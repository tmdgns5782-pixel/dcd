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
    var link = siteLink(site);
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
        button: appUrl() ? { label: '조치대장 열기', url: appUrl() + '#/acts' } : null
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

/** 트리거가 부르는 매일 점검(08시). 세션 정리 + 독촉 + 기한경과 높음 조치 요약. */
function cronDaily() {
  try {
    return Dispatch.daily();
  } catch (e) {
    try { Db.log('system', 'cron', 'daily', '매일 점검 실패: ' + ((e && e.message) || e)); } catch (e2) { console.error('매일 점검 실패 기록도 실패'); }
    throw e;
  }
}

/** 트리거가 부르는 주간 요약(월요일 08시). */
function cronWeekly() {
  try {
    return Dispatch.weekly();
  } catch (e) {
    try { Db.log('system', 'cron', 'weekly', '주간 요약 실패: ' + ((e && e.message) || e)); } catch (e2) { console.error('주간 요약 실패 기록도 실패'); }
    throw e;
  }
}
