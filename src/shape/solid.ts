// What a body with a height carries beside its flat top and its plain side:
// where a point over the ground is drawn, the faces of a roof, the places of
// the openings of a side, and the outline of a set of points for a shadow.
// Plain geometry: no drawing library here.

import { DEG, type Vec2, type Vec3 } from '../core/math.ts';
import { pathAt, type PathTable } from '../motion/paths.ts';
import { cornerOutline, isRegion, type ShapeSpec } from './geometry.ts';
import { straightSkeleton } from './skeleton.ts';

/**
 * How a body stands at a frame, in the units of its top: its height `h`, and
 * what says where a point over the ground is drawn. In a flat layer `uh` is 0
 * and (ux, uy) is the direction down the screen, one unit long. In a plane of
 * a perspective layer (ux, uy) is the point of the ground the camera stands
 * over, and `uh` is how high the camera is over the ground the body stands on.
 */
export interface Upright {
  readonly h: number;
  readonly ux: number;
  readonly uy: number;
  readonly uh: number;
  /**
   * A body of a plane whose bodies may rise above the camera (a group with `tall`), taller than the camera is high:
   * its points are drawn at any height (highest), and none exactly at the height of the eye, where it has no place in
   * the plane (upright).
   */
  readonly tall?: boolean;
}

/** A point of a tall body this near the height of the eye, as a share of that height, is drawn this much off it. */
const EYE_GAP = 1e-3;

/**
 * Where the point `z` units over the foot of a body is drawn, on the upright
 * through the point (x, y) of its top, in the units of the top: at the height
 * of the body it is (x, y) itself, at 0 its foot, above the height a point
 * over the top.
 */
export function upright(u: Upright, x: number, y: number, z: number): Vec2 {
  if (u.uh === 0) return [x + u.ux * (u.h - z), y + u.uy * (u.h - z)];
  let below = u.uh - z;
  if (u.tall && Math.abs(below) < EYE_GAP * u.uh) below = below < 0 ? -EYE_GAP * u.uh : EYE_GAP * u.uh;
  const m = (u.uh - u.h) / below;
  return [u.ux + (x - u.ux) * m, u.uy + (y - u.uy) * m];
}

/** In a plane nothing over a body is drawn nearer the camera than this share of the way from its top to the camera. */
const NEAR_SHARE = 0.5;

/** The greatest height over the foot at which something on a body is drawn: in a plane, short of the camera. */
export function highest(u: Upright): number {
  return u.uh > 0 && !u.tall ? u.h + NEAR_SHARE * (u.uh - u.h) : Infinity;
}

// --- The outline of a body, corner by corner ---------------------------------------------------

/** A turn of the outline sharper than this is a corner between two faces. */
const CORNER = 20 * DEG;
/** Along a curve the outline keeps one point to this much turn. */
const CURVE_STEP = 7.5 * DEG;
/** A straight stretch this many times longer than the shorter of its neighbours is a face of its own. */
const SIDE_RATIO = 4;

/** The outline of a shape as the faces of a body are built on it. */
export interface Ring {
  /** Its points, clockwise on screen: the outward side of the stretch a -> b is (b.y - a.y, a.x - b.x). */
  readonly points: readonly Vec2[];
  /** True at a point where one face ends and the next starts: a sharp corner, or an end of a straight side. */
  readonly corner: readonly boolean[];
}

const ringCache = new WeakMap<ShapeSpec, Ring>();

/**
 * The outline of a shape with a few points: every corner, the two ends of
 * every straight side, and one point to each 7.5 degrees of a curve. Computed
 * once per spec object.
 */
export function ringOf(spec: ShapeSpec): Ring {
  let ring = ringCache.get(spec);
  if (!ring) {
    ring = buildRing(cornerOutline(spec));
    ringCache.set(spec, ring);
  }
  return ring;
}

function buildRing(source: readonly Vec2[]): Ring {
  // Repeated points go first.
  let pts: Vec2[] = [];
  for (const p of source) {
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) pts.push(p);
  }
  while (pts.length > 1 && Math.hypot(pts[0]![0] - pts[pts.length - 1]![0], pts[0]![1] - pts[pts.length - 1]![1]) <= 1e-9) pts.pop();
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (area < 0) pts.reverse();
  const turnAt = (list: readonly Vec2[], i: number): number => {
    const n = list.length;
    const a = list[(i - 1 + n) % n]!;
    const p = list[i]!;
    const b = list[(i + 1) % n]!;
    const ux = p[0] - a[0];
    const uy = p[1] - a[1];
    const vx = b[0] - p[0];
    const vy = b[1] - p[1];
    return Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
  };
  // Points on a straight stretch say nothing.
  pts = pts.filter((_, i) => turnAt(pts, i) > 1e-6);
  const n = pts.length;
  if (n < 3) return { points: pts, corner: pts.map(() => true) };
  const len = (i: number): number => Math.hypot(pts[(i + 1) % n]![0] - pts[i]![0], pts[(i + 1) % n]![1] - pts[i]![1]);
  const turns = pts.map((_, i) => turnAt(pts, i));
  const breaks = turns.map((t) => t >= CORNER);
  for (let i = 0; i < n; i++) {
    // A straight side between two curves: both its ends are kept, and end the curves.
    if (len(i) >= SIDE_RATIO * Math.min(len((i - 1 + n) % n), len((i + 1) % n))) {
      breaks[i] = true;
      breaks[(i + 1) % n] = true;
    }
  }
  const first = Math.max(0, breaks.indexOf(true));
  const points: Vec2[] = [];
  const corner: boolean[] = [];
  let turned = 0;
  for (let k = 0; k < n; k++) {
    const i = (first + k) % n;
    turned += turns[i]!;
    if (k === 0 || breaks[i] || turned >= CURVE_STEP - 1e-9) {
      points.push(pts[i]!);
      corner.push(breaks[i]!);
      turned = 0;
    }
  }
  return { points, corner };
}

