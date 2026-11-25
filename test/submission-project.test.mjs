import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const { projectInventory, preparedProjectPackage } = createRequire(import.meta.url)('../editor-plugin/features/submission-project.cjs');

test('project inventory includes production leftovers outside Assets and hidden files with native staging excluded', () => {
  const root = tmpdir('xs-inventory-');
  for (const [name, bytes] of [['Assets/main.scene', 3], ['素材/录屏.mp4', 50], ['.mcp_agent/log.json', 7], ['.dyeh-h5/staging/large.mp4', 1000]]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), Buffer.alloc(bytes));
  }
  assert.deepEqual(projectInventory(root), { project_directory_bytes: 60, project_file_count: 3, largest_project_files: [{ path: '素材/录屏.mp4', bytes: 50 }, { path: '.mcp_agent/log.json', bytes: 7 }, { path: 'Assets/main.scene', bytes: 3 }] });
});

test('project inventory does not silently omit symbolic links', () => {
  const root = tmpdir('xs-inventory-');
  fs.symlinkSync(tmpdir('xs-external-'), path.join(root, 'outside'));
  assert.throws(() => projectInventory(root), /PROJECT_INVENTORY_UNSUPPORTED: symbolic link outside/);
});

test('native project ZIP readiness has a deadline and cannot silently pass without an archive', async () => {
  const win = { isClosed: false, exportPromise: Promise.resolve() };
  const error = await preparedProjectPackage(win, Date.now() + 20, 2).then(() => null, (e) => e.message);
  assert.equal(error, 'PROJECT_EXPORT_FAILED: native project ZIP was not prepared');
});
