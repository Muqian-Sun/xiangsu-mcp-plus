import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';

const require = createRequire(import.meta.url);
const { Library, M, INNOVATION_KINDS, RANK_FILTERS, SUBJECT_KINDS } = require('../editor-plugin/library.cjs');

const ok = (data) => JSON.stringify({ code: 0, message: 'success', data });

// Fixtures trimmed from real responses; the 19-digit ids stay raw JSON text.
const INSPIRATION = {
  id: '7697075498307897370',
  title: '鎏花入镜',
  cover_img: { uri: 'u', urlList: ['https://cdn/i1.png'], width: 1728, height: 2304 },
  tag_desc: '激励',
  author_name: '唐糖',
  author_avatar: 'https://cdn/a.png',
  total_collection: 185,
  is_collect: false,
  author_uid: '2465527461847677',
  is_ai_ins: true,
  hotspot_data: { id: '13483', title: '进博会中国好物' },
};
const INSPIRATION_DETAIL = {
  base: {
    id: '7696975869251864618',
    title: '万元券锦鲤妆',
    detail_desc: 'AI 锦鲤妆造',
    imgs: [{ uri: 'x', urlList: ['https://cdn/d1.png'], width: 1728, height: 2304 }],
    effect_types: [{ id: 5841, name: 'AI 妆造扮演' }],
    bonus_text: '收藏灵感，即有机会获得激励',
    tag_desc: '',
  },
  designer: { uid: '103424810657', name: '早安玫瑰', avatar: 'https://cdn/av.png' },
  award: { id: '0', type: 0, amount: 0, text: '', desc: '' },
  ai_hotspot_info: { id: '12527', title: '双11开门红', score: '11681000', tags: ['66条热点相关灵感', '1168.1万热度'] },
  project_info: { title: 'AI 女神节快乐', icon: 'i', desc: '可在像塑桌面端搜索使用' },
  effects: [{ name: '拆快递', total_pub_num: 169 }],
  videos: [
    { video_url: 'https://play/v1', video_img: 'https://img/c1.jpeg', video_username: '吃屁股', video_avatar: '', video_digg: '', height: 1920, width: 864 },
    { video_url: 'https://play/v2', video_img: 'https://img/c2.jpeg', video_username: '小鱼', video_digg: '1.2万', height: 1280, width: 720 },
  ],
  stickers: [],
};
// The task list can carry a tag twice (「特效/模板」 seen twice, 2026-11-09).
const ACTIVITY = { id: 'A1', title: '新人成长路线', tags: '新手,必做,新手', ttl: 3 * 86400000 + 5 };
const EFFECT_TASKS = {
  cursor: 0,
  total: 2,
  effect_tasks: [
    {
      title: '冷空气网感美妆定向征集赛',
      process_status: 1,
      process_status_text: '领取',
      process_status_desc: '查看官方指导，帮您完成任务',
      designer_task_id: '',
      item_id: 108116,
      tags: [
        { type: 3, name: '特效' },
        { type: 5, name: '特效' },
      ],
      revenue: '0',
      icon_url: 'https://cdn/t.png',
      can_fin_times: -1,
      binding_templates: ['7408401210929053711', '7411422748410609714'],
      receive_id: 108117,
      task_id: 108117,
      offline_at: 1797350400000,
      release_at: 1793977780000,
    },
    { title: '冬日将至爆款玩法征集赛', process_status: 2, process_status_text: '去制作', designer_task_id: '555', item_id: 108200, tags: [], receive_id: 108201, task_id: 108201 },
  ],
};
const GROWTH_TASKS = {
  cursor: 2,
  total: 2,
  growth_tasks: [
    {
      task_id: 'headdress_decoration',
      name: '学会制作1款头饰装饰特效',
      icon: 'https://cdn/g.png',
      bonus_amount: 1000,
      tags: ['基础任务', '10元奖励'],
      project_data: [{ project_id: '7535420584646262830', project_desc: '投稿量80万' }],
      growth_task_type: 1,
    },
    { task_id: 'newbie_first', name: '完成第一个特效', bonus_amount: 500, tags: [], project_data: [], growth_task_type: 0 },
  ],
};
const RANK_TAGS = [
  { tagName: '基础头饰', level: 2, num: 45 },
  { tagName: '美妆', level: 2, num: 17 },
  { tagName: '人像美化', level: 1, num: 68 },
  { tagName: '游戏玩法', level: 1, num: 49 },
  { tagName: '怪奇', level: 4, num: 1 },
];
const RANK_EFFECT = {
  app_effect_id: 273663451,
  effect_name: '好友对你都有什么想法',
  effect_icon: 'https://cdn/r1.png',
  effect_lv: 3,
  peak_pub_val: '56.7万',
  male_pub_rate: '34.84',
  female_pub_rate: '65.16',
  effect_id: '88649924',
  young_like_score: 10,
  all_pub_val: '506.6万',
  is_new_inc: true,
  male_like_score: 9,
  hot_play_score: 8,
  follow_shoot_pub_val: 67206,
  follow_shoot_pub_val_30d: 2047071,
  effect_total_rev: '71291',
};
const HOTSPOTS = {
  rank_time: '2026-11-06 15',
  subtitle: '激发创作灵感 每周瓜分1万！',
  hotspots: [
    {
      id: '2728034',
      title: '原来深秋是咕嘟的',
      topic_id: '13439',
      cover: { urlList: ['https://cdn/h1.png'] },
      hot_core: 19727126,
      subtitle_text: '69条创作灵感',
      rank_num: 10,
      description: '深秋咕嘟暖感强',
      tags: ['1972.7万热度'],
    },
    { id: '2729772', title: '立冬', topic_id: '13444', cover: { urlList: [] }, hot_core: 19384492, rank_num: 21, tags: [] },
  ],
};
const HOTSPOT_INSPIRATIONS =
  '{"code":0,"message":"success","data":{"insp_tabs":[{"id":0,"title":"全部","insps":[{"tag":"AI 妆造扮演","id":7704552248298391592,"title":"宿舍小电锅咕嘟达人","cover":{"uri":"u","urlList":["https://cdn/hi.png"]},"detail":"AI 宿舍场景"}]}]}}';
const SUBJECT = {
  subject_id: '261',
  subject_name: '测一测玩法特效榜 - 11月 ',
  sub_title: '本月测一测爆款',
  page_view_cnt: 5120,
  subject_cover_pic: 'https://cdn/s.png',
  online_time: 1793772002000,
  effects: [{ app_effect_id: 278949852, effect_id: '90154479', effect_name: '11月你会发生什么', effect_icon: 'https://cdn/e.png', effect_desc: '' }],
};
// 23 effect boards and 2 template boards; the template board's app_effect_id overflowed like the real one.
const EFFECT_SUBJECTS = Array.from({ length: 23 }, (_, i) => ({ ...SUBJECT, subject_id: String(261 - i), subject_name: i === 21 ? '热爆美妆特效榜 - 3月' : `测一测玩法特效榜 - ${i}期` }));
const TEMPLATE_SUBJECTS = [
  {
    subject_id: '203',
    subject_name: '萌娃萌宠模板榜 - 9月',
    effects: [{ app_effect_id: -1388249034, app_effect_id_str: '7529884834588590134', effect_id: '40013082', effect_name: 'AI 高级感睡裙试穿' }],
  },
  { subject_id: '204', subject_name: '歌词玩法模板榜 - 10月', effects: [] },
];
// The 专题合集 endpoint: cursor is an offset it echoes back, and past the end it answers code 0 without data.
function subjectsRoute(call) {
  const list = call.query.type === '2' ? TEMPLATE_SUBJECTS : EFFECT_SUBJECTS;
  const at = Number(call.query.cursor);
  const page = list.slice(at, at + Number(call.query.count));
  if (!page.length) return JSON.stringify({ code: 0, message: 'success' });
  return ok({ cursor: at, count: Number(call.query.count), total: list.length, subjects: page });
}
const CREATOR_MONTH =
  '{"code":0,"message":"success","data":[{"rank_no":1,"uid":7495234997042594875,"username":"征蓬落日圆","avatar":"https://cdn/u.png","material_cnt":1,"award_num":300000,"display_val":"预计奖3000元","display_follow_pub":"1.2万","follow_pub_val":12972}]}';
const PICKS = {
  effect_list: [
    {
      effect_id_str: '91518554',
      app_effect_id_str: '7703570232371232802',
      name: '用这首歌官宣好朋友',
      icon: 'https://cdn/p.png',
      pub_val: '5741',
      total_rev: '67.54',
      cover_img: 'https://cdn/pc.jpeg',
      label: '音频配文',
      review_date: '2026-11-03',
      video_item_id: '7704341495155455739',
    },
  ],
  date: '2026-11-03',
  total: 249,
  has_more: true,
};

const BASE_ROUTES = {
  'GET /creator/v1/growth_route_online': ok({ activities: [ACTIVITY] }),
  'GET /creator_api/inspiration/v1/tabs': ok({ tab_names: ['全部', '热门音源', '头饰'] }),
  'GET /creator_api/inspiration/v1/list': ok({ total: 10000000, cursor: 23, count: 3, has_more: true, list: [INSPIRATION] }),
  'GET /creator/v2/inspiration_detail': ok(INSPIRATION_DETAIL),
  'GET /creator_api/inspiration/v1/is_collected': ok({ item_id: '7696975869251864618', is_collected: false }),
  'GET /creator_api/inspiration/v1/extra': ok({ id: '7696975869251864618', total_collection: 35 }),
  'GET /creator_api/task/v1/effect_task_list': ok(EFFECT_TASKS),
  'GET /cam_api/task/v1/growth_task_list': ok(GROWTH_TASKS),
  'GET /cam_api/rank/v1/tag': ok(RANK_TAGS),
  'GET /cam_api/rank/v1/detail': ok({ cursor: 7, count: 2, total: 200, update_time: '2026-11-06 16:32:12', date: '2026-11-06', effects: [RANK_EFFECT], title: '年轻排名' }),
  'GET /cam_api/hotspot/v1/rank': ok(HOTSPOTS),
  'GET /cam_api/hotspot/v1/insp_tabs': HOTSPOT_INSPIRATIONS,
  'GET /cam_api/discover/v1/subjects': subjectsRoute,
  'GET /cam_api/discover/v1/subject_detail': ok({ subject: SUBJECT, cursor: 10, count: 10, total: 1 }),
  'GET /cam_api/innovation_plan/v1/user_month_rank': CREATOR_MONTH,
  'GET /cam_api/innovation_plan/v1/rank_list': ok(PICKS),
};

// A fake editor exposing the modules the community feature reads, and a fetch answering by method and path.
function setup(routes = {}) {
  const table = { ...BASE_ROUTES, ...routes };
  const calls = [];
  const cookieUrls = [];
  const marked = [];
  const state = { project: true };
  const modules = {
    [M.urls]: {
      Domain: { kBackendApiURL: 'https://api.test' },
      DomainPath: { kActivityAPI: '/creator/v1/growth_route_online', kTaskListAPI: '/creator_api/task/v1/effect_task_list', kGrowthTaskList: '/cam_api/task/v1/growth_task_list' },
    },
    [M.orionui]: {
      CookieManager: class {
        async getCookie(url) {
          cookieUrls.push(url);
          return 'sessionid=abc';
        }
      },
    },
    [M.bizUtils]: { PlatformUtils: { genSignData: () => 'signed' }, UserAgentUtils: { userAgentGenerator: () => () => 'DouyinAR/9.7.2' } },
    [M.activityTypes]: {
      TaskStatus: { 1: 'WAIT_RECEIVE', 2: 'WAIT_SUBMIT', WAIT_RECEIVE: 1, WAIT_SUBMIT: 2 },
      growthTaskType: { 0: 'Newbie', 1: 'Other', Newbie: 0, Other: 1 },
      getTypeName: (m) => ({ 1: 'special', 2: 'special', 3: 'video' })[m.display_type] || 'normal',
    },
    [M.inspirationConst]: { IS_COLLECT_PARAMS_TYPE: { Default: 2, Music: 5 } },
    [M.inspirationBridge]: { markAgentInspirationUsed: ({ inspirationId }) => marked.push(inspirationId) },
    [M.ef]: { ProjectManager: { getInstance: () => ({ hasActiveProject: () => state.project }) } },
  };
  const mod = (name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  };
  const fetch = async (href, init) => {
    const url = new URL(href);
    const call = { origin: url.origin, path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method, headers: init.headers, body: init.body, signal: init.signal };
    calls.push(call);
    const route = table[`${init.method} ${url.pathname}`];
    if (route === undefined) throw Error(`unexpected ${init.method} ${url.pathname}`);
    const r = typeof route === 'function' ? route(call, calls) : route;
    return r instanceof Response ? r : new Response(r, { status: 200 });
  };
  const to = (path) => calls.filter((c) => c.path === path);
  return { lib: new Library(mod, fetch), calls, to, modules, cookieUrls, marked, state };
}

test('community requests carry the editor login cookie and signing headers and keep 19-digit ids exact', async () => {
  const { lib, calls, cookieUrls } = setup();
  const out = await lib.hotspotInspirations({ topic_id: '13439' });
  assert.equal(out.items[0].inspiration_id, '7704552248298391592');
  assert.equal(out.items[0].cover_url, 'https://cdn/hi.png');
  assert.equal(out.items[0].tab, out.tabs[0]);
  const month = await lib.rankCreatorsMonth();
  assert.equal(month.items[0].uid, '7495234997042594875');
  assert.equal(calls[0].origin, 'https://api.test');
  assert.deepEqual(calls[0].query, { topic_id: '13439' });
  assert.deepEqual(calls[0].headers, { cookie: 'sessionid=abc', 'x-api-sign-data': 'signed', 'user-agent': 'DouyinAR/9.7.2' });
  assert.deepEqual(cookieUrls[0], 'https://api.test');
  assert.ok(calls.every((c) => c.signal instanceof AbortSignal), 'every request has a timeout');
});