const spanCache = new WeakMap<ShapeSpec, number>();

/** How far a shape reaches across: the longer side of the box round its outline. Computed once per spec object. */
export function spanOf(spec: ShapeSpec): number {
  let span = spanCache.get(spec);
  if (span === undefined) {
    if (spec.kind === 'circle') span = 2 * spec.r;
    else if (spec.kind === 'capsule') span = spec.length;
    else {
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const p of cornerOutline(spec)) {
        x0 = Math.min(x0, p[0]);
        x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]);
        y1 = Math.max(y1, p[1]);
      }
      span = Math.max(x1 - x0, y1 - y0, 0);
    }
    spanCache.set(spec, span);
  }
  return span;
}

/** The outline of a shape as the side of a body is built on it. */
export interface SideRing {
  /** Its corners in order, in the units of the shape. */
  readonly points: readonly Vec2[];
  /** 1 when they run clockwise on screen, -1 when they run the other way. */
  readonly way: 1 | -1;
  /** True when the outline has no bay. */
  readonly convex: boolean;
}

/** How far from its outline, in units of the stage, the side of a body may be drawn: nothing an eye can find. */
export const SIDE_TOLERANCE = 0.06;

const sideRingCache = new WeakMap<ShapeSpec, Map<number, SideRing>>();

/** The key of the outline with every corner in it. */
const EVERY_CORNER = -Infinity;

/**
 * The outline the side of a body is built on: the corners of the shape, without the points that say nothing. With
 * `unit`, the size of one unit of the shape on screen in units of the stage, the points that move the outline by
 * less than SIDE_TOLERANCE on screen say nothing either: a small body has a few corners, a large one all of them.
 * Computed once per spec object and per step of size; the steps are a factor of two apart.
 */
export function sideRing(spec: ShapeSpec, unit?: number): SideRing {
  let rings = sideRingCache.get(spec);
  if (!rings) {
    rings = new Map();
    sideRingCache.set(spec, rings);
  }
  // The outline may be off by 2^step of its own units.
  const step = unit !== undefined && unit > 0 && Number.isFinite(unit) ? Math.max(-40, Math.min(40, Math.floor(Math.log2(SIDE_TOLERANCE / unit)))) : EVERY_CORNER;
  let ring = rings.get(step);
  if (!ring) {
    if (step === EVERY_CORNER) {
      const all = cornerOutline(spec);
      const n = all.length;
      const points: Vec2[] = [];
      let area = 0;
      for (let i = 0; i < n; i++) {
        const before = all[(i + n - 1) % n]!;
        const p = all[i]!;
        const after = all[(i + 1) % n]!;
        area += p[0] * after[1] - after[0] * p[1];
        const ax = p[0] - before[0];
        const ay = p[1] - before[1];
        const bx = after[0] - p[0];
        const by = after[1] - p[1];
        // A point half-way along a straight stretch says nothing: the stretch is as straight without it.
        const straight = Math.abs(ax * by - ay * bx) <= 1e-9 * Math.hypot(ax, ay) * Math.hypot(bx, by) && ax * bx + ay * by > 0;
        if (!straight) points.push(p);
      }
      const way = area >= 0 ? 1 : -1;
      const kept = points.length >= 3 ? points : all;
      ring = { points: kept, way, convex: noBay(kept, way) };
    } else {
      const whole = sideRing(spec);
      const kept = thinned(whole.points, 2 ** step);
      ring = kept.length >= 3 && kept.length < whole.points.length ? { points: kept, way: whole.way, convex: noBay(kept, whole.way) } : whole;
    }
    rings.set(step, ring);
  }
  return ring;
}

