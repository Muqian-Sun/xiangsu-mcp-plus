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

// The preview recolours everything it draws, the calibration layer included (measured with the filter at
// 0: texture 0 → about 10, 85 → 98, 128 → 146, 170 → 188, 255 → 255), so the coded colours read back
// too high and the face layout decoded 40–85 texture px off (忧郁冷都女, model D). A ramp texture of grey
// stripes at these levels, repeating across the window so every visible part shows all of them, gives
// the curve: the transform keeps the order of greys, so sorting the stripes' frame colours by brightness
// matches them to the levels without knowing where each landed. Levels 32 apart, picked: far wider than
// the JPEG error (12/255 measured) and close enough that the curve is near straight between two.
export const RAMP_LEVELS = [0, 32, 64, 96, 128, 160, 192, 224, 255];
// Texture px per stripe, picked: about 17 frame px on the face layout and 29 on the eye layout (1.42 and
// 0.55 texture px per frame px), so each stripe keeps a flat middle after its JPEG-blurred edges.
const RAMP_STRIPE = { face: 24, eye: 16, lips: 16 };

export function encodeRamp(layout) {
  const { width: w, height: h } = LAYOUTS[layout];
  const win = WINDOWS[layout];
  const stripe = RAMP_STRIPE[layout];
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xl = win.mirror && x >= w / 2 ? w - 1 - x : x;
      const i = (y * w + x) * 4;
      const v = RAMP_LEVELS[Math.floor(xl / stripe) % RAMP_LEVELS.length];
      img.data.set([v, v, v, xl >= win.x0 && xl < win.x1 && y >= win.y0 && y < win.y1 ? 255 : 0], i);
    }
  }
  return PNG.sync.write(img);
}

// Derived from B_TOLERANCE's JPEG error: a pixel whose 4-neighbours 2 px away differ by more than this in
// luma sits on a stripe edge. The layer shows where the frame moved off the bare one by more than the
// same JPEG allowance per channel. Picked: fewer flat pixels than this per level is too few to trust.
const RAMP_FLAT = 12;
const RAMP_SHOWS = 30;
const RAMP_MIN_PIXELS = 30;
const RAMP_PEAK_GAP = 8;

