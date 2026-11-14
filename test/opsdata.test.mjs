import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { platformRequest, readPlatformToken } from '../src/opsdata.mjs';
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
  const dir = tmpdir('platform-');
  const file = path.join(dir, 'token');
  assert.throws(() => readPlatformToken(file), /OPS_TOKEN_MISSING: no read-only token in .*token.*set-secrets\.sh/);
  fs.writeFileSync(file, '\n');
  assert.throws(() => readPlatformToken(file), /OPS_TOKEN_MISSING/);
  fs.writeFileSync(file, 'abc123\n');
  assert.equal(readPlatformToken(file), 'abc123');
});

test('a platform request keeps a base path, sends a JSON body on POST and reports the platform error', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), method: init.method, auth: init.headers.authorization, type: init.headers['content-type'], body: init.body });
    return String(url).endsWith('/nope') ? new Response(JSON.stringify({ error: '没有这个作品' }), { status: 404 }) : new Response(JSON.stringify({ told: 3 }), { status: 200 });
  };
  await platformRequest('/api/agent/works', { baseUrl: 'https://ops.test/v2/', token: 't1', fetchImpl });
  await platformRequest('/api/agent/changes/ack', { method: 'POST', body: { up_to: 3 }, baseUrl: 'https://ops.test/v2', token: 't1', fetchImpl });
  await assert.rejects(platformRequest('/api/agent/nope', { baseUrl: 'https://ops.test/v2', token: 't1', fetchImpl }), /OPS_HTTP_404: 没有这个作品 \(GET \/api\/agent\/nope\)/);
  assert.deepEqual(seen.slice(0, 2), [
    { url: 'https://ops.test/v2/api/agent/works', method: 'GET', auth: 'Bearer t1', type: undefined, body: undefined },
    { url: 'https://ops.test/v2/api/agent/changes/ack', method: 'POST', auth: 'Bearer t1', type: 'application/json', body: '{"up_to":3}' },
  ]);
});

test('each platform tool reads its endpoint without opening the editor', async () => {
  const seen = [];
  const client = await connect({
    listInstances: () => assert.fail('the platform tools need no editor window'),
    callPlugin: async () => assert.fail('the platform tools do not call the editor plugin'),
    platformRequest: async (pathname, method = 'GET', body) => (seen.push([method, pathname, body]), { pathname }),
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
  await call('brief_today');
  await call('track_board');
  await call('pick_samples');
  await call('pick_samples', { track: '脸控游戏', kind: 'effect', days: 14, limit: 5 });
  await call('failure_lessons');
  await call('hot_topics');
  await call('task_usage');
  await call('hit_reasons');
  await call('inspirations_new');
  await call('tasks_open');
  assert.deepEqual(seen, [
    ['GET', '/api/agent/works', undefined],
    ['GET', '/api/agent/works/92765390', undefined],
    ['GET', '/api/agent/account', undefined],
    ['GET', '/api/agent/changes', undefined],
    ['GET', '/api/agent/changes?after=12&limit=5&types=stage%2Cauth', undefined],
    ['POST', '/api/agent/changes/ack', { up_to: 17 }],
    ['POST', '/api/agent/refresh', undefined],
    ['GET', '/api/agent/brief', undefined],
    ['GET', '/api/agent/tracks', undefined],
    ['GET', '/api/agent/picks', undefined],
    ['GET', `/api/agent/picks?${new URLSearchParams({ track: '脸控游戏', kind: 'effect', days: '14', limit: '5' })}`, undefined],
    ['GET', '/api/agent/lessons', undefined],
    ['GET', '/api/agent/hotspots', undefined],
    ['GET', '/api/agent/tasks', undefined],
    ['GET', '/api/agent/hits', undefined],
    ['GET', '/api/agent/inspirations', undefined],
    ['GET', '/api/agent/open-tasks', undefined],
  ]);
  assert.equal((await client.callTool({ name: 'pipeline_work', arguments: { effect_id: '../x' } })).isError, true, 'effect_id must be digits');
  assert.equal((await client.callTool({ name: 'changes_since', arguments: { types: 'stage;drop' } })).isError, true, 'types is a comma list of words');
  assert.equal((await client.callTool({ name: 'pick_samples', arguments: { kind: 'video' } })).isError, true, 'kind is effect or template');
  assert.equal(seen.length, 17);
});

test('topic_crowd hands the word to the platform and polls until the search is done, giving up after a minute', async () => {
  const seen = [];
  let answers = [{ status: 'pending', request_id: 7 }, { status: 'pending', request_id: 7 }, { status: 'done', matched: 3 }];
  const slept = [];
  const client = await connect({
    listInstances: () => assert.fail('no editor needed'),
    callPlugin: async () => assert.fail('no plugin needed'),
    sleep: async (ms) => { slept.push(ms); },
    platformRequest: async (pathname, method = 'GET', body) => (seen.push([method, pathname, body]), answers.shift() ?? { status: 'pending', request_id: 7 }),
  });
  const call = async (args) => JSON.parse((await client.callTool({ name: 'topic_crowd', arguments: args })).content[0].text);
  assert.deepEqual(await call({ q: ' 前任撤回 ' }), { status: 'done', matched: 3 });
  assert.deepEqual(seen, [
    ['POST', '/api/agent/topic', { q: '前任撤回' }],
    ['GET', `/api/agent/topic?q=${encodeURIComponent('前任撤回')}`, undefined],
    ['GET', `/api/agent/topic?q=${encodeURIComponent('前任撤回')}`, undefined],
  ]);
  answers = [];
  slept.length = 0;
  assert.equal((await call({ q: '冬眠' })).status, 'pending');
  assert.equal(slept.reduce((a, b) => a + b, 0), 60000);
  assert.equal((await client.callTool({ name: 'topic_crowd', arguments: { q: '' } })).isError, true);
});

test('the old dashboard tools are gone: every ops_* tool moved to the platform', async () => {
  const client = await connect({ listInstances: () => [], callPlugin: async () => ({}) });
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(names.filter((n) => n.startsWith('ops_')), []);
});
