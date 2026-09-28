import { SupertonicTTS, VOICES } from './tts.js';
import { STORIES } from './stories.js';

const COLORS = ['#3e8e7e', '#5b7bd5', '#c0587e', '#8a6bc4', '#c98a1e', '#4a9cc0', '#6f8f3a', '#b0603a'];
const VOICE_LABEL = {
  F1: '여성 1', F2: '여성 2', F3: '여성 3', F4: '여성 4', F5: '여성 5',
  M1: '남성 1', M2: '남성 2', M3: '남성 3', M4: '남성 4', M5: '남성 5',
};
const USER_KEY = 'story-player:user-stories';
const LOOKAHEAD = 2; // 재생 중 미리 합성해 둘 줄 수 (이야기를 고르면 첫 줄 + LOOKAHEAD 줄도 미리 합성)

// 표현 태그는 합성에만 쓰고 화면에는 숨김
const TAG_RE = /<\s*[a-z]+\s*>/gi;
const shown = (t) => t.replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();

const $ = (id) => document.getElementById(id);
const el = {
  engine: $('engine'), storyList: $('storyList'), storyTitle: $('storyTitle'), storySource: $('storySource'),
  castList: $('castList'), spotName: $('spotName'), spotText: $('spotText'), script: $('script'),
  play: $('playBtn'), prev: $('prevBtn'), next: $('nextBtn'), steps: $('steps'), progress: $('progress'),
  editor: $('editor'), openEditor: $('openEditor'), edTitle: $('edTitle'), edBody: $('edBody'),
};

const tts = new SupertonicTTS();
let ready = false;
let stories = [...STORIES, ...loadUserStories()];
let story = null;
let idx = 0;
let playing = false;
let runId = 0;
let audioCtx = null;
let source = null;
// key → { p: Promise<Float32Array>, started: boolean }
const audioCache = new Map();
let prefetchCtl = new AbortController();

/* ---------- 저장된 사용자 이야기 ---------- */
function loadUserStories() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || '[]'); } catch (_) { return []; }
}
function saveUserStories() {
  try { localStorage.setItem(USER_KEY, JSON.stringify(stories.filter((s) => s.user))); } catch (_) { /* ignore */ }
}

/* ---------- 색상/목소리 ---------- */
function colorOf(name) {
  const names = Object.keys(story.cast);
  return COLORS[names.indexOf(name) % COLORS.length];
}
function castOf(name) {
  if (!story.cast[name]) {
    const used = new Set(Object.values(story.cast).map((c) => c.voice));
    const voice = VOICES.find((v) => !used.has(v)) || VOICES[Object.keys(story.cast).length % VOICES.length];
    story.cast[name] = { voice, speed: 1.0 };
  }
  return story.cast[name];
}
function keyFor(i) {
  const [who, text] = story.lines[i];
  const c = castOf(who);
  return `${story.id}|${i}|${c.voice}|${c.speed}|${el.steps.value}|${text}`;
}

/* ---------- 합성 캐시 ---------- */
// 목소리·품질·이야기·위치가 바뀌면 아직 시작하지 않은 미리 합성을 버려서, 바뀐 설정이 곧바로 반영되게 함.
// 이미 합성 중인 줄은 그대로 두어 같은 줄을 두 번 합성하지 않음.
function cancelPending() {
  prefetchCtl.abort();
  for (const [k, e] of audioCache) if (!e.started) audioCache.delete(k);
  prefetchCtl = new AbortController();
}
function audioFor(i) {
  const k = keyFor(i);
  if (!audioCache.has(k)) {
    const [who, text] = story.lines[i];
    const c = castOf(who);
    const li = el.script.children[i];
    li?.classList.add('busy');
    const entry = { started: false };
    entry.p = tts.synth(text, {
      voice: c.voice, speed: c.speed, steps: Number(el.steps.value), lang: 'ko',
      signal: prefetchCtl.signal, onStart: () => { entry.started = true; },
    }).finally(() => li?.classList.remove('busy'));
    entry.p.catch(() => { if (audioCache.get(k) === entry) audioCache.delete(k); });
    audioCache.set(k, entry);
  }
  return audioCache.get(k).p;
}
function warmup(from = 0) {
  if (!ready || !story) return;
  for (let k = 0; k <= LOOKAHEAD && from + k < story.lines.length; k++) audioFor(from + k).catch(() => {});
}

