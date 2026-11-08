import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.XIANGSU_MCP_EXT_STATE = tmpdir('xs-state-');
const { Library, M } = require('../editor-plugin/library.cjs');

const ID = { Image: '7488219358821416986', Video: '7492709644196986918', Animation: '7596953578066034714' };
const SCENE = { Image: 'AI3DModelImagePC', Video: 'AI3DModelVideoPC', Animation: 'AI3DModelAnimationPC' };
const I18N = { ai_3d_generation: '图生 3D 模型', ai_3d_generation_scale: '模型大小控制', ai_3d_generation_mesh: '模型网格', '3d_gen_preset_model_whole': '全身' };
const BONES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'];

function file(dir, name, bytes = 16) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

// A fake editor: the AI 3D folder, the cloud APIs (recording every request), uploads, the video probe,
// the FBX loader, the importer and a scene the importer adds objects to.
function setup(opts = {}) {
  const root = tmpdir('xs-ai3d-');
  const folder = path.join(root, 'AIGen3D');
  const app = path.join(root, 'app');
  file(app, 'BuiltinResource/AssetLibrary/3d_gen_preset_model_whole.fbx');
  const calls = { submit: [], upload: [], space: [], history: [], query: [], cancel: [], exec: [], download: [], imported: [], segQuery: [] };
  const running = opts.running ?? 0;
  const meta = { valid: true, width: 720, height: 1280, duration: 3483000, size: 0.85, ...opts.meta };
  const results = opts.results || {};
  const sceneObjects = [{ name: '已有', parent: null }];
  const project = { path: path.join(root, 'proj'), resourceManager: { getAllResources: () => [] } };
  class Vector3f {
    constructor(x, y, z) {
      Object.assign(this, { x, y, z });
    }
  }
  const node = (name, parent) => {
    const transform = {};
    const so = { name, parent, children: [], target: { getComponent: (t) => (t === 'Transform' ? transform : null) }, transform, getChildren: () => so.children };
    if (parent) parent.children.push(so);
    sceneObjects.push(so);
    return so;
  };
  const modules = {
    [M.ai3dConst]: { AIGen3DModelScene: SCENE, AIGenModelIdMap: ID, AIGen3DModelQueryStatus: [1, 2, 3], AIGen3DFolder: folder },
    [M.ai3dUtils]: {
      getGen3DModelLocalInfoByTaskId: (id) => {
        const dir = path.join(folder, id);
        return {
          zipLocalPath: `${dir}.zip`,
          unzipLocalPath: dir,
          previewVideoCoverPath: path.join(dir, 'preview.png'),
          previewVideoPath: path.join(dir, 'preview.mp4'),
          modelPath: path.join(dir, 'mesh.glb'),
          plyPath: path.join(dir, 'splat.ply'),
          originFbxPath: path.join(dir, 'input.fbx'),
          resultFbxPath: path.join(dir, 'output.fbx'),
        };
      },
    },
    [M.aiEffectApi]: {
      submitAIGCRequest: async (req) => {
        calls.submit.push(req);
        if (opts.submitFails) return { body: { code: 4001, message: '额度不足' } };
        return { body: { code: 0, data: { taskId: `task-${calls.submit.length}` } } };
      },
      queryAITaskHistories: async (req) => {
        calls.history.push(req);
        if (req.size > 20) return { code: 5062, message: 'AI历史记录查询超出最大条数限制' };
        if (req.statusList.length === 1) return { code: 0, data: { taskRecords: Array.from({ length: running }, (_, i) => ({ taskId: `r${i}`, status: 1 })) } };
        if (opts.historyPages) {
          const i = req.cursor / 100;
          return { code: 0, data: { taskRecords: opts.historyPages[i] || [], nextCursor: (i + 1) * 100, hasMore: i + 1 < opts.historyPages.length } };
        }
        return { code: 0, data: { taskRecords: opts.records || [], nextCursor: 5, hasMore: true } };
      },
      queryAIGCResult: async ({ taskId }) => {
        calls.query.push(taskId);
        const r = results[taskId];
        const data = typeof r === 'function' ? r(calls.query.filter((t) => t === taskId).length) : r;
        return data ? { code: 0, data } : { code: 1001, message: 'task not found' };
      },
      cancelAIGCRequest: async ({ taskId }) => (calls.cancel.push(taskId), { code: 0 }),
    },
    [M.uploadApi]: {
      FileType: { File: 0, Picture: 1, Video: 2 },
      uploadFileCommon: async ({ filePath, fileType }) => {
        calls.upload.push({ name: path.basename(filePath), fileType, existed: fs.existsSync(filePath) });
        return { code: 0, data: { decryptedUri: `tos-${path.basename(filePath)}`, url: `https://cdn/${path.basename(filePath)}` } };
      },
      uploadToSpace: async ({ filePath, fileType }) => {
        calls.space.push({ name: path.basename(filePath), fileType });
        return { code: 0, data: { res: true, videoInfo: { vid: 'vid-1', duration: 3.48, width: 720, height: 1280 } } };
      },
    },
    [M.aigcUtils]: { getAIGCEnv: () => 'prod' },
    [M.lokiUtils]: {
      downloadTemplateFile: async (url, dest, timeout) => {
        calls.download.push({ url, dest, timeout });
        fs.writeFileSync(dest, 'zip');
        return dest;
      },
    },
    [M.aiApiUtils]: {
      QueryTaskResult: async (id, interval, timeout) => {
        calls.segQuery.push({ id, interval, timeout });
        if (opts.segment === 'fail') throw Error('timeout');
        const lists = opts.segment === 'empty' ? { image_url_list: [], image_info_list: [] } : { image_url_list: ['https://cdn/subject.png'], image_info_list: [{ uri: 'tos-subject' }] };
        return { status: 'success', result: { output_node_list: [lists] } };
      },
    },
    [M.resImport]: {
      ResourceImportHandles: {
        importExtAsset: (files, ...rest) => {
          calls.imported.push({ files, rest, existed: files.map((f) => fs.existsSync(f)) });
          return { name: path.basename(files[0]), subResourceItems: [{ name: 'mesh' }] };
        },
        registerLoadingCallbackByResItem: (item, cb) => cb(item, opts.importState || 'loaded'),
      },
    },
    [M.preview]: {
      PreviewManager: class {
        static getInstance() {
          return new this();
        }
        checkIsValidVideoFile() {
          return meta;
        }
        getFirstNonBlackFrame(video, out) {
          if (!opts.noCover) fs.writeFileSync(out, 'png');
        }
      },
    },
    [M.ef]: {
      ProjectManager: { getInstance: () => ({ hasActiveProject: () => true, getCurrentActiveProject: () => project }) },
      APJS: {
        Vector3f,
        FbxLoaderAPJSWrapper: {
          createFromPathAsync: async () => ({
            getTriangleCount: () => opts.rig?.triangles ?? 5000,
            getVertexCount: () => 3000,
            getMaxBoneCount: () => opts.rig?.bones ?? 40,
            getAllNodeNames: () => opts.rig?.names ?? BONES.map((b) => b.toLowerCase()),
          }),
        },
      },
      ImportLimitationNumber: { BONE_NUM_LIMIT: 100, SKIN_MESH_TRIANGLE_HARD_NUM_LIMIT: 120000 },
      Extension: {
        Scene: {
          AssetSceneObjectCreationSystem: {
            createSceneObjectFromAssetWithUndo: ({ resItems }) =>
              resItems.map((item) => {
                const top = node(item.name, null);
                node('mesh', node('scale', top));
                return top;
              }),
          },
        },
      },
      SceneView: { SceneView: { repaintAll: () => {} } },
    },
    [M.scene]: { SceneModule: { getEditingSceneService: () => ({ sceneEditor: { getAllSceneObjectEditors: () => [...sceneObjects] } }) } },
    [M.orionui]: { I18n: { t: (k) => I18N[k] || k }, url: (p) => path.relative('.', p) },
    [M.globalConfig]: { url: (p) => path.join(app, p) },
  };
  const mod = (name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  };
  const lib = new Library(mod);
  lib.ai3dPollMs = 1;
  lib.ai3dExec = (cmd, args) => {
    calls.exec.push([cmd, ...args]);
    if (cmd === 'sips') return `  pixelWidth: ${opts.image?.width ?? 1024}\n  pixelHeight: ${opts.image?.height ?? 1024}\n`;
    if (cmd === 'zip') fs.writeFileSync(args[2], 'zip');
    if (cmd === 'ditto') {
      const dir = args[3];
      for (const f of opts.unzipped || ['mesh.glb', 'preview.png', 'preview.mp4']) file(dir, f);
    }
    return '';
  };
  return { lib, calls, modules, root, folder, app, sceneObjects };
}

