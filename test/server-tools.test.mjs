import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { FONT, frameFile } from './drawing.mjs';

// Tests of the tools added for the project scripts (icons, sounds, UI images, preview models, scene
// layers) and for the 9.8.3 panels and agent commands (画面特效, 实时变脸, image editor, preview input).

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]).toString('base64');

function official() {
  return {
    url: 'http://official',
    listTools: async () => [],
    status: () => ({ connected: true }),
    callTool: async () => ({ content: [] }),
    callJson: async (name) => {
      if (name === 'list_instances') return { instances: [{ instance_id: '1', generation: '7-1', project_path: '/proj/A' }] };
      throw Error(`unexpected ${name}`);
    },
  };
}

async function connect({ plugin = async () => ({}), ...deps } = {}) {
  const seen = [];
  const callPlugin = async (method, params, opts) => {
    seen.push({ method, params, opts });
    return plugin(method, params, opts);
  };
  const server = createServer({ official: official(), callPlugin, listInstances: () => [{ pid: 7 }], frontApp: async () => null, sleep: async () => {}, ...deps });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => client.callTool({ name, arguments: args });
  const json = async (name, args) => {
    const res = await call(name, args);
    if (res.isError) throw Error(res.content[0].text);
    return JSON.parse(res.content[0].text);
  };
  return { call, json, seen };
}

test('icon_compose writes the icons, their thumbnails and a list-size comparison sheet, and shows them', async () => {
  const dir = tmpdir('xs-tools-');
  const frame = await frameFile(dir);
  const out = path.join(dir, 'icons');
  const { call } = await connect();
  const res = await call('icon_compose', {
    sources: [
      { frame, crop: { top: 0 }, caption: { text: '测试字幕', font: FONT, size: 60, stroke: { color: '#000000', width: 4 } }, name: 'icon_f' },
      { frame, crop: { x: 80, y: 680, size: 200 } },
    ],
    size: 360,
    out_dir: out,
    compare_images: [frame],
  });
  assert.equal(res.isError, undefined, res.content[0].text);
  const summary = JSON.parse(res.content[0].text);
  assert.deepEqual(summary.icons.map((i) => [path.basename(i.file), path.basename(i.thumb_file), i.size]), [['icon_f.png', 'icon_f_160.png', 360], ['icon_2.png', 'icon_2_160.png', 360]]);
  for (const f of [...summary.icons.flatMap((i) => [i.file, i.thumb_file]), summary.sheet_file]) assert.ok(fs.statSync(f).size > 0, f);
  assert.equal(summary.note_files, undefined, 'files under out_dir are kept');
  assert.deepEqual(res.content.filter((c) => c.type === 'image').length, 3, 'the sheet and a 360 preview of each icon');
  const bad = await call('icon_compose', { sources: [{ frame, crop: { top: 900 } }] });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /CROP_OUT_OF_FRAME/);
  const badName = await call('icon_compose', { sources: [{ frame, crop: { top: 0 }, name: '../x' }] });
  assert.match(badName.content[0].text, /INVALID_ARGUMENTS\(icon_compose\)/);
});

test('sfx_synth, ui_text_image and ui_panel write their files into out_dir and report sizes', async () => {
  const dir = tmpdir('xs-tools-');
  const encoded = [];
  const { json, call } = await connect({ writeSound: async (samples, file) => (encoded.push(path.basename(file)), fs.writeFileSync(file, Buffer.alloc(samples.length))) });
  const sfx = await json('sfx_synth', { out_dir: dir, sounds: [{ preset: 'ding', file: 'sfx_ding.mp3' }, { preset: 'pop', file: 'pop.wav', pitch: 1.5, volume: 0.3 }] });
  assert.deepEqual(encoded, ['sfx_ding.mp3', 'pop.wav']);
  assert.deepEqual(sfx.sounds.map((s) => [path.basename(s.file), s.seconds, s.peak]), [['sfx_ding.mp3', 1, 0.5], ['pop.wav', 0.16, 0.3]]);
  assert.match((await call('sfx_synth', { out_dir: dir, sounds: [{ preset: 'meow', file: 'a.mp3' }] })).content[0].text, /INVALID_ARGUMENTS\(sfx_synth\): sounds\.0\.preset/);

  const txt = await connect();
  const t = await txt.call('ui_text_image', { out_dir: dir, items: [{ file: 'digit_1.png', text: '1', font: FONT, size: 64, gradient: ['#ffffff', '#ffcc00'], stroke: { color: '#802010', width: 6 }, shadow: {} }] });
  const ti = JSON.parse(t.content[0].text).images[0];
  assert.ok(ti.width > 40 && ti.height > 60 && fs.existsSync(ti.file));
  assert.equal(t.content.filter((c) => c.type === 'image').length, 1);
  assert.match((await txt.call('ui_text_image', { out_dir: dir, items: [{ file: 'a.png', text: 'A', size: 20, fill: 'red' }] })).content[0].text, /INVALID_ARGUMENTS\(ui_text_image\): items\.0\.fill 颜色写/);
  const p = JSON.parse((await txt.call('ui_panel', { out_dir: dir, items: [{ file: 'hint.png', radius: 'pill', fill: '#121c2e96', lines: [{ text: '双手入镜', font: FONT, size: 40 }] }, { file: 'card.png', width: 300, height: 120 }] })).content[0].text).images;
  assert.deepEqual(p.map((x) => path.basename(x.file)), ['hint.png', 'card.png']);
  assert.deepEqual([p[1].width, p[1].height], [300, 120]);
});

