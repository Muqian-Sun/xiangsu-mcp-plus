#!/usr/bin/env node
// stdio MCP server: everything 像塑's official MCP offers (proxied unchanged), plus editor features the
// official server cannot reach, served by the XiangsuMcpExt editor plugin.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
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
import { OfficialMcp, OfficialUnreachable } from './official.mjs';
import { fetchImage, fetchImageBytes, readImageFile, sniffImage } from './images.mjs';
import { Projects, activateApp, frontApp, openWithApp } from './projects.mjs';
import { prepareIcon } from './icons.mjs';
import { BLEND_MODES, dropUnset, formatObjects, formatTree, pickInspect, resolveComponentRefs, resolveObject, resolveRefs, sceneObjects } from './inspect.mjs';
import { loadScene } from './scenefile.mjs';
import { makeupLayers, pixelStats } from './makeup.mjs';
import { DETAIL_SIGMA, decodePng, frameDiff, pixelBox, regionStats, sideBySide } from './measure.mjs';
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

const { INNOVATION_KINDS, MAX_MENU_PREVIEW, RANK_TYPES, RANK_FILTERS, EFFECT_SEARCH_KINDS, SEARCH_MAX, SCRIPT_TAGS, SCRIPT_MAX, AI3D_FACE_NUM, AI3D_IMAGE_LIMIT, AI3D_VIDEO_LIMIT, AI3D_MAX_RUNNING, AI3D_PRESET_MODELS, AI3D_HISTORY_PAGE, AR_VIDEO_MODES, AR_VIDEO_HISTORY_PAGE, AI_MAKEUP_IMAGE_LIMIT, AI_MAKEUP_HISTORY_PAGE, CUSTOM_GAN_SELECT_COUNT, IMAGE_MATTING_PARTS } = createRequire(
  import.meta.url,
)('../editor-plugin/library.cjs');
const rankFilter = (key) => z.array(z.enum(Object.keys(RANK_FILTERS[key].options))).optional();
const LIBRARY_PANELS_TEXT =
  'general 为普通面板（如 3d_distortion=脸部变形/3D 变形、distortion=美型、gaoguai_gan/makeup_gan=AI 实时变脸、3d_makeup=美妆、3d_filter=滤镜、sticker=跟脸贴纸）；square 为 aigc_material=素材广场（其他创作者分享的素材，含现成的 AI 图片、AI 妆容、自定义实时变脸，应用时不重新生成、不扣额度）；collection 为 collection=收藏（当前账号收藏的素材）。现生成的 AI 面板不在其中；其中「AI 妆容」（从参考图提取妆容）用 ai_makeup_* 工具，「AI 3D」（图生 3D 模型、3D 动画、高精度模型重建）用 ai3d_* 工具，「AR 视频」（AR 视频贴片）用 ar_video_* 工具，「画面特效」用 ai_vfx_* 工具，「实时变脸」（训练自己的 AI 实时变脸）用 custom_gan_* 工具；「图片」「视频」生成没有接入。';
const RANK_TYPE_TEXT = Object.entries(RANK_TYPES).map(([k, name]) => `${k} ${name}`).join('、');
const SCRIPT_TAG_TEXT = Object.entries(SCRIPT_TAGS).map(([k, name]) => `${k} ${name}`).join('、');

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const target = {
  project_path: z.string().optional().describe('目标工程的绝对路径。与 instance_id 二选一；只开了一个工程窗口时都可省略。'),
  instance_id: z.string().optional().describe('官方 list_instances 返回的 instance_id，与 project_path 二选一。'),
};

const saveTo = z.string().min(1).optional().describe('另存到这个目录（绝对路径，不存在会创建），长期保留。');
const refBox = z
  .strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().gt(0).max(1), height: z.number().gt(0).max(1) })
  .optional()
  .describe('同一部位在参考图上的框（按参考图宽高的比例），和 reference 一起用。');

// Skia (@napi-rs/canvas) takes seconds to load cold, so the drawing tools load it on first use.
const graphics = () => import('./graphics.mjs');
const absPath = (what) => z.string().min(1).refine((p) => path.isAbsolute(p), `${what}须是绝对路径`);
const outDir = absPath('目录').describe('输出目录的绝对路径（不存在会创建）；放进工程的 Assets/ 下时 PNG 会被编辑器自动导入。');
const hexColor = z.string().regex(/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, '颜色写 #rgb、#rgba、#rrggbb 或 #rrggbbaa');
const fontArg = z
  .string()
  .min(1)
  .optional()
  .describe(`字体：像塑自带字体的文件夹名（douyinti 抖音体、yansongxin、xinqingnianti、wenyuehouxiandaiti、nihongxin、gangfengfanti、fenglingyouyou、DouyinNumberABC-ExtraBold，以本机安装的为准），或 .ttf / .otf 的绝对路径；默认 ${DEFAULT_FONT}。`);
const strokeArg = z.strictObject({ color: hexColor, width: z.number().min(0.5).max(60).describe('描边宽度（像素）') }).optional().describe('描边。');
const shadowArg = z
  .strictObject({
    color: hexColor.optional(),
    blur: z.number().min(0).max(60).optional(),
    offset_y: z.number().min(-60).max(60).optional(),
    opacity: z.number().min(0).max(1).optional(),
  })
  .optional()
  .describe('投影；传 {} 用默认的柔和黑影（模糊 6、下移 4、不透明度 0.45）。');
