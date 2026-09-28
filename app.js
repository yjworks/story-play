import { createTTS, VOICES } from './tts-client.js';
import { STORIES } from './stories.js';

/* ---------- 진단 기록 (휴대폰에서도 원인을 볼 수 있게) ---------- */
// [tts]·[player] 로그와 오류를 모아 두었다가, 상단 상태 문구를 누르면 보여 줌
const diag = [];
const t0 = performance.now();
function note(kind, args) {
  const text = args.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  diag.push(`${((performance.now() - t0) / 1000).toFixed(1)}s ${kind} ${text}`.slice(0, 400));
  if (diag.length > 60) diag.shift();
}
for (const k of ['info', 'warn', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...args) => { note(k === 'info' ? '·' : k === 'warn' ? '!' : '✕', args); orig(...args); };
}
window.addEventListener('error', (e) => note('✕', [e.error || e.message]));
window.addEventListener('unhandledrejection', (e) => note('✕', [e.reason]));

// 인물별 글씨 색 (해설은 기본 글씨 색). 밝은 종이 위에서 읽히는 진한 색 위주.
const COLORS = ['#c0392b', '#2e6fd8', '#8e44ad', '#1e8a5a', '#d2691e', '#b0306a', '#0f7f8f', '#7a6a12'];
const NARRATOR = '해설';
const VOICE_LABEL = {
  F1: '여성 1', F2: '여성 2', F3: '여성 3', F4: '여성 4', F5: '여성 5',
  M1: '남성 1', M2: '남성 2', M3: '남성 3', M4: '남성 4', M5: '남성 5',
};
const USER_KEY = 'story-player:user-stories';
const REPEAT_KEY = 'story-player:repeat';
const PLAYLIST_KEY = 'story-player:playlist';
const FILTER_KEY = 'story-player:filter';
const LAST_KEY = 'story-player:last'; // 이어 읽기: { id, idx }
// 이야기 표지 색 (모음 순서대로)
const COVER_COLORS = ['#2f7d6d', '#4f7a2e', '#b5452f', '#3b5ca8', '#7a4a9e', '#b0306a', '#b8741a', '#2b6f8f', '#8a5a2b', '#5a6b2f'];
const LOOKAHEAD = 4; // 재생 중 미리 합성해 둘 문장 수 (이야기를 고르면 첫 문장 + LOOKAHEAD 문장도 미리 합성)
// 화면을 끄거나 다른 앱으로 가면 휴대폰이 계산을 늦춰서, 앞서 만들어 둔 문장이 많을수록 끊김이 늦게 옴
const NARRATION_PER_PARA = 3; // 해설 문장을 한 문단에 몇 개까지 이어 붙일지
const GAP_MS = 250; // 문장 사이 쉼
const THINK_MS = 7000; // 질문 뒤 아이가 생각할 시간
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
  storySource: $('storySource'), legend: $('castLegend'), book: $('book'), hint: $('hint'), page: $('page'),
  pgPrev: $('pgPrev'), pgNext: $('pgNext'), pgNum: $('pgNum'), voices: $('voices'), pager: document.querySelector('.pager'),
  shelf: $('shelf'), openShelf: $('openShelf'), closeShelf: $('closeShelf'), backdrop: $('shelfBackdrop'),
  castList: $('castList'), repeat: $('repeat'),
  playlist: $('playlist'), plCount: $('plCount'), plEmpty: $('plEmpty'), plPlay: $('plPlay'), plClear: $('plClear'),
  play: $('playBtn'), prev: $('prevBtn'), next: $('nextBtn'), steps: $('steps'), progress: $('progress'),
  editor: $('editor'), openEditor: $('openEditor'), edTitle: $('edTitle'), edBody: $('edBody'),
};

