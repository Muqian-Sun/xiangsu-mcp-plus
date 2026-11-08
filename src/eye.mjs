// Eye makeup in the eye layout (900×460, left half = the frame's left eye, outer corner at small x):
// where the parts of an eye are on the texture, and a liner, lashes, shadow, highlights and lower lid
// built on those positions the way a makeup artist describes them, as paint() specs.
import fs from 'node:fs';
import { fitArc } from './paint.mjs';

// Measured with 工具/eye_calib on models D, I, E, G (初雪冷白, 2026-11-08; median of both eyes,
// smoothed): `edge` is where the lid skin ends, `rim` the dark lash-line rim. Inner corner first.
const RIM = [[305, 259], [285, 253], [270, 249], [255, 247.5], [240, 247], [225, 247], [210, 246.5], [195, 248.5], [180, 255], [165, 262], [152, 266]];
const EDGE = [[305, 254], [285, 244], [270, 240], [255, 237], [240, 236], [225, 235.5], [210, 236], [195, 238.5], [180, 242], [165, 245.5], [152, 248]];
// The lower lid: the top half-max edge of the official 粉雾 crescent, which a calibration texture put on
// model D's lower lid (初雪冷白 make_snow.py, 2026-11-08); inner corner first, to the outer end of the
// mesh (x ≈ 130). The aegyo-sal's highlight sits 4–20 rows below it, its crease 25 rows below.
const LOWER = [[340, 294], [325, 299], [310, 303], [295, 306], [280, 308], [265, 309], [250, 309], [235, 308], [220, 307], [205, 304], [190, 299], [175, 294], [160, 288], [145, 284], [130, 278]];
const AEGYO_HIGHLIGHT = 12;
const AEGYO_CREASE = 25;
const AEGYO = LOWER.map(([x, y]) => [x, y + AEGYO_HIGHLIGHT]);

export const DEFAULT_ANATOMY = {
  source: 'default',
  rim: RIM,
  edge: EDGE,
  lower: LOWER,
  aegyo: AEGYO,
  // How far the rim of different faces sits from `rim` (texture px, up / down): makeup_calibrate on
  // D, E, G, I (2026-11-08) read the middle of the rim 236–256 over both eyes, about 4 above and 6
  // below the median.
  spread: [4, 6],
  // The right eye maps lower on the texture than the left (beauty notes: about 3 texture px on 3 of
  // 4 models).
  mirror_dy: 3,
};

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The eye positions from a makeup_calibrate eye calibration: for each column the median over its
// models and eyes (right eye read at its mirrored column, less the right eye's own offset), and the
// spread of their rims. Columns with too few readings keep the default; the curves are re-fitted as one
// arc each, so a few noisy columns do not bend them.
const MIN_READINGS = 3;
export function anatomyFromCalibration(file) {
  const cal = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (cal.layout !== 'eye') throw Error(`CALIBRATION_NOT_EYE: ${file} is a ${cal.layout} calibration`);
  const read = new Map();
  const dys = [];
  for (const run of cal.runs) {
    const byEye = Object.fromEntries(run.parts.map((p) => [p.eye, new Map(p.upper_lid.map((l) => [p.eye === 'right' ? 899 - l.x : l.x, l]))]));
    if (byEye.left && byEye.right) for (const [x, l] of byEye.left) if (l.rim !== null && byEye.right.get(x)?.rim != null) dys.push(byEye.right.get(x).rim - l.rim);
  }
  const mirror_dy = dys.length >= MIN_READINGS ? median(dys) : DEFAULT_ANATOMY.mirror_dy;
  for (const run of cal.runs) {
    for (const p of run.parts) {
      for (const l of p.upper_lid) {
        const x = p.eye === 'right' ? 899 - l.x : l.x;
        const shift = p.eye === 'right' ? mirror_dy : 0;
        const r = read.get(x) || { edge: [], rim: [] };
        if (l.edge !== null) r.edge.push(l.edge - shift);
        if (l.rim !== null) r.rim.push(l.rim - shift);
        read.set(x, r);
      }
    }
  }
  // The calibration reads every 15 px from 135; the default points sit on other columns, so readings
  // are taken at the calibration's own columns and the default fills the rest.
  const columns = [...read.keys()].sort((a, b) => b - a);
  const merged = (key, fallback) => {
    const interp = (x) => {
      const s = [...fallback].sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < s.length; i++) if (x <= s[i][0]) return s[i - 1][1] + ((s[i][1] - s[i - 1][1]) * (x - s[i - 1][0])) / (s[i][0] - s[i - 1][0]);
      return s[s.length - 1][1];
    };
    const pts = [];
    let measured = 0;
    for (const x of columns) {
      if (x > fallback[0][0] || x < fallback[fallback.length - 1][0]) continue;
      const r = read.get(x)[key];
      if (r.length >= MIN_READINGS) {
        pts.push([x, median(r)]);
        measured++;
      } else pts.push([x, interp(x)]);
    }
    const ends = [fallback[0], fallback[fallback.length - 1]];
    const all = [ends[0], ...pts.filter(([x]) => x < ends[0][0] && x > ends[1][0]), ends[1]];
    return { pts: smoothPoints(all), measured };
  };
  const rim = merged('rim', RIM);
  const edge = merged('edge', EDGE);
  const spreads = [];
  for (const x of columns) {
    const r = read.get(x).rim;
    if (r.length < MIN_READINGS) continue;
    const m = median(r);
    spreads.push([m - Math.min(...r), Math.max(...r) - m]);
  }
  const spread = spreads.length ? [median(spreads.map((s) => s[0])), median(spreads.map((s) => s[1]))] : DEFAULT_ANATOMY.spread;
  return {
    ...DEFAULT_ANATOMY,
    source: file,
    rim: rim.pts,
    edge: edge.pts,
    spread,
    mirror_dy,
    measured: { rim_columns: rim.measured, edge_columns: edge.measured, models: cal.runs.length },
  };
}

