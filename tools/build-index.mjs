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
    const en = EN[s.id];
    if (en) r.en = { title: en.title, f: en._file };
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
