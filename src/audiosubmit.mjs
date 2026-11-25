import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AUDIO_TEMPLATE_VERSION, openAudioProject } from './audiotemplate.mjs';
import { validateAudioSourceAsset } from './audiosource.mjs';
import { renderAudio } from './audioedit.mjs';

const run = promisify(execFile);
const fileHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export const submissionDigest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// Native 17.8.0: type=14; Media=10 with Video=2/Cover=1; source reuse No=1/Yes=2.
// The source and runtime ZIPs come from audio_template_prepare, without a mobile runtime.
export async function prepareAudioSubmission(args, services) {
  const { manifest_path, icon_path, showcase_path, cover_path = icon_path, description, share_id, allow_project_reuse = false } = args;
  if (![manifest_path, icon_path, showcase_path, cover_path].every(p => typeof p === 'string' && path.isAbsolute(p))) throw Error('AUDIO_SUBMIT_ABSOLUTE_PATHS_REQUIRED');
  const manifest = JSON.parse(fs.readFileSync(manifest_path, 'utf8'));
  const requestedName = args.name ?? manifest.name;
  const name = typeof requestedName === 'string' ? requestedName.trim() : '';
  if (!name) throw Error('AUDIO_SUBMIT_NAME_REQUIRED');
  if (manifest.artwork_type !== 14 || manifest.compatibility_version !== AUDIO_TEMPLATE_VERSION || !Array.isArray(manifest.packages)) throw Error('AUDIO_SUBMIT_UNSUPPORTED_MANIFEST');
  const originals = { template: manifest.template_zip, project: manifest.project_zip, icon: icon_path, showcase: showcase_path, cover: cover_path };
  const validate = services.validate || validateAudioSourceAsset;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-audio-submit-'));
  try {
    const files = {}, media = {}, copies = new Map();
    for (const [kind, original] of Object.entries(originals)) {
      if (typeof original !== 'string' || !path.isAbsolute(original)) throw Error('AUDIO_SUBMIT_ABSOLUTE_PATHS_REQUIRED');
      const key = (kind === 'cover' ? 'icon' : kind) + ':' + original;
      if (!copies.has(key)) {
        const copy = path.join(work, kind + path.extname(original));
        fs.copyFileSync(original, copy);
        copies.set(key, copy);
      }
      const file_path = copies.get(key);
      files[kind] = file_path;
      media[kind] = await validate({ file_path, kind: kind === 'cover' ? 'icon' : kind });
      if (['template', 'project'].includes(kind)) {
        const expected = manifest.packages?.filter(p => p.file === original);
        if (expected?.length !== 1 || expected[0].sha256 !== fileHash(file_path) || expected[0].bytes !== fs.statSync(file_path).size) throw Error(`AUDIO_SUBMIT_PACKAGE_CHANGED: ${kind}`);
      }
    }
    const opened = await (services.openProject || openAudioProject)({ project_zip: files.project, out_dir: work });
    const { stdout: infoBytes } = await run('/usr/bin/unzip', ['-p', files.project, 'customInfo.json']);
    const info = JSON.parse(infoBytes);
    if (info.draftType !== 14 || typeof info.draftId !== 'string' || !info.draftId.trim()) throw Error('AUDIO_SUBMIT_INVALID_SOURCE_ID');
    const { stdout: embedded } = await run('/usr/bin/unzip', ['-p', files.project, 'EcTemplate.zip'], { encoding: 'buffer', maxBuffer: fs.statSync(files.template).size + 65536 });
    if (!embedded.equals(fs.readFileSync(files.template))) throw Error('AUDIO_SUBMIT_TEMPLATE_SOURCE_MISMATCH');
    const account = await services.context();
    const reviewed = [];
    for (const file_path of new Set(opened.clips.map(c => c.file_path))) {
      await validate({ file_path, kind: 'audio' });
      const result = await services.review({ file_path });
      if (result.passed !== true) throw Error('AUDIO_SUBMIT_AUDIO_REVIEW_FAILED');
      reviewed.push({ sha256: fileHash(file_path), passed: true });
    }
    // Review the showcase's actual soundtrack too; it is a separate submitted media asset.
    const rendered = await (services.render || renderAudio)({ clips: [{ file_path: files.showcase }], export_path: path.join(work, 'showcase-audio.mp3') });
    const showcaseReview = await services.review({ file_path: rendered.export_path });
    if (showcaseReview.passed !== true) throw Error('AUDIO_SUBMIT_SHOWCASE_REVIEW_FAILED');
    const assets = {}, uploaded = new Map();
    for (const [kind, file_path] of Object.entries(files)) {
      const assetKind = kind === 'cover' ? 'icon' : kind;
      const key = assetKind + ':' + file_path;
      if (!uploaded.has(key)) {
        const asset = await services.upload({ file_path, kind: assetKind });
        if (!asset.hash_readback_matches || !asset.uri || asset.sha256 !== fileHash(file_path)) throw Error(`AUDIO_SUBMIT_UPLOAD_NOT_VERIFIED: ${kind}`);
        uploaded.set(key, asset);
      }
      const { file_path: snapshot, ...asset } = uploaded.get(key);
      assets[kind] = { ...asset, source_path: originals[kind] };
    }
    const check = await services.checkStart({ name, template_uri: assets.template.uri, icon_uri: assets.icon.uri, cover_uri: assets.cover.uri });
    const performance = await services.checkQuery({ job_id: check.job_id });
    if ((await services.context()).uid !== account.uid) throw Error('AUDIO_SUBMIT_ACCOUNT_CHANGED_DURING_PREPARATION');
    const request = {
      project_id: info.draftId, name,
      ...(description === undefined ? {} : { description }),
      icon_e_uri: assets.icon.uri, file_e_uri: assets.template.uri, ecpj_e_uri: assets.project.uri,
      size: String(fs.statSync(files.template).size), os: 'android', creator_version: AUDIO_TEMPLATE_VERSION,
      type: 14, is_project_authorization: allow_project_reuse ? 2 : 1,
      bind_resource: [
        { type: 10, key: assets.showcase.uri, source: 0, sub_type: 2 },
        { type: 10, key: assets.cover.uri, source: 0, sub_type: 1 },
      ],
      customized: JSON.stringify({ min_xiangsu_version_android: AUDIO_TEMPLATE_VERSION, min_xiangsu_version_ios: AUDIO_TEMPLATE_VERSION }),
      ...(share_id === undefined ? {} : { share_id }),
    };
    const summary = {
      artwork_type: 14, allow_project_reuse, task_bindings: [],
      performance_job_id: check.job_id, performance,
      assets, media, reviews: { source_tracks: reviewed, showcase_audio: true },
      validation: { source_project_opened: true, manifest_package_hashes_match: true, embedded_template_matches: true, uploaded_snapshot: true, submission_end_to_end: 'not_run' },
    };
    return { request, account, summary };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

// The attempt marker survives MCP restarts and RPC timeouts. Reusing a prepared submission
// returns its receipt or an explicit unknown outcome, without sending the artwork a second time.
export class AudioSubmissions {
  constructor({ stateDir = process.env.XIANGSU_MCP_PLUS_STATE || path.join(os.homedir(), '.xiangsu-mcp-plus') } = {}) {
    this.directory = path.join(stateDir, 'audio-submissions');
  }

  file(id, suffix = '.json') {
    if (!idPattern.test(id || '')) throw Error('AUDIO_SUBMIT_INVALID_PREPARATION_ID');
    return path.join(this.directory, id + suffix);
  }

  prepare({ request, account, summary }) {
    if (request?.type !== 14 || typeof account?.uid !== 'string' || !account.uid) throw Error('AUDIO_SUBMIT_INVALID_PREPARATION');
    const id = crypto.randomUUID();
    const record = { submission_id: id, created_at: new Date().toISOString(), request, request_sha256: submissionDigest(request), account, summary, preparation_sha256: submissionDigest({ request, account, summary }) };
    fs.mkdirSync(this.directory, { recursive: true });
    fs.writeFileSync(this.file(id), JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
    return { submission_id: id, name: request.name, state: 'prepared', account, ...summary, request, request_sha256: record.request_sha256, prepared_file: this.file(id), artwork_submitted: false };
  }

  read(id) {
    const record = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
    if (record.submission_id !== id || record.request_sha256 !== submissionDigest(record.request) || record.preparation_sha256 !== submissionDigest({ request: record.request, account: record.account, summary: record.summary }) || record.request?.type !== 14) throw Error('AUDIO_SUBMIT_PREPARATION_CHANGED');
    return record;
  }

  async submit({ submission_id, name, account }, { check, send }) {
    const record = this.read(submission_id);
    if (name !== record.request.name) throw Error(`AUDIO_SUBMIT_NAME_MISMATCH: preparation is for ${record.request.name}`);
    if (account?.uid !== record.account.uid) throw Error('AUDIO_SUBMIT_ACCOUNT_CHANGED: prepare again for the current account');
    const marker = this.file(submission_id, '.attempt');
    const previous = () => {
      const receipt = this.file(submission_id, '.receipt.json');
      if (fs.existsSync(receipt)) return { ...JSON.parse(fs.readFileSync(receipt, 'utf8')), reused_receipt: true };
      return { submission_id, name, state: 'unknown', artwork_submitted: null, retry_safe: false, reason: 'An attempt already exists without a receipt; inspect my_effects before any new preparation. No second submission was sent.' };
    };
    if (fs.existsSync(marker)) return previous();
    await check(record);
    try {
      fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), request_sha256: record.request_sha256 }), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return previous();
    }
    let result;
    try {
      result = await send({ request: record.request, request_sha256: record.request_sha256, account_uid: record.account.uid });
      if (!['submitted', 'rejected', 'unknown'].includes(result?.state)) throw Error('AUDIO_SUBMIT_INVALID_RPC_RESPONSE');
    } catch (error) {
      result = { state: 'unknown', artwork_submitted: null, retry_safe: false, reason: error.message };
    }
    const receipt = { submission_id, name, ...result };
    // A failed receipt write still leaves the exclusive marker, preventing an automatic retry.
    try {
      fs.writeFileSync(this.file(submission_id, '.receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
      return receipt;
    } catch (error) {
      return { ...receipt, receipt_saved: false, persistence_error: error.message };
    }
  }
}
