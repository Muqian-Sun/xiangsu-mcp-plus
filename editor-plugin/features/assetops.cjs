'use strict';
// Asset properties, project snapshots, and asset package operations backed by EHCommandManager,
// ConversationProjectSnapshotHost, and EditorFramework.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const { M, STATE_ROOT } = require('./common.cjs');

const CONVERSATION_ID = 'xiangsu-mcp-plus';
const SNAPSHOTS_DIR = path.join(STATE_ROOT, 'snapshots');

function getEhm(lib) {
  const mod = lib.mod(M.ehCommandManager);
  if (!mod) throw Error('EH_COMMAND_MANAGER_UNAVAILABLE');
  const Mgr = mod.EHCommandManager || mod.default || mod;
  if (typeof Mgr === 'function') return new Mgr();
  if (Mgr && typeof Mgr.getAllAssets === 'function') return Mgr;
  throw Error('EH_COMMAND_MANAGER_INVALID');
}

function getActiveProject(ef) {
  const pm = ef?._OEF_Core?.ProjectManager?.getInstance?.() ?? ef?.ProjectManager?.getInstance?.();
  if (!pm) throw Error('PROJECT_MANAGER_UNAVAILABLE');
  if (typeof pm.hasActiveProject === 'function' && !pm.hasActiveProject()) throw Error('NO_ACTIVE_PROJECT');
  const project = pm.getCurrentActiveProject?.() ?? pm.getActiveProject?.();
  if (!project || !project.path) throw Error('NO_ACTIVE_PROJECT');
  return project;
}

function resolveRealPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function snapshotIndexFile(realProjectPath) {
  const projectHash = crypto.createHash('sha1').update(realProjectPath).digest('hex').slice(0, 12);
  return path.join(SNAPSHOTS_DIR, `${projectHash}.json`);
}

function readSnapshotIndex(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw Error('CORRUPT_SNAPSHOT_INDEX: expected JSON array');
    return parsed;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function writeSnapshotIndex(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function normalizeAssetEntry(a) {
  return {
    guid: a.guid?.data ?? a.guid,
    name: a.name?.data ?? a.name,
    type: a.type?.data ?? a.type,
    file_path: a.filePath?.data ?? a.filePath,
  };
}

function extractAssetList(raw) {
  if (!raw) throw Error('GET_ALL_ASSETS_FAILED: empty response');
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.assets)) return raw.assets;
  if (Array.isArray(raw.data)) return raw.data;
  throw Error('GET_ALL_ASSETS_FAILED: unexpected response shape');
}

function normalizeRelPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

async function resolveAssetGuid(ehm, guid, relPath) {
  if (typeof guid === 'string' && guid.trim()) return guid.trim();
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw Error('INVALID_ARGUMENTS: guid or path is required');
  }
  const list = extractAssetList(await ehm.getAllAssets()).map(normalizeAssetEntry);
  const want = normalizeRelPath(relPath.trim());
  let hits = list.filter((a) => typeof a.file_path === 'string' && normalizeRelPath(a.file_path) === want);
  if (hits.length === 0) {
    hits = list.filter((a) => typeof a.file_path === 'string' && normalizeRelPath(a.file_path).endsWith(`/${want}`));
  }
  if (hits.length === 0) throw Error(`ASSET_NOT_FOUND: no asset matching path "${relPath}"`);
  if (hits.length > 1) {
    throw Error(`AMBIGUOUS_ASSET_PATH: "${relPath}" matches ${hits.map((h) => h.file_path).join(' | ')}`);
  }
  if (!hits[0].guid) throw Error(`ASSET_NOT_FOUND: matched asset for "${relPath}" has no guid`);
  return String(hits[0].guid);
}

function extractAssetProperties(asset) {
  const raw = asset?.properties ?? asset?.data?.properties ?? (asset && typeof asset === 'object' && !Array.isArray(asset) ? asset : null);
  if (!raw || typeof raw !== 'object') {
    throw Error('INVALID_ASSET_SHAPE: asset has no properties');
  }
  const map = new Map();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const key = item.name ?? item.key ?? item.id;
      if (key !== undefined) map.set(String(key), item);
    }
  } else {
    for (const [k, v] of Object.entries(raw)) {
      map.set(k, v);
    }
  }
  return map;
}

