// ⚠️ 本文件由 tools/build.mjs 自动生成，请勿直接修改。
// 源文件：lib/nol-api.js + lib/seat-engine.js + lib/locator.js + lib/seat-prefs.js + lib/session-timer.js + lib/panel-pos.js + lib/captcha.js + lib/automation.js + lib/captcha-dom.js + content/onestop-seat.js
// 生成时间：2026-10-06T14:29:41.117Z
(() => {
'use strict';
// ===== lib/nol-api.js =====
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

const ONESTOP_ORIGIN = 'https://tickets.interpark.com';
const BFF = ONESTOP_ORIGIN + '/onestop/api';
const GQL_ENDPOINT = ONESTOP_ORIGIN + '/onestop/gql';
const SERVER_TIME_ENDPOINT = 'https://api-ticketfront.interpark.com/v1/getServerTime?type=1&nc=';

// 抓包中出现的固定值（channel 会随入口变化，优先用钩子捕获到的真实值）
const DEFAULT_CTX = { channel: 'TRIPLE_KOREA', session: '', lang: 'EN', traceId: '' };

// 服务端限制：seatMeta 一次最多约 2 个区块（单块 30~130KB），seatStatus 一次可达 16 块（极小）
const SEATMETA_CHUNK = 2;
const SEATSTATUS_CHUNK = 16;

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

function randTraceId() {
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
async function getServerTime() {
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
async function getPlaySeqs(playDate, ctx, opts) {
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

async function getGradePrices({ playSeq }, ctx, opts) {
  const data = await gql(Q_GRADE_PRICES, { input: { sort: 'SEAT_GRADE_ASC', playSeq } }, 'GetSeatGradePrices', ctx, opts);
  return data?.getSeatGradePrices || [];
}

// REST 版档位余票（返回 remainCount + 颜色），与 gql 互为校验
async function getSeatGrades({ goodsCode, placeCode, playSeq, bizCode }, ctx, opts) {
  return bffGet('/seats/grades', { goodsCode, placeCode, playSeq, bizCode }, ctx, opts);
}

// ---------------- 区块几何 / 座位元数据 / 座位状态 ----------------

// 单场次全部区块的绝对坐标（用于自绘座位图）
async function getBlockData({ goodsCode, placeCode, playSeq }, ctx, opts) {
  return bffGet('/seats/block-data', { goodsCode, placeCode, playSeq }, ctx, opts);
}

// 座位级元数据：seatInfoId / 价位 / 排号 / 行列索引 / 坐标
// blockKeys: ['003:001', ...]，按 SEATMETA_CHUNK 自动分块
async function getSeatMeta({ goodsCode, placeCode, playSeq, bizCode }, blockKeys, ctx, opts = {}) {
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
async function getSeatStatus({ goodsCode, placeCode, playSeq, bizCode }, blockKeys, ctx, opts = {}) {
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
const Q_EXPIRED_SESSION = `
  query ExpiredSession {
    isExpiredSession
  }
`;

async function getExpiredSession(ctx, opts) {
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

const SEATS_PER_CHAR = 4;
const FREE_CHAR = '0';

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
function decodeBlockStatus(statusStr, seatCount) {
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
function isFreeAt(statusStr, pos) {
  const ch = (statusStr || '')[(pos >> 2)];
  if (ch === undefined) return false;
  const v = hexVal(ch);
  if (v < 0) return false;
  return ((v >> (3 - (pos & 3))) & 1) === 1;
}

// 该区块的可购座位下标列表
function freeSeatIndexes(statusStr, seatCount) {
  const flags = decodeBlockStatus(statusStr, seatCount);
  const out = [];
  for (let i = 0; i < flags.length; i++) if (flags[i]) out.push(i);
  return out;
}

// 该区块的可购座位数（精确）
function freeSeatCount(statusStr, seatCount) {
  const flags = decodeBlockStatus(statusStr, seatCount);
  let n = 0;
  for (let i = 0; i < flags.length; i++) n += flags[i];
  return n;
}

// 兼容旧调用：非 '0' 的"组"（每字符 4 座）——粗粒度视图，仅用于快速跳读
function freeGroupIndexes(statusStr) {
  const out = [];
  for (let i = 0; i < (statusStr || '').length; i++) if (statusStr[i] !== FREE_CHAR) out.push(i);
  return out;
}

// 两张状态串快照的差异：返回新出现的可购座位下标
function diffNewFreeSeats(prevStr, nextStr, seatCount) {
  const a = decodeBlockStatus(prevStr, seatCount);
  const b = decodeBlockStatus(nextStr, seatCount);
  const out = [];
  for (let i = 0; i < b.length; i++) if (b[i] && !a[i]) out.push(i);
  return out;
}

// ---------------- 工具 ----------------

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms, ratio = 0.15) {
  return Math.round(ms * (1 - ratio + Math.random() * ratio * 2));
}


// ===== lib/seat-engine.js =====
// 座位目录与命中匹配引擎（v0.3 —— 座位级精确匹配）
//
// 输入：/onestop/api/seats/block-data（区块几何）+ /onestop/api/seatMeta（座位明细）
//      + /onestop/api/seats/grades（价位配色与余票）+ seatStatus（逐座位可购位图）
// 输出：区块 → 区域 → 价位 → 座位 的完整目录；以及"命中到具体哪几个座位"的精确结果。
//
// 与 v0.2 的关键差别：
//   · 旧版只知道"某个 4 座组里有票"，因此连座数只能给 1~4 的上下界
//   · 新版解码到单个座位，并按**真实几何**（posLeft/posTop）做连座归并，
//     所以能直接给出「A구역 입장번호 第 204 号」这种可下单级别的坐标

// ---------------- 文本解析 ----------------

// 从排号里抽区域名。实测 rowNo 形如 "A구역 입장번호" / "E구역 10열" / "10열"
function regionFromRowNo(rowNo) {
  if (!rowNo) return '';
  const m = String(rowNo).match(/(\d+\s*구역)/);
  if (m) return m[1].replace(/\s+/g, '');
  const m2 = String(rowNo).match(/^([A-Za-z]+\s*구역)/);
  if (m2) return m2[1].replace(/\s+/g, '');
  return '';
}

// 从排号里抽排号，如 "E구역 10열" -> "10열"
function rowLabelFromRowNo(rowNo) {
  if (!rowNo) return '';
  const m = String(rowNo).match(/(\d+\s*열)/);
  if (m) return m[1].replace(/\s+/g, '');
  return '';
}

// 区块的"区域"归属：优先 구역 名，其次楼层，最后退回区块号
function blockRegionOf(seats, blockCode) {
  const votes = {};
  for (const s of seats) {
    const r = regionFromRowNo(s.rowNo);
    if (r) votes[r] = (votes[r] || 0) + 1;
  }
  const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  if (top) return top[0];
  const floors = {};
  for (const s of seats) if (s.floor) floors[s.floor] = (floors[s.floor] || 0) + 1;
  const f = Object.entries(floors).sort((a, b) => b[1] - a[1])[0];
  if (f) return f[0];
  return blockCode ? blockCode + '구역' : '';
}

/**
 * 构建座位目录（任务启动时跑一次并缓存到内容脚本内存）
 * @param {object} args
 * @param {Array}  args.blockData   getBlockData 的返回
 * @param {Array}  args.seatMeta    getSeatMeta 的返回（[{blockKey, seats:[]}]）
 * @param {Array}  args.gradeColors getGradePrices / getSeatGrades 的返回（含颜色与价格）
 */
function buildCatalog({ blockData = [], seatMeta = [], gradeColors = [] }) {
  // 注意：档位必须按 seatGrade 号码对齐——seatMeta 返回的是韩文名（스탠딩 / 지정석），
  // 而 seats/grades、GetSeatGradePrices 在英文界面下返回英文名（STANDING / Assigned Seat），
  // 用名字做键会全部对不上。
  const colorByGrade = {};
  const priceByGrade = {};
  const nameByGrade = {};
  for (const g of gradeColors) {
    const no = String(g.seatGrade ?? '');
    const name = g.seatGradeName || g.name || '';
    if (!no) continue;
    colorByGrade[no] = g.seatColor || g.salesColor || null;
    priceByGrade[no] = g.salePrice ?? g.salesPrice ?? null;
    if (name) nameByGrade[no] = name;
  }

  // 注意：这里**必须保持 seatMeta 的原始顺序**——seatStatus 的位序就是这个数组的下标
  const seatsByBlock = new Map();
  for (const blk of seatMeta) {
    const arr = seatsByBlock.get(blk.blockKey) || [];
    for (const s of blk.seats || []) {
      arr.push({
        idx: arr.length,                        // 区块内的状态位下标
        id: s.seatInfoId,
        grade: String(s.seatGrade ?? ''),
        gradeName: s.seatGradeName || null,
        price: s.salesPrice ?? null,
        floor: s.floor || '',
        rowNo: s.rowNo || '',
        seatNo: s.seatNo || '',
        rowIdx: s.rowIdx ?? 0,
        colIdx: s.colIdx ?? 0,
        x: s.posLeft ?? 0,
        y: s.posTop ?? 0,
        exposable: !!s.isExposable,
      });
    }
    seatsByBlock.set(blk.blockKey, arr);
  }

  const blocks = [];
  for (const b of blockData) {
    const seats = seatsByBlock.get(b.blockKey) || [];
    const gradeCounts = {};
    for (const s of seats) {
      const g = s.gradeName || '(未分级)';
      gradeCounts[g] = (gradeCounts[g] || 0) + 1;
    }
    const gradeNos = [...new Set(seats.map((s) => s.grade).filter(Boolean))];
    const box = {
      x: b.absoluteLeft,
      y: b.absoluteTop,
      w: b.absoluteRight - b.absoluteLeft,
      h: b.absoluteBottom - b.absoluteTop,
    };
    const exposableCount = seats.filter((s) => s.exposable).length;
    blocks.push({
      key: b.blockKey,
      code: b.selfDefineBlock,
      region: blockRegionOf(seats, b.selfDefineBlock),
      box,
      seatCount: seats.length,
      exposableCount,
      gradeCounts,
      gradeNos,
      seats,
      rows: groupRows(seats),
      center: { x: box.x + box.w / 2, y: box.y + box.h / 2 },
    });
  }

  const regions = [];
  const regionMap = new Map();
  for (const b of blocks) {
    // 只有含"可见座位"的区块才算一个真实区域（결제용 之类虚拟区块不参与）
    if (!b.region || !b.exposableCount) continue;
    let r = regionMap.get(b.region);
    if (!r) {
      r = { name: b.region, blockKeys: [], seatCount: 0, gradeCounts: {} };
      regionMap.set(b.region, r);
      regions.push(r);
    }
    r.blockKeys.push(b.key);
    r.seatCount += b.exposableCount;
    for (const [g, n] of Object.entries(b.gradeCounts)) {
      if (g === '(未分级)') continue;
      r.gradeCounts[g] = (r.gradeCounts[g] || 0) + n;
    }
  }
  regions.sort((a, b) => a.name.localeCompare(b.name, 'ko'));

  const grades = [];
  const gradeMap = new Map();
  for (const b of blocks) {
    for (const s of b.seats) {
      if (!s.grade || !s.exposable) continue;
      let g = gradeMap.get(s.grade);
      if (!g) {
        g = {
          grade: s.grade,
          name: s.gradeName || nameByGrade[s.grade] || `档位 ${s.grade}`,
          blocks: [],
          seatCount: 0,
          price: priceByGrade[s.grade] ?? s.price ?? null,
          color: colorByGrade[s.grade] || null,
        };
        gradeMap.set(s.grade, g);
        grades.push(g);
      }
      g.seatCount++;
      if (!g.blocks.includes(b.key)) g.blocks.push(b.key);
    }
  }
  grades.sort((a, b) => (b.price || 0) - (a.price || 0));

  const exposable = blocks.flatMap((b) => b.seats.filter((s) => s.exposable));
  const pool = exposable.length ? exposable : blocks.flatMap((b) => b.seats);
  const canvas = pool.length
    ? {
        minX: Math.min(...pool.map((s) => s.x)),
        minY: Math.min(...pool.map((s) => s.y)),
        maxX: Math.max(...pool.map((s) => s.x)),
        maxY: Math.max(...pool.map((s) => s.y)),
      }
    : { minX: 0, minY: 0, maxX: 1, maxY: 1 };

  return { blocks, regions, grades, canvas, builtAt: Date.now() };
}

// 区块内按 rowIdx 分行，行内按 x 排序，并估算座距（用于连座判定）
function groupRows(seats) {
  const byRow = new Map();
  for (const s of seats) {
    const arr = byRow.get(s.rowIdx) || [];
    arr.push(s);
    byRow.set(s.rowIdx, arr);
  }
  const rows = [];
  for (const [rowIdx, arr] of byRow) {
    arr.sort((a, b) => a.x - b.x || a.colIdx - b.colIdx);
    const gaps = [];
    for (let i = 1; i < arr.length; i++) {
      const d = arr[i].x - arr[i - 1].x;
      if (d > 0.01) gaps.push(d);
    }
    gaps.sort((a, b) => a - b);
    const spacing = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 3;
    rows.push({ rowIdx, seats: arr, spacing });
  }
  rows.sort((a, b) => a.rowIdx - b.rowIdx);
  return rows;
}

// ---------------- 位置评分 ----------------

// 舞台参考点：NOL 场馆图惯例把舞台画在图的上方（본 抓包 SVG 中舞台位于 y 小的一侧）
function stageRef(canvas, stageSide = 'top') {
  const cx = (canvas.minX + canvas.maxX) / 2;
  const cy = (canvas.minY + canvas.maxY) / 2;
  switch (stageSide) {
    case 'bottom': return { x: cx, y: canvas.maxY };
    case 'left': return { x: canvas.minX, y: cy };
    case 'right': return { x: canvas.maxX, y: cy };
    case 'top':
    default: return { x: cx, y: canvas.minY };
  }
}

// 单张票的打分：越小越好
function scoreSeat(seat, { preference = 'any', stage, stageSide = 'top' } = {}) {
  if (!stage || preference === 'any') return Math.hypot(seat.x - (stage?.x ?? seat.x), seat.y - (stage?.y ?? seat.y));
  const depth = (stageSide === 'top' || stageSide === 'bottom')
    ? Math.abs(seat.y - stage.y)
    : Math.abs(seat.x - stage.x);
  const lateral = Math.abs(seat.x - stage.x);
  switch (preference) {
    case 'front': return depth * 2 + lateral * 0.2;
    case 'center': return lateral * 2 + depth * 0.2;
    case 'left': return (seat.x - stage.x) * -1 + depth * 0.2;
    case 'right': return (seat.x - stage.x) + depth * 0.2;
    default: return depth + lateral * 0.2;
  }
}

// ---------------- 命中判定（座位级） ----------------

/**
 * 用一份 seatStatus 快照跑一次精确匹配
 * @param {object} task  { grades:[价位名], regions:[区域名], quantity, preference, stageSide, exposableOnly }
 * @param {object} catalog buildCatalog 的结果
 * @param {object} statusByBlock { '001:001': '0000…' } 状态串
 * @param {object} [prevByBlock] 上一轮快照，用于标记"新出现"的座位
 * @returns {{hit, runs, best, freeSeats, blocksWithFree, seats, message}}
 */
function matchSnapshot(task, catalog, statusByBlock, prevByBlock = null) {
  const wantGrades = new Set(task.grades || []);
  const wantRegions = new Set(task.regions || []);
  const quantity = Math.max(1, task.quantity || 1);
  const exposableOnly = task.exposableOnly !== false;
  const stage = stageRef(catalog.canvas, task.stageSide || 'top');

  const runs = [];
  const newSeats = [];
  let freeSeats = 0;
  let totalSeats = 0;
  const blocksWithFree = new Set();
  const perBlock = {};

  for (const block of catalog.blocks) {
    const str = statusByBlock[block.key];
    if (!str) continue;

    // 档位过滤接受「档位号」或「档位名」，两种写法都能匹配上
    const hasGrade = (g, n) => !wantGrades.size || wantGrades.has(g) || (n && wantGrades.has(n));
    const inScopeGrade = !wantGrades.size || block.gradeNos.some((g) => wantGrades.has(g))
      || Object.keys(block.gradeCounts).some((n) => wantGrades.has(n));
    const inScopeRegion = !wantRegions.size || wantRegions.has(block.region);

    const flags = decodeBlockStatus(str, block.seatCount);
    let blockFree = 0;

    for (const row of block.rows) {
      let cur = null;
      for (const seat of row.seats) {
        const free = flags[seat.idx] === 1;
        const usable = free && (!exposableOnly || seat.exposable) && hasGrade(seat.grade, seat.gradeName);

        if (!usable || !inScopeGrade || !inScopeRegion) {
          if (cur) { runs.push(cur); cur = null; }   // 断开了：先把已累积的连座段收下
          continue;
        }

        // 连座判定：与前一张同一行、x 间距≈座距，则并入当前段
        if (cur && Math.abs(seat.x - cur.lastX) <= row.spacing * 1.35) {
          cur.seats.push(seat);
          cur.lastX = seat.x;
        } else {
          if (cur) runs.push(cur);
          cur = { seats: [seat], lastX: seat.x, rowIdx: row.rowIdx, blockKey: block.key, region: block.region };
        }
        blockFree++;
      }
      if (cur) runs.push(cur);
    }

    freeSeats += blockFree;
    totalSeats += block.seatCount;
    perBlock[block.key] = { free: blockFree, total: block.seatCount, inScope: inScopeGrade && inScopeRegion };
    if (blockFree > 0) blocksWithFree.add(block.key);

    // 与上一轮对比，找出"新出现的"座位（回流票）
    if (prevByBlock && prevByBlock[block.key] !== undefined) {
      const prev = decodeBlockStatus(prevByBlock[block.key], block.seatCount);
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] && !prev[i]) newSeats.push(block.seats[i]);
      }
    }
  }

  // 计算每段的打分与信息
  const enriched = runs.map((r) => {
    const lead = r.seats[0];
    const gradeNames = [...new Set(r.seats.map((s) => s.gradeName).filter(Boolean))];
    return {
      blockKey: r.blockKey,
      region: r.region,
      rowIdx: r.rowIdx,
      rowNo: lead.rowNo,
      rowLabel: rowLabelFromRowNo(lead.rowNo) || lead.rowNo,
      len: r.seats.length,
      gradeNames,
      grade: lead.grade,
      grades: [...new Set(r.seats.map((s) => s.grade).filter(Boolean))],
      price: lead.price,
      seatNos: r.seats.map((s) => s.seatNo),
      seatIds: r.seats.map((s) => s.id),
      first: pick(lead),
      seats: r.seats.slice(0, 12).map(pick),
      x: lead.x,
      y: lead.y,
      score: scoreSeat(lead, { preference: task.preference, stage, stageSide: task.stageSide }),
    };
  });

  // 只有长度 >= 需求张数的段才算命中
  const ok = enriched.filter((r) => r.len >= quantity);
  ok.sort((a, b) => a.score - b.score || b.len - a.len);

  const best = ok[0] || null;
  const hit = ok.length > 0;

  return {
    hit,
    runs: ok.slice(0, 30),
    allRuns: enriched.length,
    best,
    freeSeats,
    totalSeats,
    blocksWithFree: blocksWithFree.size,
    perBlock,
    newSeats: newSeats.slice(0, 40).map(pick),
    message: hit
      ? buildMessage(task, best, ok, freeSeats, blocksWithFree.size)
      : '',
    at: Date.now(),
  };
}

function pick(s) {
  return {
    id: s.id, seatNo: s.seatNo, rowNo: s.rowNo, gradeName: s.gradeName,
    grade: s.grade, price: s.price, x: s.x, y: s.y, idx: s.idx,
  };
}

function buildMessage(task, best, ok, freeSeats, blocksWithFree) {
  const range = best.len > 1 ? `${best.seatNos[0]}~${best.seatNos[best.seatNos.length - 1]}` : `${best.seatNos[0]}号`;
  const grade = best.gradeNames.join('/') || [best.grade].filter(Boolean).join('/') || '—';
  return `命中 ${best.region || best.blockKey} · ${best.rowLabel} · ${best.seatNos.length} 连座（${range}）· ${grade}`
    + `｜共 ${ok.length} 处可用 / ${freeSeats} 个座位 / ${blocksWithFree} 个区块`;
}

// 把命中结果压成一行短文本，供通知 / 列表展示
function hitSummary(run) {
  if (!run) return '';
  const range = run.seatNos.length > 1
    ? `${run.seatNos[0]}~${run.seatNos[run.seatNos.length - 1]}`
    : run.seatNos[0];
  return `${run.region || run.blockKey} · ${run.rowLabel} · ${range}`;
}


// ===== lib/locator.js =====
// NOL Scout — 页面座位图坐标解算（纯函数，可在 node 里单测）
//
// 为什么需要"解"而不是直接换算：
//   seatMeta 返回的 posLeft/posTop 属于**接口坐标空间**，它不一定等于页面座位层
//   （[class*="SeatMap_seatGroup"] 里的那个 <svg>）自己的 viewBox 空间，也不一定等于
//   底图 SVG 的自然尺寸。实测两个场馆就不一致：
//     场馆 26000813：底图 527×700，座位层 viewBox 也是 "0 0 527 700"（恰好一致）
//     场馆 26000166：底图 316×305，而座位坐标横跨 80.2 ~ 380.1（明显放不进 316 的宽）
//   所以不能"猜比例"，改用**页面上已经画出来的座位元素**做标定：
//     1) 取每个座位元素的屏幕矩形中心
//     2) 用座位层 svg 的 getScreenCTM() 反算回 user space（页面的缩放/平移自动被抵消）
//     3) 与接口坐标做包围盒 + 最近邻拟合，解出 sx / sy / dx / dy（并尝试 x↔y 互换）
//     4) 用残差判断可信度，给 UI 一个诚实的"准 / 不准"
//
// 标定结果存在 user space（不是屏幕坐标），因此页面缩放、拖动后依然有效。

const LOCATOR_VERSION = 1;

// 从目录里取接口坐标点
function pointsFromCatalog(catalog, { onlyExposable = true } = {}) {
  const out = [];
  for (const b of catalog.blocks) {
    for (const s of b.seats) {
      if (onlyExposable && !s.exposable) continue;
      out.push({ x: s.x, y: s.y, blockKey: b.key, seat: s });
    }
  }
  return out;
}

function bounds(pts) {
  if (!pts || !pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  if (!Number.isFinite(x0) || x1 <= x0 || y1 <= y0) {
    // 允许退化成"一条线"（例如全在一个 row），此时给最小厚度避免除零
    if (!Number.isFinite(x0)) return null;
    return {
      x0, y0, x1: Math.max(x1, x0 + 1e-6), y1: Math.max(y1, y0 + 1e-6),
      w: Math.max(x1 - x0, 1e-6), h: Math.max(y1 - y0, 1e-6),
      cx: (x0 + Math.max(x1, x0 + 1e-6)) / 2, cy: (y0 + Math.max(y1, y0 + 1e-6)) / 2,
    };
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

// 候选集合：全部可见座位 + 每个区块的可见座位。
// 页面常常"只渲染当前放大区块"，所以必须逐区块也试一遍，否则包围盒会整体错位。
function candidateApiSets(catalog, { minSeats = 6 } = {}) {
  const sets = [];
  const all = pointsFromCatalog(catalog);
  if (all.length) sets.push({ name: 'all', label: '全部区块', pts: all });
  for (const b of catalog.blocks) {
    const pts = pointsFromCatalog({ blocks: [b] });
    if (pts.length >= minSeats) sets.push({ name: b.key, label: b.region || b.key, pts, block: b });
  }
  return sets;
}

// 最近邻索引（网格哈希）
function makePageIndex(pts, { cellScale = 1.8 } = {}) {
  const b = bounds(pts) || { w: 1, h: 1 };
  const pitch = Math.sqrt((b.w * b.h) / Math.max(1, pts.length));
  const cell = Math.max(pitch * cellScale, 1e-6);
  const map = new Map();
  const k = (i, j) => i + ':' + j;
  for (let n = 0; n < pts.length; n++) {
    const i = Math.floor(pts[n].x / cell), j = Math.floor(pts[n].y / cell);
    const kk = k(i, j);
    const arr = map.get(kk);
    if (arr) arr.push(n); else map.set(kk, [n]);
  }
  const query = (x, y, maxR) => {
    const R = Math.max(1, Math.ceil(maxR / cell));
    const i0 = Math.floor(x / cell), j0 = Math.floor(y / cell);
    let bd = Infinity, bi = -1;
    for (let i = i0 - R; i <= i0 + R; i++) {
      for (let j = j0 - R; j <= j0 + R; j++) {
        const arr = map.get(k(i, j));
        if (!arr) continue;
        for (const n of arr) {
          const dx = pts[n].x - x, dy = pts[n].y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bd) { bd = d2; bi = n; }
        }
      }
    }
    if (bi < 0) {
      for (let n = 0; n < pts.length; n++) {
        const dx = pts[n].x - x, dy = pts[n].y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bd) { bd = d2; bi = n; }
      }
    }
    return { d: Math.sqrt(bd), i: bi };
  };
  return { pts, cell, pitch, query };
}

// 拟合质量：把接口点按标定映射过去，看离"页面上的座位"有多远
function fitStats(cal, apiPts, index, tol) {
  let sum = 0, max = 0, within = 0, n = 0, idxSum = 0;
  for (const p of apiPts) {
    const q = applyCalibration(cal, p);
    const r = index.query(q.x, q.y, tol * 2);
    if (!Number.isFinite(r.d)) continue;
    const d = Math.min(r.d, tol * 4);   // 截断，避免个别离群点拉爆均值
    sum += d; max = Math.max(max, r.d); n++;
    if (r.d <= tol) { within++; idxSum += r.i; }
  }
  if (!n) return { mean: Infinity, max: Infinity, hitRate: 0, n: 0 };
  return { mean: sum / n, max, hitRate: within / n, n };
}

function applyCalibration(cal, p) {
  const ax = cal.swap ? p.y : p.x;
  const ay = cal.swap ? p.x : p.y;
  return { x: cal.sx * ax + cal.dx, y: cal.sy * ay + cal.dy };
}

// 主解算：apiPts → pagePts（两边都已是**同一个 user space**下的点）
function solveCalibration(apiPts, pagePts, { sampleMax = 400 } = {}) {
  if (!apiPts?.length || !pagePts?.length) return null;
  const aB = bounds(apiPts), pB = bounds(pagePts);
  if (!aB || !pB) return null;

  const index = makePageIndex(pagePts);
  const pitch = index.pitch;
  const tol = Math.max(pitch * 0.55, 1e-6);
  const stride = Math.max(1, Math.ceil(apiPts.length / sampleMax));
  const samples = apiPts.filter((_, i) => i % stride === 0);

  let best = null;
  for (const swap of [false, true]) {
    const ax0 = swap ? aB.y0 : aB.x0, ax1 = swap ? aB.y1 : aB.x1;
    const ay0 = swap ? aB.x0 : aB.y0, ay1 = swap ? aB.x1 : aB.y1;
    const aw = ax1 - ax0, ah = ay1 - ay0;
    if (!(aw > 0) || !(ah > 0)) continue;
    const sx = pB.w / aw, sy = pB.h / ah;
    for (const mode of ['corner', 'center']) {
      const dx = mode === 'corner'
        ? pB.x0 - sx * ax0
        : pB.cx - sx * ((ax0 + ax1) / 2);
      const dy = mode === 'corner'
        ? pB.y0 - sy * ay0
        : pB.cy - sy * ((ay0 + ay1) / 2);
      const cal = { swap, sx, sy, dx, dy, mode };
      const st = fitStats(cal, samples, index, tol);
      if (!best || st.mean < best.fit.mean) best = { ...cal, fit: st };
    }
  }
  if (!best) return null;

  const rel = best.fit.mean / pitch;
  const confidence = (rel < 0.28 && best.fit.hitRate > 0.85) ? 'exact'
    : rel < 0.85 ? 'rough' : 'bad';
  return {
    v: LOCATOR_VERSION,
    swap: best.swap, sx: best.sx, sy: best.sy, dx: best.dx, dy: best.dy, mode: best.mode,
    pitch, residual: best.fit.mean, rel, hitRate: best.fit.hitRate,
    confidence,
    apiBounds: aB, pageBounds: pB,
    apiCount: apiPts.length, pageCount: pagePts.length,
  };
}

function describeCalibration(cal) {
  if (!cal) return '未标定';
  const f = (n) => (Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(4));
  const conf = { exact: '精确', rough: '粗略', bad: '不可用', assumed: '推定' }[cal.confidence] || cal.confidence;
  return `${conf} · 缩放 ${f(cal.sx)}/${f(cal.sy)} · 偏移 ${f(cal.dx)},${f(cal.dy)}`
    + `${cal.swap ? ' · x↔y 互换' : ''} · 残差 ${(cal.rel * 100).toFixed(1)}% 座距`;
}

// 无法观测页面座位元素时的兜底推定（页面把座位画进位图 / 座位层不可见时用）
function guessCalibration(canvas, box, { identityPad = 0.02 } = {}) {
  if (!canvas || !box) return null;
  const aw = canvas.maxX - canvas.minX, ah = canvas.maxY - canvas.minY;
  if (!(aw > 0) || !(ah > 0) || !(box.w > 0) || !(box.h > 0)) return null;
  const padX = box.w * identityPad, padY = box.h * identityPad;
  const inside = canvas.minX >= box.x - padX && canvas.minY >= box.y - padY
    && canvas.maxX <= box.x + box.w + padX && canvas.maxY <= box.y + box.h + padY;
  if (inside) {
    return {
      swap: false, sx: 1, sy: 1, dx: 0, dy: 0, mode: 'identity', confidence: 'assumed',
      rel: 1, hitRate: 0, setName: '1:1 推定',
      note: '页面未渲染座位元素；接口坐标整块落在座位层内，按 1:1 推定',
    };
  }
  const s = Math.min(box.w / aw, box.h / ah);
  const ox = box.x + (box.w - s * aw) / 2, oy = box.y + (box.h - s * ah) / 2;
  return {
    swap: false, sx: s, sy: s,
    dx: ox - s * canvas.minX, dy: oy - s * canvas.minY,
    mode: 'fit', confidence: 'assumed', rel: 1, hitRate: 0, setName: '等比适配推定',
    note: '页面未渲染座位元素；接口坐标超出座位层，按等比居中适配推定（可能不准）',
  };
}

// 页面元素尺寸中位数过滤：座位层里常混着区块底纹/边界等大元素，先剔掉
function dropOutliers(boxes) {
  if (boxes.length < 8) return boxes;
  const diag = boxes.map((b) => Math.hypot(b.w, b.h)).sort((a, b) => a - b);
  const med = diag[diag.length >> 1] || 1;
  return boxes.filter((b) => Math.hypot(b.w, b.h) <= med * 4 && b.w > 0 && b.h > 0);
}


// ===== lib/seat-prefs.js =====
// NOL Scout — 捡漏参数与「现场任务」构造（v0.5）
//
// 设计意图：取消"先在 popup 里新建监控任务"这一步。
// 用户已经把页面走到了选座页，页面本身就是任务的上下文（商品号/场馆号/场次都能从
// 页面自己的请求里旁听到），所以不再需要手填商品页链接 —— 直接「点一下就开始」。
//
// 本文件只放纯函数，方便 test/verify-har.mjs 直接断言。

const PREFERENCES = ['any', 'front', 'center', 'left', 'right'];
const STAGE_SIDES = ['top', 'bottom', 'left', 'right'];

const PREF_LABEL = {
  any: '不挑位置',
  front: '尽量靠前',
  center: '尽量居中',
  left: '尽量靠左',
  right: '尽量靠右',
};

const GRADE_FILTER_ALL = '';

// 默认：全部价位、全部区域、1 张、不挑位置。
// 站位票（입장번호）基本都在"全部"里，捡漏场景要的就是"有就行"。
const DEFAULT_SCOUT_PREFS = {
  grades: [],
  regions: [],
  quantity: 1,
  preference: 'any',
  stageSide: 'top',
  intervalMs: 2800,
  // 验证码期自动开扫：默认**关**。
  // 用户明确要过"由我点开始"，所以不擅自开；打开后，检测到验证码关卡且目录就绪时会自动开扫，
  // 让输入验证码的那 ~8 秒不空转（实测这段耗时 8.3s，会从选座 10 分钟里扣）。
  captchaAutoStart: false,
  captchaAutoSolve: false,
  autoLock: false,
};

// 轮询下限 800ms：捡漏就吃这一口"比别人快半个身位"。
// 官网自身 seatStatus 的最快间隔约 2.6s、中位 4.5s，超过 10 倍频率没意义且更容易被限流，
// 所以下限就停在 800ms；上限 10s 防止手滑填成分钟级而误以为"没在工作"。
const MIN_INTERVAL_MS = 800;
const MAX_INTERVAL_MS = 10000;

// 面板/popup 共用的档位，避免两边各写一份
const INTERVAL_OPTIONS = [800, 1000, 1500, 2000, 2800];

// 低于这个值给一句提醒：不是不让用，而是让你知道自己在踩油门
const INTERVAL_AGGRESSIVE_MS = 1000;

const MAX_QUANTITY = 8;

const uniqStr = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((x) => String(x)).filter(Boolean))];

const clampInt = (v, lo, hi, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

/** 把任意（可能来自 storage / 消息 / 表单的）输入规整成合法参数 */
function normalizePrefs(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    grades: uniqStr(src.grades),
    regions: uniqStr(src.regions),
    quantity: clampInt(src.quantity, 1, MAX_QUANTITY, DEFAULT_SCOUT_PREFS.quantity),
    preference: PREFERENCES.includes(src.preference) ? src.preference : DEFAULT_SCOUT_PREFS.preference,
    stageSide: STAGE_SIDES.includes(src.stageSide) ? src.stageSide : DEFAULT_SCOUT_PREFS.stageSide,
    intervalMs: clampInt(src.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_SCOUT_PREFS.intervalMs),
    captchaAutoStart: src.captchaAutoStart === true,
    captchaAutoSolve: src.captchaAutoSolve === true,
    autoLock: src.autoLock === true,
  };
}

/** 参数是否为「全部价位 / 全部区域」（用于 UI 上给"全部"chip 打勾） */
function isAllScoped(prefs) {
  const p = normalizePrefs(prefs);
  return p.grades.length === 0 && p.regions.length === 0;
}

/** 把参数压成一行中文摘要，给面板/popup 直接用。
 *  第二个参数既可以直接给 Map<档位号, 档位名>，也可以给 { nameOfGrade: Map }。 */
function describePrefs(prefs, opts = {}) {
  const p = normalizePrefs(prefs);
  const map = opts && typeof opts.get === 'function' ? opts : (opts?.nameOfGrade || null);
  const grade = p.grades.length
    ? p.grades.map((g) => (map && map.get ? map.get(g) || g : g)).join('/')
    : '全部价位';
  const region = p.regions.length ? p.regions.join('/') : '全部区域';
  return `${grade} · ${region} · ${p.quantity} 张 · ${PREF_LABEL[p.preference] || p.preference}`;
}

/** 现场任务 id：同一个页面（商品+场次）反复点开始，复用同一条任务，不堆垃圾 */
function adHocTaskId(page = {}) {
  return 'scout:' + [page.goodsCode, page.placeCode, page.playSeq].filter(Boolean).join(':');
}

/**
 * 用「当前选座页」+「用户参数」直接造一条可执行任务。
 *
 * 注意两个刻意的取值：
 *   · playSeqs 留空 —— 页面即场次，不锁死；若用户在场次下拉里切到别的场次，
 *     任务不会因为"场次不在白名单"而报错停机。
 *   · adHoc: true —— 标记"依存于当前这个活着的页面"。浏览器重启后不该被自动拉起
 *     （那时页面早就没了），background 会把这些任务直接置为 stopped。
 *
 * @param {{goodsCode, placeCode, bizCode?, playSeq?, name?}} page 页面旁听到的上下文
 * @param {object} prefs  normalizePrefs 的输入
 */
function buildAdHocTask(page, prefs) {
  const goodsCode = page?.goodsCode ? String(page.goodsCode) : '';
  const placeCode = page?.placeCode ? String(page.placeCode) : '';
  if (!goodsCode || !placeCode) {
    throw new Error('页面还没给出商品号 / 场馆号 —— 请确认已经在 NOL 选座页（tickets.interpark.com/onestop/seat）');
  }
  const p = normalizePrefs(prefs);
  const playSeq = page.playSeq ? String(page.playSeq) : '';
  return {
    id: adHocTaskId({ goodsCode, placeCode, playSeq }),
    createdAt: Date.now(),
    status: 'running',
    mode: 'seat',
    adHoc: true,
    name: page.name || `捡漏 · ${goodsCode}${playSeq ? ' / ' + playSeq + ' 场' : ''}`,
    goodsCode,
    placeCode,
    bizCode: String(page.bizCode || '10965'),
    url: `https://world.nol.com/ticket/places/${placeCode}/products/${goodsCode}`,
    entryUrl: null,
    playSeqs: [],
    grades: p.grades,
    regions: p.regions,
    quantity: p.quantity,
    preference: p.preference,
    stageSide: p.stageSide,
    intervalMs: p.intervalMs,
    cooldownMs: 15000,
  };
}

/**
 * 取区块的「档位号」集合。
 *
 * 为什么必须是档位号而不是档位名：选区里点的是 `catalog.grades[].grade`（号码），
 * 而 `gradeCounts` 的键是 `seatGradeName`（韩文/英文名）。直接拿号码去 has(名字)
 * 会永远不命中——早期版本在 `targetBlocks` 和地图着色上都踩过这个坑，
 * 表现为"一选价位，目标区块就变成 0 个"。
 * 这里保留对 gradeCounts 的兜底，是为了兼容只有名字的输入（如测试桩）。
 */
function blockGradeKeys(b) {
  if (Array.isArray(b?.gradeNos) && b.gradeNos.length) return b.gradeNos.map(String);
  return Object.keys(b?.gradeCounts || {}).map(String);
}

/**
 * 把「用户筛选参数」+「座位目录」解算成"到底选中了哪些区块"。
 *
 * 这套口径必须与真正下发任务时的过滤口径完全一致（见 targetBlocks / startMonitor），
 * 否则地图上显示"选中了"，实际却没扫——那比不显示更糟。
 * 所以规则只此一处定义，UI 与任务构造都从这儿取。
 *
 * 规则：
 *   · 区域：未选 = 全部区域；否则区块 region 必须在选中集合里
 *   · 价位：未选 = 全部价位；否则区块至少要含一个选中档位的座位
 *   · 两者是「与」关系；只有含可见座位的区块才算候选
 *     （isExposable=false 的结账用虚拟座位不参与展示，也不参与计数）
 */
function resolveScope(prefs, catalog, { exposableOnly = true } = {}) {
  const p = normalizePrefs(prefs);
  const regions = new Set(p.regions);
  const grades = new Set(p.grades.map(String));
  const narrow = regions.size > 0 || grades.size > 0;

  const all = catalog?.blocks || [];
  // 展示口径只看"含可见座位"的区块（结账用虚拟区块不算）；扫描口径要宽一档，
  // 否则那些没有可见座位的区块就再也不会被轮询了。
  const blocks = exposableOnly
    ? all.filter((b) => (b.exposableCount ?? 0) > 0 || (b.seats || []).some((s) => s.exposable))
    : all;

  const inKeys = new Set();
  const regionStat = new Map();   // 区域名 -> { name, blocks, seats }
  let selectedSeats = 0;
  let totalSeats = 0;

  for (const b of blocks) {
    const seats = b.exposableCount ?? (b.seats || []).filter((s) => s.exposable).length;
    totalSeats += seats;
    const okRegion = !regions.size || regions.has(b.region);
    const okGrade = !grades.size || blockGradeKeys(b).some((g) => grades.has(g));
    if (!okRegion || !okGrade) continue;
    inKeys.add(b.key);
    selectedSeats += seats;
    const r = regionStat.get(b.region) || { name: b.region, blocks: 0, seats: 0 };
    r.blocks += 1;
    r.seats += seats;
    regionStat.set(b.region, r);
  }

  return {
    narrow, regions, grades,
    total: blocks.length, totalSeats,
    selected: inKeys.size, selectedSeats,
    inKeys,
    regionStat,
    selectedRegions: [...regionStat.values()].sort((a, b) => b.blocks - a.blocks || a.name.localeCompare(b.name, 'ko')),
    /** 区块是否在筛选范围内（不筛时恒为 true） */
    has: (blockKey) => !narrow || inKeys.has(blockKey),
  };
}

/** 单行中文摘要：给面板/popup 的"实时选区"用 */
function describeScope(scope) {
  if (!scope) return '';
  if (!scope.narrow) return `全部 ${scope.total} 区块 · ${scope.totalSeats.toLocaleString()} 座`;
  const detail = scope.selectedRegions.map((r) => `${r.name} ${r.blocks}块`).join(' · ');
  return `已选 ${scope.selected} / ${scope.total} 区块 · ${scope.selectedSeats.toLocaleString()} 座`
    + (detail ? `（${detail}）` : '（当前条件下没有匹配的区块）');
}

/**
 * 候选座位优先级队列。
 *
 * matchSnapshot 已经把可用连座段按用户的「位置偏好」打过分并升序排好（score 越小越好），
 * 这里只负责把它切成"首选 / 备份1 / 备份2"。人在紧张的时刻不需要理解排序逻辑，
 * 需要的是"点第一个"。所以队列本身也是合规的那一步——它只排序和标注，
 * 不替用户点选。
 */
function labelRuns(runs, limit = 3) {
  const list = (Array.isArray(runs) ? runs : [])
    .filter((r) => r && r.len)
    .slice()
    .sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity) || (b.len || 0) - (a.len || 0));
  return list.slice(0, limit).map((run, i) => ({
    rank: i + 1,
    label: i === 0 ? '首选' : `备份${i}`,
    run,
  }));
}


// ===== lib/session-timer.js =====
// 选座会话倒计时（纯函数，可单测）
//
// 为什么能算出"还剩几分钟"：NOL onestop 的会话不靠 Cookie，而是靠请求头
//   x-onestop-session: 26010474_M0000001661831791271752
// 这串 token 的结构是 `{goodsCode}_M{userSeq 补零 12 位}{Unix 秒 10 位}`，
// 末 10 位就是**排队放行、进入选座会话的那一秒**（服务器时钟）。
//
// 抓包实证（tickets.interpark.com.har）：
//   token 尾数 1791271752 → 2026-10-06T07:29:12Z
//   而 waiting/api/rank 最后一次返回"已放行"的请求时刻 = 07:29:12.451Z，误差 0.45s。
// 也就是说：这个尾数不是随机数，而是会话起点，可以直接当作计时的锚。
//
// 时限 10 分钟来自站点自己的语言包（不是猜的）：
//   locales/en/common.json:
//     "session_timer_label_seat": "Seat selection time"
//     "session_timer_expired_title": "Your 10-minute seat selection time has expired."
//     "session_timer_expired_booking_title": "Your 10-minute booking window has expired."
//
// 权威终点由服务端给：页面自己在轮询 GraphQL `ExpiredSession { isExpiredSession }`。
// 所以本模块的判停规则是「本地钟 + 服务端开关」双条件：
//   · 服务端说 expired → 立刻停
//   · 本地钟归零但服务端 60s 内刚说过 false → 给一段宽限，别把还能买的场次误停
//   · 本地钟归零且服务端没否认 → 停

const TIMER_VERSION = '1.0.0';

/** 站点文案里的 10 分钟（좌석 선택 시간 / seat selection time） */
const SEAT_WINDOW_MS = 10 * 60 * 1000;
/** 宽限：本地钟归零、但服务端明确说过"还没过期"时，再撑这么久 */
const DEFAULT_GRACE_MS = 45 * 1000;
/** 服务端 `isExpiredSession` 观测值的新鲜期：超过这么久就不再采信 */
const SERVER_FRESH_MS = 60 * 1000;

// 合理性区间：2020-01-01 ~ 2036-01-01。
// 用来防止把 userSeq 之类的纯数字误当成时间戳（宁可退化为"首次观测"锚点，也不要算错）。
const TOKEN_TS_MIN = 1577836800;
const TOKEN_TS_MAX = 2082758400;

/**
 * 从 x-onestop-session 解出会话起点（Unix 毫秒）。
 * @returns {number|null} 解不出或不在合理区间 → null
 */
function parseSessionStart(token) {
  if (!token || typeof token !== 'string') return null;
  const m = /(\d{10})\s*$/.exec(token.trim());
  if (!m) return null;
  const sec = Number(m[1]);
  if (!Number.isFinite(sec) || sec < TOKEN_TS_MIN || sec > TOKEN_TS_MAX) return null;
  return sec * 1000;
}

/**
 * 决定计时锚点。
 * 优先用 token 里内嵌的服务器时刻（能正确反映"你已经进来多久了"）；
 * 解不出时退化为首次观测到会话的本地时刻（会偏乐观，但至少能倒计时）。
 */
function resolveAnchor(token, firstSeenMs = Date.now()) {
  const fromToken = parseSessionStart(token);
  if (fromToken != null) return { startMs: fromToken, anchor: 'token', confidence: 'exact' };
  return { startMs: firstSeenMs, anchor: 'observed', confidence: 'assumed' };
}

/** 剩余毫秒（可为负） */
function remainingMs(deadlineMs, nowMs) {
  if (!Number.isFinite(deadlineMs)) return NaN;
  return deadlineMs - nowMs;
}

/** 分档：ok / warn（≤5min）/ danger（≤1min）/ expired（≤0） */
function countdownPhase(remaining, { warnMs = 5 * 60 * 1000, dangerMs = 60 * 1000 } = {}) {
  if (!Number.isFinite(remaining)) return 'unknown';
  if (remaining <= 0) return 'expired';
  if (remaining <= dangerMs) return 'danger';
  if (remaining <= warnMs) return 'warn';
  return 'ok';
}

/** 倒计时文本：MM:SS；超过 1 小时给 H:MM:SS；归零给 00:00 */
function formatCountdown(ms) {
  if (!Number.isFinite(ms)) return '--:--';
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
}

/**
 * 判停规则（本地钟 + 服务端开关）。
 * @param {object} o
 * @param {number} o.nowMs
 * @param {number} o.deadlineMs
 * @param {boolean|null} o.serverExpired  最近一次 isExpiredSession 观测值
 * @param {number} o.serverCheckedAt      该观测的时刻
 * @param {number} [o.graceMs]
 * @returns {{state:'live'|'grace'|'dead', remaining:number, reason:string, graceLeftMs?:number}}
 */
function reconcile({ nowMs, deadlineMs, serverExpired = null, serverCheckedAt = 0, graceMs = DEFAULT_GRACE_MS } = {}) {
  const remaining = remainingMs(deadlineMs, nowMs);

  // 服务端说死了就是死了，不看本地钟
  if (serverExpired === true) {
    return { state: 'dead', remaining, reason: 'server' };
  }
  if (!Number.isFinite(remaining)) {
    return { state: 'live', remaining: NaN, reason: 'no-anchor' };
  }
  if (remaining > 0) {
    return { state: 'live', remaining, reason: 'live' };
  }

  // 本地已归零：只有"服务端刚刚确认还活着"才给宽限
  const fresh = serverCheckedAt > 0 && (nowMs - serverCheckedAt) < SERVER_FRESH_MS;
  if (fresh && serverExpired === false) {
    const graceLeftMs = graceMs - (-remaining);
    if (graceLeftMs > 0) {
      return { state: 'grace', remaining, reason: 'server-ok', graceLeftMs };
    }
  }
  return { state: 'dead', remaining, reason: 'local' };
}

/**
 * 相对上次告警，这次该不该再响一次。
 * 只在跨过档位时返回 true，避免每秒都弹。
 * @returns {{warn:boolean, level:'warn'|'danger'|'expired'|null}}
 */
function nextAlarm(prevLevel, remaining) {
  const lv = countdownPhase(remaining) === 'warn' ? 'warn'
    : countdownPhase(remaining) === 'danger' ? 'danger'
      : countdownPhase(remaining) === 'expired' ? 'expired' : null;
  if (!lv) return { warn: false, level: null };
  const rank = { warn: 1, danger: 2, expired: 3 };
  if ((rank[lv] || 0) > (rank[prevLevel] || 0)) return { warn: true, level: lv };
  return { warn: false, level: lv };
}

/**
 * 秒表是否应该发出"该停"的指令。
 * 注意：监控本身是否已经在跑由调用方判断，这里只回答时间维度。
 */
function shouldStop(result) {
  return result?.state === 'dead';
}

/** 面板/弹窗用的一行摘要 */
function describeTimer({ confidence, anchor, deadlineMs, note } = {}) {
  const src = confidence === 'exact'
    ? '起点取自会话令牌内嵌的服务器时刻'
    : '起点为首次观测（令牌未含时间戳，计时可能偏乐观）';
  const at = Number.isFinite(deadlineMs)
    ? new Date(deadlineMs).toLocaleTimeString('zh-CN', { hour12: false })
    : '—';
  return `${src} · 截止 ${at}${note ? ' · ' + note : ''}`;
}


// ===== lib/panel-pos.js =====
// 悬浮面板的定位解算（纯函数，可单测）
//
// 为什么需要它：
//   面板默认原本贴在**右上角**，而 NOL 的选座区域正好在页面中右侧，
//   面板一弹出来就压住座位图，影响选座。改成默认贴左边之后，
//   又带来两个新问题 —— 都需要纯函数来兜底：
//     1) 拖到屏幕外 / 换窗口大小后找不到面板；
//     2) 用户拖过之后刷新页面，位置又跑回默认，白拖一次。
//
// 所以这里只做两件确定性的事：**把坐标夹进视口** 与 **左右镜像**。
// 落盘与 DOM 写入留给内容脚本（那边才有 chrome.storage 和元素）。

const PANEL_MARGIN = 16;          // 与页边留白
const PANEL_MIN_VISIBLE = 120;    // 纵向至少留这么多，保证标题栏始终可抓可拖
const PANEL_DEFAULT_W = 372;      // 兜底宽度（.card 实际就是 372px）
const PANEL_DEFAULT_H = 320;

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * 把面板坐标夹进视口。
 * 横向要求整块可见；纵向只要求标题栏可见 —— 面板内容很长时（日志/地图）
 * 允许下沿超出视口，`top` 被顶到 `vh - PANEL_MIN_VISIBLE` 就停住。
 */
function clampPanelPos(left, top, opts = {}) {
  const w = Math.max(1, num(opts.w, PANEL_DEFAULT_W));
  const vw = Math.max(1, num(opts.vw, 1280));
  const vh = Math.max(1, num(opts.vh, 900));
  const margin = num(opts.margin, PANEL_MARGIN);

  const maxLeft = Math.max(margin, vw - w - margin);
  const maxTop = Math.max(margin, vh - PANEL_MIN_VISIBLE);
  const L = Math.min(Math.max(margin, Math.round(num(left, margin))), maxLeft);
  const T = Math.min(Math.max(margin, Math.round(num(top, margin))), maxTop);
  return { left: L, top: T };
}

/**
 * 左右镜像：把面板翻到屏幕的另一侧（保持纵向不变）。
 * 用**中心点**判当前在哪一侧，而不是 left 值 —— 面板宽度和视口都可能是任意值。
 */
function mirrorPanelPos(pos, opts = {}) {
  const w = Math.max(1, num(opts.w, PANEL_DEFAULT_W));
  const vw = Math.max(1, num(opts.vw, 1280));
  const margin = num(opts.margin, PANEL_MARGIN);
  const top = num(pos?.top, 0);

  const left = Math.min(Math.max(0, num(pos?.left, 0)), Math.max(0, vw - w));
  const onLeftHalf = left + w / 2 < vw / 2;
  return {
    left: onLeftHalf ? Math.max(margin, vw - w - margin) : margin,
    top,
  };
}

/** storage 里读出来的东西不可信（可能被手改、可能是旧版本字段），先规整 */
function normalizePanelPos(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const left = Number(raw.left);
  const top = Number(raw.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { left, top };
}


// ===== lib/captcha.js =====
// NOL Scout — 验证码关卡（合规版，v0.7）
//
// 实测数据（真实抓包 tickets.interpark.com.har，2026-10-06 那场）：
//   计时起点 = 令牌尾数 1791271752（= 排队放行那一刻）        t+53.9s
//   POST /onestop/api/captcha/image  → {"Img":"data:image/jpeg;base64,…"}   t+79.3s
//   GET  /onestop/api/captcha/verify?p1=<答案>&…&p9=<签名> → {"result":"Y"} t+87.7s
//   → 人工看图 + 输入 + 提交 ≈ **8.3 秒**，且全部落在选座 10 分钟窗口内（占 1.4%）。
//
// 关卡计时与结果解析；本地识别和自动提交见 offscreen/ocr.js 与 onestop-seat.js。

const CAPTCHA_API = {
  image: '/onestop/api/captcha/image',
  verify: '/onestop/api/captcha/verify',
};

// class 名带构建哈希（ModalCaptchaText_captchaInput__DC7Gz），所以只能前缀/包含匹配
const CAPTCHA_SEL = {
  box: '[class*="captchaBox"], [class*="captchaPlugin"]',
  textBox: '[class*="captchaBox"]',
  input: '[class*="captchaInput"] input, input[class*="captchaInput"], [class*="captchaInput"]',
  slider: '[class*="captchaPlugin"]',
  error: '[class*="captchaError"]',
};

const CAPTCHA_KIND_LABEL = { text: '文字验证码', slider: '滑块验证码', '': '验证码' };

// 耗时分档：0~6s 正常 / 6~12s 偏慢 / >12s 太慢
const CAPTCHA_SLOW_MS = 6000;
const CAPTCHA_BAD_MS = 12000;
// 卡这么久基本是输错了或看不懂 → 值得再响一声提醒（避免人已经走神）
const CAPTCHA_STUCK_MS = 35000;

const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 这个请求是验证码的哪一步？（image = 关卡出现，verify = 交答案） */
function captchaStage(url) {
  const s = String(url || '');
  if (s.includes(CAPTCHA_API.image)) return 'image';
  if (s.includes(CAPTCHA_API.verify)) return 'verify';
  return '';
}

/** 从元素 class 串判断是哪一种验证码 */
function captchaKindFromClass(classText) {
  const s = String(classText || '');
  if (/captchaPlugin|captchaSlider|Slider_captcha/i.test(s)) return 'slider';
  if (/captchaBox|captchaInput|captchaImage/i.test(s)) return 'text';
  return '';
}

/** verify 的响应体 → 通过 / 未通过 / 无法判断（{"result":"Y"}） */
function captchaPassed(text) {
  let j;
  try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return null; }
  if (!j || typeof j !== 'object') return null;
  const r = j.result;
  if (typeof r === 'boolean') return r;
  if (typeof r === 'string') {
    const u = r.trim().toUpperCase();
    if (u === 'Y' || u === 'TRUE') return true;
    if (u === 'N' || u === 'FALSE') return false;
  }
  return null;
}

/**
 * 把答案从 URL 里抹掉。
 * verify 的答案就挂在 p1 上 —— 我们只需要知道"发生过一次验证"，
 * 既不需要、也不应该把用户输入的答案落进日志或 storage。
 */
function stripCaptchaAnswer(url) {
  return String(url || '').replace(/([?&]p1=)[^&]*/gi, '$1***');
}

/** 耗时落在哪一档 */
function elapsedPhase(ms, opts = {}) {
  const slow = numOr(opts.slow, CAPTCHA_SLOW_MS);
  const bad = numOr(opts.bad, CAPTCHA_BAD_MS);
  const t = numOr(ms, -1);
  if (t < 0) return 'ok';
  if (t >= bad) return 'bad';
  if (t >= slow) return 'slow';
  return 'ok';
}

const ELAPSED_LABEL = { ok: '正常', slow: '偏慢', bad: '太慢' };

/** 8.3s / 42s —— 一位小数在 10 秒内才有意义，超过就取整免得太吵 */
function formatElapsed(ms) {
  const s = Math.max(0, numOr(ms, 0)) / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

function describeElapsed(ms, opts = {}) {
  const phase = elapsedPhase(ms, opts);
  return `${formatElapsed(ms)} · ${ELAPSED_LABEL[phase]}`;
}

/**
 * 贴在验证码框旁边的徽标。
 * 文案刻意把「剩余」放在前面：输入验证码的人最需要的不是"我花了多久"，
 * 而是"我还剩多久"，所以剩余时间是主角，耗时是副标题。
 */
function captchaBadge({ remainingText, elapsedMs, kind, expired } = {}) {
  const phase = expired ? 'expired' : elapsedPhase(elapsedMs);
  const label = CAPTCHA_KIND_LABEL[kind] || CAPTCHA_KIND_LABEL[''];
  return {
    tone: phase,
    label,
    main: expired ? '⌛ 选座时间已到' : `⏱ 剩余 ${remainingText}`,
    sub: expired ? '这次会话已结束' : `验证码已用 ${formatElapsed(elapsedMs)}`,
    // 只在必要时多嘴一句，平时不打扰
    tip: phase === 'bad' ? '（这个速度会吃掉不少时间）' : phase === 'slow' ? '（比 6 秒慢一些）' : '',
  };
}

/** 通关后写进日志的一行 */
function captchaSummary({ elapsedMs, attempts = 1, remainingText } = {}) {
  const retry = attempts > 1 ? ` · 共 ${attempts} 次` : '';
  return `✅ 验证码通过 · 用时 ${formatElapsed(elapsedMs)}${retry} · 当前剩余 ${remainingText}`;
}

/**
 * 这 8 秒到底亏不亏？
 * 给用户一句实话：扫描如果没在跑，验证码期间就是纯等待。
 */
function gateAdvice({ monitoring, autoStartEnabled, ready }) {
  if (monitoring) return { level: 'hit', text: '扫描进行中 —— 验证码这几秒不空转，通过时命中已经排在候选队列里' };
  if (!ready) return { level: 'wait', text: '座位目录还没好，通过验证码后再点开始也不迟' };
  if (autoStartEnabled) return { level: 'warn', text: '正在自动开扫…' };
  return { level: 'warn', text: '扫描未启动 —— 想让它在这几秒里也盯着，可在「调整范围」里打开「验证码期自动开扫」' };
}


// ===== lib/automation.js =====
// 自动操作的纯函数。请求只使用当前页面会话，不复用 HAR 的令牌或签名。
function normalizeOcrAnswer(text) {
  const answer = String(text || '').replace(/\s/g, '').toUpperCase();
  return /^[A-Z]{6}$/.test(answer) ? answer : '';
}

function makeLockPayload(page, run, quantity) {
  if (!page.session || !page.goodsCode || !page.placeCode || !page.playSeq) throw new Error('缺少当前购票会话');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 8) throw new Error('购票数量错误');
  const seats = run?.seats?.slice(0, quantity) || [];
  if (seats.length !== quantity || new Set(seats.map(s => s.id)).size !== quantity) throw new Error('候选座位不足或重复');
  const prefix = `${page.goodsCode}:${page.placeCode}:${page.playSeq}:`;
  if (seats.some(s => !s.id?.startsWith(prefix) || !s.grade)) throw new Error('座位与当前场次不匹配');
  return {
    goodsCode: page.goodsCode, placeCode: page.placeCode, playSeq: page.playSeq,
    seatType: 'DEFAULT', seats: seats.map(s => ({ seatGrade: s.grade, seatInfoId: s.id })),
    sessionId: page.session, autoAssign: false,
  };
}

function lockOutcome(json) {
  if (!Array.isArray(json?.unselectableSeatInfoIds)) return 'unknown';
  return json.unselectableSeatInfoIds.length === 0 ? 'locked' : 'unavailable';
}


// ===== lib/captcha-dom.js =====
// 验证码图片、输入框和 footer 位于同一弹窗的不同层级。
function captchaDomStatus(doc) {
  const input = doc.querySelector('input[class*="captchaInput"], [class*="captchaInput"] input');
  if (!input) return { reason: '等待验证码输入框渲染' };
  let image;
  for (let root = input.parentElement; root && root !== doc.body; root = root.parentElement) {
    image = root.querySelector('[class*="captchaImage"] img') || image;
    const button = root.querySelector('footer button, [class*="footer"] button');
    if (image && button) return { root, input, image, button, reason: '' };
  }
  return { input, reason: image ? '等待验证码确认按钮渲染' : '等待验证码图片渲染' };
}
function findCaptchaControls(doc) {
  const status = captchaDomStatus(doc);
  return status.reason ? null : status;
}

// 节流保证连续 DOM 更新不能无限推迟检查；属性监听和轮询覆盖分阶段渲染。
function watchCaptchaDom(doc, check, shouldPoll) {
  let timer;
  const observer = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; check(); }, 100);
  });
  observer.observe(doc.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['src', 'class', 'disabled'],
  });
  const poll = setInterval(() => { if (shouldPoll()) check(); }, 500);
  check();
  return () => { observer.disconnect(); clearTimeout(timer); clearInterval(poll); };
}


