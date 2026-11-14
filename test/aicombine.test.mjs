import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.XIANGSU_MCP_EXT_STATE = tmpdir('xs-state-');
const { Library, M } = require('../editor-plugin/library.cjs');

let seq = 0;
function graph() {
  seq += 1;
  const nodes = [
    { uniqueName: `Input-in${seq}`, AINodeType: 'Input', nodeName: '输入图' },
    { uniqueName: `Combination-out${seq}`, AINodeType: 'Combination', nodeName: '效果组合' },
  ];
  return { uniqueId: `graph-${seq}`, getNodes: () => new Set(nodes) };
}

// A fake editor: the AI graph manager, its toast bus and a scene the 「应用」 step adds objects to.
// `apply` decides what editorPanelApply does: 'add' (succeeds), 'toast' (rejects with a toast) or 'none'.
function setup({ active = true, apply = 'add' } = {}) {
  const calls = { created: 0, cleared: 0, switched: [], appliedOn: [] };
  const handlers = new Map();
  const bus = {
    on: (ev, fn) => handlers.set(ev, [...(handlers.get(ev) || []), fn]),
    off: (ev, fn) => handlers.set(ev, (handlers.get(ev) || []).filter((f) => f !== fn)),
    emit: (ev, ...a) => (handlers.get(ev) || []).forEach((f) => f(...a)),
  };
  const sceneObjects = [{ name: '已有', parent: null }];
  const mgr = {
    isGraphInit: false,
    allGraphs: new Map(),
    curGraph: null,
    autoSaveManager: { draftId: '', clearDraft: () => calls.cleared++ },
    addGraph(g) {
      this.allGraphs.set(g.uniqueId, g);
    },
    getGraphById(id) {
      return this.allGraphs.get(id);
    },
    switchGraphbyGuid(id) {
      calls.switched.push(id);
      this.curGraph = this.allGraphs.get(id);
    },
    async editorPanelApply() {
      calls.appliedOn.push(this.curGraph && this.curGraph.uniqueId);
      if (apply === 'toast') return bus.emit('AIEffectShowToast', '请先连接效果组合器');
      if (apply === 'add') {
        const fg = { name: '2D 前景', parent: null };
        const cam = { name: '2D 摄像机', parent: fg };
        sceneObjects.push(fg, cam, { name: 'AI 组合效果', parent: cam });
      }
    },
  };
  class AIGraphManager {
    static getInstance() {
      return mgr;
    }
  }
  for (const k of ['addGraph', 'getGraphById', 'switchGraphbyGuid', 'editorPanelApply']) AIGraphManager.prototype[k] = mgr[k];
  const modules = {
    [M.ef]: { ProjectManager: { getInstance: () => ({ hasActiveProject: () => active, getCurrentActiveProject: () => ({}) }) } },
    [M.scene]: { SceneModule: { getEditingSceneService: () => ({ sceneEditor: { getAllSceneObjectEditors: () => [...sceneObjects] } }) } },
    [M.events]: { BusinessEventManager: { TypeGuard: () => bus } },
    [M.aiGraphManager]: { AIGraphManager },
    // Like the editor's, the new graph becomes the current one.
    [M.aiGraphProject]: {
      createAIGraph: () => {
        calls.created++;
        mgr.curGraph = graph();
        return mgr.curGraph;
      },
    },
  };
  const mod = (name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  };
  return { lib: new Library(mod), calls, mgr, modules, handlers };
}

test('ai_combine_new does what 「新建工作流」 does and returns the ids the official workflow tools take', () => {
  const { lib, calls, mgr } = setup();
  const out = lib.aiCombineNew();
  assert.equal(calls.created, 1);
  assert.equal(mgr.isGraphInit, true);
  assert.equal(calls.cleared, 1);
  assert.equal(mgr.getGraphById(out.ai_graph_id).uniqueId, out.ai_graph_id);
  assert.deepEqual(out, {
    ai_graph_id: out.ai_graph_id,
    nodes: [
      { node_id: out.ai_graph_id.replace('graph-', 'Input-in'), type: 'Input', name: '输入图' },
      { node_id: out.ai_graph_id.replace('graph-', 'Combination-out'), type: 'Combination', name: '效果组合' },
    ],
  });
});

test('ai_combine_new refuses without an active project and before creating a graph', () => {
  const { lib, calls } = setup({ active: false });
  assert.throws(() => lib.aiCombineNew(), /NO_ACTIVE_PROJECT/);
  assert.equal(calls.created, 0);
});