/** True when a closed outline turns one way at every corner, and once round in all. */
function noBay(points: readonly Vec2[], way: 1 | -1): boolean {
  const n = points.length;
  let turned = 0;
  for (let i = 0; i < n; i++) {
    const a = points[(i + n - 1) % n]!;
    const b = points[i]!;
    const c = points[(i + 1) % n]!;
    const ax = b[0] - a[0];
    const ay = b[1] - a[1];
    const bx = c[0] - b[0];
    const by = c[1] - b[1];
    const cross = way * (ax * by - ay * bx);
    if (cross < -1e-9 * Math.hypot(ax, ay) * Math.hypot(bx, by)) return false;
    turned += Math.atan2(cross, ax * bx + ay * by);
  }
  return Math.abs(turned - 2 * Math.PI) < 1e-6;
}

/** A closed outline without the points that lie within `off` of the line between the points kept beside them. */
function thinned(points: readonly Vec2[], off: number): Vec2[] {
  const n = points.length;
  if (n < 4) return [...points];
  // Two points to start from: the first, and the one farthest from it.
  let far = 1;
  let most = -1;
  for (let i = 1; i < n; i++) {
    const d = (points[i]![0] - points[0]![0]) ** 2 + (points[i]![1] - points[0]![1]) ** 2;
    if (d > most) {
      most = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  // Each span runs from a kept point to a later kept one; the second may be the first again, counted as n.
  const spans: number[] = [0, far, far, n];
  while (spans.length > 0) {
    const to = spans.pop()!;
    const from = spans.pop()!;
    if (to - from < 2) continue;
    const a = points[from]!;
    const b = points[to % n]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let at = from;
    for (let i = from + 1; i < to; i++) {
      const p = points[i]!;
      // How far the point lies from the stretch between the two ends.
      const s = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
      const d = (p[0] - a[0] - s * dx) ** 2 + (p[1] - a[1] - s * dy) ** 2;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > off * off) {
      keep[at] = 1;
      spans.push(from, at, at, to);
    }
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]!);
  return out;
}

/**
 * The runs of an outline whose side is turned to the viewer, as pairs of numbers: the stretch a run starts with (the
 * stretch i runs from the point i to the next one) and how many stretches it has. `foot` says where a point p of the
 * top stands: at k p + (x, y), with k above 0. The sides of the other stretches lie behind the body. An outline
 * without a bay has one run at most.
 */
export function seenRuns(ring: SideRing, foot: { readonly k: number; readonly x: number; readonly y: number }): number[] {
  const pts = ring.points;
  const n = pts.length;
  const far = 1 - foot.k;
  // The piece a, b, b', a' under a stretch a -> b is seen when it winds against the outline. Its area is
  // (1 + k) / 2 times this number.
  const seen = (i: number): boolean => {
    const a = pts[i]!;
    const b = pts[i + 1 === n ? 0 : i + 1]!;
    return ring.way * (far * (a[0] * b[1] - b[0] * a[1]) + (b[0] - a[0]) * foot.y - (b[1] - a[1]) * foot.x) < 0;
  };
  // Start after a stretch that is turned away, so that no run is cut in two.
  let start = 0;
  while (start < n && seen(start)) start++;
  if (start === n) return [0, n];
  const out: number[] = [];
  for (let k = 1; k < n; ) {
    const i = (start + k) % n;
    if (!seen(i)) {
      k++;
      continue;
    }
    let len = 1;
    while (k + len < n && seen((start + k + len) % n)) len++;
    out.push(i, len);
    k += len;
  }
  return out;
}

// --- Roofs -------------------------------------------------------------------------------------

/** A roof, as a body is given one. */
export interface Roof {
  readonly kind: 'gable' | 'hip' | 'cone' | 'dome';
  readonly height: number;
  readonly ridge?: number;
  /** A hip on a region: how far in the slopes run before the roof is flat. */
  readonly run?: number;
  /** How far the tones of the slopes lie from the fill: 1 as the light gives them. */
  readonly contrast?: number;
}

/** One flat face of a roof. */
export interface RoofFace {
  /** Its corners, three numbers each: x and y in the units of the shape, and how high over the top of the body. Seen from outside they run clockwise on screen. */
  readonly points: Float64Array;
  /** The way it faces: one unit long, the third number up. */
  readonly normal: Vec3;
  /** True for an upright face (the end of a gable): it is part of the side of the body. */
  readonly wall: boolean;
  /**
   * On a face of a curved roof: the way the roof looks at each corner, three numbers each, one unit long. Such a face
   * is lit corner by corner, so that light and shade meet along a smooth line; a face without it is flat, and lit as a whole.
   */
  readonly normals?: Float64Array;
}

/** How many rings of faces a dome has between its foot and its top. */
const DOME_RINGS = 6;

const roofCache = new WeakMap<Roof, { spec: ShapeSpec; faces: readonly RoofFace[] }>();

/** The faces of a roof on a shape. Computed once per roof object, and again when its shape is another. */
export function roofFaces(spec: ShapeSpec, roof: Roof): readonly RoofFace[] {
  const hit = roofCache.get(roof);
  if (hit && hit.spec === spec) return hit.faces;
  const ring = ringOf(spec).points;
  const faces = isRegion(spec) ? regionRoof(ring, roof) : buildRoof(ring, roof);
  roofCache.set(roof, { spec, faces });
  return faces;
}

/**
 * A hip on a free outline: a slope on every stretch of it, all as steep, that meet in ridges over the middle of a
 * wing and in valleys where two wings meet (the straight skeleton of the outline). The slopes rise `height` over
 * `run`, and the roof is flat at `height` past it; without a run they rise to `height` at the deepest point. An
 * outline too broken for it keeps a flat top.
 */
function regionRoof(ring: readonly Vec2[], roof: Roof): RoofFace[] {
  const out: RoofFace[] = [];
  const skeleton = ring.length >= 3 ? straightSkeleton(ring, roof.run) : null;
  const reach = roof.run ?? skeleton?.depth ?? 0;
  if (!skeleton || !(reach > 0)) {
    const top = face(ring.flatMap((p) => [p[0], p[1], 0]), false);
    return top ? [top] : out;
  }
  for (const f of skeleton.faces) {
    const points = f.points.slice();
    for (let j = 2; j < points.length; j += 3) points[j] = (roof.height * Math.min(points[j]!, reach)) / reach;
    const slope = face(points, false);
    if (slope) out.push(slope);
  }
  return out;
}

function face(points: number[], wall: boolean, normals?: number[]): RoofFace | null {
  // The way a face looks is the sum of the cross products round it (Newell).
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const m = points.length / 3;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = points[3 * i]!;
    const ay = points[3 * i + 1]!;
    const az = points[3 * i + 2]!;
    const bx = points[3 * j]!;
    const by = points[3 * j + 1]!;
    const bz = points[3 * j + 2]!;
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  const l = Math.hypot(nx, ny, nz);
  if (m < 3 || l < 1e-9) return null;
  return { points: Float64Array.from(points), normal: [nx / l, ny / l, nz / l], wall, ...(normals ? { normals: Float64Array.from(normals) } : {}) };
}

/** The part of a convex outline where a x + b y + c is not below 0. */
function clipTo(poly: readonly Vec2[], a: number, b: number, c: number, eps: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const fp = a * p[0] + b * p[1] + c;
    const fq = a * q[0] + b * q[1] + c;
    if (fp >= -eps) out.push(p);
    if ((fp > eps && fq < -eps) || (fp < -eps && fq > eps)) {
      const t = fp / (fp - fq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

function buildRoof(ring: readonly Vec2[], roof: Roof): RoofFace[] {
  const out: RoofFace[] = [];
  const add = (points: number[], wall: boolean, normals?: number[]): void => {
    const f = face(points, wall, normals);
    if (f) out.push(f);
  };
  const n = ring.length;
  if (n < 3) return out;
  const H = roof.height;
  if (roof.kind === 'cone' || roof.kind === 'dome') {
    // Both stand over the middle of the outline: the middle of its area.
    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      const w = a[0] * b[1] - b[0] * a[1];
      area += w;
      cx += (a[0] + b[0]) * w;
      cy += (a[1] + b[1]) * w;
    }
    cx /= 3 * area;
    cy /= 3 * area;
    // The outward side of each stretch of the outline, and how far the stretch is from the middle.
    const side: Vec2[] = [];
    const reach: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      side.push([(b[1] - a[1]) / l, (a[0] - b[0]) / l]);
      reach.push((a[0] - cx) * side[i]![0] + (a[1] - cy) * side[i]![1]);
    }
    // At a point where the outline bends gently the roof is round: it looks the way between the two stretches there.
    // At a corner each of them keeps its own way.
    const at = (point: number, stretch: number): { x: number; y: number; d: number } => {
      const other = point === stretch ? (stretch - 1 + n) % n : (stretch + 1) % n;
      const s = side[stretch]!;
      const o = side[other]!;
      if (s[0] * o[0] + s[1] * o[1] < Math.cos(CORNER)) return { x: s[0], y: s[1], d: reach[stretch]! };
      const l = Math.hypot(s[0] + o[0], s[1] + o[1]);
      return { x: (s[0] + o[0]) / l, y: (s[1] + o[1]) / l, d: (reach[stretch]! + reach[other]!) / 2 };
    };
    // The way the roof looks over a point of the outline, a share `turn` of a quarter circle up it (a cone: all the way up alike).
    const way = (to: number[], w: { x: number; y: number; d: number }, turn: number): void => {
      const flat = roof.kind === 'cone' ? H : H * Math.cos(turn);
      const up = roof.kind === 'cone' ? w.d : w.d * Math.sin(turn);
      const l = Math.hypot(flat, up) || 1;
      to.push((w.x * flat) / l, (w.y * flat) / l, up / l);
    };
    const rings = roof.kind === 'cone' ? 1 : DOME_RINGS;
    for (let j = 0; j < rings; j++) {
      // A cone goes straight to its point; a dome by rings that draw in as a quarter of a circle does.
      const t0 = (Math.PI / 2) * (j / rings);
      const t1 = (Math.PI / 2) * ((j + 1) / rings);
      const f0 = roof.kind === 'cone' ? 1 : Math.cos(t0);
      const z0 = roof.kind === 'cone' ? 0 : H * Math.sin(t0);
      // The top is one point exactly: every face that ends there ends at the same numbers.
      const f1 = j === rings - 1 ? 0 : Math.cos(t1);
      const z1 = j === rings - 1 ? H : H * Math.sin(t1);
      for (let i = 0; i < n; i++) {
        const k = (i + 1) % n;
        const a = ring[i]!;
        const b = ring[k]!;
        const wa = at(i, i);
        const wb = at(k, i);
        // Four corners, also where the two upper ones are one point: each keeps the way the roof looks along its own line up.
        const quad = [cx + (a[0] - cx) * f0, cy + (a[1] - cy) * f0, z0, cx + (b[0] - cx) * f0, cy + (b[1] - cy) * f0, z0, cx + (b[0] - cx) * f1, cy + (b[1] - cy) * f1, z1, cx + (a[0] - cx) * f1, cy + (a[1] - cy) * f1, z1];
        const ways: number[] = [];
        way(ways, wa, t0);
        way(ways, wb, t0);
        way(ways, wb, t1);
        way(ways, wa, t1);
        // A face of a pyramid is flat: one way all over.
        const flat = roof.kind === 'cone' && wa.x === wb.x && wa.y === wb.y;
        add(quad, false, flat ? undefined : ways);
      }
    }
    return out;
  }

  // A gable and a hip: flat slopes that meet in a ridge. The ridge runs along u through the middle of the outline.
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of ring) {
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]);
    y1 = Math.max(y1, p[1]);
  }
  const angle = roof.ridge === undefined ? (x1 - x0 >= y1 - y0 ? 0 : 90) : roof.ridge;
  const ux = Math.cos(angle * DEG);
  const uy = Math.sin(angle * DEG);
  const vx = -uy;
  const vy = ux;
  let s0 = Infinity;
  let s1 = -Infinity;
  let d0 = Infinity;
  let d1 = -Infinity;
  for (const p of ring) {
    const s = p[0] * ux + p[1] * uy;
    const d = p[0] * vx + p[1] * vy;
    s0 = Math.min(s0, s);
    s1 = Math.max(s1, s);
    d0 = Math.min(d0, d);
    d1 = Math.max(d1, d);
  }
  const S = (s1 - s0) / 2;
  const D = (d1 - d0) / 2;
  const sm = (s0 + s1) / 2;
  const dm = (d0 + d1) / 2;
  if (!(S > 1e-9 && D > 1e-9)) return out;
  // Each slope is a height that falls evenly away from the ridge: z = c + a x + b y.
  const slopes: { a: number; b: number; c: number }[] = [];
  const k = H / (roof.kind === 'hip' ? Math.min(S, D) : D);
  slopes.push({ a: -k * vx, b: -k * vy, c: k * (D + dm) }, { a: k * vx, b: k * vy, c: k * (D - dm) });
  if (roof.kind === 'hip') slopes.push({ a: -k * ux, b: -k * uy, c: k * (S + sm) }, { a: k * ux, b: k * uy, c: k * (S - sm) });
  const eps = 1e-9 * Math.max(1, H);
  const heightAt = (x: number, y: number): number => {
    let z = Infinity;
    for (const s of slopes) z = Math.min(z, s.c + s.a * x + s.b * y);
    return Math.max(0, z);
  };
  for (const s of slopes) {
    // A slope reaches as far as it is the lowest of them all.
    let poly: Vec2[] = ring.slice();
    for (const o of slopes) {
      if (o !== s && poly.length >= 3) poly = clipTo(poly, o.a - s.a, o.b - s.b, o.c - s.c, eps);
    }
    if (poly.length < 3) continue;
    const points: number[] = [];
    for (const p of poly) points.push(p[0], p[1], Math.max(0, s.c + s.a * p[0] + s.b * p[1]));
    add(points, false);
  }
  // Where the roof stands higher than the top of the body at its edge, an upright face closes it: the end of a gable.
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    // The stretch is cut where two slopes meet over it, so that each part lies under one slope.
    const cuts = [0, 1];
    for (let p = 0; p < slopes.length; p++) {
      for (let q = p + 1; q < slopes.length; q++) {
        const fa = slopes[p]!.c - slopes[q]!.c + (slopes[p]!.a - slopes[q]!.a) * a[0] + (slopes[p]!.b - slopes[q]!.b) * a[1];
        const fb = slopes[p]!.c - slopes[q]!.c + (slopes[p]!.a - slopes[q]!.a) * b[0] + (slopes[p]!.b - slopes[q]!.b) * b[1];
        if ((fa > eps && fb < -eps) || (fa < -eps && fb > eps)) cuts.push(fa / (fa - fb));
      }
    }
    cuts.sort((p, q) => p - q);
    for (let c = 0; c + 1 < cuts.length; c++) {
      if (cuts[c + 1]! - cuts[c]! < 1e-9) continue;
      const px = a[0] + (b[0] - a[0]) * cuts[c]!;
      const py = a[1] + (b[1] - a[1]) * cuts[c]!;
      const qx = a[0] + (b[0] - a[0]) * cuts[c + 1]!;
      const qy = a[1] + (b[1] - a[1]) * cuts[c + 1]!;
      const pz = heightAt(px, py);
      const qz = heightAt(qx, qy);
      if (Math.max(pz, qz) <= 1e-6 * H) continue;
      const points = [px, py, 0, qx, qy, 0];
      if (qz > 1e-6 * H) points.push(qx, qy, qz);
      if (pz > 1e-6 * H) points.push(px, py, pz);
      add(points, true);
    }
  }
  return out;
}