// ===== content/onestop-seat.js =====
// NOL Scout — 座位页监控脚本（ISOLATED world，v0.4）
// 运行在 https://tickets.interpark.com/onestop/seat 上。
//
// 职责：
//   1) 接收 MAIN world 钩子旁听到的会话头与座位/余票响应（零额外请求）
//   2) 按用户配置对目标区块轮询 seatStatus，解码到**单个座位**
//   3) 命中时：通知 + 提示音 + 弹出精确座位（区域/排/号/价位）+ 在座位图上高亮
//   4) 把命中的座位**画到页面自己的座位图上**（叠加标记 + 自动滚动居中）
//
// 可选本地验证码识别与自动锁票；不自动提交支付。







const HOOK_TAG = 'nol-scout-hook';
const KRW_CNY = 0.00496;   // 与 popup/popup.js 的 krw2cny 保持同一口径

const state = {
  session: '', channel: '', lang: 'EN',
  goodsCode: '', placeCode: '', bizCode: '', playSeq: '',
  catalog: null, catalogKey: '',
  status: {}, prevStatus: {}, lastSeenAt: {},
  monitor: null,
  automation: { busy: false, locked: null, uncertain: false, lastAttempt: 0, captchaImage: null, captchaGeneration: 0, ocrBusy: false, ocrTried: new Set() },
  panel: null, modal: null,
  panelPos: null,      // {left, top} 面板落点；null = 用默认的贴左位置
  logLines: [],
  zoom: null,          // {blockKey, seat} 面板地图缩放目标
  overlay: null,       // 页面叠加标记
  locator: null,       // 页面座位图定位器 { map, pagePoints, cal, ... }
  seatCanvas: null,    // 页面定位结果摘要（给 popup 显示）
  prefs: normalizePrefs(DEFAULT_SCOUT_PREFS),
  ui: { scopeOpen: false },
  // 验证码关卡：只记录"什么时候出现、花了多久"，答案本身一律不碰（见 lib/captcha.js）
  captcha: {
    active: false, kind: '', source: '', seenAt: 0, lastGoneAt: 0,
    attempts: 0, passed: null, elapsed: 0, totalMs: 0,
    needGone: false, wantAutoStart: false, stuckWarned: false,
    lastCost: null, history: [],
  },
  // 选座 10 分钟时限：锚点来自 x-onestop-session 内嵌的服务器秒；权威终点来自服务端 isExpiredSession
  timer: {
    token: '',
    startMs: 0,
    deadlineMs: NaN,
    anchor: '', confidence: '',
    durationMs: SEAT_WINDOW_MS,
    firstSeenAt: 0,
    serverExpired: null,      // 最近一次观测到的 isExpiredSession
    serverCheckedAt: 0,
    lastServerAskAt: 0,
    lastPhase: null,
    stoppedByTimer: false,
    clockSkewMs: 0,           // serverNow - Date.now()，用 getServerTime 校准
    skewAt: 0,
  },
};


