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
