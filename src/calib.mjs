// Where a makeup layer's texture lands on the face: a calibration texture whose colour is its own
// coordinate (R = texture x, G = texture y, B = 128) is rendered on a temporary layer, and decoding a
// preview frame gives every face pixel's texture position. Overlaying the texture grid on the frame
// without makeup then shows where a line drawn at texture y lands on this model; for the eye layout the
// upper-lid edge and the lash-line rim are read off directly, per eye.
import { PNG } from 'pngjs';
import { LAYOUTS } from './paint.mjs';

// The coded window per layout, in texture px. The eye layout codes its left half (the frame's left eye)
// and mirrors it onto the right half, so 8 bits span half the width (window from the calibration that
// found the liner fringe, 初雪冷白 2026-11-08); face and lips code the whole texture.
export const WINDOWS = {
  eye: { x0: 90, x1: 450, y0: 170, y1: 330, mirror: true },
  face: { x0: 0, x1: 1024, y0: 0, y1: 1024, mirror: false },
  lips: { x0: 0, x1: 460, y0: 0, y1: 230, mirror: false },
};

export function encodeUv(layout) {
  const { width: w, height: h } = LAYOUTS[layout];
  const win = WINDOWS[layout];
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xl = win.mirror && x >= w / 2 ? w - 1 - x : x;
      const i = (y * w + x) * 4;
      const inside = xl >= win.x0 && xl < win.x1 && y >= win.y0 && y < win.y1;
      img.data[i] = Math.round(((xl - win.x0) / (win.x1 - win.x0 - 1)) * 255);
      img.data[i + 1] = Math.round(((y - win.y0) / (win.y1 - win.y0 - 1)) * 255);
      img.data[i + 2] = 128;
      img.data[i + 3] = inside ? 255 : 0;
    }
  }
  return PNG.sync.write(img);
}

export function clearTexture(layout) {
  const { width, height } = LAYOUTS[layout];
  return PNG.sync.write(new PNG({ width, height }));
}

const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

// B is written as 128 everywhere in the code, and the calibration layer is opaque, normal-blended and
// drawn last, so on lossless frames B stays at 128 wherever it shows. Picked: ±8 covers rounding and
// texture filtering, and rejects pixels a filter or another layer changed. Where the bare frame's own B
// is that close to 128, the pixel must also differ in R or G to count as the layer showing.
const B_TOLERANCE = 8;
// Picked: σ 1.5 frame px averages the 8-bit steps (1.4 texture px on the eye layout) without blurring
// across the eye opening, which is about 10 frame px tall on a 720-wide frame.
const SMOOTH_SIGMA = 1.5;
// Picked, not measured: fewer decoded pixels than this means the layer did not show (hidden, covered,
// or a filter changed its colours).
const MIN_PIXELS = 300;

function erode(mask, w, h, n) {
  let cur = mask;
  for (let k = 0; k < n; k++) {
    const next = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      next[i] = cur[i] && cur[i - 1] && cur[i + 1] && cur[i - w] && cur[i + w] ? 1 : 0;
    }
    cur = next;
  }
  return cur;
}

// Gaussian smoothing over the valid pixels only (normalised convolution: blur(v·m) / blur(m)), so
// invalid pixels neither count nor get a value.
function smoothValid(v, valid, w, h, sigma) {
  const r = Math.ceil(sigma * 3);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const blur = (src) => {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = -r; j <= r; j++) if (x + j >= 0 && x + j < w) s += src[y * w + x + j] * k[j + r];
      tmp[y * w + x] = s;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = -r; j <= r; j++) if (y + j >= 0 && y + j < h) s += tmp[(y + j) * w + x] * k[j + r];
      out[y * w + x] = s;
    }
    return out;
  };
  const m = Float32Array.from(valid);
  const num = blur(v.map((x, i) => x * m[i]));
  const den = blur(m);
  const out = new Float32Array(w * h).fill(NaN);
  for (let i = 0; i < w * h; i++) if (valid[i]) out[i] = num[i] / den[i];
  return out;
}

