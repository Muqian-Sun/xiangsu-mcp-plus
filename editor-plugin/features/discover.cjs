'use strict';
// Other creators' effects and the platform's own guides, read through the 像塑 mobile app's endpoints
// (v17.7.0 Android package): effect details and videos, the app's search, tutorials, the 拍视频激励
// activity with its shooting scripts, and the 做同款 project an effect points to. Requests go out the
// way the community feature sends them: the editor's login cookie plus its signing headers.
const { request, requireId, str, iso, appEffectId, slimInspiration, DOUYIN_APP_ID } = require('./community.cjs');

// discover_effect_detail answers 「请求参数错误」 without effect_source, but any value (0, 1, 2, 3, 5 and 6
// tried on 2026-11-09) returns the same effect and the answer carries its real source.
const ANY_SOURCE = 1;
// Picked: one effect (284648191, the top of a board) ran past the usual 15 s twice in a row while
// others answered at once (2026-11-09).
const EFFECT_DETAIL_TIMEOUT_MS = 45000;
// The app's search types, read off live answers (2026-11-09): each type fills one of the answer's lists.
const SEARCH_TYPES = { effect: 2, template: 4, inspiration: 3, tutorial: 1 };
const EFFECT_SEARCH_KINDS = ['effect', 'template'];
// The search answers code 1014 (「网络开小差了」) above 20 a page (30, 40 and 50 tried on 2026-11-09).
const SEARCH_MAX = 20;
// Shooting script tags as the 【…】 prefixes of the scripts each one returned (2026-11-09, all 48 scripts).
// No name for them was found in the app, so the tags pass as codes.
const SCRIPT_TAGS = { 1: '测一测', 2: '游戏', 3: '美妆为主，含两条变形', 4: '变形为主，含一条美妆', 5: 'AI', 6: '技巧' };
// Picked: a page of 50 brought back all 48 scripts (2026-11-09); more was not tried.
const SCRIPT_MAX = 50;
// The tutorial list dates a course by its Beijing day ("2025-07-13"); the search sends the same course's
// time in ms (1752404263000, 18:57 that day in Beijing).
const BEIJING_MS = 8 * 3600 * 1000;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const num = (s) => (s === undefined || s === null || s === '' ? null : Number(s));
const nonEmpty = (o) => Object.keys(o).length > 0;

function beijingDay(v) {
  if (v === undefined || v === null || v === '') return null;
  return /^\d{10,}$/.test(String(v)) ? new Date(Number(v) + BEIJING_MS).toISOString().slice(0, 10) : String(v);
}

function slimSearchEffect(e) {
  return {
    effect_id: str(e.effect_id_str ?? e.effect_id),
    app_effect_id: appEffectId(e),
    name: e.name,
    description: e.instructions || '',
    level_code: e.level ?? null,
    young_like_score: e.young_score ?? null,
    publish_total_text: str(e.all_pub),
    icon_url: e.icon || null,
  };
}

// Tutorials are videos (tutorial_video) or documents (tutorial_link, Feishu docs).
function slimTutorial(c) {
  return {
    tutorial_id: String(c.id),
    title: c.name,
    label: c.tutorial_num_text || null,
    study_text: c.study_num_text || null,
    author: c.username || null,
    online_date: beijingDay(c.online_date),
    paid: !!c.need_pay,
    link: c.tutorial_link || null,
    cover_url: c.tutorial_img || null,
    video_url: c.tutorial_video || null,
  };
}

function slimScript(s) {
  return {
    script_id: str(s.script_id_str ?? s.script_id),
    name: s.name,
    description: s.desc || '',
    type: s.script_type ?? null,
    tags: s.tag || [],
    views: s.video_view_cnt ?? null,
    shoots: s.shoot_num ?? null,
    cover_url: s.script_pic || null,
    video_url: s.script_url || null,
  };
}

