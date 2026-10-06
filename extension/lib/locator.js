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

export const LOCATOR_VERSION = 1;

// 从目录里取接口坐标点
export function pointsFromCatalog(catalog, { onlyExposable = true } = {}) {
  const out = [];
  for (const b of catalog.blocks) {
    for (const s of b.seats) {
      if (onlyExposable && !s.exposable) continue;
      out.push({ x: s.x, y: s.y, blockKey: b.key, seat: s });
    }
  }
  return out;
}

export function bounds(pts) {
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
export function candidateApiSets(catalog, { minSeats = 6 } = {}) {
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
export function makePageIndex(pts, { cellScale = 1.8 } = {}) {
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
export function fitStats(cal, apiPts, index, tol) {
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

export function applyCalibration(cal, p) {
  const ax = cal.swap ? p.y : p.x;
  const ay = cal.swap ? p.x : p.y;
  return { x: cal.sx * ax + cal.dx, y: cal.sy * ay + cal.dy };
}

// 主解算：apiPts → pagePts（两边都已是**同一个 user space**下的点）
export function solveCalibration(apiPts, pagePts, { sampleMax = 400 } = {}) {
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

export function describeCalibration(cal) {
  if (!cal) return '未标定';
  const f = (n) => (Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(4));
  const conf = { exact: '精确', rough: '粗略', bad: '不可用', assumed: '推定' }[cal.confidence] || cal.confidence;
  return `${conf} · 缩放 ${f(cal.sx)}/${f(cal.sy)} · 偏移 ${f(cal.dx)},${f(cal.dy)}`
    + `${cal.swap ? ' · x↔y 互换' : ''} · 残差 ${(cal.rel * 100).toFixed(1)}% 座距`;
}

// 无法观测页面座位元素时的兜底推定（页面把座位画进位图 / 座位层不可见时用）
export function guessCalibration(canvas, box, { identityPad = 0.02 } = {}) {
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
export function dropOutliers(boxes) {
  if (boxes.length < 8) return boxes;
  const diag = boxes.map((b) => Math.hypot(b.w, b.h)).sort((a, b) => a - b);
  const med = diag[diag.length >> 1] || 1;
  return boxes.filter((b) => Math.hypot(b.w, b.h) <= med * 4 && b.w > 0 && b.h > 0);
}
