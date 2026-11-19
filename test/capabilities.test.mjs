import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { tmpdir } from './tmp.mjs';
import { CAPABILITIES_RESOURCE_URI, CAPABILITY_INSTRUCTIONS, CapabilityAtlas } from '../src/capabilities.mjs';
import { createServer } from '../src/server.mjs';

test('CapabilityAtlas serves baseline offline, persists versioned snapshots, and loads cached menu offline', () => {
  const dir = tmpdir('xs-atlas-');
  const atlas = new CapabilityAtlas({ stateDir: dir, editorVersion: '9.8.3', now: () => new Date('2026-11-19T00:00:00Z') });

  const base = atlas.overview();
  assert.equal(base.source, 'baseline');
  assert.equal(base.editor_version, '9.8.3');
  assert.ok(base.menu_total > 50);
  assert.ok(base.categories.Face);
  assert.ok(base.categories.PetEffect);
  assert.ok(Array.isArray(base.ai_pipelines) && base.ai_pipelines.length >= 6);

  // Record live menu + library panels -> persists versioned snapshot file
  atlas.recordMenu([
    { menu_id: 'HeadSegmentationObjectTwoDNewV2', name: '2D头部分割', path: 'Body/人体分割', kind: 'builtin' },
    { menu_id: 'SausageLips', name: '香肠嘴', path: 'AIEffectMenu/表情生成', kind: 'package' },
    { menu_id: 'CustomNew984', name: '新测试组件', path: 'Social', kind: 'builtin' },
  ]);
  atlas.recordLibraryPanels([{ panel_key: '3d_filter', name: '滤镜', categories: ['复古', '胶片'] }]);
  assert.ok(fs.existsSync(atlas.cacheFile('9.8.3')));

  // New instance on same stateDir reads cached snapshot offline without any editor
  const atlas2 = new CapabilityAtlas({ stateDir: dir, editorVersion: '9.8.3' });
  const cached = atlas2.overview();
  assert.equal(cached.source, 'cache');
  assert.equal(cached.menu_total, 3);
  assert.equal(cached.library_panels[0].panel_key, '3d_filter');
  assert.ok(atlas2.search({ query: '新测试组件' }).items.some((x) => x.menu_id === 'CustomNew984'));
});

test('CapabilityAtlas semantic play-intent lookup and fromFunctions reverse mapping work accurately', () => {
  const dir = tmpdir('xs-atlas-sem-');
  const atlas = new CapabilityAtlas({ stateDir: dir, editorVersion: '9.8.3' });

  const prank = atlas.search({ query: '整蛊' });
  assert.ok(prank.items.some((x) => x.menu_id === 'SausageLips' || x.menu_id === 'FaceDistortionEntity'));
  assert.match(prank.items[0].how_to_add, /^menu_add\(menu_id="/);

  const pet = atlas.search({ query: '宠物' });
  assert.ok(pet.items.some((x) => x.menu_id === 'PetFaceTracker'));

  const draw = atlas.search({ query: '涂鸦' });
  assert.ok(draw.items.some((x) => x.menu_id === 'TwoDFingerDrawingEntity'));

  const mapped = atlas.fromFunctions(['2D头部分割', '音频播放', '宠物脸跟踪']);
  assert.equal(mapped.mappings.length, 3);
  assert.ok(mapped.mappings[0].matched.some((m) => m.menu_id === 'HeadSegmentationObjectTwoDNewV2'));
  assert.ok(mapped.mappings[1].matched.some((m) => m.menu_id === 'Audio_Effect'));
  assert.ok(mapped.mappings[2].matched.some((m) => m.menu_id === 'PetFaceTracker'));
});

test('server exposes editor_capabilities tool, xiangsu://capabilities resource, and capability instructions', async () => {
  const dir = tmpdir('xs-atlas-srv-');
  const atlas = new CapabilityAtlas({ stateDir: dir, editorVersion: '9.8.3' });
  let pluginCalls = 0;
  const server = createServer({
    atlas,
    frontApp: async () => null,
    activateApp: async () => {},
    listInstances: () => [{ pid: 42 }],
    official: { listTools: async () => [], status: () => ({ connected: false, tools: 0 }) },
    callPlugin: async (method) => {
      pluginCalls += 1;
      if (method === 'menu_list') {
        return {
          total: 2,
          menu_total: 2,
          items: [
            { menu_id: 'PetFaceTracker', name: '宠物脸跟踪', path: 'PetEffect', kind: 'builtin' },
            { menu_id: 'WeatherCardEntity', name: '天气卡片', path: 'Social', kind: 'builtin' },
          ],
        };
      }
      if (method === 'library_nav') return { panels: [{ panel_key: 'sticker', name: '跟脸贴纸' }] };
      return {};
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);

  // MCP instructions carry the capability map
  assert.match(client.getInstructions() || '', /editor_capabilities/);
  assert.ok(CAPABILITY_INSTRUCTIONS.length < 2200);

  // First call with an open window auto-refreshes from baseline -> cache
  const overview = JSON.parse((await client.callTool({ name: 'editor_capabilities', arguments: {} })).content[0].text);
  assert.equal(overview.source, 'cache');
  assert.equal(overview.menu_total, 2);
  assert.equal(overview.library_panels[0].panel_key, 'sticker');
  assert.equal(pluginCalls, 2);

  // Subsequent call uses cache without hitting plugin again
  const search = JSON.parse((await client.callTool({ name: 'editor_capabilities', arguments: { query: '天气' } })).content[0].text);
  assert.equal(search.items[0].menu_id, 'WeatherCardEntity');
  assert.equal(pluginCalls, 2);

  // MCP Resource xiangsu://capabilities works
  const { resources } = await client.listResources();
  assert.ok(resources.some((r) => r.uri === CAPABILITIES_RESOURCE_URI));
  const res = await client.readResource({ uri: CAPABILITIES_RESOURCE_URI });
  const resJson = JSON.parse(res.contents[0].text);
  assert.equal(resJson.source, 'cache');
  assert.equal(resJson.menu_total, 2);
});
