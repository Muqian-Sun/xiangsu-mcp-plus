import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { validateAudioSourceAsset, saveAudioSourceTask } from '../src/audiosource.mjs';
const require = createRequire(import.meta.url);
const { Library, M, METHODS, REQUIRED } = require('../editor-plugin/library.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ROOT = '/cam_api/aigc/v1/';
const track = (index = 1) => ({ title: `原创${index}`, vid: `770000000000000000${index}`, status: 'Success', url: `https://audio.test/${index}.mp3`, lyrics: index === 1 ? '{"lines":["冬天的风"]}' : '第二首原词\n下一行' });
const task = () => ({ status: 2, output: { music_info_list: [track(1), track(2)] } });
const mp3Meta = { codec: 'mp3', duration_s: 1.25, sample_rate: 44100, channels: 2 };

function setup(overrides = {}) {
  const calls = [], uploads = [], cdn = new Map();
  const modules = {
    [M.urls]: { Domain: { kBackendApiURL: 'https://api.test' }, DomainPath: { kActivityAPI: 'a', kTaskListAPI: 'b', kGrowthTaskList: 'c' } },
    [M.orionui]: { CookieManager: class { async getCookie() { return 'test-session'; } } },
    [M.bizUtils]: { PlatformUtils: { genSignData: () => 'signed' }, UserAgentUtils: { userAgentGenerator: () => () => 'DesktopTest' } },
    [M.activityTypes]: { getTypeName: () => '', TaskStatus: { WAIT_RECEIVE: 1, WAIT_SUBMIT: 2 }, growthTaskType: { Newbie: 0 } },
    [M.inspirationConst]: { IS_COLLECT_PARAMS_TYPE: { Default: 2 } },
    [M.inspirationBridge]: { markAgentInspirationUsed: () => {} },
    [M.uploadApi]: {
      FileType: { Picture: 1, Video: 2, Project: 3, Effect: 4, Audio: 6 },
      async uploadFileCommon(args) {
        uploads.push(args);
        if (overrides.upload) return overrides.upload(args);
        const url = `https://cdn.test/${uploads.length}`;
        cdn.set(url, fs.readFileSync(args.filePath));
        return { code: 0, data: { uri: `encrypted-${uploads.length}`, decryptedUri: `ies.fe.effect/ref-${uploads.length}`, url } };
      },
    },
  };
  const fetch = async (href, init = {}) => {
    const url = new URL(href), method = init.method || 'GET';
    const call = { url: href, method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: init.headers, body: init.body };
    calls.push(call);
    if (url.hostname === 'cdn.test') return new Response(overrides.cdnBytes ?? cdn.get(href), { status: overrides.cdnStatus ?? 200 });
    const handler = overrides[`${method} ${url.pathname}`];
    if (handler) return await handler(call);
    let data;
    if (method === 'GET' && url.pathname === ROOT + 'get_ai_music_config') data = { scene: call.query.scene, sway_offline: false };
    else if (method === 'GET' && url.pathname === '/cam_api/v2/music/genres') data = { genres: [{ genre_name: '流行', genre_code: 'Pop' }] };
    else if (method === 'POST' && url.pathname === ROOT + 'submit_ai_music_task') data = { task_id: 'ai_music_test' };
    else if (method === 'GET' && url.pathname === ROOT + 'query_ai_music_task') data = task();
    else if (method === 'POST' && url.pathname === '/cam_api/v2/music/upload_review') data = { uri: '', decrypted_uri: '', url: '' };
    else if (method === 'POST' && url.pathname === '/cam_api/pre_check/submit_task') data = { JobID: 3880056615938 };
    else if (method === 'GET' && url.pathname === '/cam_api/pre_check/performance') data = { TaskStatus: 0, Result: 0, ResourceID: 'resource', PerfList: [{ OS: 1, Result: 0 }] };
    else throw Error(`UNEXPECTED_NETWORK_ROUTE: ${method} ${url.pathname}`);
    return new Response(JSON.stringify({ code: 0, data }));
  };
  const lib = new Library(name => { if (!(name in modules)) throw Error('UNEXPECTED_MODULE:' + name); return modules[name]; }, fetch);
  return { lib, calls, uploads, modules };
}

test('audio source reads both scene configurations and genres through signed desktop requests', async () => {
  const { lib, calls } = setup();
  const data = await lib.audioSourceConfig();
  assert.deepEqual(data.modes, ['theme', 'lyrics', 'cover']);
  assert.deepEqual(data.genres, [{ name: '流行', code: 'Pop' }]);
  assert.deepEqual(calls.filter(c => c.path.endsWith('get_ai_music_config')).map(c => c.query.scene).sort(), ['AIMusicCover', 'AIMusicCreate']);
  for (const c of calls) assert.deepEqual(c.headers, { cookie: 'test-session', 'x-api-sign-data': 'signed', 'user-agent': 'DesktopTest' });
  const bad = setup({ ['GET ' + ROOT + 'get_ai_music_config']: async () => new Response('{"code":0,"data":{"scene":"wrong"}}') });
  await assert.rejects(bad.lib.audioSourceConfig(), /CONFIG_BAD_RESPONSE/);
});

test('song scope retains original-song and adaptation modes without a personal-speaker RPC', () => {
  const { lib } = setup();
  assert.equal(Object.hasOwn(METHODS, 'audio_source_speakers'), false);
  assert.equal(typeof lib.audioSourceSpeakers, 'undefined');
});

test('audio generation preserves the three verified payloads and rejects conflicting modes before network', async () => {
  const { lib, calls } = setup();
  const lyrics = '第一行\n第二行';
  for (const args of [{ mode: 'theme', idea: '冬日清晨' }, { mode: 'lyrics', lyrics }, { mode: 'cover', reference_uri: 'ies.fe.effect/own' }]) {
    const result = await lib.audioSourceGenerate({ ...args, style: 'Warm acoustic pop' });
    assert.equal(result.artwork_submitted, false);
    assert.equal(result.task_id, 'ai_music_test');
    assert.equal(result.state, 'created');
  }
  const payloads = calls.map(c => JSON.parse(c.body));
  assert.deepEqual(payloads.map(p => [p.scene, p.params.type, p.params.user_query, p.params.lyrics, p.uri_list]), [
    ['AIMusicCreate', 'prompt', '冬日清晨', '', []], ['AIMusicCreate', 'lyrics', '', lyrics, []], ['AIMusicCover', '', '', '', ['ies.fe.effect/own']],
  ]);
  for (const p of payloads) {
    assert.equal(p.params.prompt, 'Warm acoustic pop'); assert.equal(p.params.sway_prompt, p.params.prompt);
    assert.deepEqual(JSON.parse(p.params.settings), { gender: '', original_maintainance: 0, musical_style: 0, freedom: 0 });
    assert.deepEqual([p.params.single_retry, p.params.is_user_defined_prompt, p.params.copyright_retry, p.params.use_copywriting, p.vid_list], [false, true, false, false, []]);
  }
  for (const bad of [{ mode: 'submit' }, { mode: 'theme' }, { mode: 'lyrics' }, { mode: 'cover' }, { mode: 'theme', idea: 'x', lyrics: 'conflict' }]) {
    await assert.rejects(lib.audioSourceGenerate({ style: 'Pop', ...bad }), /INVALID_MODE|_REQUIRED|ARGUMENT_CONFLICT/);
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => c.method === 'POST' && c.path === ROOT + 'submit_ai_music_task'));
});

