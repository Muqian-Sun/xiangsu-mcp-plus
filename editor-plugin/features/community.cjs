'use strict';
// Creator feeds of the user's account: inspirations and tasks from the editor's home window, and the
// rank boards of the 像塑 mobile app, which share the editor's backend; plus binding tasks and
// inspirations to a project the way the editor does. Requests go out like the home window's activity
// center sends them: the editor's login cookie plus its signing headers.
const { M } = require('./common.cjs');

// The activity center marks every task as an effect activity and rewrites task_type; the task detail
// window then launches projects with these fields (ActivityCenter/TaskDetailsWindow).
const EFFECT_ACTIVITY = 0;

// Rank boards of the mobile app's rank page (rank_type -> board name). 8 (特效优秀视频榜) is served by
// excellent_video_rank, which returns nothing for every rank type, so it is left out.
const RANK_TYPES = { 1: '年轻喜爱榜', 2: '特效每日投稿榜', 3: '男生喜爱榜', 4: '女生喜爱榜', 7: '热玩互动榜', 9: '模板每日投稿榜', 10: '特效跟拍榜' };
// The template board lists its entries under `templates` instead of `effects`.
const TEMPLATE_BOARD = 9;
// Options of the rank page's filter panel: label -> code, sent comma-joined under `param`.
const RANK_FILTERS = {
  levels: {
    param: 'effect_lv',
    options: { SSS: 1, SS: 2, S: 3, 'S-': 4, 'A+': 5, A: 6, 'B+': 7, B: 8, C: 9, D: 10, E: 11, F: 13, 'F+': 15, G: 14, 'G+': 16, H: 17, I: 18 },
  },
  panels: { param: 'panel_type', options: { 头饰: 1, 氛围: 2, 扮演: 3, 变形: 4, 游戏: 5, 测一测: 6, 新奇: 7, 美妆: 8, 场景: 9 } },
  preferences: { param: 'perf_type', options: { 友友: 5, 潮酷: 6 } },
  tools: { param: 'tool_type', options: { 像塑桌面端: 1, '轻颜 App': 3, 像塑移动版: 6 } },
};
const YOUNG_LIKE_SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const LEVEL_LABELS = Object.fromEntries(Object.entries(RANK_FILTERS.levels.options).map(([label, code]) => [code, label]));
// A board category goes under the field of its level; the server takes one category per level.
const CATEGORY_PARAMS = { 1: 'material_labels3_first', 2: 'material_labels3_second', 3: 'material_labels3_third' };
// Innovation plan picks by artwork type (the app's ArtworkType index); the app itself shows templates.
const PICK_KINDS = { template: 2, effect: 0 };
// rank_innovation kinds: the picks of one artwork type.
const INNOVATION_KINDS = Object.keys(PICK_KINDS);
// Topic collection tabs of the app's 专题合集 page (topic_type).
const SUBJECT_KINDS = { effect: 1, template: 2 };
// subjects and subject_detail answer code 1 for larger counts.
const SUBJECT_MAX = 20;
// The editor's task window page reads task details with this mobile app version.
const TASK_PAGE_APP_VERSION = '11.3.0';
// The 像塑 mobile app version whose endpoints growth_route reads (v17.7.0 Android package, 2026-11-08).
const MOBILE_APP_VERSION = '17.7.0';
// 成长之路 states, read off a live answer: the finished goal (1/1) was 1, the current level and its open goals
// 2, every later level 3.
const GROWTH_STATES = { 1: 'done', 2: 'in_progress', 3: 'locked' };
// 我的作品 rows of a task page, read off live answers against the mobile app's tags (2026-11-09): task_status
// and is_fit_theme came back equal on every effect; 1 shows no tag (effects still in review are 1 too), 2
// shows 主题不符合 and 任务未完成, 3 shows 任务已完成.
const TASK_EFFECT_STATES = { 1: 'pending', 2: 'unfinished', 3: 'done' };
const OFF_THEME = 2;
// The mobile app's 作品详情 page sends 抖音's app id with every per-effect request; its base answer lists
// 抖音极速版 (1164) among other_app_effects.
const DOUYIN_APP_ID = 184;
// 作品详情 数据趋势 tabs, the app's TrendDayType Recent / Online; the server takes cycle = index + 1 and
// refuses 0 and 3–30 (2026-11-09).
const TREND_CYCLES = { recent: 1, since_online: 2 };
// 消息 page groups as /cam_api/message/v1/group answered them (2026-11-09).
const MESSAGE_GROUPS = { all: '0', service: '1', official: '2' };
const MESSAGE_GROUP_NAMES = { 1: '服务', 2: '官方' };
// Picked: 50 came back whole (2026-11-09); more was not tried.
const MESSAGE_MAX = 50;
// Times written out without a zone are Beijing time: the 16:25 实时热点 version came back at 16:40 local
// (2026-11-09), and an inspiration collected at 11:53 local listed 11:53:25 (2026-11-10).
const BEIJING_TZ = '+08:00';
// The collection lists no inspirations unless asked for their artwork types. The editor's pages ask for
// 0 and 5 (the inspiration page's 收藏 tab) or 0, 5 and 14 (the submit window); 2 is in neither but held
// a collected template inspiration (2026-11-10: 0 held 55, 2 held 1, 1 and 3–20 none).
const COLLECTED_ARTWORK_TYPES = [0, 2, 5, 14];
// Collection item types as the submit window labels them: 1 and 4 hotspots, 2 inspirations, 3 effects.
const COLLECTED_INSPIRATION = 2;
// Statuses the effect list page colours as failures (its 审核未通过, 测试未通过, 申诉审核未通过).
const FAILED_STATUSES = [101, 112, 119];
// The review record page's review types: 上线审核 and 精选审核.
const REVIEW_TYPES = { online: 1, innovation: 2 };
// The server's 「网络开小差了」 code, seen once on a growth task detail that the next three tries
// returned; reads are retried once on it. The wait is picked, not measured (works search uses the same).
const BUSY_CODE = '1';
const BUSY_RETRY_MS = 500;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const first = (list) => (Array.isArray(list) && list.length ? list[0] : null);
// Image structs inside these snake_case responses keep a camelCase urlList ({ uri, urlList, width, height }).
const str = (v) => (v === undefined || v === null || v === '' ? null : String(v));
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
// The inspiration page stores image sizes this way (its convertToDecimal).
const decimal = (n) => (typeof n === 'number' ? n.toFixed(1) : '0');

function requireId(v, what) {
  if ((typeof v !== 'string' && typeof v !== 'number') || !String(v).trim()) throw Error(`${what}: pass a non-empty id`);
  return String(v).trim();
}

// Inspiration and user ids exceed 2^53; such integers keep their source text.
function keepBigInts(key, value, context) {
  return typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) ? context.source : value;
}

// Picked: the app's pages answer within a few seconds; one that has not in 15 s is stuck.
const REQUEST_TIMEOUT_MS = 15000;

async function request(lib, what, path, opts = {}) {
  let out = await send(lib, what, path, opts);
  if (out.code === BUSY_CODE && !opts.json && !opts.form) {
    await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
    out = await send(lib, what, path, opts);
  }
  if (out.code !== '0') throw Error(`${what}_FAILED: code=${out.code} message=${out.message}`);
  return out.data;
}

