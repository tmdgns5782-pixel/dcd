// HDS 안전장부 E2E: 사업장에서 18개 양식 작성·제출 → 제출 파일 → 본사 가져오기 → 화면·엑셀 확인
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const APP = 'file://' + path.resolve(__dirname, '../hds-safety-ledger.html');
const SHOTS = process.env.SHOTS || '/tmp';
(async () => {
  const b = await chromium.launch();
  const errs = []; const nets = [];
  const mk = async () => { const ctx = await b.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push('pageerror: ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); }); p.on('request', r => { if (!/^(file|data|blob):/.test(r.url())) nets.push(r.url()); }); await p.goto(APP); await p.waitForTimeout(500); return { ctx, p }; };
  // ── 사업장 ──
  const site = await mk(); const p = site.p;
  await p.click('details summary'); await p.fill('#su-code', 'S101'); await p.fill('#su-name', '시험 사업장'); await p.fill('#su-person', '홍길동');
  await p.click('[data-act=setup-site]'); await p.waitForTimeout(300);
  // 명부 추가
  await p.evaluate(() => { const S = HDS.S; ['김철수', '이영희', '박민수'].forEach((n, i) => S.people.push({ id: 'Pt' + i, site: 'S101', name: n, job: '보안', role: i ? '근로자' : '소장', active: true })); });
  const codes = await p.evaluate(() => Object.keys(HDS.FORM));
  const results = [];
  for (const code of codes) {
    await p.evaluate(c => HDS.go('#/new/' + c), code); await p.waitForTimeout(250);
    for (let step = 0; step < 6; step++) {
      await p.evaluate(() => { const ed = HDS.ED; HDS.autofill(ed.def, ed.rec, { tableRows: 1 }); HDS.refresh(); });
      const btn = await p.$('[data-act=submit], [data-act=stage-done]'); if (!btn) break;
      const isSubmit = await btn.getAttribute('data-act') === 'submit';
      await btn.click(); await p.waitForTimeout(350);
      if (isSubmit) break;
    }
    const st = await p.evaluate(c => { const r = [...HDS.S.records.values()].filter(x => x.form === c).pop(); return r ? r.status + ' ' + r.id : 'none'; }, code);
    const remain = await p.evaluate(() => HDS.ED ? document.querySelectorAll('.errlist button').length : 0);
    results.push(`${code}: ${st}${remain ? ' (남은 오류 ' + remain + ')' : ''}`);
  }
  console.log(results.join('\n'));
  const acts = await p.evaluate(() => HDS.S.acts.size); console.log('site acts', acts);
  // 출력 미리보기 1건
  const rid = await p.evaluate(() => [...HDS.S.records.values()].find(r => r.form === 'F07').id);
  await p.evaluate(id => HDS.go('#/rec/' + id), rid); await p.waitForTimeout(300); await p.click('[data-act=print]'); await p.waitForTimeout(500);
  await p.screenshot({ path: SHOTS + '/print-F07.png', fullPage: false }); await p.click('#pb-close');
  // 조치 1건 완료
  await p.evaluate(() => HDS.go('#/acts')); await p.waitForTimeout(300);
  const firstAct = await p.$('tr[data-actid]');
  if (firstAct) { await firstAct.click(); await p.waitForTimeout(200); await p.fill('#a-note', '정리 완료'); await p.selectOption('#a-nophoto', '기타'); await p.click('[data-ast="완료"]'); await p.waitForTimeout(300); }
  // 제출 파일
  await p.evaluate(() => HDS.go('#/data')); await p.waitForTimeout(300);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-act=export-site]')]);
  const pkgPath = path.join(SHOTS, dl.suggestedFilename()); await dl.saveAs(pkgPath); console.log('package', path.basename(pkgPath), Math.round(fs.statSync(pkgPath).size / 1024) + 'KB');
  // ── 본사 ──
  const hq = await mk(); const q = hq.p;
  await q.click('[data-act=setup-demo]'); await q.waitForTimeout(1500);
  for (const r of ['home', 'forms', 'records', 'acts', 'schedule', 'hec', 'sites', 'data', 'settings', 'help']) { await q.evaluate(x => HDS.go('#/' + x), r); await q.waitForTimeout(350); await q.screenshot({ path: `${SHOTS}/hq-${r}.png`, fullPage: false }); }
  await q.evaluate(() => HDS.go('#/data')); await q.waitForTimeout(300);
  await q.setInputFiles('#imp-files', [pkgPath, pkgPath]); await q.waitForTimeout(500);
  console.log('preview:', (await q.textContent('#imp-preview')).replace(/\s+/g, ' ').slice(0, 220));
  await q.click('[data-act=imp-apply]'); await q.waitForTimeout(800);
  const after = await q.evaluate(() => ({ recs: [...HDS.S.records.values()].filter(r => r.site === 'S101').length, acts: [...HDS.S.acts.values()].filter(a => a.site === 'S101').length, site: !!HDS.S.sites.find(s => s.id === 'S101') }));
  console.log('hq after import', JSON.stringify(after));
  // 다시 가져오기(중복 없음)
  await q.evaluate(() => HDS.go('#/data')); await q.waitForTimeout(300); await q.setInputFiles('#imp-files', pkgPath); await q.waitForTimeout(400);
  console.log('re-import preview:', (await q.textContent('#imp-preview')).replace(/\s+/g, ' ').slice(0, 160));
  // 엑셀
  const [x] = await Promise.all([q.waitForEvent('download'), q.click('[data-act=xlsx]')]); const xp = path.join(SHOTS, x.suggestedFilename()); await x.saveAs(xp); console.log('xlsx', path.basename(xp));
  // 새로고침 유지
  await q.reload(); await q.waitForTimeout(800); console.log('after reload recs', await q.evaluate(() => HDS.S.records.size));
  await q.evaluate(() => HDS.go('#/home')); await q.waitForTimeout(500); await q.screenshot({ path: `${SHOTS}/hq-home-after.png`, fullPage: true });
  console.log('errors', errs.length ? errs.slice(0, 15) : 'none'); console.log('network', nets.length ? nets.slice(0, 5) : 'none');
  await b.close();
})();