const textStyle = {
  text: z.string().min(1).describe('文字，\\n 换行，多行居中。'),
  font: fontArg,
  size: z.number().min(6).max(400).describe('字号（像素）。'),
  fill: hexColor.optional().describe('填充色，默认 #ffffff。'),
  gradient: z.array(hexColor).min(2).max(6).optional().describe('从上到下的渐变色（替代 fill）。'),
  stroke: strokeArg,
  shadow: shadowArg,
  line_height: z.number().min(0.8).max(3).optional().describe('行距（字号的倍数），默认 1.25。'),
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
  '窗口最小化在程序坞里，不显示加载进度窗、不抢前台（结果里 background.focus_kept_on 是打开期间焦点留在的应用）；用户从程序坞点开后就是普通窗口。最小化时 capture_preview、preview_frames 从渲染结果截图，get_scene_view 不可用（拒绝并说明），interact_by_dsl 的 screenshot 是黑图。';
const SCENE_VIEW_REFUSED =
  'SCENE_VIEW_NOT_DRAWN: 这个工程窗口最小化在程序坞里（MCP 打开的窗口都不上屏），最小化的窗口不绘制场景视图，get_scene_view 只能拍到一片纯色，所以没有调用。看效果用 capture_preview / preview_frames，看结构和对象用 scene_tree / get_scene / inspect_many；确实要场景视图截图，请用户从程序坞点开这个窗口后再调用。';

const OFFICIAL_NOTES = {
  capture_preview:
    '窗口可见时这里就是官方截图：刚改完场景或切换预览视频后，它可能还是改之前的画面；要确认新画面请用 preview_frames（先重置预览、等到重载后的画面再截）。窗口最小化或不可见时，这里改为重置预览后从渲染结果截取。',
  get_scene_view: '工程窗口最小化时（本服务打开的窗口都最小化在程序坞里）拒绝调用并说明原因：最小化的窗口不绘制场景视图，只会拍到一片纯色。',
  get_scene: '先摸清结构用 scene_tree（紧凑的缩进文本，也能不开窗口直接读下载的工程目录）；要看多个对象的参数用 inspect_many。',
  inspect: '一次看多个对象、按组件类型或属性名过滤、只留关键参数时用 inspect_many（逐个调用本工具并整理结果）。',
  edit_by_dsl:
    '删除对象时，要连带找出并清理只被它使用的资源和素材包文件夹，用 object_remove（可撤销，资源默认只报告）。{"$ref": X, "component_type": T} 里的 X 不是本批前面命令的 alias 时，可以写已有对象的 guid（sNN）、名称或层级路径（同 inspect_many），转发前换成该对象上 T 组件的 guid；官方自己只认本批的 alias，已有对象的 sNN 配 component_type 会报 has no component。T 写 inspect 里的组件类型名（FaceMask、EyeColorV2、GanComponent、PostProcess 等）。set_component 的 properties 写成对象（{"属性名": 值}），写成数组会在转发前被拒；单条命令 status=success 不等于写进去了，看它 result.changes 里有没有这个属性（2026-11-09 见过单条 success、属性没写上、只有整批报 error）。',
  interact_by_dsl: '窗口最小化或不可见时 screenshot 动作截到的是黑图；要看画面用 preview_frames（取自渲染结果，后台也能截）。',
  list_preview_videos: '一次返回约 70 KB；只要挑视频名（给 preview_frames、makeup_compare 的 videos）时用 preview_videos，只给每类的视频名和当前视频。',
  upload_workflow_image: '图片要写成对象 {"kind": "local_path", "file_path": "<绝对路径>"}，只传路径字符串会被拒（2026-11-09 实测）。',
  generate_assets_batch: 'assets 里每项的类型字段叫 kind，写成 type 会被拒（2026-11-09 实测）。',
  get_workflow_capabilities: 'algorithm_list 只给 baseModelId，algorithm_detail 要的 algorithm_id 不在列表里，二者不是同一个值；2026-11-09 因此没能加上生图节点，没找到绕过的办法。',
  apply_workflow_patch: '校验不过时官方报错是整个联合校验的展开（几十 KB），有用的通常只有 source / target 那一句；超过 4000 字的官方报错会被截断，全文存到返回的文件里。',
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
const REF_NOTE = '\n\n返回里的图片、视频、音频给的是短引用（*_ref / *_refs 字段，如 img:12、video:3）。看图时把引用放进 image_view 的 images 数组（参数名就是 images，如 images: ["img:12", "img:13"]）：图片直接显示，视频和音频返回原地址；引用在 MCP 服务这次运行期间有效。';
const KIND_TEXT = { video: '视频', audio: '音频' };
const failure = (error) => ({ content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true });

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
  const server = new Server({ name: 'xiangsu-mcp-ext', version: VERSION }, { capabilities: { tools: { listChanged: true } } });
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
    if (!pids.length) throw Error('NO_EDITOR_WINDOW: open any project window first (works are served by the XiangsuMcpExt plugin inside it)');
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
  const musicCursor = z.union([z.number(), z.string()]).optional().describe('下一页：上一页返回的 next_cursor；省略时从第一页开始。');
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
        '扩展自身状态：官方 MCP 连接情况；本次启动时编辑器插件的安装结果 plugin_install（action 为 installed 新装、kept 已有同版本或更新的插件未动、failed 安装失败附 error）；以及每个已加载 XiangsuMcpExt 插件的工程窗口（pid、工程路径、对应的官方 instance_id、有没有未保存的改动 unsaved_changes（读不到时为 null）、编辑器接口自检）。工具报找不到窗口、INCOMPATIBLE_EDITOR 或官方工具不可用时先调它排查；插件只在装好后新打开的工程窗口里生效。',
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
      description: '在新窗口打开一个已有的像塑工程（已经开着就直接返回，不改变它的窗口状态）。返回窗口 pid 和官方 instance_id。' + QUIET_TEXT + '旧版本工程可能弹出升级对话框，需要在编辑器里点确认。',
      shape: { path: z.string().min(1).describe('工程文件夹的绝对路径（含 effect.dyehpj）。') },
      run: async (a) => text(await projects.open(a)),
    },
    {
      name: 'project_new',
      description: '新建一个空白像塑工程并首次保存到 path（目录须不存在或为空）。需要已有任意一个工程窗口开着。返回新窗口的 pid 和官方 instance_id。' + QUIET_TEXT,
      shape: { path: z.string().min(1).describe('新工程要保存到的文件夹绝对路径。') },
      run: async (a) => text(await projects.create(a)),
    },
    {
      name: 'project_close',
      description: '关闭一个工程窗口（等同工具栏「回到首页」，但不把首页窗口带出来）。有未保存改动时默认拒绝，先 save_project；确实要丢弃改动才传 discard_changes=true。',
      shape: { ...target, discard_changes: z.boolean().optional().describe('丢弃未保存改动直接关闭。') },
      run: async (a) => text(await projects.close(a)),
    },
    {
      name: 'image_view',
      description: `查看图片。列表类工具（素材、作品、灵感、任务、排行榜、音乐等）返回的是短引用 *_ref / *_refs（如 img:12），详情类工具（inspiration_detail 的 images、menu_list details 的 image_url）返回地址，都放进参数 images（数组，如 images: ["img:12", "https://…"]；没有 ref / refs / url 参数）；也可以传本机图片文件的绝对路径（如 menu_list details 的 image_file）。视频和音频引用（video:3、audio:5）看不了画面，返回它的原地址。一次最多 ${IMAGE_VIEW_MAX} 张，只认 png / jpeg / gif / webp，单张失败只在该项写明原因；图片很大（如动图）时一次给不完，没给的列在 not_returned 里，再调用一次即可。`,
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
        '按关键词搜索官方素材库（美妆、滤镜、脸部变形、AI 实时变脸、贴纸、画面特效、音效、素材广场等）。除了标题匹配，词正好是面板名或子分类名时也带出那里的素材：「滤镜」→ 滤镜面板，「腮红」→ 美妆/腮红、跟脸贴纸/腮红（这些素材标题里多半没有这个词），「复古滤镜」→ 滤镜/复古；每个面板或子分类最多 300 条。结果按标题完全相同 > 标题开头 > 标题包含 > 分类匹配 > 其余排序，每条的 matched 说明命中方式（title、category:面板/分类、panel:面板）。queries 一次搜多个近义词（最多 8 个）并合并去重。按 offset / count 分页（结果缓存 10 分钟，翻页不重新请求），每条带 template_id、title、panel_key、kind、cover_ref，另返回 total、by_panel（各面板条数，可再用 panel_key 缩小）、matched_categories（展开了哪些分类）、related_categories（名字里含这个词、没有展开的分类，可用 library_list 列出）。kind：package 素材包、ai_image AI 图片、ai_makeup AI 妆容、custom_gan 自定义实时变脸、foreground_sticker 前景贴纸、face_sticker 跟脸贴纸、filter 滤镜。第一页（没传 panel_key / offset）还会附带「添加对象」菜单里名字匹配的项到 menu_items（如「脸蛋天才」「磨皮」「发光」——它们不在素材库里，要用 menu_add 加），并写 menu_note。',
      shape: {
        ...target,
        query: z.string().min(1).optional().describe('搜索关键词，如「芒果脸」「腮红」「复古滤镜」。与 queries 二选一。'),
        queries: z.array(z.string().min(1)).min(1).max(8).optional().describe('一次搜多个词并合并，如 ["冷艳", "猫眼", "烟熏", "风格妆"]。与 query 二选一。'),
        panel_key: z.string().optional().describe('只搜这个面板（library_list 不传 panel_key 时返回的 panel_key，如 aigc_material）。'),
        offset: z.number().int().min(0).optional().describe('分页起点，取上一页的 next_offset；默认 0。'),
        count: z.number().int().min(1).max(200).optional().describe('每页数量，默认 20。'),
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
        '下载一个首页作品的完整工程并解压（与在首页点开作品同一流程，但不打开窗口），返回工程目录和文件概况：key_files 只列学做法要读的文件（effect.dyehpj、场景 .scene 及其 .extra、Graph 下的文件和作者的 .js / .ts 脚本，相对路径和大小；官方素材包 _DynamicAsset 里自带的脚本不列），其余贴图、模型只给总数 file_count 和按扩展名的计数 by_extension，要看时自己列目录。dest 给定时把工程放到该目录（须不存在或为空，跳过 Library 缓存），像塑临时目录里的那份随即删除。下载的工程（含 dest）都会登记，expires_at（24 小时）后在下次下载时自动删除；学完请立即调用 works_cleanup。同一窗口的多个下载会排队一个个下，可以一起发出。要在编辑器里看效果用 works_open。作品版权归原作者，只用于学习参考，不要复制进自己的工程或仓库。',
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
        '下载一个首页作品并在新的编辑器窗口里打开，与在首页点开作品同一流程（不弹版本升级提示，工程处于未保存状态）。返回窗口 pid、官方 instance_id 和工程目录，之后可用 get_scene、capture_preview 等官方工具观察它的做法。' + QUIET_TEXT + '看完用 project_close（discard_changes=true）关窗，再 works_cleanup 删除下载；窗口开着时工程不会被删除。',
      shape: { ...target, template_id: z.string().describe('works_list / works_search / works_by_effect 返回的 template_id。') },
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
      name: 'icon_compose',
      description:
        '做图标图片（不开像塑）：从 preview_frames 存下的预览帧里裁一块正方形，按需压一行描边 / 渐变 / 投影字幕（说明玩法的一句话），缩放到 size（默认 720）存成 PNG，另存一张 160 的缩略图；一次最多 4 张（比如女生图、男生图，或几种取景）。另出一张列表大小（160）的并排图 sheet_160.jpg：先是这次做的图标，后面接 compare_images（同类作品的图标，用来看缩到列表大小后和它们拉不拉得开）。并排图和每张图标的 360 预览都在返回里。crop 用帧自己的像素：{top} 是和帧一样宽的正方形的上沿，{x, y, size} 是任意正方形；超出画面报 CROP_OUT_OF_FRAME（不做补边，补背景、补被切掉的头饰仍按工程里的做法）。字幕字号按输出尺寸算，太宽时等比缩到图宽的 max_width（默认 0.86），返回里 caption_shrunk_to 说明缩了多少。满意后把 file 交给 icon_set 上传（女生、男生图不同时分两次传 type）。',
      shape: {
        sources: z
          .array(
            z.strictObject({
              frame: absPath('帧').describe('预览帧图片的绝对路径（preview_frames 的 files，或任意 PNG / JPEG）。'),
              crop: z
                .union([
                  z.strictObject({ top: z.number().int().min(0).describe('和帧一样宽的正方形的上沿（帧的像素）。') }),
                  z.strictObject({ x: z.number().int().min(0), y: z.number().int().min(0), size: z.number().int().min(16) }),
                ])
                .describe('裁哪块正方形。'),
              caption: z
                .strictObject({
                  ...textStyle,
                  position: z
                    .union([z.enum(['top', 'bottom']), z.number().min(0).max(1)])
                    .optional()
                    .describe('top / bottom（默认，离边 3%），或字幕中心所在的高度（0–1）。字幕不要挡下巴和嘴。'),
                  max_width: z.number().gt(0).max(1).optional().describe('字幕最宽占图宽的比例，默认 0.86。'),
                })
                .optional()
                .describe('字幕；字号、描边宽度按输出尺寸（size）的像素算。'),
              name: fileStem.optional().describe('文件名（不含扩展名），默认 icon_1、icon_2…'),
            }),
          )
          .min(1)
          .max(4),
        size: z.number().int().min(160).max(1080).optional().describe('图标边长，默认 720（icon_set 会再缩到 360）。'),
        out_dir: outDir.optional().describe('输出目录的绝对路径；省略时放临时目录（24 小时后删除）。'),
        compare_images: z.array(absPath('图片')).max(8).optional().describe('同类作品的图标（本机路径），接在并排图后面对比。'),
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
      description: '打开编辑器的「图标制作」窗口（官方图标模板、文字模板、AI 图标），让用户在里面挑选或调整。窗口最小化在程序坞里、不抢前台，告诉用户从程序坞点开它。',
      shape: { ...target },
      run: async ({ project_path, instance_id }) => {
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        return text(await keepingFocus(() => d.callPlugin('icon_open', {}, { projectPath })));
      },
    },
    {
      name: 'effect_check',
      description:
        '特效检测，和在编辑器工具栏点「特效检测」一样：打开「特效检测」窗口（最小化，不抢前台），由窗口把特效包上传到抖音做云端检测（不是发布），等待结果 passed / not_passed / needs_optimization / failed。出结果后读出检测页的详情一起返回：verdict（页面结论，如「检测通过」「特效不通过」）、checks（每项检测的结论；包体积、帧率给出 figures：数值、上限、是否达标，帧率分 android / ios；没通过的项带页面给的改进建议 advice，读不到时写 advice_unavailable），然后关掉这个窗口（window_closed=true）；详情读不出来时窗口留着，返回 details_error。超过 timeout_ms 还没出结果时返回 timeout，窗口留着继续检测；之前调用留下的检测窗口会先关掉再开新的（closed_previous 是关掉的个数），所以窗口不会越叠越多。',
      shape: {
        ...target,
        timeout_ms: z.number().int().min(10000).max(1800000).optional().describe('最长等待时间，默认 300000（5 分钟）。'),
      },
      run: async (a) => {
        const { project_path, instance_id, timeout_ms = 300000 } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        return text(await keepingFocus(() => d.callPlugin('effect_check', { timeout_ms }, { projectPath, timeoutMs: timeout_ms + 30000 })));
      },
    },
    {
      name: 'submit_prepare',
      description:
        '填好提交窗口，停在最后一步「提交审核」页（不送审）：先在本地检查提交流程会拒收的情况（包体上限、是否原样套用模板、登录、图标），全部通过后先关掉还开着的提交窗口（之前调用留下的，closed_previous 是关掉的个数，关不掉报 WINDOW_NOT_CLOSED），再走和工具栏「提交特效」按钮相同的入口打开一个新的，（窗口最小化在程序坞里、不抢前台）然后逐页填写：「特效基础信息」页填名称、触发提示、默认摄像头方向（图标来自工程，可先用 icon_image 设好），「特效发布设置」页选灵感和任务，再翻到「提交审核」页，等页面上的检测（包体积、性能、相似度等，一般一分钟内）跑完，返回页面摘要、各检测结果、是否已同意创作者协议、「提交审核」按钮是否可点，以及 next（还要做什么）。本工具不勾选协议、不点「提交审核」，不会送审；确认摘要无误后用 submit_confirm 送审，或让用户从程序坞点开窗口自己点。每一项都从页面读回核对：页面截断、报错、没选上、或翻页被拦住时直接报错（SUBMIT_*，原样带上页面提示），窗口保持打开。页面上本工具没填的其它设置（如活动、创新声明）列在 other_sections 里，保持页面原样。本地检查未通过时不打开窗口，返回 issues。',
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
          .describe('「灵感绑定」要选的灵感或热点，取它在列表里显示的名称（当前账号收藏的灵感或热点，灵感的名称同 inspiration_collected 的标题）；传「暂不绑定」解绑；省略时保留页面带出的（inspiration_bind 绑定过的会自动带出）。'),
        task: z.string().min(1).optional().describe('「任务绑定」要选的任务标题（已领取的任务，同 tasks_list 的 title）；传「暂不参与」解绑；省略时保留页面带出的（task_bind 绑定过的会自动带出）。'),
        task_track: z.string().min(1).optional().describe('任务下的赛道名称，任务分赛道时必填，否则报 SUBMIT_TASK_NEEDS_TRACK 并列出赛道。'),
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
      description:
        '送审：在 submit_prepare 填好的提交窗口里勾选《创作者协议》（账号以前同意过、页面显示「已阅读并同意」时不用勾），再点「提交审核」，特效真正提交给平台审核，占用账号的提交次数，审核中和审核通过后提交的信息不能再改，调用前先和用户确认 submit_prepare 返回的摘要。只接手这个工程窗口里唯一一个开着的提交窗口（没有报 SUBMIT_WINDOW_NOT_OPEN，有多个报 SUBMIT_WINDOW_AMBIGUOUS），不重新填写；name 须和窗口摘要里的特效名称一致（不一致报 SUBMIT_NAME_MISMATCH），防止把填给别的特效的窗口提交出去。页面检测还在跑时先等（最多 3 分钟），没跑完（SUBMIT_CHECKS_RUNNING）或有没通过的（SUBMIT_CHECKS_FAILED）都不点。点之前还看一眼账号最新的 10 个作品：已有同名、在审核中或审核过了的（审核未通过的不算）就不点，报 SUBMIT_ALREADY_SUBMITTED，防止重复提交；作品列表读不到报 SUBMIT_LOOKUP_FAILED，也不点。点了之后页面先上传特效包和工程再提交，最多等 5 分钟，结果取页面报给编辑器的那一份（成功带 effect_id，失败带原因）：成功时关掉提交窗口，返回 effect_id、名称、触发提示、这次是否替用户勾了协议 agreement_ticked、页面的成功提示 success_text、是否提示要实名认证 needs_real_name，并到账号最新的作品列表里找这条特效放在 listed（审核状态等；没找到时 listed 为 null 并在 listed_note 说明）。页面没确认成功时（报了失败原因、停止提交却没给结果、5 分钟内没给结果）作品可能其实已经交上了，先到作品列表里找同名的这一条：找到就照成功处理，另把页面当时的情况放在 page_problem；没找到才报错，窗口保持打开，页面报了失败原因的报 SUBMIT_FAILED，其余报 SUBMIT_RESULT_UNKNOWN。这两种报错之后作品也可能稍后才出现，不要直接重新提交：先 pipeline_refresh 再用 pipeline_works 看有没有这条特效，确实没有再和用户商量重交，本工具不会自动重试。',
      shape: {
        ...target,
        name: z.string().min(1).describe('要提交的特效名称，须和 submit_prepare 填进窗口、返回在 filled.name 里的一致。'),
      },
      run: async (a) => {
        const { project_path, instance_id, name } = a;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        const got = await keepingFocus(() => d.callPlugin('submit_confirm', { name }, { projectPath, timeoutMs: SUBMIT_CONFIRM_TIMEOUT_MS }));
        return text({ ...got, ...(await listedEffect(projectPath, got)) });
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
      description: '一个灵感的详情：玩法说明、特效类型、激励说明、全部图片的地址 images（用 image_view 看）、作者、奖励（金额、说明、时间）、关联热点（热度和标签，如「66条热点相关灵感」）、关联官方工程 project（服务端只给标题、图标和「可在像塑桌面端搜索使用」，没有工程 id，2026-11-09 查了 13 个带工程的灵感都是这样；要下载就拿标题去 works_search）、已有的同灵感特效及发布量、示例视频 videos（抖音视频的播放地址 url、封面 cover_url、作者、点赞数、尺寸）、贴纸 stickers，以及当前账号是否已收藏和总收藏数。',
      shape: { ...target, inspiration_id: z.string().min(1).describe('inspiration_list / inspiration_collected / inspiration_search / hotspot_inspirations / growth_task_detail 返回的 inspiration_id，或像塑 / 抖音 App 灵感页里的灵感 ID。') },
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
      name: 'inspiration_collected',
      refs: true,
      description:
        '分页列出当前账号收藏的灵感（和首页「灵感」页签里的「收藏」页同一接口），按收藏时间从新到旧：字段同 inspiration_list，另有收藏时间 collected_at、作品类型 artwork_type（0 特效、2 模板、5 表情）、所属征集任务 task（task_id 和标题；提交时选了别的任务，这条灵感会被挤掉）。服务端没给灵感卡片的条目只有 inspiration_id 和标题，并标 card_missing=true。只列灵感，不含收藏的热点和素材。submit_prepare 的 inspiration 按标题在这些收藏里选。按 cursor 翻页，total 是收藏总数。',
      shape: {
        ...target,
        cursor: z.number().int().min(0).optional().describe('翻页游标（偏移量），取上一页的 next_cursor；默认 0。'),
        // 100 came back as 50 (2026-11-10).
        count: z.number().int().min(1).max(50).optional().describe('每页数量，默认 20，最多 50。'),
      },
      run: community('inspiration_collected'),
    },
    {
      name: 'submit_close',
      description: '关掉这个工程窗口里开着的提交窗口（submit_prepare 打开、还没提交的），不打开新的；返回关掉的个数 closed。要改填内容不用先关，直接再调 submit_prepare，它会先关掉旧的。',
      shape: { ...target },
      run: plugin('submit_close'),
    },
    {
      name: 'inspiration_bind',
      description:
        '按 inspiration_id 把一条创作灵感绑定到当前工程（编辑器给 agent 的同一接口），之后 save_project 落盘，打开提交窗口时会自动带出。提交窗口的下拉只列已收藏的灵感，没收藏的会带不出来，所以本工具会顺手收藏它（newly_collected=true 表示这次收藏的，不要了可用 inspiration_collect 取消）。只在提交时选灵感的话，也可以直接给 submit_prepare 传 inspiration：它在提交窗口的下拉里按名称选，只列当前账号收藏的灵感和热点。',
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
      description: '按 offset / count 分页列出活动中心里的成长任务：task_id、标题、奖励金额 bonus_yuan、标签、是否新手任务、参考工程。详情（参考工程、相关灵感、教程）用 growth_task_detail；特效师等级和每级目标进度看 account_status 的 growth。',
      shape: { ...target, ...pageShape },
      run: async ({ project_path, instance_id, offset = 0, count = 20 }) => text(pageOf(seenGrowth.keep(await d.callPlugin('growth_tasks_list', {}, await homeWindow({ project_path, instance_id }))), offset, count)),
    },
    {
      name: 'task_detail',
      refs: true,
      description:
        '一个特效征集任务的详情：状态、奖励时间、下线时间、我提交到这个任务的特效 my_effects（名称、effect_id、审核状态、拍摄数、播放数、投稿峰值、获奖金额、任务评定 task_state（pending 待评定，任务页不显示标签；unfinished 任务未完成；done 任务已完成；认不出的值原样给）和 off_theme（任务页标了「主题不符合」）、赛道）、完成状态、是否分档任务、任务页推荐工程的模板 id recommended_template_ids（去重后最多前 20 个，总数在 recommended_template_total，全部见 save_to；目前没有工具能按它直接下载，只能当线索），和整理过的任务说明 content：每个内容块（参与要求、奖项详情、近期热门、任务说明等）有名称 name、条目 items 和链接 links；条目有标题 title、正文 text（页面里的链接标记已换成文字，链接放进 links）、参考图 image_refs 和参考视频 video_refs，奖项条目另有页面原样给的金额 money、发放方式 money_mode 和名额 people（unlimited 为不限）；空地址和 blob: 地址任务页里也显示不出来，只在 unusable_media 里计数；读不懂的字段原样放进 unread。要原始返回时传 save_to。task_id 来自 tasks_list（本会话没列过时自动先读一次任务列表）；活动没有详情，成长任务用 growth_task_detail。只看自己所有作品各自绑的任务和灵感评成了什么，用 pipeline_works 每个作品的 bindings 一次取全（ref_id 是作品数据卡片里的编号，和 tasks_list 的 task_id 不一定是一套，对不上时按任务名对）。',
      shape: { ...target, task_id: z.string().min(1).describe('tasks_list 返回的 task_id。'), save_to: saveTo.describe('把接口的原始返回另存到这个目录（绝对路径），文件名 task_detail-<task_id>.json，长期保留。') },
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
      description: '一个成长任务的详情：标题、奖励、标签、参考工程、相关灵感（封面 cover_ref）和教程。task_id 须来自本会话的 growth_tasks_list。',
      shape: { ...target, task_id: z.string().min(1).describe('growth_tasks_list 返回的 task_id。') },
      run: async ({ project_path, instance_id, task_id }) => {
        seenGrowth.get(task_id);
        return text({ task_id, ...(await d.callPlugin('growth_task_detail', { id: task_id }, await homeWindow({ project_path, instance_id }))) });
      },
    },
    {
      name: 'task_receive',
      description: '领取一个征集任务（写入当前登录账号，与活动中心的「领取」按钮相同，领取后不能撤销）。只有状态为 WAIT_RECEIVE 的任务能领，其它状态直接拒绝。返回 designer_task_id 和新状态；领取后本工具会重新读一次任务列表，接着就能 task_bind。',
      shape: { ...target, task_id: z.string().min(1).describe('tasks_list 返回的任务 task_id。') },
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
      description:
        '把工程绑定到一个已领取的任务，和从任务详情页点「去创作」打开的工程一样，提交时会带上该任务。编辑器只在打开工程时写入任务信息，所以本工具会先关闭该工程的窗口（有未保存改动时拒绝，先 save_project），再带着任务信息重新打开，返回新的 pid 和 instance_id。带任务的打开要经由另一个开着的窗口发起，这个工程是唯一的窗口时，会先开一个不保存的空工程当跳板，绑完关掉。task_id 须来自本会话的 tasks_list。只在提交时选任务的话，直接给 submit_prepare 传 task（已领取任务的标题），不用重开窗口。',
      shape: {
        path: z.string().min(1).describe('工程文件夹的绝对路径。'),
        task_id: z.string().min(1).describe('tasks_list 返回的 task_id（须 bindable=true）。'),
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
      description: '热点榜（按热度排序的抖音热点，每小时更新），按 offset / count 分页：名次、topic_id、标题、说明、热度、相关灵感数、封面 cover_ref。一个热点下的灵感用 hotspot_inspirations。',
      shape: { ...target, ...pageShape },
      run: community('rank_hotspots'),
    },
    {
      name: 'hotspot_inspirations',
      refs: true,
      description: '一个热点下的灵感，按热点页页签的顺序、按 offset / count 分页：每条的页签 tab、inspiration_id、标题、标签、说明、封面 cover_ref（交给 image_view 看）；tabs 是全部页签名。详情用 inspiration_detail；把这个热点下全部灵感的图片下载到本机用 hotspot_inspiration_images。',
      shape: { ...target, topic_id: z.string().min(1).describe('rank_hotspots 返回的 topic_id。'), ...pageShape },
      run: async ({ project_path, instance_id, topic_id, offset = 0, count = 20 }) =>
        text(pageOf(await d.callPlugin('hotspot_inspirations', { topic_id }, await homeWindow({ project_path, instance_id })), offset, count)),
    },
    {
      name: 'hotspot_inspiration_images',
      description: `把一个热点下全部灵感的图片下载到本机：逐条读灵感详情，下载详情里的全部图片（封面就是第一张；多数灵感只有 1 张，也有 3 张、6 张的），同一灵感在几个页签里出现只下一次。文件名是「序号-灵感标题-第几张.扩展名」，序号按热点页的顺序；同目录的 index.json 记下每条灵感的 inspiration_id、标题、页签、文件名和原图地址。文件是临时的：存在临时目录里，24 小时后删除（MCP 服务一直开着时到点删；服务重启过的，下次调用本工具时删），要留存就自己复制走。一个热点约 70 张图，一般一分钟左右。返回目录 dir、灵感数、存下的图片数、每条灵感的文件名，以及失败的灵感和原因 failed（详情读不出、图片下载两次都失败或不是图片）；一张都没存下时报错。topic_id 来自 rank_hotspots。`,
      shape: {
        ...target,
        topic_id: z.string().min(1).describe('rank_hotspots 返回的 topic_id。'),
        tab: z.string().min(1).optional().describe('只下这个页签的灵感（hotspot_inspirations 返回的 tabs 之一）；省略时下全部。'),
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
      description: '创新计划的官方精选（像塑移动版发现页的精选列表，移动版展示的是模板）：特效名、effect_id、标签 labels（同一页里同一个特效带不同标签出现多次时合成一条）、投稿量、总收益、入选日期、封面。服务端的 offset 不按条目计，翻页时上一页的特效会再出现，返回的 date 也可能变；要全看时按 effect_id 去重。',
      shape: {
        ...target,
        kind: z.enum(INNOVATION_KINDS).optional().describe('template 精选模板（默认），effect 精选特效。'),
        offset: z.number().int().min(0).optional().describe('翻页偏移，取上一页的 next_offset。'),
        count: z.number().int().min(1).max(100).optional().describe('每页数量，默认 20；精选由服务端过滤，实际条数可能略少。'),
      },
      run: community('rank_innovation'),
    },
    {
      name: 'pipeline_works',
      description:
        '我们全部作品走到精选的哪一步（运营平台 xiangsu.muqian.chat 的 /api/agent/works；它每 10 分钟取一次作品列表和站内信、每小时取一次数据卡片，不连编辑器）。每个作品分三条线，各带 stage、label、since（时间）和 at_kind（platform 平台给的时间、detected 我们发现的时间、derived 按规则算出的时间）：上线 online（reviewing 审核中、testing 测试中、online 已上线、rejected 审核未通过 / test_failed 测试未通过，reason 是驳回原因原文、gone 已下线或删除）；精选 pick（waiting 上线不满 3 天或绑定还在评定中、还可能进精选审核，missed 上线满 3 天且绑定评完仍没进，round1 精选首轮审核中，round2 首轮没过在二审，picked 入选，pick_rejected 落选、reason 是平台原话、几条用「；」隔开，template 模板不发精选审核消息，none 没上线）；精选奖 reward（pending / locked 要拍宣传视频解锁，unlocked 已解锁）。group 分组：act 要用户处理、wait 等结果、done 已结束；action 是要用户做的事。eta 是这一步大概什么时候出结果：ours 是我们自己作品的历史（样本数 n、中位、最慢，样本不到 3 个为 null），ours_range 是按中位和最慢推的时间，ours_passed 表示已经等过最慢的样本，official / official_by 是官方说法和日子。bindings 是绑定的任务和灵感各自的评定 label；metrics 是累计曝光、投稿、收益和最近一天的增量；successor_id 表示被驳回后已经重新提交。还带 summary（各组、各精选阶段个数）、stats（各段耗时的历史分布）、账号是否被限制提交 restricted / restriction 和提交节奏 submit_pace（next_allowed_at 之前不开提交窗口，被限制时为 null）、各块数据的健康 health（ok=false 的块写着原因和上次成功的时间，auth 是像塑登录态）、data_at 最近一次取到作品列表的时间、refreshing 是否正在重取。',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/works')),
    },
    {
      name: 'pipeline_work',
      description:
        '一个作品的完整信息（运营平台 /api/agent/works/:id）：pipeline_works 里那一行，加上时间线 timeline（提交、测试、上线、进精选审核、首轮没过、入选 / 落选、精选奖、加热、完成任务、绑定评定、判没进审，每步的时间、时间来源和距上一步几秒）、按天的累计曝光和投稿 days、数据卡片 figures（页面原样文字）、用到的能力 functions、流量标签 traffic（精选加热带实发和计划曝光）、上线审核记录 reviews（驳回原因原文）、收益明细 revenue、热门用户视频 videos 和作者自己拍没拍过 author_shot、这个作品的全部变化 events。effect_id 来自 pipeline_works。',
      shape: { effect_id: z.string().regex(/^\d+$/).describe('pipeline_works 返回的 effect_id。') },
      run: async ({ effect_id }) => text(await d.platformRequest(`/api/agent/works/${effect_id}`)),
    },
    {
      name: 'account_status',
      description:
        '账号（运营平台 /api/agent/account）：是否被限制提交 restricted 和限制详情 restriction（until 解除时间；until_source=notice 是限制通知里写的，default 是通知没写、按 24 小时算；平台解除时不发通知）、提交节奏 submit_pace（今天交了几个、上次提交时间、下次最早可交 next_allowed_at）、像塑登录态 auth（到期时间 expires_at、是否失效 logged_out、快到期 warn）、资料和数字 profile（昵称、等级、粉丝、开拍总计、本月提交、上线、收入）、收入 revenue、等级成长 growth（每级目标和进度）、本期拍视频激励 shoot_activity（任务、连续打卡档位）、精选作者计划 author_plan、最近 50 条和作品或账号有关的站内信 messages（推广不列）、对不上作品的站内信 unmatched_messages。',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/account')),
    },
    {
      name: 'changes_since',
      description:
        '从「已经告诉过用户」的进度往后的变化（运营平台 /api/agent/changes）：作品阶段变了（审核中、上线、驳回、进精选审核、首轮没过、入选、落选、判没进审、精选奖待解锁 / 已解锁）、绑定的任务和灵感评定变了、完成任务和获奖公布、精选加热、账号限制开始和到解除时间、像塑登录失效或快过期。每条有 id、type（stage、binding、notice、restriction、auth）、at 和 at_kind、作品 effect_id 和 name、一句话 text、needs_you（要用户动手）。会话开始时调一次，把变化（尤其 needs_you 的）告诉用户，告诉完再用 changes_ack 传这次返回的 up_to；不 ack 下次还会拿到。has_more 为 true 时传 after=up_to 接着取。进度是所有 agent 对话共用的，别的对话告诉过的这里不再出现。还带账号是否被限制和提交节奏。',
      shape: {
        after: z.number().int().min(0).optional().describe('从哪个事件 id 之后取，默认是「已经告诉过用户」的进度。'),
        limit: z.number().int().min(1).max(200).optional().describe('最多几条，默认 50。'),
        types: z.string().regex(/^[a-z,]+$/).optional().describe('只看这几类，逗号分隔：stage、binding、notice、restriction、auth。'),
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
      description: '把「已经告诉过用户」的进度推到 up_to（changes_since 返回的 up_to）。只往前推，不超过最新的变化；返回新的进度 told。只在真的把这些变化告诉用户之后调。',
      shape: { up_to: z.number().int().min(0).describe('changes_since 返回的 up_to。') },
      run: async ({ up_to }) => text(await d.platformRequest('/api/agent/changes/ack', 'POST', { up_to })),
    },
    {
      name: 'pipeline_refresh',
      description:
        '让运营平台现在就重取一次作品列表、站内信和到点的数据卡片（POST /api/agent/refresh），刚提交、刚上线、等精选审核消息时用；平时每 10 分钟取一次。5 分钟内最多一次：太近时 started=false 带 next_allowed_at，正在重取时 started=false。交给采集进程后 15 秒内开始，一遍几秒到一两分钟，之后再调 pipeline_works 看 data_at 变没变、refreshing 是否还是 true。',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/refresh', 'POST')),
    },
    {
      name: 'brief_today',
      description:
        '开工简报（运营平台 /api/agent/brief），会话开始、出方向前读一次，结论在前：账号能不能交 account（restricted、until、today、next_allowed_at）；从上次告诉用户以来的变化 changes（needs_you 要用户动手的、latest 最近 10 条、up_to，告诉完用 changes_ack）；AI 按选题流程写的今天主攻建议 focus（inference=true 表示是推断：summary 一句话；focus 每个方向倒推自哪几个爆款 from_hits、人为什么想玩 interest（四类之一）、借的像塑热点 hotspot 和怎么放进钩子 angle、赛道的理由 why、带数字的依据 evidence、要学的入选作品 learn_from、要避开的坑 avoid、候选绑定 bind（tasks 任务标题、inspirations 灵感标题、check 绑之前要逐条对上的要求；标题都是输入里有的，绑前照样用 tasks_open / task_requirements / inspirations_new 核对）；avoid 别做的赛道；model、created_at；还没写成时 missing 说明原因）；赛道表前 12 个 tracks（平台近 30 天精选数 picks_30d、近 7 天 picks_7d 和前 7 天 picks_prev_7d、我们做了 ours、进审 entered、入选 picked、落选 pick_rejected、判没进审 missed、进审率 entry_rate，样本不到 2 个为 null）；平台近 30 天精选总数；从我们结果算出的规律 insights；失败经验前 10 条 lessons（类别 label、平台原话或赛道 reason、次数、涉及作品、最近一次）；从爆款倒推的 hits（inference=true：AI 从几个榜头部的用户视频标题归纳的共同规律 patterns，和前 10 个爆款 top 各自为什么想玩 why、原因类型 hook；ai_at 写的时间）；像塑热点前 6 个 hotspots（标题、热度、一天涨了多少 heat_delta、刚上榜 is_new、站内同题材几个 same_topic_on_site、label 扎堆 / 还早 / 有人做 / 没查、灵感数）；新出现的 fresh（第一次采到灵感以后新出现的灵感个数和前 8 个、现在挂着的【创新】灵感数、7 天内发布的任务）；我们绑过的任务 tasks（截止、有没有同类型条款、每个作品的平台分类和评定）；各块数据的健康 health。more 写了选题时按什么顺序细看：hit_reasons → hot_topics、topic_crowd → track_board、pick_samples、failure_lessons → tasks_open、task_requirements、inspirations_new。',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/brief')),
    },
    {
      name: 'track_board',
      description: '全部赛道（细分类型）的精选情况（运营平台 /api/agent/tracks）：每个赛道的上级分类 parent、平台近 30 天精选数和近 7 天 / 前 7 天、我们做了几个、进审、入选、落选、没进审、还在等、进审率，我们每个作品的阶段 our_works，最近入选的样例 samples（名称、入选日、标签、投稿、用到的能力 functions、图标）。按平台精选数排。模板合成一行「模板」。',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/tracks')),
    },
    {
      name: 'pick_samples',
      description: '官方精选作品明细（运营平台 /api/agent/picks，每天采一次精选榜和入选作品详情）：名称、app_effect_id、特效或模板 kind、赛道 track（平台判定的细分类型）、标签 labels、入选日 reviewed_on、投稿、用到的编辑器能力 functions、图标地址。可按赛道、类型、最近几天筛，按入选日倒序。要看某个作品的视频用 effect_videos，工程用 works_by_effect。',
      shape: {
        track: z.string().max(40).optional().describe('赛道（细分类型），如「脸控游戏」「玩法测试」「模板」，取自 brief_today / track_board 的 track。'),
        kind: z.enum(['effect', 'template']).optional().describe('effect 特效，template 模板；不传两种都要。'),
        days: z.number().int().min(1).max(90).optional().describe('最近几天入选的，默认 30。'),
        limit: z.number().int().min(1).max(200).optional().describe('最多几个，默认 30。'),
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
      description: '全部失败经验（运营平台 /api/agent/lessons，只用平台数据算）：上线审核驳回（按平台给的原因标题归，如「名称与效果不相关」）、测试未通过、精选落选（平台原话，几条分开）、精选首轮没过、没进精选审核（按赛道归）。每条有类别 kind / label、原因 reason、次数 count、涉及作品 works（按先后）、首次和最近一次的时间、一段平台原文 sample_text。同一个原因反复出现的，出方向和起名时要避开。真机试玩的教训不在这里，在规则文件里。',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/lessons')),
    },
    {
      name: 'hot_topics',
      description: '像塑热点（运营平台 /api/agent/hotspots，每 6 小时取一次热点榜）：updated_at 取到的时间；items 按名次，每条有 topic_id、标题、说明、热度 heat、和约一天前比的热度涨落 heat_delta 和名次涨落 rank_delta、刚上榜 is_new、站内同题材的特效和模板 crowd（matched 几个、effects、templates、投稿最高的几个 top，每天按热点标题搜一次）、label（扎堆：同题材 6 个以上；还早：2 个以下又在涨；有人做；没查），前 10 个带热点下的灵感（标题、标签、玩法说明）；rising 是一天涨得最快的 5 个 topic_id。只有像塑自己的热点，不含站外热榜。',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/hotspots')),
    },
    {
      name: 'task_usage',
      description: '我们绑过、还没截止的任务（运营平台 /api/agent/tasks）：标题、截止时间、说明里有没有「同一设计师提交多个同类型玩法」这类条款 same_type_clause、我们每个作品的平台分类 track 和评定 state（pending / unfinished / done / off_theme）。同一个任务有同类型条款时，新作品要和已绑的平台分类不同才绑（规则见 规范/选题与组合.md「绑任务和灵感」）。',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/tasks')),
    },
    {
      name: 'hit_reasons',
      description:
        '从爆款倒推「为什么想玩」（运营平台 /api/agent/hits，每天取一次）：出方向的第一步。items 是年轻喜爱榜、每日投稿榜、热玩互动榜、跟拍榜各前 20 和最近入选的 20 个官方精选（去重，上了几个榜的排前面），每个有名字、app_effect_id、effect_id、图标、在哪几个榜第几 boards（young / publish / play / follow / picks）、投稿、平台给的类型 category、点赞最高的 10 条用户视频 videos（标题、点赞、跟拍、作者、封面 cover_url、播放地址 video_url），和 AI 归纳的 ai（why 人为什么想玩、hook 四类之一：和自己或身边的人有关 / 自己动手马上有反馈 / 有悬念结果不固定 / 戳中正在聊的情绪和梗、evidence 引用的视频标题、how_shot 用户怎么拍）；ai.patterns 是几个爆款共同的点。AI 部分是推断（inference=true），依据只有视频标题；要看用户实际怎么拍，把封面交给 image_view，或用 effect_videos 取视频。',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/hits')),
    },
    {
      name: 'inspirations_new',
      description: '灵感（运营平台 /api/agent/inspirations，每 6 小时取一次灵感列表「全部」页签前 300 条）：new 是第一次采到（baseline_at）以后才出现的灵感（最近 14 天，innovation 标【创新】），innovation 是现在挂着的全部【创新】灵感；每条有 inspiration_id、标题、标签、是否 AI 灵感、关联热点、收藏数、封面、第一次看到的时间 first_seen_at（列表不给发布时间），和绑之前要对的详情 detail（玩法说明 description；激励 incentive：从说明里的【激励说明】解析的截止 deadline、过期没有 expired、要同时绑的任务 tasks（title 和它现在还开没开 open）、奖金区间 reward，说明里没写激励时是 null；平台的大类 effect_types（只有手速比拼、脸部/五官变形、基础脸/头饰三种，测一测也标手速比拼，不当要求用）；bonus_text、奖励 award_text、关联热点 hotspot、前 3 张参考图 images 和总张数 images_total、取详情的时间 at，每 3 天刷一次；还没取到是 null）。激励要求同时绑的任务没开（open=false）或激励过期了，就别为激励绑。参考图交给 image_view 看；要灵感下的作品和视频用 inspiration_detail。',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/inspirations')),
    },
    {
      name: 'tasks_open',
      description: '活动中心没截止的全部任务（运营平台 /api/agent/open-tasks，每 12 小时取一次）：task_id、item_id（task_detail 用它）、kind（task 征集任务 / activity 活动）、标题、状态、领没领 received、标签、发布 released_at、截止 offline_at、7 天内发布的 is_new、说明里有没有同类型条款 same_type_clause、绑之前要逐条对上的要求 requirements（「任务说明」「参与要求」里的征集类型、主题要求、配置要求、不符合任务标准这类原文，没取到详情是 null）、我们放了哪些作品 ours（名字、评定 state、平台分类 track）。新发布的在前。奖项详情、灵感玩法等全文用 task_requirements；只看我们放了作品的用 task_usage。',
      shape: {},
      run: async () => text(await d.platformRequest('/api/agent/open-tasks')),
    },
    {
      name: 'task_requirements',
      description: '一个任务的全部说明（运营平台 /api/agent/tasks/{item_id}/requirements，不用开编辑器）：标题、截止、同类型条款、取详情的时间 at、content（每条 block 块名、title 小标题、text 原文：任务说明、参与要求、奖项详情、灵感玩法……）。绑任务前逐条对要求用；内容块里的参考图和推荐工程用 task_detail。只有没截止的任务和我们绑过的任务有详情，没有时返回 error。',
      shape: { item_id: z.string().regex(/^\d+$/).describe('tasks_open 返回的 item_id。') },
      run: async ({ item_id }) => text(await d.platformRequest(`/api/agent/tasks/${item_id}/requirements`)),
    },
    {
      name: 'topic_crowd',
      description: '查一个题材词在站内扎不扎堆（运营平台 /api/agent/topic）：特效和模板各搜两页，作品名一半以上的相邻两字出现在题材词里才算同题材。返回 matched 同题材几个、effects、templates、投稿最高的几个 top、label（扎堆 6 个以上 / 很少 2 个以下 / 有人做）、搜的时间 at。24 小时内搜过的直接给；没有就交给平台采集进程去搜，这个工具最多等 60 秒，还没好返回 status=pending，过一会儿再调。',
      shape: { q: z.string().trim().min(1).max(30).describe('题材词，如「前任撤回」「冬眠」。') },
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
      description:
        '任意一个已上线特效或模板的详情（像塑移动版「发现」页特效详情同一接口，别人的特效也能看）：名称、类型（特效 / 模板）、effect_id、上线时间、等级代码 level_code、累计投稿 / 点赞 / 评论（页面原样文字）、年轻 / 男生喜爱度、热玩分、男女投稿比例、受众（年龄、性别）、风格（如潮酷）、平台判定的类型 category（如「社交测试」「美妆」）、来自哪个工具、流量状态、用到的编辑器能力 functions（如美瞳、屏幕液化、3D 模型动画、辉光、滤镜，看出爆款怎么组合）、作者及等级、图标 icon_ref、几条示例视频（video_ref 和封面 cover_ref）。category、functions、designer、点赞评论数这几块服务端有时不返回（同一个特效连查也会时有时无），缺的给 null，隔一会儿再查；读不懂的字段原样放 unread。用这个特效拍的视频（标题、跟拍数）用 effect_videos，工程用 works_by_effect。',
      shape: { ...target, app_effect_id: z.string().regex(/^\d+$/).describe('特效在抖音上的 ID：rank_list、rank_subject_detail、rank_innovation、effect_search、pipeline_works 返回的 app_effect_id。') },
      run: community('effect_detail'),
    },
    {
      name: 'effect_videos',
      refs: true,
      description:
        '用一个特效拍的抖音视频（像塑移动版「作品详情」页的视频卡片，别人的特效也能看）：累计点赞和跟拍（页面原样文字），以及几条热门视频 videos（实测 5 条）：抖音视频 ID item_id、标题、作者、点赞、跟拍、封面 cover_ref 和视频 video_ref（交给 image_view 拿地址）。看别人怎么拍、文案怎么写。自己刚上线、还没人拍的特效列表是空的。',
      shape: {
        ...target,
        effect_id: z.string().regex(/^\d+$/).describe('特效 ID（rank_list、effect_search、pipeline_works 等返回的 effect_id）。'),
        app_effect_id: z.string().regex(/^\d+$/).describe('同一个特效的 app_effect_id。'),
      },
      run: community('effect_videos'),
    },
    {
      name: 'effect_search',
      refs: true,
      description: `按关键词搜索像塑全平台已上线的特效或模板（像塑移动版搜索页同一接口）：effect_id、app_effect_id、名称、说明、等级代码、年轻喜爱度、累计投稿（页面原样文字）、图标 icon_ref。特效最多翻到 100 条。按 cursor 翻页，每页最多 ${SEARCH_MAX} 条。顺序是服务端定的，前几名多是累计投稿很高的老特效；接口不认排序参数（2026-11-09 试了 sort_type、order_by、sort 等 12 种写法，顺序都不变），要看现在火的用 rank_list / rank_subjects。只搜首页工程用 works_search；拿到特效后用 effect_detail 看详情、effect_videos 看视频、works_by_effect 找工程。搜灵感用 inspiration_search，搜教程用 tutorial_search。`,
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
        '像塑官方教程（移动版「教程」页同一组接口）：每次都带上全部分类 tabs（特效：新手入门、特效进阶、精选课程、PC工具、工程实操、三方工具、爆款分享、账号运营、视频教程；模板：模板入门、模板进阶等），按 tab_id 列出一个分类的教程，不传时列出全部（约 190 篇，比各分类之和多）。每篇有标题、标签（如「新手必看」「拍视频脚本」）、学习人数、作者、上线日期、是否付费、文档链接 link（飞书文档，要登录飞书才能打开，agent 读不到正文，只能看标题和标签）、封面 cover_ref 和视频 video_ref（视频教程才有，交给 image_view 拿到的地址能直接打开）。按 offset / count 分页。按关键词找教程用 tutorial_search。',
      shape: {
        ...target,
        tab_id: z.number().int().optional().describe('分类 ID，取返回的 tabs 里的 tab_id；省略时列出全部教程。'),
        ...pageShape,
      },
      run: community('tutorials_list'),
    },
    {
      name: 'shoot_scripts',
      refs: true,
      description: `像塑官方的拍摄脚本（移动版「拍摄脚本」同一接口）：教你用特效拍什么样的视频（如「【测一测】表演有梗结果」「【美妆】带特效前后反差」），每条有脚本 ID、名称、完整说明 description（脚本解读和「尝试拍一个」的具体做法）、标签代码 tags、播放数 views、拍摄数 shoots、封面 cover_ref 和示范视频 video_ref。tag 按标签代码筛选，App 里没有标签名，实测各代码下的脚本：${SCRIPT_TAG_TEXT}。type 是接口给的脚本类型代码，含义也没给出（1 多为技巧合集，2 多为具体演绎）。全部约 50 条，按 offset / count 分页。`,
      shape: {
        ...target,
        tag: z.coerce.number().int().optional().describe(`标签代码（整数，写成 "3" 也行）：${SCRIPT_TAG_TEXT}；省略时全部。`),
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
      description: '抖音音乐库一个分类的一页（每页约 35 首，按 cursor 翻页）：music_id、标题、作者、时长 duration_sec、封面 cover_ref、试听 preview_ref（音频引用）和 has_copyright（音乐库给的版权标记，false 或 null 的不要用于要发布的特效），以及下一页的 next_cursor、has_more。分类 code 从 music_categories 取；按关键词找歌用 music_search。',
      shape: { ...target, category_code: z.string().min(1).describe('music_categories 返回的分类 code。'), cursor: musicCursor },
      run: async ({ project_path, instance_id, category_code, cursor }) => text(seenMusic.keep(await d.callPlugin('music_list', { category_code, ...(cursor === undefined ? {} : { cursor }) }, await homeWindow({ project_path, instance_id })), { category_code })),
    },
    {
      name: 'music_search',
      refs: true,
      description: '按关键词搜抖音音乐，一页约 35 首、按 cursor 翻页：每首的 music_id、标题、作者、时长 duration_sec、封面 cover_ref、试听 preview_ref（音频引用）和 has_copyright（false 或 null 的不要用于要发布的特效），以及 next_cursor、has_more。',
      shape: { ...target, query: z.string().min(1).describe('搜索关键词。'), cursor: musicCursor },
      run: async ({ project_path, instance_id, query, cursor }) => text(seenMusic.keep(await d.callPlugin('music_search', { query, ...(cursor === undefined ? {} : { cursor }) }, await homeWindow({ project_path, instance_id })), { category_code: null })),
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
        '把场景结构输出成紧凑的缩进文本：渲染组，以及每个对象的 guid、名称、是否隐藏、组件类型。比官方 get_scene 的 JSON 好读，适合先摸清结构再用 inspect_many 查参数；要渲染组和对象的完整 JSON 用 get_scene。subtree 只看某个对象：guid、名称，或层级路径（从渲染组名起，或只给末尾几段，如「2D 前景/2D 摄像机」；同名对象常见，重名时报 AMBIGUOUS_OBJECT 并列出各自的 guid 和路径），depth 控制展开层数（默认 6）；没展开的子对象会注明数量。传 project_dir（工程目录，如 works_download 下载的作品）时不需要打开窗口，直接读 Assets/main.scene 和 main.scene.extra，对象写成 #序号，组件类型和窗口里显示的一致（编辑器数据缺失时退回场景文件里的名称）；没有渲染组这一层，渲染组本身作为根对象列出。save_to 是目录的绝对路径，结果另存为其中的 scene_tree.txt，长期保留。',
      shape: {
        ...target,
        project_dir: z.string().min(1).optional().describe('不开窗口、直接读这个工程目录的场景文件；给了它就不看 project_path / instance_id。'),
        subtree: z.string().min(1).optional().describe('只输出这个对象及其子对象：guid（project_dir 时是 #序号）、名称或层级路径。'),
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
      description:
        '一次查看多个对象的组件参数（逐个调用官方 inspect；只看一个对象的完整原始数据时直接用 inspect），值里的 {type, data} 包装直接展开成值，超长数组只给长度和前几项；绑定的资源写成 {resource, type, file}，引用的对象写成 {object, name}。component_types 只留某些组件（如 ["Transform"]），fields 只留属性名包含这些片段的属性（不分大小写，如 ["intensity", "position"]）。fields 也会留下内部某一层属性名包含这些片段的整块参数（如后处理的 bloom 块里的 pBloomThreshold）。妆容层（FaceMask / FaceMaskDY）的混合模式编号旁边加上 blendMode_name / surfaceBlendMode_name（如「正片叠底」）。preset="key" 自动留下通常决定效果的参数：位置/缩放/旋转、显隐与启用、强度/不透明度/Transparency/权重/颜色类属性、AI 脸的 Channel（Texture 皮肤路 / Distortion 形变路）、内部含强度类参数的整块参数（如后处理的发光、调色）、文字内容（str）与 2D 尺寸（sizeDelta）、绑定的资源，以及场景文件里脚本组件的全部参数；空的贴图槽（编辑器的「缺失纹理」）和完全透明的黑色（妆容层没用到的珠光色等）会丢掉（这份清单是按已做过的妆容、形变、贴纸、文字效果拍的，缺的用 fields 补，可与 fields 同时用；fields 点名的属性即使空着也留下）。guids 里每一项可以是 guid、对象名称或层级路径（同 scene_tree 的 subtree：从渲染组名起，或只给末尾几段；重名时该项报 AMBIGUOUS_OBJECT 并列出候选）；不是场景对象的 guid（组件、资源）原样交给官方 inspect。传 project_dir 时不开窗口、直接读场景文件（含编辑器面板里的参数，如妆容的贴图和强度），guid 是 scene_tree 给出的 #序号；内置资源写成 {builtin: id}，组件运行时生成、工程里没有文件的资源写成 {path}。单个对象失败只在该项写明原因。save_to 是目录的绝对路径，结果另存为其中的 inspect_many.json，长期保留。',
      shape: {
        ...target,
        project_dir: z.string().min(1).optional().describe('不开窗口、直接读这个工程目录的场景文件；给了它就不看 project_path / instance_id。'),
        guids: z.array(z.string().min(1)).min(1).max(40).describe('要看的对象：guid（scene_tree / get_scene 返回的；project_dir 时是 #序号）、名称或层级路径；开窗口时也可以是组件或资源的 guid。'),
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
      description:
        '列出一个工程的全部美妆层（FaceMask 妆容层、旧版 FaceMaskDY 妆容层和 EyeColorV2 美瞳），逐层说明画在哪个部位、什么颜色、男女强度，以及是否生效（对象或上级隐藏、组件停用、男女强度都为 0 的不生效）。区域（全脸 / 眼部 / 睫毛 / 唇部 / 牙齿）取自妆容层自身的类型；部位先看层名（眉、眼线、腮红、口红等关键字），层名看不出时按贴图像素判断（part_from 注明依据），颜色是贴图上色部分按透明度加权的平均色（color 和 hsl）；层上设了着色 tint 时另给贴图色乘上着色的 tinted_color / tinted_hsl（按着色和贴图相乘算的，没有实测核对）。整张不透明的贴图（底色是白或黑、靠颜色深浅起作用）按每个像素离该混合模式下「不改变皮肤」的颜色多远来算颜色和范围，并在 texture_note 里注明；几乎全是这种中性色的层没有颜色，texture_note 说明它几乎不改变皮肤。texture_source 标出贴图从哪来：AI 妆容（素材库「AI 妆容」提取的，带 task_id 和部位 part，即 ai_makeup_import 导入的那种）、素材广场（应用素材广场的 AI 妆容卡片得来，id 是卡片的 id）、官方素材包（package_id 是这个包在素材库里的 template_id；整套美妆和部分素材包解压在按包名命名的文件夹里，这时给的是 package_folder，如「清冷_美妆」）、作者导入（file 是作者导入时的文件名）或未知，copy 为 true 表示是复制出来的副本（常是作者在官方贴图上改过）。FaceMask 的 intensity 是面板上的「不透明度」：单独加的层实际画出的浓度 opacity = intensity × 男女强度 × 外部强度；挂在整套美妆（AI 实时变脸）下的子项由 GAN 接管，改 intensity 不起作用，opacity 只按男女强度 × 外部强度算。FaceMaskDY 面板上只有一个强度（intensity），男女强度取它运行时各自的不透明度（实际渲染用的是这两个）；它的唇部质地写成 surface（混合模式和强度）。groups 按眉、眼妆、美瞳、颊、轮廓、唇、点缀汇总生效的层，absent 列出整套妆里没有的部位，用来看一套妆缺了什么、或拆解别人的作品（works_download 下载的工程）用了哪些部位和颜色。读的是工程目录里的场景文件：正在编辑的工程先 save_project。',
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
      name: 'makeup_compare',
      description: `在同一张脸上比较几种妆容状态：重置预览、播放 at_ms 后截基线（当前状态），再依次把每个 variant 的改动临时套上、等预览画出来、截一帧、改回去，最后再截一次基线。要用静态照片做的预览视频（如「模特D清秀||女」这些模特视频，每一帧都是同一张照片）：会动的视频每次截到的是不同的帧，两次基线的平均亮度差超过 ${DRIFT_MEAN} 时返回提示。预览暂停后不再重绘，所以不能靠暂停停住画面。改动有两种，都实时生效、跑完改回原值：一是妆容层的 female / male（男女强度）和 intensity（面板上的「不透明度」，单独加的层实际画出的浓度是它 × 男女强度；整套美妆的子项由 AI 脸接管，改它不起作用）、美瞳和滤镜的 intensity；二是任意组件的一个数值属性：object_path + component（inspect 里的组件类型名，如 GanComponent、PostProcess）+ property（如 Transparency、bloom.pBloomIntensity）+ value，经官方 set_component 设置，用来比 AI 脸皮肤路强度、发光强度这类参数。换贴图、换混合模式要重载预览，不在这里比。整套妆的子项也可以这样调，强度改回原值，不会删层。regions 是按画面比例（0–1）给的区域，如眼下、脸颊、唇：每个区域返回每种状态的平均色 RGB / HSL、亮度 luma（Rec.601）、皮肤细节 detail（亮度减去 σ ${DETAIL_SIGMA} px 高斯模糊后的平均绝对差，越高纹理越多），以及相对基线的差值；再给一张并排放大图（基线在最前，之后按 variants 顺序，像素直接放大不插值，一行放不下时换行）。给了 reference（参考图）时，区域的 ref 是同一部位在参考图上的框（按参考图的比例），每种状态另给 to_reference（相对参考图的差值），并排图最后一格是参考图的这一块（缩放到同样大小）。同一张静态照片上前后两帧在眼部的噪声约 0.5–0.8（平均，最大 13–18），差值比这个小的看不出区别。videos 依次在几个预览视频上各比一次，完了切回原视频。跑完所有改动都已改回；切换过视频或改过参数后工程会显示「已修改」。`,
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
                      object_path: z.string().min(1).describe('妆容层、美瞳或滤镜对象的层级路径（或能唯一定位的末尾几段）。'),
                      female: z.number().min(0).max(1).optional(),
                      male: z.number().min(0).max(1).optional(),
                      intensity: z.number().min(0).max(1).optional().describe('妆容层：面板上的不透明度；美瞳、滤镜：强度。'),
                    }),
                    z.strictObject({
                      object_path: z.string().min(1).describe('对象的 guid、名称或层级路径（同 inspect_many）。'),
                      component: z.string().min(1).describe('组件类型名，如 GanComponent、PostProcess。'),
                      property: z.string().min(1).describe('属性名，嵌套的用点路径，如 Transparency、bloom.pBloomIntensity。'),
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
          .describe('区域：按画面比例给框（模特的眼睛位置各不相同，同一个比例框在别的模特脸上会框偏，换模特时按截图重新给框）。'),
        reference: z.string().min(1).optional().describe('参考图（PNG / JPEG）的绝对路径；和区域的 ref 一起用。'),
        videos: z.array(z.string().min(1)).min(1).max(MAX_FRAME_VIDEOS).optional().describe('依次使用的预览视频名称（preview_videos 列出的 video_name）；不给就用当前视频。'),
        tracking_type: z.string().min(1).optional().describe('videos 所属的 tracking_type，默认 face。'),
        at_ms: z.number().int().min(0).max(20000).optional().describe(`重置后播放多久再截基线（毫秒），默认 ${HOLD_AT_MS}（AI 变脸要过一会儿才完全生效）。`),
        zoom: z.number().int().min(1).max(8).optional().describe('并排图的放大倍数，默认 3。'),
        save_to: saveTo,
      },
      run: async (a) => {
        const { variants, regions, reference, videos, tracking_type = 'face', at_ms = HOLD_AT_MS, zoom = 3, save_to } = a;
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
      description: '可用的预览视频名，按 tracking_type 分组（face、two_person、body、hand、pet、environment），外加当前视频 current：只给名字，用来挑 preview_frames、makeup_compare 的 videos 和官方 set_preview_video 的 video_name。要地址、有没有本地文件等全部字段用官方 list_preview_videos（约 70 KB）。',
      shape: { ...target, tracking_type: z.string().min(1).optional().describe('只列这一类，如 face；不给就全列。') },
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
      description:
        '按时间连续截取预览画面，分辨率是预览本身的（720×1280，官方截图是缩小后的 320×569），取自预览的渲染结果，窗口在后台或最小化时也能截（截图期间临时恢复正常帧率）：默认先重置预览、等到重载后的画面出来，再每隔 interval_ms 截一张，共 count 张（一次最多 24 张），用来看动态效果、摇头时的侧脸等。videos 可依次换几个预览视频各截一组（名称取自 preview_videos，如 preview_single_shake_head||女），全部截完切回原视频，并等编辑器把视频写回工程信息，工程原来没有未保存的改动时，截完仍是干净的（note 里说明）。crop 按画面比例（0–1）裁出局部，如脸部。每帧都存成文件并随结果返回，files 里是路径，可直接贴给用户看；默认存在临时目录、24 小时后删除，save_to（目录的绝对路径）则存到那里长期保留。每帧注明实际截取时刻（相对重置完成的毫秒数）。',
      shape: {
        ...target,
        count: z.number().int().min(1).max(12).optional().describe('每个视频截几张，默认 4。'),
        interval_ms: z.number().int().min(100).max(10000).optional().describe('相邻两张的间隔（毫秒），默认 700。'),
        videos: z.array(z.string().min(1)).min(1).max(MAX_FRAME_VIDEOS).optional().describe('依次使用的预览视频名称（preview_videos 列出的 video_name）；不给就用当前视频。'),
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
      name: 'menu_list',
      description:
        `列出像塑「添加对象」菜单里的全部官方功能项（工具栏美妆、美型、AI 实时变脸，及人脸/身体/2D/3D/AI 玩法/互动/宠物/音乐等），返回 menu_id、中文名、路径、类型。官方 edit_by_dsl 的 add_builtin_object 命令只覆盖其中一部分；美容（面部提拉、祛皱纹）、面部生成（烟熏妆、卡通脸）、表情生成（香肠嘴、呲牙尬笑）、性别年龄、五官处理、身体换装等用 menu_add。query 按名称、路径或 menu_id 过滤。details=true 时每项再带说明 description 和示意图（编辑器悬停提示里的图：在 CDN 上的给 image_url，随编辑器安装的给本机文件 image_file，都没有为 null），按画面挑选 AI 变脸、美容等效果时把它交给 image_view 看；details 一次最多 ${MAX_MENU_PREVIEW} 项，query 匹配更多时报错。云端 AI 生成项不在列表中；拍照后云端生图的「AI 组合效果」用 ai_combine_new / ai_combine_apply。`,
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
        '新建一张「AI 组合效果」工作流（用户拍照后在云端按工作流出图或出视频），等同 AI 效果窗口的「新建工作流」：在本地建 AI Graph，只有「输入图」和「效果组合」两个节点且未连线；不联网、不扣额度、不建云端草稿。返回 ai_graph_id 和各节点的 node_id，交给官方 get_workflow_context / get_workflow_capabilities / apply_workflow_patch 添加生图节点、写 prompt、连线（图生视频节点官方工具建不了，用 ai_video_node）（官方 apply_workflow_patch 每次改完会把工作流保存成账号下的云端 AI 效果草稿），要看效果用官方 generate_workflow（扣额度）。改好后用 ai_combine_apply 放进场景。「添加对象」菜单里的 AI 组合效果只建空壳，不要用 menu_add。',
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
      name: 'ai_video_node',
      description:
        '在 AI 工作流里加或改一个「视频生成」节点，即 AI 效果窗口的「图生视频」（Seedance 系列：照片 + 提示词生成一段视频）；官方 apply_workflow_patch 只能建生图节点。不传 node_id 时新建：按节点编辑面板的做法用所选模型初始化，把图里的「输入图」连到它的第一个图片口、它的输出连到「效果组合」的空输入口，摆在两者之间（图里有多个输入图时要传 input_node_id，效果组合没有空口时报 COMBINATION_PORT_TAKEN，都在改图之前报）。传 node_id 时只改这个节点的参数；换模型时从新模型的默认参数开始，提示词沿用。参数按所选模型的面板核对，各模型不同（如 Seedance 2.0 Mini 时长 5–15 秒、分辨率 480p / 720p，Seedance 2.5 时长 4–30 秒、多 1080p），不合法时报错并列出可选值。改完照官方补丁的做法把工作流存成云端草稿（saved；没存上时 save_error 是原因）。不联网生成、不扣额度。之后照常：upload_workflow_image + apply_workflow_patch（update_node_params）给输入图绑照片，generate_workflow 看效果（扣模型次数），ai_combine_apply 放进场景。返回 node_id、created、model（id、name）、params（节点存的参数）、新建时的 connected。',
      shape: {
        ...target,
        graph_id: z.string().min(1).describe('ai_combine_new 或官方 get_workflow_context 返回的 ai_graph_id。'),
        node_id: z.string().min(1).optional().describe('要改的视频生成节点（get_workflow_context 里 type 为 Video 的 id）；省略时新建一个。'),
        model: z.string().min(1).optional().describe('模型的显示名，如「Seedance 2.0 Mini」「Seedance 2.0 Fast」「Seedance 2.0」「Seedance 2.5」；新建时默认 Seedance 2.0 Mini，改节点时省略则不换模型。写错时报 UNKNOWN_VIDEO_MODEL 并列出可选的。'),
        prompt: z.string().min(1).optional().describe('提示词：描述要生成的画面和动作。新建时必填。'),
        duration: z.number().positive().optional().describe('视频时长（秒），范围看模型；省略时用模型默认（Mini 是 10）。'),
        aspect_ratio: z.string().min(1).optional().describe('视频比例，如 9:16、16:9、1:1；省略时用模型默认（9:16）。'),
        resolution: z.string().min(1).optional().describe('分辨率，如 480p、720p；省略时用模型默认（480p）。'),
        input_node_id: z.string().min(1).optional().describe('新建时要连的输入图节点；图里只有一个输入图时可省略。'),
      },
      run: plugin('ai_video_node', 120000),
    },
    {
      name: 'ai_video_results',
      description:
        '读 AI 工作流里「视频生成」节点和「效果组合」节点的生成结果（官方 generate_workflow 成功后用；官方 download_workflow_node_asset 只认生图节点）：每个节点的状态 state（waiting / success 等）和生成的视频 videos：本机文件 local_path（编辑器 AI 效果窗口预览用的那份缓存，没有下载时加的水印；缓存被清掉时为 null，重新生成才有）、宽高、时长 duration_s。看效果用 ffmpeg 抽帧再 image_view。只读，不联网。',
      shape: { ...target, graph_id: z.string().min(1).describe('ai_combine_new 或官方 get_workflow_context 返回的 ai_graph_id。') },
      run: plugin('ai_video_results'),
    },
    {
      name: 'ai_makeup_submit',
      refs: true,
      description: `素材库「AI 妆容」的「立即提取」：上传一张带妆的人像参考图，AI 从中提取面部（腮红、修容这类）、美瞳、眼部、睫毛、唇部五张妆容贴图和每个部位的推荐强度，返回 task_id。任务走面板自己的 AIMakeupManager，面板的生成记录里同样能看到。参考图须是 ${AI_MAKEUP_IMAGE_LIMIT.exts.join(' / ').toUpperCase()}、不超过 ${AI_MAKEUP_IMAGE_LIMIT.maxMB} MB，主体清晰、无遮挡（面板的提示），越接近正脸近景提取得越准。有任务在跑时拒绝提交（报 AI_MAKEUP_RUNNING；面板此时也禁用「立即提取」）。默认等任务完成（最多 wait_s 秒，2026-11-11 实测每次 5–8 秒），完成后返回：parts（每个部位的 part、name、贴图 image_ref、推荐的 intensity 面板不透明度、female / male 男女强度、blend_mode 混合模式及其名称；美瞳是 intensity、reflect_intensity 反光强度和两种混合模式）、参考原图 reference_image_ref，以及 preview_file（面板的「整妆」预览：妆画在编辑器内置样例脸上，交给 image_view 看）。没等到完成时 status 是 running，之后用 ai_makeup_tasks（task_id + wait_s）。满意后用 ai_makeup_import 导入工程。是否扣账号额度以编辑器为准，编辑器代码里没有相关提示（历史记录里的 cost 是任务耗时的秒数，不是额度）。`,
      shape: {
        ...target,
        image_path: z.string().min(1).describe('参考图的绝对路径。'),
        wait_s: z.number().int().min(0).max(AI_MAKEUP_MAX_WAIT_S).optional().describe(`最多等任务完成的秒数，默认 ${AI_MAKEUP_WAIT_S}；0 表示提交后立即返回。`),
      },
      run: async (a) => {
        const { project_path, instance_id, wait_s = AI_MAKEUP_WAIT_S, ...params } = a;
        const got = await d.callPlugin('ai_makeup_submit', { ...params, wait_s }, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: wait_s * 1000 + AI_MAKEUP_SLACK_MS });
        return text(nameBlends(got));
      },
    },
    {
      name: 'ai_makeup_tasks',
      refs: true,
      description: `素材库「AI 妆容」的提取记录（当前账号，与面板右侧的记录同一份），最新的在前。不传 task_id 时按 cursor 分页列出：状态（running / finished / failed）、创建和完成时间、参考原图 reference_image_ref、失败原因 failure，完成的带 parts（各部位贴图 image_ref 和推荐强度、混合模式，字段同 ai_makeup_submit）。传 task_id 时只查这一个，再给 wait_s 就一直等到它不再是 running 或时间到（最多 ${AI_MAKEUP_MAX_WAIT_S} 秒）；完成的另给 preview_file（面板的「整妆」预览，交给 image_view 看）。`,
      shape: {
        ...target,
        task_id: z.string().min(1).optional().describe('只查这个任务（ai_makeup_submit 返回的 task_id）。'),
        wait_s: z.number().int().min(0).max(AI_MAKEUP_MAX_WAIT_S).optional().describe('配合 task_id：最多等多少秒，默认 0（只查一次）。'),
        cursor: z.number().int().min(0).optional().describe('翻页游标，原样取上一页的 next_cursor。'),
        count: z.number().int().min(1).max(AI_MAKEUP_HISTORY_PAGE).optional().describe(`每页数量，默认 ${AI_MAKEUP_HISTORY_PAGE}（服务端上限）。`),
      },
      run: async (a) => {
        const { project_path, instance_id, task_id, wait_s = 0, cursor, count } = a;
        const win = await homeWindow({ project_path, instance_id });
        if (task_id !== undefined) return text(nameBlends(await d.callPlugin('ai_makeup_task', { task_id, wait_s }, { ...win, timeoutMs: wait_s * 1000 + AI_MAKEUP_SLACK_MS })));
        if (a.wait_s !== undefined) throw Error('INVALID_ARGUMENTS: wait_s only applies together with task_id');
        return text(nameBlends(await d.callPlugin('ai_makeup_tasks', { cursor, count }, win)));
      },
    },
    {
      name: 'ai_makeup_import',
      description:
        '把一个已完成的 AI 妆容任务导入目标工程，等同面板里勾选部位后点「导入素材」（不动面板里自己勾选的项）：每个部位的贴图以面板的文件名「AI 美妆_面部.png」等导入 Assets（工程里已有同名文件时编辑器自动改名为「AI 美妆_面部 (1).png」，不会覆盖之前导入的），在「面部面具」下建同名的层（场景里没有「面部面具」时连同它的摄像机一起建），强度、男女强度和混合模式取 AI 的推荐值。美瞳层另外处理：编辑器 9.8.1 的面板会把美瞳的贴图和强度写到一个美瞳层上并不存在的组件，导入后的美瞳层其实是内置的默认棕色瞳色、强度 0.8；本工具把 AI 的美瞳贴图、推荐强度、反光强度和混合模式写到美瞳组件（EyeColorV2）上，并照面板的意图关掉透明度贴图。可撤销（编辑器每个部位记两步）。parts 只导部分部位，默认全部五个。返回 added_objects、layers（每层的 object_path、贴图 texture、读回的 intensity / female / male / blend 等，美瞳是 intensity）、skipped_parts（这次提取没给贴图的部位）和 package_folders。之后用 makeup_compare 调强度，save_project。',
      shape: {
        ...target,
        task_id: z.string().min(1).describe('ai_makeup_submit / ai_makeup_tasks 返回的 task_id（须 status=finished）。'),
        parts: z
          .array(z.enum(['rest', 'pupil', 'eyepart', 'eyelash', 'lip']))
          .min(1)
          .optional()
          .describe('只导这些部位：rest 面部、pupil 美瞳、eyepart 眼部、eyelash 睫毛、lip 唇部；默认全部。'),
      },
      run: async (args) => {
        const { project_path, instance_id, ...params } = args;
        const projectPath = await projects.resolveProjectPath({ project_path, instance_id });
        return text(nameBlends(await d.callPlugin('ai_makeup_import', params, { projectPath, timeoutMs: AI_MAKEUP_IMPORT_TIMEOUT_MS })));
      },
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
      description: `素材库「AI 3D」的生成任务（当前账号）。不传 task_id 时按 kind（必填）分页列出历史任务：状态（running / finished / failed）、创建和完成时间、输入（图生 3D 的精度、3D 动画的模型）、失败原因，以及结果是否已下载到本机和本机的预览图 / 预览视频（preview_image_file 交给 image_view 看）。传 task_id 时只查这一个（不用给 kind）；再给 wait_s 就一直等到它不再是 running 或时间到（最多 ${AI3D_MAX_WAIT_S} 秒），status=finished 后用 ai3d_import 导入。`,
      shape: {
        ...target,
        kind: z.enum(['image', 'animation', 'gs']).optional().describe('列历史时必填：image=3D模型（图生 3D）、animation=3D动画、gs=高精度模型重建。只查一个 task_id 时不用给。'),
        task_id: z.string().min(1).optional().describe('只查这个任务（不用给 kind）。'),
        wait_s: z.number().int().min(0).max(AI3D_MAX_WAIT_S).optional().describe('配合 task_id：最多等多少秒，默认 0（只查一次）。'),
        cursor: z.number().int().min(0).optional().describe('翻页游标，原样取上一页的 next_cursor。'),
        count: z.number().int().min(1).max(AI3D_HISTORY_PAGE).optional().describe(`每页数量，默认 ${AI3D_HISTORY_PAGE}（服务端上限）。`),
      },
      run: async (a) => {
        const { project_path, instance_id, kind, task_id, wait_s = 0, cursor, count } = a;
        const win = await homeWindow({ project_path, instance_id });
        if (task_id !== undefined) return text({ ...(kind ? { kind } : {}), ...(await d.callPlugin('ai3d_task', { task_id, wait_s }, { ...win, timeoutMs: wait_s * 1000 + 30000 })) });
        if (a.wait_s !== undefined) throw Error('INVALID_ARGUMENTS: wait_s only applies together with task_id');
        if (kind === undefined) throw Error('INVALID_ARGUMENTS: kind is required to list the history (image, animation or gs)');
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
        '素材库「AI 素材 › AR 视频」（AR 视频贴片）：提交一次生成，等同面板上的「立即生成」，云端（Seedance）接受任务后返回 task_id。编辑器没有单独的模式开关，由输入决定：mode=direct 只抠像、不改动作，主体须是视频，不能带 prompt 和参考素材；mode=motion 由 prompt（必填）描述新动作或样式，主体可以是图片或视频，可加参考图（如给主体加道具）和一段参考动作视频。输入先交给编辑器自己的素材检查和转换（与面板上传素材相同：只认 JPG / JPEG / PNG / MP4 / MOV，包括主体最多 9 张图、3 段视频，视频每段至少 2 秒、合计不超过编辑器开关给的上限，主体视频原长须小于 60 秒；不合规格的图片自动缩放压缩、视频自动转码裁剪，转不了时报 AR_VIDEO_INPUT_INVALID 并带编辑器原话），视频还要先过编辑器的内容审核（最长 15 分钟）。动作时长 duration_s 默认 10 秒，最短 4 秒，上限由编辑器开关决定（9.8.1 为 15 秒，9.8.3 为 30 秒，以 ar_video_tasks 返回的 limits 为准）。shadow 是「添加投影」，省略时用编辑器默认（开关 dyeh_enable_ar_video_shadow，2026-11-08 为开）；开着时结果是带投影的幕底视频。同时最多 10 个任务在跑。会占用账号的 AI 模型使用次数（按特效师等级给），编辑器里查不到剩余次数和单次扣多少，用完时报「模型使用次数达到上限」。任务在哪个工程窗口提交，就在那个窗口里下载并合成结果，之后的 ar_video_tasks / ar_video_import 用同一个窗口最快；实测一段 10 秒的图片生成动作从提交到合成完约 6 分钟。',
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
      description: '取消一个还在 running（或 unconfirmed）的 AR 视频生成任务，等同面板里的「取消生成」。取消确认后任务从记录里消失（cancelled=true）；取消前它已经结束时返回 cancelled=false 和结束时的 status。已经结束的任务（完成、失败、已取消）不能取消，直接报 AR_VIDEO_NOT_RUNNING。',
      shape: { ...target, task_id: z.string().min(1).describe('要取消的 task_id。') },
      run: plugin('ar_video_cancel'),
    },
    {
      name: 'sfx_synth',
      description: `合成音效（不开像塑，用像塑自带的 ffmpeg 出 MP3）：预设取自各特效工程用过的音效脚本，频率、包络和默认音量照原样（没有随机噪声的预设和原脚本逐采样一致）。预设：${Object.entries(SFX_PRESETS)
        .map(([k, p]) => `${k} ${p.desc}`)
        .join('；')}。pitch 整体升降调（${PITCH_RANGE[0]}–${PITCH_RANGE[1]} 倍），volume 是峰值（默认按预设）。.mp3 是双声道 128 kbps（工程里导入的就是这种），.wav 是单声道 16 位。mp3 拷进 Assets/ 后有时会自动导入、有时不会：用官方 list_resources 看，没有再用官方 import_resource（绝对路径）导入。官方音效库没有合适的声音时用它；要做的是循环音、旋律或预设里没有的声音，仍按工程的做法写脚本。`,
      shape: {
        out_dir: outDir,
        sounds: z
          .array(
            z.strictObject({
              preset: z.enum(Object.keys(SFX_PRESETS)),
              file: z.string().regex(/^[^/\\:*?"<>|]+\.(mp3|wav)$/, '文件名（不含目录）以 .mp3 或 .wav 结尾'),
              pitch: z.number().min(PITCH_RANGE[0]).max(PITCH_RANGE[1]).optional().describe('升降调倍数，默认 1。'),
              volume: z.number().min(0.05).max(1).optional().describe('峰值 0–1，默认按预设（0.45–0.8）。'),
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
      description:
        '把文字渲染成透明 PNG（不开像塑）：描边、上下渐变、投影都能做（Text2D 的描边设不进去，粗描边字只能做成图片放在 Image 上）。一次最多 60 张，比如一组数字 0–9、几句弹字。图片按文字加描边、投影和留白的范围裁好，返回每张的宽高（摆 ScreenTransform 用）。字体默认抖音体；字体须有授权（像塑自带字体或 SIL OFL 这类开源可商用字体）。',
      shape: {
        out_dir: outDir,
        items: z
          .array(z.strictObject({ file: pngFile, ...textStyle, padding: z.number().min(0).max(100).optional().describe('四周留白（像素），默认 4。') }))
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
      description:
        '画界面底板 PNG（不开像塑）：圆角矩形或胶囊（radius="pill"），纯色或上下渐变（颜色可带透明度，如 #121c2e96 半透明深色磨砂底），可加描边和投影，里面可以放几行居中的文字（每行单独设字号、颜色、描边）。不给 width / height 时按文字加 padding 自动定大小。用来做开局提示条、结算卡、按钮底。一次最多 30 张，返回每张的宽高（含投影外扩）。',
      shape: {
        out_dir: outDir,
        items: z
          .array(
            z.strictObject({
              file: pngFile,
              width: z.number().int().min(4).max(2048).optional(),
              height: z.number().int().min(4).max(2048).optional(),
              radius: z.union([z.number().min(0).max(1024), z.literal('pill')]).optional().describe('圆角半径（像素），或 pill 两头全圆；默认 24。'),
              fill: hexColor.optional().describe('底色，默认 #ffffff。'),
              gradient: z.array(hexColor).min(2).max(6).optional().describe('从上到下的渐变（替代 fill）。'),
              stroke: strokeArg,
              shadow: shadowArg,
              padding: z.number().min(0).max(200).optional().describe('自动定大小时文字四周的留白，默认 24。'),
              line_gap: z.number().min(0).max(200).optional().describe('行与行之间的间距，默认 8。'),
              lines: z
                .array(z.strictObject({ ...textStyle, shadow: shadowArg }))
                .max(6)
                .optional()
                .describe('底板上的文字，从上到下居中排列。'),
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
      description: `把自己的模特加进像塑的预览视频清单（不开像塑）：一张照片（默认 ${PHOTO_SECONDS} 秒静止视频）、一段视频，或两张照片交替循环（alternate，用来验「做一次表情记一次」：平静照和表情照交替），按内置预览视频的规格转码（720×1280、h264、30000/1001 fps、带静音 AAC；动图 320×569、图标 56×96），写进 ~/Library/Application Support/DouyinAR/Shared/Resources/PreviewResource/PreviewResources.json（改之前的版本备份到 ~/.xiangsu-mcp-ext/preview-resources-backup/，留最近 10 份）。之后新打开的工程窗口就有这个视频（set_preview_video 的 video_name、preview_frames 的 videos 用 name）；已开着的窗口要关掉重开。replace=true 原位换掉同名模特的视频：替换某个窗口播过的视频会让那个窗口的预览卡住，先关掉那些窗口再替换。像塑更新可能覆盖清单，覆盖后重新加。`,
      shape: {
        name: z.string().min(1).max(40).describe('清单里的名字，照现有的写法「模特W短发||女」（|| 后面是性别）。'),
        file_name: z.string().regex(/^[a-z0-9_]+$/).describe('文件名（小写字母、数字、下划线），如 model_w、model_s_kiss。'),
        type: z.enum(PREVIEW_TYPES).optional().describe('预览类型，默认 preview_face。'),
        image: absPath('照片').optional().describe('照片（PNG / JPG / WEBP），铺满 720×1280 后居中裁切。'),
        seconds: z.number().min(1).max(30).optional().describe(`照片做成的视频时长，默认 ${PHOTO_SECONDS} 秒。`),
        video: absPath('视频').optional().describe('视频（MP4 / MOV），铺满 720×1280 后居中裁切，保留原声（没有就配静音）。'),
        alternate: z
          .strictObject({
            first: absPath('照片'),
            second: absPath('照片'),
            first_s: z.number().min(0.2).max(10).describe('第一张停留秒数（如平静 1.4）。'),
            second_s: z.number().min(0.2).max(10).describe('第二张停留秒数（如嘟嘴 1）。'),
            cycles: z.number().int().min(1).max(20).describe('循环几次（如 4，共 9.6 秒）。'),
          })
          .optional()
          .describe('两张照片交替循环；preview_frames 的间隔别取一个循环的整数倍，否则每帧落在同一相位。'),
        replace: z.boolean().optional().describe('替换同名模特，默认 false（同名时报 PREVIEW_MODEL_EXISTS）。'),
      },
      run: async (a) => text(await d.addPreviewModel(a)),
    },
    {
      name: 'scene_set_layer',
      description:
        '改已保存工程的 Assets/main.scene 里对象的渲染图层（layer）和摄像机能看见哪些图层（layerVisibleMask），官方 DSL 改不了这两项（报 Invalid property name layer）。用于把一些对象只给某个摄像机画（如擦痕遮罩只画进渲染纹理）。只改对象各自那一行，其余内容原样；改完重新解析核对，对不上就不写（报 SCENE_EDIT_NOT_APPLIED）。改之前的文件备份到 ~/.xiangsu-mcp-ext/scene-backups/（每个工程留最近 10 份）。工程窗口开着时拒绝（报 PROJECT_OPEN：编辑器保存时会覆盖文件）：先 save_project、project_close，改完再 project_open。对象写法同 scene_tree 的 project_dir 模式（#序号、名称或层级路径）。',
      shape: {
        project_dir: absPath('工程目录').describe('工程目录的绝对路径（含 Assets/main.scene）。'),
        objects: z
          .array(z.strictObject({ object: z.string().min(1), layer: z.number().int().min(0).max(63).describe('图层 0–63，默认的对象都在 0。') }))
          .max(200)
          .optional(),
        cameras: z
          .array(z.strictObject({ object: z.string().min(1).describe('带 Camera 组件的对象。'), visible_layers: z.array(z.number().int().min(0).max(63)).min(1).describe('这个摄像机画哪些图层。') }))
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
      description:
        '给预览喂模拟声音，验声音玩法（编辑器里没有真人声音，音量读数一直是 0、关键词不会命中）：先开启编辑器内置 Agent 的「试玩」会话（预览会重载一次，重载时注入把模拟输入转成 AudioDetection 结果的运行时），按 steps 依次喂音量 volume（检测器原始值 0–1，人声参考：轻 0.05、中 0.10、响 0.15）、音高 pitch_hz（45–650）、关键词命中 keywords 或未命中 keyword_miss，每步持续 duration_ms，期间按 frames 均匀截预览图；结束后清掉输入、关闭会话（预览再重载一次，回到没有注入的状态）。2026-11-14 实测：脚本里 VolumeDetector.getResult() 在喂 0.12 的 2.5 秒里读到 0.12，前后都是 0。脚本收到的值用官方 get_script_logs 看。会话期间预览从头重载，特效状态会重置；lead_ms 是重载后先等多久再喂第一步（默认 1000）。',
      shape: {
        ...target,
        steps: z
          .array(
            z.strictObject({
              volume: z.number().min(0).max(1).optional(),
              pitch_hz: z.number().min(45).max(650).optional(),
              keywords: z.array(z.string().min(1)).min(1).optional().describe('模拟检测器命中这些关键词（和脚本注册的关键词一致）。'),
              keyword_miss: z.literal(true).optional().describe('模拟一次关键词未命中。'),
              duration_ms: z.number().int().min(100).max(30000).describe('这一步持续多久。'),
              frames: z.number().int().min(0).max(6).optional().describe('这一步里均匀截几张预览图，默认 2。'),
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
      description:
        '官方 interact_by_dsl 不收的几条预览命令（它报 unsupported command，2026-11-14 实测），走编辑器内置 Agent 自己的预览命令：touch_move（按住时移动到 x, y，0–1，配合官方 touch_down / touch_up 做拖动轨迹）、seek_to_time（把预览视频跳到 time_ms 并继续播放，用来在固定时刻截图）、switch_gesture_video（换成编辑器给某个手势配好的预览视频并暂停，hand_action 取 Victory、OK、ThumbUp、HeartA、Fist、HandOpen、Namaste、Pistol、DoubleHand 等，以 PreviewResources.json 里配了 handAction 的条目为准，返回 captureTimesMs 是这个手势最清楚的时刻）。按顺序执行，遇到失败停下，每条返回 status。',
      shape: {
        ...target,
        commands: z
          .array(
            z.discriminatedUnion('command_type', [
              z.strictObject({ command_type: z.literal('touch_move'), params: z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }) }),
              z.strictObject({ command_type: z.literal('seek_to_time'), params: z.strictObject({ time_ms: z.number().min(0) }) }),
              z.strictObject({ command_type: z.literal('switch_gesture_video'), params: z.strictObject({ hand_action: z.string().min(1) }) }),
            ]),
          )
          .min(1)
          .max(20),
      },
      run: plugin('preview_actions', 30000),
    },
    {
      name: 'ai_vfx_submit',
      description:
        '素材库「AI 生成 › 画面特效」（9.8.3 新增）：按描述 prompt 和参考素材（最多 10 张图片、1 段视频，视频最长 60 秒，超过编辑器会截取）在云端生成 1–10 秒的全屏画面特效，返回 task_id；任务走面板自己的 AIVisualEffectManager，面板里同样能看到。prompt 和参考素材至少给一样。参考视频要先过编辑器的上传审核（最长约 15 分钟），审核不过报 AI_VFX_REFERENCE_REJECTED。同时最多 10 个任务在跑。之后用 ai_vfx_tasks（task_id + wait_s）等它完成，看预览视频和 6 帧预览图，满意再 ai_vfx_import。会占用账号的 AI 模型使用次数，编辑器里查不到剩余次数。',
      shape: {
        ...target,
        prompt: z.string().optional().describe('特效描述，如「从画面中心扩散出金色粒子光环，带一点胶片颗粒」。'),
        reference_images: z.array(absPath('参考图')).max(10).optional().describe('参考图（PNG / JPG / JPEG）。'),
        reference_video: absPath('参考视频').optional().describe('参考视频（MP4 / MOV）。'),
        duration_s: z.number().int().min(1).max(10).optional().describe('时长（秒），默认 5。'),
      },
      run: async (a) => {
        const { project_path, instance_id, ...params } = a;
        return text(await d.callPlugin('ai_vfx_submit', params, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: AI_VFX_SUBMIT_TIMEOUT_MS }));
      },
    },
    {
      name: 'ai_vfx_tasks',
      description: `素材库「画面特效」的生成任务（当前账号，与面板的生成记录同一份），最新的在前。不传 task_id 时按 offset / count 分页列出，带当前限制 limits；传 task_id 时只查这一个，再给 wait_s 就等到它不再生成中（最多 ${AI_VFX_MAX_WAIT_S} 秒）。status：running、succeeded（可导入）、imported、failed / audit_failed（failure 是编辑器给的原因）、canceled。完成的带本机的预览视频 preview_video_file（特效叠在编辑器的样例模特上）和一张横排 6 帧的预览图 preview_image_file（交给 image_view 看）。`,
      shape: {
        ...target,
        task_id: z.string().min(1).optional(),
        wait_s: z.number().int().min(0).max(AI_VFX_MAX_WAIT_S).optional(),
        offset: z.number().int().min(0).optional(),
        count: z.number().int().min(1).max(20).optional(),
      },
      run: async (a) => {
        const { project_path, instance_id, task_id, wait_s = 0, offset, count } = a;
        const win = await homeWindow({ project_path, instance_id });
        if (task_id !== undefined) return text(await d.callPlugin('ai_vfx_task', { task_id, wait_s }, { ...win, timeoutMs: wait_s * 1000 + 120000 }));
        if (a.wait_s !== undefined) throw Error('INVALID_ARGUMENTS: wait_s only applies together with task_id');
        return text(await d.callPlugin('ai_vfx_tasks', { offset, count }, { ...win, timeoutMs: 120000 }));
      },
    },
    {
      name: 'ai_vfx_import',
      description: '把一个 succeeded 的画面特效任务导入目标工程，等同面板里选中它后点「导入」：下载生成的特效包（ae2sg_export），按编辑器的方式转成表面图（Surface Graph）和材质导入工程，预览随即重载。返回 added_objects、package_folders。之后用 preview_frames 验收，save_project。',
      shape: { ...target, task_id: z.string().min(1).describe('ai_vfx_submit / ai_vfx_tasks 返回的 task_id（须 succeeded 或 imported）。') },
      run: plugin('ai_vfx_import', 300000),
    },
    {
      name: 'ai_vfx_cancel',
      description: '取消一个还在生成的画面特效任务，等同面板里的「取消」。取消没得到确认时编辑器会继续查询它的状态，返回 cancelled=false 和当前状态。',
      shape: { ...target, task_id: z.string().min(1) },
      run: async (a) => {
        const { project_path, instance_id, task_id } = a;
        return text(await d.callPlugin('ai_vfx_cancel', { task_id }, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: 120000 }));
      },
    },
    {
      name: 'custom_gan_styles',
      description:
        '素材库「AI 生成 › 实时变脸」（自己训练 AI 实时变脸）的风格和今天剩余的训练次数 quota：全身换装（一张全身服装参考图）、真人搞怪（脸部参考图，要从候选效果图里挑满 30 张再训练，flow=select_30）、表情迁移、真人美化（脸部参考图，预览满意直接训练，flow=direct），每种带参考图建议和预计训练时长（3–12 小时）。流程：custom_gan_submit 生成预览（不消耗训练次数）→ custom_gan_tasks 看男女两张预览图 → custom_gan_train 训练（消耗 1 次）→ 训练完 custom_gan_import 导入工程。',
      shape: { ...target },
      run: async ({ project_path, instance_id }) => text(await d.callPlugin('custom_gan_styles', {}, await homeWindow({ project_path, instance_id }))),
    },
    {
      name: 'custom_gan_submit',
      description: '「实时变脸」第一步「生成」：上传一张参考图（PNG / JPG / JPEG，不超过 10 MB，主体清晰无遮挡），按风格在云端生成编辑器样例男女脸上的预览，返回 task_id；不消耗训练次数。面板同时只允许一个预览在生成，有在跑的报 CUSTOM_GAN_RUNNING。之后 custom_gan_tasks（task_id + wait_s）等预览完成。',
      shape: {
        ...target,
        style: z.string().min(1).describe('风格名或 preset，取 custom_gan_styles 的 style / preset（如「表情迁移」或 emotions）。'),
        image_path: absPath('参考图'),
      },
      run: async (a) => {
        const { project_path, instance_id, ...params } = a;
        return text(await d.callPlugin('custom_gan_submit', params, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: 120000 }));
      },
    },
    {
      name: 'custom_gan_tasks',
      refs: true,
      description: `「实时变脸」的任务（当前账号，与面板的记录同一份），最新的在前。每条有 stage：preview（预览，完成后带男女预览图 female_image_ref / male_image_ref）、select（真人搞怪的候选效果图：candidates 每张的 index、image_ref、是否已选）、train（训练中或训练完，完成的带男女预览视频 video_female_ref / video_male_ref、模型是否已下载到本机）；status 是 running / finished / failed / discarded。传 task_id 时只查这一个，再给 wait_s 就等到它不再 running（最多 ${CUSTOM_GAN_MAX_WAIT_S} 秒；训练要几个小时，隔一段时间再查）。`,
      shape: {
        ...target,
        task_id: z.string().min(1).optional(),
        wait_s: z.number().int().min(0).max(CUSTOM_GAN_MAX_WAIT_S).optional(),
        offset: z.number().int().min(0).optional(),
        count: z.number().int().min(1).max(20).optional(),
      },
      run: async (a) => {
        const { project_path, instance_id, task_id, wait_s = 0, offset, count } = a;
        const win = await homeWindow({ project_path, instance_id });
        if (task_id !== undefined) return text(await d.callPlugin('custom_gan_task', { task_id, wait_s }, { ...win, timeoutMs: wait_s * 1000 + 120000 }));
        if (a.wait_s !== undefined) throw Error('INVALID_ARGUMENTS: wait_s only applies together with task_id');
        return text(await d.callPlugin('custom_gan_tasks', { offset, count }, { ...win, timeoutMs: 120000 }));
      },
    },
    {
      name: 'custom_gan_train',
      description: `「实时变脸」训练，等同面板的「去训练」（会消耗 1 次当天的训练次数，次数用完报 CUSTOM_GAN_NO_QUOTA；调用前先和用户确认预览图满意）。表情迁移、真人美化、全身换装：预览完成后直接训练。真人搞怪（preset fun）分两步，和面板一样：先不带 selected 调用，生成候选效果图（不消耗次数）；等 custom_gan_tasks 里 stage=select 完成后，挑满 ${CUSTOM_GAN_SELECT_COUNT} 张，把 index 传给 selected 再调用一次，正式训练。训练要 3–12 小时，用 custom_gan_tasks 隔段时间看。`,
      shape: {
        ...target,
        task_id: z.string().min(1),
        selected: z.array(z.number().int().min(0)).length(CUSTOM_GAN_SELECT_COUNT).optional().describe(`真人搞怪：挑中的 ${CUSTOM_GAN_SELECT_COUNT} 张候选图的 index。`),
      },
      run: async (a) => {
        const { project_path, instance_id, ...params } = a;
        return text(await d.callPlugin('custom_gan_train', params, { ...(await homeWindow({ project_path, instance_id })), timeoutMs: 120000 }));
      },
    },
    {
      name: 'custom_gan_import',
      description: '把训练完成的「实时变脸」模型导入目标工程，等同面板勾选它后点「导入」：先下载模型文件和男女预览视频（与面板训练完成卡片一样），再按 AI 实时变脸素材导入并放进场景（可撤销）。返回 added_objects、package_folders 和预览视频路径。帧率提醒：AI 实时变脸是特效检测里固定的大头开销。',
      shape: { ...target, task_id: z.string().min(1) },
      run: plugin('custom_gan_import', CUSTOM_GAN_IMPORT_TIMEOUT_MS),
    },
    {
      name: 'image_upscale',
      description: '图片超清，和编辑器图片编辑器的「超清」按钮同一个云端请求（不打开窗口）：返回放大后的 PNG（存到 out_dir 或临时目录）和一张缩小的预览。用来把小图、截帧放大做图标或贴图。是否扣额度以编辑器为准，编辑器里没有相关提示。',
      shape: { ...target, image_path: absPath('图片').describe('PNG / JPG / JPEG。'), out_dir: outDir.optional().describe('输出目录；省略时放临时目录（24 小时后删除）。') },
      run: async (a) => imageAi(a, 'image_upscale', {}, 'upscaled'),
    },
    {
      name: 'image_repaint',
      description:
        '图片局部消除 / 重绘，和编辑器图片编辑器的「消除笔」「局部重绘」同一个云端请求（不打开窗口）：用 mask（一张图，亮且不透明的地方是要改的区域，自动拉伸到原图大小）或 boxes（按原图比例的矩形）标出区域，本工具按编辑器的方式把区域涂成绿色棋盘格再提交。不给 prompt 是「消除」（把区域里的东西去掉、补背景），给 prompt 是「重绘」（按描述画区域里的内容）。返回结果 PNG、标记后的提交图 marked_file 和预览。',
      shape: {
        ...target,
        image_path: absPath('图片'),
        mask: absPath('遮罩').optional(),
        boxes: z
          .array(z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().gt(0).max(1), height: z.number().gt(0).max(1) }))
          .max(20)
          .optional(),
        prompt: z.string().optional().describe('重绘的描述；省略时为消除。'),
        out_dir: outDir.optional().describe('输出目录；省略时放临时目录（24 小时后删除）。'),
      },
      run: async (a) => {
        if (!a.mask && !a.boxes?.length) throw Error('INVALID_ARGUMENTS: mark the area with mask or boxes');
        const { markedCanvas, png } = await graphics();
        const dir = a.out_dir ? saveDir(a.out_dir) : d.framesDir();
        const stem = path.basename(a.image_path, path.extname(a.image_path));
        const { canvas, marked_ratio } = await markedCanvas(a.image_path, { mask: a.mask, boxes: a.boxes });
        const marked = path.join(dir, `${stem}_marked.png`);
        fs.writeFileSync(marked, await png(canvas));
        return imageAi({ ...a, image_path: marked }, 'image_repaint', { prompt: a.prompt }, a.prompt?.trim() ? 'repainted' : 'removed', { dir, stem, marked_file: marked, marked_ratio });
      },
    },
    {
      name: 'image_matting',
      description: `AI 抠图，和编辑器图片编辑器的「抠图」同一个云端请求（不打开窗口）：返回透明底的主体 subject，以及按部位分开的 ${IMAGE_MATTING_PARTS.filter((p) => p !== 'subject').join('、')}（照片里有才返回），PNG 存到 out_dir 或临时目录，附主体的预览。用来做贴纸、图标素材。`,
      shape: { ...target, image_path: absPath('图片').describe('PNG / JPG / JPEG。'), out_dir: outDir.optional().describe('输出目录；省略时放临时目录（24 小时后删除）。') },
      run: async (a) => {
        const { previewJpeg } = await graphics();
        const { project_path, instance_id, image_path, out_dir } = a;
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
      name: 'face_warp_list',
      description: '列出场景里所有「塑型画笔」组件（FaceWarpX，含猫脸/狗脸），返回 object_path、是否启用、每项画笔的序号与强度。官方 edit_by_dsl 的 set_component 命令改不了画笔强度，用 face_warp_set_intensity。',
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
        '删除一个场景对象（含子对象，可撤销），并找出只被它使用的工程资源：删除前后对比场景引用，删除前被引用、删除后不再被引用的即为孤儿（unused_paths 已合并到素材包文件夹，只含磁盘上存在的路径）。editor_only_paths 是素材放进场景时编辑器按对象名建的文件夹（如「复古清冷_滤镜」），只在编辑器里、尚未写到磁盘，对象删除后下次保存就会消失，不用删。delete_unused_resources=true 时一并删除 unused_paths（资源删除不可撤销）；默认只报告，可之后用 resource_delete_unused 删除。object_path 用完整层级路径或能唯一定位的末尾几段（渲染组本身请用官方 edit_by_dsl 的 delete_render_group 命令）。只删对象、不关心资源时官方 edit_by_dsl 也能删；要知道删完哪些资源没人用了，用本工具。',
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

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const mine = [...own.values()].map((t) => ({ name: t.name, description: t.refs ? `${t.description}${REF_NOTE}` : t.description, inputSchema: z.toJSONSchema(t.schema) }));
    const official = (await d.official.listTools())
      .filter((t) => !own.has(t.name))
      .map((t) => (Object.prototype.hasOwnProperty.call(OFFICIAL_NOTES, t.name) ? { ...t, description: `${t.description || ''}\n\n（xiangsu-mcp-plus）${OFFICIAL_NOTES[t.name]}` } : t));
    return { tools: [...mine, ...official] };
  });

  // Official tools whose arguments are rewritten here before they are forwarded.
  const rewritten = {
    edit_by_dsl: async (args) => {
      if (!Array.isArray(args.commands)) return args;
      for (const [i, c] of args.commands.entries()) {
        if (c && c.command_type === 'set_component' && Array.isArray(c.params?.properties)) throw Error(`INVALID_ARGUMENTS(edit_by_dsl): commands[${i}] set_component properties must be an object such as {"intensity": 0.5}, not an array`);
      }
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
    let forward = args;
    if (Object.prototype.hasOwnProperty.call(rewritten, name)) {
      try {
        forward = await rewritten[name](args);
      } catch (e) {
        return failure(e);
      }
    }
    try {
      return clipError(name, await d.official.callTool(name, forward));
    } catch (e) {
      if (e instanceof McpError) return clipError(name, failure(`OFFICIAL_TOOL_ERROR(${name}): ${e.message}`));
      if (e instanceof OfficialUnreachable) return failure(`OFFICIAL_MCP_UNAVAILABLE(${name}): ${e.message}；确认像塑已启动（${d.official.url}）`);
      return failure(`OFFICIAL_MCP_DISCONNECTED(${name}): ${e.message}；调用发出后连接断了，编辑器里可能已经执行（生成类调用可能已扣额度），没有自动重发：先确认结果（如 get_scene、生成任务的状态）再决定要不要重新调用`);
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
