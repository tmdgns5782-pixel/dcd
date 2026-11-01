# HDS 안전장부 — Google Apps Script 웹앱 설계 계약서 (SPEC)

이 문서는 병렬로 일하는 모든 구현 에이전트의 **계약**이다. 여기 적힌 이름·모양·규칙을 바꾸지 말 것.
바꿔야 하면 바꾸지 말고 최종 보고에 "계약 변경 필요"로 적는다.

## 0. 무엇을 만드나

HDS(주) 안전경영지원실(본사)이 표준 안전보건 양식(F01~F10, N1~N4)을 **사업장에 배포**하고, 사업장이 웹(주로 휴대폰)으로
작성·제출한 것을 **취합**하고, 본사가 **분석**하는 Google Apps Script(GAS) 웹앱.

- 양식 정의는 `gas/FormsData.html` 의 JSON(이하 FD) 하나가 원천이다. 양식 엔진이 이 JSON으로 입력 화면·검증·계산·인쇄를 만든다.
- 이전 로컬판 프로토타입 `ref/prototype-hds-anjeonjangbu.html` (단일 HTML, IndexedDB)에 양식 엔진·화면이 이미 있다.
  **로직은 최대한 이식**하고, 저장소·권한·배포·취합·분석·디자인은 이 문서대로 새로 만든다.
  프로토타입 주요 구간(줄 번호): 기본도구 285, 저장소 329, 공통조회 380, 양식엔진 409, 마감기대치 579, HEC 624, 라우터·화면 654,
  기록편집 802, 기록상세·목록 1079, 조치대장 1154, 일정 1220, HEC화면 1228, 사업장·인원 1238, 데이터 1294, XLSX 1400, 출력 1454,
  설정 1492, 이벤트 1519, 자동채우기 1574, 예시데이터 1607, 시작 1657. CSS 8~259.
- 원본 양식 파일: `ref/forms-original/` (1~10 xlsx/pptx, 참고: 고객사 HEC 안전평가 항목 xlsx).
- 디자인: taste-skill(app screens) 규칙 + HDS CI. §9 참고. 원문: `/home/user/leonxlnx/taste-skill/skills/taste-skill/references/app-screens.md`.

사용자
- 본사 관리자(admin): 전부. 사업장·사용자·배포 관리, 검토(확인/반려), 분석, 설정.
- 본사 담당(hq): 관리자와 같되 사용자 관리·설정 불가.
- 본사 열람(viewer): 읽기 + 분석만.
- 사업장(site): 사업장별 비밀 링크(`?s=<siteToken>`)로 들어옴. 구글 계정 없어도 됨. 선택적으로 PIN. 자기 사업장 데이터만.

## 1. 파일과 담당 (소유자만 그 파일을 쓴다)

```
hds-safety/
  SPEC.md                 계약서(이 파일) — 리드만 수정
  README.md               배포·운영 가이드(한국어)                      [docs]
  docs/FORMS-REVIEW.md    양식 6~10·N1~N4 검토·보완 내역                 [forms]
  gas/                    ← clasp rootDir. Apps Script 프로젝트 그대로
    appsscript.json       (리드 작성)
    Config.gs             상수·테이블 스키마 SCHEMA (리드 작성, server-data가 보강 가능)
    Db.gs                 시트 DB 계층                                   [server-data]
    Views.gs              양식별 평탄화 시트·월간지표 시트·재구축          [server-data]
    Export.gs             시트/엑셀 내보내기                              [server-data]
    Setup.gs              setup(), 트리거 설치, 초기 관리자                [server-data]
    Main.gs               doGet, include, BOOT                           [server-api]
    Auth.gs               로그인·세션·사업장 토큰·권한                     [server-api]
    Api.gs                api() 디스패처 + 핸들러(기록·조치·사업장·인원·사용자·파일·설정·admin) [server-api]
    Dispatch.gs           배포(요청·공지)·열람·독촉·메일 템플릿·cronDaily/cronWeekly [server-dispatch]
    FormsData.html        FD JSON (forms 에이전트만 내용 보완 가능, 스키마 변경 금지)
    Index.html            셸 마크업 + include 순서 (리드 작성)
    Css.html              디자인 시스템 전체(토큰·셸·컴포넌트·폰)          [ui-css]
    CssEngine.html        .fe-* 양식 편집기 / .pdoc 인쇄                  [engine]
    CssViews.html         .hq-* .st-* .an-* 화면 전용 소량                 [views-css] (아래 참고)
    JsCharts.html         window.Charts (taste charts.js 이식·확장)       [analytics-a]
    JsCore.html           App 코어: util·api·store·router·셸·로그인·UI 컴포넌트·아이콘 [ui-core]
    JsEngine.html         App.engine: 계산·검증·조치추출·facts·편집기·읽기·인쇄·엑셀·자동채우기 [engine-a, engine-b 분담]
    JsHq.html             본사 화면                                       [hq-a, hq-b 분담]
    JsAnalytics.html      분석 화면                                       [analytics-a, analytics-b 분담]
    JsSite.html           사업장(휴대폰) 화면                              [site]
    JsDemo.html           예시 데이터 생성기 App.demo                      [demo]
  dev/
    gas-mock.js           GAS 서비스 모의(브라우저·Node 겸용)              [harness]
    build-preview.mjs     gas/ → dist/preview.html (모의 서버 내장 단일 HTML) [harness]
    test/server.test.mjs  Node에서 모의로 서버 API 시험                   [harness]
    test/e2e.mjs          Playwright 시나리오 시험                        [harness]
  dist/preview.html       빌드 결과(커밋함)
  vendor/                 taste-skill charts.js·app.css 원본, 라이선스, 폰트
  ref/                    프로토타입·원본 양식(읽기 전용)
```

하나의 파일을 두 에이전트가 나눠 쓰는 경우(JsEngine, JsHq, JsAnalytics)는 **파일 안에 각자 구역**을 둔다.
리드가 만든 뼈대에 `/* ===== [engine-a] 시작 ===== */ … /* ===== [engine-a] 끝 ===== */` 표식이 있다. 자기 구역 밖은 건드리지 않는다.
(편집은 표식 사이에만. Edit 도구로 자기 구역 표식을 기준으로 바꿀 것.)

