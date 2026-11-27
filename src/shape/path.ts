// Shapes as Skia paths, and thin helpers over the path operations of skia-canvas.
// Paths are built in the shape's local space and cached per spec object; a cache
// hit returns the same geometry a miss would build, so it never changes pixels.
//
// The path operations of the library are not exact: for some inputs the
// difference of two paths comes out wrong. A crescent, the difference of a path
// and its own shifted copy, is therefore held against the area it must have,
// and taken again with the shift turned a little when it is not sound.

import { Path2D } from 'skia-canvas';
import { DEG, type Vec2 } from '../core/math.ts';
import {
  blobControlPoints,
  capsuleCenters,
  closedSplineSegments,
  insetConvex,
  isRegion,
  regionSegments,
  type ShapeSpec,
} from './geometry.ts';

const pathCache = new WeakMap<ShapeSpec, Path2D>();

function buildPath(spec: ShapeSpec): Path2D {
  const p = new Path2D();
  switch (spec.kind) {
    case 'circle':
      p.arc(0, 0, spec.r, 0, Math.PI * 2);
      p.closePath();
      break;
    case 'capsule': {
      const [c0, c1] = capsuleCenters(spec);
      p.arc(c1[0], c1[1], spec.r, -Math.PI / 2, Math.PI / 2);
      p.arc(c0[0], c0[1], spec.r, Math.PI / 2, (3 * Math.PI) / 2);
      p.closePath();
      break;
    }
    case 'polygon': {
      if (spec.rings) {
        for (const ring of spec.rings) {
          p.moveTo(ring[0]![0], ring[0]![1]);
          for (let i = 1; i < ring.length; i++) p.lineTo(ring[i]![0], ring[i]![1]);
          p.closePath();
        }
        break;
      }
      if (isRegion(spec)) {
        // A region: the curve through its points.
        const segs = regionSegments(spec);
        p.moveTo(segs[0]!.p0[0], segs[0]!.p0[1]);
        for (const s of segs) p.bezierCurveTo(s.c1[0], s.c1[1], s.c2[0], s.c2[1], s.p1[0], s.p1[1]);
        p.closePath();
        break;
      }
      const n = spec.points.length;
      if (spec.radius <= 0) {
        spec.points.forEach((q, i) => (i === 0 ? p.moveTo(q[0], q[1]) : p.lineTo(q[0], q[1])));
        p.closePath();
        break;
      }
      const inner = insetConvex(spec.points, spec.radius);
      for (let i = 0; i < n; i++) {
        const prev = spec.points[(i + n - 1) % n]!;
        const cur = spec.points[i]!;
        const next = spec.points[(i + 1) % n]!;
        const a0 = Math.atan2(-(cur[0] - prev[0]), cur[1] - prev[1]);
        let a1 = Math.atan2(-(next[0] - cur[0]), next[1] - cur[1]);
        while (a1 < a0) a1 += Math.PI * 2;
        const v = inner[i]!;
        // arc() joins to the previous corner with a straight edge.
        p.arc(v[0], v[1], spec.radius, a0, a1);
      }
      p.closePath();
      break;
    }
    case 'blob': {
      const segs = closedSplineSegments(blobControlPoints(spec));
      const first = segs[0]!;
      p.moveTo(first.p0[0], first.p0[1]);
      for (const s of segs) p.bezierCurveTo(s.c1[0], s.c1[1], s.c2[0], s.c2[1], s.p1[0], s.p1[1]);
      p.closePath();
      break;
    }
  }
  return p;
}

/** The closed outline of a shape as a path in its local space. */
export function shapePath(spec: ShapeSpec): Path2D {
  let p = pathCache.get(spec);
  if (!p) {
    p = buildPath(spec);
    pathCache.set(spec, p);
  }
  return p;
}

/** `a` with `b` cut out. */
export function subtractPath(a: Path2D, b: Path2D): Path2D {
  return a.difference(b);
}

