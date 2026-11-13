'use strict';
// 素材库 › AI 生成 › 画面特效 (new in 9.8.3): a prompt and up to 10 reference images or one reference
// video become a full-frame visual effect (a cloud workflow), previewed as a video and imported into the
// project as a surface graph. Everything goes through the panel's own AIVisualEffectManager
// (AssetsLibrary.getInstance().aiVisualEffectManager), so uploads, the reference-video audit, polling,
// the preview download and the import stay the editor's, and the panel shows the same tasks.
const fs = require('fs');
const path = require('path');
const { M, STATE_ROOT, editingScene, sceneObjectSet, addedObjectEditors, sceneObjectPath, projectResources, packageRootsAdded, recordImport } = require('./common.cjs');

const TOAST = 'assetAIVideoToast';
// Picked: often enough to see a reference upload or a state change soon; only reads memory.
const POLL_MS = 1000;
// Derived: the editor's own reference-video audit gives up within 15 min (its timeout message); this guards a hang.
const AUDIT_TIMEOUT_MS = 960000;
// Picked: how long a history query may take before it counts as stuck.
const HISTORY_TIMEOUT_MS = 30000;
// Picked: how far back a task_id is looked up (pages of 20, the panel's own page size).
const HISTORY_PAGES = 10;
// Picked, as for AR 视频: six frames across the preview show the effect in one image.
const STRIP_FRAMES = 6;
const STRIP_HEIGHT = 320;
const QUOTA_NOTE = '生成在云端进行，会占用账号的 AI 模型使用次数（按特效师等级给）；编辑器里查不到剩余次数和单次扣多少。';
const STATUS = { generating: 'running', downloading_preview: 'running', importing: 'succeeded', succeeded: 'succeeded', imported: 'imported', failed: 'failed', audit_failed: 'audit_failed', canceled: 'canceled' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

function checkPath(file, what) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error(`${what}_PATH_NOT_ABSOLUTE: ${file}`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw Error(`${what}_NOT_FOUND: ${file}`);
  return file;
}

const methods = {
  aiVfx() {
    const mgr = this.mod(M.assetsLibrary).AssetsLibrary.getInstance().aiVisualEffectManager;
    // resume() binds the manager to the signed-in account and re-arms polling, as opening the page does.
    mgr.resume();
    return mgr;
  },

  aiVfxLimits() {
    const C = this.mod(M.aiVfxManager);
    return {
      duration_s: { ...C.VisualEffectDurationRange },
      max_reference_images: C.VisualEffectReferenceLimits.images,
      max_reference_videos: C.VisualEffectReferenceLimits.videos,
      max_running: C.VisualEffectMaxConcurrentTasks,
      image_formats: this.mod(M.aiVfxInput).visualEffectImageExtensions,
      video_formats: this.mod(M.aiVfxInput).visualEffectVideoExtensions,
    };
  },

  async aiVfxHistorySettled(mgr) {
    const until = Date.now() + (this.aiVfxHistoryTimeoutMs ?? HISTORY_TIMEOUT_MS);
    while (mgr.historyLoading.getValue()) {
      if (Date.now() > until) throw Error('AI_VFX_HISTORY_TIMEOUT: the panel history did not finish loading');
      await sleep(this.aiVfxPollMs ?? POLL_MS);
    }
    if (mgr.historyError.getValue()) throw Error(`AI_VFX_HISTORY_FAILED: ${mgr.historyError.getValue()}`);
  },

  async aiVfxRefresh(mgr) {
    await this.aiVfxHistorySettled(mgr);
    await mgr.queryTaskList(true);
    await this.aiVfxHistorySettled(mgr);
  },

  async aiVfxFind(task_id) {
    if (typeof task_id !== 'string' || !task_id) throw Error('INVALID_TASK_ID: task_id must be a non-empty string');
    const mgr = this.aiVfx();
    const hit = () => mgr.taskRecordList.getValue().find((t) => t.workflowId === task_id);
    if (hit()) return hit();
    await this.aiVfxRefresh(mgr);
    for (let page = 1; !hit() && mgr.historyHasMore.getValue() && page < HISTORY_PAGES; page++) {
      await mgr.queryTaskList(false);
      await this.aiVfxHistorySettled(mgr);
    }
    if (!hit()) throw Error(`AI_VFX_TASK_NOT_FOUND: ${task_id} is not among this account's latest 画面特效 tasks`);
    return hit();
  },

  async aiVfxStrip(task_id, video, seconds) {
    const file = path.join(STATE_ROOT, 'ai-vfx', `${task_id.replace(/[^\w-]/g, '_')}.jpg`);
    if (fs.existsSync(file) && fs.statSync(file).mtimeMs >= fs.statSync(video).mtimeMs) return file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await this.mod(M.ffmpeg).ffmpegExec(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', video, '-vf', `fps=${STRIP_FRAMES}/${seconds},scale=-2:${STRIP_HEIGHT},tile=${STRIP_FRAMES}x1`, '-frames:v', '1', '-q:v', '3', file]);
    if (!fs.existsSync(file)) throw Error('ffmpeg wrote no image');
    return file;
  },

  async aiVfxView(t) {
    const out = {
      task_id: t.workflowId || null,
      name: t.name || null,
      status: STATUS[t.state] || t.state,
      created_at: iso(t.createdAt),
      prompt: t.prompt ?? null,
      duration_s: t.durationSeconds ?? null,
      references: (t.referenceMedia || []).map((m) => m.type),
      generation_mode: t.generationMode === 'secondary_edit' ? 'edit' : 'initial',
      output_type: t.outputType || null,
    };
    if (['failed', 'audit_failed'].includes(t.state)) out.failure = t.errorMessage || null;
    if (['succeeded', 'imported', 'importing'].includes(t.state) && t.previewArtifact && t.workflowId) {
      try {
        const local = t.previewVideoPath && !/^https?:/.test(t.previewVideoPath) && fs.existsSync(t.previewVideoPath) ? t.previewVideoPath : await this.mod(M.aiVfxPreview).ensureGeneratedVisualEffectPreview(t.workflowId, t.previewArtifact);
        out.preview_video_file = local;
        out.preview_image_file = await this.aiVfxStrip(t.workflowId, local, t.durationSeconds || 5);
      } catch (e) {
        out.preview_error = String(e.message || e);
      }
    }
    return out;
  },

  async aiVfxSubmit({ prompt = '', reference_images = [], reference_video, duration_s }) {
    this.ensureCompatible('aiVfx');
    const limits = this.aiVfxLimits();
    const text = String(prompt).trim();
    const duration = duration_s ?? limits.duration_s.default;
    if (!Number.isInteger(duration) || duration < limits.duration_s.min || duration > limits.duration_s.max) throw Error(`INVALID_DURATION: ${duration_s}; ${limits.duration_s.min}–${limits.duration_s.max} s`);
    if (reference_images.length > limits.max_reference_images) throw Error(`TOO_MANY_REFERENCES: at most ${limits.max_reference_images} images`);
    const refs = [...reference_images.map((f) => ['image', checkPath(f, 'REFERENCE')]), ...(reference_video ? [['video', checkPath(reference_video, 'REFERENCE')]] : [])];
    if (!text && !refs.length) throw Error('INPUT_REQUIRED: give a prompt or at least one reference (请输入特效描述或添加效果参考)');
    const validate = this.mod(M.aiVfxInput).validateVisualEffectFile;
    for (const [type, file] of refs) {
      const bad = validate(file, type);
      if (bad) throw Error(`AI_VFX_INPUT_INVALID: ${path.basename(file)}: ${bad.message}`);
    }
    const mgr = this.aiVfx();
    await this.aiVfxHistorySettled(mgr);
    if (mgr.submitting.getValue() || mgr.importing.getValue()) throw Error('AI_VFX_BUSY: the panel is submitting or importing; try again when it is done');
    if (mgr.activeTaskCount >= limits.max_running) throw Error(`AI_VFX_TOO_MANY_RUNNING: ${mgr.activeTaskCount} 画面特效 tasks are running (at most ${limits.max_running})`);

    const bus = this.mod(M.events).BusinessEventManager.TypeGuard();
    const toasts = [];
    const onToast = (m) => toasts.push(String(m));
    bus.on(TOAST, onToast);
    try {
      // The panel's input fields belong to one task at a time; leaving the page clears them and moves
      // running tasks to the background, as switching away from the panel does.
      mgr.leavePage();
      mgr.updatePrompt(text);
      mgr.updateDurationSeconds(duration);
      for (const [type, file] of refs) mgr.updateReferenceMedia(type, file);
      const until = Date.now() + (this.aiVfxAuditTimeoutMs ?? AUDIT_TIMEOUT_MS);
      while (mgr.referenceMedia.getValue().some((m) => ['uploading', 'auditing'].includes(m.auditStatus))) {
        if (Date.now() > until) throw Error('AI_VFX_AUDIT_TIMEOUT: the reference video is still being uploaded or audited');
        await sleep(this.aiVfxPollMs ?? POLL_MS);
      }
      const refused = mgr.getReferenceAdmissionError(mgr.referenceMedia.getValue());
      if (refused) throw Error(`AI_VFX_REFERENCE_REJECTED: ${refused}`);
      const before = new Set(mgr.taskRecordList.getValue().map((t) => t.attemptId));
      await mgr.submit('initial');
      const task = mgr.currentTask.getValue();
      if (!task || before.has(task.attemptId)) throw Error(`AI_VFX_SUBMIT_REFUSED: ${toasts.join('; ') || mgr.errorMessage.getValue() || 'the editor started no task'}`);
      if (!task.workflowId) throw Error(`AI_VFX_SUBMIT_FAILED: ${task.errorMessage || mgr.errorMessage.getValue() || toasts.join('; ') || task.state}`);
      mgr.leavePage();
      return { task_id: task.workflowId, name: task.name || null, prompt: text, duration_s: duration, references: refs.map(([type]) => type), quota: QUOTA_NOTE };
    } catch (e) {
      mgr.leavePage();
      throw e;
    } finally {
      bus.off(TOAST, onToast);
    }
  },

  async aiVfxTasks({ offset = 0, count = 20 }) {
    this.ensureCompatible('aiVfx');
    const mgr = this.aiVfx();
    await this.aiVfxRefresh(mgr);
    for (let page = 1; mgr.taskRecordList.getValue().length < offset + count && mgr.historyHasMore.getValue() && page < HISTORY_PAGES; page++) {
      await mgr.queryTaskList(false);
      await this.aiVfxHistorySettled(mgr);
    }
    const all = mgr.taskRecordList.getValue();
    const items = [];
    for (const t of all.slice(offset, offset + count)) items.push(await this.aiVfxView(t));
    const next = offset + count;
    return { items, next_offset: next, has_more: next < all.length || !!mgr.historyHasMore.getValue(), limits: this.aiVfxLimits() };
  },

  async aiVfxTask({ task_id, wait_s = 0 }) {
    this.ensureCompatible('aiVfx');
    const running = this.mod(M.aiVfxManager).isVisualEffectTaskRunning;
    let t = await this.aiVfxFind(task_id);
    const until = Date.now() + wait_s * 1000;
    const poll = this.aiVfxPollMs ?? POLL_MS * 3;
    while (running(t) && Date.now() + poll <= until) {
      await sleep(poll);
      // Reloading the history also picks up a task the panel's own polling is not following.
      await this.aiVfxRefresh(this.aiVfx());
      t = await this.aiVfxFind(task_id);
    }
    return this.aiVfxView(t);
  },

  async aiVfxImport({ task_id }) {
    this.ensureCompatible('aiVfx');
    const mgr = this.aiVfx();
    const t = await this.aiVfxFind(task_id);
    if (!['succeeded', 'imported'].includes(t.state) || !t.artifact) throw Error(`AI_VFX_NOT_READY: task ${task_id} is ${STATUS[t.state] || t.state}; wait with ai_vfx_tasks first`);
    if (mgr.importing.getValue() || mgr.submitting.getValue()) throw Error('AI_VFX_BUSY: the panel is importing or submitting; try again when it is done');
    const { sceneEditor, project } = editingScene(this);
    const before = sceneObjectSet(sceneEditor);
    const beforePaths = new Set(projectResources(project).map((r) => r.assetPath));
    const bus = this.mod(M.events).BusinessEventManager.TypeGuard();
    const toasts = [];
    const onToast = (m) => toasts.push(String(m));
    bus.on(TOAST, onToast);
    let ok;
    try {
      mgr.selectedTask.next(t);
      ok = await mgr.importCurrentResult();
    } finally {
      bus.off(TOAST, onToast);
    }
    if (!ok) throw Error(`AI_VFX_IMPORT_FAILED: ${mgr.errorMessage.getValue() || toasts.filter((m) => m !== '画面特效已导入工程').join('; ') || 'the editor did not import it'}`);
    const added = addedObjectEditors(before, sceneEditor);
    const packageFolders = packageRootsAdded(project, beforePaths);
    if (!added.length && !packageFolders.length) throw Error(`AI_VFX_IMPORT_NO_CHANGE: task ${task_id} reported imported but the scene and the project resources did not change`);
    recordImport(project, added, packageFolders);
    return { task_id, added_objects: added.map((o) => ({ name: o.name, object_path: sceneObjectPath(o) })), package_folders: packageFolders };
  },

  async aiVfxCancel({ task_id }) {
    this.ensureCompatible('aiVfx');
    const mgr = this.aiVfx();
    const t = await this.aiVfxFind(task_id);
    if (!this.mod(M.aiVfxManager).isVisualEffectTaskRunning(t)) throw Error(`AI_VFX_NOT_RUNNING: task ${task_id} is ${STATUS[t.state] || t.state}`);
    await mgr.cancel(t);
    const after = mgr.taskRecordList.getValue().find((x) => x.attemptId === t.attemptId);
    if (!after) return { task_id, cancelled: true };
    if (after.state === 'canceled') return { task_id, cancelled: true };
    return { task_id, cancelled: false, status: STATUS[after.state] || after.state, note: '取消请求没有得到确认，编辑器会继续查询这个任务的状态；稍后用 ai_vfx_tasks 查看' };
  },
};

const METHODS = {
  ai_vfx_submit: 'aiVfxSubmit',
  ai_vfx_tasks: 'aiVfxTasks',
  ai_vfx_task: 'aiVfxTask',
  ai_vfx_import: 'aiVfxImport',
  ai_vfx_cancel: 'aiVfxCancel',
};

module.exports = { methods, METHODS };
