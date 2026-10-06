// NOL Scout — 后台调度核心（v0.4）
// 两类监控任务：
//   mode='seat'   座位级回流票监控：由 tickets.interpark.com/onestop/seat 页面的内容脚本执行，
//                 本文件负责"确保座位页在线 → 下发任务 → 接收命中 → 提醒/记录"。
//   mode='onSale' 开售倒计时监控：轮询商品页，到点提醒。
//   mode='returns' 商品页产品级（粗粒度）回流监控：作为没有座位页会话时的兜底。
// 本地 OCR 通过 offscreen 工作线程运行；锁票由选座页执行。

import { parseProduct, parseKst } from '../lib/parser.js';
import { syncTime, ensureTimeSynced, serverNow, timeSyncInfo } from '../lib/time-sync.js';

const DEFAULT_SETTINGS = {
  notify: true,
  sound: true,
  autoOpenTab: true,
  autoEnsureSeatTab: true, // 启动座位任务时自动把 onestop 页面拉起来
  minIntervalMs: 600,
  maxChannels: 4,
};

const tasks = new Map();
const loops = new Map();
const heartbeats = new Map();
const stats = new Map();
const fingerprints = new Map();
const lastHitAt = new Map();
let logs = [];
let settings = { ...DEFAULT_SETTINGS };
let seatState = {};       // 来自内容脚本的最新座位页状态
let hits = [];            // 最近命中记录

bootstrap();

async function bootstrap() {
  const { tasks: saved = [], settings: s = {}, hits: savedHits = [] } = await chrome.storage.local.get(['tasks', 'settings', 'hits']);
  settings = { ...DEFAULT_SETTINGS, ...s };
  hits = savedHits;
  saved.forEach((t) => tasks.set(t.id, t));
  for (const task of tasks.values()) {
    // 「现场任务」（adHoc）依存于当时那个活着的选座页；浏览器重启后页面早就没了，
    // 不该被自动拉起（否则会莫名其妙打开商品页），直接置为已停止。
    if (task.adHoc) { task.status = 'stopped'; continue; }
    if (task.status === 'running') startTask(task.id, true);
  }
  await persistTasks();
  syncTime().catch(() => {});
  pushLog(null, 'info', 'NOL Scout 后台已启动（v0.5 页面即任务 + 候选优先级队列）');
  await mirrorRuntime();
  await refreshBadge();
}

// ---------------- 任务生命周期 ----------------

export function startTask(id, silent = false) {
  const task = tasks.get(id);
  if (!task) return;
  if (task.mode === 'seat') return startSeatTask(task, silent);
  if (loops.has(id)) return;
  const channels = Math.min(task.channels || 1, settings.maxChannels);
  const ctrls = [];
  for (let i = 0; i < channels; i++) {
    const ctrl = new AbortController();
    ctrls.push(ctrl);
    channelLoop(task, i, ctrl).catch((e) => pushLog(id, 'error', `通道${i + 1}异常退出: ${e.message}`));
  }
  loops.set(id, ctrls);
  task.status = 'running';
  persistTasks();
  if (!silent) pushLog(id, 'info', `启动监控（${channels} 通道 / ${task.intervalMs}ms）`);
}

export async function startSeatTask(task, silent = false) {
  task.status = 'running';
  await persistTasks();
  await chrome.storage.local.set({ seatTask: publicTask(task), autoStartTask: resumeToken(task) });
  const tab = await findSeatTab(task);
  if (!tab) {
    // 现场任务是"页面即任务"，页面不在就无从扫起，绝不去替用户开页面
    if (task.adHoc) {
      task.status = 'stopped';
      await persistTasks();
      if (!silent) pushLog(task.id, 'warn', '「捡漏扫描」跟随当前选座页 —— 请先打开 NOL 选座页并进入选座界面，再点开始');
      return;
    }
    if (settings.autoEnsureSeatTab) {
      pushLog(task.id, 'warn', '未找到已打开的座位页，正在打开入场链接（需你手动完成排队/验证）');
      await chrome.tabs.create({ url: task.entryUrl || productUrl(task), active: true }).catch(() => {});
      if (!silent) pushLog(task.id, 'info', '进入座位页后会自动开始监控');
    } else if (!silent) {
      pushLog(task.id, 'warn', '请先打开 NOL 座位页（tickets.interpark.com/onestop/seat）');
    }
    return;
  }
  // 现场任务重新下发时走"按当前页现算"的入口，否则会把用户后来改过的范围覆盖回去
  if (task.adHoc) await chrome.tabs.sendMessage(tab.id, { type: 'START_ADHOC_SCAN' }).catch(() => {});
  else await pushTaskToTab(tab.id, task);
  if (!silent) pushLog(task.id, 'info', `已向座位页下发监控（${task.intervalMs}ms / ${task.grades?.join('/') || '全部价位'}）`);
}

