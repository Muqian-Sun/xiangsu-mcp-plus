import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { tmpdir } from './tmp.mjs';
import { callPlugin, listInstances, resolveInstance, BRIDGE_TIMING } from '../src/bridge.mjs';

const DIR = path.join(process.env.XIANGSU_MCP_EXT_STATE, 'instances');
const PROCESS_START = Date.now() - process.uptime() * 1000;

function writeRecords(records) {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  for (const { pid, port = 1, startedAt } of records) fs.writeFileSync(path.join(DIR, `${pid}.json`), JSON.stringify({ pid, port, token: 't', startedAt }));
}

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  return child.pid;
}

test('no instance directory means no windows', () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  assert.deepEqual(listInstances(), []);
});

test('a record written after its process started is a live window', () => {
  writeRecords([{ pid: process.pid, startedAt: Date.now() }]);
  assert.deepEqual(listInstances().map((s) => s.pid), [process.pid]);
});

test('a record whose pid now belongs to a process started later is stale', () => {
  writeRecords([{ pid: process.pid, startedAt: PROCESS_START - 60000 }]);
  assert.deepEqual(listInstances(), []);
});

test('a record whose process has exited is stale, and does not hide the live ones', async () => {
  writeRecords([{ pid: await exitedPid(), startedAt: Date.now() }, { pid: process.pid, startedAt: Date.now() }]);
  assert.deepEqual(listInstances().map((s) => s.pid), [process.pid]);
});

test('records whose processes have all exited give no windows', async () => {
  writeRecords([{ pid: await exitedPid(), startedAt: Date.now() }]);
  assert.deepEqual(listInstances(), []);
});

// A window: a sleeping process for the pid, and an HTTP server answering the plugin's status RPC.
// `answer` is the project path to report, 'hang' to never reply, or 'closed' for a port nobody listens on.
const children = [];
test.after(() => children.forEach((c) => c.kill()));

async function window(answer) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1e6)']);
  children.push(child);
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    if (answer === 'hang') return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, value: { projectPath: answer } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  if (answer === 'closed') await new Promise((r) => server.close(r));
  else test.after(() => server.closeAllConnections() || server.close());
  await new Promise((r) => setTimeout(r, 50));
  return { pid: child.pid, port, startedAt: Date.now(), calls, server };
}

test('a hung, a closing and a stale window do not keep the target window from being found', async () => {
  BRIDGE_TIMING.statusMs = 300;
  const target = tmpdir('xs-proj-');
  const gone = path.join(tmpdir('xs-gone-'), 'deleted');
  const [hung, closing, stale, good] = [await window('hang'), await window('closed'), await window(gone), await window(target)];
  writeRecords([hung, closing, stale, good]);
  assert.equal((await resolveInstance({ projectPath: target })).pid, good.pid);
  const before = hung.calls.length;
  assert.equal((await resolveInstance({ projectPath: target })).pid, good.pid);
  assert.equal(hung.calls.length, before, 'the window last seen with the project is asked first, not the hung one');
});

test('a project in no window fails with the windows that did not answer', async () => {
  BRIDGE_TIMING.statusMs = 300;
  const [hung, other, stale] = [await window('hang'), await window(tmpdir('xs-other-')), await window(path.join(tmpdir('xs-gone-'), 'deleted'))];
  writeRecords([hung, other, stale]);
  const err = await resolveInstance({ projectPath: tmpdir('xs-none-') }).catch((e) => e);
  assert.match(err.message, new RegExp(`NO_UNIQUE_PLUGIN_INSTANCE for .*: 0 matches; windows that did not answer: ${hung.pid} \\(`));
  assert.ok(!err.message.includes(String(stale.pid)), 'a window showing a deleted project did answer');
});

// The built-in fetch gives up on headers after 300 s whatever the signal allows (measured at 301 s), so
// plugin calls that wait longer (effect checks, downloads, AR video) must not go through it.
test('plugin calls do not go through the built-in fetch', async () => {
  const target = tmpdir('xs-proj-');
  writeRecords([await window(target)]);
  const builtin = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(Error('built-in fetch used'));
  try {
    assert.deepEqual(await callPlugin('status', {}, { projectPath: target }), { projectPath: target });
  } finally {
    globalThis.fetch = builtin;
  }
});

test('a window that no longer shows the project it was last seen with sends the lookup to every window', async () => {
  BRIDGE_TIMING.statusMs = 300;
  const target = tmpdir('xs-proj-');
  const first = await window(target);
  writeRecords([first]);
  assert.equal((await resolveInstance({ projectPath: target })).pid, first.pid);
  const moved = await window(target);
  first.server.removeAllListeners('request');
  first.server.on('request', (req, res) => res.end(JSON.stringify({ ok: true, value: { projectPath: tmpdir('xs-else-') } })));
  writeRecords([first, moved]);
  assert.equal((await resolveInstance({ projectPath: target })).pid, moved.pid);
});
