import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Library, M } = require('../editor-plugin/library.cjs');

class FaceMaskComponentEditor {
  constructor(so, props) {
    this.sceneObject = so;
    this.enabled = true;
    Object.assign(this, { externalFemaleIntensity: 1, externalMaleIntensity: 1, intensity: 1, ...props });
  }
  setProperty(k, v) {
    if (this.ignore) return undefined;
    if (k === 'readonlyKey') return Error('readonly');
    this[k] = v;
    return undefined;
  }
}
class EyeColorComponentEditor {
  constructor(so, intensity) {
    this.sceneObject = so;
    this.enabled = true;
    this.values = { intensity };
  }
  getProperty(k) {
    return this.values[k];
  }
  setProperty(k, v) {
    this.values[k] = v;
  }
}
class FilterComponentEditor extends EyeColorComponentEditor {}

function setup() {
  const projectDir = tmpdir('xs-mk-');
  const calls = { undo: [], imports: [] };
  const group = { name: '面部面具', parent: null };
  const set = { name: '清冷_美妆', parent: group };
  const texItem = (assetPath) => ({ assetPath, mainObject: { tex: assetPath }, compressMaxResolution: 512 });
  const items = [texItem('/p/Assets/liner.png'), texItem('/p/Assets/blush.png')];
  const so = (name, parent) => ({ name, parent });
  const editors = [
    new FaceMaskComponentEditor(so('眼线', set), { regionType: 1, blendMode: 1, femaleIntensity: 0.7, maleIntensity: 0, makeupTexture: items[0].mainObject }),
    new FaceMaskComponentEditor(so('腮红', set), { regionType: 0, blendMode: 1, femaleIntensity: 0.4, maleIntensity: 0.05, externalFemaleIntensity: 0.5, makeupTexture: items[1].mainObject }),
    new FaceMaskComponentEditor(so('腮红', group), { regionType: 0, blendMode: 0, femaleIntensity: 1, maleIntensity: 0, makeupTexture: null }),
    new EyeColorComponentEditor(so('美瞳', set), 0.8),
    new FilterComponentEditor(so('冷白皮', { name: '滤镜', parent: null }), 1),
    { constructor: { name: 'OtherEditor' }, sceneObject: so('别的', null) },
  ];
  const resourceManager = {
    getResourceItemByObject: (o) => items.find((i) => i.mainObject === o) || null,
    getResourceItemByAssetPath: (p) => items.find((i) => i.assetPath === p) || null,
    importResourceFileAsync: async (p, opts) => {
      calls.imports.push([p, opts.undoID]);
      const item = texItem(p.startsWith('/p/Assets/') ? p : `/p/Assets/Textures/${p.split('/').pop()}`);
      items.push(item);
      return item;
    },
  };
  const project = { path: projectDir, resourceManager };
  const bus = new EventEmitter();
  const modules = {
    [M.ef]: {
      ProjectManager: { getInstance: () => ({ hasActiveProject: () => true, getCurrentActiveProject: () => project }) },
      UndoSystem: { instance: { start: (n) => calls.undo.push(`start:${n}`), end: () => calls.undo.push('end') } },
      Resource: { ResourceUndoManager: { createImportUndoID: (k) => `undo:${k}` } },
    },
    [M.scene]: { SceneModule: { getEditingSceneService: () => ({ sceneEditor: { getAllComponentEditors: () => editors } }) } },
    [M.events]: { BusinessEventManager: { TypeGuard: () => bus } },
  };
  const lib = new Library((name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  });
  return { lib, calls, editors, items, bus, modules };
}

