import test from 'node:test';
import './tmp.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';

const require = createRequire(import.meta.url);
const { Library, M, EFFECT_SEARCH_KINDS, SEARCH_MAX, SCRIPT_TAGS, SCRIPT_MAX } = require('../editor-plugin/library.cjs');

const ok = (data) => JSON.stringify({ code: 0, message: 'success', data });

// A fake editor with the modules the community feature's signed requests need, and a fetch answering by
// method and path.
function setup(routes = {}) {
  const calls = [];
  const modules = {
    [M.urls]: { Domain: { kBackendApiURL: 'https://api.test' }, DomainPath: { kActivityAPI: '/a', kTaskListAPI: '/t', kGrowthTaskList: '/g' } },
    [M.bizUtils]: { PlatformUtils: { genSignData: () => 'signed' }, UserAgentUtils: { userAgentGenerator: () => () => 'DouyinAR/9.7.2' } },
    [M.orionui]: {
      CookieManager: class {
        async getCookie() {
          return 'sessionid=abc';
        }
      },
    },
    [M.activityTypes]: { getTypeName: () => 'normal', TaskStatus: { WAIT_RECEIVE: 1, WAIT_SUBMIT: 2 }, growthTaskType: { Newbie: 0 } },
    [M.inspirationConst]: { IS_COLLECT_PARAMS_TYPE: { Default: 2 } },
    [M.inspirationBridge]: { markAgentInspirationUsed: () => {} },
  };
  const mod = (name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  };
  const fetch = async (href, init) => {
    const url = new URL(href);
    const call = { path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method, headers: init.headers };
    calls.push(call);
    const route = routes[`${init.method} ${url.pathname}`];
    if (route === undefined) throw Error(`unexpected ${init.method} ${url.pathname}`);
    return new Response(typeof route === 'function' ? route(call) : route, { status: 200 });
  };
  return { lib: new Library(mod, fetch), calls, to: (p) => calls.filter((c) => c.path === p) };
}

// Trimmed from the answer for 「好友对你都有什么想法」 (2026-11-09) with every card present.
const DETAIL = {
  is_choiceness: 0,
  base: {
    effect_name: '好友对你都有什么想法',
    effect_icon: 'https://cdn/icon.png',
    app_effect_id: 273663451,
    app_effect_id_str: '273663451',
    first_online_at: 1791530714000,
    id: '88649924',
    effect_desc: '',
    type: 0,
    type_desc: '特效',
    is_show_pub_data: true,
    source: 5,
    app_id: 184,
  },
  data: {
    level: 25,
    base_rev: '1.3万',
    young_like_score: 10,
    hot_play_score: 8,
    age_desc: '年轻',
    gender_desc: '所有',
    male_pub_rate: '34.84',
    female_pub_rate: '65.16',
    style_type: '潮酷',
    male_like_score: 9,
    all_pub_val: '615.4万',
    tool_source: '桌面端',
    effect_flow: { status: 2, status_desc: '正常' },
    effect_type: { id: '5168', name: '社交测试', root_id: '4509' },
    like_cnt_all: '518.2万',
    comment_cnt_all: '91.8万',
  },
  videos: [{ video_url: 'https://play/v1', video_img: 'https://img/c1.jpeg', video_username: '', video_avatar: '', video_digg: '46.0万' }],
  effect_source: 1,
  extra: { hot: '', ins: '', is_fit_hot: 1 },
  project: { fn_types: [{ name: '美瞳', key: 'EyeColor' }, { name: '辉光', key: 'PostProcess_Bloom' }], fn_type: [], tmt_name: '你是靠什么吸引异性' },
  designer: { designer_id: '3578226660096025', name: '落落小魔王', avatar: 'https://cdn/a.png', ly: 1, ly_name: '小白特效师' },
  effect_tags: [],
};

