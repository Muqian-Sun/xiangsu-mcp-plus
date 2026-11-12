// Opening, creating and closing project windows. The plugin asks the home process to open windows;
// this module waits for the resulting window and finishes the job (e.g. first save of a new project).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const { quietMarkFile, QUIET_NEW_PROJECT } = createRequire(import.meta.url)('../editor-plugin/library.cjs');

const BUNDLE_ID = 'com.ies.dyeh';
// The home process is com.ies.dyeh, its project windows com.ies.dyeh.orionkit.
const EDITOR_BUNDLE = /^com\.ies\.dyeh(\.|$)/;
const TMP_MARK = `${path.sep}ProjectCreatedTmp${path.sep}`;
// Picked: how often the focus is checked while a window opens; with it the focus a window process took
// came back within 70–190 ms (9.8.1, 9.8.3).
const FOCUS_POLL_MS = 100;
// Measured on 9.8.1: the last activation came about 0.1 s before the window turned minimized, and the
// window state is polled once a second, so the focus is watched for one second more.
const FOCUS_TAIL_MS = 1000;
const run = promisify(execFile);

// -g: 像塑 starts without coming to the front.
export function openWithApp(file, exec = run) {
  return exec('open', ['-g', '-b', BUNDLE_ID, file]);
}

// The app in front as { pid, bundle_id }; null when no app is, or it quit between the two queries
// (lsappinfo then prints [ NULL ] for it).
export async function frontApp(exec = run) {
  const asn = (await exec('lsappinfo', ['front'])).stdout.trim();
  if (!asn.startsWith('ASN:')) return null;
  const { stdout } = await exec('lsappinfo', ['info', '-only', 'pid', '-only', 'bundleid', asn]);
  if (stdout.includes('"pid"=[ NULL ]')) return null;
  const pid = /"pid"=(\d+)/.exec(stdout);
  const bundle = /"CFBundleIdentifier"="([^"]+)"/.exec(stdout);
  if (!pid || !bundle) throw Error(`FRONT_APP_UNREADABLE: lsappinfo said ${JSON.stringify(stdout)} for ${asn}`);
  return { pid: Number(pid[1]), bundle_id: bundle[1] };
}

// Through LaunchServices, which needs no Accessibility or Automation permission.
export function activateApp(bundleId, exec = run) {
  return exec('open', ['-b', bundleId]);
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return path.resolve(p);
  }
};
const samePath = (a, b) => !!a && !!b && real(a) === real(b);
// The editor's CHILD_PROCESS_LIMIT: two project windows at a time. Its own WINDOW_LIMIT answer stays
// the authority; this only refuses early.
export const MAX_WINDOWS = 2;
const listWindows = (windows) => windows.map((w) => `${w.pid} ${w.project_path ?? '(no project)'}`).join(' | ') || 'none with the plugin loaded';

export async function waitFor(fn, { timeoutMs, intervalMs = 1000, sleep }) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(intervalMs);
  }
}

export class Projects {
  constructor(d) {
    this.d = d;
  }

  // Live plugin windows with the project each one shows.
  async windows() {
    const rows = [];
    for (const s of this.d.listInstances()) {
      try {
        const st = await this.d.callPlugin('status', {}, { pid: s.pid, timeoutMs: 5000 });
        rows.push({ pid: s.pid, project_path: st.projectPath || null });
      } catch (_) {}
    }
    return rows;
  }

  async officialInstances() {
    const { instances = [] } = await this.d.official.callJson('list_instances', {});
    return instances.map((i) => ({ ...i, pid: Number(String(i.generation || '').split('-')[0]) }));
  }

  // Refuses up front when every window is taken, before slow work such as a download.
  async ensureFreeWindow() {
    const windows = await this.windows();
    if (windows.length >= MAX_WINDOWS) throw Error(`WINDOW_LIMIT: all ${MAX_WINDOWS} project windows 像塑 allows are in use (${listWindows(windows)}); save and project_close one first`);
  }

  // A window closed just before is gone from the plugin's list a moment before the editor frees its
  // slot, so a launch right after a close can still be refused; it is retried for launchRetryMs.
  async launch(pid, params) {
    const end = Date.now() + this.d.launchRetryMs;
    for (;;) {
      try {
        return await this.d.callPlugin('project_launch', params, { pid });
      } catch (e) {
        if (!/^WINDOW_LIMIT/.test(e.message)) throw e;
        if (Date.now() >= end) throw Error(`${e.message}; open windows: ${listWindows(await this.windows())}`);
        await this.d.sleep(1000);
      }
    }
  }

  async instanceIdForPid(pid, timeoutMs = 0) {
    const hit = await waitFor(async () => (await this.officialInstances().catch(() => [])).find((i) => i.pid === pid), { timeoutMs, sleep: this.d.sleep });
    return hit ? hit.instance_id : null;
  }

