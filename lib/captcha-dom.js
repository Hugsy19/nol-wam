// 验证码图片、输入框和 footer 位于同一弹窗的不同层级。
export function captchaDomStatus(doc) {
  const input = doc.querySelector('input[class*="captchaInput"], [class*="captchaInput"] input');
  if (!input) return { reason: '等待验证码输入框渲染' };
  let image;
  for (let root = input.parentElement; root && root !== doc.body; root = root.parentElement) {
    image = root.querySelector('[class*="captchaImage"] img') || image;
    const button = root.querySelector('footer button, [class*="footer"] button');
    if (image && button) return { root, input, image, button, reason: '' };
  }
  return { input, reason: image ? '等待验证码确认按钮渲染' : '等待验证码图片渲染' };
}
export function findCaptchaControls(doc) {
  const status = captchaDomStatus(doc);
  return status.reason ? null : status;
}

// 节流保证连续 DOM 更新不能无限推迟检查；属性监听和轮询覆盖分阶段渲染。
export function watchCaptchaDom(doc, check, shouldPoll) {
  let timer;
  const observer = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; check(); }, 100);
  });
  observer.observe(doc.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['src', 'class', 'disabled'],
  });
  const poll = setInterval(() => { if (shouldPoll()) check(); }, 500);
  check();
  return () => { observer.disconnect(); clearTimeout(timer); clearInterval(poll); };
}
