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

export const PANEL_MARGIN = 16;          // 与页边留白
export const PANEL_MIN_VISIBLE = 120;    // 纵向至少留这么多，保证标题栏始终可抓可拖
export const PANEL_DEFAULT_W = 372;      // 兜底宽度（.card 实际就是 372px）
export const PANEL_DEFAULT_H = 320;

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * 把面板坐标夹进视口。
 * 横向要求整块可见；纵向只要求标题栏可见 —— 面板内容很长时（日志/地图）
 * 允许下沿超出视口，`top` 被顶到 `vh - PANEL_MIN_VISIBLE` 就停住。
 */
export function clampPanelPos(left, top, opts = {}) {
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
export function mirrorPanelPos(pos, opts = {}) {
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
export function normalizePanelPos(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const left = Number(raw.left);
  const top = Number(raw.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { left, top };
}
