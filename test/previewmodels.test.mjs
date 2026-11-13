import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addPreviewModel } from '../src/previewmodels.mjs';

const BASE = {
  defaultVideoInputModels: [
    { key: 'inputModel', name: 'preview_single_blink||女', type: 'preview_face', resourceUrl: './PreviewResource/video/preview_face/female/female-blink.mp4', gifUrl: 'g', iconUrl: 'i' },
    { key: 'inputModel', name: '模特D清秀||女', type: 'preview_face', resourceUrl: './PreviewResource/video/preview_face/model/model_d.mp4', gifUrl: 'g', iconUrl: 'i' },
    { key: 'inputModel', name: 'preview_hand_ok||女', type: 'preview_hand', resourceUrl: './PreviewResource/video/preview_hand/female/ok.mp4', gifUrl: 'g', iconUrl: 'i', handAction: 'OK', captureTimesMs: [1300] },
  ],
  defaultUniqueInputTypes: ['preview_face', 'preview_hand'],
};

function setup() {
  const root = tmpdir('xs-preview-root-');
  fs.writeFileSync(path.join(root, 'PreviewResources.json'), JSON.stringify(BASE, null, 2));
  fs.chmodSync(path.join(root, 'PreviewResources.json'), 0o666);
  const src = tmpdir('xs-preview-src-');
  const photo = path.join(src, 'a.png');
  const photo2 = path.join(src, 'b.jpg');
  const video = path.join(src, 'v.mp4');
  for (const f of [photo, photo2, video]) fs.writeFileSync(f, 'x');
  const calls = [];
  // Stands in for the editor's ffmpeg: writes the output file named by the last argument.
  const ffmpeg = async (args) => {
    calls.push(args);
    fs.writeFileSync(args.at(-1), `out:${path.extname(args.at(-1))}`);
  };
  return { root, photo, photo2, video, calls, ffmpeg };
}

test('a photo becomes a preview video, GIF and icon in the model folder, listed after the last entry of its type', async () => {
  const { root, photo, calls, ffmpeg } = setup();
  const out = await addPreviewModel({ name: '模特W短发||女', file_name: 'model_w', image: photo }, { ffmpeg, root });
  const dir = path.join(root, 'video/preview_face/model');
  assert.deepEqual(out.files, { mp4: path.join(dir, 'model_w.mp4'), gif: path.join(dir, 'model_w.gif'), png: path.join(dir, 'model_w.png') });
  assert.equal(fs.readFileSync(out.files.mp4, 'utf8'), 'out:.mp4');
  const [video, gif, icon] = calls;
  assert.deepEqual(video.slice(0, 5), ['-loop', '1', '-framerate', '30000/1001', '-i']);
  assert.equal(video[5], photo);
  for (const [flag, value] of [['-t', '5'], ['-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1'], ['-r', '30000/1001'], ['-c:v', 'libx264'], ['-pix_fmt', 'yuv420p'], ['-c:a', 'aac'], ['-i', 'anullsrc=r=44100:cl=stereo']]) {
    assert.ok(video.some((v, k) => v === flag && video[k + 1] === value), `${flag} ${value} in ${video.join(' ')}`);
  }
  assert.deepEqual(gif.slice(0, 4), ['-t', '2', '-i', gif[3]]);
  assert.match(gif.join(' '), /fps=10,scale=320:569/);
  assert.match(icon.join(' '), /-frames:v 1 -vf scale=56:96/);

  const text = fs.readFileSync(path.join(root, 'PreviewResources.json'), 'utf8');
  assert.ok(!text.endsWith('\n') && text.startsWith('{\n  "defaultVideoInputModels": [\n    {'), 'written in the editor’s own layout');
  assert.equal(fs.statSync(path.join(root, 'PreviewResources.json')).mode & 0o777, 0o666, 'the editor’s file mode is kept');
  const list = JSON.parse(text).defaultVideoInputModels;
  assert.deepEqual(list.map((m) => m.name), ['preview_single_blink||女', '模特D清秀||女', '模特W短发||女', 'preview_hand_ok||女']);
  assert.deepEqual(list[2], { key: 'inputModel', name: '模特W短发||女', type: 'preview_face', resourceUrl: './PreviewResource/video/preview_face/model/model_w.mp4', gifUrl: './PreviewResource/video/preview_face/model/model_w.gif', iconUrl: './PreviewResource/video/preview_face/model/model_w.png' });
  assert.equal(JSON.parse(fs.readFileSync(out.config_backup, 'utf8')).defaultVideoInputModels.length, 3, 'the backup is the version before');
});

