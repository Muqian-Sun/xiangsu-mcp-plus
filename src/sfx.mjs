// Synthesized one-shot sound effects, ported from the effect projects' make_sfx.py scripts (frequencies,
// envelopes and peak levels as those scripts used them in shipped effects). Written as WAV, or as stereo
// 128 kbps MP3 through 像塑's own ffmpeg, the format the projects imported.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpeg } from './editorres.mjs';

export const SR = 44100;

// mulberry32: a small seeded generator, so the same call gives the same noise.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(n, seed) {
  const r = random(seed);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = Math.max(r(), 1e-12);
    const v = r();
    const m = Math.sqrt(-2 * Math.log(u));
    out[i] = m * Math.cos(2 * Math.PI * v);
    if (i + 1 < n) out[i + 1] = m * Math.sin(2 * Math.PI * v);
  }
  return out;
}

const times = (dur) => Float64Array.from({ length: Math.max(1, Math.trunc(dur * SR)) }, (_, i) => i / SR);
const clip01 = (x) => Math.max(0, Math.min(1, x));
// The scripts' env(t, attack, rate): a linear attack, then exponential decay.
const env = (t, attack, rate) => clip01(t / attack) * Math.exp(-t * rate);

// numpy.convolve(x, ones(k) / k, mode="same"): the scripts' cheap low-pass.
function movingAverage(x, k) {
  const out = new Float64Array(x.length);
  const half = Math.floor((k - 1) / 2);
  let sum = 0;
  const at = (i) => (i >= 0 && i < x.length ? x[i] : 0);
  for (let j = -half; j < k - half; j++) sum += at(j);
  for (let i = 0; i < x.length; i++) {
    out[i] = sum / k;
    sum += at(i + k - half) - at(i - half);
  }
  return out;
}

// RBJ biquad band-pass (constant 0 dB peak), standing in for the whoosh script's FFT band filter.
function bandpass(x, center, q) {
  const w = (2 * Math.PI * center) / SR;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const [b0, b2, a1, a2] = [alpha / a0, -alpha / a0, (-2 * Math.cos(w)) / a0, (1 - alpha) / a0];
  const out = new Float64Array(x.length);
  let [x1, x2, y1, y2] = [0, 0, 0, 0];
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
    [x2, x1, y2, y1] = [x1, x[i], y1, y];
    out[i] = y;
  }
  return out;
}

// sin of a running phase for a frequency that changes per sample (numpy cumsum(f) / SR).
function chirp(freqs) {
  const out = new Float64Array(freqs.length);
  let ph = 0;
  for (let i = 0; i < freqs.length; i++) {
    ph += (2 * Math.PI * freqs[i]) / SR;
    out[i] = ph;
  }
  return out;
}

function mixInto(out, y, at, gain = 1) {
  const i0 = Math.trunc(at * SR);
  for (let i = 0; i < y.length && i0 + i < out.length; i++) out[i0 + i] += y[i] * gain;
  return out;
}

const map = (t, f) => t.map(f);
const concat = (parts) => {
  const out = new Float64Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};

function bell(freq, dur) {
  return map(times(dur), (t) => (Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 3) + 0.3 * Math.sin(2 * Math.PI * freq * 2 * t) * Math.exp(-t * 6)) * clip01(t / 0.004));
}

