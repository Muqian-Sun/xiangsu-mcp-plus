'use strict';
// Makeup layers in the open project, read and changed through their component editors (the same
// setters the inspector uses, so the preview follows), and the preview held on one video frame so
// makeup states can be compared or decoded on exactly the same picture.
const { M, editingScene, sceneObjectPath, resolveByPath } = require('./common.cjs');

const KINDS = { FaceMaskComponentEditor: 'face_mask', EyeColorComponentEditor: 'eye_color', FilterComponentEditor: 'filter' };
// What each kind lets a change set; makeup_set refuses anything else.
const SETTABLE = {
  face_mask: ['female', 'male', 'blend', 'texture'],
  eye_color: ['intensity'],
  filter: ['intensity'],
};
// FaceMask regions to the add-object menu items that create an empty layer of that region.
const REGION_MENU = { face: 'FaceMask', eye: 'FaceEye', lips: 'FaceLips' };

const TEXTURE = 'PreviewTextureUpdated';
// Picked, not measured: same count as preview_reset waits for (the first frame after a change may
// still be the old one); the timeout leaves room for the 6 fps background mode.
const FRESH_FRAMES = 2;
const FRAME_TIMEOUT_MS = 5000;

function tunables(lib) {
  const { sceneEditor } = editingScene(lib);
  return sceneEditor
    .getAllComponentEditors()
    .filter((c) => Object.prototype.hasOwnProperty.call(KINDS, c.constructor.name))
    .map((c) => ({ comp: c, path: sceneObjectPath(c.sceneObject), kind: KINDS[c.constructor.name] }));
}

function texturePath(project, tex) {
  if (!tex) return null;
  const item = project.resourceManager.getResourceItemByObject(tex);
  return (item && item.assetPath) || null;
}

function describe(project, { comp, path, kind }) {
  const base = { object_path: path, kind, enabled: !!comp.enabled };
  if (kind === 'face_mask') {
    return {
      ...base,
      region: comp.regionType,
      blend: comp.blendMode,
      female: comp.femaleIntensity,
      male: comp.maleIntensity,
      external: [comp.externalFemaleIntensity, comp.externalMaleIntensity],
      texture: texturePath(project, comp.makeupTexture),
    };
  }
  return { ...base, intensity: comp.getProperty ? comp.getProperty('intensity') : comp.intensity };
}

function set(comp, key, value) {
  const res = comp.setProperty(key, value);
  if (res instanceof Error) throw Error(`SET_PROPERTY_FAILED: ${key}: ${res.message}`);
}

