'use strict';
// AI 妆容 (素材库 › AI 妆容): a portrait of a made-up face becomes five makeup textures (面部, 美瞳, 眼部,
// 睫毛, 唇部) with recommended strengths, imported as layers under 「面部面具」. Everything goes through
// the panel's own AIMakeupManager (AssetsLibrary.getInstance().aiMakeupManager), so the panel lists the
// same tasks and the layers are built by the editor's own code.
const fs = require('fs');
const path = require('path');
const { M, STATE_ROOT, editingScene, sceneObjectSet, addedObjectEditors, describeAdded, sceneObjectPath, projectResources, packageRootsAdded, recordImport } = require('./common.cjs');
const { tunables, describe } = require('./makeup.cjs');

// The panel's own checks (9.8.1): its file filter takes png / jpg / jpeg, its tip says 「不超过 10MB」.
const IMAGE_LIMIT = { exts: ['png', 'jpg', 'jpeg'], maxMB: 10 };
const STATUS = { 1: 'running', 2: 'finished', 3: 'failed', 4: 'discarded' };
// The toast event the manager reports its failures on (upload, submit, layer creation).
const TOAST = 'assetAIVideoToast';
// Picked: tasks finished 5 s after submitting (history, 2026-11-11), so a second between checks.
const POLL_MS = 1000;
// Same as the panel's download of a part.
const DOWNLOAD_TIMEOUT_MS = 30000;
// Measured: the history API answers 5062 「超出最大条数限制」 for a page of more than 20.
const HISTORY_PAGE = 20;
// Picked, as for AI 3D: 10 pages of 20 reach well past what anyone imports from.
const HISTORY_PAGES = 10;
// Picked: textures loaded in 0.07–0.17 s (2026-11-11), so one that takes this long never will.
const LOAD_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : null);

function checkImage(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error(`IMAGE_PATH_NOT_ABSOLUTE: ${file}`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw Error(`IMAGE_NOT_FOUND: ${file}`);
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!IMAGE_LIMIT.exts.includes(ext)) throw Error(`IMAGE_FORMAT: ${path.basename(file)}; supported: ${IMAGE_LIMIT.exts.join(', ')}`);
  const mb = fs.statSync(file).size / (1024 * 1024);
  if (mb > IMAGE_LIMIT.maxMB) throw Error(`IMAGE_TOO_LARGE: ${mb.toFixed(1)} MB; the limit is ${IMAGE_LIMIT.maxMB} MB`);
}

// A part's recommended strengths in the names makeup_layers and makeup_compare use.
function partParams(key, p = {}) {
  if (key === 'pupil') return { intensity: p.intensity ?? null, reflect_intensity: p.reflect_intensity ?? null, blend_mode: p.blend_mode ?? null, reflect_blend_mode: p.reflect_blend_mode ?? null };
  return { intensity: p.intensity ?? null, female: p.female_opacity ?? null, male: p.male_opacity ?? null, blend_mode: p.blend_mode ?? null };
}

function writePreview(file, dataUrl) {
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(dataUrl.slice(prefix.length), 'base64'));
  return file;
}

