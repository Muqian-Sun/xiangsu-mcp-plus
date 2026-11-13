'use strict';
// 素材库 › AI 生成 › 实时变脸 (custom AI real-time face, UGan): one reference photo and a style
// (全身换装 / 真人搞怪 / 表情迁移 / 真人美化) first give a cloud preview on the editor's sample faces; training
// a real-time model from it uses one of the account's daily training quota and takes hours; the trained
// model is downloaded and imported as an AI 实时变脸 object. Everything goes through the panel's own
// UGanManager (AssetsLibrary.getInstance().UGanManager), so the panel shows the same tasks.
//
// Flows, as the panel runs them: most styles train straight from a finished preview; 真人搞怪 (preset fun)
// first generates candidate images on the editor's base faces and trains on exactly 30 picked ones.
const fs = require('fs');
const path = require('path');
const { M, editingScene, sceneObjectSet, addedObjectEditors, sceneObjectPath, projectResources, packageRootsAdded, recordImport } = require('./common.cjs');

const TOAST = 'assetUGanToast';
const SELECT_PRESET = 'fun';
// From the panel (SelectPanel): training on picked candidates needs exactly this many.
const SELECT_COUNT = 30;
// From the panel's upload hint: PNG / JPEG / JPG up to 10 MB.
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg'];
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
// Picked: how many history pages (4 tasks each, the panel's page size) a task_id is looked up in.
const HISTORY_PAGES = 15;
// Picked: the panel refreshes progress every 10 s; waiting here checks twice as often.
const POLL_MS = 5000;
const STATUS = { 1: 'running', 2: 'finished', 3: 'failed', 4: 'discarded' };
const QUOTA_NOTE = '训练会消耗账号每天的训练次数（custom_gan_styles 的 quota），预计 3–12 小时，按风格不同；预览不消耗训练次数。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
};

