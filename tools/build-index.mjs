// 이야기 색인 만들기: node tools/build-index.mjs  → stories/index.js
// 앱은 처음에 색인(목록에 필요한 정보)만 받고, 이야기를 열 때 그 파일만 받는다(이야기가 많아도 첫 화면이 가벼움).
// --check: 파일을 쓰지 않고, 색인이 최신인지 확인만 함(검사 도구에서 사용)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { STORIES, EN } = await import(pathToFileURL(path.join(root, 'stories.js')).href);

export function buildIndex() {
  const rows = STORIES.map((s) => {
    const r = { id: s.id, source: s.source, title: s.title, emoji: s.emoji, scene: s.scene, f: s._file };
    if (s.age) r.age = s.age;
    if (s.author) r.author = s.author;
    // 연재: '삼국지 3화', '촛불의 과학 2강' → 같은 모음의 같은 제목끼리 묶음(sr), 몇 번째인지(ep)
    const m = s.title.match(/^(.*\S)\s+(\d+)(화|강)$/);
    if (m) { r.sr = `${s.source}|${m[1]}`; r.ep = Number(m[2]); }
    // 길이 계산용: 읽는 글자 수(n)와 줄 수(l)
    const texts = [s.title, ...s.lines.map((l) => l[1]).filter(Boolean), ...(s.outro || [])];
    r.n = texts.reduce((a, t) => a + t.replace(/<[a-z]+>/g, '').length, 0);
    r.l = texts.length;
    const en = EN[s.id];
    if (en) {
      const et = [en.title, ...en.lines.map((l) => l[1]), ...(en.outro || [])];
      r.en = { title: en.title, f: en._file, w: et.join(' ').split(/\s+/).length, l: et.length };
    }
    return r;
  });
  return '// 자동 생성: node tools/build-index.mjs (손으로 고치지 말 것)\n'
    + `export const INDEX = ${JSON.stringify(rows)};\n`;
}

const out = path.join(root, 'stories', 'index.js');
const text = buildIndex();
if (process.argv.includes('--check')) {
  let cur = '';
  try { cur = readFileSync(out, 'utf8'); } catch (_) { /* 없음 */ }
  if (cur !== text) {
    console.log('stories/index.js 가 최신이 아님 → node tools/build-index.mjs');
    process.exit(1);
  }
  console.log('색인 최신');
} else {
  writeFileSync(out, text);
  console.log(`색인 ${STORIES.length}편 → stories/index.js (${(text.length / 1024).toFixed(0)} KB)`);
}
