// 2D assets the effect projects used to draw with one-off PIL scripts: outlined / gradient / shadowed
// text (Text2D cannot outline), rounded and pill panels, and icons cropped from preview frames with a
// caption. Rendered with Skia (@napi-rs/canvas); fonts are 像塑's built-in ones or a .ttf / .otf path.
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { fontFile } from './editorres.mjs';

const COLOR = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// Canvas ignores a colour it cannot parse and keeps the previous one, so a typo would draw silently wrong.
export function checkColor(c, what) {
  if (typeof c !== 'string' || !COLOR.test(c)) throw Error(`INVALID_COLOR(${what}): ${c}; use #rgb, #rgba, #rrggbb or #rrggbbaa`);
  return c;
}

const families = new Map();
function family(font) {
  const file = fontFile(font);
  if (!families.has(file)) {
    const alias = `xs-font-${families.size}`;
    if (!GlobalFonts.registerFromPath(file, alias)) throw Error(`FONT_LOAD_FAILED: ${file}`);
    families.set(file, alias);
  }
  return families.get(file);
}

// Picked (the PIL scripts' look): a soft drop shadow 6 px blurred, 4 px down, 45% black.
const SHADOW = { color: '#000000', blur: 6, offset_y: 4, opacity: 0.45 };

const withAlpha = (hex, opacity) => {
  const h = hex.slice(1);
  const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h;
  const a = full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1;
  return `#${full.slice(0, 6)}${Math.round(Math.max(0, Math.min(1, a * opacity)) * 255).toString(16).padStart(2, '0')}`;
};

function fillStyle(ctx, { fill, gradient }, top, bottom, what) {
  if (gradient) {
    if (!Array.isArray(gradient) || gradient.length < 2) throw Error(`INVALID_GRADIENT(${what}): give at least two colours, top to bottom`);
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    gradient.forEach((c, i) => g.addColorStop(i / (gradient.length - 1), checkColor(c, `${what}.gradient`)));
    return g;
  }
  return checkColor(fill ?? '#ffffff', `${what}.fill`);
}

function measure(spec) {
  const size = spec.size;
  const ctx = createCanvas(1, 1).getContext('2d');
  ctx.font = `${size}px "${family(spec.font)}"`;
  // Lines are drawn centred, so the ink box is measured from the centre: a glyph whose ink sits off the
  // middle of its advance (a full-width ！) would otherwise be clipped.
  ctx.textAlign = 'center';
  const lines = String(spec.text).split('\n');
  const step = size * (spec.line_height ?? 1.25);
  const metrics = lines.map((line) => ctx.measureText(line || ' '));
  const left = Math.max(...metrics.map((m) => m.actualBoundingBoxLeft));
  const right = Math.max(...metrics.map((m) => m.actualBoundingBoxRight));
  const ascent = Math.max(...metrics.map((m) => m.actualBoundingBoxAscent));
  const descent = Math.max(...metrics.map((m) => m.actualBoundingBoxDescent));
  return { lines, metrics, step, left, right, width: left + right, ascent, descent, height: ascent + descent + step * (lines.length - 1) };
}

