// Measurements on preview frames for comparing makeup states on the same video frame: region colour,
// brightness and skin detail, and side-by-side crops. Frames are PNG (lossless): JPEG blurs thin lines
// and bleeds colour across edges, which is exactly what these numbers look at.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PNG } from 'pngjs';

export const decodePng = (buf) => PNG.sync.read(buf);

// Rec. 601 luma, the brightness the beauty notes measure (眼周明暗, 皮肤细节).
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// Pixel boxes from light_metrics.py (xiangsu-beauty), written for the reference sizes below and scaled
 // to the actual frame. Keys match the Chinese labels the skill printed.
const LIGHT_BASE = { H: [720, 1280], G: [720, 1280], ref: [673, 808] };
const LIGHT_BOXES_PX = {
  ref: {
    眉心: [275, 250, 335, 290],
    画面左颊: [90, 380, 200, 470],
    画面右颊: [420, 400, 480, 470],
    鼻尖顶: [230, 450, 270, 475],
    鼻底: [225, 485, 275, 505],
    下巴: [200, 670, 300, 710],
  },
  H: {
    眉心: [345, 470, 375, 495],
    画面左颊: [250, 600, 320, 680],
    画面右颊: [440, 600, 510, 680],
    鼻尖顶: [345, 612, 375, 632],
    鼻底: [345, 652, 375, 664],
    下巴: [330, 745, 400, 775],
  },
  G: {
    眉心: [345, 400, 385, 430],
    画面左颊: [210, 530, 290, 610],
    画面右颊: [440, 530, 520, 610],
    鼻尖顶: [350, 555, 385, 578],
    鼻底: [350, 598, 385, 610],
    下巴: [330, 745, 400, 775],
  },
};

export function lightPresetRegions(preset, width, height) {
  const boxes = LIGHT_BOXES_PX[preset];
  if (!boxes) throw Error(`UNKNOWN_LIGHT_PRESET: ${preset}; use H, G or ref`);
  const [bw, bh] = LIGHT_BASE[preset];
  return Object.entries(boxes).map(([label, [x0, y0, x1, y1]]) => ({
    label,
    x: x0 / bw,
    y: y0 / bh,
    width: (x1 - x0) / bw,
    height: (y1 - y0) / bh,
    // Kept so callers that want absolute pixels on this frame can rescale without re-deriving.
    _px: {
      x0: Math.round((x0 / bw) * width),
      y0: Math.round((y0 / bh) * height),
      x1: Math.round((x1 / bw) * width),
      y1: Math.round((y1 / bh) * height),
    },
  }));
}

export function lightMetrics(img, { preset, boxes } = {}) {
  const regions = boxes?.length
    ? boxes.map((b) => ({ label: b.label, x: b.x, y: b.y, width: b.width, height: b.height }))
    : lightPresetRegions(preset, img.width, img.height);
  const vals = {};
  for (const r of regions) {
    vals[r.label] = regionStats(img, r).luma;
  }
  const left = vals['画面左颊'];
  const right = vals['画面右颊'];
  const chin = vals['下巴'];
  const cheek = left !== undefined && right !== undefined ? (left + right) / 2 : null;
  return {
    preset: preset ?? null,
    regions: Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, Number(v.toFixed(1))])),
    cheek_delta: left !== undefined && right !== undefined ? Number((left - right).toFixed(1)) : null,
    nose_delta: vals['鼻尖顶'] !== undefined && vals['鼻底'] !== undefined ? Number((vals['鼻尖顶'] - vals['鼻底']).toFixed(1)) : null,
    chin_over_cheek: cheek ? Number((chin / cheek).toFixed(2)) : null,
    boxes: regions.map(({ label, x, y, width, height }) => ({ label, x, y, width, height })),
  };
}

export async function lightMetricsPreview(pngBuf, metrics) {
  const img = await loadImage(pngBuf);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  ctx.strokeStyle = '#00ff00';
  ctx.lineWidth = 2;
  ctx.font = 'bold 18px sans-serif';
  ctx.fillStyle = '#00ff00';
  for (const b of metrics.boxes) {
    const x = Math.round(b.x * img.width);
    const y = Math.round(b.y * img.height);
    const w = Math.round(b.width * img.width);
    const h = Math.round(b.height * img.height);
    ctx.strokeRect(x, y, w, h);
    const v = metrics.regions[b.label];
    if (v !== undefined) {
      const label = `${b.label} ${v}`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#000';
      ctx.strokeText(label, x, Math.max(16, y - 4));
      ctx.fillStyle = '#00ff00';
      ctx.fillText(label, x, Math.max(16, y - 4));
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 2;
    }
  }
  return canvas.toBuffer('image/jpeg', 85);
}

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