// ---------------- 与 MAIN world 钩子通信 ----------------

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.__tag !== HOOK_TAG) return;
  if (d.type === 'session') return onSession(d.payload);
  if (d.type === 'api') return onPassiveApi(d.payload);
});

function onSession(p) {
  if (!p) return;
  let isNew = false;
  if (p.session && p.session !== state.session) {
    state.session = p.session;
    isNew = true;
    state.automation.locked = null;
    state.automation.uncertain = false;
    state.captcha.passed = null;
    state.automation.captchaGeneration++;
    state.automation.ocrTried.clear();
    log(`已捕获会话 ${state.session.slice(0, 30)}…`);
    syncTimerToken(p.session);
  }
  if (p.channel) state.channel = p.channel;
  if (p.lang) state.lang = p.lang;
  pushState();
  if (isNew) scheduleCatalogBuild();
}

// ---------------- 选座 10 分钟时限 ----------------

/** 会话令牌一变就（重）锚定计时；同一场演出刷新页面时令牌通常不变，所以倒计时能跨刷新延续 */
function syncTimerToken(token) {
  const t = state.timer;
  const now = Date.now();
  if (!t.firstSeenAt) t.firstSeenAt = now;
  const start = parseSessionStart(token);
  if (start != null) {
    const changed = t.startMs !== start;
    t.startMs = start;
    t.anchor = 'token';
    t.confidence = 'exact';
    t.stoppedByTimer = false;
    if (changed) {
      expiredHandled = false;   // 新会话 = 新的 10 分钟，允许再次自动停
      t.lastPhase = null;
      log(`选座时钟已对齐：起点 ${new Date(start).toLocaleTimeString('zh-CN', { hour12: false })}（会话令牌内嵌）· 时限 ${Math.round(t.durationMs / 60000)} 分钟`);
    }
  } else if (!t.startMs) {
    t.startMs = now;
    t.anchor = 'observed';
    t.confidence = 'assumed';
    log('会话令牌里没读到时间戳，计时从「首次看到会话」起算，会偏乐观', 'warn');
  }
  t.token = token;
  t.deadlineMs = t.startMs + t.durationMs;
  ensureServerClock();
  startTimerTicker();
  tickTimer();
}

/** 用站点自己的校时接口校准本地钟（13 字节的小请求，只在会话建立时问一次） */
async function ensureServerClock() {
  const t = state.timer;
  if (t.skewAt && Date.now() - t.skewAt < 5 * 60 * 1000) return;
  try {
    const { serverMs, t1 } = await getServerTime();
    t.clockSkewMs = serverMs - t1;
    t.skewAt = Date.now();
  } catch (e) { /* 拿不到就用本地钟，误差通常在秒级 */ }
}

/** 服务端"会话是否已过期"的最新观测（被动旁听 /onestop/gql 得到） */
function noteServerExpired(expired) {
  const t = state.timer;
  const was = t.serverExpired;
  t.serverExpired = !!expired;
  t.serverCheckedAt = Date.now();
  if (was !== t.serverExpired) {
    if (t.serverExpired) log('服务端已标记本会话过期（isExpiredSession = true）', 'error');
    else if (was === true) log('服务端会话重新有效（isExpiredSession = false）');
  }
  tickTimer();
}

/** 本地钟归零、但服务端还没确认时，主动问一次（平时不请求，避免额外负载） */
async function doubleCheckExpired() {
  const t = state.timer;
  if (!state.session) return null;
  if (Date.now() - t.lastServerAskAt < 25000) return t.serverExpired;
  t.lastServerAskAt = Date.now();
  try {
    const expired = await getExpiredSession(ctx());
    noteServerExpired(expired);
    return expired;
  } catch (e) {
    return t.serverExpired;
  }
}

