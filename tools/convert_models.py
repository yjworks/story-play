#!/usr/bin/env python3
"""
Supertonic 3 모델을 8비트(INT8)로 변환하고, 같은 문장을 32비트·8비트로 합성해 비교한 뒤
edge-lab 에 올릴 폴더(tts-int8)를 만든다. 앱(tts.js)은 tts-int8 을 먼저 찾고, 없으면 tts(32비트)를 씀.

왜 8비트 하나인가(2026-09-28 브라우저 런타임 onnxruntime-web 1.22.0 으로 확인):
  - 8비트는 WASM(휴대폰)·WebGPU(태블릿·PC) 모두 정상 동작, 파일이 줄어 휴대폰 메모리·다운로드 부담이 작음.
  - 16비트는 WASM 정상이지만, 16비트 연산을 지원하지 않는 GPU의 WebGPU에서 결과가 틀리게 나옴 → 쓰지 않음.
  - 실제 기기에서의 속도는 실측 필요.

설치:
  pip install onnx onnxruntime onnxconverter-common huggingface_hub numpy

실행:
  python tools/convert_models.py                 # 받기 → 변환 → 검증(wav 저장) → 업로드 폴더 만들기
  python tools/convert_models.py --src ./my/tts  # 이미 받아 둔 tts 폴더(onnx/, voice_styles/ 포함)를 쓸 때
  python tools/convert_models.py --compare       # 잡음이 있을 때: 조합별 wav 를 work/cmp/ 에 만들어 비교(업로드 폴더는 안 만듦)
  python tools/convert_models.py --no-conv vocoder            # vocoder 는 MatMul 만 8비트, Conv 는 32비트
  python tools/convert_models.py --keep vocoder               # vocoder 파일 전체를 32비트로

업로드(검증 결과를 듣고 괜찮을 때):
  huggingface-cli upload leeyunjai/edge-lab ./export/tts-int8 tts-int8
"""
import argparse
import json
import shutil
import time
import unicodedata
import wave
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort

REPO = 'leeyunjai/edge-lab'
NAMES = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder']
TEST_TEXT = '옛날 옛날, 깊은 숲속에 꾀돌이 여우가 살았어요. 여우는 친구들을 골려 주는 장난을 아주 좋아했지요.'
ROOT = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------- 받기
def download(dst: Path) -> Path:
    from huggingface_hub import snapshot_download
    snapshot_download(REPO, allow_patterns=['tts/onnx/*', 'tts/voice_styles/*'], local_dir=dst)
    return dst / 'tts'


# ---------------------------------------------------------------- 변환
def to_fp16(src: Path, dst: Path):
    from onnxconverter_common import float16
    model = onnx.load(str(src))
    # keep_io_types: 입출력은 32비트 그대로 → 앱(JS)의 Float32 텐서를 바꿀 필요 없음
    m16 = float16.convert_float_to_float16(model, keep_io_types=True)
    onnx.save(m16, str(dst))


def to_int8(src: Path, dst: Path, conv: bool = True):
    from onnxruntime.quantization import QuantType, quantize_dynamic
    # MatMul/Gemm(/Conv) 가중치를 8비트로(동적 양자화). conv=False 면 Conv 는 32비트로 둠(잡음이 날 때).
    # 반드시 부호 없는 8비트(QUInt8): 부호 있는 8비트(QInt8)의 ConvInteger 는 브라우저(onnxruntime-web 1.22.0)
    # WASM·WebGPU 모두 "구현 없음"으로 안 열림. QUInt8 은 둘 다 정상(작은 모델로 확인, 오차 약 1%).
    ops = ['MatMul', 'Gemm', 'Conv'] if conv else ['MatMul', 'Gemm']
    quantize_dynamic(str(src), str(dst), weight_type=QuantType.QUInt8, op_types_to_quantize=ops)


