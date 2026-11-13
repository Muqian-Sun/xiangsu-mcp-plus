'use strict';
// AR 视频贴片 (素材库 › AI 素材 › AR 视频): a subject image or video, optionally with a motion prompt and
// reference media, becomes a matted video of the subject (Seedance in the cloud, matting and packing on
// this machine) that is placed in the scene as an AR plane. Everything goes through the ARVideoManager the
// panel itself uses (AssetsLibrary.getInstance().arVideoManager), so its input checks and conversions,
// audits, local composition, history cache and the toolbar's background task list stay the editor's own.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { M, STATE_ROOT, editingScene, sceneObjectSet, addedObjectEditors, sceneObjectPath, projectResources, packageRootsAdded, recordImport } = require('./common.cjs');

const MODES = ['direct', 'motion'];
// Picked: often enough to return soon after the cloud accepts the task, cheap since it only reads memory.
const SUBMIT_POLL_MS = 500;
// Picked, not measured: input conversion, uploads (60 s each in the editor) and the submit call (60 s).
const ACCEPT_TIMEOUT_MS = 240000;
// Derived: the editor's own audit gives up after AR_VIDEO_VIDEO_AUDIT_TIMEOUT_MS; this only guards a hang.
const AUDIT_SLACK_MS = 60000;
// Picked, as for AI 3D: often enough to notice a finished task soon.
const POLL_MS = 3000;
// Same as the panel's history page.
const HISTORY_PAGE = 20;
// Picked: how far back a task_id is looked up; 10 pages of 20 reach well past what anyone imports from.
const HISTORY_PAGES = 10;
// Picked: six frames show a 4–15 s move well enough to judge it; 320 px high keeps the strip under 200 KB.
const STRIP_FRAMES = 6;
const STRIP_HEIGHT = 320;
const QUOTA_NOTE =
  '会占用账号的 AI 模型使用次数：次数按特效师等级给，用完时报「模型使用次数达到上限，请提升特效师等级以获取更多次数」（错误码 2038）。编辑器里没有查询剩余次数或单次扣多少的接口，这里给不出具体数字。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const exists = (p) => typeof p === 'string' && p !== '' && fs.existsSync(p);

function checkPath(file, what) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error(`${what}_PATH_NOT_ABSOLUTE: ${file}`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw Error(`${what}_NOT_FOUND: ${file}`);
  return file;
}

// The panel's own reading of a request: a video subject with no prompt and no references is matted as it
// is; anything else has Seedance make the motion.
function modeOf(request) {
  const r = request || {};
  return r.subject && r.subject.type === 'video' && !String(r.prompt || '').trim() && !(r.references || []).length ? 'direct' : 'motion';
}