/* ---------- 오디오 ---------- */
function ensureCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function stopAudio() {
  if (source) { source.onended = null; try { source.stop(); } catch (_) { /* ended */ } source = null; }
}
function playPCM(pcm) {
  const ctx = ensureCtx();
  const buf = ctx.createBuffer(1, pcm.length, tts.sampleRate);
  buf.copyToChannel(pcm, 0);
  return new Promise((resolve) => {
    source = ctx.createBufferSource();
    source.buffer = buf;
    source.connect(ctx.destination);
    source.onended = () => { source = null; resolve(); };
    source.start();
  });
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------- 재생 루프 ---------- */
async function run(from) {
  const my = ++runId;
  stopAudio();
  cancelPending();
  playing = true;
  idx = from;
  renderPlayState();
  while (my === runId && idx < story.lines.length) {
    highlight(idx);
    const t0 = performance.now();
    const cur = audioFor(idx);
    for (let k = 1; k <= LOOKAHEAD && idx + k < story.lines.length; k++) audioFor(idx + k).catch(() => {});
    let pcm;
    try {
      pcm = await cur;
    } catch (e) {
      if (my !== runId) return;
      console.error(e);
      el.engine.textContent = `음성을 만들지 못했어요: ${e.message}`;
      break;
    }
    if (my !== runId) return;
    const waited = performance.now() - t0;
    if (waited > 50) console.info(`[player] ${idx + 1}번째 줄 대기 ${(waited / 1000).toFixed(2)}s (끊김)`);
    await playPCM(pcm);
    if (my !== runId) return;
    markDone(idx);
    idx += 1;
    await wait(250);
  }
  if (my === runId) {
    playing = false;
    if (idx >= story.lines.length) {
      idx = 0;
      highlight(-1);
      el.spotName.textContent = '';
      el.spotText.textContent = '끝! 다시 들으려면 재생을 눌러 주세요.';
      warmup(0);
    }
    renderPlayState();
  }
}
function pause() {
  runId++;
  stopAudio();
  playing = false;
  renderPlayState();
}
function jump(i) {
  if (!story) return;
  i = Math.max(0, Math.min(story.lines.length - 1, i));
  resetMarks(i);
  if (playing) run(i);
  else { idx = i; highlight(i); }
}

/* ---------- 렌더링 ---------- */
function renderStoryList() {
  el.storyList.replaceChildren(...stories.map((s) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.setAttribute('aria-current', String(story?.id === s.id));
    const pic = document.createElement('span'); pic.className = 's-pic'; pic.setAttribute('aria-hidden', 'true');
    pic.textContent = s.emoji || '📖';
    const t = document.createElement('span'); t.className = 's-title'; t.textContent = s.title;
    const src = document.createElement('span'); src.className = 's-src'; src.textContent = s.source;
    b.append(pic, t, src);
    b.onclick = () => selectStory(s.id);
    li.append(b);
    return li;
  }));
}
function renderCast() {
  el.castList.replaceChildren(...Object.entries(story.cast).map(([name, c]) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.style.setProperty('--c', colorOf(name));
    const n = document.createElement('strong'); n.textContent = name;
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `${name} 목소리`);
    for (const v of VOICES) {
      const o = document.createElement('option'); o.value = v; o.textContent = VOICE_LABEL[v];
      if (v === c.voice) o.selected = true;
      sel.append(o);
    }
    sel.onchange = () => {
      c.voice = sel.value;
      if (story.user) saveUserStories();
      if (playing) run(idx);
      else { cancelPending(); warmup(idx); }
    };
    const hear = document.createElement('button');
    hear.textContent = '들어보기';
    hear.disabled = !ready;
    hear.onclick = async () => {
      if (!ready) return;
      pause();
      ensureCtx();
      const line = story.lines.find(([w]) => w === name);
      const text = line ? line[1] : `안녕, 나는 ${name}이야.`;
      hear.disabled = true;
      try { await playPCM(await tts.synth(text, { voice: c.voice, speed: c.speed, steps: Number(el.steps.value) })); }
      catch (e) { console.error(e); el.engine.textContent = `음성을 만들지 못했어요: ${e.message}`; }
      finally { hear.disabled = false; }
    };
    chip.append(n, sel, hear);
    return chip;
  }));
}
function renderScript() {
  el.script.replaceChildren(...story.lines.map(([who, text], i) => {
    castOf(who);
    const li = document.createElement('li');
    li.style.setProperty('--c', colorOf(who));
    const b = document.createElement('button');
    const w = document.createElement('span'); w.className = 'who'; w.textContent = who;
    const s = document.createElement('span'); s.className = 'said'; s.textContent = shown(text);
    b.append(w, s);
    b.onclick = () => { if (!ready) return; resetMarks(i); ensureCtx(); run(i); };
    li.append(b);
    return li;
  }));
}
function highlight(i) {
  [...el.script.children].forEach((li, k) => li.classList.toggle('now', k === i));
  if (i < 0) return;
  const [who, text] = story.lines[i];
  document.querySelector('.spotlight').style.setProperty('--c', colorOf(who));
  el.spotName.textContent = who;
  el.spotText.textContent = shown(text);
  el.progress.textContent = `${i + 1} / ${story.lines.length}`;
  const li = el.script.children[i];
  li?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
function markDone(i) { el.script.children[i]?.classList.add('done'); }
function resetMarks(from) {
  [...el.script.children].forEach((li, k) => li.classList.toggle('done', k < from));
}
function renderPlayState() {
  el.play.textContent = playing ? '❚❚' : '▶';
  el.play.setAttribute('aria-label', playing ? '일시정지' : '재생');
  el.play.disabled = !ready || !story;
}
function selectStory(id) {
  pause();
  cancelPending();
  story = stories.find((s) => s.id === id);
  idx = 0;
  el.storyTitle.textContent = story.title;
  el.storySource.textContent = story.source;
  renderStoryList();
  renderScript();
  renderCast();
  resetMarks(0);
  highlight(-1);
  el.spotName.textContent = '';
  el.spotText.textContent = ready ? '재생을 눌러 주세요.' : '음성 엔진을 준비하는 동안 대본을 먼저 읽어 보세요.';
  el.progress.textContent = `0 / ${story.lines.length}`;
  renderPlayState();
  warmup(0);
}

/* ---------- 내 이야기 넣기 ---------- */
function parseStory(title, body) {
  const lines = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^:：]{1,12})\s*[:：]\s*(.+)$/);
    lines.push(m ? [m[1].trim(), m[2].trim()] : ['해설', line]);
  }
  return { id: `user-${Date.now()}`, source: '내 이야기', emoji: '✏️', title: title.trim(), cast: {}, lines, user: true };
}
el.openEditor.onclick = () => { el.edTitle.value = ''; el.edBody.value = ''; el.editor.showModal(); };
el.editor.addEventListener('close', () => {
  if (el.editor.returnValue !== 'save') return;
  const s = parseStory(el.edTitle.value, el.edBody.value);
  if (!s.title || !s.lines.length) return;
  story = s;
  s.lines.forEach(([w]) => castOf(w));
  stories.push(s);
  saveUserStories();
  selectStory(s.id);
});

/* ---------- 조작 ---------- */
el.play.onclick = () => {
  if (!ready || !story) return;
  ensureCtx();
  if (playing) pause(); else run(idx);
};
el.prev.onclick = () => jump(idx - 1);
el.next.onclick = () => jump(idx + 1);
el.steps.onchange = () => {
  if (playing) run(idx);
  else { cancelPending(); warmup(idx); }
};
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, dialog')) return;
  if (e.code === 'Space') { e.preventDefault(); el.play.click(); }
  if (e.code === 'ArrowLeft') el.prev.click();
  if (e.code === 'ArrowRight') el.next.click();
});

/* ---------- 시작 ---------- */
selectStory(stories[0].id);
tts.load((msg) => { el.engine.textContent = msg; })
  .then(async () => {
    await tts.style(castOf(story.lines[0][0]).voice);
    ready = true;
    el.engine.textContent = `준비 완료 (${tts.backend})`;
    renderCast();
    renderPlayState();
    if (!playing) el.spotText.textContent = '재생을 눌러 주세요.';
    warmup(idx);
  })
  .catch((e) => {
    console.error(e);
    el.engine.textContent = `음성 엔진을 불러오지 못했어요: ${e.message}`;
  });