test('generation errors and missing task IDs do not silently pass or automatically create a second job', async () => {
  for (const response of [new Response('{"code":1,"message":"busy","data":{"task_id":"must-not-be-accepted"}}'), new Response('{"code":0,"data":{"task_id":"bad-http"}}', { status: 500 }), new Response('{"code":0,"data":{}}')]) {
    const s = setup({ ['POST ' + ROOT + 'submit_ai_music_task']: async () => response });
    await assert.rejects(s.lib.audioSourceGenerate({ mode: 'theme', style: 'Pop', idea: '自有原创音乐' }), /GENERATE_FAILED|RETURNED_NO_TASK/);
    assert.equal(s.calls.length, 1);
  }
});

test('advanced music settings retain native names, merge defaults and reject invalid settings before network', async () => {
  const s = setup();
  await s.lib.audioSourceGenerate({ mode: 'theme', idea: '原创', style: 'Pop', settings: { gender: 'male', original_maintainance: 25, musical_style: 50, freedom: 75 } });
  await s.lib.audioSourceGenerate({ mode: 'lyrics', lyrics: '原创歌词', style: 'Pop', settings: { gender: 'female' } });
  assert.deepEqual(JSON.parse(JSON.parse(s.calls[0].body).params.settings), { gender: 'male', original_maintainance: 25, musical_style: 50, freedom: 75 });
  assert.deepEqual(JSON.parse(JSON.parse(s.calls[1].body).params.settings), { gender: 'female', original_maintainance: 0, musical_style: 0, freedom: 0 });
  await assert.rejects(s.lib.audioSourceGenerate({ mode: 'cover', style: 'Pop', reference_uri: 'own', settings: { gender: 'female' } }), /ADVANCED_COVER_NOT_VERIFIED/);
  for (const settings of [null, [], { gender: 'unknown' }, { freedom: -1 }, { musical_style: 0.5 }, { original_maintainance: Infinity }, { submit: true }]) await assert.rejects(s.lib.audioSourceGenerate({ mode: 'theme', idea: 'x', style: 'Pop', settings }), /INVALID_SETTINGS/);
  assert.equal(s.calls.length, 2);
});