CssViews.html 은 hq-a/hq-b/analytics/site 가 각자 구역(`/* [hq-a] */` 등)에 쓴다. 코어 클래스로 되면 쓰지 않는다.

## 2. 런타임 규칙 (GAS)

- V8 런타임, 시간대 `Asia/Seoul`. 서버 코드는 전역 함수/전역 객체(`var Db = {...}` 등). ES2019까지만(옵셔널 체이닝·널 병합은 V8 GAS에서 됨. 클래스 필드·top-level await 금지). `import/export` 금지.
- 서버 .gs 파일은 **브라우저에서도 실행된다**(미리보기). 그래서 Node/브라우저 전용 API 금지, 아래 GAS 부분집합만 사용:
  - SpreadsheetApp: openById, create, flush; Spreadsheet: getSheetByName, insertSheet(name), getSheets, getId, getUrl, deleteSheet;
    Sheet: getName, getRange(r,c,nr,nc), getLastRow, getLastColumn, getMaxRows, getMaxColumns, appendRow, clear, clearContents, setFrozenRows,
    deleteRows(start,n), insertRowsAfter(after,n), hideSheet, setColumnWidth(col,w), getDataRange;
    Range: getValues, setValues, getValue, setValue, setNumberFormat, setNumberFormats, setFontWeight, setBackground, setFontColor, clearContent, getNumRows, getNumColumns.
  - PropertiesService.getScriptProperties(): getProperty, setProperty, deleteProperty, getProperties, setProperties.
  - CacheService.getScriptCache(): get, put(k,v,sec), remove, getAll, putAll, removeAll. (값 100KB 이하, 최대 21600초)
  - LockService.getScriptLock(): waitLock(ms), tryLock(ms), releaseLock, hasLock.
  - DriveApp: getFolderById, createFolder(name), getFileById, getRootFolder; Folder: createFolder, createFile(blob), getId, getUrl, getName;
    File: getBlob, getId, getUrl, getName, getMimeType, getSize, setTrashed, makeCopy(name, folder).
  - Utilities: newBlob(bytes|string, mime, name), base64Encode, base64Decode, computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8),
    getUuid, formatDate(date, tz, pattern), sleep.
  - Blob: getBytes, getDataAsString, getContentType, getName, setName.
  - Session.getActiveUser().getEmail(), Session.getEffectiveUser().getEmail(), Session.getScriptTimeZone().
  - MailApp.sendEmail({to, subject, htmlBody, name, replyTo}), MailApp.getRemainingDailyQuota().
  - ScriptApp.getService().getUrl(), ScriptApp.newTrigger(fn).timeBased().atHour(h).everyDays(1).create(),
    ScriptApp.newTrigger(fn).timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(h).create(), getProjectTriggers, deleteTrigger, getOAuthToken.
  - UrlFetchApp.fetch(url, {method, headers, payload, contentType, muteHttpExceptions}) → getResponseCode, getContentText, getBlob.
  - HtmlService.createTemplateFromFile(name)(.evaluate), createHtmlOutputFromFile(name).getContent(), HtmlOutput.setTitle, addMetaTag,
    setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL), setFaviconUrl.
  - Logger.log, console.log/warn/error.
  이 밖이 꼭 필요하면 쓰되 `dev/gas-mock.js` 에도 추가돼야 하므로 최종 보고에 적는다.
- 시트 셀 한 칸 최대 50,000자. 큰 JSON 은 §5 청크 규칙.
- 모든 날짜·시각은 **문자열**로 저장: 날짜 `YYYY-MM-DD`, 시각 `YYYY-MM-DDTHH:mm:ss`(KST, 오프셋 없음). 시트에는 쓰기 전에 범위에 `setNumberFormat('@')`.
- 동시성: 쓰기는 `Db.withLock(fn)`(ScriptLock 20초) 안에서.
- 클라이언트가 부르는 서버 함수는 **딱 하나**: `api(method, payloadJson, token)` → JSON 문자열 `{"ok":true,"data":…}` 또는
  `{"ok":false,"error":"사람이 읽을 한국어 문장","code":"AUTH|FORBIDDEN|NOTFOUND|INVALID|CONFLICT|SERVER"}`. 예외는 api 안에서 잡아 이 모양으로.

## 3. 부팅·템플릿

- `doGet(e)`: `HtmlService.createTemplateFromFile('Index')`, `t.BOOT = JSON.stringify({ url: ScriptApp.getService().getUrl(), s: e.parameter.s||'', view: e.parameter.v||'', appName, company, version })`.
  `.evaluate().setTitle('HDS 안전장부').addMetaTag('viewport','width=device-width, initial-scale=1, viewport-fit=cover').setXFrameOptionsMode(ALLOWALL)`.
- `include(name)` = `HtmlService.createHtmlOutputFromFile(name).getContent()`.
- Index.html 은 `<?!= include('Css'); ?>` 형태로만 포함하고, `<script>window.BOOT = <?!= BOOT ?>;</script>` 로 BOOT 전달.
  미리보기 빌드는 이 두 형태만 정규식으로 처리한다. 다른 스크립틀릿 금지.
- 포함 순서(Index.html): FormsData, Css, CssEngine, CssViews, JsCharts, JsCore, JsEngine, JsDemo, JsHq, JsAnalytics, JsSite, 마지막에 `<script>App.start()</script>`.

## 4. 인증·세션·권한

- 비밀번호: `salt`(Utilities.getUuid) + SHA-256(salt + ':' + pw) 를 hex 로. 평문 저장 금지.
- `setup()`(편집기에서 1회 실행): DB 스프레드시트·드라이브 폴더 생성, 스크립트 속성 `DB_ID`, `FOLDER_ID` 저장,
  관리자 `admin` 계정을 임의 10자 비밀번호로 만들고 `Logger.log` 로 출력(+ 속성 `INIT_ADMIN_PW_SHOWN=1`). 이미 있으면 건너뜀(idempotent).