function serverNowMs() {
  const t = state.timer;
  return Date.now() + (t.skewAt ? t.clockSkewMs : 0);
}

/** 当前时刻的计时快照（面板/popup/后台共用一份口径） */
function timerSnapshot() {
  const t = state.timer;
  if (!t.startMs) {
    return { active: false, remaining: NaN, state: 'unknown', text: '--:--', phase: 'unknown' };
  }
  const r = reconcile({
    nowMs: serverNowMs(),
    deadlineMs: t.deadlineMs,
    serverExpired: t.serverExpired,
    serverCheckedAt: t.serverCheckedAt,
    graceMs: DEFAULT_GRACE_MS,
  });
  return {
    active: true,
    remaining: r.remaining,
    state: r.state,
    reason: r.reason,
    graceLeftMs: r.graceLeftMs,
    text: formatCountdown(r.state === 'grace' ? 0 : r.remaining),
    phase: countdownPhase(r.remaining),
    total: t.durationMs,
    anchor: t.anchor,
    confidence: t.confidence,
    startMs: t.startMs,
    deadlineMs: t.deadlineMs,
    serverExpired: t.serverExpired,
    serverCheckedAge: t.serverCheckedAt ? Math.round((Date.now() - t.serverCheckedAt) / 1000) : null,
    skewMs: t.skewAt ? Math.round(t.clockSkewMs) : null,
    stoppedByTimer: t.stoppedByTimer,
  };
}

let tickerId = null;
function startTimerTicker() {
  if (tickerId) return;
  tickerId = setInterval(tickTimer, 1000);
}
function stopTimerTicker() {
  if (!tickerId) return;
  clearInterval(tickerId);
  tickerId = null;
}

/**
 * 每秒跑一次。刻意**不做整块重绘**——地图可能有上万个 svg 节点，
 * 每秒重建一次会把页面拖死。这里只改倒计时自己的那几个文本节点。
 */
function tickTimer() {
  const snap = timerSnapshot();
  paintTimer(snap);

  if (snap.active) {
    const alarm = nextAlarm(state.timer.lastPhase, snap.remaining);
    if (alarm.level) state.timer.lastPhase = alarm.level;
    if (alarm.warn) {
      if (alarm.level === 'warn') {
        log(`⚠ 还剩 ${formatCountdown(snap.remaining)}，座位有限，建议现在就定下来`, 'warn');
        notifySoon('选座时间剩余 5 分钟', `当前剩余 ${formatCountdown(snap.remaining)}`);
      } else if (alarm.level === 'danger') {
        log(`⚠⚠ 只剩 ${formatCountdown(snap.remaining)}！扫码/输入验证码都来不及了，现在立刻下单`, 'error');
        notifySoon('选座时间不足 1 分钟', `剩余 ${formatCountdown(snap.remaining)}，请立即完成下单`);
      }
    }
  }

  if (snap.active && snap.remaining <= 0 && snap.state !== 'dead') {
    // 本地钟归零但服务端未确认 → 复核一次
    doubleCheckExpired().then(() => tickTimer());
  }
  if (snap.state === 'dead') handleTimerExpired(snap);
}

/** 只改倒计时节点，不碰其他 DOM */
function paintTimer(snap) {
  const root = state.panel?.root;
  const cls = `tmr ${snap.phase}${snap.state === 'grace' ? ' grace' : ''}`;
  for (const id of ['tmr', 'hdTmr']) {
    const el = root?.getElementById?.(id);
    if (!el) continue;
    el.textContent = snap.text;
    if (id === 'tmr') el.className = cls;
  }
  const sub = root?.getElementById?.('tmrSub');
  if (sub) sub.textContent = timerSubText(snap);
}

function timerSubText(snap) {
  if (!snap.active) return '等页面产生会话后自动计时';
  if (snap.state === 'dead') {
    return snap.reason === 'server' ? '服务端已判定会话过期' : '选座时限已到';
  }
  if (snap.state === 'grace') {
    return `已到 10 分钟，但服务端还没判超时 → 宽限 ${Math.ceil((snap.graceLeftMs || 0) / 1000)}s 后停`;
  }
  const conf = snap.confidence === 'exact' ? '令牌锚定' : '推定起点';
  const skew = snap.skewMs != null ? ` · 校时 ${snap.skewMs >= 0 ? '+' : ''}${(snap.skewMs / 1000).toFixed(1)}s` : '';
  return `${conf} · 起点 ${new Date(snap.startMs).toLocaleTimeString('zh-CN', { hour12: false })} · 共 ${Math.round(snap.total / 60000)} 分钟${skew}`;
}

let expiredHandled = false;
function handleTimerExpired(snap) {
  if (expiredHandled) return;
  expiredHandled = true;
  state.timer.stoppedByTimer = true;
  const why = snap.reason === 'server' ? '服务端判定会话超时' : '选座 10 分钟已到';
  if (state.monitor) {
    stopMonitor({ quiet: false });
    log(`⏱ ${why}，捡漏扫描已自动停止`, 'error');
  } else {
    log(`⏱ ${why}`, 'warn');
  }
  safeNotify('选座时间已到 · 扫描已停止', `${why}。若还要买，请重新排队进入选座页。`);
  paintTimer(timerSnapshot());
}

function safeNotify(title, message) {
  try {
    chrome.runtime.sendMessage({ type: 'SEAT_TIMER_NOTIFY', title, message }).catch(() => {});
  } catch (e) { /* 扩展上下文可能已失效 */ }
}
let lastNotifyAt = 0;
function notifySoon(title, message) {
  const now = Date.now();
  if (now - lastNotifyAt < 5000) return;
  lastNotifyAt = now;
  safeNotify(title, message);
}

// ---------------- 验证码关卡（合规版） ----------------
//
// 只做三件事：**发现关卡 / 把光标送进输入框 / 把这段时间花在哪摆到你面前**。
// 计时与聚焦始终可用；启用本地识别时由页面原有按钮验证。
//
// 为什么值得做：实测这一关卡要吃掉约 8.3 秒，而这 8.3 秒是从选座 10 分钟里扣的。
// 既然不能替你输入，就至少让你不用再去找时间、找输入框。

const C = () => state.captcha;

function captchaElapsed() {
  const c = C();
  return c.seenAt ? Date.now() - c.seenAt : 0;
}

function captchaAppear(source, kind) {
  const c = C();
  if (c.active) return;
  // 通关后同一张模态可能还赖在 DOM 里（站点是渐隐移除的）。必须等它真的消失过一次
  // 才重新武装，否则观察器会把同一张图反复判成"新的验证码关卡"，徽标也跟着阴魂不散。
  if (c.needGone) return;
  c.active = true;
  c.inputReadyNoted = false;
  state.automation.captchaNote = '';
  c.seenAt = Date.now();
  c.passed = null;
  c.stuckWarned = false;
  c.source = source || '';
  if (kind) c.kind = kind;
  if (!c.kind) c.kind = 'text';

  const snap = timerSnapshot();
  log(`⏳ 验证码关卡出现（${CAPTCHA_KIND_LABEL[c.kind] || '验证码'}）· 现在剩余 ${snap.text} · 计时不会停`,
    snap.remaining < 120000 ? 'error' : 'warn');

  const focused = focusCaptchaInput();
  mountCaptchaBadge();
  startCaptchaTicker();
  notifySoon('验证码关卡',
    `${CAPTCHA_KIND_LABEL[c.kind] || '验证码'} · 当前剩余 ${snap.text}。`
    + `插件在这期间照常盯着余票，输入完就能直接用。`);
  if (!focused) log('没找到验证码输入框（可能还在渲染），已挂观察器等它出来', 'warn');
  maybeAutoStartOnGate();
  renderPanel();
}

/**
 * 只把光标放进去 —— **不写 value、不派发 input/change、不提交**。
 * 省掉的是"用眼睛找到那个框再点一下"，不是"人来认这张图"。
 */
function focusCaptchaInput() {
  let el = null;
  try { el = document.querySelector(CAPTCHA_SEL.input); } catch (e) { return false; }
  if (!el) return false;
  try {
    if (document.activeElement !== el) el.focus({ preventScroll: true });
  } catch (e) { /* 某些输入框不可聚焦，无所谓 */ }
  // 模态有开合动画，浏览器随后可能把焦点抢回去，所以在动画结束后再补一次
  setTimeout(() => {
    const cur = C();
    if (!cur.active) return;
    try {
      const again = document.querySelector(CAPTCHA_SEL.input);
      if (again && document.contains(again) && document.activeElement !== again) {
        again.focus({ preventScroll: true });
      }
    } catch (e) { /* noop */ }
  }, 700);
  return true;
}

// ---- 贴身徽标：把"还剩多久"放到你正在看的地方 ----

function mountCaptchaBadge() {
  unmountCaptchaBadge();
  const host = document.createElement('div');
  host.id = 'nol-scout-captcha';
  // max-width 是必须的：提示文案有时很长，不限制的话徽标会被撑成一条横贯半屏的条
  host.style.cssText = 'position:fixed;z-index:2147483200;pointer-events:none;max-width:340px;';
  const sh = host.attachShadow({ mode: 'open' });
  sh.innerHTML = `<style>
      :host{all:initial}
      .b{display:flex;flex-direction:column;gap:1px;padding:7px 11px;border-radius:9px;
         font:600 14px/1.35 ui-monospace,Menlo,"PingFang SC",monospace;font-variant-numeric:tabular-nums;
         background:#0f141c;color:#e8ecf3;border:1px solid #27303f;box-shadow:0 10px 30px rgba(0,0,0,.55)}
      .m{font-size:15px}
      .s{font-size:11px;font-weight:500;color:#93a3b8}
      .t{font-size:10.5px;font-weight:500;color:#8494a8}
      .ok{border-color:#1d4d2e}.ok .m{color:#86efac}
      .slow{border-color:#573f16}.slow .m{color:#fbbf24}
      .bad{border-color:#5b2326}.bad .m{color:#f87171}
      .expired{border-color:#5b2326}.expired .m{color:#f87171}
      .bad,.expired{animation:nolCapPulse 1s ease-in-out infinite}
      @keyframes nolCapPulse{0%,100%{opacity:1}50%{opacity:.5}}
    </style>
    <div class="b ok" id="b"><div class="m" id="m">--</div><div class="s" id="s"></div><div class="t" id="t"></div></div>`;
  (document.body || document.documentElement).appendChild(host);
  C().badge = host;
  positionCaptchaBadge();
  paintCaptchaBadge();
}

/** 尽量贴在验证码框正上方；框找不到就退回屏幕顶部居中 */
function positionCaptchaBadge() {
  const host = C().badge;
  if (!host) return;
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 900;
  let anchor = null;
  try { anchor = document.querySelector(CAPTCHA_SEL.box); } catch (e) { /* noop */ }
  const r = anchor?.getBoundingClientRect?.();
  if (r && r.width > 0 && r.height > 0) {
    // 用徽标**自己的高度**算，才能保证底边正好压在框顶上方 —— 写死偏移量会在
    // 多出一行提示时让徽标盖住验证码图（实测就踩过：固定 52px 对 67px 高地盖了 16px）
    const h = host.getBoundingClientRect().height || 64;
    const left = Math.min(Math.max(8, r.left), Math.max(8, vw - 340));
    const above = r.top - h - 8;
    const top = above >= 8 ? above : Math.min(r.bottom + 10, vh - h - 8);
    host.style.transform = 'none';
    host.style.left = Math.round(left) + 'px';
    host.style.top = Math.round(Math.max(8, top)) + 'px';
    return;
  }
  host.style.left = '50%';
  host.style.top = '18px';
  host.style.transform = 'translateX(-50%)';
}

function paintCaptchaBadge() {
  const spec = captchaSpecNow();
  const host = C().badge;
  const sh = host?.shadowRoot;
  if (!sh) { paintPanelCaptchaRow(); return; }
  sh.getElementById('b').className = 'b ' + spec.tone;
  sh.getElementById('m').textContent = spec.main;
  sh.getElementById('s').textContent = spec.sub + (spec.tip ? ' ' + spec.tip : '');
  sh.getElementById('t').textContent = spec.advice;
  paintPanelCaptchaRow();
}

/** 当前该显示什么：徽标和面板横幅共用这一份，避免两边文案走偏 */
function captchaSpecNow() {
  const snap = timerSnapshot();
  const spec = captchaBadge({
    remainingText: snap.text,
    elapsedMs: captchaElapsed(),
    kind: C().kind,
    expired: snap.state === 'dead',
  });
  spec.advice = gateAdvice({
    monitoring: !!state.monitor,
    autoStartEnabled: !!state.prefs.captchaAutoStart,
    ready: pageReady(),
  }).text;
  return spec;
}

/** 只改那几个文本节点 —— 面板有上万节点的地图，不能为了一个秒数整块重建 */
function paintPanelCaptchaRow() {
  const root = state.panel?.root;
  if (!root?.getElementById) return;
  const spec = captchaSpecNow();
  const main = root.getElementById('capMain');
  if (!main) return;
  main.textContent = spec.main;
  const sub = root.getElementById('capSub');
  if (sub) sub.textContent = spec.sub + (spec.tip ? ' ' + spec.tip : '');
  const adv = root.getElementById('capAdv');
  if (adv) adv.textContent = spec.advice;
  const box = root.getElementById('capBanner');
  if (box) box.className = 'banner cap ' + spec.tone;
}

function unmountCaptchaBadge() {
  try { C().badge?.remove?.(); } catch (e) { /* noop */ }
  C().badge = null;
}

let captchaTickId = null;
function startCaptchaTicker() {
  if (captchaTickId) return;
  captchaTickId = setInterval(() => {
    const c = C();
    if (!c.active) return stopCaptchaTicker();
    positionCaptchaBadge();   // 模态可能会动（换行、报错文案撑高），跟着走
    paintCaptchaBadge();
    // 卡太久：大概率输错了或看不懂，再响一声，避免人已经走神
    if (!c.stuckWarned && captchaElapsed() >= CAPTCHA_STUCK_MS) {
      c.stuckWarned = true;
      log(`⚠ 验证码已卡 ${formatElapsed(captchaElapsed())}，是不是输错了？剩余 ${timerSnapshot().text}`, 'error');
      notifySoon('验证码卡住了', `已用 ${formatElapsed(captchaElapsed())}，剩余 ${timerSnapshot().text}`);
    }
  }, 500);
}
function stopCaptchaTicker() {
  if (!captchaTickId) return;
  clearInterval(captchaTickId);
  captchaTickId = null;
}

/** 收到 verify 响应（权威）或发现验证码框消失（兜底）后收尾 */
function captchaFinish(ok, why) {
  const c = C();
  if (!c.active) return;
  const ms = captchaElapsed();
  c.elapsed = ms;
  c.totalMs = (c.totalMs || 0) + ms;

  if (ok === false) {
    // 输错了：人还停在同一张图上，只把这一轮的秒表重新起，别当成关卡结束。
    // （否则徽标会停住不动、耗时也不再累计，用户反而更慌）
    c.attempts += 1;
    c.passed = false;
    c.seenAt = Date.now();
    c.stuckWarned = false;
    log(`❌ 验证码未通过（${why || '服务端返回 N'}）· 本轮 ${formatElapsed(ms)} · 累计 ${formatElapsed(c.totalMs)}`
      + ` · 剩余 ${timerSnapshot().text}，再试一次`, 'error');
    notifySoon('验证码错误', `再试一次。本轮 ${formatElapsed(ms)}，剩余 ${timerSnapshot().text}`);
    paintCaptchaBadge();
    renderPanel();
    return;
  }

  // 通过 / 结果未知：都按"关卡结束"处理，免得徽标赖着不走
  c.active = false;
  c.passed = ok === true ? true : null;
  c.attempts += 1;
  c.needGone = true;          // 等这个框消失，再允许把下一个验证码当成新关卡
  stopCaptchaTicker();

  if (ok === true) {
    c.history.push({ at: Date.now(), ms, totalMs: c.totalMs, kind: c.kind, attempts: c.attempts });
    if (c.history.length > 20) c.history = c.history.slice(-20);
    const retries = '';
    log(captchaSummary({ elapsedMs: c.totalMs, attempts: c.attempts, remainingText: timerSnapshot().text }) + retries,
      c.totalMs >= 12000 ? 'warn' : 'hit');
    // 只把「这一关总共花了多久」记下来；答案本身从来不碰
    noteCaptchaCost(c.totalMs, c.attempts, c.kind);
    if (state.monitor) maybeEvaluate('captcha-passed');
  } else {
    log(`🔎 验证码框已消失，但没读到服务端结果（本轮 ${formatElapsed(ms)}）`, 'warn');
  }
  setTimeout(unmountCaptchaBadge, 1400);   // 留一会儿，让人看见自己花了多久
  renderPanel();
}

/** 把这一关的耗时记进日志区上方的一行，供面板/后续参考 */
function noteCaptchaCost(totalMs, attempts, kind) {
  const c = C();
  c.lastCost = { at: Date.now(), totalMs, attempts, kind: kind || 'text' };
}

/** 验证码框消失但没等到 verify 响应：多半是过了（也可能整个 step 被切走） */
function captchaMaybeGone() {
  const c = C();
  if (!c.active) return;
  if (c.lastGoneAt && Date.now() - c.lastGoneAt < 1500) return;
  c.lastGoneAt = Date.now();
  setTimeout(() => {
    if (!C().active) return;
    let still = null;
    try { still = document.querySelector(CAPTCHA_SEL.box); } catch (e) { /* noop */ }
    if (!still) captchaFinish(null, '验证码框已消失，未能读到服务端结果');
  }, 1200);
}

/**
 * 观察验证码模态的出现与消失。
 * 用 MutationObserver + 250ms 尾部去抖：模态是插入/移除的，轮询会慢半拍，
 * 但每次 DOM 变动都跑一次 querySelector 又太贵。
 */
let captchaMoDom = null;
function captchaWatchStart() {
  if (captchaMoDom) return;
  const target = document.documentElement;
  if (!target) return;
  const check = () => {
    let box = null;
    try { box = document.querySelector(CAPTCHA_SEL.box); } catch (e) { /* noop */ }
    if (box) {
      if (C().needGone) return;      // 通关后同一张图还没移走，别把旧关卡当新的
      const kind = captchaKindFromClass(box.className || box.parentElement?.className || '');
      captchaAppear('dom', kind);
      if (!C().inputReadyNoted && document.querySelector('input[class*="captchaInput"], [class*="captchaInput"] input')) {
        C().inputReadyNoted = true;
        focusCaptchaInput();
        log('验证码输入框已就绪' + (state.prefs.captchaAutoSolve ? '，准备自动填写' : '；自动填写未开启，请在插件设置中开启或手动输入'));
      }
      maybeSolveCaptcha();
      if (C().badge) positionCaptchaBadge();
    } else {
      // 框真的消失了 → 重新武装，下一次出现的才是新关卡
      if (C().needGone) C().needGone = false;
      captchaMaybeGone();
    }
  };
  captchaMoDom = watchCaptchaDom(document, check, () => C().active || C().needGone);

}

/**
 * 可选的"验证码期自动开扫"。
 * 默认关闭：用户明确要过"由我点开始"，所以这里不擅自开，只在开关打开时才动。
 */
function maybeAutoStartOnGate() {
  const c = C();
  if (state.monitor) return;
  if (!state.prefs.captchaAutoStart) return;
  if (!pageReady()) { c.wantAutoStart = true; return; }
  autoStartScan('验证码关卡');
}

async function autoStartScan(why) {
  const c = C();
  if (state.monitor || !pageReady()) return;
  c.wantAutoStart = false;
  try {
    await startMonitor(adHocTask());
    log(`⏱ 已在「${why}」期间自动开扫 —— 这几秒不空转`, 'hit');
  } catch (e) {
    log('自动开扫失败：' + e.message, 'warn');
  }
}



let catalogBuildTimer = null;
function scheduleCatalogBuild() {
  clearTimeout(catalogBuildTimer);
  catalogBuildTimer = setTimeout(() => {
    if (state.catalog) return;
    ensureCatalog(false).catch((e) => log('目录构建跳过：' + e.message, 'warn'));
  }, 2000);
}

// 旁听页面自己的请求：拿上下文 + 顺带把页面拉的余票/座位数据收进来
function onPassiveApi({ url, status, text, requestSeatIds }) {
  if (!url) return;
  if (url.includes('/onestop/api/seats/select')) {
    let outcome = 'unknown';
    try { if (status >= 200 && status < 300) outcome = lockOutcome(JSON.parse(text)); } catch (e) { /* unknown */ }
    state.automation.lockReceipt = { ids: requestSeatIds || [], outcome, at: Date.now() };
  }
  if (url.includes('/onestop/gql')) {
    try { const init = JSON.parse(text)?.data?.initSeat; if (init) state.ticketMaxCount = Number(init.ticketMaxCount) || 0; } catch (e) { /* noop */ }
  }
  const q = parseQuery(url);
  if (q.playSeq) state.playSeq = q.playSeq;
  if (q.goodsCode) state.goodsCode = q.goodsCode;
  if (q.placeCode) state.placeCode = q.placeCode;
  if (q.bizCode) state.bizCode = q.bizCode;

  if (url.includes('/onestop/api/seatStatus')) {
    let json; try { json = JSON.parse(text); } catch (e) { return; }
    const keys = q.blockKeys || [];
    (json.data || []).forEach((str, i) => {
      if (keys[i]) { state.status[keys[i]] = str; state.lastSeenAt[keys[i]] = Date.now(); }
    });
    if (state.monitor) state.monitor.passiveSeen = (state.monitor.passiveSeen || 0) + 1;
    maybeEvaluate('passive');
    renderPanel();
  }
  if (url.includes('_next/data') && url.includes('seat.json')) {
    // 站点切到选座页，说明会话有效
    pushState();
  }
  // 页面自己的验证码请求：image = 关卡出现（权威信号，比 DOM 早一拍）；
  // verify = 交答案。注意**只取结果**——答案挂在 p1 上，不读也不记
  //（stripCaptchaAnswer 只用于"万一要打 URL"的场合，避免把答案写进日志）。
  const capStage = captchaStage(url);
  if (capStage === 'image') {
    captchaAppear('hook', '');
    try {
      const image = JSON.parse(text)?.Img;
      if (typeof image === 'string' && image.startsWith('data:image/')) {
        if (state.automation.captchaImage !== image) {
          state.automation.captchaImage = image;
          state.automation.captchaGeneration++;
        }
        maybeSolveCaptcha();
      }
    } catch (e) { /* wait for next image */ }
  } else if (capStage === 'verify') {
    const ok = captchaPassed(text);
    if (ok === true) captchaFinish(true);
    else if (ok === false) captchaFinish(false, '服务端返回未通过');
    else {
      // 响应体不是预期 JSON：打日志时把 p1（答案）抹掉，别把用户的输入留进日志
      log(`验证码请求已发出但响应格式异常（…${stripCaptchaAnswer(url).slice(-70)}）`, 'warn');
    }
  }
  // 页面自己在轮询 ExpiredSession，我们只读旁听，不额外发请求
  if (url.includes('/onestop/gql') && typeof text === 'string' && text.includes('isExpiredSession')) {
    try {
      const json = JSON.parse(text);
      if (typeof json?.data?.isExpiredSession === 'boolean') noteServerExpired(json.data.isExpiredSession);
    } catch (e) { /* 不是 JSON 就忽略 */ }
  }
}