test('community requests fail on server codes, HTTP errors and non-JSON bodies', async () => {
  const bad = setup({ 'GET /cam_api/rank/v1/detail': JSON.stringify({ code: 400, message: '参数错误' }) });
  await assert.rejects(bad.lib.rankList({}), /GET_RANK_FAILED: code=400 message=参数错误/);
  const http = setup({ 'GET /cam_api/hotspot/v1/rank': () => new Response('busy', { status: 502 }) });
  await assert.rejects(http.lib.rankHotspots({}), /GET_HOTSPOTS_FAILED: HTTP 502/);
  const html = setup({ 'GET /cam_api/discover/v1/subjects': '<html>' });
  await assert.rejects(html.lib.rankSubjects({}), /GET_SUBJECTS_FAILED: response is not JSON/);
});

test('reads retry once on the busy code 1; writes and other codes are not retried', async () => {
  const busy = JSON.stringify({ code: 1, message: '网络开小差了' });
  const flaky = setup({ 'GET /cam_api/task/v1/growth_task_detail': (call, calls) => (calls.length === 1 ? busy : ok(GROWTH_TASKS.growth_tasks[0])) });
  assert.equal((await flaky.lib.growthTaskDetail({ id: 'headdress_decoration' })).title, '学会制作1款头饰装饰特效');
  assert.equal(flaky.to('/cam_api/task/v1/growth_task_detail').length, 2);
  const down = setup({ 'GET /cam_api/task/v1/growth_task_detail': busy });
  await assert.rejects(down.lib.growthTaskDetail({ id: 'headdress_decoration' }), /GET_GROWTH_TASK_FAILED: code=1 message=网络开小差了/);
  assert.equal(down.to('/cam_api/task/v1/growth_task_detail').length, 2);
  const bad = setup({ 'GET /cam_api/rank/v1/detail': JSON.stringify({ code: 400, message: '参数错误' }) });
  await assert.rejects(bad.lib.rankList({}), /code=400/);
  assert.equal(bad.to('/cam_api/rank/v1/detail').length, 1);
  const write = setup({ 'POST /creator/v1/receive_task': busy });
  await assert.rejects(write.lib.taskReceive({ item_id: '108116' }), /RECEIVE_TASK_FAILED: code=1/);
  assert.equal(write.to('/creator/v1/receive_task').length, 1);
});

test('inspiration_list checks the tab, sends flag 1 for the first page and 2 after, and slims items', async () => {
  const { lib, to } = setup();
  const out = await lib.inspirationList({});
  assert.deepEqual(to('/creator_api/inspiration/v1/list')[0].query, { flag: '1', cursor: '0', count: '20', tab_name: '全部' });
  assert.deepEqual(out, {
    tab: '全部',
    tabs: ['全部', '热门音源', '头饰'],
    items: [
      {
        inspiration_id: '7697075498307897370',
        title: '鎏花入镜',
        tag: '激励',
        author: '唐糖',
        author_uid: '2465527461847677',
        collect_count: 185,
        collected: false,
        ai: true,
        hotspot: { id: '13483', title: '进博会中国好物' },
        cover_url: 'https://cdn/i1.png',
      },
    ],
    next_cursor: 23,
    has_more: true,
  });
  await lib.inspirationList({ tab: '头饰', cursor: 23, count: 5 });
  assert.deepEqual(to('/creator_api/inspiration/v1/list')[1].query, { flag: '2', cursor: '23', count: '5', tab_name: '头饰' });
  await assert.rejects(lib.inspirationList({ tab: '宠物' }), /INVALID_TAB: 宠物; valid: 全部, 热门音源, 头饰/);
  assert.equal(to('/creator_api/inspiration/v1/list').length, 2);
});

test('inspiration_detail merges the detail with its collection state and count', async () => {
  const { lib, to } = setup();
  const out = await lib.inspirationDetail({ inspiration_id: '7696975869251864618' });
  assert.deepEqual(out, {
    inspiration_id: '7696975869251864618',
    title: '万元券锦鲤妆',
    description: 'AI 锦鲤妆造',
    tag: null,
    effect_types: ['AI 妆造扮演'],
    bonus_text: '收藏灵感，即有机会获得激励',
    images: ['https://cdn/d1.png'],
    author: { uid: '103424810657', name: '早安玫瑰' },
    award: null,
    hotspot: { id: '12527', title: '双11开门红', score: '11681000', tags: ['66条热点相关灵感', '1168.1万热度'] },
    project: { title: 'AI 女神节快乐', desc: '可在像塑桌面端搜索使用', icon_url: 'i' },
    effects: [{ name: '拆快递', published: 169 }],
    videos: [
      { url: 'https://play/v1', cover_url: 'https://img/c1.jpeg', author: '吃屁股', likes: null, width: 864, height: 1920 },
      { url: 'https://play/v2', cover_url: 'https://img/c2.jpeg', author: '小鱼', likes: '1.2万', width: 720, height: 1280 },
    ],
    stickers: [],
    collected: false,
    collect_count: 35,
  });
  assert.deepEqual(to('/creator/v2/inspiration_detail')[0].query, { id: '7696975869251864618' });
  assert.deepEqual(to('/creator_api/inspiration/v1/is_collected')[0].query, { item_id: '7696975869251864618', item_type: '2' });
  assert.deepEqual(to('/creator_api/inspiration/v1/extra')[0].query, { id: '7696975869251864618' });
  await assert.rejects(lib.inspirationDetail({ inspiration_id: ' ' }), /INVALID_INSPIRATION_ID/);
  const gone = setup({ 'GET /creator/v2/inspiration_detail': ok({ base: { imgs: [] }, videos: [] }) });
  await assert.rejects(gone.lib.inspirationDetail({ inspiration_id: '1' }), /INSPIRATION_NOT_FOUND: 1/);
});

test('inspiration_bind records the inspiration on the open project and collects it so the submit window lists it', async () => {
  let collected = true;
  const { lib, marked, state, to } = setup({
    'GET /creator_api/inspiration/v1/is_collected': () => ok({ is_collected: collected }),
    'POST /creator_api/inspiration/v1/collect': (call) => {
      collected = JSON.parse(call.body).action === 1;
      return ok({});
    },
  });
  assert.deepEqual(await lib.inspirationBind({ inspiration_id: ' 77 ' }), { bound: '77', collected: true, newly_collected: false, next: 'save_project to keep it' });
  assert.deepEqual(marked, ['77']);
  assert.equal(to('/creator_api/inspiration/v1/collect').length, 0);
  collected = false;
  assert.deepEqual(await lib.inspirationBind({ inspiration_id: '77' }), { bound: '77', collected: true, newly_collected: true, next: 'save_project to keep it' });
  assert.equal(to('/creator_api/inspiration/v1/collect').length, 1);
  await assert.rejects(lib.inspirationBind({ inspiration_id: ' ' }), /INVALID_INSPIRATION_ID/);
  state.project = false;
  await assert.rejects(lib.inspirationBind({ inspiration_id: '77' }), /NO_ACTIVE_PROJECT/);
  assert.deepEqual(marked, ['77', '77']);
});

test('inspiration_collect posts the inspiration card with the action and confirms the new state', async () => {
  let collected = false;
  const routes = {
    'POST /creator_api/inspiration/v1/collect': (call) => {
      collected = JSON.parse(call.body).action === 1;
      return ok({});
    },
    'GET /creator_api/inspiration/v1/is_collected': () => ok({ is_collected: collected }),
  };
  const { lib, to } = setup(routes);
  assert.deepEqual(await lib.inspirationCollect({ inspiration_id: '7696975869251864618' }), {
    inspiration_id: '7696975869251864618',
    title: '万元券锦鲤妆',
    collected: true,
  });
  const post = to('/creator_api/inspiration/v1/collect')[0];
  assert.equal(post.headers['content-type'], 'application/json');
  const body = JSON.parse(post.body);
  assert.deepEqual({ ...body, extra: JSON.parse(body.extra) }, {
    item_id: '7696975869251864618',
    item_name: '万元券锦鲤妆',
    item_type: 2,
    action: 1,
    extra: { img_url: 'https://cdn/d1.png', img_width: '1728.0', img_height: '2304.0', tag_desc: '', author: '早安玫瑰', avatar: 'https://cdn/av.png', collect_num: 35 },
  });
  assert.equal((await lib.inspirationCollect({ inspiration_id: '7696975869251864618', collect: false })).collected, false);
  assert.equal(JSON.parse(to('/creator_api/inspiration/v1/collect')[1].body).action, 0);
});

test('inspiration_collect reports a collection the server did not apply', async () => {
  const { lib } = setup({ 'POST /creator_api/inspiration/v1/collect': ok({}) });
  await assert.rejects(lib.inspirationCollect({ inspiration_id: '7696975869251864618' }), /COLLECT_NOT_APPLIED: inspiration 7696975869251864618 is not collected/);
});

test('inspiration_collected asks for collected inspirations of every known artwork type with their cards, and keeps cardless entries', async () => {
  // Trimmed from a real page (2026-11-10).
  const page = {
    cursor: 52,
    count: 2,
    has_more: true,
    total: 56,
    items: [
      {
        item_id: '7697075498307897370',
        item_name: '鎏花入镜',
        item_type: 2,
        create_time: '2026-11-10 11:53:25',
        extra: '{"img_url":"https://cdn/x.png","img_width":529.0,"img_height":668.0,"tag_desc":""}',
        item_status: 1,
        artwork_type: 0,
        ins_detail: { ...INSPIRATION, is_collect: true, insp_artwork_type: 0, ins_type: 1, source: 3 },
        task_info: { designer_task_id: '7705385617585670178', task_title: '冷空气网感美妆定向征集赛', task_id: '108116' },
      },
      { item_id: '7690401119121672242', item_name: '小猫踏浪舞蹈抠像模板', item_type: 2, create_time: '2026-11-07 00:21:17', item_status: 1, artwork_type: 2 },
    ],
  };
  const { lib, to } = setup({ 'POST /creator_api/inspiration/v1/collect_list': ok(page) });
  assert.deepEqual(await lib.collectedInspirations({ cursor: 50, count: 2 }), {
    total: 56,
    items: [
      {
        inspiration_id: '7697075498307897370',
        title: '鎏花入镜',
        tag: '激励',
        author: '唐糖',
        author_uid: '2465527461847677',
        collect_count: 185,
        collected: true,
        ai: true,
        hotspot: { id: '13483', title: '进博会中国好物' },
        cover_url: 'https://cdn/i1.png',
        artwork_type: 0,
        collected_at: '2026-11-10T03:53:25.000Z',
        task: { task_id: '108116', title: '冷空气网感美妆定向征集赛' },
      },
      { inspiration_id: '7690401119121672242', title: '小猫踏浪舞蹈抠像模板', card_missing: true, artwork_type: 2, collected_at: '2026-11-06T16:21:17.000Z', task: null },
    ],
    next_cursor: 52,
    has_more: true,
  });
  const post = to('/creator_api/inspiration/v1/collect_list')[0];
  assert.equal(post.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(post.body), { item_types: [2], artwork_types: [0, 2, 5, 14], need_ins_detail: true, need_del: false, cursor: 50, count: 2 });
  await lib.collectedInspirations();
  assert.deepEqual(JSON.parse(to('/creator_api/inspiration/v1/collect_list')[1].body), { item_types: [2], artwork_types: [0, 2, 5, 14], need_ins_detail: true, need_del: false, cursor: 0, count: 20 });
});

test('inspiration_collected reads an empty collection, which comes without items', async () => {
  const { lib } = setup({ 'POST /creator_api/inspiration/v1/collect_list': ok({ cursor: 0, count: 0, has_more: false, total: 0 }) });
  assert.deepEqual(await lib.collectedInspirations(), { total: 0, items: [], next_cursor: 0, has_more: false });
});

test('tasks_list merges activities and effect tasks, and prepares launch extras only for received ones', async () => {
  const { lib, to } = setup();
  const effect = await lib.tasksList();
  assert.deepEqual(effect.items.map((i) => [i.task_id, i.kind]), [['A1', 'activity'], ['108117', 'task'], ['108201', 'task']]);
  assert.deepEqual(effect.items[1], {
    task_id: '108117',
    kind: 'task',
    title: '冷空气网感美妆定向征集赛',
    status: 'WAIT_RECEIVE',
    status_text: '领取',
    status_desc: '查看官方指导，帮您完成任务',
    received: false,
    bindable: false,
    tags: ['特效'],
    days_left: null,
    revenue: '0',
    can_finish_times: -1,
    released_at: new Date(1793977780000).toISOString(),
    offline_at: new Date(1797350400000).toISOString(),
    icon_url: 'https://cdn/t.png',
  });
  assert.deepEqual({ received: effect.items[2].received, bindable: effect.items[2].bindable, status: effect.items[2].status }, { received: true, bindable: true, status: 'WAIT_SUBMIT' });
  assert.deepEqual({ status: effect.items[0].status, tags: effect.items[0].tags, days: effect.items[0].days_left }, { status: null, tags: ['新手', '必做'], days: 3 });
  assert.deepEqual(effect.raw, [
    { kind: 'activity', item_id: null, extra: { activity_id: 'A1', activity_name: '新人成长路线', activity_enter_from: 'homepage', activity_type: 'normal', task_type: 'Growup' } },
    { kind: 'task', item_id: '108116', extra: null },
    { kind: 'task', item_id: '108200', extra: { activity_id: '555', activity_name: '冬日将至爆款玩法征集赛', activity_enter_from: 'homepage', activity_type: 'normal', task_type: 'Normal' } },
  ]);
  assert.equal(to('/cam_api/task/v1/growth_task_list').length, 0);
});

