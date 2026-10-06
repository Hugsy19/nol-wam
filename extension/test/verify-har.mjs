// NOL Scout — 真实抓包回归验证
//
// 用法：
//   node test/verify-har.mjs [har路径]
//   默认读取 /Users/hugsy/Downloads/tickets.interpark.com.har
//   （该文件应来自「有票场次」的抓包：goods=26010474 / place=26000166 / playSeq=001）
//
// 本脚本不联网，只把抓包里的原始响应喂给插件的解析/匹配代码，断言结果与抓包事实一致。

import fs from 'node:fs';
import { decodeBlockStatus, freeSeatIndexes } from '../lib/nol-api.js';
import { buildCatalog, matchSnapshot, regionFromRowNo, rowLabelFromRowNo, hitSummary } from '../lib/seat-engine.js';
import {
  pointsFromCatalog, bounds, candidateApiSets, solveCalibration, applyCalibration,
  describeCalibration, dropOutliers, guessCalibration,
} from '../lib/locator.js';
import {
  DEFAULT_SCOUT_PREFS, normalizePrefs, buildAdHocTask, adHocTaskId,
  labelRuns, describePrefs, isAllScoped, resolveScope, describeScope, blockGradeKeys,
  MIN_INTERVAL_MS, INTERVAL_OPTIONS, INTERVAL_AGGRESSIVE_MS,
} from '../lib/seat-prefs.js';
import {
  SEAT_WINDOW_MS, DEFAULT_GRACE_MS, SERVER_FRESH_MS,
  parseSessionStart, resolveAnchor, formatCountdown, countdownPhase,
  reconcile, nextAlarm, describeTimer, remainingMs,
} from '../lib/session-timer.js';
import {
  clampPanelPos, mirrorPanelPos, normalizePanelPos, PANEL_MARGIN, PANEL_MIN_VISIBLE,
} from '../lib/panel-pos.js';
import {
  captchaStage, captchaKindFromClass, captchaPassed, stripCaptchaAnswer,
  elapsedPhase, formatElapsed, describeElapsed,
  captchaBadge, captchaSummary, gateAdvice,
} from '../lib/captcha.js';

