import { SupertonicTTS, VOICES } from './tts.js';
import { STORIES } from './stories.js';

// 인물별 글씨 색 (해설은 기본 글씨 색). 밝은 종이 위에서 읽히는 진한 색 위주.
const COLORS = ['#c0392b', '#2e6fd8', '#8e44ad', '#1e8a5a', '#d2691e', '#b0306a', '#0f7f8f', '#7a6a12'];
const NARRATOR = '해설';
const VOICE_LABEL = {
  F1: '여성 1', F2: '여성 2', F3: '여성 3', F4: '여성 4', F5: '여성 5',
  M1: '남성 1', M2: '남성 2', M3: '남성 3', M4: '남성 4', M5: '남성 5',
};
const USER_KEY = 'story-player:user-stories';
const REPEAT_KEY = 'story-player:repeat';
const LOOKAHEAD = 2; // 재생 중 미리 합성해 둘 문장 수 (이야기를 고르면 첫 문장 + LOOKAHEAD 문장도 미리 합성)
const NARRATION_PER_PARA = 3; // 해설 문장을 한 문단에 몇 개까지 이어 붙일지
const GAP_MS = 250; // 문장 사이 쉼
const THINK_MS = 4000; // 질문 뒤 아이가 생각할 시간
const NEXT_STORY_MS = 1500; // 반복·이어 듣기에서 다음 이야기 전 쉼
const DEFAULT_OUTRO = ['이야기 잘 들었나요?', '이야기에서 가장 기억에 남는 장면은 무엇인가요? 왜 그런가요?'];

// 삽화 배경별 꾸밈 그림과 위치(%)
const DECO = {
  forest: ['🌲', '🌳', '🌲'], field: ['☁️', '🌼', '🌷'], sky: ['☁️', '☁️', '🕊️'], river: ['☁️', '🌿', '🐟'],
  house: ['🪟', '🖼️', '🪴'], village: ['☁️', '🏡', '🌳'], palace: ['🚩', '✨', '☁️'], night: ['🌙', '⭐', '✨'],
};
const DECO_POS = [[10, 12], [88, 10], [66, 6]];
const ITEM_X = { 1: [50], 2: [30, 70], 3: [20, 50, 80], 4: [14, 38, 62, 86] };

// 표현 태그는 합성에만 쓰고 화면에는 숨김
const TAG_RE = /<\s*[a-z]+\s*>/gi;
const shown = (t) => t.replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();

const $ = (id) => document.getElementById(id);
const el = {
  engine: $('engine'), storyList: $('storyList'), scene: $('scene'), storyTitle: $('storyTitle'),
  storySource: $('storySource'), legend: $('castLegend'), book: $('book'), ask: $('ask'), hint: $('hint'),
  castList: $('castList'), repeat: $('repeat'),
  play: $('playBtn'), prev: $('prevBtn'), next: $('nextBtn'), steps: $('steps'), progress: $('progress'),
  editor: $('editor'), openEditor: $('openEditor'), edTitle: $('edTitle'), edBody: $('edBody'),
};

const tts = new SupertonicTTS();
let ready = false;
let stories = [...STORIES, ...loadUserStories()];
let story = null;
let seq = []; // 읽을 순서: 본문 + 마무리 질문. { who, text, ask, q }
let sents = []; // 문장 번호 → 화면의 <span>/<p>
let idx = 0;
let playing = false;
let runId = 0;
let audioCtx = null;
let source = null;
// key → { p: Promise<Float32Array>, started: boolean }
const audioCache = new Map();
let prefetchCtl = new AbortController();

/* ---------- 저장 ---------- */
function loadUserStories() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || '[]'); } catch (_) { return []; }
}
function saveUserStories() {
  try { localStorage.setItem(USER_KEY, JSON.stringify(stories.filter((s) => s.user))); } catch (_) { /* ignore */ }
}
try { el.repeat.value = localStorage.getItem(REPEAT_KEY) || 'off'; } catch (_) { /* ignore */ }
el.repeat.onchange = () => { try { localStorage.setItem(REPEAT_KEY, el.repeat.value); } catch (_) { /* ignore */ } };

/* ---------- 색상/목소리 ---------- */
function characters() {
  return Object.keys(story.cast).filter((n) => n !== NARRATOR);
}
function colorOf(name) {
  if (name === NARRATOR) return null;
  return COLORS[characters().indexOf(name) % COLORS.length];
}
// 목소리는 자동 배정: 아직 안 쓴 목소리부터 차례로. 필요하면 "목소리 바꾸기"에서 변경.
function castOf(name) {
  if (!story.cast[name]) {
    const used = new Set(Object.values(story.cast).map((c) => c.voice));
    const voice = VOICES.find((v) => !used.has(v)) || VOICES[Object.keys(story.cast).length % VOICES.length];
    story.cast[name] = { voice, speed: name === NARRATOR ? 0.95 : 1.0 };
  }
  return story.cast[name];
}
function buildSeq() {
  const body = story.lines.map(([who, text]) => ({ who, text, ask: false, q: false }));
  const outro = (story.outro?.length ? story.outro : DEFAULT_OUTRO)
    .map((text, k) => ({ who: NARRATOR, text, ask: true, q: k > 0 }));
  return [...body, ...outro];
}
function keyFor(i) {
  const { who, text } = seq[i];
  const c = castOf(who);
  return `${story.id}|${i}|${c.voice}|${c.speed}|${el.steps.value}|${text}`;
}

