// 内容脚本：NOL World 商品页解析
// 1) 从 RSC payload 中提取商品结构化数据，上报给后台（popup 建任务时自动填充）
// 2) 响应 popup 的 GET_PRODUCT 请求
// 注：content script 不能直接 import ES module，故这里复制了解析逻辑的精简版。

(() => {
  const PRODUCT_URL_RE = /\/ticket\/places\/(\d+)\/products\/(\d+)/;

  function unescapeRsc(html) {
    let out = '';
    for (let i = 0; i < html.length; i++) {
      const c = html[i];
      if (c === '\\' && i + 1 < html.length) {
        const n = html[i + 1];
        if (n === '"' || n === '\\') { out += n; i++; continue; }
        out += c + n; i++;
        continue;
      }
      out += c;
    }
    return out;
  }

  function extractBalancedJson(text, start) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') { i++; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return JSON.parse(text.slice(start, i + 1));
      }
    }
    throw new Error('JSON 未闭合');
  }

  function parseFromHtml(html) {
    const text = unescapeRsc(html);
    const keyIdx = text.indexOf('"ticketDetail":');
    if (keyIdx === -1) return null;
    const braceIdx = text.indexOf('{', keyIdx);
    const d = extractBalancedJson(text, braceIdx);
    const detail = d.detail || {};
    const fee = d.fee || {};
    return {
      goodsCode: d.goodsCode,
      placeCode: d.placeCode,
      name: d.goodsName,
      placeName: d.placeName,
      startDate: d.playStartDate,
      endDate: d.playEndDate,
      playTimeInfo: detail.playTimeInfo || '',
      bookingOpenTime: d.bookingOpenTime,
      bookingEndTime: d.bookingEndTime,
      goodsStatus: d.goodsStatus,
      prices: (d.price || []).map((p) => ({ grade: p.seatGradeName, price: p.salesPrice })),
    };
  }

  async function detect() {
    const m = location.pathname.match(PRODUCT_URL_RE);
    if (!m) return null;
    let product = null;
    try {
      product = parseFromHtml(document.documentElement.outerHTML);
    } catch (e) {
      product = null;
    }
    if (!product) {
      product = {
        goodsCode: m[2],
        placeCode: m[1],
        name: (document.title || '').split('|')[0].trim(),
      };
    }
    product.url = location.origin + location.pathname;
    chrome.runtime.sendMessage({ type: 'PRODUCT_DETECTED', product, url: product.url }).catch(() => {});
    return product;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'GET_PRODUCT') {
      detect()
        .then((p) => sendResponse({ product: p }))
        .catch((e) => sendResponse({ error: String(e.message || e) }));
      return true;
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', detect);
  } else {
    detect();
  }
})();