const methods = {
  // The 发现 page's effect detail, for any online effect or template.
  async effectDetail({ app_effect_id } = {}) {
    const id = requireId(app_effect_id, 'INVALID_APP_EFFECT_ID');
    const d = (await request(this, 'GET_EFFECT_DETAIL', '/effectcam/v2/discover_effect_detail', { query: { app_effect_id: id, app_effect_id_str: id, effect_source: ANY_SOURCE }, timeoutMs: EFFECT_DETAIL_TIMEOUT_MS })) || {};
    // Unknown ids are refused with code 3000 (「特效不存在」) before this.
    const { base, data, project, designer, videos, effect_tags, ...rest } = d;
    const { effect_name, effect_icon, app_effect_id: _id, app_effect_id_str: _idStr, id: effectId, type_desc, first_online_at, effect_desc, ...baseRest } = base;
    const {
      level,
      young_like_score,
      male_like_score,
      hot_play_score,
      male_pub_rate,
      female_pub_rate,
      age_desc,
      gender_desc,
      style_type,
      effect_type,
      all_pub_val,
      like_cnt_all,
      comment_cnt_all,
      tool_source,
      effect_flow,
      ...dataRest
    } = data || {};
    const { fn_types, ...projectRest } = project || {};
    const unread = { ...rest };
    if (nonEmpty(baseRest)) unread.base = baseRest;
    if (nonEmpty(dataRest)) unread.data = dataRest;
    if (nonEmpty(projectRest)) unread.project = projectRest;
    return {
      app_effect_id: id,
      effect_id: str(effectId),
      name: effect_name,
      type: type_desc || null,
      description: effect_desc || '',
      online_at: iso(first_online_at),
      icon_url: effect_icon || null,
      level_code: level ?? null,
      publish_total_text: str(all_pub_val),
      likes_total_text: str(like_cnt_all),
      comments_total_text: str(comment_cnt_all),
      young_like_score: young_like_score ?? null,
      male_like_score: male_like_score ?? null,
      hot_play_score: hot_play_score ?? null,
      male_rate: male_pub_rate ?? null,
      female_rate: female_pub_rate ?? null,
      audience: { age: age_desc || null, gender: gender_desc || null },
      style: style_type || null,
      category: effect_type && effect_type.name ? { id: str(effect_type.id), name: effect_type.name } : null,
      tool: tool_source || null,
      traffic_text: (effect_flow && effect_flow.status_desc) || null,
      functions: fn_types ? fn_types.map((f) => f.name) : null,
      designer: designer ? { uid: str(designer.designer_id), name: designer.name || null, level_name: designer.ly_name || null } : null,
      tags: effect_tags || [],
      videos: (videos || []).map((v) => ({ video_url: v.video_url || null, cover_url: v.video_img || null, likes: str(v.video_digg) })),
      unread,
    };
  },

  // The 作品详情 page's video cards. Its 优秀视频 list repeated the 作品视频 (5 of 5, same addresses,
  // 2026-11-09) and adds each video's 抖音 item id and untruncated title, so the two are merged.
  async effectVideos({ effect_id, app_effect_id } = {}) {
    const query = { effect_id: requireId(effect_id, 'INVALID_EFFECT_ID'), app_effect_id: requireId(app_effect_id, 'INVALID_APP_EFFECT_ID'), app_id: DOUYIN_APP_ID };
    const d = (await request(this, 'GET_EFFECT_VIDEOS', '/cam_api/effect/v2/videos', { query })) || {};
    const { effect_video, hot_video, author_video, ...rest } = d;
    const ev = effect_video || {};
    const hot = new Map(((hot_video && hot_video.ExcellentVideoList) || []).map((v) => [v.url, v]));
    const video = (url, v, h = {}) => ({
      item_id: str(h.item_id),
      title: h.video_title || v.video_title || '',
      author: v.video_username || h.video_author || null,
      likes_text: str(v.video_digg ?? h.digg_str),
      follow_shoot_text: str(v.video_follow_shoot ?? h.follow_pub_str),
      cover_url: v.video_img || h.icon || null,
      video_url: url || null,
    });
    const videos = (ev.videos || []).map((v) => {
      const h = hot.get(v.video_url);
      hot.delete(v.video_url);
      return video(v.video_url, v, h);
    });
    for (const [url, h] of hot) videos.push(video(url, {}, h));
    const unread = { ...rest };
    if (author_video) unread.author_video = author_video;
    return {
      effect_id: query.effect_id,
      app_effect_id: query.app_effect_id,
      likes_total_text: str(ev.like_cnt_all),
      follow_shoot_total_text: str(ev.follow_shoot_cnt_all),
      videos,
      ...(nonEmpty(unread) ? { unread } : {}),
    };
  },

  // One page of the app's search page; `cursor` is an offset the server hands back.
  async searchPage(type, list, slim, { query, cursor = 0, count = SEARCH_MAX } = {}) {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) throw Error('INVALID_QUERY: pass a non-empty query');
    const d = (await request(this, 'SEARCH', '/cam_api/search/v1/search_list', { query: { type, content: q, cursor, count } })) || {};
    // The server can ignore `count` and hand back everything left while its cursor moves on by `count`
    // only (8 results, cursor 3, for count 3), so the next page starts past whichever is further.
    const found = d[list] || [];
    const next = Math.max(d.cursor ?? 0, cursor + found.length);
    const total = d.total ?? null;
    return { query: q, total, items: found.map(slim), next_cursor: next, has_more: found.length > 0 && total !== null && next < total };
  },

  async effectSearch({ kind = 'effect', ...params } = {}) {
    if (!EFFECT_SEARCH_KINDS.includes(kind)) throw Error(`INVALID_KIND: ${kind}; valid: ${EFFECT_SEARCH_KINDS.join(', ')}`);
    return { kind, ...(await this.searchPage(SEARCH_TYPES[kind], 'effect_list', slimSearchEffect, params)) };
  },

  inspirationSearch(params) {
    return this.searchPage(SEARCH_TYPES.inspiration, 'insp_list', slimInspiration, params);
  },

  tutorialSearch(params) {
    return this.searchPage(SEARCH_TYPES.tutorial, 'course_list', slimTutorial, params);
  },

  // The 教程 page: its tabs, and one tab's courses (every course without a tab), paged here.
  async tutorialsList({ tab_id, offset = 0, count = 20 } = {}) {
    const groups = (await request(this, 'GET_TUTORIAL_TABS', '/cam_api/course/v2/tabs')) || [];
    const tabs = groups.flatMap((g) => (g.course_tabs || []).map((t) => ({ tab_id: t.id, name: t.name, group: g.tab_type })));
    const tab = tab_id === undefined ? null : tabs.find((t) => t.tab_id === tab_id);
    if (tab === undefined) throw Error(`INVALID_TAB_ID: ${tab_id}; valid: ${tabs.map((t) => `${t.tab_id}(${t.group} › ${t.name})`).join(', ')}`);
    const all = ((await request(this, 'GET_TUTORIALS', '/cam_api/course/v1/list', { query: { tab_id } })) || []).map(slimTutorial);
    const end = offset + count;
    return { tab, tabs, total: all.length, items: all.slice(offset, end), next_offset: end, has_more: end < all.length };
  },

  // The 拍视频激励 activity card: this period's tasks, the shooting streak and the newbie tasks.
  async shootActivity() {
    const d = (await request(this, 'GET_SHOOT_ACTIVITY', '/cam_api/activity/v1/info')) || {};
    const { activity_id, activity_name, start_time, end_time, status, shoot_num, income_amount, task_list, user_shoot_activity_list, user_reward_task, game_list, next_reset_timestamp, server_time, ...unread } = d;
    // game_list repeats the newbie tasks (game_code = task_id) with the text the card shows for each.
    const games = new Map((game_list || []).map((g) => [g.game_code, g]));
    const newbie = user_reward_task
      ? {
          title: user_reward_task.title || '',
          subtitle: user_reward_task.sub_title || null,
          total_yuan: num(user_reward_task.total_amount_yuan),
          tasks: (user_reward_task.task_list || []).map((t) => {
            const g = games.get(t.task_id);
            games.delete(t.task_id);
            return { task_id: str(t.task_id), title: t.title || '', status: t.status ?? null, target: t.target_num ?? null, text: (g && g.game_text) || null };
          }),
        }
      : null;
    if (games.size) unread.game_list = [...games.values()];
    return {
      activity_id: str(activity_id),
      name: activity_name || null,
      start_at: iso(start_time),
      end_at: iso(end_time),
      status: status ?? null,
      shoot_count: shoot_num ?? null,
      income: income_amount ?? null,
      tasks: (task_list || []).map((t) => ({ name: t.task_name || '', reward_text: t.custom_name || null, status: t.status ?? null, finish_count: t.finish_count ?? null })),
      streaks: (user_shoot_activity_list || []).map((s) => ({
        task_id: str(s.task_id),
        title: s.task_title || '',
        description: s.task_desc || '',
        reward_text: s.custom_name || null,
        current: s.cur_num ?? null,
        steps: (s.shoot_task_process || []).map((p) => ({ target: p.target_num ?? null, bonus_yuan: num(p.bonus_amount_yuan) })),
      })),
      newbie,
      resets_at: next_reset_timestamp ? iso(next_reset_timestamp * 1000) : null,
      unread,
    };
  },

  // The 拍摄脚本 list: how to shoot a video with an effect, with views and shoots of each script.
  async shootScripts({ tag, offset = 0, count = 20 } = {}) {
    if (tag !== undefined && !hasOwn(SCRIPT_TAGS, tag)) throw Error(`INVALID_TAG: ${tag}; valid: ${Object.entries(SCRIPT_TAGS).map(([k, n]) => `${k}(${n})`).join(', ')}`);
    const d = (await request(this, 'GET_SHOOT_SCRIPTS', '/cam_api/activity/v1/script_list', { query: { offset, page_size: count, tag } })) || {};
    const list = d.script_list || [];
    const next = d.offset ?? offset + list.length;
    const total = d.total ?? null;
    return { tag: tag ?? null, total, items: list.map(slimScript), next_offset: next, has_more: list.length > 0 && total !== null && next < total };
  },

  // The project the 做同款 button points to: a homepage work (guide_project_info.id is its template id),
  // which is the effect's own project or another effect's (project_id, project_name). Effects without
  // one come back with no data.
  async sameStyleProject(effect_id) {
    const d = await request(this, 'GET_ITEM_PROJECT', '/cam_api/feed/v1/get_item_project', { query: { effect_id } });
    const guide = d && d.is_available_project && d.guide_project_info && d.guide_project_info.id;
    return guide ? { template_id: String(guide), effect_id: str(d.project_id), name: d.project_name || null } : null;
  },
};

const METHODS = {
  effect_detail: 'effectDetail',
  effect_videos: 'effectVideos',
  effect_search: 'effectSearch',
  inspiration_search: 'inspirationSearch',
  tutorial_search: 'tutorialSearch',
  tutorials_list: 'tutorialsList',
  shoot_activity: 'shootActivity',
  shoot_scripts: 'shootScripts',
};

module.exports = { methods, METHODS, EFFECT_SEARCH_KINDS, SEARCH_MAX, SCRIPT_TAGS, SCRIPT_MAX };
