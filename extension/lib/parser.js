// NOL World 商品页解析器
// 原理：world.nol.com 是 Next.js 站点，商品结构化数据不在可见 DOM 里，
// 而是序列化在页面底部的 self.__next_f.push(...) RSC payload 中（转义过的 JSON）。
// 思路：把 \" 反转义回 "，再按括号配对截取 "ticketDetail":{...} 并 JSON.parse。

// RSC payload 在 HTML 里被转义了一层：\" 是分隔符引号，\\\" 是字符串内部的引号。
// 这里做"精确去一层转义"：\" -> "，\\ -> \，其余 \x 原样保留（交给 JSON.parse 处理）。
export function unescapeRsc(html) {
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

// 从 start（指向 '{' 或 '['）开始做括号配对，返回解析出的对象
export function extractBalancedJson(text, start) {
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
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }
  throw new Error('JSON 未闭合（页面结构可能变化）');
}

// KST 时间字符串 "2026-09-11 20:00:00" -> epoch ms
export function parseKst(s) {
  if (!s) return null;
  const iso = s.trim().replace(' ', 'T');
  const t = Date.parse(iso.length === 19 ? iso + '+09:00' : iso);
  return Number.isNaN(t) ? null : t;
}

// 输入商品页 HTML，返回归一化后的商品对象；解析失败返回 null
export function parseProduct(html) {
  const text = unescapeRsc(html);
  const keyIdx = text.indexOf('"ticketDetail":');
  if (keyIdx === -1) return null;
  const braceIdx = text.indexOf('{', keyIdx);
  if (braceIdx === -1) return null;
  let d;
  try {
    d = extractBalancedJson(text, braceIdx);
  } catch (e) {
    throw new Error('ticketDetail 解析失败: ' + e.message);
  }
  return normalize(d);
}

function normalize(d) {
  const detail = d.detail || {};
  const fee = d.fee || {};
  return {
    goodsCode: d.goodsCode,
    placeCode: d.placeCode,
    goodsKey: d.goodsKey,
    name: d.goodsName,
    placeName: d.placeName,
    genre: d.genreName,
    ageLimit: d.viewRateName,
    runningTimeMin: Number(d.runningTime) || null,
    startDate: d.playStartDate,
    endDate: d.playEndDate,
    playTimeInfo: detail.playTimeInfo || '',
    // 以下时间均为 KST 字符串
    bookingOpenTime: d.bookingOpenTime,
    bookingEndTime: d.bookingEndTime,
    cancelableTimeName: detail.cancelableTimeName || '',
    goodsStatus: d.goodsStatus,
    useMobileTicket: !!d.useMobileTicket,
    deliveryMethodName: detail.deliveryMethodName || '',
    notice: detail.noticeInfo || '',
    prices: (d.price || []).map((p) => ({
      grade: p.seatGradeName,
      price: p.salesPrice,
      currency: 'KRW',
    })),
    bookingFee: (fee.bookingFee || [])[0]?.feeValue ?? null,
    deliveryFee: fee.deliveryFee ?? null,
    cancellationFee: (fee.cancellationFee || []).map((c) => ({
      type: c.feeType,
      baseDay: c.baseDay,
      value: c.feeValue,
    })),
  };
}
