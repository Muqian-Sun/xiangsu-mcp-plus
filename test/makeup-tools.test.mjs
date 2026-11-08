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

// Where the fake face puts the eye texture: left eye frame (20–100, 30–90) → texture x 120–360, y 200–290;
// the right eye shows the mirrored half. Same mapping as the decoder's own test.
function eyeTexel(u, v) {
  if (u >= 20 && u < 100 && v >= 30 && v < 90) return [120 + 3 * (u + 0.5 - 20), 200 + 1.5 * (v + 0.5 - 30)];
  if (u >= 140 && u < 220 && v >= 32 && v < 92) return [899 - (120 + 3 * (220 - (u + 0.5))), 200 + 1.5 * (v + 0.5 - 32)];
  return null;
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
    const temp = [...layers.entries()].find(([p]) => p.startsWith('面部面具/眼部妆容'));
    const uv = temp && temp[1].female > 0 && temp[1].texture && fs.existsSync(temp[1].texture) ? PNG.sync.read(fs.readFileSync(temp[1].texture)) : null;
    for (let v = 0; v < FH; v++) {
      for (let u = 0; u < FW; u++) {
        const i = (v * FW + u) * 4;
        // The cheek (bottom band) brightens with the blush; the drift option nudges the last frames.
        const base = v >= 100 ? 100 + Math.round(100 * blush.female) : 150;
        img.data.set([base + (drift && frames > 3 ? 40 : 0), 120, 110, 255], i);
        const t = eyeTexel(u, v);
        if (!t) continue;
        if (Math.abs(t[1] - 247) < 1.5) img.data.set([40, 30, 30, 255], i);
        if (uv) {
          const si = (Math.floor(t[1]) * uv.width + Math.floor(t[0])) * 4;
          if (uv.data[si + 3]) img.data.set([uv.data[si], uv.data[si + 1], uv.data[si + 2], 255], i);
        }
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
        for (const k of ['female', 'male', 'intensity', 'blend', 'texture']) if (c[k] !== undefined) l[k] = c[k];
      });
      return { before, after: paths.map(describe) };
    },
    makeup_add_layer: ({ region }) => {
      const p = `面部面具/眼部妆容${region === 'eye' ? '' : `-${region}`}`;
      layers.set(p, { kind: 'face_mask', region: { face: 0, eye: 1, lips: 3 }[region], blend: 1, female: 0.8, male: 0, texture: null, enabled: true });
      return { object_path: p, added_objects: [{ name: '眼部妆容', object_path: p }] };
    },
    object_remove: ({ object_path, delete_unused_resources }) => {
      const tex = layers.get(object_path).texture;
      layers.delete(object_path);
      const deleted = [];
      if (delete_unused_resources && tex && fs.existsSync(tex)) {
        fs.rmSync(tex);
        deleted.push(path.relative(projectDir, tex));
      }
      return { removed_object: object_path, resources_deleted: deleted };
    },
    resource_delete_unused: ({ paths }) => {
      throw Error(`PLUGIN_ERROR(resource_delete_unused): RESOURCE_NOT_FOUND: ${paths[0]}`);
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
  assert.deepEqual(r.box_px, [0, 100, 240, 20]);
  const strip = PNG.sync.read(fs.readFileSync(r.image));
  assert.deepEqual([strip.width, strip.height], [3 * 240 * 3 + 2 * 2, 20 * 3]);
  assert.deepEqual(res.content.slice(1).map((c) => c.type), ['text', 'image']);
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

test('makeup_calibrate decodes both eyes on a temporary layer, reads the lid, mutes and restores everything and cleans up', async () => {
  const projectDir = project();
  const win = fakeWindow({ projectDir });
  const original = strengths(win);
  const keep = tmpdir('xs-calib-keep-');
  const client = await connect({ official: fakeOfficial(projectDir), callPlugin: win.callPlugin });
  const res = await client.callTool({ name: 'makeup_calibrate', arguments: { instance_id: '2', layout: 'eye', save_to: keep } });
  assert.equal(res.isError, undefined, res.content[0].text);
  const out = JSON.parse(res.content[0].text);
  const [left, right] = out.runs[0].parts;
  assert.deepEqual([left.eye, right.eye], ['left', 'right']);
  assert.deepEqual(left.box_px, [22, 32, 76, 56]);
  assert.equal(left.texture_px_per_frame_px, 1.5);
  // The fake lid rim is at texture y 247 on both eyes; read in 2-px bins.
  for (const p of [left, right]) for (const row of p.upper_lid.filter((r) => r.rim !== null)) assert.equal(row.rim, 246, JSON.stringify(row));
  assert.ok(left.upper_lid.filter((r) => r.rim !== null).length >= 5);
  assert.ok(right.upper_lid.every((r) => r.x > 450));
  const json = JSON.parse(fs.readFileSync(out.calibration_json, 'utf8'));
  const g = json.runs[0].parts[0].texture_grid.find((p) => p.texture[0] === 240 && p.texture[1] === 250);
  // Texture (240, 250) on the left eye is frame (60, 63.3) by the fake mapping.
  assert.ok(Math.abs(g.frame[0] - 60) < 1 && Math.abs(g.frame[1] - 63.3) < 1, JSON.stringify(g));
  assert.ok(fs.existsSync(left.overlay) && left.overlay.startsWith(keep));
  // Everything muted during the shots and back afterwards; the temporary layer and its texture are gone.
  const mute = win.calls.find(([m, p]) => m === 'makeup_set' && p.label === 'makeup_calibrate: mute makeup')[1];
  assert.deepEqual(mute.changes.map((c) => c.object_path).sort(), [...Object.keys(original)].sort());
  assert.deepEqual(strengths(win), original);
  assert.equal(win.layers.has('面部面具/眼部妆容'), false);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'Assets')), []);
  assert.equal(out.cleaned_up.length, 1);
});

