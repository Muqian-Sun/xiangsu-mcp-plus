import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.XIANGSU_MCP_EXT_STATE = tmpdir('xs-state-');
const { Library, M } = require('../editor-plugin/library.cjs');

// The editor's agent command layer as far as these tools use it: the preview, its commands, the audio
// input service and the playthrough runtime session flag (activate / deactivate reload the preview).
function setup(opts = {}) {
  const calls = [];
  const preview = { isPreviewServiceInit: opts.ready ?? true, playingState: opts.paused ? 2 : 0, resume: () => (calls.push('resume'), (preview.playingState = 0)) };
  const session = { active: false };
  class EHPreviewCommand {
    async reloadSticker() {
      calls.push(['reload', preview.playingState]);
      if (opts.reloadFails) throw Error('Preview effect package reload timed out.');
      return { reloadToken: 1 };
    }
    async previewTouchMove(x, y) {
      calls.push(['touchMove', x, y]);
      return { x, y, action: 'touchMove' };
    }
    async seekToTime(ms) {
      calls.push(['seek', ms]);
      return { success: true, timeMs: ms, paused: false };
    }
    async switchGestureVideo(hand) {
      calls.push(['gesture', hand]);
      return hand === 'Victory' ? { success: true, handAction: hand, captureTimesMs: [967], paused: true } : { success: false, error: { code: 'INVALID_HAND_ACTION', message: `Unknown canonical HandAction: ${hand}` } };
    }
  }
  class AgentPlayAudioInputService {
    setPlayAudioInput(id, input, ms) {
      calls.push(['audio', input, ms]);
      return { id };
    }
    clearPlayAudioInput() {
      calls.push('clear');
      return { cleared: true };
    }
  }
  const modules = {
    [M.preview]: { PreviewManager: { getInstance: () => preview }, PreviewStreamState: { Playing: 0, Paused: 2 } },
    [M.ehPreview]: { EHPreviewCommand },
    [M.playAudio]: { AgentPlayAudioInputService },
    [M.playthroughRuntime]: {
      activateAgentPlaythroughRuntimeSession: async (id, reload) => {
        calls.push(['activate', id]);
        session.active = true;
        await reload();
        return { started: true };
      },
      deactivateAgentPlaythroughRuntimeSession: async (id, reload) => {
        calls.push(['deactivate', id]);
        await reload();
        session.active = false;
        return { restored: true };
      },
      isAgentPlaythroughRuntimeSessionActive: () => session.active,
      clearAgentPlaythroughRuntimeSession: () => (calls.push('clearSession'), (session.active = false)),
    },
  };
  const lib = new Library((name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  });
  return { lib, calls, session };
}

test('the audio session resumes a paused preview, then reloads it with the runtime on and off', async () => {
  const { lib, calls, session } = setup({ paused: true });
  assert.deepEqual(await lib.previewAudioSession({ action: 'start' }), { started: true, active: true });
  assert.deepEqual(calls, ['resume', ['activate', 'xiangsu-mcp-ext-audio'], ['reload', 0]], 'resumed before the reload, which needs a playing preview');
  assert.deepEqual(await lib.previewAudioSession({ action: 'stop' }), { restored: true, active: false });
  assert.deepEqual(calls.slice(3), [['deactivate', 'xiangsu-mcp-ext-audio'], ['reload', 0]]);
  assert.equal(session.active, false);
  await assert.rejects(lib.previewAudioSession({ action: 'pause' }), /INVALID_ACTION/);
  await assert.rejects(setup({ ready: false }).lib.previewAudioSession({ action: 'start' }), /PREVIEW_NOT_READY/);
});

test('a session that fails to start or stop is rolled back so no runtime stays injected', async () => {
  const { lib, calls, session } = setup({ reloadFails: true });
  await assert.rejects(lib.previewAudioSession({ action: 'start' }), /AUDIO_SESSION_START_FAILED: Preview effect package reload timed out\./);
  assert.deepEqual(calls.filter((c) => c === 'clearSession' || c[0] === 'deactivate').map((c) => (Array.isArray(c) ? c[0] : c)), ['deactivate', 'clearSession']);
  assert.equal(session.active, false);
  session.active = true;
  await assert.rejects(lib.previewAudioSession({ action: 'stop' }), /AUDIO_SESSION_STOP_FAILED: .*the session flag was cleared/);
  assert.equal(session.active, false);
});

test('audio input needs the session; it is passed through as the editor validates it, and can be cleared', async () => {
  const { lib, calls } = setup();
  assert.throws(() => lib.previewAudioInput({ input: { volume: 0.1 }, duration_ms: 500 }), /AUDIO_SESSION_NOT_ACTIVE/);
  await lib.previewAudioSession({ action: 'start' });
  const out = lib.previewAudioInput({ input: { volume: 0.12, keywordEvent: { type: 'hit', keywords: ['开门'] } }, duration_ms: 1500 });
  assert.match(out.id, /^xs-audio-\d+$/);
  assert.deepEqual(calls.at(-1), ['audio', { volume: 0.12, keywordEvent: { type: 'hit', keywords: ['开门'] } }, 1500]);
  assert.deepEqual(lib.previewAudioInput({ clear: true }), { cleared: true });
});

test('preview actions run in order and stop at the first failure', async () => {
  const { lib, calls } = setup();
  const ok = await lib.previewActions({ commands: [{ command_type: 'seek_to_time', params: { time_ms: 500 } }, { command_type: 'touch_move', params: { x: 0.2, y: 0.8 } }, { command_type: 'switch_gesture_video', params: { hand_action: 'Victory' } }] });
  assert.equal(ok.success, true);
  assert.deepEqual(calls, [['seek', 500], ['touchMove', 0.2, 0.8], ['gesture', 'Victory']]);
  assert.deepEqual(ok.results[2].result.captureTimesMs, [967]);
  const bad = await lib.previewActions({ commands: [{ command_type: 'switch_gesture_video', params: { hand_action: 'Nope' } }, { command_type: 'seek_to_time', params: { time_ms: 1 } }] });
  assert.deepEqual(bad, { success: false, results: [{ command_type: 'switch_gesture_video', status: 'error', error: 'INVALID_HAND_ACTION: Unknown canonical HandAction: Nope' }] });
  assert.equal(calls.length, 4, 'nothing ran after the failure');
  await assert.rejects(lib.previewActions({ commands: [{ command_type: 'screenshot' }] }), /UNSUPPORTED_COMMAND: screenshot/);
});
