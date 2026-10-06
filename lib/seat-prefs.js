// NOL Scout — 捡漏参数与「现场任务」构造（v0.5）
//
// 设计意图：取消"先在 popup 里新建监控任务"这一步。
// 用户已经把页面走到了选座页，页面本身就是任务的上下文（商品号/场馆号/场次都能从
// 页面自己的请求里旁听到），所以不再需要手填商品页链接 —— 直接「点一下就开始」。
//
// 本文件只放纯函数，方便 test/verify-har.mjs 直接断言。

export const PREFERENCES = ['any', 'front', 'center', 'left', 'right'];
export const STAGE_SIDES = ['top', 'bottom', 'left', 'right'];

export const PREF_LABEL = {
  any: '不挑位置',
  front: '尽量靠前',
  center: '尽量居中',
  left: '尽量靠左',
  right: '尽量靠右',
};

export const GRADE_FILTER_ALL = '';

// 默认：全部价位、全部区域、1 张、不挑位置。
// 站位票（입장번호）基本都在"全部"里，捡漏场景要的就是"有就行"。
export const DEFAULT_SCOUT_PREFS = {
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
};

// 轮询下限 800ms：捡漏就吃这一口"比别人快半个身位"。
// 官网自身 seatStatus 的最快间隔约 2.6s、中位 4.5s，超过 10 倍频率没意义且更容易被限流，
// 所以下限就停在 800ms；上限 10s 防止手滑填成分钟级而误以为"没在工作"。
export const MIN_INTERVAL_MS = 800;
export const MAX_INTERVAL_MS = 10000;

// 面板/popup 共用的档位，避免两边各写一份
export const INTERVAL_OPTIONS = [800, 1000, 1500, 2000, 2800];

// 低于这个值给一句提醒：不是不让用，而是让你知道自己在踩油门
export const INTERVAL_AGGRESSIVE_MS = 1000;

export const MAX_QUANTITY = 8;

const uniqStr = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((x) => String(x)).filter(Boolean))];

const clampInt = (v, lo, hi, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

/** 把任意（可能来自 storage / 消息 / 表单的）输入规整成合法参数 */
export function normalizePrefs(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    grades: uniqStr(src.grades),
    regions: uniqStr(src.regions),
    quantity: clampInt(src.quantity, 1, MAX_QUANTITY, DEFAULT_SCOUT_PREFS.quantity),
    preference: PREFERENCES.includes(src.preference) ? src.preference : DEFAULT_SCOUT_PREFS.preference,
    stageSide: STAGE_SIDES.includes(src.stageSide) ? src.stageSide : DEFAULT_SCOUT_PREFS.stageSide,
    intervalMs: clampInt(src.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_SCOUT_PREFS.intervalMs),
    captchaAutoStart: src.captchaAutoStart === true,
  };
}

/** 参数是否为「全部价位 / 全部区域」（用于 UI 上给"全部"chip 打勾） */
export function isAllScoped(prefs) {
  const p = normalizePrefs(prefs);
  return p.grades.length === 0 && p.regions.length === 0;
}

/** 把参数压成一行中文摘要，给面板/popup 直接用。
 *  第二个参数既可以直接给 Map<档位号, 档位名>，也可以给 { nameOfGrade: Map }。 */
export function describePrefs(prefs, opts = {}) {
  const p = normalizePrefs(prefs);
  const map = opts && typeof opts.get === 'function' ? opts : (opts?.nameOfGrade || null);
  const grade = p.grades.length
    ? p.grades.map((g) => (map && map.get ? map.get(g) || g : g)).join('/')
    : '全部价位';
  const region = p.regions.length ? p.regions.join('/') : '全部区域';
  return `${grade} · ${region} · ${p.quantity} 张 · ${PREF_LABEL[p.preference] || p.preference}`;
}

/** 现场任务 id：同一个页面（商品+场次）反复点开始，复用同一条任务，不堆垃圾 */
export function adHocTaskId(page = {}) {
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
export function buildAdHocTask(page, prefs) {
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
export function blockGradeKeys(b) {
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
export function resolveScope(prefs, catalog, { exposableOnly = true } = {}) {
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
export function describeScope(scope) {
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
export function labelRuns(runs, limit = 3) {
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
