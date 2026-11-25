import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AudioSubmissions, prepareAudioSubmission, submissionDigest } from '../src/audiosubmit.mjs';
import { createServer } from '../src/server.mjs';
const require = createRequire(import.meta.url);
const { Library, M, METHODS } = require('../editor-plugin/library.cjs');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const projectId = '96876f3d-cf45-4af1-8500-01c62519ad8b';
const account = { uid: '1234567890123456789', nickname: '测试作者' };
const baseRequest = () => ({ project_id: projectId, name: '原创风铃', icon_e_uri: 'encrypted-icon', file_e_uri: 'encrypted-template', ecpj_e_uri: 'encrypted-project', size: '1234', os: 'android', creator_version: '17.8.0', type: 14, is_project_authorization: 1, bind_resource: [{ type: 10, key: 'encrypted-showcase', source: 0, sub_type: 2 }, { type: 10, key: 'encrypted-icon', source: 0, sub_type: 1 }], customized: '{"min_xiangsu_version_android":"17.8.0","min_xiangsu_version_ios":"17.8.0"}' });

function runtime(handler) {
  const env = { uid: account.uid, passed: true, cookie: 'test-cookie', cookie_reads: 0, onProfile: null }, calls = [], uploads = [], cdn = new Map();
  const modules = {
    [M.urls]: { Domain: { kBackendApiURL: 'https://api.test' }, DomainPath: { kActivityAPI: 'a', kTaskListAPI: 'b', kGrowthTaskList: 'c' } },
    [M.orionui]: { CookieManager: class { async getCookie() { env.cookie_reads++;return env.cookie; } } },
    [M.bizUtils]: { PlatformUtils: { genSignData: () => 'test-sign' }, UserAgentUtils: { userAgentGenerator: () => () => 'TestDesktop' } },
    [M.activityTypes]: { getTypeName: () => '', TaskStatus: { WAIT_RECEIVE: 1, WAIT_SUBMIT: 2 }, growthTaskType: { Newbie: 0 } },
    [M.inspirationConst]: { IS_COLLECT_PARAMS_TYPE: { Default: 2 } },
    [M.inspirationBridge]: { markAgentInspirationUsed() {} },
    [M.uploadApi]: { FileType: { Picture: 1, Video: 2, Project: 3, Effect: 4, Audio: 6 }, async uploadFileCommon(args) {
      uploads.push(args); const uri = `encrypted-${uploads.length}`, url = `https://cdn.test/${uploads.length}`; cdn.set(url, fs.readFileSync(args.filePath));
      return { code: 0, data: { uri, decryptedUri: 'plain/' + uri, url } };
    } },
  };
  const lib = new Library(name => { if (!Object.hasOwn(modules, name)) throw Error('UNKNOWN_MODULE:' + name); return modules[name]; }, async (href, init = {}) => {
    const url = new URL(href); const row = { path: url.pathname, method: init.method || 'GET', headers: init.headers, body: init.body }; calls.push(row);
    if (url.hostname === 'cdn.test') return new Response(cdn.get(href));
    if (row.path === '/effectcam/v1/submit') {
      if (!handler) throw Error('PUBLICATION_TRANSPORT_NOT_CONFIGURED');
      return handler(row);
    }
    let data;
    if (row.path === '/cam_api/designer/v1/base') { data = { designer: { uid: env.uid, username: account.nickname } };env.onProfile?.(row); }
    else if (row.path === '/cam_api/v2/music/upload_review') data = {};
    else if (row.path === '/cam_api/pre_check/submit_task') data = { JobID: '123456' };
    else if (row.path === '/cam_api/pre_check/performance') data = { TaskStatus: env.passed ? 0 : 1, Result: 0, ResourceID: 'checked', PerfList: [{ Result: 0 }] };
    else throw Error('UNEXPECTED_TEST_ROUTE:' + row.path);
    return new Response(JSON.stringify({ code: 0, data }));
  });
  return { lib, calls, uploads, env };
}

