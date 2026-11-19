import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.XIANGSU_MCP_PLUS_STATE = tmpdir('xs-state-');
const { Library, METHODS, M } = require('../editor-plugin/library.cjs');

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
  class EHCommandManager {
    async previewDrag(x1, y1, x2, y2, steps, durationMs) {
      calls.push(['drag', x1, y1, x2, y2, steps, durationMs]);
      return { dragged: true };
    }
    async pausePreview() {
      calls.push(['pause']);
      return { paused: true };
    }
    async resumePreview() {
      calls.push(['resumePreview']);
      return { paused: false };
    }
    async transportPreviewProperty(guid, componentType, property, value) {
      calls.push(['setProperty', guid, componentType, property, value]);
      return { applied: true };
    }
    async beginHumanActionSession(sessionId) {
      calls.push(['beginHuman', sessionId]);
      return { sessionId };
    }
    async switchHumanAction(sessionId, actionId, filePath, inputType) {
      calls.push(['switchHuman', sessionId, actionId, filePath, inputType]);
      return { switched: true };
    }
    async restoreHumanActionSession(sessionId) {
      calls.push(['restoreHuman', sessionId]);
      return { restored: true };
    }
    async recordPreviewVideo(outPath, durationS) {
      calls.push(['recordVideo', outPath, durationS]);
      if (opts.recordFails) throw Error('RECORD_FAILED');
      return { outPath, durationS };
    }
    async beginPreviewRecording(outPath, projectPath) {
      calls.push(['beginRecording', outPath, projectPath]);
      if (opts.startRecordFails) throw Error('START_RECORD_FAILED');
      return { outPath, projectPath };
    }
    async endPreviewRecording() {
      calls.push(['endRecording']);
      return { stopped: true };
    }
    async abortPreviewRecording() {
      calls.push(['abortRecording']);
      return { aborted: true };
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
    [M.ef]: { ProjectManager: { getInstance: () => ({ getActiveProject: () => ({ path: opts.projectPath ?? '/tmp/mock-project' }) }) } },
    [M.preview]: { PreviewManager: { getInstance: () => preview }, PreviewStreamState: { Playing: 0, Paused: 2 } },
    [M.ehPreview]: { EHPreviewCommand },
    [M.ehCommandManager]: { EHCommandManager },
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
  assert.deepEqual(calls, ['resume', ['activate', 'xiangsu-mcp-plus-audio'], ['reload', 0]], 'resumed before the reload, which needs a playing preview');
  assert.deepEqual(await lib.previewAudioSession({ action: 'stop' }), { restored: true, active: false });
  assert.deepEqual(calls.slice(3), [['deactivate', 'xiangsu-mcp-plus-audio'], ['reload', 0]]);
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

test('previewActions supports drag, pause, resume, and set_preview_property with validation', async () => {
  const { lib, calls } = setup();
  const ok = await lib.previewActions({
    commands: [
      { command_type: 'drag', params: { x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9 } },
      { command_type: 'drag', params: { x1: 0, y1: 1, x2: 0.5, y2: 0.5, steps: 20, duration_ms: 600 } },
      { command_type: 'pause' },
      { command_type: 'resume' },
      {
        command_type: 'set_preview_property',
        params: { scene_object_guid: 'guid-1', component_type: 'Transform', property: 'position', value: [1, 2, 3] },
      },
    ],
  });
  assert.equal(ok.success, true);
  assert.deepEqual(calls, [
    ['drag', 0.1, 0.2, 0.8, 0.9, 10, 300],
    ['drag', 0, 1, 0.5, 0.5, 20, 600],
    ['pause'],
    ['resumePreview'],
    ['setProperty', 'guid-1', 'Transform', 'position', [1, 2, 3]],
  ]);

  const badCoord = await lib.previewActions({
    commands: [{ command_type: 'drag', params: { x1: -0.1, y1: 0.2, x2: 0.8, y2: 0.9 } }],
  });
  assert.equal(badCoord.success, false);
  assert.match(badCoord.results[0].error, /INVALID_ARGUMENTS.*x1/);

  const badCoordHigh = await lib.previewActions({
    commands: [{ command_type: 'drag', params: { x1: 0.1, y1: 0.2, x2: 1.5, y2: 0.9 } }],
  });
  assert.equal(badCoordHigh.success, false);
  assert.match(badCoordHigh.results[0].error, /INVALID_ARGUMENTS.*x2/);

  const badProp = await lib.previewActions({
    commands: [{ command_type: 'set_preview_property', params: { scene_object_guid: 'guid-1', component_type: 'Transform' } }],
  });
  assert.equal(badProp.success, false);
  assert.match(badProp.results[0].error, /INVALID_ARGUMENTS/);
});

test('previewActions manages human_action sessions and restore_human_action', async () => {
  const { lib, calls } = setup();
  const res = await lib.previewActions({
    commands: [
      { command_type: 'human_action', params: { action_id: 'wave', input_type: 'preview_hand' } },
      { command_type: 'human_action', params: { file_path: '/tmp/dance.mp4', input_type: 'preview_fullbody' } },
      { command_type: 'restore_human_action' },
      { command_type: 'human_action', params: { action_id: 'smile', file_path: '/tmp/face.mp4', input_type: 'preview_face' } },
    ],
  });
  assert.equal(res.success, true);
  assert.deepEqual(calls, [
    ['beginHuman', 'xiangsu-mcp-plus-human'],
    ['switchHuman', 'xiangsu-mcp-plus-human', 'wave', undefined, 'preview_hand'],
    ['switchHuman', 'xiangsu-mcp-plus-human', '/tmp/dance.mp4', '/tmp/dance.mp4', 'preview_fullbody'],
    ['restoreHuman', 'xiangsu-mcp-plus-human'],
    ['beginHuman', 'xiangsu-mcp-plus-human'],
    ['switchHuman', 'xiangsu-mcp-plus-human', 'smile', '/tmp/face.mp4', 'preview_face'],
  ]);

  const badType = await lib.previewActions({
    commands: [{ command_type: 'human_action', params: { action_id: 'wave', input_type: 'invalid_type' } }],
  });
  assert.equal(badType.success, false);
  assert.match(badType.results[0].error, /INVALID_INPUT_TYPE: invalid_type/);
});

test('previewRecord supports record, start/stop, abort, and cleans up on error', async () => {
  assert.equal(METHODS.preview_record, 'previewRecord');

  const { lib, calls } = setup({ projectPath: '/tmp/proj-a' });
  const recDefault = await lib.previewRecord({ action: 'record' });
  assert.equal(recDefault.action, 'record');
  assert.equal(recDefault.duration_s, 5);
  assert.match(recDefault.path, /xiangsu-preview-\d+\.mp4$/);
  assert.deepEqual(calls.at(-1), ['recordVideo', recDefault.path, 5]);

  const recCustom = await lib.previewRecord({ action: 'record', duration_s: 12, save_to: '/tmp/custom.mp4' });
  assert.equal(recCustom.path, '/tmp/custom.mp4');
  assert.deepEqual(calls.at(-1), ['recordVideo', '/tmp/custom.mp4', 12]);

  const started = await lib.previewRecord({ action: 'start', save_to: '/tmp/session.mp4' });
  assert.equal(started.action, 'start');
  assert.equal(started.path, '/tmp/session.mp4');
  assert.equal(started.projectPath, '/tmp/proj-a');
  assert.deepEqual(calls.at(-1), ['beginRecording', '/tmp/session.mp4', '/tmp/proj-a']);

  const stopped = await lib.previewRecord({ action: 'stop' });
  assert.equal(stopped.action, 'stop');
  assert.equal(stopped.path, '/tmp/session.mp4');
  assert.deepEqual(calls.at(-1), ['endRecording']);

  const aborted = await lib.previewRecord({ action: 'abort' });
  assert.equal(aborted.action, 'abort');
  assert.deepEqual(calls.at(-1), ['abortRecording']);

  const stoppedAfterAbort = await lib.previewRecord({ action: 'stop' });
  assert.equal(stoppedAfterAbort.path, undefined);

  await assert.rejects(lib.previewRecord({ action: 'invalid' }), /INVALID_ACTION/);
  await assert.rejects(lib.previewRecord({ action: 'record', duration_s: 0 }), /INVALID_DURATION/);
  await assert.rejects(lib.previewRecord({ action: 'record', duration_s: 61 }), /INVALID_DURATION/);

  const recErr = setup({ recordFails: true });
  await assert.rejects(recErr.lib.previewRecord({ action: 'record', save_to: '/tmp/fail.mp4' }), /RECORD_FAILED/);
  assert.deepEqual(recErr.calls.at(-1), ['abortRecording']);

  const startErr = setup({ startRecordFails: true });
  await assert.rejects(startErr.lib.previewRecord({ action: 'start', save_to: '/tmp/fail-start.mp4' }), /START_RECORD_FAILED/);
  assert.deepEqual(startErr.calls.at(-1), ['abortRecording']);
  const stopAfterFail = await startErr.lib.previewRecord({ action: 'stop' });
  assert.equal(stopAfterFail.path, undefined);
});
