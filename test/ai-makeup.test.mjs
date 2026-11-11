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

const PARTS = [
  { key: 'all', value: '整妆', index: 0 },
  { key: 'rest', value: '面部', index: 0 },
  { key: 'pupil', value: '美瞳', index: 1 },
  { key: 'eyepart', value: '眼部', index: 2 },
  { key: 'eyelash', value: '睫毛', index: 3 },
  { key: 'lip', value: '唇部', index: 4 },
];
const INDEX = ['rest', 'pupil', 'eyepart', 'eyelash', 'lip'];
const DETAIL = {
  rest: { intensity: 0.7, female_opacity: 0.5, male_opacity: 0.2, blend_mode: 1, image_index: 0 },
  pupil: { intensity: 0.35, reflect_intensity: 0.1, blend_mode: 0, reflect_blend_mode: 1, image_index: 1 },
  eyepart: { intensity: 0.9, female_opacity: 0.5, male_opacity: 0.2, blend_mode: 1, image_index: 2 },
  eyelash: { intensity: 1, female_opacity: 0.6, male_opacity: 0.2, blend_mode: 1, image_index: 3 },
  lip: { intensity: 0.5, female_opacity: 0.5, male_opacity: 0.1, blend_mode: 1, image_index: 4 },
};
const PNG_URL = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;

// A history record and the message the panel's taskRecordToMessage makes of it.
function task(taskId, status, { assets = INDEX.map((k) => `https://cdn/${taskId}/${k}.png`), createTime = 1794380177, finishTime = 1794380182, ...rest } = {}) {
  const record = { taskId, status, createTime, finishTime, cost: finishTime - createTime, message: '', errorCode: 0, ...rest };
  const done = () => record.status === 2;
  const message = () => ({ taskId, raw: `https://cdn/${taskId}/ref.jpg`, rawUri: 'ref', assets: done() ? assets : [], uris: [], detail: done() ? JSON.stringify(DETAIL) : undefined, status: record.status, message: '' });
  return { record, message };
}

class Subject {
  constructor(v) {
    this.v = v;
  }
  getValue() {
    return this.v;
  }
  next(v) {
    this.v = v;
  }
}

class FaceMaskComponentEditor {
  constructor(so, p) {
    Object.assign(this, { sceneObject: so, enabled: true, regionType: p.region, blendMode: p.blend_mode ?? 0, femaleIntensity: p.female_opacity ?? 0.8, maleIntensity: p.male_opacity ?? 0.3, intensity: p.intensity ?? 0.5, externalFemaleIntensity: 1, externalMaleIntensity: 1, makeupTexture: p.texture });
  }
}

// Like 9.8.1: the pupil layer keeps the built-in iris at 0.8 whatever the panel asks for.
class EyeColorComponentEditor {
  constructor(so) {
    this.sceneObject = so;
    this.enabled = true;
    this.props = { makeupTexture: { builtin: 'defaultEyeColor' }, intensity: 0.8, reflectionIntensity: 0.8, blendMode: 0, reflectionBlendMode: 3, isOpacityEnabled: true };
  }
  getProperty(k) {
    return this.props[k];
  }
  setProperty(k, v) {
    if (this.refuse === k) return Error('read-only');
    this.props[k] = v;
  }
}

const REGION = { rest: 0, eyepart: 1, eyelash: 2, lip: 3 };

