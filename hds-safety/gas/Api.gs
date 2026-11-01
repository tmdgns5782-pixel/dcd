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
  var BLOCK_MIME = /^(text\/html|application\/(x-)?javascript|text\/javascript|application\/x-msdownload|application\/x-sh|application\/xhtml\+xml)$/;
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
      else if (name === 'Ai' && typeof Ai !== 'undefined') m = Ai;
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

  function indexRow(r) {
    var o = {};
    REC_INDEX_KEYS.forEach(function (k) { o[k] = r[k] === undefined ? (k === 'stageDone' ? [] : (k === 'facts' ? {} : '')) : r[k]; });
    if (r.deleted) o.deleted = true;
    return o;
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
    var requests = Db.all('requests').filter(function (r) { return !isSite || reqVisibleToSite(r, me.site); });
    var reads = Db.all('reads').filter(function (r) { return mine(r.site); });
    var acts = Db.all('acts').filter(function (a) { return !a.deleted && mine(a.site); });
    var index = Db.all('records').filter(function (r) {
      if (r.deleted || !mine(r.site)) return false;
      if (r.status === '작성중' || r.status === '반려') return true;
      var d = r.date || String(r.updatedAt || '').slice(0, 10);
      return d >= since;
    }).map(indexRow);

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
    }).map(indexRow);
  }

  function hRecordsGet(p, me) {
    return loadRecord(p.id, me);
  }

  function hRecordsBulkGet(p, me) {
    var ids = strList(p.ids, 500, LIM.id, '기록 번호 목록');
    var out = [];
    ids.forEach(function (id) {
      var r = Db.get('records', id);
      if (!r || !Auth.canSite(me, r.site) || (r.deleted && me.kind === 'site')) return;
      out.push(r);
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
    if (!Array.isArray(rec.stageDone)) rec.stageDone = [];
    rec.period = periodFor(def, rec, src.period);
    rec.updatedAt = now();
    return { cur: cur, rec: rec, def: def };
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
    if (isNew) rec.id = newRecordId(x.def, rec.site, rec.date, me);
    writeRecord(rec, isNew);
    if (rec.status !== '작성중' || rec.stageDone.length) views('onRecord', rec, ctx);
    // 자동 임시저장(3초마다)이 감사 기록을 채우지 않도록 새로 만들 때만 남긴다. 제출·검토·삭제는 각 핸들러가 남긴다.
    if (isNew) audit(ctx, 'record', rec.id, formName(x.def) + ' 새로 작성(임시저장)');
    return { record: rec };
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
    if (me && me.kind === 'site' && hqOnlyStage(stages[idx]) && done.indexOf(sid) < 0) fail('FORBIDDEN', '본사가 쓰는 단계입니다(' + (stages[idx].label || sid) + '). 사업장에서는 제출할 수 없습니다');
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

  function hRecordsSubmit(p, me, ctx) {
    var x = prepRecord(p, me);
    var rec = x.rec, def = x.def, cur = x.cur;
    var prev = cur ? clone(cur) : null;
    var isNew = !cur;
    if (isNew) rec.id = newRecordId(def, rec.site, rec.date, me);
    var stage = null;
    var wasReturned = cur && cur.status === '반려';
    if (def.stages && def.stages.length) {
      stage = applyStage(def, rec, p.stageId, me);
    } else {
      rec.status = '제출';
      rec.submittedAt = rec.submittedAt || now();
    }
    rec.rev = (Number(cur && cur.rev) || 0) + 1;
    rec.updatedAt = now();
    writeRecord(rec, isNew);
    var acts = upsertActs(def, rec, p.acts, me);
    views('onRecord', rec, ctx);
    acts.forEach(function (a) { views('onAct', a, ctx); });

    var what = formName(def) + (stage ? ' ' + (stage.label || stage.id) + ' 단계' : '') + (wasReturned ? ' 다시 제출' : ' 제출');
    audit(ctx, 'submit', rec.id, what + ' (rev ' + rec.rev + (acts.length ? ', 조치 ' + acts.length + '건' : '') + ')');
    var done = clone(rec);
    later(ctx, 'Dispatch.onRecordSubmitted', function () {
      var D = mod('Dispatch');
      if (D && typeof D.onRecordSubmitted === 'function') D.onRecordSubmitted(done, me, prev);
    });
    return { record: rec, acts: acts };
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

  function hRecordsDelete(p, me, ctx) {
    Db.all('records', { fresh: true });
    var r = clone(loadRecord(p.id, me));
    if (r.deleted) return {};
    var reason = str(p.reason, LIM.memo, '삭제 사유');
    if (me.kind === 'site') {
      if (r.status !== '작성중' && r.status !== '반려') {
        fail('FORBIDDEN', '제출한 기록은 사업장에서 지울 수 없습니다. 본사에 삭제를 요청하세요');
      }
      if (r.status === '작성중' && (r.stageDone || []).length) {
        fail('FORBIDDEN', '단계 보고가 올라간 기록은 사업장에서 지울 수 없습니다. 본사에 삭제를 요청하세요');
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
    if (p.due) a.due = ymd(p.due, '기한');
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
      var toStatus = src.status ? String(src.status) : '';
      if (toStatus && toStatus !== before.status) {
        applyTransition(a, toStatus, str(src.note, LIM.memo, '메모'), photoRef(src.photo), me);
      }
      if (changed.length) {
        a.history = (Array.isArray(a.history) ? a.history : []).concat([histEntry(me, a.status, a.status, '내용 수정(' + changed.join(', ') + ')')]);
        a.updatedAt = t;
      }
      if (!changed.length && !(toStatus && toStatus !== before.status)) return { act: a };
      Db.upsert('acts', a);
      audit(ctx, 'act', a.id, '조치 수정' + (changed.length ? ': ' + changed.join(', ') : ''));
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

  function hPeopleBulk(p, me, ctx) {
    var site = scopeSite(me, p.site ? str(p.site, 8, '사업장') : '', 'people.bulk');
    if (!site) fail('INVALID', '사업장을 고르세요');
    getSite(site);
    if (!Array.isArray(p.rows)) fail('INVALID', '명부 행이 없습니다');
    if (p.rows.length > 2000) fail('INVALID', '한 번에 2,000명까지 올릴 수 있습니다');
    var existing = {};
    Db.all('people', { fresh: true }).forEach(function (x) {
      if (x.site === site && x.active !== false) existing[String(x.name || '').replace(/\s+/g, '')] = true;
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

  function hReadsMark(p, me) {
    var refId = str(p.refId, LIM.id, '대상 번호', true);
    if (me.kind === 'site') {
      var r = Db.get('requests', refId);
      if (r && !reqVisibleToSite(r, me.site)) forbid(me, refId, '받지 않은 요청 열람 표시 시도', '우리 사업장이 받은 요청이 아닙니다');
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

  function extOf(mime) {
    var m = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'application/pdf': 'pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx', 'text/plain': 'txt', 'text/csv': 'csv'
    };
    return m[mime] || 'bin';
  }

  function hFilesPut(p, me, ctx) {
    var dataUrl = p.dataUrl;
    if (typeof dataUrl !== 'string' || !dataUrl) fail('INVALID', '파일 내용이 없습니다');
    var m = /^data:([^;,]*)((?:;[^;,]*)*),/.exec(dataUrl.slice(0, 400));
    if (!m || !/;base64/i.test(m[2] || '')) fail('INVALID', '파일 형식이 맞지 않습니다(base64 데이터 URL 이어야 합니다)');
    var mime = (m[1] || 'application/octet-stream').toLowerCase();
    if (BLOCK_MIME.test(mime)) fail('INVALID', '이 형식의 파일은 올릴 수 없습니다: ' + mime);
    var b64 = dataUrl.length - m[0].length;
    var padN = /==$/.test(dataUrl) ? 2 : (/=$/.test(dataUrl) ? 1 : 0);
    var bytes = Math.floor(b64 * 3 / 4) - padN;
    if (bytes <= 0) fail('INVALID', '빈 파일입니다');
    if (bytes > APP.maxFileBytes) fail('INVALID', '파일이 너무 큽니다. 8MB 까지 올릴 수 있습니다');
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
    var name = cleanFileName(p.name) || ((kind === 'photo' ? '사진' : kind === 'sign' ? '서명' : '첨부') + '-' + now().replace(/[^0-9]/g, '').slice(2, 14) + '.' + extOf(mime));
    var saved = Db.saveDataUrl(dataUrl, name, site);
    var f = {
      id: 'FILE-' + Db.uuid8(), site: site, recordId: recordId, name: name, mime: (saved && saved.mime) || mime,
      size: Number(saved && saved.size) || bytes, driveId: saved.driveId, kind: kind, createdAt: now(), createdBy: whoOf(me)
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
    if (has(src, 'ai')) {
      if (!isObj(src.ai)) fail('INVALID', 'AI 설정이 올바르지 않습니다');
      out.ai = isObj(out.ai) ? out.ai : {};
      if (has(src.ai, 'enabled')) out.ai.enabled = bool(src.ai.enabled);
      if (has(src.ai, 'model')) out.ai.model = str(src.ai.model, 80, 'AI 모델');
      changed.push('ai');
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

  function hAiInsight(p, me, ctx) {
    if (!isObj(p.scope)) p.scope = {};
    if (p.digest !== undefined && !isObj(p.digest)) fail('INVALID', '분석 요약 숫자가 올바르지 않습니다');
    if (p.digest && JSON.stringify(p.digest).length > 60000) fail('INVALID', '분석 요약이 너무 큽니다');
    var out = callMod('Ai', 'insight', [p, me]);
    audit(ctx, 'ai', '', 'AI 분석 요약 요청');
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
    'reads.mark': { perm: 'any', lock: true, fn: hReadsMark },

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
    'admin.log': { perm: 'hq', fn: hLog },

    'ai.insight': { perm: 'hq', fn: hAiInsight }
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