# 파일별 방식: 'all' = MatMul/Gemm/Conv 8비트, 'mm' = MatMul/Gemm 만 8비트, 'fp32' = 그대로
def build(fp32: Path, cache: Path, out: Path, plan: dict):
    out.mkdir(parents=True, exist_ok=True)
    for name in ['tts.json', 'unicode_indexer.json']:
        shutil.copy(fp32 / name, out / name)
    for n in NAMES:
        mode = plan[n]
        if mode == 'fp32':
            shutil.copy(fp32 / f'{n}.onnx', out / f'{n}.onnx')
            continue
        c = cache / f'{n}.{mode}.onnx'
        if not c.exists():
            print(f'변환 중: {n} ({"MatMul/Gemm/Conv" if mode == "all" else "MatMul/Gemm 만"})')
            to_int8(fp32 / f'{n}.onnx', c, conv=(mode == 'all'))
        shutil.copy(c, out / f'{n}.onnx')


def plan_label(plan: dict) -> str:
    fp = [n for n in NAMES if plan[n] == 'fp32']
    mm = [n for n in NAMES if plan[n] == 'mm']
    parts = []
    if mm:
        parts.append(f'Conv 32비트 유지: {", ".join(mm)}')
    if fp:
        parts.append(f'파일 전체 32비트 유지: {", ".join(fp)}')
    return ', '.join(parts)


# ---------------------------------------------------------------- 합성 (앱의 tts.js 와 같은 순서)
def preprocess(text: str, lang: str = 'ko') -> str:
    text = unicodedata.normalize('NFKD', text)
    text = ' '.join(text.split())
    if not text.endswith(('.', '!', '?', ';', ':', ',', "'", '"', ')', ']', '}', '…')):
        text += '.'
    return f'<{lang}>{text}</{lang}>'


def synth(onnx_dir: Path, voice_dir: Path, text: str, steps: int = 8, seed: int = 0):
    cfg = json.loads((onnx_dir / 'tts.json').read_text(encoding='utf-8'))
    indexer = json.loads((onnx_dir / 'unicode_indexer.json').read_text(encoding='utf-8'))
    style = json.loads((voice_dir / 'F1.json').read_text(encoding='utf-8'))
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    t0 = time.time()
    s = {n: ort.InferenceSession(str(onnx_dir / f'{n}.onnx'), opts, providers=['CPUExecutionProvider']) for n in NAMES}
    t_load = time.time() - t0

    ids = [indexer[ord(c)] if ord(c) < len(indexer) else -1 for c in preprocess(text)]
    text_ids = np.array([ids], dtype=np.int64)
    text_mask = np.ones((1, 1, len(ids)), dtype=np.float32)
    sdp = np.array(style['style_dp']['data'], dtype=np.float32).reshape(style['style_dp']['dims'])
    sttl = np.array(style['style_ttl']['data'], dtype=np.float32).reshape(style['style_ttl']['dims'])

    t0 = time.time()
    dur = s['duration_predictor'].run(None, {'text_ids': text_ids, 'style_dp': sdp, 'text_mask': text_mask})[0]
    dur = float(np.ravel(dur)[0]) / 1.05
    emb = s['text_encoder'].run(None, {'text_ids': text_ids, 'style_ttl': sttl, 'text_mask': text_mask})[0]
    sr = cfg['ae']['sample_rate']
    chunk = cfg['ae']['base_chunk_size'] * cfg['ttl']['chunk_compress_factor']
    dim = cfg['ttl']['latent_dim'] * cfg['ttl']['chunk_compress_factor']
    wav_len = int(dur * sr)
    T = max(1, -(-wav_len // chunk))
    xt = np.random.default_rng(seed).standard_normal((1, dim, T)).astype(np.float32)
    latent_mask = np.ones((1, 1, T), dtype=np.float32)
    total = np.array([steps], dtype=np.float32)
    for k in range(steps):
        xt = s['vector_estimator'].run(None, {
            'noisy_latent': xt, 'text_emb': emb, 'style_ttl': sttl, 'latent_mask': latent_mask,
            'text_mask': text_mask, 'current_step': np.array([k], dtype=np.float32), 'total_step': total,
        })[0].astype(np.float32)
    wav = s['vocoder'].run(None, {'latent': xt})[0].reshape(-1)[:wav_len]
    t_synth = time.time() - t0
    return wav.astype(np.float32), sr, t_load, t_synth


def save_wav(path: Path, pcm: np.ndarray, sr: int):
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(pcm, -1, 1) * 32767).astype('<i2').tobytes())