/** The light of a roof stands this high over the ground: the share of it that falls straight down. */
const LIGHT_UP = Math.SQRT1_2;
/**
 * A slope turned to the viewer is a little lighter than one turned away, as under an open sky. Without it two slopes
 * that lean equally far from the light are one patch, and the edge between them is lost.
 */
const VIEW_FILL = 0.2;

/** The tones of a roof, from its deepest shade to its lit side: what lies flat is 'base', the fill itself. */
export const SHADES = ['shadow2', 'shadow1', 'base', 'rim'] as const;
/** How lit a slope is at each of those tones. */
const SHADE_STOPS = [-0.3, 0.2, LIGHT_UP, 1] as const;

/** The direction on the ground from a body toward the viewer, as long as the viewer looks along the ground (1) or down on it (0). */
export function viewOf(u: Upright): Vec2 {
  if (u.uh === 0) return [u.ux * Math.SQRT1_2, u.uy * Math.SQRT1_2];
  const l = Math.hypot(u.ux, u.uy, u.uh - u.h) || 1;
  return [u.ux / l, u.uy / l];
}

/**
 * How a slope that looks the way (nx, ny, nz) is lit, as a place on the scale
 * of SHADES: 0 the deepest shade, 1, 2 (the fill: what lies flat), 3 the lit
 * side, and every place between two of them. `light` is the direction of the
 * light on the ground (one unit long, toward the light), `view` the one toward
 * the viewer (viewOf).
 */
