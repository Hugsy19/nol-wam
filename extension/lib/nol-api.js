// NOL / Interpark "onestop" 购票接口客户端
// 全部接口来自真实抓包（tickets.interpark.com.har）：
//   · 抓包 A：goods=26012479 / place=26001057（全场售罄）——用于确定"0 = 无余票"
//   · 抓包 B：goods=26010474 / place=26000166 / playSeq=001（有票）——用于确定位级语义与坐标系
//
// 链路还原：
//   world.nol.com 商品页 → /gates/partner → reserve-gate（取 member-info 的 signature/secureData）
//   → ent-waiting-api 排队（secure-url → line-up → rank）→ tickets.interpark.com/onestop?key=...
//   → onestop/gql(getPlaySeqsForDate) → seats/grades → seats/block-data → seatMeta → seatStatus
//
// 鉴权：不使用 Cookie，会话靠请求头 x-onestop-session（= 排队 rank 返回的 sessionId）。
// 因此本模块只能在 tickets.interpark.com 的页面上下文（内容脚本）里调用，
// 由页面自己携带的会话与同源策略保证请求合法。
//
// 坐标系：seatMeta 的 posLeft/posTop 与 block-data 的 absoluteLeft/Top 同属一张画布，
//         画布尺寸等于座位图 SVG 的 viewBox（实测 0 0 316 305）。据此可把座位精确画到屏幕上。

export const ONESTOP_ORIGIN = 'https://tickets.interpark.com';
export const BFF = ONESTOP_ORIGIN + '/onestop/api';
export const GQL_ENDPOINT = ONESTOP_ORIGIN + '/onestop/gql';
export const SERVER_TIME_ENDPOINT = 'https://api-ticketfront.interpark.com/v1/getServerTime?type=1&nc=';

// 抓包中出现的固定值（channel 会随入口变化，优先用钩子捕获到的真实值）
export const DEFAULT_CTX = { channel: 'TRIPLE_KOREA', session: '', lang: 'EN', traceId: '' };

// 服务端限制：seatMeta 一次最多约 2 个区块（单块 30~130KB），seatStatus 一次可达 16 块（极小）
export const SEATMETA_CHUNK = 2;
export const SEATSTATUS_CHUNK = 16;

// ---------------- 基础请求 ----------------

function bffHeaders(ctx) {
  const h = {
    accept: 'application/json, text/plain, */*',
    'x-onestop-channel': ctx.channel || DEFAULT_CTX.channel,
    'x-onestop-session': ctx.session || '',
    'x-onestop-trace-id': ctx.traceId || randTraceId(),
    'x-ticket-bff-language': ctx.lang || DEFAULT_CTX.lang,
    'x-requested-with': 'XMLHttpRequest',
  };
  if (!h['x-onestop-session']) delete h['x-onestop-session'];
  return h;
}

