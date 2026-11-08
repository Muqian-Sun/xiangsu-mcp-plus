import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const STATE = tmpdir('xs-state-');
process.env.XIANGSU_MCP_EXT_STATE = STATE;
const { Library, M } = require('../editor-plugin/library.cjs');

function subject(v) {
  const s = { v, getValue: () => s.v, next: (x) => (s.v = x) };
  return s;
}

function file(dir, name, bytes = 16) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

// The part of the editor's ARVideoManager these tools drive: tasks and history pages, the input step,
// audits, one editor generation at a time, background tasks, cancel and the importing flag.
class FakeManager {
  constructor(opts) {
    this.opts = opts;
    this.calls = { refresh: 0, loadMore: 0, capture: [], generate: [], closeEditor: 0, discard: [], cancel: [], update: [] };
    this.tasks = subject([...(opts.tasks || [])]);
    this.pages = opts.pages || [];
    this.recordHasMore = this.pages.length > 0;
    this.operationError = subject('');
    this.importing = subject(false);
    this.audits = new Map();
    this.editorTaskId = opts.editorTaskId;
  }
  get isGenerating() {
    return !!this.editorTaskId;
  }
  get activeTaskCount() {
    return this.opts.active ?? this.tasks.getValue().filter((t) => t.status === 'running').length;
  }
  async refreshRecords() {
    this.calls.refresh++;
    this.recordHasMore = this.pages.length > 0;
    this.loaded = 0;
  }
  async loadMoreRecords() {
    this.calls.loadMore++;
    const page = this.pages[this.loaded++] || [];
    this.tasks.next([...this.tasks.getValue(), ...page.filter((p) => !this.tasks.getValue().some((t) => t.id === p.id))]);
    this.recordHasMore = this.loaded < this.pages.length;
  }
  async captureInput(file, existing, signal, role) {
    this.calls.capture.push({ file: path.basename(file), existing: existing.map((m) => path.basename(m.sourcePath)), role, aborted: signal.aborted });
    const bad = (this.opts.badInput || {})[path.basename(file)];
    if (bad) throw Error(bad);
    const type = /\.(mp4|mov)$/i.test(file) ? 'video' : 'image';
    const media = { path: `/inputs/${path.basename(file)}`, sourcePath: file, type, materialId: `m-${path.basename(file)}`, ...((this.opts.crop || {})[path.basename(file)] ? { crop: { startMs: 0, durationMs: this.opts.crop[path.basename(file)] } } : {}) };
    if (type === 'video') this.audits.set(media.materialId, { status: 'auditing', polls: 0 });
    return media;
  }
  getAuditState(media) {
    const a = this.audits.get(media.materialId);
    if (!a) return undefined;
    const outcome = (this.opts.audit || {})[path.basename(media.sourcePath)] || 'passed';
    if (++a.polls >= 3) return outcome === 'passed' ? { status: 'passed', vid: 'v1' } : { status: 'rejected', message: '存在安全风险，请修改提示词或参考素材' };
    return { status: 'auditing' };
  }
  discardAudit(media) {
    this.calls.discard.push(path.basename(media.sourcePath));
  }
  clearError() {
    this.operationError.next('');
  }
  closeEditor() {
    this.calls.closeEditor++;
    const id = this.editorTaskId;
    this.editorTaskId = undefined;
    this.updateTask(id, { background: true, name: 'AR 视频生成任务1' });
  }
  generate(request) {
    this.calls.generate.push(request);
    const g = this.opts.generate || {};
    if (g.refuse) {
      this.operationError.next(g.refuse);
      return Promise.resolve();
    }
    const id = `local-${this.calls.generate.length}`;
    this.editorTaskId = id;
    this.tasks.next([...this.tasks.getValue(), { id, status: 'running', stage: '正在准备素材…', createdAt: 1794131146000, request }]);
    return (async () => {
      await new Promise((r) => setTimeout(r, 5));
      if (g.fail) return this.updateTask(id, { status: 'failed', stage: '', errorMessage: g.fail, errorCode: g.code });
      if (g.never) return new Promise(() => {});
      this.updateTask(id, { recordTaskId: 'wf1', taskId: 'wf1', acceptedTaskId: 'wf1', stage: 'AI 正在生成视频…' });
    })();
  }
  async cancelTask(id) {
    this.calls.cancel.push(id);
    const c = this.opts.cancel || 'confirmed';
    if (c === 'confirmed') this.tasks.next(this.tasks.getValue().filter((t) => t.id !== id));
    else if (c === 'terminal') this.updateTask(id, { status: 'succeeded' });
    else this.operationError.next('取消失败，请稍后重试');
  }
  updateTask(id, patch) {
    this.calls.update.push({ id, patch });
    this.tasks.next(this.tasks.getValue().map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }
}

function setup(opts = {}) {
  const root = tmpdir('xs-arvideo-');
  const mgr = new FakeManager(opts);
  const calls = { ffmpeg: [], imported: [] };
  const sceneObjects = [{ name: '已有', parent: null }];
  const project = { path: path.join(root, 'proj'), resourceManager: { getAllResources: () => [] } };
  const exts = { '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.mp4': 'video', '.mov': 'video' };
  const modules = {
    [M.assetsLibrary]: { AssetsLibrary: { getInstance: () => ({ arVideoManager: mgr }) } },
    [M.arVideoManager]: { AR_VIDEO_MAX_CONCURRENT_TASKS: 10, AR_VIDEO_CONCURRENT_LIMIT_MESSAGE: '当前运行任务已达上限（10 个），请等待任一任务完成或取消后再试', default: FakeManager },
    [M.arVideoContract]: {
      AR_VIDEO_MIN_DURATION_SECONDS: 4,
      AR_VIDEO_DEFAULT_DURATION_SECONDS: 10,
      AR_VIDEO_MAX_IMAGE_COUNT: 9,
      AR_VIDEO_MAX_VIDEO_COUNT: 3,
      AR_VIDEO_MAX_PROMPT_LENGTH: 2000,
      AR_VIDEO_VIDEO_AUDIT_TIMEOUT_MS: 900000,
      getARVideoMaxOutputDurationSeconds: () => 15,
      getARVideoMaxTotalVideoDurationMs: () => 15000,
      getARVideoWithShadowDefault: () => true,
      classifyARVideoMedia: (f) => exts[path.extname(f).toLowerCase()],
      validateARVideoInputCounts: (list) => {
        if (list.filter((m) => m.type === 'image').length > 9) throw Error('包括主体在内最多支持 9 张图片');
        if (list.filter((m) => m.type === 'video').length > 3) throw Error('包括主体在内最多支持 3 段视频');
      },
    },
    [M.arVideoAudit]: { ARVideoAuditStatus: { Auditing: 'auditing', Passed: 'passed', Rejected: 'rejected' }, isAuditPending: (s) => !s || s.status !== 'passed' || !s.vid },
    [M.arVideoAnalytics]: { arVideoInputFields: (s, refs, prompt) => ({ generation_mode: s.type === 'video' ? 'video_ai' : prompt.trim() || refs.length ? 'image_ai' : 'image_default_motion' }) },
    [M.arVideoProject]: {
      importARVideosToCurrentProject: async (items) => {
        calls.imported.push({ items, importing: mgr.importing.getValue() });
        if (opts.importFails) throw Error('当前工程主场景尚未就绪');
        const top = { name: 'AR平面跟踪', parent: null };
        sceneObjects.push(top, { name: '视频贴片', parent: top });
        return { projectPath: project.path, sceneObjectCount: 1, selectedPlaneGuid: 'plane-1' };
      },
    },
    [M.nav]: { isARVideoEntryEnabled: () => opts.enabled ?? true },
    [M.ffmpeg]: {
      ffmpegExec: async (args) => {
        calls.ffmpeg.push(args);
        if (!opts.ffmpegFails) fs.writeFileSync(args.at(-1), 'jpg');
        return ['', ''];
      },
    },
    [M.ef]: { ProjectManager: { getInstance: () => ({ hasActiveProject: () => true, getCurrentActiveProject: () => project }) } },
    [M.scene]: { SceneModule: { getEditingSceneService: () => ({ sceneEditor: { getAllSceneObjectEditors: () => [...sceneObjects] } }) } },
  };
  const mod = (name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  };
  const lib = new Library(mod);
  lib.arVideoSubmitPollMs = 1;
  lib.arVideoPollMs = 1;
  return { lib, mgr, calls, modules, root, sceneObjects };
}

// A finished task the way the manager holds it once the result is composed on this machine.
function succeeded(root, id, extra = {}) {
  const dir = path.join(root, `video-${id}`);
  return {
    id: `local-${id}`,
    recordTaskId: id,
    taskId: id,
    acceptedTaskId: id,
    assetId: `vid-${id}`,
    name: 'AR 视频生成任务1',
    status: 'succeeded',
    stage: '',
    createdAt: 1794131146000,
    request: { subject: { type: 'image', path: '' }, references: [], prompt: '扭屁股', durationSeconds: 10, withShadow: false },
    output: {
      usedSeedance: true,
      result: { mixedVideoPath: file(dir, '混合透明.mp4'), previewVideoPath: file(dir, '抠图预览.mp4'), sourceWidth: 720, sourceHeight: 720, fps: 24, frameCount: 240, greenScreen: false, hasAlphaMask: true, audioStatus: 'available' },
    },
    ...extra,
  };
}

const QUOTA = /AI 模型使用次数.*2038.*查询剩余次数/;

test('ar_video_submit runs the panel input step, starts the generation and returns once the cloud accepts it', async () => {
  const { lib, mgr, root } = setup();
  const cat = file(root, 'cat.png');
  const hat = file(root, 'hat.PNG');
  const dance = file(root, 'dance.mp4');
  const out = await lib.arVideoSubmit({ subject: cat, mode: 'motion', prompt: '  扭屁股  ', reference_images: [hat], reference_video: dance, shadow: false, duration_s: 8 });
  assert.equal(mgr.calls.refresh, 1, 'running tasks are loaded before the concurrency check');
  assert.deepEqual(mgr.calls.capture, [
    { file: 'cat.png', existing: [], role: 'subject', aborted: false },
    { file: 'hat.PNG', existing: ['cat.png'], role: 'reference', aborted: false },
    { file: 'dance.mp4', existing: ['cat.png', 'hat.PNG'], role: 'reference', aborted: false },
  ]);
  const req = mgr.calls.generate[0];
  assert.deepEqual([req.subject.sourcePath, req.references.map((m) => m.sourcePath), req.prompt, req.durationSeconds, req.withShadow], [cat, [hat, dance], '扭屁股', 8, false]);
  assert.equal(mgr.getAuditState(req.references[1]).status, 'passed', 'the generation starts only after the video audit passed');
  assert.equal(mgr.calls.closeEditor, 1, 'the accepted task moves to the background');
  const { quota, ...rest } = out;
  assert.deepEqual(rest, { task_id: 'wf1', name: 'AR 视频生成任务1', mode: 'motion', subject_type: 'image', references: ['image', 'video'], prompt: '扭屁股', duration_s: 8, shadow: false });
  assert.match(quota, QUOTA);
});

test('ar_video_submit defaults: 10 s, the editor shadow default, direct for a video subject', async () => {
  const { lib, mgr, root } = setup({ crop: { 'walk.mov': 15000 } });
  const out = await lib.arVideoSubmit({ subject: file(root, 'walk.mov'), mode: 'direct' });
  const req = mgr.calls.generate[0];
  assert.deepEqual([req.prompt, req.references, req.durationSeconds, req.withShadow], ['', [], 10, true]);
  assert.deepEqual([out.mode, out.subject_type, out.duration_s, out.shadow], ['direct', 'video', 10, true]);
  assert.deepEqual(out.input_notes, ['walk.mov 超过可用时长，编辑器截取了 15.0 秒']);
});

test('ar_video_submit refuses what the panel would refuse before touching any input', async () => {
  const { lib, mgr, root } = setup();
  const cat = file(root, 'cat.png');
  const vid = file(root, 'v.mp4');
  for (const [args, re] of [
    [{ subject: cat, mode: 'direct' }, /INVALID_ARGUMENTS: mode=direct only mattes a subject video/],
    [{ subject: vid, mode: 'direct', prompt: '跳舞' }, /INVALID_ARGUMENTS: mode=direct takes no prompt and no references/],
    [{ subject: vid, mode: 'direct', reference_images: [cat] }, /mode=direct takes no prompt and no references/],
    [{ subject: cat, mode: 'motion', prompt: '   ' }, /INVALID_ARGUMENTS: mode=motion needs a prompt/],
    [{ subject: cat, mode: 'dance', prompt: 'x' }, /INVALID_MODE: dance/],
    [{ subject: cat, mode: 'motion', prompt: 'x'.repeat(2001) }, /PROMPT_TOO_LONG: 2001 characters; the limit is 2000/],
    [{ subject: cat, mode: 'motion', prompt: 'x', duration_s: 16 }, /INVALID_DURATION: 16; 动作时长需要在 4-15 秒之间/],
    [{ subject: cat, mode: 'motion', prompt: 'x', duration_s: 3 }, /INVALID_DURATION: 3/],
    [{ subject: 'cat.png', mode: 'motion', prompt: 'x' }, /SUBJECT_PATH_NOT_ABSOLUTE: cat.png/],
    [{ subject: path.join(root, 'none.png'), mode: 'motion', prompt: 'x' }, /SUBJECT_NOT_FOUND/],
    [{ subject: file(root, 'cat.webp'), mode: 'motion', prompt: 'x' }, /SUBJECT_FORMAT: cat.webp; 素材仅支持 JPG、JPEG、PNG、MP4、MOV/],
    [{ subject: cat, mode: 'motion', prompt: 'x', reference_video: cat }, /REFERENCE_FORMAT: cat.png is not an MP4 \/ MOV video/],
    [{ subject: cat, mode: 'motion', prompt: 'x', reference_images: [vid] }, /REFERENCE_FORMAT: v.mp4 is not a JPG/],
    [{ subject: cat, mode: 'motion', prompt: 'x', reference_images: Array(9).fill(cat) }, /AR_VIDEO_TOO_MANY_INPUTS: 包括主体在内最多支持 9 张图片/],
  ]) await assert.rejects(lib.arVideoSubmit(args), re, JSON.stringify(args).slice(0, 80));
  assert.equal((await lib.arVideoSubmit({ subject: cat, mode: 'motion', prompt: 'x', duration_s: 15, reference_images: Array(8).fill(cat) })).task_id, 'wf1');
  assert.equal(mgr.calls.capture.length, 9, 'only the accepted call reached the input step');

  const off = setup({ enabled: false });
  await assert.rejects(off.lib.arVideoSubmit({ subject: file(off.root, 'a.png'), mode: 'motion', prompt: 'x' }), /AR_VIDEO_DISABLED/);
  const busy = setup({ active: 10 });
  await assert.rejects(busy.lib.arVideoSubmit({ subject: file(busy.root, 'a.png'), mode: 'motion', prompt: 'x' }), /AR_VIDEO_TOO_MANY_RUNNING: 当前运行任务已达上限（10 个）/);
  assert.deepEqual([off.mgr.calls.capture, busy.mgr.calls.capture, busy.mgr.calls.generate], [[], [], []]);
});

test('ar_video_submit reports the editor input check and audit failures and drops the started audits', async () => {
  const bad = setup({ badInput: { 'hat.png': '图片自动压缩失败，请重新上传' } });
  const dance = file(bad.root, 'dance.mp4');
  await assert.rejects(bad.lib.arVideoSubmit({ subject: dance, mode: 'motion', prompt: 'x', reference_images: [file(bad.root, 'hat.png')] }), /AR_VIDEO_INPUT_INVALID: hat.png: 图片自动压缩失败，请重新上传/);
  assert.deepEqual([bad.mgr.calls.discard, bad.mgr.calls.generate], [['dance.mp4'], []]);

  const rejected = setup({ audit: { 'dance.mp4': 'rejected' } });
  await assert.rejects(rejected.lib.arVideoSubmit({ subject: file(rejected.root, 'dance.mp4'), mode: 'direct' }), /AR_VIDEO_AUDIT_REJECTED: dance.mp4: 存在安全风险/);
  assert.deepEqual([rejected.mgr.calls.discard, rejected.mgr.calls.generate], [['dance.mp4'], []]);
});

test('ar_video_submit reports a generation that ends before the cloud accepts it', async () => {
  const failed = setup({ generate: { fail: '模型使用次数达到上限，请提升特效师等级以获取更多次数', code: 2038 } });
  await assert.rejects(failed.lib.arVideoSubmit({ subject: file(failed.root, 'a.png'), mode: 'motion', prompt: 'x' }), /AR_VIDEO_SUBMIT_FAILED: 模型使用次数达到上限.* \(code 2038\)/);
  const refused = setup({ generate: { refuse: '视频素材仍在审核中，请稍候或重新选择素材' } });
  await assert.rejects(refused.lib.arVideoSubmit({ subject: file(refused.root, 'a.png'), mode: 'motion', prompt: 'x' }), /AR_VIDEO_SUBMIT_REFUSED: 视频素材仍在审核中/);
  const slow = setup({ generate: { never: true } });
  slow.lib.arVideoAcceptTimeoutMs = 30;
  await assert.rejects(slow.lib.arVideoSubmit({ subject: file(slow.root, 'a.png'), mode: 'motion', prompt: 'x' }), /AR_VIDEO_SUBMIT_TIMEOUT: not accepted by the cloud after 0 s \(stage: 正在准备素材…\); it keeps running in the editor/);
});

test('ar_video_submit moves a generation already running in the panel to the background first', async () => {
  const { lib, mgr, root } = setup({ editorTaskId: 'panel-run', tasks: [{ id: 'panel-run', status: 'running', createdAt: 1 }] });
  assert.equal((await lib.arVideoSubmit({ subject: file(root, 'a.png'), mode: 'motion', prompt: 'x' })).task_id, 'wf1');
  assert.equal(mgr.calls.closeEditor, 2);
  assert.equal(mgr.tasks.getValue().find((t) => t.id === 'panel-run').background, true);
  assert.equal(mgr.calls.generate.length, 1);
});

test('ar_video_tasks lists newest first with readable state, failure, local files and a frame strip', async () => {
  const s0 = setup();
  const done = succeeded(s0.root, 'wf1', { createdAt: 1794131146000 });
  const running = { id: 'r', recordTaskId: 'wf2', status: 'running', stage: 'AI 正在生成视频…', createdAt: 1794131200000, request: { subject: { type: 'video' }, references: [], prompt: '', durationSeconds: 10, withShadow: true } };
  const failed = { id: 'f', recordTaskId: 'wf0', status: 'failed', stage: '', createdAt: 1794131000000, errorMessage: '存在安全风险，请修改提示词或参考素材', errorCode: 28023051, request: { subject: { type: 'image' }, references: [{ type: 'image' }], prompt: '戴帽子', durationSeconds: 4, withShadow: true } };
  const { lib, mgr, calls } = setup({ pages: [[done, running], [failed]] });
  const page = await lib.arVideoTasks({ count: 2 });
  assert.equal(mgr.calls.loadMore, 1, 'one history page covers two tasks');
  assert.deepEqual(page.items.map((i) => [i.task_id, i.status, i.mode]), [['wf2', 'running', 'direct'], ['wf1', 'succeeded', 'motion']]);
  assert.deepEqual([page.next_offset, page.has_more, page.limits.max_duration_s, page.limits.shadow_default], [2, true, 15, true]);
  const strip = path.join(STATE, 'ar-video', 'wf1.jpg');
  assert.deepEqual(page.items[1], {
    task_id: 'wf1',
    name: 'AR 视频生成任务1',
    status: 'succeeded',
    stage: null,
    created_at: '2026-11-08T09:45:46.000Z',
    mode: 'motion',
    subject_type: 'image',
    references: [],
    prompt: '扭屁股',
    duration_s: 10,
    shadow: false,
    seconds: 10,
    size: { width: 720, height: 720 },
    green_screen: false,
    audio: 'available',
    preview_video_file: done.output.result.previewVideoPath,
    video_file: done.output.result.mixedVideoPath,
    preview_image_file: strip,
  });
  assert.deepEqual(calls.ffmpeg, [['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', done.output.result.previewVideoPath, '-vf', 'fps=6/10,scale=-2:320,tile=6x1', '-frames:v', '1', '-q:v', '3', strip]]);
  const rest = await lib.arVideoTasks({ offset: 2, count: 2 });
  assert.deepEqual(rest.items.map((i) => [i.task_id, i.failure]), [['wf0', { message: '存在安全风险，请修改提示词或参考素材', code: 28023051 }]]);
  assert.equal(rest.has_more, false);
  assert.equal((await lib.arVideoTasks({ count: 2 })).items[1].preview_image_file, strip);
  assert.equal(calls.ffmpeg.length, 1, 'the strip is made once and reused');
  // A preview made again (the editor rebuilds it) gets a new strip.
  fs.utimesSync(done.output.result.previewVideoPath, new Date(), new Date(Date.now() + 60000));
  await lib.arVideoTasks({ count: 2 });
  assert.equal(calls.ffmpeg.length, 2);

  const broken = setup({ tasks: [succeeded(s0.root, 'wf9')], ffmpegFails: true });
  const item = (await broken.lib.arVideoTasks({})).items[0];
  assert.deepEqual([item.preview_image_file, item.preview_image_error], [null, 'ffmpeg wrote no image']);
});

test('ar_video_task finds older tasks in the history and waits until the result is composed', async () => {
  const s0 = setup();
  const old = { ...succeeded(s0.root, 'wf7'), status: 'running', output: undefined };
  const { lib, mgr } = setup({ pages: [[{ id: 'x', recordTaskId: 'wf8', status: 'failed', createdAt: 2, request: {} }], [old]] });
  const once = await lib.arVideoTask({ task_id: 'wf7' });
  assert.equal(once.status, 'running', 'without wait_s it looks once');
  assert.equal(mgr.calls.loadMore, 2, 'the second history page has it');
  const states = [];
  setTimeout(() => mgr.updateTask(old.id, { status: 'restoring', stage: '正在加载生成结果…' }), 10);
  setTimeout(() => mgr.updateTask(old.id, succeeded(s0.root, 'wf7')), 30);
  const watch = setInterval(() => states.push(mgr.tasks.getValue().find((t) => t.id === old.id).status), 2);
  const out = await lib.arVideoTask({ task_id: 'wf7', wait_s: 5 });
  clearInterval(watch);
  assert.ok(states.includes('restoring'), 'it kept waiting through restoring');
  assert.deepEqual([out.status, out.seconds, out.preview_image_file], ['succeeded', 10, path.join(STATE, 'ar-video', 'wf7.jpg')]);
  await assert.rejects(lib.arVideoTask({ task_id: 'nope' }), /AR_VIDEO_TASK_NOT_FOUND: nope/);
  await assert.rejects(lib.arVideoTask({ task_id: '' }), /INVALID_TASK_ID/);
});

test('ar_video_import imports just this task the way the panel does and reports the new objects', async () => {
  const s0 = setup();
  const done = succeeded(s0.root, 'wf1');
  const { lib, mgr, calls } = setup({ tasks: [done, { ...succeeded(s0.root, 'wf2'), id: 'other', selected: true }] });
  const out = await lib.arVideoImport({ task_id: 'wf1' });
  assert.equal(calls.imported.length, 1);
  const [{ items, importing }] = calls.imported;
  assert.equal(importing, true, 'the panel sees the import as running');
  assert.equal(items.length, 1, 'other selected results are left alone');
  assert.equal(items[0].result, done.output.result);
  const { originImportId, ...source } = items[0].source;
  assert.deepEqual(source, { assetId: 'vid-wf1', originTaskId: 'wf1', generationMode: 'image_ai' });
  assert.match(originImportId, /^[a-zA-Z0-9_-]{1,128}$/);
  assert.equal(mgr.importing.getValue(), false);
  assert.deepEqual(mgr.calls.update.at(-1), { id: 'local-wf1', patch: { selected: false } });
  assert.deepEqual(out, { task_id: 'wf1', added_objects: [{ name: 'AR平面跟踪', object_path: 'AR平面跟踪' }], package_folders: [], plane_guid: 'plane-1' });
});

test('ar_video_import refuses unfinished tasks and a busy panel, and reports editor failures', async () => {
  const s0 = setup();
  const { lib, mgr, calls } = setup({ tasks: [{ ...succeeded(s0.root, 'wf1'), status: 'restoring', stage: '正在加载生成结果…' }, succeeded(s0.root, 'wf2')] });
  await assert.rejects(lib.arVideoImport({ task_id: 'wf1' }), /AR_VIDEO_NOT_READY: task wf1 is restoring（正在加载生成结果…）/);
  mgr.importing.next(true);
  await assert.rejects(lib.arVideoImport({ task_id: 'wf2' }), /AR_VIDEO_IMPORT_IN_PROGRESS/);
  assert.deepEqual(calls.imported, []);
  const bad = setup({ tasks: [succeeded(s0.root, 'wf3')], importFails: true });
  await assert.rejects(bad.lib.arVideoImport({ task_id: 'wf3' }), /AR_VIDEO_IMPORT_FAILED: 当前工程主场景尚未就绪/);
  assert.equal(bad.mgr.importing.getValue(), false);
});

test('ar_video_cancel cancels a running task and tells a task that already ended apart', async () => {
  const run = () => [{ id: 'r', recordTaskId: 'wf2', status: 'running', createdAt: 1, request: {} }];
  const ok = setup({ tasks: run() });
  assert.deepEqual(await ok.lib.arVideoCancel({ task_id: 'wf2' }), { task_id: 'wf2', cancelled: true });
  assert.deepEqual(ok.mgr.calls.cancel, ['r']);
  const late = setup({ tasks: run(), cancel: 'terminal' });
  assert.deepEqual(await late.lib.arVideoCancel({ task_id: 'wf2' }), { task_id: 'wf2', cancelled: false, status: 'succeeded', note: '任务在取消前已经结束' });
  const fails = setup({ tasks: run(), cancel: 'error' });
  await assert.rejects(fails.lib.arVideoCancel({ task_id: 'wf2' }), /AR_VIDEO_CANCEL_FAILED: 取消失败，请稍后重试/);
  const s0 = setup();
  const done = setup({ tasks: [succeeded(s0.root, 'wf1')] });
  await assert.rejects(done.lib.arVideoCancel({ task_id: 'wf1' }), /AR_VIDEO_NOT_RUNNING: task wf1 is succeeded/);
  assert.deepEqual(done.mgr.calls.cancel, []);
});

test('ar_video calls refuse to run when the AR 视频 internals are missing', async () => {
  const { lib, modules, mgr, root } = setup();
  delete modules[M.arVideoProject].importARVideosToCurrentProject;
  await assert.rejects(lib.arVideoSubmit({ subject: file(root, 'a.png'), mode: 'motion', prompt: 'x' }), /INCOMPATIBLE_EDITOR: missing .*importARVideosToCurrentProject/);
  assert.equal(lib.selfCheck().features.arVideo, false);
  assert.deepEqual(mgr.calls.capture, []);
});
