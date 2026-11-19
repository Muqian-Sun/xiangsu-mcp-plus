'use strict';
// WS-5: Built-in scene text/lyrics templates, Timeline@1.0.17 track/beat editing, and
// .surfacegraph/.vfxgraph exposed parameter inspection & editing. Zero third-party npm deps.
const fs = require('fs');
const path = require('path');
const {
  M,
  editingScene,
  sceneObjectSet,
  addedObjectEditors,
  describeAdded,
  projectResources,
  packageRootsAdded,
  recordImport,
} = require('./common.cjs');

const DEFAULT_BUILTIN_ROOT = '/Applications/Douyin AR.app/Contents/Resources/BuiltinResource';
const PLUGINS_ROOT = '/Applications/Douyin AR.app/Contents/Plugins';
const GRAPH_EXTS = new Set(['.surfacegraph', '.vfxgraph']);

function walkFiles(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'Library' || ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      walkFiles(full, predicate, out);
    } else if (ent.isFile() && predicate(full, ent.name)) {
      out.push(full);
    }
  }
  return out;
}

function resolveInsideProject(projectPath, relOrAbs) {
  if (typeof relOrAbs !== 'string' || !relOrAbs.trim()) {
    throw Error('INVALID_ARGUMENTS: path is required');
  }
  const realProj = fs.realpathSync(projectPath);
  const abs = path.isAbsolute(relOrAbs) ? path.resolve(relOrAbs) : path.resolve(realProj, relOrAbs);
  const rel = path.relative(realProj, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Error(`PATH_OUTSIDE_PROJECT: ${relOrAbs} is outside ${projectPath}`);
  }
  return { abs, rel: rel.replace(/\\/g, '/') };
}

function findTimelinePluginDir() {
  if (!fs.existsSync(PLUGINS_ROOT)) return null;
  const hit = fs.readdirSync(PLUGINS_ROOT).find((d) => d.startsWith('Timeline@'));
  return hit ? path.join(PLUGINS_ROOT, hit) : null;
}

function loadTimelineApi(customLoader) {
  if (typeof customLoader === 'function') return customLoader();
  const dir = findTimelinePluginDir();
  if (!dir) throw Error('TIMELINE_PLUGIN_NOT_FOUND: Timeline@* plugin directory not found');
  return require(path.join(dir, 'lib', 'plugin', 'api.js'));
}

function parseColor(color) {
  if (color && typeof color === 'object' && 'r' in color && 'g' in color && 'b' in color) {
    return { r: Number(color.r), g: Number(color.g), b: Number(color.b), a: color.a === undefined ? 1 : Number(color.a) };
  }
  if (typeof color === 'string') {
    const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
    if (m) {
      const hex = m[1];
      const aHex = m[2];
      return {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
        a: aHex ? parseInt(aHex, 16) / 255 : 1,
      };
    }
  }
  throw Error(`INVALID_COLOR: expected #RRGGBB[AA] or {r,g,b,a}, got ${JSON.stringify(color)}`);
}

function scanTextTemplates(builtinRoot) {
  const items = [
    { id: 'ScreenTextJS', name: '2D屏幕文字 (Text2D)', kind: 'scene_text', path: null, scene_addable: true },
    { id: 'Text3D', name: '3D文字 (Text3D)', kind: 'scene_text', path: null, scene_addable: true },
  ];
  const ttDir = path.join(builtinRoot, 'TextTemplate');
  if (fs.existsSync(ttDir)) {
    for (const ent of fs.readdirSync(ttDir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        items.push({ id: ent.name, name: ent.name, kind: 'icon_text_template', path: path.join(ttDir, ent.name), scene_addable: false });
      }
    }
  }
  const ttrDir = path.join(builtinRoot, 'TextTemplateResource');
  if (fs.existsSync(ttrDir)) {
    for (const ent of fs.readdirSync(ttrDir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        items.push({ id: ent.name, name: ent.name, kind: 'text_template_resource', path: path.join(ttrDir, ent.name), scene_addable: false });
      }
    }
  }
  for (const name of ['Lyrics', 'LyricsTemplate']) {
    const p = path.join(builtinRoot, 'InternalPlugins', name);
    if (fs.existsSync(p)) {
      items.push({ id: name, name, kind: 'lyrics_template', path: p, scene_addable: false });
    }
  }
  return items;
}

function walkSurfaceNodes(nodeList, out = []) {
  if (!Array.isArray(nodeList)) return out;
  for (const node of nodeList) {
    if (!node || typeof node !== 'object') continue;
    out.push(node);
    if (Array.isArray(node.subContainer?.graph?.nodeList)) {
      walkSurfaceNodes(node.subContainer.graph.nodeList, out);
    }
  }
  return out;
}

