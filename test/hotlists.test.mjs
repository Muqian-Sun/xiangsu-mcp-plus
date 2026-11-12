import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { baiduHotList, bilibiliHotSearch, bilibiliPopular } from '../src/hotlists.mjs';

// Trimmed from the sites' answers (2026-11-09).
const BAIDU = {
  success: true,
  data: {
    cards: [
      {
        component: 'hotList',
        updateTime: '1794214077',
        topContent: [{ word: '永远做党和人民的忠诚卫士', desc: '置顶摘要', hotScore: '7904419', hotTag: '0', img: 'https://fyb/top.png', url: 'https://www.baidu.com/s?wd=top' }],
        content: [
          { index: 0, word: '为什么小电驴也卖不动了', desc: '销量同比下降', hotScore: '7808700', hotTag: '0', img: 'https://fyb/1.png', url: 'https://www.baidu.com/s?wd=1' },
          { index: 1, query: '“99人的群里 98个都是托”', desc: '', hotScore: '', hotTag: '3', url: 'https://www.baidu.com/s?wd=2' },
        ],
      },
    ],
  },
  error: {},
};
const POPULAR = {
  code: 0,
  data: {
    no_more: false,
    list: [
      {
        title: '【2026全球总决赛】11月9日 BLG vs T1',
        bvid: 'BV1TgWp6MEHJ',
        pic: 'http://i0.hdslb.com/a.jpg',
        tname: '电子竞技',
        pubdate: 1794178689,
        duration: 15510,
        owner: { mid: 50329118, name: '哔哩哔哩英雄联盟赛事' },
        stat: { view: 7430341, like: 92730, reply: 45055, danmaku: 86654 },
        rcmd_reason: { content: '百万播放', corner_mark: 0 },
      },
      { title: '无统计', bvid: 'BV2', owner: null },
    ],
  },
};
const HOTWORD = {
  code: 0,
  timestamp: 1794214154,
  list: [
    { pos: 1, keyword: '喵仙人锐评BLG淘汰T1', show_name: '喵仙人锐评BLG淘汰T1', heat_score: 13974223, icon: 'http://i0.hdslb.com/new.png' },
    { pos: 2, keyword: 'knight', show_name: '', heat_score: 3773372 },
  ],
};

function fakeFetch(table) {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    const hit = Object.entries(table).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw Error(`unexpected ${url}`);
    return typeof hit[1] === 'function' ? hit[1](url) : structuredClone(hit[1]);
  };
  return { fetch, urls };
}

test('baidu_hot_list reads the PC 热搜榜 with its pinned entry, summaries and heat', async () => {
  const { fetch, urls } = fakeFetch({ 'https://top.baidu.com/api/board': BAIDU });
  assert.deepEqual(await baiduHotList(fetch), {
    updated_at: new Date(1794214077000).toISOString(),
    pinned: [{ rank: null, word: '永远做党和人民的忠诚卫士', description: '置顶摘要', heat: 7904419, tag_code: '0', image_url: 'https://fyb/top.png', link: 'https://www.baidu.com/s?wd=top' }],
    items: [
      { rank: 1, word: '为什么小电驴也卖不动了', description: '销量同比下降', heat: 7808700, tag_code: '0', image_url: 'https://fyb/1.png', link: 'https://www.baidu.com/s?wd=1' },
      { rank: 2, word: '“99人的群里 98个都是托”', description: '', heat: null, tag_code: '3', image_url: null, link: 'https://www.baidu.com/s?wd=2' },
    ],
  });
  assert.deepEqual(urls, ['https://top.baidu.com/api/board?platform=pc&tab=realtime']);
  const down = fakeFetch({ 'https://top.baidu.com': { success: false, error: { code: 1 } } });
  await assert.rejects(baiduHotList(down.fetch), /BAIDU_HOT_LIST_FAILED: \{"code":1\}/);
  const odd = fakeFetch({ 'https://top.baidu.com': { success: true, data: { cards: [{ component: 'tabTextList' }] } } });
  await assert.rejects(baiduHotList(odd.fetch), /the board has no hotList card/);
});