function fixture() {
  const directory = tmpdir('audio-submit-fixture-'), template = path.join(directory, 'template'), source = path.join(directory, 'source');
  fs.mkdirSync(template); fs.mkdirSync(source);
  fs.writeFileSync(path.join(template, 'NLETemplate.json'), '{"fixture":"paired runtime package"}');
  const templateZip = path.join(directory, 'AudioTemplate.zip');execFileSync('/usr/bin/zip', ['-qr', templateZip, '.'], { cwd: template });
  fs.writeFileSync(path.join(source, 'customInfo.json'), JSON.stringify({ draftType: 14, draftId: projectId }));
  fs.copyFileSync(templateZip, path.join(source, 'EcTemplate.zip'));
  const projectZip = path.join(directory, 'AudioProject.zip');
  const audio = path.join(directory, 'own.mp3'), icon = path.join(directory, 'icon.png'), showcase = path.join(directory, 'showcase.mp4');
  for (const [file, bytes] of [[audio, 'owned MP3 fixture'], [icon, 'owned icon fixture'], [showcase, 'owned showcase fixture']]) fs.writeFileSync(file, bytes);
  const manifestPath = path.join(directory, 'manifest.json');
  function repack() {
    if (fs.existsSync(projectZip)) fs.unlinkSync(projectZip);
    execFileSync('/usr/bin/zip', ['-qr', projectZip, '.'], { cwd: source });
    fs.writeFileSync(manifestPath, JSON.stringify({ name: '原创风铃', artwork_type: 14, compatibility_version: '17.8.0', template_zip: templateZip, project_zip: projectZip, packages: [templateZip, projectZip].map(file => ({ file, sha256: hash(fs.readFileSync(file)), bytes: fs.statSync(file).size })) }));
  }
  repack();
  return { directory, source, audio, icon, showcase, templateZip, projectZip, repack, manifestPath, args: { manifest_path: manifestPath, icon_path: icon, showcase_path: showcase } };
}

function mediaServices(f) {
  const calls = { validation: [], reviews: [], uploads: [], rendered: [], contexts: 0 };
  const services = {
    validate: async args => { calls.validation.push(args); return { bytes: fs.statSync(args.file_path).size, ...(args.kind === 'audio' ? { codec: 'mp3', duration_s: 3 } : {}) }; },
    openProject: async () => ({ clips: [{ file_path: f.audio }] }),
    render: async args => { calls.rendered.push({ ...args, input_sha256: hash(fs.readFileSync(args.clips[0].file_path)) }); fs.writeFileSync(args.export_path, 'owned transcoded showcase soundtrack'); return { export_path: args.export_path }; },
    context: async () => { calls.contexts++; return account; },
    review: async args => { calls.reviews.push(args); return { passed: true }; },
    upload: async args => { calls.uploads.push(args); return { ...args, uri: 'enc-' + args.kind, sha256: hash(fs.readFileSync(args.file_path)), hash_readback_matches: true }; },
    checkStart: async () => ({ job_id: 'job-123' }), checkQuery: async () => ({ passed: true }),
  };
  return { services, calls };
}

test('audio submission preparation builds the native type-14 request and validates before any artwork POST', async () => {
  const f = fixture(), { services, calls } = mediaServices(f);
  const result = await prepareAudioSubmission({ ...f.args, description: '原创短歌', share_id: 'share-123' }, services);
  assert.deepEqual(result.request, {
    ...baseRequest(), description: '原创短歌', size: String(fs.statSync(f.templateZip).size),
    icon_e_uri: 'enc-icon', file_e_uri: 'enc-template', ecpj_e_uri: 'enc-project',
    bind_resource: [{ type: 10, key: 'enc-showcase', source: 0, sub_type: 2 }, { type: 10, key: 'enc-icon', source: 0, sub_type: 1 }], share_id: 'share-123',
  });
  assert.equal(calls.contexts, 2);
  assert.deepEqual(calls.uploads.map(u => u.kind), ['template', 'project', 'icon', 'showcase']);
  assert.equal(calls.reviews[0].file_path, f.audio);
  assert.equal(calls.rendered[0].input_sha256, hash(fs.readFileSync(f.showcase)));
  assert.equal(calls.reviews[1].file_path, calls.rendered[0].export_path);
  assert.equal(fs.existsSync(calls.rendered[0].export_path), false, 'scratch soundtrack removed');
  assert.equal(result.summary.validation.submission_end_to_end, 'not_run');
  assert.equal(result.summary.performance_job_id, 'job-123');
  assert.deepEqual(result.summary.task_bindings, []);
  const reused = await prepareAudioSubmission({ ...f.args, name: '改编短歌', allow_project_reuse: true }, services);
  assert.equal(reused.request.name, '改编短歌'); assert.equal(reused.request.is_project_authorization, 2);
});