test('growth_tasks_list reads the activity center growth tasks with their bonus in yuan', async () => {
  const { lib, to } = setup();
  const growth = await lib.growthTasksList();
  assert.deepEqual(growth.items[0], {
    task_id: 'headdress_decoration',
    title: '学会制作1款头饰装饰特效',
    bonus_yuan: 10,
    tags: ['基础任务', '10元奖励'],
    newbie: false,
    projects: [{ project_id: '7535420584646262830', desc: '投稿量80万' }],
    icon_url: 'https://cdn/g.png',
  });
  assert.equal(growth.items[1].newbie, true);
  assert.equal(growth.raw, undefined);
  assert.equal(to('/creator_api/task/v1/effect_task_list').length, 0);
});

test('task_detail reads an effect task like the task window, and growth_task_detail a growth task with its inspirations', async () => {
  const { lib, to } = setup({
    'GET /effectcam/v2/effect_task_detail': ok({
      process_status: 1,
      s_desc: '未领取',
      title: '冷空气网感美妆定向征集赛',
      tags: [
        { name: '特效', type: 3 },
        { name: '特效', type: 5 },
      ],
      reward_begin: '12月21日',
      reward_end: '12月31日',
      template_id_list: '["7408401210929053711","7411422748410609714"]',
      can_fin_times: -1,
      offline_at_unix: 1797350400000,
      fin_status: '',
      is_level_task: false,
      task_effect_list: [
        {
          effect_name: '方言吃播挑战',
          shoot_num: '0',
          vv_num: '0',
          effect_status: 100,
          effect_status_desc: '审核中',
          award_amount: '',
          effect_id: '92199001',
          icon: { uri: 'u', url_list: ['https://cdn/e1.png', 'https://cdn/e1b.png'] },
          pub_peak_num: '0',
          task_status: 1,
          is_fit_theme: 1,
          type_desc: '特效',
          sub_track_name: '',
        },
        { effect_name: '跟着小猫做动作', effect_id: '92218559', effect_status: 103, task_status: 2, is_fit_theme: 2 },
        { effect_name: '我和codex三天', effect_id: '92149570', effect_status: 103, task_status: 3, is_fit_theme: 3 },
        { effect_name: '新状态', effect_id: '92000000', effect_status: 103, task_status: 9, is_fit_theme: 9 },
      ],
    }),
    'GET /effectcam/v2/effect_task_content': ok({
      modules: [{ name: '', type: 3, seq: 0, render_content: '{"type":3,"contentBlockName":"参与要求","demandList":[{"tit":"主题要求","desc":"年轻美妆"}]}' }],
    }),
    'GET /cam_api/task/v1/growth_task_detail': ok({
      ...GROWTH_TASKS.growth_tasks[0],
      inspiration_list: [INSPIRATION],
      tutorial_title: '像素胡子小蓝兔教程',
      tutorial_desc: '静态贴纸替换',
      tutorial_video_url: 'https://cdn/v.mp4',
    }),
  });
  const { raw, ...effect } = await lib.taskDetail({ id: '108116' });
  for (const path of ['/effectcam/v2/effect_task_detail', '/effectcam/v2/effect_task_content']) {
    assert.deepEqual(to(path)[0].query, { item_id: '108116', app_version: '11.3.0' });
  }
  assert.deepEqual(effect, {
    title: '冷空气网感美妆定向征集赛',
    status: 'WAIT_RECEIVE',
    status_text: '未领取',
    tags: ['特效'],
    reward_begin: '12月21日',
    reward_end: '12月31日',
    offline_at: new Date(1797350400000).toISOString(),
    can_finish_times: -1,
    finish_status: null,
    level_task: false,
    my_effects: [
      {
        effect_id: '92199001',
        name: '方言吃播挑战',
        type: '特效',
        status: '审核中',
        status_code: 100,
        task_state: 'pending',
        off_theme: false,
        track: null,
        shoots: '0',
        views: '0',
        publish_peak: '0',
        award_amount: null,
        icon_url: 'https://cdn/e1.png',
      },
      ...[
        ['92218559', '跟着小猫做动作', 'unfinished', true],
        ['92149570', '我和codex三天', 'done', false],
        ['92000000', '新状态', 9, false],
      ].map(([effect_id, name, task_state, off_theme]) => ({
        effect_id,
        name,
        type: null,
        status: null,
        status_code: 103,
        task_state,
        off_theme,
        track: null,
        shoots: null,
        views: null,
        publish_peak: null,
        award_amount: null,
        icon_url: null,
      })),
    ],
    recommended_template_ids: ['7408401210929053711', '7411422748410609714'],
    recommended_template_total: 2,
    content: [{ name: '参与要求', items: [{ title: '主题要求', text: '年轻美妆' }] }],
  });
  assert.deepEqual(raw.content, [{ type: 3, contentBlockName: '参与要求', demandList: [{ tit: '主题要求', desc: '年轻美妆' }] }]);
  assert.equal(raw.detail.template_id_list, '["7408401210929053711","7411422748410609714"]');
  assert.equal(to('/cam_api/task/v1/growth_task_detail').length, 0);
  const growth = await lib.growthTaskDetail({ id: 'headdress_decoration' });
  assert.deepEqual(to('/cam_api/task/v1/growth_task_detail')[0].query, { task_id: 'headdress_decoration' });
  assert.equal(growth.bonus_yuan, 10);
  assert.deepEqual(growth.inspirations.map((i) => i.inspiration_id), ['7697075498307897370']);
  assert.deepEqual(growth.tutorial, { title: '像素胡子小蓝兔教程', desc: '静态贴纸替换', video_url: 'https://cdn/v.mp4' });
  assert.equal(growth.title, '学会制作1款头饰装饰特效');
  assert.equal(to('/effectcam/v2/effect_task_detail').length, 1);
  await assert.rejects(lib.growthTaskDetail({}), /INVALID_TASK_ID/);
  await assert.rejects(lib.taskDetail({}), /INVALID_TASK_ID/);
});

test('task_detail hands on recommended template ids it cannot read as they came', async () => {
  const { lib } = setup({ 'GET /effectcam/v2/effect_task_detail': ok({ title: '征集赛', tags: [], template_id_list: '7408,' }), 'GET /effectcam/v2/effect_task_content': ok({ modules: [] }) });
  assert.deepEqual((await lib.taskDetail({ id: '1' })).recommended_template_ids, { unparsed: '7408,' });
  const none = setup({ 'GET /effectcam/v2/effect_task_detail': ok({ title: '征集赛', tags: [] }), 'GET /effectcam/v2/effect_task_content': ok({ modules: [] }) });
  const empty = await none.lib.taskDetail({ id: '1' });
  assert.deepEqual([empty.recommended_template_ids, empty.recommended_template_total], [[], 0]);
});

test('task_detail lists the first 20 recommended templates once each, with how many there are', async () => {
  // 108117 recommended 120, some twice (2026-11-09).
  const ids = Array.from({ length: 30 }, (_, i) => String(7400000000000000000n + BigInt(i)));
  const list = JSON.stringify([...ids, ids[0], ids[5]]);
  const { lib } = setup({ 'GET /effectcam/v2/effect_task_detail': ok({ title: '征集赛', tags: [], template_id_list: list }), 'GET /effectcam/v2/effect_task_content': ok({ modules: [] }) });
  const out = await lib.taskDetail({ id: '1' });
  assert.deepEqual(out.recommended_template_ids, ids.slice(0, 20));
  assert.equal(out.recommended_template_total, 30);
  assert.equal(out.raw.detail.template_id_list, list);
});

test('task_detail reads each content block into entries, media, awards and links, keeping what it does not know', async () => {
  const block = (o) => ({ name: '', type: o.type, seq: 0, render_content: JSON.stringify(o) });
  const { lib } = setup({
    'GET /effectcam/v2/effect_task_detail': ok({ title: '征集赛', tags: [] }),
    'GET /effectcam/v2/effect_task_content': ok({
      modules: [
        block({
          type: 9,
          contentBlockName: '任务说明',
          link: { desc: '本文详情', url: 'https://wiki/doc' },
          baseList: [
            { textType: 1, tit: '主题要求', desc: '推荐使用$A$$HREF$https://doc/model$HREF$$TEXT$最新模特图$TEXT$$A$\n做出氛围', source: [{ url: 'https://cdn/a.png', width: 1, height: 1 }, { url: '' }, { url: 'blob:https://admin/x' }] },
            { mediaType: 1, desc: 'AI 贵妃扑蝶', source: [{ url: 'https://cdn/v.mp4' }] },
            { textType: 1 },
          ],
        }),
        block({
          type: 4,
          contentBlockName: '奖项详情',
          awardList: [
            { tit: '最佳爆款奖', desc: '≥ A', people_mode: 'infinite', money: '5000' },
            { tit: '阳光普照奖', desc: 'Top100', people_mode: 'specific', peope: '100', money: '100', money_mode: 'average' },
          ],
        }),
        block({ type: 10, contentBlockName: '推荐工程', recommendProject: { ids: [7408401210929053711n.toString()] } }),
        block({ type: 7, contentBlockName: '平台声明', statement: { link: { url: 'https://effect/article' } } }),
        block({ type: 11, contentBlockName: '新块', votes: [1, 2] }),
      ],
    }),
  });
  const { content } = await lib.taskDetail({ kind: 'task', id: '108116' });
  assert.deepEqual(content, [
    {
      name: '任务说明',
      items: [
        { title: '主题要求', text: '推荐使用最新模特图\n做出氛围', images: ['https://cdn/a.png'], unusable_media: 2, links: [{ text: '最新模特图', url: 'https://doc/model' }] },
        { text: 'AI 贵妃扑蝶', videos: ['https://cdn/v.mp4'] },
      ],
      links: [{ text: '本文详情', url: 'https://wiki/doc' }],
    },
    {
      name: '奖项详情',
      items: [
        { title: '最佳爆款奖', text: '≥ A', money: '5000', money_mode: null, people: 'unlimited' },
        { title: '阳光普照奖', text: 'Top100', money: '100', money_mode: 'average', people: '100' },
      ],
    },
    { name: '推荐工程', project_ids: ['7408401210929053711'] },
    { name: '平台声明', links: [{ text: '平台声明', url: 'https://effect/article' }] },
    { name: '新块', unread: { votes: [1, 2] } },
  ]);
});

test('task_receive posts the receive id as a form field, only for a task waiting to be received', async () => {
  const { lib, to } = setup({ 'POST /creator/v1/receive_task': ok({ designer_task_id: 9001, process_status: 2 }) });
  assert.deepEqual(await lib.taskReceive({ item_id: '108116' }), {
    title: '冷空气网感美妆定向征集赛',
    designer_task_id: '9001',
    status: 'WAIT_SUBMIT',
  });
  const post = to('/creator/v1/receive_task')[0];
  assert.ok(post.body instanceof FormData);
  assert.deepEqual([...post.body.entries()], [['id', '108117']]);
  await assert.rejects(lib.taskReceive({ item_id: '108200' }), /TASK_NOT_RECEIVABLE: 108200 status=WAIT_SUBMIT/);
  await assert.rejects(lib.taskReceive({ item_id: '1' }), /UNKNOWN_TASK: 1/);
  assert.equal(to('/creator/v1/receive_task').length, 1);
});

test('task_receive fails when the server hands back no designer task', async () => {
  const { lib } = setup({ 'POST /creator/v1/receive_task': ok({}) });
  await assert.rejects(lib.taskReceive({ item_id: '108116' }), /RECEIVE_TASK_FAILED: task 108116/);
});

test('rank_list maps filters and one category per level to the rank page query and numbers items from the cursor', async () => {
  const { lib, to } = setup();
  const out = await lib.rankList({
    rank_type: 1,
    date: '2026-11-05',
    categories: ['人像美化', '美妆'],
    levels: ['S', 'A+'],
    panels: ['头饰', '美妆'],
    preferences: ['友友'],
    tools: ['像塑桌面端'],
    young_like_scores: [9, 10],
    cursor: 5,
    count: 2,
  });
  assert.deepEqual(to('/cam_api/rank/v1/detail')[0].query, {
    rank_type: '1',
    date: '2026-11-05',
    cursor: '5',
    count: '2',
    effect_lv: '3,5',
    panel_type: '1,8',
    perf_type: '5',
    tool_type: '1',
    young_like_score: '9,10',
    material_labels3_first: '人像美化',
    material_labels3_second: '美妆',
  });
  assert.deepEqual(to('/cam_api/rank/v1/tag')[0].query, { rank_type: '1', date: '2026-11-05' });
  assert.equal(out.name, '年轻喜爱榜');
  assert.equal(out.updated_at, '2026-11-06 16:32:12');
  assert.deepEqual(out.items[0], {
    rank: 6,
    effect_id: '88649924',
    app_effect_id: '273663451',
    name: '好友对你都有什么想法',
    icon_url: 'https://cdn/r1.png',
    level: 'S',
    is_new: true,
    publish_peak: '56.7万',
    publish_total: '506.6万',
    follow_shoot: 67206,
    follow_shoot_30d: 2047071,
    follow_shoot_60d: null,
    male_rate: '34.84',
    female_rate: '65.16',
    young_like_score: 10,
    male_like_score: 9,
    hot_play_score: 8,
    revenue_total: '71291',
  });
  assert.equal(out.next_cursor, 7);
  assert.equal(out.has_more, true);
  assert.deepEqual(out.categories[0], { name: '基础头饰', level: 2, count: 45 });
});

test('rank_list returns the board categories for that day without a category filter', async () => {
  const { lib, to } = setup();
  const out = await lib.rankList({ rank_type: 2, date: '2026-11-01' });
  assert.deepEqual(to('/cam_api/rank/v1/tag').map((c) => c.query), [{ rank_type: '2', date: '2026-11-01' }]);
  assert.deepEqual(out.categories.map((c) => c.name), ['基础头饰', '美妆', '人像美化', '游戏玩法', '怪奇']);
});

