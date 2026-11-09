// Reads a project's makeup layers (FaceMask, FaceMaskDY, EyeColorV2) from its scene file and tells, for each one,
// which part of the face it paints and in what colour: layer names in published works are often
// generic (面具1, 脸部妆容 (2)), so the part comes from the layer's region and its texture's pixels.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { sniffImage } from './images.mjs';
import { BLEND_MODES } from './inspect.mjs';
import { loadScene } from './scenefile.mjs';

// FaceMask (type, regionType) → the face area its texture is laid out for. These five pairs cover
// all 109 FaceMask layers of 13 projects (our own and homepage best sellers, 2026-11-07); any other
// pair is reported as it is, without a part.
const REGIONS = {
  'FACEU_MASK/0': '全脸',
  'FACEU_EYEPART/1': '眼部',
  'FACEU_JIEMAO/2': '睫毛',
  'FACEU_LIPS_KEYPOINT/3': '唇部',
  'FACEU_LIPS_KEYPOINT/4': '牙齿',
};

// Checked in order on the layer name; the first match wins (唇面高光 is a highlight, not a lipstick).
const NAME_PARTS = [
  [/睫毛/, '睫毛'],
  [/眼线/, '眼线'],
  [/卧蚕/, '卧蚕'],
  [/眉/, '眉毛'],
  [/腮红/, '腮红'],
  [/修容|鼻影/, '修容'],
  [/高光|提亮|亮片|闪/, '高光'],
  [/痣/, '痣'],
  [/雀斑/, '雀斑'],
  [/遮瑕/, '遮瑕'],
  [/口红|唇/, '口红'],
  [/眼影|眼妆/, '眼影'],
];
// A name only decides the part when it fits the region the texture is laid out for.
const NAME_FITS = {
  眼部: ['睫毛', '眼线', '卧蚕', '高光', '眼影', '修容'],
  唇部: ['口红', '高光'],
};

// Blend modes that can only lighten the skin (相加, 滤色, 颜色减淡, 变亮, 线性减淡): whatever the
// texture's colour, such a layer is a highlight, never a blush or a contour. Black leaves the skin as
// it is under them.
const LIGHTENING = new Set([3, 4, 8, 12, 13]);
// Blend modes that can only darken it (正片叠底, 颜色加深, 变暗); white leaves the skin as it is.
const DARKENING = new Set([1, 7, 9]);
// Picked: a texture this opaque carries no shape in its alpha (鼻子修容 of 妹宝甜豆妆 is fully opaque,
// 97.8 % pure white, 2026-11-09), so the shape is read from how far each pixel is from the colour the
// blend mode leaves unchanged.
const OPAQUE_SHARE = 0.95;

// Pixel rules, from the textures of the same 109 layers (positions are fractions of the texture):
// neutral-grey full-face maps (rgb 125–128, 73–100 % covered) are light/shadow maps blended over the
// skin; brows sit at y 0.39–0.40 and are under 0.07 tall; nose highlights are about 0.12 wide;
// freckles, moles and sparkles cover under 0.1 % of the texture; blush and cheek contour sit at
// y 0.51–0.64. In the eye layout liners are bands 0.09–0.20 tall, lower-lid lines sit at y 0.70 and
// below, highlights are near white.
function partFromPixels(region, s, blendMode) {
  if (region === '唇部') return s.hsl[2] >= 80 || LIGHTENING.has(blendMode) ? '唇部高光' : '口红';
  if (region === '眼部') {
    if (s.hsl[2] >= 80 || LIGHTENING.has(blendMode)) return '高光';
    if (s.cy >= 0.68) return '卧蚕';
    if (s.height <= 0.2) return '眼线';
    return '眼影';
  }
  if (LIGHTENING.has(blendMode)) return '高光';
  if (s.coverage > 0.5 && s.hsl[1] < 8 && Math.abs(s.hsl[2] - 50) < 6) return '明暗';
  if (s.cy < 0.45 && s.height < 0.1) return '眉毛';
  if (s.width <= 0.15 && Math.abs(s.cx - 0.5) < 0.05) return '鼻部';
  if (s.coverage < 0.001) return '点缀';
  if (s.cy >= 0.45 && s.cy <= 0.75) return '腮红/修容';
  return '全脸其他';
}

