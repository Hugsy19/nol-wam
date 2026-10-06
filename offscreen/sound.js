// 在隐藏文档中本地合成提示音；重复提醒替换旧声音，避免叠加。
let activeSound = null;

function stopSound() {
  if (!activeSound) return;
  const { ctx, timer } = activeSound;
  activeSound = null;
  clearTimeout(timer);
  void ctx.close().catch(() => {});
}

function tone(ctx, at, freq, duration, volume, type) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), at + 0.015);
  gain.gain.setValueAtTime(Math.max(0.0001, volume), at + duration - 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + duration + 0.02);
}

async function play(msg) {
  stopSound();
  const rawVolume = Number(msg.volume ?? 80);
  const volume = Math.max(0, Math.min(100, Number.isFinite(rawVolume) ? rawVolume : 80)) / 100;
  if (!volume) return;
  const ctx = new AudioContext();
  const playback = { ctx, timer: null };
  activeSound = playback;
  try {
    await ctx.resume();
    if (activeSound !== playback) return;
    const base = ctx.currentTime + 0.05;
    let duration;
    if (msg.style === 'classic') {
      const times = Math.max(1, Math.min(6, Math.floor(Number(msg.times) || 1)));
      for (let i = 0; i < times; i++) {
        tone(ctx, base + i * 0.22, 880, 0.12, volume * 0.25, 'sine');
        tone(ctx, base + i * 0.22 + 0.12, 1320, 0.1, volume * 0.25, 'sine');
      }
      duration = times * 0.22;
    } else {
      for (let i = 0; i < 10; i++) {
        tone(ctx, base + i * 0.8, 880, 0.26, volume * 0.45, 'triangle');
        tone(ctx, base + i * 0.8 + 0.3, 1174.66, 0.26, volume * 0.45, 'triangle');
      }
      duration = 8;
    }
    playback.timer = setTimeout(() => {
      if (activeSound === playback) stopSound();
    }, (duration + 0.3) * 1000);
  } catch (error) {
    if (activeSound === playback) stopSound();
    console.warn('提示音播放失败', error);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'play-sound') void play(msg);
  if (msg?.type === 'stop-sound' && msg.target === 'sound-offscreen') stopSound();
});