test('ai_combine_apply applies the requested graph and reports every object it added', async () => {
  const { lib, calls, mgr, handlers } = setup();
  const a = lib.aiCombineNew().ai_graph_id;
  const b = lib.aiCombineNew().ai_graph_id;
  assert.equal(mgr.curGraph.uniqueId, b);
  const out = await lib.aiCombineApply({ graph_id: a });
  assert.deepEqual(calls.appliedOn, [a]);
  assert.deepEqual(out, {
    ai_graph_id: a,
    added_objects: [
      { name: '2D 前景', object_path: '2D 前景' },
      { name: '2D 摄像机', object_path: '2D 前景/2D 摄像机' },
      { name: 'AI 组合效果', object_path: '2D 前景/2D 摄像机/AI 组合效果' },
    ],
    draft_id: null,
  });
  assert.deepEqual(handlers.get('AIEffectShowToast'), []);
});

test('ai_combine_apply reports the draft id when the workflow was saved as a cloud draft', async () => {
  const { lib, mgr } = setup();
  const id = lib.aiCombineNew().ai_graph_id;
  mgr.autoSaveManager.draftId = '89938740';
  assert.equal((await lib.aiCombineApply({ graph_id: id })).draft_id, '89938740');
});

test('ai_combine_apply turns the editor toast into an error and stops listening', async () => {
  const { lib, handlers } = setup({ apply: 'toast' });
  const id = lib.aiCombineNew().ai_graph_id;
  await assert.rejects(lib.aiCombineApply({ graph_id: id }), /AI_COMBINE_APPLY_FAILED: 请先连接效果组合器/);
  assert.deepEqual(handlers.get('AIEffectShowToast'), []);
});

test('ai_combine_apply fails when the editor added nothing', async () => {
  const { lib } = setup({ apply: 'none' });
  const id = lib.aiCombineNew().ai_graph_id;
  await assert.rejects(lib.aiCombineApply({ graph_id: id }), /AI_COMBINE_APPLY_NO_EFFECT/);
});

test('ai_combine_apply refuses unknown or missing graph ids before applying', async () => {
  const { lib, calls } = setup();
  const id = lib.aiCombineNew().ai_graph_id;
  await assert.rejects(lib.aiCombineApply({ graph_id: 'nope' }), new RegExp(`UNKNOWN_AI_GRAPH: nope; graphs in this window: ${id}`));
  await assert.rejects(lib.aiCombineApply({}), /INVALID_GRAPH_ID/);
  assert.deepEqual(calls.appliedOn, []);
  assert.deepEqual(calls.switched, []);
});

test('ai_combine calls refuse to run when the AI graph internals are missing', async () => {
  const { lib, modules, calls } = setup();
  delete modules[M.aiGraphManager].AIGraphManager.prototype.editorPanelApply;
  assert.throws(() => lib.aiCombineNew(), /INCOMPATIBLE_EDITOR: missing .*editorPanelApply/);
  await assert.rejects(lib.aiCombineApply({ graph_id: 'x' }), /INCOMPATIBLE_EDITOR/);
  assert.equal(calls.created, 0);
  assert.equal(lib.selfCheck().features.aiCombine, false);
});

const MINI = '7648913495051894811';
const V25 = '7698181052485091354';
const VIDEO_MODELS = {
  [MINI]: { name: 'Seedance 2.0 Mini', resolutions: ['480p', '720p'], min: 5, max: 15 },
  [V25]: { name: 'Seedance 2.5', resolutions: ['480p', '720p', '1080p'], min: 4, max: 30 },
};

// The video model's uiSchema as getBaseModelById returns it (trimmed to what the panel reads).
function fullModel(id) {
  const m = VIDEO_MODELS[id];
  return {
    lokiId: id,
    displayName: m.name,
    defaultParams: {
      defaultConfig: { resolution: '480p', prompt: '', aspect_ratio: '9:16', video_duration: 10 },
      uiSchema: {
        baseSchema: [
          { uiKey: 'exampleModule', internalKey: 'multiMediaStylization' },
          { uiKey: 'segment', internalKey: 'resolution', options: m.resolutions.map((text) => ({ text })) },
          { uiKey: 'prompt', internalKey: 'prompt' },
          { uiKey: 'ratio', internalKey: 'aspect_ratio', options: { ratioOptions: ['9:16', '16:9', '1:1'] } },
        ],
        advancedSchema: [{ uiKey: 'video_duration', internalKey: 'video_duration', min: m.min, max: m.max }],
      },
    },
  };
}