export async function stopTask(id) {
  const task = tasks.get(id);
  if (task?.mode === 'seat') {
    const tab = await findSeatTab(task);
    if (tab) await chrome.tabs.sendMessage(tab.id, { type: 'STOP_SEAT_MONITOR' }).catch(() => {});
    if (task) { task.status = 'stopped'; await persistTasks(); }
    pushLog(id, 'info', '监控已停止');
    return;
  }
  (loops.get(id) || []).forEach((c) => c.abort());
  loops.delete(id);
  const t = tasks.get(id);
  if (t) { t.status = 'stopped'; persistTasks(); }
  pushLog(id, 'info', '监控已停止');
}

export function deleteTask(id) {
  stopTask(id);
  const t = tasks.get(id);
  tasks.delete(id);
  stats.delete(id);
  fingerprints.delete(id);
  if (t?.adHoc) chrome.storage.local.remove('autoStartTask').catch(() => {});
  persistTasks();
  mirrorRuntime();
  refreshBadge();
  pushLog(id, 'info', '任务已删除');
}

// ---------------- 座位页协作 ----------------

function productUrl(task) {
  return `https://world.nol.com/ticket/places/${task.placeCode}/products/${task.goodsCode}`;
}

function publicTask(task) {
  return {
    id: task.id,
    name: task.name,
    goodsCode: task.goodsCode,
    placeCode: task.placeCode,
    bizCode: task.bizCode,
    playSeqs: task.playSeqs || [],
    grades: task.grades || [],
    regions: task.regions || [],
    quantity: task.quantity || 1,
    preference: task.preference || 'any',
    stageSide: task.stageSide || 'top',
    intervalMs: task.intervalMs || 2800,
    cooldownMs: task.cooldownMs || 20000,
  };
}

// 座位页刷新后要能自己续扫，所以存给页面的令牌必须带 mode/adHoc/url
// （publicTask 是给 popup 显示用的，字段更少）
function resumeToken(task) {
  return {
    ...publicTask(task), mode: 'seat', adHoc: !!task.adHoc, status: 'running',
    createdAt: task.createdAt || Date.now(),
    url: task.url || productUrl(task),
    entryUrl: task.entryUrl || null,
  };
}

async function findSeatTab(task) {
  const tabs = await chrome.tabs.query({ url: 'https://tickets.interpark.com/onestop*' });
  if (!tabs.length) return null;
  if (!task) return tabs[0];
  const alive = [];
  for (const t of tabs) {
    const st = await chrome.tabs.sendMessage(t.id, { type: 'GET_SEAT_STATE' }).catch(() => null);
    if (st?.ok && st.hasSession) alive.push({ tab: t, st });
  }
  const pool = alive.length ? alive : tabs.map((t) => ({ tab: t, st: null }));
  const match = pool.find((p) => p.st?.goodsCode === task.goodsCode) || pool[0];
  return match?.tab || null;
}

async function pushTaskToTab(tabId, task) {
  const res = await chrome.tabs.sendMessage(tabId, { type: 'START_SEAT_MONITOR', task: publicTask(task) }).catch((e) => ({ error: e.message }));
  if (res?.error) pushLog(task.id, 'error', '下发失败：' + res.error);
  else {
    pushLog(task.id, 'info', `座位页已接管：目标 ${res.blocks} 个区块`);
    // 记录目录摘要供 popup 展示
    if (res.catalog) await chrome.storage.local.set({ lastCatalog: res.catalog });
  }
  return res;
}

