// NOL Scout — 座位页请求钩子（MAIN world，document_start）
// 目的：只读地"旁听"页面自己的请求，捕获两样东西：
//   1) 会话头 x-onestop-session / x-onestop-channel（NOL 不用 Cookie 传会话，全靠这个头）
//   2) 页面自身拉取的余票/座位响应（seatStatus / seatMeta / block-data / seats/grades / gql）
// 不修改、不阻断任何请求；不发起任何新请求。捕获结果通过 window.postMessage 交给隔离世界的脚本。

(() => {
  if (window.__nolScoutHooked) return;
  window.__nolScoutHooked = true;

  const TAG = 'nol-scout-hook';
  // 验证码两步也旁听：image = 关卡出现，verify = 交答案（只用来判"通过没通过"）
  const WATCH = ['/onestop/api/seatStatus', '/onestop/api/seatMeta', '/onestop/api/seats/block-data',
    '/onestop/api/seats/grades', '/onestop/gql', '/onestop/api/play/play-date',
    '/onestop/api/captcha/image', '/onestop/api/captcha/verify'];

  const post = (type, payload) => {
    try { window.postMessage({ __tag: TAG, type, payload }, location.origin); } catch (e) { /* noop */ }
  };

  // fetch 的 headers 可能是 Headers 实例 / 普通对象 / [[k,v]] 数组，统一处理
  const toLookup = (headers) => {
    if (!headers) return null;
    if (typeof headers.get === 'function') return (k) => headers.get(k);
    if (Array.isArray(headers)) {
      const m = new Map(headers.map((p) => [String(p[0]).toLowerCase(), p[1]]));
      return (k) => m.get(String(k).toLowerCase()) ?? null;
    }
    if (typeof headers === 'object') {
      const lower = {};
      for (const [k, v] of Object.entries(headers)) lower[String(k).toLowerCase()] = v;
      return (k) => lower[String(k).toLowerCase()] ?? null;
    }
    return null;
  };

  const captureSession = (headers) => {
    const read = toLookup(headers);
    if (!read) return;
    const session = read('x-onestop-session');
    const channel = read('x-onestop-channel');
    const lang = read('x-ticket-bff-language');
    if (session || channel) post('session', { session, channel, lang, href: location.href });
  };

  const looksWatched = (url) => typeof url === 'string' && WATCH.some((w) => url.includes(w));

  // ---- fetch ----
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const headers = (init && init.headers) || (input && input.headers) || null;
      captureSession(headers);
      const p = origFetch.apply(this, arguments);
      if (!looksWatched(url)) return p;
      return p.then((res) => {
        try {
          res.clone().text().then((text) => {
            post('api', { url, status: res.status, text: text.slice(0, 4_000_000) });
          }).catch(() => {});
        } catch (e) { /* noop */ }
        return res;
      });
    };
  }

  // ---- XMLHttpRequest ----
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    const setHeader = XHR.prototype.setRequestHeader;
    XHR.prototype.open = function (method, url) {
      this.__nsUrl = url;
      this.__nsHeaders = {};
      return open.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (k, v) {
      try { this.__nsHeaders[k.toLowerCase()] = v; } catch (e) { /* noop */ }
      if (/^x-onestop-|^x-ticket-bff-/.test(String(k).toLowerCase())) {
        captureSession({ [String(k).toLowerCase()]: v });
      }
      return setHeader.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      if (looksWatched(this.__nsUrl)) {
        this.addEventListener('load', () => {
          try {
            let text = '';
            if (this.responseType === '' || this.responseType === 'text') text = this.responseText || '';
            else if (this.responseType === 'json') text = JSON.stringify(this.response || null);
            post('api', { url: this.__nsUrl, status: this.status, text: String(text).slice(0, 4_000_000) });
          } catch (e) { /* noop */ }
        });
      }
      return send.apply(this, arguments);
    };
  }

  post('ready', { href: location.href });
})();
