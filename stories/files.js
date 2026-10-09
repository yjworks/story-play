// 이야기 파일 목록(이 순서대로 목록과 태그가 나옴). 새 파일을 만들면 여기에 넣고
// `node tools/build-index.mjs` 로 색인(stories/index.js)을 다시 만든다. 형식은 stories/_format.md.
export const KO_FILES = [
  // 어린이
  'talmud.js', 'aesop.js', 'korean.js', 'english.js', 'grimm.js', 'andersen.js', 'perrault.js', 'world.js', 'gosa.js',
  'classics.js', 'serial-a.js', 'serial-b.js', 'gojeon.js', 'history.js', 'nature.js', 'yun.js',
  // 청소년(age: 'teen')
  'teen-modern.js', 'teen-modern2.js', 'teen-a.js', 'teen-b.js', 'teen-c.js', 'teen-d.js', 'teen-e.js', 'teen-f.js', 'teen-g.js', 'teen-h.js', 'teen-yusa.js',
  'teen-sg1.js', 'teen-sg2.js', 'teen-ch.js', 'teen-sagi.js', 'teen-sillok1.js', 'teen-sillok2.js', 'teen-essay-modern.js', 'teen-essay.js', 'teen-speech.js',
];

// 영어 원고(영문 모드). 키 = 이야기 id.
export const EN_FILES = [
  'en/set1.js', 'en/set2.js', 'en/set3.js', 'en/set4.js', 'en/set5.js', 'en/set6.js', 'en/set7.js',
  'en/set8.js', 'en/set9.js', 'en/set10.js', 'en/set11.js', 'en/set12.js',
];
