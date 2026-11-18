// Full live e2e for the refactor, excluding submit_prepare / submit_confirm (作品送审).
// node scripts/e2e-full-no-submit.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createCanvas } from '@napi-rs/canvas';
import { PNG } from 'pngjs';
import { ffmpeg } from '../src/editorres.mjs';

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/server.mjs');
const H5_SRC = '/Users/muqian/Downloads/xiangsu-h5-src';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-e2e-full-'));
const results = [];
const pass = (name, detail) => (results.push({ name, ok: true, detail }), console.log(`✔ ${name}`, detail || ''));
const fail = (name, err) => (results.push({ name, ok: false, detail: String(err?.message || err) }), console.error(`✖ ${name}:`, err?.message || err));

async function connect(flat = true) {
  const client = new Client({ name: 'e2e-full', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [server],
      env: { ...process.env, ...(flat ? { XIANGSU_MCP_FLAT_TOOLS: '1' } : {}) },
    }),
  );
  return client;
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw Error(`${name}: ${res.content?.[0]?.text || 'error'}`);
  return res;
}

const textJson = (res) => JSON.parse(res.content.find((c) => c.type === 'text')?.text || '{}');

async function fixtures() {
  const clip = path.join(work, 'clip.mp4');
  const tone = path.join(work, 'tone.mp3');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100', '-t', '1.0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1.0', '-c:a', 'libmp3lame', tone]);
  const frame = path.join(work, 'face.png');
  const canvas = createCanvas(720, 1280);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#707070';
  ctx.fillRect(0, 0, 720, 1280);
  ctx.fillStyle = '#d8d8d8';
  ctx.fillRect(330, 745, 70, 30);
  fs.writeFileSync(frame, canvas.toBuffer('image/png'));
  const alpha = path.join(work, 'alpha.png');
  const img = new PNG({ width: 64, height: 64 });
  img.data.fill(0);
  for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) {
    const i = (y * 64 + x) * 4;
    img.data[i] = 255; img.data[i + 3] = 255;
  }
  fs.writeFileSync(alpha, PNG.sync.write(img));
  return { clip, tone, frame, alpha };
}