// 座位页可达时自动接管正在运行的任务
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!info.status || info.status !== 'complete') return;
  if (!/tickets\.interpark\.com\/onestop/.test(tab.url || '')) return;
  const running = [...tasks.values()].filter((t) => t.mode === 'seat' && t.status === 'running');
  if (!running.length) return;
  for (let i = 0; i < 20; i++) {
    const st = await chrome.tabs.sendMessage(tabId, { type: 'GET_SEAT_STATE' }).catch(() => null);
    if (st?.ok && st.hasSession) {
      const task = running.find((t) => t.goodsCode === st.goodsCode) || running[0];
      if (task.adHoc) await chrome.tabs.sendMessage(tabId, { type: 'START_ADHOC_SCAN' }).catch(() => {});
      else await pushTaskToTab(tabId, task);
      return;
    }
    await sleep(500);
  }
});

// ---------------- 商品页轮询通道（onSale / returns） ----------------

async function channelLoop(task, channelIdx, ctrl) {
  await sleep(80 * channelIdx + Math.random() * 150);
  let errStreak = 0;
  while (!ctrl.signal.aborted) {
    heartbeats.set(task.id, Date.now());
    const started = Date.now();
    let ok = false;
    let hitInfo = null;
    try {
      const product = await fetchProduct(task.url, ctrl.signal);
      ok = true;
      errStreak = 0;
      hitInfo = evaluate(task, product);
      await recordScan(task.id, Date.now() - started, hitInfo);
      if (hitInfo.hit) await onHit(task, hitInfo);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      errStreak++;
      pushLog(task.id, 'error', `通道${channelIdx + 1}: ${e.message}`);
      await recordScan(task.id, Date.now() - started, null, e.message);
    }
    const base = Math.max(task.intervalMs || 800, settings.minIntervalMs);
    let wait = base * (0.85 + Math.random() * 0.3);
    if (!ok) wait = Math.min(base * Math.pow(2, errStreak), 30000);
    await sleepInterruptible(wait, ctrl);
  }
}

async function fetchProduct(url, signal) {
  const res = await fetch(url, { signal, cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const html = await res.text();
  return parseProduct(html);
}

function evaluate(task, product) {
  if (task.mode === 'onSale') {
    const open = parseKst(product.bookingOpenTime);
    if (open && serverNow() >= open) {
      return { hit: true, kind: 'on-sale', signature: 'open', message: `已开售！开售时间 ${product.bookingOpenTime} KST` };
    }
    return { hit: false, message: '未开售' };
  }
  const fp = JSON.stringify([product.goodsStatus, product.prices, product.bookingOpenTime, product.bookingEndTime]);
  const prev = fingerprints.get(task.id);
  fingerprints.set(task.id, fp);
  if (prev && prev !== fp) {
    return { hit: true, kind: 'page-change', signature: 'fp-' + Date.now(), message: '商品页数据发生变化，可能存在回流票！' };
  }
  return { hit: false, message: '暂无变化' };
}

// ---------------- 命中处理 ----------------

async function onHit(task, info) {
  const now = Date.now();
  if (now - (lastHitAt.get(task.id) || 0) < 30000) return;
  lastHitAt.set(task.id, now);
  const s = stats.get(task.id);
  if (s) { s.hits++; s.lastHitAt = now; }
  pushLog(task.id, 'hit', info.message);
  hits.unshift({ t: now, taskId: task.id, taskName: task.name, message: info.message, detail: info.detail || null });
  hits = hits.slice(0, 50);
  await chrome.storage.local.set({ hits });
  await mirrorRuntime();
  await alertUser(task, info.message);
}

// 与具体任务无关的提醒（选座时限告警、扫描自动停止等）
async function notifyRaw(title, message, withSound = false) {
  if (settings.notify) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
      priority: 2,
      requireInteraction: true,
    }).catch(() => {});
  }
  if (withSound && settings.sound) playSound(3).catch(() => {});
}