// Each preset: what it sounds like, its default peak (from the script that used it) and a generator
// taking k, the pitch multiplier.
export const PRESETS = {
  ding: {
    desc: '三个往上走的清脆铃音（揭晓、得分）',
    peak: 0.5,
    make: (k) => {
      const out = new Float64Array(SR);
      [784, 1175, 1568].forEach((f, i) => mixInto(out, map(times(0.8), (t) => (Math.sin(2 * Math.PI * f * k * t) + 0.3 * Math.sin(2 * Math.PI * f * k * 2 * t)) * env(t, 0.002, 5)), i * 0.06));
      return out;
    },
  },
  tick: { desc: '很短的「嗒」（倒计时、逐字出现）', peak: 0.5, make: (k) => map(times(0.06), (t) => Math.sin(2 * Math.PI * 1600 * k * t) * env(t, 0.0005, 70)) },
  pop: {
    desc: '卡通「啵」（出现、变化）',
    peak: 0.7,
    make: (k) => {
      const t = times(0.16);
      const ph = chirp(map(t, (x) => k * (260 + 900 * Math.exp(-x / 0.018) + 120 * Math.exp(-(((x - 0.07) / 0.02) ** 2)))));
      const noise = gaussian(t.length, 3);
      return map(t, (x, i) => Math.sin(ph[i]) * Math.exp(-x / 0.045) * clip01(x / 0.003) + noise[i] * Math.exp(-x / 0.002) * 0.25);
    },
  },
  boing: {
    desc: '弹簧「咚~」（蹦出来、被弹开）',
    peak: 0.7,
    make: (k) => {
      const t = times(0.55);
      const ph = chirp(map(t, (x) => k * (240 + 380 * Math.exp(-x * 9) * (1 + 0.25 * Math.sin(2 * Math.PI * 14 * x)))));
      return map(t, (x, i) => (Math.sin(ph[i]) + 0.3 * Math.sin(2 * ph[i])) * Math.exp(-x * 5) * clip01(x / 0.005));
    },
  },
  puff: {
    desc: '噗地漏气（笑场、泄气）',
    peak: 0.8,
    make: (k) => {
      const t = times(0.4);
      const lo = movingAverage(gaussian(t.length, 11), 30);
      const ph = chirp(map(t, (x) => k * (180 * Math.exp(-x * 4) + 70)));
      return map(t, (x, i) => (2.5 * lo[i] + 0.6 * Math.sin(ph[i])) * Math.exp(-x * 9) * clip01(x / 0.01));
    },
  },
  win: {
    desc: '四个往上走的胜利铃音',
    peak: 0.7,
    make: (k) => {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      const out = new Float64Array(Math.trunc(0.11 * SR) * (notes.length - 1) + SR);
      notes.forEach((f, i) => mixInto(out, bell(f * k, 1.0), i * 0.11));
      return out;
    },
  },
  chime: {
    desc: '高音风铃（完成、闪亮）',
    peak: 0.45,
    make: (k) => {
      const t = times(1.4);
      const notes = [[1568, 0, 1], [2093, 0.08, 0.8], [2637, 0.16, 0.6], [3136, 0.24, 0.45]];
      return map(t, (x) => notes.reduce((s, [f, d, a]) => s + (x >= d ? a * Math.sin(2 * Math.PI * f * k * (x - d)) * Math.exp(-(x - d) * 4.5) : 0), 0));
    },
  },
  whoosh: {
    desc: '呼地扫过加一声低沉的「咚」（转场、揭晓前）',
    peak: 0.6,
    make: (k) => {
      const d = 0.8;
      const t = times(d);
      const band = bandpass(gaussian(t.length, 7), 2500 * k, 0.7);
      const m = Math.max(...band.map(Math.abs)) || 1;
      const ph = chirp(map(t, (x) => k * (90 * Math.exp(-x * 6) + 40)));
      return map(t, (x, i) => (band[i] / m) * Math.sin(Math.PI * clip01(x / d)) ** 1.5 * 0.7 + Math.sin(ph[i]) * env(x, 0.003, 7));
    },
  },
  wahwah: {
    desc: '失败长号「哇哇哇哇~」，最后一个拖长带颤音',
    peak: 0.5,
    make: (k) => {
      const notes = [[392, 0.32], [370, 0.32], [349, 0.32], [330, 1.0]];
      return concat(
        notes.map(([f, d], i) => {
          const t = times(d);
          const last = i === 3 ? 1 : 0;
          const ph = chirp(map(t, (x) => f * k * (1 + last * 0.012 * Math.sin(2 * Math.PI * 5.5 * x)) * (1 - (last * 0.04 * x) / d)));
          return map(t, (x, j) => {
            let y = 0;
            for (let h = 1; h <= 6; h++) y += Math.sin(h * ph[j]) / h;
            return y * (0.55 + 0.45 * Math.sin(Math.PI * clip01(x / d))) * clip01(x / 0.03) * clip01((d - x) / 0.06);
          });
        }),
      );
    },
  },
  lose: {
    desc: '短促的方波「哇哇哇~」（小游戏失败）',
    peak: 0.5,
    make: (k) => {
      const notes = [[392, 0.18], [370, 0.18], [349, 0.18], [330, 0.6]];
      const y = concat(
        notes.map(([f, d], i) => {
          const t = times(d);
          const ph = chirp(map(t, (x) => f * k * (1 + (i === 3 ? 0.02 : 0) * Math.sin(2 * Math.PI * 6 * x))));
          return map(t, (x, j) => (Math.sign(Math.sin(ph[j])) * 0.5 + Math.sin(ph[j]) * 0.5) * clip01(x / 0.01) * clip01((d - x) / 0.04));
        }),
      );
      return movingAverage(y, 40);
    },
  },
  reveal: {
    desc: '一声带泛音的亮「叮」（结果揭晓）',
    peak: 0.5,
    make: (k) => {
      const f = 1568 * k;
      return map(times(0.9), (t) => (Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 5) + 0.4 * Math.sin(2 * Math.PI * f * 2.01 * t) * Math.exp(-t * 9) + 0.2 * Math.sin(2 * Math.PI * f * 3.02 * t) * Math.exp(-t * 14)) * clip01(t / 0.002));
    },
  },
  sparkle: {
    desc: '三个往上走的高音铃，间隔 60 毫秒（闪光、变身）',
    peak: 0.5,
    make: (k) => {
      const out = new Float64Array(Math.trunc(0.8 * SR));
      [1568, 2093, 2637].forEach((f, i) => mixInto(out, map(times(0.6), (t) => (Math.sin(2 * Math.PI * f * k * t) + 0.3 * Math.sin(2 * Math.PI * f * k * 2.76 * t)) * Math.exp(-t * 7) * clip01(t / 0.002)), i * 0.06, 1 - 0.15 * i));
      return out;
    },
  },
  heartbeat: {
    desc: '两下心跳「咚咚」（心动、紧张）',
    peak: 0.7,
    make: (k) => {
      const out = new Float64Array(Math.trunc(0.9 * SR));
      for (const [at, gain] of [[0, 1], [0.24, 0.75]]) {
        const t = times(0.22);
        const ph = chirp(map(t, (x) => k * (62 - (20 * x) / 0.22)));
        mixInto(out, map(t, (x, i) => Math.sin(ph[i]) * Math.exp(-x * 18) * clip01(x / 0.004)), at, gain);
      }
      return out;
    },
  },
  shutter: {
    desc: '两下机械快门咔嗒（拍照、定格）',
    peak: 0.6,
    make: (k) => {
      const out = new Float64Array(Math.trunc(0.25 * SR));
      [0, 0.06].forEach((at, n) => {
        const t = times(0.05);
        const noise = gaussian(t.length, 3 + n);
        const lo = movingAverage(noise, 3);
        const hi = movingAverage(noise, 12);
        mixInto(out, map(t, (x, i) => (lo[i] - hi[i]) * Math.exp(-x * 90) + 0.6 * Math.sin(2 * Math.PI * (n === 0 ? 220 : 180) * k * x) * Math.exp(-x * 60)), at);
      });
      return out;
    },
  },
  miss: {
    desc: '倒吸凉气的「嘶——」垫一声往下掉的「啵」（没中、失误）',
    peak: 0.6,
    make: (k) => {
      const t = times(0.55);
      const noise = gaussian(t.length, 5);
      const lo = movingAverage(noise, 6);
      const out = map(t, (x, i) => (noise[i] - lo[i]) * clip01(x / 0.06) * clip01((0.55 - x) / 0.2) * 0.5);
      const tb = times(0.35);
      const ph = chirp(map(tb, (x) => k * 420 * Math.exp(-x * 4)));
      return mixInto(out, map(tb, (x, i) => Math.sin(ph[i]) * env(x, 0.003, 7)), 0, 0.7);
    },
  },
  hit: {
    desc: '短促的「噗」紧跟一声清脆的「叮」（扎中、命中）',
    peak: 0.6,
    make: (k) => {
      const t = times(0.08);
      const lo = movingAverage(gaussian(t.length, 9), 30);
      const thump = map(t, (x, i) => lo[i] * env(x, 0.002, 45) * 3 + Math.sin(2 * Math.PI * (180 - 600 * x) * k * x) * env(x, 0.002, 40));
      const td = times(0.7);
      const f = 1760 * k;
      const ding = map(td, (x) => (Math.sin(2 * Math.PI * f * x) + 0.35 * Math.sin(2 * Math.PI * 2 * f * x) + 0.2 * Math.sin(2 * Math.PI * 3 * f * x)) * env(x, 0.001, 6));
      const out = new Float64Array(Math.trunc(0.05 * SR) + ding.length);
      mixInto(out, thump, 0);
      return mixInto(out, ding, 0.05, 0.6);
    },
  },
  stamp: {
    desc: '盖章：低频「咚」加一点纸面噪声（盖章、落定）',
    peak: 0.7,
    make: (k) => {
      const t = times(0.4);
      const ph = chirp(map(t, (x) => k * (120 - 60 * clip01(x / 0.15))));
      const paper = gaussian(t.length, 5);
      return map(t, (x, i) => Math.sin(ph[i]) * env(x, 0.002, 16) + paper[i] * env(x, 0.001, 55) * 0.35);
    },
  },
  shiver: {
    desc: '风声加牙齿打颤（冷、冻住）',
    peak: 0.6,
    make: (k) => {
      const d = 1.6;
      const t = times(d);
      const noise = gaussian(t.length, 11);
      const a = movingAverage(noise, 6);
      const b = movingAverage(noise, 40);
      return map(t, (x, i) => {
        const chatter = Math.sin(2 * Math.PI * 22 * x) > 0.3 ? 1 : 0;
        const tone = Math.sin(2 * Math.PI * 150 * k * x) * chatter * Math.exp(-x * 1.2);
        return (0.8 * (a[i] - b[i]) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.8 * x)) + 0.5 * tone) * clip01(x / 0.05) * clip01((d - x) / 0.3);
      });
    },
  },
};

// Picked: the pitch shift a preset still sounds like itself across (an octave down to an octave up).
export const PITCH_RANGE = [0.5, 2];

export function synth(preset, { pitch = 1, peak } = {}) {
  const p = PRESETS[preset];
  if (!p) throw Error(`UNKNOWN_SFX_PRESET: ${preset}; presets: ${Object.keys(PRESETS).join(', ')}`);
  const y = p.make(pitch);
  let max = 0;
  for (const v of y) max = Math.max(max, Math.abs(v));
  if (!(max > 0) || !Number.isFinite(max)) throw Error(`SFX_SILENT: preset ${preset} produced no signal`);
  const gain = (peak ?? p.peak) / max;
  return Float32Array.from(y, (v) => v * gain);
}

export function wav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return buf;
}

export async function writeSound(samples, file, { encode = ffmpeg } = {}) {
  if (file.endsWith('.wav')) return fs.writeFileSync(file, wav(samples));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-sfx-'));
  try {
    const src = path.join(dir, 'sfx.wav');
    fs.writeFileSync(src, wav(samples));
    await encode(['-i', src, '-ac', '2', '-b:a', '128k', file]);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw Error(`SFX_ENCODE_FAILED: ffmpeg wrote nothing to ${file}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
