// Paints FaceMask textures from shapes: the soft spots, tapering strokes, filled bands, freckles and
// lashes that hand-written per-look scripts used to draw, with the pixel rules those scripts kept
// getting wrong done once (straight-alpha compositing, what colour transparent pixels carry, mirroring
// onto the other eye).
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { sniffImage } from './images.mjs';

// Texture layouts by FaceMask region. Official textures come in several sizes per region (eye: 900×460,
// 512×256, 1000×512) laid out the same way; these are the sizes the measured coordinates in the beauty
// notes are written in (face 1024, eye 900×460) and the official lipstick size (460×230).
export const LAYOUTS = {
  face: { width: 1024, height: 1024, region: 0 },
  eye: { width: 900, height: 460, region: 1 },
  lips: { width: 460, height: 230, region: 3 },
};

// FaceMask BlendModeType values, keyed like the editor's options (general_blend_mode_<key>).
export const BLENDS = { normal: 0, multiply: 1, overlay: 2, add: 3, screen: 4, soft_light: 5, color_burn: 7, color_dodge: 8, darken: 9, difference: 10, exclusion: 11, lighten: 12, linear_dodge: 13 };
// The colour each blend mode leaves the skin unchanged with. Transparent pixels carry it, so texture
// filtering at a shape's edge (or an engine path that ignores alpha) fades toward "no change" instead of
// toward some colour. Normal blend has no such colour; its transparent pixels take the nearest painted
// colour instead (see bleed()).
const NEUTRAL = {
  multiply: [255, 255, 255],
  color_burn: [255, 255, 255],
  darken: [255, 255, 255],
  screen: [0, 0, 0],
  add: [0, 0, 0],
  linear_dodge: [0, 0, 0],
  lighten: [0, 0, 0],
  color_dodge: [0, 0, 0],
  difference: [0, 0, 0],
  exclusion: [0, 0, 0],
  overlay: [128, 128, 128],
  soft_light: [128, 128, 128],
};

// Picked, not measured: far above the 7 spots, 44 lashes or 48 freckles of the looks made so far, low
// enough that one call cannot run for minutes.
export const LIMITS = { layers: 32, shapes: 400, points: 400, count: 1000 };

// Measured in face UV (1024) on models D, E, G, I (beauty notes 2026-11-08): the eye openings span
// y 465–485, the left one x 375–455; a full-face mask paints over them, tinting the iris and the white.
const EYE_OPENINGS = [
  { x0: 375, x1: 455, y0: 465, y1: 485 },
  { x0: 569, x1: 649, y0: 465, y1: 485 },
];

// Deterministic PRNG (mulberry32) so a seed always gives the same freckles and lashes.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseColor(c) {
  if (Array.isArray(c) && c.length === 3 && c.every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) return c.map(Math.round);
  const m = typeof c === 'string' && /^#?([0-9a-f]{6})$/i.exec(c);
  if (!m) throw Error(`INVALID_COLOR: ${JSON.stringify(c)}; use "#RRGGBB" or [r, g, b] in 0–255`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// A coverage canvas (0–1 per pixel) that shapes are unioned into: 1 - (1 - a)(1 - b), so overlapping
// shapes never exceed 1 and soft edges add up the way the old scripts' screen-combine did.
class Coverage {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.a = new Float32Array(w * h);
  }
  add(x, y, v) {
    if (v <= 0) return;
    const i = y * this.w + x;
    this.a[i] = 1 - (1 - this.a[i]) * (1 - Math.min(1, v));
  }
  box(x0, y0, x1, y1) {
    return [Math.max(0, Math.floor(x0)), Math.max(0, Math.floor(y0)), Math.min(this.w - 1, Math.ceil(x1)), Math.min(this.h - 1, Math.ceil(y1))];
  }
}

function spot(cv, { x, y, rx, ry = rx, angle = 0, peak = 1 }) {
  const t = (angle * Math.PI) / 180;
  const [ct, st] = [Math.cos(t), Math.sin(t)];
  const r = 3 * Math.max(rx, ry);
  const [x0, y0, x1, y1] = cv.box(x - r, y - r, x + r, y + r);
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = px + 0.5 - x;
      const dy = py + 0.5 - y;
      const u = (dx * ct + dy * st) / rx;
      const v = (-dx * st + dy * ct) / ry;
      cv.add(px, py, peak * Math.exp(-0.5 * (u * u + v * v)));
    }
  }
}