const finished = { status: 2, outputNodeList: [{ objectInfoList: [{ url: 'https://cdn/result.zip' }] }] };

test('ai3d_image_submit uploads the image and sends the request the panel sends', async () => {
  const { lib, calls, root } = setup();
  const img = file(root, 'dog.PNG');
  const out = await lib.ai3dImageSubmit({ image_path: img, precision: 'high' });
  assert.deepEqual(out, { task_id: 'task-1', kind: 'image', precision: 'high', face_num: 50000, image: { width: 1024, height: 1024 } });
  assert.deepEqual(calls.upload, [{ name: 'dog.PNG', fileType: 1, existed: true }]);
  assert.deepEqual(calls.submit, [
    {
      inputNodeList: [
        {
          source: `loki_material://${ID.Image}`,
          params: JSON.stringify({ business_type: 'dyeh', dyeh_custom_params: { req_json: { faceNum: 50000 } } }),
          uriList: ['tos-dog.PNG'],
          aigc_env: 'prod',
        },
      ],
      scene: SCENE.Image,
      needRecord: true,
    },
  ]);
  assert.deepEqual(calls.history[0], { cursor: 0, size: 3, scene: SCENE.Image, statusList: [1] });
  await lib.ai3dImageSubmit({ image_path: img });
  assert.equal(JSON.parse(calls.submit[1].inputNodeList[0].params).dyeh_custom_params.req_json.faceNum, 10000, 'medium by default');
});

