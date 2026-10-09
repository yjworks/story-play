import { createTTS, VOICES } from './tts-client.js';
import { INDEX } from './stories/index.js';
const HAS_EN = INDEX.some((s) => s.en);
// 청소년 영어 원고가 하나라도 있으면 영문 모드에서도 어린이/청소년을 고를 수 있음
const HAS_TEEN_EN = INDEX.some((s) => s.en && s.age === 'teen');

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
const AGE_KEY = 'story-player:age'; // 'kid' | 'teen'
const LANG_KEY = 'story-player:lang'; // 'ko' | 'en' (영문 모드: 영어 학습용 원고가 있는 이야기만)
// 전체 빠르기: 인물마다 정한 빠르기에 곱함(아이가 따라오기 쉽게 조금 천천히)
const BASE_SPEED = 0.93;
// 영문 모드는 영어를 처음 배우는 아이용이라 한 번 더 천천히
const EN_SPEED = 0.9;
// 청소년 영어는 덜 천천히
const EN_SPEED_TEEN = 0.95;
// 목소리 나이: 음 높이(pitch)는 모델에 입력이 없어 재생 속도(playbackRate)로 올리고 내림.
// 합성 빠르기를 pitch 로 나눠 두므로 말 빠르기는 그대로이고 음 높이만 바뀜(울림도 함께 올라가 아이 목소리처럼 들림).
// ±12%를 넘으면 기계음이 나서 그 안에서만 씀. speed 는 인물 빠르기에 한 번 더 곱함.
const AGES = {
  child: { pitch: 1.10, speed: 1.05 },
  normal: { pitch: 1.0, speed: 1.0 },
  adult: { pitch: 0.96, speed: 0.97 },
  old: { pitch: 0.92, speed: 0.9 },
};
const AGE_LABEL = { child: '아이', normal: '보통', adult: '어른', old: '노인' };
const AGE_LABEL_EN = { child: 'Child', normal: 'Normal', adult: 'Adult', old: 'Elder' };
// 이야기 파일 cast 에 age 가 없으면 이름으로 짐작(해설은 늘 보통)
const CHILD_RE = /(아이(?!린)|꼬마|아기|소년|소녀|막내|손자|손녀|새끼|어린)/;
const OLD_RE = /(할머니|할아버지|할멈|영감|노인|노파|늙은)/;
function guessAge(name) {
  if (name === NARRATOR) return 'normal';
  return CHILD_RE.test(name) ? 'child' : OLD_RE.test(name) ? 'old' : 'normal';
}
const ageOf = (c) => AGES[c.age] || AGES.normal;
// 이야기 표지 색 (모음 순서대로)
const COVER_COLORS = ['#2f7d6d', '#4f7a2e', '#b5452f', '#3b5ca8', '#7a4a9e', '#b0306a', '#b8741a', '#2b6f8f', '#8a5a2b', '#5a6b2f'];
const LOOKAHEAD = 4; // 이야기를 고르면 첫 문장 + LOOKAHEAD 문장을 미리 합성. 위치를 옮겨도 이만큼은 버리지 않음
// 재생 중에는 이야기 끝까지 차례로 미리 합성함(합성이 음성보다 빠르므로 여유분이 계속 쌓임).
// 화면을 끄면 휴대폰이 계산을 거의 멈추는데(S24+ 확인), 그때까지 쌓아 둔 문장은 끝까지 들려줄 수 있음.
const NARRATION_PER_PARA = 3; // 해설 문장을 한 문단에 몇 개까지 이어 붙일지
const GAP_MS = 500; // 문장 사이 쉼
const THINK_MS = 7000; // 질문 뒤 아이가 생각할 시간
const STANZA_MS = 600; // 시에서 연이 바뀔 때 더 쉬는 시간
const PARA_MS = 300; // 원문 산문에서 문단이 바뀔 때 더 쉬는 시간
const NEXT_STORY_MS = 1500; // 반복·이어 듣기에서 다음 이야기 전 쉼
const DEFAULT_OUTRO = ['이야기 잘 들었나요?', '이야기에서 가장 기억에 남는 장면은 무엇인가요? 왜 그런가요?'];
const DEFAULT_OUTRO_EN = ['Did you like the story?', 'What part did you like best?'];