async function alertUser(task, message) {
  if (settings.notify) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '🎫 命中 — ' + task.name,
      message,
      priority: 2,
      requireInteraction: true,
    });
  }
  if (settings.sound) playSound(3).catch(() => {});
  if (settings.autoOpenTab) {
    const tab = await findSeatTab(task);
    if (tab) chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    else chrome.tabs.create({ url: task.entryUrl || productUrl(task), active: true }).catch(() => {});
  }
}

// ---------------- 统计 / 日志 ----------------

async function recordScan(taskId, latency, hitInfo, err) {
  const s = stats.get(taskId) || { scans: 0, hits: 0, avgLatency: 0, lastScanAt: 0, lastHitAt: 0, lastError: '' };
  s.scans++;
  s.lastScanAt = Date.now();
  s.avgLatency = s.avgLatency ? Math.round(s.avgLatency * 0.8 + latency * 0.2) : Math.round(latency);
  if (hitInfo?.hit) s.hits++;
  if (err) s.lastError = err;
  stats.set(taskId, s);
  if (s.scans % 20 === 0 || hitInfo?.hit || err) await mirrorRuntime();
}

function pushLog(taskId, level, msg) {
  logs.push({ t: Date.now(), taskId, level, msg });
  if (logs.length > 300) logs = logs.slice(-300);
}

async function mirrorRuntime() {
  await chrome.storage.session.set({ stats: [...stats.entries()], logs: logs.slice(-200) }).catch(() => {});
}

async function persistTasks() {
  await chrome.storage.local.set({ tasks: [...tasks.values()] }).catch(() => {});
}

// ---------------- 徽标：座位页就绪但还没开扫时提示一下 ----------------

// 只在状态翻转时写徽标，避免每次余票推送都打一次 tabs.query
let badgeKey = '';

async function refreshBadge() {
  let live = seatState;
  if (!live?.href) {
    const tab = await findSeatTab(null).catch(() => null);
    const st = tab ? await chrome.tabs.sendMessage(tab.id, { type: 'GET_SEAT_STATE' }).catch(() => null) : null;
    if (st?.ok) live = st;
  }
  const t = live?.timer || null;
  // 剩余 2 分钟以内就把徽标切成红色，即使面板收起也不会漏看
  const urgent = t?.active && (t.remaining <= 120000 || t.state === 'dead');
  const key = `${live?.hasSession ? 1 : 0}|${live?.monitoring ? 1 : 0}|${urgent ? 1 : 0}`;
  if (key === badgeKey) return;
  badgeKey = key;
  const monitoring = !!live?.monitoring;
  const text = urgent ? '!' : monitoring ? '●' : live?.hasSession ? '1' : '';
  chrome.action.setBadgeBackgroundColor({ color: urgent ? '#dc2626' : monitoring ? '#16a34a' : '#f59e0b' }).catch(() => {});
  chrome.action.setBadgeText({ text }).catch(() => {});
}

// 座位页被关掉后徽标要跟着清掉（内容脚本不会再推 SEAT_STATE 了）
chrome.tabs.onRemoved.addListener(() => {
  setTimeout(async () => {
    const tab = await findSeatTab(null).catch(() => null);
    if (!tab) {
      seatState = {};
      badgeKey = '';
      await refreshBadge();
    }
  }, 300);
});

// ---------------- 提示音 ----------------
let offscreenCreating;
async function ensureOffscreen() {
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!contexts.length) await chrome.offscreen.createDocument({
      url: 'offscreen/sound.html', reasons: ['WORKERS', 'AUDIO_PLAYBACK'],
      justification: '本地验证码 OCR 工作线程与提示音',
    });
  })().finally(() => { offscreenCreating = null; });
  return offscreenCreating;
}
async function playSound(times) {
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'play-sound', times }).catch(() => {});
}

// ---------------- 看门狗 ----------------