- 세션 토큰: Utilities.getUuid() 두 개를 이어 붙인 문자열. `sessions` 테이블 + CacheService(`sess:<token>`, 6시간) 이중 저장.
  본사 세션 만료 14일, 사업장 세션 30일. 매 호출마다 캐시 확인 → 없으면 시트 확인 → 있으면 캐시 재적재.
- `auth.login {id, password}` (본사) / `auth.siteLogin {siteToken, pin?, name}` (사업장. 사업장에 pinHash 가 있으면 PIN 필수) /
  `auth.google {}` (Session.getActiveUser 이메일이 users.email 과 같으면 로그인 — 같은 Workspace 도메인일 때만 됨) / `auth.logout {}` /
  `auth.changePassword {old, new}` / `auth.status {}`(토큰 없이: {ready: DB 준비 여부, appName, company}).
- 로그인 실패 5회/15분 → 15분 잠금(캐시 카운터, 키 `fail:<id>`).
- me 모양: `{ kind:'hq'|'site', id, name, role:'admin'|'hq'|'viewer'|'site', site: siteId|null, siteName? }`.
  사업장 세션의 name 은 로그인 때 입력한 작성자 이름(사업장 담당자). id 는 `site:<siteId>`.
- 권한 함수(Auth.gs): `Auth.require(token, perm)` → me 또는 throw. perm: 'any' | 'hq'(admin|hq|viewer) | 'hqWrite'(admin|hq) | 'admin' | 'site'.
  사업장 세션은 자기 site 의 데이터만 읽고/쓰기. 다른 site 를 건드리면 FORBIDDEN.

## 5. 데이터 모델 (`Config.gs` 의 SCHEMA 가 정본)

스프레드시트 하나(`HDS 안전장부 DB`)에 테이블 시트. 1행은 헤더(영문 키). 열 순서는 SCHEMA 순서. JSON 열은 문자열로 저장하고 Db 가 파싱/직렬화.
`Db` 는 객체를 `{키: 값}` 으로 다루고 json 타입 열은 자동 변환한다. 큰 JSON 열(`data`, `facts`)은 45,000자씩 잘라
`data`, `data_2` … `data_8` 열에 나눠 저장(SCHEMA 에 chunk:8 표시). 넘치면 드라이브 JSON 파일로 저장하고 `data` 에 `@drive:<fileId>`.

테이블과 열 — Config.gs 참조. 요약:
- `sites` id, name, type, region, client, address, tags[], shifts[], forms[](필수 양식 코드, 비면 기본값), openDate, status('운영'|'종료'), hec(bool),
  hecLastEval, hecNextEval, headcount, managerName, managerEmail, managerPhone, token, pinHash, pinSalt, memo, createdAt, updatedAt
- `people` id, site, name, job, role, phone4, active(bool), createdAt, updatedAt
- `users` id(로그인 ID), email, name, role, salt, pwHash, active(bool), createdAt, updatedAt, lastLoginAt
- `sessions` token, kind, uid, site, name, role, createdAt, expiresAt
- `records` id, form, formVersion, site, date, period, shift, status, stageDone[], author, rev, createdBy, requestId,
  createdAt, updatedAt, submittedAt, confirmedAt, confirmedBy, returnedAt, returnedBy, returnNote, deleted(bool), deletedReason,
  facts{}, data{}(chunk 8)
- `acts` id, key, site, srcId, srcForm, srcItem, title, detail, level, type, due, owner, status, photoBefore, photoAfter,
  doneAt, doneBy, doneNote, confirmedAt, confirmedBy, history[], createdAt, updatedAt, deleted(bool)
- `requests` id, kind('form'|'notice'), title, message, forms[], sites[](['*']=전체), periodKey, openAt, due, attachments[]({id,name,mime,size}),
  ackRequired(bool), remind{}, status('진행'|'마감'|'취소'), createdBy, createdAt, updatedAt, lastRemindAt
- `reads` id, refId, site, by, at   (공지·요청 열람/확인 기록)
- `files` id, site, recordId, name, mime, size, driveId, kind('photo'|'sign'|'attach'), createdAt, createdBy
- `log` at, who, kind, ref, text
- `kv` key, value{}   (설정: settings, counters 등)

상태 어휘
- 기록 status: `'작성중' | '제출' | '확인' | '반려'`. 단계형 양식(def.stages)은 단계마다 제출 → stageDone 에 단계 id 추가.
  모든 단계 완료 시 status '제출'. 단계 진행 중(stageDone 1개 이상, status '작성중')도 본사에 보인다("1단계 보고").
  반려되면 사업장이 고쳐 다시 제출(rev+1). '확인' 된 기록은 잠김(관리자만 '확인 취소' 가능 → '제출').
- 조치 status: `'등록' | '조치중' | '완료' | '확인' | '보류' | '고객사 이관'` (FD.codes.actStatus). level: '높음'|'보통'|'낮음'.
- 요청 status: '진행' | '마감' | '취소'.

ID 규칙(서버가 Lock 안에서 발급)
- 기록: `${def.idPrefix}-${site}-${YYMMDD(date)}-${NN}` (본사 대리 입력은 끝이 `H1, H2…`).
- 조치: `ACT-${site}-${YYMM}-${NNN}` (본사 등록은 `H01…`).
- 요청: `REQ-${YYMMDD}-${NN}`, 사업장: `S001` 형식(영대문자·숫자 2~8자, 사용자가 정함), 파일: `FILE-<uuid8>`, 인원: `P-<uuid8>`.

기간 키(period) — 클라이언트 엔진 `periodOf(type, date)` 와 서버 동일 규칙:
daily `YYYY-MM-DD`, monthly·season `YYYY-MM`, quarterly `YYYY-Qn`, half `YYYY-H1|H2`, annual `YYYY`, event `''`.
F09(월간보고)는 data.reportMonth 의 월. 클라이언트가 계산해서 record.period 로 보낸다.

facts (분석용 요약, 클라이언트 `App.engine.factsOf(def, rec)` 가 만들어 제출 때 함께 보냄):
```
{ v: { <fieldId>: 값 },           // header + fields 섹션 중 type ∈ select, multi, number, date, datetime, time, bool, computed (sensitive:true 제외)
  t: { <tableId>: { n: 행수, c: { <selectColId>: { <값>: 건수 } }, s: { <numberColId>: 합계 } } },
  k: { <checklistSectionId>: { <itemCode>: '양호'|'주의'|'불량'|'해당없음' } },
  sm: [ def.summary 순서대로 값 ] }
```
추가 규칙: person/people/multi 필드는 개수를 `v['<id>#n']` 로 넣는다(사람 이름 자체는 넣지 않음). 반 select 계열 값은 문자열 그대로.