// 화면 글자. 영문 모드에서는 모두 영어로(index.html 의 data-i18n* 속성 + 아래 t()).
const UI = {
  ko: {
    shelf: '📚 이야기 목록', kids: '어린이', teens: '청소년', app: '이야기 극장', toCover: '처음 표지로', ai: '🤖 AI 목소리', aiTitle: 'AI 목소리 안내',
    langBtn: 'A English', langTitle: '영어로 바꾸기', coverLang: 'A 영어로 듣기',
    open: '📖 책 펼치기', close: '닫기', playlist: '재생목록', plPlay: '▶ 목록 재생', plClear: '비우기',
    plEmpty: '이야기 옆 ＋를 누르면 여기에 담겨요.', plAddShown: '아래 목록 모두 담기', choose: '이야기 고르기',
    voices: '목소리 바꾸기', pgPrev: '◀ 앞 쪽', pgNext: '다음 쪽 ▶', repeat: '반복', rOff: '반복 안 함', rOne: '한 편 반복',
    rList: '목록 반복', quality: '목소리 품질', qFast: '빠르게', qMid: '보통', qGood: '좋게',
    prevLine: '이전 문장', nextLine: '다음 문장', play: '재생', pause: '일시정지', all: '전체', count: (n) => `${n}편`,
    up: '위로', down: '아래로', remove: '빼기', addOnce: '재생목록에 담기', addAgain: '재생목록에 한 번 더 담기',
    clearAsk: '재생목록을 비울까요?', slow: '목소리를 만드는 중이에요…', again: '처음부터 다시 들려줄게요.',
    nextStory: '다음 이야기로 넘어갈게요.', end: '끝! 다시 들으려면 재생을 눌러 주세요.', pic: '그림', voiceOf: '목소리', ageOf: '나이',
    hear: '들어보기', think: '생각해 볼까요?', cover: '표지', page: (a, b) => `${a} / ${b} 쪽`,
    tapHint: '재생을 누르거나, 듣고 싶은 문장을 눌러 주세요.', readFirst: '목소리를 준비하는 동안 먼저 읽어 보세요.',
    coverSub: (n) => (age === 'teen' ? `청소년 읽을거리 ${n}편 · 근대 소설 원문과 세계 명작을 목소리로` : `이야기 ${n}편을 인물마다 다른 목소리로 들려줘요`), resume: (t) => `▶ 이어 읽기 · ${t}`,
    ready: (b, s) => `준비 완료 (${b} · ${s})`, synthFail: (m) => `음성을 만들지 못했어요: ${m}`,
    loadFail: '음성 엔진을 불러오지 못했어요 (모델 파일을 받지 못함)', loadFailMsg: (m) => `음성 엔진을 불러오지 못했어요: ${m}`,
    cast: '등장인물', pages: '쪽 넘기기', controls: '재생 조작', loading: '음성 엔진 불러오는 중',
    minutes: (m) => `약 ${m}분`, episodes: (n) => `${n}화`, epLabel: (n) => `${n}화`, addSeries: '연재 전체를 재생목록에 담기',
    search: '제목·작가로 찾기', nextEp: '다음 화로 넘어갈게요.',
    repeatTitle: '반복 안 함: 재생목록을 끝까지 한 번 · 한 편 반복: 지금 이야기만 계속 · 목록 반복: 재생목록을 처음부터 다시',
  },
  en: {
    shelf: '📚 Stories', kids: 'Kids', teens: 'Teens', app: 'Story Theater', toCover: 'Back to the cover', ai: '🤖 AI Voice', aiTitle: 'About the AI voice',
    langBtn: '가 한국어', langTitle: 'Switch to Korean', coverLang: '가 한국어로 듣기',
    open: '📖 Open the Book', close: 'Close', playlist: 'Playlist', plPlay: '▶ Play list', plClear: 'Clear',
    plEmpty: 'Tap ＋ next to a story to add it here.', plAddShown: 'Add all stories below', choose: 'Choose a story',
    voices: 'Change voices', pgPrev: '◀ Back', pgNext: 'Next ▶', repeat: 'Repeat', rOff: 'No repeat', rOne: 'Repeat one',
    rList: 'Repeat list', quality: 'Voice quality', qFast: 'Fast', qMid: 'Normal', qGood: 'Best',
    prevLine: 'Previous sentence', nextLine: 'Next sentence', play: 'Play', pause: 'Pause', all: 'All',
    count: (n) => `${n}`, up: 'up', down: 'down', remove: 'remove', addOnce: 'add to playlist', addAgain: 'add again',
    clearAsk: 'Clear the playlist?', slow: 'Making the voice…', again: 'Let’s hear it again!',
    nextStory: 'Next story!', end: 'The end! Press play to hear it again.', pic: 'picture', voiceOf: 'voice', ageOf: 'age',
    hear: 'Listen', think: 'Let’s think!', cover: 'Cover', page: (a, b) => `Page ${a} / ${b}`,
    tapHint: 'Press play, or tap a sentence to hear it.', readFirst: 'Read first while the voice gets ready.',
    coverSub: (n) => `${n} stories in English`, resume: (t) => `▶ Keep reading · ${t}`,
    ready: (b) => `Ready (${b})`, synthFail: (m) => `Could not make the voice: ${m}`,
    loadFail: 'Could not load the voice engine (model files)', loadFailMsg: (m) => `Could not load the voice engine: ${m}`,
    cast: 'Characters', pages: 'Turn pages', controls: 'Player controls', loading: 'Loading the voice engine…',
    minutes: (m) => `about ${m} min`, episodes: (n) => `${n} parts`, epLabel: (n) => `Part ${n}`, addSeries: 'add all parts to playlist',
    search: 'Search by title', nextEp: 'On to the next part!',
    repeatTitle: 'No repeat: play the list once · Repeat one: this story again and again · Repeat list: start the list again',
  },
};
// 모음 이름(영문 모드)
const SRC_EN = {
  탈무드: 'Talmud', 이솝우화: 'Aesop’s Fables', '한국 전래동화': 'Korean Tales', '영국 민담': 'English Tales',
  '그림 형제': 'Brothers Grimm', 안데르센: 'Andersen', 페로: 'Perrault', '세계 민담': 'World Tales', 고사성어: 'Chinese Fables',
  '명작 동화': 'Classic Tales', '명작 연재': 'Classic Series', '자연 관찰': 'Nature Notes', '우리 고전': 'Korean Classics',
  '신화와 역사': 'Myths & History', '세계 도시 탐방': 'World City Trips',
  '근대 소설': 'Korean Modern Fiction', '근대 수필': 'Korean Modern Essays', '고전 산문': 'Korean Classical Prose',
  '고전 수필': 'Korean Classical Essays', '수필·편지': 'Essays & Letters', '과학 고전': 'Science Classics',
  '인문 고전': 'Humanities Classics', '삼국사기·삼국유사': 'Tales of the Three Kingdoms of Korea', '삼국지': 'Romance of the Three Kingdoms',
  '초한지': 'The Chu–Han War', '조선왕조실록': 'Annals of the Joseon Dynasty', '세계 단편': 'World Short Stories',
  '세계 장편': 'World Novels', '셰익스피어': 'Shakespeare', '연설과 기록': 'Speeches & Records',
  '추리·괴기 명작': 'Mystery & Gothic Tales', '교양 강연': 'Talks',
};
const VOICE_LABEL_EN = {
  F1: 'Woman 1', F2: 'Woman 2', F3: 'Woman 3', F4: 'Woman 4', F5: 'Woman 5',
  M1: 'Man 1', M2: 'Man 2', M3: 'Man 3', M4: 'Man 4', M5: 'Man 5',
};

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
let lang = loadLang();
let age = loadAge();
let stories = storiesFor(lang);
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

