'use strict';
// The AI tools of the editor's image editor window (ImageEditor): 超清 (super resolution), 消除 (remove
// what is marked), 重绘 (repaint what is marked from a prompt) and AI 抠图 (subject and body-part cutouts).
// They run the same cloud requests as the window's buttons, without opening it. The mark is the window's:
// the area to change is painted over the image as a green checkerboard (the MCP server draws it).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { M } = require('./common.cjs');

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg'];
// The cutouts extractImage writes next to the subject, by its own names.
const PARTS = ['subject', 'body', 'hair', 'headdress', 'scarf', 'sunglasses'];

function checkImage(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.existsSync(file)) throw Error(`IMAGE_NOT_FOUND: ${file}`);
  if (!IMAGE_EXTS.includes(path.extname(file).toLowerCase())) throw Error(`IMAGE_FORMAT: ${path.basename(file)} is not PNG / JPG / JPEG`);
  return file;
}

const methods = {
  async imageEditRequest(file, reqJson) {
    this.ensureCompatible('imageEdit');
    const scene = this.mod(M.aiEffectApi).AI_SCENE.AIMattingGenPC;
    try {
      return await this.mod(M.imageEditAI).requestImageEditorAIResult({ scene, sourceFilePath: checkImage(file), reqJson });
    } catch (e) {
      throw Error(`IMAGE_AI_FAILED: ${String(e.message || e)}`);
    }
  },

  async imageUpscale({ image_path }) {
    return { output: await this.imageEditRequest(image_path, { algo_type: '超清' }) };
  },

  // image_path already carries the green mark; with a prompt the marked area is repainted, without it removed.
  async imageRepaint({ image_path, prompt }) {
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    return { output: await this.imageEditRequest(image_path, text ? { algo_type: '重绘', prompt: text } : { algo_type: '消除' }), mode: text ? 'repaint' : 'remove' };
  },

  async imageMatting({ image_path }) {
    this.ensureCompatible('imageEdit');
    const file = checkImage(image_path);
    // extractImage caches by this key; the file's content makes a fresh cutout for a changed image.
    const key = `xs_${crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')}`;
    let got;
    try {
      got = await this.mod(M.imageSegmentation).default(file, key);
    } catch (e) {
      throw Error(`IMAGE_AI_FAILED: ${String(e.message || e)}`);
    }
    const parts = Object.fromEntries(PARTS.filter((p) => typeof got[p] === 'string' && fs.existsSync(got[p])).map((p) => [p, got[p]]));
    if (!parts.subject) throw Error('IMAGE_AI_FAILED: the cutout returned no subject image');
    return { parts, folder: got.folderPath };
  },
};

const METHODS = {
  image_upscale: 'imageUpscale',
  image_repaint: 'imageRepaint',
  image_matting: 'imageMatting',
};

module.exports = { methods, METHODS, PARTS };
