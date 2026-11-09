import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.mjs';
import { fetchImage, readImageFile } from '../src/images.mjs';
import { MediaRefs } from '../src/outputs.mjs';

const OWN = [
  'ai3d_animation_submit',
  'ai3d_cancel',
  'ai3d_gs_segment',
  'ai3d_gs_submit',
  'ai3d_image_submit',
  'ai3d_import',
  'ai3d_tasks',
  'ai_combine_apply',
  'ai_combine_new',
  'ar_video_cancel',
  'ar_video_import',
  'ar_video_submit',
  'ar_video_tasks',
  'baidu_hot_list',
  'bilibili_hot_search',
  'bilibili_popular',
  'douyin_hot_detail',
  'douyin_hot_list',
  'douyin_hot_videos',
  'effect_check',
  'ext_status',
  'face_warp_list',
  'face_warp_set_intensity',
  'growth_route',
  'icon_open',
  'icon_set',
  'image_view',
  'inspect_many',
  'inspiration_bind',
  'inspiration_collect',
  'inspiration_detail',
  'inspiration_list',
  'library_apply',
  'library_images',
  'library_list',
  'library_search',
  'makeup_calibrate',
  'makeup_compare',
  'makeup_eye',
  'makeup_layers',
  'makeup_texture',
  'menu_add',
  'menu_list',
  'messages_list',
  'mobile_preview',
  'music_apply',
  'music_list',
  'my_effect_data',
  'my_effect_revenue',
  'my_effect_reviews',
  'my_effect_trend',
  'my_effects',
  'my_profile',
  'my_revenue',
  'my_task_status',
  'object_remove',
  'preview_frames',
  'project_close',
  'project_new',
  'project_open',
  'rank_hotspots',
  'rank_innovation',
  'rank_list',
  'rank_subjects',
  'resource_delete_unused',
  'scene_tree',
  'submit_prepare',
  'task_bind',
  'task_detail',
  'task_receive',
  'tasks_list',
  'works_by_effect',
  'works_cleanup',
  'works_download',
  'works_list',
  'works_open',
  'works_search',
];

function fakeOfficial({ tools = [{ name: 'get_scene', description: 'official', inputSchema: { type: 'object' } }], call } = {}) {
  const seen = [];
  return {
    seen,
    url: 'http://official',
    listTools: async () => tools,
    status: () => ({ connected: true, tools: tools.length }),
    callTool: async (name, args) => {
      seen.push([name, args]);
      if (call) return call(name, args);
      return { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }] };
    },
    callJson: async (name) => {
      seen.push([name]);
      if (name === 'list_instances') return { instances: [{ instance_id: '1', generation: '100-1', project_path: '/proj/A' }] };
      throw Error(`unexpected ${name}`);
    },
  };
}

async function connect(deps) {
  const server = createServer(deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, server };
}

test('lists own tools plus the official tools, own names first', async () => {
  const { client } = await connect({ official: fakeOfficial(), callPlugin: async () => ({}) });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).slice(0, OWN.length).sort(), OWN);
  assert.equal(tools.at(-1).name, 'get_scene');
  assert.equal(tools.find((t) => t.name === 'library_apply').inputSchema.type, 'object');
});

test('official tools are proxied unchanged, images included', async () => {
  const official = fakeOfficial();
  const { client } = await connect({ official, callPlugin: async () => ({}) });
  const res = await client.callTool({ name: 'get_scene', arguments: { instance_id: '1' } });
  assert.deepEqual(official.seen, [['get_scene', { instance_id: '1' }]]);
  assert.deepEqual(res.content, [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }]);
});

