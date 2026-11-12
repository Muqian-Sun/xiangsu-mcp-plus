import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Library, M, quietMarkFile, QUIET_NEW_PROJECT } = require('../editor-plugin/library.cjs');
const { STATE } = require('../editor-plugin/features/quiet.cjs');

const MINIMIZED = 1;
const STYLE = { WindowCustomize: 1, ButtonMin: 2, ButtonClose: 8, FixedSize: 16, Borderless: 32768 };

// A fake editor with the window behaviour measured on 9.8.3: windows share Window.prototype's show,
// showMinimized, focus and friends (WebWindow overrides show and calls super), the app activates
// through its prototype, and showWindow shows the edit window, focuses it and activates the app.
function editor() {
  delete globalThis[STATE];
  const log = [];
  class Window {
    constructor(name, style = STYLE.WindowCustomize | STYLE.ButtonMin | STYLE.ButtonClose) {
      this.name = name;
      this.style = style;
      this.visible = 0;
      this.windowState = 0;
      this.pos = { x: 15, y: 62 };
      this.pinned = false;
    }
    show() {
      log.push(`${this.name} show`);
      this.visible = 1;
      this.windowState = 0;
    }
    showMinimized() {
      this.visible = 0;
      if (!(this.style & STYLE.ButtonMin)) return log.push(`${this.name} stays hidden`);
      log.push(`${this.name} minimized`);
      this.windowState = MINIMIZED;
    }
    hide() {
      log.push(`${this.name} hide`);
      this.visible = 0;
    }
    requestActive() {
      log.push(`${this.name} requestActive`);
    }
    raise() {
      log.push(`${this.name} raise`);
    }
    bringToTop() {
      log.push(`${this.name} bringToTop`);
    }
    get focus() {
      return !!this.focused;
    }
    set focus(v) {
      log.push(`${this.name} focus`);
      this.focused = v;
    }
    get windowPosition() {
      return { ...this.pos };
    }
    set windowPosition(p) {
      if (!this.pinned) this.pos = { x: p.x, y: p.y };
    }
  }
  class WebWindow extends Window {
    show() {
      super.show();
    }
  }
  class App {
    activate() {
      log.push('activate');
    }
  }
  globalThis.OrionApplication = { App: new App() };
  const edit = new Window('edit');
  class EditWindowController {
    static getInstance() {
      return controller;
    }
    getWindow() {
      return this.window;
    }
    showWindow() {
      return Promise.resolve().then(() => {
        this.window.show();
        this.window.focus = true;
        globalThis.OrionApplication.App.activate();
      });
    }
  }
  const controller = new EditWindowController();
  controller.window = edit;
  const e = { log, project: null, edit, controller, Window, WebWindow };
  e.modules = {
    [M.ef]: { ProjectManager: { getInstance: () => ({ getActiveProject: () => e.project }) } },
    [M.orionui]: { Window, WindowState: { Normal: 0, Minimized: MINIMIZED }, WindowStyle: STYLE },
    [M.editWindow]: { EditWindowController },
  };
  e.lib = new Library((id) => e.modules[id]);
  // What loading a project does: a progress window, then the edit window.
  e.load = async () => {
    new Window('progress', STYLE.WindowCustomize | STYLE.Borderless | STYLE.FixedSize).show();
    await controller.showWindow();
  };
  return e;
}

function project(parent) {
  const dir = parent ? path.join(tmpdir('xs-q-'), ...parent) : tmpdir('xs-q-');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'effect.dyehpj'), '{}');
  return dir;
}

function mark(key, expiresAt = Date.now() + 60000) {
  const file = quietMarkFile(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ key, expires_at: expiresAt }));
  return file;
}

const FRONT = ['progress show', 'edit show', 'edit focus', 'activate'];

test('a project the MCP server opened loads with every window minimized, never focused or activated', async () => {
  const e = editor();
  e.project = { path: project() };
  mark(e.project.path);
  e.lib.installQuietWindows();
  await e.load();
  assert.deepEqual(e.log, ['progress stays hidden', 'edit minimized']);
  e.log.length = 0;
  const dialog = new e.WebWindow('dialog');
  dialog.show();
  dialog.requestActive();
  dialog.raise();
  dialog.bringToTop();
  dialog.focus = true;
  globalThis.OrionApplication.App.activate();
  assert.deepEqual(e.log, ['dialog minimized']);
});

test('once the user brings the edit window up, the window process behaves as the editor does', async () => {
  const e = editor();
  e.project = { path: project() };
  mark(e.project.path);
  e.lib.installQuietWindows();
  await e.load();
  e.edit.visible = 1;
  e.edit.windowState = 0;
  e.log.length = 0;
  const dialog = new e.Window('dialog');
  dialog.show();
  dialog.focus = true;
  globalThis.OrionApplication.App.activate();
  assert.deepEqual(e.log, ['dialog show', 'dialog focus', 'activate']);
  e.edit.showMinimized();
  e.log.length = 0;
  new e.Window('later').show();
  assert.deepEqual(e.log, ['later minimized']);
});

