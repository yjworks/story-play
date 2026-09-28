// 영문 모드 원고 검사: node tools/check-en.mjs [stories/en/파일.js ...]  (인자 없으면 stories/en/ 전체)
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { STORIES } from '../stories.js';

const ko = Object.fromEntries(STORIES.map((s) => [s.id, s]));
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
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
    if (!s.title || s.title.length > 32) E('title 없음 또는 32자 초과');
    if (s.outro?.length !== 3) E('outro 3줄');
    const n = s.lines?.length || 0;
    if (n < 18 || n > 24) E(`줄 수 ${n} (18~24)`);
    if (s.lines?.[0]?.[0] !== '해설') E('첫 줄은 해설');
    // 본문 문장은 12단어, 마무리 질문은 14단어까지
    const texts = [...(s.outro || []).map((t) => [t, 14]), ...(s.lines || []).map((l) => [l[1], 12])];
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
console.log(`영어 원고 ${count}편 / 한국어 ${STORIES.length}편`);
if (errs.length) { console.log(errs.join('\n')); process.exit(1); }
console.log('통과');