test('effect_detail reads the 发现 page detail of any effect and keeps what it cannot name under unread', async () => {
  const { lib, to } = setup({ 'GET /effectcam/v2/discover_effect_detail': ok(DETAIL) });
  assert.deepEqual(await lib.effectDetail({ app_effect_id: ' 273663451 ' }), {
    app_effect_id: '273663451',
    effect_id: '88649924',
    name: '好友对你都有什么想法',
    type: '特效',
    description: '',
    online_at: new Date(1791530714000).toISOString(),
    icon_url: 'https://cdn/icon.png',
    level_code: 25,
    publish_total_text: '615.4万',
    likes_total_text: '518.2万',
    comments_total_text: '91.8万',
    young_like_score: 10,
    male_like_score: 9,
    hot_play_score: 8,
    male_rate: '34.84',
    female_rate: '65.16',
    audience: { age: '年轻', gender: '所有' },
    style: '潮酷',
    category: { id: '5168', name: '社交测试' },
    tool: '桌面端',
    traffic_text: '正常',
    functions: ['美瞳', '辉光'],
    designer: { uid: '3578226660096025', name: '落落小魔王', level_name: '小白特效师' },
    tags: [],
    videos: [{ url: 'https://play/v1', cover_url: 'https://img/c1.jpeg', likes: '46.0万' }],
    unread: {
      is_choiceness: 0,
      effect_source: 1,
      extra: { hot: '', ins: '', is_fit_hot: 1 },
      base: { type: 0, is_show_pub_data: true, source: 5, app_id: 184 },
      data: { base_rev: '1.3万' },
      project: { fn_type: [], tmt_name: '你是靠什么吸引异性' },
    },
  });
  // The server refuses the request without effect_source; the value does not pick the effect.
  assert.deepEqual(to('/effectcam/v2/discover_effect_detail')[0].query, { app_effect_id: '273663451', app_effect_id_str: '273663451', effect_source: '1' });
});

test('effect_detail leaves the cards the server left out empty', async () => {
  const { base, data, videos, effect_source, effect_tags } = DETAIL;
  const { id, type_desc, ...thinBase } = base;
  const { effect_type, like_cnt_all, comment_cnt_all, ...thinData } = data;
  const { lib } = setup({ 'GET /effectcam/v2/discover_effect_detail': ok({ base: thinBase, data: thinData, videos, effect_source, effect_tags }) });
  const out = await lib.effectDetail({ app_effect_id: '273663451' });
  assert.deepEqual(
    { effect_id: out.effect_id, type: out.type, category: out.category, likes: out.likes_total_text, functions: out.functions, designer: out.designer, unread: Object.keys(out.unread) },
    { effect_id: null, type: null, category: null, likes: null, functions: null, designer: null, unread: ['effect_source', 'base', 'data'] },
  );
  const missing = setup({ 'GET /effectcam/v2/discover_effect_detail': JSON.stringify({ code: 3000, message: '特效不存在' }) });
  await assert.rejects(missing.lib.effectDetail({ app_effect_id: '999999999999' }), /GET_EFFECT_DETAIL_FAILED: code=3000 message=特效不存在/);
  await assert.rejects(missing.lib.effectDetail({}), /INVALID_APP_EFFECT_ID/);
  assert.equal(missing.calls.length, 1);
});

