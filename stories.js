// 이야기 모음. 모음마다 stories/<파일>.js 하나. 여기 순서대로 목록과 태그가 나옴.
// 각 파일의 형식은 stories/_format.md, 검사는 `node tools/check-stories.mjs`.
import talmud from './stories/talmud.js';
import aesop from './stories/aesop.js';

export const STORIES = [...talmud, ...aesop];
