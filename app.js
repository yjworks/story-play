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
const PLAYLIST_KEY = 'story-player:playlist';
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
  storySource: $('storySource'), legend: $('castLegend'), book: $('book'), hint: $('hint'), page: $('page'),
  pgPrev: $('pgPrev'), pgNext: $('pgNext'), pgNum: $('pgNum'), voices: $('voices'), pager: document.querySelector('.pager'),
  shelf: $('shelf'), openShelf: $('openShelf'), closeShelf: $('closeShelf'), backdrop: $('shelfBackdrop'),
  castList: $('castList'), repeat: $('repeat'),
  playlist: $('playlist'), plCount: $('plCount'), plEmpty: $('plEmpty'), plPlay: $('plPlay'), plClear: $('plClear'),
  play: $('playBtn'), prev: $('prevBtn'), next: $('nextBtn'), steps: $('steps'), progress: $('progress'),
  editor: $('editor'), openEditor: $('openEditor'), edTitle: $('edTitle'), edBody: $('edBody'),
};

const tts = new SupertonicTTS();
let ready = false;
let stories = [...STORIES, ...loadUserStories()];
let story = null;
let playlist = loadPlaylist(); // 재생목록: 이야기 id 배열 (같은 이야기를 여러 번 담아도 됨)
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
let prefetchCtl = new AbortController();

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
document.querySelectorAll('.plist-add [data-src]').forEach((b) => {
  b.onclick = () => {
    stories.filter((s) => s.source === b.dataset.src && !playlist.includes(s.id)).forEach((s) => playlist.push(s.id));
    savePlaylist();
    renderPlaylist();
    renderStoryList();
  };
});

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
  else { idx = i; highlight(i); cancelPending(); warmup(i); }
}

/* ---------- 렌더링 ---------- */
function renderStoryList() {
  el.storyList.replaceChildren(...stories.map((s) => {
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
  seq.forEach(({ who, text, ask, q }, i) => {
    castOf(who);
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
    const top = el.book.getBoundingClientRect().top;
    cap = Math.max(200, window.innerHeight - top - transportH - tailH);
  };
  newPage();
  units.forEach((u) => {
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
  el.pgNum.textContent = `${curPage + 1} / ${pages.length} 쪽`;
  el.pgPrev.disabled = curPage === 0;
  el.pgNext.disabled = curPage === pages.length - 1;
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
  showPage(n);
  el.progress.textContent = `${i + 1} / ${seq.length}`;
  cancelPending();
  warmup(i);
}
el.pgPrev.onclick = () => turnPage(-1);
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
  if (pageOf[i] !== curPage) showPage(pageOf[i]);
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
document.addEventListener('visibilitychange', syncWakeLock);
function selectStory(id, pos = -1) {
  pause();
  cancelPending();
  story = stories.find((s) => s.id === id);
  plPos = pos;
  seq = buildSeq();
  idx = 0;
  el.storyTitle.textContent = story.title;
  el.storySource.textContent = story.source;
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
  if (e.code === 'Escape') closeShelf();
  if (e.target.closest('input, textarea, select, dialog, summary')) return;
  if (e.code === 'Space') { e.preventDefault(); el.play.click(); }
  if (e.code === 'ArrowLeft') el.prev.click();
  if (e.code === 'ArrowRight') el.next.click();
  if (e.code === 'PageUp') turnPage(-1);
  if (e.code === 'PageDown') turnPage(1);
});

/* ---------- 시작 ---------- */
selectStory(stories[0].id);
tts.load((msg) => { el.engine.textContent = msg; })
  .then(async () => {
    await tts.style(castOf(seq[0].who).voice);
    ready = true;
    el.engine.textContent = `준비 완료 (${tts.backend} · ${tts.source})`;
    renderCast();
    renderPlaylist();
    renderPlayState();
    if (!playing) el.hint.textContent = '재생을 누르거나, 듣고 싶은 문장을 눌러 주세요.';
    warmup(idx);
  })
  .catch((e) => {
    console.error(e);
    el.engine.textContent = /모델을 찾지 못했어요/.test(e.message)
      ? '음성 엔진을 불러오지 못했어요 (모델 파일을 받지 못함)'
      : `음성 엔진을 불러오지 못했어요: ${e.message}`;
    el.engine.title = e.message;
  });