// Radius at each point of a polyline: one number, [start, end] tapering by length, or one per point.
function radii(points, radius) {
  if (typeof radius === 'number') return points.map(() => radius);
  if (radius.length === points.length) return radius;
  if (radius.length !== 2) throw Error(`INVALID_RADIUS: give one number, [start, end], or one radius per point (${points.length})`);
  const seg = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
  const total = seg.reduce((s, v) => s + v, 0) || 1;
  let run = 0;
  return points.map((_, i) => {
    if (i) run += seg[i - 1];
    return radius[0] + ((radius[1] - radius[0]) * run) / total;
  });
}

// Picked: half a pixel between samples keeps a curve's polygon edges below what anti-aliasing shows.
const CURVE_STEP = 0.5;

// The centripetal Catmull–Rom spline (α = 0.5) through `points`, sampled every CURVE_STEP px, with
// `values` (one per point) interpolated along each segment. Unlike the uniform form it makes no loops or
// cusps where the points are unevenly spaced, as measured lid points are. The ends get a mirrored
// phantom point, so the curve starts and ends heading along its first and last segment.
export function smoothLine(points, values) {
  const pts = [];
  const vals = [];
  points.forEach((p, i) => {
    if (i && p[0] === points[i - 1][0] && p[1] === points[i - 1][1]) return;
    pts.push(p);
    vals.push(values[i]);
  });
  if (pts.length < 3) return { points: pts, values: vals };
  const n = pts.length;
  const ext = [[2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]], ...pts, [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]]];
  const knot = (a, b) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const lerp = (a, b, ta, tb, t) => [a[0] + ((b[0] - a[0]) * (t - ta)) / (tb - ta), a[1] + ((b[1] - a[1]) * (t - ta)) / (tb - ta)];
  const outP = [pts[0]];
  const outV = [vals[0]];
  for (let i = 0; i < n - 1; i++) {
    const [p0, p1, p2, p3] = ext.slice(i, i + 4);
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const steps = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / CURVE_STEP));
    for (let s = 1; s <= steps; s++) {
      const t = t1 + ((t2 - t1) * s) / steps;
      const a1 = lerp(p0, p1, t0, t1, t);
      const a2 = lerp(p1, p2, t1, t2, t);
      const a3 = lerp(p2, p3, t2, t3, t);
      const b1 = lerp(a1, a2, t0, t2, t);
      const b2 = lerp(a2, a3, t1, t3, t);
      outP.push(lerp(b1, b2, t1, t2, t));
      outV.push(vals[i] + ((vals[i + 1] - vals[i]) * s) / steps);
    }
  }
  return { points: outP, values: outV };
}

