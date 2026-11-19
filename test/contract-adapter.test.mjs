import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import {
  compactEditByDslResult,
  normalizeIntention,
  normalizeOfficialArgs,
  precheckEditByDsl,
} from '../src/contract-adapter.mjs';

test('normalizeIntention strips intention on own tools and respects official schemas', () => {
  const own = normalizeIntention({ query: '猫', intention: '查素材' }, { isOwn: true });
  assert.deepEqual(own, { args: { query: '猫' }, intention: '查素材' });

  const strictNoIntention = {
    type: 'object',
    properties: { instance_id: { type: 'string' } },
    additionalProperties: false,
  };
  const stripped = normalizeIntention({ instance_id: '1', intention: '看图' }, { isOwn: false, officialSchema: strictNoIntention });
  assert.deepEqual(stripped.args, { instance_id: '1' });

  const reqIntention = {
    type: 'object',
    properties: { instance_id: { type: 'string' }, intention: { type: 'string' } },
    required: ['instance_id', 'intention'],
  };
  const filled = normalizeIntention({ instance_id: '1' }, { isOwn: false, officialSchema: reqIntention });
  assert.equal(filled.args.intention, 'MCP tool call');
});

test('normalizeOfficialArgs auto-fills single instance_id, maps project_path, and reports clear errors', async () => {
  const schema = {
    type: 'object',
    properties: { instance_id: { type: 'string' }, count: { type: 'number' } },
    required: ['instance_id'],
    additionalProperties: false,
  };

  // Single open window auto-fills instance_id
  const single = await normalizeOfficialArgs('get_script_logs', { count: 20 }, {
    officialSchema: schema,
    listOpenInstances: async () => [{ instance_id: '1', project_path: '/proj/A' }],
  });
  assert.deepEqual(single, { count: 20, instance_id: '1' });

  // project_path translates to instance_id and is stripped when not accepted
  const byPath = await normalizeOfficialArgs('get_project_context', { project_path: '/proj/B' }, {
    officialSchema: schema,
    resolveInstanceId: async ({ project_path }) => (project_path === '/proj/B' ? '2' : null),
  });
  assert.deepEqual(byPath, { instance_id: '2' });

  // Ambiguous windows produce a clear error instead of Unknown gateway MCP tool
  await assert.rejects(
    normalizeOfficialArgs('get_current_preview_video', {}, {
      officialSchema: schema,
      listOpenInstances: async () => [
        { instance_id: '1', project_path: '/proj/A' },
        { instance_id: '2', project_path: '/proj/B' },
      ],
    }),
    /AMBIGUOUS_INSTANCE\(get_current_preview_video\): 2 editor windows/,
  );

  // Zero windows produce NO_OPEN_PROJECT
  await assert.rejects(
    normalizeOfficialArgs('get_current_preview_video', {}, {
      officialSchema: schema,
      listOpenInstances: async () => [],
    }),
    /NO_OPEN_PROJECT\(get_current_preview_video\)/,
  );

  // Misnamed key produces a targeted hint
  await assert.rejects(
    normalizeOfficialArgs('get_script_logs', { instance_id: '1', lines: 40 }, { officialSchema: schema }),
    /unrecognized key\(s\) "lines" \(did you mean "count"\?\)/,
  );
});

test('precheckEditByDsl catches component typo, scene object guid, and array properties before forwarding', () => {
  assert.throws(
    () => precheckEditByDsl([{ command_type: 'set_component', params: { component: 'c1', properties: { enabled: true } } }]),
    /uses "guid" \(not "component"\)/,
  );
  assert.throws(
    () => precheckEditByDsl([{ command_type: 'set_component', params: { guid: 's38', properties: { intensity: 0.5 } } }]),
    /scene object GUID \(sNN\), not a component GUID \(cNN\)/,
  );
  assert.throws(
    () => precheckEditByDsl([{ command_type: 'set_component', params: { guid: 'c1', properties: [] } }]),
    /must be an object/,
  );
  // Valid component guid and $ref pass cleanly
  assert.doesNotThrow(() =>
    precheckEditByDsl([
      { command_type: 'set_component', params: { guid: 'c1', properties: { intensity: 0.5 } } },
      { command_type: 'set_component', params: { guid: { $ref: 's10', component_type: 'Image' }, properties: { enabled: true } } },
    ]),
  );
});

