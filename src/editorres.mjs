// Files shipped inside 像塑.app that our own tools reuse: its ffmpeg (libx264, libmp3lame, aac, gif)
// and its built-in fonts. Nothing here needs an editor window.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const appRoot = () => process.env.XIANGSU_APP ?? '/Applications/Douyin AR.app';
const builtin = (...parts) => path.join(appRoot(), 'Contents/Resources/BuiltinResource', ...parts);

// The app ships one ffmpeg per architecture folder (arm64 on Apple silicon builds).
export function editorFfmpeg() {
  const root = builtin('ffmpeg');
  if (!fs.existsSync(root)) throw Error(`EDITOR_FFMPEG_NOT_FOUND: ${root} (像塑 not installed?)`);
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const dirs = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'ffmpeg')));
  const dir = dirs.includes(arch) ? arch : dirs.length === 1 ? dirs[0] : null;
  if (!dir) throw Error(`EDITOR_FFMPEG_NOT_FOUND: no ffmpeg for ${arch} under ${root} (found: ${dirs.join(', ') || 'none'})`);
  return path.join(root, dir, 'ffmpeg');
}

// The stream types (video / audio) of a media file, from the ffprobe next to the app's ffmpeg.
export async function streamTypes(file, { exec = run } = {}) {
  try {
    const { stdout } = await exec(path.join(path.dirname(editorFfmpeg()), 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    throw Error(`FFPROBE_FAILED: ${path.basename(file)}: ${String(e.stderr || e.message).trim().slice(0, 300)}`);
  }
}

export async function ffmpeg(args, { exec = run } = {}) {
  try {
    await exec(editorFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    throw Error(`FFMPEG_FAILED: ${String(e.stderr || e.message).trim().slice(0, 600)}`);
  }
}

// Built-in fonts by folder name (douyinti, yansongxin…); each folder holds one font file and a config.json.
export function builtinFonts() {
  const root = builtin('fonts');
  if (!fs.existsSync(root)) return {};
  const out = {};
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = fs.readdirSync(path.join(root, e.name)).find((f) => /\.(otf|ttf)$/i.test(f));
    if (file) out[e.name] = path.join(root, e.name, file);
  }
  return out;
}

export const DEFAULT_FONT = 'douyinti';

// A built-in font name or an absolute path to a .ttf / .otf.
export function fontFile(font = DEFAULT_FONT) {
  if (path.isAbsolute(font)) {
    if (!/\.(otf|ttf)$/i.test(font) || !fs.existsSync(font)) throw Error(`FONT_NOT_FOUND: ${font} (an absolute path to an existing .ttf / .otf)`);
    return font;
  }
  const fonts = builtinFonts();
  if (!fonts[font]) throw Error(`FONT_NOT_FOUND: ${font}; built-in fonts: ${Object.keys(fonts).join(', ') || '(none: 像塑 not installed?)'}, or pass an absolute .ttf / .otf path`);
  return fonts[font];
}