// The single cubic Bézier that best fits `points` in least squares with its ends on the first and last
// point (Schneider, "An algorithm for automatically fitting digitized curves", 1990: chord-length
// parameters, the normal equations for the two inner control points, Newton reparameterisation).
// One such curve (an arc, or at most one S bend) is what a liner drawn in one stroke is; measured points carry a pixel or two of noise and
// would otherwise be followed kink by kink. Needs 4 or more points. Returns samples every CURVE_STEP
// px, `values` carried along by each point's parameter, and the largest distance of a point to the arc.
const NEWTON_PASSES = 4;
export function fitArc(points, values) {
  const n = points.length;
  const P0 = points[0];
  const P3 = points[n - 1];
  const chord = [0];
  for (let i = 1; i < n; i++) chord.push(chord[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  let t = chord.map((v) => v / chord[n - 1]);
  const at = (c, s) => {
    const u = 1 - s;
    return [0, 1].map((k) => u * u * u * c[0][k] + 3 * u * u * s * c[1][k] + 3 * u * s * s * c[2][k] + s * s * s * c[3][k]);
  };
  let ctrl = null;
  for (let pass = 0; pass <= NEWTON_PASSES; pass++) {
    let a11 = 0, a12 = 0, a22 = 0;
    const r1 = [0, 0];
    const r2 = [0, 0];
    for (let i = 0; i < n; i++) {
      const s = t[i];
      const u = 1 - s;
      const b1 = 3 * u * u * s;
      const b2 = 3 * u * s * s;
      a11 += b1 * b1;
      a12 += b1 * b2;
      a22 += b2 * b2;
      for (let k = 0; k < 2; k++) {
        const r = points[i][k] - u * u * u * P0[k] - s * s * s * P3[k];
        r1[k] += b1 * r;
        r2[k] += b2 * r;
      }
    }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-12) return null;
    const P1 = [0, 1].map((k) => (r1[k] * a22 - r2[k] * a12) / det);
    const P2 = [0, 1].map((k) => (a11 * r2[k] - a12 * r1[k]) / det);
    ctrl = [P0, P1, P2, P3];
    if (pass === NEWTON_PASSES) break;
    t = t.map((s, i) => {
      if (i === 0 || i === n - 1) return s;
      const u = 1 - s;
      const q = at(ctrl, s);
      const d1 = [0, 1].map((k) => 3 * (u * u * (P1[k] - P0[k]) + 2 * u * s * (P2[k] - P1[k]) + s * s * (P3[k] - P2[k])));
      const d2 = [0, 1].map((k) => 6 * (u * (P2[k] - 2 * P1[k] + P0[k]) + s * (P3[k] - 2 * P2[k] + P1[k])));
      const num = (q[0] - points[i][0]) * d1[0] + (q[1] - points[i][1]) * d1[1];
      const den = d1[0] * d1[0] + d1[1] * d1[1] + (q[0] - points[i][0]) * d2[0] + (q[1] - points[i][1]) * d2[1];
      return den ? Math.min(1, Math.max(0, s - num / den)) : s;
    });
  }
  const error = Math.max(...points.map((p, i) => Math.hypot(at(ctrl, t[i])[0] - p[0], at(ctrl, t[i])[1] - p[1])));
  const steps = Math.max(2, Math.ceil(chord[n - 1] / CURVE_STEP));
  const out = [];
  const vals = [];
  for (let s = 0; s <= steps; s++) {
    const f = s / steps;
    out.push(at(ctrl, f));
    let j = 0;
    while (j < n - 2 && t[j + 1] < f) j++;
    const span = t[j + 1] - t[j];
    vals.push(span > 0 ? values[j] + ((values[j + 1] - values[j]) * Math.min(1, Math.max(0, (f - t[j]) / span))) : values[j]);
  }
  return { points: out, values: vals, error, control: ctrl };
}

export const CURVES = ['arc', 'through', 'straight'];
// Picked: past 3 texture px (about 1 frame px on a close-up face) the points are not one stroke (two bends, or
// a deliberate corner) and the fit would move the line visibly off them.
export const ARC_TOLERANCE = 3;

// The line a shape draws through its points: one fitted arc (default; 4+ points), the smooth curve
// through every point, or straight pieces. Fit errors over ARC_TOLERANCE are noted in `warnings`.
function lineThrough(points, values, curve = 'arc', warnings, what) {
  if (curve === 'straight' || points.length < 3) return { points, values };
  if (curve === 'arc' && points.length >= 4) {
    const fit = fitArc(points, values);
    if (fit) {
      if (fit.error > ARC_TOLERANCE) warnings.push(`${what}：这些点不在一条弧上（离拟合的弧最远 ${fit.error.toFixed(1)} 像素），要严格经过每个点用 curve: "through"`);
      return fit;
    }
  }
  return smoothLine(points, values);
}

// Continues a line past its last point into a tail (a liner's wing): a quadratic Bézier whose control
// point lies on the line's end tangent, so the tail leaves in exactly the direction the line arrives,
// and whose tip is `length` px away, turned `lift` degrees upward (toward smaller y) from that direction.
// The radius goes on from the line's last radius to `radius` at the tip.
export function withTail(line, { length, lift, radius = 0.2 }) {
  const pts = line.points;
  const end = pts[pts.length - 1];
  // The last piece of the sampled line is its end tangent (curves are sampled every half pixel).
  let k = pts.length - 2;
  while (k > 0 && end[0] === pts[k][0] && end[1] === pts[k][1]) k--;
  const dx = end[0] - pts[k][0];
  const dy = end[1] - pts[k][1];
  const n = Math.hypot(dx, dy);
  if (!n) throw Error('TAIL_NO_DIRECTION: the line has no length to continue');
  const [tx, ty] = [dx / n, dy / n];
  const turn = (a) => [tx * Math.cos(a) - ty * Math.sin(a), tx * Math.sin(a) + ty * Math.cos(a)];
  const a = (lift * Math.PI) / 180;
  // Of the two ways to turn by `lift`, upward is the one whose tip ends higher on the texture.
  const [ux, uy] = turn(a)[1] <= turn(-a)[1] ? turn(a) : turn(-a);
  const tip = [end[0] + ux * length, end[1] + uy * length];
  const ctrl = [end[0] + tx * length * 0.5, end[1] + ty * length * 0.5];
  const steps = Math.max(2, Math.ceil(length / CURVE_STEP));
  const r0 = line.values[line.values.length - 1];
  const outP = [...pts];
  const outV = [...line.values];
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const u = 1 - t;
    outP.push([u * u * end[0] + 2 * u * t * ctrl[0] + t * t * tip[0], u * u * end[1] + 2 * u * t * ctrl[1] + t * t * tip[1]]);
    outV.push(r0 + (radius - r0) * t);
  }
  return { points: outP, values: outV };
}