test('effect_videos merges the 优秀视频 into the 作品视频 they repeat, taking their item id and full title', async () => {
  const answer = {
    effect_video: {
      videos: [
        { video_url: 'https://v/1.mp4', video_img: 'https://img/1.jpeg', video_username: '阿畔', video_digg: '45.5万', video_follow_shoot: '1.3万', video_title: '嘻嘻嘻#嘻嘻...' },
        { video_url: 'https://v/2.mp4', video_img: 'https://img/2.jpeg', video_username: '小鱼', video_digg: '23.6万', video_follow_shoot: '6651', video_title: '' },
      ],
      like_cnt_all: '518.2万',
      follow_shoot_cnt_all: '275.9万',
    },
    author_video: null,
    hot_video: {
      ExcellentVideoList: [
        { url: 'https://v/1.mp4', icon: 'https://img/1.jpeg', item_id: '7695469125849955722', video_author: '阿畔', digg_str: '45.5万', follow_pub_str: '1.3万', video_title: '嘻嘻嘻#嘻嘻嘻嘻 @☁️' },
        { url: 'https://v/3.mp4', icon: 'https://img/3.jpeg', item_id: '7695074895293735417', video_author: '卖萌', digg_str: '2.0万', follow_pub_str: '10', video_title: '只在优秀视频里' },
      ],
      total: 2,
    },
  };
  const { lib, to } = setup({ 'GET /cam_api/effect/v2/videos': ok(answer) });
  assert.deepEqual(await lib.effectVideos({ effect_id: '88649924', app_effect_id: '273663451' }), {
    effect_id: '88649924',
    app_effect_id: '273663451',
    likes_total_text: '518.2万',
    follow_shoot_total_text: '275.9万',
    videos: [
      { item_id: '7695469125849955722', title: '嘻嘻嘻#嘻嘻嘻嘻 @☁️', author: '阿畔', likes_text: '45.5万', follow_shoot_text: '1.3万', cover_url: 'https://img/1.jpeg', video_url: 'https://v/1.mp4' },
      { item_id: null, title: '', author: '小鱼', likes_text: '23.6万', follow_shoot_text: '6651', cover_url: 'https://img/2.jpeg', video_url: 'https://v/2.mp4' },
      { item_id: '7695074895293735417', title: '只在优秀视频里', author: '卖萌', likes_text: '2.0万', follow_shoot_text: '10', cover_url: 'https://img/3.jpeg', video_url: 'https://v/3.mp4' },
    ],
  });
  assert.deepEqual(to('/cam_api/effect/v2/videos')[0].query, { effect_id: '88649924', app_effect_id: '273663451', app_id: '184' });

  const authored = setup({ 'GET /cam_api/effect/v2/videos': ok({ effect_video: { videos: [] }, author_video: { videos: [1] }, hot_video: null }) });
  const out = await authored.lib.effectVideos({ effect_id: '1', app_effect_id: '2' });
  assert.deepEqual([out.videos, out.unread], [[], { author_video: { videos: [1] } }]);
  await assert.rejects(lib.effectVideos({ effect_id: '88649924' }), /INVALID_APP_EFFECT_ID/);
});

const SEARCH = {
  2: {
    search_type: 2,
    cursor: 3,
    total: 100,
    effect_list: [{ name: '醉美妆', icon: 'https://cdn/z.png', instructions: '超好看的妆容', app_effect_id: 1238916, level: 27, young_score: 3, all_pub: '337.8万', effect_source: 1, app_effect_id_str: '1238916', effect_id_str: '238895' }],
    course_list: null,
    insp_list: null,
  },
  // Template ids overflow app_effect_id; app_effect_id_str carries the real one.
  4: {
    search_type: 4,
    cursor: 300,
    total: 300,
    effect_list: [{ name: '美妆', icon: '', instructions: '', app_effect_id: -977272791, level: 0, young_score: 0, all_pub: '0', effect_source: 6, app_effect_id_str: '7413650070643408937', effect_id_str: '27377702' }],
  },
  3: {
    search_type: 3,
    cursor: 1,
    count: 0,
    total: 300,
    insp_list: [{ id: '7548608692686604338', title: '中秋节彩妆', cover_img: { uri: 'u', urlList: ['https://cdn/i.png'] }, tag_desc: '', author_name: '🍉', total_collection: 209, is_collect: false, author_uid: '3861953422301592', is_ai_ins: false }],
  },
  1: {
    search_type: 1,
    cursor: 8,
    total: 8,
    // 02:30 on 2025-07-13 in Beijing, still the 12th in UTC.
    course_list: [{ id: '1512300000371', name: '「美妆」测试美妆效果', tutorial_img: 'https://cdn/t.png', study_num_text: '2.0万次学习', tutorial_num_text: '拍视频脚本', need_pay: false, tutorial_link: 'https://doc/1', username: '抖音特效开放平台', online_date: '1752345000000', tutorial_type: 3, tutorial_video: '' }],
  },
};