// The AI graph with its ports and edges, the 视频生成 node the library makes, the AI effect controller
// with its video model list and shared AIVideoCtx, and the undo system.
function setupVideo({ inputs = 1, combinationTaken = false, save = { success: true }, models } = {}) {
  const base = setup();
  const { mgr, modules } = base;
  const calls = { ctx: [], styled: [], undo: [], saves: 0 };
  const edges = [];
  const port = (owner) => ({
    owner,
    connectPorts(src, dst) {
      edges.push({ sourcePort: src, targetPort: dst });
      return true;
    },
  });
  const plain = (uniqueName, AINodeType, x) => {
    const n = { uniqueName, AINodeType, position: { x, y: 100 } };
    n.inputPorts = AINodeType === 'Input' ? [] : [port(n)];
    n.outputPorts = AINodeType === 'Combination' ? [] : [port(n)];
    return n;
  };
  const nodes = [];
  for (let i = 1; i <= inputs; i++) nodes.push(plain(`Input-${i}`, 'Input', 0));
  const combination = plain('Combination-1', 'Combination', 1000);
  nodes.push(combination);
  if (combinationTaken) edges.push({ sourcePort: nodes[0].outputPorts[0], targetPort: combination.inputPorts[0] });
  const graph = {
    uniqueId: 'g-video',
    getNodes: () => new Set(nodes),
    getEdges: () => edges,
    getCombinationNode: () => combination,
    addNode: (n) => (nodes.push(n), true),
  };
  mgr.allGraphs.set(graph.uniqueId, graph);
  let made = 0;
  mgr.initNodeByName = (name) => {
    assert.equal(name, 'AI Effect Video');
    made += 1;
    const n = {
      uniqueName: `Video-${made}`,
      AINodeType: 'Video',
      AIData: null,
      async setStyleParamByStyleItem(item) {
        calls.styled.push(item);
        this.AIData = { baseModelId: item.defaultParams.modelId, styleParams: { ...item.defaultParams.defaultConfig } };
      },
      getStyleItem() {
        return { defaultParams: { modelId: this.AIData.baseModelId, defaultConfig: this.AIData.styleParams } };
      },
    };
    n.inputPorts = [port(n), port(n), port(n), port(n), port(n)];
    n.outputPorts = [port(n)];
    return n;
  };
  modules[M.aiGraphManager].AIGraphManager.prototype.initNodeByName = mgr.initNodeByName;
  mgr.autoSaveManager.saveGraph = async (target, toast) => {
    calls.saves += 1;
    assert.equal(mgr.curGraph, graph, 'saves the graph it changed');
    assert.equal(toast, false);
    return save;
  };
  const ctx = {
    params: null,
    model: null,
    async styleItemToCtxParams(item, page, existing) {
      calls.ctx.push([item.defaultParams.modelId, page, existing === true]);
      this.model = item.defaultParams.modelId;
      this.params = { ...item.defaultParams.defaultConfig };
    },
    onStyleParamsUpdate(k, v) {
      this.params[k] = v;
    },
    async getCurStyleItem() {
      return { defaultParams: { modelId: this.model, defaultConfig: { ...this.params } } };
    },
    createDefaultSceneList: () => [{ scene_key: 'default' }],
  };
  const list = models || [
    { lokiId: V25, displayName: 'Seedance 2.5', ableToUseInCombination: true },
    { lokiId: MINI, displayName: 'Seedance 2.0 Mini', ableToUseInCombination: true },
    { lokiId: '7559880796488810546', displayName: '藏起来的', ableToUseInCombination: true },
    { lokiId: '1', displayName: '只在 AI 视频里', ableToUseInCombination: false },
    { lokiId: '2', displayName: '没开放', ableToUseInCombination: true, hidden: true },
  ];
  modules[M.aiEffectController] = {
    default: {
      getInstance: () => ({
        AIVideoCtx: ctx,
        baseModelMap: { getValue: () => new Map([['44027', list]]) },
        getBaseModelById: async (id) => (VIDEO_MODELS[id] ? fullModel(id) : undefined),
      }),
    },
  };
  modules[M.aiEffectConst] = { BASE_MODEL_CATEGORY_ID_MAP: { videoAllModelKey: '44027' }, BACKUP_AUTHOR_INFO: { name: 'backup' } };
  modules[M.aiApiUtils] = { isBaseModelEntranceVisible: (m) => !m.hidden };
  modules[M.ef].UndoSystem = { instance: { start: (n) => calls.undo.push(`start ${n}`), end: () => calls.undo.push('end') } };
  return { ...base, calls, graph, nodes, edges, combination, ctx };
}