test('two photos alternate in a loop of whole cycles, and a video keeps its own audio or gets silence', async () => {
  const { root, photo, photo2, video, calls, ffmpeg } = setup();
  await addPreviewModel({ name: '模特S亲亲交替||女', file_name: 'model_s_kiss', alternate: { first: photo, second: photo2, first_s: 1.4, second_s: 1, cycles: 4 } }, { ffmpeg, root });
  const alt = calls[0];
  const graph = alt[alt.indexOf('-filter_complex') + 1];
  assert.match(graph, /concat=n=2:v=1:a=0,loop=loop=3:size=72:start=0\[v\]/, '2.4 s at 30000/1001 fps is 72 frames, looped 3 more times');
  assert.equal(alt[alt.indexOf('-t', alt.indexOf('-filter_complex')) + 1], '9.6');

  calls.length = 0;
  await addPreviewModel({ name: '视频有声||女', file_name: 'model_v1', video }, { ffmpeg, root, streamTypes: async () => ['video', 'audio'] });
  assert.equal(calls[0][calls[0].indexOf('-map', calls[0].indexOf('-map') + 1) + 1], '0:a:0');
  assert.ok(!calls[0].includes('anullsrc=r=44100:cl=stereo'));
  calls.length = 0;
  await addPreviewModel({ name: '视频无声||女', file_name: 'model_v2', video }, { ffmpeg, root, streamTypes: async () => ['video'] });
  assert.equal(calls[0][calls[0].indexOf('-map', calls[0].indexOf('-map') + 1) + 1], '1:a:0');
  assert.ok(calls[0].includes('anullsrc=r=44100:cl=stereo'));
});

test('names and files are not taken twice unless replacing, and bad input is refused before encoding', async () => {
  const { root, photo, calls, ffmpeg } = setup();
  await assert.rejects(addPreviewModel({ name: '模特D清秀||女', file_name: 'model_x', image: photo }, { ffmpeg, root }), /PREVIEW_MODEL_EXISTS: 「模特D清秀\|\|女」 is already listed/);
  await assert.rejects(addPreviewModel({ name: '新的||女', file_name: 'model_d', image: photo }, { ffmpeg, root }), /FILE_NAME_TAKEN: model_d is the video of 「模特D清秀\|\|女」/);
  await assert.rejects(addPreviewModel({ name: '新的||女', file_name: 'Model-1', image: photo }, { ffmpeg, root }), /INVALID_FILE_NAME/);
  await assert.rejects(addPreviewModel({ name: '新的||女', file_name: 'm', image: photo, video: photo }, { ffmpeg, root }), /exactly one of image, video or alternate \(got image, video\)/);
  await assert.rejects(addPreviewModel({ name: '新的||女', file_name: 'm', image: '/nope.png' }, { ffmpeg, root }), /IMAGE_NOT_FOUND/);
  await assert.rejects(addPreviewModel({ name: '新的||女', file_name: 'm', type: 'preview_cat', image: photo }, { ffmpeg, root }), /INVALID_TYPE/);
  assert.deepEqual(calls, []);
  await assert.rejects(addPreviewModel({ name: '新的||女', file_name: 'm2', image: photo }, { ffmpeg: async () => {}, root }), /PREVIEW_MODEL_ENCODE_FAILED/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'PreviewResources.json'), 'utf8')).defaultVideoInputModels.length, 3, 'a failed encode leaves the list alone');

  const out = await addPreviewModel({ name: '模特D清秀||女', file_name: 'model_d', image: photo, replace: true }, { ffmpeg, root });
  assert.equal(out.replaced, true);
  const list = JSON.parse(fs.readFileSync(path.join(root, 'PreviewResources.json'), 'utf8')).defaultVideoInputModels;
  assert.equal(list.length, 3);
  assert.equal(list[1].name, '模特D清秀||女');
});
