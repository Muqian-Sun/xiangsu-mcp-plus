'use strict';
// AudioTemplate music creation and preparation. Only audioSourceSubmit publishes an artwork;
// its native type-14 contract is tested with an intercepted transport, never a live submission.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { M } = require('./common.cjs');
const { request, send } = require('./community.cjs');

const MODES = ['theme', 'lyrics', 'cover'];
const ASSET_TYPES = { audio: 'Audio', icon: 'Picture', showcase: 'Video', template: 'Effect', project: 'Project' };
const EXTENSIONS = { audio: '.mp3', icon: '.png', showcase: '.mp4', template: '.zip', project: '.zip' };
const SCENES = { create: 'AIMusicCreate', cover: 'AIMusicCover' };
const ROUTES = Object.freeze({
  config: '/cam_api/aigc/v1/get_ai_music_config',
  genres: '/cam_api/v2/music/genres',
  generate: '/cam_api/aigc/v1/submit_ai_music_task',
  task: '/cam_api/aigc/v1/query_ai_music_task',
  review: '/cam_api/v2/music/upload_review',
  beats: '/cam_api/v2/music/parse_beats',
  align: '/cam_api/v2/music/align_lyric',
  check_start: '/cam_api/pre_check/submit_task',
  check_query: '/cam_api/pre_check/performance',
  submit_context: '/cam_api/designer/v1/base',
  submit: '/effectcam/v1/submit',
});
// Same 60/30 second request budgets as the successful live generation, review and readback probes.
const GENERATION_TIMEOUT_MS = 60000;
const MEDIA_TIMEOUT_MS = 30000;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const SUBMIT_KEYS = new Set(['project_id', 'name', 'description', 'icon_e_uri', 'file_e_uri', 'ecpj_e_uri', 'size', 'os', 'creator_version', 'type', 'customized', 'is_project_authorization', 'bind_resource', 'share_id']);
function submitAccount(data) {
  const uid = data?.designer?.uid;
  if ((typeof uid !== 'string' && !Number.isSafeInteger(uid)) || !String(uid) || String(uid) === '0') return null;
  return { uid: String(uid), nickname: data.designer.username || null };
}
const nonempty = (value, key) => {
  if (typeof value !== 'string' || !value.trim()) throw Error(`AUDIO_SOURCE_${key}_REQUIRED`);
  return value;
};
const GENERATION_SETTINGS = { gender: '', original_maintainance: 0, musical_style: 0, freedom: 0 };
function generationSettings(settings = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(k => !Object.hasOwn(GENERATION_SETTINGS, k))) throw Error('AUDIO_SOURCE_INVALID_SETTINGS');
  const merged = { ...GENERATION_SETTINGS, ...settings };
  if (!['', 'male', 'female'].includes(merged.gender) || ['original_maintainance', 'musical_style', 'freedom'].some(k => !Number.isSafeInteger(merged[k]) || merged[k] < 0)) throw Error('AUDIO_SOURCE_INVALID_SETTINGS');
  return merged;
}

function localFile(file, kind) {
  if (!Object.hasOwn(ASSET_TYPES, kind)) throw Error(`AUDIO_SOURCE_INVALID_ASSET_KIND: ${kind}`);
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('AUDIO_SOURCE_FILE_PATH_NOT_ABSOLUTE');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw Error(`AUDIO_SOURCE_FILE_NOT_FOUND: ${file}`);
  if (!fs.statSync(file).size) throw Error(`AUDIO_SOURCE_FILE_EMPTY: ${file}`);
  if (path.extname(file).toLowerCase() !== EXTENSIONS[kind]) throw Error(`AUDIO_SOURCE_FILE_FORMAT: ${kind} requires ${EXTENSIONS[kind]}`);
  return file;
}

function taskSummary(task_id, data, includeLyrics) {
  const status = data?.status;
  if (!Number.isInteger(status)) throw Error('AUDIO_SOURCE_TASK_BAD_RESPONSE: missing numeric task status');
  const list = data.output?.music_info_list ?? [];
  if (!Array.isArray(list)) throw Error('AUDIO_SOURCE_TASK_BAD_RESPONSE: music_info_list is not an array');
  const usable = status === 2 && list.length > 0 && list.every(t => t.status === 'Success' && typeof t.url === 'string' && t.url);
  const failed = status === 3 || list.some(t => t.status === 'Failed');
  return {
    task_id, task_status: status, finished: status === 2 || status === 3, usable,
    state: usable ? 'succeeded' : failed ? 'failed' : status === 2 ? 'incomplete' : [0, 1].includes(status) ? 'running' : 'unknown',
    error_code: data.task_error_code ?? null, error_message: data.task_error_msg || null,
    tracks: list.map((t, i) => ({
      index: i + 1, title: t.title || '', vid: t.vid ? String(t.vid) : null, status: t.status || 'Unknown',
      has_lyrics: !!t.lyrics,
      ...(t.status === 'Success' && t.url ? { audio_url: t.url } : {}),
      ...(includeLyrics && t.lyrics ? { lyrics: t.lyrics } : {}),
    })),
  };
}

