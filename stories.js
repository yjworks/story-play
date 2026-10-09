// 이야기 모음. 모음마다 stories/<파일>.js 하나. 여기 순서대로 목록과 태그가 나옴.
// 각 파일의 형식은 stories/_format.md, 검사는 `node tools/check-stories.mjs`, 영어 원고는 `node tools/check-en.mjs`.
import talmud from './stories/talmud.js';
import aesop from './stories/aesop.js';
import korean from './stories/korean.js';
import english from './stories/english.js';
import grimm from './stories/grimm.js';
import andersen from './stories/andersen.js';
import perrault from './stories/perrault.js';
import world from './stories/world.js';
import gosa from './stories/gosa.js';
import classics from './stories/classics.js';
import serialA from './stories/serial-a.js';
import serialB from './stories/serial-b.js';
import gojeon from './stories/gojeon.js';
import history from './stories/history.js';
import nature from './stories/nature.js';
import yun from './stories/yun.js';
import teenModern from './stories/teen-modern.js';
import teenA from './stories/teen-a.js';
import teenB from './stories/teen-b.js';
import enSet1 from './stories/en/set1.js';
import enSet2 from './stories/en/set2.js';
import enSet3 from './stories/en/set3.js';
import enSet4 from './stories/en/set4.js';
import enSet5 from './stories/en/set5.js';
import enSet6 from './stories/en/set6.js';
import enSet7 from './stories/en/set7.js';
import enSet8 from './stories/en/set8.js';
import enSet9 from './stories/en/set9.js';
import enSet10 from './stories/en/set10.js';
import enSet11 from './stories/en/set11.js';
import enSet12 from './stories/en/set12.js';

export const STORIES = [
  ...talmud, ...aesop, ...korean, ...english, ...grimm, ...andersen, ...perrault, ...world, ...gosa,
  ...classics, ...serialA, ...serialB, ...gojeon, ...history, ...nature, ...yun,
  // 청소년(age: 'teen')
  ...teenModern, ...teenA, ...teenB,
];

// 영어 원고(영문 모드). 키 = 이야기 id. 형식은 stories/en/*.js 참고.
export const EN = {
  ...enSet1, ...enSet2, ...enSet3, ...enSet4, ...enSet5, ...enSet6, ...enSet7,
  ...enSet8, ...enSet9, ...enSet10, ...enSet11, ...enSet12,
};