test('official beat parsing sends plain URI and preserves musical beat timestamps and values', async () => {
  const data = { bpm: 146.39105, time: [0.19, 0.59, 1], value: [1, 2, 3] };
  const s = setup({ 'POST /cam_api/v2/music/parse_beats': async () => new Response(JSON.stringify({ code: 0, data })) });
  assert.deepEqual(await s.lib.audioSourceBeats({ reference_uri: 'ies.fe.effect/own' }), { bpm: 146.39105, beats: [{ time_s: 0.19, value: 1 }, { time_s: 0.59, value: 2 }, { time_s: 1, value: 3 }], has_beats: true, artwork_submitted: false });
  assert.deepEqual(JSON.parse(s.calls[0].body), { uri: 'ies.fe.effect/own' });
  for (const bad of [{ ...data, bpm: null }, { ...data, time: [1, 0] }, { ...data, value: [] }, { ...data, time: [-1, 0.59, 1] }]) {
    const broken = setup({ 'POST /cam_api/v2/music/parse_beats': async () => new Response(JSON.stringify({ code: 0, data: bad })) });
    await assert.rejects(broken.lib.audioSourceBeats({ reference_uri: 'own' }), /BEATS_BAD_RESPONSE/);
  }
});

test('lyric alignment keeps copyright checks and converts line and word milliseconds to seconds', async () => {
  const utterances = [{ text: '原创词', start_time: 828, end_time: 1172, words: [{ text: '原', start_time: 828, end_time: 1000 }, { text: '创词', start_time: 1000, end_time: 1172 }] }];
  const data = { aligned_lyrics: '原创词', aligned_utterance: JSON.stringify({ utterances }) };
  const s = setup({ 'POST /cam_api/v2/music/align_lyric': async () => new Response(JSON.stringify({ code: 0, data })) });
  const full = await s.lib.audioSourceAlign({ audio_url: 'https://audio.test/own.mp3', lyrics: '原创词', include_words: true });
  assert.deepEqual(full.utterances, [{ text: '原创词', start_s: 0.828, end_s: 1.172, words: [{ text: '原', start_s: 0.828, end_s: 1 }, { text: '创词', start_s: 1, end_s: 1.172 }] }]);
  assert.deepEqual(JSON.parse(s.calls[0].body), { audio_url: 'https://audio.test/own.mp3', original_lyrics: '原创词', skip_copyright_check: false });
  const compact = await s.lib.audioSourceAlign({ audio_url: 'https://audio.test/own.mp3', lyrics: '原创词' });
  assert.equal(Object.hasOwn(compact.utterances[0], 'words'), false);
  for (const bad of [{}, { utterances: [] }, { utterances: [{ ...utterances[0], end_time: 0 }] }, { utterances: [{ ...utterances[0], words: [{ text: 'x', start_time: -1, end_time: 1 }] }] }]) {
    const broken = setup({ 'POST /cam_api/v2/music/align_lyric': async () => new Response(JSON.stringify({ code: 0, data: { aligned_lyrics: '词', aligned_utterance: JSON.stringify(bad) } })) });
    await assert.rejects(broken.lib.audioSourceAlign({ audio_url: 'https://audio.test/own.mp3', lyrics: '词', include_words: true }), /ALIGN_BAD_RESPONSE/);
  }
});

