// Shape primitives as plain data, plus the geometry the rest of the engine needs
// from them: an outline polyline, a size, a centre. No drawing library here, so
// physics and checks can use shapes without touching Skia.
//
// Local space: x to the right, y down, the shape sits around its own origin.

import { TAU, type Vec2 } from '../core/math.ts';
import { Rng } from '../core/rng.ts';

export interface CircleSpec {
  readonly kind: 'circle';
  readonly r: number;
}

export interface CapsuleSpec {
  readonly kind: 'capsule';
  /** Tip-to-tip length along the local x axis. */
  readonly length: number;
  /** Radius of the rounded ends (half the thickness). */
  readonly r: number;
  /** 'center': centred on the origin. 'start': the first cap's centre is the origin (a pivot). */
  readonly origin: 'center' | 'start';
}

export interface PolygonSpec {
  readonly kind: 'polygon';
  /** Outer corners of a convex polygon, before rounding. For a region: the points its outline runs through, clockwise on screen. */
  readonly points: readonly Vec2[];
  /** Corner radius. 0 for a region. */
  readonly radius: number;
  /**
   * Present: the polygon is a region, a free-form closed outline through its
   * points that may be concave. 0 joins the points with straight edges, 1 with
   * a smooth curve through them; between, the corners are partly rounded.
   * Left out: a rounded convex polygon.
   */
  readonly smooth?: number;
}

export interface BlobSpec {
  readonly kind: 'blob';
  /** Mean radius. */
  readonly r: number;
  /** Number of control points around the outline (5..16). */
  readonly points: number;
  /** How far the outline wanders from the circle, as a fraction of r (0..0.4). */
  readonly wobble: number;
  /** Seed of the outline; the same seed always gives the same blob. */
  readonly seed: number;
}

/**
 * A free-form closed outline through a list of points: it may be concave, with
 * bays and capes. It is kept as a polygon that has a `smooth`, so that the
 * kinds of shape stay the four that code may switch over.
 */
export type RegionSpec = PolygonSpec & { readonly smooth: number };

export type ShapeSpec = CircleSpec | CapsuleSpec | PolygonSpec | BlobSpec;

/** True for a polygon that is a region: a free-form outline, possibly concave. */
export function isRegion(spec: ShapeSpec): spec is RegionSpec {
  return spec.kind === 'polygon' && spec.smooth !== undefined;
}

export class ShapeError extends Error {}

function need(cond: boolean, message: string): asserts cond {
  if (!cond) throw new ShapeError(message);
}

export function circleShape(r: number): CircleSpec {
  need(r > 0, `circle: r must be positive, got ${r}`);
  return { kind: 'circle', r };
}

export function capsuleShape(length: number, r: number, origin: 'center' | 'start' = 'center'): CapsuleSpec {
  need(r > 0, `capsule: r must be positive, got ${r}`);
  need(length >= 2 * r, `capsule: length (${length}) must be at least 2 * r (${2 * r})`);
  return { kind: 'capsule', length, r, origin };
}

