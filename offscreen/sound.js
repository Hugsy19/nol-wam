// 提示音：MV3 的 service worker 不能播放音频，必须走 offscreen document。
// 用 WebAudio 合成"哔哔哔"，无需额外音频资源文件。

function beep(ctx, at, freq = 880, dur = 0.12) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

function play(times) {
  const ctx = new AudioContext();
  const base = ctx.currentTime + 0.05;
  for (let i = 0; i < times; i++) {
    beep(ctx, base + i * 0.22, 880, 0.12);
    beep(ctx, base + i * 0.22 + 0.12, 1320, 0.1);
  }
  setTimeout(() => ctx.close(), (times * 0.22 + 0.5) * 1000 + 200);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'play-sound') {
    play(Math.min(msg.times || 1, 6));
  }
});
