import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PRESETS, SR, synth, wav, writeSound } from '../src/sfx.mjs';

// Samples of the original make_sfx.py functions (numpy, unscaled), at [index, value]; the presets are ports of them.
const REFERENCE = {
  ding: { length: 44100, peak: 2.490106571493371, at: [[10, 0.12856132993204344], [1000, -0.9708566314488845], [14700, 0.39576470306641465], [22050, -0.1668850818502802], [44095, 0]] },
  wahwah: { length: 86436, peak: 1.6221798868542985, at: [[10, 0.006056171862715832], [1000, -0.6889522859763687], [28812, -0.12909830886882237], [43218, -0.18388499750553514], [86431, -0.0003734446501568413]] },
  heartbeat: { length: 39690, peak: 0.9302986845690288, at: [[10, 0.00547644631312443], [1000, 0.4431044107329853], [13230, -0.09033968978059809], [19845, 0.0017867902264687126], [39685, 0]] },
  win: { length: 58653, peak: 2.558764900750012, at: [[10, 0.055358311915334], [1000, -0.9602783458773929], [19551, -0.3525627697458413], [29326, -0.5175215282139329], [58648, 0.033042428541426985]] },
};

test('sound presets match the original scripts sample for sample', () => {
  for (const [name, ref] of Object.entries(REFERENCE)) {
    const y = PRESETS[name].make(1);
    assert.equal(y.length, ref.length, `${name} length`);
    for (const [i, v] of ref.at) assert.ok(Math.abs(y[i] - v) < 1e-9, `${name}[${i}] = ${y[i]}, script ${v}`);
    assert.ok(Math.abs(Math.max(...y.map(Math.abs)) - ref.peak) < 1e-9, `${name} peak`);
  }
});

test('every preset synthesizes a finite sound scaled to its peak, and pitch raises the frequency', () => {
  for (const name of Object.keys(PRESETS)) {
    const y = synth(name);
    assert.ok(y.length > SR * 0.05, `${name} is audible length`);
    assert.ok(y.every(Number.isFinite), `${name} finite`);
    const peak = Math.max(...y.map(Math.abs));
    assert.ok(Math.abs(peak - PRESETS[name].peak) < 1e-6, `${name} peak ${peak}`);
  }
  assert.ok(Math.abs(Math.max(...synth('ding', { peak: 0.2 }).map(Math.abs)) - 0.2) < 1e-6);
  // The first 20 ms of 揭晓叮 (a 1568 Hz tone): zero crossings double with pitch 2.
  const crossings = (y) => y.slice(0, SR * 0.02).reduce((n, v, i, a) => n + (i && Math.sign(v) !== Math.sign(a[i - 1]) ? 1 : 0), 0);
  const base = crossings(synth('reveal'));
  const up = crossings(synth('reveal', { pitch: 2 }));
  assert.ok(Math.abs(up / base - 2) < 0.1, `crossings ${base} → ${up}`);
  assert.throws(() => synth('nope'), /UNKNOWN_SFX_PRESET: nope; presets: ding, tick/);
});

test('sounds are written as 16-bit mono WAV, or as stereo 128 kbps MP3 through ffmpeg', async () => {
  const dir = tmpdir('xs-sfx-');
  const samples = Float32Array.from([0, 0.5, -1, 2]);
  const buf = wav(samples);
  assert.equal(buf.toString('latin1', 0, 4), 'RIFF');
  assert.equal(buf.readUInt32LE(24), SR);
  assert.equal(buf.readUInt16LE(22), 1);
  assert.deepEqual([0, 1, 2, 3].map((i) => buf.readInt16LE(44 + i * 2)), [0, 16384, -32767, 32767]);
  await writeSound(samples, path.join(dir, 'a.wav'));
  assert.deepEqual(fs.readFileSync(path.join(dir, 'a.wav')), buf);

  const calls = [];
  const encode = async (args) => {
    calls.push(args);
    assert.deepEqual(fs.readFileSync(args[1]), buf, 'ffmpeg reads the WAV');
    fs.writeFileSync(args.at(-1), 'mp3');
  };
  await writeSound(samples, path.join(dir, 'b.mp3'), { encode });
  assert.deepEqual(calls[0].slice(2), ['-ac', '2', '-b:a', '128k', path.join(dir, 'b.mp3')]);
  assert.equal(fs.readFileSync(path.join(dir, 'b.mp3'), 'utf8'), 'mp3');
  await assert.rejects(writeSound(samples, path.join(dir, 'c.mp3'), { encode: async () => {} }), /SFX_ENCODE_FAILED/);
});