test('compactEditByDslResult shrinks huge batch echoes while keeping changes and errors', () => {
  const bigPayload = {
    success: true,
    status: 'success',
    executed: 2,
    failed: 0,
    skipped: 0,
    results: [
      { command_type: 'import_resource', status: 'success', alias: 'mesh', result: { guid: 'r1', huge_tree: 'x'.repeat(12000) } },
      { command_type: 'set_component', status: 'success', result: { guid: 'c1', changes: [{ property: 'enabled', oldValue: false, newValue: true }] } },
    ],
  };
  const raw = { content: [{ type: 'text', text: JSON.stringify(bigPayload) }] };
  const out = compactEditByDslResult(raw, { maxChars: 1000 });
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.compacted, true);
  assert.equal(parsed.results[0].result.guid, 'r1');
  assert.equal(parsed.results[0].result.huge_tree, undefined);
  assert.deepEqual(parsed.results[1].result.changes, [{ property: 'enabled', oldValue: false, newValue: true }]);
});

test('server end-to-end: own tools ignore intention, official tools auto-resolve instance_id, brief_today filters sections', async () => {
  const officialCalls = [];
  const pluginCalls = [];
  const official = {
    url: 'http://official',
    status: () => ({ connected: true, tools: 2 }),
    listTools: async () => [
      {
        name: 'get_current_preview_video',
        description: 'current video',
        inputSchema: { type: 'object', properties: { instance_id: { type: 'string' } }, required: ['instance_id'], additionalProperties: false },
      },
      {
        name: 'get_scene',
        description: 'scene',
        inputSchema: { type: 'object', properties: { instance_id: { type: 'string' }, intention: { type: 'string' } }, required: ['instance_id'] },
      },
    ],
    callTool: async (name, args) => {
      officialCalls.push([name, args]);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, name, args }) }] };
    },
    callJson: async (name) => {
      if (name === 'list_instances') return { instances: [{ instance_id: '1', generation: '100-1', project_path: '/proj/A' }] };
      throw Error(`unexpected ${name}`);
    },
  };

  const server = createServer({
    official,
    frontApp: async () => null,
    activateApp: async () => {},
    callPlugin: async (m, p) => {
      pluginCalls.push([m, p]);
      return { items: [] };
    },
    platformRequest: async (pathname) => {
      if (pathname === '/api/agent/brief') return { account: { ok: true }, focus: { summary: 'A' }, tracks: [1, 2], hotspots: ['h1'] };
      return {};
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);

  // Own tool receives intention without failing strictObject validation
  const fw = await client.callTool({ name: 'face_warp', arguments: { action: 'list', project_path: '/proj/A', intention: '查塑型画笔' } });
  assert.equal(fw.isError, undefined);
  assert.deepEqual(pluginCalls[0], ['face_warp_list', {}]);

  // Official tool called with {} auto-fills single instance_id instead of failing at gateway
  const cur = await client.callTool({ name: 'get_current_preview_video', arguments: { intention: '会被严格schema剥离' } });
  assert.equal(cur.isError, undefined);
  assert.deepEqual(officialCalls[0], ['get_current_preview_video', { instance_id: '1' }]);

  // Official tool called with project_path resolves to instance_id
  const sc = await client.callTool({ name: 'get_scene', arguments: { project_path: '/proj/A', intention: '看树' } });
  assert.equal(sc.isError, undefined);
  assert.deepEqual(officialCalls[1], ['get_scene', { instance_id: '1', intention: '看树' }]);

  // brief_today with sections returns only requested keys
  const brief = JSON.parse((await client.callTool({ name: 'brief_today', arguments: { sections: ['account', 'focus', 'nope'] } })).content[0].text);
  assert.deepEqual(brief, {
    account: { ok: true },
    focus: { summary: 'A' },
    missing_sections: ['nope'],
    available_sections: ['account', 'focus', 'tracks', 'hotspots'],
  });
});
