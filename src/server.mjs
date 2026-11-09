#!/usr/bin/env node
// stdio MCP server: everything 像塑's official MCP offers (proxied unchanged), plus editor features the
// official server cannot reach, served by the XiangsuMcpExt editor plugin.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import QRCode from 'qrcode';
import { PNG } from 'pngjs';
import { z } from 'zod';
import { callPlugin, listInstances } from './bridge.mjs';
import { OfficialMcp } from './official.mjs';
import { fetchImage, readImageFile } from './images.mjs';
import { BILIBILI_POPULAR_MAX, baiduHotList, bilibiliHotSearch, bilibiliPopular, fetchJson } from './hotlists.mjs';
import { Projects, openWithApp } from './projects.mjs';
import { prepareIcon } from './icons.mjs';
import { formatObjects, formatTree, pickInspect, resolveRefs } from './inspect.mjs';
import { loadScene } from './scenefile.mjs';
import { makeupLayers, pixelStats } from './makeup.mjs';
import { BLENDS, CURVES, LAYOUTS, LIMITS as PAINT_LIMITS, paint, previewPng, writeTexture } from './paint.mjs';
import { DETAIL_SIGMA, decodePng, frameDiff, pixelBox, regionStats, sideBySide } from './measure.mjs';
import { LID_SEARCH, WINDOWS, decodeUv, encodeUv, overlay, textureGrid, upperLid } from './calib.mjs';
import { DEFAULT_ANATOMY, LASHES, LINERS, anatomyFromCalibration, eyeTextures } from './eye.mjs';
import { cropImage, framesDir, jpegToPng, resizeImage } from './frames.mjs';
import { DOWNLOAD_TTL_MS, Downloads, checkTarget, copyProject, editorRoot, outlineProject } from './works.mjs';
import { QrCodes } from './qrcodes.mjs';
import { CallLog } from './calllog.mjs';
import { MediaRefs, REF_PATTERN, Spill, withRefs } from './outputs.mjs';

const { INNOVATION_KINDS, MAX_MENU_PREVIEW, RANK_TYPES, RANK_FILTERS, TREND_CYCLES, MESSAGE_GROUPS, MESSAGE_MAX, EFFECT_SEARCH_KINDS, SEARCH_MAX, SCRIPT_TAGS, SCRIPT_MAX, AI3D_FACE_NUM, AI3D_IMAGE_LIMIT, AI3D_VIDEO_LIMIT, AI3D_MAX_RUNNING, AI3D_PRESET_MODELS, AI3D_HISTORY_PAGE, AR_VIDEO_MODES, AR_VIDEO_HISTORY_PAGE } = createRequire(
  import.meta.url,
)('../editor-plugin/library.cjs');
const rankFilter = (key) => z.array(z.enum(Object.keys(RANK_FILTERS[key].options))).optional();
const LIBRARY_PANELS_TEXT =
  'general 为普通面板（如 3d_distortion=脸部变形/3D 变形、distortion=美型、gaoguai_gan/makeup_gan=AI 实时变脸、3d_makeup=美妆、3d_filter=滤镜、sticker=跟脸贴纸）；square 为 aigc_material=素材广场（其他创作者分享的素材，含现成的 AI 图片、AI 妆容、自定义实时变脸，应用时不重新生成、不扣额度）；collection 为 collection=收藏（当前账号收藏的素材）。现生成的 AI 面板不在其中；其中「AI 3D」（图生 3D 模型、3D 动画、高精度模型重建）用 ai3d_* 工具，「AR 视频」（AR 视频贴片）用 ar_video_* 工具。';
const RANK_TYPE_TEXT = Object.entries(RANK_TYPES).map(([k, name]) => `${k} ${name}`).join('、');
const SCRIPT_TAG_TEXT = Object.entries(SCRIPT_TAGS).map(([k, name]) => `${k} ${name}`).join('、');

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const target = {
  project_path: z.string().optional().describe('目标工程的绝对路径。与 instance_id 二选一；只开了一个工程窗口时都可省略。'),
  instance_id: z.string().optional().describe('官方 list_instances 返回的 instance_id，与 project_path 二选一。'),
};

const saveTo = z.string().min(1).optional().describe('另存到这个目录（绝对路径，不存在会创建），长期保留。');

// makeup_texture's shapes. Nested objects are strict too: a misspelt key would otherwise be dropped
// and the shape drawn with defaults.
const pt = z.tuple([z.number(), z.number()]);
const line = z.array(pt).min(2).max(PAINT_LIMITS.points);
const pos = z.number().gt(0);
const mirror = z.boolean().optional().describe('同时画一份左右镜像（关于贴图竖直中线）：另一只眼、另一侧脸颊。');
const range = (what) => z.tuple([z.number().min(0), z.number().min(0)]).describe(what);
const paintShape = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('spot'),
    x: z.number(),
    y: z.number(),
    rx: pos.describe('横向 σ（像素），高斯点约 3σ 处淡到看不见。'),
    ry: pos.optional().describe('纵向 σ，默认同 rx。'),
    angle: z.number().optional().describe('旋转角度（度），默认 0。'),
    peak: z.number().gt(0).max(1).optional().describe('中心不透明度，默认 1。'),
    mirror,
  }),
  z.strictObject({
    type: z.literal('stroke'),
    points: line,
    radius: z.union([pos, z.array(z.number().min(0)).min(2)]).describe('半径（像素，线宽的一半）：一个数；[起点, 终点] 按长度渐变；或每个点一个。'),
    tail: z
      .strictObject({
        length: pos.describe('尾巴长度（像素）。'),
        lift: z.number().min(-90).max(90).describe('尾尖相对线末端走向往上挑的角度（度），负数往下。'),
        radius: z.number().min(0).optional().describe('尾尖半径，默认 0.2；粗细从线末端的半径渐变过去。'),
      })
      .optional()
      .describe('从最后一个点顺着线的走向接出一条尾巴（眼线的上扬眼尾），接头处方向连续；眼尾不要另画一笔，两笔的接头会折。'),
    curve: z.enum(CURVES).optional().describe('线怎么走：arc（默认，4 个点以上）用一条三次贝塞尔曲线拟合这些点，像一笔画下来（整体一条弧，最多一个反弯），首尾落在第一个和最后一个点上，中间不逐个经过（实测点带一两像素的误差，逐点经过会把误差画成折角），点不在一条弧上时 warnings 里会说；through 平滑地穿过每个点；straight 直线连接，要尖角（如翼尖）时用。3 个点时 arc 按 through 画。'),
    mirror,
  }),
  z.strictObject({ type: z.literal('polygon'), points: z.array(pt).min(3).max(PAINT_LIMITS.points), mirror }),
  z.strictObject({
    type: z.literal('band'),
    top: line.describe('上沿，从左到右。'),
    bottom: line.describe('下沿，从左到右。'),
    curve: z.enum(CURVES).optional().describe('上下沿各自怎么走：arc（默认，4 个点以上）用一条三次贝塞尔曲线拟合这些点，像一笔画下来（整体一条弧，最多一个反弯），首尾落在第一个和最后一个点上，中间不逐个经过（实测点带一两像素的误差，逐点经过会把误差画成折角），点不在一条弧上时 warnings 里会说；through 平滑地穿过每个点；straight 直线连接，要尖角（如翼尖）时用。3 个点时 arc 按 through 画。'),
    mirror,
  }),
  z.strictObject({
    type: z.literal('scatter'),
    x: z.number(),
    y: z.number(),
    rx: pos,
    ry: pos.optional(),
    count: z.number().int().min(1).max(PAINT_LIMITS.count),
    radius: range('每个点的 σ 范围 [最小, 最大]（像素）。'),
    peak: range('每个点的中心不透明度范围，默认 [1, 1]。').optional(),
    avoid: z.array(z.strictObject({ x: z.number(), y: z.number(), rx: pos, ry: pos.optional() })).max(16).optional().describe('不放点的椭圆（如眼睛、鼻翼）。'),
    seed: z.number().int().optional().describe('随机种子，同一个种子画出同样的点，默认 1。'),
    mirror,
  }),
  z.strictObject({
    type: z.literal('strands'),
    along: line.describe('发根所在的线（如睫毛根），角度和长度从它的第一个点线性变到最后一个点。'),
    count: z.number().int().min(1).max(PAINT_LIMITS.count),
    length: range('长度 [第一个点处, 最后一个点处]（像素）。'),
    angle: z.tuple([z.number(), z.number()]).describe('方向 [第一个点处, 最后一个点处]（度，0 朝右、-90 朝上）。'),
    radius: range('半径 [发根, 发梢]（像素）。'),
    curl: z.number().optional().describe('发根到发梢转过的角度（度），默认 12。'),
    jitter: z.strictObject({ angle: z.number().min(0).optional(), length: z.number().min(0).optional(), position: z.number().min(0).optional() }).optional().describe('随机扰动：角度 ± 度（默认 6）、长度 ± 比例（默认 0.2）、位置 ± 间距比例（默认 0.3）。'),
    seed: z.number().int().optional(),
    curve: z.enum(CURVES).optional().describe('发根线怎么走（同 stroke 的 curve）；每根发丝都是弯曲的弧，straight 时发丝也是折线。'),
    mirror,
  }),
]);
const paintLayer = z
  .strictObject({
    color: z.union([z.string(), z.tuple([z.number(), z.number(), z.number()])]).optional().describe('颜色 "#RRGGBB" 或 [r, g, b]（0–255）；erase 层不用。'),
    opacity: z.number().min(0).max(1).optional().describe('整层不透明度，默认 1。'),
    blur: z.number().min(0).max(64).optional().describe('整层高斯模糊 σ（像素），默认 0。'),
    erase: z.boolean().optional().describe('擦除：按形状降低下面（base 和前面各层）的不透明度，不上色。'),
    clip: z
      .strictObject({ x_min: z.number().optional(), x_max: z.number().optional(), y_min: z.number().optional(), y_max: z.number().optional(), feather: z.number().min(0).optional() })
      .optional()
      .describe('只保留框内的部分，feather 是边缘渐变的像素数：如整脸贴图里下眼睑粉用 y_min 488、feather 3 清掉眼裂。'),
    shapes: z.array(paintShape).min(1).max(PAINT_LIMITS.shapes),
  })
  .refine((l) => l.erase || l.color !== undefined, { message: 'color is required unless erase is true' });
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
// Picked, not measured: as many states and regions as fit a readable answer.
const MAX_COMPARE_VARIANTS = 6;
const MAX_COMPARE_REGIONS = 6;
// Picked: a held frame that changes by more than this (max luma step in a region) between the first and
// the last baseline was not held (an effect that animates by itself), and the comparison is reported as such.
const DRIFT_MAX = 8;
// Where the eye layout's lid is read: every 15 texture px across the left eye's coded window (lid.py's
// columns, 135–330), and the same columns mirrored for the right eye.
const LID_COLUMNS = Array.from({ length: 14 }, (_, i) => 135 + 15 * i);
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
// Picked, not measured: as many images per image_view call as the old preview tools showed.
const IMAGE_VIEW_MAX = 8;
// Derived: the SDK's stdio transport drops a message over 10 MiB and with it the connection, and six
// animated GIFs from one task's content reached 16 MB of base64 (measured); this leaves room for the text.
const IMAGE_VIEW_BYTES = 8 * 1024 * 1024;
// Cursor ends a tool call that sends nothing for a while ("MCP tool call timed out (idle)", seen on a
// submit_prepare that waited for the page's checks). Picked: well inside the 25 s calls that went through.
const PROGRESS_MS = 5000;
// Appended to official tools whose work overlaps ours, saying which one to reach for.
const OFFICIAL_NOTES = {
  capture_preview:
    '窗口可见时这里就是官方截图：刚改完场景或切换预览视频后，它可能还是改之前的画面；要确认新画面请用 preview_frames（先重置预览、等到重载后的画面再截）。窗口最小化或不可见时，这里改为重置预览后从渲染结果截取。',
  get_scene: '先摸清结构用 scene_tree（紧凑的缩进文本，也能不开窗口直接读下载的工程目录）；要看多个对象的参数用 inspect_many。',
  inspect: '一次看多个对象、按组件类型或属性名过滤、只留关键参数时用 inspect_many（逐个调用本工具并整理结果）。',
  edit_by_dsl: '删除对象时，要连带找出并清理只被它使用的资源和素材包文件夹，用 object_remove（可撤销，资源默认只报告）。',
};

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
const REF_NOTE = '\n\n返回里的图片、视频、音频给的是短引用（*_ref / *_refs，如 img:12、video:3），交给 image_view：图片直接显示，视频和音频返回原地址；引用在 MCP 服务这次运行期间有效。';
const KIND_TEXT = { video: '视频', audio: '音频' };
const failure = (error) => ({ content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true });

async function imageContent(d, { url, file }) {
  try {
    return { type: 'image', ...(url ? await d.fetchImage(url) : await d.readImageFile(file)) };
  } catch (e) {
    return { type: 'text', text: `图片读取失败：${e.message}` };
  }
}