// The points moved onto the arc fitted through them (keeps their columns).
function smoothPoints(pts) {
  if (pts.length < 4) return pts;
  const arc = fitArc(pts, pts.map(() => 0)).points;
  return pts.map(([x]) => {
    let best = arc[0];
    for (const p of arc) if (Math.abs(p[0] - x) < Math.abs(best[0] - x)) best = p;
    return [x, Number(best[1].toFixed(1))];
  });
}

const shiftY = (pts, dy) => pts.map(([x, y]) => [x, y + dy]);
const lerp = (a, b, t) => a + (b - a) * t;
// Values along a line from the inner end (t = 0) to the outer end (t = 1), one per point.
const profile = (pts, f) => pts.map((_, i) => f(i / (pts.length - 1)));
// The part of a line between two fractions of its points (inner end 0, outer end 1).
const part = (pts, from, to) => pts.slice(Math.round(from * (pts.length - 1)), Math.round(to * (pts.length - 1)) + 1);

// A curve densified into `n` points along the fitted arc, so parts and profiles have room.
function dense(pts, n = 24) {
  const arc = fitArc(pts, pts.map(() => 0)).points;
  return Array.from({ length: n }, (_, i) => arc[Math.round((i * (arc.length - 1)) / (n - 1))]);
}

export const LINERS = ['tight', 'lash_line', 'wing'];
export const LASHES = ['natural', 'cluster', 'sunflower', 'doll', 'fox'];

// Default colours (beauty notes: liner in ink; lashes a slightly lighter dark brown at about 85 %: full
// black reads as false lashes, a light brown at 60–70 % blurs into a pale fuzz; under the eye light
// colours in normal blend, never multiply).
const INK = '#1A1212';
const LASH = [40, 30, 30];
const LASH_OPACITY = 0.85;

