import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Projects, activateApp, frontApp, openWithApp } from '../src/projects.mjs';

const { backgroundOpenFile } = createRequire(import.meta.url)('../editor-plugin/library.cjs');

const tmp = () => tmpdir('xs-p-');

// A fake editor: plugin windows keyed by pid, plus an official MCP mapping pids to instance ids.
function world() {
  const windows = new Map([[100, path.join(tmp(), 'S16')]]);
  const calls = [];
  const ready = new Map();
  let readyAfter = 2;
  const official = {
    callJson: async (name, args) => {
      calls.push(['official', name, args]);
      if (name === 'list_instances') return { instances: [...windows].map(([pid, p], i) => ({ instance_id: String(i + 1), generation: `${pid}-123`, project_path: p })) };
      if (name === 'save_project') {
        const pid = [...windows].find(([, p], i) => String(i + 1) === args.instance_id)[0];
        windows.set(pid, args.path);
        return { save_status: 'succeeded' };
      }
      throw Error(`unexpected ${name}`);
    },
  };
  const d = {
    official,
    sleep: async () => {},
    openTimeoutMs: 50,
    closeTimeoutMs: 50,
    launchRetryMs: 50,
    instanceTimeoutMs: 50,
    saveTimeoutMs: 50,
    listInstances: () => [...windows.keys()].map((pid) => ({ pid })),
    openWithApp: async (file) => {
      calls.push(['open', file]);
      windows.set(300, path.dirname(file));
    },
    callPlugin: async (method, params, opts) => {
      calls.push(['plugin', method, params, opts]);
      if (method === 'status') return { projectPath: windows.get(opts.pid) };
      if (method === 'project_state') {
        const n = (ready.get(opts.pid) ?? 0) + 1;
        ready.set(opts.pid, n);
        return { scene_ready: n >= readyAfter };
      }
      if (method === 'project_launch' && params.operation !== 'createNew') windows.set(200, params.path);
      if (method === 'project_launch' && params.operation === 'createNew') windows.set(201, '/x/Instances/Instance2/ProjectCreatedTmp/未命名');
      if (method === 'project_close') {
        const p = windows.get(opts.pid);
        windows.delete(opts.pid);
        return { closing: true, project_path: p, discarded_changes: !!params.discard_changes };
      }
      return {};
    },
  };
  return { d, windows, calls, ready, setReadyAfter: (n) => (readyAfter = n) };
}

function project() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'effect.dyehpj'), '{}');
  return dir;
}

test('open asks an existing window to open the project and waits for it', async () => {
  const { d, calls } = world();
  const dir = project();
  const out = await new Projects(d).open({ path: dir });
  assert.deepEqual(out, { already_open: false, pid: 200, project_path: dir, instance_id: '2' });
  assert.deepEqual(calls.find((c) => c[1] === 'project_launch').slice(1, 3), ['project_launch', { operation: 'openLocal', path: dir }]);
});

test('open with a template id launches openTemplate and needs an open window', async () => {
  const { d, windows, calls } = world();
  const dir = project();
  const out = await new Projects(d).open({ path: dir, template_id: '9' });
  assert.equal(out.pid, 200);
  assert.deepEqual(calls.find((c) => c[1] === 'project_launch')[2], { operation: 'openTemplate', path: dir, template_id: '9' });
  windows.clear();
  await assert.rejects(new Projects(d).open({ path: project(), template_id: '9' }), /NO_EDITOR_WINDOW/);
  assert.ok(!calls.some((c) => c[0] === 'open'));
});

test('open with an activity passes it to the launch and never falls back to the app', async () => {
  const { d, windows, calls } = world();
  const dir = project();
  await new Projects(d).open({ path: dir, activity: { activity_id: 'D2' } });
  assert.deepEqual(calls.find((c) => c[1] === 'project_launch')[2], { operation: 'openLocal', path: dir, activity: { activity_id: 'D2' } });
  windows.clear();
  await assert.rejects(new Projects(d).open({ path: project(), activity: { activity_id: 'D2' } }), /NO_EDITOR_WINDOW/);
  assert.ok(!calls.some((c) => c[0] === 'open'));
});