const methods = {
  customGan() {
    return this.mod(M.assetsLibrary).AssetsLibrary.getInstance().UGanManager;
  },

  customGanStyleList(mgr) {
    const list = mgr.styleList.getValue();
    if (!list.length) throw Error('CUSTOM_GAN_STYLES_NOT_LOADED: the panel has not loaded its styles yet; try again in a few seconds');
    return list;
  },

  customGanPreset(t) {
    return parse(t.inputNodeList && t.inputNodeList[0] && t.inputNodeList[0].params)?.dyeh_custom_params?.preset ?? null;
  },

  async customGanStyles() {
    this.ensureCompatible('customGan');
    const mgr = this.customGan();
    const quota = await this.mod(M.uganUtils).queryQuota();
    mgr.quota.next(quota);
    return {
      quota,
      styles: this.customGanStyleList(mgr).map((s) => {
        const a = s.algoConfig || {};
        return {
          style: s.label,
          preset: a.preset,
          flow: a.preset === SELECT_PRESET ? 'select_30' : 'direct',
          needs: a.emptyEffects?.desc ?? null,
          reference_advice: a.referenceAdvice?.desc ?? null,
          train_note: a.confirm_train?.desc ?? null,
          text_output: !!a.textInput,
        };
      }),
      image: { formats: IMAGE_EXTS.map((e) => e.slice(1)), max_mb: IMAGE_MAX_BYTES / 1024 / 1024 },
      max_import: this.mod(M.uganConst).MaxImportNum,
    };
  },

  // Reloads the history from the first page, as reopening the panel does, and refreshes running tasks.
  async customGanReload(mgr, pages = 1) {
    mgr.taskRecordList.next([]);
    mgr.cursorInfo.next({ cursor: 0, size: 4, hasNext: true });
    mgr.loadingState.next(0);
    for (let p = 0; p < pages && mgr.cursorInfo.getValue().hasNext; p++) {
      await mgr.queryTaskList();
      if (mgr.loadingState.getValue() === 3) throw Error('CUSTOM_GAN_HISTORY_FAILED: the panel could not load its task history');
    }
    await this.customGanProgress(mgr);
  },

  // What the panel's updateTaskProgress does for running tasks, awaited (the panel's version does not
  // wait for its queries), without its auto-cancel of previews older than the timeout.
  async customGanProgress(mgr, only) {
    const U = this.mod(M.uganUtils);
    const api = this.mod(M.aiEffectApi);
    const Running = api.AIGCRecordStatus.Running;
    for (const t of mgr.taskRecordList.getValue()) {
      if (only && t.taskId !== only) continue;
      const running = U.isGanTask(t) ? U.getGanTaskStatus(t) === Running : U.isGanPreviewTask(t) ? U.getGanSelectPreviewTaskStatus(t) === Running : t.status === Running;
      if (!running) continue;
      const r = await api.queryAIGCResultWithBizInfo({ taskId: t.taskId });
      if (r.code !== 0) continue;
      Object.assign(t, { outputNodeList: r.data.outputNodeList, errorCode: r.data.errorCode ?? -1, status: r.data.status, bizInfo: r.data.bizInfo });
    }
    mgr.taskRecordList.next([...mgr.taskRecordList.getValue()]);
  },

  async customGanFind(task_id) {
    if (typeof task_id !== 'string' || !task_id) throw Error('INVALID_TASK_ID: task_id must be a non-empty string');
    const mgr = this.customGan();
    await this.customGanReload(mgr);
    const hit = () => mgr.taskRecordList.getValue().find((t) => t.taskId === task_id);
    for (let p = 1; !hit() && mgr.cursorInfo.getValue().hasNext && p < HISTORY_PAGES; p++) await mgr.queryTaskList();
    const t = hit();
    if (!t) throw Error(`CUSTOM_GAN_TASK_NOT_FOUND: ${task_id} is not among this account's latest 实时变脸 tasks`);
    await this.customGanProgress(mgr, task_id);
    return mgr.taskRecordList.getValue().find((x) => x.taskId === task_id);
  },

  customGanView(t) {
    const U = this.mod(M.uganUtils);
    const mgr = this.customGan();
    const preset = this.customGanPreset(t);
    const style = mgr.getStyleItemFromTask(t.taskId);
    const out = {
      task_id: t.taskId,
      style: style ? style.label : null,
      preset,
      created_at: t.createTime ? new Date(t.createTime * 1000).toISOString() : null,
      reference_image: t.inputNodeList?.[0]?.urlList?.[0] ?? null,
    };
    const node = (t.outputNodeList || [])[0];
    if (U.isGanTask(t)) {
      const info = t.bizInfo.ganBizInfo.ganTaskInfo || {};
      Object.assign(out, { stage: 'train', status: STATUS[U.getGanTaskStatus(t)] || 'unknown' });
      if (out.status === 'finished') {
        const gnode = (info.outputNodeList || [])[0] || {};
        const local = U.getUGanModelLocalInfoByTaskId(t.taskId, style?.algoConfig?.lodCnt || 2);
        out.video_female_url = gnode.videoInfoList?.[0]?.url ?? null;
        out.video_male_url = gnode.videoInfoList?.[1]?.url ?? null;
        out.model_downloaded = local.modelPathes.every((p) => fs.existsSync(p));
      }
    } else if (U.isGanPreviewTask(t)) {
      const candidates = U.getGanPreviewImageList(t);
      Object.assign(out, {
        stage: 'select',
        status: STATUS[U.getGanSelectPreviewTaskStatus(t)] || 'unknown',
        candidates: candidates.map((c) => ({ index: c.imageIndex, image_url: c.outputImageUrl || null, selected: !!c.isSelect, status: c.status ? STATUS[c.status] : 'finished' })),
        selected_count: candidates.filter((c) => c.isSelect).length,
      });
    } else {
      Object.assign(out, { stage: 'preview', status: STATUS[t.status] || 'unknown' });
    }
    if (node && t.status === 2) {
      out.female_image_url = node.imageUrlList?.[0] ?? null;
      out.male_image_url = node.imageUrlList?.[1] ?? null;
      if (style?.algoConfig?.textInput) out.text = node.textList?.[0] ?? null;
    }
    if (out.status === 'failed') out.error_code = t.errorCode ?? null;
    return out;
  },

  async customGanSubmit({ style, image_path }) {
    this.ensureCompatible('customGan');
    if (typeof image_path !== 'string' || !path.isAbsolute(image_path) || !fs.existsSync(image_path)) throw Error(`IMAGE_NOT_FOUND: ${image_path}`);
    if (!IMAGE_EXTS.includes(path.extname(image_path).toLowerCase())) throw Error(`IMAGE_FORMAT: ${path.basename(image_path)} is not PNG / JPG / JPEG`);
    if (fs.statSync(image_path).size > IMAGE_MAX_BYTES) throw Error(`IMAGE_TOO_LARGE: ${path.basename(image_path)} is over 10 MB`);
    const mgr = this.customGan();
    const list = this.customGanStyleList(mgr);
    const s = list.find((x) => x.label === style || x.algoConfig?.preset === style);
    if (!s) throw Error(`UNKNOWN_STYLE: ${style}; styles: ${list.map((x) => `${x.label} (${x.algoConfig?.preset})`).join(', ')}`);
    await this.customGanReload(mgr);
    if (mgr.taskRecordList.getValue().some((t) => t.status === this.mod(M.aiEffectApi).AIGCRecordStatus.Running)) throw Error('CUSTOM_GAN_RUNNING: a 实时变脸 preview is still being generated (the panel allows one at a time)');
    const bus = this.mod(M.events).BusinessEventManager.TypeGuard();
    const toasts = [];
    const onToast = (m) => toasts.push(String(m));
    bus.on(TOAST, onToast);
    const before = new Set(mgr.taskRecordList.getValue().map((t) => t.taskId));
    try {
      mgr.curStyle.next(s);
      mgr.onUGanEditParamsUpdate('preset', s.algoConfig.preset);
      mgr.onUGanEditParamsUpdate('referenceImage', image_path);
      await mgr.submitUGanPreviewRequest();
    } finally {
      mgr.onUGanEditParamsUpdate('referenceImage', '');
      bus.off(TOAST, onToast);
    }
    const t = mgr.taskRecordList.getValue().find((x) => !before.has(x.taskId));
    if (!t) throw Error(`CUSTOM_GAN_SUBMIT_FAILED: ${toasts.join('; ') || 'the editor added no task'}`);
    return { task_id: t.taskId, style: s.label, preset: s.algoConfig.preset, stage: 'preview', flow: s.algoConfig.preset === SELECT_PRESET ? 'select_30' : 'direct', note: '预览图在云端生成（几分钟），用 custom_gan_tasks（task_id + wait_s）等它完成、看男女两张预览图，满意再 custom_gan_train', quota: QUOTA_NOTE };
  },

  async customGanTasks({ offset = 0, count = 8 }) {
    this.ensureCompatible('customGan');
    const mgr = this.customGan();
    await this.customGanReload(mgr);
    while (mgr.taskRecordList.getValue().length < offset + count && mgr.cursorInfo.getValue().hasNext) await mgr.queryTaskList();
    await this.customGanProgress(mgr);
    const all = mgr.taskRecordList.getValue();
    const next = offset + count;
    return { items: all.slice(offset, next).map((t) => this.customGanView(t)), next_offset: next, has_more: next < all.length || !!mgr.cursorInfo.getValue().hasNext, quota: mgr.quota.getValue() };
  },

  async customGanTask({ task_id, wait_s = 0 }) {
    this.ensureCompatible('customGan');
    let view = this.customGanView(await this.customGanFind(task_id));
    const until = Date.now() + wait_s * 1000;
    const poll = this.customGanPollMs ?? POLL_MS;
    while (view.status === 'running' && Date.now() + poll <= until) {
      await sleep(poll);
      const mgr = this.customGan();
      await this.customGanProgress(mgr, task_id);
      view = this.customGanView(mgr.taskRecordList.getValue().find((t) => t.taskId === task_id) || (await this.customGanFind(task_id)));
    }
    return view;
  },

  async customGanTrain({ task_id, selected }) {
    this.ensureCompatible('customGan');
    const U = this.mod(M.uganUtils);
    const Finished = this.mod(M.aiEffectApi).AIGCRecordStatus.Finished;
    const mgr = this.customGan();
    const t = await this.customGanFind(task_id);
    if (U.isGanTask(t)) throw Error(`CUSTOM_GAN_ALREADY_TRAINED: task ${task_id} is already in training (${STATUS[U.getGanTaskStatus(t)] || 'unknown'})`);
    if (t.status !== Finished) throw Error(`CUSTOM_GAN_PREVIEW_NOT_READY: the preview of ${task_id} is ${STATUS[t.status] || t.status}; wait with custom_gan_tasks first`);
    const select = this.customGanPreset(t) === SELECT_PRESET;
    if (!select && selected !== undefined) throw Error('INVALID_ARGUMENTS: selected only applies to the 真人搞怪 style (preset fun)');
    const bus = this.mod(M.events).BusinessEventManager.TypeGuard();
    const toasts = [];
    const onToast = (m) => toasts.push(String(m));
    bus.on(TOAST, onToast);
    try {
      if (select && !U.isGanPreviewTask(t)) {
        if (selected !== undefined) throw Error('CUSTOM_GAN_NO_CANDIDATES: call custom_gan_train without selected first to generate the candidate images');
        const pid = await mgr.submitGANPreviewSelectRequest(t);
        if (!pid) throw Error(`CUSTOM_GAN_SELECT_FAILED: ${toasts.join('; ') || 'the editor started no candidate task'}`);
        return { task_id, stage: 'select', note: `候选效果图在云端生成，用 custom_gan_tasks（task_id + wait_s）等 stage=select 的 status 变成 finished，看 candidates 的 image_ref，挑满 ${SELECT_COUNT} 张，把它们的 index 传给本工具的 selected 正式训练（不消耗训练次数的只到这一步）` };
      }
      const quota = await U.queryQuota();
      mgr.quota.next(quota);
      if (quota <= 0) throw Error('CUSTOM_GAN_NO_QUOTA: 今日训练次数已用完，请明天再来');
      let ganId;
      if (select) {
        const candidates = U.getGanPreviewImageList(t);
        if (U.getGanSelectPreviewTaskStatus(t) !== Finished) throw Error('CUSTOM_GAN_CANDIDATES_NOT_READY: the candidate images are still being generated');
        const valid = new Set(candidates.filter((c) => c.outputImageUri).map((c) => c.imageIndex));
        const picks = [...new Set(selected || [])];
        if (picks.length !== SELECT_COUNT || (selected || []).length !== SELECT_COUNT) throw Error(`INVALID_SELECTION: pick exactly ${SELECT_COUNT} different candidate indexes (got ${(selected || []).length})`);
        const bad = picks.filter((i) => !valid.has(i));
        if (bad.length) throw Error(`INVALID_SELECTION: no finished candidate at index ${bad.join(', ')}`);
        ganId = await mgr.submitGanModelWithSelectImagesRequest(t, picks);
      } else {
        const style = mgr.getStyleItemFromTask(t.taskId);
        const text = style?.algoConfig?.textInput ? t.outputNodeList?.[0]?.textList?.[0] : undefined;
        ganId = await mgr.submitGanModelRequest(t.taskId, t.inputNodeList[0].uriList?.[0] ?? '', text);
      }
      if (!ganId || ganId === -1) throw Error(`CUSTOM_GAN_TRAIN_FAILED: ${toasts.join('; ') || 'the editor did not start the training'}`);
      mgr.quota.next(quota - 1);
      if (!select) mgr.updatePreviewTask2GanTask(t.taskId, ganId);
      const style = mgr.getStyleItemFromTask(t.taskId);
      return { task_id, stage: 'train', quota_left: quota - 1, note: style?.algoConfig?.confirm_train?.desc ?? QUOTA_NOTE };
    } finally {
      bus.off(TOAST, onToast);
    }
  },

  // What the panel's finished-task card does before 导入 (download the model files, the preview videos and
  // their covers), then its import for this one task.
  async customGanImport({ task_id }) {
    this.ensureCompatible('customGan');
    const U = this.mod(M.uganUtils);
    const C = this.mod(M.uganConst);
    const mgr = this.customGan();
    const t = await this.customGanFind(task_id);
    if (!U.isGanTask(t) || U.getGanTaskStatus(t) !== this.mod(M.aiEffectApi).AIGCRecordStatus.Finished) throw Error(`CUSTOM_GAN_NOT_TRAINED: task ${task_id} has no finished training; check custom_gan_tasks`);
    const info = t.bizInfo.ganBizInfo.ganTaskInfo;
    const gnode = (info.outputNodeList || [])[0];
    if (!gnode || !Array.isArray(gnode.objectInfoList) || !gnode.objectInfoList.length) throw Error(`CUSTOM_GAN_NO_MODEL: the training of ${task_id} returned no model files`);
    const style = mgr.getStyleItemFromTask(t.taskId);
    const local = U.getUGanModelLocalInfoByTaskId(t.taskId, style?.algoConfig?.lodCnt || 2);
    const timeout = U.assetGanSettings()?.resp_download_timeout ?? C.RespDownloadTimeOut;
    const download = this.mod(M.lokiUtils).downloadTemplateFile;
    fs.mkdirSync(local.unzipLocalPath, { recursive: true });
    const fetchTo = async (url, file) => {
      if (!fs.existsSync(file) && url) await download(url, file, timeout);
    };
    await Promise.all(gnode.objectInfoList.map((o, i) => fetchTo(o.url, local.modelPathes[i])));
    await fetchTo(gnode.videoInfoList?.[0]?.url, local.femalePreviewVideoPath);
    await fetchTo(gnode.videoInfoList?.[1]?.url, local.malePreviewVideoPath);
    const missing = [local.modelPathes[0], local.femalePreviewVideoPath, local.malePreviewVideoPath].filter((f) => !fs.existsSync(f));
    if (missing.length) throw Error(`CUSTOM_GAN_DOWNLOAD_FAILED: ${missing.map((f) => path.basename(f)).join(', ')} did not download`);
    const preview = this.mod(M.preview).PreviewManager.getInstance();
    if (!fs.existsSync(local.femalePreviewVideoCoverPath)) preview.getFirstNonBlackFrame(local.femalePreviewVideoPath, local.femalePreviewVideoCoverPath);
    if (!fs.existsSync(local.malePreviewVideoCoverPath)) preview.getFirstNonBlackFrame(local.malePreviewVideoPath, local.malePreviewVideoCoverPath);

    const { sceneEditor, project } = editingScene(this);
    const before = sceneObjectSet(sceneEditor);
    const beforePaths = new Set(projectResources(project).map((r) => r.assetPath));
    const kept = mgr.selectedTaskIdSet.getValue();
    mgr.selectedTaskIdSet.next(new Set([t.taskId]));
    try {
      await mgr.importUGanModel();
    } catch (e) {
      throw Error(`CUSTOM_GAN_IMPORT_FAILED: ${String((e && e.message) || e || 'the editor did not import the model')}`);
    } finally {
      mgr.selectedTaskIdSet.next(new Set([...kept].filter((id) => id !== t.taskId)));
    }
    const added = addedObjectEditors(before, sceneEditor);
    if (!added.length) throw Error(`CUSTOM_GAN_IMPORT_NO_OBJECT: task ${task_id} was imported but nothing was added to the scene`);
    const packageFolders = packageRootsAdded(project, beforePaths);
    recordImport(project, added, packageFolders);
    return { task_id, added_objects: added.map((o) => ({ name: o.name, object_path: sceneObjectPath(o) })), package_folders: packageFolders, preview_videos: { female: local.femalePreviewVideoPath, male: local.malePreviewVideoPath } };
  },
};

const METHODS = {
  custom_gan_styles: 'customGanStyles',
  custom_gan_submit: 'customGanSubmit',
  custom_gan_tasks: 'customGanTasks',
  custom_gan_task: 'customGanTask',
  custom_gan_train: 'customGanTrain',
  custom_gan_import: 'customGanImport',
};

module.exports = { methods, METHODS, SELECT_COUNT };
