/**
 * Main.gs — 웹앱 입구(doGet)와 템플릿 포함(include). SPEC §3.
 *
 * 전역으로 내놓는 것: doGet(e), include(name). 나머지는 함수 안에 둔다(서버 파일들이 한 전역 범위를 같이 쓰므로).
 */

/**
 * 웹앱 첫 화면. Index 템플릿에 BOOT(JSON)를 넣어 돌려준다.
 * BOOT = { url, s, view, appName, company, version, ready, site? }
 *  - ready: DB 스프레드시트가 준비됐는지(setup 전이면 false — 클라이언트가 안내 화면을 띄운다)
 *  - site : ?s=<사업장 토큰> 으로 들어왔을 때 그 사업장의 {id, name, needPin} (토큰이 틀리면 null)
 */
function doGet(e) {
  var q = (e && e.parameter) || {};
  var s = String(q.s || '').trim();
  if (!/^[A-Za-z0-9]{1,64}$/.test(s)) s = '';
  var view = String(q.v || '').trim();
  if (!/^[A-Za-z0-9_\-\/.:]{1,80}$/.test(view)) view = '';

  var st = { ready: false, appName: DEFAULT_SETTINGS.appName, company: DEFAULT_SETTINGS.company };
  try {
    st = Auth.status(s ? { siteToken: s } : {});
  } catch (err) {
    console.warn('doGet: 상태 확인 실패 — ' + (err && err.message || err));
  }

  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (err) { url = ''; }

  var boot = {
    url: url,
    s: s,
    view: view,
    appName: st.appName || APP.name,
    company: st.company || DEFAULT_SETTINGS.company,
    version: APP.version,
    ready: !!st.ready
  };
  if (s) boot.site = st.site || null;

  var t = HtmlService.createTemplateFromFile('Index');
  // <script> 안에 그대로 들어가므로 '<'·줄 구분 문자를 이스케이프해 </script> 끊김을 막는다.
  t.BOOT = JSON.stringify(boot)
    .replace(/</g, '\\u003c')
    .replace(/ /g, '\\u2028')
    .replace(/ /g, '\\u2029');

  return t.evaluate()
    .setTitle(boot.appName || APP.name)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** 템플릿에서 <?!= include('Css'); ?> 로 다른 HTML 파일 내용을 넣는다. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}