async function send(lib, what, path, { query = {}, json, form, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  lib.ensureCompatible('community');
  const base = lib.mod(M.urls).Domain.kBackendApiURL;
  const utils = lib.mod(M.bizUtils);
  const headers = {
    cookie: await new (lib.mod(M.orionui).CookieManager)().getCookie(base),
    'x-api-sign-data': utils.PlatformUtils.genSignData(),
    'user-agent': utils.UserAgentUtils.userAgentGenerator()(),
  };
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  const init = { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) };
  if (json) {
    headers['content-type'] = 'application/json';
    Object.assign(init, { method: 'POST', body: JSON.stringify(json) });
  } else if (form) {
    const body = new FormData();
    for (const [k, v] of Object.entries(form)) body.append(k, String(v));
    Object.assign(init, { method: 'POST', body });
  }
  const res = await lib.fetch(url.href, init);
  const text = await res.text();
  if (!res.ok) throw Error(`${what}_FAILED: HTTP ${res.status}`);
  let out;
  try {
    out = JSON.parse(text, keepBigInts);
  } catch (_) {
    throw Error(`${what}_FAILED: response is not JSON`);
  }
  return { code: String(out.code), message: out.message || '', data: out.data };
}

function slimInspiration(i) {
  return {
    inspiration_id: String(i.id),
    title: i.title,
    tag: i.tag_desc || null,
    author: i.author_name || null,
    author_uid: str(i.author_uid),
    collect_count: i.total_collection ?? null,
    collected: !!i.is_collect,
    ai: !!i.is_ai_ins,
    hotspot: i.hotspot_data && i.hotspot_data.title ? { id: str(i.hotspot_data.id), title: i.hotspot_data.title } : null,
    cover_url: first(i.cover_img && i.cover_img.urlList),
  };
}

// The example videos an inspiration page plays: Douyin videos made from the idea.
function slimVideo(v) {
  return { url: v.video_url || null, cover_url: v.video_img || null, author: v.video_username || null, likes: str(v.video_digg), width: v.width ?? null, height: v.height ?? null };
}

function tagNames(tags) {
  if (typeof tags === 'string') return [...new Set(tags.split(',').filter(Boolean))];
  return [...new Set((tags || []).map((t) => (t && t.name) || t).filter(Boolean))];
}

const days = (ms) => (typeof ms === 'number' && ms >= 0 ? Math.floor(ms / 86400000) : null);

// Activities (kind activity) and effect tasks (kind task) from the activity center's two lists. A task
// is bound through its designer_task_id, which it only gets once received.
function slimTask(lib, t, kind) {
  const bindId = kind === 'task' ? t.designer_task_id : t.id;
  return {
    task_id: String(kind === 'task' ? t.task_id ?? t.item_id : t.id),
    kind,
    title: t.title || t.name || '',
    status: kind === 'task' ? lib.taskStatus(t.process_status) : null,
    status_text: t.process_status_text || null,
    status_desc: t.process_status_desc || null,
    received: kind === 'task' ? !!t.designer_task_id : null,
    bindable: !!bindId,
    tags: tagNames(t.tags),
    days_left: days(t.ttl),
    revenue: t.revenue ?? null,
    can_finish_times: t.can_fin_times ?? null,
    released_at: iso(t.release_at),
    offline_at: iso(t.offline_at),
    icon_url: t.icon_url || null,
  };
}

// An effect submitted to a task, as the task page lists it under 我的作品.
function slimTaskEffect(e) {
  return {
    effect_id: str(e.effect_id),
    name: e.effect_name,
    type: e.type_desc || null,
    status: e.effect_status_desc || null,
    status_code: e.effect_status ?? null,
    task_state: TASK_EFFECT_STATES[e.task_status] ?? e.task_status ?? null,
    off_theme: e.is_fit_theme === OFF_THEME,
    track: e.sub_track_name || null,
    shoots: str(e.shoot_num),
    views: str(e.vv_num),
    publish_peak: str(e.pub_peak_num),
    award_amount: e.award_amount || null,
    icon_url: first(e.icon && e.icon.url_list),
  };
}

// Task page text marks a link as $A$$HREF$url$HREF$$TEXT$label$TEXT$$A$.
const TASK_LINK = /\$A\$\$HREF\$(.*?)\$HREF\$\$TEXT\$(.*?)\$TEXT\$\$A\$/g;
// The lists a task content block holds its entries in (参与要求, 奖项详情, 近期热门, 任务说明 and the like).
const TASK_LISTS = ['demandList', 'awardList', 'inspirationList', 'baseList'];

function readTaskText(src, links) {
  return String(src || '')
    .replace(TASK_LINK, (_, url, label) => (links.push({ text: label, url }), label))
    .trim();
}