test('modified manifests, mismatched source/template packages and wrong artwork IDs cannot prepare a submission', async () => {
  for (const fault of ['hash', 'embedded-template', 'wrong-type', 'missing-project-id', 'manifest-type', 'manifest-version', 'manifest-packages']) {
    const f = fixture(), { services, calls } = mediaServices(f);
    if (fault === 'hash') { fs.appendFileSync(f.templateZip, 'changed bytes'); const m = JSON.parse(fs.readFileSync(f.manifestPath)); assert.notEqual(hash(fs.readFileSync(f.templateZip)), m.packages[0].sha256, 'hash fault injected'); }
    else if (fault === 'embedded-template') { fs.writeFileSync(path.join(f.source, 'EcTemplate.zip'), 'different runtime bytes'); f.repack(); assert.notDeepEqual(fs.readFileSync(path.join(f.source, 'EcTemplate.zip')), fs.readFileSync(f.templateZip), 'pairing fault injected'); }
    else if (fault.startsWith('manifest-')) { const m = JSON.parse(fs.readFileSync(f.manifestPath));if (fault === 'manifest-type') m.artwork_type = 0;else if (fault === 'manifest-version') m.compatibility_version = 'invalid-version';else m.packages = {};fs.writeFileSync(f.manifestPath, JSON.stringify(m));const after = JSON.parse(fs.readFileSync(f.manifestPath));if (fault === 'manifest-type') assert.equal(after.artwork_type, 0);else if (fault === 'manifest-version') assert.equal(after.compatibility_version, 'invalid-version');else assert.equal(Array.isArray(after.packages), false); }
    else { const value = { draftType: fault === 'wrong-type' ? 0 : 14, draftId: fault === 'missing-project-id' ? '' : projectId }; fs.writeFileSync(path.join(f.source, 'customInfo.json'), JSON.stringify(value)); f.repack(); const after = JSON.parse(fs.readFileSync(path.join(f.source, 'customInfo.json')));assert.equal(after.draftId, value.draftId);assert.equal(after.draftType, value.draftType); }
    const expected = fault === 'hash' ? /PACKAGE_CHANGED/ : fault === 'embedded-template' ? /TEMPLATE_SOURCE_MISMATCH/ : fault.startsWith('manifest-') ? /UNSUPPORTED_MANIFEST/ : /INVALID_SOURCE_ID/;
    await assert.rejects(prepareAudioSubmission(f.args, services), expected);
    assert.equal(calls.uploads.length, 0); assert.equal(calls.contexts, 0);
  }
});

test('source and showcase pre-review failures, bad upload readback and account changes stay explicit', async () => {
  for (const fault of ['source-review', 'showcase-review', 'upload-readback', 'account-switch']) {
    const f = fixture(), { services, calls } = mediaServices(f);
    if (fault.includes('review')) services.review = async args => { calls.reviews.push(args); return { passed: fault === 'showcase-review' && calls.reviews.length === 1 }; };
    if (fault === 'upload-readback') services.upload = async args => { calls.uploads.push(args); const wrong = '0'.repeat(64); assert.notEqual(wrong, hash(fs.readFileSync(args.file_path)), 'wrong readback hash injected'); return { uri: 'enc', sha256: wrong, hash_readback_matches: true }; };
    if (fault === 'account-switch') services.context = async () => { calls.contexts++; return calls.contexts === 1 ? account : { uid: 'different-account' }; };
    await assert.rejects(prepareAudioSubmission(f.args, services), /REVIEW_FAILED|UPLOAD_NOT_VERIFIED|ACCOUNT_CHANGED/);
    if (fault.includes('review')) { assert.equal(calls.uploads.length, 0);assert.equal(calls.reviews.length, fault === 'source-review' ? 1 : 2, 'review failure injection reached the intended track'); }
    if (fault === 'account-switch') assert.equal(calls.contexts, 2);
  }
});