function isReadonlyProp(entry) {
  return Boolean(entry && typeof entry === 'object' && entry.readonly === true);
}

function getPropValue(entry) {
  if (entry && typeof entry === 'object') {
    if ('value' in entry) return entry.value;
    if ('data' in entry) return entry.data;
  }
  return entry;
}

function assertNoErrorResult(res, code) {
  if (res instanceof Error) throw Error(`${code}: ${res.message}`);
  if (res && typeof res === 'object') {
    if (res.errorCode !== undefined && res.errorCode !== null && res.errorCode !== 0 && res.errorCode !== '') {
      throw Error(`${code}: errorCode=${res.errorCode}${res.message ? ` (${res.message})` : ''}`);
    }
    if (res.success === false) {
      const msg = res.error?.message || res.error || res.message || 'operation failed';
      throw Error(`${code}: ${msg}`);
    }
    if (res.error) {
      const msg = res.error?.message || String(res.error);
      throw Error(`${code}: ${msg}`);
    }
  }
}

function resolveSceneObjects(ef, guids) {
  const project = getActiveProject(ef);
  const sm = project.sceneManager;
  if (!sm) throw Error('NO_ACTIVE_SCENE_MANAGER');
  const findOne = (g) => {
    if (typeof sm.findSceneObjectByGuid === 'function') return sm.findSceneObjectByGuid(g);
    if (typeof sm.getSceneObject === 'function') return sm.getSceneObject(g);
    if (typeof sm.mainScene?.findSceneObjectByGuid === 'function') return sm.mainScene.findSceneObjectByGuid(g);
    if (typeof sm.mainScene?.getSceneObject === 'function') return sm.mainScene.getSceneObject(g);
    throw Error('SCENE_OBJECT_LOOKUP_UNAVAILABLE');
  };
  return guids.map((g) => {
    const obj = findOne(g);
    if (!obj) throw Error(`SCENE_OBJECT_NOT_FOUND: ${g}`);
    return obj;
  });
}

