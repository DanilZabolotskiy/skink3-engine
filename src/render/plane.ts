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
import { withAlpha } from '../look/color.ts';
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

/** What a context for what lies in a plane (planeContext) tells of the canvas it draws on. */
export interface PlaneCanvas {
  /** The canvas itself. A current path that is built and filled on it is not cut where the plane passes the camera. */
  readonly raw: CanvasRenderingContext2D;
  /** The transform the context has now. It is asked of the canvas once, and kept for as long as nothing moves it. */
  transform(): DOMMatrix;
}

const planeCanvases = new WeakMap<object, PlaneCanvas>();

/** The canvas of a context made by planeContext; null for any other context. */
export function planeCanvas(ctx: CanvasRenderingContext2D): PlaneCanvas | null {
  return planeCanvases.get(ctx) ?? null;
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
  // The transform as it is now, once it has been asked for; and what it was at each save that is still open.
  let matrix: DOMMatrix | null = null;
  const saved: (DOMMatrix | null)[] = [];
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
  const made = new Proxy(ctx, {
    get(target, name) {
      let value = own.get(name);
      if (value !== undefined) return value;
      if (name === 'save') {
        value = (): void => {
          saved.push(matrix);
          target.save();
        };
      } else if (name === 'beginPath') {
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
          // A restore brings back the transform of its save; any other move makes one that is not known yet.
          matrix = name === 'restore' ? (saved.pop() ?? null) : null;
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
      if (name === 'currentTransform') {
        moved = true;
        matrix = null;
      }
      return Reflect.set(target, name, value);
    },
  });
  planeCanvases.set(made, { raw: ctx, transform: () => (matrix ??= ctx.getTransform()) });
  return made;
}

/** A curve is drawn on the canvas as this many straight pieces. */
const LIFTED_STEPS = 12;

/** A path traced through a lifted context: its outlines as x, y pairs on the canvas, and on which sides of the eye its points lie (1 in front, 2 behind, 3 both). */
interface Lifted {
  readonly outlines: number[][];
  readonly signs: number;
}

/**
 * A context for a body of a plane that rises above the camera (a group with `tall`): each point is mapped through the
 * plane here, x / w and y / w, and what is drawn is drawn on the canvas as it lies there, with no perspective left for
 * skia to apply.
 *
 * A point higher than the camera is drawn in the plane where the line from the eye through it meets the plane: behind
 * the camera, where w is below 0 and skia cuts it away, though the point itself is in front of the camera. Mapped by
 * itself, it lands where the camera sees it. Straight edges of the body (the uprights, the edges of its faces) are
 * straight on the canvas, so each is drawn between the two ends it has there; a curve lies at one height (a ring of the
 * outline), and is drawn as straight pieces through points mapped one by one.
 *
 * A path whose points lie on both sides of the camera's height (the pieces of a side, from the foot to the top) cannot
 * keep the way it winds: on the canvas each of its outlines is turned to wind clockwise, so that together they fill
 * what all of them cover. Any other path keeps the way it winds, holes and all.
 */
export function liftedContext(ctx: CanvasRenderingContext2D): CanvasRenderingContext2D {
  const raw = planeCanvas(ctx)?.raw ?? ctx;
  let m = ctx.getTransform();
  const saved: DOMMatrix[] = [];
  let lineWidth = 1;
  let outlines: number[][] = [];
  let signs = 0;
  let at: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];

  const put = (out: number[], x: number, y: number): void => {
    const w = m.m14 * x + m.m24 * y + m.m44;
    signs |= w < 0 ? 2 : 1;
    out.push((m.m11 * x + m.m21 * y + m.m41) / w, (m.m12 * x + m.m22 * y + m.m42) / w);
  };
  const last = (): number[] => {
    if (outlines.length === 0) outlines.push([]);
    return outlines[outlines.length - 1]!;
  };
  const curve = (point: (t: number) => [number, number]): void => {
    const out = last();
    for (let i = 1; i <= LIFTED_STEPS; i++) {
      const [x, y] = point(i / LIFTED_STEPS);
      put(out, x, y);
    }
  };
  const builds = {
    beginPath(): void {
      outlines = [];
      signs = 0;
    },
    moveTo(x: number, y: number): void {
      const out: number[] = [];
      put(out, x, y);
      outlines.push(out);
      at = [x, y];
      start = [x, y];
    },
    lineTo(x: number, y: number): void {
      put(last(), x, y);
      at = [x, y];
    },
    quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
      const [x0, y0] = at;
      curve((t) => {
        const s = 1 - t;
        return [s * s * x0 + 2 * s * t * cx + t * t * x, s * s * y0 + 2 * s * t * cy + t * t * y];
      });
      at = [x, y];
    },
    conicCurveTo(cx: number, cy: number, x: number, y: number, weight: number): void {
      const [x0, y0] = at;
      curve((t) => {
        const s = 1 - t;
        const d = s * s + 2 * s * t * weight + t * t;
        return [(s * s * x0 + 2 * s * t * weight * cx + t * t * x) / d, (s * s * y0 + 2 * s * t * weight * cy + t * t * y) / d];
      });
      at = [x, y];
    },
    bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
      const [x0, y0] = at;
      curve((t) => {
        const s = 1 - t;
        return [s * s * s * x0 + 3 * s * s * t * c1x + 3 * s * t * t * c2x + t * t * t * x, s * s * s * y0 + 3 * s * s * t * c1y + 3 * s * t * t * c2y + t * t * t * y];
      });
      at = [x, y];
    },
    closePath(): void {
      at = start;
    },
  };
  // A path that is handed over is traced through the same steps; the current path is then put back.
  const trace = (path: Path2D): Lifted => {
    const before = { outlines, signs, at, start };
    builds.beginPath();
    for (const [verb, ...n] of path.edges) {
      if (verb === 'moveTo') builds.moveTo(n[0]!, n[1]!);
      else if (verb === 'lineTo') builds.lineTo(n[0]!, n[1]!);
      else if (verb === 'quadraticCurveTo') builds.quadraticCurveTo(n[0]!, n[1]!, n[2]!, n[3]!);
      else if (verb === 'conicCurveTo') builds.conicCurveTo(n[0]!, n[1]!, n[2]!, n[3]!, n[4]!);
      else if (verb === 'bezierCurveTo') builds.bezierCurveTo(n[0]!, n[1]!, n[2]!, n[3]!, n[4]!, n[5]!);
      else if (verb === 'closePath') builds.closePath();
    }
    const traced = { outlines, signs };
    ({ outlines, signs, at, start } = before);
    return traced;
  };
  /** How large a unit of the current space is drawn on the canvas about a point of it. */
  const scaleAt = (x: number, y: number): number => {
    const w = m.m14 * x + m.m24 * y + m.m44;
    const X = (m.m11 * x + m.m21 * y + m.m41) / w;
    const Y = (m.m12 * x + m.m22 * y + m.m42) / w;
    const xu = (m.m11 - X * m.m14) / w;
    const xv = (m.m21 - X * m.m24) / w;
    const yu = (m.m12 - Y * m.m14) / w;
    const yv = (m.m22 - Y * m.m24) / w;
    return Math.sqrt(Math.abs(xu * yv - xv * yu));
  };
  const draw = (how: 'fill' | 'stroke', args: unknown[]): void => {
    const given = args[0] instanceof Path2D;
    const path = given ? trace(args[0] as Path2D) : { outlines, signs };
    const rule = given ? args[1] : args[0];
    raw.save();
    raw.setTransform(1, 0, 0, 1, 0, 0);
    if (how === 'fill') {
      const p = liftedFill(path);
      if (rule === 'evenodd' || rule === 'nonzero') raw.fill(p, rule);
      else raw.fill(p);
    } else {
      raw.lineWidth = lineWidth * scaleAt(at[0], at[1]);
      raw.stroke(liftedStroke(path));
    }
    raw.restore();
  };
  const own: Record<string, unknown> = {
    ...builds,
    save(): void {
      saved.push(m);
      raw.save();
    },
    restore(): void {
      m = saved.pop() ?? m;
      raw.restore();
    },
    translate(x: number, y: number): void {
      m = m.translate(x, y);
    },
    rotate(a: number): void {
      m = m.rotate((a * 180) / Math.PI);
    },
    scale(x: number, y: number): void {
      m = m.scale(x, y);
    },
    transform(...args: unknown[]): void {
      if (args[0] instanceof DOMMatrix) m = m.multiply(args[0]);
      else {
        const [a, b, c, d, e, f] = args as number[];
        m = m.multiply({ a: a!, b: b!, c: c!, d: d!, e: e!, f: f! });
      }
    },
    getTransform(): DOMMatrix {
      return m;
    },
    fill(...args: unknown[]): void {
      draw('fill', args);
    },
    stroke(...args: unknown[]): void {
      draw('stroke', args);
    },
  };
  const made = new Proxy(raw, {
    get(target, name) {
      if (typeof name === 'string' && Object.hasOwn(own, name)) return own[name];
      if (name === 'lineWidth') return lineWidth;
      const field = Reflect.get(target, name);
      return typeof field === 'function' ? (field as (...a: unknown[]) => unknown).bind(target) : field;
    },
    set(target, name, value) {
      if (name === 'lineWidth') {
        lineWidth = value as number;
        return true;
      }
      return Reflect.set(target, name, value);
    },
  });
  // What is traced on its canvas (easelOf) is traced on it too: every point is mapped here.
  planeCanvases.set(made, { raw: made, transform: () => m });
  return made;
}