test('open returns the window that already shows the project', async () => {
  const { d, windows, calls } = world();
  const dir = project();
  windows.set(150, dir);
  const out = await new Projects(d).open({ path: dir });
  assert.equal(out.already_open, true);
  assert.equal(out.pid, 150);
  assert.ok(!calls.some((c) => c[1] === 'project_launch'));
});

test('open falls back to the app when no window is open, and rejects non-projects', async () => {
  const { d, windows, calls } = world();
  windows.clear();
  const dir = project();
  const out = await new Projects(d).open({ path: dir });
  assert.equal(out.pid, 300);
  assert.deepEqual(calls.find((c) => c[0] === 'open'), ['open', path.join(dir, 'effect.dyehpj')]);
  await assert.rejects(new Projects(d).open({ path: tmp() }), /NOT_A_PROJECT/);
});

test('open times out when the window never shows the project', async () => {
  const { d } = world();
  d.callPlugin = async (method, params, opts) => (method === 'status' ? { projectPath: '/somewhere/else' } : {});
  await assert.rejects(new Projects(d).open({ path: project() }), /OPEN_TIMEOUT/);
});

test('create opens a new window and saves it to the target through the official MCP', async () => {
  const { d, windows, calls } = world();
  const target = path.join(tmp(), '新工程');
  const out = await new Projects(d).create({ path: target });
  assert.deepEqual(out, { pid: 201, instance_id: '2', project_path: target });
  assert.equal(windows.get(201), target);
  const save = calls.find((c) => c[1] === 'save_project');
  assert.deepEqual(save[2], { instance_id: '2', path: target, intention: '新建工程首次保存' });
});

test('create refuses non-empty targets and needs an open window', async () => {
  const { d, windows } = world();
  const busy = tmp();
  fs.writeFileSync(path.join(busy, 'x'), '');
  await assert.rejects(new Projects(d).create({ path: busy }), /TARGET_NOT_EMPTY/);
  windows.clear();
  await assert.rejects(new Projects(d).create({ path: path.join(tmp(), 'n') }), /NO_EDITOR_WINDOW/);
});

test('create fails when the save does not move the window to the target', async () => {
  const { d } = world();
  const official = d.official.callJson;
  d.official.callJson = async (name, args) => (name === 'save_project' ? { save_status: 'succeeded' } : official(name, args));
  await assert.rejects(new Projects(d).create({ path: path.join(tmp(), 'n') }), /SAVE_NOT_APPLIED/);
});

test('close targets the window by instance id and waits for it to exit', async () => {
  const { d, windows } = world();
  const s16 = windows.get(100);
  const out = await new Projects(d).close({ instance_id: '1', discard_changes: true });
  assert.deepEqual(out, { closed: true, pid: 100, project_path: s16, discarded_changes: true });
  assert.equal(windows.has(100), false);
});

test('close reports windows that keep running and unknown instances', async () => {
  const { d } = world();
  const call = d.callPlugin;
  d.callPlugin = async (method, params, opts) => (method === 'project_close' ? { closing: true } : call(method, params, opts));
  await assert.rejects(new Projects(d).close({ instance_id: '1' }), /CLOSE_TIMEOUT/);
  await assert.rejects(new Projects(d).close({ instance_id: '9' }), /UNKNOWN_INSTANCE: 9/);
});

test('open and create wait until the new window scene is editable', async () => {
  const { d, ready, setReadyAfter } = world();
  const dir = project();
  await new Projects(d).open({ path: dir });
  assert.equal(ready.get(200), 2);
  setReadyAfter(Infinity);
  await assert.rejects(new Projects(d).create({ path: path.join(tmp(), 'n') }), /SCENE_NOT_READY: window 201/);
});

test('a launch refused at the window cap right after a close is retried until the slot frees', async () => {
  const { d, windows, calls } = world();
  let refusals = 2;
  const plugin = d.callPlugin;
  d.callPlugin = async (method, params, opts) => {
    if (method === 'project_launch' && refusals-- > 0) {
      calls.push(['plugin', method, params, opts]);
      throw Error('WINDOW_LIMIT: all 2 project windows 像塑 allows are in use; close one with project_close first');
    }
    return plugin(method, params, opts);
  };
  const dir = project();
  const out = await new Projects(d).open({ path: dir });
  assert.equal(out.pid, 200);
  assert.equal(calls.filter((c) => c[1] === 'project_launch').length, 3);
  assert.equal(windows.get(200), dir);
});

