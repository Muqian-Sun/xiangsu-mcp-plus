import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';

const FW = 240;
const FH = 120;

function fakeOfficial(projectDir) {
  const calls = [];
  return {
    calls,
    url: 'x',
    listTools: async () => [],
    status: () => ({}),
    callJson: async (name, args) => {
      calls.push([name, args]);
      if (name === 'list_instances') return { instances: [{ instance_id: '2', project_path: projectDir }] };
      if (name === 'get_current_preview_video') return { tracking_type: 'face', video_name: 'preview_single_blink||女' };
      if (name === 'set_preview_video') return { ok: true };
      throw Error(`unexpected ${name}`);
    },
  };
}

// A fake editor window: makeup layers with strengths, a frame rendered from them, and every call logged.
function fakeWindow({ projectDir, fail = {}, drift = false } = {}) {
  const calls = [];
  const layers = new Map([
    ['面部面具/腮红', { kind: 'face_mask', region: 0, blend: 1, female: 0.6, male: 0.1, texture: '/t/blush.png', enabled: true }],
    ['面部面具/清冷_美妆/眼线', { kind: 'face_mask', region: 1, blend: 1, female: 0.7, male: 0, texture: '/t/liner.png', enabled: true }],
    ['面部面具/清冷_美妆/美瞳', { kind: 'eye_color', intensity: 0.8, enabled: true }],
    ['滤镜/冷白皮', { kind: 'filter', intensity: 1, enabled: true }],
  ]);
  let frames = 0;
  const describe = (p) => ({ object_path: p, ...layers.get(p) });
  const render = () => {
    frames += 1;
    const img = new PNG({ width: FW, height: FH });
    const blush = layers.get('面部面具/腮红');
    for (let v = 0; v < FH; v++) {
      for (let u = 0; u < FW; u++) {
        const i = (v * FW + u) * 4;
        // The cheek (bottom band) brightens with the blush; the drift option nudges the last frames.
        const base = v >= 100 ? 100 + Math.round(100 * blush.female) : 150;
        img.data.set([base + (drift && frames > 3 ? 40 : 0), 120, 110, 255], i);
      }
    }
    return PNG.sync.write(img).toString('base64');
  };
  const answers = {
    preview_full_rate: ({ hold_ms }) => ({ held: hold_ms > 0 }),
    preview_reset: () => ({ reloaded_ms: 700, ready_ms: 1100 }),
    preview_fresh: () => ({ frames: 2 }),
    preview_frame: () => ({ mimeType: 'image/png', data: render() }),
    makeup_list: () => ({ layers: [...layers.keys()].map(describe) }),
    // Paths resolve like the plugin's resolveByPath: the full path or a unique trailing chain.
    makeup_set: ({ changes }) => {
      const full = (p) => {
        const hits = [...layers.keys()].filter((k) => k === p || k.endsWith(`/${p}`));
        if (hits.length !== 1) throw Error(`MAKEUP_LAYER_NOT_FOUND: ${p}`);
        return hits[0];
      };
      const paths = changes.map((c) => full(c.object_path));
      const before = paths.map(describe);
      changes.forEach((c, i) => {
        const l = layers.get(paths[i]);
        for (const k of ['female', 'male', 'intensity']) if (c[k] !== undefined) l[k] = c[k];
      });
      return { before, after: paths.map(describe) };
    },
  };
  return {
    calls,
    layers,
    callPlugin: async (method, params, opts) => {
      calls.push([method, params]);
      assert.equal(opts.projectPath, projectDir);
      if (fail[method] && fail[method](params, calls)) throw Error(`PLUGIN_ERROR(${method}): boom`);
      return answers[method](params);
    },
  };
}

