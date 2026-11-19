import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from './tmp.mjs';

const require = createRequire(import.meta.url);
const STATE_DIR = tmpdir('xs-assetops-state-');
process.env.XIANGSU_MCP_PLUS_STATE = STATE_DIR;

const { Library, M } = require('../editor-plugin/library.cjs');
const assetops = require('../editor-plugin/features/assetops.cjs');

// Attach assetops onto a test Library subclass without modifying library.cjs.
class TestLibrary extends Library {}
Object.assign(TestLibrary.prototype, assetops.methods);

function createSetup(opts = {}) {
  const calls = [];
  const projectPath = opts.projectPath ?? tmpdir('xs-proj-a-');
  const assets = new Map(
    (opts.assets ?? [
      {
        guid: { data: 'guid-tex-1' },
        name: { data: 'diffuse.png' },
        type: { data: 'Texture2D' },
        filePath: { data: 'Assets/Textures/diffuse.png' },
        properties: {
          filterMode: { value: 'Bilinear', readonly: false },
          sRGB: { value: true, readonly: false },
          width: { value: 512, readonly: true },
        },
      },
      {
        guid: 'guid-mat-1',
        name: 'skin.mat',
        type: 'Material',
        filePath: 'Assets/Materials/skin.mat',
        properties: {
          roughness: { value: 0.5, readonly: false },
          shader: { value: 'Standard', readonly: true },
        },
      },
    ]).map((a) => [a.guid?.data ?? a.guid, structuredClone(a)]),
  );

  const sceneObjects = new Map(
    (opts.sceneObjects ?? [
      { guid: 'so-1', name: 'Head' },
      { guid: 'so-2', name: 'Hat' },
    ]).map((so) => [so.guid, so]),
  );

  let snapCounter = 0;
  class EHCommandManager {
    async getAllAssets() {
      calls.push(['getAllAssets']);
      return [...assets.values()].map((a) => ({
        guid: a.guid,
        name: a.name,
        type: a.type,
        filePath: a.filePath,
      }));
    }
    async getAsset(guid) {
      calls.push(['getAsset', guid]);
      return assets.get(guid) ? structuredClone(assets.get(guid)) : null;
    }
    async setResourceProperties(guid, props) {
      calls.push(['setResourceProperties', guid, structuredClone(props)]);
      if (opts.dropWrite) return { success: true };
      const target = assets.get(guid);
      if (!target) return { success: false, error: 'not found' };
      for (const [k, v] of Object.entries(props)) {
        if (target.properties[k] && typeof target.properties[k] === 'object' && 'value' in target.properties[k]) {
          target.properties[k].value = v;
        } else {
          target.properties[k] = { value: v, readonly: false };
        }
      }
      return { success: true };
    }
    async addPackage(pkgPath) {
      calls.push(['addPackage', pkgPath]);
      return { imported: true, path: pkgPath };
    }
    async addPrefab(guid) {
      calls.push(['addPrefab', guid]);
      return { prefabGuid: `prefab-${guid}` };
    }
    async instantiatePrefab(guid) {
      calls.push(['instantiatePrefab', guid]);
      return { instanceGuid: `inst-${guid}` };
    }
    async createProjectSnapshot(conversationId, pp, gitRef) {
      calls.push(['createProjectSnapshot', conversationId, pp, gitRef]);
      snapCounter += 1;
      return {
        commitId: `commit-${snapCounter}`,
        gitRepoPath: path.join(pp, '.git'),
      };
    }
    async restoreProjectSnapshot(conversationId, pp, commitId, gitRepoPath) {
      calls.push(['restoreProjectSnapshot', conversationId, pp, commitId, gitRepoPath]);
      return { ok: true };
    }
    async deleteProjectSnapshotRefs(conversationId, gitRefs, gitRepoPath) {
      calls.push(['deleteProjectSnapshotRefs', conversationId, gitRefs, gitRepoPath]);
      return { ok: true };
    }
  }

  const sceneManager = {
    findSceneObjectByGuid: (g) => {
      calls.push(['findSceneObjectByGuid', g]);
      return sceneObjects.get(g) ?? null;
    },
  };

  const activeProject = { path: projectPath, sceneManager };
  const pm = {
    hasActiveProject: () => opts.hasActiveProject ?? true,
    getCurrentActiveProject: () => activeProject,
  };

  const ef = {
    _OEF_Core: {
      ProjectManager: { getInstance: () => pm },
    },
    ProjectManager: { getInstance: () => pm },
    Resource: {
      AssetPackageManager: {
        instance: {
          exportAsPrefabsPkg: async (objs, name, outDir) => {
            calls.push(['exportAsPrefabsPkg', objs.map((o) => o.guid), name, outDir]);
            if (opts.exportErrorCode !== undefined) {
              return { errorCode: opts.exportErrorCode, message: 'export failed' };
            }
            return { packagePath: path.join(outDir, `${name}.ehpackage`) };
          },
        },
      },
    },
  };

  const modules = {
    [M.ehCommandManager]: { EHCommandManager },
    [M.ef]: ef,
  };

  const lib = new TestLibrary((name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  });

  return { lib, calls, projectPath, assets, activeProject };
}

