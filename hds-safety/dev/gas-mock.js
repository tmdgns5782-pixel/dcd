/**
 * gas-mock.js — Google Apps Script 서비스 모의 (미리보기·Node 시험 공용). SPEC.md §2·§10.
 *
 * 브라우저: window.createGasMock(opts)   Node(CommonJS·vm): module.exports = createGasMock (모듈이 없으면 globalThis.createGasMock)
 *
 * createGasMock({
 *   storage,          // {getItem,setItem[,removeItem]} — 브라우저 localStorage, Node 는 메모리 객체 또는 생략(영속 안 함)
 *   storageKey,       // 기본 'hds-preview-db'
 *   formsHtml,        // HtmlService.createHtmlOutputFromFile('FormsData').getContent() 가 돌려줄 문자열 또는 함수
 *   htmlFiles,        // 프로젝트의 HTML 파일 이름 배열(있으면 그 밖의 이름은 GAS 처럼 오류)
 *   nowFn,            // () => Date (캐시 만료·기록 시각)
 *   onMail,           // (msg) => void  MailApp.sendEmail 포착
 *   log,              // {log,info,warn,error} — 기본 console
 *   activeUserEmail, effectiveUserEmail, serviceUrl,
 *   autoSave,         // 기본 true: 상태가 바뀌면 300ms 뒤 storage 에 저장
 *   debounceMs        // 기본 300
 * }) → { globals, state, save(), reload(), reset(), isDirty(), sent:[], logs:[], warnings:[], table(name), lastTemplate }
 *
 * 순수 ES2019 + 전역 의존 없음(TextEncoder·btoa·crypto 없이도 동작) — node:vm 컨텍스트 안에서도 그대로 돈다.
 */
