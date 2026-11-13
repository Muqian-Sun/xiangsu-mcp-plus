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

const STYLES = [
  { label: '表情迁移', algoConfig: { preset: 'emotions', confirm_train: { desc: '训练将消耗次数，请确认效果后再训练（预计3～8小时）' }, emptyEffects: { desc: '只需 1 张 脸部参考图' } } },
  { label: '真人搞怪', algoConfig: { preset: 'fun', lodCnt: 2 } },
];
const params = (preset) => JSON.stringify({ business_type: 'dyeh', dyeh_custom_params: { req_json: {}, preset } });
// Task records as the history and queryAIGCResultWithBizInfo give them.
const preview = (id, preset, status = 2, extra = {}) => ({ taskId: id, status, createTime: 1794600000, inputNodeList: [{ params: params(preset), uriList: [`tos://${id}`], urlList: [`https://ref/${id}.png`] }], outputNodeList: status === 2 ? [{ imageUrlList: [`https://out/${id}-f.png`, `https://out/${id}-m.png`] }] : [], ...extra });
const trained = (id, status) => preview(id, 'emotions', 2, { bizInfo: { ganBizInfo: { ganTaskId: `g-${id}`, taskStage: 'train', ganTaskInfo: { status, outputNodeList: [{ objectInfoList: [{ url: 'https://m/l0' }, { url: 'https://m/l1' }], videoInfoList: [{ url: 'https://v/f.mp4' }, { url: 'https://v/m.mp4' }] }] } } } });

class FakeUGan {
  constructor(opts, toast, scene) {
    Object.assign(this, { opts, toast, scene, calls: [] });
    this.styleList = subject(opts.noStyles ? [] : STYLES);
    this.curStyle = subject(STYLES[0]);
    this.quota = subject(0);
    this.records = opts.tasks || [];
    this.taskRecordList = subject([]);
    this.cursorInfo = subject({ cursor: 0, size: 4, hasNext: true });
    this.loadingState = subject(0);
    this.selectedTaskIdSet = subject(new Set(['other']));
    this.uganParams = subject({ referenceImage: '', reqJson: {}, preset: '' });
  }
  onUGanEditParamsUpdate(k, v) {
    this.calls.push(['param', k, v && path.basename(String(v))]);
    this.uganParams.next({ ...this.uganParams.getValue(), [k]: v });
  }
  async queryTaskList() {
    const { cursor, size } = this.cursorInfo.getValue();
    const page = this.records.slice(cursor, cursor + size);
    this.taskRecordList.next([...this.taskRecordList.getValue(), ...page]);
    this.cursorInfo.next({ cursor: cursor + size, size, hasNext: cursor + size < this.records.length });
    this.loadingState.next(2);
  }
  getStyleItemFromTask(id) {
    const t = this.taskRecordList.getValue().find((x) => x.taskId === id);
    const preset = t && JSON.parse(t.inputNodeList[0].params).dyeh_custom_params.preset;
    return STYLES.find((s) => s.algoConfig.preset === preset);
  }
  async submitUGanPreviewRequest() {
    this.calls.push(['submitPreview', this.curStyle.getValue().label, this.uganParams.getValue().preset, path.basename(this.uganParams.getValue().referenceImage)]);
    if (this.opts.refuse) return this.toast(this.opts.refuse);
    this.taskRecordList.next([preview('new', this.uganParams.getValue().preset, 1), ...this.taskRecordList.getValue()]);
  }
  async submitGanModelRequest(id, uri, text) {
    this.calls.push(['train', id, uri, text]);
    return this.opts.trainFails ? undefined : `g-${id}`;
  }
  async submitGANPreviewSelectRequest(t) {
    this.calls.push(['select', t.taskId]);
    return 'p-1';
  }
  async submitGanModelWithSelectImagesRequest(t, picks) {
    this.calls.push(['trainSelected', t.taskId, picks.length]);
    return 'g-sel';
  }
  updatePreviewTask2GanTask(id, g) {
    this.calls.push(['bindGan', id, g]);
  }
  async importUGanModel() {
    this.calls.push(['import', [...this.selectedTaskIdSet.getValue()]]);
    this.scene.push({ name: '表情迁移', parent: null });
    this.selectedTaskIdSet.next(new Set());
  }
}