function liner(a, o) {
  const rim = dense(a.rim);
  const [up, down] = a.spread;
  // Thin on top, reaching down `cover` × the spread below the rim, so the line still meets the lash
  // line on faces whose rim sits lower (a liner above the rim floats on the lid; one a little into the
  // rim hides in the lash line).
  const cover = o.cover ?? 0.5;
  const [wi, wm, wo] = o.width ?? (o.style === 'tight' ? [0.6, 1, 0.8] : [1, 2.2, 2]);
  const top = (t) => (t < 0.5 ? lerp(wi, wm, t / 0.5) : lerp(wm, wo, (t - 0.5) / 0.5));
  const lift = o.style === 'tight' ? 1 : 0;
  // Upper edge: over the rim by the line's width; lower edge: down into the spread.
  const upper = rim.map(([x, y], i) => [x, y - top(i / (rim.length - 1)) * 2 + lift - up * 0.25]);
  const lower = rim.map(([x, y]) => [x, y + down * cover + 1]);
  const shapes = [{ type: 'band', top: upper, bottom: lower, mirror: true }];
  const tail = o.tail ?? (o.style === 'wing' ? { length: 30, lift: 30 } : null);
  if (tail) {
    // The wing continues the upper edge past the outer corner.
    const end = rim.slice(-8);
    shapes.push({ type: 'stroke', points: end.map(([x, y]) => [x, y - wo]), radius: profile(end, (t) => lerp(wm, wo, t)), tail: { length: tail.length, lift: tail.lift, radius: 0.2 }, mirror: true });
  }
  return { color: o.color ?? INK, opacity: o.opacity ?? 1, blur: o.softness ?? 0.6, shapes };
}

// Strands as explicit strokes: a quadratic Bézier from root to tip, curling by `curl` degrees.
function strand(root, angleDeg, length, curlDeg, radius) {
  const a = (angleDeg * Math.PI) / 180;
  const c = ((angleDeg - curlDeg) * Math.PI) / 180;
  const ctrl = [root[0] + Math.cos(c) * length * 0.5, root[1] + Math.sin(c) * length * 0.5];
  const tip = [root[0] + Math.cos(a) * length, root[1] + Math.sin(a) * length];
  const n = Math.max(3, Math.ceil(length / 2));
  const points = Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const u = 1 - t;
    return [u * u * root[0] + 2 * u * t * ctrl[0] + t * t * tip[0], u * u * root[1] + 2 * u * t * ctrl[1] + t * t * tip[1]];
  });
  return { type: 'stroke', points, radius, curve: 'straight', mirror: true };
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Upper lashes by style. Angles are texture degrees (0 right, -90 up); the outer corner is at small x,
// so lashes leaning outward point up and to the left (toward -180). Lengths in texture px (about 0.3–
// 0.55 frame px each).
const LASH_STYLES = {
  // Separated, even, a little longer and more lifted toward the outer corner.
  natural: { count: 40, length: (t) => lerp(16, 30, t), angle: (t) => lerp(-95, -140, t), curl: 14, radius: [1.1, 0.25] },
  // Long all along, fanned evenly from the inner to the outer end, strongly curled.
  sunflower: { count: 54, length: (t) => lerp(26, 32, Math.sin(t * Math.PI)), angle: (t) => lerp(-70, -160, t), curl: 22, radius: [1.15, 0.25] },
  // Longest over the iris, opening the eye round.
  doll: { count: 46, length: (t) => lerp(18, 36, Math.sin(t * Math.PI)), angle: (t) => lerp(-85, -135, t), curl: 18, radius: [1.15, 0.25] },
  // Short at the inner corner, long and swept up toward the outer corner. Tips stay inside x ≈ 125:
  // makeup_calibrate decoded the eye mesh only from about x 130 on (D, E, G, I), so a strand reaching
  // further out is cut off on the face.
  fox: { count: 42, length: (t) => lerp(10, 34, t ** 1.5), angle: (t) => lerp(-100, -145, t), curl: 12, radius: [1.15, 0.25] },
};

function lashes(a, o) {
  const root = shiftY(dense(a.rim, 60), -1);
  const r = rng(o.seed ?? 7);
  const scale = o.length ?? 1;
  const shapes = [];
  if (o.style === 'cluster') {
    // Clusters (manga lashes): groups of strands whose tips meet, with gaps between groups.
    const groups = o.count ?? 9;
    for (let g = 0; g < groups; g++) {
      const t = (g + 0.5) / groups;
      const c = root[Math.round(t * (root.length - 1))];
      const len = lerp(20, 34, t) * scale;
      const ang = lerp(-95, -145, t);
      const tip = [c[0] + Math.cos((ang * Math.PI) / 180) * len, c[1] + Math.sin((ang * Math.PI) / 180) * len];
      for (let k = -2; k <= 2; k++) {
        const base = root[Math.max(0, Math.min(root.length - 1, Math.round(t * (root.length - 1)) + k))];
        const dx = tip[0] - base[0];
        const dy = tip[1] - base[1];
        shapes.push(strand(base, (Math.atan2(dy, dx) * 180) / Math.PI, Math.hypot(dx, dy), (o.curl ?? 10) * (r() * 0.4 + 0.8), [1.2, 0.3]));
      }
    }
  } else {
    const st = LASH_STYLES[o.style];
    const n = o.count ?? st.count;
    for (let i = 0; i < n; i++) {
      const t = Math.min(1, Math.max(0, (i + (r() - 0.5) * 0.6) / (n - 1)));
      const base = root[Math.round(t * (root.length - 1))];
      shapes.push(strand(base, st.angle(t) + (r() - 0.5) * 10, st.length(t) * scale * (0.85 + r() * 0.3), o.curl ?? st.curl, st.radius));
    }
  }
  return { color: o.color ?? LASH, opacity: o.opacity ?? LASH_OPACITY, shapes };
}