test('ai_video_node adds a Seedance 2.0 Mini 视频生成 node between the input and the combination, the way its panel does', async () => {
  const { lib, calls, nodes, edges, combination, mgr } = setupVideo();
  const out = await lib.aiVideoNode({ graph_id: 'g-video', prompt: '书页卷起来', duration: 5 });
  const video = nodes.find((n) => n.AINodeType === 'Video');
  assert.deepEqual(out, {
    ai_graph_id: 'g-video',
    node_id: 'Video-1',
    created: true,
    model: { id: MINI, name: 'Seedance 2.0 Mini' },
    params: { resolution: '480p', prompt: '书页卷起来', aspect_ratio: '9:16', video_duration: 5 },
    connected: { input: 'Input-1', combination: 'Combination-1' },
    saved: true,
  });
  assert.equal(mgr.curGraph.uniqueId, 'g-video');
  assert.deepEqual(video.position, { x: 500, y: 100 });
  assert.deepEqual(calls.ctx, [[MINI, 'aiCombination', false]], 'the model default goes through the shared AIVideoCtx');
  assert.equal(calls.styled[0].author.name, 'backup');
  assert.deepEqual(calls.styled[0].defaultParams.customSceneList, [{ scene_key: 'default' }]);
  assert.deepEqual(calls.undo, ['start Select Style', 'end']);
  assert.deepEqual(
    edges.map((e) => [e.sourcePort.owner.uniqueName, e.targetPort.owner.uniqueName, e.targetPort === video.inputPorts[0] || e.targetPort === combination.inputPorts[0]]),
    [
      ['Input-1', 'Video-1', true],
      ['Video-1', 'Combination-1', true],
    ],
  );
  assert.equal(calls.saves, 1);
});