/** The outlines of a lifted path as a path to fill on the canvas; on both sides of the eye, each turned clockwise. */
function liftedFill(path: Lifted): Path2D {
  const p = new Path2D();
  for (const o of path.outlines) {
    if (o.length < 6) continue;
    let area = 0;
    for (let i = 0; i < o.length; i += 2) {
      const j = (i + 2) % o.length;
      area += o[i]! * o[j + 1]! - o[j]! * o[i + 1]!;
    }
    const flip = path.signs === 3 && area < 0;
    const n = o.length / 2;
    for (let k = 0; k < n; k++) {
      const i = 2 * (flip ? n - 1 - k : k);
      if (k === 0) p.moveTo(o[i]!, o[i + 1]!);
      else p.lineTo(o[i]!, o[i + 1]!);
    }
    p.closePath();
  }
  return p;
}

/** The outlines of a lifted path as a path to stroke on the canvas, open as they were traced. */
function liftedStroke(path: Lifted): Path2D {
  const p = new Path2D();
  for (const o of path.outlines) {
    for (let i = 0; i < o.length; i += 2) {
      if (i === 0) p.moveTo(o[i]!, o[i + 1]!);
      else p.lineTo(o[i]!, o[i + 1]!);
    }
  }
  return p;
}

/** Stops of the gradient a fog is laid with, evenly spaced in distance from its near end to its far end. */
const FOG_STOPS = 24;