function lowerLashes(a, o) {
  const root = shiftY(dense(a.lower, 40), 1);
  const r = rng(o.seed ?? 11);
  const scale = o.length ?? 1;
  const shapes = [];
  const pick = part(root, 0.15, 1);
  if (o.style === 'cluster') {
    for (let g = 0; g < (o.count ?? 6); g++) {
      const t = (g + 0.5) / (o.count ?? 6);
      const base = pick[Math.round(t * (pick.length - 1))];
      for (let k = -1; k <= 1; k++) shapes.push(strand([base[0] + k * 1.5, base[1]], lerp(95, 120, t) + k * 6, lerp(8, 14, t) * scale, -8, [0.9, 0.2]));
    }
  } else {
    const n = o.count ?? 16;
    for (let i = 0; i < n; i++) {
      const t = (i + r() * 0.6) / n;
      const base = pick[Math.min(pick.length - 1, Math.round(t * (pick.length - 1)))];
      shapes.push(strand(base, lerp(92, 118, t) + (r() - 0.5) * 10, lerp(5, 11, t) * scale * (0.8 + r() * 0.4), -6, [0.8, 0.2]));
    }
  }
  return { color: o.color ?? LASH, opacity: o.opacity ?? 0.5, shapes };
}

// The eye opening (between the upper rim and the lower lash line), for erasing what would tint the
// eye: shadows and lower-lid colour stay on the skin around it.
function opening(a, dyTop = 0) {
  const top = dense(a.rim, 24).map(([x, y]) => [x, y + dyTop]);
  const bottom = dense(a.lower, 24);
  return { erase: true, blur: 2, shapes: [{ type: 'band', top, bottom: top.map(([x]) => [x, interpY(bottom, x)]), curve: 'straight', mirror: true }] };
}

function interpY(pts, x) {
  const s = [...pts].sort((p, q) => p[0] - q[0]);
  if (x <= s[0][0]) return s[0][1];
  for (let i = 1; i < s.length; i++) if (x <= s[i][0]) return lerp(s[i - 1][1], s[i][1], (x - s[i - 1][0]) / (s[i][0] - s[i - 1][0]));
  return s[s.length - 1][1];
}

// Lid shadow (multiply): a low-saturation wash over the whole lid from the rim up to the crease, the
// outer third deepened and drawn out past the corner (beauty notes: 眼影整个眼皮低饱和打底，后三分之一
// 加深拉长), kept out of the eye opening.
function shadow(a, o) {
  const layers = [];
  const rim = dense(a.rim, 24);
  const height = o.height ?? 40;
  if (o.base) {
    const crease = rim.map(([x, y]) => [x, y - height]);
    layers.push({ color: o.base.color, opacity: o.base.opacity ?? 0.5, blur: 10, shapes: [{ type: 'band', top: crease, bottom: shiftY(rim, 4), mirror: true }] });
  }
  if (o.outer) {
    const outer = part(rim, 0.62, 1);
    const ext = o.outer.extend ?? 14;
    const end = outer[outer.length - 1];
    const top = [...outer.map(([x, y], i) => [x, y - height * lerp(0.4, 0.75, i / (outer.length - 1))]), [end[0] - ext, end[1] - height * 0.45]];
    const bottom = [...shiftY(outer, 3), [end[0] - ext, end[1] - 2]];
    layers.push({ color: o.outer.color, opacity: o.outer.opacity ?? 0.6, blur: 8, shapes: [{ type: 'band', top, bottom, curve: 'through', mirror: true }] });
  }
  if (!layers.length) return null;
  return [...layers, opening(a, 2)];
}