export function randTraceId() {
  const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 15; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

async function bffGet(path, params, ctx, { signal, timeoutMs = 12000 } = {}) {
  const url = new URL(BFF + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: bffHeaders(ctx),
    credentials: 'include',
    cache: 'no-store',
    signal: withTimeout(signal, timeoutMs),
  });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

async function gql(query, variables, operationName, ctx, opts = {}) {
  const body = JSON.stringify({ query, variables: variables ?? {}, operationName });
  const res = await fetch(GQL_ENDPOINT, {
    method: 'POST',
    headers: { ...bffHeaders(ctx), 'content-type': 'application/json' },
    credentials: 'include',
    cache: 'no-store',
    body,
    signal: withTimeout(opts.signal, opts.timeoutMs || 12000),
  });
  if (!res.ok) throw new Error(`POST gql/${operationName} -> HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`gql/${operationName}: ${json.errors[0].message}`);
  return json.data;
}

function withTimeout(signal, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  timer.unref?.();
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  }
  ctrl.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return ctrl.signal;
}

// ---------------- 服务器时间（精确到毫秒，无需会话） ----------------

// 返回 { serverMs, t0, t1, rttMs }；serverMs 已按 RTT/2 校正
export async function getServerTime() {
  const t0 = Date.now();
  const res = await fetch(SERVER_TIME_ENDPOINT + t0 + '&_=' + t0, {
    cache: 'no-store',
    credentials: 'omit',
  });
  const t1 = Date.now();
  const text = (await res.text()).trim();
  const ms = Number(text);
  if (!Number.isFinite(ms)) throw new Error('getServerTime 返回非法: ' + text.slice(0, 40));
  const rttMs = t1 - t0;
  return { serverMs: ms + Math.round(rttMs / 2), t0, t1, rttMs };
}

// ---------------- 场次 / 档位余票 ----------------

const Q_PLAY_SEQS = `query GetPlaySeqsForDate($playDate: String!) {
  getPlaySeqsForDate(playDate: $playDate) {
    playDate
    playSeq
    playTime
    noOfTime
    isSeatRemain
    isRemainSeatVisible
    showCasting
    onlineDepositEndTime
    onlineAccountLimitStartDate
    onlineAccountLimitEndDate
    onlineAccountYn
    seats { seatGrade seatGradeName salesPrice remainCount seatExternalType isSacToday isVisibleSeatCount }
    bookWait
    bookWaitStartDate
    bookWaitMaxDate
    bookWaitStatus
    onlineDate
    cancelableDate
    cancelableEndDate
    bookingEndDate
  }
}`;

// playDate: 'YYYYMMDD'
export async function getPlaySeqs(playDate, ctx, opts) {
  const data = await gql(Q_PLAY_SEQS, { playDate }, 'GetPlaySeqsForDate', ctx, opts);
  const list = data?.getPlaySeqsForDate || [];
  return list.map((s) => ({
    playDate: s.playDate,
    playSeq: s.playSeq,
    playTime: s.playTime,
    isSeatRemain: !!s.isSeatRemain,
    isRemainSeatVisible: !!s.isRemainSeatVisible,
    bookingEndDate: s.bookingEndDate,
    grades: (s.seats || []).map((g) => ({
      grade: g.seatGrade,
      name: g.seatGradeName,
      price: g.salesPrice,
      remainCount: g.remainCount,
    })),
    remainTotal: (s.seats || []).reduce((n, g) => n + (g.remainCount || 0), 0),
  }));
}

const Q_GRADE_PRICES = `query GetSeatGradePrices($input: GetRemainSeatSortInput) {
  getSeatGradePrices(input: $input) { seatGrade seatGradeName seatColor salePrice isNonReservedSeat }
}`;

export async function getGradePrices({ playSeq }, ctx, opts) {
  const data = await gql(Q_GRADE_PRICES, { input: { sort: 'SEAT_GRADE_ASC', playSeq } }, 'GetSeatGradePrices', ctx, opts);
  return data?.getSeatGradePrices || [];
}

// REST 版档位余票（返回 remainCount + 颜色），与 gql 互为校验
export async function getSeatGrades({ goodsCode, placeCode, playSeq, bizCode }, ctx, opts) {
  return bffGet('/seats/grades', { goodsCode, placeCode, playSeq, bizCode }, ctx, opts);
}

// ---------------- 区块几何 / 座位元数据 / 座位状态 ----------------

// 单场次全部区块的绝对坐标（用于自绘座位图）
export async function getBlockData({ goodsCode, placeCode, playSeq }, ctx, opts) {
  return bffGet('/seats/block-data', { goodsCode, placeCode, playSeq }, ctx, opts);
}

// 座位级元数据：seatInfoId / 价位 / 排号 / 行列索引 / 坐标
// blockKeys: ['003:001', ...]，按 SEATMETA_CHUNK 自动分块
export async function getSeatMeta({ goodsCode, placeCode, playSeq, bizCode }, blockKeys, ctx, opts = {}) {
  const out = [];
  for (const chunk of chunkArray(blockKeys, opts.chunkSize || SEATMETA_CHUNK)) {
    const json = await bffGet('/seatMeta', { goodsCode, placeCode, playSeq, blockKeys: chunk, bizCode }, ctx, opts);
    out.push(...(json?.data || []));
    if (opts.gapMs) await sleep(opts.gapMs);
  }
  return out;
}

// 座位状态：data[i] 对应 blockKeys[i]，字符串长度 = ceil(该区块座位数 / 4)
// 抓包实测：全场售罄时所有字符均为 '0'，故 '0' = 该组无余票；非 '0' = 该组有余票。
export async function getSeatStatus({ goodsCode, placeCode, playSeq, bizCode }, blockKeys, ctx, opts = {}) {
  const map = {};
  for (const chunk of chunkArray(blockKeys, opts.chunkSize || SEATSTATUS_CHUNK)) {
    const json = await bffGet('/seatStatus', { goodsCode, placeCode, playSeq, blockKeys: chunk, bizCode }, ctx, opts);
    const arr = json?.data || [];
    chunk.forEach((k, i) => { map[k] = arr[i] ?? ''; });
    if (opts.gapMs) await sleep(opts.gapMs);
  }
  return map;
}

// ---------------- 会话是否过期（选座 10 分钟时限的服务端权威开关） ----------------
//
// 页面自己就在轮询这条 query（抓包中出现 4 次，间隔约 5s）：
//   query ExpiredSession { isExpiredSession }  →  {"data":{"isExpiredSession":false}}
// 我们平时靠钩子被动旁听它；只有在"本地钟已归零但需要复核"时才主动问一次。
export const Q_EXPIRED_SESSION = `
  query ExpiredSession {
    isExpiredSession
  }
`;

export async function getExpiredSession(ctx, opts) {
  const data = await gql(Q_EXPIRED_SESSION, {}, 'ExpiredSession', ctx, opts);
  return data?.isExpiredSession === true;
}

// ---------------- 状态串解码（位级，已双向验证） ----------------
//
// 格式：seatStatus.data[i] 对应请求中第 i 个 blockKeys；字符串长度 = ceil(该区块座位数 / 4)。
//       每个字符是一个十六进制数，4 个二进制位对应 4 个连续座位。
//
// 位序与语义（用第二份抓包 goods=26010474 / place=26000166 / playSeq=001 验证）：
//   · 座位序 = seatMeta 返回数组的下标（seatInfoId 升序），不是栅格坐标序
//   · 第 i 个座位 → 字符 i>>2，取该字符的第 (i&3) 个位，**MSB 优先**（bit3 是该字符第 1 个座位）
//   · 1 = 可购（有余票）；0 = 不可购（已售 / 被占 / 不可售）
//
// 证据链：
//   [1] 8/8 区块满足 len(status) === ceil(seatMeta 座位数 / 4)
//   [2] 轮询 07:29:52.438 时 block 001:001 的第 48 个字符由 '8'(0b1000) 变为 '0'，
//       紧接着 07:29:55 就发出了 seats/select；被锁定的 seatInfoId 末位 194
//       在 seatMeta 数组中下标恰为 192 → 字符 48、位 (192&3)=0 → MSB 位 3
//       '8' 的 bit3 = 1（可购）→ 变 '0' 后 bit3 = 0（已占），四条假设里唯一自洽的一组
//   [3] 售罄场次（goods=26012479）全部 34821 个字符都是 '0'
//   [4] 有票场次中「档位置位数」与 grades/prices 接口返回的 remainCount 吻合
//       （Assigned Seat 置位 43 = remainCount 43）
//
// 推论：只要拿到 seatStatus 就能确定**具体哪些座位**有票，不只是"哪个区块"。

export const SEATS_PER_CHAR = 4;
export const FREE_CHAR = '0';

function hexVal(ch) {
  const v = ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48
    : ch >= 'a' && ch <= 'f' ? ch.charCodeAt(0) - 87
      : ch >= 'A' && ch <= 'F' ? ch.charCodeAt(0) - 55 : -1;
  return v;
}

/**
 * 把状态串解码成逐座位的是否可购数组
 * @param {string} statusStr
 * @param {number} seatCount 该区块的座位总数（= seatMeta 数组长度）
 * @returns {Uint8Array} out[i] = 1 可购 / 0 不可购
 */
export function decodeBlockStatus(statusStr, seatCount) {
  const n = Math.max(0, seatCount | 0);
  const out = new Uint8Array(n);
  if (!statusStr) return out;
  for (let i = 0; i < n; i++) {
    const ch = statusStr[i >> 2];
    if (ch === undefined) break;
    const v = hexVal(ch);
    if (v < 0) continue;
    out[i] = (v >> (3 - (i & 3))) & 1;
  }
  return out;
}

// 单个座位的可购判定（避免整块解码的开销）
export function isFreeAt(statusStr, pos) {
  const ch = (statusStr || '')[(pos >> 2)];
  if (ch === undefined) return false;
  const v = hexVal(ch);
  if (v < 0) return false;
  return ((v >> (3 - (pos & 3))) & 1) === 1;
}

// 该区块的可购座位下标列表
export function freeSeatIndexes(statusStr, seatCount) {
  const flags = decodeBlockStatus(statusStr, seatCount);
  const out = [];
  for (let i = 0; i < flags.length; i++) if (flags[i]) out.push(i);
  return out;
}

// 该区块的可购座位数（精确）
export function freeSeatCount(statusStr, seatCount) {
  const flags = decodeBlockStatus(statusStr, seatCount);
  let n = 0;
  for (let i = 0; i < flags.length; i++) n += flags[i];
  return n;
}

// 兼容旧调用：非 '0' 的"组"（每字符 4 座）——粗粒度视图，仅用于快速跳读
export function freeGroupIndexes(statusStr) {
  const out = [];
  for (let i = 0; i < (statusStr || '').length; i++) if (statusStr[i] !== FREE_CHAR) out.push(i);
  return out;
}

// 两张状态串快照的差异：返回新出现的可购座位下标
export function diffNewFreeSeats(prevStr, nextStr, seatCount) {
  const a = decodeBlockStatus(prevStr, seatCount);
  const b = decodeBlockStatus(nextStr, seatCount);
  const out = [];
  for (let i = 0; i < b.length; i++) if (b[i] && !a[i]) out.push(i);
  return out;
}

// ---------------- 工具 ----------------

export function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function jitter(ms, ratio = 0.15) {
  return Math.round(ms * (1 - ratio + Math.random() * ratio * 2));
}
