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

export const TIMER_VERSION = '1.0.0';

/** 站点文案里的 10 分钟（좌석 선택 시간 / seat selection time） */
export const SEAT_WINDOW_MS = 10 * 60 * 1000;
/** 宽限：本地钟归零、但服务端明确说过"还没过期"时，再撑这么久 */
export const DEFAULT_GRACE_MS = 45 * 1000;
/** 服务端 `isExpiredSession` 观测值的新鲜期：超过这么久就不再采信 */
export const SERVER_FRESH_MS = 60 * 1000;

// 合理性区间：2020-01-01 ~ 2036-01-01。
// 用来防止把 userSeq 之类的纯数字误当成时间戳（宁可退化为"首次观测"锚点，也不要算错）。
export const TOKEN_TS_MIN = 1577836800;
export const TOKEN_TS_MAX = 2082758400;

/**
 * 从 x-onestop-session 解出会话起点（Unix 毫秒）。
 * @returns {number|null} 解不出或不在合理区间 → null
 */
export function parseSessionStart(token) {
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
export function resolveAnchor(token, firstSeenMs = Date.now()) {
  const fromToken = parseSessionStart(token);
  if (fromToken != null) return { startMs: fromToken, anchor: 'token', confidence: 'exact' };
  return { startMs: firstSeenMs, anchor: 'observed', confidence: 'assumed' };
}

/** 剩余毫秒（可为负） */
export function remainingMs(deadlineMs, nowMs) {
  if (!Number.isFinite(deadlineMs)) return NaN;
  return deadlineMs - nowMs;
}

/** 分档：ok / warn（≤5min）/ danger（≤1min）/ expired（≤0） */
export function countdownPhase(remaining, { warnMs = 5 * 60 * 1000, dangerMs = 60 * 1000 } = {}) {
  if (!Number.isFinite(remaining)) return 'unknown';
  if (remaining <= 0) return 'expired';
  if (remaining <= dangerMs) return 'danger';
  if (remaining <= warnMs) return 'warn';
  return 'ok';
}

/** 倒计时文本：MM:SS；超过 1 小时给 H:MM:SS；归零给 00:00 */
export function formatCountdown(ms) {
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
export function reconcile({ nowMs, deadlineMs, serverExpired = null, serverCheckedAt = 0, graceMs = DEFAULT_GRACE_MS } = {}) {
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
export function nextAlarm(prevLevel, remaining) {
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
export function shouldStop(result) {
  return result?.state === 'dead';
}

/** 面板/弹窗用的一行摘要 */
export function describeTimer({ confidence, anchor, deadlineMs, note } = {}) {
  const src = confidence === 'exact'
    ? '起点取自会话令牌内嵌的服务器时刻'
    : '起点为首次观测（令牌未含时间戳，计时可能偏乐观）';
  const at = Number.isFinite(deadlineMs)
    ? new Date(deadlineMs).toLocaleTimeString('zh-CN', { hour12: false })
    : '—';
  return `${src} · 截止 ${at}${note ? ' · ' + note : ''}`;
}