chrome.alarms.create('watchdog', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'watchdog') return;
  await ensureTimeSynced();
  for (const [id, ctrls] of loops) {
    const hb = heartbeats.get(id) || 0;
    if (Date.now() - hb > 90000) {
      pushLog(id, 'warn', '通道心跳丢失，自动重启');
      ctrls.forEach((c) => c.abort());
      loops.delete(id);
      startTask(id, true);
    }
  }
  for (const task of tasks.values()) {
    if (task.status !== 'running') continue;
    if (task.mode === 'seat') {
      // 座位会话可能因刷新/过期失效，定期巡视一遍
      const tab = await findSeatTab(task);
      if (tab) {
        const st = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SEAT_STATE' }).catch(() => null);
        // 选座 10 分钟已经用完 → 别再把它重新拉起来，标记为已停止
        if (st?.timer?.active && st.timer.state === 'dead') {
          task.status = 'stopped';
          await persistTasks();
          await chrome.storage.local.remove('autoStartTask').catch(() => {});
          pushLog(task.id, 'warn', '选座时限已到，任务自动标记为已停止');
          continue;
        }
        if (st?.ok && st.hasSession && !st.monitoring) {
          // 现场任务重新下发时走"按当前页现算"的入口，避免用旧参数把用户改过的范围覆盖回去
          if (task.adHoc) await chrome.tabs.sendMessage(tab.id, { type: 'START_ADHOC_SCAN' }).catch(() => {});
          else await pushTaskToTab(tab.id, task);
        }
      }
    } else if (!loops.has(task.id)) {
      startTask(task.id, true);
    }
  }
  await mirrorRuntime();
  await refreshBadge();
});

