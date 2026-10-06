// 校时模块：用 world.nol.com 响应的 Date 头估算本地时钟与服务器时钟的偏移。
// 精度：秒级（CDN 缓存可能有 ±1s 误差），足够"准点就位"使用。
// 若需要亚秒级精度，后续可换成向 NTS/NTP API 发请求（浏览器内无法直接走 UDP NTP）。

let offsetMs = 0; // serverNow = Date.now() + offsetMs
let lastSyncAt = 0;
let lastRttMs = 0;

export async function syncTime() {
  const t0 = Date.now();
  const res = await fetch('https://world.nol.com/', {
    method: 'HEAD',
    cache: 'no-store',
    credentials: 'omit',
  });
  const t1 = Date.now();
  const dateHeader = res.headers.get('date');
  if (!dateHeader) throw new Error('响应缺少 Date 头');
  const serverMs = new Date(dateHeader).getTime();
  if (Number.isNaN(serverMs)) throw new Error('Date 头解析失败');
  lastRttMs = t1 - t0;
  offsetMs = Math.round(serverMs + lastRttMs / 2 - t1);
  lastSyncAt = Date.now();
  return { offsetMs, rttMs: lastRttMs };
}

// 距上次同步超过 10 分钟则自动重新同步
export async function ensureTimeSynced() {
  if (!lastSyncAt || Date.now() - lastSyncAt > 10 * 60 * 1000) {
    try { await syncTime(); } catch (e) { /* 同步失败时沿用旧偏移 */ }
  }
}

export function serverNow() {
  return Date.now() + offsetMs;
}

export function timeSyncInfo() {
  return { offsetMs, lastSyncAt, rttMs: lastRttMs };
}
