// Render layers in a saved project's Assets/main.scene: an object's own `layer` and a camera's
// layerVisibleMask, which the official DSL cannot set (Invalid property name layer). Edited line by line
// in the object's block so the rest of the file stays byte-for-byte as the editor wrote it, then parsed
// back and checked before it is written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { loadScene } from './scenefile.mjs';

const STATE_ROOT = process.env.XIANGSU_MCP_EXT_STATE || path.join(os.homedir(), '.xiangsu-mcp-ext');
const ENTITY = '  - __class: Entity';
const LAYER = /^    layer: (\d+)$/;
const MASK = /^(        layerVisibleMask: \{__class: DynamicBitset, numBits: )(\d+)(, values: \[)([^\]]*)(\]\})$/;
// Picked: how many earlier versions of one project's main.scene are kept.
const KEEP_BACKUPS = 10;

// The entity blocks of the Scene document (the file's first): each from its `  - __class: Entity` line
// up to the next one, the last up to the next top-level key or document.
function entityBlocks(lines) {
  const end = lines.findIndex((l, i) => i > 1 && l.startsWith('--- '));
  const stop = end < 0 ? lines.length : end;
  const starts = [];
  for (let i = 0; i < stop; i++) if (lines[i] === ENTITY) starts.push(i);
  return starts.map((s, k) => {
    if (k + 1 < starts.length) return [s, starts[k + 1]];
    const key = lines.findIndex((l, j) => j > s && j < stop && /^\S/.test(l));
    return [s, key < 0 ? stop : key];
  });
}

function only(lines, [s, e], re, what) {
  const hits = [];
  for (let i = s; i < e; i++) if (re.test(lines[i])) hits.push(i);
  if (hits.length !== 1) throw Error(`SCENE_LAYOUT_UNEXPECTED: ${what} has ${hits.length} matching lines (expected 1)`);
  return hits[0];
}

// DynamicBitset words are 32 bits each, layer 0 the lowest bit of the first.
export function maskWords(layers, numBits) {
  const words = Array(numBits / 32).fill(0);
  for (const l of layers) {
    if (!Number.isInteger(l) || l < 0 || l >= numBits) throw Error(`INVALID_LAYER: ${l}; layers are 0–${numBits - 1}`);
    words[Math.floor(l / 32)] = (words[Math.floor(l / 32)] | (1 << l % 32)) >>> 0;
  }
  return words;
}

const layersOf = (words) => words.flatMap((w, i) => Array.from({ length: 32 }, (_, b) => ((Number(w) >>> b) & 1 ? i * 32 + b : -1)).filter((x) => x >= 0));

function backup(projectDir, file, text) {
  const dir = path.join(STATE_ROOT, 'scene-backups', crypto.createHash('sha1').update(path.resolve(projectDir)).digest('hex').slice(0, 12));
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `main.scene.${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.writeFileSync(out, text);
  fs.writeFileSync(path.join(dir, 'project.txt'), path.resolve(projectDir));
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('main.scene.')).sort().slice(0, -KEEP_BACKUPS)) fs.rmSync(path.join(dir, f), { force: true });
  return out;
}

export function setSceneLayers(projectDir, { objects = [], cameras = [] }) {
  if (!objects.length && !cameras.length) throw Error('INVALID_ARGUMENTS: give objects and / or cameras to change');
  const scene = loadScene(projectDir);
  const file = path.join(projectDir, 'Assets', 'main.scene');
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const blocks = entityBlocks(lines);
  if (blocks.length !== scene.entityCount) throw Error(`SCENE_LAYOUT_UNEXPECTED: ${blocks.length} entity blocks in the file, ${scene.entityCount} objects parsed`);
  const want = new Map();
  const changes = [];
  for (const { object, layer } of objects) {
    const o = scene.locate(object);
    const i = only(lines, blocks[o.index], LAYER, `object ${o.path}`);
    const before = Number(LAYER.exec(lines[i])[1]);
    lines[i] = `    layer: ${layer}`;
    want.set(`${o.index}.layer`, layer);
    changes.push({ object: o.path, id: o.id, layer_before: before, layer });
  }
  const cameraChanges = [];
  for (const { object, visible_layers } of cameras) {
    const o = scene.locate(object);
    if (!o.components.includes('Camera')) throw Error(`NOT_A_CAMERA: ${o.path} has no Camera component (${o.components.join(', ')})`);
    const i = only(lines, blocks[o.index], MASK, `camera ${o.path}`);
    const [, head, bits, mid, values, tail] = MASK.exec(lines[i]);
    const numBits = Number(bits);
    const old = values.split(',').map((v) => v.trim()).filter(Boolean);
    if (numBits % 32 || old.length !== numBits / 32) throw Error(`SCENE_LAYOUT_UNEXPECTED: camera ${o.path} mask has numBits ${numBits} and ${old.length} values`);
    const words = maskWords(visible_layers, numBits);
    lines[i] = `${head}${bits}${mid}${words.join(', ')}${tail}`;
    want.set(`${o.index}.mask`, words);
    cameraChanges.push({ object: o.path, id: o.id, visible_layers_before: layersOf(old), visible_layers: layersOf(words) });
  }

  const next = lines.join('\n');
  const doc = YAML.parseAllDocuments(next, { intAsBigInt: true, schema: 'core' })[0];
  if (doc.errors.length) throw Error(`SCENE_EDIT_BROKE_FILE: ${doc.errors[0].message}`);
  const entities = doc.toJS().entities;
  for (const [key, value] of want) {
    const [idx, kind] = key.split('.');
    const e = entities[Number(idx)];
    const got = kind === 'layer' ? Number(e.layer) : (e.components || []).find((c) => c && c.__class === 'Camera')?.layerVisibleMask?.values?.map(Number);
    if (JSON.stringify(got) !== JSON.stringify(value)) throw Error(`SCENE_EDIT_NOT_APPLIED: ${e.name} ${kind} reads back as ${JSON.stringify(got)}, expected ${JSON.stringify(value)}; the file was not written`);
  }
  const saved = backup(projectDir, file, text);
  fs.writeFileSync(`${file}.tmp`, next);
  fs.chmodSync(`${file}.tmp`, fs.statSync(file).mode & 0o777);
  fs.renameSync(`${file}.tmp`, file);
  return { scene: file, objects: changes, cameras: cameraChanges, backup: saved };
}