test('official failures are reported as tool errors with their cause', async () => {
  const down = fakeOfficial({ call: () => Promise.reject(Error('ECONNREFUSED')) });
  const { client } = await connect({ official: down, callPlugin: async () => ({}) });
  const res = await client.callTool({ name: 'get_scene', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /OFFICIAL_MCP_UNAVAILABLE\(get_scene\): ECONNREFUSED/);
  const bad = fakeOfficial({ call: () => Promise.reject(new McpError(-32602, 'Invalid arguments')) });
  const c2 = (await connect({ official: bad, callPlugin: async () => ({}) })).client;
  const res2 = await c2.callTool({ name: 'get_scene', arguments: {} });
  assert.match(res2.content[0].text, /OFFICIAL_TOOL_ERROR\(get_scene\)/);
});

test('own tools route to the plugin window by project_path or official instance_id', async () => {
  const seen = [];
  const { client } = await connect({
    official: fakeOfficial(),
    callPlugin: async (method, params, opts) => {
      seen.push({ method, params, opts });
      if (method === 'library_search') return { query: 'x', items: [{ template_id: '111', title: '芒果脸' }], raw: [{ templateId: '111', title: '芒果脸' }] };
      return { ok: method };
    },
  });
  const unseen = await client.callTool({ name: 'library_apply', arguments: { project_path: '/proj/B', template_id: '111' } });
  assert.match(unseen.content[0].text, /UNKNOWN_TEMPLATE: 111/);
  const found = JSON.parse((await client.callTool({ name: 'library_search', arguments: { project_path: '/proj/C', query: 'x' } })).content[0].text);
  assert.equal(found.raw, undefined);
  const a = await client.callTool({ name: 'library_apply', arguments: { project_path: '/proj/B', template_id: '111' } });
  assert.deepEqual(JSON.parse(a.content[0].text), { ok: 'library_apply' });
  assert.deepEqual(seen[1], { method: 'library_apply', params: { item: { templateId: '111', title: '芒果脸' } }, opts: { projectPath: '/proj/B', timeoutMs: 180000 } });
  await client.callTool({ name: 'face_warp_set_intensity', arguments: { instance_id: '1', object_path: 'a/塑型画笔', intensity: 55 } });
  assert.deepEqual(seen[2], { method: 'face_warp_set_intensity', params: { object_path: 'a/塑型画笔', intensity: 55 }, opts: { projectPath: '/proj/A', timeoutMs: undefined } });
  await client.callTool({ name: 'ai_combine_apply', arguments: { instance_id: '1', graph_id: 'g-1' } });
  assert.deepEqual(seen[3], { method: 'ai_combine_apply', params: { graph_id: 'g-1' }, opts: { projectPath: '/proj/A', timeoutMs: 180000 } });
  const unknown = await client.callTool({ name: 'menu_list', arguments: { instance_id: '7' } });
  assert.match(unknown.content[0].text, /UNKNOWN_INSTANCE: 7/);
  assert.equal(seen.length, 4);
});

test('invalid arguments are rejected before reaching the plugin', async () => {
  const seen = [];
  const { client } = await connect({ official: fakeOfficial(), callPlugin: async (m) => (seen.push(m), {}) });
  const res = await client.callTool({ name: 'face_warp_set_intensity', arguments: { object_path: 'a', intensity: 101 } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /INVALID_ARGUMENTS\(face_warp_set_intensity\): intensity/);
  const extra = await client.callTool({ name: 'library_search', arguments: { query: 'x', bogus: 1 } });
  assert.equal(extra.isError, true);
  assert.deepEqual(seen, []);
});

test('image_view shows URLs and local files with a caption each, isolating failures', async () => {
  const fetched = [];
  const { client } = await connect({
    official: fakeOfficial(),
    callPlugin: async () => ({}),
    fetchImage: async (url) => {
      fetched.push(url);
      if (url === 'https://bad') throw Error('HTTP 404');
      return { data: 'AAAA', mimeType: 'image/png' };
    },
    readImageFile: async (file) => ({ data: Buffer.from(file).toString('base64'), mimeType: 'image/gif' }),
  });
  const res = await client.callTool({ name: 'image_view', arguments: { images: ['https://ok', 'https://bad', '/hover/smokey.png', 'blob:https://admin/x'] } });
  assert.deepEqual(res.content, [
    { type: 'text', text: '第 1 张：https://ok' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { type: 'text', text: '第 2 张：https://bad' },
    { type: 'text', text: '图片读取失败：HTTP 404' },
    { type: 'text', text: '第 3 张：/hover/smokey.png' },
    { type: 'image', data: Buffer.from('/hover/smokey.png').toString('base64'), mimeType: 'image/gif' },
    { type: 'text', text: '第 4 张：blob:https://admin/x' },
    { type: 'text', text: '图片读取失败：不是引用、http(s) 地址或绝对路径' },
  ]);
  assert.deepEqual(fetched, ['https://ok', 'https://bad']);
  const tooMany = await client.callTool({ name: 'image_view', arguments: { images: Array(9).fill('https://ok') } });
  assert.equal(tooMany.isError, true);
});

test('image_view resolves refs: pictures by their address, videos and audio as their address, unknown refs per item', async () => {
  const fetched = [];
  const refs = new MediaRefs();
  const img = refs.add('https://c/cover.png', 'image');
  const video = refs.add('https://c/clip.mp4', 'video');
  const audio = refs.add('https://c/song.mp3', 'audio');
  const { client } = await connect({ official: fakeOfficial(), callPlugin: async () => ({}), refs, fetchImage: async (url) => (fetched.push(url), { data: 'AAAA', mimeType: 'image/png' }) });
  const res = await client.callTool({ name: 'image_view', arguments: { images: [img, video, audio, 'img:999'] } });
  assert.deepEqual(res.content, [
    { type: 'text', text: `第 1 张：${img}` },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { type: 'text', text: `第 2 张：${video}` },
    { type: 'text', text: `${video} 是视频，看不了画面，原地址：https://c/clip.mp4` },
    { type: 'text', text: `第 3 张：${audio}` },
    { type: 'text', text: `${audio} 是音频，看不了画面，原地址：https://c/song.mp3` },
    { type: 'text', text: '第 4 张：img:999' },
    { type: 'text', text: '图片读取失败：引用 img:999 已失效（MCP 服务重启过，或是很久以前的列表），重新调用返回它的工具' },
  ]);
  assert.deepEqual(fetched, ['https://c/cover.png']);
});

test('image_view stops before the stdio message limit and lists what it left out', async () => {
  let size = 3 * 1024 * 1024;
  const { client } = await connect({ official: fakeOfficial(), callPlugin: async () => ({}), fetchImage: async () => ({ data: 'A'.repeat(size), mimeType: 'image/gif' }) });
  const urls = ['https://g/1.gif', 'https://g/2.gif', 'https://g/3.gif', 'https://g/4.gif'];
  const res = await client.callTool({ name: 'image_view', arguments: { images: urls } });
  assert.equal(res.content.filter((c) => c.type === 'image').length, 2);
  assert.deepEqual(JSON.parse(res.content.at(-1).text).not_returned, ['https://g/3.gif', 'https://g/4.gif']);
  size = 9 * 1024 * 1024;
  const one = await client.callTool({ name: 'image_view', arguments: { images: urls.slice(2) } });
  assert.equal(one.content.filter((c) => c.type === 'image').length, 1);
  assert.deepEqual(JSON.parse(one.content.at(-1).text).not_returned, ['https://g/4.gif']);
});

test('menu_list details and library_images return image addresses without fetching them', async () => {
  const rows = [
    { menu_id: 'smokey', name: '烟熏妆', description: '一键烟熏妆', image_url: null, image_file: '/hover/smokey.png' },
    { menu_id: 'x', name: '无图项', description: '', image_url: null, image_file: null },
  ];
  const fetchImage = async () => assert.fail('no image may be fetched');
  const sent = [];
  const { client } = await connect({
    official: fakeOfficial(),
    callPlugin: async (method, params) => {
      sent.push({ method, params });
      if (method === 'menu_list') return { total: 300, items: rows };
      if (method === 'library_search') return { items: [{ template_id: '901', title: '萌猫造型帽子', kind: 'ai_image' }], raw: [{ templateId: '901' }] };
      if (method === 'library_images') return [{ image_index: 0, image_url: 'https://img/0.png' }];
      throw Error(`unexpected ${method}`);
    },
    listInstances: () => [{ pid: 1 }],
    fetchImage,
    readImageFile: fetchImage,
  });
  const menu = await client.callTool({ name: 'menu_list', arguments: { query: '妆', details: true } });
  assert.deepEqual(sent[0], { method: 'menu_list', params: { query: '妆', details: true } });
  assert.deepEqual(JSON.parse(menu.content[0].text), { total: 300, items: rows });
  assert.equal(menu.content.length, 1);
  await client.callTool({ name: 'library_search', arguments: { query: '猫' } });
  const lib = await client.callTool({ name: 'library_images', arguments: { template_id: '901' } });
  assert.deepEqual(JSON.parse(lib.content[0].text), { template_id: '901', title: '萌猫造型帽子', images: [{ image_index: 0, image_ref: 'img:1' }] });
});

test('library_list without panel_key lists the panels instead of a panel page', async () => {
  const sent = [];
  const panels = { panels: [{ panel_key: '3d_makeup', name: '美妆', kind: 'general' }] };
  const { client } = await connect({
    official: fakeOfficial(),
    callPlugin: async (method, params, opts) => (sent.push({ method, params, opts }), method === 'library_nav' ? panels : { items: [], raw: [] }),
  });
  assert.deepEqual(JSON.parse((await client.callTool({ name: 'library_list', arguments: { project_path: '/proj/A' } })).content[0].text), panels);
  await client.callTool({ name: 'library_list', arguments: { project_path: '/proj/A', panel_key: '3d_makeup' } });
  assert.deepEqual(
    sent.map((c) => [c.method, c.params, c.opts.projectPath]),
    [
      ['library_nav', {}, '/proj/A'],
      ['library_list', { panel_key: '3d_makeup' }, '/proj/A'],
    ],
  );
});

test('the asset library and the add-object menu go to the lowest-pid window when no target is given', async () => {
  const seen = [];
  const { client } = await connect({
    official: fakeOfficial(),
    listInstances: () => [{ pid: 300 }, { pid: 200 }],
    callPlugin: async (method, params, opts) => (seen.push({ method, opts }), method === 'library_nav' ? { panels: [] } : { total: 0, items: [], raw: [] }),
  });
  for (const [name, args] of [
    ['library_list', {}],
    ['library_list', { panel_key: '3d_makeup' }],
    ['library_search', { query: '腮红' }],
    ['menu_list', { query: '妆' }],
  ]) {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.isError, undefined, `${name}: ${res.content[0].text}`);
  }
  assert.deepEqual(
    seen.map((c) => [c.method, c.opts]),
    [
      ['library_nav', { pid: 200 }],
      ['library_list', { pid: 200 }],
      ['library_search', { pid: 200 }],
      ['menu_list', { pid: 200 }],
    ],
  );
  await client.callTool({ name: 'menu_list', arguments: { project_path: '/proj/A' } });
  assert.deepEqual(seen.at(-1).opts, { projectPath: '/proj/A' });
});

test('own answers over the spill limit come back as a file and an outline, after refs are handed out', async () => {
  const items = Array.from({ length: 300 }, (_, i) => ({ music_id: String(i), title: `歌${i}`, cover_url: `https://c/${i}.png`, preview_url: `https://c/${i}.mp3`, note: '很长的说明'.repeat(10) }));
  const { client } = await connect({
    official: fakeOfficial(),
    listInstances: () => [{ pid: 1 }],
    callPlugin: async (method, params) => (params.query === '冬天' ? { query: '冬天', items: items.slice(0, 1), raw: items.slice(0, 1) } : { query: '夏天', items, raw: items }),
  });
  const res = await client.callTool({ name: 'music_list', arguments: { query: '夏天' } });
  const summary = JSON.parse(res.content[0].text);
  assert.deepEqual(summary.outline.items, { items: 300, item_keys: ['music_id', 'title', 'cover_ref', 'preview_ref', 'note'] });
  const full = JSON.parse(fs.readFileSync(summary.spilled_to, 'utf8'));
  assert.deepEqual(full.items[1], { music_id: '1', title: '歌1', cover_ref: 'img:3', preview_ref: 'audio:4', note: items[1].note });
  const small = JSON.parse((await client.callTool({ name: 'music_list', arguments: { query: '冬天' } })).content[0].text);
  assert.equal(small.spilled_to, undefined);
  assert.equal(small.items[0].cover_ref, 'img:1');
});

test('ext_status reports the official connection and each window with instance id and self check', async () => {
  const { client } = await connect({
    official: fakeOfficial(),
    listInstances: () => [{ pid: 100 }, { pid: 101 }],
    callPlugin: async (method, _p, opts) => {
      if (method === 'status') return { projectPath: `/proj/${opts.pid}` };
      if (opts.pid === 101) throw Error('PLUGIN_ERROR(self_check): unknown method: self_check');
      return { ok: true, missing: [] };
    },
  });
  const res = JSON.parse((await client.callTool({ name: 'ext_status', arguments: {} })).content[0].text);
  assert.deepEqual(res.official, { connected: true, tools: 1 });
  assert.deepEqual(res.windows[0], { pid: 100, project_path: '/proj/100', instance_id: '1', self_check: { ok: true, missing: [] } });
  assert.equal(res.windows[1].instance_id, null);
  assert.match(res.windows[1].self_check.error, /unknown method: self_check.*重开工程窗口/);
});

test('a change in the official tool list is pushed to clients', async () => {
  const official = fakeOfficial();
  const { client } = await connect({ official, callPlugin: async () => ({}) });
  let notified = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    notified += 1;
  });
  official.onToolsChanged();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(notified, 1);
});

