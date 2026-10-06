// NOL Scout — popup 仪表盘（v0.5：页面即任务 + 候选优先级队列）
//
// 关键变化：不再有「新建监控任务」这一步。
// 用户把 NOL 的选座页打开（走完排队、进了选座界面）之后，popup 顶部会出现
// 「▶ 开始捡漏扫描」—— 参数默认是「全部价位 / 全部区域 / 1 张 / 不挑位置」，
// 点一下就按当前这个页面开始扫。想收窄范围再展开筛选。
//
// 参数存在 chrome.storage.local.scoutPrefs，页面上的浮动面板与这里共用同一份。

const $ = (s) => document.querySelector(s);

const DEFAULTS = { grades: [], regions: [], quantity: 1, preference: 'any', stageSide: 'top', intervalMs: 2800 };
const PREF_LABEL = { any: '不挑位置', front: '尽量靠前', center: '尽量居中', left: '尽量靠左', right: '尽量靠右' };

const stateRef = {
  data: null,
  fetchedAt: 0,
  lastCatalogKey: '',
  prefs: { ...DEFAULTS },
  scopeOpen: false,
  scoutSig: '',
  busy: false,
  settingsDirty: false,
};
const selectedGrades2 = new Set();

init();

async function init() {
  bindUI();
  bindScout();
  await refresh();
  setInterval(refresh, 1000);
  // 倒计时单独走一条 1s 的轻量更新：refresh() 是异步取全局状态，
  // 拿它来刷秒会被网络抖动带偏，直接按 deadline 本地递减更稳。
  setInterval(renderTimer, 1000);
  autoFillFromCurrentTab();
}

// ---------------- 数据 ----------------
async function refresh() {
  try {
    const data = await chrome.runtime.sendMessage({ type: 'get-state' });
    if (data?.error) return;
    stateRef.data = data;
    stateRef.fetchedAt = Date.now();
    // 页面上的浮动面板改了参数也会通过 get-state 反映过来；用户正在点 chips 时不覆盖
    if (!stateRef.busy && data.scoutPrefs) stateRef.prefs = normalizePrefs(data.scoutPrefs);
    render();
  } catch (e) {
    /* SW 重启中，忽略 */
  }
}

function now() {
  if (!stateRef.data) return Date.now();
  return stateRef.data.serverNow + (Date.now() - stateRef.fetchedAt);
}

function parseKst(s) {
  if (!s) return null;
  const iso = s.trim().replace(' ', 'T');
  const t = Date.parse(iso.length === 19 ? iso + '+09:00' : iso);
  return Number.isNaN(t) ? null : t;
}

function normalizePrefs(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const q = Number(src.quantity);
  const iv = Number(src.intervalMs);
  return {
    grades: [...new Set((src.grades || []).map(String).filter(Boolean))],
    regions: [...new Set((src.regions || []).map(String).filter(Boolean))],
    quantity: Number.isFinite(q) ? Math.min(8, Math.max(1, Math.round(q))) : 1,
    preference: PREF_LABEL[src.preference] ? src.preference : 'any',
    stageSide: ['top', 'bottom', 'left', 'right'].includes(src.stageSide) ? src.stageSide : 'top',
    intervalMs: Number.isFinite(iv) ? Math.min(10000, Math.max(800, Math.round(iv))) : 2800,
    // 这个开关只在页面面板里真正生效，但 popup 保存参数时必须原样带回去，
    // 否则用户在 popup 里点任意一个 chip 都会把它悄悄重置成关闭。
    captchaAutoStart: src.captchaAutoStart === true,
    captchaAutoSolve: src.captchaAutoSolve === true,
    autoLock: src.autoLock === true,
  };
}