test('music task usability needs every Success track; failed URLs never become playable results', async () => {
  const scenarios = [
    [task(), 'succeeded', true],
    [{ status: 2, output: { music_info_list: [{ ...track(), status: 'Failed' }] } }, 'failed', false],
    [{ status: 2, output: { music_info_list: [track(), { ...track(2), status: 'Streaming' }] } }, 'incomplete', false],
    [{ status: 2, output: { music_info_list: [] } }, 'incomplete', false],
    [{ status: 1, output: { music_info_list: [] } }, 'running', false],
    [{ status: 1, output: { music_info_list: [track()] } }, 'running', false],
    [{ status: 3, task_error_code: 500, task_error_msg: 'AI服务忙', output: { music_info_list: [] } }, 'failed', false],
    [{ status: 9, output: { music_info_list: [] } }, 'unknown', false],
  ];
  for (const [data, state, usable] of scenarios) {
    const s = setup({ ['GET ' + ROOT + 'query_ai_music_task']: async () => new Response(JSON.stringify({ code: 0, data })) });
    const result = await s.lib.audioSourceTask({ task_id: 'owned-task' });
    assert.equal(result.state, state); assert.equal(result.usable, usable);
    assert.equal(result.finished, [2, 3].includes(data.status));
    for (const t of result.tracks) { assert.equal(Object.hasOwn(t, 'lyrics'), false); if (t.status !== 'Success') assert.equal(Object.hasOwn(t, 'audio_url'), false); }
    if (data.task_error_code) assert.deepEqual([result.error_code, result.error_message], [500, 'AI服务忙']);
  }
  const s = setup(); const full = await s.lib.audioSourceTask({ task_id: 'owned-task', include_lyrics: true });
  assert.equal(full.tracks[0].lyrics, track().lyrics);
  assert.equal(full.tracks[0].audio_url, track().url);
  const invalid = setup({ ['GET ' + ROOT + 'query_ai_music_task']: async () => new Response('{"code":0,"data":{"status":null}}') });
  await assert.rejects(invalid.lib.audioSourceTask({ task_id: 't' }), /TASK_BAD_RESPONSE/);
});

test('five asset kinds use the official uploader and byte-identical readback; missing and modified bytes fail', async () => {
  const dir = tmpdir('audio-uploads-'); const s = setup();
  for (const [kind, ext, type] of [['audio', 'mp3', 6], ['icon', 'png', 1], ['showcase', 'mp4', 2], ['template', 'zip', 4], ['project', 'zip', 3]]) {
    const file = path.join(dir, kind + '.' + ext); const bytes = Buffer.from('owned-' + kind); fs.writeFileSync(file, bytes);
    const result = await s.lib.audioSourceUpload({ file_path: file, kind });
    assert.deepEqual(s.uploads.at(-1), { filePath: file, fileType: type });
    assert.equal(result.sha256, sha(bytes)); assert.equal(result.hash_readback_matches, true);
    assert.equal(result.artwork_submitted, false); assert.equal(result.uri, `encrypted-${s.uploads.length}`); assert.equal(result.decrypted_uri, `ies.fe.effect/ref-${s.uploads.length}`);
  }
  const file = path.join(dir, 'audio.mp3'); const before = s.uploads.length;
  for (const bad of [{ file_path: 'relative.mp3' }, { file_path: path.join(dir, 'missing.mp3') }, { file_path: file, kind: 'submit' }, { file_path: file, kind: 'icon' }]) await assert.rejects(s.lib.audioSourceUpload(bad), /NOT_ABSOLUTE|NOT_FOUND|INVALID_ASSET_KIND|FILE_FORMAT/);
  assert.equal(s.uploads.length, before);
  const changed = setup({ cdnBytes: Buffer.from('changed bytes') });
  await assert.rejects(changed.lib.audioSourceUpload({ file_path: file }), /READBACK_HASH_MISMATCH/);
  const inaccessible = setup({ cdnStatus: 403 });
  await assert.rejects(inaccessible.lib.audioSourceUpload({ file_path: file }), /READBACK_FAILED: HTTP 403/);
  const rejected = setup({ upload: async () => ({ code: 1, message: 'rejected', data: {} }) });
  await assert.rejects(rejected.lib.audioSourceUpload({ file_path: file }), /UPLOAD_FAILED/);
  const noPlain = setup({ upload: async () => ({ code: 0, data: { uri: 'e', url: 'https://cdn.test/1' } }) });
  await assert.rejects(noPlain.lib.audioSourceUpload({ file_path: file }), /NO_REFERENCE_URI/);
  assert.ok(REQUIRED.audioSourceUpload.some(([id, key]) => id === M.uploadApi && key === 'FileType.Audio'));
});

