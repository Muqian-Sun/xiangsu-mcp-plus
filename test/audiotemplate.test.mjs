import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { prepareAudioTemplate } from '../src/audiotemplate.mjs';
import { createServer } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const entry = (zip, file) => execFileSync('/usr/bin/unzip', ['-p', zip, file]);
const json = (zip, file) => JSON.parse(entry(zip, file));

// This test covers the archive contract. Actual MP3 decoding and the native cloud reader are
// exercised separately with real self-generated audio; the probe is the only stub here.
test('native audio archives contain a resolvable audio graph, portable source draft and original bytes', async () => {
  const directory = tmpdir('audio-native-');
  for (const [index, duration] of [0.4, 57.182].entries()) {
    const input = path.join(directory, `原声 ${index}.mp3`);
    const bytes = Buffer.from(`owned fixture ${index}`);
    fs.writeFileSync(input, bytes);
    const out = await prepareAudioTemplate({ audio_path: input, out_dir: directory, name: `测试 ${index}` }, {
      probe: async file => { assert.equal(file, input); return { codec: 'mp3', duration_s: duration, sample_rate: 44100, channels: 2 }; },
    });
    const expectedDuration = Math.round(duration * 1e6);
    assert.equal(out.artwork_type, 14);
    assert.equal(out.submitted, false);
    assert.equal(out.validation.cloud_precheck, 'not_run');
    assert.equal(out.validation.source_sdk_reopen, 'not_run');
    assert.equal(out.audio.duration_us, expectedDuration);
    assert.equal(out.audio.sha256, sha(bytes));
    const template = json(out.template_zip, 'NLETemplate.json');
    const model = template._objects[template._templateModel];
    assert.equal(model._class, 'NLETemplateModel');
    const tracks = model._arrays.Track.map(id => template._objects[id]);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0]._extras._trackType, '1');
    const slot = template._objects[tracks[0]._arrays.Slot[0]];
    const segment = template._objects[slot._objects.MainSegment];
    const resource = template._objects[segment._objects.AVFile];
    assert.equal(segment._class, 'NLESegmentAudio');
    assert.equal(resource.ResourceType, 3);
    assert.deepEqual([slot.StartTime, slot.EndTime, segment.TimeClipStart, segment.TimeClipEnd, resource.Duration], [0, expectedDuration, 0, expectedDuration, expectedDuration]);
    assert.deepEqual(entry(out.template_zip, resource.ResourceFile), bytes);
    assert.equal(path.isAbsolute(resource.ResourceFile), false);
    const config = json(out.template_zip, 'config.json');
    assert.equal(config.temple_info.type, 2, 'package type belongs to the NLE protocol');
    assert.equal(config.temple_info.path, 'NLETemplate.json');
    assert.deepEqual(config.temple_info.feature, template._features);
    const music = json(out.template_zip, 'extra.json').tool_music;
    assert.deepEqual(music.use_music_ids, []);
    assert.deepEqual(music.use_local_audios, [{ path: path.basename(resource.ResourceFile), start: 0, duration, volume: 1, is_loop: false, exclude_music: true }]);
    assert.deepEqual(json(out.template_zip, 'templateExtra.json'), {});
    assert.deepEqual(json(out.template_zip, 'capabilities.json').contentFeature, [['Audio_BackgroundMusic', 'VideoTemplate']]);

    const meta = json(out.project_zip, 'customInfo.json');
    assert.equal(meta.draftType, 14);
    assert.equal(meta.versionCode, 106);
    assert.equal(meta.name, `测试 ${index}`);
    assert.deepEqual([meta.draftPath, meta.templateModelPath, meta.creationDataPath], ['', '', '']);
    assert.deepEqual(json(out.project_zip, 'featureList.json'), { ckeFeature: [], nleFeature: ['E', 'T_Base'] });
    assert.deepEqual(json(out.project_zip, 'customExtra.json'), {});
    const draft = json(out.project_zip, 'nle/nle_draft.json');
    assert.deepEqual(draft._features, ['E', 'T_Base']);
    const sourceInfo = Object.values(draft._objects).find(n => n._class === 'TemplateInfo');
    assert.deepEqual(sourceInfo._features, ['E', 'T_Base']);
    assert.equal(Object.hasOwn(sourceInfo, 'Editable'), false);
    const draftResource = Object.values(draft._objects).find(n => n._class === 'NLEResourceAV');
    assert.deepEqual(entry(out.project_zip, `nle/${draftResource.ResourceFile}`), bytes);
    assert.equal(path.isAbsolute(draftResource.ResourceFile), false);
    assert.deepEqual(entry(out.project_zip, 'EcTemplate.zip'), fs.readFileSync(out.template_zip));
    for (const p of out.packages) assert.deepEqual([p.bytes, p.sha256], [fs.statSync(p.file).size, sha(fs.readFileSync(p.file))]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out.directory, 'manifest.json'))), out);
  }
});