// mediaType 1 marks mp4 videos; pictures come with 0 or none. Empty and blob: addresses do not show on
// the task page either, so they are only counted. Award amounts pass as the page sends them: no page
// code was found to tell their unit.
function taskItem(it) {
  const links = [];
  const out = {};
  const title = readTaskText(it.tit, links);
  const text = readTaskText(it.desc, links);
  if (title) out.title = title;
  if (text) out.text = text;
  const urls = (it.source || []).map((s) => (s && typeof s.url === 'string' ? s.url : ''));
  const media = urls.filter((u) => /^https?:\/\//.test(u));
  if (media.length) out[it.mediaType === 1 ? 'videos' : 'images'] = media;
  if (urls.length > media.length) out.unusable_media = urls.length - media.length;
  if (it.money !== undefined) {
    out.money = it.money;
    out.money_mode = it.money_mode ?? null;
    out.people = it.people_mode === 'infinite' ? 'unlimited' : (it.peope ?? null);
  }
  if (links.length) out.links = links;
  return out;
}

// One content block of the task page, read into its entries and links. Fields this reader does not
// know are kept as they came under `unread`, not dropped.
function taskBlock(b) {
  const out = { name: b.contentBlockName || '' };
  const links = [];
  const unread = {};
  for (const [key, v] of Object.entries(b)) {
    if (key === 'type' || key === 'contentBlockName') continue;
    if (TASK_LISTS.includes(key)) out.items = (v || []).map(taskItem).filter((x) => Object.keys(x).length);
    else if (key === 'link' && v && v.url) links.push({ text: v.desc || '', url: v.url });
    else if (key === 'statement' && v && v.link && v.link.url) links.push({ text: b.contentBlockName || '', url: v.link.url });
    else if (key === 'recommendProject') {
      const { ids, ...rest } = v || {};
      out.project_ids = (ids || []).map(String);
      if (Object.keys(rest).length) unread[key] = rest;
    }
    else unread[key] = v;
  }
  if (links.length) out.links = links;
  if (Object.keys(unread).length) out.unread = unread;
  return out;
}

// The task page's 推荐工程 arrive as a JSON string of template ids; anything else is handed on as it
// came rather than failing the whole detail.
function templateIds(list) {
  if (list === undefined || list === null || list === '') return [];
  let ids = list;
  if (typeof list === 'string') {
    try {
      ids = JSON.parse(list);
    } catch (_) {
      return { unparsed: list };
    }
  }
  return Array.isArray(ids) ? [...new Set(ids.map(String))] : { unparsed: list };
}
// Picked: a task page can recommend over a hundred templates (108117: 120, 2026-11-09) that no tool
// downloads by id, so the first few stand for them; save_to keeps the whole list.
const MAX_TEMPLATE_IDS = 20;

function recommendedTemplates(ids) {
  if (!Array.isArray(ids)) return { recommended_template_ids: ids };
  return { recommended_template_ids: ids.slice(0, MAX_TEMPLATE_IDS), recommended_template_total: ids.length };
}

function slimGrowthLevel(l) {
  const level = { level: l.layer, name: l.layer_name, award_text: l.award || null, status: GROWTH_STATES[l.status] ?? l.status };
  if (l.sub_tasks) {
    level.goals = l.sub_tasks.flatMap((t) =>
      (t.progresses || []).map((p) => ({ text: p.goal_text, current: p.curr_num, target: p.goal_num, reward_text: p.desc_text || null, status: GROWTH_STATES[t.status] ?? t.status })),
    );
  }
  if (l.rights) level.rights = l.rights.flatMap((r) => (r.right_cards || []).map((c) => c.title));
  return level;
}

// What the task detail window passes as launch extras when it opens a project for a task.
function activityExtra(lib, t, kind) {
  const model = { ...t, display_type: EFFECT_ACTIVITY, task_type: kind === 'task' ? 'Normal' : 'Growup', id: kind === 'task' ? t.designer_task_id : t.id };
  return {
    activity_id: model.id,
    activity_name: model.title,
    activity_enter_from: 'homepage',
    activity_type: lib.mod(M.activityTypes).getTypeName(model),
    task_type: model.task_type,
  };
}

function growthProjects(t) {
  return (t.project_data || []).map((p) => ({ project_id: String(p.project_id), desc: p.project_desc || '' }));
}

function slimRankItem(e, rank) {
  return {
    rank,
    effect_id: str(e.effect_id),
    app_effect_id: appEffectId(e),
    name: e.effect_name,
    icon_url: e.effect_icon || null,
    level: LEVEL_LABELS[e.effect_lv] ?? null,
    is_new: e.is_new_inc ?? null,
    publish_peak: e.peak_pub_val ?? null,
    publish_total: e.all_pub_val ?? null,
    follow_shoot: e.follow_shoot_pub_val ?? null,
    follow_shoot_30d: e.follow_shoot_pub_val_30d ?? null,
    follow_shoot_60d: e.follow_shoot_pub_val60d ?? null,
    male_rate: e.male_pub_rate ?? null,
    female_rate: e.female_pub_rate ?? null,
    young_like_score: e.young_like_score ?? null,
    male_like_score: e.male_like_score ?? null,
    hot_play_score: e.hot_play_score ?? null,
    revenue_total: e.effect_total_rev ?? e.total_rev ?? null,
  };
}

// Template ids overflow app_effect_id into a negative 32-bit number; app_effect_id_str carries the real
// one where the server sends it.
function appEffectId(e) {
  return str(e.app_effect_id_str ?? e.app_effect_id);
}

function slimSubject(s) {
  return {
    subject_id: String(s.subject_id),
    name: String(s.subject_name || '').trim(),
    subtitle: s.sub_title || null,
    online_at: iso(s.online_time),
    views: s.page_view_cnt ?? null,
    cover_url: s.subject_cover_pic || null,
    effects: (s.effects || []).map((e) => ({
      effect_id: str(e.effect_id),
      app_effect_id: appEffectId(e),
      name: e.effect_name,
      icon_url: e.effect_icon || null,
      description: e.effect_desc || '',
    })),
  };
}

// Review texts mark up segments between `|`: <b>bold<b>, <mark>…<mark>, <br>… and
// <a><href>url<href>label<a>, read the way the review record page reads them.
function readMarkup(src) {
  const links = [];
  const parts = String(src || '')
    .split('|')
    .map((seg) => {
      if (seg.startsWith('<a>')) {
        const body = seg.replace(/<a>/g, '');
        const m = /<href>(.*)<href>(.*)/.exec(body);
        if (!m) return body;
        links.push({ text: m[2], url: m[1] });
        return m[2];
      }
      if (seg.startsWith('<b>')) return seg.replace(/<b>/g, '');
      if (seg.startsWith('<mark>')) return seg.replace(/<mark>/g, '');
      if (seg.startsWith('<br>')) return `\n${seg.replace(/<br>/g, '')}`;
      return seg;
    });
  return { text: parts.join('').trim(), links };
}

function slimReview(r) {
  const desc = readMarkup(r.detail_desc);
  const links = [...desc.links];
  const reasons = (r.refuse_reason || []).map((x) => {
    const detail = readMarkup(x.detail);
    links.push(...detail.links);
    return { title: x.title || '', items: x.content || [], detail: detail.text };
  });
  return { title: r.title || '', at: iso(r.created_at), text: desc.text, refuse_reasons: reasons, links };
}

function reviewList(data, what) {
  if (data === undefined || data === null) return [];
  if (!Array.isArray(data)) throw Error(`${what}_FAILED: expected a list of review records`);
  return data.map(slimReview);
}

function slimArtwork(e) {
  return {
    effect_id: String(e.id),
    name: e.name,
    status: e.effect_status,
    status_text: e.effect_status_desc || null,
    created_at: iso(Number(e.created_at)),
    online_at: iso(Number(e.first_online_at)),
    app_effect_id: appEffectId(e),
    task: e.b_task || null,
    inspiration: e.b_ins || null,
    hotspot: e.b_hot || null,
    can_edit: !!e.can_edit,
    can_delete: !!e.can_delete,
    can_appeal: !!e.can_appeal,
    appeal_types: (e.appeal_types || []).map((t) => t.appeal_type_text),
    publish_count: e.pub_num ?? null,
    icon_url: e.icon || null,
  };
}

// The 作品详情 / 我的 pages' figure cards: a label, its value and the text shown for it.
// Money cards carry fen in val next to yuan in the text (本月收入 5100 / "51.00"); value is in yuan.
function slimFigures(list) {
  return (list || []).map((f) => ({
    name: f.display_type,
    value: typeof f.val === 'number' && /收入|收益/.test(f.display_type || '') ? f.val / 100 : f.val ?? null,
    text: f.display_val ?? null,
  }));
}

const day = (s) => (/^\d{8}$/.test(String(s)) ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6)}` : s ?? null);
const yuan = (s) => (s === undefined || s === null || s === '' ? null : Number(s));

function slimAppEffect(a) {
  return {
    app_id: a.app_id,
    app_effect_id: str(a.app_effect_id),
    status: a.online_status ?? null,
    status_text: a.online_status_desc || null,
    online_at: iso(a.online_at),
    level_code: a.level ?? null,
    publish_peak: a.peak_pub ?? null,
    publish_total: a.total_pub ?? null,
  };
}

// 数据趋势: exposure (show_stat) and submissions (pub_stat) by day; both lists carry their counts as pub_val.
function trendDays(stat) {
  const byDate = new Map();
  const row = (d) => {
    if (!byDate.has(d)) byDate.set(d, { date: day(d), exposure: null, publish: null });
    return byDate.get(d);
  };
  for (const p of stat.show_stat || []) row(p.date).exposure = p.pub_val;
  for (const p of stat.pub_stat || []) row(p.date).publish = p.pub_val;
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// A message's effect: 审核 notices open the review record page of it.
function messageEffectId(page) {
  try {
    const u = new URL(page);
    return u.pathname === '/m/detail' ? u.searchParams.get('id') : null;
  } catch (_) {
    return null;
  }
}

function hotListTime(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(v || ''));
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${BEIJING_TZ}`).toISOString() : null;
}

// 收藏时间 as the collection list writes it ("2026-11-10 11:53:25"); other text passes as it came.
function collectedAt(v) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(String(v || ''));
  return m ? new Date(`${m[1]}T${m[2]}${BEIJING_TZ}`).toISOString() : str(v);
}

// A collection entry; the inspiration page drops entries that come without their card, which are kept
// here under what the entry itself says.
function slimCollected(i) {
  const card = i.ins_detail ? slimInspiration(i.ins_detail) : { inspiration_id: String(i.item_id), title: i.item_name, card_missing: true };
  const t = i.task_info;
  return {
    ...card,
    artwork_type: i.artwork_type ?? null,
    collected_at: collectedAt(i.create_time),
    task: t && t.task_id ? { task_id: String(t.task_id), title: t.task_title || '' } : null,
  };
}

