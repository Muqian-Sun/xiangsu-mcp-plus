import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from './tmp.mjs';

const require = createRequire(import.meta.url);
const { Library, M } = require('../editor-plugin/library.cjs');
const templatesTimeline = require('../editor-plugin/features/templates_timeline.cjs');

class TestLibrary extends Library {}
Object.assign(TestLibrary.prototype, templatesTimeline.methods);

function makeSampleContentJson(text = 'Hello', size = 40, color = [1, 1, 1]) {
  return {
    root: { name: 'rootWidget', duration: 999999999 },
    children: [
      {
        name: 'text-node',
        type: 'text',
        text_params: {
          version: '2',
          richText: {
            text,
            styles: [
              {
                range: [0, 400],
                size,
                fill: {
                  enable: true,
                  content: {
                    render_type: 'solid',
                    solid: { color, alpha: 1 },
                  },
                },
              },
            ],
          },
        },
      },
    ],
  };
}

function createBuiltinFixture() {
  const root = tmpdir('xs-builtin-');
  // TextTemplate/Default with nested scriptTemplate-0000000000000/content.json
  const defDir = path.join(root, 'TextTemplate', 'Default', 'scriptTemplate-0000000000000');
  fs.mkdirSync(defDir, { recursive: true });
  fs.writeFileSync(path.join(defDir, 'content.json'), JSON.stringify(makeSampleContentJson(), null, 2));

  // TextTemplate/ItalicThree without preset json
  fs.mkdirSync(path.join(root, 'TextTemplate', 'ItalicThree'), { recursive: true });

  // TextTemplate/sticker_0 with config.json and content.json
  const stickerDir = path.join(root, 'TextTemplate', 'sticker_0');
  fs.mkdirSync(stickerDir, { recursive: true });
  fs.writeFileSync(path.join(stickerDir, 'config.json'), JSON.stringify({ name: 'StickerZero' }));
  fs.writeFileSync(path.join(stickerDir, 'content.json'), JSON.stringify(makeSampleContentJson('Sticker', 32, [0, 1, 0])));

  // TextTemplateResource/7514244375228977715
  const resDir = path.join(root, 'TextTemplateResource', '7514244375228977715');
  fs.mkdirSync(resDir, { recursive: true });
  fs.writeFileSync(path.join(resDir, 'content.json'), JSON.stringify(makeSampleContentJson('ResText', 48, [1, 0, 0])));

  // InternalPlugins/Lyrics & LyricsTemplate
  const lyricsDir = path.join(root, 'InternalPlugins', 'Lyrics', 'PluginResource', 'PinToGraph');
  fs.mkdirSync(lyricsDir, { recursive: true });
  fs.writeFileSync(path.join(lyricsDir, 'pinToGraphConfig.json'), JSON.stringify({ id: 'Lyrics' }));

  const lyricsTplDir = path.join(root, 'InternalPlugins', 'LyricsTemplate', 'PluginResource', 'script');
  fs.mkdirSync(lyricsTplDir, { recursive: true });
  fs.writeFileSync(path.join(lyricsTplDir, 'LyricsTemplate.js'), '// lyrics');

  return root;
}

function createSetup(opts = {}) {
  const projectPath = opts.projectPath ?? tmpdir('xs-tt-proj-');
  fs.mkdirSync(path.join(projectPath, 'Assets'), { recursive: true });

  const calls = [];
  const project = {
    path: projectPath,
    sceneManager: opts.sceneManager ?? {
      sceneObjects: opts.sceneObjects ?? [],
      createEntity: async (payload) => {
        calls.push(['sceneManager.createEntity', payload]);
        return { guid: 'created-entity-1', ...payload };
      },
    },
  };

  const modules = {
    [M.ef]: {
      ProjectManager: {
        getInstance: () => ({
          hasActiveProject: () => opts.hasActiveProject ?? true,
          getCurrentActiveProject: () => project,
          getActiveProject: () => project,
        }),
      },
      Extension: {
        MenuConfig: {
          MenuConfigAPIKey: 'MenuConfigAPIKey',
        },
      },
    },
  };

  if (opts.withMenuSceneOps) {
    modules[M.orionui] = {
      ExtensionManager: {
        host: {
          getAPI: () => ({
            getEntityMenuConfig: () => ({
              getConfig: (id) => ({ id, displayName: id }),
            }),
          }),
        },
      },
    };
    modules[M.scene] = {
      SceneModule: {
        getEditingSceneService: () => ({
          sceneEditor: { id: 'mock-scene-editor' },
        }),
      },
    };
    modules[M.sceneOps] = {
      createEntity: async (sceneEditor, cfg, name) => {
        calls.push(['sceneOps.createEntity', cfg.id, name]);
        return { guid: `sceneops-${cfg.id}`, name };
      },
    };
  }

  const lib = new TestLibrary();
  lib.mod = (id) => modules[id];
  return { lib, projectPath, project, calls };
}