function parseQuery(url) {
  const out = {};
  const qi = url.indexOf('?');
  if (qi === -1) return out;
  for (const pair of url.slice(qi + 1).split('&')) {
    const [k, v] = pair.split('=');
    if (!k) continue;
    const val = decodeURIComponent(v || '');
    if (k === 'blockKeys' || k === 'blockKeys[]') (out.blockKeys ||= []).push(val);
    else out[k] = val;
  }
  return out;
}

function ctx() {
  return { channel: state.channel || DEFAULT_CTX.channel, session: state.session, lang: state.lang || DEFAULT_CTX.lang };
}

let pushTimer = null;
function pushState() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'SEAT_STATE', state: publicState() }).catch(() => {});
  }, 400);
}

// ---------------- 捡漏参数（popup 与页面面板共用同一份，存在 storage.local.scoutPrefs） ----------------

const PREFS_KEY = 'scoutPrefs';

async function loadPrefs() {
  const st = await chrome.storage.local.get(PREFS_KEY).catch(() => ({}));
  state.prefs = normalizePrefs(st?.[PREFS_KEY] || DEFAULT_SCOUT_PREFS);
  return state.prefs;
}

async function savePrefs(patch) {
  state.prefs = normalizePrefs({ ...state.prefs, ...patch });
  if (patch.autoLock === false) pageCommand('cancel').catch(() => {});
  // 不能读写同一个对象：normalizePrefs 返回新对象，但 grades/regions 是数组，浅拷贝即可
  await chrome.storage.local.set({ [PREFS_KEY]: state.prefs }).catch(() => {});
  return state.prefs;
}

// 扫描中改范围不会影响"已经在跑的那条任务"（任务在启动时就把范围固化了），
// 所以必须明确说一句，免得用户以为点了没生效。
function noteScopeChange(what) {
  if (state.monitor) log(`${what}已改 —— 重启扫描后生效`, 'warn');
}

// popup 改了参数 → 页面面板立刻同步（反之亦然）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[PREFS_KEY]) return;
  const next = normalizePrefs(changes[PREFS_KEY].newValue || DEFAULT_SCOUT_PREFS);
  // 自己刚写进去的那份已经在本地重绘过了；这里再去重绘一次等于把整张地图画两遍。
  if (JSON.stringify(next) === JSON.stringify(state.prefs)) return;
  state.prefs = next;
  if (!next.autoLock) pageCommand('cancel').catch(() => {});
  renderPanel();
  maybeSolveCaptcha();
  if (state.monitor) maybeEvaluate('settings-changed');
  if (state.panel?.root) syncScopeUI(state.panel.root);
  else renderPanel();
});

/** 当前页面是否已经具备"可以开始扫"的条件 */
function pageReady() {
  return !!(state.session && state.catalog);
}

/** 用页面自身上下文 + 用户参数造一条现场任务（不需要 popup 里再新建） */
function adHocTask() {
  return buildAdHocTask({
    goodsCode: state.goodsCode,
    placeCode: state.placeCode,
    bizCode: state.bizCode,
    playSeq: state.playSeq,
  }, state.prefs);
}

/** 发给 background 的任务快照（字段与 service-worker 的 publicTask 对齐 + url/状态） */
function taskForBackground(task) {
  return {
    id: task.id, mode: 'seat', adHoc: true, name: task.name, status: task.status,
    createdAt: task.createdAt,
    goodsCode: task.goodsCode, placeCode: task.placeCode, bizCode: task.bizCode,
    url: task.url, entryUrl: task.entryUrl || null,
    playSeqs: task.playSeqs || [], grades: task.grades || [], regions: task.regions || [],
    quantity: task.quantity || 1, preference: task.preference || 'any',
    stageSide: task.stageSide || 'top',
    intervalMs: task.intervalMs || 2800,
  };
}

function adoptTask(task) {
  chrome.runtime.sendMessage({ type: 'ADOPT_SEAT_TASK', task: taskForBackground(task) }).catch(() => {});
}

function releaseTask() {
  chrome.runtime.sendMessage({ type: 'SEAT_SCAN_STOPPED' }).catch(() => {});
}

// ---------------- 目录构建 ----------------

async function ensureCatalog(force = false) {
  const key = [state.goodsCode, state.placeCode, state.playSeq].join('|');
  if (state.catalog && state.catalogKey === key && !force) return state.catalog;
  if (!state.goodsCode || !state.placeCode || !state.playSeq) {
    throw new Error('还没拿到商品/场次信息——请先在本页完成一次正常进入（排队 + 验证码），或直接刷新一次本页');
  }
  log('正在构建座位目录（区块 / 区域 / 价位 / 座位坐标）…');
  const c = ctx();
  const base = {
    goodsCode: state.goodsCode, placeCode: state.placeCode,
    playSeq: state.playSeq, bizCode: state.bizCode || '10965',
  };
  const blockData = await getBlockData(base, c);
  let gradeColors = [];
  try { gradeColors = await getGradePrices({ playSeq: state.playSeq }, c); } catch (e) { /* 可选 */ }
  if (!gradeColors.length) {
    try { gradeColors = await getSeatGrades(base, c); } catch (e) { /* 可选 */ }
  }
  await sleep(120);
  const seatMeta = await getSeatMeta(base, blockData.map((b) => b.blockKey), c, { chunkSize: 2, gapMs: 140 });
  const catalog = buildCatalog({ blockData, seatMeta, gradeColors });
  state.catalog = catalog;
  state.catalogKey = key;
  state.locator = null;   // 目录变了，定位标定作废重算
  const summary = summarizeCatalog(catalog);
  await chrome.storage.local.set({ [`catalog:${key}`]: summary, lastCatalog: summary }).catch(() => {});
  log(`目录就绪：${catalog.blocks.length} 区块 / ${catalog.regions.length} 区域 / ${catalog.grades.length} 价位 / ${catalog.blocks.reduce((n, b) => n + b.seatCount, 0)} 座位`);
  renderPanel();
  // 目录是在验证码期间才建出来的：如果用户此刻正卡在验证码上、又开了自动开扫开关，
  // 就趁这个机会把扫描拉起来 —— 这就是"那 8 秒不空转"真正落地的地方。
  if (state.captcha.active && state.captcha.wantAutoStart) maybeAutoStartOnGate();
  return catalog;
}

function summarizeCatalog(c) {
  return {
    builtAt: c.builtAt,
    canvas: c.canvas,
    grades: c.grades.map((g) => ({ name: g.name, grade: g.grade, price: g.price, color: g.color, seatCount: g.seatCount })),
    regions: c.regions.map((r) => ({ name: r.name, seatCount: r.seatCount, gradeCounts: r.gradeCounts, blockKeys: r.blockKeys })),
    // gradeNos 是筛选的关键：popup 也要按"档位号"配对区块，才能和页面面板算出同一份选区
    blocks: c.blocks.map((b) => ({
      key: b.key, region: b.region, box: b.box, seatCount: b.seatCount,
      exposableCount: b.exposableCount, gradeNos: b.gradeNos,
      gradeCounts: b.gradeCounts, rows: b.rows.length,
    })),
  };
}

// ---------------- 监控循环 ----------------

function targetBlocks(task) {
  const c = state.catalog;
  if (!c) return [];
  // 过滤口径统一走 resolveScope，和面板地图上"选中了哪些块"是同一份逻辑。
  // （早期版本这里拿档位**号**去 gradeCounts 的档位**名**里找，一选价位目标区块就归零。）
  const scope = resolveScope({ grades: task.grades || [], regions: task.regions || [] }, c, { exposableOnly: false });
  return c.blocks.filter((b) => b.seatCount > 0 && scope.has(b.key)).map((b) => b.key);
}

async function startMonitor(task) {
  stopMonitor({ quiet: true });
  const t0 = timerSnapshot();
  if (t0.state === 'dead') {
    throw new Error('选座 10 分钟已经用完了（' + (t0.reason === 'server' ? '服务端已判定超时' : '时限已到') + '），请重新排队进入选座页');
  }
  await ensureCatalog(false);
  if (task.playSeqs?.length && state.playSeq && !task.playSeqs.includes(state.playSeq)) {
    throw new Error(`当前页面是第 ${state.playSeq} 场，不在任务选定场次（${task.playSeqs.join(', ')}）内`);
  }
  const blocks = targetBlocks(task);
  const ctrl = new AbortController();
  state.monitor = {
    task, ctrl, scans: 0, hits: 0, passiveSeen: 0, startedAt: Date.now(),
    blocks, lastHitAt: 0, lastResult: null,
  };
  adoptTask(task);          // 登记到后台，popup 的任务清单里会立刻出现"捡漏 · …"
  renderPanel();
  log(`监控启动：目标 ${blocks.length} 个区块 / 间隔 ${task.intervalMs || 2800}ms（${describePrefs(task)}）`);
  // 先把页面座位图标定好，命中时才能"秒级"落点
  ensureLocator({ quiet: true }).then((l) => {
    if (l?.cal) renderPanel();
  }).catch(() => {});
  loop(task, blocks, ctrl).catch((e) => { if (!ctrl.signal.aborted) log('监控异常：' + e.message, 'error'); });
  return { blocks: blocks.length, catalog: summarizeCatalog(state.catalog) };
}

function stopMonitor({ quiet = false } = {}) {
  if (!state.monitor) return;
  state.monitor.ctrl.abort();
  if (state.automation.busy) pageCommand('cancel').catch(() => {});
  state.monitor = null;
  clearOverlay();
  renderPanel();
  log('监控已停止');
  if (!quiet) releaseTask();
}

async function loop(task, blocks, ctrl) {
  const base = Math.max(task.intervalMs || 2800, MIN_INTERVAL_MS);
  let errStreak = 0;
  while (!ctrl.signal.aborted) {
    // 选座时间结束就别再浪费请求了
    if (timerSnapshot().state === 'dead') { handleTimerExpired(timerSnapshot()); return; }
    try {
      const snap = await getSeatStatus(
        {
          goodsCode: state.goodsCode, placeCode: state.placeCode,
          playSeq: state.playSeq, bizCode: state.bizCode || '10965',
        },
        blocks, ctx(), { chunkSize: 16, signal: ctrl.signal },
      );
      const now = Date.now();
      for (const [k, v] of Object.entries(snap)) {
        state.prevStatus[k] = state.status[k];
        state.status[k] = v;
        state.lastSeenAt[k] = now;
      }
      errStreak = 0;
      if (state.monitor) state.monitor.scans++;
      await maybeEvaluate('poll');
    } catch (e) {
      if (ctrl.signal.aborted) return;
      errStreak++;
      log('轮询失败：' + e.message, 'error');
      if (/HTTP 401|HTTP 403/.test(e.message)) log('会话可能已失效，请刷新座位页并重走一次排队', 'error');
    }
    await sleepInterruptible(errStreak ? Math.min(base * 2 ** errStreak, 30000) : jitter(base), ctrl);
    if (!ctrl.signal.aborted) renderPanel();
  }
}

let evaluating = false;
async function maybeEvaluate(trigger) {
  if (!state.monitor || evaluating) return;
  evaluating = true;
  try {
    const m = state.monitor;
    const res = matchSnapshot(m.task, state.catalog, state.status, state.prevStatus);
    m.lastResult = res;
    if (res.hit && res.best) await maybeLockBest(res.best, m);
    if (state.monitor !== m) return;
    if (res.hit && res.best) {
      const now = Date.now();
      if (now - (m.lastHitAt || 0) > (m.task.cooldownMs || 15000)) {
        m.lastHitAt = now;
        m.hits++;
        log(`命中：${hitSummary(res.best)}（${res.best.gradeNames.join('/') || res.best.grade}）`, 'hit');
        state.zoom = { blockKey: res.best.blockKey, seat: res.best.seats[0] };
        renderPanel();
        const placed = await locateOnPage(res.best, { auto: true });
        chrome.runtime.sendMessage({
          type: 'SEAT_HIT',
          taskId: m.task.id,
          hit: {
            message: res.message,
            summary: hitSummary(res.best),
            freeSeats: res.freeSeats,
            blocksWithFree: res.blocksWithFree,
            runs: res.runs.slice(0, 10),
            best: res.best,
            trigger,
            at: now,
            located: placed?.ok ? (placed.matched || 0) : -1,
            locateConfidence: placed?.confidence || (state.locator?.cal?.confidence ?? null),
          },
        }).catch(() => {});
      }
    }
  } finally {
    evaluating = false;
  }
}

// ---------------- 本地文字验证码与自动锁票 ----------------
function captchaAutoNote(reason) {
  if (state.automation.captchaNote === reason) return;
  state.automation.captchaNote = reason;
  log(reason, 'warn');
}
async function maybeSolveCaptcha() {
  const a = state.automation;
  if (!C().active || a.ocrBusy || timerSnapshot().state === 'dead') return;
  if (!state.prefs.captchaAutoSolve) { captchaAutoNote('自动填写验证码已关闭；请在插件设置中勾选并保存'); return; }
  if (C().kind === 'slider') { captchaAutoNote('当前为滑块验证码，请手动完成'); return; }
  const controls = captchaDomStatus(document);
  if (controls.reason) { captchaAutoNote(controls.reason); return; }
  const { input, button } = controls;
  const image = controls.image.src || a.captchaImage;
  // 确认按钮在输入六位前本来就是 disabled，不能在填写前因此退出。
  if (!image?.startsWith('data:image/')) { captchaAutoNote('等待验证码图片地址就绪'); return; }
  if (input.value) return;
  const generation = a.captchaGeneration;
  if (a.ocrTried.has(image)) return;
  a.ocrTried.add(image);
  a.ocrBusy = true;
  const session = state.session;
  a.ocrRequestId = crypto.randomUUID();
  log('正在本地识别文字验证码…');
  let ocrTimeout;
  try {
    const result = await Promise.race([
      chrome.runtime.sendMessage({ type: 'OCR_CAPTCHA', image, requestId: a.ocrRequestId }),
      new Promise((_, reject) => { ocrTimeout = setTimeout(() => reject(new Error('本地识别等待超过 15 秒，请手动输入')), 15000); }),
    ]);
    clearTimeout(ocrTimeout);
    if (!state.prefs.captchaAutoSolve || !C().active || timerSnapshot().state === 'dead') return;
    // 页面先渲染、钩子后读完同一张图时 generation 可能改变；只丢弃实际图片/会话已经变更的结果。
    if (session !== state.session || !input.isConnected || controls.image.src !== image) {
      log('本地识别已返回，但验证码图片或会话已更新，等待当前图片', 'warn');
      a.ocrTried.delete(image);
      return;
    }
    if (input.value) { log('本地识别已返回，输入框已有内容，保留你的输入'); return; }
    log(`本地识别已完成（置信度 ${Math.round(result?.confidence || 0)}）`);
    const answer = normalizeOcrAnswer(result?.text);
    if (!answer || !(result.confidence >= 40)) throw new Error(result?.error || '识别置信度不足，请手动输入');
    // React 受控输入：原生 setter + input 事件，让页面更新答案并生成验证签名。
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, answer);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 20 && button.disabled; i++) await sleep(50);
    if (!state.prefs.captchaAutoSolve || !C().active || !button.isConnected || session !== state.session || controls.image.src !== image || input.value !== answer) return;
    if (button.disabled) { log('验证码已填写，但页面确认按钮仍未启用，请检查页面提示', 'warn'); return; }
    button.click();
    log('已提交本地识别结果，等待页面验证');
  } catch (e) { log(e.message, 'warn'); }
  finally {
    clearTimeout(ocrTimeout);
    a.ocrBusy = false;
    if (a.captchaGeneration !== generation && state.prefs.captchaAutoSolve) setTimeout(maybeSolveCaptcha, 0);
  }
}

const pagePending = new Map();
window.addEventListener('message', ev => {
  const d = ev.data;
  if (ev.source !== window || ev.origin !== location.origin || d?.__tag !== 'nol-scout-page' || d.type !== 'result') return;
  const pending = pagePending.get(d.id);
  if (!pending) return;
  pagePending.delete(d.id); clearTimeout(pending.timer); pending.resolve(d.payload);
});
function pageCommand(action, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pagePending.delete(id); reject(new Error('页面操作超时')); }, action === 'lock' ? 45000 : 3000);
    pagePending.set(id, { resolve, timer });
    window.postMessage({ __tag: 'nol-scout-page', type: 'command', id, action, payload }, location.origin);
  });
}

async function maybeLockBest(run, monitor) {
  const a = state.automation;
  if (!state.prefs.autoLock || a.busy || a.locked || a.uncertain || timerSnapshot().state === 'dead' || Date.now() - a.lastAttempt < 3000) return;
  const session = state.session;
  const scene = [state.goodsCode, state.placeCode, state.playSeq].join('|');
  a.busy = true;
  a.lastAttempt = Date.now();
  let sent = false;
  try {
    const status = await pageCommand('status');
    if (!status.verified || status.session !== session) return;
    if (document.querySelector(CAPTCHA_SEL.box)) return;
    if (status.selectedIds?.length) throw new Error('页面已有选中座位，请先人工确认');
    C().passed = true;
    const quantity = monitor.task.quantity || 1;
    if (state.ticketMaxCount && quantity > state.ticketMaxCount) throw new Error(`本场最多可选 ${state.ticketMaxCount} 张`);
    const payload = makeLockPayload(state, run, quantity);
    const fresh = await getSeatStatus(state, [run.blockKey], ctx(), { signal: monitor.ctrl.signal });
    const block = state.catalog.blocks.find(b => b.key === run.blockKey);
    const flags = decodeBlockStatus(fresh[run.blockKey], block?.seats.length || 0);
    if (payload.seats.some(s => !flags[block?.seats.findIndex(x => x.id === s.seatInfoId)])) return;
    // 取原始元数据，保留 seatGroupId / floor 等页面原生校验需要的字段。
    const meta = await getSeatMeta(state, [run.blockKey], ctx(), { signal: monitor.ctrl.signal });
    const originals = meta.flatMap(b => b.seats || []);
    const seats = payload.seats.map(target => originals.find(s => s.seatInfoId === target.seatInfoId));
    if (seats.some(s => !s)) throw new Error('座位元数据不完整');
    if (state.monitor !== monitor || monitor.ctrl.signal.aborted || !state.prefs.autoLock || session !== state.session || scene !== [state.goodsCode, state.placeCode, state.playSeq].join('|') || timerSnapshot().state === 'dead') return;
    log(`正在通过页面预选并锁票：${hitSummary(run)}`);
    a.lockReceipt = null;
    sent = true;
    const result = await pageCommand('lock', { session, goodsCode: state.goodsCode, placeCode: state.placeCode, playSeq: state.playSeq, blockKey: run.blockKey, seats });
    // 原生回调进入 price + 实际锁票响应，两者同时成立才算完成。
    await sleep(100);
    const receipt = a.lockReceipt;
    const ids = payload.seats.map(s => s.seatInfoId).sort();
    const receiptMatches = receipt?.ids?.length === ids.length && [...receipt.ids].sort().every((id, i) => id === ids[i]);
    if (result.outcome === 'locked' && receiptMatches && receipt.outcome === 'locked') {
      const selected = { ...run, seats: run.seats.slice(0, quantity), seatNos: run.seatNos.slice(0, quantity), len: quantity };
      a.locked = { seats: payload.seats, summary: hitSummary(selected), at: Date.now() };
      log(`✅ 锁票成功，已进入票价步骤：${a.locked.summary}`, 'hit');
      notifySoon('锁票成功', a.locked.summary);
      stopMonitor();
    } else {
      a.uncertain = result.uncertain !== false;
      log(result.error || '尚未同时确认服务器锁票结果和页面跳转，请检查页面', 'warn');
    }
  } catch (e) {
    if (sent) a.uncertain = true;
    if (!monitor.ctrl.signal.aborted || sent) log(sent ? '页面锁票结果未确认，自动操作暂停，请检查页面' : `锁票前检查失败：${e.message}`, 'warn');
  } finally { a.busy = false; renderPanel(); }
}

// ---------------- 页面座位图定位 ----------------

// 实测 DOM 契约（选座页 tickets.interpark.com/onestop）：
//   [class*="SeatMap_placeImg"]  <img>  场馆底图；naturalWidth/Height = 底图 viewBox 尺寸
//   [class*="SeatMap_seatGroup"] <svg>  座位层；页面在这里画座位，viewBox = 座位层坐标空间
//   [class*="MiniMap"]           <img>  右下角缩略导航图 —— 面积不算小，**必须显式排除**，
//                                       否则会被旧逻辑当成座位画布（这就是之前定位偏的根因之一）
// class 名带构建哈希（SeatMap_seatGroup__dH6wd），所以一律用前缀匹配。
const HL_CLASS = 'nol-scout-hl';
const SEAT_NODE_SEL = 'rect,circle,ellipse,path,polygon,use,image,line';

function parseViewBox(el) {
  const vb = el?.getAttribute?.('viewBox');
  if (!vb) return null;
  const p = vb.trim().split(/[\s,]+/).map(Number);
  if (p.length !== 4 || !p.every(Number.isFinite) || p[2] <= 0 || p[3] <= 0) return null;
  return { x: p[0], y: p[1], w: p[2], h: p[3] };
}
function isMini(el) { return !!el?.closest?.('[class*="MiniMap"]'); }
function isOurs(el) { return !!el?.closest?.('#nol-scout-host,#nol-scout-overlay'); }