test('image helpers sniff real bytes from URLs and files and reject non-images', async (t) => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  const srv = http.createServer((req, res) => {
    if (req.url === '/png') res.end(png);
    else if (req.url === '/webp') res.end(webp);
    else if (req.url === '/html') res.writeHead(200, { 'content-type': 'image/png' }).end('<html>');
    else res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  assert.deepEqual(await fetchImage(`${base}/png`), { data: png.toString('base64'), mimeType: 'image/png' });
  assert.equal((await fetchImage(`${base}/webp`)).mimeType, 'image/webp');
  await assert.rejects(fetchImage(`${base}/html`), /not a png\/jpeg\/gif\/webp image/);
  await assert.rejects(fetchImage(`${base}/missing`), /HTTP 404/);
  const dir = tmpdir('xs-img-');
  fs.writeFileSync(path.join(dir, 'a.gif'), 'GIF89a....');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'hello');
  assert.equal((await readImageFile(path.join(dir, 'a.gif'))).mimeType, 'image/gif');
  await assert.rejects(readImageFile(path.join(dir, 'b.txt')), /not a png/);
});

test('a call that asked for progress gets beats while it runs, and every call is logged with its outcome', async () => {
  const entries = [];
  const callLog = { call: (e) => entries.push(e) };
  const slow = fakeOfficial({ call: () => new Promise((r) => setTimeout(() => r({ content: [{ type: 'text', text: 'done' }] }), 120)) });
  const { client } = await connect({ official: slow, callPlugin: async () => ({}), callLog, progressMs: 20 });
  const beats = [];
  const res = await client.callTool({ name: 'get_scene', arguments: {} }, undefined, { onprogress: (p) => beats.push(p), resetTimeoutOnProgress: true });
  assert.equal(res.content[0].text, 'done');
  assert.ok(beats.length >= 3, `got ${beats.length} beats`);
  assert.deepEqual(beats.slice(0, 2).map((b) => b.progress), [1, 2]);
  assert.match(beats[0].message, /^get_scene: \d+ s$/);
  const n = beats.length;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(beats.length, n, 'beats stop when the call ends');
  assert.equal(entries[0].tool, 'get_scene');
  assert.ok(entries[0].ms >= 100);
  assert.ok(entries[0].progress >= 3);
  await client.callTool({ name: 'get_scene', arguments: {} });
  assert.equal(entries[1].progress, 'none', 'no beats without a progress token');
  const down = await connect({ official: fakeOfficial({ call: () => Promise.reject(Error('ECONNREFUSED')) }), callPlugin: async () => ({}), callLog });
  await down.client.callTool({ name: 'get_scene', arguments: {} });
  assert.match(entries[2].result.content[0].text, /OFFICIAL_MCP_UNAVAILABLE/);
});