test('ai3d_image_submit refuses images the panel would refuse, before uploading anything', async () => {
  const { lib, calls, root } = setup();
  await assert.rejects(lib.ai3dImageSubmit({ image_path: 'dog.png' }), /IMAGE_PATH_NOT_ABSOLUTE/);
  await assert.rejects(lib.ai3dImageSubmit({ image_path: path.join(root, 'none.png') }), /IMAGE_NOT_FOUND/);
  await assert.rejects(lib.ai3dImageSubmit({ image_path: file(root, 'dog.webp') }), /IMAGE_FORMAT: dog.webp; supported: png, jpg, jpeg/);
  await assert.rejects(lib.ai3dImageSubmit({ image_path: file(root, 'big.jpg', 10 * 1024 * 1024 + 1) }), /IMAGE_TOO_LARGE: 10.0 MB/);
  await assert.rejects(lib.ai3dImageSubmit({ image_path: file(root, 'ok.jpg'), precision: 'ultra' }), /INVALID_PRECISION: ultra/);
  const wide = setup({ image: { width: 4001, height: 300 } });
  await assert.rejects(wide.lib.ai3dImageSubmit({ image_path: file(wide.root, 'wide.png') }), /IMAGE_RESOLUTION: 4001×300/);
  const edge = setup({ image: { width: 4000, height: 4000 } });
  assert.equal((await edge.lib.ai3dImageSubmit({ image_path: file(edge.root, 'edge.png') })).task_id, 'task-1');
  assert.deepEqual([calls.upload, calls.submit, wide.calls.upload], [[], [], []]);
});