/** Signed area in y-down coordinates: positive means clockwise on screen. */
function signedArea(points: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function isConvex(points: readonly Vec2[]): boolean {
  let sign = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const c = points[(i + 2) % n]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

/**
 * Moves every edge of a convex polygon inward by `d` and returns the new
 * corners. A rounded polygon with corner radius d is exactly this inner polygon
 * grown by a disc of radius d, which is also how the physics collider is built.
 */
export function insetConvex(points: readonly Vec2[], d: number): Vec2[] {
  const n = points.length;
  const cw = signedArea(points) > 0;
  const pts = cw ? points.slice() : points.slice().reverse();
  // Clockwise on screen (y down): the inward normal of edge a->b is (-ey, ex).
  const lines: { p: Vec2; e: Vec2 }[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    need(len > 1e-9, 'polygon: two corners coincide');
    const e: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    lines.push({ p: [a[0] - e[1] * d, a[1] + e[0] * d], e });
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const l0 = lines[(i + n - 1) % n]!;
    const l1 = lines[i]!;
    const det = l0.e[0] * l1.e[1] - l0.e[1] * l1.e[0];
    need(Math.abs(det) > 1e-9, 'polygon: two neighbouring edges are parallel');
    const t = ((l1.p[0] - l0.p[0]) * l1.e[1] - (l1.p[1] - l0.p[1]) * l1.e[0]) / det;
    out.push([l0.p[0] + l0.e[0] * t, l0.p[1] + l0.e[1] * t]);
  }
  return out;
}

export function polygonShape(points: readonly Vec2[], radius: number): PolygonSpec {
  need(points.length >= 3, 'polygon: at least 3 corners are required');
  need(radius >= 0, `polygon: corner radius must not be negative, got ${radius}`);
  need(isConvex(points), 'polygon: corners must form a convex polygon (compose concave forms from several shapes)');
  const cw = signedArea(points) > 0 ? points.slice() : points.slice().reverse();
  if (radius > 0) {
    const inner = insetConvex(cw, radius);
    // The inner polygon must keep every edge pointing the same way as the outer one;
    // otherwise the radius is larger than the polygon can take.
    for (let i = 0; i < cw.length; i++) {
      const a = cw[i]!;
      const b = cw[(i + 1) % cw.length]!;
      const ia = inner[i]!;
      const ib = inner[(i + 1) % cw.length]!;
      const along = (ib[0] - ia[0]) * (b[0] - a[0]) + (ib[1] - ia[1]) * (b[1] - a[1]);
      need(along > 1e-6, `polygon: corner radius ${radius} is too large for this polygon`);
    }
  }
  return { kind: 'polygon', points: cw.map((p) => [p[0], p[1]] as Vec2), radius };
}

/** A regular rounded polygon with `sides` corners on a circle of radius r. */
export function regularPolygonShape(sides: number, r: number, radius: number, phaseDeg = -90): PolygonSpec {
  need(Number.isInteger(sides) && sides >= 3 && sides <= 12, `polygon: sides must be an integer in 3..12, got ${sides}`);
  need(r > 0, `polygon: r must be positive, got ${r}`);
  const pts: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (phaseDeg * Math.PI) / 180 + (i / sides) * TAU;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return polygonShape(pts, radius);
}

/** A rounded rectangle centred on the origin. */
export function rectShape(w: number, h: number, radius: number): PolygonSpec {
  need(w > 0 && h > 0, `rect: w and h must be positive, got ${w} x ${h}`);
  need(radius <= Math.min(w, h) / 2 - 1e-6 || radius === 0, `rect: corner radius ${radius} must be below half the short side (use a capsule for a pill)`);
  return polygonShape([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], radius);
}

export function blobShape(r: number, opts: { points?: number; wobble?: number; seed?: number } = {}): BlobSpec {
  const points = opts.points ?? 9;
  const wobble = opts.wobble ?? 0.14;
  need(r > 0, `blob: r must be positive, got ${r}`);
  need(Number.isInteger(points) && points >= 5 && points <= 16, `blob: points must be an integer in 5..16, got ${points}`);
  need(wobble >= 0 && wobble <= 0.4, `blob: wobble must be in 0..0.4, got ${wobble}`);
  return { kind: 'blob', r, points, wobble, seed: opts.seed ?? 1 };
}

/**
 * Cubic Bezier segments of the closed outline of a region: the curve of a
 * path through its points (motion/paths.ts), so a stroke with the same points
 * and the same `smooth` lies exactly on its edge.
 */
export function regionSegments(spec: RegionSpec): { p0: Vec2; c1: Vec2; c2: Vec2; p1: Vec2 }[] {
  const pts = spec.points;
  const n = pts.length;
  const k = spec.smooth / 6;
  const segs: { p0: Vec2; c1: Vec2; c2: Vec2; p1: Vec2 }[] = [];
  for (let i = 0; i < n; i++) {
    const pm = pts[(i + n - 1) % n]!;
    const p0 = pts[i]!;
    const p1 = pts[(i + 1) % n]!;
    const p2 = pts[(i + 2) % n]!;
    segs.push({ p0, c1: [p0[0] + (p1[0] - pm[0]) * k, p0[1] + (p1[1] - pm[1]) * k], c2: [p1[0] - (p2[0] - p0[0]) * k, p1[1] - (p2[1] - p0[1]) * k], p1 });
  }
  return segs;
}

/** True when two segments cross at a point inside both. */
function crosses(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const side = (p: Vec2, q: Vec2, r: Vec2): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * What is wrong with an outline through `points` as a region, or null when it
 * is sound: its points must not coincide, must enclose an area, and the curve
 * through them must not cross itself. `turn` is the way round the points are
 * to run (1: clockwise on screen, -1: the other way, 0: either).
 */
export function regionFault(points: readonly Vec2[], smooth: number, turn: -1 | 0 | 1 = 0): string | null {
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    if (!(Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6)) return 'two neighbouring points coincide';
  }
  const area = signedArea(points);
  if (!(Math.abs(area) > 1e-6) || area * turn < 0) return 'the points enclose no area';
  // The outline as it is drawn must not cross itself: a shape has one inside.
  const ring: Vec2[] = [];
  for (const s of regionSegments({ kind: 'polygon', points, radius: 0, smooth })) for (let k = 0; k < 12; k++) ring.push(cubicAt(s, k / 12));
  const pair = firstCrossing(ring);
  return pair ? `the outline crosses itself near point ${Math.floor(pair[0] / 12)} and point ${Math.floor(pair[1] / 12)}` : null;
}

/**
 * The first two pieces of the closed line through `ring` that cross, or null
 * when none do. Piece i runs from point i to the next one; pieces that share
 * an end are not held against each other. The answer is the one a search of
 * every pair in turn gives: the smallest i, and for it the smallest j.
 *
 * Two pieces can cross only where their boxes meet. So the pieces are sorted
 * into the cells of a grid, and each is held against the pieces that share a
 * cell with it, in their order: the work grows with the number of pieces, not
 * with its square. At worst, when one point lies so far from the rest that
 * nearly every piece falls into one cell, it is the search of every pair.
 */
export function firstCrossing(ring: readonly Vec2[]): readonly [number, number] | null {
  const m = ring.length;
  if (m < 4) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of ring) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  // About one piece to a cell. A line without width or without height has one column or one row.
  const side = Math.ceil(Math.sqrt(m));
  const cw = (x1 - x0) / side || 1;
  const ch = (y1 - y0) / side || 1;
  // The cell of a coordinate never falls as the coordinate grows: boxes that meet share a cell.
  const cell = (v: number, from: number, size: number): number => {
    const k = Math.floor((v - from) / size);
    return k > 0 ? Math.min(side - 1, k) : 0;
  };
  const cells: number[][] = Array.from({ length: side * side }, () => []);
  const box = new Int32Array(4 * m);
  for (let i = 0; i < m; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % m]!;
    const c0 = cell(Math.min(a[0], b[0]), x0, cw);
    const c1 = cell(Math.max(a[0], b[0]), x0, cw);
    const r0 = cell(Math.min(a[1], b[1]), y0, ch);
    const r1 = cell(Math.max(a[1], b[1]), y0, ch);
    box[4 * i] = c0;
    box[4 * i + 1] = c1;
    box[4 * i + 2] = r0;
    box[4 * i + 3] = r1;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r * side + c]!.push(i);
  }
  // The pieces that share a cell with piece i and come at least two after it, each once.
  const near: number[] = [];
  const seen = new Int32Array(m).fill(-1);
  for (let i = 0; i < m; i++) {
    near.length = 0;
    let inOrder = true;
    for (let r = box[4 * i + 2]!; r <= box[4 * i + 3]!; r++) {
      for (let c = box[4 * i]!; c <= box[4 * i + 1]!; c++) {
        for (const j of cells[r * side + c]!) {
          if (j < i + 2 || seen[j] === i || (i === 0 && j === m - 1)) continue;
          seen[j] = i;
          if (near.length > 0 && j < near[near.length - 1]!) inOrder = false;
          near.push(j);
        }
      }
    }
    if (!inOrder) near.sort((p, q) => p - q);
    for (const j of near) if (crosses(ring[i]!, ring[(i + 1) % m]!, ring[j]!, ring[(j + 1) % m]!)) return [i, j];
  }
  return null;
}