// 음성 엔진은 가능하면 별도 스레드(워커)에서 돌림 → 합성 중에도 화면이 멈추지 않음
const tts = await createTTS();
// 저장 공간이 부족해도 브라우저가 모델 캐시를 지우지 않도록 영구 저장 요청(워커에서는 못 함)
try { navigator.storage?.persist?.(); } catch (_) { /* unsupported */ }
let ready = false;
let stories = [...STORIES, ...loadUserStories()];
let story = null;
let playlist = loadPlaylist(); // 재생목록: 이야기 id 배열 (같은 이야기를 여러 번 담아도 됨)
let srcFilter = loadFilter(); // 이야기 목록 모음 태그: 'all' 또는 source 값(탈무드, 이솝우화, 내 이야기 …)
let plPos = -1; // 지금 재생목록의 몇 번째를 듣는 중인지 (-1: 재생목록 밖)
let seq = []; // 읽을 순서: 본문 + 마무리 질문. { who, text, ask, q }
let sents = []; // 문장 번호 → 화면의 <span>/<p>
let units = []; // 쪽을 나누는 단위(문단, 질문 상자): { node, first, ask }
let pages = []; // 쪽 <div>
let pageOf = []; // 문장 번호 → 쪽 번호
let curPage = 0;
let idx = 0;
let playing = false;
let runId = 0;
let audioCtx = null;
let source = null;
// key → { p: Promise<Float32Array>, started: boolean }
const audioCache = new Map();

/* ---------- 저장 ---------- */
function loadUserStories() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || '[]'); } catch (_) { return []; }
}
function saveUserStories() {
  try { localStorage.setItem(USER_KEY, JSON.stringify(stories.filter((s) => s.user))); } catch (_) { /* ignore */ }
}
function loadPlaylist() {
  try {
    const ids = new Set(stories.map((s) => s.id));
    return JSON.parse(localStorage.getItem(PLAYLIST_KEY) || '[]').filter((id) => ids.has(id));
  } catch (_) { return []; }
}
function savePlaylist() {
  try { localStorage.setItem(PLAYLIST_KEY, JSON.stringify(playlist)); } catch (_) { /* ignore */ }
}
try {
  const saved = localStorage.getItem(REPEAT_KEY);
  el.repeat.value = ['off', 'one', 'list'].includes(saved) ? saved : (saved ? 'list' : 'off');
} catch (_) { /* ignore */ }
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
  // 맨 앞은 제목(표지에서 해설이 읽음), 이어서 본문, 끝에 마무리 질문
  const title = { who: NARRATOR, text: story.title, ask: false, q: false, title: true };
  const body = story.lines.map(([who, text]) => ({ who, text, ask: false, q: false }));
  const outro = (story.outro?.length ? story.outro : DEFAULT_OUTRO)
    .map((text, k) => ({ who: NARRATOR, text, ask: true, q: k > 0 }));
  return [title, ...body, ...outro];
}
function keyFor(i) {
  const { who, text } = seq[i];
  const c = castOf(who);
  return `${story.id}|${i}|${c.voice}|${c.speed}|${el.steps.value}|${text}`;
}