test('ai3d submits stop at the panel limit of three running tasks', async () => {
  const { lib, calls, root } = setup({ running: 3 });
  await assert.rejects(lib.ai3dImageSubmit({ image_path: file(root, 'a.png') }), /AI3D_TOO_MANY_RUNNING: 3 image tasks/);
  await assert.rejects(lib.ai3dAnimationSubmit({ video_path: file(root, 'a.mp4') }), /AI3D_TOO_MANY_RUNNING: 3 animation tasks/);
  assert.deepEqual([calls.upload, calls.space, calls.submit], [[], [], []]);
  const two = setup({ running: 2 });
  assert.equal((await two.lib.ai3dImageSubmit({ image_path: file(two.root, 'a.png') })).task_id, 'task-1');
});

test('ai3d submit failures carry the cloud message', async () => {
  const { lib, root } = setup({ submitFails: true });
  await assert.rejects(lib.ai3dImageSubmit({ image_path: file(root, 'a.png') }), /AI3D_SUBMIT_FAILED: code=4001 message=额度不足/);
});

test('ai3d_animation_submit with a preset model uploads cover, zipped model and video like the panel', async () => {
  const { lib, calls, root, folder, app } = setup();
  const video = file(root, 'dance.mp4');
  const out = await lib.ai3dAnimationSubmit({ video_path: video });
  assert.deepEqual(out, { task_id: 'task-1', kind: 'animation', model: 'whole', video: { width: 720, height: 1280, seconds: 3.48 } });
  assert.deepEqual(calls.upload.map(({ name, fileType, existed }) => [name, fileType, existed]), [
    ['cover.png', 1, true],
    ['model.zip', 0, true],
  ]);
  assert.deepEqual(calls.space, [{ name: 'dance.mp4', fileType: 2 }]);
  const zip = calls.exec.find((c) => c[0] === 'zip');
  assert.deepEqual([zip.slice(0, 3), zip[4]], [['zip', '-j', '-q'], path.join(app, './BuiltinResource/AssetLibrary/3d_gen_preset_model_whole.fbx')]);
  const req = calls.submit[0];
  assert.deepEqual([req.scene, req.needRecord, req.inputNodeList[0].source, req.inputNodeList[0].uriList], [SCENE.Animation, true, `loki_material://${ID.Animation}`, undefined]);
  assert.deepEqual(JSON.parse(req.inputNodeList[0].params), {
    model: 'tos://tos-model.zip',
    video: 'vid-1',
    req_json: { videoCoverUri: 'https://cdn/cover.png', presetModel: '3d_gen_preset_model_whole', localModel: '' },
  });
  assert.deepEqual(fs.readdirSync(folder), [], 'the scratch upload folder is removed');
  fs.rmSync(path.join(app, 'BuiltinResource'), { recursive: true });
  await assert.rejects(lib.ai3dAnimationSubmit({ video_path: video }), /PRESET_MODEL_MISSING/);
  assert.equal(calls.submit.length, 1);
});

