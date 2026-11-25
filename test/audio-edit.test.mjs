import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from './tmp.mjs';
import { editorFfmpeg } from '../src/editorres.mjs';
import { normalizeAudioClips, renderAudio } from '../src/audioedit.mjs';
import { prepareAudioTemplate, openAudioProject } from '../src/audiotemplate.mjs';

const work = tmpdir('audio-edit-');
// Keep the test app isolated: expose only read-only media binaries, never a live editor plugin.
// CI uses a system FFmpeg directory; local runs default to the installed editor's binaries.
const mediaSource = process.env.XIANGSU_TEST_FFMPEG_DIR || path.join('/Applications/Douyin AR.app/Contents/Resources/BuiltinResource/ffmpeg', process.arch === 'arm64' ? 'arm64' : 'x64');
const media = path.join(work, 'media.app/Contents/Resources/BuiltinResource/ffmpeg', process.arch === 'arm64' ? 'arm64' : 'x64');
fs.mkdirSync(media, { recursive: true });
for (const binary of ['ffmpeg', 'ffprobe']) {
  const source = path.join(mediaSource, binary);
  if (!fs.existsSync(source)) throw Error(`AUDIO_TEST_BINARY_NOT_FOUND: ${source}; set XIANGSU_TEST_FFMPEG_DIR to a directory containing ffmpeg and ffprobe`);
  fs.symlinkSync(source, path.join(media, binary));
}
process.env.XIANGSU_APP = path.join(work, 'media.app');
const tone = path.join(work, 'tone.wav');
execFileSync(editorFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=48000', '-codec:a', 'pcm_s16le', tone]);
function pcm(file) {
  const b = execFileSync(editorFfmpeg(), ['-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 32 * 1024 * 1024 });
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}
const rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
const window = (a, start, end) => a.subarray(Math.round(start * 48000), Math.round(end * 48000));
function frequency(a) {
  let crossings = 0;
  for (let i = 1; i < a.length; i++) if (a[i - 1] < 0 && a[i] >= 0) crossings++;
  return crossings * 48000 / a.length;
}
async function make(name, clips) {
  const file = path.join(work, name + '.wav');
  const result = await renderAudio({ clips, export_path: file });
  return { result, samples: pcm(file), file };
}

test('real audio rendering preserves gain, mixes overlapping clips, and sequences on the timeline', async () => {
  const base = await make('base', [{ file_path: tone }]);
  const quiet = await make('quiet', [{ file_path: tone, volume: 0.25 }]);
  assert.ok(Math.abs(rms(quiet.samples) / rms(base.samples) - 0.25) < 0.001);
  const mixed = await make('mixed', [
    { file_path: tone, trim_start_s: 0.5, trim_end_s: 2.5, volume: 0.25 },
    { file_path: tone, start_s: 1, trim_end_s: 2, volume: 0.25 },
  ]);
  assert.equal(mixed.samples.length, 3 * 48000);
  const first = rms(window(mixed.samples, 0.1, 0.9)), overlap = rms(window(mixed.samples, 1.1, 1.9));
  assert.ok(Math.abs(overlap / first - 2) < 0.002, 'both timeline clips must reach the mix');
  const sequence = await make('sequence', [{ file_path: tone, trim_end_s: 1 }, { file_path: tone, start_s: 1.5, trim_end_s: 1 }]);
  assert.equal(sequence.samples.length, 120000);
  assert.equal(rms(window(sequence.samples, 1.05, 1.45)), 0);
  assert.ok(rms(window(sequence.samples, 1.6, 2.4)) > 0.05);
});

test('speed and pitch are independently audible and tempo chains cover both directions', async () => {
  for (const [name, speed, pitch, seconds, hz] of [['fast', 2, 0, 1.5, 440], ['up', 1, 12, 3, 880], ['slow-high', 0.5, 24, 6, 1760], ['fast-low', 4, -12, 0.75, 220]]) {
    const { samples } = await make(name, [{ file_path: tone, speed, pitch_semitones: pitch }]);
    assert.equal(samples.length, Math.round(seconds * 48000));
    assert.ok(Math.abs(frequency(window(samples, 0.15, seconds - 0.15)) - hz) / hz < 0.02, `${name}: pitch must survive tempo processing`);
  }
});

test('fades affect both endpoints and each explicit effect changes decoded samples', async () => {
  const base = await make('dry', [{ file_path: tone }]);
  const faded = await make('faded', [{ file_path: tone, fade_in_s: 1, fade_out_s: 1 }]);
  const middle = rms(window(faded.samples, 1.2, 1.8));
  assert.ok(rms(window(faded.samples, 0, 0.1)) < middle * 0.1);
  assert.ok(rms(window(faded.samples, 2.9, 3)) < middle * 0.1);
  for (const effect of ['echo', 'telephone', 'denoise']) {
    const processed = await make(effect, [{ file_path: tone, effect }]);
    assert.equal(processed.samples.length, base.samples.length);
    assert.notDeepEqual(processed.samples, base.samples, `${effect} must process actual media`);
    assert.ok(rms(window(processed.samples, 0.2, 2.8)) > 0.005);
  }
});

test('invalid edits fail and failed rendering preserves existing output', async () => {
  for (const changes of [{ speed: 0 }, { speed: Infinity }, { volume: -1 }, { start_s: -1 }, { trim_end_s: 5 }, { trim_start_s: 2, trim_end_s: 1 }, { pitch_semitones: NaN }, { fade_in_s: 4 }, { effect: 'unknown' }]) {
    await assert.rejects(normalizeAudioClips([{ file_path: tone, ...changes }]), /AUDIO_EDIT_/);
  }
  await assert.rejects(renderAudio({ clips: [{ file_path: tone }], export_path: tone }), /OUTPUT_IS_INPUT/);
  const out = path.join(work, 'keep.wav'); fs.writeFileSync(out, 'keep');
  await assert.rejects(renderAudio({ clips: [{ file_path: tone }], export_path: out }, { render: async () => { throw Error('injected renderer failure'); } }), /injected renderer failure/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'keep');
});

test('multitrack source round trip preserves trims, gain, speed, offsets and media bytes; edits survive a new ZIP', async () => {
  const mp3 = path.join(work, 'original.mp3');
  execFileSync(editorFfmpeg(), ['-v', 'error', '-i', tone, '-codec:a', 'libmp3lame', mp3]);
  const clips = [
    { file_path: mp3, start_s: 0, trim_start_s: 0.25, trim_end_s: 2.25, volume: 0.35, speed: 2 },
    { file_path: mp3, start_s: 0.5, trim_start_s: 0, trim_end_s: 2, volume: 0.2, speed: 0.5 },
  ];
  const original = await prepareAudioTemplate({ clips, name: '多轨', out_dir: work });
  const template = JSON.parse(execFileSync('/usr/bin/unzip', ['-p', original.template_zip, 'NLETemplate.json']));
  const templateTracks = template._objects[template._templateModel]._arrays.Track;
  assert.equal(templateTracks.length, 2);
  for (const [i, id] of templateTracks.entries()) {
    const slot = template._objects[template._objects[id]._arrays.Slot[0]];
    const segment = template._objects[slot._objects.MainSegment];
    const resource = template._objects[segment._objects.AVFile];
    assert.deepEqual(execFileSync('/usr/bin/unzip', ['-p', original.template_zip, resource.ResourceFile]), fs.readFileSync(mp3));
    assert.deepEqual([segment.Volume, segment.Speed, segment.TimeClipStart, segment.TimeClipEnd, slot.StartTime, slot.EndTime], [clips[i].volume, clips[i].speed, clips[i].trim_start_s * 1e6, clips[i].trim_end_s * 1e6, clips[i].start_s * 1e6, (clips[i].start_s + (clips[i].trim_end_s - clips[i].trim_start_s) / clips[i].speed) * 1e6]);
  }
  const opened = await openAudioProject({ project_zip: original.project_zip, out_dir: work });
  assert.equal(opened.clips.length, 2);
  for (const [i, c] of opened.clips.entries()) {
    assert.deepEqual(fs.readFileSync(c.file_path), fs.readFileSync(mp3));
    for (const key of ['start_s', 'trim_start_s', 'trim_end_s', 'volume', 'speed']) assert.equal(c[key], clips[i][key]);
  }
  opened.clips[1].volume = 0.6; opened.clips[1].start_s = 2;
  const resaved = await prepareAudioTemplate({ clips: opened.clips, name: '续编', out_dir: work });
  const second = await openAudioProject({ project_zip: resaved.project_zip, out_dir: work });
  assert.equal(second.name, '续编');
  assert.equal(second.clips[1].volume, 0.6); assert.equal(second.clips[1].start_s, 2);
  const rendered = await renderAudio({ clips: second.clips, export_path: path.join(work, 'continued.mp3') });
  assert.equal(rendered.duration_s, 6);
  assert.equal(rendered.audio.codec, 'mp3');
});

test('source loader refuses missing media and native filters instead of dropping them', async () => {
  const mp3 = path.join(work, 'negative-fixture.mp3');
  execFileSync(editorFfmpeg(), ['-v', 'error', '-i', tone, '-codec:a', 'libmp3lame', mp3]);
  const { project_zip: prior } = await prepareAudioTemplate({ audio_path: mp3, out_dir: work });
  const unpack = path.join(work, 'bad-source');fs.mkdirSync(unpack);
  execFileSync('/usr/bin/unzip', ['-q', prior, '-d', unpack]);
  const file = path.join(unpack, 'nle/nle_draft.json'); const original = fs.readFileSync(file, 'utf8');
  const draft = JSON.parse(original); const resource = Object.values(draft._objects).find(n => n._class === 'NLEResourceAV');
  const media = path.join(unpack, 'nle', resource.ResourceFile);const bytes = fs.readFileSync(media);fs.unlinkSync(media);
  assert.equal(fs.existsSync(media), false, 'missing audio injection applied');
  const missing = path.join(work, 'missing.zip');execFileSync('/usr/bin/zip', ['-qr', missing, '.'], { cwd: unpack });
  await assert.rejects(openAudioProject({ project_zip: missing, out_dir: work }), /MISSING_RESOURCE/);
  fs.writeFileSync(media, bytes);
  for (const [i, cls] of ['NLESegmentAudio', 'NLETrack', 'NLETrackSlot'].entries()) {
    const changed = JSON.parse(original); const target = Object.values(changed._objects).find(n => n._class === cls);
    target._arrays = { ...target._arrays, Filters: ['999'] };
    assert.deepEqual(target._arrays.Filters, ['999'], 'native filter injection applied');fs.writeFileSync(file, JSON.stringify(changed));
    const filtered = path.join(work, `filtered-${i}.zip`);execFileSync('/usr/bin/zip', ['-qr', filtered, '.'], { cwd: unpack });
    await assert.rejects(openAudioProject({ project_zip: filtered, out_dir: work }), /UNSUPPORTED_AUDIO_FILTER/);
  }
  const badZip = path.join(work, 'unsafe.zip');fs.copyFileSync(prior, badZip);fs.writeFileSync(path.join(work, 'escape.txt'), 'unsafe archive path');
  execFileSync('/usr/bin/zip', ['-q', badZip, '../escape.txt'], { cwd: unpack });
  assert.ok(execFileSync('/usr/bin/unzip', ['-Z1', badZip], { encoding: 'utf8' }).split('\n').includes('../escape.txt'), 'unsafe ZIP entry injection applied');
  await assert.rejects(openAudioProject({ project_zip: badZip, out_dir: work }), /UNSAFE_OR_DUPLICATE_ENTRY/);
});