async function main() {
  console.log('work', work);
  console.log('NOTE: intentionally skips submit_prepare / submit_confirm');
  const fx = await fixtures();

  // --- discovery mode (default 19-list) ---
  {
    const client = await connect(false);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      if (names.length > 30) throw Error(`default list too large: ${names.length}`);
      if (!names.includes('tool_search') || !names.includes('project_open') || !names.includes('library_search')) {
        throw Error(`default names: ${names.join(',')}`);
      }
      pass('default tools/list size', `${names.length} items`);

      const search = textJson(await call(client, 'tool_search', { query: '抠图' }));
      if (!search.tools?.some((t) => /matting/i.test(t.name))) throw Error(JSON.stringify(search));
      pass('tool_search synonym 抠图', search.tools.map((t) => t.name).slice(0, 5).join(','));

      const desc = textJson(await call(client, 'tool_describe', { name: 'image_sheet' }));
      if (desc.name !== 'image_sheet' || !desc.inputSchema) throw Error(JSON.stringify(desc).slice(0, 200));
      pass('tool_describe image_sheet', 'schema ok');

      const via = textJson(await call(client, 'tool_call', { name: 'ext_status', arguments: {} }));
      if (!via.official?.connected) throw Error(JSON.stringify(via).slice(0, 300));
      pass('tool_call ext_status', `windows=${via.windows?.length}`);
    } catch (e) {
      fail('discovery layer', e);
    } finally {
      await client.close().catch(() => {});
    }
  }

  // --- flat mode script tools + live editor ---
  const client = await connect(true);
  try {
    const status = textJson(await call(client, 'ext_status', {}));
    const win = status.windows?.[0];
    if (!win?.instance_id || !win?.project_path) throw Error('no open editor window');
    const instance_id = String(win.instance_id);
    const project_path = win.project_path;
    const ctx = textJson(await call(client, 'get_project_context', { instance_id }));
    const project_id = ctx.context?.identity?.project_id;
    if (!project_id) throw Error(`no project_id: ${JSON.stringify(ctx).slice(0, 400)}`);
    pass('live editor', `${project_path} id=${project_id} instance=${instance_id}`);

    // media tools
    try {
      const res = await call(client, 'image_view', { images: [fx.clip, fx.frame], crop: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 } });
      const n = res.content.filter((c) => c.type === 'image').length;
      if (n < 2) throw Error(`images=${n}`);
      pass('image_view video+image+crop', `images=${n}`);
    } catch (e) {
      fail('image_view video+image+crop', e);
    }

    try {
      await call(client, 'image_sheet', {
        items: [{ src: fx.frame, label: 'A' }, { src: fx.alpha, label: 'B' }],
        trim_alpha: true,
        save_to: path.join(work, 'sheet.png'),
      });
      pass('image_sheet', `${fs.statSync(path.join(work, 'sheet.png')).size}B`);
    } catch (e) {
      fail('image_sheet', e);
    }

    try {
      const body = textJson(await call(client, 'makeup_light_metrics', { image_path: fx.frame, preset: 'H' }));
      if (!body.chin_over_cheek) throw Error(JSON.stringify(body).slice(0, 300));
      pass('makeup_light_metrics', `chin/cheek=${body.chin_over_cheek}`);
    } catch (e) {
      fail('makeup_light_metrics', e);
    }

    try {
      const body = textJson(
        await call(client, 'audio_probe', {
          audio: fx.tone,
          export_path: path.join(work, 'out.wav'),
          mono_16k: true,
        }),
      );
      if (!body.export?.bytes) throw Error(JSON.stringify(body).slice(0, 300));
      pass('audio_probe', `export=${body.export.bytes}B`);
    } catch (e) {
      fail('audio_probe', e);
    }

    // direct editing smoke (no submit)
    try {
      const tree = await call(client, 'scene_tree', { instance_id });
      const body = tree.content.map((c) => c.text || '').join('\\n');
      if (body.length < 20) throw Error(body.slice(0, 200));
      pass('scene_tree', `${body.length} chars`);
    } catch (e) {
      fail('scene_tree', e);
    }

    try {
      const lib = textJson(await call(client, 'library_search', { instance_id, query: '腮红', count: 5 }));
      if (!Array.isArray(lib.items) && lib.total === undefined) throw Error(JSON.stringify(lib).slice(0, 300));
      pass('library_search', `total=${lib.total ?? lib.items?.length}`);
    } catch (e) {
      fail('library_search', e);
    }

    try {
      const frames = await client.callTool(
        { name: 'preview_frames', arguments: { instance_id, count: 1, interval_ms: 400, reset: true } },
        undefined,
        { timeout: 240000 },
      );
      if (frames.isError) throw Error(frames.content?.[0]?.text || 'preview_frames error');
      const imgs = frames.content.filter((c) => c.type === 'image').length;
      if (!imgs) throw Error(frames.content[0]?.text?.slice(0, 300) || 'no image');
      pass('preview_frames', `images=${imgs}`);
    } catch (e) {
      fail('preview_frames', e);
    }

    // H5: subset → build/publish → import → poll status
    const h5src = path.join(work, 'h5');
    fs.cpSync(path.join(H5_SRC, 'snow-polaroid'), h5src, { recursive: true });
    try {
      const font = textJson(
        await call(client, 'h5_font_subset', {
          font_path: path.join(H5_SRC, '_fonts/NotoSansSC.ttf'),
          license_path: path.join(H5_SRC, '_fonts/OFL.txt'),
          source_dir: h5src,
          output_name: 'e2e-full.woff2',
        }),
      );
      if (font.outcome !== 'ok') throw Error(JSON.stringify(font));
      pass('h5_font_subset', `${font.bytes}B`);
    } catch (e) {
      fail('h5_font_subset', e);
    }

    let handle;
    try {
      const request_id = `e2e-full-${Date.now()}`;
      const built = textJson(
        await call(client, 'h5_bundle_build', {
          source_dir: h5src,
          brief_path: path.join(H5_SRC, 'snow-polaroid.brief.json'),
          project_path,
          instance_id: project_id,
          request_id,
        }),
      );
      if (built.outcome !== 'ok') throw Error(JSON.stringify(built));
      handle = { request_id, ...built };
      pass('h5_bundle_build publish', `artifact=${built.artifact_id} bytes=${built.bytes}`);
    } catch (e) {
      fail('h5_bundle_build publish', e);
    }

    if (handle) {
      try {
        const accepted = textJson(
          await call(client, 'import_h5_render_bundle', {
            instance_id,
            request_id: handle.request_id,
            artifact_id: handle.artifact_id,
            expected_digest: handle.expected_digest,
            source_app_name: 'cursor',
            allow_empty_inputs: true,
            import_intention: { kind: 'create', placement: { x: 120, y: 120 } },
            intention: 'e2e import empty template after artifact publish',
          }),
        );
        const import_id = accepted.import_id || accepted.data?.import_id || accepted.result?.import_id;
        if (!import_id && accepted.status !== 'accepted' && accepted.state !== 'succeeded') {
          // dump for diagnosis
          throw Error(JSON.stringify(accepted).slice(0, 800));
        }
        const id = import_id || accepted.import_id;
        pass('import_h5_render_bundle accepted', JSON.stringify(accepted).slice(0, 240));

        let last;
        for (let i = 0; i < 60; i++) {
          last = textJson(
            await call(client, 'get_h5_import_status', {
              instance_id,
              request_id: `status-${handle.request_id}-${i}`,
              import_id: id || accepted.import_id,
            }),
          );
          const state = last.status || last.state || last.data?.status;
          if (state === 'succeeded' || state === 'failed') {
            if (state !== 'succeeded') throw Error(JSON.stringify(last).slice(0, 800));
            pass('get_h5_import_status succeeded', JSON.stringify(last).slice(0, 240));
            break;
          }
          await sleep(2000);
        }
        if (!results.some((r) => r.name === 'get_h5_import_status succeeded')) {
          throw Error(`timeout: ${JSON.stringify(last).slice(0, 800)}`);
        }
      } catch (e) {
        fail('import_h5_render_bundle / status', e);
      }
    }

    // prove submit tools exist but we do not call them
    const { tools } = await client.listTools();
    const submit = tools.filter((t) => /^submit_/.test(t.name)).map((t) => t.name);
    pass('submit tools present but not called', submit.join(',') || '(none)');
  } catch (e) {
    fail('live editor setup', e);
  } finally {
    await client.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n--- summary ---');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}`);
  fs.rmSync(work, { recursive: true, force: true });
  if (failed.length) {
    console.error(`\n${failed.length}/${results.length} failed`);
    process.exit(1);
  }
  console.log(`\n${results.length}/${results.length} passed (submit_* skipped)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