/* ---------- 언어 (한국어 / 영문 학습 모드) ---------- */
function loadAge() {
  try { return localStorage.getItem(AGE_KEY) === 'teen' ? 'teen' : 'kid'; } catch (_) { return 'kid'; }
}
function loadLang() {
  if (!HAS_EN) return 'ko';
  try { return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'ko'; } catch (_) { return 'ko'; }
}
// 영문 모드: 영어 원고(stories/en/*.js)가 있는 이야기만, 제목·대사·질문을 영어로 바꿔 씀.
// 인물(cast)은 한국어 이야기와 같은 객체를 써서 목소리 바꾸기가 두 모드에 함께 반영됨.
// 독자: 'kid'(어린이, 기본) | 'teen'(청소년: age: 'teen' 인 이야기). 영문 모드는 청소년 영어 원고가 있을 때만 청소년을 고를 수 있음.
// 목록은 색인(stories/index.js: 제목·모음·그림·파일 위치)만으로 만들고, 본문은 열 때 loadStory()로 받음
function storiesFor(l, a = age) {
  if (l === 'en') {
    const teen = a === 'teen' && HAS_TEEN_EN;
    return INDEX.filter((s) => s.en && (s.age === 'teen') === teen)
      .map((s) => ({ ...s, title: s.en.title, koTitle: s.title, lang: 'en' }));
  }
  if (a === 'teen') return INDEX.filter((s) => s.age === 'teen');
  return [...INDEX.filter((s) => !s.age), ...loadUserStories()];
}
// 이야기 파일 받기(파일 단위로 한 번만). 영문 모드는 영어 원고 파일도 받아 합침.
// 인물(cast)은 한국어 이야기 객체의 것을 그대로 써서 목소리 바꾸기가 두 모드에 함께 반영됨
const fileCache = new Map();
function loadFile(f) {
  if (!fileCache.has(f)) {
    const p = import(`./stories/${f}`).then((m) => m.default);
    p.catch(() => fileCache.delete(f)); // 실패하면 다음에 다시 시도
    fileCache.set(f, p);
  }
  return fileCache.get(f);
}
async function loadStory(id) {
  const meta = stories.find((s) => s.id === id);
  if (!meta) return null;
  if (meta.user) return meta;
  const ko = (await loadFile(meta.f)).find((s) => s.id === id);
  if (!ko) throw new Error(`이야기를 찾지 못함: ${id}`);
  if (meta.lang !== 'en') return ko;
  const en = (await loadFile(meta.en.f))[id];
  return { ...ko, ...en, cast: ko.cast, lang: 'en', koTitle: ko.title };
}
// 재생목록·이어 읽기는 모드(언어·독자)마다 따로 저장
const keyOf = (k) => (lang === 'en' ? (age === 'teen' && HAS_TEEN_EN ? `${k}:en:teen` : `${k}:en`) : age === 'teen' ? `${k}:teen` : k);
const isEn = () => lang === 'en';
function t(k, ...args) {
  const v = UI[lang][k] ?? UI.ko[k];
  return typeof v === 'function' ? v(...args) : v;
}
// 영문 모드에서는 한글로 적힌 작가 이름을 숨김(영어 원고 본문에 작가가 영어로 소개됨)
const authorOf = (s) => (s.author && !(isEn() && /[가-힣]/.test(s.author)) ? s.author : '');
const srcLabel = (src) => (isEn() ? SRC_EN[src] || src : src);
// 정적 화면 글자: data-i18n(글자), data-i18n-aria(aria-label), data-i18n-title(title)
function applyUI() {
  for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of document.querySelectorAll('[data-i18n-aria]')) n.setAttribute('aria-label', t(n.dataset.i18nAria));
  for (const n of document.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle);
  for (const n of document.querySelectorAll('[data-i18n-ph]')) n.placeholder = t(n.dataset.i18nPh);
  for (const n of document.querySelectorAll('[data-lang]')) n.hidden = n.dataset.lang !== lang;
  document.title = t('app');
}
function nameOf(who) {
  return story?.names?.[who] || who;
}

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
    return JSON.parse(localStorage.getItem(keyOf(PLAYLIST_KEY)) || '[]').filter((id) => ids.has(id));
  } catch (_) { return []; }
}
function savePlaylist() {
  try { localStorage.setItem(keyOf(PLAYLIST_KEY), JSON.stringify(playlist)); } catch (_) { /* ignore */ }
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
  const c = story.cast[name];
  if (!AGES[c.age]) c.age = guessAge(name);
  return c;
}
function buildSeq() {
  // 맨 앞은 제목(표지에서 해설이 읽음), 이어서 본문, 끝에 마무리 질문
  const title = { who: NARRATOR, text: story.title, ask: false, q: false, title: true };
  // 시(poem): 빈 줄('')은 연 구분 → 읽지 않고, 다음 행에 stanza 표시(화면에서 띄우고 읽을 때 조금 더 쉼)
  const body = [];
  let stanza = false;
  for (const [who, text] of story.lines) {
    if (!text) { stanza = true; continue; }
    body.push({ who, text, ask: false, q: false, stanza });
    stanza = false;
  }
  const outro = (story.outro?.length ? story.outro : isEn() ? DEFAULT_OUTRO_EN : DEFAULT_OUTRO)
    .map((text, k) => ({ who: NARRATOR, text, ask: true, q: k > 0 }));
  return [title, ...body, ...outro];
}
function keyFor(i) {
  const { who, text } = seq[i];
  const c = castOf(who);
  return `${storyKey()}|${i}|${c.voice}|${c.speed}|${c.age}|${el.steps.value}|${text}`;
}
const storyKey = () => `${story.id}:${story.lang || 'ko'}`;

