// Multi-image contact sheets, PNG alpha trim, and resize — replaces the one-off PIL scripts agents
// used to run in the terminal. Built on @napi-rs/canvas + pngjs (no new deps).
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PNG } from 'pngjs';
import { imageMetaFromPng } from './mediainfo.mjs';

const MAX_ITEMS = 24;

function pickColumns(n, columns) {
  if (columns) return Math.max(1, Math.min(columns, n));
  if (n <= 2) return n;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

export function trimAlphaPng(buf) {
  const meta = imageMetaFromPng(buf);
  if (!meta.alpha_bbox) return { buf, before: { width: meta.width, height: meta.height }, after: { width: meta.width, height: meta.height }, opaque_ratio: 0, trimmed: false };
  const img = PNG.sync.read(buf);
  const { x, y, width, height } = meta.alpha_bbox;
  const out = new PNG({ width, height });
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const si = ((y + row) * img.width + (x + col)) * 4;
      const di = (row * width + col) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = img.data[si + 3];
    }
  }
  return {
    buf: PNG.sync.write(out),
    before: { width: meta.width, height: meta.height },
    after: { width, height },
    opaque_ratio: meta.opaque_ratio,
    trimmed: width !== meta.width || height !== meta.height,
  };
}

async function loadTile(srcBuf, crop) {
  let buf = srcBuf;
  if (crop) {
    const img = await loadImage(buf);
    const x = Math.round(crop.x * img.width);
    const y = Math.round(crop.y * img.height);
    const w = Math.max(1, Math.min(img.width - x, Math.round(crop.width * img.width)));
    const h = Math.max(1, Math.min(img.height - y, Math.round(crop.height * img.height)));
    const c = createCanvas(w, h);
    c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
    buf = c.toBuffer('image/png');
  }
  return loadImage(buf);
}

export async function buildImageSheet({ items, columns, tile_height = 360, trim_alpha = false, resize, save_to }) {
  if (!items?.length) throw Error('IMAGE_SHEET_EMPTY');
  if (items.length > MAX_ITEMS) throw Error(`IMAGE_SHEET_TOO_MANY: ${items.length} > ${MAX_ITEMS}`);
  const prepared = [];
  const trimInfo = [];
  for (const [i, item] of items.entries()) {
    let buf = item.buf;
    if (!buf) throw Error(`IMAGE_SHEET_ITEM_EMPTY: #${i}`);
    if (trim_alpha) {
      const t = trimAlphaPng(buf);
      buf = t.buf;
      trimInfo.push({ index: i, label: item.label ?? null, ...t, buf: undefined });
    }
    const img = await loadTile(buf, item.crop);
    prepared.push({ img, label: item.label });
  }
  const cols = pickColumns(prepared.length, columns);
  const rows = Math.ceil(prepared.length / cols);
  const scales = prepared.map(({ img }) => tile_height / img.height);
  const tileWidths = prepared.map(({ img }, i) => Math.max(1, Math.round(img.width * scales[i])));
  const colW = Array.from({ length: cols }, (_, c) => Math.max(0, ...prepared.map((_, i) => (i % cols === c ? tileWidths[i] : 0))));
  const width = colW.reduce((a, b) => a + b, 0);
  const height = rows * tile_height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1b1b1b';
  ctx.fillRect(0, 0, width, height);
  prepared.forEach(({ img, label }, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = colW.slice(0, c).reduce((a, b) => a + b, 0);
    const y = r * tile_height;
    const tw = tileWidths[i];
    const th = tile_height;
    ctx.drawImage(img, x + (colW[c] - tw) / 2, y, tw, th);
    if (label) {
      ctx.font = 'bold 16px sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#000';
      ctx.fillStyle = '#fff';
      ctx.strokeText(label, x + 8, y + 22);
      ctx.fillText(label, x + 8, y + 22);
    }
  });
  let outBuf = canvas.toBuffer('image/png');
  let outSize = { width: canvas.width, height: canvas.height };
  if (resize) {
    const r = createCanvas(resize.width, resize.height);
    r.getContext('2d').drawImage(await loadImage(outBuf), 0, 0, resize.width, resize.height);
    outBuf = r.toBuffer('image/png');
    outSize = { width: resize.width, height: resize.height };
  }
  if (save_to) {
    if (!path.isAbsolute(save_to)) throw Error(`SAVE_TO_NOT_ABSOLUTE: ${save_to}`);
    fs.mkdirSync(path.dirname(save_to), { recursive: true });
    fs.writeFileSync(save_to, outBuf);
  }
  return {
    png: outBuf,
    size: outSize,
    columns: cols,
    tile_height,
    trim: trim_alpha ? trimInfo.map(({ index, label, before, after, opaque_ratio, trimmed }) => ({ index, label, before, after, opaque_ratio, trimmed })) : undefined,
    save_to: save_to || undefined,
  };
}