// ---------------- UI 绑定 ----------------
function bindUI() {
  $('#formToggle').onclick = () => {
    $('#form').classList.toggle('hidden');
    $('#formCaret').textContent = $('#form').classList.contains('hidden') ? '▸' : '▾';
  };
  $('#logToggle').onclick = () => toggle('#logView', '#logCaret');
  $('#setToggle').onclick = () => toggle('#settings', '#setCaret');
  $('#hitToggle').onclick = () => toggle('#hitView', '#hitCaret');

  $('#fLoad2').onclick = () => loadProduct('#fUrl2', '#fInfo2', '#fGrades2', selectedGrades2);
  $('#fCreate').onclick = createPageTask;
  $('#sTest').onclick = async (e) => {
    e.preventDefault();
    await chrome.runtime.sendMessage({ type: 'test-sound', options: { soundStyle: $('#sSoundStyle').value, soundVolume: Number($('#sSoundVolume').value) } });
  };
  $('#sStopSound').onclick = () => chrome.runtime.sendMessage({ type: 'stop-sound' });
  $('#sSave').onclick = saveSettings;
  $('#settings').addEventListener('change', () => { stateRef.settingsDirty = true; });
}

function toggle(panelSel, caretSel) {
  $(panelSel).classList.toggle('hidden');
  $(caretSel).textContent = $(panelSel).classList.contains('hidden') ? '▸' : '▾';
}

async function autoFillFromCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    if (tab.url.includes('world.nol.com')) {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PRODUCT' }).catch(() => null);
      $('#fUrl2').value = res?.product?.url || tab.url;
    }
  } catch (e) { /* ignore */ }
}

// ---------------- 捡漏扫描面板 ----------------

function bindScout() {
  const box = $('#scoutBox');
  // 事件委托：面板每次重绘都不需要重新绑定（chips 是动态生成的）
  box.addEventListener('click', async (ev) => {
    const chip = ev.target.closest('[data-k]');
    if (chip) return onChip(chip);
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'scan') return startScan();
    if (btn.dataset.act === 'stop') return stopScan();
    if (btn.dataset.act === 'scope') { stateRef.scopeOpen = !stateRef.scopeOpen; renderScout(true); }
  });
}

function onChip(chip) {
  const key = chip.dataset.k;
  const val = chip.dataset.v;
  const p = { ...stateRef.prefs };
  if (key === 'grade') {
    const set = new Set(p.grades);
    if (!val) set.clear();
    else if (set.has(val)) set.delete(val);
    else set.add(val);
    p.grades = [...set];
  } else if (key === 'region') {
    const set = new Set(p.regions);
    if (!val) set.clear();
    else if (set.has(val)) set.delete(val);
    else set.add(val);
    p.regions = [...set];
  } else if (key === 'qty') p.quantity = Number(val);
  else if (key === 'pref') p.preference = val;
  else if (key === 'iv') p.intervalMs = Number(val);
  else if (key === 'gate') p.captchaAutoStart = !p.captchaAutoStart;

  stateRef.prefs = normalizePrefs(p);
  stateRef.busy = true;
  chrome.storage.local.set({ scoutPrefs: stateRef.prefs })
    .catch(() => {})
    .finally(() => { setTimeout(() => { stateRef.busy = false; }, 350); });
  renderScout(true);
}

async function startScan() {
  const box = $('#scoutBox');
  const btn = box.querySelector('button[data-act="scan"]');
  if (btn) { btn.disabled = true; btn.textContent = '正在启动…'; }
  // 先把参数落盘：页面脚本会优先用 storage 里的这份
  await chrome.storage.local.set({ scoutPrefs: stateRef.prefs }).catch(() => {});
  const res = await chrome.runtime.sendMessage({ type: 'start-adhoc-scan', prefs: stateRef.prefs }).catch((e) => ({ error: e.message }));
  if (res?.error || res?.ok === false) {
    alert('无法开始扫描：' + (res.error || '未知错误'));
  }
  stateRef.scoutSig = '';
  await refresh();
}

async function stopScan() {
  await chrome.runtime.sendMessage({ type: 'stop-adhoc-scan' }).catch(() => {});
  stateRef.scoutSig = '';
  await refresh();
}

