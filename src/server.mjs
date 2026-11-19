#!/usr/bin/env node
// stdio MCP server: everything 像塑's official MCP offers (proxied unchanged), plus editor features the
// official server cannot reach, served by the XiangsuMcpPlus editor plugin.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import QRCode from 'qrcode';
import { PNG } from 'pngjs';
import { loadImage as loadCanvasImage } from '@napi-rs/canvas';
import { z } from 'zod';
import { callPlugin, listInstances } from './bridge.mjs';
import { OfficialMcp, OfficialUnreachable } from './official.mjs';
import { fetchImage, fetchImageBytes, readImageFile, sniffImage } from './images.mjs';
import { Projects, activateApp, frontApp, openWithApp } from './projects.mjs';
import { prepareIcon } from './icons.mjs';
import { BLEND_MODES, dropUnset, formatObjects, formatTree, pickInspect, resolveComponentRefs, resolveObject, resolveRefs, sceneObjects } from './inspect.mjs';
import { loadScene } from './scenefile.mjs';
import { makeupLayers, pixelStats } from './makeup.mjs';
import { DETAIL_SIGMA, decodePng, frameDiff, lightMetrics, lightMetricsPreview, lightPresetRegions, pixelBox, regionStats, sideBySide } from './measure.mjs';
import { FRAMES_TTL_MS, cropImage, framesDir, jpegToPng, resizeImage } from './frames.mjs';
import { DOWNLOAD_TTL_MS, Downloads, checkTarget, copyProject, editorRoot, outlineProject } from './works.mjs';
import { QrCodes } from './qrcodes.mjs';
import { CallLog } from './calllog.mjs';
import { MediaRefs, REF_PATTERN, Spill, withRefs } from './outputs.mjs';
import { ensurePlugin } from './plugininstall.mjs';
import { platformRequest } from './opsdata.mjs';
import { DEFAULT_FONT } from './editorres.mjs';
import { PRESETS as SFX_PRESETS, PITCH_RANGE, SR as SFX_RATE, synth, writeSound } from './sfx.mjs';
import { PHOTO_SECONDS, TYPES as PREVIEW_TYPES, addPreviewModel } from './previewmodels.mjs';
import { setSceneLayers } from './scenelayers.mjs';
import { DIRECT_TOOLS, isNativeDeferredClient, searchTools, withHiddenToolHints } from './tool-catalog.mjs';
import { CAPABILITIES_RESOURCE_URI, CAPABILITY_INSTRUCTIONS, COMPACT_MODE_NOTE, CapabilityAtlas } from './capabilities.mjs';
import { compactEditByDslResult, normalizeIntention, normalizeOfficialArgs, precheckEditByDsl } from './contract-adapter.mjs';
import { buildImageSheet } from './imagesheet.mjs';
import { cropBuffer, exportAudio, imageMetaFromPng, isVideoPath, probeAudio, videoContactSheet } from './mediainfo.mjs';
import { buildH5Bundle, subsetH5Font } from './h5.mjs';

const { INNOVATION_KINDS, MAX_MENU_PREVIEW, RANK_TYPES, RANK_FILTERS, EFFECT_SEARCH_KINDS, SEARCH_MAX, SCRIPT_TAGS, SCRIPT_MAX, AI3D_FACE_NUM, AI3D_IMAGE_LIMIT, AI3D_VIDEO_LIMIT, AI3D_MAX_RUNNING, AI3D_PRESET_MODELS, AI3D_HISTORY_PAGE, AR_VIDEO_MODES, AR_VIDEO_HISTORY_PAGE, AI_MAKEUP_IMAGE_LIMIT, AI_MAKEUP_HISTORY_PAGE, CUSTOM_GAN_SELECT_COUNT, IMAGE_MATTING_PARTS } = createRequire(
  import.meta.url,
)('../editor-plugin/library.cjs');
const rankFilter = (key) => z.array(z.enum(Object.keys(RANK_FILTERS[key].options))).optional();
const LIBRARY_PANELS_TEXT =
  'general: regular panels (3d_distortion=脸部变形, distortion=美型, gaoguai_gan/makeup_gan=AI 实时变脸, 3d_makeup=美妆, 3d_filter=滤镜, sticker=跟脸贴纸); square: aigc_material=素材广场 (ready-made creator shares, no quota); collection: collection=收藏. Cloud AI generation panels use ai_makeup, ai3d, ar_video, ai_vfx, custom_gan.';
const RANK_TYPE_TEXT = Object.entries(RANK_TYPES).map(([k, name]) => `${k} ${name}`).join('、');
const SCRIPT_TAG_TEXT = Object.entries(SCRIPT_TAGS).map(([k, name]) => `${k} ${name}`).join('、');

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const target = {
  project_path: z.string().optional().describe('Target project path (omit when only one window is open).'),
  instance_id: z.string().optional().describe('Official instance_id (alternative to project_path).'),
};

const saveTo = z.string().min(1).optional().describe('Directory (absolute path, created if missing) to save the output into for long-term keeping.');
const refBox = z
  .strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().gt(0).max(1), height: z.number().gt(0).max(1) })
  .optional()
  .describe('Box of the same region on the reference image, as fractions of its width/height; use together with reference.');

// Skia (@napi-rs/canvas) takes seconds to load cold, so the drawing tools load it on first use.
const graphics = () => import('./graphics.mjs');
const absPath = (what) => z.string().min(1).refine((p) => path.isAbsolute(p), `${what}须是绝对路径`);
const outDir = absPath('目录').describe('Output directory, absolute path (created if missing); PNGs under a project Assets/ folder are imported by the editor automatically.');
const hexColor = z.string().regex(/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, '颜色写 #rgb、#rgba、#rrggbb 或 #rrggbbaa');
const fontArg = z
  .string()
  .min(1)
  .optional()
  .describe(`Font: folder name of a bundled Xiangsu font (douyinti 抖音体, yansongxin, xinqingnianti, wenyuehouxiandaiti, nihongxin, gangfengfanti, fenglingyouyou, DouyinNumberABC-ExtraBold — whichever is installed locally), or an absolute path to a .ttf / .otf; default ${DEFAULT_FONT}.`);
const strokeArg = z.strictObject({ color: hexColor, width: z.number().min(0.5).max(60).describe('Stroke width (pixels)') }).optional().describe('Stroke outline.');
const shadowArg = z
  .strictObject({
    color: hexColor.optional(),
    blur: z.number().min(0).max(60).optional(),
    offset_y: z.number().min(-60).max(60).optional(),
    opacity: z.number().min(0).max(1).optional(),
  })
  .optional()
  .describe('Drop shadow; pass {} for the default soft black shadow (blur 6, shifted 4 down, opacity 0.45).');
const textStyle = {
  text: z.string().min(1).describe('Text; \\n starts a new line, lines are centered.'),
  font: fontArg,
  size: z.number().min(6).max(400).describe('Font size (pixels).'),
  fill: hexColor.optional().describe('Fill color, default #ffffff.'),
  gradient: z.array(hexColor).min(2).max(6).optional().describe('Vertical top-to-bottom gradient colors; replaces fill.'),
  stroke: strokeArg,
  shadow: shadowArg,
  line_height: z.number().min(0.8).max(3).optional().describe('Line height as a multiple of font size; default 1.25.'),
};
const pngFile = z.string().regex(/^[^/\\:*?"<>|]+\.png$/, '文件名（不含目录）以 .png 结尾');
const fileStem = z.string().regex(/^[^/\\:*?"<>|.][^/\\:*?"<>|]*$/, '文件名（不含目录和扩展名）');

// Picked, not measured: four videos covers 正脸、摇头、点头、双人; 24 full-size frames (about 75 KB
// each, measured) keep one answer at about 1.8 MB of images.
const MAX_FRAME_VIDEOS = 4;
const MAX_FRAMES = 24;
// Derived: the plugin's preview_reset gives up after 15 s for the reload plus 5 s for fresh frames.
const RESET_TIMEOUT_MS = 20000;
// Picked, not measured: on top of the reset and the frame intervals, room for the frame calls
// (about 0.2 s each, measured) and the next video switch before the hold is renewed.
const HOLD_SLACK_MS = 30000;
// Derived from practice (project notes): AI face effects show fully in the second frame taken 3 s apart
// after a reset, so a held frame is taken this long after the reset by default.
const HOLD_AT_MS = 3000;
// Picked: after switching back, the editor wrote the last video back into the project info within 3 s
// (measured 2026-11-09), which is when the project shows as unchanged again.
const PREVIEW_INFO_SETTLE_MS = 5000;
// Picked, not measured: as many states and regions as fit a readable answer.
const MAX_COMPARE_VARIANTS = 6;
const MAX_COMPARE_REGIONS = 6;
// Derived: two frames of the same still photo differ by 0.5–0.8 mean luma around the eyes (13–18 at
// the single worst pixel, so the max says nothing; measured); a region whose first and last baseline
// differ by more than 2.5 times that was not held still (a moving video, an effect that animates by itself).
const DRIFT_MEAN = 2;
// The official screenshot's size: it scales the preview down to 320×569.
const OFFICIAL_SHOT_SIDE = 569;
// Measured: the preview service answers ttl 604800 (a week); used when an answer carries no ttl.
const QR_TTL_SEC = 604800;
// Picked: the expiry timer fires this long after the code expires, so the clock has surely passed it.
const QR_PRUNE_SLACK_MS = 1000;
// Picked, not measured: the subject step usually takes about 20 s (the editor's own estimate); six times that.
const AI3D_SEGMENT_WAIT_S = 120;
// Picked, not measured: long enough for one wait to cover a typical generation, short of the client's patience.
const AI3D_MAX_WAIT_S = 600;
// Derived: uploads (60 s each in the editor's upload API) plus the submit call, with room to spare.
const AI3D_SUBMIT_TIMEOUT_MS = 300000;
// Picked, not measured: the result download (30 s in the editor) plus the import.
const AI3D_IMPORT_TIMEOUT_MS = 180000;
// Derived: the editor's video audit (900 s at most) plus the plugin's 240 s wait for the cloud to accept
// the task, with a minute to spare.
const AR_VIDEO_SUBMIT_TIMEOUT_MS = 1200000;
// Picked: covers the one 10 s generation measured (6 min from submit to the composed result, 2026-11-08).
const AR_VIDEO_MAX_WAIT_S = 600;
// Picked, not measured: importing the video and audio resources and building the AR plane.
const AR_VIDEO_IMPORT_TIMEOUT_MS = 180000;
// Picked: the account's six extractions took 5–8 s each (2026-11-11); ten times the slowest.
const AI_MAKEUP_WAIT_S = 60;
const AI_MAKEUP_MAX_WAIT_S = 300;
// Derived: the upload and the submit call (60 s each in the editor's APIs) plus the preview's five
// texture downloads (30 s each in the editor), on top of wait_s.
const AI_MAKEUP_SLACK_MS = 270000;
// Derived: five texture downloads (30 s each in the editor) and five loads (30 s each in the plugin).
const AI_MAKEUP_IMPORT_TIMEOUT_MS = 300000;
// Fields of the ai_makeup_* answers that hold a blend mode number; its name goes next to it.
const AI_MAKEUP_BLEND_KEYS = ['blend_mode', 'reflect_blend_mode', 'blend'];
// Derived: the image editor's requests wait up to 60 s for the cloud result, on top of the upload and download.
const IMAGE_AI_TIMEOUT_MS = 180000;
// Derived: the editor's audit of a reference video gives up within 15 min, plus the upload and the create call.
const AI_VFX_SUBMIT_TIMEOUT_MS = 1100000;
// Picked: long enough for one wait to cover a typical generation, short of the client's patience.
const AI_VFX_MAX_WAIT_S = 900;
const CUSTOM_GAN_MAX_WAIT_S = 900;
// Derived: the model and preview downloads (120 s each in the editor) and the import.
const CUSTOM_GAN_IMPORT_TIMEOUT_MS = 600000;
// Derived: the preview reload behind starting or stopping the audio session (measured 0.5–0.9 s; the editor gives up after 10 s).
const AUDIO_SESSION_TIMEOUT_MS = 30000;
// Picked: generated images shown inline in one answer (the rest are only listed as files).
const INLINE_IMAGES = 8;
// Picked, not measured: as many images per image_view call as the old preview tools showed.
const IMAGE_VIEW_MAX = 8;
// Derived: the SDK's stdio transport drops a message over 10 MiB and with it the connection, and six
// animated GIFs from one task's content reached 16 MB of base64 (measured); this leaves room for the text.
const IMAGE_VIEW_BYTES = 8 * 1024 * 1024;
// Derived: the plugin's wait for the page's checks (180 s) and for the submission's result (300 s), plus a minute.
const SUBMIT_CONFIRM_TIMEOUT_MS = 540000;
// Picked: the submitted effect is the newest; a page this long also covers a few submitted meanwhile.
const SUBMITTED_LOOKUP = 10;
// Cursor ends a tool call that sends nothing for a while ("MCP tool call timed out (idle)", seen on a
// submit_prepare that waited for the page's checks). Picked: well inside the 25 s calls that went through.
const PROGRESS_MS = 5000;
// Appended to official tools whose work overlaps ours, saying which one to reach for.
// What every tool that opens a project window says about it.
const QUIET_TEXT =
  'The window opens minimized in the Dock — no loading window, no focus (background.focus_kept_on names the app that kept focus while it opened); clicked in the Dock, it becomes a normal window. While minimized: capture_preview / preview_frames shoot the render output, get_scene_view refuses with an explanation, interact_by_dsl screenshots come back black.';
const SCENE_VIEW_REFUSED =
  'SCENE_VIEW_NOT_DRAWN: 这个工程窗口最小化在程序坞里（MCP 打开的窗口都不上屏），最小化的窗口不绘制场景视图，get_scene_view 只能拍到一片纯色，所以没有调用。看效果用 capture_preview / preview_frames，看结构和对象用 scene_tree / get_scene / inspect_many；确实要场景视图截图，请用户从程序坞点开这个窗口后再调用。';

const OFFICIAL_NOTES = {
  capture_preview:
    'When the window is visible this is the official screenshot — right after a scene edit or preview-video switch it may still show the previous frame; confirm the new frame with preview_frames (it resets the preview and waits for the reloaded frame first). While minimized or hidden, this instead resets the preview and shoots the render output.',
  get_scene_view: 'Refused while the project window is minimized (windows opened by this server are always minimized to the Dock): a minimized window does not draw its scene view — the shot would be one flat colour.',
  get_scene: 'First look at structure: scene_tree (compact indented text; also reads a downloaded project directory without a window). Parameters of several objects: inspect_many.',
  inspect: 'Several objects at once, filtering by component type / property name, or key parameters only: inspect_many (calls this tool per object and organizes the results).',
  edit_by_dsl:
    'Delete an object together with the resources and package folders only it used: object_remove (undoable; resources reported by default, not deleted).\n' +
    'In {"$ref": X, "component_type": T}: when X is not an alias from an earlier command of this batch it may be an existing object guid (sNN), name or path (resolved like inspect_many) — swapped for that object T component guid before forwarding. The official server only accepts batch aliases: an existing object sNN with component_type fails "has no component". T is a component type from inspect (FaceMask, EyeColorV2, GanComponent, PostProcess, ...).\n' +
    'set_component properties must be an object ({"属性名": value}); an array is rejected before forwarding. One command status=success does not prove the property landed — check result.changes (seen 2026-11-09: single command success, property missing, only the batch as a whole reported error).',
  interact_by_dsl: 'While the window is minimized or hidden the screenshot action returns black; see the frame via preview_frames (render output, works in the background).',
  list_preview_videos: 'About 70 KB per call; to just pick video names (the videos of preview_frames / makeup_compare) use preview_videos — names per tracking type plus the current video only.',
  upload_workflow_image: 'The image must be an object {"kind": "local_path", "file_path": "<absolute path>"}; a bare path string is rejected (measured 2026-11-09).',
  generate_assets_batch: 'The type field of each assets entry is kind; writing type is rejected (measured 2026-11-09).',
  get_workflow_capabilities: 'algorithm_list returns baseModelId, algorithm_detail wants algorithm_id — not the same value. This blocked adding an image-generation node on 2026-11-09; no workaround found.',
  apply_workflow_patch: 'On validation failure the official error is the whole union-validator dump (tens of KB); the useful part is usually the source / target line. Errors over 4000 chars are truncated, full text saved to a file named in the reply.',
};
// Picked: an official error this long is a validator dump (apply_workflow_patch answered tens of KB);
// the head says what went wrong, the rest goes to a file.
const OFFICIAL_ERROR_CHARS = 4000;
// Picked: 16 inspirations' details and images fetched all at once took 18 s (2026-11-10); six at a time
// keeps a hotspot (66–70 inspirations) around a minute without opening dozens of connections.
const INSPIRATION_IMAGE_CONCURRENCY = 6;
// Derived: single inspiration images took up to 17.7 s from the CDN (2026-11-10), past fetchImage's 15 s.
const INSPIRATION_IMAGE_TIMEOUT_MS = 30000;
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
// Picked: long enough for a title (they run to about 15 characters) and short of path limits.
const FILE_TITLE_CHARS = 60;

// Characters file systems refuse in a name, and control characters.
const fileSafe = (s) => String(s ?? '').replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, FILE_TITLE_CHARS) || 'untitled';

// Runs fn over items, at most `limit` at a time, keeping their order; fn must not throw.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Writes each blend mode's name next to its number, as inspect_many does.
function nameBlends(value) {
  if (Array.isArray(value)) return value.map(nameBlends);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = nameBlends(v);
    if (AI_MAKEUP_BLEND_KEYS.includes(k) && Number.isInteger(v)) out[`${k}_name`] = BLEND_MODES[v] ?? `未知（${v}）`;
  }
  return out;
}