test('ai_video_node checks every param against the chosen model and changes nothing when one is off', async () => {
  const { lib, nodes, calls } = setupVideo();
  const before = nodes.length;
  await assert.rejects(lib.aiVideoNode({ graph_id: 'g-video', prompt: 'x', duration: 20 }), /INVALID_VIDEO_PARAM: duration 20 is outside Seedance 2.0 Mini's 5–15 s/);
  await assert.rejects(lib.aiVideoNode({ graph_id: 'g-video', prompt: 'x', resolution: '1080p' }), /INVALID_VIDEO_PARAM: resolution 1080p is not one of Seedance 2.0 Mini's 480p, 720p/);
  await assert.rejects(lib.aiVideoNode({ graph_id: 'g-video', prompt: 'x', aspect_ratio: '2:1' }), /INVALID_VIDEO_PARAM: aspect_ratio 2:1/);
  await assert.rejects(lib.aiVideoNode({ graph_id: 'g-video', prompt: 'x', model: '可灵' }), /UNKNOWN_VIDEO_MODEL: 可灵; the 视频生成 node offers Seedance 2.5, Seedance 2.0 Mini$/);
  await assert.rejects(lib.aiVideoNode({ graph_id: 'g-video' }), /INVALID_PROMPT/);
  await assert.rejects(lib.aiVideoNode({ graph_id: 'nope', prompt: 'x' }), /UNKNOWN_AI_GRAPH: nope/);
  assert.equal(nodes.length, before);
  assert.deepEqual(calls.undo, []);
  assert.equal(calls.saves, 0);
  const longer = await lib.aiVideoNode({ graph_id: 'g-video', prompt: 'x', model: 'Seedance 2.5', duration: 20, resolution: '1080p' });
  assert.deepEqual([longer.model.name, longer.params.video_duration, longer.params.resolution], ['Seedance 2.5', 20, '1080p']);
});

test('ai_video_node refuses to guess which input to wire, or to take a used combination input', async () => {
  const two = setupVideo({ inputs: 2 });
  await assert.rejects(two.lib.aiVideoNode({ graph_id: 'g-video', prompt: 'x' }), /INPUT_NODE_AMBIGUOUS: the graph has input nodes Input-1, Input-2; pass input_node_id/);
  await assert.rejects(two.lib.aiVideoNode({ graph_id: 'g-video', prompt: 'x', input_node_id: 'Input-9' }), /UNKNOWN_INPUT_NODE: Input-9/);
  const out = await two.lib.aiVideoNode({ graph_id: 'g-video', prompt: 'x', input_node_id: 'Input-2' });
  assert.equal(out.connected.input, 'Input-2');
  const taken = setupVideo({ combinationTaken: true });
  await assert.rejects(taken.lib.aiVideoNode({ graph_id: 'g-video', prompt: 'x' }), /COMBINATION_PORT_TAKEN/);
  assert.equal(taken.nodes.filter((n) => n.AINodeType === 'Video').length, 0);
});

test('ai_video_node changes an existing node in place, and a model switch keeps its prompt', async () => {
  const { lib, calls, edges } = setupVideo();
  await lib.aiVideoNode({ graph_id: 'g-video', prompt: '原来的提示词', duration: 12 });
  const wired = edges.length;
  calls.ctx.length = 0;
  const changed = await lib.aiVideoNode({ graph_id: 'g-video', node_id: 'Video-1', aspect_ratio: '16:9' });
  assert.equal(changed.created, false);
  assert.equal(changed.connected, undefined);
  assert.deepEqual(changed.params, { resolution: '480p', prompt: '原来的提示词', aspect_ratio: '16:9', video_duration: 12 });
  assert.deepEqual(calls.ctx, [[MINI, 'aiCombination', true]], 'loads the node’s own style, as the panel does for a configured node');
  assert.equal(edges.length, wired);
  const switched = await lib.aiVideoNode({ graph_id: 'g-video', node_id: 'Video-1', model: 'Seedance 2.5' });
  assert.deepEqual(switched.model, { id: V25, name: 'Seedance 2.5' });
  assert.deepEqual(switched.params, { resolution: '480p', prompt: '原来的提示词', aspect_ratio: '9:16', video_duration: 10 });
  await assert.rejects(lib.aiVideoNode({ graph_id: 'g-video', node_id: 'Input-1', prompt: 'x' }), /UNKNOWN_VIDEO_NODE: Input-1; video nodes in this graph: Video-1/);
  await assert.rejects(lib.aiVideoNode({ graph_id: 'g-video', node_id: 'Video-1', input_node_id: 'Input-1' }), /INVALID_INPUT_NODE/);
});

test('ai_video_node says when the cloud draft was not saved', async () => {
  const { lib } = setupVideo({ save: { success: false, code: 'SAVE_REJECTED', message: '网络开小差了' } });
  const out = await lib.aiVideoNode({ graph_id: 'g-video', prompt: 'x' });
  assert.equal(out.saved, false);
  assert.equal(out.save_error, 'SAVE_REJECTED: 网络开小差了');
});

test('ai_video_node refuses to run without the AI effect controller, without touching ai_combine', async () => {
  const { lib, modules, nodes } = setupVideo();
  delete modules[M.aiEffectController];
  await assert.rejects(lib.aiVideoNode({ graph_id: 'g-video', prompt: 'x' }), /INCOMPATIBLE_EDITOR: missing .*AIEffectController/);
  assert.equal(nodes.filter((n) => n.AINodeType === 'Video').length, 0);
  const { features } = lib.selfCheck();
  assert.equal(features.aiVideo, false);
  assert.equal(features.aiCombine, true);
});

test('ai_video_results lists the videos the 视频生成 and 效果组合 nodes generated, with the file the window previews', async () => {
  const { lib, nodes } = setupVideo();
  await lib.aiVideoNode({ graph_id: 'g-video', prompt: 'x' });
  const cached = path.join(tmpdir('xs-aigc-'), 'wf1-Video.mp4');
  fs.writeFileSync(cached, 'mp4');
  const video = nodes.find((n) => n.AINodeType === 'Video');
  const combination = nodes.find((n) => n.AINodeType === 'Combination');
  video.nodeState = 'success';
  video.AIResultList = [{ localPath: cached, vid: 'v0d8', videoMeta: { url: 'https://signed', width: 496, height: 864, duration: 5.088 } }];
  combination.nodeState = 'success';
  combination.AIResultList = [{ localPath: '/gone/wf1-Combination.mp4', videoMeta: { width: 496, height: 864, duration: 5.088 } }, { uri: 'tos://image' }];
  nodes.find((n) => n.AINodeType === 'Input').AIResultList = [{ localPath: cached, videoMeta: {} }];
  assert.deepEqual(lib.aiVideoResults({ graph_id: 'g-video' }), {
    ai_graph_id: 'g-video',
    nodes: [
      { node_id: 'Combination-1', type: 'Combination', state: 'success', videos: [{ local_path: null, width: 496, height: 864, duration_s: 5.088 }] },
      { node_id: 'Video-1', type: 'Video', state: 'success', videos: [{ local_path: cached, width: 496, height: 864, duration_s: 5.088 }] },
    ],
  });
  assert.throws(() => lib.aiVideoResults({ graph_id: 'nope' }), /UNKNOWN_AI_GRAPH/);
});
