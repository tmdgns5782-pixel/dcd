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
 * 로그인 실패: 캐시 'fail:'+id 카운터, 5회 실패 → 15분 잠김.
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

  function failKey(id) { return 'fail:' + String(id).toLowerCase(); }
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
    if (id.length > 60 || pw.length > 200) fail('AUTH', '아이디 또는 비밀번호가 맞지 않습니다');
    checkLocked(id);
    var user = findUser(id);
    var ok = !!(user && user.active !== false && HQ_ROLES.indexOf(user.role) >= 0 && user.salt && user.pwHash &&
      safeEq(Db.hash(user.salt, pw), user.pwHash));
    if (!ok) {
      var n = noteFail(id);
      if (user) audit('(로그인 시도)', 'login-fail', user.id, '본사 로그인 실패 ' + n + '회' + (n >= FAIL_MAX ? ' — 15분 잠김' : ''));
      fail('AUTH', failMsg('아이디 또는 비밀번호가 맞지 않습니다', n));
    }
    clearFail(id);
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
    var token = Db.withLock(function () { return createSession(me, APP.siteSessionDays); });
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
