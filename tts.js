// Supertonic 3 browser inference (ONNX Runtime Web, WebGPU → WASM fallback)
// Based on supertone-inc/supertonic web/helper.js (MIT). Typed-array rewrite + Cache API model storage.
// onnxruntime-web 1.22.0 (npm 패키지 dist/ 그대로)를 저장소 vendor/ort/ 에 두고 같은 사이트에서 불러옴 → CDN 의존 없음
import * as ort from './vendor/ort/ort.webgpu.min.mjs';

ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, navigator.hardwareConcurrency || 1)
  : 1;

// 모델 위치 후보. 위에서부터 차례로 시도하고, 파일이 없거나 구성이 다르면 다음 후보로 넘어감.
//  1) ./assets            자체 호스팅(있을 때만)
//  2) edge-lab            leeyunjai/edge-lab 저장소의 tts/ 폴더
//  3) 공식 아카이브        supertone-oss-archive/supertonic-3 고정 리비전
// 주소 뒤에 ?model=계정/저장소[@리비전][/하위/폴더] 를 붙이면 그 위치를 가장 먼저 시도. 예: ?model=leeyunjai/edge-lab@main/tts
// 각 위치 안의 구성은 두 가지를 모두 받음: <위치>/onnx/*.onnx 또는 <위치>/*.onnx (목소리는 <위치>/voice_styles/*.json)
const hf = (repo, rev, path = '') => `https://huggingface.co/${repo}/resolve/${rev}${path ? `/${path}` : ''}`;
const EDGE_LAB = { name: 'edge-lab', base: hf('leeyunjai/edge-lab', 'main', 'tts') };
// 8비트 변환본(tools/convert_models.py). WASM(CPU)용: 가볍고 CPU 정수 연산이라 휴대폰에 유리.
// WebGPU에서는 8비트 연산(MatMulInteger/ConvInteger)을 GPU가 못 해서 CPU로 넘겨 매우 느려지므로 32비트를 먼저 씀.
// INT8_REV: 8비트 파일을 다시 올리면 그 커밋 해시로 바꿀 것 → 주소가 바뀌어 모든 기기가 새 파일을 받고 예전 파일은 정리됨
// 71800e5 = vocoder 만 32비트로 둔 변환본(--keep vocoder, 약 177MB). 전부 8비트는 vocoder 에서 잡음이 나서 안 씀.
// 짧은 해시를 HF가 못 알아들으면 main 으로 넘어감(EDGE_LAB_INT8_MAIN).
const INT8_REV = '71800e5';
const EDGE_LAB_INT8 = { name: 'edge-lab 8비트', base: hf('leeyunjai/edge-lab', INT8_REV, 'tts-int8') };
const EDGE_LAB_INT8_MAIN = { name: 'edge-lab 8비트(main)', base: hf('leeyunjai/edge-lab', 'main', 'tts-int8') };
const OFFICIAL = {
  name: '공식 아카이브',
  base: hf('supertone-oss-archive/supertonic-3', 'aafc6e32416a594460b32413efc49d7fe4ce6d46'),
};
const LOCAL = { name: '자체 호스팅', base: './assets', local: true };

// search: 페이지 주소의 ?… 부분. 워커 안에서는 location 이 워커 파일 주소라서 페이지에서 넘겨받음.
// ep: 'webgpu' 면 32비트 먼저, 'wasm' 이면 8비트 먼저
function modelSources(search = self.location?.search || '', ep = 'wasm') {
  const q = new URLSearchParams(search).get('model');
  const m = q?.match(/^([\w.-]+\/[\w.-]+)(?:@([\w.-]+))?(?:\/([\w./-]+))?$/);
  const list = ep === 'webgpu'
    ? [LOCAL, EDGE_LAB, EDGE_LAB_INT8, EDGE_LAB_INT8_MAIN, OFFICIAL]
    : [LOCAL, EDGE_LAB_INT8, EDGE_LAB_INT8_MAIN, EDGE_LAB, OFFICIAL];
  // ?model= 로 지정한 위치를 먼저 시도하고, 실패하면 기본 후보로 넘어감
  if (m) list.unshift({ name: q, base: hf(m[1], m[2] || 'main', m[3] || '') });
  return list;
}
const CACHE_NAME = 'supertonic3-aafc6e3';

