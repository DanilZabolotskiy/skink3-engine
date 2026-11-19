// Drawing what lies in a plane of a perspective layer: the perspective matrix of the plane, whether the canvas can see
// anything of the plane, and a context that keeps what lies behind the camera from being drawn through the eye.
//
// In the matrix of a plane a point (u, v) of the plane has the weight w = g u + h v + 1: 1 at the place of the plane,
// less the nearer the point is to the camera, 0 level with the camera and below 0 behind it. A path that skia is given
// whole (a Path2D) is cut where w falls to PLANE_NEAR_W0, so a shape, a text or a clip in a plane loses what of it lies
// behind the camera, and the rest is drawn as the camera sees it. The current path of a canvas (beginPath, lineTo, arc,
// then stroke or fill) is not cut: each point of it is projected as it is added, and a point behind the camera comes
// back from the other side of the eye, so the line to it runs off to the horizon. In a plane, such a path is drawn
// whole when it reaches that far.

import { DOMMatrix, Path2D, type CanvasRenderingContext2D } from 'skia-canvas';
import type { PlaneItem } from '../scene/evaluate.ts';

/**
 * The least w at which skia maps a point through a perspective: it clips what lies nearer the plane w = 0 than this.
 * Through the matrix of a plane, that is a point of the plane nearer the camera than 1/16384 of the depth of its
 * place; back from the canvas into the plane (1/w), a point of the plane farther than 16384 times that depth.
 */
export const PLANE_NEAR_W0 = 1 / (1 << 14);

/**
 * Whether the canvas of a context that has just been set to draw through a plane can show anything of that plane.
 * When the shot camera has pushed in so far that every corner of the canvas lies beyond the horizon of the plane,
 * nothing of the plane can be seen there. Worse, skia then maps the canvas into the plane as an empty rectangle at
 * its origin, and an opaque fill that holds that origin is taken to cover the whole canvas: everything drawn on the
 * canvas before it was thrown away. Such a plane is left out. A plane any part of the canvas sees is drawn as it was.
 */
export function seesPlane(ctx: CanvasRenderingContext2D): boolean {
  const t = ctx.getTransform();
  // The transform as a 3 x 3 matrix [a c e; b d f; g h i] of the plane into the canvas.
  const [a, b, c, d, e, f, g, h, i] = [t.m11, t.m12, t.m21, t.m22, t.m41, t.m42, t.m14, t.m24, t.m44];
  const det = a * (d * i - f * h) - c * (b * i - f * g) + e * (b * h - d * g);
  if (!Number.isFinite(det) || det === 0) return true;
  // The last row of its inverse gives, at a point of the canvas, 1/w of the point of the plane drawn there. It is
  // linear across the canvas, so it is largest at one of the corners.
  const r0 = (b * h - d * g) / det;
  const r1 = -(a * h - c * g) / det;
  const r2 = (a * d - c * b) / det;
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const most = Math.max(r2, r0 * width + r2, r1 * height + r2, r0 * width + r1 * height + r2);
  return most >= PLANE_NEAR_W0;
}

/** Draws what comes next through the picture the camera of a perspective layer has of a plane. */
export function applyPlane(ctx: CanvasRenderingContext2D, item: PlaneItem): void {
  const m = item.map;
  const matrix = new DOMMatrix();
  matrix.m11 = m.a;
  matrix.m12 = m.b;
  matrix.m14 = m.g;
  matrix.m21 = m.c;
  matrix.m22 = m.d;
  matrix.m24 = m.h;
  matrix.m41 = m.e;
  matrix.m42 = m.f;
  ctx.transform(matrix);
}

/** The methods that add to the current path of a canvas. */
const BUILDS: ReadonlySet<PropertyKey> = new Set(['moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'conicCurveTo', 'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'closePath']);
/** The methods that may change the transform of a canvas. */
const MOVES: ReadonlySet<PropertyKey> = new Set(['translate', 'rotate', 'scale', 'transform', 'setTransform', 'resetTransform', 'restore']);
/** The methods that draw or clip with the current path, or with a path they are given. */
const USES: ReadonlySet<PropertyKey> = new Set(['fill', 'stroke', 'clip']);

/** Whether a point of a path, or a control point of one of its curves, lies where skia cuts the plane it is drawn in. */
export function reachesBehind(ctx: CanvasRenderingContext2D, path: Path2D): boolean {
  const t = ctx.getTransform();
  const gu = t.m14;
  const gv = t.m24;
  const g0 = t.m44;
  for (const edge of path.edges) {
    // The numbers after the verb are points, two by two; those of a conic end with its weight.
    for (let i = 1; i + 1 < edge.length; i += 2) {
      if (gu * (edge[i] as number) + gv * (edge[i + 1] as number) + g0 < PLANE_NEAR_W0) return true;
    }
  }
  return false;
}

/**
 * A context for what lies in a plane: everything is passed on to `ctx` as it is, and the current path is also kept as
 * a path of its own while it is built. A fill, a stroke or a clip of the current path that reaches behind the camera
 * is made with that path instead, and skia cuts it where the plane passes the camera; one that does not is the call it
 * always was. A current path is begun, built and used under one transform, after `beginPath` in this context.
 */
export function planeContext(ctx: CanvasRenderingContext2D): CanvasRenderingContext2D {
  // The current path as it was given, in the units of the transform it is built under; null until one is begun here.
  let path: Path2D | null = null;
  // The transform has changed since the path was begun.
  let moved = false;
  const own = new Map<PropertyKey, unknown>();
  const use = (name: PropertyKey, args: unknown[]): unknown => {
    const method = Reflect.get(ctx, name) as (...a: unknown[]) => unknown;
    if (args[0] instanceof Path2D) return Reflect.apply(method, ctx, args);
    if (path === null || moved) {
      throw new Error(`a path that is drawn in a plane of a perspective layer must be begun there and built and drawn under one transform (${String(name)})`);
    }
    // A stroke takes no fill rule; a fill and a clip keep theirs.
    return reachesBehind(ctx, path) ? Reflect.apply(method, ctx, [path, ...args]) : Reflect.apply(method, ctx, args);
  };
  return new Proxy(ctx, {
    get(target, name) {
      let value = own.get(name);
      if (value !== undefined) return value;
      if (name === 'beginPath') {
        value = (): void => {
          target.beginPath();
          path = new Path2D();
          moved = false;
        };
      } else if (BUILDS.has(name)) {
        value = (...args: unknown[]): void => {
          Reflect.apply(Reflect.get(target, name) as (...a: unknown[]) => unknown, target, args);
          if (path) Reflect.apply(Reflect.get(path, name) as (...a: unknown[]) => unknown, path, args);
        };
      } else if (MOVES.has(name)) {
        value = (...args: unknown[]): unknown => {
          moved = true;
          return Reflect.apply(Reflect.get(target, name) as (...a: unknown[]) => unknown, target, args);
        };
      } else if (USES.has(name)) {
        value = (...args: unknown[]): unknown => use(name, args);
      } else {
        const field = Reflect.get(target, name);
        if (typeof field !== 'function') return field;
        value = (field as (...a: unknown[]) => unknown).bind(target);
      }
      own.set(name, value);
      return value;
    },
    set(target, name, value) {
      if (name === 'currentTransform') moved = true;
      return Reflect.set(target, name, value);
    },
  });
}