  // Our tools accept either the official instance_id or a project path; both end up as a project path.
  async resolveProjectPath({ project_path, instance_id }) {
    if (instance_id === undefined) return project_path;
    const hit = (await this.officialInstances()).find((i) => String(i.instance_id) === String(instance_id));
    if (!hit) throw Error(`UNKNOWN_INSTANCE: ${instance_id}`);
    if (project_path && !samePath(project_path, hit.project_path)) throw Error(`INSTANCE_PROJECT_MISMATCH: instance ${instance_id} has ${hit.project_path}`);
    return hit.project_path;
  }

  // A window reports its project path before the scene is editable; tools need the scene.
  async waitReady(pid) {
    const ok = await waitFor(
      async () => {
        try {
          return (await this.d.callPlugin('project_state', {}, { pid, timeoutMs: 5000 })).scene_ready;
        } catch (_) {
          return false;
        }
      },
      { timeoutMs: this.d.openTimeoutMs, sleep: this.d.sleep },
    );
    if (!ok) throw Error(`SCENE_NOT_READY: window ${pid} did not finish loading its scene`);
  }

  // A window the MCP server opened is shown minimized once its project has loaded (see the plugin's
  // quiet.cjs).
  async waitMinimized(pid) {
    const win = await waitFor(
      async () => {
        const w = await this.d.callPlugin('preview_window', {}, { pid, timeoutMs: 5000 });
        return w.minimized || w.visible ? w : null;
      },
      { timeoutMs: this.d.openTimeoutMs, sleep: this.d.sleep },
    );
    if (!win) throw Error(`WINDOW_SHOW_TIMEOUT: window ${pid} loaded the project but never showed its window`);
    if (!win.minimized) throw Error(`WINDOW_IN_FRONT: window ${pid} has the project open in front; its plugin does not keep windows off screen (close the idle 像塑 windows started before the plugin update, or restart 像塑)`);
  }

