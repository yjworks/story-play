// 이야기 데이터 검사: node tools/check-stories.mjs [파일...]  (인자 없으면 stories.js 전체)
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'];
const BGS = ['forest', 'field', 'sky', 'river', 'house', 'village', 'palace', 'night'];
const files = process.argv.slice(2);
let list = [];
if (files.length) {
  for (const f of files) list.push(...(await import(pathToFileURL(path.resolve(f)).href)).default.map((s) => ({ ...s, _file: f })));
} else {
  list = (await import(pathToFileURL(path.resolve('stories.js')).href)).STORIES;
}
const errs = [];
const warn = [];
const ids = new Set();
for (const s of list) {
  const at = `[${s.id || '?'}]`;
  const E = (m) => errs.push(`${at} ${m}`);
  const W = (m) => warn.push(`${at} ${m}`);
  if (!/^[a-z0-9-]+$/.test(s.id || '')) E('id 형식');
  if (ids.has(s.id)) E('id 중복'); ids.add(s.id);
  for (const k of ['source', 'emoji', 'title']) if (!s[k]) E(`${k} 없음`);
  if ([...(s.title || '')].length > 12) E(`title 12자 초과: ${s.title}`);
  if (!s.scene || !BGS.includes(s.scene.bg)) E(`scene.bg 잘못됨: ${s.scene?.bg}`);
  if (!Array.isArray(s.scene?.items) || s.scene.items.length < 2 || s.scene.items.length > 4) E('scene.items 2~4개');
  if (!Array.isArray(s.outro) || (s.outro.length !== 3 && !s.prose)) E('outro 3줄'); // 연재 원문의 중간 화는 1줄
  const cast = s.cast || {};
  if (!cast['해설']) E('해설 없음');
  const vs = Object.values(cast).map((c) => c.voice);
  if (new Set(vs).size !== vs.length) E(`목소리 중복: ${vs.join(',')}`);
  for (const [n, c] of Object.entries(cast)) {
    if (!VOICES.includes(c.voice)) E(`${n} voice 잘못됨`);
    if (!(c.speed >= 0.85 && c.speed <= 1.25)) E(`${n} speed 범위`);
    if (/\s/.test(n) || [...n].length > 6) E(`인물 이름: ${n}`);
  }
  const lines = s.lines || [];
  // 시(poem: true): 원문 그대로라 줄 수·문장부호·길이 규칙은 적용하지 않음. 빈 줄('')은 연 구분.
  if (s.poem || s.prose) {
    if (lines.filter((l) => l[1]).length < 4) E('행·문장이 너무 적음');
    if (!lines[0]?.[1] || !lines.at(-1)?.[1]) E('처음·끝에 빈 줄');
    if (!(s.outro || []).length) E('outro 없음');
    for (const q of s.outro || []) if (!/[.!?]$/.test(q)) E(`outro 끝 문장부호: ${q}`);
    continue;
  }
  if (lines.length < 24 || lines.length > 32) E(`줄 수 ${lines.length} (24~32)`);
  const who = new Set(lines.map((l) => l[0]));
  for (const w of who) if (!cast[w]) E(`cast에 없는 인물: ${w}`);
  for (const n of Object.keys(cast)) if (!who.has(n)) W(`대사 없는 인물: ${n}`);
  let tags = 0;
  lines.forEach(([w, t], i) => {
    if (typeof t !== 'string' || !t.trim()) E(`${i + 1}줄 비어 있음`);
    const plain = t.replace(/<[a-z]+>\s*/g, '');
    if ([...plain].length > 70) W(`${i + 1}줄 ${[...plain].length}자`);
    if (!/[.!?…]["'”]?$/.test(plain.trim())) E(`${i + 1}줄 끝 문장부호: ${plain.slice(-8)}`);
    const tg = t.match(/<[^>]+>/g) || [];
    for (const g of tg) if (!['<laugh>', '<sigh>', '<breath>'].includes(g)) E(`${i + 1}줄 알 수 없는 태그 ${g}`);
    if (tg.length && !t.startsWith(tg[0])) E(`${i + 1}줄 태그는 맨 앞에만`);
    tags += tg.length;
    if (/["“”]/.test(t)) W(`${i + 1}줄 따옴표`);
  });
  if (tags > 3) E(`표현 태그 ${tags}개 (최대 3)`);
  for (const q of s.outro || []) if (!/[.!?]$/.test(q)) E(`outro 끝 문장부호: ${q}`);
}
// 디즈니판·영화판에만 있는 이름(원작에 없음) — 쓰면 안 됨
const BANNED = ['에리얼', '엘사', '올라프', '지미니', '플린 라이더', '우르술라', '플라운더', '루이 왕', 'Ariel', 'Elsa', 'Olaf', 'Jiminy', 'Ursula', 'Flounder'];
for (const s of list) {
  const text = [s.title, ...(s.lines || []).map((l) => l[1]), ...(s.outro || []), ...Object.keys(s.cast || {})].join(' ');
  for (const w of BANNED) if (text.includes(w)) errs.push(`[${s.id}] 쓰면 안 되는 이름(디즈니·영화판): ${w}`);
}
// 같은 독자층(어린이/청소년) 안에서 제목이 같은 이야기 → 중복 의심
const seenTitle = new Map();
for (const s of list) {
  const k = `${s.age || 'kid'}|${s.title.replace(/\s+/g, '')}`;
  if (seenTitle.has(k)) warn.push(`[${s.id}] 제목이 [${seenTitle.get(k)}]와 같음 — 중복인지 확인`);
  else seenTitle.set(k, s.id);
}
const bySrc = {};
for (const s of list) bySrc[s.source] = (bySrc[s.source] || 0) + 1;
console.log(`이야기 ${list.length}편`, bySrc);
if (warn.length) console.log(`경고 ${warn.length}\n  ` + warn.join('\n  '));
// 전체 검사일 때: 앱이 쓰는 색인(stories/index.js)이 최신인지도 확인
if (!files.length) {
  const { execFileSync } = await import('node:child_process');
  try { execFileSync(process.execPath, [path.resolve('tools/build-index.mjs'), '--check'], { stdio: 'pipe' }); }
  catch (_) { errs.push('stories/index.js 가 최신이 아님 → node tools/build-index.mjs'); }
}
if (errs.length) { console.log(`오류 ${errs.length}\n  ` + errs.join('\n  ')); process.exit(1); }
console.log('통과');
