'use strict';
// Preview input the official interact_by_dsl does not take, served by the editor's own agent command
// layer (Agent/EHCommand): simulated audio (pitch, volume, keyword hits), seeking the preview video,
// moving a held touch and switching to a configured hand-gesture video.
//
// Simulated audio only reaches an effect while the agent "playthrough" runtime session is active: the
// session sets a flag and reloads the preview, and the reload injects the runtime that turns these
// messages into AudioDetection results. Ending it reloads the preview without that runtime.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { M } = require('./common.cjs');

const SESSION_ID = 'xiangsu-mcp-plus-audio';
const HUMAN_SESSION_ID = 'xiangsu-mcp-plus-human';
const HUMAN_INPUT_TYPES = ['preview_face', 'preview_hand', 'preview_fullbody', 'preview_twoperson'];
const RECORD_ACTIONS = ['record', 'start', 'stop', 'abort'];
const COMMANDS = [
  'touch_move',
  'seek_to_time',
  'switch_gesture_video',
  'drag',
  'pause',
  'resume',
  'set_preview_property',
  'human_action',
  'restore_human_action',
];

function resolveRecordPath(saveTo) {
  const filename = `xiangsu-preview-${Date.now()}.mp4`;
  if (saveTo === undefined || saveTo === null) return path.join(os.tmpdir(), filename);
  if (typeof saveTo !== 'string' || !saveTo.trim()) throw Error('INVALID_PATH: save_to must be a non-empty path');
  if (fs.existsSync(saveTo) && fs.statSync(saveTo).isDirectory()) return path.join(saveTo, filename);
  if (!saveTo.toLowerCase().endsWith('.mp4')) throw Error(`INVALID_PATH: save_to must end with .mp4 or be an existing directory (got ${saveTo})`);
  return saveTo;
}

