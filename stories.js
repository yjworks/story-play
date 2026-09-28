// 이야기 모음. 모음마다 stories/<파일>.js 하나. 여기 순서대로 목록과 태그가 나옴.
// 각 파일의 형식은 stories/_format.md, 검사는 `node tools/check-stories.mjs`.
import talmud from './stories/talmud.js';
import aesop from './stories/aesop.js';
import korean from './stories/korean.js';
import english from './stories/english.js';
import grimm from './stories/grimm.js';
import andersen from './stories/andersen.js';
import perrault from './stories/perrault.js';
import world from './stories/world.js';
import gosa from './stories/gosa.js';

export const STORIES = [...talmud, ...aesop, ...korean, ...english, ...grimm, ...andersen, ...perrault, ...world, ...gosa];