const utils = (root, quota = 3) => ({
  isGanTask: (t) => !!t.bizInfo?.ganBizInfo?.ganTaskId,
  isGanPreviewTask: (t) => !!t.bizInfo?.ganBizInfo?.previewTaskId && t.bizInfo.ganBizInfo.taskStage !== 'train',
  getGanTaskStatus: (t) => t.bizInfo.ganBizInfo.ganTaskInfo.status,
  getGanSelectPreviewTaskStatus: (t) => t.bizInfo.ganBizInfo.previewTaskInfo.status,
  getGanPreviewImageList: (t) => (t.bizInfo?.ganBizInfo?.previewImages || []).map((p) => ({ outputImageUri: p.uri || '', outputImageUrl: p.url || '', isSelect: !!p.isSelect, imageIndex: p.index, status: p.status })),
  getUGanModelLocalInfoByTaskId: (id, lod) => {
    const dir = path.join(root, 'UGan3D', id);
    return { unzipLocalPath: dir, modelPathes: Array.from({ length: lod }, (_, i) => path.join(dir, `m_l${i}.model`)), femalePreviewVideoPath: path.join(dir, 'female_preview.mp4'), malePreviewVideoPath: path.join(dir, 'male_preview.mp4'), femalePreviewVideoCoverPath: path.join(dir, 'female_preview_cover.png'), malePreviewVideoCoverPath: path.join(dir, 'male_preview_cover.png') };
  },
  queryQuota: async () => quota,
  assetGanSettings: () => ({}),
});

function setup(opts = {}) {
  const root = tmpdir('xs-ugan-');
  const listeners = new Set();
  const bus = { on: (e, f) => e === 'assetUGanToast' && listeners.add(f), off: (e, f) => listeners.delete(f) };
  const scene = [{ name: '已有', parent: null }];
  const mgr = new FakeUGan(opts, (m) => listeners.forEach((f) => f(m)), scene);
  const downloads = [];
  const covers = [];
  const project = { path: path.join(root, 'proj'), resourceManager: { getAllResources: () => [] } };
  const proto = Object.fromEntries(['onUGanEditParamsUpdate', 'queryTaskList', 'getStyleItemFromTask', 'submitUGanPreviewRequest', 'submitGanModelRequest', 'submitGANPreviewSelectRequest', 'submitGanModelWithSelectImagesRequest', 'updatePreviewTask2GanTask', 'importUGanModel'].map((k) => [k, () => {}]));
  const progress = opts.progress || {};
  const modules = {
    [M.assetsLibrary]: { AssetsLibrary: { getInstance: () => ({ UGanManager: mgr }) } },
    [M.uganManager]: { default: { prototype: proto } },
    [M.uganUtils]: utils(root, opts.quota),
    [M.uganConst]: { MaxImportNum: 5, RespDownloadTimeOut: 120000 },
    [M.aiEffectApi]: { AIGCRecordStatus: { Running: 1, Finished: 2, Failed: 3 }, queryAIGCResultWithBizInfo: async ({ taskId }) => (progress[taskId] ? { code: 0, data: progress[taskId] } : { code: 1 }) },
    [M.lokiUtils]: { downloadTemplateFile: async (url, file, timeout) => (downloads.push([url, path.basename(file), timeout]), fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, url)) },
    [M.preview]: { PreviewManager: { getInstance: () => ({ getFirstNonBlackFrame: (v, out) => (covers.push(path.basename(out)), fs.writeFileSync(out, 'png')) }) } },
    [M.events]: { BusinessEventManager: { TypeGuard: () => bus } },
    [M.ef]: { ProjectManager: { getInstance: () => ({ hasActiveProject: () => true, getCurrentActiveProject: () => project }) } },
    [M.scene]: { SceneModule: { getEditingSceneService: () => ({ sceneEditor: { getAllSceneObjectEditors: () => [...scene] } }) } },
  };
  const lib = new Library((name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  });
  lib.customGanPollMs = 1;
  const image = path.join(root, 'face.png');
  fs.writeFileSync(image, 'x');
  return { lib, mgr, root, image, downloads, covers };
}

