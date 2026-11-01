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

  function clean(v, kind) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return isFinite(v) ? v : '';
    if (typeof v === 'boolean') return v ? '예' : '아니오';
    var s = String(v);
    if (s.length > CELL_MAX) s = s.slice(0, CELL_MAX);
    if (s.charAt(0) === '=') s = "'" + s;
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
    header.forEach(function (h, i) {
      try { sh.setColumnWidth(i + 1, colWidth(h, kinds[i])); } catch (e) { /* 너비는 보기 좋게일 뿐 */ }
    });
  }

  /** 시트를 비우고 머리 + 행을 새로 쓴다(재구축·내보내기). */
  function writeTable(ss, name, header, kinds, rows) {
    var sh = ss.getSheetByName(name);
    if (sh) sh.clear(); else sh = ss.insertSheet(name);
    styleHeader(sh, header, kinds);
    writeBlock(sh, 2, rows || [], kinds);
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

  function onRecord(rec) {
    if (!rec || !rec.id) return false;
    try {
      return Db.withLock(function () { return applyRecord(rec); });
    } catch (e) {
      console.warn('평탄화 시트 갱신 실패(' + rec.id + '): ' + (e && e.message || e));
      return false;
    }
  }

  function onAct(act) {
    if (!act || !act.id) return false;
    try {
      return Db.withLock(function () {
        var ss = Db.book();
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
      L.tables.forEach(function (t, i) { Array.prototype.push.apply(tabs[i].rows, tableRows(t, rec)); });
      if (L.checks.length) Array.prototype.push.apply(checks.rows, checkRows(L, rec, site));
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

  /** 모든 V_ 시트와 월간지표 시트를 지우고 다시 만든다. */
  function rebuildAll() {
    return Db.withLock(function () {
      var ss = Db.book();
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
            if (!checkAll) checkAll = t; else Array.prototype.push.apply(checkAll.rows, t.rows);
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

      var names = [];
      var total = 0;
      tables.forEach(function (t) {
        writeTable(ss, t.name, t.header, t.kinds, t.rows);
        names.push(t.name);
        total += t.rows.length;
      });
      var kRows = kpiOrder.map(function (k) { return kpiBest[k].row; });
      writeTable(ss, K.name, K.cols, K.kinds, kRows);
      names.push(K.name);
      total += kRows.length;

      ss.getSheets().forEach(function (sh) {
        var n = sh.getName();
        if (n.indexOf('V_') === 0 && names.indexOf(n) < 0) ss.deleteSheet(sh);
      });
      try { Db.log('system', 'views', '', '평탄화 시트 재구축: 시트 ' + names.length + '개, ' + total + '행'); } catch (e) { /* 기록 실패는 무시 */ }
      return { sheets: names, rows: total };
    });
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