// A fake editor: the panel's manager, the cloud history and results, the downloader, the importer and a
// scene whose 「面部面具」 group the manager's createCorrespondingEntity fills.
function setup(opts = {}) {
  const root = tmpdir('xs-aimakeup-');
  const project = { path: path.join(root, 'proj'), resources: [] };
  fs.mkdirSync(path.join(project.path, 'Assets'), { recursive: true });
  project.resourceManager = {
    getAllResources: () => project.resources,
    getResourceItemByObject: (o) => project.resources.find((r) => r.mainObject === o) || null,
  };
  const shared = path.join(root, 'shared');
  const cache = path.join(shared, 'AIGC');
  const tasks = opts.tasks || [task('t1', 2)];
  const calls = { history: [], query: [], submit: [], download: [], imported: [], created: [], progress: 0, preview: [] };
  const objects = [];
  const comps = [];
  const listeners = new Map();
  const bus = {
    on: (e, f) => listeners.set(e, [...(listeners.get(e) || []), f]),
    off: (e, f) => listeners.set(e, (listeners.get(e) || []).filter((g) => g !== f)),
    emit: (e, ...a) => (listeners.get(e) || []).forEach((f) => f(...a)),
  };
  const node = (name, parent) => {
    const taken = new Set(objects.filter((o) => o.parent === parent).map((o) => o.name));
    let unique = name;
    for (let n = 1; taken.has(unique); n++) unique = `${name} (${n})`;
    const so = { name: unique, parent, guid: `g${objects.length}` };
    objects.push(so);
    return so;
  };
  const mgr = {
    taskRecordList: new Subject([]),
    isImporting: new Subject(false),
    async submitMakeupExtract(file) {
      calls.submit.push(file);
      if (opts.submitToast) return bus.emit('assetAIVideoToast', opts.submitToast);
      const fresh = task('t-new', 1);
      tasks.unshift(fresh);
      this.taskRecordList.next([{ taskId: 't-new', status: 1 }, ...this.taskRecordList.getValue()]);
    },
    async taskRecordToMessage(record) {
      return tasks.find((t) => t.record === record).message();
    },
    updateTaskProgress() {
      calls.progress++;
    },
    async ensurePartPreview(msg, part) {
      calls.preview.push([msg.taskId, part]);
      if (opts.previewThrows) throw Error('sharp failed');
      return opts.noPreview ? '' : PNG_URL;
    },
    createCorrespondingEntity(s, res) {
      calls.created.push({ ...s, texture: path.basename(res.assetPath) });
      if (opts.noLayer === s.type) return bus.emit('assetAIVideoToast', '请求失败');
      let group = objects.find((o) => o.name === '面部面具' && !o.parent);
      if (!group) {
        group = node('面部面具', null);
        node('面部面具摄像机', group);
      }
      const so = node(s.name.split('.')[0], group);
      if (opts.noComponent === s.type) return;
      const p = JSON.parse(s.params);
      comps.push(s.type === 'pupil' ? Object.assign(new EyeColorComponentEditor(so), { refuse: opts.pupilRefuses }) : new FaceMaskComponentEditor(so, { ...p, region: REGION[s.type], texture: res.mainObject }));
    },
  };
  const status = (r) => r.status;
  const modules = {
    [M.assetsLibrary]: { AssetsLibrary: { getInstance: () => ({ aiMakeupManager: mgr }) } },
    [M.aiMakeupManager]: { AIMakeupManager: { prototype: Object.fromEntries(['submitMakeupExtract', 'taskRecordToMessage', 'updateTaskProgress', 'ensurePartPreview', 'createCorrespondingEntity'].map((k) => [k, () => {}])) } },
    [M.aiMakeupConst]: { AIMakeupManagerScene: 'AIMakeUpPC', MakeupParts: PARTS, MakeupPartsIndex: INDEX },
    [M.aiEffectApi]: {
      queryAITaskHistories: async (req, flag) => {
        calls.history.push({ ...req, flag });
        if (req.size > 20) return { code: 5062, message: 'AI历史记录查询超出最大条数限制' };
        const hits = tasks.filter((t) => req.statusList.includes(status(t.record)));
        const page = hits.slice(req.cursor, req.cursor + req.size).map((t) => t.record);
        const next = req.cursor + page.length;
        return { code: 0, data: { taskRecords: page, nextCursor: next, hasMore: next < hits.length } };
      },
      queryAIGCResult: async ({ taskId }) => {
        calls.query.push(taskId);
        const t = tasks.find((x) => x.record.taskId === taskId);
        if (!t) return { code: 1001, message: 'task not found' };
        const n = calls.query.filter((x) => x === taskId).length;
        if (opts.finishAfter && n >= opts.finishAfter) t.record.status = 2;
        return { code: 0, data: { status: t.record.status } };
      },
    },
    [M.lokiUtils]: {
      downloadTemplateFile: async (url, dest, timeout, flag) => {
        calls.download.push({ url, dest, timeout, flag });
        if (opts.downloadFails) throw Error('timeout');
        fs.writeFileSync(dest, url);
        return dest;
      },
    },
    [M.resImport]: {
      ResourceImportHandles: {
        importExtAsset: (files, ...rest) => {
          calls.imported.push({ files, rest });
          const base = path.basename(files[0], '.png');
          const taken = new Set(project.resources.map((r) => path.basename(r.assetPath)));
          let name = `${base}.png`;
          for (let n = 1; taken.has(name); n++) name = `${base} (${n}).png`;
          const item = { assetPath: path.join(project.path, 'Assets', name), mainObject: { tex: name } };
          project.resources.push(item);
          return item;
        },
        registerLoadingCallbackByResItem: (item, cb) => {
          if (opts.neverLoads) return;
          cb(item, opts.loadState || 'loaded');
        },
      },
    },
    [M.events]: { BusinessEventManager: { TypeGuard: () => bus } },
    [M.scene]: { SceneModule: { getEditingSceneService: () => ({ sceneEditor: { getAllSceneObjectEditors: () => [...objects], getAllComponentEditors: () => [...comps] } }) } },
    [M.ef]: {
      ProjectManager: { getInstance: () => ({ hasActiveProject: () => true, getCurrentActiveProject: () => project }) },
      Resource: { EditorFoundation: { env: { getSharedCachePath: () => shared } } },
    },
  };
  const mod = (name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  };
  const lib = new Library(mod);
  lib.aiMakeupPollMs = 1;
  lib.aiMakeupLoadTimeoutMs = 50;
  return { lib, calls, mgr, modules, root, project, cache, objects, comps, tasks, bus, listeners };
}