// A round-capped stroke whose radius varies along the line; coverage is the analytic distance to the
// nearest segment against the radius there, anti-aliased over one pixel.
function stroke(cv, { points: given, radius, curve, tail }, warnings = [], what = 'stroke') {
  let line = lineThrough(given, radii(given, radius), curve, warnings, what);
  if (tail) line = withTail(line, tail);
  const points = line.points;
  const rs = line.values;
  const maxR = Math.max(...rs);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, y0, x1, y1] = cv.box(Math.min(...xs) - maxR - 1, Math.min(...ys) - maxR - 1, Math.max(...xs) + maxR + 1, Math.max(...ys) + maxR + 1);
  const bw = x1 - x0 + 1;
  const best = new Float32Array(bw * (y1 - y0 + 1));
  // Each segment only touches the pixels within its own radius, so a curve sampled every half pixel
  // costs its area, not area × segments.
  for (let i = 0; i < points.length; i++) {
    const j = Math.min(i + 1, points.length - 1);
    const [ax, ay] = points[i];
    const [bx, by] = points[j];
    const r = Math.max(rs[i], rs[j]) + 1;
    const [sx0, sy0, sx1, sy1] = cv.box(Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let py = sy0; py <= sy1; py++) {
      for (let px = sx0; px <= sx1; px++) {
        const cx = px + 0.5;
        const cy = py + 0.5;
        const t = len2 ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / len2)) : 0;
        const d = Math.hypot(cx - (ax + t * dx), cy - (ay + t * dy));
        const v = Math.max(0, Math.min(1, rs[i] + t * (rs[j] - rs[i]) - d + 0.5));
        const k = (py - y0) * bw + px - x0;
        if (v > best[k]) best[k] = v;
      }
    }
  }
  for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) cv.add(px, py, best[(py - y0) * bw + px - x0]);
}

// Even-odd polygon fill, anti-aliased by 4×4 supersampling: each sub-row's edge crossings are found
// once (scanline), then every sample in the row is inside when an odd number of crossings lie left of it.
function polygon(cv, { points }) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, y0, x1, y1] = cv.box(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
  const S = 4;
  const bw = x1 - x0 + 1;
  const count = new Uint8Array(bw);
  for (let py = y0; py <= y1; py++) {
    count.fill(0);
    for (let sy = 0; sy < S; sy++) {
      const y = py + (sy + 0.5) / S;
      const cross = [];
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if (yi > y !== yj > y) cross.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
      cross.sort((a, b) => a - b);
      for (let c = 0; c + 1 < cross.length; c += 2) {
        // Samples at px + (sx + 0.5) / S with cross[c] <= x < cross[c + 1].
        const first = Math.max(x0 * S, Math.ceil(cross[c] * S - 0.5));
        const last = Math.min((x1 + 1) * S - 1, Math.ceil(cross[c + 1] * S - 0.5) - 1);
        for (let k = first; k <= last; k++) count[Math.floor(k / S) - x0]++;
      }
    }
    for (let px = x0; px <= x1; px++) if (count[px - x0]) cv.add(px, py, count[px - x0] / (S * S));
  }
}