const methods = {
  arVideo() {
    return this.mod(M.assetsLibrary).AssetsLibrary.getInstance().arVideoManager;
  },

  arVideoLimits() {
    const C = this.mod(M.arVideoContract);
    return {
      min_duration_s: C.AR_VIDEO_MIN_DURATION_SECONDS,
      max_duration_s: C.getARVideoMaxOutputDurationSeconds(),
      default_duration_s: C.AR_VIDEO_DEFAULT_DURATION_SECONDS,
      max_total_input_video_s: C.getARVideoMaxTotalVideoDurationMs() / 1000,
      max_images: C.AR_VIDEO_MAX_IMAGE_COUNT,
      max_videos: C.AR_VIDEO_MAX_VIDEO_COUNT,
      max_prompt_length: C.AR_VIDEO_MAX_PROMPT_LENGTH,
      shadow_default: C.getARVideoWithShadowDefault(),
    };
  },

  // 9.8.1 gated the panel behind isARVideoEntryEnabled (switch dyeh_enable_ar_video_entry); 9.8.3 dropped
  // both and lists the panel in the asset library's navigation, which is what is checked here.
  arVideoEnsureEnabled() {
    this.ensureCompatible('arVideo');
    const key = this.mod(M.navConst).NavItemKey.ARVideo;
    const listed = this.mod(M.nav)
      .getDefaultNavList()
      .some((group) => group.some((item) => [item, ...(item.children || [])].some((e) => e.id === key)));
    if (!listed) throw Error('AR_VIDEO_DISABLED: 素材库导航里没有「AR 视频贴片」入口');
  },

  // Waits until the editor's audit of an uploaded video has passed; the editor rejects it itself on timeout.
  async arVideoAudited(mgr, media) {
    const A = this.mod(M.arVideoAudit);
    const until = Date.now() + this.mod(M.arVideoContract).AR_VIDEO_VIDEO_AUDIT_TIMEOUT_MS + AUDIT_SLACK_MS;
    const poll = this.arVideoSubmitPollMs ?? SUBMIT_POLL_MS;
    for (;;) {
      const state = mgr.getAuditState(media);
      if (state && state.status === A.ARVideoAuditStatus.Rejected) throw Error(`AR_VIDEO_AUDIT_REJECTED: ${path.basename(media.sourcePath || media.path)}: ${state.message || ''}`);
      if (!A.isAuditPending(state)) return;
      if (Date.now() + poll > until) throw Error(`AR_VIDEO_AUDIT_TIMEOUT: ${path.basename(media.sourcePath || media.path)} is still being audited`);
      await sleep(poll);
    }
  },

  async arVideoSubmit({ subject, mode, prompt = '', reference_images = [], reference_video, shadow, duration_s }) {
    this.arVideoEnsureEnabled();
    const C = this.mod(M.arVideoContract);
    const limits = this.arVideoLimits();
    if (!MODES.includes(mode)) throw Error(`INVALID_MODE: ${mode}; valid: ${MODES.join(', ')}`);
    checkPath(subject, 'SUBJECT');
    const subjectType = C.classifyARVideoMedia(subject);
    if (!subjectType) throw Error(`SUBJECT_FORMAT: ${path.basename(subject)}; 素材仅支持 JPG、JPEG、PNG、MP4、MOV`);
    const refs = [...reference_images.map((f) => [f, 'image']), ...(reference_video === undefined ? [] : [[reference_video, 'video']])];
    for (const [f, type] of refs) {
      checkPath(f, 'REFERENCE');
      if (C.classifyARVideoMedia(f) !== type) throw Error(`REFERENCE_FORMAT: ${path.basename(f)} is not ${type === 'image' ? 'a JPG / JPEG / PNG image' : 'an MP4 / MOV video'}`);
    }
    const text = String(prompt).trim();
    if (mode === 'direct') {
      if (subjectType !== 'video') throw Error('INVALID_ARGUMENTS: mode=direct only mattes a subject video as it is; an image subject needs mode=motion and a prompt');
      if (text || refs.length) throw Error('INVALID_ARGUMENTS: mode=direct takes no prompt and no references (with them the editor generates a new motion); use mode=motion');
    } else if (!text) throw Error('INVALID_ARGUMENTS: mode=motion needs a prompt describing the motion');
    if (text.length > limits.max_prompt_length) throw Error(`PROMPT_TOO_LONG: ${text.length} characters; the limit is ${limits.max_prompt_length}`);
    const seconds = duration_s ?? limits.default_duration_s;
    if (!Number.isInteger(seconds) || seconds < limits.min_duration_s || seconds > limits.max_duration_s) throw Error(`INVALID_DURATION: ${seconds}; 动作时长需要在 ${limits.min_duration_s}-${limits.max_duration_s} 秒之间（上限由编辑器开关 dyeh_ar_video_max_output_duration_s 决定）`);
    try {
      C.validateARVideoInputCounts([{ type: subjectType }, ...refs.map(([, type]) => ({ type }))]);
    } catch (e) {
      throw Error(`AR_VIDEO_TOO_MANY_INPUTS: ${e.message}`);
    }

    const mgr = this.arVideo();
    const MC = this.mod(M.arVideoManager);
    await mgr.refreshRecords();
    if (mgr.activeTaskCount >= MC.AR_VIDEO_MAX_CONCURRENT_TASKS) throw Error(`AR_VIDEO_TOO_MANY_RUNNING: ${MC.AR_VIDEO_CONCURRENT_LIMIT_MESSAGE}`);

    // The panel's own input step: copy, check against the Seedance limits, convert if needed, audit videos.
    const abort = new AbortController();
    const media = [];
    try {
      for (const [file, role] of [[subject, 'subject'], ...refs.map(([f]) => [f, 'reference'])]) {
        let m;
        try {
          m = await mgr.captureInput(file, media.slice(), abort.signal, role);
        } catch (e) {
          throw Error(`AR_VIDEO_INPUT_INVALID: ${path.basename(file)}: ${e.message}`);
        }
        media.push(m);
      }
      for (const m of media) if (m.type === 'video') await this.arVideoAudited(mgr, m);
    } catch (e) {
      abort.abort();
      for (const m of media) mgr.discardAudit(m);
      throw e;
    }

    // One generation at a time belongs to the panel's editor; an earlier one moves to the background,
    // as when the asset library is closed.
    if (mgr.isGenerating) mgr.closeEditor();
    mgr.clearError();
    const request = { subject: media[0], references: media.slice(1), prompt: text, durationSeconds: seconds, withShadow: shadow ?? limits.shadow_default };
    const run = mgr.generate(request);
    const id = mgr.editorTaskId;
    if (!id) throw Error(`AR_VIDEO_SUBMIT_REFUSED: ${mgr.operationError.getValue() || 'the editor did not start a generation'}`);
    let settled = false;
    run.then(
      () => (settled = true),
      () => (settled = true),
    );
    const poll = this.arVideoSubmitPollMs ?? SUBMIT_POLL_MS;
    const until = Date.now() + (this.arVideoAcceptTimeoutMs ?? ACCEPT_TIMEOUT_MS);
    for (;;) {
      const t = mgr.tasks.getValue().find((x) => x.id === id);
      if (t && t.recordTaskId) {
        if (mgr.editorTaskId === id) mgr.closeEditor();
        const named = mgr.tasks.getValue().find((x) => x.id === id) || t;
        const out = { task_id: String(t.recordTaskId), name: named.name || null, mode, subject_type: subjectType, references: request.references.map((m) => m.type), prompt: text, duration_s: seconds, shadow: request.withShadow, quota: QUOTA_NOTE };
        const trimmed = media.filter((m) => m.crop).map((m) => `${path.basename(m.sourcePath || m.path)} 超过可用时长，编辑器截取了 ${(m.crop.durationMs / 1000).toFixed(1)} 秒`);
        if (trimmed.length) out.input_notes = trimmed;
        return out;
      }
      if (t && (t.status === 'failed' || t.status === 'unconfirmed')) throw Error(`AR_VIDEO_SUBMIT_FAILED: ${t.errorMessage || t.status}${t.errorCode !== undefined ? ` (code ${t.errorCode})` : ''}`);
      if (!t || settled) throw Error(`AR_VIDEO_SUBMIT_FAILED: ${mgr.operationError.getValue() || (t ? t.errorMessage : '') || 'the generation ended before the cloud accepted it'}`);
      if (Date.now() + poll > until) throw Error(`AR_VIDEO_SUBMIT_TIMEOUT: not accepted by the cloud after ${Math.round((this.arVideoAcceptTimeoutMs ?? ACCEPT_TIMEOUT_MS) / 1000)} s (stage: ${t.stage}); it keeps running in the editor, check ar_video_tasks later`);
      await sleep(poll);
    }
  },

  // A strip of frames across the preview video, so the motion can be judged from one image.
  async arVideoStrip(task_id, video, seconds) {
    const file = path.join(STATE_ROOT, 'ar-video', `${task_id.replace(/[^\w-]/g, '_')}.jpg`);
    if (fs.existsSync(file) && fs.statSync(file).mtimeMs >= fs.statSync(video).mtimeMs) return file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await this.mod(M.ffmpeg).ffmpegExec(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', video, '-vf', `fps=${STRIP_FRAMES}/${seconds},scale=-2:${STRIP_HEIGHT},tile=${STRIP_FRAMES}x1`, '-frames:v', '1', '-q:v', '3', file]);
    if (!fs.existsSync(file)) throw Error('ffmpeg wrote no image');
    return file;
  },

  async arVideoView(t) {
    const r = t.request || {};
    const out = {
      task_id: t.recordTaskId ? String(t.recordTaskId) : null,
      name: t.name || null,
      status: t.status,
      stage: t.stage || null,
      created_at: iso(t.createdAt),
      mode: modeOf(r),
      subject_type: r.subject ? r.subject.type : null,
      references: (r.references || []).map((m) => m.type),
      prompt: r.prompt ?? null,
      duration_s: r.durationSeconds ?? null,
      shadow: r.withShadow ?? null,
    };
    if (t.status === 'failed' || t.status === 'unconfirmed') out.failure = { message: t.errorMessage || null, code: t.errorCode ?? null };
    const res = t.output && t.output.result;
    if (t.status === 'succeeded' && res) {
      const seconds = res.fps > 0 ? Number((res.frameCount / res.fps).toFixed(2)) : null;
      Object.assign(out, {
        seconds,
        size: { width: res.sourceWidth, height: res.sourceHeight },
        green_screen: !!res.greenScreen,
        audio: res.audioStatus || null,
        preview_video_file: exists(res.previewVideoPath) ? res.previewVideoPath : null,
        video_file: exists(res.mixedVideoPath) ? res.mixedVideoPath : null,
      });
      if (out.preview_video_file && out.task_id && seconds) {
        try {
          out.preview_image_file = await this.arVideoStrip(out.task_id, out.preview_video_file, seconds);
        } catch (e) {
          out.preview_image_file = null;
          out.preview_image_error = String(e.message || e);
        }
      }
    }
    return out;
  },

  // The manager's task for a cloud task id, loading older history pages when it is not among the loaded ones.
  async arVideoFind(task_id) {
    if (typeof task_id !== 'string' || !task_id) throw Error('INVALID_TASK_ID: task_id must be a non-empty string');
    const mgr = this.arVideo();
    const hit = () => mgr.tasks.getValue().find((t) => String(t.recordTaskId) === task_id);
    if (hit()) return hit();
    await mgr.refreshRecords();
    for (let page = 1; !hit() && mgr.recordHasMore && page < HISTORY_PAGES; page++) await mgr.loadMoreRecords();
    if (!hit()) throw Error(`AR_VIDEO_TASK_NOT_FOUND: ${task_id} is not in this account's latest ${HISTORY_PAGES * HISTORY_PAGE} AR 视频 tasks`);
    return hit();
  },

  async arVideoTasks({ offset = 0, count = HISTORY_PAGE }) {
    this.arVideoEnsureEnabled();
    const mgr = this.arVideo();
    await mgr.refreshRecords();
    while (mgr.tasks.getValue().length < offset + count && mgr.recordHasMore) await mgr.loadMoreRecords();
    const all = [...mgr.tasks.getValue()].sort((a, b) => b.createdAt - a.createdAt);
    const items = [];
    for (const t of all.slice(offset, offset + count)) items.push(await this.arVideoView(t));
    const next = offset + count;
    return { items, next_offset: next, has_more: next < all.length || !!mgr.recordHasMore, limits: this.arVideoLimits() };
  },

  // One task; with wait_s it waits until the result is composed on this machine, failed, or the time is up.
  async arVideoTask({ task_id, wait_s = 0 }) {
    this.arVideoEnsureEnabled();
    const mgr = this.arVideo();
    let t = await this.arVideoFind(task_id);
    const poll = this.arVideoPollMs ?? POLL_MS;
    const until = Date.now() + wait_s * 1000;
    while (['running', 'restoring'].includes(t.status) && Date.now() + poll <= until) {
      await sleep(poll);
      t = mgr.tasks.getValue().find((x) => x.id === t.id) || (await this.arVideoFind(task_id));
    }
    return this.arVideoView(t);
  },

  // What the panel's 「导入 AR 视频贴片」 does for one task, without touching the other selected results.
  async arVideoImport({ task_id }) {
    this.arVideoEnsureEnabled();
    const mgr = this.arVideo();
    const t = await this.arVideoFind(task_id);
    if (t.status !== 'succeeded' || !t.output) throw Error(`AR_VIDEO_NOT_READY: task ${task_id} is ${t.status}${t.stage ? `（${t.stage}）` : ''}; wait with ar_video_tasks first`);
    if (mgr.importing.getValue()) throw Error('AR_VIDEO_IMPORT_IN_PROGRESS: the panel is importing; try again when it is done');
    const { sceneEditor, project } = editingScene(this);
    const r = t.request;
    const source = {
      assetId: String(t.assetId ?? t.id),
      originTaskId: String(t.acceptedTaskId ?? t.taskId ?? t.id),
      originImportId: crypto.randomUUID(),
      generationMode: String(t.output.usedSeedance ? this.mod(M.arVideoAnalytics).arVideoInputFields(r.subject, r.references, r.prompt).generation_mode : 'video_direct'),
    };
    const before = sceneObjectSet(sceneEditor);
    const beforePaths = new Set(projectResources(project).map((x) => x.assetPath));
    mgr.importing.next(true);
    let res;
    try {
      res = await this.mod(M.arVideoProject).importARVideosToCurrentProject([{ result: t.output.result, source }]);
    } catch (e) {
      throw Error(`AR_VIDEO_IMPORT_FAILED: ${e.message}`);
    } finally {
      mgr.importing.next(false);
    }
    mgr.updateTask(t.id, { selected: false });
    const added = addedObjectEditors(before, sceneEditor);
    if (!added.length) throw Error(`AR_VIDEO_IMPORT_NO_OBJECT: task ${task_id} was imported but nothing was added to the scene`);
    const packageFolders = packageRootsAdded(project, beforePaths);
    recordImport(project, added, packageFolders);
    return {
      task_id,
      added_objects: added.map((o) => ({ name: o.name, object_path: sceneObjectPath(o) })),
      package_folders: packageFolders,
      plane_guid: res.selectedPlaneGuid || null,
    };
  },

  async arVideoCancel({ task_id }) {
    this.arVideoEnsureEnabled();
    const mgr = this.arVideo();
    const t = await this.arVideoFind(task_id);
    if (!['running', 'unconfirmed'].includes(t.status)) throw Error(`AR_VIDEO_NOT_RUNNING: task ${task_id} is ${t.status}`);
    mgr.clearError();
    await mgr.cancelTask(t.id);
    const after = mgr.tasks.getValue().find((x) => x.id === t.id);
    if (!after) return { task_id, cancelled: true };
    if (mgr.operationError.getValue()) throw Error(`AR_VIDEO_CANCEL_FAILED: ${mgr.operationError.getValue()}`);
    return { task_id, cancelled: false, status: after.status, note: '任务在取消前已经结束' };
  },
};

const METHODS = {
  ar_video_submit: 'arVideoSubmit',
  ar_video_tasks: 'arVideoTasks',
  ar_video_task: 'arVideoTask',
  ar_video_import: 'arVideoImport',
  ar_video_cancel: 'arVideoCancel',
};

module.exports = { methods, METHODS, MODES, HISTORY_PAGE };