function file(dir, name, bytes = 16) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

test('ai_makeup_submit refuses images the panel would refuse, before asking the cloud anything', async () => {
  const { lib, calls, root } = setup();
  await assert.rejects(lib.aiMakeupSubmit({ image_path: 'ref.png' }), /IMAGE_PATH_NOT_ABSOLUTE/);
  await assert.rejects(lib.aiMakeupSubmit({ image_path: path.join(root, 'none.png') }), /IMAGE_NOT_FOUND/);
  await assert.rejects(lib.aiMakeupSubmit({ image_path: file(root, 'ref.webp') }), /IMAGE_FORMAT: ref.webp; supported: png, jpg, jpeg/);
  await assert.rejects(lib.aiMakeupSubmit({ image_path: file(root, 'big.jpg', 10 * 1024 * 1024 + 1) }), /IMAGE_TOO_LARGE: 10.0 MB; the limit is 10 MB/);
  assert.deepEqual([calls.history, calls.submit], [[], []]);
  assert.equal((await lib.aiMakeupSubmit({ image_path: file(root, 'edge.JPEG', 10 * 1024 * 1024) })).task_id, 't-new');
});

test('ai_makeup_submit refuses while a task runs, as the panel disables 「立即提取」', async () => {
  const { lib, calls, root } = setup({ tasks: [task('busy', 1), task('t1', 2)] });
  await assert.rejects(lib.aiMakeupSubmit({ image_path: file(root, 'ref.png') }), /AI_MAKEUP_RUNNING: task busy is still running/);
  assert.deepEqual(calls.history, [{ cursor: 0, size: 1, scene: 'AIMakeUpPC', statusList: [1], flag: true }]);
  assert.deepEqual(calls.submit, []);
});

test('ai_makeup_submit goes through the panel manager, waits for the result and returns its parts and preview', async () => {
  const { lib, calls, root, listeners } = setup({ finishAfter: 3 });
  const img = file(root, 'ref.png');
  const out = await lib.aiMakeupSubmit({ image_path: img, wait_s: 5 });
  assert.deepEqual(calls.submit, [img]);
  assert.equal(calls.query.length, 3, 'asked until the task stopped running');
  assert.equal(calls.progress, 1, "the panel's own list is brought up to date");
  assert.deepEqual(calls.preview, [['t-new', 'all']]);
  assert.equal((listeners.get('assetAIVideoToast') || []).length, 0, 'the toast listener is removed');
  const preview = path.join(STATE, 'ai-makeup', 't-new.png');
  assert.deepEqual(out, {
    task_id: 't-new',
    status: 'finished',
    created_at: '2026-11-11T06:56:17.000Z',
    finished_at: '2026-11-11T06:56:22.000Z',
    reference_image_url: 'https://cdn/t-new/ref.jpg',
    parts: [
      { part: 'rest', name: '面部', image_url: 'https://cdn/t-new/rest.png', intensity: 0.7, female: 0.5, male: 0.2, blend_mode: 1 },
      { part: 'pupil', name: '美瞳', image_url: 'https://cdn/t-new/pupil.png', intensity: 0.35, reflect_intensity: 0.1, blend_mode: 0, reflect_blend_mode: 1 },
      { part: 'eyepart', name: '眼部', image_url: 'https://cdn/t-new/eyepart.png', intensity: 0.9, female: 0.5, male: 0.2, blend_mode: 1 },
      { part: 'eyelash', name: '睫毛', image_url: 'https://cdn/t-new/eyelash.png', intensity: 1, female: 0.6, male: 0.2, blend_mode: 1 },
      { part: 'lip', name: '唇部', image_url: 'https://cdn/t-new/lip.png', intensity: 0.5, female: 0.5, male: 0.1, blend_mode: 1 },
    ],
    preview_file: preview,
  });
  assert.equal(fs.readFileSync(preview, 'utf8'), 'png');
});