test('preparation uploads the validated snapshot even when the caller edits original files during pre-review', async () => {
  const f = fixture(), { services, calls } = mediaServices(f);
  const originalTemplateHash = hash(fs.readFileSync(f.templateZip)), originalIconHash = hash(fs.readFileSync(f.icon));
  services.context = async () => {
    calls.contexts++;
    if (calls.contexts === 1) { fs.writeFileSync(f.templateZip, 'changed runtime after validation');fs.writeFileSync(f.icon, 'changed icon after validation'); }
    return account;
  };
  const p = await prepareAudioSubmission(f.args, services);
  assert.notEqual(hash(fs.readFileSync(f.templateZip)), originalTemplateHash, 'concurrent template edit injected');
  assert.notEqual(hash(fs.readFileSync(f.icon)), originalIconHash, 'concurrent icon edit injected');
  assert.equal(p.summary.assets.template.sha256, originalTemplateHash);assert.equal(p.summary.assets.icon.sha256, originalIconHash);
  assert.equal(p.summary.assets.icon.source_path, f.icon);assert.equal(Object.hasOwn(p.summary.assets.icon, 'file_path'), false);
  assert.equal(p.summary.validation.uploaded_snapshot, true);
});

test('a distinct cover image is uploaded separately and keeps its native cover binding', async () => {
  const f = fixture(), { services, calls } = mediaServices(f), cover = path.join(f.directory, 'cover.png');fs.writeFileSync(cover, 'different cover image');
  services.upload = async args => { calls.uploads.push(args);const sha256 = hash(fs.readFileSync(args.file_path));return { ...args, uri: 'enc-' + sha256, sha256, hash_readback_matches: true }; };
  const p = await prepareAudioSubmission({ ...f.args, cover_path: cover }, services);
  assert.equal(calls.uploads.length, 5);assert.notEqual(p.summary.assets.icon.uri, p.summary.assets.cover.uri);
  assert.equal(p.request.bind_resource[1].key, p.summary.assets.cover.uri);assert.equal(p.request.bind_resource[1].sub_type, 1);
});

test('native submission uses one signed POST, preserves the receipt IDs, and never equates it with listing approval', async () => {
  const s = runtime(() => new Response('{"code":0,"data":{"effect_id":7711666123456789012,"item_id":"item-123","pre_gen_online_id":"online-123"}}'));
  const request = baseRequest(), result = await s.lib.audioSourceSubmit({ request, request_sha256: submissionDigest(request), account_uid: account.uid });
  assert.deepEqual(result, { state: 'submitted', artwork_submitted: true, retry_safe: false, effect_id: '7711666123456789012', item_id: 'item-123', pre_gen_online_id: 'online-123', review_status: 'not_queried' });
  const posts = s.calls.filter(c => c.method === 'POST');assert.equal(posts.length, 1);assert.equal(posts[0].path, '/effectcam/v1/submit');
  assert.deepEqual(JSON.parse(posts[0].body), request);
  assert.deepEqual(posts[0].headers, { cookie: 'test-cookie', 'x-api-sign-data': 'test-sign', 'user-agent': 'TestDesktop', 'content-type': 'application/json' });
  assert.equal(s.env.cookie_reads, 1);
});

test('submission rejection, transport failure and malformed success each remain non-retryable outcomes', async () => {
  for (const [handler, expected] of [
    [() => new Response('{"code":1014,"message":"busy"}'), 'rejected'],
    [() => new Response('failure', { status: 503 }), 'unknown'],
    [() => { throw Error('connection lost after sending'); }, 'unknown'],
    [() => new Response('invalid JSON'), 'unknown'],
    [() => new Response('{"data":{"effect_id":"123"}}'), 'unknown'],
    [() => new Response('{"code":0,"data":{}}'), 'unknown'],
    [() => new Response('{"code":0,"data":{"effect_id":"0"}}'), 'unknown'],
    [() => new Response('{"code":0,"data":{"effect_id":"not-an-id"}}'), 'unknown'],
  ]) {
    const s = runtime(handler), request = baseRequest(); const r = await s.lib.audioSourceSubmit({ request, request_sha256: submissionDigest(request), account_uid: account.uid });
    assert.equal(r.state, expected); assert.equal(r.retry_safe, false); assert.equal(r.artwork_submitted, expected === 'rejected' ? false : null); assert.equal(s.calls.filter(c => c.method === 'POST').length, 1);
    if (expected === 'rejected') assert.deepEqual([r.code, r.message], ['1014', 'busy']);
  }
});

