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