const AVAILABLE_LANGS = ['en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi',
  'hr', 'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi', 'na'];

export const VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'];

async function openCache() {
  try { return await caches.open(CACHE_NAME); } catch (_) { return null; }
}

// 한 번 받은 파일은 Cache Storage에 보관 → 다음 방문부터 네트워크 없이 로드.
// 큰 모델 파일은 받는 즉시 디스크(Cache Storage)로 흘려 보내고, 다 받은 뒤 한 번만 메모리로 읽음.
// (메모리에 조각·합본·복사본을 동시에 들고 있으면 iPhone Safari처럼 탭 메모리가 작은 곳에서 실패함)
async function fetchCached(url, onProgress) {
  const cache = await openCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const buf = await hit.arrayBuffer();
      onProgress?.(buf.byteLength, buf.byteLength, true);
      return buf;
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (cache && res.body && typeof TransformStream === 'function') {
    let got = 0;
    const counter = new TransformStream({
      transform(chunk, ctl) {
        got += chunk.byteLength;
        onProgress?.(got, total, false);
        ctl.enqueue(chunk);
      },
    });
    try {
      const type = res.headers.get('content-type') || 'application/octet-stream';
      await cache.put(url, new Response(res.body.pipeThrough(counter), { headers: { 'content-type': type } }));
      const hit = await cache.match(url);
      if (hit) return await hit.arrayBuffer();
    } catch (e) {
      // 저장 공간 부족 등으로 캐시에 못 쓰면, 캐시 없이 다시 받아 메모리로 읽음
      console.warn('[tts] 캐시에 저장하지 못해 메모리로 받음', url, e);
      try { await cache.delete(url); } catch (_) { /* ignore */ }
      const again = await fetch(url);
      if (!again.ok) throw new Error(`다운로드 실패 (${again.status}): ${url}`);
      return readAll(again, total, onProgress);
    }
  }
  return readAll(res, total, onProgress);
}

// 캐시 없이 받을 때: 크기를 알면 한 번에 자리를 잡아 채움(합치기 복사 없음)
async function readAll(res, total, onProgress) {
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  let out = total ? new Uint8Array(total) : null;
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (out && got + value.byteLength <= out.byteLength) out.set(value, got);
    else { if (out) { parts.push(out.subarray(0, got)); out = null; } parts.push(value); }
    got += value.byteLength;
    onProgress?.(got, total, false);
  }
  if (out) return got === out.byteLength ? out.buffer : out.slice(0, got).buffer;
  const joined = new Uint8Array(got);
  let off = 0;
  for (const p of parts) { joined.set(p, off); off += p.byteLength; }
  return joined.buffer;
}

async function fetchJSON(url) {
  const buf = await fetchCached(url);
  return JSON.parse(new TextDecoder().decode(buf));
}

class UnicodeProcessor {
  constructor(indexer) { this.indexer = indexer; }