const methods = {
  async assetProperties({ action, guid, path: relPath, type, path_contains, properties } = {}) {
    this.ensureCompatible('assetOps');
    const ehm = getEhm(this);

    if (action === 'list') {
      const all = extractAssetList(await ehm.getAllAssets()).map(normalizeAssetEntry);
      const filtered = all.filter((item) => {
        if (type !== undefined && type !== null && type !== '' && item.type !== type) return false;
        if (path_contains !== undefined && path_contains !== null && path_contains !== '') {
          if (typeof item.file_path !== 'string' || !item.file_path.includes(path_contains)) return false;
        }
        return true;
      });
      return { assets: filtered, count: filtered.length };
    }

    if (action === 'get') {
      const resolvedGuid = await resolveAssetGuid(ehm, guid, relPath);
      const asset = await ehm.getAsset(resolvedGuid);
      if (!asset) throw Error(`ASSET_NOT_FOUND: ${resolvedGuid}`);
      assertNoErrorResult(asset, 'GET_ASSET_FAILED');
      return { guid: resolvedGuid, asset };
    }

    if (action === 'set') {
      if (!properties || typeof properties !== 'object' || Array.isArray(properties) || Object.keys(properties).length === 0) {
        throw Error('INVALID_ARGUMENTS: properties must be a non-empty object');
      }
      const resolvedGuid = await resolveAssetGuid(ehm, guid, relPath);
      const beforeAsset = await ehm.getAsset(resolvedGuid);
      if (!beforeAsset) throw Error(`ASSET_NOT_FOUND: ${resolvedGuid}`);
      assertNoErrorResult(beforeAsset, 'GET_ASSET_FAILED');

      const propMap = extractAssetProperties(beforeAsset);
      const validEditableKeys = [...propMap.entries()].filter(([, v]) => !isReadonlyProp(v)).map(([k]) => k);

      for (const key of Object.keys(properties)) {
        if (!propMap.has(key)) {
          throw Error(`INVALID_ASSET_PROPERTY: "${key}" does not exist on ${resolvedGuid}; valid editable keys: ${validEditableKeys.join(', ') || '(none)'}`);
        }
        if (isReadonlyProp(propMap.get(key))) {
          throw Error(`READONLY_ASSET_PROPERTY: "${key}" is readonly on ${resolvedGuid}; valid editable keys: ${validEditableKeys.join(', ') || '(none)'}`);
        }
      }

      const setRes = await ehm.setResourceProperties(resolvedGuid, properties);
      assertNoErrorResult(setRes, 'SET_ASSET_PROPERTIES_FAILED');

      const afterAsset = await ehm.getAsset(resolvedGuid);
      if (!afterAsset) throw Error(`ASSET_NOT_FOUND: ${resolvedGuid} disappeared after set`);
      assertNoErrorResult(afterAsset, 'GET_ASSET_FAILED');

      const afterMap = extractAssetProperties(afterAsset);
      for (const [key, expectedVal] of Object.entries(properties)) {
        const actualVal = getPropValue(afterMap.get(key));
        if (!util.isDeepStrictEqual(actualVal, expectedVal)) {
          throw Error(`ASSET_PROPERTY_NOT_APPLIED: "${key}" expected ${JSON.stringify(expectedVal)}, got ${JSON.stringify(actualVal)}`);
        }
      }

      return { guid: resolvedGuid, updated: properties, asset: afterAsset };
    }

    throw Error(`INVALID_ACTION: ${action}; valid: list, get, set`);
  },

  async projectSnapshot({ action, label, snapshot_id } = {}) {
    this.ensureCompatible('assetOps');
    const ef = this.mod(M.ef);
    const project = getActiveProject(ef);
    const projectPath = project.path;
    const realProjectPath = resolveRealPath(projectPath);
    const indexFile = snapshotIndexFile(realProjectPath);
    const ehm = getEhm(this);

    if (action === 'create') {
      const rand = crypto.randomBytes(3).toString('hex');
      const id = `snap-${Date.now()}-${rand}`;
      const gitRef = `refs/heads/snapshot/${id}`;
      const res = await ehm.createProjectSnapshot(CONVERSATION_ID, projectPath, gitRef);
      assertNoErrorResult(res, 'CREATE_SNAPSHOT_FAILED');
      const commitId = res?.commitId ?? res?.commit_id;
      const gitRepoPath = res?.gitRepoPath ?? res?.git_repo_path;
      if (!commitId || !gitRepoPath) {
        throw Error('CREATE_SNAPSHOT_FAILED: host did not return commitId and gitRepoPath');
      }
      const entry = {
        snapshot_id: id,
        label: label ?? null,
        project_path: realProjectPath,
        created_at: new Date().toISOString(),
        commit_id: commitId,
        git_ref: gitRef,
        git_repo_path: gitRepoPath,
      };
      const entries = readSnapshotIndex(indexFile);
      entries.push(entry);
      writeSnapshotIndex(indexFile, entries);
      return entry;
    }

    if (action === 'list') {
      const entries = readSnapshotIndex(indexFile).filter(
        (e) => resolveRealPath(e.project_path) === realProjectPath,
      );
      return { project_path: realProjectPath, snapshots: entries };
    }

    if (action === 'restore') {
      if (typeof snapshot_id !== 'string' || !snapshot_id.trim()) {
        throw Error('INVALID_ARGUMENTS: snapshot_id is required');
      }
      const entries = readSnapshotIndex(indexFile);
      const entry = entries.find((e) => e.snapshot_id === snapshot_id);
      if (!entry) throw Error(`SNAPSHOT_NOT_FOUND: ${snapshot_id}`);
      if (resolveRealPath(entry.project_path) !== realProjectPath) {
        throw Error(`SNAPSHOT_PROJECT_MISMATCH: ${snapshot_id} belongs to ${entry.project_path}, current is ${realProjectPath}`);
      }
      const res = await ehm.restoreProjectSnapshot(CONVERSATION_ID, projectPath, entry.commit_id, entry.git_repo_path);
      assertNoErrorResult(res, 'RESTORE_SNAPSHOT_FAILED');
      return { restored: true, snapshot: entry, ...(res && typeof res === 'object' ? { result: res } : {}) };
    }

    if (action === 'delete') {
      if (typeof snapshot_id !== 'string' || !snapshot_id.trim()) {
        throw Error('INVALID_ARGUMENTS: snapshot_id is required');
      }
      const entries = readSnapshotIndex(indexFile);
      const idx = entries.findIndex((e) => e.snapshot_id === snapshot_id);
      if (idx === -1) throw Error(`SNAPSHOT_NOT_FOUND: ${snapshot_id}`);
      const entry = entries[idx];
      if (resolveRealPath(entry.project_path) !== realProjectPath) {
        throw Error(`SNAPSHOT_PROJECT_MISMATCH: ${snapshot_id} belongs to ${entry.project_path}, current is ${realProjectPath}`);
      }
      const res = await ehm.deleteProjectSnapshotRefs(CONVERSATION_ID, [entry.git_ref], entry.git_repo_path);
      assertNoErrorResult(res, 'DELETE_SNAPSHOT_FAILED');
      entries.splice(idx, 1);
      writeSnapshotIndex(indexFile, entries);
      return { deleted: true, snapshot_id, git_ref: entry.git_ref };
    }

    throw Error(`INVALID_ACTION: ${action}; valid: create, list, restore, delete`);
  },

  async assetPackage({ action, path: pkgPath, guid, guids, name, out_dir } = {}) {
    this.ensureCompatible('assetOps');
    const ehm = getEhm(this);

    if (action === 'import_package') {
      if (typeof pkgPath !== 'string' || !pkgPath.trim()) {
        throw Error('INVALID_ARGUMENTS: path is required for import_package');
      }
      const res = await ehm.addPackage(pkgPath);
      assertNoErrorResult(res, 'IMPORT_PACKAGE_FAILED');
      return { action: 'import_package', path: pkgPath, result: res };
    }

    if (action === 'create_prefab') {
      if (typeof guid !== 'string' || !guid.trim()) {
        throw Error('INVALID_ARGUMENTS: guid is required for create_prefab');
      }
      const res = await ehm.addPrefab(guid);
      assertNoErrorResult(res, 'CREATE_PREFAB_FAILED');
      return { action: 'create_prefab', guid, result: res };
    }

    if (action === 'instantiate_prefab') {
      if (typeof guid !== 'string' || !guid.trim()) {
        throw Error('INVALID_ARGUMENTS: guid is required for instantiate_prefab');
      }
      const res = await ehm.instantiatePrefab(guid);
      assertNoErrorResult(res, 'INSTANTIATE_PREFAB_FAILED');
      return { action: 'instantiate_prefab', guid, result: res };
    }

    if (action === 'export_package') {
      if (!Array.isArray(guids) || guids.length === 0) {
        throw Error('INVALID_ARGUMENTS: guids must be a non-empty array');
      }
      if (typeof name !== 'string' || !name.trim()) {
        throw Error('INVALID_ARGUMENTS: name is required for export_package');
      }
      if (typeof out_dir !== 'string' || !out_dir.trim()) {
        throw Error('INVALID_ARGUMENTS: out_dir is required for export_package');
      }
      const ef = this.mod(M.ef);
      const sceneObjs = resolveSceneObjects(ef, guids);
      const pkgMgr = ef?.Resource?.AssetPackageManager?.instance;
      if (!pkgMgr || typeof pkgMgr.exportAsPrefabsPkg !== 'function') {
        throw Error('ASSET_PACKAGE_MANAGER_UNAVAILABLE');
      }
      const res = await pkgMgr.exportAsPrefabsPkg(sceneObjs, name, out_dir);
      assertNoErrorResult(res, 'EXPORT_PACKAGE_FAILED');
      return { action: 'export_package', name, out_dir, guids, result: res };
    }

    throw Error(`INVALID_ACTION: ${action}; valid: import_package, create_prefab, instantiate_prefab, export_package`);
  },
};

const METHODS = {
  asset_properties: 'assetProperties',
  project_snapshot: 'projectSnapshot',
  asset_package: 'assetPackage',
};

module.exports = { methods, METHODS, snapshotIndexFile };
