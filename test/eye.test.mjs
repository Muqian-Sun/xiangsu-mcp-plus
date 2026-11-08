import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { fitArc, paint } from '../src/paint.mjs';
import { DEFAULT_ANATOMY, anatomyFromCalibration, eyeTextures } from '../src/eye.mjs';

const painted = (t) => paint({ layout: t.layout, blend: t.blend, mirror_dy: t.mirror_dy, layers: t.layers });
const alpha = (p, x, y) => p.data[(Math.round(y) * p.width + Math.round(x)) * 4 + 3];
// Rows of the anatomy curves at a column (they are given inner corner first, x decreasing).
const at = (pts, x) => {
  const s = [...pts].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < s.length; i++) if (x <= s[i][0]) return s[i - 1][1] + ((s[i][1] - s[i - 1][1]) * (x - s[i - 1][0])) / (s[i][0] - s[i - 1][0]);
  return s[s.length - 1][1];
};

test('only the parts asked for are drawn, each in the texture of its blend mode', () => {
  assert.deepEqual(eyeTextures({}), []);
  assert.deepEqual(eyeTextures({ liner: { style: 'tight' } }).map((t) => [t.key, t.blend, t.layout, t.layers.length]), [['line', 'normal', 'eye', 1]]);
  const all = eyeTextures({
    liner: { style: 'wing' },
    lashes: { style: 'natural' },
    lower_lashes: { style: 'sparse' },
    shadow: { base: { color: '#E6C2BC' }, outer: { color: '#B68A82' } },
    highlight: { inner: {} },
    aegyo: { highlight: {}, shadow: {} },
    lower_lid: { line: { color: '#F0ACA4' } },
  });
  assert.deepEqual(all.map((t) => [t.key, t.blend]), [['line', 'normal'], ['shadow', 'multiply'], ['light', 'screen'], ['under', 'normal']]);
  // Liner on top of the lashes: the last layer of the line texture is the liner, in ink.
  assert.equal(all[0].layers.at(-1).color, '#1A1212');
  assert.ok(all.every((t) => t.mirror_dy === DEFAULT_ANATOMY.mirror_dy));
});

test('the liner is thin above the rim and reaches down into the spread of rims, so it meets lower lash lines too', () => {
  const p = painted(eyeTextures({ liner: { style: 'lash_line' } })[0]);
  const x = 240;
  // The liner follows the arc fitted through the rim points.
  const arc = fitArc(DEFAULT_ANATOMY.rim, DEFAULT_ANATOMY.rim.map(() => 0)).points;
  const rim = arc.reduce((best, p) => (Math.abs(p[0] - x) < Math.abs(best[0] - x) ? p : best))[1];
  const [, down] = DEFAULT_ANATOMY.spread;
  const rows = Array.from({ length: 60 }, (_, k) => rim - 30 + k).filter((y) => alpha(p, x, y) > 127);
  const [top, bottom] = [Math.min(...rows), Math.max(...rows)];
  // Down past the rim by half the spread below it (cover 0.5), up by about the line's width.
  assert.ok(bottom >= rim + down * 0.5, `${bottom} vs rim ${rim}`);
  assert.ok(top >= rim - 8 && top <= rim - 3, `${top} vs rim ${rim}`);
  const deeper = painted(eyeTextures({ liner: { style: 'lash_line', cover: 1.5 } })[0]);
  assert.ok(alpha(deeper, x, rim + down * 1.4) > 127 && alpha(p, x, rim + down * 1.4) < 127);
  // Mirrored onto the right eye, moved down by mirror_dy.
  assert.ok(Math.abs(alpha(p, 899 - x, bottom + DEFAULT_ANATOMY.mirror_dy) - alpha(p, x, bottom)) < 40);
  // A wing continues past the outer corner; a plain lash line stops there.
  const outer = DEFAULT_ANATOMY.rim.at(-1);
  const wing = painted(eyeTextures({ liner: { style: 'wing' } })[0]);
  const past = (q) => Array.from({ length: 40 }, (_, k) => outer[1] - 20 + k).some((y) => alpha(q, outer[0] - 20, y) > 60);
  assert.deepEqual([past(wing), past(p)], [true, false]);
});

