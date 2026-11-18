import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { createCanvas } from '@napi-rs/canvas';
import { lightMetrics, lightPresetRegions, decodePng } from '../src/measure.mjs';
import { buildImageSheet, trimAlphaPng } from '../src/imagesheet.mjs';
import { imageMetaFromPng, cropBuffer } from '../src/mediainfo.mjs';
import { subsetH5Font, buildH5Bundle } from '../src/h5.mjs';
import { editorFfmpeg } from '../src/editorres.mjs';

function solidPng(w, h, rgba = [255, 0, 0, 255]) {
  const img = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4] = rgba[0];
    img.data[i * 4 + 1] = rgba[1];
    img.data[i * 4 + 2] = rgba[2];
    img.data[i * 4 + 3] = rgba[3];
  }
  return PNG.sync.write(img);
}

function paddedPng() {
  // 100×100 transparent with a 20×20 opaque block at (40,40).
  const img = new PNG({ width: 100, height: 100 });
  img.data.fill(0);
  for (let y = 40; y < 60; y++) {
    for (let x = 40; x < 60; x++) {
      const i = (y * 100 + x) * 4;
      img.data[i] = 10;
      img.data[i + 1] = 20;
      img.data[i + 2] = 30;
      img.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(img);
}

test('imageMetaFromPng and trimAlphaPng report the opaque bbox', () => {
  const buf = paddedPng();
  const meta = imageMetaFromPng(buf);
  assert.deepEqual(meta.alpha_bbox, { x: 40, y: 40, width: 20, height: 20 });
  const trimmed = trimAlphaPng(buf);
  assert.equal(trimmed.after.width, 20);
  assert.equal(trimmed.after.height, 20);
  assert.equal(trimmed.trimmed, true);
});

test('cropBuffer cuts by 0–1 box', async () => {
  const buf = solidPng(100, 100, [0, 128, 255, 255]);
  const out = await cropBuffer(buf, 'image/png', { x: 0.1, y: 0.2, width: 0.5, height: 0.4 });
  assert.equal(out.width, 50);
  assert.equal(out.height, 40);
});

test('buildImageSheet lays out tiles and can resize', async () => {
  const a = solidPng(80, 120, [255, 0, 0, 255]);
  const b = solidPng(80, 120, [0, 255, 0, 255]);
  const sheet = await buildImageSheet({ items: [{ buf: a, label: 'A' }, { buf: b, label: 'B' }], columns: 2, tile_height: 60 });
  assert.equal(sheet.columns, 2);
  assert.equal(sheet.size.height, 60);
  assert.ok(sheet.png.length > 100);
  const resized = await buildImageSheet({ items: [{ buf: a }], resize: { width: 32, height: 32 } });
  assert.deepEqual(resized.size, { width: 32, height: 32 });
});

test('lightPresetRegions H matches light_metrics.py proportions on 720×1280', () => {
  const regions = lightPresetRegions('H', 720, 1280);
  const chin = regions.find((r) => r.label === '下巴');
  assert.deepEqual(
    [Math.round(chin.x * 720), Math.round(chin.y * 1280), Math.round((chin.x + chin.width) * 720), Math.round((chin.y + chin.height) * 1280)],
    [330, 745, 400, 775],
  );
});

test('lightMetrics returns cheek ratio on a gradient frame', () => {
  const canvas = createCanvas(720, 1280);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 720, 1280);
  ctx.fillStyle = '#c0c0c0';
  ctx.fillRect(330, 745, 70, 30);
  const buf = canvas.toBuffer('image/png');
  const m = lightMetrics(decodePng(buf), { preset: 'H' });
  assert.ok(m.regions['下巴'] > m.regions['画面左颊']);
  assert.ok(m.chin_over_cheek > 1);
});

test('buildH5Bundle reports a structured error when skills are missing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-h5-missing-'));
  try {
    fs.writeFileSync(path.join(tmp, 'brief.json'), '{}');
    const out = await buildH5Bundle({
      source_dir: tmp,
      brief_path: path.join(tmp, 'brief.json'),
      project_path: tmp,
      request_id: 'req1',
      skills: path.join(tmp, 'no-skills'),
    });
    assert.equal(out.outcome, 'error');
    assert.match(out.diagnostics.message, /H5_SKILLS_MISSING/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('subsetH5Font rejects relative font paths', async () => {
  await assert.rejects(
    () => subsetH5Font({ font_path: 'rel.ttf', license_path: '/tmp/OFL.txt', source_dir: '/tmp', output_name: 'a.woff2' }),
    /FONT_PATH_NOT_ABSOLUTE/,
  );
});

test('像塑 ffmpeg is reachable for media tools when the app is installed', () => {
  try {
    const bin = editorFfmpeg();
    assert.ok(fs.existsSync(bin));
  } catch (e) {
    assert.match(String(e.message), /EDITOR_FFMPEG_NOT_FOUND/);
  }
});

// Negative: wrong preset must fail closed.
test('lightMetrics rejects unknown presets', () => {
  const img = decodePng(solidPng(10, 10));
  assert.throws(() => lightMetrics(img, { preset: 'Z' }), /UNKNOWN_LIGHT_PRESET/);
});
