import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from './tmp.mjs';
import { parseTimelineYaml } from '../src/timeline-yaml.mjs';

const require = createRequire(import.meta.url);
const { Library, METHODS, M } = require('../editor-plugin/library.cjs');

// Real .timeline YAML from 看眼睛测精神状态/Assets/特效时间轴.timeline (measured 2026-11-19).
const REAL_TIMELINE_YAML = `%YAML 1.1
--- !ScriptCustomExternalObject &1
name: !<str> 特效时间轴
guid: {a: 14792753372181348601, b: 5905389265552751245}
serializedProperty:
  __class: ScriptSerializedProperty
  name: !<str> ""
  guid: {a: 13061232928718594866, b: 11014767671541189052}
  properties:
    __class: Map
    __scriptClassName: !<str> TimelineAsset
    durationMode: 0
    fixedDuration: 0
    frameRate: 30
    muted: false
    tracks:
      - __class: ScriptCustomObject
        name: !<str> ""
        guid: {a: 11335440079605105005, b: 3382365815556296851}
        serializedProperty:
          __class: ScriptSerializedProperty
          name: !<str> ""
          guid: {a: 2470974256022195340, b: 8555936898704876952}
          properties:
            __class: Map
            __scriptClassName: !<str> TimelineActivityTrackAsset
            clips:
              - __class: ScriptCustomObject
                name: !<str> ""
                guid: {a: 1748406616210754585, b: 17098278664595293064}
                serializedProperty:
                  __class: ScriptSerializedProperty
                  name: !<str> ""
                  guid: {a: 15658381552735847709, b: 4210034244013661350}
                  properties:
                    __class: Map
                    __scriptClassName: !<str> TimelineActivityClipAsset
                    endTime: 24
                    startTime: 0
            m_keyframeTrack:
              __class: ScriptCustomObject
              name: !<str> ""
              guid: {a: 4849436843359810022, b: 7251366786353755522}
              serializedProperty:
                __class: ScriptSerializedProperty
                name: !<str> ""
                guid: {a: 14790855816479568124, b: 6706831463363164067}
                properties:
                  __class: Map
                  __scriptClassName: !<str> TimelineKeyFrameTrackAsset
                  trackName: !<str> ""
            trackName: !<str> DouyinMusic
    volume: 100
`;

// Real SurfaceGraph structure (LyricsSG.surfacegraph Vec4Node showInProperty + TextNode isExpandUniform).
const REAL_SURFACE_GRAPH = {
  __class: 'Container',
  graph: {
    __class: 'SurfaceGraph',
    nodeList: [
      { __class: 'Vec4Node', nodeType: 'VEC4', name: 'ColorLine1', showInProperty: true, x: 1, y: 0.5, z: 0, w: 1 },
      {
        __class: 'TextNode',
        isExpandUniform: true,
        uniformName: ['_LoopCount', '_TextColor'],
        inputPorts: [
          { portValue: { type: 'Number', value: 1 } },
          { portValue: { type: 'Vector4f', value: { x: 1, y: 1, z: 1, w: 1 } } },
        ],
      },
    ],
  },
};

// Real VFXGraph structure (vfxGraphData stringified JSON with Parameters node + paramList).
const REAL_VFX_GRAPH = {
  vfxGraphGuid: 'vfx-1',
  type: 'regular',
  vfxGraphData: JSON.stringify({
    __class: 'Container',
    graph: {
      __class: 'VFXGraph',
      paramList: [
        { __class: 'VFXGraphParam', __uniqueId: 'u1', name: '火焰速率', type: 'Float', uniformName: 'Float_0_10', externalVariable: { name: 'Float_0_10', type: 'Float', defaultValue: 1.5 } },
      ],
      nodeList: [
        {
          __class: 'VFXGraphOperatorNodeParameterFloat',
          category: 'Parameters',
          param: { __class: 'VFXGraphParam', __uniqueId: 'u1', name: '火焰速率', type: 'Float', uniformName: 'Float_0_10', externalVariable: { name: 'Float_0_10', type: 'Float', defaultValue: 1.5 } },
          outputPorts: [{ valueTypeName: 'Float', portValue: { type: 'Float', value: 1.5 } }],
        },
      ],
    },
  }),
};