function renderScout(force = false) {
  const d = stateRef.data;
  if (!d) return;
  const s = d.seatState || {};
  const cat = s.catalog;
  const p = stateRef.prefs;
  const monitoring = !!s.monitoring;

  const badge = $('#scoutBadge');
  badge.className = 'badge ' + (monitoring ? 'run' : s.hasSession ? 'mode' : 'stop');
  badge.textContent = monitoring ? '扫描中' : s.hasSession ? (s.pageReady ? '可开始' : '识别中') : '未检测到选座页';

  const sig = JSON.stringify([s.hasSession, s.pageReady, monitoring, s.goodsCode, s.playSeq,
    cat?.builtAt, cat?.regions?.length, p, stateRef.scopeOpen]);
  if (!force && sig === stateRef.scoutSig) return;
  stateRef.scoutSig = sig;

  const box = $('#scoutBox');
  if (!s.hasSession) {
    box.innerHTML = s.href
      ? `<div class="hint">已检测到 NOL 选座页，正在捕获排队会话与座位目录…<br/>若一直停在这里，请刷新一次选座页。</div>
         <div class="line"><span>当前</span><span class="muted">会话未捕获</span></div>`
      : `<div class="hint">在 NOL World 走完排队、进入选座界面后，这里会出现「开始捡漏扫描」。</div>
         <div class="line"><span>当前</span><span class="muted">未检测到 NOL 选座页</span></div>`;
    return;
  }

  const gradeChips = cat
    ? [`<span class="chip-opt ${p.grades.length ? '' : 'on'}" data-k="grade" data-v="">全部价位</span>`]
        .concat((cat.grades || []).map((g) => `<span class="chip-opt ${p.grades.includes(String(g.grade)) ? 'on' : ''}" data-k="grade" data-v="${esc(g.grade)}">${esc(g.name)}${g.price ? ` ¥${krw2cny(g.price)}` : ''}</span>`))
        .join('')
    : '<span class="muted">座位目录构建中…</span>';

  const regionChips = cat
    ? [`<span class="chip-opt ${p.regions.length ? '' : 'on'}" data-k="region" data-v="">全部区域</span>`]
        .concat((cat.regions || []).map((r) => `<span class="chip-opt ${p.regions.includes(r.name) ? 'on' : ''}" data-k="region" data-v="${esc(r.name)}">${esc(r.name)}·${(r.blockKeys || []).length}块·${r.seatCount}</span>`))
        .join('')
    : '';

  // 实时选区：点任何一个区域/价位 chip，这里立刻给出"选中了哪些区块"，
  // 口径与页面面板、与真正下发任务时完全一致（都按档位号配对）。
  const sc = cat ? computeScope(p, cat) : null;

  const scopeBody = `
    <div class="scope-label">价位（不点＝全部）</div>
    <div class="chips">${gradeChips}</div>
    <div class="scope-label">区域（不点＝全部）</div>
    <div class="chips">${regionChips}</div>
    ${sc ? `<div class="scope-live ${sc.narrow ? 'on' : ''}">${scopeLine(sc)}</div>` : ''}
    <div class="scope-label">需要张数</div>
    <div class="chips">${[1, 2, 3, 4].map((n) => `<span class="chip-opt ${p.quantity === n ? 'on' : ''}" data-k="qty" data-v="${n}">${n} 张</span>`).join('')}</div>
    <div class="scope-label">位置偏好</div>
    <div class="chips">${Object.keys(PREF_LABEL).map((k) => `<span class="chip-opt ${p.preference === k ? 'on' : ''}" data-k="pref" data-v="${k}">${PREF_LABEL[k]}</span>`).join('')}</div>
    <div class="scope-label">轮询间隔</div>
    <div class="chips">${INTERVAL_OPTIONS.map((n) => `<span class="chip-opt ${p.intervalMs === n ? 'on' : ''}" data-k="iv" data-v="${n}">${n}ms</span>`).join('')}</div>
    <div class="scope-label">验证码关卡</div>
    <div class="chips"><span class="chip-opt ${p.captchaAutoStart ? 'on' : ''}" data-k="gate" data-v="1" title="打开后：检测到验证码关卡且座位目录就绪时自动开扫，让输入验证码的那几秒不空转。默认关闭。">验证码期自动开扫：${p.captchaAutoStart ? '开' : '关'}</span></div>`;

  box.innerHTML = `
    <div class="timer-box" id="tmrBox">
      <b class="tmr" id="tmr">--:--</b>
      <div class="tmr-cap"><span id="tmrCap">选座剩余时间</span><span class="muted" id="tmrSub">等页面产生会话后自动计时</span></div>
    </div>
    <div class="line"><span>场次 / 商品</span><span>${esc(s.playSeq || '—')} · ${esc(s.goodsCode || '—')}</span></div>
    <div class="line"><span>座位目录</span><span>${cat ? `${cat.blocks.length} 区块 · ${cat.regions.length} 区域 · ${cat.grades.length} 价位` : '构建中…'}</span></div>
    <div class="line"><span>本页轮询 / 命中</span><span>${s.scans || 0} / <b>${s.hits || 0}</b></span></div>
    <div class="line"><span>扫描范围</span><span class="range-line">${esc(describePrefs(p, cat))}</span></div>
    <button class="btn big ${monitoring ? 'stop' : 'go'}" data-act="${monitoring ? 'stop' : 'scan'}"
      ${!monitoring && !s.pageReady ? 'disabled' : ''}>
      ${monitoring ? '■ 停止扫描' : s.pageReady ? '▶ 开始捡漏扫描' : '正在识别选座页…'}</button>
    <div class="hint">扫描会在选座 10 分钟用完时自动停止；到点会弹通知。</div>
    <button class="btn tiny" data-act="scope" style="align-self:flex-start">${stateRef.scopeOpen ? '▾ 收起筛选' : '▸ 调整范围'}</button>
    <div class="${stateRef.scopeOpen ? '' : 'hidden'}">${scopeBody}</div>`;

  renderTimer();
}

