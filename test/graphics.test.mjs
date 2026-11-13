import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { MARK_COLORS, checkColor, iconCanvas, markCell, markedCanvas, panelCanvas, sheetCanvas, textCanvas } from '../src/graphics.mjs';
import { FONT, frameFile } from './drawing.mjs';

const pixel = (canvas, x, y) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];

test('text images fit the text, its outline and shadow, and draw fill, gradient and outline colours', () => {
  const plain = textCanvas({ text: '测试', font: FONT, size: 80, padding: 0 });
  const outlined = textCanvas({ text: '测试', font: FONT, size: 80, padding: 0, stroke: { color: '#000000', width: 8 } });
  assert.equal(outlined.width - plain.width, 16, 'the outline widens both sides');
  const shadowed = textCanvas({ text: '测试', font: FONT, size: 80, padding: 0, shadow: {} });
  assert.equal(shadowed.height - plain.height, (6 * 2 + 4) * 2, 'room for blur and offset on each side');
  const two = textCanvas({ text: '测试\n测试', font: FONT, size: 80, padding: 0 });
  assert.equal(two.height - plain.height, 100, 'a second line adds one line height (1.25 × size)');

  const red = textCanvas({ text: 'A', font: FONT, size: 120, padding: 0, fill: '#ff0000' });
  const ctx = red.getContext('2d');
  const data = ctx.getImageData(0, 0, red.width, red.height).data;
  let opaque = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 255) (opaque++, assert.deepEqual([data[i], data[i + 1], data[i + 2]], [255, 0, 0]));
  assert.ok(opaque > 100, 'the glyph is filled red');

  const grad = textCanvas({ text: '测', font: FONT, size: 200, padding: 0, gradient: ['#ff0000', '#0000ff'] });
  const col = (y) => {
    const d = grad.getContext('2d').getImageData(0, y, grad.width, 1).data;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255) return [d[i], d[i + 2]];
    return null;
  };
  const top = col(Math.round(grad.height * 0.15));
  const bottom = col(Math.round(grad.height * 0.85));
  assert.ok(top[0] > top[1] && bottom[1] > bottom[0], `red at the top, blue at the bottom: ${top} / ${bottom}`);

  // A full-width ！ has its ink left of its advance's middle; the ink box, not the advance, sets the canvas.
  const bang = textCanvas({ text: '提示！', font: FONT, size: 100, padding: 4 });
  const ink = bang.getContext('2d').getImageData(0, 0, bang.width, bang.height).data;
  let minX = Infinity;
  let maxX = -1;
  for (let i = 3; i < ink.length; i += 4) {
    if (ink[i] < 128) continue;
    const x = ((i - 3) / 4) % bang.width;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  }
  assert.ok(minX >= 3 && minX <= 6, `ink starts at x=${minX}, inside the 4 px padding`);
  assert.ok(maxX <= bang.width - 4 && maxX >= bang.width - 7, `ink ends at x=${maxX} of ${bang.width}`);

  assert.throws(() => textCanvas({ text: 'A', font: FONT, size: 20, fill: 'red' }), /INVALID_COLOR\(text\.fill\): red/);
  assert.throws(() => checkColor('#12345', 'x'), /INVALID_COLOR/);
  assert.throws(() => textCanvas({ text: 'A', font: '/nope.ttf', size: 20 }), /FONT_NOT_FOUND: \/nope\.ttf/);
  assert.throws(() => textCanvas({ text: 'A', font: 'douyinti', size: 20 }), /FONT_NOT_FOUND: douyinti; built-in fonts: \(none: 像塑 not installed\?\)/);
});

test('panels fit their lines or take a given size, with pill ends and the fill colour', () => {
  const fit = panelCanvas({ padding: 20, lines: [{ text: '双手入镜', font: FONT, size: 40 }] });
  const line = textCanvas({ text: '双手入镜', font: FONT, size: 40, padding: 0 });
  assert.ok(Math.abs(fit.width - (line.width + 40)) <= 2, `width ${fit.width} ≈ text ${line.width} + 2 × padding`);
  const pill = panelCanvas({ width: 300, height: 80, radius: 'pill', fill: '#00ff00' });
  assert.deepEqual([pill.width, pill.height], [300, 80]);
  assert.deepEqual(pixel(pill, 150, 40), [0, 255, 0, 255], 'filled in the middle');
  assert.equal(pixel(pill, 2, 2)[3], 0, 'the round end leaves the corner empty');
  const square = panelCanvas({ width: 300, height: 80, radius: 0, fill: '#00ff00' });
  assert.equal(pixel(square, 1, 1)[3], 255, 'radius 0 fills the corner');
  const shadowed = panelCanvas({ width: 300, height: 80, shadow: {} });
  assert.deepEqual([shadowed.width, shadowed.height], [300 + 32, 80 + 32]);
  assert.throws(() => panelCanvas({}), /INVALID_PANEL_SIZE/);
});