/** The area common to `a` and `b`. */
export function intersectPath(a: Path2D, b: Path2D): Path2D {
  return a.intersect(b);
}

/** The area covered by `a` or `b`. */
export function unionPath(a: Path2D, b: Path2D): Path2D {
  return a.union(b);
}

/** A copy of the path moved by (dx, dy). */
export function shiftPath(p: Path2D, dx: number, dy: number): Path2D {
  return p.transform(1, 0, 0, 1, dx, dy);
}

/** A copy of the path scaled about the origin. */
export function scalePath(p: Path2D, k: number): Path2D {
  return p.transform(k, 0, 0, k, 0, 0);
}

/** A polyline (open or closed) as a path. */
export function polylinePath(points: readonly Vec2[], closed = false): Path2D {
  const p = new Path2D();
  points.forEach((q, i) => (i === 0 ? p.moveTo(q[0], q[1]) : p.lineTo(q[0], q[1])));
  if (closed) p.closePath();
  return p;
}

/** A path with its sharp corners rounded by `radius`. */
export function roundPath(p: Path2D, radius: number): Path2D {
  return p.round(radius);
}

// --- Crescents: a path minus its own shifted copy, checked -------------------------------

/** Straight steps a curve is cut into where a path is measured: the area is then good to a fraction of a percent. */
const CURVE_STEPS = 12;

/**
 * Walks the outline of a path as straight steps: `start` where a contour
 * begins, `line` for the end of every step, `close` where a contour ends.
 * Curves are cut into short steps.
 */