test('unmarked, expired and unreadable marks leave the editor opening the project in front', async () => {
  for (const setup of [() => {}, (dir) => mark(dir, Date.now() - 1), (dir) => fs.writeFileSync(mark(dir), '{not json')]) {
    const e = editor();
    e.project = { path: project() };
    setup(e.project.path);
    e.lib.installQuietWindows();
    await e.load();
    assert.deepEqual(e.log, FRONT);
  }
});

test('a new project is quiet under the new-project mark only, and only in its ProjectCreatedTmp folder', async () => {
  const fresh = project(['Instance2', 'ProjectCreatedTmp', '未命名']);
  const cases = [
    [fresh, true, ['progress stays hidden', 'edit minimized']],
    [fresh, false, FRONT],
    [project(), true, FRONT],
  ];
  for (const [dir, marked, want] of cases) {
    const e = editor();
    e.project = { path: dir };
    const file = marked ? mark(QUIET_NEW_PROJECT) : null;
    e.lib.installQuietWindows();
    await e.load();
    assert.deepEqual(e.log, want, `${dir} marked=${marked}`);
    if (file) fs.rmSync(file);
  }
});

test('windows a tool opens stay minimized while it runs, in any window process', async () => {
  const e = editor();
  e.project = { path: project() };
  e.edit.visible = 1;
  e.lib.installQuietWindows();
  const out = await e.lib.withQuietWindows(async () => {
    await e.lib.withQuietWindows(async () => {});
    await new Promise((r) => setTimeout(r, 5));
    const w = new e.WebWindow('submit');
    w.show();
    w.bringToTop();
    globalThis.OrionApplication.App.activate();
    return 'done';
  });
  assert.equal(out, 'done');
  await assert.rejects(
    e.lib.withQuietWindows(async () => {
      throw Error('boom');
    }),
    /boom/,
  );
  new e.Window('after').show();
  assert.deepEqual(e.log, ['submit minimized', 'after show']);
});

test('a library reload wraps the editor originals again rather than the previous wrappers', async () => {
  const e = editor();
  e.lib.installQuietWindows();
  new Library((id) => e.modules[id]).installQuietWindows();
  e.project = { path: project() };
  await e.load();
  assert.deepEqual(e.log, FRONT);
  const checks = Library.prototype.quietNow;
  let n = 0;
  Library.prototype.quietNow = function () {
    n += 1;
    return checks.call(this);
  };
  try {
    new e.Window('dialog').show();
  } finally {
    Library.prototype.quietNow = checks;
  }
  assert.equal(n, 1, 'one wrapper, not one per load');
  const w = editor();
  w.lib.installQuietWindows();
  new Library((id) => w.modules[id]).installQuietWindows();
  w.project = { path: project() };
  mark(w.project.path);
  await w.load();
  assert.deepEqual(w.log, ['progress stays hidden', 'edit minimized']);
});

test('a window without a minimize button gets one, so it goes to the Dock instead of staying hidden', async () => {
  const e = editor();
  e.project = { path: project() };
  e.edit.visible = 1;
  e.lib.installQuietWindows();
  const icon = new e.Window('icon', STYLE.WindowCustomize | STYLE.ButtonClose | STYLE.FixedSize);
  const bare = new e.Window('bare', STYLE.Borderless);
  await e.lib.withQuietWindows(async () => {
    icon.show();
    bare.show();
  });
  assert.deepEqual(e.log, ['icon minimized', 'bare stays hidden']);
  assert.equal(icon.style, STYLE.WindowCustomize | STYLE.ButtonClose | STYLE.FixedSize | STYLE.ButtonMin);
  assert.equal(bare.style, STYLE.Borderless);
  const outside = new e.Window('outside', STYLE.ButtonClose);
  outside.show();
  assert.equal(outside.style, STYLE.ButtonClose, 'windows shown normally keep their style');
});



test('the runtime installs the quiet windows whenever it loads the library', async () => {
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
  assert.deepEqual(e.log, ['progress stays hidden', 'edit minimized']);
});

test('installing refuses an editor without the functions it wraps', () => {
  const e = editor();
  delete e.modules[M.editWindow];
  assert.throws(() => e.lib.installQuietWindows(), /INCOMPATIBLE_EDITOR: missing .*EditWindowController/);
  const f = editor();
  globalThis.OrionApplication = {};
  assert.throws(() => f.lib.installQuietWindows(), /INCOMPATIBLE_EDITOR: missing OrionApplication\.App\.activate/);
});
