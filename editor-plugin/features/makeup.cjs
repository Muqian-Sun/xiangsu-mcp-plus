'use strict';
// Makeup layers in the open project, read and changed through their component editors (the same
// setters the inspector uses, so the preview follows without a reload).
const { M, editingScene, sceneObjectPath, resolveByPath } = require('./common.cjs');

const KINDS = { FaceMaskComponentEditor: 'face_mask', EyeColorComponentEditor: 'eye_color', FilterComponentEditor: 'filter' };
// What each kind lets a change set; makeup_set refuses anything else.
const SETTABLE = {
  face_mask: ['female', 'male', 'intensity'],
  eye_color: ['intensity'],
  filter: ['intensity'],
};
const TEXTURE = 'PreviewTextureUpdated';
// Measured 2026-11-08 (still-photo video, liner and lashes switched off and back): a strength change
// shows from the second new frame on; one more for margin. The timeout leaves room for the 6 fps
// background mode.
const FRESH_FRAMES = 3;
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
      // The panel's 不透明度: the shader draws at clamp(intensity × female × external).
      intensity: comp.intensity,
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

  // changes: [{ object_path, female?, male?, intensity? }]. Returns each layer before and after, so the
  // caller can put it back.
  async makeupSet({ changes, label = 'makeup_set' }) {
    this.ensureCompatible('makeup');
    if (!Array.isArray(changes) || !changes.length) throw Error('INVALID_CHANGES: pass at least one change');
    const { EF, project } = editingScene(this);
    const all = tunables(this);
    const plan = changes.map((ch) => {
      const t = resolveByPath(all, ch.object_path, 'MAKEUP_LAYER');
      const keys = Object.keys(ch).filter((k) => k !== 'object_path' && ch[k] !== undefined);
      const bad = keys.filter((k) => !SETTABLE[t.kind].includes(k));
      if (bad.length) throw Error(`NOT_SETTABLE: ${t.path} is a ${t.kind}; it takes ${SETTABLE[t.kind].join(', ')}, not ${bad.join(', ')}`);
      if (!keys.length) throw Error(`NOTHING_TO_SET: ${t.path}`);
      return { t, ch };
    });
    const before = plan.map(({ t }) => describe(project, t));
    EF.UndoSystem.instance.start(label);
    try {
      for (const { t, ch } of plan) {
        if (t.kind === 'face_mask') {
          if (ch.female !== undefined) set(t.comp, 'femaleIntensity', ch.female);
          if (ch.male !== undefined) set(t.comp, 'maleIntensity', ch.male);
          if (ch.intensity !== undefined) set(t.comp, 'intensity', ch.intensity);
        } else set(t.comp, 'intensity', ch.intensity);
      }
    } finally {
      EF.UndoSystem.instance.end();
    }
    const after = plan.map(({ t }) => describe(project, t));
    for (const [i, { t, ch }] of plan.entries()) {
      const a = after[i];
      const off = [];
      for (const k of ['female', 'male', 'intensity']) if (ch[k] !== undefined && Math.abs(a[k] - ch[k]) > 1e-4) off.push(`${k}=${a[k]}`);
      if (off.length) throw Error(`WRITE_NOT_APPLIED: ${t.path}: ${off.join(', ')}`);
    }
    return { before, after };
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

const METHODS = { makeup_list: 'makeupList', makeup_set: 'makeupSet', preview_fresh: 'previewFresh' };

module.exports = { methods, METHODS, KINDS, SETTABLE, tunables, describe };
