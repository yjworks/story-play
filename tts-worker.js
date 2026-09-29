// 음성 엔진 워커: 모델 준비와 합성을 화면(메인) 스레드 밖에서 돌려, 무거운 계산 중에도 버튼·쪽 넘김이 멈추지 않게 함.
// 주고받는 말: tts-client.js 참고
import { SupertonicTTS } from './tts.js';

const tts = new SupertonicTTS();
const cancelled = new Set();
const post = (msg, transfer) => self.postMessage(msg, transfer || []);

// 워커의 로그도 화면 쪽 진단 기록으로 보냄
for (const level of ['info', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    const text = args.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    post({ type: 'log', level, text: text.slice(0, 400) });
  };
}

self.onmessage = async ({ data }) => {
  const { type, id } = data;
  try {
    if (type === 'load') {
      await tts.load((msg) => post({ type: 'status', msg }), { search: data.search, mobile: data.mobile });
      post({ type: 'ready', id, backend: tts.backend, source: tts.source, sampleRate: tts.sampleRate });
    } else if (type === 'style') {
      await tts.style(data.voice);
      post({ type: 'done', id });
    } else if (type === 'synth') {
      const signal = { get aborted() { return cancelled.has(id); } };
      const pcm = await tts.synth(data.text, { ...data.opts, signal, onStart: () => post({ type: 'started', id }) });
      cancelled.delete(id);
      post({ type: 'audio', id, pcm }, [pcm.buffer]);
    } else if (type === 'cancel') {
      cancelled.add(id);
    }
  } catch (e) {
    cancelled.delete(id);
    post({ type: 'error', id, name: e?.name || 'Error', message: e?.message || String(e) });
  }
};
