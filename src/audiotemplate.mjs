// Native AudioTemplate (artwork/draft type 14) packages, generated without an Android runtime.
// Container and draft metadata follow 像塑 17.8.0's DraftImpl.saveNLECloudDraft,
// CloudDraftUtil.copyCloudDraftRes and CKEDraftInfo/FeatureList serialization.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeAudio } from './mediainfo.mjs';
import { normalizeAudioClips } from './audioedit.mjs';

const run = promisify(execFile);
// Compatibility target tested with the native backend, rather than an inferred minimum SDK.
export const AUDIO_TEMPLATE_VERSION = '17.8.0';
const TEMPLATE_FEATURES = ['E_T', 'E', 'T_Base'];
// Source timelines remain editable through NLEEditor; the template's Editable/E_T capability is
// separate and is not required by the source audio graph (native SDK restore/edit/store verified).
const SOURCE_FEATURES = ['E', 'T_Base'];
const hash = (bytes, algorithm = 'sha256') => crypto.createHash(algorithm).update(bytes).digest('hex');
const writeJson = (directory, name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
const node = (_class, fields = {}) => ({ Name: crypto.randomUUID(), UUID: crypto.randomUUID(), _class, _features: ['E'], ...fields });

function audioModel(clips) {
  const objects = {}, tracks = [];
  const us = n => Math.round(n * 1e6);
  clips.forEach((c, i) => {
    const [res, seg, slot, track] = [1, 2, 3, 4].map(n => String(i * 4 + n));
    objects[res] = node('NLEResourceAV', { Duration: us(c.source.duration_s), HasAudio: true, ResourceFile: c.resource, ResourceId: '', ResourceType: 3 });
    objects[seg] = node('NLESegmentAudio', { TimeClipStart: us(c.trim_start_s), TimeClipEnd: us(c.trim_end_s), Volume: c.volume, Speed: c.speed, _objects: { AVFile: res } });
    objects[slot] = node('NLETrackSlot', { StartTime: us(c.start_s), EndTime: us(c.start_s + c.duration_s), NormalizeTime: -1, _objects: { MainSegment: seg } });
    objects[track] = node('NLETrack', { MainTrack: false, _arrays: { Slot: [slot] }, _objects: {}, _extras: { _trackType: '1', business: 'cke_creator' } });
    tracks.push(track);
  });
  const [config, info, model] = [1, 2, 3].map(n => String(clips.length * 4 + n));
  objects[config] = node('TemplateConfig', { _extras: { width: '720', height: '1280' } });
  objects[info] = node('TemplateInfo', { Editable: true, _features: [...TEMPLATE_FEATURES], _arrays: { MutableItems: [] }, _objects: { Config: config } });
  objects[model] = node('NLETemplateModel', { CanvasRatio: 720 / 1280, AlignMode: 'align_canvas', _features: ['E', 'T_Base'], _arrays: { Track: tracks }, _objects: { TemplateInfo: info } });
  return { _features: [...TEMPLATE_FEATURES], _objects: objects, _templateModel: model };
}

async function zip(directory, file) {
  await run('/usr/bin/zip', ['-q', '-r', file, '.'], { cwd: directory });
  await run('/usr/bin/unzip', ['-t', file]);
}

async function verifyEntry(archive, resource, expected) {
  // Picked 64 KiB diagnostic budget also covers unzip's stderr for tiny or missing entries.
  const { stdout } = await run('/usr/bin/unzip', ['-p', archive, resource], { encoding: 'buffer', maxBuffer: Math.max(expected.length + 1, 64 * 1024) });
  if (!stdout.equals(expected)) throw Error(`AUDIO_TEMPLATE_CONTENT_MISMATCH: ${resource}`);
}

export async function prepareAudioTemplate({ audio_path, clips, out_dir, name = audio_path ? path.basename(audio_path, path.extname(audio_path)) : 'AudioProject' }, { probe = probeAudio, pack = zip } = {}) {
  if (!path.isAbsolute(out_dir || '') || (audio_path !== undefined && !path.isAbsolute(audio_path))) throw Error('AUDIO_TEMPLATE_ABSOLUTE_PATHS_REQUIRED');
  if ((audio_path === undefined) === (clips === undefined)) throw Error('AUDIO_TEMPLATE_ONE_INPUT_REQUIRED: audio_path or clips');
  if (!name.trim()) throw Error('AUDIO_TEMPLATE_NAME_REQUIRED');
  const inputs = audio_path === undefined ? clips : [{ file_path: audio_path }];
  const prepared = await normalizeAudioClips(inputs, { probe: async file => {
    const audio = await probe(file);
    if (audio.codec !== 'mp3') throw Error('AUDIO_TEMPLATE_MP3_REQUIRED: use audio_probe export_path to convert the audio to MP3 first');
    if (!Number.isSafeInteger(Math.round(audio.duration_s * 1e6)) || !(audio.duration_s > 0)) throw Error('AUDIO_TEMPLATE_INVALID_DURATION');
    return audio;
  } });
  for (const c of prepared) {
    if (c.pitch_semitones || c.fade_in_s || c.fade_out_s || c.effect !== 'none') throw Error('AUDIO_TEMPLATE_RENDER_FIRST: render pitch, fades and effects using audio_render before packaging');
    c.bytes = fs.readFileSync(c.file_path);
    c.sha256 = hash(c.bytes);
    c.resource = `audio/${c.sha256}.mp3`;
    c.projectResource = `${hash(c.file_path, 'md5')}/${path.basename(c.resource)}`;
  }
  const duration = Math.round(Math.max(...prepared.map(c => c.start_s + c.duration_s)) * 1e6);
  if (!Number.isSafeInteger(duration) || duration <= 0) throw Error('AUDIO_TEMPLATE_INVALID_DURATION');
  const first = prepared[0], audio = first.source, bytes = first.bytes, sha256 = first.sha256;
  const version = AUDIO_TEMPLATE_VERSION;
  fs.mkdirSync(out_dir, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-native-audio-'));
  let output;
  try {
    output = fs.mkdtempSync(path.join(out_dir, 'audio-'));
    const templateDir = path.join(workspace, 'template');
    fs.mkdirSync(path.join(templateDir, 'audio'), { recursive: true });
    for (const c of prepared) fs.writeFileSync(path.join(templateDir, c.resource), c.bytes);
    const template = audioModel(prepared);
    writeJson(templateDir, 'NLETemplate.json', template);
    writeJson(templateDir, 'config.json', {
      effect: { model_names: { models: [] } },
      em_tool: 'AdvancedMobileEffect', name,
      temple_info: { feature: [...TEMPLATE_FEATURES], path: 'NLETemplate.json', type: 2 },
      version, AdvancedMobileEffect: { business: 'Pixel', minSdkVersion: version },
    });
    writeJson(templateDir, 'extra.json', {
      tool_music: { use_music_ids: [], use_local_audios: prepared.map(c => ({ path: path.basename(c.resource), start: c.start_s, duration: c.duration_s, volume: c.volume, is_loop: false, exclude_music: true })) },
      ame_business: { platform: 'android', AppVersion: version },
    });
    writeJson(templateDir, 'templateExtra.json', {});
    writeJson(templateDir, 'capabilities.json', { contentFeature: [['Audio_BackgroundMusic', 'VideoTemplate']] });
    const templateZip = path.join(output, 'AudioTemplate.zip');
    await pack(templateDir, templateZip);

    const projectDir = path.join(workspace, 'project');
    // The native cloud draft copies each local file under MD5(original path)/basename.
    const draft = structuredClone(template);
    draft._features = [...SOURCE_FEATURES];
    const sourceInfo = Object.values(draft._objects).find(n => n._class === 'TemplateInfo');
    sourceInfo._features = [...SOURCE_FEATURES];
    delete sourceInfo.Editable;
    prepared.forEach((c, i) => {
      fs.mkdirSync(path.join(projectDir, 'nle', path.dirname(c.projectResource)), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'nle', c.projectResource), c.bytes);
      draft._objects[String(i * 4 + 1)].ResourceFile = c.projectResource;
      draft._objects[String(i * 4 + 3)]._extras = { business_type: '26' };
    });
    writeJson(projectDir, 'nle/nle_draft.json', draft);
    fs.copyFileSync(templateZip, path.join(projectDir, 'EcTemplate.zip'));
    writeJson(projectDir, 'featureList.json', { ckeFeature: [], nleFeature: [...SOURCE_FEATURES] });
    const now = String(Date.now());
    writeJson(projectDir, 'customInfo.json', {
      draftId: crypto.randomUUID(), draftPath: '', templateModelPath: '', versionCode: 106,
      draftType: 14, platform: 'Android', curAppVersion: version, creationDataPath: '',
      minAppVersionAndroid: version, minAppVersioniOS: version, effectId: '', iconPath: '',
      name, createTime: now, updateTime: now, modelId: '', author: '',
    });
    writeJson(projectDir, 'customExtra.json', {});
    const projectZip = path.join(output, 'AudioProject.zip');
    await pack(projectDir, projectZip);
    // Native performance checks accept packages with missing audio. Check the actual ZIP bytes.
    for (const c of prepared) {
      await verifyEntry(templateZip, c.resource, c.bytes);
      await verifyEntry(projectZip, `nle/${c.projectResource}`, c.bytes);
    }
    await verifyEntry(projectZip, 'EcTemplate.zip', fs.readFileSync(templateZip));
    const result = {
      name, artwork_type: 14, compatibility_version: version,
      directory: output, template_zip: templateZip, project_zip: projectZip,
      audio: { source: first.file_path, sha256, bytes: bytes.length, duration_us: duration, sample_rate: audio.sample_rate, channels: audio.channels, codec: audio.codec },
      clips: prepared.map(({ bytes: data, projectResource, resource, ...c }) => ({ ...c, bytes: data.length })),
      packages: [templateZip, projectZip].map(file => ({ file, bytes: fs.statSync(file).size, sha256: hash(fs.readFileSync(file)) })),
      validation: { zip_integrity: true, audio_decoded: true, packaged_audio_matches: true, embedded_template_matches: true, cloud_precheck: 'not_run', source_sdk_reopen: 'not_run' },
      submitted: false,
    };
    writeJson(output, 'manifest.json', result);
    return result;
  } catch (error) {
    if (output) fs.rmSync(output, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

// Read entries as bytes instead of extracting ZIP links or paths into the filesystem.
export async function openAudioProject({ project_zip, out_dir }, { probe = probeAudio } = {}) {
  if (!path.isAbsolute(project_zip || '') || !path.isAbsolute(out_dir || '')) throw Error('AUDIO_PROJECT_ABSOLUTE_PATHS_REQUIRED');
  await run('/usr/bin/unzip', ['-t', project_zip]);
  const { stdout } = await run('/usr/bin/unzip', ['-Z1', project_zip]);
  const entries = stdout.trimEnd().split('\n');
  const safe = s => typeof s === 'string' && s.length > 0 && !s.startsWith('/') && !s.includes('\\') && !/[\u0000-\u001f*?\[\]]/.test(s) && !s.split('/').some(p => p === '..' || p === '.');
  if (new Set(entries).size !== entries.length || entries.some(s => !safe(s))) throw Error('AUDIO_PROJECT_UNSAFE_OR_DUPLICATE_ENTRY');
  const read = async name => {
    if (!safe(name) || !entries.includes(name)) throw Error(`AUDIO_PROJECT_MISSING_RESOURCE: ${name}`);
    const { stdout: bytes } = await run('/usr/bin/unzip', ['-p', project_zip, name], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
    return bytes;
  };
  const info = JSON.parse(await read('customInfo.json'));
  if (info.draftType !== 14) throw Error('AUDIO_PROJECT_WRONG_ARTWORK_TYPE');
  const draft = JSON.parse(await read('nle/nle_draft.json'));
  const objects = draft._objects;
  const model = objects?.[draft._templateModel];
  if (model?._class !== 'NLETemplateModel' || !Array.isArray(model._arrays?.Track) || !model._arrays.Track.length) throw Error('AUDIO_PROJECT_UNSUPPORTED_MODEL');
  const clips = [];
  for (const id of model._arrays.Track) {
    const track = objects[id];
    if (track?._class !== 'NLETrack' || !Array.isArray(track._arrays?.Slot) || !track._arrays.Slot.length) throw Error('AUDIO_PROJECT_UNSUPPORTED_TRACK');
    if (Object.keys(track._objects || {}).length || Object.entries(track._arrays).some(([k, a]) => k !== 'Slot' && a.length)) throw Error('AUDIO_PROJECT_UNSUPPORTED_AUDIO_FILTER');
    for (const slotId of track._arrays.Slot) {
      const slot = objects[slotId], segment = objects[slot?._objects?.MainSegment];
      const resource = objects[segment?._objects?.AVFile];
      if (slot?._class !== 'NLETrackSlot' || segment?._class !== 'NLESegmentAudio' || resource?._class !== 'NLEResourceAV' || resource.ResourceType !== 3) throw Error('AUDIO_PROJECT_UNSUPPORTED_SEGMENT');
      const segmentKeys = ['Name', 'UUID', '_class', '_features', '_extras', '_objects', '_arrays', 'TimeClipStart', 'TimeClipEnd', 'Volume', 'Speed'];
      if (Object.keys(segment).some(k => !segmentKeys.includes(k)) || Object.keys(slot._objects || {}).some(k => k !== 'MainSegment') || Object.values(slot._arrays || {}).some(a => a.length) || Object.keys(segment._objects || {}).some(k => k !== 'AVFile') || Object.values(segment._arrays || {}).some(a => a.length)) throw Error('AUDIO_PROJECT_UNSUPPORTED_AUDIO_FILTER: no silent loss of native filters');
      const bytes = await read(`nle/${resource.ResourceFile}`);
      clips.push({ bytes, sha256: hash(bytes), start_s: (slot.StartTime ?? 0) / 1e6, trim_start_s: (segment.TimeClipStart ?? 0) / 1e6, trim_end_s: segment.TimeClipEnd / 1e6, volume: segment.Volume ?? 1, speed: segment.Speed ?? 1, end_s: slot.EndTime / 1e6 });
    }
  }
  fs.mkdirSync(out_dir, { recursive: true });
  const directory = fs.mkdtempSync(path.join(out_dir, 'opened-audio-'));
  try {
    const editable = [];
    for (const { bytes, sha256, end_s, ...c } of clips) {
      const file_path = path.join(directory, sha256 + '.mp3');
      fs.writeFileSync(file_path, bytes);
      const [checked] = await normalizeAudioClips([{ ...c, file_path }], { probe });
      // NLE timestamps are integer microseconds, allowing one rounding unit at either end.
      if (!Number.isFinite(end_s) || Math.abs(end_s - checked.start_s - checked.duration_s) > 2e-6) throw Error('AUDIO_PROJECT_UNSUPPORTED_SLOT_DURATION');
      editable.push({ file_path, ...c });
    }
    return { name: info.name, artwork_type: 14, source_zip: project_zip, directory, clips: editable, workflow: 'Edit clips and call audio_template_prepare with clips to save a new project; audio_render renders the same clips.', validation: { zip_integrity: true, resource_audio_decoded: true, source_sdk_reopen: 'not_run' }, artwork_submitted: false };
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