test('icons are the asked square of the frame, scaled, with the caption shrunk to fit', async () => {
  const dir = tmpdir('xs-gfx-');
  const frame = await frameFile(dir);
  const top = await iconCanvas({ frame, crop: { top: 0 } }, 360);
  assert.deepEqual([top.canvas.width, top.canvas.height, top.crop.size], [360, 360, 720]);
  assert.deepEqual(pixel(top.canvas, 180, 100), [255, 0, 0, 255]);
  const low = await iconCanvas({ frame, crop: { top: 560 } }, 360);
  assert.deepEqual(pixel(low.canvas, 180, 300), [0, 0, 255, 255], 'from the blue half');
  assert.deepEqual(pixel(low.canvas, 180, 20), [255, 0, 0, 255], 'the red half above 640 is in its top band');
  // The white square at (100, 700) lands at ((100 - 80) / 2, (700 - 680) / 2) in a 200 px crop scaled to 100.
  const sq = await iconCanvas({ frame, crop: { x: 80, y: 680, size: 200 } }, 100);
  assert.deepEqual(pixel(sq.canvas, 20, 20), [255, 255, 255, 255]);
  assert.deepEqual(pixel(sq.canvas, 60, 60), [0, 0, 255, 255]);
  await assert.rejects(iconCanvas({ frame, crop: { top: 700 } }, 360), /CROP_OUT_OF_FRAME: 720×720 at \(0, 700\) does not fit the 720×1280 frame frame\.png/);

  const caption = { text: '测试字幕', font: FONT, size: 60, fill: '#ffff00', position: 'top' };
  const withCaption = await iconCanvas({ frame, crop: { top: 0 }, caption }, 360);
  assert.equal(withCaption.caption_shrunk_to, null);
  const ctx = withCaption.canvas.getContext('2d');
  const band = ctx.getImageData(0, 0, 360, 60).data;
  let yellow = 0;
  for (let i = 0; i < band.length; i += 4) if (band[i] > 200 && band[i + 1] > 200 && band[i + 2] < 60) yellow++;
  assert.ok(yellow > 200, `caption drawn in the top band (${yellow} yellow pixels)`);
  const lower = ctx.getImageData(0, 200, 360, 160).data;
  for (let i = 0; i < lower.length; i += 4) assert.ok(!(lower[i + 1] > 200 && lower[i + 2] < 60), 'nothing yellow below it');
  const long = await iconCanvas({ frame, crop: { top: 0 }, caption: { ...caption, text: '测试字幕测试字幕测试字幕测试字幕' } }, 360);
  assert.ok(long.caption_shrunk_to > 0 && long.caption_shrunk_to < 1, `shrunk to ${long.caption_shrunk_to}`);
});

test('the repaint mark is the image editor checkerboard over the marked area only', async () => {
  const dir = tmpdir('xs-gfx-');
  const frame = await frameFile(dir);
  const cell = markCell(720, 1280);
  assert.equal(cell, Math.round((12 * 1280) / 600));
  const { canvas, marked_ratio } = await markedCanvas(frame, { boxes: [{ x: 0.5, y: 0.5, width: 0.25, height: 0.125 }] });
  assert.equal(marked_ratio, Number(((180 * 160) / (720 * 1280)).toFixed(4)));
  assert.deepEqual(pixel(canvas, 100, 100), [255, 0, 0, 255], 'outside the box the image is untouched');
  assert.deepEqual(pixel(canvas, 600, 900), [0, 0, 255, 255]);
  assert.deepEqual(pixel(canvas, 300, 700), [0, 0, 255, 255], 'left of the box');
  // Over blue, green at alpha a gives (0, 255a, 255(1 - a)); neighbouring cells alternate 0xc0 and 0x48.
  const alpha = MARK_COLORS.map((c) => parseInt(c.slice(7), 16) / 255);
  const greens = [];
  for (let x = 360 + cell / 2; x < 540; x += cell) greens.push(pixel(canvas, Math.floor(x), 700 + Math.floor(cell / 2)));
  assert.ok(greens.length >= 4);
  const startCell = Math.floor(360 / cell) + Math.floor(700 / cell);
  greens.forEach((p, i) => {
    const a = alpha[(startCell + i) & 1];
    assert.ok(Math.abs(p[1] - 255 * a) <= 2 && Math.abs(p[2] - 255 * (1 - a)) <= 2, `cell ${i}: ${p} for alpha ${a.toFixed(2)}`);
  });

  const mask = createCanvas(72, 128);
  const m = mask.getContext('2d');
  m.fillStyle = '#000000';
  m.fillRect(0, 0, 72, 128);
  m.fillStyle = '#ffffff';
  m.fillRect(0, 0, 36, 128);
  const maskFile = path.join(dir, 'mask.png');
  fs.writeFileSync(maskFile, await mask.encode('png'));
  const byMask = await markedCanvas(frame, { mask: maskFile });
  assert.equal(byMask.marked_ratio, 0.5);
  assert.notDeepEqual(pixel(byMask.canvas, 100, 100), [255, 0, 0, 255]);
  assert.deepEqual(pixel(byMask.canvas, 600, 100), [255, 0, 0, 255]);
  const black = createCanvas(10, 10);
  black.getContext('2d').fillRect(0, 0, 10, 10);
  fs.writeFileSync(path.join(dir, 'black.png'), await black.encode('png'));
  await assert.rejects(markedCanvas(frame, { mask: path.join(dir, 'black.png') }), /EMPTY_MARK/);
});

test('the comparison sheet puts the icons and the other images side by side at list size', async () => {
  const dir = tmpdir('xs-gfx-');
  const frame = await frameFile(dir);
  const icon = (await iconCanvas({ frame, crop: { top: 0 } }, 160)).canvas;
  const sheet = await sheetCanvas([icon], [frame], 160);
  assert.deepEqual([sheet.width, sheet.height], [8 + 160 + 8 + 160 + 8, 176]);
  assert.deepEqual(pixel(sheet, 8 + 80, 8 + 80), [255, 0, 0, 255]);
  // The frame is centre-cropped to its middle square (y 280–1000): the red/blue edge at 640 is at 50%.
  const img = await loadImage(await sheet.encode('png'));
  assert.equal(img.width, sheet.width);
  assert.deepEqual(pixel(sheet, 176 + 80, 8 + 40), [255, 0, 0, 255]);
  assert.deepEqual(pixel(sheet, 176 + 80, 8 + 120), [0, 0, 255, 255]);
});