test('custom_gan_styles lists the styles with their flow and the day’s training quota', async () => {
  const { lib, mgr } = setup();
  const out = await lib.customGanStyles();
  assert.equal(out.quota, 3);
  assert.equal(mgr.quota.getValue(), 3);
  assert.deepEqual(out.styles.map((s) => [s.style, s.preset, s.flow]), [['表情迁移', 'emotions', 'direct'], ['真人搞怪', 'fun', 'select_30']]);
  assert.equal(out.styles[0].train_note, '训练将消耗次数，请确认效果后再训练（预计3～8小时）');
  await assert.rejects(setup({ noStyles: true }).lib.customGanStyles(), /CUSTOM_GAN_STYLES_NOT_LOADED/);
});

test('custom_gan_submit sets the style and reference like the panel, submits the preview and clears the reference', async () => {
  const { lib, mgr, image } = setup();
  const out = await lib.customGanSubmit({ style: 'emotions', image_path: image });
  assert.deepEqual(mgr.calls, [['param', 'preset', 'emotions'], ['param', 'referenceImage', 'face.png'], ['submitPreview', '表情迁移', 'emotions', 'face.png'], ['param', 'referenceImage', '']]);
  assert.deepEqual([out.task_id, out.style, out.stage, out.flow], ['new', '表情迁移', 'preview', 'direct']);
  await assert.rejects(lib.customGanSubmit({ style: '赛博', image_path: image }), /UNKNOWN_STYLE: 赛博; styles: 表情迁移 \(emotions\), 真人搞怪 \(fun\)/);
  await assert.rejects(lib.customGanSubmit({ style: 'emotions', image_path: image.replace('.png', '.gif') }), /IMAGE_NOT_FOUND/);
  const gif = image.replace('.png', '.webp');
  fs.writeFileSync(gif, 'x');
  await assert.rejects(lib.customGanSubmit({ style: 'emotions', image_path: gif }), /IMAGE_FORMAT/);
  const busy = setup({ tasks: [preview('t1', 'emotions', 1)] });
  await assert.rejects(busy.lib.customGanSubmit({ style: 'emotions', image_path: busy.image }), /CUSTOM_GAN_RUNNING/);
  const refused = setup({ refuse: '生成任务失败' });
  await assert.rejects(refused.lib.customGanSubmit({ style: 'emotions', image_path: refused.image }), /CUSTOM_GAN_SUBMIT_FAILED: 生成任务失败/);
});

test('custom_gan_tasks shows each stage: preview pictures, select candidates, training and model download', async () => {
  const select = preview('s1', 'fun', 2, { bizInfo: { ganBizInfo: { previewTaskId: 'p1', taskStage: 'select', previewTaskInfo: { status: 2 }, previewImages: [{ index: 0, uri: 'u0', url: 'https://c/0.png', isSelect: true }, { index: 1, uri: 'u1', url: 'https://c/1.png' }] } } });
  const { lib } = setup({ tasks: [preview('t1', 'emotions'), select, trained('t3', 2), preview('t4', 'emotions', 1)], progress: { t4: { status: 2, outputNodeList: [{ imageUrlList: ['https://out/t4-f.png', 'https://out/t4-m.png'] }], bizInfo: {} } } });
  const out = await lib.customGanTasks({ count: 4 });
  const [p, s, t, refreshed] = out.items;
  assert.deepEqual([p.stage, p.status, p.female_image_url, p.male_image_url, p.style], ['preview', 'finished', 'https://out/t1-f.png', 'https://out/t1-m.png', '表情迁移']);
  assert.deepEqual([s.stage, s.status, s.selected_count, s.candidates[1]], ['select', 'finished', 1, { index: 1, image_url: 'https://c/1.png', selected: false, status: 'finished' }]);
  assert.deepEqual([t.stage, t.status, t.video_female_url, t.model_downloaded], ['train', 'finished', 'https://v/f.mp4', false]);
  assert.deepEqual([refreshed.status, refreshed.female_image_url], ['finished', 'https://out/t4-f.png'], 'running tasks are refreshed before they are shown');
  await assert.rejects(lib.customGanTask({ task_id: 'zz' }), /CUSTOM_GAN_TASK_NOT_FOUND: zz/);
});