test('rank_list reads the template board from its templates list', async () => {
  const { lib } = setup({
    'GET /cam_api/rank/v1/detail': ok({
      cursor: 1,
      total: 1,
      date: '2026-11-06',
      templates: [{ app_effect_id: '7700473516407210024', effect_name: 'AI 复古氛围', all_pub_val: '9.5万', total_rev: '3526', effect_id: '90489844' }],
    }),
  });
  const out = await lib.rankList({ rank_type: 9 });
  assert.equal(out.name, '模板每日投稿榜');
  assert.deepEqual(
    { id: out.items[0].app_effect_id, name: out.items[0].name, rev: out.items[0].revenue_total, more: out.has_more },
    { id: '7700473516407210024', name: 'AI 复古氛围', rev: '3526', more: false },
  );
});

test('rank_list rejects unknown boards, filter labels, categories and dates before asking for the board', async () => {
  const { lib, to } = setup();
  await assert.rejects(lib.rankList({ rank_type: 5 }), /INVALID_RANK_TYPE: 5/);
  await assert.rejects(lib.rankList({ levels: ['S+'] }), /INVALID_FILTER\(levels\): S\+; valid: SSS, SS, S/);
  await assert.rejects(lib.rankList({ tools: ['剪映'] }), /INVALID_FILTER\(tools\): 剪映/);
  await assert.rejects(lib.rankList({ young_like_scores: [11] }), /INVALID_FILTER\(young_like_scores\): 11/);
  await assert.rejects(lib.rankList({ date: '2026/11/05' }), /INVALID_DATE/);
  await assert.rejects(lib.rankList({ categories: ['宠物'] }), /INVALID_CATEGORY: 宠物; valid: 基础头饰, 美妆, 人像美化, 游戏玩法, 怪奇/);
  await assert.rejects(lib.rankList({ categories: ['怪奇'] }), /UNSUPPORTED_CATEGORY_LEVEL: 怪奇 has level 4/);
  await assert.rejects(lib.rankList({ categories: ['人像美化', '游戏玩法'] }), /ONE_CATEGORY_PER_LEVEL: 人像美化 and 游戏玩法 are both level 1/);
  assert.equal(to('/cam_api/rank/v1/detail').length, 0);
});

test('rank_hotspots ranks hotspots by position, not rank_num, reads the board whole and pages it here', async () => {
  const { lib, to } = setup();
  const out = await lib.rankHotspots({});
  assert.deepEqual(to('/cam_api/hotspot/v1/rank')[0].query, {});
  assert.deepEqual({ total: out.total, next: out.next_offset, more: out.has_more }, { total: 2, next: 20, more: false });
  assert.equal(out.rank_time, '2026-11-06 15');
  assert.deepEqual(out.items[0], {
    rank: 1,
    topic_id: '13439',
    title: '原来深秋是咕嘟的',
    description: '深秋咕嘟暖感强',
    heat: 19727126,
    heat_text: '1972.7万热度',
    inspirations_text: '69条创作灵感',
    cover_url: 'https://cdn/h1.png',
  });
  assert.deepEqual(
    out.items.map((i) => [i.rank, i.cover_url]),
    [
      [1, 'https://cdn/h1.png'],
      [2, null],
    ],
  );
  const page = await lib.rankHotspots({ offset: 1, count: 1 });
  assert.deepEqual({ ranks: page.items.map((i) => i.rank), next: page.next_offset, more: page.has_more }, { ranks: [2], next: 2, more: false });
  const first = await lib.rankHotspots({ count: 1 });
  assert.deepEqual({ ranks: first.items.map((i) => i.rank), more: first.has_more }, { ranks: [1], more: true });
  assert.deepEqual(to('/cam_api/hotspot/v1/rank')[2].query, {});
});

test('rank_subjects pages the effect and template boards by offset, and rank_subject_detail reads one board in full', async () => {
  const { lib, to } = setup();
  const first = await lib.rankSubjects({});
  assert.deepEqual(to('/cam_api/discover/v1/subjects')[0].query, { cursor: '0', count: '20', type: '1' });
  assert.deepEqual(first.subjects[0], {
    subject_id: '261',
    name: '测一测玩法特效榜 - 0期',
    subtitle: '本月测一测爆款',
    online_at: new Date(1793772002000).toISOString(),
    views: 5120,
    cover_url: 'https://cdn/s.png',
    effects: [{ effect_id: '90154479', app_effect_id: '278949852', name: '11月你会发生什么', icon_url: 'https://cdn/e.png', description: '' }],
  });
  assert.deepEqual({ n: first.subjects.length, total: first.total, next: first.next_cursor, more: first.has_more }, { n: 20, total: 23, next: 20, more: true });
  const last = await lib.rankSubjects({ cursor: 20 });
  assert.deepEqual({ n: last.subjects.length, next: last.next_cursor, more: last.has_more }, { n: 3, next: 23, more: false });
  const past = await lib.rankSubjects({ cursor: 40 });
  assert.deepEqual({ n: past.subjects.length, total: past.total, more: past.has_more }, { n: 0, total: null, more: false });
  const templates = await lib.rankSubjects({ kind: 'template' });
  assert.equal(to('/cam_api/discover/v1/subjects').at(-1).query.type, '2');
  assert.equal(templates.subjects[0].effects[0].app_effect_id, '7529884834588590134');
  const one = await lib.rankSubjectDetail({ subject_id: '261' });
  assert.deepEqual(to('/cam_api/discover/v1/subject_detail')[0].query, { subject_id: '261', cursor: '0', count: '20' });
  assert.equal(one.name, '测一测玩法特效榜 - 11月');
  await assert.rejects(lib.rankSubjects({ kind: 'emoji' }), /INVALID_KIND: emoji; valid: effect, template/);
  await assert.rejects(lib.rankSubjectDetail({}), /INVALID_SUBJECT_ID/);
  assert.equal(to('/cam_api/discover/v1/subject_detail').length, 1);
});

test('rank_subjects_search reads every page of a kind and matches board names', async () => {
  const { lib, to } = setup();
  const out = await lib.rankSubjectsSearch({ keyword: ' 美妆 ' });
  assert.deepEqual(to('/cam_api/discover/v1/subjects').map((c) => c.query.cursor), ['0', '20']);
  assert.deepEqual({ kw: out.keyword, total: out.total, names: out.subjects.map((s) => s.name) }, { kw: '美妆', total: 1, names: ['热爆美妆特效榜 - 3月'] });
  const tpl = await lib.rankSubjectsSearch({ kind: 'template', keyword: '歌词' });
  assert.deepEqual(tpl.subjects.map((s) => s.subject_id), ['204']);
  await assert.rejects(lib.rankSubjectsSearch({ keyword: '  ' }), /INVALID_KEYWORD/);
  await assert.rejects(lib.rankSubjectsSearch({}), /INVALID_KEYWORD/);
  await assert.rejects(lib.rankSubjectsSearch({ kind: 'emoji', keyword: '美妆' }), /INVALID_KIND: emoji; valid: effect, template/);
});

test('rank_creators converts the award to yuan', async () => {
  const { lib } = setup();
  assert.deepEqual((await lib.rankCreators()).items[0], {
    rank: 1,
    uid: '7495234997042594875',
    name: '征蓬落日圆',
    avatar_url: 'https://cdn/u.png',
    material_count: 1,
    follow_shoot: 12972,
    follow_shoot_text: '1.2万',
    award_text: '预计奖3000元',
    award_yuan: 3000,
  });
});

test('rank_creators pages the creator board, which arrives whole', async () => {
  const users = [1, 2, 3].map((n) => `{"rank_no":${n},"uid":749523499704259487${n},"username":"u${n}"}`).join(',');
  const { lib, to } = setup({ 'GET /cam_api/innovation_plan/v1/user_month_rank': `{"code":0,"data":[${users}]}` });
  const first = await lib.rankCreators({ count: 2 });
  assert.deepEqual({ ranks: first.items.map((u) => u.rank), total: first.total, next: first.next_offset, more: first.has_more }, { ranks: [1, 2], total: 3, next: 2, more: true });
  const last = await lib.rankCreators({ offset: 2, count: 2 });
  assert.deepEqual({ ranks: last.items.map((u) => u.rank), uid: last.items[0].uid, more: last.has_more }, { ranks: [3], uid: '7495234997042594873', more: false });
  assert.equal(to('/cam_api/innovation_plan/v1/rank_list').length, 0);
});

test('rank_innovation picks ask for the artwork type and page by the requested size', async () => {
  const { lib, to } = setup();
  const out = await lib.rankInnovation({ offset: 20, count: 20 });
  assert.deepEqual(to('/cam_api/innovation_plan/v1/rank_list')[0].query, { page_size: '20', offset: '20', tab_id: 'all', artwork_type: '2' });
  assert.deepEqual(out.items[0], {
    effect_id: '91518554',
    app_effect_id: '7703570232371232802',
    name: '用这首歌官宣好朋友',
    icon_url: 'https://cdn/p.png',
    labels: ['音频配文'],
    publish_count: '5741',
    revenue_total: '67.54',
    reviewed_on: '2026-11-03',
    cover_url: 'https://cdn/pc.jpeg',
    video_item_id: '7704341495155455739',
  });
  assert.deepEqual({ next: out.next_offset, more: out.has_more, total: out.total }, { next: 40, more: true, total: 249 });
  await lib.rankInnovation({ kind: 'effect' });
  assert.equal(to('/cam_api/innovation_plan/v1/rank_list')[1].query.artwork_type, '0');
  await assert.rejects(lib.rankInnovation({ kind: 'emoji' }), /INVALID_KIND: emoji; valid: template, effect/);
  await assert.rejects(lib.rankInnovation({ kind: 'creators' }), /INVALID_KIND: creators; valid: template, effect/);
  assert.equal(to('/cam_api/innovation_plan/v1/user_month_rank').length, 0);
});

test('rank_innovation lists an effect the page carries twice once, with both labels', async () => {
  const pick = (label) => ({ effect_id_str: '91518554', app_effect_id_str: '1', name: '官宣', label });
  const { lib } = setup({ 'GET /cam_api/innovation_plan/v1/rank_list': ok({ effect_list: [pick('音频配文'), { ...pick('AI'), effect_id_str: '2' }, pick('热歌')], total: 3, has_more: false }) });
  const out = await lib.rankInnovation({});
  assert.deepEqual(out.items.map((e) => [e.effect_id, e.labels]), [['91518554', ['音频配文', '热歌']], ['2', ['AI']]]);
});

test('community calls refuse without sending anything when the editor modules are missing', async () => {
  const { lib, calls, modules } = setup();
  delete modules[M.bizUtils].PlatformUtils;
  assert.deepEqual(lib.selfCheck('community').missing, [`${M.bizUtils} :: PlatformUtils.genSignData`]);
  await assert.rejects(lib.inspirationNav(), /INCOMPATIBLE_EDITOR/);
  await assert.rejects(lib.rankList({}), /INCOMPATIBLE_EDITOR/);
  assert.equal(calls.length, 0);
});

// Trimmed from the account's real 作品 list and review records (2026-11-07).
const ART_FAILED = {
  id: '92139627',
  name: '我和codex三天',
  icon: 'https://cdn/a2.png',
  effect_status: 101,
  effect_status_desc: '审核未通过',
  b_task: '玩法孵化之热梗语录定向征集',
  b_hot: '',
  b_ins: '【创新】【热梗语录】我和codex三天',
  can_delete: true,
  can_edit: true,
  can_appeal: true,
  appeal_types: [{ appeal_type: 0, appeal_type_text: '作品审核不通过' }],
  created_at: '1794049306000',
};
const ART_REVIEWING = { id: '92146750', name: '把手握紧什么都没有', effect_status: 100, effect_status_desc: '审核中', b_task: '', b_hot: '', b_ins: '', can_delete: true, can_edit: false, can_appeal: false, appeal_types: [], created_at: '1794053427000' };
const ART_ONLINE = {
  id: '92032977',
  name: '灭建国是谁呀',
  effect_status: 103,
  effect_status_desc: '已上线',
  app_effect_id: 286017094,
  app_effect_id_str: '286017094',
  first_online_at: '1794012899000',
  pub_num: '0',
  can_appeal: false,
  appeal_types: [],
  created_at: '1793981766000',
};
const REVIEWS = [
  {
    title: '审核未通过',
    detail_desc: '特效未通过审核,原因如下：\n|<b>特效不符合规范<b>|\n特效中可能含有涉及展示或宣扬不同群体攻击对立类内容。\n\n未通过特效可直接编辑修改后重新提交，过审速度更快',
    created_at: 1794052023000,
  },
  { title: '提交成功', detail_desc: '', created_at: 1794049308000 },
  { title: '审核中', detail_desc: '特效已进入审核流程，预计1个工作日内完成，点击了解更多|<a><href>https://effect.douyin.com/content/3z7xbu37/ojv9vjeb<href>审核规则<a>|', created_at: 1794049308000 },
];
const REJECTED_TEXT = '特效未通过审核,原因如下：\n特效不符合规范\n特效中可能含有涉及展示或宣扬不同群体攻击对立类内容。\n\n未通过特效可直接编辑修改后重新提交，过审速度更快';
// review_nodes answered code 0 without data for every real effect tried; the page then reads effect_reviews.
const NO_NODES = JSON.stringify({ code: 0, message: 'success' });
const artworks = (effects, sort = '["2026-11-07T19:01:46.000Z",92139627]') => ok({ sort, count: effects.length, total: 5, effects });