// Decodes the coded frame against the bare one. Returns per eye (eye layout) or for the whole layer the
// texture position of every frame pixel the layer covers: tx / ty (NaN elsewhere), in texture px.
export function decodeUv(layout, coded, bare) {
  const { width: tw } = LAYOUTS[layout];
  const win = WINDOWS[layout];
  const { width: w, height: h } = coded;
  if (bare.width !== w || bare.height !== h) throw Error(`FRAME_SIZE_MISMATCH: ${w}×${h} vs ${bare.width}×${bare.height}`);
  let valid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const coded128 = Math.abs(coded.data[p + 2] - 128) <= B_TOLERANCE;
    const bare128 = Math.abs(bare.data[p + 2] - 128) <= B_TOLERANCE;
    const rgChanged = Math.abs(coded.data[p] - bare.data[p]) + Math.abs(coded.data[p + 1] - bare.data[p + 1]) > B_TOLERANCE;
    valid[i] = coded128 && (!bare128 || rgChanged) ? 1 : 0;
  }
  // The window's border and the layer's edge mix code with skin.
  valid = erode(valid, w, h, 2);
  const tx = new Float32Array(w * h);
  const ty = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    tx[i] = win.x0 + (coded.data[i * 4] / 255) * (win.x1 - win.x0 - 1);
    ty[i] = win.y0 + (coded.data[i * 4 + 1] / 255) * (win.y1 - win.y0 - 1);
  }
  const xs = [];
  for (let i = 0; i < w * h; i++) if (valid[i]) xs.push(i % w);
  if (xs.length < MIN_PIXELS) throw Error(`CALIBRATION_NOT_VISIBLE: only ${xs.length} frame pixels show the calibration texture; is the face in view, and does a filter or another layer drawn on top change its colours?`);
  const parts = [];
  if (win.mirror) {
    // The two eyes are two clusters along x; split at the widest gap between decoded columns.
    const cols = [...new Set(xs)].sort((a, b) => a - b);
    let gap = 0;
    let split = null;
    for (let i = 1; i < cols.length; i++) if (cols[i] - cols[i - 1] > gap) [gap, split] = [cols[i] - cols[i - 1], (cols[i] + cols[i - 1]) / 2];
    if (split === null || gap < 3) throw Error('CALIBRATION_ONE_EYE: the decoded pixels do not form two eyes');
    // The texture's left half is the frame's left eye (measured, beauty notes); the right eye shows the
    // mirrored copy, so its code reads x' = width - 1 - x.
    parts.push({ eye: 'left', sel: (x) => x < split, flip: false }, { eye: 'right', sel: (x) => x >= split, flip: true });
  } else parts.push({ eye: null, sel: () => true, flip: false });

  return parts.map(({ eye, sel, flip }) => {
    const m = new Uint8Array(w * h);
    let n = 0;
    let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
    for (let i = 0; i < w * h; i++) {
      const x = i % w;
      if (!valid[i] || !sel(x)) continue;
      m[i] = 1;
      n++;
      const y = (i - x) / w;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
    if (n < MIN_PIXELS) throw Error(`CALIBRATION_NOT_VISIBLE: only ${n} frame pixels decode for the ${eye} eye`);
    const sx = smoothValid(tx, m, w, h, SMOOTH_SIGMA);
    const sy = smoothValid(ty, m, w, h, SMOOTH_SIGMA);
    if (flip) for (let i = 0; i < w * h; i++) if (m[i]) sx[i] = tw - 1 - sx[i];
    // Texture px per frame px down the middle column, for converting widths.
    const scale = verticalScale(sy, w, Math.round((bx0 + bx1) / 2), by0, by1);
    return { eye, pixels: n, box: { x0: bx0, y0: by0, x1: bx1, y1: by1 }, tx: sx, ty: sy, texture_px_per_frame_px: scale };
  });
}

function verticalScale(ty, w, x, y0, y1) {
  const d = [];
  for (let y = y0; y < y1; y++) {
    const a = ty[y * w + x];
    const b = ty[(y + 1) * w + x];
    if (Number.isFinite(a) && Number.isFinite(b)) d.push(Math.abs(b - a));
  }
  if (!d.length) return null;
  d.sort((a, b) => a - b);
  return Number(d[Math.floor(d.length / 2)].toFixed(2));
}