function extractSurfaceParams(doc) {
  const params = [];
  const nodes = walkSurfaceNodes(doc?.graph?.nodeList);
  for (const node of nodes) {
    if (node.showInProperty === true && node.name) {
      if (node.__class === 'Vec4Node' || node.__class === 'ColorPickNode') {
        params.push({ name: node.name, type: node.__class, value: { x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0, w: node.w ?? 1 }, source: 'showInProperty' });
      } else if (node.__class === 'Vec3Node') {
        params.push({ name: node.name, type: node.__class, value: { x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 }, source: 'showInProperty' });
      } else if (node.__class === 'Vec2Node') {
        params.push({ name: node.name, type: node.__class, value: { x: node.x ?? 0, y: node.y ?? 0 }, source: 'showInProperty' });
      } else if ('value' in node) {
        params.push({ name: node.name, type: node.__class || 'Scalar', value: node.value, source: 'showInProperty' });
      }
    }
    if (node.isExpandUniform === true && Array.isArray(node.uniformName) && Array.isArray(node.inputPorts)) {
      for (let i = 0; i < node.uniformName.length; i++) {
        const uName = node.uniformName[i];
        const port = node.inputPorts[i];
        if (uName && port?.portValue && 'value' in port.portValue) {
          params.push({ name: uName, type: port.portValue.type || 'Unknown', value: port.portValue.value, source: 'expandUniform' });
        }
      }
    }
  }
  return params;
}

function setSurfaceParam(doc, paramName, newValue) {
  const nodes = walkSurfaceNodes(doc?.graph?.nodeList);
  for (const node of nodes) {
    if (node.showInProperty === true && node.name === paramName) {
      if (node.__class === 'Vec4Node' || node.__class === 'ColorPickNode') {
        if (!newValue || typeof newValue !== 'object') throw Error(`INVALID_VALUE: ${paramName} expects {x,y,z,w}`);
        for (const k of ['x', 'y', 'z', 'w']) {
          if (k in newValue) node[k] = Number(newValue[k]);
        }
        return true;
      }
      if (node.__class === 'Vec3Node') {
        if (!newValue || typeof newValue !== 'object') throw Error(`INVALID_VALUE: ${paramName} expects {x,y,z}`);
        for (const k of ['x', 'y', 'z']) {
          if (k in newValue) node[k] = Number(newValue[k]);
        }
        return true;
      }
      if (node.__class === 'Vec2Node') {
        if (!newValue || typeof newValue !== 'object') throw Error(`INVALID_VALUE: ${paramName} expects {x,y}`);
        for (const k of ['x', 'y']) {
          if (k in newValue) node[k] = Number(newValue[k]);
        }
        return true;
      }
      if ('value' in node) {
        node.value = newValue;
        return true;
      }
    }
    if (node.isExpandUniform === true && Array.isArray(node.uniformName) && Array.isArray(node.inputPorts)) {
      const idx = node.uniformName.indexOf(paramName);
      if (idx !== -1 && node.inputPorts[idx]?.portValue && 'value' in node.inputPorts[idx].portValue) {
        node.inputPorts[idx].portValue.value = newValue;
        return true;
      }
    }
  }
  return false;
}

function extractVfxParams(doc) {
  const inner = typeof doc.vfxGraphData === 'string' ? JSON.parse(doc.vfxGraphData) : doc.vfxGraphData;
  const graph = inner?.graph;
  if (!graph) return [];
  const params = [];
  const seen = new Set();
  for (const node of Array.isArray(graph.nodeList) ? graph.nodeList : []) {
    if (node?.category !== 'Parameters' || !node.param) continue;
    const name = node.param.name || node.param.uniformName;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const portVal = node.outputPorts?.[0]?.portValue?.value;
    const val = portVal !== undefined ? portVal : node.param.externalVariable?.defaultValue;
    params.push({ name, uniform_name: node.param.uniformName || null, type: node.param.type || 'Unknown', value: val, source: 'vfxParamNode' });
  }
  for (const p of Array.isArray(graph.paramList) ? graph.paramList : []) {
    if (!p || p.__referenceId || !p.name || seen.has(p.name)) continue;
    seen.add(p.name);
    params.push({ name: p.name, uniform_name: p.uniformName || null, type: p.type || 'Unknown', value: p.externalVariable?.defaultValue, source: 'vfxParamList' });
  }
  return params;
}