/** The most points the outline of a region may have. */
export const REGION_MAX_POINTS = 600;
/**
 * The most points of a region that is drawn flat, without the light. The
 * light of a shape is cut out of its outline by operations on paths: their
 * work grows faster than the points do, and on an outline of a few thousand
 * points they fail. A flat fill is one path, so such a region takes the whole
 * coast of a wide map.
 */
export const REGION_MAX_FLAT_POINTS = 4000;

/**
 * A free-form closed outline through `points`, concave allowed. The outline
 * may not cross itself; the points are kept clockwise on screen whichever way
 * they are given. `most`: how many points it may have.
 */
export function regionShape(points: readonly Vec2[], smooth = 1, most = REGION_MAX_POINTS): RegionSpec {
  need(points.length >= 3, 'region: at least 3 points are required');
  need(points.length <= most, `region: at most ${most} points, got ${points.length}`);
  need(smooth >= 0 && smooth <= 1, `region: smooth must be in 0..1, got ${smooth}`);
  const cw = (signedArea(points) > 0 ? points.slice() : points.slice().reverse()).map((p) => [p[0], p[1]] as Vec2);
  const fault = regionFault(cw, smooth);
  need(fault === null, `region: ${fault}${fault !== null && fault.startsWith('the outline crosses itself') ? '; move the points apart or lower smooth' : ''}`);
  return { kind: 'polygon', points: cw, radius: 0, smooth };
}