test('ai_makeup_submit reports what the editor said when it took no task', async () => {
  const { lib, root } = setup({ submitToast: '图片上传失败' });
  await assert.rejects(lib.aiMakeupSubmit({ image_path: file(root, 'ref.png') }), /AI_MAKEUP_SUBMIT_FAILED: 图片上传失败/);
});

test('ai_makeup_tasks with a task_id stops at the deadline, and says why a task failed or has no preview', async () => {
  const running = setup({ tasks: [task('r1', 1)] });
  const out = await running.lib.aiMakeupTask({ task_id: 'r1', wait_s: 0.05 });
  assert.deepEqual([out.status, out.parts, out.preview_file], ['running', undefined, undefined]);
  assert.ok(running.calls.query.length > 1);
  assert.deepEqual(running.calls.preview, []);
  const once = setup({ tasks: [task('r1', 1)] });
  await once.lib.aiMakeupTask({ task_id: 'r1' });
  assert.equal(once.calls.query.length, 1, 'without wait_s it asks once');

  const failed = setup({ tasks: [task('f1', 3, { message: '未检测到人脸', errorCode: 2001 })] });
  assert.deepEqual((await failed.lib.aiMakeupTask({ task_id: 'f1' })).failure, { message: '未检测到人脸', code: 2001 });
  const blank = setup({ noPreview: true });
  const b = await blank.lib.aiMakeupTask({ task_id: 't1' });
  assert.deepEqual([b.preview_file, b.preview_error], [null, 'the editor made no preview (a texture could not be downloaded)']);
  const broken = setup({ previewThrows: true });
  assert.equal((await broken.lib.aiMakeupTask({ task_id: 't1' })).preview_error, 'sharp failed');
  await assert.rejects(blank.lib.aiMakeupTask({ task_id: 'nope' }), /AI_MAKEUP_QUERY_FAILED: task nope code=1001 message=task not found/);
});