function setVfxParam(doc, paramName, newValue) {
  const isStr = typeof doc.vfxGraphData === 'string';
  const inner = isStr ? JSON.parse(doc.vfxGraphData) : doc.vfxGraphData;
  const graph = inner?.graph;
  if (!graph) return false;
  let updated = false;
  for (const node of Array.isArray(graph.nodeList) ? graph.nodeList : []) {
    if (node?.category !== 'Parameters' || !node.param) continue;
    if (node.param.name === paramName || node.param.uniformName === paramName) {
      if (node.outputPorts?.[0]?.portValue && 'value' in node.outputPorts[0].portValue) {
        node.outputPorts[0].portValue.value = newValue;
      }
      if (node.param.externalVariable && 'defaultValue' in node.param.externalVariable) {
        node.param.externalVariable.defaultValue = newValue;
      }
      if (Array.isArray(node.externalVariables)) {
        for (const ev of node.externalVariables) {
          if (ev && 'defaultValue' in ev) ev.defaultValue = newValue;
        }
      }
      updated = true;
    }
  }
  for (const p of Array.isArray(graph.paramList) ? graph.paramList : []) {
    if (p && !p.__referenceId && (p.name === paramName || p.uniformName === paramName)) {
      if (p.externalVariable && 'defaultValue' in p.externalVariable) p.externalVariable.defaultValue = newValue;
      updated = true;
    }
  }
  if (updated) {
    doc.vfxGraphData = isStr ? JSON.stringify(inner) : inner;
  }
  return updated;
}

function inspectGraphFile(absPath, relPath) {
  const ext = path.extname(absPath).toLowerCase();
  const raw = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  const params = ext === '.vfxgraph' ? extractVfxParams(raw) : extractSurfaceParams(raw);
  return { path: relPath, kind: ext.slice(1), params };
}

