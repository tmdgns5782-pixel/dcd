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
    var block = heavyBlock(m);
    var inf = sheetInfo(table);
    var r = block[m.rowOf[key] - 2] || [];
    var s = col.names.map(function (n) { return cellText(r[inf.idx[n] - inf.hs]); }).join('');
    var v = decodeJson(table, key, col, s);
    Object.defineProperty(cur, colName, { value: v, writable: true, enumerable: true, configurable: true });
    return v;
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
          var block = it.row <= m.last ? heavyBlock(m) : [];
          var raw = block[it.row - 2] || [];
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
    var bytes = /;base64/i.test(head) ? Utilities.base64Decode(body) : Utilities.newBlob(decodeURIComponent(body)).getBytes();
    if (bytes.length > APP.maxFileBytes) fail('INVALID', '파일이 너무 큽니다. 8MB 이하만 올릴 수 있습니다');
    if (!bytes.length) fail('INVALID', '빈 파일은 올릴 수 없습니다');
    var file = folder(siteId).createFile(Utilities.newBlob(bytes, mime, safeName(name)));
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
    forms: forms, form: form, folder: folder, saveDataUrl: saveDataUrl, readDataUrl: readDataUrl, putJson: putJson, getJson: getJson,
    fit: fit, reset: reset, deepMerge: deepMerge
  };
})();