test('preview_model_add hands the request to the preview model writer; scene_set_layer refuses a project that is open', async () => {
  const got = [];
  const { json, call } = await connect({
    addPreviewModel: async (a) => (got.push(a), { name: a.name, files: {} }),
    plugin: async (method) => (method === 'status' ? { projectPath: '/proj/Open' } : {}),
  });
  await json('preview_model_add', { name: '模特W||女', file_name: 'model_w', image: '/p/w.png' });
  assert.deepEqual(got, [{ name: '模特W||女', file_name: 'model_w', image: '/p/w.png' }]);
  assert.match((await call('preview_model_add', { name: 'x', file_name: 'Bad-Name', image: '/p/w.png' })).content[0].text, /INVALID_ARGUMENTS/);
  const open = await call('scene_set_layer', { project_dir: '/proj/Open', objects: [{ object: '笔刷0', layer: 1 }] });
  assert.equal(open.isError, true);
  assert.match(open.content[0].text, /PROJECT_OPEN: \/proj\/Open is open in an editor window/);
});

test('preview_audio_test opens the session, feeds each step while taking frames, and always clears and closes it', async () => {
  const order = [];
  const plugin = async (method, params) => {
    order.push(method === 'preview_audio_input' ? (params.clear ? 'clear' : ['input', params.input, params.duration_ms]) : method === 'preview_audio_session' ? `session:${params.action}` : method === 'preview_full_rate' ? `rate:${params.hold_ms > 0 ? 'hold' : 'release'}` : method);
    if (method === 'preview_frame') return { data: JPEG, mimeType: 'image/jpeg' };
    if (method === 'preview_audio_session') return params.action === 'start' ? { started: true, active: true } : { restored: true, active: false };
    return {};
  };
  const { call } = await connect({ plugin });
  const res = await call('preview_audio_test', { project_path: '/proj/A', steps: [{ volume: 0.12, duration_ms: 300, frames: 2 }, { keywords: ['开门'], duration_ms: 200, frames: 0 }, { keyword_miss: true, pitch_hz: 200, duration_ms: 100, frames: 1 }], save_to: tmpdir('xs-audio-') });
  assert.equal(res.isError, undefined, res.content[0].text);
  assert.deepEqual(order, [
    'rate:hold',
    'session:start',
    ['input', { volume: 0.12 }, 300],
    'preview_frame',
    'preview_frame',
    ['input', { keywordEvent: { type: 'hit', keywords: ['开门'] } }, 200],
    ['input', { pitchHz: 200, keywordEvent: { type: 'miss' } }, 100],
    'preview_frame',
    'clear',
    'session:stop',
    'rate:release',
  ]);
  const summary = JSON.parse(res.content[0].text);
  assert.deepEqual(summary.steps.map((s) => s.frames.length), [2, 0, 1]);
  assert.deepEqual(summary.session_stopped, { restored: true, active: false });
  assert.equal(res.content.filter((c) => c.type === 'image').length, 3);

  order.length = 0;
  const failing = await connect({ plugin: async (m, p) => (m === 'preview_frame' ? Promise.reject(Error('NO_FRESH_PREVIEW_FRAME')) : plugin(m, p)) });
  const bad = await failing.call('preview_audio_test', { project_path: '/proj/A', steps: [{ volume: 0.1, duration_ms: 100 }] });
  assert.match(bad.content[0].text, /NO_FRESH_PREVIEW_FRAME/);
  assert.deepEqual(order.slice(-3), ['clear', 'session:stop', 'rate:release'], 'the session is closed even when a frame fails');
  assert.match((await failing.call('preview_audio_test', { steps: [{ duration_ms: 100 }] })).content[0].text, /steps\[0\] needs volume, pitch_hz, keywords or keyword_miss/);
  assert.match((await failing.call('preview_audio_test', { steps: [{ keywords: ['a'], keyword_miss: true, duration_ms: 100 }] })).content[0].text, /has both keywords and keyword_miss/);
});