const median = (a) => {
  const s = Float64Array.from(a).sort();
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// The preview's curve per channel: for each ramp level, the median frame value of the stripes at it.
// Fails rather than guess when a level does not show or the curve does not rise.
export function toneCurve(ramp, bare) {
  const { width: w, height: h } = ramp;
  if (bare.width !== w || bare.height !== h) throw Error(`FRAME_SIZE_MISMATCH: ${w}×${h} vs ${bare.width}×${bare.height}`);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = luma(ramp.data, i * 4);
  const picked = [];
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const p = i * 4;
      const moved = Math.abs(ramp.data[p] - bare.data[p]) + Math.abs(ramp.data[p + 1] - bare.data[p + 1]) + Math.abs(ramp.data[p + 2] - bare.data[p + 2]);
      if (moved <= RAMP_SHOWS) continue;
      // Grey stays grey through the curve within the JPEG error; skin seen through holes does not.
      if (Math.max(ramp.data[p], ramp.data[p + 1], ramp.data[p + 2]) - Math.min(ramp.data[p], ramp.data[p + 1], ramp.data[p + 2]) > 2 * RAMP_FLAT) continue;
      const l = lum[i];
      if ([i - 2, i + 2, i - 2 * w, i + 2 * w].some((j) => Math.abs(lum[j] - l) > RAMP_FLAT)) continue;
      picked.push(i);
    }
  }
  const k = RAMP_LEVELS.length;
  if (picked.length < k * RAMP_MIN_PIXELS) throw Error(`CALIBRATION_NOT_VISIBLE: only ${picked.length} frame pixels show the tone ramp on the calibration layer; is the face in view, and does a filter or another layer drawn on top change its colours?`);
  // The levels' stripes are the peaks of the luma histogram (smoothed over ±2): local maxima, a smaller
  // one within RAMP_PEAK_GAP of a larger one dropped, the k largest kept. Each pixel goes to the
  // nearest. Derived: the levels are 32 apart and the curve's slope stayed above 0.7 (measured points),
  // so neighbouring levels land 20 or more apart; 8 keeps two JPEG-blurred halves of one level together.
  const hist = new Float64Array(256);
  for (const i of picked) hist[Math.round(lum[i])] += 1;
  const smooth = hist.map((_, v) => { let t = 0; for (let d = -2; d <= 2; d++) t += hist[v + d] || 0; return t; });
  const peaks = [];
  for (let v = 0; v < 256; v++) if (smooth[v] > 0 && smooth.slice(Math.max(0, v - 3), v + 4).every((x) => x <= smooth[v])) peaks.push(v);
  peaks.sort((a, b) => smooth[b] - smooth[a]);
  const kept = [];
  for (const v of peaks) if (kept.every((u) => Math.abs(u - v) > RAMP_PEAK_GAP)) kept.push(v);
  if (kept.length < k) throw Error(`TONE_RAMP_LEVEL_MISSING: the ramp shows ${kept.length} grey levels (luma ${kept.sort((a, b) => a - b).join(', ')}), not ${k}`);
  const centres = kept.slice(0, k);
  const label = picked.map((i) => centres.reduce((best, c, j) => (Math.abs(lum[i] - c) < Math.abs(lum[i] - centres[best]) ? j : best), 0));
  const groups = Array.from({ length: k }, () => [[], [], []]);
  for (const [n, i] of picked.entries()) for (let c = 0; c < 3; c++) groups[label[n]][c].push(ramp.data[i * 4 + c]);
  const order = centres.map((c, j) => [c, j]).sort((a, b) => a[0] - b[0]).map(([, j]) => j);
  const counts = order.map((j) => groups[j][0].length);
  if (counts.some((c) => c < RAMP_MIN_PIXELS)) throw Error(`TONE_RAMP_LEVEL_MISSING: flat pixels per level ${counts.join(', ')}; every one of ${k} levels needs ${RAMP_MIN_PIXELS}`);
  const curve = [0, 1, 2].map((c) => order.map((j) => median(groups[j][c])));
  for (const [c, vals] of curve.entries()) {
    if (vals.some((v, n) => n && v <= vals[n - 1])) throw Error(`TONE_CURVE_NOT_RISING: channel ${'RGB'[c]} reads ${vals.join(', ')} for levels ${RAMP_LEVELS.join(', ')}`);
  }
  return { levels: RAMP_LEVELS, r: curve[0], g: curve[1], b: curve[2], pixels: counts };
}

// Frame value → texture value through the measured curve, linear between levels and past the ends.
function inverse(levels, vals) {
  return (v) => {
    let n = 1;
    while (n < vals.length - 1 && v > vals[n]) n++;
    const t = (v - vals[n - 1]) / (vals[n] - vals[n - 1]);
    return Math.max(0, Math.min(255, levels[n - 1] + t * (levels[n] - levels[n - 1])));
  };
}

// A copy of the frame with the preview's curve undone, so the coded colours read as the texture's.
export function undoTone(img, tone) {
  const maps = [tone.r, tone.g, tone.b].map((vals) => {
    const f = inverse(tone.levels, vals);
    return Uint8Array.from({ length: 256 }, (_, v) => Math.round(f(v)));
  });
  const data = Buffer.from(img.data);
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = maps[c][data[i + c]];
  return { width: img.width, height: img.height, data };
}

// B is written as 128 everywhere in the code, and with the other makeup and filters muted the frame shows
// the calibration layer's own colours, so B stays near 128 wherever it shows. Derived: preview frames are
// JPEG, measured up to 12/255 off the lossless frame around the eyes; twice that is the tolerance (the
// JPEG-based eye_calib script used 30). Where the bare frame's own B is that close to 128, the pixel must
// also differ in R or G to count as the layer showing.
const B_TOLERANCE = 24;
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

// Least squares by the normal equations, solved by Gaussian elimination with partial pivoting.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw Error('CALIBRATION_FIT_SINGULAR: too few distinct decoded pixels to fit the mapping');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// The mesh maps frame pixels to texture positions smoothly, while JPEG errors come in blocks (8 px,
// colour at half resolution), so each part's mapping is fitted with a 2-D polynomial instead of being
// read pixel by pixel: degree 4 in normalised coordinates, 4 rounds rejecting residuals over 2.5 rms,
// fitted on pixels away from strong edges of the bare frame, where JPEG errors pile up. The method of
// 工具/eye_calib/calib.py, which measured the 初雪冷白 lid to ±2 texture px on JPEG frames.
const FIT_DEGREE = 4;
const FIT_ROUNDS = 4;
const FIT_REJECT = 2.5;
const EDGE_GRADIENT = 60;

