import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ensurePlugin } from '../src/plugininstall.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// A package checkout with a stub editor-plugin, under parent (e.g. an npx cache path).
function fakePackage(version, parent = tmpdir('xs-pkg-')) {
  const root = path.join(parent, 'pkg');
  fs.mkdirSync(path.join(root, 'editor-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@muqian/xiangsu-mcp-plus', version }));
  fs.writeFileSync(path.join(root, 'editor-plugin', 'runtime.cjs'), `module.exports = { version: ${JSON.stringify(version)} };`);
  return root;
}

function pluginRootWithOthers() {
  const root = tmpdir('xs-plugins-');
  fs.writeFileSync(path.join(root, 'plugins.config.json'), JSON.stringify({ plugins: [{ name: 'Other', version: '1.0.0', loadOnStartup: true }] }));
  return root;
}

const listed = (root) => JSON.parse(fs.readFileSync(path.join(root, 'plugins.config.json'), 'utf8')).plugins;
const entryCode = (root) => fs.readFileSync(path.join(root, 'XiangsuMcpExt@0.3.0', 'index.js'), 'utf8');
const backups = (root) => fs.readdirSync(root).filter((f) => f.startsWith('plugins.config.json.bak-'));

test('a fresh install points the plugin at the package and keeps other plugins listed', () => {
  const pluginRoot = pluginRootWithOthers();
  const pkgRoot = fakePackage('1.2.0');
  const res = ensurePlugin({ pluginRoot, pkgRoot, stateRoot: tmpdir('xs-st-') });
  assert.equal(res.action, 'installed');
  assert.equal(res.code, path.join(pkgRoot, 'editor-plugin'));
  assert.deepEqual(listed(pluginRoot), [
    { name: 'Other', version: '1.0.0', loadOnStartup: true },
    { name: 'XiangsuMcpExt', version: '0.3.0', loadOnStartup: true },
  ]);
  assert.ok(entryCode(pluginRoot).includes(JSON.stringify(path.join(pkgRoot, 'editor-plugin', 'runtime.cjs'))));
  assert.equal(backups(pluginRoot).length, 1);
});

test('the generated entry loads the real runtime', () => {
  const pluginRoot = pluginRootWithOthers();
  ensurePlugin({ pluginRoot, pkgRoot: REPO, stateRoot: tmpdir('xs-st-') });
  const Plugin = createRequire(import.meta.url)(path.join(pluginRoot, 'XiangsuMcpExt@0.3.0', 'index.js'));
  assert.equal(typeof Plugin, 'function');
  assert.equal(typeof Plugin.prototype.initPlugin, 'function');
});

test('the same version already installed is left alone', () => {
  const pluginRoot = pluginRootWithOthers();
  const pkgRoot = fakePackage('1.2.0');
  const stateRoot = tmpdir('xs-st-');
  ensurePlugin({ pluginRoot, pkgRoot, stateRoot });
  const before = entryCode(pluginRoot);
  const res = ensurePlugin({ pluginRoot, pkgRoot: fakePackage('1.2.0'), stateRoot });
  assert.deepEqual(res, { action: 'kept', plugin_root: pluginRoot, version: '1.2.0', code: path.join(pkgRoot, 'editor-plugin') });
  assert.equal(entryCode(pluginRoot), before);
  assert.equal(backups(pluginRoot).length, 1);
});

test('a newer installed version is kept, an older one is replaced, force always replaces', () => {
  const pluginRoot = pluginRootWithOthers();
  const stateRoot = tmpdir('xs-st-');
  const newer = fakePackage('1.10.0');
  ensurePlugin({ pluginRoot, pkgRoot: newer, stateRoot });
  assert.equal(ensurePlugin({ pluginRoot, pkgRoot: fakePackage('1.9.0'), stateRoot }).action, 'kept');
  const newest = fakePackage('2.0.0');
  assert.equal(ensurePlugin({ pluginRoot, pkgRoot: newest, stateRoot }).action, 'installed');
  assert.ok(entryCode(pluginRoot).includes(newest));
  const older = fakePackage('1.0.0');
  assert.equal(ensurePlugin({ pluginRoot, pkgRoot: older, stateRoot, force: true }).action, 'installed');
  assert.ok(entryCode(pluginRoot).includes(older));
});

test('an install whose code is gone is replaced', () => {
  const pluginRoot = pluginRootWithOthers();
  const stateRoot = tmpdir('xs-st-');
  const gone = fakePackage('3.0.0');
  ensurePlugin({ pluginRoot, pkgRoot: gone, stateRoot });
  fs.rmSync(gone, { recursive: true });
  const pkgRoot = fakePackage('1.0.0');
  assert.equal(ensurePlugin({ pluginRoot, pkgRoot, stateRoot }).action, 'installed');
  assert.ok(entryCode(pluginRoot).includes(pkgRoot));
});

test('an install from before the record existed is replaced, removing old plugin versions', () => {
  const pluginRoot = pluginRootWithOthers();
  fs.mkdirSync(path.join(pluginRoot, 'XiangsuMcpExt@0.2.0'));
  fs.mkdirSync(path.join(pluginRoot, 'XiangsuMcpExt@0.3.0'));
  fs.writeFileSync(path.join(pluginRoot, 'XiangsuMcpExt@0.3.0', 'index.js'), '// legacy');
  const res = ensurePlugin({ pluginRoot, pkgRoot: fakePackage('1.0.0'), stateRoot: tmpdir('xs-st-') });
  assert.equal(res.action, 'installed');
  assert.deepEqual(res.removed.sort(), ['XiangsuMcpExt@0.2.0', 'XiangsuMcpExt@0.3.0']);
  assert.deepEqual(fs.readdirSync(pluginRoot).filter((f) => f.startsWith('XiangsuMcpExt')), ['XiangsuMcpExt@0.3.0']);
});

test('a package run from the npx cache is copied out, and the plugin keeps working after the cache goes', () => {
  const pluginRoot = pluginRootWithOthers();
  const stateRoot = tmpdir('xs-st-');
  const cache = path.join(tmpdir('xs-npm-'), '_npx', 'abc123', 'node_modules', '@muqian');
  fs.mkdirSync(cache, { recursive: true });
  const pkgRoot = fakePackage('1.2.0', cache);
  const res = ensurePlugin({ pluginRoot, pkgRoot, stateRoot });
  const copy = path.join(stateRoot, 'editor-plugin', '1.2.0', 'editor-plugin');
  assert.equal(res.code, copy);
  assert.ok(entryCode(pluginRoot).includes(JSON.stringify(path.join(copy, 'runtime.cjs'))));
  fs.rmSync(pkgRoot, { recursive: true });
  const req = createRequire(import.meta.url);
  assert.deepEqual(req(path.join(copy, 'runtime.cjs')), { version: '1.2.0' });
  assert.equal(ensurePlugin({ pluginRoot, pkgRoot: fakePackage('1.2.0', cache), stateRoot }).action, 'kept');
});