test('unsupported inputs fail before creating output and existing destination files survive', async () => {
  const directory = tmpdir('audio-native-errors-');
  const input = path.join(directory, 'input.wav');
  fs.writeFileSync(input, 'fixture');
  const out = path.join(directory, 'out');
  await assert.rejects(prepareAudioTemplate({ audio_path: 'relative.mp3', out_dir: out }), /ABSOLUTE_PATHS_REQUIRED/);
  await assert.rejects(prepareAudioTemplate({ audio_path: input, out_dir: out, name: '  ' }), /NAME_REQUIRED/);
  await assert.rejects(prepareAudioTemplate({ audio_path: input, out_dir: out }, { probe: async () => ({ codec: 'wav', duration_s: 1 }) }), /MP3_REQUIRED/);
  await assert.rejects(prepareAudioTemplate({ audio_path: input, out_dir: out }, { probe: async () => ({ codec: 'mp3', duration_s: 0 }) }), /INVALID_DURATION/);
  assert.equal(fs.existsSync(out), false);
  // Force the output directory creation itself to fail; the caller's file must survive unchanged.
  fs.writeFileSync(out, 'keep me');
  await assert.rejects(prepareAudioTemplate({ audio_path: input, out_dir: out }, { probe: async () => ({ codec: 'mp3', duration_s: 1 }) }), /EEXIST/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'keep me');
});

test('missing or corrupted archived audio is rejected and no partial package is returned', async () => {
  const directory = tmpdir('audio-native-archive-errors-');
  const input = path.join(directory, 'input.mp3');
  fs.writeFileSync(input, 'owned original audio bytes');
  for (const fault of ['missing', 'corrupt']) {
    const destination = path.join(directory, fault);
    let injected = false;
    const pack = async (source, archive) => {
      if (path.basename(archive) === 'AudioTemplate.zip') {
        const model = JSON.parse(fs.readFileSync(path.join(source, 'NLETemplate.json')));
        const resource = Object.values(model._objects).find(n => n._class === 'NLEResourceAV').ResourceFile;
        const file = path.join(source, resource);
        if (fault === 'missing') {
          fs.unlinkSync(file);
          assert.equal(fs.existsSync(file), false, 'missing resource injection took effect');
        } else {
          fs.writeFileSync(file, 'corrupted archive bytes');
          assert.notDeepEqual(fs.readFileSync(file), fs.readFileSync(input), 'corruption injection took effect');
        }
        injected = true;
      }
      execFileSync('/usr/bin/zip', ['-q', '-r', archive, '.'], { cwd: source });
    };
    await assert.rejects(prepareAudioTemplate({ audio_path: input, out_dir: destination }, {
      probe: async () => ({ codec: 'mp3', duration_s: 1, channels: 2, sample_rate: 44100 }), pack,
    }), fault === 'missing' ? /filename not matched/ : /CONTENT_MISMATCH/);
    assert.equal(injected, true);
    assert.deepEqual(fs.readdirSync(destination), [], 'failed output was removed');
  }
});

test('MCP discovers and executes the native audio tool without an editor call', async () => {
  const calls = [];
  const directory = tmpdir('audio-native-mcp-');
  const input = path.join(directory, 'input.mp3');
  const bytes = Buffer.from('owned MCP input');
  fs.writeFileSync(input, bytes);
  let received;
  const server = createServer({
    flatTools: true, official: { listTools: async () => [] },
    callPlugin: async (...args) => { calls.push(args); throw Error('UNEXPECTED_EDITOR_CALL'); },
    prepareAudioTemplate: args => { received = args; return prepareAudioTemplate(args, { probe: async () => ({ codec: 'mp3', duration_s: 1, channels: 2, sample_rate: 44100 }) }); },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'audio-native-test', version: '1' });
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = await client.listTools();
    const tool = tools.tools.find(t => t.name === 'audio_template_prepare');
    assert.ok(tool, 'registered MCP entry');
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['audio_path', 'clips', 'name', 'out_dir']);
    const result = await client.callTool({ name: 'audio_template_prepare', arguments: { audio_path: 'relative.mp3', out_dir: tmpdir('audio-native-mcp-') } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /INVALID_ARGUMENTS/);
    const args = { audio_path: input, out_dir: directory, name: 'MCP原声' };
    const prepared = await client.callTool({ name: 'audio_template_prepare', arguments: args });
    assert.equal(prepared.isError, undefined, prepared.content[0].text);
    const output = JSON.parse(prepared.content[0].text);
    assert.deepEqual(received, args);
    assert.equal(output.audio.sha256, sha(bytes));
    assert.equal(json(output.project_zip, 'customInfo.json').name, args.name);
    assert.deepEqual(calls, []);
  } finally {
    await client.close();
    await server.close();
  }
});