// ---------------- 消息接口 ----------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'ocr-offscreen' || msg?.type === 'play-sound') return false;
  (async () => {
    try {
      switch (msg?.type) {
        case 'OCR_PROGRESS': {
          if (sender.url !== chrome.runtime.getURL('offscreen/sound.html') || !Number.isInteger(msg.tabId)) break;
          await chrome.tabs.sendMessage(msg.tabId, { type: 'OCR_PROGRESS', requestId: msg.requestId, stage: msg.stage }).catch(() => {});
          sendResponse({ ok: true });
          break;
        }
        case 'OCR_CAPTCHA': {
          if (!/^https:\/\/tickets\.interpark\.com\/onestop/.test(sender.tab?.url || '')) throw new Error('OCR 仅用于选座页');
          if (typeof msg.image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(msg.image) || msg.image.length > 2000000) throw new Error('验证码图片格式错误');
          await ensureOffscreen();
          sendResponse(await chrome.runtime.sendMessage({ target: 'ocr-offscreen', image: msg.image, tabId: sender.tab.id, requestId: msg.requestId }));
          break;
        }
        case 'get-state': {
          await ensureTimeSynced();
          const running = [...tasks.values()].find((t) => t.mode === 'seat' && t.status === 'running');
          sendResponse({
            tasks: [...tasks.values()],
            stats: [...stats.entries()],
            logs: logs.slice(-200),
            hits: hits.slice(0, 30),
            settings,
            time: timeSyncInfo(),
            serverNow: serverNow(),
            maxChannels: settings.maxChannels,
            seatState: seatState || null,
            seatTask: running ? publicTask(running) : null,
            lastCatalog: (await chrome.storage.local.get('lastCatalog')).lastCatalog || null,
            scoutPrefs: (await chrome.storage.local.get('scoutPrefs')).scoutPrefs || null,
          });
          break;
        }
        case 'parse-url': {
          const product = await fetchProduct(msg.url, undefined);
          sendResponse({ ok: true, product });
          break;
        }
        case 'create-task': {
          const task = await buildTask(msg.task);
          tasks.set(task.id, task);
          await persistTasks();
          pushLog(task.id, 'info', `任务创建：${task.name}（${MODE_NAME[task.mode] || task.mode}）`);
          await mirrorRuntime();
          sendResponse({ ok: true, task });
          break;
        }
        case 'start-task': await startTask(msg.id); sendResponse({ ok: true }); break;
        case 'stop-task': await stopTask(msg.id); sendResponse({ ok: true }); break;
        case 'delete-task': deleteTask(msg.id); sendResponse({ ok: true }); break;

        // ---- 「页面即任务」：popup 不再需要先新建任务，直接让座位页按当前页开扫 ----
        case 'start-adhoc-scan': {
          const tab = await findSeatTab(null);
          if (!tab) { sendResponse({ ok: false, error: '没有打开的 NOL 选座页 —— 请先在浏览器里进入选座界面' }); break; }
          const r = await chrome.tabs.sendMessage(tab.id, { type: 'START_ADHOC_SCAN', prefs: msg.prefs })
            .catch((e) => ({ error: e.message }));
          if (r?.error) sendResponse({ ok: false, error: r.error });
          else sendResponse({ ok: true, reused: true, blocks: r.blocks, task: r.task });
          await refreshBadge();
          break;
        }
        case 'stop-adhoc-scan': {
          const tab = await findSeatTab(null);
          if (tab) await chrome.tabs.sendMessage(tab.id, { type: 'STOP_SEAT_MONITOR' }).catch(() => {});
          for (const t of tasks.values()) if (t.adHoc && t.status === 'running') { t.status = 'stopped'; }
          await persistTasks();
          await mirrorRuntime();
          sendResponse({ ok: true });
          await refreshBadge();
          break;
        }
        case 'refresh-badge':
          await refreshBadge();
          sendResponse({ ok: true });
          break;
        case 'update-settings':
          settings = { ...settings, ...msg.settings };
          await chrome.storage.local.set({ settings });
          sendResponse({ ok: true, settings });
          break;
        case 'test-sound':
          await playSound(1);
          sendResponse({ ok: true });
          break;
        case 'sync-time': {
          const r = await syncTime();
          sendResponse({ ok: true, ...r, ...timeSyncInfo() });
          break;
        }
        case 'open-seat-page': {
          const tab = await findSeatTab(null);
          if (tab) { chrome.tabs.update(tab.id, { active: true }); sendResponse({ ok: true, reused: true }); }
          else {
            const t = await chrome.tabs.create({ url: msg.url, active: true });
            sendResponse({ ok: true, tabId: t.id });
          }
          break;
        }
        case 'locate-best': {
          // 让座位页把当前命中的座位在页面座位图上标出来（只做视觉定位，不点选）
          const task = msg.id ? tasks.get(msg.id) : [...tasks.values()].find((t) => t.mode === 'seat');
          const tab = await findSeatTab(task || null);
          if (!tab) { sendResponse({ ok: false, error: '没有打开的座位页' }); break; }
          chrome.tabs.update(tab.id, { active: true }).catch(() => {});
          const r = await chrome.tabs.sendMessage(tab.id, { type: 'LOCATE_BEST' }).catch((e) => ({ error: e.message }));
          sendResponse(r || { ok: false });
          break;
        }
        case 'probe-seat-canvas': {
          const tab = await findSeatTab(null);
          if (!tab) { sendResponse({ ok: false, error: '没有打开的座位页' }); break; }
          const r = await chrome.tabs.sendMessage(tab.id, { type: 'PROBE_SEAT_CANVAS' }).catch((e) => ({ error: e.message }));
          sendResponse(r || { ok: false });
          break;
        }
        case 'clear-hits':
          hits = [];
          await chrome.storage.local.set({ hits: [] });
          sendResponse({ ok: true });
          break;

        // ---- 来自座位页内容脚本 ----
        case 'SEAT_STATE':
          seatState = msg.state || {};
          await refreshBadge();
          sendResponse({ ok: true });
          break;
        case 'ADOPT_SEAT_TASK': {
          // 座位页就地开扫后把任务登记过来：popup 的任务清单会立刻出现它，也能从这里停止
          if (msg.task?.id) {
            tasks.set(msg.task.id, { ...msg.task, status: 'running' });
            await persistTasks();
            // 记一份"续扫令牌"：页面刷新后由内容脚本自己比对商品号为同一场再续扫
            await chrome.storage.local.set({ autoStartTask: resumeToken(msg.task) });
            pushLog(msg.task.id, 'hit', `已在页面就地开始：${msg.task.name}`);
          }
          await mirrorRuntime();
          await refreshBadge();
          sendResponse({ ok: true });
          break;
        }
        case 'SEAT_SCAN_STOPPED': {
          for (const t of tasks.values()) {
            if (t.adHoc && t.status === 'running') t.status = 'stopped';
          }
          await persistTasks();
          await chrome.storage.local.remove('autoStartTask').catch(() => {});
          await mirrorRuntime();
          await refreshBadge();
          sendResponse({ ok: true });
          break;
        }
        case 'SEAT_TIMER_NOTIFY': {
          // 选座时限相关提醒（剩 5 分钟 / 剩 1 分钟 / 时间已到自动停止）
          const ttl = msg.title || 'NOL Scout';
          const body = msg.message || '';
          await chrome.storage.local.set({ seatTimer: { title: ttl, message: body, at: Date.now() } }).catch(() => {});
          await notifyRaw(ttl, body, /停止|立即|不足/.test(body));
          pushLog(null, /时间已到|停止/.test(body) ? 'error' : 'warn', `${ttl}：${body}`);
          await mirrorRuntime();
          await refreshBadge();
          sendResponse({ ok: true });
          break;
        }
        case 'SEAT_HIT': {
          const task = tasks.get(msg.taskId) || [...tasks.values()].find((t) => t.mode === 'seat');
          const s = stats.get(msg.taskId) || { scans: 0, hits: 0, avgLatency: 0, lastScanAt: 0, lastHitAt: 0, lastError: '' };
          s.hits = (s.hits || 0) + 1;
          s.lastHitAt = Date.now();
          stats.set(msg.taskId, s);
          const detail = msg.hit;
          pushLog(msg.taskId, 'hit', detail.message);
          hits.unshift({ t: detail.at || Date.now(), taskId: msg.taskId, taskName: task?.name || '座位任务', message: detail.message, detail });
          hits = hits.slice(0, 50);
          await chrome.storage.local.set({ hits });
          await mirrorRuntime();
          if (task) await alertUser(task, detail.message + (detail.located > 0 ? ` · 页面已精确定位（${detail.located} 座）` : detail.located === 0 ? " · 已在座位图打标" : ""));
          sendResponse({ ok: true });
          break;
        }
        case 'PRODUCT_DETECTED':
          await chrome.storage.local.set({ lastProduct: { product: msg.product, url: msg.url, at: Date.now() } });
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ error: 'unknown message type' });
      }
    } catch (e) {
      sendResponse({ error: e.message });
    }
  })();
  return true;
});