export function createServer(deps = {}) {
  const d = {
    callPlugin,
    listInstances,
    fetchImage,
    readImageFile,
    fetchJson,
    openWithApp,
    prepareIcon,
    cropImage,
    resizeImage,
    jpegToPng,
    framesDir,
    qrPng: (text) => QRCode.toBuffer(text, { width: 360, margin: 2 }),
    // Expiry timers must not keep the process alive after the client goes away.
    schedule: (fn, ms) => setTimeout(fn, ms).unref(),
    sleep,
    openTimeoutMs: 90000,
    closeTimeoutMs: 30000,
    instanceTimeoutMs: 30000,
    saveTimeoutMs: 15000,
    progressMs: PROGRESS_MS,
    ...deps,
  };
  const server = new Server({ name: 'xiangsu-mcp-ext', version: VERSION }, { capabilities: { tools: { listChanged: true } } });
  d.official = d.official ?? new OfficialMcp();
  d.official.onToolsChanged = () => server.sendToolListChanged().catch(() => {});
  const projects = new Projects(d);
  d.downloads = d.downloads ?? new Downloads();
  d.qrCodes = d.qrCodes ?? new QrCodes();
  d.callLog = d.callLog ?? new CallLog();
  d.refs = d.refs ?? new MediaRefs();
  d.spill = d.spill ?? new Spill();
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
  const seenHots = new Seen('UNKNOWN_HOT', 'douyin_hot_list', 'hot_id');
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
  const freshFrames = (projectPath) => d.callPlugin('preview_fresh', {}, { projectPath, timeoutMs: 15000 });
  // A compare region from a calibration's eye boxes for this preview video, in frame fractions.
  const eyeRegion = ({ eye, calibration, pad = 0.3 }, video, frame) => {
    const cal = JSON.parse(fs.readFileSync(calibration, 'utf8'));
    if (cal.layout !== 'eye') throw Error(`CALIBRATION_NOT_EYE: ${calibration} is a ${cal.layout} calibration`);
    const run = cal.runs.find((r) => r.video === video);
    if (!run) throw Error(`VIDEO_NOT_CALIBRATED: ${video ?? '(current video)'} is not in ${calibration}; it has ${cal.runs.map((r) => r.video ?? '(current video)').join(', ')}`);
    const boxes = run.parts.filter((p) => eye === 'both' || p.eye === eye).map((p) => p.box_px);
    const x0 = Math.min(...boxes.map((b) => b[0]));
    const y0 = Math.min(...boxes.map((b) => b[1]));
    const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
    const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
    const [pw, ph] = [(x1 - x0) * pad, (y1 - y0) * pad];
    const fx = (v) => Math.max(0, Math.min(1, v / frame.width));
    const fy = (v) => Math.max(0, Math.min(1, v / frame.height));
    const box = { x: fx(x0 - pw), y: fy(y0 - ph) };
    return { ...box, width: fx(x1 + pw) - box.x, height: fy(y1 + ph) - box.y };
  };
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
  // Homepage works, the asset library and the add-object menu do not depend on the project, so any
  // window serves them (the lowest pid when no target is given).
  const homeWindow = async ({ project_path, instance_id }) => {
    if (project_path !== undefined || instance_id !== undefined) return { projectPath: await projects.resolveProjectPath({ project_path, instance_id }) };
    const pids = d.listInstances().map((s) => s.pid).sort((a, b) => a - b);
    if (!pids.length) throw Error('NO_EDITOR_WINDOW: open any project window first (works are served by the XiangsuMcpExt plugin inside it)');
    return { pid: pids[0] };
  };
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
  const setIcon = async (projectPath, image_path, type = 'both') => {
    const { png, dir } = await d.prepareIcon(image_path);
    try {
      return await d.callPlugin('icon_set', { png_path: png, types: type === 'both' ? ['female', 'male'] : [type] }, { projectPath });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  // Inspirations, tasks and rank boards belong to the account rather than a project, so any window
  // serves them.
  const community = (method) => async (args) => {
    const { project_path, instance_id, ...params } = args;
    return text(await d.callPlugin(method, params, await homeWindow({ project_path, instance_id })));
  };
  const effectKeys = {
    effect_id: z.string().regex(/^\d+$/).describe('my_effects 返回的 effect_id。'),
    app_effect_id: z.string().regex(/^\d+$/).describe('my_effects 返回的同一个特效的 app_effect_id（抖音上的特效 ID）。'),
  };
  // Lists read whole from the plugin and paged here.
  const pageOf = ({ items, ...rest }, offset, count) => {
    const next = offset + count;
    return { ...rest, total: items.length, items: items.slice(offset, next), next_offset: next, has_more: next < items.length };
  };
  const pageShape = {
    offset: z.number().int().min(0).optional().describe('分页起点，取上一页的 next_offset；默认 0。'),
    count: z.number().int().min(1).max(100).optional().describe('每页数量，默认 20。'),
  };
  const subjectKind = z.enum(['effect', 'template']).optional().describe('effect 特效专题榜（默认），template 模板专题榜。');
  const workSort = z.enum(['suggest', 'latest', 'effect_usage', 'project_usage']).optional().describe('排序：suggest 推荐（默认）、latest 最新、effect_usage 特效使用量、project_usage 工程使用量。');
  const workPage = {
    category_id: z.string().optional().describe('works_list 返回的 categories 里的分类 ID；省略时用第一个分类（推荐）。'),
    cursor: z.string().min(1).optional().describe('翻页游标，原样取上一页的 next_cursor；最后一页的 next_cursor 是 null。'),
    count: z.number().int().min(1).max(100).optional().describe('每页数量，默认 20。'),
    sort: workSort,
  };

  const tools = [
    {
      name: 'ext_status',
      description:
        '扩展自身状态：官方 MCP 连接情况，以及每个已加载 XiangsuMcpExt 插件的工程窗口（pid、工程路径、对应的官方 instance_id、编辑器接口自检）。工具报找不到窗口、INCOMPATIBLE_EDITOR 或官方工具不可用时先调它排查；插件只在装好后新打开的工程窗口里生效。',
      shape: {},
      run: async () => {
        const official = await d.official.listTools().then(() => d.official.status());
        const ids = new Map((await projects.officialInstances().catch(() => [])).map((i) => [i.pid, i.instance_id]));
        const windows = [];
        for (const w of await projects.windows()) {
          const self_check = await d
            .callPlugin('self_check', {}, { pid: w.pid, timeoutMs: 5000 })
            .catch((e) => ({ ok: false, error: `${e.message}（该窗口里的插件是旧版本，保存后重开工程窗口即可）` }));
          windows.push({ ...w, instance_id: ids.get(w.pid) ?? null, self_check });
        }
        return text({ official, windows });
      },
    },
    {
      name: 'project_open',
      description: '在新窗口打开一个已有的像塑工程（已经开着就直接返回）。返回窗口 pid 和官方 instance_id。旧版本工程可能弹出升级对话框，需要在编辑器里点确认。',
      shape: { path: z.string().min(1).describe('工程文件夹的绝对路径（含 effect.dyehpj）。') },
      run: async (a) => text(await projects.open(a)),
    },
    {
      name: 'project_new',
      description: '新建一个空白像塑工程并首次保存到 path（目录须不存在或为空）。需要已有任意一个工程窗口开着。返回新窗口的 pid 和官方 instance_id。',
      shape: { path: z.string().min(1).describe('新工程要保存到的文件夹绝对路径。') },
      run: async (a) => text(await projects.create(a)),
    },
    {
      name: 'project_close',
      description: '关闭一个工程窗口（等同工具栏「回到首页」）。有未保存改动时默认拒绝，先 save_project；确实要丢弃改动才传 discard_changes=true。',
      shape: { ...target, discard_changes: z.boolean().optional().describe('丢弃未保存改动直接关闭。') },
      run: async (a) => text(await projects.close(a)),
    },
    {
      name: 'image_view',
      description: `查看图片。列表类工具（素材、作品、灵感、任务、排行榜、音乐等）返回的是短引用 *_ref / *_refs（如 img:12），详情类工具（inspiration_detail 的 images、menu_list details 的 image_url）返回地址，都交给本工具；也可以传本机图片文件的绝对路径（如 menu_list details 的 image_file）。视频和音频引用（video:3、audio:5）看不了画面，返回它的原地址。一次最多 ${IMAGE_VIEW_MAX} 张，只认 png / jpeg / gif / webp，单张失败只在该项写明原因；图片很大（如动图）时一次给不完，没给的列在 not_returned 里，再调用一次即可。`,
      shape: { images: z.array(z.string().min(1)).min(1).max(IMAGE_VIEW_MAX).describe('其它工具返回的引用（img:12）、http(s) 图片地址，或本机图片文件的绝对路径。') },
      run: async ({ images }) => {
        const content = [];
        let bytes = 0;
        let shown = 0;
        for (const src of images) {
          const hit = REF_PATTERN.test(src) ? d.refs.get(src) : null;
          if (REF_PATTERN.test(src) && (!hit || hit.kind !== 'image')) {
            const said = hit ? `${src} 是${KIND_TEXT[hit.kind]}，看不了画面，原地址：${hit.url}` : `图片读取失败：引用 ${src} 已失效（MCP 服务重启过，或是很久以前的列表），重新调用返回它的工具`;
            content.push({ type: 'text', text: `第 ${shown + 1} 张：${src}` }, { type: 'text', text: said });
            shown++;
            continue;
          }
          const where = hit ? hit.url : src;
          const remote = /^https?:\/\//.test(where);
          const img =
            remote || path.isAbsolute(where) ? await imageContent(d, remote ? { url: where } : { file: where }) : { type: 'text', text: '图片读取失败：不是引用、http(s) 地址或绝对路径' };
          const size = img.data ? img.data.length : 0;
          if (shown && bytes + size > IMAGE_VIEW_BYTES) break;
          bytes += size;
          shown++;
          content.push({ type: 'text', text: `第 ${shown} 张：${src}` }, img);
        }
        const rest = images.slice(shown);
        if (rest.length) content.push({ type: 'text', text: JSON.stringify({ not_returned: rest, note: '超出单次体积上限，再调用一次 image_view 看这些' }, null, 2) });
        return { content };
      },
    },
    {
      name: 'library_list',
      refs: true,
      description: `不传 panel_key 时列出可直接应用的分类面板（panel_key）和类型 kind：${LIBRARY_PANELS_TEXT}传 panel_key 时分页列出该面板里的素材：子分类、素材（template_id、title、kind、封面 cover_ref 等）和翻页游标。素材广场的子分类是妆容、图片、实时变脸、跟脸贴纸、前景贴纸、画面特效、3D 模型、3D 饰品；收藏的子分类是全部、美妆、滤镜等目录。没有可应用内容的广场卡片不列出，只在 unsupported 里计数。按画面挑选时把 cover_ref 交给 image_view 看；知道要找什么时用 library_search 按关键词搜，本工具适合按面板和子分类浏览。拿到 template_id 后用 library_apply 应用，AI 图片卡片（kind=ai_image）的整组结果图用 library_images 取。`,
      shape: {
        ...target,
        panel_key: z.string().optional().describe('面板，取不传 panel_key 时返回的 panels 里的 panel_key；省略时只返回面板清单。'),
        category_id: z.string().optional().describe('子分类 ID（收藏为目录名）；省略时用第一个子分类（通常是「全部」）。'),
        cursor: z.union([z.number().int().min(0), z.string()]).optional().describe('翻页游标，原样取上一页的 next_cursor（收藏是字符串）。'),
        count: z.number().int().min(1).max(100).optional().describe('每页数量，默认 20。'),
      },
      run: async (a) => {
        if (a.panel_key !== undefined) return library('library_list')(a);
        const { project_path, instance_id } = a;
        return text(await d.callPlugin('library_nav', {}, await homeWindow({ project_path, instance_id })));
      },
    },
    {
      name: 'library_search',
      refs: true,
      description:
        '按关键词搜索官方素材库（美妆、滤镜、脸部变形、AI 实时变脸、贴纸、画面特效、音效、素材广场等）。除了标题匹配，词正好是面板名或子分类名时也带出那里的素材：「滤镜」→ 滤镜面板，「腮红」→ 美妆/腮红、跟脸贴纸/腮红（这些素材标题里多半没有这个词），「复古滤镜」→ 滤镜/复古；每个面板或子分类最多 300 条。结果按标题完全相同 > 标题开头 > 标题包含 > 分类匹配 > 其余排序，每条的 matched 说明命中方式（title、category:面板/分类、panel:面板）。queries 一次搜多个近义词（最多 8 个）并合并去重。按 offset / count 分页（结果缓存 10 分钟，翻页不重新请求），每条带 template_id、title、panel_key、kind、cover_ref，另返回 total、by_panel（各面板条数，可再用 panel_key 缩小）、matched_categories（展开了哪些分类）、related_categories（名字里含这个词、没有展开的分类，可用 library_list 列出）。kind：package 素材包、ai_image AI 图片、ai_makeup AI 妆容、custom_gan 自定义实时变脸、foreground_sticker 前景贴纸、face_sticker 跟脸贴纸、filter 滤镜。',
      shape: {
        ...target,
        query: z.string().min(1).optional().describe('搜索关键词，如「芒果脸」「腮红」「复古滤镜」。与 queries 二选一。'),
        queries: z.array(z.string().min(1)).min(1).max(8).optional().describe('一次搜多个词并合并，如 ["冷艳", "猫眼", "烟熏", "风格妆"]。与 query 二选一。'),
        panel_key: z.string().optional().describe('只搜这个面板（library_list 不传 panel_key 时返回的 panel_key，如 aigc_material）。'),
        offset: z.number().int().min(0).optional().describe('分页起点，取上一页的 next_offset；默认 0。'),
        count: z.number().int().min(1).max(200).optional().describe('每页数量，默认 20。'),
      },
      run: library('library_search'),
    },
    {
      name: 'library_images',
      refs: true,
      description:
        '一张 AI 图片卡片（kind=ai_image）的整组结果图 image_ref，按 image_index 编号；用 image_view 看图，应用时用 library_apply 的 image_index 选择。template_id 须来自本会话的 library_list / library_search。',
      shape: { ...target, template_id: z.string().describe('library_list / library_search 返回的 template_id。') },
      run: async ({ project_path, instance_id, template_id }) => {
        const { slim, raw } = seenLib.get(template_id);
        const images = await d.callPlugin('library_images', { item: raw }, await homeWindow({ project_path, instance_id }));
        return text({ template_id: slim.template_id, title: slim.title, images });
      },
    },
    {
      name: 'library_apply',
      description:
        '把一个官方素材应用到目标工程，与素材库面板里点应用相同（可撤销）：素材包下载、校验 MD5、导入并默认放进场景；素材广场的卡片按 kind 走编辑器自己的应用流程（AI 图片、AI 妆容等只下载现成结果，不重新生成、不扣额度），等对象出现在场景里才返回。返回 kind、added_objects（新放进场景的对象名和 object_path）和 package_folders。template_id 须来自本会话的 library_list / library_search。应用后用 capture_preview 验收。',
      shape: {
        ...target,
        template_id: z.string().describe('library_list / library_search 返回的 template_id。'),
        auto_instantiate: z.boolean().optional().describe('是否放进场景，默认 true；false 时只导入资源面板（只有 kind=package 支持）。'),
        image_index: z.number().int().min(0).optional().describe('kind=ai_image 时用第几张结果图，默认 0；整组图见 library_images。'),
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
      description: '分页列出像塑首页「模板」某个分类下的作品。首页作品是完整的像塑工程（官方工程和用户投稿），可下载到本地阅读、学习其场景和脚本做法；任意一个工程窗口开着即可。每次都带上全部分类 categories（推荐、官方工程、新手必做、游戏、妆容、AI玩法等）。每条作品有 template_id、标题、标签、已发布到抖音的特效 ID 和发布量（effect_id / publish_count，没有则为 null）、使用量、工程包大小、封面 cover_ref 和动图 gif_ref（交给 image_view 看）。拿到 template_id 后用 works_download 下载工程。',
      shape: { ...target, ...workPage },
      run: works('works_list'),
    },
    {
      name: 'works_search',
      refs: true,
      description:
        '按作品名搜索首页作品（与首页搜索框同一个接口）。不给 category_id 时搜全部分类并合并去重：「推荐」翻到底只有约 300 条，「美化」「友友天地」等分类里还有它没有的作品。合并顺序是先「推荐」里的（按 sort），再按分类顺序追加只在其它分类出现的；每个分类最多 300 条。每条带 found_in（出现在哪些分类），另返回 total、by_category（各分类条数）。queries 一次搜多个词（最多 8 个）并合并，每条带 matched_queries。按 offset / count 分页，结果缓存 10 分钟，翻页不重新请求。某个分类翻页时服务端一直给同一页，会列在 incomplete 里。其余字段同 works_list。按特效 ID 查用 works_by_effect。',
      shape: {
        ...target,
        query: z.string().min(1).optional().describe('作品名关键词，如「合掌」「转场」「换装」。与 queries 二选一。'),
        queries: z.array(z.string().min(1)).min(1).max(8).optional().describe('一次搜多个词并合并，如 ["头套", "头饰"]。与 query 二选一。'),
        category_id: z.string().optional().describe('只搜这个分类（works_list 返回的 categories 里的分类 ID）；省略时搜全部分类。'),
        offset: z.number().int().min(0).optional().describe('分页起点，取上一页的 next_offset；默认 0。'),
        count: z.number().int().min(1).max(200).optional().describe('每页数量，默认 20。'),
        sort: workSort,
      },
      run: works('works_search'),
    },
    {
      name: 'works_by_effect',
      refs: true,
      description:
        '按特效 ID 查排行榜等处给出的特效（rank_list / rank_subject_detail / rank_innovation / effect_search 的 effect_id）在首页有没有工程，与首页搜索框「特效ID」搜索同一个接口。逐个返回 status：found 首页有这个特效的工程；same_style 首页没有它，但像塑移动版「做同款」按钮指向首页上的一个工程（same_style 给出那个工程所属特效的 effect_id 和名称，常常是别人的另一个特效，如「顶美精致淡妆感」指向「可可裸妆」，不是这个特效本身的工程）；same_name 首页没有它、也没有做同款工程，只有同名作品（effect_id 不同，可能是别人的同名作品，不能当成同一个特效）；not_on_homepage 拿不到工程。做同款工程不在首页时 same_style 仍会给出，status 按同名作品的查找结果。found、same_style 和 same_name 的作品在 items 里（字段同 works_list），template_id 可直接用于 works_download / works_open。默认在「推荐」里查：按特效 ID 查时「推荐」也能查到只在其它分类出现的作品，在别的分类里按 ID 查反而查不到，所以一般不用给 category_id。每个特效一到四次请求。',
      shape: {
        ...target,
        effects: z
          .array(
            z.object({
              effect_id: z.string().regex(/^\d+$/).describe('特效 ID，如 rank_list 返回的 effect_id。'),
              name: z.string().min(1).optional().describe('特效名；给了才会在查不到 ID 时找同名作品。'),
            }),
          )
          .min(1)
          .max(20)
          .describe('要查的特效，最多 20 个（一页排行榜）。'),
        category_id: workPage.category_id,
      },
      run: works('works_by_effect'),
    },
    {
      name: 'works_download',
      description:
        '下载一个首页作品的完整工程并解压（与在首页点开作品同一流程，但不打开窗口），返回工程目录和文件清单（files 列出相对路径和大小，可直接读取 effect.dyehpj、Assets 下的场景、Graph 下的脚本等来学习做法）。dest 给定时把工程放到该目录（须不存在或为空，跳过 Library 缓存），像塑临时目录里的那份随即删除。下载的工程（含 dest）都会登记，expires_at（24 小时）后在下次下载时自动删除；学完请立即调用 works_cleanup。要在编辑器里看效果用 works_open。作品版权归原作者，只用于学习参考，不要复制进自己的工程或仓库。',
      shape: {
        ...target,
        template_id: z.string().describe('works_list / works_search / works_by_effect 返回的 template_id。'),
        dest: z.string().optional().describe('工程要放到的文件夹绝对路径（须不存在或为空）；省略时留在像塑的临时目录。'),
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
      description:
        '下载一个首页作品并在新的编辑器窗口里打开，与在首页点开作品同一流程（不弹版本升级提示，工程处于未保存状态）。返回窗口 pid、官方 instance_id 和工程目录，之后可用 get_scene、capture_preview 等官方工具观察它的做法。看完用 project_close（discard_changes=true）关窗，再 works_cleanup 删除下载；窗口开着时工程不会被删除。',
      shape: { ...target, template_id: z.string().describe('works_list / works_search / works_by_effect 返回的 template_id。') },
      run: async (a) => {
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
      description: '删除 works_download / works_open 下载过的作品工程（像塑临时目录里的和 dest 副本）。省略 paths 时删除全部；编辑器窗口正开着的会保留并在 kept_open 里列出，关窗后再调用即可。只删登记过的下载，其它路径一律拒绝。',
      shape: { paths: z.array(z.string().min(1)).min(1).optional().describe('只删这些下载（works_download / works_open 返回的 project_path）；省略时删除全部。') },
      run: async ({ paths }) => {
        const out = d.downloads.cleanup({ paths, openPaths: await openPaths() });
        return text({ ...out, remaining: d.downloads.list().map((e) => e.path) });
      },
    },
    {
      name: 'icon_set',
      description:
        '设置特效图标（提交特效必需）：把一张图片居中裁成正方形、缩放到 360×360 PNG，写进工程的 Icon/ 目录（与「图标制作」窗口保存的同一批文件），并和那个窗口的「完成」按钮一样把图标上传到抖音特效平台（提交窗口只认上传过的图标）。默认女性、男性两个图标位都用这张图（提交窗口要这两个）。上传失败报 ICON_UPLOAD_FAILED，重试即可。图片可以来自 generate_image 生成的资源，或 capture_preview 截图另存的文件。之后 save_project 落盘。',
      shape: {
        ...target,
        image_path: z.string().min(1).describe('图片的绝对路径（png / jpg / webp 等 sips 能读的格式）。'),
        type: z.enum(['both', 'female', 'male', 'common']).optional().describe('写哪个图标位：both（默认，女性和男性两个位都用这张图，提交窗口要的就是这两个）、female、male，或 common 通用。'),
      },
      run: async (a) => {
        const { project_path, instance_id, image_path, type } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        return text(await setIcon(projectPath, image_path, type));
      },
    },
    {
      name: 'icon_open',
      description: '打开编辑器的「图标制作」窗口（官方图标模板、文字模板、AI 图标），让用户在里面挑选或调整。',
      shape: { ...target },
      run: plugin('icon_open'),
    },
    {
      name: 'effect_check',
      description:
        '特效检测，和在编辑器工具栏点「特效检测」一样：打开「特效检测」窗口，由窗口把特效包上传到抖音做云端检测（不是发布），等待结果 passed / not_passed / needs_optimization / failed。出结果后读出检测页的详情一起返回：verdict（页面结论，如「检测通过」「特效不通过」）、checks（每项检测的结论；包体积、帧率给出 figures：数值、上限、是否达标，帧率分 android / ios；没通过的项带页面给的改进建议 advice，读不到时写 advice_unavailable），然后关掉这个窗口（window_closed=true）；详情读不出来时窗口留着，返回 details_error。超过 timeout_ms 还没出结果时返回 timeout，窗口留着继续检测；之前调用留下的检测窗口会先关掉再开新的（closed_previous 是关掉的个数），所以窗口不会越叠越多。',
      shape: {
        ...target,
        timeout_ms: z.number().int().min(10000).max(1800000).optional().describe('最长等待时间，默认 300000（5 分钟）。'),
      },
      run: async (a) => {
        const { project_path, instance_id, timeout_ms = 300000 } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        return text(await d.callPlugin('effect_check', { timeout_ms }, { projectPath, timeoutMs: timeout_ms + 30000 }));
      },
    },
    {
      name: 'submit_prepare',
      description:
        '填好提交窗口，停在最后一步等用户点「提交审核」：先在本地检查提交流程会拒收的情况（包体上限、是否原样套用模板、登录、图标），全部通过后先关掉还开着的提交窗口（之前调用留下的，closed_previous 是关掉的个数，关不掉报 WINDOW_NOT_CLOSED），再走和工具栏「提交特效」按钮相同的入口打开一个新的，然后逐页填写：「特效基础信息」页填名称、触发提示、默认摄像头方向（图标来自工程，可先用 icon_image 设好），「特效发布设置」页选灵感和任务，再翻到「提交审核」页，等页面上的检测（包体积、性能、相似度等，一般一分钟内）跑完，返回页面摘要、各检测结果、是否已同意创作者协议、「提交审核」按钮是否可点，以及 next（用户还要做什么）。本工具不会勾选协议，也不会点「提交审核」，发布只在用户点了之后发生。每一项都从页面读回核对：页面截断、报错、没选上、或翻页被拦住时直接报错（SUBMIT_*，原样带上页面提示），窗口保持打开。页面上本工具没填的其它设置（如活动、创新声明）列在 other_sections 里，保持页面原样。本地检查未通过时不打开窗口，返回 issues。',
      shape: {
        ...target,
        name: z.string().min(1).describe('特效名称（必填）：最多 10 个字，两个英文字母或数字算一个字，不能有表情和特殊符号；页面截断或报错时整次调用失败。'),
        trigger_hint: z.string().optional().describe('特效触发提示，开拍时显示，如「张嘴试试」：最多 10 个字；省略时保留页面带出的内容，传空串清空。'),
        camera: z.enum(['front', 'back']).optional().describe('默认摄像头方向：front 前置、back 后置；省略时保留页面的默认（一般是前置）。'),
        icon_image: z.string().min(1).optional().describe('先用这张图设图标（同 icon_set 的默认：女性、男性两个位，并上传），再打开提交窗口；省略时用工程现有的图标。'),
        inspiration: z
          .string()
          .min(1)
          .optional()
          .describe('「灵感绑定」要选的灵感或热点，取它在列表里显示的名称（当前账号收藏的灵感或热点，名称同 inspiration_list 的标题）；传「暂不绑定」解绑；省略时保留页面带出的（inspiration_bind 绑定过的会自动带出）。'),
        task: z.string().min(1).optional().describe('「任务绑定」要选的任务标题（已领取的任务，同 tasks_list 的 title）；传「暂不参与」解绑；省略时保留页面带出的（task_bind 绑定过的会自动带出）。'),
        task_track: z.string().min(1).optional().describe('任务下的赛道名称，任务分赛道时必填，否则报 SUBMIT_TASK_NEEDS_TRACK 并列出赛道。'),
      },
      run: async (a) => {
        const { project_path, instance_id, icon_image, ...fill } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        if (icon_image !== undefined) await setIcon(projectPath, icon_image);
        return text(await d.callPlugin('submit_prepare', fill, { projectPath, timeoutMs: 360000 }));
      },
    },
    {
      name: 'mobile_preview',
      description:
        '手机预览：按工具栏「手机预览」的方式打包当前工程并上传到抖音的预览服务，返回和编辑器弹出的一样的二维码图片（及其文本、有效期），用抖音 App 扫码即可在真机上看效果。二维码同时存成文件 qr_file，可直接给用户扫，不要另存到别处：到期（expires_at，一般 7 天）后自动删除。会把特效包上传到抖音服务器；内容审核不通过时报 MOBILE_PREVIEW_MODERATION_FAILED。',
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
      description: '分页列出某个分类下的灵感（灵感是官方和创作者发布的特效创意，首页右侧「灵感」页签就是它）：inspiration_id、标题、标签（如「激励」）、作者、收藏数、是否已收藏、是否 AI 灵感、关联热点 hotspot、封面 cover_ref（交给 image_view 看）。每次都带上全部分类 tabs。拿到 inspiration_id 后用 inspiration_detail 看详情。',
      shape: {
        ...target,
        tab: z.string().optional().describe('分类名，取上次返回的 tabs 里的一个（全部、热门音源、头饰、变形等）；省略时用第一个（全部）。'),
        cursor: z.number().int().min(0).optional().describe('翻页游标，取上一页的 next_cursor。'),
        // The server answers code 1 at 100 (measured); 50 works.
        count: z.number().int().min(1).max(50).optional().describe('每页数量，默认 20。'),
      },
      run: community('inspiration_list', (out) => out.items),
    },
    {
      name: 'inspiration_detail',
      description: '一个灵感的详情：玩法说明、特效类型、激励说明、全部图片的地址 images（用 image_view 看）、作者、奖励（金额、说明、时间）、关联热点（热度和标签，如「66条热点相关灵感」）、关联官方工程、已有的同灵感特效及发布量、示例视频 videos（抖音视频的播放地址 url、封面 cover_url、作者、点赞数、尺寸）、贴纸 stickers，以及当前账号是否已收藏和总收藏数。',
      shape: { ...target, inspiration_id: z.string().min(1).describe('inspiration_list / rank_hotspots / task_detail 返回的 inspiration_id，或像塑 / 抖音 App 灵感页里的灵感 ID。') },
      run: community('inspiration_detail'),
    },
    {
      name: 'inspiration_collect',
      description: '收藏或取消收藏一个灵感（写入当前登录账号，与灵感详情页的收藏按钮相同），之后重新查询收藏状态确认生效。',
      shape: {
        ...target,
        inspiration_id: z.string().min(1).describe('要收藏的 inspiration_id。'),
        collect: z.boolean().optional().describe('true 收藏（默认），false 取消收藏。'),
      },
      run: community('inspiration_collect'),
    },
    {
      name: 'inspiration_bind',
      description:
        '按 inspiration_id 把一条创作灵感绑定到当前工程（编辑器给 agent 的同一接口），之后 save_project 落盘，打开提交窗口时会自动带出。只在提交时选灵感的话，也可以直接给 submit_prepare 传 inspiration：它在提交窗口的下拉里按名称选，只列当前账号收藏的灵感和热点。',
      shape: { ...target, inspiration_id: z.string().min(1).describe('要绑定的 inspiration_id。') },
      run: plugin('inspiration_bind'),
    },
    {
      name: 'tasks_list',
      refs: true,
      description:
        '按 offset / count 分页列出首页活动中心的活动和特效征集任务：标题、状态（如 WAIT_RECEIVE 待领取 / WAIT_SUBMIT 待提交）、是否已领取、状态说明（如「查看官方指导，帮您完成任务」）、剩余天数、收益、上下线时间、可完成次数。拿到 task_id 后用 task_detail 看详情、task_receive 领取、task_bind 绑定到工程（bindable=true 的才能绑）。成长任务用 growth_tasks_list。',
      shape: { ...target, ...pageShape },
      run: async ({ project_path, instance_id, offset = 0, count = 20 }) => text(pageOf(seenTasks.keep(await d.callPlugin('tasks_list', {}, await homeWindow({ project_path, instance_id }))), offset, count)),
    },
    {
      name: 'growth_tasks_list',
      refs: true,
      description: '按 offset / count 分页列出活动中心里的成长任务：task_id、标题、奖励金额 bonus_yuan、标签、是否新手任务、参考工程。详情（参考工程、相关灵感、教程）用 growth_task_detail；特效师等级和每级目标进度在 growth_route。',
      shape: { ...target, ...pageShape },
      run: async ({ project_path, instance_id, offset = 0, count = 20 }) => text(pageOf(seenGrowth.keep(await d.callPlugin('growth_tasks_list', {}, await homeWindow({ project_path, instance_id }))), offset, count)),
    },
    {
      name: 'task_detail',
      refs: true,
      description:
        '一个特效征集任务的详情：状态、奖励时间、下线时间、我提交到这个任务的特效 my_effects（名称、effect_id、审核状态、拍摄数、播放数、投稿峰值、获奖金额、任务评定 task_state（pending 待评定，任务页不显示标签；unfinished 任务未完成；done 任务已完成；认不出的值原样给）和 off_theme（任务页标了「主题不符合」）、赛道）、完成状态、是否分档任务，和整理过的任务说明 content：每个内容块（参与要求、奖项详情、近期热门、任务说明等）有名称 name、条目 items 和链接 links；条目有标题 title、正文 text（页面里的链接标记已换成文字，链接放进 links）、参考图 image_refs 和参考视频 video_refs，奖项条目另有页面原样给的金额 money、发放方式 money_mode 和名额 people（unlimited 为不限）；空地址和 blob: 地址任务页里也显示不出来，只在 unusable_media 里计数；读不懂的字段原样放进 unread。要原始返回时传 save_to。task_id 须来自本会话的 tasks_list；活动没有详情，成长任务用 growth_task_detail。只看所有任务里自己作品的评定，用 my_task_status 一次取全。',
      shape: { ...target, task_id: z.string().min(1).describe('tasks_list 返回的 task_id。'), save_to: saveTo.describe('把接口的原始返回另存到这个目录（绝对路径），文件名 task_detail-<task_id>.json，长期保留。') },
      run: async (a) => {
        const { project_path, instance_id, task_id, save_to } = a;
        const t = seenTasks.get(task_id);
        if (t.raw.kind === 'activity') throw Error(`NO_TASK_DETAIL: ${task_id} is an activity; only effect tasks have details`);
        const { raw, ...out } = await d.callPlugin('task_detail', { id: t.raw.item_id }, await homeWindow({ project_path, instance_id }));
        if (save_to === undefined) return text({ task_id, ...out });
        const file = saveFile(save_to, `task_detail-${task_id}.json`, JSON.stringify(raw ?? out, null, 2));
        return text({ task_id, ...out, raw_saved_to: file });
      },
    },
    {
      name: 'growth_task_detail',
      refs: true,
      description: '一个成长任务的详情：标题、奖励、标签、参考工程、相关灵感（封面 cover_ref）和教程。task_id 须来自本会话的 growth_tasks_list。',
      shape: { ...target, task_id: z.string().min(1).describe('growth_tasks_list 返回的 task_id。') },
      run: async ({ project_path, instance_id, task_id }) => {
        seenGrowth.get(task_id);
        return text({ task_id, ...(await d.callPlugin('growth_task_detail', { id: task_id }, await homeWindow({ project_path, instance_id }))) });
      },
    },
    {
      name: 'task_receive',
      description: '领取一个征集任务（写入当前登录账号，与活动中心的「领取」按钮相同，领取后不能撤销）。只有状态为 WAIT_RECEIVE 的任务能领，其它状态直接拒绝。返回 designer_task_id 和新状态；领取后重新 tasks_list，该任务即可 task_bind。',
      shape: { ...target, task_id: z.string().min(1).describe('tasks_list 返回的任务 task_id。') },
      run: async (a) => {
        const { project_path, instance_id, task_id } = a;
        const t = seenTasks.get(task_id);
        if (t.raw.kind !== 'task') throw Error(`TASK_NOT_RECEIVABLE: ${task_id} is not an effect task (kind=${t.raw.kind})`);
        return text({ task_id, ...(await d.callPlugin('task_receive', { item_id: t.raw.item_id }, await homeWindow({ project_path, instance_id }))) });
      },
    },
    {
      name: 'task_bind',
      description:
        '把工程绑定到一个已领取的任务，和从任务详情页点「去创作」打开的工程一样，提交时会带上该任务。编辑器只在打开工程时写入任务信息，所以本工具会先关闭该工程的窗口（有未保存改动时拒绝，先 save_project），再带着任务信息重新打开，返回新的 pid 和 instance_id。task_id 须来自本会话的 tasks_list。只在提交时选任务的话，直接给 submit_prepare 传 task（已领取任务的标题），不用重开窗口。',
      shape: {
        path: z.string().min(1).describe('工程文件夹的绝对路径。'),
        task_id: z.string().min(1).describe('tasks_list 返回的 task_id（须 bindable=true）。'),
      },
      run: async ({ path: projectDir, task_id }) => {
        const t = seenTasks.get(task_id);
        if (!t.raw.extra) throw Error(`TASK_NOT_RECEIVED: ${task_id}; receive it with task_receive first`);
        const open = (await projects.windows()).some((w) => w.project_path && fs.existsSync(w.project_path) && fs.realpathSync(w.project_path) === fs.realpathSync(projectDir));
        if (open) await projects.close({ project_path: projectDir });
        return text({ task: t.slim, ...(await projects.open({ path: projectDir, activity: t.raw.extra })) });
      },
    },
    {
      name: 'growth_route',
      description:
        '像塑移动版的「成长之路」：当前账号的特效师等级 current_level，以及每一级（新手特效师、潜力特效师……大师特效师）的现金奖励、状态（done 已完成 / in_progress 进行中 / locked 未解锁）和要达成的目标：每个目标的说明（如「绑定「灵感」上线 0/3 个作品」）、当前进度 current / 目标 target、对应奖励。最高级给的是权益 rights。任意一个工程窗口开着即可，用编辑器里登录的账号读取。活动中心里一个个带参考工程和教程的成长任务用 growth_tasks_list。',
      shape: { ...target },
      run: community('growth_route'),
    },
    {
      name: 'rank_list',
      refs: true,
      description: '分页读取一个排行榜（与像塑移动版排行榜页同一个接口）：名次、特效名、effect_id、等级、投稿量（峰值 / 累计）、跟拍量、男女比例、年轻喜爱度、热玩分、总收益等。可按日期、分类（每级一个，如只看「人像美化 › 美妆」）和筛选项过滤，每页都带上该榜当天的分类 categories（level 1 大类如人像美化、游戏玩法、人设扮演、AI 玩法，level 2 细类如基础头饰、测一测、不露脸壁纸；每个榜不同）。按主题的专题榜（如「热爆美妆特效榜」）见 rank_subjects。要看某个特效的工程，把 effect_id 和 name 交给 works_by_effect，查它在不在首页。',
      shape: {
        ...target,
        rank_type: z.number().int().optional().describe(`榜单：${RANK_TYPE_TEXT}；默认 1。`),
        date: z.string().optional().describe('榜单日期 YYYY-MM-DD，默认最新一期。'),
        categories: z.array(z.string()).max(3).optional().describe('分类名，取上一页返回的 categories，每级最多一个，可叠加，如 ["人像美化","美妆"]（大类 + 细类）。'),
        levels: rankFilter('levels').describe('特效等级，如 ["S","A+"]。'),
        panels: rankFilter('panels').describe('面板，如 ["头饰","美妆"]。'),
        preferences: rankFilter('preferences').describe('偏好。'),
        tools: rankFilter('tools').describe('来自工具。'),
        young_like_scores: z.array(z.number().int().min(1).max(10)).optional().describe('年轻喜爱度 1–10。'),
        cursor: z.number().int().min(0).optional().describe('翻页游标，取上一页的 next_cursor。'),
        // The server answers code 1 above 20 (measured).
        count: z.number().int().min(1).max(20).optional().describe('每页数量，默认 20（最大 20）。'),
      },
      run: community('rank_list'),
    },
    {
      name: 'rank_hotspots',
      refs: true,
      description: '热点榜（按热度排序的抖音热点，每小时更新），按 offset / count 分页：名次、topic_id、标题、说明、热度、相关灵感数、封面 cover_ref。一个热点下的灵感用 hotspot_inspirations。抖音全站的实时热点榜见 douyin_hot_list。',
      shape: { ...target, ...pageShape },
      run: community('rank_hotspots'),
    },
    {
      name: 'hotspot_inspirations',
      refs: true,
      description: '一个热点下的灵感，按热点页的页签分组：每条的 inspiration_id、标题、标签、说明、封面 cover_ref（交给 image_view 看）。详情用 inspiration_detail。',
      shape: { ...target, topic_id: z.string().min(1).describe('rank_hotspots 返回的 topic_id。') },
      run: community('hotspot_inspirations'),
    },
    {
      name: 'douyin_hot_list',
      description:
        '抖音实时热点榜（像塑移动版「实时热点」同一接口，约 5 分钟一版）：前 20 条的 hot_id、名次、名称、分类 categories（娱乐、站内玩法、话题互动、二次元等；「站内玩法」多是正在火的梗、手势舞和跟拍玩法）、热度文字。榜单版本时间 updated_at。看一个热点的热度走势和站内已有特效数用 douyin_hot_detail，看它的热门视频用 douyin_hot_videos。像塑官方挑过、适合做特效的话题见 rank_hotspots。',
      shape: { ...target },
      run: async ({ project_path, instance_id }) => text(seenHots.keep(await d.callPlugin('douyin_hot_list', {}, await homeWindow({ project_path, instance_id })))),
    },
    {
      name: 'douyin_hot_detail',
      description:
        '一个抖音实时热点的详情（像塑移动版「热点详情」页同一接口）：名称、分类、上榜时间 listed_at_text、站内已有的特效数 effects_text（如「上线特效0个，等级特效0个」，0 说明还没人做）、近 7 天每天的热度 days 和今天每小时的热度 hours（heat 数值、heat_text 页面文字）。hot_id 须来自本会话的 douyin_hot_list。服务端偶尔答「网络开小差了」，隔几秒再调。',
      shape: { ...target, hot_id: z.string().regex(/^\d+$/).describe('douyin_hot_list 返回的 hot_id。') },
      run: async ({ project_path, instance_id, hot_id }) => {
        const { raw } = seenHots.get(hot_id);
        return text(await d.callPlugin('douyin_hot_detail', { hot_id, ...raw }, await homeWindow({ project_path, instance_id })));
      },
    },
    {
      name: 'douyin_hot_videos',
      refs: true,
      description: '一个抖音实时热点下的热门视频（像塑移动版「热点详情」页同一接口）：视频 ID、播放地址 video_ref、封面 cover_ref、点赞数、作者（昵称、头像）。用来看这个梗、玩法实际怎么拍。hot_id 须来自本会话的 douyin_hot_list。',
      shape: { ...target, hot_id: z.string().regex(/^\d+$/).describe('douyin_hot_list 返回的 hot_id。') },
      run: async ({ project_path, instance_id, hot_id }) => {
        const { raw } = seenHots.get(hot_id);
        return text(await d.callPlugin('douyin_hot_videos', { hot_id, ...raw }, await homeWindow({ project_path, instance_id })));
      },
    },
    {
      name: 'baidu_hot_list',
      refs: true,
      description: '百度热搜榜（top.baidu.com，不用登录、不用开像塑）：置顶条 pinned 和 50 条热搜，每条有名次、词、摘要、热度、配图 image_ref、链接 link，榜单更新时间 updated_at。看站外正在发生的社会、娱乐话题。',
      shape: {},
      run: async () => text(await baiduHotList(d.fetchJson)),
    },
    {
      name: 'bilibili_popular',
      refs: true,
      description: 'B 站「热门」视频（不用登录、不用开像塑）：标题、BV 号、链接、封面 cover_ref、分区、UP 主、播放 / 点赞 / 评论 / 弹幕数、时长、发布时间、上热门的理由（如「百万播放」）。按 page 翻页。看年轻人在 B 站追的梗和内容。',
      shape: {
        page: z.number().int().min(1).optional().describe('页码，默认 1，取上一页的 next_page。'),
        count: z.number().int().min(1).max(BILIBILI_POPULAR_MAX).optional().describe(`每页数量，默认 20（最大 ${BILIBILI_POPULAR_MAX}）。`),
      },
      run: async (a) => text(await bilibiliPopular(a, d.fetchJson)),
    },
    {
      name: 'bilibili_hot_search',
      description: 'B 站搜索框下的热搜词（不用登录、不用开像塑）：名次、关键词、展示名、热度分，更新时间 updated_at。',
      shape: {},
      run: async () => text(await bilibiliHotSearch(d.fetchJson)),
    },
    {
      name: 'rank_subjects',
      refs: true,
      description: '像塑移动版「专题合集」里按主题的榜单，最新的在前，按 cursor 翻页：kind=effect 为特效专题榜（近 200 期，如「测一测玩法特效榜 - 11月」「热爆美妆特效榜」「熊出没IP特效榜」「主题创新优胜特效榜」、各期征集活动优质特效），kind=template 为模板专题榜（如「歌词玩法模板榜」「AI配文创意模板榜」「氛围转场模板榜」）。每个榜带前几个特效、浏览量。按榜名搜用 rank_subjects_search，一个榜的全部特效用 rank_subject_detail。',
      shape: {
        ...target,
        kind: subjectKind,
        cursor: z.number().int().min(0).optional().describe('翻页游标，取上一页的 next_cursor。'),
        // The server answers code 1 above 20 (measured).
        count: z.number().int().min(1).max(20).optional().describe('每页数量，默认 20（最大 20）。'),
      },
      run: community('rank_subjects'),
    },
    {
      name: 'rank_subjects_search',
      refs: true,
      description: '按榜名在「专题合集」的全部期里搜索（服务端没有搜索，逐页读完再过滤），返回全部匹配的榜，不分页；每个榜带前几个特效、浏览量。',
      shape: { ...target, kind: subjectKind, keyword: z.string().min(1).describe('榜名里的词，如「美妆」「测一测」「IP」「热梗」。') },
      run: community('rank_subjects_search'),
    },
    {
      name: 'rank_subject_detail',
      refs: true,
      description: '「专题合集」里一个榜的全部特效（最多 20 个）：特效名、effect_id、app_effect_id、图标、说明。',
      shape: { ...target, subject_id: z.string().min(1).describe('rank_subjects 或 rank_subjects_search 返回的 subject_id。') },
      run: community('rank_subject_detail'),
    },
    {
      name: 'rank_innovation',
      refs: true,
      description: '创新计划的官方精选（像塑移动版发现页的精选列表，移动版展示的是模板）：特效名、effect_id、标签、投稿量、总收益、入选日期、封面。创作者月榜用 rank_creators。',
      shape: {
        ...target,
        kind: z.enum(INNOVATION_KINDS).optional().describe('template 精选模板（默认），effect 精选特效。'),
        offset: z.number().int().min(0).optional().describe('翻页偏移，取上一页的 next_offset。'),
        count: z.number().int().min(1).max(100).optional().describe('每页数量，默认 20；精选由服务端过滤，实际条数可能略少。'),
      },
      run: community('rank_innovation'),
    },
    {
      name: 'rank_creators',
      description: '创新计划的创作者月榜，按 offset / count 分页：名次、创作者 uid 和昵称、上榜素材数、跟拍量、预计奖金（元）。',
      shape: { ...target, ...pageShape },
      run: community('rank_creators'),
    },
    {
      name: 'my_effects',
      refs: true,
      description:
        '当前登录账号提交过的特效，最新的在前（与像塑移动版「作品」同一个接口）：effect_id、名称、审核状态 status 和 status_text（100 审核中、101 审核未通过、111 测试中、112 测试未通过、120 测试通过、103 已上线、104 已下线、113 延后上线、118 申诉重审中、119 申诉审核未通过）、提交和上线时间、绑定的任务 / 灵感 / 热点、能否编辑 / 删除 / 申诉及申诉类型、投稿量。101、112、119 的特效带 review：最近一条审核记录，text 是去掉标记的原因正文，refuse_reasons 是分条原因，links 是正文里的链接（如审核规则）。完整审核时间线用 my_effect_reviews；把 effect_id 和 app_effect_id 交给 my_effect_data（数据卡片）、my_effect_trend（按天趋势和投稿等级）、my_effect_revenue（收益）。',
      shape: {
        ...target,
        cursor: z.string().min(1).optional().describe('翻页游标，原样取上一页的 next_cursor。'),
        // Picked, not measured: every failed effect on a page costs one or two more requests.
        count: z.number().int().min(1).max(50).optional().describe('每页数量，默认 20（最大 50）。'),
      },
      run: community('my_effects'),
    },
    {
      name: 'my_effect_reviews',
      description:
        '一个自己的特效的审核记录，与像塑移动版「审核记录」页同一组接口：名称、当前状态、绑定的任务，reviews 为「上线审核」时间线（最新的在前，提交成功、审核中、审核未通过等，每条有时间、去掉标记的正文 text、分条原因 refuse_reasons、链接 links），innovation_reviews 为「精选审核」时间线（没有时为空）。',
      shape: { ...target, effect_id: z.string().regex(/^\d+$/).describe('my_effects 返回的 effect_id。') },
      run: community('my_effect_reviews'),
    },
    {
      name: 'my_effect_data',
      refs: true,
      description:
        '一个自己已上线特效的数据卡片，与像塑移动版「作品详情」页同一组接口：名称、类型、各 App 上线情况 apps（抖音 app_id 184、抖音极速版 1164：上线状态、时间、投稿峰值和累计）、用到的功能 functions、标签；数据卡片 figures（页面原样的名称、值和文字：累计曝光、累计投稿、累计播放、累计跟拍、平台判定的特效类型如「技巧比拼」「玩法测试」、特效等级、跟拍等级、年轻喜爱度）；流量状态 traffic（如「流量正常」）；播放数 views（与任务页的播放数同源）；绑定的任务和灵感 related。按天的趋势和投稿等级用 my_effect_trend，收益用 my_effect_revenue。',
      shape: { ...target, ...effectKeys },
      run: community('my_effect_data'),
    },
    {
      name: 'my_effect_trend',
      description:
        '一个自己已上线特效的「数据趋势」和投稿等级（像塑移动版「作品详情」页同一接口）：按天的曝光 exposure 和投稿 publish（逐日累计值，数据隔天才更新，当天为空），累计曝光、试拍 trial_total、跟拍、视频播放；投稿等级 level（当前等级代码 code、当前投稿 publish、下一级代码 next_code、升到下一级还差的投稿 publish_to_next）。等级代码和字母等级的对应没有接口给出，投稿门槛见像塑 App「激励规则」页。',
      shape: {
        ...target,
        ...effectKeys,
        trend: z.enum(Object.keys(TREND_CYCLES)).optional().describe('范围：recent 近 7 日（默认），since_online 上线后。'),
      },
      run: community('my_effect_trend'),
    },
    {
      name: 'my_effect_revenue',
      description: '一个自己已上线特效的收益明细（像塑移动版「作品详情」页同一接口）：总收益、基础等级奖、年轻奖、跟拍奖、精选奖，每项的金额 amount（页面原样）、说明 note（如「暂未达到最低等级」「不符合精选标准」）和是否已解锁。',
      shape: { ...target, ...effectKeys },
      run: community('my_effect_revenue'),
    },
    {
      name: 'my_profile',
      description:
        '当前账号的资料和数字，与像塑移动版「我的」页同一组接口：昵称、粉丝数、是否实名、特效作者 / 模板作者各自的等级 identities；数据卡片 figures（开拍总计、播放总计、本月提交、本月上线、本月收入、累计收入，页面原样的名称、值和文字）；本月数据 month（本月上线数、本月收入、前一天收入、累计收入，其余字段含义未核实，原样放在 unread）。收益明细用 my_revenue。',
      shape: { ...target },
      run: community('my_profile'),
    },
    {
      name: 'my_revenue',
      description: '当前账号的收益，与像塑移动版「钱包」同一接口：累计和某个月的总额、按来源（投稿收益等）的占比和金额、那个月每天的收入。',
      shape: { ...target, month: z.string().regex(/^\d{6}$/).optional().describe('月份 YYYYMM，默认本月。') },
      run: community('my_revenue'),
    },
    {
      name: 'messages_list',
      description:
        '像塑移动版「消息」页的站内信，最新的在前：标题、正文、时间、是否已读、分组（服务 / 官方）、审核类消息的状态和对应的 effect_id、点开的链接 link。包括发布成功、进入测试、上线（「拍摄特效视频可获得更多冷启流量」）、审核未通过、精选审核中、任务完成、获奖公布、成长之路奖金到账等。按 cursor 翻页。',
      shape: {
        ...target,
        group: z.enum(Object.keys(MESSAGE_GROUPS)).optional().describe('all 全部（默认），service 服务（任务完成、获奖公布、精选审核等），official 官方（发布、审核、上线等）。'),
        cursor: z.string().regex(/^\d+$/).optional().describe('翻页游标，原样取上一页的 next_cursor。'),
        count: z.number().int().min(1).max(MESSAGE_MAX).optional().describe(`每页数量，默认 20（最大 ${MESSAGE_MAX}）。`),
      },
      run: community('messages_list'),
    },
    {
      name: 'my_task_status',
      refs: true,
      description:
        '一次列出提交到所有已领取任务里的作品和它们的任务评定（逐个任务读任务详情页的「我的作品」，与 task_detail 的 my_effects 相同）：每条带任务 task_id 和标题、作品名、effect_id、审核状态、拍摄 / 播放 / 投稿峰值、任务评定 task_state（pending 待评定、unfinished 任务未完成、done 任务已完成）和 off_theme（任务页标了「主题不符合」）；summary 按评定计数并统计主题不符合的条数。没交过作品的任务不出现在列表里；每个已领取任务一次请求，按顺序发。',
      shape: { ...target },
      run: community('my_task_status'),
    },
    {
      name: 'effect_detail',
      description:
        '任意一个已上线特效或模板的详情（像塑移动版「发现」页特效详情同一接口，别人的特效也能看）：名称、类型（特效 / 模板）、effect_id、上线时间、等级代码 level_code、累计投稿 / 点赞 / 评论（页面原样文字）、年轻 / 男生喜爱度、热玩分、男女投稿比例、受众（年龄、性别）、风格（如潮酷）、平台判定的类型 category（如「社交测试」「美妆」）、来自哪个工具、流量状态、用到的编辑器能力 functions（如美瞳、屏幕液化、3D 模型动画、辉光、滤镜，看出爆款怎么组合）、作者及等级、几条示例视频（地址和封面）。category、functions、designer、点赞评论数这几块服务端有时不返回（同一个特效连查也会时有时无），缺的给 null，隔一会儿再查；读不懂的字段原样放 unread。用这个特效拍的视频（标题、跟拍数）用 effect_videos，工程用 works_by_effect。',
      shape: { ...target, app_effect_id: z.string().regex(/^\d+$/).describe('特效在抖音上的 ID：rank_list、rank_subject_detail、rank_innovation、effect_search、my_effects 返回的 app_effect_id。') },
      run: community('effect_detail'),
    },
    {
      name: 'effect_videos',
      refs: true,
      description:
        '用一个特效拍的抖音视频（像塑移动版「作品详情」页的视频卡片，别人的特效也能看）：累计点赞和跟拍（页面原样文字），以及几条热门视频 videos（实测 5 条）：抖音视频 ID item_id、标题、作者、点赞、跟拍、封面 cover_ref 和视频 video_ref（交给 image_view 拿地址）。看别人怎么拍、文案怎么写。自己刚上线、还没人拍的特效列表是空的。',
      shape: {
        ...target,
        effect_id: z.string().regex(/^\d+$/).describe('特效 ID（rank_list、effect_search、my_effects 等返回的 effect_id）。'),
        app_effect_id: z.string().regex(/^\d+$/).describe('同一个特效的 app_effect_id。'),
      },
      run: community('effect_videos'),
    },
    {
      name: 'effect_search',
      refs: true,
      description: `按关键词搜索像塑全平台已上线的特效或模板（像塑移动版搜索页同一接口）：effect_id、app_effect_id、名称、说明、等级代码、年轻喜爱度、累计投稿（页面原样文字）、图标 icon_ref。特效最多翻到 100 条。按 cursor 翻页，每页最多 ${SEARCH_MAX} 条。只搜首页工程用 works_search；拿到特效后用 effect_detail 看详情、effect_videos 看视频、works_by_effect 找工程。搜灵感用 inspiration_search，搜教程用 tutorial_search。`,
      shape: {
        ...target,
        query: z.string().min(1).describe('关键词，如「美妆」「测一测」「变装」。'),
        kind: z.enum(EFFECT_SEARCH_KINDS).optional().describe('effect 特效（默认），template 模板。'),
        cursor: z.number().int().min(0).optional().describe('翻页游标，取上一页的 next_cursor。'),
        count: z.number().int().min(1).max(SEARCH_MAX).optional().describe(`每页数量，默认 ${SEARCH_MAX}（最大 ${SEARCH_MAX}，更多服务端报错）。`),
      },
      run: community('effect_search'),
    },
    {
      name: 'inspiration_search',
      refs: true,
      description: `按关键词搜索灵感（像塑移动版搜索页同一接口；inspiration_list 只能按分类翻）：字段同 inspiration_list。按 cursor 翻页，每页最多 ${SEARCH_MAX} 条。`,
      shape: {
        ...target,
        query: z.string().min(1).describe('关键词，如「美妆」「测一测」「变装」。'),
        cursor: z.number().int().min(0).optional().describe('翻页游标，取上一页的 next_cursor。'),
        count: z.number().int().min(1).max(SEARCH_MAX).optional().describe(`每页数量，默认 ${SEARCH_MAX}（最大 ${SEARCH_MAX}，更多服务端报错）。`),
      },
      run: community('inspiration_search'),
    },
    {
      name: 'tutorial_search',
      refs: true,
      description: `按关键词搜索像塑官方教程（像塑移动版搜索页同一接口）：字段同 tutorials_list。按 cursor 翻页，每页最多 ${SEARCH_MAX} 条。`,
      shape: {
        ...target,
        query: z.string().min(1).describe('关键词，如「美妆」「测一测」「变装」。'),
        cursor: z.number().int().min(0).optional().describe('翻页游标，取上一页的 next_cursor。'),
        count: z.number().int().min(1).max(SEARCH_MAX).optional().describe(`每页数量，默认 ${SEARCH_MAX}（最大 ${SEARCH_MAX}，更多服务端报错）。`),
      },
      run: community('tutorial_search'),
    },
    {
      name: 'tutorials_list',
      refs: true,
      description:
        '像塑官方教程（移动版「教程」页同一组接口）：每次都带上全部分类 tabs（特效：新手入门、特效进阶、精选课程、PC工具、工程实操、三方工具、爆款分享、账号运营、视频教程；模板：模板入门、模板进阶等），按 tab_id 列出一个分类的教程，不传时列出全部（约 190 篇，比各分类之和多）。每篇有标题、标签（如「新手必看」「拍视频脚本」）、学习人数、作者、上线日期、是否付费、文档链接 link（飞书文档）、封面 cover_ref 和视频 video_ref（视频教程才有）。按 offset / count 分页。按关键词找教程用 tutorial_search。',
      shape: {
        ...target,
        tab_id: z.number().int().optional().describe('分类 ID，取返回的 tabs 里的 tab_id；省略时列出全部教程。'),
        ...pageShape,
      },
      run: community('tutorials_list'),
    },
    {
      name: 'shoot_activity',
      description:
        '当前账号本期的「拍视频激励」活动（像塑移动版首页活动卡片同一接口，按周重置）：活动名、起止时间、本期拍摄数 shoot_count、收入 income（单位未核实，原样给）、本期任务 tasks（如「拍作品视频发布到抖音」「按照脚本拍摄同款视频」，各自的奖励文字、完成次数）、连续创作打卡 streaks（每档目标次数和奖金）、新手成长任务 newbie（每项的状态和页面文字、全部完成的奖金）、下次重置时间。状态码 status 的含义接口没给，原样给出，结合 text、finish_count 看。拍摄脚本用 shoot_scripts。',
      shape: { ...target },
      run: community('shoot_activity'),
    },
    {
      name: 'shoot_scripts',
      refs: true,
      description: `像塑官方的拍摄脚本（移动版「拍摄脚本」同一接口）：教你用特效拍什么样的视频（如「【测一测】表演有梗结果」「【美妆】带特效前后反差」），每条有脚本 ID、名称、完整说明 description（脚本解读和「尝试拍一个」的具体做法）、标签代码 tags、播放数 views、拍摄数 shoots、封面 cover_ref 和示范视频 video_ref。tag 按标签代码筛选，App 里没有标签名，实测各代码下的脚本：${SCRIPT_TAG_TEXT}。type 是接口给的脚本类型代码，含义也没给出（1 多为技巧合集，2 多为具体演绎）。全部约 50 条，按 offset / count 分页。`,
      shape: {
        ...target,
        tag: z.number().int().optional().describe(`标签代码：${SCRIPT_TAG_TEXT}；省略时全部。`),
        offset: z.number().int().min(0).optional().describe('分页起点，取上一页的 next_offset；默认 0。'),
        count: z.number().int().min(1).max(SCRIPT_MAX).optional().describe(`每页数量，默认 20（最大 ${SCRIPT_MAX}）。`),
      },
      run: community('shoot_scripts'),
    },
    {
      name: 'music_categories',
      description: '抖音音乐库的分类（像塑原创、推荐、抖音收藏、潮流心选等）的 code 和名称，交给 music_list 看分类里的歌。',
      shape: { ...target },
      run: community('music_categories'),
    },
    {
      name: 'music_list',
      refs: true,
      description: '抖音音乐库一个分类的第一页（35 首）：music_id、标题、作者、时长 duration_sec、封面 cover_ref、试听 preview_ref（音频引用）和 has_copyright（音乐库给的版权标记，false 或 null 的不要用于要发布的特效）。分类 code 从 music_categories 取；按关键词找歌用 music_search。',
      shape: { ...target, category_code: z.string().min(1).describe('music_categories 返回的分类 code。') },
      run: async ({ project_path, instance_id, category_code }) => text(seenMusic.keep(await d.callPlugin('music_list', { category_code }, await homeWindow({ project_path, instance_id })), { category_code })),
    },
    {
      name: 'music_search',
      refs: true,
      description: '按关键词搜抖音音乐：每首的 music_id、标题、作者、时长 duration_sec、封面 cover_ref、试听 preview_ref（音频引用）和 has_copyright（false 或 null 的不要用于要发布的特效）。',
      shape: { ...target, query: z.string().min(1).describe('搜索关键词。') },
      run: async ({ project_path, instance_id, query }) => text(seenMusic.keep(await d.callPlugin('music_search', { query }, await homeWindow({ project_path, instance_id })), { category_code: null })),
    },
    {
      name: 'music_apply',
      description:
        '把一首抖音音乐设为特效的音乐，和音乐库里点「使用」相同：下载音频进工程、写入音乐信息，并在场景里加入抖音音乐对象（再次使用会替换上一首）。start_sec / end_sec 截取片段，默认整首。music_id 须来自本会话的 music_list 或 music_search。之后 capture_preview 验收、save_project 落盘。',
      shape: {
        ...target,
        music_id: z.string().min(1).describe('music_list 或 music_search 返回的 music_id。'),
        start_sec: z.number().min(0).optional().describe('片段开始（秒），默认 0。'),
        end_sec: z.number().positive().optional().describe('片段结束（秒），默认整首时长。'),
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
      description:
        '把场景结构输出成紧凑的缩进文本：渲染组，以及每个对象的 guid、名称、是否隐藏、组件类型。比官方 get_scene 的 JSON 好读，适合先摸清结构再用 inspect_many 查参数；要渲染组和对象的完整 JSON 用 get_scene。subtree 只看某个对象（guid 或名称），depth 控制展开层数（默认 6）；没展开的子对象会注明数量。传 project_dir（工程目录，如 works_download 下载的作品）时不需要打开窗口，直接读 Assets/main.scene 和 main.scene.extra，对象写成 #序号，组件类型和窗口里显示的一致（编辑器数据缺失时退回场景文件里的名称）；没有渲染组这一层，渲染组本身作为根对象列出。save_to 是目录的绝对路径，结果另存为其中的 scene_tree.txt，长期保留。',
      shape: {
        ...target,
        project_dir: z.string().min(1).optional().describe('不开窗口、直接读这个工程目录的场景文件；给了它就不看 project_path / instance_id。'),
        subtree: z.string().min(1).optional().describe('只输出这个对象及其子对象（guid 或名称；project_dir 时用 #序号 或名称）。'),
        depth: z.number().int().min(1).max(30).optional().describe('展开层数，默认 6。'),
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
          out = formatTree(await d.official.callJson('get_scene', { instance_id, summary: false, depth, ...(subtree ? { subtree } : {}), intention: '读取场景结构' }));
        }
        out = out || '（场景为空）';
        const saved = save_to ? saveFile(save_to, 'scene_tree.txt', out) : null;
        return { content: [{ type: 'text', text: [out, warn, saved && `已保存：${saved}`].filter(Boolean).join('\n\n') }] };
      },
    },
    {
      name: 'inspect_many',
      description:
        '一次查看多个对象的组件参数（逐个调用官方 inspect；只看一个对象的完整原始数据时直接用 inspect），值里的 {type, data} 包装直接展开成值，超长数组只给长度和前几项；绑定的资源写成 {resource, type, file}，引用的对象写成 {object, name}。component_types 只留某些组件（如 ["Transform"]），fields 只留属性名包含这些片段的属性（不分大小写，如 ["intensity", "position"]）。preset="key" 自动留下通常决定效果的参数：位置/缩放/旋转、显隐与启用、强度/不透明度/权重/颜色类属性、文字内容（str）与 2D 尺寸（sizeDelta）、绑定的资源，以及场景文件里脚本组件的全部参数（这份清单是按已做过的妆容、形变、贴纸、文字效果拍的，缺的用 fields 补，可与 fields 同时用）。传 project_dir 时不开窗口、直接读场景文件（含编辑器面板里的参数，如妆容的贴图和强度），guids 用 scene_tree 给出的 #序号；内置资源写成 {builtin: id}，组件运行时生成、工程里没有文件的资源写成 {path}。单个对象失败只在该项写明原因。save_to 是目录的绝对路径，结果另存为其中的 inspect_many.json，长期保留。',
      shape: {
        ...target,
        project_dir: z.string().min(1).optional().describe('不开窗口、直接读这个工程目录的场景文件；给了它就不看 project_path / instance_id。'),
        guids: z.array(z.string().min(1)).min(1).max(40).describe('对象或组件的 guid（scene_tree / get_scene 返回的；project_dir 时是 #序号）。'),
        component_types: z.array(z.string().min(1)).min(1).optional().describe('只保留这些类型的组件。'),
        fields: z.array(z.string().min(1)).min(1).optional().describe('只保留属性名包含这些片段的属性。'),
        preset: z.enum(['key']).optional().describe('key：只留关键参数，见工具说明。'),
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
              out.push(pickInspect(scene.inspect(guid), pick));
            } catch (e) {
              out.push({ guid, error: String(e.message ?? e) });
            }
          }
        } else {
          const instance_id = await officialInstance(a);
          const root = await projects.resolveProjectPath({ instance_id });
          const inspect = (guid) => d.official.callJson('inspect', { instance_id, guid, intention: '批量查看对象参数' });
          const cache = new Map();
          for (const guid of guids) {
            try {
              out.push(await resolveRefs(pickInspect(await inspect(guid), pick), inspect, { root, cache }));
            } catch (e) {
              out.push({ guid, error: String(e.message ?? e) });
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
      description:
        '列出一个工程的全部美妆层（FaceMask 妆容层和 EyeColorV2 美瞳），逐层说明画在哪个部位、什么颜色、男女强度，以及是否生效（对象或上级隐藏、组件停用、男女强度都为 0 的不生效）。区域（全脸 / 眼部 / 睫毛 / 唇部 / 牙齿）取自妆容层自身的类型；部位先看层名（眉、眼线、腮红、口红等关键字），层名看不出时按贴图像素判断（part_from 注明依据），颜色是贴图上色部分按透明度加权的平均色（color 和 hsl）。groups 按眉、眼妆、美瞳、颊、轮廓、唇、点缀汇总生效的层，absent 列出整套妆里没有的部位，用来看一套妆缺了什么、或拆解别人的作品（works_download 下载的工程）用了哪些部位和颜色。读的是工程目录里的场景文件：正在编辑的工程先 save_project。',
      shape: {
        project_dir: z.string().min(1).describe('工程目录的绝对路径（含 Assets/main.scene），如 works_download 返回的 project_path 或自己的工程。'),
        save_to: saveTo,
      },
      run: async ({ project_dir, save_to }) => {
        const res = text(makeupLayers(project_dir));
        if (save_to) res.content.push({ type: 'text', text: `已保存：${saveFile(save_to, 'makeup_layers.json', res.content[0].text)}` });
        return res;
      },
    },
    {
      name: 'makeup_texture',
      description: `按形状画一张妆容层（FaceMask）贴图，写成 PNG：官方单品做不出的眼线、下眼睑粉、水光点、遮瑕、红晕、雀斑、睫毛等。layout 决定贴图布局和尺寸（坐标都按这个尺寸的像素写）：${Object.entries(LAYOUTS)
        .map(([k, v]) => `${k} ${v.width}×${v.height}`)
        .join('、')}，分别对应整脸、眼部、唇部区域的妆容层。layers 从下往上按标准方式叠加；每层一个颜色，形状有 spot（高斯点）、stroke（渐细的圆头线，默认用一条平滑的弧拟合给的点）、polygon、band（上下两条线围成的带）、scatter（椭圆里随机撒点，如雀斑）、strands（沿一条线长出的渐细发丝，如睫毛）；mirror 的形状再画一份左右镜像，mirror_dy 让镜像那份整体下移（眼部贴图右半边在画面上比左半边高约 3 贴图像素，实测 4 位模特里 3 位如此）。blend 填妆容层要用的混合模式：透明像素按它填「不改变皮肤」的颜色（正片叠底填白、滤色填黑、柔光填中灰，普通混合填最近的上色像素的颜色），边缘不会被纹理过滤混出一圈别的颜色。base 给一张现有贴图时在它上面画，erase 层按形状擦掉它的一部分。实测坐标（模特 D、E、G、I，整脸 1024）：眉 y≈410；眼裂 y≈465–485，左眼 x≈375–455（外眼角在小 x 一侧，右眼关于 x=512 对称）；上眼皮 430–455；下睫毛线≈490；卧蚕≈500；颧骨高点 (350, 545)；鼻尖 (512, 590)；上唇≈690，唇心≈720，下唇下缘≈760。眼部 900×460 的左半边是画面左眼，上眼缘暗边中段 y≈247、眼尾 263–266，眼皮皮肤结束处中段≈236。要精确到像素用 makeup_calibrate 在自己的模特上量。返回文件路径、贴图上色部分的平均色和范围、warnings（如整脸贴图画进了眼裂），以及贴图叠在中灰上的预览图。贴图写到工程 Assets 里、覆盖已有文件时编辑器几秒后热更新；新文件要挂到妆容层上用 attach。`,
      shape: {
        out: z.string().min(1).describe('输出 PNG 的绝对路径；已存在会覆盖。'),
        layout: z.enum(Object.keys(LAYOUTS)).describe('贴图布局：face 整脸、eye 眼部、lips 唇部。'),
        blend: z.enum(Object.keys(BLENDS)).describe('这张贴图在妆容层上用的混合模式（决定透明像素填什么颜色）。'),
        layers: z.array(paintLayer).min(1).max(PAINT_LIMITS.layers),
        mirror_dy: z.number().min(-20).max(20).optional().describe('镜像那份的下移量（贴图像素，可为负），默认 0。'),
        base: z.string().min(1).optional().describe('在这张 PNG（绝对路径）上画；尺寸不同时先缩放到 layout 的尺寸。'),
        attach: z
          .strictObject({
            object_path: z.string().min(1).optional().describe('换这个已有妆容层的贴图（层级路径或能唯一定位的末尾几段）；它的区域要和 layout 一致。'),
            add: z.boolean().optional().describe('新建一个和 layout 同区域的妆容层（添加对象菜单的面部 / 眼部 / 唇部妆容）再挂上。'),
            female: z.number().min(0).max(1).optional().describe('女生强度；不给时保留层上原来的值。'),
            male: z.number().min(0).max(1).optional().describe('男生强度；不给时保留层上原来的值。'),
            texture_size: z.union([z.literal(512), z.literal(1024), z.literal(2048)]).optional().describe('贴图导入后的最大分辨率；编辑器默认压到 512，雀斑、光点这类细小的点用 1024。'),
          })
          .refine((a) => !a.object_path !== !a.add, { message: 'give object_path or add: true, not both' })
          .optional()
          .describe('写完后挂到目标工程的妆容层上，混合模式设成 blend（可撤销）。out 在工程 Assets 里时原地登记，不在时编辑器复制一份进工程。'),
        ...target,
      },
      run: async ({ out, attach, project_path, instance_id, ...spec }) => {
        const painted = paint(spec);
        const file = writeTexture(out, painted);
        const { color, hsl, coverage, cx, cy, width, height } = pixelStats(painted);
        const summary = {
          file,
          size: [painted.width, painted.height],
          blend: spec.blend,
          // pixelStats averages pixel indices; shapes put pixel (x, y)'s centre at (x + 0.5, y + 0.5).
          painted: {
            color,
            hsl,
            coverage: Number(coverage.toFixed(4)),
            center: [cx * painted.width + 0.5, cy * painted.height + 0.5].map((v) => Number(v.toFixed(1))),
            extent: [Math.round(width * painted.width), Math.round(height * painted.height)],
          },
          warnings: painted.warnings,
        };
        if (attach) {
          const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
          let object_path = attach.object_path;
          if (attach.add) object_path = (await d.callPlugin('makeup_add_layer', { region: spec.layout }, { projectPath, timeoutMs: 180000 })).object_path;
          else {
            const { layers } = await d.callPlugin('makeup_list', {}, { projectPath, timeoutMs: 15000 });
            const hits = layers.filter((l) => l.kind === 'face_mask' && (l.object_path === object_path || l.object_path.endsWith(`/${object_path}`)));
            if (hits.length !== 1) throw Error(`MAKEUP_LAYER_NOT_FOUND: ${object_path} matches ${hits.length} makeup layers${hits.length ? `: ${hits.map((l) => l.object_path).join(' | ')}` : ''}`);
            if (hits[0].region !== LAYOUTS[spec.layout].region) throw Error(`LAYOUT_MISMATCH: ${hits[0].object_path} is region ${hits[0].region}, the ${spec.layout} layout is for region ${LAYOUTS[spec.layout].region}`);
            object_path = hits[0].object_path;
          }
          const change = Object.fromEntries(
            Object.entries({ object_path, texture: file, blend: BLENDS[spec.blend], female: attach.female, male: attach.male, texture_size: attach.texture_size }).filter(([, v]) => v !== undefined),
          );
          const { after } = await makeupSet(projectPath, [change], `makeup_texture: ${path.basename(file)}`);
          summary.attached = { ...after[0], note: '改动在编辑器里，可撤销；要落盘请 save_project' };
        }
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }, { type: 'text', text: '预览（贴图叠在中灰上）：' }, { type: 'image', mimeType: 'image/png', data: previewPng(painted).toString('base64') }] };
      },
    },
    {
      name: 'makeup_eye',
      description: `按化妆步骤画一整只眼的妆（眼部布局 900×460，自动画到另一只眼）：眼线、上睫毛、下睫毛、眼影、眼头提亮、卧蚕、下眼睑，只画给了参数的部分。位置取自眼部坐标：默认是在模特 D、E、G、I 上实测的上眼缘、眼皮边，和官方下睫毛、卧蚕贴图的位置；给 anatomy（makeup_calibrate layout=eye 存下的 calibration-eye.json）时按那几位模特汇总，眼线的上沿、下沿按他们上眼缘的分布定，在大多数人脸上都贴着睫毛根、不浮在眼皮上。按混合模式分成几张贴图：line（普通：眼线 + 睫毛）、shadow（正片叠底：眼影，只在眼皮上）、light（滤色：眼头、卧蚕提亮）、under（普通：下眼睑色、卧蚕阴影线；眼下不用正片叠底，它会压暗眼下、加深泪沟），眼影和眼下的颜色都自动避开眼裂。写到 out_dir/<name>_<部分>.png；attach 时挂到妆容层上（add 新建，或给每张贴图指定已有的层），男生强度默认 0。眼线 style：tight 内眼线（只填上眼缘，看不到线）、lash_line 贴睫毛根的细线、wing 贴睫毛根并在眼尾顺势上挑。睫毛 style：${LASHES.join(' / ')}（自然根根分明 / 簇状漫画睫 / 太阳花 / 娃娃睫中段最长 / 狐系眼尾拉长上扬）。`,
      shape: {
        ...target,
        out_dir: z.string().min(1).describe('贴图写到这个目录（绝对路径，最好在工程 Assets 里，挂层时原地登记）；同名文件覆盖，编辑器几秒后热更新。'),
        name: z.string().regex(/^[^/\\\\]+$/).max(40).optional().describe('文件名前缀，默认 eye。'),
        anatomy: z.string().min(1).optional().describe('makeup_calibrate（layout=eye）存下的 calibration-eye.json；不给用默认眼部坐标。'),
        liner: z
          .strictObject({
            style: z.enum(LINERS),
            width: z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]).optional().describe('线宽的一半 [眼头, 中段, 眼尾]（贴图像素）；默认 tight [0.6, 1, 0.8]，其余 [1, 2.2, 2]。'),
            cover: z.number().min(0).max(2).optional().describe('下沿往上眼缘里盖多少（占各人上眼缘往下分布的比例），默认 0.5；大了在上眼缘偏高的人脸上会盖到眼珠。'),
            tail: z.strictObject({ length: pos, lift: z.number().min(-90).max(90) }).optional().describe('眼尾，wing 默认 { length: 30, lift: 30 }。'),
            color: z.string().optional(),
            opacity: z.number().min(0).max(1).optional(),
            softness: z.number().min(0).max(8).optional().describe('边缘模糊（贴图像素），默认 0.6；大了像眼线笔晕开。'),
          })
          .optional(),
        lashes: z
          .strictObject({
            style: z.enum(LASHES),
            length: z.number().gt(0).max(3).optional().describe('长度倍数，默认 1。'),
            count: z.number().int().min(1).max(120).optional().describe('根数（cluster 是簇数）。'),
            curl: z.number().min(-60).max(60).optional().describe('卷翘（度）。'),
            color: z.union([z.string(), z.tuple([z.number(), z.number(), z.number()])]).optional().describe('默认深棕 [40, 30, 30]，比眼线稍浅。'),
            opacity: z.number().min(0).max(1).optional().describe('默认 0.85；全黑开满像假睫毛，60–70% 会糊成一圈浅色绒边。'),
            seed: z.number().int().optional(),
          })
          .optional(),
        lower_lashes: z
          .strictObject({ style: z.enum(['sparse', 'cluster']), length: z.number().gt(0).max(3).optional(), count: z.number().int().min(1).max(60).optional(), color: z.union([z.string(), z.tuple([z.number(), z.number(), z.number()])]).optional(), opacity: z.number().min(0).max(1).optional(), seed: z.number().int().optional() })
          .optional(),
        shadow: z
          .strictObject({
            base: z.strictObject({ color: z.string(), opacity: z.number().min(0).max(1).optional() }).optional().describe('整个眼皮打底，低饱和。'),
            outer: z.strictObject({ color: z.string(), opacity: z.number().min(0).max(1).optional(), extend: z.number().min(0).max(60).optional() }).optional().describe('后三分之一加深并拉长到眼尾外 extend 像素（默认 14）。'),
            height: z.number().min(10).max(90).optional().describe('眼影从上眼缘往上多高（贴图像素），默认 40。'),
          })
          .optional(),
        highlight: z.strictObject({ inner: z.strictObject({ color: z.string().optional(), opacity: z.number().min(0).max(1).optional() }).optional() }).optional().describe('眼头提亮。'),
        aegyo: z
          .strictObject({
            highlight: z.strictObject({ color: z.string().optional(), opacity: z.number().min(0).max(1).optional() }).optional().describe('卧蚕提亮带。'),
            shadow: z.strictObject({ color: z.string().optional(), opacity: z.number().min(0).max(1).optional() }).optional().describe('卧蚕下的阴影线。'),
          })
          .optional(),
        lower_lid: z
          .strictObject({
            line: z.strictObject({ color: z.string(), opacity: z.number().min(0).max(1).optional(), width: z.number().gt(0).max(8).optional(), from: z.number().min(0).max(1).optional().describe('从眼头起多远开始（0–1），默认 0.3。') }).optional().describe('贴着下睫毛线的一条颜色（下眼睑粉）。'),
            outer: z.strictObject({ color: z.string(), opacity: z.number().min(0).max(1).optional() }).optional().describe('下眼尾。'),
          })
          .optional(),
        attach: z
          .strictObject({
            add: z.boolean().optional().describe('每张贴图新建一个眼部妆容层挂上。'),
            line: z.string().min(1).optional(),
            shadow: z.string().min(1).optional(),
            light: z.string().min(1).optional(),
            under: z.string().min(1).optional(),
            female: z.number().min(0).max(1).optional().describe('女生强度，默认 1。'),
            male: z.number().min(0).max(1).optional().describe('男生强度，默认 0（男生的眼妆在 0–0.15）。'),
          })
          .optional()
          .describe('挂到妆容层上：add 新建，或给 line / shadow / light / under 指定已有的眼部妆容层路径（再画一次时用，原贴图被覆盖、热更新）。'),
      },
      run: async ({ out_dir, name = 'eye', anatomy: anatomyFile, attach, project_path, instance_id, ...spec }) => {
        if (!path.isAbsolute(out_dir)) throw Error(`OUT_DIR_NOT_ABSOLUTE: ${out_dir}`);
        const anatomy = anatomyFile ? anatomyFromCalibration(anatomyFile) : DEFAULT_ANATOMY;
        const textures = eyeTextures(spec, anatomy);
        if (!textures.length) throw Error('NOTHING_TO_DRAW: give at least one of liner, lashes, lower_lashes, shadow, highlight, aegyo, lower_lid');
        const done = [];
        const content = [];
        for (const t of textures) {
          const painted = paint({ layout: t.layout, blend: t.blend, mirror_dy: t.mirror_dy, layers: t.layers });
          const file = writeTexture(path.join(out_dir, `${name}_${t.key}.png`), painted);
          done.push({ key: t.key, blend: t.blend, file, warnings: painted.warnings });
          content.push({ type: 'text', text: `${t.key}（${t.blend}）贴图预览：` }, { type: 'image', mimeType: 'image/png', data: previewPng(painted).toString('base64') });
        }
        if (attach) {
          const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
          for (const t of done) {
            let object_path = attach[t.key];
            if (!object_path && !attach.add) continue;
            if (!object_path) object_path = (await d.callPlugin('makeup_add_layer', { region: 'eye' }, { projectPath, timeoutMs: 180000 })).object_path;
            const { after } = await makeupSet(projectPath, [{ object_path, texture: t.file, blend: BLENDS[t.blend], female: attach.female ?? 1, male: attach.male ?? 0, texture_size: 1024 }], `makeup_eye: ${t.key}`);
            t.attached = after[0].object_path;
          }
        }
        const { source, spread, mirror_dy, measured } = anatomy;
        const summary = { anatomy: { source, spread, mirror_dy, ...(measured ? { measured } : {}) }, textures: done, ...(attach ? { note: '改动在编辑器里，可撤销；要落盘请 save_project' } : {}) };
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }, ...content] };
      },
    },
    {
      name: 'makeup_compare',
      description: `在同一张脸上比较几种妆容状态：重置预览、播放 at_ms 后截基线（当前状态），再依次把每个 variant 的改动临时套上、等预览画出来、截一帧、改回去，最后再截一次基线。要用静态照片做的预览视频（如「模特D清秀||女」这些模特视频，每一帧都是同一张照片）：会动的视频每次截到的是不同的帧，两次基线对不上时返回 drift 和提示。预览暂停后不再重绘，所以不能靠暂停停住画面。改动只能是强度：妆容层的 female / male、美瞳和滤镜的 intensity（用来「关掉这层看看」「强度 0.3 和 0.6 比一比」，实时生效；换贴图、换混合模式要重载预览）。整套妆的子项也可以这样调，强度改回原值，不会删层。regions 是按画面比例（0–1）给的区域，如眼下、脸颊、唇：每个区域返回每种状态的平均色 RGB / HSL、亮度 luma（Rec.601）、皮肤细节 detail（亮度减去 σ ${DETAIL_SIGMA} px 高斯模糊后的平均绝对差，越高纹理越多），以及相对基线的差值；再给一张并排放大图（基线在最左，之后按 variants 顺序，像素直接放大不插值）。同一张静态照片上前后两帧在眼部的噪声约 0.5–0.8（平均，最大 13–18），差值比这个小的看不出区别。videos 依次在几个预览视频上各比一次，完了切回原视频。跑完所有改动都已改回；切换过视频或改过参数后工程会显示「已修改」。`,
      shape: {
        ...target,
        variants: z
          .array(
            z.strictObject({
              label: z.string().min(1).max(20),
              changes: z
                .array(
                  z.strictObject({
                    object_path: z.string().min(1).describe('妆容层、美瞳或滤镜对象的层级路径（或能唯一定位的末尾几段）。'),
                    female: z.number().min(0).max(1).optional(),
                    male: z.number().min(0).max(1).optional(),
                    intensity: z.number().min(0).max(1).optional().describe('美瞳、滤镜的强度。'),
                  }),
                )
                .min(1)
                .max(40),
            }),
          )
          .min(1)
          .max(MAX_COMPARE_VARIANTS),
        regions: z
          .array(
            z.union([
              z.strictObject({ label: z.string().min(1).max(20), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().gt(0).max(1), height: z.number().gt(0).max(1) }),
              z.strictObject({
                label: z.string().min(1).max(20),
                eye: z.enum(['left', 'right', 'both']).describe('取标定量出的眼睛范围：画面左眼、右眼或双眼。'),
                calibration: z.string().min(1).describe('makeup_calibrate（layout=eye）存下的 calibration-eye.json 的绝对路径，里面要有这次用到的每个预览视频。'),
                pad: z.number().min(0).max(2).optional().describe('在眼睛范围外再留多少（占范围宽高的比例），默认 0.3。'),
              }),
            ]),
          )
          .min(1)
          .max(MAX_COMPARE_REGIONS)
          .describe('区域：按画面比例给框，或用 eye + calibration 按每位模特自己的眼睛位置取（模特的眼睛位置各不相同，同一个比例框在别的模特脸上会框偏）。'),
        videos: z.array(z.string().min(1)).min(1).max(MAX_FRAME_VIDEOS).optional().describe('依次使用的预览视频名称（list_preview_videos 返回的 video_name）；不给就用当前视频。'),
        tracking_type: z.string().min(1).optional().describe('videos 所属的 tracking_type，默认 face。'),
        at_ms: z.number().int().min(0).max(20000).optional().describe(`重置后播放多久再截基线（毫秒），默认 ${HOLD_AT_MS}（AI 变脸要过一会儿才完全生效）。`),
        zoom: z.number().int().min(1).max(8).optional().describe('并排图的放大倍数，默认 3。'),
        save_to: saveTo,
      },
      run: async (a) => {
        const { variants, regions, videos, tracking_type = 'face', at_ms = HOLD_AT_MS, zoom = 3, save_to } = a;
        const instance_id = await officialInstance(a);
        const projectPath = await projects.resolveProjectPath({ instance_id });
        const dir = save_to ? saveDir(save_to) : d.framesDir();
        const runs = await eachVideo(instance_id, videos, tracking_type, (video) =>
          onPlayingPreview(projectPath, at_ms, async () => {
            const frames = [await pngFrame(projectPath)];
            for (const v of variants) {
              const { before } = await makeupSet(projectPath, v.changes, `makeup_compare: ${v.label}`);
              try {
                await freshFrames(projectPath);
                frames.push(await pngFrame(projectPath));
              } finally {
                await makeupSet(projectPath, before.map(({ object_path, kind, female, male, intensity }) => (kind === 'face_mask' ? { object_path, female, male } : { object_path, intensity })), 'makeup_compare: restore');
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
            const r = 'eye' in given ? eyeRegion(given, video, frames[0]) : given;
            const states = frames.map((f, i) => ({ label: labels[i], ...regionStats(f, r) }));
            const base = states[0];
            for (const s of states.slice(1)) {
              s.delta = { rgb: s.rgb.map((v, c) => Number((v - base.rgb[c]).toFixed(1))), luma: Number((s.luma - base.luma).toFixed(1)), detail: Number((s.detail - base.detail).toFixed(2)) };
            }
            const drift = frameDiff(frames[0], again, r);
            const file = path.join(dir, `${prefix}compare-${j + 1}.png`);
            fs.writeFileSync(file, sideBySide(frames, r, zoom));
            const box = pixelBox(frames[0], r);
            return { label: given.label, box_px: [box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0], states, drift, ...(drift.max > DRIFT_MAX ? { warning: '前后两次基线不一样，这期间画面自己在变（会动的视频或自带动画的特效），各状态之间的差别不全是改动造成的' } : {}), image: file };
          });
          out.push({ video, regions: regionsOut });
          for (const r of regionsOut) {
            content.push({ type: 'text', text: `${video ? `${video} ` : ''}${r.label}：${labels.join(' | ')}` });
            content.push({ type: 'image', ...(await d.readImageFile(r.image)) });
          }
        }
        const summary = { states: labels, runs: out, ...(save_to ? {} : { note_files: '临时文件，24 小时后删除；要留存请传 save_to' }), note: '所有改动都已改回；工程可能显示「已修改」，不需要的话不用保存' };
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }, ...content] };
      },
    },
    {
      name: 'makeup_calibrate',
      description: `量出妆容贴图在当前预览模特脸上落在哪里。临时加一个 layout 区域的妆容层，贴上「颜色就是贴图坐标」的标定贴图（R=x、G=y），截图期间把其它妆容层、美瞳、滤镜的强度临时调成 0（整套妆的子项也只是调强度，不删不关），在 at_ms 之后截一张带标定层的、一张不带的（要用静态照片做的模特视频，两张才是同一张脸）（即这张脸只有 AI 脸、美型时的样子），逐像素解码出每个画面像素对应的贴图坐标；截完改回所有强度，删掉临时层和标定贴图。返回每个预览视频（eye 布局下每只眼）的：画面上的范围 box_px、每画面像素对应多少贴图像素、标注图（不带妆的脸放大 4 倍，红线 / 青线是贴图 y 每 ${5} 像素的等高线，红线标了数值；黄色刻度是贴图 x 每 30 像素），以及 textures_grid（贴图上每 10 像素的格点落在画面哪个像素，写进 calibration.json）。eye 布局另返回上眼皮：每一列贴图 x 上，眼皮皮肤结束处 edge（亮度下降最快处）和上眼缘最暗处 rim 的贴图 y（右眼的 x 已换算成贴图右半边的坐标），画内眼线时线的上沿放在 rim 上方几像素、下沿到 rim。预览截图是 JPEG，每只眼的映射用二维多项式拟合（避开素帧里亮度变化剧烈的边缘），fit_rms 是拟合残差（实测 D、E、G、I 约 1–3 贴图像素）；眼皮边、上眼缘读不准的列给 null，不猜。滤镜以外还有会改颜色的后处理（自写的 .omtl 等）时解码会失败并说明，先把它们关掉再标定。`,
      shape: {
        ...target,
        layout: z.enum(Object.keys(LAYOUTS)).describe('要标定的贴图布局：face 整脸、eye 眼部、lips 唇部。'),
        videos: z.array(z.string().min(1)).min(1).max(MAX_FRAME_VIDEOS).optional().describe('依次在这些预览视频上标定（list_preview_videos 的 video_name），如几位模特的正脸视频；不给就用当前视频。'),
        tracking_type: z.string().min(1).optional().describe('videos 所属的 tracking_type，默认 face。'),
        at_ms: z.number().int().min(0).max(20000).optional().describe(`重置后播放多久再截图（毫秒），默认 ${HOLD_AT_MS}。`),
        save_to: saveTo,
      },
      run: async (a) => {
        const { layout, videos, tracking_type = 'face', at_ms = HOLD_AT_MS, save_to } = a;
        const instance_id = await officialInstance(a);
        const projectPath = await projects.resolveProjectPath({ instance_id });
        const dir = save_to ? saveDir(save_to) : d.framesDir();
        const uvFile = path.join(projectPath, 'Assets', `xs-calibration-${layout}-${Date.now()}.png`);
        fs.writeFileSync(uvFile, encodeUv(layout));
        let temp = null;
        let imported = false;
        let restore = null;
        const cleanup = [];
        let runs;
        try {
          const { layers } = await d.callPlugin('makeup_list', {}, { projectPath, timeoutMs: 15000 });
          temp = (await d.callPlugin('makeup_add_layer', { region: layout }, { projectPath, timeoutMs: 180000 })).object_path;
          const mute = layers.map((l) => (l.kind === 'face_mask' ? { object_path: l.object_path, female: 0, male: 0 } : { object_path: l.object_path, intensity: 0 }));
          imported = true;
          await makeupSet(projectPath, [{ object_path: temp, texture: uvFile, blend: BLENDS.normal, female: 1, male: 1 }], 'makeup_calibrate: calibration layer');
          if (mute.length) restore = (await makeupSet(projectPath, mute, 'makeup_calibrate: mute makeup')).before;
          runs = await eachVideo(instance_id, videos, tracking_type, (video) =>
            onPlayingPreview(projectPath, at_ms, async () => {
              const coded = await pngFrame(projectPath);
              await makeupSet(projectPath, [{ object_path: temp, female: 0, male: 0 }], 'makeup_calibrate: bare');
              try {
                await freshFrames(projectPath);
                return { video, coded, bare: await pngFrame(projectPath) };
              } finally {
                await makeupSet(projectPath, [{ object_path: temp, female: 1, male: 1 }], 'makeup_calibrate: calibration layer');
              }
            }),
          );
        } finally {
          if (restore) await makeupSet(projectPath, restore.map(({ object_path, kind, female, male, intensity }) => (kind === 'face_mask' ? { object_path, female, male } : { object_path, intensity })), 'makeup_calibrate: restore');
          if (temp) {
            const removed = await d.callPlugin('object_remove', { object_path: temp, delete_unused_resources: true }, { projectPath, timeoutMs: 60000 });
            cleanup.push(...removed.resources_deleted);
          }
          // Never handed to the editor: a plain file. Handed over but still there (the import or the
          // layer change failed, or removing the layer kept it): a resource, or a plain file if the
          // import never registered it.
          const rel = path.relative(projectPath, uvFile);
          if (!imported) fs.rmSync(uvFile, { force: true });
          else if (fs.existsSync(uvFile)) {
            try {
              cleanup.push(...(await d.callPlugin('resource_delete_unused', { paths: [rel] }, { projectPath, timeoutMs: 30000 })).deleted);
            } catch (e) {
              if (!/RESOURCE_NOT_FOUND/.test(e.message)) throw e;
              fs.rmSync(uvFile, { force: true });
              cleanup.push(rel);
            }
          }
        }
        const leftover = fs.existsSync(uvFile) ? [path.relative(projectPath, uvFile)] : [];
        const win = WINDOWS[layout];
        const out = [];
        const content = [];
        for (const [k, { video, coded, bare }] of runs.entries()) {
          const parts = decodeUv(layout, coded, bare);
          const prefix = videos ? `v${k + 1}-` : '';
          const bareFile = path.join(dir, `${prefix}bare.png`);
          fs.writeFileSync(bareFile, PNG.sync.write(bare));
          fs.writeFileSync(path.join(dir, `${prefix}coded.png`), PNG.sync.write(coded));
          const partsOut = parts.map((p) => {
            const file = path.join(dir, `${prefix}calibration${p.eye ? `-${p.eye}` : ''}.png`);
            fs.writeFileSync(file, overlay(p, bare));
            const res = { ...(p.eye ? { eye: p.eye } : {}), box_px: [p.box.x0, p.box.y0, p.box.x1 - p.box.x0 + 1, p.box.y1 - p.box.y0 + 1], pixels: p.pixels, texture_px_per_frame_px: p.texture_px_per_frame_px, fit_rms: p.fit_rms, overlay: file };
            if (layout === 'eye') res.upper_lid = upperLid(p, bare, p.eye === 'right' ? LID_COLUMNS.map((x) => LAYOUTS.eye.width - 1 - x) : LID_COLUMNS);
            res.texture_grid = textureGrid(p, bare.width, 10);
            return res;
          });
          out.push({ video, bare: bareFile, parts: partsOut });
          for (const p of partsOut) {
            content.push({ type: 'text', text: `${video ? `${video} ` : ''}${p.eye ? `${p.eye === 'left' ? '左' : '右'}眼` : ''}标注图` });
            content.push({ type: 'image', ...(await d.readImageFile(p.overlay)) });
          }
        }
        const json = path.join(dir, `calibration-${layout}.json`);
        fs.writeFileSync(json, JSON.stringify({ layout, window: win, lid_search: LID_SEARCH, runs: out }, null, 2));
        const brief = out.map((r) => ({ video: r.video, parts: r.parts.map(({ texture_grid, ...p }) => p) }));
        const summary = { layout, runs: brief, calibration_json: json, cleaned_up: cleanup, ...(leftover.length ? { leftover, warning: '标定贴图没删掉，请用 resource_delete_unused 删除' } : {}), note: '所有强度都已改回，临时层已删除；工程会显示「已修改」，不需要的话不用保存' };
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }, ...content] };
      },
    },
    {
      name: 'preview_frames',
      description:
        '按时间连续截取预览画面，分辨率是预览本身的（720×1280，官方截图是缩小后的 320×569），取自预览的渲染结果，窗口在后台或最小化时也能截（截图期间临时恢复正常帧率）：默认先重置预览、等到重载后的画面出来，再每隔 interval_ms 截一张，共 count 张（一次最多 24 张），用来看动态效果、摇头时的侧脸等。videos 可依次换几个预览视频各截一组（名称取自 list_preview_videos，如 preview_single_shake_head||女），全部截完切回原视频；切换会让工程变成「已修改」，之后需要 save_project。crop 按画面比例（0–1）裁出局部，如脸部。每帧都存成文件并随结果返回，files 里是路径，可直接贴给用户看；默认存在临时目录、24 小时后删除，save_to（目录的绝对路径）则存到那里长期保留。每帧注明实际截取时刻（相对重置完成的毫秒数）。',
      shape: {
        ...target,
        count: z.number().int().min(1).max(12).optional().describe('每个视频截几张，默认 4。'),
        interval_ms: z.number().int().min(100).max(10000).optional().describe('相邻两张的间隔（毫秒），默认 700。'),
        videos: z.array(z.string().min(1)).min(1).max(MAX_FRAME_VIDEOS).optional().describe('依次使用的预览视频名称（list_preview_videos 返回的 video_name）；不给就用当前视频。'),
        tracking_type: z.string().min(1).optional().describe('videos 所属的 tracking_type，如 face、body、hand，默认 face。'),
        reset: z.boolean().optional().describe('每组截图前先重置预览，默认 true。'),
        crop: z
          .object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            width: z.number().gt(0).max(1),
            height: z.number().gt(0).max(1),
          })
          .optional()
          .describe('裁剪区域，按画面宽高的比例，左上角为 (0, 0)。'),
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
        try {
          if (videos) {
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
          ...(original ? { note: `预览视频已切回 ${original.video_name || original.resource_url}；切换过预览视频，工程变成了「已修改」，需要 save_project` } : {}),
        };
        return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }, ...content] };
      },
    },
    {
      name: 'menu_list',
      description:
        `列出像塑「添加对象」菜单里的全部官方功能项（工具栏美妆、美型、AI 实时变脸，及人脸/身体/2D/3D/AI 玩法/互动/宠物/音乐等），返回 menu_id、中文名、路径、类型。官方 add_builtin_object 只覆盖其中一部分；美容（面部提拉、祛皱纹）、面部生成（烟熏妆、卡通脸）、表情生成（香肠嘴、呲牙尬笑）、性别年龄、五官处理、身体换装等用 menu_add。query 按名称、路径或 menu_id 过滤。details=true 时每项再带说明 description 和示意图（编辑器悬停提示里的图：在 CDN 上的给 image_url，随编辑器安装的给本机文件 image_file，都没有为 null），按画面挑选 AI 变脸、美容等效果时把它交给 image_view 看；details 一次最多 ${MAX_MENU_PREVIEW} 项，query 匹配更多时报错。云端 AI 生成项不在列表中；拍照后云端生图的「AI 组合效果」用 ai_combine_new / ai_combine_apply。`,
      shape: {
        ...target,
        query: z.string().optional().describe('按中文名、路径或 menu_id 过滤，如「表情」「美容」「烟熏妆」。'),
        details: z.boolean().optional().describe(`同时返回说明和示意图，默认 false；匹配项须不超过 ${MAX_MENU_PREVIEW} 个。`),
      },
      run: async (a) => {
        const { project_path, instance_id, ...params } = a;
        return text(await d.callPlugin('menu_list', params, await homeWindow({ project_path, instance_id })));
      },
    },
    {
      name: 'menu_add',
      description: '按 menu_id 往场景添加一个官方功能对象，与在编辑器菜单里点选等效（可撤销）。kind=package 的项会先下载官方素材包再导入。返回 added_objects（新对象名和 object_path）。',
      shape: { ...target, menu_id: z.string().min(1).describe('menu_list 返回的 menu_id。') },
      run: plugin('menu_add', 180000),
    },
    {
      name: 'ai_combine_new',
      description:
        '新建一张「AI 组合效果」工作流（用户拍照后在云端按工作流出图或出视频），等同 AI 效果窗口的「新建工作流」：在本地建 AI Graph，只有「输入图」和「效果组合」两个节点且未连线；不联网、不扣额度、不建云端草稿。返回 ai_graph_id 和各节点的 node_id，交给官方 get_workflow_context / get_workflow_capabilities / apply_workflow_patch 添加生图节点、写 prompt、连线（官方 apply_workflow_patch 每次改完会把工作流保存成账号下的云端 AI 效果草稿），要看效果用官方 generate_workflow（扣额度）。改好后用 ai_combine_apply 放进场景。「添加对象」菜单里的 AI 组合效果只建空壳，不要用 menu_add。',
      shape: { ...target },
      run: plugin('ai_combine_new'),
    },
    {
      name: 'ai_combine_apply',
      description:
        '把一张 AI 工作流放进场景，等同 AI 效果窗口的「应用」（可撤销）：编辑器编译工作流、把工作流文件上传到特效平台，再添加「AI 组合效果」对象（场景里没有 2D 前景时一并建「2D 前景」「2D 摄像机」）。不扣额度，不新建草稿；工作流生成过预览视频时一并上传供审核。效果组合节点没有输入连线等情况下编辑器会拒绝，返回 AI_COMBINE_APPLY_FAILED 和编辑器的提示原文（如「请先连接效果组合器」）。返回 added_objects（新对象名和 object_path）和 draft_id（工作流已存成云端草稿时才有，否则为 null）。之后 save_project。',
      shape: { ...target, graph_id: z.string().min(1).describe('ai_combine_new 或官方 get_workflow_context 返回的 ai_graph_id。') },
      run: plugin('ai_combine_apply', 180000),
    },
    {
      name: 'ai3d_image_submit',
      description: `素材库「AI 3D › 3D模型」（图生 3D）：上传一张参考图，在云端生成 3D 模型（静态网格，没有骨骼和动画），返回 task_id。参考图须是 ${AI3D_IMAGE_LIMIT.exts.join(' / ').toUpperCase()}、不超过 ${AI3D_IMAGE_LIMIT.maxMB} MB、长宽不超过 ${AI3D_IMAGE_LIMIT.maxSide} 像素；主体完整清晰、无遮挡，背景尽量纯色（编辑器的建议）。卡通角色可以先用官方 generate_image 出一张正面全身、纯色背景的图再交给本工具。同一类型最多同时跑 ${AI3D_MAX_RUNNING} 个任务。之后用 ai3d_tasks（带 task_id 和 wait_s）等它完成，再用 ai3d_import 放进工程。是否扣账号额度以编辑器为准，编辑器代码里没有相关提示。`,
      shape: {
        ...target,
        image_path: z.string().min(1).describe('参考图的绝对路径。'),
        precision: z
          .enum(Object.keys(AI3D_FACE_NUM))
          .optional()
          .describe(`精度（面数）：${Object.entries(AI3D_FACE_NUM).map(([k, v]) => `${k}=${v}`).join('、')}，对应编辑器的低 / 中 / 高面数；默认 medium。`),
      },
      run: async (a) => {
        const { project_path, instance_id, ...params } = a;
        return text(await d.callPlugin('ai3d_image_submit', params, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: AI3D_SUBMIT_TIMEOUT_MS }));
      },
    },
    {
      name: 'ai3d_animation_submit',
      description: `素材库「AI 3D › 3D动画」：把参考视频里人的动作做成动画，套到一个带标准人形骨骼的 FBX 上，返回 task_id。model 可选内置的 ${Object.keys(AI3D_PRESET_MODELS).join(' / ')}（全身 / 上半身 / 下半身 / 手臂，编辑器自带的人形模型），或一个本地 .fbx 的绝对路径：须有骨骼（Hips、Spine、LeftUpLeg 等 20 根标准人形骨骼，名字完全一致、不带 mixamorig_ 前缀，缺了编辑器也只提醒，返回里会有 warning），骨骼和面数不超过编辑器的导入上限。参考视频须是 ${AI3D_VIDEO_LIMIT.animation.exts.join(' / ').toUpperCase()}、不超过 ${AI3D_VIDEO_LIMIT.animation.maxSeconds} 秒、${AI3D_VIDEO_LIMIT.animation.maxMB} MB、长宽不超过 ${AI3D_VIDEO_LIMIT.animation.maxSide}，建议单人、全身出镜。图生 3D（ai3d_image_submit）出来的模型没有骨骼，不能直接用作 model。之后 ai3d_tasks 等完成、ai3d_import 导入（导入的是带动画的 FBX）。`,
      shape: {
        ...target,
        video_path: z.string().min(1).describe('参考视频的绝对路径。'),
        model: z.string().min(1).optional().describe(`${Object.keys(AI3D_PRESET_MODELS).join(' / ')} 之一，或本地 .fbx 的绝对路径；默认 whole。`),
      },
      run: async (a) => {
        const { project_path, instance_id, ...params } = a;
        return text(await d.callPlugin('ai3d_animation_submit', params, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: AI3D_SUBMIT_TIMEOUT_MS }));
      },
    },
    {
      name: 'ai3d_gs_segment',
      refs: true,
      description: `素材库「AI 3D › 高精度模型重建」第一步：上传一段实物 360 度环绕视频，云端识别出要重建的主体，返回 seg_task_id 和主体图 subject_image_ref（交给 image_view 看）。确认主体没问题后用 ai3d_gs_submit 正式生成 3D 高斯点云（.ply）；主体不对就换视频或重拍。视频须是 ${AI3D_VIDEO_LIMIT.gs.exts.join(' / ').toUpperCase()}、不超过 ${AI3D_VIDEO_LIMIT.gs.maxSeconds} 秒、${AI3D_VIDEO_LIMIT.gs.maxMB} MB、长宽不超过 ${AI3D_VIDEO_LIMIT.gs.maxSide}，主体清晰、光线充足、各角度都拍到。识别一般约 20 秒，最多等 wait_s 秒，超时编辑器会取消这次识别。`,
      shape: {
        ...target,
        video_path: z.string().min(1).describe('环绕视频的绝对路径。'),
        wait_s: z.number().int().min(10).max(AI3D_MAX_WAIT_S).optional().describe(`最多等待识别的秒数，默认 ${AI3D_SEGMENT_WAIT_S}。`),
      },
      run: async (a) => {
        const { project_path, instance_id, wait_s = AI3D_SEGMENT_WAIT_S, ...params } = a;
        const got = await d.callPlugin('ai3d_gs_segment', { ...params, wait_s }, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: AI3D_SUBMIT_TIMEOUT_MS + wait_s * 1000 });
        segments.set(got.seg_task_id, { subject_uri: got.subject_uri, req_json: got.req_json });
        return text({ seg_task_id: got.seg_task_id, subject_image_url: got.subject_image_url });
      },
    },
    {
      name: 'ai3d_gs_submit',
      description: '素材库「AI 3D › 高精度模型重建」第二步：按 ai3d_gs_segment 识别出的主体正式生成 3D 高斯点云，等同识别窗口里的「确认主体」，返回 task_id。之后 ai3d_tasks（kind=gs）等完成、ai3d_import 导入。',
      shape: { ...target, seg_task_id: z.string().min(1).describe('ai3d_gs_segment 返回的 seg_task_id。') },
      run: async (a) => {
        const { project_path, instance_id, seg_task_id } = a;
        const seg = segments.get(seg_task_id);
        if (!seg) throw Error(`UNKNOWN_SEGMENT: ${seg_task_id}; call ai3d_gs_segment first`);
        return text(await d.callPlugin('ai3d_gs_submit', seg, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: AI3D_SUBMIT_TIMEOUT_MS }));
      },
    },
    {
      name: 'ai3d_tasks',
      description: `素材库「AI 3D」的生成任务（当前账号）。不传 task_id 时按 kind 分页列出历史任务：状态（running / finished / failed）、创建和完成时间、输入（图生 3D 的精度、3D 动画的模型）、失败原因，以及结果是否已下载到本机和本机的预览图 / 预览视频（preview_image_file 交给 image_view 看）。传 task_id 时只查这一个；再给 wait_s 就一直等到它不再是 running 或时间到（最多 ${AI3D_MAX_WAIT_S} 秒），status=finished 后用 ai3d_import 导入。`,
      shape: {
        ...target,
        kind: z.enum(['image', 'animation', 'gs']).describe('image=3D模型（图生 3D）、animation=3D动画、gs=高精度模型重建。'),
        task_id: z.string().min(1).optional().describe('只查这个任务。'),
        wait_s: z.number().int().min(0).max(AI3D_MAX_WAIT_S).optional().describe('配合 task_id：最多等多少秒，默认 0（只查一次）。'),
        cursor: z.number().int().min(0).optional().describe('翻页游标，原样取上一页的 next_cursor。'),
        count: z.number().int().min(1).max(AI3D_HISTORY_PAGE).optional().describe(`每页数量，默认 ${AI3D_HISTORY_PAGE}（服务端上限）。`),
      },
      run: async (a) => {
        const { project_path, instance_id, kind, task_id, wait_s = 0, cursor, count } = a;
        const win = await homeWindow({ project_path, instance_id });
        if (task_id !== undefined) return text({ kind, ...(await d.callPlugin('ai3d_task', { task_id, wait_s }, { ...win, timeoutMs: wait_s * 1000 + 30000 })) });
        if (a.wait_s !== undefined) throw Error('INVALID_ARGUMENTS: wait_s only applies together with task_id');
        return text(await d.callPlugin('ai3d_tasks', { kind, cursor, count }, win));
      },
    },
    {
      name: 'ai3d_import',
      description:
        '把一个已完成的 AI 3D 任务结果下载到编辑器的 AI 3D 缓存目录（面板里同样能看到），导入工程并放进场景（可撤销），与面板里勾选后点「导入素材」相同：图生 3D 导入 GLB（外层对象「模型大小控制」放大 15 倍）、3D 动画导入带动画的 FBX、高精度模型重建导入 PLY 点云（缩小到 0.3）。返回 added_objects（新对象名和 object_path）、package_folders 和本机预览文件。之后用 capture_preview 看大小和位置，save_project。',
      shape: {
        ...target,
        task_id: z.string().min(1).describe('ai3d_*_submit 或 ai3d_tasks 返回的 task_id。'),
        kind: z.enum(['image', 'animation', 'gs']).describe('任务类型，与提交时一致。'),
      },
      run: plugin('ai3d_import', AI3D_IMPORT_TIMEOUT_MS),
    },
    {
      name: 'ai3d_cancel',
      description: '取消一个还在 running 的 AI 3D 生成任务（等同面板里的「取消生成」）。',
      shape: { ...target, task_id: z.string().min(1).describe('要取消的 task_id。') },
      run: async (a) => {
        const { project_path, instance_id, task_id } = a;
        return text(await d.callPlugin('ai3d_cancel', { task_id }, await homeWindow({ project_path, instance_id })));
      },
    },
    {
      name: 'ar_video_submit',
      description:
        '素材库「AI 素材 › AR 视频」（AR 视频贴片）：提交一次生成，等同面板上的「立即生成」，云端（Seedance）接受任务后返回 task_id。编辑器没有单独的模式开关，由输入决定：mode=direct 只抠像、不改动作，主体须是视频，不能带 prompt 和参考素材；mode=motion 由 prompt（必填）描述新动作或样式，主体可以是图片或视频，可加参考图（如给主体加道具）和一段参考动作视频。输入先交给编辑器自己的素材检查和转换（与面板上传素材相同：只认 JPG / JPEG / PNG / MP4 / MOV，包括主体最多 9 张图、3 段视频，视频每段至少 2 秒、合计不超过编辑器开关给的上限，主体视频原长须小于 60 秒；不合规格的图片自动缩放压缩、视频自动转码裁剪，转不了时报 AR_VIDEO_INPUT_INVALID 并带编辑器原话），视频还要先过编辑器的内容审核（最长 15 分钟）。动作时长 duration_s 默认 10 秒，最短 4 秒，上限由编辑器开关决定（2026-11-08 为 15 秒，以 ar_video_tasks 返回的 limits 为准）。shadow 是「添加投影」，省略时用编辑器默认（开关 dyeh_enable_ar_video_shadow，2026-11-08 为开）；开着时结果是带投影的幕底视频。同时最多 10 个任务在跑。会占用账号的 AI 模型使用次数（按特效师等级给），编辑器里查不到剩余次数和单次扣多少，用完时报「模型使用次数达到上限」。任务在哪个工程窗口提交，就在那个窗口里下载并合成结果，之后的 ar_video_tasks / ar_video_import 用同一个窗口最快；实测一段 10 秒的图片生成动作从提交到合成完约 6 分钟。',
      shape: {
        ...target,
        subject: z.string().min(1).describe('主体图片或视频的绝对路径（面板文案「上传图片或视频」）。'),
        mode: z.enum(AR_VIDEO_MODES).describe('direct：主体视频直接生成 AR 视频贴片，只抠像不改动作；motion：按 prompt 和参考素材生成新动作。'),
        prompt: z.string().optional().describe('动作描述（最多 2000 字），mode=motion 时必填，mode=direct 时不能给。任务文档的建议：写上「生成高清视频」这类话会出高清。'),
        reference_images: z.array(z.string().min(1)).min(1).optional().describe('参考图的绝对路径（JPG / JPEG / PNG），如给主体加道具；仅 mode=motion。'),
        reference_video: z.string().min(1).optional().describe('参考动作视频的绝对路径（MP4 / MOV），动作迁移用；仅 mode=motion。'),
        shadow: z.boolean().optional().describe('「添加投影」，省略时用编辑器默认；前置自拍类效果一般关掉。'),
        duration_s: z.number().int().positive().optional().describe('输出动作时长（秒），默认 10，范围见 ar_video_tasks 返回的 limits。'),
      },
      run: plugin('ar_video_submit', AR_VIDEO_SUBMIT_TIMEOUT_MS),
    },
    {
      name: 'ar_video_tasks',
      description: `素材库「AR 视频」的生成任务（当前账号，与面板右侧的生成记录同一份）。不传 task_id 时按 offset / count 分页列出，最新的在前，并带上当前的输入限制 limits；传 task_id 时只查这一个，再给 wait_s 就一直等到它合成完、失败或时间到（最多 ${AR_VIDEO_MAX_WAIT_S} 秒）。status：running 云端生成中、restoring 云端已完成，正在本机下载并合成、succeeded 可以导入、failed 失败（failure 里是编辑器给的原因和错误码）、unconfirmed 暂时查不到云端状态。每条带 name（工具栏后台任务里显示的名字）、mode、主体类型、参考素材类型、prompt、时长、投影；succeeded 的另有实际时长 seconds、尺寸、是否幕底 green_screen、原声 audio、本机的预览视频 preview_video_file（抠像后叠在 #1b1b1b 背景上）、要导入的视频 video_file，以及一张横排 6 帧的预览图 preview_image_file（交给 image_view 看动作，不用打开视频）。在别的窗口提交的任务，这个窗口第一次看到时要自己下载并合成，会先显示 restoring。`,
      shape: {
        ...target,
        task_id: z.string().min(1).optional().describe('只查这个任务（ar_video_submit 返回的 task_id）。'),
        wait_s: z.number().int().min(0).max(AR_VIDEO_MAX_WAIT_S).optional().describe('配合 task_id：最多等多少秒，默认 0（只查一次）。'),
        offset: z.number().int().min(0).optional().describe('分页起点，取上一页的 next_offset；默认 0。'),
        count: z.number().int().min(1).max(AR_VIDEO_HISTORY_PAGE).optional().describe(`每页数量，默认 ${AR_VIDEO_HISTORY_PAGE}。`),
      },
      run: async (a) => {
        const { project_path, instance_id, task_id, wait_s = 0, offset, count } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        if (task_id !== undefined) return text(await d.callPlugin('ar_video_task', { task_id, wait_s }, { projectPath, timeoutMs: wait_s * 1000 + 120000 }));
        if (a.wait_s !== undefined) throw Error('INVALID_ARGUMENTS: wait_s only applies together with task_id');
        return text(await d.callPlugin('ar_video_tasks', { offset, count }, { projectPath }));
      },
    },
    {
      name: 'ar_video_import',
      description:
        '把一个 succeeded 的 AR 视频任务导入目标工程并放进场景，等同面板上勾选它后点「导入素材」（只导这一个，面板里其它勾选的结果不受影响）：视频「混合透明.mp4」、它的视频纹理「混合透明 MP4 播放器」（Mp4Texture，.mp4Tex）和原声「原声.mp3」导入为工程资源；场景里建渲染组「AR跟踪」，其下「AR平面跟踪」（AR 平面，MeshRenderer）上挂「AR 视频主体 N」，以及「AR摄像机」；场景原来是空的时还会建「通用」组（摄像机和灯光）。「AR 视频主体」上：Image 的 texture 是那张视频纹理（播放由它负责，loopCount=-1 无限循环）；AudioComponent 播原声；ARVideoAudioController（编辑器内置组件，参数 playOriginalAudio_target、originalVolume_target、videoTexture_target）让原声跟着视频播。脚本里控制播放：texture.getControl() 的 play() / pause() / resume() / stop()，事件用 APJS.EventManager.getObjectEmitter(texture) 监听 APJS.Mp4Event.PlayBegin / PlayEnd 等；可视化脚本用内置节点「视频纹理播放器」。返回 added_objects（新对象名和 object_path）、package_folders（这次导入新建的资源）和 plane_guid（编辑器选中的「AR平面跟踪」）。之后 capture_preview 看位置和大小，save_project。',
      shape: { ...target, task_id: z.string().min(1).describe('ar_video_submit / ar_video_tasks 返回的 task_id（须 status=succeeded）。') },
      run: plugin('ar_video_import', AR_VIDEO_IMPORT_TIMEOUT_MS),
    },
    {
      name: 'ar_video_cancel',
      description: '取消一个还在 running（或 unconfirmed）的 AR 视频生成任务，等同面板里的「取消生成」。取消确认后任务从记录里消失（cancelled=true）；取消前它已经结束时返回 cancelled=false 和结束时的 status。',
      shape: { ...target, task_id: z.string().min(1).describe('要取消的 task_id。') },
      run: plugin('ar_video_cancel'),
    },
    {
      name: 'face_warp_list',
      description: '列出场景里所有「塑型画笔」组件（FaceWarpX，含猫脸/狗脸），返回 object_path、是否启用、每项画笔的序号与强度。官方 set_component 改不了画笔强度，用 face_warp_set_intensity。',
      shape: { ...target },
      run: plugin('face_warp_list'),
    },
    {
      name: 'face_warp_set_intensity',
      description:
        '修改「塑型画笔」强度（等同检查器强度滑块，0–100），只改强度、保留笔刷数据，可撤销。object_path 取 face_warp_list 的路径，或能唯一定位的末尾几段。省略 item_index 时改全部画笔项。',
      shape: {
        ...target,
        object_path: z.string().min(1).describe('face_warp_list 返回的 object_path，或能唯一定位的末尾几段。'),
        intensity: z.number().min(0).max(100).describe('强度，0–100。'),
        item_index: z.number().int().min(0).optional().describe('只改某一项画笔；省略时改全部。'),
      },
      run: plugin('face_warp_set_intensity'),
    },
    {
      name: 'object_remove',
      description:
        '删除一个场景对象（含子对象，可撤销），并找出只被它使用的工程资源：删除前后对比场景引用，删除前被引用、删除后不再被引用的即为孤儿（unused_paths 已合并到素材包文件夹，只含磁盘上存在的路径）。editor_only_paths 是素材放进场景时编辑器按对象名建的文件夹（如「复古清冷_滤镜」），只在编辑器里、尚未写到磁盘，对象删除后下次保存就会消失，不用删。delete_unused_resources=true 时一并删除 unused_paths（资源删除不可撤销）；默认只报告，可之后用 resource_delete_unused 删除。object_path 用完整层级路径或能唯一定位的末尾几段（渲染组本身请用官方 delete_render_group）。只删对象、不关心资源时官方 edit_by_dsl 也能删；要知道删完哪些资源没人用了，用本工具。',
      shape: {
        ...target,
        object_path: z.string().min(1).describe('对象的层级路径，如「面部拉伸/小屁桃_美型」，或能唯一定位的末尾几段。'),
        delete_unused_resources: z.boolean().optional().describe('同时删除孤儿资源，默认 false（只报告）。'),
      },
      run: plugin('object_remove'),
    },
    {
      name: 'resource_delete_unused',
      description: '删除 object_remove 报告的 unused_paths（工程内相对路径的资源或素材包文件夹）。删除前再次核对：当前场景仍在引用的一律拒绝。资源删除不可撤销。',
      shape: { ...target, paths: z.array(z.string().min(1)).min(1).describe('object_remove 返回的 unused_paths。') },
      run: plugin('resource_delete_unused'),
    },
  ];
  const own = new Map(tools.map((t) => [t.name, { ...t, schema: z.strictObject(t.shape) }]));

  // Official tools listed unchanged whose calls are partly served here.
  const intercepted = {
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

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const mine = [...own.values()].map((t) => ({ name: t.name, description: t.refs ? `${t.description}${REF_NOTE}` : t.description, inputSchema: z.toJSONSchema(t.schema) }));
    const official = (await d.official.listTools())
      .filter((t) => !own.has(t.name))
      .map((t) => (Object.prototype.hasOwnProperty.call(OFFICIAL_NOTES, t.name) ? { ...t, description: `${t.description || ''}\n\n（xiangsu-mcp-plus）${OFFICIAL_NOTES[t.name]}` } : t));
    return { tools: [...mine, ...official] };
  });

  const callTool = async (name, args) => {
    const t = own.get(name);
    if (t) {
      const parsed = t.schema.safeParse(args);
      if (!parsed.success) return failure(`INVALID_ARGUMENTS(${name}): ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
      try {
        let res = await t.run(parsed.data);
        if (t.refs && !res.isError) res = { ...res, content: res.content.map((c) => (c.type === 'text' ? { ...c, text: JSON.stringify(withRefs(JSON.parse(c.text), d.refs), null, 2) } : c)) };
        return d.spill.apply(name, res);
      } catch (e) {
        return failure(e);
      }
    }
    if (Object.prototype.hasOwnProperty.call(intercepted, name)) {
      try {
        return await intercepted[name](args);
      } catch (e) {
        return failure(e);
      }
    }
    try {
      return await d.official.callTool(name, args);
    } catch (e) {
      if (e instanceof McpError) return failure(`OFFICIAL_TOOL_ERROR(${name}): ${e.message}`);
      return failure(`OFFICIAL_MCP_UNAVAILABLE(${name}): ${e.message}；确认像塑已启动（${d.official.url}）`);
    }
  };

  // While a call runs, a client that asked for progress gets a beat every progressMs, so long calls
  // (frames over seconds, waiting for checks) are not ended as idle.
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args = {} } = req.params;
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
      result = await callTool(name, args);
      return result;
    } catch (e) {
      error = String(e?.message ?? e);
      throw e;
    } finally {
      clearInterval(timer);
      d.callLog.call({ tool: name, ms: Date.now() - started, result, error, progress: token === undefined ? 'none' : beats });
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
  await createServer({ official, callLog }).connect(new StdioServerTransport());
}