/** True when the points run clockwise on screen. */
export function isClockwise(points: readonly Vec2[]): boolean {
  return signedArea(points) > 0;
}

/** The same shape, `k` times larger. */
export function scaleShape(spec: ShapeSpec, k: number): ShapeSpec {
  if (k === 1) return spec;
  switch (spec.kind) {
    case 'circle':
      return { ...spec, r: spec.r * k };
    case 'capsule':
      return { ...spec, length: spec.length * k, r: spec.r * k };
    case 'polygon':
      return { ...spec, points: spec.points.map((p) => [p[0] * k, p[1] * k] as Vec2), radius: spec.radius * k };
    case 'blob':
      return { ...spec, r: spec.r * k };
  }
}

/** Control points of a blob, in order around the origin. */
export function blobControlPoints(spec: BlobSpec): Vec2[] {
  const rng = new Rng(spec.seed, 'blob');
  const out: Vec2[] = [];
  const phase = rng.range(0, TAU);
  for (let i = 0; i < spec.points; i++) {
    const a = phase + (i / spec.points) * TAU;
    const rr = spec.r * (1 + spec.wobble * rng.range(-1, 1));
    out.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  return out;
}

/**
 * Cubic Bezier segments of the closed Catmull-Rom spline through the points:
 * for each i the segment from p[i] to p[i+1] with its two control points.
 */
export function closedSplineSegments(points: readonly Vec2[]): { p0: Vec2; c1: Vec2; c2: Vec2; p1: Vec2 }[] {
  const n = points.length;
  const segs: { p0: Vec2; c1: Vec2; c2: Vec2; p1: Vec2 }[] = [];
  for (let i = 0; i < n; i++) {
    const pm = points[(i + n - 1) % n]!;
    const p0 = points[i]!;
    const p1 = points[(i + 1) % n]!;
    const p2 = points[(i + 2) % n]!;
    segs.push({
      p0,
      c1: [p0[0] + (p1[0] - pm[0]) / 6, p0[1] + (p1[1] - pm[1]) / 6],
      c2: [p1[0] - (p2[0] - p0[0]) / 6, p1[1] - (p2[1] - p0[1]) / 6],
      p1,
    });
  }
  return segs;
}

function cubicAt(s: { p0: Vec2; c1: Vec2; c2: Vec2; p1: Vec2 }, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * s.p0[0] + b * s.c1[0] + c * s.c2[0] + d * s.p1[0],
    a * s.p0[1] + b * s.c1[1] + c * s.c2[1] + d * s.p1[1],
  ];
}

