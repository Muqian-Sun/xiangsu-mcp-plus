'use strict';
// AI 3D (素材库 › AI 3D): 图生3D (an image → a static GLB mesh), 3D 动画 (an FBX with the standard humanoid
// skeleton + a reference video → that FBX animated with the video's motion) and 高精度模型重建 (an orbit
// video of a real object → a 3D Gaussian splat). Requests are the ones AI3DManager makes; results are
// downloaded to and imported from the folder the panel uses, so the panel finds them as well.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { M, editingScene, sceneObjectSet, addedObjectEditors, sceneObjectPath, projectResources, packageRootsAdded, recordImport } = require('./common.cjs');

// The panel's names for the three generation types (AI3DManager/type AIGenType).
const GEN_TYPE = { image: 'Image', animation: 'Animation', gs: 'Video' };
// The precision options of 图生3D (FaceNumSelection, 9.8.1).
const FACE_NUM = { low: 1000, medium: 10000, high: 50000 };
// The upload panels' own checks (9.8.1): extensions from the panels' texts, numbers from their code.
// The image panel measures images with the video probe, which reads 0 for pictures, so in the editor
// only the extension is really checked; the size and resolution here are the limits its text states.
const IMAGE_LIMIT = { exts: ['png', 'jpg', 'jpeg'], maxSide: 4000, maxMB: 10 };
const VIDEO_LIMIT = {
  animation: { exts: ['mp4'], maxSide: 1280, maxMB: 20, maxSeconds: 30 },
  gs: { exts: ['mp4', 'mov'], maxSide: 4000, maxMB: 100, maxSeconds: 120 },
};
// The panel refuses a fourth running task of the same type (3d_gen_max_limit).
const MAX_RUNNING = 3;
// Built-in reference models of 3D 动画 (BuiltinResource/AssetLibrary/<id>.fbx).
const PRESET_MODELS = {
  whole: '3d_gen_preset_model_whole',
  upper_body: '3d_gen_preset_model_upper_body',
  lower_body: '3d_gen_preset_model_lower_body',
  arm: '3d_gen_preset_model_arm',
};
// Bones the animation panel looks for in an uploaded model (case-insensitive, whole names). Missing ones
// only bring up a warning there; the model is still used.
const REQUIRED_BONES = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
];
const STATUS = { 1: 'running', 2: 'finished', 3: 'failed', 4: 'discarded' };
// How the editor tags and sizes each kind of result when importing it (AI3DManager.import*Model).
const IMPORT = {
  image: { file: 'modelPath', idPrefix: 'AIAsset_3DMesh_', type: 'AIAsset_ImageTo3D' },
  gs: { file: 'plyPath', idPrefix: 'AIAsset_3DGS_', type: 'AIAsset_VideoTo3DGS' },
  animation: { file: 'resultFbxPath', idPrefix: 'AIAsset_Animation_', type: 'AIDanceToAnimation' },
};
// Picked, not measured: often enough to notice a finished task soon, rare enough not to hammer the API.
const POLL_MS = 3000;
// Same as the panel's TaskSucceed download.
const DOWNLOAD_TIMEOUT_MS = 30000;
// Measured: the history API answers 5062 「超出最大条数限制」 for a page of more than 20 (the panel asks for 5).
const HISTORY_PAGE = 20;
// Picked: how far back an import looks for a task's own record (queryAIGCResult does not return the
// input); 10 pages of 20 reach well past what anyone keeps importing from.
const HISTORY_PAGES = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseJson(s) {
  if (typeof s !== 'string' || !s) return {};
  try {
    return JSON.parse(s);
  } catch (_) {
    return {};
  }
}

function ext(file) {
  return path.extname(file).slice(1).toLowerCase();
}

function checkFile(file, exts, what) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error(`${what}_PATH_NOT_ABSOLUTE: ${file}`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw Error(`${what}_NOT_FOUND: ${file}`);
  if (!exts.includes(ext(file))) throw Error(`${what}_FORMAT: ${path.basename(file)}; supported: ${exts.join(', ')}`);
  return file;
}

function checkKind(kind) {
  if (!Object.prototype.hasOwnProperty.call(GEN_TYPE, kind)) throw Error(`INVALID_KIND: ${kind}; valid: ${Object.keys(GEN_TYPE).join(', ')}`);
  return kind;
}

const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : null);

