// Supertonic 3 browser inference (ONNX Runtime Web, WebGPU → WASM fallback)
// Based on supertone-inc/supertonic web/helper.js (MIT). Typed-array rewrite + Cache API model storage.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.webgpu.min.mjs';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, navigator.hardwareConcurrency || 1)
  : 1;

// 아카이브 공식 가중치(고정 리비전). ./assets/onnx/tts.json 이 있으면 자체 호스팅 파일을 우선 사용.
const HF_BASE =
  'https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/aafc6e32416a594460b32413efc49d7fe4ce6d46';
const LOCAL_BASE = './assets';
const CACHE_NAME = 'supertonic3-aafc6e3';

const AVAILABLE_LANGS = ['en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi',
  'hr', 'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi', 'na'];

export const VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'];

async function resolveBase() {
  try {
    const r = await fetch(`${LOCAL_BASE}/onnx/tts.json`, { method: 'HEAD', cache: 'no-store' });
    if (r.ok) return LOCAL_BASE;
  } catch (_) { /* no local assets */ }
  return HF_BASE;
}

async function openCache() {
  try { return await caches.open(CACHE_NAME); } catch (_) { return null; }
}

// 한 번 받은 파일은 Cache Storage에 보관 → 다음 방문부터 네트워크 없이 로드
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
  let buf;
  if (res.body && onProgress) {
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.byteLength;
      onProgress(got, total, false);
    }
    const out = new Uint8Array(got);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.byteLength; }
    buf = out.buffer;
  } else {
    buf = await res.arrayBuffer();
  }
  if (cache) {
    try { await cache.put(url, new Response(buf.slice(0))); } catch (_) { /* quota */ }
  }
  return buf;
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
    this.base = null;
    this.cfgs = null;
    this.proc = null;
    this.sessions = null;
    this.backend = null;
    this.styles = new Map();
    this.lock = Promise.resolve(); // session.run 직렬화
  }

  get sampleRate() { return this.cfgs.ae.sample_rate; }

  async load(onStatus) {
    const t0 = performance.now();
    // 저장 공간 부족 시 브라우저가 모델 캐시를 지우지 않도록 영구 저장 요청
    try { await navigator.storage?.persist?.(); } catch (_) { /* unsupported */ }
    this.base = await resolveBase();
    onStatus?.('설정 파일을 불러오는 중');
    this.cfgs = await fetchJSON(`${this.base}/onnx/tts.json`);
    this.proc = new UnicodeProcessor(await fetchJSON(`${this.base}/onnx/unicode_indexer.json`));

    const names = [
      ['dp', 'duration_predictor.onnx'],
      ['enc', 'text_encoder.onnx'],
      ['vec', 'vector_estimator.onnx'],
      ['voc', 'vocoder.onnx'],
    ];
    const bufs = {};
    for (let i = 0; i < names.length; i++) {
      const [key, file] = names[i];
      bufs[key] = await fetchCached(`${this.base}/onnx/${file}`, (got, total, cached) => {
        const mb = (n) => (n / 1048576).toFixed(1);
        const size = total ? `${mb(got)} / ${mb(total)} MB` : `${mb(got)} MB`;
        onStatus?.(cached
          ? `저장된 모델 사용 (${i + 1}/4)`
          : `모델 내려받는 중 (${i + 1}/4) ${size}`);
      });
    }

    const create = async (ep) => {
      const s = {};
      for (const [key] of names) {
        s[key] = await ort.InferenceSession.create(new Uint8Array(bufs[key]), {
          executionProviders: [ep],
          graphOptimizationLevel: 'all',
        });
      }
      return s;
    };

    onStatus?.('음성 엔진 준비 중');
    if (navigator.gpu) {
      try {
        this.sessions = await create('webgpu');
        this.backend = 'WebGPU';
      } catch (e) {
        console.warn('WebGPU 실패, WASM으로 전환', e);
      }
    }
    if (!this.sessions) {
      this.sessions = await create('wasm');
      this.backend = 'WASM';
    }
    this.loadSeconds = (performance.now() - t0) / 1000;
    console.info(`[tts] 로딩 ${this.loadSeconds.toFixed(1)}s, backend=${this.backend}, `
      + `threads=${ort.env.wasm.numThreads}, crossOriginIsolated=${self.crossOriginIsolated}`);
  }

  async style(name) {
    if (this.styles.has(name)) return this.styles.get(name);
    const j = await fetchJSON(`${this.base}/voice_styles/${name}.json`);
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
