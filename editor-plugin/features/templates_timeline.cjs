'use strict';
// Text templates (including Lyrics/LyricsTemplate), Timeline (.timeline) inspection/authoring/beats,
// and Graph parameter (.surfacegraph / .audiograph / .vfxgraph) inspection and mutation.
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { M } = require('./common.cjs');

const DEFAULT_BUILTIN_ROOT = '/Applications/Douyin AR.app/Contents/Resources/BuiltinResource';
const GRAPH_EXTS = new Set(['.surfacegraph', '.audiograph', '.vfxgraph']);

function getActiveProject(lib) {
  const ef = lib.mod(M.ef);
  const pm = ef?._OEF_Core?.ProjectManager?.getInstance?.() ?? ef?.ProjectManager?.getInstance?.();
  if (!pm) throw Error('PROJECT_MANAGER_UNAVAILABLE');
  if (typeof pm.hasActiveProject === 'function' && !pm.hasActiveProject()) throw Error('NO_ACTIVE_PROJECT');
  const project = pm.getCurrentActiveProject?.() ?? pm.getActiveProject?.();
  if (!project || !project.path) throw Error('NO_ACTIVE_PROJECT');
  return project;
}

function realPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function resolveRealAncestor(targetPath) {
  const resolved = path.resolve(targetPath);
  const parts = [];
  let cur = resolved;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return resolved;
    parts.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(realPath(cur), ...parts);
}

function resolveInsideProject(projectPath, targetPath, { mustExist = true } = {}) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw Error('INVALID_PATH: path must be a non-empty string');
  }
  const realRoot = realPath(projectPath);
  const candidate = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(realRoot, targetPath);
  const realCandidate = fs.existsSync(candidate) ? realPath(candidate) : resolveRealAncestor(candidate);
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + path.sep)) {
    throw Error(`PATH_OUTSIDE_PROJECT: ${targetPath} is outside active project ${realRoot}`);
  }
  if (mustExist && !fs.existsSync(realCandidate)) {
    throw Error(`FILE_NOT_FOUND: ${targetPath}`);
  }
  return realCandidate;
}

function atomicWriteFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function walkFiles(rootDir, exts) {
  const results = [];
  if (!fs.existsSync(rootDir)) return results;
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && exts.has(path.extname(ent.name).toLowerCase())) {
        results.push(full);
      }
    }
  }
  return results.sort();
}