export function shadeOf(nx: number, ny: number, nz: number, light: Vec2, view: Vec2): number {
  const lit = (nx * light[0] + ny * light[1]) * Math.sqrt(1 - LIGHT_UP * LIGHT_UP) + nz * LIGHT_UP + VIEW_FILL * (nx * view[0] + ny * view[1]);
  for (let i = 1; i < SHADE_STOPS.length; i++) {
    if (lit < SHADE_STOPS[i]!) return Math.max(0, i - 1 + (lit - SHADE_STOPS[i - 1]!) / (SHADE_STOPS[i]! - SHADE_STOPS[i - 1]!));
  }
  return SHADE_STOPS.length - 1;
}

/**
 * The part of a face where a value that runs evenly along its edges lies
 * between `lo` and `hi`. `corners` are x, y and the value, three numbers each;
 * so is the result. Two faces that share an edge are cut at the same point of
 * it: the parts of a roof in one tone fit each other without a gap.
 */
export function between(corners: readonly number[], lo: number, hi: number): number[] {
  let poly = corners;
  for (const [limit, over] of [[lo, true], [hi, false]] as const) {
    const out: number[] = [];
    const m = poly.length / 3;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const vi = poly[3 * i + 2]!;
      const vj = poly[3 * j + 2]!;
      const keep = over ? vi >= limit : vi <= limit;
      if (keep) out.push(poly[3 * i]!, poly[3 * i + 1]!, vi);
      if (keep !== (over ? vj >= limit : vj <= limit)) {
        const u = (limit - vi) / (vj - vi);
        out.push(poly[3 * i]! + (poly[3 * j]! - poly[3 * i]!) * u, poly[3 * i + 1]! + (poly[3 * j + 1]! - poly[3 * i + 1]!) * u, limit);
      }
    }
    poly = out;
  }
  return poly as number[];
}