// One heat reading of a hotspot: by day (date) or by hour (date with the hour).
const heatPoint = (p) => ({ at: p.date, heat: p.h_v === undefined || p.h_v === null || p.h_v === '' ? null : Number(p.h_v), heat_text: p.h_v_text ?? null });

function slimMessage(m) {
  return {
    message_id: String(m.id),
    group: MESSAGE_GROUP_NAMES[m.group] ?? m.group,
    title: m.title || '',
    content: m.content || '',
    at: iso(m.time),
    read: !!m.is_ack,
    status: m.status_code || null,
    status_text: m.status_text || null,
    effect_id: messageEffectId(m.page),
    link: m.page || null,
  };
}

function rankType(rank_type) {
  if (!hasOwn(RANK_TYPES, rank_type)) {
    throw Error(`INVALID_RANK_TYPE: ${rank_type}; valid: ${Object.entries(RANK_TYPES).map(([k, n]) => `${k}(${n})`).join(', ')}`);
  }
  return Number(rank_type);
}

function checkDate(date) {
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error(`INVALID_DATE: ${date}; expected YYYY-MM-DD`);
}

function filterCodes(key, labels) {
  const { options } = RANK_FILTERS[key];
  return labels.map((label) => {
    if (!hasOwn(options, label)) throw Error(`INVALID_FILTER(${key}): ${label}; valid: ${Object.keys(options).join(', ')}`);
    return options[label];
  });
}