// Highlights (screen): the inner corner (眼头提亮) and the aegyo-sal band.
function light(a, o) {
  const layers = [];
  if (o.inner) {
    const [x, y] = a.rim[0];
    layers.push({ color: o.inner.color ?? '#FFF4EC', opacity: o.inner.opacity ?? 0.5, blur: 3, shapes: [{ type: 'spot', x: x + 8, y: y + 8, rx: 9, ry: 7, mirror: true }] });
  }
  if (o.aegyo) {
    const ag = dense(a.aegyo, 24);
    const mid = part(ag, 0.05, 0.8);
    layers.push({ color: o.aegyo.color ?? '#FFF0E8', opacity: o.aegyo.opacity ?? 0.45, blur: 4, shapes: [{ type: 'stroke', points: mid, radius: profile(mid, (t) => lerp(3, 5, Math.sin(t * Math.PI))), mirror: true }] });
  }
  return layers.length ? layers : null;
}

// Under the eye (normal blend; multiply darkens the under-eye and deepens the tear trough): a thin line
// of colour hugging the lower lash line, the shadow line under the aegyo-sal, the lower outer corner.
function under(a, o) {
  const layers = [];
  if (o.line) {
    const low = dense(a.lower, 24);
    const from = o.line.from ?? 0.3;
    const seg = part(low, from, 1);
    layers.push({ color: o.line.color, opacity: o.line.opacity ?? 0.6, blur: 1.5, shapes: [{ type: 'stroke', points: shiftY(seg, 2), radius: profile(seg, (t) => lerp(1, (o.line.width ?? 2.5), Math.min(1, t * 2))), mirror: true }] });
  }
  if (o.aegyo_shadow) {
    const ag = part(dense(a.aegyo, 24), 0.1, 0.8);
    layers.push({ color: o.aegyo_shadow.color ?? '#B08478', opacity: o.aegyo_shadow.opacity ?? 0.25, blur: 2.5, shapes: [{ type: 'stroke', points: shiftY(ag, AEGYO_CREASE - AEGYO_HIGHLIGHT), radius: 1.5, mirror: true }] });
  }
  if (o.outer) {
    const low = part(dense(a.lower, 24), 0.6, 1);
    layers.push({ color: o.outer.color, opacity: o.outer.opacity ?? 0.4, blur: 5, shapes: [{ type: 'stroke', points: shiftY(low, 4), radius: profile(low, (t) => lerp(2, 4, t)), mirror: true }] });
  }
  if (!layers.length) return null;
  return [...layers, opening(a, -1)];
}

// The textures of one eye look: each a paint() spec with its blend mode. Only the parts asked for.
export function eyeTextures(spec, anatomy = DEFAULT_ANATOMY) {
  const out = [];
  // Bottom to top: lower lashes, upper lashes, then the liner, so the line stays crisp where lashes
  // grow out of it.
  const lineLayers = [spec.lower_lashes && lowerLashes(anatomy, spec.lower_lashes), spec.lashes && lashes(anatomy, spec.lashes), spec.liner && liner(anatomy, spec.liner)].filter(Boolean);
  if (lineLayers.length) out.push({ key: 'line', blend: 'normal', layers: lineLayers });
  const sh = spec.shadow && shadow(anatomy, spec.shadow);
  if (sh) out.push({ key: 'shadow', blend: 'multiply', layers: sh });
  const li = (spec.highlight || spec.aegyo?.highlight) && light(anatomy, { inner: spec.highlight?.inner, aegyo: spec.aegyo?.highlight });
  if (li) out.push({ key: 'light', blend: 'screen', layers: li });
  const un = (spec.lower_lid || spec.aegyo?.shadow) && under(anatomy, { ...spec.lower_lid, aegyo_shadow: spec.aegyo?.shadow });
  if (un) out.push({ key: 'under', blend: 'normal', layers: un });
  return out.map((t) => ({ ...t, layout: 'eye', mirror_dy: anatomy.mirror_dy }));
}
