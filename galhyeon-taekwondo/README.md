# 갈현이룸태권도 상담 PPT (9장)

- `index.html` — 9장 초안 (1600×900, 16:9). **파일 하나로 완결**(폰트 내장)이라 어디서 열어도 같은 모양. "PDF로 저장" 버튼으로 PDF 출력.
- `GPT_이미지_프롬프트.md` — GPT 이미지 요청서 (마스터 → 캐릭터 시트 → 캐릭터 13장 필수 / 나머지 선택).
- `assets/` — GPT 이미지 35개 (캐릭터·버스·로고·문구·아이콘·장식). 빌드할 때 투명 여백을 잘라 `index.html`에 내장.
- `reference/` — GPT 원본 시트(캐릭터 시트, 아이콘 시트)와 글자 없는 버스(`C12_bus_blank.png`, 실제 사용).
- `fonts/` — 사용 폰트 원본 (PPT 작업 PC에 설치용).
- `build/` — 초안 원본(`deck.src.html`)과 빌드 스크립트. 수정 후 `python3 build/build.py` → `index.html` 다시 생성.

## 폰트 (샘플 부분 이미지와 후보 폰트를 나란히 렌더링해 비교 후 선정)

| 용도 | 폰트 | 비고 |
|---|---|---|
| 슬라이드 제목, 번호 배지, 카드 제목, 금액 | 레코체 (Recipekorea) | 샘플 제목의 굵기, ㅎ·ㅊ 모양, 좁은 숫자가 가장 비슷 |
| 표지 손글씨 문구 | 온글잎 석영체 | 두꺼운 마커 손글씨 |
| 본문, 설명, 시간표 | Pretendard | |
| 영문 "GALHYEON IRUM TAEKWONDO" | Montserrat ExtraBold | 자간 넓게 |

PPT 납품 시: 의뢰인 PC에 폰트가 없으면 깨지므로 **파일 › 옵션 › 저장 › "파일의 글꼴 포함"**을 켜고 저장.

## 이미지 배치

- GPT 이미지 사용: 캐릭터 13장, 버스(글자 없는 버전 + 간판 글자는 텍스트), 로고 A02, 마무리 문구 A03, 아이콘 I01~I12, 반짝이 D01, 효과선 D05, 체크 D06·D07.
- 쓰지 않은 것: A01 배경(모서리에만 붓 터치가 있어 샘플과 다름 → 샘플처럼 배치한 벡터 줄무늬 유지), D02 별·D03/D04 음표(로고·캐릭터 그림에 이미 포함).
- 벡터로 그린 것: 표지·마무리 태극 붓 터치 줄무늬, 빨간 붓 스윕, 구름·덤불·도로.

## PPT (`갈현이룸태권도_상담PPT.pptx`)

- 만드는 법: `python3 build/build.py` → `python3 build/pptx_extract.py` → `node build/build_pptx.js` (pptxgenjs 필요).
  초안(index.html)에서 각 요소의 위치·스타일을 재서 그대로 PPT 개체로 옮긴다.
- 수정 가능: 모든 글자(제목·설명·금액·시간표·버스 간판), 카드·배지·가격 박스·말풍선·안내 박스(도형), 시간표(표).
- 그림: 캐릭터·로고·아이콘은 원본 PNG. 붓 터치 줄무늬·그라데이션 원·구름·도로 같은 장식만 슬라이드 배경 그림.
- 폰트: `fonts_ppt/` (TTF/OTF). PPT 여는 PC에 설치 필요 — 레코체(Recipekorea), 온글잎 석영체(Ownglyph SeokyoungChae), Pretendard Medium/SemiBold/Bold, Montserrat ExtraBold.
