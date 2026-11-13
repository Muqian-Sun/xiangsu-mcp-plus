// Shared by the drawing tests: a font that exists on every test machine and a frame with known colours.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

// A subset of Noto Sans SC (SIL OFL, see NotoSansSC-OFL.txt) with only the characters the tests draw.
export const FONT = fileURLToPath(new URL('./fixtures/NotoSansSC-subset.ttf', import.meta.url));

// A 720×1280 frame: red top half, blue bottom half, a white square at (100, 700) 50 px wide.
export async function frameFile(dir, name = 'frame.png') {
  const c = createCanvas(720, 1280);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 720, 640);
  ctx.fillStyle = '#0000ff';
  ctx.fillRect(0, 640, 720, 640);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(100, 700, 50, 50);
  const file = path.join(dir, name);
  fs.writeFileSync(file, await c.encode('png'));
  return file;
}