// The look's coverage, by the groups a makeup artist checks.
const GROUPS = ['底妆', '眉', '眼妆', '美瞳', '颊', '轮廓', '唇', '点缀', '其他'];
// Groups every full look is expected to decide on; 底妆 (mostly the AI face and skin smoothing, not
// makeup layers), 点缀 and 其他 are optional.
const CORE_GROUPS = ['眉', '眼妆', '美瞳', '颊', '轮廓', '唇'];
const EYE_PARTS = ['眼影', '眼线', '睫毛', '卧蚕'];
// The runtime classes of FaceMask and EyeColorV2: seen under these names only when the editor's side
// (main.scene.extra) is missing, which also loses their region and texture.
const RUNTIME_ONLY = ['EffectFaceMakeupFaceU', 'EyeColor'];
// SurfaceType of the editor's FaceMask plugin (CreationConfigBase.d.ts, FaceMask@1.0.6).
const SURFACES = ['普通', '水润', '珠光', '渐变', '哑光', '丝绒', '金属'];
// FaceMaskDY is the editor's older makeup layer, still in projects saved before it moved to FaceMask
// (official 混血doll感娃娃妆, homepage 冰透蓝调; the same package applied today comes in as FaceMask).
// Region and blend numbers are the same (韩漫少女 saved both ways, 2026-11-09); its panel has one
// intensity, and its lips gloss is a second blend mode (surfaceBlendMode) instead of a surface type.
const FACE_MASKS = ['FaceMask', 'FaceMaskDY'];
// Where the editor keeps official packages it imported from: an imported texture's .extra points
// there (…\DouyinAR\package\<id>\…, …/Instances/Instance1/EHpackage/<id>/…).
const PACKAGE_PATH = /DouyinAR[\\/](?:package|.*[\\/]EHpackage)[\\/](\d+)[\\/]/;
// A texture duplicated in the file manager to be edited (圆眼 - 副本.png).
const COPY_NAME = /副本|copy/i;
// A FaceMask draws on every face unless faceIds says otherwise; the editor's default is all five.
const ALL_FACES = [0, 1, 2, 3, 4];

function groupOf(region, part) {
  if (region === '眼部' || region === '睫毛') return '眼妆';
  if (region === '唇部') return '唇';
  if (region === '美瞳') return '美瞳';
  if (region === '牙齿') return null;
  if (part === '眉毛') return '眉';
  if (part === '遮瑕') return '底妆';
  if (EYE_PARTS.includes(part)) return '眼妆';
  if (part === '腮红' || part === '腮红/修容') return '颊';
  if (['修容', '明暗', '鼻部', '高光'].includes(part)) return '轮廓';
  if (['痣', '雀斑', '点缀'].includes(part)) return '点缀';
  if (part === '口红') return '唇';
  return '其他';
}

function hsl(r, g, b) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, Math.round(l * 100)];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [Math.round(((h * 60) + 360) % 360), Math.round(s * 100), Math.round(l * 100)];
}

const hex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const round3 = (v) => Math.round(v * 1000) / 1000;

// Alpha-weighted colour and placement of a texture's painted pixels. Pixels under 5 % alpha (texture
// noise) do not count. An opaque texture under a darkening or lightening blend mode is weighed by how
// much each pixel changes the skin instead (`opaque` is then set).
export function textureStats(file, { blendMode } = {}) {
  const buf = fs.readFileSync(file);
  if (sniffImage(buf) !== 'image/png') throw Error('不是 PNG，没有分析像素');
  const img = PNG.sync.read(buf);
  const neutral = DARKENING.has(blendMode) ? 255 : LIGHTENING.has(blendMode) ? 0 : null;
  const opaque = neutral !== null && opaqueShare(img) >= OPAQUE_SHARE;
  let s;
  try {
    s = pixelStats(opaque ? byEffect(img, neutral) : img);
  } catch (e) {
    if (!opaque) throw e;
    throw Error(`贴图不透明、几乎全是${neutral ? '白色' : '黑色'}，在${BLEND_MODES[blendMode]}下几乎不改变皮肤`);
  }
  const round = (v) => Number(v.toFixed(3));
  return { color: s.color, hsl: s.hsl, coverage: round(s.coverage), cx: round(s.cx), cy: round(s.cy), width: round(s.width), height: round(s.height), ...(opaque ? { opaque: true } : {}) };
}