function findFileRecursive(dir, filename, maxDepth = 3) {
  if (!fs.existsSync(dir) || maxDepth < 0) return null;
  const direct = path.join(dir, filename);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (maxDepth === 0) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isDirectory()) {
      const hit = findFileRecursive(path.join(dir, ent.name), filename, maxDepth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (ent.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function scanTextTemplates(builtinRoot) {
  const root = builtinRoot || DEFAULT_BUILTIN_ROOT;
  const items = [];

  const scanGroup = (dirName, kind) => {
    const base = path.join(root, dirName);
    if (!fs.existsSync(base)) return;
    for (const ent of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!ent.isDirectory()) continue;
      const full = path.join(base, ent.name);
      const contentJson = findFileRecursive(full, 'content.json', 2);
      const configJson = findFileRecursive(full, 'config.json', 2);
      const presetJson = findFileRecursive(full, 'preset.json', 2);
      const cfg = configJson ? readJsonSafe(configJson) : null;
      items.push({
        id: ent.name,
        name: (cfg && typeof cfg.name === 'string' && cfg.name) || ent.name,
        kind,
        path: full,
        has_preset_json: Boolean(contentJson || presetJson || configJson),
      });
    }
  };

  scanGroup('TextTemplate', 'text_template');
  scanGroup('TextTemplateResource', 'text_template_resource');

  for (const lyricsId of ['Lyrics', 'LyricsTemplate']) {
    const full = path.join(root, 'InternalPlugins', lyricsId);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      const hasJson = Boolean(
        findFileRecursive(full, 'pinToGraphConfig.json', 3) ||
          findFileRecursive(full, 'content.json', 3) ||
          findFileRecursive(full, 'config.json', 3),
      );
      items.push({
        id: lyricsId,
        name: lyricsId,
        kind: 'lyrics_template',
        path: full,
        has_preset_json: hasJson,
      });
    }
  }

  return items;
}

function applyTextPropertiesToJson(jsonObj, { text, font_size, color }) {
  let updated = false;
  if (Array.isArray(jsonObj.children)) {
    for (const child of jsonObj.children) {
      const rt = child?.text_params?.richText;
      if (rt && typeof rt === 'object') {
        if (text !== undefined) {
          rt.text = text;
          updated = true;
        }
        if (Array.isArray(rt.styles) && rt.styles.length > 0) {
          const style = rt.styles[0];
          if (font_size !== undefined) {
            style.size = font_size;
            updated = true;
          }
          if (color !== undefined && style.fill?.content?.solid) {
            style.fill.content.solid.color = color;
            updated = true;
          }
        }
      }
    }
  }
  if (!updated) {
    if (text !== undefined) jsonObj.text = text;
    if (font_size !== undefined) jsonObj.font_size = font_size;
    if (color !== undefined) jsonObj.color = color;
  }
  return jsonObj;
}

function parseTimelineText(raw) {
  const parsed = yaml.parse(raw, { logLevel: 'silent' });
  const props = parsed?.serializedProperty?.properties ?? parsed?.properties ?? parsed ?? {};
  const tracks = Array.isArray(props.tracks) ? props.tracks : [];
  const beatsPoint = Array.isArray(props.beatsPoint) ? props.beatsPoint : [];
  const keyframes = [];
  for (const t of tracks) {
    if (t && Array.isArray(t.keyframes)) {
      for (const kf of t.keyframes) {
        keyframes.push({ track: t.name || t.target_guid || t.property || null, ...kf });
      }
    }
  }
  return {
    durationMode: props.durationMode ?? null,
    fixedDuration: props.fixedDuration ?? null,
    frameRate: props.frameRate ?? null,
    tracks,
    beatsPoint,
    keyframes,
  };
}

function createEmptyTimelineDoc(fps = 30) {
  const raw = [
    '%YAML 1.1',
    '--- !ScriptCustomExternalObject &1',
    'name: !<str> ""',
    'serializedProperty:',
    '  __class: ScriptSerializedProperty',
    '  name: !<str> ""',
    '  properties:',
    '    __class: Map',
    '    __scriptClassName: !<str> TimelineAsset',
    '    durationMode: 0',
    '    fixedDuration: 0',
    `    frameRate: ${fps}`,
    '',
  ].join('\n');
  return yaml.parseDocument(raw, { logLevel: 'silent' });
}

function setTimelineProp(doc, key, val) {
  const sp = doc.getIn(['serializedProperty', 'properties'], true);
  if (sp && typeof sp === 'object') {
    doc.setIn(['serializedProperty', 'properties', key], val);
  } else if (doc.get('properties', true) && typeof doc.get('properties', true) === 'object') {
    doc.setIn(['properties', key], val);
  } else {
    doc.set(key, val);
  }
}

function collectTimelinePlayers(project, lib) {
  const players = [];
  const inspectComp = (comp, obj) => {
    const typeName = comp?.constructor?.name || comp?.type || comp?.rttiType || '';
    if (!String(typeName).includes('TimelinePlayer')) return;
    players.push({
      object_name: obj?.name ?? comp?.sceneObject?.name ?? null,
      object_guid: obj?.guid ?? comp?.sceneObject?.guid ?? null,
      enabled: comp.enabled !== undefined ? Boolean(comp.enabled) : true,
      timeline_asset: comp.timelineAsset ?? comp.timeline ?? comp.assetPath ?? null,
      play_on_start: comp.playOnStart !== undefined ? Boolean(comp.playOnStart) : null,
    });
  };

  const sm = project.sceneManager;
  if (sm) {
    const objects =
      (typeof sm.getAllSceneObjects === 'function' && sm.getAllSceneObjects()) ||
      (Array.isArray(sm.sceneObjects) && sm.sceneObjects) ||
      (Array.isArray(sm.mainScene?.sceneObjects) && sm.mainScene.sceneObjects) ||
      [];
    for (const obj of objects) {
      const comps =
        (typeof obj.getAllComponents === 'function' && obj.getAllComponents()) ||
        (Array.isArray(obj.components) && obj.components) ||
        [];
      for (const comp of comps) inspectComp(comp, obj);
    }
  }

  try {
    const sceneMod = lib.mod(M.scene);
    const sceneEditor = sceneMod?.SceneModule?.getEditingSceneService?.()?.sceneEditor;
    if (sceneEditor && typeof sceneEditor.getAllComponentEditors === 'function') {
      for (const comp of sceneEditor.getAllComponentEditors()) {
        inspectComp(comp, comp.sceneObject);
      }
    }
  } catch {
    // SceneModule not required when inspecting files only
  }
  return players;
}

function parseGraphFile(absPath) {
  const raw = fs.readFileSync(absPath, 'utf8');
  let outer;
  try {
    outer = JSON.parse(raw);
  } catch {
    outer = yaml.parse(raw, { logLevel: 'silent' });
  }
  if (!outer || typeof outer !== 'object') {
    throw Error(`INVALID_GRAPH_FILE: could not parse ${absPath}`);
  }
  let inner = outer;
  let wrappedStringKey = null;
  if (typeof outer.vfxGraphData === 'string') {
    inner = JSON.parse(outer.vfxGraphData);
    wrappedStringKey = 'vfxGraphData';
  } else if (outer.vfxGraphData && typeof outer.vfxGraphData === 'object') {
    inner = outer.vfxGraphData;
  }
  return { outer, inner, wrappedStringKey };
}

function findParamContainers(inner) {
  const containers = [];
  const graph = inner.graph && typeof inner.graph === 'object' ? inner.graph : inner;
  for (const key of ['paramList', 'parameters', 'uniforms', 'exposedParams', 'params']) {
    if (Array.isArray(graph[key])) {
      containers.push({ kind: 'array', list: graph[key] });
    } else if (graph[key] && typeof graph[key] === 'object') {
      containers.push({ kind: 'map', map: graph[key] });
    }
    if (graph !== inner) {
      if (Array.isArray(inner[key])) {
        containers.push({ kind: 'array', list: inner[key] });
      } else if (inner[key] && typeof inner[key] === 'object') {
        containers.push({ kind: 'map', map: inner[key] });
      }
    }
  }
  if (Array.isArray(graph.nodeList)) {
    const exposedNodes = graph.nodeList.filter(
      (n) => n && typeof n === 'object' && (n.exposed === true || n.isExposed === true || n.nodeType === 'PARAMETER' || n.nodeType === 'UNIFORM'),
    );
    if (exposedNodes.length) {
      containers.push({ kind: 'array', list: exposedNodes });
    }
  }
  return containers;
}

function extractGraphParams(inner) {
  const params = [];
  const seen = new Set();
  for (const c of findParamContainers(inner)) {
    if (c.kind === 'array') {
      for (const item of c.list) {
        if (!item || typeof item !== 'object') continue;
        const name = item.name ?? item.paramName ?? item.key;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const value = 'value' in item ? item.value : 'defaultValue' in item ? item.defaultValue : item.val;
        params.push({ name: String(name), type: item.type ?? item.valueType ?? item.dataType ?? 'unknown', value });
      }
    } else if (c.kind === 'map') {
      for (const [name, entry] of Object.entries(c.map)) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (entry && typeof entry === 'object' && !Array.isArray(entry) && ('value' in entry || 'defaultValue' in entry || 'type' in entry)) {
          const value = 'value' in entry ? entry.value : entry.defaultValue;
          params.push({ name, type: entry.type ?? entry.valueType ?? 'unknown', value });
        } else {
          params.push({ name, type: typeof entry, value: entry });
        }
      }
    }
  }
  return params;
}