const methods = {
  previewCommand() {
    return new (this.mod(M.ehPreview).EHPreviewCommand)();
  },

  ehManager() {
    const mod = this.mod(M.ehCommandManager);
    const mgr = mod.EHCommandManager || mod;
    if (typeof mgr.getInstance === 'function') return mgr.getInstance();
    if (typeof mgr === 'function' && typeof mgr.previewDrag !== 'function') {
      if (!this._ehManager || this._ehManagerCtor !== mgr) {
        this._ehManager = new mgr();
        this._ehManagerCtor = mgr;
      }
      return this._ehManager;
    }
    return mgr;
  },

  async previewAudioSession({ action }) {
    this.ensureCompatible('previewInput');
    const RS = this.mod(M.playthroughRuntime);
    const reload = () => this.previewCommand().reloadSticker();
    const P = this.mod(M.preview);
    const pm = P.PreviewManager.getInstance();
    if (!pm.isPreviewServiceInit) throw Error('PREVIEW_NOT_READY: the preview has not started in this window yet');
    // A paused preview never reports the reload done (measured: the reload timed out after a gesture
    // video left it paused), so it is resumed first.
    if (pm.playingState === P.PreviewStreamState.Paused) pm.resume();
    if (action === 'start') {
      try {
        const r = await RS.activateAgentPlaythroughRuntimeSession(SESSION_ID, reload);
        return { started: !!r.started, active: RS.isAgentPlaythroughRuntimeSessionActive() };
      } catch (e) {
        await RS.deactivateAgentPlaythroughRuntimeSession(SESSION_ID, reload).catch(() => {});
        RS.clearAgentPlaythroughRuntimeSession();
        throw Error(`AUDIO_SESSION_START_FAILED: ${String(e.message || e)}`);
      }
    }
    if (action === 'stop') {
      try {
        const r = await RS.deactivateAgentPlaythroughRuntimeSession(SESSION_ID, reload);
        return { restored: !!r.restored, active: RS.isAgentPlaythroughRuntimeSessionActive() };
      } catch (e) {
        // The flag is dropped either way, so the next preview reload comes back without the runtime.
        RS.clearAgentPlaythroughRuntimeSession();
        throw Error(`AUDIO_SESSION_STOP_FAILED: ${String(e.message || e)}; the session flag was cleared, the next preview reload drops the runtime`);
      }
    }
    throw Error(`INVALID_ACTION: ${action}; valid: start, stop`);
  },

  // input is { pitchHz?, volume?, keywordEvent? } as the editor's AgentPlayAudioInputService validates it.
  // Note: static + bundle inspection confirmed setPlayAudioInput does NOT support STT fields (asrText / speechText).
  previewAudioInput({ input, duration_ms, clear = false }) {
    this.ensureCompatible('previewInput');
    const service = new (this.mod(M.playAudio).AgentPlayAudioInputService)();
    if (clear) return service.clearPlayAudioInput();
    if (!this.mod(M.playthroughRuntime).isAgentPlaythroughRuntimeSessionActive()) throw Error('AUDIO_SESSION_NOT_ACTIVE: start the audio session first; without its runtime the effect never sees the input');
    return service.setPlayAudioInput(`xs-audio-${Date.now()}`, input, duration_ms);
  },

  // Runs the commands in order and stops at the first failure, reporting each one like interact_by_dsl.
  async previewActions({ commands }) {
    this.ensureCompatible('previewInput');
    if (!Array.isArray(commands) || !commands.length) throw Error('INVALID_ARGUMENTS: commands must be a non-empty list');
    let cmd;
    let mgr;
    const getCmd = () => (cmd ||= this.previewCommand());
    const getMgr = () => (mgr ||= this.ehManager());
    const results = [];
    for (const { command_type, params = {} } of commands) {
      if (!COMMANDS.includes(command_type)) throw Error(`UNSUPPORTED_COMMAND: ${command_type}; valid: ${COMMANDS.join(', ')}`);
      let result;
      try {
        if (command_type === 'touch_move') result = await getCmd().previewTouchMove(params.x, params.y);
        else if (command_type === 'seek_to_time') result = await getCmd().seekToTime(params.time_ms);
        else if (command_type === 'switch_gesture_video') {
          result = await getCmd().switchGestureVideo(params.hand_action);
          if (!result.success) throw Error(`${result.error.code}: ${result.error.message}`);
        } else if (command_type === 'drag') {
          for (const key of ['x1', 'y1', 'x2', 'y2']) {
            const v = params[key];
            if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
              throw Error(`INVALID_ARGUMENTS: drag ${key} must be a normalized number in [0, 1] (got ${v})`);
            }
          }
          const steps = params.steps ?? 10;
          const durationMs = params.duration_ms ?? 300;
          if (typeof steps !== 'number' || !Number.isFinite(steps) || steps <= 0) throw Error(`INVALID_ARGUMENTS: drag steps must be > 0 (got ${steps})`);
          if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) throw Error(`INVALID_ARGUMENTS: drag duration_ms must be >= 0 (got ${durationMs})`);
          result = await getMgr().previewDrag(params.x1, params.y1, params.x2, params.y2, steps, durationMs);
        } else if (command_type === 'pause') {
          result = await getMgr().pausePreview();
        } else if (command_type === 'resume') {
          result = await getMgr().resumePreview();
        } else if (command_type === 'set_preview_property') {
          if (!params.scene_object_guid || !params.component_type || !params.property || !('value' in params)) {
            throw Error('INVALID_ARGUMENTS: set_preview_property requires scene_object_guid, component_type, property, and value');
          }
          result = await getMgr().transportPreviewProperty(params.scene_object_guid, params.component_type, params.property, params.value);
        } else if (command_type === 'human_action') {
          if (!HUMAN_INPUT_TYPES.includes(params.input_type)) {
            throw Error(`INVALID_INPUT_TYPE: ${params.input_type}; valid: ${HUMAN_INPUT_TYPES.join(', ')}`);
          }
          const actionId = params.action_id || params.file_path;
          if (!actionId) throw Error('INVALID_ARGUMENTS: human_action requires action_id or file_path');
          const sessionId = params.session_id || HUMAN_SESSION_ID;
          this._humanActionSessions ||= new Set();
          if (!this._humanActionSessions.has(sessionId)) {
            await getMgr().beginHumanActionSession(sessionId);
            this._humanActionSessions.add(sessionId);
          }
          result = await getMgr().switchHumanAction(sessionId, actionId, params.file_path, params.input_type);
        } else if (command_type === 'restore_human_action') {
          const sessionId = params.session_id || HUMAN_SESSION_ID;
          result = await getMgr().restoreHumanActionSession(sessionId);
          if (this._humanActionSessions) this._humanActionSessions.delete(sessionId);
        }
      } catch (e) {
        results.push({ command_type, status: 'error', error: String(e.message || e) });
        return { success: false, results };
      }
      results.push({ command_type, status: 'success', result });
    }
    return { success: true, results };
  },

  async previewRecord({ action, duration_s, save_to } = {}) {
    this.ensureCompatible('previewInput');
    if (!RECORD_ACTIONS.includes(action)) throw Error(`INVALID_ACTION: ${action}; valid: ${RECORD_ACTIONS.join(', ')}`);
    const mgr = this.ehManager();
    if (action === 'record') {
      const dur = duration_s === undefined ? 5 : duration_s;
      if (typeof dur !== 'number' || !Number.isFinite(dur) || dur <= 0 || dur > 60) {
        throw Error(`INVALID_DURATION: duration_s must satisfy 0 < duration_s <= 60 (got ${duration_s})`);
      }
      const outPath = resolveRecordPath(save_to);
      try {
        const result = await mgr.recordPreviewVideo(outPath, dur);
        if (result && result.success === false) throw Error(`PREVIEW_RECORD_FAILED: ${result.error || 'recording failed'}`);
        return { action: 'record', path: outPath, duration_s: dur, result };
      } catch (e) {
        await mgr.abortPreviewRecording().catch(() => {});
        throw e;
      }
    }
    if (action === 'start') {
      const outPath = resolveRecordPath(save_to);
      const projectPath = this.mod(M.ef).ProjectManager.getInstance().getActiveProject()?.path ?? null;
      try {
        const result = await mgr.beginPreviewRecording(outPath, projectPath);
        this._recordOutPath = outPath;
        return { action: 'start', path: outPath, projectPath, result };
      } catch (e) {
        this._recordOutPath = null;
        await mgr.abortPreviewRecording().catch(() => {});
        throw e;
      }
    }
    if (action === 'stop') {
      const result = await mgr.endPreviewRecording();
      const outPath = result?.path || this._recordOutPath || null;
      this._recordOutPath = null;
      return { action: 'stop', ...(outPath ? { path: outPath } : {}), result };
    }
    this._recordOutPath = null;
    const result = await mgr.abortPreviewRecording();
    return { action: 'abort', result };
  },
};

const METHODS = {
  preview_audio_session: 'previewAudioSession',
  preview_audio_input: 'previewAudioInput',
  preview_actions: 'previewActions',
  preview_record: 'previewRecord',
};

module.exports = { methods, METHODS };