/**
 * Lays the fog of a plane over the canvas of `ctx`, whose transform draws the plane: at each pixel, as strong as the
 * distance of the point of the plane drawn there asks. `far0` is the distance of the plane's origin from the camera,
 * along its line of sight. 'source-atop' tints what is drawn toward `color`; 'destination-out' takes away as much of
 * it (a glow fading with the ground it lies on).
 *
 * At a pixel the plane is drawn at w = g u + h v + 1 times the distance of its origin, and 1/w is linear across the
 * canvas: a linear gradient along the direction 1/w changes in, with its stops placed at the distances they stand for,
 * gives every pixel its fog without a pixel worked out by hand.
 */
export function fogPlane(
  ctx: CanvasRenderingContext2D,
  far0: number,
  fog: { readonly near: number; readonly far: number; readonly amount: number },
  color: string,
  mode: 'source-atop' | 'destination-out',
): void {
  const t = ctx.getTransform();
  const [a, b, c, d, e, f, g, h, i] = [t.m11, t.m12, t.m21, t.m22, t.m41, t.m42, t.m14, t.m24, t.m44];
  const det = a * (d * i - f * h) - c * (b * i - f * g) + e * (b * h - d * g);
  if (!Number.isFinite(det) || det === 0 || !(far0 > 0) || fog.amount <= 0) return;
  // 1/w at the pixel (X, Y) is r0 X + r1 Y + r2.
  const r0 = (b * h - d * g) / det;
  const r1 = -(a * h - c * g) / det;
  const r2 = (a * d - c * b) / det;
  const near = Math.max(fog.near, fog.far * 1e-3);
  const strength = (distance: number): number => {
    const s = Math.min(1, Math.max(0, (distance - near) / (fog.far - near)));
    return fog.amount * s * s * (3 - 2 * s);
  };
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = mode;
  const run = r0 * r0 + r1 * r1;
  if (run * width * width < 1e-18 * r2 * r2) {
    // The plane faces the camera: all of it is as far.
    ctx.fillStyle = withAlpha(color, strength(far0 / r2));
  } else {
    // The pixel where 1/w is the given value, on the line through the origin of the canvas along which it changes.
    const at = (r: number): [number, number] => [((r - r2) * r0) / run, ((r - r2) * r1) / run];
    const rNear = far0 / near;
    const rFar = far0 / fog.far;
    const [x0, y0] = at(rNear);
    const [x1, y1] = at(rFar);
    const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
    for (let k = 0; k < FOG_STOPS; k++) {
      const distance = near + ((fog.far - near) * k) / (FOG_STOPS - 1);
      const place = (far0 / distance - rNear) / (rFar - rNear);
      gradient.addColorStop(Math.min(1, Math.max(0, place)), withAlpha(color, strength(distance)));
    }
    ctx.fillStyle = gradient;
  }
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}
