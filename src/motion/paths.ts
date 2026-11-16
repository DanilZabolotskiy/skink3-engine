// Free-form paths: a curve through a list of points, measured by its own
// length, so that something can travel along it at a known speed. A path is
// plain data (the points and two options); its table of lengths is built once
// per path object and is a pure function of that data.

import type { Vec2 } from '../core/math.ts';

export interface PathSpec {
  /** The points the path runs through, in order; the first is where it starts. */
  readonly points: readonly Vec2[];
  /** Back to the first point after the last one. */
  readonly closed: boolean;
  /** 0 joins the points with straight lines, 1 with a smooth curve (a Catmull-Rom spline); between them the corners are partly rounded. */
  readonly smooth: number;
}

export interface PathTable {
  /** Length of the whole path in units. */
  readonly length: number;
  readonly closed: boolean;
  /** Samples along the path and the length up to each of them. */
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly cum: Float64Array;
  /** Signed length up to each sample: forward while the path runs to the right, backward while it runs to the left. */
  readonly roll: Float64Array;
}

/** Samples per span between two points. */
const SAMPLES = 32;

const tables = new WeakMap<object, PathTable>();

function build(spec: PathSpec): PathTable {
  const pts = spec.points;
  const n = pts.length;
  const spans = spec.closed ? n : n - 1;
  const xs = new Float64Array(spans * SAMPLES + 1);
  const ys = new Float64Array(spans * SAMPLES + 1);
  const at = (i: number): Vec2 => (spec.closed ? pts[((i % n) + n) % n]! : pts[Math.max(0, Math.min(n - 1, i))]!);
  const k = spec.smooth / 6;
  let o = 0;
  for (let i = 0; i < spans; i++) {
    const pm = at(i - 1);
    const p0 = at(i);
    const p1 = at(i + 1);
    const p2 = at(i + 2);
    // A cubic Bezier span of the spline. With smooth 0 its control points fall on its ends: a straight line.
    const c1x = p0[0] + (p1[0] - pm[0]) * k;
    const c1y = p0[1] + (p1[1] - pm[1]) * k;
    const c2x = p1[0] - (p2[0] - p0[0]) * k;
    const c2y = p1[1] - (p2[1] - p0[1]) * k;
    for (let s = 0; s < SAMPLES; s++) {
      const t = s / SAMPLES;
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const c = 3 * u * t * t;
      const d = t * t * t;
      xs[o] = a * p0[0] + b * c1x + c * c2x + d * p1[0];
      ys[o] = a * p0[1] + b * c1y + c * c2y + d * p1[1];
      o++;
    }
  }
  const end = at(spans);
  xs[o] = end[0];
  ys[o] = end[1];
  const cum = new Float64Array(xs.length);
  const roll = new Float64Array(xs.length);
  let dir = 1;
  let dirKnown = false;
  for (let i = 1; i < xs.length; i++) {
    const dx = xs[i]! - xs[i - 1]!;
    const d = Math.hypot(dx, ys[i]! - ys[i - 1]!);
    cum[i] = cum[i - 1]! + d;
    // A stretch that runs straight up or down keeps the direction it had.
    if (Math.abs(dx) > 1e-9 * Math.max(1, d)) {
      const now = dx > 0 ? 1 : -1;
      if (!dirKnown) {
        // What came before the first sideways step takes its direction.
        for (let j = 1; j < i; j++) roll[j] = now * cum[j]!;
        dirKnown = true;
      }
      dir = now;
    }
    roll[i] = roll[i - 1]! + dir * d;
  }
  return { length: cum[cum.length - 1]!, closed: spec.closed, xs, ys, cum, roll };
}

/** The table of a path, built once per path object. */
export function pathTable(spec: PathSpec): PathTable {
  let t = tables.get(spec);
  if (!t) {
    t = build(spec);
    tables.set(spec, t);
  }
  return t;
}

/** Length of a path in units. */
export function pathLength(spec: PathSpec): number {
  return pathTable(spec).length;
}

export interface PathPoint {
  readonly x: number;
  readonly y: number;
  /** Direction of travel in radians (0 = to the right, clockwise on screen). */
  readonly angle: number;
  /** Signed length travelled up to here: how far the rim of a wheel that rolls along the path has turned. */
  readonly roll: number;
}

/**
 * The point at distance `s` from the start of the path. On a closed path the
 * distance wraps round; on an open one it is held within the path.
 */
export function pathAt(table: PathTable, s: number): PathPoint {
  const L = table.length;
  const m = table.cum.length;
  if (L <= 1e-12) return { x: table.xs[0]!, y: table.ys[0]!, angle: 0, roll: 0 };
  let d = s;
  let laps = 0;
  if (table.closed) {
    laps = Math.floor(d / L);
    d -= laps * L;
  } else {
    d = d < 0 ? 0 : d > L ? L : d;
  }
  // Binary search for the two samples that hold d between them.
  let lo = 0;
  let hi = m - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table.cum[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const span = table.cum[hi]! - table.cum[lo]!;
  const t = span > 1e-12 ? (d - table.cum[lo]!) / span : 0;
  const dx = table.xs[hi]! - table.xs[lo]!;
  const dy = table.ys[hi]! - table.ys[lo]!;
  return {
    x: table.xs[lo]! + dx * t,
    y: table.ys[lo]! + dy * t,
    angle: Math.atan2(dy, dx),
    roll: table.roll[lo]! + (table.roll[hi]! - table.roll[lo]!) * t + laps * table.roll[m - 1]!,
  };
}

/**
 * Points of an arc of a circle, for a stroke or a path: from the angle `from`
 * to the angle `to`, in degrees (0 = right of the centre, 90 = below it; a
 * larger `to` runs clockwise on screen). A point every `step` degrees at most,
 * so that a smooth path through them is the arc.
 */
export function arcPoints(center: Vec2, r: number, from: number, to: number, opts: { step?: number } = {}): Vec2[] {
  const step = Math.min(45, Math.max(1, opts.step ?? 15));
  const n = Math.max(2, Math.ceil(Math.abs(to - from) / step));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((from + ((to - from) * i) / n) * Math.PI) / 180;
    out.push([center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r]);
  }
  return out;
}

/**
 * Points of an ellipse around a centre, for a closed path: a loop that never
 * stops and never leaves its middle. `start` is the angle of the first point
 * in degrees (0 = right of the centre, 90 = below it, 180 = left of it).
 */
export function loopPoints(center: Vec2, radius: Vec2 | number, opts: { start?: number; clockwise?: boolean; points?: number } = {}): Vec2[] {
  const [rx, ry] = typeof radius === 'number' ? [radius, radius] : radius;
  const n = Math.max(4, Math.round(opts.points ?? 8));
  const start = ((opts.start ?? 180) * Math.PI) / 180;
  const dir = opts.clockwise === false ? -1 : 1;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = start + (dir * i * 2 * Math.PI) / n;
    out.push([center[0] + Math.cos(a) * rx, center[1] + Math.sin(a) * ry]);
  }
  return out;
}