test('effect_search, inspiration_search and tutorial_search send their app search type and read its list', async () => {
  const { lib, to } = setup({ 'GET /cam_api/search/v1/search_list': (c) => ok(SEARCH[c.query.type]) });
  const effects = await lib.effectSearch({ query: ' 美妆 ', count: 3 });
  assert.deepEqual(effects, {
    kind: 'effect',
    query: '美妆',
    total: 100,
    items: [{ effect_id: '238895', app_effect_id: '1238916', name: '醉美妆', description: '超好看的妆容', level_code: 27, young_like_score: 3, publish_total_text: '337.8万', icon_url: 'https://cdn/z.png' }],
    next_cursor: 3,
    has_more: true,
  });
  assert.deepEqual(to('/cam_api/search/v1/search_list')[0].query, { type: '2', content: '美妆', cursor: '0', count: '3' });
  const templates = await lib.effectSearch({ kind: 'template', query: '美妆', cursor: 280 });
  assert.deepEqual([templates.items[0].app_effect_id, templates.items[0].icon_url, templates.next_cursor, templates.has_more], ['7413650070643408937', null, 300, false]);
  assert.deepEqual(to('/cam_api/search/v1/search_list')[1].query, { type: '4', content: '美妆', cursor: '280', count: String(SEARCH_MAX) });
  const insp = await lib.inspirationSearch({ query: '美妆' });
  assert.deepEqual(to('/cam_api/search/v1/search_list')[2].query, { type: '3', content: '美妆', cursor: '0', count: String(SEARCH_MAX) });
  assert.equal(insp.kind, undefined);
  assert.deepEqual(insp.items[0], { inspiration_id: '7548608692686604338', title: '中秋节彩妆', tag: null, author: '🍉', author_uid: '3861953422301592', collect_count: 209, collected: false, ai: false, hotspot: null, cover_url: 'https://cdn/i.png' });
  // The answer's count says 0 while its list holds an entry; paging goes by the list.
  assert.equal(insp.has_more, true);
  const courses = await lib.tutorialSearch({ query: '美妆' });
  assert.equal(to('/cam_api/search/v1/search_list')[3].query.type, '1');
  assert.deepEqual(courses.items[0], {
    tutorial_id: '1512300000371',
    title: '「美妆」测试美妆效果',
    label: '拍视频脚本',
    study_text: '2.0万次学习',
    author: '抖音特效开放平台',
    online_date: '2025-07-13',
    paid: false,
    link: 'https://doc/1',
    cover_url: 'https://cdn/t.png',
    video_url: null,
  });
  assert.equal(courses.has_more, false);
  assert.deepEqual(EFFECT_SEARCH_KINDS, ['effect', 'template']);
});

test('the searches end on an empty page and check their arguments before asking', async () => {
  const { lib, calls } = setup({ 'GET /cam_api/search/v1/search_list': ok({ search_type: 2, cursor: 0, count: 0, total: 0, effect_list: null }) });
  await assert.rejects(lib.effectSearch({ query: '  ' }), /INVALID_QUERY/);
  await assert.rejects(lib.inspirationSearch({}), /INVALID_QUERY/);
  await assert.rejects(lib.tutorialSearch({ query: '' }), /INVALID_QUERY/);
  await assert.rejects(lib.effectSearch({ kind: 'inspiration', query: '美妆' }), /INVALID_KIND: inspiration; valid: effect, template/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await lib.effectSearch({ query: '没有的词' }), { kind: 'effect', query: '没有的词', total: 0, items: [], next_cursor: 0, has_more: false });
});

const COURSE_TABS = [
  { tab_type: '特效', course_tabs: [{ id: 25, name: '新手入门' }, { id: 10, name: '三方工具' }] },
  { tab_type: '模板', course_tabs: [{ id: 31, name: '三方工具' }] },
];
const course = (id, extra = {}) => ({ id, name: `课${id}`, tutorial_img: `https://cdn/${id}.png`, study_num_text: '3.5万次学习', tutorial_num_text: '入门必看', need_pay: false, tutorial_link: '', username: '抖音特效开放平台', online_date: '2023-10-23', tutorial_video: `https://cdn/${id}.mp4`, ...extra });