function polyFit(px, py, vals, keep) {
  const n = px.length;
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) [cx, cy] = [cx + px[i], cy + py[i]];
  [cx, cy] = [cx / n, cy / n];
  let s = 0;
  for (let i = 0; i < n; i++) s = Math.max(s, Math.abs(px[i] - cx), Math.abs(py[i] - cy));
  const terms = [];
  for (let i = 0; i <= FIT_DEGREE; i++) for (let j = 0; j <= FIT_DEGREE - i; j++) terms.push([i, j]);
  const basis = (x, y) => {
    const u = (x - cx) / s;
    const v = (y - cy) / s;
    return terms.map(([i, j]) => u ** i * v ** j);
  };
  const rows = px.map((x, i) => basis(x, py[i]));
  let use = keep.slice();
  let coef = null;
  let rms = 0;
  for (let round = 0; round < FIT_ROUNDS; round++) {
    const m = terms.length;
    const A = Array.from({ length: m }, () => new Array(m).fill(0));
    const b = new Array(m).fill(0);
    for (let i = 0; i < n; i++) {
      if (!use[i]) continue;
      const r = rows[i];
      for (let a = 0; a < m; a++) {
        b[a] += r[a] * vals[i];
        for (let c = a; c < m; c++) A[a][c] += r[a] * r[c];
      }
    }
    for (let a = 0; a < m; a++) for (let c = 0; c < a; c++) A[a][c] = A[c][a];
    coef = solve(A, b);
    const res = rows.map((r, i) => r.reduce((t, v, k) => t + v * coef[k], 0) - vals[i]);
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < n; i++) if (use[i]) [sum, cnt] = [sum + res[i] * res[i], cnt + 1];
    rms = Math.sqrt(sum / cnt);
    use = res.map((r, i) => keep[i] && Math.abs(r) <= FIT_REJECT * rms);
  }
  return { at: (x, y) => basis(x, y).reduce((t, v, k) => t + v * coef[k], 0), rms };
}