test('the 9.8.3 panel and agent tools route to the right window with their timeouts', async () => {
  const { json, call, seen } = await connect({
    plugin: async (method) => (method === 'custom_gan_tasks' ? { items: [{ task_id: 't1', female_image_url: 'https://out/f.png', video_female_url: 'https://v/f.mp4' }] } : { ok: method }),
  });
  await json('ai_vfx_submit', { prompt: '金色光环', duration_s: 6 });
  assert.deepEqual(seen.at(-1), { method: 'ai_vfx_submit', params: { prompt: '金色光环', duration_s: 6 }, opts: { pid: 7, timeoutMs: 1100000 } });
  await json('ai_vfx_tasks', { task_id: 'wf1', wait_s: 30 });
  assert.deepEqual(seen.at(-1), { method: 'ai_vfx_task', params: { task_id: 'wf1', wait_s: 30 }, opts: { pid: 7, timeoutMs: 150000 } });
  assert.match((await call('ai_vfx_tasks', { wait_s: 3 })).content[0].text, /wait_s only applies together with task_id/);
  await json('ai_vfx_import', { project_path: '/proj/B', task_id: 'wf1' });
  assert.deepEqual(seen.at(-1), { method: 'ai_vfx_import', params: { task_id: 'wf1' }, opts: { projectPath: '/proj/B', timeoutMs: 300000 } });
  const tasks = await json('custom_gan_tasks', {});
  assert.match(tasks.items[0].female_image_ref, /^img:\d+$/);
  assert.match(tasks.items[0].video_female_ref, /^video:\d+$/);
  assert.match((await call('custom_gan_train', { task_id: 't1', selected: [1, 2] })).content[0].text, /INVALID_ARGUMENTS\(custom_gan_train\): selected/);
  await json('custom_gan_import', { project_path: '/proj/B', task_id: 't1' });
  assert.deepEqual(seen.at(-1).opts, { projectPath: '/proj/B', timeoutMs: 600000 });
  await json('preview_actions', { project_path: '/proj/B', commands: [{ command_type: 'seek_to_time', params: { time_ms: 800 } }] });
  assert.deepEqual(seen.at(-1), { method: 'preview_actions', params: { commands: [{ command_type: 'seek_to_time', params: { time_ms: 800 } }] }, opts: { projectPath: '/proj/B', timeoutMs: 30000 } });
  assert.match((await call('preview_actions', { commands: [{ command_type: 'screenshot', params: {} }] })).content[0].text, /INVALID_ARGUMENTS\(preview_actions\)/);
});

test('image tools copy the editor result out of its cache; repaint sends the marked image', async () => {
  const dir = tmpdir('xs-tools-');
  const frame = await frameFile(dir);
  const cache = tmpdir('xs-editor-cache-');
  const result = path.join(cache, 'ai_AIMattingGenPC_1.png');
  fs.copyFileSync(frame, result);
  const parts = { subject: path.join(cache, 'subject.png'), hair: path.join(cache, 'hair.png') };
  for (const p of Object.values(parts)) fs.copyFileSync(frame, p);
  const { call, seen } = await connect({
    plugin: async (method) => (method === 'image_matting' ? { parts, folder: cache } : method === 'image_repaint' ? { output: result, mode: 'remove' } : { output: result }),
  });
  const out = path.join(dir, 'out');
  const up = await call('image_upscale', { image_path: frame, out_dir: out });
  assert.equal(JSON.parse(up.content[0].text).file, path.join(out, 'frame_upscaled.png'));
  assert.equal(up.content[1].type, 'image');
  assert.deepEqual(seen.at(-1).opts, { pid: 7, timeoutMs: 180000 });

  const rep = await call('image_repaint', { image_path: frame, boxes: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.1 }], out_dir: out });
  const r = JSON.parse(rep.content[0].text);
  assert.equal(seen.at(-1).params.image_path, path.join(out, 'frame_marked.png'), 'the plugin gets the marked copy');
  assert.equal(r.file, path.join(out, 'frame_removed.png'));
  assert.equal(r.marked_ratio, 0.02);
  assert.match((await call('image_repaint', { image_path: frame })).content[0].text, /mark the area with mask or boxes/);

  const mat = await call('image_matting', { image_path: frame, out_dir: out });
  assert.deepEqual(JSON.parse(mat.content[0].text).files, { subject: path.join(out, 'frame_subject.png'), hair: path.join(out, 'frame_hair.png') });
  assert.ok(fs.existsSync(path.join(out, 'frame_hair.png')));
});