test('ai3d_animation_submit checks a local model the way the panel does', async () => {
  const ok = setup();
  const fbx = file(ok.root, 'models/frog.FBX');
  const out = await ok.lib.ai3dAnimationSubmit({ video_path: file(ok.root, 'a.mp4'), model: fbx });
  assert.deepEqual([out.model, out.model_check, out.warning], [fbx, { bones: 40, triangles: 5000, missing_bones: [] }, undefined]);
  assert.deepEqual(JSON.parse(ok.calls.submit[0].inputNodeList[0].params).req_json, { videoCoverUri: 'https://cdn/cover.png', presetModel: '', localModel: 'frog.FBX' });

  const prefixed = setup({ rig: { names: BONES.map((b) => `mixamorig_${b}`) } });
  const warned = await prefixed.lib.ai3dAnimationSubmit({ video_path: file(prefixed.root, 'a.mp4'), model: file(prefixed.root, 'frog.fbx') });
  assert.deepEqual(warned.model_check.missing_bones, BONES);
  assert.match(warned.warning, /mixamorig_/);
  assert.equal(prefixed.calls.submit.length, 1, 'missing bones only warn, as in the editor');

  for (const [rig, re] of [
    [{ bones: 0 }, /MODEL_NOT_RIGGED: frog.fbx has no skeleton/],
    [{ bones: 101 }, /MODEL_TOO_MANY_BONES: 101; the limit is 100/],
    [{ triangles: 120001 }, /MODEL_TOO_MANY_TRIANGLES: 120001; the limit is 120000/],
  ]) {
    const s = setup({ rig });
    await assert.rejects(s.lib.ai3dAnimationSubmit({ video_path: file(s.root, 'a.mp4'), model: file(s.root, 'frog.fbx') }), re);
    assert.deepEqual([s.calls.upload, s.calls.submit], [[], []]);
  }
  await assert.rejects(ok.lib.ai3dAnimationSubmit({ video_path: file(ok.root, 'a.mp4'), model: 'dragon' }), /INVALID_MODEL: dragon/);
  await assert.rejects(ok.lib.ai3dAnimationSubmit({ video_path: file(ok.root, 'a.mp4'), model: file(ok.root, 'frog.glb') }), /MODEL_FORMAT: frog.glb; supported: fbx/);
});

test('ai3d video checks use the panel limits for each kind', async () => {
  for (const [kind, call, meta, re] of [
    ['animation', 'ai3dAnimationSubmit', { duration: 30000001 }, /VIDEO_TOO_LONG: 30.0 s; the limit is 30 s/],
    ['animation', 'ai3dAnimationSubmit', { width: 1281 }, /VIDEO_RESOLUTION: 1281×1280; the limit is 1280×1280/],
    ['animation', 'ai3dAnimationSubmit', { size: 20.5 }, /VIDEO_TOO_LARGE: 20.5 MB; the limit is 20 MB/],
    ['animation', 'ai3dAnimationSubmit', { valid: false }, /VIDEO_UNREADABLE/],
    ['gs', 'ai3dGsSegment', { duration: 120000001 }, /VIDEO_TOO_LONG: 120.0 s; the limit is 120 s/],
    ['gs', 'ai3dGsSegment', { width: 4001, height: 100 }, /VIDEO_RESOLUTION: 4001×100/],
    ['gs', 'ai3dGsSegment', { size: 101 }, /VIDEO_TOO_LARGE: 101.0 MB; the limit is 100 MB/],
  ]) {
    const s = setup({ meta });
    await assert.rejects(s.lib[call]({ video_path: file(s.root, 'v.mp4') }), re, `${kind} ${JSON.stringify(meta)}`);
    assert.deepEqual([s.calls.space, s.calls.submit], [[], []]);
  }
  const s = setup({ meta: { duration: 30000000, width: 1280, size: 20 } });
  assert.equal((await s.lib.ai3dAnimationSubmit({ video_path: file(s.root, 'v.mp4') })).task_id, 'task-1');
  await assert.rejects(s.lib.ai3dAnimationSubmit({ video_path: file(s.root, 'v.mov') }), /VIDEO_FORMAT: v.mov; supported: mp4/);
  const gs = setup({ meta: { duration: 100e6, width: 3840, height: 2160, size: 90 } });
  assert.equal((await gs.lib.ai3dGsSegment({ video_path: file(gs.root, 'v.MOV') })).seg_task_id, 'task-1');
  const blank = setup({ noCover: true });
  await assert.rejects(blank.lib.ai3dAnimationSubmit({ video_path: file(blank.root, 'v.mp4') }), /VIDEO_COVER_FAILED/);
});

