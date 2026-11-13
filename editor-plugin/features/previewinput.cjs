'use strict';
// Preview input the official interact_by_dsl does not take, served by the editor's own agent command
// layer (Agent/EHCommand): simulated audio (pitch, volume, keyword hits), seeking the preview video,
// moving a held touch and switching to a configured hand-gesture video.
//
// Simulated audio only reaches an effect while the agent "playthrough" runtime session is active: the
// session sets a flag and reloads the preview, and the reload injects the runtime that turns these
// messages into AudioDetection results. Ending it reloads the preview without that runtime.
const { M } = require('./common.cjs');

const SESSION_ID = 'xiangsu-mcp-ext-audio';
const COMMANDS = ['touch_move', 'seek_to_time', 'switch_gesture_video'];

const methods = {
  previewCommand() {
    return new (this.mod(M.ehPreview).EHPreviewCommand)();
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
    const cmd = this.previewCommand();
    const results = [];
    for (const { command_type, params = {} } of commands) {
      if (!COMMANDS.includes(command_type)) throw Error(`UNSUPPORTED_COMMAND: ${command_type}; valid: ${COMMANDS.join(', ')}`);
      let result;
      try {
        if (command_type === 'touch_move') result = await cmd.previewTouchMove(params.x, params.y);
        else if (command_type === 'seek_to_time') result = await cmd.seekToTime(params.time_ms);
        else {
          result = await cmd.switchGestureVideo(params.hand_action);
          if (!result.success) throw Error(`${result.error.code}: ${result.error.message}`);
        }
      } catch (e) {
        results.push({ command_type, status: 'error', error: String(e.message || e) });
        return { success: false, results };
      }
      results.push({ command_type, status: 'success', result });
    }
    return { success: true, results };
  },
};

const METHODS = {
  preview_audio_session: 'previewAudioSession',
  preview_audio_input: 'previewAudioInput',
  preview_actions: 'previewActions',
};

module.exports = { methods, METHODS };