// 轮询下限 800ms；上限档位与页面面板共用同一套（popup 是普通脚本，不能 import）
const INTERVAL_OPTIONS = [800, 1000, 1500, 2000, 2800];

/** 倒计时每秒只改自己的文本，不重建面板 */
function renderTimer() {
  const t = stateRef.data?.seatState?.timer;
  const el = $('#tmr');
  if (!el) return;
  const cap = $('#tmrCap');
  const sub = $('#tmrSub');
  if (!t?.active) {
    el.textContent = '--:--';
    el.className = 'tmr off';
    if (cap) cap.textContent = '选座剩余时间';
    if (sub) sub.textContent = '等页面产生会话后自动计时';
    return;
  }
  const now = Date.now() + (t.skewMs || 0);
  const rem = t.deadlineMs - now;
  const dead = t.state === 'dead' || (rem <= 0 && t.serverExpired === true);
  const grace = !dead && rem <= 0;
  const phase = dead ? 'danger' : rem <= 60000 ? 'danger' : rem <= 300000 ? 'warn' : 'ok';
  el.textContent = formatCountdown(grace ? 0 : rem);
  el.className = 'tmr ' + (grace ? 'grace' : phase);
  if (cap) cap.textContent = dead ? '选座时间已结束' : grace ? '选座时间（宽限中）' : '选座剩余时间';
  if (sub) {
    sub.textContent = dead
      ? (t.reason === 'server' ? '服务端判定会话过期' : '时限已到，扫描已自动停止')
      : grace ? '服务端还没判超时，宽限中'
        : (t.confidence === 'exact' ? '计时锚定会话令牌' : '起点为首次观测');
  }
}