const methods = {
  makeupList() {
    this.ensureCompatible('makeup');
    const { project } = editingScene(this);
    return { layers: tunables(this).map((t) => describe(project, t)) };
  },

  // changes: [{ object_path, female?, male?, blend?, texture?, texture_size?, intensity? }]. texture is an
  // absolute PNG path: inside the project's Assets it is registered where it is, elsewhere the editor
  // copies it in. Returns each layer before and after, so the caller can put it back.
  async makeupSet({ changes, label = 'makeup_set' }) {
    this.ensureCompatible('makeup');
    if (!Array.isArray(changes) || !changes.length) throw Error('INVALID_CHANGES: pass at least one change');
    const { EF, project } = editingScene(this);
    const all = tunables(this);
    const plan = changes.map((ch) => {
      const t = resolveByPath(all, ch.object_path, 'MAKEUP_LAYER');
      const keys = Object.keys(ch).filter((k) => k !== 'object_path' && k !== 'texture_size' && ch[k] !== undefined);
      const bad = keys.filter((k) => !SETTABLE[t.kind].includes(k));
      if (bad.length) throw Error(`NOT_SETTABLE: ${t.path} is a ${t.kind}; it takes ${SETTABLE[t.kind].join(', ')}, not ${bad.join(', ')}`);
      if (!keys.length) throw Error(`NOTHING_TO_SET: ${t.path}`);
      return { t, ch };
    });
    const before = plan.map(({ t }) => describe(project, t));
    // Textures are imported first, outside the undo step: an import is its own resource transaction.
    const textures = new Map();
    for (const { ch } of plan) {
      if (ch.texture === undefined || textures.has(ch.texture)) continue;
      const rm = project.resourceManager;
      let item = rm.getResourceItemByAssetPath(ch.texture);
      if (!item) item = await rm.importResourceFileAsync(ch.texture, { undoID: EF.Resource.ResourceUndoManager.createImportUndoID(`makeup_set:${ch.texture}`) });
      if (!item || !item.mainObject) throw Error(`TEXTURE_IMPORT_FAILED: ${ch.texture}`);
      if (ch.texture_size !== undefined && item.compressMaxResolution !== ch.texture_size) item.compressMaxResolution = ch.texture_size;
      textures.set(ch.texture, item);
    }
    EF.UndoSystem.instance.start(label);
    try {
      for (const { t, ch } of plan) {
        if (t.kind === 'face_mask') {
          if (ch.blend !== undefined) set(t.comp, 'blendMode', ch.blend);
          if (ch.texture !== undefined) set(t.comp, 'makeupTexture', textures.get(ch.texture).mainObject);
          if (ch.female !== undefined) set(t.comp, 'femaleIntensity', ch.female);
          if (ch.male !== undefined) set(t.comp, 'maleIntensity', ch.male);
        } else set(t.comp, 'intensity', ch.intensity);
      }
    } finally {
      EF.UndoSystem.instance.end();
    }
    const after = plan.map(({ t }) => describe(project, t));
    for (const [i, { t, ch }] of plan.entries()) {
      const a = after[i];
      const off = [];
      for (const k of ['female', 'male', 'blend', 'intensity']) if (ch[k] !== undefined && Math.abs(a[k] - ch[k]) > 1e-4) off.push(`${k}=${a[k]}`);
      if (ch.texture !== undefined && a.texture !== textures.get(ch.texture).assetPath) off.push(`texture=${a.texture}`);
      if (off.length) throw Error(`WRITE_NOT_APPLIED: ${t.path}: ${off.join(', ')}`);
    }
    return { before, after };
  },

  async makeupAddLayer({ region }) {
    this.ensureCompatible('makeup');
    const menu_id = REGION_MENU[region];
    if (!menu_id) throw Error(`INVALID_REGION: ${region}; use ${Object.keys(REGION_MENU).join(' / ')}`);
    const res = await this.menuAdd({ menu_id });
    const paths = new Set(res.added_objects.map((o) => o.object_path));
    const layer = tunables(this).find((t) => t.kind === 'face_mask' && [...paths].some((p) => t.path === p || t.path.startsWith(`${p}/`)));
    if (!layer) throw Error(`ADD_LAYER_NO_FACE_MASK: ${menu_id} added ${[...paths].join(', ')} without a FaceMask`);
    return { object_path: layer.path, added_objects: res.added_objects };
  },

  // Holds the preview on the current video frame (hold=true) or plays it again (hold=false).
  previewHold({ hold }) {
    this.ensureCompatible('makeup');
    const pm = this.mod(M.preview).PreviewManager.getInstance();
    if (hold) pm.pause();
    else pm.resume();
    return { held: !pm.getPlaystate() };
  },

  // Resolves once the preview has drawn `frames` new frames (after a change, so the next capture shows it).
  async previewFresh({ frames = FRESH_FRAMES, timeout_ms = FRAME_TIMEOUT_MS } = {}) {
    this.ensureCompatible('makeup');
    const bus = this.mod(M.events).BusinessEventManager.TypeGuard();
    let n = 0;
    let onTexture;
    let timer;
    try {
      await new Promise((resolve, reject) => {
        onTexture = () => {
          n += 1;
          if (n >= frames) resolve();
        };
        bus.on(TEXTURE, onTexture);
        timer = setTimeout(() => reject(Error(`NO_FRESH_PREVIEW_FRAME: the preview drew ${n} of ${frames} frames within ${timeout_ms} ms`)), timeout_ms);
      });
    } finally {
      clearTimeout(timer);
      bus.off(TEXTURE, onTexture);
    }
    return { frames: n };
  },
};

const METHODS = { makeup_list: 'makeupList', makeup_set: 'makeupSet', makeup_add_layer: 'makeupAddLayer', preview_hold: 'previewHold', preview_fresh: 'previewFresh' };

module.exports = { methods, METHODS, KINDS, SETTABLE, REGION_MENU };