const MODE_NAME = { seat: '座位级回流监控', onSale: '开售监控', returns: '商品页回流监控' };

async function buildTask(input) {
  const id = input.id || 't' + Date.now();
  if (input.mode === 'seat') {
    if (!input.goodsCode || !input.placeCode) throw new Error('座位级任务需要商品号与场馆号（在商品页解析一次即可）');
    return {
      id,
      createdAt: Date.now(),
      status: 'stopped',
      mode: 'seat',
      name: input.name || `座位监控 ${input.goodsCode}`,
      goodsCode: String(input.goodsCode),
      placeCode: String(input.placeCode),
      bizCode: String(input.bizCode || '10965'),
      url: input.url || `https://world.nol.com/ticket/places/${input.placeCode}/products/${input.goodsCode}`,
      entryUrl: input.entryUrl || null,
      playSeqs: input.playSeqs || [],
      grades: input.grades || [],
      regions: input.regions || [],
      quantity: Math.max(1, Number(input.quantity) || 1),
      preference: input.preference || 'any',
      stageSide: input.stageSide || 'top',
      intervalMs: Math.max(Number(input.intervalMs) || 2800, 1200),
      cooldownMs: Math.max(Number(input.cooldownMs) || 15000, 5000),
    };
  }
  if (!/^https:\/\/world\.nol\.com\/.*/.test(input.url || '')) throw new Error('仅支持 world.nol.com 的商品页');
  const product = await fetchProduct(input.url, undefined);
  return {
    id,
    createdAt: Date.now(),
    status: 'stopped',
    mode: input.mode || 'returns',
    name: input.name || product.name || '未命名任务',
    url: input.url,
    goodsCode: product.goodsCode,
    placeCode: product.placeCode,
    channels: Math.min(Math.max(1, input.channels || 2), settings.maxChannels),
    intervalMs: Math.max(input.intervalMs || 800, settings.minIntervalMs),
    quantity: input.quantity || 1,
    grades: input.grades || [],
    regions: input.regions || [],
    openAt: product.bookingOpenTime || null,
  };
}

// ---------------- 工具 ----------------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
