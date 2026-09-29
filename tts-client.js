// 화면 쪽 음성 엔진 창구. 가능하면 tts-worker.js(별도 스레드)에서 돌리고, 워커를 못 쓰면 화면 스레드에서 직접 돌림.
// app.js 는 이 파일의 createTTS() 가 돌려주는 객체만 씀: load, style, synth, sampleRate, backend, source, inWorker
// 휴대폰·태블릿 여부(tts.js 의 isMobileDevice 와 같은 기준). 화면 쪽에서만 iPad(UA가 Mac)를 터치로 구분할 수 있어 여기서 계산해 워커에 넘김.
// tts.js 를 여기서 import 하지 않는 이유: 음성 엔진(ONNX Runtime)이 화면 스레드에도 로드됨
const isMobileDevice = () => /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent)
  || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

export const VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'];

class WorkerTTS {
  constructor(worker) {
    this.worker = worker;
    this.inWorker = true;
    this.seq = 0;
    this.jobs = new Map(); // id → { resolve, reject, onStart }
    this.onStatus = null;
    worker.onmessage = ({ data }) => this.receive(data);
    worker.onerror = (e) => {
      const err = new Error(`음성 엔진 워커 오류: ${e.message || '알 수 없음'}`);
      for (const j of this.jobs.values()) j.reject(err);
      this.jobs.clear();
    };
  }

  receive(m) {
    if (m.type === 'status') { this.onStatus?.(m.msg); return; }
    if (m.type === 'log') { (console[m.level] || console.info)(m.text); return; }
    const job = this.jobs.get(m.id);
    if (!job) return;
    if (m.type === 'started') { job.onStart?.(); return; }
    this.jobs.delete(m.id);
    if (m.type === 'error') {
      const err = m.name === 'AbortError' ? new DOMException(m.message, 'AbortError') : Object.assign(new Error(m.message), { name: m.name });
      job.reject(err);
    } else job.resolve(m);
  }

  call(type, payload = {}, extra = {}) {
    const id = ++this.seq;
    return {
      id,
      promise: new Promise((resolve, reject) => {
        this.jobs.set(id, { resolve, reject, ...extra });
        this.worker.postMessage({ type, id, ...payload });
      }),
    };
  }

  async load(onStatus) {
    this.onStatus = onStatus;
    const r = await this.call('load', { search: location.search, mobile: isMobileDevice() }).promise;
    Object.assign(this, { backend: r.backend, source: r.source, sampleRate: r.sampleRate });
  }

  async style(voice) { await this.call('style', { voice }).promise; }

  synth(text, { signal, onStart, ...opts } = {}) {
    if (signal?.aborted) return Promise.reject(new DOMException('취소됨', 'AbortError'));
    const { id, promise } = this.call('synth', { text, opts }, { onStart });
    signal?.addEventListener('abort', () => this.worker.postMessage({ type: 'cancel', id }), { once: true });
    return promise.then((m) => m.pcm);
  }
}

export async function createTTS() {
  try {
    const worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
    return new WorkerTTS(worker);
  } catch (e) {
    console.warn('[tts] 워커를 만들 수 없어 화면 스레드에서 실행', e);
    const { SupertonicTTS } = await import('./tts.js');
    const tts = new SupertonicTTS();
    tts.inWorker = false;
    return tts;
  }
}
