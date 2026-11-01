forms/docs 결과 반영 필요:
- engine: computed 필드에도 validate 실행, lte/gte/eq 의 rule.value(상수) 비교 지원 (F01 scoreAfter, N3 planMin, N4 prevRows).
- settings.requiredForms.seasonal.F06 기본값을 FD F06 frequency.seasonMonths([4..9])와 맞추기 (Config.gs DEFAULT_SETTINGS) — 또는 엔진이 FD seasonMonths 우선.
- F09 kpiCodes 에 M01~M03, R04 추가됨 → Views HQ_MonthlyData 반영 확인.
- 분석 화면이 F07/F01/F08A/N1 에서 TBM 수·위험성평가 수·보호구 지급 수를 세는지(FORMS-REVIEW 서술과 일치하게).
ui-css 계약 보충:
- 휴대폰은 문서 스크롤, 데스크톱은 .sheet 내부 스크롤 → 화면 전환 시 #main.scrollTop=0 + window.scrollTo(0,0) 둘 다.
- 인쇄 미리보기는 #print-root 에 .show 클래스를 붙여야 화면에 보임(engine-b 확인).
- 태블릿(641~1100)은 .topbar 직속 .only-phone 만 보임.
- Paperlogy 폰트 파일 없음(CDN 403) → 미리보기는 대체 글꼴. GAS 실배포는 jsdelivr 로 로드.
server-data 계약 보충:
- gas-mock 에 Sheet.insertColumnsAfter, Trigger.getHandlerFunction, File.moveTo, formatDate 패턴('yyMMdd-HHmm','yyyy-MM-dd HH:mm:ss') 필요.
- Db.all/get 은 메모 객체 그대로 반환(변경 후 upsert 필요). records.data 지연 읽기 — 색인 행 만들 때 필요한 필드만 골라 담기.
- 미리보기 export.xlsx: 모의 UrlFetch 가 export URL 에 가짜 xlsx 를 주거나, 클라이언트가 App.engine.xlsx 로 대체.
- 미리보기처럼 실행이 이어지는 환경: api() 시작에서 Db.reset() 권장.
site 계약 보충:
- 새 기록 링크: '#/new/F07/<site>?date=YYYY-MM-DD&shift=주간|야간', '#/new/<form>/<site>?req=<id>' → engine-a new 화면이 ?date ?shift 읽어야 함.
- acts.transition 완료 payload 에 noPhotoReason 추가 가능(서버가 무시해도 note 에 덧붙임).
- ackRequired 는 '확인했습니다' 누를 때만 reads.mark.
- App.siteViews.todoCount/unreadCount 로 사업장 내비 배지 가능.
analytics 계약 보충:
- engine-a factsOf: F01 sec_hazards 계산 열 grade·gradeAfter 를 facts.t.c 에, F04 sec_return.lostDays 를 facts.t.s 에 넣기(계산 열도 select/number 처럼 집계).
- App.engine.hecReady(site) 반환 모양 통일(0~100 숫자 권장).
- hq-a requests/new 가 쿼리 form=F01&sites=S001,S002 를 읽어 미리 채우기.
- 재해율 정의(ΣA02 ÷ 평균 월말 재적 × 100) — FD/SPEC 에 명시 필요(문서 반영).
engine 계약 보충:
- expectedFor(siteId, refDate) → [{def, period:{key,label,from,to}, due, st}] (옛 3인자 호환). schedStatus 에 periodKey/from/to/recId/late 추가, event 는 {status:'na'}.
- hecReady(site, refDate) → {total, applicable, counts, cells, pct, score, mock} (객체!) — analytics 는 숫자 또는 {pct} 받도록 해 둠, hq-a 홈/사업장 확인 필요.
- '제출' 상태 기록 재편집은 자동저장 안 함 → [수정 제출]만. 서버 records.save 가 제출 기록 임시저장을 허용할지 결정.
- App.engine.flushEditor()/editing() 공개. body.fe-editing 시 휴대폰 탭바 숨김.
hq 계약 보충:
- JsCore 검토함 배지 cReview 가 App.hq.reviewCount() 를 쓰도록(단계보고 확인 후 배지>목록 불일치).
- 휴대폰 .actions 줄바꿈(≤640) — Css.html.
- 정기 양식 독촉은 새 요청 미리 채움으로 이동(직접 메일 API 없음).
- F07 일일점검을 본사가 '확인'까지 해야 하는지 결정 필요(검토함 맨 뒤 정렬).
dispatch 계약 보충:
- 서버 Dispatch.dueStatus 는 직전 기간 마감 지나고 미제출이면 그 기간을 'miss' 로 보고. 엔진 schedStatus(프로토타입 이식)는 월·분기·반기·계절 양식을 miss 로 못 보일 수 있음 → 엔진 schedStatus 를 서버 규칙과 일치시켜 현황판·메일 불일치 없애기.
- requests.remind 반환 sites[].result 로 실제 건너뛴 이유 표시(JsHq.html:570 문구 '메일 주소 없는 n곳 제외' 수정).
- 메일 링크 '#/rec/id' 가 GAS /exec 에서 살아남도록 ui-core 가 google.script.url.getLocation 의 hash 를 읽어 첫 라우팅에 반영.
- 미리보기 export.xlsx 실패(외부 호출 불가) → 클라이언트 엑셀 버튼은 App.engine.xlsx 사용, 모의 UrlFetch 에 export URL 가짜 응답 추가 또는 시험에서 참고 처리 유지.

리드 기본 결정(사용자 미응답 시 기본값):
- F07 일일점검은 본사 '확인' 대상이 아님. 검토함에는 불량 판정 또는 사고·아차 건수가 있는 F07 만 올림(나머지는 '제출'로 종결로 간주). JsCore 검토함 배지도 같은 규칙(App.hq.reviewCount 사용).
- 재해율 = Σ재해자수(A02) ÷ 평균 월말 재적인원(H01) × 100 — docs/USER-GUIDE.md 와 분석 화면 각주에 명시.
- 제출된 기록 재편집은 [수정 제출]만(자동저장 없음).
- F06 폭염 시즌: FD seasonMonths(4~9월)를 정본으로, Config DEFAULT_SETTINGS.requiredForms.seasonal.F06 도 [4,5,6,7,8,9].
