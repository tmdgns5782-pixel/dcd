/**
 * Ai.gs — (선택 기능) AI 분석 요약. SPEC §6 ai.insight.
 *
 * 공개: Ai.insight(p, me) → {text, model}
 *   p = { scope:{from, to, sites?}, digest:{…클라이언트가 만든 숫자 요약…} }
 *
 * 설정(스크립트 속성 — 편집기 > 프로젝트 설정 > 스크립트 속성)
 *   ANTHROPIC_API_KEY  (필수) Anthropic API 키. 없으면 이 기능은 꺼진 것으로 본다.
 *   ANTHROPIC_MODEL    (선택) 모델 ID. 기본 claude-sonnet-5-5. 설정 화면의 settings.ai.model 이 있으면 그것이 먼저.
 *   settings.ai.enabled === false 이면 키가 있어도 쓰지 않는다.
 *   ANTHROPIC_EFFORT   (선택) low | medium | high. 기본 medium.
 *
 * 호출: UrlFetchApp → POST https://api.anthropic.com/v1/messages
 *   헤더 x-api-key, anthropic-version: 2026-10-21 (이 버전은 temperature·top_p·top_k 를 받지 않으므로 보내지 않는다).
 *   지원 모델이면 서버 쪽 대체 실행(fallbacks:'default', 베타 server-side-fallback-2026-07-01)을 켠다 — 안전 분류기가
 *   거절하면 API 가 권장 모델로 다시 돌린다. 베타가 계정에서 막혀 있으면 한 번 그 옵션 없이 다시 보낸다.
 * 비용 관리: 같은 입력은 6시간 캐시, 사용자당 1시간 30회 제한.
 */
