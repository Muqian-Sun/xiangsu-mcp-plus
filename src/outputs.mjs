// How answers carry bulk data. Lists hand out short refs instead of media addresses (a signed CDN
// address runs to hundreds of characters and most of a list item, measured), which image_view turns
// back into the address; an answer too long to read in one go is written to a file and replaced by
// an outline of it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Picked, not measured: far more refs than a session's lists hand out (a page of 20 holds about 40);
// past it the least recently handed out are forgotten, and image_view says to list again.
const MAX_REFS = 20000;
const PREFIX = { image: 'img', video: 'video', audio: 'audio' };
export const REF_PATTERN = /^(img|video|audio):\d+$/;

export class MediaRefs {
  constructor({ max = MAX_REFS } = {}) {
    this.max = max;
    this.byKey = new Map();
    this.byRef = new Map();
    this.next = 1;
  }

  add(url, kind) {
    const key = `${kind} ${url}`;
    let ref = this.byKey.get(key);
    if (ref) this.byRef.delete(ref);
    else ref = `${PREFIX[kind]}:${this.next++}`;
    this.byKey.set(key, ref);
    this.byRef.set(ref, { url, kind });
    while (this.byRef.size > this.max) {
      const [old, hit] = this.byRef.entries().next().value;
      this.byRef.delete(old);
      this.byKey.delete(`${hit.kind} ${hit.url}`);
    }
    return ref;
  }

  get(ref) {
    return this.byRef.get(ref) ?? null;
  }
}

// Media fields are named by what they hold: video_url / videos are videos, preview_url and audio_url
// audio, every other *_url and images pictures. Other links (review and task page links) are named
// url or link and stay as they are.
const kindOf = (key) => (key.startsWith('video') ? 'video' : key.startsWith('preview') || key.startsWith('audio') ? 'audio' : 'image');
const isAddress = (v) => typeof v === 'string' && /^https?:\/\//.test(v);

export function withRefs(value, refs) {
  if (Array.isArray(value)) return value.map((v) => withRefs(v, refs));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (key.endsWith('_url') && (typeof v === 'string' || v === null)) {
      out[`${key.slice(0, -4)}_ref`] = isAddress(v) ? refs.add(v, kindOf(key)) : null;
    } else if ((key === 'images' || key === 'videos') && Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      out[`${key.slice(0, -1)}_refs`] = v.filter(isAddress).map((u) => refs.add(u, kindOf(key)));
    } else {
      out[key] = withRefs(v, refs);
    }
  }
  return out;
}

// Derived: task_detail answered 48K characters (measured), most of it media addresses and page
// markup, and agents read such answers in pieces or not at all; picked a round number below it.
export const SPILL_CHARS = 30000;
// Picked: long enough to read the file within the session that asked for it.
const SPILL_TTL_MS = 24 * 60 * 60 * 1000;
// Picked: enough of a text answer (scene trees) to see what it is.
const TEXT_HEAD = 2000;

function outline(value) {
  if (Array.isArray(value)) {
    const first = value.find((v) => v && typeof v === 'object' && !Array.isArray(v));
    return first ? { items: value.length, item_keys: Object.keys(first) } : { items: value.length };
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, outline(v)]));
  if (typeof value === 'string' && value.length > 200) return `${value.slice(0, 200)}…（共 ${value.length} 字）`;
  return value;
}

export class Spill {
  constructor({ stateDir = process.env.XIANGSU_MCP_EXT_STATE || path.join(os.homedir(), '.xiangsu-mcp-ext'), now = Date.now, limit = SPILL_CHARS } = {}) {
    this.dir = path.join(stateDir, 'outputs');
    this.now = now;
    this.limit = limit;
  }

  prune() {
    if (!fs.existsSync(this.dir)) return;
    for (const name of fs.readdirSync(this.dir)) {
      const file = path.join(this.dir, name);
      if (this.now() - fs.statSync(file).mtimeMs > SPILL_TTL_MS) fs.rmSync(file, { force: true });
    }
  }

  // Writes body to a new file kept SPILL_TTL_MS and returns its path.
  write(tool, body, ext = 'txt') {
    this.prune();
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${tool}-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
    fs.writeFileSync(file, body);
    return file;
  }

  // A text-only answer over the limit goes to a file; errors and answers with images pass unchanged.
  apply(tool, result) {
    if (!result || result.isError || !result.content.every((c) => c.type === 'text')) return result;
    const body = result.content.map((c) => c.text).join('\n');
    if (body.length <= this.limit) return result;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      parsed = undefined;
    }
    const file = this.write(tool, body, parsed === undefined ? 'txt' : 'json');
    const summary = {
      spilled_to: file,
      chars: body.length,
      note: `回答有 ${body.length} 字，超过 ${this.limit} 字，全文写进了 spilled_to（24 小时后删除）：用读文件的工具按需读取，或用分页参数分几次取`,
      ...(parsed === undefined ? { head: body.slice(0, TEXT_HEAD) } : { outline: outline(parsed) }),
    };
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }
}