test('effects_mine pages by the returned sort key and attaches the latest review to failed effects only', async () => {
  const { lib, to } = setup({
    'GET /effectcam/v1/artworks': (call) => artworks(call.query.sort ? [ART_ONLINE] : [ART_REVIEWING, ART_FAILED]),
    'GET /cam_api/effect/v1/review_nodes': NO_NODES,
    'GET /effectcam/v1/effect_reviews': ok(REVIEWS),
  });
  const first = await lib.myEffects({ count: 2 });
  assert.deepEqual(to('/effectcam/v1/artworks')[0].query, { count: '2' });
  assert.deepEqual(first.items[1], {
    effect_id: '92139627',
    name: '我和codex三天',
    status: 101,
    status_text: '审核未通过',
    created_at: new Date(1794049306000).toISOString(),
    online_at: null,
    app_effect_id: null,
    task: '玩法孵化之热梗语录定向征集',
    inspiration: '【创新】【热梗语录】我和codex三天',
    hotspot: null,
    can_edit: true,
    can_delete: true,
    can_appeal: true,
    appeal_types: ['作品审核不通过'],
    publish_count: null,
    icon_url: 'https://cdn/a2.png',
    review: { title: '审核未通过', at: new Date(1794052023000).toISOString(), text: REJECTED_TEXT, refuse_reasons: [], links: [] },
  });
  assert.equal('review' in first.items[0], false);
  assert.deepEqual(to('/cam_api/effect/v1/review_nodes').map((c) => c.query), [{ effect_id: '92139627', review_type: '1' }]);
  assert.deepEqual(to('/effectcam/v1/effect_reviews').map((c) => c.query), [{ effect_id: '92139627' }]);
  assert.deepEqual({ total: first.total, next: first.next_cursor, more: first.has_more }, { total: 5, next: '["2026-11-07T19:01:46.000Z",92139627]', more: true });
  const last = await lib.myEffects({ cursor: first.next_cursor, count: 2 });
  assert.deepEqual(to('/effectcam/v1/artworks')[1].query, { count: '2', sort: '["2026-11-07T19:01:46.000Z",92139627]' });
  assert.deepEqual(last.items[0], {
    effect_id: '92032977',
    name: '灭建国是谁呀',
    status: 103,
    status_text: '已上线',
    created_at: new Date(1793981766000).toISOString(),
    online_at: new Date(1794012899000).toISOString(),
    app_effect_id: '286017094',
    task: null,
    inspiration: null,
    hotspot: null,
    can_edit: false,
    can_delete: false,
    can_appeal: false,
    appeal_types: [],
    publish_count: '0',
    icon_url: null,
  });
  assert.deepEqual({ next: last.next_cursor, more: last.has_more }, { next: null, more: false });
  assert.equal(to('/effectcam/v1/effect_reviews').length, 1);
});

test('effects_mine reads reviews for test and appeal failures too, from review_nodes when it has records', async () => {
  const { lib, to } = setup({
    'GET /effectcam/v1/artworks': artworks([
      { ...ART_FAILED, id: '1', effect_status: 112 },
      { ...ART_FAILED, id: '2', effect_status: 119 },
      { ...ART_FAILED, id: '3', effect_status: 118 },
    ]),
    'GET /cam_api/effect/v1/review_nodes': (call) => ok([{ title: `节点${call.query.effect_id}`, detail_desc: '', created_at: 5 }]),
  });
  const out = await lib.myEffects({});
  assert.deepEqual(out.items.map((i) => i.review && i.review.title), ['节点1', '节点2', undefined]);
  assert.deepEqual({ next: out.next_cursor, more: out.has_more }, { next: null, more: false });
  assert.deepEqual(to('/effectcam/v1/artworks')[0].query, { count: '20' });
  assert.equal(to('/cam_api/effect/v1/review_nodes').length, 2);
});

test('online reviews fall back to effect_reviews when review_nodes fails, and fail on unreadable records', async () => {
  const fallback = setup({
    'GET /effectcam/v1/artworks': artworks([ART_FAILED]),
    'GET /cam_api/effect/v1/review_nodes': JSON.stringify({ code: 400, message: '参数错误' }),
    'GET /effectcam/v1/effect_reviews': ok(REVIEWS),
  });
  assert.equal((await fallback.lib.myEffects({})).items[0].review.text, REJECTED_TEXT);
  const down = setup({
    'GET /effectcam/v1/artworks': artworks([ART_FAILED]),
    'GET /cam_api/effect/v1/review_nodes': NO_NODES,
    'GET /effectcam/v1/effect_reviews': JSON.stringify({ code: 500, message: '内部错误' }),
  });
  await assert.rejects(down.lib.myEffects({}), /GET_EFFECT_REVIEWS_FAILED: code=500 message=内部错误/);
  const odd = setup({
    'GET /effectcam/v1/artworks': artworks([ART_FAILED]),
    'GET /cam_api/effect/v1/review_nodes': ok({ nodes: [] }),
  });
  await assert.rejects(odd.lib.myEffects({}), /GET_REVIEW_NODES_FAILED: expected a list of review records/);
});

test('effect_reviews returns both review timelines with the markup read like the review record page', async () => {
  // The refuse_reason shape comes from the review record page's code; no real effect carried one yet.
  const reasons = {
    title: '审核未通过',
    detail_desc: '',
    created_at: 1794052023000,
    refuse_reason: [{ title: '画面问题', content: ['贴纸遮挡五官', '文字过小'], detail: '修改后可|<mark>重新提交<mark>||<br>详见|<a><href>https://x/rule<href>规则<a>|' }],
  };
  const { lib, to } = setup({
    'GET /effectcam/v2/effect_detail': ok({ base: { id: '92139627', name: '我和codex三天', effect_status: 101, effect_status_desc: '审核未通过' }, extra: { b_task: '玩法孵化之热梗语录定向征集' } }),
    'GET /cam_api/effect/v1/review_nodes': (call) => (call.query.review_type === '2' ? ok([reasons]) : NO_NODES),
    'GET /effectcam/v1/effect_reviews': ok(REVIEWS),
  });
  const out = await lib.myEffectReviews({ effect_id: ' 92139627 ' });
  assert.deepEqual(to('/effectcam/v2/effect_detail')[0].query, { effect_id: '92139627' });
  assert.deepEqual(to('/cam_api/effect/v1/review_nodes').map((c) => c.query.review_type).sort(), ['1', '2']);
  assert.deepEqual({ name: out.name, status: out.status, status_text: out.status_text, task: out.task }, { name: '我和codex三天', status: 101, status_text: '审核未通过', task: '玩法孵化之热梗语录定向征集' });
  assert.deepEqual(out.reviews.map((r) => r.title), ['审核未通过', '提交成功', '审核中']);
  assert.deepEqual(out.reviews[2], {
    title: '审核中',
    at: new Date(1794049308000).toISOString(),
    text: '特效已进入审核流程，预计1个工作日内完成，点击了解更多审核规则',
    refuse_reasons: [],
    links: [{ text: '审核规则', url: 'https://effect.douyin.com/content/3z7xbu37/ojv9vjeb' }],
  });
  assert.deepEqual(out.innovation_reviews, [
    {
      title: '审核未通过',
      at: new Date(1794052023000).toISOString(),
      text: '',
      refuse_reasons: [{ title: '画面问题', items: ['贴纸遮挡五官', '文字过小'], detail: '修改后可重新提交\n详见规则' }],
      links: [{ text: '规则', url: 'https://x/rule' }],
    },
  ]);
});

test('effect_reviews rejects blank ids and passes on the refusal for effects of other accounts', async () => {
  // The real answer for another account's effect and for an unknown id (2026-11-07).
  const refused = JSON.stringify({ code: 1301, message: '参数不正确，请正确访问' });
  const { lib, calls } = setup({
    'GET /effectcam/v2/effect_detail': refused,
    'GET /cam_api/effect/v1/review_nodes': refused,
    'GET /effectcam/v1/effect_reviews': refused,
  });
  await assert.rejects(lib.myEffectReviews({ effect_id: ' ' }), /INVALID_EFFECT_ID/);
  assert.equal(calls.length, 0);
  await assert.rejects(lib.myEffectReviews({ effect_id: '88649924' }), /code=1301 message=参数不正确，请正确访问/);
});

async function connect(deps) {
  const official = { url: 'x', listTools: async () => [], status: () => ({}), callJson: async () => ({ instances: [] }) };
  const server = createServer({ frontApp: async () => null, activateApp: async () => { throw Error('activateApp called in a test'); }, official, ...deps });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG_BYTES = Buffer.from('ffd8ffe000104a464946', 'hex');

// A hotspot whose inspirations come back from fake detail calls, with images served by a fake fetch.
function imageHarness({ items, details, images, tabs = ['全部'] }) {
  const calls = { detail: [], fetch: [], scheduled: [] };
  const dirs = [];
  const deps = {
    listInstances: () => [{ pid: 7 }],
    callPlugin: async (method, params) => {
      if (method === 'hotspot_inspirations') return { topic_id: params.topic_id, tabs, items };
      if (method !== 'inspiration_detail') throw Error(`unexpected ${method}`);
      calls.detail.push(params.inspiration_id);
      return details(params.inspiration_id);
    },
    fetchImageBytes: async (url, opts) => {
      calls.fetch.push({ url, opts });
      return images(url, calls.fetch.filter((c) => c.url === url).length);
    },
    inspirationImagesDir: () => (dirs.push(tmpdir('xs-insp-img-')), dirs.at(-1)),
    schedule: (fn, ms) => calls.scheduled.push({ fn, ms }),
  };
  return { deps, calls, dirs };
}

test('hotspot_inspiration_images saves every detail image once per inspiration, retries a failed image once and lists what failed', async () => {
  const { deps, calls, dirs } = imageHarness({
    tabs: ['全部', '妆容'],
    items: [
      { tab: '全部', inspiration_id: '1', title: '北风/暴击:妆', cover_url: 'https://c/1.png' },
      { tab: '全部', inspiration_id: '2', title: '水管防冻抢修' },
      { tab: '全部', inspiration_id: '3', title: '寒潮预警妆' },
      { tab: '妆容', inspiration_id: '1', title: '北风/暴击:妆' },
      { tab: '妆容', inspiration_id: '4', title: '冷风' },
    ],
    details: (id) => {
      if (id === '2') throw Error('GET_INSPIRATION_FAILED: code=3000');
      return { images: { 1: ['https://c/1a', 'https://c/1b'], 3: ['https://c/3'], 4: ['https://c/4'] }[id] };
    },
    images: (url, nth) => {
      if (url === 'https://c/1a') return { buf: PNG_BYTES, mimeType: 'image/png' };
      if (url === 'https://c/1b') return { buf: JPEG_BYTES, mimeType: 'image/jpeg' };
      if (url === 'https://c/3' && nth > 1) return { buf: JPEG_BYTES, mimeType: 'image/jpeg' };
      throw Error(`HTTP 50${nth}`);
    },
  });
  const client = await connect(deps);
  const res = await client.callTool({ name: 'hotspot_inspiration_images', arguments: { topic_id: '13635' } });
  assert.equal(res.isError, undefined, res.content[0].text);
  const out = JSON.parse(res.content[0].text);
  const [dir] = dirs;
  assert.equal(out.dir, dir);
  assert.deepEqual(calls.detail.sort(), ['1', '2', '3', '4']);
  assert.deepEqual(
    { ...out, expires_at: typeof out.expires_at },
    {
      topic_id: '13635',
      tab: null,
      dir,
      index_file: path.join(dir, 'index.json'),
      expires_at: 'string',
      inspirations: 4,
      images_saved: 3,
      items: [
        { inspiration_id: '1', title: '北风/暴击:妆', files: ['1-北风_暴击_妆-1.png', '1-北风_暴击_妆-2.jpg'] },
        { inspiration_id: '2', title: '水管防冻抢修', files: [] },
        { inspiration_id: '3', title: '寒潮预警妆', files: ['3-寒潮预警妆-1.jpg'] },
        { inspiration_id: '4', title: '冷风', files: [] },
      ],
      failed: [
        { inspiration_id: '2', title: '水管防冻抢修', errors: ['detail: GET_INSPIRATION_FAILED: code=3000'] },
        { inspiration_id: '4', title: '冷风', errors: ['image 1: HTTP 502'] },
      ],
    },
  );
  assert.ok(Math.abs(Date.parse(out.expires_at) - Date.now() - 24 * 3600000) < 60000);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['1-北风_暴击_妆-1.png', '1-北风_暴击_妆-2.jpg', '3-寒潮预警妆-1.jpg', 'index.json']);
  assert.deepEqual(fs.readFileSync(path.join(dir, '1-北风_暴击_妆-1.png')), PNG_BYTES);
  assert.deepEqual(fs.readFileSync(path.join(dir, '3-寒潮预警妆-1.jpg')), JPEG_BYTES);
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.deepEqual(index.items[0], { inspiration_id: '1', title: '北风/暴击:妆', tab: '全部', files: [{ file: '1-北风_暴击_妆-1.png', url: 'https://c/1a' }, { file: '1-北风_暴击_妆-2.jpg', url: 'https://c/1b' }], errors: [] });
  assert.deepEqual(calls.fetch.filter((c) => c.url === 'https://c/3').length, 2);
  assert.deepEqual(calls.fetch.filter((c) => c.url === 'https://c/4').length, 2);
  assert.ok(calls.fetch.every((c) => c.opts.timeoutMs === 30000));
  assert.deepEqual(calls.scheduled.map((s) => s.ms), [24 * 3600000]);
  calls.scheduled[0].fn();
  assert.equal(fs.existsSync(dir), false);
});