def dir_mb(d: Path) -> float:
    return sum(f.stat().st_size for f in d.glob('*.onnx')) / 1048576


# ---------------------------------------------------------------- 업로드 폴더
def make_export(src_tts: Path, variant_onnx: Path, out: Path, label: str):
    if out.exists():
        shutil.rmtree(out)
    (out / 'onnx').mkdir(parents=True)
    for f in variant_onnx.glob('*.onnx'):
        shutil.copy(f, out / 'onnx' / f.name)
    for name in ['tts.json', 'unicode_indexer.json']:
        shutil.copy(src_tts / 'onnx' / name, out / 'onnx' / name)
    shutil.copytree(src_tts / 'voice_styles', out / 'voice_styles')
    # Open RAIL-M 4b(라이선스 사본 제공)·4c(수정 사실 표시)
    lic = ROOT / 'licenses' / 'OpenRAIL-M.txt'
    if lic.exists():
        shutil.copy(lic, out / 'LICENSE-OpenRAIL-M.txt')
    (out / 'MODIFICATIONS.md').write_text(
        f'# 수정 사항\n\n이 폴더의 ONNX 파일은 Supertone Inc.의 Supertonic 3 모델(BigScience Open RAIL-M)을 {label}로 변환한 것입니다.\n'
        '- 원본: supertone-oss-archive/supertonic-3 (revision aafc6e32416a594460b32413efc49d7fe4ce6d46)\n'
        '- 변환 도구: tools/convert_models.py (onnxconverter-common / onnxruntime.quantization)\n'
        '- 입출력 형식과 설정(tts.json), 목소리 파일(voice_styles)은 바꾸지 않았습니다.\n'
        '- 사용 제한(Attachment A)은 원본과 같이 적용됩니다.\n', encoding='utf-8')


def compare_line(label, d, voices, steps, ref, out_wav):
    try:
        wav, sr, tl, ts = synth(d, voices, TEST_TEXT, steps)
        secs = len(wav) / sr
        save_wav(out_wav, wav, sr)
        note = str(out_wav)
        if ref is not None:
            n = min(len(ref), len(wav))
            corr = float(np.corrcoef(ref[:n], wav[:n])[0, 1]) if n > 1 else float('nan')
            note += f'  (fp32과 파형 상관 {corr:.3f})'
        print(f'{label:<28}{dir_mb(d):>9.1f}{ts:>9.2f}{secs:>8.2f}{ts / max(secs, 1e-3):>7.2f}   {note}')
        return wav
    except Exception as e:  # noqa: BLE001
        print(f'{label:<28}{dir_mb(d):>9.1f}   실패: {type(e).__name__}: {str(e)[:200]}')
        return None