function setup(opts = {}) {
  const projectPath = tmpdir('xs-ws5-proj-');
  const assetsDir = path.join(projectPath, 'Assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const builtinRoot = tmpdir('xs-ws5-builtin-');
  fs.mkdirSync(path.join(builtinRoot, 'TextTemplate', 'Default'), { recursive: true });
  fs.mkdirSync(path.join(builtinRoot, 'TextTemplateResource', '7514244375228977715'), { recursive: true });
  fs.mkdirSync(path.join(builtinRoot, 'InternalPlugins', 'Lyrics'), { recursive: true });

  const calls = [];
  const sceneObjects = [];
  const textComp = { text: 'old', fontSize: 24, color: { r: 1, g: 1, b: 1, a: 1 } };
  const timelineTracks = [];
  const timelineFile = path.join(assetsDir, '特效时间轴.timeline');
  fs.writeFileSync(timelineFile, REAL_TIMELINE_YAML);
  const realTimelineFile = fs.realpathSync(timelineFile);

  const resItemTimeline = {
    assetPath: realTimelineFile,
    get tracks() {
      return timelineTracks;
    },
    addTrack(trackType, idx) {
      const clips = [];
      const track = { trackType, name: '', clips };
      timelineTracks.splice(idx ?? timelineTracks.length, 0, track);
      return {
        addClip(cfg) {
          clips.push(cfg);
          calls.push(['addClip', cfg]);
          return clips.length - 1;
        },
        getClipCount() {
          return clips.length;
        },
      };
    },
    setTrackName(idx, name) {
      timelineTracks[idx].name = name;
      calls.push(['setTrackName', idx, name]);
    },
    getTrackName(idx) {
      return timelineTracks[idx].name;
    },
    saveToAssetSync(p) {
      calls.push(['saveToAssetSync', p]);
    },
  };

  const sceneEditor = {
    getAllSceneObjectEditors: () => sceneObjects,
  };
  const project = {
    path: projectPath,
    resourceManager: {
      getAllResources: () => [resItemTimeline],
      getResourceItemByPath: (p) => (p === realTimelineFile ? resItemTimeline : null),
    },
  };
  const modules = {
    [M.ef]: {
      Project: { getCurrent: () => project },
      ProjectManager: { getInstance: () => ({ hasActiveProject: () => true, getCurrentActiveProject: () => project }) },
      Extension: { MenuConfig: { MenuConfigAPIKey: 'MenuConfigAPIKey' } },
    },
    [M.orionui]: {
      ExtensionManager: {
        host: {
          getAPI: () => ({
            getEntityMenuConfig: () => ({
              getConfig: (id) => (id === 'ScreenTextJS' || id === 'Text3D' ? { id } : null),
            }),
          }),
        },
      },
    },
    [M.sceneOps]: {
      createEntity: async (_se, cfg) => {
        calls.push(['createEntity', cfg.id]);
        if (opts.dropAdd) return;
        sceneObjects.push({
          guid: `guid-${cfg.id}`,
          name: cfg.id,
          parent: null,
          getComponent: (name) => (name === 'Text2D' || name === 'Text3D' ? textComp : null),
        });
      },
    },
    [M.scene]: {
      SceneModule: { getEditingSceneService: () => ({ sceneEditor }) },
    },
  };
  const lib = new Library((name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  });
  lib._loadTimelineApi = () => ({
    TimelineMainTrackType: { ActivityTrack: 'TimelineActivityTrackAsset' },
    TimelinePreviewInstance: { getInstance: () => ({ getTimelinePlayers: () => new Set([{ autoPlay: true, playMode: 0, currentTime: 0, resItemTimeline }]) }) },
  });
  return { lib, projectPath, assetsDir, builtinRoot, calls, textComp, timelineTracks, timelineFile };
}

test('METHODS registers text_template, timeline, and graph_params', () => {
  assert.equal(METHODS.text_template, 'textTemplate');
  assert.equal(METHODS.timeline, 'timeline');
  assert.equal(METHODS.graph_params, 'graphParams');
});

test('parseTimelineYaml parses real %YAML 1.1 .timeline asset without third-party deps in plugin', () => {
  const parsed = parseTimelineYaml(REAL_TIMELINE_YAML);
  assert.equal(parsed.name, '特效时间轴');
  assert.equal(parsed.frame_rate, 30);
  assert.equal(parsed.tracks.length, 1);
  assert.equal(parsed.tracks[0].track_name, 'DouyinMusic');
  assert.equal(parsed.tracks[0].track_type, 'TimelineActivityTrackAsset');
  assert.deepEqual(parsed.tracks[0].clips, [{ clip_type: 'TimelineActivityClipAsset', start_time: 0, end_time: 24 }]);
});

test('textTemplate lists all kinds, applies ScreenTextJS with props, and fails closed on non-scene templates', async () => {
  const { lib, builtinRoot, textComp } = setup();
  const listed = await lib.textTemplate({ action: 'list', builtin_root: builtinRoot });
  assert.deepEqual(
    listed.items.map((i) => [i.id, i.kind]),
    [
      ['ScreenTextJS', 'scene_text'],
      ['Text3D', 'scene_text'],
      ['Default', 'icon_text_template'],
      ['7514244375228977715', 'text_template_resource'],
      ['Lyrics', 'lyrics_template'],
    ],
  );

  const applied = await lib.textTemplate({ action: 'apply', id: 'ScreenTextJS', text: '新年快乐', font_size: 40, color: '#ff0000', builtin_root: builtinRoot });
  assert.equal(applied.applied, true);
  assert.equal(applied.added_objects.length, 1);
  assert.equal(textComp.text, '新年快乐');
  assert.equal(textComp.fontSize, 40);
  assert.deepEqual(textComp.color, { r: 1, g: 0, b: 0, a: 1 });

  await assert.rejects(lib.textTemplate({ action: 'apply', id: 'Default', builtin_root: builtinRoot }), /TEXT_TEMPLATE_SCENE_UNSUPPORTED/);
  await assert.rejects(lib.textTemplate({ action: 'apply', id: '7514244375228977715', builtin_root: builtinRoot }), /TEXT_TEMPLATE_SCENE_UNSUPPORTED/);
  await assert.rejects(lib.textTemplate({ action: 'apply', id: 'Lyrics', builtin_root: builtinRoot }), /LYRICS_TEMPLATE_UNSUPPORTED/);

  const noAdd = setup({ dropAdd: true });
  await assert.rejects(noAdd.lib.textTemplate({ action: 'apply', id: 'ScreenTextJS', builtin_root: noAdd.builtinRoot }), /TEXT_TEMPLATE_APPLY_FAILED/);
});

test('timeline inspect, set_tracks, and import_beats use ResItemTimeline API', async () => {
  const { lib, timelineTracks, calls } = setup();
  const insp = await lib.timeline({ action: 'inspect' });
  assert.equal(insp.timeline_files[0].rel_path, 'Assets/特效时间轴.timeline');
  assert.equal(insp.players.length, 1);

  const beats = await lib.timeline({ action: 'import_beats', timeline_path: 'Assets/特效时间轴.timeline', beats: [0.5, 1.0, 1.5], fps: 30, track_name: 'Beats' });
  assert.equal(beats.beats_count, 3);
  assert.equal(timelineTracks[0].name, 'Beats');
  assert.equal(timelineTracks[0].clips.length, 3);
  assert.ok(calls.some((c) => c[0] === 'saveToAssetSync'));
});

test('graphParams inspects and updates real .surfacegraph and .vfxgraph JSON preserving format', async () => {
  const { lib, assetsDir } = setup();
  const sgPath = path.join(assetsDir, 'LyricsSG.surfacegraph');
  const vfxPath = path.join(assetsDir, 'fire.vfxgraph');
  fs.writeFileSync(sgPath, JSON.stringify(REAL_SURFACE_GRAPH, null, 2));
  fs.writeFileSync(vfxPath, JSON.stringify(REAL_VFX_GRAPH, null, 2));

  const insp = await lib.graphParams({ action: 'inspect' });
  assert.equal(insp.graphs.length, 2);

  const sgSet = await lib.graphParams({ action: 'set', graph_path: 'Assets/LyricsSG.surfacegraph', param_name: 'ColorLine1', value: { x: 0, y: 1, z: 0, w: 1 } });
  assert.deepEqual(sgSet.param.value, { x: 0, y: 1, z: 0, w: 1 });

  const vfxSet = await lib.graphParams({ action: 'set', graph_path: 'Assets/fire.vfxgraph', param_name: '火焰速率', value: 3.0 });
  assert.equal(vfxSet.param.value, 3.0);
  const vfxSetByUniform = await lib.graphParams({ action: 'set', graph_path: 'Assets/fire.vfxgraph', param_name: 'Float_0_10', value: 4.5 });
  assert.equal(vfxSetByUniform.param.uniform_name, 'Float_0_10');
  assert.equal(vfxSetByUniform.param.value, 4.5);
  const rawVfx = JSON.parse(fs.readFileSync(vfxPath, 'utf8'));
  assert.equal(typeof rawVfx.vfxGraphData, 'string', 'vfxGraphData stays stringified JSON');

  await assert.rejects(lib.graphParams({ action: 'inspect', graph_path: 'Assets/missing.surfacegraph' }), /GRAPH_NOT_FOUND/);
  await assert.rejects(lib.graphParams({ action: 'set', graph_path: 'Assets/LyricsSG.surfacegraph', param_name: 'Missing' }), /GRAPH_PARAM_NOT_FOUND/);
});
