'use strict';
// Project windows: ask the home process to open / create a project in a new window, and close this one.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { M, STATE_ROOT } = require('./common.cjs');

// openTemplate is how the homepage opens a work: no version-upgrade or save-copy prompts, and the
// project opens as unsaved-new.
const OPERATIONS = new Set(['createNew', 'openLocal', 'openTemplate']);
const CLOSE_DELAY_MS = 300;

// The MCP server marks a project for a background open with this file before asking for its window
// and removes it once the window is up; expires_at covers a server that exits in between.
const BACKGROUND_OPEN_DIR = path.join(STATE_ROOT, 'background-open');

function backgroundOpenFile(projectPath) {
  let real;
  try {
    real = fs.realpathSync(projectPath);
  } catch (_) {
    real = path.resolve(projectPath);
  }
  return path.join(BACKGROUND_OPEN_DIR, `${crypto.createHash('sha1').update(real).digest('hex')}.json`);
}

// The editor's own functions the background open wraps; kept across library reloads so every reload
// wraps the originals rather than the previous wrapper.
const ORIGINALS = Symbol.for('xiangsu-mcp-ext.backgroundOpen.originals');

// Replaces obj[key] until the returned function puts the previous own property back (or removes it).
function shadow(obj, key, descriptor) {
  const own = Object.getOwnPropertyDescriptor(obj, key);
  Object.defineProperty(obj, key, { configurable: true, ...descriptor });
  return () => (own ? Object.defineProperty(obj, key, own) : delete obj[key]);
}