test('hotspot_inspiration_images reads details six at a time and numbers files in hotspot order', async () => {
  let running = 0;
  let peak = 0;
  const items = Array.from({ length: 14 }, (_, i) => ({ tab: '全部', inspiration_id: String(i + 1), title: `灵感${i + 1}` }));
  const { deps, dirs } = imageHarness({
    items,
    details: async (id) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 30 - Number(id)));
      running--;
      return { images: [`https://c/${id}`] };
    },
    images: () => ({ buf: JPEG_BYTES, mimeType: 'image/jpeg' }),
  });
  const client = await connect(deps);
  const out = JSON.parse((await client.callTool({ name: 'hotspot_inspiration_images', arguments: { topic_id: '1' } })).content[0].text);
  assert.equal(peak, 6);
  assert.deepEqual(out.items.map((i) => i.files[0]), items.map((it, i) => `${String(i + 1).padStart(2, '0')}-灵感${i + 1}-1.jpg`));
  assert.equal(fs.readdirSync(dirs[0]).length, 15);
});

test('hotspot_inspiration_images takes one tab, refuses an unknown tab, and fails when nothing was saved', async () => {
  const items = [
    { tab: '全部', inspiration_id: '1', title: 'a' },
    { tab: '妆容', inspiration_id: '2', title: 'b' },
    { tab: '妆容', inspiration_id: '3', title: 'c' },
  ];
  const ok = imageHarness({ tabs: ['全部', '妆容'], items, details: (id) => ({ images: [`https://c/${id}`] }), images: () => ({ buf: PNG_BYTES, mimeType: 'image/png' }) });
  const client = await connect(ok.deps);
  const out = JSON.parse((await client.callTool({ name: 'hotspot_inspiration_images', arguments: { topic_id: '1', tab: '妆容' } })).content[0].text);
  assert.equal(out.tab, '妆容');
  assert.deepEqual(out.items.map((i) => i.files), [['1-b-1.png'], ['2-c-1.png']]);
  assert.deepEqual(ok.calls.detail.sort(), ['2', '3']);
  const bad = await client.callTool({ name: 'hotspot_inspiration_images', arguments: { topic_id: '1', tab: '宠物' } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /INVALID_TAB: 宠物; valid: 全部, 妆容/);
  assert.equal(ok.calls.detail.length, 2);

  const none = imageHarness({ items, details: () => ({ images: [] }), images: () => assert.fail('nothing to fetch') });
  const res = await (await connect(none.deps)).callTool({ name: 'hotspot_inspiration_images', arguments: { topic_id: '1' } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /NO_IMAGES_SAVED: .*detail: no images/);
  const empty = imageHarness({ items: [], details: () => assert.fail('no details'), images: () => assert.fail('nothing to fetch') });
  const res2 = await (await connect(empty.deps)).callTool({ name: 'hotspot_inspiration_images', arguments: { topic_id: '9' } });
  assert.match(res2.content[0].text, /NO_INSPIRATIONS: hotspot 9 lists no inspirations/);
  assert.equal(empty.dirs.length, 0);
});

test('community tools use the lowest-pid window; lists hand out refs and details keep addresses, nothing fetched', async () => {
  const seen = [];
  const answers = {
    inspiration_list: { items: [{ inspiration_id: '1', title: '鎏花入镜', cover_url: 'https://c/1.png' }] },
    inspiration_collected: { total: 1, items: [{ inspiration_id: '5', title: '冻伤妆', cover_url: 'https://c/5.png' }], next_cursor: 1, has_more: false },
    inspiration_detail: { inspiration_id: '2', title: '锦鲤妆', images: ['https://c/2.png', 'https://c/2b.png'] },
    hotspot_inspirations: { topic_id: '13439', tabs: ['全部'], items: [{ tab: '全部', inspiration_id: '3', title: '咕嘟', cover_url: null }] },
    growth_tasks_list: { items: [{ task_id: 'g' }] },
    growth_task_detail: { inspirations: [{ inspiration_id: '4', title: '重返2018', cover_url: 'https://c/4.png' }] },
    rank_list: { items: [] },
  };
  const client = await connect({
    listInstances: () => [{ pid: 300 }, { pid: 200 }],
    callPlugin: async (method, params, opts) => (seen.push({ method, params, opts }), answers[method]),
    fetchImage: async () => assert.fail('no image may be fetched'),
  });
  const json = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.content.length, 1, name);
    return JSON.parse(res.content[0].text);
  };
  await json('rank_list', { rank_type: 2, levels: ['S'], count: 5 });
  assert.deepEqual(seen[0], { method: 'rank_list', params: { rank_type: 2, levels: ['S'], count: 5 }, opts: { pid: 200 } });
  const list = await json('inspiration_list', { project_path: '/proj/X' });
  assert.deepEqual(list, { items: [{ inspiration_id: '1', title: '鎏花入镜', cover_ref: 'img:1' }] });
  assert.deepEqual(seen[1].opts, { projectPath: '/proj/X' });
  assert.deepEqual(await json('inspiration_detail', { inspiration_id: '2' }), answers.inspiration_detail);
  assert.deepEqual(await json('hotspot_inspirations', { topic_id: '13439' }), { topic_id: '13439', tabs: ['全部'], total: 1, items: [{ tab: '全部', inspiration_id: '3', title: '咕嘟', cover_ref: null }], next_offset: 20, has_more: false });
  await json('growth_tasks_list', {});
  assert.deepEqual(await json('growth_task_detail', { task_id: 'g' }), { task_id: 'g', inspirations: [{ inspiration_id: '4', title: '重返2018', cover_ref: 'img:2' }] });
  assert.equal((await json('inspiration_list', {})).items[0].cover_ref, 'img:1');
  assert.deepEqual(await json('inspiration_collected', { cursor: 20, count: 50 }), { total: 1, items: [{ inspiration_id: '5', title: '冻伤妆', cover_ref: 'img:3' }], next_cursor: 1, has_more: false });
  assert.deepEqual(seen.at(-1), { method: 'inspiration_collected', params: { cursor: 20, count: 50 }, opts: { pid: 200 } });
  assert.equal((await client.callTool({ name: 'inspiration_collected', arguments: { count: 51 } })).isError, true);
  for (const name of ['rank_list', 'rank_subjects']) {
    const tooMany = await client.callTool({ name, arguments: { count: 21 } });
    assert.equal(tooMany.isError, true, name);
  }
  // The creator board has its own tool now.
  assert.equal((await client.callTool({ name: 'rank_innovation', arguments: { kind: 'creators' } })).isError, true);
  assert.equal(seen.filter((x) => x.method === 'rank_innovation').length, 0);
});

test('tasks_list pages what it keeps whole, and every listed task stays usable for task_detail', async () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ task_id: String(100 + i), kind: 'task', icon_url: `https://c/${i}.png` }));
  const seen = [];
  const client = await connect({
    listInstances: () => [{ pid: 7 }],
    callPlugin: async (method, params) => {
      seen.push({ method, params });
      if (method === 'tasks_list') return { items, raw: items.map((t) => ({ kind: 'task', item_id: t.task_id, extra: null })) };
      return { title: 't', content: [] };
    },
  });
  const page = async (args) => JSON.parse((await client.callTool({ name: 'tasks_list', arguments: args })).content[0].text);
  const first = await page({});
  assert.deepEqual(seen[0].params, {});
  assert.deepEqual({ n: first.items.length, total: first.total, next: first.next_offset, more: first.has_more, ref: first.items[0].icon_ref }, { n: 20, total: 25, next: 20, more: true, ref: 'img:1' });
  const last = await page({ offset: 20 });
  assert.deepEqual({ ids: last.items.map((t) => t.task_id), more: last.has_more }, { ids: ['120', '121', '122', '123', '124'], more: false });
  await client.callTool({ name: 'tasks_list', arguments: {} });
  const detail = await client.callTool({ name: 'task_detail', arguments: { task_id: '124' } });
  assert.equal(detail.isError, undefined, detail.content[0].text);
  assert.deepEqual(seen.at(-1).params, { id: '124' });
});

