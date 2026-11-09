// Measurements on preview frames for comparing makeup states on the same video frame: region colour,
// brightness and skin detail, and side-by-side crops. Frames are PNG (lossless): JPEG blurs thin lines
// and bleeds colour across edges, which is exactly what these numbers look at.
import { PNG } from 'pngjs';

export const decodePng = (buf) => PNG.sync.read(buf);

// Rec. 601 luma, the brightness the beauty notes measure (眼周明暗, 皮肤细节).
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

function hsl(r, g, b) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, Math.round(l * 100)];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [Math.round((h * 60 + 360) % 360), Math.round(s * 100), Math.round(l * 100)];
}

// A box given as fractions of the frame, in whole pixels, clamped to the frame.
export function pixelBox(img, box) {
  const x0 = Math.max(0, Math.min(img.width - 1, Math.round(box.x * img.width)));
  const y0 = Math.max(0, Math.min(img.height - 1, Math.round(box.y * img.height)));
  const x1 = Math.max(x0 + 1, Math.min(img.width, Math.round((box.x + box.width) * img.width)));
  const y1 = Math.max(y0 + 1, Math.min(img.height, Math.round((box.y + box.height) * img.height)));
  return { x0, y0, x1, y1 };
}

// Separable gaussian over a luma plane, clamped at the borders.
function blurPlane(p, w, h, sigma) {
  const r = Math.ceil(sigma * 3);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const sum = k.reduce((s, v) => s + v, 0);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += p[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + r];
    tmp[y * w + x] = s / sum;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r];
    out[y * w + x] = s / sum;
  }
  return out;
}

// Picked, not measured: σ 2 px separates pore-level texture from the face's shading at 720 px wide.
export const DETAIL_SIGMA = 2;

// Mean colour, HSL, luma and skin detail (mean |luma − blurred luma|: higher is more texture, lower is
// smoother) inside `box`.
export function regionStats(img, box) {
  const { x0, y0, x1, y1 } = pixelBox(img, box);
  const w = x1 - x0;
  const h = y1 - y0;
  const Y = new Float32Array(w * h);
  let r = 0, g = 0, b = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * img.width + x0 + x) * 4;
      r += img.data[i];
      g += img.data[i + 1];
      b += img.data[i + 2];
      Y[y * w + x] = luma(img.data[i], img.data[i + 1], img.data[i + 2]);
    }
  }
  const n = w * h;
  const blurred = blurPlane(Y, w, h, DETAIL_SIGMA);
  let detail = 0;
  for (let i = 0; i < n; i++) detail += Math.abs(Y[i] - blurred[i]);
  const rgb = [r / n, g / n, b / n];
  return { rgb: rgb.map((v) => Number(v.toFixed(1))), hsl: hsl(...rgb), luma: Number(luma(...rgb).toFixed(1)), detail: Number((detail / n).toFixed(2)), pixels: [w, h] };
}

// Largest per-pixel luma difference and mean absolute difference between two frames inside `box`.
export function frameDiff(a, b, box) {
  if (a.width !== b.width || a.height !== b.height) throw Error(`FRAME_SIZE_MISMATCH: ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  const { x0, y0, x1, y1 } = pixelBox(a, box);
  let sum = 0;
  let max = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4;
      const d = Math.abs(luma(a.data[i], a.data[i + 1], a.data[i + 2]) - luma(b.data[i], b.data[i + 1], b.data[i + 2]));
      sum += d;
      if (d > max) max = d;
    }
  }
  return { mean: Number((sum / ((x1 - x0) * (y1 - y0))).toFixed(2)), max: Math.round(max) };
}

// Measured: a 7-state strip 2.2k px wide came back to the chat scaled to 1024 px, too small to make out
// lashes; rows are kept within this width instead.
const STRIP_WIDTH = 1024;

// Crops [{ img, box }] of the same part, each scaled to the first crop's size × zoom by pixel
// replication (nearest, so nothing is invented), in rows no wider than STRIP_WIDTH with a 2 px white gap.
export function sideBySide(tiles, zoom) {
  const first = pixelBox(tiles[0].img, tiles[0].box);
  const cw = (first.x1 - first.x0) * zoom;
  const ch = (first.y1 - first.y0) * zoom;
  const GAP = 2;
  const cols = Math.max(1, Math.min(tiles.length, Math.floor((STRIP_WIDTH + GAP) / (cw + GAP))));
  const rows = Math.ceil(tiles.length / cols);
  const out = new PNG({ width: cols * cw + (cols - 1) * GAP, height: rows * ch + (rows - 1) * GAP });
  out.data.fill(255);
  tiles.forEach(({ img, box }, k) => {
    const { x0, y0, x1, y1 } = pixelBox(img, box);
    const [ox, oy] = [(k % cols) * (cw + GAP), Math.floor(k / cols) * (ch + GAP)];
    for (let y = 0; y < ch; y++) {
      const sy = y0 + Math.min(y1 - y0 - 1, Math.floor((y * (y1 - y0)) / ch));
      for (let x = 0; x < cw; x++) {
        const sx = x0 + Math.min(x1 - x0 - 1, Math.floor((x * (x1 - x0)) / cw));
        const si = (sy * img.width + sx) * 4;
        const di = ((oy + y) * out.width + ox + x) * 4;
        out.data[di] = img.data[si];
        out.data[di + 1] = img.data[si + 1];
        out.data[di + 2] = img.data[si + 2];
        out.data[di + 3] = 255;
      }
    }
  });
  return PNG.sync.write(out);
}