const methods = {
  async audioSourceSubmitContext() {
    const data = await request(this, 'AUDIO_SOURCE_SUBMIT_ACCOUNT', ROUTES.submit_context);
    const account = submitAccount(data);
    if (!account) throw Error('AUDIO_SOURCE_SUBMIT_LOGIN_REQUIRED');
    return account;
  },

  async audioSourceSubmit({ request: payload, request_sha256, account_uid }) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.type !== 14 || Object.keys(payload).some(k => !SUBMIT_KEYS.has(k))) throw Error('AUDIO_SOURCE_SUBMIT_INVALID_ARTWORK');
    for (const key of ['project_id', 'name', 'icon_e_uri', 'file_e_uri', 'ecpj_e_uri', 'size', 'creator_version']) nonempty(payload[key], 'SUBMIT_' + key.toUpperCase());
    if (payload.os !== 'android' || !/^[1-9]\d*$/.test(payload.size) || ![1, 2].includes(payload.is_project_authorization)) throw Error('AUDIO_SOURCE_SUBMIT_INVALID_FIELDS');
    const bindings = payload.bind_resource;
    if (!Array.isArray(bindings) || bindings.length !== 2 || bindings.some(b => b.type !== 10 || b.source !== 0 || typeof b.key !== 'string' || !b.key.trim()) || bindings[0].sub_type !== 2 || bindings[1].sub_type !== 1) throw Error('AUDIO_SOURCE_SUBMIT_INVALID_MEDIA_BINDINGS');
    if (digest(JSON.stringify(payload)) !== request_sha256) throw Error('AUDIO_SOURCE_SUBMIT_DIGEST_MISMATCH');
    nonempty(account_uid, 'SUBMIT_ACCOUNT_UID');
    // Freeze authentication for both the final identity read and the POST. The editor account
    // may otherwise switch while the parent process is waiting for its performance check.
    let sessionCookie, identity;
    try {
      sessionCookie = await new (this.mod(M.orionui).CookieManager)().getCookie(this.mod(M.urls).Domain.kBackendApiURL);
      const context = await send(this, 'AUDIO_SOURCE_SUBMIT_ACCOUNT', ROUTES.submit_context, { sessionCookie });
      identity = context.code === '0' ? submitAccount(context.data) : null;
    } catch (error) { return { state: 'rejected', artwork_submitted: false, retry_safe: false, code: 'ACCOUNT_CHECK_FAILED', message: error.message }; }
    if (!identity || identity.uid !== account_uid) return { state: 'rejected', artwork_submitted: false, retry_safe: false, code: 'ACCOUNT_CHANGED', message: 'The captured login does not match the prepared account; no artwork was sent.' };
    // Chosen 60 s HTTP budget. send(), unlike request(), has no retry branch.
    let response;
    try { response = await send(this, 'AUDIO_SOURCE_SUBMIT', ROUTES.submit, { json: payload, timeoutMs: 60000, sessionCookie }); }
    catch (error) { return { state: 'unknown', artwork_submitted: null, retry_safe: false, reason: error.message }; }
    if (!/^-?\d+$/.test(response.code)) return { state: 'unknown', artwork_submitted: null, retry_safe: false, reason: 'The server did not return a valid submission code; inspect my_effects before any new submission.' };
    if (response.code !== '0') return { state: 'rejected', artwork_submitted: false, retry_safe: false, code: response.code, message: response.message };
    const value = response.data?.effect_id;
    const effect_id = typeof value === 'string' ? value : Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    if (!/^[1-9]\d*$/.test(effect_id || '')) return { state: 'unknown', artwork_submitted: null, retry_safe: false, reason: 'The server accepted the request without a valid effect_id; inspect my_effects before any new submission.' };
    return { state: 'submitted', artwork_submitted: true, retry_safe: false, effect_id, item_id: response.data.item_id || null, pre_gen_online_id: response.data.pre_gen_online_id || null, review_status: 'not_queried' };
  },

  async audioSourceConfig() {
    const [create, cover, genres] = await Promise.all([
      request(this, 'AUDIO_SOURCE_CONFIG', ROUTES.config, { query: { scene: SCENES.create } }),
      request(this, 'AUDIO_SOURCE_CONFIG', ROUTES.config, { query: { scene: SCENES.cover } }),
      request(this, 'AUDIO_SOURCE_GENRES', ROUTES.genres),
    ]);
    if (create?.scene !== SCENES.create || cover?.scene !== SCENES.cover || typeof create.sway_offline !== 'boolean' || typeof cover.sway_offline !== 'boolean' || !Array.isArray(genres?.genres) || genres.genres.some(g => !g.genre_name || !g.genre_code)) throw Error('AUDIO_SOURCE_CONFIG_BAD_RESPONSE');
    return { scenes: { create, cover }, genres: genres.genres.map(g => ({ name: g.genre_name, code: g.genre_code })), modes: MODES };
  },

  async audioSourceGenerate({ mode, style, idea, lyrics, reference_uri, settings }) {
    if (!MODES.includes(mode)) throw Error(`AUDIO_SOURCE_INVALID_MODE: ${mode}`);
    nonempty(style, 'STYLE');
    if (mode === 'theme') nonempty(idea, 'IDEA');
    if (mode === 'lyrics') nonempty(lyrics, 'LYRICS');
    if (mode === 'cover') nonempty(reference_uri, 'REFERENCE_URI');
    if ((mode !== 'theme' && idea !== undefined) || (mode !== 'lyrics' && lyrics !== undefined) || (mode !== 'cover' && reference_uri !== undefined)) throw Error('AUDIO_SOURCE_MODE_ARGUMENT_CONFLICT');
    const nativeSettings = generationSettings(settings);
    if (mode === 'cover' && Object.keys(GENERATION_SETTINGS).some(k => nativeSettings[k] !== GENERATION_SETTINGS[k])) throw Error('AUDIO_SOURCE_ADVANCED_COVER_NOT_VERIFIED: cover uses native defaults');
    const input = {
      scene: mode === 'cover' ? SCENES.cover : SCENES.create,
      params: {
        type: mode === 'theme' ? 'prompt' : mode === 'lyrics' ? 'lyrics' : '',
        prompt: style, sway_prompt: style, lyrics: mode === 'lyrics' ? lyrics : '', user_query: mode === 'theme' ? idea : '',
        settings: JSON.stringify(nativeSettings),
        single_retry: false, is_user_defined_prompt: true, copyright_retry: false, use_copywriting: false,
      },
      uri_list: mode === 'cover' ? [reference_uri] : [], vid_list: [],
    };
    const data = await request(this, 'AUDIO_SOURCE_GENERATE', ROUTES.generate, { json: input, timeoutMs: GENERATION_TIMEOUT_MS });
    if (typeof data?.task_id !== 'string' || !data.task_id) throw Error('AUDIO_SOURCE_GENERATE_RETURNED_NO_TASK');
    return { task_id: data.task_id, mode, scene: input.scene, state: 'created', artwork_submitted: false };
  },

  async audioSourceTask({ task_id, include_lyrics = false }) {
    nonempty(task_id, 'TASK_ID');
    const data = await request(this, 'AUDIO_SOURCE_TASK', ROUTES.task, { query: { task_id } });
    return taskSummary(task_id, data, include_lyrics);
  },

  async audioSourceBeats({ reference_uri }) {
    nonempty(reference_uri, 'REFERENCE_URI');
    const data = await request(this, 'AUDIO_SOURCE_BEATS', ROUTES.beats, { json: { uri: reference_uri }, timeoutMs: GENERATION_TIMEOUT_MS });
    if (!Number.isFinite(data?.bpm) || data.bpm < 0 || !Array.isArray(data.time) || !Array.isArray(data.value) || data.time.length !== data.value.length || data.time.some((t, i) => !Number.isFinite(t) || t < 0 || (i > 0 && t < data.time[i - 1])) || data.value.some(v => !Number.isInteger(v))) throw Error('AUDIO_SOURCE_BEATS_BAD_RESPONSE');
    return { bpm: data.bpm, beats: data.time.map((time_s, i) => ({ time_s, value: data.value[i] })), has_beats: data.time.length > 0, artwork_submitted: false };
  },

  async audioSourceAlign({ audio_url, lyrics, include_words = false }) {
    nonempty(audio_url, 'AUDIO_URL'); nonempty(lyrics, 'LYRICS');
    if (!['https:', 'http:'].includes(new URL(audio_url).protocol)) throw Error('AUDIO_SOURCE_AUDIO_URL_REQUIRED');
    const data = await request(this, 'AUDIO_SOURCE_ALIGN', ROUTES.align, { json: { audio_url, original_lyrics: lyrics, skip_copyright_check: false }, timeoutMs: GENERATION_TIMEOUT_MS });
    const parsed = JSON.parse(data?.aligned_utterance || '{}');
    const valid = t => typeof t.text === 'string' && Number.isFinite(t.start_time) && Number.isFinite(t.end_time) && t.start_time >= 0 && t.end_time >= t.start_time;
    if (typeof data.aligned_lyrics !== 'string' || !data.aligned_lyrics || !Array.isArray(parsed.utterances) || !parsed.utterances.length || parsed.utterances.some(t => !valid(t) || (include_words && (!Array.isArray(t.words) || t.words.some(w => !valid(w)))))) throw Error('AUDIO_SOURCE_ALIGN_BAD_RESPONSE');
    const time = t => ({ text: t.text, start_s: t.start_time / 1000, end_s: t.end_time / 1000 });
    return { lyrics: data.aligned_lyrics, utterances: parsed.utterances.map(t => ({ ...time(t), ...(include_words ? { words: t.words.map(time) } : {}) })), artwork_submitted: false };
  },

  async audioSourceUpload({ file_path, kind = 'audio' }) {
    localFile(file_path, kind);
    this.ensureCompatible('audioSourceUpload');
    const original = fs.readFileSync(file_path);
    const sha256 = digest(original);
    const api = this.mod(M.uploadApi);
    const result = await api.uploadFileCommon({ filePath: file_path, fileType: api.FileType[ASSET_TYPES[kind]] });
    if (Number(result?.code) !== 0 || !result.data?.uri || !result.data?.url) throw Error(`AUDIO_SOURCE_UPLOAD_FAILED: ${result?.message || 'no uploaded resource'}`);
    if (kind === 'audio' && !result.data.decryptedUri) throw Error('AUDIO_SOURCE_UPLOAD_RETURNED_NO_REFERENCE_URI');
    const response = await this.fetch(result.data.url, { signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    if (!response.ok) throw Error(`AUDIO_SOURCE_READBACK_FAILED: HTTP ${response.status}`);
    if (digest(Buffer.from(await response.arrayBuffer())) !== sha256) throw Error('AUDIO_SOURCE_UPLOAD_READBACK_HASH_MISMATCH');
    return { kind, file_path, bytes: original.length, sha256, uri: result.data.uri, decrypted_uri: result.data.decryptedUri || null, url: result.data.url, hash_readback_matches: true, artwork_submitted: false };
  },

  async audioSourceReview({ file_path }) {
    localFile(file_path, 'audio');
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(file_path)], { type: 'audio/mpeg' }), path.basename(file_path));
    await request(this, 'AUDIO_SOURCE_REVIEW', ROUTES.review, { multipart: form, timeoutMs: MEDIA_TIMEOUT_MS });
    // This endpoint returns empty resource URIs even on success; it reviews rather than uploads.
    return { file_path, passed: true, review_only: true, artwork_submitted: false };
  },

  async audioSourceCheckStart({ template_uri, icon_uri, cover_uri, name }) {
    nonempty(template_uri, 'TEMPLATE_URI'); nonempty(icon_uri, 'ICON_URI'); nonempty(name, 'NAME');
    const data = await request(this, 'AUDIO_SOURCE_PACKAGE_CHECK', ROUTES.check_start, { json: {
      TaskType: 2, ArtworkType: 2, Source: 6,
      PreCheckPayload: { EncryptedFileURI: template_uri, ArtworkName: name, EncryptedIconURI: icon_uri, EncryptedCoverURI: cover_uri || icon_uri },
    } });
    if (!data?.JobID) throw Error('AUDIO_SOURCE_PACKAGE_CHECK_RETURNED_NO_JOB');
    return { job_id: String(data.JobID), artwork_submitted: false };
  },

  async audioSourceCheckTask({ job_id }) {
    nonempty(job_id, 'JOB_ID');
    const data = await request(this, 'AUDIO_SOURCE_PACKAGE_CHECK', ROUTES.check_query, { query: { JobID: job_id, ArtworkType: 2 } });
    if (!Number.isInteger(data?.TaskStatus)) throw Error('AUDIO_SOURCE_PACKAGE_CHECK_BAD_RESPONSE');
    const passed = data.TaskStatus === 0 && data.Result === 0 && !!data.ResourceID && Array.isArray(data.PerfList) && data.PerfList.length > 0 && data.PerfList.every(p => p.Result === 0);
    return { ...data, job_id, passed, scope: 'template_performance_only', media_integrity_verified: false, artwork_submitted: false };
  },
};

const METHODS = {
  audio_source_config: 'audioSourceConfig', audio_source_generate: 'audioSourceGenerate', audio_source_task: 'audioSourceTask',
  audio_source_upload: 'audioSourceUpload', audio_source_review: 'audioSourceReview',
  audio_source_beats: 'audioSourceBeats', audio_source_align: 'audioSourceAlign',
  audio_source_check_start: 'audioSourceCheckStart', audio_source_check_task: 'audioSourceCheckTask',
  audio_source_submit_context: 'audioSourceSubmitContext', audio_source_submit: 'audioSourceSubmit',
};
module.exports = { methods, METHODS, MODES, ASSET_TYPES };