test('audio pre-review sends an actual multipart file, returns no upload URI and never retries POST', async () => {
  const file = path.join(tmpdir('audio-review-'), '原创.mp3'), bytes = Buffer.from('owned MP3 review'); fs.writeFileSync(file, bytes);
  const s = setup(); const result = await s.lib.audioSourceReview({ file_path: file });
  const request = s.calls[0]; const uploaded = request.body.get('file');
  assert.ok(request.body instanceof FormData); assert.equal(request.headers['content-type'], undefined);
  assert.equal(uploaded.name, '原创.mp3'); assert.equal(uploaded.type, 'audio/mpeg');
  assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), bytes);
  assert.deepEqual(result, { file_path: file, passed: true, review_only: true, artwork_submitted: false });
  for (const response of [new Response('{"code":1,"message":"busy"}'), new Response('{"code":0,"data":{}}', { status: 500 })]) {
    const failed = setup({ 'POST /cam_api/v2/music/upload_review': async () => response });
    await assert.rejects(failed.lib.audioSourceReview({ file_path: file }), /REVIEW_FAILED/);
    assert.equal(failed.calls.length, 1);
  }
  const empty = path.join(path.dirname(file), 'empty.mp3'); fs.writeFileSync(empty, '');
  await assert.rejects(s.lib.audioSourceReview({ file_path: empty }), /FILE_EMPTY/);
  assert.equal(s.calls.length, 1);
});

test('template check uses native Source 6 and requires completed real performance results', async () => {
  const s = setup(); const started = await s.lib.audioSourceCheckStart({ name: '原声音源', template_uri: 'encrypted-template', icon_uri: 'encrypted-icon' });
  assert.equal(started.job_id, '3880056615938'); assert.equal(started.artwork_submitted, false);
  assert.deepEqual(JSON.parse(s.calls[0].body), { TaskType: 2, ArtworkType: 2, Source: 6, PreCheckPayload: { EncryptedFileURI: 'encrypted-template', ArtworkName: '原声音源', EncryptedIconURI: 'encrypted-icon', EncryptedCoverURI: 'encrypted-icon' } });
  const checked = await s.lib.audioSourceCheckTask({ job_id: started.job_id });
  assert.equal(checked.passed, true); assert.equal(checked.media_integrity_verified, false);
  assert.equal(checked.scope, 'template_performance_only');
  assert.deepEqual(s.calls[1].query, { JobID: started.job_id, ArtworkType: '2' });
  for (const data of [{ TaskStatus: 1, Result: 0, ResourceID: 'r', PerfList: [{ Result: 0 }] }, { TaskStatus: 0, Result: 1, ResourceID: 'r', PerfList: [{ Result: 0 }] }, { TaskStatus: 0, Result: 0, ResourceID: 'r', PerfList: [] }, { TaskStatus: 0, Result: 0, ResourceID: 'r', PerfList: [{ Result: 1 }] }]) {
    const bad = setup({ 'GET /cam_api/pre_check/performance': async () => new Response(JSON.stringify({ code: 0, data: { ...data, passed: true } })) });
    assert.equal((await bad.lib.audioSourceCheckTask({ job_id: '1' })).passed, false);
  }
  await assert.rejects(s.lib.audioSourceCheckStart({ template_uri: 't', icon_uri: 'i' }), /NAME_REQUIRED/);
});

