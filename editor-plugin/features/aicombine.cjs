'use strict';
// AI 组合效果: the photo is sent with a workflow (AI Graph) to the cloud, which generates the result.
// The menu item AICombine only adds an empty texture; the AI effect window builds the graph and its
// 「应用」 compiles it, uploads it and fills the texture. These mirror the window's 「新建工作流」 and
// 「应用」; nodes, prompts and preview generation are left to the official workflow tools.
const fs = require('fs');
const { M, editingScene, sceneObjectSet, sceneObjectPath } = require('./common.cjs');

// Event the AI graph manager reports apply failures on, instead of throwing.
const APPLY_TOAST = 'AIEffectShowToast';
// The 视频生成 node of the AI effect window (its 「图生视频」), BuiltinResource/AIGraph/NodeInfo/Image2VideoEffect.
const VIDEO_NODE = 'AI Effect Video';
// The model the 视频生成 node's picker leaves out (VideoSeedanceAdjustment).
const HIDDEN_VIDEO_MODEL = '7559880796488810546';
// Picked: task 107961 asks for Seedance 2.0 Mini; the window itself starts on the first model it lists.
const DEFAULT_VIDEO_MODEL = 'Seedance 2.0 Mini';

function graphSummary(graph) {
  return {
    ai_graph_id: graph.uniqueId,
    nodes: [...graph.getNodes()].map((n) => ({ node_id: n.uniqueName, type: n.AINodeType, name: n.nodeName })),
  };
}

function knownGraph(mgr, graph_id) {
  if (typeof graph_id !== 'string' || !graph_id) throw Error('INVALID_GRAPH_ID: graph_id must be a non-empty string');
  const graph = mgr.getGraphById(graph_id);
  if (!graph) throw Error(`UNKNOWN_AI_GRAPH: ${graph_id}; graphs in this window: ${[...mgr.allGraphs.keys()].join(', ') || '(none)'}`);
  return graph;
}

// What a video model's panel lets the user set, from its uiSchema: the keys the node stores them under.
function videoParamSpec(uiSchema) {
  const base = (uiSchema && uiSchema.baseSchema) || [];
  const advanced = (uiSchema && uiSchema.advancedSchema) || [];
  const key = (item) => item.internalKey || item.uiKey;
  const spec = {};
  const prompt = base.find((s) => s.uiKey === 'prompt');
  if (prompt) spec.prompt = { key: key(prompt) };
  const resolution = base.find((s) => s.uiKey === 'segment' && s.internalKey === 'resolution');
  if (resolution) spec.resolution = { key: key(resolution), options: resolution.options.map((o) => o.text) };
  const ratio = base.find((s) => s.uiKey === 'ratio');
  if (ratio) spec.aspect_ratio = { key: key(ratio), options: ratio.options.ratioOptions };
  const duration = advanced.find((s) => s.uiKey === 'video_duration');
  if (duration) spec.duration = { key: key(duration), min: duration.min, max: duration.max };
  return spec;
}

// [node key, value] pairs for the given params, checked against the model's panel.
function videoUpdates(spec, given, modelName) {
  const updates = [];
  for (const [name, value] of Object.entries(given)) {
    if (value === undefined) continue;
    const s = spec[name];
    if (!s) throw Error(`VIDEO_PARAM_UNSUPPORTED: ${modelName} has no ${name}; it takes ${Object.keys(spec).join(', ')}`);
    if (s.options && !s.options.includes(value)) throw Error(`INVALID_VIDEO_PARAM: ${name} ${value} is not one of ${modelName}'s ${s.options.join(', ')}`);
    if (name === 'duration' && !(value >= s.min && value <= s.max)) throw Error(`INVALID_VIDEO_PARAM: duration ${value} is outside ${modelName}'s ${s.min}–${s.max} s`);
    updates.push([s.key, value]);
  }
  return updates;
}

