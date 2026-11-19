import test from 'node:test';
import assert from 'node:assert/strict';
import { DIRECT_TOOLS, searchTools, withHiddenToolHints } from '../src/tool-catalog.mjs';
import { createServer } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const OWN_EXTRA = ['library_apply', 'hot_topics', 'tasks_open', 'image_sheet', 'audio_probe'];

test('DIRECT_TOOLS has the 16 names from the call-log plan', () => {
  assert.equal(DIRECT_TOOLS.size, 16);
  for (const name of [
    'ext_status', 'get_project_context', 'brief_today', 'effect_search', 'inspiration_detail',
    'project_open', 'project_close', 'save_project', 'library_search', 'library_apply', 'list_resources',
    'scene_tree', 'inspect_many', 'edit_by_dsl', 'preview_frames', 'image_view',
  ]) assert.ok(DIRECT_TOOLS.has(name), name);
});

test('searchTools ranks exact/prefix/name/description and falls back to token hits', () => {
  const tools = [
    { name: 'library_apply', description: '官方素材应用' },
    { name: 'library_search', description: '搜素材' },
    { name: 'image_matting', description: '抠图' },
    { name: 'script_logs', description: '脚本报错日志' },
  ];
  assert.equal(searchTools(tools, 'library_apply').tools[0].name, 'library_apply');
  assert.equal(searchTools(tools, 'library').tools[0].name, 'library_apply');
  assert.ok(searchTools(tools, '抠图').tools.some((t) => t.name === 'image_matting'));
  assert.ok(searchTools(tools, '报错').tools.some((t) => t.name === 'script_logs'));
  // A compound query typed without spaces still hits spaced keywords.
  const spaced = [{ name: 'douyin_hot_list', description: 'The Douyin hot list', keywords: '抖音 热榜 douyin hot list' }];
  assert.equal(searchTools(spaced, '抖音热榜').tools[0]?.name, 'douyin_hot_list');
  const soft = searchTools(tools, '素材 xyz_no_hit');
  assert.ok(soft.total >= 1);
  assert.ok(soft.tools.some((t) => t.name.startsWith('library_')));
});

test('withHiddenToolHints only annotates non-direct names', () => {
  const known = new Set(['brief_today', 'hot_topics', 'tasks_open', 'save_project', 'tool_describe']);
  const raw = 'Read brief_today first, then tasks_open and hot_topics, finally save_project.';
  const out = withHiddenToolHints(raw, { self: 'brief_today', knownNames: known });
  assert.match(out, /hot_topics, tasks_open/);
  assert.doesNotMatch(out, /Note:[^)]*save_project/);
  assert.match(out, /tool_describe/);
});

async function connect(deps = {}) {
  const server = createServer({
    frontApp: async () => null,
    activateApp: async () => { throw Error('activateApp'); },
    official: {
      listTools: async () => [
        { name: 'get_scene', description: '场景', inputSchema: { type: 'object' } },
        { name: 'get_project_context', description: '上下文', inputSchema: { type: 'object' } },
        { name: 'edit_by_dsl', description: '编辑', inputSchema: { type: 'object' } },
        { name: 'save_project', description: '保存', inputSchema: { type: 'object' } },
        { name: 'list_resources', description: '资源', inputSchema: { type: 'object' } },
      ],
      status: () => ({ connected: true }),
      callTool: async () => ({ content: [{ type: 'text', text: '{}' }] }),
      callJson: async () => ({ instances: [] }),
    },
    callPlugin: async () => ({}),
    ...deps,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test('default catalog names equal flat list names (set equivalence)', async () => {
  const flat = await connect({ flatTools: true });
  const def = await connect({ flatTools: false });
  const flatNames = new Set((await flat.listTools()).tools.map((t) => t.name));
  assert.ok(!flatNames.has('tool_search'));
  const direct = (await def.listTools()).tools.map((t) => t.name);
  assert.ok(direct.includes('tool_search'));
  const found = new Set(direct.filter((n) => n !== 'tool_search' && n !== 'tool_describe' && n !== 'tool_call'));
  let offset = 0;
  for (;;) {
    const page = JSON.parse((await def.callTool({ name: 'tool_search', arguments: { offset } })).content[0].text);
    for (const t of page.tools) found.add(t.name);
    if (page.next_offset == null) break;
    offset = page.next_offset;
  }
  assert.deepEqual([...found].sort(), [...flatNames].sort());
});

test('XIANGSU_MCP_FLAT_TOOLS=1 without deps.flatTools lists the flat set', async () => {
  const prev = process.env.XIANGSU_MCP_FLAT_TOOLS;
  process.env.XIANGSU_MCP_FLAT_TOOLS = '1';
  try {
    const client = await connect({});
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes('tool_search'));
    assert.ok(names.includes('library_apply'));
    assert.ok(names.includes('get_scene'));
  } finally {
    if (prev === undefined) delete process.env.XIANGSU_MCP_FLAT_TOOLS;
    else process.env.XIANGSU_MCP_FLAT_TOOLS = prev;
  }
});

test('default descriptions that name hidden tools carry the call hint', async () => {
  const client = await connect({ flatTools: false });
  const { tools } = await client.listTools();
  const brief = tools.find((t) => t.name === 'brief_today');
  assert.ok(brief);
  if (/hot_topics|tasks_open|douyin_hot_list/.test(brief.description)) {
    assert.match(brief.description, /tool_describe[\s\S]*tool_call/);
  }
  for (const t of tools) {
    const hidden = OWN_EXTRA.filter((n) => n !== t.name && !DIRECT_TOOLS.has(n) && new RegExp(`(?<![A-Za-z0-9_])${n}(?![A-Za-z0-9_])`).test(t.description));
    if (hidden.length) assert.match(t.description, /not in the default direct-call set/);
  }
});
