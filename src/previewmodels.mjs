// Our own preview models: a photo (or a video, or two photos alternating) turned into a preview video
// the way the editor's built-in ones are made, and listed in 像塑's shared PreviewResources.json so every
// project window offers it under set_preview_video / preview_frames.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpeg as runFfmpeg, streamTypes as probeStreams } from './editorres.mjs';

const STATE_ROOT = process.env.XIANGSU_MCP_EXT_STATE || path.join(os.homedir(), '.xiangsu-mcp-ext');
export const previewRoot = () => process.env.XIANGSU_PREVIEW_ROOT ?? path.join(os.homedir(), 'Library/Application Support/DouyinAR/Shared/Resources/PreviewResource');
const CONFIG = 'PreviewResources.json';

// Measured on the built-in and earlier added model files: 720×1280 h264 at 30000/1001 fps with a silent
// 44.1 kHz stereo AAC track (5 s for a still photo), a 320×569 GIF of 2 s at 10 fps, a 56×96 PNG icon.
const FPS = '30000/1001';
const FIT = 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1';
const SILENCE = ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'];
const H264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', FPS];
export const PHOTO_SECONDS = 5;
const GIF_SECONDS = 2;
// Picked: how many backups of PreviewResources.json are kept (the newest ones).
const KEEP_BACKUPS = 10;
export const TYPES = ['preview_face', 'preview_fullbody', 'preview_twoperson', 'preview_hand', 'preview_pet', 'preview_environment'];

function readConfig(root) {
  const file = path.join(root, CONFIG);
  if (!fs.existsSync(file)) throw Error(`PREVIEW_CONFIG_NOT_FOUND: ${file} (start 像塑 once first)`);
  const text = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(text);
  if (!Array.isArray(data.defaultVideoInputModels)) throw Error(`PREVIEW_CONFIG_UNEXPECTED: ${file} has no defaultVideoInputModels list`);
  return { file, text, data };
}