const methods = {
  aiGraphManager() {
    this.ensureCompatible('aiCombine');
    return this.mod(M.aiGraphManager).AIGraphManager.getInstance();
  },

  aiCombineNew() {
    const mgr = this.aiGraphManager();
    if (!this.mod(M.ef).ProjectManager.getInstance().hasActiveProject()) throw Error('NO_ACTIVE_PROJECT');
    const graph = this.mod(M.aiGraphProject).createAIGraph();
    mgr.isGraphInit = true;
    mgr.autoSaveManager.clearDraft();
    mgr.addGraph(graph);
    return graphSummary(graph);
  },

  async aiCombineApply({ graph_id } = {}) {
    const mgr = this.aiGraphManager();
    const { sceneEditor } = editingScene(this);
    knownGraph(mgr, graph_id);
    mgr.switchGraphbyGuid(graph_id);
    const before = sceneObjectSet(sceneEditor);
    const bus = this.mod(M.events).BusinessEventManager.TypeGuard();
    const toasts = [];
    const onToast = (msg) => toasts.push(String(msg));
    bus.on(APPLY_TOAST, onToast);
    try {
      await mgr.editorPanelApply();
    } finally {
      bus.off(APPLY_TOAST, onToast);
    }
    if (toasts.length) throw Error(`AI_COMBINE_APPLY_FAILED: ${toasts.join('; ')}`);
    const added = sceneEditor.getAllSceneObjectEditors().filter((o) => !before.has(o));
    if (!added.length) throw Error('AI_COMBINE_APPLY_NO_EFFECT: the editor added no scene objects (it refuses while a voice change component is in the scene; see the editor log)');
    return {
      ai_graph_id: graph_id,
      added_objects: added.map((o) => ({ name: o.name, object_path: sceneObjectPath(o) })),
      draft_id: mgr.autoSaveManager.draftId || null,
    };
  },

  // The video models the 视频生成 node's picker offers.
  aiVideoModels() {
    const controller = this.mod(M.aiEffectController).default.getInstance();
    const key = this.mod(M.aiEffectConst).BASE_MODEL_CATEGORY_ID_MAP.videoAllModelKey;
    const visible = this.mod(M.aiApiUtils).isBaseModelEntranceVisible;
    return (controller.baseModelMap.getValue().get(key) || []).filter((m) => m.ableToUseInCombination && m.lokiId !== HIDDEN_VIDEO_MODEL && visible(m));
  },

  // Adds a 视频生成 node to an AI graph, or changes one, the way its edit panel does: the model's default
  // style goes through the window's shared AIVideoCtx onto the node, and each param is set as the panel's
  // inputs set it. A new node is wired input → video → combination; the graph is then saved as the cloud
  // draft, as the official workflow patch saves it.
  async aiVideoNode({ graph_id, node_id, model, prompt, duration, aspect_ratio, resolution, input_node_id } = {}) {
    this.ensureCompatible('aiVideo');
    const mgr = this.aiGraphManager();
    const graph = knownGraph(mgr, graph_id);
    const nodes = [...graph.getNodes()];
    let node = null;
    if (node_id !== undefined) {
      node = nodes.find((n) => n.uniqueName === node_id && n.AINodeType === 'Video');
      if (!node) {
        const videos = nodes.filter((n) => n.AINodeType === 'Video').map((n) => n.uniqueName);
        throw Error(`UNKNOWN_VIDEO_NODE: ${node_id}; video nodes in this graph: ${videos.join(', ') || '(none)'}`);
      }
      if (input_node_id !== undefined) throw Error('INVALID_INPUT_NODE: input_node_id only applies to a new video node');
    } else if (prompt === undefined) {
      throw Error('INVALID_PROMPT: a new video node needs the prompt');
    }

    const models = this.aiVideoModels();
    const names = models.map((m) => m.displayName).join(', ') || '(none)';
    const currentId = node ? node.AIData && node.AIData.baseModelId : undefined;
    let picked;
    if (model !== undefined || !node) {
      const want = model === undefined ? DEFAULT_VIDEO_MODEL : model;
      picked = models.find((m) => m.displayName === want);
      if (!picked) throw Error(`UNKNOWN_VIDEO_MODEL: ${want}; the 视频生成 node offers ${names}`);
    }
    const switching = !!picked && picked.lokiId !== currentId;
    const controller = this.mod(M.aiEffectController).default.getInstance();
    const full = await controller.getBaseModelById(switching ? picked.lokiId : currentId);
    if (!full || !full.defaultParams || !full.defaultParams.uiSchema) throw Error(`VIDEO_MODEL_UNAVAILABLE: model ${switching ? picked.lokiId : currentId} did not load; the 视频生成 node offers ${names}`);
    const spec = videoParamSpec(full.defaultParams.uiSchema);
    // A model switch starts from the new model's defaults; the prompt written for the old one carries over.
    const oldPrompt = node && switching ? node.AIData && node.AIData.styleParams && node.AIData.styleParams.prompt : undefined;
    const updates = videoUpdates(spec, { prompt: prompt !== undefined ? prompt : oldPrompt || undefined, duration, aspect_ratio, resolution }, full.displayName);

    let input = null;
    let combination = null;
    let combinationPort = null;
    if (!node) {
      const inputs = nodes.filter((n) => n.AINodeType === 'Input');
      const ids = inputs.map((n) => n.uniqueName).join(', ') || '(none)';
      if (input_node_id !== undefined) {
        input = inputs.find((n) => n.uniqueName === input_node_id);
        if (!input) throw Error(`UNKNOWN_INPUT_NODE: ${input_node_id}; input nodes in this graph: ${ids}`);
      } else if (inputs.length === 1) {
        input = inputs[0];
      } else {
        throw Error(`INPUT_NODE_AMBIGUOUS: the graph has input nodes ${ids}; pass input_node_id`);
      }
      combination = graph.getCombinationNode();
      const edges = graph.getEdges();
      combinationPort = combination && combination.inputPorts.find((p) => !edges.some((e) => e.targetPort === p));
      if (!combinationPort) throw Error('COMBINATION_PORT_TAKEN: the combination node has no free input; disconnect it with apply_workflow_patch disconnect_nodes first');
    }

    mgr.switchGraphbyGuid(graph_id);
    const created = !node;
    if (created) {
      node = mgr.initNodeByName(VIDEO_NODE);
      node.position = { x: (input.position.x + combination.position.x) / 2, y: input.position.y };
      if (!graph.addNode(node, false, { interactive: false })) throw Error('VIDEO_NODE_NOT_ADDED: the graph refused the 视频生成 node');
    }
    const ctx = controller.AIVideoCtx;
    const undo = this.mod(M.ef).UndoSystem.instance;
    undo.start('Select Style');
    try {
      if (switching) {
        const item = {
          templateId: '',
          name: '',
          icon: '',
          iconMd5: '',
          defaultParams: { modelId: full.lokiId, defaultConfig: full.defaultParams.defaultConfig, customSceneList: ctx.createDefaultSceneList() },
          author: this.mod(M.aiEffectConst).BACKUP_AUTHOR_INFO,
        };
        await ctx.styleItemToCtxParams(item, 'aiCombination');
        await node.setStyleParamByStyleItem(item);
      } else {
        await ctx.styleItemToCtxParams(node.getStyleItem(), 'aiCombination', true);
      }
      if (updates.length) {
        for (const [key, value] of updates) ctx.onStyleParamsUpdate(key, value);
        await node.setStyleParamByStyleItem(await ctx.getCurStyleItem());
      }
    } finally {
      undo.end();
    }
    if (created) {
      const imagePort = node.inputPorts[0];
      if (!imagePort.connectPorts(input.outputPorts[0], imagePort, false)) throw Error(`VIDEO_NODE_NOT_CONNECTED: ${input.uniqueName} did not connect to the new node ${node.uniqueName}`);
      if (!combinationPort.connectPorts(node.outputPorts[0], combinationPort, false)) throw Error(`VIDEO_NODE_NOT_CONNECTED: the new node ${node.uniqueName} did not connect to ${combination.uniqueName}`);
    }
    const saved = await mgr.autoSaveManager.saveGraph(undefined, false);
    return {
      ai_graph_id: graph_id,
      node_id: node.uniqueName,
      created,
      model: { id: node.AIData.baseModelId, name: full.displayName },
      params: { ...node.AIData.styleParams },
      ...(created ? { connected: { input: input.uniqueName, combination: combination.uniqueName } } : {}),
      saved: !!(saved && saved.success),
      ...(saved && saved.success ? {} : { save_error: (saved && [saved.code, saved.message].filter(Boolean).join(': ')) || JSON.stringify(saved) }),
    };
  },

  // What the 视频生成 and 效果组合 nodes generated: the node's own result list, whose localPath is the
  // file the window previews (the AIGC cache, before any download watermark).
  aiVideoResults({ graph_id } = {}) {
    const graph = knownGraph(this.aiGraphManager(), graph_id);
    return {
      ai_graph_id: graph_id,
      nodes: [...graph.getNodes()]
        .filter((n) => n.AINodeType === 'Video' || n.AINodeType === 'Combination')
        .map((n) => ({
          node_id: n.uniqueName,
          type: n.AINodeType,
          state: n.nodeState,
          videos: (n.AIResultList || [])
            .filter((r) => r && r.videoMeta)
            .map((r) => ({
              local_path: r.localPath && fs.existsSync(r.localPath) ? r.localPath : null,
              width: r.videoMeta.width ?? null,
              height: r.videoMeta.height ?? null,
              duration_s: r.videoMeta.duration ?? null,
            })),
        })),
    };
  },
};

const METHODS = { ai_combine_new: 'aiCombineNew', ai_combine_apply: 'aiCombineApply', ai_video_node: 'aiVideoNode', ai_video_results: 'aiVideoResults' };

module.exports = { methods, METHODS, APPLY_TOAST };
