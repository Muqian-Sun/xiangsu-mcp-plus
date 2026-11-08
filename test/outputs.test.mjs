import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MediaRefs, Spill, withRefs } from '../src/outputs.mjs';

test('refs are short, one per address and kind, and the least recently handed out are forgotten past the cap', () => {
  const refs = new MediaRefs({ max: 2 });
  const a = refs.add('https://c/a.png', 'image');
  assert.equal(a, 'img:1');
  assert.equal(refs.add('https://c/a.png', 'image'), a);
  assert.equal(refs.add('https://c/a.png', 'video'), 'video:2');
  assert.deepEqual(refs.get(a), { url: 'https://c/a.png', kind: 'image' });
  refs.add('https://c/a.png', 'image');
  assert.equal(refs.add('https://c/b.mp3', 'audio'), 'audio:3');
  assert.equal(refs.get('video:2'), null);
  assert.deepEqual(refs.get(a), { url: 'https://c/a.png', kind: 'image' });
  assert.equal(refs.get('img:99'), null);
});

test('withRefs swaps media fields by their name and leaves links and other fields alone', () => {
  const refs = new MediaRefs();
  const out = withRefs(
    {
      items: [
        { title: 't', cover_url: 'https://c/1.png', gif_url: 'https://c/1.gif', icon_url: null, avatar_url: '' },
        { preview_url: 'https://c/s.mp3', tutorial: { video_url: 'https://c/v.mp4' } },
      ],
      content: [{ items: [{ images: ['https://c/2.png', 'blob:x'], videos: ['https://c/v2.mp4'], links: [{ text: '文档', url: 'https://doc' }] }] }],
      images: [{ image_index: 0, image_url: 'https://c/3.png' }],
      next_cursor: 'abc',
    },
    refs,
  );
  assert.deepEqual(out, {
    items: [
      { title: 't', cover_ref: 'img:1', gif_ref: 'img:2', icon_ref: null, avatar_ref: null },
      { preview_ref: 'audio:3', tutorial: { video_ref: 'video:4' } },
    ],
    content: [{ items: [{ image_refs: ['img:5'], video_refs: ['video:6'], links: [{ text: '文档', url: 'https://doc' }] }] }],
    images: [{ image_index: 0, image_ref: 'img:7' }],
    next_cursor: 'abc',
  });
  assert.deepEqual(refs.get('video:4'), { url: 'https://c/v.mp4', kind: 'video' });
});

const answer = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

test('an answer over the limit goes to a file with an outline; short ones, errors and images pass unchanged', () => {
  const dir = tmpdir('spill');
  const spill = new Spill({ stateDir: dir, limit: 100, now: () => Date.parse('2026-11-08T10:00:00Z') });
  const short = answer({ a: 1 });
  assert.equal(spill.apply('t', short), short);
  const error = { content: [{ type: 'text', text: 'x'.repeat(200) }], isError: true };
  assert.equal(spill.apply('t', error), error);
  const image = { content: [{ type: 'text', text: 'x'.repeat(200) }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
  assert.equal(spill.apply('t', image), image);
  const big = { total: 30, next_cursor: 5, items: Array.from({ length: 30 }, (_, i) => ({ id: i, title: `第${i}个` })), note: 'n'.repeat(300) };
  const res = spill.apply('rank_list', answer(big));
  const summary = JSON.parse(res.content[0].text);
  assert.equal(res.content.length, 1);
  assert.match(summary.spilled_to, new RegExp(`^${dir}/outputs/rank_list-2026-11-08T10-00-00-000Z-[0-9a-f]{6}\\.json$`));
  assert.equal(fs.readFileSync(summary.spilled_to, 'utf8'), JSON.stringify(big));
  assert.equal(summary.chars, JSON.stringify(big).length);
  assert.deepEqual(summary.outline, { total: 30, next_cursor: 5, items: { items: 30, item_keys: ['id', 'title'] }, note: `${'n'.repeat(200)}…（共 300 字）` });
  assert.match(summary.note, /超过 100 字/);
  const tree = spill.apply('scene_tree', answer('行\n'.repeat(100)));
  const head = JSON.parse(tree.content[0].text);
  assert.ok(head.spilled_to.endsWith('.txt'));
  assert.equal(head.head, '行\n'.repeat(100));
});

test('spilling sweeps out files older than a day', () => {
  const dir = tmpdir('spill-prune');
  let now = Date.parse('2026-11-08T10:00:00Z');
  const spill = new Spill({ stateDir: dir, limit: 10, now: () => now });
  const first = JSON.parse(spill.apply('a', answer('x'.repeat(20))).content[0].text).spilled_to;
  fs.utimesSync(first, new Date(now - 25 * 3600 * 1000), new Date(now - 25 * 3600 * 1000));
  const fresh = path.join(dir, 'outputs', 'fresh.json');
  fs.writeFileSync(fresh, '{}');
  now += 1000;
  spill.apply('b', answer('y'.repeat(20)));
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(fresh), true);
});