test('wrong artwork type, cross-submission fields, missing assets and changed media/digest fail before POST', async () => {
  for (const change of [{ type: 0 }, { effect_id: 'update-an-existing-work' }, { sub_artwork_info: { type: 2 } }, { file_e_uri: '' }, { size: '0' }, { is_project_authorization: 0 }, { bind_resource: [] }, { bind_resource: [{ type: 10, key: 'v', source: 0, sub_type: 5 }, { type: 10, key: 'i', source: 0, sub_type: 1 }] }]) {
    const s = runtime(() => { throw Error('MUST_NOT_SEND'); }), request = { ...baseRequest(), ...change };
    await assert.rejects(s.lib.audioSourceSubmit({ request, request_sha256: submissionDigest(request), account_uid: account.uid }), /AUDIO_SOURCE_SUBMIT_/);assert.equal(s.calls.length, 0);
  }
  const s = runtime(), request = baseRequest(); const changed = { ...request, name: 'changed' };assert.notEqual(submissionDigest(request), submissionDigest(changed), 'digest mismatch injected');
  await assert.rejects(s.lib.audioSourceSubmit({ request: changed, request_sha256: submissionDigest(request), account_uid: account.uid }), /DIGEST_MISMATCH/);assert.equal(s.calls.length, 0);
});

test('the final account check and submission use one captured login even if the editor switches accounts mid-call', async () => {
  const s = runtime(() => new Response('{"code":0,"data":{"effect_id":"123"}}')), request = baseRequest();
  s.env.cookie = 'cookie-A';s.env.onProfile = () => { s.env.cookie = 'cookie-B';s.env.uid = 'another-user'; };
  const result = await s.lib.audioSourceSubmit({ request, request_sha256: submissionDigest(request), account_uid: account.uid });
  assert.equal(s.env.uid, 'another-user', 'mid-call account switch injected');assert.equal(result.state, 'submitted');
  assert.deepEqual(s.calls.map(c => c.headers.cookie), ['cookie-A', 'cookie-A']);assert.equal(s.env.cookie_reads, 1);
  const changed = runtime(() => { throw Error('MUST_NOT_SEND'); });changed.env.uid = 'another-user';
  const rejected = await changed.lib.audioSourceSubmit({ request, request_sha256: submissionDigest(request), account_uid: account.uid });
  assert.equal(rejected.state, 'rejected');assert.equal(rejected.code, 'ACCOUNT_CHANGED');assert.equal(changed.calls.filter(c => c.method === 'POST').length, 0);
  const unavailable = runtime();let failedRead = false;unavailable.env.onProfile = () => { failedRead = true;throw Error('identity lookup unavailable'); };
  const blocked = await unavailable.lib.audioSourceSubmit({ request, request_sha256: submissionDigest(request), account_uid: account.uid });
  assert.equal(failedRead, true, 'identity read failure injected');assert.equal(blocked.state, 'rejected');assert.equal(blocked.code, 'ACCOUNT_CHECK_FAILED');assert.equal(unavailable.calls.filter(c => c.method === 'POST').length, 0);
});

test('account context only returns the current signed-in identity and refuses anonymous submissions', async () => {
  const s = runtime();assert.deepEqual(await s.lib.audioSourceSubmitContext(), account);assert.equal(s.calls[0].method, 'GET');
  s.env.uid = '0';assert.equal(s.env.uid, '0', 'anonymous identity injected');await assert.rejects(s.lib.audioSourceSubmitContext(), /LOGIN_REQUIRED/);
});

const preparation = store => store.prepare({ request: baseRequest(), account, summary: { performance_job_id: 'job-123' } });
const submitArgs = p => ({ submission_id: p.submission_id, name: p.name, account });

test('submission state uses explicit, configured and default roots without writing to the user home during tests', () => {
  const previous = process.env.XIANGSU_MCP_PLUS_STATE;
  try {
    process.env.XIANGSU_MCP_PLUS_STATE = '/tmp/configured-audio-state';
    assert.equal(new AudioSubmissions().directory, '/tmp/configured-audio-state/audio-submissions');
    assert.equal(new AudioSubmissions({ stateDir: '/tmp/explicit-audio-state' }).directory, '/tmp/explicit-audio-state/audio-submissions');
    delete process.env.XIANGSU_MCP_PLUS_STATE;
    assert.equal(new AudioSubmissions().directory, path.join(os.homedir(), '.xiangsu-mcp-plus/audio-submissions'));
  } finally { if (previous === undefined) delete process.env.XIANGSU_MCP_PLUS_STATE;else process.env.XIANGSU_MCP_PLUS_STATE = previous; }
});