test('ai3d_gs_segment finds the subject first; ai3d_gs_submit then builds it as the confirm button does', async () => {
  const { lib, calls, root } = setup();
  const seg = await lib.ai3dGsSegment({ video_path: file(root, 'cup.mov'), wait_s: 30 });
  const req_json = { req_type: 1, vid: 'vid-1', prompt: '', duration: 3.48, width: 720, height: 1280 };
  assert.deepEqual(seg, { seg_task_id: 'task-1', subject_image_url: 'https://cdn/subject.png', subject_uri: 'tos-subject', req_json });
  assert.deepEqual(calls.submit[0], {
    inputNodeList: [{ source: `loki_material://${ID.Video}`, params: JSON.stringify({ business_type: 'dyeh', dyeh_custom_params: { req_json } }), uriList: [''], aigc_env: 'prod' }],
    scene: SCENE.Video,
    needRecord: false,
  });
  assert.deepEqual(calls.segQuery, [{ id: 'task-1', interval: 1000, timeout: 30000 }]);
  const out = await lib.ai3dGsSubmit({ subject_uri: seg.subject_uri, req_json: seg.req_json });
  assert.deepEqual(out, { task_id: 'task-2', kind: 'gs' });
  assert.deepEqual(calls.submit[1].inputNodeList[0].uriList, ['tos-subject']);
  assert.equal(calls.submit[1].needRecord, true);
  assert.deepEqual(JSON.parse(calls.submit[1].inputNodeList[0].params).dyeh_custom_params.req_json, { ...req_json, req_type: 0 });
  await assert.rejects(lib.ai3dGsSubmit({ subject_uri: '', req_json }), /INVALID_SUBJECT/);
});

test('ai3d_gs_segment reports a failed or empty subject search', async () => {
  const failed = setup({ segment: 'fail' });
  await assert.rejects(failed.lib.ai3dGsSegment({ video_path: file(failed.root, 'v.mp4') }), /AI3D_SUBJECT_FAILED: timeout \(task task-1\)/);
  const empty = setup({ segment: 'empty' });
  await assert.rejects(empty.lib.ai3dGsSegment({ video_path: file(empty.root, 'v.mp4') }), /AI3D_SUBJECT_NOT_FOUND/);
});

test('ai3d_tasks lists the history with readable status, input, failure and local files', async () => {
  const records = [
    { taskId: 11, status: 2, createTime: 1794121000, finishTime: 1794121100, inputNodeList: [{ params: JSON.stringify({ dyeh_custom_params: { req_json: { faceNum: 1000 } } }) }] },
    { taskId: 12, status: 1, createTime: 1794121200, finishTime: 1794121200, inputNodeList: [{ params: '{}' }] },
    { taskId: 13, status: 3, createTime: 1794121300, finishTime: 1794121310, inputNodeList: [], outputNodeList: [{ textList: ['图片中未识别到主体'] }] },
  ];
  const { lib, calls, folder } = setup({ records });
  file(folder, '11/preview.png');
  const out = await lib.ai3dTasks({ kind: 'image', cursor: 0, count: 3 });
  assert.deepEqual(calls.history.at(-1), { cursor: 0, size: 3, scene: SCENE.Image, statusList: [1, 2, 3] });
  assert.deepEqual(out, {
    kind: 'image',
    next_cursor: 5,
    has_more: true,
    items: [
      { task_id: '11', status: 'finished', created_at: '2026-11-08T06:56:40.000Z', finished_at: '2026-11-08T06:58:20.000Z', precision: 'low', face_num: 1000, downloaded: true, preview_image_file: path.join(folder, '11/preview.png'), preview_video_file: null },
      { task_id: '12', status: 'running', created_at: '2026-11-08T07:00:00.000Z', finished_at: null, precision: null, face_num: null, downloaded: false, preview_image_file: null, preview_video_file: null },
      { task_id: '13', status: 'failed', created_at: '2026-11-08T07:01:40.000Z', finished_at: '2026-11-08T07:01:50.000Z', precision: null, face_num: null, failure: '图片中未识别到主体', downloaded: false, preview_image_file: null, preview_video_file: null },
    ],
  });
  const anim = setup({ records: [{ taskId: 21, status: 2, inputNodeList: [{ params: JSON.stringify({ req_json: { presetModel: '3d_gen_preset_model_whole' } }) }] }, { taskId: 22, status: 2, inputNodeList: [{ params: JSON.stringify({ req_json: { presetModel: '', localModel: 'frog.fbx' } }) }] }] });
  assert.deepEqual((await anim.lib.ai3dTasks({ kind: 'animation' })).items.map((i) => i.model), ['whole', 'frog.fbx']);
  await assert.rejects(lib.ai3dTasks({ kind: 'video' }), /INVALID_KIND: video; valid: image, animation, gs/);
});