(function (root, factory) {
  var createGasMock = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = createGasMock;
  else if (root) root.createGasMock = createGasMock;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  var CELL_MAX = 50000;
  var PROP_VALUE_MAX = 9 * 1024;
  var CACHE_VALUE_MAX = 100 * 1024;
  var CACHE_KEY_MAX = 250;
  var CACHE_TTL_MAX = 21600;
  var DEFAULT_ROWS = 1000;
  var DEFAULT_COLS = 26;
  var MAIL_QUOTA = 100;
  var MAX_TRIGGERS = 20;
  var FILE_PERSIST_MAX = 1500000;      // base64 글자 수: 이보다 큰 드라이브 파일 바이트는 메모리에만
  var DRIVE_PERSIST_BUDGET = 3000000;  // 드라이브 바이트 영속 총량(base64 글자)
  var COMPRESS_OVER = 100000;          // 이보다 긴 JSON 은 압축해 저장

  /* =====================================================================
   * 바이트·문자열 도구 (UTF-8, base64, SHA-256, HMAC, 압축)
   * ===================================================================== */

  function utf8Encode(str) {
    str = String(str);
    var out = new Uint8Array(str.length * 3);
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) { out[n++] = c; continue; }
      if (c < 0x800) { out[n++] = 0xc0 | (c >> 6); out[n++] = 0x80 | (c & 63); continue; }
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
        var d = str.charCodeAt(i + 1);
        if (d >= 0xdc00 && d < 0xe000) {
          var cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
          out[n++] = 0xf0 | (cp >> 18); out[n++] = 0x80 | ((cp >> 12) & 63);
          out[n++] = 0x80 | ((cp >> 6) & 63); out[n++] = 0x80 | (cp & 63);
          continue;
        }
      }
      if (c >= 0xd800 && c < 0xe000) { out[n++] = 0xef; out[n++] = 0xbf; out[n++] = 0xbd; continue; }
      out[n++] = 0xe0 | (c >> 12); out[n++] = 0x80 | ((c >> 6) & 63); out[n++] = 0x80 | (c & 63);
    }
    return out.slice(0, n);
  }

  function codesToString(codes, len) {
    var parts = [];
    for (var i = 0; i < len; i += 8192) parts.push(String.fromCharCode.apply(null, codes.subarray ? codes.subarray(i, Math.min(len, i + 8192)) : codes.slice(i, Math.min(len, i + 8192))));
    return parts.join('');
  }

  function utf8Decode(bytes) {
    var codes = new Uint16Array(bytes.length + 1);
    var n = 0;
    for (var i = 0; i < bytes.length;) {
      var b = bytes[i] & 255;
      var cp = 0xfffd, need = 0;
      if (b < 0x80) { cp = b; need = 0; }
      else if (b >= 0xc2 && b < 0xe0) { cp = b & 31; need = 1; }
      else if (b >= 0xe0 && b < 0xf0) { cp = b & 15; need = 2; }
      else if (b >= 0xf0 && b < 0xf5) { cp = b & 7; need = 3; }
      else { codes[n++] = 0xfffd; i++; continue; }
      var ok = i + need < bytes.length + (need ? 0 : 1);
      for (var k = 1; ok && k <= need; k++) {
        var x = bytes[i + k] & 255;
        if ((x & 0xc0) !== 0x80) ok = false; else cp = (cp << 6) | (x & 63);
      }
      if (!ok) { codes[n++] = 0xfffd; i++; continue; }
      i += need + 1;
      if (cp >= 0x10000) {
        if (n + 2 > codes.length) { var bigger = new Uint16Array(codes.length * 2); bigger.set(codes); codes = bigger; }
        cp -= 0x10000;
        codes[n++] = 0xd800 + (cp >> 10);
        codes[n++] = 0xdc00 + (cp & 1023);
      } else {
        codes[n++] = cp;
      }
    }
    return codesToString(codes, n);
  }

  /** 부호 있는/없는 숫자 배열·Uint8Array → Uint8Array */
  function toU8(data) {
    if (data instanceof Uint8Array) return data;
    var out = new Uint8Array(data.length);
    for (var i = 0; i < data.length; i++) out[i] = Number(data[i]) & 255;
    return out;
  }
  /** GAS 처럼 부호 있는 바이트 배열(-128..127) */
  function toSigned(u8) {
    var out = new Array(u8.length);
    for (var i = 0; i < u8.length; i++) out[i] = u8[i] > 127 ? u8[i] - 256 : u8[i];
    return out;
  }
  function isByteArray(v) {
    return v instanceof Uint8Array || (Array.isArray(v) && (v.length === 0 || typeof v[0] === 'number'));
  }
  function bytesOf(data, charset) {
    if (data == null) return new Uint8Array(0);
    if (isByteArray(data)) return toU8(data);
    if (data && data.__mockBlob) return data.__mockBlob.bytes.slice();
    var s = String(data);
    if (charset && /ascii|latin|8859/i.test(String(charset))) {
      var a = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 255;
      return a;
    }
    return utf8Encode(s);
  }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64REV = (function () {
    var m = {};
    for (var i = 0; i < 64; i++) m[B64.charAt(i)] = i;
    return m;
  })();

  function b64encode(u8, webSafe) {
    var parts = [], chunk = [];
    for (var i = 0; i < u8.length; i += 3) {
      var a = u8[i], b = i + 1 < u8.length ? u8[i + 1] : 0, c = i + 2 < u8.length ? u8[i + 2] : 0;
      var t = (a << 16) | (b << 8) | c;
      chunk.push(B64.charAt((t >> 18) & 63), B64.charAt((t >> 12) & 63),
        i + 1 < u8.length ? B64.charAt((t >> 6) & 63) : '=', i + 2 < u8.length ? B64.charAt(t & 63) : '=');
      if (chunk.length >= 16384) { parts.push(chunk.join('')); chunk = []; }
    }
    parts.push(chunk.join(''));
    var s = parts.join('');
    return webSafe ? s.replace(/\+/g, '-').replace(/\//g, '_') : s;
  }

  function b64decode(str, webSafe) {
    var s = String(str == null ? '' : str).replace(/[\s]/g, '');
    if (webSafe) s = s.replace(/-/g, '+').replace(/_/g, '/');
    s = s.replace(/=+$/, '');
    if (/[^A-Za-z0-9+/]/.test(s) || s.length % 4 === 1) throw gasError('Could not decode string.');
    var out = new Uint8Array(Math.floor(s.length * 3 / 4));
    var n = 0, acc = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      acc = (acc << 6) | B64REV[s.charAt(i)];
      bits += 6;
      if (bits >= 8) { bits -= 8; out[n++] = (acc >> bits) & 255; }
    }
    return out.slice(0, n);
  }

  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  /** SHA-256(바이트) → Uint8Array(32) */
  function sha256(u8) {
    var len = u8.length;
    var total = ((len + 9 + 63) >> 6) << 6;
    var m = new Uint8Array(total);
    m.set(u8);
    m[len] = 0x80;
    var bitsHi = Math.floor(len / 0x20000000), bitsLo = (len << 3) >>> 0;
    m[total - 8] = (bitsHi >>> 24) & 255; m[total - 7] = (bitsHi >>> 16) & 255;
    m[total - 6] = (bitsHi >>> 8) & 255; m[total - 5] = bitsHi & 255;
    m[total - 4] = (bitsLo >>> 24) & 255; m[total - 3] = (bitsLo >>> 16) & 255;
    m[total - 2] = (bitsLo >>> 8) & 255; m[total - 1] = bitsLo & 255;
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var W = new Int32Array(64);
    for (var off = 0; off < total; off += 64) {
      for (var t = 0; t < 16; t++) {
        var j = off + t * 4;
        W[t] = (m[j] << 24) | (m[j + 1] << 16) | (m[j + 2] << 8) | m[j + 3];
      }
      for (t = 16; t < 64; t++) {
        var x = W[t - 15], y = W[t - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K256[t] + W[t]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = new Uint8Array(32);
    for (var i = 0; i < 8; i++) {
      out[i * 4] = (H[i] >>> 24) & 255; out[i * 4 + 1] = (H[i] >>> 16) & 255;
      out[i * 4 + 2] = (H[i] >>> 8) & 255; out[i * 4 + 3] = H[i] & 255;
    }
    return out;
  }

  function hmacSha256(msgU8, keyU8) {
    if (keyU8.length > 64) keyU8 = sha256(keyU8);
    var k = new Uint8Array(64);
    k.set(keyU8);
    var ipad = new Uint8Array(64 + msgU8.length), opad = new Uint8Array(64 + 32);
    for (var i = 0; i < 64; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
    ipad.set(msgU8, 64);
    opad.set(sha256(ipad), 64);
    return sha256(opad);
  }

  /*
   * 저장용 압축(LZW, 코드 0..65535 = UTF-16 글자, 65536~ = 사전). 15비트씩 묶어 0x20 을 더한 글자로 적어
   * 대리 쌍 영역(0xD800~)을 피한다 → localStorage 에 안전하게 들어간다.
   */
  var LZ_BASE = 65536, LZ_CAP = 4194304;
  // node:vm 컨텍스트에서는 전역 조회가 느리므로 자주 쓰는 함수는 지역 변수로 잡아 둔다.
  var imul = Math.imul, mpow = Math.pow, mfloor = Math.floor, I32 = Int32Array, U16 = Uint16Array;
  function lzHash(w, c) {
    var x = imul(w, 0x9e3779b1) ^ c;
    x = imul(x ^ (x >>> 15), 0x85ebca6b);
    return x ^ (x >>> 13);
  }

  function lzEncode(s) {
    var n = s.length;
    if (!n) return '0:';
    // (앞 코드, 다음 글자) → 코드 : 열린 주소 해시표(형식 배열)로 빠르게
    var size = 1 << 16, mask = size - 1, count = 0;
    var kw = new I32(size).fill(-1), kc = new U16(size), kv = new I32(size);
    function grow() {
      var ow = kw, oc = kc, ov = kv, os = size;
      size <<= 1; mask = size - 1;
      kw = new I32(size).fill(-1); kc = new U16(size); kv = new I32(size);
      for (var i = 0; i < os; i++) {
        if (ow[i] === -1) continue;
        var h = lzHash(ow[i], oc[i]) & mask;
        while (kw[h] !== -1) h = (h + 1) & mask;
        kw[h] = ow[i]; kc[h] = oc[i]; kv[h] = ov[i];
      }
    }
    var next = LZ_BASE, k = 0, acc = 0, accBits = 0, w = 17, lim = mpow(2, 17);
    var outBuf = new U16(Math.max(64, Math.ceil(n / 4))), on = 0;
    function push(v) {
      if (on >= outBuf.length) { var b = new U16(outBuf.length * 2); b.set(outBuf); outBuf = b; }
      outBuf[on++] = v;
    }
    function emit(code) {
      k++;
      if (LZ_BASE + k >= lim && LZ_BASE + k <= LZ_CAP) { w++; lim *= 2; }
      acc = acc * mpow(2, w) + code;
      accBits += w;
      while (accBits >= 15) {
        accBits -= 15;
        var p = mpow(2, accBits);
        var chv = mfloor(acc / p);
        acc -= chv * p;
        push(chv + 32);
      }
    }
    var cur = s.charCodeAt(0);
    for (var i = 1; i < n; i++) {
      var c = s.charCodeAt(i);
      var h = lzHash(cur, c) & mask;
      var found = -1;
      while (kw[h] !== -1) {
        if (kw[h] === cur && kc[h] === c) { found = kv[h]; break; }
        h = (h + 1) & mask;
      }
      if (found !== -1) { cur = found; continue; }
      emit(cur);
      if (next < LZ_CAP) {
        kw[h] = cur; kc[h] = c; kv[h] = next++;
        if (++count * 2 > size) grow();
      }
      cur = c;
    }
    emit(cur);
    if (accBits > 0) push(acc * mpow(2, 15 - accBits) + 32);
    return n + ':' + codesToString(outBuf, on);
  }

  function lzDecode(raw) {
    var colon = raw.indexOf(':');
    var n = Number(raw.slice(0, colon));
    var data = raw.slice(colon + 1);
    var out = new U16(n);
    var cap = 1 << 16;
    var pre = new I32(cap), suf = new U16(cap), len = new I32(cap);
    var cnt = 0, pos = 0, rd = 0, acc = 0, accBits = 0, k = 0;
    var prevCode = -1, prevLen = 0, prevPos = 0, prevFirst = 0;
    var width = 17, lim = mpow(2, 17);
    while (pos < n) {
      while (accBits < width) {
        if (rd >= data.length) throw new Error('저장 데이터가 잘렸습니다');
        acc = acc * 32768 + (data.charCodeAt(rd++) - 32);
        accBits += 15;
      }
      accBits -= width;
      var p = mpow(2, accBits);
      var code = mfloor(acc / p);
      acc -= code * p;
      k++;
      if (LZ_BASE + k + 1 >= lim && LZ_BASE + k + 1 <= LZ_CAP) { width++; lim *= 2; }
      var L, first;
      if (code < LZ_BASE) {
        L = 1; first = code;
        if (pos >= n) throw new Error('저장 데이터가 손상됐습니다');
        out[pos] = code;
      } else if (code - LZ_BASE < cnt) {
        L = len[code - LZ_BASE];
        if (pos + L > n) throw new Error('저장 데이터가 손상됐습니다');
        var q = pos + L - 1, c = code;
        while (c >= LZ_BASE) { out[q--] = suf[c - LZ_BASE]; c = pre[c - LZ_BASE]; }
        out[q] = c;
        first = c;
      } else if (code - LZ_BASE === cnt && prevCode !== -1) {
        L = prevLen + 1;
        if (pos + L > n) throw new Error('저장 데이터가 손상됐습니다');
        out.copyWithin(pos, prevPos, prevPos + prevLen);
        out[pos + prevLen] = prevFirst;
        first = prevFirst;
      } else {
        throw new Error('저장 데이터가 손상됐습니다');
      }
      if (prevCode !== -1 && LZ_BASE + cnt < LZ_CAP) {
        if (cnt >= cap) {
          cap <<= 1;
          var a = new I32(cap); a.set(pre); pre = a;
          var b = new U16(cap); b.set(suf); suf = b;
          var d = new I32(cap); d.set(len); len = d;
        }
        pre[cnt] = prevCode; suf[cnt] = first; len[cnt] = prevLen + 1; cnt++;
      }
      prevCode = code; prevLen = L; prevPos = pos; prevFirst = first;
      pos += L;
    }
    return codesToString(out, n);
  }

  /* =====================================================================
   * 공통
   * ===================================================================== */

  function gasError(msg) {
    var e = new Error(msg);
    e.name = 'Exception';
    return e;
  }
  function isDate(v) { return Object.prototype.toString.call(v) === '[object Date]'; }
  function pad(n, w) { var s = String(Math.abs(n)); while (s.length < w) s = '0' + s; return (n < 0 ? '-' : '') + s; }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function iterator(arr) {
    var i = 0;
    return {
      hasNext: function () { return i < arr.length; },
      next: function () {
        if (i >= arr.length) throw gasError('Cannot retrieve the next object: iterator has reached the end.');
        return arr[i++];
      },
      getContinuationToken: function () { return null; }
    };
  }
  function randomHex(n) {
    var s = '';
    var c = (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') ? crypto : null;
    if (c) {
      var a = new Uint8Array(Math.ceil(n / 2));
      c.getRandomValues(a);
      for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
      return s.slice(0, n);
    }
    while (s.length < n) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }
  function uuid() {
    var h = randomHex(32).split('');
    h[12] = '4';
    h[16] = '89ab'.charAt(parseInt(h[16], 16) & 3);
    h = h.join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  /* ---------- 날짜 서식 (Java SimpleDateFormat 부분집합) ---------- */

  var DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function tzOffsetMin(tz) {
    var t = String(tz == null ? '' : tz).trim();
    if (!t || /^(Asia\/Seoul|Asia\/Tokyo|ROK|KST|JST|Japan|Asia\/Pyongyang)$/i.test(t)) return 540;
    if (/^(UTC|GMT|Z|Etc\/UTC|Etc\/GMT|Universal|Zulu)$/i.test(t)) return 0;
    var m = /^(?:GMT|UTC)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(t);
    if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
    return 540;
  }

  function tokenizePattern(fmt) {
    var toks = [];
    var i = 0;
    while (i < fmt.length) {
      var ch = fmt.charAt(i);
      if (ch === "'") {
        var j = i + 1, lit = '';
        if (fmt.charAt(j) === "'") { toks.push({ lit: "'" }); i += 2; continue; }
        while (j < fmt.length) {
          if (fmt.charAt(j) === "'") {
            if (fmt.charAt(j + 1) === "'") { lit += "'"; j += 2; continue; }
            break;
          }
          lit += fmt.charAt(j++);
        }
        if (j >= fmt.length) throw gasError('Unterminated quote');
        toks.push({ lit: lit });
        i = j + 1;
        continue;
      }
      if (/[A-Za-z]/.test(ch)) {
        var k = i;
        while (k < fmt.length && fmt.charAt(k) === ch) k++;
        toks.push({ ch: ch, n: k - i });
        i = k;
        continue;
      }
      toks.push({ lit: ch });
      i++;
    }
    return toks;
  }

  function formatDate(date, tz, fmt) {
    if (!isDate(date)) {
      var tn = date === null ? 'null' : (typeof date === 'string' ? 'String' : typeof date);
      throw gasError('The parameters (' + tn + ',String,String) don\'t match the method signature for Utilities.formatDate.');
    }
    if (isNaN(date.getTime())) throw gasError('Invalid argument: date');
    var off = tzOffsetMin(tz);
    var d = new Date(date.getTime() + off * 60000);
    var Y = d.getUTCFullYear(), Mo = d.getUTCMonth(), D = d.getUTCDate(), H = d.getUTCHours(),
      Mi = d.getUTCMinutes(), S = d.getUTCSeconds(), ms = d.getUTCMilliseconds(), wd = d.getUTCDay();
    var sign = off < 0 ? '-' : '+', aoff = Math.abs(off);
    var oh = pad(Math.floor(aoff / 60), 2), om = pad(aoff % 60, 2);
    var toks = tokenizePattern(String(fmt));
    var out = '';
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.lit !== undefined) { out += t.lit; continue; }
      var n = t.n;
      switch (t.ch) {
        case 'y': case 'Y': out += n === 2 ? pad(Y % 100, 2) : pad(Y, Math.max(n, 1)); break;
        case 'M': case 'L': out += n >= 4 ? MON_LONG[Mo] : n === 3 ? MON_SHORT[Mo] : pad(Mo + 1, n); break;
        case 'd': out += pad(D, n); break;
        case 'H': out += pad(H, n); break;
        case 'k': out += pad(H === 0 ? 24 : H, n); break;
        case 'K': out += pad(H % 12, n); break;
        case 'h': out += pad(H % 12 === 0 ? 12 : H % 12, n); break;
        case 'm': out += pad(Mi, n); break;
        case 's': out += pad(S, n); break;
        case 'S': out += pad(ms, n); break;
        case 'E': out += n >= 4 ? DAY_LONG[wd] : DAY_SHORT[wd]; break;
        case 'u': out += pad(wd === 0 ? 7 : wd, n); break;
        case 'a': out += H < 12 ? 'AM' : 'PM'; break;
        case 'D': {
          var start = Date.UTC(Y, 0, 1);
          out += pad(Math.floor((Date.UTC(Y, Mo, D) - start) / 86400000) + 1, n);
          break;
        }
        case 'Z': out += sign + oh + om; break;
        case 'X': out += off === 0 ? 'Z' : (n === 1 ? sign + oh : n === 2 ? sign + oh + om : sign + oh + ':' + om); break;
        case 'z': out += off === 540 ? 'KST' : 'GMT' + sign + oh + ':' + om; break;
        default: throw gasError("Illegal pattern character '" + t.ch + "'");
      }
    }
    return out;
  }

  function parseDate(str, tz, fmt) {
    var toks = tokenizePattern(String(fmt));
    var s = String(str), pos = 0;
    var f = { y: 1970, M: 1, d: 1, H: 0, m: 0, s: 0, S: 0 }, pm = null;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.lit !== undefined) {
        if (s.substr(pos, t.lit.length) !== t.lit) throw gasError('Unparseable date: "' + str + '"');
        pos += t.lit.length;
        continue;
      }
      if (t.ch === 'a') {
        var ap = s.substr(pos, 2).toUpperCase();
        if (ap !== 'AM' && ap !== 'PM') throw gasError('Unparseable date: "' + str + '"');
        pm = ap === 'PM';
        pos += 2;
        continue;
      }
      if (t.ch === 'M' && t.n >= 3) {
        var list = t.n >= 4 ? MON_LONG : MON_SHORT, found = -1;
        for (var q = 0; q < 12; q++) if (s.substr(pos, list[q].length).toLowerCase() === list[q].toLowerCase()) { found = q; break; }
        if (found < 0) throw gasError('Unparseable date: "' + str + '"');
        f.M = found + 1;
        pos += list[found].length;
        continue;
      }
      var nextIsDigit = i + 1 < toks.length && toks[i + 1].ch !== undefined;
      var mx = nextIsDigit ? t.n : 10;
      var m = new RegExp('^[+-]?\\d{1,' + mx + '}').exec(s.slice(pos));
      if (!m) throw gasError('Unparseable date: "' + str + '"');
      pos += m[0].length;
      var v = Number(m[0]);
      if (t.ch === 'y' || t.ch === 'Y') f.y = (t.n === 2 && m[0].length <= 2) ? 2000 + v : v;
      else if (t.ch === 'M') f.M = v;
      else if (t.ch === 'd') f.d = v;
      else if (t.ch === 'H' || t.ch === 'k') f.H = v % 24;
      else if (t.ch === 'h' || t.ch === 'K') f.H = v % 12;
      else if (t.ch === 'm') f.m = v;
      else if (t.ch === 's') f.s = v;
      else if (t.ch === 'S') f.S = v;
    }
    if (pm === true) f.H += 12;
    var off = tzOffsetMin(tz);
    return new Date(Date.UTC(f.y, f.M - 1, f.d, f.H, f.m, f.s, f.S) - off * 60000);
  }

  function parseCsv(csv, delim) {
    var d = delim || ',', s = String(csv), rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (q) {
        if (c === '"') { if (s.charAt(i + 1) === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === d) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s.charAt(i + 1) === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /* ---------- A1 표기 ---------- */

  function colLetter(n) {
    var s = '';
    while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function colNumber(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.toUpperCase().charCodeAt(i) - 64);
    return n;
  }

  /* =====================================================================
   * createGasMock
   * ===================================================================== */

  function createGasMock(opts) {
    opts = opts || {};
    var storage = opts.storage || null;
    var storageKey = opts.storageKey || 'hds-preview-db';
    var nowFn = typeof opts.nowFn === 'function' ? opts.nowFn : function () { return new Date(); };
    var sink = opts.log || (typeof console !== 'undefined' ? console : { log: function () {}, warn: function () {}, error: function () {}, info: function () {} });
    var autoSave = opts.autoSave !== false;
    var debounceMs = opts.debounceMs == null ? 300 : opts.debounceMs;
    // setTimeout 을 객체 메서드로 부르면 브라우저에서 Illegal invocation — 감싸서 쓴다.
    var timers = opts.timers || (typeof setTimeout === 'function'
      ? { set: function (f, ms) { return setTimeout(f, ms); }, clear: function (t) { clearTimeout(t); } }
      : null);
    var htmlFiles = Array.isArray(opts.htmlFiles) ? opts.htmlFiles.slice() : null;

    var mock = {
      sent: [],
      logs: [],
      warnings: [],
      lastTemplate: null,
      templates: [],
      options: opts
    };

    var state = null;
    var blobs = {};     // driveFileId → Uint8Array (메모리)
    var dirty = false;
    var timer = null;
    var warned = {};
    var locks = 0;

    function nowMs() { var d = nowFn(); return isDate(d) ? d.getTime() : Number(d) || Date.now(); }
    function nowIso() { return new Date(nowMs()).toISOString(); }
    function out(kind, args) {
      try { (sink[kind] || sink.log).apply(sink, args); } catch (e) { /* 출력 실패는 무시 */ }
    }
    function warnOnce(key, msg) {
      if (warned[key]) { warned[key].count++; return; }
      warned[key] = { key: key, msg: msg, count: 1 };
      mock.warnings.push(warned[key]);
      out('warn', ['[gas-mock] ' + msg]);
    }

    function freshState() {
      return {
        v: 1,
        seq: 0,
        books: {},
        props: {},
        userProps: {},
        cache: {},
        drive: { root: 'root', folders: { root: { id: 'root', name: '내 드라이브', parent: null, trashed: false, created: nowIso() } }, files: {} },
        triggers: [],
        mail: { day: '', count: 0, recent: [] }
      };
    }
    state = freshState();

    function touch() {
      dirty = true;
      if (!storage || !autoSave) return;
      if (!timers) { save(); return; }
      // 첫 변경 뒤 debounceMs 에 한 번 저장(그 사이 변경은 묶음). 계속 바뀌어도 저장이 밀리지 않게 타이머를 다시 걸지 않는다.
      if (timer) return;
      timer = timers.set(function () { timer = null; if (dirty) save(); }, debounceMs);
    }

    function newId(prefix) {
      state.seq++;
      return prefix + randomHex(20) + state.seq.toString(36);
    }

    /* ---------- 영속 ---------- */

    function serialize(withBytes) {
      var now = nowMs();
      var cache = {};
      Object.keys(state.cache).forEach(function (k) {
        var c = state.cache[k];
        if (c && c.exp > now) cache[k] = c;
      });
      var snap = {
        v: 1, seq: state.seq, books: state.books, props: state.props, userProps: state.userProps, cache: cache,
        drive: state.drive, triggers: state.triggers, mail: state.mail, blobs: {}
      };
      if (withBytes) {
        var budget = DRIVE_PERSIST_BUDGET;
        Object.keys(blobs).forEach(function (id) {
          var f = state.drive.files[id];
          if (!f || f.trashed) return;
          var est = Math.ceil(blobs[id].length / 3) * 4;
          if (est > FILE_PERSIST_MAX || est > budget) return;
          budget -= est;
          snap.blobs[id] = b64encode(blobs[id]);
        });
      }
      return snap;
    }

    function encodeSnap(snap) {
      var json = JSON.stringify(snap);
      return json.length > COMPRESS_OVER ? 'lz1:' + lzEncode(json) : json;
    }

    function save() {
      if (timer && timers) { timers.clear(timer); timer = null; }
      dirty = false;
      if (!storage) return true;
      var hasBytes = Object.keys(blobs).length > 0;
      try {
        storage.setItem(storageKey, encodeSnap(serialize(true)));
        return true;
      } catch (e1) {
        if (hasBytes) {
          try {
            storage.setItem(storageKey, encodeSnap(serialize(false)));
            warnOnce('quota-bytes', '저장 공간이 모자라 드라이브 파일(사진·첨부) 내용은 이 탭 메모리에만 둡니다. 새로 고치면 파일 내용이 사라집니다');
            return true;
          } catch (e2) { /* 아래로 */ }
        }
        warnOnce('quota', '미리보기 데이터가 브라우저 저장 공간보다 커서 저장하지 못했습니다(이 탭을 닫거나 새로 고치면 사라짐): ' + (e1 && e1.message));
        return false;
      }
    }

    function applySnap(s) {
      var base = freshState();
      state = {
        v: 1,
        seq: s.seq || 0,
        books: s.books || {},
        props: s.props || {},
        userProps: s.userProps || {},
        cache: s.cache || {},
        drive: s.drive && s.drive.folders ? s.drive : base.drive,
        triggers: s.triggers || [],
        mail: s.mail || base.mail
      };
      blobs = {};
      var bl = s.blobs || {};
      Object.keys(bl).forEach(function (id) {
        try { blobs[id] = b64decode(bl[id]); } catch (e) { /* 깨진 파일은 버림 */ }
      });
      // 저장 왕복으로 문자열이 된 날짜 등은 그대로 둔다(시트 값은 문자열로 쓰는 것이 계약).
    }

    function load() {
      if (!storage) return false;
      var raw = null;
      try { raw = storage.getItem(storageKey); } catch (e) { raw = null; }
      if (!raw) return false;
      try {
        var json = raw.slice(0, 4) === 'lz1:' ? lzDecode(raw.slice(4)) : raw;
        var s = JSON.parse(json);
        if (!s || s.v !== 1) throw new Error('버전이 맞지 않습니다');
        applySnap(s);
        return true;
      } catch (e) {
        warnOnce('load', '저장된 미리보기 데이터를 읽지 못해 새로 시작합니다: ' + (e && e.message));
        return false;
      }
    }

    /* ---------- Blob ---------- */

    function makeBlob(bytes, type, name) {
      var inner = { bytes: toU8(bytes || []), type: type == null ? null : String(type), name: name == null ? null : String(name) };
      var blob = {
        __mockBlob: inner,
        getBytes: function () { return toSigned(inner.bytes); },
        setBytes: function (b) { inner.bytes = toU8(b); return blob; },
        getDataAsString: function (charset) {
          if (charset && /ascii|latin|8859/i.test(String(charset))) {
            var s = '';
            for (var i = 0; i < inner.bytes.length; i++) s += String.fromCharCode(inner.bytes[i]);
            return s;
          }
          return utf8Decode(inner.bytes);
        },
        setDataFromString: function (s, charset) { inner.bytes = bytesOf(String(s), charset); return blob; },
        getContentType: function () { return inner.type; },
        setContentType: function (t) { inner.type = t == null ? null : String(t); return blob; },
        getName: function () { return inner.name; },
        setName: function (n) { inner.name = n == null ? null : String(n); return blob; },
        copyBlob: function () { return makeBlob(inner.bytes.slice(), inner.type, inner.name); },
        getAs: function (t) {
          if (String(t) === inner.type) return blob.copyBlob();
          throw gasError('Converting from ' + inner.type + ' to ' + t + ' is not supported.');
        },
        getBlob: function () { return blob; },
        isGoogleType: function () { return false; },
        toString: function () { return 'Blob'; }
      };
      return blob;
    }

    /* ---------- Spreadsheet ---------- */

    function bookOf(id) {
      var b = state.books[id];
      if (!b) throw gasError('Unexpected error while getting the method or property openById on object SpreadsheetApp.');
      return b;
    }
    function sheetData(bookId, sheetId) {
      var b = state.books[bookId];
      var sh = b && b.sheets.filter(function (s) { return s.id === sheetId; })[0];
      if (!sh) throw gasError('시트가 이미 삭제됐습니다(미리보기 모의): ' + sheetId);
      return sh;
    }
    function newSheetData(book, name) {
      var maxId = 0;
      book.sheets.forEach(function (s) { if (s.id > maxId) maxId = s.id; });
      return { id: book.sheets.length ? maxId + 1 : 0, name: name, rows: [], maxRows: DEFAULT_ROWS, maxCols: DEFAULT_COLS, frozenRows: 0, frozenCols: 0, hidden: false, textCols: [], colWidths: {} };
    }
    function cellOut(v) {
      if (v === null || v === undefined) return '';
      if (isDate(v)) return new Date(v.getTime());
      return v;
    }
    function looksAutoConverted(s) {
      return /^\s*[+-]?(\d[\d,]*(\.\d+)?|\.\d+)([eE][+-]?\d+)?\s*%?\s*$/.test(s) ||
        /^\d{4}[-./]\d{1,2}[-./]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$/.test(s) ||
        /^\d{1,2}:\d{2}(:\d{2})?$/.test(s) || /^(true|false)$/i.test(s);
    }
    function cellIn(v, sh, col) {
      if (v === null || v === undefined) return '';
      var t = typeof v;
      if (t === 'string') {
        if (v.length > CELL_MAX) throw gasError('Your input contains more than the maximum of 50000 characters in a single cell.');
        if (v && !sh.textCols[col - 1]) {
          if (v.charAt(0) === '=') {
            warnOnce('formula:' + sh.name, '시트 "' + sh.name + '" 에 "=" 로 시작하는 문자열을 썼습니다 — GAS 는 수식으로 해석합니다. 그 열에 setNumberFormat(\'@\') 을 먼저 거세요');
          } else if (looksAutoConverted(v)) {
            warnOnce('auto:' + sh.name + ':' + col, '시트 "' + sh.name + '" ' + colLetter(col) + '열에 "' + v.slice(0, 20) + '" 같은 문자열을 서식 없이 썼습니다 — GAS 는 숫자·날짜·불리언으로 바꿉니다. setNumberFormat(\'@\') 을 먼저 거세요');
          }
        }
        return v;
      }
      if (t === 'number') return v;
      if (t === 'boolean') return v;
      if (isDate(v)) return new Date(v.getTime());
      if (Array.isArray(v)) {
        warnOnce('arraycell', '셀에 배열을 그대로 썼습니다 — GAS 는 쉼표로 이어 붙인 글자로 씁니다. JSON.stringify 하세요');
        return v.join(',');
      }
      if (t === 'object') {
        warnOnce('objcell', '셀에 객체를 그대로 썼습니다 — GAS 는 {a=1} 같은 글자로 씁니다. JSON.stringify 하세요');
        return '{' + Object.keys(v).map(function (k) { return k + '=' + v[k]; }).join(', ') + '}';
      }
      return String(v);
    }
    function lastRowOf(sh) {
      for (var r = sh.rows.length - 1; r >= 0; r--) {
        var row = sh.rows[r];
        if (!row) continue;
        for (var c = 0; c < row.length; c++) if (row[c] !== '' && row[c] !== null && row[c] !== undefined) return r + 1;
      }
      return 0;
    }
    function lastColOf(sh) {
      var m = 0;
      for (var r = 0; r < sh.rows.length; r++) {
        var row = sh.rows[r];
        if (!row) continue;
        for (var c = row.length - 1; c >= m; c--) if (row[c] !== '' && row[c] !== null && row[c] !== undefined) { m = c + 1; break; }
      }
      return m;
    }
    function trimRows(sh) {
      while (sh.rows.length && (function (row) {
        if (!row) return true;
        for (var c = 0; c < row.length; c++) if (row[c] !== '' && row[c] !== null && row[c] !== undefined) return false;
        return true;
      })(sh.rows[sh.rows.length - 1])) sh.rows.pop();
    }
    function checkInt(v, what) {
      if (typeof v !== 'number' || !isFinite(v)) throw gasError('Cannot convert ' + v + ' to (class). ' + what);
      return Math.floor(v);
    }

    function makeRange(bookId, sheetId, r, c, nr, nc) {
      function sh() { return sheetData(bookId, sheetId); }
      var range = {
        getValues: function () {
          var s = sh(), out = new Array(nr);
          for (var i = 0; i < nr; i++) {
            var src = s.rows[r - 1 + i], row = new Array(nc);
            for (var j = 0; j < nc; j++) row[j] = src ? cellOut(src[c - 1 + j]) : '';
            out[i] = row;
          }
          return out;
        },
        getDisplayValues: function () {
          return range.getValues().map(function (row) {
            return row.map(function (v) { return isDate(v) ? formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss') : String(v); });
          });
        },
        getValue: function () { var s = sh(); var row = s.rows[r - 1]; return row ? cellOut(row[c - 1]) : ''; },
        getDisplayValue: function () { var v = range.getValue(); return isDate(v) ? formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss') : String(v); },
        setValues: function (values) {
          if (!Array.isArray(values)) throw gasError('The parameters (' + typeof values + ') don\'t match the method signature for SpreadsheetApp.Range.setValues.');
          if (values.length !== nr) throw gasError('The number of rows in the data does not match the number of rows in the range. The data has ' + values.length + ' but the range has ' + nr + '.');
          for (var i = 0; i < values.length; i++) {
            if (!Array.isArray(values[i])) throw gasError('The parameters (number[]) don\'t match the method signature for SpreadsheetApp.Range.setValues.');
            if (values[i].length !== nc) throw gasError('The number of columns in the data does not match the number of columns in the range. The data has ' + values[i].length + ' but the range has ' + nc + '.');
          }
          var s = sh();
          var conv = values.map(function (row) { return row.map(function (v, j) { return cellIn(v, s, c + j); }); });
          for (i = 0; i < nr; i++) {
            var ri = r - 1 + i;
            while (s.rows.length <= ri) s.rows.push([]);
            var row = s.rows[ri] || (s.rows[ri] = []);
            while (row.length < c - 1 + nc) row.push('');
            for (var j = 0; j < nc; j++) row[c - 1 + j] = conv[i][j];
          }
          trimRows(s);
          touch();
          return range;
        },
        setValue: function (v) { return range.getCell(1, 1).setValues([[v]]) && range; },
        clearContent: function () {
          var s = sh();
          for (var i = 0; i < nr; i++) {
            var row = s.rows[r - 1 + i];
            if (!row) continue;
            for (var j = 0; j < nc; j++) if (c - 1 + j < row.length) row[c - 1 + j] = '';
          }
          trimRows(s);
          touch();
          return range;
        },
        clear: function () { return range.clearContent(); },
        clearFormat: function () { return range; },
        clearDataValidations: function () { return range; },
        setNumberFormat: function (f) {
          var s = sh();
          for (var j = 0; j < nc; j++) s.textCols[c - 1 + j] = String(f) === '@';
          touch();
          return range;
        },
        setNumberFormats: function (fs) {
          var s = sh();
          if (Array.isArray(fs)) fs.forEach(function (row) {
            (row || []).forEach(function (f, j) { if (String(f) === '@') s.textCols[c - 1 + j] = true; });
          });
          touch();
          return range;
        },
        getNumberFormat: function () { return sh().textCols[c - 1] ? '@' : 'General'; },
        getNumRows: function () { return nr; },
        getNumColumns: function () { return nc; },
        getRow: function () { return r; },
        getRowIndex: function () { return r; },
        getColumn: function () { return c; },
        getLastRow: function () { return r + nr - 1; },
        getLastColumn: function () { return c + nc - 1; },
        getHeight: function () { return nr; },
        getWidth: function () { return nc; },
        getA1Notation: function () {
          var a = colLetter(c) + r;
          return nr === 1 && nc === 1 ? a : a + ':' + colLetter(c + nc - 1) + (r + nr - 1);
        },
        getSheet: function () { return makeSheet(bookId, sheetId); },
        getCell: function (rr, cc) {
          if (rr < 1 || cc < 1 || rr > nr || cc > nc) throw gasError('Cell reference out of range');
          return makeRange(bookId, sheetId, r + rr - 1, c + cc - 1, 1, 1);
        },
        offset: function (dr, dc, nr2, nc2) {
          return makeSheet(bookId, sheetId).getRange(r + dr, c + dc, nr2 == null ? nr : nr2, nc2 == null ? nc : nc2);
        },
        setFormula: function (f) { return range.setValue(String(f)); },
        protect: function () { return { setDescription: function () { return this; }, setWarningOnly: function () { return this; }, removeEditors: function () { return this; } }; }
      };
      ['setFontWeight', 'setFontWeights', 'setBackground', 'setBackgrounds', 'setFontColor', 'setFontColors', 'setHorizontalAlignment',
        'setVerticalAlignment', 'setWrap', 'setWrapStrategy', 'setFontSize', 'setFontFamily', 'setBorder', 'setNote', 'setFontStyle',
        'setDataValidation', 'setTextStyle', 'setHorizontalAlignments', 'setFontLine', 'merge', 'breakApart', 'activate'].forEach(function (m) {
        range[m] = function () { return range; };
      });
      return range;
    }

    function makeSheet(bookId, sheetId) {
      function sh() { return sheetData(bookId, sheetId); }
      var sheet = {
        getName: function () { return sh().name; },
        setName: function (n) {
          n = String(n);
          var b = state.books[bookId];
          if (b.sheets.some(function (s) { return s.id !== sheetId && s.name.toLowerCase() === n.toLowerCase(); })) {
            throw gasError('A sheet with the name "' + n + '" already exists. Please enter another name.');
          }
          sh().name = n;
          touch();
          return sheet;
        },
        getSheetId: function () { return sheetId; },
        getIndex: function () {
          var b = state.books[bookId];
          for (var i = 0; i < b.sheets.length; i++) if (b.sheets[i].id === sheetId) return i + 1;
          return 0;
        },
        getParent: function () { return makeBook(bookId); },
        getRange: function (a, b, cc, d) {
          var s = sh(), r, c, nr, nc;
          if (typeof a === 'string') {
            var m = /^(?:'?[^!]*'?!)?\$?([A-Za-z]+)\$?(\d+)?(?::\$?([A-Za-z]+)\$?(\d+)?)?$/.exec(a.trim());
            if (!m) throw gasError('Range not found');
            c = colNumber(m[1]);
            r = m[2] ? Number(m[2]) : 1;
            var c2 = m[3] ? colNumber(m[3]) : c;
            var r2;
            if (m[3]) r2 = m[4] ? Number(m[4]) : s.maxRows;      // 'A1:C3' · 'A2:C'
            else r2 = m[2] ? r : s.maxRows;                       // 'A1' · 'A'
            nr = r2 - r + 1;
            nc = c2 - c + 1;
          } else {
            r = checkInt(a, 'row');
            c = checkInt(b, 'column');
            nr = cc === undefined ? 1 : checkInt(cc, 'numRows');
            nc = d === undefined ? 1 : checkInt(d, 'numColumns');
          }
          if (r < 1) throw gasError('The starting row of the range is too small.');
          if (c < 1) throw gasError('The starting column of the range is too small.');
          if (nr < 1) throw gasError('The number of rows in the range must be at least 1.');
          if (nc < 1) throw gasError('The number of columns in the range must be at least 1.');
          if (r + nr - 1 > s.maxRows || c + nc - 1 > s.maxCols) throw gasError('The coordinates of the range are outside the dimensions of the sheet.');
          return makeRange(bookId, sheetId, r, c, nr, nc);
        },
        getSheetValues: function (r, c, nr, nc) { return sheet.getRange(r, c, nr, nc).getValues(); },
        getDataRange: function () {
          var s = sh();
          return makeRange(bookId, sheetId, 1, 1, Math.max(1, lastRowOf(s)), Math.max(1, lastColOf(s)));
        },
        getLastRow: function () { return lastRowOf(sh()); },
        getLastColumn: function () { return lastColOf(sh()); },
        getMaxRows: function () { return sh().maxRows; },
        getMaxColumns: function () { return sh().maxCols; },
        appendRow: function (arr) {
          if (!Array.isArray(arr)) throw gasError('The parameters (' + typeof arr + ') don\'t match the method signature for SpreadsheetApp.Sheet.appendRow.');
          var s = sh();
          var ri = lastRowOf(s);
          var conv = arr.map(function (v, j) { return cellIn(v, s, j + 1); });
          if (ri + 1 > s.maxRows) s.maxRows = ri + 1;
          if (conv.length > s.maxCols) s.maxCols = conv.length;
          while (s.rows.length < ri) s.rows.push([]);
          s.rows[ri] = conv;
          trimRows(s);
          touch();
          return sheet;
        },
        clear: function () { sh().rows = []; touch(); return sheet; },
        clearContents: function () { sh().rows = []; touch(); return sheet; },
        clearFormats: function () { sh().textCols = []; touch(); return sheet; },
        setFrozenRows: function (n) { sh().frozenRows = checkInt(n, 'rows'); touch(); return sheet; },
        getFrozenRows: function () { return sh().frozenRows; },
        setFrozenColumns: function (n) { sh().frozenCols = checkInt(n, 'columns'); touch(); return sheet; },
        getFrozenColumns: function () { return sh().frozenCols; },
        deleteRows: function (start, n) {
          var s = sh();
          start = checkInt(start, 'rowPosition');
          n = checkInt(n, 'howMany');
          if (n < 1 || start < 1 || start + n - 1 > s.maxRows) throw gasError('Those rows are out of bounds.');
          if (s.maxRows - n <= s.frozenRows) throw gasError('Sorry, it is not possible to delete all non-frozen rows.');
          s.rows.splice(start - 1, n);
          s.maxRows -= n;
          trimRows(s);
          touch();
          return sheet;
        },
        deleteRow: function (r) { return sheet.deleteRows(r, 1); },
        insertRowsAfter: function (after, n) {
          var s = sh();
          after = checkInt(after, 'afterPosition');
          n = checkInt(n, 'howMany');
          if (after < 1 || after > s.maxRows) throw gasError('Those rows are out of bounds.');
          if (n < 1) throw gasError('The number of rows to insert must be at least 1.');
          if (after < s.rows.length) {
            var blank = [];
            for (var i = 0; i < n; i++) blank.push([]);
            Array.prototype.splice.apply(s.rows, [after, 0].concat(blank));
          }
          s.maxRows += n;
          touch();
          return sheet;
        },
        insertRowAfter: function (after) { return sheet.insertRowsAfter(after, 1); },
        insertRowsBefore: function (before, n) {
          var s = sh();
          before = checkInt(before, 'beforePosition');
          n = checkInt(n, 'howMany');
          if (before < 1 || before > s.maxRows) throw gasError('Those rows are out of bounds.');
          if (before - 1 < s.rows.length) {
            var blank = [];
            for (var i = 0; i < n; i++) blank.push([]);
            Array.prototype.splice.apply(s.rows, [before - 1, 0].concat(blank));
          }
          s.maxRows += n;
          touch();
          return sheet;
        },
        insertRowBefore: function (before) { return sheet.insertRowsBefore(before, 1); },
        insertRows: function (before, n) { return sheet.insertRowsBefore(before, n == null ? 1 : n); },
        insertColumnsAfter: function (after, n) {
          var s = sh();
          after = checkInt(after, 'afterPosition');
          n = checkInt(n, 'howMany');
          if (after < 1 || after > s.maxCols) throw gasError('Those columns are out of bounds.');
          s.rows.forEach(function (row) {
            if (row && row.length > after) {
              var blank = [];
              for (var i = 0; i < n; i++) blank.push('');
              Array.prototype.splice.apply(row, [after, 0].concat(blank));
            }
          });
          var tb = [];
          for (var i = 0; i < n; i++) tb.push(s.textCols[after - 1] || false);
          Array.prototype.splice.apply(s.textCols, [after, 0].concat(tb));
          s.maxCols += n;
          touch();
          return sheet;
        },
        insertColumnAfter: function (after) { return sheet.insertColumnsAfter(after, 1); },
        insertColumnsBefore: function (before, n) {
          var s = sh();
          before = checkInt(before, 'beforePosition');
          n = checkInt(n, 'howMany');
          if (before < 1 || before > s.maxCols) throw gasError('Those columns are out of bounds.');
          s.rows.forEach(function (row) {
            if (row && row.length >= before) {
              var blank = [];
              for (var i = 0; i < n; i++) blank.push('');
              Array.prototype.splice.apply(row, [before - 1, 0].concat(blank));
            }
          });
          var tb = [];
          for (var i = 0; i < n; i++) tb.push(false);
          Array.prototype.splice.apply(s.textCols, [before - 1, 0].concat(tb));
          s.maxCols += n;
          touch();
          return sheet;
        },
        insertColumnBefore: function (before) { return sheet.insertColumnsBefore(before, 1); },
        insertColumns: function (before, n) { return sheet.insertColumnsBefore(before, n == null ? 1 : n); },
        deleteColumns: function (start, n) {
          var s = sh();
          start = checkInt(start, 'columnPosition');
          n = checkInt(n, 'howMany');
          if (n < 1 || start < 1 || start + n - 1 > s.maxCols) throw gasError('Those columns are out of bounds.');
          if (s.maxCols - n < 1) throw gasError('Sorry, it is not possible to delete all non-frozen columns.');
          s.rows.forEach(function (row) { if (row) row.splice(start - 1, n); });
          s.textCols.splice(start - 1, n);
          s.maxCols -= n;
          trimRows(s);
          touch();
          return sheet;
        },
        deleteColumn: function (c) { return sheet.deleteColumns(c, 1); },
        hideSheet: function () {
          var b = state.books[bookId];
          var visible = b.sheets.filter(function (s) { return !s.hidden; });
          if (visible.length <= 1 && !sh().hidden) throw gasError('You can\'t hide all the sheets in a document.');
          sh().hidden = true;
          touch();
          return sheet;
        },
        showSheet: function () { sh().hidden = false; touch(); return sheet; },
        isSheetHidden: function () { return !!sh().hidden; },
        setColumnWidth: function (col, w) { sh().colWidths[col] = w; return sheet; },
        setColumnWidths: function (start, n, w) { for (var i = 0; i < n; i++) sh().colWidths[start + i] = w; return sheet; },
        getColumnWidth: function (col) { return sh().colWidths[col] || 100; },
        setRowHeight: function () { return sheet; },
        setRowHeights: function () { return sheet; },
        autoResizeColumns: function () { return sheet; },
        autoResizeColumn: function () { return sheet; },
        setTabColor: function () { return sheet; },
        activate: function () { return sheet; },
        showColumns: function () { return sheet; },
        hideColumns: function () { return sheet; },
        protect: function () { return { setDescription: function () { return this; }, setWarningOnly: function () { return this; }, removeEditors: function () { return this; } }; },
        getType: function () { return 'GRID'; },
        toString: function () { return 'Sheet'; }
      };
      return sheet;
    }

    function makeBook(id) {
      bookOf(id);
      var book = {
        getId: function () { return id; },
        getUrl: function () { return 'https://docs.google.com/spreadsheets/d/' + id + '/edit'; },
        getName: function () { return bookOf(id).name; },
        rename: function (n) { bookOf(id).name = String(n); var f = state.drive.files[id]; if (f) f.name = String(n); touch(); return book; },
        getSheetByName: function (n) {
          var s = bookOf(id).sheets.filter(function (x) { return x.name === String(n); })[0];
          return s ? makeSheet(id, s.id) : null;
        },
        getSheets: function () { return bookOf(id).sheets.map(function (s) { return makeSheet(id, s.id); }); },
        getSheetById: function (sid) {
          var s = bookOf(id).sheets.filter(function (x) { return x.id === sid; })[0];
          return s ? makeSheet(id, s.id) : null;
        },
        getNumSheets: function () { return bookOf(id).sheets.length; },
        insertSheet: function (name, index) {
          var b = bookOf(id);
          if (typeof name === 'number' && index === undefined) { index = name; name = undefined; }
          if (name === undefined || name === null || name === '') {
            var k = b.sheets.length + 1;
            while (b.sheets.some(function (s) { return s.name === 'Sheet' + k; })) k++;
            name = 'Sheet' + k;
          }
          name = String(name);
          if (b.sheets.some(function (s) { return s.name.toLowerCase() === name.toLowerCase(); })) {
            throw gasError('A sheet with the name "' + name + '" already exists. Please enter another name.');
          }
          var sd = newSheetData(b, name);
          if (typeof index === 'number' && index >= 0 && index <= b.sheets.length) b.sheets.splice(index, 0, sd);
          else b.sheets.push(sd);
          touch();
          return makeSheet(id, sd.id);
        },
        deleteSheet: function (sheet) {
          var b = bookOf(id);
          var sid = sheet && typeof sheet.getSheetId === 'function' ? sheet.getSheetId() : null;
          var i = -1;
          for (var k = 0; k < b.sheets.length; k++) if (b.sheets[k].id === sid) i = k;
          if (i < 0) throw gasError('Sheet not found');
          if (b.sheets.length <= 1) throw gasError('You can\'t remove all the sheets in a document.');
          b.sheets.splice(i, 1);
          touch();
        },
        getActiveSheet: function () { return makeSheet(id, bookOf(id).sheets[0].id); },
        setActiveSheet: function (s) { return s; },
        getSpreadsheetTimeZone: function () { return 'Asia/Seoul'; },
        setSpreadsheetTimeZone: function () { return book; },
        getSpreadsheetLocale: function () { return 'ko_KR'; },
        setSpreadsheetLocale: function () { return book; },
        addEditor: function () { return book; },
        addViewer: function () { return book; },
        getOwner: function () { return { getEmail: function () { return opts.effectiveUserEmail || ''; } }; },
        toast: function () { return book; },
        flush: function () { return book; },
        toString: function () { return 'Spreadsheet'; }
      };
      return book;
    }

    var SpreadsheetApp = {
      openById: function (id) {
        id = String(id || '');
        if (!state.books[id]) throw gasError('Unexpected error while getting the method or property openById on object SpreadsheetApp.');
        return makeBook(id);
      },
      open: function (file) { return SpreadsheetApp.openById(file && file.getId ? file.getId() : ''); },
      openByUrl: function (url) {
        var m = /\/d\/([^/]+)/.exec(String(url || ''));
        if (!m || !state.books[m[1]]) throw gasError('Unexpected error while getting the method or property openByUrl on object SpreadsheetApp.');
        return makeBook(m[1]);
      },
      create: function (name, rows, cols) {
        var id = newId('ss');
        var b = { id: id, name: String(name == null ? '제목 없는 스프레드시트' : name), sheets: [], created: nowIso() };
        var sd = newSheetData(b, 'Sheet1');
        if (rows) sd.maxRows = rows;
        if (cols) sd.maxCols = cols;
        b.sheets.push(sd);
        state.books[id] = b;
        state.drive.files[id] = { id: id, name: b.name, mime: 'application/vnd.google-apps.spreadsheet', parent: state.drive.root, trashed: false, size: 0, created: nowIso(), updated: nowIso(), google: true };
        touch();
        return makeBook(id);
      },
      flush: function () {},
      getActiveSpreadsheet: function () { return null; },
      getActive: function () { return null; },
      getUi: function () { throw gasError('Cannot call SpreadsheetApp.getUi() from this context.'); },
      newDataValidation: function () {
        var b = {};
        ['requireValueInList', 'setAllowInvalid', 'requireCheckbox', 'setHelpText'].forEach(function (m) { b[m] = function () { return b; }; });
        b.build = function () { return {}; };
        return b;
      },
      BorderStyle: { SOLID: 'SOLID', DOTTED: 'DOTTED', DASHED: 'DASHED' },
      WrapStrategy: { WRAP: 'WRAP', CLIP: 'CLIP', OVERFLOW: 'OVERFLOW' }
    };

    /* ---------- Properties / Cache / Lock ---------- */

    function makeProps(bag) {
      var p = {
        getProperty: function (k) {
          var o = state[bag];
          return Object.prototype.hasOwnProperty.call(o, String(k)) ? o[String(k)] : null;
        },
        setProperty: function (k, v) {
          var s = String(v);
          if (s.length > PROP_VALUE_MAX) throw gasError('Argument too large: value');
          state[bag][String(k)] = s;
          touch();
          return p;
        },
        deleteProperty: function (k) { delete state[bag][String(k)]; touch(); return p; },
        getProperties: function () { var o = {}; Object.keys(state[bag]).forEach(function (k) { o[k] = state[bag][k]; }); return o; },
        setProperties: function (obj, deleteAllOthers) {
          if (deleteAllOthers) state[bag] = {};
          Object.keys(obj || {}).forEach(function (k) {
            var s = String(obj[k]);
            if (s.length > PROP_VALUE_MAX) throw gasError('Argument too large: value');
            state[bag][k] = s;
          });
          touch();
          return p;
        },
        deleteAllProperties: function () { state[bag] = {}; touch(); return p; },
        getKeys: function () { return Object.keys(state[bag]); }
      };
      return p;
    }
    var PropertiesService = {
      getScriptProperties: function () { return makeProps('props'); },
      getUserProperties: function () { return makeProps('userProps'); },
      getDocumentProperties: function () { return null; }
    };

    function cacheObj(prefix) {
      function key(k) {
        k = String(k);
        if (k.length > CACHE_KEY_MAX) throw gasError('Argument too large: key');
        return prefix + k;
      }
      function getOne(k) {
        var c = state.cache[key(k)];
        if (!c) return null;
        if (c.exp <= nowMs()) { delete state.cache[key(k)]; return null; }
        return c.v;
      }
      function putOne(k, v, ttl) {
        var s = String(v);
        if (s.length > CACHE_VALUE_MAX) throw gasError('Argument too large: value');
        var sec = ttl == null ? 600 : Number(ttl);
        if (!(sec >= 1)) sec = 1;
        if (sec > CACHE_TTL_MAX) sec = CACHE_TTL_MAX;
        state.cache[key(k)] = { v: s, exp: nowMs() + sec * 1000 };
      }
      var c = {
        get: function (k) { return getOne(k); },
        put: function (k, v, ttl) { putOne(k, v, ttl); touch(); },
        remove: function (k) { delete state.cache[key(k)]; touch(); },
        getAll: function (keys) {
          var o = {};
          (keys || []).forEach(function (k) { var v = getOne(k); if (v !== null) o[k] = v; });
          return o;
        },
        putAll: function (obj, ttl) { Object.keys(obj || {}).forEach(function (k) { putOne(k, obj[k], ttl); }); touch(); },
        removeAll: function (keys) { (keys || []).forEach(function (k) { delete state.cache[key(k)]; }); touch(); }
      };
      return c;
    }
    var CacheService = {
      getScriptCache: function () { return cacheObj('s:'); },
      getUserCache: function () { return cacheObj('u:'); },
      getDocumentCache: function () { return null; }
    };

    function lockObj() {
      var held = false;
      var l = {
        waitLock: function (ms) { if (!held) { held = true; locks++; } },
        tryLock: function (ms) { if (!held) { held = true; locks++; } return true; },
        releaseLock: function () { if (held) { held = false; locks = Math.max(0, locks - 1); } },
        hasLock: function () { return held; }
      };
      return l;
    }
    var LockService = {
      getScriptLock: function () { return lockObj(); },
      getUserLock: function () { return lockObj(); },
      getDocumentLock: function () { return null; }
    };

    /* ---------- Drive ---------- */

    function folderData(id) {
      var f = state.drive.folders[id];
      if (!f) throw gasError('No item with the given ID could be found. Possibly because you have not edited this item or you do not have permission to access it.');
      return f;
    }
    function fileData(id) {
      var f = state.drive.files[id];
      if (!f) throw gasError('No item with the given ID could be found. Possibly because you have not edited this item or you do not have permission to access it.');
      return f;
    }
    function createFileIn(parentId, a, b, c) {
      var bytes, mime, name;
      if (a && a.__mockBlob) {
        bytes = a.__mockBlob.bytes.slice();
        mime = a.__mockBlob.type || 'application/octet-stream';
        name = a.__mockBlob.name || '제목 없음';
      } else {
        name = String(a == null ? '제목 없음' : a);
        bytes = utf8Encode(b == null ? '' : String(b));
        mime = c ? String(c) : 'text/plain';
      }
      var id = newId('fl');
      state.drive.files[id] = { id: id, name: name, mime: mime, parent: parentId, trashed: false, size: bytes.length, created: nowIso(), updated: nowIso() };
      blobs[id] = bytes;
      touch();
      return makeFile(id);
    }
    function makeFile(id) {
      fileData(id);
      var file = {
        getId: function () { return id; },
        getName: function () { return fileData(id).name; },
        setName: function (n) { fileData(id).name = String(n); touch(); return file; },
        getMimeType: function () { return fileData(id).mime; },
        getSize: function () { return fileData(id).size || 0; },
        getUrl: function () {
          var f = fileData(id);
          return f.google ? 'https://docs.google.com/spreadsheets/d/' + id + '/edit?usp=drivesdk' : 'https://drive.google.com/file/d/' + id + '/view?usp=drivesdk';
        },
        getDownloadUrl: function () { return 'https://drive.google.com/uc?id=' + id + '&export=download'; },
        getBlob: function () {
          var f = fileData(id);
          if (f.google) throw gasError('미리보기에서는 구글 문서를 다른 파일 형식으로 바꿀 수 없습니다');
          var b = blobs[id];
          if (!b) {
            warnOnce('lost:' + id, '드라이브 파일 ' + f.name + ' 의 내용이 미리보기 저장소에 없습니다(용량 때문에 메모리에만 있었음)');
            b = new Uint8Array(0);
          }
          return makeBlob(b.slice(), f.mime, f.name);
        },
        getAs: function (t) { return file.getBlob().getAs(t); },
        setContent: function (s) {
          var f = fileData(id);
          blobs[id] = utf8Encode(String(s));
          f.size = blobs[id].length;
          f.updated = nowIso();
          touch();
          return file;
        },
        setTrashed: function (t) { fileData(id).trashed = !!t; touch(); return file; },
        isTrashed: function () { return !!fileData(id).trashed; },
        getDateCreated: function () { return new Date(fileData(id).created); },
        getLastUpdated: function () { return new Date(fileData(id).updated || fileData(id).created); },
        getParents: function () { var p = fileData(id).parent; return iterator(p && state.drive.folders[p] ? [makeFolder(p)] : []); },
        moveTo: function (folder) { fileData(id).parent = folder.getId(); touch(); return file; },
        makeCopy: function (name, folder) {
          var f = fileData(id);
          if (name && typeof name === 'object' && typeof name.getId === 'function') { folder = name; name = null; }
          var nid = newId('fl');
          var copy = clone(f);
          copy.id = nid;
          copy.name = name ? String(name) : '사본 - ' + f.name;
          copy.parent = folder ? folder.getId() : f.parent;
          copy.created = nowIso();
          state.drive.files[nid] = copy;
          if (f.google && state.books[id]) {
            var bk = clone(state.books[id]);
            bk.id = nid;
            bk.name = copy.name;
            state.books[nid] = bk;
          }
          if (blobs[id]) blobs[nid] = blobs[id].slice();
          touch();
          return makeFile(nid);
        },
        setSharing: function () { return file; },
        setDescription: function () { return file; },
        getDescription: function () { return ''; },
        addEditor: function () { return file; },
        addViewer: function () { return file; },
        getOwner: function () { return { getEmail: function () { return opts.effectiveUserEmail || ''; } }; },
        toString: function () { return fileData(id).name; }
      };
      return file;
    }
    function makeFolder(id) {
      folderData(id);
      function kids(kind, pred) {
        var bag = kind === 'file' ? state.drive.files : state.drive.folders;
        return Object.keys(bag).filter(function (k) {
          var x = bag[k];
          return x.parent === id && !x.trashed && (!pred || pred(x));
        }).map(function (k) { return kind === 'file' ? makeFile(k) : makeFolder(k); });
      }
      var folder = {
        getId: function () { return id; },
        getName: function () { return folderData(id).name; },
        setName: function (n) { folderData(id).name = String(n); touch(); return folder; },
        getUrl: function () { return 'https://drive.google.com/drive/folders/' + id; },
        createFolder: function (name) {
          var nid = newId('fd');
          state.drive.folders[nid] = { id: nid, name: String(name), parent: id, trashed: false, created: nowIso() };
          touch();
          return makeFolder(nid);
        },
        createFile: function (a, b, c) { return createFileIn(id, a, b, c); },
        getFiles: function () { return iterator(kids('file')); },
        getFolders: function () { return iterator(kids('folder')); },
        getFilesByName: function (n) { return iterator(kids('file', function (x) { return x.name === String(n); })); },
        getFoldersByName: function (n) { return iterator(kids('folder', function (x) { return x.name === String(n); })); },
        getParents: function () { var p = folderData(id).parent; return iterator(p ? [makeFolder(p)] : []); },
        addFile: function (f) { fileData(f.getId()).parent = id; touch(); return folder; },
        removeFile: function () { return folder; },
        moveTo: function (dest) { folderData(id).parent = dest.getId(); touch(); return folder; },
        setTrashed: function (t) { folderData(id).trashed = !!t; touch(); return folder; },
        isTrashed: function () { return !!folderData(id).trashed; },
        getDateCreated: function () { return new Date(folderData(id).created); },
        setSharing: function () { return folder; },
        setDescription: function () { return folder; },
        addEditor: function () { return folder; },
        addViewer: function () { return folder; },
        getSize: function () { return 0; },
        toString: function () { return folderData(id).name; }
      };
      return folder;
    }
    var DriveApp = {
      getRootFolder: function () { return makeFolder(state.drive.root); },
      getFolderById: function (id) { folderData(String(id)); return makeFolder(String(id)); },
      getFileById: function (id) { fileData(String(id)); return makeFile(String(id)); },
      createFolder: function (name) { return makeFolder(state.drive.root).createFolder(name); },
      createFile: function (a, b, c) { return createFileIn(state.drive.root, a, b, c); },
      getFoldersByName: function (n) {
        return iterator(Object.keys(state.drive.folders).filter(function (k) { var f = state.drive.folders[k]; return f.name === String(n) && !f.trashed; }).map(makeFolder));
      },
      getFilesByName: function (n) {
        return iterator(Object.keys(state.drive.files).filter(function (k) { var f = state.drive.files[k]; return f.name === String(n) && !f.trashed; }).map(makeFile));
      },
      getFiles: function () { return iterator(Object.keys(state.drive.files).filter(function (k) { return !state.drive.files[k].trashed; }).map(makeFile)); },
      getFolders: function () { return iterator(Object.keys(state.drive.folders).filter(function (k) { return k !== state.drive.root && !state.drive.folders[k].trashed; }).map(makeFolder)); },
      getStorageUsed: function () { return Object.keys(blobs).reduce(function (s, k) { return s + blobs[k].length; }, 0); },
      Access: { ANYONE: 'ANYONE', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', DOMAIN: 'DOMAIN', DOMAIN_WITH_LINK: 'DOMAIN_WITH_LINK', PRIVATE: 'PRIVATE' },
      Permission: { VIEW: 'VIEW', EDIT: 'EDIT', COMMENT: 'COMMENT', NONE: 'NONE' }
    };

    /* ---------- Utilities ---------- */

    var Utilities = {
      DigestAlgorithm: { MD2: 'MD2', MD5: 'MD5', SHA_1: 'SHA_1', SHA_256: 'SHA_256', SHA_384: 'SHA_384', SHA_512: 'SHA_512' },
      Charset: { US_ASCII: 'US_ASCII', UTF_8: 'UTF_8' },
      MacAlgorithm: { HMAC_SHA_256: 'HMAC_SHA_256' },
      getUuid: function () { return uuid(); },
      newBlob: function (data, contentType, name) { return makeBlob(bytesOf(data), contentType, name); },
      base64Encode: function (data, charset) { return b64encode(bytesOf(data, charset), false); },
      base64EncodeWebSafe: function (data, charset) { return b64encode(bytesOf(data, charset), true); },
      base64Decode: function (s) { return toSigned(b64decode(s, false)); },
      base64DecodeWebSafe: function (s) { return toSigned(b64decode(s, true)); },
      computeDigest: function (alg, value, charset) {
        if (String(alg) !== 'SHA_256') throw gasError('미리보기 모의는 SHA_256 만 지원합니다: ' + alg);
        return toSigned(sha256(bytesOf(value, charset)));
      },
      computeHmacSha256Signature: function (value, key, charset) {
        return toSigned(hmacSha256(bytesOf(value, charset), bytesOf(key, charset)));
      },
      computeHmacSignature: function (alg, value, key, charset) {
        if (String(alg) !== 'HMAC_SHA_256') throw gasError('미리보기 모의는 HMAC_SHA_256 만 지원합니다: ' + alg);
        return toSigned(hmacSha256(bytesOf(value, charset), bytesOf(key, charset)));
      },
      formatDate: formatDate,
      parseDate: parseDate,
      formatString: function (fmt) {
        var args = Array.prototype.slice.call(arguments, 1), i = 0;
        return String(fmt).replace(/%(\d+\$)?([-0]?\d*)(\.\d+)?([sdfi%])/g, function (m, pos, w, prec, t) {
          if (t === '%') return '%';
          var v = args[i++];
          if (t === 'd' || t === 'i') v = String(Math.trunc(Number(v)));
          else if (t === 'f') v = Number(v).toFixed(prec ? Number(prec.slice(1)) : 6);
          else v = String(v);
          var width = Number(String(w).replace(/[-0]/g, '')) || 0;
          while (v.length < width) v = String(w).charAt(0) === '-' ? v + ' ' : (String(w).charAt(0) === '0' ? '0' + v : ' ' + v);
          return v;
        });
      },
      parseCsv: parseCsv,
      sleep: function () {},
      jsonStringify: function (o) { return JSON.stringify(o); },
      jsonParse: function (s) { return JSON.parse(s); },
      zip: function () { throw gasError('미리보기 모의는 Utilities.zip 을 지원하지 않습니다'); },
      unzip: function () { throw gasError('미리보기 모의는 Utilities.unzip 을 지원하지 않습니다'); }
    };

    /* ---------- Session / Mail ---------- */

    var Session = {
      getActiveUser: function () { return { getEmail: function () { return opts.activeUserEmail || ''; } }; },
      getEffectiveUser: function () { return { getEmail: function () { return opts.effectiveUserEmail || ''; } }; },
      getScriptTimeZone: function () { return 'Asia/Seoul'; },
      getActiveUserLocale: function () { return 'ko'; },
      getTemporaryActiveUserKey: function () { return 'preview-user'; }
    };

    function mailDay() { return formatDate(new Date(nowMs()), 'Asia/Seoul', 'yyyy-MM-dd'); }
    function quotaLeft() {
      if (state.mail.day !== mailDay()) { state.mail.day = mailDay(); state.mail.count = 0; }
      return Math.max(0, MAIL_QUOTA - state.mail.count);
    }
    function sendMail(a, b, c, d) {
      var m;
      if (a && typeof a === 'object') m = a;
      else {
        m = d && typeof d === 'object' ? JSON.parse(JSON.stringify(d)) : {};
        m.to = a; m.subject = b; m.body = c;
      }
      var to = String(m.to || m.recipient || '').trim();
      if (!to) throw gasError('Failed to send email: no recipient');
      var all = [to, m.cc || '', m.bcc || ''].join(',').split(/[,;]/).map(function (x) { return x.trim(); }).filter(Boolean);
      all.forEach(function (addr) {
        var bare = /<([^>]+)>/.exec(addr);
        var e = bare ? bare[1] : addr;
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw gasError('Invalid email: ' + addr);
      });
      if (m.subject == null || String(m.subject) === '') warnOnce('nosubject', '제목 없는 메일을 보냈습니다');
      if (quotaLeft() <= 0) throw gasError('Service invoked too many times for one day: email.');
      state.mail.count++;
      var msg = {
        to: to, cc: m.cc || '', bcc: m.bcc || '', subject: String(m.subject == null ? '' : m.subject),
        body: m.body == null ? '' : String(m.body), htmlBody: m.htmlBody == null ? '' : String(m.htmlBody),
        name: m.name || '', replyTo: m.replyTo || '', noReply: !!m.noReply,
        attachments: (m.attachments || []).length, at: nowIso()
      };
      mock.sent.push(msg);
      state.mail.recent.push({ to: msg.to, subject: msg.subject, at: msg.at });
      if (state.mail.recent.length > 30) state.mail.recent.splice(0, state.mail.recent.length - 30);
      touch();
      out('info', ['[gas-mock] 메일 발송(모의) → ' + msg.to + ' : ' + msg.subject]);
      if (typeof opts.onMail === 'function') {
        try { opts.onMail(msg); } catch (e) { out('warn', ['[gas-mock] onMail 콜백 오류: ' + (e && e.message)]); }
      }
    }
    var MailApp = {
      sendEmail: function (a, b, c, d) { sendMail(a, b, c, d); },
      getRemainingDailyQuota: function () { return quotaLeft(); }
    };
    var GmailApp = {
      sendEmail: function (a, b, c, d) { sendMail(a, b, c, d); return GmailApp; }
    };

    /* ---------- ScriptApp ---------- */

    var WeekDay = { MONDAY: 'MONDAY', TUESDAY: 'TUESDAY', WEDNESDAY: 'WEDNESDAY', THURSDAY: 'THURSDAY', FRIDAY: 'FRIDAY', SATURDAY: 'SATURDAY', SUNDAY: 'SUNDAY' };
    function makeTrigger(t) {
      return {
        getUniqueId: function () { return t.id; },
        getHandlerFunction: function () { return t.handler; },
        getEventType: function () { return t.type || 'CLOCK'; },
        getTriggerSource: function () { return 'CLOCK'; },
        getTriggerSourceId: function () { return null; },
        toString: function () { return 'Trigger'; }
      };
    }
    function triggerBuilder(handler) {
      var spec = {};
      var clock = {};
      ['atHour', 'nearMinute', 'everyMinutes', 'everyHours', 'everyDays', 'everyWeeks', 'onWeekDay', 'onMonthDay', 'inTimezone', 'after', 'at', 'atDate'].forEach(function (m) {
        clock[m] = function (v) { spec[m] = isDate(v) ? v.toISOString() : v; return clock; };
      });
      clock.create = function () {
        if (state.triggers.length >= MAX_TRIGGERS) throw gasError('This script has too many triggers. Triggers must be deleted from the script before more can be added.');
        var t = { id: String(Math.floor(Math.random() * 9e15) + 1e15), handler: String(handler), type: 'CLOCK', spec: spec, created: nowIso() };
        state.triggers.push(t);
        touch();
        return makeTrigger(t);
      };
      var b = {
        timeBased: function () { return clock; },
        forSpreadsheet: function () { return { onEdit: function () { return clock; }, onChange: function () { return clock; }, onFormSubmit: function () { return clock; }, onOpen: function () { return clock; } }; }
      };
      return b;
    }
    var ScriptApp = {
      getService: function () {
        return {
          getUrl: function () {
            if (opts.serviceUrl) return opts.serviceUrl;
            if (typeof location !== 'undefined' && location && location.origin && location.origin !== 'null') return location.origin + location.pathname;
            return 'https://script.google.com/macros/s/PREVIEW/exec';
          },
          isEnabled: function () { return true; }
        };
      },
      newTrigger: function (fn) { return triggerBuilder(fn); },
      getProjectTriggers: function () { return state.triggers.map(makeTrigger); },
      getUserTriggers: function () { return state.triggers.map(makeTrigger); },
      deleteTrigger: function (t) {
        var id = t && typeof t.getUniqueId === 'function' ? t.getUniqueId() : null;
        state.triggers = state.triggers.filter(function (x) { return x.id !== id; });
        touch();
      },
      getOAuthToken: function () { return 'mock-token'; },
      getIdentityToken: function () { return ''; },
      getScriptId: function () { return 'PREVIEW'; },
      invalidateAuth: function () {},
      WeekDay: WeekDay,
      EventType: { CLOCK: 'CLOCK', ON_OPEN: 'ON_OPEN', ON_EDIT: 'ON_EDIT', ON_FORM_SUBMIT: 'ON_FORM_SUBMIT', ON_CHANGE: 'ON_CHANGE' },
      TriggerSource: { CLOCK: 'CLOCK', SPREADSHEETS: 'SPREADSHEETS' },
      AuthMode: { NONE: 'NONE', LIMITED: 'LIMITED', FULL: 'FULL' }
    };

    /* ---------- UrlFetch / Html / Content / Logger ---------- */

    /* 구글 시트 → xlsx 내보내기 URL 흉내: 모의 스프레드시트 내용으로 최소 xlsx(무압축 zip)를 만든다. */
    var CRC_TABLE = null;
    function crc32(u8) {
      if (!CRC_TABLE) {
        CRC_TABLE = [];
        for (var n = 0; n < 256; n++) {
          var c = n;
          for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
          CRC_TABLE[n] = c >>> 0;
        }
      }
      var crc = 0xffffffff;
      for (var i = 0; i < u8.length; i++) crc = CRC_TABLE[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
      return (crc ^ 0xffffffff) >>> 0;
    }
    function zipStore(entries) {
      var parts = [], central = [], offset = 0;
      function u16(a, v) { a.push(v & 0xff, (v >>> 8) & 0xff); }
      function u32(a, v) { a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); }
      entries.forEach(function (e) {
        var name = utf8Encode(e.name), data = utf8Encode(e.text), crc = crc32(data);
        var h = [];
        u32(h, 0x04034b50); u16(h, 20); u16(h, 0x0800); u16(h, 0); u16(h, 0); u16(h, 0x21);
        u32(h, crc); u32(h, data.length); u32(h, data.length); u16(h, name.length); u16(h, 0);
        var c = [];
        u32(c, 0x02014b50); u16(c, 20); u16(c, 20); u16(c, 0x0800); u16(c, 0); u16(c, 0); u16(c, 0x21);
        u32(c, crc); u32(c, data.length); u32(c, data.length); u16(c, name.length); u16(c, 0); u16(c, 0);
        u16(c, 0); u16(c, 0); u32(c, 0); u32(c, offset);
        parts.push(h, name, data);
        central.push(c, name);
        offset += h.length + name.length + data.length;
      });
      var cdSize = central.reduce(function (t, x) { return t + x.length; }, 0);
      var end = [];
      u32(end, 0x06054b50); u16(end, 0); u16(end, 0); u16(end, entries.length); u16(end, entries.length);
      u32(end, cdSize); u32(end, offset); u16(end, 0);
      var all = parts.concat(central, [end]);
      var total = all.reduce(function (t, x) { return t + x.length; }, 0);
      var out = new Uint8Array(total), p = 0;
      all.forEach(function (x) { for (var i = 0; i < x.length; i++) out[p++] = x[i]; });
      return out;
    }
    function xmlEsc(s) {
      return String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function colName(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
    function bookXlsx(book) {
      var sheets = book.sheets.filter(function (s) { return !s.deleted; });
      var files = [
        { name: '[Content_Types].xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
          '</Types>' },
        { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
        { name: 'xl/workbook.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
          sheets.map(function (s, i) { return '<sheet name="' + xmlEsc(String(s.name).slice(0, 31)) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') +
          '</sheets></workbook>' },
        { name: 'xl/_rels/workbook.xml.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
          '</Relationships>' }
      ];
      sheets.forEach(function (s, si) {
        var rows = (s.rows || []).map(function (row, ri) {
          var cells = (row || []).map(function (v, ci) {
            if (v === null || v === undefined || v === '') return '';
            var ref = colName(ci) + (ri + 1);
            if (typeof v === 'number' && isFinite(v)) return '<c r="' + ref + '"><v>' + v + '</v></c>';
            if (typeof v === 'boolean') return '<c r="' + ref + '" t="b"><v>' + (v ? 1 : 0) + '</v></c>';
            var str = isDate(v) ? formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss') : String(v);
            return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(str) + '</t></is></c>';
          }).join('');
          return '<row r="' + (ri + 1) + '">' + cells + '</row>';
        }).join('');
        files.push({ name: 'xl/worksheets/sheet' + (si + 1) + '.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + rows + '</sheetData></worksheet>' });
      });
      return zipStore(files);
    }
    function httpResponse(code, bytes, type, name) {
      var blob = makeBlob(bytes, type, name);
      return {
        getResponseCode: function () { return code; },
        getContent: function () { return blob.getBytes(); },
        getContentText: function () { return blob.getDataAsString(); },
        getBlob: function () { return blob; },
        getAs: function () { return blob; },
        getHeaders: function () { return { 'Content-Type': type }; },
        getAllHeaders: function () { return { 'Content-Type': type }; }
      };
    }
    function mockFetch(url, opts) {
      var m = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([^/?#]+)\/export\?(?:.*&)?format=xlsx\b/.exec(String(url || ''));
      if (m) {
        var book = state.books[m[1]];
        if (!book) {
          if (opts && opts.muteHttpExceptions) return httpResponse(404, utf8Encode('Not Found'), 'text/html', null);
          throw gasError('Request failed for https://docs.google.com returned code 404.');
        }
        return httpResponse(200, bookXlsx(book), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', (book.name || 'export') + '.xlsx');
      }
      throw gasError('미리보기에서는 외부 호출을 할 수 없습니다');
    }

    var UrlFetchApp = {
      fetch: mockFetch,
      fetchAll: function () { throw gasError('미리보기에서는 외부 호출을 할 수 없습니다'); },
      getRequest: function (url, o) { return { url: url, method: (o && o.method) || 'get', headers: (o && o.headers) || {}, payload: o && o.payload }; }
    };

    function makeHtmlOutput(content) {
      var st = { content: String(content == null ? '' : content), title: '', metas: [] };
      var h = {
        getContent: function () { return st.content; },
        setContent: function (c) { st.content = String(c); return h; },
        append: function (c) { st.content += String(c); return h; },
        appendUntrusted: function (c) { st.content += String(c).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); return h; },
        clear: function () { st.content = ''; return h; },
        setTitle: function (t) { st.title = String(t); return h; },
        getTitle: function () { return st.title; },
        addMetaTag: function (n, c) { st.metas.push({ name: n, content: c }); return h; },
        getMetaTags: function () { return st.metas.map(function (m) { return { getName: function () { return m.name; }, getContent: function () { return m.content; } }; }); },
        setXFrameOptionsMode: function () { return h; },
        setSandboxMode: function () { return h; },
        setFaviconUrl: function () { return h; },
        setWidth: function () { return h; },
        setHeight: function () { return h; },
        getBlob: function () { return makeBlob(utf8Encode(st.content), 'text/html', null); },
        getAs: function (t) { return makeBlob(utf8Encode(st.content), t, null); },
        asTemplate: function () { return makeTemplate('(asTemplate)', st.content); }
      };
      return h;
    }
    function fileContent(name) {
      name = String(name).replace(/\.html$/i, '');
      if (name === 'FormsData') {
        var f = opts.formsHtml;
        return typeof f === 'function' ? String(f() || '') : String(f || '');
      }
      if (opts.files && Object.prototype.hasOwnProperty.call(opts.files, name)) return String(opts.files[name]);
      if (htmlFiles && htmlFiles.indexOf(name) < 0) throw gasError('No HTML file named ' + name + ' was found.');
      return '';
    }
    function makeTemplate(name, raw) {
      var t = {};
      Object.defineProperty(t, 'evaluate', {
        enumerable: false,
        value: function () {
          var vars = {};
          Object.keys(t).forEach(function (k) { if (typeof t[k] !== 'function') vars[k] = t[k]; });
          var rec = { name: name, vars: vars, at: nowIso() };
          mock.lastTemplate = rec;
          mock.templates.push(rec);
          if (mock.templates.length > 20) mock.templates.shift();
          return makeHtmlOutput('');
        }
      });
      Object.defineProperty(t, 'getRawContent', { enumerable: false, value: function () { return raw || ''; } });
      Object.defineProperty(t, 'getCode', { enumerable: false, value: function () { return ''; } });
      return t;
    }
    var HtmlService = {
      createHtmlOutputFromFile: function (name) { return makeHtmlOutput(fileContent(name)); },
      createHtmlOutput: function (html) { return makeHtmlOutput(html && html.getDataAsString ? html.getDataAsString() : html); },
      createTemplateFromFile: function (name) { fileContent(name); return makeTemplate(String(name), ''); },
      createTemplate: function (html) { return makeTemplate('(inline)', String(html || '')); },
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
      SandboxMode: { IFRAME: 'IFRAME', NATIVE: 'NATIVE', EMULATED: 'EMULATED' }
    };

    var ContentService = {
      createTextOutput: function (s) {
        var st = { content: String(s == null ? '' : s), mime: 'TEXT' };
        var o = {
          getContent: function () { return st.content; },
          setContent: function (c) { st.content = String(c); return o; },
          append: function (c) { st.content += String(c); return o; },
          setMimeType: function (m) { st.mime = m; return o; },
          getMimeType: function () { return st.mime; },
          downloadAsFile: function () { return o; }
        };
        return o;
      },
      MimeType: { TEXT: 'TEXT', JSON: 'JSON', CSV: 'CSV', JAVASCRIPT: 'JAVASCRIPT', XML: 'XML', ICAL: 'ICAL' }
    };

    var MimeType = {
      GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet', GOOGLE_DOCS: 'application/vnd.google-apps.document',
      FOLDER: 'application/vnd.google-apps.folder', PDF: 'application/pdf', JSON: 'application/json', PLAIN_TEXT: 'text/plain',
      HTML: 'text/html', CSV: 'text/csv', JPEG: 'image/jpeg', PNG: 'image/png', GIF: 'image/gif', SVG: 'image/svg+xml',
      ZIP: 'application/zip', MICROSOFT_EXCEL: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      MICROSOFT_EXCEL_LEGACY: 'application/vnd.ms-excel', MICROSOFT_WORD: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    };

    function fmtLog(args) {
      var a = Array.prototype.slice.call(args);
      if (!a.length) return '';
      var first = a[0];
      if (typeof first === 'string' && a.length > 1 && /%s/.test(first)) {
        var i = 1;
        first = first.replace(/%s/g, function () { return i < a.length ? String(a[i++]) : '%s'; });
        return first + (i < a.length ? ' ' + a.slice(i).map(String).join(' ') : '');
      }
      return a.map(function (v) {
        if (typeof v === 'string') return v;
        try { return JSON.stringify(v); } catch (e) { return String(v); }
      }).join(' ');
    }
    var Logger = {
      log: function () {
        var s = fmtLog(arguments);
        mock.logs.push(s);
        if (mock.logs.length > 500) mock.logs.shift();
        out('log', ['[Logger] ' + s]);
        return Logger;
      },
      getLog: function () { return mock.logs.join('\n'); },
      clear: function () { mock.logs.length = 0; }
    };

    /* ---------- 조립 ---------- */

    var globals = {
      SpreadsheetApp: SpreadsheetApp,
      PropertiesService: PropertiesService,
      CacheService: CacheService,
      LockService: LockService,
      DriveApp: DriveApp,
      Utilities: Utilities,
      Session: Session,
      MailApp: MailApp,
      GmailApp: GmailApp,
      ScriptApp: ScriptApp,
      UrlFetchApp: UrlFetchApp,
      HtmlService: HtmlService,
      ContentService: ContentService,
      MimeType: MimeType,
      Logger: Logger
    };

    load();

    mock.globals = globals;
    Object.defineProperty(mock, 'state', { enumerable: true, get: function () { return state; } });
    mock.save = save;
    mock.isDirty = function () { return dirty; };
    mock.reload = function () {
      if (timer && timers) { timers.clear(timer); timer = null; }
      dirty = false;
      state = freshState();
      blobs = {};
      return load();
    };
    mock.reset = function () {
      if (timer && timers) { timers.clear(timer); timer = null; }
      state = freshState();
      blobs = {};
      dirty = false;
      if (storage) {
        try { if (typeof storage.removeItem === 'function') storage.removeItem(storageKey); else storage.setItem(storageKey, ''); } catch (e) { /* 무시 */ }
      }
    };
    /** DB 스프레드시트(속성 DB_ID, 없으면 첫 스프레드시트)의 표를 객체 배열로 — 시험·디버깅용 */
    mock.table = function (name, bookId) {
      var id = bookId || state.props.DB_ID || Object.keys(state.books)[0];
      var b = id && state.books[id];
      if (!b) return [];
      var sh = b.sheets.filter(function (s) { return s.name === name; })[0];
      if (!sh || !sh.rows.length) return [];
      var head = (sh.rows[0] || []).map(function (h) { return String(h == null ? '' : h); });
      var outRows = [];
      for (var r = 1; r < sh.rows.length; r++) {
        var row = sh.rows[r] || [];
        var empty = true;
        var o = {};
        for (var c = 0; c < head.length; c++) {
          if (!head[c]) continue;
          var v = row[c];
          if (v === null || v === undefined) v = '';
          if (v !== '') empty = false;
          o[head[c]] = v;
        }
        if (!empty) outRows.push(o);
      }
      return outRows;
    };
    mock.sheetNames = function (bookId) {
      var id = bookId || state.props.DB_ID || Object.keys(state.books)[0];
      var b = id && state.books[id];
      return b ? b.sheets.map(function (s) { return s.name; }) : [];
    };
    mock.storageSize = function () {
      try { var v = storage && storage.getItem(storageKey); return v ? v.length : 0; } catch (e) { return 0; }
    };
    mock.lockCount = function () { return locks; };
    mock.util = { sha256Hex: function (s) { return Array.prototype.map.call(sha256(bytesOf(s)), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(''); }, lzEncode: lzEncode, lzDecode: lzDecode, utf8Encode: utf8Encode, utf8Decode: utf8Decode, b64encode: b64encode, b64decode: b64decode };
    return mock;
  }

  return createGasMock;
});