// --- Openings ----------------------------------------------------------------------------------

/** The openings of a side, as a body is given them. */
export interface Openings {
  readonly shape: 'rect' | 'arch';
  readonly width: number;
  readonly height: number;
  readonly step: number;
  readonly rows: number;
  readonly sill?: number;
  readonly inset: number;
}

/** One column of openings: where it is along the top of the wall. Every row has an opening in it. */
export interface OpeningColumn {
  /** Points of the top of the wall across the opening, three numbers each: x, y, and how far across the opening the point is, 0..1. */
  readonly across: Float64Array;
  /** The middle of the opening on the top of the wall, and the outward side of the wall there (one unit long). */
  readonly mx: number;
  readonly my: number;
  readonly nx: number;
  readonly ny: number;
}

const openingCache = new WeakMap<Openings, { spec: ShapeSpec; columns: readonly OpeningColumn[] }>();

/** An opening is left out where the wall turns by more than this under it. */
const OPENING_MAX_TURN = 30 * DEG;

/**
 * Where the openings of a body are along its outline. Each face (from one
 * corner to the next) takes as many as fit between its insets, placed about
 * its middle; an outline without a corner is one face all the way round, with
 * the openings spread evenly. Computed once per openings object, and again
 * when its shape is another.
 */
export function openingColumns(spec: ShapeSpec, o: Openings): readonly OpeningColumn[] {
  const hit = openingCache.get(o);
  if (hit && hit.spec === spec) return hit.columns;
  const columns = buildColumns(ringOf(spec), o);
  openingCache.set(o, { spec, columns });
  return columns;
}

