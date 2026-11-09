'use strict';
// Douyin music from the editor's music library: categories, a page of a category or a search, and
// using a track as the effect's music the way the library's 使用 button does.
const { M } = require('./common.cjs');

// The list model's own requests never settle when it is already busy or out of pages; a fresh model
// is used per call, so this only guards against the service hanging. Picked, not measured.
const MUSIC_REQUEST_TIMEOUT_MS = 20000;

function withTimeout(promise, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`MUSIC_TIMEOUT: ${what}`)), MUSIC_REQUEST_TIMEOUT_MS);
    }),
  ]);
}

function slimMusic(m) {
  return {
    music_id: String(m.id),
    title: m.title || '',
    author: m.author || '',
    duration_sec: m.duration ?? null,
    cover_url: (m.cover || [])[0] || null,
    preview_url: (m.fileUrl || [])[0] || null,
    has_copyright: m.hasCopyright ?? null,
  };
}

function page(list) {
  const raw = (list || []).filter((m) => m && m.id);
  return { items: raw.map(slimMusic), raw };
}

// A fresh list model starts at the first page; one that should start further on gets the cursor the
// previous page's answer carried, as the model itself keeps it between pages. After the request the
// model holds the next cursor and whether more follow.
function startAt(list, cursor) {
  if (cursor !== undefined) list.cursorInfo.next({ cursor, count: list.pageSize, hasMore: true });
}
function nextPage(list) {
  const c = list.cursorInfo.getValue() || {};
  return { next_cursor: c.cursor ?? null, has_more: !!c.hasMore };
}

const methods = {
  async musicCategories() {
    this.ensureCompatible('music');
    const cats = await withTimeout(new (this.mod(M.musicCategory).MusicCategoryModel)().updateCategoryList(), 'categories');
    return { categories: (cats || []).map((c) => ({ code: c.codeCategory, name: c.name })) };
  },

  async musicList({ category_code, cursor } = {}) {
    this.ensureCompatible('music');
    if (typeof category_code !== 'string' || !category_code) throw Error('INVALID_CATEGORY: pass category_code from music_categories');
    const categories = new (this.mod(M.musicCategory).MusicCategoryModel)();
    const list = new (this.mod(M.musicList).MusicListModel)(categories);
    list.requestTimestamp = String(Date.now());
    categories.setSelectedCategory({ codeCategory: category_code });
    startAt(list, cursor);
    const got = page(await withTimeout(list.getNextMusicListForDouyin(), 'list'));
    return { category_code, ...got, ...nextPage(list) };
  },

  async musicSearch({ query, cursor } = {}) {
    this.ensureCompatible('music');
    if (typeof query !== 'string' || !query.trim()) throw Error('INVALID_QUERY: query must be a non-empty string');
    const list = new (this.mod(M.musicList).MusicListModel)(new (this.mod(M.musicCategory).MusicCategoryModel)());
    list.requestTimestamp = String(Date.now());
    startAt(list, cursor);
    const got = page(await withTimeout(list.getNextSearchMusicListForDouyin(query.trim()), 'search'));
    return { query: query.trim(), ...got, ...nextPage(list) };
  },

  // `item` is a raw track from music_list or music_search. The library only applies a track with a clip range set;
  // start/end default to the whole track.
  async musicApply({ item, category_code, start_sec, end_sec }) {
    this.ensureCompatible('music');
    if (!item || !item.id) throw Error('INVALID_MUSIC: pass the raw track returned by music_list or music_search');
    const EF = this.mod(M.ef);
    if (!EF.ProjectManager.getInstance().hasActiveProject()) throw Error('NO_ACTIVE_PROJECT');
    const start = start_sec ?? 0;
    const end = end_sec ?? item.duration;
    if (typeof end !== 'number' || !(end > start)) throw Error(`INVALID_RANGE: start ${start}, end ${end}`);
    const ok = await this.mod(M.musicSquare).MusicSquareManager.instance.setDouyinMusicInfo({ ...item, startTime: start, endTime: end }, category_code);
    if (!ok) throw Error(`MUSIC_APPLY_FAILED: ${item.id} (the editor shows the reason in a dialog)`);
    return { music_id: String(item.id), title: item.title, start_sec: start, end_sec: end };
  },
};

const METHODS = { music_categories: 'musicCategories', music_list: 'musicList', music_search: 'musicSearch', music_apply: 'musicApply' };

module.exports = { methods, METHODS, slimMusic };