const methods = {
  taskStatus(code) {
    return this.mod(M.activityTypes).TaskStatus[code] ?? null;
  },

  async inspirationNav() {
    const d = await request(this, 'GET_INSPIRATION_TABS', '/creator_api/inspiration/v1/tabs');
    if (!d.tab_names || !d.tab_names.length) throw Error('NO_INSPIRATION_TABS: the inspiration page returned no tabs');
    return { tabs: d.tab_names };
  },

  async inspirationList({ tab, cursor = 0, count = 20 } = {}) {
    const { tabs } = await this.inspirationNav();
    const name = tab === undefined ? tabs[0] : tab;
    if (!tabs.includes(name)) throw Error(`INVALID_TAB: ${name}; valid: ${tabs.join(', ')}`);
    // The inspiration page asks for its first page with flag 1 and for every later page with flag 2.
    const d = await request(this, 'GET_INSPIRATIONS', '/creator_api/inspiration/v1/list', {
      query: { flag: cursor === 0 ? 1 : 2, cursor, count, tab_name: name },
    });
    return { tab: name, tabs, items: (d.list || []).map(slimInspiration), next_cursor: d.cursor ?? null, has_more: !!d.has_more };
  },

  async inspirationCollected(id) {
    const item_type = this.mod(M.inspirationConst).IS_COLLECT_PARAMS_TYPE.Default;
    const d = await request(this, 'GET_COLLECT_STATE', '/creator_api/inspiration/v1/is_collected', { query: { item_id: id, item_type } });
    return !!d.is_collected;
  },

  // Detail plus collection state and count, the three requests the editor's inspiration panel makes.
  async inspirationRecord(id) {
    const [detail, collected, extra] = await Promise.all([
      request(this, 'GET_INSPIRATION', '/creator/v2/inspiration_detail', { query: { id } }),
      this.inspirationCollected(id),
      request(this, 'GET_INSPIRATION_EXTRA', '/creator_api/inspiration/v1/extra', { query: { id } }),
    ]);
    return { detail, collected, collect_count: extra.total_collection ?? null };
  },

  async inspirationDetail({ inspiration_id } = {}) {
    const id = requireId(inspiration_id, 'INVALID_INSPIRATION_ID');
    const { detail: d, collected, collect_count } = await this.inspirationRecord(id);
    const base = d.base || {};
    if (!base.id) throw Error(`INSPIRATION_NOT_FOUND: ${id}`);
    const hot = d.ai_hotspot_info || {};
    return {
      inspiration_id: id,
      title: base.title,
      description: base.detail_desc || '',
      tag: base.tag_desc || null,
      effect_types: (base.effect_types || []).map((t) => t.name),
      bonus_text: base.bonus_text || null,
      images: (base.imgs || []).map((i) => first(i.urlList)).filter(Boolean),
      author: d.designer ? { uid: str(d.designer.uid), name: d.designer.name } : null,
      // The award times come as numbers whose unit no live answer has shown yet (all were 0), so they pass as they are.
      award:
        d.award && d.award.amount
          ? { amount: d.award.amount, text: d.award.text || '', desc: d.award.desc || '', start_time: d.award.start_time ?? null, end_time: d.award.end_time ?? null, award_time: d.award.award_time ?? null, icon_url: d.award.icon_url || null }
          : null,
      hotspot: hot.title ? { id: str(hot.id), title: hot.title, score: str(hot.score), tags: hot.tags || [] } : null,
      project: d.project_info && d.project_info.title ? { title: d.project_info.title, desc: d.project_info.desc || '', icon_url: d.project_info.icon || null } : null,
      // Effects made from the idea; fields beyond name and total_pub_num pass through, none having been seen live yet.
      effects: (d.effects || []).map(({ name, total_pub_num, ...rest }) => ({ name, published: total_pub_num ?? null, ...rest })),
      videos: (d.videos || []).map(slimVideo),
      stickers: d.stickers || [],
      collected,
      collect_count,
    };
  },

  // The editor's own agent hook: records the inspiration on the open project (saved with it). The submit
  // window lists only collected inspirations, so a bound one that is not collected would not show there;
  // it is collected too.
  async inspirationBind({ inspiration_id } = {}) {
    this.ensureCompatible('community');
    const id = requireId(inspiration_id, 'INVALID_INSPIRATION_ID');
    const EF = this.mod(M.ef);
    if (!EF.ProjectManager.getInstance().hasActiveProject()) throw Error('NO_ACTIVE_PROJECT');
    this.mod(M.inspirationBridge).markAgentInspirationUsed({ inspirationId: id });
    const wasCollected = await this.inspirationCollected(id);
    if (!wasCollected) await this.inspirationCollect({ inspiration_id: id });
    return { bound: id, collected: true, newly_collected: !wasCollected, next: 'save_project to keep it' };
  },

  async inspirationCollect({ inspiration_id, collect = true } = {}) {
    const id = requireId(inspiration_id, 'INVALID_INSPIRATION_ID');
    const { detail: d, collect_count } = await this.inspirationRecord(id);
    const base = d.base || {};
    const img = first(base.imgs) || {};
    const designer = d.designer || {};
    // The card the inspiration page stores with a collection; the collection list renders from it.
    const extra = {
      img_url: first(img.urlList),
      img_width: decimal(img.width),
      img_height: decimal(img.height),
      tag_desc: base.tag_desc || '',
      author: designer.name,
      avatar: designer.avatar,
      collect_num: collect_count,
    };
    const item_type = this.mod(M.inspirationConst).IS_COLLECT_PARAMS_TYPE.Default;
    await request(this, 'COLLECT_INSPIRATION', '/creator_api/inspiration/v1/collect', {
      json: { item_id: id, item_name: base.title, item_type, action: collect ? 1 : 0, extra: JSON.stringify(extra) },
    });
    const now = await this.inspirationCollected(id);
    if (now !== !!collect) throw Error(`COLLECT_NOT_APPLIED: inspiration ${id} is ${now ? 'still' : 'not'} collected`);
    return { inspiration_id: id, title: base.title, collected: now };
  },

  // The inspiration page's 收藏 tab: the account's collected inspirations, latest first, each with its
  // card. `cursor` is an offset.
  async collectedInspirations({ cursor = 0, count = 20 } = {}) {
    const d = await request(this, 'GET_COLLECTED_INSPIRATIONS', '/creator_api/inspiration/v1/collect_list', {
      json: { item_types: [COLLECTED_INSPIRATION], artwork_types: COLLECTED_ARTWORK_TYPES, need_ins_detail: true, need_del: false, cursor, count },
    });
    return { total: d.total ?? null, items: (d.items || []).map(slimCollected), next_cursor: d.cursor ?? null, has_more: !!d.has_more };
  },

  // The activity center's activities and effect tasks. raw goes to the MCP server, which keeps it for
  // task_detail, task_receive and task_bind.
  async tasksList() {
    const { DomainPath } = this.mod(M.urls);
    const [acts, tasks] = await Promise.all([
      request(this, 'GET_ACTIVITIES', DomainPath.kActivityAPI),
      request(this, 'GET_EFFECT_TASKS', DomainPath.kTaskListAPI),
    ]);
    const rows = [...(acts.activities || []).map((t) => ['activity', t]), ...(tasks.effect_tasks || []).map((t) => ['task', t])];
    const items = rows.map(([k, t]) => slimTask(this, t, k));
    const raw = rows.map(([k, t]) => ({
      kind: k,
      item_id: k === 'task' ? String(t.item_id) : null,
      extra: (k === 'task' ? t.designer_task_id : t.id) ? activityExtra(this, t, k) : null,
    }));
    return { items, raw };
  },

  // The activity center's growth tasks.
  async growthTasksList() {
    const { growthTaskType } = this.mod(M.activityTypes);
    const d = await request(this, 'GET_GROWTH_TASKS', this.mod(M.urls).DomainPath.kGrowthTaskList);
    const items = (d.growth_tasks || []).map((t) => ({
      task_id: String(t.task_id),
      title: t.name || '',
      // fen: 1000 comes with the tag 「10元奖励」
      bonus_yuan: t.bonus_amount != null ? t.bonus_amount / 100 : null,
      tags: t.tags || [],
      newbie: t.growth_task_type === growthTaskType.Newbie,
      projects: growthProjects(t),
      icon_url: t.icon || null,
    }));
    return { items };
  },

  // An effect task by its item id, as the task detail window reads it.
  async taskDetail({ id } = {}) {
    const query = { item_id: requireId(id, 'INVALID_TASK_ID'), app_version: TASK_PAGE_APP_VERSION };
    const [d, c] = await Promise.all([
      request(this, 'GET_EFFECT_TASK', '/effectcam/v2/effect_task_detail', { query }),
      request(this, 'GET_EFFECT_TASK_CONTENT', '/effectcam/v2/effect_task_content', { query }),
    ]);
    const modules = (c.modules || []).map((m) => JSON.parse(m.render_content));
    return {
      title: d.title,
      status: this.taskStatus(d.process_status),
      status_text: d.s_desc || null,
      tags: [...new Set((d.tags || []).map((x) => x.name))],
      reward_begin: d.reward_begin || null,
      reward_end: d.reward_end || null,
      offline_at: iso(d.offline_at_unix),
      can_finish_times: d.can_fin_times ?? null,
      finish_status: d.fin_status || null,
      level_task: !!d.is_level_task,
      my_effects: (d.task_effect_list || []).map(slimTaskEffect),
      ...recommendedTemplates(templateIds(d.template_id_list)),
      content: modules.map(taskBlock),
      raw: { detail: d, content: modules },
    };
  },

  // A growth task with its reference projects, inspirations and tutorial.
  async growthTaskDetail({ id } = {}) {
    const d = await request(this, 'GET_GROWTH_TASK', '/cam_api/task/v1/growth_task_detail', { query: { task_id: requireId(id, 'INVALID_TASK_ID') } });
    return {
      title: d.name || '',
      bonus_yuan: d.bonus_amount != null ? d.bonus_amount / 100 : null,
      tags: d.tags || [],
      projects: growthProjects(d),
      inspirations: (d.inspiration_list || []).map(slimInspiration),
      tutorial: d.tutorial_title ? { title: d.tutorial_title, desc: d.tutorial_desc || '', video_url: d.tutorial_video_url || null } : null,
    };
  },

  // The mobile app's 成长之路: designer levels with their cash awards, each goal with its progress.
  async growthRoute() {
    const d = await request(this, 'GET_GROWTH_ROUTE', '/cam_api/designer/v6/growth_route', { query: { app_version: MOBILE_APP_VERSION } });
    const entries = Array.isArray(d) ? d : [];
    if (!entries.length) throw Error('NO_GROWTH_ROUTE: the 成长之路 answer has no levels');
    const levels = entries.flatMap((e) => e.layer_task || []).map(slimGrowthLevel);
    return { current_level: entries[0].cur_layer ?? null, levels };
  },

  // Same request as the activity center's 领取 button, which it only offers while the task waits to be received.
  async taskReceive({ item_id } = {}) {
    const id = requireId(item_id, 'INVALID_ITEM_ID');
    const { TaskStatus } = this.mod(M.activityTypes);
    const d = await request(this, 'GET_EFFECT_TASKS', this.mod(M.urls).DomainPath.kTaskListAPI);
    const t = (d.effect_tasks || []).find((x) => String(x.item_id) === id);
    if (!t) throw Error(`UNKNOWN_TASK: ${id} is not in the effect task list`);
    if (t.process_status !== TaskStatus.WAIT_RECEIVE) throw Error(`TASK_NOT_RECEIVABLE: ${id} status=${this.taskStatus(t.process_status)}`);
    const r = await request(this, 'RECEIVE_TASK', '/creator/v1/receive_task', { form: { id: t.receive_id } });
    if (!r || !r.designer_task_id) throw Error(`RECEIVE_TASK_FAILED: task ${id} returned no designer_task_id`);
    return {
      title: t.title,
      designer_task_id: String(r.designer_task_id),
      status: this.taskStatus(r.process_status ?? TaskStatus.WAIT_SUBMIT),
    };
  },

  async rankCategories(rank_type, date) {
    const d = await request(this, 'GET_RANK_CATEGORIES', '/cam_api/rank/v1/tag', { query: { rank_type, date } });
    return d.map((t) => ({ name: t.tagName, level: t.level, count: t.num }));
  },

  async rankList(params = {}) {
    const { rank_type = 1, date, categories, young_like_scores, cursor = 0, count = 20 } = params;
    const rt = rankType(rank_type);
    checkDate(date);
    const query = { rank_type: rt, date, cursor, count };
    for (const [key, f] of Object.entries(RANK_FILTERS)) {
      if (params[key] && params[key].length) query[f.param] = filterCodes(key, params[key]).join(',');
    }
    if (young_like_scores && young_like_scores.length) {
      for (const s of young_like_scores) if (!YOUNG_LIKE_SCORES.includes(s)) throw Error(`INVALID_FILTER(young_like_scores): ${s}; valid: 1-10`);
      query.young_like_score = young_like_scores.join(',');
    }
    // The board's categories for that day go back with every page, for picking `categories` next time.
    const known = await this.rankCategories(rt, date);
    if (categories && categories.length) {
      for (const name of categories) {
        const hit = known.find((c) => c.name === name);
        if (!hit) throw Error(`INVALID_CATEGORY: ${name}; valid: ${known.map((c) => c.name).join(', ')}`);
        if (!hasOwn(CATEGORY_PARAMS, hit.level)) throw Error(`UNSUPPORTED_CATEGORY_LEVEL: ${name} has level ${hit.level}`);
        const param = CATEGORY_PARAMS[hit.level];
        if (query[param] !== undefined) throw Error(`ONE_CATEGORY_PER_LEVEL: ${query[param]} and ${name} are both level ${hit.level}`);
        query[param] = name;
      }
    }
    const d = await request(this, 'GET_RANK', '/cam_api/rank/v1/detail', { query });
    const list = (rt === TEMPLATE_BOARD ? d.templates : d.effects) || [];
    return {
      rank_type: rt,
      name: RANK_TYPES[rt],
      date: d.date,
      updated_at: d.update_time || null,
      total: d.total,
      items: list.map((e, i) => slimRankItem(e, cursor + i + 1)),
      next_cursor: d.cursor,
      has_more: d.cursor < d.total,
      categories: known,
    };
  },

  // A hotspot's inspirations in the order of the hotspot page's tabs, each naming its tab; the page
  // sends them all at once, so the MCP server pages them.
  async hotspotInspirations({ topic_id } = {}) {
    const id = requireId(topic_id, 'INVALID_TOPIC_ID');
    const d = await request(this, 'GET_HOTSPOT_INSPIRATIONS', '/cam_api/hotspot/v1/insp_tabs', { query: { topic_id: id } });
    const tabs = d.insp_tabs || [];
    const items = tabs.flatMap((t) =>
      (t.insps || []).map((i) => ({
        tab: t.title,
        inspiration_id: String(i.id),
        title: i.title,
        tag: i.tag || null,
        description: i.detail || '',
        cover_url: first(i.cover && i.cover.urlList),
      })),
    );
    return { topic_id: id, tabs: tabs.map((t) => t.title), items };
  },

  // The board is one short list (79 hotspots, measured), read whole and paged here.
  async rankHotspots({ offset = 0, count = 20 } = {}) {
    const d = await request(this, 'GET_HOTSPOTS', '/cam_api/hotspot/v1/rank');
    // Hotspots arrive ordered by heat; rank_num is not their position.
    const all = (d.hotspots || []).map((h, i) => ({
      rank: i + 1,
      topic_id: String(h.topic_id),
      title: h.title,
      description: h.description || '',
      heat: h.hot_core ?? null,
      heat_text: first(h.tags),
      inspirations_text: h.subtitle_text || null,
      cover_url: first(h.cover && h.cover.urlList),
    }));
    const next = offset + count;
    return { rank_time: d.rank_time || null, subtitle: d.subtitle || null, total: all.length, items: all.slice(offset, next), next_offset: next, has_more: next < all.length };
  },

  async subjectPage(kind, cursor, count) {
    const d = await request(this, 'GET_SUBJECTS', '/cam_api/discover/v1/subjects', { query: { cursor, count, type: SUBJECT_KINDS[kind] } });
    // Past the last page the server answers code 0 without data.
    return { total: d ? d.total : null, subjects: (d && d.subjects) || [] };
  },

  subjectKind(kind) {
    if (!hasOwn(SUBJECT_KINDS, kind)) throw Error(`INVALID_KIND: ${kind}; valid: ${Object.keys(SUBJECT_KINDS).join(', ')}`);
    return kind;
  },

  // The 专题合集 page: monthly themed boards, newest first. `cursor` is an offset the server echoes back.
  async rankSubjects({ kind = 'effect', cursor = 0, count = SUBJECT_MAX } = {}) {
    const page = await this.subjectPage(this.subjectKind(kind), cursor, count);
    const next = cursor + page.subjects.length;
    return { kind, total: page.total, subjects: page.subjects.map(slimSubject), next_cursor: next, has_more: page.total !== null && next < page.total };
  },

  // The boards of a kind whose name holds `keyword`; the server has no search, so every page is read.
  async rankSubjectsSearch({ kind = 'effect', keyword } = {}) {
    this.subjectKind(kind);
    const q = String(keyword ?? '').trim();
    if (!q) throw Error('INVALID_KEYWORD: keyword must be a non-empty string');
    const all = [];
    for (let at = 0; ; at += SUBJECT_MAX) {
      const page = await this.subjectPage(kind, at, SUBJECT_MAX);
      all.push(...page.subjects);
      if (page.subjects.length < SUBJECT_MAX) break;
    }
    const subjects = all.filter((x) => String(x.subject_name || '').includes(q)).map(slimSubject);
    return { kind, keyword: q, total: subjects.length, subjects };
  },

  // One board with all its effects.
  async rankSubjectDetail({ subject_id } = {}) {
    const id = requireId(subject_id, 'INVALID_SUBJECT_ID');
    const d = await request(this, 'GET_SUBJECT', '/cam_api/discover/v1/subject_detail', { query: { subject_id: id, cursor: 0, count: SUBJECT_MAX } });
    return slimSubject(d.subject);
  },

  async rankCreatorsMonth() {
    const d = await request(this, 'GET_CREATOR_MONTH_RANK', '/cam_api/innovation_plan/v1/user_month_rank');
    const items = d.map((u) => ({
      rank: u.rank_no,
      uid: String(u.uid),
      name: u.username,
      avatar_url: u.avatar || null,
      material_count: u.material_cnt ?? null,
      follow_shoot: u.follow_pub_val ?? null,
      follow_shoot_text: u.display_follow_pub ?? null,
      award_text: u.display_val || null,
      // fen: 300000 comes with 「预计奖3000元」
      award_yuan: u.award_num != null ? u.award_num / 100 : null,
    }));
    return { items };
  },

  // 创新计划 picks of one artwork type.
  async rankInnovation({ kind = 'template', offset = 0, count = 20 } = {}) {
    if (!hasOwn(PICK_KINDS, kind)) throw Error(`INVALID_KIND: ${kind}; valid: ${Object.keys(PICK_KINDS).join(', ')}`);
    const d = await request(this, 'GET_INNOVATION_PICKS', '/cam_api/innovation_plan/v1/rank_list', {
      query: { page_size: count, offset, tab_id: 'all', artwork_type: PICK_KINDS[kind] },
    });
    // The same effect can come twice in a page under different labels; it is listed once with both.
    const byId = new Map();
    for (const e of d.effect_list || []) {
      const id = str(e.effect_id_str);
      const had = byId.get(id);
      if (had) {
        if (e.label && !had.labels.includes(e.label)) had.labels.push(e.label);
        continue;
      }
      byId.set(id, { e, labels: e.label ? [e.label] : [] });
    }
    const items = [...byId.values()].map(({ e, labels }) => ({
      effect_id: str(e.effect_id_str),
      app_effect_id: str(e.app_effect_id_str),
      name: e.name,
      icon_url: e.icon || null,
      labels,
      publish_count: e.pub_val ?? null,
      revenue_total: e.total_rev ?? null,
      reviewed_on: e.review_date || null,
      cover_url: e.cover_img || null,
      video_item_id: str(e.video_item_id),
    }));
    // offset counts the server's entries before it filters a page, so a page can hold fewer than `count`.
    return { kind, date: d.date || null, total: d.total, items, next_offset: offset + count, has_more: !!d.has_more };
  },

  // The 创新计划 creator month board arrives whole; it is paged here like the picks.
  async rankCreators({ offset = 0, count = 20 } = {}) {
    const { items } = await this.rankCreatorsMonth();
    return { total: items.length, items: items.slice(offset, offset + count), next_offset: offset + count, has_more: offset + count < items.length };
  },

  // The 上线审核 records of the review record page: review_nodes when it has them, otherwise effect_reviews.
  async onlineReviews(id) {
    const nodes = await send(this, 'GET_REVIEW_NODES', '/cam_api/effect/v1/review_nodes', { query: { effect_id: id, review_type: REVIEW_TYPES.online } });
    if (nodes.code === '0' && nodes.data) return reviewList(nodes.data, 'GET_REVIEW_NODES');
    return reviewList(await request(this, 'GET_EFFECT_REVIEWS', '/effectcam/v1/effect_reviews', { query: { effect_id: id } }), 'GET_EFFECT_REVIEWS');
  },

  // The mobile app's 作品 list, newest first. Pages chain through the `sort` key each page returns.
  async myEffects({ cursor, count = 20 } = {}) {
    const d = await request(this, 'GET_MY_EFFECTS', '/effectcam/v1/artworks', { query: { count, sort: cursor } });
    const effects = d.effects || [];
    const items = await Promise.all(
      effects.map(async (e) => {
        const item = slimArtwork(e);
        if (FAILED_STATUSES.includes(e.effect_status)) item.review = (await this.onlineReviews(item.effect_id))[0] ?? null;
        return item;
      }),
    );
    // A short page is the last; a full last page still hands out a key, whose page comes back empty.
    const next = effects.length === count && d.sort ? d.sort : null;
    return { total: d.total, items, next_cursor: next, has_more: next !== null };
  },

  async myEffectReviews({ effect_id } = {}) {
    const id = requireId(effect_id, 'INVALID_EFFECT_ID');
    const [detail, online, innovation] = await Promise.all([
      request(this, 'GET_EFFECT_DETAIL', '/effectcam/v2/effect_detail', { query: { effect_id: id } }),
      this.onlineReviews(id),
      request(this, 'GET_REVIEW_NODES', '/cam_api/effect/v1/review_nodes', { query: { effect_id: id, review_type: REVIEW_TYPES.innovation } }),
    ]);
    // Effects of other accounts and unknown ids are refused with code 1301 before this.
    const { base, extra = {} } = detail;
    return {
      effect_id: id,
      name: base.name,
      status: base.effect_status,
      status_text: base.effect_status_desc || null,
      task: extra.b_task || null,
      reviews: online,
      innovation_reviews: reviewList(innovation, 'GET_REVIEW_NODES'),
    };
  },

  // The 作品详情 page's cards are keyed by the effect, its 抖音 id and 抖音's app id.
  effectQuery({ effect_id, app_effect_id } = {}) {
    return { effect_id: requireId(effect_id, 'INVALID_EFFECT_ID'), app_effect_id: requireId(app_effect_id, 'INVALID_APP_EFFECT_ID'), app_id: DOUYIN_APP_ID };
  },

  // 作品详情 page, data cards: where the effect is online, what it uses, its figures and traffic.
  async myEffectData(params = {}) {
    const query = this.effectQuery(params);
    const cards = await Promise.all([
      request(this, 'GET_EFFECT_BASE', '/cam_api/effect/v1/base', { query }),
      request(this, 'GET_EFFECT_ONLINE_DATA', '/cam_api/effect/v1/online_data', { query }),
      request(this, 'GET_EFFECT_TRAFFIC', '/cam_api/effect/v1/effect_traffic', { query: { effect_id: query.effect_id, app_effect_id: query.app_effect_id } }),
      request(this, 'GET_EFFECT_VV', '/effectcam/v1/effect_vv', { query: { app_effect_id: query.app_effect_id, app_id: DOUYIN_APP_ID } }),
      request(this, 'GET_EFFECT_RELATED', '/cam_api/effect/v1/related_info', { query }),
      request(this, 'GET_EFFECT_TIPS', '/cam_api/effect/v1/tips', { query }),
      request(this, 'GET_SCARCE_CATEGORY', '/cam_api/effect/v1/scarce_category', { query }),
    ]);
    // tips and scarce_category answer code 0 without data; the other cards might too.
    const [base, online, traffic, vv, related] = cards.slice(0, 5).map((c) => c || {});
    const [tips, scarce] = cards.slice(5);
    const e = base.effect || {};
    const out = {
      effect_id: query.effect_id,
      app_effect_id: query.app_effect_id,
      name: e.name ?? null,
      type: e.artwork_type_desc || null,
      submitted_at: iso(e.submit_at),
      icon_url: e.icon || null,
      apps: [base.dy_app_effect, ...(base.other_app_effects || [])].filter(Boolean).map(slimAppEffect),
      functions: ((base.project && base.project.fn_types) || []).map((f) => f.name),
      tags: (base.tags || []).map((t) => t.text),
      figures: slimFigures(online.display_list),
      traffic: { status: traffic.traffic_status ?? null, tags: (traffic.details || []).map((x) => x.tag && x.tag.name).filter(Boolean) },
      views: vv.vv_num ?? null,
      related: (related.details || []).map((r) => ({ type: r.type_desc || null, id: str(r.id), name: r.name || '', status: r.related_status ?? null })),
    };
    // Both cards answered no data for every effect tried (2026-11-09); what they carry is not known yet.
    const unread = {};
    if (tips) unread.tips = tips;
    if (scarce) unread.scarce_category = scarce;
    if (Object.keys(unread).length) out.unread = unread;
    return out;
  },

  // 作品详情 page, 数据趋势 card: exposure and submissions by day, and the submission level.
  async myEffectTrend({ trend = 'recent', ...params } = {}) {
    const query = this.effectQuery(params);
    if (!hasOwn(TREND_CYCLES, trend)) throw Error(`INVALID_TREND: ${trend}; valid: ${Object.keys(TREND_CYCLES).join(', ')}`);
    const stat = (await request(this, 'GET_EFFECT_PUB_STAT', '/effectcam/v1/effect_pub_stat', { query: { ...query, cycle: TREND_CYCLES[trend] } })) || {};
    return {
      effect_id: query.effect_id,
      app_effect_id: query.app_effect_id,
      window: trend,
      level: {
        code: stat.cur_lv ?? null,
        publish: stat.cur_pub ?? null,
        next_code: stat.next_lv ?? null,
        publish_to_next: stat.next_lv_need_pub ?? null,
        is_new: stat.is_new_inc ?? null,
        overtime: stat.is_overtime ?? null,
      },
      days: trendDays(stat),
      exposure_total: stat.total_show ?? null,
      trial_total: stat.total_trial ?? null,
      follow_shoot: stat.follow_shoot_pub ?? null,
      video_plays: stat.video_plays ?? null,
    };
  },

  // 作品详情 page, 收益 card.
  async myEffectRevenue(params = {}) {
    const query = this.effectQuery(params);
    const d = (await request(this, 'GET_EFFECT_REVENUE', '/cam_api/effect/v1/revenue', { query })) || {};
    return {
      effect_id: query.effect_id,
      app_effect_id: query.app_effect_id,
      items: (d.revenue_details || []).map((r) => ({ name: r.display_type, amount: r.amount ?? null, note: r.detail_text || null, unlocked: r.unlocked ?? null })),
    };
  },

  // The mobile app's 我的 page: the designer, their levels, the figure cards and this month's numbers.
  async myProfile() {
    const [base, figures, monthData] = await Promise.all([
      request(this, 'GET_DESIGNER_BASE', '/cam_api/designer/v1/base'),
      request(this, 'GET_DESIGNER_DATA', '/cam_api/designer/v1/data'),
      request(this, 'GET_MONTH_DATA', '/effectcam/v1/month_data'),
    ]);
    const designer = (base && base.designer) || {};
    // Read off one answer against the figures and the daily revenue (2026-11-09): on_amount matched 本月上线,
    // revenue 本月收入, all_rev 累计收入, pd_revenue the day before's revenue. The rest stay unread.
    const { date, revenue: monthRevenue, pd_revenue, on_amount, all_rev, ...unread } = monthData || {};
    return {
      uid: str(designer.uid),
      nickname: designer.username || null,
      fans: designer.fans_num ?? null,
      real_name: designer.is_real_name ?? null,
      identities: ((base && base.identity_list) || []).map((i) => ({ name: i.name, level: i.lv ?? null, level_name: i.lv_name || null })),
      figures: slimFigures(figures && figures.display_list),
      month: {
        date: day(date),
        online_count: on_amount ?? null,
        revenue_yuan: yuan(monthRevenue),
        previous_day_revenue_yuan: yuan(pd_revenue),
        revenue_total_yuan: yuan(all_rev),
        unread,
      },
    };
  },

  // The mobile app's 钱包 revenue page; `month` (YYYYMM) picks the month, default this one.
  async myRevenue({ month } = {}) {
    if (month !== undefined && !/^\d{6}$/.test(month)) throw Error(`INVALID_MONTH: ${month}; expected YYYYMM`);
    const revenue = (await request(this, 'GET_ACCOUNT_REVENUE', '/effectcam/v1/account_revenue', { query: { d_m: month } })) || {};
    const sources = (r) => ((r && r.ro_list) || []).map((s) => ({ name: s.n, share: s.ro || null, yuan: yuan(s.re) }));
    const total = revenue.a_re || {};
    const inMonth = revenue.m_re || {};
    return {
      total_yuan: yuan(total.t_re),
      sources_total: sources(total),
      month: inMonth.re_m ?? null,
      month_yuan: yuan(inMonth.t_re),
      sources_month: sources(inMonth),
      days: (revenue.m_d_res || []).map((x) => ({ date: day(x.d), yuan: yuan(x.re) })),
      partner_play_incentive_yuan: yuan(revenue.partner_play_incentive),
    };
  },

  // The mobile app's 消息 page, newest first; a page's last message id fetches the next page.
  async messagesList({ group = 'all', cursor, count = 20 } = {}) {
    if (!hasOwn(MESSAGE_GROUPS, group)) throw Error(`INVALID_GROUP: ${group}; valid: ${Object.keys(MESSAGE_GROUPS).join(', ')}`);
    const d = await request(this, 'GET_MESSAGES', '/cam_api/message/v1/list', { query: { group: MESSAGE_GROUPS[group], cursor: cursor ?? '', count } });
    const items = (d.messages || []).map(slimMessage);
    const next = d.has_more && items.length ? items.at(-1).message_id : null;
    return { group, items, next_cursor: next, has_more: next !== null };
  },

  // The mobile app's 实时热点 list: 抖音's hot topics with their category and heat. Each entry's t and v
  // go back with its detail and videos requests, as the 热点详情 page sends them.
  async douyinHotList() {
    const d = (await request(this, 'GET_REAL_TIME_HOTS', '/effectcam/v1/real_time_hots')) || {};
    const list = d.ls || [];
    return {
      updated_at: hotListTime(d.v),
      items: list.map((h) => ({ hot_id: String(h.id), rank: h.r ?? null, name: h.n || '', categories: h.cs || [], heat_text: h.h_v || null })),
      raw: list.map((h) => ({ t: h.t, v: h.v })),
    };
  },

  // The 热点详情 page: when the topic got on the list, its heat by day and by hour, and how many effects it has.
  async douyinHotDetail({ hot_id, t, v } = {}) {
    const id = requireId(hot_id, 'INVALID_HOT_ID');
    const d = (await request(this, 'GET_HOT_DETAIL', '/effectcam/v1/hot_detail', { query: { id, t, v, d: '' } })) || {};
    const { id: _id, n, o_at, tag_name, b_e_text, b_s_text, d_ts, h_ts, ...unread } = d;
    return {
      hot_id: id,
      name: n || '',
      category: tag_name || null,
      listed_at_text: o_at || null,
      effects_text: b_e_text || null,
      status_text: b_s_text || null,
      days: (d_ts || []).map(heatPoint),
      hours: (h_ts || []).map(heatPoint),
      unread,
    };
  },

  // The 热点详情 page's videos of the topic.
  async douyinHotVideos({ hot_id, t, v } = {}) {
    const id = requireId(hot_id, 'INVALID_HOT_ID');
    const list = (await request(this, 'GET_HOT_VIDEOS', '/effectcam/v1/hot_detail_videos', { query: { id, t, v, d: '' } })) || [];
    return {
      hot_id: id,
      items: list.map((x) => ({
        video_id: str(x.id),
        video_url: x.url || null,
        cover_url: x.icon || null,
        likes: x.digg_v ?? null,
        likes_text: x.digg || null,
        author: x.author ? { id: str(x.author.id), name: x.author.name || '' } : null,
      })),
    };
  },

  // Every received effect task's 我的作品 rows in one list, as task_detail reads them one task at a time.
  async myTaskStatus() {
    const d = await request(this, 'GET_EFFECT_TASKS', this.mod(M.urls).DomainPath.kTaskListAPI);
    const received = (d.effect_tasks || []).filter((t) => t.designer_task_id);
    const items = [];
    for (const t of received) {
      const detail = await request(this, 'GET_EFFECT_TASK', '/effectcam/v2/effect_task_detail', { query: { item_id: String(t.item_id), app_version: TASK_PAGE_APP_VERSION } });
      for (const e of detail.task_effect_list || []) items.push({ task_id: String(t.task_id ?? t.item_id), task_title: t.title || '', ...slimTaskEffect(e) });
    }
    const by_state = {};
    for (const i of items) by_state[i.task_state] = (by_state[i.task_state] || 0) + 1;
    return { tasks_checked: received.length, summary: { by_state, off_theme: items.filter((i) => i.off_theme).length }, items };
  },
};

