# 현대엔지니어링 임원면접 PT — 디자인 시안 (초안)

2026년 하반기 신입사원 공개채용 임원면접 PT 3장을 가로형·세로형 두 안으로 만든 HTML 시안입니다.

| 파일 | 내용 |
|---|---|
| `landscape.html` | 가로형 16:9 (1920×1080) 3장 |
| `portrait.html` | 세로형 A4 비율 (1240×1754) 3장 |
| `pdf/` | 위 두 파일을 PDF로 저장한 결과 (제출 형식 확인용) |
| `preview/` | 장별 PNG 미리보기 |
| `pptx/landscape.pptx`, `pptx/portrait.pptx` | HTML과 같은 모양의 PowerPoint 파일 |
| `fonts-ttf/` | PowerPoint용 페이퍼로지 TTF (PPTX를 열기 전에 설치) |

두 HTML은 폰트까지 파일 안에 들어 있어서, 파일 하나만 있어도 Chrome에서 그대로 열립니다.

## PDF로 저장하기

Chrome에서 HTML을 열고 `인쇄` → 대상 `PDF로 저장` → 여백 `없음`, `배경 그래픽` 체크.
용지 크기는 파일에 지정되어 있어 3페이지로 나뉘어 저장됩니다.

## PowerPoint(PPTX)

1. `fonts-ttf/`의 TTF 7개를 먼저 설치합니다. PPTX는 굵기별 글꼴 이름(`Paperlogy 5 Medium`, `Paperlogy 7 Bold`, `Paperlogy 8 ExtraBold` 등)을 그대로 씁니다.
   설치하지 않으면 다른 글꼴로 바뀌어 모양이 달라집니다.
2. `pptx/landscape.pptx`(16:9) 또는 `pptx/portrait.pptx`(A4 세로)를 엽니다.

변환 방식 — Chrome이 그린 HTML에서 위치·크기·색·줄바꿈을 그대로 읽어 옮깁니다.
- **글자**: 화면의 한 줄이 텍스트 상자 하나입니다. 문구를 고칠 수 있고, 줄바꿈 위치는 HTML과 같습니다.
- **단색 상자·칩·점·카드·핵심 메시지 상자**: PowerPoint 도형이라 색과 크기를 바꿀 수 있습니다.
- **그라데이션 원, 곡선 연결선, 아이콘, 로고**: 도형으로 똑같이 만들 수 없어서 그 부분만 고해상도(3배) PNG로 넣었습니다.

다른 프로그램에서 열 때: LibreOffice는 한글과 영문·숫자 사이에 간격을 자동으로 넣어("3주" → "3 주") 글자가 조금 밀립니다.
PowerPoint 기준으로 맞춘 파일입니다.

PPTX 다시 만들기: `npm install` 후 `node tools/build.cjs && node tools/to-pptx.cjs landscape.html portrait.html`

## 디자인 기준

- **CI 전용색** (공식 CI 파일 `HEC영문CI.ai` 기준): Blue `#004B8D`, Green `#00A94F`, Yellow `#FDBB30`
- **2026 가치체계 그래픽**의 하늘색 → 파랑 그래디언트(`#45B9EC → #2A78DD`)를 '잇는 길'(연결선)에 사용
- **의미 색**: 사람·우리·협업 = Green / 기술 = Blue / 현장·성과 = Yellow
- **서체**: Paperlogy(페이퍼로지)
- **공통 모티프**: 얇은 그래디언트 테두리의 노드와 이를 잇는 선(가치체계 그래픽의 '여정' 형태) — 3장 공통 키워드 '연결'

## 로고

`logo.svg`(공식 국문 CI를 벡터로 잘라낸 것)가 빌드 때 각 장 오른쪽 위에 들어갑니다.
영문 로고로 바꾸려면 `ci/hec-logo-eng.svg`를 `logo.svg`로 복사한 뒤 `node tools/build.cjs`를 실행하세요.
`ci/`의 두 SVG는 공식 CI 파일(AI)에서 컬러 버전만 그대로 잘라낸 것으로, 형태와 색은 바꾸지 않았습니다.

## 수정과 빌드 (개발용)

- 원본: `src/base.css`(공통 디자인 시스템), `src/landscape.html`·`src/portrait.html`(머리글·바닥글 틀), `src/parts/*.html`(장별 본문)
- `node tools/build.cjs` — 폰트·스타일·로고를 넣은 단일 HTML을 `hec-pt/`에 생성
- `node tools/render.cjs landscape.html portrait.html` — `preview/` PNG와 `pdf/` PDF 생성 (Playwright 필요)
- `node tools/preview-part.cjs landscape 2` — 한 장만 미리보기

## 폰트 출처

`fonts/Paperlogy-*.woff2` — 페이퍼로지(Paperlogy), 눈누 웹폰트 배포본([projectnoonnu/2408-3](https://github.com/projectnoonnu/2408-3))에서 가져왔습니다. 사용 조건은 배포처의 라이선스 안내를 따릅니다.
