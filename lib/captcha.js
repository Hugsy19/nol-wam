// NOL Scout — 验证码关卡（合规版，v0.7）
//
// 实测数据（真实抓包 tickets.interpark.com.har，2026-10-06 那场）：
//   计时起点 = 令牌尾数 1791271752（= 排队放行那一刻）        t+53.9s
//   POST /onestop/api/captcha/image  → {"Img":"data:image/jpeg;base64,…"}   t+79.3s
//   GET  /onestop/api/captcha/verify?p1=<答案>&…&p9=<签名> → {"result":"Y"} t+87.7s
//   → 人工看图 + 输入 + 提交 ≈ **8.3 秒**，且全部落在选座 10 分钟窗口内（占 1.4%）。
//
// 关卡计时与结果解析；本地识别和自动提交见 offscreen/ocr.js 与 onestop-seat.js。

export const CAPTCHA_API = {
  image: '/onestop/api/captcha/image',
  verify: '/onestop/api/captcha/verify',
};

// class 名带构建哈希（ModalCaptchaText_captchaInput__DC7Gz），所以只能前缀/包含匹配
export const CAPTCHA_SEL = {
  box: '[class*="captchaBox"], [class*="captchaPlugin"]',
  textBox: '[class*="captchaBox"]',
  input: '[class*="captchaInput"] input, input[class*="captchaInput"], [class*="captchaInput"]',
  slider: '[class*="captchaPlugin"]',
  error: '[class*="captchaError"]',
};

export const CAPTCHA_KIND_LABEL = { text: '文字验证码', slider: '滑块验证码', '': '验证码' };

// 耗时分档：0~6s 正常 / 6~12s 偏慢 / >12s 太慢
export const CAPTCHA_SLOW_MS = 6000;
export const CAPTCHA_BAD_MS = 12000;
// 卡这么久基本是输错了或看不懂 → 值得再响一声提醒（避免人已经走神）
export const CAPTCHA_STUCK_MS = 35000;

const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** 这个请求是验证码的哪一步？（image = 关卡出现，verify = 交答案） */
export function captchaStage(url) {
  const s = String(url || '');
  if (s.includes(CAPTCHA_API.image)) return 'image';
  if (s.includes(CAPTCHA_API.verify)) return 'verify';
  return '';
}

/** 从元素 class 串判断是哪一种验证码 */
export function captchaKindFromClass(classText) {
  const s = String(classText || '');
  if (/captchaPlugin|captchaSlider|Slider_captcha/i.test(s)) return 'slider';
  if (/captchaBox|captchaInput|captchaImage/i.test(s)) return 'text';
  return '';
}

/** verify 的响应体 → 通过 / 未通过 / 无法判断（{"result":"Y"}） */
export function captchaPassed(text) {
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
export function stripCaptchaAnswer(url) {
  return String(url || '').replace(/([?&]p1=)[^&]*/gi, '$1***');
}

/** 耗时落在哪一档 */
export function elapsedPhase(ms, opts = {}) {
  const slow = numOr(opts.slow, CAPTCHA_SLOW_MS);
  const bad = numOr(opts.bad, CAPTCHA_BAD_MS);
  const t = numOr(ms, -1);
  if (t < 0) return 'ok';
  if (t >= bad) return 'bad';
  if (t >= slow) return 'slow';
  return 'ok';
}

export const ELAPSED_LABEL = { ok: '正常', slow: '偏慢', bad: '太慢' };

/** 8.3s / 42s —— 一位小数在 10 秒内才有意义，超过就取整免得太吵 */
export function formatElapsed(ms) {
  const s = Math.max(0, numOr(ms, 0)) / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

export function describeElapsed(ms, opts = {}) {
  const phase = elapsedPhase(ms, opts);
  return `${formatElapsed(ms)} · ${ELAPSED_LABEL[phase]}`;
}

/**
 * 贴在验证码框旁边的徽标。
 * 文案刻意把「剩余」放在前面：输入验证码的人最需要的不是"我花了多久"，
 * 而是"我还剩多久"，所以剩余时间是主角，耗时是副标题。
 */
export function captchaBadge({ remainingText, elapsedMs, kind, expired } = {}) {
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
export function captchaSummary({ elapsedMs, attempts = 1, remainingText } = {}) {
  const retry = attempts > 1 ? ` · 共 ${attempts} 次` : '';
  return `✅ 验证码通过 · 用时 ${formatElapsed(elapsedMs)}${retry} · 当前剩余 ${remainingText}`;
}

/**
 * 这 8 秒到底亏不亏？
 * 给用户一句实话：扫描如果没在跑，验证码期间就是纯等待。
 */
export function gateAdvice({ monitoring, autoStartEnabled, ready }) {
  if (monitoring) return { level: 'hit', text: '扫描进行中 —— 验证码这几秒不空转，通过时命中已经排在候选队列里' };
  if (!ready) return { level: 'wait', text: '座位目录还没好，通过验证码后再点开始也不迟' };
  if (autoStartEnabled) return { level: 'warn', text: '正在自动开扫…' };
  return { level: 'warn', text: '扫描未启动 —— 想让它在这几秒里也盯着，可在「调整范围」里打开「验证码期自动开扫」' };
}