test('a launch still refused when the retry time is up names the windows that hold the slots', async () => {
  const { d } = world();
  let now = 0;
  const realNow = Date.now;
  Date.now = () => now;
  d.sleep = async (ms) => {
    now += ms;
  };
  d.launchRetryMs = 3000;
  const plugin = d.callPlugin;
  let launches = 0;
  d.callPlugin = async (method, params, opts) => {
    if (method === 'project_launch') {
      launches += 1;
      throw Error('WINDOW_LIMIT: all 2 project windows 像塑 allows are in use; close one with project_close first');
    }
    return plugin(method, params, opts);
  };
  try {
    await assert.rejects(new Projects(d).open({ path: project() }), /WINDOW_LIMIT: all 2 project windows .*; open windows: 100 .*S16/);
  } finally {
    Date.now = realNow;
  }
  assert.equal(launches, 4);
});

test('other launch failures are not retried', async () => {
  const { d } = world();
  const plugin = d.callPlugin;
  let launches = 0;
  d.callPlugin = async (method, params, opts) => {
    if (method === 'project_launch') {
      launches += 1;
      throw Error('LAUNCH_FAILED: {"status":"failed"}');
    }
    return plugin(method, params, opts);
  };
  await assert.rejects(new Projects(d).open({ path: project() }), /^Error: LAUNCH_FAILED/);
  assert.equal(launches, 1);
});

// The window process takes the focus while it loads; preview_window reports the edit window hidden
// until it is shown, then as `shown`.
function backgroundWorld({ owner = { pid: 1, bundle_id: 'com.todesktop.cursor' }, shown = { visible: false, minimized: true, window: true } } = {}) {
  const w = world();
  const { d, calls } = w;
  let front = owner;
  w.marks = [];
  d.frontApp = async () => {
    calls.push(['front']);
    return front;
  };
  d.activateApp = async (bundle) => {
    calls.push(['activate', bundle]);
    front = owner;
  };
  const plugin = d.callPlugin;
  let windowChecks = 0;
  d.callPlugin = async (method, params, opts) => {
    if (method === 'project_launch') {
      const file = backgroundOpenFile(params.path);
      w.marks.push(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
      front = { pid: 200, bundle_id: 'com.ies.dyeh.orionkit' };
    }
    if (method === 'preview_window') {
      windowChecks += 1;
      calls.push(['plugin', method, params, opts]);
      return windowChecks < 2 ? { visible: false, minimized: false, window: true } : shown;
    }
    return plugin(method, params, opts);
  };
  return w;
}

test('a background open marks the project while it opens, waits for the minimized window and hands the focus back', async () => {
  const { d, calls, marks } = backgroundWorld();
  const dir = project();
  const out = await new Projects(d).open({ path: dir, background: true });
  assert.deepEqual(out, { already_open: false, pid: 200, project_path: dir, instance_id: '2', background: { minimized: true, focus_kept_on: 'com.todesktop.cursor' } });
  assert.equal(marks.length, 1);
  assert.equal(marks[0].project_path, dir);
  assert.ok(marks[0].expires_at > Date.now());
  assert.equal(fs.existsSync(backgroundOpenFile(dir)), false);
  assert.ok(calls.some((c) => c[0] === 'activate' && c[1] === 'com.todesktop.cursor'));
  assert.equal(calls.filter((c) => c[1] === 'preview_window').length, 2);
  const seen = calls.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, seen, 'focus watch stopped');
});

test('a background open whose window comes up in front fails loudly and still cleans up', async () => {
  const { d, calls } = backgroundWorld({ shown: { visible: true, minimized: false, window: true } });
  const dir = project();
  await assert.rejects(new Projects(d).open({ path: dir, background: true }), /BACKGROUND_NOT_APPLIED: window 200 has the project open in front/);
  assert.equal(fs.existsSync(backgroundOpenFile(dir)), false);
  const seen = calls.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, seen, 'focus watch stopped');
});

