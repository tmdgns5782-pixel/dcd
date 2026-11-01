# 감사 지시문 (각 영역 감사관에게 공통 머리말 + 영역 지시)

const SCHEMA = { type: 'object', properties: {
  verified: { type: 'array', items: { type: 'object', properties: { feature: { type: 'string' }, how: { type: 'string' }, result: { type: 'string', enum: ['pass', 'fail', 'partial'] }, evidence: { type: 'string' } }, required: ['feature', 'how', 'result', 'evidence'] } },
  findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['critical', 'major', 'minor'] }, title: { type: 'string' }, area: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, repro: { type: 'string' }, expected: { type: 'string' }, actual: { type: 'string' }, suggestedFix: { type: 'string' } }, required: ['severity', 'title', 'area', 'files', 'repro', 'expected', 'actual'] } },
  verdict: { type: 'string' } }, required: ['verified', 'findings', 'verdict'] }
const PRE = `너는 "HDS 안전장부" Google Apps Script 웹앱의 **독립 감사팀** 감사관이다. 구현팀과 별개로, 기능이 실제로 제대로 되는지 증거로 확인한다.
프로젝트 /home/user/dcd/hds-safety. 계약서 SPEC.md 와 dev/AGENT-BRIEF.md 를 먼저 읽어라. 고객 요구: 본사가 표준 안전보건 양식을 사업장에 배포하고, 취합하고, 받은 내용을 분석하는 사이트(GAS). 디자인은 taste-skill 앱 화면 규칙 + HDS CI. "가장 중요한 건 기능".
규칙: 소스 파일(gas/, dev/, docs/, README) 을 고치지 마라 — 읽기·실행만. 시험 스크립트·스크린샷은 스크래치 /tmp/claude-0/-home-user-dcd/692a5cfe-94c9-5d9f-8350-64252635e7e1/scratchpad/audit/<네 영역>/ 에.
미리보기 실행: cd /home/user/dcd/hds-safety && node dev/build-preview.mjs → dist/preview.html. node 로 작은 http 서버를 띄워 Playwright(require('playwright'), chromium.launch())로 연다. ?demo=1 이면 관리자 자동 로그인 + 예시 데이터. 사업장 링크는 ?s=<token>(token 은 window.__mock 상태 또는 본사 '사업장' 화면에서).
서버 API 는 브라우저에서 window.__server.api(method, JSON.stringify(payload), token) 로 직접 부를 수 있다(모의 GAS). Node 시험: dev/test/server.test.mjs 참고.
판정은 실제로 해 본 결과로만. 추측으로 통과 처리 금지. 각 확인 항목에 어떻게 확인했는지(how)와 증거(evidence: 콘솔 출력·스크린샷 경로·값)를 남겨라.
발견(findings)은 재현 절차·기대·실제·관련 파일·고칠 방향을 구체적으로. 심각도: critical(핵심 기능 불가·데이터 손실·보안), major(기능 오류·잘못된 숫자·흐름 막힘), minor(문구·디자인·사소).


## auth
너의 영역: 인증·권한·보안. (1) 본사 로그인/로그아웃/잠금(5회 실패), 비밀번호 변경, 사용자 역할 admin/hq/viewer 별 허용·거부를 API 로 전부 시험. (2) 사업장 링크 로그인(이름·PIN), 사업장 세션이 다른 사업장 기록·조치·파일·인원·요청에 접근/수정 시도 → 거부되는지(payload 에 다른 site 넣기, 다른 사업장 기록 id 로 get/save/submit/delete, files.get). (3) boot 응답에 비밀(pwHash, salt, pinHash, 다른 사업장 token) 노출 여부. (4) 토큰 없는 호출 거부, 만료 세션. (5) XSS: 기록 텍스트·사업장 이름·요청 제목에 <img src=x onerror=alert(1)> 넣고 본사·사업장 모든 화면·인쇄에서 실행되는지(Playwright dialog 이벤트 감시). (6) 확인된 기록 수정 금지, viewer 쓰기 금지, 마지막 관리자 비활성화 금지.


## engine
너의 영역: 양식 엔진 전체(FD 의 모든 양식 F01, F01B, F02, F03, F04, F05, F06, F07, F08A, F08B, F08C, F09, F10, F10B, N1, N2, N3, N4). 각 양식마다 사업장 세션 또는 본사 대리로 새 기록을 열어: 모든 섹션이 그려지는지(필드 타입별 입력 가능), showIf 조건 동작, 계산 필드(risk 점수·등급, 합계, 비율, 시간차, 개수) 값이 맞는지 손계산과 비교, 필수·검증 메시지, 체크리스트 판정·비고 필수·사진, 표 행 추가·삭제·라이브러리 불러오기(F01), 서명 캔버스, 단계형(F04·F10 등) 단계별 제출, 임시저장 후 다시 열기(데이터 보존), 제출 후 조치 자동 등록(불량·높음 → 조치대장에 생기는지, 기한 기본값), facts 가 SPEC §5 모양인지(서버 records 테이블에서 확인), 기록 상세 화면과 A4 인쇄 미리보기(빈 양식 인쇄 포함)가 내용을 빠짐없이 보여주는지, 엑셀 내보내기 파일이 열리는지(python3 -I openpyxl). 양식별 결과를 verified 에 하나씩.


## flow
너의 영역: 배포→취합→검토 업무 흐름 끝까지. (1) 본사가 새 요청(양식 N2, 일부 사업장, 마감, 첨부 파일, 열람 확인) 생성 → 대상 사업장 담당자 메일이 보내지는지(window.__mock 의 sent 또는 admin.log kind mail) → 사업장 링크로 들어가 받은 요청에 보이고 열람 표시(reads) → 첨부 내려받기 → 양식 작성·제출(requestId 연결) → 본사 요청 상세 회수율·사업장 상태 갱신 → 독촉 메일은 미제출 사업장에만. (2) 취합 현황판: 기간 단위 전환(월·분기·반기·연), 칸 상태 기호가 실제 기록 상태(확인/제출/지연/작성중/반려/미제출/마감 전/해당없음)와 일치하는지 표본 10칸 대조, 칸 메뉴 동작. (3) 검토함: 제출 건 확인/반려(사유 필수) → 사업장에서 반려 사유 보이고 고쳐 재제출(rev 증가) → 다시 검토함 → 확인 → 잠김. (4) 조치대장: 자동 등록된 조치를 사업장이 조치중→완료(사진/사유) → 본사 확인 → 종결, 기한경과 표시. (5) cronDaily 를 window.__server.cronDaily() 로 실행해 마감 임박·기한경과 독촉 메일 내용이 맞는지. (6) 본사 홈의 '오늘의 예외'가 실제 상황을 반영하는지.


## mobile
너의 영역: 사업장 휴대폰 사용성(390×844, 그리고 360×740). 사업장 링크로 들어가 처음 이름 입력부터: 홈 할 일, '오늘 일일점검 쓰기' → F07 전부 판정·제출, '사고·아차 보고' → F04 1단계 보고(사진 첨부 포함: page.setInputFiles 로 작은 PNG), 받은 요청 열람·작성, 반려된 기록 고치기, 조치 완료 보고, 사업장 정보·인원 추가. 확인: 가로 스크롤 없음(scrollWidth), 터치 목표 44px 이상(주요 버튼 boundingBox), 글자 12px 미만 없음, 하단 탭바·상단바 동작, 키보드로 입력 시 하단 고정 줄이 입력을 가리지 않는지, 오프라인/느린 응답 시 상태 표시, 뒤로 가기 동작. 본사 화면도 390 폭에서 각 화면 한 번씩 열어 깨지는 곳 기록. 스크린샷을 Read 로 직접 보고 판단.


## analytics
너의 영역: 분석 숫자의 정확성. 데모 데이터를 적재한 뒤 window.__server.api 로 records/acts 원자료를 직접 받아(또는 __mock 상태에서 records 시트) 독립적으로 다시 계산한 값과, 분석 화면(개요, incidents, risk, daily, edu, acts, hec, sites, form/<code>)과 본사 홈 KPI·취합 현황판 회수율에 표시된 숫자를 대조하라. 최소 25개 숫자 표본. 기간 필터·사업장 필터를 바꿨을 때 숫자가 따라 바뀌는지, 합계가 부분합과 맞는지, 0/없음 표시, 재해율·도수율 공식(FD.kpiCodes 정의)이 맞는지, 발견 문장(insights)이 사실인지(숫자 대조), 차트가 비어 있거나 잘리지 않는지(스크린샷). 틀린 숫자는 major 이상.


## design
너의 영역: 디자인 준수(taste-skill 앱 화면 규칙 + HDS CI). 먼저 /home/user/leonxlnx/taste-skill/skills/taste-skill/references/app-screens.md 를 통째로 읽어라. 회사 CI 참고 이미지: /tmp/claude-0/-home-user-dcd/692a5cfe-94c9-5d9f-8350-64252635e7e1/scratchpad/pdf/hi1-01.png, hi4-04.png, hi5-05.png. 모든 본사·사업장 화면을 1440×900, 768×1024, 390×844 로 스크린샷 찍어 Read 로 보며 §2.7 의 7개 질문과 §13 금지 목록, §14 티를 하나씩 대조. 또한 DOM 측정으로: 카드 그림자, 그라데이션(현황판 해칭·로그인 외), backdrop-filter, 11px 미만 글자, 숫자 열 왼쪽 정렬, tabular-nums 미적용 숫자, 한 화면 h1 개수, 주 버튼(primary) 개수, 차트 색 수(4 초과), 라디우스 종류 수, 같은 줄 카드 아래 끝 어긋남(ragged), 카드 안 40px 넘는 빈 띠, 색 비중. CI 느낌(네이비·레드·Paperlogy 제목)이 나는지 평가. 각 위반은 화면·요소·측정값과 함께 finding 으로. 첫 화면만 예쁘고 나머지가 템플릿 같은지도 판단.


## gas
너의 영역: 실제 Google Apps Script 배포 가능성(정적 분석 + 실행 시험). (1) gas/*.gs 전부 읽고 SPEC §2 부분집합 밖 API, GAS V8 에서 안 되는 문법/API(예: structuredClone, fetch, TextEncoder, Intl 일부, setTimeout, require, import), 전역 이름 충돌, 파일 로드 순서 의존 top-level 코드, HtmlService 템플릿 문법 오류(Index.html 의 스크립틀릿), include 이름과 파일 이름 일치, appsscript.json 범위(scope)·webapp 설정, doGet BOOT 이스케이프(</script> 주입 가능성). (2) 실행 한도: 데모 규모(12곳·3000건)에서 boot·records.submit·cronDaily·Views.rebuildAll 이 GAS 6분·응답 크기 한도 안인지 — 시트 읽기 횟수·루프 안 시트 호출(getRange 를 루프에서 반복) 같은 성능 함정을 코드에서 찾아라. (3) 50,000자 셀 제한·청크·LockService 사용 위치, 동시 제출 시 id 중복 가능성. (4) clasp 배포(.clasp.json.example rootDir gas)와 README 의 수동 배포 절차를 처음 하는 사람 입장에서 따라가 보며 빠진 단계·틀린 메뉴 이름 지적. (5) 클라이언트가 GAS iframe 안에서 깨질 요소(localStorage 사용 시 예외 처리, window.top 접근, 다운로드 a[download] 가 샌드박스에서 동작하는지 — GAS IFRAME 샌드박스에선 allow-downloads 가 있음, target=_top 링크, 클립보드 API 권한 실패 대비).


## forms
너의 영역: 양식 내용 품질(고객이 실제로 요청한 '6~10번 수정·보완'과 N1~N4 신규 양식). ref/forms-original/ 원본(python3 -I openpyxl/python-pptx 로 읽기)과 gas/FormsData.html 의 양식 정의, docs/FORMS-REVIEW.md 를 대조: 원본의 중요한 점검 항목이 빠지지 않았는지, 보완 내용이 실제 FD 에 반영됐는지(문서와 FD 불일치), 산업안전보건법 시행규칙 교육시간(별표 4)·비상조치·작업허가 내용의 사실 정확성, HEC 항목 매핑(FD.hecItems ↔ 참고 xlsx) 누락, 경비·미화·주차·시설 용역 현장 실무 적합성, 문구 오탈자·어려운 표현, 판정 척도 일관성. FD JSON 무결성(id 고유, 참조 존재)도 스크립트로 검사. 앱 화면에서 실제로 F06·F07·F09·F10·N1~N4 를 열어 사용자 눈으로 읽기 쉬운지도 확인.