function walkPath(path: Path2D, start: (x: number, y: number) => void, line: (x: number, y: number) => void, close: () => void): void {
  let x0 = 0;
  let y0 = 0;
  let open = false;
  for (const edge of path.edges) {
    const verb = edge[0];
    // After the verb an edge holds numbers only.
    const v = edge as unknown as readonly number[];
    if (verb === 'moveTo') {
      if (open) close();
      x0 = v[1]!;
      y0 = v[2]!;
      start(x0, y0);
      open = true;
      continue;
    }
    if (verb === 'closePath') {
      if (open) close();
      open = false;
      continue;
    }
    if (!open) {
      // A contour that goes on from where the last one closed.
      start(x0, y0);
      open = true;
    }
    if (verb === 'lineTo') {
      x0 = v[1]!;
      y0 = v[2]!;
      line(x0, y0);
      continue;
    }
    const x1 = v[1]!;
    const y1 = v[2]!;
    const x2 = v[3]!;
    const y2 = v[4]!;
    if (verb === 'quadraticCurveTo') {
      for (let k = 1; k <= CURVE_STEPS; k++) {
        const t = k / CURVE_STEPS;
        const u = 1 - t;
        line(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2);
      }
      x0 = x2;
      y0 = y2;
    } else if (verb === 'conicCurveTo') {
      const w = v[5]!;
      for (let k = 1; k <= CURVE_STEPS; k++) {
        const t = k / CURVE_STEPS;
        const u = 1 - t;
        const den = u * u + 2 * w * u * t + t * t;
        line((u * u * x0 + 2 * w * u * t * x1 + t * t * x2) / den, (u * u * y0 + 2 * w * u * t * y1 + t * t * y2) / den);
      }
      x0 = x2;
      y0 = y2;
    } else if (verb === 'bezierCurveTo') {
      const x3 = v[5]!;
      const y3 = v[6]!;
      for (let k = 1; k <= CURVE_STEPS; k++) {
        const t = k / CURVE_STEPS;
        const u = 1 - t;
        line(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
      }
      x0 = x3;
      y0 = y3;
    } else {
      throw new Error(`a path with an edge of the kind "${verb}" cannot be measured`);
    }
  }
  if (open) close();
}

/**
 * The area of a path as the sum of the areas of its contours, each taken for
 * itself whichever way it runs: the pieces of a crescent come out of a path
 * operation running either way. A path that holds the same outline twice has
 * twice its area; a hole would be added, not taken off.
 */
export function pathArea(path: Path2D): number {
  let total = 0;
  let sum = 0;
  let sx = 0;
  let sy = 0;
  let px = 0;
  let py = 0;
  walkPath(
    path,
    (x, y) => {
      sum = 0;
      sx = px = x;
      sy = py = y;
    },
    (x, y) => {
      sum += px * y - x * py;
      px = x;
      py = y;
    },
    () => {
      total += Math.abs(sum + px * sy - sx * py) / 2;
    },
  );
  return total;
}

/** The contours of a path as polygons: the points x, y, x, y, ... of all of them, and where each contour ends in that list. */
interface Outline {
  readonly points: Float64Array;
  readonly ends: Uint32Array;
}

const outlineCache = new WeakMap<Path2D, Outline>();

/** The outline of a path in straight steps; kept per path object. */
function pathOutline(path: Path2D): Outline {
  let outline = outlineCache.get(path);
  if (!outline) {
    const points: number[] = [];
    const ends: number[] = [];
    walkPath(
      path,
      (x, y) => {
        points.push(x, y);
      },
      (x, y) => {
        points.push(x, y);
      },
      () => {
        ends.push(points.length);
      },
    );
    outline = { points: Float64Array.from(points), ends: Uint32Array.from(ends) };
    outlineCache.set(path, outline);
  }
  return outline;
}

/** Lines across a path on which the area of a crescent is added up. */
const CRESCENT_LINES = 128;
/** Cuts kept per line. An outline that crosses a line more often than this is not measured. */
const MAX_CUTS = 32;
const cutCount = new Uint8Array(CRESCENT_LINES);
const cutAt = new Float64Array(CRESCENT_LINES * MAX_CUTS);

/**
 * Cuts the outline of a path with lines parallel to the unit direction
 * (ux, uy), evenly spread across it, and leaves in `cutAt` where along each
 * line the outline crosses it, in order. Returns the distance between two
 * lines; 0 for a path that cannot be measured this way (it has no width
 * across the direction, or it crosses a line too often).
 */
function cutAcross(path: Path2D, ux: number, uy: number): number {
  const { points, ends } = pathOutline(path);
  // Across the direction: w = y ux - x uy; along it: x ux + y uy.
  let w0 = Infinity;
  let w1 = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const w = points[i + 1]! * ux - points[i]! * uy;
    if (w < w0) w0 = w;
    if (w > w1) w1 = w;
  }
  if (!(w1 > w0)) return 0;
  const dw = (w1 - w0) / CRESCENT_LINES;
  cutCount.fill(0);
  let from = 0;
  for (const end of ends) {
    for (let i = from; i < end; i += 2) {
      const j = i + 2 < end ? i + 2 : from;
      const wa = points[i + 1]! * ux - points[i]! * uy;
      const wb = points[j + 1]! * ux - points[j]! * uy;
      if (wa === wb) continue;
      const pa = points[i]! * ux + points[i + 1]! * uy;
      const pb = points[j]! * ux + points[j + 1]! * uy;
      // The lines between the two ends of the edge; an end that lies on a line counts for the edge above it only.
      const lo = wa < wb ? wa : wb;
      const hi = wa < wb ? wb : wa;
      const first = Math.max(0, Math.ceil((lo - w0) / dw - 0.5));
      const last = Math.min(CRESCENT_LINES - 1, Math.ceil((hi - w0) / dw - 0.5) - 1);
      for (let k = first; k <= last; k++) {
        const n = cutCount[k]!;
        if (n >= MAX_CUTS) return 0;
        const at = pa + ((pb - pa) * (w0 + (k + 0.5) * dw - wa)) / (wb - wa);
        // Few cuts per line: each goes to its place among the ones before it.
        let m = k * MAX_CUTS + n;
        while (m > k * MAX_CUTS && cutAt[m - 1]! > at) {
          cutAt[m] = cutAt[m - 1]!;
          m--;
        }
        cutAt[m] = at;
        cutCount[k] = n + 1;
      }
    }
    from = end;
  }
  return dw;
}

