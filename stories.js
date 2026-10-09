// 이야기 전체(검사 도구·색인 만들기용). 앱은 이 파일을 쓰지 않고 stories/index.js(색인)만 먼저 받은 뒤,
// 이야기를 열 때 그 이야기가 든 파일만 받는다. 파일 목록은 stories/files.js.
import { KO_FILES, EN_FILES } from './stories/files.js';

const load = async (f) => (await import(`./stories/${f}`)).default;

export const STORIES = (await Promise.all(KO_FILES.map(async (f) => (await load(f)).map((s) => ({ ...s, _file: f }))))).flat();

// 영어 원고: 키 = 이야기 id. _file 은 색인용(열거되지 않게 붙임)
export const EN = Object.assign({}, ...(await Promise.all(EN_FILES.map(async (f) => {
  const set = await load(f);
  for (const v of Object.values(set)) Object.defineProperty(v, '_file', { value: f, enumerable: false });
  return set;
}))));