// Decodes the coded frame against the bare one. Returns per eye (eye layout) or for the whole layer the
// texture position of every frame pixel the layer covers: tx / ty (NaN elsewhere), in texture px.
export function decodeUv(layout, coded, bare) {
  const { width: tw } = LAYOUTS[layout];
  const win = WINDOWS[layout];
  const { width: w, height: h } = coded;
  if (bare.width !== w || bare.height !== h) throw Error(`FRAME_SIZE_MISMATCH: ${w}×${h} vs ${bare.width}×${bare.height}`);
  let valid = new Uint8Array(w * h);
  const coded128 = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    coded128[i] = Math.abs(coded.data[p + 2] - 128) <= B_TOLERANCE ? 1 : 0;
    const bare128 = Math.abs(bare.data[p + 2] - 128) <= B_TOLERANCE;
    const rgChanged = Math.abs(coded.data[p] - bare.data[p]) + Math.abs(coded.data[p + 1] - bare.data[p + 1]) > B_TOLERANCE;
    valid[i] = coded128[i] && (!bare128 || rgChanged) ? 1 : 0;
  }
  // Where the code happens to match the skin, the pixel looks unchanged; those are holes inside the
  // layer's area. Fill holes (binary hole filling: what the frame border cannot reach through
  // non-layer pixels) whose B still reads as code.
  const outside = new Uint8Array(w * h);
  const queue = [];
  for (let x = 0; x < w; x++) queue.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) queue.push(y * w, y * w + w - 1);
  while (queue.length) {
    const i = queue.pop();
    if (outside[i] || valid[i]) continue;
    outside[i] = 1;
    const x = i % w;
    if (x > 0) queue.push(i - 1);
    if (x < w - 1) queue.push(i + 1);
    if (i >= w) queue.push(i - w);
    if (i < w * (h - 1)) queue.push(i + w);
  }
  for (let i = 0; i < w * h; i++) if (!valid[i] && !outside[i] && coded128[i]) valid[i] = 1;
  // The window's border and the layer's edge mix code with skin.
  valid = erode(valid, w, h, 2);
  const tx = new Float32Array(w * h);
  const ty = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    tx[i] = win.x0 + (coded.data[i * 4] / 255) * (win.x1 - win.x0 - 1);
    ty[i] = win.y0 + (coded.data[i * 4 + 1] / 255) * (win.y1 - win.y0 - 1);
  }
  // Pixels next to strong edges of the bare frame (Sobel on luma, grown by 2 px), left out of the fits.
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = luma(bare.data, i * 4);
  let edgy = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1];
    const gy = lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1];
    edgy[i] = Math.hypot(gx, gy) > EDGE_GRADIENT ? 1 : 0;
  }
  for (let k = 0; k < 2; k++) {
    const next = edgy.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (edgy[i - 1] || edgy[i + 1] || edgy[i - w] || edgy[i + w]) next[i] = 1;
    }
    edgy = next;
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
    const px = [];
    const py = [];
    const vx = [];
    const vy = [];
    const calm = [];
    for (let i = 0; i < w * h; i++) {
      if (!m[i]) continue;
      const x = i % w;
      px.push(x + 0.5);
      py.push((i - x) / w + 0.5);
      vx.push(tx[i]);
      vy.push(ty[i]);
      calm.push(!edgy[i]);
    }
    if (calm.filter(Boolean).length < MIN_PIXELS) throw Error(`CALIBRATION_NOT_VISIBLE: only ${calm.filter(Boolean).length} decoded pixels away from edges for the ${eye ?? 'layer'}`);
    const fx = polyFit(px, py, vx, calm);
    const fy = polyFit(px, py, vy, calm);
    const sx = new Float32Array(w * h).fill(NaN);
    const sy = new Float32Array(w * h).fill(NaN);
    for (let i = 0; i < w * h; i++) {
      if (!m[i]) continue;
      const x = i % w + 0.5;
      const y = Math.floor(i / w) + 0.5;
      sx[i] = flip ? tw - 1 - fx.at(x, y) : fx.at(x, y);
      sy[i] = fy.at(x, y);
    }
    const fit_rms = [fx.rms, fy.rms].map((v) => Number(v.toFixed(2)));
    // Texture px per frame px down the middle column, for converting widths.
    const scale = verticalScale(sy, w, Math.round((bx0 + bx1) / 2), by0, by1);
    return { eye, pixels: n, box: { x0: bx0, y0: by0, x1: bx1, y1: by1 }, tx: sx, ty: sy, texture_px_per_frame_px: scale, fit_rms };
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
// Picked, checked against eye_calib's readings on models D, E, G, I: lid skin falls into the lash line
// by 6–14 luma per 2 texture px, the slow shading of the lid by 1–3.
const LID_FALL = 5;
// Picked: the lash line sat 8–11 texture px below the lid edge on those models (edge 233–239, rim
// 241–247); 16 leaves room for thicker lash lines without reaching the iris middle.
const LID_RIM_PX = 16;

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
    const g = (b) => (sm[Math.min(nb - 1, b + 1)] - sm[Math.max(0, b - 1)]) / 2;
    // Scanning down from the lid skin: the edge is the first clear fall (a local extreme of the slope
    // steeper than LID_FALL), not the steepest one, which over the iris is the pupil's rim; the rim is
    // the first dip within LID_RIM_PX below it (the lash line), left out where the lash line runs
    // straight into the iris without a dip.
    const lo = Math.ceil((220 - LID_SEARCH.y0) / LID_SEARCH.bin);
    const hi = Math.floor((285 - LID_SEARCH.y0) / LID_SEARCH.bin);
    let edge = null;
    for (let b = lo; b <= hi && edge === null; b++) if (g(b) <= -LID_FALL && g(b) <= g(b - 1) && g(b) <= g(b + 1)) edge = b;
    let rim = null;
    if (edge !== null) {
      for (let b = edge + 1; b <= Math.min(nb - 2, edge + LID_RIM_PX / LID_SEARCH.bin) && rim === null; b++) if (sm[b] <= sm[b - 1] && sm[b] < sm[b + 1]) rim = b;
    }
    out.push({ x: X, edge: edge === null ? null : centre(edge), rim: rim === null ? null : centre(rim) });
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

// The minus sign as a bar: texture y fitted past the layer's edge goes below 0 on the face layout.
const MINUS = '000000111000000';

function label(img, x, y, text, c, s = 2) {
  [...String(text)].forEach((ch, k) => {
    const bits = ch === '-' ? MINUS : DIGITS[Number(ch)];
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