test('METHODS table exports expected RPC method names', () => {
  assert.deepEqual(templatesTimeline.METHODS, {
    text_template: 'textTemplate',
    timeline: 'timeline',
    graph_params: 'graphParams',
  });
});

test('textTemplate list scans TextTemplate, TextTemplateResource, and InternalPlugins Lyrics', async () => {
  const builtinRoot = createBuiltinFixture();
  const { lib } = createSetup();
  const res = await lib.textTemplate({ action: 'list', builtin_root: builtinRoot });

  const byId = new Map(res.items.map((it) => [it.id, it]));
  assert.equal(byId.get('Default')?.kind, 'text_template');
  assert.equal(byId.get('Default')?.has_preset_json, true);
  assert.equal(byId.get('ItalicThree')?.kind, 'text_template');
  assert.equal(byId.get('ItalicThree')?.has_preset_json, false);
  assert.equal(byId.get('sticker_0')?.name, 'StickerZero');
  assert.equal(byId.get('7514244375228977715')?.kind, 'text_template_resource');
  assert.equal(byId.get('Lyrics')?.kind, 'lyrics_template');
  assert.equal(byId.get('LyricsTemplate')?.kind, 'lyrics_template');
});

test('textTemplate apply fails closed on unknown id and applies text/font_size/color', async () => {
  const builtinRoot = createBuiltinFixture();
  const { lib, projectPath } = createSetup();

  await assert.rejects(
    () => lib.textTemplate({ action: 'apply', id: 'DoesNotExist', builtin_root: builtinRoot }),
    /TEXT_TEMPLATE_NOT_FOUND/,
  );

  const res = await lib.textTemplate({
    action: 'apply',
    id: 'Default',
    text: 'New Year!',
    font_size: 64,
    color: [0.2, 0.4, 0.8],
    builtin_root: builtinRoot,
  });

  assert.equal(res.applied, true);
  assert.equal(res.id, 'Default');
  assert.equal(res.kind, 'text_template');
  assert.equal(res.asset_path, path.join(projectPath, 'Assets', 'TextTemplate', 'Default'));

  const written = JSON.parse(
    fs.readFileSync(path.join(res.asset_path, 'scriptTemplate-0000000000000', 'content.json'), 'utf8'),
  );
  const rt = written.children[0].text_params.richText;
  assert.equal(rt.text, 'New Year!');
  assert.equal(rt.styles[0].size, 64);
  assert.deepEqual(rt.styles[0].fill.content.solid.color, [0.2, 0.4, 0.8]);
});

test('textTemplate apply uses MenuConfig + SceneOpsService for lyrics_template when available', async () => {
  const builtinRoot = createBuiltinFixture();
  const { lib, calls } = createSetup({ withMenuSceneOps: true });

  const res = await lib.textTemplate({
    action: 'apply',
    id: 'LyricsTemplate',
    kind: 'lyrics_template',
    builtin_root: builtinRoot,
  });

  assert.equal(res.applied, true);
  assert.equal(res.kind, 'lyrics_template');
  assert.equal(res.entity?.guid, 'sceneops-LyricsTemplate');
  assert.ok(calls.some((c) => c[0] === 'sceneOps.createEntity' && c[1] === 'LyricsTemplate'));
});

test('timeline inspect parses Douyin AR YAML .timeline files and TimelinePlayer components', () => {
  const { lib, projectPath } = createSetup({
    sceneObjects: [
      {
        name: 'MusicController',
        guid: 'obj-mc-1',
        components: [
          {
            constructor: { name: 'TimelinePlayerComponent' },
            enabled: true,
            timelineAsset: 'Assets/Timelines/main.timeline',
            playOnStart: true,
          },
        ],
      },
    ],
  });

  const tlDir = path.join(projectPath, 'Assets', 'Timelines');
  fs.mkdirSync(tlDir, { recursive: true });
  fs.writeFileSync(
    path.join(tlDir, 'main.timeline'),
    [
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
      '    fixedDuration: 4.5',
      '    frameRate: 30',
      '',
    ].join('\n'),
  );

  const res = lib.timeline({ action: 'inspect' });
  assert.equal(res.timelines.length, 1);
  assert.equal(res.timelines[0].durationMode, 0);
  assert.equal(res.timelines[0].fixedDuration, 4.5);
  assert.equal(res.timelines[0].frameRate, 30);
  assert.equal(res.timeline_players.length, 1);
  assert.equal(res.timeline_players[0].object_guid, 'obj-mc-1');
  assert.equal(res.timeline_players[0].play_on_start, true);
});