test('a background open hands the focus to the app the user switched to while it opened', async () => {
  const { d, calls } = backgroundWorld();
  const fronts = [{ pid: 1, bundle_id: 'com.todesktop.cursor' }, { pid: 2, bundle_id: 'com.tencent.WeWorkMac' }, { pid: 200, bundle_id: 'com.ies.dyeh.orionkit' }];
  let front = fronts[0];
  let reads = 0;
  d.frontApp = async () => {
    reads += 1;
    if (reads <= fronts.length) front = fronts[reads - 1];
    return front;
  };
  d.activateApp = async (bundle) => {
    calls.push(['activate', bundle]);
    front = fronts.find((f) => f.bundle_id === bundle);
  };
  const out = await new Projects(d).open({ path: project(), background: true });
  assert.deepEqual(calls.filter((c) => c[0] === 'activate'), [['activate', 'com.tencent.WeWorkMac']]);
  assert.equal(out.background.focus_kept_on, 'com.tencent.WeWorkMac');
});

test('a background open leaves the focus alone when 像塑 itself is in front', async () => {
  const { d, calls } = backgroundWorld({ owner: { pid: 72074, bundle_id: 'com.ies.dyeh' } });
  const out = await new Projects(d).open({ path: project(), background: true });
  assert.deepEqual(out.background, { minimized: true, focus_kept_on: null });
  assert.deepEqual(calls.filter((c) => c[0] === 'front' || c[0] === 'activate'), [['front']]);
});

test('a background open reports a focus watch that broke, with the window open minimized', async () => {
  const { d } = backgroundWorld();
  const front = d.frontApp;
  let n = 0;
  d.frontApp = async () => {
    if (++n === 2) throw Error('lsappinfo gone');
    return front();
  };
  const out = await new Projects(d).open({ path: project(), background: true });
  assert.equal(out.background.minimized, true);
  assert.equal(out.background.focus_error, 'FOCUS_NOT_RETURNED: lsappinfo gone');
});

test('a background open with no editor window starts 像塑 without bringing it forward', async () => {
  const { d, windows, calls } = backgroundWorld();
  windows.clear();
  const open = d.openWithApp;
  d.openWithApp = async (file, opts) => {
    calls.push(['open-opts', opts]);
    return open(file);
  };
  const out = await new Projects(d).open({ path: project(), background: true });
  assert.equal(out.pid, 300);
  assert.deepEqual(calls.find((c) => c[0] === 'open-opts'), ['open-opts', { background: true }]);
});

test('像塑 is started through LaunchServices, in the background only when asked', async () => {
  const seen = [];
  const exec = async (cmd, args) => seen.push([cmd, ...args]);
  await openWithApp('/p/effect.dyehpj', {}, exec);
  await openWithApp('/p/effect.dyehpj', { background: true }, exec);
  await activateApp('com.todesktop.cursor', exec);
  assert.deepEqual(seen, [
    ['open', '-b', 'com.ies.dyeh', '/p/effect.dyehpj'],
    ['open', '-g', '-b', 'com.ies.dyeh', '/p/effect.dyehpj'],
    ['open', '-b', 'com.todesktop.cursor'],
  ]);
});

test('frontApp reads the app in front from lsappinfo and fails on output it cannot read', async () => {
  const lsappinfo = (front, info) => async (cmd, args) => ({ stdout: args[0] === 'front' ? front : info });
  assert.deepEqual(await frontApp(lsappinfo('ASN:0x0-0xbe2be2:\n', '"pid"=57795\n"CFBundleIdentifier"="com.google.Chrome"\n')), { pid: 57795, bundle_id: 'com.google.Chrome' });
  assert.equal(await frontApp(lsappinfo('\n', '')), null);
  assert.equal(await frontApp(lsappinfo('ASN:0x0-0x1:\n', '"pid"=[ NULL ] \n"CFBundleIdentifier"=[ NULL ] \n')), null);
  await assert.rejects(frontApp(lsappinfo('ASN:0x0-0x1:\n', 'something else')), /FRONT_APP_UNREADABLE/);
});

test('ensureFreeWindow refuses when both windows are taken and lists them', async () => {
  const { d, windows } = world();
  await new Projects(d).ensureFreeWindow();
  windows.set(200, '/proj/B');
  await assert.rejects(new Projects(d).ensureFreeWindow(), /WINDOW_LIMIT: all 2 project windows .*in use \(100 .*S16 \| 200 \/proj\/B\)/);
});