test('ai3d_task waits while the task runs and stops at the deadline', async () => {
  const { lib, calls } = setup({ results: { t1: (n) => (n < 3 ? { status: 1 } : finished), t2: { status: 1 }, t3: { status: 3, outputNodeList: [{ textList: ['生成失败'] }] } } });
  assert.deepEqual(await lib.ai3dTask({ task_id: 't1', wait_s: 5 }), { task_id: 't1', status: 'finished', result_ready: true, downloaded: false, preview_image_file: null, preview_video_file: null });
  assert.equal(calls.query.filter((t) => t === 't1').length, 3);
  assert.equal((await lib.ai3dTask({ task_id: 't2' })).status, 'running');
  assert.equal(calls.query.filter((t) => t === 't2').length, 1, 'without wait_s it asks once');
  assert.equal((await lib.ai3dTask({ task_id: 't3', wait_s: 5 })).failure, '生成失败');
  await assert.rejects(lib.ai3dTask({ task_id: 'nope' }), /AI3D_QUERY_FAILED: task nope code=1001 message=task not found/);
});

test('ai3d_import downloads, unzips and imports a 3D model the way 「导入素材」 does', async () => {
  const { lib, calls, folder } = setup({ results: { m1: finished } });
  const out = await lib.ai3dImport({ task_id: 'm1', kind: 'image' });
  assert.deepEqual(calls.download, [{ url: 'https://cdn/result.zip', dest: path.join(folder, 'm1.zip'), timeout: 30000 }]);
  assert.deepEqual(calls.exec.find((c) => c[0] === 'ditto'), ['ditto', '-x', '-k', path.join(folder, 'm1.zip'), path.join(folder, 'm1')]);
  const copy = path.join(folder, 'm1', '图生 3D 模型.glb');
  assert.deepEqual(calls.imported, [{ files: [copy], rest: [false, undefined, true, { enablePopupWindow: false }], existed: [true] }]);
  assert.equal(fs.existsSync(copy), false, 'the import copy is removed, as in the editor');
  assert.deepEqual(out.added_objects, [
    { name: '图生 3D 模型.glb', object_path: '图生 3D 模型.glb' },
  ]);
  assert.deepEqual([out.downloaded, out.preview_image_file], [true, path.join(folder, 'm1', 'preview.png')]);
  // A second import reuses the downloaded result.
  await lib.ai3dImport({ task_id: 'm1', kind: 'image' });
  assert.equal(calls.download.length, 1);
  assert.equal(calls.exec.filter((c) => c[0] === 'ditto').length, 1);
});

test('ai3d_import tags the asset and sizes the objects like the editor', async () => {
  const s = setup({ results: { m1: finished } });
  let item;
  const orig = s.modules[M.resImport].ResourceImportHandles.importExtAsset;
  s.modules[M.resImport].ResourceImportHandles.importExtAsset = (...a) => (item = orig(...a));
  await s.lib.ai3dImport({ task_id: 'm1', kind: 'image' });
  assert.deepEqual([item.assetPackageID, item.assetStudioData, item.subResourceItems[0].assetPackageID], ['AIAsset_3DMesh_m1', { id: 'AIAsset_3DMesh_m1', styleTag: '', type: 'AIAsset_ImageTo3D' }, 'AIAsset_3DMesh_m1']);
  const scale = s.sceneObjects.find((o) => o.name === '模型大小控制');
  assert.deepEqual([{ ...scale.transform.localScale }, scale.children[0].name], [{ x: 15, y: 15, z: 15 }, '模型网格']);

  const gs = setup({ results: { g1: finished }, unzipped: ['splat.ply'] });
  await gs.lib.ai3dImport({ task_id: 'g1', kind: 'gs' });
  const top = gs.sceneObjects.find((o) => o.name === '视频生3DGS模型.ply');
  assert.deepEqual({ ...top.transform.localScale }, { x: 0.3, y: 0.3, z: 0.3 });

});