/** Where the capsule's two cap centres are in local space. */
export function capsuleCenters(spec: CapsuleSpec): [Vec2, Vec2] {
  const span = spec.length - 2 * spec.r;
  return spec.origin === 'start' ? [[0, 0], [span, 0]] : [[-span / 2, 0], [span / 2, 0]];
}

/** A dense closed polyline along the outline, clockwise on screen. */
function denseOutline(spec: ShapeSpec): Vec2[] {
  const out: Vec2[] = [];
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number): void => {
    const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (TAU / 96)));
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };
  switch (spec.kind) {
    case 'circle':
      for (let i = 0; i < 192; i++) {
        const a = (i / 192) * TAU;
        out.push([Math.cos(a) * spec.r, Math.sin(a) * spec.r]);
      }
      break;
    case 'capsule': {
      const [c0, c1] = capsuleCenters(spec);
      arc(c1[0], c1[1], spec.r, -Math.PI / 2, Math.PI / 2);
      arc(c0[0], c0[1], spec.r, Math.PI / 2, (3 * Math.PI) / 2);
      break;
    }
    case 'polygon': {
      if (isRegion(spec)) {
        // A region: the curve through its points.
        for (const s of regionSegments(spec)) for (let k = 0; k < 24; k++) out.push(cubicAt(s, k / 24));
        break;
      }
      const n = spec.points.length;
      if (spec.radius <= 0) {
        for (let i = 0; i < n; i++) {
          const a = spec.points[i]!;
          const b = spec.points[(i + 1) % n]!;
          for (let k = 0; k < 16; k++) out.push([a[0] + ((b[0] - a[0]) * k) / 16, a[1] + ((b[1] - a[1]) * k) / 16]);
        }
        break;
      }
      const inner = insetConvex(spec.points, spec.radius);
      for (let i = 0; i < n; i++) {
        const prev = spec.points[(i + n - 1) % n]!;
        const cur = spec.points[i]!;
        const next = spec.points[(i + 1) % n]!;
        // Outward normals of the edge arriving at this corner and of the edge leaving it.
        const a0 = Math.atan2(-(cur[0] - prev[0]), cur[1] - prev[1]);
        let a1 = Math.atan2(-(next[0] - cur[0]), next[1] - cur[1]);
        while (a1 < a0) a1 += TAU;
        const v = inner[i]!;
        arc(v[0], v[1], spec.radius, a0, a1);
      }
      break;
    }
    case 'blob': {
      const segs = closedSplineSegments(blobControlPoints(spec));
      for (const s of segs) for (let k = 0; k < 24; k++) out.push(cubicAt(s, k / 24));
      // Control points run with increasing angle, which is clockwise on screen already.
      break;
    }
  }
  return out;
}

