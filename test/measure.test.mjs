import test from 'node:test';
import './tmp.mjs';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { frameDiff, regionStats, sideBySide } from '../src/measure.mjs';

function frame(w, h, at) {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set([...at(x, y), 255], (y * w + x) * 4);
  return img;
}
const ALL = { x: 0, y: 0, width: 1, height: 1 };

test('regionStats gives mean colour, luma and a detail figure that is 0 on flat skin and grows with texture', () => {
  const flat = regionStats(frame(40, 40, () => [200, 150, 140]), ALL);
  assert.deepEqual([flat.rgb, flat.hsl, flat.luma, flat.detail, flat.pixels], [[200, 150, 140], [10, 35, 67], 163.8, 0, [40, 40]]);
  const fine = regionStats(frame(40, 40, (x, y) => ((x + y) % 2 ? [210, 160, 150] : [190, 140, 130])), ALL);
  const coarse = regionStats(frame(40, 40, (x, y) => ((x + y) % 2 ? [230, 180, 170] : [170, 120, 110])), ALL);
  assert.ok(fine.detail > 5 && coarse.detail > fine.detail * 2.5, `${fine.detail} ${coarse.detail}`);
  // A box in fractions of the frame: only the right half.
  const half = regionStats(frame(40, 40, (x) => (x < 20 ? [0, 0, 0] : [100, 100, 100])), { x: 0.5, y: 0, width: 0.5, height: 1 });
  assert.deepEqual([half.rgb, half.pixels], [[100, 100, 100], [20, 40]]);
});

test('frameDiff reports the mean and largest luma change in a box; sideBySide replicates pixels without smoothing', () => {
  const a = frame(10, 10, () => [100, 100, 100]);
  const b = frame(10, 10, (x, y) => (x === 9 && y === 9 ? [150, 150, 150] : [100, 100, 100]));
  assert.deepEqual(frameDiff(a, b, ALL), { mean: 0.5, max: 50 });
  assert.deepEqual(frameDiff(a, b, { x: 0, y: 0, width: 0.5, height: 0.5 }), { mean: 0, max: 0 });
  const box = { x: 0.8, y: 0.8, width: 0.2, height: 0.2 };
  const strip = PNG.sync.read(sideBySide([{ img: a, box }, { img: b, box }], 4));
  assert.deepEqual([strip.width, strip.height], [2 * 8 + 2, 8]);
  // The changed pixel (9, 9) of b fills a 4×4 block at the bottom right of the second tile, untouched by its neighbours.
  const at = (x, y) => strip.data[(y * strip.width + x) * 4];
  assert.deepEqual([at(10 + 4, 4), at(10 + 7, 7), at(10 + 3, 4), at(9, 0)], [150, 150, 100, 255]);
});

test('sideBySide wraps tiles so a strip stays within 1024 px wide', () => {
  const img = frame(100, 20, () => [10, 20, 30]);
  const box = { x: 0, y: 0, width: 1, height: 1 };
  // Three 400-wide tiles at zoom 4 would be 1208 px in one row; they wrap to two rows of one and two.
  const tiles = Array.from({ length: 3 }, () => ({ img, box }));
  const strip = PNG.sync.read(sideBySide(tiles, 4));
  assert.deepEqual([strip.width, strip.height], [2 * 400 + 2, 2 * 80 + 2]);
});
