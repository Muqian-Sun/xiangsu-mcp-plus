import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { fitArc, paint, smoothLine, withTail, writeTexture } from '../src/paint.mjs';

const W = { face: 1024, eye: 900, lips: 460 };
const px = (p, x, y) => {
  const i = (y * p.width + x) * 4;
  return [...p.data.subarray(i, i + 4)];
};
const alpha = (p, x, y) => px(p, x, y)[3];
const one = (shape, layer = {}) => ({ color: '#FF0000', ...layer, shapes: [shape] });

test('paint lays out face, eye and lips textures at their sizes and refuses an empty one', () => {
  for (const layout of ['face', 'eye', 'lips']) {
    const p = paint({ layout, blend: 'normal', layers: [one({ type: 'spot', x: 50, y: 50, rx: 4 })] });
    assert.deepEqual([p.width, p.data.length / 4 / p.width], [W[layout], { face: 1024, eye: 460, lips: 230 }[layout]]);
  }
  assert.throws(() => paint({ layout: 'eye', blend: 'normal', layers: [one({ type: 'spot', x: -500, y: -500, rx: 2 })] }), /TEXTURE_EMPTY/);
  assert.throws(() => paint({ layout: 'cheek', blend: 'normal', layers: [] }), /INVALID_LAYOUT/);
});

test('a spot peaks at its centre and fades as a gaussian; a stroke tapers from start radius to end radius', () => {
  const p = paint({ layout: 'eye', blend: 'normal', layers: [one({ type: 'spot', x: 100.5, y: 100.5, rx: 4, peak: 0.8 })] });
  assert.equal(alpha(p, 100, 100), 204);
  // exp(-0.5 · (4/4)²) of the peak, one σ away.
  assert.equal(alpha(p, 104, 100), Math.round(204 * Math.exp(-0.5)));
  assert.equal(alpha(p, 120, 100), 0);
  const s = paint({ layout: 'eye', blend: 'normal', layers: [one({ type: 'stroke', points: [[100, 200], [300, 200]], radius: [6, 1] })] });
  const thick = (x) => Array.from({ length: 40 }, (_, k) => alpha(s, x, 180 + k)).filter((a) => a > 127).length;
  assert.deepEqual([thick(110), thick(290)], [12, 2]);
});

test('bands and polygons fill with anti-aliased edges', () => {
  const p = paint({ layout: 'eye', blend: 'normal', layers: [one({ type: 'band', top: [[100, 100], [200, 100]], bottom: [[100, 110.5], [200, 110.5]] })] });
  assert.deepEqual([alpha(p, 150, 99), alpha(p, 150, 100), alpha(p, 150, 109), alpha(p, 150, 110), alpha(p, 150, 111)], [0, 255, 255, 128, 0]);
});

test('mirror copies a shape onto the other half pixel for pixel, and mirror_dy moves only the copy down', () => {
  const layers = [one({ type: 'scatter', x: 200, y: 200, rx: 60, count: 12, radius: [1, 2], seed: 3, mirror: true })];
  const p = paint({ layout: 'eye', blend: 'normal', layers });
  for (let y = 120; y < 280; y++) for (let x = 120; x < 280; x++) assert.equal(alpha(p, 899 - x, y), alpha(p, x, y));
  const shifted = paint({ layout: 'eye', blend: 'normal', mirror_dy: 3, layers });
  for (let y = 120; y < 280; y++) {
    for (let x = 120; x < 280; x++) {
      assert.equal(alpha(shifted, x, y), alpha(p, x, y));
      assert.equal(alpha(shifted, 899 - x, y + 3), alpha(p, x, y));
    }
  }
});

