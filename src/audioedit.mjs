import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg } from './editorres.mjs';
import { probeAudio } from './mediainfo.mjs';

export const AUDIO_EFFECTS = ['none', 'echo', 'telephone', 'denoise'];
const finite = (n, label, min, inclusive = true) => {
  if (!Number.isFinite(n) || (inclusive ? n < min : n <= min)) throw Error(`AUDIO_EDIT_INVALID_${label}`);
  return n;
};

export async function normalizeAudioClips(clips, { probe = probeAudio } = {}) {
  if (!Array.isArray(clips) || !clips.length) throw Error('AUDIO_EDIT_CLIPS_REQUIRED');
  const metadata = new Map();
  const out = [];
  for (const c of clips) {
    if (!path.isAbsolute(c.file_path || '')) throw Error('AUDIO_EDIT_ABSOLUTE_PATH_REQUIRED');
    if (!metadata.has(c.file_path)) metadata.set(c.file_path, await probe(c.file_path));
    const audio = metadata.get(c.file_path);
    const start_s = finite(c.start_s ?? 0, 'START', 0);
    const trim_start_s = finite(c.trim_start_s ?? 0, 'TRIM_START', 0);
    const trim_end_s = finite(c.trim_end_s ?? audio.duration_s, 'TRIM_END', trim_start_s, false);
    if (trim_end_s > audio.duration_s) throw Error('AUDIO_EDIT_TRIM_EXCEEDS_SOURCE');
    const speed = finite(c.speed ?? 1, 'SPEED', 0, false);
    const volume = finite(c.volume ?? 1, 'VOLUME', 0);
    const pitch_semitones = c.pitch_semitones ?? 0;
    if (!Number.isFinite(pitch_semitones) || !Number.isFinite(2 ** (pitch_semitones / 12)) || 2 ** (pitch_semitones / 12) === 0) throw Error('AUDIO_EDIT_INVALID_PITCH');
    const duration_s = (trim_end_s - trim_start_s) / speed;
    finite(duration_s, 'DURATION', 0, false);
    finite(speed / (2 ** (pitch_semitones / 12)), 'TEMPO', 0, false);
    const fade_in_s = finite(c.fade_in_s ?? 0, 'FADE_IN', 0);
    const fade_out_s = finite(c.fade_out_s ?? 0, 'FADE_OUT', 0);
    if (fade_in_s + fade_out_s > duration_s) throw Error('AUDIO_EDIT_FADES_EXCEED_CLIP');
    const effect = c.effect ?? 'none';
    if (!AUDIO_EFFECTS.includes(effect)) throw Error(`AUDIO_EDIT_INVALID_EFFECT: ${effect}`);
    out.push({ file_path: c.file_path, start_s, trim_start_s, trim_end_s, speed, volume, pitch_semitones, fade_in_s, fade_out_s, effect, duration_s, source: audio });
  }
  return out;
}

// Each atempo stage stays in 0.5–2, supported by the editor's FFmpeg. Pitch resampling is
// compensated by tempo, so pitch changes do not intentionally change the clip's duration.
function tempoFilters(value) {
  const out = [];
  while (value > 2) { out.push('atempo=2'); value /= 2; }
  while (value < 0.5) { out.push('atempo=0.5'); value /= 0.5; }
  out.push(`atempo=${value}`);
  return out;
}

export async function renderAudio({ clips, export_path }, { probe = probeAudio, render = ffmpeg } = {}) {
  if (!path.isAbsolute(export_path || '')) throw Error('AUDIO_EDIT_EXPORT_ABSOLUTE_PATH_REQUIRED');
  const ext = path.extname(export_path).toLowerCase();
  if (!['.mp3', '.wav'].includes(ext)) throw Error('AUDIO_EDIT_EXPORT_FORMAT: use .mp3 or .wav');
  const normalized = await normalizeAudioClips(clips, { probe });
  if (normalized.some(c => path.resolve(c.file_path) === path.resolve(export_path))) throw Error('AUDIO_EDIT_OUTPUT_IS_INPUT');
  const duration_s = Math.max(...normalized.map(c => c.start_s + c.duration_s));
  const graph = normalized.map((c, i) => {
    const ratio = 2 ** (c.pitch_semitones / 12);
    const filters = [`atrim=start=${c.trim_start_s}:end=${c.trim_end_s}`, 'asetpts=PTS-STARTPTS', 'aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo'];
    if (ratio !== 1) filters.push(`asetrate=${48000 * ratio}`, 'aresample=48000');
    if (c.speed / ratio !== 1) filters.push(...tempoFilters(c.speed / ratio));
    // Effect values are explicit convenience presets, not mobile SDK effect equivalence.
    if (c.effect === 'echo') filters.push('aecho=0.8:0.88:60:0.35');
    if (c.effect === 'telephone') filters.push('highpass=f=300', 'lowpass=f=3400');
    if (c.effect === 'denoise') filters.push('afftdn');
    filters.push(`volume=${c.volume}`);
    if (c.fade_in_s) filters.push(`afade=t=in:st=0:d=${c.fade_in_s}`);
    if (c.fade_out_s) filters.push(`afade=t=out:st=${c.duration_s - c.fade_out_s}:d=${c.fade_out_s}`);
    // apad makes tempo endpoints deterministic; trim also bounds effect tails to the timeline.
    filters.push('apad', `atrim=duration=${c.duration_s}`, `adelay=${Math.round(c.start_s * 48000)}S:all=1`);
    return `[${i}:a]${filters.join(',')}[a${i}]`;
  });
  graph.push(`${normalized.map((_, i) => `[a${i}]`).join('')}amix=inputs=${normalized.length}:duration=longest:dropout_transition=0:normalize=0[mix]`);
  fs.mkdirSync(path.dirname(export_path), { recursive: true });
  const work = fs.mkdtempSync(path.join(path.dirname(export_path), '.audio-render-'));
  const output = path.join(work, 'render' + ext);
  try {
    await render([...normalized.flatMap(c => ['-i', c.file_path]), '-filter_complex', graph.join(';'), '-map', '[mix]', '-t', String(duration_s), '-ar', '48000', '-ac', '2', '-codec:a', ext === '.mp3' ? 'libmp3lame' : 'pcm_s16le', ...(ext === '.mp3' ? ['-b:a', '192k'] : []), output]);
    const audio = await probe(output);
    if (!fs.statSync(output).size || !(audio.duration_s > 0)) throw Error('AUDIO_EDIT_EMPTY_OUTPUT');
    fs.renameSync(output, export_path);
    return { export_path, bytes: fs.statSync(export_path).size, duration_s, audio, clips: normalized, engine: 'desktop_ffmpeg', effects_match_mobile_sdk: false, artwork_submitted: false };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
