import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Library, M, backgroundOpenFile } = require('../editor-plugin/library.cjs');

const ORIGINALS = Symbol.for('xiangsu-mcp-ext.backgroundOpen.originals');

// A fake editor with the load sequence measured on 9.8.1: the progress service creates and shows its
// window, and showWindow later shows the edit window, focuses it, emits EditWindowShown and
// activates the app in one task.
function editor() {
  delete globalThis[ORIGINALS];
  const log = [];
  const listeners = new Map();
  const bus = {
    on: (ev, fn) => listeners.set(ev, [...(listeners.get(ev) ?? []), fn]),
    once(ev, fn) {
      const wrap = (...a) => {
        listeners.set(ev, listeners.get(ev).filter((f) => f !== wrap));
        fn(...a);
      };
      this.on(ev, wrap);
    },
    emit: (ev) => (listeners.get(ev) ?? []).forEach((fn) => fn()),
  };
  class Window {
    constructor(name) {
      this.name = name;
    }
    show() {
      log.push(`${this.name} show`);
    }
    showMinimized() {
      log.push(`${this.name} minimized`);
    }
    get focus() {
      return this.focused ?? false;
    }
    set focus(v) {
      log.push(`${this.name} focus`);
      this.focused = v;
    }
  }
  class ReactWindow extends Window {}
  class MainWindow extends Window {}
  class ProgressService {
    showProgressWindow() {
      this.progressWindow = new ReactWindow('progress');
      this.progressWindow.show();
    }
  }
  class EditWindowController {
    constructor() {
      this.window = new MainWindow('edit');
    }
    showWindow() {
      return Promise.resolve().then(() => {
        this.window.show();
        this.window.focus = true;
        bus.emit('EditWindowShown');
        globalThis.OrionApplication.App.activate();
      });
    }
  }
  class App {
    activate() {
      log.push('activate');
    }
  }
  globalThis.OrionApplication = { App: new App() };
  const e = { log, project: null };
  const modules = {
    [M.ef]: { ProjectManager: { getInstance: () => ({ getActiveProject: () => e.project }) } },
    [M.orionui]: { ReactWindow, MainWindow },
    [M.editWindow]: { EditWindowController },
    [M.progressWindow]: { ProjectProgressServiceInstance: new ProgressService() },
    [M.events]: { BusinessEventManager: { TypeGuard: () => bus } },
  };
  e.lib = new Library((id) => modules[id]);
  e.modules = modules;
  e.controller = new EditWindowController();
  e.ReactWindow = ReactWindow;
  e.load = async () => {
    modules[M.progressWindow].ProjectProgressServiceInstance.showProgressWindow();
    await e.controller.showWindow();
    await new Promise((r) => setTimeout(r, 5));
  };
  return e;
}

function project() {
  const dir = tmpdir('xs-bg-');
  fs.writeFileSync(path.join(dir, 'effect.dyehpj'), '{}');
  return dir;
}

function mark(dir, expiresAt = Date.now() + 60000) {
  const file = backgroundOpenFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ project_path: dir, expires_at: expiresAt }));
  return file;
}

test('a marked project loads with no window on screen and the edit window minimized, without focus or activation', async () => {
  const e = editor();
  e.project = { path: project() };
  mark(e.project.path);
  e.lib.installBackgroundOpen();
  await e.load();
  assert.deepEqual(e.log, ['edit minimized']);
});

test('the editor functions shadowed for a background open are put back once the window is shown', async () => {
  const e = editor();
  e.project = { path: project() };
  mark(e.project.path);
  e.lib.installBackgroundOpen();
  await e.load();
  e.log.length = 0;
  const win = e.controller.window;
  win.show();
  win.focus = true;
  globalThis.OrionApplication.App.activate();
  new e.ReactWindow('later').show();
  assert.deepEqual(e.log, ['edit show', 'edit focus', 'activate', 'later show']);
  assert.ok(!Object.hasOwn(win, 'show') && !Object.hasOwn(win, 'focus') && !Object.hasOwn(globalThis.OrionApplication.App, 'activate'));
  assert.ok(!Object.hasOwn(e.ReactWindow.prototype, 'show'));
});

test('unmarked, expired and unreadable marks leave the editor opening the project in front', async () => {
  for (const setup of [() => {}, (dir) => mark(dir, Date.now() - 1), (dir) => fs.writeFileSync(mark(dir), '{not json')]) {
    const e = editor();
    e.project = { path: project() };
    setup(e.project.path);
    e.lib.installBackgroundOpen();
    await e.load();
    assert.deepEqual(e.log, ['progress show', 'edit show', 'edit focus', 'activate']);
  }
});

test('a library reload wraps the editor originals again rather than the previous wrapper', async () => {
  const e = editor();
  e.lib.installBackgroundOpen();
  new Library((id) => e.modules[id]).installBackgroundOpen();
  e.project = { path: project() };
  await e.load();
  assert.deepEqual(e.log, ['progress show', 'edit show', 'edit focus', 'activate']);
  e.log.length = 0;
  e.project = { path: project() };
  mark(e.project.path);
  await e.load();
  assert.deepEqual(e.log, ['edit minimized']);
  const win = e.controller.window;
  assert.ok(!Object.hasOwn(win, 'show') && !Object.hasOwn(win, 'focus') && !Object.hasOwn(globalThis.OrionApplication.App, 'activate'));
  assert.ok(!Object.hasOwn(e.ReactWindow.prototype, 'show'));
});

test('the mark is found by the real path, whichever spelling of it the editor or the server uses', async () => {
  const e = editor();
  const dir = project();
  const link = path.join(tmpdir('xs-bg-link-'), 'link');
  fs.symlinkSync(dir, link);
  mark(link);
  e.project = { path: dir };
  assert.equal(e.lib.backgroundOpenRequested(), true);
  e.project = null;
  assert.equal(e.lib.backgroundOpenRequested(), false);
});

test('the runtime installs the background open whenever it loads the library', async () => {
  const { Runtime } = require('../editor-plugin/runtime.cjs');
  const e = editor();
  globalThis.orion = e.modules;
  try {
    new Runtime();
    e.project = { path: project() };
    mark(e.project.path);
    await e.load();
  } finally {
    delete globalThis.orion;
  }
  assert.deepEqual(e.log, ['edit minimized']);
});

test('installing refuses an editor without the functions it wraps', () => {
  const e = editor();
  delete e.modules[M.progressWindow].ProjectProgressServiceInstance;
  assert.throws(() => e.lib.installBackgroundOpen(), /INCOMPATIBLE_EDITOR: missing .*ProjectProgressServiceInstance\.showProgressWindow/);
  const f = editor();
  globalThis.OrionApplication = {};
  assert.throws(() => f.lib.installBackgroundOpen(), /INCOMPATIBLE_EDITOR: missing OrionApplication\.App\.activate/);
});