test('custom_gan_train trains a finished preview, or runs the two select_30 steps for 真人搞怪', async () => {
  const { lib, mgr } = setup({ tasks: [preview('t1', 'emotions')] });
  const out = await lib.customGanTrain({ task_id: 't1' });
  assert.deepEqual(mgr.calls.slice(-2), [['train', 't1', 'tos://t1', undefined], ['bindGan', 't1', 'g-t1']]);
  assert.deepEqual([out.stage, out.quota_left], ['train', 2]);
  assert.equal(mgr.quota.getValue(), 2);
  await assert.rejects(lib.customGanTrain({ task_id: 't1', selected: Array(30).fill(0) }), /selected only applies to the 真人搞怪 style/);
  await assert.rejects(setup({ tasks: [preview('t1', 'emotions', 1)] }).lib.customGanTrain({ task_id: 't1' }), /CUSTOM_GAN_PREVIEW_NOT_READY/);
  await assert.rejects(setup({ tasks: [trained('t1', 1)] }).lib.customGanTrain({ task_id: 't1' }), /CUSTOM_GAN_ALREADY_TRAINED/);
  await assert.rejects(setup({ tasks: [preview('t1', 'emotions')], trainFails: true }).lib.customGanTrain({ task_id: 't1' }), /CUSTOM_GAN_TRAIN_FAILED/);
  const spent = setup({ tasks: [preview('t1', 'emotions')], quota: 0 });
  await assert.rejects(spent.lib.customGanTrain({ task_id: 't1' }), /CUSTOM_GAN_NO_QUOTA: 今日训练次数已用完/);
  assert.ok(!spent.mgr.calls.some((c) => c[0] === 'train'), 'nothing is submitted without quota');

  const fun = setup({ tasks: [preview('f1', 'fun')] });
  const first = await fun.lib.customGanTrain({ task_id: 'f1' });
  assert.equal(first.stage, 'select');
  assert.deepEqual(fun.mgr.calls.at(-1), ['select', 'f1']);
  const images = Array.from({ length: 40 }, (_, i) => ({ index: i, uri: `u${i}`, url: `https://c/${i}.png` }));
  const ready = setup({ tasks: [preview('f1', 'fun', 2, { bizInfo: { ganBizInfo: { previewTaskId: 'p1', taskStage: 'select', previewTaskInfo: { status: 2 }, previewImages: images } } })] });
  await assert.rejects(ready.lib.customGanTrain({ task_id: 'f1', selected: Array.from({ length: 29 }, (_, i) => i) }), /INVALID_SELECTION: pick exactly 30/);
  await assert.rejects(ready.lib.customGanTrain({ task_id: 'f1', selected: [...Array.from({ length: 29 }, (_, i) => i), 0] }), /INVALID_SELECTION: pick exactly 30 different/);
  await assert.rejects(ready.lib.customGanTrain({ task_id: 'f1', selected: [...Array.from({ length: 29 }, (_, i) => i), 99] }), /no finished candidate at index 99/);
  const trainedSel = await ready.lib.customGanTrain({ task_id: 'f1', selected: Array.from({ length: 30 }, (_, i) => i) });
  assert.deepEqual(ready.mgr.calls.at(-1), ['trainSelected', 'f1', 30]);
  assert.equal(trainedSel.stage, 'train');
});

test('custom_gan_import downloads the model and previews like the finished card, then imports only this task', async () => {
  const { lib, mgr, downloads, covers } = setup({ tasks: [trained('t1', 2)] });
  const out = await lib.customGanImport({ task_id: 't1' });
  assert.deepEqual(downloads.map((d) => d.slice(0, 2)), [['https://m/l0', 'm_l0.model'], ['https://m/l1', 'm_l1.model'], ['https://v/f.mp4', 'female_preview.mp4'], ['https://v/m.mp4', 'male_preview.mp4']]);
  assert.equal(downloads[0][2], 120000, 'the editor’s download timeout');
  assert.deepEqual(covers, ['female_preview_cover.png', 'male_preview_cover.png']);
  assert.deepEqual(mgr.calls.at(-1), ['import', ['t1']], 'only this task was selected for the import');
  assert.deepEqual([...mgr.selectedTaskIdSet.getValue()], ['other'], 'the panel’s own selection is put back');
  assert.deepEqual(out.added_objects, [{ name: '表情迁移', object_path: '表情迁移' }]);
  await assert.rejects(setup({ tasks: [trained('t1', 1)] }).lib.customGanImport({ task_id: 't1' }), /CUSTOM_GAN_NOT_TRAINED/);
});