## 6. API (`api(method, payloadJson, token)`)

권한 표기: any=로그인한 누구나, hq, hqWrite, admin, site(사업장만), own(사업장은 자기 것만, 본사는 전체).
모든 응답 data 는 아래 모양. 사업장 세션은 서버가 자동으로 자기 site 로 범위를 좁힌다.

| method | 권한 | payload | data |
|---|---|---|---|
| auth.status | 없음 | {} | {ready, appName, company, hasUsers} |
| auth.login | 없음 | {id, password} | {token, me} |
| auth.siteLogin | 없음 | {siteToken, pin, name} | {token, me} |
| auth.google | 없음 | {} | {token, me} 또는 error AUTH |
| auth.logout | any | {} | {} |
| auth.changePassword | hq | {old, new} | {} |
| boot | any | {days?:400} | {me, settings, sites, people, users(admin만, 해시 제외), requests, reads, acts, index, serverTime, urls:{app, sheet(hq만), folder(hq만)}} |
| records.index | any(own) | {from?, to?, forms?, sites?} | [indexRow] |
| records.get | any(own) | {id} | record(전체, data 포함) |
| records.bulkGet | any(own) | {ids} | [record] |
| records.save | any(own, viewer 불가) | {record} | {record} (임시저장. id 없으면 발급. status 는 '작성중' 유지, 반려 기록은 '반려' 유지) |
| records.submit | any(own, viewer 불가) | {record, stageId?, acts:[actCandidate]} | {record, acts:[생성·갱신된 조치]} |
| records.review | hqWrite | {id, decision:'확인'|'반려'|'확인취소', note} | {record} |
| records.delete | any(own) | {id, reason} | {} (작성중·반려만 사업장 삭제 가능 — 단, 단계 보고가 있는 기록과 반려된 F04·F10 은 사업장 삭제 불가. 본사 hqWrite 는 언제나. soft delete) |
| acts.save | any(own) | {act} | {act} (본사 수동 등록 포함) |
| acts.transition | any(own) | {id, to, note, photo?, owner?, due?} | {act} (확인은 hqWrite 또는 사업장 '소장' 역할 이름 무관 — 사업장도 '확인' 가능하되 history 에 남김) |
| sites.save | admin | {site} | {site} (새로 만들 때 token 자동 발급) |
| sites.rotateToken | admin | {id} | {site} |
| sites.setPin | admin | {id, pin('' 이면 해제)} | {site} |
| people.save | any(own) | {person} | {person} |
| people.bulk | any(own) | {site, rows:[{name,job,role,phone4}]} | {added, skipped} |
| people.delete | any(own) | {id} | {} (active=false) |
| users.save | admin | {user, password?} | {user} |
| users.delete | admin | {id} | {} (active=false) |
| requests.save | hqWrite | {request} | {request} (새로 만들면 대상 사업장 담당자 메일 발송 — settings.mail.onRequest) |
| requests.close | hqWrite | {id, status} | {request} |
| requests.remind | hqWrite | {id, sites?} | {sent, skipped} |
| reads.mark | write(viewer 제외) | {refId} | {read} (사업장은 받은 REQ 만, 본사는 요청 또는 '<기록번호>#<단계>') |
| files.put | any(own) | {dataUrl, name, kind, recordId?, site?} | {file} (최대 8MB) |
| files.get | any(own) | {id} | {id, name, mime, dataUrl} |
| settings.save | admin | {settings} | {settings} |
| export.sheet | hq | {kind:'records'|'acts'|'form', form?, from?, to?, sites?} | {url} (드라이브에 새 구글 시트 만들어 링크) |
| export.xlsx | hq | 위와 같음 | {name, base64} |
| admin.rebuildViews | admin | {} | {sheets:[…], rows} |
| admin.importBulk | admin | {sites?, people?, records?, acts?, requests?, reads?, replace?:bool} | {counts} (예시 데이터·이관용, id 유지) |
| admin.wipe | admin | {confirm:'삭제'} | {} (users·sessions 빼고 모두 비움) |
| admin.info | admin | {} | {triggers, quota, sheetUrl, folderUrl, version, counts} |
| admin.installTriggers | admin | {} | {triggers} |
| admin.log | hq | {kind?, limit?:200} | [logRow] 최신순 (kind 'mail' = 보낸 메일 기록) |