test('tutorials_list names every tab with its group and pages one tab or all courses here', async () => {
  const lists = { 25: [course('1'), course('2'), course('3', { need_pay: true, tutorial_link: 'https://doc/3', tutorial_video: '' })], all: [course('9')] };
  const { lib, to } = setup({
    'GET /cam_api/course/v2/tabs': ok(COURSE_TABS),
    'GET /cam_api/course/v1/list': (c) => ok(lists[c.query.tab_id ?? 'all']),
  });
  const page = await lib.tutorialsList({ tab_id: 25, offset: 1, count: 1 });
  assert.deepEqual(page, {
    tab: { tab_id: 25, name: '新手入门', group: '特效' },
    tabs: [
      { tab_id: 25, name: '新手入门', group: '特效' },
      { tab_id: 10, name: '三方工具', group: '特效' },
      { tab_id: 31, name: '三方工具', group: '模板' },
    ],
    total: 3,
    items: [{ tutorial_id: '2', title: '课2', label: '入门必看', study_text: '3.5万次学习', author: '抖音特效开放平台', online_date: '2023-10-23', paid: false, link: null, cover_url: 'https://cdn/2.png', video_url: 'https://cdn/2.mp4' }],
    next_offset: 2,
    has_more: true,
  });
  assert.deepEqual(to('/cam_api/course/v1/list')[0].query, { tab_id: '25' });
  const last = await lib.tutorialsList({ tab_id: 25, offset: 2 });
  assert.deepEqual([last.items.map((i) => [i.paid, i.link, i.video_url]), last.has_more], [[[true, 'https://doc/3', null]], false]);
  const all = await lib.tutorialsList({});
  assert.deepEqual([all.tab, all.items.map((i) => i.tutorial_id)], [null, ['9']]);
  assert.deepEqual(to('/cam_api/course/v1/list')[2].query, {});
  await assert.rejects(lib.tutorialsList({ tab_id: 99 }), /INVALID_TAB_ID: 99; valid: 25\(特效 › 新手入门\), 10\(特效 › 三方工具\), 31\(模板 › 三方工具\)/);
  assert.equal(to('/cam_api/course/v1/list').length, 3);
});

// Trimmed from the 拍视频激励 card of 2026-11-09; activity_id is a 19-digit raw number.
const ACTIVITY =
  '{"code":0,"message":"success","data":{"activity_name":"拍视频激励","start_time":1794153600000,"end_time":1794758399000,"server_time":1794214805212,"status":1,' +
  '"participation_data":{"tutor_id":0},"game_list":[{"game_name":"新手成长必学第一课","game_code":"newbie_task_1","game_status":1,"game_text":"已完成新手成长必学第一课"},' +
  '{"game_name":"别的玩法","game_code":"other","game_status":0,"game_text":""}],"shoot_num":1,"income_amount":0,' +
  '"task_list":[{"task_type":1,"task_name":"拍作品视频发布到抖音","status":1,"finish_count":1,"custom_name":"拍特效视频得 1 次抽奖机会"},{"task_type":2,"task_name":"按照脚本拍摄同款视频","status":1,"finish_count":0}],' +
  '"activity_id":7705722419054577714,"user_level":0,"user_shoot_activity_list":[{"task_id":"streak_daily","task_title":"连续创作打卡","task_desc":"参与任务广场，连续创作 7 天必得 1.5 元","cur_num":0,' +
  '"shoot_task_process":[{"process_id":"1","bonus_amount_yuan":"0.2","target_num":2},{"process_id":"4","bonus_amount_yuan":"1.5","target_num":7}],"custom_name":"连续 7 天参与达人任务得 1.5 元"}],' +
  '"next_reset_timestamp":1794758400,"user_reward_task":{"title":"新手成长任务","sub_title":"全部完成立得","task_list":[{"task_id":"newbie_task_1","status":1,"title":"新手成长必学第一课","sub_title":"","target_num":1},' +
  '{"task_id":"newbie_task_2","status":0,"title":"进入任务广场，参与 5 个任务","target_num":5}],"total_amount":1000,"total_amount_yuan":"10"},"user_layer":2}}';