function detectLayers() {
  const seatGroup = document.querySelector('[class*="SeatMap_seatGroup"]');
  const placeWrap = document.querySelector('[class*="SeatMap_placeImg"]');
  let seatSvg = null, baseEl = null;

  if (seatGroup) seatSvg = seatGroup.tagName?.toLowerCase() === 'svg' ? seatGroup : seatGroup.querySelector('svg');
  if (placeWrap) {
    const t = placeWrap.tagName?.toLowerCase();
    baseEl = (t === 'img' || t === 'svg') ? placeWrap : placeWrap.querySelector('img,svg');
  }
  // 兜底：类名或结构变了也能找（退化为"子图形最多的那个 svg / 自然尺寸最大的那个 img"）
  if (!seatSvg) {
    const svgs = [...document.querySelectorAll('svg')].filter((s) => {
      if (isMini(s) || isOurs(s)) return false;
      const r = s.getBoundingClientRect();
      return r.width >= 120 && r.height >= 120 && parseViewBox(s);
    });
    svgs.sort((a, b) => b.querySelectorAll(SEAT_NODE_SEL).length - a.querySelectorAll(SEAT_NODE_SEL).length);
    seatSvg = svgs[0] || null;
  }
  if (!baseEl) {
    const imgs = [...document.querySelectorAll('img')].filter((im) =>
      !isMini(im) && !isOurs(im) && im.getBoundingClientRect().width >= 120);
    imgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
    baseEl = imgs[0] || null;
  }
  return { seatSvg, baseEl };
}

// 座位层坐标 ↔ 屏幕坐标。svg 走 getScreenCTM()（页面缩放/平移/父级 transform 全自动涵盖），
// img 走 rect 比例（user space 取自然像素，同样与页面缩放解耦）。
function makeMapper(el) {
  if (!el) return null;
  const isSvg = el.tagName?.toLowerCase() === 'svg';
  if (isSvg) {
    const box = parseViewBox(el);
    const rectBox = () => {
      const r = el.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, w: box.w, h: box.h, r } : { x: 0, y: 0, w: r.width || 1, h: r.height || 1, r };
    };
    return {
      kind: 'svg', el, box,
      toScreen(x, y) {
        const m = el.getScreenCTM();
        if (m) {
          const pt = el.createSVGPoint(); pt.x = x; pt.y = y;
          const p = pt.matrixTransform(m);
          return { x: p.x, y: p.y, via: 'ctm' };
        }
        const b = rectBox();
        return { x: b.r.left + (x - b.x) * (b.r.width / b.w), y: b.r.top + (y - b.y) * (b.r.height / b.h), via: 'rect' };
      },
      fromScreen(cx, cy) {
        const m = el.getScreenCTM();
        if (m) {
          const inv = m.inverse();
          const pt = el.createSVGPoint(); pt.x = cx; pt.y = cy;
          const p = pt.matrixTransform(inv);
          return { x: p.x, y: p.y };
        }
        const b = rectBox();
        return { x: b.x + (cx - b.r.left) * (b.w / b.r.width), y: b.y + (cy - b.r.top) * (b.h / b.r.height) };
      },
    };
  }
  const nat = () => ({
    w: el.naturalWidth || el.getBoundingClientRect().width || 1,
    h: el.naturalHeight || el.getBoundingClientRect().height || 1,
  });
  const n0 = nat();
  return {
    kind: 'img', el, box: { x: 0, y: 0, w: n0.w, h: n0.h },
    toScreen(x, y) {
      const r = el.getBoundingClientRect(); const n = nat();
      return { x: r.left + x * (r.width / n.w), y: r.top + y * (n.h ? r.height / n.h : 1), via: 'img' };
    },
    fromScreen(cx, cy) {
      const r = el.getBoundingClientRect(); const n = nat();
      return { x: (cx - r.left) * (n.w / Math.max(1, r.width)), y: (cy - r.top) * (n.h / Math.max(1, r.height)) };
    },
  };
}

// 收集页面已渲染的座位元素，统一换算到**座位层 user space**（与页面缩放无关）
function collectPageSeats(map) {
  const out = [];
  if (!map?.el?.querySelectorAll) return out;
  for (const el of map.el.querySelectorAll(SEAT_NODE_SEL)) {
    if (isOurs(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const c = map.fromScreen(r.left + r.width / 2, r.top + r.height / 2);
    const tl = map.fromScreen(r.left, r.top);
    const br = map.fromScreen(r.right, r.bottom);
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    out.push({
      el, x: c.x, y: c.y,
      w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y),
      cx: r.left + r.width / 2, cy: r.top + r.height / 2,
    });
  }
  return out;
}

// 标定：页面座位（user space）↔ 接口座位坐标
async function ensureLocator({ force = false, quiet = false } = {}) {
  const { seatSvg, baseEl } = detectLayers();
  const layer = seatSvg || baseEl;
  const map = makeMapper(layer);
  if (!map) {
    state.locator = { ok: false, note: '页面上没找到座位层/底图' };
    if (!quiet) log('未找到页面座位图，请用面板内置座位图定位', 'warn');
    return null;
  }

  const raw = collectPageSeats(map);
  const pagePoints = dropOutliers(raw);
  const key = state.placeCode || 'unknown';
  const sig = [state.goodsCode, state.placeCode, state.playSeq].join('|')
    + `#${pagePoints.length}@${map.kind}${map.box ? `${Math.round(map.box.w)}x${Math.round(map.box.h)}` : ''}`
    + `@${state.catalog?.builtAt || 0}/${state.catalog?.blocks.length || 0}`;

  // 1) 缓存命中（同一场馆同一布局，不必每次重算）
  if (!force) {
    const stored = await chrome.storage.local.get(`locator:${key}`).catch(() => ({}));
    const c = stored?.[`locator:${key}`];
    if (c && c.sig === sig && c.confidence !== 'bad') {
      state.locator = { ok: true, map, pagePoints, cal: c, cached: true, note: c.note || '' };
      return state.locator;
    }
  }

  // 2) 用页面实际渲染的座位反解变换
  const catalog = state.catalog;
  let cal = null, setName = '—';
  if (catalog && pagePoints.length >= 8) {
    const sets = candidateApiSets(catalog);
    for (const set of sets) {
      const dc = Math.abs(set.pts.length - pagePoints.length) / Math.max(1, set.pts.length);
      // 数量差太多的候选直接跳过（除非只有"全部"这一个候选）
      if (set.name !== 'all' && dc > 0.3) continue;
      if (set.name === 'all' && dc > 0.3 && sets.length > 1) continue;
      const c = solveCalibration(set.pts, pagePoints);
      if (!c) continue;
      // 数量差异也计入评分：既要贴合，也要规模对得上
      const score = c.rel + dc * 0.5;
      if (!cal || score < (cal.__score ?? Infinity)) { cal = { ...c, __score: score }; setName = set.label; }
    }
  }

  if (cal) {
    delete cal.__score;
    cal.sig = sig; cal.setName = setName; cal.at = Date.now();
    cal.note = `对照「${setName}」的 ${pagePoints.length} 个页面座位`;
    state.locator = { ok: true, map, pagePoints, cal, cached: false, note: cal.note };
    await chrome.storage.local.set({ [`locator:${key}`]: cal }).catch(() => {});
    if (!quiet) {
      log(`定位标定：${describeCalibration(cal)}` + (cal.confidence === 'bad' ? '（建议点“重新标定”或用内置图）' : ''),
        cal.confidence === 'exact' ? 'info' : 'warn');
    }
    return state.locator;
  }

  // 3) 兜底：页面没有可用的座位元素（座位被画进底图位图之类），按底图尺寸推定
  const guessed = guessCalibration(catalog?.canvas, map.box || null);
  if (guessed) cal = { v: LOCATOR_VERSION, ...guessed, sig, at: Date.now() };
  state.locator = { ok: !!cal, map, pagePoints, cal, cached: false, note: cal?.note || '无法标定' };
  if (!quiet) log(`定位标定失败：${cal ? cal.note : '页面无座位层'}`, 'warn');
  return state.locator;
}

function clearOverlay() {
  if (state.overlay?.host) state.overlay.host.remove();
  if (state.overlay?.timer) clearInterval(state.overlay.timer);
  state.overlay = null;
  for (const el of document.querySelectorAll(`.${HL_CLASS}`)) el.classList.remove(HL_CLASS);
}

function ensureHlStyle() {
  if (document.getElementById('nol-scout-hl-style')) return;
  const s = document.createElement('style');
  s.id = 'nol-scout-hl-style';
  s.textContent = `.${HL_CLASS}{stroke:#f59e0b !important;stroke-width:3px !important;paint-order:stroke;`
    + `animation:nolScoutSeatPulse .85s ease-in-out infinite !important}`
    + `@keyframes nolScoutSeatPulse{0%,100%{opacity:1}50%{opacity:.3}}`;
  (document.head || document.documentElement).appendChild(s);
}

// 把命中座位定位到页面座位图上：
//   ① 接口坐标 --标定--> 座位层 user space --getScreenCTM--> 屏幕坐标
//   ② 能对上页面座位元素 → 直接给它加高亮类（像素级，用户点它就行）
//   ③ 对不上 → 画脉冲圆环兜底；两者都画，视觉上互相印证
//   ④ 页面滚动/缩放后按 user space 重算屏幕位置（所以缩放不跑偏）
function locateOnPage(run, { auto = false, retry = true, scroll = true } = {}) {
  if (!run?.seats?.length) return { ok: false, reason: '无座位数据' };
  const loc = state.locator;
  if (!loc?.map || !loc?.cal) {
    if (retry) {
      ensureLocator({ quiet: auto }).then((l) => { if (l?.cal) locateOnPage(run, { auto, retry: false, scroll }); });
      return { ok: false, reason: '正在标定' };
    }
    if (!auto) log('定位失败：页面座位图未标定，可点“重新标定”或用面板内置图', 'warn');
    return { ok: false, reason: '未标定' };
  }

  const { map, cal, pagePoints } = loc;
  const pts = run.seats.map((s) => ({ ...applyCalibration(cal, s) }));

  // 元素级配对（连座一般 ≤4 个，暴力最近邻足够）
  const tol = Math.max(0.6 * (cal.pitch || 1), 0.2);
  const used = new Set();
  const matched = [];
  for (const p of pts) {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < pagePoints.length; i++) {
      if (used.has(i)) continue;
      const d = Math.hypot(pagePoints[i].x - p.x, pagePoints[i].y - p.y);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi >= 0 && bd <= tol) { used.add(bi); matched.push({ ...pagePoints[bi], d: bd }); }
  }

  clearOverlay();
  ensureHlStyle();
  for (const m of matched) m.el.classList.add(HL_CLASS);

  const host = document.createElement('div');
  host.id = 'nol-scout-overlay';
  host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147482999;pointer-events:none';
  const style = document.createElement('style');
  style.textContent = '@keyframes nolScoutPulse{0%,100%{opacity:1}50%{opacity:.4}}';
  const rings = pts.map(() => {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;transform:translate(-50%,-50%);border-radius:50%;'
      + 'width:26px;height:26px;border:3px solid #f59e0b;'
      + 'box-shadow:0 0 0 3px rgba(245,158,11,.3),0 0 20px 6px rgba(245,158,11,.5);'
      + 'animation:nolScoutPulse .9s ease-in-out infinite';
    host.appendChild(d);
    return d;
  });
  const label = document.createElement('div');
  label.style.cssText = 'position:absolute;transform:translateX(-50%);background:#f59e0b;color:#1f2937;'
    + 'font:600 12px/1.5 -apple-system,"PingFang SC",sans-serif;padding:3px 8px;border-radius:6px;'
    + 'white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.35)';
  label.textContent = `${run.region || run.blockKey} · ${run.rowLabel} · ${run.seatNos.join(',')}`
    + (matched.length ? ` ★${matched.length}` : '');
  host.append(style, label);
  (document.body || document.documentElement).appendChild(host);

  const reposition = () => {
    if (!state.overlay) return;
    const scr = pts.map((p) => map.toScreen(p.x, p.y));
    for (let i = 0; i < scr.length; i++) {
      rings[i].style.left = `${scr[i].x + window.scrollX}px`;
      rings[i].style.top = `${scr[i].y + window.scrollY}px`;
    }
    const c0 = scr[0];
    label.style.left = `${c0.x + window.scrollX}px`;
    label.style.top = `${c0.y + window.scrollY - 30}px`;
  };
  reposition();

  state.overlay = { host, run, pts, map, matched, reposition, timer: null };
  const onMove = () => reposition();
  window.addEventListener('scroll', onMove, { passive: true, capture: true });
  window.addEventListener('resize', onMove, { passive: true });
  // 页面自己缩放地图（容器尺寸/transform 变化）时也重新落点
  state.overlay.timer = setInterval(() => {
    if (!state.overlay || !document.body.contains(host)) { clearOverlay(); return; }
    reposition();
  }, 500);

  state.seatCanvas = {
    kind: map.kind, mode: cal.confidence, setName: cal.setName,
    pageSeats: pagePoints.length, matched: matched.length,
    viewBox: map.box ? `${Math.round(map.box.w)}×${Math.round(map.box.h)}` : '',
  };

  if (scroll) {
    if (matched.length) matched[0].el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    else {
      const s0 = map.toScreen(pts[0].x, pts[0].y);
      window.scrollTo({
        left: Math.max(0, s0.x + window.scrollX - window.innerWidth / 2),
        top: Math.max(0, s0.y + window.scrollY - window.innerHeight / 2),
        behavior: 'smooth',
      });
    }
  }

  if (!auto) {
    log(matched.length
      ? `已精确定位到页面座位元素（${matched.length} 个，残差 ${(cal.rel * 100).toFixed(0)}% 座距）→ ${hitSummary(run)}`
      : `已在页面座位图上画出标记（未匹配到座位元素，标定置信度 ${cal.confidence}）→ ${hitSummary(run)}`,
      matched.length ? 'hit' : 'warn');
  }
  renderPanel();
  return { ok: true, matched: matched.length, confidence: cal.confidence };
}

// ---------------- 面板 ----------------

function log(msg, level = 'info') {
  state.logLines.push({ t: Date.now(), level, msg });
  if (state.logLines.length > 150) state.logLines = state.logLines.slice(-150);
  console.log('[NOL Scout]', msg);
  renderPanel();
}

// ---------------- 面板位置 ----------------
//
// 默认贴在**页面左边**：NOL 的选座区域在页面中右侧，面板贴右会直接压住座位图，
// 挡着选座。贴左之后仍然允许拖动，位置落进 storage 记住 —— 否则刷新一次白拖一次。

const PANEL_POS_KEY = 'panelPos';
const PANEL_DEFAULT_TOP = 80;

/** 把面板放到 (left, top)，夹进视口后写回 DOM。返回最终落点。 */
function applyPanelPos(left, top) {
  const host = state.panel?.host;
  if (!host) return null;
  const r = host.getBoundingClientRect();
  const final = clampPanelPos(left, top, {
    w: Math.round(r.width) || PANEL_DEFAULT_W,
    h: Math.round(r.height) || PANEL_DEFAULT_H,
    vw: window.innerWidth || 1280,
    vh: window.innerHeight || 900,
  });
  host.style.right = 'auto';
  host.style.left = final.left + 'px';
  host.style.top = final.top + 'px';
  state.panelPos = final;
  return final;
}

async function loadPanelPos() {
  const st = await chrome.storage.local.get(PANEL_POS_KEY).catch(() => ({}));
  state.panelPos = normalizePanelPos(st?.[PANEL_POS_KEY]);
  if (state.panelPos) applyPanelPos(state.panelPos.left, state.panelPos.top);
  return state.panelPos;
}

async function savePanelPos(pos) {
  if (!pos) return;
  state.panelPos = pos;
  await chrome.storage.local.set({ [PANEL_POS_KEY]: pos }).catch(() => {});
}

/** 贴左 / 贴右 一键切换（有些场次的座位图整体偏左） */
function flipPanelSide() {
  const host = state.panel?.host;
  if (!host) return;
  const r = host.getBoundingClientRect();
  const next = mirrorPanelPos({ left: r.left, top: r.top }, {
    w: Math.round(r.width) || PANEL_DEFAULT_W,
    vw: window.innerWidth || 1280,
  });
  const final = applyPanelPos(next.left, next.top);
  savePanelPos(final);
  const onLeft = (final?.left ?? 0) <= PANEL_MARGIN + 1;
  log(onLeft ? '面板已贴到左侧（默认位，避开选座区域）' : '面板已贴到右侧');
}

// 窗口尺寸变了要重新夹一次，不然面板可能已经被推到视口外（标题栏都抓不到）
window.addEventListener('resize', () => {
  if (!state.panel?.host || !state.panelPos) return;
  applyPanelPos(state.panelPos.left, state.panelPos.top);
});

