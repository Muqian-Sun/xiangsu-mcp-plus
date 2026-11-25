import test from 'node:test';
import './tmp.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { submitPage } = require('../editor-plugin/features/webpages.cjs');

test('submit state reports the actual DOM and stalled assets with URL secrets removed', async () => {
  const dom = new JSDOM(`<!doctype html><title>提交特效</title><main><div class="upload-icon-wrapper"><div class="icon-bottom female">加载中</div></div><div class="name-wrapper"><input></div><div class="text-err">图标加载失败</div></main><script src="https://cdn.example.test/pending.js?token=script-secret"></script><img src="https://cdn.example.test/icon.png?signature=image-secret">`, { url: 'https://effect.example.test/ac/submit?account=private', runScripts: 'outside-only' });
  dom.window.performance.getEntriesByType = () => [{ name: 'https://api.example.test/config?token=config-secret', initiatorType: 'fetch', duration: 14.2, transferSize: 0, responseStatus: 503 }];
  try {
    const state = await dom.window.eval(`(${submitPage})({action:'state'})`);
    assert.deepEqual(JSON.parse(JSON.stringify(state.diagnostics)), {
      page: 'https://effect.example.test/ac/submit', title: '提交特效', icon_sections: 1,
      icon_status: [{ class: 'icon-bottom female', children: 0, text: '加载中' }], errors: ['图标加载失败'], api_resources: [],
      pending_assets: [{ kind: 'script', url: 'https://cdn.example.test/pending.js' }, { kind: 'image', url: 'https://cdn.example.test/icon.png', complete: false }],
      last_resources: [{ url: 'https://api.example.test/config', kind: 'fetch', duration_ms: 14, bytes: 0, status: 503 }],
    });
  } finally {
    dom.window.close();
  }
});

test('submit diagnostics replay only the observed task URL and report its code without response contents', async () => {
  const dom = new JSDOM('<!doctype html>', { url: 'https://effect.example.test/ac/submit', runScripts: 'outside-only' });
  const requested = 'https://api.example.test/creator/v1/effect_task_list?account=private';
  const calls = [];
  dom.window.performance.getEntriesByType = () => [{ name: requested }];
  dom.window.fetch = async (url, options) => { calls.push({ url, credentials: options.credentials }); return { status: 200, json: async () => ({ code: 10002, data: { private: 'do not collect' } }) }; };
  try {
    const state = await dom.window.eval(`(${submitPage})({action:'diagnose',wait_ms:100})`);
    assert.deepEqual({ calls, probe: JSON.parse(JSON.stringify(state.diagnostics.task_probe)) }, {
      calls: [{ url: requested, credentials: 'include' }], probe: { attempted: true, status: 200, code: 10002, count: null },
    });
  } finally {
    dom.window.close();
  }
});
