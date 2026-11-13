import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { maskWords, setSceneLayers } from '../src/scenelayers.mjs';

const entity = (name, a, components, layer = 0) => `  - __class: Entity
    name: !<str> ${name}
    guid: {a: ${a}, b: 1}
    scene: {localId: 1}
    selfvisible: true
    components:
${components}
    layer: ${layer}`;
const camera = (a) => `      - __class: Camera
        name: !<str> ""
        guid: {a: ${a}, b: 2}
        enabled: true
        layerVisibleMask: {__class: DynamicBitset, numBits: 64, values: [1, 0]}
        renderOrder: 0`;
const image = (a) => `      - __class: Image
        name: !<str> ""
        guid: {a: ${a}, b: 2}
        enabled: true`;

// The layout the editor writes (2026-11-13 哈气写字挑战): entities inline in the Scene document, each
// object's own layer at the end of its block, a camera's mask on one line.
function scene(blocks) {
  return ['%YAML 1.1', '--- !Scene &1', 'name: !<str> ""', 'guid: {a: 1, b: 1}', 'entities:', ...blocks, 'renderSetting: {localId: 2}', '--- !RenderSetting &2', 'name: !<str> ""', ''].join('\n');
}

function project(text) {
  const dir = tmpdir('xs-layers-');
  fs.mkdirSync(path.join(dir, 'Assets'));
  fs.writeFileSync(path.join(dir, 'Assets/main.scene'), text);
  return dir;
}

const BASE = scene([entity('擦痕摄像机', 10, camera(11)), entity('笔刷0', 20, image(21)), entity('笔刷1', 30, image(31)), entity('重名', 40, image(41)), entity('重名', 50, image(51))]);

test('scene_set_layer changes only the layer lines and the camera mask, and keeps a backup', () => {
  const dir = project(BASE);
  fs.chmodSync(path.join(dir, 'Assets/main.scene'), 0o640);
  const out = setSceneLayers(dir, { objects: [{ object: '笔刷0', layer: 1 }, { object: '#3', layer: 2 }], cameras: [{ object: '擦痕摄像机', visible_layers: [1, 2] }] });
  assert.equal(fs.statSync(path.join(dir, 'Assets/main.scene')).mode & 0o777, 0o640, 'the file mode is kept');
  const after = fs.readFileSync(path.join(dir, 'Assets/main.scene'), 'utf8').split('\n');
  const before = BASE.split('\n');
  const changed = before.map((l, i) => [i, l, after[i]]).filter(([, a, b]) => a !== b);
  assert.equal(after.length, before.length);
  assert.deepEqual(
    changed.map(([, , b]) => b),
    ['        layerVisibleMask: {__class: DynamicBitset, numBits: 64, values: [6, 0]}', '    layer: 1', '    layer: 2'],
  );
  assert.deepEqual(out.objects, [
    { object: '笔刷0', id: '#2', layer_before: 0, layer: 1 },
    { object: '笔刷1', id: '#3', layer_before: 0, layer: 2 },
  ]);
  assert.deepEqual(out.cameras, [{ object: '擦痕摄像机', id: '#1', visible_layers_before: [0], visible_layers: [1, 2] }]);
  assert.equal(fs.readFileSync(out.backup, 'utf8'), BASE);
});

test('masks past layer 31 go into the second 32-bit word', () => {
  assert.deepEqual(maskWords([0, 33], 64), [1, 2]);
  assert.deepEqual(maskWords([31], 64), [2147483648, 0]);
  assert.throws(() => maskWords([64], 64), /INVALID_LAYER: 64; layers are 0–63/);
  const dir = project(BASE);
  setSceneLayers(dir, { cameras: [{ object: '擦痕摄像机', visible_layers: [33] }] });
  assert.match(fs.readFileSync(path.join(dir, 'Assets/main.scene'), 'utf8'), /values: \[0, 2\]\}/);
});

test('scene_set_layer refuses what it cannot change exactly, and writes nothing then', () => {
  const dir = project(BASE);
  const file = path.join(dir, 'Assets/main.scene');
  assert.throws(() => setSceneLayers(dir, { cameras: [{ object: '笔刷0', visible_layers: [1] }] }), /NOT_A_CAMERA: 笔刷0 has no Camera component \(Image\)/);
  assert.throws(() => setSceneLayers(dir, { objects: [{ object: '没有', layer: 1 }] }), /OBJECT_NOT_FOUND: 没有/);
  assert.throws(() => setSceneLayers(dir, { objects: [{ object: '重名', layer: 1 }] }), /AMBIGUOUS_OBJECT: 重名 matches 2 objects/);
  assert.throws(() => setSceneLayers(dir, {}), /INVALID_ARGUMENTS/);
  assert.equal(fs.readFileSync(file, 'utf8'), BASE);

  const noLayer = project(scene([entity('擦痕摄像机', 10, camera(11)), entity('笔刷0', 20, image(21)).replace('    layer: 0', '')]));
  assert.throws(() => setSceneLayers(noLayer, { objects: [{ object: '笔刷0', layer: 1 }] }), /SCENE_LAYOUT_UNEXPECTED: object 笔刷0 has 0 matching lines/);
});
