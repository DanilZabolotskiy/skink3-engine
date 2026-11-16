// Geometry of the physics review: how far two colliders are apart or sunk into
// each other, whether a point lies inside one, where a path crosses one.
//
// It is written here, in plain arithmetic, and does not ask the physics library:
// a check that used the solver's own contact code would share its mistakes.
//
// Every collider of the engine is a convex core grown by a disc: a circle is a
// point and its radius, a capsule a segment and its radius, a rounded polygon
// the polygon moved inward by the corner radius, a blob its convex hull with no
// radius. This is how src/physics/rigid.ts builds the same colliders.

import type { Vec2 } from '../core/math.ts';
import { capsuleCenters, insetConvex, outline, shapeExtent, type ShapeSpec } from '../shape/geometry.ts';

/** A collider in the space of its body: a convex core (one point, a segment, or a polygon) and a radius around it. */
export interface Collider {
  /** Corners of the core, x and y in turn. */
  readonly core: Float64Array;
  /** Number of corners: 1, 2, or 3 and more. */
  readonly n: number;
  readonly radius: number;
  /** A point inside the shape, and the radius of the largest disc around it that stays inside. */
  readonly center: Vec2;
  readonly inner: number;
  /** Radius of a circle around the body's origin that holds the whole shape. */
  readonly bound: number;
}

/** The convex hull of a set of points, in the order the points turn (Andrew's monotone chain). */
export function convexHull(points: readonly Vec2[]): Vec2[] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** The collider of a shape at a scale, as the rigid-body world builds it. */
export function colliderOf(shape: ShapeSpec, scale = 1): Collider {
  let pts: Vec2[];
  let radius: number;
  switch (shape.kind) {
    case 'circle':
      pts = [[0, 0]];
      radius = shape.r;
      break;
    case 'capsule':
      pts = capsuleCenters(shape);
      radius = shape.r;
      break;
    case 'polygon':
      pts = shape.radius > 0 ? insetConvex(shape.points, shape.radius) : shape.points.slice();
      radius = shape.radius;
      break;
    case 'blob':
      pts = convexHull(outline(shape, 28));
      radius = 0;
      break;
    case 'region':
      // Never a body; its hull stands in where a collider is asked for.
      pts = convexHull(outline(shape, 48));
      radius = 0;
      break;
  }
  const core = new Float64Array(pts.length * 2);
  let bound = 0;
  pts.forEach((p, i) => {
    core[i * 2] = p[0] * scale;
    core[i * 2 + 1] = p[1] * scale;
    bound = Math.max(bound, Math.hypot(p[0], p[1]) * scale);
  });
  const ext = shapeExtent(shape);
  return {
    core,
    n: pts.length,
    radius: radius * scale,
    center: [ext.center[0] * scale, ext.center[1] * scale],
    inner: ext.inner * scale,
    bound: bound + radius * scale,
  };
}

/** Writes the corners of a collider's core at a pose into `out` (x and y in turn). */
export function placeCore(c: Collider, x: number, y: number, rot: number, out: Float64Array): void {
  if (c.n === 1 && c.core[0] === 0 && c.core[1] === 0) {
    out[0] = x;
    out[1] = y;
    return;
  }
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  for (let i = 0; i < c.n; i++) {
    const px = c.core[i * 2]!;
    const py = c.core[i * 2 + 1]!;
    out[i * 2] = x + px * cos - py * sin;
    out[i * 2 + 1] = y + px * sin + py * cos;
  }
}

/** Squared distance from point p to the segment a-b, and the nearest point on it. */
function pointSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number, near: Float64Array): number {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  let t = len2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = ax + ex * t;
  const qy = ay + ey * t;
  near[0] = qx;
  near[1] = qy;
  return (px - qx) * (px - qx) + (py - qy) * (py - qy);
}