test('METHODS table registers all three WS-3 tools', () => {
  assert.deepEqual(assetops.METHODS, {
    asset_properties: 'assetProperties',
    project_snapshot: 'projectSnapshot',
    asset_package: 'assetPackage',
  });
});

test('assetProperties list normalizes entries and filters by type and path_contains', async () => {
  const { lib } = createSetup();

  const all = await lib.assetProperties({ action: 'list' });
  assert.equal(all.count, 2);
  assert.deepEqual(all.assets[0], {
    guid: 'guid-tex-1',
    name: 'diffuse.png',
    type: 'Texture2D',
    file_path: 'Assets/Textures/diffuse.png',
  });
  assert.deepEqual(all.assets[1], {
    guid: 'guid-mat-1',
    name: 'skin.mat',
    type: 'Material',
    file_path: 'Assets/Materials/skin.mat',
  });

  const byType = await lib.assetProperties({ action: 'list', type: 'Material' });
  assert.equal(byType.count, 1);
  assert.equal(byType.assets[0].guid, 'guid-mat-1');

  const byPath = await lib.assetProperties({ action: 'list', path_contains: 'Textures/' });
  assert.equal(byPath.count, 1);
  assert.equal(byPath.assets[0].guid, 'guid-tex-1');
});

test('assetProperties get resolves by guid or relative path and fails closed when missing', async () => {
  const { lib } = createSetup();

  const byGuid = await lib.assetProperties({ action: 'get', guid: 'guid-tex-1' });
  assert.equal(byGuid.guid, 'guid-tex-1');
  assert.equal(byGuid.asset.properties.width.value, 512);

  const byPath = await lib.assetProperties({ action: 'get', path: 'Materials/skin.mat' });
  assert.equal(byPath.guid, 'guid-mat-1');
  assert.equal(byPath.asset.properties.roughness.value, 0.5);

  await assert.rejects(
    lib.assetProperties({ action: 'get', path: 'Assets/Missing/none.png' }),
    /ASSET_NOT_FOUND/,
  );
  await assert.rejects(
    lib.assetProperties({ action: 'get', guid: 'guid-nope' }),
    /ASSET_NOT_FOUND/,
  );
});

test('assetProperties set rejects invalid or readonly keys listing valid editable keys, and verifies readback', async () => {
  const { lib, calls } = createSetup();

  // Invalid property name -> fail closed, list valid editable keys, never call setResourceProperties
  await assert.rejects(
    lib.assetProperties({ action: 'set', guid: 'guid-tex-1', properties: { nonexistent: 1 } }),
    (err) => {
      assert.match(err.message, /INVALID_ASSET_PROPERTY/);
      assert.match(err.message, /filterMode, sRGB/);
      return true;
    },
  );
  assert.equal(calls.some((c) => c[0] === 'setResourceProperties'), false);

  // Readonly property -> fail closed, list valid editable keys, never call setResourceProperties
  await assert.rejects(
    lib.assetProperties({ action: 'set', path: 'Assets/Textures/diffuse.png', properties: { width: 1024 } }),
    (err) => {
      assert.match(err.message, /READONLY_ASSET_PROPERTY/);
      assert.match(err.message, /filterMode, sRGB/);
      return true;
    },
  );
  assert.equal(calls.some((c) => c[0] === 'setResourceProperties'), false);

  // Valid write -> updates and passes readback
  const ok = await lib.assetProperties({
    action: 'set',
    path: 'Assets/Textures/diffuse.png',
    properties: { filterMode: 'Point', sRGB: false },
  });
  assert.equal(ok.guid, 'guid-tex-1');
  assert.equal(ok.asset.properties.filterMode.value, 'Point');
  assert.equal(ok.asset.properties.sRGB.value, false);

  // Readback mismatch -> throws ASSET_PROPERTY_NOT_APPLIED
  const dropped = createSetup({ dropWrite: true });
  await assert.rejects(
    dropped.lib.assetProperties({
      action: 'set',
      guid: 'guid-tex-1',
      properties: { filterMode: 'Point' },
    }),
    /ASSET_PROPERTY_NOT_APPLIED/,
  );
});