test('transparent pixels carry the colour that leaves the skin unchanged under the chosen blend mode', () => {
  const layers = [one({ type: 'spot', x: 450, y: 230, rx: 5 }, { color: '#3366CC' })];
  assert.deepEqual(px(paint({ layout: 'eye', blend: 'multiply', layers }), 0, 0), [255, 255, 255, 0]);
  assert.deepEqual(px(paint({ layout: 'eye', blend: 'screen', layers }), 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(px(paint({ layout: 'eye', blend: 'soft_light', layers }), 0, 0), [128, 128, 128, 0]);
  // Normal blend: the nearest painted colour, so edge filtering never mixes in another one.
  const two = [one({ type: 'spot', x: 100, y: 230, rx: 3 }, { color: '#3366CC' }), one({ type: 'spot', x: 800, y: 230, rx: 3 }, { color: '#CC3300' })];
  const n = paint({ layout: 'eye', blend: 'normal', layers: two });
  assert.deepEqual([px(n, 0, 0), px(n, 899, 459)], [[51, 102, 204, 0], [204, 51, 0, 0]]);
});

test('layers composite bottom to top with straight alpha: a solid top layer keeps its own colour at its edge', () => {
  const p = paint({
    layout: 'eye',
    blend: 'normal',
    layers: [
      one({ type: 'band', top: [[0, 100], [900, 100]], bottom: [[0, 300], [900, 300]] }, { color: '#FFC0C0', opacity: 0.5 }),
      one({ type: 'band', top: [[0, 200], [900, 200]], bottom: [[0, 220.5], [900, 220.5]] }, { color: '#101010' }),
    ],
  });
  assert.deepEqual(px(p, 450, 150), [255, 192, 192, 128]);
  assert.deepEqual(px(p, 450, 210), [16, 16, 16, 255]);
  // Half-covered edge row: half ink over the half-transparent pink, by the over operator.
  const [r, , , a] = px(p, 450, 220);
  assert.equal(a, Math.round((0.5 + 0.5 * 0.5) * 255));
  assert.equal(r, Math.round((16 * 0.5 + 255 * 0.5 * 0.5) / 0.75));
});

test('clip keeps the box with a feathered edge, and erase takes alpha out of a base texture', () => {
  const p = paint({ layout: 'face', blend: 'normal', layers: [one({ type: 'band', top: [[0, 480], [1024, 480]], bottom: [[0, 500], [1024, 500]] }, { clip: { y_min: 488, feather: 3 } })] });
  assert.deepEqual([487, 488, 489, 490, 491].map((y) => alpha(p, 100, y)), [0, 43, 128, 212, 255]);
  const dir = tmpdir('xs-paint-');
  const base = writeTexture(path.join(dir, 'base.png'), paint({ layout: 'eye', blend: 'normal', layers: [one({ type: 'band', top: [[0, 0], [900, 0]], bottom: [[0, 460], [900, 460]] })] }));
  const e = paint({ layout: 'eye', blend: 'normal', base, layers: [{ erase: true, shapes: [{ type: 'polygon', points: [[0, 0], [450, 0], [450, 460], [0, 460]] }] }] });
  assert.deepEqual([alpha(e, 100, 100), alpha(e, 800, 100), px(e, 800, 100).slice(0, 3)], [0, 255, [255, 0, 0]]);
});

test('scatter places count dots inside its ellipse and none in the avoided ones, the same for the same seed', () => {
  const shape = { type: 'scatter', x: 450, y: 230, rx: 200, ry: 100, count: 40, radius: [0.6, 0.6], seed: 9, avoid: [{ x: 450, y: 230, rx: 60 }] };
  const p = paint({ layout: 'eye', blend: 'normal', layers: [one(shape)] });
  const peaks = [];
  for (let y = 1; y < 459; y++) {
    for (let x = 1; x < 899; x++) {
      const a = alpha(p, x, y);
      if (a > 60 && [[-1, 0], [1, 0], [0, -1], [0, 1]].every(([dx, dy]) => alpha(p, x + dx, y + dy) <= a)) peaks.push([x, y]);
    }
  }
  assert.ok(peaks.length >= 36 && peaks.length <= 40, `${peaks.length} dots`);
  assert.ok(peaks.every(([x, y]) => ((x - 450) / 201) ** 2 + ((y - 230) / 101) ** 2 <= 1 && Math.hypot(x - 450, y - 230) >= 59));
  assert.deepEqual(paint({ layout: 'eye', blend: 'normal', layers: [one(shape)] }).data, p.data);
  assert.notDeepEqual(paint({ layout: 'eye', blend: 'normal', layers: [one({ ...shape, seed: 10 })] }).data, p.data);
});

test('strands grow from their line toward the given angle', () => {
  const p = paint({ layout: 'eye', blend: 'normal', layers: [one({ type: 'strands', along: [[100, 300], [300, 300]], count: 5, length: [40, 40], angle: [-90, -90], radius: [1.5, 0.5], curl: 0, jitter: { angle: 0, length: 0, position: 0 } })] });
  const column = (x) => Array.from({ length: 460 }, (_, y) => alpha(p, x, y)).map((a, y) => (a > 127 ? y : null)).filter((y) => y !== null);
  const c = column(100);
  assert.deepEqual([Math.min(...c), Math.max(...c)], [260, 300]);
  assert.deepEqual(column(130), []);
});

test('paint warns when a full-face texture paints over the eye openings', () => {
  const p = paint({ layout: 'face', blend: 'normal', layers: [one({ type: 'spot', x: 410, y: 478, rx: 10 })] });
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /左眼眼裂/);
  assert.deepEqual(paint({ layout: 'face', blend: 'normal', layers: [one({ type: 'spot', x: 410, y: 520, rx: 6 })] }).warnings, []);
});


test('three points are drawn as the smooth curve through them; curve: "straight" keeps the corner', () => {
  const points = [[100, 300], [200, 250], [300, 300]];
  // Centre line of the stroke per column: the alpha-weighted mean row.
  const centre = (p, x) => {
    let s = 0;
    let t = 0;
    for (let y = 200; y < 350; y++) {
      const a = alpha(p, x, y);
      s += a * (y + 0.5);
      t += a;
    }
    return s / t;
  };
  const draw = (curve) => paint({ layout: 'eye', blend: 'normal', layers: [one({ type: 'stroke', points, radius: 2, curve })] });
  const curved = draw(undefined);
  const straight = draw('straight');
  // Through the middle point either way.
  assert.ok(Math.abs(centre(curved, 199) - 250.5) < 1 && Math.abs(centre(straight, 199) - 250.5) < 1);
  // The polyline turns at x 200: its slope jumps from -0.5 to +0.5 there. Bend is the second difference
  // over 5 px, divided by 25 (per px²), which the 8-bit edge noise of single columns does not reach.
  const bend = (p) => Math.max(...Array.from({ length: 150 }, (_, k) => 125 + k).map((x) => Math.abs(centre(p, x + 5) - 2 * centre(p, x) + centre(p, x - 5)) / 25));
  assert.ok(bend(straight) > 0.15, `${bend(straight)}`);
  assert.ok(bend(curved) < 0.05, `${bend(curved)}`);
  // Halfway along the first piece the curve bulges above the straight line.
  assert.ok(centre(curved, 150) < centre(straight, 150) - 3, `${centre(curved, 150)} ${centre(straight, 150)}`);
  const band = (curve) => paint({ layout: 'eye', blend: 'normal', layers: [one({ type: 'band', top: points, bottom: points.map(([x, y]) => [x, y + 4]), curve })] });
  assert.ok(centre(band(undefined), 150) < centre(band('straight'), 150) - 3);
});

test('a curled strand is one smooth arc, not two straight pieces', () => {
  const draw = (curve) => paint({ layout: 'eye', blend: 'normal', layers: [one({ type: 'strands', along: [[200, 300], [201, 300]], count: 1, length: [80, 80], angle: [-90, -90], radius: [1.5, 1.5], curl: 40, curve, jitter: { angle: 0, length: 0, position: 0 } })] });
  // Centre column of the strand per row, and its bend over 5 rows (per px²).
  const centre = (p, y) => {
    let s = 0;
    let t = 0;
    for (let x = 150; x < 260; x++) {
      const a = alpha(p, x, y);
      s += a * (x + 0.5);
      t += a;
    }
    return s / t;
  };
  const bend = (p) => Math.max(...Array.from({ length: 60 }, (_, k) => 235 + k).map((y) => Math.abs(centre(p, y + 5) - 2 * centre(p, y) + centre(p, y - 5)) / 25));
  const straight = bend(draw('straight'));
  const curved = bend(draw(undefined));
  assert.ok(straight > 0.1 && curved < straight / 3, `${curved} vs ${straight}`);
});

test('the curve through unevenly spaced points neither loops back nor overshoots them', () => {
  // Two close pairs far apart, like lid points sampled densely at the corners.
  const pts = [[100, 300], [104, 299], [300, 250], [304, 252]];
  const c = smoothLine(pts, pts.map((_, i) => i)).points;
  assert.ok(c.every((p, i) => i === 0 || p[0] >= c[i - 1][0]), 'x goes back somewhere');
  const ys = c.map((p) => p[1]);
  assert.ok(Math.min(...ys) > 249.9 && Math.max(...ys) <= 300, `${Math.min(...ys)} – ${Math.max(...ys)}`);
  assert.deepEqual([c[0], c[c.length - 1]], [pts[0], pts[3]]);
});

// Upper-lid rim of model D's left eye, measured (初雪冷白 make_snow.py): flat over the iris, then a
// steep drop to the outer corner, with a pixel or two of noise.
const RIM = [[305, 259], [285, 253], [270, 249], [255, 247.5], [240, 247], [225, 247], [210, 246.5], [195, 248.5], [180, 255], [165, 262], [152, 266]];
const turns = (c) => {
  const out = [];
  for (let i = 10; i < c.length - 10; i++) {
    const a = Math.atan2(c[i][1] - c[i - 10][1], c[i][0] - c[i - 10][0]);
    const b = Math.atan2(c[i + 10][1] - c[i][1], c[i + 10][0] - c[i][0]);
    out.push((Math.atan2(Math.sin(b - a), Math.cos(b - a)) * 180) / Math.PI);
  }
  return out;
};

test('measured points are drawn as one arc by default: it bends one way, gently, close to every point', () => {
  const arc = fitArc(RIM, RIM.map(() => 0));
  const t = turns(arc.points);
  assert.ok(t.every((d) => d <= 0.05) || t.every((d) => d >= -0.05), 'the arc bends both ways');
  const through = turns(smoothLine(RIM, RIM.map(() => 0)).points);
  assert.ok(Math.max(...t.map(Math.abs)) < Math.max(...through.map(Math.abs)) / 2, `${Math.max(...t.map(Math.abs))} vs ${Math.max(...through.map(Math.abs))}`);
  assert.ok(arc.error < 2.1, `${arc.error}`);
  assert.deepEqual([arc.points[0], arc.points.at(-1)].map((p) => p.map((v) => Number(v.toFixed(6)))), [RIM[0], RIM.at(-1)]);
  const drawn = (curve) => paint({ layout: 'eye', blend: 'normal', layers: [one({ type: 'stroke', points: RIM, radius: [1, 3], curve })] });
  const p = drawn(undefined);
  assert.deepEqual(p.warnings, []);
  assert.ok(p.data.equals(drawn('arc').data) && !p.data.equals(drawn('through').data), 'the default is not the fitted arc');
  const band = (curve) => paint({ layout: 'eye', blend: 'normal', layers: [one({ type: 'band', top: RIM, bottom: RIM.map(([x, y]) => [x, y + 4]), curve })] }).data;
  assert.ok(band(undefined).equals(band('arc')) && !band(undefined).equals(band('through')));
  const lashes = (curve) => paint({ layout: 'eye', blend: 'normal', layers: [one({ type: 'strands', along: RIM, count: 20, length: [20, 30], angle: [-100, -140], radius: [1, 0.3], curve })] }).data;
  assert.ok(lashes(undefined).equals(lashes('arc')) && !lashes(undefined).equals(lashes('through')));
});

test('points one stroke cannot follow are fitted anyway and reported, and curve: "through" follows them', () => {
  // A cubic follows one S bend; a W has two, so the fit misses its middle.
  const s = [[100, 250], [150, 230], [200, 250], [250, 230], [300, 250]];
  const p = paint({ layout: 'eye', blend: 'normal', layers: [one({ type: 'band', top: s, bottom: s.map(([x, y]) => [x, y + 3]) })] });
  assert.equal(p.warnings.length, 2);
  assert.match(p.warnings[0], /第 1 层第 1 个形状（band） 上沿：这些点不在一条弧上（离拟合的弧最远 \d+\.\d 像素），要严格经过每个点用 curve: "through"/);
  assert.deepEqual(paint({ layout: 'eye', blend: 'normal', layers: [one({ type: 'band', top: s, bottom: s.map(([x, y]) => [x, y + 3]), curve: 'through' })] }).warnings, []);
});

test('a tail leaves the line in the direction it arrives and lifts its tip by the given angle', () => {
  const body = fitArc(RIM, RIM.map(() => 2));
  const out = withTail(body, { length: 30, lift: 32, radius: 0.2 });
  const p = out.points;
  const n = body.points.length;
  const dir = (a, b) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  const diff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  // The body's last half-pixel piece and the tail's first one point the same way: no corner at the join.
  const arrive = dir(body.points[n - 2], body.points[n - 1]);
  const leave = dir(p[n - 1], p[n]);
  assert.ok(diff(arrive, leave) < 1, `${arrive} → ${leave}`);
  // The tip is 30 px from the end, 32° above the arrival direction (upward: smaller y).
  const end = body.points[n - 1];
  const tip = p[p.length - 1];
  assert.ok(Math.abs(Math.hypot(tip[0] - end[0], tip[1] - end[1]) - 30) < 1e-6);
  // The line arrives heading 28° below horizontal, so 32° up from it ends the tip just above the end.
  assert.ok(Math.abs(diff(dir(end, tip), arrive) - 32) < 0.5 && tip[1] < end[1], `${dir(end, tip)} ${tip}`);
  assert.ok(out.values[n - 1] === 2 && Math.abs(out.values.at(-1) - 0.2) < 1e-9);
  // Upward whichever way the line runs: a line heading right lifts its tail the other way round.
  const right = fitArc([[100, 300], [200, 302], [300, 304], [400, 306]], [1, 1, 1, 1]);
  assert.ok(withTail(right, { length: 30, lift: 30 }).points.at(-1)[1] < 306 - 10);
  const down = withTail(body, { length: 30, lift: -20 }).points.at(-1);
  assert.ok(down[1] > end[1] + 1, `${down}`);
  // Drawn as one stroke: the painted line has no gap from the body into the tail.
  const img = paint({ layout: 'eye', blend: 'normal', layers: [one({ type: 'stroke', points: RIM, radius: 2, tail: { length: 30, lift: 32 } })] });
  for (const q of p.slice(n - 20, p.length - 8)) assert.ok(alpha(img, Math.floor(q[0]), Math.floor(q[1])) > 100, `gap at ${q}`);
});
