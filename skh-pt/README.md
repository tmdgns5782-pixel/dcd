# SK하이닉스 석사 연구 PT — 3D BIM 자동 생성 연구

Utility 기술(건축, BIM/5D) 직무 면접용 석사 연구 발표 12장(16:9). 원본 초안(10장)과 의뢰인 구성안(5장 구조)을 바탕으로 새로 디자인했습니다.

| 파일 | 내용 |
|---|---|
| `deck.html` | 폰트·그림이 모두 들어간 HTML 시안 (Chrome에서 바로 열림) |
| `pptx/deck.pptx` | PowerPoint 파일. 글자는 줄마다 텍스트 상자, 카드·차트·아이콘·연결선은 전부 PowerPoint 도형(점 편집 가능). 연구 그림·로고만 그림 |
| `preview/` | 장별 PNG |
| `deck5.html`, `pptx/deck5.pptx`, `pdf/deck5.pdf` | **5장 압축판** (장당 한 쪽, 표지 없음) |
| `BRIEF.md`, `BRIEF5.md` | 원고·숫자 규칙·디자인 규칙 / 5장 압축 규칙 |
| `src/` | 원본(장별 `parts/s1~s12.html`, 공통 `base.css`, 틀 `deck.html`) |

- 글꼴: **Pretendard** (PPTX를 여는 PC에 Pretendard가 설치되어 있어야 같은 모양으로 보입니다)
- 다시 만들기: `npm install` 후 `node tools/build.cjs && node tools/render.cjs deck.html --png-only && node tools/to-pptx.cjs deck.html`
