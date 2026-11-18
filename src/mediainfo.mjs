// Probe and preview media with 像塑's bundled ffmpeg/ffprobe: video contact sheets, audio loudness /
// silence / onsets, and optional trim/export. Used by image_view and audio_probe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PNG } from 'pngjs';
import { editorFfmpeg, ffmpeg as runFfmpeg } from './editorres.mjs';

const run = promisify(execFile);
const VIDEO_EXT = /\.(mp4|mov|webm)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;

export const isVideoPath = (p) => VIDEO_EXT.test(p);
export const isAudioPath = (p) => AUDIO_EXT.test(p);

export function editorFfprobe() {
  return path.join(path.dirname(editorFfmpeg()), 'ffprobe');
}

async function ffprobeJson(file, { exec = run } = {}) {
  try {
    const { stdout } = await exec(editorFfprobe(), [
      '-v', 'error', '-print_format', 'json',
      '-show_format', '-show_streams',
      file,
    ], { maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (e) {
    throw Error(`FFPROBE_FAILED: ${path.basename(file)}: ${String(e.stderr || e.message).trim().slice(0, 300)}`);
  }
}

function streamOf(info, type) {
  return (info.streams || []).find((s) => s.codec_type === type) || null;
}

export async function probeVideo(file, { exec = run } = {}) {
  const info = await ffprobeJson(file, { exec });
  const v = streamOf(info, 'video');
  const a = streamOf(info, 'audio');
  if (!v) throw Error(`NOT_A_VIDEO: ${file}`);
  const duration_s = Number(info.format?.duration || v.duration || 0);
  const fpsParts = String(v.avg_frame_rate || v.r_frame_rate || '0/1').split('/');
  const fps = fpsParts.length === 2 && Number(fpsParts[1]) ? Number(fpsParts[0]) / Number(fpsParts[1]) : 0;
  return {
    duration_s: Number(duration_s.toFixed(3)),
    width: v.width || null,
    height: v.height || null,
    fps: Number(fps.toFixed(3)),
    has_audio: Boolean(a),
  };
}

export async function probeAudio(file, { exec = run, ffmpeg = runFfmpeg } = {}) {
  const info = await ffprobeJson(file, { exec });
  const a = streamOf(info, 'audio');
  if (!a) throw Error(`NOT_AN_AUDIO: ${file}`);
  const duration_s = Number(info.format?.duration || a.duration || 0);
  const base = {
    duration_s: Number(duration_s.toFixed(3)),
    sample_rate: a.sample_rate ? Number(a.sample_rate) : null,
    channels: a.channels ?? null,
    codec: a.codec_name || null,
  };
  const vol = await volumeStats(file);
  const silence_ranges = await silenceRanges(file);
  const onset_peaks_s = await onsetPeaks(file, duration_s, { ffmpeg });
  return { ...base, ...vol, silence_ranges, onset_peaks_s };
}

async function ffmpegStderr(args, { exec = run } = {}) {
  try {
    const { stderr } = await exec(editorFfmpeg(), ['-hide_banner', '-nostdin', '-y', ...args], { maxBuffer: 16 * 1024 * 1024 });
    return String(stderr || '');
  } catch (e) {
    const stderr = String(e.stderr || '');
    // Analysis filters often exit non-zero after printing the metrics we need.
    if (stderr) return stderr;
    throw Error(`FFMPEG_FAILED: ${String(e.message).trim().slice(0, 600)}`);
  }
}

async function volumeStats(file) {
  const stderr = await ffmpegStderr(['-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const mean = /mean_volume:\s*([-\d.]+)/.exec(stderr);
  const max = /max_volume:\s*([-\d.]+)/.exec(stderr);
  return {
    mean_volume_db: mean ? Number(mean[1]) : null,
    max_volume_db: max ? Number(max[1]) : null,
  };
}

async function silenceRanges(file) {
  const stderr = await ffmpegStderr(['-i', file, '-af', 'silencedetect=noise=-40dB:d=0.3', '-f', 'null', '-']);
  const ranges = [];
  let start = null;
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*([\d.]+)/.exec(line);
    if (s) start = Number(s[1]);
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && start !== null) {
      ranges.push({ start_s: Number(start.toFixed(3)), end_s: Number(Number(e[1]).toFixed(3)) });
      start = null;
    }
  }
  return ranges;
}

// Onset peaks via ffmpeg's astats RMS over short windows — good enough for beat markers agents used
// to extract with one-off scripts. Returns up to 64 timestamps (seconds).
async function onsetPeaks(file, duration_s, { ffmpeg }) {
  if (!(duration_s > 0)) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-onset-'));
  const wav = path.join(dir, 'mono.wav');
  try {
    await ffmpeg(['-i', file, '-ac', '1', '-ar', '8000', '-f', 'wav', wav]);
    const buf = fs.readFileSync(wav);
    // Skip WAV header (44 bytes for PCM) and read int16 samples.
    const samples = new Int16Array(buf.buffer, buf.byteOffset + 44, Math.floor((buf.length - 44) / 2));
    const window = 800; // 100 ms at 8 kHz
    const energies = [];
    for (let i = 0; i + window <= samples.length; i += window) {
      let sum = 0;
      for (let j = 0; j < window; j++) sum += Math.abs(samples[i + j]);
      energies.push(sum / window);
    }
    if (!energies.length) return [];
    const mean = energies.reduce((a, b) => a + b, 0) / energies.length;
    const threshold = mean * 1.8;
    const peaks = [];
    for (let i = 1; i < energies.length - 1; i++) {
      if (energies[i] >= threshold && energies[i] >= energies[i - 1] && energies[i] >= energies[i + 1]) {
        peaks.push(Number(((i * window) / 8000).toFixed(3)));
      }
    }
    return peaks.slice(0, 64);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function exportAudio(file, { trim_start_s, trim_end_s, export_path, mono_16k, ffmpeg = runFfmpeg } = {}) {
  if (!export_path) throw Error('EXPORT_PATH_REQUIRED');
  if (!path.isAbsolute(export_path)) throw Error(`EXPORT_PATH_NOT_ABSOLUTE: ${export_path}`);
  fs.mkdirSync(path.dirname(export_path), { recursive: true });
  const args = ['-i', file];
  if (trim_start_s !== undefined) args.push('-ss', String(trim_start_s));
  if (trim_end_s !== undefined) args.push('-to', String(trim_end_s));
  if (mono_16k) args.push('-ac', '1', '-ar', '16000');
  const ext = path.extname(export_path).toLowerCase();
  if (ext === '.mp3') args.push('-codec:a', 'libmp3lame', '-b:a', '128k');
  else if (ext === '.wav') args.push('-codec:a', 'pcm_s16le');
  else throw Error(`EXPORT_FORMAT_UNSUPPORTED: ${ext}; use .wav or .mp3`);
  args.push(export_path);
  await ffmpeg(args);
  if (!fs.existsSync(export_path) || fs.statSync(export_path).size === 0) throw Error(`AUDIO_EXPORT_FAILED: wrote nothing to ${export_path}`);
  return { export_path, bytes: fs.statSync(export_path).size };
}

// Uniform 3×2 contact sheet with second labels burned in.
export async function videoContactSheet(file, { cols = 3, rows = 2, tile = 320, ffmpeg = runFfmpeg, probe = probeVideo } = {}) {
  const meta = await probe(file);
  const n = cols * rows;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-vsheet-'));
  try {
    const times = Array.from({ length: n }, (_, i) => (meta.duration_s > 0 ? ((i + 0.5) / n) * meta.duration_s : 0));
    const frames = [];
    for (const [i, t] of times.entries()) {
      const out = path.join(dir, `f${i}.jpg`);
      await ffmpeg(['-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', `scale=${tile}:-1`, out]);
      if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw Error(`VIDEO_FRAME_FAILED: t=${t}`);
      frames.push({ file: out, t });
    }
    const imgs = await Promise.all(frames.map((f) => loadImage(f.file)));
    const tw = Math.max(...imgs.map((im) => im.width));
    const th = Math.max(...imgs.map((im) => im.height));
    const canvas = createCanvas(cols * tw, rows * th);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    imgs.forEach((im, i) => {
      const x = (i % cols) * tw;
      const y = Math.floor(i / cols) * th;
      ctx.drawImage(im, x + (tw - im.width) / 2, y + (th - im.height) / 2);
      const label = `${frames[i].t.toFixed(2)}s`;
      ctx.font = 'bold 18px sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#000';
      ctx.fillStyle = '#fff';
      ctx.strokeText(label, x + 8, y + 24);
      ctx.fillText(label, x + 8, y + 24);
    });
    const png = canvas.toBuffer('image/png');
    return { meta, png, times_s: times.map((t) => Number(t.toFixed(3))) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function imageMetaFromPng(buf) {
  const img = PNG.sync.read(buf);
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1, opaque = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const a = img.data[(y * img.width + x) * 4 + 3];
      if (a > 0) {
        opaque++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const alpha_bbox = maxX >= 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
  return {
    width: img.width,
    height: img.height,
    alpha_bbox,
    opaque_ratio: Number((opaque / (img.width * img.height)).toFixed(4)),
  };
}

export async function cropBuffer(buf, mimeType, crop) {
  const img = await loadImage(buf);
  const x = Math.round(crop.x * img.width);
  const y = Math.round(crop.y * img.height);
  const w = Math.max(1, Math.min(img.width - x, Math.round(crop.width * img.width)));
  const h = Math.max(1, Math.min(img.height - y, Math.round(crop.height * img.height)));
  const canvas = createCanvas(w, h);
  canvas.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
  const out = canvas.toBuffer('image/png');
  return { data: out.toString('base64'), mimeType: 'image/png', width: w, height: h };
}