// Frame position (sub-pixel) where texture y reaches `level` in each frame column of the part: the
// iso-line a stroke drawn at that texture height lands on.
export function isoLine(part, w, level) {
  const pts = [];
  for (let x = part.box.x0; x <= part.box.x1; x++) {
    let prev = null;
    for (let y = part.box.y0; y <= part.box.y1; y++) {
      const v = part.ty[y * w + x];
      if (!Number.isFinite(v)) {
        prev = null;
        continue;
      }
      if (prev && (prev.v - level) * (v - level) <= 0 && prev.v !== v) {
        pts.push([x, prev.y + (level - prev.v) / (v - prev.v)]);
        break;
      }
      prev = { y, v };
    }
  }
  return pts;
}

// Where each texture grid point (every `step` texture px) lands on the frame: the mean frame position of
// the pixels decoding to within a texture pixel of it (the decoded scale is 1–3 texture px per frame
// px, so a point's neighbourhood holds a pixel or more). Points no pixel decodes to are left out.
export function textureGrid(part, w, step) {
  const tol = Math.max(1, (part.texture_px_per_frame_px || 1) * 0.6);
  const acc = new Map();
  for (let y = part.box.y0; y <= part.box.y1; y++) {
    for (let x = part.box.x0; x <= part.box.x1; x++) {
      const i = y * w + x;
      const tx = part.tx[i];
      const ty = part.ty[i];
      if (!Number.isFinite(tx)) continue;
      const gx = Math.round(tx / step) * step;
      const gy = Math.round(ty / step) * step;
      if (Math.abs(tx - gx) > tol || Math.abs(ty - gy) > tol) continue;
      const k = `${gx},${gy}`;
      const a = acc.get(k) || { x: gx, y: gy, u: 0, v: 0, n: 0 };
      a.u += x + 0.5;
      a.v += y + 0.5;
      a.n += 1;
      acc.set(k, a);
    }
  }
  return [...acc.values()].sort((a, b) => a.y - b.y || a.x - b.x).map((a) => ({ texture: [a.x, a.y], frame: [Number((a.u / a.n).toFixed(1)), Number((a.v / a.n).toFixed(1))] }));
}

// Upper lid of each eye from the bare frame (no eye makeup): per texture column, the luminance profile
// down texture y; `edge` is where it falls fastest (lid skin into the lash line), `rim` its darkest row
// (the lash-line rim of the eye opening). Method of 工具/eye_calib/lid.py, which placed the 初雪冷白 liner.
export const LID_SEARCH = { y0: 215, y1: 300, bin: 2 };

export function upperLid(part, bare, columns) {
  const w = bare.width;
  const out = [];
  for (const X of columns) {
    const bins = new Map();
    for (let y = part.box.y0; y <= part.box.y1; y++) {
      for (let x = part.box.x0; x <= part.box.x1; x++) {
        const i = y * w + x;
        const tx = part.tx[i];
        const ty = part.ty[i];
        if (!Number.isFinite(tx) || Math.abs(tx - X) >= 1.5 || ty <= LID_SEARCH.y0 || ty >= LID_SEARCH.y1) continue;
        const b = Math.floor((ty - LID_SEARCH.y0) / LID_SEARCH.bin);
        if (!bins.has(b)) bins.set(b, []);
        bins.get(b).push(luma(bare.data, i * 4));
      }
    }
    const nb = Math.floor((LID_SEARCH.y1 - LID_SEARCH.y0) / LID_SEARCH.bin);
    const raw = Array.from({ length: nb }, (_, b) => {
      const v = bins.get(b);
      if (!v) return null;
      v.sort((p, q) => p - q);
      return v[Math.floor(v.length / 2)];
    });
    const known = raw.map((v, b) => (v === null ? null : b)).filter((b) => b !== null);
    if (known.length < nb / 2) {
      out.push({ x: X, edge: null, rim: null });
      continue;
    }
    const filled = raw.map((v, b) => {
      if (v !== null) return v;
      const lo = known.filter((k) => k < b).pop();
      const hi = known.find((k) => k > b);
      if (lo === undefined) return raw[hi];
      if (hi === undefined) return raw[lo];
      return raw[lo] + ((raw[hi] - raw[lo]) * (b - lo)) / (hi - lo);
    });
    const sm = filled.map((_, b) => {
      let s = 0;
      let t = 0;
      for (let j = -3; j <= 3; j++) {
        const k = Math.exp(-(j * j) / 2);
        const v = filled[Math.min(nb - 1, Math.max(0, b + j))];
        s += v * k;
        t += k;
      }
      return s / t;
    });
    const centre = (b) => LID_SEARCH.y0 + (b + 0.5) * LID_SEARCH.bin;
    // Edge and rim sit above the eye's middle; the window matches lid.py (texture y 220–285).
    const lo = Math.ceil((220 - LID_SEARCH.y0) / LID_SEARCH.bin);
    const hi = Math.floor((285 - LID_SEARCH.y0) / LID_SEARCH.bin);
    let edge = lo;
    let rim = lo;
    for (let b = lo; b <= hi; b++) {
      const g = (sm[Math.min(nb - 1, b + 1)] - sm[Math.max(0, b - 1)]) / 2;
      const ge = (sm[Math.min(nb - 1, edge + 1)] - sm[Math.max(0, edge - 1)]) / 2;
      if (g < ge) edge = b;
      if (sm[b] < sm[rim]) rim = b;
    }
    out.push({ x: X, edge: centre(edge), rim: centre(rim) });
  }
  return out;
}