function saveDir(dir) {
  if (!path.isAbsolute(dir)) throw Error(`SAVE_TO_NOT_ABSOLUTE: ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const unreadableNote = (scene) =>
  scene.unreadable.length ? `注意：${scene.unreadable.length} 个资源描述文件（.extra）读不了，其中的资源只给原始路径：\n${scene.unreadable.join('\n')}` : null;

function saveFile(dir, name, body) {
  const file = path.join(saveDir(dir), name);
  fs.writeFileSync(file, body);
  return file;
}

class Seen {
  constructor(code, source, key = 'template_id') {
    this.code = code;
    this.source = source;
    this.key = key;
    this.map = new Map();
  }

  keep({ raw = [], ...page }, extra = {}) {
    page.items.forEach((slim, i) => this.map.set(String(slim[this.key]), { slim, raw: raw[i] ?? null, ...extra }));
    return page;
  }

  get(id) {
    const hit = this.map.get(String(id));
    if (!hit) throw Error(`${this.code}: ${id}; call ${this.source} first`);
    return hit;
  }
}

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const REF_NOTE = ' Media fields (*_ref/*_refs) are viewed via image_view(images=["img:N","video:N"]); audio via audio_probe.';
const KIND_TEXT = { video: '视频', audio: '音频' };
const cropBox = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
});
const failure = (error) => ({ content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true });
const invalidArguments = (name, error) => failure(`INVALID_ARGUMENTS(${name}): ${error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);

async function imageContent(d, { url, file }) {
  try {
    return { type: 'image', ...(url ? await d.fetchImage(url) : await d.readImageFile(file)) };
  } catch (e) {
    return { type: 'text', text: `图片读取失败：${e.message}` };
  }
}

// topic_crowd 交给平台后等它搜完：拍的，平台采集进程 15 秒内开始，特效和模板各两页十来秒。
const TOPIC_POLL_MS = 3000;
const TOPIC_WAIT_MS = 60000;

export function createServer(deps = {}) {
  // Exposure mode negotiation across multiple MCP clients (Claude Code, Codex, Cursor, Grok, ZCode, Antigravity):
  // - Explicit override via deps.flatTools or XIANGSU_MCP_FLAT_TOOLS=1|0 / XIANGSU_MCP_COMPACT_TOOLS=1 always wins.
  // - Otherwise auto-detects after MCP initialize using clientInfo.name: clients with verified native
  //   deferred tool loading (Claude Code) get flat typed tools; all other clients get compact mode
  //   (29 high-frequency direct tools + tool_search/tool_describe/tool_call) to stay within tool/context budgets.
  const explicitFlat =
    deps.flatTools !== undefined
      ? Boolean(deps.flatTools)
      : process.env.XIANGSU_MCP_COMPACT_TOOLS === '1' || process.env.XIANGSU_MCP_FLAT_TOOLS === '0'
        ? false
        : process.env.XIANGSU_MCP_FLAT_TOOLS === '1'
          ? true
          : null;
  const d = {
    callPlugin,
    listInstances,
    fetchImage,
    fetchImageBytes,
    readImageFile,
    platformRequest: (pathname, method = 'GET', body) => platformRequest(pathname, { method, body }),
    openWithApp,
    frontApp,
    activateApp,
    prepareIcon,
    cropImage,
    resizeImage,
    jpegToPng,
    framesDir,
    inspirationImagesDir: () => framesDir({ root: path.join(os.tmpdir(), 'xs-inspiration-images') }),
    qrPng: (text) => QRCode.toBuffer(text, { width: 360, margin: 2 }),
    writeSound,
    addPreviewModel,
    // Expiry timers must not keep the process alive after the client goes away.
    schedule: (fn, ms) => setTimeout(fn, ms).unref(),
    sleep,
    openTimeoutMs: 90000,
    closeTimeoutMs: 30000,
    // Picked: the trial saw the slot freed a few seconds after project_close returned.
    launchRetryMs: 8000,
    instanceTimeoutMs: 30000,
    // Picked: the idle window process started after a close had its plugin up 6 s after it (9.8.3).
    idleSpawnMs: 15000,
    saveTimeoutMs: 15000,
    progressMs: PROGRESS_MS,
    ...deps,
  };
  const server = new Server(
    { name: 'xiangsu-mcp-plus', version: VERSION },
    {
      capabilities: { tools: { listChanged: true }, resources: {} },
      instructions: CAPABILITY_INSTRUCTIONS,
    },
  );
  const isFlat = () => (explicitFlat !== null ? explicitFlat : isNativeDeferredClient(server.getClientVersion()));
  d.official = d.official ?? new OfficialMcp();
  d.official.onToolsChanged = () => server.sendToolListChanged().catch(() => {});
  const projects = new Projects(d);
  // The window an official call goes to: by instance_id, or the only window with a project.
  const officialTarget = async (instance_id) => {
    if (instance_id !== undefined) return projects.resolveProjectPath({ instance_id });
    const open = (await projects.officialInstances()).filter((i) => i.project_path);
    return open.length === 1 ? open[0].project_path : null;
  };
  d.downloads = d.downloads ?? new Downloads();
  d.qrCodes = d.qrCodes ?? new QrCodes();
  d.callLog = d.callLog ?? new CallLog();
  server.oninitialized = () => {
    d.callLog.write({ event: 'client_initialized', client: server.getClientVersion() ?? null, mode: isFlat() ? 'flat' : 'compact' });
  };
  d.refs = d.refs ?? new MediaRefs();
  d.spill = d.spill ?? new Spill();
  d.atlas = d.atlas ?? new CapabilityAtlas();
  d.qrCodes.prune();
  // Library assets and homepage works seen in this session, kept here rather than in a window:
  // windows open and close while an agent works, and a later apply or download may be served by a
  // different one. The plugin returns raw records next to the slim items; clients only see the slim ones.
  const seenLib = new Seen('UNKNOWN_TEMPLATE', 'library_list or library_search');
  const seenWorks = new Seen('UNKNOWN_WORK', 'works_list, works_search or works_by_effect');
  const seenTasks = new Seen('UNKNOWN_TASK', 'tasks_list', 'task_id');
  const seenGrowth = new Seen('UNKNOWN_GROWTH_TASK', 'growth_tasks_list', 'task_id');
  const seenMusic = new Seen('UNKNOWN_MUSIC', 'music_list or music_search', 'music_id');
  // 实时热点 entries carry t and v that their detail and video requests must send back.
  // Subjects found by ai3d_gs_segment, kept here so ai3d_gs_submit only needs the segment task id.
  const segments = new Map();

  // Background windows draw at 6 fps; the plugin holds full rate until released, or by itself until
  // hold_ms runs out if the release never arrives.
  const holdFullRate = (projectPath, hold_ms) => d.callPlugin('preview_full_rate', { hold_ms }, { projectPath, timeoutMs: 15000 });
  const releaseFullRate = (projectPath) => holdFullRate(projectPath, 0).catch(() => {});
  const resetPreview = (projectPath) => d.callPlugin('preview_reset', {}, { projectPath, timeoutMs: RESET_TIMEOUT_MS + 5000 });
  // A preview frame as RGBA pixels (the editor's JPEG; measured against lossless PNG on the same frame:
  // 2.4/255 mean, 12 at most around the eyes).
  const pngFrame = async (projectPath) => {
    await holdFullRate(projectPath, HOLD_SLACK_MS);
    const img = await d.callPlugin('preview_frame', {}, { projectPath, timeoutMs: 15000 });
    const buf = Buffer.from(img.data, 'base64');
    return decodePng(img.mimeType === 'image/png' ? buf : await d.jpegToPng(buf));
  };
  const makeupSet = (projectPath, changes, label) => d.callPlugin('makeup_set', { changes, label }, { projectPath, timeoutMs: 60000 });
  const restoreOf = ({ object_path, kind, female, male, intensity }) => (kind === 'face_mask' ? { object_path, female, male, intensity } : { object_path, intensity });
  // Sets [{ guid, property, value }] with the official set_component and returns what puts them back.
  // A batch stops at its first failing command; the ones before it are put back before the error.
  const setComponents = async (instance_id, list, label) => {
    if (!list.length) return [];
    const commands = list.map(({ guid, property, value }) => ({ command_type: 'set_component', params: { guid, properties: { [property]: value } } }));
    const res = await d.official.callTool('edit_by_dsl', { instance_id, commands, intention: label });
    const body = (res.content || []).find((c) => c.type === 'text')?.text;
    let out;
    try {
      out = JSON.parse(body);
    } catch (_) {
      throw Error(`COMPONENT_SET_FAILED: ${String(body).slice(0, 300)}`);
    }
    const undo = [];
    for (const [i, c] of list.entries()) {
      const r = out.results?.[i];
      const was = r?.status === 'success' ? r.result?.changes?.find((x) => x.property === c.property) : null;
      if (was) undo.push({ ...c, value: was.oldValue });
    }
    if (undo.length < list.length) {
      if (undo.length) await setComponents(instance_id, undo, `${label}: put back`);
      throw Error(`COMPONENT_SET_FAILED: ${JSON.stringify((out.results || []).filter((r) => r.status !== 'success'))}`);
    }
    return undo;
  };
  const loadImage = async (file) => {
    const buf = fs.readFileSync(file);
    const type = sniffImage(buf);
    if (type === 'image/png') return decodePng(buf);
    if (type === 'image/jpeg') return decodePng(await d.jpegToPng(buf));
    throw Error(`NOT_PNG_OR_JPEG: ${file}`);
  };
  const freshFrames = (projectPath) => d.callPlugin('preview_fresh', {}, { projectPath, timeoutMs: 15000 });
  // Runs fn(video) once per preview video (or once on the current one), switching back afterwards.
  const eachVideo = async (instance_id, videos, tracking_type, fn) => {
    if (!videos) return [await fn(null)];
    const original = await d.official.callJson('get_current_preview_video', { instance_id, intention: '记下当前预览视频，用完切回' });
    const out = [];
    try {
      for (const video_name of videos) {
        await d.official.callJson('set_preview_video', { instance_id, tracking_type, video_name, intention: '临时切换预览视频' });
        out.push(await fn(video_name));
      }
    } finally {
      const back = original.video_name ? { video_name: original.video_name } : { resource_url: original.resource_url };
      await d.official.callJson('set_preview_video', { instance_id, tracking_type: original.tracking_type, ...back, intention: '切回原预览视频' });
    }
    return out;
  };
  // Resets the preview and lets it play for at_ms, then runs fn while it keeps playing. Changes to
  // strengths show live (no reload), so on a still-photo preview video every capture fn takes is the
  // same face. Pausing cannot stand in for that: a paused preview stops drawing and ignores changes,
  // and seekToTime or forceUpdateInputFrame do not make it draw again.
  const onPlayingPreview = async (projectPath, at_ms, fn) => {
    await holdFullRate(projectPath, RESET_TIMEOUT_MS + at_ms + HOLD_SLACK_MS);
    try {
      await resetPreview(projectPath);
      await d.sleep(at_ms);
      return await fn();
    } finally {
      await releaseFullRate(projectPath);
    }
  };
  // Forwards to the plugin window showing the target project.
  // Tools that open windows keep the focus off 像塑 while they run (see Projects.keepingFocus).
  const keepingFocus = async (fn) => {
    const got = await projects.keepingFocus(fn);
    return got.error ? { ...got.value, focus_error: got.error } : got.value;
  };
  const plugin = (method, timeoutMs) => async (args) => {
    const { project_path, instance_id, ...params } = args;
    const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
    return text(await d.callPlugin(method, params, { projectPath, timeoutMs }));
  };

  // Official tools take the official instance_id; ours also accept the project path, and either can be
  // left out while only one editor window is open.
  const officialInstance = async ({ project_path, instance_id }) => {
    if (instance_id !== undefined) return String(instance_id);
    const list = await projects.officialInstances();
    const real = (p) => {
      try {
        return fs.realpathSync(p);
      } catch (_) {
        return path.resolve(p);
      }
    };
    const hits = project_path ? list.filter((i) => i.project_path && real(i.project_path) === real(project_path)) : list;
    if (hits.length === 1) return String(hits[0].instance_id);
    throw Error(project_path ? `NO_UNIQUE_INSTANCE for ${project_path}: ${hits.length} matches` : `AMBIGUOUS_INSTANCE: ${list.length} editor windows; pass project_path or instance_id`);
  };
  // The official tools take objects by guid only; this is the scene's guids and names to find them by.
  const namesTree = (instance_id) => d.official.callJson('get_scene', { instance_id, names_only: true, intention: '按名称或路径找对象' });
  // Homepage works, the asset library and the add-object menu do not depend on the project, so any
  // window serves them (the lowest pid when no target is given).
  const homeWindow = async ({ project_path, instance_id }) => {
    if (project_path !== undefined || instance_id !== undefined) return { projectPath: await projects.resolveProjectPath({ project_path, instance_id }) };
    const pids = d.listInstances().map((s) => s.pid).sort((a, b) => a - b);
    if (!pids.length) throw Error('NO_EDITOR_WINDOW: open any project window first (works are served by the XiangsuMcpPlus plugin inside it)');
    return { pid: pids[0] };
  };
  // Received state and bindings change outside tasks_list (task_receive, the app), so a miss or a
  // stale entry is re-read once before it is reported.
  const refreshTasks = async (win) => seenTasks.keep(await d.callPlugin('tasks_list', {}, win));
  const library = (method) => async (args) => {
    const { project_path, instance_id, ...params } = args;
    return text(seenLib.keep(await d.callPlugin(method, params, await homeWindow({ project_path, instance_id }))));
  };
  const works = (method) => async (args) => {
    const { project_path, instance_id, ...params } = args;
    return text(seenWorks.keep(await d.callPlugin(method, params, await homeWindow({ project_path, instance_id }))));
  };
  const openPaths = async () => (await projects.windows()).map((w) => w.project_path).filter(Boolean);
  // Every works download first sweeps out earlier ones past their lifetime.
  const pruneDownloads = async () => d.downloads.cleanup({ olderThanMs: DOWNLOAD_TTL_MS, openPaths: await openPaths() });
  const downloadWork = async (args) => {
    const { project_path, instance_id, template_id } = args;
    const { raw } = seenWorks.get(template_id);
    await pruneDownloads();
    const got = await d.callPlugin('works_download', { item: raw }, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: 600000 });
    const root = editorRoot(got.project_path);
    d.downloads.record({ path: root, template_id: got.template_id, title: got.title });
    return { ...got, root };
  };
  const expiresAt = () => new Date(Date.now() + DOWNLOAD_TTL_MS).toISOString();
  // The submitted effect in my_effects, the account's own record of it: by effect_id, or by name when the
  // page showed 提交成功 without reporting the id.
  const listedEffect = async (projectPath, { effect_id, name }) => {
    try {
      const { items } = await d.callPlugin('my_effects', { count: SUBMITTED_LOOKUP }, { projectPath });
      const hit = effect_id ? items.find((e) => e.effect_id === effect_id) : items.find((e) => e.name === name);
      if (hit) return { listed: hit };
      return { listed: null, listed_note: `not among the newest ${SUBMITTED_LOOKUP} effects of my_effects ${effect_id ? `by effect_id ${effect_id}` : `by name 「${name}」`}; call pipeline_refresh, then look at pipeline_works in a minute` };
    } catch (e) {
      return { listed: null, listed_error: e.message };
    }
  };
  const setIcon = async (projectPath, image_path, type = 'both') => {
    const { png, dir } = await d.prepareIcon(image_path);
    try {
      return await d.callPlugin('icon_set', { png_path: png, types: type === 'both' ? ['female', 'male'] : [type] }, { projectPath });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  // An image editor AI request, served by any window; the result is copied out of the editor's cache.
  const imageAi = async (a, method, params, suffix, { dir, stem, ...info } = {}) => {
    const { previewJpeg } = await graphics();
    const { project_path, instance_id, image_path, out_dir } = a;
    const got = await d.callPlugin(method, { image_path, ...params }, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: IMAGE_AI_TIMEOUT_MS });
    const where = dir ?? (out_dir ? saveDir(out_dir) : d.framesDir());
    const file = path.join(where, `${stem ?? path.basename(image_path, path.extname(image_path))}_${suffix}.png`);
    fs.copyFileSync(got.output, file);
    const summary = { file, ...(got.mode ? { mode: got.mode } : {}), ...info, ...(out_dir ? {} : { note_files: '临时文件，24 小时后删除；要留存请传 out_dir' }) };
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }, { type: 'image', mimeType: 'image/jpeg', data: (await previewJpeg(file)).toString('base64') }] };
  };
  // Inspirations, tasks and rank boards belong to the account rather than a project, so any window
  // serves them.
  const community = (method) => async (args) => {
    const { project_path, instance_id, ...params } = args;
    return text(await d.callPlugin(method, params, await homeWindow({ project_path, instance_id })));
  };
  // Lists read whole from the plugin and paged here.
  const pageOf = ({ items, ...rest }, offset, count) => {
    const next = offset + count;
    return { ...rest, total: items.length, items: items.slice(offset, next), next_offset: next, has_more: next < items.length };
  };
  const musicCursor = z.union([z.number(), z.string()]).optional().describe('Next page: the previous page next_cursor; omit for the first page.');
  const pageShape = {
    offset: z.number().int().min(0).optional().describe('Paging start; take the previous page next_offset. Default 0.'),
    count: z.number().int().min(1).max(100).optional().describe('Items per page, default 20.'),
  };
  const subjectKind = z.enum(['effect', 'template']).optional().describe('effect for effect subject boards (default), template for template subject boards.');
  const workSort = z.enum(['suggest', 'latest', 'effect_usage', 'project_usage']).optional().describe('Sort: suggest (recommended, default), latest, effect_usage, or project_usage.');
  const workPage = {
    category_id: z.string().optional().describe('A category ID from works_list categories; omitted means the first category (recommended).'),
    cursor: z.string().min(1).optional().describe('Page cursor; take next_cursor from the previous page verbatim. The last page next_cursor is null.'),
    count: z.number().int().min(1).max(100).optional().describe('Items per page, default 20.'),
    sort: workSort,
  };

  const tools = [
    {
      name: 'ext_status',
      keywords: '状态 排查 插件 窗口 self status plugin',
      description:
        "Status of this server: official MCP connectivity, the editor plugin install result at startup, and every project window with the XiangsuMcpPlus plugin loaded.\n\n" +
        'Returns: official (connectivity); plugin_install with action installed (freshly installed) / kept (equal-or-newer plugin already present, untouched) / failed (with error); windows with pid, project path, matching official instance_id, unsaved_changes (null when unreadable), and an editor interface self-check.\n\n' +
        'Call it first when a tool cannot find a window, reports INCOMPATIBLE_EDITOR, or official tools are unreachable. The plugin only takes effect in windows opened after it was installed.',
      shape: {},
      run: async () => {
        const official = await d.official.listTools().then(() => d.official.status());
        const ids = new Map((await projects.officialInstances().catch(() => [])).map((i) => [i.pid, i.instance_id]));
        const windows = [];
        for (const w of await projects.windows()) {
          const self_check = await d
            .callPlugin('self_check', {}, { pid: w.pid, timeoutMs: 5000 })
            .catch((e) => ({ ok: false, error: `${e.message}（该窗口里的插件是旧版本，保存后重开工程窗口即可）` }));
          const state = await d.callPlugin('project_state', {}, { pid: w.pid, timeoutMs: 5000 }).catch(() => null);
          windows.push({ ...w, instance_id: ids.get(w.pid) ?? null, unsaved_changes: state ? state.changed : null, self_check });
        }
        return text({ official, plugin_install: d.pluginInstall ?? null, windows });
      },
    },
    {
      name: 'project_open',
      keywords: '打开 工程 窗口 open',
      description:
        'Open an existing Xiangsu project in a new window. Returns the window pid and official instance_id; already open, it returns as-is without changing that window. ' +
        QUIET_TEXT +
        ' Older projects may pop an upgrade dialog needing a click in the editor.',
      shape: { path: z.string().min(1).describe('Absolute path of the project folder (contains effect.dyehpj).') },
      run: async (a) => text(await projects.open(a)),
    },
    {
      name: 'project_new',
      keywords: '新建 工程 空白 new create',
      description: 'Create a blank Xiangsu project, saved to path on first save (the directory must not exist or must be empty). Needs any project window already open. Returns the new window pid and official instance_id. ' + QUIET_TEXT,
      shape: { path: z.string().min(1).describe('Absolute path of the folder to save the new project into.') },
      run: async (a) => text(await projects.create(a)),
    },
    {
      name: 'project_close',
      keywords: '关闭 工程 窗口 close',
      description: 'Close a project window — the toolbar 「回到首页」 without bringing the home window up. Refuses with unsaved changes (save_project first); discard_changes=true throws them away.',
      shape: { ...target, discard_changes: z.boolean().optional().describe('Discard unsaved changes and close anyway.') },
      run: async (a) => text(await projects.close(a)),
    },
    {
      name: 'image_view',
      keywords: '看图 预览 图片 视频 画面 image view',
      description: `View images or video frames inline. images takes list-tool references (*_ref / *_refs, e.g. img:12, video:3), detail-tool addresses, or local absolute paths.\n\n` +
        '- images render with width×height (PNGs add the non-transparent bounding box alpha_bbox)\n' +
        "- videos (video references / URLs / local .mp4|.mov|.webm) get media info via Xiangsu's bundled ffprobe+ffmpeg plus an evenly sampled 3×2 frame-grid preview (timestamps as labels)\n" +
        '- audio references belong to audio_probe\n\n' +
        `Optional crop trims the returned visuals. ≤${IMAGE_VIEW_MAX} items per call; a failed item notes its own reason; anything skipped for size lands in not_returned.`,
      shape: {
        images: z.array(z.string().min(1)).min(1).max(IMAGE_VIEW_MAX).describe('img:/video: references, http(s) URLs, or local absolute paths of images/videos.'),
        crop: cropBox.optional().describe('Crop each returned visual by frame fractions (0–1); video grids are cropped too.'),
      },
      run: async ({ images, crop }) => {
        const content = [];
        let bytes = 0;
        let shown = 0;
        const cleanups = [];
        const materialize = async (where, hintExt) => {
          if (/^https?:\/\//.test(where)) {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-iv-'));
            const ext = hintExt || path.extname(new URL(where).pathname) || '.bin';
            const file = path.join(dir, `m${ext}`);
            const res = await fetch(where, { signal: AbortSignal.timeout(30000) });
            if (!res.ok) throw Error(`HTTP ${res.status}`);
            fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
            cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
            return file;
          }
          if (path.isAbsolute(where)) return where;
          throw Error('不是引用、http(s) 地址或绝对路径');
        };
        try {
          for (const src of images) {
            const hit = REF_PATTERN.test(src) ? d.refs.get(src) : null;
            if (REF_PATTERN.test(src) && !hit) {
              content.push({ type: 'text', text: `第 ${shown + 1} 张：${src}` }, { type: 'text', text: `图片读取失败：引用 ${src} 已失效（MCP 服务重启过，或是很久以前的列表），重新调用返回它的工具` });
              shown++;
              continue;
            }
            if (hit?.kind === 'audio') {
              content.push({ type: 'text', text: `第 ${shown + 1} 张：${src}` }, { type: 'text', text: `${src} 是音频，看波形/响度/卡点用 audio_probe；原地址：${hit.url}` });
              shown++;
              continue;
            }
            const where = hit ? hit.url : src;
            const asVideo = hit?.kind === 'video' || isVideoPath(where) || /\.(mp4|mov|webm)(\?|$)/i.test(where);
            try {
              if (asVideo) {
                const file = await materialize(where, '.mp4');
                const { meta, png } = await videoContactSheet(file);
                let img = { type: 'image', data: png.toString('base64'), mimeType: 'image/png' };
                let note = { ...meta };
                if (crop) {
                  const cropped = await cropBuffer(png, 'image/png', crop);
                  img = { type: 'image', data: cropped.data, mimeType: cropped.mimeType };
                  note = { ...note, crop, cropped: { width: cropped.width, height: cropped.height } };
                }
                const size = img.data.length;
                if (shown && bytes + size > IMAGE_VIEW_BYTES) break;
                bytes += size;
                shown++;
                content.push({ type: 'text', text: `第 ${shown} 张（视频）：${src}\n${JSON.stringify(note)}` }, img);
                continue;
              }
              const remote = /^https?:\/\//.test(where);
              let img = remote || path.isAbsolute(where) ? await imageContent(d, remote ? { url: where } : { file: where }) : { type: 'text', text: '图片读取失败：不是引用、http(s) 地址或绝对路径' };
              if (img.data) {
                const raw = Buffer.from(img.data, 'base64');
                let meta = {};
                try {
                  if (img.mimeType === 'image/png') meta = imageMetaFromPng(raw);
                  else {
                    const im = await loadCanvasImage(raw);
                    meta = { width: im.width, height: im.height };
                  }
                } catch (_) {
                  // Synthetic / tiny fixtures in tests are not always real image bytes.
                }
                if (crop) {
                  const cropped = await cropBuffer(raw, img.mimeType, crop);
                  img = { type: 'image', data: cropped.data, mimeType: cropped.mimeType };
                  meta = { ...meta, crop, cropped: { width: cropped.width, height: cropped.height } };
                }
                const size = img.data.length;
                if (shown && bytes + size > IMAGE_VIEW_BYTES) break;
                bytes += size;
                shown++;
                const detail = [
                  meta.width || meta.height ? `${meta.width}×${meta.height}` : '',
                  meta.alpha_bbox ? `alpha_bbox=${JSON.stringify(meta.alpha_bbox)}` : '',
                  crop ? `crop=${JSON.stringify(crop)}` : '',
                ].filter(Boolean).join(' ');
                content.push({ type: 'text', text: detail ? `第 ${shown} 张：${src}（${detail}）` : `第 ${shown} 张：${src}` }, img);
              } else {
                shown++;
                content.push({ type: 'text', text: `第 ${shown} 张：${src}` }, img);
              }
            } catch (e) {
              shown++;
              const where = (REF_PATTERN.test(src) ? d.refs.get(src)?.url : null) || src;
              const asVideo = isVideoPath(where) || /\.(mp4|mov|webm)(\?|$)/i.test(where) || d.refs.get(src)?.kind === 'video';
              content.push(
                { type: 'text', text: `第 ${shown} 张：${src}` },
                { type: 'text', text: asVideo ? `视频预览失败：${e.message}；原地址：${where}` : `图片读取失败：${e.message}` },
              );
            }
          }
          const rest = images.slice(shown);
          if (rest.length) content.push({ type: 'text', text: JSON.stringify({ not_returned: rest, note: '超出单次体积上限，再调用一次 image_view 看这些' }, null, 2) });
          return { content };
        } finally {
          for (const c of cleanups) c();
        }
      },
    },
    {
      name: 'image_sheet',
      keywords: '拼图 网格 对比 素材 sheet grid',
      description:
        'Grid collage of images without opening Xiangsu — replaces PIL collage / alpha-trim / resize scripts. Up to 24 images; returns the sheet PNG plus metadata.\n\n' +
        'items: images (img: references, URLs, local paths) with optional label and crop. Options: columns (2–4 auto when omitted), tile_height (default 360), trim_alpha (cut fully transparent PNG borders; reports sizes before/after and the opaque ratio), resize, save_to.',
      shape: {
        items: z
          .array(
            z.strictObject({
              src: z.string().min(1).describe('img: reference, http(s) URL, or local image absolute path.'),
              label: z.string().max(40).optional(),
              crop: cropBox.optional(),
            }),
          )
          .min(1)
          .max(24),
        columns: z.number().int().min(1).max(8).optional().describe('Column count; omitted, it adapts between 2–4 columns by image count.'),
        tile_height: z.number().int().min(64).max(1200).optional().describe('Tile height, default 360.'),
        trim_alpha: z.boolean().optional().describe('Trim fully transparent borders of each PNG and report sizes before/after plus the opaque ratio.'),
        resize: z.strictObject({ width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) }).optional(),
        save_to: z.string().min(1).optional().describe('Absolute path of the output PNG.'),
      },
      run: async ({ items, columns, tile_height, trim_alpha, resize, save_to }) => {
        const cleanups = [];
        try {
          const loaded = [];
          for (const it of items) {
            const hit = REF_PATTERN.test(it.src) ? d.refs.get(it.src) : null;
            if (REF_PATTERN.test(it.src) && (!hit || hit.kind !== 'image')) throw Error(`IMAGE_SHEET_BAD_SRC: ${it.src}`);
            const where = hit ? hit.url : it.src;
            let buf;
            if (/^https?:\/\//.test(where)) {
              const got = await d.fetchImageBytes(where);
              buf = got.buf;
            } else if (path.isAbsolute(where)) {
              buf = await fs.promises.readFile(where);
            } else throw Error(`IMAGE_SHEET_BAD_SRC: ${it.src}`);
            loaded.push({ buf, label: it.label, crop: it.crop });
          }
          const sheet = await buildImageSheet({ items: loaded, columns, tile_height, trim_alpha, resize, save_to });
          return {
            content: [
              { type: 'text', text: JSON.stringify({ size: sheet.size, columns: sheet.columns, tile_height: sheet.tile_height, trim: sheet.trim, save_to: sheet.save_to }, null, 2) },
              { type: 'image', data: sheet.png.toString('base64'), mimeType: 'image/png' },
            ],
          };
        } finally {
          for (const c of cleanups) c();
        }
      },
    },
    {
      name: 'makeup_light_metrics',
      keywords: '打光 妆容 亮度 采样 light luma',
      description:
        'Measure makeup lighting: mean luma of brow centre, left/right cheeks, nose tip top, nose base, chin; chin/cheek ratios; left-right cheek difference. Returns the numbers plus a preview with the sample boxes drawn.\n\n' +
        'Sample boxes: preset H / G / ref (original light_metrics.py coordinates, frame-scaled) or custom boxes. image_path: absolute frame path; omitted, a frame is shot from the current preview.',
      shape: {
        ...target,
        image_path: z.string().min(1).optional().describe('Absolute path of a PNG/JPEG frame; omitted, a frame is shot from the current preview.'),
        preset: z.enum(['H', 'G', 'ref']).optional().describe('Standard sample boxes; either this or boxes.'),
        boxes: z
          .array(z.strictObject({ label: z.string().min(1).max(20), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().gt(0).max(1), height: z.number().gt(0).max(1) }))
          .min(1)
          .max(20)
          .optional(),
        save_to: saveTo,
      },
      run: async (a) => {
        if (!a.preset && !a.boxes?.length) throw Error('LIGHT_METRICS_NEED_PRESET_OR_BOXES');
        let pngBuf;
        let label = a.image_path || 'preview';
        if (a.image_path) {
          if (!path.isAbsolute(a.image_path)) throw Error(`IMAGE_PATH_NOT_ABSOLUTE: ${a.image_path}`);
          pngBuf = await fs.promises.readFile(a.image_path);
          if (sniffImage(pngBuf) === 'image/jpeg') pngBuf = await d.jpegToPng(pngBuf);
        } else {
          const instance_id = await officialInstance(a);
          const projectPath = await projects.resolveProjectPath({ instance_id });
          const frame = await pngFrame(projectPath);
          pngBuf = PNG.sync.write(frame);
          label = 'preview_frame';
        }
        const img = decodePng(pngBuf);
        const metrics = lightMetrics(img, { preset: a.preset, boxes: a.boxes });
        const preview = await lightMetricsPreview(pngBuf, metrics);
        const dir = a.save_to ? saveDir(a.save_to) : null;
        if (dir) fs.writeFileSync(path.join(dir, 'light_metrics.jpg'), preview);
        return {
          content: [
            { type: 'text', text: JSON.stringify({ source: label, ...metrics, preview_saved: dir ? path.join(dir, 'light_metrics.jpg') : undefined }, null, 2) },
            { type: 'image', data: preview.toString('base64'), mimeType: 'image/jpeg' },
          ],
        };
      },
    },
    {
      name: 'audio_probe',
      keywords: '音频 音效 卡点 探测 audio',
      description:
        "Probe an audio file (local path, audio: reference, URL): duration, sample rate, channels, codec, mean/peak loudness, silence spans, and beat peaks onset_peaks_s. Uses Xiangsu's bundled ffprobe+ffmpeg.\n\n" +
        'Optionally trims by seconds and exports (export_path, .wav / .mp3); mono_16k=true exports 16 kHz mono.',
      shape: {
        audio: z.string().min(1).describe('audio: reference, http(s) URL, or local audio absolute path.'),
        trim_start_s: z.number().min(0).optional(),
        trim_end_s: z.number().min(0).optional(),
        export_path: z.string().min(1).optional().describe('Absolute path of the export file (.wav or .mp3).'),
        mono_16k: z.boolean().optional(),
      },
      run: async ({ audio, trim_start_s, trim_end_s, export_path, mono_16k }) => {
        const hit = REF_PATTERN.test(audio) ? d.refs.get(audio) : null;
        if (REF_PATTERN.test(audio) && (!hit || (hit.kind !== 'audio' && hit.kind !== 'video'))) {
          throw Error(hit ? `AUDIO_PROBE_BAD_REF: ${audio} 是${KIND_TEXT[hit.kind] || hit.kind}` : `引用 ${audio} 已失效`);
        }
        const where = hit ? hit.url : audio;
        let file = where;
        let cleanup = null;
        if (/^https?:\/\//.test(where)) {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-audio-'));
          const ext = path.extname(new URL(where).pathname) || '.bin';
          file = path.join(dir, `a${ext}`);
          const res = await fetch(where, { signal: AbortSignal.timeout(60000) });
          if (!res.ok) throw Error(`HTTP ${res.status}`);
          fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
          cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
        } else if (!path.isAbsolute(where)) {
          throw Error(`AUDIO_PATH_NOT_ABSOLUTE: ${where}`);
        }
        try {
          const info = await probeAudio(file);
          let exported;
          if (export_path || trim_start_s !== undefined || trim_end_s !== undefined || mono_16k) {
            const out = export_path || path.join(os.tmpdir(), `xs-audio-export-${Date.now()}.wav`);
            exported = await exportAudio(file, { trim_start_s, trim_end_s, export_path: out, mono_16k });
          }
          return text({ ...info, export: exported });
        } finally {
          if (cleanup) cleanup();
        }
      },
    },
    {
      name: 'h5_bundle_build',
      keywords: 'H5 打包 发布 bundle',
      description:
        'Pack and publish an H5 script animation: minify → audit → compatibility compile → pack twice, cross-check digest/sha256 → unpack re-review → publish to the ArtifactStore.\n\n' +
        'Success: artifact_id / expected_digest / zip_relative_path for import_h5_render_bundle. Failure: outcome=error with diagnostics. Needs the local Xiangsu BuiltinResource skills; missing skills are a structured error.',
      shape: {
        source_dir: z.string().min(1).describe('Absolute path of the H5 source directory.'),
        brief_path: z.string().min(1).describe('Absolute path of brief.json.'),
        project_path: z.string().min(1).describe('Absolute path of the Xiangsu project directory (the zip is published to its ArtifactStore).'),
        instance_id: z.string().optional().describe('Project persistent id; omitted, the project directory name is used.'),
        request_id: z.string().min(1),
        short_edge: z.number().int().min(360).max(1440).optional().describe('Default 720.'),
        fps: z.number().int().min(1).max(60).optional().describe('Default 24.'),
      },
      run: async (a) => text(await buildH5Bundle(a)),
    },
    {
      name: 'h5_font_subset',
      keywords: '字体 裁剪 woff2 font subset',
      description: 'Subset a font to woff2 for source_dir/index.html (plus extra_text and printable ASCII) → source_dir/fonts/<output_name>.woff2, with OFL.txt copied alongside. Missing characters: missing_chars and an error.',
      shape: {
        font_path: z.string().min(1).describe('Absolute path of the source font (.ttf/.otf).'),
        license_path: z.string().min(1).describe('Absolute path of OFL.txt.'),
        source_dir: z.string().min(1).describe('Absolute path of the H5 source directory.'),
        output_name: z.string().min(1).describe('Output file name, such as brand.woff2.'),
        extra_text: z.string().optional().describe('Characters that dynamic page copy may show but index.html does not contain.'),
      },
      run: async (a) => {
        const out = await subsetH5Font(a);
        if (out.outcome === 'error') return failure(`H5_FONT_MISSING_CHARS: ${out.missing_chars.join('')}`);
        return text(out);
      },
    },
    {
      name: 'library_list',
      refs: true,
      keywords: '素材库 素材 面板 浏览 library panel browse',
      description: `Browse official asset library panels. Omit panel_key for panel index (${LIBRARY_PANELS_TEXT}); pass panel_key for paged assets (template_id, title, kind, cover_ref). Apply via library_apply; AI image card full set via library_images.`,
      shape: {
        ...target,
        panel_key: z.string().optional().describe('A panel: take panel_key from the panels of a call without panel_key; omitted, only the panel list is returned.'),
        category_id: z.string().optional().describe('Sub-category ID (for 收藏 the folder name); omitted, the first sub-category is used (usually 「全部」).'),
        cursor: z.union([z.number().int().min(0), z.string()]).optional().describe('Page cursor; take next_cursor from the previous page verbatim (a string for 收藏).'),
        count: z.number().int().min(1).max(100).optional().describe('Items per page, default 20.'),
      },
      run: async (a) => {
        if (a.panel_key !== undefined) return library('library_list')(a);
        const { project_path, instance_id } = a;
        const nav = await d.callPlugin('library_nav', {}, await homeWindow({ project_path, instance_id }));
        if (Array.isArray(nav?.panels)) {
          try { d.atlas.recordLibraryPanels(nav.panels); } catch (_) {}
        }
        return text(nav);
      },
    },
    {
      name: 'library_search',
      refs: true,
      keywords: '素材库 搜索 美妆 滤镜 贴纸 音效 library search',
      description: 'Search the official asset library (makeup, filters, distortion, live face, stickers, VFX, sound, square) by query or queries (≤8 synonyms). Exact panel/category names expand that section; first page also lists matching add-object menu items in menu_items (add via menu_add). Paged 10-min cache; apply via library_apply.',
      shape: {
        ...target,
        query: z.string().min(1).optional().describe('Search term, such as 「芒果脸」, 「腮红」 or 「复古滤镜」. Either this or queries.'),
        queries: z.array(z.string().min(1)).min(1).max(8).optional().describe('Search several terms at once and merge, such as ["冷艳", "猫眼", "烟熏", "风格妆"]. Either this or query.'),
        panel_key: z.string().optional().describe('Search only this panel (a panel_key from a library_list call without panel_key, such as aigc_material).'),
        offset: z.number().int().min(0).optional().describe('Paging start; take the previous page next_offset. Default 0.'),
        count: z.number().int().min(1).max(200).optional().describe('Items per page, default 20.'),
      },
      run: async (a) => {
        const { project_path, instance_id, ...params } = a;
        const win = await homeWindow({ project_path, instance_id });
        const page = seenLib.keep(await d.callPlugin('library_search', params, win));
        if (params.panel_key || params.offset) return text(page);
        // 脸蛋天才、磨皮、发光 and the like are add-object menu items, not library assets.
        const terms = params.queries ?? [params.query];
        const menu = new Map();
        for (const term of terms) {
          const q = term.toLowerCase();
          for (const m of (await d.callPlugin('menu_list', { query: term }, win)).items) {
            if (`${m.name}/${m.menu_id}`.toLowerCase().includes(q)) menu.set(m.menu_id, { menu_id: m.menu_id, name: m.name, path: m.path, kind: m.kind });
          }
        }
        return text(menu.size ? { ...page, menu_items: [...menu.values()], menu_note: 'menu_items 是「添加对象」菜单里同名的功能，不在素材库里，用 menu_add 加' } : page);
      },
    },
    {
      name: 'library_images',
      refs: true,
      keywords: 'AI 图片 结果图 ai image',
      description: 'Full result set (image_ref, numbered by image_index) of one AI image card (kind=ai_image). View with image_view; pick one at apply time via library_apply image_index. template_id from this session library_list / library_search.',
      shape: { ...target, template_id: z.string().describe('A template_id from library_list / library_search.') },
      run: async ({ project_path, instance_id, template_id }) => {
        const { slim, raw } = seenLib.get(template_id);
        const images = await d.callPlugin('library_images', { item: raw }, await homeWindow({ project_path, instance_id }));
        return text({ template_id: slim.template_id, title: slim.title, images });
      },
    },
    {
      name: 'library_apply',
      keywords: '应用 素材 加入场景 apply asset',
      description: "Apply an official asset to the target project — the library panel 应用, undoable.\n\n" +
        '- packages: download, MD5 check, import, placed into the scene by default\n' +
        '- 素材广场 cards: the editor own per-kind apply flow; AI images / AI makeup only download the ready-made result (no regeneration, no quota)\n\n' +
        'Returns only once the objects have appeared in the scene: kind, added_objects (names + object_path), package_folders. template_id from this session library_list / library_search. Verify with capture_preview.',
      shape: {
        ...target,
        template_id: z.string().describe('A template_id from library_list / library_search.'),
        auto_instantiate: z.boolean().optional().describe('Whether to place into the scene, default true; false only imports into the asset panel (supported for kind=package only).'),
        image_index: z.number().int().min(0).optional().describe('For kind=ai_image, which result image to use (0-based); the full set is in library_images.'),
      },
      run: async (a) => {
        const { project_path, instance_id, template_id, auto_instantiate, image_index } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        const params = { item: seenLib.get(template_id).raw, ...(auto_instantiate === undefined ? {} : { auto_instantiate }), ...(image_index === undefined ? {} : { image_index }) };
        return text(await d.callPlugin('library_apply', params, { projectPath, timeoutMs: 180000 }));
      },
    },
    {
      name: 'works_list',
      refs: true,
      keywords: '首页 作品 模板 浏览 works browse',
      description: "Page through homepage 「模板」 works of one category. Works are complete Xiangsu projects (official + user submissions), downloadable to learn from their scenes and scripts; any open project window serves.\n\n" +
        'Every call carries all categories (推荐, 官方工程, 新手必做, 游戏, 妆容, AI玩法, ...). Per work: template_id, title, tags, published Douyin effect_id / publish_count (null when absent), usage, package size, cover cover_ref, animated gif_ref — hand covers to image_view. Next: works_download.',
      shape: { ...target, ...workPage },
      run: works('works_list'),
    },
    {
      name: 'works_search',
      refs: true,
      keywords: '首页 作品 搜索 works search',
      description: 'Search homepage works by name — the homepage search box endpoint.\n\n' +
        'Without category_id all categories are searched and merged: 「推荐」 alone bottoms out at ~300 items; categories like 「美化」 / 「友友天地」 hold more. Merge order: 「推荐」 hits first (by sort), then category-unique works in category order; ≤300 per category. A category stuck on the same page while paging is listed in incomplete.\n\n' +
        'Items add found_in; totals: total, by_category. queries merges up to 8 terms (matched_queries per item). Paged by offset / count, 10-minute cache. Other fields as works_list. Lookup by effect ID: works_by_effect.',
      shape: {
        ...target,
        query: z.string().min(1).optional().describe('Work-name keyword, such as 「合掌」, 「转场」 or 「换装」. Either this or queries.'),
        queries: z.array(z.string().min(1)).min(1).max(8).optional().describe('Search several terms at once and merge, such as ["头套", "头饰"]. Either this or query.'),
        category_id: z.string().optional().describe('Search only this category (a category ID from works_list categories); omitted, all categories.'),
        offset: z.number().int().min(0).optional().describe('Paging start; take the previous page next_offset. Default 0.'),
        count: z.number().int().min(1).max(200).optional().describe('Items per page, default 20.'),
        sort: workSort,
      },
      run: works('works_search'),
    },
    {
      name: 'works_by_effect',
      refs: true,
      keywords: '特效 ID 查工程 做同款 works by effect',
      description: 'Check up to 20 effect IDs (from rank_list / effect_search) for downloadable homepage projects: returns per-effect status (found, same_style via mobile 做同款, same_name, not_on_homepage) and matching items ready for works_download / works_open. Leave category_id unset (defaults to 「推荐」).',
      shape: {
        ...target,
        effects: z
          .array(
            z.object({
              effect_id: z.string().regex(/^\d+$/).describe('The effect ID, such as an effect_id from rank_list.'),
              name: z.string().min(1).optional().describe('Effect name; only with it does a same-name lookup run when the ID misses.'),
            }),
          )
          .min(1)
          .max(20)
          .describe('Effects to look up, at most 20 (one rank page).'),
        category_id: workPage.category_id,
      },
      run: works('works_by_effect'),
    },
    {
      name: 'works_download',
      keywords: '下载 作品 工程 学习 works download',
      description: "Download a homepage work as a complete project and unpack it (homepage open-work flow, no window). Returns the project directory plus a file outline.\n\n" +
        "key_files: only what learning the craft needs — effect.dyehpj, scene .scene/.extra, Graph files, author .js/.ts scripts (relative paths + sizes); scripts bundled in official packages (_DynamicAsset) are not listed. Other textures/models: counted only (file_count, by_extension) — list the directory yourself.\n\n" +
        "dest: place the project there (must not exist or be empty, skips the Library cache); the Xiangsu temp copy is removed at once. Omitted, it stays in Xiangsu's temp dir. All downloads are registered and auto-deleted on the next download past expires_at (24 h) — call works_cleanup when done. Same-window downloads queue; send several together. Live inspection: works_open. Author copyright: learning reference only — never copy into your own project or repository.",
      shape: {
        ...target,
        template_id: z.string().describe('A template_id from works_list / works_search / works_by_effect.'),
        dest: z.string().optional().describe('Absolute path of the folder for the project (must not exist or must be empty); omitted, it stays in Xiangsu temp directory.'),
      },
      run: async (a) => {
        const { template_id, dest } = a;
        if (dest !== undefined) checkTarget(dest);
        const got = await downloadWork(a);
        let root = got.project_path;
        if (dest !== undefined) {
          try {
            root = copyProject(got.project_path, dest);
            d.downloads.record({ path: root, template_id, title: got.title });
          } finally {
            d.downloads.cleanup({ paths: [got.root] });
          }
        }
        return text({ template_id: got.template_id, title: got.title, project_path: root, expires_at: expiresAt(), outline: outlineProject(root) });
      },
    },
    {
      name: 'works_open',
      keywords: '打开 作品 编辑器 学习 works open',
      description: 'Download a homepage work and open it in a new editor window (homepage open-work flow; no upgrade dialog, project unsaved). Returns pid, official instance_id, project directory — then study it with get_scene, capture_preview, ... ' +
        QUIET_TEXT +
        ' When done: project_close (discard_changes=true), then works_cleanup; the download survives while a window holds it.',
      shape: { ...target, template_id: z.string().describe('A template_id from works_list / works_search / works_by_effect.') },
      run: async (a) => {
        await projects.ensureFreeWindow();
        const got = await downloadWork(a);
        try {
          const opened = await projects.open({ path: got.project_path, template_id: got.template_id });
          return text({ template_id: got.template_id, title: got.title, ...opened, expires_at: expiresAt() });
        } catch (e) {
          d.downloads.cleanup({ paths: [got.root], openPaths: await openPaths() });
          throw e;
        }
      },
    },
    {
      name: 'works_cleanup',
      keywords: '删除 下载 清理 cleanup works',
      description: 'Delete downloaded homepage works (Xiangsu temp copies and dest copies) from works_download / works_open. No paths = all; ones an open window holds are kept and listed in kept_open — close the window, call again. Only registered downloads are deletable; any other path is refused.',
      shape: { paths: z.array(z.string().min(1)).min(1).optional().describe('Delete only these downloads (project_path values from works_download / works_open); omitted, delete all.') },
      run: async ({ paths }) => {
        const out = d.downloads.cleanup({ paths, openPaths: await openPaths() });
        return text({ ...out, remaining: d.downloads.list().map((e) => e.path) });
      },
    },
    {
      name: 'icon_set',
      keywords: '图标 上传 交付 icon',
      description: 'Set the effect icon (submission requires it): centre-crop square → 360×360 PNG → project Icon/ folder (the same files the 「图标制作」 window saves) → upload to the Douyin platform, like that window 「完成」 button (the submit window only accepts an uploaded icon). By default both female and male slots get the image — the two the submit window requires.\n\n' +
        'Upload failure: ICON_UPLOAD_FAILED, retry. Source: generate_image output or a saved capture_preview frame. Persist with save_project.',
      shape: {
        ...target,
        image_path: z.string().min(1).describe('Absolute path of the image (png / jpg / webp — anything sips reads).'),
        type: z.enum(['both', 'female', 'male', 'common']).optional().describe('Which slot to write: both (default — the female and male slots both get this image; those are the two the submit window requires), female, male, or common.'),
      },
      run: async (a) => {
        const { project_path, instance_id, image_path, type } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        return text(await setIcon(projectPath, image_path, type));
      },
    },
    {
      name: 'icon_compose',
      keywords: '图标 合成 帧裁 icon compose',
      description: 'Compose icon images without opening Xiangsu, from preview_frames frames. Per icon: crop a square → optional one-line stroked / gradient / shadowed caption (the sentence explaining the play) → scale to size (default 720) PNG + 160 thumbnail. Up to 4 per call (female / male image, several framings). Also renders a list-sized (160) side-by-side sheet_160.jpg — the new icons first, then compare_images (similar works icons, to check they still stand apart at list size). The reply carries the sheet and a 360 preview per icon.\n\n' +
        'Out-of-frame crop: CROP_OUT_OF_FRAME (no border padding — background / cut-off headwear fixes follow the project own practice). Happy with an icon: hand the file to icon_set (distinct female/male images: two calls with type).',
      shape: {
        sources: z
          .array(
            z.strictObject({
              frame: absPath('帧').describe('Absolute path of a preview frame image (a file from preview_frames, or any PNG / JPEG).'),
              crop: z
                .union([
                  z.strictObject({ top: z.number().int().min(0).describe('Top edge of a square as wide as the frame (frame pixels).') }),
                  z.strictObject({ x: z.number().int().min(0), y: z.number().int().min(0), size: z.number().int().min(16) }),
                ])
                .describe('Crop which square.'),
              caption: z
                .strictObject({
                  ...textStyle,
                  position: z
                    .union([z.enum(['top', 'bottom']), z.number().min(0).max(1)])
                    .optional()
                    .describe('top / bottom (default, 3% off the edge), or the height of the caption centre (0–1). Keep the caption off the chin and mouth.'),
                  max_width: z.number().gt(0).max(1).optional().describe('Widest fraction of the image width the caption may span, default 0.86.'),
                })
                .optional()
                .describe('Caption; font size and stroke width are in output-size (size) pixels.'),
              name: fileStem.optional().describe('File name without extension; default icon_1, icon_2, ...'),
            }),
          )
          .min(1)
          .max(4),
        size: z.number().int().min(160).max(1080).optional().describe('Icon side length, default 720 (icon_set scales down to 360).'),
        out_dir: outDir.optional().describe('Output directory; omitted, it goes to the temp directory (24 hours before deletion).'),
        compare_images: z.array(absPath('图片')).max(8).optional().describe('Local paths of similar works icons, appended to the side-by-side sheet for comparison.'),
      },
      run: async (a) => {
        const { iconCanvas, jpeg, png, scaled, sheetCanvas } = await graphics();
        const size = a.size ?? 720;
        const dir = a.out_dir ? saveDir(a.out_dir) : d.framesDir();
        const icons = [];
        const thumbs = [];
        const previews = [];
        for (const [i, s] of a.sources.entries()) {
          const name = s.name ?? `icon_${i + 1}`;
          const got = await iconCanvas(s, size);
          const file = path.join(dir, `${name}.png`);
          const thumbFile = path.join(dir, `${name}_160.png`);
          const thumb = scaled(got.canvas, 160);
          fs.writeFileSync(file, await png(got.canvas));
          fs.writeFileSync(thumbFile, await png(thumb));
          thumbs.push(thumb);
          previews.push({ type: 'text', text: `${name}（360 预览）` }, { type: 'image', mimeType: 'image/jpeg', data: (await jpeg(scaled(got.canvas, 360))).toString('base64') });
          icons.push({ name, file, thumb_file: thumbFile, size, crop: got.crop, frame_size: got.source, ...(got.caption_shrunk_to ? { caption_shrunk_to: got.caption_shrunk_to } : {}) });
        }
        const sheetFile = path.join(dir, 'sheet_160.jpg');
        const sheet = await jpeg(await sheetCanvas(thumbs, a.compare_images ?? [], 160));
        fs.writeFileSync(sheetFile, sheet);
        const summary = { icons, sheet_file: sheetFile, ...(a.out_dir ? {} : { note_files: '临时文件，24 小时后删除；要留存请传 out_dir' }), next: '满意后把 file 交给 icon_set' };
        return {
          content: [
            { type: 'text', text: JSON.stringify(summary, null, 2) },
            { type: 'text', text: `列表大小并排：前 ${icons.length} 张是这次做的图标${a.compare_images?.length ? '，后面是 compare_images' : ''}` },
            { type: 'image', mimeType: 'image/jpeg', data: sheet.toString('base64') },
            ...previews,
          ],
        };
      },
    },
    {
      name: 'icon_open',
      keywords: '图标制作 窗口 icon window',
      description: "Open the editor 「图标制作」 icon window (official icon templates, text templates, AI icons) for the user to pick and adjust in. Minimized to the Dock, no focus — tell the user to open it from the Dock.",
      shape: { ...target },
      run: async ({ project_path, instance_id }) => {
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        return text(await keepingFocus(() => d.callPlugin('icon_open', {}, { projectPath })));
      },
    },
    {
      name: 'effect_check',
      keywords: '特效检测 云端检测 check',
      description: 'Run effect detection — the toolbar 「特效检测」: opens the detection window (minimized, no focus), which uploads the package for cloud detection (not publishing) and waits for passed / not_passed / needs_optimization / failed.\n\n' +
        'With a verdict the page details come back: verdict (the page conclusion, e.g. 「检测通过」 / 「特效不通过」), checks (per-check results; size and frame rate carry figures: value, limit, pass — frame rate split android/ios; failing items carry the page advice, or advice_unavailable) — then the window closes (window_closed=true); unreadable details keep the window and return details_error.\n\n' +
        'Past timeout_ms: reply timeout, the window keeps detecting. A stale detection window is closed first (closed_previous) so windows never pile up.',
      shape: { ...target, timeout_ms: z.number().int().min(10000).max(1800000).optional().describe('How long to wait at most, default 300000 (5 minutes).') },
      run: async (a) => {
        const { project_path, instance_id, timeout_ms = 300000 } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        return text(await keepingFocus(() => d.callPlugin('effect_check', { timeout_ms }, { projectPath, timeoutMs: timeout_ms + 30000 })));
      },
    },
    {
      name: 'submit_prepare',
      keywords: '提交 填表 提审 prepare',
      description: 'Open a minimized submit window, fill name/trigger_hint/camera/inspiration/task (and optional icon_image), wait for on-page checks on 「提交审核」, and read back every field to verify. Never ticks the agreement or clicks submit. Next: submit_confirm after user approval.',
      shape: {
        ...target,
        name: z.string().min(1).describe('Effect name: ≤10 chars, two English letters or digits count as one, no emoji or special symbols. Page truncation or an error fails the call.'),
        trigger_hint: z.string().optional().describe('Trigger hint shown when shooting starts, e.g. 「张嘴试试」. ≤10 chars; omitted keeps what the page carried in, an empty string clears it.'),
        camera: z.enum(['front', 'back']).optional().describe('Default camera; omitted keeps the page default (usually front).'),
        icon_image: z.string().min(1).optional().describe('Sets the icon from this image first (icon_set defaults: female and male slots, then upload); omitted keeps the project icon.'),
        inspiration: z
          .string()
          .min(1)
          .optional()
          .describe('Inspiration or hotspot to pick in 「灵感绑定」, by its display name among this account collected ones (an inspiration name is the inspiration_collected title). 「暂不绑定」 unbinds; omitted keeps what the page carried in.'),
        task: z.string().min(1).optional().describe('Task title to pick in 「任务绑定」 (a received task, the tasks_list title). 「暂不参与」 unbinds; omitted keeps what the page carried in.'),
        task_track: z.string().min(1).optional().describe('Track name under the task; required when the task has tracks, else SUBMIT_TASK_NEEDS_TRACK with the tracks listed.'),
        pick_nomination: z.boolean().optional().describe('Optional: tick (true) or untick (false) 「精选提报」 (LV3+ daily quota). Omit to leave unchanged.'),
      },
      run: async (a) => {
        const { project_path, instance_id, icon_image, ...fill } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        if (icon_image !== undefined) await setIcon(projectPath, icon_image);
        return text(await keepingFocus(() => d.callPlugin('submit_prepare', fill, { projectPath, timeoutMs: 360000 })));
      },
    },
    {
      name: 'submit_confirm',
      keywords: '送审 提交 审核 submit confirm',
      description: 'Submit the effect for review in the window filled by submit_prepare (irreversible, consumes account submission quota; confirm with user first). Verifies name matches filled.name, checks pass, and no duplicate among newest 10 works; ticks 《创作者协议》 if needed and waits up to 5 min for effect_id. On SUBMIT_FAILED / SUBMIT_RESULT_UNKNOWN, never auto-retry: check pipeline_refresh + pipeline_works first.',
      shape: { ...target, name: z.string().min(1).describe('The effect name to submit; must equal filled.name from the submit_prepare summary.') },
      run: async (a) => {
        const { project_path, instance_id, name } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        const got = await keepingFocus(() => d.callPlugin('submit_confirm', { name }, { projectPath, timeoutMs: SUBMIT_CONFIRM_TIMEOUT_MS }));
        return text({ ...got, ...(await listedEffect(projectPath, got)) });
      },
    },
    {
      name: 'mobile_preview',
      keywords: '手机预览 真机 二维码 preview qr',
      description:
        'Packages the current project the way the toolbar 「手机预览」 does, uploads it to the Douyin preview service, and returns the same QR image the editor pops up (with its text and validity). Scanning it with the Douyin app shows the effect on a real phone.\n\n' +
        'The QR is also saved to qr_file — hand that to the user to scan and do not store it elsewhere; it is auto-deleted past expires_at (usually 7 days). The effect package is uploaded to Douyin servers; a moderation failure reports MOBILE_PREVIEW_MODERATION_FAILED.',
      shape: { ...target },
      run: async (a) => {
        const projectPath = await projects.resolveProjectPath(a);
        const res = await d.callPlugin('mobile_preview', {}, { projectPath, timeoutMs: 300000 });
        const png = await d.qrPng(res.qr_text);
        const ttlMs = (res.expires_in_sec ?? QR_TTL_SEC) * 1000;
        const expiresAt = d.qrCodes.now() + ttlMs;
        d.qrCodes.prune();
        const qr_file = d.qrCodes.save(png, { project: path.basename(res.project_path), expiresAt });
        d.schedule(() => d.qrCodes.prune(), ttlMs + QR_PRUNE_SLACK_MS);
        return {
          content: [
            { type: 'text', text: JSON.stringify({ ...res, qr_file, expires_at: new Date(expiresAt).toISOString() }, null, 2) },
            { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
          ],
        };
      },
    },
    {
      name: 'inspiration_list',
      refs: true,
      keywords: '灵感 列表 分类 inspiration list',
      description: 'Page through inspirations of one tab — the ideas official and creators publish for effects (the homepage 「灵感」 tab).\n\n' +
        'Per item: inspiration_id, title, tags (e.g. 「激励」), author, collect count, collected-or-not, AI-or-not, linked hotspot, cover cover_ref (hand to image_view). Every call carries all tabs. Next: inspiration_detail.',
      shape: {
        ...target,
        tab: z.string().optional().describe('A tab name from the previous reply tabs (全部, 热门音源, 头饰, 变形, ...); omitted, the first one (全部).'),
        cursor: z.number().int().min(0).optional().describe('Page cursor; take the previous page next_cursor.'),
        // The server answers code 1 at 100 (measured); 50 works.
        count: z.number().int().min(1).max(50).optional().describe('Items per page, default 20.'),
      },
      run: community('inspiration_list', (out) => out.items),
    },
    {
      name: 'inspiration_detail',
      keywords: '灵感 详情 激励 inspiration detail',
      description: 'One inspiration in full: play description, effect types, incentive terms, all image addresses (images — view via image_view), author, reward (amount, terms, dates), linked hotspot (heat, tags such as 「66条热点相关灵感」), linked official project (server gives only title, icon and a "searchable in the desktop app" note — no project id; checked across 13 such inspirations 2026-11-09 — to download it, works_search by that title), existing effects of this inspiration with publish counts, sample videos videos (Douyin play URLs, covers, authors, likes, dimensions), stickers, and whether this account has collected it plus the total.\n\n' +
        'id source: inspiration_list / inspiration_collected / inspiration_search / hotspot_inspirations / growth_task_detail, or an ID from the Xiangsu / Douyin app inspiration page.',
      shape: { ...target, inspiration_id: z.string().min(1).describe('An inspiration_id from inspiration_list / inspiration_collected / inspiration_search / hotspot_inspirations / growth_task_detail, or from the Xiangsu / Douyin app inspiration page.') },
      run: community('inspiration_detail'),
    },
    {
      name: 'inspiration_collect',
      keywords: '灵感 收藏 collect',
      description: 'Collect or uncollect an inspiration (written to the logged-in account, same as the detail-page button); re-query the state afterwards to confirm it took effect.',
      shape: {
        ...target,
        inspiration_id: z.string().min(1).describe('The inspiration_id to collect.'),
        collect: z.boolean().optional().describe('true collect (default), false uncollect.'),
      },
      run: community('inspiration_collect'),
    },
    {
      name: 'inspiration_collected',
      refs: true,
      keywords: '灵感 收藏列表 collected',
      description: 'Page through the account collected inspirations, newest first (the 「灵感」 tab 收藏 page, same endpoint). Fields as inspiration_list, plus collected_at, artwork_type (0 effect, 2 template, 5 sticker), and the collecting task (task_id + title; picking another task at submit time displaces this inspiration).\n\n' +
        'Entries without a server-side card carry only inspiration_id + title and are flagged card_missing=true. Only inspirations here — not collected hotspots or assets. submit_prepare picks its inspiration by title among these. Paged by cursor; total is the collection size.',
      shape: {
        ...target,
        cursor: z.number().int().min(0).optional().describe('Page cursor (offset); take the previous page next_cursor. Default 0.'),
        // 100 came back as 50 (2026-11-10).
        count: z.number().int().min(1).max(50).optional().describe('Items per page, default 20, max 50.'),
      },
      run: community('inspiration_collected'),
    },
    {
      name: 'submit_close',
      keywords: '关闭 提交窗口 submit close',
      description: 'Close the submit window open in this project window (from submit_prepare, not yet submitted); opens nothing. Returns closed (how many). To change what is filled, skip this — submit_prepare closes the old window itself.',
      shape: { ...target },
      run: plugin('submit_close'),
    },
    {
      name: 'inspiration_bind',
      keywords: '灵感 绑定 bind',
      description: 'Bind an inspiration (by inspiration_id) to the current project — the editor interface for agents; save_project persists it, and the submit window carries it in automatically.\n\n' +
        'The submit window dropdown only lists collected inspirations, so this tool collects it first too (newly_collected=true marks the fresh one; uncollect via inspiration_collect if unwanted). Alternative: skip binding and pass inspiration to submit_prepare directly — it picks by name in the dropdown (collected inspirations and hotspots only).',
      shape: { ...target, inspiration_id: z.string().min(1).describe('The inspiration_id to bind.') },
      run: plugin('inspiration_bind'),
    },
    {
      name: 'tasks_list',
      refs: true,
      keywords: '任务 活动中心 列表 tasks',
      description: 'Page through the activity centre campaigns and effect-collection tasks: title, status (WAIT_RECEIVE awaiting claim / WAIT_SUBMIT awaiting submission), received-or-not, status note, days left, reward, online/offline dates, completion counts.\n\n' +
        'With a task_id: task_detail for the full brief, task_receive to claim, task_bind to bind to a project (bindable=true required). Growth tasks: growth_tasks_list.',
      shape: { ...target, ...pageShape },
      run: async ({ project_path, instance_id, offset = 0, count = 20 }) => text(pageOf(seenTasks.keep(await d.callPlugin('tasks_list', {}, await homeWindow({ project_path, instance_id }))), offset, count)),
    },
    {
      name: 'growth_tasks_list',
      refs: true,
      keywords: '成长任务 列表 growth tasks',
      description: 'Page through activity-centre growth tasks: task_id, title, reward bonus_yuan, tags, newcomer flag, reference works. Details (reference works, related inspirations, tutorials): growth_task_detail; designer level and per-level progress: account_status growth.',
      shape: { ...target, ...pageShape },
      run: async ({ project_path, instance_id, offset = 0, count = 20 }) => text(pageOf(seenGrowth.keep(await d.callPlugin('growth_tasks_list', {}, await homeWindow({ project_path, instance_id }))), offset, count)),
    },
    {
      name: 'task_detail',
      refs: true,
      keywords: '任务 详情 要求 task detail',
      description: 'One effect-collection task in full: status, reward dates, offline date, my_effects submitted to it (name, effect_id, review state, shoots, plays, publish peak, prize money, task evaluation task_state — pending: not yet rated, no tag on the task page; unfinished; done; unknown values passed through verbatim — and off_theme when the task page marked 「主题不符合」, plus tracks), completion state, tiered-prize flag, recommended_template_ids from the task page (top 20 after dedup; total in recommended_template_total, all in save_to; no tool downloads by these ids — treat as leads), and content — the organized brief: blocks (participation requirements, prizes, recent hits, task notes, ...) each with name, items and links; items carry title, text (in-page link markup converted to text, links moved into links), reference images image_refs and videos video_refs; prize items add money, money_mode and people (unlimited = unlimited) as the page shows them; empty and blob: addresses are invisible on the task page too and only counted in unusable_media; unparsable fields land in unread verbatim. Raw response: save_to.\n\n' +
        'task_id from tasks_list (missing from this session: the task list is re-read once first). Activities have no detail; growth tasks: growth_task_detail. To see what each of our works earned for its task and inspiration bindings in one shot: pipeline_works bindings (ref_id there is the data-card number, not necessarily the tasks_list task_id — match by task name when they disagree).',
      shape: { ...target, task_id: z.string().min(1).describe('A task_id from tasks_list.'), save_to: saveTo.describe('Directory (absolute path) to save the raw API response into, as task_detail-<task_id>.json, for long-term keeping.') },
      run: async (a) => {
        const { project_path, instance_id, task_id, save_to } = a;
        const win = await homeWindow({ project_path, instance_id });
        if (!seenTasks.map.has(String(task_id))) await refreshTasks(win);
        const t = seenTasks.get(task_id);
        if (t.raw.kind === 'activity') throw Error(`NO_TASK_DETAIL: ${task_id} is an activity; only effect tasks have details`);
        const { raw, ...out } = await d.callPlugin('task_detail', { id: t.raw.item_id }, win);
        if (save_to === undefined) return text({ task_id, ...out });
        const file = saveFile(save_to, `task_detail-${task_id}.json`, JSON.stringify(raw ?? out, null, 2));
        return text({ task_id, ...out, raw_saved_to: file });
      },
    },
    {
      name: 'growth_task_detail',
      refs: true,
      keywords: '成长任务 详情 growth task detail',
      description: 'One growth task in full: title, reward, tags, reference works, related inspirations (cover cover_ref), tutorials. task_id from this session growth_tasks_list.',
      shape: { ...target, task_id: z.string().min(1).describe('A task_id from growth_tasks_list.') },
      run: async ({ project_path, instance_id, task_id }) => {
        seenGrowth.get(task_id);
        return text({ task_id, ...(await d.callPlugin('growth_task_detail', { id: task_id }, await homeWindow({ project_path, instance_id }))) });
      },
    },
    {
      name: 'task_receive',
      keywords: '领取 任务 receive',
      description: 'Claim a collection task (written to the logged-in account, same as the activity-centre button; cannot be undone). Only WAIT_RECEIVE tasks are claimable — anything else is refused. Returns designer_task_id and the new state; the task list is re-read afterwards so task_bind can follow immediately.',
      shape: { ...target, task_id: z.string().min(1).describe('A task_id from tasks_list.') },
      run: async (a) => {
        const { project_path, instance_id, task_id } = a;
        const t = seenTasks.get(task_id);
        if (t.raw.kind !== 'task') throw Error(`TASK_NOT_RECEIVABLE: ${task_id} is not an effect task (kind=${t.raw.kind})`);
        const win = await homeWindow({ project_path, instance_id });
        const out = await d.callPlugin('task_receive', { item_id: t.raw.item_id }, win);
        await refreshTasks(win);
        return text({ task_id, ...out });
      },
    },
    {
      name: 'task_bind',
      keywords: '任务 绑定 工程 bind',
      description: 'Bind the project to a received task — the same as 「去创作」 from the task detail page; submissions carry the task.\n\n' +
        'The editor only writes task info at project-open time, so this tool closes the project window first (refuses with unsaved changes — save_project), then reopens it carrying the task info, returning the new pid and instance_id. The task-carrying open must be launched via another open window; when this project is the only one, an unsaved blank project stands in for it and is closed after.\n\n' +
        'task_id from this session tasks_list (bindable=true). Alternative without reopening: pass task (a received task title) to submit_prepare.',
      shape: {
        path: z.string().min(1).describe('Absolute path of the project folder.'),
        task_id: z.string().min(1).describe('A task_id from tasks_list (bindable=true).'),
      },
      run: async ({ path: projectDir, task_id }) => {
        let t = seenTasks.get(task_id);
        if (!t.raw.extra) {
          await refreshTasks(await homeWindow({}));
          t = seenTasks.get(task_id);
        }
        if (!t.raw.extra) throw Error(`TASK_NOT_RECEIVED: ${task_id}; receive it with task_receive first`);
        const windows = await projects.windows();
        const mine = windows.find((w) => w.project_path && fs.existsSync(w.project_path) && fs.realpathSync(w.project_path) === fs.realpathSync(projectDir));
        const open = !!mine;
        if (open && (await d.callPlugin('project_state', {}, { pid: mine.pid, timeoutMs: 5000 })).changed) throw Error(`PROJECT_HAS_UNSAVED_CHANGES: ${projectDir}; save it first (task_bind closes and reopens the window)`);
        // A task launch goes through another open window; when this project's is the only one, an
        // unsaved empty project stands in for it until the project is back, then is closed unsaved.
        const bridge = open && windows.length === 1 ? await projects.newUnsaved() : null;
        if (open) await projects.close({ project_path: projectDir });
        let opened;
        try {
          opened = await projects.open({ path: projectDir, activity: t.raw.extra });
        } catch (e) {
          if (!open) throw e;
          throw Error(`BIND_REOPEN_FAILED: ${projectDir} was closed to bind the task but did not reopen (${e.message}); the task is not bound: reopen it with project_open, then task_bind again${bridge ? `; the empty stand-in window ${bridge.project_path} is still open, close it with project_close (discard_changes=true)` : ''}`);
        }
        if (bridge) await projects.close({ project_path: bridge.project_path, discard_changes: true });
        return text({ task: t.slim, ...opened, ...(bridge ? { stand_in_window: 'closed' } : {}) });
      },
    },
    {
      name: 'rank_list',
      refs: true,
      keywords: '排行榜 榜单 投稿 rank',
      description: 'Read one ranking board (the mobile leaderboard endpoint): rank, effect name, effect_id, level, publishes (peak / cumulative), follow-shoots, gender split, youth favour, play score, total earnings, etc.\n\n' +
        'Filters by date, category (one per level, e.g. only 「人像美化 › 美妆」) and the options below; every page carries the board categories of the day (level 1 groups like 人像美化, 游戏玩法, 人设扮演, AI玩法; level 2 sub-tracks like 基础头饰, 测一测, 不露脸壁纸 — per board). Theme boards (e.g. 「热爆美妆特效榜」): rank_subjects. To find a homepage project for an effect: works_by_effect with its effect_id and name.',
      shape: {
        ...target,
        rank_type: z.number().int().optional().describe(`The board: ${RANK_TYPE_TEXT}; default 1.`),
        date: z.string().optional().describe('Board date YYYY-MM-DD; the latest edition by default.'),
        categories: z.array(z.string()).max(3).optional().describe('Category names from the previous reply categories, one per level, stackable, e.g. ["人像美化","美妆"] (group + sub-track).'),
        levels: rankFilter('levels').describe('Effect levels, e.g. ["S","A+"].'),
        panels: rankFilter('panels').describe('Panels, e.g. ["头饰","美妆"].'),
        preferences: rankFilter('preferences').describe('Preferences.'),
        tools: rankFilter('tools').describe('Source tools.'),
        young_like_scores: z.array(z.number().int().min(1).max(10)).optional().describe('Youth favour 1–10.'),
        cursor: z.number().int().min(0).optional().describe('Page cursor; take the previous page next_cursor.'),
        // The server answers code 1 above 20 (measured).
        count: z.number().int().min(1).max(20).optional().describe('Items per page, default 20 (max 20).'),
      },
      run: community('rank_list'),
    },
    {
      name: 'rank_hotspots',
      refs: true,
      keywords: '热点 榜 热度 hotspots',
      description: 'The hotspot board (Douyin hotspots by heat, hourly), paged by offset / count: rank, topic_id, title, description, heat, linked-inspiration count, cover cover_ref. Inspirations under one hotspot: hotspot_inspirations. The site-wide Douyin real-time list: douyin_hot_list.',
      shape: { ...target, ...pageShape },
      run: community('rank_hotspots'),
    },
    {
      name: 'hotspot_inspirations',
      refs: true,
      keywords: '热点 灵感 hotspot',
      description: 'Inspirations under one hotspot, in hotspot-page tab order, paged by offset / count: per item the tab, inspiration_id, title, tags, description, cover cover_ref (hand to image_view); tabs lists all tab names.\n\n' +
        'Details: inspiration_detail. Download all images of every inspiration under this hotspot: hotspot_inspiration_images.',
      shape: { ...target, topic_id: z.string().min(1).describe('A topic_id from rank_hotspots.'), ...pageShape },
      run: async ({ project_path, instance_id, topic_id, offset = 0, count = 20 }) =>
        text(pageOf(await d.callPlugin('hotspot_inspirations', { topic_id }, await homeWindow({ project_path, instance_id })), offset, count)),
    },
    {
      name: 'hotspot_inspiration_images',
      keywords: '热点 灵感 下载 图片 images',
      description: 'Download every image of every inspiration under one hotspot: each inspiration detail is read, all its images downloaded (the cover is image 1; most inspirations have 1, some 3 or 6), and an inspiration appearing in several tabs is fetched once. File names are 「序号-灵感标题-第几张.扩展名」 numbered in hotspot-page order; index.json beside them records each inspiration inspiration_id, title, tab, files and original URLs.\n\n' +
        'Files are temporary — in the temp directory, deleted after 24 hours (on schedule while the server runs; on the next call of this tool after a restart) — copy them out to keep. About 70 images per hotspot, roughly a minute. Returns dir, inspiration count, images saved, per-inspiration file names, and failed (detail unreadable, image failed twice, or not an image); zero images saved is an error. topic_id from rank_hotspots.',
      shape: {
        ...target,
        topic_id: z.string().min(1).describe('A topic_id from rank_hotspots.'),
        tab: z.string().min(1).optional().describe('Download only this tab (one of hotspot_inspirations tabs); omitted, all.'),
      },
      run: async ({ project_path, instance_id, topic_id, tab }) => {
        const win = await homeWindow({ project_path, instance_id });
        const listed = await d.callPlugin('hotspot_inspirations', { topic_id }, win);
        if (tab !== undefined && !listed.tabs.includes(tab)) throw Error(`INVALID_TAB: ${tab}; valid: ${listed.tabs.join(', ')}`);
        const ids = new Set();
        const picked = listed.items.filter((i) => (tab === undefined || i.tab === tab) && !ids.has(i.inspiration_id) && ids.add(i.inspiration_id));
        if (!picked.length) throw Error(`NO_INSPIRATIONS: hotspot ${topic_id}${tab === undefined ? '' : ` tab ${tab}`} lists no inspirations`);
        const dir = d.inspirationImagesDir();
        d.schedule(() => fs.rmSync(dir, { recursive: true, force: true }), FRAMES_TTL_MS);
        const width = String(picked.length).length;
        const rows = await mapPool(picked, INSPIRATION_IMAGE_CONCURRENCY, async (insp, i) => {
          const row = { inspiration_id: insp.inspiration_id, title: insp.title, tab: insp.tab, files: [], errors: [] };
          let images;
          try {
            ({ images } = await d.callPlugin('inspiration_detail', { inspiration_id: insp.inspiration_id }, win));
          } catch (e) {
            row.errors.push(`detail: ${e.message}`);
            return row;
          }
          if (!images.length) row.errors.push('detail: no images');
          const base = `${String(i + 1).padStart(width, '0')}-${fileSafe(insp.title)}`;
          for (const [n, url] of images.entries()) {
            const get = () => d.fetchImageBytes(url, { timeoutMs: INSPIRATION_IMAGE_TIMEOUT_MS });
            try {
              const { buf, mimeType } = await get().catch(get);
              const file = `${base}-${n + 1}.${IMAGE_EXT[mimeType]}`;
              fs.writeFileSync(path.join(dir, file), buf);
              row.files.push({ file, url });
            } catch (e) {
              row.errors.push(`image ${n + 1}: ${e.message}`);
            }
          }
          return row;
        });
        const saved = rows.reduce((n, r) => n + r.files.length, 0);
        const failed = rows.filter((r) => r.errors.length).map(({ inspiration_id, title, errors }) => ({ inspiration_id, title, errors }));
        if (!saved) throw Error(`NO_IMAGES_SAVED: ${JSON.stringify(failed.slice(0, 5))}`);
        const index_file = path.join(dir, 'index.json');
        fs.writeFileSync(index_file, JSON.stringify({ topic_id, tab: tab ?? null, items: rows }, null, 2));
        return text({
          topic_id,
          tab: tab ?? null,
          dir,
          index_file,
          expires_at: new Date(Date.now() + FRAMES_TTL_MS).toISOString(),
          inspirations: picked.length,
          images_saved: saved,
          items: rows.map((r) => ({ inspiration_id: r.inspiration_id, title: r.title, files: r.files.map((f) => f.file) })),
          failed,
        });
      },
    },
    {
      name: 'rank_subjects',
      refs: true,
      keywords: '专题 合集 榜单 subjects',
      description: 'The mobile 「专题合集」 theme boards, newest first, paged by cursor: kind=effect effect subject boards (about 200 editions, e.g. 「测一测玩法特效榜 - 11月」, 「热爆美妆特效榜」, 「熊出没IP特效榜」, 「主题创新优胜特效榜」, collection campaigns quality effects), kind=template template subject boards (e.g. 「歌词玩法模板榜」, 「AI配文创意模板榜」, 「氛围转场模板榜」).\n\n' +
        'Each board carries its first few effects and view count. Search by name: rank_subjects_search; all effects of one board: rank_subject_detail.',
      shape: {
        ...target,
        kind: subjectKind,
        cursor: z.number().int().min(0).optional().describe('Page cursor; take the previous page next_cursor.'),
        // The server answers code 1 above 20 (measured).
        count: z.number().int().min(1).max(20).optional().describe('Items per page, default 20 (max 20).'),
      },
      run: community('rank_subjects'),
    },
    {
      name: 'rank_subjects_search',
      refs: true,
      keywords: '专题 搜索 榜名 subjects search',
      description: 'Search all 「专题合集」 editions by board name (no server-side search — pages through everything and filters); returns every matching board, unpaged; each with its first few effects and view count.',
      shape: { ...target, kind: subjectKind, keyword: z.string().min(1).describe('A word from the board name, such as 「美妆」, 「测一测」, 「IP」, 「热梗」.') },
      run: community('rank_subjects_search'),
    },
    {
      name: 'rank_subject_detail',
      refs: true,
      keywords: '专题 详情 榜单 subject detail',
      description: 'All effects of one 「专题合集」 board (at most 20): name, effect_id, app_effect_id, icon, description.',
      shape: { ...target, subject_id: z.string().min(1).describe('A subject_id from rank_subjects / rank_subjects_search.') },
      run: community('rank_subject_detail'),
    },
    {
      name: 'rank_innovation',
      refs: true,
      keywords: '创新计划 精选 innovation',
      description: 'The Innovation Program official picks (the mobile discovery page; the mobile view shows templates): name, effect_id, labels labels (repeated entries of one effect with different labels on one page are merged), publishes, total earnings, pick date, cover.\n\n' +
        'The server offset is not per item: paging re-serves previous effects and the returned date may change — dedupe by effect_id to see everything.',
      shape: {
        ...target,
        kind: z.enum(INNOVATION_KINDS).optional().describe('template picked templates (default), effect picked effects.'),
        offset: z.number().int().min(0).optional().describe('Paging offset; take the previous page next_offset.'),
        count: z.number().int().min(1).max(100).optional().describe('Items per page, default 20; server-side filtering may return slightly fewer.'),
      },
      run: community('rank_innovation'),
    },
    {
      name: 'pipeline_works',
      keywords: '作品 进度 精选 看板 pipeline works',
      description: 'Ops platform (/api/agent/works): status of all our works across online (reviewing/testing/online/rejected), pick (waiting/missed/round1/round2/picked/pick_rejected), and reward lines; grouped by act/wait/done with rejection reasons, ETAs, bindings, metrics, account restrictions, and submit_pace.',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/works')),
    },
    {
      name: 'pipeline_work',
      keywords: '作品 详情 数据 timeline pipeline work',
      description: 'One work in full (ops platform /api/agent/works/:id): the pipeline_works row, plus timeline (submit, test, online, pick review, round-1 failure, picked / rejected, reward, promo video, task completion, binding ratings, judged-not-entered — each step with time, time source, seconds since the previous), per-day cumulative exposure / publishes days, data-card figures (page text verbatim), functions used, traffic tags (pick boosts with delivered and planned exposure), review records (rejection reasons verbatim), revenue detail, popular user videos + whether the author shot it themselves (author_shot), and all changes events. effect_id from pipeline_works.',
      shape: { effect_id: z.string().regex(/^\d+$/).describe('An effect_id from pipeline_works.') },
      run: async ({ effect_id }) => text(await d.platformRequest(`/api/agent/works/${effect_id}`)),
    },
    {
      name: 'account_status',
      keywords: '账号 等级 提交节奏 限制 account',
      description: 'The account (ops platform /api/agent/account): restricted + restriction details (until = lift time; until_source notice = from the restriction notice, default = notice gave none, 24 h assumed; the platform does not notify on lift), submit_pace (today count, last submit, next_allowed_at), Xiangsu login auth (expires_at, logged_out, warn), profile numbers (nickname, level, fans, total shoots, monthly submits / online / earnings), revenue, growth (per-level goals and progress), this period shoot-video incentive shoot_activity (task, streak tiers), the pick-author program author_plan, the latest 50 works/account messages (promos excluded), and unmatched_messages.',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/account')),
    },
    {
      name: 'changes_since',
      keywords: '变化 进度 告诉用户 changes',
      description: 'Changes since the last point already told to the user (ops platform /api/agent/changes): work stages moved (reviewing, online, rejection, pick review, round-1 failure, picked, rejected, judged-not-entered, reward pending / unlocked), binding ratings moved, tasks completed and prizes announced, pick boosts, restriction start and lift time, Xiangsu login expired or expiring.\n\n' +
        'Each item: id, type (stage / binding / notice / restriction / auth), at + at_kind, work effect_id and name, one-line text, needs_you (user must act). At session start call once, tell the user the changes (needs_you first), then changes_ack with the returned up_to; without ack they come back next time. has_more: continue with after=up_to. Progress is shared across all agent conversations — anything another conversation already told does not reappear. Also carries restriction state and submit pace.',
      shape: {
        after: z.number().int().min(0).optional().describe('Take events after this id; default is the told-to-user progress.'),
        limit: z.number().int().min(1).max(200).optional().describe('At most this many items, default 50.'),
        types: z.string().regex(/^[a-z,]+$/).optional().describe('Only these types, comma-separated: stage, binding, notice, restriction, auth.'),
      },
      run: async ({ after, limit, types }) => {
        const q = new URLSearchParams();
        if (after !== undefined) q.set('after', String(after));
        if (limit !== undefined) q.set('limit', String(limit));
        if (types) q.set('types', types);
        return text(await d.platformRequest(`/api/agent/changes${q.size ? `?${q}` : ''}`));
      },
    },
    {
      name: 'changes_ack',
      keywords: '变化 确认 已告知 ack',
      description: 'Push the told-to-user progress to up_to (from changes_since). Only moves forward, never past the newest change; returns the new progress told. Call only after those changes were actually told to the user.',
      shape: { up_to: z.number().int().min(0).describe('The up_to from changes_since.') },
      run: async ({ up_to }) => text(await d.platformRequest('/api/agent/changes/ack', 'POST', { up_to })),
    },
    {
      name: 'pipeline_refresh',
      keywords: '刷新 重取 看板 refresh',
      description: 'Make the ops platform re-fetch works, inbox mail and due data cards now (POST /api/agent/refresh) — right after a submission, going online, or while waiting for a pick-review message; otherwise it refreshes every 10 min. At most once per 5 minutes: too soon returns started=false with next_allowed_at, already running returns started=false. The collector starts within ~15 s; one pass takes seconds to a couple of minutes — afterwards call pipeline_works and check data_at and refreshing.',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/refresh', 'POST')),
    },
    {
      name: 'brief_today',
      keywords: '开工 简报 主攻 方向 brief today',
      description: 'Ops platform morning brief (/api/agent/brief) — read once per session before ideation. Sections: account, changes (ack via changes_ack), focus, tracks, insights, lessons, hits, douyin, hotspots, fresh, tasks. Pass sections to fetch only specific blocks and save context.',
      shape: {
        sections: z.array(z.string().min(1)).min(1).optional().describe('Optional subset of top-level keys to return (e.g. ["account", "changes", "focus", "hotspots"]).'),
      },
      run: async ({ sections } = {}) => {
        const data = await d.platformRequest('/api/agent/brief');
        if (!sections?.length || !data || typeof data !== 'object') return text(data);
        const picked = {};
        const missing = [];
        for (const k of sections) {
          if (Object.hasOwn(data, k)) picked[k] = data[k];
          else missing.push(k);
        }
        return text({ ...picked, ...(missing.length ? { missing_sections: missing, available_sections: Object.keys(data) } : {}) });
      },
    },
    {
      name: 'track_board',
      keywords: '赛道 精选 汇总 track board',
      description: 'Pick status of every sub-track (ops platform /api/agent/tracks): per track its parent, platform picks (30 days, last 7, prior 7), how many we made, entered, picked, rejected, missed, still waiting, entry rate, our works stages (our_works), and recent pick samples (name, pick date, tags, publishes, functions, icon). Sorted by platform picks; templates collapse into one 「模板」 row.',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/tracks')),
    },
    {
      name: 'pick_samples',
      keywords: '精选 样例 明细 picks',
      description: 'Official pick details (ops platform /api/agent/picks, the pick board and picked-work details collected daily): name, app_effect_id, kind (effect / template), track (platform sub-track), labels, pick date reviewed_on, publishes, editor functions, icon. Filter by track, kind, recent days; newest picks first.\n\n' +
        'Videos of one work: effect_videos; projects: works_by_effect.',
      shape: {
        track: z.string().max(40).optional().describe('Sub-track, such as 「脸控游戏」, 「玩法测试」, 「模板」 — from brief_today / track_board track.'),
        kind: z.enum(['effect', 'template']).optional().describe('effect or template; omitted, both.'),
        days: z.number().int().min(1).max(90).optional().describe('Picked within the last n days, default 30.'),
        limit: z.number().int().min(1).max(200).optional().describe('At most this many, default 30.'),
      },
      run: async ({ track, kind, days, limit }) => {
        const q = new URLSearchParams();
        if (track) q.set('track', track);
        if (kind) q.set('kind', kind);
        if (days !== undefined) q.set('days', String(days));
        if (limit !== undefined) q.set('limit', String(limit));
        return text(await d.platformRequest(`/api/agent/picks${q.size ? `?${q}` : ''}`));
      },
    },
    {
      name: 'failure_lessons',
      keywords: '失败 经验 驳回 落选 lessons',
      description: 'All failure lessons (ops platform /api/agent/lessons, platform data only): submission rejections (grouped by the platform reason title, e.g. 「名称与效果不相关」), test failures, pick rejections (platform wording, one entry each), pick round-1 failures, judged-not-entered (grouped by track). Each: kind / label, reason, count, works (in order), first and latest date, a verbatim sample_text.\n\n' +
        'A reason that repeats must be avoided in ideation and naming. Real-device play lessons are not here — they live in the rules files.',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/lessons')),
    },
    {
      name: 'hot_topics',
      keywords: '像塑 热点 扎堆 hot topics',
      description: 'Xiangsu hotspots (ops platform /api/agent/hotspots, refreshed every 6 h): updated_at; items ranked, each with topic_id, title, description, heat, heat_delta + rank_delta vs about a day ago, is_new, crowd (same-topic effects and templates: matched count, lists, top by publishes — searched daily by hotspot title), label (扎堆: ≥6 same-topic; 还早: ≤2 and rising; 有人做; 没查), and the top 10 with their inspirations (title, tags, play description); rising: the 5 fastest risers as topic_ids.\n\n' +
        'Xiangsu hotspots only; the Douyin hot list (key direction, 「站内玩法」 categories only) is douyin_hot_list.',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/hotspots')),
    },
    {
      name: 'task_usage',
      keywords: '任务 占用 评定 usage',
      description: 'Tasks we bound that have not closed yet (ops platform /api/agent/tasks): title, deadline, same_type_clause (whether the notes carry clauses like 「同一设计师提交多个同类型玩法」), and per work of ours its platform track and rating state (pending / unfinished / done / off_theme).\n\n' +
        'When a task has a same-type clause, only bind new works whose platform track differs from the already-bound ones (rules: 规范/选题与组合.md「绑任务和灵感」).',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/tasks')),
    },
    {
      name: 'douyin_hot_list',
      keywords: '抖音 热榜 douyin hot list',
      description: 'The Douyin hot list (ops platform /api/agent/douyin-hot, hourly; key direction — we publish to Douyin and Douyin promotes our videos): only hotspots relevant to making effects, i.e. categories containing 「站内玩法」 (the gameplay-class hotspots Douyin tags; e.g. 2026-11-17 board: 「茉茉手势舞」, 「在美术馆和另一个自己同框了」). Categories without it (only 娱乐, 时尚, 话题互动, 二次元 etc.) are excluded.\n\n' +
        'updated_at (list version), at (fetch time), total, related (of which 「站内玩法」); items ranked, each with hot_id, rank, name, categories, heat_text, trend (up / down / new / flat; null when detail fetch failed), listed_at; effects + effects_leveled are reference only (measured always 0 — no signal on how many exist; check crowding with topic_crowd). No editor needed. Heat curve of one hotspot: douyin_hot_detail; Xiangsu hotspots: hot_topics.',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/douyin-hot')),
    },
    {
      name: 'douyin_hot_detail',
      keywords: '抖音 热点 详情 douyin hot detail',
      description: 'One Douyin hotspot in full (ops platform /api/agent/douyin-hot/:hot_id): rank, name, categories, heat, trend, listed_at, related (categories include 「站内玩法」), effects + effects_leveled (reference only), first_seen_at, and the verbatim platform detail (per-day days and per-hour hours heat points, effects_text, status_text). hot_id from douyin_hot_list.',
      shape: { hot_id: z.string().regex(/^\d+$/).describe('A hot_id from douyin_hot_list.') },
      run: async ({ hot_id }) => text(await d.platformRequest(`/api/agent/douyin-hot/${hot_id}`)),
    },
    {
      name: 'hit_reasons',
      keywords: '爆款 倒推 为什么想玩 hits',
      description: 'Reverse-engineered why people play the hits (ops platform /api/agent/hits, daily) — the first step of ideation.\n\n' +
        'items: top 20 of the youth-favour, daily-publish, play-interaction and follow-shoot boards plus the 20 newest official picks, deduped (multi-board entries first): name, app_effect_id, effect_id, icon, boards (young / publish / play / follow with rank per board), publishes, platform category, the 10 highest-liked user videos (title, likes, follow-shoots, author, cover cover_url, play video_url), and AI summary ai (why people play, hook — one of: about self or people around / hands-on with instant feedback / suspense, varying outcomes / riding a live emotion or meme; evidence quotes video titles; how_shot = how users shoot); ai.patterns: what the hits share.\n\n' +
        'The AI part is inference (inference=true) from video titles only; to see how users really shoot, hand covers to image_view or fetch videos with effect_videos.',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/hits')),
    },
    {
      name: 'inspirations_new',
      keywords: '灵感 新增 创新 inspirations new',
      description: 'Ops platform (/api/agent/inspirations): newly appeared inspirations (last 14 d) and all active 【创新】 inspirations, with parsed incentive deadlines, co-bind tasks (check open=true and !expired before binding), rewards, and reference images. Full inspiration details: inspiration_detail.',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/inspirations')),
    },
    {
      name: 'inspirations_find',
      keywords: '灵感 找 题材 inspirations find',
      description: 'Ops platform (/api/agent/inspirations/find, no editor needed): search all active inspirations (【创新】/hotspot/plain) by space-separated topic words q (≤40 items, prioritized by 【创新】 and active incentives) with play description, incentive deadline, and co-bind tasks. Delisted inspirations: inspiration_search.',
      shape: {
        q: z.string().trim().max(30).optional().describe('Topic words, space-separated, such as 「前任 撤回」 or 「火锅」.'),
        kind: z.enum(['innovation', 'hotspot', 'plain']).optional().describe('Only one kind: innovation 【创新】, hotspot (attached to a hotspot), plain.'),
      },
      run: async ({ q, kind }) => {
        const p = new URLSearchParams();
        if (q) p.set('q', q);
        if (kind) p.set('kind', kind);
        return text(await d.platformRequest(`/api/agent/inspirations/find${p.size ? `?${p}` : ''}`));
      },
    },
    {
      name: 'tasks_open',
      keywords: '任务 开放 截止 tasks open',
      description: 'Every activity-centre task not yet closed (ops platform /api/agent/open-tasks, every 12 h): task_id, item_id (for task_detail), kind (task collection / activity), title, status, received-or-not, tags, released_at, offline_at deadline, is_new (published within 7 days), same_type_clause, requirements to check one by one before binding (verbatim lines on submission type / theme / config requirements / non-compliance from 「任务说明」 and 「参与要求」; null before detail fetch), inspirations the incentive asks to co-bind (unexpired ones: inspiration_id, title, cover, deadline), and ours (works we placed: name, rating state, platform track). Newest releases first.\n\n' +
        'Prize details and inspiration notes verbatim: task_requirements; only the tasks we placed works under: task_usage.',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/open-tasks')),
    },
    {
      name: 'task_requirements',
      refs: true,
      keywords: '任务 要求 说明 requirements',
      description: 'One task full notes (ops platform /api/agent/tasks/{item_id}/requirements, no editor needed): title, deadline, same-type clauses, fetched-at at, and content — blocks each with block name, title and verbatim text (任务说明, 参与要求, 奖项详情, 灵感玩法, ...). Check task requirements one by one against it before binding; reference images and recommended works inside blocks: task_detail. Only unclosed tasks and tasks we bound have details; otherwise the reply is an error.',
      shape: { item_id: z.string().regex(/^\d+$/).describe('An item_id from tasks_open.') },
      run: async ({ item_id }) => text(await d.platformRequest(`/api/agent/tasks/${item_id}/requirements`)),
    },
    {
      name: 'topic_crowd',
      keywords: '题材 扎堆 查重 topic crowd',
      description: 'How crowded a topic already is (ops platform /api/agent/topic): searches effects and templates (two pages each), works whose title shares half its adjacent character pairs with the topic. Returns matched count, effects, templates, top by publishes, label (扎堆 ≥6 / 很少 ≤2 / 有人做), searched-at at. A 24-hour cache; a miss hands the query to the collector — up to 60 s wait, then status=pending and ask again.',
      shape: { q: z.string().trim().min(1).max(30).describe('Topic words, such as 「前任撤回」 or 「冬眠」.') },
      run: async ({ q }) => {
        let r = await d.platformRequest('/api/agent/topic', 'POST', { q });
        for (let waited = 0; r.status === 'pending' && waited < TOPIC_WAIT_MS; waited += TOPIC_POLL_MS) {
          await d.sleep(TOPIC_POLL_MS);
          r = await d.platformRequest(`/api/agent/topic?q=${encodeURIComponent(q)}`);
        }
        return text(r);
      },
    },
    {
      name: 'effect_detail',
      refs: true,
      keywords: '特效 详情 数据 effect detail',
      description: 'Full detail of any published effect or template (the mobile effect-detail endpoint; others works too): name, kind, effect_id, online date, level_code, cumulative publishes / likes / comments (page text), youth + male favour, play score, gender split, audience (age, gender), style (e.g. 潮酷), platform category (e.g. 「社交测试」, 「美妆」), source tool, traffic state, editor functions (e.g. 美瞳, 屏幕液化, 3D 模型动画, 辉光, 滤镜 — how hits combine), designer + level, icon icon_ref, a few sample videos (video_ref + cover cover_ref).\n\n' +
        'category, functions, designer, likes/comments are sometimes missing server-side (flaky even back-to-back on the same effect) — null then, retry later; unparsable fields land in unread. Videos shot with it: effect_videos; project: works_by_effect.',
      shape: { ...target, app_effect_id: z.string().regex(/^\d+$/).describe('The Douyin-side ID: an app_effect_id from rank_list / rank_subject_detail / rank_innovation / effect_search / pipeline_works.') },
      run: community('effect_detail'),
    },
    {
      name: 'effect_videos',
      refs: true,
      keywords: '视频 用户怎么拍 跟拍 effect videos',
      description: 'Douyin videos shot with one effect (the mobile work-detail video card; others works too): cumulative likes and follow-shoots (page text), plus the popular videos videos (measured 5): Douyin item_id, title, author, likes, follow-shoots, cover cover_ref and video video_ref (hand to image_view for addresses). Learn how people shoot and what captions they write. A just-online effect nobody has shot yet returns an empty list.',
      shape: {
        ...target,
        effect_id: z.string().regex(/^\d+$/).describe('The effect ID (from rank_list, effect_search, pipeline_works, ...).'),
        app_effect_id: z.string().regex(/^\d+$/).describe('The same effect app_effect_id.'),
      },
      run: community('effect_videos'),
    },
    {
      name: 'effect_search',
      refs: true,
      keywords: '特效 搜索 全平台 effect search',
      description: `Keyword search over all published effects or templates (the mobile search endpoint): effect_id, app_effect_id, name, description, level_code, youth favour, cumulative publishes (page text), icon icon_ref. Effects page up to 100 items; ≤${SEARCH_MAX} per page, cursor paging. The server fixes the order — top entries are old high-publish effects; no sort parameter exists (tried sort_type / order_by / sort and 9 more spellings 2026-11-09, order never changed) — for what is hot now use rank_list / rank_subjects. Homepage projects only: works_search. Next on an effect: effect_detail, effect_videos, works_by_effect. Inspirations: inspiration_search; tutorials: tutorial_search.`,
      shape: {
        ...target,
        query: z.string().min(1).describe('Keyword, such as 「美妆」, 「测一测」, 「变装」.'),
        kind: z.enum(EFFECT_SEARCH_KINDS).optional().describe('effect (default), template.'),
        cursor: z.number().int().min(0).optional().describe('Page cursor; take the previous page next_cursor.'),
        count: z.number().int().min(1).max(SEARCH_MAX).optional().describe(`Items per page, default ${SEARCH_MAX} (max ${SEARCH_MAX}; more errors server-side).`),
      },
      run: community('effect_search'),
    },
    {
      name: 'inspiration_search',
      refs: true,
      keywords: '灵感 搜索 inspiration search',
      description: `Keyword search over inspirations (the mobile search endpoint; inspiration_list only pages by tab): fields as inspiration_list. Cursor paging, ≤${SEARCH_MAX} per page.`,
      shape: {
        ...target,
        query: z.string().min(1).describe('Keyword, such as 「美妆」, 「测一测」, 「变装」.'),
        cursor: z.number().int().min(0).optional().describe('Page cursor; take the previous page next_cursor.'),
        count: z.number().int().min(1).max(SEARCH_MAX).optional().describe(`Items per page, default ${SEARCH_MAX} (max ${SEARCH_MAX}; more errors server-side).`),
      },
      run: community('inspiration_search'),
    },
    {
      name: 'tutorial_search',
      refs: true,
      keywords: '教程 搜索 tutorial search',
      description: `Keyword search over official tutorials (the mobile search endpoint): fields as tutorials_list. Cursor paging, ≤${SEARCH_MAX} per page.`,
      shape: {
        ...target,
        query: z.string().min(1).describe('Keyword, such as 「美妆」, 「测一测」, 「变装」.'),
        cursor: z.number().int().min(0).optional().describe('Page cursor; take the previous page next_cursor.'),
        count: z.number().int().min(1).max(SEARCH_MAX).optional().describe(`Items per page, default ${SEARCH_MAX} (max ${SEARCH_MAX}; more errors server-side).`),
      },
      run: community('tutorial_search'),
    },
    {
      name: 'tutorials_list',
      refs: true,
      keywords: '教程 官方 列表 tutorials',
      description: 'Official tutorials (the mobile 「教程」 endpoints): every call carries all tabs (effects: 新手入门, 特效进阶, 精选课程, PC工具, 工程实操, 三方工具, 爆款分享, 账号运营, 视频教程; templates: 模板入门, 模板进阶, ...); with tab_id, one tab; without, everything (about 190 — more than the tabs sum).\n\n' +
        'Per tutorial: title, tags (e.g. 「新手必看」, 「拍视频脚本」), learners, author, release date, paid-or-not, doc link (Feishu docs — need a Feishu login, agents cannot read the body, only title and tags), cover cover_ref, and video video_ref on video tutorials (the address image_view returns opens directly). Paged by offset / count. Search: tutorial_search.',
      shape: {
        ...target,
        tab_id: z.number().int().optional().describe('A tab_id from the reply tabs; omitted, all tutorials.'),
        ...pageShape,
      },
      run: community('tutorials_list'),
    },
    {
      name: 'shoot_scripts',
      refs: true,
      keywords: '拍摄脚本 玩法 shoot scripts',
      description: `Official shooting scripts (the mobile 「拍摄脚本」 endpoint): how to shoot an effect (e.g. 「【测一测】表演有梗结果」, 「【美妆】带特效前后反差」) — script ID, name, full description description (script read-out and the 「尝试拍一个」 how-to), tags tags, views views, shoots shoots, cover cover_ref, demo video video_ref. Tag codes: ${SCRIPT_TAG_TEXT}. type is the platform script-type code (1 mostly 技巧合集, 2 mostly 具体演绎). ≤${SCRIPT_MAX} per page by offset / count.`,
      shape: {
        ...target,
        tag: z.coerce.number().int().optional().describe(`Tag code (integer, "3" works too): ${SCRIPT_TAG_TEXT}; omitted, all.`),
        offset: z.number().int().min(0).optional().describe('Paging start; take the previous page next_offset. Default 0.'),
        count: z.number().int().min(1).max(SCRIPT_MAX).optional().describe(`Items per page, default 20 (max ${SCRIPT_MAX}).`),
      },
      run: community('shoot_scripts'),
    },
    {
      name: 'music_categories',
      keywords: '音乐 分类 music categories',
      description: 'Douyin music library categories (像塑原创, 推荐, 抖音收藏, 潮流心选, ...) with their codes; feed a code to music_list.',
      shape: { ...target },
      run: community('music_categories'),
    },
    {
      name: 'music_list',
      refs: true,
      keywords: '音乐 列表 分类 music list',
      description: 'One page (about 35 tracks, cursor paging) of a music library category: music_id, title, author, duration_sec, cover cover_ref, preview preview_ref (audio reference), has_copyright (false or null: do not use in effects meant for publishing), next_cursor, has_more. Category code from music_categories; search: music_search.',
      shape: { ...target, category_code: z.string().min(1).describe('A category code from music_categories.'), cursor: musicCursor },
      run: async ({ project_path, instance_id, category_code, cursor }) => text(seenMusic.keep(await d.callPlugin('music_list', { category_code, ...(cursor === undefined ? {} : { cursor }) }, await homeWindow({ project_path, instance_id })), { category_code })),
    },
    {
      name: 'music_search',
      refs: true,
      keywords: '音乐 搜索 music search',
      description: 'Search the Douyin music library by keyword — one page (about 35 tracks, cursor paging): music_id, title, author, duration_sec, cover cover_ref, preview preview_ref, has_copyright (false or null: not for publishing), next_cursor, has_more.',
      shape: { ...target, query: z.string().min(1).describe('Search keyword.'), cursor: musicCursor },
      run: async ({ project_path, instance_id, query, cursor }) => text(seenMusic.keep(await d.callPlugin('music_search', { query, ...(cursor === undefined ? {} : { cursor }) }, await homeWindow({ project_path, instance_id })), { category_code: null })),
    },
    {
      name: 'music_apply',
      keywords: '音乐 使用 设置 music apply',
      description: 'Set a Douyin track as the effect music — the music library 「使用」 button: downloads the audio into the project, writes the music info, and adds a Douyin music object to the scene (applying again replaces the previous track). start_sec / end_sec cut a segment; the full track by default. music_id from this session music_list / music_search. Then capture_preview to verify, save_project to persist.',
      shape: {
        ...target,
        music_id: z.string().min(1).describe('A music_id from music_list / music_search.'),
        start_sec: z.number().min(0).optional().describe('Segment start (s), default 0.'),
        end_sec: z.number().positive().optional().describe('Segment end (s), default full duration.'),
      },
      run: async (a) => {
        const { project_path, instance_id, music_id, start_sec, end_sec } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        const m = seenMusic.get(music_id);
        const params = { item: m.raw, ...(m.category_code ? { category_code: m.category_code } : {}), ...(start_sec === undefined ? {} : { start_sec }), ...(end_sec === undefined ? {} : { end_sec }) };
        return text(await d.callPlugin('music_apply', params, { projectPath, timeoutMs: 180000 }));
      },
    },
    {
      name: 'scene_tree',
      keywords: '场景 结构 树 对象 scene tree',
      description:
        'The scene structure as compact indented text: render groups and, per object, guid, name, hidden state, component types. More readable than the official get_scene JSON — use it for a first look, then inspect_many for parameters; raw JSON via get_scene.\n\n' +
        'subtree narrows to one object: guid, name, or hierarchical path (subtree of the render-group name, or trailing segments only, such as 「2D 前景/2D 摄像机」; ambiguous names report AMBIGUOUS_OBJECT with the candidates), depth caps depth (default 6; unexpanded children are counted). project_dir reads a downloaded project directory directly, no window (Assets/main.scene and its .extra; objects keyed by #index; component types as the editor shows them; no render-group layer). save_to saves the text to that directory as scene_tree.txt.',
      shape: {
        ...target,
        project_dir: z.string().min(1).optional().describe('Read this project directory directly, no window; ignores project_path / instance_id.'),
        subtree: z.string().min(1).optional().describe('Only this object and its subtree: guid (project_dir mode: #index), name, or hierarchical path.'),
        depth: z.number().int().min(1).max(30).optional().describe('Depth cap, default 6.'),
        save_to: saveTo,
      },
      run: async (a) => {
        const { project_dir, subtree, depth = 6, save_to } = a;
        let out;
        let warn = null;
        if (project_dir) {
          const scene = loadScene(project_dir);
          out = formatObjects(scene.tree({ subtree, depth }));
          warn = unreadableNote(scene);
        } else {
          const instance_id = await officialInstance(a);
          let guid;
          if (subtree) {
            const hit = resolveObject(sceneObjects(await namesTree(instance_id)), subtree);
            if (!hit) throw Error(`SUBTREE_NOT_FOUND: no scene object ${subtree} (guid, name or path)`);
            guid = hit.guid;
          }
          out = formatTree(await d.official.callJson('get_scene', { instance_id, summary: false, depth, ...(guid ? { subtree: guid } : {}), intention: '读取场景结构' }));
        }
        out = out || '（场景为空）';
        const saved = save_to ? saveFile(save_to, 'scene_tree.txt', out) : null;
        return { content: [{ type: 'text', text: [out, warn, saved && `已保存：${saved}`].filter(Boolean).join('\n\n') }] };
      },
    },
    {
      name: 'inspect_many',
      keywords: '查看 参数 组件 批量 inspect',
      description: 'Inspect multiple objects in one call (by guid, name, or path; or #index with project_dir offline). Unwraps values, resolves bound resources/objects, and names makeup blend modes. Filter with component_types, fields (substring match), or preset="key" (transform/visibility/intensity/color/text/resources/script params).',
      shape: {
        ...target,
        project_dir: z.string().min(1).optional().describe('Read this project directory directly, no window; ignores project_path / instance_id.'),
        guids: z.array(z.string().min(1)).min(1).max(40).describe('Objects to inspect: guid (from scene_tree / get_scene; project_dir mode: #index), name, or hierarchical path. With a window, component / resource guids also pass through.'),
        component_types: z.array(z.string().min(1)).min(1).optional().describe('Keep only these component types.'),
        fields: z.array(z.string().min(1)).min(1).optional().describe('Keep only properties whose name contains any of these fragments.'),
        preset: z.enum(['key']).optional().describe('key: keep the usually-deciding parameters (see description).'),
        save_to: saveTo,
      },
      run: async (a) => {
        const { project_dir, guids, component_types, fields, preset, save_to } = a;
        const pick = { component_types, fields, preset };
        const out = [];
        let warn = null;
        if (project_dir) {
          const scene = loadScene(project_dir);
          warn = unreadableNote(scene);
          for (const guid of guids) {
            try {
              out.push(dropUnset(pickInspect(scene.inspect(guid), pick), pick));
            } catch (e) {
              out.push({ guid, error: String(e.message ?? e) });
            }
          }
        } else {
          const instance_id = await officialInstance(a);
          const root = await projects.resolveProjectPath({ instance_id });
          const inspect = (guid) => d.official.callJson('inspect', { instance_id, guid, intention: '批量查看对象参数' });
          const objects = sceneObjects(await namesTree(instance_id));
          const cache = new Map();
          for (const ref of guids) {
            try {
              // Not an object of the tree: a component or resource guid, passed on as given.
              const guid = resolveObject(objects, ref)?.guid ?? ref;
              out.push(dropUnset(await resolveRefs(pickInspect(await inspect(guid), pick), inspect, { root, cache }), pick));
            } catch (e) {
              out.push({ guid: ref, error: String(e.message ?? e) });
            }
          }
        }
        const res = text(out);
        if (warn) res.content.push({ type: 'text', text: warn });
        if (save_to) res.content.push({ type: 'text', text: `已保存：${saveFile(save_to, 'inspect_many.json', res.content[0].text)}` });
        return res;
      },
    },
    {
      name: 'makeup_layers',
      keywords: '美妆 妆容 层 拆解 makeup layers',
      description: 'Inspect all makeup layers in a saved project scene file (FaceMask, FaceMaskDY, EyeColorV2): region, part, color/HSL, female/male/opacity strengths, texture_source (AI 妆容 / 素材广场 / 官方素材包 / local), active state, groups, and absent parts. Call save_project first for an open project.',
      shape: {
        project_dir: z.string().min(1).describe('Absolute path of the project directory (contains Assets/main.scene), e.g. a works_download project_path or your own project.'),
        save_to: saveTo,
      },
      run: async ({ project_dir, save_to }) => {
        const res = text(makeupLayers(project_dir));
        if (save_to) res.content.push({ type: 'text', text: `已保存：${saveFile(save_to, 'makeup_layers.json', res.content[0].text)}` });
        return res;
      },
    },
    {
      name: 'makeup_compare',
      keywords: '妆容 对比 调强度 makeup compare',
      description: `A/B compare temporary makeup/contact/filter or numeric component-property variants on a still-photo preview video: shoots baseline, applies each variant live, shoots zoomed side-by-side crops + RGB/HSL/luma/detail deltas (and optional to_reference deltas), then reverts all changes. Warns if baseline drifts >${DRIFT_MEAN}.`,
      shape: {
        ...target,
        variants: z
          .array(
            z.strictObject({
              label: z.string().min(1).max(20),
              changes: z
                .array(
                  z.union([
                    z.strictObject({
                      object_path: z.string().min(1).describe('Hierarchical path of the makeup layer, contact or filter object (or uniquely-identifying trailing segments).'),
                      female: z.number().min(0).max(1).optional(),
                      male: z.number().min(0).max(1).optional(),
                      intensity: z.number().min(0).max(1).optional().describe('Makeup layer: panel opacity; contacts and filters: intensity.'),
                    }),
                    z.strictObject({
                      object_path: z.string().min(1).describe('Object guid, name or hierarchical path (like inspect_many).'),
                      component: z.string().min(1).describe('Component type name, e.g. GanComponent, PostProcess.'),
                      property: z.string().min(1).describe('Property name, dotted when nested, e.g. Transparency, bloom.pBloomIntensity.'),
                      value: z.union([z.number(), z.boolean()]),
                    }),
                  ]),
                )
                .min(1)
                .max(40),
            }),
          )
          .min(1)
          .max(MAX_COMPARE_VARIANTS),
        regions: z
          .array(z.strictObject({ label: z.string().min(1).max(20), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().gt(0).max(1), height: z.number().gt(0).max(1), ref: refBox }))
          .min(1)
          .max(MAX_COMPARE_REGIONS)
          .optional()
          .describe('Regions as frame fractions (model eye positions differ — a fixed fraction box shifts between models; re-give boxes per model from a screenshot). Either this or preset_regions.'),
        preset_regions: z.enum(['H', 'G']).optional().describe('Use the makeup_light_metrics H/G sample boxes as regions; either this or regions.'),
        reference: z.string().min(1).optional().describe('Reference image (PNG / JPEG) absolute path; used together with region ref boxes.'),
        videos: z.array(z.string().min(1)).min(1).max(MAX_FRAME_VIDEOS).optional().describe('Preview video names in order (video_name from preview_videos); omitted, the current video.'),
        tracking_type: z.string().min(1).optional().describe('The tracking_type of videos, default face.'),
        at_ms: z.number().int().min(0).max(20000).optional().describe(`How long to play after the reset before the baseline (ms), default ${HOLD_AT_MS} (AI face changes need a moment to fully apply).`),
        zoom: z.number().int().min(1).max(8).optional().describe('Side-by-side zoom, default 3.'),
        save_to: saveTo,
      },
      run: async (a) => {
        const { variants, reference, videos, tracking_type = 'face', at_ms = HOLD_AT_MS, zoom = 3, save_to } = a;
        let regions = a.regions;
        if (a.preset_regions) {
          if (regions?.length) throw Error('REGIONS_AND_PRESET: pass regions or preset_regions, not both');
          regions = lightPresetRegions(a.preset_regions, 720, 1280).map(({ label, x, y, width, height }) => ({ label, x, y, width, height }));
        }
        if (!regions?.length) throw Error('REGIONS_REQUIRED: pass regions or preset_regions');
        if (!reference !== !regions.some((r) => r.ref)) throw Error(reference ? 'REFERENCE_UNUSED: give ref boxes on the regions to compare with the reference' : 'REFERENCE_MISSING: regions give ref boxes but no reference image');
        const ref = reference ? await loadImage(reference) : null;
        const instance_id = await officialInstance(a);
        const projectPath = await projects.resolveProjectPath({ instance_id });
        const dir = save_to ? saveDir(save_to) : d.framesDir();
        // Component changes are resolved to component guids before the preview is touched.
        const isComponent = (c) => 'component' in c;
        const guids = new Map();
        if (variants.some((v) => v.changes.some(isComponent))) {
          const objects = sceneObjects(await namesTree(instance_id));
          for (const c of variants.flatMap((v) => v.changes).filter(isComponent)) {
            const key = `${c.object_path}|${c.component}`;
            if (guids.has(key)) continue;
            const obj = resolveObject(objects, c.object_path);
            if (!obj) throw Error(`OBJECT_NOT_FOUND: ${c.object_path}`);
            const all = (await d.official.callJson('inspect', { instance_id, guid: obj.guid, intention: '找要临时改的组件' })).components || [];
            const hits = all.filter((x) => x.type === c.component);
            if (hits.length !== 1) throw Error(`${hits.length ? 'AMBIGUOUS_COMPONENT' : 'COMPONENT_NOT_FOUND'}: ${c.object_path} has ${hits.length} ${c.component} components; its components are ${all.map((x) => x.type).join(', ')}`);
            guids.set(key, hits[0].guid);
          }
        }
        const runs = await eachVideo(instance_id, videos, tracking_type, (video) =>
          onPlayingPreview(projectPath, at_ms, async () => {
            const frames = [await pngFrame(projectPath)];
            for (const v of variants) {
              const masks = v.changes.filter((c) => !isComponent(c));
              const comps = v.changes.filter(isComponent).map((c) => ({ guid: guids.get(`${c.object_path}|${c.component}`), property: c.property, value: c.value }));
              const { before } = masks.length ? await makeupSet(projectPath, masks, `makeup_compare: ${v.label}`) : { before: [] };
              let undo = [];
              try {
                undo = await setComponents(instance_id, comps, `makeup_compare: ${v.label}`);
                await freshFrames(projectPath);
                frames.push(await pngFrame(projectPath));
              } finally {
                if (undo.length) await setComponents(instance_id, undo, 'makeup_compare: restore');
                if (before.length) await makeupSet(projectPath, before.map(restoreOf), 'makeup_compare: restore');
              }
            }
            await freshFrames(projectPath);
            const again = await pngFrame(projectPath);
            return { video, frames, again };
          }),
        );
        const labels = ['基线', ...variants.map((v) => v.label)];
        const out = [];
        const content = [];
        for (const [k, { video, frames, again }] of runs.entries()) {
          const prefix = videos ? `v${k + 1}-` : '';
          const regionsOut = regions.map((given, j) => {
            const r = given;
            const states = frames.map((f, i) => ({ label: labels[i], ...regionStats(f, r) }));
            const base = states[0];
            for (const s of states.slice(1)) {
              s.delta = { rgb: s.rgb.map((v, c) => Number((v - base.rgb[c]).toFixed(1))), luma: Number((s.luma - base.luma).toFixed(1)), detail: Number((s.detail - base.detail).toFixed(2)) };
            }
            const target = given.ref ? regionStats(ref, given.ref) : null;
            if (target) {
              for (const s of states) s.to_reference = { rgb: s.rgb.map((v, c) => Number((v - target.rgb[c]).toFixed(1))), luma: Number((s.luma - target.luma).toFixed(1)), detail: Number((s.detail - target.detail).toFixed(2)) };
            }
            const drift = frameDiff(frames[0], again, r);
            // Deltas are rounded to 0.1, so all zeros means no variant moved the box's average at all.
            const unchanged = states.length > 1 && states.slice(1).every((s) => s.delta.luma === 0 && s.delta.rgb.every((v) => v === 0));
            const file = path.join(dir, `${prefix}compare-${j + 1}.png`);
            fs.writeFileSync(file, sideBySide([...frames.map((img) => ({ img, box: r })), ...(target ? [{ img: ref, box: given.ref }] : [])], zoom));
            const box = pixelBox(frames[0], r);
            return {
              label: given.label,
              box_px: [box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0],
              states,
              ...(target ? { reference: target } : {}),
              drift,
              ...(drift.mean > DRIFT_MEAN ? { warning: '前后两次基线不一样，这期间画面自己在变（会动的视频或自带动画的特效），各状态之间的差别不全是改动造成的' } : {}),
              ...(unchanged ? { note: '所有状态在这个区域都和基线完全一样：框可能压在贴纸或别的遮挡上，或者框到了这些改动画不到的地方，看并排图核对框的位置' } : {}),
              image: file,
            };
          });
          out.push({ video, regions: regionsOut });
          for (const [j, r] of regionsOut.entries()) {
            content.push({ type: 'text', text: `${video ? `${video} ` : ''}${r.label}：${[...labels, ...(regions[j].ref ? ['参考'] : [])].join(' | ')}` });
            content.push({ type: 'image', ...(await d.readImageFile(r.image)) });
          }
        }
        const summary = { states: labels, runs: out, ...(save_to ? {} : { note_files: '临时文件，24 小时后删除；要留存请传 save_to' }), note: '所有改动都已改回；工程可能显示「已修改」，不需要的话不用保存' };
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }, ...content] };
      },
    },
    {
      name: 'preview_videos',
      keywords: '预览视频 名单 preview videos',
      description: 'Available preview video names grouped by tracking_type (face, two_person, body, hand, pet, environment), plus the current video: names only, for picking the videos of preview_frames / makeup_compare and the official set_preview_video video_name. Full fields (URLs, local files): the official list_preview_videos (about 70 KB).',
      shape: { ...target, tracking_type: z.string().min(1).optional().describe('Only this type, e.g. face; omitted, all.') },
      run: async (a) => {
        const instance_id = await officialInstance(a);
        const all = await d.official.callJson('list_preview_videos', { instance_id, intention: '列出预览视频名' });
        const groups = all.videos || {};
        if (a.tracking_type !== undefined && !Object.prototype.hasOwnProperty.call(groups, a.tracking_type)) throw Error(`INVALID_TRACKING_TYPE: ${a.tracking_type}; valid: ${Object.keys(groups).join(', ')}`);
        const pick = a.tracking_type === undefined ? Object.keys(groups) : [a.tracking_type];
        return text({
          current: all.current ? { tracking_type: all.current.tracking_type, video_name: all.current.video_name ?? null } : null,
          videos: Object.fromEntries(pick.map((k) => [k, groups[k].map((v) => v.video_name)])),
        });
      },
    },
    {
      name: 'preview_frames',
      keywords: '截图 连续 帧 预览 preview frames',
      description: 'Capture preview frames over time at the preview resolution (720×1280; the official screenshot is the downscaled 320×569), taken from the render output — works while the window is minimized (frame rate is raised temporarily during the shots). By default: reset the preview, wait for the reloaded frame, then shoot count frames (≤24 per call) every interval_ms — for motion, head-shakes, side profiles.\n\n' +
        'videos switches through several preview videos, one group each (names from preview_videos, e.g. preview_single_shake_head||女), switching back after; the editor then writes the video back into the project info, so a previously clean project stays clean (noted in note). crop trims a region by frame fractions (0–1), e.g. the face. Every frame is saved and returned; files carries the paths — paste them to the user directly. Temp directory by default (24 h); save_to keeps them. Each frame notes the capture time (ms since the reset finished).',
      shape: {
        ...target,
        count: z.number().int().min(1).max(12).optional().describe('Frames per video, default 4.'),
        interval_ms: z.number().int().min(100).max(10000).optional().describe('Gap between frames (ms), default 700.'),
        videos: z.array(z.string().min(1)).min(1).max(MAX_FRAME_VIDEOS).optional().describe('Preview video names in order (video_name from preview_videos); omitted, the current video.'),
        tracking_type: z.string().min(1).optional().describe('The tracking_type of videos, e.g. face, body, hand; default face.'),
        reset: z.boolean().optional().describe('Reset the preview before each group, default true.'),
        crop: z
          .object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            width: z.number().gt(0).max(1),
            height: z.number().gt(0).max(1),
          })
          .optional()
          .describe('Crop region as frame fractions, top-left (0, 0).'),
        save_to: saveTo,
      },
      run: async (a) => {
        const { count = 4, interval_ms = 700, videos, tracking_type = 'face', reset = true, crop, save_to } = a;
        const total = count * (videos ? videos.length : 1);
        if (total > MAX_FRAMES) throw Error(`TOO_MANY_FRAMES: ${total} frames asked, at most ${MAX_FRAMES} per call`);
        const instance_id = await officialInstance(a);
        const projectPath = await projects.resolveProjectPath({ instance_id });
        const dir = save_to ? saveDir(save_to) : d.framesDir();
        const frame = (name) => d.callPlugin('preview_frame', {}, { projectPath, timeoutMs: 15000 }).then((img) => ({ name, img }));
        const shoot = async (prefix) => {
          await holdFullRate(projectPath, RESET_TIMEOUT_MS + count * interval_ms + HOLD_SLACK_MS);
          if (reset) await resetPreview(projectPath);
          const t0 = Date.now();
          const shots = [];
          for (let i = 0; i < count; i++) {
            if (i) await d.sleep(Math.max(0, t0 + i * interval_ms - Date.now()));
            const at = Date.now() - t0;
            shots.push({ ...(await frame(`${prefix}frame-${i + 1}.jpg`)), at });
          }
          return shots;
        };
        const groups = [];
        let original = null;
        let wasChanged = null;
        try {
          if (videos) {
            wasChanged = (await d.callPlugin('project_state', {}, { projectPath, timeoutMs: 5000 })).changed;
            original = await d.official.callJson('get_current_preview_video', { instance_id, intention: '记下当前预览视频，截图后切回' });
            try {
              for (const [k, video_name] of videos.entries()) {
                await d.official.callJson('set_preview_video', { instance_id, tracking_type, video_name, intention: '临时切换预览视频截图' });
                groups.push({ video: video_name, shots: await shoot(`v${k + 1}-`) });
              }
            } finally {
              const back = original.video_name ? { video_name: original.video_name } : { resource_url: original.resource_url };
              await d.official.callJson('set_preview_video', { instance_id, tracking_type: original.tracking_type, ...back, intention: '截图后切回原预览视频' });
            }
          } else {
            groups.push({ video: null, shots: await shoot('') });
          }
        } finally {
          await releaseFullRate(projectPath);
        }
        // Switching back leaves the project unchanged only once the editor has written the last video
        // back, a moment later; a project that had changes before keeps them.
        let leftChanged = wasChanged;
        if (original && !wasChanged) {
          const end = Date.now() + PREVIEW_INFO_SETTLE_MS;
          for (;;) {
            leftChanged = (await d.callPlugin('project_state', {}, { projectPath, timeoutMs: 5000 })).changed;
            if (!leftChanged || Date.now() >= end) break;
            await d.sleep(500);
          }
        }
        const files = [];
        const content = [];
        for (const g of groups) {
          for (const [i, s] of g.shots.entries()) {
            const file = path.join(dir, s.name);
            fs.writeFileSync(file, Buffer.from(s.img.data, 'base64'));
            if (crop) await d.cropImage(file, crop);
            files.push(file);
            content.push({ type: 'text', text: `${g.video ? `${g.video} ` : ''}第 ${i + 1} 帧（${s.at} ms）` });
            content.push({ type: 'image', ...(await d.readImageFile(file)) });
          }
        }
        const summary = {
          frames: files.length,
          files,
          ...(save_to ? {} : { note_files: '临时文件，24 小时后删除；要留存请传 save_to' }),
          ...(original ? { note: `预览视频已切回 ${original.video_name || original.resource_url}${leftChanged ? (wasChanged ? '；工程在截图前就有未保存的改动' : '；工程仍显示「已修改」，需要 save_project') : '；工程没有因为切换变成「已修改」'}` } : {}),
        };
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }, ...content] };
      },
    },
    {
      name: 'editor_capabilities',
      keywords: '内置 能力 地图 组件 菜单 玩法 查能力 editor capabilities atlas functions',
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: 'Offline-queryable map of Xiangsu built-in editor capabilities (add-object menu, library panels, AI pipelines). Omit args for a compact overview by category; pass query/category for play-intent lookup (returns exact menu_id + how_to_add); pass from_functions to map competitor effect_detail.functions labels to editor menu_ids. Auto-caches live menu_list by editor version when a window is open.',
      shape: {
        ...target,
        query: z.string().trim().min(1).optional().describe('Keyword or play intent (CN/EN), e.g. 「整蛊」「宠物」「头部分割」「下雪」「涂鸦」.'),
        category: z.string().trim().min(1).optional().describe('Filter by menu group (Face, Body, 2DMenu, 3D, AIEffectMenu, Social, PetEffect, MusicEffect).'),
        from_functions: z.array(z.string().min(1)).min(1).max(30).optional().describe('Platform capability labels from effect_detail.functions / pick_samples to map to editor menu_ids.'),
        refresh: z.boolean().optional().describe('Force refresh from an open editor window into the versioned local cache.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max matched items for query/category search, default 25.'),
      },
      run: async ({ project_path, instance_id, query, category, from_functions, refresh = false, limit }) => {
        const snap = d.atlas.loadSnapshot();
        const shouldRefresh = refresh || (snap.source === 'baseline' && d.listInstances().length > 0);
        if (shouldRefresh) {
          try {
            const win = await homeWindow({ project_path, instance_id });
            const menu = await d.callPlugin('menu_list', { details: false }, win);
            if (Array.isArray(menu?.items)) d.atlas.recordMenu(menu.items);
            try {
              const nav = await d.callPlugin('library_nav', {}, win);
              if (Array.isArray(nav?.panels)) d.atlas.recordLibraryPanels(nav.panels);
            } catch (_) {}
          } catch (e) {
            if (refresh) throw e;
          }
        }
        if (from_functions?.length) return text(d.atlas.fromFunctions(from_functions));
        if (query || category) return text(d.atlas.search({ query, category, limit }));
        return text(d.atlas.overview());
      },
    },
    {
      name: 'menu_list',
      keywords: '添加对象 菜单 官方功能 menu',
      description: `List official 「添加对象」 menu items (menu_id, name, path, kind) from an open window. query filters by name/path/menu_id; details=true adds hover descriptions and demo images (≤${MAX_MENU_PREVIEW} matches). For offline overview or play-intent search, use editor_capabilities.`,
      shape: {
        ...target,
        query: z.string().optional().describe('Filter by Chinese name, path or menu_id, such as 「表情」, 「美容」, 「烟熏妆」.'),
        details: z.boolean().optional().describe(`Also return descriptions and demo images, default false; matches must be ≤${MAX_MENU_PREVIEW}.`),
      },
      run: async (a) => {
        const { project_path, instance_id, ...params } = a;
        const res = await d.callPlugin('menu_list', params, await homeWindow({ project_path, instance_id }));
        if (!params.query && !params.details && Array.isArray(res?.items)) {
          try { d.atlas.recordMenu(res.items); } catch (_) {}
        }
        return text(res);
      },
    },
    {
      name: 'menu_add',
      keywords: '添加对象 加 功能 menu add',
      description: 'Add one official menu object to the scene by menu_id — the same as picking it in the editor menu (undoable). kind=package items download the official package first. Returns added_objects (names + object_path).',
      shape: { ...target, menu_id: z.string().min(1).describe('A menu_id from menu_list.') },
      run: plugin('menu_add', 180000),
    },
    {
      name: 'ai_combine_new',
      keywords: 'AI 组合 工作流 新建 ai combine',
      description:
        "Create a new 「AI 组合效果」 AI workflow (the user photographs, the cloud renders images or video by the graph) — the AI effects window 「新建工作流」: builds the AI graph locally with just an 「输入图」 input node and an 「效果组合」 combination node, unconnected. No network, no quota, no cloud draft. Returns ai_graph_id and per-node node_id; edit it with the official get_workflow_context / get_workflow_capabilities / apply_workflow_patch (add image-generation nodes, write prompts, wire) — video-generation nodes the official tools cannot create: ai_video_node (apply_workflow_patch saves each change as a cloud AI draft under the account). To preview: official generate_workflow (spends quota). When done, ai_combine_apply places it into the scene.\n\n" +
        'The 「添加对象」 menu AI item only builds an empty shell — do not use menu_add.',
      shape: { ...target },
      run: plugin('ai_combine_new'),
    },
    {
      name: 'ai_combine_apply',
      keywords: 'AI 组合 应用 场景 ai combine apply',
      description:
        "Place an AI workflow into the scene — the AI effects window 「应用」 (undoable): the editor compiles the workflow, uploads the workflow file to the effect platform, and adds a 「AI 组合效果」 object (creating 「2D 前景」 and 「2D 摄像机」 too when the scene has no 2D foreground). No quota, no new draft; a workflow that generated a preview video uploads it for review as well. The editor refuses when the combination node lacks input wires etc., reporting AI_COMBINE_APPLY_FAILED with the editor message verbatim (e.g. 「请先连接效果组合器」). Returns added_objects (names + object_path) and draft_id (set when the workflow was saved as a cloud draft, else null). Then save_project.",
      shape: { ...target, graph_id: z.string().min(1).describe('An ai_graph_id from ai_combine_new or the official get_workflow_context.') },
      run: plugin('ai_combine_apply', 180000),
    },
    {
      name: 'ai_video_node',
      keywords: '图生视频 工作流 节点 ai video node',
      description:
        "Add or edit a 「视频生成」 node in an AI workflow — the AI effects window 「图生视频」 (Seedance: photo + prompt → a video clip); the official apply_workflow_patch can only create image-generation nodes.\n\n" +
        'Without node_id it creates one: initialized per the chosen model panel defaults, wired 「输入图」 → its first image port → its output into the combination node free port, placed between them (multiple input nodes: pass input_node_id; no free combination port: COMBINATION_PORT_TAKEN — both checked before any graph edit). With node_id it edits that node only; a model switch starts from the new model defaults, prompt carried over. Parameters follow the chosen model panel (Seedance 2.0 Mini: 5–15 s, 480p/720p; Seedance 2.5: 4–30 s, adds 1080p); invalid values error with the valid options. The graph is saved as a cloud draft like an official patch (saved; save_error names the reason). No generation, no quota.\n\n' +
        'Usual sequence: upload_workflow_image + apply_workflow_patch (update_node_params) to bind the input photo, generate_workflow to preview (spends model quota), ai_combine_apply to place. Returns node_id, created, model (id, name), params, and connected (when created).',
      shape: {
        ...target,
        graph_id: z.string().min(1).describe('An ai_graph_id from ai_combine_new or the official get_workflow_context.'),
        node_id: z.string().min(1).optional().describe('The video node to edit (a type=Video id in get_workflow_context); omitted, create one.'),
        model: z.string().min(1).optional().describe('Model display name: 「Seedance 2.0 Mini」, 「Seedance 2.0 Fast」, 「Seedance 2.0」, 「Seedance 2.5」. Creation defaults to Seedance 2.0 Mini; editing without it keeps the model. Unknown: UNKNOWN_VIDEO_MODEL with the options.'),
        prompt: z.string().min(1).optional().describe('Prompt: the scene and motion to generate. Required on creation.'),
        duration: z.number().positive().optional().describe('Video duration (s), per model; omitted, the model default (Mini: 10).'),
        aspect_ratio: z.string().min(1).optional().describe('Aspect ratio, e.g. 9:16, 16:9, 1:1; omitted, the model default (9:16).'),
        resolution: z.string().min(1).optional().describe('Resolution, e.g. 480p, 720p; omitted, the model default (480p).'),
        input_node_id: z.string().min(1).optional().describe('The input-image node to wire on creation; omit when the graph has exactly one.'),
      },
      run: plugin('ai_video_node', 120000),
    },
    {
      name: 'ai_video_results',
      keywords: '图生视频 结果 预览 ai video results',
      description:
        "Generation results of the 「视频生成」 node and its combination node (official generate_workflow succeeded; the official download_workflow_node_asset only reads image nodes): per node state state (waiting / success, ...) and generated videos videos — local files local_path (the editor AI preview cache copy, no watermark; a null when the cache was cleared, re-generate to get), width/height, duration duration_s. To view: ffmpeg frame extraction then image_view. Read-only, no network.",
      shape: { ...target, graph_id: z.string().min(1).describe('An ai_graph_id from ai_combine_new or the official get_workflow_context.') },
      run: plugin('ai_video_results'),
    },
    {
      name: 'ai_makeup',
      refs: true,
      keywords: 'AI 妆容 提取 记录 导入 建层 ai makeup submit tasks import',
      description: `Library 「AI 妆容」 pipeline: action=submit extracts 5 makeup textures (face, contacts, eye, lash, lip) from a portrait image (${AI_MAKEUP_IMAGE_LIMIT.exts.join('/').toUpperCase()}, ≤${AI_MAKEUP_IMAGE_LIMIT.maxMB} MB); action=tasks lists history or waits on one task_id; action=import imports a finished task into 「面部面具」 layers (fixes 9.8.x contacts EyeColorV2).`,
      shape: {
        ...target,
        action: z.enum(['submit', 'tasks', 'import']).describe('Operation: submit, tasks, or import.'),
        image_path: z.string().min(1).optional().describe('submit: absolute path of the reference portrait.'),
        task_id: z.string().min(1).optional().describe('tasks (optional single lookup) / import (required): task_id.'),
        wait_s: z.number().int().min(0).max(AI_MAKEUP_MAX_WAIT_S).optional().describe(`submit (default ${AI_MAKEUP_WAIT_S}) / tasks with task_id (default 0): max seconds to wait.`),
        cursor: z.number().int().min(0).optional().describe('tasks: page cursor (next_cursor).'),
        count: z.number().int().min(1).max(AI_MAKEUP_HISTORY_PAGE).optional().describe(`tasks: items per page, default ${AI_MAKEUP_HISTORY_PAGE}.`),
        parts: z.array(z.enum(['rest', 'pupil', 'eyepart', 'eyelash', 'lip'])).min(1).optional().describe('import: subset of parts (all 5 by default).'),
      },
      run: async (a) => {
        const { action, project_path, instance_id, image_path, task_id, wait_s, cursor, count, parts } = a;
        if (action === 'submit') {
          if (!image_path) throw Error('INVALID_ARGUMENTS(ai_makeup): image_path is required for action=submit');
          const ws = wait_s ?? AI_MAKEUP_WAIT_S;
          const got = await d.callPlugin('ai_makeup_submit', { image_path, wait_s: ws }, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: ws * 1000 + AI_MAKEUP_SLACK_MS });
          return text(nameBlends(got));
        }
        if (action === 'tasks') {
          const win = await homeWindow({ project_path, instance_id });
          if (task_id !== undefined) {
            const ws = wait_s ?? 0;
            return text(nameBlends(await d.callPlugin('ai_makeup_task', { task_id, wait_s: ws }, { ...win, timeoutMs: ws * 1000 + AI_MAKEUP_SLACK_MS })));
          }
          if (wait_s !== undefined) throw Error('INVALID_ARGUMENTS: wait_s only applies together with task_id');
          return text(nameBlends(await d.callPlugin('ai_makeup_tasks', { cursor, count }, win)));
        }
        if (!task_id) throw Error('INVALID_ARGUMENTS(ai_makeup): task_id is required for action=import');
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        return text(nameBlends(await d.callPlugin('ai_makeup_import', { task_id, ...(parts ? { parts } : {}) }, { projectPath, timeoutMs: AI_MAKEUP_IMPORT_TIMEOUT_MS })));
      },
    },
    {
      name: 'ai3d',
      refs: true,
      keywords: 'AI 3D 图生 动画 高精度 重建 高斯 模型 导入 取消 ai3d submit tasks import cancel',
      description: `Library 「AI 3D」 pipeline: submit_image (image→static GLB, ≤${AI3D_IMAGE_LIMIT.maxMB} MB), submit_animation (video→humanoid FBX, model=${Object.keys(AI3D_PRESET_MODELS).join('/')} or .fbx), gs_segment+gs_submit (360° video→3DGS .ply), tasks (list by kind or wait on task_id), import (place into scene), cancel.`,
      shape: {
        ...target,
        action: z.enum(['submit_image', 'submit_animation', 'gs_segment', 'gs_submit', 'tasks', 'import', 'cancel']).describe('Operation.'),
        image_path: z.string().min(1).optional().describe('submit_image: absolute path of the reference image.'),
        precision: z.enum(Object.keys(AI3D_FACE_NUM)).optional().describe(`submit_image: ${Object.entries(AI3D_FACE_NUM).map(([k, v]) => `${k}=${v}`).join(', ')}; default medium.`),
        video_path: z.string().min(1).optional().describe('submit_animation / gs_segment: absolute path of the reference video.'),
        model: z.string().min(1).optional().describe(`submit_animation: ${Object.keys(AI3D_PRESET_MODELS).join('/')} or local .fbx path; default whole.`),
        seg_task_id: z.string().min(1).optional().describe('gs_submit: seg_task_id returned by gs_segment.'),
        kind: z.enum(['image', 'animation', 'gs']).optional().describe('tasks (required when listing history) / import (required): image, animation, or gs.'),
        task_id: z.string().min(1).optional().describe('tasks (optional single) / import / cancel (required): task_id.'),
        wait_s: z.number().int().min(0).max(AI3D_MAX_WAIT_S).optional().describe(`gs_segment (min 10, default ${AI3D_SEGMENT_WAIT_S}) / tasks with task_id (default 0): max wait seconds.`),
        cursor: z.number().int().min(0).optional().describe('tasks: page cursor (next_cursor).'),
        count: z.number().int().min(1).max(AI3D_HISTORY_PAGE).optional().describe(`tasks: items per page, default ${AI3D_HISTORY_PAGE}.`),
      },
      run: async (a) => {
        const { action, project_path, instance_id, image_path, precision, video_path, model, seg_task_id, kind, task_id, wait_s, cursor, count } = a;
        if (action === 'submit_image') {
          if (!image_path) throw Error('INVALID_ARGUMENTS(ai3d): image_path is required for action=submit_image');
          return text(await d.callPlugin('ai3d_image_submit', { image_path, ...(precision ? { precision } : {}) }, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: AI3D_SUBMIT_TIMEOUT_MS }));
        }
        if (action === 'submit_animation') {
          if (!video_path) throw Error('INVALID_ARGUMENTS(ai3d): video_path is required for action=submit_animation');
          return text(await d.callPlugin('ai3d_animation_submit', { video_path, ...(model ? { model } : {}) }, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: AI3D_SUBMIT_TIMEOUT_MS }));
        }
        if (action === 'gs_segment') {
          if (!video_path) throw Error('INVALID_ARGUMENTS(ai3d): video_path is required for action=gs_segment');
          const ws = wait_s ?? AI3D_SEGMENT_WAIT_S;
          if (ws < 10) throw Error('INVALID_ARGUMENTS(ai3d): wait_s must be >= 10 for action=gs_segment');
          const got = await d.callPlugin('ai3d_gs_segment', { video_path, wait_s: ws }, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: AI3D_SUBMIT_TIMEOUT_MS + ws * 1000 });
          segments.set(got.seg_task_id, { subject_uri: got.subject_uri, req_json: got.req_json });
          return text({ seg_task_id: got.seg_task_id, subject_image_url: got.subject_image_url });
        }
        if (action === 'gs_submit') {
          if (!seg_task_id) throw Error('INVALID_ARGUMENTS(ai3d): seg_task_id is required for action=gs_submit');
          const seg = segments.get(seg_task_id);
          if (!seg) throw Error(`UNKNOWN_SEGMENT: ${seg_task_id}; call ai3d(action="gs_segment") first`);
          return text(await d.callPlugin('ai3d_gs_submit', seg, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: AI3D_SUBMIT_TIMEOUT_MS }));
        }
        if (action === 'tasks') {
          const win = await homeWindow({ project_path, instance_id });
          if (task_id !== undefined) {
            const ws = wait_s ?? 0;
            return text({ ...(kind ? { kind } : {}), ...(await d.callPlugin('ai3d_task', { task_id, wait_s: ws }, { ...win, timeoutMs: ws * 1000 + 30000 })) });
          }
          if (wait_s !== undefined) throw Error('INVALID_ARGUMENTS: wait_s only applies together with task_id');
          if (kind === undefined) throw Error('INVALID_ARGUMENTS: kind is required to list the history (image, animation or gs)');
          return text(await d.callPlugin('ai3d_tasks', { kind, cursor, count }, win));
        }
        if (action === 'import') {
          if (!task_id || !kind) throw Error('INVALID_ARGUMENTS(ai3d): task_id and kind are required for action=import');
          return plugin('ai3d_import', AI3D_IMPORT_TIMEOUT_MS)({ project_path, instance_id, task_id, kind });
        }
        if (!task_id) throw Error('INVALID_ARGUMENTS(ai3d): task_id is required for action=cancel');
        return text(await d.callPlugin('ai3d_cancel', { task_id }, await homeWindow({ project_path, instance_id })));
      },
    },
    {
      name: 'ar_video',
      keywords: 'AR 视频 贴片 生成 任务 导入 取消 ar video submit tasks import cancel',
      description: 'Library 「AI 素材 › AR 视频」 pipeline: action=submit generates an AR cutout video plane (mode=direct cuts out a video, mode=motion generates new motion from prompt+refs, spends quota); action=tasks lists/waits (succeeded returns 6-frame preview_image_file); action=import places AR plane+audio into scene; action=cancel.',
      shape: {
        ...target,
        action: z.enum(['submit', 'tasks', 'import', 'cancel']).describe('Operation: submit, tasks, import, or cancel.'),
        subject: z.string().min(1).optional().describe('submit: absolute path of subject image or video.'),
        mode: z.enum(AR_VIDEO_MODES).optional().describe('submit: direct (video cutout only) or motion (prompt-driven).'),
        prompt: z.string().optional().describe('submit: motion description (required for mode=motion, forbidden for direct).'),
        reference_images: z.array(z.string().min(1)).min(1).optional().describe('submit: reference image paths (mode=motion).'),
        reference_video: z.string().min(1).optional().describe('submit: reference action video path (mode=motion).'),
        shadow: z.boolean().optional().describe('submit: 「添加投影」; usually false for front-camera selfie effects.'),
        duration_s: z.number().int().positive().optional().describe('submit: duration in seconds (default 10; range in tasks limits).'),
        task_id: z.string().min(1).optional().describe('tasks (optional single) / import / cancel (required): task_id.'),
        wait_s: z.number().int().min(0).max(AR_VIDEO_MAX_WAIT_S).optional().describe(`tasks with task_id: max wait seconds (max ${AR_VIDEO_MAX_WAIT_S}).`),
        offset: z.number().int().min(0).optional().describe('tasks: paging offset, default 0.'),
        count: z.number().int().min(1).max(AR_VIDEO_HISTORY_PAGE).optional().describe(`tasks: items per page, default ${AR_VIDEO_HISTORY_PAGE}.`),
      },
      run: async (a) => {
        const { action, project_path, instance_id, subject, mode, prompt, reference_images, reference_video, shadow, duration_s, task_id, wait_s, offset, count } = a;
        if (action === 'submit') {
          if (!subject || !mode) throw Error('INVALID_ARGUMENTS(ar_video): subject and mode are required for action=submit');
          const params = {
            subject,
            mode,
            ...(prompt !== undefined ? { prompt } : {}),
            ...(reference_images ? { reference_images } : {}),
            ...(reference_video ? { reference_video } : {}),
            ...(shadow !== undefined ? { shadow } : {}),
            ...(duration_s !== undefined ? { duration_s } : {}),
          };
          return plugin('ar_video_submit', AR_VIDEO_SUBMIT_TIMEOUT_MS)({ project_path, instance_id, ...params });
        }
        if (action === 'tasks') {
          const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
          if (task_id !== undefined) {
            const ws = wait_s ?? 0;
            return text(await d.callPlugin('ar_video_task', { task_id, wait_s: ws }, { projectPath, timeoutMs: ws * 1000 + 120000 }));
          }
          if (wait_s !== undefined) throw Error('INVALID_ARGUMENTS: wait_s only applies together with task_id');
          return text(await d.callPlugin('ar_video_tasks', { offset, count }, { projectPath }));
        }
        if (action === 'import') {
          if (!task_id) throw Error('INVALID_ARGUMENTS(ar_video): task_id is required for action=import');
          return plugin('ar_video_import', AR_VIDEO_IMPORT_TIMEOUT_MS)({ project_path, instance_id, task_id });
        }
        if (!task_id) throw Error('INVALID_ARGUMENTS(ar_video): task_id is required for action=cancel');
        return plugin('ar_video_cancel')({ project_path, instance_id, task_id });
      },
    },
    {
      name: 'sfx_synth',
      keywords: '音效 合成 预设 sfx synth',
      description: `Synthesize sound effects (no editor needed; Xiangsu's bundled ffmpeg writes MP3): presets ported from sound-effect scripts the effect projects used — frequencies, envelopes and default volumes verbatim (presets without noise match the original scripts sample for sample). Presets: ${Object.entries(SFX_PRESETS)
        .map(([k, p]) => `${k} ${p.desc}`)
        .join('; ')}. pitch shifts the whole thing (${PITCH_RANGE[0]}–${PITCH_RANGE[1]}×), volume is the peak (per preset by default). .mp3: stereo 128 kbps (what projects import), .wav: mono 16-bit. After copying an .mp3 into Assets/ import is sometimes automatic, sometimes not: check with official list_resources, import with official import_resource (absolute path) when missing. Use it when the official sound library has nothing fitting; loops, melodies and anything outside the presets still follow the project's own scripting.`,
      shape: {
        out_dir: outDir,
        sounds: z
          .array(
            z.strictObject({
              preset: z.enum(Object.keys(SFX_PRESETS)),
              file: z.string().regex(/^[^/\\:*?"<>|]+\.(mp3|wav)$/, '文件名（不含目录）以 .mp3 或 .wav 结尾'),
              pitch: z.number().min(PITCH_RANGE[0]).max(PITCH_RANGE[1]).optional().describe('Pitch shift multiplier, default 1.'),
              volume: z.number().min(0.05).max(1).optional().describe('Peak 0–1, per preset by default (0.45–0.8).'),
            }),
          )
          .min(1)
          .max(30),
      },
      run: async ({ out_dir, sounds }) => {
        const dir = saveDir(out_dir);
        const written = [];
        for (const s of sounds) {
          const samples = synth(s.preset, { pitch: s.pitch ?? 1, peak: s.volume });
          const file = path.join(dir, s.file);
          await d.writeSound(samples, file);
          written.push({ file, preset: s.preset, seconds: Number((samples.length / SFX_RATE).toFixed(2)), peak: s.volume ?? SFX_PRESETS[s.preset].peak, ...(s.pitch && s.pitch !== 1 ? { pitch: s.pitch } : {}) });
        }
        return text({ sounds: written });
      },
    },
    {
      name: 'ui_text_image',
      keywords: '文字 渲染 PNG 描边 ui text image',
      description:
        'Render text as transparent PNGs (no editor needed): stroked, gradient, shadowed — Text2D stroke is not settable, thick stroked text only as an image on an Image. Up to 60 images, e.g. a digit set 0–9, a few lines of text. Images are trimmed by the text bounds plus padding, returning each width/height (for ScreenTransform). Default font is the Douyin body; fonts need a licence (Xiangsu built-in fonts or SIL OFL open-source commercial ones).',
      shape: {
        out_dir: outDir,
        items: z
          .array(z.strictObject({ file: pngFile, ...textStyle, padding: z.number().min(0).max(100).optional().describe('Padding around the text (px), default 4.') }))
          .min(1)
          .max(60),
      },
      run: async ({ out_dir, items }) => {
        const { png, textCanvas } = await graphics();
        const dir = saveDir(out_dir);
        const out = [];
        const shown = [];
        for (const [i, item] of items.entries()) {
          const canvas = textCanvas(item, `items[${i}]`);
          const file = path.join(dir, item.file);
          const buf = await png(canvas);
          fs.writeFileSync(file, buf);
          out.push({ file, width: canvas.width, height: canvas.height });
          if (shown.length < INLINE_IMAGES * 2) shown.push({ type: 'text', text: item.file }, { type: 'image', mimeType: 'image/png', data: buf.toString('base64') });
        }
        return { content: [{ type: 'text', text: JSON.stringify({ images: out }, null, 2) }, ...shown] };
      },
    },
    {
      name: 'ui_panel',
      keywords: '界面 底板 按钮 ui panel',
      description:
        'Draw UI panel PNGs (no editor needed): rounded rectangle or capsule (radius="pill"), solid or vertical gradient (colors may carry alpha, e.g. #121c2e96 translucent dark frosted), optional stroke and shadow, with centered text lines inside (each its own size, color, stroke). Without width / height the size is auto-set from the text plus padding. For intro banners, result cards, button bases. Up to 30 images; returns each width/height (shadow outset included).',
      shape: {
        out_dir: outDir,
        items: z
          .array(
            z.strictObject({
              file: pngFile,
              width: z.number().int().min(4).max(2048).optional(),
              height: z.number().int().min(4).max(2048).optional(),
              radius: z.union([z.number().min(0).max(1024), z.literal('pill')]).optional().describe('Corner radius (px), or pill for fully rounded ends; default 24.'),
              fill: hexColor.optional().describe('Fill color, default #ffffff.'),
              gradient: z.array(hexColor).min(2).max(6).optional().describe('Vertical top-to-bottom gradient (replaces fill).'),
              stroke: strokeArg,
              shadow: shadowArg,
              padding: z.number().min(0).max(200).optional().describe('Padding around the text when auto-sizing, default 24.'),
              line_gap: z.number().min(0).max(200).optional().describe('Gap between lines, default 8.'),
              lines: z
                .array(z.strictObject({ ...textStyle, shadow: shadowArg }))
                .max(6)
                .optional()
                .describe('Text lines on the panel, centered top-to-bottom.'),
            }),
          )
          .min(1)
          .max(30),
      },
      run: async ({ out_dir, items }) => {
        const { png, panelCanvas } = await graphics();
        const dir = saveDir(out_dir);
        const out = [];
        const shown = [];
        for (const [i, item] of items.entries()) {
          const canvas = panelCanvas(item, `items[${i}]`);
          const file = path.join(dir, item.file);
          const buf = await png(canvas);
          fs.writeFileSync(file, buf);
          out.push({ file, width: canvas.width, height: canvas.height });
          if (shown.length < INLINE_IMAGES * 2) shown.push({ type: 'text', text: item.file }, { type: 'image', mimeType: 'image/png', data: buf.toString('base64') });
        }
        return { content: [{ type: 'text', text: JSON.stringify({ images: out }, null, 2) }, ...shown] };
      },
    },
    {
      name: 'preview_model_add',
      keywords: '模特 预览 加 自己的脸 preview model',
      description: `Add your own model to Xiangsu's preview video list (no editor needed): a photo (a ${PHOTO_SECONDS} s still video by default), a video, or two photos alternating (alternate — to verify 「make an expression, count one」: calm photo and expression photo alternating), transcoded to the built-in preview spec (720×1280, h264, 30000/1001 fps, silent AAC; animated 320×569, icons 56×96) and written into ~/Library/Application Support/DouyinAR/Shared/Resources/PreviewResource/PreviewResources.json (previous version backed up to ~/.xiangsu-mcp-plus/preview-resources-backup/, last 10 kept). New project windows pick it up (its name works as set_preview_video video_name / preview_frames videos); open windows must be closed and reopened. replace=true swaps a same-named model in place: windows that played that video freeze — close them first. Xiangsu updates may overwrite the list; re-add then.`,
      shape: {
        name: z.string().min(1).max(40).describe('Name in the list, following the existing style 「模特W短发||女」 (after || is the gender).'),
        file_name: z.string().regex(/^[a-z0-9_]+$/).describe('File name (lowercase, digits, underscores), such as model_w, model_s_kiss.'),
        type: z.enum(PREVIEW_TYPES).optional().describe('Preview type, default preview_face.'),
        image: absPath('照片').optional().describe('Photo (PNG / JPG / WEBP), cover-filled to 720×1280 then centre-cropped.'),
        seconds: z.number().min(1).max(30).optional().describe(`Duration of the photo video, default ${PHOTO_SECONDS} s.`),
        video: absPath('视频').optional().describe('Video (MP4 / MOV), cover-filled to 720×1280 then centre-cropped, original audio kept (silent otherwise).'),
        alternate: z
          .strictObject({
            first: absPath('照片'),
            second: absPath('照片'),
            first_s: z.number().min(0.2).max(10).describe('How long the first photo holds (e.g. calm 1.4).'),
            second_s: z.number().min(0.2).max(10).describe('How long the second photo holds (e.g. pout 1).'),
            cycles: z.number().int().min(1).max(20).describe('How many cycles (e.g. 4, 9.6 s total).'),
          })
          .optional()
          .describe('Two photos alternating; keep preview_frames intervals off whole-cycle multiples or every frame lands on the same phase.'),
        replace: z.boolean().optional().describe('Replace a same-named model, default false (same name: PREVIEW_MODEL_EXISTS).'),
      },
      run: async (a) => text(await d.addPreviewModel(a)),
    },
    {
      name: 'scene_set_layer',
      keywords: '图层 渲染层 摄像机 layer',
      description: 'Set render layers (layer) of objects and camera visibility masks (layerVisibleMask) in a saved project Assets/main.scene — the official DSL cannot write these (Invalid property name layer). For drawing some objects only into one camera (e.g. a scratch mask rendered only into a render texture).\n\n' +
        'Only the touched rows change; the file is re-parsed and cross-checked, mismatch refuses the write (SCENE_EDIT_NOT_APPLIED). Backups per project in ~/.xiangsu-mcp-plus/scene-backups/ (last 10). Refuses while the project window is open (PROJECT_OPEN — the editor would overwrite the file on save): save_project, project_close, edit, project_open. Objects like scene_tree project_dir mode (#index, name, or path).',
      shape: {
        project_dir: absPath('工程目录').describe('Absolute path of the project directory (contains Assets/main.scene).'),
        objects: z
          .array(z.strictObject({ object: z.string().min(1), layer: z.number().int().min(0).max(63).describe('Layer 0–63; default objects sit at 0.') }))
          .max(200)
          .optional(),
        cameras: z
          .array(z.strictObject({ object: z.string().min(1).describe('Object with a Camera component.'), visible_layers: z.array(z.number().int().min(0).max(63)).min(1).describe('Which layers this camera draws.') }))
          .max(20)
          .optional(),
      },
      run: async ({ project_dir, objects, cameras }) => {
        const real = (p) => {
          try {
            return fs.realpathSync(p);
          } catch (_) {
            return path.resolve(p);
          }
        };
        if ((await openPaths()).some((p) => real(p) === real(project_dir))) throw Error(`PROJECT_OPEN: ${project_dir} is open in an editor window, which would overwrite main.scene on its next save; save_project and project_close it first`);
        return text(setSceneLayers(project_dir, { objects, cameras }));
      },
    },
    {
      name: 'preview_audio_test',
      keywords: '声音 音量 关键词 预览 audio test',
      description: 'Feed simulated sound into the preview to test audio gameplay (the editor has no real voice: volume reads stay 0 and keywords never hit).\n\n' +
        "Opens the editor's built-in Agent 「试玩」 session (the preview reloads once; a runtime converting the simulated input into AudioDetection results is injected), then feeds the steps in order — volume volume (detector raw 0–1; voice reference: soft 0.05, mid 0.10, loud 0.15), pitch_hz (45–650), keyword hits keywords or a miss keyword_miss — each for duration_ms, shooting frames evenly along the way; then inputs clear and the session closes (one more reload, back to the uninjected state). Measured 2026-11-14: VolumeDetector.getResult() read 0.12 while 0.12 was fed for 2.5 s, 0 before and after. What the script received: official get_script_logs. The preview reloads from the start, resetting effect state; lead_ms waits that long after the reload before the first step (default 1000).",
      shape: {
        ...target,
        steps: z
          .array(
            z.strictObject({
              volume: z.number().min(0).max(1).optional(),
              pitch_hz: z.number().min(45).max(650).optional(),
              keywords: z.array(z.string().min(1)).min(1).optional().describe('Simulate the detector hitting these keywords (matching the script registered ones).'),
              keyword_miss: z.literal(true).optional().describe('Simulate one keyword miss.'),
              duration_ms: z.number().int().min(100).max(30000).describe('How long this step lasts.'),
              frames: z.number().int().min(0).max(6).optional().describe('Preview frames shot evenly within the step, default 2.'),
            }),
          )
          .min(1)
          .max(10),
        lead_ms: z.number().int().min(0).max(10000).optional(),
        save_to: saveTo,
      },
      run: async (a) => {
        const { steps, lead_ms = 1000, save_to } = a;
        const inputs = steps.map((s, i) => {
          if (s.keywords && s.keyword_miss) throw Error(`INVALID_ARGUMENTS: steps[${i}] has both keywords and keyword_miss`);
          const input = { ...(s.volume !== undefined ? { volume: s.volume } : {}), ...(s.pitch_hz !== undefined ? { pitchHz: s.pitch_hz } : {}), ...(s.keywords ? { keywordEvent: { type: 'hit', keywords: s.keywords } } : {}), ...(s.keyword_miss ? { keywordEvent: { type: 'miss' } } : {}) };
          if (!Object.keys(input).length) throw Error(`INVALID_ARGUMENTS: steps[${i}] needs volume, pitch_hz, keywords or keyword_miss`);
          return input;
        });
        const projectPath = await projects.resolveProjectPath({ project_path: a.project_path, instance_id: a.instance_id });
        const dir = save_to ? saveDir(save_to) : d.framesDir();
        const total = lead_ms + steps.reduce((s, x) => s + x.duration_ms, 0);
        const shots = [];
        let stopped;
        await holdFullRate(projectPath, AUDIO_SESSION_TIMEOUT_MS * 2 + total + HOLD_SLACK_MS);
        try {
          await d.callPlugin('preview_audio_session', { action: 'start' }, { projectPath, timeoutMs: AUDIO_SESSION_TIMEOUT_MS });
          await d.sleep(lead_ms);
          for (const [k, s] of steps.entries()) {
            await d.callPlugin('preview_audio_input', { input: inputs[k], duration_ms: s.duration_ms }, { projectPath, timeoutMs: 15000 });
            const t0 = Date.now();
            const n = s.frames ?? 2;
            for (let j = 0; j < n; j++) {
              await d.sleep(Math.max(0, t0 + Math.round((s.duration_ms * (j + 1)) / (n + 1)) - Date.now()));
              const img = await d.callPlugin('preview_frame', {}, { projectPath, timeoutMs: 15000 });
              const file = path.join(dir, `step${k + 1}-frame-${j + 1}.jpg`);
              fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
              shots.push({ step: k + 1, at_ms: Date.now() - t0, file });
            }
            await d.sleep(Math.max(0, t0 + s.duration_ms - Date.now()));
          }
        } finally {
          await d.callPlugin('preview_audio_input', { clear: true }, { projectPath, timeoutMs: 15000 }).catch(() => {});
          stopped = await d.callPlugin('preview_audio_session', { action: 'stop' }, { projectPath, timeoutMs: AUDIO_SESSION_TIMEOUT_MS }).catch((e) => ({ error: e.message }));
          await releaseFullRate(projectPath);
        }
        const content = [];
        for (const s of shots) content.push({ type: 'text', text: `第 ${s.step} 步，${s.at_ms} ms` }, { type: 'image', ...(await d.readImageFile(s.file)) });
        const summary = { steps: steps.map((s, k) => ({ input: inputs[k], duration_ms: s.duration_ms, frames: shots.filter((x) => x.step === k + 1).map((x) => x.file) })), session_stopped: stopped, next: '用官方 get_script_logs 看脚本读到的值' };
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }, ...content] };
      },
    },
    {
      name: 'preview_actions',
      keywords: '预览 交互 拖动 拖拽 手势 动作 暂停 恢复 临时属性 preview actions drag pause resume human_action set_preview_property',
      description: 'Preview commands via editor Agent: touch_move (x,y in 0..1), drag (x1,y1,x2,y2,steps,duration_ms), seek_to_time (time_ms), switch_gesture_video (hand_action), pause, resume, set_preview_property (scene_object_guid,component_type,property,value), human_action (input_type,file_path,action_id), restore_human_action. Runs in order.',
      shape: {
        ...target,
        commands: z
          .array(
            z.discriminatedUnion('command_type', [
              z.strictObject({ command_type: z.literal('touch_move'), params: z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }) }),
              z.strictObject({
                command_type: z.literal('drag'),
                params: z.strictObject({
                  x1: z.number().min(0).max(1),
                  y1: z.number().min(0).max(1),
                  x2: z.number().min(0).max(1),
                  y2: z.number().min(0).max(1),
                  steps: z.number().int().min(1).optional(),
                  duration_ms: z.number().min(0).optional(),
                }),
              }),
              z.strictObject({ command_type: z.literal('seek_to_time'), params: z.strictObject({ time_ms: z.number().min(0) }) }),
              z.strictObject({ command_type: z.literal('switch_gesture_video'), params: z.strictObject({ hand_action: z.string().min(1) }) }),
              z.strictObject({ command_type: z.literal('pause'), params: z.strictObject({}).optional() }),
              z.strictObject({ command_type: z.literal('resume'), params: z.strictObject({}).optional() }),
              z.strictObject({
                command_type: z.literal('set_preview_property'),
                params: z.strictObject({
                  scene_object_guid: z.string().min(1),
                  component_type: z.string().min(1),
                  property: z.string().min(1),
                  value: z.unknown(),
                }),
              }),
              z.strictObject({
                command_type: z.literal('human_action'),
                params: z.strictObject({
                  input_type: z.enum(['preview_face', 'preview_hand', 'preview_fullbody', 'preview_twoperson']),
                  file_path: z.string().min(1),
                  action_id: z.string().min(1).optional(),
                }),
              }),
              z.strictObject({ command_type: z.literal('restore_human_action'), params: z.strictObject({}).optional() }),
            ]),
          )
          .min(1)
          .max(20),
      },
      run: plugin('preview_actions', 30000),
    },
    {
      name: 'preview_record',
      keywords: '预览 录屏 录制 视频 preview record mp4 video',
      description: 'Record the live preview to an .mp4 file and return a 3x2 contact sheet preview: action=record (timed duration_s, default 5s), or start / stop / abort around preview_actions. Holds full frame rate while recording.',
      shape: {
        ...target,
        action: z.enum(['record', 'start', 'stop', 'abort']).describe('record (timed), start, stop, or abort.'),
        duration_s: z.number().gt(0).max(60).optional().describe('record: duration in seconds (0 < duration_s <= 60, default 5).'),
        save_to: z.string().min(1).optional().describe('record/start: output .mp4 path (defaults to temp file).'),
      },
      run: async ({ project_path, instance_id, action, duration_s, save_to }) => {
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        const holdMs = action === 'record' ? Math.ceil((duration_s ?? 5) * 1000) + HOLD_SLACK_MS : 60000 + HOLD_SLACK_MS;
        const needHold = action === 'record' || action === 'start';
        if (needHold) await holdFullRate(projectPath, holdMs);
        let res;
        let started = false;
        try {
          res = await d.callPlugin('preview_record', { action, duration_s, save_to }, { projectPath, timeoutMs: 120000 });
          started = action === 'start';
        } finally {
          if (!started) await releaseFullRate(projectPath);
        }
        const content = [{ type: 'text', text: JSON.stringify(res, null, 2) }];
        if ((action === 'record' || action === 'stop') && res?.path && fs.existsSync(res.path)) {
          try {
            const { meta, png } = await videoContactSheet(res.path);
            content[0].text = JSON.stringify({ ...res, video_meta: meta }, null, 2);
            content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
          } catch (_) {}
        }
        return { content };
      },
    },
    {
      name: 'ai_vfx',
      keywords: 'AI 生成 画面 特效 任务 导入 取消 ai vfx submit tasks import cancel',
      description: `Library 「AI 生成 › 画面特效」 (9.8.3) pipeline: action=submit generates a full-screen visual effect from prompt and/or reference assets (≤10 images, 1 video ≤60 s, spends quota); action=tasks lists/waits (succeeded returns 6-frame preview_image_file); action=import imports as Surface Graph; action=cancel.`,
      shape: {
        ...target,
        action: z.enum(['submit', 'tasks', 'import', 'cancel']).describe('Operation: submit, tasks, import, or cancel.'),
        prompt: z.string().optional().describe('submit: effect description.'),
        reference_images: z.array(absPath('参考图')).max(10).optional().describe('submit: reference images (PNG/JPG/JPEG).'),
        reference_video: absPath('参考视频').optional().describe('submit: reference video (MP4/MOV).'),
        duration_s: z.number().int().min(1).max(10).optional().describe('submit: duration in seconds, default 5.'),
        task_id: z.string().min(1).optional().describe('tasks (optional single) / import / cancel (required): task_id.'),
        wait_s: z.number().int().min(0).max(AI_VFX_MAX_WAIT_S).optional().describe(`tasks with task_id: max wait seconds (max ${AI_VFX_MAX_WAIT_S}).`),
        offset: z.number().int().min(0).optional().describe('tasks: paging offset, default 0.'),
        count: z.number().int().min(1).max(20).optional().describe('tasks: items per page, default 20.'),
      },
      run: async (a) => {
        const { action, project_path, instance_id, prompt, reference_images, reference_video, duration_s, task_id, wait_s, offset, count } = a;
        if (action === 'submit') {
          const params = {
            ...(prompt !== undefined ? { prompt } : {}),
            ...(reference_images ? { reference_images } : {}),
            ...(reference_video ? { reference_video } : {}),
            ...(duration_s !== undefined ? { duration_s } : {}),
          };
          return text(await d.callPlugin('ai_vfx_submit', params, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: AI_VFX_SUBMIT_TIMEOUT_MS }));
        }
        if (action === 'tasks') {
          const win = await homeWindow({ project_path, instance_id });
          if (task_id !== undefined) {
            const ws = wait_s ?? 0;
            return text(await d.callPlugin('ai_vfx_task', { task_id, wait_s: ws }, { ...win, timeoutMs: ws * 1000 + 120000 }));
          }
          if (wait_s !== undefined) throw Error('INVALID_ARGUMENTS: wait_s only applies together with task_id');
          return text(await d.callPlugin('ai_vfx_tasks', { offset, count }, { ...win, timeoutMs: 120000 }));
        }
        if (action === 'import') {
          if (!task_id) throw Error('INVALID_ARGUMENTS(ai_vfx): task_id is required for action=import');
          return plugin('ai_vfx_import', 300000)({ project_path, instance_id, task_id });
        }
        if (!task_id) throw Error('INVALID_ARGUMENTS(ai_vfx): task_id is required for action=cancel');
        return text(await d.callPlugin('ai_vfx_cancel', { task_id }, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: 120000 }));
      },
    },
    {
      name: 'custom_gan',
      refs: true,
      keywords: '实时变脸 风格 生成 任务 训练 导入 custom gan styles submit tasks train import',
      description: `Library 「AI 生成 › 实时变脸」 (9.8.3) pipeline: action=styles lists styles & daily training quota; action=submit generates male/female previews (no quota); action=tasks lists/waits (returns preview refs/videos); action=train starts training (1 quota; 「真人搞怪」 first without selected then with ${CUSTOM_GAN_SELECT_COUNT} indices); action=import places trained model into scene.`,
      shape: {
        ...target,
        action: z.enum(['styles', 'submit', 'tasks', 'train', 'import']).describe('Operation: styles, submit, tasks, train, or import.'),
        style: z.string().min(1).optional().describe('submit: style name or preset from action=styles.'),
        image_path: absPath('参考图').optional().describe('submit: reference image (PNG/JPG/JPEG, ≤10 MB).'),
        task_id: z.string().min(1).optional().describe('tasks (optional single) / train / import (required): task_id.'),
        wait_s: z.number().int().min(0).max(CUSTOM_GAN_MAX_WAIT_S).optional().describe(`tasks with task_id: max wait seconds (max ${CUSTOM_GAN_MAX_WAIT_S}).`),
        offset: z.number().int().min(0).optional().describe('tasks: paging offset.'),
        count: z.number().int().min(1).max(20).optional().describe('tasks: items per page.'),
        selected: z.array(z.number().int().min(0)).length(CUSTOM_GAN_SELECT_COUNT).optional().describe(`train (真人搞怪): ${CUSTOM_GAN_SELECT_COUNT} candidate indices.`),
      },
      run: async (a) => {
        const { action, project_path, instance_id, style, image_path, task_id, wait_s, offset, count, selected } = a;
        if (action === 'styles') {
          return text(await d.callPlugin('custom_gan_styles', {}, await homeWindow({ project_path, instance_id })));
        }
        if (action === 'submit') {
          if (!style || !image_path) throw Error('INVALID_ARGUMENTS(custom_gan): style and image_path are required for action=submit');
          return text(await d.callPlugin('custom_gan_submit', { style, image_path }, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: 120000 }));
        }
        if (action === 'tasks') {
          const win = await homeWindow({ project_path, instance_id });
          if (task_id !== undefined) {
            const ws = wait_s ?? 0;
            return text(await d.callPlugin('custom_gan_task', { task_id, wait_s: ws }, { ...win, timeoutMs: ws * 1000 + 120000 }));
          }
          if (wait_s !== undefined) throw Error('INVALID_ARGUMENTS: wait_s only applies together with task_id');
          return text(await d.callPlugin('custom_gan_tasks', { offset, count }, { ...win, timeoutMs: 120000 }));
        }
        if (action === 'train') {
          if (!task_id) throw Error('INVALID_ARGUMENTS(custom_gan): task_id is required for action=train');
          return text(await d.callPlugin('custom_gan_train', { task_id, ...(selected ? { selected } : {}) }, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: 120000 }));
        }
        if (!task_id) throw Error('INVALID_ARGUMENTS(custom_gan): task_id is required for action=import');
        return plugin('custom_gan_import', CUSTOM_GAN_IMPORT_TIMEOUT_MS)({ project_path, instance_id, task_id });
      },
    },
    {
      name: 'image_ai_edit',
      keywords: '图片 超清 放大 消除 重绘 AI 抠图 贴纸 upscale repaint inpaint matting',
      description: `Image editor cloud AI (no window opened): action=upscale (超清), action=repaint (消除 without prompt / 局部重绘 with prompt; requires mask or boxes), action=matting (抠图 returning subject + ${IMAGE_MATTING_PARTS.filter((p) => p !== 'subject').join('、')} PNGs).`,
      shape: {
        ...target,
        action: z.enum(['upscale', 'repaint', 'matting']).describe('Operation: upscale, repaint, or matting.'),
        image_path: absPath('图片').describe('Input PNG / JPG / JPEG path.'),
        mask: absPath('遮罩').optional().describe('repaint: mask image path (bright/opaque = edit area).'),
        boxes: z
          .array(z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().gt(0).max(1), height: z.number().gt(0).max(1) }))
          .max(20)
          .optional()
          .describe('repaint: normalized rectangles [0..1] to edit.'),
        prompt: z.string().optional().describe('repaint: description to paint; omit for object removal (消除).'),
        out_dir: outDir.optional().describe('Output directory; omitted, saved to temp dir (24h TTL).'),
      },
      run: async (a) => {
        const { action, project_path, instance_id, image_path, mask, boxes, prompt, out_dir } = a;
        if (action === 'upscale') return imageAi({ project_path, instance_id, image_path, out_dir }, 'image_upscale', {}, 'upscaled');
        if (action === 'repaint') {
          if (!mask && !boxes?.length) throw Error('INVALID_ARGUMENTS: mark the area with mask or boxes');
          const { markedCanvas, png } = await graphics();
          const dir = out_dir ? saveDir(out_dir) : d.framesDir();
          const stem = path.basename(image_path, path.extname(image_path));
          const { canvas, marked_ratio } = await markedCanvas(image_path, { mask, boxes });
          const marked = path.join(dir, `${stem}_marked.png`);
          fs.writeFileSync(marked, await png(canvas));
          return imageAi({ project_path, instance_id, image_path: marked, out_dir }, 'image_repaint', { prompt }, prompt?.trim() ? 'repainted' : 'removed', { dir, stem, marked_file: marked, marked_ratio });
        }
        const { previewJpeg } = await graphics();
        const got = await d.callPlugin('image_matting', { image_path }, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: IMAGE_AI_TIMEOUT_MS });
        const dir = out_dir ? saveDir(out_dir) : d.framesDir();
        const stem = path.basename(image_path, path.extname(image_path));
        const files = {};
        for (const [part, src] of Object.entries(got.parts)) {
          files[part] = path.join(dir, `${stem}_${part}.png`);
          fs.copyFileSync(src, files[part]);
        }
        const summary = { files, ...(out_dir ? {} : { note_files: '临时文件，24 小时后删除；要留存请传 out_dir' }) };
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }, { type: 'image', mimeType: 'image/jpeg', data: (await previewJpeg(files.subject)).toString('base64') }] };
      },
    },
    {
      name: 'face_warp',
      keywords: '塑型画笔 列表 强度 face warp list intensity',
      description: 'Inspect or tune 「塑型画笔」 (FaceWarpX, including cat/dog): action=list returns object_path, enabled, brush items; action=set_intensity sets 0–100 intensity (undoable; official edit_by_dsl cannot write brush intensity).',
      shape: {
        ...target,
        action: z.enum(['list', 'set_intensity']).describe('Operation: list or set_intensity.'),
        object_path: z.string().min(1).optional().describe('set_intensity: object_path from action=list (or unique trailing segments).'),
        intensity: z.number().min(0).max(100).optional().describe('set_intensity: 0–100.'),
        item_index: z.number().int().min(0).optional().describe('set_intensity: brush item index; omitted changes all items.'),
      },
      run: async (a) => {
        const { action, project_path, instance_id, object_path, intensity, item_index } = a;
        if (action === 'list') return plugin('face_warp_list')({ project_path, instance_id });
        if (!object_path || intensity === undefined) throw Error('INVALID_ARGUMENTS(face_warp): object_path and intensity are required for action=set_intensity');
        return plugin('face_warp_set_intensity')({ project_path, instance_id, object_path, intensity, ...(item_index !== undefined ? { item_index } : {}) });
      },
    },
    {
      name: 'object_remove',
      keywords: '删除 对象 资源 object remove',
      description: 'Delete a scene object (children included, undoable) and find the resources only it used: scene references are diffed before and after; anything referenced before and not after is an orphan (unused_paths, folded into package folders, disk paths only). editor_only_paths are folders the editor created per object name when the asset was placed (e.g. 「复古清冷_滤镜」) — editor-only, not yet on disk, gone at the next save; nothing to delete. delete_unused_resources=true also deletes unused_paths (resource deletion is not undoable); default reports only, delete later with resource_delete_unused.\n\n' +
        'object_path: full hierarchical path or uniquely-identifying trailing segments. Render groups themselves: the official edit_by_dsl delete_render_group command. Just deleting, no resource accounting: official edit_by_dsl works too — use this tool when you need to know what becomes orphaned.',
      shape: {
        ...target,
        object_path: z.string().min(1).describe('Hierarchical path of the object, such as 「面部拉伸/小屁桃_美型」, or uniquely-identifying trailing segments.'),
        delete_unused_resources: z.boolean().optional().describe('Also delete the orphan resources, default false (report only).'),
      },
      run: plugin('object_remove'),
    },
    {
      name: 'resource_delete_unused',
      keywords: '删除 资源 孤儿 resource unused',
      description: 'Delete the unused_paths reported by object_remove (project-relative resource or package-folder paths). Re-checked before deleting: anything still referenced by the scene is refused. Resource deletion is not undoable.',
      shape: { ...target, paths: z.array(z.string().min(1)).min(1).describe('unused_paths from object_remove.') },
      run: plugin('resource_delete_unused'),
    },
    {
      name: 'asset_properties',
      keywords: '资源 属性 贴图 分辨率 压缩 过滤 extra asset properties list get set',
      description: 'List, read, or edit asset import properties online (e.g. texture compressMaxResolution, filterMin, wrapModeS) without closing the editor: action=list|get|set. Validates editable keys and reads back to confirm.',
      shape: {
        ...target,
        action: z.enum(['list', 'get', 'set']).describe('list, get, or set.'),
        guid: z.string().min(1).optional().describe('Asset GUID (for get/set).'),
        path: z.string().min(1).optional().describe('Project-relative asset path (alternative to guid).'),
        type: z.string().min(1).optional().describe('list: filter by asset type (e.g. Texture2D).'),
        path_contains: z.string().min(1).optional().describe('list: filter by substring in filePath.'),
        properties: z.record(z.string(), z.unknown()).optional().describe('set: map of editable property keys to new values.'),
      },
      run: plugin('asset_properties', 30000),
    },
    {
      name: 'project_snapshot',
      keywords: '工程 快照 备份 回滚 恢复 project snapshot create restore delete list',
      description: 'Create, list, restore, or delete project snapshots via editor snapshot host: action=create|list|restore|delete. Enforces project matching on restore.',
      shape: {
        ...target,
        action: z.enum(['create', 'list', 'restore', 'delete']).describe('create, list, restore, or delete.'),
        label: z.string().optional().describe('create: optional human-readable label.'),
        snapshot_id: z.string().min(1).optional().describe('restore/delete: snapshot_id returned by create or list.'),
      },
      run: plugin('project_snapshot', 60000),
    },
    {
      name: 'asset_package',
      keywords: '资产包 预制体 导入 导出 实例化 ehpackage prefab import export instantiate',
      description: 'Import/export .ehpackage bundles and create/instantiate prefabs: action=import_package|create_prefab|instantiate_prefab|export_package.',
      shape: {
        ...target,
        action: z.enum(['import_package', 'create_prefab', 'instantiate_prefab', 'export_package']).describe('Operation.'),
        path: z.string().min(1).optional().describe('import_package: .ehpackage file path.'),
        guid: z.string().min(1).optional().describe('create_prefab/instantiate_prefab: target GUID.'),
        guids: z.array(z.string().min(1)).min(1).optional().describe('export_package: scene object GUIDs to export.'),
        name: z.string().min(1).optional().describe('export_package: package name.'),
        out_dir: z.string().min(1).optional().describe('export_package: output directory.'),
      },
      run: plugin('asset_package', 60000),
    },
  ];
  const own = new Map(tools.map((t) => [t.name, { ...t, schema: z.strictObject(t.shape) }]));

  // Official tools listed unchanged whose calls are partly served here.
  const intercepted = {
    // Measured on 9.8.3: the scene view of a window that is not on screen comes back as one flat colour,
    // also shown off screen (macOS then keeps a corner of it on screen), so get_scene_view is refused for
    // a minimized window rather than bringing it up.
    get_scene_view: async (args) => {
      const projectPath = await officialTarget(args.instance_id);
      const win = projectPath ? await d.callPlugin('preview_window', {}, { projectPath, timeoutMs: 5000 }) : null;
      if (win && !win.visible) return failure(SCENE_VIEW_REFUSED);
      return d.official.callTool('get_scene_view', args);
    },
    // Since 9.8.1 the official screenshot photographs the window's preview area, which is black while
    // the window is minimized or hidden. Then the frame comes from the render output instead, scaled
    // to the official size.
    capture_preview: async (args) => {
      let projectPath;
      let win;
      try {
        projectPath = await projects.resolveProjectPath({ instance_id: args.instance_id });
        win = await d.callPlugin('preview_window', {}, { projectPath, timeoutMs: 5000 });
      } catch (e) {
        const res = await d.official.callTool('capture_preview', args);
        if (res.isError) return res;
        return { ...res, content: [...res.content, { type: 'text', text: `未能检查窗口是否可见（${e.message}），以上是官方截图；窗口最小化时它是黑的` }] };
      }
      if (win.visible) return d.official.callTool('capture_preview', args);
      let img;
      try {
        await holdFullRate(projectPath, RESET_TIMEOUT_MS + HOLD_SLACK_MS);
        await resetPreview(projectPath);
        img = await d.callPlugin('preview_frame', {}, { projectPath, timeoutMs: 15000 });
      } finally {
        await releaseFullRate(projectPath);
      }
      const file = path.join(d.framesDir(), 'capture_preview.jpg');
      fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
      await d.resizeImage(file, OFFICIAL_SHOT_SIDE);
      const note = `窗口${win.minimized ? '最小化了' : '不可见'}，官方截图会是黑的；这张已重置预览，取自预览的渲染结果（不含「选择音乐」、拍摄按钮等界面元素）`;
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, status: 'success', source: 'render_output', note }, null, 2) }, { type: 'image', ...(await d.readImageFile(file)) }] };
    },
  };

  // Official tools whose arguments are rewritten here before they are forwarded.
  const rewritten = {
    edit_by_dsl: async (args) => {
      if (!Array.isArray(args.commands)) return args;
      precheckEditByDsl(args.commands);
      const instance_id = String(args.instance_id);
      const inspect = (guid) => d.official.callJson('inspect', { instance_id, guid, intention: '把 $ref 的对象换成组件 guid' });
      return { ...args, commands: await resolveComponentRefs(args.commands, { objects: async () => sceneObjects(await namesTree(instance_id)), inspect }) };
    },
  };

  const clipError = (name, res) => {
    if (!res || !res.isError) return res;
    const body = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (body.length <= OFFICIAL_ERROR_CHARS) return res;
    const file = d.spill.write(`${name}-error`, body);
    return failure(`${body.slice(0, OFFICIAL_ERROR_CHARS)}\n…（官方报错共 ${body.length} 字，已截断，全文在 ${file}）`);
  };

  const listOfficialCached = async () => (await d.official.listTools()).filter((t) => !own.has(t.name) && !catalog.has(t.name));
  const findOfficial = async (name) => (await listOfficialCached()).find((t) => t.name === name);

  const callTool = async (name, args) => {
    const t = own.get(name);
    if (t) {
      const { args: cleanArgs } = normalizeIntention(args, { isOwn: true });
      const parsed = t.schema.safeParse(cleanArgs);
      if (!parsed.success) return invalidArguments(name, parsed.error);
      try {
        let res = await t.run(parsed.data);
        if (t.refs && !res.isError) res = { ...res, content: res.content.map((c) => (c.type === 'text' ? { ...c, text: JSON.stringify(withRefs(JSON.parse(c.text), d.refs), null, 2) } : c)) };
        return d.spill.apply(name, res);
      } catch (e) {
        return failure(e);
      }
    }

    const officialDef = await findOfficial(name).catch(() => undefined);
    const officialSchema = officialDef?.inputSchema;
    let forward = args;
    try {
      const { args: afterIntention } = normalizeIntention(args, { isOwn: false, officialSchema });
      forward = await normalizeOfficialArgs(name, afterIntention, {
        officialSchema,
        resolveInstanceId: officialInstance,
        listOpenInstances: () => projects.officialInstances(),
      });
    } catch (e) {
      return failure(e);
    }

    if (Object.prototype.hasOwnProperty.call(intercepted, name)) {
      try {
        return await intercepted[name](forward);
      } catch (e) {
        return failure(e);
      }
    }
    if (Object.prototype.hasOwnProperty.call(rewritten, name)) {
      try {
        forward = await rewritten[name](forward);
      } catch (e) {
        return failure(e);
      }
    }
    try {
      let res = clipError(name, await d.official.callTool(name, forward));
      if (name === 'edit_by_dsl') res = compactEditByDslResult(res);
      return d.spill.apply(name, res);
    } catch (e) {
      if (e instanceof McpError) return clipError(name, failure(`OFFICIAL_TOOL_ERROR(${name}): ${e.message}`));
      if (e instanceof OfficialUnreachable) return failure(`OFFICIAL_MCP_UNAVAILABLE(${name}): ${e.message}；确认像塑已启动（${d.official.url}）`);
      return failure(`OFFICIAL_MCP_DISCONNECTED(${name}): ${e.message}；调用发出后连接断了，编辑器里可能已经执行（生成类调用可能已扣额度），没有自动重发：先确认结果（如 get_scene、生成任务的状态）再决定要不要重新调用`);
    }
  };

  const ownDefinition = (t, { hintNames } = {}) => {
    let description = t.refs ? `${t.description}${REF_NOTE}` : t.description;
    if (hintNames) description = withHiddenToolHints(description, { self: t.name, knownNames: hintNames });
    return {
      name: t.name,
      description,
      inputSchema: z.toJSONSchema(t.schema),
      ...(t.annotations ? { annotations: t.annotations } : {}),
    };
  };
  const officialDefinition = (t, { hintNames } = {}) => {
    let description = Object.hasOwn(OFFICIAL_NOTES, t.name) ? `${t.description || ''}\n\n（xiangsu-mcp-plus）${OFFICIAL_NOTES[t.name]}` : t.description || '';
    if (hintNames) description = withHiddenToolHints(description, { self: t.name, knownNames: hintNames });
    return { ...t, description };
  };
  const listOfficial = listOfficialCached;
  const unknownTool = (name) => {
    const status = d.official.status();
    const note = status.connected ? '' : '；官方 MCP 当前未连接，查官方工具请先启动像塑';
    return failure(`UNKNOWN_TOOL(${name}): 用 tool_search 查可用工具${note}`);
  };
  const toolName = z.string().trim().min(1).describe('Original tool name, as found by tool_search.');
  const catalog = new Map([
    {
      name: 'tool_search',
      keywords: '查找 工具 搜索 tool search',
      description: 'Find Xiangsu official and extension tools by keyword (Chinese or English). Results are names, compact params, and one-line summaries, 12 per page. Get full parameters with tool_describe, then call via tool_call.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      schema: z.strictObject({
        query: z.string().trim().min(1).optional().describe('Keyword by tool name or purpose, such as 「素材库」, 「工作流」, or "library apply". Omit to page through everything.'),
        offset: z.number().int().min(0).optional().describe('Paging start; take the previous page next_offset, first call omitted.'),
      }),
      run: async ({ query, offset }) => {
        const official = await listOfficial();
        const page = searchTools([...own.values(), ...official], query, offset);
        d.callLog.write({ event: 'tool_search', query: query ?? '', total: page.total });
        return text({ ...page, official_connected: d.official.status().connected });
      },
    },
    {
      name: 'tool_describe',
      keywords: '工具 参数 说明 tool describe',
      description: 'Full usage and parameter JSON Schema for one tool, by original name. Put the parameter object into tool_call arguments.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      schema: z.strictObject({ name: toolName }),
      run: async ({ name }) => {
        const local = own.get(name);
        if (local) return text(ownDefinition(local));
        const official = await findOfficial(name);
        return official ? text(officialDefinition(official)) : unknownTool(name);
      },
    },
    {
      name: 'tool_call',
      keywords: '调用 工具 tool call',
      description: 'Call a Xiangsu tool by its original name and get its original result. Look parameters up with tool_describe and pass them as arguments.',
      schema: z.strictObject({
        name: toolName,
        arguments: z.record(z.string(), z.unknown()).optional().describe('The original tool parameter object.'),
      }),
      run: async ({ name, arguments: rawArgs = {} }) => {
        const local = own.get(name);
        const official = local ? null : await findOfficial(name);
        if (!local && !official) return unknownTool(name);
        // Unwrap accidental double-nested { arguments: { ... } } emitted by compact-mode clients
        // when the target tool itself has no "arguments" parameter.
        let args = rawArgs;
        const targetHasArgumentsKey = Boolean(local?.shape?.arguments || official?.inputSchema?.properties?.arguments);
        if (!targetHasArgumentsKey && Object.keys(rawArgs).length === 1 && rawArgs.arguments && typeof rawArgs.arguments === 'object' && !Array.isArray(rawArgs.arguments)) {
          args = rawArgs.arguments;
        }
        return callTool(name, args);
      },
    },
  ].map((t) => [t.name, t]));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: CAPABILITIES_RESOURCE_URI,
        name: 'Xiangsu Editor Capability Atlas',
        description: 'Built-in add-object menu categories, library panels, and AI pipelines (cached offline by editor version).',
        mimeType: 'application/json',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri !== CAPABILITIES_RESOURCE_URI) {
      throw new McpError(-32602, `Unknown resource URI: ${req.params.uri}`);
    }
    return {
      contents: [
        {
          uri: CAPABILITIES_RESOURCE_URI,
          mimeType: 'application/json',
          text: JSON.stringify(d.atlas.overview(), null, 2),
        },
      ],
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const flat = isFlat();
    const visible = (t) => flat || DIRECT_TOOLS.has(t.name);
    const official = await listOfficial();
    const hintNames = flat ? null : new Set([...own.keys(), ...official.map((t) => t.name), ...catalog.keys()]);
    return {
      tools: [
        ...[...own.values()].filter(visible).map((t) => ownDefinition(t, { hintNames })),
        ...official.filter(visible).map((t) => officialDefinition(t, { hintNames })),
        ...(flat ? [] : [...catalog.values()].map((t) => ownDefinition(t))),
      ],
    };
  });

  // While a call runs, a client that asked for progress gets a beat every progressMs, so long calls
  // (frames over seconds, waiting for checks) are not ended as idle.
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name: requested, arguments: args = {} } = req.params;
    const entry = isFlat() ? undefined : catalog.get(requested);
    const parsed = entry?.schema.safeParse(args);
    const name = requested === 'tool_call' && parsed?.success ? parsed.data.name : requested;
    const via = requested === 'tool_call' ? 'tool_call' : 'direct';
    const token = req.params._meta?.progressToken;
    const started = Date.now();
    let beats = 0;
    const timer =
      token === undefined
        ? null
        : setInterval(() => {
            beats += 1;
            extra
              .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: beats, message: `${name}: ${Math.round((Date.now() - started) / 1000)} s` } })
              .catch(() => {});
          }, d.progressMs);
    let result;
    let error;
    try {
      if (!entry) result = await callTool(name, args);
      else if (!parsed.success) result = invalidArguments(requested === 'tool_call' ? name : requested, parsed.error);
      else result = await entry.run(parsed.data);
      return result;
    } catch (e) {
      error = String(e?.message ?? e);
      throw e;
    } finally {
      clearInterval(timer);
      d.callLog.call({ tool: name, via, ms: Date.now() - started, result, error, progress: token === undefined ? 'none' : beats });
    }
  });

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const official = new OfficialMcp();
  official.watch();
  // The official-MCP watcher keeps the event loop alive, so a closed client would leave this process
  // running forever.
  const callLog = new CallLog();
  process.stdin.on('end', () => {
    callLog.write({ event: 'client_closed' });
    process.exit(0);
  });
  for (const kind of ['uncaughtException', 'unhandledRejection']) {
    process.on(kind, (e) => {
      callLog.write({ event: kind, error: String(e?.stack ?? e).slice(0, 2000) });
      process.exit(1);
    });
  }
  callLog.write({ event: 'started' });
  // A failed install (像塑 missing or never started) still leaves the official tools working.
  let pluginInstall;
  try {
    pluginInstall = ensurePlugin();
  } catch (e) {
    pluginInstall = { action: 'failed', error: String(e?.message ?? e) };
  }
  callLog.write({ event: 'plugin_install', ...pluginInstall });
  await createServer({ official, callLog, pluginInstall }).connect(new StdioServerTransport());
}