indexRow = `{id, form, site, date, period, shift, status, stageDone, author, createdBy, requestId, rev, updatedAt, submittedAt, confirmedAt, returnNote, facts}` (data 제외).
actCandidate = `{key, srcItem, title, detail, level, due, owner, photo}` — 서버가 key 로 기존 조치 찾고, 열린 조치면 갱신, 없으면 새로 발급.
settings 기본값(kv 'settings'):
```
{ company:'HDS(주) 안전경영지원실', appName:'HDS 안전장부',
  mail:{ enabled:true, onRequest:true, onReturn:true, onIncident:true, dailyReminder:true, weeklyDigest:true, hqEmails:[] },
  reminder:{ beforeDays:[3,1], overdue:true, hour:8 },
  dailyDue:'10:00', monthlyDueDay:5,
  requiredForms:{ default:['F07','F09','F01','N1','N2','N4','F08B','F10B'], seasonal:{ F06:[6,7,8,9] } } }
```
메일(Dispatch.gs): 새 요청 → 대상 사업장 managerEmail. 반려 → 사업장. F04/F10 단계 제출 → hqEmails 즉시. cronDaily(08시): 마감 D-3/D-1·기한경과
요청과 정기양식 미제출 사업장에 독촉, 기한경과 '높음' 조치 요약을 hqEmails 로. cronWeekly(월 08시): 주간 요약(제출률·사고·미결조치).
메일 HTML 은 CI 스타일(흰 바탕, 상단 네이비 띠 없이 워드마크, 본문 ink #14183c, 강조 네이비 #223189, 버튼은 #14183c 채움, 사업장 링크 포함).

## 7. 클라이언트 구조 (전역 `window.App`, 프레임워크 없음)

각 Js*.html 은 `<script>(function(){ 'use strict'; … })();</script>` 하나. 모듈 간 통신은 `App` 의 공개 함수로만.

### 7.1 JsCore 가 제공 (ui-core) — 다른 모듈은 이것만 믿고 쓴다
- `App.FD`(FD 전체), `App.FORMS`(배열), `App.FORM`(code→def).
- 유틸 `App.u`: esc, pad, today(), now(), isoLocal(d), dkey(d), parseD(s), addDays(s,n), daysDiff(a,b), fmtD, fmtDT, rel(s)("오늘/어제/3일 전"),
  num(v, d=0)(천 단위 구분), pct(v, d=1), uid(), clone, isEmpty, debounce(fn,ms), groupBy(arr, fn), sum(arr, fn), sortBy(arr, fn, desc),
  periodOf(type, date) → {key, from, to, label}, yymmdd, yymm.
- `App.api(method, payload, opts)` → Promise(data). 세션 토큰 자동 첨부, 실패 시 Error(message, code). code 'AUTH' 면 로그인 화면으로.
  `opts.silent` 이면 토스트 안 띄움. 미리보기·GAS 둘 다 `google.script.run.withSuccessHandler().withFailureHandler().api(m, JSON.stringify(p), token)`.
- 상태 `App.S`: `{ boot, me, settings, sites:[], people:[], users:[], requests:[], reads:[], acts:Map, index:Map, records:Map(전체 기록 캐시), files:Map }`.
  `App.load()` = boot 호출 후 S 채움. `App.refresh()` = 다시 불러오고 현재 화면 다시 그림.
  편의: `App.site(id)`, `App.siteName(id)`, `App.activeSites()`, `App.isHQ()`, `App.canWrite()`, `App.isAdmin()`, `App.peopleOf(site)`,
  `App.recs(filterFn)`(index 배열, 삭제 제외), `App.acts(filterFn)`, `App.getRecord(id)`(→Promise 전체 기록, 캐시), `App.putIndex(rec)`, `App.putAct(act)`,
  `App.getFile(id)`(→Promise dataUrl, 캐시), `App.uploadFile(fileOrDataUrl, {kind, recordId, site, name})`(→Promise fileId, 사진은 1600px·품질 .72 로 줄여서).
- 라우터: 해시 `#/경로/인자?쿼리`. `App.view(name, def)` 로 등록: def = `{ title, render(main, args, query) , nav?:string }`. `App.go(hash)`, `App.route()`.
  `App.views` 에 없는 경로는 홈으로. 각 화면은 `main` 엘리먼트에 innerHTML 로 그린다. 화면 전환 시 스크롤 맨 위.
- 셸: 로그인 후 `App.renderShell()` — 본사는 사이드바 내비(아래 §8 순서), 사업장은 휴대폰 하단 탭바 + 데스크톱에선 좁은 사이드바.
  내비 항목 정의는 JsCore 의 `App.NAV.hq`, `App.NAV.site` 배열 `[{key, label, icon, href, count?:fn}]`.
- UI 함수(모두 HTML 문자열을 반환하거나 Promise):
  `App.ui.titleRow({title, sub, actions})`, `App.ui.panel({title, sub, actions, body, foot, cls})`, `App.ui.kpis([{label, value, unit, sub, tone}])`,
  `App.ui.pill(text, tone)` tone ∈ pos|neg|warn|neu|acc, `App.ui.recStatus(indexRow)`, `App.ui.actStatus(act)`, `App.ui.level(level)`,
  `App.ui.empty(text, actionHtml)`, `App.ui.skeleton(rows)`, `App.ui.error(err, retryAct)`, `App.ui.seg(name, options[{value,label}], value)`,
  `App.ui.tabs(name, items[{value,label,count}], value)`, `App.ui.table({cols:[{key,label,num?,width?,render?}], rows, rowHref?, empty})`,
  `App.ui.field({label, html, hint, required, id})`, `App.ui.select(id, options, value, attrs)`, `App.ui.input(id, value, attrs)`,
  `App.icon(name, size=16)` (선 아이콘 SVG: home, inbox, send, check, x, alert, chart, file, folder, users, user, settings, search, plus, edit,
  trash, download, upload, print, link, copy, bell, calendar, clock, shield, flame, helmet, list, grid, filter, chevron-right, chevron-left,
  chevron-down, more, logout, refresh, eye, lock, camera, pen, mail, building, clipboard, sun, thermometer, stop, flag, book, siren, external),
  `App.toast(msg, tone)`, `App.dialog({title, body, actions:[{label, kind, act, onClick}], wide, onOpen})` → {el, close},
  `App.confirm(msg, {ok, danger})` → Promise<bool>, `App.promptText({title, label, value, multiline, placeholder})` → Promise<string|null>,
  `App.menu(anchorEl, [{label, icon, onClick, danger}])`, `App.download(name, data, mime)`, `App.copy(text)`.
- 이벤트 위임: 문서 전체 click 에서 `[data-href]` → App.go, `[data-act]` → `App.actions[name](el, ev)`. 각 모듈은
  `Object.assign(App.actions, {...})` 로 자기 액션을 등록(이름에 모듈 접두사: `hq.`, `an.`, `st.`, `fe.`, `core.`). `[data-seg]`/`[data-tab]` 클릭은
  `App.actions[name]` 대신 `change` 커스텀 이벤트를 그 엘리먼트에 쏜다(`el.dispatchEvent(new CustomEvent('seg', {bubbles:true, detail:{name, value}}))`).
- 로그인 화면(ui-core): 본사 로그인(아이디·비밀번호, "구글 계정으로" 버튼), 사업장 링크로 들어오면(BOOT.s) 사업장 이름 확인 + 작성자 이름(+PIN) 입력.
  토큰은 localStorage `hds.token`, 사업장 토큰 `hds.siteToken`, 작성자 이름 `hds.name`. 미리보기에서도 동일.

### 7.2 JsEngine 이 제공 (engine-a: 로직·편집기 / engine-b: 읽기·인쇄·엑셀·목록양식)
`App.engine`:
- 로직(engine-a): `computeAll(def, rec)`, `calcValue(...)`, `validate(def, rec, uptoStage)` → [{sec,id,msg}], `actsFromRecord(def, rec)` → [actCandidate],
  `factsOf(def, rec)`, `periodKeyOf(def, rec)`, `showOk(cond, data, site)`, `summaryOf(def, rec)` → [{label,value}], `newRecord(def, site, opts)`,
  `autofill(def, rec, {seed, badRate, tableRows})` (프로토타입 이식, 데모용), `schedStatus(def, siteId, refDate?)` (프로토타입 이식, index 기반),
  `expectedFor(siteId, periodType, refDate)` → 필수 양식·기간 목록, `hecCell(item, site)`, `hecReady(site)`, `mockScore(site)`.
- 편집기(engine-a): 화면 `edit/<id>`, `new/<form>/<site>?req=<requestId>` 등록. 단계 탭, 섹션별 입력, 표(행 추가·삭제·라이브러리 불러오기),
  체크리스트(양호·주의·불량·해당없음 큰 터치 버튼, 비고, 사진), 사진(카메라·앨범, 압축 업로드), 서명(캔버스 손서명 + "종이 서명지 별첨"),
  사람 선택(person/people: App.peopleOf), ref(다른 기록 연결), 계산 필드 실시간, 검증 메시지(필드 옆 + 상단 요약), 자동 임시저장(입력 후 3초,
  records.save), 제출(records.submit, acts 후보 포함, facts·period 포함), 반려 사유 표시, 확인된 기록은 읽기 전용. 휴대폰 우선.
- 읽기·인쇄(engine-b): 화면 `rec/<id>`(기록 상세: 요약, 섹션별 값, 사진, 서명, 연결 조치, 이력, 본사면 [확인][반려] 버튼 → records.review),
  `forms`(표준 양식 목록: 양식별 카드 대신 목록 행 — 번호·이름·주기·문서번호·버전·용도, 새로 쓰기, 빈 양식 인쇄, 미리보기),
  `App.engine.printRecords(ids)` / `App.engine.printBlank(code)` (A4 공문 양식: 상단 HDS 워드마크·문서번호·결재란(def.approvals), 표 레이아웃,
  @media print), `App.engine.renderRecordBody(rec)` → Promise<HTML 문자열>(검토함 미리보기·상세 공용 본문), `App.engine.xlsx(sheets)` → Blob (프로토타입 XLSX 모듈 이식: `[{name, rows:[[…]], cols?}]`), `App.engine.valueText(f, v)`.

### 7.3 JsHq (hq-a / hq-b) — 본사 화면
- hq-a: `home`(종합 현황), `collect`(취합 현황판 — 시그니처), `requests`, `requests/new`, `requests/<id>`, `review`(검토함).
- hq-b: `records`(기록 조회·필터·검색·엑셀/시트 내보내기·일괄 인쇄), `acts`, `acts/<id>`, `sites`, `sites/<id>`(정보·링크·QR·PIN·인원·필수양식),
  `users`, `settings`(회사·메일·독촉·필수양식 기본값·예시 데이터·뷰 재구축·트리거·시스템 정보·비밀번호 변경), `search?q=`.
### 7.4 JsAnalytics (analytics-a / analytics-b)
- analytics-a: JsCharts.html(Charts) 전부 + `analytics`(개요), `analytics/incidents`(재해·아차·작업중지·위반), `analytics/risk`(위험성평가).
- analytics-b: `analytics/daily`(일일점검), `analytics/edu`(교육·비상훈련), `analytics/acts`(조치 이행), `analytics/hec`(HEC 준비도·모의점수),
  `analytics/sites`(사업장 비교·스코어카드), `analytics/form/<code>`(양식별 자동 분석: facts 기반 모든 select/number 분포·추이),
  `App.analytics.insights(scope)` → [문장](규칙 기반 발견), 분석 보고서 인쇄.
  공통 필터 바(기간·사업장)는 analytics-a 가 `App.analytics.filterBar(state)` / `App.analytics.scope()` 로 제공, analytics-b 가 사용.
### 7.5 JsSite (site) — 사업장(휴대폰 우선)
`home`(오늘 할 일: 받은 요청·정기 마감·반려된 기록·내 미결 조치, 큰 "오늘 일일점검" 버튼과 "사고·아차 보고" 버튼),
`inbox`(받은 요청·공지, 열람 표시 reads.mark, 첨부 내려받기), `records`(우리 사업장 기록), `acts`(우리 조치: 조치중/완료 전환, 사진),
`site`(사업장 정보·인원 명부 관리). 양식 작성은 engine 화면(`new/…`, `edit/…`)으로 이동.
같은 경로 이름(home, records, acts)이라도 사업장 세션이면 JsSite 의 것이 쓰인다: 등록 이름은 `site:home` 처럼 접두사를 붙이고
App.route 가 세션 종류에 따라 `hq:` 또는 `site:` 를 먼저 찾고 없으면 접두사 없는 이름(공용: edit, new, rec, forms)을 찾는다.
본사 화면 등록 이름은 `hq:home`, `hq:records` …, 분석은 `hq:analytics`, `hq:analytics/incidents` 처럼 첫 두 조각까지.
### 7.6 JsDemo (demo)
`App.demo.build({sites:12, days:90})` → `{sites, people, records, acts, requests, reads}` (엔진 autofill·computeAll·factsOf·actsFromRecord 사용,
현실적인 한국 사업장명·고객사·인원명, 사고·아차·위반·작업중지·교육·훈련·HEC 점검·폭염 점검 포함, 계절성(폭염 6~9월), 사업장마다 성향 차이,
제출 지연·미제출·반려 사례 포함). `App.demo.load()` = build 후 `admin.importBulk {replace:true}` → App.refresh.

## 8. 화면 목록과 각 화면의 질문 (taste app-screens §2.2)

본사 내비 순서(그룹): [현황] 종합 현황 home · 취합 현황 collect · 검토함 review(건수) · 배포·요청 requests / [기록] 양식 forms · 기록 조회 records · 조치대장 acts(기한경과 건수) /
[분석] 분석 analytics / [관리] 사업장 sites · 사용자 users(admin) · 설정 settings(admin). 사이드바 맨 위: HDS 마크+“안전장부”, 범위 표시(“안전경영지원실 · 사업장 12곳”), 맨 아래: 사용자 행(이름·역할·로그아웃).

| 화면 | 한 질문 | 가장 큰 것 |
|---|---|---|
| home | 오늘 손봐야 할 사업장·건은 무엇인가 | 오늘의 예외 목록 + 이번 달 취합 현황 미니 매트릭스 |
| collect | 이번 기간 누가 무엇을 안 냈나 | 사업장 × 양식 현황판(시그니처) |
| review | 무엇을 확인/반려해야 하나 | 제출 대기 목록(왼쪽) + 선택한 기록 미리보기(오른쪽) |
| requests | 보낸 요청이 얼마나 돌아왔나 | 요청별 회수율 막대 + 미회수 사업장 |
| acts | 기한이 지났거나 다가오는 조치는 | 조치 목록(기한순) + 경과 분포 |
| analytics | 사고·위험이 어디서 늘고 있나 | 월별 사고·아차 추이 + 발견 문장 |
| site home | 오늘 무엇을 내야 하나 | 할 일 목록(마감순) + 큰 두 버튼 |

시그니처 요소: **취합 현황판** — 행=사업장, 열=양식(기간별), 칸=상태 기호. 상태마다 고유 표시:
제출(기한 내)=네이비 채움 사각, 지연 제출=네이비 테두리+안 채움 점, 확인 완료=네이비 채움+흰 체크, 작성중/단계보고=반쯤 채움,
반려=빨강 테두리, 기한경과 미제출=빨강 사선 해칭, 마감 전 미제출=회색 테두리 빈칸, 해당없음=회색 대시. 범례는 표시 그대로 축소해 머리말에.
칸을 누르면 그 기록(또는 그 사업장·양식으로 새 기록/독촉 메뉴). 열 머리 = 양식 짧은 이름 + 회수율 %, 행 끝 = 사업장 제출률.

## 9. 디자인 시스템 (Css.html, ui-css) — taste-skill app screens + HDS CI

스타일: **framed-sheet**(B2B 분석·관리): 사이드바와 48px 상단바가 한 색조 프레임(L자), 작업 화면은 흰 시트(오른쪽·아래 8px 띄움,
모서리 16px, 1px 테두리, 그림자 없음). 휴대폰: 프레임 사라지고 시트가 화면, 48px 상단바(메뉴·제목·한 동작) — 사업장은 하단 탭바 4~5개.

토큰(정본):
```
--chrome:#f3f4f8;  --ground:#f3f4f8;  --surface:#ffffff;  --raised:#f6f7fa;  --active:#e7e9f1;
--border:#e4e6ee;  --rule:#eef0f5;  --control:#cbcfdb;
--text:#14183c;  --muted:#555a75;  --faint:#676b84;            /* 모두 흰 바탕 4.5:1 이상 */
--primary:#14183c; --primary-ink:#ffffff;                      /* 주 버튼은 거의 검정에 가까운 네이비 잉크 */
--brand:#223189;  --brand-red:#e03024;                          /* 브랜드: 워드마크·로그인 면에만 */
--chart-1:#223189; --chart-2:#8b90a7; --chart-3:#b7791f; --chart-4:#4e8a7a; --chart-muted:#c9ccd8; --chart-mark:#14183c;
--accent:#223189;                                               /* 데이터·선택 표시 한 곳 */
--positive:#1e7b4f; --negative:#c8281d; --warning:#92400e;
--pill-pos-bg:#dcfae5; --pill-pos-ink:#04250e; --pill-neg-bg:#ffedea; --pill-neg-ink:#831c1e;
--pill-warn-bg:#fffbeb; --pill-warn-ink:#92400e; --pill-neu-bg:#eceef4; --pill-neu-ink:#353a52; --pill-acc-bg:#e8ebf8; --pill-acc-ink:#1c2768;
--grid:#e6e8ef; --axis-ink:#676b84; --chart-span:.06;
--radius-sheet:16px; --radius-card:8px; --radius-control:6px; --radius-chip:4px;
--gap:24px; --pad:24px; --card-pad:20px; --control-h:32px; --row-h:48px; --side-w:228px; --top-h:48px;
--font:"Pretendard Variable","Pretendard",-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;
--font-brand:"Paperlogy","Pretendard Variable","Pretendard",sans-serif;   /* 워드마크·h1 만 */
--fs-title:22px; --fs-section:16px; --fs-kpi:28px; --fs-body:14px; --fs-small:12px;
```
폰트: Pretendard(CDN `https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css`),
Paperlogy 7Bold(`https://cdn.jsdelivr.net/gh/projectnoonnu/2408-3@1.0/Paperlogy-7Bold.woff2`, @font-face family "Paperlogy" 700). 미리보기는 로컬 폰트를 인라인.
숫자는 `font-variant-numeric: tabular-nums` (.num). 표의 숫자 열 오른쪽 정렬.

규칙(어기면 감사에서 떨어짐):
- 색은 데이터와 상태, 주 동작 하나에만. 크롬(사이드바·상단바·탭)에 브랜드 채움 금지. 활성 내비 = 회색 알약(--active), 글자색 그대로.
- KPI 는 타일이 아니라 숫자: 한 컨테이너를 1px 구분선으로 나눈 줄(`.kpis`), 라벨 위·값 아래, 아이콘·스파크라인 금지. 값 28px 400~600.
- 카드 그림자 금지(떠 있는 메뉴·대화상자만 그림자). 그라데이션·글래스(backdrop-blur)·글로우·이모지 금지.
- 아이콘 16px 선 아이콘 회색, 색 원/사각 안에 넣지 않기.
- 표: 줄무늬·머리 띠 금지, 머리글 12px 회색 문장형(대문자 자간 금지), 행 구분선 1px --rule, 숫자 오른쪽 tabular.
- 상태 알약: 연한 바탕 + 같은 색 진한 글자, 16~22px 높이, 11px 이상.
- 차트: 한 차트 한 색(주 데이터에 --chart-1), 격자 3~5개 연하게, y축선 없음, 막대 각진 모서리, 선 2px 직선, 단일 계열 범례 없음.
- 제목 h1 22px(--font-brand, 700), 화면마다 h1 하나. 그 아래 회색 한 문장 = 그 화면의 발견(데이터 문장)이지 사용법 설명 아님.
- 0은 0으로, 없는 값은 회색 대시 '—'. 빈 섹션도 머리와 틀 유지 + 한 문장.
- 로딩: 실제 레이아웃 그대로 회색 막대(쉬머 금지). 오류: 해당 블록 안에 한 문장 + 다시 시도.
- 휴대폰(≤640px): 사이드바 접힘(상단바 메뉴 → 전체 화면 시트), 터치 44px 이상, 표는 두 줄 목록으로, 페이지 가로 스크롤 금지.
- 로그인 화면만 예외로 브랜드 면: 왼쪽(데스크톱) 네이비 #1c2a78 평면 + 빨간 곡선(CI 스우시, 브랜드 자산) + 워드마크, 오른쪽 흰 폼. 휴대폰은 위아래.
- 간격 4px 단위, 한 화면 한 거터(24px). 같은 줄 카드는 아래 끝 맞춤.
- 문구: 업계 말(“미제출”, “기한경과”, “확인 대기”, “반려”, “1단계 보고”), 일반명사(“항목”, “데이터”) 피하기. 존댓말 짧게.

## 10. 미리보기·시험 (harness)

- `node dev/build-preview.mjs` → `dist/preview.html`: Index.html 의 include·BOOT 를 풀고, `dev/gas-mock.js` + 모든 `gas/*.gs` 를
  `(function(){ …gs 전부… ; return { api, setup, cronDaily, cronWeekly }; })()` 로 감싼 서버를 `window.__server` 로 넣고,
  `window.google.script.run` 가짜(비동기 setTimeout 20~120ms, JSON 왕복)를 넣는다. 모의 DB 는 localStorage `hds-preview-db` 에 저장.
  처음 열면 자동 `setup()` + 관리자 `admin` / 비밀번호 `hds1234`(미리보기 전용). URL 해시 `#demo` 또는 쿼리 `?demo=1` 이면 자동 로그인 + 데이터 없을 때 `App.demo.load()`.
  `?s=<token>` 쿼리는 BOOT.s 로. 폰트는 `../fonts/PretendardVariable.woff2` 를 base64 로 인라인(있으면), Paperlogy 는 vendor 에 있으면 인라인.
- `node dev/test/server.test.mjs`: Node vm 에 gas-mock + gas/*.gs 를 올려 시나리오 시험(setup→login→사업장→기록 저장·제출·반려·재제출·확인→조치 전환→요청·독촉 메일 포착→export→권한 위반 거부). 실패 시 종료코드 1.
- `node dev/test/e2e.mjs`: Playwright(Chromium 설치돼 있음, `require('playwright')`) 로 dist/preview.html 을 열고 데모 로드, 모든 본사 화면·사업장 화면을
  1440/768/390 폭으로 열어 콘솔 오류 0, 스크린샷 `dev/shots/*.png`, 핵심 흐름(사업장 일일점검 작성·제출 → 본사 검토 확인) 통과.

## 11. 완료 기준

- 서버 시험·E2E 통과, 콘솔 오류 0, 모든 화면이 데모 데이터로 의미 있게 채워짐, 휴대폰 390px 에서 가로 스크롤 없음.
- README 만으로 처음 쓰는 사람이 배포 가능(스크립트 만들기 → 파일 붙여넣기 또는 clasp push → setup 실행 → 웹앱 배포(실행: 나, 액세스: 모든 사용자) → 관리자 로그인 → 사업장 등록 → 링크 전달).

## 12. 구글 앱스 스크립트 "복붙" 배포 (최우선 요구)

고객은 빌드 도구 없이 script.google.com 편집기에 **복사·붙여넣기**로 설치한다. 그래서:
- `gas/` 의 모든 파일은 그대로 붙여넣어 동작해야 한다: ES 모듈(import/export)·번들러·npm 의존성·TypeScript 금지. 외부 리소스는 CDN 링크만.
- 같은 프로젝트 안 여러 파일이 하나의 전역 범위를 공유하므로, 파일 순서와 상관없이 동작해야 한다(top-level 에서 다른 파일의 객체를 즉시 호출하지 않기 — 함수 안에서만 참조).
- HTML 파일 안 JS/CSS 에 `<?` 나 `?>` 문자열이 나오면 안 된다(HtmlService 템플릿이 스크립틀릿으로 오해). include 되는 파일은 템플릿 처리되지 않지만 Index.html 은 처리된다.
- `node dev/build-paste.mjs` → `paste/` 폴더(커밋함): 붙여넣기 파일 최소화 묶음
  - `paste/Code.gs` = gas/*.gs 전부(Config.gs 먼저, 나머지 이름순)를 파일별 머리 주석과 함께 이어붙인 한 파일
  - `paste/Index.html` = gas/Index.html 그대로(include 이름을 아래 4개로 맞춤)
  - `paste/Styles.html` = Css + CssEngine + CssViews 를 하나로
  - `paste/App.html` = JsCharts + JsCore + JsEngine, `paste/App2.html` = JsDemo + JsHq, `paste/App3.html` = JsAnalytics + JsSite (파일당 500KB 이하)
  - `paste/FormsData.html` = gas/FormsData.html 그대로(서버 Db.forms() 가 이 이름으로 읽음)
  - `paste/appsscript.json`
  - `paste/붙여넣기-안내.txt` = 편집기에서 만들 파일 이름 6개와 순서, setup 실행, 배포 설정 (짧게)
  즉 붙여넣기 묶음에서는 Index.html 의 include 가 FormsData, Styles, App, App2, App3 다섯 개가 되도록 빌드가 바꿔 쓴다.
- README 의 첫 배포 절차는 이 `paste/` 8개 파일 붙여넣기 기준으로 쓴다(clasp 는 선택 사항).