test('shadow and under-eye colour stay out of the eye opening', () => {
  // A wide lower-lid line (width 8) would reach up into the opening if it were not kept out.
  const [shadow, under] = eyeTextures({ shadow: { base: { color: '#E6C2BC', opacity: 0.6 } }, lower_lid: { line: { color: '#F0ACA4', width: 8 } } }).map(painted);
  const x = 240;
  const rim = at(DEFAULT_ANATOMY.rim, x);
  const lower = at(DEFAULT_ANATOMY.lower, x);
  const inside = (p) => Math.max(...Array.from({ length: Math.floor(lower - rim - 9) }, (_, k) => alpha(p, x, rim + 6 + k)));
  assert.ok(alpha(shadow, x, rim - 20) > 40, 'no shadow on the lid');
  assert.ok(inside(shadow) < 8, `shadow in the opening: ${inside(shadow)}`);
  assert.ok(alpha(under, x, lower + 3) > 40, 'no line under the lower lashes');
  assert.ok(inside(under) < 8, `under-eye colour in the opening: ${inside(under)}`);
});

const lashShapes = (style, extra = {}) => eyeTextures({ lashes: { style, seed: 3, ...extra } })[0].layers[0].shapes;
const len = (s) => Math.hypot(s.points.at(-1)[0] - s.points[0][0], s.points.at(-1)[1] - s.points[0][1]);
// Mean length of the strands rooted in a third of the eye (by root x: inner corner at large x).
const third = (shapes, k) => {
  const xs = shapes.map((s) => s.points[0][0]);
  const [lo, hi] = [Math.min(...xs), Math.max(...xs)];
  const pick = shapes.filter((s) => {
    const f = (hi - s.points[0][0]) / (hi - lo);
    return f >= k / 3 && f <= (k + 1) / 3;
  });
  return pick.reduce((t, s) => t + len(s), 0) / pick.length;
};

test('the lash styles differ the way their names say', () => {
  const doll = lashShapes('doll');
  assert.ok(third(doll, 1) > third(doll, 0) && third(doll, 1) > third(doll, 2), 'doll lashes are not longest in the middle');
  const fox = lashShapes('fox');
  assert.ok(third(fox, 2) > 2 * third(fox, 0), 'fox lashes are not long at the outer corner');
  const natural = lashShapes('natural');
  const sunflower = lashShapes('sunflower');
  const mean = (s) => s.reduce((t, x) => t + len(x), 0) / s.length;
  assert.ok(mean(sunflower) > mean(natural) * 1.2 && sunflower.length > natural.length);
  // Clusters: strands in groups of five whose tips meet.
  const cluster = lashShapes('cluster', { count: 6 });
  assert.equal(cluster.length, 30);
  for (let g = 0; g < 6; g++) {
    const tips = cluster.slice(g * 5, g * 5 + 5).map((s) => s.points.at(-1));
    assert.ok(tips.every((t) => Math.hypot(t[0] - tips[0][0], t[1] - tips[0][1]) < 1e-6), `group ${g} tips apart`);
  }
  assert.ok(lashShapes('natural', { length: 2 }).every((s, i) => len(s) > len(natural[i]) * 1.9));
});

function calibration(runs) {
  const file = path.join(tmpdir('xs-cal-'), 'calibration-eye.json');
  fs.writeFileSync(file, JSON.stringify({ layout: 'eye', runs }));
  return file;
}
const lid = (cols, rim, edge = (x) => rim(x) - 8) => cols.map((x) => ({ x, edge: rim(x) === null ? null : edge(x), rim: rim(x) }));
const COLS = Array.from({ length: 14 }, (_, i) => 135 + 15 * i);