test('local asset checks decode PNG/MP3/video and test ZIP contents before any remote upload', async () => {
  const dir = tmpdir('audio-files-'); const audio = path.join(dir, 'a.mp3'); fs.writeFileSync(audio, 'owned audio');
  assert.equal((await validateAudioSourceAsset({ file_path: audio }, { audioProbe: async () => mp3Meta })).codec, 'mp3');
  await assert.rejects(validateAudioSourceAsset({ file_path: audio }, { audioProbe: async () => ({ codec: 'aac', duration_s: 1 }) }), /MP3_REQUIRED/);
  const icon = path.join(dir, 'icon.png'); fs.writeFileSync(icon, PNG.sync.write(new PNG({ width: 2, height: 3 })));
  assert.deepEqual(await validateAudioSourceAsset({ file_path: icon, kind: 'icon' }), { bytes: fs.statSync(icon).size, width: 2, height: 3, format: 'png' });
  const brokenIcon = path.join(dir, 'bad.png'); fs.writeFileSync(brokenIcon, 'invalid PNG');
  await assert.rejects(validateAudioSourceAsset({ file_path: brokenIcon, kind: 'icon' }));
  const video = path.join(dir, 'show.mp4'); fs.writeFileSync(video, 'video fixture');
  await assert.rejects(validateAudioSourceAsset({ file_path: video, kind: 'showcase' }, { videoProbe: async () => ({ has_audio: false }) }), /SHOWCASE_NEEDS_AUDIO/);
  const zip = path.join(dir, 'source.zip'); execFileSync('/usr/bin/zip', ['-q', zip, 'a.mp3'], { cwd: dir });
  assert.equal((await validateAudioSourceAsset({ file_path: zip, kind: 'project' })).zip_integrity, true);
  const badZip = path.join(dir, 'broken.zip'); fs.writeFileSync(badZip, 'not a ZIP');
  await assert.rejects(validateAudioSourceAsset({ file_path: badZip, kind: 'project' }));
});

test('task download saves real bytes, hashes, both lyric formats and rejects unreadable media', async () => {
  const dir = tmpdir('audio-downloads-'); const result = await setup().lib.audioSourceTask({ task_id: 't', include_lyrics: true });
  const bytes = Buffer.from('owned downloaded fixture');
  const saved = await saveAudioSourceTask(result, dir, { fetchImpl: async () => new Response(bytes), audioProbe: async file => { assert.deepEqual(fs.readFileSync(file), bytes); return mp3Meta; } });
  assert.equal(saved.status, 'saved'); assert.equal(saved.files.length, 2);
  assert.equal(saved.files[0].sha256, sha(bytes)); assert.equal(saved.files[0].codec, 'mp3');
  assert.deepEqual(JSON.parse(fs.readFileSync(saved.files[0].lyrics_file)), { lines: ['冬天的风'] });
  assert.ok(saved.files[0].lyrics_file.endsWith('.lyrics.json'));
  assert.equal(fs.readFileSync(saved.files[1].lyrics_file, 'utf8'), '第二首原词\n下一行');
  assert.ok(saved.files[1].lyrics_file.endsWith('.lyrics.txt'));
  assert.equal(JSON.parse(fs.readFileSync(saved.metadata_file)).task_id, 't');
  for (const props of [{ fetchImpl: async () => new Response('forbidden page', { status: 403 }), audioProbe: async () => mp3Meta }, { fetchImpl: async () => new Response(''), audioProbe: async () => mp3Meta }, { fetchImpl: async () => new Response(bytes), audioProbe: async () => ({ codec: 'aac', duration_s: 1 }) }]) {
    const out = path.join(dir, 'bad-' + fs.readdirSync(dir).length); await assert.rejects(saveAudioSourceTask(result, out, props), /DOWNLOAD_FAILED|DOWNLOAD_EMPTY|NOT_MP3/); assert.deepEqual(fs.readdirSync(out), []);
  }
});

test('running, failed and incomplete jobs never download URLs or leave an ambiguous silent skip', async () => {
  for (const [state, finished, expected] of [['running', false, 'not_ready'], ['failed', true, 'refused_failed_task'], ['incomplete', true, 'refused_incomplete_task']]) {
    const destination = path.join(tmpdir('audio-no-download-'), 'out'); let fetched = false;
    const result = await saveAudioSourceTask({ usable: false, state, finished, tracks: [track()] }, destination, { fetchImpl: async () => { fetched = true; throw Error('MUST_NOT_FETCH'); } });
    assert.equal(result.status, expected); assert.equal(fetched, false); assert.equal(fs.existsSync(destination), false);
  }
});

