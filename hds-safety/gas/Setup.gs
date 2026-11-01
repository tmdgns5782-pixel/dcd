/**
 * Setup.gs — 설치(setup), 테이블 보장(ensureSchema), 트리거 설치(installTriggers). SPEC §4.
 *
 * 전역으로 내놓는 것: setup(opts), ensureSchema(), installTriggers() (편집기용, 소유자 실행만 동작)
 *  + 내부용 ownerRun_(), ensureSchema_(), installTriggers_() (이름이 _ 로 끝나 웹앱에서 부를 수 없음).
 * 스크립트 편집기에서 함수 목록의 setup 을 골라 [실행] 하면 된다(인자 없이도 동작). 여러 번 실행해도 안전(idempotent).
 *
 * setup 이 하는 일
 *  1) DB 스프레드시트(APP.dbName)와 드라이브 폴더(APP.folderName)를 만들고 스크립트 속성 DB_ID·FOLDER_ID 에 저장(있으면 재사용).
 *  2) SCHEMA 의 모든 테이블 시트를 만들고 빠진 열을 채운다. 새 스프레드시트의 기본 '시트1' 은 지운다.
 *  3) kv 'settings' 가 없으면 DEFAULT_SETTINGS 저장.
 *  4) 사용자가 하나도 없으면 관리자 admin 계정 생성 — 비밀번호는 opts.adminPassword 또는 임의 10자(실행 로그에 크게 출력).
 *  5) 매일·매주 알림 트리거 설치(opts.triggers === false 면 건너뜀).
 * 반환 { dbUrl, folderUrl, admin:'admin', password(임의로 만들었을 때만), triggers }
 *
 * 보호: 전역 함수는 웹앱 방문자도 google.script.run 으로 부를 수 있다(이름이 _ 로 끝나는 함수만 막힘).
 * 그래서 setup·ensureSchema·installTriggers 는 '소유자 실행'(ownerRun_)일 때만 일한다.
 *  - 설치 뒤 다른 사람이 부르면 아무것도 하지 않고 {already:true} 만 돌려준다(주소·비밀번호 없음).
 *  - 설치 전 다른 사람이 부르면 거부한다(남이 먼저 관리자 비밀번호를 정하지 못하게).
 *  - 소유자 신원을 읽지 못하는 특수한 환경이면 스크립트 속성 ALLOW_SETUP=1 을 잠깐 넣고 실행한 뒤 지운다.
 * 웹앱의 [설정 > 트리거 설치](admin.installTriggers)는 관리자 로그인을 거쳐 installTriggers_ 를 직접 부른다.
 */
function setup(opts) {
  // 편집기·트리거에서 부르면 이벤트 객체가 들어올 수 있다 — 평범한 설정 객체만 받는다.
  opts = (opts && typeof opts === 'object' && !Array.isArray(opts) && !opts.triggerUid && !opts.authMode) ? opts : {};
  var props = PropertiesService.getScriptProperties();
  if (!ownerRun_()) {
    if (props.getProperty('DB_ID')) return { already: true };
    throw new Error('setup 은 스크립트 편집기에서 소유자가 실행해야 합니다');
  }

  var out = Db.withLock(function () {
    var created = false;

    // 1) DB 스프레드시트
    var ss = null;
    var dbId = props.getProperty('DB_ID');
    if (dbId) {
      try { ss = SpreadsheetApp.openById(dbId); } catch (e) { ss = null; console.warn('저장된 DB_ID 로 열 수 없어 새로 만듭니다: ' + (e && e.message)); }
    }
    if (!ss) {
      ss = SpreadsheetApp.create(APP.dbName);
      props.setProperty('DB_ID', ss.getId());
      created = true;
    }

    // 2) 드라이브 폴더
    var folder = null;
    var folderId = props.getProperty('FOLDER_ID');
    if (folderId) {
      try { folder = DriveApp.getFolderById(folderId); } catch (e) { folder = null; console.warn('저장된 FOLDER_ID 로 열 수 없어 새로 만듭니다: ' + (e && e.message)); }
    }
    if (!folder) {
      folder = DriveApp.createFolder(APP.folderName);
      props.setProperty('FOLDER_ID', folder.getId());
    }
    if (created) {
      // DB 파일도 같은 폴더에 둔다(옮기기가 안 되는 환경이면 그대로).
      try {
        var f = DriveApp.getFileById(ss.getId());
        if (typeof f.moveTo === 'function') f.moveTo(folder);
      } catch (e) { console.warn('DB 파일을 폴더로 옮기지 못했습니다: ' + (e && e.message)); }
    }

    // 3) 테이블
    Db.reset();
    var tables = ensureSchema_();
    dropBlankDefaultSheets(ss, tables);

    // 4) 기본 설정
    if (!Db.kvGet('settings', null)) Db.kvSet('settings', JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));

    // 5) 첫 관리자
    var res = { dbUrl: ss.getUrl(), folderUrl: folder.getUrl(), admin: 'admin' };
    var users = Db.all('users', { fresh: true });
    if (!users.length) {
      var given = String(opts.adminPassword || '');
      var pw = given || Db.randomCode(10);
      var salt = Utilities.getUuid();
      var at = Db.now();
      Db.insert('users', {
        id: 'admin', email: '', name: '관리자', role: 'admin', salt: salt, pwHash: Db.hash(salt, pw),
        active: true, createdAt: at, updatedAt: at, lastLoginAt: ''
      });
      Db.log('system', 'setup', 'admin', '첫 관리자 계정을 만들었습니다');
      if (!given) {
        res.password = pw;
        props.setProperty('INIT_ADMIN_PW_SHOWN', '1');
        Logger.log([
          '',
          '==================================================',
          '  HDS 안전장부 설치가 끝났습니다',
          '  관리자 아이디 : admin',
          '  임시 비밀번호 : ' + pw,
          '  웹앱에 로그인한 뒤 [설정 > 비밀번호 변경]에서 꼭 바꾸세요.',
          '  이 비밀번호는 다시 보여 주지 않습니다.',
          '=================================================='
        ].join('\n'));
      }
    }
    Db.log('system', 'setup', '', created ? '설치: DB 스프레드시트를 새로 만들었습니다' : '설치 점검: 기존 DB 를 그대로 씁니다');
    return res;
  });

  if (opts.triggers !== false) {
    try {
      out.triggers = installTriggers_();
    } catch (e) {
      out.triggers = [];
      console.warn('트리거를 설치하지 못했습니다(관리 화면에서 다시 설치하세요): ' + (e && e.message || e));
    }
  }
  Logger.log('DB 스프레드시트: ' + out.dbUrl);
  Logger.log('파일 폴더: ' + out.folderUrl);
  return out;

  /** 새 스프레드시트가 만든 빈 기본 시트('시트1'·'Sheet1')를 지운다. 테이블 시트가 있을 때만. */
  function dropBlankDefaultSheets(ss, tables) {
    var keep = {};
    (tables || []).forEach(function (t) { keep[t] = 1; });
    ss.getSheets().forEach(function (sh) {
      var n = sh.getName();
      if (keep[n]) return;
      if (!/^(시트|Sheet)\s*\d+$/i.test(n)) return;
      if (sh.getLastRow() > 0 || ss.getSheets().length <= 1) return;
      try { ss.deleteSheet(sh); } catch (e) { console.warn('기본 시트를 지우지 못했습니다: ' + n); }
    });
  }
}