test('the call log writes one line per call, with the error of a failed one', async () => {
  const { CallLog } = await import('../src/calllog.mjs');
  const dir = tmpdir('xs-log-');
  const log = new CallLog({ stateDir: dir, now: () => new Date(Date.UTC(2026, 10, 8)) });
  log.call({ tool: 'preview_frames', ms: 12, result: { isError: true, content: [{ type: 'text', text: 'PLUGIN_ERROR(preview_reset): NO_FRESH_PREVIEW_FRAME' }] }, progress: 2 });
  log.call({ tool: 'get_scene', ms: 3, result: { content: [] }, progress: 'none' });
  log.write({ event: 'client_closed' });
  const lines = fs.readFileSync(path.join(dir, 'logs', 'server.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { at: '2026-11-08T00:00:00.000Z', pid: process.pid, tool: 'preview_frames', ms: 12, ok: false, error: 'PLUGIN_ERROR(preview_reset): NO_FRESH_PREVIEW_FRAME', progress: 2 });
  assert.equal(lines[1].ok, true);
  assert.equal(lines[1].error, undefined);
  assert.equal(lines[2].event, 'client_closed');
});

test('official tools that overlap ours are listed with a note naming ours; the rest stay unchanged', async () => {
  const names = ['capture_preview', 'get_scene', 'inspect', 'edit_by_dsl', 'list_resources'];
  const official = fakeOfficial({ tools: names.map((name) => ({ name, description: `官方${name}`, inputSchema: { type: 'object' } })) });
  const { client } = await connect({ official, callPlugin: async () => ({}) });
  const { tools } = await client.listTools();
  const desc = (name) => tools.find((t) => t.name === name).description;
  assert.match(desc('capture_preview'), /^官方capture_preview\n\n（xiangsu-mcp-plus）.*preview_frames/);
  assert.match(desc('get_scene'), /^官方get_scene\n\n（xiangsu-mcp-plus）.*scene_tree.*inspect_many/);
  assert.match(desc('inspect'), /（xiangsu-mcp-plus）.*inspect_many/);
  assert.match(desc('edit_by_dsl'), /（xiangsu-mcp-plus）.*object_remove/);
  assert.equal(desc('list_resources'), '官方list_resources');
});

test('ai3d tools route account calls to any window and keep the found subject for ai3d_gs_submit', async () => {
  const seen = [];
  const { client } = await connect({
    official: fakeOfficial(),
    listInstances: () => [{ pid: 30 }, { pid: 20 }],
    callPlugin: async (method, params, opts) => {
      seen.push({ method, params, opts });
      if (method === 'ai3d_gs_segment') return { seg_task_id: 's1', subject_image_url: 'https://cdn/subject.png', subject_uri: 'tos-subject', req_json: { req_type: 1, vid: 'v1' } };
      return { ok: method };
    },
  });
  const call = async (name, args) => client.callTool({ name, arguments: args });
  await call('ai3d_image_submit', { image_path: '/a/dog.png' });
  assert.deepEqual(seen[0], { method: 'ai3d_image_submit', params: { image_path: '/a/dog.png' }, opts: { pid: 20, timeoutMs: 300000 } });

  const missing = await call('ai3d_gs_submit', { seg_task_id: 's1' });
  assert.match(missing.content[0].text, /UNKNOWN_SEGMENT: s1; call ai3d_gs_segment first/);
  const seg = JSON.parse((await call('ai3d_gs_segment', { video_path: '/a/cup.mov' })).content[0].text);
  assert.equal(seg.seg_task_id, 's1');
  assert.match(seg.subject_image_ref, /^img:\d+$/);
  assert.equal(seg.subject_uri, undefined, 'internal fields stay in the server');
  assert.deepEqual(seen[1], { method: 'ai3d_gs_segment', params: { video_path: '/a/cup.mov', wait_s: 120 }, opts: { pid: 20, timeoutMs: 420000 } });
  await call('ai3d_gs_submit', { seg_task_id: 's1' });
  assert.deepEqual(seen[2].params, { subject_uri: 'tos-subject', req_json: { req_type: 1, vid: 'v1' } });

  await call('ai3d_tasks', { kind: 'image', count: 5 });
  assert.deepEqual(seen[3], { method: 'ai3d_tasks', params: { kind: 'image', cursor: undefined, count: 5 }, opts: { pid: 20 } });
  const one = JSON.parse((await call('ai3d_tasks', { kind: 'image', task_id: 't1', wait_s: 60 })).content[0].text);
  assert.deepEqual(one, { kind: 'image', ok: 'ai3d_task' });
  assert.deepEqual(seen[4], { method: 'ai3d_task', params: { task_id: 't1', wait_s: 60 }, opts: { pid: 20, timeoutMs: 90000 } });
  const stray = await call('ai3d_tasks', { kind: 'image', wait_s: 60 });
  assert.match(stray.content[0].text, /wait_s only applies together with task_id/);

  await call('ai3d_import', { project_path: '/proj/B', task_id: 't1', kind: 'image' });
  assert.deepEqual(seen[5], { method: 'ai3d_import', params: { task_id: 't1', kind: 'image' }, opts: { projectPath: '/proj/B', timeoutMs: 180000 } });
  const tooLong = await call('ai3d_tasks', { kind: 'image', task_id: 't1', wait_s: 601 });
  assert.match(tooLong.content[0].text, /INVALID_ARGUMENTS\(ai3d_tasks\): wait_s/);
  // The history API refuses pages of more than 20.
  const tooMany = await call('ai3d_tasks', { kind: 'image', count: 21 });
  assert.match(tooMany.content[0].text, /INVALID_ARGUMENTS\(ai3d_tasks\): count/);
  assert.equal(seen.length, 6);
});

test('ar_video tools go to the target project window, where the task is composed', async () => {
  const seen = [];
  const { client } = await connect({
    official: fakeOfficial(),
    listInstances: () => [{ pid: 30 }, { pid: 20 }],
    callPlugin: async (method, params, opts) => (seen.push({ method, params, opts }), { ok: method }),
  });
  const call = async (name, args) => client.callTool({ name, arguments: { project_path: '/proj/B', ...args } });
  const submit = { subject: '/a/cat.png', mode: 'motion', prompt: '扭屁股', reference_images: ['/a/hat.png'], shadow: false, duration_s: 10 };
  await call('ar_video_submit', submit);
  assert.deepEqual(seen[0], { method: 'ar_video_submit', params: submit, opts: { projectPath: '/proj/B', timeoutMs: 1200000 } });
  await call('ar_video_tasks', { count: 5 });
  assert.deepEqual(seen[1], { method: 'ar_video_tasks', params: { offset: undefined, count: 5 }, opts: { projectPath: '/proj/B' } });
  await call('ar_video_tasks', { task_id: 'wf1', wait_s: 300 });
  assert.deepEqual(seen[2], { method: 'ar_video_task', params: { task_id: 'wf1', wait_s: 300 }, opts: { projectPath: '/proj/B', timeoutMs: 420000 } });
  await call('ar_video_import', { task_id: 'wf1' });
  assert.deepEqual(seen[3], { method: 'ar_video_import', params: { task_id: 'wf1' }, opts: { projectPath: '/proj/B', timeoutMs: 180000 } });
  await call('ar_video_cancel', { task_id: 'wf1' });
  assert.deepEqual(seen[4], { method: 'ar_video_cancel', params: { task_id: 'wf1' }, opts: { projectPath: '/proj/B', timeoutMs: undefined } });

  for (const [args, re] of [
    [{ task_id: 'wf1', wait_s: 601 }, /INVALID_ARGUMENTS\(ar_video_tasks\): wait_s/],
    [{ count: 21 }, /INVALID_ARGUMENTS\(ar_video_tasks\): count/],
    [{ wait_s: 10 }, /wait_s only applies together with task_id/],
  ]) assert.match((await call('ar_video_tasks', args)).content[0].text, re);
  assert.match((await call('ar_video_submit', { subject: '/a/cat.png', mode: 'dance' })).content[0].text, /INVALID_ARGUMENTS\(ar_video_submit\): mode/);
  assert.match((await call('ar_video_submit', { subject: '/a/cat.png', mode: 'motion', duration_s: 9.5 })).content[0].text, /INVALID_ARGUMENTS\(ar_video_submit\): duration_s/);
  assert.equal(seen.length, 5);
});