def header(steps):
    print(f'\n같은 문장 합성 비교 (CPU, steps={steps}): "{TEST_TEXT}"')
    print(f'{"조합":<28}{"MB":>9}{"합성(s)":>9}{"음성(s)":>8}{"RTF":>7}   결과')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', type=Path, help='이미 받아 둔 tts 폴더(onnx/, voice_styles/ 포함)')
    ap.add_argument('--work', type=Path, default=Path('work'), help='작업 폴더')
    ap.add_argument('--steps', type=int, default=5, help='앱의 휴대폰 기본값과 같은 5')
    ap.add_argument('--keep', nargs='*', default=[], choices=NAMES,
                    help='8비트로 바꾸지 않고 파일 전체를 32비트로 둘 파일. 예: --keep vocoder')
    ap.add_argument('--no-conv', nargs='*', default=[], choices=NAMES,
                    help='MatMul/Gemm 만 8비트로, Conv 는 32비트로 둘 파일. 예: --no-conv vocoder')
    ap.add_argument('--compare', action='store_true', help='조합별 wav 를 work/cmp/ 에 만들어 비교만 함')
    args = ap.parse_args()

    work = args.work
    src = args.src or download(work / 'hf')
    fp32 = src / 'onnx'
    voices = src / 'voice_styles'
    cache = work / 'q'
    cache.mkdir(parents=True, exist_ok=True)

    if args.compare:
        V, E = 'vocoder', 'vector_estimator'
        combos = [
            ('A 전부 8비트', {}),
            ('B vocoder Conv 32비트', {V: 'mm'}),
            ('C vocoder 전체 32비트', {V: 'fp32'}),
            ('D vocoder+VE Conv 32비트', {V: 'mm', E: 'mm'}),
            ('E Conv 전부 32비트', {n: 'mm' for n in NAMES}),
        ]
        cmp = work / 'cmp'
        dirs = []
        for label, over in combos:
            plan = {n: over.get(n, 'all') for n in NAMES}
            d = cmp / label.split()[0]
            if d.exists():
                shutil.rmtree(d)
            build(fp32, cache, d, plan)
            dirs.append((label, d))
        header(args.steps)
        ref = compare_line('fp32 (원본)', fp32, voices, args.steps, None, cmp / 'fp32.wav')
        for label, d in dirs:
            compare_line(label, d, voices, args.steps, ref, cmp / f'{label.split()[0]}.wav')
        print('\nwork/cmp/ 의 wav 를 들어 보고, 잡음 없는 것 중 가장 작은 조합으로 다시 실행하세요:')
        print('  B → python tools/convert_models.py --no-conv vocoder')
        print('  C → python tools/convert_models.py --keep vocoder')
        print('  D → python tools/convert_models.py --no-conv vocoder vector_estimator')
        print('  E → python tools/convert_models.py --no-conv duration_predictor text_encoder vector_estimator vocoder')
        return

    plan = {n: 'fp32' if n in args.keep else 'mm' if n in args.no_conv else 'all' for n in NAMES}
    out8 = work / 'int8'
    if out8.exists():
        shutil.rmtree(out8)
    build(fp32, cache, out8, plan)
    print('\n파일 크기(MB)   32비트 → 8비트')
    for n in NAMES:
        a, b = (fp32 / f'{n}.onnx').stat().st_size / 1048576, (out8 / f'{n}.onnx').stat().st_size / 1048576
        print(f'  {n:<20}{a:>8.1f} → {b:>7.1f}')

    header(args.steps)
    ref = compare_line('fp32', fp32, voices, args.steps, None, work / 'test-fp32.wav')
    if compare_line('int8', out8, voices, args.steps, ref, work / 'test-int8.wav') is None:
        print('       → 이 변환본은 CPU(= 브라우저 WASM)에서 안 돌 가능성이 큽니다. 올리지 마세요.')

    extra = plan_label(plan)
    make_export(src, out8, Path('export') / 'tts-int8',
                f'8비트(INT8 동적 양자화, QUInt8, MatMul/Gemm/Conv 가중치{", " + extra if extra else ""})')
    print('\n업로드 폴더: export/tts-int8')
    print('test-fp32.wav 와 test-int8.wav 를 들어 보고 잡음이 없으면 export/tts-int8 을 올리세요.')
    print('잡음이 있으면: python tools/convert_models.py --compare')
    print(f'  huggingface-cli upload {REPO} ./export/tts-int8 tts-int8')


if __name__ == '__main__':
    main()
