import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { opsRequest, readOpsToken } from '../src/opsdata.mjs';
import { tmpdir } from './tmp.mjs';

async function connect(deps) {
  const official = { url: 'x', listTools: async () => [], status: () => ({}), callJson: async () => ({ instances: [] }) };
  const server = createServer({ frontApp: async () => null, activateApp: async () => { throw Error('activateApp called in a test'); }, official, ...deps });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test('the read-only token comes from its file, trimmed; a missing or empty file says where to put it', () => {
  const dir = tmpdir('ops-');
  const file = path.join(dir, 'feedback-token');
  assert.throws(() => readOpsToken(file), /OPS_TOKEN_MISSING: no read-only token in .*feedback-token/);
  fs.writeFileSync(file, '\n');
  assert.throws(() => readOpsToken(file), /OPS_TOKEN_MISSING/);
  fs.writeFileSync(file, 'abc123\n');
  assert.equal(readOpsToken(file), 'abc123');
});

test('a dashboard request carries the bearer token and reports the dashboard error on failure', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), method: init.method, auth: init.headers.authorization });
    return String(url).endsWith('/works') ? new Response(JSON.stringify({ works: [] }), { status: 200 }) : new Response(JSON.stringify({ error: '要登录' }), { status: 401 });
  };
  assert.deepEqual(await opsRequest('/api/agent/works', { baseUrl: 'https://ops.test', token: 't0', fetchImpl }), { works: [] });
  await assert.rejects(opsRequest('/api/agent/refresh', { method: 'POST', baseUrl: 'https://ops.test', token: 't0', fetchImpl }), /OPS_HTTP_401: 要登录 \(POST \/api\/agent\/refresh\)/);
  assert.deepEqual(seen, [
    { url: 'https://ops.test/api/agent/works', method: 'GET', auth: 'Bearer t0' },
    { url: 'https://ops.test/api/agent/refresh', method: 'POST', auth: 'Bearer t0' },
  ]);
});

test('each ops tool reads its dashboard endpoint without opening the editor', async () => {
  const seen = [];
  const client = await connect({
    listInstances: () => assert.fail('the ops tools need no editor window'),
    callPlugin: async () => assert.fail('the ops tools do not call the editor plugin'),
    opsRequest: async (pathname, method = 'GET') => (seen.push([method, pathname]), { pathname }),
  });
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.isError, undefined, `${name}: ${res.content[0].text}`);
    return JSON.parse(res.content[0].text);
  };
  assert.deepEqual(await call('ops_works'), { pathname: '/api/agent/works' });
  await call('ops_work', { effect_id: '92765390' });
  await call('ops_tracks');
  await call('ops_market');
  await call('ops_account');
  await call('ops_feedback');
  await call('ops_refresh');
  assert.deepEqual(seen, [
    ['GET', '/api/agent/works'],
    ['GET', '/api/agent/works/92765390'],
    ['GET', '/api/agent/tracks'],
    ['GET', '/api/agent/market'],
    ['GET', '/api/agent/account'],
    ['GET', '/api/agent/feedback'],
    ['POST', '/api/agent/refresh'],
  ]);
  assert.equal((await client.callTool({ name: 'ops_work', arguments: { effect_id: '../x' } })).isError, true, 'effect_id must be digits');
  assert.equal(seen.length, 7);
});

test('the retired account tools are gone from the tool list', async () => {
  const client = await connect({ listInstances: () => [], callPlugin: async () => ({}) });
  const names = new Set((await client.listTools()).tools.map((t) => t.name));
  for (const name of ['my_effects', 'my_effect_reviews', 'my_effect_data', 'my_effect_trend', 'my_effect_revenue', 'my_profile', 'my_revenue', 'messages_list', 'my_task_status', 'my_innovation_status', 'growth_route', 'shoot_activity', 'rank_creators']) {
    assert.equal(names.has(name), false, name);
  }
  for (const name of ['rank_list', 'effect_search', 'effect_detail', 'douyin_hot_list', 'rank_hotspots']) assert.equal(names.has(name), true, `${name} stays for 选题`);
});