  // Marks a project, or the next new one (QUIET_NEW_PROJECT), for the plugin of whichever window takes
  // it; the mark outlives every wait of a launch, so only a server that exits mid-open leaves one
  // behind, and it expires.
  markQuiet(key) {
    const file = quietMarkFile(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ key, expires_at: Date.now() + 3 * this.d.openTimeoutMs + this.d.launchRetryMs }));
    return () => fs.rmSync(file, { force: true });
  }

  // Whenever a 像塑 process takes the focus it goes back to the last other app in front, which is not
  // the one in front at the start when the user switched apps meanwhile.
  keepFocus(owner) {
    let stopped = false;
    const state = { owner, error: null };
    const loop = (async () => {
      while (!stopped) {
        const front = await this.d.frontApp();
        if (front && EDITOR_BUNDLE.test(front.bundle_id)) await this.d.activateApp(state.owner.bundle_id);
        else if (front) state.owner = front;
        await this.d.sleep(FOCUS_POLL_MS);
      }
    })().catch((e) => {
      state.error = e;
    });
    return async () => {
      stopped = true;
      await loop;
      return state;
    };
  }

  // Runs fn with the focus kept off 像塑: taking over a project and showing a window activate the
  // window process even when the plugin keeps the window off screen. Nothing is watched when 像塑
  // itself is in front, where the user is working in it.
  async keepingFocus(fn) {
    const owner = await this.d.frontApp();
    const stop = owner && !EDITOR_BUNDLE.test(owner.bundle_id) ? this.keepFocus(owner) : null;
    let value;
    let focus = null;
    try {
      value = await fn();
      if (stop) await this.d.sleep(FOCUS_TAIL_MS);
    } finally {
      if (stop) focus = await stop();
    }
    return { value, kept_on: focus ? focus.owner.bundle_id : null, error: focus && focus.error ? `FOCUS_NOT_RETURNED: ${focus.error.message}` : null };
  }

  // Opens a project window that stays minimized, with the focus kept off 像塑.
  async openQuietly(key, launchIt, find) {
    const unmark = this.markQuiet(key);
    let got;
    try {
      got = await this.keepingFocus(async () => {
        await launchIt();
        const w = await waitFor(find, { timeoutMs: this.d.openTimeoutMs, sleep: this.d.sleep });
        if (!w) return null;
        await this.waitReady(w.pid);
        await this.waitMinimized(w.pid);
        return w;
      });
    } finally {
      unmark();
    }
    return got.value && { window: got.value, background: { minimized: true, focus_kept_on: got.kept_on, ...(got.error ? { focus_error: got.error } : {}) } };
  }

  // template_id opens the folder the way the homepage opens a work (openTemplate): no version-upgrade
  // prompt, and the project starts unsaved. That launch goes through a window, so one must be open.
  // `activity` binds the project to a creator task the way the task detail window does (see the
  // plugin's project_launch).
  async open({ path: target, template_id, activity }) {
    const abs = path.resolve(target);
    const file = path.join(abs, 'effect.dyehpj');
    if (!fs.existsSync(file)) throw Error(`NOT_A_PROJECT: ${abs} has no effect.dyehpj`);
    const windows = await this.windows();
    const already = windows.find((w) => samePath(w.project_path, abs));
    if (already) return { already_open: true, pid: already.pid, project_path: already.project_path, instance_id: await this.instanceIdForPid(already.pid, this.d.instanceTimeoutMs) };
    if (!windows.length && (template_id !== undefined || activity !== undefined)) throw Error('NO_EDITOR_WINDOW: open any project window first; template and task launches go through an open editor window');
    const launch = template_id === undefined ? { operation: 'openLocal', path: abs } : { operation: 'openTemplate', path: abs, template_id };
    if (activity !== undefined) launch.activity = activity;
    const opened = await this.openQuietly(
      abs,
      () => (windows.length ? this.launch(windows[0].pid, launch) : this.d.openWithApp(file)),
      async () => (await this.windows()).find((x) => samePath(x.project_path, abs)),
    );
    if (!opened) throw Error(`OPEN_TIMEOUT: ${abs} did not finish opening; 像塑 may be showing a dialog (e.g. version upgrade) that needs a click`);
    const w = opened.window;
    return { already_open: false, pid: w.pid, project_path: w.project_path, instance_id: await this.instanceIdForPid(w.pid, this.d.instanceTimeoutMs), background: opened.background };
  }

  // A new, never saved project window (像塑 keeps it under ProjectCreatedTmp until it is saved).
  async newUnsaved() {
    const windows = await this.windows();
    if (!windows.length) throw Error('NO_EDITOR_WINDOW: open any project first; new projects are created through an open editor window');
    const seen = new Set(windows.map((w) => `${w.pid}|${w.project_path}`));
    const opened = await this.openQuietly(
      QUIET_NEW_PROJECT,
      () => this.launch(windows[0].pid, { operation: 'createNew' }),
      async () => (await this.windows()).find((x) => !seen.has(`${x.pid}|${x.project_path}`) && x.project_path && x.project_path.includes(TMP_MARK)),
    );
    if (!opened) throw Error('NEW_PROJECT_TIMEOUT: no new project window appeared');
    return { ...opened.window, background: opened.background };
  }

  async create({ path: target }) {
    const abs = path.resolve(target);
    if (fs.existsSync(abs) && (!fs.statSync(abs).isDirectory() || fs.readdirSync(abs).length)) throw Error(`TARGET_NOT_EMPTY: ${abs}`);
    const w = await this.newUnsaved();
    const instance_id = await this.instanceIdForPid(w.pid, this.d.instanceTimeoutMs);
    if (instance_id === null) throw Error(`NO_OFFICIAL_INSTANCE: window ${w.pid} is not visible to the official MCP`);
    const saved = await this.d.official.callJson('save_project', { instance_id, path: abs, intention: '新建工程首次保存' });
    if (saved.save_status !== 'succeeded') throw Error(`SAVE_FAILED: ${JSON.stringify(saved)}`);
    const moved = await waitFor(async () => (await this.windows()).find((x) => x.pid === w.pid && samePath(x.project_path, abs)), { timeoutMs: this.d.saveTimeoutMs, sleep: this.d.sleep });
    if (!moved) throw Error(`SAVE_NOT_APPLIED: window ${w.pid} still shows ${w.project_path}`);
    return { pid: w.pid, instance_id, project_path: abs, background: w.background };
  }

  // Measured on 9.8.3: about 4 s after a window closes the home process starts an idle window process in
  // its place, which takes the focus and kept it once. The focus is watched past the close, without
  // holding it up, until that process's plugin is up or for d.idleSpawnMs; spawnWatch is that watch.
  async close(args) {
    const projectPath = await this.resolveProjectPath(args);
    const windows = await this.windows();
    const hits = projectPath ? windows.filter((w) => samePath(w.project_path, projectPath)) : windows;
    if (hits.length !== 1) throw Error(projectPath ? `NO_UNIQUE_WINDOW for ${projectPath}: ${hits.length} matches` : `AMBIGUOUS_INSTANCE: ${windows.length} windows; pass project_path or instance_id`);
    const { pid } = hits[0];
    const owner = await this.d.frontApp();
    const before = new Set(this.d.listInstances().map((s) => s.pid));
    const res = await this.d.callPlugin('project_close', { discard_changes: !!args.discard_changes }, { pid });
    const gone = await waitFor(() => !this.d.listInstances().some((s) => s.pid === pid), { timeoutMs: this.d.closeTimeoutMs, sleep: this.d.sleep });
    if (!gone) throw Error(`CLOSE_TIMEOUT: window ${pid} is still running`);
    if (owner && !EDITOR_BUNDLE.test(owner.bundle_id)) this.spawnWatch = this.watchSpawn(owner, before);
    return { closed: true, pid, project_path: res.project_path, discarded_changes: res.discarded_changes };
  }

  async watchSpawn(owner, before) {
    const stop = this.keepFocus(owner);
    try {
      await waitFor(() => this.d.listInstances().some((s) => !before.has(s.pid)), { timeoutMs: this.d.idleSpawnMs, intervalMs: 200, sleep: this.d.sleep });
      await this.d.sleep(FOCUS_TAIL_MS);
    } finally {
      const { error } = await stop();
      if (error) this.d.callLog?.write({ event: 'focus_watch_failed', after: 'project_close', error: error.message });
    }
  }
}