const methods = {
  // scene_ready turns true once the editing scene exists; the project path is known earlier than that.
  projectState() {
    const EF = this.mod(M.ef);
    const pm = EF.ProjectManager.getInstance();
    if (!pm.hasActiveProject()) return { project_path: null, changed: false, scene_ready: false };
    const p = pm.getCurrentActiveProject();
    const service = this.mod(M.scene).SceneModule.getEditingSceneService();
    return { project_path: p.path || null, changed: !!p.isProjectChanged(), scene_ready: !!(service && service.sceneEditor) };
  },

  // The home process decides which window hosts the project (a new one, or an idle editor process);
  // the project in this window is never replaced.
  // `activity` (activity_id, activity_name, activity_enter_from, activity_type, task_type) is what the
  // task detail window passes; the editor writes it into the project once it has loaded, which is the
  // only way a project gets bound to a task.
  async projectLaunch({ operation, path: projectPath, template_id, activity }) {
    this.ensureCompatible('project');
    if (!OPERATIONS.has(operation)) throw Error(`INVALID_OPERATION: ${operation}; expected ${[...OPERATIONS].join(', ')}`);
    const withPath = operation !== 'createNew';
    if (withPath) {
      if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) throw Error(`INVALID_PATH: ${operation} needs an absolute project folder`);
      if (!fs.existsSync(path.join(projectPath, 'effect.dyehpj'))) throw Error(`NOT_A_PROJECT: ${projectPath} has no effect.dyehpj`);
    }
    const extra = { enter_method: 'xiangsu_mcp_ext' };
    if (operation === 'openTemplate' && template_id !== undefined) extra.template_id = String(template_id);
    if (activity !== undefined) {
      const keys = ['activity_id', 'activity_name', 'activity_enter_from', 'activity_type', 'task_type'];
      if (!activity || !activity.activity_id || Object.keys(activity).some((k) => !keys.includes(k))) throw Error(`INVALID_ACTIVITY: expected ${keys.join(', ')} with an activity_id`);
      Object.assign(extra, activity, { enter_method: 'activity' });
    }
    // The same request the editor's own launchProject sends; the home process answers once the new
    // window has opened the project. At the window cap it answers reuseCurrent, after which the editor
    // would load the project into this window, so that is refused.
    const { OpenProjectFromEditCommand } = this.mod(M.ipc);
    const res = await this.mod(M.sender)
      .EditSender.getInstance()
      .sendCmdWithResponse(new OpenProjectFromEditCommand(operation, withPath ? projectPath : undefined, extra));
    const status = res && res.status;
    if (status === 'succeeded') return { requested: operation, path: withPath ? projectPath : null };
    if (status === 'reuseCurrent') throw Error(`WINDOW_LIMIT: all ${res.processCount} project windows 像塑 allows are in use; close one with project_close first`);
    if (status === 'cancelled' && res.reason === 'duplicateProject') throw Error(`PROJECT_ALREADY_OPEN: ${projectPath} is open in another window`);
    if (status === 'cancelled' || status === 'failed') throw Error(`LAUNCH_${status.toUpperCase()}: ${JSON.stringify(res)}`);
    throw Error(`UNEXPECTED_LAUNCH_RESPONSE: ${JSON.stringify(res)}`);
  },

  // Same path as the toolbar's "back to home": unloads the project and exits this window's process,
  // without a save prompt, so unsaved changes are refused unless discard_changes is set.
  projectClose({ discard_changes = false } = {}) {
    this.ensureCompatible('project');
    const state = this.projectState();
    if (state.changed && !discard_changes) throw Error(`PROJECT_HAS_UNSAVED_CHANGES: ${state.project_path}; save it first or pass discard_changes`);
    const close = this.mod(M.toolbar).closeProjectAndBackToHome;
    setTimeout(() => {
      Promise.resolve(close(false, false)).catch(() => {});
    }, CLOSE_DELAY_MS);
    return { closing: true, project_path: state.project_path, discarded_changes: state.changed };
  },

  // Whether the project this window is loading is marked for a background open.
  backgroundOpenRequested() {
    const project = this.mod(M.ef).ProjectManager.getInstance().getActiveProject();
    if (!project || !project.path) return false;
    let mark;
    try {
      mark = JSON.parse(fs.readFileSync(backgroundOpenFile(project.path), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
    return mark.expires_at > Date.now();
  },

  // Measured on 9.8.1: a window process comes to the front when it first shows a window, so for a
  // marked project the loading progress window never goes on screen and the edit window is shown
  // minimized, without the focus and app activation that follow. The progress window is still
  // created: its view model is what shows the edit window once loading finishes. (Taking over the
  // project activates the process as well, before any window shows; the MCP server hands the focus
  // back for that.) Unmarked projects go through the editor's own code, and so does a marked one
  // when anything here fails: its window then opens in front and the MCP server reports it.
  installBackgroundOpen() {
    this.ensureCompatible('backgroundOpen');
    const app = globalThis.OrionApplication && globalThis.OrionApplication.App;
    if (!app || typeof app.activate !== 'function') throw Error('INCOMPATIBLE_EDITOR: missing OrionApplication.App.activate');
    const { ReactWindow } = this.mod(M.orionui);
    const Controller = this.mod(M.editWindow).EditWindowController;
    const progress = this.mod(M.progressWindow).ProjectProgressServiceInstance;
    const bus = this.mod(M.events).BusinessEventManager.TypeGuard();
    const orig = (globalThis[ORIGINALS] ||= { showWindow: Controller.prototype.showWindow, showProgressWindow: progress.showProgressWindow });
    const requested = () => {
      try {
        return this.backgroundOpenRequested();
      } catch (_) {
        return false;
      }
    };
    progress.showProgressWindow = function (...args) {
      if (!requested()) return orig.showProgressWindow.apply(this, args);
      const restore = shadow(ReactWindow.prototype, 'show', { value() {}, writable: true });
      try {
        return orig.showProgressWindow.apply(this, args);
      } finally {
        restore();
      }
    };
    Controller.prototype.showWindow = function (...args) {
      const win = this.window;
      if (!win || !requested()) return orig.showWindow.apply(this, args);
      const restores = [
        shadow(win, 'show', { value: () => win.showMinimized(), writable: true }),
        shadow(win, 'focus', { get: () => false, set() {} }),
        shadow(app, 'activate', { value() {}, writable: true }),
      ];
      // The editor activates the app right after emitting EditWindowShown, in the same task.
      bus.once('EditWindowShown', () => setTimeout(() => restores.forEach((r) => r()), 0));
      return orig.showWindow.apply(this, args);
    };
    return { installed: true };
  },
};

const METHODS = { project_state: 'projectState', project_launch: 'projectLaunch', project_close: 'projectClose' };

module.exports = { methods, METHODS, backgroundOpenFile };