test('bilibili_popular pages the 热门 videos and bilibili_hot_search reads the hot words', async () => {
  const { fetch, urls } = fakeFetch({
    'https://api.bilibili.com/x/web-interface/popular': (url) => (new URL(url).searchParams.get('pn') === '2' ? { code: 0, data: { no_more: true, list: [] } } : structuredClone(POPULAR)),
    'https://s.search.bilibili.com/main/hotword': HOTWORD,
  });
  assert.deepEqual(await bilibiliPopular({}, fetch), {
    page: 1,
    items: [
      {
        title: '【2026全球总决赛】11月9日 BLG vs T1',
        bvid: 'BV1TgWp6MEHJ',
        link: 'https://www.bilibili.com/video/BV1TgWp6MEHJ',
        cover_url: 'http://i0.hdslb.com/a.jpg',
        category: '电子竞技',
        author: '哔哩哔哩英雄联盟赛事',
        views: 7430341,
        likes: 92730,
        comments: 45055,
        danmaku: 86654,
        duration_sec: 15510,
        published_at: new Date(1794178689000).toISOString(),
        reason: '百万播放',
      },
      { title: '无统计', bvid: 'BV2', link: 'https://www.bilibili.com/video/BV2', cover_url: null, category: null, author: null, views: null, likes: null, comments: null, danmaku: null, duration_sec: null, published_at: null, reason: null },
    ],
    next_page: 2,
    has_more: true,
  });
  const last = await bilibiliPopular({ page: 2, count: 50 }, fetch);
  assert.deepEqual([last.next_page, last.has_more], [null, false]);
  assert.deepEqual(urls, ['https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1', 'https://api.bilibili.com/x/web-interface/popular?ps=50&pn=2']);
  assert.deepEqual(await bilibiliHotSearch(fetch), {
    updated_at: new Date(1794214154000).toISOString(),
    items: [
      { rank: 1, keyword: '喵仙人锐评BLG淘汰T1', show_name: '喵仙人锐评BLG淘汰T1', heat: 13974223 },
      { rank: 2, keyword: 'knight', show_name: 'knight', heat: 3773372 },
    ],
  });
  const blocked = fakeFetch({ 'https://api.bilibili.com': { code: -352, message: '-352' }, 'https://s.search.bilibili.com': { code: -400, message: '请求错误' } });
  await assert.rejects(bilibiliPopular({}, blocked.fetch), /BILIBILI_POPULAR_FAILED: code=-352 message=-352/);
  await assert.rejects(bilibiliHotSearch(blocked.fetch), /BILIBILI_HOT_SEARCH_FAILED: code=-400 message=请求错误/);
});

test('the outside hot list tools answer through the injected fetcher, need no editor window, and hand out refs', async () => {
  const { fetch, urls } = fakeFetch({ 'https://top.baidu.com': BAIDU, 'https://api.bilibili.com': POPULAR, 'https://s.search.bilibili.com': HOTWORD });
  const official = { url: 'x', listTools: async () => [], status: () => ({}), callJson: async () => ({ instances: [] }) };
  const server = createServer({ frontApp: async () => null, activateApp: async () => { throw Error('activateApp called in a test'); }, official, fetchJson: fetch, listInstances: () => [], callPlugin: async () => assert.fail('no window needed') });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const baidu = await call('baidu_hot_list');
  assert.equal(baidu.items[0].image_ref, 'img:2');
  assert.deepEqual([baidu.total, baidu.items.length, baidu.next_offset, baidu.has_more], [2, 2, 20, false]);
  assert.equal((await call('bilibili_popular', { page: 1, count: 5 })).items[0].cover_ref, 'img:3');
  assert.equal((await call('bilibili_hot_search')).items.length, 2);
  assert.deepEqual(urls.slice(1, 2), ['https://api.bilibili.com/x/web-interface/popular?ps=5&pn=1']);
  const second = await call('baidu_hot_list', { offset: 1, count: 1 });
  assert.deepEqual([second.items.map((i) => i.rank), second.has_more, second.pinned.length], [[2], false, 1]);
  const { tools } = await client.listTools();
  // The site answers -400 above 50 a page (2026-11-09).
  assert.equal(tools.find((t) => t.name === 'bilibili_popular').inputSchema.properties.count.maximum, 50);
  assert.equal((await client.callTool({ name: 'bilibili_popular', arguments: { count: 51 } })).isError, true);
});