const methods = {
  async textTemplate({ action, id, kind, text, font_size, color, builtin_root } = {}) {
    this.ensureCompatible('templatesTimeline');
    const root = builtin_root || DEFAULT_BUILTIN_ROOT;
    const catalog = scanTextTemplates(root);

    if (action === 'list') {
      const items = kind ? catalog.filter((i) => i.kind === kind) : catalog;
      return { items, count: items.length };
    }

    if (action === 'apply') {
      if (typeof id !== 'string' || !id.trim()) throw Error('INVALID_ARGUMENTS: id is required for apply');
      const item = catalog.find((i) => i.id === id);
      if (!item) throw Error(`TEXT_TEMPLATE_NOT_FOUND: "${id}"; call text_template(action="list") first`);
      if (item.kind === 'icon_text_template' || item.kind === 'text_template_resource') {
        throw Error(`TEXT_TEMPLATE_SCENE_UNSUPPORTED: "${item.id}" (${item.kind}) is an IconCreationNew template, not a scene object; use id="ScreenTextJS" or "Text3D" for scene text`);
      }

      const ui = this.mod(M.orionui);
      const ef = this.mod(M.ef);
      const emc = ui.ExtensionManager.host.getAPI(ef.Extension.MenuConfig.MenuConfigAPIKey).getEntityMenuConfig();
      const cfg = emc.getConfig(item.id) || (item.kind === 'lyrics_template' ? (emc.getConfig('LyricsObject') || emc.getConfig('Lyrics')) : null);
      if (!cfg) {
        if (item.kind === 'lyrics_template') {
          throw Error(`LYRICS_TEMPLATE_UNSUPPORTED: "${item.id}" has no scene MenuConfig entry in this editor; use music_apply for lyrics`);
        }
        throw Error(`MENU_ITEM_NOT_FOUND: ${item.id}`);
      }

      const { sceneEditor, project } = editingScene(this);
      const before = sceneObjectSet(sceneEditor);
      const beforePaths = new Set(projectResources(project).map((r) => r.assetPath));
      const { createEntity } = this.mod(M.sceneOps);
      await createEntity(sceneEditor, cfg, cfg.id || item.id, () => {});
      const added = addedObjectEditors(before, sceneEditor);
      if (!added.length) throw Error(`TEXT_TEMPLATE_APPLY_FAILED: ${item.id} added no scene objects`);

      const appliedProps = {};
      if (text !== undefined || font_size !== undefined || color !== undefined) {
        const addedSet = new Set(added);
        const compEditors = typeof sceneEditor.getAllComponentEditors === 'function'
          ? sceneEditor.getAllComponentEditors().filter((c) => addedSet.has(c.sceneObject))
          : [];
        const targets = [];
        for (const ce of compEditors) {
          if (ce.target) targets.push(ce.target);
          targets.push(ce);
        }
        for (const obj of added) {
          const target = obj.target || obj;
          for (const cn of ['Text2D', 'Text3D']) {
            const comp = typeof target.getComponent === 'function' ? target.getComponent(cn) : null;
            if (comp) targets.push(comp);
          }
        }
        for (const comp of targets) {
          if (text !== undefined && 'text' in comp) {
            comp.text = String(text);
            appliedProps.text = comp.text;
          }
          if (font_size !== undefined && 'fontSize' in comp) {
            comp.fontSize = Number(font_size);
            appliedProps.font_size = comp.fontSize;
          }
          if (color !== undefined && ('color' in comp || 'textColor' in comp)) {
            const rgba = parseColor(color);
            const val = ef.APJS?.Color ? new ef.APJS.Color(rgba.r, rgba.g, rgba.b, rgba.a) : rgba;
            if ('textColor' in comp) {
              comp.textColor = val;
              appliedProps.color = rgba;
            } else {
              comp.color = val;
              appliedProps.color = rgba;
            }
          }
        }
      }

      recordImport(project, added, packageRootsAdded(project, beforePaths));
      return {
        applied: true,
        id: item.id,
        kind: item.kind,
        added_objects: describeAdded(added, before, sceneEditor),
        properties: appliedProps,
      };
    }

    throw Error(`INVALID_ACTION: ${action}; valid: list, apply`);
  },

  async timeline({ action, timeline_path, tracks, beats, fps = 30, track_name = 'Beats' } = {}) {
    this.ensureCompatible('templatesTimeline');
    const ef = this.mod(M.ef);
    const project = ef.Project.getCurrent();
    if (!project || !project.path) throw Error('NO_ACTIVE_PROJECT');
    const tlApi = loadTimelineApi(this._loadTimelineApi);

    if (action === 'inspect') {
      const assetsDir = path.join(project.path, 'Assets');
      const files = walkFiles(assetsDir, (_, name) => name.endsWith('.timeline')).map((abs) => ({
        abs_path: abs,
        rel_path: path.relative(fs.realpathSync(project.path), fs.realpathSync(abs)).replace(/\\/g, '/'),
      }));
      const previewInst = tlApi.TimelinePreviewInstance?.getInstance?.();
      const players = previewInst && typeof previewInst.getTimelinePlayers === 'function'
        ? [...previewInst.getTimelinePlayers()].map((p) => ({
            auto_play: p.autoPlay ?? null,
            play_mode: p.playMode ?? null,
            current_time: p.currentTime ?? null,
            track_count: p.resItemTimeline?.tracks?.length ?? null,
          }))
        : [];
      return { timeline_files: files, players };
    }

    if (action === 'set_tracks' || action === 'import_beats') {
      if (typeof timeline_path !== 'string' || !timeline_path.trim().endsWith('.timeline')) {
        throw Error('INVALID_ARGUMENTS: timeline_path must end with .timeline');
      }
      const { abs, rel } = resolveInsideProject(project.path, timeline_path);
      const rm = project.resourceManager;
      if (!rm) throw Error('RESOURCE_MANAGER_UNAVAILABLE');

      if (!fs.existsSync(abs)) {
        const pluginDir = findTimelinePluginDir();
        const tmpl = pluginDir ? path.join(pluginDir, 'resources', 'timeline.timeline') : null;
        if (!tmpl || !fs.existsSync(tmpl)) {
          throw Error(`TIMELINE_TEMPLATE_MISSING: cannot create ${rel} without Timeline plugin template`);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.copyFileSync(tmpl, abs);
        if (typeof rm.importResource === 'function') await rm.importResource(abs);
      }

      const resItem = rm.getResourceItemByPath?.(abs) ?? rm.getAllResources?.().find((r) => r?.assetPath === abs);
      if (!resItem || typeof resItem.addTrack !== 'function') {
        throw Error(`TIMELINE_RESOURCE_NOT_FOUND: ${rel} is not loaded as a ResItemTimeline`);
      }

      const trackType = tlApi.TimelineMainTrackType?.ActivityTrack ?? 'TimelineActivityTrackAsset';

      if (action === 'set_tracks') {
        if (!Array.isArray(tracks) || tracks.length === 0) {
          throw Error('INVALID_ARGUMENTS: tracks must be a non-empty array');
        }
        const addedTracks = [];
        for (const t of tracks) {
          const idx = resItem.tracks.length;
          const editor = resItem.addTrack(trackType, idx, true);
          if (!editor) throw Error(`TIMELINE_ADD_TRACK_FAILED: index ${idx}`);
          if (t.name) resItem.setTrackName(idx, String(t.name));
          for (const clip of Array.isArray(t.clips) ? t.clips : []) {
            editor.addClip({ startTime: Number(clip.start_time ?? 0), endTime: Number(clip.end_time ?? 1) });
          }
          addedTracks.push({ index: idx, name: resItem.getTrackName(idx), clips: editor.getClipCount?.() ?? 0 });
        }
        resItem.saveToAssetSync(abs);
        return { action: 'set_tracks', timeline_path: rel, added_tracks: addedTracks, track_count: resItem.tracks.length };
      }

      // import_beats
      if (!Array.isArray(beats) || beats.length === 0 || beats.some((b) => typeof b !== 'number' || !Number.isFinite(b) || b < 0)) {
        throw Error('INVALID_ARGUMENTS: beats must be a non-empty array of non-negative numbers (seconds)');
      }
      if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) {
        throw Error('INVALID_ARGUMENTS: fps must be > 0');
      }
      const idx = resItem.tracks.length;
      const editor = resItem.addTrack(trackType, idx, true);
      if (!editor) throw Error(`TIMELINE_ADD_TRACK_FAILED: index ${idx}`);
      resItem.setTrackName(idx, String(track_name));
      const clipDur = 1 / fps;
      for (const b of beats) {
        editor.addClip({ startTime: b, endTime: b + clipDur });
      }
      resItem.saveToAssetSync(abs);
      return { action: 'import_beats', timeline_path: rel, track_index: idx, track_name, beats_count: beats.length, track_count: resItem.tracks.length };
    }

    throw Error(`INVALID_ACTION: ${action}; valid: inspect, set_tracks, import_beats`);
  },

  async graphParams({ action, graph_path, param_name, value } = {}) {
    this.ensureCompatible('templatesTimeline');
    const ef = this.mod(M.ef);
    const project = ef.Project.getCurrent();
    if (!project || !project.path) throw Error('NO_ACTIVE_PROJECT');
    const realProj = fs.realpathSync(project.path);

    if (action === 'inspect') {
      if (graph_path) {
        const { abs, rel } = resolveInsideProject(project.path, graph_path);
        const ext = path.extname(abs).toLowerCase();
        if (!GRAPH_EXTS.has(ext)) throw Error(`UNSUPPORTED_GRAPH_TYPE: ${ext}; supported: .surfacegraph, .vfxgraph`);
        return { graphs: [inspectGraphFile(abs, rel)] };
      }
      const files = walkFiles(path.join(realProj, 'Assets'), (_, name) => GRAPH_EXTS.has(path.extname(name).toLowerCase()));
      return {
        graphs: files.map((abs) => inspectGraphFile(abs, path.relative(realProj, fs.realpathSync(abs)).replace(/\\/g, '/'))),
      };
    }

    if (action === 'set') {
      if (typeof graph_path !== 'string' || !graph_path.trim()) throw Error('INVALID_ARGUMENTS: graph_path is required');
      if (typeof param_name !== 'string' || !param_name.trim()) throw Error('INVALID_ARGUMENTS: param_name is required');
      const { abs, rel } = resolveInsideProject(project.path, graph_path);
      const ext = path.extname(abs).toLowerCase();
      if (!GRAPH_EXTS.has(ext)) throw Error(`UNSUPPORTED_GRAPH_TYPE: ${ext}; supported: .surfacegraph, .vfxgraph`);
      if (!fs.existsSync(abs)) throw Error(`GRAPH_NOT_FOUND: ${rel}`);

      const doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
      const before = ext === '.vfxgraph' ? extractVfxParams(doc) : extractSurfaceParams(doc);
      const ok = ext === '.vfxgraph' ? setVfxParam(doc, param_name, value) : setSurfaceParam(doc, param_name, value);
      if (!ok) {
        throw Error(`GRAPH_PARAM_NOT_FOUND: "${param_name}" in ${rel}; available: ${before.map((p) => p.name).join(', ') || '(none)'}`);
      }

      const tmp = `${abs}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
      fs.renameSync(tmp, abs);

      const readback = inspectGraphFile(abs, rel);
      const hit = readback.params.find((p) => p.name === param_name);
      return { updated: true, graph_path: rel, param_name, param: hit || null };
    }

    throw Error(`INVALID_ACTION: ${action}; valid: inspect, set`);
  },
};

const METHODS = {
  text_template: 'textTemplate',
  timeline: 'timeline',
  graph_params: 'graphParams',
};

module.exports = { methods, METHODS, inspectGraphFile, scanTextTemplates };
