import test from 'node:test';
import './tmp.mjs';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { frameDiff, regionStats, sideBySide } from '../src/measure.mjs';
import { decodeUv, encodeUv } from '../src/calib.mjs';

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

test('decodeUv refuses frames where the calibration texture does not show or shows one eye only', () => {
  const tex = PNG.sync.read(encodeUv('eye'));
  const bare = frame(120, 60, () => [150, 120, 110]);
  // A filter that tints everything moves B off 128: nothing decodes.
  const tinted = frame(120, 60, (x, y) => {
    const i = ((170 + y * 2) * 900 + 150 + x * 2) * 4;
    return [tex.data[i], tex.data[i + 1], Math.round(tex.data[i + 2] * 0.8)];
  });
  assert.throws(() => decodeUv('eye', tinted, bare), /CALIBRATION_NOT_VISIBLE: only 0 frame pixels/);
  const one = frame(120, 60, (x, y) => {
    const i = ((170 + y * 2) * 900 + 150 + x * 2) * 4;
    return [tex.data[i], tex.data[i + 1], tex.data[i + 2]];
  });
  assert.throws(() => decodeUv('eye', one, bare), /CALIBRATION_ONE_EYE/);
  assert.throws(() => decodeUv('eye', one, frame(10, 10, () => [0, 0, 0])), /FRAME_SIZE_MISMATCH/);
});

test('decodeUv fits the mapping on pixels away from strong edges, where JPEG errors pile up', () => {
  const tex = PNG.sync.read(encodeUv('eye'));
  const W = 240;
  const H = 120;
  // Left eye: frame (20–100, 30–90) → texture x 120–360, y 200–290; right eye mirrored.
  const truth = (u, v) => {
    if (u >= 20 && u < 100 && v >= 30 && v < 90) return [120 + 3 * (u + 0.5 - 20), 200 + 1.5 * (v + 0.5 - 30)];
    if (u >= 140 && u < 220 && v >= 30 && v < 90) return [899 - (120 + 3 * (220 - (u + 0.5))), 200 + 1.5 * (v + 0.5 - 30)];
    return null;
  };
  // A dark lash line across both eyes in the bare frame; next to it the coded colours are off, as
  // JPEG leaves them around high-contrast edges.
  const line = (v) => v >= 50 && v < 53;
  const near = (v) => v >= 47 && v < 56;
  const bare = frame(W, H, (u, v) => (truth(u, v) && line(v) ? [30, 25, 25] : [150, 120, 110]));
  const coded = frame(W, H, (u, v) => {
    const t = truth(u, v);
    if (!t) return [150, 120, 110];
    const i = (Math.floor(t[1]) * 900 + Math.floor(t[0])) * 4;
    const off = near(v) ? 40 : 0;
    return [Math.min(255, tex.data[i] + off), Math.max(0, tex.data[i + 1] - off), tex.data[i + 2]];
  });
  for (const p of decodeUv('eye', coded, bare)) {
    let worst = 0;
    for (let i = 0; i < W * H; i++) {
      if (!Number.isFinite(p.tx[i])) continue;
      const t = truth(i % W, Math.floor(i / W));
      worst = Math.max(worst, Math.abs(p.tx[i] - t[0]), Math.abs(p.ty[i] - t[1]));
    }
    assert.ok(worst < 1.5, `${p.eye}: off by ${worst.toFixed(2)} texture px`);
  }
});