const HAR = process.argv[2] || '/Users/hugsy/Downloads/tickets.interpark.com.har';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const head = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(2, 66 - t.length))}`);

// ============================================================
head('1. 解码基础规律（合成数据，锁定位序与极性）');
// ============================================================
{
  const allTaken = decodeBlockStatus('0'.repeat(3), 12);
  ok("全 '0' → 一个座位都不可购（对应售罄场次 34821 字符全为 0）", allTaken.every((x) => x === 0));

  const eight = decodeBlockStatus('8', 4);            // 0b1000
  ok("'8' + 4 座 → 只有第 1 个座位可购（MSB 优先）", eight[0] === 1 && eight[1] === 0 && eight[2] === 0 && eight[3] === 0,
    `[${[...eight]}]`);

  const one = decodeBlockStatus('1', 4);              // 0b0001
  ok("'1' + 4 座 → 只有第 4 个座位可购（反证不是 LSB 优先）", one[0] === 0 && one[1] === 0 && one[2] === 0 && one[3] === 1,
    `[${[...one]}]`);

  const f = decodeBlockStatus('F', 4);
  ok("'F' + 4 座 → 4 个座位全可购", f.every((x) => x === 1));

  const half = decodeBlockStatus('C' + '0', 4);       // 0b1100
  ok("'C' → 前两个座位可购", half[0] === 1 && half[1] === 1 && half[2] === 0 && half[3] === 0);

  const trunc = decodeBlockStatus('F', 4);
  ok('第 3 个座位超出字符串长度时不越界', trunc.length === 4);
  ok('freeSeatIndexes 与 decodeBlockStatus 一致', JSON.stringify(freeSeatIndexes('8', 4)) === '[0]');
}

// ============================================================
let raw;
try { raw = JSON.parse(fs.readFileSync(HAR, 'utf8')); }
catch (e) { console.log(`\n读取抓包失败：${HAR}\n${e.message}`); process.exit(1); }

const entries = raw.log.entries;
const bodyOf = (e) => e.response?.content?.text || '';
const reqOf = (e) => e.request?.postData?.text || '';
const qOf = (u) => {
  const out = {};
  const qi = u.indexOf('?'); if (qi < 0) return out;
  for (const p of u.slice(qi + 1).split('&')) {
    const [k, v] = p.split('=');
    if (!k) continue;
    const val = decodeURIComponent(v || '');
    if (k === 'blockKeys') (out.blockKeys ||= []).push(val); else out[k] = val;
  }
  return out;
};

// 抓包里的原始数据
const seatMetaByBlock = new Map();
for (const e of entries) {
  if (!e.request.url.includes('/onestop/api/seatMeta')) continue;
  for (const blk of JSON.parse(bodyOf(e)).data || []) seatMetaByBlock.set(blk.blockKey, blk.seats);
}
const polls = [];
for (const e of entries) {
  if (!e.request.url.includes('/onestop/api/seatStatus')) continue;
  const keys = qOf(e.request.url).blockKeys || [];
  const data = JSON.parse(bodyOf(e)).data || [];
  polls.push({ at: e.startedDateTime, map: Object.fromEntries(keys.map((k, i) => [k, data[i] ?? ''])) });
}
const blockData = (() => {
  for (const e of entries) {
    if (!e.request.url.includes('/onestop/api/seats/block-data')) continue;
    return JSON.parse(bodyOf(e));
  }
  return null;
})();
const gradesApi = (() => {
  for (const e of entries) {
    if (!e.request.url.includes('/onestop/api/seats/grades')) continue;
    return JSON.parse(bodyOf(e));
  }
  return null;
})();

head('2. 抓包结构');
ok(`抓到 seatMeta（${seatMetaByBlock.size} 个区块）`, seatMetaByBlock.size > 0);
ok(`抓到 seatStatus（${polls.length} 次轮询）`, polls.length >= 2);
ok(`抓到 block-data（${blockData?.length ?? 0} 个区块）`, !!blockData?.length);
ok('抓到 grades', !!gradesApi?.length);
if (!seatMetaByBlock.size || !polls.length) { console.log('\n抓包内容不足，后续跳过'); process.exit(1); }

const first = polls[0].map;

// ============================================================
head('3. 长度对齐：len(status) === ceil(座位数 / 4)');
// ============================================================
{
  let allOk = true;
  for (const [k, seats] of seatMetaByBlock) {
    const expect = Math.ceil(seats.length / 4);
    const got = (first[k] || '').length;
    if (got !== expect) { allOk = false; console.log(`      ${k}: len=${got} 期望 ${expect}（座位 ${seats.length}）`); }
  }
  ok(`${seatMetaByBlock.size}/${seatMetaByBlock.size} 个区块长度吻合`, allOk);
}

// ============================================================
head('4. 关键实证：被锁定座位的位在轮询中由 1 变 0');
// ============================================================
{
  // seats/select 请求里锁定的座位
  let lockedId = null;
  for (const e of entries) {
    if (!e.request.url.includes('/onestop/api/seats/select')) continue;
    const j = JSON.parse(reqOf(e));
    lockedId = j.seats?.[0]?.seatInfoId || null;
  }
  ok('抓到座位锁定请求 seats/select', !!lockedId, lockedId || '');
  if (!lockedId) process.exit(1);

  let found = null;
  for (const [k, seats] of seatMetaByBlock) {
    const i = seats.findIndex((s) => s.seatInfoId === lockedId);
    if (i >= 0) { found = { blockKey: k, idx: i, seat: seats[i] }; break; }
  }
  ok('被锁座位在 seatMeta 中定位到', !!found,
    found ? `${found.blockKey} 下标 ${found.idx}` : '');
  if (!found) process.exit(1);

  const { blockKey, idx } = found;
  const charIdx = idx >> 2;
  const bit = 3 - (idx & 3);
  console.log(`      座位 ${lockedId} → 区块 ${blockKey} 数组下标 ${idx} → 字符 ${charIdx} 第 ${bit} 位（MSB）`);

  const before = first[blockKey] || '';
  const hv = parseInt(before[charIdx], 16);
  ok('锁定时该位为 1（可购）', ((hv >> bit) & 1) === 1, `char[${charIdx}]='${before[charIdx]}' 0b${hv.toString(2).padStart(4, '0')}`);
  ok('该字符形态为 8（仅第 1 位为 1，其余 3 位已售）', before[charIdx] === '8',
    `实际 '${before[charIdx]}'`);

  // 找到字符发生变化的轮询
  let change = null;
  for (let i = 1; i < polls.length; i++) {
    const a = polls[i - 1].map[blockKey] || '';
    const b = polls[i].map[blockKey] || '';
    if (a[charIdx] !== b[charIdx]) { change = { i, from: a[charIdx], to: b[charIdx], at: polls[i].at }; break; }
  }
  ok('后续轮询中该字符发生变化（座位被占）', !!change,
    change ? `${change.from} → ${change.to}` : '无变化');
  if (change) {
    ok('变化方向为 1 → 0（被占用，与"1=可购"一致）', parseInt(change.from, 16) > parseInt(change.to, 16));
    // 该次变化在整份响应里是唯一差异吗？
    const prev = polls[change.i - 1].map[blockKey] || '';
    const cur = polls[change.i].map[blockKey] || '';
    const diffs = [];
    for (let i = 0; i < Math.min(prev.length, cur.length); i++) if (prev[i] !== cur[i]) diffs.push(i);
    ok(`该次变化仅涉及 1 个字符（= 仅 1 张票被锁）`, diffs.length === 1,
      `差异字符下标 [${diffs.join(',')}]`);
  }
}

// ============================================================
head('5. 与官方余票数交叉验证（档位置位数 vs remainCount）');
// ============================================================
{
  // grades 接口按 seatGrade 号给 remainCount；seatMeta 按 seatGrade 号可分组
  for (const g of gradesApi || []) {
    const no = String(g.seatGrade);
    let free = 0;
    for (const [k, seats] of seatMetaByBlock) {
      const str = first[k] || '';
      const flags = decodeBlockStatus(str, seats.length);
      for (let i = 0; i < seats.length; i++) {
        if (flags[i] && String(seats[i].seatGrade) === no && seats[i].isExposable) free++;
      }
    }
    const diff = Math.abs(free - g.remainCount);
    const tol = Math.max(3, Math.round(g.remainCount * 0.01));
    ok(`档位 ${no}（${g.seatGradeName}）可购 ${free} ≈ 官方 remainCount ${g.remainCount}`,
      diff <= tol, `偏差 ${diff} > 容差 ${tol}`);
  }
}

// ============================================================
head('6. 目录构建与文本解析');
// ============================================================
const catalog = buildCatalog({ blockData, seatMeta: [...seatMetaByBlock].map(([blockKey, seats]) => ({ blockKey, seats })), gradeColors: gradesApi || [] });
{
  ok(`区块数 = ${blockData.length}`, catalog.blocks.length === blockData.length);
  ok('区块都解析出了区域名', catalog.blocks.every((b) => !!b.region),
    catalog.blocks.filter((b) => !b.region).map((b) => b.key).join(','));
  ok('价位按号码归并', catalog.grades.length === (gradesApi || []).length,
    catalog.grades.map((g) => `${g.grade}:${g.name}:${g.price}:${g.color}`).join(' | '));
  ok('座位按 seatMeta 原序保存（状态位序依赖此顺序）',
    catalog.blocks.every((b) => b.seats.every((s, i) => s.idx === i)));
  ok('regionFromRowNo("A구역 입장번호") = A구역', regionFromRowNo('A구역 입장번호') === 'A구역');
  ok('rowLabelFromRowNo("E구역 10열") = 10열', rowLabelFromRowNo('E구역 10열') === '10열');
  ok('rowLabelFromRowNo("A구역 입장번호") = 空（站立区没有排号）', rowLabelFromRowNo('A구역 입장번호') === '');
  const rows = catalog.blocks[0].rows;
  ok('区块内按 rowIdx 分行且行内按 x 升序',
    rows.every((r) => r.seats.every((s, i) => i === 0 || s.x >= r.seats[i - 1].x - 1e-6)));
  const sp = rows.map((r) => r.spacing).filter((x) => x > 0.5 && x < 10);
  ok('座距估算落在合理区间（约 3 个坐标单位）', sp.length > 0 && sp.every((x) => x > 0.5 && x < 10),
    sp.slice(0, 6).join(','));
}

// ============================================================
head('7. 命中匹配（座位级 + 几何连座）');
// ============================================================
{
  const statusOf = (m) => Object.fromEntries(catalog.blocks.map((b) => [b.key, m[b.key] || '']));
  const snap = statusOf(first);

  const r1 = matchSnapshot({ quantity: 1, preference: 'any' }, catalog, snap);
  ok('任意档位 / 1 张 → 命中', r1.hit, `freeSeats=${r1.freeSeats}`);
  ok('可购座位数与逐区块解码求和一致',
    r1.freeSeats === [...seatMetaByBlock].reduce((n, [k, seats]) =>
      n + decodeBlockStatus(first[k] || '', seats.length).reduce((a, b) => a + b, 0), 0),
    `${r1.freeSeats}`);
  ok('每段座位都在同一行且 x 间距 ≤ 座距 ×1.35',
    r1.runs.every((run) => {
      const blk = catalog.blocks.find((b) => b.key === run.blockKey);
      const row = blk.rows.find((r) => r.rowIdx === run.rowIdx);
      if (!row) return false;
      for (let i = 1; i < run.seats.length; i++) {
        const a = run.seats[i - 1], b = run.seats[i];
        if (Math.abs(b.x - a.x) > row.spacing * 1.3501) return false;
      }
      return true;
    }));
  ok('命中段按"偏好"排序（score 单调不减）', r1.runs.every((r, i) => i === 0 || r.score >= r1.runs[i - 1].score - 1e-9));
  ok('最优命中携带可下单级别的座位号', !!r1.best?.seatNos?.length && !!r1.best?.grade);

  const r2 = matchSnapshot({ quantity: 3, preference: 'front' }, catalog, snap);
  ok('要求 3 连座时，命中的每段都 ≥3 张', !r2.hit || r2.runs.every((r) => r.len >= 3),
    r2.hit ? `最长段 ${Math.max(...r2.runs.map((r) => r.len))}` : '未命中');

  const big = matchSnapshot({ quantity: 999, preference: 'any' }, catalog, snap);
  ok('要求 999 连座 → 不命中', big.hit === false);

  // 档位过滤：指定不存在的档位名
  const r3 = matchSnapshot({ quantity: 1, grades: ['__不存在的档位__'] }, catalog, snap);
  ok('指定不存在的档位 → 不命中', r3.hit === false && r3.freeSeats === 0);

  // 按档位号过滤
  const gno = catalog.grades[0].grade;
  const r4 = matchSnapshot({ quantity: 1, grades: [gno] }, catalog, snap);
  ok(`按档位号 ${gno} 过滤 → 只统计该档位座位`,
    r4.freeSeats <= r1.freeSeats && (r4.hit === (r4.freeSeats >= 1)),
    `${r4.freeSeats} / 全档 ${r1.freeSeats}`);

  // 区域过滤
  const reg = catalog.regions[0].name;
  const r5 = matchSnapshot({ quantity: 1, regions: [reg] }, catalog, snap);
  ok(`区域过滤「${reg}」→ 命中段都落在该区域`,
    !r5.hit || r5.runs.every((r) => r.region === reg));

  // 回流票检测：对比两次快照
  if (polls.length >= 2) {
    const prev = statusOf(polls[0].map), next = statusOf(polls[1].map);
    const r6 = matchSnapshot({ quantity: 1 }, catalog, next, prev);
    ok('能算出"新出现"的座位列表（回流票）', Array.isArray(r6.newSeats));
  }
}

// ============================================================
head('7b. 模拟回流票：人工把两个相邻座位置为可购，验证精确到座');
// ============================================================
{
  const setBit = (str, pos) => {
    const ci = pos >> 2, bi = 3 - (pos & 3);
    const arr = str.split('');
    arr[ci] = ((parseInt(arr[ci] || '0', 16) | (1 << bi)) & 15).toString(16).toUpperCase();
    return arr.join('');
  };
  // 找一个"行内紧邻、都可见、且状态位下标连续"的座位对（这样中间不会夹其它座位）
  let target = null;
  for (const b of catalog.blocks) {
    for (const row of b.rows) {
      for (let i = 1; i < row.seats.length; i++) {
        const a = row.seats[i - 1], c = row.seats[i];
        if (a.exposable && c.exposable && Math.abs(c.x - a.x) <= row.spacing * 1.2) {
          target = { block: b, row, a, b: c }; break;
        }
      }
      if (target) break;
    }
    if (target) break;
  }
  ok('找到可用于模拟的相邻座位对', !!target,
    target ? `${target.block.key}(${target.block.region}) 行${target.row.rowIdx} ${target.a.seatNo}号/${target.b.seatNo}号` : '');
  if (target) {
    // 以"全不可购"为底，只放开这两个座位（模拟这两张票刚回流）
    let str = '0'.repeat(Math.ceil(target.block.seatCount / 4));
    str = setBit(str, target.a.idx);
    str = setBit(str, target.b.idx);
    const snap = { [target.block.key]: str };

    const r = matchSnapshot(
      { quantity: 2, preference: 'any' },
      catalog,
      snap,
      { [target.block.key]: first[target.block.key] || '' },
    );
    ok('恰好命中一段 2 连座', r.hit && r.runs.length === 1 && r.best.len === 2,
      `runs=${r.runs.length} len=${r.best?.len}`);
    ok('命中的正是人工放开的那两个座号',
      r.best && r.best.seatNos.join(',') === [target.a.seatNo, target.b.seatNo].join(','),
      `得到 ${r.best?.seatNos.join(',')} 期望 ${target.a.seatNo},${target.b.seatNo}`);
    ok('携带可下单的 seatInfoId', r.best?.seatIds?.length === 2 && r.best.seatIds[0] === target.a.id);
    ok('"新出现"列表就是这两个座位', r.newSeats.length === 2 && r.newSeats.some((s) => s.id === target.a.id));

    const r2 = matchSnapshot({ quantity: 3, preference: 'any' }, catalog, snap);
    ok('需求 3 张时不命中（只有 2 张回流）', r2.hit === false);
  }
}

head('8. 页面定位标定（真实座位坐标闭环，v0.4）');
{
  const api = pointsFromCatalog(catalog);
  ok('拿到接口座位点', api.length > 100, `${api.length}`);
  const T = (t, p) => ({
    x: t.sx * (t.swap ? p.y : p.x) + t.dx,
    y: t.sy * (t.swap ? p.x : p.y) + t.dy,
  });

  const round = (t, name, expectSwap) => {
    const page = api.map((p) => T(t, p));
    const cal = solveCalibration(api, page);
    ok(`${name} → 解出精确标定`, !!cal && cal.confidence === 'exact', cal ? describeCalibration(cal) : 'null');
    if (!cal) return;
    ok(`${name} → 缩放还原误差 <0.5%`,
      Math.abs(cal.sx - t.sx) / t.sx < 0.005 && Math.abs(cal.sy - t.sy) / t.sy < 0.005,
      `${cal.sx}/${t.sx}`);
    ok(`${name} → 偏移还原误差 ≤1 个座距`,
      Math.abs(cal.dx - t.dx) <= cal.pitch && Math.abs(cal.dy - t.dy) <= cal.pitch,
      `dx ${cal.dx.toFixed(2)} vs ${t.dx.toFixed(2)} · pitch ${cal.pitch.toFixed(2)}`);
    if (expectSwap !== undefined) ok(`${name} → x↔y 互换判定正确`, cal.swap === expectSwap, String(cal.swap));
    const maxErr = Math.max(...api.map((p) => {
      const a = T(t, p), b = applyCalibration(cal, p);
      return Math.hypot(a.x - b.x, a.y - b.y);
    }));
    ok(`${name} → 逐座位落点最大误差 <1 个座距`, maxErr < cal.pitch, `maxErr=${maxErr.toFixed(3)} pitch=${cal.pitch.toFixed(3)}`);
  };

  round({ sx: 2.3, sy: 2.3, dx: -100, dy: 50 }, '等比缩放（页面放大 2.3×）');
  round({ sx: 1.7, sy: 2.4, dx: 12, dy: -80 }, '非等比缩放（页面拉伸）');
  round({ swap: true, sx: 0.9, sy: 0.9, dx: 30, dy: 0 }, 'x↔y 互换（场地图旋转 90°）', true);

  // 关键事实：非可见的"结算用虚拟座位"坐标会溢出底图（26000166 的 001:014 就在 x=353~380），
  // 标定必须只用 isExposable 的座位，否则包围盒被拉偏——这正是旧版定位跑偏的原因之一。
  const allSeats = bounds(pointsFromCatalog(catalog, { onlyExposable: false }));
  ok('含虚拟座位的坐标会溢出 316×305 底图', allSeats.x1 > 316,
    `bbox ${allSeats.x0.toFixed(1)}~${allSeats.x1.toFixed(1)} × ${allSeats.y0.toFixed(1)}~${allSeats.y1.toFixed(1)}`);
  const vis = bounds(api);
  ok('只用可见座位时坐标落在 316×305 底图内', vis.x1 <= 316 && vis.y1 <= 305,
    `bbox ${vis.x0.toFixed(1)}~${vis.x1.toFixed(1)} × ${vis.y0.toFixed(1)}~${vis.y1.toFixed(1)}`);

  const fx = 316 / vis.w, fy = 305 / vis.h;
  round({ sx: fx, sy: fy, dx: -vis.x0 * fx, dy: -vis.y0 * fy }, '压进 316×305 底图空间');
}

{
  // 页面只渲染当前放大区块的情形（最常见的真实场景）
  const sets = candidateApiSets(catalog);
  ok('候选集合含"全部"与逐区块', sets.some((s) => s.name === 'all') && sets.length > 1, `${sets.length} 个候选`);
  const target = sets.filter((s) => s.name !== 'all' && s.pts.length > 50)
    .sort((a, b) => b.pts.length - a.pts.length)[0];
  const t = { sx: 3.1, sy: 3.1, dx: 40, dy: -25 };
  const page = target.pts.map((p) => ({
    x: t.sx * p.x + t.dx,
    y: t.sy * p.y + t.dy,
  }));

  let best = null;
  for (const set of sets) {
    const dc = Math.abs(set.pts.length - page.length) / Math.max(1, set.pts.length);
    if (set.name !== 'all' && dc > 0.3) continue;
    if (set.name === 'all' && dc > 0.3 && sets.length > 1) continue;
    const c = solveCalibration(set.pts, page);
    if (!c) continue;
    const score = c.rel + dc * 0.5;
    if (!best || score < best.score) best = { score, c, name: set.name, label: set.label };
  }
  ok(`只有 ${target.label} 被渲染时能挑对区块`, best?.name === target.name, `挑到 ${best?.name}`);
  ok('单区块标定同样精确', best?.c?.confidence === 'exact', best ? describeCalibration(best.c) : 'null');
}

{
  const pts = pointsFromCatalog(catalog).map((p) => ({ ...p, w: 3, h: 3 }));
  const withNoise = pts.concat([{ x: 0, y: 0, w: 400, h: 400 }, { x: 10, y: 10, w: 320, h: 300 }]);
  ok('大元素（区块底纹/边界）被剔除', dropOutliers(withNoise).length === pts.length,
    `${dropOutliers(withNoise).length} / ${pts.length}`);

  // 确定性伪随机，避免测试抖动
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const chaos = pointsFromCatalog(catalog).map(() => ({ x: rnd() * 4000, y: rnd() * 4000 }));
  const cal = solveCalibration(pointsFromCatalog(catalog), chaos);
  ok('完全对不上的点集不会被误判为精确', !cal || cal.confidence !== 'exact', cal ? cal.confidence : 'null');
}

{
  // 页面无法观测座位元素时的兜底（抓包里 26000166 的底图 SVG 实测 viewBox="0 0 316 305"）
  const venueBox = { x: 0, y: 0, w: 316, h: 305 };
  const g = guessCalibration(catalog.canvas, venueBox);
  ok('可见座位落在底图内 → 推定 1:1（旧版会把 bbox 错误地拉满整张画布）',
    g?.mode === 'identity' && g.sx === 1 && g.sy === 1 && g.dx === 0 && g.dy === 0,
    g ? `${g.mode} sx=${g.sx}` : 'null');
  const g2 = guessCalibration({ minX: 0, minY: 0, maxX: 400, maxY: 300 }, { x: 0, y: 0, w: 100, h: 100 });
  ok('接口坐标超出底图 → 等比居中适配（不失真）',
    !!g2 && g2.sx === g2.sy && Math.abs(g2.sx - 100 / 400) < 1e-9,
    g2 ? `sx=${g2.sx.toFixed(4)}` : 'null');
}

// ============================================================
head('9. 捡漏参数与「页面即任务」+ 候选优先级队列（v0.5）');
// ============================================================
{
  // ---- 参数规整 ----
  const n = normalizePrefs({ grades: ['1', '1', '2'], regions: ['A구역'], quantity: 99, preference: '不存在', intervalMs: 50 });
  ok('张数被夹到上限 8', n.quantity === 8, String(n.quantity));
  ok('轮询间隔被夹到下限 800ms（v0.6 起放宽；不得比官网刷新快一个数量级）',
    n.intervalMs === MIN_INTERVAL_MS, String(n.intervalMs));
  ok('价位去重且转成字符串', JSON.stringify(n.grades) === '["1","2"]', JSON.stringify(n.grades));
  ok('非法位置偏好回落为 any', n.preference === 'any', n.preference);
  ok('张数非数字时回落为 1', normalizePrefs({ quantity: 'abc' }).quantity === 1);

  const d = normalizePrefs();
  ok('空输入 = 全部价位/全部区域/1 张/不挑位置/2800ms',
    isAllScoped(d) && d.quantity === 1 && d.preference === 'any' && d.intervalMs === DEFAULT_SCOUT_PREFS.intervalMs,
    JSON.stringify(d));
  ok('normalizePrefs 幂等（反复读写 storage 不会漂移）',
    JSON.stringify(normalizePrefs(n)) === JSON.stringify(n));

  // ---- 现场任务：用真实抓包里的页面上下文 ----
  const page = { goodsCode: '26010474', placeCode: '26000166', bizCode: '10965', playSeq: '001' };
  const task = buildAdHocTask(page, { quantity: 2, preference: 'front', intervalMs: 2000 });
  ok('现场任务被标记 adHoc（浏览器重启后不自动拉起）', task.adHoc === true && task.mode === 'seat');
  ok('场次不锁死（playSeqs 留空）—— 页面即场次', task.playSeqs.length === 0);
  ok('页面上下文原样带入（商品号/场馆号/业务码）',
    task.goodsCode === '26010474' && task.placeCode === '26000166' && task.bizCode === '10965');
  ok('参数带到任务上', task.quantity === 2 && task.preference === 'front' && task.intervalMs === 2000);
  ok('同一页面反复点开始 → id 稳定，不堆垃圾任务',
    buildAdHocTask(page, {}) .id === task.id, `${task.id} vs ${adHocTaskId(page)}`);
  ok('切到别的场次 → 得到不同 id',
    buildAdHocTask({ ...page, playSeq: '003' }, {}).id !== task.id);
  ok('缺商品号/场馆号时给出可操作的报错', (() => {
    try { buildAdHocTask({}, {}); return false; }
    catch (e) { return /选座页/.test(e.message); }
  })());

  // ---- 端到端：现场任务直接跑真实快照 ----
  const snap = Object.fromEntries(catalog.blocks.map((b) => [b.key, first[b.key] || '']));
  const res = matchSnapshot(buildAdHocTask(page, { quantity: 1 }), catalog, snap);
  ok('现场任务（不填任何号，只靠页面）直接跑匹配 → 命中', res.hit, `freeSeats=${res.freeSeats}`);

  if (res.hit) {
    // ---- 候选优先级队列 ----
    const queue = labelRuns(res.runs, 3);
    ok('队列 = 首选 + 备份（最多 3 条）',
      queue.length === Math.min(3, res.runs.length) && queue[0].label === '首选',
      queue.map((q) => q.label).join('/'));
    ok('备份顺序为 备份1 / 备份2',
      queue.slice(1).every((q, i) => q.label === `备份${i + 1}`),
      queue.map((q) => q.label).join('/'));
    ok('队列保持"按位置偏好"排序（score 单调不减）',
      queue.every((q, i) => i === 0 || (q.run.score ?? 0) >= (queue[i - 1].run.score ?? 0) - 1e-9));
    ok('队列第 1 顺位就是最优座位（不会与 best 脱节）',
      queue[0].run.seatIds.join() === res.best.seatIds.join(),
      `${hitSummary(queue[0].run)} vs ${hitSummary(res.best)}`);
    ok('队列每一条都带着可下单级别的座号与 seatInfoId',
      queue.every((q) => q.run.seatNos.length && q.run.seatIds.length === q.run.seatNos.length));
    ok('空输入安全', labelRuns(null).length === 0 && labelRuns([]).length === 0 && labelRuns(undefined, 0).length === 0);
    ok('不满足张数（len=0）的段不会混进队列', labelRuns([{ len: 0, score: 0 }, res.best], 3).length === 1);

    // ---- 参数摘要 ----
    const nameOf = new Map(catalog.grades.map((g) => [String(g.grade), g.name]));
    ok('默认参数摘要 =「全部价位 · 全部区域 · 1 张 · 不挑位置」',
      describePrefs({}, nameOf) === '全部价位 · 全部区域 · 1 张 · 不挑位置', describePrefs({}, nameOf));
    ok('指定档位号时摘要显示档位名而不是裸号码',
      describePrefs({ grades: [catalog.grades[0].grade], quantity: 2, preference: 'center' }, nameOf)
        .includes(catalog.grades[0].name),
      describePrefs({ grades: [catalog.grades[0].grade], quantity: 2, preference: 'center' }, nameOf));
  }

  // ---- 张数需求如实传递 ----
  const t3 = buildAdHocTask(page, { quantity: 3 });
  const r3 = matchSnapshot(t3, catalog, snap);
  ok('张数 = 3 的现场任务 → 命中的每段都 ≥3 张（或明确不命中）',
    !r3.hit || r3.runs.every((r) => r.len >= 3),
    r3.hit ? `最长 ${Math.max(...r3.runs.map((r) => r.len))}` : '未命中');
}

head('9b. 选区解算：点一下区域/价位，到底选中了哪些区块（v0.5.1）');
// ============================================================
{
  const exposable = catalog.blocks.filter((b) => b.seats.some((s) => s.exposable));
  const scopeAll = resolveScope({}, catalog);
  ok('不筛 = 全部区块都在范围内',
    !scopeAll.narrow && scopeAll.selected === exposable.length && scopeAll.total === exposable.length,
    `${scopeAll.selected}/${scopeAll.total}`);
  ok('不筛时的"座数"口径 = 可见座位总数',
    scopeAll.selectedSeats === exposable.reduce((n, b) => n + b.exposableCount, 0));
  ok('has() 在不筛时恒为 true', catalog.blocks.every((b) => scopeAll.has(b.key)));

  // ★ 这是本次修掉的核心 bug：档位**号** vs 档位**名**
  const g0 = String(catalog.grades[0].grade);
  const scopeOneCycle = resolveScope({ grades: [g0] }, catalog);
  ok('按档位号筛区块 → 命中数 > 0（早期版本拿号码比名字，结果恒为 0）',
    scopeOneCycle.selected > 0, `selected=${scopeOneCycle.selected}`);
  const byNo = exposable.filter((b) => (b.gradeNos || []).map(String).includes(g0)).length;
  ok('按档位号筛区块 → 与 gradeNos 直接比对结果一致',
    scopeOneCycle.selected === byNo, `${scopeOneCycle.selected} vs ${byNo}`);
  ok('按档位名筛（老口径）会被识别为"筛不出东西" —— 证明两者确实不是一回事',
    resolveScope({ grades: [catalog.grades[0].name] }, catalog).selected !== scopeOneCycle.selected);

  const r0 = catalog.regions[0];
  const scopeRegion = resolveScope({ regions: [r0.name] }, catalog);
  ok('按区域筛 → 只选中该区域的区块',
    scopeRegion.selected === exposable.filter((b) => b.region === r0.name).length
      && scopeRegion.selected > 0,
    `${scopeRegion.selected} vs ${exposable.filter((b) => b.region === r0.name).length}`);
  ok('按区域筛 → 区域统计里只有这一个区域',
    scopeRegion.selectedRegions.length === 1 && scopeRegion.selectedRegions[0].name === r0.name);
  ok('按区域筛 → 未选中的区块 has() === false',
    exposable.filter((b) => b.region !== r0.name).every((b) => !scopeRegion.has(b.key)));

  // 区域 × 档位 = 与关系
  const both = resolveScope({ regions: [r0.name], grades: [g0] }, catalog);
  const manualBoth = exposable.filter((b) =>
    b.region === r0.name && (b.gradeNos || []).map(String).includes(g0)).length;
  ok('区域 + 档位是「与」关系（同时满足才算选中）',
    both.selected === manualBoth, `${both.selected} vs ${manualBoth}`);
  ok('同时筛时选中的区块 ⊆ 只筛区域时的区块', [...both.inKeys].every((k) => scopeRegion.inKeys.has(k)));
  ok('筛选后座数 ≤ 全选座数', both.selectedSeats <= scopeAll.selectedSeats);

  // 互斥组合：不存在的区域 → 0 块，而不是"当作没筛"
  const none = resolveScope({ regions: ['不存在的区域'] }, catalog);
  ok('筛一个不存在的区域 → 0 区块（不能默默退化成"全部"）',
    none.narrow && none.selected === 0 && !none.has(catalog.blocks[0].key),
    `selected=${none.selected}`);
  ok('0 命中时不报错且摘要可读', typeof describeScope(none) === 'string' && describeScope(none).includes('0'));

  // 虚拟结算区块不得混进来
  const VIRTUAL = catalog.blocks.filter((b) => !b.seats.some((s) => s.exposable));
  if (VIRTUAL.length) {
    ok('isExposable=false 的结算用虚拟区块不参与展示口径',
      VIRTUAL.every((b) => !scopeAll.inKeys.has(b.key)), `虚拟区块 ${VIRTUAL.length} 个`);
    ok('但扫描口径（exposableOnly:false）仍然带上它们，避免漏轮询',
      VIRTUAL.every((b) => resolveScope({}, catalog, { exposableOnly: false }).inKeys.has(b.key)));
  }

  ok('describeScope(不筛) 给出全部区块数',
    /全部\s*\d+\s*区块/.test(describeScope(scopeAll)), describeScope(scopeAll));
  ok('describeScope(筛后) 给出 已选 X / Y 区块',
    /已选\s*\d+\s*\/\s*\d+\s*区块/.test(describeScope(scopeRegion)), describeScope(scopeRegion));
  ok('选区摘要里带上区域明细（能读出是哪几个块）',
    describeScope(scopeRegion).includes(r0.name), describeScope(scopeRegion));

  // 与 targetBlocks 同口径：面板说选中了几个，扫描就该扫几个
  const page9b = { goodsCode: '26010474', placeCode: '26000166', playSeq: '001' };
  const t = buildAdHocTask(page9b, { grades: [g0], regions: [r0.name] });
  ok('选区解算与任务构造同口径（面板显示 = 实际扫描范围）',
    t.grades.length === 1 && t.regions.length === 1
      && resolveScope(t, catalog).selected === manualBoth);
}

head('10. 选座 10 分钟倒计时（锚点取自真实抓包）');
// ============================================================
{
  // 抓包里的会话令牌：x-onestop-session = 26010474_M0000001661831791271752
  const sessEntry = entries.find((e) =>
    (e.request.headers || []).some((h) => h.name.toLowerCase() === 'x-onestop-session'));
  const token = sessEntry
    ? sessEntry.request.headers.find((h) => h.name.toLowerCase() === 'x-onestop-session').value
    : '';
  ok('抓包里确实拿到了 x-onestop-session 头', !!token, token);
  ok('令牌形如 {goodsCode}_M{userSeq 补零 12 位}{10 位 Unix 秒}', /^26010474_M\d{12}\d{10}$/.test(token), token);

  const start = parseSessionStart(token);
  ok('能从令牌末 10 位解出会话起点', Number.isFinite(start), String(start));
  const tokenSec = Number(/(\d{10})$/.exec(token)[1]);
  ok('解出的起点秒数 = 令牌尾数', start === tokenSec * 1000, `${start} vs ${tokenSec * 1000}`);

  // ★ 关键实证：令牌尾数必须 ≈ 排队放行的那一刻（waiting/api/rank 最后一次返回）
  const ranks = entries.filter((e) => /\/waiting\/api\/rank/.test(e.request.url));
  ok('抓包里有排队 rank 请求', ranks.length > 0, `${ranks.length} 次`);
  const lastRankMs = Math.max(...ranks.map((e) => Date.parse(e.startedDateTime)));
  const driftMs = Math.abs(lastRankMs - start);
  ok('令牌尾数与"排队放行时刻"吻合（±2s 内）——证明它就是会话起点',
    driftMs < 2000, `相差 ${driftMs}ms`);

  // 反向校验：选座页的 seat.json 一定发生在会话开始之后（不然就不是"起点"）
  const seatJson = entries.filter((e) => /_next\/data.*seat\.json/.test(e.request.url));
  ok('选座页 seat.json 请求晚于令牌时刻（起点早于进页，说明计的是"整段 10 分钟"）',
    seatJson.length > 0 && seatJson.every((e) => Date.parse(e.startedDateTime) >= start - 1000),
    seatJson.length ? new Date(Math.min(...seatJson.map((e) => Date.parse(e.startedDateTime)))).toISOString() : '无');

  // 语言包里的 10 分钟文案（时限不是我们猜的）
  const enCommon = entries.find((e) => /locales\/en\/common\.json/.test(e.request.url));
  const localeText = enCommon ? bodyOf(enCommon) : '';
  ok('站点语言包自证 10 分钟时限（en: "Your 10-minute seat selection time has expired"）',
    /10-minute seat selection time/.test(localeText));
  ok('选座计时器标签存在（Seat selection time）', /"session_timer_label_seat"/.test(localeText));

  // 权威终点：页面自己在轮询 ExpiredSession
  const gqlExpired = entries.filter((e) => /onestop\/gql/.test(e.request.url)
    && /isExpiredSession/.test(reqOf(e)));
  ok('页面自身在轮询 GraphQL ExpiredSession（我们只读旁听，零额外请求）', gqlExpired.length > 0, `${gqlExpired.length} 次`);
  if (gqlExpired.length) {
    ok('ExpiredSession 返回布尔值，可作权威超时开关',
      /"isExpiredSession"\s*:\s*(true|false)/.test(bodyOf(gqlExpired[0])), bodyOf(gqlExpired[0]).slice(0, 60));
  }

  // --- 解析健壮性 ---
  ok('缺尾数 → null', parseSessionStart('26010474_M000000166183') === null);
  ok('空/非串 → null', parseSessionStart('') === null && parseSessionStart(null) === null);
  ok('数字越界（把 userSeq 当时间）→ null', parseSessionStart('26010474_M0000001661830000000001') === null);
  ok('正常令牌可解', parseSessionStart('26010474_M0000001661831791271752') === 1791271752000);

  const fallback = resolveAnchor('26010474_M000000166183', 1700000000000);
  ok('解不出时间戳 → 退化为"首次观测"锚点而非报错',
    fallback.anchor === 'observed' && fallback.startMs === 1700000000000 && fallback.confidence === 'assumed');
  ok('可解时优先用令牌锚点',
    resolveAnchor('26010474_M0000001661831791271752', 1).anchor === 'token');

  // --- 10 分钟窗口 ---
  const deadline = start + SEAT_WINDOW_MS;
  ok('时限 = 起点 + 10 分钟', deadline - start === 600000);
  ok('刚进来时剩余 10:00', formatCountdown(remainingMs(deadline, start)) === '10:00',
    formatCountdown(remainingMs(deadline, start)));
  ok('抓包里进选座页 20s 时剩余约 9:40',
    formatCountdown(remainingMs(deadline, start + 20000)) === '09:40',
    formatCountdown(remainingMs(deadline, start + 20000)));
  ok('剩余 9s 显示 00:09', formatCountdown(9000) === '00:09');
  ok('超时显示 00:00（不出现负数）', formatCountdown(-5000) === '00:00');
  ok('非法输入显示 --:--', formatCountdown(NaN) === '--:--');
  ok('超过 1 小时给 H:MM:SS', formatCountdown(3661000) === '1:01:01', formatCountdown(3661000));

  ok('分档：>5min → ok', countdownPhase(400000) === 'ok');
  ok('分档：≤5min → warn', countdownPhase(299000) === 'warn');
  ok('分档：≤1min → danger', countdownPhase(59000) === 'danger');
  ok('分档：≤0 → expired', countdownPhase(0) === 'expired');

  // --- 判停规则：本地钟 + 服务端开关 ---
  const T0 = 1791271752000;
  const live = reconcile({ nowMs: T0 + 60000, deadlineMs: deadline, serverExpired: false, serverCheckedAt: T0 + 60000 });
  ok('时间没到 → live', live.state === 'live' && live.remaining === 540000, JSON.stringify(live));

  const byServer = reconcile({ nowMs: T0 + 60000, deadlineMs: deadline, serverExpired: true, serverCheckedAt: T0 + 60000 });
  ok('★ 服务端说 expired → 立刻 dead（不看本地钟）',
    byServer.state === 'dead' && byServer.reason === 'server');

  const grace = reconcile({ nowMs: deadline + 5000, deadlineMs: deadline, serverExpired: false, serverCheckedAt: deadline - 1000 });
  ok('★ 本地归零但服务端刚说 false → 宽限（不误停还能买的场次）',
    grace.state === 'grace' && grace.graceLeftMs > 0, JSON.stringify(grace));

  const graceOut = reconcile({
    nowMs: deadline + DEFAULT_GRACE_MS + 1000, deadlineMs: deadline,
    serverExpired: false, serverCheckedAt: deadline + DEFAULT_GRACE_MS,
  });
  ok('宽限耗尽 → dead', graceOut.state === 'dead' && graceOut.reason === 'local');

  const stale = reconcile({ nowMs: deadline + 1000, deadlineMs: deadline, serverExpired: null, serverCheckedAt: 0 });
  ok('本地归零且没有服务端证据 → dead（不无限拖）', stale.state === 'dead');
  ok('观测过旧（超过新鲜期）不再采信',
    reconcile({ nowMs: deadline + 1000, deadlineMs: deadline, serverExpired: false, serverCheckedAt: deadline - SERVER_FRESH_MS - 5000 }).state === 'dead');
  ok('没有锚点时不判停', reconcile({ nowMs: T0, deadlineMs: NaN }).state === 'live');

  // --- 告警只跨档响一次 ---
  ok('首次进入 warn 档会告警', nextAlarm(null, 240000).warn && nextAlarm(null, 240000).level === 'warn');
  ok('已经 warn 过再 tick 不重复告警', !nextAlarm('warn', 230000).warn);
  ok('warn → danger 跨档要告警', nextAlarm('warn', 55000).warn && nextAlarm('warn', 55000).level === 'danger');
  ok('danger → expired 跨档要告警', nextAlarm('danger', 0).warn && nextAlarm('danger', 0).level === 'expired');
  ok('回退到 ok 档不告警', !nextAlarm(null, 600000).warn);

  ok('describeTimer 解释计时来源', /令牌|观测/.test(describeTimer({ confidence: 'exact', deadlineMs: deadline })));

  // --- 与面板/popup 共用的参数边界 ---
  ok('轮询下限已下调到 800ms', MIN_INTERVAL_MS === 800);
  ok('参数规整会把 100ms 夹到下限', normalizePrefs({ intervalMs: 100 }).intervalMs === MIN_INTERVAL_MS);
  ok('档位列表含下限且递增',
    INTERVAL_OPTIONS[0] === MIN_INTERVAL_MS
      && INTERVAL_OPTIONS.every((v, i) => i === 0 || v > INTERVAL_OPTIONS[i - 1]));
  ok('800ms 低于激进阈值（面板会提示限流风险）', INTERVAL_OPTIONS.filter((v) => v < INTERVAL_AGGRESSIVE_MS).length === 1);
}

// ============================================================
head('11. 悬浮面板定位（默认贴左 + 夹视口 + 拖后记忆，v0.6.1）');

{
  const W = 372, VW = 1440, VH = 900;
  const base = { w: W, vw: VW, vh: VH };

  // --- 默认位：贴左。贴右会压住 NOL 的选座区域，这是本次改动的初衷 ---
  const d = clampPanelPos(PANEL_MARGIN, 80, base);
  ok('默认落在页面左边（left = 16，明显在中线左侧）', d.left === PANEL_MARGIN && d.left + W / 2 < VW / 2);
  ok('默认纵向不越过顶栏', d.top === 80);

  // --- 屏幕外坐标必须被拉回来，否则标题栏抓不到，面板等于消失 ---
  ok('拖出左边界 → 拉回左边距', clampPanelPos(-500, 80, base).left === PANEL_MARGIN);
  ok('拖出右边界 → 拉回右边距', clampPanelPos(99999, 80, base).left === VW - W - PANEL_MARGIN);
  ok('拖出上边界 → 拉回上边距', clampPanelPos(120, -300, base).top === PANEL_MARGIN);
  ok('拖出下边界 → 至少留 120px 让标题栏可抓', clampPanelPos(120, 5000, base).top === VH - PANEL_MIN_VISIBLE);

  // --- 视口比面板还窄时，不能把 left 夹成负数（那会把面板推出屏幕） ---
  const narrow = clampPanelPos(100, 100, { w: 900, vw: 600, vh: 400 });
  ok('窄窗口下 left 不退化成负数', narrow.left === PANEL_MARGIN);
  // --- 换窗口大小 / 换显示器：旧坐标要重新夹一次 ---
  const shrunk = clampPanelPos(1000, 700, { w: W, vw: 800, vh: 500 });
  ok('窗口变小后旧坐标被夹回可见区', shrunk.left === 800 - W - PANEL_MARGIN && shrunk.top <= 500 - PANEL_MIN_VISIBLE);

  // --- 贴左 / 贴右 一键切换 ---
  const toRight = mirrorPanelPos({ left: PANEL_MARGIN, top: 80 }, { w: W, vw: VW });
  ok('贴左 → 翻到右边距', toRight.left === VW - W - PANEL_MARGIN && toRight.top === 80);
  ok('再翻一次回到左边（可来回切）',
    mirrorPanelPos(toRight, { w: W, vw: VW }).left === PANEL_MARGIN);
  // 判边要看**中心点**：左值很小但面板很宽时，中心其实已经在右半屏
  ok('用中心点判当前在哪一侧（宽面板）',
    mirrorPanelPos({ left: 500, top: 0 }, { w: 900, vw: VW }).left === PANEL_MARGIN);

  // --- storage 里的东西不可信，先规整 ---
  ok('空值 / 非对象一律不认', normalizePanelPos(null) === null && normalizePanelPos('x') === null);
  ok('缺字段不认', normalizePanelPos({}) === null && normalizePanelPos({ left: 10 }) === null);
  ok('非数字坐标不认', normalizePanelPos({ left: 'abc', top: 10 }) === null);
  ok('合法坐标规整成数字',
    JSON.stringify(normalizePanelPos({ left: '120', top: '80' })) === '{"left":120,"top":80}');

  // --- 打包产物自检：改动确实进了 content/seat-bundle.js ---
  const bundle = fs.readFileSync(new URL('../content/seat-bundle.js', import.meta.url), 'utf8');
  const hint = '（打包产物过期？先跑 node tools/build.mjs）';
  ok('打包产物默认锚点是 left（不再是 right）',
    /z-index:2147483000;left:\$\{PANEL_MARGIN\}px;top:\$\{PANEL_DEFAULT_TOP\}px/.test(bundle), hint);
  ok('旧的右上角锚点已彻底消失', !/z-index:2147483000;right:16px/.test(bundle), hint);
  ok('夹视口 / 镜像 / 落盘 三件事都在产物里',
    /function clampPanelPos/.test(bundle) && /function mirrorPanelPos/.test(bundle)
      && /savePanelPos\(applyPanelPos/.test(bundle));
  ok('松手即记忆（拖完刷新回原位）', /function savePanelPos/.test(bundle) && /PANEL_POS_KEY = 'panelPos'/.test(bundle));
  ok('头部有贴左/贴右切换按钮', /data-act="flip"/.test(bundle));
  ok('启动时会读回记忆位置', /await loadPanelPos\(\)/.test(bundle));
}

// ============================================================
head('12. 验证码关卡：只观察不代填（v0.7）');

{
  // --- 请求识别（真实抓包里的两个 endpoint）---
  ok('captcha/image 判为关卡出现',
    captchaStage('https://tickets.interpark.com/onestop/api/captcha/image') === 'image');
  ok('captcha/verify 判为交答案',
    captchaStage('https://tickets.interpark.com/onestop/api/captcha/verify?p1=XUTBKZ&p2=26010474_M000') === 'verify');
  ok('seatStatus 不会被误判', captchaStage('https://tickets.interpark.com/onestop/api/seatStatus?blockKeys=001:001') === '');
  ok('gql 不会被误判', captchaStage('https://tickets.interpark.com/onestop/gql') === '');

  // --- 答案绝不落进日志（verify 的答案挂在 p1 上）---
  const vu = 'https://tickets.interpark.com/onestop/api/captcha/verify?p1=XUTBKZ&p2=26010474_M0000001661831791271752&p9=J66lJXbiJaZm8bIZ';
  const stripped = stripCaptchaAnswer(vu);
  ok('答案 p1 被抹掉', !stripped.includes('XUTBKZ') && stripped.includes('p1=***'));
  ok('其余参数保留（排查时还需要）', stripped.includes('p2=') && stripped.includes('p9='));

  // --- 类型判定（class 带构建哈希，只能包含匹配）---
  ok('captchaBox → 文字验证码', captchaKindFromClass('ModalCaptchaText_captchaBox__B_pUV') === 'text');
  ok('captchaInput → 文字验证码', captchaKindFromClass('ModalCaptchaText_captchaInput__DC7Gz') === 'text');
  ok('captchaPlugin → 滑块验证码', captchaKindFromClass('ModalCaptchaSlider_captchaPlugin__PLzG6') === 'slider');
  ok('座位层 class 判不出来（不会误报）', captchaKindFromClass('SeatMap_seatGroup__dH6wd') === '');

  // --- 结果判定：服务端返回 {"result":"Y"} ---
  ok('{"result":"Y"} → 通过', captchaPassed('{"result":"Y"}') === true);
  ok('{"result":"N"} → 未通过', captchaPassed('{"result":"N"}') === false);
  ok('小写 y 也认', captchaPassed('{"result":"y"}') === true);
  ok('布尔 true 也认', captchaPassed({ result: true }) === true);
  ok('垃圾响应返回 null（转走 DOM 兜底）', captchaPassed('<html>502</html>') === null && captchaPassed('') === null);

  // --- 耗时分档：实测那一场是 8.3 秒 ---
  ok('6s 内算正常', elapsedPhase(5999) === 'ok');
  ok('6s 起算偏慢', elapsedPhase(6000) === 'slow');
  ok('12s 起算太慢', elapsedPhase(12000) === 'bad');
  ok('实测的 8.3s 落在「偏慢」档', elapsedPhase(8340) === 'slow');
  ok('格式化：10 秒内给一位小数', formatElapsed(8340) === '8.3s');
  ok('格式化：超过 10 秒取整（不啰嗦）', formatElapsed(42100) === '42s');
  ok('describeElapsed 带档位', describeElapsed(8340) === '8.3s · 偏慢');

  // --- 徽标文案：剩余时间必须是主角，耗时是副标题 ---
  const b = captchaBadge({ remainingText: '09:41', elapsedMs: 8340, kind: 'text' });
  ok('主文案是「剩余」', b.main === '⏱ 剩余 09:41');
  ok('副文案是已用时长', b.sub.includes('8.3s'));
  ok('偏慢时才多一句提示', b.tip.includes('6 秒'));
  ok('正常时不打扰（无 tip）', captchaBadge({ remainingText: '09:00', elapsedMs: 2000 }).tip === '');
  ok('超时态另有文案', captchaBadge({ remainingText: '00:00', elapsedMs: 1, expired: true }).main.includes('已到'));
  ok('滑块也能标出类型', captchaBadge({ remainingText: '09:00', elapsedMs: 1, kind: 'slider' }).label.includes('滑块'));

  // --- 通关总结 ---
  const sum = captchaSummary({ elapsedMs: 8340, attempts: 1, remainingText: '09:20' });
  ok('通关行含用时与剩余', sum.includes('8.3s') && sum.includes('09:20'));
  ok('重试过会写明次数', captchaSummary({ elapsedMs: 9000, attempts: 2 }).includes('共 2 次'));

  // --- 那句实话：扫描没在跑，这几秒就是纯等待 ---
  ok('扫描中 → 告知这几秒不空转', gateAdvice({ monitoring: true, ready: true }).level === 'hit');
  ok('没扫 + 目录没好 → 别催', gateAdvice({ monitoring: false, ready: false }).level === 'wait');
  ok('没扫 + 没开开关 → 指路去开', gateAdvice({ monitoring: false, ready: true, autoStartEnabled: false }).text.includes('自动开扫'));

  // --- 参数：默认关（尊重用户"由我点开始"），且不会被 popup 抹掉 ---
  ok('captchaAutoStart 默认关闭', DEFAULT_SCOUT_PREFS.captchaAutoStart === false);
  ok('normalizePrefs 保留 true', normalizePrefs({ captchaAutoStart: true }).captchaAutoStart === true);
  ok('非布尔值一律当关（不做真值判断）', normalizePrefs({ captchaAutoStart: 'yes' }).captchaAutoStart === false);
  ok('popup 的规整也带着这个字段（否则点任意 chip 就会重置它）',
    /captchaAutoStart/.test(fs.readFileSync(new URL('../popup/popup.js', import.meta.url), 'utf8')));

  // --- 打包产物 + 合规自检 ---
  const bundle = fs.readFileSync(new URL('../content/seat-bundle.js', import.meta.url), 'utf8');
  ok('产物里有完整的关卡逻辑',
    /function captchaAppear/.test(bundle) && /function captchaFinish/.test(bundle)
      && /function captchaWatchStart/.test(bundle) && /function captchaSpecNow/.test(bundle));
  ok('产物里只做 focus，不写值',
    /focus\(\{ preventScroll: true \}\)/.test(bundle)
      && !/captchaInput[^\n]{0,160}\.value\s*=/.test(bundle));
  ok('没有伪造输入事件（InputEvent/KeyboardEvent）', !/new\s+(Input|Keyboard|Composition)Event/.test(bundle));
  ok('没有 OCR / 识别相关代码', !/tesseract|jimp|canvas.*getImageData|recognizeCaptcha/i.test(bundle));
  ok('没有主动请求验证码接口',
    !/fetch\([^)]*captcha/i.test(bundle) && !/getCaptchaImage|solveCaptcha/i.test(bundle));

  const hook = fs.readFileSync(new URL('../content/onestop-hook.js', import.meta.url), 'utf8');
  ok('钩子只是把这两步加进只读旁听表（不新增请求）',
    /'\/onestop\/api\/captcha\/image'/.test(hook) && /'\/onestop\/api\/captcha\/verify'/.test(hook)
      && !/fetch\(\s*['"`]/.test(hook.replace(/const\s+origFetch[\s\S]{0,80}/, '')));
}

head('13. 汇总');
console.log(`  ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
