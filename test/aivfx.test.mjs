import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.XIANGSU_MCP_EXT_STATE = tmpdir('xs-state-');
const { Library, M } = require('../editor-plugin/library.cjs');

function subject(v) {
  const s = { v, getValue: () => s.v, next: (x) => (s.v = x) };
  return s;
}

function file(dir, name) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  return p;
}

const running = (t) => t.state === 'generating' || t.state === 'downloading_preview';

// The part of the editor's AIVisualEffectManager these tools drive: the panel's inputs, the reference
// video audit, one submit at a time, the history list with its loading flag, import and cancel.
class FakeVfx {
  constructor(opts, toast, scene) {
    this.opts = opts;
    this.toast = toast;
    this.scene = scene;
    this.calls = [];
    this.prompt = subject('');
    this.durationSeconds = subject(5);
    this.referenceMedia = subject([]);
    this.submitting = subject(false);
    this.importing = subject(false);
    this.currentTask = subject(undefined);
    this.selectedTask = subject(undefined);
    this.errorMessage = subject('');
    this.historyLoading = subject(false);
    this.historyError = subject('');
    this.historyHasMore = subject(false);
    this.taskRecordList = subject([...(opts.tasks || [])]);
    this.polls = 0;
  }
  get activeTaskCount() {
    return this.taskRecordList.getValue().filter(running).length;
  }
  resume() {
    this.calls.push('resume');
  }
  leavePage() {
    this.calls.push('leavePage');
    this.prompt.next('');
    this.referenceMedia.next([]);
    this.currentTask.next(undefined);
  }
  updatePrompt(s) {
    this.calls.push(['prompt', s]);
    this.prompt.next(s);
  }
  updateDurationSeconds(s) {
    this.calls.push(['duration', s]);
    this.durationSeconds.next(s);
  }
  updateReferenceMedia(type, p) {
    this.calls.push(['reference', type, path.basename(p)]);
    const m = { type, localPath: p, ...(type === 'video' ? { auditStatus: 'uploading', polls: 0 } : {}) };
    this.referenceMedia.next([...this.referenceMedia.getValue(), m]);
    if (type === 'video') {
      const tick = () => {
        m.polls++;
        m.auditStatus = m.polls < 3 ? 'auditing' : this.opts.rejectVideo ? 'rejected' : 'passed';
        if (m.auditStatus === 'rejected') m.auditError = '参考视频审核未通过，请裁剪或更换素材';
        if (m.polls < 3) setTimeout(tick, 1);
      };
      setTimeout(tick, 1);
    }
  }
  getReferenceAdmissionError(list) {
    const bad = list.find((m) => m.auditStatus === 'rejected');
    return bad ? bad.auditError : undefined;
  }
  async submit(mode) {
    this.calls.push(['submit', mode, this.prompt.getValue(), this.durationSeconds.getValue(), this.referenceMedia.getValue().map((m) => m.auditStatus || 'image')]);
    if (this.opts.refuse) return this.toast(this.opts.refuse);
    const t = { attemptId: `a${this.calls.length}`, state: 'generating', prompt: this.prompt.getValue(), durationSeconds: this.durationSeconds.getValue(), referenceMedia: this.referenceMedia.getValue(), createdAt: 1794600000000, name: '画面特效生成任务1' };
    this.taskRecordList.next([t, ...this.taskRecordList.getValue()]);
    this.currentTask.next(t);
    if (this.opts.fail) Object.assign(t, { state: 'failed', errorMessage: this.opts.fail });
    else t.workflowId = 'wf-new';
  }
  async queryTaskList(reset) {
    this.calls.push(['query', reset]);
    this.polls++;
    for (const t of this.taskRecordList.getValue()) if (running(t) && this.opts.finishAfter && this.polls >= this.opts.finishAfter) Object.assign(t, { state: 'succeeded', artifact: { uri: 'tos://x' }, previewArtifact: { downloadUrl: 'https://p' } });
  }
  async importCurrentResult() {
    this.calls.push(['import', this.selectedTask.getValue().workflowId]);
    if (this.opts.importFails) {
      this.errorMessage.next('导入失败：产物不可用');
      return false;
    }
    this.scene.push({ name: '画面特效', parent: null });
    this.toast('画面特效已导入工程');
    return true;
  }
  async cancel(t) {
    this.calls.push(['cancel', t.workflowId]);
    t.state = this.opts.cancel === 'pending' ? 'generating' : 'canceled';
    if (t.state === 'canceled') this.taskRecordList.next(this.taskRecordList.getValue().filter((x) => x !== t));
  }
}