function inEllipse(x, y, e) {
  const u = (x - e.x) / e.rx;
  const v = (y - e.y) / (e.ry ?? e.rx);
  return u * u + v * v <= 1;
}

// Freckles: `count` soft dots placed uniformly inside an ellipse, outside the `avoid` ellipses.
function scatter(cv, s) {
  const r = rng(s.seed ?? 1);
  const [rmin, rmax] = s.radius;
  const [pmin, pmax] = s.peak ?? [1, 1];
  const ry = s.ry ?? s.rx;
  let placed = 0;
  for (let tries = 0; placed < s.count; tries++) {
    if (tries > s.count * 200) throw Error(`SCATTER_NO_ROOM: placed ${placed} of ${s.count} dots; the avoid areas cover most of the ellipse`);
    const x = s.x + (r() * 2 - 1) * s.rx;
    const y = s.y + (r() * 2 - 1) * ry;
    if (!inEllipse(x, y, { x: s.x, y: s.y, rx: s.rx, ry })) continue;
    if ((s.avoid || []).some((e) => inEllipse(x, y, e))) continue;
    const rad = rmin + r() * (rmax - rmin);
    spot(cv, { x, y, rx: rad, peak: pmin + r() * (pmax - pmin) });
    placed++;
  }
}

function pointAt(points, f) {
  const seg = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
  const total = seg.reduce((s, v) => s + v, 0);
  let want = Math.max(0, Math.min(1, f)) * total;
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i] || i === seg.length - 1) {
      const t = seg[i] ? Math.min(1, want / seg[i]) : 0;
      return [points[i][0] + (points[i + 1][0] - points[i][0]) * t, points[i][1] + (points[i + 1][1] - points[i][1]) * t];
    }
    want -= seg[i];
  }
  return points[0];
}

// Lashes: `count` tapering strands growing from a line. Angles are degrees in texture space (0 points
// right, -90 points up); angle and length go linearly from the line's first point to its last, and each
// strand bends by `curl` degrees between its root and its tip, so it curls toward its final direction.
function strands(cv, s) {
  const r = rng(s.seed ?? 1);
  const j = { angle: 6, length: 0.2, position: 0.3, ...s.jitter };
  const curl = ((s.curl ?? 12) * Math.PI) / 180;
  for (let i = 0; i < s.count; i++) {
    const f = s.count === 1 ? 0.5 : (i + (r() * 2 - 1) * j.position) / (s.count - 1);
    const t = Math.max(0, Math.min(1, f));
    const [bx, by] = pointAt(s.along, t);
    const ang = ((s.angle[0] + (s.angle[1] - s.angle[0]) * t + (r() * 2 - 1) * j.angle) * Math.PI) / 180;
    const len = (s.length[0] + (s.length[1] - s.length[0]) * t) * (1 + (r() * 2 - 1) * j.length);
    const mid = [bx + Math.cos(ang - curl) * len * 0.5, by + Math.sin(ang - curl) * len * 0.5];
    const tip = [bx + Math.cos(ang) * len, by + Math.sin(ang) * len];
    // A strand bends as a quadratic Bézier with `mid` as its control point, not as two straight pieces.
    const pts = s.curve === 'straight' ? [[bx, by], mid, tip] : bezier([bx, by], mid, tip);
    stroke(cv, { points: pts, radius: s.radius, curve: 'straight' });
  }
}

function bezier(a, c, b) {
  const steps = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / CURVE_STEP));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const u = 1 - t;
    return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
  });
}

const lineOf = (list, curve, warnings, what) => lineThrough(list, list.map(() => 0), curve, warnings, what).points;
// Each takes (coverage, shape, warnings, name of the shape for warnings).
const DRAW = {
  spot,
  stroke,
  polygon,
  band: (cv, s, w, what) => polygon(cv, { points: [...lineOf(s.top, s.curve, w, `${what} 上沿`), ...[...lineOf(s.bottom, s.curve, w, `${what} 下沿`)].reverse()] }),
  scatter,
  strands: (cv, s, w, what) => strands(cv, { ...s, along: lineOf(s.along, s.curve, w, `${what} 发根线`) }),
};