test('timeline set_tracks creates/updates .timeline file, verifies readback, and rejects outside paths', () => {
  const { lib, projectPath } = createSetup();

  assert.throws(
    () =>
      lib.timeline({
        action: 'set_tracks',
        timeline_path: '/tmp/outside.timeline',
        tracks: [],
      }),
    /PATH_OUTSIDE_PROJECT/,
  );

  const res = lib.timeline({
    action: 'set_tracks',
    timeline_path: 'Assets/Timelines/anim.timeline',
    fps: 60,
    tracks: [
      {
        target_guid: 'obj-1',
        property: 'opacity',
        keyframes: [
          { time: 0, value: 0 },
          { time: 2.5, value: 1 },
        ],
      },
    ],
  });

  assert.equal(res.frameRate, 60);
  assert.equal(res.fixedDuration, 2.5);
  assert.equal(res.tracks.length, 1);
  assert.ok(fs.existsSync(path.join(projectPath, 'Assets', 'Timelines', 'anim.timeline')));
});

test('timeline import_beats validates beats, writes beatsPoint + keyframe track, and updates fixedDuration', () => {
  const { lib } = createSetup();

  for (const badBeats of [[], [-0.5, 1], [Number.NaN], [Number.POSITIVE_INFINITY], 'not-array']) {
    assert.throws(
      () =>
        lib.timeline({
          action: 'import_beats',
          timeline_path: 'Assets/Timelines/beat.timeline',
          beats: badBeats,
        }),
      /INVALID_BEATS/,
    );
  }

  const res = lib.timeline({
    action: 'import_beats',
    timeline_path: 'Assets/Timelines/beat.timeline',
    beats: [0.5, 1.0, 1.5, 3.2],
    fps: 30,
    target_guid: 'obj-glow',
    property: 'intensity',
  });

  assert.equal(res.beats_count, 4);
  assert.equal(res.fixedDuration, 3.2);
  assert.equal(res.beatsPoint[1].frame, 30);
  assert.equal(res.tracks.length, 1);
  assert.equal(res.tracks[0].target_guid, 'obj-glow');
  assert.equal(res.tracks[0].keyframes.length, 4);
});

test('graphParams inspect and set work for surfacegraph, audiograph, and stringified vfxgraph', () => {
  const { lib, projectPath } = createSetup();
  const graphsDir = path.join(projectPath, 'Assets', 'Graphs');
  fs.mkdirSync(graphsDir, { recursive: true });

  const surfacePath = path.join(graphsDir, 'mat.surfacegraph');
  fs.writeFileSync(
    surfacePath,
    JSON.stringify({
      graph: {
        __class: 'SurfaceGraph',
        paramList: [
          { name: 'u_Intensity', type: 'float', value: 0.5 },
          { name: 'u_Tint', type: 'vec3', value: [1, 1, 1] },
        ],
      },
    }),
  );

  const audioPath = path.join(graphsDir, 'mix.audiograph');
  fs.writeFileSync(
    audioPath,
    JSON.stringify({
      uniforms: {
        gain: { type: 'float', value: 0.8 },
      },
    }),
  );

  const vfxPath = path.join(graphsDir, 'sparks.vfxgraph');
  fs.writeFileSync(
    vfxPath,
    JSON.stringify({
      vfxGraphGuid: 'VFX-1',
      type: 'regular',
      vfxGraphData: JSON.stringify({
        graph: {
          __class: 'VFXGraph',
          paramList: [{ name: 'spawnRate', type: 'float', value: 100 }],
        },
      }),
    }),
  );

  const inspected = lib.graphParams({ action: 'inspect' });
  assert.equal(inspected.graphs.length, 3);
  const byKind = new Map(inspected.graphs.map((g) => [g.kind, g]));
  assert.equal(byKind.get('surfacegraph')?.params.length, 2);
  assert.equal(byKind.get('audiograph')?.params[0].name, 'gain');
  assert.equal(byKind.get('vfxgraph')?.params[0].name, 'spawnRate');

  assert.throws(
    () =>
      lib.graphParams({
        action: 'set',
        graph_path: 'Assets/Graphs/mat.surfacegraph',
        param_name: 'u_Missing',
        value: 1,
      }),
    /GRAPH_PARAM_NOT_FOUND.*u_Intensity.*u_Tint/,
  );

  const setSurface = lib.graphParams({
    action: 'set',
    graph_path: 'Assets/Graphs/mat.surfacegraph',
    param_name: 'u_Intensity',
    value: 0.95,
  });
  assert.equal(setSurface.previous_value, 0.5);
  assert.equal(setSurface.value, 0.95);

  const setVfx = lib.graphParams({
    action: 'set',
    graph_path: 'Assets/Graphs/sparks.vfxgraph',
    param_name: 'spawnRate',
    value: 250,
  });
  assert.equal(setVfx.previous_value, 100);
  assert.equal(setVfx.value, 250);

  const reInspected = lib.graphParams({ action: 'inspect', graph_path: 'Assets/Graphs/sparks.vfxgraph' });
  assert.equal(reInspected.graphs[0].params[0].value, 250);
});
