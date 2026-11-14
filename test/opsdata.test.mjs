import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { opsRequest, platformRequest, readOpsToken, readPlatformToken } from '../src/opsdata.mjs';
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

test('a platform request keeps the /v2 base path and sends a JSON body on POST', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), method: init.method, auth: init.headers.authorization, type: init.headers['content-type'], body: init.body });
    return new Response(JSON.stringify({ told: 3 }), { status: 200 });
  };
  await platformRequest('/api/agent/works', { baseUrl: 'https://ops.test/v2/', token: 't1', fetchImpl });
  await platformRequest('/api/agent/changes/ack', { method: 'POST', body: { up_to: 3 }, baseUrl: 'https://ops.test/v2', token: 't1', fetchImpl });
  assert.deepEqual(seen, [
    { url: 'https://ops.test/v2/api/agent/works', method: 'GET', auth: 'Bearer t1', type: undefined, body: undefined },
    { url: 'https://ops.test/v2/api/agent/changes/ack', method: 'POST', auth: 'Bearer t1', type: 'application/json', body: '{"up_to":3}' },
  ]);
  const dir = tmpdir('platform-');
  assert.throws(() => readPlatformToken(path.join(dir, 'token')), /OPS_TOKEN_MISSING: .*set-secrets\.sh/);
});

test('each ops and platform tool reads its endpoint without opening the editor', async () => {
  const seen = [];
  const client = await connect({
    listInstances: () => assert.fail('the ops tools need no editor window'),
    callPlugin: async () => assert.fail('the ops tools do not call the editor plugin'),
    opsRequest: async (pathname, method = 'GET') => (seen.push(['old', method, pathname]), { pathname }),
    platformRequest: async (pathname, method = 'GET', body) => (seen.push(['v2', method, pathname, body]), { pathname }),
  });
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.isError, undefined, `${name}: ${res.content[0].text}`);
    return JSON.parse(res.content[0].text);
  };
  assert.deepEqual(await call('pipeline_works'), { pathname: '/api/agent/works' });
  await call('pipeline_work', { effect_id: '92765390' });
  await call('account_status');
  await call('changes_since');
  await call('changes_since', { after: 12, limit: 5, types: 'stage,auth' });
  await call('changes_ack', { up_to: 17 });
  await call('pipeline_refresh');
  await call('ops_tracks');
  await call('ops_market');
  await call('ops_feedback');
  await call('ops_refresh');
  assert.deepEqual(seen, [
    ['v2', 'GET', '/api/agent/works', undefined],
    ['v2', 'GET', '/api/agent/works/92765390', undefined],
    ['v2', 'GET', '/api/agent/account', undefined],
    ['v2', 'GET', '/api/agent/changes', undefined],
    ['v2', 'GET', '/api/agent/changes?after=12&limit=5&types=stage%2Cauth', undefined],
    ['v2', 'POST', '/api/agent/changes/ack', { up_to: 17 }],
    ['v2', 'POST', '/api/agent/refresh', undefined],
    ['old', 'GET', '/api/agent/tracks'],
    ['old', 'GET', '/api/agent/market'],
    ['old', 'GET', '/api/agent/feedback'],
    ['old', 'POST', '/api/agent/refresh'],
  ]);
  assert.equal((await client.callTool({ name: 'pipeline_work', arguments: { effect_id: '../x' } })).isError, true, 'effect_id must be digits');
  assert.equal((await client.callTool({ name: 'changes_since', arguments: { types: 'stage;drop' } })).isError, true, 'types is a comma list of words');
  assert.equal(seen.length, 11);
});

test('the account tools moved to the platform: ops_works, ops_work and ops_account are gone', async () => {
  const client = await connect({ listInstances: () => [], callPlugin: async () => ({}) });
  const names = new Set((await client.listTools()).tools.map((t) => t.name));
  for (const name of ['ops_works', 'ops_work', 'ops_account']) assert.equal(names.has(name), false, name);
});

test('the retired account tools are gone from the tool list', async () => {
  const client = await connect({ listInstances: () => [], callPlugin: async () => ({}) });
  const names = new Set((await client.listTools()).tools.map((t) => t.name));
  for (const name of ['my_effects', 'my_effect_reviews', 'my_effect_data', 'my_effect_trend', 'my_effect_revenue', 'my_profile', 'my_revenue', 'messages_list', 'my_task_status', 'my_innovation_status', 'growth_route', 'shoot_activity', 'rank_creators']) {
    assert.equal(names.has(name), false, name);
  }
  for (const name of ['rank_list', 'effect_search', 'effect_detail', 'douyin_hot_list', 'rank_hotspots']) assert.equal(names.has(name), true, `${name} stays for 选题`);
});