test('projectSnapshot create, list, restore, delete lifecycle and cross-project isolation', async () => {
  const projA = tmpdir('xs-proj-iso-a-');
  const projB = tmpdir('xs-proj-iso-b-');

  const setupA = createSetup({ projectPath: projA });
  const setupB = createSetup({ projectPath: projB });

  // Create snapshot in project A
  const created = await setupA.lib.projectSnapshot({ action: 'create', label: 'before-edit' });
  assert.match(created.snapshot_id, /^snap-\d+-[0-9a-f]+$/);
  assert.equal(created.label, 'before-edit');
  assert.equal(created.git_ref, `refs/heads/snapshot/${created.snapshot_id}`);
  assert.equal(created.commit_id, 'commit-1');

  assert.deepEqual(setupA.calls[0], [
    'createProjectSnapshot',
    'xiangsu-mcp-plus',
    projA,
    created.git_ref,
  ]);

  // Verify index file path uses sha1(realProjectPath).slice(0, 12)
  const realA = fs.realpathSync(projA);
  const hashA = crypto.createHash('sha1').update(realA).digest('hex').slice(0, 12);
  const expectedIndexFile = path.join(STATE_DIR, 'snapshots', `${hashA}.json`);
  assert.equal(fs.existsSync(expectedIndexFile), true);

  // List in project A shows it; list in project B is empty
  const listA = await setupA.lib.projectSnapshot({ action: 'list' });
  assert.equal(listA.snapshots.length, 1);
  assert.equal(listA.snapshots[0].snapshot_id, created.snapshot_id);

  const listB = await setupB.lib.projectSnapshot({ action: 'list' });
  assert.equal(listB.snapshots.length, 0);

  // Restore / delete from project B fails closed
  await assert.rejects(
    setupB.lib.projectSnapshot({ action: 'restore', snapshot_id: created.snapshot_id }),
    /SNAPSHOT_NOT_FOUND/,
  );
  await assert.rejects(
    setupB.lib.projectSnapshot({ action: 'delete', snapshot_id: created.snapshot_id }),
    /SNAPSHOT_NOT_FOUND/,
  );

  // Even if project B's index file is tampered with an entry from project A, project_path mismatch fails closed
  const realB = fs.realpathSync(projB);
  const hashB = crypto.createHash('sha1').update(realB).digest('hex').slice(0, 12);
  const indexFileB = path.join(STATE_DIR, 'snapshots', `${hashB}.json`);
  fs.mkdirSync(path.dirname(indexFileB), { recursive: true });
  fs.writeFileSync(indexFileB, JSON.stringify([created], null, 2));
  await assert.rejects(
    setupB.lib.projectSnapshot({ action: 'restore', snapshot_id: created.snapshot_id }),
    /SNAPSHOT_PROJECT_MISMATCH/,
  );
  await assert.rejects(
    setupB.lib.projectSnapshot({ action: 'delete', snapshot_id: created.snapshot_id }),
    /SNAPSHOT_PROJECT_MISMATCH/,
  );

  // Restore in project A succeeds
  const restored = await setupA.lib.projectSnapshot({ action: 'restore', snapshot_id: created.snapshot_id });
  assert.equal(restored.restored, true);
  assert.deepEqual(setupA.calls.at(-1), [
    'restoreProjectSnapshot',
    'xiangsu-mcp-plus',
    projA,
    'commit-1',
    path.join(projA, '.git'),
  ]);

  // Delete in project A removes it from index
  const deleted = await setupA.lib.projectSnapshot({ action: 'delete', snapshot_id: created.snapshot_id });
  assert.equal(deleted.deleted, true);
  assert.deepEqual(setupA.calls.at(-1), [
    'deleteProjectSnapshotRefs',
    'xiangsu-mcp-plus',
    [created.git_ref],
    path.join(projA, '.git'),
  ]);

  const listAAfter = await setupA.lib.projectSnapshot({ action: 'list' });
  assert.equal(listAAfter.snapshots.length, 0);
});

test('assetPackage handles import_package, create_prefab, instantiate_prefab, and export_package with errorCode', async () => {
  const { lib, calls } = createSetup();

  const imp = await lib.assetPackage({ action: 'import_package', path: '/tmp/foo.ehpackage' });
  assert.equal(imp.action, 'import_package');
  assert.deepEqual(calls.at(-1), ['addPackage', '/tmp/foo.ehpackage']);

  const pref = await lib.assetPackage({ action: 'create_prefab', guid: 'so-1' });
  assert.equal(pref.action, 'create_prefab');
  assert.deepEqual(calls.at(-1), ['addPrefab', 'so-1']);

  const inst = await lib.assetPackage({ action: 'instantiate_prefab', guid: 'prefab-so-1' });
  assert.equal(inst.action, 'instantiate_prefab');
  assert.deepEqual(calls.at(-1), ['instantiatePrefab', 'prefab-so-1']);

  const exp = await lib.assetPackage({
    action: 'export_package',
    guids: ['so-1', 'so-2'],
    name: 'MyBundle',
    out_dir: '/tmp/out',
  });
  assert.equal(exp.action, 'export_package');
  assert.equal(exp.result.packagePath, '/tmp/out/MyBundle.ehpackage');
  assert.deepEqual(calls.at(-1), ['exportAsPrefabsPkg', ['so-1', 'so-2'], 'MyBundle', '/tmp/out']);

  // Missing scene object fails closed
  await assert.rejects(
    lib.assetPackage({
      action: 'export_package',
      guids: ['so-1', 'so-missing'],
      name: 'MyBundle',
      out_dir: '/tmp/out',
    }),
    /SCENE_OBJECT_NOT_FOUND: so-missing/,
  );

  // Non-zero errorCode fails closed
  const failing = createSetup({ exportErrorCode: 10042 });
  await assert.rejects(
    failing.lib.assetPackage({
      action: 'export_package',
      guids: ['so-1'],
      name: 'MyBundle',
      out_dir: '/tmp/out',
    }),
    /EXPORT_PACKAGE_FAILED: errorCode=10042/,
  );
});
