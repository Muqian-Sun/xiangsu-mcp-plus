import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.XIANGSU_MCP_EXT_STATE = tmpdir('xs-state-');
const { Library, M } = require('../editor-plugin/library.cjs');

function setup(opts = {}) {
  const root = tmpdir('xs-imgedit-');
  const calls = [];
  const cut = (name) => {
    const p = path.join(root, 'AISeg', name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, name);
    return p;
  };
  const modules = {
    [M.aiEffectApi]: { AI_SCENE: { AIMattingGenPC: 'AIMattingGenPC', AIMattingSave: 'AIMattingSave' } },
    [M.imageEditAI]: {
      requestImageEditorAIResult: async (req) => {
        calls.push(req);
        if (opts.fail) throw Error('生成失败，请稍后重试');
        return path.join(root, 'ai_AIMattingGenPC_1.png');
      },
    },
    [M.imageSegmentation]: {
      default: async (file, key) => {
        calls.push(['extract', path.basename(file), key]);
        // extractImage lists body parts even when the photo has none; only existing files count.
        return { folderPath: path.join(root, 'AISeg'), subject: cut('subject.png'), hair: cut('hair.png'), scarf: path.join(root, 'AISeg/scarf.png'), source: cut('source.png'), mask: 'tos://mask' };
      },
    },
  };
  const lib = new Library((name) => {
    if (!(name in modules)) throw Error(`MODULE_NOT_FOUND: ${name}`);
    return modules[name];
  });
  const image = path.join(root, 'photo.jpg');
  fs.writeFileSync(image, 'jpeg bytes');
  return { lib, calls, image, root };
}

test('upscale, remove and repaint send the image editor’s own requests', async () => {
  const { lib, calls, image } = setup();
  assert.match((await lib.imageUpscale({ image_path: image })).output, /ai_AIMattingGenPC_1\.png$/);
  assert.deepEqual(calls[0], { scene: 'AIMattingGenPC', sourceFilePath: image, reqJson: { algo_type: '超清' } });
  assert.equal((await lib.imageRepaint({ image_path: image })).mode, 'remove');
  assert.deepEqual(calls[1].reqJson, { algo_type: '消除' });
  assert.equal((await lib.imageRepaint({ image_path: image, prompt: '  一朵花  ' })).mode, 'repaint');
  assert.deepEqual(calls[2].reqJson, { algo_type: '重绘', prompt: '一朵花' });
  await assert.rejects(setup({ fail: true }).lib.imageUpscale({ image_path: image }), /IMAGE_AI_FAILED: 生成失败，请稍后重试/);
  await assert.rejects(lib.imageUpscale({ image_path: '/nope.png' }), /IMAGE_NOT_FOUND/);
  const gif = image.replace('.jpg', '.gif');
  fs.writeFileSync(gif, 'x');
  await assert.rejects(lib.imageUpscale({ image_path: gif }), /IMAGE_FORMAT/);
});

test('matting returns the subject and the body parts that exist, cached by the image content', async () => {
  const { lib, calls, image } = setup();
  const out = await lib.imageMatting({ image_path: image });
  assert.deepEqual(Object.keys(out.parts), ['subject', 'hair']);
  const key = calls[0][2];
  assert.match(key, /^xs_[0-9a-f]{40}$/);
  fs.writeFileSync(image, 'other bytes');
  await lib.imageMatting({ image_path: image });
  assert.notEqual(calls[1][2], key, 'a changed image gets a fresh cutout');
});
