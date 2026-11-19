import test from 'node:test';
import assert from 'node:assert/strict';
import { DIRECT_TOOLS, isNativeDeferredClient, searchTools, withHiddenToolHints } from '../src/tool-catalog.mjs';
import { createServer } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const OWN_EXTRA = ['library_apply', 'hot_topics', 'tasks_open', 'image_sheet', 'audio_probe'];

test('DIRECT_TOOLS covers the expanded high-frequency + capability set', () => {
  assert.equal(DIRECT_TOOLS.size, 29);
  for (const name of [
    'ext_status', 'get_project_context', 'brief_today', 'effect_search', 'effect_detail', 'effect_videos',
    'inspiration_detail', 'inspirations_find', 'rank_list', 'topic_crowd',
    'project_open', 'project_close', 'save_project', 'library_search', 'library_apply', 'list_resources',
    'editor_capabilities', 'menu_list', 'menu_add',
    'scene_tree', 'inspect', 'inspect_many', 'edit_by_dsl', 'interact_by_dsl', 'get_script_logs',
    'run_otsc_check', 'set_preview_video', 'preview_frames', 'image_view',
  ]) assert.ok(DIRECT_TOOLS.has(name), name);
});

test('searchTools ranks exact/prefix/name/description, returns inline params, and falls back to token hits', () => {
  const tools = [
    { name: 'library_apply', description: '官方素材应用', inputSchema: { type: 'object', properties: { template_id: { type: 'string' }, project_path: { type: 'string' } }, required: ['template_id'] } },
    { name: 'library_search', description: '搜素材' },
    { name: 'image_ai_edit', description: '抠图、超清、重绘' },
    { name: 'get_script_logs', description: '脚本报错日志' },
    { name: 'editor_capabilities', description: '编辑器内置能力地图' },
  ];
  const exact = searchTools(tools, 'library_apply').tools[0];
  assert.equal(exact.name, 'library_apply');
  assert.equal(exact.params, 'template_id*, project_path');
  assert.equal(searchTools(tools, 'library').tools[0].name, 'library_apply');
  assert.ok(searchTools(tools, '抠图').tools.some((t) => t.name === 'image_ai_edit'));
  assert.ok(searchTools(tools, '报错').tools.some((t) => t.name === 'get_script_logs'));
  assert.ok(searchTools(tools, '内置组件').tools.some((t) => t.name === 'editor_capabilities'));
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

async function connect(deps = {}, clientInfo = { name: 't', version: '0' }) {
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
  const client = new Client(clientInfo);
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

test('auto mode negotiates flat for claude-code and compact for other clients, with env overrides', async () => {
  const prevCompact = process.env.XIANGSU_MCP_COMPACT_TOOLS;
  const prevFlat = process.env.XIANGSU_MCP_FLAT_TOOLS;
  const prevClients = process.env.XIANGSU_MCP_FLAT_CLIENTS;
  delete process.env.XIANGSU_MCP_COMPACT_TOOLS;
  delete process.env.XIANGSU_MCP_FLAT_TOOLS;
  delete process.env.XIANGSU_MCP_FLAT_CLIENTS;
  try {
    assert.equal(isNativeDeferredClient({ name: 'claude-code' }), true);
    assert.equal(isNativeDeferredClient({ name: 'cursor' }), false);
    assert.equal(isNativeDeferredClient({ name: 'codex' }), false);
    assert.equal(isNativeDeferredClient({ name: 'my-ide' }, 'my-ide,other'), true);

    // Claude Code auto-negotiates flat typed tools
    const cc = await connect({}, { name: 'claude-code', version: '2.0' });
    const ccNames = (await cc.listTools()).tools.map((t) => t.name);
    assert.ok(!ccNames.includes('tool_search'));
    assert.ok(ccNames.includes('editor_capabilities'));
    assert.ok(ccNames.includes('get_scene'));

    // Cursor / Codex / Antigravity / unknown auto-negotiate compact mode
    for (const cname of ['cursor', 'codex', 'antigravity']) {
      const c = await connect({}, { name: cname, version: '1.0' });
      const names = (await c.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes('tool_search'), cname);
      assert.ok(names.includes('editor_capabilities'), cname);
      assert.ok(!names.includes('get_scene'), cname);
    }

    // XIANGSU_MCP_FLAT_TOOLS=1 forces flat even for non-claude-code clients
    process.env.XIANGSU_MCP_FLAT_TOOLS = '1';
    const forcedFlat = await connect({}, { name: 'cursor', version: '1.0' });
    assert.ok(!(await forcedFlat.listTools()).tools.some((t) => t.name === 'tool_search'));
    delete process.env.XIANGSU_MCP_FLAT_TOOLS;

    // XIANGSU_MCP_COMPACT_TOOLS=1 forces compact even for claude-code
    process.env.XIANGSU_MCP_COMPACT_TOOLS = '1';
    const forcedCompact = await connect({}, { name: 'claude-code', version: '2.0' });
    assert.ok((await forcedCompact.listTools()).tools.some((t) => t.name === 'tool_search'));
  } finally {
    if (prevCompact === undefined) delete process.env.XIANGSU_MCP_COMPACT_TOOLS;
    else process.env.XIANGSU_MCP_COMPACT_TOOLS = prevCompact;
    if (prevFlat === undefined) delete process.env.XIANGSU_MCP_FLAT_TOOLS;
    else process.env.XIANGSU_MCP_FLAT_TOOLS = prevFlat;
    if (prevClients === undefined) delete process.env.XIANGSU_MCP_FLAT_CLIENTS;
    else process.env.XIANGSU_MCP_FLAT_CLIENTS = prevClients;
  }
});

test('compact tool_call unwraps accidental double-nested arguments', async () => {
  const seen = [];
  const client = await connect(
    {
      flatTools: false,
      callPlugin: async (method, params) => {
        seen.push([method, params]);
        return { ok: true };
      },
    },
    { name: 'cursor', version: '1.0' },
  );
  const res = await client.callTool({
    name: 'tool_call',
    arguments: {
      name: 'face_warp',
      arguments: { arguments: { action: 'list', project_path: '/proj/A' } },
    },
  });
  assert.equal(res.isError, undefined);
  assert.deepEqual(seen[0], ['face_warp_list', {}]);
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
