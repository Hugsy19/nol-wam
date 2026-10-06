// 模型、引擎、图片全在本地。多个选座页的 OCR 串行执行。
let ocrWorkerPromise;
let queue = Promise.resolve();
let currentOcrJob;
let lastOcrStage = '';
function reportOcrStage(status) {
  const labels = { 'loading tesseract core': '正在加载本地识别引擎', 'initializing tesseract': '正在初始化本地识别引擎', 'loading language traineddata': '正在加载本地识别模型', 'initializing api': '正在初始化识别模型', 'recognizing text': '正在识别验证码文字' };
  if (!currentOcrJob || lastOcrStage === status || !labels[status]) return;
  lastOcrStage = status;
  chrome.runtime.sendMessage({ type: 'OCR_PROGRESS', tabId: currentOcrJob.tabId, requestId: currentOcrJob.requestId, stage: labels[status] }).catch(() => {});
}
async function ocrDeadline(promise, ms, error) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(error)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function localWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = Tesseract.createWorker('eng', 1, {
      workerPath: chrome.runtime.getURL('vendor/ocr/worker.min.js'),
      corePath: chrome.runtime.getURL('vendor/ocr/core'),
      langPath: chrome.runtime.getURL('vendor/ocr/lang'),
      workerBlobURL: false, gzip: true,
      logger: event => reportOcrStage(event.status),
      errorHandler: () => reportOcrStage('error'),
    }).then(async worker => {
      await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', tessedit_pageseg_mode: '7' });
      return worker;
    }).catch(error => { ocrWorkerPromise = null; throw error; });
  }
  return ocrWorkerPromise;
}
async function prepareCaptcha(dataUrl) {
  // 隐藏 offscreen 文档不依赖页面绘制周期，使用 ImageBitmap 解码，避免 Image.decode 一直等待。
  const image = await createImageBitmap(await (await fetch(dataUrl)).blob());
  if (image.width > 2000 || image.height > 1000) throw new Error('图片尺寸超限');
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); image.close();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const w = canvas.width, h = canvas.height, mask = new Uint8Array(w * h);
  let greenSum = 0, blueSum = 0;
  for (let i = 0; i < pixels.data.length; i += 4) { greenSum += pixels.data[i + 1]; blueSum += pixels.data[i + 2]; }
  const cyanTheme = greenSum > blueSum;
  let foreground = 0;
  for (let i = 0; i < mask.length; i++) {
    const [r, g, b] = pixels.data.subarray(i * 4, i * 4 + 3);
    if (g > 90 && (cyanTheme ? (b > 100 && r < 140 && b > r * 1.4 && g > r * 1.4) : (r > 100 && r + g > 3 * b))) { mask[i] = 1; foreground++; }
  }
  // 两份 HAR 分别为蓝底黄字、绿底青字；其他主题保留原图。
  if (foreground < 50 || foreground > mask.length * 0.5) return dataUrl;
  const keep = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    mask[i] = 0; const component = [i], stack = [i];
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = Math.floor(p / w);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const q = ny * w + nx;
        if (mask[q]) { mask[q] = 0; component.push(q); stack.push(q); }
      }
    }
    if (component.length >= 8) for (const p of component) keep[p] = 1;
  }
  for (let i = 0; i < keep.length; i++) {
    pixels.data[i * 4] = pixels.data[i * 4 + 1] = pixels.data[i * 4 + 2] = keep[i] ? 0 : 255;
    pixels.data[i * 4 + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  const large = document.createElement('canvas'); large.width = w * 4; large.height = h * 4;
  const output = large.getContext('2d'); output.imageSmoothingEnabled = true; output.imageSmoothingQuality = 'high';
  output.drawImage(canvas, 0, 0, large.width, large.height);
  return large.toDataURL('image/png');
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.target !== 'ocr-offscreen') return false;
  queue = queue.catch(() => {}).then(async () => {
    currentOcrJob = msg; lastOcrStage = '';
    let worker;
    try {
      worker = await ocrDeadline(localWorker(), 10000, '本地识别引擎初始化超时，请手动输入');
      const { data } = await ocrDeadline((async () => worker.recognize(await prepareCaptcha(msg.image)))(), 5000, '本地文字识别超时，请手动输入');
      reply({ text: data.text, confidence: data.confidence });
    } catch (e) {
      ocrWorkerPromise = null;
      if (worker) worker.terminate().catch(() => {});
      reply({ error: e.message?.includes('超时') ? e.message : '本地识别引擎出错，请手动输入验证码' });
    } finally { currentOcrJob = null; }
  });
  return true;
});