function backup(text) {
  const dir = path.join(STATE_ROOT, 'preview-resources-backup');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `PreviewResources.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, text);
  const old = fs.readdirSync(dir).filter((f) => f.startsWith('PreviewResources.')).sort().slice(0, -KEEP_BACKUPS);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

function checkFile(file, what, exts) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.existsSync(file)) throw Error(`${what}_NOT_FOUND: ${file}`);
  if (!exts.test(file)) throw Error(`${what}_FORMAT: ${path.basename(file)}`);
  return file;
}

const IMAGE = /\.(png|jpe?g|webp)$/i;
const VIDEO = /\.(mp4|mov|m4v)$/i;

// The ffmpeg arguments for the preview video, by the kind of input.
async function videoArgs(input, out, streamTypes) {
  if (input.image) {
    return ['-loop', '1', '-framerate', FPS, '-i', checkFile(input.image, 'IMAGE', IMAGE), ...SILENCE, '-t', String(input.seconds ?? PHOTO_SECONDS), '-vf', FIT, ...H264, '-c:a', 'aac', '-shortest', out];
  }
  if (input.video) {
    const src = checkFile(input.video, 'VIDEO', VIDEO);
    const audio = (await streamTypes(src)).includes('audio');
    return ['-i', src, ...(audio ? [] : SILENCE), '-map', '0:v:0', '-map', audio ? '0:a:0' : '1:a:0', '-vf', FIT, ...H264, '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-shortest', out];
  }
  const { first, second, first_s, second_s, cycles } = input.alternate;
  const a = checkFile(first, 'IMAGE', IMAGE);
  const b = checkFile(second, 'IMAGE', IMAGE);
  const frames = Math.round(((first_s + second_s) * 30000) / 1001);
  const graph = `[0:v]${FIT},fps=${FPS}[a];[1:v]${FIT},fps=${FPS}[b];[a][b]concat=n=2:v=1:a=0,loop=loop=${cycles - 1}:size=${frames}:start=0[v]`;
  return ['-loop', '1', '-t', String(first_s), '-i', a, '-loop', '1', '-t', String(second_s), '-i', b, ...SILENCE, '-filter_complex', graph, '-map', '[v]', '-map', '2:a:0', '-t', String((first_s + second_s) * cycles), ...H264, '-c:a', 'aac', out];
}

// Adds one model. `replace` swaps the files and entry of a model of the same name in place.
export async function addPreviewModel(spec, { ffmpeg = runFfmpeg, streamTypes = probeStreams, root = previewRoot() } = {}) {
  const { name, file_name, type = 'preview_face', replace = false } = spec;
  if (!TYPES.includes(type)) throw Error(`INVALID_TYPE: ${type}; valid: ${TYPES.join(', ')}`);
  if (!/^[a-z0-9_]+$/.test(file_name)) throw Error(`INVALID_FILE_NAME: ${file_name}; lowercase letters, digits and _ only, e.g. model_w`);
  const inputs = ['image', 'video', 'alternate'].filter((k) => spec[k] !== undefined);
  if (inputs.length !== 1) throw Error(`INVALID_ARGUMENTS: give exactly one of image, video or alternate (got ${inputs.join(', ') || 'none'})`);
  const { file: configFile, text, data } = readConfig(root);
  const list = data.defaultVideoInputModels;
  const same = list.findIndex((m) => m.name === name);
  if (same >= 0 && !replace) throw Error(`PREVIEW_MODEL_EXISTS: 「${name}」 is already listed (${list[same].resourceUrl}); pass replace=true to swap its video`);
  const rel = `./PreviewResource/video/${type}/model`;
  const dir = path.join(root, 'video', type, 'model');
  const urls = { resourceUrl: `${rel}/${file_name}.mp4`, gifUrl: `${rel}/${file_name}.gif`, iconUrl: `${rel}/${file_name}.png` };
  const taken = list.find((m, i) => i !== same && Object.values(urls).includes(m.resourceUrl));
  if (taken) throw Error(`FILE_NAME_TAKEN: ${file_name} is the video of 「${taken.name}」; pick another file_name`);
  if (same < 0 && fs.existsSync(path.join(dir, `${file_name}.mp4`))) throw Error(`FILE_NAME_TAKEN: ${path.join(dir, `${file_name}.mp4`)} exists but is not listed; pick another file_name`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-preview-model-'));
  try {
    const mp4 = path.join(work, 'v.mp4');
    const gif = path.join(work, 'v.gif');
    const png = path.join(work, 'v.png');
    await ffmpeg(await videoArgs(spec, mp4, streamTypes));
    await ffmpeg(['-t', String(GIF_SECONDS), '-i', mp4, '-vf', 'fps=10,scale=320:569:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', '-loop', '0', gif]);
    await ffmpeg(['-i', mp4, '-frames:v', '1', '-vf', 'scale=56:96', png]);
    for (const f of [mp4, gif, png]) if (!fs.existsSync(f) || fs.statSync(f).size === 0) throw Error(`PREVIEW_MODEL_ENCODE_FAILED: ffmpeg wrote no ${path.extname(f)}`);
    fs.mkdirSync(dir, { recursive: true });
    const backupFile = backup(text);
    for (const [src, ext] of [[mp4, 'mp4'], [gif, 'gif'], [png, 'png']]) fs.copyFileSync(src, path.join(dir, `${file_name}.${ext}`));
    const entry = { key: 'inputModel', name, type, ...urls };
    if (same >= 0) list[same] = entry;
    else {
      const lastOfType = list.map((m) => m.type).lastIndexOf(type);
      list.splice(lastOfType >= 0 ? lastOfType + 1 : list.length, 0, entry);
    }
    // The editor ships the list world-writable (0666); the rewrite keeps whatever mode it had.
    fs.writeFileSync(`${configFile}.tmp`, JSON.stringify(data, null, 2));
    fs.chmodSync(`${configFile}.tmp`, fs.statSync(configFile).mode & 0o777);
    fs.renameSync(`${configFile}.tmp`, configFile);
    return { name, type, replaced: same >= 0, files: Object.fromEntries(['mp4', 'gif', 'png'].map((ext) => [ext, path.join(dir, `${file_name}.${ext}`)])), config: configFile, config_backup: backupFile };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