// 3×5 digits for labelling iso-lines.
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];

function put(img, x, y, c) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  [img.data[i], img.data[i + 1], img.data[i + 2]] = c;
}

function label(img, x, y, text, c, s = 2) {
  [...String(text)].forEach((ch, k) => {
    const bits = DIGITS[Number(ch)];
    for (let r = 0; r < 5; r++) for (let q = 0; q < 3; q++) if (bits[r * 3 + q] === '1') for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) put(img, x + (k * 4 + q) * s + dx, y + r * s + dy, c);
  });
}

// The bare frame around the part, scaled `zoom` times by pixel replication, with texture-y iso-lines
// every `step` px (red and labelled every 2 steps, cyan between) and texture-x ticks every 30 px (yellow).
export function overlay(part, bare, { zoom = 4, step = 5, pad = 6 } = {}) {
  const w = bare.width;
  const x0 = Math.max(0, part.box.x0 - pad);
  const y0 = Math.max(0, part.box.y0 - pad);
  const x1 = Math.min(w - 1, part.box.x1 + pad);
  const y1 = Math.min(bare.height - 1, part.box.y1 + pad);
  const img = new PNG({ width: (x1 - x0 + 1) * zoom, height: (y1 - y0 + 1) * zoom });
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const s = ((y0 + Math.floor(y / zoom)) * w + x0 + Math.floor(x / zoom)) * 4;
    const d = (y * img.width + x) * 4;
    img.data[d] = bare.data[s];
    img.data[d + 1] = bare.data[s + 1];
    img.data[d + 2] = bare.data[s + 2];
    img.data[d + 3] = 255;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < part.ty.length; i++) if (Number.isFinite(part.ty[i])) [lo, hi] = [Math.min(lo, part.ty[i]), Math.max(hi, part.ty[i])];
  for (let level = Math.ceil(lo / step) * step; level <= hi; level += step) {
    const major = level % (2 * step) === 0;
    const c = major ? [255, 40, 40] : [0, 200, 255];
    const pts = isoLine(part, w, level);
    for (const [x, y] of pts) for (let dx = 0; dx < zoom; dx++) put(img, (x - x0) * zoom + dx, Math.round((y - y0 + 0.5) * zoom), c);
    if (major && pts.length) {
      const [x, y] = pts[0];
      label(img, (x - x0) * zoom + 2, Math.round((y - y0) * zoom) - 12, level, c);
    }
  }
  // Texture-x ticks where the middle row of the part crosses each multiple of 30.
  const my = Math.round((part.box.y0 + part.box.y1) / 2);
  const seen = new Set();
  for (let x = part.box.x0; x < part.box.x1; x++) {
    const a = part.tx[my * w + x];
    const b = part.tx[my * w + x + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;
    for (let X = Math.ceil(Math.min(a, b) / 30) * 30; X <= Math.max(a, b); X += 30) {
      if (seen.has(X)) continue;
      seen.add(X);
      const fx = x + (X - a) / (b - a);
      for (let dy = -3 * zoom; dy <= 3 * zoom; dy++) put(img, Math.round((fx - x0 + 0.5) * zoom), (my - y0) * zoom + dy, [255, 220, 0]);
      label(img, Math.round((fx - x0 + 0.5) * zoom) + 3, (my - y0) * zoom + 3 * zoom + 2, X, [255, 220, 0]);
    }
  }
  return PNG.sync.write(img);
}
