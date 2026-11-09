// Public hot lists outside 像塑, read without logging in. Each reader takes the JSON fetcher so tests
// can answer for the sites.

// Bilibili answers -352 (risk control) to requests without a browser user agent (2026-11-09).
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
// The popular list takes up to 50 a page; 51 answers -400 (2026-11-09).
export const BILIBILI_POPULAR_MAX = 50;

export async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

const iso = (sec) => (sec ? new Date(Number(sec) * 1000).toISOString() : null);
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// 百度热搜 (top.baidu.com, 热搜榜): the pinned entry first, then the ranked 50. The PC board carries the
// summary, heat and picture that the mobile one leaves out.
export async function baiduHotList(fetch = fetchJson) {
  const out = await fetch('https://top.baidu.com/api/board?platform=pc&tab=realtime');
  if (!out || out.success !== true) throw Error(`BAIDU_HOT_LIST_FAILED: ${JSON.stringify(out && out.error)}`);
  const card = (out.data.cards || []).find((c) => c.component === 'hotList');
  if (!card) throw Error('BAIDU_HOT_LIST_FAILED: the board has no hotList card');
  const item = (e, rank) => ({
    rank,
    word: e.word || e.query || '',
    description: e.desc || '',
    heat: num(e.hotScore),
    tag_code: e.hotTag ?? null,
    image_url: e.img || null,
    link: e.url || null,
  });
  return {
    updated_at: iso(card.updateTime),
    pinned: (card.topContent || []).map((e) => item(e, null)),
    items: (card.content || []).map((e, i) => item(e, i + 1)),
  };
}

function bilibiliData(out, what) {
  if (!out || out.code !== 0) throw Error(`${what}_FAILED: code=${out && out.code} message=${out && out.message}`);
  return out;
}

// B 站「热门」视频, the site's own pick of what is popular now.
export async function bilibiliPopular({ page = 1, count = 20 } = {}, fetch = fetchJson) {
  const { data } = bilibiliData(await fetch(`https://api.bilibili.com/x/web-interface/popular?ps=${count}&pn=${page}`), 'BILIBILI_POPULAR');
  const items = (data.list || []).map((v) => ({
    title: v.title || '',
    bvid: v.bvid,
    link: `https://www.bilibili.com/video/${v.bvid}`,
    cover_url: v.pic || null,
    category: v.tname || null,
    author: (v.owner && v.owner.name) || null,
    views: v.stat ? v.stat.view : null,
    likes: v.stat ? v.stat.like : null,
    comments: v.stat ? v.stat.reply : null,
    danmaku: v.stat ? v.stat.danmaku : null,
    duration_sec: v.duration ?? null,
    published_at: iso(v.pubdate),
    reason: (v.rcmd_reason && v.rcmd_reason.content) || null,
  }));
  return { page, items, next_page: data.no_more ? null : page + 1, has_more: !data.no_more };
}

// B 站搜索框下的热搜词.
export async function bilibiliHotSearch(fetch = fetchJson) {
  const out = bilibiliData(await fetch('https://s.search.bilibili.com/main/hotword'), 'BILIBILI_HOT_SEARCH');
  return {
    updated_at: iso(out.timestamp),
    items: (out.list || []).map((w) => ({ rank: w.pos ?? null, keyword: w.keyword || '', show_name: w.show_name || w.keyword || '', heat: w.heat_score ?? null })),
  };
}