function setup(opts = {}) {
  const root = tmpdir('xs-vfx-');
  const listeners = new Set();
  const bus = { on: (e, f) => e === 'assetAIVideoToast' && listeners.add(f), off: (e, f) => listeners.delete(f) };
  const toast = (m) => listeners.forEach((f) => f(m));
  const scene = [{ name: '已有', parent: null }];
  const mgr = new FakeVfx(opts, toast, scene);
  const project = { path: path.join(root, 'proj'), resourceManager: { getAllResources: () => (opts.newResource && mgr.calls.some((c) => c[0] === 'import') ? [{ assetPath: path.join(root, 'proj/Assets/画面特效/main.json') }] : []) } };
  const preview = file(root, 'preview.mp4');
  const ffmpeg = [];
  const proto = Object.fromEntries(['resume', 'leavePage', 'updatePrompt', 'updateDurationSeconds', 'updateReferenceMedia', 'getReferenceAdmissionError', 'submit', 'queryTaskList', 'importCurrentResult', 'cancel'].map((k) => [k, () => {}]));
  const modules = {
    [M.assetsLibrary]: { AssetsLibrary: { getInstance: () => ({ aiVisualEffectManager: mgr }) } },
    [M.aiVfxManager]: { default: { prototype: proto }, VisualEffectDurationRange: { min: 1, max: 10, default: 5 }, VisualEffectReferenceLimits: { images: 10, videos: 1 }, VisualEffectMaxConcurrentTasks: 10, isVisualEffectTaskRunning: running },
    [M.aiVfxInput]: {
      visualEffectImageExtensions: ['png', 'jpg', 'jpeg'],
      visualEffectVideoExtensions: ['mp4', 'mov'],
      validateVisualEffectFile: (p, type) => ((type === 'image' ? /\.(png|jpe?g)$/i : /\.(mp4|mov)$/i).test(p) ? undefined : { code: 'file_type_invalid', message: '仅支持 PNG、JPG、JPEG 图片和 MP4、MOV 视频' }),
    },
    [M.aiVfxPreview]: { ensureGeneratedVisualEffectPreview: async (id, artifact) => (assert.equal(artifact.downloadUrl, 'https://p'), preview) },
    [M.events]: { BusinessEventManager: { TypeGuard: () => bus } },
    [M.ffmpeg]: { ffmpegExec: async (args) => (ffmpeg.push(args), fs.writeFileSync(args.at(-1), 'jpg')) },
    [M.ef]: { ProjectManager: { getInstance: () => ({ hasActiveProject: () => true, getCurrentActiveProject: () => project }) } },
    [M.scene]: { SceneModule: { getEditingSceneService: () => ({ sceneEditor: { getAllSceneObjectEditors: () => [...scene] } }) } },
  };
  const lib = new Library((name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  });
  lib.aiVfxPollMs = 1;
  return { lib, mgr, root, ffmpeg, scene };
}

test('ai_vfx_submit fills the panel inputs, waits for the video audit, submits and returns the workflow id', async () => {
  const { lib, mgr, root } = setup();
  const out = await lib.aiVfxSubmit({ prompt: '  金色粒子光环  ', reference_images: [file(root, 'a.png')], reference_video: file(root, 'b.mp4'), duration_s: 8 });
  assert.deepEqual(mgr.calls.slice(0, 6), ['resume', 'leavePage', ['prompt', '金色粒子光环'], ['duration', 8], ['reference', 'image', 'a.png'], ['reference', 'video', 'b.mp4']]);
  const submit = mgr.calls.find((c) => c[0] === 'submit');
  assert.deepEqual(submit, ['submit', 'initial', '金色粒子光环', 8, ['image', 'passed']], 'submitted only after the video audit passed');
  assert.equal(mgr.calls.at(-1), 'leavePage', 'the accepted task goes to the background');
  assert.deepEqual({ ...out, quota: undefined }, { task_id: 'wf-new', name: '画面特效生成任务1', prompt: '金色粒子光环', duration_s: 8, references: ['image', 'video'], quota: undefined });
  assert.match(out.quota, /AI 模型使用次数/);
});

