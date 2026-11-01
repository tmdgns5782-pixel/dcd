/**
 * HDS 안전장부 — 서버 코드 (Code.gs) · 버전 1.0.0
 * 이 파일은 dev/build-paste.mjs 가 gas/*.gs 를 이어 붙여 만든 것입니다. 고칠 때는 gas/ 원본을 고치고 다시 만드세요.
 * 원본 순서: Config.gs, Api.gs, Auth.gs, Db.gs, Dispatch.gs, Export.gs, Main.gs, Setup.gs, Views.gs
 * 편집기에서 처음 한 번 함수 목록의 setup 을 골라 [실행] 하세요(실행 로그에 관리자 임시 비밀번호가 나옵니다).
 */


/* ======================================================================
 * Config.gs
 * ==================================================================== */

/**
 * HDS 안전장부 — 상수와 테이블 스키마 (SPEC.md §5 의 정본).
 * 열 타입: s=문자열, b=불리언, n=숫자, j=JSON(배열·객체). chunk:N 이면 큰 JSON 을 col, col_2 … col_N 열에 나눠 저장.
 */
var APP = {
  name: 'HDS 안전장부',
  version: '1.0.0',
  dbName: 'HDS 안전장부 DB',
  folderName: 'HDS 안전장부 파일',
  tz: 'Asia/Seoul',
  chunkSize: 45000,
  hqSessionDays: 14,
  siteSessionDays: 30,
  lockMs: 20000,
  maxFileBytes: 8 * 1024 * 1024
};

var SCHEMA = {
  sites: { key: 'id', cols: [
    ['id','s'],['name','s'],['type','s'],['region','s'],['client','s'],['address','s'],['tags','j'],['shifts','j'],['forms','j'],
    ['openDate','s'],['status','s'],['hec','b'],['hecLastEval','s'],['hecNextEval','s'],['headcount','n'],
    ['managerName','s'],['managerEmail','s'],['managerPhone','s'],['token','s'],['pinHash','s'],['pinSalt','s'],['memo','s'],
    ['createdAt','s'],['updatedAt','s']
  ]},
  people: { key: 'id', cols: [
    ['id','s'],['site','s'],['name','s'],['job','s'],['role','s'],['phone4','s'],['active','b'],['createdAt','s'],['updatedAt','s']
  ]},
  users: { key: 'id', cols: [
    ['id','s'],['email','s'],['name','s'],['role','s'],['salt','s'],['pwHash','s'],['active','b'],['createdAt','s'],['updatedAt','s'],['lastLoginAt','s']
  ]},
  sessions: { key: 'token', cols: [
    ['token','s'],['kind','s'],['uid','s'],['site','s'],['name','s'],['role','s'],['createdAt','s'],['expiresAt','s']
  ]},
  records: { key: 'id', cols: [
    ['id','s'],['form','s'],['formVersion','s'],['site','s'],['date','s'],['period','s'],['shift','s'],['status','s'],['stageDone','j'],
    ['author','s'],['rev','n'],['createdBy','s'],['requestId','s'],['createdAt','s'],['updatedAt','s'],['submittedAt','s'],
    ['confirmedAt','s'],['confirmedBy','s'],['returnedAt','s'],['returnedBy','s'],['returnNote','s'],['deleted','b'],['deletedReason','s'],
    ['facts','j',{chunk:2}],['data','j',{chunk:8}]
  ]},
  acts: { key: 'id', cols: [
    ['id','s'],['key','s'],['site','s'],['srcId','s'],['srcForm','s'],['srcItem','s'],['title','s'],['detail','s'],['level','s'],['type','s'],
    ['due','s'],['owner','s'],['status','s'],['photoBefore','s'],['photoAfter','s'],['doneAt','s'],['doneBy','s'],['doneNote','s'],
    ['confirmedAt','s'],['confirmedBy','s'],['history','j'],['createdAt','s'],['updatedAt','s'],['deleted','b']
  ]},
  requests: { key: 'id', cols: [
    ['id','s'],['kind','s'],['title','s'],['message','s'],['forms','j'],['sites','j'],['periodKey','s'],['openAt','s'],['due','s'],
    ['attachments','j'],['ackRequired','b'],['remind','j'],['status','s'],['createdBy','s'],['createdAt','s'],['updatedAt','s'],['lastRemindAt','s']
  ]},
  reads: { key: 'id', cols: [
    ['id','s'],['refId','s'],['site','s'],['by','s'],['at','s']
  ]},
  files: { key: 'id', cols: [
    ['id','s'],['site','s'],['recordId','s'],['name','s'],['mime','s'],['size','n'],['driveId','s'],['kind','s'],['createdAt','s'],['createdBy','s']
  ]},
  log: { key: null, cols: [
    ['at','s'],['who','s'],['kind','s'],['ref','s'],['text','s']
  ]},
  kv: { key: 'key', cols: [
    ['key','s'],['value','j']
  ]}
};

var DEFAULT_SETTINGS = {
  company: 'HDS(주) 안전경영지원실',
  appName: 'HDS 안전장부',
  mail: { enabled: true, onRequest: true, onReturn: true, onIncident: true, dailyReminder: true, weeklyDigest: true, hqEmails: [] },
  reminder: { beforeDays: [3, 1], overdue: true, hour: 8 },
  dailyDue: '10:00',
  monthlyDueDay: 5,
  requiredForms: { 'default': ['F07', 'F09', 'F01', 'N1', 'N2', 'N4', 'F08B', 'F10B'], seasonal: { F06: [4, 5, 6, 7, 8, 9] } }
};


/* ======================================================================
 * Api.gs
 * ==================================================================== */

/**
 * Api.gs — 클라이언트가 부르는 단 하나의 서버 함수 api(method, payloadJson, token) 와 핸들러. SPEC §6.
 *
 * 응답: JSON 문자열 {"ok":true,"data":…} 또는 {"ok":false,"error":"한국어 문장","code":"AUTH|FORBIDDEN|NOTFOUND|INVALID|CONFLICT|SERVER"}.
 * 메서드 표(METHODS)에 권한(perm)·잠금(lock)·핸들러(fn)를 선언한다.
 *   perm: null(로그인 없이) | 'any' | 'write'(열람 권한 제외) | 'hq' | 'hqWrite' | 'admin' | 'site'
 *   lock: true 면 핸들러 전체를 Db.withLock 안에서 실행한다(쓰기). 메일 등 부수효과는 ctx.after 에 넣어 잠금을 푼 뒤 실행한다.
 * 사업장 세션은 서버가 자기 사업장으로 범위를 좁힌다(다른 사업장을 넣으면 FORBIDDEN + 감사 기록).
 *
 * 전역으로 내놓는 것: api(method, payloadJson, token), Api(내부 도구 — Api.call, Api.METHODS).
 * 다른 파일 객체(Db, Auth, Views, Dispatch, Export, Ai)는 함수 안에서만 참조한다(파일 순서와 무관하게 동작).
 */
function api(method, payloadJson, token) {
  // GAS 는 호출마다 새 실행이지만, 실행이 이어지는 환경(미리보기 등)에서 지난 호출의 메모가 남지 않게 비운다.
  try { Db.reset(); } catch (e) { /* DB 전이면 무시 */ }
  return Api.call(method, payloadJson, token);
}

var Api = (function () {
  'use strict';

  var CODES = ['AUTH', 'FORBIDDEN', 'NOTFOUND', 'INVALID', 'CONFLICT', 'SERVER'];
  var REC_STATUS = ['작성중', '제출', '확인', '반려'];
  var LEVELS = ['높음', '보통', '낮음'];
  var ACT_STATUS = ['등록', '조치중', '완료', '확인', '보류', '고객사 이관'];
  var ACT_OPEN = ['등록', '조치중', '보류'];
  /** 조치 상태 전이(현재 → 갈 수 있는 상태). '확인' → '조치중'(다시 열기)은 본사 관리자·담당자만. */
  var ACT_FLOW = {
    '등록': ['조치중', '완료', '보류', '고객사 이관'],
    '조치중': ['완료', '보류', '고객사 이관', '등록'],
    '완료': ['확인', '조치중'],
    '보류': ['등록', '조치중', '완료', '고객사 이관'],
    '고객사 이관': ['조치중', '완료', '확인', '보류'],
    '확인': ['조치중']
  };
  var FILE_KINDS = ['photo', 'sign', 'attach'];
  var SITE_RE = /^[A-Z0-9]{2,8}$/;
  var USER_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
  var PERIOD_RE = /^(\d{4}|\d{4}-(0[1-9]|1[0-2])|\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])|\d{4}-Q[1-4]|\d{4}-H[12])$/;
  var MAX_PAYLOAD = 40 * 1024 * 1024;
  var MAX_DATA_CHARS = 5 * 1024 * 1024;
  var LIM = { title: 200, memo: 4000, name: 50, short: 30, id: 60 };
  var IMPORT_TABLES = ['sites', 'people', 'records', 'acts', 'requests', 'reads'];
  var REC_INDEX_KEYS = ['id', 'form', 'site', 'date', 'period', 'shift', 'status', 'stageDone', 'author', 'createdBy', 'requestId', 'rev',
    'updatedAt', 'submittedAt', 'confirmedAt', 'returnNote', 'facts'];

  /* ======================================================================
   * 공통 도구
   * ==================================================================== */

  function fail(code, msg) {
    var e = new Error(msg);
    e.code = code;
    throw e;
  }

  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function pick(v, d) { return v === undefined || v === null ? d : v; }

  /** 받침에 맞춘 조사: josa('제목', '은', '는') → '제목은'. 한글이 아니면 앞의 것. */
  function josa(w, a, b) {
    w = String(w);
    var c = w.charCodeAt(w.length - 1);
    if (c >= 0xAC00 && c <= 0xD7A3) return w + (((c - 0xAC00) % 28) ? a : b);
    return w + a;
  }

  /** 문자열 입력 정리·검증. 너무 길면 INVALID. */
  function str(v, max, label, required) {
    if (v === null || v === undefined) v = '';
    if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
    if (typeof v !== 'string') fail('INVALID', josa(label, '이', '가') + ' 올바르지 않습니다');
    v = v.replace(/\u0000/g, '').trim();
    if (required && !v) fail('INVALID', josa(label, '을', '를') + ' 입력하세요');
    if (v.length > max) fail('INVALID', josa(label, '은', '는') + ' ' + max + '자까지 적을 수 있습니다');
    return v;
  }

  /** 길면 자르는 문자열(자동 생성 값용 — 실패시키지 않음). */
  function clip(v, max) {
    if (v === null || v === undefined) return '';
    if (typeof v !== 'string') v = (typeof v === 'number' || typeof v === 'boolean') ? String(v) : '';
    v = v.replace(/\u0000/g, '').trim();
    return v.length > max ? v.slice(0, max) : v;
  }

  function validYmd(s) {
    if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
    var y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    if (m < 1 || m > 12 || d < 1) return false;
    var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return d <= last;
  }

  function ymd(v, label, required) {
    v = str(v, 10, label, required);
    if (!v) return '';
    if (!validYmd(v)) fail('INVALID', josa(label, '이', '가') + ' 날짜 형식(YYYY-MM-DD)에 맞지 않습니다');
    return v;
  }

  function bool(v) {
    return v === true || v === 1 || v === 'Y' || v === 'y' || v === 'true' || v === 'TRUE' || v === '1';
  }

  function int(v, min, max, d) {
    var n = Number(v);
    if (v === '' || v === null || v === undefined || !isFinite(n)) return d;
    n = Math.round(n);
    return Math.max(min, Math.min(max, n));
  }

  function email(v, label) {
    v = str(v, 120, label).toLowerCase();
    if (v && !EMAIL_RE.test(v)) fail('INVALID', josa(label, '이', '가') + ' 이메일 형식에 맞지 않습니다');
    return v;
  }

  function siteCode(v, label) {
    v = str(v, 8, label || '사업장 코드', true).toUpperCase();
    if (!SITE_RE.test(v)) fail('INVALID', '사업장 코드는 영문 대문자·숫자 2~8자로 정하세요 (예: S001)');
    return v;
  }

  function strList(v, maxItems, maxLen, label) {
    if (v === null || v === undefined || v === '') return [];
    if (typeof v === 'string') v = v.split(/[,\n]/);
    if (!Array.isArray(v)) fail('INVALID', josa(label, '이', '가') + ' 올바르지 않습니다');
    var out = [];
    v.forEach(function (x) {
      x = clip(x, maxLen);
      if (x && out.indexOf(x) < 0) out.push(x);
    });
    if (out.length > maxItems) fail('INVALID', josa(label, '은', '는') + ' ' + maxItems + '개까지 넣을 수 있습니다');
    return out;
  }

  function plainObj(v, label, maxChars) {
    if (v === null || v === undefined) return {};
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch (e) { fail('INVALID', josa(label, '이', '가') + ' 올바르지 않습니다'); }
    }
    if (!isObj(v)) fail('INVALID', josa(label, '이', '가') + ' 올바르지 않습니다');
    if (maxChars && JSON.stringify(v).length > maxChars) {
      fail('INVALID', josa(label, '이', '가') + ' 너무 큽니다. 사진·첨부는 파일로 올려 주세요');
    }
    return v;
  }

  function whoOf(me) {
    if (!me) return '(익명)';
    return me.kind === 'site' ? (me.name || '사업장') + ' (' + me.site + ')' : (me.name || me.id);
  }

  function now() { return Db.now(); }
  function today() { return Db.today(); }

  function fd() { return Db.forms() || {}; }
  function codes() { return fd().codes || {}; }
  function formDef(code) {
    var def = code ? Db.form(code) : null;
    if (!def) fail('INVALID', '없는 양식입니다: ' + String(code || '(비어 있음)'));
    return def;
  }
  function formName(def) { return def.short || def.title || def.code; }

  function isHqWriter(me) { return !!me && me.kind === 'hq' && (me.role === 'admin' || me.role === 'hq'); }
  function isAdmin(me) { return !!me && me.kind === 'hq' && me.role === 'admin'; }

  function forbid(me, ref, text, msg) { Auth.forbid(me, ref, text, msg); }

  /** 사업장 세션이면 자기 사업장으로 강제(다른 사업장을 넣으면 거부). 본사면 받은 값 그대로. */
  function scopeSite(me, siteId, ref) {
    siteId = siteId ? String(siteId).trim().toUpperCase() : '';
    if (me.kind === 'site') {
      if (siteId && siteId !== me.site) {
        forbid(me, ref || siteId, '다른 사업장(' + siteId + ') 자료 접근 시도', '우리 사업장 자료만 다룰 수 있습니다');
      }
      return me.site;
    }
    return siteId;
  }

  function needSite(me, siteId, ref) {
    if (!Auth.canSite(me, siteId)) {
      forbid(me, ref || siteId, '다른 사업장(' + siteId + ') 자료 접근 시도', '다른 사업장 자료는 다룰 수 없습니다');
    }
  }

  function getSite(id) {
    var s = id ? Db.get('sites', id) : null;
    if (!s) fail('NOTFOUND', '없는 사업장입니다: ' + (id || '(비어 있음)'));
    return s;
  }

  /** 감사 기록 — 잠금을 푼 뒤에 남긴다. */
  function audit(ctx, kind, ref, text) {
    var who = whoOf(ctx.me);
    ctx.after.push(function () { Db.log(who, kind, ref || '', text || ''); });
  }

  /** 부수효과(메일 등) — 잠금을 푼 뒤 실행, 실패해도 요청은 성공. */
  function later(ctx, label, fn) {
    ctx.after.push(function () {
      try { fn(); } catch (e) { console.warn(label + ' 실패: ' + (e && e.message || e)); }
    });
  }

  /**
   * 뷰 시트 갱신 — 잠금을 푼 뒤(ctx.after) 실행한다. Views 가 시트 만들기는 잠금 밖에서, 행 쓰기만 짧게 잠그고
   * 저장된 최신 기록을 다시 읽어 반영하므로 순서가 뒤바뀌어도 마지막 상태가 남는다. 실패해도 무시(admin.rebuildViews 로 다시 만듦).
   */
  function views(name, arg, ctx) {
    function run() {
      try {
        if (typeof Views !== 'undefined' && Views && typeof Views[name] === 'function') Views[name](arg);
      } catch (e) {
        console.warn('Views.' + name + ' 실패: ' + (e && e.message || e));
      }
    }
    if (ctx && ctx.after) ctx.after.push(run); else run();
  }

  function mod(name) {
    var m = null;
    try {
      if (name === 'Dispatch' && typeof Dispatch !== 'undefined') m = Dispatch;
      else if (name === 'Export' && typeof Export !== 'undefined') m = Export;
      else if (name === 'Views' && typeof Views !== 'undefined') m = Views;
    } catch (e) { m = null; }
    return m;
  }

  function callMod(name, fn, args) {
    var m = mod(name);
    if (!m || typeof m[fn] !== 'function') fail('SERVER', name + '.gs 의 ' + fn + ' 기능이 설치되지 않았습니다. 스크립트 파일을 모두 붙여넣었는지 확인하세요');
    return m[fn].apply(m, args);
  }

  /* ======================================================================
   * 출력 정리
   * ==================================================================== */

  function pubSite(s, me) {
    var o = {};
    Object.keys(s).forEach(function (k) { if (k !== 'pinHash' && k !== 'pinSalt') o[k] = s[k]; });
    o.hasPin = !!s.pinHash;
    var showToken = isAdmin(me) || (me && me.kind === 'site' && me.site === s.id);
    if (!showToken) delete o.token;
    return o;
  }

  function pubUser(u) {
    var o = {};
    Object.keys(u).forEach(function (k) { if (k !== 'salt' && k !== 'pwHash') o[k] = u[k]; });
    return o;
  }

  function pubFile(f) {
    return { id: f.id, site: f.site, recordId: f.recordId, name: f.name, mime: f.mime, size: f.size, kind: f.kind, createdAt: f.createdAt, createdBy: f.createdBy };
  }

  function indexRow(r, me) {
    var o = {};
    REC_INDEX_KEYS.forEach(function (k) { o[k] = r[k] === undefined ? (k === 'stageDone' ? [] : (k === 'facts' ? {} : '')) : r[k]; });
    if (r.deleted) o.deleted = true;
    if (me && me.kind === 'site') {
      var parts = hqParts(r.form);
      if (parts && parts.hasPriv) o.facts = stripFacts(o.facts, parts, true);
    }
    return o;
  }

  /*
   * 본사 전용 단계(hqOnlyStage: FD stage.role==='hq' 또는 담당이 '본사'로 시작)의 칸.
   * - 쓰기: 사업장 세션은 이 칸을 바꿀 수 없다(저장·제출 때 기존 값으로 되돌림).
   * - 읽기: 사업장 세션에는 '비공개' 칸을 내려보내지 않는다 —
   *   본사 전용 단계의 민감 칸(sensitive), 그리고 HQ_PRIVATE_STAGES 의 단계 전체
   *   (F10 작업중지권: 사후관리·D+30 불리한 처우 확인은 본사가 행사자에게 직접 확인하는 내용이라 관리감독자·사업장이 보면 안 된다).
   *   F01 본사 검토·F03 본사 처리처럼 사업장에 돌려주는 회신은 그대로 보인다.
   */
  var HQ_PRIVATE_STAGES = { F10: ['s3', 's4'] };
  var HQ_PARTS = {};
  function hqParts(code) {
    if (!code) return null;
    if (has(HQ_PARTS, code)) return HQ_PARTS[code];
    var def = null;
    try { def = Db.form(code); } catch (e) { def = null; }
    var out = null;
    if (def && Array.isArray(def.stages) && def.stages.length) {
      var secs = {};
      (def.sections || []).forEach(function (s) { if (s && s.id) secs[s.id] = s; });
      var o = { keys: [], fields: [], secs: [], privKeys: [], privFields: [], privSecs: [], hasPriv: false };
      var priv = HQ_PRIVATE_STAGES[def.code] || [];
      def.stages.forEach(function (st) {
        if (!hqOnlyStage(st)) return;
        var whole = priv.indexOf(st.id) >= 0;
        (st.sections || []).forEach(function (sid) {
          var sec = secs[sid];
          if (!sec) return;
          o.secs.push(sid);
          if (whole) o.privSecs.push(sid);
          if (sec.type === 'fields') {
            (sec.fields || []).forEach(function (f) {
              if (!f || !f.id) return;
              o.keys.push(f.id);
              o.fields.push(f.id);
              if (whole || f.sensitive) { o.privKeys.push(f.id); o.privFields.push(f.id); }
            });
          } else {
            o.keys.push(sid, sid + '_paper');
            if (whole) o.privKeys.push(sid, sid + '_paper');
          }
        });
      });
      o.hasPriv = o.privKeys.length > 0;
      if (o.keys.length) out = o;
    }
    HQ_PARTS[code] = out;
    return out;
  }

  /** 조치가 본사 비공개 단계(HQ_PRIVATE_STAGES) 섹션에서 나왔으면 사업장 세션에는 보이지 않는다(예: F10 D+30 불리한 처우 확인). */
  function actVisibleTo(a, me) {
    if (!a || !me || me.kind !== 'site') return true;
    var parts = hqParts(a.srcForm);
    if (!parts || !parts.privSecs.length) return true;
    var sec = String(a.key || '').split('#')[1] || '';
    return parts.privSecs.indexOf(sec) < 0;
  }

  /** facts 에서 본사 전용(priv=true 면 비공개만) 칸·섹션 값을 뺀 사본. */
  function stripFacts(facts, parts, priv) {
    if (!isObj(facts)) return facts;
    var f = clone(facts);
    var fields = priv ? parts.privFields : parts.fields;
    var secs = priv ? parts.privSecs : parts.secs;
    if (isObj(f.v)) fields.forEach(function (id) { delete f.v[id]; delete f.v[id + '#n']; });
    if (isObj(f.t)) secs.forEach(function (sid) { delete f.t[sid]; });
    if (isObj(f.k)) secs.forEach(function (sid) { delete f.k[sid]; });
    return f;
  }

  /** 사업장 세션에 내려보낼 기록(비공개 칸 제외). 본사면 그대로. */
  function recFor(r, me) {
    if (!r || !me || me.kind !== 'site') return r;
    var parts = hqParts(r.form);
    if (!parts || !parts.hasPriv) return r;
    var o = clone(r);
    if (isObj(o.data)) parts.privKeys.forEach(function (k) { delete o.data[k]; });
    o.facts = stripFacts(o.facts, parts, true);
    return o;
  }

  /**
   * 사업장 세션이 보낸 기록: 본사 전용 단계 칸은 기존 값으로 되돌린다(새 값은 무시).
   * facts 도 같은 칸은 기존 값으로(사업장 화면은 그 칸을 모르므로 빠진 채로 계산해 보낸다).
   */
  function keepHqParts(rec, cur, me) {
    if (!me || me.kind !== 'site') return;
    var parts = hqParts(rec.form);
    if (!parts) return;
    var old = (cur && isObj(cur.data)) ? cur.data : {};
    parts.keys.forEach(function (k) {
      if (has(old, k)) rec.data[k] = clone(old[k]); else delete rec.data[k];
    });
    var of = (cur && isObj(cur.facts)) ? cur.facts : {};
    var nf = isObj(rec.facts) ? rec.facts : (rec.facts = {});
    function put(bucket, key) {
      var src = isObj(of[bucket]) ? of[bucket] : {};
      if (has(src, key)) {
        if (!isObj(nf[bucket])) nf[bucket] = {};
        nf[bucket][key] = clone(src[key]);
      } else if (isObj(nf[bucket])) {
        delete nf[bucket][key];
      }
    }
    parts.fields.forEach(function (id) { put('v', id); put('v', id + '#n'); });
    parts.secs.forEach(function (sid) { put('t', sid); put('k', sid); });
  }

  /** 설정에서 비밀 값은 빼고, 사업장 세션에는 본사 수신 메일 목록을 숨긴다. */
  function pubSettings(st, me) {
    var o = clone(st) || {};
    (function strip(x) {
      if (!x || typeof x !== 'object') return;
      Object.keys(x).forEach(function (k) {
        if (/api.?key|secret|password/i.test(k)) delete x[k];
        else strip(x[k]);
      });
    })(o);
    if (me.kind === 'site' && o.mail) delete o.mail.hqEmails;
    return o;
  }

  function appUrl() {
    try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
  }

  function reqVisibleToSite(r, siteId) {
    if (!r || r.status === '취소') return false;
    var ss = Array.isArray(r.sites) ? r.sites : [];
    if (ss.indexOf('*') < 0 && ss.indexOf(siteId) < 0) return false;
    if (r.openAt && String(r.openAt) > now()) return false;
    return true;
  }

  /**
   * 사업장 세션에 내려보낼 요청: 다른 사업장 목록·독촉 이력(=다른 사업장 미제출 여부)·본사 담당자 이름은 뺀다.
   * sites 는 전체 요청이면 ['*'], 아니면 [자기 사업장]. remind.sent 는 자기 사업장 값만.
   */
  function reqForSite(r, siteId) {
    var o = clone(r);
    var ss = Array.isArray(r.sites) ? r.sites : [];
    o.sites = ss.indexOf('*') >= 0 ? ['*'] : [siteId];
    var rm = isObj(r.remind) ? r.remind : {};
    var mine = {};
    if (isObj(rm.sent) && has(rm.sent, siteId)) mine[siteId] = rm.sent[siteId];
    o.remind = { sent: mine };
    if (rm.beforeDays !== undefined) o.remind.beforeDays = rm.beforeDays;
    o.createdBy = '본사';
    delete o.lastRemindAt;
    return o;
  }

  /* ======================================================================
   * 인증
   * ==================================================================== */

  function hAuthStatus(p) {
    return Auth.status({ siteToken: typeof p.siteToken === 'string' ? p.siteToken : '' });
  }
  function hLogin(p) { return Auth.login(p); }
  function hSiteLogin(p) { return Auth.siteLogin(p); }
  function hGoogle() { return Auth.google(); }
  function hLogout(p, me, ctx) {
    Auth.logout(ctx.token);
    audit(ctx, 'logout', me.id, '로그아웃');
    return {};
  }
  function hChangePassword(p, me, ctx) { return Auth.changePassword(me, p, ctx.token); }

  /* ======================================================================
   * boot
   * ==================================================================== */

  function hBoot(p, me) {
    var days = int(p.days, 1, 3650, 400);
    var since = Db.addDays(today(), -days);
    var isSite = me.kind === 'site';
    function mine(siteId) { return !isSite || siteId === me.site; }

    var sites = Db.all('sites').filter(function (s) { return mine(s.id); }).map(function (s) { return pubSite(s, me); });
    var people = Db.all('people').filter(function (x) { return mine(x.site); });
    var users = isAdmin(me) ? Db.all('users').map(pubUser) : [];
    var requests = Db.all('requests').filter(function (r) { return !isSite || reqVisibleToSite(r, me.site); })
      .map(function (r) { return isSite ? reqForSite(r, me.site) : r; });
    var reads = Db.all('reads').filter(function (r) { return mine(r.site); });
    var acts = Db.all('acts').filter(function (a) { return !a.deleted && mine(a.site) && actVisibleTo(a, me); });
    var index = Db.all('records').filter(function (r) {
      if (r.deleted || !mine(r.site)) return false;
      if (r.status === '작성중' || r.status === '반려') return true;
      var d = r.date || String(r.updatedAt || '').slice(0, 10);
      return d >= since;
    }).map(function (r) { return indexRow(r, me); });

    var urls = { app: appUrl() };
    if (me.kind === 'hq') {
      try { urls.sheet = Db.book().getUrl(); } catch (e) { urls.sheet = ''; }
      try { urls.folder = Db.folder().getUrl(); } catch (e) { urls.folder = ''; }
    }
    return {
      me: me,
      settings: pubSettings(Db.settings(), me),
      sites: sites,
      people: people,
      users: users,
      requests: requests,
      reads: reads,
      acts: acts,
      index: index,
      serverTime: now(),
      urls: urls
    };
  }

  /* ======================================================================
   * 기록
   * ==================================================================== */

  function loadRecord(id, me) {
    id = str(id, LIM.id, '기록 번호', true);
    var r = Db.get('records', id);
    if (!r || (r.deleted && me.kind === 'site')) fail('NOTFOUND', '기록을 찾을 수 없습니다: ' + id);
    needSite(me, r.site, id);
    return r;
  }

  function hRecordsIndex(p, me) {
    var from = p.from ? ymd(p.from, '시작일') : '';
    var to = p.to ? ymd(p.to, '종료일') : '';
    var forms = strList(p.forms, 50, 10, '양식');
    var sites = strList(p.sites, 500, 8, '사업장');
    if (me.kind === 'site') sites = [me.site];
    var withDeleted = me.kind === 'hq' && bool(p.deleted);
    return Db.all('records').filter(function (r) {
      if (r.deleted && !withDeleted) return false;
      if (sites.length && sites.indexOf(r.site) < 0) return false;
      if (forms.length && forms.indexOf(r.form) < 0) return false;
      var d = r.date || String(r.updatedAt || '').slice(0, 10);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    }).map(function (r) { return indexRow(r, me); });
  }

  function hRecordsGet(p, me) {
    return recFor(loadRecord(p.id, me), me);
  }

  function hRecordsBulkGet(p, me) {
    var ids = strList(p.ids, 500, LIM.id, '기록 번호 목록');
    var out = [];
    ids.forEach(function (id) {
      var r = Db.get('records', id);
      if (!r || !Auth.canSite(me, r.site) || (r.deleted && me.kind === 'site')) return;
      out.push(recFor(r, me));
    });
    return out;
  }

  /** 기간 키: 클라이언트 값이 형식에 맞으면 그대로, 아니면 서버가 계산(SPEC §5). */
  function periodFor(def, rec, given) {
    var type = (def.frequency && def.frequency.type) || 'event';
    if (typeof given === 'string') {
      given = given.trim();
      if (given === '' && type === 'event') return '';
      if (PERIOD_RE.test(given)) return given;
    }
    var d = rec.date || today();
    if (def.code === 'F09') {
      var rm = rec.data && rec.data.reportMonth;
      if (typeof rm === 'string' && /^\d{4}-(0[1-9]|1[0-2])/.test(rm)) return rm.slice(0, 7);
    }
    var y = d.slice(0, 4), m = Number(d.slice(5, 7));
    switch (type) {
      case 'daily': return d;
      case 'monthly':
      case 'season': return d.slice(0, 7);
      case 'quarterly': return y + '-Q' + Math.ceil(m / 3);
      case 'half': return y + '-H' + (m <= 6 ? 1 : 2);
      case 'annual': return y;
      default: return '';
    }
  }

  /*
   * 한 사업장·한 기간(일일점검은 날짜+근무조)에 보고된 기록은 1건 — 화면 엔진(JsEngine findDup·singlePerPeriod·isReported)과 같은 규칙.
   * 화면 확인창은 그 기기의 색인만 보므로 다른 기기·API 직접 호출로 건너뛸 수 있어 서버가 잠금 안에서 다시 본다.
   *  - 대상: 정기 양식(frequency.type 이 event 아님) 가운데 한 기간 여러 건 양식(multiPerPeriod: '회마다 기록 1건|1회 이상|차수마다')과
   *    수시 추가 작성이 있는 양식(due 에 '수시': 위험성평가 수시평가·폭염 수시 점검)은 뺀다.
   *  - 같은 site·form·period(근무조 양식이면 근무조도. 근무조가 빈 기존 기록은 어느 근무조와도 겹침)의 삭제되지 않은 다른 기록 가운데
   *    이미 보고된 것(제출·확인·반려 또는 단계 보고)이 있으면 그 번호. 없으면 ''.
   */
  function multiPerPeriodSrv(def) {
    var fq = def.frequency || {};
    if (fq.multiPerPeriod !== undefined) return !!fq.multiPerPeriod;
    return /회마다 기록 1건|1회 이상|차수마다/.test(String(fq.due || ''));
  }
  function singlePerPeriodSrv(def) {
    var fq = def.frequency || {};
    if (!fq.type || fq.type === 'event' || multiPerPeriodSrv(def)) return false;
    return !/수시/.test(String(fq.due || ''));
  }
  function reportedRec(r) {
    return !!r && (r.status === '제출' || r.status === '확인' || r.status === '반려' || (Array.isArray(r.stageDone) && r.stageDone.length > 0));
  }
  function reportedDupId(def, rec) {
    if (!singlePerPeriodSrv(def)) return '';
    var shifts = !!(def.frequency && def.frequency.shifts);
    var pk = String(rec.period || '');
    var hit = Db.all('records').filter(function (r) {
      return r && !r.deleted && r.id !== rec.id && r.site === rec.site && r.form === def.code && String(r.period || '') === pk &&
        (!shifts || !r.shift || r.shift === rec.shift) && reportedRec(r);
    })[0];
    return hit ? String(hit.id) : '';
  }

  function emptyRecord(def, site, me) {
    var t = now();
    return {
      id: '', form: def.code, formVersion: def.version || '', site: site, date: '', period: '', shift: '', status: '작성중',
      stageDone: [], author: '', rev: 0, createdBy: me.kind === 'hq' ? 'hq' : 'site', requestId: '', createdAt: t, updatedAt: t,
      submittedAt: '', confirmedAt: '', confirmedBy: '', returnedAt: '', returnedBy: '', returnNote: '', deleted: false, deletedReason: '',
      facts: {}, data: {}
    };
  }

  /**
   * records.save / submit 공통: 받은 기록을 검사하고 저장할 모양으로 합친다. 잠금 안에서 부른다.
   * → { cur(기존 기록|null), rec(저장할 기록), def }
   */
  function prepRecord(p, me) {
    var src = p.record;
    if (!isObj(src)) fail('INVALID', '기록 내용이 없습니다');
    Db.all('records', { fresh: true });

    var id = src.id ? str(src.id, LIM.id, '기록 번호') : '';
    var cur = null;
    if (id) {
      cur = Db.get('records', id);
      if (!cur) fail('NOTFOUND', '기록을 찾을 수 없습니다. 목록을 새로 고친 뒤 다시 여세요: ' + id);
      needSite(me, cur.site, id);
      if (cur.deleted) fail('CONFLICT', '삭제된 기록이라 고칠 수 없습니다');
      if (cur.status === '확인') fail('CONFLICT', '본사가 확인한 기록은 고칠 수 없습니다. 고쳐야 하면 관리자가 먼저 확인을 취소해야 합니다');
      if (src.form && String(src.form) !== cur.form) fail('INVALID', '기록의 양식은 바꿀 수 없습니다');
      if (src.site && String(src.site).toUpperCase() !== cur.site) {
        if (me.kind === 'site') forbid(me, id, '다른 사업장(' + src.site + ')으로 기록 이동 시도', '우리 사업장 기록만 다룰 수 있습니다');
        fail('INVALID', '기록의 사업장은 바꿀 수 없습니다. 새 기록으로 작성하세요');
      }
    }

    var def = formDef(cur ? cur.form : str(src.form, 10, '양식', true));
    var site;
    if (cur) {
      site = cur.site;
    } else {
      site = scopeSite(me, src.site ? str(src.site, 8, '사업장') : '', 'records');
      if (!site) fail('INVALID', '사업장을 고르세요');
      getSite(site);
    }

    var rec = cur ? clone(cur) : emptyRecord(def, site, me);
    rec.date = ymd(pick(src.date, rec.date), '작성일') || rec.date || today();
    rec.shift = str(pick(src.shift, rec.shift), 20, '근무조');
    rec.author = str(pick(src.author, rec.author), LIM.name, '작성자') || rec.author || me.name;
    rec.requestId = str(pick(src.requestId, rec.requestId), 40, '요청 번호');
    if (src.data !== undefined) rec.data = plainObj(src.data, '입력 내용', MAX_DATA_CHARS);
    if (!isObj(rec.data)) rec.data = {};
    if (src.facts !== undefined) rec.facts = plainObj(src.facts, '분석 요약', 400000);
    if (!isObj(rec.facts)) rec.facts = {};
    if (!cur) rec.formVersion = def.version || '';
    keepHqParts(rec, cur, me);
    if (!Array.isArray(rec.stageDone)) rec.stageDone = [];
    rec.period = periodFor(def, rec, src.period);
    rec.updatedAt = now();
    return { cur: cur, rec: rec, def: def };
  }

  /* ----------------------------------------------------------------------
   * 서버 쪽 입력 검사 — 화면 검사(App.engine.validate)를 API 직접 호출로 건너뛰지 못하게 핵심만 다시 본다.
   * 화면보다 엄하지 않게(화면이 통과시키는 기록은 여기서도 통과) 같은 규칙의 부분집합만 쓴다.
   *  - 저장·제출 모두: 숫자·날짜·일시·시각 칸의 값 모양(숫자 칸에 글자, 날짜 칸에 아무 글자 거부).
   *  - 제출만: 필수 칸(보이는 칸만, showIf), 숫자 최소·최대, 표 최소 행·행별 필수 칸, 점검표 판정·사유, 사진 최소 장수.
   *    단계형 양식은 제출하는 단계까지의 섹션만.
   * -------------------------------------------------------------------- */

  var TYPE_RE = {
    date: /^\d{4}-\d{2}-\d{2}$/,
    datetime: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/,
    time: /^\d{2}:\d{2}(:\d{2})?$/
  };
  var NUM_STR = /^-?\d+(\.\d+)?$/;

  function emptyVal(v) { return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0); }
  function numOf(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && NUM_STR.test(v.trim())) return Number(v.trim());
    return null;
  }

  /** 화면 엔진 showOk 와 같은 규칙. tags = 사업장 직무 태그(없으면 모든 항목을 보인다). */
  function showOkSrv(cond, data, tags) {
    if (!cond) return true;
    data = data || {};
    if (cond.siteTag) return !tags.length || tags.indexOf(cond.siteTag) >= 0;
    if (cond.field) {
      var v = data[cond.field];
      var alt = v === true ? '예' : v === false ? '아니오' : v === '예' ? true : v === '아니오' ? false : v;
      if (cond.in) {
        if (Array.isArray(v)) return v.some(function (x) { return cond.in.indexOf(x) >= 0; });
        return cond.in.indexOf(v) >= 0 || cond.in.indexOf(alt) >= 0;
      }
      if (cond.notIn) return Array.isArray(v) ? !v.some(function (x) { return cond.notIn.indexOf(x) >= 0; }) : (cond.notIn.indexOf(v) < 0 && !emptyVal(v));
      var n = (v === '' || v === null || v === undefined || v === true || v === false || isNaN(Number(v))) ? null : Number(v);
      if (cond.gte !== undefined) return n !== null && n >= cond.gte;
      if (cond.lte !== undefined) return n !== null && n <= cond.lte;
      if (cond.eq !== undefined) return v === cond.eq || alt === cond.eq;
      if (cond.notEmpty) return !emptyVal(v);
    }
    return true;
  }

  /** 값 모양 검사(빈 값은 통과). → 오류 문장 또는 '' */
  function typeErr(f, v, where) {
    if (emptyVal(v) || !f || f.type === 'computed') return '';
    var label = where + (f.label || f.id);
    if (f.type === 'number') {
      if (numOf(v) === null) return label + ': 숫자를 입력하세요';
    } else if (TYPE_RE[f.type]) {
      if (typeof v !== 'string' || !TYPE_RE[f.type].test(v)) {
        return label + ': ' + (f.type === 'date' ? '날짜(YYYY-MM-DD)' : f.type === 'time' ? '시각(HH:mm)' : '일시(YYYY-MM-DDTHH:mm)') + ' 형식이 아닙니다';
      }
    }
    return '';
  }

  /** 제출 때 칸 하나 검사(필수·숫자 범위). */
  function fieldErrs(f, v, where, out) {
    if (!f || !f.id) return;
    var label = where + (f.label || f.id);
    var te = typeErr(f, v, where);
    if (te) { out.push(te); return; }
    if (f.type !== 'computed' && f.required && emptyVal(v)) { out.push(label + ': 필수 입력입니다'); return; }
    if (f.type === 'number' && !emptyVal(v)) {
      var n = numOf(v);
      if (f.min !== undefined && f.min !== null && n < f.min) out.push(label + ': ' + f.min + ' 이상이어야 합니다');
      if (f.max !== undefined && f.max !== null && n > f.max) out.push(label + ': ' + f.max + ' 이하여야 합니다');
    }
  }

  /**
   * 기록 검사. submitIdx: 제출이면 단계 번호(단계 없는 양식은 0), 임시저장이면 -1(값 모양만).
   * → 오류 문장 배열
   */
  function recordErrs(def, rec, submitIdx, me, prev) {
    var out = [];
    var d = isObj(rec.data) ? rec.data : {};
    var submit = submitIdx >= 0;
    // 임시저장은 이번에 바뀐 값만 모양을 본다(예전에 저장된 값 때문에 자동 저장이 막히지 않게). 제출은 전부.
    var pd = !submit && prev && isObj(prev.data) ? prev.data : null;
    function same(k) { return !!pd && JSON.stringify(pd[k]) === JSON.stringify(d[k]); }
    var site = null;
    try { site = Db.get('sites', rec.site); } catch (e) { site = null; }
    var tags = site && Array.isArray(site.tags) ? site.tags : [];
    var secStage = {};
    (def.stages || []).forEach(function (st, i) { (st.sections || []).forEach(function (sid) { if (secStage[sid] === undefined) secStage[sid] = i; }); });
    var hq = me && me.kind === 'site' ? hqParts(def.code) : null;
    function inScope(s) {
      if (!submit) return false;
      if (hq && hq.secs.indexOf(s.id) >= 0) return false;
      return !def.stages || (secStage[s.id] || 0) <= submitIdx;
    }
    if (submit) {
      if (!String(rec.author || '').trim()) out.push('작성자: 필수 입력입니다');
      if (def.frequency && def.frequency.shifts && !rec.shift) out.push('근무조: 고르세요');
    }
    (def.header || []).forEach(function (f) {
      if (!f || !f.id) return;
      if (submit) { if (showOkSrv(f.showIf, d, tags)) fieldErrs(f, d[f.id], '', out); }
      else if (!same(f.id)) { var e0 = typeErr(f, d[f.id], ''); if (e0) out.push(e0); }
    });
    (def.sections || []).forEach(function (s) {
      if (!s || !s.id) return;
      var scope = inScope(s);
      var title = (s.title || '') ? s.title + ' ' : '';
      if (s.type === 'fields') {
        (s.fields || []).forEach(function (f) {
          if (!f || !f.id) return;
          if (scope && showOkSrv(f.showIf, d, tags)) fieldErrs(f, d[f.id], '', out);
          else if (submit || !same(f.id)) { var e1 = typeErr(f, d[f.id], ''); if (e1) out.push(e1); }
        });
      } else if (s.type === 'table') {
        var rows = Array.isArray(d[s.id]) ? d[s.id] : [];
        if (scope && (s.minRows || 0) > rows.length) out.push((s.title || '표') + ': ' + s.minRows + '행 이상 입력하세요');
        if (!submit && same(s.id)) return;
        rows.forEach(function (row, i) {
          if (!isObj(row)) return;
          (s.columns || []).forEach(function (c) {
            var where = (s.title || '표') + ' ' + (i + 1) + '행 ';
            if (scope) fieldErrs(c, row[c.id], where, out);
            else { var e2 = typeErr(c, row[c.id], where); if (e2) out.push(e2); }
          });
        });
      } else if (s.type === 'checklist' && scope) {
        var got = isObj(d[s.id]) ? d[s.id] : {};
        (s.items || []).forEach(function (it) {
          if (!it || !it.code || !showOkSrv(it.showIf, d, tags)) return;
          var x = got[it.code];
          if (!isObj(x) || !x.r) out.push(title + it.code + ': 판정을 고르세요');
          else if ((s.noteRequiredOn || []).indexOf(x.r) >= 0 && !String(x.note || '').trim()) out.push(title + it.code + ": '" + x.r + "'이면 내용(사유)을 적어야 합니다");
        });
      } else if (s.type === 'photos' && scope) {
        var ph = Array.isArray(d[s.id]) ? d[s.id] : [];
        if ((s.minCount || 0) > ph.length) out.push((s.title || '사진') + ': 사진 ' + s.minCount + '장 이상 필요합니다');
      }
    });
    return out;
  }

  function checkRecord(def, rec, submitIdx, me, prev) {
    var errs = recordErrs(def, rec, submitIdx, me, prev);
    if (!errs.length) return;
    var head = submitIdx >= 0 ? '제출할 수 없습니다. 입력이 빠졌거나 맞지 않는 칸이 ' : '저장할 수 없습니다. 형식이 맞지 않는 칸이 ';
    fail('INVALID', head + errs.length + '곳 있습니다: ' + errs.slice(0, 5).join(' · ') + (errs.length > 5 ? ' 외 ' + (errs.length - 5) + '곳' : ''));
  }

  /** 기록 번호 발급(잠금 안). 본사 대리 입력은 끝이 H1, H2… */
  function newRecordId(def, site, date, me) {
    var head = (def.idPrefix || def.code) + '-' + site + '-' + Db.yymmdd(date) + '-';
    var maxN = 0, maxH = 0;
    Db.all('records').forEach(function (r) {
      var id = String(r.id || '');
      if (id.indexOf(head) !== 0) return;
      var t = id.slice(head.length);
      if (/^H\d+$/.test(t)) maxH = Math.max(maxH, Number(t.slice(1)));
      else if (/^\d+$/.test(t)) maxN = Math.max(maxN, Number(t));
    });
    return me.kind === 'hq' ? head + 'H' + (maxH + 1) : head + pad(maxN + 1, 2);
  }

  function writeRecord(rec, isNew) {
    if (isNew) Db.insert('records', rec);
    else Db.upsert('records', rec);
  }

  function hRecordsSave(p, me, ctx) {
    var x = prepRecord(p, me);
    var rec = x.rec;
    var isNew = !x.cur;
    // 리드 결정: 제출된 기록은 임시저장으로 몰래 바뀌지 않는다 — [수정 제출](records.submit, rev+1)로만 고친다.
    if (!isNew && x.cur.status === '제출') fail('CONFLICT', '제출된 기록은 임시저장할 수 없습니다. 고친 내용은 [수정 제출]로 반영하세요');
    checkRecord(x.def, rec, -1, me, x.cur);
    if (isNew) rec.id = newRecordId(x.def, rec.site, rec.date, me);
    writeRecord(rec, isNew);
    if (rec.status !== '작성중' || rec.stageDone.length) views('onRecord', rec, ctx);
    // 자동 임시저장(3초마다)이 감사 기록을 채우지 않도록 새로 만들 때만 남긴다. 제출·검토·삭제는 각 핸들러가 남긴다.
    if (isNew) audit(ctx, 'record', rec.id, formName(x.def) + ' 새로 작성(임시저장)');
    return { record: recFor(rec, me) };
  }

  /** 단계형 양식: 단계 하나를 끝낸 것으로 표시하고 상태를 정한다. → 끝낸 단계 정의 */
  /** 본사만 쓰는 단계인가(FD stage.role==='hq' 또는 담당(who)이 '본사'로 시작). */
  function hqOnlyStage(st) {
    return !!st && (st.role === 'hq' || /^본사/.test(String(st.who || '')));
  }

  /** 단계형 양식이 이 단계에서 끝나는가(N3 허가서를 보류·불허로 낸 경우). */
  function endsEarly(def, rec, sid) {
    if (def.code === 'N3' && sid === 's1') {
      var d = String((rec.data && rec.data.decision) || '');
      return /^(보류|불허)/.test(d);
    }
    return false;
  }

  function applyStage(def, rec, stageId, me) {
    var stages = def.stages || [];
    var ids = stages.map(function (s) { return s.id; });
    var done = (rec.stageDone || []).filter(function (s) { return ids.indexOf(s) >= 0; });
    var sid = stageId ? String(stageId) : '';
    if (!sid) {
      for (var i = 0; i < ids.length; i++) if (done.indexOf(ids[i]) < 0) { sid = ids[i]; break; }
      if (!sid) sid = ids[ids.length - 1];
    }
    var idx = ids.indexOf(sid);
    if (idx < 0) fail('INVALID', '이 양식에 없는 단계입니다: ' + sid);
    if (me && me.kind === 'site' && hqOnlyStage(stages[idx])) fail('FORBIDDEN', '본사가 쓰는 단계입니다(' + (stages[idx].label || sid) + '). 사업장에서는 제출할 수 없습니다');
    if (done.indexOf(sid) < 0) {
      for (var j = 0; j < idx; j++) {
        if (done.indexOf(ids[j]) < 0) fail('INVALID', '앞 단계(' + (stages[j].label || ids[j]) + ')를 먼저 제출하세요');
      }
      done.push(sid);
    }
    done.sort(function (a, b) { return ids.indexOf(a) - ids.indexOf(b); });
    rec.stageDone = done;
    if (done.length >= ids.length || endsEarly(def, rec, sid)) {
      rec.status = '제출';
      rec.submittedAt = rec.submittedAt || now();
    } else {
      rec.status = '작성중';
    }
    return stages[idx];
  }

  /** 조치 번호 발급기(잠금 안). 본사 등록은 H01, H02… */
  function actIdGen(site, date, me) {
    var head = 'ACT-' + site + '-' + Db.yymm(date || today()) + '-';
    var maxN = 0, maxH = 0;
    Db.all('acts').forEach(function (a) {
      var id = String(a.id || '');
      if (id.indexOf(head) !== 0) return;
      var t = id.slice(head.length);
      if (/^H\d+$/.test(t)) maxH = Math.max(maxH, Number(t.slice(1)));
      else if (/^\d+$/.test(t)) maxN = Math.max(maxN, Number(t));
    });
    return function () {
      if (me.kind === 'hq') { maxH += 1; return head + 'H' + pad(maxH, 2); }
      maxN += 1;
      return head + pad(maxN, 3);
    };
  }

  /** 조치 후보 key 를 실제 기록 번호 기준으로 맞춘다(새 기록은 클라이언트가 번호를 모름). */
  function normKey(key, recId) {
    var i = key.indexOf('#');
    return recId + (i >= 0 ? key.slice(i) : '#' + key);
  }

  /** 사진 참조: 파일 번호만 받는다(데이터 URL 은 files.put 으로 먼저 올려야 함). */
  function photoRef(v) {
    if (isObj(v)) v = v.id || v.fileId || '';
    if (typeof v !== 'string') return '';
    v = v.trim();
    return /^[A-Za-z0-9_\-:.]{3,120}$/.test(v) ? v : '';
  }

  function actDueDays(level) {
    var m = codes().actDefaultDueDays || { '높음': 1, '보통': 7, '낮음': 30 };
    return Number(m[level]) || 7;
  }

  function validActType(t) {
    var types = codes().actTypes || ['자체', '본사 지원', '고객사 협조 요청', '구매'];
    return types.indexOf(t) >= 0 ? t : '';
  }

  function histEntry(me, from, to, note) {
    return { at: now(), by: whoOf(me), from: from || '', to: to || '', note: note || '', role: me.role };
  }

  /** 제출 때 받은 조치 후보를 조치대장에 반영(잠금 안). → 생성·갱신된 조치 목록 */
  function upsertActs(def, rec, cands, me) {
    if (cands === undefined || cands === null) return [];
    if (!Array.isArray(cands)) fail('INVALID', '조치 후보 목록이 올바르지 않습니다');
    if (cands.length > 300) fail('INVALID', '한 번에 등록할 수 있는 조치는 300건까지입니다');
    if (!cands.length) return [];
    var all = Db.all('acts', { fresh: true });
    var byKey = {};
    all.forEach(function (a) { if (a.key && !a.deleted) byKey[a.key] = a; });
    var next = actIdGen(rec.site, rec.date, me);
    var t = now();
    var out = [], seen = {};
    cands.forEach(function (c) {
      if (!isObj(c)) return;
      var rawKey = clip(c.key, 300);
      if (!rawKey) return;
      var key = normKey(rawKey, rec.id);
      if (seen[key]) return;
      seen[key] = true;
      var level = LEVELS.indexOf(c.level) >= 0 ? c.level : '보통';
      var title = clip(c.title, LIM.title) || (formName(def) + ' 개선 필요');
      var detail = clip(c.detail, LIM.memo);
      var due = validYmd(c.due) ? c.due : '';
      var owner = clip(c.owner, LIM.name);
      var photo = photoRef(c.photo);
      var ex = byKey[key];
      if (ex) {
        if (ACT_OPEN.indexOf(ex.status) < 0) return; // 닫힌 조치(완료·확인·이관)는 그대로 둔다
        var patch = { title: title, detail: detail, level: level, due: due || ex.due, owner: owner || ex.owner };
        var changed = Object.keys(patch).filter(function (k) { return String(patch[k] || '') !== String(ex[k] || ''); });
        if (photo && !ex.photoBefore) { patch.photoBefore = photo; changed.push('photoBefore'); }
        if (!changed.length) return;
        var nx = clone(ex);
        Object.keys(patch).forEach(function (k) { nx[k] = patch[k]; });
        nx.updatedAt = t;
        nx.history = (Array.isArray(ex.history) ? ex.history : []).concat([
          histEntry(me, ex.status, ex.status, formName(def) + ' 다시 제출로 내용 갱신(' + rec.id + ' rev ' + rec.rev + ')')
        ]);
        out.push(nx);
        byKey[key] = nx;
      } else {
        var a = {
          id: next(), key: key, site: rec.site, srcId: rec.id, srcForm: rec.form, srcItem: clip(c.srcItem, LIM.title),
          title: title, detail: detail, level: level, type: validActType(c.type) || '자체',
          due: due || Db.addDays(rec.date || today(), actDueDays(level)), owner: owner, status: '등록',
          photoBefore: photo, photoAfter: '', doneAt: '', doneBy: '', doneNote: '', confirmedAt: '', confirmedBy: '',
          history: [histEntry(me, '', '등록', formName(def) + ' 제출로 자동 등록(' + rec.id + ')')],
          createdAt: t, updatedAt: t, deleted: false
        };
        out.push(a);
        byKey[key] = a;
      }
    });
    if (out.length) Db.upsertMany('acts', out);
    return out;
  }

  /**
   * 수정·재제출로 더는 후보가 아닌 자동 조치 정리(잠금 안). 후보 목록(p.acts)을 배열로 받았을 때만.
   * - 이 기록에서 자동 등록된 조치(key '<기록번호>#<섹션>#…', 섹션이 조치를 만드는 점검표·표) 중 이번 후보에 없는 것:
   *   손대지 않은 '등록' 상태면 삭제(이력 남김), 사람이 손댄 열린 조치(조치중·보류)는 이력에 안내만 한 번 남긴다.
   * - 사업장 세션은 본사 전용 단계 섹션의 조치를 건드리지 않는다(그 섹션은 사업장 화면이 후보를 만들지 않는다).
   * → 바뀐 조치 목록
   */
  function pruneActs(def, rec, cands, me) {
    if (!Array.isArray(cands)) return [];
    var actSecs = {};
    (def.sections || []).forEach(function (s) {
      if (s && s.id && s.act && (s.type === 'checklist' || s.type === 'table')) actSecs[s.id] = true;
    });
    var parts = me.kind === 'site' ? hqParts(def.code) : null;
    if (parts) parts.secs.forEach(function (sid) { delete actSecs[sid]; });
    var keep = {};
    cands.forEach(function (c) {
      if (!isObj(c)) return;
      var raw = clip(c.key, 300);
      if (raw) keep[normKey(raw, rec.id)] = true;
    });
    var head = rec.id + '#';
    var NOTE_GONE = '원 항목을 고쳐 다시 제출 — 더는 조치 대상(주의·불량 등)이 아니어서 자동 정리(' + rec.id + ' rev ' + rec.rev + ')';
    var NOTE_KEEP = '원 항목을 고쳐 다시 제출 — 이번 제출에서는 조치 대상이 아님. 진행 중이라 그대로 둠(' + rec.id + ')';
    var t = now();
    var out = [];
    Db.all('acts', { fresh: true }).forEach(function (a) {
      if (a.deleted || a.srcId !== rec.id) return;
      var key = String(a.key || '');
      if (key.indexOf(head) !== 0 || keep[key]) return;
      var sec = key.slice(head.length).split('#')[0];
      if (!actSecs[sec]) return;
      var hist = Array.isArray(a.history) ? a.history : [];
      var nx = clone(a);
      if (a.status === '등록') {
        nx.deleted = true;
        nx.history = hist.concat([histEntry(me, a.status, a.status, NOTE_GONE)]);
      } else if (ACT_OPEN.indexOf(a.status) >= 0) {
        if (hist.some(function (h) { return h && String(h.note || '').indexOf('원 항목을 고쳐 다시 제출 — 이번 제출에서는') === 0; })) return;
        nx.history = hist.concat([histEntry(me, a.status, a.status, NOTE_KEEP)]);
      } else {
        return; // 완료·확인·고객사 이관은 그대로
      }
      nx.updatedAt = t;
      out.push(nx);
    });
    if (out.length) Db.upsertMany('acts', out);
    return out;
  }

  function hRecordsSubmit(p, me, ctx) {
    var x = prepRecord(p, me);
    var rec = x.rec, def = x.def, cur = x.cur;
    var prev = cur ? clone(cur) : null;
    var isNew = !cur;
    // 처음 보고하는 기록(새 기록·아직 보고 안 한 작성중)만 본다. 같은 기록의 재제출·수정 제출·다음 단계 제출은 그대로.
    if (!reportedRec(cur)) {
      var dupId = reportedDupId(def, rec);
      if (dupId) {
        var pl = rec.period ? String(rec.period) + (def.frequency && def.frequency.shifts && rec.shift ? ' ' + rec.shift : '') : '';
        fail('CONFLICT', '같은 기간' + (pl ? '(' + pl + ')' : '') + '에 이미 보고한 ' + formName(def) + ' 기록이 있습니다: ' + dupId +
          '. 같은 기간 기록은 1건만 냅니다. 그 기록을 이어서 쓰거나 수정 제출하세요');
      }
    }
    if (isNew) rec.id = newRecordId(def, rec.site, rec.date, me);
    var stage = null;
    var wasReturned = cur && cur.status === '반려';
    if (def.stages && def.stages.length) {
      stage = applyStage(def, rec, p.stageId, me);
      checkRecord(def, rec, Math.max(0, def.stages.indexOf(stage)), me);
    } else {
      checkRecord(def, rec, 0, me);
      rec.status = '제출';
      rec.submittedAt = rec.submittedAt || now();
    }
    // 반려 뒤 다시 제출하면 제출 시각을 지금으로(검토함 정렬·'가장 오래된 제출'·취합 현황판 기한 판정은 받아들일 수 있는 마지막 제출 기준).
    // 최초 제출 시각은 감사 기록(log)에 남긴다.
    var firstSubmittedAt = '';
    if (wasReturned && rec.status === '제출') {
      firstSubmittedAt = cur.submittedAt || '';
      rec.submittedAt = now();
    }
    rec.rev = (Number(cur && cur.rev) || 0) + 1;
    rec.updatedAt = now();
    writeRecord(rec, isNew);
    var acts = upsertActs(def, rec, p.acts, me);
    var pruned = cur ? pruneActs(def, rec, p.acts, me) : [];
    views('onRecord', rec, ctx);
    acts.forEach(function (a) { views('onAct', a, ctx); });
    pruned.forEach(function (a) { views('onAct', a, ctx); });

    var what = formName(def) + (stage ? ' ' + (stage.label || stage.id) + ' 단계' : '') + (wasReturned ? ' 다시 제출' : ' 제출');
    var gone = pruned.filter(function (a) { return a.deleted; }).length;
    audit(ctx, 'submit', rec.id, what + ' (rev ' + rec.rev + (acts.length ? ', 조치 ' + acts.length + '건' : '') + (gone ? ', 해소된 자동 조치 ' + gone + '건 정리' : '') +
      (firstSubmittedAt ? ', 이전 제출 ' + String(firstSubmittedAt).replace('T', ' ').slice(0, 16) : '') + ')');
    var done = clone(rec);
    later(ctx, 'Dispatch.onRecordSubmitted', function () {
      var D = mod('Dispatch');
      if (D && typeof D.onRecordSubmitted === 'function') D.onRecordSubmitted(done, me, prev);
    });
    // prunedActs: 이번 재제출로 정리(삭제 표시)되거나 안내 이력이 붙은 자동 조치 — 화면 캐시 갱신용(App.putAct 가 deleted 를 지운다).
    return { record: recFor(rec, me), acts: acts, prunedActs: pruned };
  }

  function hRecordsReview(p, me, ctx) {
    Db.all('records', { fresh: true });
    var r = clone(loadRecord(p.id, me));
    if (r.deleted) fail('CONFLICT', '삭제된 기록입니다');
    var decision = String(p.decision || '');
    var note = str(p.note, LIM.memo, '사유');
    var t = now();
    var staged = r.status === '작성중' && (r.stageDone || []).length > 0;
    if (decision === '확인') {
      if (r.status === '확인') fail('CONFLICT', '이미 확인한 기록입니다');
      if (r.status !== '제출') fail('CONFLICT', '제출이 끝난 기록만 확인할 수 있습니다 (지금 상태: ' + (staged ? '단계 보고' : r.status) + ')');
      r.status = '확인';
      r.confirmedAt = t;
      r.confirmedBy = me.name;
    } else if (decision === '반려') {
      if (!note) fail('INVALID', '반려 사유를 적어 주세요');
      if (r.status === '확인') fail('CONFLICT', '확인한 기록은 반려할 수 없습니다. 관리자가 먼저 확인을 취소해야 합니다');
      if (r.status === '반려') fail('CONFLICT', '이미 반려한 기록입니다');
      if (r.status !== '제출' && !staged) fail('CONFLICT', '아직 제출하지 않은 기록은 반려할 수 없습니다');
      r.status = '반려';
      r.returnNote = note;
      r.returnedAt = t;
      r.returnedBy = me.name;
      r.confirmedAt = '';
      r.confirmedBy = '';
    } else if (decision === '확인취소') {
      if (!isAdmin(me)) forbid(me, r.id, '확인 취소 시도(관리자 아님)', '확인 취소는 관리자만 할 수 있습니다');
      if (r.status !== '확인') fail('CONFLICT', '확인한 기록만 확인을 취소할 수 있습니다');
      r.status = '제출';
      r.confirmedAt = '';
      r.confirmedBy = '';
    } else {
      fail('INVALID', '검토 결정은 확인·반려·확인취소 가운데 하나여야 합니다');
    }
    r.updatedAt = t;
    Db.upsert('records', r);
    views('onRecord', r, ctx);
    audit(ctx, 'review', r.id, decision + (note ? ': ' + note : ''));
    var done = clone(r);
    later(ctx, 'Dispatch.onReviewed', function () {
      var D = mod('Dispatch');
      if (D && typeof D.onReviewed === 'function') D.onReviewed(done, decision, me);
    });
    return { record: r };
  }

  /** 본사에 한 번이라도 보고된(반려 포함) 기록은 사업장이 지울 수 없는 양식 — 사고(F04)·작업중지(F10). */
  var SITE_NO_DELETE_FORMS = ['F04', 'F10'];

  function hRecordsDelete(p, me, ctx) {
    Db.all('records', { fresh: true });
    var r = clone(loadRecord(p.id, me));
    if (r.deleted) return {};
    var reason = str(p.reason, LIM.memo, '삭제 사유');
    if (me.kind === 'site') {
      if (r.status !== '작성중' && r.status !== '반려') {
        fail('FORBIDDEN', '제출한 기록은 사업장에서 지울 수 없습니다. 본사에 삭제를 요청하세요');
      }
      if ((r.stageDone || []).length) {
        fail('FORBIDDEN', '단계 보고가 올라간 기록은 ' + (r.status === '반려' ? '반려됐더라도 ' : '') + '사업장에서 지울 수 없습니다. 고쳐서 다시 보고하거나 본사에 삭제를 요청하세요');
      }
      if (r.status === '반려' && SITE_NO_DELETE_FORMS.indexOf(r.form) >= 0) {
        fail('FORBIDDEN', '본사에 보고된 사고·작업중지 기록은 사업장에서 지울 수 없습니다. 고쳐서 다시 제출하거나 본사에 삭제를 요청하세요');
      }
    } else {
      if (!isHqWriter(me)) forbid(me, r.id, '기록 삭제 시도(열람 권한)', '열람 권한으로는 지울 수 없습니다');
      if (r.status !== '작성중' && !reason) fail('INVALID', '제출된 기록을 지우려면 사유를 적어 주세요');
    }
    var t = now();
    r.deleted = true;
    r.deletedReason = reason || '작성 취소';
    r.updatedAt = t;
    Db.upsert('records', r);
    // 손대지 않은 자동 조치(등록 상태)는 함께 지운다.
    var acts = Db.all('acts', { fresh: true }).filter(function (a) { return a.srcId === r.id && !a.deleted && a.status === '등록'; })
      .map(function (a) {
        var nx = clone(a);
        nx.deleted = true;
        nx.updatedAt = t;
        nx.history = (Array.isArray(a.history) ? a.history : []).concat([histEntry(me, a.status, a.status, '원본 기록 삭제로 함께 삭제')]);
        return nx;
      });
    if (acts.length) Db.upsertMany('acts', acts);
    views('onRecord', r, ctx);
    acts.forEach(function (a) { views('onAct', a, ctx); });
    audit(ctx, 'delete', r.id, '기록 삭제' + (reason ? ': ' + reason : '') + (acts.length ? ' (조치 ' + acts.length + '건 함께)' : ''));
    return {};
  }

  /* ======================================================================
   * 조치
   * ==================================================================== */

  function loadAct(id, me) {
    id = str(id, LIM.id, '조치 번호', true);
    var a = Db.get('acts', id);
    if (!a || a.deleted) fail('NOTFOUND', '조치를 찾을 수 없습니다: ' + id);
    needSite(me, a.site, id);
    return a;
  }

  /** 상태 전이 적용(검증 포함). a 를 직접 고친다. */
  function applyTransition(a, to, note, photo, me) {
    var from = a.status || '등록';
    if (ACT_STATUS.indexOf(to) < 0) fail('INVALID', '없는 조치 상태입니다: ' + to);
    if (to === from) fail('INVALID', "이미 '" + to + "' 상태입니다");
    var allowed = ACT_FLOW[from] || [];
    if (allowed.indexOf(to) < 0) fail('CONFLICT', "'" + from + "'에서 '" + to + "'(으)로 바꿀 수 없습니다");
    if (from === '확인' && !isHqWriter(me)) {
      forbid(me, a.id, '확인된 조치 다시 열기 시도', '확인된 조치는 본사만 다시 열 수 있습니다');
    }
    if ((to === '보류' || to === '고객사 이관') && !note) fail('INVALID', to + ' 사유를 적어 주세요');
    var t = now();
    if (to === '완료') {
      a.doneAt = t;
      a.doneBy = me.name;
      a.doneNote = note || '';
      if (photo) a.photoAfter = photo;
    } else if (to === '확인') {
      a.confirmedAt = t;
      a.confirmedBy = me.name;
      if (!a.doneAt) { a.doneAt = t; a.doneBy = me.name; }
    } else if (from === '완료' || from === '확인') {
      // 다시 여는 경우: 완료·확인 표시를 지우고 이력에 남긴다.
      a.doneAt = '';
      a.doneBy = '';
      a.confirmedAt = '';
      a.confirmedBy = '';
    }
    if (photo && to !== '완료' && !a.photoBefore) a.photoBefore = photo;
    a.status = to;
    var hnote = note || '';
    if (to === '확인' && me.kind === 'site') hnote = '[사업장 확인] ' + hnote;
    a.history = (Array.isArray(a.history) ? a.history : []).concat([histEntry(me, from, to, hnote.trim())]);
    a.updatedAt = t;
  }

  function hActsTransition(p, me, ctx) {
    Db.all('acts', { fresh: true });
    var a = clone(loadAct(p.id, me));
    var to = str(p.to, 10, '바꿀 상태', true);
    var note = str(p.note, LIM.memo, '메모');
    var photo = photoRef(p.photo);
    // 사업장 화면이 완료 사진 대신 사유를 보낼 수 있다(noPhotoReason) — 별도 열 없이 메모에 덧붙여 이력에 남긴다.
    var noPhoto = photo ? '' : str(p.noPhotoReason, 200, '사진 없음 사유');
    if (noPhoto) note = (note ? note + ' · ' : '') + '사진 없음 사유: ' + noPhoto;
    if (p.owner !== undefined && p.owner !== null) a.owner = str(p.owner, LIM.name, '담당자');
    var oldDue = a.due || '';
    if (p.due) {
      var nd = ymd(p.due, '기한');
      if (nd !== oldDue) {
        // 기한은 본사가 정한다 — 사업장이 기한경과 표시를 스스로 없애지 못하게.
        if (me.kind === 'site') forbid(me, a.id, '조치 기한 변경 시도(' + oldDue + ' → ' + nd + ')', '조치 기한은 본사만 바꿀 수 있습니다. 기한 조정이 필요하면 본사에 요청하세요');
        a.due = nd;
        note = (note ? note + ' · ' : '') + '기한 ' + (oldDue || '없음') + ' → ' + nd;
      }
    }
    var from = a.status;
    applyTransition(a, to, note, photo, me);
    Db.upsert('acts', a);
    views('onAct', a, ctx);
    audit(ctx, 'act', a.id, from + ' → ' + to + (note ? ': ' + note : ''));
    return { act: a };
  }

  function hActsSave(p, me, ctx) {
    var src = p.act;
    if (!isObj(src)) fail('INVALID', '조치 내용이 없습니다');
    var all = Db.all('acts', { fresh: true });
    var t = now();
    var a;
    if (src.id) {
      a = clone(loadAct(src.id, me));
      if (src.site && String(src.site).toUpperCase() !== a.site) {
        if (me.kind === 'site') forbid(me, a.id, '다른 사업장으로 조치 이동 시도', '우리 사업장 조치만 다룰 수 있습니다');
        fail('INVALID', '조치의 사업장은 바꿀 수 없습니다');
      }
      if (a.status === '확인' && !isHqWriter(me)) fail('CONFLICT', '확인된 조치는 본사만 고칠 수 있습니다');
      var before = clone(a);
      if (src.title !== undefined) a.title = str(src.title, LIM.title, '조치 제목', true);
      if (src.detail !== undefined) a.detail = str(src.detail, LIM.memo, '조치 내용');
      if (src.level !== undefined) {
        if (LEVELS.indexOf(src.level) < 0) fail('INVALID', '위험 수준은 높음·보통·낮음 가운데 하나입니다');
        a.level = src.level;
      }
      if (src.type !== undefined) a.type = src.type ? (validActType(src.type) || fail('INVALID', '없는 조치 구분입니다: ' + src.type)) : '';
      if (src.due !== undefined) a.due = ymd(src.due, '기한');
      if (src.owner !== undefined) a.owner = str(src.owner, LIM.name, '담당자');
      if (src.srcItem !== undefined) a.srcItem = str(src.srcItem, LIM.title, '항목');
      if (src.photoBefore !== undefined) a.photoBefore = photoRef(src.photoBefore);
      if (src.photoAfter !== undefined) a.photoAfter = photoRef(src.photoAfter);
      var changed = ['title', 'detail', 'level', 'type', 'due', 'owner', 'srcItem', 'photoBefore', 'photoAfter'].filter(function (k) {
        return String(before[k] || '') !== String(a[k] || '');
      });
      // 위험 수준·기한은 본사가 정한다(사업장이 기한경과·높음 표시를 스스로 없애지 못하게).
      var hqOnly = changed.filter(function (k) { return k === 'level' || k === 'due'; });
      if (hqOnly.length && me.kind === 'site') {
        forbid(me, a.id, '조치 ' + hqOnly.join('·') + ' 변경 시도', '조치의 위험 수준·기한은 본사만 바꿀 수 있습니다. 조정이 필요하면 본사에 요청하세요');
      }
      var LABEL = { level: '위험 수준', due: '기한' };
      var diffText = changed.map(function (k) {
        return LABEL[k] ? LABEL[k] + ' ' + (before[k] || '없음') + ' → ' + (a[k] || '없음') : k;
      });
      var toStatus = src.status ? String(src.status) : '';
      if (toStatus && toStatus !== before.status) {
        applyTransition(a, toStatus, str(src.note, LIM.memo, '메모'), photoRef(src.photo), me);
      }
      if (changed.length) {
        a.history = (Array.isArray(a.history) ? a.history : []).concat([histEntry(me, a.status, a.status, '내용 수정(' + diffText.join(', ') + ')')]);
        a.updatedAt = t;
      }
      if (!changed.length && !(toStatus && toStatus !== before.status)) return { act: a };
      Db.upsert('acts', a);
      audit(ctx, 'act', a.id, '조치 수정' + (changed.length ? ': ' + diffText.join(', ') : ''));
    } else {
      var site = scopeSite(me, src.site ? str(src.site, 8, '사업장') : '', 'acts');
      if (!site) fail('INVALID', '사업장을 고르세요');
      getSite(site);
      var level = src.level ? src.level : '보통';
      if (LEVELS.indexOf(level) < 0) fail('INVALID', '위험 수준은 높음·보통·낮음 가운데 하나입니다');
      var srcId = str(src.srcId, LIM.id, '원본 기록 번호');
      var srcForm = '';
      if (srcId) {
        var r = Db.get('records', srcId);
        if (!r || r.deleted) fail('NOTFOUND', '원본 기록을 찾을 수 없습니다: ' + srcId);
        if (r.site !== site) fail('INVALID', '원본 기록과 조치의 사업장이 다릅니다');
        srcForm = r.form;
      }
      var id = actIdGen(site, today(), me)();
      var key = src.key ? str(src.key, 300, '조치 키') : 'manual#' + id;
      if (all.some(function (x) { return x.key === key && !x.deleted; })) key = 'manual#' + id;
      a = {
        id: id, key: key, site: site, srcId: srcId, srcForm: srcForm, srcItem: str(src.srcItem, LIM.title, '항목'),
        title: str(src.title, LIM.title, '조치 제목', true), detail: str(src.detail, LIM.memo, '조치 내용'), level: level,
        type: src.type ? (validActType(src.type) || fail('INVALID', '없는 조치 구분입니다: ' + src.type)) : (me.kind === 'hq' ? '본사 지원' : '자체'),
        due: src.due ? ymd(src.due, '기한') : Db.addDays(today(), actDueDays(level)),
        owner: str(src.owner, LIM.name, '담당자'), status: '등록',
        photoBefore: photoRef(src.photoBefore || src.photo), photoAfter: '', doneAt: '', doneBy: '', doneNote: '', confirmedAt: '', confirmedBy: '',
        history: [histEntry(me, '', '등록', str(src.note, LIM.memo, '메모') || (me.kind === 'hq' ? '본사 등록' : '사업장 등록'))],
        createdAt: t, updatedAt: t, deleted: false
      };
      Db.insert('acts', a);
      audit(ctx, 'act', a.id, '조치 등록: ' + a.title);
    }
    views('onAct', a, ctx);
    return { act: a };
  }

  /* ======================================================================
   * 사업장
   * ==================================================================== */

  function hSitesSave(p, me, ctx) {
    var src = p.site;
    if (!isObj(src)) fail('INVALID', '사업장 정보가 없습니다');
    Db.all('sites', { fresh: true });
    var id = siteCode(src.id);
    var cur = Db.get('sites', id);
    if (cur && (p.isNew || src.isNew)) fail('CONFLICT', '이미 있는 사업장 코드입니다: ' + id);
    var t = now();
    var s = cur ? clone(cur) : {
      id: id, name: '', type: '', region: '', client: '', address: '', tags: [], shifts: [], forms: [], openDate: '', status: '운영',
      hec: false, hecLastEval: '', hecNextEval: '', headcount: 0, managerName: '', managerEmail: '', managerPhone: '',
      token: Db.token().slice(0, 20), pinHash: '', pinSalt: '', memo: '', createdAt: t, updatedAt: t
    };
    function set(k, fn) { if (src[k] !== undefined || !cur) s[k] = fn(src[k] === undefined ? s[k] : src[k]); }
    set('name', function (v) { return str(v, 100, '사업장 이름', true); });
    set('type', function (v) { return str(v, LIM.short, '사업장 유형'); });
    set('region', function (v) { return str(v, LIM.short, '지역'); });
    set('client', function (v) { return str(v, 100, '고객사'); });
    set('address', function (v) { return str(v, LIM.title, '주소'); });
    set('tags', function (v) { return strList(v, 30, LIM.short, '태그'); });
    set('shifts', function (v) { return strList(v, 10, 20, '근무조'); });
    set('forms', function (v) {
      var list = strList(v, 50, 10, '필수 양식');
      list.forEach(function (c) { if (!Db.form(c)) fail('INVALID', '없는 양식입니다: ' + c); });
      return list;
    });
    set('openDate', function (v) { return ymd(v, '개설일'); });
    set('status', function (v) {
      v = str(v, 10, '운영 상태') || '운영';
      if (v !== '운영' && v !== '종료') fail('INVALID', "운영 상태는 '운영' 또는 '종료'입니다");
      return v;
    });
    set('hec', function (v) { return bool(v); });
    set('hecLastEval', function (v) { return ymd(v, 'HEC 최근 평가일'); });
    set('hecNextEval', function (v) { return ymd(v, 'HEC 다음 평가일'); });
    set('headcount', function (v) { return int(v, 0, 100000, 0); });
    set('managerName', function (v) { return str(v, LIM.name, '담당자 이름'); });
    set('managerEmail', function (v) { return email(v, '담당자 이메일'); });
    set('managerPhone', function (v) {
      v = str(v, 30, '담당자 전화');
      if (v && !/^[0-9+\-() .]{4,30}$/.test(v)) fail('INVALID', '전화번호는 숫자와 - 로 적어 주세요');
      return v;
    });
    set('memo', function (v) { return str(v, LIM.memo, '메모'); });
    if (!s.token) s.token = Db.token().slice(0, 20);
    s.updatedAt = t;
    Db.upsert('sites', s);
    if (cur && cur.status !== '종료' && s.status === '종료') {
      Auth.killSessions(function (r) { return r.kind === 'site' && r.site === id; });
    }
    audit(ctx, 'site', id, cur ? '사업장 정보 수정' + (cur.status !== s.status ? ' (' + cur.status + ' → ' + s.status + ')' : '') : '사업장 등록: ' + s.name);
    return { site: pubSite(s, me) };
  }

  function hSitesRotate(p, me, ctx) {
    Db.all('sites', { fresh: true });
    var s = clone(getSite(siteCode(p.id)));
    s.token = Db.token().slice(0, 20);
    s.updatedAt = now();
    Db.upsert('sites', s);
    var n = Auth.killSessions(function (r) { return r.kind === 'site' && r.site === s.id; });
    audit(ctx, 'site', s.id, '사업장 링크 새로 발급(이전 링크 무효, 접속 ' + n + '건 끊음)');
    return { site: pubSite(s, me) };
  }

  function hSitesSetPin(p, me, ctx) {
    Db.all('sites', { fresh: true });
    var s = clone(getSite(siteCode(p.id)));
    var pin = str(p.pin, 8, 'PIN');
    if (pin && !/^\d{4,8}$/.test(pin)) fail('INVALID', 'PIN 은 숫자 4~8자리로 정하세요');
    if (pin) {
      s.pinSalt = Utilities.getUuid();
      s.pinHash = Db.hash(s.pinSalt, pin);
    } else {
      s.pinSalt = '';
      s.pinHash = '';
    }
    s.updatedAt = now();
    Db.upsert('sites', s);
    if (pin) Auth.killSessions(function (r) { return r.kind === 'site' && r.site === s.id; });
    audit(ctx, 'site', s.id, pin ? '사업장 PIN 설정' : '사업장 PIN 해제');
    return { site: pubSite(s, me) };
  }

  /* ======================================================================
   * 인원
   * ==================================================================== */

  function phone4(v) {
    v = String(v === null || v === undefined ? '' : v).replace(/\D/g, '');
    return v.slice(-4);
  }

  function hPeopleSave(p, me, ctx) {
    var src = p.person;
    if (!isObj(src)) fail('INVALID', '인원 정보가 없습니다');
    Db.all('people', { fresh: true });
    var t = now();
    var x;
    if (src.id) {
      var cur = Db.get('people', str(src.id, LIM.id, '인원 번호'));
      if (!cur) fail('NOTFOUND', '인원을 찾을 수 없습니다: ' + src.id);
      needSite(me, cur.site, cur.id);
      if (src.site && String(src.site).toUpperCase() !== cur.site) {
        if (me.kind === 'site') forbid(me, cur.id, '다른 사업장으로 인원 이동 시도', '우리 사업장 인원만 다룰 수 있습니다');
        getSite(String(src.site).toUpperCase());
      }
      x = clone(cur);
      if (src.site && me.kind === 'hq') x.site = String(src.site).toUpperCase();
    } else {
      var site = scopeSite(me, src.site ? str(src.site, 8, '사업장') : '', 'people');
      if (!site) fail('INVALID', '사업장을 고르세요');
      getSite(site);
      peopleRoom(site, 1);
      x = { id: 'P-' + Db.uuid8(), site: site, name: '', job: '', role: '', phone4: '', active: true, createdAt: t, updatedAt: t };
    }
    if (src.name !== undefined || !src.id) x.name = str(src.name, LIM.short, '이름', true);
    if (src.job !== undefined) x.job = str(src.job, LIM.short, '직무');
    if (src.role !== undefined) x.role = str(src.role, LIM.short, '역할');
    if (src.phone4 !== undefined) x.phone4 = phone4(src.phone4);
    if (src.active !== undefined) x.active = bool(src.active);
    x.updatedAt = t;
    Db.upsert('people', x);
    audit(ctx, 'people', x.id, (src.id ? '인원 수정: ' : '인원 등록: ') + x.name + ' (' + x.site + ')');
    return { person: x };
  }

  /** 인원 명부 상한: 한 번에 올리는 행, 사업장당 재직 인원, 사업장당 전체 행(퇴사 포함). */
  var PEOPLE_BULK_MAX = 1000;
  var PEOPLE_SITE_MAX = 2000;
  var PEOPLE_SITE_ROWS = 5000;
  function peopleRoom(site, more) {
    var activeN = 0, rowsN = 0;
    Db.all('people').forEach(function (x) { if (x.site === site) { rowsN++; if (x.active !== false) activeN++; } });
    if (activeN + more > PEOPLE_SITE_MAX || rowsN + more > PEOPLE_SITE_ROWS) {
      fail('INVALID', '한 사업장에 등록할 수 있는 인원(' + PEOPLE_SITE_MAX + '명)을 넘습니다. 그만둔 인원을 정리한 뒤 다시 등록하세요');
    }
  }

  function hPeopleBulk(p, me, ctx) {
    var site = scopeSite(me, p.site ? str(p.site, 8, '사업장') : '', 'people.bulk');
    if (!site) fail('INVALID', '사업장을 고르세요');
    getSite(site);
    if (!Array.isArray(p.rows)) fail('INVALID', '명부 행이 없습니다');
    if (p.rows.length > PEOPLE_BULK_MAX) fail('INVALID', '한 번에 ' + PEOPLE_BULK_MAX + '명까지 올릴 수 있습니다');
    var existing = {};
    var activeN = 0, rowsN = 0;
    Db.all('people', { fresh: true }).forEach(function (x) {
      if (x.site !== site) return;
      rowsN++;
      if (x.active !== false) { activeN++; existing[String(x.name || '').replace(/\s+/g, '')] = true; }
    });
    var t = now();
    var add = [], skipped = 0;
    p.rows.forEach(function (row) {
      if (!isObj(row)) { skipped++; return; }
      var name = clip(row.name, LIM.short);
      var k = name.replace(/\s+/g, '');
      if (!name || existing[k]) { skipped++; return; }
      existing[k] = true;
      add.push({
        id: 'P-' + Db.uuid8(), site: site, name: name, job: clip(row.job, LIM.short), role: clip(row.role, LIM.short),
        phone4: phone4(row.phone4), active: true, createdAt: t, updatedAt: t
      });
    });
    if (activeN + add.length > PEOPLE_SITE_MAX || rowsN + add.length > PEOPLE_SITE_ROWS) {
      fail('INVALID', '한 사업장에 등록할 수 있는 인원(' + PEOPLE_SITE_MAX + '명)을 넘습니다. 그만둔 인원을 정리한 뒤 다시 올리세요');
    }
    if (add.length) Db.upsertMany('people', add);
    audit(ctx, 'people', site, '인원 일괄 등록 ' + add.length + '명' + (skipped ? ' (건너뜀 ' + skipped + ')' : ''));
    return { added: add.length, skipped: skipped };
  }

  function hPeopleDelete(p, me, ctx) {
    Db.all('people', { fresh: true });
    var id = str(p.id, LIM.id, '인원 번호', true);
    var x = Db.get('people', id);
    if (!x) fail('NOTFOUND', '인원을 찾을 수 없습니다: ' + id);
    needSite(me, x.site, id);
    if (x.active === false) return {};
    Db.update('people', id, { active: false, updatedAt: now() });
    audit(ctx, 'people', id, '인원 비활성: ' + x.name + ' (' + x.site + ')');
    return {};
  }

  /* ======================================================================
   * 사용자(본사)
   * ==================================================================== */

  function activeAdmins(exceptId) {
    return Db.all('users').filter(function (u) { return u.role === 'admin' && u.active !== false && u.id !== exceptId; }).length;
  }

  function hUsersSave(p, me, ctx) {
    var src = p.user;
    if (!isObj(src)) fail('INVALID', '사용자 정보가 없습니다');
    Db.all('users', { fresh: true });
    var id = str(src.id, 30, '아이디', true).toLowerCase();
    if (!USER_RE.test(id)) fail('INVALID', '아이디는 영문 소문자·숫자·. _ - 로 3~30자로 정하세요');
    var cur = Db.get('users', id);
    if (cur && (p.isNew || src.isNew)) fail('CONFLICT', '이미 있는 아이디입니다: ' + id);
    var pw = p.password !== undefined && p.password !== null && p.password !== '' ? String(p.password)
      : (src.password ? String(src.password) : '');
    if (!cur && !pw) fail('INVALID', '새 사용자는 첫 비밀번호를 정해야 합니다');
    if (pw) Auth.checkNewPassword(pw);
    var t = now();
    var u = cur ? clone(cur) : { id: id, email: '', name: '', role: 'hq', salt: '', pwHash: '', active: true, createdAt: t, updatedAt: t, lastLoginAt: '' };
    if (src.name !== undefined || !cur) u.name = str(src.name, LIM.name, '이름', true);
    if (src.email !== undefined) u.email = email(src.email, '이메일');
    if (src.role !== undefined || !cur) {
      var role = String(src.role || (cur ? cur.role : 'hq'));
      if (Auth.HQ_ROLES.indexOf(role) < 0) fail('INVALID', '역할은 관리자(admin)·담당(hq)·열람(viewer) 가운데 하나입니다');
      u.role = role;
    }
    if (src.active !== undefined) u.active = bool(src.active);
    if (u.email && Db.all('users').some(function (x) { return x.id !== id && x.active !== false && String(x.email || '').toLowerCase() === u.email; })) {
      fail('CONFLICT', '같은 이메일을 쓰는 사용자가 이미 있습니다: ' + u.email);
    }
    if (cur && cur.role === 'admin' && cur.active !== false && (u.role !== 'admin' || u.active === false) && activeAdmins(id) === 0) {
      fail('CONFLICT', '마지막 관리자는 역할을 바꾸거나 끌 수 없습니다. 다른 관리자를 먼저 만드세요');
    }
    if (pw) {
      var h = Auth.hashPassword(pw);
      u.salt = h.salt;
      u.pwHash = h.pwHash;
    }
    u.updatedAt = t;
    Db.upsert('users', u);
    if (cur) {
      var roleChanged = cur.role !== u.role || (cur.active !== false) !== (u.active !== false);
      if (roleChanged || pw) {
        var keep = (id === me.id && !roleChanged) ? ctx.token : undefined;
        Auth.killSessions(function (r) { return r.kind === 'hq' && String(r.uid).toLowerCase() === id; }, keep);
      }
    }
    var what = [];
    if (!cur) what.push('사용자 등록(' + u.role + ')');
    else {
      if (cur.role !== u.role) what.push('역할 ' + cur.role + ' → ' + u.role);
      if ((cur.active !== false) !== (u.active !== false)) what.push(u.active === false ? '비활성' : '활성');
      if (pw) what.push('비밀번호 재설정');
      if (!what.length) what.push('정보 수정');
    }
    audit(ctx, 'user', id, what.join(', '));
    return { user: pubUser(u) };
  }

  function hUsersDelete(p, me, ctx) {
    Db.all('users', { fresh: true });
    var id = str(p.id, 30, '아이디', true).toLowerCase();
    var u = Db.get('users', id);
    if (!u) fail('NOTFOUND', '사용자를 찾을 수 없습니다: ' + id);
    if (id === me.id) fail('CONFLICT', '지금 로그인한 자기 계정은 끌 수 없습니다');
    if (u.active === false) return {};
    if (u.role === 'admin' && activeAdmins(id) === 0) fail('CONFLICT', '마지막 관리자는 끌 수 없습니다');
    Db.update('users', id, { active: false, updatedAt: now() });
    Auth.killSessions(function (r) { return r.kind === 'hq' && String(r.uid).toLowerCase() === id; });
    audit(ctx, 'user', id, '사용자 비활성');
    return {};
  }

  /* ======================================================================
   * 요청·열람 (Dispatch.gs 에 맡김)
   * ==================================================================== */

  function hRequestsSave(p, me, ctx) {
    var r = p.request;
    if (!isObj(r)) fail('INVALID', '요청 내용이 없습니다');
    str(r.title, LIM.title, '제목', true);
    str(r.message, LIM.memo, '내용');
    if (r.sites !== undefined) {
      strList(r.sites, 1000, 8, '대상 사업장').forEach(function (s) {
        if (s !== '*' && !SITE_RE.test(s)) fail('INVALID', '대상 사업장 코드가 올바르지 않습니다: ' + s);
      });
    }
    if (r.forms !== undefined) {
      strList(r.forms, 50, 10, '양식').forEach(function (c) { if (!Db.form(c)) fail('INVALID', '없는 양식입니다: ' + c); });
    }
    if (r.due) ymd(String(r.due).slice(0, 10), '마감일');
    var out = callMod('Dispatch', 'saveRequest', [p, me]);
    var req = out && out.request;
    if (req) audit(ctx, 'request', req.id, (r.id ? '요청 수정: ' : '요청 배포: ') + String(req.title || '').slice(0, 80));
    return out;
  }

  function hRequestsClose(p, me, ctx) {
    str(p.id, LIM.id, '요청 번호', true);
    var st = String(p.status || '마감');
    if (['진행', '마감', '취소'].indexOf(st) < 0) fail('INVALID', "요청 상태는 '진행'·'마감'·'취소' 가운데 하나입니다");
    var out = callMod('Dispatch', 'closeRequest', [p, me]);
    audit(ctx, 'request', p.id, '요청 상태 → ' + st);
    return out;
  }

  function hRequestsRemind(p, me, ctx) {
    str(p.id, LIM.id, '요청 번호', true);
    var out = callMod('Dispatch', 'remind', [p, me]);
    audit(ctx, 'request', p.id, '독촉 발송 ' + (out && out.sent != null ? out.sent : 0) + '건');
    return out;
  }

  /**
   * 열람·확인 표시. 실제로 있는 것에만 남긴다(아무 번호나 넣어 reads 행을 불리지 못하게):
   * - 사업장: 우리 사업장이 받은 요청·공지(REQ-…)만.
   * - 본사(열람 권한 제외 — perm 'write'): 요청 번호, 또는 단계 보고 확인 표시 '<기록번호>#<단계>'(그 기록이 있어야 함).
   * (refId, 사업장)마다 한 행이라 행 수는 요청 수 × 사업장 수를 넘지 않는다.
   */
  function hReadsMark(p, me) {
    var refId = str(p.refId, LIM.id + 12, '대상 번호', true);
    if (me.kind === 'site') {
      var r = Db.get('requests', refId);
      if (!r) fail('NOTFOUND', '요청·공지를 찾을 수 없습니다: ' + refId);
      if (!reqVisibleToSite(r, me.site)) forbid(me, refId, '받지 않은 요청 열람 표시 시도', '우리 사업장이 받은 요청이 아닙니다');
    } else {
      var hash = refId.indexOf('#');
      if (hash > 0) {
        var rec = Db.get('records', refId.slice(0, hash));
        if (!rec || rec.deleted) fail('NOTFOUND', '기록을 찾을 수 없습니다: ' + refId.slice(0, hash));
      } else if (!Db.get('requests', refId)) {
        fail('NOTFOUND', '요청·공지를 찾을 수 없습니다: ' + refId);
      }
    }
    return callMod('Dispatch', 'markRead', [p, me]);
  }

  /* ======================================================================
   * 파일
   * ==================================================================== */

  function cleanFileName(v) {
    v = clip(v, 200).replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '');
    return v.length > 120 ? v.slice(0, 120) : v;
  }

  /*
   * 올릴 수 있는 파일(허용 목록). 확장자 → 받는 MIME, 파일 앞 바이트 모양(magic).
   * 사진(jpg·png·webp·gif·heic), PDF, 사무문서(엑셀·워드·파워포인트·한글), 텍스트(txt·csv)만.
   * .html·.svg·.js·.exe 처럼 목록에 없는 확장자, 확장자와 맞지 않는 MIME·내용은 거부한다(본사가 내려받아 여는 파일이므로).
   */
  var OOXML = 'application/vnd.openxmlformats-officedocument.';
  var FILE_TYPES = {
    jpg: { mimes: ['image/jpeg', 'image/jpg', 'image/pjpeg'], magic: 'jpg', image: true },
    png: { mimes: ['image/png'], magic: 'png', image: true },
    webp: { mimes: ['image/webp'], magic: 'webp', image: true },
    gif: { mimes: ['image/gif'], magic: 'gif', image: true },
    heic: { mimes: ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'], magic: 'ftyp', image: true },
    pdf: { mimes: ['application/pdf'], magic: 'pdf' },
    xlsx: { mimes: [OOXML + 'spreadsheetml.sheet'], magic: 'zip' },
    docx: { mimes: [OOXML + 'wordprocessingml.document'], magic: 'zip' },
    pptx: { mimes: [OOXML + 'presentationml.presentation'], magic: 'zip' },
    hwpx: { mimes: ['application/vnd.hancom.hwpx', 'application/hwp+zip', 'application/haansofthwpx'], magic: 'zip' },
    xls: { mimes: ['application/vnd.ms-excel'], magic: 'ole' },
    doc: { mimes: ['application/msword'], magic: 'ole' },
    ppt: { mimes: ['application/vnd.ms-powerpoint'], magic: 'ole' },
    hwp: { mimes: ['application/x-hwp', 'application/haansofthwp', 'application/vnd.hancom.hwp'], magic: 'ole' },
    txt: { mimes: ['text/plain'], magic: '' },
    csv: { mimes: ['text/csv', 'application/csv', 'text/comma-separated-values', 'application/vnd.ms-excel', 'text/plain'], magic: '' }
  };
  var EXT_ALIAS = { jpeg: 'jpg', jpe: 'jpg', heif: 'heic' };
  /** 브라우저가 형식을 모를 때 주는 MIME — 확장자로 판단한다. */
  var GENERIC_MIME = ['', 'application/octet-stream', 'binary/octet-stream', 'application/x-zip-compressed', 'application/zip'];

  function extOf(mime) {
    var ks = Object.keys(FILE_TYPES);
    for (var i = 0; i < ks.length; i++) if (FILE_TYPES[ks[i]].mimes[0] === mime) return ks[i];
    for (var j = 0; j < ks.length; j++) if (FILE_TYPES[ks[j]].mimes.indexOf(mime) >= 0) return ks[j];
    return '';
  }

  /** 파일 앞 바이트로 본 모양: 'jpg'|'png'|'gif'|'webp'|'ftyp'|'pdf'|'zip'|'ole'|''. (GAS 바이트는 부호 있음) */
  function magicOf(bytes) {
    var b = [];
    for (var i = 0; i < 16 && i < bytes.length; i++) b.push(bytes[i] & 0xff);
    function at(off, arr) { for (var k = 0; k < arr.length; k++) if (b[off + k] !== arr[k]) return false; return true; }
    if (at(0, [0xff, 0xd8, 0xff])) return 'jpg';
    if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    if (at(0, [0x47, 0x49, 0x46, 0x38])) return 'gif';
    if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'webp';
    if (at(4, [0x66, 0x74, 0x79, 0x70])) return 'ftyp';
    if (at(0, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
    if (at(0, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
    if (at(0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
    return '';
  }
  var MAGIC_EXT = { jpg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', ftyp: 'heic' };

  /**
   * 받은 파일 검사 → { mime, name, bytes }. 허용 목록 밖·확장자/MIME/내용 불일치·깨진 base64 는 INVALID.
   * name 이 비었으면 기본 이름, 확장자가 없으면 형식에 맞는 확장자를 붙인다.
   */
  function checkUpload(rawMime, rawName, body, kind) {
    var mime = String(rawMime || '').trim().toLowerCase();
    var name = cleanFileName(rawName);
    var em = /\.([A-Za-z0-9]{1,8})$/.exec(name);
    var ext = em ? em[1].toLowerCase() : '';
    ext = EXT_ALIAS[ext] || ext;
    var generic = GENERIC_MIME.indexOf(mime) >= 0;
    if (ext && !FILE_TYPES[ext]) fail('INVALID', '이 형식의 파일은 올릴 수 없습니다(.' + em[1] + '). 사진·PDF·엑셀·워드·한글·파워포인트·txt·csv 만 올릴 수 있습니다');
    var type = ext || (generic ? '' : extOf(mime));
    if (!type) fail('INVALID', '이 형식의 파일은 올릴 수 없습니다' + (mime ? ': ' + mime : '') + '. 사진·PDF·엑셀·워드·한글·파워포인트·txt·csv 만 올릴 수 있습니다');
    var T = FILE_TYPES[type];
    if (!generic && T.mimes.indexOf(mime) < 0) {
      // 사진끼리는 브라우저가 압축하며 형식을 바꿀 수 있어 내용으로 다시 판단한다.
      if (!(T.image && /^image\//.test(mime) && extOf(mime) && FILE_TYPES[extOf(mime)].image)) {
        fail('INVALID', '파일 이름(.' + type + ')과 형식(' + mime + ')이 맞지 않습니다');
      }
    }
    var bytes;
    try { bytes = Utilities.base64Decode(body); } catch (e) { fail('INVALID', '파일 내용이 깨졌습니다(base64 해독 실패). 다시 골라 올려 주세요'); }
    if (!bytes || !bytes.length) fail('INVALID', '빈 파일입니다');
    if (bytes.length > APP.maxFileBytes) fail('INVALID', '파일이 너무 큽니다. 8MB 까지 올릴 수 있습니다');
    var mg = magicOf(bytes);
    if (T.image) {
      if (!MAGIC_EXT[mg]) fail('INVALID', '사진 파일이 아닙니다. 사진(jpg·png·webp·gif·heic)만 올릴 수 있습니다');
      var real = MAGIC_EXT[mg];
      if (real !== type) {
        T = FILE_TYPES[real];
        if (ext) name = name.slice(0, name.length - em[0].length) + '.' + real;
        type = real;
      }
    } else if (T.magic && mg !== T.magic) {
      fail('INVALID', '파일 내용이 .' + type + ' 형식이 아닙니다');
    } else if (!T.magic) {
      // 글자 파일: 그림·문서 묶음·실행 파일 같은 이진 파일이 아닌지만 본다.
      if (mg) fail('INVALID', '파일 내용이 .' + type + ' 글자 파일이 아닙니다');
    }
    var outMime = T.mimes.indexOf(mime) >= 0 ? mime : T.mimes[0];
    if (!name) name = (kind === 'photo' ? '사진' : kind === 'sign' ? '서명' : '첨부') + '-' + now().replace(/[^0-9]/g, '').slice(2, 14);
    if (!ext) name += '.' + type;
    return { mime: outMime, name: name, bytes: bytes };
  }

  /*
   * 사업장 링크만 아는 사람이 드라이브·시트를 채우지 못하게 사업장·하루 단위 상한.
   * 휴대폰 사진은 줄여서(1600px) 올리므로 한 장 0.3~0.6MB — 하루 300장·300MB 면 점검이 아주 많은 날도 넉넉하다.
   */
  var SITE_FILES_PER_DAY = 300;
  var SITE_BYTES_PER_DAY = 300 * 1024 * 1024;
  function siteFileQuota(site, addBytes) {
    var day = today();
    var n = 0, bytes = 0;
    Db.all('files').forEach(function (f) {
      if (f.site !== site || String(f.createdAt || '').slice(0, 10) !== day) return;
      n++;
      bytes += Number(f.size) || 0;
    });
    if (n + 1 > SITE_FILES_PER_DAY || bytes + addBytes > SITE_BYTES_PER_DAY) {
      fail('INVALID', '오늘 이 사업장에서 올릴 수 있는 파일 한도(' + SITE_FILES_PER_DAY + '개·' + Math.round(SITE_BYTES_PER_DAY / 1048576) + 'MB)를 넘었습니다. 내일 다시 올리거나 본사에 문의하세요');
    }
  }

  function hFilesPut(p, me, ctx) {
    var dataUrl = p.dataUrl;
    if (typeof dataUrl !== 'string' || !dataUrl) fail('INVALID', '파일 내용이 없습니다');
    var m = /^data:([^;,]*)((?:;[^;,]*)*),/.exec(dataUrl.slice(0, 400));
    if (!m || !/;\s*base64\s*(;|$)/i.test(m[2] || '')) fail('INVALID', '파일 형식이 맞지 않습니다(base64 데이터 URL 이어야 합니다)');
    var b64 = dataUrl.length - m[0].length;
    var padN = /==$/.test(dataUrl) ? 2 : (/=$/.test(dataUrl) ? 1 : 0);
    var approx = Math.floor(b64 * 3 / 4) - padN;
    if (approx <= 0) fail('INVALID', '빈 파일입니다');
    if (approx > APP.maxFileBytes) fail('INVALID', '파일이 너무 큽니다. 8MB 까지 올릴 수 있습니다');
    var kind = FILE_KINDS.indexOf(p.kind) >= 0 ? p.kind : 'attach';
    var recordId = str(p.recordId, LIM.id, '기록 번호');
    var site = me.kind === 'site' ? scopeSite(me, p.site ? str(p.site, 8, '사업장') : '', 'files.put') : (p.site ? str(p.site, 8, '사업장').toUpperCase() : '');
    if (recordId) {
      var r = Db.get('records', recordId);
      if (r) {
        needSite(me, r.site, recordId);
        if (!site) site = r.site;
        else if (site !== r.site) fail('INVALID', '기록과 파일의 사업장이 다릅니다');
      }
    }
    if (site && me.kind === 'hq') getSite(site);
    var up = checkUpload(m[1], p.name, dataUrl.slice(m[0].length), kind);
    if ((kind === 'photo' || kind === 'sign') && !/^image\//.test(up.mime)) fail('INVALID', '사진·서명은 그림 파일만 올릴 수 있습니다');
    if (me.kind === 'site') siteFileQuota(site, up.bytes.length);
    var saved = Db.saveBytes(up.bytes, up.mime, up.name, site);
    var f = {
      id: 'FILE-' + Db.uuid8(), site: site, recordId: recordId, name: up.name, mime: up.mime,
      size: Number(saved && saved.size) || up.bytes.length, driveId: saved.driveId, kind: kind, createdAt: now(), createdBy: whoOf(me)
    };
    Db.withLock(function () { Db.insert('files', f); });
    return { file: pubFile(f) };
  }

  function hFilesGet(p, me) {
    var id = str(p.id, LIM.id, '파일 번호', true);
    var f = Db.get('files', id);
    if (!f || !f.driveId) fail('NOTFOUND', '파일을 찾을 수 없습니다: ' + id);
    if (me.kind === 'site' && f.site !== me.site) {
      var viaRequest = Db.all('requests').some(function (r) {
        return reqVisibleToSite(r, me.site) && (r.attachments || []).some(function (a) { return a && (a.id === id || a === id); });
      });
      if (!viaRequest) forbid(me, id, '다른 사업장 파일 열람 시도', '다른 사업장 파일은 볼 수 없습니다');
    }
    return { id: f.id, name: f.name, mime: f.mime, dataUrl: Db.readDataUrl(f.driveId) };
  }

  /* ======================================================================
   * 설정
   * ==================================================================== */

  function hSettingsSave(p, me, ctx) {
    var src = p.settings;
    if (!isObj(src)) fail('INVALID', '설정 내용이 없습니다');
    var cur = Db.settings();
    var out = clone(cur);
    var changed = [];
    if (has(src, 'company')) { out.company = str(src.company, 100, '회사 이름', true); changed.push('company'); }
    if (has(src, 'appName')) { out.appName = str(src.appName, 60, '앱 이름', true); changed.push('appName'); }
    if (has(src, 'mail')) {
      if (!isObj(src.mail)) fail('INVALID', '메일 설정이 올바르지 않습니다');
      out.mail = isObj(out.mail) ? out.mail : {};
      ['enabled', 'onRequest', 'onReturn', 'onIncident', 'dailyReminder', 'weeklyDigest'].forEach(function (k) {
        if (has(src.mail, k)) out.mail[k] = bool(src.mail[k]);
      });
      if (has(src.mail, 'hqEmails')) {
        out.mail.hqEmails = strList(src.mail.hqEmails, 30, 120, '본사 수신 메일').map(function (e) { return email(e, '본사 수신 메일'); });
      }
      changed.push('mail');
    }
    if (has(src, 'reminder')) {
      if (!isObj(src.reminder)) fail('INVALID', '독촉 설정이 올바르지 않습니다');
      out.reminder = isObj(out.reminder) ? out.reminder : {};
      if (has(src.reminder, 'beforeDays')) {
        var bd = Array.isArray(src.reminder.beforeDays) ? src.reminder.beforeDays : String(src.reminder.beforeDays || '').split(',');
        var list = [];
        bd.forEach(function (d) { var n = int(d, 0, 30, null); if (n !== null && list.indexOf(n) < 0) list.push(n); });
        if (list.length > 5) fail('INVALID', '마감 전 독촉은 5번까지 정할 수 있습니다');
        out.reminder.beforeDays = list.sort(function (a, b) { return b - a; });
      }
      if (has(src.reminder, 'overdue')) out.reminder.overdue = bool(src.reminder.overdue);
      if (has(src.reminder, 'hour')) out.reminder.hour = int(src.reminder.hour, 0, 23, 8);
      changed.push('reminder');
    }
    if (has(src, 'dailyDue')) {
      var dd = str(src.dailyDue, 5, '일일 마감 시각', true);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dd)) fail('INVALID', '일일 마감 시각은 HH:mm 형식으로 적어 주세요 (예: 10:00)');
      out.dailyDue = dd;
      changed.push('dailyDue');
    }
    if (has(src, 'monthlyDueDay')) {
      var md = int(src.monthlyDueDay, 1, 28, null);
      if (md === null) fail('INVALID', '월간 마감일은 1~28 사이 숫자로 정하세요');
      out.monthlyDueDay = md;
      changed.push('monthlyDueDay');
    }
    if (has(src, 'requiredForms')) {
      var rf = src.requiredForms;
      if (!isObj(rf)) fail('INVALID', '필수 양식 설정이 올바르지 않습니다');
      out.requiredForms = isObj(out.requiredForms) ? out.requiredForms : {};
      if (has(rf, 'default')) {
        var defs = strList(rf['default'], 50, 10, '필수 양식');
        defs.forEach(function (c) { if (!Db.form(c)) fail('INVALID', '없는 양식입니다: ' + c); });
        out.requiredForms['default'] = defs;
      }
      if (has(rf, 'seasonal')) {
        if (!isObj(rf.seasonal)) fail('INVALID', '계절 양식 설정이 올바르지 않습니다');
        var sea = {};
        Object.keys(rf.seasonal).forEach(function (c) {
          if (!Db.form(c)) fail('INVALID', '없는 양식입니다: ' + c);
          var ms = Array.isArray(rf.seasonal[c]) ? rf.seasonal[c] : [];
          var months = [];
          ms.forEach(function (x) { var n = int(x, 1, 12, null); if (n !== null && months.indexOf(n) < 0) months.push(n); });
          sea[c] = months.sort(function (a, b) { return a - b; });
        });
        // 저장은 기존 설정과 깊게 합쳐지므로, 뺀 양식은 빈 달 목록으로 남겨 '계절 양식 아님'을 표시한다.
        Object.keys(isObj(out.requiredForms.seasonal) ? out.requiredForms.seasonal : {}).forEach(function (c) {
          if (!has(sea, c)) sea[c] = [];
        });
        out.requiredForms.seasonal = sea;
      }
      changed.push('requiredForms');
    }
    if (!changed.length) fail('INVALID', '바꿀 설정 항목이 없습니다');
    Db.saveSettings(out);
    audit(ctx, 'settings', changed.join(','), '설정 변경: ' + changed.join(', '));
    return { settings: pubSettings(out, me) };
  }

  /* ======================================================================
   * 내보내기·관리
   * ==================================================================== */

  function exportArgs(p) {
    var kind = String(p.kind || 'records');
    if (['records', 'acts', 'form'].indexOf(kind) < 0) fail('INVALID', "내보내기 종류는 records·acts·form 가운데 하나입니다");
    if (kind === 'form') formDef(p.form);
    if (p.from) ymd(p.from, '시작일');
    if (p.to) ymd(p.to, '종료일');
    return p;
  }
  function hExportSheet(p, me, ctx) {
    var out = callMod('Export', 'sheet', [exportArgs(p), me]);
    audit(ctx, 'export', p.kind || 'records', '구글 시트로 내보내기');
    return out;
  }
  function hExportXlsx(p, me, ctx) {
    var out = callMod('Export', 'xlsx', [exportArgs(p), me]);
    audit(ctx, 'export', p.kind || 'records', '엑셀로 내보내기');
    return out;
  }

  function hRebuildViews(p, me, ctx) {
    var out = callMod('Views', 'rebuildAll', []);
    audit(ctx, 'admin', 'views', '분석 시트 다시 만들기');
    return out;
  }

  function pickCols(table, o) {
    var row = {};
    SCHEMA[table].cols.forEach(function (c) { if (o[c[0]] !== undefined) row[c[0]] = o[c[0]]; });
    return row;
  }

  function normImport(table, o, t) {
    var r = pickCols(table, o);
    if (table === 'sites') {
      r.id = String(r.id).toUpperCase();
      if (!SITE_RE.test(r.id)) fail('INVALID', '사업장 코드가 올바르지 않습니다: ' + r.id);
      if (!r.token || !/^[A-Za-z0-9_\-]{6,64}$/.test(String(r.token))) r.token = Db.token().slice(0, 20);
      if (r.status !== '종료') r.status = '운영';
      r.hec = bool(r.hec);
      ['tags', 'shifts', 'forms'].forEach(function (k) { if (!Array.isArray(r[k])) r[k] = []; });
    } else if (table === 'people') {
      if (!r.site) fail('INVALID', '인원에 사업장이 없습니다: ' + r.id);
      r.active = r.active === undefined ? true : bool(r.active);
    } else if (table === 'records') {
      if (!r.form || !r.site) fail('INVALID', '기록에 양식·사업장이 없습니다: ' + r.id);
      if (REC_STATUS.indexOf(r.status) < 0) r.status = '작성중';
      if (!Array.isArray(r.stageDone)) r.stageDone = [];
      if (!isObj(r.data)) r.data = {};
      if (!isObj(r.facts)) r.facts = {};
      r.rev = Number(r.rev) || (r.status === '작성중' ? 0 : 1);
      r.deleted = bool(r.deleted);
    } else if (table === 'acts') {
      if (!r.site) fail('INVALID', '조치에 사업장이 없습니다: ' + r.id);
      if (ACT_STATUS.indexOf(r.status) < 0) r.status = '등록';
      if (LEVELS.indexOf(r.level) < 0) r.level = '보통';
      if (!Array.isArray(r.history)) r.history = [];
      if (!r.key) r.key = 'import#' + r.id;
      r.deleted = bool(r.deleted);
    } else if (table === 'requests') {
      ['forms', 'sites', 'attachments'].forEach(function (k) { if (!Array.isArray(r[k])) r[k] = []; });
      if (!isObj(r.remind)) r.remind = {};
      if (['진행', '마감', '취소'].indexOf(r.status) < 0) r.status = '진행';
      if (r.kind !== 'notice') r.kind = 'form';
      r.ackRequired = bool(r.ackRequired);
    }
    var cols = SCHEMA[table].cols.map(function (c) { return c[0]; });
    if (cols.indexOf('createdAt') >= 0 && !r.createdAt) r.createdAt = t;
    if (cols.indexOf('updatedAt') >= 0 && !r.updatedAt) r.updatedAt = r.submittedAt || r.createdAt || t;
    if (table === 'reads' && !r.at) r.at = t;
    return r;
  }

  function hImportBulk(p, me, ctx) {
    var replace = bool(p.replace);
    var t = now();
    var counts = {};
    var any = false;
    IMPORT_TABLES.forEach(function (table) {
      if (!Array.isArray(p[table])) return;
      any = true;
      var key = SCHEMA[table].key;
      var map = {}, order = [];
      p[table].forEach(function (o, i) {
        if (!isObj(o)) return;
        if (!o[key]) {
          if (table === 'reads') o[key] = 'RD-' + Db.uuid8();
          else fail('INVALID', table + ' ' + (i + 1) + '번째 행에 ' + key + ' 가 없습니다');
        }
        var r = normImport(table, o, t);
        if (!has(map, r[key])) order.push(r[key]);
        map[r[key]] = r;
      });
      var rows = order.map(function (k) { return map[k]; });
      if (replace) Db.replaceAll(table, rows);
      else Db.upsertMany(table, rows);
      counts[table] = rows.length;
    });
    if (!any) fail('INVALID', '가져올 자료가 없습니다');
    if (replace && Array.isArray(p.sites)) Auth.killSessions(function (r) { return r.kind === 'site'; });
    audit(ctx, 'import', replace ? 'replace' : 'merge', '자료 가져오기(' + (replace ? '바꾸기' : '합치기') + '): ' +
      Object.keys(counts).map(function (k) { return k + ' ' + counts[k]; }).join(', '));
    return { counts: counts };
  }

  function hWipe(p, me, ctx) {
    if (p.confirm !== '삭제') fail('INVALID', "확인 문구로 '삭제'를 입력하세요");
    var keepKv = Db.all('kv', { fresh: true }).filter(function (r) { return r.key === 'folders'; });
    Object.keys(SCHEMA).forEach(function (t) {
      if (t === 'users' || t === 'sessions') return;
      Db.replaceAll(t, t === 'kv' ? keepKv : []);
    });
    Auth.killSessions(function (r) { return r.kind === 'site'; });
    audit(ctx, 'wipe', 'all', '전체 자료 삭제(사용자 계정 제외)');
    return {};
  }

  function triggerList() {
    try {
      return ScriptApp.getProjectTriggers().map(function (tr) {
        var o = {};
        try { o.fn = tr.getHandlerFunction(); } catch (e) { o.fn = ''; }
        try { o.type = String(tr.getEventType()); } catch (e) { o.type = ''; }
        try { o.id = tr.getUniqueId(); } catch (e) { /* 선택 정보 */ }
        return o;
      });
    } catch (e) {
      return [];
    }
  }

  function hInfo() {
    var counts = {};
    Object.keys(SCHEMA).forEach(function (t) {
      try { counts[t] = Db.all(t).length; } catch (e) { counts[t] = null; }
    });
    var quota = null;
    try { quota = MailApp.getRemainingDailyQuota(); } catch (e) { quota = null; }
    var sheetUrl = '', folderUrl = '';
    try { sheetUrl = Db.book().getUrl(); } catch (e) { sheetUrl = ''; }
    try { folderUrl = Db.folder().getUrl(); } catch (e) { folderUrl = ''; }
    var tz = APP.tz;
    try { tz = Session.getScriptTimeZone() || APP.tz; } catch (e) { tz = APP.tz; }
    return {
      triggers: triggerList(), quota: quota, sheetUrl: sheetUrl, folderUrl: folderUrl, version: APP.version,
      counts: counts, appUrl: appUrl(), timeZone: tz, serverTime: now()
    };
  }

  function hInstallTriggers(p, me, ctx) {
    if (typeof installTriggers_ !== 'function') fail('SERVER', 'Setup.gs 의 installTriggers_ 가 설치되지 않았습니다');
    var r = installTriggers_();
    audit(ctx, 'admin', 'triggers', '자동 실행(트리거) 다시 설치');
    if (r && r.triggers) return r;
    return { triggers: Array.isArray(r) ? r : triggerList() };
  }

  function hLog(p) {
    var kind = p.kind ? str(p.kind, 30, '기록 종류') : '';
    var limit = int(p.limit, 1, 2000, 200);
    var rows = Db.all('log', { fresh: true });
    var out = [];
    for (var i = rows.length - 1; i >= 0 && out.length < limit; i--) {
      if (kind && rows[i].kind !== kind) continue;
      out.push({ at: rows[i].at, who: rows[i].who, kind: rows[i].kind, ref: rows[i].ref, text: rows[i].text });
    }
    return out;
  }

  /* ======================================================================
   * 메서드 표
   * ==================================================================== */

  var METHODS = {
    'auth.status': { perm: null, fn: hAuthStatus },
    'auth.login': { perm: null, fn: hLogin },
    'auth.siteLogin': { perm: null, fn: hSiteLogin },
    'auth.google': { perm: null, fn: hGoogle },
    'auth.logout': { perm: 'any', fn: hLogout },
    'auth.changePassword': { perm: 'hq', fn: hChangePassword },

    'boot': { perm: 'any', fn: hBoot },

    'records.index': { perm: 'any', fn: hRecordsIndex },
    'records.get': { perm: 'any', fn: hRecordsGet },
    'records.bulkGet': { perm: 'any', fn: hRecordsBulkGet },
    'records.save': { perm: 'write', lock: true, fn: hRecordsSave },
    'records.submit': { perm: 'write', lock: true, fn: hRecordsSubmit },
    'records.review': { perm: 'hqWrite', lock: true, fn: hRecordsReview },
    'records.delete': { perm: 'write', lock: true, fn: hRecordsDelete },

    'acts.save': { perm: 'write', lock: true, fn: hActsSave },
    'acts.transition': { perm: 'write', lock: true, fn: hActsTransition },

    'sites.save': { perm: 'admin', lock: true, fn: hSitesSave },
    'sites.rotateToken': { perm: 'admin', lock: true, fn: hSitesRotate },
    'sites.setPin': { perm: 'admin', lock: true, fn: hSitesSetPin },

    'people.save': { perm: 'write', lock: true, fn: hPeopleSave },
    'people.bulk': { perm: 'write', lock: true, fn: hPeopleBulk },
    'people.delete': { perm: 'write', lock: true, fn: hPeopleDelete },

    'users.save': { perm: 'admin', lock: true, fn: hUsersSave },
    'users.delete': { perm: 'admin', lock: true, fn: hUsersDelete },

    // 잠금 없음: Dispatch.saveRequest 가 요청 행 저장만 Db.withLock 으로 감싸고, 사업장별 메일은 잠금 밖에서 보낸다.
    'requests.save': { perm: 'hqWrite', fn: hRequestsSave },
    'requests.close': { perm: 'hqWrite', lock: true, fn: hRequestsClose },
    'requests.remind': { perm: 'hqWrite', fn: hRequestsRemind },
    'reads.mark': { perm: 'write', lock: true, fn: hReadsMark },

    'files.put': { perm: 'write', fn: hFilesPut },
    'files.get': { perm: 'any', fn: hFilesGet },

    'settings.save': { perm: 'admin', lock: true, fn: hSettingsSave },

    'export.sheet': { perm: 'hq', fn: hExportSheet },
    'export.xlsx': { perm: 'hq', fn: hExportXlsx },

    'admin.rebuildViews': { perm: 'admin', fn: hRebuildViews },
    'admin.importBulk': { perm: 'admin', lock: true, fn: hImportBulk },
    'admin.wipe': { perm: 'admin', lock: true, fn: hWipe },
    'admin.info': { perm: 'admin', fn: hInfo },
    'admin.installTriggers': { perm: 'admin', fn: hInstallTriggers },
    'admin.log': { perm: 'hq', fn: hLog }
  };

  /* ======================================================================
   * 진입점
   * ==================================================================== */

  function parsePayload(x) {
    if (x === null || x === undefined || x === '') return {};
    if (typeof x === 'object') {
      if (Array.isArray(x)) fail('INVALID', '요청 형식이 맞지 않습니다');
      return x;
    }
    if (typeof x !== 'string') fail('INVALID', '요청 형식이 맞지 않습니다');
    if (x.length > MAX_PAYLOAD) fail('INVALID', '보내는 내용이 너무 큽니다');
    var p;
    try { p = JSON.parse(x); } catch (e) { fail('INVALID', '요청 내용을 읽을 수 없습니다(JSON 형식 오류)'); }
    if (p === null || p === undefined) return {};
    if (!isObj(p)) fail('INVALID', '요청 형식이 맞지 않습니다');
    return p;
  }

  function errorOf(e, method) {
    var msg = String((e && e.message) || e || '');
    var code = e && e.code;
    if (CODES.indexOf(code) >= 0) return { ok: false, error: msg || '요청을 처리하지 못했습니다', code: code };
    if (/lock|잠금|timed? ?out|시간.*초과/i.test(msg)) {
      return { ok: false, error: '다른 사용자가 저장하는 중입니다. 잠시 후 다시 시도하세요', code: 'CONFLICT' };
    }
    if (/설치가 끝나지 않았습니다|setup/i.test(msg)) {
      return { ok: false, error: msg, code: 'SERVER' };
    }
    try { console.error('api ' + method + ' 오류: ' + (e && e.stack || msg)); } catch (x) { /* 로그 실패 무시 */ }
    return { ok: false, error: '서버에서 처리하지 못했습니다. 잠시 후 다시 시도하세요' + (msg ? ' (' + msg.slice(0, 200) + ')' : ''), code: 'SERVER' };
  }

  function runAfter(ctx) {
    ctx.after.forEach(function (fn) {
      try { fn(); } catch (e) { console.warn('후처리 실패: ' + (e && e.message || e)); }
    });
  }

  function call(method, payloadJson, token) {
    var m = typeof method === 'string' ? method : '';
    var ctx = { me: null, token: '', method: m, after: [] };
    try {
      var def = has(METHODS, m) ? METHODS[m] : null;
      if (!def) fail('NOTFOUND', '알 수 없는 요청입니다: ' + m.slice(0, 60));
      var p = parsePayload(payloadJson);
      ctx.token = typeof token === 'string' ? token.trim() : '';
      var me = null;
      if (def.perm) {
        if (!ctx.token) fail('AUTH', '로그인이 필요합니다');
        me = Auth.require(ctx.token, def.perm);
      }
      ctx.me = me;
      var data = def.lock
        ? Db.withLock(function () { return def.fn(p, me, ctx); })
        : def.fn(p, me, ctx);
      runAfter(ctx);
      return JSON.stringify({ ok: true, data: data === undefined || data === null ? {} : data });
    } catch (e) {
      // 권한 위반 감사 기록은 Auth.forbid 가 던지기 전에 이미 남겼다. 후처리(메일 등)는 실패한 요청에선 하지 않는다.
      return JSON.stringify(errorOf(e, m));
    }
  }

  return {
    call: call,
    METHODS: METHODS,
    periodFor: periodFor,
    pubSite: pubSite,
    pubUser: pubUser,
    indexRow: indexRow
  };
})();


/* ======================================================================
 * Auth.gs
 * ==================================================================== */

/**
 * Auth.gs — 로그인·세션·사업장 토큰·권한. SPEC §4.
 *
 * 공개: Auth.status / login / siteLogin / google / logout / changePassword
 *       Auth.session(token) → me|null, Auth.require(token, perm) → me (아니면 throw)
 *       Auth.canSite(me, siteId), Auth.allowed(me, perm), Auth.forbid(me, ref, text, msg)
 *       Auth.killSessions(pred) (잠금 안에서 호출), Auth.cleanup() (만료 세션 삭제 — cronDaily 용, 스스로 잠금)
 *       Auth.fail(code, msg) (오류 던지기 — e.code 가 api 응답 code 가 된다), Auth.publicSite(token)
 *
 * me = { kind:'hq'|'site', id, name, role:'admin'|'hq'|'viewer'|'site', site: siteId|null, siteName? }
 * 세션: sessions 시트 + CacheService('sess:'+token, 6시간) 이중 저장. 본사 14일, 사업장 30일(고정 만료).
 * 로그인 실패: 캐시 'fail:<hq|site|pw>:'+id 카운터(종류별 키 공간), 5회 실패 → 15분 잠김.
 */
var Auth = (function () {
  'use strict';

  var HQ_ROLES = ['admin', 'hq', 'viewer'];
  var FAIL_MAX = 5;
  var FAIL_SEC = 15 * 60;
  var CACHE_SEC = 21600;
  var LOCKED_MSG = '로그인을 5번 잘못해 15분 동안 잠겼습니다. 잠시 후 다시 시도하세요';

  /* ---------- 공통 ---------- */

  function fail(code, msg) {
    var e = new Error(msg);
    e.code = code;
    throw e;
  }

  function cache() {
    try { return CacheService.getScriptCache(); } catch (e) { return null; }
  }
  function cget(k) {
    var c = cache();
    if (!c) return null;
    try { return c.get(k); } catch (e) { return null; }
  }
  function cput(k, v, sec) {
    var c = cache();
    if (!c) return;
    try { c.put(k, v, sec); } catch (e) { console.warn('캐시 저장 실패: ' + k); }
  }
  function cdel(k) {
    var c = cache();
    if (!c) return;
    try { c.remove(k); } catch (e) { /* 캐시는 보조 저장소 — 실패해도 시트가 정본 */ }
  }

  /** 감사 기록. 기록 실패가 요청을 깨뜨리지 않게 감싼다. */
  function audit(who, kind, ref, text) {
    try { Db.log(who || '(알 수 없음)', kind, ref || '', text || ''); } catch (e) { console.warn('감사 기록 실패: ' + (e && e.message)); }
  }

  /** 길이가 같은지와 무관하게 끝까지 비교(시간 차 공격 완화). */
  function safeEq(a, b) {
    a = String(a || '');
    b = String(b || '');
    var diff = a.length ^ b.length;
    var n = Math.max(a.length, b.length);
    for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0 && a.length > 0;
  }

  function ready() {
    try {
      if (!PropertiesService.getScriptProperties().getProperty('DB_ID')) return false;
      Db.book();
      return true;
    } catch (e) {
      return false;
    }
  }
  function needReady() {
    if (!ready()) fail('SERVER', '설치가 끝나지 않았습니다. 관리자가 스크립트 편집기에서 setup 을 먼저 실행해야 합니다');
  }

  function expiry(days) {
    var now = Db.now();
    return Db.addDays(now.slice(0, 10), days) + now.slice(10);
  }

  function validToken(t) {
    return /^[A-Za-z0-9]{16,128}$/.test(t);
  }

  /* ---------- 로그인 실패 잠금 ---------- */

  /*
   * 잠금 카운터는 종류별로 키 공간을 나눈다: 'fail:hq:<아이디>' · 'fail:site:<사업장>' · 'fail:pw:<아이디>'.
   * (한 공간이면 본사 로그인 폼에 'site:S002' 를 넣어 남의 사업장 PIN 로그인을 잠글 수 있다.)
   * id 는 'hq:admin' 처럼 '<종류>:<값>' 으로 받는다.
   */
  var FAIL_KINDS = ['hq', 'site', 'pw'];
  /** 본사 로그인 아이디로 받을 수 있는 모양(영문 소문자·숫자·. _ -). 아니면 카운터를 만들지 않고 바로 거부. */
  var LOGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,59}$/;
  function failKey(id) {
    id = String(id);
    var i = id.indexOf(':');
    var kind = i > 0 ? id.slice(0, i) : '';
    if (FAIL_KINDS.indexOf(kind) < 0) fail('SERVER', '잠금 키 종류가 올바르지 않습니다');
    return 'fail:' + kind + ':' + id.slice(i + 1).toLowerCase();
  }
  function failCount(id) { return Number(cget(failKey(id)) || 0) || 0; }
  function checkLocked(id) {
    if (failCount(id) >= FAIL_MAX) fail('AUTH', LOCKED_MSG);
  }
  function noteFail(id) {
    var n = failCount(id) + 1;
    cput(failKey(id), String(n), FAIL_SEC);
    return n;
  }
  function clearFail(id) { cdel(failKey(id)); }
  function failMsg(base, n) {
    if (n >= FAIL_MAX) return LOCKED_MSG;
    var left = FAIL_MAX - n;
    return left <= 2 ? base + ' (남은 시도 ' + left + '회)' : base;
  }

  /* ---------- 사용자·사업장 찾기 ---------- */

  function findUser(id) {
    id = String(id || '').trim().toLowerCase();
    if (!id) return null;
    var u = Db.get('users', id);
    if (u) return u;
    var list = Db.find('users', function (x) { return String(x.id || '').toLowerCase() === id; });
    return list[0] || null;
  }

  function findSiteByToken(tok) {
    tok = String(tok || '').trim();
    if (!tok || !/^[A-Za-z0-9_\-]{6,64}$/.test(tok)) return null;
    var list = Db.find('sites', function (s) { return s.token && safeEq(String(s.token), tok); });
    return list[0] || null;
  }

  /** 로그인 전 화면용 사업장 정보(토큰이 맞을 때만). */
  function publicSite(tok) {
    var s = findSiteByToken(tok);
    if (!s || s.status === '종료') return null;
    return { id: s.id, name: s.name || s.id, needPin: !!s.pinHash };
  }

  /* ---------- 세션 ---------- */

  function hqMe(user) {
    return { kind: 'hq', id: user.id, name: user.name || user.id, role: user.role, site: null };
  }

  /** 시트 행 → me. 사용자가 꺼졌거나 사업장이 종료·삭제됐으면 null. */
  function meOfRow(row) {
    if (row.kind === 'site') {
      var site = row.site ? Db.get('sites', row.site) : null;
      if (!site || site.status === '종료') return null;
      return { kind: 'site', id: 'site:' + site.id, name: row.name || '사업장', role: 'site', site: site.id, siteName: site.name || site.id };
    }
    var user = findUser(row.uid);
    if (!user || user.active === false || HQ_ROLES.indexOf(user.role) < 0) return null;
    return hqMe(user);
  }

  /** 세션 행을 만든다. 잠금 안에서 부를 것. */
  function createSession(me, days) {
    var token = Db.token();
    var row = {
      token: token, kind: me.kind, uid: me.id, site: me.site || '', name: me.name, role: me.role,
      createdAt: Db.now(), expiresAt: expiry(days)
    };
    Db.insert('sessions', row);
    cput('sess:' + token, JSON.stringify({ me: me, exp: row.expiresAt }), CACHE_SEC);
    return token;
  }

  function session(token) {
    token = String(token || '').trim();
    if (!token || !validToken(token)) return null;
    var now = Db.now();
    var raw = cget('sess:' + token);
    if (raw) {
      try {
        var v = JSON.parse(raw);
        if (v && v.me && v.exp && v.exp > now) return v.me;
      } catch (e) { /* 깨진 캐시는 버리고 시트로 */ }
      cdel('sess:' + token);
    }
    var row = Db.get('sessions', token);
    if (!row) return null;
    if (!row.expiresAt || row.expiresAt <= now) {
      try { Db.withLock(function () { Db.remove('sessions', token); }); } catch (e) { console.warn('만료 세션 삭제 실패'); }
      return null;
    }
    var me = meOfRow(row);
    if (!me) return null;
    cput('sess:' + token, JSON.stringify({ me: me, exp: row.expiresAt }), CACHE_SEC);
    return me;
  }

  /**
   * 조건에 맞는 세션을 모두 지운다(시트 행 + 캐시). Db.withLock 안에서 부를 것.
   * pred(row) → true 면 삭제. keepToken 은 남긴다(자기 세션 유지용).
   */
  function killSessions(pred, keepToken) {
    var all = Db.all('sessions', { fresh: true });
    var dead = [], alive = [];
    all.forEach(function (r) {
      if (r.token !== keepToken && pred(r)) dead.push(r); else alive.push(r);
    });
    if (!dead.length) return 0;
    if (dead.length > 5) Db.replaceAll('sessions', alive);
    else dead.forEach(function (r) { Db.remove('sessions', r.token); });
    dead.forEach(function (r) { cdel('sess:' + r.token); });
    return dead.length;
  }

  /*
   * 사업장 세션 상한 — 링크만 알면 로그인할 수 있으므로 세션 행이 끝없이 늘지 않게 한다(잠금 안에서 부를 것).
   * 같은 사업장·같은 작성자 이름은 최근 SITE_SESS_PER_NAME 개(휴대폰·태블릿·PC 등)만, 사업장 전체는 SITE_SESS_MAX 개만 남기고
   * 오래된 것부터 끊는다. 만료된 행도 이때 함께 지운다.
   */
  var SITE_SESS_PER_NAME = 5;
  var SITE_SESS_MAX = 60;
  function trimSiteSessions(siteId, name) {
    var now = Db.now();
    var key = String(name || '').replace(/\s+/g, '');
    var mine = Db.all('sessions', { fresh: true }).filter(function (r) { return r.kind === 'site' && r.site === siteId; })
      .sort(function (a, b) { return String(b.createdAt || '') < String(a.createdAt || '') ? -1 : 1; });
    var dead = {};
    var live = [], sameName = 0;
    mine.forEach(function (r) {
      if (!r.expiresAt || r.expiresAt <= now) { dead[r.token] = 1; return; }
      if (String(r.name || '').replace(/\s+/g, '') === key) {
        sameName++;
        if (sameName >= SITE_SESS_PER_NAME) { dead[r.token] = 1; return; }
      }
      live.push(r);
    });
    live.slice(SITE_SESS_MAX - 1).forEach(function (r) { dead[r.token] = 1; });
    if (Object.keys(dead).length) killSessions(function (r) { return dead[r.token] === 1; });
  }

  /** 만료된 세션 행 정리. 스스로 잠금을 잡는다(cronDaily 에서 호출). → 지운 개수 */
  function cleanup() {
    var now = Db.now();
    return Db.withLock(function () {
      return killSessions(function (r) { return !r.expiresAt || r.expiresAt <= now; });
    });
  }

  /* ---------- 권한 ---------- */

  function allowed(me, perm) {
    if (!me) return false;
    var hq = me.kind === 'hq' && HQ_ROLES.indexOf(me.role) >= 0;
    switch (perm) {
      case 'any': return true;
      case 'write': return me.role !== 'viewer';
      case 'hq': return hq;
      case 'hqWrite': return hq && (me.role === 'admin' || me.role === 'hq');
      case 'admin': return hq && me.role === 'admin';
      case 'site': return me.kind === 'site';
      default: return false;
    }
  }

  var PERM_TEXT = {
    write: '열람 권한으로는 고칠 수 없습니다',
    hq: '본사 사용자만 할 수 있습니다',
    hqWrite: '본사 관리자·담당자만 할 수 있습니다',
    admin: '관리자만 할 수 있습니다',
    site: '사업장 화면에서만 할 수 있습니다'
  };

  /** 권한 위반을 감사 기록에 남기고 FORBIDDEN 을 던진다. */
  function forbid(me, ref, text, msg) {
    audit(me ? me.name + (me.kind === 'site' ? ' (' + me.site + ')' : ' (' + me.id + ')') : '(익명)', 'forbidden', ref || '', text || '권한 위반');
    fail('FORBIDDEN', msg || '이 작업을 할 권한이 없습니다');
  }

  function requireMe(token, perm) {
    var me = session(token);
    if (!me) fail('AUTH', '로그인이 필요합니다. 다시 로그인하세요');
    if (!allowed(me, perm)) forbid(me, perm, '권한 부족: ' + perm, PERM_TEXT[perm]);
    return me;
  }

  function canSite(me, siteId) {
    if (!me) return false;
    if (me.kind === 'hq') return true;
    return !!siteId && me.site === siteId;
  }

  /* ---------- 비밀번호 ---------- */

  function checkNewPassword(pw) {
    pw = String(pw || '');
    if (pw.length < 8) fail('INVALID', '비밀번호는 8자 이상으로 정하세요');
    if (pw.length > 100) fail('INVALID', '비밀번호는 100자까지 정할 수 있습니다');
    if (/^\s|\s$/.test(pw)) fail('INVALID', '비밀번호 앞뒤에 빈칸을 넣을 수 없습니다');
    if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) fail('INVALID', '비밀번호에 영문과 숫자를 함께 넣어 주세요');
    return pw;
  }

  function hashPassword(pw) {
    var salt = Utilities.getUuid();
    return { salt: salt, pwHash: Db.hash(salt, pw) };
  }

  /* ---------- API 핸들러 ---------- */

  function status(p) {
    p = p || {};
    var out = { ready: false, appName: DEFAULT_SETTINGS.appName, company: DEFAULT_SETTINGS.company, hasUsers: false, version: APP.version };
    if (!ready()) {
      if (p.siteToken) out.site = null;
      return out;
    }
    out.ready = true;
    try {
      var st = Db.settings();
      out.appName = st.appName || out.appName;
      out.company = st.company || out.company;
    } catch (e) { console.warn('설정 읽기 실패: ' + (e && e.message)); }
    out.hasUsers = Db.all('users').some(function (u) { return u.active !== false; });
    if (p.siteToken) out.site = publicSite(p.siteToken);
    return out;
  }

  function login(p) {
    needReady();
    var id = String(p.id || '').trim().toLowerCase();
    var pw = String(p.password || '');
    if (!id || !pw) fail('INVALID', '아이디와 비밀번호를 입력하세요');
    if (id.length > 60 || pw.length > 200 || !LOGIN_ID_RE.test(id)) fail('AUTH', '아이디 또는 비밀번호가 맞지 않습니다');
    var lockId = 'hq:' + id;
    checkLocked(lockId);
    var user = findUser(id);
    var ok = !!(user && user.active !== false && HQ_ROLES.indexOf(user.role) >= 0 && user.salt && user.pwHash &&
      safeEq(Db.hash(user.salt, pw), user.pwHash));
    if (!ok) {
      var n = noteFail(lockId);
      if (user) audit('(로그인 시도)', 'login-fail', user.id, '본사 로그인 실패 ' + n + '회' + (n >= FAIL_MAX ? ' — 15분 잠김' : ''));
      fail('AUTH', failMsg('아이디 또는 비밀번호가 맞지 않습니다', n));
    }
    clearFail(lockId);
    var me = hqMe(user);
    var token = Db.withLock(function () {
      Db.update('users', user.id, { lastLoginAt: Db.now() });
      return createSession(me, APP.hqSessionDays);
    });
    audit(me.name, 'login', me.id, '본사 로그인(' + me.role + ')');
    return { token: token, me: me };
  }

  function siteLogin(p) {
    needReady();
    var tok = String(p.siteToken || '').trim();
    var name = String(p.name || '').replace(/\s+/g, ' ').trim();
    var pin = String(p.pin == null ? '' : p.pin).trim();
    if (!tok) fail('AUTH', '사업장 링크로 들어와 주세요. 링크는 본사 안전경영지원실에서 받을 수 있습니다');
    var site = findSiteByToken(tok);
    if (!site) fail('AUTH', '사업장 링크가 맞지 않거나 바뀌었습니다. 본사에 새 링크를 요청하세요');
    if (site.status === '종료') fail('FORBIDDEN', '운영이 끝난 사업장입니다. 본사에 문의하세요');
    if (!name) fail('INVALID', '작성자 이름을 입력하세요');
    if (name.length > 30) fail('INVALID', '이름은 30자까지 적을 수 있습니다');
    var lockId = 'site:' + site.id;
    if (site.pinHash) {
      checkLocked(lockId);
      if (!pin) fail('AUTH', 'PIN 을 입력하세요');
      if (!safeEq(Db.hash(site.pinSalt || '', pin), site.pinHash)) {
        var n = noteFail(lockId);
        audit(name + ' (' + site.id + ')', 'login-fail', site.id, '사업장 PIN 실패 ' + n + '회' + (n >= FAIL_MAX ? ' — 15분 잠김' : ''));
        fail('AUTH', failMsg('PIN 이 맞지 않습니다', n));
      }
      clearFail(lockId);
    }
    var me = { kind: 'site', id: 'site:' + site.id, name: name, role: 'site', site: site.id, siteName: site.name || site.id };
    var token = Db.withLock(function () {
      trimSiteSessions(site.id, name);
      return createSession(me, APP.siteSessionDays);
    });
    audit(name + ' (' + site.id + ')', 'login', site.id, '사업장 로그인');
    return { token: token, me: me };
  }

  function google() {
    needReady();
    var email = '';
    try { email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { email = ''; }
    if (!email) {
      fail('AUTH', '구글 계정을 확인할 수 없습니다. 회사 구글 계정으로 로그인한 브라우저에서 다시 시도하거나 아이디로 로그인하세요');
    }
    var user = Db.find('users', function (u) {
      return u.active !== false && HQ_ROLES.indexOf(u.role) >= 0 && String(u.email || '').trim().toLowerCase() === email;
    })[0];
    if (!user) fail('AUTH', email + ' 계정은 등록돼 있지 않습니다. 관리자에게 사용자 등록을 요청하세요');
    var me = hqMe(user);
    var token = Db.withLock(function () {
      Db.update('users', user.id, { lastLoginAt: Db.now() });
      return createSession(me, APP.hqSessionDays);
    });
    audit(me.name, 'login', me.id, '구글 계정 로그인(' + email + ')');
    return { token: token, me: me };
  }

  function logout(token) {
    token = String(token || '').trim();
    if (!token) return {};
    cdel('sess:' + token);
    Db.withLock(function () { Db.remove('sessions', token); });
    return {};
  }

  function changePassword(me, p, token) {
    if (!me || me.kind !== 'hq') fail('FORBIDDEN', '본사 사용자만 비밀번호를 바꿀 수 있습니다');
    var oldPw = String(p.old || '');
    var newPw = String(p['new'] || '');
    if (!oldPw) fail('INVALID', '지금 비밀번호를 입력하세요');
    checkNewPassword(newPw);
    if (oldPw === newPw) fail('INVALID', '새 비밀번호가 지금 비밀번호와 같습니다');
    var lockId = 'pw:' + me.id;
    checkLocked(lockId);
    var user = findUser(me.id);
    if (!user || user.active === false) fail('AUTH', '사용자 정보를 찾을 수 없습니다. 다시 로그인하세요');
    if (!safeEq(Db.hash(user.salt || '', oldPw), user.pwHash)) {
      var n = noteFail(lockId);
      fail('INVALID', failMsg('지금 비밀번호가 맞지 않습니다', n));
    }
    clearFail(lockId);
    var h = hashPassword(newPw);
    Db.withLock(function () {
      Db.update('users', user.id, { salt: h.salt, pwHash: h.pwHash, updatedAt: Db.now() });
      // 다른 기기의 세션은 끊고 지금 세션만 남긴다.
      killSessions(function (r) { return r.kind === 'hq' && r.uid === user.id; }, token);
    });
    audit(me.name, 'user', user.id, '비밀번호 변경');
    return {};
  }

  return {
    HQ_ROLES: HQ_ROLES,
    fail: fail,
    ready: ready,
    status: status,
    login: login,
    siteLogin: siteLogin,
    google: google,
    logout: logout,
    changePassword: changePassword,
    session: session,
    require: requireMe,
    allowed: allowed,
    canSite: canSite,
    forbid: forbid,
    audit: audit,
    killSessions: killSessions,
    cleanup: cleanup,
    publicSite: publicSite,
    checkNewPassword: checkNewPassword,
    hashPassword: hashPassword
  };
})();


/* ======================================================================
 * Db.gs
 * ==================================================================== */

/**
 * Db.gs — 시트 DB 계층. SPEC §2·§5.
 *
 * 전역으로 내놓는 것: Db 하나. 나머지는 이 함수 안에 둔다(서버 파일들이 한 전역 범위를 같이 쓰므로).
 *
 * 테이블 = DB 스프레드시트의 시트 하나(이름 = SCHEMA 키). 1행은 영문 열 이름, 2행부터 자료.
 * 열 타입: s 문자열, b 불리언('Y'/''), n 숫자(문자열로 저장), j JSON. chunk:N 이면 col, col_2 … col_N 에 나눠 저장,
 * 그래도 넘치면 드라이브 JSON 파일에 두고 첫 칸에 '@drive:<fileId>'.
 * 모든 칸은 쓰기 전에 서식 '@'(일반 텍스트) — 날짜·숫자 자동 변환을 막는다.
 *
 * 읽기는 실행 단위로 메모한다(같은 실행 안 두 번째 읽기는 시트를 다시 읽지 않음). 쓰기는 메모도 같이 고친다.
 * Db.withLock 의 가장 바깥 잠금을 잡을 때 메모를 비운다(잠금 전에 읽은 것은 다른 실행이 바꿨을 수 있으므로).
 * chunk 4 이상인 큰 JSON 열(records.data)은 처음 그 값을 읽을 때 모든 행을 한 번에 읽는다(목록·색인 조회가 빨라짐).
 * Db.all / Db.get 이 돌려주는 객체는 메모 그 자체다. 고친 뒤에는 반드시 Db.update/upsert 로 저장할 것.
 */
var Db = (function () {
  'use strict';

  var SINGLE_MAX = 8;            // 한 실행에서 큰 열을 행 단위로 읽는 최대 건수(넘으면 전 행 한 번에)
  var HEAVY_CHUNK = 4;          // chunk 가 이 이상이면 '큰 열'로 보고 늦게 읽는다
  var CELL_MAX = 49000;         // 칸 하나 최대 50,000자 — 여유를 둔다
  var LOG_MAX = 5000;           // log 테이블 최대 행
  var LOG_SLACK = 200;          // 이만큼 넘치면 한꺼번에 정리
  var MEMO_TTL = 60000;         // 미리보기처럼 실행이 이어지는 환경에서 메모를 오래 들고 있지 않게
  var ARRAY_COLS = { tags: 1, shifts: 1, forms: 1, stageDone: 1, history: 1, sites: 1, attachments: 1 };
  var OBJECT_COLS = { facts: 1, data: 1, remind: 1 };
  var RISKY_START = /[=+\-@']/;  // 조각 첫 글자가 이것이면 시트가 수식·텍스트 표시로 오해할 수 있다
  var PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

  /** 실행 단위 상태 */
  var X = { book: null, specs: {}, info: {}, memo: {}, depth: 0, fd: null, fdMap: null, folders: {}, drv: {} };

  /* =========================================================== 공통 */

  function fail(code, msg) {
    var e = new Error(msg);
    e.code = code;
    throw e;
  }

  function props() { return PropertiesService.getScriptProperties(); }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function isDate(v) { return Object.prototype.toString.call(v) === '[object Date]'; }

  function isPlain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && !isDate(v); }

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  /** 시트에서 날짜로 바뀌어 들어온 값을 저장 규칙 문자열로 되돌린다. */
  function dateText(d) {
    var t = Utilities.formatDate(d, APP.tz, "yyyy-MM-dd'T'HH:mm:ss");
    return /T00:00:00$/.test(t) ? t.slice(0, 10) : t;
  }

  /** 칸 값 → 문자열(읽기). 앞에 붙인 수식 방지 따옴표는 떼어 낸다. */
  function cellText(v) {
    if (v === null || v === undefined) return '';
    if (isDate(v)) return dateText(v);
    var s = String(v);
    if (s.charAt(0) === "'" && s.charAt(1) === '=') s = s.slice(1);
    return s;
  }

  /** 문자열 → 칸 값(쓰기). '=' 로 시작하면 수식이 되지 않게 따옴표를 붙이고, 칸 한도를 넘으면 자른다. */
  function safeText(s) {
    s = String(s);
    if (s.length > CELL_MAX) s = s.slice(0, CELL_MAX);
    if (s.charAt(0) === '=') s = "'" + s;
    return s;
  }

  function toBool(v) {
    if (v === true) return true;
    if (v === false || v === null || v === undefined) return false;
    var s = String(v).trim().toUpperCase();
    return s === 'Y' || s === 'TRUE' || s === '1' || s === 'YES' || s === '예';
  }

  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    if (isDate(v)) return null;
    var n = Number(String(v).replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }

  function emptyJ(col) {
    if (ARRAY_COLS[col]) return [];
    if (OBJECT_COLS[col]) return {};
    return null;
  }

  /* =========================================================== 스키마 */

  /** SCHEMA 한 테이블을 다루기 쉬운 모양으로(실행당 1회). */
  function spec(table) {
    var sp = X.specs[table];
    if (sp) return sp;
    var s = SCHEMA[table];
    if (!s) fail('SERVER', '알 수 없는 테이블입니다: ' + table);
    sp = { table: table, key: s.key || null, cols: [], header: [], heavy: [] };
    s.cols.forEach(function (c) {
      var opt = c[2] || {};
      var n = Math.max(1, Number(opt.chunk) || 1);
      var names = [c[0]];
      for (var i = 2; i <= n; i++) names.push(c[0] + '_' + i);
      var col = { name: c[0], type: c[1], chunk: n, names: names, heavy: c[1] === 'j' && n >= HEAVY_CHUNK };
      sp.cols.push(col);
      names.forEach(function (x) { sp.header.push(x); });
      if (col.heavy) sp.heavy.push(col);
    });
    X.specs[table] = sp;
    return sp;
  }

  /* =========================================================== 책·시트 */

  function book() {
    if (X.book) return X.book;
    var id = props().getProperty('DB_ID');
    if (!id) throw new Error('설치가 끝나지 않았습니다. setup 을 먼저 실행하세요');
    try {
      X.book = SpreadsheetApp.openById(id);
    } catch (e) {
      throw new Error('DB 스프레드시트를 열지 못했습니다. setup 을 다시 실행하세요 (' + (e && e.message || e) + ')');
    }
    return X.book;
  }

  /** 시트 크기가 모자라면 늘린다(실제 구글 시트는 범위를 벗어난 getRange 를 거부). */
  function fit(sh, rows, cols) {
    if (rows && sh.getMaxRows) {
      var mr = sh.getMaxRows();
      if (mr < rows) sh.insertRowsAfter(mr, rows - mr);
    }
    if (cols && sh.getMaxColumns) {
      var mc = sh.getMaxColumns();
      if (mc < cols && typeof sh.insertColumnsAfter === 'function') sh.insertColumnsAfter(mc, cols - mc);
    }
  }

  function writeHeader(sh, col1, names) {
    fit(sh, 1, col1 + names.length - 1);
    var r = sh.getRange(1, col1, 1, names.length);
    r.setNumberFormat('@');
    r.setValues([names]);
    r.setFontWeight('bold');
  }

  /** 테이블 시트 정보(없으면 만들고, 빠진 열은 끝에 붙인다). 실행당 1회 머리 읽기. */
  function sheetInfo(table) {
    var inf = X.info[table];
    if (inf) return inf;
    var sp = spec(table);
    var ss = book();
    var sh = ss.getSheetByName(table);
    var header;
    if (!sh) {
      sh = ss.insertSheet(table);
      header = sp.header.slice();
      writeHeader(sh, 1, header);
      fit(sh, 0, header.length);
      sh.getRange(1, 1, Math.max(sh.getMaxRows ? sh.getMaxRows() : 1, 1), header.length).setNumberFormat('@');
      sh.setFrozenRows(1);
    } else {
      var lc = sh.getLastColumn();
      header = lc ? sh.getRange(1, 1, 1, lc).getValues()[0].map(function (v) { return cellText(v).trim(); }) : [];
      var missing = sp.header.filter(function (n) { return header.indexOf(n) < 0; });
      if (missing.length) {
        writeHeader(sh, header.length + 1, missing);
        sh.getRange(1, header.length + 1, Math.max(sh.getMaxRows ? sh.getMaxRows() : 1, 1), missing.length).setNumberFormat('@');
        header = header.concat(missing);
        if (header.length === missing.length) sh.setFrozenRows(1);
      }
    }
    var idx = {};
    header.forEach(function (n, i) { if (n && idx[n] === undefined) idx[n] = i; });
    // 큰 열 묶음이 머리의 맨 끝에 붙어 있으면 늦게 읽기를 쓴다(아니면 한 번에 다 읽음).
    var hs = -1;
    var heavyNames = [];
    sp.heavy.forEach(function (c) { heavyNames = heavyNames.concat(c.names); });
    if (heavyNames.length) {
      var pos = heavyNames.map(function (n) { return idx[n]; }).sort(function (a, b) { return a - b; });
      var lo = pos[0];
      var hi = pos[pos.length - 1];
      if (hi === header.length - 1 && hi - lo + 1 === heavyNames.length) hs = lo;
    }
    var known = {};
    sp.header.forEach(function (n) { known[n] = 1; });
    var extra = [];
    header.forEach(function (n, i) { if (!known[n]) extra.push(i); });
    inf = { sh: sh, header: header, idx: idx, width: header.length, hs: hs, extra: extra };
    X.info[table] = inf;
    return inf;
  }

  /* =========================================================== 직렬화 */

  /** 긴 JSON 문자열을 n 조각 이하로 자른다. 조각 첫 글자가 위험하면 경계를 한 칸 앞으로. 못 담으면 null. */
  function splitText(s, n) {
    var parts = [];
    var pos = 0;
    while (pos < s.length) {
      if (parts.length >= n) return null;
      var end = Math.min(s.length, pos + APP.chunkSize);
      while (end < s.length && end > pos + 1 && RISKY_START.test(s.charAt(end))) end--;
      parts.push(s.slice(pos, end));
      pos = end;
    }
    while (parts.length < n) parts.push('');
    return parts;
  }

  /** JSON 값 → 칸 조각들. 드라이브에 두면 trash 목록에 옛 파일을 넣는다. */
  function encodeJson(table, key, col, v, pend) {
    var dk = table + '|' + key + '|' + col.name;
    var old = X.drv[dk];
    var parts;
    if (v === null || v === undefined) {
      parts = [];
      for (var i = 0; i < col.chunk; i++) parts.push('');
    } else {
      var s = JSON.stringify(v);
      parts = splitText(s, col.chunk);
      if (!parts) {
        var id = putJson(v, table + '-' + (key || 'row') + '-' + col.name + '.json');
        parts = ['@drive:' + id];
        for (var j = 1; j < col.chunk; j++) parts.push('');
        pend.drv[dk] = id;
        if (old && old !== id) pend.trash.push(old);
        return parts;
      }
    }
    if (old) { pend.drv[dk] = null; pend.trash.push(old); }
    return parts;
  }

  function decodeJson(table, key, col, s) {
    if (!s) return emptyJ(col.name);
    if (s.indexOf('@drive:') === 0) {
      var id = s.slice(7).trim();
      X.drv[table + '|' + key + '|' + col.name] = id;
      try { return getJson(id); } catch (e) {
        console.warn('드라이브 JSON 을 읽지 못했습니다: ' + table + '.' + col.name + ' ' + key + ' — ' + (e && e.message));
        return emptyJ(col.name);
      }
    }
    try { return JSON.parse(s); } catch (e) {
      console.warn('JSON 해석 실패: ' + table + '.' + col.name + ' ' + key);
      return emptyJ(col.name);
    }
  }

  /** 값 하나를 타입에 맞게 고른다(메모에 넣는 모양). */
  function normVal(col, v) {
    switch (col.type) {
      case 'b': return toBool(v);
      case 'n': return toNum(v);
      case 'j':
        if (v === undefined || v === null || v === '') return emptyJ(col.name);
        if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return v; } }
        return v;
      default:
        if (v === null || v === undefined) return '';
        if (isDate(v)) return dateText(v);
        return String(v);
    }
  }

  function lazyDesc(o, name) {
    var d = Object.getOwnPropertyDescriptor(o, name);
    return d && d.get && d.get.lazy ? d : null;
  }

  /** 객체 → 메모 모양(SCHEMA 열만, 타입 맞춤). 늦게 읽는 열은 그대로 옮긴다. */
  function normalize(sp, obj) {
    var out = {};
    sp.cols.forEach(function (c) {
      var d = lazyDesc(obj, c.name);
      if (d) { Object.defineProperty(out, c.name, d); return; }
      out[c.name] = normVal(c, obj[c.name]);
    });
    if (sp.key) out[sp.key] = String(out[sp.key] || '').trim();
    return out;
  }

  /** 늦게 읽는 열의 접근자. 처음 읽을 때 그 테이블의 큰 열을 한꺼번에 읽고 값으로 바꿔 둔다. */
  function makeLazy(obj, table, key, colName) {
    var getter = function () {
      var v = heavyValue(table, key, colName);
      Object.defineProperty(this, colName, { value: v, writable: true, enumerable: true, configurable: true });
      return v;
    };
    getter.lazy = true;
    Object.defineProperty(obj, colName, {
      get: getter,
      set: function (v) { Object.defineProperty(this, colName, { value: v, writable: true, enumerable: true, configurable: true }); },
      enumerable: true,
      configurable: true
    });
  }

  function heavyValue(table, key, colName) {
    var sp = spec(table);
    var col = sp.cols.filter(function (c) { return c.name === colName; })[0];
    var m = memo(table);
    var i = m.pos[key];
    if (i === undefined) return emptyJ(colName);
    var cur = m.rows[i];
    var d = Object.getOwnPropertyDescriptor(cur, colName);
    if (d && !(d.get && d.get.lazy)) return d.value;
    var inf = sheetInfo(table);
    var r = heavyRow(m, key, m.rowOf[key]);
    var s = col.names.map(function (n) { return cellText(r[inf.idx[n] - inf.hs]); }).join('');
    var v = decodeJson(table, key, col, s);
    Object.defineProperty(cur, colName, { value: v, writable: true, enumerable: true, configurable: true });
    return v;
  }

  /**
   * 한 행의 큰 열 원본 값. 기록 1건 조회·수정처럼 몇 건만 읽을 때는 그 행만 읽고(기록 수와 무관),
   * 한 실행에서 SINGLE_MAX 건을 넘게 읽으면(목록·내보내기·재구축) 그때 전 행을 한 번에 읽는다.
   */
  function heavyRow(m, key, row) {
    if (m.block || !key) return heavyBlock(m)[row - 2] || [];
    m.single = m.single || {};
    if (m.single[key]) return m.single[key];
    m.nSingle = (m.nSingle || 0) + 1;
    if (m.nSingle > SINGLE_MAX) return heavyBlock(m)[row - 2] || [];
    var inf = sheetInfo(m.table);
    var r = row >= 2 && row <= m.last ? inf.sh.getRange(row, inf.hs + 1, 1, inf.width - inf.hs).getValues()[0] : [];
    m.single[key] = r;
    return r;
  }

  function heavyBlock(m) {
    if (m.block) return m.block;
    var inf = sheetInfo(m.table);
    var n = m.last - 1;
    m.block = n > 0 ? inf.sh.getRange(2, inf.hs + 1, n, inf.width - inf.hs).getValues() : [];
    return m.block;
  }

  /* =========================================================== 읽기·메모 */

  function memo(table, fresh) {
    var m = X.memo[table];
    if (m && !fresh && Date.now() - m.at < MEMO_TTL) return m;
    m = load(table);
    X.memo[table] = m;
    return m;
  }

  function load(table) {
    var sp = spec(table);
    var inf = sheetInfo(table);
    var sh = inf.sh;
    var last = sh.getLastRow();
    var m = { table: table, rows: [], pos: {}, rowOf: {}, rowNums: [], last: Math.max(last, 1), block: null, extras: {}, at: Date.now() };
    if (last < 2 || !inf.width) return m;
    var lightW = inf.hs >= 0 ? inf.hs : inf.width;
    var vals = sh.getRange(2, 1, last - 1, lightW).getValues();
    var kIdx = sp.key ? inf.idx[sp.key] : -1;
    for (var i = 0; i < vals.length; i++) {
      var row = vals[i];
      var key = null;
      if (sp.key) {
        key = cellText(row[kIdx]).trim();
        if (!key) continue;
        if (m.pos[key] !== undefined) { console.warn('같은 키가 두 번 있습니다: ' + table + ' ' + key + ' (' + (i + 2) + '행은 무시)'); continue; }
      } else if (row.every(function (v) { return v === '' || v === null; })) {
        continue;
      }
      var obj = {};
      for (var c = 0; c < sp.cols.length; c++) {
        var col = sp.cols[c];
        if (col.heavy && inf.hs >= 0) { makeLazy(obj, table, key, col.name); continue; }
        if (col.type === 'j') {
          var s = '';
          for (var k = 0; k < col.names.length; k++) {
            var ci = inf.idx[col.names[k]];
            if (ci !== undefined) s += cellText(row[ci]);
          }
          obj[col.name] = decodeJson(table, key, col, s);
        } else {
          var ci2 = inf.idx[col.name];
          obj[col.name] = normVal(col, ci2 === undefined ? '' : (col.type === 's' ? cellText(row[ci2]) : row[ci2]));
        }
      }
      if (sp.key) obj[sp.key] = key;
      if (inf.extra.length) {
        var ex = {};
        inf.extra.forEach(function (ci3) { if (ci3 < lightW) ex[ci3] = row[ci3]; });
        if (key) m.extras[key] = ex;
      }
      m.rows.push(obj);
      m.rowNums.push(i + 2);
      if (sp.key) { m.pos[key] = m.rows.length - 1; m.rowOf[key] = i + 2; }
    }
    return m;
  }

  /* =========================================================== 쓰기 */

  /**
   * 객체 → 시트 한 행. light=true 면 큰 열을 쓰지 않는다(늦게 읽기 열을 건드리지 않은 경우).
   * 반환 { cells, light }
   */
  function encodeRow(table, obj, pend, allowLight) {
    var sp = spec(table);
    var inf = sheetInfo(table);
    var key = sp.key ? String(obj[sp.key] || '').trim() : '';
    var cells = new Array(inf.width);
    for (var i = 0; i < inf.width; i++) cells[i] = '';
    var light = !!allowLight && inf.hs >= 0 && sp.heavy.length > 0 &&
      sp.heavy.every(function (c) { return !!lazyDesc(obj, c.name); });
    sp.cols.forEach(function (col) {
      if (col.heavy && light) return;
      var v = obj[col.name];
      if (col.type === 'j') {
        var parts = encodeJson(table, key, col, normVal(col, v), pend);
        col.names.forEach(function (n, k) { var ci = inf.idx[n]; if (ci !== undefined) cells[ci] = parts[k] || ''; });
        return;
      }
      var ci = inf.idx[col.name];
      if (ci === undefined) return;
      if (col.type === 'b') cells[ci] = toBool(v) ? 'Y' : '';
      else if (col.type === 'n') { var n = toNum(v); cells[ci] = n === null ? '' : String(n); }
      else cells[ci] = (v === null || v === undefined) ? '' : safeText(isDate(v) ? dateText(v) : v);
    });
    var m = X.memo[table];
    var ex = m && key && m.extras[key];
    if (ex) Object.keys(ex).forEach(function (ci) { cells[Number(ci)] = ex[ci]; });
    return { cells: cells, light: light, key: key };
  }

  function newPend() { return { drv: {}, trash: [] }; }

  /** 쓰기가 끝난 뒤: 드라이브 참조 기억 갱신, 옛 JSON 파일 휴지통. */
  function settle(pend) {
    Object.keys(pend.drv).forEach(function (k) {
      if (pend.drv[k]) X.drv[k] = pend.drv[k]; else delete X.drv[k];
    });
    pend.trash.forEach(function (id) {
      try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { console.warn('옛 JSON 파일 정리 실패: ' + id); }
    });
  }

  /**
   * items = [{row, enc}] 를 행 번호순으로 이어진 구간마다 setValues 한 번.
   * 구간 안에 큰 열을 바꾸는 행이 하나라도 있으면 그 구간은 전체 폭으로 쓰고, 나머지 행의 큰 열은 시트 원래 값을 옮겨 쓴다.
   */
  function writeItems(table, m, items) {
    if (!items.length) return;
    var inf = sheetInfo(table);
    var sh = inf.sh;
    items.sort(function (a, b) { return a.row - b.row; });
    var maxRow = items[items.length - 1].row;
    fit(sh, maxRow, inf.width);
    var runs = [];
    var cur = null;
    items.forEach(function (it) {
      if (cur && it.row === cur.start + cur.items.length) cur.items.push(it);
      else { cur = { start: it.row, items: [it] }; runs.push(cur); }
    });
    runs.forEach(function (run) {
      var light = run.items.every(function (it) { return it.enc.light; });
      var w = light ? inf.hs : inf.width;
      var vals = run.items.map(function (it) {
        if (!light && it.enc.light) {
          // 이 행은 큰 열을 바꾸지 않았다 — 시트에 있는 그대로 다시 쓴다.
          var raw = it.row <= m.last ? heavyRow(m, it.enc.key, it.row) : [];
          for (var c = inf.hs; c < inf.width; c++) it.enc.cells[c] = raw[c - inf.hs] === undefined ? '' : raw[c - inf.hs];
        }
        return it.enc.cells.slice(0, w);
      });
      var rng = sh.getRange(run.start, 1, vals.length, w);
      rng.setNumberFormat('@');
      rng.setValues(vals);
    });
  }

  /** 메모에 한 행 반영(있으면 바꾸고 없으면 붙임). 큰 열 블록은 바뀐 행만 무효화. */
  function memoPut(m, key, row, obj) {
    var i = m.pos[key];
    if (i === undefined) {
      m.rows.push(obj);
      m.rowNums.push(row);
      m.pos[key] = m.rows.length - 1;
      m.rowOf[key] = row;
      if (row > m.last) {
        if (m.block) { while (m.block.length < row - 1) m.block.push([]); }
        m.last = row;
      }
    } else {
      m.rows[i] = obj;
    }
  }

  function keyOf(sp, obj) {
    if (!sp.key) fail('SERVER', sp.table + ' 테이블에는 키가 없습니다');
    var k = String((obj && obj[sp.key]) || '').trim();
    if (!k) fail('INVALID', sp.table + ' 저장에 키(' + sp.key + ')가 없습니다');
    return k;
  }

  /** 기존 객체에 patch 를 덮는다(undefined 는 건너뜀). 늦게 읽는 열은 건드리지 않으면 그대로 둔다. */
  function merge(sp, cur, patch) {
    var out = {};
    Object.keys(cur).forEach(function (k) {
      var d = Object.getOwnPropertyDescriptor(cur, k);
      if (d.get && d.get.lazy) Object.defineProperty(out, k, d);
      else out[k] = d.value;
    });
    Object.keys(patch || {}).forEach(function (k) {
      if (k === sp.key) return;
      var d = Object.getOwnPropertyDescriptor(patch, k);
      // 같은 키의 늦게 읽기 열은 시트의 같은 칸을 가리키므로 기존 것을 그대로 둔다.
      if (d.get && d.get.lazy) return;
      if (d.value === undefined) return;
      out[k] = d.value;
    });
    return out;
  }

  function insert(table, obj) {
    return withLock(function () {
      var sp = spec(table);
      var m = memo(table);
      var key = keyOf(sp, obj);
      if (m.pos[key] !== undefined) fail('CONFLICT', '이미 있는 항목입니다: ' + key);
      var norm = normalize(sp, obj);
      var pend = newPend();
      var enc = encodeRow(table, norm, pend, false);
      var row = m.last + 1;
      writeItems(table, m, [{ row: row, enc: enc }]);
      settle(pend);
      memoPut(m, key, row, norm);
      return norm;
    });
  }

  function update(table, key, patch) {
    return withLock(function () {
      var sp = spec(table);
      var m = memo(table);
      key = String(key || '').trim();
      var i = m.pos[key];
      if (i === undefined) fail('NOTFOUND', '찾을 수 없습니다: ' + key);
      var norm = normalize(sp, merge(sp, m.rows[i], patch));
      norm[sp.key] = key;
      var pend = newPend();
      var enc = encodeRow(table, norm, pend, true);
      writeItems(table, m, [{ row: m.rowOf[key], enc: enc }]);
      settle(pend);
      memoPut(m, key, m.rowOf[key], norm);
      return norm;
    });
  }

  function upsert(table, obj) {
    return withLock(function () {
      var sp = spec(table);
      var m = memo(table);
      var key = keyOf(sp, obj);
      if (m.pos[key] === undefined) return insert(table, obj);
      return update(table, key, obj);
    });
  }

  /** 여러 개를 한 번에. 같은 키가 겹치면 마지막 것. 반환: 저장한 개수. */
  function upsertMany(table, objs) {
    objs = (objs || []).filter(Boolean);
    if (!objs.length) return 0;
    return withLock(function () {
      var sp = spec(table);
      var m = memo(table);
      var order = [];
      var byKey = {};
      objs.forEach(function (o) {
        var k = keyOf(sp, o);
        if (!byKey[k]) order.push(k);
        byKey[k] = o;
      });
      var pend = newPend();
      var items = [];
      var next = m.last + 1;
      var puts = [];
      order.forEach(function (k) {
        var o = byKey[k];
        var norm;
        var row;
        var exists = m.pos[k] !== undefined;
        if (exists) {
          norm = normalize(sp, merge(sp, m.rows[m.pos[k]], o));
          row = m.rowOf[k];
        } else {
          norm = normalize(sp, o);
          row = next++;
        }
        norm[sp.key] = k;
        items.push({ row: row, enc: encodeRow(table, norm, pend, exists) });
        puts.push([k, row, norm]);
      });
      writeItems(table, m, items);
      settle(pend);
      puts.forEach(function (p) { memoPut(m, p[0], p[1], p[2]); });
      return order.length;
    });
  }

  /** 행 삭제(sessions 정리 등). 반환: 지웠는지. */
  function remove(table, key) {
    return withLock(function () {
      var sp = spec(table);
      if (!sp.key) fail('SERVER', table + ' 테이블은 키로 지울 수 없습니다');
      var m = memo(table);
      key = String(key || '').trim();
      var i = m.pos[key];
      if (i === undefined) return false;
      var row = m.rowOf[key];
      sheetInfo(table).sh.deleteRows(row, 1);
      m.rows.splice(i, 1);
      m.rowNums.splice(i, 1);
      if (m.block && row - 2 < m.block.length) m.block.splice(row - 2, 1);
      if (m.single) delete m.single[key];
      delete m.extras[key];
      m.last = Math.max(1, m.last - 1);
      m.pos = {};
      m.rowOf = {};
      for (var j = 0; j < m.rows.length; j++) {
        if (m.rowNums[j] > row) m.rowNums[j]--;
        var k = m.rows[j][sp.key];
        m.pos[k] = j;
        m.rowOf[k] = m.rowNums[j];
      }
      var pend = newPend();
      sp.cols.forEach(function (c) {
        var dk = table + '|' + key + '|' + c.name;
        if (X.drv[dk]) { pend.trash.push(X.drv[dk]); pend.drv[dk] = null; }
      });
      settle(pend);
      return true;
    });
  }

  /** 테이블 전체 바꾸기. 순서대로 2행부터 쓴다. */
  function replaceAll(table, objs) {
    return withLock(function () {
      var sp = spec(table);
      var inf = sheetInfo(table);
      var m = memo(table);
      var list = [];
      var seen = {};
      (objs || []).filter(Boolean).forEach(function (o) {
        if (sp.key) {
          var k = keyOf(sp, o);
          if (seen[k] !== undefined) { list[seen[k]] = o; return; }
          seen[k] = list.length;
        }
        list.push(o);
      });
      var pend = newPend();
      // 늦게 읽는 열은 지우기 전에 값을 확정해야 한다(normalize 가 접근자를 옮기므로 여기서 값으로 바꿈).
      var norms = list.map(function (o) {
        var n = normalize(sp, o);
        sp.heavy.forEach(function (c) { if (lazyDesc(n, c.name)) { var v = n[c.name]; n[c.name] = v; } });
        return n;
      });
      var oldDrv = [];
      Object.keys(X.drv).forEach(function (dk) { if (dk.indexOf(table + '|') === 0) oldDrv.push(X.drv[dk]); });
      var rows = norms.map(function (n) { return encodeRow(table, n, pend, false).cells; });
      var keepIds = {};
      Object.keys(pend.drv).forEach(function (k) { if (pend.drv[k]) keepIds[pend.drv[k]] = 1; });
      if (m.last >= 2) inf.sh.getRange(2, 1, m.last - 1, inf.width).clearContent();
      if (rows.length) {
        fit(inf.sh, rows.length + 1, inf.width);
        for (var off = 0; off < rows.length; off += 5000) {
          var part = rows.slice(off, off + 5000);
          var rng = inf.sh.getRange(2 + off, 1, part.length, inf.width);
          rng.setNumberFormat('@');
          rng.setValues(part);
        }
      }
      pend.trash = pend.trash.concat(oldDrv).filter(function (id, i, a) { return !keepIds[id] && a.indexOf(id) === i; });
      Object.keys(X.drv).forEach(function (dk) { if (dk.indexOf(table + '|') === 0 && pend.drv[dk] === undefined) pend.drv[dk] = null; });
      settle(pend);
      var nm = { table: table, rows: [], pos: {}, rowOf: {}, rowNums: [], last: rows.length + 1, block: null, extras: {}, at: Date.now() };
      norms.forEach(function (n, i) {
        nm.rows.push(n);
        nm.rowNums.push(i + 2);
        if (sp.key) { nm.pos[n[sp.key]] = i; nm.rowOf[n[sp.key]] = i + 2; }
      });
      X.memo[table] = nm;
      return norms.length;
    });
  }

  /** 키 없는 테이블(log)에 한 행 붙이기. appendRow 는 원자적이라 잠금 없이 쓴다. */
  function append(table, obj) {
    var sp = spec(table);
    var inf = sheetInfo(table);
    var norm = normalize(sp, obj || {});
    var pend = newPend();
    var enc = encodeRow(table, norm, pend, false);
    inf.sh.appendRow(enc.cells);
    settle(pend);
    delete X.memo[table];
    return norm;
  }

  /* =========================================================== 잠금 */

  /** ScriptLock 안에서 fn 실행. 다시 들어와도 안전(가장 바깥만 잠그고 풂). */
  function withLock(fn) {
    if (X.depth > 0) {
      X.depth++;
      try { return fn(); } finally { X.depth--; }
    }
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(APP.lockMs);
    } catch (e) {
      fail('SERVER', '다른 저장 작업이 진행 중입니다. 잠시 후 다시 시도하세요');
    }
    X.depth = 1;
    X.memo = {};
    try {
      return fn();
    } finally {
      X.depth = 0;
      try { SpreadsheetApp.flush(); } catch (e) { /* 미리보기 모의에는 없을 수 있음 */ }
      try { lock.releaseLock(); } catch (e) { console.warn('잠금 해제 실패'); }
    }
  }

  /* =========================================================== kv·설정·로그 */

  function kvGet(key, def) {
    var row = get('kv', key);
    if (!row || row.value === null || row.value === undefined) return def;
    return row.value;
  }

  function kvSet(key, value) {
    upsert('kv', { key: String(key), value: value === undefined ? null : value });
    return value;
  }

  function deepMerge(a, b) {
    if (!isPlain(b)) return a;
    Object.keys(b).forEach(function (k) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
      var v = b[k];
      if (v === undefined) return;
      if (isPlain(v) && isPlain(a[k])) a[k] = deepMerge(a[k], v);
      else a[k] = clone(v);
    });
    return a;
  }

  /** DEFAULT_SETTINGS 위에 저장된 설정을 깊게 덮은 새 객체. */
  function settings() {
    return deepMerge(clone(DEFAULT_SETTINGS), kvGet('settings', {}) || {});
  }

  function saveSettings(obj) {
    return withLock(function () {
      var merged = deepMerge(settings(), obj || {});
      kvSet('settings', merged);
      return clone(merged);
    });
  }

  /** 감사·메일 기록. 5,000행을 넘으면 오래된 것부터 정리. */
  function log(who, kind, ref, text) {
    append('log', {
      at: now(),
      who: String(who || '').slice(0, 200),
      kind: String(kind || '').slice(0, 60),
      ref: String(ref || '').slice(0, 200),
      text: String(text || '').slice(0, 2000)
    });
    try {
      var sh = sheetInfo('log').sh;
      var n = sh.getLastRow() - 1;
      if (n > LOG_MAX + LOG_SLACK) {
        var lock = LockService.getScriptLock();
        var mine = X.depth > 0;
        if (mine || lock.tryLock(2000)) {
          try {
            var cnt = sh.getLastRow() - 1 - LOG_MAX;
            if (cnt > 0) sh.deleteRows(2, cnt);
          } finally {
            if (!mine) lock.releaseLock();
          }
          delete X.memo.log;
        }
      }
    } catch (e) {
      console.warn('로그 정리 실패: ' + (e && e.message));
    }
  }

  /* =========================================================== 조회 */

  function all(table, opts) {
    return memo(table, !!(opts && opts.fresh)).rows.slice();
  }

  function get(table, key) {
    if (key === null || key === undefined || key === '') return null;
    var m = memo(table);
    var i = m.pos[String(key).trim()];
    return i === undefined ? null : m.rows[i];
  }

  function find(table, fn) {
    return memo(table).rows.filter(fn);
  }

  /* =========================================================== 시각·ID */

  function now() { return Utilities.formatDate(new Date(), APP.tz, "yyyy-MM-dd'T'HH:mm:ss"); }
  function today() { return Utilities.formatDate(new Date(), APP.tz, 'yyyy-MM-dd'); }

  function addDays(ymd, n) {
    var p = String(ymd || '').slice(0, 10).split('-');
    var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + Number(n || 0)));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function yymmdd(ymd) { var s = String(ymd || '').replace(/-/g, ''); return s.slice(2, 8); }
  function yymm(ymd) { var s = String(ymd || '').replace(/-/g, ''); return s.slice(2, 6); }

  function hash(salt, text) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(salt || '') + ':' + String(text || ''), Utilities.Charset.UTF_8);
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
      out += (b < 16 ? '0' : '') + b.toString(16);
    }
    return out;
  }

  function uuid8() { return Utilities.getUuid().replace(/-/g, '').slice(0, 8).toLowerCase(); }
  function token() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }

  /** 헷갈리는 글자(0 O 1 l I) 없는 임의 문자열. 숫자·영문이 하나씩은 들어간다. */
  function randomCode(len) {
    len = len || 10;
    for (var tries = 0; tries < 20; tries++) {
      var hex = '';
      while (hex.length < len * 2) hex += Utilities.getUuid().replace(/-/g, '');
      var s = '';
      for (var i = 0; i < len; i++) s += PW_CHARS.charAt(parseInt(hex.substr(i * 2, 2), 16) % PW_CHARS.length);
      if (/[0-9]/.test(s) && /[A-Za-z]/.test(s)) return s;
    }
    return s;
  }

  /* =========================================================== 양식 정의 */

  function forms() {
    if (X.fd) return X.fd;
    var html = HtmlService.createHtmlOutputFromFile('FormsData').getContent();
    var a = html.indexOf('{');
    var b = html.lastIndexOf('}');
    if (a < 0 || b < a) fail('SERVER', '양식 정의(FormsData)를 읽지 못했습니다');
    X.fd = JSON.parse(html.slice(a, b + 1));
    X.fdMap = {};
    (X.fd.forms || []).forEach(function (f) { X.fdMap[f.code] = f; });
    return X.fd;
  }

  function form(code) {
    forms();
    return X.fdMap[String(code || '')] || null;
  }

  /* =========================================================== 드라이브 */

  function rootFolder() {
    if (X.folders['']) return X.folders[''];
    var id = props().getProperty('FOLDER_ID');
    if (!id) throw new Error('설치가 끝나지 않았습니다. setup 을 먼저 실행하세요');
    X.folders[''] = DriveApp.getFolderById(id);
    return X.folders[''];
  }

  /** 루트 폴더 또는 하위 폴더(사업장 코드·'exports' 등). 하위 폴더 id 는 kv 'folders' 에 기억. */
  function folder(siteId) {
    var root = rootFolder();
    if (!siteId) return root;
    var k = String(siteId).trim();
    if (X.folders[k]) return X.folders[k];
    var known = (kvGet('folders', {}) || {})[k];
    if (known) {
      try { X.folders[k] = DriveApp.getFolderById(known); return X.folders[k]; } catch (e) { /* 지워졌으면 새로 만든다 */ }
    }
    return withLock(function () {
      var map = kvGet('folders', {}) || {};
      if (map[k] && map[k] !== known) {
        try { X.folders[k] = DriveApp.getFolderById(map[k]); return X.folders[k]; } catch (e) { /* 새로 만든다 */ }
      }
      var name = k;
      if (/^[A-Z0-9]{2,8}$/.test(k)) {
        var s = get('sites', k);
        if (s && s.name) name = k + ' ' + s.name;
      }
      var f = root.createFolder(name);
      map = isPlain(map) ? map : {};
      map[k] = f.getId();
      kvSet('folders', map);
      X.folders[k] = f;
      return f;
    });
  }

  function safeName(name) {
    var s = String(name || '').replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
    return (s || ('file-' + uuid8())).slice(0, 120);
  }

  /** dataUrl → 드라이브 파일. 반환 {driveId, mime, size}. */
  function saveDataUrl(dataUrl, name, siteId) {
    var s = String(dataUrl || '');
    var comma = s.indexOf(',');
    if (s.indexOf('data:') !== 0 || comma < 0) fail('INVALID', '파일 형식이 올바르지 않습니다');
    var head = s.slice(5, comma);
    var body = s.slice(comma + 1);
    var mime = (head.split(';')[0] || 'application/octet-stream').toLowerCase();
    var bytes;
    try {
      bytes = /;\s*base64/i.test(head) ? Utilities.base64Decode(body) : Utilities.newBlob(decodeURIComponent(body)).getBytes();
    } catch (e) {
      fail('INVALID', '파일 내용이 깨졌습니다. 다시 골라 올려 주세요');
    }
    if (bytes.length > APP.maxFileBytes) fail('INVALID', '파일이 너무 큽니다. 8MB 이하만 올릴 수 있습니다');
    if (!bytes.length) fail('INVALID', '빈 파일은 올릴 수 없습니다');
    var file = folder(siteId).createFile(Utilities.newBlob(bytes, mime, safeName(name)));
    return { driveId: file.getId(), mime: mime, size: bytes.length };
  }

  /** 이미 해독·검사한 바이트 → 드라이브 파일. 반환 {driveId, mime, size}. */
  function saveBytes(bytes, mime, name, siteId) {
    if (!bytes || !bytes.length) fail('INVALID', '빈 파일은 올릴 수 없습니다');
    if (bytes.length > APP.maxFileBytes) fail('INVALID', '파일이 너무 큽니다. 8MB 이하만 올릴 수 있습니다');
    var file = folder(siteId).createFile(Utilities.newBlob(bytes, mime || 'application/octet-stream', safeName(name)));
    return { driveId: file.getId(), mime: mime, size: bytes.length };
  }

  function readDataUrl(driveId) {
    var file = DriveApp.getFileById(String(driveId));
    var blob = file.getBlob();
    var mime = blob.getContentType() || file.getMimeType() || 'application/octet-stream';
    return 'data:' + mime + ';base64,' + Utilities.base64Encode(blob.getBytes());
  }

  function putJson(obj, name) {
    var blob = Utilities.newBlob(JSON.stringify(obj), 'application/json', safeName(name || ('data-' + uuid8() + '.json')));
    return folder('_json').createFile(blob).getId();
  }

  function getJson(driveId) {
    return JSON.parse(DriveApp.getFileById(String(driveId)).getBlob().getDataAsString());
  }

  /* =========================================================== 기타 */

  /** 실행 단위 메모 모두 비우기(설치 직후·미리보기 시험용). */
  function reset() {
    X.book = null;
    X.info = {};
    X.memo = {};
    X.folders = {};
  }

  function sheet(table) { return sheetInfo(table).sh; }

  return {
    book: book, sheet: sheet, all: all, get: get, find: find,
    insert: insert, update: update, upsert: upsert, upsertMany: upsertMany, remove: remove, replaceAll: replaceAll, append: append,
    withLock: withLock, kvGet: kvGet, kvSet: kvSet, settings: settings, saveSettings: saveSettings, log: log,
    hash: hash, uuid8: uuid8, token: token, randomCode: randomCode,
    now: now, today: today, addDays: addDays, yymmdd: yymmdd, yymm: yymm,
    forms: forms, form: form, folder: folder, saveDataUrl: saveDataUrl, saveBytes: saveBytes, readDataUrl: readDataUrl, putJson: putJson, getJson: getJson,
    fit: fit, reset: reset, deepMerge: deepMerge
  };
})();


/* ======================================================================
 * Dispatch.gs
 * ==================================================================== */

/**
 * Dispatch.gs — 배포(요청·공지)·열람·독촉·메일 템플릿·정기 점검. SPEC §5·§6.
 *
 * 공개(Api.gs 가 부름)
 *   Dispatch.saveRequest(p, me)  → {request, mailed}   요청 새로 만들기·고치기(새로 만들면 대상 사업장 담당자에게 메일)
 *   Dispatch.closeRequest(p, me) → {request}           진행·마감·취소
 *   Dispatch.remind(p, me)       → {sent, skipped, done, sites:[{site, result}], note?}
 *   Dispatch.markRead(p, me)     → {read}              같은 사업장·refId 가 있으면 그대로 돌려줌
 *   Dispatch.onRecordSubmitted(rec, me, prevRecord)    F04·F10 단계 제출 → 본사 즉시 메일
 *   Dispatch.onReviewed(rec, decision, me)             반려 → 사업장 담당자 메일
 *   Dispatch.dueStatus(siteId, refYmd) → [{form, period:{key,from,to,label}, due, status:'ok'|'late'|'miss'|'pending'|'na', label, dueAt?, done?, need?, recId?}]
 *   Dispatch.mail(to, subject, html, opt?) → true|false
 *   Dispatch.template(kind, ctx) → 메일 HTML(인라인 스타일)
 *   Dispatch.daily() / Dispatch.weekly() — 전역 cronDaily() / cronWeekly() 가 부른다(트리거).
 *   보조: Dispatch.periodOf(type, ymd), Dispatch.dueOf(def, period), Dispatch.siteLink(site), Dispatch.recordLink(id)
 *
 * 규칙
 *   - 다른 파일의 객체(Db·Auth·SCHEMA 등)는 함수 안에서만 참조한다(붙여넣기 파일 순서와 무관하게 동작).
 *   - 시트는 표마다 한 번씩만 읽는다(makeCtx 메모 + Db 실행 메모). records 는 data(늦게 읽는 열)를 건드리지 않는다.
 *   - 메일은 사업장당 한 통으로 모아서 보낸다. 성공·실패·건너뜀 모두 log(kind 'mail') 에 남긴다.
 */
var Dispatch = (function () {
  'use strict';

  var SUBMITTED = { '제출': true, '확인': true };
  var OPEN_ACT = { '등록': true, '조치중': true };
  var REQ_STATUS = ['진행', '마감', '취소'];
  var INCIDENT_FORMS = { F04: true, F10: true };
  var INCIDENT_FACTS = {
    F04: ['kind', 'serious', 'occurredAt', 'accType', 'area', 'injured', 'injuredCount', 'hospital'],
    F10: ['swType', 'hazardTypes', 'evacState', 'injured', 'hazardAt', 'stopAt', 'resumeType']
  };
  var FREQ_LABEL = { daily: '매일', monthly: '매월', quarterly: '분기', half: '반기', annual: '연 1회', season: '계절', event: '수시' };
  var KIND_LABEL = {
    request: '배포 요청', notice: '공지', remind: '제출 독촉', incident: '사고 즉시 보고', 'return': '반려 안내',
    acts: '조치 기한경과', weekly: '주간 안전 요약', test: '메일 시험'
  };
  var C = { ink: '#14183c', brand: '#223189', muted: '#555a75', faint: '#676b84', border: '#e4e6ee', neg: '#c8281d', bg: '#ffffff' };
  var FONT = "Pretendard,'Apple SD Gothic Neo','Malgun Gothic',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
  var DAY_MS = 86400000;
  var EMAIL_RE = /^[^\s@,;<>()"']+@[^\s@,;<>()"'.]+(\.[^\s@,;<>()"'.]+)+$/;
  var TIME_BUDGET_MS = 5 * 60 * 1000; // 6분 제한 안에서 여유를 둔다
  var WEEK = ['일', '월', '화', '수', '목', '금', '토'];

  /* ───────────── 기본 도구 ───────────── */

  function fail(code, msg) {
    var e = new Error(msg);
    e.code = code;
    throw e;
  }
  function msgOf(e) { return String((e && e.message) || e || '알 수 없는 오류'); }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function arr(v) { return Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function dedupe(list) {
    var seen = {}, out = [];
    list.forEach(function (x) { if (!seen[x]) { seen[x] = true; out.push(x); } });
    return out;
  }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function assign(a, b) {
    var o = {};
    Object.keys(a || {}).forEach(function (k) { o[k] = a[k]; });
    Object.keys(b || {}).forEach(function (k) { o[k] = b[k]; });
    return o;
  }
  function merge(base, over) {
    var out = {};
    Object.keys(base || {}).forEach(function (k) { out[k] = base[k]; });
    Object.keys(over || {}).forEach(function (k) {
      var b = out[k], o = over[k];
      if (o === undefined) return;
      out[k] = (isObj(b) && isObj(o)) ? merge(b, o) : o;
    });
    return out;
  }

  /* 날짜는 'YYYY-MM-DD' 문자열로만 계산한다(UTC 산술 — 시간대 영향 없음). */
  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  }
  function ymdOf(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function isYmd(s) {
    s = String(s || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(s) && ymdOf(parseYmd(s)) === s;
  }
  function addDays(s, n) { var t = parseYmd(s); return isNaN(t) ? '' : ymdOf(t + n * DAY_MS); }
  function daysDiff(a, b) {
    var x = parseYmd(a), y = parseYmd(b);
    return (isNaN(x) || isNaN(y)) ? NaN : Math.round((y - x) / DAY_MS);
  }
  function monthNo(s) { return Number(String(s || '').slice(5, 7)); }
  function dateOf(v) { var s = String(v || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ''; }
  function tz() { return (typeof APP !== 'undefined' && APP && APP.tz) || 'Asia/Seoul'; }
  function today() {
    try { var t = Db.today(); if (isYmd(t)) return t; } catch (e) { /* 아래 대체 */ }
    return Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd');
  }
  function now() {
    try { var t = Db.now(); if (t) return String(t); } catch (e) { /* 아래 대체 */ }
    return Utilities.formatDate(new Date(), tz(), "yyyy-MM-dd'T'HH:mm:ss");
  }
  function yymmdd(ymd) { return String(ymd).slice(2, 4) + String(ymd).slice(5, 7) + String(ymd).slice(8, 10); }
  function weekday(ymd) { var t = parseYmd(ymd); return isNaN(t) ? '' : WEEK[new Date(t).getUTCDay()]; }
  /** '2026-11-05' → '11월 5일(목)' */
  function fmtDay(ymd) {
    if (!isYmd(ymd)) return str(ymd);
    return Number(ymd.slice(5, 7)) + '월 ' + Number(ymd.slice(8, 10)) + '일(' + weekday(ymd) + ')';
  }
  /** '2026-11-05T09:30:00' → '2026-11-05 09:30' */
  function fmtDT(v) {
    var s = str(v);
    var m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(s);
    if (!m) return s;
    return m[2] ? m[1] + ' ' + m[2] : m[1];
  }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n >= 1048576) return (Math.round(n / 104857.6) / 10) + 'MB';
    if (n >= 1024) return Math.round(n / 1024) + 'KB';
    return n + 'B';
  }
  function pct(a, b) { return b > 0 ? Math.round(a / b * 1000) / 10 : null; }

  /* ───────────── 설정·사람·링크 ───────────── */

  function settings() {
    var s = null;
    try { s = Db.settings(); } catch (e) { s = null; }
    var base = (typeof DEFAULT_SETTINGS !== 'undefined' && DEFAULT_SETTINGS) ? DEFAULT_SETTINGS : {};
    var out = merge(base, isObj(s) ? s : {});
    if (!isObj(out.mail)) out.mail = {};
    if (!isObj(out.reminder)) out.reminder = {};
    if (!isObj(out.requiredForms)) out.requiredForms = {};
    return out;
  }
  function appName(st) { return str(st && st.appName) || (typeof APP !== 'undefined' && APP.name) || 'HDS 안전장부'; }
  function tag(st) { return '[' + appName(st) + '] '; }

  function appUrl() {
    try { return String(ScriptApp.getService().getUrl() || ''); } catch (e) { return ''; }
  }
  /** 웹앱 링크에 쿼리 하나 붙이기 */
  function withParam(url, k, v) { return url + (url.indexOf('?') >= 0 ? '&' : '?') + k + '=' + encodeURIComponent(v); }
  /**
   * 사업장 링크(…/exec?s=토큰). view 를 주면 &v=<화면>(예: 'rec/ID') — doGet 이 BOOT.view 로 넘겨 첫 화면이 된다.
   * 메일 링크에 '#/…' 해시를 쓰지 않는 까닭: GAS 웹앱은 iframe 안에서 돌아 최상위 해시가 앱에 바로 보이지 않는다.
   */
  function siteLink(site, view) {
    var url = appUrl();
    if (!url) return '';
    var tok = site && str(site.token);
    var out = tok ? withParam(url, 's', tok) : url;
    return view ? withParam(out, 'v', view) : out;
  }
  function recordLink(id) {
    var url = appUrl();
    return url ? withParam(url, 'v', 'rec/' + id) : '';
  }

  function whoOf(me) {
    if (!me) return 'system';
    if (typeof me === 'string') return me;
    var name = me.name || me.id || '(이름 없음)';
    if (me.kind === 'site') return name + ' (' + (me.site || '') + ')';
    return me.id ? name + ' (' + me.id + ')' : name;
  }
  function log(who, kind, ref, text) {
    try { Db.log(who || 'system', kind, ref || '', text || ''); } catch (e) { console.warn('기록 실패: ' + msgOf(e)); }
  }

  /** 문자열(쉼표·세미콜론·공백 구분) 또는 배열 → 올바른 주소만, 중복 없이. */
  function emailsOf(v) {
    var list = [];
    arr(v).forEach(function (x) {
      String(x == null ? '' : x).split(/[,;\s]+/).forEach(function (e) { e = e.trim(); if (e) list.push(e); });
    });
    var seen = {}, out = [];
    list.forEach(function (e) {
      var k = e.toLowerCase();
      if (!EMAIL_RE.test(e) || seen[k]) return;
      seen[k] = true;
      out.push(e);
    });
    return out;
  }

  /** 본사 수신자: settings.mail.hqEmails, 비어 있으면 이메일이 등록된 관리자 계정. */
  function hqRecipients(st, ctx) {
    var list = emailsOf(st.mail.hqEmails);
    if (list.length) return list;
    var users = ctx ? ctx.users() : all('users');
    return emailsOf(users.filter(function (u) {
      return u && u.active !== false && u.role === 'admin' && u.email;
    }).map(function (u) { return u.email; }));
  }

  /* ───────────── 데이터 읽기 ───────────── */

  function all(t, fresh) {
    try { return arr(fresh ? Db.all(t, { fresh: true }) : Db.all(t)); } catch (e) {
      console.warn('표 읽기 실패(' + t + '): ' + msgOf(e));
      return [];
    }
  }

  var formCache = {};
  function formDef(code) {
    code = str(code);
    if (!code) return null;
    if (formCache.hasOwnProperty(code)) return formCache[code];
    var def = null;
    try { def = Db.form(code) || null; } catch (e) { def = null; }
    if (!def) {
      try {
        var fd = Db.forms();
        var list = (fd && fd.forms) || (Array.isArray(fd) ? fd : []);
        for (var i = 0; i < list.length; i++) if (list[i] && list[i].code === code) { def = list[i]; break; }
      } catch (e2) { def = null; }
    }
    formCache[code] = def;
    return def;
  }
  function formShort(code) { var d = formDef(code); return d ? (d.short || d.title || code) : code; }
  function formTitle(code) { var d = formDef(code); return d ? (d.title || d.short || code) : code; }

  var fieldCache = {};
  function fieldsOf(def) {
    if (!def || !def.code) return {};
    if (fieldCache[def.code]) return fieldCache[def.code];
    var map = {};
    arr(def.header).forEach(function (f) { if (f && f.id) map[f.id] = f; });
    arr(def.sections).forEach(function (s) {
      arr(s && s.fields).forEach(function (f) { if (f && f.id && !map[f.id]) map[f.id] = f; });
    });
    fieldCache[def.code] = map;
    return map;
  }

  var LIGHT_REC = ['id', 'form', 'site', 'date', 'period', 'shift', 'status', 'stageDone', 'author', 'requestId',
    'createdAt', 'updatedAt', 'submittedAt', 'confirmedAt', 'returnedAt', 'deleted'];

  /**
   * records 를 data 없이 가볍게 복사한다. Db.all 은 큰 data 열을 늦게 읽으므로(그 속성을 건드릴 때만 읽음)
   * 여기서는 필요한 열만 골라 복사해 data 를 건드리지 않는다. withFacts 면 facts 도.
   */
  function recordRows(withFacts) {
    return all('records').map(function (r) {
      var o = {};
      for (var i = 0; i < LIGHT_REC.length; i++) o[LIGHT_REC[i]] = r[LIGHT_REC[i]];
      if (!Array.isArray(o.stageDone)) o.stageDone = [];
      o.deleted = o.deleted === true || /^(true|y|1)$/i.test(String(o.deleted || ''));
      if (withFacts) o.facts = isObj(r.facts) ? r.facts : {};
      return o;
    });
  }

  /** 한 실행 안에서 표를 한 번씩만 읽게 하는 묶음. */
  function makeCtx(st) {
    var memo = {};
    function once(k, fn) { if (!memo.hasOwnProperty(k)) memo[k] = fn(); return memo[k]; }
    var ctx = {
      st: st || settings(),
      today: today(),
      now: now(),
      sites: function () { return once('sites', function () { return all('sites'); }); },
      siteMap: function () {
        return once('siteMap', function () { var m = {}; ctx.sites().forEach(function (s) { if (s && s.id) m[s.id] = s; }); return m; });
      },
      activeSites: function () {
        return once('active', function () { return ctx.sites().filter(function (s) { return s && s.id && s.status !== '종료'; }); });
      },
      users: function () { return once('users', function () { return all('users'); }); },
      requests: function () { return once('requests', function () { return all('requests'); }); },
      reads: function () { return once('reads', function () { return all('reads'); }); },
      acts: function () { return once('acts', function () { return all('acts').filter(function (a) { return a && !a.deleted; }); }); },
      records: function () {
        return once('records', function () { return recordRows(!!ctx.withFacts).filter(function (r) { return !r.deleted; }); });
      },
      recsBySite: function () {
        return once('bySite', function () {
          var m = {};
          ctx.records().forEach(function (r) { (m[r.site] = m[r.site] || []).push(r); });
          return m;
        });
      },
      withFacts: false
    };
    return ctx;
  }

  /* ───────────── 기간·마감 (클라이언트 엔진과 같은 규칙) ───────────── */

  function periodOf(type, ymd) {
    var y = Number(String(ymd).slice(0, 4)), m = Number(String(ymd).slice(5, 7)) - 1;
    if (type === 'monthly' || type === 'season') {
      return { key: y + '-' + pad2(m + 1), from: ymdOf(Date.UTC(y, m, 1)), to: ymdOf(Date.UTC(y, m + 1, 0)), label: y + '년 ' + (m + 1) + '월' };
    }
    if (type === 'quarterly') {
      var q = Math.floor(m / 3);
      return { key: y + '-Q' + (q + 1), from: ymdOf(Date.UTC(y, q * 3, 1)), to: ymdOf(Date.UTC(y, q * 3 + 3, 0)), label: y + '년 ' + (q + 1) + '분기' };
    }
    if (type === 'half') {
      var h = m < 6 ? 0 : 1;
      return { key: y + '-H' + (h + 1), from: ymdOf(Date.UTC(y, h * 6, 1)), to: ymdOf(Date.UTC(y, h * 6 + 6, 0)), label: y + '년 ' + (h ? '하' : '상') + '반기' };
    }
    if (type === 'annual') return { key: String(y), from: y + '-01-01', to: y + '-12-31', label: y + '년' };
    return { key: ymd, from: ymd, to: ymd, label: fmtDay(ymd) };
  }

  function dueOf(def, period, st) {
    var r = (def && def.frequency && def.frequency.dueRule) || {};
    if (r.kind === 'nextDayTime') return addDays(period.to, 1);
    if (r.kind === 'monthDay') {
      var day = Number(st && st.monthlyDueDay);
      if (!(day >= 1 && day <= 28)) day = Number(r.day) || 5;
      return addDays(period.to, day);
    }
    if (r.kind === 'periodEndPlusDays') return addDays(period.to, Number(r.days) || 0);
    return period.to;
  }

  var KEY_RE = {
    daily: /^\d{4}-\d{2}-\d{2}$/, monthly: /^\d{4}-\d{2}$/, season: /^\d{4}-\d{2}$/,
    quarterly: /^\d{4}-Q[1-4]$/, half: /^\d{4}-H[12]$/, annual: /^\d{4}$/
  };
  /** 기간 키가 그 주기 형식이면 키로, 아니면 날짜로 판정. */
  function inPeriod(r, type, p) {
    var k = str(r.period);
    if (k && KEY_RE[type] && KEY_RE[type].test(k)) return k === p.key;
    var d = dateOf(r.date);
    return !!d && d >= p.from && d <= p.to;
  }

  function periodLabelOfKey(key) {
    key = str(key);
    var m;
    if ((m = /^(\d{4})-Q([1-4])$/.exec(key))) return m[1] + '년 ' + m[2] + '분기';
    if ((m = /^(\d{4})-H([12])$/.exec(key))) return m[1] + '년 ' + (m[2] === '1' ? '상' : '하') + '반기';
    if ((m = /^(\d{4})-(\d{2})$/.exec(key))) return m[1] + '년 ' + Number(m[2]) + '월';
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return fmtDay(key);
    if (/^\d{4}$/.test(key)) return key + '년';
    return key;
  }

  /** 사업장이 이번에 내야 하는 정기 양식 코드와 계절 월. */
  function requiredOf(site, st) {
    var rf = st.requiredForms || {};
    var seasonal = isObj(rf.seasonal) ? rf.seasonal : {};
    var own = arr(site.forms).map(str).filter(Boolean);
    var codes = own.length ? own.slice() : arr(rf['default']).map(str).filter(Boolean);
    if (!own.length) Object.keys(seasonal).forEach(function (c) { if (codes.indexOf(c) < 0) codes.push(c); });
    return dedupe(codes).map(function (c) {
      return { code: c, months: arr(seasonal[c]).map(Number).filter(function (n) { return n >= 1 && n <= 12; }) };
    });
  }

  function annualStatus(site, ref, R, open) {
    var dates = R.map(function (r) { return dateOf(r.date) || dateOf(r.submittedAt); }).filter(isYmd).sort();
    var last = dates[dates.length - 1];
    var y = ref.slice(0, 4);
    if (!last) {
      var first = open ? addDays(open, 30) : '';
      if (first && ref <= first) {
        return { period: { key: y, from: open, to: first, label: '최초 평가' }, due: first, status: 'pending', label: '최초 평가 마감 ' + first };
      }
      return { period: { key: y, from: open || (y + '-01-01'), to: first || ref, label: '실시 기록 없음' }, due: first, status: 'miss', label: '실시 기록 없음' };
    }
    var next = addDays(last, 365);
    var left = daysDiff(ref, next);
    var cycle = { key: next.slice(0, 4), from: addDays(next, -30), to: next, label: '정기 재평가' };
    var lastRec = R.filter(function (r) { return (dateOf(r.date) || dateOf(r.submittedAt)) === last; })[0];
    if (left < 0) return { period: cycle, due: next, status: 'miss', label: '기한 ' + (-left) + '일 경과' };
    if (left <= 30) return { period: cycle, due: next, status: 'pending', label: '재평가 D-' + left, recId: lastRec && lastRec.id };
    return { period: { key: last.slice(0, 4), from: last, to: next, label: '직전 평가 ' + last }, due: next, status: 'ok', label: next + '까지 유효', recId: lastRec && lastRec.id };
  }

  /** 하루치 교대별 제출 판정. dueAt 기준 지연 여부, nowCap 기준 기한경과 여부. */
  function dayEval(f, site, day, R, dueAt, nowCap, time) {
    var shifts = f.shifts ? arr(site.shifts).map(str).filter(Boolean) : [];
    if (!shifts.length) shifts = [''];
    var dayRecs = R.filter(function (r) { return dateOf(r.date) === day || (!r.date && str(r.period) === day); });
    var done = 0, late = false, recId = '';
    shifts.forEach(function (sh) {
      var mine = shifts.length === 1 ? dayRecs : dayRecs.filter(function (r) { return str(r.shift) === sh; });
      if (!mine.length) return;
      done++;
      recId = recId || mine[0].id;
      if (!mine.some(function (r) { return !r.submittedAt || String(r.submittedAt) <= dueAt; })) late = true;
    });
    var need = shifts.length;
    var base = { period: { key: day, from: day, to: day, label: fmtDay(day) }, due: dueAt.slice(0, 10), dueAt: dueAt, done: done, need: need };
    if (done === need) return assign(base, { status: late ? 'late' : 'ok', label: late ? '지연 제출' : '제출', recId: recId });
    var over = nowCap > dueAt;
    var part = need > 1 ? ' (' + done + '/' + need + '교대)' : '';
    return assign(base, { status: over ? 'miss' : 'pending', label: (over ? '미제출' : fmtDay(dueAt.slice(0, 10)) + ' ' + time + ' 마감') + part, recId: recId || undefined });
  }

  /**
   * 매일 양식: 어제 근무분(마감 오늘 dailyDue). 어제분이 아직 마감 전이면 그제분이 빠졌는지 먼저 본다(기한경과 우선).
   */
  function dailyStatus(def, site, ref, R, open, nowCap, st) {
    var f = def.frequency || {};
    var time = /^\d{1,2}:\d{2}$/.test(str(st.dailyDue)) ? str(st.dailyDue) : '10:00';
    if (time.length === 4) time = '0' + time;
    var day = addDays(ref, -1);
    if (open && open > day) {
      return { period: { key: day, from: day, to: day, label: fmtDay(day) }, due: ref, dueAt: ref + 'T' + time + ':00', status: 'na', label: '개설 전' };
    }
    var cur = dayEval(f, site, day, R, ref + 'T' + time + ':00', nowCap, time);
    if (cur.status !== 'pending') return cur;
    var prevDay = addDays(ref, -2);
    if (open && open > prevDay) return cur;
    var prev = dayEval(f, site, prevDay, R, day + 'T' + time + ':00', nowCap, time);
    return prev.status === 'miss' ? prev : cur;
  }

  /**
   * 기간 양식(월·분기·반기·계절). 프로토타입 schedStatus 규칙 + 보완:
   *  - 직전 기간의 마감 전이면 직전 기간을 본다(제출/지연/마감 전).
   *  - 직전 기간 마감이 지났는데 안 냈으면 직전 기간을 '기한경과 미제출'로(프로토타입은 이 경우를 놓친다).
   *  - 그 밖에는 이번 기간. 계절 양식은 해당 월에만, 개설 전 기간은 '해당없음'.
   */
  function periodicStatus(def, site, ref, R, open, months, st) {
    var type = def.frequency.type;
    var inSeason = function (ymd) { return !months.length || months.indexOf(monthNo(ymd)) >= 0; };
    var evalP = function (p, due) {
      var inP = R.filter(function (r) { return inPeriod(r, type, p); });
      if (inP.length) {
        var onTime = inP.some(function (r) { var d = dateOf(r.submittedAt) || dateOf(r.updatedAt); return !d || d <= due; });
        var last = inP.slice().sort(function (a, b) { return String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')); })[0];
        return { period: p, due: due, status: onTime ? 'ok' : 'late', label: onTime ? '제출' : '지연 제출', recId: last && last.id };
      }
      var over = ref > due;
      return { period: p, due: due, status: over ? 'miss' : 'pending', label: over ? '미제출' : '마감 ' + due };
    };
    var p = periodOf(type, ref);
    var due = dueOf(def, p, st);
    var prev = periodOf(type, addDays(p.from, -1));
    var prevDue = dueOf(def, prev, st);
    var prevApplies = inSeason(prev.from) && !(open && open > prev.to);
    if (prevApplies) {
      var pe = evalP(prev, prevDue);
      if (ref <= prevDue || pe.status === 'miss') return pe;
    }
    if (!inSeason(ref)) return { period: p, due: '', status: 'na', label: '시즌 아님' };
    if (open && open > p.to) return { period: p, due: due, status: 'na', label: '개설 전' };
    return evalP(p, due);
  }

  /**
   * 사업장의 필수 정기 양식별 "가장 최근에 마감이 지난(또는 진행 중인) 기간" 상태.
   * ctx(선택)는 makeCtx 결과 — 여러 사업장을 돌 때 표를 다시 읽지 않도록.
   */
  function dueStatus(siteId, refYmd, ctx) {
    ctx = ctx || makeCtx(settings());
    var ref = isYmd(refYmd) ? refYmd : ctx.today;
    var site = isObj(siteId) ? siteId : ctx.siteMap()[str(siteId)];
    if (!site || site.status === '종료') return [];
    var st = ctx.st;
    var open = isYmd(dateOf(site.openDate)) ? dateOf(site.openDate) : '';
    var nowCap = ref < ctx.today ? ref + 'T23:59:59' : (ref > ctx.today ? ref + 'T00:00:00' : ctx.now);
    var mine = (ctx.recsBySite()[site.id] || []).filter(function (r) { return SUBMITTED[r.status]; });
    var out = [];
    requiredOf(site, st).forEach(function (req) {
      var def = formDef(req.code);
      var f = def && def.frequency;
      if (!f || !f.type || f.type === 'event') return;
      var months = req.months.length ? req.months : (f.type === 'season' ? arr(f.seasonMonths).map(Number) : []);
      var R = mine.filter(function (r) { return r.form === req.code; });
      var item;
      if (f.type === 'annual') item = annualStatus(site, ref, R, open);
      else if (f.type === 'daily') {
        item = (months.length && months.indexOf(monthNo(ref)) < 0)
          ? { period: periodOf('daily', addDays(ref, -1)), due: ref, status: 'na', label: '시즌 아님' }
          : dailyStatus(def, site, ref, R, open, nowCap, st);
      } else item = periodicStatus(def, site, ref, R, open, months, st);
      if (!item) return;
      var o = { form: req.code, period: item.period, due: item.due || '', status: item.status, label: item.label };
      ['dueAt', 'done', 'need', 'recId'].forEach(function (k) { if (item[k] !== undefined && item[k] !== '') o[k] = item[k]; });
      out.push(o);
    });
    return out;
  }

  /* ───────────── 요청 대상·제출 판정 ───────────── */

  function targetsOf(req, ctx) {
    var ids = arr(req.sites).map(str);
    if (ids.indexOf('*') >= 0) return ctx.activeSites();
    var map = ctx.siteMap();
    return ids.map(function (id) { return map[id]; }).filter(function (s) { return s && s.status !== '종료'; });
  }

  /** 그 사업장이 아직 안 낸 것: 양식 요청이면 양식 코드 목록, 공지면 ['열람'] (다 냈으면 []). */
  function missingOf(req, siteId, ctx) {
    if (req.kind === 'notice') {
      var read = ctx.reads().some(function (r) { return r.refId === req.id && r.site === siteId; });
      return read ? [] : ['열람'];
    }
    var mine = ctx.recsBySite()[siteId] || [];
    return arr(req.forms).map(str).filter(function (code) {
      return !mine.some(function (r) {
        return r.form === code && SUBMITTED[r.status] &&
          (r.requestId === req.id || (!!req.periodKey && str(r.period) === str(req.periodKey)));
      });
    });
  }

  function beforeDaysOf(v) {
    return dedupe(arr(v).map(Number).filter(function (n) { return n >= 0 && n <= 60 && Math.floor(n) === n; }));
  }

  /** 오늘 독촉한 사업장을 요청에 적는다(remind.sent = {siteId: 'YYYY-MM-DD'}) — 하루 1회 중복 방지. */
  function markReminded(list, t, ts) {
    if (!list.length) return;
    Db.withLock(function () {
      list.forEach(function (x) {
        var cur = Db.get('requests', x.id);
        if (!cur) return;
        var rm = isObj(cur.remind) ? clone(cur.remind) : {};
        var old = isObj(rm.sent) ? rm.sent : {};
        var sent = {};
        Object.keys(old).forEach(function (k) { if (old[k] === t) sent[k] = t; });
        x.sites.forEach(function (s) { sent[s] = t; });
        rm.sent = sent;
        Db.update('requests', x.id, { remind: rm, lastRemindAt: ts });
      });
    });
  }

  /* ───────────── 메일 ───────────── */

  /**
   * 메일 보내기. opt = {who, ref, settings, replyTo}. 보냈으면 true.
   * 메일 끔·받는 사람 없음·할당량 부족·실패 모두 log(kind 'mail') 에 남긴다.
   */
  function mail(to, subject, html, opt) {
    opt = opt || {};
    var who = whoOf(opt.who), ref = opt.ref || '';
    var st = opt.settings || settings();
    var list = emailsOf(to);
    subject = str(subject).replace(/[\r\n]+/g, ' ').slice(0, 250);
    var head = '받는이 ' + (list.join(', ') || '없음') + ' · 제목 ' + subject;
    if (!st.mail || st.mail.enabled === false) { log(who, 'mail', ref, '보내지 않음(메일 발송 꺼짐) · ' + head); return false; }
    if (!list.length) { log(who, 'mail', ref, '보내지 않음(받는 사람 주소 없음) · ' + head); return false; }
    var quota = -1;
    try { quota = Number(MailApp.getRemainingDailyQuota()); } catch (e) { quota = -1; }
    if (!isNaN(quota) && quota >= 0 && quota < list.length) {
      log(who, 'mail', ref, '보내지 않음(오늘 남은 메일 할당량 ' + quota + '통) · ' + head);
      return false;
    }
    try {
      var msg = { to: list.join(','), subject: subject, htmlBody: String(html || ''), name: appName(st) };
      if (opt.replyTo && emailsOf(opt.replyTo).length) msg.replyTo = emailsOf(opt.replyTo)[0];
      MailApp.sendEmail(msg);
      log(who, 'mail', ref, '보냄 · ' + head);
      return true;
    } catch (e2) {
      log(who, 'mail', ref, '실패(' + msgOf(e2) + ') · ' + head);
      return false;
    }
  }

  /* ───── 메일 HTML (인라인 스타일만, 표 레이아웃, 그라데이션·이모지 없음) ───── */

  function cell(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (v.html != null) return String(v.html);
      var t = esc(v.text == null ? '—' : v.text).replace(/\r?\n/g, '<br>');
      if (v.tone === 'neg') return '<span style="color:' + C.neg + ';font-weight:600;">' + t + '</span>';
      if (v.tone === 'strong') return '<span style="font-weight:600;">' + t + '</span>';
      if (v.tone === 'muted') return '<span style="color:' + C.muted + ';">' + t + '</span>';
      return t;
    }
    if (Array.isArray(v)) v = v.join(', ');
    if (v === null || v === undefined || v === '') return '<span style="color:' + C.faint + ';">—</span>';
    return esc(v).replace(/\r?\n/g, '<br>');
  }

  function blockHtml(b) {
    if (!b) return '';
    var h = '';
    if (b.title) h += '<h2 style="margin:28px 0 10px 0;font-size:15px;line-height:22px;font-weight:700;color:' + C.ink + ';">' + esc(b.title) + '</h2>';
    else h += '<div style="height:16px;line-height:16px;font-size:1px;">&nbsp;</div>';
    var tbl = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;border:1px solid ' + C.border + ';">';
    if (b.type === 'text') {
      h += '<div style="font-size:15px;line-height:24px;color:' + C.ink + ';">' + esc(b.text).replace(/\r?\n/g, '<br>') + '</div>';
    } else if (b.type === 'kv') {
      h += tbl;
      arr(b.rows).forEach(function (r, i) {
        var line = i ? 'border-top:1px solid ' + C.border + ';' : '';
        h += '<tr><th align="left" valign="top" style="width:112px;padding:10px 12px;font-size:13px;line-height:20px;font-weight:600;color:' + C.muted + ';text-align:left;' + line + '">' + esc(r[0]) + '</th>' +
          '<td valign="top" style="padding:10px 12px;font-size:15px;line-height:22px;color:' + C.ink + ';' + line + '">' + cell(r[1]) + '</td></tr>';
      });
      h += '</table>';
    } else if (b.type === 'table') {
      var cols = arr(b.cols).map(function (c) { return typeof c === 'string' ? { label: c } : c; });
      h += tbl + '<tr>';
      cols.forEach(function (c) {
        h += '<th align="' + (c.num ? 'right' : 'left') + '" style="padding:8px 10px;font-size:12px;line-height:18px;font-weight:600;color:' + C.muted + ';text-align:' + (c.num ? 'right' : 'left') + ';border-bottom:1px solid ' + C.border + ';white-space:nowrap;">' + esc(c.label) + '</th>';
      });
      h += '</tr>';
      var rows = arr(b.rows);
      if (!rows.length) {
        h += '<tr><td colspan="' + cols.length + '" style="padding:12px 10px;font-size:14px;line-height:20px;color:' + C.muted + ';">' + esc(b.empty || '해당 없음') + '</td></tr>';
      }
      rows.forEach(function (r, i) {
        h += '<tr>';
        cols.forEach(function (c, j) {
          h += '<td valign="top" align="' + (c.num ? 'right' : 'left') + '" style="padding:9px 10px;font-size:14px;line-height:20px;color:' + C.ink + ';text-align:' + (c.num ? 'right' : 'left') + ';' +
            (c.num ? 'font-variant-numeric:tabular-nums;white-space:nowrap;' : '') + (i ? 'border-top:1px solid ' + C.border + ';' : '') + '">' + cell(r[j]) + '</td>';
        });
        h += '</tr>';
      });
      h += '</table>';
      if (b.more) h += '<p style="margin:8px 0 0 0;font-size:13px;line-height:20px;color:' + C.muted + ';">' + esc(b.more) + '</p>';
    } else if (b.type === 'stats') {
      var items = arr(b.items);
      var per = Math.min(3, Math.max(1, items.length));
      h += tbl;
      for (var s = 0; s < items.length; s += per) {
        h += '<tr>';
        for (var k = 0; k < per; k++) {
          var it = items[s + k];
          var edge = (k ? 'border-left:1px solid ' + C.border + ';' : '') + (s ? 'border-top:1px solid ' + C.border + ';' : '');
          if (!it) { h += '<td style="' + edge + '">&nbsp;</td>'; continue; }
          h += '<td valign="top" width="' + Math.floor(100 / per) + '%" style="padding:12px 14px;' + edge + '">' +
            '<div style="font-size:12px;line-height:18px;color:' + C.muted + ';">' + esc(it.label) + '</div>' +
            '<div style="font-size:22px;line-height:30px;font-weight:600;color:' + (it.tone === 'neg' ? C.neg : C.ink) + ';font-variant-numeric:tabular-nums;">' +
            (it.value == null || it.value === '' ? '<span style="color:' + C.faint + ';">—</span>' : esc(it.value)) +
            (it.unit ? '<span style="font-size:13px;font-weight:400;color:' + C.muted + ';padding-left:2px;">' + esc(it.unit) + '</span>' : '') + '</div>' +
            (it.sub ? '<div style="font-size:12px;line-height:18px;color:' + C.muted + ';">' + esc(it.sub) + '</div>' : '') + '</td>';
        }
        h += '</tr>';
      }
      h += '</table>';
    } else if (b.type === 'list') {
      h += '<ul style="margin:0;padding:0 0 0 20px;font-size:15px;line-height:24px;color:' + C.ink + ';">';
      arr(b.items).forEach(function (x) { h += '<li style="margin:0 0 4px 0;">' + cell(x) + '</li>'; });
      h += '</ul>';
    } else if (b.type === 'alert') {
      h += '<div style="border:1px solid ' + C.neg + ';border-radius:6px;padding:12px 14px;font-size:15px;line-height:22px;font-weight:600;color:' + C.neg + ';">' + esc(b.text) + '</div>';
    }
    return h;
  }

  function wordmark() {
    return '<span style="font-family:' + FONT + ';font-size:24px;line-height:28px;font-weight:800;font-style:italic;color:' + C.brand + ';letter-spacing:-0.5px;">HDS</span>' +
      '<span style="font-family:' + FONT + ';font-size:15px;line-height:28px;font-weight:600;color:' + C.faint + ';padding-left:8px;">안전장부</span>';
  }

  function buttonHtml(btn) {
    if (!btn || !btn.url || !/^https?:\/\//i.test(String(btn.url))) return '';
    var url = esc(btn.url);
    return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0 0;border-collapse:separate;"><tr>' +
      '<td align="center" bgcolor="' + C.ink + '" style="background-color:' + C.ink + ';border-radius:6px;">' +
      '<a href="' + url + '" target="_blank" style="display:inline-block;padding:12px 22px;font-family:' + FONT + ';font-size:15px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">' +
      esc(btn.label || '열기') + '</a></td></tr></table>' +
      '<p style="margin:10px 0 0 0;font-size:12px;line-height:18px;color:' + C.faint + ';word-break:break-all;">버튼이 열리지 않으면 이 주소를 브라우저에 붙여 넣으세요: ' +
      '<a href="' + url + '" target="_blank" style="color:' + C.brand + ';text-decoration:underline;">' + url + '</a></p>';
  }

  /**
   * 메일 HTML. kind ∈ request|notice|remind|incident|return|acts|weekly|test (머리 작은 글자만 다름).
   * ctx = { heading, lead, preheader, eyebrow?, blocks:[{type:'text'|'kv'|'table'|'stats'|'list'|'alert', title?, …}], button:{label,url}, note, settings? }
   * 값 칸은 문자열·숫자(자동 이스케이프), {text, tone:'neg'|'strong'|'muted'}, {html}(신뢰된 조각만).
   */
  function template(kind, ctx) {
    ctx = ctx || {};
    var st = ctx.settings || settings();
    var app = appName(st);
    var company = str(st.company) || 'HDS(주)';
    var eyebrow = ctx.eyebrow != null ? ctx.eyebrow : (KIND_LABEL[kind] || '');
    var h = [];
    h.push('<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + esc(ctx.heading || app) + '</title></head>');
    h.push('<body style="margin:0;padding:0;background-color:#ffffff;">');
    if (ctx.preheader) {
      h.push('<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#ffffff;">' + esc(ctx.preheader) + '</div>');
    }
    h.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;background-color:#ffffff;border-collapse:collapse;"><tr><td align="center" style="padding:28px 16px 32px 16px;">');
    h.push('<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;font-family:' + FONT + ';color:' + C.ink + ';text-align:left;">');
    h.push('<tr><td style="padding:0 0 16px 0;border-bottom:1px solid ' + C.border + ';">' + wordmark() + '</td></tr>');
    h.push('<tr><td style="padding:24px 0 0 0;font-family:' + FONT + ';font-size:15px;line-height:24px;color:' + C.ink + ';">');
    if (eyebrow) h.push('<div style="font-size:12px;line-height:18px;font-weight:600;color:' + C.muted + ';margin:0 0 6px 0;">' + esc(eyebrow) + '</div>');
    if (ctx.heading) h.push('<h1 style="margin:0 0 12px 0;font-size:20px;line-height:28px;font-weight:700;color:' + C.ink + ';">' + esc(ctx.heading) + '</h1>');
    if (ctx.lead) h.push('<p style="margin:0;font-size:15px;line-height:24px;color:' + C.ink + ';">' + esc(ctx.lead).replace(/\r?\n/g, '<br>') + '</p>');
    arr(ctx.blocks).forEach(function (b) { h.push(blockHtml(b)); });
    h.push(buttonHtml(ctx.button));
    if (ctx.note) h.push('<p style="margin:20px 0 0 0;font-size:13px;line-height:20px;color:' + C.muted + ';">' + esc(ctx.note) + '</p>');
    h.push('</td></tr>');
    h.push('<tr><td style="padding:32px 0 0 0;"><div style="border-top:1px solid ' + C.border + ';padding-top:16px;font-family:' + FONT + ';font-size:12px;line-height:18px;color:' + C.faint + ';">' +
      esc(company) + '<br>' + esc('이 메일은 ' + app + '에서 자동으로 발송했습니다. 회신은 확인되지 않으니 문의는 안전경영지원실로 해 주세요.') + '</div></td></tr>');
    h.push('</table></td></tr></table></body></html>');
    return h.join('');
  }

  /* ───────────── 요청(배포) ───────────── */

  var DT_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2}))?)?$/;

  function requestMail(req, site, st) {
    var isNotice = req.kind === 'notice';
    var forms = arr(req.forms);
    var blocks = [];
    if (str(req.message)) blocks.push({ type: 'text', title: isNotice ? '공지 내용' : '요청 내용', text: req.message });
    if (forms.length) {
      blocks.push({
        type: 'table', title: '제출할 양식',
        cols: [{ label: '양식' }, { label: '이름' }, { label: '주기' }],
        rows: forms.map(function (c) {
          var d = formDef(c) || {};
          return [c, d.title || c, FREQ_LABEL[d.frequency && d.frequency.type] || '—'];
        })
      });
    }
    var kv = [];
    if (req.due) kv.push(['마감', { text: fmtDay(req.due) + '까지', tone: 'strong' }]);
    if (req.periodKey) kv.push(['대상 기간', periodLabelOfKey(req.periodKey)]);
    if (req.ackRequired) kv.push(['확인 표시', '내용을 읽고 사업장 화면에서 확인을 눌러 주세요']);
    var att = arr(req.attachments);
    if (att.length) kv.push(['첨부', att.map(function (a) { return str(a.name) + (a.size ? ' (' + fmtSize(a.size) + ')' : ''); }).join('\n')]);
    kv.push(['요청 번호', req.id]);
    blocks.push({ type: 'kv', title: '안내', rows: kv });
    var link = siteLink(site, 'inbox/' + req.id);
    return template(isNotice ? 'notice' : 'request', {
      settings: st,
      preheader: (req.due ? fmtDay(req.due) + '까지 · ' : '') + (site.name || site.id),
      heading: req.title,
      lead: (site.managerName ? site.managerName + ' 님, ' : '') + (site.name || site.id) + '에 ' +
        (isNotice ? '본사 안전경영지원실의 공지가 도착했습니다.' : '본사 안전경영지원실의 제출 요청이 도착했습니다.') +
        (req.due ? ' 마감은 ' + fmtDay(req.due) + '입니다.' : ''),
      blocks: blocks,
      button: link ? { label: isNotice ? '공지 보기' : '양식 작성하기', url: link } : null,
      note: (att.length ? '첨부 파일은 사업장 화면의 받은 요청에서 내려받을 수 있습니다. ' : '') +
        '이 링크는 ' + (site.name || '사업장') + ' 전용입니다. 다른 사람에게 전달하지 마세요.'
    });
  }

  function sendRequestMails(req, sites, st, me) {
    var n = 0;
    sites.forEach(function (site) {
      var subject = tag(st) + req.title + (req.due ? ' — ' + fmtDay(req.due) + ' 까지' : '');
      if (mail(site.managerEmail, subject, requestMail(req, site, st), { who: me, ref: req.id, settings: st })) n++;
    });
    return n;
  }

  function saveRequest(p, me) {
    p = p || {};
    if (me && me.kind === 'site') fail('FORBIDDEN', '사업장에서는 요청을 만들 수 없습니다');
    var src = isObj(p.request) ? p.request : p;
    var st = settings();
    var t = today(), ts = now();
    var id = str(src.id);
    var existing = id ? Db.get('requests', id) : null;
    if (id && !existing) fail('NOTFOUND', '요청을 찾을 수 없습니다: ' + id);

    var title = str(src.title).replace(/\s+/g, ' ');
    if (!title) fail('INVALID', '요청 제목을 입력하세요');
    if (title.length > 120) fail('INVALID', '제목은 120자 이내로 줄여 주세요');

    var kind = str(src.kind) || (existing && existing.kind) || 'form';
    if (kind !== 'form' && kind !== 'notice') fail('INVALID', '요청 종류는 양식 요청(form) 또는 공지(notice)여야 합니다');

    var forms = dedupe(arr(src.forms).map(str).filter(Boolean));
    forms.forEach(function (c) { if (!formDef(c)) fail('INVALID', '없는 양식 코드입니다: ' + c); });
    if (kind === 'form' && !forms.length) fail('INVALID', '제출받을 양식을 하나 이상 고르세요');

    var siteList = all('sites');
    var siteMap = {};
    siteList.forEach(function (s) { if (s && s.id) siteMap[s.id] = s; });
    var siteIds = dedupe(arr(src.sites).map(str).filter(Boolean));
    if (!siteIds.length) fail('INVALID', '대상 사업장을 고르세요');
    if (siteIds.indexOf('*') >= 0) siteIds = ['*'];
    else siteIds.forEach(function (sid) { if (!siteMap[sid]) fail('INVALID', '없는 사업장입니다: ' + sid); });

    var due = '';
    if (str(src.due)) {
      var dm = DT_RE.exec(str(src.due));
      if (!dm || !isYmd(dm[1])) fail('INVALID', '마감일 형식이 맞지 않습니다(예: 2026-11-05)');
      due = dm[1];
    }
    if (kind === 'form' && !due) fail('INVALID', '마감일을 정하세요');
    if (!existing && due && due < t) fail('INVALID', '마감일이 오늘보다 앞섭니다. 날짜를 확인하세요');

    var openAt = str(src.openAt) || (existing && str(existing.openAt)) || ts;
    var om = DT_RE.exec(openAt);
    if (!om || !isYmd(om[1])) fail('INVALID', '공개일 형식이 맞지 않습니다(예: 2026-11-01)');
    if (due && om[1] > due) fail('INVALID', '공개일이 마감일보다 늦습니다');

    var periodKey = str(src.periodKey);
    if (periodKey && !/^\d{4}(-(\d{2}(-\d{2})?|Q[1-4]|H[12]))?$/.test(periodKey)) {
      fail('INVALID', '대상 기간 형식이 맞지 않습니다(예: 2026-10, 2026-Q4, 2026-H2)');
    }

    var message = String(src.message == null ? '' : src.message).replace(/\r\n/g, '\n').trim();
    if (message.length > 20000) fail('INVALID', '요청 내용은 20,000자 이내로 줄여 주세요');

    var attachments = [];
    var rawAtt = arr(src.attachments);
    if (rawAtt.length > 10) fail('INVALID', '첨부는 10개까지 넣을 수 있습니다');
    rawAtt.forEach(function (a) {
      var fid = str(isObj(a) ? a.id : a);
      if (!fid) return;
      var f = Db.get('files', fid);
      if (!f) fail('INVALID', '첨부 파일을 찾을 수 없습니다: ' + (isObj(a) && a.name ? a.name : fid));
      attachments.push({
        id: fid,
        name: str(isObj(a) && a.name) || str(f.name) || fid,
        mime: str(f.mime) || str(isObj(a) && a.mime),
        size: Number(f.size) || Number(isObj(a) && a.size) || 0
      });
    });

    var ackRequired = src.ackRequired === true || src.ackRequired === 'true';
    var remind = isObj(src.remind) ? clone(src.remind) : (existing && isObj(existing.remind) ? clone(existing.remind) : {});
    delete remind.sent;
    if (remind.beforeDays != null) remind.beforeDays = beforeDaysOf(remind.beforeDays);
    if (existing && isObj(existing.remind) && isObj(existing.remind.sent)) remind.sent = existing.remind.sent;

    var fields = {
      kind: kind, title: title, message: message, forms: forms, sites: siteIds, periodKey: periodKey,
      openAt: openAt, due: due, attachments: attachments, ackRequired: ackRequired, remind: remind
    };
    if (existing && REQ_STATUS.indexOf(str(src.status)) >= 0) fields.status = str(src.status);

    var saved = null;
    Db.withLock(function () {
      if (existing) {
        var cur = Db.get('requests', id) || existing;
        var patch = assign(fields, { updatedAt: ts });
        var r = Db.update('requests', id, patch);
        saved = (isObj(r) && r.id) ? r : assign(cur, patch);
      } else {
        var head = 'REQ-' + yymmdd(t) + '-';
        var used = all('requests', true).map(function (r) { return String(r.id || ''); })
          .filter(function (x) { return x.indexOf(head) === 0; })
          .map(function (x) { return parseInt(x.slice(head.length), 10) || 0; });
        var n = used.length ? Math.max.apply(null, used) + 1 : 1;
        saved = assign(fields, {
          id: head + pad2(n), status: '진행', createdBy: me ? (me.name || me.id || '') : 'system',
          createdAt: ts, updatedAt: ts, lastRemindAt: ''
        });
        Db.insert('requests', saved);
      }
    });

    log(whoOf(me), 'request', saved.id, (existing ? '요청 수정' : '요청 등록') + ' · ' + title +
      ' · 대상 ' + (siteIds[0] === '*' ? '전체 사업장' : siteIds.length + '곳') + (due ? ' · 마감 ' + due : ''));

    var mailed = 0;
    if (st.mail.enabled !== false && st.mail.onRequest !== false && saved.status === '진행') {
      var ctx = makeCtx(st);
      ctx.sites = function () { return siteList; };
      var targets = targetsOf(saved, ctx);
      if (existing) {
        var before = {};
        targetsOf(existing, ctx).forEach(function (s) { before[s.id] = true; });
        targets = targets.filter(function (s) { return !before[s.id]; });
      }
      mailed = sendRequestMails(saved, targets, st, me);
    }
    return { request: saved, mailed: mailed };
  }

  function closeRequest(p, me) {
    p = p || {};
    if (me && me.kind === 'site') fail('FORBIDDEN', '사업장에서는 요청 상태를 바꿀 수 없습니다');
    var id = str(p.id);
    if (!id) fail('INVALID', '요청을 고르세요');
    var status = str(p.status) || '마감';
    if (REQ_STATUS.indexOf(status) < 0) fail('INVALID', '상태는 진행·마감·취소 중 하나여야 합니다');
    var cur = Db.get('requests', id);
    if (!cur) fail('NOTFOUND', '요청을 찾을 수 없습니다: ' + id);
    var saved = cur;
    if (cur.status !== status) {
      var patch = { status: status, updatedAt: now() };
      Db.withLock(function () {
        var r = Db.update('requests', id, patch);
        saved = (isObj(r) && r.id) ? r : assign(cur, patch);
      });
      log(whoOf(me), 'request', id, '요청 상태 ' + (cur.status || '—') + ' → ' + status + ' · ' + (cur.title || ''));
    }
    return { request: saved };
  }

  /* ───────────── 독촉 ───────────── */

  function leftText(left) {
    if (left == null || isNaN(left)) return { text: '기록 없음', tone: 'neg' };
    if (left < 0) return { text: '기한 ' + (-left) + '일 경과', tone: 'neg' };
    if (left === 0) return { text: '오늘 마감', tone: 'strong' };
    return 'D-' + left;
  }

  function remindMail(site, items, st) {
    items = items.slice().sort(function (a, b) {
      var x = a.left == null || isNaN(a.left) ? -9999 : a.left, y = b.left == null || isNaN(b.left) ? -9999 : b.left;
      return x - y;
    });
    var over = items.filter(function (i) { return i.left == null || isNaN(i.left) || i.left < 0; }).length;
    var subject = tag(st) + (site.name || site.id) + ' 미제출 ' + items.length + '건' + (over ? '(기한경과 ' + over + '건)' : '') + ' — 제출 부탁드립니다';
    var html = template('remind', {
      settings: st,
      preheader: '미제출 ' + items.length + '건' + (over ? ', 기한경과 ' + over + '건' : ''),
      heading: '아직 제출되지 않은 항목이 ' + items.length + '건 있습니다',
      lead: (site.managerName ? site.managerName + ' 님, ' : '') + (site.name || site.id) + '의 미제출 항목입니다. ' +
        (over ? '기한이 지난 항목부터 먼저 제출해 주세요.' : '마감 전에 제출해 주세요.'),
      blocks: [{
        type: 'table',
        cols: [{ label: '항목' }, { label: '기간' }, { label: '마감' }, { label: '상태' }],
        rows: items.map(function (i) {
          return [i.what, i.period || '—', i.dueAt ? fmtDT(i.dueAt) : (i.due ? fmtDay(i.due) : '—'), leftText(i.left)];
        })
      }],
      button: siteLink(site) ? { label: '사업장 화면 열기', url: siteLink(site) } : null,
      note: '이미 제출하셨다면 이 메일은 넘기셔도 됩니다. 제출 여부는 메일을 보낸 시각 기준입니다.'
    });
    return { subject: subject, html: html };
  }

  function remind(p, me) {
    p = p || {};
    if (me && me.kind === 'site') fail('FORBIDDEN', '사업장에서는 독촉을 보낼 수 없습니다');
    var id = str(p.id);
    if (!id) fail('INVALID', '독촉할 요청을 고르세요');
    var req = Db.get('requests', id);
    if (!req) fail('NOTFOUND', '요청을 찾을 수 없습니다: ' + id);
    if (req.status !== '진행') fail('INVALID', '진행 중인 요청만 독촉할 수 있습니다');
    var st = settings();
    var ctx = makeCtx(st);
    var t = ctx.today;
    var targets = targetsOf(req, ctx);
    var only = arr(p.sites).map(str).filter(Boolean);
    if (only.length) targets = targets.filter(function (s) { return only.indexOf(s.id) >= 0; });
    var sentMap = (isObj(req.remind) && isObj(req.remind.sent)) ? req.remind.sent : {};
    var left = isYmd(req.due) ? daysDiff(t, req.due) : null;
    var res = { sent: 0, skipped: 0, done: 0, sites: [] };
    if (st.mail.enabled === false) res.note = '설정에서 메일 발송이 꺼져 있어 보내지 못했습니다';
    var mailed = [];
    var started = Date.now();
    targets.forEach(function (site) {
      var missing = missingOf(req, site.id, ctx);
      if (!missing.length) { res.done++; return; }
      var why = '';
      if (sentMap[site.id] === t) why = '오늘 이미 독촉함';
      else if (!emailsOf(site.managerEmail).length) why = '담당자 메일 없음';
      else if (Date.now() - started > TIME_BUDGET_MS) why = '시간 초과로 다음에 보냄';
      if (!why) {
        var item = {
          what: req.kind === 'notice' ? req.title + ' (열람 확인)' : req.title + ' — ' + missing.map(formShort).join(', '),
          period: periodLabelOfKey(req.periodKey), due: req.due, left: left
        };
        var m = remindMail(site, [item], st);
        if (mail(site.managerEmail, m.subject, m.html, { who: me, ref: req.id, settings: st })) {
          res.sent++; mailed.push(site.id); res.sites.push({ site: site.id, result: '보냄' });
          return;
        }
        why = st.mail.enabled === false ? '메일 발송 꺼짐' : '발송 실패';
      }
      res.skipped++;
      res.sites.push({ site: site.id, result: why });
    });
    if (mailed.length) {
      try { markReminded([{ id: req.id, sites: mailed }], t, ctx.now); } catch (e) { log('system', 'remind', req.id, '독촉 기록 저장 실패: ' + msgOf(e)); }
    }
    log(whoOf(me), 'remind', req.id, '독촉 ' + res.sent + '곳 보냄 · ' + res.skipped + '곳 건너뜀 · 제출 완료 ' + res.done + '곳');
    return res;
  }

  /* ───────────── 열람 표시 ───────────── */

  function markRead(p, me) {
    p = p || {};
    if (!me) fail('AUTH', '다시 로그인해 주세요');
    var refId = str(p.refId);
    // refId: 요청 번호(REQ-…) 또는 본사 확인 표시용 '기록번호#단계' 등
    if (!refId || !/^[A-Za-z0-9_\-:.#\/]{1,120}$/.test(refId)) fail('INVALID', '열람 표시할 항목이 올바르지 않습니다');
    var site = me.kind === 'site' ? str(me.site) : 'HQ';
    if (!site) fail('FORBIDDEN', '사업장 정보가 없는 세션입니다');
    if (me.kind === 'site' && /^REQ-/.test(refId)) {
      var req = Db.get('requests', refId);
      if (!req) fail('NOTFOUND', '요청을 찾을 수 없습니다: ' + refId);
      var ids = arr(req.sites).map(str);
      if (ids.indexOf('*') < 0 && ids.indexOf(site) < 0) fail('FORBIDDEN', '우리 사업장에 온 요청이 아닙니다');
    }
    var match = function (r) { return r && r.refId === refId && r.site === site; };
    var hit = null;
    try { hit = arr(Db.find('reads', match))[0] || null; } catch (e) { hit = all('reads').filter(match)[0] || null; }
    if (hit) return { read: hit };
    var out = null;
    Db.withLock(function () {
      out = all('reads', true).filter(match)[0] || null;
      if (out) return;
      out = { id: Db.uuid8(), refId: refId, site: site, by: str(me.name) || str(me.id), at: now() };
      Db.insert('reads', out);
    });
    return { read: out };
  }

  /* ───────────── 기록 이벤트 메일 ───────────── */

  function fmtVal(field, v) {
    if (v === null || v === undefined || v === '') return null;
    if (Array.isArray(v)) return v.length ? v.join(', ') : null;
    if (typeof v === 'boolean') return v ? '예' : '아니오';
    var type = field && field.type;
    if (type === 'datetime' || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(v))) return fmtDT(v);
    if (type === 'bool') return (v === true || v === 'true') ? '예' : '아니오';
    return String(v);
  }

  function factRows(def, rec) {
    var facts = isObj(rec.facts) ? rec.facts : {};
    var v = isObj(facts.v) ? facts.v : {};
    var fields = fieldsOf(def);
    var rows = [];
    var keys = (INCIDENT_FACTS[rec.form] || []).slice();
    Object.keys(v).forEach(function (k) {
      if (keys.length < 12 && keys.indexOf(k) < 0 && fields[k] && /^(select|datetime)$/.test(fields[k].type) && !fields[k].sensitive) keys.push(k);
    });
    keys.forEach(function (k) {
      if (rows.length >= 8) return;
      var f = fields[k];
      if (f && f.sensitive) return;
      var val = fmtVal(f, v[k]);
      if (val == null && v[k + '#n'] != null) val = String(v[k + '#n']) + '명';
      if (val == null) return;
      rows.push([(f && f.label) || k, k === 'serious' && val === '해당' ? { text: val, tone: 'neg' } : val]);
    });
    var sm = arr(facts.sm);
    arr(def && def.summary).forEach(function (s, i) {
      var val = sm[i];
      if (val === null || val === undefined || val === '' || rows.length >= 11) return;
      rows.push([s.label || s.id, typeof val === 'number' ? String(Math.round(val * 10) / 10) : fmtVal(null, val)]);
    });
    return rows;
  }

  function stageText(def, fresh, isFinal, prev) {
    var stages = arr(def && def.stages);
    if (fresh.length) {
      return fresh.map(function (id) {
        for (var i = 0; i < stages.length; i++) if (stages[i].id === id) return (i + 1) + '단계 ' + (stages[i].label || '');
        return id;
      }).join('·') + ' 보고';
    }
    if (prev && prev.status === '반려') return '재제출';
    return isFinal ? '최종 제출' : '제출';
  }

  /** 기록 제출 직후(Api 가 부름). F04·F10 의 단계 제출이면 본사로 즉시 메일. 실패해도 제출을 막지 않는다. */
  function onRecordSubmitted(rec, me, prev) {
    try {
      if (!rec || !INCIDENT_FORMS[rec.form] || rec.deleted) return { sent: false };
      var st = settings();
      if (st.mail.enabled === false || st.mail.onIncident === false) return { sent: false };
      var before = arr(prev && prev.stageDone), done = arr(rec.stageDone);
      var fresh = done.filter(function (s) { return before.indexOf(s) < 0; });
      var isFinal = SUBMITTED[rec.status] && !(prev && SUBMITTED[prev.status]);
      if (!fresh.length && !isFinal) return { sent: false };
      var to = hqRecipients(st);
      var def = formDef(rec.form) || { code: rec.form, title: rec.form };
      var site = Db.get('sites', rec.site) || { id: rec.site, name: rec.site };
      var stage = stageText(def, fresh, isFinal, prev);
      var v = (isObj(rec.facts) && isObj(rec.facts.v)) ? rec.facts.v : {};
      var serious = rec.form === 'F04' && v.serious === '해당';
      var kindTxt = rec.form === 'F04' ? str(v.kind) : str(v.swType).replace(/^제\d+조\s*/, '');
      var subject = tag(st) + (serious ? '중대재해 ' : '') + (def.short || def.title) + ' ' + stage + ' — ' + (site.name || site.id) + (kindTxt ? ' (' + kindTxt + ')' : '');
      var stages = arr(def.stages);
      var rows = [
        ['사업장', (site.name || site.id) + ' (' + site.id + ')'],
        ['양식', def.title || rec.form],
        ['단계', stage + (stages.length ? ' · 완료 ' + done.length + '/' + stages.length : '')],
        ['기록번호', rec.id],
        ['작성자', rec.author || (me && me.name) || null],
        ['보고 시각', fmtDT(rec.submittedAt || rec.updatedAt || now())]
      ];
      var blocks = [];
      if (serious) blocks.push({ type: 'alert', text: '중대재해 해당으로 보고되었습니다. 바로 확인해 주세요.' });
      blocks.push({ type: 'kv', title: '보고 정보', rows: rows });
      var fr = factRows(def, rec);
      if (fr.length) blocks.push({ type: 'kv', title: '요약', rows: fr });
      var link = recordLink(rec.id);
      var html = template('incident', {
        settings: st,
        preheader: (site.name || site.id) + ' · ' + stage,
        heading: (site.name || site.id) + ' ' + (def.short || def.title) + ' ' + stage,
        lead: (site.name || site.id) + '에서 ' + (def.title || rec.form) + '의 ' + stage + '를 올렸습니다. 내용을 확인하고 필요한 지원을 결정해 주세요.',
        blocks: blocks,
        button: link ? { label: '기록 보기', url: link } : null
      });
      if (!to.length) {
        log(whoOf(me), 'mail', rec.id, '보내지 않음(본사 수신 메일 미설정 — 설정 > 메일에서 본사 수신 주소를 넣으세요) · 제목 ' + subject);
        return { sent: false };
      }
      return { sent: mail(to, subject, html, { who: me, ref: rec.id, settings: st }) };
    } catch (e) {
      log(whoOf(me), 'mail', rec && rec.id, '사고 보고 메일 준비 실패: ' + msgOf(e));
      return { sent: false };
    }
  }

  /** 검토 직후(Api 가 부름). 반려면 사업장 담당자에게 사유 메일. 실패해도 검토를 막지 않는다. */
  function onReviewed(rec, decision, me) {
    try {
      if (!rec || decision !== '반려') return { sent: false };
      var st = settings();
      if (st.mail.enabled === false || st.mail.onReturn === false) return { sent: false };
      var site = Db.get('sites', rec.site);
      if (!site) return { sent: false };
      var def = formDef(rec.form) || { title: rec.form };
      var subject = tag(st) + '반려 — ' + (def.title || rec.form) + ' ' + rec.id + ' 고쳐서 다시 제출해 주세요';
      var link = siteLink(site, 'rec/' + rec.id);
      var html = template('return', {
        settings: st,
        preheader: '반려 사유: ' + str(rec.returnNote).slice(0, 60),
        heading: (def.title || rec.form) + ' 기록이 반려되었습니다',
        lead: (site.managerName ? site.managerName + ' 님, ' : '') + '본사 검토에서 아래 기록이 반려되었습니다. 사유를 확인하고 고쳐서 다시 제출해 주세요.',
        blocks: [{
          type: 'kv', rows: [
            ['반려 사유', { text: str(rec.returnNote) || '사유가 적혀 있지 않습니다. 안전경영지원실에 문의해 주세요', tone: 'strong' }],
            ['기록번호', rec.id],
            ['양식', def.title || rec.form],
            ['기간', rec.period ? periodLabelOfKey(rec.period) : (rec.date ? fmtDay(dateOf(rec.date)) : null)],
            ['작성자', rec.author || null],
            ['검토자', (me && me.name) || rec.returnedBy || null],
            ['반려 시각', fmtDT(rec.returnedAt || now())]
          ]
        }],
        button: link ? { label: '기록 고치기', url: link + '#/edit/' + encodeURIComponent(rec.id) } : null
      });
      return { sent: mail(site.managerEmail, subject, html, { who: me, ref: rec.id, settings: st }) };
    } catch (e) {
      log(whoOf(me), 'mail', rec && rec.id, '반려 메일 준비 실패: ' + msgOf(e));
      return { sent: false };
    }
  }

  /* ───────────── 매일 점검 (트리거 08시) ───────────── */

  /** 정기 양식 기한경과 독촉 주기: 경과 1·2·3일째, 그 뒤로는 7일마다(마감일이 없으면 월요일마다). 오래 밀린 반기 양식으로 매일 메일이 가지 않게. */
  function overdueDay(left, t) {
    if (left == null || isNaN(left)) return weekday(t) === '월';
    var over = -left;
    return over <= 3 || over % 7 === 0;
  }

  function daily() {
    var started = Date.now();
    var res = { at: now(), cleaned: 0, sites: 0, mails: 0, failed: 0, noEmail: 0, requestItems: 0, formItems: 0, overdueActs: 0, hqMail: false, note: '' };
    try { res.cleaned = Number(Auth.cleanup()) || 0; } catch (e) { log('system', 'cron', 'daily', '만료 세션 정리 실패: ' + msgOf(e)); }
    var st = settings();
    if (st.mail.enabled === false || st.mail.dailyReminder === false) {
      res.note = '메일 발송 또는 매일 독촉이 꺼져 있어 독촉을 보내지 않음';
      log('system', 'cron', 'daily', '매일 점검 · 만료 세션 ' + res.cleaned + '건 정리 · ' + res.note);
      return res;
    }
    var ctx = makeCtx(st);
    var t = ctx.today;
    var before = beforeDaysOf(st.reminder.beforeDays);
    var overdueOn = st.reminder.overdue !== false;
    var bucket = {};
    var covered = {};
    function add(siteId, item) { (bucket[siteId] = bucket[siteId] || []).push(item); }
    var marks = [];

    // (1) 진행 중 요청: 마감 D-n·당일·기한경과 미제출 사업장
    ctx.requests().forEach(function (req) {
      if (!req || req.status !== '진행' || !isYmd(req.due)) return;
      if (req.openAt && dateOf(req.openAt) > t) return;
      var rm = isObj(req.remind) ? req.remind : {};
      if (rm.enabled === false || rm.off === true) return;
      var bd = rm.beforeDays != null ? beforeDaysOf(rm.beforeDays) : before;
      var od = rm.overdue != null ? rm.overdue !== false : overdueOn;
      var left = daysDiff(t, req.due);
      if (!(left === 0 || (left > 0 && bd.indexOf(left) >= 0) || (left < 0 && od))) return;
      var sent = isObj(rm.sent) ? rm.sent : {};
      var hit = [];
      targetsOf(req, ctx).forEach(function (site) {
        if (sent[site.id] === t) return;
        var missing = missingOf(req, site.id, ctx);
        if (!missing.length) return;
        add(site.id, {
          what: req.kind === 'notice' ? req.title + ' (열람 확인)' : req.title + ' — ' + missing.map(formShort).join(', '),
          period: periodLabelOfKey(req.periodKey), due: req.due, left: left
        });
        if (req.periodKey) missing.forEach(function (c) { covered[site.id + '|' + c + '|' + req.periodKey] = true; });
        res.requestItems++;
        hit.push(site.id);
      });
      if (hit.length) marks.push({ id: req.id, sites: hit });
    });

    // (2) 정기 필수 양식: 기한경과 미제출 + 마감 D-n·당일
    ctx.activeSites().forEach(function (site) {
      dueStatus(site, t, ctx).forEach(function (it) {
        if (covered[site.id + '|' + it.form + '|' + it.period.key]) return;
        var left = isYmd(it.due) ? daysDiff(t, it.due) : null;
        var take = (it.status === 'miss' && overdueOn && overdueDay(left, t)) ||
          (it.status === 'pending' && left != null && (left === 0 || before.indexOf(left) >= 0));
        if (!take) return;
        add(site.id, { what: formTitle(it.form), period: it.period.label, due: it.due, dueAt: it.dueAt, left: it.status === 'miss' && left != null && left >= 0 ? -1 : left });
        res.formItems++;
      });
    });

    // 사업장당 한 통. 같은 날 다시 돌려도(수동 실행·시간 초과 뒤 재실행) 이미 보낸 사업장은 건너뛴다.
    var mem = null;
    try { mem = Db.kvGet('cron.daily', null); } catch (e3) { mem = null; }
    if (!isObj(mem) || mem.date !== t) mem = { date: t, sites: {}, hq: false };
    if (!isObj(mem.sites)) mem.sites = {};
    var siteMap = ctx.siteMap();
    var mailedSites = {};
    var ids = Object.keys(bucket);
    for (var i = 0; i < ids.length; i++) {
      var site = siteMap[ids[i]];
      if (!site) continue;
      if (mem.sites[site.id]) { res.already = (res.already || 0) + 1; continue; }
      res.sites++;
      if (Date.now() - started > TIME_BUDGET_MS) { res.note = '실행 시간 한도에 가까워 ' + (ids.length - i) + '곳은 다음 실행으로 미룸'; break; }
      if (!emailsOf(site.managerEmail).length) { res.noEmail++; continue; }
      var m = remindMail(site, bucket[ids[i]], st);
      if (mail(site.managerEmail, m.subject, m.html, { who: 'system', ref: 'cron:' + site.id, settings: st })) {
        res.mails++; mailedSites[site.id] = true; mem.sites[site.id] = 1;
      } else res.failed++;
    }
    var done = marks.map(function (x) { return { id: x.id, sites: x.sites.filter(function (s) { return mailedSites[s]; }) }; })
      .filter(function (x) { return x.sites.length; });
    try { markReminded(done, t, ctx.now); } catch (e2) { log('system', 'cron', 'daily', '독촉 기록 저장 실패: ' + msgOf(e2)); }

    // (3) 기한경과 '높음' 조치 → 본사
    var late = ctx.acts().filter(function (a) { return a.level === '높음' && OPEN_ACT[a.status] && isYmd(dateOf(a.due)) && dateOf(a.due) < t; })
      .sort(function (a, b) { return String(a.due).localeCompare(String(b.due)); });
    res.overdueActs = late.length;
    if (late.length && !mem.hq) {
      var to = hqRecipients(st, ctx);
      var rows = late.slice(0, 40).map(function (a) {
        var s = siteMap[a.site];
        return [s ? s.name || s.id : a.site, a.title || a.srcItem || a.id, fmtDay(dateOf(a.due)), { text: daysDiff(dateOf(a.due), t) + '일', tone: 'neg' }, a.owner || null, a.status];
      });
      var html = template('acts', {
        settings: st,
        preheader: '기한이 지난 위험도 높음 조치 ' + late.length + '건',
        heading: '기한이 지난 위험도 높음 조치 ' + late.length + '건',
        lead: '오늘(' + fmtDay(t) + ') 기준으로 기한이 지났는데 아직 끝나지 않은 위험도 높음 조치입니다. 오래된 것부터 정리했습니다.',
        blocks: [{
          type: 'table',
          cols: [{ label: '사업장' }, { label: '조치' }, { label: '기한' }, { label: '경과', num: true }, { label: '담당' }, { label: '상태' }],
          rows: rows,
          more: late.length > 40 ? '외 ' + (late.length - 40) + '건은 조치대장에서 확인하세요.' : ''
        }],
        button: appUrl() ? { label: '조치대장 열기', url: withParam(appUrl(), 'v', 'acts') } : null
      });
      if (to.length) res.hqMail = mail(to, tag(st) + '기한경과 위험도 높음 조치 ' + late.length + '건', html, { who: 'system', ref: 'cron:acts', settings: st });
      else log('system', 'mail', 'cron:acts', '보내지 않음(본사 수신 메일 미설정) · 기한경과 높음 조치 ' + late.length + '건');
      if (res.hqMail) mem.hq = true;
    }
    try { Db.kvSet('cron.daily', mem); } catch (e4) { log('system', 'cron', 'daily', '오늘 보낸 곳 기록 실패: ' + msgOf(e4)); }

    log('system', 'cron', 'daily', '매일 점검 · 만료 세션 ' + res.cleaned + '건 정리 · 독촉 대상 ' + res.sites + '곳(요청 ' + res.requestItems + '건, 정기 양식 ' + res.formItems + '건) · 메일 ' + res.mails + '통' +
      (res.failed ? ' · 실패 ' + res.failed + '통' : '') + (res.noEmail ? ' · 담당자 메일 없음 ' + res.noEmail + '곳' : '') +
      (res.already ? ' · 오늘 이미 보낸 곳 ' + res.already + '곳 건너뜀' : '') +
      ' · 기한경과 높음 조치 ' + res.overdueActs + '건' + (res.note ? ' · ' + res.note : '') + ' · ' + Math.round((Date.now() - started) / 100) / 10 + '초');
    return res;
  }

  /* ───────────── 주간 요약 (트리거 월요일 08시) ───────────── */

  function reported(r) { return SUBMITTED[r.status] || r.status === '반려' || arr(r.stageDone).length > 0; }

  function weekly() {
    var started = Date.now();
    var st = settings();
    var res = { at: now(), sent: false, note: '' };
    if (st.mail.enabled === false || st.mail.weeklyDigest === false) {
      res.note = '메일 발송 또는 주간 요약이 꺼져 있음';
      log('system', 'cron', 'weekly', '주간 요약 · ' + res.note);
      return res;
    }
    var ctx = makeCtx(st);
    ctx.withFacts = true;
    var to = hqRecipients(st, ctx);
    var t = ctx.today, from = addDays(t, -7), end = addDays(t, -1);
    var inWin = function (d) { d = dateOf(d); return !!d && d >= from && d <= end; };
    var sites = ctx.activeSites();
    var recs = ctx.records();
    var bySite = ctx.recsBySite();
    var acts = ctx.acts();

    // 매일 양식(일일점검 등) 제출률
    var per = {};
    sites.forEach(function (s) { per[s.id] = { exp: 0, got: 0, acc: 0, near: 0, stop: 0, overdue: 0, high: 0, miss: 0 }; });
    var expTotal = 0, gotTotal = 0;
    sites.forEach(function (s) {
      var row = per[s.id];
      var mine = bySite[s.id] || [];
      var open = dateOf(s.openDate);
      requiredOf(s, st).forEach(function (r) {
        var def = formDef(r.code);
        if (!def || !def.frequency || def.frequency.type !== 'daily') return;
        var shifts = def.frequency.shifts ? arr(s.shifts).map(str).filter(Boolean) : [];
        if (!shifts.length) shifts = [''];
        var seen = {};
        mine.forEach(function (x) { if (x.form === r.code && SUBMITTED[x.status] && inWin(x.date)) seen[dateOf(x.date) + '|' + (shifts.length > 1 ? str(x.shift) : '')] = true; });
        for (var d = from; d <= end; d = addDays(d, 1)) {
          if (open && open > d) continue;
          if (r.months.length && r.months.indexOf(monthNo(d)) < 0) continue;
          shifts.forEach(function (sh) {
            row.exp++;
            if (seen[d + '|' + (shifts.length > 1 ? sh : '')]) row.got++;
          });
        }
      });
      expTotal += row.exp; gotTotal += row.got;
      row.miss = dueStatus(s, t, ctx).filter(function (x) { return x.status === 'miss'; }).length;
    });

    // 사고·아차·작업중지
    var acc = 0, near = 0, minor = 0, stop = 0, serious = 0;
    recs.forEach(function (r) {
      if (!per[r.site] || !inWin(r.date) || !reported(r)) return;
      var v = (isObj(r.facts) && isObj(r.facts.v)) ? r.facts.v : {};
      if (r.form === 'F04') {
        if (v.kind === '아차사고') { near++; per[r.site].near++; }
        else if (v.kind === '무상해') { minor++; per[r.site].acc++; }
        else { acc++; per[r.site].acc++; }
        if (v.serious === '해당') serious++;
      } else if (r.form === 'F10') { stop++; per[r.site].stop++; }
    });

    // 기록 흐름
    var submitted = recs.filter(function (r) { return SUBMITTED[r.status] && inWin(r.submittedAt); }).length;
    var confirmed = recs.filter(function (r) { return inWin(r.confirmedAt) && r.status === '확인'; }).length;
    var returned = recs.filter(function (r) { return inWin(r.returnedAt); }).length;
    var waiting = recs.filter(function (r) { return r.status === '제출'; }).length;

    // 조치
    var actNew = 0, actDone = 0, overdue = 0, overdueHigh = 0;
    acts.forEach(function (a) {
      if (inWin(a.createdAt)) actNew++;
      if (inWin(a.doneAt) && (a.status === '완료' || a.status === '확인')) actDone++;
      if (OPEN_ACT[a.status] && isYmd(dateOf(a.due)) && dateOf(a.due) < t) {
        overdue++;
        if (a.level === '높음') overdueHigh++;
        if (per[a.site]) { per[a.site].overdue++; if (a.level === '높음') per[a.site].high++; }
      }
    });
    var missTotal = 0, missSites = 0;
    sites.forEach(function (s) { missTotal += per[s.id].miss; if (per[s.id].miss) missSites++; });

    var rate = pct(gotTotal, expTotal);
    var rows = sites.map(function (s) {
      var r = per[s.id];
      return { s: s, r: r, rate: pct(r.got, r.exp), score: r.miss * 3 + r.high * 3 + r.overdue + r.acc * 2 + r.stop };
    }).sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var x = a.rate == null ? 101 : a.rate, y = b.rate == null ? 101 : b.rate;
      return x - y;
    });
    var show = rows.slice(0, 50);
    var range = fmtDay(from) + ' ~ ' + fmtDay(end);
    var html = template('weekly', {
      settings: st,
      preheader: range + ' · 일일점검 제출률 ' + (rate == null ? '—' : rate + '%') + ' · 사고 ' + acc + '건 · 아차 ' + near + '건',
      heading: '지난주 안전 요약 (' + range + ')',
      lead: '운영 중인 사업장 ' + sites.length + '곳의 지난 7일 제출·사고·조치 현황입니다.' +
        (missTotal ? ' 정기 양식 기한경과 미제출이 ' + missSites + '곳 ' + missTotal + '건 있습니다.' : ' 정기 양식 기한경과 미제출은 없습니다.'),
      blocks: [
        {
          type: 'stats', items: [
            { label: '일일점검 제출률', value: rate == null ? '' : rate, unit: rate == null ? '' : '%', sub: '제출 ' + gotTotal + ' / 기대 ' + expTotal, tone: rate != null && rate < 90 ? 'neg' : '' },
            { label: '재해·무상해 사고', value: acc + minor, unit: '건', sub: serious ? '중대재해 ' + serious + '건' : '무상해 ' + minor + '건 포함', tone: serious ? 'neg' : '' },
            { label: '아차사고', value: near, unit: '건' },
            { label: '작업중지권 행사', value: stop, unit: '건' },
            { label: '새 조치 · 완료', value: actNew + ' · ' + actDone, unit: '건' },
            { label: '기한경과 조치', value: overdue, unit: '건', sub: '위험도 높음 ' + overdueHigh + '건', tone: overdueHigh ? 'neg' : '' }
          ]
        },
        { type: 'kv', title: '기록 흐름', rows: [
          ['제출', submitted + '건'], ['확인', confirmed + '건'], ['반려', returned + '건'],
          ['확인 대기', { text: waiting + '건', tone: waiting ? 'strong' : '' }],
          ['정기 양식 미제출', missTotal ? { text: missSites + '곳 ' + missTotal + '건', tone: 'neg' } : '없음']
        ] },
        {
          type: 'table', title: '사업장별 (손볼 곳 먼저)',
          cols: [{ label: '사업장' }, { label: '일일점검', num: true }, { label: '사고 · 아차', num: true }, { label: '작업중지', num: true }, { label: '기한경과 조치', num: true }, { label: '미제출 양식', num: true }],
          rows: show.map(function (x) {
            var r = x.r;
            return [
              x.s.name || x.s.id,
              x.rate == null ? null : (x.rate < 90 ? { text: x.rate + '%', tone: 'neg' } : x.rate + '%'),
              (r.acc + r.near) ? r.acc + ' · ' + r.near : '0',
              String(r.stop),
              r.overdue ? (r.high ? { text: r.overdue + ' (높음 ' + r.high + ')', tone: 'neg' } : String(r.overdue)) : '0',
              r.miss ? { text: String(r.miss), tone: 'neg' } : '0'
            ];
          }),
          empty: '운영 중인 사업장이 없습니다',
          more: rows.length > 50 ? '외 ' + (rows.length - 50) + '곳은 분석 화면에서 확인하세요.' : ''
        }
      ],
      button: appUrl() ? { label: '종합 현황 열기', url: appUrl() } : null,
      note: '일일점검 제출률은 지난 7일 동안 사업장별 교대 수만큼 기대한 건수 대비 제출(확인 포함) 건수입니다.'
    });
    var subject = tag(st) + '주간 안전 요약 ' + from.slice(5).replace('-', '/') + '~' + end.slice(5).replace('-', '/') +
      ' · 사고 ' + (acc + minor) + ' · 아차 ' + near + ' · 기한경과 조치 ' + overdue;
    if (!to.length) {
      res.note = '본사 수신 메일 미설정';
      log('system', 'mail', 'cron:weekly', '보내지 않음(본사 수신 메일 미설정) · 제목 ' + subject);
    } else {
      // 같은 날 두 번 보내지 않는다(웹앱의 google.script.run 으로도 전역 함수 cronWeekly 를 부를 수 있으므로 반복 발송 방지).
      var wk = null;
      try { wk = Db.kvGet('cron.weekly', null); } catch (e5) { wk = null; }
      if (isObj(wk) && wk.date === t && wk.sent) {
        res.note = '오늘 이미 보냄';
      } else {
        res.sent = mail(to, subject, html, { who: 'system', ref: 'cron:weekly', settings: st });
        if (res.sent) { try { Db.kvSet('cron.weekly', { date: t, sent: true, at: now() }); } catch (e6) { log('system', 'cron', 'weekly', '보낸 날 기록 실패: ' + msgOf(e6)); } }
      }
    }
    res.summary = { from: from, to: end, sites: sites.length, dailyRate: rate, accidents: acc + minor, nearMiss: near, stopWork: stop, actNew: actNew, actDone: actDone, overdue: overdue, overdueHigh: overdueHigh, missing: missTotal };
    log('system', 'cron', 'weekly', '주간 요약 ' + from + '~' + end + ' · 일일점검 ' + (rate == null ? '—' : rate + '%') + ' · 사고 ' + (acc + minor) + ' · 아차 ' + near +
      ' · 작업중지 ' + stop + ' · 새 조치 ' + actNew + '/완료 ' + actDone + ' · 기한경과 ' + overdue + ' · 메일 ' + (res.sent ? '보냄' : '안 보냄') +
      (res.note ? '(' + res.note + ')' : '') + ' · ' + Math.round((Date.now() - started) / 100) / 10 + '초');
    return res;
  }

  return {
    saveRequest: saveRequest,
    closeRequest: closeRequest,
    remind: remind,
    markRead: markRead,
    onRecordSubmitted: onRecordSubmitted,
    onReviewed: onReviewed,
    dueStatus: function (siteId, refYmd, ctx) { return dueStatus(siteId, refYmd, ctx); },
    mail: mail,
    template: template,
    daily: daily,
    weekly: weekly,
    periodOf: periodOf,
    dueOf: function (def, period) { return dueOf(def, period, settings()); },
    siteLink: siteLink,
    recordLink: recordLink,
    emailsOf: emailsOf
  };
})();

/**
 * 트리거가 부르는 매일 점검(08시). 세션 정리 + 독촉 + 기한경과 높음 조치 요약.
 * 전역 함수라 웹앱 방문자도 google.script.run 으로 부를 수 있다 — 트리거 이벤트도 없고 소유자 실행(ownerRun_)도 아니면 아무것도 하지 않는다.
 * 집계 결과는 돌려주지 않는다(트리거는 반환값을 쓰지 않고, 외부에 숫자를 내보이지 않게). 같은 날 중복 발송은 Dispatch 가 막는다.
 */
function cronDaily(e) {
  if (!cronAllowed_(e)) return;
  try {
    Dispatch.daily();
  } catch (err) {
    try { Db.log('system', 'cron', 'daily', '매일 점검 실패: ' + ((err && err.message) || err)); } catch (e2) { console.error('매일 점검 실패 기록도 실패'); }
    throw err;
  }
}

/** 트리거가 부르는 주간 요약(월요일 08시). 보호·반환은 cronDaily 와 같다. */
function cronWeekly(e) {
  if (!cronAllowed_(e)) return;
  try {
    Dispatch.weekly();
  } catch (err) {
    try { Db.log('system', 'cron', 'weekly', '주간 요약 실패: ' + ((err && err.message) || err)); } catch (e2) { console.error('주간 요약 실패 기록도 실패'); }
    throw err;
  }
}

/** 트리거 실행(이벤트에 triggerUid) 또는 소유자 실행일 때만 true. 이름이 _ 로 끝나 웹앱에서 부를 수 없다. */
function cronAllowed_(e) {
  try { if (typeof ownerRun_ === 'function' && ownerRun_()) return true; } catch (x) { /* 아래 트리거 확인 */ }
  if (!(e && typeof e === 'object' && e.triggerUid)) return false;
  // 이벤트의 triggerUid 가 이 프로젝트에 실제로 설치된 트리거 ID 와 같을 때만 믿는다(웹앱에서 위조한 값 거부).
  try {
    var uid = String(e.triggerUid);
    return ScriptApp.getProjectTriggers().some(function (t) {
      return typeof t.getUniqueId === 'function' && String(t.getUniqueId()) === uid;
    });
  } catch (x2) { return false; }
}


/* ======================================================================
 * Export.gs
 * ==================================================================== */

/**
 * Export.gs — 구글 시트·엑셀 내보내기. SPEC §6 export.sheet / export.xlsx.
 *
 * 전역으로 내놓는 것: Export 하나.
 *  Export.sheet(payload, me) → {url}         드라이브 '<루트>/exports' 에 새 스프레드시트 'HDS 안전장부 내보내기 YYMMDD-HHmm'
 *  Export.xlsx(payload, me)  → {name, base64} 같은 내용을 임시 스프레드시트로 만들고 xlsx 로 받아 base64(임시 파일은 휴지통)
 * payload = { kind:'records'|'acts'|'form', form?, from?, to?, sites? }
 *  - records: 기록 목록(색인 열 + 요약), acts: 조치대장, form: 그 양식 평탄화(Views 와 같은 열 — 본표·표 섹션·점검결과).
 *  - from/to 는 'YYYY-MM-DD'(기록은 작성일, 조치는 등록일 기준), sites 는 사업장 코드 배열(['*'] 또는 비우면 전체).
 * 본사 세션(me.kind === 'hq')만 부를 수 있다. 사업장 세션이면 FORBIDDEN.
 */
var Export = (function () {
  'use strict';

  var REC_COLS = [
    ['기록번호', 's'], ['양식코드', 's'], ['양식명', 's'], ['사업장코드', 's'], ['사업장명', 's'], ['작성일', 'd'], ['기간', 's'], ['근무조', 's'],
    ['상태', 's'], ['단계', 's'], ['작성자', 's'], ['작성 주체', 's'], ['요청번호', 's'], ['차수', 'n'], ['최초 저장', 'd'], ['최종 수정', 'd'],
    ['제출일시', 'd'], ['확인일시', 'd'], ['확인자', 's'], ['반려일시', 'd'], ['반려 사유', 's'], ['요약', 's']
  ];
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  function fail(code, msg) {
    var e = new Error(msg);
    e.code = code;
    throw e;
  }

  function guard(me) {
    if (!me || me.kind !== 'hq') fail('FORBIDDEN', '내보내기는 본사 계정만 할 수 있습니다');
  }

  function dt(s) { return s ? String(s).replace('T', ' ').slice(0, 19) : ''; }

  function ymd(v) {
    var s = String(v || '').trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  }

  function list(v) {
    if (v === undefined || v === null || v === '') return [];
    var a = Array.isArray(v) ? v : String(v).split(',');
    return a.map(function (x) { return String(x).trim(); }).filter(Boolean);
  }

  /** payload → 걸러 낼 조건 */
  function scope(p) {
    var from = ymd(p.from);
    var to = ymd(p.to);
    if (from && to && from > to) { var t = from; from = to; to = t; }
    var sites = list(p.sites);
    if (sites.indexOf('*') >= 0) sites = [];
    var forms = list(p.forms);
    if (p.form) forms = [String(p.form).trim()];
    return { from: from, to: to, sites: sites, forms: forms };
  }

  function inRange(d, sc) {
    d = String(d || '').slice(0, 10);
    if (sc.from && (!d || d < sc.from)) return false;
    if (sc.to && (!d || d > sc.to)) return false;
    return true;
  }

  function siteOk(id, sc) { return !sc.sites.length || sc.sites.indexOf(id) >= 0; }

  function stamp() { return Utilities.formatDate(new Date(), APP.tz, 'yyMMdd-HHmm'); }

  function rangeText(sc) {
    if (!sc.from && !sc.to) return '전체 기간';
    return (sc.from || '처음') + ' ~ ' + (sc.to || '오늘');
  }

  function sitesMap() {
    var m = {};
    Db.all('sites').forEach(function (s) { m[s.id] = s; });
    return m;
  }

  function summaryText(def, rec) {
    var sm = rec.facts && rec.facts.sm;
    if (!def || !Array.isArray(sm) || !def.summary) return '';
    var parts = [];
    def.summary.forEach(function (s, i) {
      var v = sm[i];
      if (v && typeof v === 'object' && 'value' in v) v = v.value;
      if (v === '' || v === null || v === undefined) return;
      parts.push(s.label + ' ' + v);
    });
    return parts.join(' · ');
  }

  function stageText(def, rec) {
    var st = (def && def.stages) || [];
    if (!st.length) return '';
    var done = rec.stageDone || [];
    var n = st.filter(function (s) { return done.indexOf(s.id) >= 0; }).length;
    return n === st.length ? '전체 완료' : n + '/' + st.length;
  }

  /* =========================================================== 표 만들기 */

  function recordsTable(sc) {
    var sm = sitesMap();
    var rows = Db.all('records').filter(function (r) {
      return !r.deleted && inRange(r.date, sc) && siteOk(r.site, sc) && (!sc.forms.length || sc.forms.indexOf(r.form) >= 0);
    }).sort(function (a, b) {
      return String(b.date || '').localeCompare(String(a.date || '')) || String(a.id).localeCompare(String(b.id));
    }).map(function (r) {
      var def = Db.form(r.form);
      var s = sm[r.site] || {};
      return [
        r.id, r.form || '', def ? (def.short || def.title || '') : '', r.site || '', s.name || '', String(r.date || '').slice(0, 10),
        r.period || '', r.shift || '', r.status || '', stageText(def, r), r.author || '', r.createdBy === 'hq' ? '본사 대리 입력' : '사업장',
        r.requestId || '', r.rev === null || r.rev === undefined ? '' : r.rev, dt(r.createdAt), dt(r.updatedAt), dt(r.submittedAt),
        dt(r.confirmedAt), r.confirmedBy || '', dt(r.returnedAt), r.returnNote || '', summaryText(def, r)
      ];
    });
    return [{ name: '기록 목록', header: REC_COLS.map(function (c) { return c[0]; }), kinds: REC_COLS.map(function (c) { return c[1]; }), rows: rows }];
  }

  function actsTable(sc) {
    var sm = sitesMap();
    var acts = Db.all('acts').filter(function (a) {
      return !a.deleted && inRange(a.createdAt, sc) && siteOk(a.site, sc);
    }).sort(function (a, b) {
      return String(a.due || '9999').localeCompare(String(b.due || '9999')) || String(a.id).localeCompare(String(b.id));
    });
    return [Views.actTable(acts, sm, '조치대장')];
  }

  function formTables(sc) {
    var code = sc.forms[0];
    var def = code ? Db.form(code) : null;
    if (!def) fail('INVALID', '내보낼 양식을 고르세요');
    var recs = Db.all('records').filter(function (r) {
      return r.form === def.code && Views.eligible(r) && inRange(r.date, sc) && siteOk(r.site, sc);
    }).sort(function (a, b) {
      return String(a.date || '').localeCompare(String(b.date || '')) || String(a.id).localeCompare(String(b.id));
    });
    return Views.tablesFor(def, recs, sitesMap(), { names: 'export' });
  }

  function build(payload) {
    var p = payload || {};
    var sc = scope(p);
    var kind = String(p.kind || 'records');
    var tables;
    var label;
    if (kind === 'records') { tables = recordsTable(sc); label = '기록 목록'; }
    else if (kind === 'acts') { tables = actsTable(sc); label = '조치대장'; }
    else if (kind === 'form') {
      tables = formTables(sc);
      var def = Db.form(sc.forms[0]);
      label = def.code + ' ' + (def.short || def.title || '');
    }
    else fail('INVALID', '내보내기 종류가 올바르지 않습니다: ' + kind);
    return { kind: kind, scope: sc, tables: tables, label: label };
  }

  /* =========================================================== 스프레드시트 */

  /** 엑셀에서도 열리게: 31자 이하, []:*?/\ 없이, 겹치지 않게. */
  function tabName(name, used) {
    var base = String(name || '시트').replace(/[\[\]:\*\?\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28) || '시트';
    var n = base;
    var i = 2;
    while (used[n]) n = base.slice(0, 26) + ' ' + (i++);
    used[n] = 1;
    return n;
  }

  function makeBook(title, tables) {
    var ss = SpreadsheetApp.create(title);
    var first = ss.getSheets()[0];
    var used = {};
    tables.forEach(function (t) {
      Views.writeTable(ss, tabName(t.name, used), t.header, t.kinds, t.rows);
    });
    if (first && tables.length) {
      try { ss.deleteSheet(first); } catch (e) { /* 마지막 시트면 남겨 둔다 */ }
    }
    return ss;
  }

  /** 새 파일을 exports 폴더로. moveTo 가 없으면 복사 후 원본 휴지통. 실패하면 내 드라이브에 둔다. */
  function place(ss, title) {
    try {
      var dest = Db.folder('exports');
      var file = DriveApp.getFileById(ss.getId());
      if (typeof file.moveTo === 'function') {
        file.moveTo(dest);
        return ss;
      }
      var copy = file.makeCopy(title, dest);
      file.setTrashed(true);
      return SpreadsheetApp.openById(copy.getId());
    } catch (e) {
      console.warn('내보내기 파일을 exports 폴더로 옮기지 못했습니다: ' + (e && e.message || e));
      return ss;
    }
  }

  function who(me) { return (me && (me.name || me.id)) || '본사'; }

  function sheet(payload, me) {
    guard(me);
    var b = build(payload);
    var title = APP.name + ' 내보내기 ' + stamp();
    var ss = place(makeBook(title, b.tables), title);
    var rows = b.tables.reduce(function (t, x) { return t + x.rows.length; }, 0);
    try { Db.log(who(me), 'export', b.kind, '구글 시트 내보내기: ' + b.label + ' · ' + rangeText(b.scope) + ' · ' + rows + '행'); } catch (e) { /* 기록 실패는 무시 */ }
    return { url: ss.getUrl() };
  }

  function xlsx(payload, me) {
    guard(me);
    var b = build(payload);
    var title = APP.name + ' 내보내기 ' + stamp();
    var ss = makeBook(title, b.tables);
    try {
      SpreadsheetApp.flush();
      var url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx';
      var res = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code !== 200) fail('SERVER', '엑셀 파일을 만들지 못했습니다(응답 ' + code + '). 잠시 후 다시 시도하세요');
      var base64 = Utilities.base64Encode(res.getBlob().getBytes());
      var rows = b.tables.reduce(function (t, x) { return t + x.rows.length; }, 0);
      try { Db.log(who(me), 'export', b.kind, '엑셀 내보내기: ' + b.label + ' · ' + rangeText(b.scope) + ' · ' + rows + '행'); } catch (e) { /* 기록 실패는 무시 */ }
      return { name: title + '.xlsx', base64: base64, mime: XLSX_MIME };
    } finally {
      try { DriveApp.getFileById(ss.getId()).setTrashed(true); } catch (e) { console.warn('임시 내보내기 파일 정리 실패: ' + ss.getId()); }
    }
  }

  return { sheet: sheet, xlsx: xlsx, build: build };
})();


/* ======================================================================
 * Main.gs
 * ==================================================================== */

/**
 * Main.gs — 웹앱 입구(doGet)와 템플릿 포함(include). SPEC §3.
 *
 * 전역으로 내놓는 것: doGet(e), include(name). 나머지는 함수 안에 둔다(서버 파일들이 한 전역 범위를 같이 쓰므로).
 */

/**
 * 웹앱 첫 화면. Index 템플릿에 BOOT(JSON)를 넣어 돌려준다.
 * BOOT = { url, s, view, appName, company, version, ready, site? }
 *  - ready: DB 스프레드시트가 준비됐는지(setup 전이면 false — 클라이언트가 안내 화면을 띄운다)
 *  - site : ?s=<사업장 토큰> 으로 들어왔을 때 그 사업장의 {id, name, needPin} (토큰이 틀리면 null)
 */
function doGet(e) {
  var q = (e && e.parameter) || {};
  var s = String(q.s || '').trim();
  if (!/^[A-Za-z0-9_\-]{6,64}$/.test(s)) s = '';
  var view = String(q.v || '').trim();
  if (!/^[A-Za-z0-9_\-\/.:]{1,80}$/.test(view)) view = '';

  var st = { ready: false, appName: DEFAULT_SETTINGS.appName, company: DEFAULT_SETTINGS.company };
  try {
    st = Auth.status(s ? { siteToken: s } : {});
  } catch (err) {
    console.warn('doGet: 상태 확인 실패 — ' + (err && err.message || err));
  }

  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (err) { url = ''; }

  var boot = {
    url: url,
    s: s,
    view: view,
    appName: st.appName || APP.name,
    company: st.company || DEFAULT_SETTINGS.company,
    version: APP.version,
    ready: !!st.ready
  };
  if (s) boot.site = st.site || null;

  var t = HtmlService.createTemplateFromFile('Index');
  // <script> 안에 그대로 들어가므로 '<'·줄 구분 문자를 이스케이프해 </script> 끊김을 막는다.
  t.BOOT = JSON.stringify(boot)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  return t.evaluate()
    .setTitle(boot.appName || APP.name)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Index 템플릿의 include 스크립틀릿이 부른다: 다른 HTML 파일 내용을 그대로 넣는다. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}


/* ======================================================================
 * Setup.gs
 * ==================================================================== */

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
 * 실제 GAS 는 userinfo.email 범위(appsscript.json)가 있어 effective 주소가 늘 있다. effective 를 못 읽으면 거부한다(ALLOW_SETUP=1 로만 허용).
 * 이름이 _ 로 끝나 google.script.run 으로는 부를 수 없다.
 */
function ownerRun_() {
  try {
    if (PropertiesService.getScriptProperties().getProperty('ALLOW_SETUP') === '1') return true;
  } catch (e) { /* 속성을 못 읽으면 신원으로만 판단 */ }
  var act = '', eff = '';
  try { act = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { act = ''; }
  try { eff = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { eff = ''; }
  // 실행 계정 주소를 못 읽으면(userinfo.email 범위 누락 등) 신원 불명 — 소유자로 보지 않는다(실패 시 닫힘).
  // 이럴 때 편집기에서 꼭 실행해야 하면 스크립트 속성 ALLOW_SETUP=1 을 잠깐 넣고 실행한 뒤 지운다.
  if (!eff) return false;
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


/* ======================================================================
 * Views.gs
 * ==================================================================== */

/**
 * Views.gs — 본사가 구글 시트에서 바로 분석하는 평탄화 시트(DB 스프레드시트 안). SPEC §1·§5.
 *
 * 전역으로 내놓는 것: Views 하나.
 *  Views.onRecord(rec)  제출·확인·단계보고 기록 → 'V_<코드> <짧은이름>' 1행 upsert, 표 섹션 → 'V_<코드>_<표제목>',
 *                       체크리스트 → 'V_점검결과', F09 → 'HQ_MonthlyData'(FD.kpiTable 규칙). 삭제·작성중(단계 없음)은 행 제거, 반려는 상태만.
 *  Views.onAct(act)     'V_조치대장' upsert(삭제된 조치는 행 제거).
 *  Views.rebuildAll()   → {sheets:[이름], rows:n}  모든 V_ 시트와 HQ_MonthlyData 를 지우고 다시 만든다.
 *  (Export 가 같이 쓰는 것) Views.tablesFor(def, recs, sites), Views.actTable(acts, sites), Views.writeTable(ss, name, header, kinds, rows)
 *
 * 열 종류(kinds): 's' 글자(서식 '@'), 'n' 숫자(숫자로 기록), 'd' 날짜·일시(자동 서식 — 시트가 날짜로 인식해 피벗·필터가 됨).
 * 평탄화 시트 갱신이 실패해도 제출은 깨지지 않게 onRecord/onAct 는 예외를 삼키고 false 를 돌려준다(콘솔에 경고).
 */
var Views = (function () {
  'use strict';

  var CHECK_SHEET = 'V_점검결과';
  var ACT_SHEET = 'V_조치대장';
  var BASE = [
    ['기록번호', 's'], ['사업장코드', 's'], ['사업장명', 's'], ['작성일', 'd'], ['기간', 's'], ['근무조', 's'], ['상태', 's'], ['단계', 's'],
    ['작성자', 's'], ['제출일시', 'd'], ['확인일시', 'd'], ['확인자', 's']
  ];
  var TABLE_BASE = [['기록번호', 's'], ['행번호', 'n'], ['사업장코드', 's'], ['작성일', 'd']];
  var CHECK_COLS = [['기록번호', 's'], ['사업장', 's'], ['작성일', 'd'], ['양식', 's'], ['섹션', 's'], ['항목코드', 's'], ['항목', 's'], ['판정', 's'], ['비고', 's']];
  var ACT_COLS = [
    ['조치번호', 's'], ['사업장코드', 's'], ['사업장명', 's'], ['원천기록', 's'], ['원천양식', 's'], ['원천항목', 's'], ['제목', 's'], ['내용', 's'],
    ['위험도', 's'], ['구분', 's'], ['기한', 'd'], ['담당', 's'], ['상태', 's'], ['조치 전 사진', 's'], ['조치 후 사진', 's'],
    ['완료일시', 'd'], ['완료자', 's'], ['완료 내용', 's'], ['확인일시', 'd'], ['확인자', 's'], ['등록일시', 'd'], ['수정일시', 'd']
  ];
  var KPI_DEFAULT_COLS = ['양식버전', '사업장코드', '보고월', '사업장명', '업무구분', '지표코드', '지표명', '단위', '지표값', '값상태',
    '보고상태', '제출차수', '제출일시', '작성자', '검토자', '기록번호', '기본키'];
  var OPEN_ACT = ['등록', '조치중', '보류', '고객사 이관'];
  var CELL_MAX = 49000;
  var BATCH = 5000;
  var GROW = 200;                 // 평탄화 시트에 남겨 두는 빈 행(행 추가 호출을 줄이는 여유)
  var BUDGET_MS = 4.5 * 60 * 1000; // 재구축 한 번의 시간 예산(GAS 실행 한도 6분)
  var RESUME_KEY = 'viewsRebuild';
  var RESUME_TTL_MS = 6 * 60 * 60 * 1000;

  var LAYOUTS = {};

  /* =========================================================== 작은 도구 */

  function sheetName(s) {
    return String(s || '').replace(/[\[\]\*\?\/\\:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 95);
  }

  function isEmpty(v) {
    return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  }

  function num(v) {
    if (v === '' || v === null || v === undefined || typeof v === 'boolean') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  /** 배열 뒤에 붙이기. push.apply 는 인자 수 한도(수만~수십만 개)에 걸리므로 하나씩 넣는다. */
  function pushAll(to, from) {
    for (var i = 0, n = from ? from.length : 0; i < n; i++) to.push(from[i]);
    return to;
  }

  function dt(s) { return s ? String(s).replace('T', ' ').slice(0, 19) : ''; }

  function itemText(x) {
    if (x === null || x === undefined) return '';
    if (typeof x === 'object') {
      var t = x.name || x.label || x.title || x.id || x.file || '';
      return t ? String(t) : JSON.stringify(x);
    }
    return String(x);
  }

  function kindOf(f) {
    switch (f.type) {
      case 'number': case 'computed': return 'n';
      case 'date': case 'datetime': return 'd';
      default: return 's';
    }
  }

  /** 필드 값 → 칸 값. multi/people/배열은 ', ' 로 잇는다. */
  function cellValue(f, v, kind) {
    if (isEmpty(v)) return '';
    if (Array.isArray(v)) return v.map(itemText).filter(function (x) { return x !== ''; }).join(', ');
    if (f.type === 'bool') {
      if (v === true || v === '예' || v === 'Y') return '예';
      if (v === false || v === '아니오' || v === 'N') return '아니오';
      return String(v);
    }
    if (kind === 'n') {
      var n = num(v);
      return n === null ? itemText(v) : n;
    }
    if (f.type === 'datetime') return String(v).replace('T', ' ').slice(0, 16);
    if (f.type === 'date') return String(v).slice(0, 10);
    return itemText(v);
  }

  /** 프로토타입 showOk 와 같은 규칙(사업장 태그 조건은 사업장의 현재 태그로). */
  function showOk(cond, data, tags) {
    if (!cond) return true;
    if (cond.siteTag) return (tags || []).indexOf(cond.siteTag) >= 0;
    if (cond.field) {
      var v = data[cond.field];
      if (cond.in) {
        if (Array.isArray(v)) return v.some(function (x) { return cond.in.indexOf(x) >= 0; });
        return cond.in.indexOf(v === true ? '예' : v === false ? '아니오' : v) >= 0;
      }
      if (cond.gte !== undefined) return Number(v) >= cond.gte;
      if (cond.eq !== undefined) return v === cond.eq;
    }
    return true;
  }

  function timeToMin(v) {
    if (!v) return null;
    var s = String(v);
    if (s.indexOf('T') >= 0 || s.length > 8) {
      var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s);
      if (!m) return null;
      return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000;
    }
    var p = s.split(':');
    var h = Number(p[0]);
    return isNaN(h) ? null : h * 60 + (Number(p[1]) || 0);
  }

  function dayNum(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null;
  }

  /** 요약·계산 필드 대비용 계산(클라이언트 엔진 calcValue 의 서버판, autoMonthly 제외). */
  function calc(c, a, d) {
    a = a || {};
    d = d || {};
    var t, any, n, dd, x, y, list;
    switch (c) {
      case 'sum':
        t = 0; any = false;
        (a.fields || []).forEach(function (f) { var v = num(d[f]); if (v !== null) { t += v; any = true; } });
        return any ? t : '';
      case 'ratio':
        n = num(d[a.num]); dd = num(d[a.den]);
        return n !== null && dd ? Math.round(n / dd * 1000) / 10 : '';
      case 'riskScore':
        x = num(d[a.a]); y = num(d[a.b]);
        return x && y ? x * y : '';
      case 'countRows':
        return Array.isArray(d[a.table]) ? d[a.table].length : 0;
      case 'countWhere':
        return Array.isArray(d[a.table]) ? d[a.table].filter(function (r) { return r && (a.values || []).indexOf(r[a.column]) >= 0; }).length : 0;
      case 'countChecklist':
        list = d[a.section] || {};
        return Object.keys(list).filter(function (k) { return list[k] && (a.values || []).indexOf(list[k].r) >= 0; }).length;
      case 'checklistRate':
        list = d[a.section] || {};
        var got = Object.keys(list).map(function (k) { return list[k]; }).filter(function (q) { return q && q.r; });
        var tot = got.filter(function (q) { return (a.exclude || []).indexOf(q.r) < 0; }).length;
        if (!tot) return '';
        return Math.round(got.filter(function (q) { return (a.good || []).indexOf(q.r) >= 0; }).length / tot * 1000) / 10;
      case 'countPeople':
        return Array.isArray(d[a.field]) ? d[a.field].length : 0;
      case 'minutesBetween':
        x = timeToMin(d[a.from]); y = timeToMin(d[a.to]);
        if (x === null || y === null) return '';
        t = Math.round(y - x);
        if (t < 0 && String(d[a.from]).length <= 5) t += 1440;
        return t;
      case 'hoursBetween':
        x = timeToMin(d[a.from]); y = timeToMin(d[a.to]);
        if (x === null || y === null) return '';
        t = y - x;
        if (t < 0) t += 1440;
        return Math.round(t / 6) / 10;
      case 'daysBetween':
        x = dayNum(d[a.from]); y = dayNum(d[a.to]);
        return x === null || y === null ? '' : Math.round(y - x);
      default:
        return '';
    }
  }

  function stageText(def, rec) {
    var st = def.stages || [];
    if (!st.length) return '';
    var done = rec.stageDone || [];
    var labels = st.filter(function (s) { return done.indexOf(s.id) >= 0; }).map(function (s) { return s.label || s.id; });
    if (labels.length === st.length) return '전체 완료';
    if (!labels.length) return '미보고';
    return labels.length + '/' + st.length + ' ' + labels[labels.length - 1];
  }

  /** 평탄화 대상: 삭제 아님 + (제출·확인·반려 또는 단계 1개 이상 보고). */
  function eligible(rec) {
    if (!rec || rec.deleted) return false;
    if (rec.status === '제출' || rec.status === '확인' || rec.status === '반려') return true;
    return Array.isArray(rec.stageDone) && rec.stageDone.length > 0;
  }

  /* =========================================================== 양식별 열 배치 */

  function layout(def) {
    var ck = def.code + '|' + (def.version || '');
    if (LAYOUTS[ck]) return LAYOUTS[ck];
    var used = {};
    BASE.forEach(function (b) { used[b[0]] = 1; });
    function uniq(label, alt) {
      var base = String(label || '').trim() || alt;
      var l = base;
      if (used[l]) {
        l = base + ' (' + alt + ')';
        var i = 2;
        while (used[l]) l = base + ' (' + alt + ' ' + (i++) + ')';
      }
      used[l] = 1;
      return l;
    }
    var fields = [];
    function addField(f, secTitle) {
      if (!f || f.sensitive || f.type === 'photo' || f.type === 'signature' || f.type === 'sign') return;
      fields.push({ f: f, label: uniq(f.label, secTitle || f.id), kind: kindOf(f) });
    }
    (def.header || []).forEach(function (f) { addField(f, '기본 정보'); });
    (def.sections || []).forEach(function (s) {
      if (s.type === 'fields') (s.fields || []).forEach(function (f) { addField(f, s.title || s.id); });
    });
    var summary = (def.summary || []).map(function (s, i) { return { s: s, i: i, label: uniq(s.label, '요약'), kind: 'n' }; });

    var tableNames = {};
    var tables = (def.sections || []).filter(function (s) { return s.type === 'table'; }).map(function (s) {
      var u = {};
      TABLE_BASE.forEach(function (b) { u[b[0]] = 1; });
      var cols = (s.columns || []).filter(function (c) { return !c.sensitive && c.type !== 'photo'; }).map(function (c) {
        var l = String(c.label || c.id);
        if (u[l]) l = l + ' (' + c.id + ')';
        u[l] = 1;
        return { c: c, label: l, kind: kindOf(c) };
      });
      var name = sheetName('V_' + def.code + '_' + (s.title || s.id));
      if (tableNames[name]) name = sheetName('V_' + def.code + '_' + s.id);
      tableNames[name] = 1;
      return {
        sec: s, name: name, short: sheetName(s.title || s.id), cols: cols,
        header: TABLE_BASE.map(function (b) { return b[0]; }).concat(cols.map(function (x) { return x.label; })),
        kinds: TABLE_BASE.map(function (b) { return b[1]; }).concat(cols.map(function (x) { return x.kind; }))
      };
    });
    var L = {
      def: def,
      main: {
        name: sheetName('V_' + def.code + ' ' + (def.short || def.title || '')),
        header: BASE.map(function (b) { return b[0]; }).concat(fields.map(function (x) { return x.label; })).concat(summary.map(function (x) { return x.label; })),
        kinds: BASE.map(function (b) { return b[1]; }).concat(fields.map(function (x) { return x.kind; })).concat(summary.map(function (x) { return x.kind; }))
      },
      fields: fields,
      summary: summary,
      tables: tables,
      checks: (def.sections || []).filter(function (s) { return s.type === 'checklist'; })
    };
    LAYOUTS[ck] = L;
    return L;
  }

  /* =========================================================== 행 만들기 */

  function fieldValue(x, rec, d, fv, tags) {
    var f = x.f;
    if (!showOk(f.showIf, d, tags)) return '';
    var v = d[f.id];
    if (isEmpty(v) && f.type === 'computed') {
      v = fv[f.id];
      if (isEmpty(v) && f.calc && f.calc !== 'autoMonthly') v = calc(f.calc, f.args, d);
    }
    return cellValue(f, v, x.kind);
  }

  function summaryValue(x, rec, d) {
    var sm = rec.facts && rec.facts.sm;
    var v = Array.isArray(sm) && x.i < sm.length ? sm[x.i] : undefined;
    if (v && typeof v === 'object' && 'value' in v) v = v.value;
    if (isEmpty(v)) v = calc(x.s.calc, x.s.args, d);
    if (isEmpty(v)) return '';
    var n = num(v);
    return n === null ? String(v) : n;
  }

  function mainRow(L, rec, site) {
    var d = rec.data || {};
    var fv = (rec.facts && rec.facts.v) || {};
    var tags = site.tags || [];
    var row = [
      rec.id, rec.site || '', site.name || '', String(rec.date || '').slice(0, 10), rec.period || '', rec.shift || '', rec.status || '',
      stageText(L.def, rec), rec.author || '', dt(rec.submittedAt), dt(rec.confirmedAt), rec.confirmedBy || ''
    ];
    L.fields.forEach(function (x) { row.push(fieldValue(x, rec, d, fv, tags)); });
    L.summary.forEach(function (x) { row.push(summaryValue(x, rec, d)); });
    return row;
  }

  function tableRows(t, rec) {
    var list = (rec.data || {})[t.sec.id];
    if (!Array.isArray(list)) return [];
    return list.filter(function (r) { return r && typeof r === 'object'; }).map(function (r, i) {
      var row = [rec.id, i + 1, rec.site || '', String(rec.date || '').slice(0, 10)];
      t.cols.forEach(function (x) { row.push(cellValue(x.c, r[x.c.id], x.kind)); });
      return row;
    });
  }

  function checkRows(L, rec, site) {
    var d = rec.data || {};
    var tags = site.tags || [];
    var def = L.def;
    var formLabel = def.code + ' ' + (def.short || def.title || '');
    var out = [];
    L.checks.forEach(function (s) {
      var got = d[s.id] || {};
      (s.items || []).forEach(function (it) {
        var x = got[it.code] || {};
        var answered = !!(x && x.r);
        if (!answered && !showOk(it.showIf, d, tags)) return;
        out.push([rec.id, rec.site || '', String(rec.date || '').slice(0, 10), formLabel, s.title || s.id, it.code, it.text || '',
          answered ? x.r : '미점검', (x && x.note) || '']);
      });
    });
    return out;
  }

  function actRow(a, site) {
    var def = a.srcForm ? Db.form(a.srcForm) : null;
    return [
      a.id, a.site || '', site.name || '', a.srcId || '', a.srcForm ? a.srcForm + (def ? ' ' + (def.short || def.title || '') : '') : '',
      a.srcItem || '', a.title || '', a.detail || '', a.level || '', a.type || '', a.due || '', a.owner || '', a.status || '',
      a.photoBefore ? '있음' : '', a.photoAfter ? '있음' : '', dt(a.doneAt), a.doneBy || '', a.doneNote || '',
      dt(a.confirmedAt), a.confirmedBy || '', dt(a.createdAt), dt(a.updatedAt)
    ];
  }

  /* =========================================================== 월간지표 긴 표(F09) */

  function kpiSpec() {
    var FD = Db.forms();
    var kt = FD.kpiTable || {};
    var cols = (kt.columns && kt.columns.length) ? kt.columns.slice() : KPI_DEFAULT_COLS.slice();
    return {
      name: sheetName(kt.name || 'HQ_MonthlyData'),
      cols: cols,
      kinds: cols.map(function (c) {
        if (c === '지표값' || c === '제출차수') return 'n';
        if (c === '보고월' || c === '제출일시') return 'd';
        return 's';
      }),
      codes: (FD.kpiCodes || []).filter(function (c) { return c.inLongTable; }),
      job: kt.jobValue || '전체',
      keyPat: kt.key || '{사업장코드}_{YYYYMM}_{업무구분}_{지표코드}',
      keyIdx: cols.indexOf('기본키'),
      recIdx: cols.indexOf('기록번호'),
      revIdx: cols.indexOf('제출차수'),
      subIdx: cols.indexOf('제출일시'),
      statusIdx: cols.indexOf('보고상태')
    };
  }

  function monthOf(rec) {
    var m = String((rec.data && rec.data.reportMonth) || rec.period || rec.date || '').slice(0, 7);
    return /^\d{4}-\d{2}$/.test(m) ? m : '';
  }

  function nextMonth(m) {
    var y = Number(m.slice(0, 4));
    var mo = Number(m.slice(5, 7)) + 1;
    if (mo > 12) { mo = 1; y++; }
    return y + '-' + (mo < 10 ? '0' : '') + mo;
  }

  /** 시점 T('YYYY-MM-DDT00:00:00')에 열려 있던 조치인가(등록·조치중·보류·고객사 이관). */
  function openAt(a, T) {
    if (a.deleted) return false;
    var created = String(a.createdAt || '');
    if (!created || created >= T) return false;
    if (OPEN_ACT.indexOf(a.status) >= 0) return true;
    var closedAt = [a.doneAt, a.confirmedAt].filter(Boolean).sort()[0] || a.updatedAt || '';
    return !(closedAt && String(closedAt) < T);
  }

  /** scope=hq 지표(C01·C04)를 조치대장에서 계산. */
  function hqKpi(code, siteId, month, acts) {
    var T = code === 'C01' ? month + '-01T00:00:00' : code === 'C04' ? nextMonth(month) + '-01T00:00:00' : '';
    if (!T) return '';
    return (acts || []).filter(function (a) { return a.site === siteId && openAt(a, T); }).length;
  }

  function kpiRows(K, rec, site, def, acts) {
    var month = monthOf(rec);
    if (!month) return [];
    var d = rec.data || {};
    var fv = (rec.facts && rec.facts.v) || {};
    var ym = month.replace('-', '');
    var reviewer = d.reviewer;
    reviewer = Array.isArray(reviewer) ? reviewer.map(itemText).join(', ') : itemText(reviewer);
    return K.codes.map(function (c) {
      var v;
      if (c.source === 'hq') {
        v = hqKpi(c.code, rec.site, month, acts);
      } else {
        v = num(d[c.field]);
        if (v === null) v = num(fv[c.field]);
        if (v === null) v = '';
      }
      var st = v === '' ? '미입력' : (c.source === 'input' ? '입력' : '자동');
      var key = K.keyPat.replace('{사업장코드}', rec.site || '').replace('{YYYYMM}', ym).replace('{업무구분}', K.job).replace('{지표코드}', c.code);
      var vals = {
        '양식버전': rec.formVersion || def.version || '', '사업장코드': rec.site || '', '보고월': month + '-01', '사업장명': site.name || '',
        '업무구분': K.job, '지표코드': c.code, '지표명': c.label || '', '단위': c.unit || '', '지표값': v, '값상태': st,
        '보고상태': rec.status || '', '제출차수': num(rec.rev) === null ? '' : num(rec.rev), '제출일시': dt(rec.submittedAt),
        '작성자': rec.author || '', '검토자': reviewer, '기록번호': rec.id, '기본키': key
      };
      return K.cols.map(function (n) { return vals[n] === undefined ? '' : vals[n]; });
    });
  }

  /** a 가 b 보다 나중 판인가(제출차수 → 제출일시). */
  function newer(revA, subA, revB, subB) {
    var ra = num(revA) || 0;
    var rb = num(revB) || 0;
    if (ra !== rb) return ra > rb;
    return String(subA || '') >= String(subB || '');
  }

  /* =========================================================== 시트 쓰기 */

  /**
   * 칸에 쓸 값. 사용자 입력이 시트에서 수식·값으로 해석되지 않게 한다.
   * - '=', '+', '-', '@', 탭·줄바꿈으로 시작하는 글자는 모든 열에서 앞에 따옴표(구글 시트는 '+1+1'·'-A1' 도 수식으로 본다).
   * - 숫자 열('n')은 숫자만 숫자로 쓰고, 숫자로 못 바꾸는 글자는 따옴표로 글자 처리.
   * - 날짜 열('d')은 YYYY-MM-DD[ HH:mm[:ss]] 모양만 그대로, 나머지는 따옴표로 글자 처리.
   *   ('@' 서식이 아닌 열이라 글자가 자동 변환되지 않게.)
   */
  var FORMULA_LEAD = /^[=+\-@\t\r\n]/;
  var DATE_TEXT = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;
  var NUM_TEXT = /^-?\d+(\.\d+)?$/;
  function clean(v, kind) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return isFinite(v) ? v : '';
    if (typeof v === 'boolean') return v ? '예' : '아니오';
    var s = String(v);
    if (s.length > CELL_MAX) s = s.slice(0, CELL_MAX);
    if (s === '') return '';
    if (kind === 'n' && NUM_TEXT.test(s)) return Number(s);
    if (FORMULA_LEAD.test(s)) return "'" + s;
    if (kind === 'n') return "'" + s;
    if (kind === 'd' && !DATE_TEXT.test(s)) return "'" + s;
    return s;
  }

  function colWidth(label, kind) {
    if (label === '기록번호' || label === '조치번호' || label === '기본키') return 170;
    if (kind === 'd') return 120;
    if (kind === 'n') return Math.min(160, Math.max(70, String(label).length * 12 + 24));
    return Math.min(260, Math.max(90, String(label).length * 14 + 28));
  }

  /** rows 를 r1 행부터 쓴다. 글자 열 구간만 '@' 서식. 큰 묶음은 나눠 쓴다. */
  function writeBlock(sh, r1, rows, kinds) {
    if (!rows.length) return;
    var w = kinds.length;
    Db.fit(sh, r1 + rows.length - 1, w);
    for (var off = 0; off < rows.length; off += BATCH) {
      var part = rows.slice(off, off + BATCH);
      var start = r1 + off;
      var c = 0;
      while (c < w) {
        if (kinds[c] !== 's') { c++; continue; }
        var e = c;
        while (e + 1 < w && kinds[e + 1] === 's') e++;
        sh.getRange(start, c + 1, part.length, e - c + 1).setNumberFormat('@');
        c = e + 1;
      }
      sh.getRange(start, 1, part.length, w).setValues(part.map(function (r) {
        var out = new Array(w);
        for (var i = 0; i < w; i++) out[i] = clean(r[i], kinds[i]);
        return out;
      }));
    }
  }

  function styleHeader(sh, header, kinds) {
    Db.fit(sh, 1, header.length);
    var r = sh.getRange(1, 1, 1, header.length);
    r.setNumberFormat('@');
    r.setValues([header.map(function (h) { return clean(h, 's'); })]);
    r.setFontWeight('bold');
    sh.setFrozenRows(1);
    setWidths(sh, header, kinds);
  }

  /**
   * 열 너비: 모든 열을 한 번에 같은 너비로, 첫 열이 번호 열이면 그 열만 넓게(호출 1~2번).
   * 열마다 setColumnWidth 를 부르면 큰 양식에서 수백 번 호출돼 재구축·첫 제출이 느려진다. 보기 좋게일 뿐이라 실패는 무시.
   */
  function setWidths(sh, header, kinds) {
    try {
      var n = header.length;
      if (!n) return;
      if (typeof sh.setColumnWidths === 'function') sh.setColumnWidths(1, n, 130);
      var w1 = colWidth(header[0], kinds[0]);
      if (w1 > 130) sh.setColumnWidth(1, w1);
    } catch (e) { /* 너비는 보기 좋게일 뿐 */ }
  }

  /**
   * 쓰지 않는 칸 줄이기. 스프레드시트 한 파일의 셀 한도(1,000만)는 '할당된' 칸 기준이라,
   * 새 시트 기본 26열·1,000행이나 옛 내용보다 큰 격자를 남기지 않는다. rows 는 머리 포함 행 수, slack 은 덧붙일 여유 행.
   */
  function trimGrid(sh, rows, cols, slack) {
    try {
      var mc = sh.getMaxColumns();
      if (cols >= 1 && mc > cols) sh.deleteColumns(cols + 1, mc - cols);
      var keep = Math.max(2, rows + (slack || 0));
      var mr = sh.getMaxRows();
      if (mr > keep) sh.deleteRows(keep + 1, mr - keep);
    } catch (e) { /* 줄이기는 한도 여유를 위한 것 — 실패해도 내용은 맞다 */ }
  }

  /** 시트를 비우고 머리 + 행을 새로 쓴다(재구축·내보내기). */
  function writeTable(ss, name, header, kinds, rows) {
    var sh = ss.getSheetByName(name);
    if (sh) sh.clear(); else sh = ss.insertSheet(name);
    rows = rows || [];
    styleHeader(sh, header, kinds);
    writeBlock(sh, 2, rows, kinds);
    trimGrid(sh, rows.length + 1, header.length, GROW);
    return sh;
  }

  /**
   * 평탄화 시트 열기. 머리가 바뀌었으면(양식에 필드 추가) 빠진 열을 끝에 붙인다.
   * 반환 { sh, header(시트 순서), kinds, map(배치 열 → 시트 열), last } 또는 create=false 이고 없으면 null.
   */
  function vsheet(ss, name, header, kinds, create) {
    var sh = ss.getSheetByName(name);
    if (!sh) {
      if (!create) return null;
      sh = ss.insertSheet(name);
      styleHeader(sh, header, kinds);
      trimGrid(sh, 1, header.length, GROW);
      return { sh: sh, header: header.slice(), kinds: kinds.slice(), map: header.map(function (h, i) { return i; }), last: 1 };
    }
    var lc = sh.getLastColumn();
    var cur = lc ? sh.getRange(1, 1, 1, lc).getValues()[0].map(function (v) { return String(v === null || v === undefined ? '' : v).replace(/^'/, '').trim(); }) : [];
    var missing = [];
    header.forEach(function (h) { if (cur.indexOf(h) < 0) missing.push(h); });
    if (missing.length) {
      Db.fit(sh, 1, cur.length + missing.length);
      var r = sh.getRange(1, cur.length + 1, 1, missing.length);
      r.setNumberFormat('@');
      r.setValues([missing]);
      r.setFontWeight('bold');
      if (!cur.length) sh.setFrozenRows(1);
      cur = cur.concat(missing);
    }
    var sk = cur.map(function (h) { var i = header.indexOf(h); return i < 0 ? 's' : kinds[i]; });
    return { sh: sh, header: cur, kinds: sk, map: header.map(function (h) { return cur.indexOf(h); }), last: Math.max(1, sh.getLastRow()) };
  }

  function toSheetRow(vs, row) {
    var out = new Array(vs.header.length);
    for (var i = 0; i < out.length; i++) out[i] = '';
    vs.map.forEach(function (j, i) { if (j >= 0) out[j] = row[i] === undefined ? '' : row[i]; });
    return out;
  }

  /** 열 col(0부터)의 값 → [행 번호] */
  function keyRows(vs, col) {
    var out = {};
    if (vs.last < 2 || col < 0) return out;
    var vals = vs.sh.getRange(2, col + 1, vs.last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      var k = String(vals[i][0] === null || vals[i][0] === undefined ? '' : vals[i][0]).replace(/^'/, '').trim();
      if (!k) continue;
      (out[k] = out[k] || []).push(i + 2);
    }
    return out;
  }

  /** 행 번호들을 아래에서부터 이어진 구간으로 묶어 지운다. */
  function deleteRowNums(vs, nums) {
    if (!nums || !nums.length) return 0;
    var s = nums.slice().sort(function (a, b) { return b - a; });
    var i = 0;
    while (i < s.length) {
      var end = s[i];
      var start = end;
      while (i + 1 < s.length && s[i + 1] === start - 1) { i++; start--; }
      vs.sh.deleteRows(start, end - start + 1);
      i++;
    }
    vs.last = Math.max(1, vs.last - s.length);
    return s.length;
  }

  /** 행 하나씩 키로 upsert: 있으면 제자리에 덮고(이어진 구간마다 한 번), 없으면 끝에 한꺼번에 붙인다. */
  function upsertKeyed(vs, keyCol, pairs, rowsIndex) {
    var idx = rowsIndex || keyRows(vs, keyCol);
    var inPlace = [];
    var add = [];
    pairs.forEach(function (p) {
      var at = idx[p[0]];
      var row = toSheetRow(vs, p[1]);
      if (at && at.length) {
        inPlace.push({ row: at[0], vals: row });
        if (at.length > 1) deleteLater(vs, at.slice(1));
      } else {
        add.push(row);
      }
    });
    inPlace.sort(function (a, b) { return a.row - b.row; });
    var i = 0;
    while (i < inPlace.length) {
      var j = i;
      while (j + 1 < inPlace.length && inPlace[j + 1].row === inPlace[j].row + 1) j++;
      writeBlock(vs.sh, inPlace[i].row, inPlace.slice(i, j + 1).map(function (x) { return x.vals; }), vs.kinds);
      i = j + 1;
    }
    if (add.length) {
      writeBlock(vs.sh, vs.last + 1, add, vs.kinds);
      vs.last += add.length;
    }
    if (vs.dups) { deleteRowNums(vs, vs.dups); vs.dups = null; }
  }

  function deleteLater(vs, nums) { vs.dups = (vs.dups || []).concat(nums); }

  /** 기록 하나의 여러 행(표·체크리스트): 같은 수·이어져 있으면 제자리, 아니면 지우고 끝에 붙임. */
  function replaceGroup(vs, key, rows, known) {
    var at = known ? (keyRows(vs, 0)[key] || []) : [];
    var sheetRows = rows.map(function (r) { return toSheetRow(vs, r); });
    var contiguous = at.length > 0 && at[at.length - 1] - at[0] === at.length - 1;
    if (at.length === sheetRows.length && contiguous) {
      if (sheetRows.length) writeBlock(vs.sh, at[0], sheetRows, vs.kinds);
      return;
    }
    if (at.length) deleteRowNums(vs, at);
    if (sheetRows.length) {
      writeBlock(vs.sh, vs.last + 1, sheetRows, vs.kinds);
      vs.last += sheetRows.length;
    }
  }

  function setColumnFor(vs, nums, colName, value) {
    var c = vs.header.indexOf(colName);
    if (c < 0 || !nums || !nums.length) return;
    nums.forEach(function (r) {
      var rg = vs.sh.getRange(r, c + 1, 1, 1);
      rg.setNumberFormat('@');
      rg.setValue(clean(value, 's'));
    });
  }

  /* =========================================================== 기록 하나 반영 */

  function applyRecord(rec) {
    var def = Db.form(rec.form);
    if (!def) return false;
    var ss = Db.book();
    var site = Db.get('sites', rec.site) || {};
    var L = layout(def);
    var isKpi = def.code === 'F09';
    var K = isKpi ? kpiSpec() : null;

    if (!eligible(rec)) {
      dropRecord(ss, L, rec.id, K);
      return true;
    }

    var main = vsheet(ss, L.main.name, L.main.header, L.main.kinds, true);
    var mainIdx = keyRows(main, 0);
    var existed = !!(mainIdx[rec.id] && mainIdx[rec.id].length);

    if (rec.status === '반려' && existed) {
      setColumnFor(main, mainIdx[rec.id], '상태', '반려');
      if (K) {
        var ks = vsheet(ss, K.name, K.cols, K.kinds, false);
        if (ks) setColumnFor(ks, keyRows(ks, K.recIdx)[rec.id], '보고상태', '반려');
      }
      return true;
    }

    upsertKeyed(main, 0, [[rec.id, mainRow(L, rec, site)]], mainIdx);

    L.tables.forEach(function (t) {
      var rows = tableRows(t, rec);
      var vs = vsheet(ss, t.name, t.header, t.kinds, rows.length > 0);
      if (vs) replaceGroup(vs, rec.id, rows, existed);
    });

    if (L.checks.length) {
      var crow = checkRows(L, rec, site);
      var cs = vsheet(ss, CHECK_SHEET, CHECK_COLS.map(function (c) { return c[0]; }), CHECK_COLS.map(function (c) { return c[1]; }), crow.length > 0);
      if (cs) replaceGroup(cs, rec.id, crow, existed);
    }

    if (K) applyKpi(ss, K, rec, site, def);
    return true;
  }

  function applyKpi(ss, K, rec, site, def) {
    var acts = Db.all('acts').filter(function (a) { return a.site === rec.site && !a.deleted; });
    var rows = kpiRows(K, rec, site, def, acts);
    var vs = vsheet(ss, K.name, K.cols, K.kinds, true);
    var all = vs.last >= 2 ? vs.sh.getRange(2, 1, vs.last - 1, vs.header.length).getValues() : [];
    var byKey = {};
    var mine = [];
    var kc = vs.header.indexOf('기본키');
    var rc = vs.header.indexOf('기록번호');
    var vc = vs.header.indexOf('제출차수');
    var sc = vs.header.indexOf('제출일시');
    all.forEach(function (r, i) {
      var k = String(r[kc] || '').trim();
      if (k) (byKey[k] = byKey[k] || []).push(i + 2);
      if (String(r[rc] || '').trim() === rec.id) mine.push(i + 2);
    });
    // 같은 기본키에 다른 기록이 더 나중 판이면(제출차수 → 제출일시) 이번 것은 넣지 않는다.
    var first = rows[0];
    if (first) {
      var at = byKey[first[K.keyIdx]];
      if (at && at.length) {
        var ex = all[at[0] - 2];
        var exRec = String(ex[rc] || '').trim();
        var exSub = ex[sc];
        if (Object.prototype.toString.call(exSub) === '[object Date]') exSub = Utilities.formatDate(exSub, APP.tz, 'yyyy-MM-dd HH:mm:ss');
        if (exRec && exRec !== rec.id && !newer(rec.rev, dt(rec.submittedAt), ex[vc], exSub)) return;
      }
    }
    var keys = {};
    rows.forEach(function (r) { keys[r[K.keyIdx]] = 1; });
    var stale = mine.filter(function (n) { return !keys[String(all[n - 2][kc] || '').trim()]; });
    var idx = {};
    Object.keys(byKey).forEach(function (k) { if (keys[k]) idx[k] = byKey[k]; });
    upsertKeyed(vs, kc, rows.map(function (r) { return [r[K.keyIdx], r]; }), idx);
    if (stale.length) deleteRowNums(vs, stale);
  }

  function dropRecord(ss, L, id, K) {
    var names = [L.main.name].concat(L.tables.map(function (t) { return t.name; }));
    if (L.checks.length) names.push(CHECK_SHEET);
    names.forEach(function (n) {
      var sh = ss.getSheetByName(n);
      if (!sh) return;
      var vs = { sh: sh, header: [], kinds: [], map: [], last: Math.max(1, sh.getLastRow()) };
      deleteRowNums(vs, keyRows(vs, 0)[id]);
    });
    if (K) {
      var ks = vsheet(ss, K.name, K.cols, K.kinds, false);
      if (ks) deleteRowNums(ks, keyRows(ks, ks.header.indexOf('기록번호'))[id]);
    }
  }

  /* =========================================================== 공개 */

  /**
   * 이 기록이 쓸 평탄화 시트가 없으면 미리 만든다(잠금 밖에서 — 시트 만들기는 느려서 다른 저장을 막지 않게).
   * 동시에 두 실행이 같은 시트를 만들려 하면 한쪽 insertSheet 가 실패하는데, 그건 이미 있다는 뜻이라 무시한다.
   */
  function prepareSheets(rec) {
    try {
      if (!eligible(rec) || rec.status === '반려') return;
      var def = Db.form(rec.form);
      if (!def) return;
      var ss = Db.book();
      var L = layout(def);
      var want = [[L.main.name, L.main.header, L.main.kinds]];
      L.tables.forEach(function (t) { if (tableRows(t, rec).length) want.push([t.name, t.header, t.kinds]); });
      if (L.checks.length && checkRows(L, rec, {}).length) {
        want.push([CHECK_SHEET, CHECK_COLS.map(function (c) { return c[0]; }), CHECK_COLS.map(function (c) { return c[1]; })]);
      }
      if (def.code === 'F09') { var K = kpiSpec(); want.push([K.name, K.cols, K.kinds]); }
      want.forEach(function (w) {
        if (ss.getSheetByName(w[0])) return;
        try { vsheet(ss, w[0], w[1], w[2], true); } catch (e) { /* 다른 실행이 막 만들었다 */ }
      });
    } catch (e) {
      console.warn('평탄화 시트 미리 만들기 실패(' + rec.id + '): ' + (e && e.message || e));
    }
  }

  /** 잠금 안에서 저장된 최신 기록으로 바꾼다(잠금 밖 후처리 순서가 뒤바뀌어도 마지막 상태가 남게). */
  function latestRecord(rec) {
    var cur = null;
    try { cur = Db.get('records', rec.id); } catch (e) { cur = null; }
    return cur || rec;
  }

  function onRecord(rec) {
    if (!rec || !rec.id) return false;
    try {
      prepareSheets(rec.data === undefined || rec.data === null ? latestRecord(rec) : rec);
      return Db.withLock(function () {
        return applyRecord(latestRecord(rec));
      });
    } catch (e) {
      console.warn('평탄화 시트 갱신 실패(' + rec.id + '): ' + (e && e.message || e));
      return false;
    }
  }

  function applyAct(ss, act) {
    var header = ACT_COLS.map(function (c) { return c[0]; });
    var kinds = ACT_COLS.map(function (c) { return c[1]; });
    if (act.deleted) {
      var old = vsheet(ss, ACT_SHEET, header, kinds, false);
      if (old) deleteRowNums(old, keyRows(old, 0)[act.id]);
      return true;
    }
    var site = Db.get('sites', act.site) || {};
    var vs = vsheet(ss, ACT_SHEET, header, kinds, true);
    upsertKeyed(vs, 0, [[act.id, actRow(act, site)]]);
    return true;
  }

  function onAct(act) {
    if (!act || !act.id) return false;
    try {
      return Db.withLock(function () {
        var cur = null;
        try { cur = Db.get('acts', act.id); } catch (e) { cur = null; }
        return applyAct(Db.book(), cur || act);
      });
    } catch (e) {
      console.warn('조치대장 시트 갱신 실패(' + act.id + '): ' + (e && e.message || e));
      return false;
    }
  }

  function siteMap(sites) {
    var m = {};
    (sites || Db.all('sites')).forEach(function (s) { m[s.id] = s; });
    return m;
  }

  /**
   * 한 양식의 기록들 → 평탄화 표 목록(재구축·내보내기 공용). opts.names='export' 면 짧은 시트 이름.
   * 반환 [{name, header, kinds, rows}] (본표, 행이 있는 표 섹션, 체크리스트 순)
   */
  function tablesFor(def, recs, sites, opts) {
    var L = layout(def);
    var sm = sites && !Array.isArray(sites) ? sites : siteMap(sites);
    var forExport = opts && opts.names === 'export';
    var main = { name: forExport ? sheetName(def.code + ' ' + (def.short || def.title || '')) : L.main.name, header: L.main.header, kinds: L.main.kinds, rows: [] };
    var tabs = L.tables.map(function (t) { return { name: forExport ? t.short : t.name, header: t.header, kinds: t.kinds, rows: [] }; });
    var checks = { name: forExport ? '점검결과' : CHECK_SHEET, header: CHECK_COLS.map(function (c) { return c[0]; }), kinds: CHECK_COLS.map(function (c) { return c[1]; }), rows: [] };
    (recs || []).forEach(function (rec) {
      var site = sm[rec.site] || {};
      main.rows.push(mainRow(L, rec, site));
      L.tables.forEach(function (t, i) { pushAll(tabs[i].rows, tableRows(t, rec)); });
      if (L.checks.length) pushAll(checks.rows, checkRows(L, rec, site));
    });
    var out = [main].concat(tabs.filter(function (t) { return t.rows.length; }));
    if (checks.rows.length) out.push(checks);
    return out;
  }

  /** 조치 목록 → 조치대장 표 */
  function actTable(acts, sites, name) {
    var sm = sites && !Array.isArray(sites) ? sites : siteMap(sites);
    return {
      name: name || ACT_SHEET,
      header: ACT_COLS.map(function (c) { return c[0]; }),
      kinds: ACT_COLS.map(function (c) { return c[1]; }),
      rows: (acts || []).map(function (a) { return actRow(a, sm[a.site] || {}); })
    };
  }

  /** 재구축에 쓸 표 전부를 만든다(읽기만 — 잠금 없이). → [{name, header, kinds, rows}] (KPI 시트 맨 끝) */
  function buildAll() {
    var sm = siteMap();
    var acts = Db.all('acts').filter(function (a) { return !a.deleted; });
    var recs = Db.all('records').filter(eligible).sort(function (a, b) {
      return String(a.date || '').localeCompare(String(b.date || '')) || String(a.id).localeCompare(String(b.id));
    });
    var byForm = {};
    var order = [];
    recs.forEach(function (r) {
      if (!byForm[r.form]) { byForm[r.form] = []; order.push(r.form); }
      byForm[r.form].push(r);
    });
    var FD = Db.forms();
    var formOrder = (FD.forms || []).map(function (f) { return f.code; });
    order.sort(function (a, b) { return formOrder.indexOf(a) - formOrder.indexOf(b); });

    var tables = [];
    var checkAll = null;
    var K = kpiSpec();
    var kpiBest = {};
    var kpiOrder = [];
    var actsBySite = {};
    acts.forEach(function (a) { (actsBySite[a.site] = actsBySite[a.site] || []).push(a); });

    order.forEach(function (code) {
      var def = Db.form(code);
      if (!def) return;
      tablesFor(def, byForm[code], sm).forEach(function (t) {
        if (t.name === CHECK_SHEET) {
          if (!checkAll) checkAll = t; else pushAll(checkAll.rows, t.rows);
        } else {
          tables.push(t);
        }
      });
      if (code === 'F09') {
        byForm[code].forEach(function (rec) {
          kpiRows(K, rec, sm[rec.site] || {}, def, actsBySite[rec.site] || []).forEach(function (row) {
            var k = row[K.keyIdx];
            var cur = kpiBest[k];
            if (!cur) { kpiOrder.push(k); kpiBest[k] = { rec: rec, row: row }; return; }
            if (cur.rec.id === rec.id || newer(rec.rev, rec.submittedAt, cur.rec.rev, cur.rec.submittedAt)) kpiBest[k] = { rec: rec, row: row };
          });
        });
      }
    });
    if (checkAll) tables.push(checkAll);
    tables.push(actTable(acts, sm));
    tables.push({ name: K.name, header: K.cols, kinds: K.kinds, rows: kpiOrder.map(function (k) { return kpiBest[k].row; }) });
    return tables;
  }

  /** 재구축이 시작된 뒤 바뀐 기록·조치를 다시 반영한다(시트별로 잠금을 나눠 잡았으므로 그 사이 저장분이 덮였을 수 있다). */
  function catchUp(since) {
    var n = 0;
    Db.withLock(function () {
      var ss = Db.book();
      Db.all('records').forEach(function (r) {
        if (String(r.updatedAt || '') >= since) { try { applyRecord(r); n++; } catch (e) { console.warn('재구축 뒤 반영 실패(' + r.id + '): ' + (e && e.message || e)); } }
      });
      Db.all('acts').forEach(function (a) {
        if (String(a.updatedAt || '') >= since) { try { applyAct(ss, a); n++; } catch (e) { console.warn('재구축 뒤 반영 실패(' + a.id + '): ' + (e && e.message || e)); } }
      });
    });
    return n;
  }

  function readResume() {
    try {
      var st = Db.kvGet(RESUME_KEY, null);
      if (st && typeof st === 'object' && Array.isArray(st.done) && st.since && Date.now() - Number(st.t || 0) < RESUME_TTL_MS) return st;
    } catch (e) { /* 없으면 처음부터 */ }
    return null;
  }

  function saveResume(st) {
    try { Db.withLock(function () { Db.kvSet(RESUME_KEY, st); }); } catch (e) { console.warn('재구축 진행 상태 저장 실패: ' + (e && e.message || e)); }
  }

  /**
   * 모든 V_ 시트와 월간지표 시트를 지우고 다시 만든다.
   * - 표 계산은 잠금 없이, 시트 쓰기는 시트 하나마다 잠금(그 사이 다른 사용자 저장이 기다리지 않게).
   * - 시간 예산(4분 30초)이 다하면 멈추고 진행 상태를 kv 에 남긴다 → {partial:true, left:n}. 다시 부르면 남은 시트부터 잇는다.
   * - 다 쓰면 재구축 시작 뒤 바뀐 기록·조치를 다시 반영하고, 쓰지 않는 V_ 시트를 지운다.
   * 반환 { sheets:[이번에 쓴 시트 이름], rows:n, partial, left, caughtUp }
   */
  function rebuildAll() {
    var t0 = Date.now();
    var st = readResume() || { since: Db.now(), done: [], t: t0 };
    var tables = buildAll();
    var all = tables.map(function (t) { return t.name; });
    var ss = Db.book();
    var names = [];
    var total = 0;
    var left = 0;
    tables.forEach(function (t) {
      if (st.done.indexOf(t.name) >= 0) return;
      if (names.length && Date.now() - t0 > BUDGET_MS) { left++; return; }
      Db.withLock(function () { writeTable(ss, t.name, t.header, t.kinds, t.rows); });
      names.push(t.name);
      st.done.push(t.name);
      total += t.rows.length;
    });
    if (left) {
      st.t = Date.now();
      saveResume(st);
      try { Db.log('system', 'views', '', '평탄화 시트 재구축 일부: 시트 ' + names.length + '개 씀, ' + left + '개 남음(다시 누르면 이어서)'); } catch (e) { /* 무시 */ }
      return { sheets: names, rows: total, partial: true, left: left };
    }
    var caught = catchUp(st.since);
    Db.withLock(function () {
      ss.getSheets().forEach(function (sh) {
        var n = sh.getName();
        if (n.indexOf('V_') === 0 && all.indexOf(n) < 0) ss.deleteSheet(sh);
      });
      try { Db.kvSet(RESUME_KEY, null); } catch (e) { /* 무시 */ }
    });
    try { Db.log('system', 'views', '', '평탄화 시트 재구축: 시트 ' + all.length + '개, ' + total + '행' + (caught ? ', 진행 중 바뀐 ' + caught + '건 다시 반영' : '')); } catch (e) { /* 기록 실패는 무시 */ }
    return { sheets: all, rows: total, partial: false, left: 0, caughtUp: caught };
  }

  return {
    onRecord: onRecord,
    onAct: onAct,
    rebuildAll: rebuildAll,
    tablesFor: tablesFor,
    actTable: actTable,
    writeTable: writeTable,
    layout: layout,
    eligible: eligible,
    sheetName: sheetName
  };
})();