function buildColumns(ring: Ring, o: Openings): OpeningColumn[] {
  const out: OpeningColumn[] = [];
  const n = ring.points.length;
  if (n < 3) return out;
  const first = ring.corner.indexOf(true);
  // The faces: runs of points from one corner to the next, or the whole outline when it has none.
  const runs: { pts: Vec2[]; closed: boolean }[] = [];
  if (first < 0) runs.push({ pts: [...ring.points, ring.points[0]!], closed: true });
  else {
    let run: Vec2[] = [ring.points[first]!];
    for (let k = 1; k <= n; k++) {
      const i = (first + k) % n;
      run.push(ring.points[i]!);
      if (ring.corner[i]) {
        runs.push({ pts: run, closed: false });
        run = [ring.points[i]!];
      }
    }
  }
  const across = o.shape === 'arch' ? 8 : 1;
  for (const run of runs) {
    const cum = [0];
    for (let i = 1; i < run.pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(run.pts[i]![0] - run.pts[i - 1]![0], run.pts[i]![1] - run.pts[i - 1]![1]));
    const length = cum[cum.length - 1]!;
    // Where a length along the face lies, and which way the face runs there. A face all the way round goes on past its seam.
    const at = (s: number): { x: number; y: number; dx: number; dy: number } => {
      let v = run.closed ? ((s % length) + length) % length : Math.min(length, Math.max(0, s));
      let i = 1;
      while (i < cum.length - 1 && cum[i]! < v) i++;
      const span = cum[i]! - cum[i - 1]!;
      v = span > 1e-12 ? (v - cum[i - 1]!) / span : 0;
      const a = run.pts[i - 1]!;
      const b = run.pts[i]!;
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return { x: a[0] + (b[0] - a[0]) * v, y: a[1] + (b[1] - a[1]) * v, dx: (b[0] - a[0]) / l, dy: (b[1] - a[1]) / l };
    };
    const middles: number[] = [];
    if (run.closed) {
      const count = length >= o.width ? Math.max(1, Math.round(length / o.step)) : 0;
      for (let j = 0; j < count; j++) middles.push(((j + 0.5) * length) / count);
    } else {
      const free = length - 2 * o.inset;
      if (free >= o.width - 1e-9) {
        const count = Math.floor((free - o.width) / o.step + 1e-9) + 1;
        for (let j = 0; j < count; j++) middles.push(length / 2 + (j - (count - 1) / 2) * o.step);
      }
    }
    // On a curve the foot and the head of an opening follow the wall.
    const steps = run.pts.length > 2 ? Math.max(across, 4) : across;
    for (const s of middles) {
      const a = at(s - o.width / 2);
      const b = at(s + o.width / 2);
      if (Math.abs(Math.atan2(a.dx * b.dy - a.dy * b.dx, a.dx * b.dx + a.dy * b.dy)) > OPENING_MAX_TURN) continue;
      const mid = at(s);
      const data = new Float64Array(3 * (steps + 1));
      for (let j = 0; j <= steps; j++) {
        const p = at(s - o.width / 2 + (o.width * j) / steps);
        data[3 * j] = p.x;
        data[3 * j + 1] = p.y;
        data[3 * j + 2] = j / steps;
      }
      out.push({ across: data, mx: mid.x, my: mid.y, nx: mid.dy, ny: -mid.dx });
    }
  }
  return out;
}

const wallCache = new WeakMap<Openings, { table: PathTable; middles: readonly number[] }>();

/**
 * Where the openings of a wall are along its line: the middle of each, as a length from the start of the line. The
 * faces of the wall run from one sharp corner of the line to the next (an end of an open line is one), and each takes
 * its openings as a face of a body does; a closed line without a corner is one face all the way round. Computed once
 * per openings object, and again when its line is another.
 */
export function wallOpenings(table: PathTable, o: Openings): readonly number[] {
  const hit = wallCache.get(o);
  if (hit && hit.table === table) return hit.middles;
  const middles = layWall(table, o);
  wallCache.set(o, { table, middles });
  return middles;
}

