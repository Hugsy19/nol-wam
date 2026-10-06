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

import { decodeBlockStatus, SEATS_PER_CHAR } from './nol-api.js';

// ---------------- 文本解析 ----------------

// 从排号里抽区域名。实测 rowNo 形如 "A구역 입장번호" / "E구역 10열" / "10열"
export function regionFromRowNo(rowNo) {
  if (!rowNo) return '';
  const m = String(rowNo).match(/(\d+\s*구역)/);
  if (m) return m[1].replace(/\s+/g, '');
  const m2 = String(rowNo).match(/^([A-Za-z]+\s*구역)/);
  if (m2) return m2[1].replace(/\s+/g, '');
  return '';
}

// 从排号里抽排号，如 "E구역 10열" -> "10열"
export function rowLabelFromRowNo(rowNo) {
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
export function buildCatalog({ blockData = [], seatMeta = [], gradeColors = [] }) {
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
export function stageRef(canvas, stageSide = 'top') {
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
export function scoreSeat(seat, { preference = 'any', stage, stageSide = 'top' } = {}) {
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
export function matchSnapshot(task, catalog, statusByBlock, prevByBlock = null) {
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
export function hitSummary(run) {
  if (!run) return '';
  const range = run.seatNos.length > 1
    ? `${run.seatNos[0]}~${run.seatNos[run.seatNos.length - 1]}`
    : run.seatNos[0];
  return `${run.region || run.blockKey} · ${run.rowLabel} · ${range}`;
}