/* ---------- 합성 캐시 ---------- */
// 목소리·품질·이야기·위치가 바뀌면 필요 없어진 합성을 버려서(합성 중인 것도 중간에 멈춤), 바뀐 설정이 곧바로 반영되게 함.
// from 을 주면 from ~ from+LOOKAHEAD 문장은 버리지 않음(재생을 누를 때 미리 만들던 문장을 다시 만들지 않도록).
// 다 만든 소리는 그대로 둠.
function cancelPending(from = -1) {
  const keep = new Set();
  for (let k = 0; from >= 0 && k <= LOOKAHEAD && from + k < seq.length; k++) keep.add(keyFor(from + k));
  for (const [k, e] of audioCache) {
    if (!e.done && !keep.has(k)) { e.ctl.abort(); audioCache.delete(k); }
    // 다른 이야기의 다 만든 소리는 지움(이야기 한 편이 수십 MB라 쌓이면 휴대폰 메모리가 모자람)
    else if (e.done && story && !k.startsWith(`${storyKey()}|`)) audioCache.delete(k);
  }
}
// 이야기 언어와 빠르기(영문 모드는 조금 천천히). 재생 때 pitch 배로 빨라지므로 합성은 그만큼 천천히.
function speechOf(c) {
  const a = ageOf(c);
  const speed = c.speed * BASE_SPEED * a.speed / a.pitch;
  return story.lang === 'en' ? { lang: 'en', speed: speed * (story.age === 'teen' ? EN_SPEED_TEEN : EN_SPEED) } : { lang: 'ko', speed };
}
// 낭독용 표기: 검열로 지운 자리(××, ○○)는 옛 관례대로 '모모'로 읽고, 책 제목 괄호(「」『』《》〈〉)는 소리 내지 않음
const speakText = (t) => t.replace(/[×○]{2,}/g, '모모').replace(/[×○]/g, '모').replace(/[「」『』《》〈〉]/g, '');
function audioFor(i) {
  const k = keyFor(i);
  if (!audioCache.has(k)) {
    const { who, text } = seq[i];
    const c = castOf(who);
    const node = sents[i];
    node?.classList.add('busy');
    const entry = { started: false, ctl: new AbortController() };
    entry.p = tts.synth(speakText(text), {
      voice: c.voice, steps: Number(el.steps.value), ...speechOf(c),
      signal: entry.ctl.signal, onStart: () => { entry.started = true; },
    }).finally(() => node?.classList.remove('busy'));
    entry.p.then(() => { entry.done = true; }, () => {});
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
  // iPhone Safari: 무음 모드(옆 스위치)에서는 Web Audio 소리가 꺼짐 → 음악 앱처럼 '재생' 용도로 알려 무음 모드에서도 나오게.
  // audioSession 은 Safari 16.4+ 에만 있음(없으면 무시).
  try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch (_) { /* unsupported */ }
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // 소리가 안 날 때 원인을 보려고 오디오 상태를 진단 기록에 남김(iOS는 'interrupted' 상태가 있음)
    const logState = () => console.info(`[player] 오디오 ${audioCtx.state}, audioSession=${navigator.audioSession?.type || '없음'}`);
    audioCtx.onstatechange = logState;
    logState();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function stopAudio() {
  if (source) { source.onended = null; try { source.stop(); } catch (_) { /* ended */ } source = null; }
}
// tail: 소리 뒤에 붙일 쉼(ms). 타이머(setTimeout)로 기다리지 않고 소리 안에 무음으로 넣음 →
// 화면이 꺼져 타이머가 느려져도(백그라운드에서 최대 1초 단위) 쉼 길이가 그대로 유지됨
// rate: 목소리 나이의 음 높이(재생 속도). 쉼은 rate 배 길게 넣어 실제 쉼 길이가 같게 함.
function playPCM(pcm, tail = 0, rate = 1) {
  const ctx = ensureCtx();
  const pad = Math.floor((tail / 1000) * tts.sampleRate * rate);
  const buf = ctx.createBuffer(1, pcm.length + pad, tts.sampleRate);
  buf.copyToChannel(pcm, 0);
  return new Promise((resolve) => {
    source = ctx.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = rate;
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
  if (plPos < 0 || playlist[plPos] !== story.id) {
    // 재생목록 밖에서 연재를 듣는 중이면 다음 화로 이어 감
    const meta = stories.find((s) => s.id === story.id);
    const nx = meta?.sr && stories.find((s) => s.sr === meta.sr && s.ep === meta.ep + 1);
    return nx ? { id: nx.id, pos: -1, nextEp: true } : null;
  }
  if (plPos + 1 < playlist.length) return { id: playlist[plPos + 1], pos: plPos + 1 };
  if (mode === 'list' && playlist.length) return { id: playlist[0], pos: 0 };
  return null;
}
async function playFromList(pos) {
  if (!ready || !playlist[pos]) return;
  ensureCtx();
  closeShelf();
  if (await selectStory(playlist[pos], pos)) run(0);
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
    const tb = document.createElement('button');
    tb.className = 'pl-title';
    tb.textContent = title(id);
    tb.onclick = () => playFromList(pos);
    const mk = (label, aria, fn) => {
      const b = document.createElement('button');
      b.className = 'pl-btn'; b.textContent = label; b.setAttribute('aria-label', aria); b.onclick = fn;
      return b;
    };
    li.append(tb,
      mk('▲', `${title(id)} ${t('up')}`, () => moveInList(pos, -1)),
      mk('▼', `${title(id)} ${t('down')}`, () => moveInList(pos, 1)),
      mk('✕', `${title(id)} ${t('remove')}`, () => removeFromList(pos)));
    return li;
  }));
  el.plCount.textContent = playlist.length ? t('count', playlist.length) : '';
  el.plEmpty.hidden = playlist.length > 0;
  el.plPlay.disabled = !ready || !playlist.length;
}
el.plPlay.onclick = () => playFromList(0);
el.plClear.onclick = () => {
  if (!playlist.length || !confirm(t('clearAsk'))) return;
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

// 이야기 찾기: 입력하는 대로 목록을 거름(연재도 화 단위로 보여 줌)
$('storySearch').addEventListener('input', (e) => { query = e.target.value; renderStoryList(); });
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
  const tags = [['all', t('all'), stories.length], ...sources().map((src) => [src, srcLabel(src), stories.filter((s) => s.source === src).length])];
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
    for (let k = idx + 1; k < seq.length; k++) audioFor(k).catch(() => {});
    let pcm;
    // 합성이 오래 걸리면 멈춘 것처럼 보이지 않게 안내
    const slow = setTimeout(() => { if (my === runId) el.hint.textContent = t('slow'); }, 800);
    try {
      pcm = await cur;
      clearTimeout(slow);
      if (my === runId) el.hint.textContent = '';
    } catch (e) {
      clearTimeout(slow);
      if (my !== runId) return;
      console.error(e);
      el.engine.textContent = t('synthFail', e.message);
      break;
    }
    if (my !== runId) return;
    const waited = performance.now() - t0;
    if (waited > 50) console.info(`[player] ${idx + 1}번째 문장 대기 ${(waited / 1000).toFixed(2)}s (끊김)`);
    // 쉼: 질문 뒤 생각할 시간 / 시의 연이 바뀔 때는 조금 더
    await playPCM(pcm, seq[idx].q ? THINK_MS : GAP_MS + (seq[idx + 1]?.stanza ? (story.prose ? PARA_MS : STANZA_MS) : 0),
      ageOf(castOf(seq[idx].who)).pitch);
    if (my !== runId) return;
    idx += 1;
  }
  if (my !== runId) return;
  playing = false;
  if (idx >= seq.length) {
    const nx = nextStep();
    if (nx) {
      el.hint.textContent = nx.id === story.id ? t('again') : nx.nextEp ? t('nextEp') : t('nextStory');
      await wait(NEXT_STORY_MS);
      if (my !== runId) return;
      if (await selectStory(nx.id, nx.pos)) run(0);
      return;
    }
    idx = 0;
    highlight(-1);
    el.hint.textContent = t('end');
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
// 이야기 길이(분, 대략): 읽는 글자 수와 줄 사이 쉼, 마무리 질문 뒤 생각할 시간으로 어림
function minutesOf(s) {
  const e = s.lang === 'en' && s.en;
  const sec = e ? e.w / 2 + e.l * 0.4 : (s.n || 0) / 6.5 + (s.l || 0) * 0.4;
  return Math.max(1, Math.round((sec + 14) / 60));
}
// 연재 묶음 이름: 한국어는 '삼국지|삼국지' 의 뒤쪽, 영문 모드는 'Pinocchio, Part 1' 에서 번호를 뗌
function seriesTitle(first) {
  if (first.lang === 'en') return first.title.replace(/,?\s*(Part|Episode|Lecture|Chapter)\s*\d+$/i, '').trim();
  return first.sr.split('|')[1];
}
// 목록 항목: 검색어가 있으면 찾은 이야기를 낱낱이, 없으면 연재는 한 칸(펼치면 화 목록)으로 묶음
let query = '';
const openSeries = new Set();
function listItems() {
  const base = shownStories();
  const q = query.trim().toLowerCase();
  if (q) {
    return base.filter((s) => [s.title, s.koTitle, s.author, s.source, srcLabel(s.source)]
      .some((v) => v && v.toLowerCase().includes(q)));
  }
  const out = [];
  const seen = new Map();
  for (const s of base) {
    if (!s.sr) { out.push(s); continue; }
    let g = seen.get(s.sr);
    if (!g) { g = { group: true, sr: s.sr, eps: [] }; seen.set(s.sr, g); out.push(g); }
    g.eps.push(s);
  }
  // 한 화뿐인 묶음은 그냥 한 칸으로
  return out.map((x) => (x.group && x.eps.length === 1 ? x.eps[0] : x));
}
function storyRow(s, label) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.className = 'pick';
  b.setAttribute('aria-current', String(story?.id === s.id));
  const pic = document.createElement('span'); pic.className = 's-pic'; pic.setAttribute('aria-hidden', 'true');
  pic.textContent = s.emoji || '📖';
  const ttl = document.createElement('span'); ttl.className = 's-title'; ttl.textContent = label || s.title;
  const src = document.createElement('span'); src.className = 's-src';
  // 연재의 한 화(label 있음)는 모음·작가를 되풀이하지 않고 길이만
  src.textContent = label ? t('minutes', minutesOf(s)) : `${srcLabel(s.source)}${authorOf(s) ? ` · ${authorOf(s)}` : ''} · ${t('minutes', minutesOf(s))}`;
  b.append(pic, ttl, src);
  b.onclick = () => { selectStory(s.id); closeShelf(); };
  const add = document.createElement('button');
  add.className = 'add';
  const inList = playlist.includes(s.id);
  add.setAttribute('aria-pressed', String(inList));
  add.setAttribute('aria-label', `${s.title} ${t(inList ? 'addAgain' : 'addOnce')}`);
  add.textContent = inList ? '✓' : '＋';
  add.onclick = () => addToList(s.id);
  li.append(b, add);
  return li;
}
function seriesRow(g) {
  const first = g.eps[0];
  const li = document.createElement('li');
  li.className = 'series';
  const isOpen = openSeries.has(g.sr) || g.eps.some((e) => e.id === story?.id);
  const b = document.createElement('button');
  b.className = 'pick';
  b.setAttribute('aria-expanded', String(isOpen));
  b.setAttribute('aria-current', String(g.eps.some((e) => e.id === story?.id)));
  const pic = document.createElement('span'); pic.className = 's-pic'; pic.setAttribute('aria-hidden', 'true');
  pic.textContent = first.emoji || '📚';
  const ttl = document.createElement('span'); ttl.className = 's-title'; ttl.textContent = `${isOpen ? '▾' : '▸'} ${seriesTitle(first)}`;
  const total = g.eps.reduce((a, e) => a + minutesOf(e), 0);
  const src = document.createElement('span'); src.className = 's-src';
  src.textContent = `${srcLabel(first.source)}${authorOf(first) ? ` · ${authorOf(first)}` : ''} · ${t('episodes', g.eps.length)} · ${t('minutes', total)}`;
  b.append(pic, ttl, src);
  b.onclick = () => {
    if (openSeries.has(g.sr)) openSeries.delete(g.sr); else openSeries.add(g.sr);
    renderStoryList();
  };
  // 연재 전체를 재생목록에 담기(1화부터 차례로)
  const add = document.createElement('button');
  add.className = 'add';
  const allIn = g.eps.every((e) => playlist.includes(e.id));
  add.setAttribute('aria-pressed', String(allIn));
  add.setAttribute('aria-label', `${seriesTitle(first)} ${t('addSeries')}`);
  add.textContent = allIn ? '✓' : '＋';
  add.onclick = () => {
    g.eps.filter((e) => !playlist.includes(e.id)).forEach((e) => playlist.push(e.id));
    savePlaylist(); renderPlaylist(); renderStoryList();
  };
  li.append(b, add);
  if (isOpen) {
    const ul = document.createElement('ul');
    ul.className = 'eps';
    ul.append(...g.eps.map((e) => storyRow(e, e.lang === 'en' ? e.title : t('epLabel', e.ep))));
    li.append(ul);
  }
  return li;
}
function renderStoryList() {
  el.storyList.replaceChildren(...listItems().map((x) => (x.group ? seriesRow(x) : storyRow(x))));
}
// 삽화: story.image(그린 그림)가 있으면 그것을, 없으면 배경 + 그림 장면(scene)을 그림
function renderScene() {
  el.scene.setAttribute('aria-label', `${story.title} ${t('pic')}`);
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
    s.textContent = nameOf(name);
    return s;
  }));
}
function renderCast() {
  el.castList.replaceChildren(...Object.keys(story.cast).map((name) => {
    const c = castOf(name);
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.style.setProperty('--c', colorOf(name) || 'var(--ink-soft)');
    const n = document.createElement('strong'); n.textContent = nameOf(name);
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `${nameOf(name)} ${t('voiceOf')}`);
    for (const v of VOICES) {
      const o = document.createElement('option'); o.value = v; o.textContent = (isEn() ? VOICE_LABEL_EN : VOICE_LABEL)[v];
      if (v === c.voice) o.selected = true;
      sel.append(o);
    }
    // 목소리 나이(아이·보통·어른·노인)
    const ageSel = document.createElement('select');
    ageSel.setAttribute('aria-label', `${nameOf(name)} ${t('ageOf')}`);
    for (const a of Object.keys(AGES)) {
      const o = document.createElement('option'); o.value = a; o.textContent = (isEn() ? AGE_LABEL_EN : AGE_LABEL)[a];
      if (a === c.age) o.selected = true;
      ageSel.append(o);
    }
    const changed = () => {
      if (story.user) saveUserStories();
      if (playing) run(idx);
      else { cancelPending(); warmup(idx); }
    };
    sel.onchange = () => { c.voice = sel.value; changed(); };
    ageSel.onchange = () => { c.age = ageSel.value; changed(); };
    const hear = document.createElement('button');
    hear.textContent = t('hear');
    hear.disabled = !ready;
    hear.onclick = async () => {
      if (!ready) return;
      pause();
      ensureCtx();
      const line = story.lines.find(([w]) => w === name);
      const text = line ? line[1] : isEn() ? `Hello, I am ${nameOf(name)}.` : `안녕, 나는 ${name}이야.`;
      hear.disabled = true;
      try { await playPCM(await tts.synth(text, { voice: c.voice, steps: Number(el.steps.value), ...speechOf(c) }), 0, ageOf(c).pitch); }
      catch (e) { console.error(e); el.engine.textContent = `음성을 만들지 못했어요: ${e.message}`; }
      finally { hear.disabled = false; }
    };
    chip.append(n, sel, ageSel, hear);
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
  seq.forEach(({ who, text, ask, q, title, stanza }, i) => {
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
        h.textContent = t('think');
        askBox.append(h);
        units.push({ node: askBox, first: i, ask: true });
      }
      s.textContent = shown(text);
      askBox.append(s);
      return;
    }
    // 원문 산문: 원래 문단 그대로(빈 줄 = 문단 바꿈), 문장은 이어 씀. 대사도 해설 목소리로 원문대로.
    if (story.prose) {
      if (!para || stanza) {
        para = document.createElement('p');
        para.className = 'prose';
        units.push({ node: para, first: i, ask: false });
      } else {
        para.append(' ');
      }
      s.textContent = shown(text);
      para.append(s);
      return;
    }
    // 시: 한 연 = 한 문단, 행마다 줄바꿈. 표기는 원문 그대로.
    if (story.poem) {
      if (!para || stanza) {
        para = document.createElement('p');
        para.className = 'verse';
        units.push({ node: para, first: i, ask: false });
      } else {
        para.append(document.createElement('br'));
      }
      s.textContent = shown(text);
      para.append(s);
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
      s.title = nameOf(who);
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
    if (pg.offsetHeight > cap && pg.childElementCount > 1 && !u.node.classList.contains('prose')) {
      u.node.remove();
      newPage();
      pg.append(u.node);
    }
    // 원문 산문의 긴 문단: 쪽 끝에서 문장 단위로 잘라 다음 쪽에 이어 씀(빈칸 없이 채움)
    let node = u.node;
    while (node.classList.contains('prose') && pg.offsetHeight > cap) {
      const cont = node.cloneNode(false);
      cont.classList.add('cont');
      while (pg.offsetHeight > cap && node.childNodes.length) cont.prepend(node.lastChild);
      // 문장이 하나도 안 남았으면 문단을 통째로 다음 쪽으로
      if (!node.querySelector('.sent')) { while (cont.firstChild && !cont.firstChild.classList?.contains('sent')) cont.firstChild.remove(); cont.prepend(...node.childNodes); cont.classList.toggle('cont', node.classList.contains('cont')); node.remove(); }
      if (!cont.querySelector('.sent')) break;
      while (cont.firstChild && cont.firstChild.nodeType === 3) cont.firstChild.remove(); // 앞 공백
      newPage();
      pg.append(cont);
      node = cont;
      if (pg.childElementCount === 1 && pg.offsetHeight > cap && cont.querySelectorAll('.sent').length === 1) break;
    }
    u.page = pages.length - 1;
  });
  // 문장 → 쪽: 문장이 실제로 놓인 쪽(문단이 쪽을 넘어갈 수 있어서 문장마다 찾음). 제목은 표지(0쪽)
  sents.forEach((n, i) => {
    const pgEl = n.closest('.pg');
    pageOf[i] = pgEl ? pages.indexOf(pgEl) : 0;
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
  el.pgNum.textContent = curPage === 0 ? t('cover') : t('page', curPage, pages.length - 1);
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
  cancelPending(i);
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
  el.play.setAttribute('aria-label', playing ? t('pause') : t('play'));
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
// 이야기 열기: 본문 파일을 받은 뒤(처음 한 번만 네트워크) 화면을 바꿈. 빠르게 여러 번 눌러도 마지막 것만 반영
let selectTok = 0;
async function selectStory(id, pos = -1, { anim = true } = {}) {
  const tok = ++selectTok;
  let full;
  try {
    full = await loadStory(id);
  } catch (e) {
    console.error(e);
    el.hint.textContent = isEn() ? 'Could not open the story. Check the network.' : '이야기를 받지 못했어요. 인터넷 연결을 확인해 주세요.';
    return false;
  }
  if (tok !== selectTok || !full) return false;
  if (anim && story && story.id !== id) { flip('book', () => showStory(full, pos)); return true; }
  showStory(full, pos);
  return true;
}
function showStory(full, pos) {
  pause();
  cancelPending();
  story = full;
  plPos = pos;
  seq = buildSeq();
  idx = 0;
  el.storyTitle.textContent = story.title;
  el.storySource.textContent = authorOf(story) ? `${srcLabel(story.source)} · ${authorOf(story)}` : srcLabel(story.source);
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
  el.hint.textContent = ready ? t('tapHint') : t('readFirst');
  renderPlayState();
  saveLast();
  warmup(0);
}
function saveLast() {
  if (!story) return;
  try { localStorage.setItem(keyOf(LAST_KEY), JSON.stringify({ id: story.id, idx })); } catch (_) { /* ignore */ }
}
function loadLast() {
  try {
    const v = JSON.parse(localStorage.getItem(keyOf(LAST_KEY)) || 'null');
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
  $('coverSub').textContent = t('coverSub', stories.length);
  $('coverToc').replaceChildren(...sources().map((src) => {
    const b = document.createElement('button');
    b.append(srcLabel(src), Object.assign(document.createElement('span'), { textContent: stories.filter((s) => s.source === src).length }));
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
  if (lastStory) resume.textContent = t('resume', lastStory.title);
  resume.onclick = () => openBook(last.id, last.idx);
}
function showCover() {
  pause();
  closeShelf();
  renderCover();
  cover.classList.remove('opening');
  cover.hidden = false;
}
async function openBook(id, at = 0) {
  ensureCtx();
  // 본문을 받는 동안 표지를 그대로 두었다가 받은 뒤 펼침
  if (!(await selectStory(id, -1, { anim: false }))) return;
  if (at > 0 && at < seq.length) {
    idx = at;
    showPage(pageOf[at]);
    el.progress.textContent = `${at + 1} / ${seq.length}`;
    cancelPending(at);
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
// 한국어 ↔ 영문(학습용) 모드 바꾸기: 상단과 표지의 버튼
function renderLang() {
  document.documentElement.lang = lang;
  applyUI();
  $('langBtn').setAttribute('aria-pressed', String(isEn()));
  el.openEditor.hidden = isEn(); // 내 이야기는 한국어 모드에서만
  const hasEn = HAS_EN; // 영어 원고가 없으면 버튼을 숨김
  $('langBtn').hidden = !hasEn;
  $('coverLang').hidden = !hasEn;
  // 어린이/청소년 고르기: 청소년 영어 원고가 없으면 영문 모드에서는 숨김
  for (const box of document.querySelectorAll('.age-tabs')) {
    box.hidden = isEn() && !HAS_TEEN_EN;
    for (const b of box.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.age === age));
  }
}
function setLang(l) {
  if (l === lang) return;
  lang = l;
  try { localStorage.setItem(LANG_KEY, l); } catch (_) { /* ignore */ }
  switchShelf();
}
function setAge(a) {
  if (a === age) return;
  age = a;
  try { localStorage.setItem(AGE_KEY, a); } catch (_) { /* ignore */ }
  switchShelf();
}
// 언어·독자가 바뀌면 책장(이야기 목록)을 통째로 바꿈
function switchShelf() {
  pause();
  stories = storiesFor(lang);
  playlist = loadPlaylist();
  plPos = -1;
  renderLang();
  story = null;
  selectStory((loadLast() || { id: stories[0].id }).id, -1, { anim: false });
  renderCover();
  renderPlaylist();
  if (ready) el.engine.textContent = t('ready', tts.backend, tts.source);
}
$('langBtn').onclick = () => setLang(isEn() ? 'ko' : 'en');
$('coverLang').onclick = () => setLang(isEn() ? 'ko' : 'en');
for (const b of document.querySelectorAll('.age-tabs button')) b.onclick = () => setAge(b.dataset.age);
renderLang();
$('homeBtn').onclick = showCover;
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
// 음성 엔진이 보내는 진행 문구(한국어)를 영문 모드에서는 영어로
function enStatus(m) {
  const n = m.match(/\((\d)\/4/)?.[1];
  const size = m.match(/[\d.]+ \/ [\d.]+ MB|[\d.]+ MB/)?.[0] || '';
  if (/내려받는/.test(m)) return `Downloading the voice (${n}/4) ${size}`.trim();
  if (n) return `Getting the voice ready (${n}/4)`;
  return t('loading');
}
function setStatus(msg) {
  statusMsg = msg;
  const step = msg.replace(/[\d.]+ ?\/? ?[\d.]* ?MB/g, '').trim();
  if (step !== lastStep) { lastStep = step; note('▶', [step]); }
  if (statusTimer) return;
  statusTimer = setTimeout(() => { statusTimer = 0; el.engine.textContent = isEn() ? enStatus(statusMsg) : statusMsg; }, 250);
}
tts.load(setStatus)
  .then(async () => {
    if (story) await tts.style(castOf(seq[0].who).voice);
    ready = true;
    clearTimeout(statusTimer); statusTimer = 0;
    el.engine.textContent = t('ready', tts.backend, tts.source);
    note('▶', [`${el.engine.textContent}${tts.inWorker ? ' · 워커' : ' · 화면 스레드'}`]);
    // WebGPU가 없어 CPU(WASM)로 도는 기기는 합성이 느리므로 품질 기본값을 '빠르게'로
    if (tts.backend === 'WASM') el.steps.value = '5';
    if (story) renderCast();
    renderPlaylist();
    renderPlayState();
    if (!playing) el.hint.textContent = t('tapHint');
    warmup(idx);
  })
  .catch((e) => {
    console.error(e);
    clearTimeout(statusTimer); statusTimer = 0;
    el.engine.textContent = /모델을 찾지 못했어요/.test(e.message)
      ? t('loadFail')
      : t('loadFailMsg', e.message);
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