function layWall(table: PathTable, o: Openings): number[] {
  const { xs, ys, cum, length, closed } = table;
  const out: number[] = [];
  if (!(length > 1e-9)) return out;
  // The samples with a length between them, and the way the line runs on from each.
  const at: number[] = [];
  for (let i = 0; i < cum.length; i++) if (at.length === 0 || cum[i]! - cum[at[at.length - 1]!]! > 1e-9) at.push(i);
  if (closed && at.length > 1 && length - cum[at[at.length - 1]!]! <= 1e-9) at.pop();
  const m = at.length;
  if (m < 2) return out;
  const way = (k: number): number => {
    const i = at[k]!;
    const j = k + 1 < m ? at[k + 1]! : closed ? at[0]! : -1;
    if (j < 0) return Math.atan2(ys[i]! - ys[at[k - 1]!]!, xs[i]! - xs[at[k - 1]!]!);
    return Math.atan2(ys[j]! - ys[i]!, xs[j]! - xs[i]!);
  };
  const turn = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
  // The corners, as lengths along the line.
  const corners: number[] = [];
  for (let k = closed ? 0 : 1; k < (closed ? m : m - 1); k++) if (turn(way((k - 1 + m) % m), way(k)) >= CORNER) corners.push(cum[at[k]!]!);
  // The faces: from a start, so long.
  const faces: { start: number; long: number; round: boolean }[] = [];
  if (closed && corners.length === 0) faces.push({ start: 0, long: length, round: true });
  else if (closed) {
    for (let c = 0; c < corners.length; c++) {
      const next = c + 1 < corners.length ? corners[c + 1]! : corners[0]! + length;
      faces.push({ start: corners[c]!, long: next - corners[c]!, round: false });
    }
  } else {
    const ends = [0, ...corners, length];
    for (let c = 0; c + 1 < ends.length; c++) faces.push({ start: ends[c]!, long: ends[c + 1]! - ends[c]!, round: false });
  }
  for (const f of faces) {
    const middles: number[] = [];
    if (f.round) {
      const count = f.long >= o.width ? Math.max(1, Math.round(f.long / o.step)) : 0;
      for (let j = 0; j < count; j++) middles.push(((j + 0.5) * f.long) / count);
    } else {
      const free = f.long - 2 * o.inset;
      if (free >= o.width - 1e-9) {
        const count = Math.floor((free - o.width) / o.step + 1e-9) + 1;
        for (let j = 0; j < count; j++) middles.push(f.start + f.long / 2 + (j - (count - 1) / 2) * o.step);
      }
    }
    for (const s of middles) {
      // An opening is left out where the wall turns too far under it.
      const a = pathAt(table, s - o.width / 2).angle;
      const b = pathAt(table, s + o.width / 2).angle;
      if (turn(a, b) > OPENING_MAX_TURN) continue;
      out.push(closed ? s - Math.floor(s / length) * length : s);
    }
  }
  return out.sort((p, q) => p - q);
}

/**
 * The foot and the head of the opening of each row, over the foot of the
 * body: the rows share `full`, the height of the body at its highest, and an
 * opening sits `sill` over the foot of its row, or in its middle.
 */
export function openingRows(o: Openings, full: number): { foot: number; head: number }[] {
  const out: { foot: number; head: number }[] = [];
  const row = full / o.rows;
  const sill = o.sill ?? Math.max(0, (row - o.height) / 2);
  for (let j = 0; j < o.rows; j++) out.push({ foot: j * row + sill, head: Math.min((j + 1) * row, j * row + sill + o.height) });
  return out;
}

// --- The outline of a set of points ------------------------------------------------------------

/**
 * The outline round a set of points (x, y pairs), as x, y pairs that run one
 * way round: what a convex body covers when its corners are these points.
 */
export function hull(points: readonly number[]): number[] {
  const n = points.length / 2;
  if (n < 3) return points.slice();
  const order = Array.from({ length: n }, (_, i) => i).sort((p, q) => points[2 * p]! - points[2 * q]! || points[2 * p + 1]! - points[2 * q + 1]!);
  const out: number[] = [];
  const turn = (x: number, y: number): boolean => {
    const m = out.length;
    return (out[m - 2]! - out[m - 4]!) * (y - out[m - 3]!) - (out[m - 1]! - out[m - 3]!) * (x - out[m - 4]!) <= 0;
  };
  for (const i of order) {
    const x = points[2 * i]!;
    const y = points[2 * i + 1]!;
    while (out.length >= 4 && turn(x, y)) out.length -= 2;
    out.push(x, y);
  }
  const lower = out.length + 2;
  for (let k = n - 2; k >= 0; k--) {
    const x = points[2 * order[k]!]!;
    const y = points[2 * order[k]! + 1]!;
    while (out.length >= lower && turn(x, y)) out.length -= 2;
    out.push(x, y);
  }
  out.length -= 2;
  return out;
}
