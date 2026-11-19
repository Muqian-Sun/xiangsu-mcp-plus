import test from 'node:test';
import './tmp.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { McpError, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { OfficialMcp, OfficialUnreachable } from '../src/official.mjs';

function fakeConnector(script) {
  const log = { connects: 0, closes: 0 };
  const connect = async () => {
    log.connects += 1;
    const n = log.connects;
    const s = script(n);
    if (s.refuse) throw Error('ECONNREFUSED');
    return {
      listTools: async () => ({ tools: s.tools ?? [{ name: 'get_scene' }] }),
      callTool: async (params) => s.call(params, n),
      close: async () => {
        log.closes += 1;
      },
    };
  };
  return { connect, log };
}

test('a connection lost after sending is not sent again; the client is dropped and the next call reconnects', async () => {
  const sent = [];
  const { connect, log } = fakeConnector(() => ({
    call: (p, n) => {
      sent.push(n);
      if (n === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } });
      return { content: [{ type: 'text', text: `ok ${p.name}` }] };
    },
  }));
  const o = new OfficialMcp({ connect });
  const err = await o.callTool('generate_image', {}).catch((e) => e);
  assert.match(err.message, /fetch failed/);
  assert.ok(!(err instanceof OfficialUnreachable), 'the call may have run in the editor');
  assert.deepEqual(sent, [1], 'sent once');
  assert.equal(log.closes, 1);
  const res = await o.callTool('get_scene', { instance_id: '1' });
  assert.equal(res.content[0].text, 'ok get_scene');
  assert.equal(log.connects, 2);
});

test('an editor that is not listening is reported as unreachable, nothing having been sent', async () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const cached = new OfficialMcp({ connect: fakeConnector(() => ({ call: () => Promise.reject(refused) })).connect });
  const err = await cached.callTool('get_scene', {}).catch((e) => e);
  assert.ok(err instanceof OfficialUnreachable);
  assert.match(err.message, /fetch failed \(ECONNREFUSED\)/);
  const never = new OfficialMcp({ connect: fakeConnector(() => ({ refuse: true })).connect });
  assert.ok((await never.callTool('get_scene', {}).catch((e) => e)) instanceof OfficialUnreachable);
});

test('does not retry protocol errors from the official server', async () => {
  const { connect, log } = fakeConnector(() => ({
    call: () => {
      throw new McpError(-32602, 'Invalid arguments');
    },
  }));
  const o = new OfficialMcp({ connect });
  await assert.rejects(o.callTool('get_scene', {}), McpError);
  assert.equal(log.connects, 1);
});

test('lists cached tools when unreachable and signals when the tool list changes', async () => {
  let up = false;
  let changes = 0;
  const { connect } = fakeConnector(() => (up ? { tools: [{ name: 'get_scene' }, { name: 'save_project' }], call: () => ({}) } : { refuse: true }));
  const o = new OfficialMcp({ connect, onToolsChanged: () => (changes += 1) });
  assert.deepEqual(await o.listTools(), []);
  assert.equal(o.status().connected, false);
  assert.match(o.status().last_error, /ECONNREFUSED/);
  up = true;
  assert.deepEqual((await o.listTools()).map((t) => t.name), ['get_scene', 'save_project']);
  assert.equal(changes, 1);
  o.reset();
  await o.listTools();
  assert.equal(changes, 1);
});

// Like the official server (measured): no session, every request answered with one plain JSON body.
async function jsonMcpServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') return res.writeHead(405).end();
    let body = '';
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body);
    if (msg.id === undefined) return res.writeHead(202).end();
    const result =
      msg.method === 'initialize'
        ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } }
        : msg.method === 'tools/list'
          ? { tools: [{ name: 'health', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: '{"status":"ok"}' }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

// The built-in fetch gives up on headers after 300 s (measured at 301 s), shorter than a generation may take.
test('official calls do not go through the built-in fetch', async () => {
  const { server, url } = await jsonMcpServer();
  const builtin = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(Error('built-in fetch used'));
  try {
    const o = new OfficialMcp({ url });
    assert.deepEqual(await o.callJson('health', {}), { status: 'ok' });
    o.reset();
  } finally {
    globalThis.fetch = builtin;
    server.closeAllConnections();
    server.close();
  }
});

test('callJson parses text results and surfaces tool errors', async () => {
  const { connect } = fakeConnector(() => ({
    call: (p) => (p.name === 'bad' ? { isError: true, content: [{ type: 'text', text: 'nope' }] } : { content: [{ type: 'text', text: '{"a":1}' }] }),
  }));
  const o = new OfficialMcp({ connect });
  assert.deepEqual(await o.callJson('good', {}), { a: 1 });
  await assert.rejects(o.callJson('bad', {}), /OFFICIAL_TOOL_ERROR\(bad\): nope/);
});

test('refreshes tools on ToolListChanged notification without disconnecting', async () => {
  let tools = [{ name: 'get_scene', inputSchema: { type: 'object' } }];
  let handler = null;
  let changes = 0;
  const o = new OfficialMcp({
    connect: async () => ({
      setNotificationHandler: (schema, fn) => {
        if (schema === ToolListChangedNotificationSchema) handler = fn;
      },
      listTools: async () => ({ tools }),
      callTool: async () => ({}),
      close: async () => {},
    }),
    onToolsChanged: () => {
      changes += 1;
    },
  });
  assert.deepEqual((await o.listTools()).map((t) => t.name), ['get_scene']);
  assert.equal(changes, 1);
  assert.equal(typeof handler, 'function');

  tools = [
    { name: 'get_scene', inputSchema: { type: 'object' } },
    { name: 'new_hot_tool', inputSchema: { type: 'object' } },
  ];
  handler();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual((await o.listTools()).map((t) => t.name), ['get_scene', 'new_hot_tool']);
  assert.equal(changes, 2);
});

test('triggers onToolsChanged when tool names match but inputSchema changes, and ignores key order', async () => {
  let step = 0;
  let changes = 0;
  const schemas = [
    [{ name: 'get_scene', description: 'scene', inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } } }],
    [{ name: 'get_scene', description: 'scene', inputSchema: { properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' } }],
    [{ name: 'get_scene', description: 'scene', inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' }, c: { type: 'boolean' } } } }],
  ];
  const o = new OfficialMcp({
    connect: async () => ({
      listTools: async () => ({ tools: schemas[step] }),
      callTool: async () => ({}),
      close: async () => {},
    }),
    onToolsChanged: () => {
      changes += 1;
    },
  });
  await o.listTools();
  assert.equal(changes, 1);

  step = 1;
  o.reset();
  await o.listTools();
  assert.equal(changes, 1, 'reordered schema keys should not trigger onToolsChanged');

  step = 2;
  o.reset();
  await o.listTools();
  assert.equal(changes, 2, 'added schema property should trigger onToolsChanged');
});