test('a calibration gives the median rim of its models, the spread of their rims and the right eye offset', () => {
  // Three models whose left rims sit 4 below, at, and 6 above 250 (a flat lid), right eyes 5 lower.
  const runs = [4, 0, -6].map((d, k) => ({
    video: `v${k}`,
    parts: [
      { eye: 'left', upper_lid: lid(COLS, (x) => (x >= 195 && x <= 285 ? 250 + d : null)) },
      { eye: 'right', upper_lid: lid(COLS.map((x) => 899 - x), (x) => (899 - x >= 195 && 899 - x <= 285 ? 255 + d : null)) },
    ],
  }));
  const a = anatomyFromCalibration(calibration(runs));
  assert.equal(a.mirror_dy, 5);
  assert.deepEqual(a.spread, [6, 4]);
  assert.equal(a.measured.models, 3);
  assert.equal(a.measured.rim_columns, 7);
  // Measured columns sit on the median (250, refitted as one arc with the default ends); the ends
  // keep the default.
  assert.ok(Math.abs(at(a.rim, 240) - 250) < 2, `${at(a.rim, 240)}`);
  assert.deepEqual([a.rim[0], a.rim.at(-1)], [DEFAULT_ANATOMY.rim[0], DEFAULT_ANATOMY.rim.at(-1)]);
  // Too few readings anywhere (one model: two eyes per column): the default positions.
  const thin = anatomyFromCalibration(calibration(runs.slice(0, 1)));
  assert.equal(thin.measured.rim_columns, 0);
  assert.deepEqual([thin.spread, thin.mirror_dy], [DEFAULT_ANATOMY.spread, 5]);
  const face = calibration([]);
  fs.writeFileSync(face, JSON.stringify({ layout: 'face', runs: [] }));
  assert.throws(() => anatomyFromCalibration(face), /CALIBRATION_NOT_EYE/);
});

test('makeup_eye writes one texture per blend mode and attaches each to a new eye layer, men at 0', async () => {
  const projectDir = tmpdir('xs-eye-proj-');
  const calls = [];
  let n = 0;
  const callPlugin = async (method, params) => {
    calls.push([method, params]);
    if (method === 'makeup_add_layer') return { object_path: `面部面具/眼部妆容 (${++n})` };
    if (method === 'makeup_set') return { before: [], after: params.changes.map((c) => ({ object_path: c.object_path })) };
    throw Error(`unexpected ${method}`);
  };
  const official = { url: 'x', listTools: async () => [], status: () => ({}), callJson: async (name) => (name === 'list_instances' ? { instances: [{ instance_id: '2', project_path: projectDir }] } : null) };
  const server = createServer({ listInstances: () => [], callPlugin, official });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const out_dir = path.join(projectDir, 'Assets', 'eye');
  const res = await client.callTool({
    name: 'makeup_eye',
    arguments: { instance_id: '2', out_dir, name: 'look', liner: { style: 'wing' }, lashes: { style: 'doll' }, shadow: { base: { color: '#E6C2BC' } }, highlight: { inner: {} }, lower_lid: { line: { color: '#F0ACA4' } }, attach: { add: true } },
  });
  assert.equal(res.isError, undefined, res.content[0].text);
  const out = JSON.parse(res.content[0].text);
  assert.deepEqual(out.textures.map((t) => [t.key, path.basename(t.file), t.attached]), [
    ['line', 'look_line.png', '面部面具/眼部妆容 (1)'],
    ['shadow', 'look_shadow.png', '面部面具/眼部妆容 (2)'],
    ['light', 'look_light.png', '面部面具/眼部妆容 (3)'],
    ['under', 'look_under.png', '面部面具/眼部妆容 (4)'],
  ]);
  assert.ok(out.textures.every((t) => fs.existsSync(t.file)));
  const sets = calls.filter(([m]) => m === 'makeup_set').map(([, p]) => p.changes[0]);
  assert.deepEqual(sets.map((c) => [c.blend, c.female, c.male, c.texture_size]), [[0, 1, 0, 1024], [1, 1, 0, 1024], [4, 1, 0, 1024], [0, 1, 0, 1024]]);
  assert.deepEqual(calls.filter(([m]) => m === 'makeup_add_layer').map(([, p]) => p.region), ['eye', 'eye', 'eye', 'eye']);
  assert.equal(out.anatomy.source, 'default');
  const none = await client.callTool({ name: 'makeup_eye', arguments: { out_dir } });
  assert.match(none.content[0].text, /NOTHING_TO_DRAW/);
  const reuse = await client.callTool({ name: 'makeup_eye', arguments: { instance_id: '2', out_dir, liner: { style: 'tight' }, attach: { line: '面部面具/眼部妆容 (1)', male: 0.1 } } });
  assert.equal(JSON.parse(reuse.content[0].text).textures[0].attached, '面部面具/眼部妆容 (1)');
  assert.equal(calls.filter(([m]) => m === 'makeup_add_layer').length, 4);
  assert.equal(calls.at(-1)[1].changes[0].male, 0.1);
});