test('ai_vfx_submit refuses bad input before touching the panel and reports the editor refusals', async () => {
  const { lib, mgr, root } = setup();
  await assert.rejects(lib.aiVfxSubmit({}), /INPUT_REQUIRED/);
  await assert.rejects(lib.aiVfxSubmit({ prompt: 'x', duration_s: 11 }), /INVALID_DURATION: 11; 1–10 s/);
  await assert.rejects(lib.aiVfxSubmit({ prompt: 'x', reference_images: Array(11).fill(file(root, 'a.png')) }), /TOO_MANY_REFERENCES: at most 10 images/);
  await assert.rejects(lib.aiVfxSubmit({ prompt: 'x', reference_images: [file(root, 'a.gif')] }), /AI_VFX_INPUT_INVALID: a\.gif: 仅支持 PNG/);
  await assert.rejects(lib.aiVfxSubmit({ prompt: 'x', reference_images: ['/nope.png'] }), /REFERENCE_NOT_FOUND/);
  assert.deepEqual(mgr.calls, []);

  const busy = setup({ tasks: Array.from({ length: 10 }, (_, i) => ({ attemptId: `r${i}`, workflowId: `w${i}`, state: 'generating' })) });
  await assert.rejects(busy.lib.aiVfxSubmit({ prompt: 'x' }), /AI_VFX_TOO_MANY_RUNNING: 10/);
  const rejected = setup({ rejectVideo: true });
  await assert.rejects(rejected.lib.aiVfxSubmit({ prompt: 'x', reference_video: file(rejected.root, 'v.mp4') }), /AI_VFX_REFERENCE_REJECTED: 参考视频审核未通过/);
  assert.ok(!rejected.mgr.calls.some((c) => c[0] === 'submit'));
  assert.equal(rejected.mgr.calls.at(-1), 'leavePage', 'the panel inputs are cleared after a failure');
  const refused = setup({ refuse: '最多同时生成10个画面特效，请等待任务完成' });
  await assert.rejects(refused.lib.aiVfxSubmit({ prompt: 'x' }), /AI_VFX_SUBMIT_REFUSED: 最多同时生成10个画面特效/);
  const failed = setup({ fail: '审核失败，请修改描述或更换参考素材' });
  await assert.rejects(failed.lib.aiVfxSubmit({ prompt: 'x' }), /AI_VFX_SUBMIT_FAILED: 审核失败/);
});

test('ai_vfx_tasks lists the history with a 6-frame strip of each finished preview; one task can be waited for', async () => {
  const done = { attemptId: 'a', workflowId: 'wf1', state: 'succeeded', prompt: '光环', durationSeconds: 6, referenceMedia: [{ type: 'image' }], createdAt: 1794600000000, artifact: { uri: 'x' }, previewArtifact: { downloadUrl: 'https://p' }, outputType: 'full_frame' };
  const bad = { attemptId: 'b', workflowId: 'wf2', state: 'audit_failed', errorMessage: '审核失败，请修改描述或更换参考素材', createdAt: 1794500000000 };
  const { lib, ffmpeg } = setup({ tasks: [done, bad] });
  const out = await lib.aiVfxTasks({});
  assert.equal(out.items[0].status, 'succeeded');
  assert.equal(out.items[0].output_type, 'full_frame');
  assert.match(out.items[0].preview_image_file, /ai-vfx\/wf1\.jpg$/);
  assert.match(ffmpeg[0].join(' '), /fps=6\/6,scale=-2:320,tile=6x1/);
  assert.deepEqual([out.items[1].status, out.items[1].failure, out.items[1].preview_image_file], ['audit_failed', '审核失败，请修改描述或更换参考素材', undefined]);
  assert.deepEqual(out.limits.duration_s, { min: 1, max: 10, default: 5 });

  const wait = setup({ tasks: [{ attemptId: 'c', workflowId: 'wf3', state: 'generating', createdAt: 1 }], finishAfter: 3 });
  assert.equal((await wait.lib.aiVfxTask({ task_id: 'wf3', wait_s: 5 })).status, 'succeeded');
  await assert.rejects(wait.lib.aiVfxTask({ task_id: 'nope' }), /AI_VFX_TASK_NOT_FOUND: nope/);
});

test('ai_vfx_import imports one finished task through the panel and reports what changed', async () => {
  const task = () => ({ attemptId: 'a', workflowId: 'wf1', state: 'succeeded', artifact: { uri: 'x' } });
  const { lib, mgr } = setup({ tasks: [task()], newResource: true });
  const out = await lib.aiVfxImport({ task_id: 'wf1' });
  assert.deepEqual(mgr.calls.find((c) => c[0] === 'import'), ['import', 'wf1']);
  assert.deepEqual(out.added_objects, [{ name: '画面特效', object_path: '画面特效' }]);
  assert.deepEqual(out.package_folders, [path.join('Assets', '画面特效')]);
  await assert.rejects(setup({ tasks: [{ ...task(), state: 'generating' }] }).lib.aiVfxImport({ task_id: 'wf1' }), /AI_VFX_NOT_READY: task wf1 is running/);
  await assert.rejects(setup({ tasks: [task()], importFails: true }).lib.aiVfxImport({ task_id: 'wf1' }), /AI_VFX_IMPORT_FAILED: 导入失败：产物不可用/);
});

test('ai_vfx_cancel cancels a running task and says when the cancel is not confirmed yet', async () => {
  const run = () => ({ attemptId: 'a', workflowId: 'wf1', state: 'generating' });
  assert.deepEqual(await setup({ tasks: [run()] }).lib.aiVfxCancel({ task_id: 'wf1' }), { task_id: 'wf1', cancelled: true });
  const pending = await setup({ tasks: [run()], cancel: 'pending' }).lib.aiVfxCancel({ task_id: 'wf1' });
  assert.deepEqual([pending.cancelled, pending.status], [false, 'running']);
  await assert.rejects(setup({ tasks: [{ ...run(), state: 'succeeded' }] }).lib.aiVfxCancel({ task_id: 'wf1' }), /AI_VFX_NOT_RUNNING/);
});