test('shoot_activity reads the 拍视频激励 card and gives each newbie task the text the card shows for it', async () => {
  const { lib, to } = setup({ 'GET /cam_api/activity/v1/info': ACTIVITY });
  assert.deepEqual(await lib.shootActivity(), {
    activity_id: '7705722419054577714',
    name: '拍视频激励',
    start_at: new Date(1794153600000).toISOString(),
    end_at: new Date(1794758399000).toISOString(),
    status: 1,
    shoot_count: 1,
    income: 0,
    tasks: [
      { name: '拍作品视频发布到抖音', reward_text: '拍特效视频得 1 次抽奖机会', status: 1, finish_count: 1 },
      { name: '按照脚本拍摄同款视频', reward_text: null, status: 1, finish_count: 0 },
    ],
    streaks: [
      {
        task_id: 'streak_daily',
        title: '连续创作打卡',
        description: '参与任务广场，连续创作 7 天必得 1.5 元',
        reward_text: '连续 7 天参与达人任务得 1.5 元',
        current: 0,
        steps: [
          { target: 2, bonus_yuan: 0.2 },
          { target: 7, bonus_yuan: 1.5 },
        ],
      },
    ],
    newbie: {
      title: '新手成长任务',
      subtitle: '全部完成立得',
      total_yuan: 10,
      tasks: [
        { task_id: 'newbie_task_1', title: '新手成长必学第一课', status: 1, target: 1, text: '已完成新手成长必学第一课' },
        { task_id: 'newbie_task_2', title: '进入任务广场，参与 5 个任务', status: 0, target: 5, text: null },
      ],
    },
    resets_at: new Date(1794758400000).toISOString(),
    unread: {
      participation_data: { tutor_id: 0 },
      user_level: 0,
      user_layer: 2,
      game_list: [{ game_name: '别的玩法', game_code: 'other', game_status: 0, game_text: '' }],
    },
  });
  assert.deepEqual(to('/cam_api/activity/v1/info')[0].query, {});
});

const script = (id, tag, extra = {}) => ({ name: `【测一测】脚本${id}`, desc: '脚本解读：…\n尝试拍一个：…', script_pic: `https://cdn/${id}.jpg`, script_url: `https://cdn/${id}.mp4`, script_type: 2, tag: [tag], script_id: Number(id), video_view_cnt: 19253, shoot_num: 3541, script_id_str: id, ...extra });

test('shoot_scripts pages the 拍摄脚本 list by the offset the server hands back and filters by tag code', async () => {
  const { lib, to } = setup({
    'GET /cam_api/activity/v1/script_list': (c) => ok(c.query.tag === '6' ? { script_list: [script('1841800000099', 6)], total: 6, offset: 6 } : { script_list: [script('1841800000011', 1)], total: 48, offset: 1 }),
  });
  assert.deepEqual(await lib.shootScripts({ count: 1 }), {
    tag: null,
    total: 48,
    items: [{ script_id: '1841800000011', name: '【测一测】脚本1841800000011', description: '脚本解读：…\n尝试拍一个：…', type: 2, tags: [1], views: 19253, shoots: 3541, cover_url: 'https://cdn/1841800000011.jpg', video_url: 'https://cdn/1841800000011.mp4' }],
    next_offset: 1,
    has_more: true,
  });
  assert.deepEqual(to('/cam_api/activity/v1/script_list')[0].query, { offset: '0', page_size: '1' });
  const tagged = await lib.shootScripts({ tag: 6, offset: 5 });
  assert.deepEqual([tagged.tag, tagged.items[0].tags, tagged.has_more], [6, [6], false]);
  assert.deepEqual(to('/cam_api/activity/v1/script_list')[1].query, { offset: '5', page_size: '20', tag: '6' });
  await assert.rejects(lib.shootScripts({ tag: 7 }), /INVALID_TAG: 7; valid: 1\(测一测\), 2\(游戏\)/);
  assert.equal(to('/cam_api/activity/v1/script_list').length, 2);
  assert.deepEqual(Object.keys(SCRIPT_TAGS), ['1', '2', '3', '4', '5', '6']);
});

