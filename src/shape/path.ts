// Shapes as Skia paths, and thin helpers over the path operations of skia-canvas.
// Paths are built in the shape's local space and cached per spec object; a cache
// hit returns the same geometry a miss would build, so it never changes pixels.

import { Path2D } from 'skia-canvas';
import type { Vec2 } from '../core/math.ts';
import {
  blobControlPoints,
  capsuleCenters,
  closedSplineSegments,
  insetConvex,
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
    case 'region': {
      const segs = regionSegments(spec);
      p.moveTo(segs[0]!.p0[0], segs[0]!.p0[1]);
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