function formatCountdown(ms) {
  if (!Number.isFinite(ms)) return '--:--';
  const t = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(t / 60), s = t % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function krw2cny(krw) { return Math.round(Number(krw || 0) * 0.00496); }

// 与页面面板 lib/seat-prefs.js 的 resolveScope 同口径（popup 是普通脚本，不能 import，
// 所以这里保留一份等价实现）。要点：区块与选中档位的配对必须用「档位号」，
// gradeCounts 的键是档位名，拿号码去比会永远不命中。
function computeScope(p, cat) {
  const regions = new Set(p.regions || []);
  const grades = new Set((p.grades || []).map(String));
  const narrow = regions.size > 0 || grades.size > 0;
  const blocks = (cat?.blocks || []).filter((b) => (b.exposableCount ?? 0) > 0);
  const inKeys = new Set();
  const byRegion = new Map();
  let seats = 0;
  for (const b of blocks) {
    if (regions.size && !regions.has(b.region)) continue;
    const keys = (b.gradeNos || []).length ? b.gradeNos.map(String) : Object.keys(b.gradeCounts || {});
    if (grades.size && !keys.some((g) => grades.has(g))) continue;
    inKeys.add(b.key);
    seats += b.exposableCount || 0;
    byRegion.set(b.region, (byRegion.get(b.region) || 0) + 1);
  }
  return { narrow, total: blocks.length, selected: inKeys.size, seats, inKeys, byRegion };
}

function scopeLine(s) {
  if (!s.narrow) return `□ 全部 ${s.total} 区块 · ${s.seats.toLocaleString()} 座`;
  const detail = [...s.byRegion.entries()].sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n} ${c}块`).join(' · ');
  return `▣ 已选 ${s.selected} / ${s.total} 区块 · ${s.seats.toLocaleString()} 座`
    + (detail ? `（${detail}）` : '（当前条件下没有匹配的区块）');
}

function describePrefs(p, cat) {
  const nameOf = new Map((cat?.grades || []).map((g) => [String(g.grade), g.name]));
  const g = p.grades.length ? p.grades.map((x) => nameOf.get(x) || x).join('/') : '全部价位';
  const r = p.regions.length ? p.regions.join('/') : '全部区域';
  return `${g} · ${r} · ${p.quantity} 张 · ${PREF_LABEL[p.preference] || p.preference}`;
}

// ---------------- 商品页模式（兜底，非座位级） ----------------
async function loadProduct(urlSel, infoSel, gradesSel, gradeSet) {
  const url = $(urlSel).value.trim();
  const info = $(infoSel);
  if (!url) return;
  info.classList.remove('hidden');
  info.textContent = '解析中…';
  const res = await chrome.runtime.sendMessage({ type: 'parse-url', url });
  if (res?.error) {
    info.innerHTML = `<span style="color:var(--err)">解析失败：${esc(res.error)}</span>`;
    return;
  }
  const p = res.product;
  info.innerHTML = `
    <b>${esc(p.name)}</b><br/>
    <span class="muted">${esc(p.placeName || '')} · ${esc(p.startDate || '')} ~ ${esc(p.endDate || '')}</span><br/>
    <span class="muted">开售：${esc(p.bookingOpenTime || '—')} KST · 档位：${p.prices.map((x) => esc(x.grade)).join(' / ') || '—'}</span>`;

  const wrap = $(gradesSel);
  wrap.innerHTML = '';
  gradeSet.clear();
  if (!p.prices.length) {
    wrap.innerHTML = '<span class="muted">未解析到票价档位</span>';
    return;
  }
  p.prices.forEach((x) => {
    const chip = document.createElement('span');
    chip.className = 'chip-opt on';
    chip.textContent = `${x.grade} ¥${krw2cny(x.price)}`;
    chip.onclick = () => {
      if (gradeSet.has(x.grade)) { gradeSet.delete(x.grade); chip.classList.remove('on'); }
      else { gradeSet.add(x.grade); chip.classList.add('on'); }
    };
    gradeSet.add(x.grade);
    wrap.appendChild(chip);
  });
}

async function createPageTask() {
  const mode = $('#fMode').value;
  const payload = mode === 'onSale'
    ? {
        mode, url: $('#fUrl2').value.trim(),
        channels: Number($('#fChannels').value) || 1,
        intervalMs: Number($('#fInterval2').value) || 1500,
        quantity: 1,
      }
    : {
        mode: 'returns', url: $('#fUrl2').value.trim(),
        channels: Number($('#fChannels').value) || 2,
        intervalMs: Number($('#fInterval2').value) || 800,
        grades: [...selectedGrades2], quantity: 1,
      };
  const res = await chrome.runtime.sendMessage({ type: 'create-task', task: payload });
  if (res?.error) return alert('创建失败：' + res.error);
  $('#fInfo2').classList.add('hidden');
  await refresh();
}

async function saveSettings() {
  const { scoutPrefs = {} } = await chrome.storage.local.get('scoutPrefs');
  const prefs = normalizePrefs({ ...scoutPrefs, captchaAutoSolve: $('#sAutoCaptcha').checked, autoLock: $('#sAutoLock').checked });
  stateRef.busy = true;
  try {
    await chrome.storage.local.set({ scoutPrefs: prefs });
    stateRef.prefs = prefs;
  } finally { stateRef.busy = false; };
  const res = await chrome.runtime.sendMessage({
    type: 'update-settings',
    settings: {
      notify: $('#sNotify').checked,
      sound: $('#sSound').checked,
      soundStyle: $('#sSoundStyle').value,
      soundVolume: Math.max(0, Math.min(100, Number($('#sSoundVolume').value) || 0)),
      autoOpenTab: $('#sAutoOpen').checked,
      autoEnsureSeatTab: $('#sAutoSeatTab').checked,
      minIntervalMs: Number($('#sMinInterval').value) || 600,
    },
  });
  if (res?.ok) {
    stateRef.settingsDirty = false;
    $('#sSave').textContent = '已保存 ✓';
    setTimeout(() => ($('#sSave').textContent = '保存设置'), 1200);
  }
}

// ---------------- 渲染 ----------------
function render() {
  const d = stateRef.data;
  if (!d) return;

  const chip = $('#timeChip');
  const off = d.time?.offsetMs ?? 0;
  chip.textContent = `校时偏差 ${off >= 0 ? '+' : ''}${off}ms · RTT ${d.time?.rttMs ?? '-'}ms`;
  chip.classList.toggle('bad', Math.abs(off) > 3000);

  renderScout();
  renderSeatStatus(d);
  applyCatalogToChips(d.lastCatalog);

  $('#taskCount').textContent = `${d.tasks.length} 个任务`;
  renderTasks(d);
  renderHits(d);
  renderLogs(d.logs || []);
  fillSettings(d.settings);
}

function renderSeatStatus(d) {
  const s = d.seatState || {};
  const box = $('#seatStatus');
  $('#seatHint').textContent = s.hasSession ? (s.monitoring ? '扫描中' : '已连接') : '未连接';
  if (!s.href) {
    box.innerHTML = '<div class="kv"><span>状态</span><span class="muted">未检测到座位页</span></div>' +
      '<div class="hint">在 NOL 走完排队进入选座页后，这里会自动显示会话与目录信息。</div>';
    return;
  }

  const cat = s.catalog;
  const lr = s.lastResult;
  box.innerHTML = `
    <div class="kv"><span>会话</span><span>${s.hasSession ? esc(s.session) : '<span class="muted">未捕获</span>'}</span></div>
    <div class="kv"><span>余票数据</span><span>${s.statusBlocks || 0} 个区块</span></div>
    ${cat ? `<div class="kv"><span>目录</span><span>${cat.blocks.length} 区块 · ${cat.regions.length} 区域 · ${cat.grades.length} 价位</span></div>` : '<div class="kv"><span>目录</span><span class="muted">构建中…</span></div>'}
    ${lr ? `<div class="kv"><span>当前余票</span><span class="${lr.freeSeats ? 'ok' : 'muted'}">${lr.freeSeats} 座 · ${lr.blocksWithFree} 区块</span></div>` : ''}
    ${lr?.best ? `<div class="kv"><span>首选座位</span><span class="ok">${esc(lr.best.summary || '')}</span></div>` : ''}
    ${(() => {
      const sc = s.seatCanvas;
      if (!sc) return '<div class="kv"><span>页面定位</span><span class="muted">待标定</span></div>';
      const names = { exact: '精确', rough: '粗略', bad: '不可用', assumed: '推定' };
      const okk = sc.mode === 'exact' ? 'ok' : sc.mode === 'bad' ? 'warn' : 'muted';
      return `<div class="kv"><span>页面定位</span><span class="${okk}">${names[sc.mode] || sc.mode}`
        + (sc.pageSeats != null ? ` · 页面座位 ${sc.pageSeats}` : '')
        + (sc.matched != null ? ` · 命中匹配 ${sc.matched}` : '')
        + `</span></div>`;
    })()}`;
}

function fillSettings(s) {
  if (!s || stateRef.settingsDirty) return;
  $('#sNotify').checked = !!s.notify;
  $('#sSound').checked = !!s.sound;
  $('#sSoundStyle').value = s.soundStyle === 'classic' ? 'classic' : 'alarm';
  $('#sSoundVolume').value = s.soundVolume ?? 80;
  $('#sAutoOpen').checked = !!s.autoOpenTab;
  $('#sAutoSeatTab').checked = !!s.autoEnsureSeatTab;
  $('#sMinInterval').value = s.minIntervalMs;
  $('#sAutoCaptcha').checked = !!stateRef.prefs.captchaAutoSolve;
  $('#sAutoLock').checked = !!stateRef.prefs.autoLock;
}

function applyCatalogToChips(catalog) {
  if (!catalog) return;
  const key = JSON.stringify([catalog.builtAt, catalog.grades?.length]);
  if (stateRef.lastCatalogKey === key) return;
  stateRef.lastCatalogKey = key;

  const gw2 = $('#fGrades2');
  gw2.innerHTML = '';
  selectedGrades2.clear();
  (catalog.grades || []).forEach((g) => {
    const chip = document.createElement('span');
    chip.className = 'chip-opt on';
    chip.textContent = `${g.name}`;
    chip.onclick = () => {
      if (selectedGrades2.has(g.name)) { selectedGrades2.delete(g.name); chip.classList.remove('on'); }
      else { selectedGrades2.add(g.name); chip.classList.add('on'); }
    };
    selectedGrades2.add(g.name);
    gw2.appendChild(chip);
  });
  if (!(catalog.grades || []).length) gw2.innerHTML = '<span class="muted">目录里没有价位信息</span>';
}

const MODE_LABEL = { seat: '座位级', onSale: '开售', returns: '商品页' };

function renderTasks(d) {
  const list = $('#taskList');
  list.innerHTML = '';
  if (!d.tasks.length) {
    list.innerHTML = '<div class="muted" style="padding:0 0 4px">暂无任务。打开 NOL 选座页点「开始捡漏扫描」即可。</div>';
    return;
  }
  const statsMap = new Map(d.stats);
  const logsByTask = {};
  (d.logs || []).forEach((l) => {
    if (!l.taskId) return;
    (logsByTask[l.taskId] ||= []).push(l);
  });

  d.tasks.forEach((task) => {
    const s = statsMap.get(task.id) || {};
    const card = document.createElement('div');
    card.className = 'task';
    const running = task.status === 'running';

    let countdown = '';
    if (task.mode === 'onSale') {
      const open = task.openAt ? parseKst(task.openAt) : null;
      if (open && now() < open) countdown = `<div class="countdown">距开售 ${fmtDur(open - now())}</div>`;
    }
    const lastLog = (logsByTask[task.id] || []).slice(-1)[0];
    // 座位级任务的扫描/命中计数由座位页内容脚本实时上报
    const live = task.mode === 'seat' && d.seatState?.monitoring ? d.seatState : null;

    let scope = '';
    if (task.mode === 'seat') {
      const nameOf = new Map((d.lastCatalog?.grades || []).map((g) => [String(g.grade), g.name]));
      const g = (task.grades || []).map((x) => nameOf.get(String(x)) || x).join('/') || '全部价位';
      const r = (task.regions || []).length ? (task.regions || []).join('/') : '全部区域';
      scope = `<div class="stat-row"><span>${esc(g)}</span><span>${esc(r)}</span><span>${task.quantity} 张</span><span>${PREF_LABEL[task.preference] || '不挑位置'}</span></div>`;
    }

    card.innerHTML = `
      <div class="task-head">
        <div class="task-name" title="${esc(task.url || '')}">${esc(task.name)}${task.adHoc ? ' <span class="muted">· 现场</span>' : ''}</div>
        <div class="badges">
          <span class="badge mode">${MODE_LABEL[task.mode] || task.mode}</span>
          <span class="badge ${running ? 'run' : 'stop'}">${running ? '扫描中' : '已停止'}</span>
        </div>
      </div>
      ${countdown}
      ${scope}
      <div class="stat-row">
        <span>扫描 <b>${live ? (live.scans ?? 0) : (s.scans || 0)}</b></span>
        <span>命中 <b>${live ? (live.hits ?? 0) : (s.hits || 0)}</b></span>
        ${task.mode === 'seat'
          ? `<span>间隔 <b>${task.intervalMs}ms</b></span>`
          : `<span>延迟 <b>${s.avgLatency ?? '-'}ms</b></span><span>通道 <b>${task.channels}</b></span>`}
      </div>
      ${live?.lastResult ? `<div class="stat-row"><span>当前余票：<b>${live.lastResult.freeSeats} 座</b> · ${live.lastResult.blocksWithFree} 区块${live.lastResult.best ? ' · ' + esc(live.lastResult.best.summary) : ''}</span></div>` : ''}
      ${lastLog ? `<div class="stat-row"><span>最近：${esc(lastLog.msg)}</span></div>` : ''}
      <div class="task-actions">
        <button class="btn ${running ? '' : 'primary'}" data-act="${running ? 'stop' : 'start'}">${running ? '停止' : '启动'}</button>
        <button class="btn danger" data-act="delete">删除</button>
      </div>`;

    card.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.onclick = async () => {
        await chrome.runtime.sendMessage({ type: btn.dataset.act + '-task', id: task.id });
        stateRef.scoutSig = '';
        await refresh();
      };
    });
    list.appendChild(card);
  });
}

// 候选优先级队列：沿用命中时 matchSnapshot 的排序（按位置偏好打分，越小越好）
function labelRuns(runs, limit = 3) {
  return (Array.isArray(runs) ? runs : [])
    .filter((r) => r && r.len)
    .slice()
    .sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity) || (b.len || 0) - (a.len || 0))
    .slice(0, limit)
    .map((run, i) => ({ rank: i + 1, label: i === 0 ? '首选' : `备份${i}`, run }));
}

function renderHits(d) {
  const hits = d.hits || [];
  $('#hitCount').textContent = hits.length ? `${hits.length} 条` : '';
  const view = $('#hitView');
  if (!hits.length) {
    view.innerHTML = '<div class="muted">暂无命中。命中后会在这里留下记录（含区域/排/座号/价位 + 候选优先级）。</div>';
    return;
  }
  view.innerHTML = hits.slice(0, 20).map((h, hi) => {
    const det = h.detail || {};
    const queue = labelRuns(det.runs || [], 3).map(({ rank, label, run }) => {
      const nos = (run.seatNos || []).slice(0, 8).join('/') + ((run.seatNos || []).length > 8 ? '…' : '');
      return `<div class="qitem ${rank === 1 ? 'top' : ''}">
        <span class="qrank">${label}</span>
        <div class="qmain">
          <div class="qt">${esc(run.region || run.blockKey)} · ${esc(run.rowLabel || '')} · ${esc(nos)}</div>
          <div class="sub">${run.len || 0} 连座${(run.gradeNames || []).length ? ' · ' + esc(run.gradeNames.join('/')) : ''}${run.price ? ' · ₩' + Number(run.price).toLocaleString() + ' / ¥' + krw2cny(run.price) : ''}</div>
        </div>
        <button class="btn tiny" data-locate="1" data-hit="${hi}" data-rank="${rank}">定位</button>
        <button class="btn tiny" data-copy="${esc(JSON.stringify(run.seatIds || []))}">复制</button>
      </div>`;
    }).join('');
    return `<div class="hit-card">
      <div class="hit-time">${new Date(h.t).toLocaleTimeString('zh-CN', { hour12: false })} · ${esc(h.taskName || '')}</div>
      <div class="hit-msg">${esc(h.message)}</div>
      ${queue ? `<div class="queue">${queue}</div>` : ''}
    </div>`;
  }).join('');

  view.querySelectorAll('button[data-copy]').forEach((b) => {
    b.onclick = () => {
      const ids = JSON.parse(b.dataset.copy || '[]');
      navigator.clipboard?.writeText(ids.join('\n'));
    };
  });
  view.querySelectorAll('button[data-locate]').forEach((b) => {
    b.onclick = () => chrome.runtime.sendMessage({ type: 'locate-best' });
  });
}

function renderLogs(logs) {
  const view = $('#logView');
  view.innerHTML = logs
    .slice(-60)
    .reverse()
    .map((l) => {
      const time = new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false });
      return `<div class="log-line"><span class="log-t">${time}</span><span class="log-${l.level}">${esc(l.msg)}</span></div>`;
    })
    .join('');
}

// ---------------- 工具 ----------------
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}天 ${h}时 ${m}分`;
  if (h) return `${h}时 ${m}分 ${sec}秒`;
  if (m) return `${m}分 ${sec}秒`;
  return `${sec}秒`;
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
