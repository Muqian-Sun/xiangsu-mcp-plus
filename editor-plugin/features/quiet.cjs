'use strict';
// Keeps 像塑 off the screen for everything the MCP server does: windows the plugin opens for a tool,
// and every window of a project the server opened, stay minimized and never take the focus.
// Measured on 9.8.1 and 9.8.3: a window process comes to the front whenever it shows a window for the
// first time, and the editor focuses its edit window and activates the app once a project has loaded.
// (Taking over a project activates the process too, before any window shows; the MCP server hands the
// focus back for that.)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { M, STATE_ROOT } = require('./common.cjs');

// The MCP server marks a project before asking for its window and removes the mark once the window is
// up; expires_at covers a server that exits in between. A new project has no path before it opens,
// so it is marked under NEW_PROJECT and recognised by its ProjectCreatedTmp folder.
const MARK_DIR = path.join(STATE_ROOT, 'quiet-open');
const NEW_PROJECT = 'createNew';
const NEW_PROJECT_DIR = `${path.sep}ProjectCreatedTmp${path.sep}`;

function quietMarkFile(key) {
  let real = key;
  if (key !== NEW_PROJECT) {
    try {
      real = fs.realpathSync(key);
    } catch (_) {
      real = path.resolve(key);
    }
  }
  return path.join(MARK_DIR, `${crypto.createHash('sha1').update(real).digest('hex')}.json`);
}

function markValid(key) {
  let mark;
  try {
    mark = JSON.parse(fs.readFileSync(quietMarkFile(key), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  return mark.expires_at > Date.now();
}

// Per process, across library reloads: the editor functions wrapped (so a reload wraps them, not the
// previous wrappers), whether this process's project was opened by the MCP server, how many tool calls
// that open windows are running.
const STATE = Symbol.for('xiangsu-mcp-ext.quiet');
const state = () => (globalThis[STATE] ||= { originals: null, marked: false, toolDepth: 0 });

function editWindow(lib) {
  return lib.mod(M.editWindow).EditWindowController.getInstance().getWindow();
}

const methods = {
  // Whether the project this window holds was marked by the MCP server.
  quietMarked() {
    const project = this.mod(M.ef).ProjectManager.getInstance().getActiveProject();
    if (!project || !project.path) return false;
    return markValid(project.path) || (project.path.includes(NEW_PROJECT_DIR) && markValid(NEW_PROJECT));
  },

  // Windows stay off screen while a tool call opens one, and in a window process holding a project the MCP server opened for as long as its edit window is not
  // on screen: once the user brings it up from the Dock, the editor behaves as it always does.
  quietNow() {
    const s = state();
    if (s.toolDepth > 0) return true;
    if (!s.marked) {
      try {
        s.marked = this.quietMarked();
      } catch (_) {
        return false;
      }
      if (!s.marked) return false;
    }
    const win = editWindow(this);
    return !win || !win.visible || win.windowState === this.mod(M.orionui).WindowState.Minimized;
  },

  // A window shown while quiet is shown minimized; focusing, raising and activating are skipped. A
  // window without a minimize button (the icon creation window, 9.8.3) does not minimize, it just stays
  // hidden and out of the Dock, so it gets the button first; borderless windows (the loading progress
  // window) are left hidden. Anything that fails here leaves the editor's own behaviour, so a window
  // may then come up in front.
  installQuietWindows() {
    this.ensureCompatible('quietWindows');
    const app = globalThis.OrionApplication && globalThis.OrionApplication.App;
    if (!app || typeof app.activate !== 'function') throw Error('INCOMPATIBLE_EDITOR: missing OrionApplication.App.activate');
    const { Window, WindowStyle } = this.mod(M.orionui);
    const W = Window.prototype;
    const AppProto = Object.getPrototypeOf(app);
    const s = state();
    const focus = Object.getOwnPropertyDescriptor(W, 'focus');
    const o = (s.originals ||= {
      show: W.show,
      showMinimized: W.showMinimized,
      focus,
      requestActive: W.requestActive,
      raise: W.raise,
      bringToTop: W.bringToTop,
      activate: AppProto.activate,
    });
    const quiet = () => {
      try {
        return this.quietNow();
      } catch (_) {
        return false;
      }
    };
    W.show = function (...args) {
      if (!quiet()) return o.show.apply(this, args);
      if (!(this.style & WindowStyle.Borderless) && !(this.style & WindowStyle.ButtonMin)) this.style |= WindowStyle.ButtonMin;
      return o.showMinimized.call(this);
    };
    Object.defineProperty(W, 'focus', {
      configurable: true,
      enumerable: o.focus.enumerable,
      get: o.focus.get,
      set(v) {
        if (v && quiet()) return;
        o.focus.set.call(this, v);
      },
    });
    for (const k of ['requestActive', 'raise', 'bringToTop']) {
      W[k] = function (...args) {
        return quiet() ? undefined : o[k].apply(this, args);
      };
    }
    AppProto.activate = function (...args) {
      return quiet() ? undefined : o.activate.apply(this, args);
    };
    return { installed: true };
  },

  // Runs fn with every window this process shows kept off screen; tool calls that open windows use it.
  async withQuietWindows(fn) {
    const s = state();
    s.toolDepth += 1;
    try {
      return await fn();
    } finally {
      s.toolDepth -= 1;
    }
  },
};

module.exports = { methods, METHODS: {}, quietMarkFile, NEW_PROJECT, STATE };