function opaqueShare({ width: w, height: h, data }) {
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] >= 250) n++;
  return n / (w * h);
}

// Each pixel composited over the colour the blend leaves unchanged (white or black), its alpha
// replaced by how far it then is from that colour: under 正片叠底 a pixel of colour c multiplies the
// skin by c, so white does nothing and the darkest channel says how much it does.
function byEffect({ width, height, data }, neutral) {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    let effect = 0;
    for (let ch = 0; ch < 3; ch++) {
      const c = data[i + ch] * a + neutral * (1 - a);
      out[i + ch] = Math.round(c);
      effect = Math.max(effect, Math.abs(c - neutral) / 255);
    }
    out[i + 3] = Math.round(effect * 255);
  }
  return { width, height, data: out };
}

// Where a texture came from, by its .extra: imported from an official package (assetPackageID, the
// package's library template_id, or a path into the editor's package folder), or a file the author
// imported; null without a readable .extra.
function textureSource(file) {
  let entry;
  try {
    entry = [].concat(JSON.parse(fs.readFileSync(`${file}.extra`, 'utf8')))[0];
  } catch {
    return null;
  }
  const from = typeof entry?.resourceFilePath === 'string' ? entry.resourceFilePath : null;
  const pkg = entry?.assetPackageID ?? from?.match(PACKAGE_PATH)?.[1];
  const source = pkg ? { from: '官方素材包', package_id: String(pkg) } : from ? { from: '作者导入', file: from.split(/[\\/]/).pop() } : { from: '未知' };
  return COPY_NAME.test(path.basename(file)) ? { ...source, copy: true } : source;
}

// The same for RGBA pixels in memory, unrounded; positions are fractions of the texture, measured on
// pixel indices.
export function pixelStats({ width: w, height: h, data }) {
  let sum = 0, sx = 0, sy = 0, r = 0, g = 0, b = 0;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3] / 255;
      if (a < 0.05) continue;
      sum += a;
      sx += x * a;
      sy += y * a;
      r += data[i] * a;
      g += data[i + 1] * a;
      b += data[i + 2] * a;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!sum) throw Error('贴图全透明');
  return {
    color: hex(r / sum, g / sum, b / sum),
    hsl: hsl(r / sum, g / sum, b / sum),
    coverage: sum / (w * h),
    cx: sx / sum / w,
    cy: sy / sum / h,
    width: (x1 - x0 + 1) / w,
    height: (y1 - y0 + 1) / h,
  };
}

function textureFile(projectDir, tex) {
  if (tex && typeof tex === 'object' && tex.file) return { file: path.join(projectDir, 'Assets', tex.file), rel: tex.file };
  if (tex && typeof tex === 'object' && tex.builtin) return { note: '内置贴图，没有分析像素' };
  return { note: `贴图不在工程里（${typeof tex === 'string' ? tex : JSON.stringify(tex)}）` };
}