var Ai = (function () {
  'use strict';

  var ENDPOINT = 'https://api.anthropic.com/v1/messages';
  var API_VERSION = '2026-10-21';
  var DEFAULT_MODEL = 'claude-sonnet-5-5';
  var FALLBACK_BETA = 'server-side-fallback-2026-07-01';
  var FALLBACK_MODELS = { 'claude-sonnet-5-5': true, 'claude-opus-5-5': true, 'claude-opus-5': true, 'claude-fable-5-1': true };
  var EFFORT_RE = /^claude-(?:(?:fable|mythos|opus|sonnet|haiku)-5(?:-\d+)?|opus-4-[5-8]|sonnet-4-6)$/;
  var MAX_TOKENS = 4000;
  var MAX_DIGEST_CHARS = 60000;
  var CACHE_SEC = 6 * 3600;
  var RATE_MAX = 30;
  var RATE_SEC = 3600;

  var SYSTEM = [
    '당신은 HDS(주) 안전경영지원실을 돕는 안전보건 데이터 분석가입니다.',
    '사업장(건물 보안·안내·주차·미화·시설 인력 파견 현장)이 제출한 표준 안전보건 양식의 집계 숫자만 보고 분석합니다.',
    '규칙:',
    '- 주어진 숫자와 이름만 사용합니다. 주어지지 않은 숫자·비율·추세·원인은 만들지 않습니다. 근거가 부족하면 "자료로는 판단이 어렵습니다"라고 씁니다.',
    '- 비율을 새로 계산할 때는 주어진 두 숫자로만 계산하고 소수 첫째 자리까지 씁니다.',
    '- 한국어 존댓말(~합니다)로, 현장 업무 용어(미제출, 기한경과, 반려, 아차사고, 작업중지, 조치)를 씁니다.',
    '- 마크다운 기호(#, *, **, 표)와 이모지는 쓰지 않습니다. 줄마다 한 문장 또는 두 문장입니다.'
  ].join('\n');

  function fail(code, msg) {
    var e = new Error(msg);
    e.code = code;
    throw e;
  }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function prop(k) {
    try { return str(PropertiesService.getScriptProperties().getProperty(k)); } catch (e) { return ''; }
  }
  function cache() { try { return CacheService.getScriptCache(); } catch (e) { return null; } }
  function who(me) { return me ? (me.name || me.id || '') + (me.id ? ' (' + me.id + ')' : '') : 'system'; }
  function log(me, ref, text) { try { Db.log(who(me), 'ai', ref || '', text); } catch (e) { console.warn('AI 기록 실패'); } }

  function hash(text) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
    return bytes.map(function (b) { var h = (b & 255).toString(16); return h.length < 2 ? '0' + h : h; }).join('');
  }

  function scopeText(scope) {
    scope = scope || {};
    var parts = [];
    if (scope.from || scope.to) parts.push('기간 ' + str(scope.from || '처음') + ' ~ ' + str(scope.to || '오늘'));
    var sites = Array.isArray(scope.sites) ? scope.sites.filter(Boolean) : [];
    parts.push(sites.length ? '사업장 ' + sites.length + '곳(' + sites.slice(0, 30).join(', ') + (sites.length > 30 ? ' 외' : '') + ')' : '전체 사업장');
    return parts.join(' · ');
  }

  function buildPrompt(p, company) {
    var digest = JSON.stringify(p.digest);
    return [
      (/안전경영지원실/.test(company) ? company : (company ? company + ' ' : '') + '안전경영지원실') + ' 담당자에게 드릴 5~7줄 분석을 써 주세요.',
      '분석 범위: ' + scopeText(p.scope),
      '',
      '구성(순서대로, 전체 5~7줄):',
      '1) 가장 큰 위험 신호 1~2줄 — 어느 사업장·어느 지표인지 숫자와 함께.',
      '2) 사업장 비교 1~2줄 — 잘하는 곳과 손볼 곳을 이름과 숫자로.',
      '3) 다음 달 할 일 3가지 — 줄마다 "할 일 1)", "할 일 2)", "할 일 3)"로 시작하고, 누가 무엇을 언제까지 하는지 짧게.',
      '숫자는 아래 요약에 있는 것만 쓰고, 없는 숫자를 지어내지 마세요. 줄 사이에 빈 줄을 넣지 마세요.',
      '',
      '<digest>',
      digest,
      '</digest>'
    ].join('\n');
  }

  function errorText(code, body) {
    var type = '', message = '';
    try {
      var j = JSON.parse(body);
      type = str(j && j.error && j.error.type);
      message = str(j && j.error && j.error.message);
    } catch (e) { /* 본문이 JSON 이 아님 */ }
    if (code === 401 || type === 'authentication_error') return 'AI 분석 키가 올바르지 않습니다. 스크립트 속성 ANTHROPIC_API_KEY 를 확인하세요';
    if (code === 402 || type === 'billing_error') return 'AI 분석 계정의 결제 상태를 확인해야 합니다(Anthropic 콘솔 > 결제)';
    if (code === 403 || type === 'permission_error') return '이 AI 분석 키로는 해당 모델을 쓸 수 없습니다. 스크립트 속성 ANTHROPIC_MODEL 을 확인하세요';
    if (code === 404 || type === 'not_found_error') return 'AI 모델을 찾을 수 없습니다. 스크립트 속성 ANTHROPIC_MODEL 의 이름을 확인하세요';
    if (code === 413 || type === 'request_too_large') return '분석할 요약 데이터가 너무 큽니다. 기간이나 사업장을 줄여 다시 시도하세요';
    if (code === 429 || type === 'rate_limit_error') return 'AI 분석 요청이 많아 잠시 막혔습니다. 1분쯤 뒤에 다시 시도하세요';
    if (code === 529 || type === 'overloaded_error' || code >= 500) return 'AI 분석 서비스가 지금 응답하지 않습니다. 잠시 후 다시 시도하세요';
    if (code === 400) return 'AI 분석 요청이 거절되었습니다' + (message ? '(' + message.slice(0, 160) + ')' : '') + '. 관리자에게 알려 주세요';
    return 'AI 분석 중 오류가 났습니다(HTTP ' + code + '). 잠시 후 다시 시도하세요';
  }

  function retryable(code) { return code === 429 || code === 500 || code === 529 || code === 503 || code === 502; }

  /** 한 번 호출. → {code, body} (네트워크 오류는 code 0) */
  function post(key, body, withFallback) {
    var headers = { 'x-api-key': key, 'anthropic-version': API_VERSION };
    var payload = JSON.parse(JSON.stringify(body));
    if (withFallback) {
      headers['anthropic-beta'] = FALLBACK_BETA;
      payload.fallbacks = 'default';
    }
    try {
      var res = UrlFetchApp.fetch(ENDPOINT, {
        method: 'post',
        contentType: 'application/json',
        headers: headers,
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      return { code: res.getResponseCode(), body: res.getContentText() };
    } catch (e) {
      return { code: 0, body: '', err: String((e && e.message) || e) };
    }
  }

  function call(key, body) {
    var useFallback = !!FALLBACK_MODELS[body.model];
    var r = post(key, body, useFallback);
    // 계정에 베타가 없으면(400: anthropic-beta / fallbacks) 그 옵션 없이 한 번 더.
    if (useFallback && r.code === 400 && /anthropic-beta|fallback/i.test(r.body)) {
      useFallback = false;
      r = post(key, body, false);
    }
    if (r.code === 0 || retryable(r.code)) {
      Utilities.sleep(r.code === 429 ? 4000 : 1500);
      r = post(key, body, useFallback);
    }
    return r;
  }

  function cleanText(t) {
    return String(t || '')
      .replace(/\r\n/g, '\n')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/^\s*[-*•]\s+/gm, '')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  function insight(p, me) {
    p = p || {};
    if (!me || me.kind !== 'hq') fail('FORBIDDEN', '본사 사용자만 AI 분석을 쓸 수 있습니다');
    var st = {};
    try { st = Db.settings() || {}; } catch (e0) { st = {}; }
    var aiSet = (st.ai && typeof st.ai === 'object') ? st.ai : {};
    if (aiSet.enabled === false) fail('INVALID', 'AI 분석이 꺼져 있습니다. 설정에서 AI 분석을 켜세요');
    var key = prop('ANTHROPIC_API_KEY');
    if (!key) fail('INVALID', 'AI 분석 키가 설정되지 않았습니다. 스크립트 속성 ANTHROPIC_API_KEY 를 넣으세요');
    if (p.digest == null || typeof p.digest !== 'object') fail('INVALID', '분석할 요약 숫자가 없습니다. 분석 화면에서 기간을 고른 뒤 다시 누르세요');
    var digestText = JSON.stringify(p.digest);
    if (digestText.length > MAX_DIGEST_CHARS) fail('INVALID', '분석할 요약 데이터가 너무 큽니다(' + Math.round(digestText.length / 1000) + '천 자). 기간이나 사업장을 줄여 다시 시도하세요');

    var model = str(aiSet.model) || prop('ANTHROPIC_MODEL') || DEFAULT_MODEL;
    if (!/^[A-Za-z0-9._:\-@\/]{3,100}$/.test(model)) fail('INVALID', 'AI 모델 이름 형식이 맞지 않습니다(설정 또는 스크립트 속성 ANTHROPIC_MODEL)');
    var effort = prop('ANTHROPIC_EFFORT').toLowerCase();
    if (['low', 'medium', 'high'].indexOf(effort) < 0) effort = 'medium';

    var company = str(st.company);
    var body = {
      model: model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: 'user', content: buildPrompt(p, company) }]
    };
    if (EFFORT_RE.test(model)) body.output_config = { effort: effort };

    var c = cache();
    var ckey = 'ai:r:' + hash(JSON.stringify(body));
    if (c) {
      try {
        var hit = c.get(ckey);
        if (hit) return JSON.parse(hit);
      } catch (e2) { /* 캐시는 보조 */ }
    }

    var rkey = 'ai:n:' + String((me && me.id) || 'hq').toLowerCase();
    var used = 0;
    if (c) { try { used = Number(c.get(rkey) || 0) || 0; } catch (e3) { used = 0; } }
    if (used >= RATE_MAX) fail('INVALID', 'AI 분석은 한 사람당 1시간에 ' + RATE_MAX + '번까지 쓸 수 있습니다. 잠시 후 다시 시도하세요');
    if (c) { try { c.put(rkey, String(used + 1), RATE_SEC); } catch (e4) { /* 제한 카운터 실패는 무시 */ } }

    var r = call(key, body);
    if (r.code === 0) {
      log(me, model, 'AI 분석 연결 실패: ' + (r.err || ''));
      fail('SERVER', 'AI 분석 서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요');
    }
    if (r.code !== 200) {
      log(me, model, 'AI 분석 실패 HTTP ' + r.code);
      fail('SERVER', errorText(r.code, r.body));
    }
    var j;
    try { j = JSON.parse(r.body); } catch (e5) { fail('SERVER', 'AI 분석 응답을 읽지 못했습니다. 잠시 후 다시 시도하세요'); }
    if (j.stop_reason === 'refusal') {
      log(me, model, 'AI 분석 거절(' + str(j.stop_details && j.stop_details.category) + ')');
      fail('SERVER', 'AI 가 이 요청에 답하지 않았습니다. 요약 범위를 바꿔 다시 시도하세요');
    }
    var text = cleanText((j.content || []).filter(function (b) { return b && b.type === 'text'; })
      .map(function (b) { return b.text; }).join('\n'));
    if (!text) fail('SERVER', 'AI 가 빈 답을 보냈습니다. 다시 시도하세요');
    if (j.stop_reason === 'max_tokens') text += '\n(답이 길어 일부가 잘렸습니다)';

    var out = { text: text, model: str(j.model) || model };
    var u = j.usage || {};
    log(me, out.model, 'AI 분석 · ' + scopeText(p.scope) + ' · 입력 ' + (u.input_tokens || 0) + ' / 출력 ' + (u.output_tokens || 0) + ' 토큰');
    if (c) { try { c.put(ckey, JSON.stringify(out), CACHE_SEC); } catch (e6) { /* 캐시는 보조 */ } }
    return out;
  }

  /** 키가 있는지만(설정 화면 표시용). */
  function enabled() { return !!prop('ANTHROPIC_API_KEY'); }

  return { insight: insight, enabled: enabled };
})();
