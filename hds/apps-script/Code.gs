/**
 * HDS 안전장부 — Google Apps Script 서버
 * 기록·조치·설정은 스프레드시트 'HDS 안전장부 DB'에, 사진·서명은 드라이브 폴더 'HDS 안전장부 첨부'에 저장한다.
 * 처음 실행할 때 둘 다 자동으로 만들고 ID를 스크립트 속성에 기억한다.
 * 본사 링크:   배포 URL
 * 사업장 링크: 배포 URL?site=S001
 */
const SHEETS = { records: 'records', acts: 'acts', kv: 'kv' };
const CHUNK = 45000; // 셀 하나 5만 자 제한 → JSON 을 나눠 저장

function doGet(e) {
  const t = HtmlService.createTemplateFromFile('Index');
  t.site = String((e && e.parameter && e.parameter.site) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  t.url = ScriptApp.getService().getUrl();
  return t.evaluate()
    .setTitle('HDS 안전장부')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

function props_() { return PropertiesService.getScriptProperties(); }
function book_() {
  const p = props_(); let id = p.getProperty('BOOK_ID'); let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('HDS 안전장부 DB');
    p.setProperty('BOOK_ID', ss.getId());
    const first = ss.getSheets()[0];
    ss.insertSheet(SHEETS.records).appendRow(['id', 'site', 'form', 'date', 'status', 'updatedAt', 'json']);
    ss.insertSheet(SHEETS.acts).appendRow(['id', 'site', 'form', 'date', 'status', 'updatedAt', 'json']);
    ss.insertSheet(SHEETS.kv).appendRow(['key', 'site', 'form', 'date', 'status', 'updatedAt', 'json']);
    ss.deleteSheet(first);
  }
  return ss;
}
function folder_() {
  const p = props_(); let id = p.getProperty('FOLDER_ID'); let f = null;
  if (id) { try { f = DriveApp.getFolderById(id); } catch (err) { f = null; } }
  if (!f) { f = DriveApp.createFolder('HDS 안전장부 첨부'); p.setProperty('FOLDER_ID', f.getId()); }
  return f;
}
function sheet_(store) { return book_().getSheetByName(SHEETS[store]); }

function rowOf_(obj, key) {
  const json = JSON.stringify(obj);
  const parts = []; for (let i = 0; i < json.length; i += CHUNK) parts.push(json.slice(i, i + CHUNK));
  return [key, obj.site || '', obj.form || obj.srcForm || '', obj.date || String(obj.createdAt || '').slice(0, 10), obj.status || '', obj.updatedAt || new Date().toISOString()].concat(parts.length ? parts : ['']);
}
function readAll_(store) {
  const sh = sheet_(store); const last = sh.getLastRow(); if (last < 2) return [];
  const width = Math.max(7, sh.getLastColumn());
  return sh.getRange(2, 1, last - 1, width).getValues().filter(r => r[0] !== '').map(r => ({ key: String(r[0]), site: r[1], json: r.slice(6).join('') }));
}
function findRow_(sh, key) {
  const f = sh.getRange('A:A').createTextFinder(String(key)).matchEntireCell(true).findNext();
  return f ? f.getRow() : 0;
}
function upsert_(store, key, obj) {
  const sh = sheet_(store); const row = rowOf_(obj, key); const r = findRow_(sh, key);
  if (r) { const width = Math.max(row.length, sh.getLastColumn()); const full = row.concat(Array(Math.max(0, width - row.length)).fill('')); sh.getRange(r, 1, 1, width).setValues([full]); }
  else sh.appendRow(row);
}

/* ── 화면에서 부르는 함수 ── */
function apiLoad(site) {
  const out = { meta: {}, sites: [], people: [], log: [], records: [], acts: [], info: apiInfo() };
  readAll_('kv').forEach(x => { try { out[x.key] = JSON.parse(x.json); } catch (err) { /* 무시 */ } });
  const keep = x => !site || x.site === site;
  readAll_('records').filter(keep).forEach(x => { try { out.records.push(JSON.parse(x.json)); } catch (err) { /* 무시 */ } });
  readAll_('acts').filter(keep).forEach(x => { try { out.acts.push(JSON.parse(x.json)); } catch (err) { /* 무시 */ } });
  return JSON.stringify(out);
}
function apiInfo() { const ss = book_(); return { bookUrl: ss.getUrl(), folderUrl: folder_().getUrl(), user: Session.getActiveUser().getEmail() || '' }; }
function apiPut(store, key, json) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { upsert_(store, key, JSON.parse(json)); return true; } finally { lock.releaseLock(); }
}
function apiPutMany(store, json) {
  const items = JSON.parse(json); if (!items.length) return 0;
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const sh = sheet_(store); const last = sh.getLastRow();
    const keys = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0])) : [];
    const index = {}; keys.forEach((k, i) => { index[k] = i + 2; });
    const append = [];
    items.forEach(it => { const row = rowOf_(it.v, it.k); if (index[it.k]) sh.getRange(index[it.k], 1, 1, row.length).setValues([row]); else append.push(row); });
    if (append.length) { const w = Math.max.apply(null, append.map(r => r.length)); const rows = append.map(r => r.concat(Array(w - r.length).fill(''))); sh.getRange(sh.getLastRow() + 1, 1, rows.length, w).setValues(rows); }
    return items.length;
  } finally { lock.releaseLock(); }
}
function apiClear(store) {
  const sh = sheet_(store); const last = sh.getLastRow(); if (last > 1) sh.deleteRows(2, last - 1); return true;
}
function apiPutFile(id, dataUrl) {
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/); if (!m) throw new Error('사진 형식이 올바르지 않습니다');
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], id);
  const f = folder_(); const old = f.getFilesByName(id); while (old.hasNext()) old.next().setTrashed(true);
  f.createFile(blob); return id;
}
function apiGetFile(id) {
  const it = folder_().getFilesByName(id); if (!it.hasNext()) return null;
  const b = it.next().getBlob(); return 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes());
}