test('ai3d_import names an animation after the model its history record was made with', async () => {
  const rec = (taskId, req_json) => ({ taskId, status: 2, inputNodeList: [{ params: JSON.stringify({ req_json }) }] });
  // queryAIGCResult carries no input; only the history record says which model was used.
  const historyPages = [[rec(30, { presetModel: '3d_gen_preset_model_arm' }), rec('a2', { presetModel: '', localModel: 'frog.fbx' })], [rec('a1', { presetModel: '3d_gen_preset_model_whole' })]];
  const anim = setup({ results: { a1: finished, a2: finished, a3: finished }, unzipped: ['output.fbx'], historyPages });
  const out = await anim.lib.ai3dImport({ task_id: 'a1', kind: 'animation' });
  const kept = path.join(anim.folder, 'a1', 'animationResult', '全身.fbx');
  assert.deepEqual([anim.calls.imported[0].files, fs.existsSync(kept), out.added_objects[0].name], [[kept], true, '全身.fbx']);
  assert.deepEqual(anim.calls.history.map((h) => [h.cursor, h.size, h.scene]), [[0, 20, SCENE.Animation], [100, 20, SCENE.Animation]]);
  await anim.lib.ai3dImport({ task_id: 'a2', kind: 'animation' });
  assert.deepEqual(anim.calls.imported[1].files, [path.join(anim.folder, 'a2', 'animationResult', 'frog.fbx')]);
  // Not in the history at all: named after the task.
  await anim.lib.ai3dImport({ task_id: 'a3', kind: 'animation' });
  assert.deepEqual(anim.calls.imported[2].files, [path.join(anim.folder, 'a3', 'animationResult', 'a3.fbx')]);
  assert.equal(anim.calls.history.length, 5, 'stops at the last page');
});

test('ai3d_import refuses unfinished tasks, missing results and failed imports', async () => {
  const s = setup({ results: { run: { status: 1 }, empty: { status: 2, outputNodeList: [{}] }, m1: finished } });
  await assert.rejects(s.lib.ai3dImport({ task_id: 'run', kind: 'image' }), /AI3D_NOT_FINISHED: task run is running/);
  await assert.rejects(s.lib.ai3dImport({ task_id: 'empty', kind: 'image' }), /AI3D_NO_RESULT/);
  await assert.rejects(s.lib.ai3dImport({ task_id: 'm1', kind: 'gs' }), /AI3D_RESULT_MISSING: splat.ply is not in task m1's result; is it a gs task\?/);
  assert.deepEqual(s.calls.imported, []);
  const bad = setup({ results: { m1: finished }, importState: 'failed' });
  await assert.rejects(bad.lib.ai3dImport({ task_id: 'm1', kind: 'image' }), /AI3D_IMPORT_FAILED/);
  assert.equal(bad.sceneObjects.length, 1);
});

test('ai3d_cancel cancels the task', async () => {
  const { lib, calls } = setup();
  assert.deepEqual(await lib.ai3dCancel({ task_id: 't9' }), { task_id: 't9', cancelled: true });
  assert.deepEqual(calls.cancel, ['t9']);
});

test('ai3d calls refuse to run when the AI 3D internals are missing', async () => {
  const { lib, modules, calls, root } = setup();
  delete modules[M.aiEffectApi].submitAIGCRequest;
  await assert.rejects(lib.ai3dImageSubmit({ image_path: file(root, 'a.png') }), /INCOMPATIBLE_EDITOR: missing .*submitAIGCRequest/);
  await assert.rejects(lib.ai3dTasks({ kind: 'image' }), /INCOMPATIBLE_EDITOR/);
  assert.equal(lib.selfCheck().features.ai3d, false);
  assert.deepEqual(calls.upload, []);
});
