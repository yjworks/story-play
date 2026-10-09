// 영문 모드 원고 검사: node tools/check-en.mjs [stories/en/파일.js ...]  (인자 없으면 stories/en/ 전체)
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { STORIES } from '../stories.js';

// --ko 파일: 아직 stories/files.js 에 넣지 않은 새 한국어 파일도 기준으로 씀(예: --ko stories/aesop2.js)
const args = process.argv.slice(2);
const extraKo = [];
for (let i = args.indexOf('--ko'); i >= 0; i = args.indexOf('--ko')) { extraKo.push(args[i + 1]); args.splice(i, 2); }
const ko = Object.fromEntries(STORIES.map((s) => [s.id, s]));
for (const f of extraKo) for (const s of (await import(pathToFileURL(path.resolve(f)).href)).default) ko[s.id] = s;
const files = args.length
  ? args
  : readdirSync('stories/en').filter((f) => f.endsWith('.js')).map((f) => `stories/en/${f}`);
const seen = new Map();
const errs = [];
let count = 0;
for (const f of files) {
  const en = (await import(pathToFileURL(path.resolve(f)).href)).default;
  for (const [id, s] of Object.entries(en)) {
    const E = (m) => errs.push(`[${f} ${id}] ${m}`);
    count++;
    if (seen.has(id)) E(`중복 (${seen.get(id)})`); seen.set(id, f);
    const k = ko[id];
    if (!k) { E('한국어 이야기에 없는 id'); continue; }
    // 청소년(age: 'teen') 원고는 중학생 이상 수준: 줄 수·문장 길이를 넉넉하게
    const teen = k.age === 'teen';
    const R = teen ? { title: 40, min: 16, max: 34, line: 20, outro: 25 } : { title: 32, min: 18, max: 24, line: 12, outro: 14 };
    if (!s.title || s.title.length > R.title) E(`title 없음 또는 ${R.title}자 초과`);
    const on = s.outro?.length || 0;
    if (teen && k.prose ? on < 1 || on > 3 : on !== 3) E(`outro 줄 수 ${on}`);
    const n = s.lines?.length || 0;
    if (n < R.min || n > R.max) E(`줄 수 ${n} (${R.min}~${R.max})`);
    if (s.lines?.[0]?.[0] !== '해설') E('첫 줄은 해설');
    // 문장 길이(단어 수): 어린이 본문 12·질문 14, 청소년 본문 20·질문 25
    const texts = [...(s.outro || []).map((t) => [t, R.outro]), ...(s.lines || []).map((l) => [l[1], R.line])];
    for (const [t, max] of texts) {
      if (!/[.!?]$/.test(t)) E(`끝 문장부호: ${t}`);
      if (/["<>]/.test(t)) E(`쓸 수 없는 문자: ${t}`);
      if (/[가-힣]/.test(t)) E(`한글 섞임: ${t}`);
      for (const sen of t.split(/(?<=[.!?])\s+/)) if (sen.split(/\s+/).length > max) E(`${max}단어 초과: ${sen}`);
    }
    for (const [sp] of s.lines || []) {
      if (!(sp in k.cast)) E(`cast에 없는 인물: ${sp}`);
      if (!(sp in (s.names || {}))) E(`names에 없는 인물: ${sp}`);
    }
  }
}
console.log(`영어 원고 ${count}편 / 한국어 ${Object.keys(ko).length}편`);
if (errs.length) { console.log(errs.join('\n')); process.exit(1); }
console.log('통과');