/**
 * The area of what was cut by `cutAcross`, minus the same moved by `s` along
 * the lines: on every line, the stretches that are in the path and not in the
 * moved path, added up.
 */
function areaOnLines(s: number, dw: number): number {
  const reach = Math.abs(s);
  let sum = 0;
  for (let k = 0; k < CRESCENT_LINES; k++) {
    const n = cutCount[k]!;
    const base = k * MAX_CUTS;
    if (n === 2) {
      // One stretch: what its own moved copy leaves of it.
      const len = cutAt[base + 1]! - cutAt[base]!;
      sum += len < reach ? len : reach;
      continue;
    }
    for (let i = 0; i + 1 < n; i += 2) {
      const a = cutAt[base + i]!;
      const b = cutAt[base + i + 1]!;
      let covered = 0;
      for (let j = 0; j + 1 < n; j += 2) {
        const lo = Math.max(a, cutAt[base + j]! + s);
        const hi = Math.min(b, cutAt[base + j + 1]! + s);
        if (hi > lo) covered += hi - lo;
      }
      sum += b - a - covered;
    }
  }
  return sum * dw;
}

/**
 * The area of a path minus the same path moved by (dx, dy), worked out without
 * a path operation: on lines parallel to the move, the stretches that are in
 * the path and not in the moved one are added up. Any outline, concave too.
 * 0 for a path that cannot be measured this way.
 */
export function crescentArea(path: Path2D, dx: number, dy: number): number {
  const s = Math.hypot(dx, dy);
  if (!(s > 0)) return 0;
  const dw = cutAcross(path, dx / s, dy / s);
  return dw > 0 ? areaOnLines(s, dw) : 0;
}

/**
 * How far the area of a crescent may be from the area it must have, as a
 * share. A sound difference is within 2 % (curves are measured in straight
 * steps, the area on a limited number of lines); a wrong one is off by far
 * more, most often by its whole area: it is the whole path, a part of it cut
 * straight across, the path twice, or nothing.
 */
export const CRESCENT_TOLERANCE = 0.05;

/**
 * Degrees by which the shift is turned, one after the other, when the
 * difference is not sound. The offsets at which the operation goes wrong lie
 * within a few hundredths of a degree of each other, so a tenth of a degree
 * leaves them. Even the largest nudge moves the far end of the shift by less
 * than a hundredth of its length: the crescent cannot be told from the one
 * that was asked for.
 */
export const CRESCENT_NUDGES: readonly number[] = [0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4, -0.4];

/** True when the area is within the tolerance of the area that is wanted. An area that could not be worked out holds nothing to account. */
const near = (area: number, want: number): boolean => !(want > 0) || Math.abs(area - want) <= CRESCENT_TOLERANCE * want;

/** True when `part` has the area that `path` minus `path` moved by (dx, dy) must have. */
export function soundCrescent(path: Path2D, part: Path2D, dx: number, dy: number): boolean {
  return near(pathArea(part), crescentArea(path, dx, dy));
}

/**
 * `path` minus `moved`, or null when the library's path operation gives up on
 * the pair and throws ("path operation failed"), as it does for a few outlines
 * at a few offsets: a lit outline driven frame by frame meets one sooner or
 * later. To a crescent such a throw is a wrong result like any other; any
 * other error is thrown on.
 */
function crescentDifference(path: Path2D, moved: Path2D): Path2D | null {
  try {
    return pathDifference(path, moved);
  } catch (error) {
    if (error instanceof Error && /path operation failed/i.test(error.message)) return null;
    throw error;
  }
}

/** The library's difference, through one door, so that a test can stand in for it (`withPathDifference`). */
let pathDifference = (a: Path2D, b: Path2D): Path2D => a.difference(b);

/** For tests: runs `body` with `difference` in place of the library's path difference of the crescents. */
export function withPathDifference<T>(difference: (a: Path2D, b: Path2D) => Path2D, body: () => T): T {
  const before = pathDifference;
  pathDifference = difference;
  try {
    return body();
  } finally {
    pathDifference = before;
  }
}

