# 현대엔지니어링 임원면접 PT — 디자인 시안 (초안)

2026년 하반기 신입사원 공개채용 임원면접 PT 3장을 가로형·세로형 두 안으로 만든 HTML 시안입니다.

| 파일 | 내용 |
|---|---|
| `landscape.html` | 가로형 16:9 (1920×1080) 3장 |
| `portrait.html` | 세로형 A4 비율 (1240×1754) 3장 |
| `pdf/` | 위 두 파일을 PDF로 저장한 결과 (제출 형식 확인용) |
| `preview/` | 장별 PNG 미리보기 |

두 HTML은 폰트까지 파일 안에 들어 있어서, 파일 하나만 있어도 Chrome에서 그대로 열립니다.

## PDF로 저장하기

Chrome에서 HTML을 열고 `인쇄` → 대상 `PDF로 저장` → 여백 `없음`, `배경 그래픽` 체크.
용지 크기는 파일에 지정되어 있어 3페이지로 나뉘어 저장됩니다.

## 디자인 기준

- **CI 전용색**: 현대 Blue `#004098`(PMS 286C), 현대 Green `#009944`(PMS 3415C), 현대 Yellow `#FABE00`(PMS 130C)
- **2026 가치체계 그래픽**의 하늘색 → 파랑 그래디언트(`#45B9EC → #2A78DD`)를 '잇는 길'(연결선)에 사용
- **의미 색**: 사람·우리·협업 = Green / 기술 = Blue / 현장·성과 = Yellow
- **서체**: Paperlogy(페이퍼로지)
- **공통 모티프**: 얇은 그래디언트 테두리의 노드와 이를 잇는 선(가치체계 그래픽의 '여정' 형태) — 3장 공통 키워드 '연결'

## 공식 로고 넣기

`hec-pt/logo.svg` 또는 `hec-pt/logo.png`(투명 배경)를 넣고 `node tools/build.cjs`를 실행하면 각 장 오른쪽 위 점선 자리에 로고가 들어갑니다.

## 수정과 빌드 (개발용)

- 원본: `src/base.css`(공통 디자인 시스템), `src/landscape.html`·`src/portrait.html`(머리글·바닥글 틀), `src/parts/*.html`(장별 본문)
- `node tools/build.cjs` — 폰트·스타일·로고를 넣은 단일 HTML을 `hec-pt/`에 생성
- `node tools/render.cjs landscape.html portrait.html` — `preview/` PNG와 `pdf/` PDF 생성 (Playwright 필요)
- `node tools/preview-part.cjs landscape 2` — 한 장만 미리보기

## 폰트 출처

`fonts/Paperlogy-*.woff2` — 페이퍼로지(Paperlogy), 눈누 웹폰트 배포본([projectnoonnu/2408-3](https://github.com/projectnoonnu/2408-3))에서 가져왔습니다. 사용 조건은 배포처의 라이선스 안내를 따릅니다.