/** `n` points spaced evenly by arc length along the outline, clockwise on screen. */
export function outline(spec: ShapeSpec, n = 96): Vec2[] {
  const dense = denseOutline(spec);
  const m = dense.length;
  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const a = dense[i]!;
    const b = dense[(i + 1) % m]!;
    cum[i + 1] = cum[i]! + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const total = cum[m]!;
  const out: Vec2[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = (i / n) * total;
    while (j < m - 1 && cum[j + 1]! < s) j++;
    const seg = cum[j + 1]! - cum[j]!;
    const t = seg > 1e-12 ? (s - cum[j]!) / seg : 0;
    const a = dense[j]!;
    const b = dense[(j + 1) % m]!;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

const sideCache = new WeakMap<ShapeSpec, Vec2[]>();

/**
 * The outline of a shape with every corner in it, for what is built on the outline itself (the side of a body with a
 * height): a region with straight sides is its own points, one with curved sides has six points to each of them, any
 * other shape its dense outline. Computed once per spec object.
 */
export function cornerOutline(spec: ShapeSpec): readonly Vec2[] {
  let pts = sideCache.get(spec);
  if (!pts) {
    const dense = denseOutline(spec);
    // A region has 24 points to each of its sides.
    const step = isRegion(spec) ? (spec.smooth > 0 ? 4 : 24) : 1;
    pts = step === 1 ? dense : dense.filter((_, i) => i % step === 0);
    sideCache.set(spec, pts);
  }
  return pts;
}

const outlineCache = new WeakMap<ShapeSpec, Vec2[]>();

/** The 96-point outline of a shape, computed once per spec object. */
export function outlineOf(spec: ShapeSpec): readonly Vec2[] {
  let pts = outlineCache.get(spec);
  if (!pts) {
    pts = outline(spec, 96);
    outlineCache.set(spec, pts);
  }
  return pts;
}

/** How far the shape reaches from its origin in a direction (a unit vector in local space). */
export function reach(spec: ShapeSpec, dir: Vec2): number {
  if (spec.kind === 'circle') return spec.r;
  let best = -Infinity;
  for (const p of outlineOf(spec)) {
    const d = p[0] * dir[0] + p[1] * dir[1];
    if (d > best) best = d;
  }
  return best;
}

export interface ShapeExtent {
  /** Centre of the shape in local space. */
  readonly center: Vec2;
  /** Radius of the largest circle around the centre that stays inside the shape. */
  readonly inner: number;
  /** Radius of the smallest circle around the centre that contains the shape. */
  readonly outer: number;
}

const extentCache = new WeakMap<ShapeSpec, ShapeExtent>();

/**
 * Gives a shape its extent instead of having it worked out: for an outline
 * that is half-way between two others, whose middle and sizes are taken
 * half-way between theirs, so that they change evenly from frame to frame.
 */
export function seedShapeExtent(spec: ShapeSpec, extent: ShapeExtent): void {
  extentCache.set(spec, extent);
}

export function shapeExtent(spec: ShapeSpec): ShapeExtent {
  const hit = extentCache.get(spec);
  if (hit) return hit;
  let center: Vec2 = [0, 0];
  let inner: number;
  let outer: number;
  if (spec.kind === 'circle') {
    inner = outer = spec.r;
  } else if (spec.kind === 'capsule') {
    const [c0, c1] = capsuleCenters(spec);
    center = [(c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2];
    inner = spec.r;
    outer = spec.length / 2;
  } else if (isRegion(spec)) {
    // A free-form outline may be concave: its middle is the point inside it that is farthest from its edge
    // (the middle of the largest circle that fits in it), found on a grid and then on a finer one round the best.
    const pts = outline(spec, 256);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
    const inside = (x: number, y: number): boolean => {
      let hit = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i]!;
        const b = pts[j]!;
        if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
      }
      return hit;
    };
    const clearance = (x: number, y: number): number => {
      let best = Infinity;
      for (const p of pts) best = Math.min(best, Math.hypot(p[0] - x, p[1] - y));
      return best;
    };
    inner = 0;
    // Until the grid finds a point inside: the middle of its box.
    center = [(x0 + x1) / 2, (y0 + y1) / 2];
    let span = Math.max(x1 - x0, y1 - y0);
    let from: Vec2 = [x0, y0];
    for (let pass = 0; pass < 3; pass++) {
      const steps = 24;
      const cell = span / steps;
      let best: Vec2 | null = null;
      for (let iy = 0; iy <= steps; iy++) {
        for (let ix = 0; ix <= steps; ix++) {
          const x = from[0] + ix * cell;
          const y = from[1] + iy * cell;
          if (!inside(x, y)) continue;
          const d = clearance(x, y);
          if (d > inner) {
            inner = d;
            best = [x, y];
          }
        }
      }
      if (best) center = best;
      span = 2 * cell;
      from = [center[0] - cell, center[1] - cell];
    }
    // A sliver has no room for a circle; the light still needs a size to work with.
    inner = Math.max(inner, 1e-3);
    outer = 0;
    for (const p of pts) outer = Math.max(outer, Math.hypot(p[0] - center[0], p[1] - center[1]));
  } else {
    const pts = outline(spec, 128);
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p[0];
      sy += p[1];
    }
    center = [sx / pts.length, sy / pts.length];
    inner = Infinity;
    outer = 0;
    for (const p of pts) {
      const d = Math.hypot(p[0] - center[0], p[1] - center[1]);
      if (d < inner) inner = d;
      if (d > outer) outer = d;
    }
  }
  const ext: ShapeExtent = { center, inner, outer };
  extentCache.set(spec, ext);
  return ext;
}