// What the record says about its own input, read the way the panel's 「重新编辑」 reads it.
function taskInput(kind, record) {
  const params = parseJson(((record.inputNodeList || [])[0] || {}).params);
  if (kind === 'animation') {
    const req = params.req_json || {};
    const preset = Object.keys(PRESET_MODELS).find((k) => PRESET_MODELS[k] === req.presetModel);
    return preset ? { model: preset } : { model: req.localModel || null };
  }
  const req = (params.dyeh_custom_params && params.dyeh_custom_params.req_json) || {};
  if (kind === 'image') {
    const precision = Object.keys(FACE_NUM).find((k) => FACE_NUM[k] === req.faceNum);
    return { precision: precision || null, face_num: req.faceNum ?? null };
  }
  return {};
}

function failureText(record) {
  const out = (record.outputNodeList || [])[0] || {};
  return (out.textList || [])[0] || null;
}

const methods = {
  ai3dRun(cmd, args) {
    return (this.ai3dExec || execFileSync)(cmd, args, { encoding: 'utf8' });
  },

  ai3dConst() {
    return this.mod(M.ai3dConst);
  },

  ai3dCheckImage(file) {
    checkFile(file, IMAGE_LIMIT.exts, 'IMAGE');
    const mb = fs.statSync(file).size / (1024 * 1024);
    if (mb > IMAGE_LIMIT.maxMB) throw Error(`IMAGE_TOO_LARGE: ${mb.toFixed(1)} MB; the limit is ${IMAGE_LIMIT.maxMB} MB`);
    const out = this.ai3dRun('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
    const width = Number((/pixelWidth:\s*(\d+)/.exec(out) || [])[1]);
    const height = Number((/pixelHeight:\s*(\d+)/.exec(out) || [])[1]);
    if (!(width > 0 && height > 0)) throw Error(`NOT_AN_IMAGE: ${file}`);
    if (width > IMAGE_LIMIT.maxSide || height > IMAGE_LIMIT.maxSide) throw Error(`IMAGE_RESOLUTION: ${width}×${height}; the limit is ${IMAGE_LIMIT.maxSide}×${IMAGE_LIMIT.maxSide}`);
    return { width, height };
  },

  ai3dCheckVideo(file, kind) {
    const limit = VIDEO_LIMIT[kind];
    checkFile(file, limit.exts, 'VIDEO');
    const meta = this.mod(M.preview).PreviewManager.getInstance().checkIsValidVideoFile(file);
    if (!meta || !meta.valid) throw Error(`VIDEO_UNREADABLE: ${file}`);
    // The probe gives the duration in microseconds and the size in MB.
    const seconds = meta.duration / 1e6;
    if (seconds > limit.maxSeconds) throw Error(`VIDEO_TOO_LONG: ${seconds.toFixed(1)} s; the limit is ${limit.maxSeconds} s`);
    if (meta.width > limit.maxSide || meta.height > limit.maxSide) throw Error(`VIDEO_RESOLUTION: ${meta.width}×${meta.height}; the limit is ${limit.maxSide}×${limit.maxSide}`);
    if (meta.size > limit.maxMB) throw Error(`VIDEO_TOO_LARGE: ${meta.size.toFixed(1)} MB; the limit is ${limit.maxMB} MB`);
    return { width: meta.width, height: meta.height, seconds: Number(seconds.toFixed(2)) };
  },

  // The animation panel's model check: no skeleton or over the import limits refuses; missing bones warn.
  async ai3dCheckRig(file) {
    const EF = this.mod(M.ef);
    const fbx = await EF.APJS.FbxLoaderAPJSWrapper.createFromPathAsync(file, 'zh_CN.UTF-8');
    const triangles = fbx.getTriangleCount();
    const bones = fbx.getMaxBoneCount();
    if (!(triangles >= 0 && fbx.getVertexCount() >= 0 && bones > 0)) throw Error(`MODEL_NOT_RIGGED: ${path.basename(file)} has no skeleton`);
    const limits = EF.ImportLimitationNumber;
    if (bones > limits.BONE_NUM_LIMIT) throw Error(`MODEL_TOO_MANY_BONES: ${bones}; the limit is ${limits.BONE_NUM_LIMIT}`);
    if (triangles > limits.SKIN_MESH_TRIANGLE_HARD_NUM_LIMIT) throw Error(`MODEL_TOO_MANY_TRIANGLES: ${triangles}; the limit is ${limits.SKIN_MESH_TRIANGLE_HARD_NUM_LIMIT}`);
    const names = new Set(fbx.getAllNodeNames().map((n) => String(n).toLowerCase()));
    return { bones, triangles, missing_bones: REQUIRED_BONES.filter((b) => !names.has(b.toLowerCase())) };
  },

  async ai3dRunningCheck(kind) {
    const res = await this.mod(M.aiEffectApi).queryAITaskHistories({ cursor: 0, size: MAX_RUNNING, scene: this.ai3dConst().AIGen3DModelScene[GEN_TYPE[kind]], statusList: [1] });
    if (!res || res.code !== 0) throw Error(`AI3D_HISTORY_FAILED: code=${res && res.code} message=${(res && res.message) || ''}`);
    const running = ((res.data && res.data.taskRecords) || []).length;
    if (running >= MAX_RUNNING) throw Error(`AI3D_TOO_MANY_RUNNING: ${running} ${kind} tasks are running; the editor allows ${MAX_RUNNING} at a time, wait for one to finish`);
  },

  async ai3dUpload(file, type) {
    const api = this.mod(M.uploadApi);
    const res = await api.uploadFileCommon({ filePath: file, fileType: api.FileType[type] });
    if (!res || res.code !== 0) throw Error(`UPLOAD_FAILED: ${path.basename(file)} code=${res && res.code} message=${(res && res.message) || ''}`);
    return res.data;
  },

  async ai3dUploadVideo(file) {
    const api = this.mod(M.uploadApi);
    const res = await api.uploadToSpace({ filePath: file, fileType: api.FileType.Video });
    if (!res || res.code !== 0 || !res.data || res.data.res === false) throw Error(`UPLOAD_FAILED: ${path.basename(file)} code=${res && res.code} message=${(res && res.message) || ''}`);
    return res.data.videoInfo;
  },

  async ai3dSubmit(kind, node, needRecord) {
    const c = this.ai3dConst();
    const type = GEN_TYPE[kind];
    const res = await this.mod(M.aiEffectApi).submitAIGCRequest({
      inputNodeList: [{ source: `loki_material://${c.AIGenModelIdMap[type]}`, ...node, aigc_env: this.mod(M.aigcUtils).getAIGCEnv() }],
      scene: c.AIGen3DModelScene[type],
      needRecord,
    });
    const b = res && res.body;
    if (!b || b.code !== 0 || !b.data || !b.data.taskId) throw Error(`AI3D_SUBMIT_FAILED: code=${b && b.code} message=${(b && b.message) || ''}`);
    return String(b.data.taskId);
  },

  async ai3dImageSubmit({ image_path, precision = 'medium' }) {
    this.ensureCompatible('ai3d');
    if (!Object.prototype.hasOwnProperty.call(FACE_NUM, precision)) throw Error(`INVALID_PRECISION: ${precision}; valid: ${Object.keys(FACE_NUM).join(', ')}`);
    const size = this.ai3dCheckImage(image_path);
    await this.ai3dRunningCheck('image');
    const up = await this.ai3dUpload(image_path, 'Picture');
    const params = { business_type: 'dyeh', dyeh_custom_params: { req_json: { faceNum: FACE_NUM[precision] } } };
    const task_id = await this.ai3dSubmit('image', { params: JSON.stringify(params), uriList: [up.decryptedUri] }, true);
    return { task_id, kind: 'image', precision, face_num: FACE_NUM[precision], image: size };
  },

  async ai3dAnimationSubmit({ video_path, model = 'whole' }) {
    this.ensureCompatible('ai3d');
    const video = this.ai3dCheckVideo(video_path, 'animation');
    let modelPath;
    let reqModel;
    let rig = null;
    if (Object.prototype.hasOwnProperty.call(PRESET_MODELS, model)) {
      // The url() the panel resolves built-in files with; orionui's url() returns a relative path.
      modelPath = this.mod(M.globalConfig).url(`./BuiltinResource/AssetLibrary/${PRESET_MODELS[model]}.fbx`);
      if (!fs.existsSync(modelPath)) throw Error(`PRESET_MODEL_MISSING: ${modelPath}`);
      reqModel = { presetModel: PRESET_MODELS[model], localModel: '' };
    } else {
      if (typeof model === 'string' && !path.isAbsolute(model)) throw Error(`INVALID_MODEL: ${model}; pass one of ${Object.keys(PRESET_MODELS).join(', ')} or the absolute path of an .fbx`);
      modelPath = checkFile(model, ['fbx'], 'MODEL');
      rig = await this.ai3dCheckRig(modelPath);
      reqModel = { presetModel: '', localModel: path.basename(modelPath) };
    }
    await this.ai3dRunningCheck('animation');
    const root = this.ai3dConst().AIGen3DFolder;
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, 'xiangsu-mcp-ext-upload-'));
    try {
      const cover = path.join(dir, 'cover.png');
      this.mod(M.preview).PreviewManager.getInstance().getFirstNonBlackFrame(video_path, cover);
      if (!fs.existsSync(cover)) throw Error(`VIDEO_COVER_FAILED: no frame could be read from ${video_path}`);
      const coverUp = await this.ai3dUpload(cover, 'Picture');
      // The panel zips the model with its file name at the root of the archive.
      const zip = path.join(dir, 'model.zip');
      this.ai3dRun('zip', ['-j', '-q', zip, modelPath]);
      const modelUp = await this.ai3dUpload(zip, 'File');
      const info = await this.ai3dUploadVideo(video_path);
      const params = { model: `tos://${modelUp.decryptedUri}`, video: info.vid, req_json: { videoCoverUri: coverUp.url, ...reqModel } };
      const task_id = await this.ai3dSubmit('animation', { params: JSON.stringify(params) }, true);
      const out = { task_id, kind: 'animation', model: Object.prototype.hasOwnProperty.call(PRESET_MODELS, model) ? model : modelPath, video };
      if (rig) {
        out.model_check = rig;
        if (rig.missing_bones.length) out.warning = `模型缺少标准人形骨骼 ${rig.missing_bones.join('、')}（名字要完全一致，不能带 mixamorig_ 之类的前缀）；编辑器在这种情况下也只是提醒，照样提交，生成结果可能不对`;
      }
      return out;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  // Step one of 高精度模型重建: the cloud finds the subject in the video; step two (ai3dGsSubmit) builds it.
  async ai3dGsSegment({ video_path, wait_s = 120 }) {
    this.ensureCompatible('ai3d');
    this.ai3dCheckVideo(video_path, 'gs');
    await this.ai3dRunningCheck('gs');
    const info = await this.ai3dUploadVideo(video_path);
    const req_json = { req_type: 1, vid: info.vid, prompt: '', duration: info.duration, width: info.width, height: info.height };
    const params = { business_type: 'dyeh', dyeh_custom_params: { req_json } };
    const seg_task_id = await this.ai3dSubmit('gs', { params: JSON.stringify(params), uriList: [''] }, false);
    let res;
    try {
      // On timeout this cancels the task itself, as the panel's window does.
      res = await this.mod(M.aiApiUtils).QueryTaskResult(seg_task_id, 1000, wait_s * 1000);
    } catch (e) {
      throw Error(`AI3D_SUBJECT_FAILED: ${e.message} (task ${seg_task_id})`);
    }
    const node = (((res && res.result) || {}).output_node_list || [])[0] || {};
    const subject_image_url = (node.image_url_list || [])[0];
    const subject_uri = ((node.image_info_list || [])[0] || {}).uri;
    if (!subject_image_url || !subject_uri) throw Error(`AI3D_SUBJECT_NOT_FOUND: the cloud found no subject in the video (task ${seg_task_id})`);
    return { seg_task_id, subject_image_url, subject_uri, req_json };
  },

  async ai3dGsSubmit({ subject_uri, req_json }) {
    this.ensureCompatible('ai3d');
    if (typeof subject_uri !== 'string' || !subject_uri || !req_json || !req_json.vid) throw Error('INVALID_SUBJECT: pass what ai3d_gs_segment returned');
    await this.ai3dRunningCheck('gs');
    const params = { business_type: 'dyeh', dyeh_custom_params: { req_json: { ...req_json, req_type: 0 } } };
    const task_id = await this.ai3dSubmit('gs', { params: JSON.stringify(params), uriList: [subject_uri] }, true);
    return { task_id, kind: 'gs' };
  },

  ai3dLocal(task_id) {
    const info = this.mod(M.ai3dUtils).getGen3DModelLocalInfoByTaskId(task_id);
    const has = (p) => fs.existsSync(p);
    return {
      downloaded: has(info.unzipLocalPath),
      preview_image_file: has(info.previewVideoCoverPath) ? info.previewVideoCoverPath : null,
      preview_video_file: has(info.previewVideoPath) ? info.previewVideoPath : null,
    };
  },

  async ai3dHistory(kind, cursor, size) {
    const c = this.ai3dConst();
    const res = await this.mod(M.aiEffectApi).queryAITaskHistories({ cursor, size, scene: c.AIGen3DModelScene[GEN_TYPE[kind]], statusList: c.AIGen3DModelQueryStatus });
    if (!res || res.code !== 0) throw Error(`AI3D_HISTORY_FAILED: code=${res && res.code} message=${(res && res.message) || ''}`);
    return res.data || {};
  },

  // The history record of one task, or null when it is not among the latest HISTORY_PAGES pages.
  async ai3dRecord(kind, task_id) {
    let cursor = 0;
    for (let page = 0; page < HISTORY_PAGES; page++) {
      const data = await this.ai3dHistory(kind, cursor, HISTORY_PAGE);
      const hit = (data.taskRecords || []).find((t) => String(t.taskId) === task_id);
      if (hit) return hit;
      if (!data.hasMore) return null;
      cursor = data.nextCursor;
    }
    return null;
  },

  async ai3dTasks({ kind, cursor = 0, count = HISTORY_PAGE }) {
    this.ensureCompatible('ai3d');
    checkKind(kind);
    const data = await this.ai3dHistory(kind, cursor, count);
    const items = (data.taskRecords || []).map((t) => ({
      task_id: String(t.taskId),
      status: STATUS[t.status] || String(t.status),
      created_at: iso(t.createTime),
      finished_at: t.status === 1 ? null : iso(t.finishTime),
      ...taskInput(kind, t),
      ...(t.status === 3 ? { failure: failureText(t) } : {}),
      ...this.ai3dLocal(String(t.taskId)),
    }));
    return { kind, items, next_cursor: data.nextCursor ?? null, has_more: !!data.hasMore };
  },

  async ai3dQuery(task_id) {
    const res = await this.mod(M.aiEffectApi).queryAIGCResult({ taskId: task_id });
    if (!res || res.code !== 0 || !res.data) throw Error(`AI3D_QUERY_FAILED: task ${task_id} code=${res && res.code} message=${(res && res.message) || ''}`);
    return res.data;
  },

  // One task's state; with wait_s it keeps asking until the task stops running or the time is up.
  async ai3dTask({ task_id, wait_s = 0 }) {
    this.ensureCompatible('ai3d');
    if (typeof task_id !== 'string' || !task_id) throw Error('INVALID_TASK_ID: task_id must be a non-empty string');
    const poll = this.ai3dPollMs ?? POLL_MS;
    const until = Date.now() + wait_s * 1000;
    let data = await this.ai3dQuery(task_id);
    while (data.status === 1 && Date.now() + poll <= until) {
      await sleep(poll);
      data = await this.ai3dQuery(task_id);
    }
    const out = { task_id, status: STATUS[data.status] || String(data.status) };
    if (data.status === 3) out.failure = failureText(data);
    if (data.status === 2) out.result_ready = !!((((data.outputNodeList || [])[0] || {}).objectInfoList || [])[0] || {}).url;
    return { ...out, ...this.ai3dLocal(task_id) };
  },

  async ai3dImport({ task_id, kind }) {
    this.ensureCompatible('ai3d');
    checkKind(kind);
    if (typeof task_id !== 'string' || !task_id) throw Error('INVALID_TASK_ID: task_id must be a non-empty string');
    const EF = this.mod(M.ef);
    const { sceneEditor, project } = editingScene(this);
    const data = await this.ai3dQuery(task_id);
    if (data.status !== 2) throw Error(`AI3D_NOT_FINISHED: task ${task_id} is ${STATUS[data.status] || data.status}`);
    const url = ((((data.outputNodeList || [])[0] || {}).objectInfoList || [])[0] || {}).url;
    if (!url) throw Error(`AI3D_NO_RESULT: task ${task_id} has no result file`);
    const info = this.mod(M.ai3dUtils).getGen3DModelLocalInfoByTaskId(task_id);
    // Absent until the account's first AI 3D result.
    fs.mkdirSync(path.dirname(info.zipLocalPath), { recursive: true });
    if (!fs.existsSync(info.zipLocalPath)) await this.mod(M.lokiUtils).downloadTemplateFile(url, info.zipLocalPath, DOWNLOAD_TIMEOUT_MS);
    if (!fs.existsSync(info.unzipLocalPath)) this.ai3dRun('ditto', ['-x', '-k', info.zipLocalPath, info.unzipLocalPath]);
    const spec = IMPORT[kind];
    const result = info[spec.file];
    if (!fs.existsSync(result)) throw Error(`AI3D_RESULT_MISSING: ${path.basename(result)} is not in task ${task_id}'s result; is it a ${kind} task?`);
    const I18n = this.mod(M.orionui).I18n;
    let file;
    if (kind === 'image') file = path.join(info.unzipLocalPath, `${I18n.t('ai_3d_generation')}.glb`);
    else if (kind === 'gs') file = path.join(info.unzipLocalPath, '视频生3DGS模型.ply');
    else {
      // The panel names the copy after the model the task was made with.
      const record = await this.ai3dRecord('animation', task_id);
      const { model } = taskInput('animation', record || {});
      const name = Object.prototype.hasOwnProperty.call(PRESET_MODELS, model) ? `${I18n.t(PRESET_MODELS[model])}.fbx` : model || `${task_id}.fbx`;
      file = path.join(info.unzipLocalPath, 'animationResult', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    if (!fs.existsSync(file)) fs.copyFileSync(result, file);
    const before = sceneObjectSet(sceneEditor);
    const beforePaths = new Set(projectResources(project).map((r) => r.assetPath));
    const RIH = this.mod(M.resImport).ResourceImportHandles;
    let item;
    try {
      const pending = RIH.importExtAsset([file], false, undefined, true, { enablePopupWindow: false });
      item = await new Promise((resolve) => RIH.registerLoadingCallbackByResItem(pending, (res, state) => resolve(state === 'loaded' ? res : null)));
    } finally {
      // The editor keeps the animation copy and removes the other two once imported.
      if (kind !== 'animation') fs.rmSync(file, { force: true });
    }
    if (!item) throw Error(`AI3D_IMPORT_FAILED: the editor could not import ${path.basename(file)}`);
    const tag = { id: `${spec.idPrefix}${task_id}`, styleTag: '', type: spec.type };
    for (const r of [item, ...(item.subResourceItems || [])]) {
      if (!r) continue;
      r.assetPackageID = tag.id;
      r.assetStudioData = { ...tag };
    }
    const created = EF.Extension.Scene.AssetSceneObjectCreationSystem.createSceneObjectFromAssetWithUndo({
      sceneEditor,
      resItems: [item],
      onDoUndoRedo: () => EF.SceneView.SceneView.repaintAll(),
    });
    for (const so of created) {
      if (kind === 'image') {
        const scale = so.getChildren()[0];
        scale.target.getComponent('Transform').localScale = new EF.APJS.Vector3f(15, 15, 15);
        scale.name = I18n.t('ai_3d_generation_scale');
        scale.getChildren()[0].name = I18n.t('ai_3d_generation_mesh');
      } else if (kind === 'gs') {
        so.target.getComponent('Transform').localScale = new EF.APJS.Vector3f(0.3, 0.3, 0.3);
      }
    }
    const added = addedObjectEditors(before, sceneEditor);
    if (!added.length) throw Error(`AI3D_IMPORT_NO_OBJECT: ${path.basename(file)} was imported but nothing was added to the scene`);
    const packageFolders = packageRootsAdded(project, beforePaths);
    recordImport(project, added, packageFolders);
    return {
      task_id,
      kind,
      added_objects: added.map((o) => ({ name: o.name, object_path: sceneObjectPath(o) })),
      package_folders: packageFolders,
      ...this.ai3dLocal(task_id),
    };
  },

  async ai3dCancel({ task_id }) {
    this.ensureCompatible('ai3d');
    if (typeof task_id !== 'string' || !task_id) throw Error('INVALID_TASK_ID: task_id must be a non-empty string');
    const res = await this.mod(M.aiEffectApi).cancelAIGCRequest({ taskId: task_id });
    if (!res || res.code !== 0) throw Error(`AI3D_CANCEL_FAILED: task ${task_id} code=${res && res.code} message=${(res && res.message) || ''}`);
    return { task_id, cancelled: true };
  },
};

const METHODS = {
  ai3d_image_submit: 'ai3dImageSubmit',
  ai3d_animation_submit: 'ai3dAnimationSubmit',
  ai3d_gs_segment: 'ai3dGsSegment',
  ai3d_gs_submit: 'ai3dGsSubmit',
  ai3d_tasks: 'ai3dTasks',
  ai3d_task: 'ai3dTask',
  ai3d_import: 'ai3dImport',
  ai3d_cancel: 'ai3dCancel',
};

module.exports = { methods, METHODS, GEN_TYPE, FACE_NUM, IMAGE_LIMIT, VIDEO_LIMIT, MAX_RUNNING, PRESET_MODELS, REQUIRED_BONES, HISTORY_PAGE };