async function connect(deps) {
  const server = createServer({ listInstances: () => [], sleep: async () => {}, framesDir: () => tmpdir('xs-frames-'), ...deps });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function project() {
  const dir = tmpdir('xs-proj-');
  fs.mkdirSync(path.join(dir, 'Assets'));
  return dir;
}

const strengths = (w) => Object.fromEntries([...w.layers].map(([p, l]) => [p, l.kind === 'face_mask' ? [l.female, l.male] : l.intensity]));
const CHEEK = { label: '脸颊', x: 0, y: 100 / FH, width: 1, height: 20 / FH };

test('makeup_compare shoots the baseline and each variant on the playing preview, puts every change back and measures the regions', async () => {
  const projectDir = project();
  const win = fakeWindow({ projectDir });
  const original = strengths(win);
  const client = await connect({ official: fakeOfficial(projectDir), callPlugin: win.callPlugin });
  const res = await client.callTool({
    name: 'makeup_compare',
    arguments: {
      instance_id: '2',
      variants: [
        { label: '关腮红', changes: [{ object_path: '腮红', female: 0 }] },
        { label: '腮红满', changes: [{ object_path: '面部面具/腮红', female: 1, male: 1 }] },
      ],
      regions: [CHEEK],
      at_ms: 1500,
    },
  });
  assert.equal(res.isError, undefined, res.content[0].text);
  assert.deepEqual(
    win.calls.map(([m, p]) => (m === 'makeup_set' ? `set:${p.changes.map((c) => `${c.object_path}=${c.female}`).join(',')}` : m)),
    [
      'preview_full_rate', 'preview_reset',
      'preview_full_rate', 'preview_frame',
      'set:腮红=0', 'preview_fresh', 'preview_full_rate', 'preview_frame', 'set:面部面具/腮红=0.6',
      'set:面部面具/腮红=1', 'preview_fresh', 'preview_full_rate', 'preview_frame', 'set:面部面具/腮红=0.6',
      'preview_fresh', 'preview_full_rate', 'preview_frame',
      'preview_full_rate',
    ],
  );
  assert.deepEqual(strengths(win), original);
  const out = JSON.parse(res.content[0].text);
  assert.deepEqual(out.states, ['基线', '关腮红', '腮红满']);
  const r = out.runs[0].regions[0];
  assert.deepEqual(r.states.map((s) => s.rgb[0]), [160, 100, 200]);
  assert.deepEqual([r.states[1].delta.rgb, r.states[2].delta.rgb], [[-60, 0, 0], [40, 0, 0]]);
  assert.deepEqual(r.drift, { mean: 0, max: 0 });
  assert.equal(r.warning, undefined);
  assert.equal(r.note, undefined);
  assert.deepEqual(r.box_px, [0, 100, 240, 20]);
  const strip = PNG.sync.read(fs.readFileSync(r.image));
  // Each cheek tile is 720×60; three of them wrap to one column under the 1024 px strip limit.
  assert.deepEqual([strip.width, strip.height], [720, 3 * 60 + 2 * 2]);
  assert.deepEqual(res.content.slice(1).map((c) => c.type), ['text', 'image']);
});

test('makeup_compare notes a region that no variant changed at all (a box over a sticker or off the makeup)', async () => {
  const projectDir = project();
  const win = fakeWindow({ projectDir });
  const client = await connect({ official: fakeOfficial(projectDir), callPlugin: win.callPlugin });
  const res = await client.callTool({
    name: 'makeup_compare',
    arguments: { instance_id: '2', variants: [{ label: '关腮红', changes: [{ object_path: '腮红', female: 0 }] }], regions: [{ label: '额头', x: 0, y: 0, width: 1, height: 0.3 }, CHEEK], at_ms: 1500 },
  });
  assert.equal(res.isError, undefined, res.content[0].text);
  const [top, cheek] = JSON.parse(res.content[0].text).runs[0].regions;
  assert.deepEqual(top.states[1].delta, { rgb: [0, 0, 0], luma: 0, detail: 0 });
  assert.match(top.note, /所有状态在这个区域都和基线完全一样/);
  assert.equal(cheek.note, undefined);
});

test('makeup_compare measures each state against a reference crop and appends it to the strip', async () => {
  const projectDir = project();
  const win = fakeWindow({ projectDir });
  const client = await connect({ official: fakeOfficial(projectDir), callPlugin: win.callPlugin });
  const refDir = tmpdir('xs-ref-');
  const ref = new PNG({ width: 100, height: 40 });
  for (let i = 0; i < ref.width * ref.height; i++) ref.data.set([200, 100, 80, 255], i * 4);
  const refPath = path.join(refDir, 'ref.png');
  fs.writeFileSync(refPath, PNG.sync.write(ref));
  const res = await client.callTool({
    name: 'makeup_compare',
    arguments: {
      instance_id: '2',
      variants: [{ label: '关腮红', changes: [{ object_path: '腮红', female: 0 }] }],
      regions: [{ ...CHEEK, ref: { x: 0, y: 0, width: 1, height: 1 } }],
      reference: refPath,
    },
  });
  assert.equal(res.isError, undefined, res.content[0].text);
  const r = JSON.parse(res.content[0].text).runs[0].regions[0];
  assert.deepEqual(r.reference.rgb, [200, 100, 80]);
  assert.deepEqual(r.states[0].to_reference.rgb, [-40, 20, 30]);
  const strip = PNG.sync.read(fs.readFileSync(r.image));
  // Baseline, variant, second baseline are omitted — strip is baseline | 关腮红 | 参考, wrapped to one column.
  assert.deepEqual([strip.width, strip.height], [720, 3 * 60 + 2 * 2]);
  assert.match(res.content[1].text, /参考/);
  const missing = await client.callTool({
    name: 'makeup_compare',
    arguments: { instance_id: '2', variants: [{ label: 'x', changes: [{ object_path: '腮红', female: 0 }] }], regions: [{ ...CHEEK, ref: { x: 0, y: 0, width: 1, height: 1 } }] },
  });
  assert.match(missing.content[0].text, /REFERENCE_MISSING/);
  const unused = await client.callTool({
    name: 'makeup_compare',
    arguments: { instance_id: '2', variants: [{ label: 'x', changes: [{ object_path: '腮红', female: 0 }] }], regions: [CHEEK], reference: refPath },
  });
  assert.match(unused.content[0].text, /REFERENCE_UNUSED/);
});

test('makeup_compare puts the change back when a capture fails', async () => {
  const projectDir = project();
  const win = fakeWindow({ projectDir, fail: { preview_frame: (_, calls) => calls.filter(([m]) => m === 'preview_frame').length === 2 } });
  const original = strengths(win);
  const client = await connect({ official: fakeOfficial(projectDir), callPlugin: win.callPlugin });
  const res = await client.callTool({ name: 'makeup_compare', arguments: { instance_id: '2', variants: [{ label: '关腮红', changes: [{ object_path: '腮红', female: 0 }] }], regions: [CHEEK] } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /boom/);
  assert.deepEqual(strengths(win), original);
});

test('makeup_compare says so when the face changed between the first and the last baseline (a moving video)', async () => {
  const projectDir = project();
  const win = fakeWindow({ projectDir, drift: true });
  const client = await connect({ official: fakeOfficial(projectDir), callPlugin: win.callPlugin });
  const res = await client.callTool({ name: 'makeup_compare', arguments: { instance_id: '2', variants: [{ label: '关腮红', changes: [{ object_path: '腮红', female: 0 }] }, { label: '腮红满', changes: [{ object_path: '腮红', female: 1 }] }], regions: [CHEEK] } });
  const r = JSON.parse(res.content[0].text).runs[0].regions[0];
  assert.ok(r.drift.max > 8, JSON.stringify(r.drift));
  assert.match(r.warning, /这期间画面自己在变/);
});
