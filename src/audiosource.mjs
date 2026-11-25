import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';
import { probeAudio, probeVideo } from './mediainfo.mjs';

const run = promisify(execFile);
const EXTENSIONS = { audio: '.mp3', icon: '.png', showcase: '.mp4', template: '.zip', project: '.zip' };

export async function validateAudioSourceAsset({ file_path, kind = 'audio' }, { audioProbe = probeAudio, videoProbe = probeVideo, exec = run } = {}) {
  if (!Object.hasOwn(EXTENSIONS, kind)) throw Error(`AUDIO_SOURCE_INVALID_ASSET_KIND: ${kind}`);
  if (!path.isAbsolute(file_path || '')) throw Error('AUDIO_SOURCE_FILE_PATH_NOT_ABSOLUTE');
  if (!fs.existsSync(file_path) || !fs.statSync(file_path).isFile()) throw Error(`AUDIO_SOURCE_FILE_NOT_FOUND: ${file_path}`);
  const bytes = fs.statSync(file_path).size;
  if (!bytes) throw Error('AUDIO_SOURCE_FILE_EMPTY');
  if (path.extname(file_path).toLowerCase() !== EXTENSIONS[kind]) throw Error(`AUDIO_SOURCE_FILE_FORMAT: ${kind} requires ${EXTENSIONS[kind]}`);
  if (kind === 'audio') {
    const meta = await audioProbe(file_path);
    if (meta.codec !== 'mp3' || !(meta.duration_s > 0)) throw Error('AUDIO_SOURCE_MP3_REQUIRED: use audio_probe to export MP3 first');
    return { bytes, ...meta };
  }
  if (kind === 'icon') {
    const image = PNG.sync.read(fs.readFileSync(file_path));
    return { bytes, width: image.width, height: image.height, format: 'png' };
  }
  if (kind === 'showcase') {
    const meta = await videoProbe(file_path);
    if (!meta.has_audio) throw Error('AUDIO_SOURCE_SHOWCASE_NEEDS_AUDIO');
    return { bytes, ...meta };
  }
  await exec('/usr/bin/unzip', ['-t', file_path]);
  return { bytes, zip_integrity: true, source_sdk_reopen: 'not_run' };
}

export async function saveAudioSourceTask(task, save_to, { fetchImpl = fetch, audioProbe = probeAudio } = {}) {
  if (!path.isAbsolute(save_to || '')) throw Error('AUDIO_SOURCE_SAVE_DIRECTORY_NOT_ABSOLUTE');
  if (!task.usable) {
    const status = task.state === 'failed' ? 'refused_failed_task' : task.finished ? 'refused_incomplete_task' : 'not_ready';
    return { status, reason: task.error_message || task.state, files: [] };
  }
  fs.mkdirSync(save_to, { recursive: true });
  const directory = fs.mkdtempSync(path.join(save_to, 'audio-source-'));
  try {
    const files = [];
    for (const track of task.tracks) {
      const file = path.join(directory, `track-${track.index}.mp3`);
      // Same 30 s CDN budget as the successful generated-audio downloads and upload readbacks.
      const response = await fetchImpl(track.audio_url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw Error(`AUDIO_SOURCE_DOWNLOAD_FAILED: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) throw Error('AUDIO_SOURCE_DOWNLOAD_EMPTY');
      fs.writeFileSync(file, bytes);
      const meta = await audioProbe(file);
      if (meta.codec !== 'mp3' || !(meta.duration_s > 0)) throw Error('AUDIO_SOURCE_DOWNLOADED_FILE_NOT_MP3');
      let lyrics_file;
      if (track.lyrics) {
        let text = track.lyrics;
        let suffix = 'txt';
        if (typeof text !== 'string') { text = JSON.stringify(text, null, 2); suffix = 'json'; }
        else { try { JSON.parse(text); suffix = 'json'; } catch { /* Plain-text lyrics are saved verbatim. */ } }
        lyrics_file = path.join(directory, `track-${track.index}.lyrics.${suffix}`);
        fs.writeFileSync(lyrics_file, text);
      }
      files.push({ index: track.index, title: track.title, file, lyrics_file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...meta });
    }
    const metadata_file = path.join(directory, 'task.json');
    fs.writeFileSync(metadata_file, JSON.stringify(task, null, 2));
    return { status: 'saved', directory, metadata_file, files };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