test('compact MCP exposes audio preparation tools and rejects incomplete publication requests', async () => {
  const s = setup(), seen = [], dir = tmpdir('audio-source-mcp-');
  const file = path.join(dir, 'own.mp3'); fs.writeFileSync(file, 'owned MCP input');
  const server = createServer({
    flatTools: false, official: { listTools: async () => [], status: () => ({ connected: false }) }, listInstances: () => [{ pid: 22 }, { pid: 11 }],
    callPlugin: async (method, args, options) => { seen.push({ method, args, options }); if (!METHODS[method]) throw Error('UNKNOWN_RPC'); return s.lib[METHODS[method]](args); },
    validateAudioSourceAsset: args => validateAudioSourceAsset(args, { audioProbe: async file => file.endsWith('wrongcodec.mp3') ? { codec: 'aac', duration_s: 1 } : mp3Meta }),
    saveAudioSourceTask: (data, folder) => saveAudioSourceTask(data, folder, { fetchImpl: async () => new Response('owned generated audio'), audioProbe: async () => mp3Meta }),
  });
  const client = new Client({ name: 'codex', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name, args) => { const response = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } }); if (response.isError) throw Error(response.content[0].text); return JSON.parse(response.content[0].text); };
    for (const name of ['audio_source_config', 'audio_source_generate', 'audio_source_task', 'audio_source_upload', 'audio_source_review', 'audio_source_package_check']) {
      const response = await client.callTool({ name: 'tool_describe', arguments: { name } }); assert.equal(response.isError, undefined); assert.equal(JSON.parse(response.content[0].text).name, name);
    }
    assert.equal((await call('audio_source_config', {})).genres[0].code, 'Pop');
    assert.equal((await call('audio_source_generate', { mode: 'theme', style: 'Pop', idea: '冬日原创' })).task_id, 'ai_music_test');
    const result = await call('audio_source_task', { task_id: 'ai_music_test', save_to: dir });
    assert.equal(result.usable, true); assert.equal(result.download.status, 'saved');
    assert.ok(fs.existsSync(result.download.files[0].lyrics_file));
    assert.equal(Object.hasOwn(result.tracks[0], 'lyrics'), false); assert.match(result.tracks[0].audio_ref, /^audio:/);
    assert.equal((await call('audio_source_upload', { file_path: file })).hash_readback_matches, true);
    assert.equal((await call('audio_source_review', { file_path: file })).passed, true);
    const check = await call('audio_source_package_check', { action: 'start', name: 'owned', template_uri: 't', icon_uri: 'i' });
    assert.equal((await call('audio_source_package_check', { action: 'query', job_id: check.job_id })).passed, true);
    assert.ok(seen.every(c => c.options.pid === 11));
    const before = s.calls.length;
    for (const args of [{ name: 'audio_source_speakers', arguments: {} }, { name: 'audio_source_tts', arguments: {} }, { name: 'audio_source_clone', arguments: {} }, { name: 'audio_source_submit', arguments: {} }, { name: 'audio_source_generate', arguments: { mode: 'theme', style: 'Pop', idea: 'x', submit: true } }, { name: 'audio_source_package_check', arguments: { action: 'submit' } }]) {
      const bad = await client.callTool({ name: 'tool_call', arguments: args }); assert.equal(bad.isError, true);
    }
    assert.equal(s.calls.length, before, 'invalid publication requests never reach any network call');
    const wrongCodec = path.join(dir, 'wrongcodec.mp3'); fs.writeFileSync(wrongCodec, 'incorrect codec');
    for (const name of ['audio_source_upload', 'audio_source_review']) {
      const bad = await client.callTool({ name: 'tool_call', arguments: { name, arguments: { file_path: wrongCodec } } }); assert.equal(bad.isError, true);
    }
    for (const args of [{ action: 'start', job_id: '1', name: 'n', template_uri: 't', icon_uri: 'i' }, { action: 'query', job_id: '1', template_uri: 't' }]) {
      const bad = await client.callTool({ name: 'tool_call', arguments: { name: 'audio_source_package_check', arguments: args } }); assert.equal(bad.isError, true);
    }
    assert.equal(s.calls.length, before, 'local codec and action validation precedes remote calls');
    assert.ok(s.calls.every(c => !['/effectcam/v1/submit', '/creator/v1/submit', '/creator_api/artwork/v1/submit', '/web_api/artwork/v1/submit'].includes(c.path)));
  } finally { await client.close(); await server.close(); }
});