const methods = {
  aiMakeup() {
    return this.mod(M.assetsLibrary).AssetsLibrary.getInstance().aiMakeupManager;
  },

  aiMakeupConst() {
    return this.mod(M.aiMakeupConst);
  },

  // Part keys in the order the task's images come in, with the panel's names (面部, 美瞳…).
  aiMakeupParts() {
    const K = this.aiMakeupConst();
    return K.MakeupPartsIndex.map((key) => ({ key, name: K.MakeupParts.find((p) => p.key === key).value }));
  },

  async aiMakeupHistory(cursor, size, statusList = [1, 2, 3]) {
    const res = await this.mod(M.aiEffectApi).queryAITaskHistories({ cursor, size, scene: this.aiMakeupConst().AIMakeupManagerScene, statusList }, true);
    if (!res || res.code !== 0) throw Error(`AI_MAKEUP_HISTORY_FAILED: code=${res && res.code} message=${(res && res.message) || ''}`);
    return res.data || {};
  },

  // The history record of one task, or null when it is not among the latest HISTORY_PAGES pages.
  async aiMakeupRecord(task_id) {
    let cursor = 0;
    for (let page = 0; page < HISTORY_PAGES; page++) {
      const data = await this.aiMakeupHistory(cursor, HISTORY_PAGE);
      const hit = (data.taskRecords || []).find((t) => String(t.taskId) === task_id);
      if (hit) return hit;
      if (!data.hasMore) return null;
      cursor = data.nextCursor;
    }
    return null;
  },

  async aiMakeupFind(task_id) {
    if (typeof task_id !== 'string' || !task_id) throw Error('INVALID_TASK_ID: task_id must be a non-empty string');
    const record = await this.aiMakeupRecord(task_id);
    if (!record) throw Error(`AI_MAKEUP_TASK_NOT_FOUND: ${task_id} is not among this account's latest ${HISTORY_PAGES * HISTORY_PAGE} AI 妆容 tasks`);
    return record;
  },

  // One task as the panel reads it (its taskRecordToMessage), plus what the history record adds.
  async aiMakeupView(record, { previews = false } = {}) {
    const mgr = this.aiMakeup();
    const msg = await mgr.taskRecordToMessage(record);
    const detail = msg.detail ? JSON.parse(msg.detail) : {};
    const out = {
      task_id: String(record.taskId),
      status: STATUS[record.status] || String(record.status),
      created_at: iso(record.createTime),
      finished_at: record.status === 1 ? null : iso(record.finishTime),
      reference_image_url: msg.raw || null,
    };
    if (record.status === 3) out.failure = { message: record.message || record.taskMsg || null, code: record.errorCode ?? null };
    if (record.status !== 2) return out;
    out.parts = this.aiMakeupParts().map(({ key, name }, i) => ({ part: key, name, image_url: msg.assets[i] || null, ...partParams(key, detail[key]) }));
    if (!previews) return out;
    // The panel's 整妆 preview: the makeup on its built-in sample face. Its other preview lays the
    // face-space textures over the whole reference photo without finding the face, so it is not used.
    try {
      out.preview_file = writePreview(path.join(STATE_ROOT, 'ai-makeup', `${out.task_id.replace(/[^\w-]/g, '_')}.png`), await mgr.ensurePartPreview(msg, 'all'));
      if (!out.preview_file) out.preview_error = 'the editor made no preview (a texture could not be downloaded)';
    } catch (e) {
      out.preview_error = String(e.message || e);
    }
    return out;
  },

  async aiMakeupSubmit({ image_path, wait_s = 0 }) {
    this.ensureCompatible('aiMakeup');
    checkImage(image_path);
    // The panel keeps 「立即提取」 disabled while one of its tasks runs.
    const running = (await this.aiMakeupHistory(0, 1, [1])).taskRecords || [];
    if (running.length) throw Error(`AI_MAKEUP_RUNNING: task ${running[0].taskId} is still running; the panel extracts one at a time, wait with ai_makeup_tasks`);
    const mgr = this.aiMakeup();
    const before = new Set(mgr.taskRecordList.getValue().map((r) => r.taskId));
    const bus = this.mod(M.events).BusinessEventManager.TypeGuard();
    const toasts = [];
    const onToast = (m) => toasts.push(String(m));
    bus.on(TOAST, onToast);
    try {
      await mgr.submitMakeupExtract(image_path);
    } finally {
      bus.off(TOAST, onToast);
    }
    const rec = mgr.taskRecordList.getValue().find((r) => !before.has(r.taskId));
    if (!rec) throw Error(`AI_MAKEUP_SUBMIT_FAILED: ${toasts.join('; ') || 'the editor added no task'}`);
    return this.aiMakeupTask({ task_id: String(rec.taskId), wait_s });
  },

  // One task; with wait_s it waits until the task stops running or the time is up. A finished task comes
  // with the panel's previews.
  async aiMakeupTask({ task_id, wait_s = 0 }) {
    this.ensureCompatible('aiMakeup');
    if (typeof task_id !== 'string' || !task_id) throw Error('INVALID_TASK_ID: task_id must be a non-empty string');
    const api = this.mod(M.aiEffectApi);
    const poll = this.aiMakeupPollMs ?? POLL_MS;
    const until = Date.now() + wait_s * 1000;
    for (;;) {
      const res = await api.queryAIGCResult({ taskId: task_id });
      if (!res || res.code !== 0 || !res.data) throw Error(`AI_MAKEUP_QUERY_FAILED: task ${task_id} code=${res && res.code} message=${(res && res.message) || ''}`);
      if (res.data.status !== 1 || Date.now() + poll > until) break;
      await sleep(poll);
    }
    // Lets the panel's own list catch up, so its 「立即提取」 is not left disabled by a stale record.
    this.aiMakeup().updateTaskProgress();
    return this.aiMakeupView(await this.aiMakeupFind(task_id), { previews: true });
  },

  async aiMakeupTasks({ cursor = 0, count = HISTORY_PAGE }) {
    this.ensureCompatible('aiMakeup');
    const data = await this.aiMakeupHistory(cursor, count);
    const items = [];
    for (const r of data.taskRecords || []) items.push(await this.aiMakeupView(r));
    return { items, next_cursor: data.nextCursor ?? null, has_more: !!data.hasMore };
  },

  // The panel writes the pupil's texture and strengths to a JSScriptComponent, which the EyeColorV2 layer
  // of 9.8.1 does not have, so its layers keep the built-in brown iris at 0.8. The same values go to the
  // EyeColorV2 editor here; the defaults are the panel's.
  aiMakeupSetPupil(so, texture, p) {
    const t = tunables(this).find((x) => x.comp.sceneObject === so && x.kind === 'eye_color');
    if (!t) throw Error(`AI_MAKEUP_PUPIL_FAILED: ${sceneObjectPath(so)} has no 美瞳 component`);
    const values = {
      makeupTexture: texture.mainObject,
      intensity: p.intensity ?? 0.8,
      reflectionIntensity: p.reflect_intensity ?? 0.8,
      // BlendModeType: 0 Normal, 3 Add.
      blendMode: p.blend_mode ?? 0,
      reflectionBlendMode: p.reflect_blend_mode ?? 3,
      isOpacityEnabled: false,
    };
    for (const [k, v] of Object.entries(values)) {
      const res = t.comp.setProperty(k, v);
      if (res instanceof Error) throw Error(`AI_MAKEUP_PUPIL_FAILED: ${k}: ${res.message}`);
    }
  },

  // What the panel's 「导入素材」 does for the chosen parts of one task, without touching the panel's own
  // selection: each texture is downloaded under the panel's file name, imported and tagged the panel's
  // way, and its layer is built by the manager's createCorrespondingEntity.
  async aiMakeupImport({ task_id, parts }) {
    this.ensureCompatible('aiMakeup');
    const all = this.aiMakeupParts();
    const keys = all.map((p) => p.key);
    const want = parts === undefined ? keys : parts;
    if (!Array.isArray(want) || !want.length) throw Error(`INVALID_PARTS: pass some of ${keys.join(', ')}`);
    const bad = want.filter((k) => !keys.includes(k));
    if (bad.length) throw Error(`INVALID_PARTS: ${bad.join(', ')}; valid: ${keys.join(', ')}`);
    const mgr = this.aiMakeup();
    if (mgr.isImporting.getValue()) throw Error('AI_MAKEUP_IMPORT_IN_PROGRESS: the panel is importing; try again when it is done');
    const { EF, sceneEditor, project } = editingScene(this);
    const record = await this.aiMakeupFind(task_id);
    if (record.status !== 2) throw Error(`AI_MAKEUP_NOT_FINISHED: task ${task_id} is ${STATUS[record.status] || record.status}`);
    const msg = await mgr.taskRecordToMessage(record);
    const detail = msg.detail ? JSON.parse(msg.detail) : {};
    const cache = path.join(EF.Resource.EditorFoundation.env.getSharedCachePath(), 'AIGC');
    fs.mkdirSync(cache, { recursive: true });
    const RIH = this.mod(M.resImport).ResourceImportHandles;
    const loki = this.mod(M.lokiUtils);
    const bus = this.mod(M.events).BusinessEventManager.TypeGuard();
    const before = sceneObjectSet(sceneEditor);
    const beforePaths = new Set(projectResources(project).map((r) => r.assetPath));
    const layers = [];
    const skipped = [];
    const toasts = [];
    const onToast = (m) => toasts.push(String(m));
    mgr.isImporting.next(true);
    bus.on(TOAST, onToast);
    try {
      for (const { key, name } of all) {
        if (!want.includes(key)) continue;
        const url = msg.assets[keys.indexOf(key)];
        if (!url) {
          skipped.push({ part: key, name, reason: '这次提取没有这个部位的贴图' });
          continue;
        }
        const fileName = `AI 美妆_${name}.png`;
        const file = path.join(cache, fileName);
        try {
          await loki.downloadTemplateFile(url, file, DOWNLOAD_TIMEOUT_MS, true);
        } catch (e) {
          throw Error(`AI_MAKEUP_DOWNLOAD_FAILED: ${name}: ${e.message || e}`);
        }
        const item = RIH.importExtAsset([file], true, undefined, true);
        if (!item) throw Error(`AI_MAKEUP_IMPORT_FAILED: the editor could not import ${fileName}`);
        const id = `AIAsset_MakeUp_${task_id}_${key}`;
        item.assetPackageID = id;
        item.assetStudioData = { id, styleTag: 'AIAsset_MakeUp', type: 'AIAsset_MakeUp' };
        const loaded = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), this.aiMakeupLoadTimeoutMs ?? LOAD_TIMEOUT_MS);
          RIH.registerLoadingCallbackByResItem(item, (res, state) => {
            clearTimeout(timer);
            resolve(state === 'loaded' ? res : null);
          });
        });
        if (!loaded) throw Error(`AI_MAKEUP_IMPORT_FAILED: ${fileName} did not load`);
        const partBefore = sceneObjectSet(sceneEditor);
        mgr.createCorrespondingEntity({ params: JSON.stringify(detail[key] || {}), type: key, name: fileName }, loaded);
        // The layer is named after the file, with 「 (1)」 and so on when the name is taken; the first
        // layer also brings 「面部面具」 and its camera when the scene has none.
        const so = sceneEditor.getAllSceneObjectEditors().find((o) => !partBefore.has(o) && o.name.startsWith(`AI 美妆_${name}`));
        if (!so) throw Error(`AI_MAKEUP_LAYER_FAILED: ${name}: ${toasts.join('; ') || 'the editor added no layer'}`);
        if (key === 'pupil') this.aiMakeupSetPupil(so, loaded, detail[key] || {});
        layers.push({ part: key, name, so, texture: path.relative(project.path, loaded.assetPath) });
      }
    } finally {
      bus.off(TOAST, onToast);
      mgr.isImporting.next(false);
    }
    if (!layers.length) throw Error(`AI_MAKEUP_NOTHING_IMPORTED: task ${task_id} has no texture for ${want.join(', ')}`);
    const set = tunables(this);
    const out = layers.map(({ part, name, so, texture }) => {
      const t = set.find((x) => x.comp.sceneObject === so);
      if (!t) throw Error(`AI_MAKEUP_LAYER_FAILED: ${sceneObjectPath(so)} has no makeup component`);
      recordImport(project, [so], [texture]);
      return { part, name, ...describe(project, t), object_path: sceneObjectPath(so), texture };
    });
    const added = addedObjectEditors(before, sceneEditor);
    return {
      task_id,
      added_objects: describeAdded(added, before, sceneEditor),
      layers: out,
      skipped_parts: skipped,
      package_folders: packageRootsAdded(project, beforePaths),
    };
  },
};

const METHODS = {
  ai_makeup_submit: 'aiMakeupSubmit',
  ai_makeup_task: 'aiMakeupTask',
  ai_makeup_tasks: 'aiMakeupTasks',
  ai_makeup_import: 'aiMakeupImport',
};

module.exports = { methods, METHODS, IMAGE_LIMIT, HISTORY_PAGE };