const METHODS = {
  inspiration_list: 'inspirationList',
  inspiration_detail: 'inspirationDetail',
  inspiration_collect: 'inspirationCollect',
  inspiration_collected: 'collectedInspirations',
  inspiration_bind: 'inspirationBind',
  growth_route: 'growthRoute',
  tasks_list: 'tasksList',
  growth_tasks_list: 'growthTasksList',
  task_detail: 'taskDetail',
  growth_task_detail: 'growthTaskDetail',
  task_receive: 'taskReceive',
  rank_list: 'rankList',
  rank_hotspots: 'rankHotspots',
  hotspot_inspirations: 'hotspotInspirations',
  rank_subjects: 'rankSubjects',
  rank_subjects_search: 'rankSubjectsSearch',
  rank_subject_detail: 'rankSubjectDetail',
  rank_innovation: 'rankInnovation',
  rank_creators: 'rankCreators',
  my_effects: 'myEffects',
  my_effect_reviews: 'myEffectReviews',
  my_effect_data: 'myEffectData',
  my_effect_trend: 'myEffectTrend',
  my_effect_revenue: 'myEffectRevenue',
  my_profile: 'myProfile',
  my_revenue: 'myRevenue',
  messages_list: 'messagesList',
  my_task_status: 'myTaskStatus',
  douyin_hot_list: 'douyinHotList',
  douyin_hot_detail: 'douyinHotDetail',
  douyin_hot_videos: 'douyinHotVideos',
};

module.exports = { methods, METHODS, INNOVATION_KINDS, SUBJECT_KINDS, RANK_TYPES, RANK_FILTERS, TREND_CYCLES, MESSAGE_GROUPS, MESSAGE_MAX, DOUYIN_APP_ID, request, requireId, str, first, iso, appEffectId, slimInspiration };