/* ---------- 합성 캐시 ---------- */
// 목소리·품질·이야기·위치가 바뀌면 아직 시작하지 않은 미리 합성을 버려서, 바뀐 설정이 곧바로 반영되게 함.
// 이미 합성 중인 문장은 그대로 두어 같은 문장을 두 번 합성하지 않음.
function cancelPending() {
  prefetchCtl.abort();
  for (const [k, e] of audioCache) if (!e.started) audioCache.delete(k);
  prefetchCtl = new AbortController();
}
function audioFor(i) {
  const k = keyFor(i);
  if (!audioCache.has(k)) {
    const { who, text } = seq[i];
    const c = castOf(who);
    const node = sents[i];
    node?.classList.add('busy');
    const entry = { started: false };
    entry.p = tts.synth(text, {
      voice: c.voice, speed: c.speed, steps: Number(el.steps.value), lang: 'ko',
      signal: prefetchCtl.signal, onStart: () => { entry.started = true; },
    }).finally(() => node?.classList.remove('busy'));
    entry.p.catch(() => { if (audioCache.get(k) === entry) audioCache.delete(k); });
    audioCache.set(k, entry);
  }
  return audioCache.get(k).p;
}
function warmup(from = 0) {
  if (!ready || !story) return;
  for (let k = 0; k <= LOOKAHEAD && from + k < seq.length; k++) audioFor(from + k).catch(() => {});
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

/* ---------- 반복 / 이어 듣기 ---------- */
// off: 한 번만 / one: 이 이야기 반복 / group: 같은 모음(탈무드·이솝·내 이야기) 차례로 반복 / all: 전체 차례로 반복
function nextStoryId() {
  const mode = el.repeat.value;
  if (mode === 'one') return story.id;
  if (mode === 'off') return null;
  const pool = mode === 'group' ? stories.filter((s) => s.source === story.source) : stories;
  const at = pool.findIndex((s) => s.id === story.id);
  return pool[(at + 1) % pool.length].id;
}

/* ---------- 재생 루프 ---------- */
async function run(from) {
  const my = ++runId;
  stopAudio();
  cancelPending();
  playing = true;
  idx = from;
  el.hint.textContent = '';
  renderPlayState();
  while (my === runId && idx < seq.length) {
    highlight(idx);
    const t0 = performance.now();
    const cur = audioFor(idx);
    for (let k = 1; k <= LOOKAHEAD && idx + k < seq.length; k++) audioFor(idx + k).catch(() => {});
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
    if (waited > 50) console.info(`[player] ${idx + 1}번째 문장 대기 ${(waited / 1000).toFixed(2)}s (끊김)`);
    await playPCM(pcm);
    if (my !== runId) return;
    await wait(seq[idx].q ? THINK_MS : GAP_MS);
    if (my !== runId) return;
    idx += 1;
  }
  if (my !== runId) return;
  playing = false;
  if (idx >= seq.length) {
    const nextId = nextStoryId();
    if (nextId) {
      el.hint.textContent = nextId === story.id ? '처음부터 다시 들려줄게요.' : '다음 이야기로 넘어갈게요.';
      await wait(NEXT_STORY_MS);
      if (my !== runId) return;
      if (nextId !== story.id) selectStory(nextId);
      run(0);
      return;
    }
    idx = 0;
    highlight(-1);
    el.hint.textContent = '끝! 다시 들으려면 재생을 눌러 주세요.';
    warmup(0);
  }
  renderPlayState();
}
function pause() {
  runId++;
  stopAudio();
  playing = false;
  renderPlayState();
}
function jump(i) {
  if (!story) return;
  i = Math.max(0, Math.min(seq.length - 1, i));
  if (playing) run(i);
  else { idx = i; highlight(i); cancelPending(); warmup(i); }
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
// 삽화: story.image(그린 그림)가 있으면 그것을, 없으면 배경 + 그림 장면(scene)을 그림
function renderScene() {
  el.scene.setAttribute('aria-label', `${story.title} 그림`);
  if (story.image) {
    const img = document.createElement('img');
    img.src = story.image;
    img.alt = '';
    el.scene.className = 'scene';
    el.scene.replaceChildren(img);
    return;
  }
  const sc = story.scene || { bg: 'field', items: [story.emoji || '📖'] };
  el.scene.className = `scene bg-${sc.bg}`;
  const deco = (DECO[sc.bg] || []).map((e, k) => {
    const s = document.createElement('span');
    s.className = 'deco';
    s.textContent = e;
    s.style.left = `${DECO_POS[k][0]}%`;
    s.style.top = `${DECO_POS[k][1]}%`;
    return s;
  });
  const items = sc.items.slice(0, 4);
  const xs = ITEM_X[items.length];
  const figs = items.map((e, k) => {
    const s = document.createElement('span');
    s.className = 'item';
    s.textContent = e;
    s.style.left = `${xs[k]}%`;
    return s;
  });
  el.scene.replaceChildren(...deco, ...figs);
}
// 등장인물 이름을 글씨 색으로 보여 주는 한 줄
function renderLegend() {
  el.legend.replaceChildren(...characters().map((name) => {
    const s = document.createElement('span');
    s.style.setProperty('--c', colorOf(name));
    s.textContent = name;
    return s;
  }));
}
function renderCast() {
  el.castList.replaceChildren(...Object.entries(story.cast).map(([name, c]) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.style.setProperty('--c', colorOf(name) || 'var(--ink-soft)');
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
// 그림책처럼: 해설은 문단으로 이어 쓰고, 인물의 말은 따옴표와 인물 글씨 색으로 한 문단씩.
// 마무리 질문은 "생각해 볼까요?" 상자에.
function renderBook() {
  sents = [];
  const paras = [];
  const asks = [];
  let para = null;
  let count = 0;
  seq.forEach(({ who, text, ask, q }, i) => {
    castOf(who);
    const s = document.createElement(ask ? 'p' : 'span');
    s.className = ask ? `sent${q ? ' q' : ''}` : 'sent';
    s.onclick = () => { if (!ready) return; ensureCtx(); run(i); };
    sents.push(s);
    if (ask) {
      s.textContent = shown(text);
      asks.push(s);
      return;
    }
    const talk = who !== NARRATOR;
    if (talk || !para || para.classList.contains('talk') || count >= NARRATION_PER_PARA) {
      para = document.createElement('p');
      if (talk) para.className = 'talk';
      paras.push(para);
      count = 0;
    } else {
      para.append(' ');
    }
    count += 1;
    const color = colorOf(who);
    if (color) {
      s.style.setProperty('--c', color);
      s.title = who;
    }
    s.textContent = talk ? `“${shown(text)}”` : shown(text);
    para.append(s);
  });
  el.book.replaceChildren(...paras);
  el.ask.replaceChildren(...asks);
}
function highlight(i) {
  sents.forEach((s, k) => s.classList.toggle('now', k === i));
  el.progress.textContent = `${i >= 0 ? i + 1 : 0} / ${seq.length}`;
  if (i < 0) return;
  sents[i]?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
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
  seq = buildSeq();
  idx = 0;
  el.storyTitle.textContent = story.title;
  el.storySource.textContent = story.source;
  renderStoryList();
  renderScene();
  renderBook();
  renderLegend();
  renderCast();
  highlight(-1);
  el.hint.textContent = ready ? '재생을 누르거나, 듣고 싶은 문장을 눌러 주세요.' : '목소리를 준비하는 동안 먼저 읽어 보세요.';
  renderPlayState();
  window.scrollTo({ top: 0 });
  warmup(0);
}

/* ---------- 내 이야기 넣기 ---------- */
function parseStory(title, body) {
  const lines = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^:：]{1,12})\s*[:：]\s*(.+)$/);
    lines.push(m ? [m[1].trim(), m[2].trim()] : [NARRATOR, line]);
  }
  return {
    id: `user-${Date.now()}`, source: '내 이야기', emoji: '✏️', title: title.trim(),
    scene: { bg: 'field', items: ['✏️', '📖'] }, cast: {}, lines, user: true,
  };
}
el.openEditor.onclick = () => { el.edTitle.value = ''; el.edBody.value = ''; el.editor.showModal(); };
el.editor.addEventListener('close', () => {
  if (el.editor.returnValue !== 'save') return;
  const s = parseStory(el.edTitle.value, el.edBody.value);
  if (!s.title || !s.lines.length) return;
  story = s;
  castOf(NARRATOR);
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
  if (e.target.closest('input, textarea, select, dialog, summary')) return;
  if (e.code === 'Space') { e.preventDefault(); el.play.click(); }
  if (e.code === 'ArrowLeft') el.prev.click();
  if (e.code === 'ArrowRight') el.next.click();
});

/* ---------- 시작 ---------- */
selectStory(stories[0].id);
tts.load((msg) => { el.engine.textContent = msg; })
  .then(async () => {
    await tts.style(castOf(seq[0].who).voice);
    ready = true;
    el.engine.textContent = `준비 완료 (${tts.backend})`;
    renderCast();
    renderPlayState();
    if (!playing) el.hint.textContent = '재생을 누르거나, 듣고 싶은 문장을 눌러 주세요.';
    warmup(idx);
  })
  .catch((e) => {
    console.error(e);
    el.engine.textContent = `음성 엔진을 불러오지 못했어요: ${e.message}`;
  });