// Draws the lines centred on cx with the first baseline at y0; used by text images and panels alike.
function drawLines(ctx, spec, m, cx, y0, what) {
  ctx.font = `${spec.size}px "${family(spec.font)}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  const fill = fillStyle(ctx, spec, y0 - m.ascent, y0 - m.ascent + m.height, what);
  const stroke = spec.stroke ? { color: checkColor(spec.stroke.color, `${what}.stroke.color`), width: spec.stroke.width } : null;
  const shadow = spec.shadow ? { ...SHADOW, ...spec.shadow } : null;
  m.lines.forEach((line, i) => {
    const y = y0 + i * m.step;
    if (shadow) {
      ctx.save();
      ctx.shadowColor = withAlpha(checkColor(shadow.color, `${what}.shadow.color`), shadow.opacity);
      ctx.shadowBlur = shadow.blur;
      ctx.shadowOffsetY = shadow.offset_y;
      if (stroke) {
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width * 2;
        ctx.strokeText(line, cx, y);
      } else {
        ctx.fillStyle = fill;
        ctx.fillText(line, cx, y);
      }
      ctx.restore();
    }
    if (stroke) {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width * 2;
      ctx.strokeText(line, cx, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(line, cx, y);
  });
}

const shadowRoom = (shadow) => (shadow ? Math.ceil((shadow.blur ?? SHADOW.blur) * 2 + Math.abs(shadow.offset_y ?? SHADOW.offset_y)) : 0);

// A transparent PNG sized to the text plus its outline, shadow and padding.
export function textCanvas(spec, what = 'text') {
  const m = measure(spec);
  const margin = (spec.stroke ? spec.stroke.width : 0) + shadowRoom(spec.shadow) + (spec.padding ?? 4);
  const w = Math.ceil(m.width + margin * 2);
  const h = Math.ceil(m.height + margin * 2);
  const canvas = createCanvas(w, h);
  drawLines(canvas.getContext('2d'), spec, m, margin + m.left, margin + m.ascent, what);
  return canvas;
}

function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// A rounded (or pill) plate with optional centred lines of text; without width / height it fits the lines.
export function panelCanvas(spec, what = 'panel') {
  const pad = spec.padding ?? 24;
  const lines = (spec.lines || []).map((l) => ({ spec: l, m: measure(l) }));
  if (!lines.length && (spec.width === undefined || spec.height === undefined)) throw Error(`INVALID_PANEL_SIZE(${what}): give width and height, or lines to fit`);
  const textW = lines.length ? Math.max(...lines.map((l) => l.m.width)) : 0;
  const gap = spec.line_gap ?? 8;
  const textH = lines.reduce((s, l) => s + l.m.height, 0) + gap * Math.max(0, lines.length - 1);
  const w = spec.width ?? Math.ceil(textW + pad * 2);
  const h = spec.height ?? Math.ceil(textH + pad * 2);
  if (!(w > 0 && h > 0)) throw Error(`INVALID_PANEL_SIZE(${what}): give width and height, or lines to fit`);
  const room = shadowRoom(spec.shadow);
  const canvas = createCanvas(w + room * 2, h + room * 2);
  const ctx = canvas.getContext('2d');
  const r = spec.radius === 'pill' ? h / 2 : spec.radius ?? 24;
  const sw = spec.stroke ? spec.stroke.width : 0;
  roundedRect(ctx, room + sw / 2, room + sw / 2, w - sw, h - sw, r - sw / 2);
  ctx.save();
  if (spec.shadow) {
    const s = { ...SHADOW, ...spec.shadow };
    ctx.shadowColor = withAlpha(checkColor(s.color, `${what}.shadow.color`), s.opacity);
    ctx.shadowBlur = s.blur;
    ctx.shadowOffsetY = s.offset_y;
  }
  ctx.fillStyle = fillStyle(ctx, spec, room, room + h, what);
  ctx.fill();
  ctx.restore();
  if (spec.stroke) {
    ctx.strokeStyle = checkColor(spec.stroke.color, `${what}.stroke.color`);
    ctx.lineWidth = sw;
    ctx.stroke();
  }
  let y = room + (h - textH) / 2;
  lines.forEach(({ spec: l, m }, i) => {
    drawLines(ctx, l, m, room + w / 2 + (m.left - m.right) / 2, y + m.ascent, `${what}.lines[${i}]`);
    y += m.height + gap;
  });
  return canvas;
}

export async function readImage(file) {
  if (!path.isAbsolute(file) || !fs.existsSync(file)) throw Error(`IMAGE_NOT_FOUND: ${file}`);
  try {
    return await loadImage(fs.readFileSync(file));
  } catch (e) {
    throw Error(`NOT_AN_IMAGE: ${file}: ${e.message}`);
  }
}

// Picked: as wide as the caption may get (86% of the icon) and how far it keeps from the edge (3%).
const CAPTION_MAX_WIDTH = 0.86;
const CAPTION_MARGIN = 0.03;

// A square cut out of a preview frame, a caption on it, scaled to `size`. `crop` is { top } for a square
// as wide as the frame, or { x, y, size }, in the frame's own pixels. Caption sizes are in output pixels.
export async function iconCanvas({ frame, crop, caption }, size) {
  const img = await readImage(frame);
  const side = crop.size ?? img.width;
  const x = crop.x ?? 0;
  const y = crop.top ?? crop.y;
  if (!(side > 0) || x < 0 || y < 0 || x + side > img.width || y + side > img.height) {
    throw Error(`CROP_OUT_OF_FRAME: ${side}×${side} at (${x}, ${y}) does not fit the ${img.width}×${img.height} frame ${path.basename(frame)}`);
  }
  const square = createCanvas(side, side);
  const sq = square.getContext('2d');
  sq.drawImage(img, x, y, side, side, 0, 0, side, side);
  let captionScaled = null;
  if (caption) {
    const k = side / size;
    const scaled = { ...caption, size: caption.size * k, stroke: caption.stroke && { ...caption.stroke, width: caption.stroke.width * k }, shadow: caption.shadow && { ...SHADOW, ...caption.shadow, blur: (caption.shadow.blur ?? SHADOW.blur) * k, offset_y: (caption.shadow.offset_y ?? SHADOW.offset_y) * k } };
    let text = textCanvas(scaled, 'caption');
    const fit = Math.min(1, (side * (caption.max_width ?? CAPTION_MAX_WIDTH)) / text.width);
    const tw = Math.round(text.width * fit);
    const th = Math.round(text.height * fit);
    const margin = side * CAPTION_MARGIN;
    const pos = caption.position ?? 'bottom';
    const ty = pos === 'top' ? margin : pos === 'bottom' ? side - th - margin : pos * side - th / 2;
    sq.drawImage(text, (side - tw) / 2, ty, tw, th);
    captionScaled = fit < 1 ? Number(fit.toFixed(3)) : null;
  }
  const out = createCanvas(size, size);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(square, 0, 0, size, size);
  return { canvas: out, source: { width: img.width, height: img.height }, crop: { x, y, size: side }, caption_shrunk_to: captionScaled };
}

export function scaled(canvas, size) {
  const out = createCanvas(size, size);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, size, size);
  return out;
}

// Icons side by side at the size the effect list shows them, with other images (centre-cropped square) after them.
export async function sheetCanvas(icons, others, tile) {
  const all = [...icons];
  for (const file of others) {
    const img = await readImage(file);
    const side = Math.min(img.width, img.height);
    const c = createCanvas(tile, tile);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, tile, tile);
    all.push(c);
  }
  const gap = 8;
  const sheet = createCanvas(all.length * tile + (all.length + 1) * gap, tile + gap * 2);
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.imageSmoothingQuality = 'high';
  all.forEach((c, i) => ctx.drawImage(c, gap + i * (tile + gap), gap, tile, tile));
  return sheet;
}

// The image editor's mark for 消除 / 重绘 (useEraserInpaintCommon): over the marked area a checkerboard of
// green (#00ff00) cells alternating between alpha 0xc0 and 0x48. Its cells are 12 screen pixels in the
// editor's view; the view's size is not known here, so 12 px per 600 px of the image's longer side is picked.
export const MARK_COLORS = ['#00ff00c0', '#00ff0048'];
export function markCell(width, height) {
  return Math.max(8, Math.round((12 * Math.max(width, height)) / 600));
}

// `mask` is an image whose bright opaque pixels mark the area (scaled to the source); `boxes` are
// { x, y, width, height } fractions of the source. Returns the marked image and how much of it is marked.
export async function markedCanvas(file, { mask, boxes = [] }) {
  const img = await readImage(file);
  const { width: w, height: h } = img;
  const area = createCanvas(w, h);
  const actx = area.getContext('2d');
  if (mask) {
    const m = await readImage(mask);
    const tmp = createCanvas(w, h);
    const tctx = tmp.getContext('2d');
    tctx.drawImage(m, 0, 0, w, h);
    const data = tctx.getImageData(0, 0, w, h);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const on = ((px[i] + px[i + 1] + px[i + 2]) / 3) * (px[i + 3] / 255) > 127;
      px[i] = px[i + 1] = px[i + 2] = 255;
      px[i + 3] = on ? 255 : 0;
    }
    actx.putImageData(data, 0, 0);
  }
  actx.fillStyle = '#ffffff';
  for (const b of boxes) actx.fillRect(Math.round(b.x * w), Math.round(b.y * h), Math.round(b.width * w), Math.round(b.height * h));
  let marked = 0;
  const alpha = actx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < alpha.length; i += 4) if (alpha[i] > 0) marked++;
  if (!marked) throw Error('EMPTY_MARK: the mask / boxes mark no pixel of the image');
  const cell = markCell(w, h);
  const checker = createCanvas(w, h);
  const cctx = checker.getContext('2d');
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      cctx.fillStyle = MARK_COLORS[(Math.floor(x / cell) + Math.floor(y / cell)) & 1];
      cctx.fillRect(x, y, cell, cell);
    }
  }
  // source-in clears whatever the drawn source does not cover, so the checkerboard goes on in one draw.
  actx.globalCompositeOperation = 'source-in';
  actx.drawImage(checker, 0, 0);
  const out = createCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.drawImage(img, 0, 0);
  ctx.drawImage(area, 0, 0);
  return { canvas: out, marked_ratio: Number((marked / (w * h)).toFixed(4)) };
}

export const png = (canvas) => canvas.encode('png');
export const jpeg = (canvas) => canvas.encode('jpeg', 90);

// A JPEG of an image file scaled so its longer side is at most maxSide, for showing it in an answer.
export async function previewJpeg(file, maxSide = 720) {
  const img = await readImage(file);
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = createCanvas(Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return jpeg(c);
}
