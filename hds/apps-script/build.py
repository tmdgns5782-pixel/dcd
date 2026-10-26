"""HDS 안전장부 빌드
ledger/src/template.html + ledger/src/forms.json 으로 두 가지를 만든다.
  1) apps-script/Index.html, apps-script/Forms.html  — 구글 앱스 스크립트에 붙여넣는 파일(시트·드라이브 저장)
  2) HDS-안전장부-미리보기.html                       — 더블클릭으로 여는 로컬 미리보기(이 PC 브라우저 저장)
코드는 하나다. google.script.run 이 있으면 서버, 없으면 IndexedDB 에 저장한다.
"""
import json, re, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent  # hds/
src = (ROOT / 'ledger/src/template.html').read_text(encoding='utf-8')
forms = json.loads((ROOT / 'ledger/src/forms.json').read_text(encoding='utf-8'))
FORMS_BLOB = json.dumps(forms, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
assert '<?' not in FORMS_BLOB and '?>' not in FORMS_BLOB
t = src


def rep(a, b):
    global t
    assert a in t, 'MISSING: ' + a[:90]
    t = t.replace(a, b, 1)


def rep_re(pat, b):
    global t
    assert re.search(pat, t, flags=re.S), 'NO MATCH: ' + pat[:80]
    t = re.sub(pat, lambda m: b, t, count=1, flags=re.S)


# 처음부터 빈 화면이 되지 않게 안내 문구
rep('<main id="view"></main>', '<main id="view"><div class="empty" style="padding:60px 20px;font-size:15px">불러오는 중입니다… 화면이 계속 이대로면 PC의 크롬이나 엣지로 여세요. 휴대폰이나 압축 파일 안에서는 열리지 않을 수 있습니다.</div></main>')
# XLSX 의 <?xml 을 앱스 스크립트 템플릿 해석에서 피하기
t = t.replace('<?xml', '<\\?xml')

# 저장소: 로컬(IndexedDB) / 서버(앱스 스크립트) 겸용
m = re.search(r"const DB = (\{.*?\n\});\n\nconst S = \{", t, flags=re.S)
assert m
idb_body = m.group(1)
hybrid = '''const LOCAL = !(window.google && google.script && google.script.run);
const HDS_SITE = (() => { const v = String(window.HDS_SITE || '').toUpperCase(); if (/^[A-Z0-9]{2,8}$/.test(v)) return v; try { const q = new URLSearchParams(location.search).get('site'); return q && /^[A-Za-z0-9]{2,8}$/.test(q) ? q.toUpperCase() : ''; } catch (e) { return ''; } })();
const HDS_URL = /^https?:/.test(window.HDS_URL || '') ? window.HDS_URL : '';
const gs = (fn, ...args) => new Promise((res, rej) => { if (LOCAL) { rej(new Error('로컬 미리보기에서는 서버를 쓰지 않습니다')); return; } google.script.run.withSuccessHandler(res).withFailureHandler(rej)[fn](...args); });
const IDB = ''' + idb_body + ''';
const SRV = {
  db: true,
  async open() { return true; },
  put(store, val, key) { if (store === 'files') return gs('apiPutFile', key, val); return gs('apiPut', store, String(key === undefined ? val.id : key), JSON.stringify(val)); },
  async bulk(store, vals) { const items = vals.map(v => Array.isArray(v) ? { k: v[0], v: v[1] } : { k: v.id, v }); if (store === 'files') { for (const it of items) await gs('apiPutFile', it.k, it.v); return; } for (let i = 0; i < items.length; i += 300) await gs('apiPutMany', store, JSON.stringify(items.slice(i, i + 300))); },
  get(store, key) { if (store === 'files') return gs('apiGetFile', key).catch(() => null); return Promise.resolve(null); },
  async all() { return []; },
  clear(store) { if (store === 'files') return Promise.resolve(); return gs('apiClear', store); },
};
const DB = LOCAL ? IDB : SRV;

const S = {'''
t = t[:m.start()] + hybrid + t[m.end():]

# 공유 설정(시트에 저장)과 개인 설정(이 브라우저) 분리
rep("const saveMeta = () => persist(() => DB.put('kv', S.meta, 'meta'));",
    "const saveMeta = () => { try { localStorage.setItem('hds.user', S.meta.user || ''); } catch (e) { /* 무시 */ } const shared = { company: S.meta.company, started: !!(S.meta.started || S.meta.mode === 'hq'), demo: !!S.meta.demo }; return persist(() => DB.put('kv', shared, 'meta')); };")

# 시작: 로컬이면 IndexedDB, 서버면 시트에서 불러오기
rep_re(r"\(async \(\) => \{\n  S\.ok = await DB\.open\(\);.*?setSaving\(0\); route\(\);\n\}\)\(\);", r'''function applyMode() { try { S.meta.user = localStorage.getItem('hds.user') || S.meta.user || ''; } catch (e) { /* 무시 */ } if (HDS_SITE) { S.meta.mode = 'site'; S.meta.site = HDS_SITE; } else { S.meta.mode = S.meta.started ? 'hq' : ''; } }
(async () => {
  try {
    if (LOCAL) {
      S.ok = await DB.open();
      if (S.ok) { for (const [k, v] of await DB.all('kv')) { if (k === 'meta') S.meta = v || {}; if (k === 'sites') S.sites = v || []; if (k === 'people') S.people = v || []; if (k === 'log') S.log = v || []; } (await DB.all('records')).forEach(r => S.records.set(r.id, r)); (await DB.all('acts')).forEach(a => S.acts.set(a.id, a)); }
    } else {
      S.ok = true; $('#view').innerHTML = '<div class="empty">구글 시트에서 기록을 불러오는 중…</div>';
      const j = JSON.parse(await gs('apiLoad', HDS_SITE)); S.meta = j.meta || {}; S.sites = j.sites || []; S.people = j.people || []; S.log = j.log || []; (j.records || []).forEach(r => S.records.set(r.id, r)); (j.acts || []).forEach(a => S.acts.set(a.id, a)); S.info = j.info || {};
    }
  } catch (e) { S.ok = false; console.error(e); toast('불러오지 못했습니다: ' + (e.message || e), 8000); }
  applyMode(); setSaving(0); route();
})();''')

# 사업장 링크인데 미등록이면 안내
rep("  renderNav(r);\n  const v = $('#view');", "  renderNav(r);\n  if (!isHQ() && !siteById(mySite())) { $('#view').innerHTML = `<div class=\"setup\"><h1>사업장 ${esc(mySite())} 은(는) 아직 등록되지 않았습니다</h1><p class=\"muted\">본사 담당자에게 사업장 등록을 요청하세요. 등록 후 새로고침하면 바로 쓸 수 있습니다.</p>${LOCAL ? '<button class=\"btn\" data-act=\"to-hq\">본사 화면으로</button>' : ''}</div>`; return; }\n  const v = $('#view');")

# 상단 띠: 로컬 미리보기 안내 + 사업장 미리보기에서 본사로 돌아가기
rep("$('#banner').innerHTML = (S.meta.demo ?", "$('#banner').innerHTML = (LOCAL ? `<div class=\"band demo\" style=\"background:var(--navy-soft);color:var(--navy)\"><b>로컬 미리보기</b> 기록은 이 PC 브라우저에 저장됩니다. 실제 운영은 구글 앱스 스크립트로 게시하면 구글 시트·드라이브에 저장됩니다.${!isHQ() && S.meta.mode ? ' <button class=\"btn sm ghost\" data-act=\"to-hq\">본사 화면으로</button>' : ''}</div>` : '') + (S.meta.demo ?")

# 최초 설정(본사)
rep_re(r"function viewSetup\(\) \{.*?\n\}\n\n/\* 홈: 본사 \*/", r'''function viewSetup() {
  $('#view').innerHTML = `<div class="setup">
    <div><h1 style="font-size:26px">HDS 안전장부 시작하기</h1><p class="muted" style="margin-top:6px">이 화면은 <b>본사 화면</b>입니다. 사업장은 본사가 보내는 사업장 링크(끝에 ?site=S001)로 들어와 입력합니다. ${LOCAL ? '지금은 로컬 미리보기라 기록이 이 PC 브라우저에 저장됩니다.' : '기록은 구글 시트에, 사진·서명은 구글 드라이브에 자동 저장됩니다.'}</p></div>
    <div class="opts" style="grid-template-columns:1fr 1fr">
      <div class="opt"><b>예시 데이터로 둘러보기</b><p class="small muted">가상 사업장 6곳과 최근 두 달 기록이 들어간 상태로 시작합니다. 기능을 확인할 때 쓰세요. 나중에 지우고 새로 시작할 수 있습니다.</p>
        <button class="btn" data-act="setup-demo">예시로 둘러보기</button></div>
      <div class="opt"><b>빈 상태로 시작</b><p class="small muted">사업장을 직접 등록하고 사업장마다 링크를 보내 입력받습니다.</p>
        <div class="fld"><label>회사·부서</label><input type="text" id="su-company" value="HDS(주) 안전경영지원실"></div>
        <div class="fld"><label>담당자 이름</label><input type="text" id="su-user" placeholder="예: 안전팀 담당자"></div>
        <button class="btn ghost" data-act="setup-hq">빈 상태로 시작</button></div>
    </div></div>`;
}

/* 홈: 본사 */''')
rep("S.meta = { mode: 'hq', company: $('#su-company').value.trim() || 'HDS(주) 안전경영지원실', user: $('#su-user').value.trim(), createdAt: isoLocal(now()) };",
    "S.meta = { mode: 'hq', started: true, company: $('#su-company').value.trim() || 'HDS(주) 안전경영지원실', user: $('#su-user').value.trim(), createdAt: isoLocal(now()) };")
rep("S.meta = { mode: 'hq', company: 'HDS(주) 안전경영지원실', user: '본사 담당자', demo: true, createdAt: isoLocal(now()) };",
    "S.meta = { mode: 'hq', started: true, company: 'HDS(주) 안전경영지원실', user: '본사 담당자', demo: true, createdAt: isoLocal(now()) }; if (!LOCAL) toast('예시 데이터를 구글 시트에 쓰는 중입니다(1~2분)…', 90000);")

# 메뉴·데이터 화면
t = t.replace("['data', '데이터 주고받기']", "['data', '데이터']").replace("['data', '본사 제출·받기']", "['data', '데이터']")
rep_re(r"function viewData\(\) \{.*?\n\}\nfunction stripSensitive", r'''function viewData() {
  const hq = isHQ(); const info = S.info || {};
  $('#view').innerHTML = `<div class="page-head"><div><h1>데이터</h1><p>${LOCAL ? '로컬 미리보기: 기록은 이 PC 브라우저에 저장됩니다. 구글 앱스 스크립트로 게시하면 구글 시트·드라이브에 바로 저장됩니다.' : '모든 기록은 구글 시트에, 사진·서명은 구글 드라이브에 바로 저장됩니다. 사업장이 파일을 따로 보낼 필요가 없습니다.'}</p></div></div>
  <div class="cols2">
  ${!LOCAL && hq ? `<div class="card"><div class="hd"><h3>저장 위치</h3></div><div class="bd" style="display:grid;gap:10px"><div class="row"><a class="btn ghost" target="_blank" rel="noopener" href="${esc(info.bookUrl || '#')}">구글 시트(DB) 열기</a><a class="btn ghost" target="_blank" rel="noopener" href="${esc(info.folderUrl || '#')}">첨부 사진 폴더 열기</a></div><p class="small muted">시트 탭: records(기록), acts(조치), kv(사업장·인원·설정). 시트를 직접 고치지 말고 이 화면에서 고치세요.</p></div></div>` : ''}
  <div class="card"><div class="hd"><h3>엑셀 내보내기</h3></div><div class="bd" style="display:grid;gap:10px"><p class="small muted">시트: 사업장, 기록목록, 점검결과(항목별 1행), 조치대장, 월간지표, HEC준비도${hq ? ' — 전 사업장 취합본' : ''}.</p><button class="btn ghost" data-act="xlsx" style="justify-self:start">엑셀 파일 만들기(.xlsx)</button></div></div>
  ${hq ? `<div class="card"><div class="hd"><h3>백업·초기화</h3></div><div class="bd" style="display:grid;gap:10px"><p class="small muted">사진까지 파일 하나로 받아 둘 수 있습니다.</p><div class="row"><button class="btn ghost" data-act="backup">전체 백업 저장</button>${LOCAL ? '<label class="upl">백업 파일로 복원<input type="file" accept=".json,application/json" id="restore-file"></label>' : ''}<button class="btn ghost" data-act="wipe" id="wipe-btn">전체 초기화</button></div></div></div>` : ''}
  </div>`;
}
function stripSensitive''')

# 사업장 홈: 제출 파일 버튼 대신 이번 달 기록
rep('<button class="btn lg ghost" data-act="export-site">본사 제출 파일 만들기</button>', '')
rep_re(r'<div class="tile"><span>마지막 본사 제출</span>.*?</div>\n  </div>', "<div class=\"tile\"><span>이번 달 기록</span><b>${recs().filter(r => r.site === site && r.date >= periodOf('monthly', t).from).length}</b><i>${LOCAL ? '이 PC에 저장됨' : '구글 시트에 바로 저장됨'}</i></div>\n  </div>")

# 본사 홈: 버튼·예외·신호등 열
rep('<a class="btn ghost" href="#/data">사업장 파일 가져오기</a>', "${LOCAL ? '' : `<a class=\"btn ghost\" target=\"_blank\" rel=\"noopener\" href=\"${esc((S.info || {}).bookUrl || '#')}\">구글 시트 열기</a>`}")
rep_re(r"  sites\.forEach\(s => \{ if \(s\.id !== mySite\(\) && \(!s\.lastReceivedAt.*?\n", "  sites.forEach(s => { const last = recs().filter(r => r.site === s.id).map(r => r.date).sort().pop(); if (!last || daysDiff(last, t) > 3) exc.push({ c: 'amber', t: '무입력', text: `${s.id} ${esc(s.name)} ${last ? daysDiff(last, t) + '일째 입력 없음' : '입력 기록 없음'}`, sub: '사업장 담당자에게 확인', href: '#/records?site=' + s.id }); });\n")
rep('<th>HEC 준비도</th><th>최근 수신</th>', '<th>HEC 준비도</th><th>최근 입력</th>')
rep("""<td class="small">${s.id === mySite() || !isHQ() ? '-' : (s.lastReceivedAt ? fmtD(s.lastReceivedAt) : '<span class="chip amber">없음</span>')}</td>""",
    """<td class="small">${recs().filter(r => r.site === s.id).map(r => r.date).sort().pop() || '<span class="chip amber">없음</span>'}</td>""")

# 사업장 목록: 링크(로컬은 사업장 화면 미리보기)
rep("""${isHQ() ? `<button class="btn sm ghost" data-act="setup-one" data-id="${s.id}">설정 파일</button>` : ''}""",
    """${isHQ() ? `<button class="btn sm ghost" data-act="copy-link" data-id="${s.id}">${LOCAL ? '사업장 화면 보기' : '사업장 링크'}</button>` : ''}""")
rep("""<div class="row">${isHQ() ? '<button class="btn" data-act="site-new">사업장 추가</button><button class="btn ghost" data-act="setup-all">전체 사업장 설정 파일 만들기</button>' : ''}</div>""",
    """<div class="row">${isHQ() ? '<button class="btn" data-act="site-new">사업장 추가</button>' : ''}</div>""")
rep("'사업장을 등록하고 사업장별 설정 파일을 만들어 보내세요. 사업장은 그 파일로 시작합니다.'",
    "(LOCAL ? '사업장을 등록하고 \"사업장 화면 보기\"로 사업장 담당자가 보는 화면을 확인하세요. 게시 후에는 \"사업장 링크\"를 담당자에게 보냅니다.' : '사업장을 등록하고 \"사업장 링크\"를 담당자에게 보내세요. 사업장은 그 링크로 들어와 바로 입력합니다.')")
rep("  if (act === 'setup-one') return exportSetup(b.dataset.id);",
    "  if (act === 'copy-link') { if (LOCAL) { location.href = location.pathname + '?site=' + b.dataset.id + '#/home'; return; } const link = HDS_URL + '?site=' + b.dataset.id; try { await navigator.clipboard.writeText(link); toast('복사했습니다: ' + link, 5000); } catch (err) { askText('사업장 링크(복사해서 보내세요)', link, () => {}); setTimeout(() => { const i = $('#ask-v'); if (i) { i.value = link; i.select(); } }, 50); } return; }\n  if (act === 'to-hq') { location.href = location.pathname + '#/home'; return; }")
rep("$('#banner').addEventListener('click', async e => {", "$('#banner').addEventListener('click', async e => { if (e.target.closest('[data-act=\"to-hq\"]')) { location.href = location.pathname + '#/home'; return; }")

# 설정: 모드 전환 대신 링크 안내
rep_re(r'  <hr style="border:0;border-top:1px solid var\(--line\);width:100%">.*?\n  \$\{S\.meta\.demo \?', '''  <hr style="border:0;border-top:1px solid var(--line);width:100%">
  <div><b>링크</b></div><p class="small">${LOCAL ? '로컬 미리보기에서는 사업장·인원 메뉴의 "사업장 화면 보기"로 사업장 화면을 확인합니다.' : `본사: <code>${esc(HDS_URL)}</code><br>사업장: <code>${esc(HDS_URL)}?site=사업장코드</code>`}</p>
  ${S.meta.demo ?''')

# 사용 방법
rep_re(r"function viewHelp\(\) \{.*?\n\}\nfunction viewSearch", r'''function viewHelp() {
  $('#view').innerHTML = `<div class="page-head"><div><h1>사용 방법</h1><p>같은 화면을 로컬 미리보기(이 PC 저장)와 구글 앱스 스크립트 웹앱(구글 시트·드라이브 저장)으로 씁니다.</p></div></div>
  <div class="card help"><div class="bd" style="display:grid;gap:14px">
  <div class="flowline"><div><b>① 등록</b>본사가 '사업장·인원'에서 사업장과 명부를 등록합니다.</div><div><b>② 링크 배포</b>사업장마다 '사업장 링크'(끝에 ?site=코드)를 담당자에게 보냅니다.</div><div><b>③ 입력</b>사업장은 링크로 들어와 양식을 씁니다. 저장하는 순간 구글 시트에 들어갑니다.</div><div><b>④ 관리</b>본사는 대시보드·조치대장·HEC 대비를 보고, 완료된 조치를 확인합니다.</div></div>
  <h3>본사가 할 일</h3><ol><li>사업장(코드 S001 형식)과 업무구성·근무조·인원 명부를 등록합니다.</li><li>사업장 링크를 복사해 담당자에게 카톡·메일로 보냅니다.</li><li>홈의 '오늘의 예외'를 처리하고, 완료된 조치는 '확인하고 종결'합니다.</li><li>엑셀 취합본은 홈 또는 데이터 메뉴에서 만듭니다.</li></ol>
  <h3>사업장이 할 일</h3><ol><li>받은 링크를 PC 크롬·엣지 즐겨찾기에 넣어 둡니다.</li><li>매일 근무조마다 일일점검을 쓰고, 사고·아차사고·작업중지는 바로 보고합니다. 주의·불량 항목은 조치로 자동 등록됩니다.</li><li>조치를 끝내면 조치대장에서 '완료'(개선 후 사진 또는 못 찍은 사유)로 바꿉니다.</li></ol>
  <h3>꼭 알아둘 것</h3><ul><li>시안이라 링크를 아는 사람은 누구나 들어올 수 있습니다. 실제 운영 전에는 사업장 PIN 같은 접근 제한을 붙여야 합니다.</li><li>제출한 기록을 고치면 수정 사유와 차수가 남고, 확인(잠금)된 기록은 본사만 잠금을 풀 수 있습니다.</li><li>로컬 미리보기는 브라우저의 '사이트 데이터 삭제'를 하면 기록이 지워집니다.</li></ul>
  </div></div>`;
}
function viewSearch''')

# ── 출력 1: 앱스 스크립트 ──
APPS = ROOT / 'apps-script'
gas = t.replace('<script id="forms-data" type="application/json">/*__FORMS__*/</script>',
                "<?!= include('Forms'); ?>\n<script>window.HDS_SITE = \"<?= site ?>\"; window.HDS_URL = \"<?= url ?>\";</script>")
assert "include('Forms')" in gas
(APPS / 'Index.html').write_text(gas, encoding='utf-8')
(APPS / 'Forms.html').write_text('<script id="forms-data" type="application/json">' + FORMS_BLOB + '</script>\n', encoding='utf-8')
# ── 출력 2: 로컬 미리보기 ──
local = t.replace('<script id="forms-data" type="application/json">/*__FORMS__*/</script>',
                  '<script id="forms-data" type="application/json">' + FORMS_BLOB + '</script>')
(ROOT / 'HDS-안전장부-미리보기.html').write_text(local, encoding='utf-8')
print('Index', len(gas.encode()) // 1024, 'KB / Forms', len(FORMS_BLOB.encode()) // 1024, 'KB / 미리보기', len(local.encode()) // 1024, 'KB')