  preprocess(text, lang) {
    text = text.normalize('NFKD');
    text = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '');
    const rep = {
      '–': '-', '‑': '-', '—': '-', '_': ' ', '\u201C': '"', '\u201D': '"', '\u2018': "'", '\u2019': "'",
      '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' ',
    };
    for (const [k, v] of Object.entries(rep)) text = text.replaceAll(k, v);
    text = text.replace(/[♥☆♡©\\]/g, '');
    for (const [k, v] of Object.entries({ '@': ' at ', 'e.g.,': 'for example, ', 'i.e.,': 'that is, ' })) {
      text = text.replaceAll(k, v);
    }
    text = text.replace(/ ([,.!?;:'])/g, '$1');
    while (text.includes('""')) text = text.replace('""', '"');
    while (text.includes("''")) text = text.replace("''", "'");
    text = text.replace(/\s+/g, ' ').trim();
    if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(text)) text += '.';
    if (!AVAILABLE_LANGS.includes(lang)) throw new Error(`지원하지 않는 언어: ${lang}`);
    return `<${lang}>${text}</${lang}>`;
  }

  encode(text, lang) {
    const t = this.preprocess(text, lang);
    const ids = [];
    for (const ch of t) {
      const cp = ch.codePointAt(0);
      ids.push(cp < this.indexer.length ? this.indexer[cp] : -1);
    }
    return ids;
  }
}

function chunkText(text, maxLen) {
  const sentences = text.trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > maxLen) { chunks.push(cur); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function gaussian() {
  const u1 = Math.max(1e-4, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export class SupertonicTTS {
  constructor() {
    this.onnxDir = null;
    this.voiceDir = null;
    this.source = null;
    this.cfgs = null;
    this.proc = null;
    this.sessions = null;
    this.backend = null;
    this.styles = new Map();
    this.lock = Promise.resolve(); // session.run 직렬화
  }

  get sampleRate() { return this.cfgs.ae.sample_rate; }

  async load(onStatus, { search } = {}) {
    const t0 = performance.now();
    // 저장 공간 부족 시 브라우저가 모델 캐시를 지우지 않도록 영구 저장 요청
    try { await navigator.storage?.persist?.(); } catch (_) { /* unsupported */ }
    const names = [
      ['dp', 'duration_predictor.onnx'],
      ['enc', 'text_encoder.onnx'],
      ['vec', 'vector_estimator.onnx'],
      ['voc', 'vocoder.onnx'],
    ];
    // 모델 파일을 하나씩 받아(또는 캐시에서 읽어) 바로 세션을 만들고, 버퍼는 곧바로 놓아 줌
    const create = async (ep) => {
      const s = {};
      for (let i = 0; i < names.length; i++) {
        const [key, file] = names[i];
        let buf = await fetchCached(`${this.onnxDir}/${file}`, (n, total, cached) => {
          const mb = (x) => (x / 1048576).toFixed(1);
          const size = total ? `${mb(n)} / ${mb(total)} MB` : `${mb(n)} MB`;
          onStatus?.(cached
            ? `저장된 모델 불러오는 중 (${i + 1}/4)`
            : `모델 내려받는 중 (${i + 1}/4, ${this.source}) ${size}`);
        });
        onStatus?.(`음성 엔진 준비 중 (${i + 1}/4)`);
        try {
          s[key] = await ort.InferenceSession.create(new Uint8Array(buf), {
            executionProviders: [ep],
            graphOptimizationLevel: 'all',
          });
        } catch (e) {
          // 이미 만든 세션은 풀어 줘서, 다음 방식으로 넘어갈 때 메모리를 비워 둠
          for (const done of Object.values(s)) { try { await done.release(); } catch (_) { /* ignore */ } }
          throw e;
        }
        buf = null;
      }
      return s;
    };
    const isNetwork = (e) => /다운로드 실패|Failed to fetch|Load failed|NetworkError/i.test(e?.message || '');

    // 위치 후보를 차례로: 설정·문자표·목소리 파일이 있으면 세션을 만들어 보고(WebGPU → WASM),
    // 그 위치의 모델이 이 기기에서 안 열리면 다음 후보(예: 8비트 → 32비트)로 넘어감
    const tried = [];
    // WebGPU 어댑터가 실제로 잡히는지 먼저 확인(navigator.gpu 가 있어도 GPU를 못 쓰는 기기가 있음)
    // 휴대폰·태블릿 GPU(Qualcomm Adreno, ARM Mali 등)는 WebGPU로 돌리면 결과가 틀려 "딴 딴" 소리만 남(Tab S8 확인, 2026-09-28).
    // 그래서 이런 GPU는 WebGPU를 건너뛰고 WASM 8비트(S24+에서 RTF 약 0.55 확인)를 씀.
    // 주소 뒤 ?ep=webgpu / ?ep=wasm 으로 강제할 수 있음(비교·진단용).
    const force = new URLSearchParams(search).get('ep');
    const eps = [];
    try {
      const adapter = force !== 'wasm' && navigator.gpu ? await navigator.gpu.requestAdapter() : null;
      if (adapter) {
        const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {}) || {};
        const gpu = `${info.vendor || '?'} ${info.architecture || ''}`.trim();
        const mobileGpu = /qualcomm|adreno|arm|mali|imagination|powervr|samsung/i.test(`${info.vendor} ${info.architecture}`);
        console.info(`[tts] GPU: ${gpu}${mobileGpu ? ' (휴대폰·태블릿 GPU)' : ''}`);
        if (force === 'webgpu' || !mobileGpu) eps.push('webgpu');
      }
    } catch (_) { /* 없음 */ }
    eps.push('wasm');
    console.info(`[tts] 계산 방식 후보: ${eps.join(' → ')}`);
    for (const ep of eps) {
    for (const src of modelSources(search, ep)) {
      for (const onnxDir of [`${src.base}/onnx`, src.base]) {
        try {
          if (src.local) {
            const r = await fetch(`${onnxDir}/tts.json`, { method: 'HEAD', cache: 'no-store' });
            if (!r.ok) throw new Error(`없음 (${r.status})`);
          }
          onStatus?.(`설정 파일을 불러오는 중 (${src.name})`);
          const cfgs = await fetchJSON(`${onnxDir}/tts.json`);
          if (!cfgs?.ae?.sample_rate || !cfgs?.ttl?.latent_dim) throw new Error('tts.json 형식이 다름');
          const indexer = await fetchJSON(`${onnxDir}/unicode_indexer.json`);
          const voiceDir = `${src.base}/voice_styles`;
          await fetchJSON(`${voiceDir}/${VOICES[0]}.json`);
          this.cfgs = cfgs;
          this.proc = new UnicodeProcessor(indexer);
          this.onnxDir = onnxDir;
          this.voiceDir = voiceDir;
          this.source = src.name;
        } catch (e) {
          tried.push(`${onnxDir}: ${e.name === 'Error' ? '' : `${e.name} `}${e.message}`);
          if (!src.local) console.warn(`[tts] 모델 위치 건너뜀: ${onnxDir}`, e);
          continue;
        }
        console.info(`[tts] 모델 위치: ${this.onnxDir} (${this.source}), ${ep}`);
        try {
          this.sessions = await create(ep);
          this.backend = ep === 'webgpu' ? 'WebGPU' : 'WASM';
        } catch (e) {
          if (isNetwork(e)) throw e;
          tried.push(`${onnxDir} (${ep}): 모델을 열지 못함 (${e.message})`);
          console.warn(`[tts] ${this.source} 모델을 ${ep}로 열지 못해 다음 후보로`, e);
        }
        break; // 이 위치는 설정이 있었으니 다른 폴더 구성은 볼 필요 없음
      }
      if (this.sessions) break;
    }
    if (this.sessions) break;
    }
    if (!this.sessions) throw new Error(`모델을 찾지 못했어요. ${tried.join(' / ')}`);

    // 지금 쓰는 4개 파일이 아닌 예전 모델 파일(32비트, 다른 리비전 등)은 기기 저장소에서 지움
    try {
      const cache = await openCache();
      const inUse = new Set(names.map(([, file]) => `${this.onnxDir}/${file}`));
      for (const req of (await cache?.keys()) || []) {
        if (req.url.endsWith('.onnx') && !inUse.has(req.url)) {
          await cache.delete(req);
          console.info(`[tts] 쓰지 않는 예전 모델 파일 정리: ${req.url.split('/').slice(-3).join('/')}`);
        }
      }
    } catch (_) { /* 정리 실패는 무시 */ }
    this.loadSeconds = (performance.now() - t0) / 1000;
    console.info(`[tts] 로딩 ${this.loadSeconds.toFixed(1)}s, backend=${this.backend}, `
      + `threads=${ort.env.wasm.numThreads}, crossOriginIsolated=${self.crossOriginIsolated}`);
  }

  async style(name) {
    if (this.styles.has(name)) return this.styles.get(name);
    const j = await fetchJSON(`${this.voiceDir}/${name}.json`);
    const td = j.style_ttl.dims;
    const dd = j.style_dp.dims;
    const st = {
      ttl: new ort.Tensor('float32', Float32Array.from(j.style_ttl.data.flat(Infinity)), [1, td[1], td[2]]),
      dp: new ort.Tensor('float32', Float32Array.from(j.style_dp.data.flat(Infinity)), [1, dd[1], dd[2]]),
    };
    this.styles.set(name, st);
    return st;
  }

  async _infer(text, lang, st, steps, speed) {
    const { dp, enc, vec, voc } = this.sessions;
    const ids = this.proc.encode(text, lang);
    const L = ids.length;
    const textIds = new ort.Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, L]);
    const textMask = new ort.Tensor('float32', new Float32Array(L).fill(1), [1, 1, L]);

    const dOut = await dp.run({ text_ids: textIds, style_dp: st.dp, text_mask: textMask });
    const dur = dOut.duration.data[0] / speed;

    const eOut = await enc.run({ text_ids: textIds, style_ttl: st.ttl, text_mask: textMask });
    const textEmb = eOut.text_emb;

    const sr = this.cfgs.ae.sample_rate;
    const chunk = this.cfgs.ae.base_chunk_size * this.cfgs.ttl.chunk_compress_factor;
    const dim = this.cfgs.ttl.latent_dim * this.cfgs.ttl.chunk_compress_factor;
    const wavLen = Math.floor(dur * sr);
    const T = Math.max(1, Math.ceil(wavLen / chunk));

    let xt = new Float32Array(dim * T);
    for (let i = 0; i < xt.length; i++) xt[i] = gaussian();
    const latentMask = new ort.Tensor('float32', new Float32Array(T).fill(1), [1, 1, T]);
    const totalStep = new ort.Tensor('float32', new Float32Array([steps]), [1]);

    for (let s = 0; s < steps; s++) {
      const out = await vec.run({
        noisy_latent: new ort.Tensor('float32', xt, [1, dim, T]),
        text_emb: textEmb,
        style_ttl: st.ttl,
        latent_mask: latentMask,
        text_mask: textMask,
        current_step: new ort.Tensor('float32', new Float32Array([s]), [1]),
        total_step: totalStep,
      });
      xt = new Float32Array(out.denoised_latent.data);
    }

    const vOut = await voc.run({ latent: new ort.Tensor('float32', xt, [1, dim, T]) });
    const wav = vOut.wav_tts.data;
    return wav.slice(0, Math.min(wav.length, wavLen || wav.length));
  }

  // 한 줄(대사)을 합성해 Float32Array(PCM, sampleRate) 반환.
  // signal 이 abort 되면 아직 시작 전인 작업은 건너뜀(목소리·품질을 바꿨을 때 낡은 미리 합성이 줄을 막지 않도록).
  synth(text, { voice = 'F1', lang = 'ko', steps = 8, speed = 1.05, gap = 0.25, signal, onStart } = {}) {
    const job = this.lock.then(async () => {
      // 앞 작업이 끝나면 곧바로(마이크로태스크로) 다음 작업이 시작돼서, 그 사이 도착한 취소 메시지가 처리될 틈이 없음.
      // 한 번 이벤트 루프에 양보해 취소 메시지를 먼저 받은 뒤 확인함(워커에서 취소한 문장을 헛되이 합성하던 문제).
      await new Promise((r) => setTimeout(r, 0));
      if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
      onStart?.();
      const t0 = performance.now();
      const st = await this.style(voice);
      const maxLen = lang === 'ko' || lang === 'ja' ? 120 : 300;
      const parts = [];
      for (const c of chunkText(text, maxLen)) parts.push(await this._infer(c, lang, st, steps, speed));
      const silence = Math.floor(gap * this.sampleRate);
      const total = parts.reduce((a, p) => a + p.length, 0) + silence * Math.max(0, parts.length - 1);
      const out = new Float32Array(total);
      let off = 0;
      parts.forEach((p, i) => { out.set(p, off); off += p.length + (i < parts.length - 1 ? silence : 0); });
      const sec = (performance.now() - t0) / 1000;
      const audio = out.length / this.sampleRate;
      console.info(`[tts] ${this.backend} steps=${steps} voice=${voice} 합성 ${sec.toFixed(2)}s / 음성 ${audio.toFixed(2)}s `
        + `(RTF ${(sec / Math.max(audio, 0.01)).toFixed(2)}) "${text.slice(0, 20)}"`);
      return out;
    });
    this.lock = job.catch(() => {});
    return job;
  }
}