async function connect(deps) {
  const official = { url: 'x', listTools: async () => [], status: () => ({}), callJson: async () => ({ instances: [] }) };
  const server = createServer({ official, ...deps });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test('the discover tools go to the lowest-pid window, lists hand out media refs and arguments are checked', async () => {
  const seen = [];
  const answers = {
    effect_detail: { name: '好友', icon_url: 'https://c/i.png', videos: [{ url: 'https://v/1', cover_url: 'https://c/1.jpeg' }] },
    effect_videos: { videos: [{ title: 't', cover_url: 'https://c/v.jpeg', video_url: 'https://v/2.mp4' }] },
    effect_search: { items: [{ name: '醉美妆', icon_url: 'https://c/z.png' }] },
    inspiration_search: { items: [{ title: '彩妆', cover_url: 'https://c/i.png' }] },
    tutorial_search: { items: [{ title: '课', cover_url: 'https://c/c.png' }] },
    tutorials_list: { items: [{ title: '课', link: 'https://doc/1', cover_url: 'https://c/t.png', video_url: 'https://v/t.mp4' }] },
    shoot_activity: { name: '拍视频激励' },
    shoot_scripts: { items: [{ name: '脚本', cover_url: 'https://c/s.jpg', video_url: 'https://v/s.mp4' }] },
  };
  const client = await connect({
    listInstances: () => [{ pid: 300 }, { pid: 200 }],
    callPlugin: async (method, params, opts) => (seen.push({ method, params, opts }), answers[method]),
    fetchImage: async () => assert.fail('no image may be fetched'),
  });
  const json = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.isError, undefined, `${name}: ${res.content[0].text}`);
    return JSON.parse(res.content[0].text);
  };
  // A detail keeps the addresses of its own pictures and videos.
  assert.deepEqual(await json('effect_detail', { app_effect_id: '273663451' }), answers.effect_detail);
  assert.deepEqual(await json('effect_videos', { effect_id: '88649924', app_effect_id: '273663451' }), { videos: [{ title: 't', cover_ref: 'img:1', video_ref: 'video:2' }] });
  assert.deepEqual(await json('effect_search', { query: '美妆', kind: 'template', cursor: 20, count: SEARCH_MAX }), { items: [{ name: '醉美妆', icon_ref: 'img:3' }] });
  assert.deepEqual(await json('inspiration_search', { query: '美妆' }), { items: [{ title: '彩妆', cover_ref: 'img:4' }] });
  assert.deepEqual(await json('tutorial_search', { query: '美妆', cursor: 3 }), { items: [{ title: '课', cover_ref: 'img:5' }] });
  assert.deepEqual(await json('tutorials_list', { tab_id: 25 }), { items: [{ title: '课', link: 'https://doc/1', cover_ref: 'img:6', video_ref: 'video:7' }] });
  await json('shoot_activity', {});
  assert.deepEqual(await json('shoot_scripts', { tag: 3, count: SCRIPT_MAX }), { items: [{ name: '脚本', cover_ref: 'img:8', video_ref: 'video:9' }] });
  assert.deepEqual(seen, [
    { method: 'effect_detail', params: { app_effect_id: '273663451' }, opts: { pid: 200 } },
    { method: 'effect_videos', params: { effect_id: '88649924', app_effect_id: '273663451' }, opts: { pid: 200 } },
    { method: 'effect_search', params: { query: '美妆', kind: 'template', cursor: 20, count: SEARCH_MAX }, opts: { pid: 200 } },
    { method: 'inspiration_search', params: { query: '美妆' }, opts: { pid: 200 } },
    { method: 'tutorial_search', params: { query: '美妆', cursor: 3 }, opts: { pid: 200 } },
    { method: 'tutorials_list', params: { tab_id: 25 }, opts: { pid: 200 } },
    { method: 'shoot_activity', params: {}, opts: { pid: 200 } },
    { method: 'shoot_scripts', params: { tag: 3, count: SCRIPT_MAX }, opts: { pid: 200 } },
  ]);
  for (const [name, args] of [
    ['effect_detail', { app_effect_id: 'abc' }],
    ['effect_videos', { app_effect_id: '273663451' }],
    ['effect_search', { kind: 'effect' }],
    ['effect_search', { query: '美妆', kind: 'inspiration' }],
    ['effect_search', { query: '美妆', count: SEARCH_MAX + 1 }],
    ['inspiration_search', { query: '美妆', kind: 'effect' }],
    ['inspiration_search', { query: '美妆', count: SEARCH_MAX + 1 }],
    ['tutorial_search', {}],
    ['tutorials_list', { count: 101 }],
    ['tutorials_list', { tab_id: '25' }],
    ['shoot_scripts', { count: SCRIPT_MAX + 1 }],
    ['shoot_activity', { tag: 1 }],
  ]) {
    assert.equal((await client.callTool({ name, arguments: args })).isError, true, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(seen.length, 8);
});