// Unions `src` reflected about the texture's vertical centre line, and shifted down by `dy` px
// (fractional, linear in y), into `cv`: the same strokes on the other eye or cheek, pixel for pixel,
// random freckles and lashes included.
function reflectInto(cv, src, dy) {
  const { w, h } = cv;
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    const y0 = Math.floor(sy);
    const f = sy - y0;
    if (y0 + 1 < 0 || y0 >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = w - 1 - x;
      const a = y0 >= 0 ? src.a[y0 * w + sx] : 0;
      const b = y0 + 1 < h ? src.a[(y0 + 1) * w + sx] : 0;
      cv.add(x, y, a * (1 - f) + b * f);
    }
  }
}

function gaussBlur(a, w, h, sigma) {
  if (!sigma) return a;
  const r = Math.ceil(sigma * 3);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const sum = k.reduce((s, v) => s + v, 0);
  const kn = k.map((v) => v / sum);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += a[y * w + Math.min(w - 1, Math.max(0, x + i))] * kn[i + r];
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * kn[i + r];
      out[y * w + x] = s;
    }
  }
  return out;
}

// A linear ramp from 0 to 1 over `feather` px inside each given edge of the clip box.
function clipFactor(x, y, c) {
  const f = c.feather || 0;
  const ramp = (d) => (f ? Math.max(0, Math.min(1, d / f)) : d >= 0 ? 1 : 0);
  let v = 1;
  if (c.y_min !== undefined) v *= ramp(y + 0.5 - c.y_min);
  if (c.y_max !== undefined) v *= ramp(c.y_max - (y + 0.5));
  if (c.x_min !== undefined) v *= ramp(x + 0.5 - c.x_min);
  if (c.x_max !== undefined) v *= ramp(c.x_max - (x + 0.5));
  return v;
}

// Bilinear resample of a straight-alpha RGBA PNG to w×h (premultiplied while filtering).
function loadBase(file, w, h) {
  const buf = fs.readFileSync(file);
  if (sniffImage(buf) !== 'image/png') throw Error(`BASE_NOT_PNG: ${file}`);
  const src = PNG.sync.read(buf);
  const out = { rgb: new Float32Array(w * h * 3), a: new Float32Array(w * h) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.max(0, Math.min(src.width - 1, ((x + 0.5) * src.width) / w - 0.5));
      const sy = Math.max(0, Math.min(src.height - 1, ((y + 0.5) * src.height) / h - 0.5));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const y1 = Math.min(src.height - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      let A = 0;
      const P = [0, 0, 0];
      for (const [px, py, wt] of [[x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)], [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy]]) {
        const i = (py * src.width + px) * 4;
        const a = (src.data[i + 3] / 255) * wt;
        A += a;
        for (let c = 0; c < 3; c++) P[c] += src.data[i + c] * a;
      }
      const o = y * w + x;
      out.a[o] = A;
      for (let c = 0; c < 3; c++) out.rgb[o * 3 + c] = A > 0 ? P[c] / A : 0;
    }
  }
  return out;
}

// Gives every transparent pixel the colour of the nearest painted one (breadth-first from the painted
// pixels), so filtering at an edge never mixes in a colour that is not there.
function bleed(rgb, a, w, h) {
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < w * h; i++) {
    if (a[i] >= 1 / 255) {
      seen[i] = 1;
      queue[tail++] = i;
    }
  }
  if (!tail) return false;
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i - x) / w;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (seen[n]) continue;
      seen[n] = 1;
      for (let c = 0; c < 3; c++) rgb[n * 3 + c] = rgb[i * 3 + c];
      queue[tail++] = n;
    }
  }
  return true;
}

function checkSpec(spec) {
  if (!LAYOUTS[spec.layout]) throw Error(`INVALID_LAYOUT: ${spec.layout}; use ${Object.keys(LAYOUTS).join(' / ')}`);
  if (!(spec.blend in BLENDS)) throw Error(`INVALID_BLEND: ${spec.blend}; use ${Object.keys(BLENDS).join(' / ')}`);
  if (!spec.layers.length || spec.layers.length > LIMITS.layers) throw Error(`INVALID_LAYERS: 1–${LIMITS.layers} layers`);
  let shapes = 0;
  for (const l of spec.layers) {
    for (const s of l.shapes) {
      shapes += s.mirror ? 2 : 1;
      for (const list of [s.points, s.top, s.bottom, s.along]) if (list && list.length > LIMITS.points) throw Error(`TOO_MANY_POINTS: at most ${LIMITS.points} points per line`);
      if (s.count > LIMITS.count) throw Error(`TOO_MANY: count at most ${LIMITS.count}`);
    }
  }
  if (shapes > LIMITS.shapes) throw Error(`TOO_MANY_SHAPES: ${shapes} (mirrored ones count twice), at most ${LIMITS.shapes}`);
}

