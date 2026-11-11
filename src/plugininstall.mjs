// Installs the XiangsuMcpExt editor plugin into 像塑's local plugin folder on macOS. The plugin's
// index.js requires editor-plugin/runtime.cjs by absolute path, so that code must stay where it is:
// a package run from npx's cache is copied to the state directory first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLUGIN_NAME = 'XiangsuMcpExt';
const PLUGIN_VERSION = '0.3.0';
const MARKER = 'install.json';
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATE_ROOT = process.env.XIANGSU_MCP_EXT_STATE || path.join(os.homedir(), '.xiangsu-mcp-ext');

// The editor loads plugins from a folder per editor version, which exists once 像塑 has run.
export function editorPluginRoot(appRoot = process.env.XIANGSU_APP ?? '/Applications/Douyin AR.app') {
  const plist = path.join(appRoot, 'Contents/Info.plist');
  if (!fs.existsSync(plist)) throw Error(`EDITOR_NOT_FOUND: ${appRoot}`);
  const editorVersion = execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist], { encoding: 'utf8' }).trim();
  const root = path.join(os.homedir(), 'Library/Application Support/DouyinAR/Plugins', `v${editorVersion}`, 'Local');
  if (!fs.existsSync(root)) throw Error(`PLUGIN_ROOT_NOT_FOUND: ${root} (start 像塑 once first)`);
  return root;
}

function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    if (!m) throw Error(`BAD_VERSION: ${v}`);
    return m.slice(1).map(Number);
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// The installed plugin as recorded by this installer; null when absent or installed before the record existed.
function installed(pluginRoot) {
  const marker = path.join(pluginRoot, `${PLUGIN_NAME}@${PLUGIN_VERSION}`, MARKER);
  if (!fs.existsSync(marker)) return null;
  const listPath = path.join(pluginRoot, 'plugins.config.json');
  const listed = fs.existsSync(listPath) && (readJson(listPath).plugins || []).some((p) => p.name === PLUGIN_NAME && p.version === PLUGIN_VERSION);
  return listed ? readJson(marker) : null;
}

// npx unpacks into <cache>/_npx/<hash>/node_modules and may replace or delete it at any time.
function stableCode(pkgRoot, version, stateRoot) {
  const src = path.join(pkgRoot, 'editor-plugin');
  if (!pkgRoot.split(path.sep).includes('_npx')) return src;
  const dest = path.join(stateRoot, 'editor-plugin', version, 'editor-plugin');
  if (!fs.existsSync(dest)) {
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(src, tmp, { recursive: true });
    fs.renameSync(tmp, dest);
  }
  return dest;
}

// Installs unless the plugin already runs this package's version or a newer one from code that is
// still on disk, so servers of different checkouts on one machine do not keep overwriting each other.
// force installs from this package regardless.
export function ensurePlugin({ pluginRoot = editorPluginRoot(), pkgRoot = PKG_ROOT, stateRoot = STATE_ROOT, force = false } = {}) {
  const { name, version } = readJson(path.join(pkgRoot, 'package.json'));
  const current = installed(pluginRoot);
  if (!force && current && fs.existsSync(path.join(current.code, 'runtime.cjs')) && compareVersions(current.version, version) >= 0) {
    return { action: 'kept', plugin_root: pluginRoot, version: current.version, code: current.code };
  }

  const code = stableCode(pkgRoot, version, stateRoot);
  const removed = [];
  for (const entry of fs.readdirSync(pluginRoot)) {
    if (entry.split('@')[0] === PLUGIN_NAME) {
      fs.rmSync(path.join(pluginRoot, entry), { recursive: true, force: true });
      removed.push(entry);
    }
  }
  const dest = path.join(pluginRoot, `${PLUGIN_NAME}@${PLUGIN_VERSION}`);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(
    path.join(dest, 'index.js'),
    `'use strict';
const { Runtime, log } = require(${JSON.stringify(path.join(code, 'runtime.cjs'))});
module.exports = class {
  initPlugin() {
    if (!process.argv.includes('--projectType=project')) return;
    try { this.runtime = new Runtime(); this.runtime.start(); } catch (e) { log('init failed', e && e.stack); }
  }
  deinitPlugin() { this.runtime && this.runtime.stop(); }
};
`,
  );
  fs.writeFileSync(
    path.join(dest, 'plugin.manifest.json'),
    JSON.stringify({ name: PLUGIN_NAME, version: PLUGIN_VERSION, description: 'Local RPC bridge for xiangsu-mcp-ext', requirements: { orionSDK: '', apis: {} }, entry: 'index.js', builderVersion: 1 }, null, 2),
  );
  fs.writeFileSync(path.join(dest, MARKER), JSON.stringify({ package: name, version, code }, null, 2));

  const listPath = path.join(pluginRoot, 'plugins.config.json');
  let list = { plugins: [] };
  if (fs.existsSync(listPath)) {
    list = readJson(listPath);
    fs.copyFileSync(listPath, `${listPath}.bak-${Date.now()}`);
  }
  list.plugins = (list.plugins || []).filter((p) => p.name !== PLUGIN_NAME);
  list.plugins.push({ name: PLUGIN_NAME, version: PLUGIN_VERSION, loadOnStartup: true });
  fs.writeFileSync(listPath, JSON.stringify(list, null, 2));

  return { action: 'installed', plugin_root: pluginRoot, version, code, plugin: dest, removed, requires_window_reopen: true };
}