test('task_detail keeps the raw answer out of the reply and writes it only when save_to is given', async () => {
  const raw = { detail: { title: 't', template_id_list: '[]' }, content: [{ type: 3, demandList: [] }] };
  const client = await connect({
    listInstances: () => [{ pid: 7 }],
    callPlugin: async (method) =>
      method === 'tasks_list' ? { kind: 'effect', items: [{ task_id: '108117', kind: 'task' }], raw: [{ kind: 'task', item_id: '108116', extra: null }] } : { kind: 'task', title: 't', content: [{ name: '参与要求', items: [{ images: ['https://c/a.png'] }] }], raw },
  });
  await client.callTool({ name: 'tasks_list', arguments: {} });
  const plain = JSON.parse((await client.callTool({ name: 'task_detail', arguments: { task_id: '108117' } })).content[0].text);
  assert.deepEqual(plain, { task_id: '108117', kind: 'task', title: 't', content: [{ name: '参与要求', items: [{ image_refs: ['img:1'] }] }] });
  const dir = tmpdir('task-raw');
  const saved = JSON.parse((await client.callTool({ name: 'task_detail', arguments: { task_id: '108117', save_to: dir } })).content[0].text);
  assert.equal(saved.raw_saved_to, path.join(dir, 'task_detail-108117.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(saved.raw_saved_to, 'utf8')), raw);
  assert.equal(saved.raw, undefined);
  const relative = await client.callTool({ name: 'task_detail', arguments: { task_id: '108117', save_to: 'out' } });
  assert.match(relative.content[0].text, /SAVE_TO_NOT_ABSOLUTE: out/);
});

test('task tools take the task_id of their own list and hand the plugin the id it needs', async () => {
  const seen = [];
  const lists = {
    tasks_list: {
      items: [
        { task_id: 'A1', kind: 'activity' },
        { task_id: '108117', kind: 'task' },
      ],
      raw: [
        { kind: 'activity', item_id: null, extra: { activity_id: 'A1' } },
        { kind: 'task', item_id: '108116', extra: null },
      ],
    },
    growth_tasks_list: { items: [{ task_id: 'headdress_decoration' }] },
  };
  const client = await connect({
    listInstances: () => [{ pid: 7 }],
    callPlugin: async (method, params, opts) => {
      seen.push({ method, params, opts });
      if (lists[method]) return lists[method];
      if (method === 'task_detail' || method === 'growth_task_detail') return { title: 't' };
      if (method === 'task_receive') return { title: 't', designer_task_id: '9001', status: 'WAIT_SUBMIT' };
      throw Error(`unexpected ${method}`);
    },
  });
  const call = async (name, args) => client.callTool({ name, arguments: args });
  // A task_id this session has not listed yet (say from my_task_status) reads the task list first.
  const detail = JSON.parse((await call('task_detail', { task_id: '108117' })).content[0].text);
  assert.deepEqual(seen.map((s) => [s.method, s.params]), [['tasks_list', {}], ['task_detail', { id: '108116' }]]);
  assert.deepEqual(seen.at(-1), { method: 'task_detail', params: { id: '108116' }, opts: { pid: 7 } });
  assert.equal(detail.task_id, '108117');
  assert.match((await call('growth_task_detail', { task_id: 'headdress_decoration' })).content[0].text, /UNKNOWN_GROWTH_TASK: headdress_decoration; call growth_tasks_list first/);
  const list = JSON.parse((await call('tasks_list', {})).content[0].text);
  assert.equal(list.raw, undefined);
  await call('growth_tasks_list', {});
  assert.deepEqual(JSON.parse((await call('growth_task_detail', { task_id: 'headdress_decoration' })).content[0].text), { task_id: 'headdress_decoration', title: 't' });
  assert.deepEqual(seen.at(-1), { method: 'growth_task_detail', params: { id: 'headdress_decoration' }, opts: { pid: 7 } });
  assert.match((await call('task_detail', { task_id: 'headdress_decoration' })).content[0].text, /UNKNOWN_TASK: headdress_decoration/);
  assert.match((await call('task_detail', { task_id: 'A1' })).content[0].text, /NO_TASK_DETAIL: A1 is an activity/);
  const got = JSON.parse((await call('task_receive', { task_id: '108117' })).content[0].text);
  assert.deepEqual(seen.slice(-2).map((s) => [s.method, s.params]), [['task_receive', { item_id: '108116' }], ['tasks_list', {}]]);
  assert.deepEqual(got, { task_id: '108117', title: 't', designer_task_id: '9001', status: 'WAIT_SUBMIT' });
  assert.match((await call('task_receive', { task_id: 'headdress_decoration' })).content[0].text, /UNKNOWN_TASK: headdress_decoration/);
  assert.match((await call('task_receive', { task_id: 'A1' })).content[0].text, /TASK_NOT_RECEIVABLE: A1 is not an effect task \(kind=activity\)/);
  assert.match((await call('task_bind', { path: '/proj/X', task_id: 'headdress_decoration' })).content[0].text, /UNKNOWN_TASK: headdress_decoration/);
  assert.equal(seen.filter((s) => s.method === 'task_receive').length, 1);
});

test('server kind and rank filter enums match the plugin tables', async () => {
  const client = await connect({ listInstances: () => [], callPlugin: async () => ({}) });
  const { tools } = await client.listTools();
  const props = (name) => tools.find((t) => t.name === name).inputSchema.properties;
  assert.deepEqual(props('rank_innovation').kind.enum, INNOVATION_KINDS);
  for (const key of Object.keys(RANK_FILTERS)) assert.deepEqual(props('rank_list')[key].items.enum, Object.keys(RANK_FILTERS[key].options), key);
  assert.deepEqual(props('rank_subjects').kind.enum, Object.keys(SUBJECT_KINDS));
});

test('growth_route reads the mobile app 成长之路 with each level, goal and state', async () => {
  const goal = (id, status, text, curr, target, reward) => ({ id, status, progresses: [{ goal_text: text, curr_num: curr, goal_num: target, desc_text: reward }] });
  const route = [
    { cur_layer: 2, layer_task: [{ layer: 2, layer_name: '新手特效师', award: '¥50', status: 2, sub_tasks: [goal(2110, 1, '拍摄作品视频并发布到抖音', 1, 1, '¥10'), goal(2120, 2, '绑定「灵感」上线 0/3 个作品', 0, 3, '¥10')] }] },
    { cur_layer: 2, layer_task: [{ layer: 3, layer_name: '潜力特效师', award: '¥90', status: 3, sub_tasks: [goal(3110, 3, '绑定「任务」上线 2 个作品', 0, 2, '¥20')] }] },
    { cur_layer: 2, layer_task: [{ layer: 9, layer_name: '大师特效师', award: '¥0', status: 3, rights: [{ operate_text: '专属两项新权益', right_cards: [{ title: '作者专访' }, { title: '周年礼盒' }] }] }] },
  ];
  const { lib, to } = setup({ 'GET /cam_api/designer/v6/growth_route': ok(route) });
  assert.deepEqual(await lib.growthRoute(), {
    current_level: 2,
    levels: [
      {
        level: 2,
        name: '新手特效师',
        award_text: '¥50',
        status: 'in_progress',
        goals: [
          { text: '拍摄作品视频并发布到抖音', current: 1, target: 1, reward_text: '¥10', status: 'done' },
          { text: '绑定「灵感」上线 0/3 个作品', current: 0, target: 3, reward_text: '¥10', status: 'in_progress' },
        ],
      },
      { level: 3, name: '潜力特效师', award_text: '¥90', status: 'locked', goals: [{ text: '绑定「任务」上线 2 个作品', current: 0, target: 2, reward_text: '¥20', status: 'locked' }] },
      { level: 9, name: '大师特效师', award_text: '¥0', status: 'locked', rights: ['作者专访', '周年礼盒'] },
    ],
  });
  assert.deepEqual(to('/cam_api/designer/v6/growth_route')[0].query, { app_version: '17.7.0' });
  const empty = setup({ 'GET /cam_api/designer/v6/growth_route': ok(null) });
  await assert.rejects(empty.lib.growthRoute(), /NO_GROWTH_ROUTE/);
});

// Trimmed from the 作品详情 answers for 「S16冠军」 (2026-11-09).
const EFFECT_BASE = {
  effect: { effect_id: 92012413, name: 'S16冠军', icon: 'https://cdn/s16.png', submit_at: 1794059970000, artwork_type: 0, artwork_type_desc: '特效', item_id: 7705653639092570147 },
  designer: { uid: 1805811249320653, nickname: '沐谦', ly: 2, ly_name: '新手特效师' },
  dy_app_effect: { app_id: 184, app_effect_id: '285940787', level: 0, online_status: 103, online_status_desc: '已上线抖音', peak_pub: '0', total_pub: '3', online_at: 1794061758000 },
  other_app_effects: [{ app_id: 1164, app_effect_id: '285955413', level: 0, online_status: 114, online_status_desc: '已上线抖音极速版', peak_pub: '0', total_pub: '0', online_at: 1794061760000 }],
  project: { fn_type: ['2D人脸形变'], fn_types: [{ name: '2D人脸形变', key: 'FaceDistortion2D' }, { name: '音频播放', key: 'AudioPlayer' }] },
  tags: [{ tag_type: 4, text: '像塑探索版' }],
};
const EFFECT_ONLINE = {
  display_list: [
    { type: 1, display_type: '累计曝光', val: 77, display_val: '77' },
    { type: 5, display_type: '特效类型', val: 5167, display_val: '玩法测试' },
    { type: 8, display_type: '年轻喜爱度', val: 10, display_val: '10分' },
  ],
};
const EFFECT_PUB_STAT = {
  is_new_inc: true,
  is_overtime: false,
  cur_lv: 0,
  cur_pub: '3',
  next_lv: 29,
  next_lv_need_pub: '297',
  pub_stat: [
    { date: '20261107', pub_val: 3, pub_val_display: '3' },
    { date: '20261106', pub_val: 3, pub_val_display: '3' },
    { date: '20261105', pub_val: 1, pub_val_display: '1' },
  ],
  show_stat: [
    { date: '20261106', pub_val: 40, pub_val_display: '40' },
    { date: '20261107', pub_val: 64, pub_val_display: '64' },
    { date: '20261108', pub_val: 77, pub_val_display: '77' },
  ],
  total_show: '77',
  total_trial: '5',
  follow_shoot_pub: '0',
  video_plays: '23',
};
const EFFECT_REVENUE = {
  revenue_details: [
    { type: 0, display_type: '总收益', amount: '0', unlocked: true, weight_flag: 0, weight_amount: '0' },
    { type: 4, display_type: '精选奖', amount: '0', detail_text: '不符合精选标准', unlocked: false, weight_flag: 0 },
  ],
};
const noData = JSON.stringify({ code: 0, message: 'success' });
const EFFECT_ROUTES = {
  'GET /cam_api/effect/v1/base': ok(EFFECT_BASE),
  'GET /cam_api/effect/v1/online_data': ok(EFFECT_ONLINE),
  'GET /effectcam/v1/effect_pub_stat': ok(EFFECT_PUB_STAT),
  'GET /cam_api/effect/v1/revenue': ok(EFFECT_REVENUE),
  'GET /cam_api/effect/v1/effect_traffic': ok({
    traffic_status: 3,
    details: [
      { tag: { type: 0, name: '官方加热中' }, vv_real: '0', schema: '' },
      { tag: { type: 1, name: '精选加热中' }, vv_expected: '100000', vv_real: '89159', schema: 'https://effect.douyin.com/content/x' },
    ],
  }),
  'GET /effectcam/v1/effect_vv': ok({ vv_num: '43' }),
  'GET /cam_api/effect/v1/related_info': ok({ details: [{ id: '107846', name: '扮演AR新玩法共创赛', type: 1, related_status: 2, type_desc: '绑定任务' }] }),
  'GET /cam_api/effect/v1/tips': noData,
  'GET /cam_api/effect/v1/scarce_category': noData,
};

test('my_effect_data reads the 作品详情 data cards with the 抖音 app id', async () => {
  const { lib, to } = setup(EFFECT_ROUTES);
  assert.deepEqual(await lib.myEffectData({ effect_id: '92012413', app_effect_id: '285940787' }), {
    effect_id: '92012413',
    app_effect_id: '285940787',
    name: 'S16冠军',
    type: '特效',
    submitted_at: new Date(1794059970000).toISOString(),
    icon_url: 'https://cdn/s16.png',
    apps: [
      { app_id: 184, app_effect_id: '285940787', status: 103, status_text: '已上线抖音', online_at: new Date(1794061758000).toISOString(), level_code: 0, publish_peak: '0', publish_total: '3' },
      { app_id: 1164, app_effect_id: '285955413', status: 114, status_text: '已上线抖音极速版', online_at: new Date(1794061760000).toISOString(), level_code: 0, publish_peak: '0', publish_total: '0' },
    ],
    functions: ['2D人脸形变', '音频播放'],
    tags: ['像塑探索版'],
    figures: [
      { name: '累计曝光', value: 77, text: '77' },
      { name: '特效类型', value: 5167, text: '玩法测试' },
      { name: '年轻喜爱度', value: 10, text: '10分' },
    ],
    traffic: {
      status: 3,
      tags: ['官方加热中', '精选加热中'],
      details: [
        { name: '官方加热中', type: 0, vv_real: 0, vv_expected: null },
        { name: '精选加热中', type: 1, vv_real: 89159, vv_expected: 100000 },
      ],
    },
    views: '43',
    related: [{ type: '绑定任务', id: '107846', name: '扮演AR新玩法共创赛', status: 2 }],
  });
  const keyed = { effect_id: '92012413', app_effect_id: '285940787', app_id: '184' };
  for (const p of ['/cam_api/effect/v1/base', '/cam_api/effect/v1/online_data', '/cam_api/effect/v1/related_info', '/cam_api/effect/v1/tips', '/cam_api/effect/v1/scarce_category']) {
    assert.deepEqual(to(p)[0].query, keyed, p);
  }
  assert.deepEqual(to('/cam_api/effect/v1/effect_traffic')[0].query, { effect_id: '92012413', app_effect_id: '285940787' });
  assert.deepEqual(to('/effectcam/v1/effect_vv')[0].query, { app_effect_id: '285940787', app_id: '184' });
  for (const p of ['/effectcam/v1/effect_pub_stat', '/cam_api/effect/v1/revenue']) assert.equal(to(p).length, 0, p);

  // Cards that answer without data leave their fields empty; tips and scarce_category with data stay unread.
  const bare = setup({ ...EFFECT_ROUTES, 'GET /cam_api/effect/v1/online_data': noData, 'GET /cam_api/effect/v1/scarce_category': ok({ category: '萌宠' }) });
  const thin = await bare.lib.myEffectData({ effect_id: '92012413', app_effect_id: '285940787' });
  assert.deepEqual(thin.figures, []);
  assert.deepEqual(thin.unread, { scarce_category: { category: '萌宠' } });

  const wrong = setup({ ...EFFECT_ROUTES, 'GET /effectcam/v1/effect_vv': JSON.stringify({ code: 1004, message: '无法查询' }) });
  await assert.rejects(wrong.lib.myEffectData({ effect_id: '92012413', app_effect_id: '1' }), /GET_EFFECT_VV_FAILED: code=1004 message=无法查询/);
  await assert.rejects(lib.myEffectData({ effect_id: '92012413' }), /INVALID_APP_EFFECT_ID/);
  await assert.rejects(lib.myEffectData({ app_effect_id: '285940787' }), /INVALID_EFFECT_ID/);
});

test('my_effect_trend reads 数据趋势 by day and the submission level for either window', async () => {
  const { lib, to } = setup(EFFECT_ROUTES);
  assert.deepEqual(await lib.myEffectTrend({ effect_id: '92012413', app_effect_id: '285940787' }), {
    effect_id: '92012413',
    app_effect_id: '285940787',
    window: 'recent',
    level: { code: 0, publish: '3', next_code: 29, publish_to_next: '297', is_new: true, overtime: false },
    days: [
      { date: '2026-11-05', exposure: null, publish: 1 },
      { date: '2026-11-06', exposure: 40, publish: 3 },
      { date: '2026-11-07', exposure: 64, publish: 3 },
      { date: '2026-11-08', exposure: 77, publish: null },
    ],
    exposure_total: '77',
    trial_total: '5',
    follow_shoot: '0',
    video_plays: '23',
  });
  assert.deepEqual(to('/effectcam/v1/effect_pub_stat')[0].query, { effect_id: '92012413', app_effect_id: '285940787', app_id: '184', cycle: '1' });
  assert.equal(to('/cam_api/effect/v1/base').length, 0);
  await lib.myEffectTrend({ effect_id: '92012413', app_effect_id: '285940787', trend: 'since_online' });
  assert.equal(to('/effectcam/v1/effect_pub_stat')[1].query.cycle, '2');

  const bare = setup({ ...EFFECT_ROUTES, 'GET /effectcam/v1/effect_pub_stat': noData });
  const thin = await bare.lib.myEffectTrend({ effect_id: '92012413', app_effect_id: '285940787' });
  assert.deepEqual(thin.level, { code: null, publish: null, next_code: null, publish_to_next: null, is_new: null, overtime: null });
  assert.deepEqual(thin.days, []);
  await assert.rejects(lib.myEffectTrend({ effect_id: '92012413', app_effect_id: '285940787', trend: '7d' }), /INVALID_TREND: 7d; valid: recent, since_online/);
  await assert.rejects(lib.myEffectTrend({ effect_id: '92012413' }), /INVALID_APP_EFFECT_ID/);
});

test('my_effect_revenue reads the 作品详情 收益 card', async () => {
  const { lib, to } = setup(EFFECT_ROUTES);
  assert.deepEqual(await lib.myEffectRevenue({ effect_id: '92012413', app_effect_id: '285940787' }), {
    effect_id: '92012413',
    app_effect_id: '285940787',
    items: [
      { name: '总收益', amount: '0', note: null, unlocked: true },
      { name: '精选奖', amount: '0', note: '不符合精选标准', unlocked: false },
    ],
  });
  assert.deepEqual(to('/cam_api/effect/v1/revenue')[0].query, { effect_id: '92012413', app_effect_id: '285940787', app_id: '184' });
  assert.equal(to('/cam_api/effect/v1/base').length, 0);
  const bare = setup({ ...EFFECT_ROUTES, 'GET /cam_api/effect/v1/revenue': noData });
  assert.deepEqual((await bare.lib.myEffectRevenue({ effect_id: '92012413', app_effect_id: '285940787' })).items, []);
  await assert.rejects(lib.myEffectRevenue({ app_effect_id: '285940787' }), /INVALID_EFFECT_ID/);
});

const DESIGNER_ROUTES = {
  'GET /cam_api/designer/v1/base': ok({
    designer: { uid: 1805811249320653, username: '沐谦', gender: 1, is_real_name: false, fans_num: 207 },
    identity_list: [
      { name: '特效作者', identity_type: 1, lv: 2, lv_name: '新手特效师' },
      { name: '模板作者', identity_type: 2, lv: 2, lv_name: '新手模板师' },
    ],
  }),
  'GET /cam_api/designer/v1/data': ok({
    display_list: [
      { type: 4, display_type: '本月上线', val: 16, display_val: '16' },
      { type: 5, display_type: '本月收入', val: 5100, display_val: '51.00' },
    ],
  }),
  'GET /effectcam/v1/month_data': ok({ date: '20261109', revenue: '51.00', pd_revenue: '10.00', on_amount: '16', panel_amount: '14', all_pub: '4', all_rev: '51.00' }),
  'GET /effectcam/v1/account_revenue': ok({
    partner_play_incentive: '0.00',
    a_re: { t_re: '51.00', ro_list: [{ t: 1, n: '投稿收益', ro: '100%', i: { uri: 'x' }, re: '51.00' }] },
    m_re: { t_re: '51.00', ro_list: [{ t: 1, n: '投稿收益', ro: '100%', re: '51.00' }], re_m: '202611' },
    m_d_res: [
      { d: '20261108', w_day: 7, re: '10.00' },
      { d: '20261106', w_day: 5, re: '41.00' },
    ],
  }),
};

test('my_profile reads the 我的 page: the designer, their levels, the figures and the month data it can name', async () => {
  const { lib, to } = setup(DESIGNER_ROUTES);
  assert.deepEqual(await lib.myProfile(), {
    uid: '1805811249320653',
    nickname: '沐谦',
    fans: 207,
    real_name: false,
    identities: [
      { name: '特效作者', level: 2, level_name: '新手特效师' },
      { name: '模板作者', level: 2, level_name: '新手模板师' },
    ],
    figures: [
      { name: '本月上线', value: 16, text: '16' },
      { name: '本月收入', value: 51, text: '51.00' },
    ],
    month: { date: '2026-11-09', online_count: '16', revenue_yuan: 51, previous_day_revenue_yuan: 10, revenue_total_yuan: 51, unread: { panel_amount: '14', all_pub: '4' } },
  });
  assert.equal(to('/effectcam/v1/account_revenue').length, 0);
});

test('my_revenue reads the 钱包 revenue of a month', async () => {
  const { lib, to } = setup(DESIGNER_ROUTES);
  assert.deepEqual(await lib.myRevenue(), {
    total_yuan: 51,
    sources_total: [{ name: '投稿收益', share: '100%', yuan: 51 }],
    month: '202611',
    month_yuan: 51,
    sources_month: [{ name: '投稿收益', share: '100%', yuan: 51 }],
    days: [
      { date: '2026-11-08', yuan: 10 },
      { date: '2026-11-06', yuan: 41 },
    ],
    partner_play_incentive_yuan: 0,
  });
  assert.deepEqual(to('/effectcam/v1/account_revenue')[0].query, {});
  assert.equal(to('/cam_api/designer/v1/base').length, 0);
  await lib.myRevenue({ month: '202610' });
  assert.deepEqual(to('/effectcam/v1/account_revenue')[1].query, { d_m: '202610' });
  await assert.rejects(lib.myRevenue({ month: '2026-10' }), /INVALID_MONTH: 2026-10; expected YYYYMM/);
});

test('messages_list pages the 消息 page by the last message id and names each message group and effect', async () => {
  const msg = (id, group, title, page, extra = {}) => ({ id, group, title, content: `${title}正文`, is_ack: true, time: 1794198270000, page, status_code: 0, status_text: '', ...extra });
  const pages = {
    '': {
      has_more: true,
      messages: [
        msg('414984848', '2', 'AI 抽到SSR的我', 'https://effect.douyin.com/m/detail?id=92336836&showReviewList=1', { is_ack: false, status_code: 100, status_text: '审核中' }),
        msg('414978447', '1', '获奖公布｜开学季热爆答题测试征集赛', 'https://effect.douyin.com/content/46hw70th/41y6q3nf?'),
      ],
    },
    414978447: {
      has_more: false,
      messages: [
        msg('414970000', '9', '新分组', ''),
        msg('414960000', '2', '小猫陪你跳', 'effectcam://flutter?page=/effect-detail&appEffectIdStr=286917268&appEffectId=286917268&effectId=92275961&source=1&appId=184&from=profile'),
        msg('414950000', '1', '任务完成', 'effectcam://flutter?page=/task-detail&itemid=108200&type=1&detid=555&newTask=0'),
      ],
    },
  };
  const { lib, to } = setup({ 'GET /cam_api/message/v1/list': (call) => ok(pages[call.query.cursor]) });
  const first = await lib.messagesList({ count: 2 });
  assert.deepEqual(first, {
    group: 'all',
    items: [
      { message_id: '414984848', group: '官方', title: 'AI 抽到SSR的我', content: 'AI 抽到SSR的我正文', at: new Date(1794198270000).toISOString(), read: false, status: 100, status_text: '审核中', effect_id: '92336836', link: 'https://effect.douyin.com/m/detail?id=92336836&showReviewList=1' },
      { message_id: '414978447', group: '服务', title: '获奖公布｜开学季热爆答题测试征集赛', content: '获奖公布｜开学季热爆答题测试征集赛正文', at: new Date(1794198270000).toISOString(), read: true, status: null, status_text: null, effect_id: null, link: 'https://effect.douyin.com/content/46hw70th/41y6q3nf?' },
    ],
    next_cursor: '414978447',
    has_more: true,
  });
  assert.deepEqual(to('/cam_api/message/v1/list')[0].query, { group: '0', cursor: '', count: '2' });
  const last = await lib.messagesList({ group: 'service', cursor: first.next_cursor });
  assert.deepEqual(to('/cam_api/message/v1/list')[1].query, { group: '1', cursor: '414978447', count: '20' });
  assert.equal(last.items[0].group, '9');
  assert.equal(last.items[0].link, null);
  // 上线 and 精选审核 notices open the app's 作品详情 page, which carries the effect; task pages do not.
  assert.deepEqual(last.items.map((m) => m.effect_id), [null, '92275961', null]);
  assert.equal(last.next_cursor, null);
  assert.equal(last.has_more, false);
  await assert.rejects(lib.messagesList({ group: 'system' }), /INVALID_GROUP: system; valid: all, service, official/);
});

test('my_innovation_status tells each effect by the 官方精选 filter and its newest 精选 verdict message', async () => {
  const art = (id, name, status = 103, online = 1794191538000) => ({ id, name, effect_status: status, effect_status_desc: status === 103 ? '已上线' : '审核中', first_online_at: String(status === 103 ? online : 0) });
  // A full first page of offline effects, so the list is read on with the sort key it hands back.
  const filler = Array.from({ length: 50 }, (_, i) => art(String(80000000 + i), `旧${i}`, 104));
  const all = [
    art('1', '已入选'),
    art('2', '审核中的'),
    art('3', '落选的'),
    art('4', '没进的'),
    art('5', '还没上线', 100),
    art('6', '文案认不出'),
    art('7', '落选没写原因'),
    art('8', '消息说入选'),
    art('9', '落选后重审'),
  ];
  const detail = (id) => `effectcam://flutter?page=/effect-detail&appEffectId=9&effectId=${id}&source=1&appId=184`;
  const msg = (id, title, content, page, time) => ({ id, group: '2', title, content, is_ack: true, time, page });
  const REVIEWING = '你的特效正在精选审核中，预估7个工作日完成，请耐心等待。';
  const REJECTED = '你的特效暂未被评为精选特效，原因为不满足设计精美，你可以参考精选评估标准进行优化。';
  const PICKED = '你的特效被评为精选特效，可获得额外激励和精选标识。';
  const PROMO = '持续创作精选特效均可获得额外曝光>>';
  const pages = {
    '': {
      has_more: true,
      messages: [
        msg('912', '落选后重审', REVIEWING, detail('9'), 1794330000000),
        msg('911', '落选后重审', REJECTED, detail('9'), 1794320000000),
        msg('910', '消息说入选', PROMO, detail('8'), 1794315000000),
        msg('909', '消息说入选', PICKED, detail('8'), 1794312000000),
        msg('908', '消息说入选', REVIEWING, detail('8'), 1794311000000),
        msg('907', '落选没写原因', '你的特效暂未被评为精选特效。', detail('7'), 1794310000000),
        msg('906', '文案认不出', '精选审核结果：未入选', detail('6'), 1794305000000),
        msg('901', '落选的', PROMO, detail('3'), 1794301000000),
        msg('900', '落选的', REJECTED, detail('3'), 1794300000000),
        msg('899', '票选精选遗珠', '快来投票', 'https://effect.douyin.com/m/vote', 1794290000000),
        msg('898', '审核中的', '特效已上线抖音，拍摄特效视频可获得更多冷启流量', detail('2'), 1794280000000),
      ],
    },
    898: {
      has_more: false,
      messages: [
        msg('897', '审核中的', REVIEWING, detail('2'), 1794270000000),
        msg('896', '落选的', REVIEWING, detail('3'), 1794260000000),
        msg('895', '已入选', REVIEWING, detail('1'), 1794250000000),
        msg('894', '审核中的', REVIEWING, detail('2'), 1794240000000),
      ],
    },
  };
  const { lib, to } = setup({
    'GET /effectcam/v1/artworks': (call) => {
      if (call.query.rating === '1') return ok({ effects: [all[0]], sort: 'c1', total: 1 });
      return ok(call.query.sort === 's1' ? { effects: all, sort: 's2' } : { effects: filler, sort: 's1' });
    },
    'GET /cam_api/message/v1/list': (call) => ok(pages[call.query.cursor]),
  });
  const out = await lib.myInnovationStatus();
  assert.deepEqual(out.summary, { online: 8, picked: 2, in_review: 2, rejected: 2, notified: 1, pick_rate: 0.25 });
  assert.equal(out.items.length, 59);
  const byId = Object.fromEntries(out.items.map((i) => [i.effect_id, i]));
  assert.deepEqual(byId['1'], {
    effect_id: '1',
    name: '已入选',
    status: 103,
    status_text: '已上线',
    online_at: new Date(1794191538000).toISOString(),
    state: 'picked',
    review_since: new Date(1794250000000).toISOString(),
    reject_reason: null,
    notices: [{ at: new Date(1794250000000).toISOString(), content: REVIEWING }],
  });
  const brief = (id) => [byId[id].state, byId[id].reject_reason];
  // review_since is the first 精选审核中 notice.
  assert.deepEqual([byId['2'].state, byId['2'].review_since, byId['2'].notices.length], ['in_review', new Date(1794240000000).toISOString(), 2]);
  // A promotion after the verdict leaves it standing.
  assert.deepEqual([...brief('3'), byId['3'].review_since, byId['3'].notices.map((n) => n.content)], ['rejected', '不满足设计精美', new Date(1794260000000).toISOString(), [PROMO, REJECTED, REVIEWING]]);
  assert.deepEqual([byId['4'].state, byId['4'].notices, byId['5'].state, byId['5'].online_at], ['none', [], 'none', null]);
  assert.deepEqual([...brief('6'), byId['6'].notices.map((n) => n.content)], ['notified', null, ['精选审核结果：未入选']]);
  assert.deepEqual(brief('7'), ['rejected', null]);
  assert.deepEqual(brief('8'), ['picked', null], 'picked by its message while the filter does not list it');
  assert.deepEqual(brief('9'), ['in_review', null], 'back in review after a rejection');
  assert.deepEqual(
    to('/effectcam/v1/artworks').map((c) => c.query),
    [{ count: '50' }, { count: '50', rating: '1' }, { count: '50', sort: 's1' }],
  );
  assert.deepEqual(to('/cam_api/message/v1/list').map((c) => c.query), [{ group: '0', cursor: '', count: '50' }, { group: '0', cursor: '898', count: '50' }]);
});

test('my_task_status reads 我的作品 of every received task, in order, and counts the 评定', async () => {
  const effects = {
    108200: [
      { effect_name: '跟着小猫做动作', effect_id: '92218559', effect_status: 103, effect_status_desc: '已上线', shoot_num: '3', vv_num: '12', pub_peak_num: '1', task_status: 2, is_fit_theme: 2, type_desc: '特效' },
      { effect_name: '我和codex三天', effect_id: '92149570', effect_status: 103, effect_status_desc: '已上线', task_status: 3, is_fit_theme: 3, icon: { url_list: ['https://cdn/c.png'] } },
    ],
    108300: [],
    108400: [
      { effect_name: '资产稳定在A2', effect_id: '92258959', effect_status: 103, task_status: 1, is_fit_theme: 1 },
      { effect_name: '把手握紧什么都没有', effect_id: '92146750', effect_status: 103, task_status: 3, is_fit_theme: 3 },
    ],
  };
  const tasks = {
    effect_tasks: [
      EFFECT_TASKS.effect_tasks[0],
      { ...EFFECT_TASKS.effect_tasks[1], title: '扮演AR新玩法共创赛' },
      { title: '空任务', designer_task_id: '556', item_id: 108300, task_id: 108301 },
      { title: '热梗语录', designer_task_id: '557', item_id: 108400 },
    ],
  };
  const { lib, to } = setup({
    'GET /creator_api/task/v1/effect_task_list': ok(tasks),
    'GET /effectcam/v2/effect_task_detail': (call) => ok({ task_effect_list: effects[call.query.item_id] }),
  });
  const out = await lib.myTaskStatus();
  assert.deepEqual(
    to('/effectcam/v2/effect_task_detail').map((c) => c.query),
    ['108200', '108300', '108400'].map((item_id) => ({ item_id, app_version: '11.3.0' })),
  );
  assert.equal(out.tasks_checked, 3);
  assert.deepEqual(out.summary, { by_state: { unfinished: 1, done: 2, pending: 1 }, off_theme: 1 });
  assert.deepEqual(
    out.items.map((i) => [i.task_id, i.task_title, i.name, i.task_state, i.off_theme]),
    [
      ['108201', '扮演AR新玩法共创赛', '跟着小猫做动作', 'unfinished', true],
      ['108201', '扮演AR新玩法共创赛', '我和codex三天', 'done', false],
      ['108400', '热梗语录', '资产稳定在A2', 'pending', false],
      ['108400', '热梗语录', '把手握紧什么都没有', 'done', false],
    ],
  );
  assert.deepEqual(out.items[0], {
    task_id: '108201',
    task_title: '扮演AR新玩法共创赛',
    effect_id: '92218559',
    name: '跟着小猫做动作',
    type: '特效',
    status: '已上线',
    status_code: 103,
    task_state: 'unfinished',
    off_theme: true,
    track: null,
    shoots: '3',
    views: '12',
    publish_peak: '1',
    award_amount: null,
    icon_url: null,
  });
  assert.equal(out.items[1].icon_url, 'https://cdn/c.png');
});