test('ai_makeup tasks are looked up in the history ten pages deep', async () => {
  const many = Array.from({ length: 205 }, (_, i) => task(`h${i}`, 2));
  const s = setup({ tasks: many });
  assert.equal((await s.lib.aiMakeupTask({ task_id: 'h199' })).task_id, 'h199');
  s.calls.history.length = 0;
  await assert.rejects(s.lib.aiMakeupTask({ task_id: 'h200' }), /AI_MAKEUP_TASK_NOT_FOUND: h200 is not among this account's latest 200 AI 妆容 tasks/);
  assert.deepEqual(s.calls.history.map((h) => [h.cursor, h.size]), Array.from({ length: 10 }, (_, i) => [i * 20, 20]));
});

test('ai_makeup_tasks lists a page of the history without making previews', async () => {
  const { lib, calls } = setup({ tasks: [task('a', 2), task('b', 1), task('c', 3, { message: '提取失败' })] });
  const out = await lib.aiMakeupTasks({ cursor: 0, count: 2 });
  assert.deepEqual(calls.history, [{ cursor: 0, size: 2, scene: 'AIMakeUpPC', statusList: [1, 2, 3], flag: true }]);
  assert.deepEqual(
    out.items.map((i) => [i.task_id, i.status, i.parts?.length]),
    [
      ['a', 'finished', 5],
      ['b', 'running', undefined],
    ],
  );
  assert.deepEqual([out.next_cursor, out.has_more], [2, true]);
  assert.equal(out.items[1].finished_at, null);
  assert.deepEqual(calls.preview, []);
  const last = await lib.aiMakeupTasks({ cursor: 2 });
  assert.deepEqual([last.items[0].failure, last.has_more], [{ message: '提取失败', code: 0 }, false]);
});

test('ai_makeup_import builds every part the panel way and puts the AI pupil on its layer', async () => {
  const { lib, calls, cache, comps, mgr, project } = setup();
  const seen = [];
  mgr.isImporting.next = (v) => seen.push(v);
  const out = await lib.aiMakeupImport({ task_id: 't1' });
  assert.deepEqual(seen, [true, false], "the panel's import button waits while this runs");
  assert.deepEqual(
    calls.download.map((d) => [d.url, d.dest, d.timeout, d.flag]),
    INDEX.map((k, i) => [`https://cdn/t1/${k}.png`, path.join(cache, `AI 美妆_${PARTS[i + 1].value}.png`), 30000, true]),
  );
  assert.deepEqual(calls.imported[0].rest, [true, undefined, true]);
  assert.deepEqual(
    project.resources.map((r) => [path.basename(r.assetPath), r.assetPackageID, r.assetStudioData]),
    INDEX.map((k, i) => [`AI 美妆_${PARTS[i + 1].value}.png`, `AIAsset_MakeUp_t1_${k}`, { id: `AIAsset_MakeUp_t1_${k}`, styleTag: 'AIAsset_MakeUp', type: 'AIAsset_MakeUp' }]),
  );
  assert.deepEqual(
    calls.created.map((c) => [c.type, c.name, JSON.parse(c.params)]),
    INDEX.map((k, i) => [k, `AI 美妆_${PARTS[i + 1].value}.png`, DETAIL[k]]),
  );
  const pupil = comps.find((c) => c instanceof EyeColorComponentEditor);
  assert.deepEqual(pupil.props, { makeupTexture: { tex: 'AI 美妆_美瞳.png' }, intensity: 0.35, reflectionIntensity: 0.1, blendMode: 0, reflectionBlendMode: 1, isOpacityEnabled: false });
  assert.deepEqual(out.added_objects, [
    {
      name: '面部面具',
      object_path: '面部面具',
      contents: ['面部面具摄像机', ...INDEX.map((k, i) => `AI 美妆_${PARTS[i + 1].value}`)].map((n) => ({ name: n, object_path: `面部面具/${n}` })),
    },
  ]);
  assert.deepEqual(out.layers[0], {
    part: 'rest',
    name: '面部',
    object_path: '面部面具/AI 美妆_面部',
    kind: 'face_mask',
    enabled: true,
    region: 0,
    blend: 1,
    female: 0.5,
    male: 0.2,
    intensity: 0.7,
    external: [1, 1],
    texture: path.join('Assets', 'AI 美妆_面部.png'),
  });
  assert.deepEqual(out.layers[1], { part: 'pupil', name: '美瞳', object_path: '面部面具/AI 美妆_美瞳', kind: 'eye_color', enabled: true, intensity: 0.35, texture: path.join('Assets', 'AI 美妆_美瞳.png') });
  assert.deepEqual(out.skipped_parts, []);
  assert.deepEqual(out.package_folders, INDEX.map((k, i) => path.join('Assets', `AI 美妆_${PARTS[i + 1].value}.png`)));
  const records = JSON.parse(fs.readdirSync(path.join(STATE, 'imports')).map((f) => fs.readFileSync(path.join(STATE, 'imports', f), 'utf8')).find((s) => s.includes('AI 美妆_唇部')));
  assert.deepEqual(
    Object.values(records).map((r) => [r.name, r.package_folders]),
    INDEX.map((k, i) => [`AI 美妆_${PARTS[i + 1].value}`, [path.join('Assets', `AI 美妆_${PARTS[i + 1].value}.png`)]]),
    'each layer is recorded with its own texture',
  );
});

test('ai_makeup_import a second time keeps the earlier layers and takes the names the editor gives', async () => {
  const { lib, calls } = setup({ tasks: [task('t1', 2), task('t2', 2)] });
  await lib.aiMakeupImport({ task_id: 't1', parts: ['lip'] });
  const out = await lib.aiMakeupImport({ task_id: 't2', parts: ['lip', 'rest'] });
  assert.deepEqual(out.added_objects, [
    { name: 'AI 美妆_面部', object_path: '面部面具/AI 美妆_面部' },
    { name: 'AI 美妆_唇部 (1)', object_path: '面部面具/AI 美妆_唇部 (1)' },
  ]);
  assert.deepEqual(out.layers.map((l) => [l.part, l.texture]), [
    ['rest', path.join('Assets', 'AI 美妆_面部.png')],
    ['lip', path.join('Assets', 'AI 美妆_唇部 (1).png')],
  ]);
  assert.deepEqual(calls.created.map((c) => c.type), ['lip', 'rest', 'lip'], 'parts go in the panel order');
});

test('ai_makeup_import skips a part the extraction gave no texture for', async () => {
  const assets = INDEX.map((k) => (k === 'pupil' ? '' : `https://cdn/t1/${k}.png`));
  const { lib, calls } = setup({ tasks: [task('t1', 2, { assets })] });
  const out = await lib.aiMakeupImport({ task_id: 't1' });
  assert.deepEqual(out.skipped_parts, [{ part: 'pupil', name: '美瞳', reason: '这次提取没有这个部位的贴图' }]);
  assert.equal(calls.download.length, 4);
  await assert.rejects(lib.aiMakeupImport({ task_id: 't1', parts: ['pupil'] }), /AI_MAKEUP_NOTHING_IMPORTED: task t1 has no texture for pupil/);
});

test('ai_makeup_import refuses bad parts, unfinished tasks and a panel import in progress', async () => {
  const { lib, calls, mgr } = setup({ tasks: [task('t1', 2), task('r1', 1)] });
  await assert.rejects(lib.aiMakeupImport({ task_id: 't1', parts: ['lip', 'brow'] }), /INVALID_PARTS: brow; valid: rest, pupil, eyepart, eyelash, lip/);
  await assert.rejects(lib.aiMakeupImport({ task_id: 't1', parts: [] }), /INVALID_PARTS: pass some of/);
  await assert.rejects(lib.aiMakeupImport({ task_id: 'r1' }), /AI_MAKEUP_NOT_FINISHED: task r1 is running/);
  mgr.isImporting.next(true);
  await assert.rejects(lib.aiMakeupImport({ task_id: 't1' }), /AI_MAKEUP_IMPORT_IN_PROGRESS/);
  assert.deepEqual(calls.download, []);
});

test('ai_makeup_import fails loudly when a texture does not download, load or become a layer', async () => {
  for (const [opts, re] of [
    [{ downloadFails: true }, /AI_MAKEUP_DOWNLOAD_FAILED: 面部: timeout/],
    [{ loadState: 'failed' }, /AI_MAKEUP_IMPORT_FAILED: AI 美妆_面部.png did not load/],
    [{ neverLoads: true }, /AI_MAKEUP_IMPORT_FAILED: AI 美妆_面部.png did not load/],
    [{ noLayer: 'eyepart' }, /AI_MAKEUP_LAYER_FAILED: 眼部: 请求失败/],
    [{ pupilRefuses: 'reflectionIntensity' }, /AI_MAKEUP_PUPIL_FAILED: reflectionIntensity: read-only/],
    [{ noComponent: 'pupil' }, /AI_MAKEUP_PUPIL_FAILED: 面部面具\/AI 美妆_美瞳 has no 美瞳 component/],
    [{ noComponent: 'lip' }, /AI_MAKEUP_LAYER_FAILED: 面部面具\/AI 美妆_唇部 has no makeup component/],
  ]) {
    const s = setup(opts);
    await assert.rejects(s.lib.aiMakeupImport({ task_id: 't1' }), re, JSON.stringify(opts));
    assert.equal(s.mgr.isImporting.getValue(), false, `${JSON.stringify(opts)}: the panel is released`);
    assert.equal((s.listeners.get('assetAIVideoToast') || []).length, 0);
  }
});

test('ai_makeup calls refuse to run when the panel internals are missing', async () => {
  const { lib, modules, calls, root } = setup();
  delete modules[M.aiMakeupManager].AIMakeupManager.prototype.createCorrespondingEntity;
  await assert.rejects(lib.aiMakeupSubmit({ image_path: file(root, 'ref.png') }), /INCOMPATIBLE_EDITOR: missing .*createCorrespondingEntity/);
  await assert.rejects(lib.aiMakeupTasks({}), /INCOMPATIBLE_EDITOR/);
  await assert.rejects(lib.aiMakeupImport({ task_id: 't1' }), /INCOMPATIBLE_EDITOR/);
  assert.equal(lib.selfCheck().features.aiMakeup, false);
  assert.deepEqual([calls.history, calls.submit], [[], []]);
});