test('makeup_list describes the makeup layers, eye colour and filters with their strengths and textures', () => {
  const { lib } = setup();
  assert.deepEqual(lib.makeupList().layers, [
    { object_path: '面部面具/清冷_美妆/眼线', kind: 'face_mask', enabled: true, region: 1, blend: 1, female: 0.7, male: 0, intensity: 1, external: [1, 1], texture: '/p/Assets/liner.png' },
    { object_path: '面部面具/清冷_美妆/腮红', kind: 'face_mask', enabled: true, region: 0, blend: 1, female: 0.4, male: 0.05, intensity: 1, external: [0.5, 1], texture: '/p/Assets/blush.png' },
    { object_path: '面部面具/腮红', kind: 'face_mask', enabled: true, region: 0, blend: 0, female: 1, male: 0, intensity: 1, external: [1, 1], texture: null },
    { object_path: '面部面具/清冷_美妆/美瞳', kind: 'eye_color', enabled: true, intensity: 0.8 },
    { object_path: '滤镜/冷白皮', kind: 'filter', enabled: true, intensity: 1 },
  ]);
});

test('makeup_set changes strengths and panel opacity in one undo step and returns the layers before and after', async () => {
  const { lib, calls, editors } = setup();
  const out = await lib.makeupSet({
    label: 'try',
    changes: [
      { object_path: '眼线', female: 0.2, intensity: 0.55 },
      { object_path: '美瞳', intensity: 0 },
      { object_path: '滤镜/冷白皮', intensity: 0.3 },
    ],
  });
  assert.deepEqual(calls.undo, ['start:try', 'end']);
  assert.deepEqual([out.before[0].female, out.after[0].female, out.after[0].blend, out.after[0].texture, out.after[0].intensity], [0.7, 0.2, 1, '/p/Assets/liner.png', 0.55]);
  assert.deepEqual([out.after[1].intensity, out.after[2].intensity], [0, 0.3]);
  assert.equal(editors[0].maleIntensity, 0);
});

test('makeup_set refuses ambiguous paths, keys a layer does not take, and writes that did not land', async () => {
  const { lib, editors } = setup();
  await assert.rejects(lib.makeupSet({ changes: [{ object_path: '腮红', female: 0 }] }), /AMBIGUOUS_OBJECT_PATH: 腮红 matches/);
  await assert.rejects(lib.makeupSet({ changes: [{ object_path: '眼线', texture: '/p/Assets/new.png' }] }), /NOT_SETTABLE: .* is a face_mask; it takes female, male, intensity, not texture/);
  await assert.rejects(lib.makeupSet({ changes: [{ object_path: '眼线', region: 0 }] }), /NOT_SETTABLE: 面部面具\/清冷_美妆\/眼线 is a face_mask; it takes female, male, intensity, not region/);
  await assert.rejects(lib.makeupSet({ changes: [{ object_path: '冷白皮', female: 0 }] }), /NOT_SETTABLE: .* is a filter/);
  await assert.rejects(lib.makeupSet({ changes: [{ object_path: '眼线' }] }), /NOTHING_TO_SET/);
  await assert.rejects(lib.makeupSet({ changes: [] }), /INVALID_CHANGES/);
  editors[0].ignore = true;
  await assert.rejects(lib.makeupSet({ changes: [{ object_path: '眼线', female: 0.1 }] }), /WRITE_NOT_APPLIED: 面部面具\/清冷_美妆\/眼线: female=0.7/);
});

test('preview_fresh waits for new frames and says when none come', async () => {
  const { lib, bus } = setup();
  const waiting = lib.previewFresh({ frames: 2, timeout_ms: 1000 });
  bus.emit('PreviewTextureUpdated');
  bus.emit('PreviewTextureUpdated');
  assert.deepEqual(await waiting, { frames: 2 });
  assert.equal(bus.listenerCount('PreviewTextureUpdated'), 0);
  await assert.rejects(lib.previewFresh({ frames: 2, timeout_ms: 30 }), /NO_FRESH_PREVIEW_FRAME: the preview drew 0 of 2 frames within 30 ms/);
  assert.equal(bus.listenerCount('PreviewTextureUpdated'), 0);
});

test('makeup calls refuse to run when the editor lacks what they need', async () => {
  const { lib, modules } = setup();
  delete modules[M.events];
  assert.throws(() => lib.makeupList(), /INCOMPATIBLE_EDITOR: missing .*BusinessEventManager/);
});