function ensurePanel() {
  if (state.panel) return state.panel;
  const rootEl = document.body || document.documentElement;
  if (!rootEl) return null;
  const host = document.createElement('div');
  host.id = 'nol-scout-host';
  // 先给默认位（贴左），append 之后再按 storage 里的记忆位置覆盖
  host.style.cssText = `position:fixed;z-index:2147483000;left:${PANEL_MARGIN}px;top:${PANEL_DEFAULT_TOP}px;`;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host{all:initial}
      .card{width:372px;background:#0f141c;color:#e8ecf3;border:1px solid #27303f;border-radius:12px;
            font:12px/1.55 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 14px 44px rgba(0,0,0,.5);overflow:hidden}
      .hd{display:flex;align-items:center;gap:8px;padding:9px 11px;background:#161d29;cursor:move;user-select:none}
      .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e}
      .dot.off{background:#6b7280;box-shadow:none}
      .ttl{font-weight:600;flex:1}
      .x{cursor:pointer;opacity:.6;padding:0 4px}
      .x:hover{opacity:1}
      .bd{padding:10px 11px;display:grid;gap:8px;max-height:74vh;overflow:auto}
      .bd.hide{display:none}
      .row{display:flex;justify-content:space-between;gap:8px}
      .k{color:#8494a8}
      .v{font-variant-numeric:tabular-nums;font-weight:600}
      .hit{color:#4ade80}.bad{color:#f87171}.warn{color:#fbbf24}
      .bar{display:flex;gap:6px}
      .btn{flex:1;padding:6px 8px;border-radius:7px;border:1px solid #33405a;background:#1b2331;color:#dbe3ee;cursor:pointer;font-size:12px}
      .btn:hover{background:#243049}
      .btn.p{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
      .btn.g{background:#166534;border-color:#166534;color:#fff}
      .btn:disabled{opacity:.45;cursor:default}
      .mapsvg{width:100%;height:250px;background:#080b11;border-radius:8px;border:1px solid #202836;display:block}
      .logs{max-height:108px;overflow:auto;font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:#8fa0b6;display:grid;gap:1px}
      .logs .hit{color:#4ade80}.logs .error{color:#f87171}.logs .warn{color:#fbbf24}
      .pill{display:inline-block;padding:1px 6px;border-radius:999px;background:#1f2a3d;font-size:10.5px;margin:0 4px 2px 0}
      .seatbox{background:#111927;border:1px solid #27354a;border-radius:8px;padding:8px}
      .seattxt{font:600 14px/1.45 -apple-system,"PingFang SC",sans-serif;color:#fde68a;word-break:break-all}
      .sub{color:#8494a8;font-size:11px;margin-top:2px}
      .modal{position:fixed;inset:0;background:rgba(6,9,14,.9);z-index:2147483600;display:flex;flex-direction:column;padding:18px;gap:10px}
      .modal svg{flex:1;width:100%;background:#080b11;border-radius:10px;border:1px solid #202836}
      .marker{animation:nolPulse 1.1s ease-in-out infinite}
      @keyframes nolPulse{0%,100%{opacity:1}50%{opacity:.35}}
      .banner{padding:6px 8px;border-radius:7px;font-size:11.5px;line-height:1.45}
      .banner.ready{background:#132b1c;color:#86efac;border:1px solid #1d4d2e}
      .banner.on{background:#14243d;color:#93c5fd;border:1px solid #1e3a8a}
      .banner.wait{background:#2a2113;color:#fbbf24;border:1px solid #573f16}
      /* 验证码关卡横幅：和页面上的贴身徽标同一套色阶 */
      .banner.cap{background:#14243d;color:#93c5fd;border:1px solid #1e3a8a}
      .banner.cap.ok{background:#132b1c;color:#86efac;border-color:#1d4d2e}
      .banner.cap.slow{background:#2a2113;color:#fbbf24;border-color:#573f16}
      .banner.cap.bad,.banner.cap.expired{background:#2a1516;color:#f87171;border-color:#5b2326}
      .banner.cap .capadv{display:block;margin-top:3px;font-size:11px;opacity:.9}
      .capadv.hit{color:#86efac}.capadv.warn{color:#fbbf24}.capadv.wait{color:#93c5fd}
      .btn.go{background:#166534;border-color:#166534;color:#fff;font-weight:600;padding:8px;font-size:13px}
      .btn.stop{background:#7f1d1d;border-color:#7f1d1d;color:#fff;font-weight:600;padding:8px;font-size:13px}
      .btn.tiny{flex:0 0 auto;padding:2px 7px;font-size:11px}
      .chips{display:flex;flex-wrap:wrap;gap:0}
      .chip{display:inline-block;padding:2px 7px;border-radius:999px;border:1px solid #33405a;background:#161d29;
            color:#9fb0c6;font-size:11px;cursor:pointer;margin:0 4px 4px 0;user-select:none}
      .chip:hover{border-color:#4b5b78}
      .chip.on{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
      .secttl{color:#8494a8;font-size:11px;margin-top:2px}
      .scope-box{display:grid;gap:4px;border-top:1px solid #1e2634;margin-top:4px;padding-top:6px}
      .scope-box.hide{display:none}
      .live{background:#0c1220;border:1px solid #1e2a3d;border-radius:7px;padding:5px 7px;display:grid;gap:3px}
      .live-main{font-size:11px;color:#9fb0c6}
      .live-main.on{color:#93c5fd;font-weight:600}
      .live-tags{display:flex;flex-wrap:wrap;gap:4px}
      .live-tag{font-size:10.5px;padding:0 5px;border-radius:999px;background:#182338;color:#a9bad0;border:1px solid #243450}
      .live-tag b{color:#e2e8f0}
      .live-tag.bad{background:#2a1516;border-color:#5b2326;color:#f87171}
      .live-tag.hit{background:#132b1c;border-color:#1d4d2e;color:#86efac}
      .mapwrap{display:grid;gap:4px}
      .legend{font-size:10.5px;color:#8494a8;display:flex;align-items:center;gap:4px;flex-wrap:wrap}
      .legend b{color:#e2e8f0}
      .lg-sel{color:#60a5fa;font-size:13px;line-height:1}
      .lg-dim{color:#4b5563;font-size:13px;line-height:1}
      .lg-ok{color:#4ade80;font-size:13px;line-height:1}
      .queue{display:grid;gap:5px}
      /* 选座倒计时：面板折叠时也要能看见，所以头部常驻一个 */
      .tmr{font:600 13px/1 ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;
           padding:3px 7px;border-radius:6px;background:#1b2331;color:#9fb0c6;border:1px solid #33405a}
      .tmr.hd{margin-right:2px}
      .tmr.ok{color:#86efac;border-color:#1d4d2e;background:#132b1c}
      .tmr.warn{color:#fbbf24;border-color:#573f16;background:#2a2113}
      .tmr.danger{color:#f87171;border-color:#5b2326;background:#2a1516;
                  animation:nolPulse 1s ease-in-out infinite}
      .tmr.grace{color:#93c5fd;border-color:#1e3a8a;background:#14243d}
      .tmr.off{opacity:.5}
      .timebox{background:#0c1220;border:1px solid #1e2a3d;border-radius:8px;padding:7px 8px;display:grid;gap:3px}
      .timebox .big{font:600 26px/1.1 ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;color:#e8ecf3}
      .timebox .big.ok{color:#86efac}.timebox .big.warn{color:#fbbf24}
      .timebox .big.danger{color:#f87171}.timebox .big.grace{color:#93c5fd}
      .timebox .cap{font-size:10.5px;color:#8494a8}
      /* 工具条：两行布局，按钮带 title 说明 */
      .tools{display:grid;gap:5px}
      .tools .bar{display:flex;gap:6px}
      .btn.ghost{background:transparent;border-color:#2b3648;color:#9fb0c6;font-size:11.5px}
      .btn.ghost:hover{background:#1b2331;color:#dbe3ee}
      .hintbar{font-size:10.5px;color:#6f8098;line-height:1.5}
      .qi{display:flex;gap:7px;align-items:center;background:#111927;border:1px solid #27354a;border-radius:8px;padding:6px 7px}
      .qi.top{border-color:#b45309}
      .rank{flex:0 0 auto;font-size:10.5px;padding:1px 6px;border-radius:999px;background:#334155;color:#cbd5e1}
      .rank.top{background:#b45309;color:#fff}
      .qi-main{flex:1;min-width:0}
      .qi-t{font-weight:600;font-size:12px;color:#fde68a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    </style>
    <style>@keyframes nolPulse{0%,100%{opacity:1}50%{opacity:.35}}</style>
    <div class="card">
      <div class="hd"><span class="dot off" id="dot"></span><span class="ttl">NOL Scout · 捡漏扫描</span><span class="tmr hd off" id="hdTmr">--:--</span><span class="x" data-act="flip" id="flip" title="面板贴左 / 贴右切换（默认贴左，避免挡住选座区域）">⇔</span><span class="x" id="toggle">▾</span></div>
      <div class="bd" id="bd"></div>
    </div>`;
  rootEl.appendChild(host);
  state.panel = { host, root };
  // 有记忆位置就用记忆的（拖过就记住），否则留在默认的左边
  if (state.panelPos) applyPanelPos(state.panelPos.left, state.panelPos.top);
  root.getElementById('toggle').onclick = () => root.getElementById('bd').classList.toggle('hide');
  makeDraggable(host, root.querySelector('.hd'));
  // 工具条用事件委托，只挂一次。
  // 之前三个按钮是逐个 el.onclick = ...，而 bind() 是从上往下依次赋值的：
  // 中间任何一个 getElementById 返回 null 抛错，后面的按钮就全部变成死键——
  // 「点了没反应」的坑就是这么来的。委托没有这个连锁风险。
  root.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    if (act === 'fullmap') openFullMap();
    else if (act === 'recalib') actRecalibrate();
    else if (act === 'reload-map') actReloadSeatMap();
    else if (act === 'flip') flipPanelSide();
  });
  return state.panel;
}

/** 工具条动作：重新获取座位图 */
async function actReloadSeatMap() {
  try {
    log('重新向服务器获取座位图（block-data + seatMeta）…');
    const c = await ensureCatalog(true);
    log(`座位图已更新：${c.blocks.length} 区块 / ${c.regions.length} 区域 / ${c.grades.length} 价位 / ${c.blocks.reduce((n, b) => n + b.seatCount, 0)} 座位`, 'hit');
    log('提示：坐标映射沿用上一份，若页面本身也缩放过，点「校准页面定位」重算一次更稳', 'warn');
  } catch (e) {
    log('重新获取座位图失败：' + e.message, 'error');
  }
}

/** 工具条动作：重算「座位图坐标 → 屏幕像素」映射 */
async function actRecalibrate() {
  log('正在重新解算页面座位图的坐标映射…');
  const l = await ensureLocator({ force: true });
  if (l?.cal) {
    log(`定位映射已更新：${describeCalibration(l.cal)}`, l.cal.confidence === 'exact' ? 'hit' : 'warn');
    const b = state.monitor?.lastResult?.best;
    if (b) locateOnPage(b, { auto: true });
  } else {
    log('解算失败：页面座位层没找到可用的座位元素（可能还没渲染完，或当前不是选座步骤）', 'error');
  }
}

function makeDraggable(el, handle) {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  handle.addEventListener('mousedown', (e) => {
    // 头部的小按钮不参与拖拽（折叠、贴左/贴右）
    if (e.target.id === 'toggle' || e.target.dataset?.act) return;
    dragging = true; sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
    // 一旦开始拖，就必须从 right 锚定切换成 left 锚定，否则 left/right 互相打架
    el.style.right = 'auto';
    el.style.left = ox + 'px'; el.style.top = oy + 'px';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    el.style.left = ox + (e.clientX - sx) + 'px';
    el.style.top = oy + (e.clientY - sy) + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    // 松手即落盘：夹进视口 + 记住，刷新后回到同一个地方
    const r = el.getBoundingClientRect();
    savePanelPos(applyPanelPos(r.left, r.top));
  });
}

function renderPanel() {
  const panel = ensurePanel();
  if (!panel) { document.addEventListener('DOMContentLoaded', () => renderPanel(), { once: true }); return; }
  const { root } = panel;
  const m = state.monitor;
  const res = m?.lastResult;
  root.getElementById('dot').className = 'dot' + (m ? '' : ' off');

  const fresh = Math.max(...Object.values(state.lastSeenAt).concat([0]));
  const age = fresh ? Math.round((Date.now() - fresh) / 1000) : null;
  const ready = pageReady();
  const CONF_NAME = { exact: '精确', rough: '粗略', bad: '不可用', assumed: '推定' };
  const locTxt = state.locator?.cal
    ? `${CONF_NAME[state.locator.cal.confidence] || state.locator.cal.confidence}`
      + ` · 残差 ${(state.locator.cal.rel * 100).toFixed(0)}%座距`
      + (state.locator.cal.swap ? ' · x↔y' : '')
      + (state.seatCanvas?.pageSeats != null ? ` · 页面座位 ${state.seatCanvas.pageSeats}` : '')
      + (state.seatCanvas?.matched != null ? ` / 命中匹配 ${state.seatCanvas.matched}` : '')
    : (state.locator && !state.locator.cal ? '标定失败，用内置图' : '待标定（启动扫描后自动）');

  // 「页面即任务」的第一屏提示：检测到选座页就明确告诉用户下一步只差一次点击
  const banner = m
    ? `<div class="banner on">扫描中 · ${m.blocks.length} 个区块 · 间隔 ${m.task.intervalMs || 2800}ms · 已扫 ${m.scans} 次</div>`
    : ready
      ? `<div class="banner ready">已检测到选座页：${state.catalog.blocks.length} 区块 / ${state.catalog.regions.length} 区域 / ${state.catalog.grades.length} 价位 · 点下面按钮即开始捡漏</div>`
      : `<div class="banner wait">${state.session ? '正在构建座位目录…' : '等待选座页数据…（若长时间无反应，刷新一次本页）'}</div>`;

  const cap = state.captcha;
  // 验证码关卡横幅：排在第一条，因为此刻用户的注意力全在验证码框上，
  // 他需要的是"还剩多少时间、这几秒亏不亏"，而不是商品号。
  const capBanner = cap.active ? captchaBannerHtml(cap) : '';

  root.getElementById('bd').innerHTML = `
    ${capBanner}
    ${banner}
    ${timerBoxHtml()}
    <div class="row"><span class="k">场次 / 商品</span><span class="v">${state.playSeq || '—'} · ${state.goodsCode || '—'}</span></div>
    <div class="row"><span class="k">会话</span><span class="v ${state.session ? 'hit' : 'bad'}">${state.session ? '已捕获' : '未捕获'}</span></div>
    <div class="row"><span class="k">余票快照</span><span class="v">${Object.keys(state.status).length} 区块${age != null ? ` · ${age}s 前` : ''}</span></div>
    <div class="row"><span class="k">页面定位</span><span class="v ${state.locator?.cal?.confidence === 'exact' ? 'hit' : state.locator?.cal ? 'warn' : ''}">${locTxt}</span></div>
    <div class="row"><span class="k">轮询 / 命中</span><span class="v">${m?.scans ?? 0} / <span class="hit">${m?.hits ?? 0}</span>${m ? ` · 旁听 ${m.passiveSeen || 0}` : ''}</span></div>
    ${!cap.active && cap.lastCost ? `<div class="row"><span class="k">上次验证码</span><span class="v">⏱ ${formatElapsed(cap.lastCost.totalMs)}${cap.lastCost.attempts > 1 ? ` · ${cap.lastCost.attempts} 次` : ''}</span></div>` : ''}
    ${res ? `<div class="row"><span class="k">全场合计</span><span class="v ${res.freeSeats ? 'hit' : ''}">${res.freeSeats} 座 · ${res.blocksWithFree} 区块</span></div>` : ''}
    <div class="bar"><button class="btn ${m ? 'stop' : 'go'}" id="btnScan">${m ? '■ 停止扫描' : '▶ 开始捡漏扫描'}</button></div>
    <div class="bar"><button class="btn" id="btnAutoCaptcha">自动验证码：${state.prefs.captchaAutoSolve ? '开' : '关'}</button><button class="btn" id="btnAutoLock">自动锁票：${state.prefs.autoLock ? '开' : '关'}</button></div>
    ${state.automation.locked ? `<div class="banner ready">已锁票：${esc(state.automation.locked.summary)}。已进入网站票价步骤，请继续购票。</div>` : ''}
    ${state.automation.uncertain ? '<div class="banner cap">锁票状态待人工确认，自动锁票已暂停。请检查页面后再开启。</div>' : ''}
    <div class="row"><span class="k">扫描范围</span><span class="v" id="scopeSummary">${esc(describePrefs(state.prefs, { nameOfGrade: gradeNameMap() }))}</span></div>
    <div class="bar"><button class="btn" id="btnScope">${state.ui.scopeOpen ? '▾ 收起筛选' : '▸ 调整范围'}</button></div>
    <div class="scope-box ${state.ui.scopeOpen ? '' : 'hide'}" id="scopeBox">${renderScope()}</div>
    ${res?.runs?.length ? renderQueue(res) : ''}
    ${state.catalog ? `<div class="mapwrap"><div id="mapBox">${renderMap()}</div><div class="legend" id="mapLegend">${mapLegendHtml()}</div></div>` : ''}
    <div class="tools">
      <div class="bar">
        <button class="btn ghost" data-act="reload-map" title="重新向服务器拉一次 seats/block-data + seatMeta（区块几何、座位坐标、价位）。页面抢票时会频繁改动座位图，怀疑数据过期时点这个；平时不用点。">↻ 重新获取座位图</button>
        <button class="btn ghost" data-act="recalib" title="重新解算「座位图坐标 → 屏幕像素」的映射关系。定位圈画歪、或你在页面上缩放/拖动过座位图之后点它；成功会报告残差百分比。">◎ 校准页面定位</button>
      </div>
      <div class="bar">
        <button class="btn" data-act="fullmap" title="打开全屏座位图（Esc 关闭）：绿=可购、灰=已售、黄圈=命中、蓝框=当前筛选选中的区块。">⛶ 全屏座位图</button>
      </div>
      <div class="hintbar">自动锁票开启后会提交首选座位；关闭时可按候选顺序定位。锁票成功后请确认座位并完成后续购票。</div>
    </div>
    <div class="logs">${state.logLines.slice(-40).reverse().map((l) =>
      `<div><span class="hit">${new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false })}</span> <span class="${l.level}">${esc(l.msg)}</span></div>`).join('')}</div>`;

  bind(root);
  tickTimer();   // 重绘后把倒计时立刻刷回当前值，避免出现一瞬间的旧数字
}

/** 面板里的验证码关卡横幅（内容与页面上的贴身徽标同一份口径） */
function captchaBannerHtml(cap) {
  const snap = timerSnapshot();
  const spec = captchaBadge({
    remainingText: snap.text,
    elapsedMs: Date.now() - cap.seenAt,
    kind: cap.kind,
    expired: snap.state === 'dead',
  });
  const adv = gateAdvice({
    monitoring: !!state.monitor,
    autoStartEnabled: !!state.prefs.captchaAutoStart,
    ready: pageReady(),
  });
  return `<div class="banner cap ${spec.tone}" id="capBanner">
    <span id="capMain">${esc(spec.main)}</span> · <span id="capSub">${esc(spec.sub)}${spec.tip ? ' ' + esc(spec.tip) : ''}</span>
    <span class="capadv ${adv.level}" id="capAdv">${esc(adv.text)}</span>
  </div>`;
}

/** 面板里的倒计时卡片 */
function timerBoxHtml() {
  const snap = timerSnapshot();
  const label = snap.state === 'dead' ? '选座时间已结束'
    : snap.state === 'grace' ? '选座时间（宽限中）'
      : '选座剩余时间';
  return `<div class="timebox">
    <div class="big ${snap.phase}${snap.state === 'grace' ? ' grace' : ''}" id="tmr">${snap.text}</div>
    <div class="cap">${label}</div>
    <div class="cap" id="tmrSub">${esc(timerSubText(snap))}</div>
  </div>`;
}

function krw2cny(krw) { return Math.round(Number(krw || 0) * KRW_CNY); }

function gradeNameMap() {
  const map = new Map();
  for (const g of state.catalog?.grades || []) map.set(String(g.grade), g.name);
  return map;
}

// 筛选区：默认「全部价位 + 全部区域 + 1 张 + 不挑位置」，点一下就能开扫；
// 想收窄范围时才展开这里。选项直接来自座位目录，不需要用户手填任何号。
//
// 点任意一个 chip 都会立刻回写参数并只重绘「选区 + 地图」这一小块（见 syncScopeUI），
// 所以地图上能实时看到"哪些块被选中了"，不用等重启扫描。
function renderScope() {
  const c = state.catalog;
  if (!c) return '<div class="sub">座位目录就绪后即可按价位 / 区域收窄范围</div>';
  const p = state.prefs;
  const scope = resolveScope(p, c);
  const gs = new Set(p.grades);
  const rs = new Set(p.regions);
  const g = [`<span class="chip ${gs.size ? '' : 'on'}" data-grade="">全部价位</span>`]
    .concat(c.grades.map((x) => {
      const on = gs.has(String(x.grade));
      // 每个档位也带上"覆盖几个区块"，和区域 chip 一样能对上地图上的描边
      const n = c.blocks.filter((b) => b.seats.some((s) => s.exposable) && (b.gradeNos || []).map(String).includes(String(x.grade))).length;
      return `<span class="chip ${on ? 'on' : ''}" data-grade="${esc(x.grade)}">${esc(x.name)}${x.price ? ` ₩${Number(x.price).toLocaleString()} / ¥${krw2cny(x.price)}` : ''} · ${n}块</span>`;
    }))
    .join('');
  const r = [`<span class="chip ${rs.size ? '' : 'on'}" data-region="">全部区域</span>`]
    .concat(c.regions.map((x) => `<span class="chip ${rs.has(x.name) ? 'on' : ''}" data-region="${esc(x.name)}">${esc(x.name)} · ${x.blockKeys?.length ?? 0}块 · ${x.seatCount}座</span>`))
    .join('');
  const q = Array.from({ length: Math.min(MAX_QUANTITY, 4) }, (_, i) => i + 1)
    .map((n) => `<span class="chip ${p.quantity === n ? 'on' : ''}" data-qty="${n}">${n} 张</span>`).join('');
  const pf = Object.keys(PREF_LABEL)
    .map((k) => `<span class="chip ${p.preference === k ? 'on' : ''}" data-pref="${k}">${PREF_LABEL[k]}</span>`).join('');
  const iv = INTERVAL_OPTIONS
    .map((n) => `<span class="chip ${p.intervalMs === n ? 'on' : ''}" data-iv="${n}" title="${n < INTERVAL_AGGRESSIVE_MS ? '比较激进：接近官网刷新频率的数倍，命中更快但更容易被站点限流' : '与官网自身刷新节奏相当'}">${n}ms</span>`).join('');
  const ivNote = p.intervalMs < INTERVAL_AGGRESSIVE_MS
    ? `<div class="sub">当前 ${p.intervalMs}ms 属于激进档：一轮只发 1 个合并请求（16 区块/次），但请留意日志里有没有出现限流报错。</div>`
    : `<div class="sub">下限 ${MIN_INTERVAL_MS}ms。官网自身约 2.6~4.5s 刷一次，越快越可能被限流，${INTERVAL_AGGRESSIVE_MS}ms 以下请留意报错。</div>`;
  const gate = `<span class="chip ${p.captchaAutoStart ? 'on' : ''}" data-gate="1" title="打开后：检测到验证码关卡且座位目录就绪时自动开扫，让输入验证码的那几秒不空转（实测约 8 秒，会从选座 10 分钟里扣）。默认关闭——不想被自动开扫就保持这样。">验证码期自动开扫：${p.captchaAutoStart ? '开' : '关'}</span>`;
  return `<div class="secttl">目标价位（不选＝全部）</div><div class="chips">${g}</div>
    <div class="secttl">目标区域（不选＝全部）</div><div class="chips">${r}</div>
    <div class="live" id="scopeLive">${scopeLiveHtml(scope)}</div>
    <div class="secttl">需要张数</div><div class="chips">${q}</div>
    <div class="secttl">位置偏好</div><div class="chips">${pf}</div>
    <div class="secttl">轮询间隔</div><div class="chips">${iv}</div>${ivNote}
    <div class="secttl">验证码关卡</div><div class="chips">${gate}</div>`;
}

// 「选中了哪些块」的实时回显：地图上的描边是图形口径，这里再给一份可读的数字口径。
function scopeLiveHtml(scope) {
  if (!scope) return '';
  const regionLine = scope.narrow
    ? (scope.selectedRegions.length
        ? scope.selectedRegions.map((r) => `<span class="live-tag">${esc(r.name)} <b>${r.blocks}</b>块/${r.seats}座</span>`).join('')
        : '<span class="live-tag bad">当前条件下没有可用区块</span>')
    : [...scope.regionStat.values()].sort((a, b) => b.blocks - a.blocks).slice(0, 8)
        .map((r) => `<span class="live-tag">${esc(r.name)} <b>${r.blocks}</b>块</span>`).join('');
  return `<div class="live-main ${scope.narrow ? 'on' : ''}">${scope.narrow ? '▣ ' : '□ '}${describeScope(scope)}</div>
    <div class="live-tags">${regionLine}${scope.selectedRegions.length > 8 ? `<span class="live-tag">…</span>` : ''}</div>`;
}

// 只重绘会被筛选影响的那几处：chip 的选中态、范围摘要、选区回显、地图高亮。
// 不整块 refresh（地图有上万个节点，重建一次的成本不该由一次点击来承担）。
function syncScopeUI(root) {
  const r = root || state.panel?.root;
  if (!r || !state.catalog) return;
  const p = state.prefs;
  const gs = new Set(p.grades);
  const rs = new Set(p.regions);
  r.querySelectorAll('[data-grade]').forEach((el) => {
    const k = el.dataset.grade;
    el.classList.toggle('on', k ? gs.has(k) : gs.size === 0);
  });
  r.querySelectorAll('[data-region]').forEach((el) => {
    const k = el.dataset.region;
    el.classList.toggle('on', k ? rs.has(k) : rs.size === 0);
  });
  r.querySelectorAll('[data-qty]').forEach((el) => el.classList.toggle('on', p.quantity === Number(el.dataset.qty)));
  r.querySelectorAll('[data-pref]').forEach((el) => el.classList.toggle('on', p.preference === el.dataset.pref));

  const sum = r.getElementById('scopeSummary');
  if (sum) sum.textContent = describePrefs(p, { nameOfGrade: gradeNameMap() });
  const live = r.getElementById('scopeLive');
  if (live) live.innerHTML = scopeLiveHtml(resolveScope(p, state.catalog));
  const mapBox = r.getElementById('mapBox');
  if (mapBox) mapBox.innerHTML = renderMap();
  const legend = r.getElementById('mapLegend');
  if (legend) legend.innerHTML = mapLegendHtml();
}

// 地图下方的一行图例：明确告诉用户"描边的就是选中的块"
function mapLegendHtml() {
  const scope = state.catalog ? resolveScope(state.prefs, state.catalog) : null;
  if (!scope?.narrow) return '<span class="lg-ok">□</span> 全部区块都在扫描范围内（点「调整范围」可只看某几个块）';
  return `<span class="lg-sel">▣</span> 描边＝已选 <b>${scope.selected}</b> 个区块 · <span class="lg-dim">□</span> 压暗的 <b>${scope.total - scope.selected}</b> 个不在范围内`;
}

// 候选优先级队列：把 matchSnapshot 排好序的可用连座段切成「首选 / 备份1 / 备份2」。
// 队列显示排序、定位、复制；开启自动锁票时提交首选。
function renderQueue(res) {
  const items = labelRuns(res.runs, 3);
  if (!items.length) return '';
  const total = res.allRuns ?? res.runs.length;
  return `<div class="secttl">候选优先级（点「定位」跳到页面上的那个座位）</div>
    <div class="queue">${items.map(({ rank, label, run }) => `
      <div class="qi ${rank === 1 ? 'top' : ''}">
        <span class="rank ${rank === 1 ? 'top' : ''}">${label}</span>
        <div class="qi-main">
          <div class="qi-t">${esc(run.region || run.blockKey)} · ${esc(run.rowLabel || run.rowNo || '')} · ${esc(run.seatNos.slice(0, 8).join('/'))}${run.seatNos.length > 8 ? '…' : ''}</div>
          <div class="sub">${esc(run.gradeNames.join('/') || run.grade || '')}${run.price ? ` · ₩${Number(run.price).toLocaleString()} / ¥${krw2cny(run.price)}` : ''} · ${run.len} 连座</div>
        </div>
        <button class="btn tiny" data-locate="${rank}">定位</button>
        <button class="btn tiny" data-copy="${rank}">复制</button>
      </div>`).join('')}</div>
    ${total > items.length ? `<div class="sub">另有 ${total - items.length} 处可用（点「放大图」看全貌）</div>` : ''}`;
}

function runsAt(rank) {
  return state.monitor?.lastResult?.runs?.[Number(rank) - 1] || null;
}

function copyRun(run) {
  if (!run) return;
  const text = `${run.region || run.blockKey} ${run.rowLabel || ''} ${run.seatNos.join(',')} ${run.gradeNames.join('/')}`.replace(/\s+/g, ' ').trim();
  navigator.clipboard?.writeText(text)
    .then(() => log('已复制：' + text), () => log('复制失败', 'warn'));
}

function bind(root) {
  const ac = root.getElementById('btnAutoCaptcha');
  if (ac) ac.onclick = async () => { await savePrefs({ captchaAutoSolve: !state.prefs.captchaAutoSolve }); renderPanel(); maybeSolveCaptcha(); };
  const al = root.getElementById('btnAutoLock');
  if (al) al.onclick = async () => {
    await savePrefs({ autoLock: !state.prefs.autoLock });
    if (state.prefs.autoLock) state.automation.uncertain = false;
    renderPanel();
    if (state.monitor) maybeEvaluate('auto-lock-toggle');
  };
  const scan = root.getElementById('btnScan');
  if (scan) scan.onclick = async () => {
    if (state.monitor) return stopMonitor();
    try {
      if (!state.catalog) await ensureCatalog(false);
      await startMonitor(adHocTask());
      state.ui.scopeOpen = false;
      log(`已按当前范围开始：${describePrefs(state.prefs, { nameOfGrade: gradeNameMap() })}`, 'hit');
      renderPanel();
    } catch (e) {
      log('无法开始：' + e.message, 'error');
    }
  };

  const scopeBtn = root.getElementById('btnScope');
  if (scopeBtn) scopeBtn.onclick = () => { state.ui.scopeOpen = !state.ui.scopeOpen; renderPanel(); };

  // 参数改动即存：popup 与页面面板共用同一份 storage.local.scoutPrefs。
  // 点 chip 只做一次"局部重绘"（选区回显 + 地图高亮），不整块重建面板，
  // 这样连点几个区域也不会卡，地图上的描边是跟手变的。
  root.querySelectorAll('[data-grade]').forEach((el) => {
    el.onclick = async () => {
      const key = el.dataset.grade;
      const set = new Set(state.prefs.grades);
      if (!key) set.clear();
      else if (set.has(key)) set.delete(key);
      else set.add(key);
      await savePrefs({ grades: [...set] });
      syncScopeUI(root);
      noteScopeChange('价位范围');
    };
  });
  root.querySelectorAll('[data-region]').forEach((el) => {
    el.onclick = async () => {
      const key = el.dataset.region;
      const set = new Set(state.prefs.regions);
      if (!key) set.clear();
      else if (set.has(key)) set.delete(key);
      else set.add(key);
      await savePrefs({ regions: [...set] });
      syncScopeUI(root);
      noteScopeChange('区域范围');
    };
  });
  root.querySelectorAll('[data-qty]').forEach((el) => {
    el.onclick = async () => {
      await savePrefs({ quantity: Number(el.dataset.qty) });
      syncScopeUI(root);
      noteScopeChange('张数');
    };
  });
  root.querySelectorAll('[data-pref]').forEach((el) => {
    el.onclick = async () => {
      await savePrefs({ preference: el.dataset.pref });
      syncScopeUI(root);
      noteScopeChange('位置偏好');
    };
  });
  root.querySelectorAll('[data-iv]').forEach((el) => {
    el.onclick = async () => {
      const ms = Number(el.dataset.iv);
      await savePrefs({ intervalMs: ms });
      if (state.monitor) log(`间隔已改为 ${ms}ms —— 重启扫描后生效`, 'warn');
      else log(`轮询间隔设为 ${ms}ms${ms < INTERVAL_AGGRESSIVE_MS ? '（激进档，注意限流）' : ''}`);
      syncScopeUI(root);
    };
  });

  root.querySelectorAll('[data-gate]').forEach((el) => {
    el.onclick = async () => {
      const next = !state.prefs.captchaAutoStart;
      await savePrefs({ captchaAutoStart: next });
      log(next
        ? '已开启「验证码期自动开扫」：检测到验证码关卡且目录就绪时会自动开扫'
        : '已关闭「验证码期自动开扫」：仍由你点开始');
      // 开关刚打开且此刻正卡在验证码上、目录也好了 → 立刻补一次
      if (next && state.captcha.active) maybeAutoStartOnGate();
      syncScopeUI(root);
    };
  });

  root.querySelectorAll('[data-locate]').forEach((el) => {
    el.onclick = () => {
      const run = runsAt(el.dataset.locate);
      if (run) locateOnPage(run, { auto: false });
      else log('这一顺位已经没有了，看下面的最新命中', 'warn');
    };
  });
  root.querySelectorAll('[data-copy]').forEach((el) => {
    el.onclick = () => copyRun(runsAt(el.dataset.copy));
  });
  // 工具条按钮（重新获取座位图 / 校准页面定位 / 全屏座位图）走事件委托，见 ensurePanel
}

// ---------------- 座位图渲染 ----------------

function renderMap() {
  const c = state.catalog;
  if (!c) return '';
  const blocks = c.blocks.filter((b) => b.seats.some((s) => s.exposable));
  if (!blocks.length) return '';
  const totalSeats = blocks.reduce((n, b) => n + b.seatCount, 0);

  // 座位太多时退化为区块热力块（避免一次性塞入上万个 svg 节点）
  const seatsMode = totalSeats <= 12000;

  const view = state.zoom
    ? (() => {
        const b = blocks.find((x) => x.key === state.zoom.blockKey);
        if (!b || b.box.w <= 0 || b.box.h <= 0) return null;
        const pad = Math.max(6, Math.min(b.box.w, b.box.h) * 0.35);
        return { cx: b.box.x + b.box.w / 2, cy: b.box.y + b.box.h / 2, w: b.box.w + pad, h: b.box.h + pad };
      })()
    : null;

  const ext = view || c.canvas;
  const vbX = view ? view.cx - view.w / 2 : ext.minX;
  const vbY = view ? view.cy - view.h / 2 : ext.minY;
  const vbW = view ? view.w : Math.max(1, ext.maxX - ext.minX);
  const vbH = view ? view.h : Math.max(1, ext.maxY - ext.minY);

  // ★ 选区实时高亮：直接用「用户当前参数」，而不是已经启动的那条任务。
  //   这样用户在筛选区里点一下区域/价位，地图立刻就能看出"哪些块被选中了"。
  const scope = resolveScope(state.prefs, c);
  const colorByGrade = {};
  for (const g of c.grades) colorByGrade[g.name] = g.color;

  const hitSeats = new Set((state.monitor?.lastResult?.runs || []).flatMap((r) => r.seatIds));
  // 点的半径跟着视窗走：全图时别小到看不见，放大时别糊成一片
  const dotR = Math.max(0.85, Math.min(2.4, vbW / 150));
  // 选中框的线宽同样跟视窗走，缩略时不至于糊成一团
  const sw = Math.max(0.45, Math.min(2.6, vbW / 230));
  const parts = [];

  for (const b of blocks) {
    const str = state.status[b.key];
    const flags = str ? decodeBlockStatus(str, b.seatCount) : null;
    const inScope = scope.has(b.key);
    // 未选中 → 压暗；选中 → 描边 + 淡蓝底，形成"这块有这个范围里的座位"的直觉
    const dim = scope.narrow && !inScope ? ' opacity="0.14"' : '';
    const boxStr = (extra = '') =>
      `<rect x="${b.box.x.toFixed(1)}" y="${b.box.y.toFixed(1)}" width="${Math.max(0.6, b.box.w).toFixed(1)}" height="${Math.max(0.6, b.box.h).toFixed(1)}" rx="2" ${extra}/>`;
    const mark = scope.narrow && inScope
      ? boxStr(`fill="#3b82f6" fill-opacity=".10" stroke="#60a5fa" stroke-opacity=".9" stroke-width="${sw.toFixed(2)}"`)
      : '';

    if (!seatsMode) {
      const free = flags ? flags.reduce((n, x) => n + x, 0) : 0;
      const fill = !flags ? '#242c3a' : free ? (inScope ? '#1f7a3f' : '#3f5a2a') : '#1b2029';
      const title = `${esc(b.region || b.key)} · ${b.seatCount}座 · ${free} 可购${scope.narrow ? (inScope ? ' · ✓已选' : ' · 不在筛选范围') : ''}`;
      parts.push(`<g${dim}><rect x="${b.box.x.toFixed(1)}" y="${b.box.y.toFixed(1)}" width="${Math.max(0.6, b.box.w).toFixed(1)}" height="${Math.max(0.6, b.box.h).toFixed(1)}" fill="${fill}" rx="1"><title>${title}</title></rect>${mark}</g>`);
      continue;
    }

    // 逐座位渲染
    let s = '';
    for (const seat of b.seats) {
      if (!seat.exposable) continue;
      const free = flags ? flags[seat.idx] === 1 : false;
      const hit = hitSeats.has(seat.id);
      let fill = '#232b38';                                  // 已售 / 无数据
      if (!flags) fill = '#232b38';
      else if (free) fill = inScope ? (colorByGrade[seat.gradeName] || '#22c55e') : '#4b5563';
      if (hit) fill = '#facc15';
      const r = hit ? dotR * 1.6 : dotR;
      s += `<circle cx="${seat.x.toFixed(2)}" cy="${seat.y.toFixed(2)}" r="${r}" fill="${fill}"${hit ? ' class="marker"' : ''}/>`;
    }
    const freeN = flags ? flags.reduce((n, x) => n + x, 0) : 0;
    const title = `${esc(b.region || b.key)} · ${b.seatCount}座 · ${freeN} 可购${scope.narrow ? (inScope ? ' · ✓已选' : ' · 不在筛选范围') : ''}`;
    parts.push(`<g${dim}><title>${title}</title>${s}${mark}</g>`);
  }

  return `<svg class="mapsvg" viewBox="${vbX.toFixed(1)} ${vbY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}

// ---------------- 全屏座位图（原「放大图」） ----------------
//
// 旧版为什么"点了没效果"，两个原因都修掉了：
//  1) 它把 renderMap() 产出的 <svg class="mapsvg"> 用字符串替换成 style="..."，
//     类名一走，面板那张样式表里的规则就全失效了；一旦内联尺寸在该容器里算成 0 高，
//     整张图就变成一片看不见的空白 —— 看起来就是"没反应"。
//  2) 它的样式只作用于内层 .modal，宿主 div 本身没有任何定位/尺寸。
// 现在改成：宿主元素自己就是全屏层（:host 里写死 fixed + inset + vw/vh 双保险），
// svg 直接吃类名样式，并在开图时明确写一条日志 —— 点了有没有生效，一眼可查。

function closeFullMap() {
  if (state.modal) { state.modal.remove(); state.modal = null; }
  document.removeEventListener('keydown', onFullMapKey, true);
}

function onFullMapKey(e) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  closeFullMap();
}

function openFullMap() {
  const rootEl = document.body || document.documentElement;
  if (!rootEl) return;
  closeFullMap();
  if (!state.catalog) {
    log('座位图还没构建好，先等页面把选座数据加载出来（或点「重新获取座位图」）', 'warn');
  }

  const host = document.createElement('div');
  host.id = 'nol-scout-fullmap';
  const sh = host.attachShadow({ mode: 'open' });
  sh.innerHTML = `<style>
    :host{all:initial}
    .layer{position:fixed;left:0;top:0;right:0;bottom:0;width:100vw;height:100vh;
           display:flex;flex-direction:column;gap:10px;padding:16px;box-sizing:border-box;
           background:rgba(6,9,14,.94);z-index:2147483600;
           font:12px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#e8ecf3}
    .hd{display:flex;align-items:center;gap:10px;flex:0 0 auto}
    .hd .ttl{font-weight:600;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .btn{padding:5px 11px;border-radius:7px;border:1px solid #33405a;background:#1b2331;color:#dbe3ee;
         cursor:pointer;font-size:12px;white-space:nowrap}
    .btn:hover{background:#243049}
    .wrap{flex:1 1 auto;min-height:0;display:block;background:#080b11;border:1px solid #202836;border-radius:10px;overflow:hidden}
    /* 直接用类名，不再做字符串替换 —— 这是旧版失效的根因 */
    .wrap svg.mapsvg{display:block;width:100%;height:100%}
    .ft{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:11.5px;color:#9fb0c6}
    .lg{display:inline-flex;align-items:center;gap:5px}
    .sw{width:10px;height:10px;border-radius:3px;display:inline-block}
    .marker{animation:nolPulse 1.1s ease-in-out infinite}
    @keyframes nolPulse{0%,100%{opacity:1}50%{opacity:.3}}
    .empty{display:flex;align-items:center;justify-content:center;height:100%;color:#8494a8;font-size:13px}
  </style>
  <div class="layer">
    <div class="hd">
      <span class="ttl" id="fmTtl">座位全图</span>
      <button class="btn" id="fmZoom">缩放到命中区块</button>
      <button class="btn" id="fmFull">看全图</button>
      <button class="btn" id="fmClose">关闭 (Esc)</button>
    </div>
    <div class="wrap" id="fmWrap"></div>
    <div class="ft" id="fmFoot"></div>
  </div>`;
  rootEl.appendChild(host);
  state.modal = host;

  const draw = () => {
    const wrap = sh.getElementById('fmWrap');
    const svg = renderMap();
    wrap.innerHTML = svg || '<div class="empty">暂时没有可画的座位（座位目录未就绪 / 该场次无可售座位）</div>';

    const scope = state.catalog ? resolveScope(state.prefs, state.catalog) : null;
    const best = state.monitor?.lastResult?.best;
    sh.getElementById('fmTtl').textContent = best
      ? `命中：${best.region || best.blockKey} · ${best.rowLabel} · ${best.seatNos.slice(0, 10).join('/')} · ${best.gradeNames.join('/') || best.grade}`
      : '全屏座位图';
    sh.getElementById('fmFoot').innerHTML = fullMapFoot(scope);
  };

  sh.getElementById('fmClose').onclick = () => closeFullMap();
  sh.getElementById('fmFull').onclick = () => { state.zoom = null; draw(); };
  sh.getElementById('fmZoom').onclick = () => {
    const b = state.monitor?.lastResult?.best;
    if (!b) { log('还没有命中记录，无法缩放到命中区块', 'warn'); return; }
    state.zoom = { blockKey: b.blockKey };
    draw();
  };
  document.addEventListener('keydown', onFullMapKey, true);
  draw();

  const scope = state.catalog ? resolveScope(state.prefs, state.catalog) : null;
  log(`已打开全屏座位图（${state.catalog ? state.catalog.blocks.length + ' 区块' : '暂无目录'}${scope?.narrow ? ` · 已选 ${scope.selected} 区块` : ''}）· 按 Esc 关闭`);
}

function fullMapFoot(scope) {
  let free = 0, blocks = 0;
  for (const b of state.catalog?.blocks || []) {
    const str = state.status[b.key];
    if (!str) continue;
    let flags; try { flags = decodeBlockStatus(str, b.seatCount); } catch (e) { continue; }
    const n = flags.reduce((a, x) => a + x, 0);
    if (n) blocks++;
    free += n;
  }
  const items = [
    `<span class="lg"><i class="sw" style="background:#22c55e"></i>可购</span>`,
    `<span class="lg"><i class="sw" style="background:#232b38"></i>已售 / 无数据</span>`,
    `<span class="lg"><i class="sw" style="background:#facc15"></i>命中座位</span>`,
  ];
  if (scope?.narrow) items.push(`<span class="lg"><i class="sw" style="background:transparent;border:1.5px solid #60a5fa"></i>已选 ${scope.selected}/${scope.total} 区块</span>`);
  items.push(`<span class="lg">当前快照可购 <b style="color:#86efac">${free}</b> 座 · ${blocks} 区块</span>`);
  if (state.monitor?.lastResult) items.push(`<span class="lg">已命中 ${state.monitor.hits} 次</span>`);
  return items.join('');
}

// ---------------- 后台消息接口 ----------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'OCR_PROGRESS':
          if (state.automation.ocrBusy && msg.requestId === state.automation.ocrRequestId) log(msg.stage);
          sendResponse({ ok: true });
          break;
        case 'SEAT_HELLO':
        case 'GET_SEAT_STATE':
          sendResponse({ ok: true, ...publicState() });
          break;
        case 'BUILD_CATALOG':
          sendResponse({ ok: true, catalog: summarizeCatalog(await ensureCatalog(true)) });
          break;
        case 'START_SEAT_MONITOR':
          sendResponse({ ok: true, ...(await startMonitor(msg.task)) });
          break;
        case 'START_ADHOC_SCAN': {
          // 「页面即任务」：不需要 popup 先建任务，直接按当前页 + 当前参数开扫
          if (msg.prefs) state.prefs = normalizePrefs(msg.prefs);
          else await loadPrefs();
          await savePrefs({});
          const task = adHocTask();
          sendResponse({ ok: true, task: taskForBackground(task), ...(await startMonitor(task)) });
          break;
        }
        case 'STOP_SEAT_MONITOR':
          stopMonitor();
          sendResponse({ ok: true });
          break;
        case 'LOCATE_BEST': {
          const b = state.monitor?.lastResult?.best;
          sendResponse(b ? locateOnPage(b, { auto: false }) : { ok: false, reason: '暂无命中' });
          break;
        }
        case 'RECALIBRATE_LOCATOR': {
          const l = await ensureLocator({ force: true });
          sendResponse({ ok: !!l?.cal, text: describeCalibration(l?.cal), cal: l?.cal || null });
          break;
        }
        case 'PROBE_SEAT_CANVAS': {
          const { seatSvg, baseEl } = detectLayers();
          const mini = document.querySelector('[class*="MiniMap"]');
          const desc = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
              tag: el.tagName, cls: el.getAttribute('class'),
              parentCls: el.parentElement?.getAttribute('class') || null,
              viewBox: el.getAttribute?.('viewBox') || null,
              natural: el.naturalWidth ? `${el.naturalWidth}×${el.naturalHeight}` : null,
              rect: [Math.round(r.width), Math.round(r.height)],
              src: el.currentSrc ? el.currentSrc.split('/').slice(-2).join('/') : null,
            };
          };
          const samples = [];
          if (seatSvg) {
            for (const el of [...seatSvg.querySelectorAll(SEAT_NODE_SEL)].slice(0, 6)) {
              const attrs = {};
              for (const a of el.attributes) attrs[a.name] = String(a.value).slice(0, 48);
              const r = el.getBoundingClientRect();
              samples.push({ tag: el.tagName, attrs, wh: [Math.round(r.width), Math.round(r.height)] });
            }
          }
          const loc = state.locator;
          sendResponse({
            ok: true,
            detail: {
              href: location.href,
              seatLayer: desc(seatSvg),
              base: desc(baseEl),
              minimap: desc(mini),
              seatNodeCount: seatSvg ? seatSvg.querySelectorAll(SEAT_NODE_SEL).length : 0,
              seatNodeSamples: samples,
              apiCanvas: state.catalog?.canvas || null,
              apiSeatCount: state.catalog ? pointsFromCatalog(state.catalog).length : 0,
              pagePointCount: loc?.pagePoints?.length ?? null,
              calibration: loc?.cal ? {
                confidence: loc.cal.confidence, sx: loc.cal.sx, sy: loc.cal.sy,
                dx: loc.cal.dx, dy: loc.cal.dy, swap: loc.cal.swap, rel: loc.cal.rel,
                setName: loc.cal.setName, note: loc.cal.note,
              } : null,
              calText: loc?.cal ? describeCalibration(loc.cal) : null,
            },
          });
          break;
        }
        default:
          sendResponse({ error: 'unknown' });
      }
    } catch (e) { sendResponse({ error: e.message }); }
  })();
  return true;
});

function publicState() {
  const res = state.monitor?.lastResult;
  return {
    href: location.href,
    hasSession: !!state.session,
    session: state.session ? state.session.slice(0, 14) + '…' : '',
    channel: state.channel,
    goodsCode: state.goodsCode, placeCode: state.placeCode, bizCode: state.bizCode, playSeq: state.playSeq,
    statusBlocks: Object.keys(state.status).length,
    catalog: state.catalog ? summarizeCatalog(state.catalog) : null,
    monitoring: !!state.monitor,
    pageReady: pageReady(),
    prefs: state.prefs,
    scans: state.monitor?.scans ?? 0,
    hits: state.monitor?.hits ?? 0,
    seatCanvas: state.seatCanvas,
    timer: timerSnapshot(),
    lastResult: res ? {
      freeSeats: res.freeSeats, blocksWithFree: res.blocksWithFree,
      best: res.best ? { region: res.best.region, rowLabel: res.best.rowLabel, seatNos: res.best.seatNos, len: res.best.len, summary: hitSummary(res.best) } : null,
    } : null,
  };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sleepInterruptible(ms, ctrl) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      ctrl.signal.removeEventListener('abort', done);
      resolve();
    }
    ctrl.signal.addEventListener('abort', done);
  });
}

// ---------------- 启动 ----------------

// 「页面即任务」的续扫规则：
//   页面刷新 / 崩溃恢复后，只有当前打开的还是**上次那一场**（商品号 + 场馆号都一致）
//   才自动续扫；换了演出就绝不擅自开扫 —— 上次的价位/区域参数对新演出没有意义。
(async () => {
  await loadPrefs();
  // 面板位置要在面板建出来之前就备好；万一已经先建了（请求抢跑），loadPanelPos 会就地挪过去
  await loadPanelPos();
  // 验证码关卡的观察器：越早挂越好 —— 刷新后可能直接就停在验证码上
  captchaWatchStart();
  const st = await chrome.storage.local.get(['autoStartTask']).catch(() => ({}));
  const prev = st?.autoStartTask;
  if (prev?.mode !== 'seat') return;
  for (let i = 0; i < 120 && !(state.session && state.goodsCode && state.placeCode); i++) await sleep(300);
  if (!state.session || !state.goodsCode) return;
  if (state.goodsCode !== prev.goodsCode || state.placeCode !== prev.placeCode) {
    await chrome.storage.local.remove('autoStartTask').catch(() => {});
    log('本页不是上次扫描的那场演出，未自动续扫；需要时点「开始捡漏扫描」');
    return;
  }
  try {
    await startMonitor(adHocTask());
    log('已按上次的范围自动续扫', 'hit');
  } catch (e) {
    log('自动续扫失败：' + e.message, 'warn');
  }
})();

log('脚本已就绪，等待页面产生余票请求…');

})();