test('submission preparations require the exact name, account, immutable request and check evidence', async () => {
  const store = new AudioSubmissions({ stateDir: tmpdir('submit-plans-') });const p = preparation(store);let sends = 0, passed = false;
  const services = { check: async () => { if (!passed) throw Error('CHECK_NOT_PASSED'); }, send: async () => { sends++; return { state: 'submitted', artwork_submitted: true, effect_id: '123', retry_safe: false }; } };
  await assert.rejects(store.submit({ ...submitArgs(p), name: 'wrong' }, services), /NAME_MISMATCH/);
  await assert.rejects(store.submit({ ...submitArgs(p), account: { uid: 'another' } }, services), /ACCOUNT_CHANGED/);
  await assert.rejects(store.submit(submitArgs(p), services), /CHECK_NOT_PASSED/);assert.equal(sends, 0);assert.equal(fs.existsSync(store.file(p.submission_id, '.attempt')), false);
  passed = true;assert.equal((await store.submit(submitArgs(p), services)).effect_id, '123');assert.equal(sends, 1);
  for (const field of ['request', 'account', 'summary', 'request-digest']) {
    const next = preparation(store), file = store.file(next.submission_id), record = JSON.parse(fs.readFileSync(file));
    if (field === 'request') record.request.name = 'changed';
    else if (field === 'account') record.account.uid = 'changed';
    else if (field === 'summary') record.summary.performance_job_id = 'another-job';
    else record.request_sha256 = '0'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(record));
    if (field === 'request-digest') assert.notEqual(record.request_sha256, hash(JSON.stringify(record.request)), 'request digest tamper injected');
    else assert.notEqual(record.preparation_sha256, hash(JSON.stringify({ request: record.request, account: record.account, summary: record.summary })), 'prepared snapshot tamper injected');
    await assert.rejects(store.submit(submitArgs(next), services), /PREPARATION_CHANGED/);
  }
  assert.equal(sends, 1);
});

test('receipts survive process recreation and an uncertain attempt is never posted again', async () => {
  const stateDir = tmpdir('submit-restart-'), store = new AudioSubmissions({ stateDir });const p = preparation(store);let sends = 0, checks = 0;
  const services = { check: async () => { checks++; }, send: async () => { sends++; return { state: 'submitted', artwork_submitted: true, effect_id: '987', retry_safe: false }; } };
  assert.equal((await store.submit(submitArgs(p), services)).effect_id, '987');
  const second = new AudioSubmissions({ stateDir }); const reused = await second.submit(submitArgs(p), services);assert.equal(reused.effect_id, '987');assert.equal(reused.reused_receipt, true);assert.equal(sends, 1);assert.equal(checks, 1);
  const uncertain = preparation(store);const failed = { check: async () => {}, send: async () => { sends++; throw Error('RPC timed out after send'); } };
  const unknown = await store.submit(submitArgs(uncertain), failed);assert.equal(unknown.state, 'unknown');assert.equal(unknown.artwork_submitted, null);
  assert.equal((await second.submit(submitArgs(uncertain), failed)).reused_receipt, true);assert.equal(sends, 2);
  const interrupted = preparation(store);fs.writeFileSync(store.file(interrupted.submission_id, '.attempt'), 'interrupted request');assert.equal(fs.existsSync(store.file(interrupted.submission_id, '.attempt')), true, 'unfinished attempt injected');
  const r = await second.submit(submitArgs(interrupted), failed);assert.equal(r.state, 'unknown');assert.equal(r.artwork_submitted, null);assert.equal(r.retry_safe, false);assert.equal(sends, 2);
});

test('concurrent submit calls claim a preparation once even when both pass the asynchronous preflight', async () => {
  const stateDir = tmpdir('submit-race-'), store = new AudioSubmissions({ stateDir }), second = new AudioSubmissions({ stateDir }), p = preparation(store);
  let entered = 0, sends = 0, releaseChecks, releaseSend;
  const checksReady = new Promise(resolve => { releaseChecks = resolve; }), sendReady = new Promise(resolve => { releaseSend = resolve; });
  const services = { check: async () => { entered++;if (entered === 2) releaseChecks();await checksReady; }, send: async () => { sends++;await sendReady;return { state: 'submitted', artwork_submitted: true, effect_id: '456' }; } };
  const a = store.submit(submitArgs(p), services), b = second.submit(submitArgs(p), services);
  try { await new Promise(resolve => setImmediate(resolve));assert.equal(sends, 1); }finally { releaseSend(); }
  const finished = await Promise.all([a, b]);assert.equal(finished.filter(r => r.state === 'submitted').length, 1);assert.equal(sends, 1);assert.equal(entered, 2);
});