function updateGraphParam(inner, paramName, newValue) {
  for (const c of findParamContainers(inner)) {
    if (c.kind === 'array') {
      for (const item of c.list) {
        if (!item || typeof item !== 'object') continue;
        const name = item.name ?? item.paramName ?? item.key;
        if (String(name) === paramName) {
          const prev = 'value' in item ? item.value : 'defaultValue' in item ? item.defaultValue : item.val;
          if ('value' in item) item.value = newValue;
          else if ('defaultValue' in item) item.defaultValue = newValue;
          else if ('val' in item) item.val = newValue;
          else item.value = newValue;
          return prev;
        }
      }
    } else if (c.kind === 'map') {
      if (Object.prototype.hasOwnProperty.call(c.map, paramName)) {
        const entry = c.map[paramName];
        if (entry && typeof entry === 'object' && !Array.isArray(entry) && ('value' in entry || 'defaultValue' in entry || 'type' in entry)) {
          const prev = 'value' in entry ? entry.value : entry.defaultValue;
          if ('value' in entry) entry.value = newValue;
          else entry.defaultValue = newValue;
          return prev;
        }
        c.map[paramName] = newValue;
        return entry;
      }
    }
  }
  return undefined;
}

function valuesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const methods = {
  async textTemplate({ action, id, kind, text, font_size, color, parent_guid, builtin_root } = {}) {
    if (action === 'list') {
      return { items: scanTextTemplates(builtin_root) };
    }
    if (action !== 'apply') {
      throw Error(`INVALID_ACTION: text_template action must be "list" or "apply", got ${JSON.stringify(action)}`);
    }
    if (typeof id !== 'string' || !id.trim()) {
      throw Error('INVALID_ARGUMENTS: id is required for text_template apply');
    }
    if (font_size !== undefined && (typeof font_size !== 'number' || !Number.isFinite(font_size) || font_size <= 0)) {
      throw Error('INVALID_FONT_SIZE: font_size must be a finite positive number');
    }
    const catalog = scanTextTemplates(builtin_root);
    const match =
      (kind ? catalog.find((it) => it.id === id && it.kind === kind) : null) ||
      catalog.find((it) => it.id === id);
    if (!match) {
      throw Error(`TEXT_TEMPLATE_NOT_FOUND: ${id}; available: ${catalog.map((c) => c.id).join(', ') || '(none)'}`);
    }

    const effectiveKind = kind || match.kind;
    const project = getActiveProject(this);
    const properties = {
      ...(text !== undefined ? { text } : {}),
      ...(font_size !== undefined ? { font_size } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(parent_guid !== undefined ? { parent_guid } : {}),
    };

    if (effectiveKind === 'lyrics_template' || id === 'Lyrics' || id === 'LyricsTemplate') {
      let createdEntity = null;
      try {
        const ui = this.mod(M.orionui);
        const ef = this.mod(M.ef);
        const sceneOps = this.mod(M.sceneOps);
        const sceneMod = this.mod(M.scene);
        const sceneEditor = sceneMod?.SceneModule?.getEditingSceneService?.()?.sceneEditor;
        const emc = ui?.ExtensionManager?.host?.getAPI?.(ef?.Extension?.MenuConfig?.MenuConfigAPIKey)?.getEntityMenuConfig?.();
        const cfg = emc?.getConfig?.(id) || emc?.getConfig?.('LyricsTemplate') || emc?.getConfig?.('Lyrics');
        if (sceneEditor && sceneOps?.createEntity && cfg) {
          createdEntity = await sceneOps.createEntity(sceneEditor, cfg, id, () => {});
        }
      } catch {
        // Fallback to project asset staging / sceneManager below when editor UI services are unavailable.
      }
      if (!createdEntity && project.sceneManager?.createEntity) {
        createdEntity = await project.sceneManager.createEntity({ name: id, component: 'Lyrics', parent_guid, ...properties });
      }
      const destDir = path.join(project.path, 'Assets', 'TextTemplate', id);
      copyDirRecursive(match.path, destDir);
      return {
        applied: true,
        id,
        kind: effectiveKind,
        asset_path: destDir,
        ...(createdEntity ? { entity: createdEntity } : {}),
        properties,
      };
    }

    const destDir = path.join(project.path, 'Assets', 'TextTemplate', id);
    copyDirRecursive(match.path, destDir);

    const contentJsonPath = findFileRecursive(destDir, 'content.json', 2);
    if (contentJsonPath && (text !== undefined || font_size !== undefined || color !== undefined)) {
      const parsed = readJsonSafe(contentJsonPath);
      if (parsed) {
        applyTextPropertiesToJson(parsed, { text, font_size, color });
        atomicWriteFile(contentJsonPath, JSON.stringify(parsed, null, 2));
      }
    }

    if (project.sceneManager?.createEntity) {
      await project.sceneManager.createEntity({
        name: id,
        component: 'ScriptTemplateLoader',
        asset_path: destDir,
        parent_guid,
        ...properties,
      });
    }

    return {
      applied: true,
      id,
      kind: effectiveKind,
      asset_path: destDir,
      properties,
    };
  },

  timeline({ action, timeline_path, tracks, beats, fps = 30, target_guid, property } = {}) {
    const project = getActiveProject(this);

    if (action === 'inspect') {
      const files = timeline_path
        ? [resolveInsideProject(project.path, timeline_path, { mustExist: true })]
        : walkFiles(path.join(project.path, 'Assets'), new Set(['.timeline']));
      const timelines = files.map((absPath) => {
        const raw = fs.readFileSync(absPath, 'utf8');
        const info = parseTimelineText(raw);
        return {
          path: absPath,
          relative_path: path.relative(realPath(project.path), absPath),
          ...info,
        };
      });
      const timeline_players = collectTimelinePlayers(project, this);
      return { timelines, timeline_players };
    }

    if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) {
      throw Error('INVALID_FPS: fps must be a finite positive number');
    }

    if (action === 'set_tracks') {
      if (typeof timeline_path !== 'string' || !timeline_path.trim().endsWith('.timeline')) {
        throw Error('INVALID_TIMELINE_PATH: timeline_path must end with .timeline');
      }
      if (!Array.isArray(tracks)) {
        throw Error('INVALID_TRACKS: tracks must be an array');
      }
      const absPath = resolveInsideProject(project.path, timeline_path, { mustExist: false });
      const doc = fs.existsSync(absPath)
        ? yaml.parseDocument(fs.readFileSync(absPath, 'utf8'), { logLevel: 'silent' })
        : createEmptyTimelineDoc(fps);

      let maxTime = 0;
      for (const tr of tracks) {
        if (tr && Array.isArray(tr.keyframes)) {
          for (const kf of tr.keyframes) {
            const t = typeof kf?.time === 'number' ? kf.time : typeof kf?.frame === 'number' ? kf.frame / fps : 0;
            if (Number.isFinite(t) && t > maxTime) maxTime = t;
          }
        }
      }
      const prevParsed = fs.existsSync(absPath) ? parseTimelineText(fs.readFileSync(absPath, 'utf8')) : { fixedDuration: 0 };
      const fixedDuration = Math.max(Number(prevParsed.fixedDuration) || 0, maxTime);

      setTimelineProp(doc, 'frameRate', fps);
      setTimelineProp(doc, 'tracks', tracks);
      setTimelineProp(doc, 'fixedDuration', fixedDuration);

      atomicWriteFile(absPath, doc.toString());

      const readback = parseTimelineText(fs.readFileSync(absPath, 'utf8'));
      if (readback.frameRate !== fps || readback.tracks.length !== tracks.length || readback.fixedDuration !== fixedDuration) {
        throw Error(`WRITE_VERIFICATION_FAILED: timeline readback mismatch for ${timeline_path}`);
      }
      return {
        timeline_path: absPath,
        frameRate: readback.frameRate,
        fixedDuration: readback.fixedDuration,
        tracks: readback.tracks,
      };
    }

    if (action === 'import_beats') {
      if (typeof timeline_path !== 'string' || !timeline_path.trim().endsWith('.timeline')) {
        throw Error('INVALID_TIMELINE_PATH: timeline_path must end with .timeline');
      }
      if (!Array.isArray(beats) || beats.length === 0 || beats.some((b) => typeof b !== 'number' || !Number.isFinite(b) || b < 0)) {
        throw Error('INVALID_BEATS: beats must be a non-empty array of finite non-negative numbers');
      }
      const absPath = resolveInsideProject(project.path, timeline_path, { mustExist: false });
      const doc = fs.existsSync(absPath)
        ? yaml.parseDocument(fs.readFileSync(absPath, 'utf8'), { logLevel: 'silent' })
        : createEmptyTimelineDoc(fps);

      const prevParsed = fs.existsSync(absPath) ? parseTimelineText(fs.readFileSync(absPath, 'utf8')) : { fixedDuration: 0, tracks: [] };
      const beatsPoint = beats.map((t) => ({ time: t, frame: Math.round(t * fps) }));
      const maxBeat = Math.max(...beats);
      const fixedDuration = Math.max(Number(prevParsed.fixedDuration) || 0, maxBeat);

      const nextTracks = [...prevParsed.tracks];
      if (target_guid) {
        const propName = property || 'beat';
        const beatTrack = {
          target_guid,
          property: propName,
          keyframes: beats.map((t, idx) => ({
            time: t,
            frame: Math.round(t * fps),
            value: idx % 2 === 0 ? 1 : 0,
            beat: true,
          })),
        };
        const existingIdx = nextTracks.findIndex((tr) => tr?.target_guid === target_guid && tr?.property === propName);
        if (existingIdx >= 0) nextTracks[existingIdx] = beatTrack;
        else nextTracks.push(beatTrack);
        setTimelineProp(doc, 'tracks', nextTracks);
      }

      setTimelineProp(doc, 'frameRate', fps);
      setTimelineProp(doc, 'beatsPoint', beatsPoint);
      setTimelineProp(doc, 'fixedDuration', fixedDuration);

      atomicWriteFile(absPath, doc.toString());

      const readback = parseTimelineText(fs.readFileSync(absPath, 'utf8'));
      if (readback.beatsPoint.length !== beats.length || readback.fixedDuration < maxBeat) {
        throw Error(`WRITE_VERIFICATION_FAILED: beats readback mismatch for ${timeline_path}`);
      }
      if (target_guid) {
        const propName = property || 'beat';
        const tr = readback.tracks.find((t) => t?.target_guid === target_guid && t?.property === propName);
        if (!tr || !Array.isArray(tr.keyframes) || tr.keyframes.length !== beats.length) {
          throw Error(`WRITE_VERIFICATION_FAILED: beat keyframe track missing in ${timeline_path}`);
        }
      }
      return {
        timeline_path: absPath,
        beats_count: readback.beatsPoint.length,
        beatsPoint: readback.beatsPoint,
        frameRate: readback.frameRate,
        fixedDuration: readback.fixedDuration,
        tracks: readback.tracks,
      };
    }

    throw Error(`INVALID_ACTION: timeline action must be "inspect", "set_tracks", or "import_beats", got ${JSON.stringify(action)}`);
  },

  graphParams({ action, graph_path, param_name, value } = {}) {
    const project = getActiveProject(this);

    if (action === 'inspect') {
      const files = graph_path
        ? [resolveInsideProject(project.path, graph_path, { mustExist: true })]
        : walkFiles(path.join(project.path, 'Assets'), GRAPH_EXTS);
      const graphs = files.map((absPath) => {
        const { inner } = parseGraphFile(absPath);
        return {
          path: absPath,
          relative_path: path.relative(realPath(project.path), absPath),
          kind: path.extname(absPath).slice(1).toLowerCase(),
          params: extractGraphParams(inner),
        };
      });
      return { graphs };
    }

    if (action === 'set') {
      if (typeof graph_path !== 'string' || !graph_path.trim()) {
        throw Error('INVALID_ARGUMENTS: graph_path is required');
      }
      if (typeof param_name !== 'string' || !param_name.trim()) {
        throw Error('INVALID_ARGUMENTS: param_name is required');
      }
      if (value === undefined) {
        throw Error('INVALID_ARGUMENTS: value is required');
      }
      const absPath = resolveInsideProject(project.path, graph_path, { mustExist: true });
      const { outer, inner, wrappedStringKey } = parseGraphFile(absPath);
      const params = extractGraphParams(inner);
      if (!params.some((p) => p.name === param_name)) {
        throw Error(
          `GRAPH_PARAM_NOT_FOUND: "${param_name}" not found in ${graph_path}; valid params: ${params.map((p) => p.name).join(', ') || '(none)'}`,
        );
      }
      const previous_value = updateGraphParam(inner, param_name, value);
      if (wrappedStringKey) {
        outer[wrappedStringKey] = JSON.stringify(inner);
      }
      atomicWriteFile(absPath, JSON.stringify(outer, null, 2));

      const verified = parseGraphFile(absPath);
      const verifiedParam = extractGraphParams(verified.inner).find((p) => p.name === param_name);
      if (!verifiedParam || !valuesEqual(verifiedParam.value, value)) {
        throw Error(`WRITE_VERIFICATION_FAILED: param "${param_name}" did not persist in ${graph_path}`);
      }
      return {
        graph_path: absPath,
        param_name,
        previous_value,
        value: verifiedParam.value,
      };
    }

    throw Error(`INVALID_ACTION: graph_params action must be "inspect" or "set", got ${JSON.stringify(action)}`);
  },
};

const METHODS = {
  text_template: 'textTemplate',
  timeline: 'timeline',
  graph_params: 'graphParams',
};

module.exports = {
  methods,
  METHODS,
  DEFAULT_BUILTIN_ROOT,
  scanTextTemplates,
  parseTimelineText,
  extractGraphParams,
};