/* ---------- 합성 캐시 ---------- */
// 목소리·품질·이야기·위치가 바뀌면 아직 시작하지 않은 미리 합성을 버려서, 바뀐 설정이 곧바로 반영되게 함.
// 이미 합성 중인 문장은 그대로 두어 같은 문장을 두 번 합성하지 않음.
// from 을 주면 from ~ from+LOOKAHEAD 문장은 버리지 않음(재생을 누를 때 미리 만들던 문장을 다시 만들지 않도록).
function cancelPending(from = -1) {
  const keep = new Set();
  for (let k = 0; from >= 0 && k <= LOOKAHEAD && from + k < seq.length; k++) keep.add(keyFor(from + k));
  for (const [k, e] of audioCache) {
    if (!e.started && !keep.has(k)) { e.ctl.abort(); audioCache.delete(k); }
  }
}
function audioFor(i) {
  const k = keyFor(i);
  if (!audioCache.has(k)) {
    const { who, text } = seq[i];
    const c = castOf(who);
    const node = sents[i];
    node?.classList.add('busy');
    const entry = { started: false, ctl: new AbortController() };
    entry.p = tts.synth(text, {
      voice: c.voice, speed: c.speed, steps: Number(el.steps.value), lang: 'ko',
      signal: entry.ctl.signal, onStart: () => { entry.started = true; },
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
// tail: 소리 뒤에 붙일 쉼(ms). 타이머(setTimeout)로 기다리지 않고 소리 안에 무음으로 넣음 →
// 화면이 꺼져 타이머가 느려져도(백그라운드에서 최대 1초 단위) 쉼 길이가 그대로 유지됨
function playPCM(pcm, tail = 0) {
  const ctx = ensureCtx();
  const pad = Math.floor((tail / 1000) * tts.sampleRate);
  const buf = ctx.createBuffer(1, pcm.length + pad, tts.sampleRate);
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

/* ---------- 반복 / 재생목록 ---------- */
// 음악 플레이어처럼: 재생목록에서 듣는 중이면 끝나면 다음 이야기로.
//  반복 안 함: 목록 끝에서 멈춤 / 한 편 반복: 지금 이야기만 다시 / 목록 반복: 끝나면 목록 처음으로.
// 재생목록 밖의 이야기는 한 편 반복일 때만 다시 들려줌.
function nextStep() {
  const mode = el.repeat.value;
  if (mode === 'one') return { id: story.id, pos: plPos };
  if (plPos < 0 || playlist[plPos] !== story.id) return null;
  if (plPos + 1 < playlist.length) return { id: playlist[plPos + 1], pos: plPos + 1 };
  if (mode === 'list' && playlist.length) return { id: playlist[0], pos: 0 };
  return null;
}
function playFromList(pos) {
  if (!ready || !playlist[pos]) return;
  ensureCtx();
  closeShelf();
  selectStory(playlist[pos], pos);
  run(0);
}
function addToList(id) {
  playlist.push(id);
  savePlaylist();
  renderPlaylist();
  renderStoryList();
}
function removeFromList(pos) {
  playlist.splice(pos, 1);
  if (plPos === pos) plPos = -1;
  else if (plPos > pos) plPos -= 1;
  savePlaylist();
  renderPlaylist();
  renderStoryList();
}
function moveInList(pos, d) {
  const to = pos + d;
  if (to < 0 || to >= playlist.length) return;
  [playlist[pos], playlist[to]] = [playlist[to], playlist[pos]];
  if (plPos === pos) plPos = to;
  else if (plPos === to) plPos = pos;
  savePlaylist();
  renderPlaylist();
}
function renderPlaylist() {
  const title = (id) => stories.find((s) => s.id === id)?.title || id;
  el.playlist.replaceChildren(...playlist.map((id, pos) => {
    const li = document.createElement('li');
    li.classList.toggle('on', pos === plPos);
    const t = document.createElement('button');
    t.className = 'pl-title';
    t.textContent = title(id);
    t.onclick = () => playFromList(pos);
    const mk = (label, aria, fn) => {
      const b = document.createElement('button');
      b.className = 'pl-btn'; b.textContent = label; b.setAttribute('aria-label', aria); b.onclick = fn;
      return b;
    };
    li.append(t,
      mk('▲', `${title(id)} 위로`, () => moveInList(pos, -1)),
      mk('▼', `${title(id)} 아래로`, () => moveInList(pos, 1)),
      mk('✕', `${title(id)} 빼기`, () => removeFromList(pos)));
    return li;
  }));
  el.plCount.textContent = playlist.length ? `${playlist.length}편` : '';
  el.plEmpty.hidden = playlist.length > 0;
  el.plPlay.disabled = !ready || !playlist.length;
}
el.plPlay.onclick = () => playFromList(0);
el.plClear.onclick = () => {
  if (!playlist.length || !confirm('재생목록을 비울까요?')) return;
  playlist = [];
  plPos = -1;
  savePlaylist();
  renderPlaylist();
  renderStoryList();
};
// 지금 목록에 보이는(태그로 거른) 이야기 가운데 아직 안 담긴 것을 모두 담기
$('plAddShown').onclick = () => {
  shownStories().filter((s) => !playlist.includes(s.id)).forEach((s) => playlist.push(s.id));
  savePlaylist();
  renderPlaylist();
  renderStoryList();
};

/* ---------- 모음 태그 (전체 / 탈무드 / 이솝우화 …) ---------- */
// 태그는 stories.js 의 source 값에서 자동으로 만듦 → 새 모음을 추가해도 코드 수정 없음
function loadFilter() {
  try { return localStorage.getItem(FILTER_KEY) || 'all'; } catch (_) { return 'all'; }
}
function sources() {
  return [...new Set(stories.map((s) => s.source))];
}
function shownStories() {
  return srcFilter === 'all' ? stories : stories.filter((s) => s.source === srcFilter);
}
function renderFilter() {
  if (srcFilter !== 'all' && !sources().includes(srcFilter)) srcFilter = 'all';
  const tags = [['all', '전체', stories.length], ...sources().map((src) => [src, src, stories.filter((s) => s.source === src).length])];
  $('srcFilter').replaceChildren(...tags.map(([val, label, n]) => {
    const b = document.createElement('button');
    b.className = 'tag';
    b.setAttribute('aria-pressed', String(srcFilter === val));
    b.append(label, Object.assign(document.createElement('span'), { className: 'n', textContent: n }));
    b.onclick = () => {
      srcFilter = val;
      try { localStorage.setItem(FILTER_KEY, val); } catch (_) { /* ignore */ }
      renderFilter();
      renderStoryList();
    };
    return b;
  }));
}

/* ---------- 재생 루프 ---------- */
async function run(from) {
  const my = ++runId;
  stopAudio();
  cancelPending(from);
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
    // 합성이 오래 걸리면 멈춘 것처럼 보이지 않게 안내
    const slow = setTimeout(() => { if (my === runId) el.hint.textContent = '목소리를 만드는 중이에요…'; }, 800);
    try {
      pcm = await cur;
      clearTimeout(slow);
      if (my === runId) el.hint.textContent = '';
    } catch (e) {
      clearTimeout(slow);
      if (my !== runId) return;
      console.error(e);
      el.engine.textContent = `음성을 만들지 못했어요: ${e.message}`;
      break;
    }
    if (my !== runId) return;
    const waited = performance.now() - t0;
    if (waited > 50) console.info(`[player] ${idx + 1}번째 문장 대기 ${(waited / 1000).toFixed(2)}s (끊김)`);
    await playPCM(pcm, seq[idx].q ? THINK_MS : GAP_MS);
    if (my !== runId) return;
    idx += 1;
  }
  if (my !== runId) return;
  playing = false;
  if (idx >= seq.length) {
    const nx = nextStep();
    if (nx) {
      el.hint.textContent = nx.id === story.id ? '처음부터 다시 들려줄게요.' : '다음 이야기로 넘어갈게요.';
      await wait(NEXT_STORY_MS);
      if (my !== runId) return;
      selectStory(nx.id, nx.pos);
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
  else { idx = i; highlight(i); cancelPending(i); warmup(i); }
}

/* ---------- 렌더링 ---------- */
function renderStoryList() {
  el.storyList.replaceChildren(...shownStories().map((s) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'pick';
    b.setAttribute('aria-current', String(story?.id === s.id));
    const pic = document.createElement('span'); pic.className = 's-pic'; pic.setAttribute('aria-hidden', 'true');
    pic.textContent = s.emoji || '📖';
    const t = document.createElement('span'); t.className = 's-title'; t.textContent = s.title;
    const src = document.createElement('span'); src.className = 's-src'; src.textContent = s.source;
    b.append(pic, t, src);
    b.onclick = () => { selectStory(s.id); closeShelf(); };
    const add = document.createElement('button');
    add.className = 'add';
    const inList = playlist.includes(s.id);
    add.setAttribute('aria-pressed', String(inList));
    add.setAttribute('aria-label', inList ? `${s.title} 재생목록에 한 번 더 담기` : `${s.title} 재생목록에 담기`);
    add.textContent = inList ? '✓' : '＋';
    add.onclick = () => addToList(s.id);
    li.append(b, add);
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
// 마무리 질문은 마지막 쪽의 "생각해 볼까요?" 상자에.
function renderBook() {
  sents = [];
  units = [];
  let para = null;
  let count = 0;
  let askBox = null;
  seq.forEach(({ who, text, ask, q, title }, i) => {
    castOf(who);
    if (title) {
      el.storyTitle.classList.add('sent');
      sents.push(el.storyTitle);
      units.push({ node: null, first: i, cover: true });
      return;
    }
    const s = document.createElement(ask ? 'p' : 'span');
    s.className = ask ? `sent${q ? ' q' : ''}` : 'sent';
    s.onclick = () => { if (!ready) return; ensureCtx(); run(i); };
    sents.push(s);
    if (ask) {
      if (!askBox) {
        askBox = document.createElement('section');
        askBox.className = 'ask';
        const h = document.createElement('h3');
        h.textContent = '생각해 볼까요?';
        askBox.append(h);
        units.push({ node: askBox, first: i, ask: true });
      }
      s.textContent = shown(text);
      askBox.append(s);
      return;
    }
    const talk = who !== NARRATOR;
    if (talk || !para || para.classList.contains('talk') || count >= NARRATION_PER_PARA) {
      para = document.createElement('p');
      if (talk) para.className = 'talk';
      units.push({ node: para, first: i, ask: false });
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
  paginate(0);
}
// 한 화면에 한 쪽: 재생바 위까지 들어가는 만큼 문단을 담고 넘치면 다음 쪽으로.
// 첫 쪽은 삽화와 제목이 있어 짧고, 둘째 쪽부터는 제목을 한 줄로 줄여 더 많이 담음. 질문 상자는 늘 새 쪽.
function paginate(keepIdx = 0) {
  const scrollY0 = window.scrollY;
  window.scrollTo(0, 0);
  el.book.replaceChildren();
  pages = [];
  pageOf = [];
  const transportH = document.querySelector('.transport').offsetHeight;
  const tailH = el.pager.offsetHeight + el.hint.offsetHeight + 40;
  let pg = null;
  let cap = 0;
  const newPage = () => {
    if (pg) pg.hidden = true;
    pg = document.createElement('div');
    pg.className = 'pg';
    el.book.append(pg);
    pages.push(pg);
    el.page.classList.toggle('compact', pages.length > 1);
    el.page.classList.toggle('cover-page', pages.length === 1);
    const top = el.book.getBoundingClientRect().top;
    cap = Math.max(200, window.innerHeight - top - transportH - tailH);
  };
  newPage();
  let afterCover = false;
  units.forEach((u) => {
    if (u.cover) { u.page = 0; afterCover = true; return; }
    if (afterCover) { newPage(); afterCover = false; }
    if (u.ask && pg.childElementCount) newPage();
    pg.append(u.node);
    if (pg.offsetHeight > cap && pg.childElementCount > 1) {
      u.node.remove();
      newPage();
      pg.append(u.node);
    }
    u.page = pages.length - 1;
  });
  units.forEach((u, k) => {
    const end = k + 1 < units.length ? units[k + 1].first : seq.length;
    for (let i = u.first; i < end; i++) pageOf[i] = u.page;
  });
  showPage(pageOf[keepIdx] ?? 0);
  // 책 높이를 화면(재생바 위까지)에 맞춰 고정 → 쪽마다 버튼 위치가 같음
  el.page.style.minHeight = '';
  const pageTop = el.page.getBoundingClientRect().top;
  el.page.style.minHeight = `${Math.max(0, window.innerHeight - pageTop - transportH - 12)}px`;
  window.scrollTo(0, Math.min(scrollY0, document.documentElement.scrollHeight));
}
function showPage(n) {
  curPage = Math.max(0, Math.min(pages.length - 1, n));
  pages.forEach((p, k) => { p.hidden = k !== curPage; });
  el.page.classList.toggle('compact', curPage > 0);
  el.page.classList.toggle('cover-page', curPage === 0);
  el.pgNum.textContent = curPage === 0 ? '표지' : `${curPage} / ${pages.length - 1} 쪽`;
  el.pgPrev.disabled = curPage === 0;
  el.pgNext.disabled = curPage === pages.length - 1;
}
/* ---------- 책장 넘김 효과 ---------- */
// 지금 쪽을 복제해 위에 겹쳐 두고(유령), 실제 쪽은 바로 새 내용으로 바꾼 뒤
//  앞으로: 유령이 왼쪽 모서리를 축으로 넘어가며 사라짐 (표지에서 넘기면 표지가 열리는 모양)
//  뒤로: 새 쪽이 왼쪽에서 넘어 들어와 유령을 덮음
//  새 책: 유령은 옆으로 치워지고 새 표지가 들어옴
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let flipTimer = 0;
function clearFlip() {
  clearTimeout(flipTimer);
  document.querySelectorAll('.flip-ghost').forEach((g) => g.remove());
  el.page.classList.remove('flip-in', 'new-book');
}
function flip(kind, update) {
  clearFlip();
  const r = el.page.getBoundingClientRect();
  if (reduceMotion() || r.width === 0 || r.bottom < 0 || r.top > window.innerHeight) { update(); return; }
  const ghost = el.page.cloneNode(true);
  ghost.removeAttribute('id');
  ghost.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  ghost.classList.add('flip-ghost');
  Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, minHeight: '0' });
  document.body.append(ghost);
  update();
  void el.page.offsetWidth; // 애니메이션 다시 시작
  if (kind === 'fwd') ghost.classList.add('fwd');
  else if (kind === 'back') el.page.classList.add('flip-in');
  else { ghost.classList.add('away'); el.page.classList.add('new-book'); }
  flipTimer = setTimeout(clearFlip, 700);
}

function firstOfPage(n) {
  return pageOf.indexOf(n);
}
// 쪽 넘기기: 재생 중이면 그 쪽 첫 문장부터 읽고, 멈춰 있으면 다음 재생 위치만 옮김
function turnPage(d) {
  const n = curPage + d;
  if (n < 0 || n >= pages.length) return;
  const i = firstOfPage(n);
  if (playing) { run(i); return; }
  idx = i;
  highlight(-1);
  flip(d > 0 ? 'fwd' : 'back', () => showPage(n));
  el.progress.textContent = `${i + 1} / ${seq.length}`;
  saveLast();
  cancelPending();
  warmup(i);
}
el.pgPrev.onclick = () => turnPage(-1);
el.storyTitle.onclick = () => {
  if (curPage > 0) { turnPage(-curPage); return; }
  if (ready) { ensureCtx(); run(0); }
};
// 손가락으로 좌우로 밀어 쪽 넘기기
let swipe = null;
el.page.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') swipe = { x: e.clientX, y: e.clientY, t: Date.now() }; });
el.page.addEventListener('pointerup', (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  const quick = Date.now() - swipe.t < 700;
  swipe = null;
  if (quick && Math.abs(dx) > 60 && Math.abs(dy) < 50) turnPage(dx < 0 ? 1 : -1);
});
el.page.addEventListener('pointercancel', () => { swipe = null; });
el.pgNext.onclick = () => turnPage(1);
let resizeTimer = 0;
const repaginate = () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (story) paginate(playing ? idx : firstOfPage(curPage)); }, 200);
};
window.addEventListener('resize', repaginate);
el.voices.addEventListener('toggle', repaginate);
document.fonts?.ready.then(repaginate);

/* ---------- 이야기 목록 서랍 (좁은 화면) ---------- */
function openShelf() {
  el.shelf.classList.add('open');
  el.backdrop.hidden = false;
  el.openShelf.setAttribute('aria-expanded', 'true');
}
function closeShelf() {
  el.shelf.classList.remove('open');
  el.backdrop.hidden = true;
  el.openShelf.setAttribute('aria-expanded', 'false');
}
el.openShelf.onclick = openShelf;
$('aboutBtn').onclick = () => $('about').showModal();
el.closeShelf.onclick = closeShelf;
el.backdrop.onclick = closeShelf;

function highlight(i) {
  sents.forEach((s, k) => s.classList.toggle('now', k === i));
  el.progress.textContent = `${i >= 0 ? i + 1 : 0} / ${seq.length}`;
  if (i < 0) return;
  if (pageOf[i] !== curPage) {
    const to = pageOf[i];
    flip(to > curPage ? 'fwd' : 'back', () => showPage(to));
  }
  saveLast();
  sents[i]?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
function renderPlayState() {
  el.play.textContent = playing ? '❚❚' : '▶';
  el.play.setAttribute('aria-label', playing ? '일시정지' : '재생');
  el.play.disabled = !ready || !story;
  syncWakeLock();
}

/* ---------- 듣는 동안 화면 꺼짐 방지 (Screen Wake Lock) ---------- */
// 재생 중에만 화면을 켜 두고, 멈추면 놓아 줌. 다른 앱에 갔다 오면 브라우저가 풀어 버리므로 돌아올 때 다시 요청.
let wakeLock = null;
async function syncWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (playing && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!playing && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (_) { /* 절전 모드 등으로 거절될 수 있음 */ }
}
document.addEventListener('visibilitychange', () => {
  console.info(`[player] 화면 ${document.visibilityState === 'visible' ? '돌아옴' : '가려짐(화면 끔·다른 앱)'}`);
  syncWakeLock();
});
function selectStory(id, pos = -1, { anim = true } = {}) {
  if (anim && story && story.id !== id) { flip('book', () => selectStory(id, pos, { anim: false })); return; }
  pause();
  cancelPending();
  story = stories.find((s) => s.id === id);
  plPos = pos;
  seq = buildSeq();
  idx = 0;
  el.storyTitle.textContent = story.title;
  el.storySource.textContent = story.source;
  el.page.style.setProperty('--cv', COVER_COLORS[Math.max(0, sources().indexOf(story.source)) % COVER_COLORS.length]);
  renderFilter();
  renderStoryList();
  renderPlaylist();
  window.scrollTo({ top: 0 });
  renderScene();
  renderLegend();
  renderCast();
  renderBook();
  highlight(-1);
  el.hint.textContent = ready ? '재생을 누르거나, 듣고 싶은 문장을 눌러 주세요.' : '목소리를 준비하는 동안 먼저 읽어 보세요.';
  renderPlayState();
  saveLast();
  warmup(0);
}
function saveLast() {
  if (!story) return;
  try { localStorage.setItem(LAST_KEY, JSON.stringify({ id: story.id, idx })); } catch (_) { /* ignore */ }
}
function loadLast() {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
    return v && stories.some((s) => s.id === v.id) ? v : null;
  } catch (_) { return null; }
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
  if (!cover.hidden) return; // 표지가 떠 있으면 재생 키 무시
  if (e.code === 'Escape') closeShelf();
  if (e.target.closest('input, textarea, select, dialog, summary')) return;
  if (e.code === 'Space') { e.preventDefault(); el.play.click(); }
  if (e.code === 'ArrowLeft') el.prev.click();
  if (e.code === 'ArrowRight') el.next.click();
  if (e.code === 'PageUp') turnPage(-1);
  if (e.code === 'PageDown') turnPage(1);
});

/* ---------- 앱 표지 (이야기 극장) ---------- */
// 들어올 때와 "이야기 극장"을 누를 때 보여 줌. 표지의 버튼을 누르는 순간 오디오도 깨워 둠(브라우저 자동 재생 정책).
const cover = $('cover');
function renderCover() {
  $('coverSub').textContent = `옛이야기 ${stories.length}편을 인물마다 다른 목소리로 들려줘요`;
  $('coverToc').replaceChildren(...sources().map((src) => {
    const b = document.createElement('button');
    b.append(src, Object.assign(document.createElement('span'), { textContent: stories.filter((s) => s.source === src).length }));
    b.onclick = () => {
      srcFilter = src;
      try { localStorage.setItem(FILTER_KEY, src); } catch (_) { /* ignore */ }
      openBook(stories.find((s) => s.source === src).id, 0);
      if (matchMedia('(max-width: 1100px)').matches) openShelf();
    };
    return b;
  }));
  const last = loadLast();
  const resume = $('coverResume');
  const lastStory = last && stories.find((s) => s.id === last.id);
  resume.hidden = !lastStory || (last.idx === 0 && lastStory === stories[0]);
  if (lastStory) resume.textContent = `▶ 이어 읽기 · ${lastStory.title}`;
  resume.onclick = () => openBook(last.id, last.idx);
}
function showCover() {
  pause();
  closeShelf();
  renderCover();
  cover.classList.remove('opening');
  cover.hidden = false;
}
function openBook(id, at = 0) {
  ensureCtx();
  selectStory(id, -1, { anim: false });
  if (at > 0 && at < seq.length) {
    idx = at;
    showPage(pageOf[at]);
    el.progress.textContent = `${at + 1} / ${seq.length}`;
    cancelPending();
    warmup(at);
  }
  if (reduceMotion()) { cover.hidden = true; return; }
  cover.classList.add('opening');
  setTimeout(() => { cover.hidden = true; cover.classList.remove('opening'); }, 900);
}
$('coverOpen').onclick = () => {
  srcFilter = 'all';
  try { localStorage.setItem(FILTER_KEY, 'all'); } catch (_) { /* ignore */ }
  openBook(stories[0].id, 0);
};
$('homeTitle').onclick = showCover;
$('homeTitle').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showCover(); } };
// 엔진 상태를 표지에도 보여 줌
new MutationObserver(() => { $('coverEngine').textContent = el.engine.textContent; })
  .observe(el.engine, { childList: true, characterData: true, subtree: true });

/* ---------- 시작 ---------- */
selectStory((loadLast() || { id: stories[0].id }).id, -1, { anim: false });
showCover();
// 상태 문구: 받는 중 진행률은 조각마다 오므로 0.25초에 한 번만 화면에 반영(버벅임 방지)
let statusTimer = 0;
let statusMsg = '';
let lastStep = '';
function setStatus(msg) {
  statusMsg = msg;
  const step = msg.replace(/[\d.]+ ?\/? ?[\d.]* ?MB/g, '').trim();
  if (step !== lastStep) { lastStep = step; note('▶', [step]); }
  if (statusTimer) return;
  statusTimer = setTimeout(() => { statusTimer = 0; el.engine.textContent = statusMsg; }, 250);
}
tts.load(setStatus)
  .then(async () => {
    await tts.style(castOf(seq[0].who).voice);
    ready = true;
    clearTimeout(statusTimer); statusTimer = 0;
    el.engine.textContent = `준비 완료 (${tts.backend} · ${tts.source})`;
    note('▶', [`${el.engine.textContent}${tts.inWorker ? ' · 워커' : ' · 화면 스레드'}`]);
    // WebGPU가 없어 CPU(WASM)로 도는 기기는 합성이 느리므로 품질 기본값을 '빠르게'로
    if (tts.backend === 'WASM') el.steps.value = '5';
    renderCast();
    renderPlaylist();
    renderPlayState();
    if (!playing) el.hint.textContent = '재생을 누르거나, 듣고 싶은 문장을 눌러 주세요.';
    warmup(idx);
  })
  .catch((e) => {
    console.error(e);
    clearTimeout(statusTimer); statusTimer = 0;
    el.engine.textContent = /모델을 찾지 못했어요/.test(e.message)
      ? '음성 엔진을 불러오지 못했어요 (모델 파일을 받지 못함)'
      : `음성 엔진을 불러오지 못했어요: ${e.message}`;
    el.engine.title = e.message;
    el.engine.classList.add('has-detail');
  });
// 오류 문구를 누르면 자세한 원인을 보여 줌(휴대폰에서는 툴팁·콘솔을 볼 수 없으므로)
// 로딩 중이든 실패 후든 누르면: 지금 상태 + 단계별 기록 + 기기 정보
const showEngineDetail = () => {
  const mem = navigator.deviceMemory ? ` · 메모리 ${navigator.deviceMemory}GB` : '';
  alert(`${el.engine.textContent}\n\n${diag.slice(-25).join('\n')}\n\nWebGPU: ${'gpu' in navigator ? '있음' : '없음'}${mem}\n${navigator.userAgent}`);
};
el.engine.addEventListener('click', showEngineDetail);
$('coverEngine').addEventListener('click', showEngineDetail);