export function makeupLayers(projectDir) {
  const scene = loadScene(projectDir);
  const notes = [...scene.unreadable.map((u) => `资源描述文件读不了：${u}`)];
  const stats = new Map();
  const statsOf = (file, blendMode) => {
    const key = `${blendMode}|${file}`;
    if (!stats.has(key)) {
      try {
        stats.set(key, textureStats(file, { blendMode }));
      } catch (e) {
        stats.set(key, { error: e.message });
      }
    }
    return stats.get(key);
  };

  const all = [];
  const flatten = (nodes, parents, shown) => {
    for (const n of nodes) {
      const names = [...parents, n.name];
      const visible = shown && n.visible;
      all.push({ n, path: names.join('/'), visible, components: scene.inspect(n.guid).components });
      flatten(n.children, names, visible);
    }
  };
  flatten(scene.tree({ depth: Infinity }), [], true);

  // A packaged look (清冷, 清透伪素颜) is generated by one AI face GAN, which lists the makeup layers it
  // drives in facemaskGuids and scales them with facemaskIntensity (written to each layer as its
  // external intensity). Removing or disabling any of them makes the editor drop the whole look.
  const sets = [];
  const setOf = new Map();
  for (const { n, components } of all) {
    for (const c of components) {
      if (c.type !== 'GanComponent' || !Array.isArray(c.properties.facemaskGuids) || !c.properties.facemaskGuids.length) continue;
      const set = { object: n.guid, name: n.name, facemask_intensity: c.properties.facemaskIntensity ?? null, layers: [] };
      for (const g of c.properties.facemaskGuids) {
        if (g && typeof g === 'object' && g.object) setOf.set(g.object, set);
        else notes.push(`${n.guid} ${n.name}：facemaskGuids 里的 ${JSON.stringify(g)} 在场景里找不到`);
      }
      sets.push(set);
    }
  }

  const layers = [];
  const blind = [];
  for (const { n, path: objectPath, visible, components } of all) {
    for (const c of components) {
      if (RUNTIME_ONLY.includes(c.type)) blind.push(`${n.guid} ${n.name}`);
      if (!FACE_MASKS.includes(c.type) && c.type !== 'EyeColorV2') continue;
      const p = c.properties;
      const eye = c.type === 'EyeColorV2';
      const dy = c.type === 'FaceMaskDY';
      const region = eye ? '美瞳' : REGIONS[`${p.type}/${p.regionType}`] ?? `${p.type}/${p.regionType}`;
      // FaceMaskDY's panel has a single intensity, but its runtime component keeps a female and a male
      // opacity of their own (an official pack's are e.g. 0.6 / 0.3 under an intensity of 0.7), and those render.
      const female = eye ? p.intensity : dy ? p.femaleOpacity : p.femaleIntensity;
      const male = eye ? p.intensity : dy ? p.maleOpacity : p.maleIntensity;
      // The editor sets the shader's opacity to the slider times the external intensity
      // (FaceMaskComponentEditor's femaleIntensity setter); the runtime component keeps the product.
      const external = eye || dy ? null : { female: p.externalFemaleIntensity ?? 1, male: p.externalMaleIntensity ?? 1 };
      const slid = external ? { female: round3(female * external.female), male: round3(male * external.male) } : null;
      if (slid && typeof p.femaleOpacity === 'number' && (Math.abs(p.femaleOpacity - slid.female) > 0.01 || Math.abs(p.maleOpacity - slid.male) > 0.01)) {
        notes.push(`${n.guid} ${n.name}：场景里运行时的不透明度（女 ${p.femaleOpacity} / 男 ${p.maleOpacity}）和强度 × 外部强度（女 ${slid.female} / 男 ${slid.male}）对不上，编辑器里可能有没保存的改动`);
      }
      // Every FaceMask material draws at clamp(_Intensity × _Opacity), _Intensity being the panel's
      // 不透明度 (FaceMask@1.0.6 .omtl; 太阳花睫毛 at 0.55 and 1 drew visibly apart). A packaged look's GAN
      // takes its layers over: 清透伪素颜's 腮红 at 0.78 and 0.2 drew the same once the GAN was on (2026-11-09).
      const set = setOf.get(n.guid);
      const panel = slid && !set && typeof p.intensity === 'number' ? p.intensity : 1;
      const opacity = slid ? { female: round3(slid.female * panel), male: round3(slid.male * panel) } : { female, male };
      const off = !visible
        ? '隐藏'
        : p.enabled === false
          ? '组件停用'
          : !opacity.female && !opacity.male
            ? !female && !male
              ? '强度为 0'
              : panel === 0
                ? '不透明度为 0'
                : '整套强度为 0'
            : null;
      let blend = BLEND_MODES[p.blendMode] ?? null;
      if (p.blendMode === undefined) notes.push(`${n.guid} ${n.name}：场景里没有混合模式`);
      else if (blend === null) {
        blend = `未知（${p.blendMode}）`;
        notes.push(`${n.guid} ${n.name}：混合模式 ${p.blendMode} 不认识，按原值报告`);
      }
      const layer = { object: n.guid, name: n.name, path: objectPath, ...(dy ? { component: 'FaceMaskDY' } : {}), active: !off, ...(off ? { off } : {}), region, part: null, part_from: null, blend, female, male };
      if (external && (external.female !== 1 || external.male !== 1)) layer.external = external;
      layer.opacity = opacity;
      if (set) {
        layer.in_set = { object: set.object, name: set.name };
        set.layers.push(`${n.guid} ${n.name}`);
      }
      const faces = p.faceIds ?? (eye ? p.faceIndexes : undefined);
      if (Array.isArray(faces) && faces.join() !== ALL_FACES.join()) layer.faces = faces;
      if (!eye && !dy && p.surfaceType) layer.surface = { type: SURFACES[p.surfaceType] ?? `未知（${p.surfaceType}）`, intensity: p.surfaceIntensity ?? null };
      if (dy && p.surfaceIntensity) layer.surface = { blend: BLEND_MODES[p.surfaceBlendMode] ?? `未知（${p.surfaceBlendMode}）`, intensity: p.surfaceIntensity };
      if (!eye && Array.isArray(p.color) && p.color.slice(0, 3).some((v) => v !== 1)) layer.tint = hex(p.color[0] * 255, p.color[1] * 255, p.color[2] * 255);
      if (!eye && typeof p.intensity === 'number') layer.intensity = p.intensity;
      // Older EyeColor versions keep the iris texture under makeupTexture and the faces under faceIndexes.
      const tex = textureFile(projectDir, eye ? (p.eyeTexture ?? p.makeupTexture) : p.makeupTexture);
      let s = null;
      if (tex.file) {
        layer.texture = tex.rel;
        const source = textureSource(tex.file);
        if (source) layer.texture_source = source;
        s = statsOf(tex.file, p.blendMode);
        if (s.error) {
          layer.texture_note = s.error;
          s = null;
        } else {
          Object.assign(layer, { color: s.color, hsl: s.hsl });
          if (s.opaque) layer.texture_note = `贴图不透明，颜色和范围按每个像素离${DARKENING.has(p.blendMode) ? '白色' : '黑色'}多远（${blend}下它不改变皮肤）算`;
        }
      } else layer.texture_note = tex.note;
      if (eye && p.color) layer.tint = hex(p.color.r * 255, p.color.g * 255, p.color.b * 255);
      // Not measured: taken as the shader multiplying the texture by the tint, as the material's color
      // slot reads. The texture colour alone is what the layer would show untinted.
      if (layer.color && layer.tint) {
        const [c, t] = [rgbOf(layer.color), rgbOf(layer.tint)];
        const m = c.map((v, i) => (v * t[i]) / 255);
        Object.assign(layer, { tinted_color: hex(...m), tinted_hsl: hsl(...m) });
      }

      const named = NAME_PARTS.find(([re]) => re.test(n.name))?.[1];
      if (eye) [layer.part, layer.part_from] = ['美瞳', '组件'];
      else if (region === '睫毛') [layer.part, layer.part_from] = ['睫毛', '区域'];
      else if (region === '牙齿') [layer.part, layer.part_from] = ['牙齿美白', '区域'];
      else if (!REGIONS[`${p.type}/${p.regionType}`]) notes.push(`${n.guid} ${n.name}：没见过的妆容区域 ${region}，没有判断部位`);
      else if (named && (!NAME_FITS[region] || NAME_FITS[region].includes(named))) {
        layer.part = region === '唇部' && named === '高光' ? '唇部高光' : named;
        layer.part_from = '层名';
      } else if (s) [layer.part, layer.part_from] = [partFromPixels(region, s, p.blendMode), '贴图'];
      layers.push(layer);
    }
  }
  if (blind.length) throw Error(`MAKEUP_EDITOR_DATA_MISSING: ${blind.length} 个妆容组件在 main.scene.extra 里没有编辑器数据，读不出区域和贴图（${blind.join('、')}）`);

  const groups = Object.fromEntries(GROUPS.map((g) => [g, []]));
  for (const l of layers) {
    const g = l.active && groupOf(l.region, l.part);
    if (g) groups[g].push(`${l.object} ${l.name}（${l.part ?? l.region}，${l.blend ?? '混合模式未知'}，女 ${l.opacity.female} / 男 ${l.opacity.male}）`);
  }
  return { layers, groups, absent: CORE_GROUPS.filter((g) => !groups[g].length), sets, notes };
}