/**
 * 이 실행이 스크립트 소유자 본인인지(편집기 [실행], 소유자가 설치한 트리거).
 * 웹앱은 '나(배포자)로 실행'이라 실행 계정(effective)은 늘 소유자이고, 방문자(active)는 익명이면 빈 값, 다른 구글 계정이면 그 주소다.
 * 실제 GAS 는 userinfo.email 범위가 있어 effective 주소가 늘 있다. 둘 다 비면 신원이 없는 로컬 모의 실행으로 본다.
 * 이름이 _ 로 끝나 google.script.run 으로는 부를 수 없다.
 */
function ownerRun_() {
  try {
    if (PropertiesService.getScriptProperties().getProperty('ALLOW_SETUP') === '1') return true;
  } catch (e) { /* 속성을 못 읽으면 신원으로만 판단 */ }
  var act = '', eff = '';
  try { act = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { act = ''; }
  try { eff = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { eff = ''; }
  if (!eff) return !act;
  return act === eff;
}

/** SCHEMA 의 모든 테이블 시트를 만들고 빠진 열을 끝에 붙인다(소유자 실행만). 반환: 테이블 이름 배열 또는 {already:true}. */
function ensureSchema() {
  if (!ownerRun_()) return { already: true };
  return ensureSchema_();
}

function ensureSchema_() {
  Db.reset();
  var names = Object.keys(SCHEMA);
  names.forEach(function (t) { Db.sheet(t); });
  return names;
}

/**
 * 매일 알림(cronDaily, settings.reminder.hour 시)과 주간 요약(cronWeekly, 월요일 8시) 트리거를 다시 만든다.
 * 함수 본체는 Dispatch.gs 에 있다. 반환 [{fn, type, when}]. 편집기용 전역 — 소유자 실행이 아니면 {already:true} 만.
 */
function installTriggers() {
  if (!ownerRun_()) return { already: true };
  return installTriggers_();
}

/** 트리거 설치 본체(setup·관리자 API 가 부른다). */
function installTriggers_() {
  var hour = 8;
  try {
    var st = Db.settings();
    var h = Number(st && st.reminder && st.reminder.hour);
    if (isFinite(h) && h >= 0 && h <= 23) hour = Math.floor(h);
  } catch (e) {
    console.warn('설정을 읽지 못해 08시로 설치합니다: ' + (e && e.message));
  }
  var mine = { cronDaily: 1, cronWeekly: 1 };
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = typeof t.getHandlerFunction === 'function' ? t.getHandlerFunction() : '';
    if (mine[fn]) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('cronDaily').timeBased().atHour(hour).everyDays(1).create();
  ScriptApp.newTrigger('cronWeekly').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  var hh = (hour < 10 ? '0' : '') + hour;
  try { Db.log('system', 'setup', 'triggers', '알림 트리거 설치: 매일 ' + hh + '시, 매주 월요일 08시'); } catch (e) { /* DB 전이면 기록 생략 */ }
  return [
    { fn: 'cronDaily', type: 'CLOCK', when: '매일 ' + hh + '시' },
    { fn: 'cronWeekly', type: 'CLOCK', when: '매주 월요일 08시' }
  ];
}