/**
 * The crescent for a shift at which the first difference did not have the
 * area that was worked out: the difference is taken again with the shift
 * turned by the nudges, and the first one that has the area it must have is
 * the crescent.
 *
 * Should none have it, it is the working-out that is in doubt, not all the
 * differences: an outline with features finer than the lines it is measured
 * on. The first result is then held against the two differences nearest to
 * it. It is kept when its area is within a factor of two of theirs, as a
 * crescent beside its neighbours is; a wrong one is many times a crescent, or
 * nothing, and the nearest neighbour is returned in its place. Without any
 * nudge there is nothing to hold it against, and the crescent is empty: a
 * part that is missing for a frame, never a wrong one.
 *
 * A difference that throws (`crescentDifference`) is a wrong one too: a nudge
 * that throws is passed over, and a first one that threw (`first` null) gives
 * way to the nearest nudge that did not; none that did not, and the crescent
 * is empty.
 */
function repairedCrescent(path: Path2D, first: Path2D | null, dx: number, dy: number, nudges: readonly number[]): Path2D {
  const tried: { part: Path2D; area: number }[] = [];
  for (const deg of nudges) {
    const cos = Math.cos(deg * DEG);
    const sin = Math.sin(deg * DEG);
    const nx = dx * cos - dy * sin;
    const ny = dx * sin + dy * cos;
    const part = crescentDifference(path, shiftPath(path, nx, ny));
    if (!part) continue;
    const want = crescentArea(path, nx, ny);
    const area = pathArea(part);
    if (want > 0 && near(area, want)) return part;
    tried.push({ part, area });
  }
  if (tried.length === 0) return new Path2D();
  // A first difference that threw has no area to hold against them: the nearest that did not throw stands in.
  if (!first) return tried[0]!.part;
  // The nudges come nearest first: the first two are the neighbours on either side.
  const beside = tried.slice(0, 2).map((t) => t.area);
  const area = pathArea(first);
  return area >= Math.min(...beside) / 2 && area <= Math.max(...beside) * 2 ? first : tried[0]!.part;
}

/**
 * Crescents: `path` minus `path` moved along the unit direction (ux, uy), one
 * for each of the `shifts` (a negative one moves it the other way). What a
 * lit shape is shaded with.
 *
 * The path operation of the library goes wrong at some offsets: instead of
 * the crescent it returns the whole path, a part of it cut straight across,
 * both outlines, or nothing, and a shape drawn with it flashes for a frame.
 * So every result is held against the area the crescent must have. A sound
 * one is returned as it is; one that is not is taken again with the shift
 * turned by the `nudges`, a fraction of a degree each, which gives a crescent
 * that cannot be told from the one that was asked for.
 */
export function crescentPaths(path: Path2D, ux: number, uy: number, shifts: readonly number[], nudges: readonly number[] = CRESCENT_NUDGES): Path2D[] {
  // The area each must have, from one cutting of the outline along the direction.
  const dw = cutAcross(path, ux, uy);
  const want = shifts.map((s) => (dw > 0 && s !== 0 ? areaOnLines(s, dw) : 0));
  return shifts.map((s, i) => {
    const first = crescentDifference(path, shiftPath(path, ux * s, uy * s));
    return first && near(pathArea(first), want[i]!) ? first : repairedCrescent(path, first, ux * s, uy * s, nudges);
  });
}

/** One crescent: `path` minus `path` moved by (dx, dy), checked as in `crescentPaths`. */
export function crescentPath(path: Path2D, dx: number, dy: number, nudges: readonly number[] = CRESCENT_NUDGES): Path2D {
  const s = Math.hypot(dx, dy);
  if (!(s > 0)) return crescentDifference(path, path) ?? new Path2D();
  return crescentPaths(path, dx / s, dy / s, [s], nudges)[0]!;
}