// spec: { layout, blend, mirror_dy?, base?, layers: [{ color, opacity?, blur?, erase?, clip?, shapes }] }.
// Returns the RGBA pixels (straight alpha) and what to warn about.
export function paint(spec) {
  checkSpec(spec);
  const { width: w, height: h } = LAYOUTS[spec.layout];
  const rgb = new Float32Array(w * h * 3);
  const A = new Float32Array(w * h);
  if (spec.base) {
    const b = loadBase(spec.base, w, h);
    rgb.set(b.rgb);
    A.set(b.a);
  }
  const warnings = [];
  for (const [li, layer] of spec.layers.entries()) {
    const cv = new Coverage(w, h);
    const toMirror = layer.shapes.some((s) => s.mirror) ? new Coverage(w, h) : null;
    for (const [si, s] of layer.shapes.entries()) {
      const what = `第 ${li + 1} 层第 ${si + 1} 个形状（${s.type}）`;
      DRAW[s.type](cv, s, warnings, what);
      if (s.mirror) DRAW[s.type](toMirror, s, [], what);
    }
    if (toMirror) reflectInto(cv, toMirror, spec.mirror_dy ?? 0);
    const cov = gaussBlur(cv.a, w, h, layer.blur || 0);
    const op = layer.opacity ?? 1;
    const col = layer.erase ? null : parseColor(layer.color);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const la = Math.min(1, cov[i]) * op * (layer.clip ? clipFactor(x, y, layer.clip) : 1);
        if (la <= 0) continue;
        if (layer.erase) {
          A[i] *= 1 - la;
          continue;
        }
        const out = la + A[i] * (1 - la);
        for (let c = 0; c < 3; c++) rgb[i * 3 + c] = (col[c] * la + rgb[i * 3 + c] * A[i] * (1 - la)) / out;
        A[i] = out;
      }
    }
  }
  const neutral = NEUTRAL[spec.blend];
  const empty = spec.blend === 'normal' ? !bleed(rgb, A, w, h) : !A.some((v) => v >= 1 / 255);
  if (empty) throw Error('TEXTURE_EMPTY: nothing was painted (every pixel is transparent)');
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = Math.round(A[i] * 255);
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(neutral && a === 0 ? neutral[c] : rgb[i * 3 + c]);
    data[i * 4 + 3] = a;
  }
  if (spec.layout === 'face') {
    for (const e of EYE_OPENINGS) {
      let peak = 0;
      for (let y = e.y0; y <= e.y1; y++) for (let x = e.x0; x <= e.x1; x++) peak = Math.max(peak, A[y * w + x]);
      if (peak >= 0.02) warnings.push(`贴图在${e.x0 < w / 2 ? '左' : '右'}眼眼裂（x ${e.x0}–${e.x1}，y ${e.y0}–${e.y1}）里有 ${Math.round(peak * 100)}% 的不透明度：整脸妆容层在眼睛上照样画，会染进眼白和瞳孔；贴着下睫毛线的妆用 clip 的 y_min（约 488）把眼裂里的部分清掉`);
    }
  }
  return { width: w, height: h, data, warnings };
}

// The texture over mid-grey, for looking at what was painted.
export function previewPng({ width, height, data }) {
  const img = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) img.data[i * 4 + c] = Math.round(data[i * 4 + c] * a + 128 * (1 - a));
    img.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(img);
}

export function writeTexture(file, painted) {
  if (!path.isAbsolute(file) || !/\.png$/i.test(file)) throw Error(`INVALID_OUT: ${file}; give an absolute path ending in .png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const img = new PNG({ width: painted.width, height: painted.height });
  painted.data.copy(img.data);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, PNG.sync.write(img));
  fs.renameSync(tmp, file);
  return file;
}