/** Result of `separation`: where the two shapes are nearest, on the surface of each. */
export interface Nearest {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

const scratch = new Float64Array(2);

/**
 * How far two colliders are apart, in the units of their cores: positive is
 * the gap between their surfaces, negative is how deep they are sunk into each
 * other (the shortest move that would part them). `a` and `b` are the cores at
 * their poses (placeCore), `na` and `nb` their corner counts, `ra` and `rb`
 * the radii. With `near`, the nearest points on the two surfaces are written
 * too (only meaningful while the shapes are apart).
 */
export function separation(a: Float64Array, na: number, ra: number, b: Float64Array, nb: number, rb: number, near?: Nearest): number {
  // Two points: two circles.
  if (na === 1 && nb === 1) {
    const dx = b[0]! - a[0]!;
    const dy = b[1]! - a[1]!;
    const d = Math.hypot(dx, dy);
    if (near) {
      const ux = d > 0 ? dx / d : 1;
      const uy = d > 0 ? dy / d : 0;
      near.ax = a[0]! + ux * ra;
      near.ay = a[1]! + uy * ra;
      near.bx = b[0]! - ux * rb;
      near.by = b[1]! - uy * rb;
    }
    return d - ra - rb;
  }

  // Do the cores themselves meet? Separating axes: the edge normals of both. A
  // segment is a polygon without width, so it brings two axes: across it and
  // along it. A point brings none. The least overlap along the axes is then how
  // deep the cores are in each other. A point and a segment have no area to
  // share: they go by distance.
  const axes = !((na === 1 && nb === 2) || (na === 2 && nb === 1));
  if (axes) {
    let meet = true;
    let least = Infinity;
    for (let pass = 0; pass < 2 && meet; pass++) {
      const p = pass === 0 ? a : b;
      const n = pass === 0 ? na : nb;
      if (n < 2) continue;
      // A polygon: one axis per edge. A segment: its one edge, across and along.
      const count = n === 2 ? 2 : n;
      for (let i = 0; i < count; i++) {
        const from = n === 2 ? 0 : i;
        const to = n === 2 ? 1 : (i + 1) % n;
        const ex = p[to * 2]! - p[from * 2]!;
        const ey = p[to * 2 + 1]! - p[from * 2 + 1]!;
        const len = Math.hypot(ex, ey);
        if (len < 1e-12) continue;
        const along = n === 2 && i === 1;
        const nx = along ? ex / len : -ey / len;
        const ny = along ? ey / len : ex / len;
        let minA = Infinity;
        let maxA = -Infinity;
        for (let k = 0; k < na; k++) {
          const d = a[k * 2]! * nx + a[k * 2 + 1]! * ny;
          if (d < minA) minA = d;
          if (d > maxA) maxA = d;
        }
        let minB = Infinity;
        let maxB = -Infinity;
        for (let k = 0; k < nb; k++) {
          const d = b[k * 2]! * nx + b[k * 2 + 1]! * ny;
          if (d < minB) minB = d;
          if (d > maxB) maxB = d;
        }
        const overlap = Math.min(maxA - minB, maxB - minA);
        if (overlap < 0) {
          meet = false;
          break;
        }
        if (overlap < least) least = overlap;
      }
    }
    if (meet && least < Infinity) return -least - ra - rb;
  }

  // Apart: the nearest pair is a corner of one and an edge of the other.
  let best = Infinity;
  let ax = 0;
  let ay = 0;
  let bx = 0;
  let by = 0;
  const edgesB = nb === 1 ? 0 : nb === 2 ? 1 : nb;
  for (let k = 0; k < na; k++) {
    const px = a[k * 2]!;
    const py = a[k * 2 + 1]!;
    if (edgesB === 0) {
      const d2 = (px - b[0]!) * (px - b[0]!) + (py - b[1]!) * (py - b[1]!);
      if (d2 < best) {
        best = d2;
        ax = px;
        ay = py;
        bx = b[0]!;
        by = b[1]!;
      }
    }
    for (let i = 0; i < edgesB; i++) {
      const j = (i + 1) % nb;
      const d2 = pointSegment(px, py, b[i * 2]!, b[i * 2 + 1]!, b[j * 2]!, b[j * 2 + 1]!, scratch);
      if (d2 < best) {
        best = d2;
        ax = px;
        ay = py;
        bx = scratch[0]!;
        by = scratch[1]!;
      }
    }
  }
  const edgesA = na === 1 ? 0 : na === 2 ? 1 : na;
  for (let k = 0; k < nb; k++) {
    const px = b[k * 2]!;
    const py = b[k * 2 + 1]!;
    for (let i = 0; i < edgesA; i++) {
      const j = (i + 1) % na;
      const d2 = pointSegment(px, py, a[i * 2]!, a[i * 2 + 1]!, a[j * 2]!, a[j * 2 + 1]!, scratch);
      if (d2 < best) {
        best = d2;
        bx = px;
        by = py;
        ax = scratch[0]!;
        ay = scratch[1]!;
      }
    }
  }
  const d = Math.sqrt(best);
  if (near) {
    const ux = d > 0 ? (bx - ax) / d : 1;
    const uy = d > 0 ? (by - ay) / d : 0;
    near.ax = ax + ux * ra;
    near.ay = ay + uy * ra;
    near.bx = bx - ux * rb;
    near.by = by - uy * rb;
  }
  return d - ra - rb;
}

const pointCore = new Float64Array(2);

/** How deep a point lies inside a collider at a pose: positive inside, negative is its distance outside. */
export function depthOfPoint(px: number, py: number, core: Float64Array, n: number, radius: number): number {
  pointCore[0] = px;
  pointCore[1] = py;
  return -separation(pointCore, 1, 0, core, n, radius);
}

/**
 * The part of the straight path from p to q that runs inside a collider, as a
 * length. 0 when the path misses it. Found by walking the path in steps no
 * longer than `step` and refining both ends, which is exact enough for a
 * review and works for every core.
 */
export function pathInside(px: number, py: number, qx: number, qy: number, core: Float64Array, n: number, radius: number, step: number): number {
  const len = Math.hypot(qx - px, qy - py);
  if (len <= 0) return 0;
  const steps = Math.max(1, Math.ceil(len / Math.max(step, 1e-6)));
  const inside = (t: number): boolean => depthOfPoint(px + (qx - px) * t, py + (qy - py) * t, core, n, radius) > 0;
  const edge = (out: number, inn: number): number => {
    // Bisect between a point outside and a point inside.
    let lo = out;
    let hi = inn;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inside(mid)) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };
  let first = -1;
  let last = -1;
  for (let i = 0; i <= steps; i++) {
    if (inside(i / steps)) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return 0;
  const t0 = first === 0 ? 0 : edge((first - 1) / steps, first / steps);
  const t1 = last === steps ? 1 : edge((last + 1) / steps, last / steps);
  return Math.max(0, t1 - t0) * len;
}

/** True when the segments p-q and a-b cross. */
export function segmentsCross(px: number, py: number, qx: number, qy: number, ax: number, ay: number, bx: number, by: number): boolean {
  const d1 = (qx - px) * (ay - py) - (qy - py) * (ax - px);
  const d2 = (qx - px) * (by - py) - (qy - py) * (bx - px);
  const d3 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const d4 = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