test('a receipt persistence failure reports the accepted server ID and leaves the attempt locked', async () => {
  const store = new AudioSubmissions({ stateDir: tmpdir('submit-write-failure-') }), p = preparation(store), original = fs.writeFileSync;let injected = false, sends = 0;
  fs.writeFileSync = function(file, ...args) { if (file === store.file(p.submission_id, '.receipt.json')) { injected = true;throw Error('ENOSPC receipt failure'); }return original.call(this, file, ...args); };
  let r;
  try { r = await store.submit(submitArgs(p), { check: async () => {}, send: async () => { sends++;return { state: 'submitted', artwork_submitted: true, effect_id: '123' }; } }); }finally { fs.writeFileSync = original; }
  assert.equal(injected, true, 'receipt write failure injected');assert.equal(r.effect_id, '123');assert.equal(r.receipt_saved, false);assert.match(r.persistence_error, /ENOSPC/);
  assert.equal(fs.existsSync(store.file(p.submission_id, '.attempt')), true);
  const again = await store.submit(submitArgs(p), { check: async () => {}, send: async () => { sends++;throw Error('MUST_NOT_RESEND'); } });assert.equal(again.state, 'unknown');assert.equal(sends, 1);
});

test('MCP prepares a reviewed snapshot without publication, then submits exactly that snapshot through the intercepted adapter', async () => {
  const f = fixture(), media = mediaServices(f), s = runtime(() => new Response('{"code":0,"data":{"effect_id":"12345678"}}'));
  const store = new AudioSubmissions({ stateDir: tmpdir('submit-mcp-state-') });
  const server = createServer({ flatTools: false, official: { listTools: async () => [], status: () => ({ connected: false }) }, listInstances: () => [{ pid: 11 }], audioSubmissions: store, validateAudioSourceAsset: media.services.validate, openAudioProject: media.services.openProject, renderAudio: media.services.render, callPlugin: async (method, args) => { if (!METHODS[method]) throw Error('UNKNOWN_RPC');return s.lib[METHODS[method]](args); } });
  const client = new Client({ name: 'codex', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  const call = (name, args) => client.callTool({ name: 'tool_call', arguments: { name, arguments: args } });
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    for (const name of ['audio_source_submit_prepare', 'audio_source_submit']) { const r = await client.callTool({ name: 'tool_describe', arguments: { name } });assert.equal(r.isError, undefined);assert.equal(JSON.parse(r.content[0].text).name, name); }
    const prepared = await call('audio_source_submit_prepare', f.args);assert.equal(prepared.isError, undefined, prepared.content[0].text);const p = JSON.parse(prepared.content[0].text);
    assert.equal(p.state, 'prepared');assert.equal(p.artwork_submitted, false);assert.equal(s.calls.filter(c => c.path === '/effectcam/v1/submit').length, 0);
    const wrong = await call('audio_source_submit', { submission_id: p.submission_id, name: 'another title' });assert.equal(wrong.isError, true);
    s.env.passed = false;const blocked = await call('audio_source_submit', { submission_id: p.submission_id, name: p.name });assert.equal(blocked.isError, true);assert.match(blocked.content[0].text, /CHECKS_NOT_PASSED/);assert.equal(s.calls.filter(c => c.path === '/effectcam/v1/submit').length, 0);
    s.env.passed = true;const sent = await call('audio_source_submit', { submission_id: p.submission_id, name: p.name });assert.equal(sent.isError, undefined, sent.content[0].text);assert.equal(JSON.parse(sent.content[0].text).effect_id, '12345678');
    const reused = await call('audio_source_submit', { submission_id: p.submission_id, name: p.name });assert.equal(JSON.parse(reused.content[0].text).reused_receipt, true);
    const posts = s.calls.filter(c => c.path === '/effectcam/v1/submit');assert.equal(posts.length, 1);assert.deepEqual(JSON.parse(posts[0].body), p.request);
    s.env.uid = 'other-account';const changed = await call('audio_source_submit', { submission_id: p.submission_id, name: p.name });assert.equal(changed.isError, true);assert.match(changed.content[0].text, /ACCOUNT_CHANGED/);
    const before = s.calls.length;const raw = await call('audio_source_submit', { submission_id: p.submission_id, name: p.name, type: 0, request: baseRequest() });assert.equal(raw.isError, true);assert.equal(s.calls.length, before, 'raw publication fields rejected before any RPC');
  } finally { await client.close();await server.close(); }
});
