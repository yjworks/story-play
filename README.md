# 이야기 극장 (Supertonic 3 브라우저 TTS)

설치·서버 없이 브라우저에서 등장인물별 목소리로 동화를 읽어 주는 정적 웹앱입니다.
대상은 초등 저학년 이하이고, 이솝우화 15편과 탈무드 5편, 모두 20편이 들어 있습니다.

## 실행
```bash
python3 -m http.server 8000   # 이 폴더에서
# http://localhost:8000 접속
```
ES module과 fetch를 쓰므로 file://로 열면 동작하지 않습니다. GitHub Pages에는 파일을 그대로 올리면 됩니다.

## 모델
- 기본: Hugging Face `supertone-oss-archive/supertonic-3`의 고정 리비전(`aafc6e32416a594460b32413efc49d7fe4ce6d46`)에서 받아 Cache Storage(`supertonic3-aafc6e3`)에 저장합니다.
  두 번째 방문부터는 네트워크 없이 불러옵니다.
- 자체 호스팅: 아래처럼 받아 `assets/`에 두면 HF 대신 로컬 파일을 자동으로 씁니다.
  ```bash
  hf download supertone-oss-archive/supertonic-3 --revision aafc6e32416a594460b32413efc49d7fe4ce6d46 --local-dir assets
  ```
  GitHub Pages는 파일당 100MB 제한이 있으니 먼저 `ls -l assets/onnx/*.onnx`로 크기를 확인하세요.
- 런타임: onnxruntime-web 1.22.0 고정. `dist/ort.webgpu.min.mjs`와 WASM 파일이 npm 1.22.0 패키지에 있는 것은 확인했습니다.
- 라이선스: 모델은 OpenRAIL-M, 샘플 코드는 MIT입니다.

## 파일
| 파일 | 역할 |
| --- | --- |
| `tts.js` | Supertonic 추론. WebGPU를 먼저 쓰고, 실패하면 WASM으로 넘어갑니다. 콘솔에 로딩 시간과 줄별 합성 시간(RTF)을 `[tts]`로 출력합니다 |
| `stories.js` | 이야기 20편. 등장인물 → 목소리(F1~F5, M1~M5)·속도, 목록용 이모지 |
| `app.js` | 플레이어. 이야기를 고르면 첫 3줄을 미리 합성하고, 재생 중에는 다음 2줄을 미리 합성합니다. 목소리나 품질을 바꾸면 시작 전인 미리 합성은 버립니다. 대사 사이에 끊기면 `[player] … 대기`를 출력합니다 |
| `index.html`, `style.css` | 화면. 한국어 줄바꿈은 `word-break: keep-all`로 어절 단위로 끊습니다 |

화면의 "내 이야기 넣기"에서 `이름: 대사` 형식으로 붙여 넣으면 목소리를 자동으로 배정하고 localStorage에 저장합니다.

## 이야기 목록
- 이솝우화(15): 여우와 두루미, 해님과 바람, 토끼와 거북이, 사자와 생쥐, 개미와 베짱이, 양치기 소년, 욕심 많은 개, 시골 쥐와 도시 쥐, 금도끼 은도끼, 여우와 신 포도, 목마른 까마귀, 황금알을 낳는 거위, 고양이 목에 방울 달기, 여우와 까마귀, 나뭇가지 한 묶음
- 탈무드(5): 세 친구, 세 형제와 마법 사과, 여우와 포도밭, 나무 심는 할아버지, 가장 좋은 것, 가장 나쁜 것

모두 자체 각색본입니다. 원전의 주요 흐름은 유지하고, 한 편에 26~31줄로 짧은 문장, 소리 흉내 말, 되풀이를 넣었습니다.
「금도끼 은도끼」는 이솝의 「헤르메스와 나무꾼」을 한국식으로 옮긴 것이고, 「세 친구」의 죽음 비유는 저학년 눈높이에 맞게 "멀리 떠나는 길"로 순화했습니다.

## 검증 상태 (2026-09-28 기준)

### 확인한 것
- `node --check`로 JS 문법 검사를 통과했습니다.
- `tts.js`의 텐서 shape와 dtype, 입출력 이름을 공식 `web/helper.js`와 한 줄씩 대조했고 모두 같습니다.
  - `text_ids` int64 `[1,L]`, `text_mask` f32 `[1,1,L]`, `noisy_latent` f32 `[1, latent_dim*ccf, T]`, `latent_mask` f32 `[1,1,T]`, `current_step`/`total_step` f32 `[1]`, `T = ceil(floor(dur*sr) / (base_chunk_size*ccf))`
  - 차이 1: 공식 코드는 UTF-16 코드 유닛 단위로 인덱싱하고, 이 코드는 코드 포인트 단위로 합니다. 한글은 NFKD 후 모두 BMP 자모라 결과가 같습니다.
  - 차이 2: 공식 코드는 vocoder 출력 전체를 돌려주고, 이 코드는 `floor(duration*sr)` 길이로 자릅니다. 끝의 무음 패딩만 잘립니다.
  - 공식 전처리에 있던 `@ → at` 등 치환 3개를 추가해 전처리를 공식과 같게 맞췄습니다.
- 헤드리스 Chromium에서 20편 목록, 대본, 등장인물 칩이 오류 없이 그려지는 것을 확인했습니다. 음성 엔진은 아래 이유로 불러오지 못했습니다.

### 아직 확인하지 못한 것
작성 환경에서 huggingface.co와 cdn.jsdelivr.net 접속이 차단(프록시 403)되어, 실제 모델을 한 번도 돌려 보지 못했습니다.

| # | 항목 | 상태 | 확인 방법 |
| --- | --- | --- | --- |
| 1 | 실제 음성 합성 | 미확인 | PC Chrome에서 실행하고 콘솔의 `[tts] … 합성` 로그를 봅니다 |
| 2 | Tab S8 Chrome WebGPU | 미확인 | 상단의 `준비 완료 (WebGPU/WASM)` 문구와 콘솔 `[tts] 로딩 … backend=` |
| 3 | 모델 용량과 첫 로딩 시간 | 미확인 | 로딩 문구의 MB 표시, 콘솔 `[tts] 로딩 N s` |
| 4 | 한국어 표현 태그 효과 | 미확인 | 「토끼와 거북이」 15번째 줄(`<breath>`), 「여우와 두루미」 13번째 줄(`<laugh>`)을 들어 봅니다. 글자로 읽으면 `stories.js`에서 태그를 지웁니다 |
| 5 | 나머지 태그 7종 이름 | 미확인 | 공식 README에는 `laugh`, `breath`, `sigh`만 나옵니다 |
| 6 | OpenRAIL-M 사용 제한과 교육 사업 배포 | 미확인 | HF 모델 페이지의 LICENSE 원문을 법무 검토해야 합니다 |

### Tab S8 측정 기록 (채워 넣을 것)
| 항목 | 값 |
| --- | --- |
| backend | |
| 첫 로딩(다운로드 포함) | |
| 두 번째 방문 로딩(캐시 적중) | |
| 줄당 합성 시간 steps 5 / 8 / 12 | / / |
| 대사 사이 끊김 여부 | |

`chrome://inspect`로 원격 디버깅하고 콘솔에서 `[tts]`, `[player]`로 필터하면 위 값을 한 번에 볼 수 있습니다.
끊김이 잦으면 `app.js`의 `LOOKAHEAD`를 3~4로 올리거나 품질을 "빠르게"(steps 5)로 낮춥니다.