test('makeup_calibrate fails clearly when the code does not show, and still removes what it added', async () => {
  const projectDir = project();
  // The temporary layer never shows: the fake only renders it when its texture file exists.
  const win = fakeWindow({ projectDir, fail: { preview_fresh: () => false } });
  const real = win.callPlugin;
  const client = await connect({
    official: fakeOfficial(projectDir),
    callPlugin: async (m, p, o) => {
      if (m === 'makeup_set' && p.changes.some((c) => c.texture)) return real(m, { ...p, changes: p.changes.map((c) => ({ ...c, texture: '/nowhere.png' })) }, o);
      return real(m, p, o);
    },
  });
  const original = strengths(win);
  const res = await client.callTool({ name: 'makeup_calibrate', arguments: { instance_id: '2', layout: 'eye' } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /CALIBRATION_NOT_VISIBLE/);
  assert.deepEqual(strengths(win), original);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'Assets')), []);
});

test('makeup_calibrate deletes its texture from disk when adding the layer fails', async () => {
  const projectDir = project();
  const win = fakeWindow({ projectDir, fail: { makeup_add_layer: () => true } });
  const client = await connect({ official: fakeOfficial(projectDir), callPlugin: win.callPlugin });
  const res = await client.callTool({ name: 'makeup_calibrate', arguments: { instance_id: '2', layout: 'eye' } });
  assert.equal(res.isError, true);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'Assets')), []);
  assert.ok(!win.calls.some(([m]) => m === 'object_remove'));
});

test('makeup_texture attach puts the texture on an existing layer of the same region, or on a new one', async () => {
  const projectDir = project();
  const win = fakeWindow({ projectDir });
  const client = await connect({ official: fakeOfficial(projectDir), callPlugin: win.callPlugin });
  const out = path.join(projectDir, 'Assets', 'liner.png');
  const layers = [{ color: '#1A1212', shapes: [{ type: 'stroke', points: [[150, 260], [300, 250]], radius: 2 }] }];
  const res = await client.callTool({ name: 'makeup_texture', arguments: { instance_id: '2', out, layout: 'eye', blend: 'normal', layers, attach: { object_path: '眼线', female: 0.9, texture_size: 1024 } } });
  assert.equal(res.isError, undefined, res.content[0].text);
  const set = win.calls.find(([m]) => m === 'makeup_set')[1].changes[0];
  assert.deepEqual(set, { object_path: '面部面具/清冷_美妆/眼线', texture: out, blend: 0, female: 0.9, texture_size: 1024 });
  assert.deepEqual(JSON.parse(res.content[0].text).attached.texture, out);
  const added = await client.callTool({ name: 'makeup_texture', arguments: { instance_id: '2', out, layout: 'eye', blend: 'multiply', layers, attach: { add: true } } });
  assert.equal(JSON.parse(added.content[0].text).attached.object_path, '面部面具/眼部妆容');
  assert.deepEqual(win.calls.filter(([m]) => m === 'makeup_add_layer').map(([, p]) => p.region), ['eye']);
  const wrong = await client.callTool({ name: 'makeup_texture', arguments: { instance_id: '2', out, layout: 'face', blend: 'normal', layers, attach: { object_path: '眼线' } } });
  assert.match(wrong.content[0].text, /LAYOUT_MISMATCH: 面部面具\/清冷_美妆\/眼线 is region 1, the face layout is for region 0/);
  const missing = await client.callTool({ name: 'makeup_texture', arguments: { instance_id: '2', out, layout: 'eye', blend: 'normal', layers, attach: { object_path: '睫毛' } } });
  assert.match(missing.content[0].text, /MAKEUP_LAYER_NOT_FOUND: 睫毛 matches 0/);
  const both = await client.callTool({ name: 'makeup_texture', arguments: { instance_id: '2', out, layout: 'eye', blend: 'normal', layers, attach: { object_path: '眼线', add: true } } });
  assert.match(both.content[0].text, /give object_path or add: true, not both/);
});

test('makeup_calibrate deletes its texture without asking the editor when it failed before handing it over', async () => {
  const projectDir = project();
  const win = fakeWindow({ projectDir, fail: { makeup_list: () => true, resource_delete_unused: () => true } });
  const client = await connect({ official: fakeOfficial(projectDir), callPlugin: win.callPlugin });
  const res = await client.callTool({ name: 'makeup_calibrate', arguments: { instance_id: '2', layout: 'eye' } });
  assert.match(res.content[0].text, /PLUGIN_ERROR\(makeup_list\)/);
  assert.deepEqual(fs.readdirSync(path.join(projectDir, 'Assets')), []);
  assert.ok(!win.calls.some(([m]) => m === 'resource_delete_unused'));
});
