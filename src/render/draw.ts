// Drawing of the display-list items onto a Skia canvas context. The context is
// already in the layer's space; these functions only add the node's transform.
//
// Colours go through a Paint, which applies the layer's atmospheric perspective.
// Opacity is not applied here: a faded node arrives wrapped in a group, and the
// compositor fades the whole group as one picture.

import { DOMMatrix, Path2D, type CanvasRenderingContext2D } from 'skia-canvas';
import { quadAt, TAU, vrot, type Quad, type Vec2, type Xf } from '../core/math.ts';
import { atmosphereTone, HIGHLIGHT_HUE, lightTone, mix, SHADOW_HUE, shadowTone, withAlpha } from '../look/color.ts';
import { litParts } from '../look/light.ts';
import type { ToneHues } from '../look/palette.ts';
import { PULSE_LENGTH } from '../motion/curves.ts';
import { PARTICLE_STRIDE, PARTICLE_TAIL_STRIDE } from '../physics/cache.ts';
import { pathAt, pathTable, type PathTable } from '../motion/paths.ts';
import type { CNode } from '../scene/compile.ts';
import { itemFill, itemPath, itemShape, itemWidth, type CastItem, type ClipItem, type EyeItem, type Foot, type LabelItem, type LinkItem, type ParticlesItem, type ShapeItem, type StrokeItem, type TextItem } from '../scene/evaluate.ts';
import type { EmitterNode, EyeNode, LinkNode, OpeningsSpec, RoofSpec, ShapeNode, StrokeNode } from '../scene/types.ts';
import { cornerOutline, isRegion, shapeExtent, type ShapeSpec } from '../shape/geometry.ts';
import { between, highest, openingColumns, openingRows, roofFaces, seenRuns, SHADES, shadeOf, sideRing, upright, viewOf, wallOpenings, type OpeningColumn } from '../shape/solid.ts';
import { shapePath } from '../shape/path.ts';
import { liftedContext, PLANE_NEAR_W0, planeCanvas } from './plane.ts';
import { drawGlobe } from './globe.ts';
import { drawRelief } from './relief.ts';
import { ensureFonts, fontString } from '../text/fonts.ts';
import { splitRuns, type RunSpan } from '../text/runs.ts';

export type ToneKind = 'base' | 'shadow1' | 'shadow2' | 'shadow3' | 'rim' | 'highlight' | 'glow' | 'pulse' | 'pulseHead';

const DEFAULT_HUES: ToneHues = { shadow: SHADOW_HUE, highlight: HIGHLIGHT_HUE };

function derive(kind: ToneKind, hex: string, hues: ToneHues): string {
  switch (kind) {
    case 'base': return hex;
    case 'shadow1': return shadowTone(hex, 1, hues.shadow);
    case 'shadow2': return shadowTone(hex, 2, hues.shadow);
    case 'shadow3': return shadowTone(hex, 3, hues.shadow);
    case 'rim': return lightTone(hex, 0.36, hues.highlight);
    case 'highlight': return lightTone(hex, 0.7, hues.highlight);
    case 'glow': return lightTone(hex, 0.22, hues.highlight);
    case 'pulse': return lightTone(hex, 0.4, hues.highlight);
    case 'pulseHead': return lightTone(hex, 0.72, hues.highlight);
  }
}

/** How colours are painted in one layer. */
export interface Paint {
  /** Unit vector toward the light, in screen space. */
  readonly light: Vec2;
  /** A tone derived from a palette colour, as it appears at this layer's depth. */
  tone(kind: ToneKind, hex: string): string;
}

const paints = new Map<string, Paint>();

/**
 * The paint of a layer: the shot's light, atmospheric perspective of the
 * given strength (0..1) toward the atmosphere colour, and the hues the tones
 * lean to (those of the shot's palette). Cached; the result for the same
 * arguments is always the same.
 */
export function makePaint(light: Vec2, atmosphere: string, tint: number, hues: ToneHues = DEFAULT_HUES): Paint {
  const key = `${light[0]},${light[1]}|${atmosphere}|${tint}|${hues.shadow}|${hues.highlight}`;
  let paint = paints.get(key);
  if (!paint) {
    const cache = new Map<string, string>();
    paint = {
      light,
      tone(kind, hex) {
        const k = `${kind}${hex}`;
        let v = cache.get(k);
        if (!v) {
          v = atmosphereTone(derive(kind, hex, hues), atmosphere, tint);
          // A fill that changes gives every frame colours of its own: the cache is emptied before it grows without end.
          if (cache.size >= 4096) cache.clear();
          cache.set(k, v);
        }
        return v;
      },
    };
    // While a background changes, every frame has an atmosphere of its own: the cache is emptied before it grows without end.
    if (paints.size >= 512) paints.clear();
    paints.set(key, paint);
  }
  return paint;
}

/** The outline of a shape as a path in the space of its layer: the shape it has at the frame of the item. */
export function placedPath(item: ShapeItem | ClipItem): Path2D {
  const { xf } = item;
  const cos = Math.cos(xf.rot) * xf.scale;
  const sin = Math.sin(xf.rot) * xf.scale;
  return shapePath(itemShape(item)).transform(cos, sin, -sin, cos, xf.x, xf.y);
}

function polygonPath(points: readonly Vec2[], upTo = points.length): Path2D {
  const p = new Path2D();
  for (let i = 0; i < upTo; i++) {
    if (i === 0) p.moveTo(points[i]![0], points[i]![1]);
    else p.lineTo(points[i]![0], points[i]![1]);
  }
  return p;
}

/** Narrows what is drawn next to the outline of a shape; for a content with a level, to its filled part. */
export function clipToShape(ctx: CanvasRenderingContext2D, item: ClipItem): void {
  ctx.clip(placedPath(item));
  if (item.level) {
    const below = polygonPath(item.level);
    below.closePath();
    ctx.clip(below);
  }
}

/**
 * The side of a body, as one path in the units of its top: everything its outline passes over on the way from the
 * top down to the foot. Each stretch of the outline sweeps a piece with four corners; with `top`, the outline itself
 * is one more piece. All of them wind one way, so together they fill the whole silhouette without a seam or a hole.
 */
function sidePath(points: readonly Vec2[], closed: boolean, foot: Foot, top: boolean): Path2D {
  const path = new Path2D();
  const n = points.length;
  if (top && n > 2) {
    let area = 0;
    for (let i = 0; i < n; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % n]!;
      area += a[0] * b[1] - b[0] * a[1];
    }
    for (let i = 0; i < n; i++) {
      const p = points[area >= 0 ? i : n - 1 - i]!;
      if (i === 0) path.moveTo(p[0], p[1]);
      else path.lineTo(p[0], p[1]);
    }
    path.closePath();
  }
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const ax = foot.k * a[0] + foot.x;
    const ay = foot.k * a[1] + foot.y;
    const bx = foot.k * b[0] + foot.x;
    const by = foot.k * b[1] + foot.y;
    // Twice the area of the piece a, b, b', a': its sign says which way it winds.
    const area = a[0] * b[1] - b[0] * a[1] + (b[0] * by - bx * b[1]) + (bx * ay - ax * by) + (ax * a[1] - a[0] * ay);
    path.moveTo(a[0], a[1]);
    if (area >= 0) {
      path.lineTo(b[0], b[1]);
      path.lineTo(bx, by);
      path.lineTo(ax, ay);
    } else {
      path.lineTo(ax, ay);
      path.lineTo(bx, by);
      path.lineTo(b[0], b[1]);
    }
    path.closePath();
  }
  return path;
}

/** The tone of the side of a body: the colour it was given, or a shadow tone of the colour of its top. */
function sideTone(colors: Readonly<Record<string, string>>, top: string, paint: Paint): string {
  const given = colors['side'];
  return given ? paint.tone('base', given) : paint.tone('shadow2', top);
}

/** The side of a shape that stands up, in one flat tone. Its top is drawn over it. */
function fillSide(ctx: CanvasRenderingContext2D, item: ShapeItem, foot: Foot, paint: Paint): void {
  const { xf } = item;
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  ctx.fillStyle = sideTone(item.node.colors, itemFill(item), paint);
  ctx.fill(sidePath(cornerOutline(itemShape(item)), true, foot, true));
  ctx.restore();
}

/** What a path is traced on: a path of its own, or the current path of a canvas. */
interface Tracer {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
}

/**
 * Where the pieces of a body are filled: the context the body is drawn with, the canvas under it, and, in a plane,
 * the weight a point (x, y) of the space the pieces are traced in has there: x * wx + y * wy + w0 (see plane.ts).
 * No weight: the canvas draws no plane.
 */
interface Easel {
  readonly ctx: CanvasRenderingContext2D;
  readonly raw: CanvasRenderingContext2D;
  readonly wx: number;
  readonly wy: number;
  readonly w0: number;
  readonly plane: boolean;
}

/** The easel of a context, for pieces traced in the space the context is in now. */
function easelOf(ctx: CanvasRenderingContext2D): Easel {
  const plane = planeCanvas(ctx);
  if (!plane) return { ctx, raw: ctx, wx: 0, wy: 0, w0: 1, plane: false };
  const t = plane.transform();
  return { ctx, raw: plane.raw, wx: t.m14, wy: t.m24, w0: t.m44, plane: true };
}

/** The easel for pieces traced in the own space of an item, once the canvas under `easel` has been moved there. */
function easelAt(easel: Easel, xf: Xf): Easel {
  if (!easel.plane) return easel;
  const cos = Math.cos(xf.rot) * xf.scale;
  const sin = Math.sin(xf.rot) * xf.scale;
  return { ...easel, wx: easel.wx * cos + easel.wy * sin, wy: easel.wy * cos - easel.wx * sin, w0: easel.wx * xf.x + easel.wy * xf.y + easel.w0 };
}

/** The current path of a canvas, with the least weight of the points traced on it. One is enough: no two paths are traced at once. */
const weighed = {
  raw: null as CanvasRenderingContext2D | null,
  wx: 0,
  wy: 0,
  w0: 1,
  least: Infinity,
  moveTo(x: number, y: number): void {
    const w = x * this.wx + y * this.wy + this.w0;
    if (w < this.least) this.least = w;
    this.raw!.moveTo(x, y);
  },
  lineTo(x: number, y: number): void {
    const w = x * this.wx + y * this.wy + this.w0;
    if (w < this.least) this.least = w;
    this.raw!.lineTo(x, y);
  },
  closePath(): void {
    this.raw!.closePath();
  },
};

/**
 * Fills what `trace` draws, in the fill style of the canvas. The pieces of a body are many and small, and the canvas
 * takes its own current path far faster than a path it is handed: in a plane each point is mapped as it is added, and
 * the path is filled as it lies on the canvas, not through the perspective. Only a path with a point where the plane
 * passes the camera is traced again as a path of its own, which skia cuts there.
 */
function fillTraced(easel: Easel, trace: (to: Tracer) => void): void {
  const { raw } = easel;
  raw.beginPath();
  if (!easel.plane) {
    trace(raw);
    raw.fill();
    return;
  }
  weighed.raw = raw;
  weighed.wx = easel.wx;
  weighed.wy = easel.wy;
  weighed.w0 = easel.w0;
  weighed.least = Infinity;
  trace(weighed);
  weighed.raw = null;
  if (weighed.least >= PLANE_NEAR_W0) {
    raw.fill();
    return;
  }
  raw.beginPath();
  const path = new Path2D();
  trace(path);
  easel.ctx.fill(path);
}

/** Traces closed outlines, each a list of x and y pairs. */
function traceOutlines(to: Tracer, outlines: readonly ArrayLike<number>[]): void {
  for (const o of outlines) {
    if (o.length < 6) continue;
    to.moveTo(o[0]!, o[1]!);
    for (let i = 2; i < o.length; i += 2) to.lineTo(o[i]!, o[i + 1]!);
    to.closePath();
  }
}

/**
 * The side of a body of a group that says what detail its bodies are worth, in one flat tone. It covers what fillSide
 * covers, with far fewer pieces: of the outline, only the corners that can be told on screen at the size of the body.
 *
 * A body without a bay is one outline: its foot where its side is turned to the viewer, its top elsewhere. Any other
 * body is its top and, under each run of the outline that is turned to the viewer, one strip down to the foot; every
 * piece winds as the top does, so together they are filled whole.
 */
function fillSideRuns(ctx: CanvasRenderingContext2D, item: ShapeItem, foot: Foot, unit: number, paint: Paint): void {
  // A foot behind the eye of the camera: the side as it is drawn anywhere.
  if (!(foot.k > 0)) return fillSide(ctx, item, foot, paint);
  const { xf } = item;
  const ring = sideRing(itemShape(item), unit);
  const pts = ring.points;
  const n = pts.length;
  const runs = seenRuns(ring, foot);
  // Seen from straight above, the whole side lies behind the top.
  if (runs.length === 0) return;
  const cos = Math.cos(xf.rot) * xf.scale;
  const sin = Math.sin(xf.rot) * xf.scale;
  const easel = easelOf(ctx);
  easel.raw.fillStyle = sideTone(item.node.colors, itemFill(item), paint);
  if (ring.convex && runs.length === 2) {
    const first = runs[0]!;
    const len = runs[1]!;
    fillTraced(easel, (to) => {
      // The foot along the run; then, unless the run goes all the way round, the top from its end on to its start.
      for (let j = 0; j <= len && j < n; j++) {
        const p = pts[(first + j) % n]!;
        const x = foot.k * p[0] + foot.x;
        const y = foot.k * p[1] + foot.y;
        if (j === 0) to.moveTo(xf.x + x * cos - y * sin, xf.y + x * sin + y * cos);
        else to.lineTo(xf.x + x * cos - y * sin, xf.y + x * sin + y * cos);
      }
      for (let j = len; j <= n && len < n; j++) {
        const p = pts[(first + j) % n]!;
        to.lineTo(xf.x + p[0] * cos - p[1] * sin, xf.y + p[0] * sin + p[1] * cos);
      }
      to.closePath();
    });
    return;
  }
  fillTraced(easel, (to) => {
    // The top itself: the strips end at its outline, and nothing may show between them and the top drawn over them.
    for (let i = 0; i < n; i++) {
      const p = pts[i]!;
      if (i === 0) to.moveTo(xf.x + p[0] * cos - p[1] * sin, xf.y + p[0] * sin + p[1] * cos);
      else to.lineTo(xf.x + p[0] * cos - p[1] * sin, xf.y + p[0] * sin + p[1] * cos);
    }
    to.closePath();
    // The strips: back along the top of a run, then forth along its foot.
    for (let r = 0; r < runs.length; r += 2) {
      const first = runs[r]!;
      const len = runs[r + 1]!;
      for (let j = len; j >= 0; j--) {
        const p = pts[(first + j) % n]!;
        if (j === len) to.moveTo(xf.x + p[0] * cos - p[1] * sin, xf.y + p[0] * sin + p[1] * cos);
        else to.lineTo(xf.x + p[0] * cos - p[1] * sin, xf.y + p[0] * sin + p[1] * cos);
      }
      for (let j = 0; j <= len; j++) {
        const p = pts[(first + j) % n]!;
        const x = foot.k * p[0] + foot.x;
        const y = foot.k * p[1] + foot.y;
        to.lineTo(xf.x + x * cos - y * sin, xf.y + x * sin + y * cos);
      }
      to.closePath();
    }
  });
}

/** A body too small for its detail: its top alone, in its fill, with the corners that can be told at its size. */
function fillPlain(ctx: CanvasRenderingContext2D, item: ShapeItem, unit: number, paint: Paint): void {
  const { xf } = item;
  const pts = sideRing(itemShape(item), unit).points;
  const cos = Math.cos(xf.rot) * xf.scale;
  const sin = Math.sin(xf.rot) * xf.scale;
  const easel = easelOf(ctx);
  easel.raw.fillStyle = paint.tone('base', itemFill(item));
  fillTraced(easel, (to) => {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      if (i === 0) to.moveTo(xf.x + p[0] * cos - p[1] * sin, xf.y + p[0] * sin + p[1] * cos);
      else to.lineTo(xf.x + p[0] * cos - p[1] * sin, xf.y + p[0] * sin + p[1] * cos);
    }
    to.closePath();
  });
}

/** The height of a body at its highest: the rise it was given, or the highest a riseTo takes it to. */
function fullRise(n: CNode): number {
  let full = n.rise ? n.rise.base : 0;
  for (const s of n.rise?.segs ?? []) full = Math.max(full, s.to);
  return full;
}

/**
 * Traces the openings of the side of a body, in the units of its top: on every face that is turned to the viewer,
 * each row as far as the body is high at this frame.
 */
function traceOpenings(to: Tracer, shape: ShapeSpec, o: OpeningsSpec, foot: Foot, full: number, turned: boolean): void {
  traceColumns(to, openingColumns(shape, o), o, foot, full, turned);
}

/** Traces openings by their columns, in the units of the top they stand under: those of the faces turned to the viewer. */
function traceColumns(to: Tracer, columns: Iterable<OpeningColumn>, o: OpeningsSpec, foot: Foot, full: number, turned: boolean): void {
  const rows = openingRows(o, full);
  for (const col of columns) {
    // A face is seen when its foot is drawn on the outward side of its top.
    const f = upright(foot, col.mx, col.my, 0);
    const seen = (f[0] - col.mx) * col.nx + (f[1] - col.my) * col.ny;
    if (turned ? seen >= 0 : seen <= 0) continue;
    const m = col.across.length / 3;
    for (const row of rows) {
      if (foot.h - row.foot <= 1e-6 || row.head - row.foot <= 1e-6) continue;
      for (let j = 0; j < m; j++) {
        const q = upright(foot, col.across[3 * j]!, col.across[3 * j + 1]!, row.foot);
        if (j === 0) to.moveTo(q[0], q[1]);
        else to.lineTo(q[0], q[1]);
      }
      // The head, back again: straight, or the half circle of an arch. The top of the wall cuts what would stand over it.
      const round = o.shape === 'arch' ? Math.min(o.width / 2, row.head - row.foot) : 0;
      for (let j = m - 1; j >= 0; j--) {
        const off = 2 * col.across[3 * j + 2]! - 1;
        const z = Math.min(foot.h, row.head - round + round * Math.sqrt(Math.max(0, 1 - off * off)));
        const q = upright(foot, col.across[3 * j]!, col.across[3 * j + 1]!, z);
        to.lineTo(q[0], q[1]);
      }
      to.closePath();
    }
  }
}

/** The corners of the faces of a roof are drawn on a grid of this many steps to a unit of the layer. */
const ROOF_GRID = 4096;

/** A flat slope takes one of this many tones between two tones of the light: as a body or the camera turns, its tone turns with it and never jumps. */
const SHADE_STEPS = 8;

const shadeCache = new WeakMap<Paint, Map<string, string>>();

/** The tone of a roof at a step of the scale of SHADES (SHADE_STEPS to each tone of the light). */
function shadeTone(paint: Paint, fill: string, step: number): string {
  const lower = Math.min(SHADES.length - 1, Math.floor(step / SHADE_STEPS));
  const share = step / SHADE_STEPS - lower;
  if (share <= 0) return paint.tone(SHADES[lower]!, fill);
  let cache = shadeCache.get(paint);
  if (!cache) {
    cache = new Map();
    shadeCache.set(paint, cache);
  }
  const key = `${step}${fill}`;
  let tone = cache.get(key);
  if (!tone) {
    tone = mix(paint.tone(SHADES[lower]!, fill), paint.tone(SHADES[lower + 1]!, fill), share);
    // A fill that changes gives every frame colours of its own: the cache is emptied before it grows without end.
    if (cache.size >= 4096) cache.clear();
    cache.set(key, tone);
  }
  return tone;
}

/**
 * The roof of a body, in the units of its top: every face of it that is turned to the viewer. Its slopes are the
 * fill in the tones of the light, by the way they look; its upright ends are the side of the body. A flat slope has
 * one tone; a round roof has the tones of the light side by side, and they meet along smooth lines.
 */
function fillRoof(easel: Easel, item: ShapeItem, shape: ShapeSpec, roof: RoofSpec, foot: Foot, paint: Paint, turned: boolean): void {
  const light = vrot(paint.light, -item.xf.rot);
  const view = viewOf(foot);
  const top = highest(foot);
  // A contrast stretches the scale of the light about the fill; without one, a slope is lit as it always was.
  const c = roof.contrast;
  const lit = (nx: number, ny: number, nz: number): number => {
    const shade = shadeOf(nx, ny, nz, light, view);
    return c === undefined ? shade : Math.min(SHADES.length - 1, Math.max(0, 2 + c * (shade - 2)));
  };
  // The slopes of a roof on a free outline may hide one another: they are drawn far to near, each in its tone.
  if (isRegion(shape)) {
    fillRegionRoof(easel, item, shape, roof, foot, paint, turned, lit);
    return;
  }
  // The slopes that are seen, by tone: the outlines of each tone are one path. All of them are also one path in the
  // first of the tones, filled first, so that nothing shows between two tones.
  const tones = new Map<number, number[][]>();
  const slopes: number[][] = [];
  const walls: number[][] = [];
  let first = -1;
  // Corners are drawn on a grid far finer than a pixel. Where many faces meet (the top of a dome), their corners differ
  // by the last digits of the arithmetic, and a path with a crowd of such points is not filled at all.
  const grid = ROOF_GRID * Math.max(Math.abs(item.xf.scale), 1e-9);
  const outline = (q: readonly number[], stride: number): number[] => {
    let px = Math.round(q[0]! * grid) / grid;
    let py = Math.round(q[1]! * grid) / grid;
    const out = [px, py];
    for (let j = stride; j < q.length; j += stride) {
      const x = Math.round(q[j]! * grid) / grid;
      const y = Math.round(q[j + 1]! * grid) / grid;
      // Two corners of a face may be one point (the top of a cone): it is drawn once.
      if (x === px && y === py) continue;
      out.push(x, y);
      px = x;
      py = y;
    }
    return out;
  };
  const toned = (step: number, o: number[]): void => {
    if (first < 0) first = step;
    // The first tone lies under all the slopes already.
    if (step === first) return;
    const list = tones.get(step);
    if (list) list.push(o);
    else tones.set(step, [o]);
  };
  const q: number[] = [];
  for (const face of roofFaces(shape, roof)) {
    const m = face.points.length / 3;
    q.length = 0;
    for (let j = 0; j < m; j++) {
      const p = upright(foot, face.points[3 * j]!, face.points[3 * j + 1]!, Math.min(top, foot.h + face.points[3 * j + 2]!));
      q.push(p[0], p[1]);
    }
    // Seen from outside a face runs clockwise on screen; one that runs the other way shows its back.
    let area = 0;
    for (let j = 0; j < m; j++) {
      const k = (j + 1) % m;
      area += q[2 * j]! * q[2 * k + 1]! - q[2 * k]! * q[2 * j + 1]!;
    }
    if (foot.tall ? !facesEye(face.points, face.normal, foot) : turned ? area >= 0 : area <= 0) continue;
    const whole = outline(q, 2);
    if (face.wall) {
      walls.push(whole);
      continue;
    }
    slopes.push(whole);
    const ways = face.normals;
    if (!ways) {
      toned(Math.round(lit(face.normal[0], face.normal[1], face.normal[2]) * SHADE_STEPS), whole);
      continue;
    }
    // A face of a round roof: its corners are lit each by itself, and it is cut where one tone ends and the next starts.
    const corners: number[] = [];
    let least = Infinity;
    let most = -Infinity;
    for (let j = 0; j < m; j++) {
      const shade = lit(ways[3 * j]!, ways[3 * j + 1]!, ways[3 * j + 2]!);
      corners.push(q[2 * j]!, q[2 * j + 1]!, shade);
      least = Math.min(least, shade);
      most = Math.max(most, shade);
    }
    for (let s = Math.round(least); s <= Math.round(most); s++) {
      const part = s === Math.round(least) && s === Math.round(most) ? corners : between(corners, s - 0.5, s + 0.5);
      if (part.length >= 9) toned(s * SHADE_STEPS, outline(part, 3));
    }
  }
  const fill = itemFill(item);
  const { raw } = easel;
  if (walls.length > 0) {
    raw.fillStyle = sideTone(item.node.colors, fill, paint);
    fillTraced(easel, (to) => traceOutlines(to, walls));
  }
  if (slopes.length > 0) {
    raw.fillStyle = shadeTone(paint, fill, first);
    fillTraced(easel, (to) => traceOutlines(to, slopes));
  }
  for (const [step, list] of tones) {
    raw.fillStyle = shadeTone(paint, fill, step);
    fillTraced(easel, (to) => traceOutlines(to, list));
  }
}

/**
 * Whether a face of a roof of a tall body is turned to the camera: in its plane a face higher than the eye is drawn
 * from points behind the camera, and the way its outline winds there says nothing; the camera's place does.
 */
function facesEye(points: Float64Array, normal: readonly [number, number, number], foot: Foot): boolean {
  return (foot.ux - points[0]!) * normal[0] + (foot.uy - points[1]!) * normal[1] + (foot.uh - foot.h - points[2]!) * normal[2] > 0;
}

/**
 * A hip roof on a free outline, in the units of its top: every slope turned to the viewer, far to near, so that a
 * near wing hides the slopes behind it. All of them are first one path in the tone of the farthest, so that nothing
 * shows between two slopes; then each run of slopes of one tone is one path.
 */
function fillRegionRoof(
  easel: Easel,
  item: ShapeItem,
  shape: ShapeSpec,
  roof: RoofSpec,
  foot: Foot,
  paint: Paint,
  turned: boolean,
  lit: (nx: number, ny: number, nz: number) => number,
): void {
  const top = highest(foot);
  const grid = ROOF_GRID * Math.max(Math.abs(item.xf.scale), 1e-9);
  const seen: { near: number; step: number; outline: number[] }[] = [];
  for (const face of roofFaces(shape, roof)) {
    const m = face.points.length / 3;
    const q: number[] = [];
    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let j = 0; j < m; j++) {
      const p = upright(foot, face.points[3 * j]!, face.points[3 * j + 1]!, Math.min(top, foot.h + face.points[3 * j + 2]!));
      q.push(Math.round(p[0] * grid) / grid, Math.round(p[1] * grid) / grid);
    }
    for (let j = 0; j < m; j++) {
      const k = (j + 1) % m;
      const cross = q[2 * j]! * q[2 * k + 1]! - q[2 * k]! * q[2 * j + 1]!;
      area += cross;
      // The middle of the face in its own plane, for the order.
      const w = face.points[3 * j]! * face.points[3 * k + 1]! - face.points[3 * k]! * face.points[3 * j + 1]!;
      cx += (face.points[3 * j]! + face.points[3 * k]!) * w;
      cy += (face.points[3 * j + 1]! + face.points[3 * k + 1]!) * w;
    }
    if (foot.tall ? !facesEye(face.points, face.normal, foot) : turned ? area >= 0 : area <= 0) continue;
    let plan = 0;
    for (let j = 0; j < m; j++) {
      const k = (j + 1) % m;
      plan += face.points[3 * j]! * face.points[3 * k + 1]! - face.points[3 * k]! * face.points[3 * j + 1]!;
    }
    let mx: number;
    let my: number;
    if (Math.abs(plan) > 1e-12) {
      mx = cx / (3 * plan);
      my = cy / (3 * plan);
    } else {
      mx = 0;
      my = 0;
      for (let j = 0; j < m; j++) {
        mx += face.points[3 * j]! / m;
        my += face.points[3 * j + 1]! / m;
      }
    }
    const [nx, ny, nz] = face.normal;
    const mz = foot.h + face.points[2]! - (nx * (mx - face.points[0]!) + ny * (my - face.points[1]!)) / (nz || 1);
    // How near the viewer the middle is: in a flat layer along the way the viewer looks, in a plane by its distance from the camera.
    const near = foot.uh === 0 ? mx * foot.ux + my * foot.uy + mz : -Math.hypot(mx - foot.ux, my - foot.uy, mz - foot.uh);
    seen.push({ near, step: Math.round(lit(nx, ny, nz) * SHADE_STEPS), outline: q });
  }
  if (seen.length === 0) return;
  seen.sort((a, b) => a.near - b.near);
  const fill = itemFill(item);
  const { raw } = easel;
  const base = seen[0]!.step;
  raw.fillStyle = shadeTone(paint, fill, base);
  fillTraced(easel, (to) => traceOutlines(to, seen.map((s) => s.outline)));
  let from = 0;
  // The farthest run of slopes in the tone of the path under them is already there.
  while (from < seen.length && seen[from]!.step === base) from++;
  while (from < seen.length) {
    const step = seen[from]!.step;
    let to = from;
    while (to < seen.length && seen[to]!.step === step) to++;
    const run = seen.slice(from, to).map((s) => s.outline);
    raw.fillStyle = shadeTone(paint, fill, step);
    fillTraced(easel, (tr) => traceOutlines(tr, run));
    from = to;
  }
}

/**
 * What a body carries beside its plain side and its flat top: the openings of its side, and its roof. True when it
 * has a roof: that stands in place of the flat top.
 */
function fillSolid(ctx: CanvasRenderingContext2D, item: ShapeItem, foot: Foot, paint: Paint): boolean {
  const node = item.node.node as ShapeNode;
  if (!node.openings && !node.roof) return false;
  const { xf } = item;
  const shape = itemShape(item);
  // Seen from behind its plane a body shows its other faces.
  const turned = foot.uh < 0;
  const easel = easelAt(easelOf(ctx), xf);
  const { raw } = easel;
  raw.save();
  raw.translate(xf.x, xf.y);
  raw.rotate(xf.rot);
  raw.scale(xf.scale, xf.scale);
  if (node.openings) {
    const o = node.openings;
    const colors = item.node.colors;
    const full = fullRise(item.node);
    raw.fillStyle = colors['openings'] ? paint.tone('base', colors['openings']) : colors['side'] ? paint.tone('shadow2', colors['side']) : paint.tone('shadow3', itemFill(item));
    fillTraced(easel, (to) => traceOpenings(to, shape, o, foot, full, turned));
  }
  if (node.roof) fillRoof(easel, item, shape, node.roof, foot, paint, turned);
  raw.restore();
  return node.roof !== undefined;
}

/** The shadows of the bodies of a group, in the colour of its cast. The group around the item makes one picture of them. */
export function drawCast(ctx: CanvasRenderingContext2D, item: CastItem, paint: Paint): void {
  const tone = paint.tone('base', item.node.colors['cast']!);
  const trace = (path: Path2D, outlines: readonly ArrayLike<number>[]): void => {
    for (const o of outlines) {
      if (o.length < 6) continue;
      path.moveTo(o[0]!, o[1]!);
      for (let i = 2; i < o.length; i += 2) path.lineTo(o[i]!, o[i + 1]!);
      path.closePath();
    }
  };
  ctx.save();
  ctx.fillStyle = tone;
  ctx.strokeStyle = tone;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // The bodies that are wholly there share one path: where their shadows meet they are one shadow.
  let plain: Path2D | null = null;
  for (const s of item.shadows) {
    if (s.width === 0 && s.alpha >= 0.998) {
      trace((plain ??= new Path2D()), s.outlines);
      continue;
    }
    const path = new Path2D();
    trace(path, s.outlines);
    ctx.globalAlpha = Math.min(1, s.alpha);
    ctx.fill(path);
    if (s.width > 0) {
      ctx.lineWidth = s.width;
      ctx.stroke(path);
    }
  }
  if (plain) {
    ctx.globalAlpha = 1;
    ctx.fill(plain);
  }
  ctx.restore();
}

/**
 * Fills the outline things are clipped to (for a content with a level, its filled part) with the fill the context has:
 * the mask of a clip with a soft edge.
 */
export function fillClipShape(ctx: CanvasRenderingContext2D, item: ClipItem): void {
  ctx.save();
  if (item.level) {
    const below = polygonPath(item.level);
    below.closePath();
    ctx.clip(below);
  }
  ctx.fill(placedPath(item));
  ctx.restore();
}

/** A shape with its automatic light. A content with a level is drawn below its surface only; a body that stands up, over its side. */
export function drawShape(ctx: CanvasRenderingContext2D, item: ShapeItem, paint: Paint): void {
  if ((item.node.node as ShapeNode).relief) {
    drawRelief(ctx, item, (hex) => paint.tone('base', hex));
    return;
  }
  if ((item.node.node as ShapeNode).globe) {
    drawGlobe(ctx, item, (hex) => paint.tone('base', hex));
    return;
  }
  const lift = item.foot?.lift;
  if (lift) {
    // A body taller than the camera is high: at its whole height, every point mapped by itself (liftedContext).
    drawShape(liftedContext(ctx), { ...item, xf: lift.xf, foot: lift.foot }, paint);
    return;
  }
  if (!item.level) {
    if (item.detail?.plain) {
      fillPlain(ctx, item, item.detail.unit, paint);
      return;
    }
    if (item.foot) {
      // The side of a tall body as one outline would take its top for its far edge, which, seen from below, it is not.
      if (item.detail && !item.foot.tall) fillSideRuns(ctx, item, item.foot, item.detail.unit, paint);
      else fillSide(ctx, item, item.foot, paint);
      // A roof stands in place of the flat top.
      if (fillSolid(ctx, item, item.foot, paint)) return;
      // A top higher than the eye is seen from below: the side hides it.
      if (item.foot.tall && item.foot.h >= item.foot.uh) return;
    }
    fillShape(ctx, item, paint);
    return;
  }
  const node = item.node.node as ShapeNode;
  const below = polygonPath(item.level);
  below.closePath();
  ctx.save();
  ctx.clip(below);
  fillShape(ctx, item, paint);
  if (node.lit) {
    // The surface catches the light: a pale line along it, inside the shape.
    ctx.clip(placedPath(item));
    const width = Math.max(2, Math.min(5, shapeExtent(itemShape(item)).inner * 0.06)) * item.xf.scale;
    ctx.strokeStyle = paint.tone('rim', itemFill(item));
    // Half of the stroke lies above the surface, where nothing is drawn.
    ctx.lineWidth = 2 * width;
    ctx.lineJoin = 'round';
    ctx.stroke(polygonPath(item.level, item.level.length - 2));
  }
  ctx.restore();
}

/**
 * Moves the canvas into the own space of a shape that stands up from its plane (stands): its x along the plane,
 * turned with it, its y straight up. A point (px, py) of it stands over the place xf + R (s px, 0) at the height
 * -s py, and the camera, over (sx, sy) at the height H, sees it in the plane where the line from the eye through it
 * meets the plane: xf + R (s px, 0) + (sx, sy) s py / H over 1 + s py / H. A perspective of its own.
 */
function standUp(ctx: CanvasRenderingContext2D, xf: Xf, upon: readonly [number, number, number]): void {
  const s = xf.scale;
  const m = new DOMMatrix();
  m.m11 = Math.cos(xf.rot) * s;
  m.m12 = Math.sin(xf.rot) * s;
  m.m21 = (upon[0] * s) / upon[2];
  m.m22 = (upon[1] * s) / upon[2];
  m.m24 = s / upon[2];
  m.m41 = xf.x;
  m.m42 = xf.y;
  ctx.transform(m);
}

function fillShape(ctx: CanvasRenderingContext2D, item: ShapeItem, paint: Paint): void {
  const node = item.node.node as ShapeNode;
  const { xf } = item;
  const base = itemFill(item);
  const shape = itemShape(item);
  const path = shapePath(shape);
  ctx.save();
  if (item.upon && item.upon[2] !== 0) standUp(ctx, xf, item.upon);
  else {
    ctx.translate(xf.x, xf.y);
    ctx.rotate(xf.rot);
    ctx.scale(xf.scale, xf.scale);
  }
  ctx.fillStyle = paint.tone('base', base);
  ctx.fill(path);
  if (node.lit) {
    // The light direction in the shape's own space: the crescents stay on the
    // correct side however the shape is turned.
    const parts = litParts(shape, vrot(paint.light, -xf.rot));
    ctx.fillStyle = paint.tone('shadow1', base);
    ctx.fill(parts.shadow);
    ctx.fillStyle = paint.tone('shadow2', base);
    ctx.fill(parts.deepShadow);
    const rimLight = item.node.colors['rimLight'];
    if (rimLight) {
      ctx.fillStyle = paint.tone('base', rimLight);
      ctx.fill(parts.rimLight);
    }
    ctx.fillStyle = paint.tone('rim', base);
    ctx.fill(parts.rim);
    // highlight: false keeps the crescents alone: on a long outline with deep bays the stroke would cut across it.
    if (node.highlight !== false) {
      ctx.strokeStyle = paint.tone('highlight', base);
      ctx.lineWidth = parts.highlightWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(parts.highlight);
    }
  }
  ctx.restore();
}

/** The part of a glowing shape that feeds the halo; it fades with the shape. */
export function drawShapeGlow(ctx: CanvasRenderingContext2D, item: ShapeItem, paint: Paint): void {
  const node = item.node.node as ShapeNode;
  const { xf } = item;
  ctx.save();
  if (item.level) {
    const below = polygonPath(item.level);
    below.closePath();
    ctx.clip(below);
  }
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  ctx.fillStyle = withAlpha(paint.tone('glow', itemFill(item)), node.glow * item.alpha);
  ctx.fill(shapePath(itemShape(item)));
  ctx.restore();
}

/**
 * Takes out of the halo what lies behind a cover: the shape of the cover is
 * erased from the glow drawn so far, as far as the cover is opaque.
 */
export function eraseGlow(ctx: CanvasRenderingContext2D, item: ShapeItem): void {
  const { xf } = item;
  ctx.save();
  if (item.level) {
    const below = polygonPath(item.level);
    below.closePath();
    ctx.clip(below);
  }
  ctx.globalCompositeOperation = 'destination-out';
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  ctx.fillStyle = `rgba(0,0,0,${Math.min(1, Math.max(0, item.alpha)).toFixed(4)})`;
  ctx.fill(shapePath(itemShape(item)));
  ctx.restore();
}

function strokeQuad(ctx: CanvasRenderingContext2D, q: Quad, from: number, to: number): void {
  const steps = 24;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const p = quadAt(q, from + ((to - from) * i) / steps);
    if (i === 0) ctx.moveTo(p[0], p[1]);
    else ctx.lineTo(p[0], p[1]);
  }
  ctx.stroke();
}

/** Unit normal of a quadratic curve at t (to the left of its direction). */
function quadNormal(q: Quad, t: number): Vec2 {
  const dx = (1 - t) * (q[1][0] - q[0][0]) + t * (q[2][0] - q[1][0]);
  const dy = (1 - t) * (q[1][1] - q[0][1]) + t * (q[2][1] - q[1][1]);
  const l = Math.hypot(dx, dy);
  return l > 1e-9 ? [-dy / l, dx / l] : [0, 1];
}

/**
 * Pulses as travelling light: a tapered body that is widest and brightest at
 * the head and fades to nothing at the tail, plus a bright head.
 */
function drawPulses(
  ctx: CanvasRenderingContext2D,
  item: LinkItem,
  width: number,
  headRadius: number,
  body: string,
  head: string,
  alpha: number,
): void {
  const steps = 14;
  for (const p of item.pulses) {
    const h = Math.min(p.head, item.reveal);
    const t = Math.min(p.tail, h);
    const headPoint = quadAt(item.curve, h);
    if (h - t > 1e-4) {
      // Thickness and brightness follow the distance from the head, so the tail
      // stays a tail while the pulse is still leaving its source or arriving.
      const left: Vec2[] = [];
      const right: Vec2[] = [];
      for (let i = 0; i <= steps; i++) {
        const u = t + ((h - t) * i) / steps;
        const near = 1 - Math.min(1, (h - u) / PULSE_LENGTH);
        const half = (width / 2) * (0.12 + 0.88 * near ** 1.5);
        const c = quadAt(item.curve, u);
        const n = quadNormal(item.curve, u);
        left.push([c[0] + n[0] * half, c[1] + n[1] * half]);
        right.push([c[0] - n[0] * half, c[1] - n[1] * half]);
      }
      const tailPoint = quadAt(item.curve, t);
      const startNear = 1 - Math.min(1, (h - t) / PULSE_LENGTH);
      const g = ctx.createLinearGradient(tailPoint[0], tailPoint[1], headPoint[0], headPoint[1]);
      g.addColorStop(0, withAlpha(body, alpha * startNear ** 1.5));
      g.addColorStop(1, withAlpha(body, alpha));
      ctx.fillStyle = g;
      ctx.beginPath();
      left.forEach((q, i) => (i === 0 ? ctx.moveTo(q[0], q[1]) : ctx.lineTo(q[0], q[1])));
      for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i]![0], right[i]![1]);
      ctx.closePath();
      ctx.fill();
    }
    if (p.head <= item.reveal + 1e-9) {
      ctx.fillStyle = withAlpha(head, alpha);
      ctx.beginPath();
      ctx.arc(headPoint[0], headPoint[1], headRadius, 0, TAU);
      ctx.fill();
    }
  }
}

/** A link and the pulses travelling along it. */
export function drawLink(ctx: CanvasRenderingContext2D, item: LinkItem, paint: Paint): void {
  // The width the link has at this frame: the lights along it are as large as the line is now.
  const width = itemWidth(item);
  ctx.save();
  ctx.strokeStyle = paint.tone('base', item.node.colors['color']!);
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  strokeQuad(ctx, item.curve, 0, item.reveal);
  const pulse = item.node.colors['pulseColor']!;
  drawPulses(ctx, item, width * 1.5, width * 0.95, paint.tone('pulse', pulse), paint.tone('pulseHead', pulse), 1);
  ctx.restore();
}

/**
 * What a link feeds the halo with: the line itself, as far as the link glows,
 * and its pulses, a little fatter. Both fade with the link.
 */
export function drawLinkGlow(ctx: CanvasRenderingContext2D, item: LinkItem, paint: Paint): void {
  const node = item.node.node as LinkNode;
  if (item.pulses.length === 0 && node.glow <= 0) return;
  const width = itemWidth(item);
  ctx.save();
  if (node.glow > 0) {
    ctx.strokeStyle = withAlpha(paint.tone('glow', item.node.colors['color']!), node.glow * item.alpha);
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokeQuad(ctx, item.curve, 0, item.reveal);
  }
  if (item.pulses.length > 0) {
    const pulse = paint.tone('base', item.node.colors['pulseColor']!);
    drawPulses(ctx, item, width * 2.1, width * 1.5, pulse, pulse, item.alpha);
  }
  ctx.restore();
}

/**
 * Strokes the drawn part of a stroke in the current colour. The dashes are
 * anchored at the first point of the line, so they stay where they are while
 * the line is drawn on; closing the gaps lengthens every dash in place. They
 * are laid out by the width the stroke was given: a width that is keyed makes
 * every dash thicker where it is, and moves none.
 */
function strokeLine(ctx: CanvasRenderingContext2D, item: StrokeItem): void {
  const node = item.node.node as StrokeNode;
  const table = pathTable(itemPath(item));
  const { xf } = item;
  const upTo = table.length * item.drawn;
  const whole = item.drawn >= 1 - 1e-9;
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  ctx.lineWidth = itemWidth(item);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (node.dash && item.solid < 1 - 1e-6) {
    // A dash has round ends, so a gap between two of them is one width longer than it looks.
    const gap = node.dash[1] + node.width;
    ctx.setLineDash([node.dash[0] + gap * item.solid, gap * (1 - item.solid)]);
  }
  ctx.beginPath();
  if (item.runs) {
    // A line on a globe: the parts of it that face the viewer.
    for (const run of item.runs) {
      ctx.moveTo(run[0]!, run[1]!);
      for (let i = 2; i < run.length; i += 2) ctx.lineTo(run[i]!, run[i + 1]!);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (item.part) {
    // One stretch of a wall. Its line reaches a little into the stretches beside it, so that the side of none of them shows in the line.
    const reach = 0.75 * itemWidth(item);
    const points = stretchPoints(table, Math.max(0, item.part[0] - reach), Math.min(item.part[1] + reach, upTo));
    ctx.moveTo(points[0]![0], points[0]![1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]![0], points[i]![1]);
    ctx.stroke();
    ctx.restore();
    return;
  }
  ctx.moveTo(table.xs[0]!, table.ys[0]!);
  const m = table.cum.length;
  for (let i = 1; i < m; i++) {
    if (table.cum[i]! <= upTo) {
      ctx.lineTo(table.xs[i]!, table.ys[i]!);
      continue;
    }
    // The line ends between two samples.
    const span = table.cum[i]! - table.cum[i - 1]!;
    const u = span > 1e-12 ? (upTo - table.cum[i - 1]!) / span : 0;
    if (u > 1e-9) ctx.lineTo(table.xs[i - 1]! + (table.xs[i]! - table.xs[i - 1]!) * u, table.ys[i - 1]! + (table.ys[i]! - table.ys[i - 1]!) * u);
    break;
  }
  if (whole && node.path.closed) ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/** The points of a line between two lengths along it: its two ends there, and every sample between them. */
function stretchPoints(table: PathTable, from: number, to: number): Vec2[] {
  const { xs, ys, cum } = table;
  const m = cum.length;
  // The point at a length that lies between the samples i - 1 and i.
  const at = (s: number, i: number): Vec2 => {
    const span = cum[i]! - cum[i - 1]!;
    const u = span > 1e-12 ? Math.min(1, Math.max(0, (s - cum[i - 1]!) / span)) : 0;
    return [xs[i - 1]! + (xs[i]! - xs[i - 1]!) * u, ys[i - 1]! + (ys[i]! - ys[i - 1]!) * u];
  };
  let lo = 0;
  let hi = m - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= from) lo = mid;
    else hi = mid;
  }
  const out: Vec2[] = [at(from, hi)];
  let i = hi;
  while (i < m - 1 && cum[i]! < to - 1e-12) {
    out.push([xs[i]!, ys[i]!]);
    i++;
  }
  out.push(at(to, i));
  return out;
}

/**
 * The lights that run along a stroke, as the pulses of a link: a tapered body
 * that is widest and brightest at the head and fades to nothing at the tail,
 * plus a bright head. They show on the part of the line that is drawn.
 */
function drawStrokePulses(ctx: CanvasRenderingContext2D, item: StrokeItem, width: number, headRadius: number, body: string, head: string, alpha: number): void {
  const table = pathTable(itemPath(item));
  const { xf } = item;
  const whole = item.drawn >= 1 - 1e-9;
  const drawnTo = table.length * item.drawn;
  const within = (s: number): number => (whole ? s : Math.max(0, Math.min(drawnTo, s)));
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  for (const p of item.pulses ?? []) {
    const h = within(p.head);
    const t = within(p.tail);
    const span = Math.abs(h - t);
    const headPoint = pathAt(table, h);
    if (span > 1e-4 * p.length) {
      // The middle line of the light, tail first; then its two sides, each as far out as the light is thick there.
      const steps = Math.max(14, Math.min(64, Math.ceil(span / 5)));
      const mid: Vec2[] = [];
      for (let i = 0; i <= steps; i++) {
        const q = pathAt(table, t + ((h - t) * i) / steps);
        mid.push([q.x, q.y]);
      }
      const left: Vec2[] = [];
      const right: Vec2[] = [];
      for (let i = 0; i <= steps; i++) {
        // The direction of the line there, taken across its neighbours, so that a corner is rounded off and not notched.
        const a = mid[Math.max(0, i - 1)]!;
        const b = mid[Math.min(steps, i + 1)]!;
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const nx = l > 1e-9 ? -(b[1] - a[1]) / l : 0;
        const ny = l > 1e-9 ? (b[0] - a[0]) / l : 1;
        // Thickness and brightness follow the distance from the head, as on a link.
        const near = 1 - Math.min(1, (span * (steps - i)) / steps / p.length);
        const half = (width / 2) * (0.12 + 0.88 * near ** 1.5);
        left.push([mid[i]![0] + nx * half, mid[i]![1] + ny * half]);
        right.push([mid[i]![0] - nx * half, mid[i]![1] - ny * half]);
      }
      const tailPoint = mid[0]!;
      const startNear = 1 - Math.min(1, span / p.length);
      if (Math.hypot(headPoint.x - tailPoint[0], headPoint.y - tailPoint[1]) > 1e-3) {
        const g = ctx.createLinearGradient(tailPoint[0], tailPoint[1], headPoint.x, headPoint.y);
        g.addColorStop(0, withAlpha(body, alpha * startNear ** 1.5));
        g.addColorStop(1, withAlpha(body, alpha));
        ctx.fillStyle = g;
      } else ctx.fillStyle = withAlpha(body, alpha);
      ctx.beginPath();
      left.forEach((q, i) => (i === 0 ? ctx.moveTo(q[0], q[1]) : ctx.lineTo(q[0], q[1])));
      for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i]![0], right[i]![1]);
      ctx.closePath();
      ctx.fill();
    }
    // The head itself, while it is on the part of the line that is drawn.
    if (whole || (p.head >= -1e-9 && p.head <= drawnTo + 1e-9)) {
      ctx.fillStyle = withAlpha(head, alpha);
      ctx.beginPath();
      ctx.arc(headPoint.x, headPoint.y, headRadius, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * The side of a line that stands up as a wall, in one flat tone: what the drawn part of the line, as wide as it is,
 * passes over on the way from its top down to its foot. The line itself is drawn over it.
 */
function strokeSide(ctx: CanvasRenderingContext2D, item: StrokeItem, foot: Foot, paint: Paint): void {
  const node = item.node.node as StrokeNode;
  const table = pathTable(itemPath(item));
  const upTo = table.length * item.drawn;
  let points: Vec2[] = [[table.xs[0]!, table.ys[0]!]];
  if (item.part) points = stretchPoints(table, item.part[0], Math.min(item.part[1], upTo));
  const m = item.part ? 0 : table.cum.length;
  for (let i = 1; i < m; i++) {
    if (table.cum[i]! <= upTo) {
      points.push([table.xs[i]!, table.ys[i]!]);
      continue;
    }
    // The line ends between two samples.
    const span = table.cum[i]! - table.cum[i - 1]!;
    const u = span > 1e-12 ? (upTo - table.cum[i - 1]!) / span : 0;
    if (u > 1e-9) points.push([table.xs[i - 1]! + (table.xs[i]! - table.xs[i - 1]!) * u, table.ys[i - 1]! + (table.ys[i]! - table.ys[i - 1]!) * u]);
    break;
  }
  if (points.length < 2) return;
  const { xf } = item;
  const closed = !item.part && item.drawn >= 1 - 1e-9 && node.path.closed;
  const path = sidePath(points, closed, foot, false);
  const tone = sideTone(item.node.colors, item.node.colors['color']!, paint);
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  ctx.fillStyle = tone;
  ctx.strokeStyle = tone;
  ctx.lineWidth = itemWidth(item);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.fill(path);
  // A stretch of a wall among sorted children takes the short route; a whole wall is stroked as it always was.
  ctx.stroke(item.part ? sideEdges(points, closed, foot) : path);
  ctx.restore();
  if (node.openings) {
    // A whole closed wall goes on past its seam; a part of one is cut at its ends.
    const whole = !item.part && item.drawn >= 1 - 1e-9;
    fillWallOpenings(ctx, item, foot, paint, node.openings, table, whole ? null : [item.part ? item.part[0] : 0, item.part ? Math.min(item.part[1], upTo) : upTo]);
  }
}

/** An opening of a wall has a point across it to each this share of its width. */
const WALL_ACROSS = 1 / 8;

/**
 * The openings of a wall, on the face of it turned to the viewer: each face stands half the width of the line out from
 * its middle. With `span` only what lies between those two lengths along the line, so that an opening that two
 * stretches of a wall share is drawn half with each.
 */
function fillWallOpenings(ctx: CanvasRenderingContext2D, item: StrokeItem, foot: Foot, paint: Paint, o: OpeningsSpec, table: PathTable, span: readonly [number, number] | null): void {
  const half = itemWidth(item) / 2;
  const L = table.length;
  const columns: OpeningColumn[] = [];
  const add = (a: number, s0: number, s1: number): void => {
    const steps = Math.max(1, Math.ceil((s1 - s0) / (o.width * WALL_ACROSS) - 1e-9));
    const mid = pathAt(table, (s0 + s1) / 2);
    const mnx = Math.sin(mid.angle);
    const mny = -Math.cos(mid.angle);
    for (const side of [1, -1]) {
      const across = new Float64Array(3 * (steps + 1));
      for (let j = 0; j <= steps; j++) {
        const s = s0 + ((s1 - s0) * j) / steps;
        const p = pathAt(table, s);
        across[3 * j] = p.x + side * half * Math.sin(p.angle);
        across[3 * j + 1] = p.y - side * half * Math.cos(p.angle);
        across[3 * j + 2] = (s - a) / o.width;
      }
      columns.push({ across, mx: mid.x + side * half * mnx, my: mid.y + side * half * mny, nx: side * mnx, ny: side * mny });
    }
  };
  for (const middle of wallOpenings(table, o)) {
    if (!span) {
      add(middle - o.width / 2, middle - o.width / 2, middle + o.width / 2);
      continue;
    }
    for (const lap of table.closed ? [-L, 0, L] : [0]) {
      const a = middle + lap - o.width / 2;
      const s0 = Math.max(a, span[0]);
      const s1 = Math.min(a + o.width, span[1]);
      if (s1 - s0 > 1e-6) add(a, s0, s1);
    }
  }
  if (columns.length === 0) return;
  const { xf } = item;
  const easel = easelAt(easelOf(ctx), xf);
  const { raw } = easel;
  const colors = item.node.colors;
  raw.save();
  raw.translate(xf.x, xf.y);
  raw.rotate(xf.rot);
  raw.scale(xf.scale, xf.scale);
  raw.fillStyle = colors['openings'] ? paint.tone('base', colors['openings']) : colors['side'] ? paint.tone('shadow2', colors['side']) : paint.tone('shadow3', colors['color']!);
  fillTraced(easel, (to) => traceColumns(to, columns, o, foot, fullRise(item.node), foot.uh < 0));
  raw.restore();
}

/**
 * The edges of the side of a wall that can lie on its outline: the line at its top, the line at its foot, and the
 * upright from top to foot at each end and wherever the pieces of the side turn over, that is where the side is seen
 * edge on. The upright between two pieces that wind one way lies inside them both and is left out. Stroked as wide as
 * the line, over the pieces filled, they cover what a stroke round every piece covers, but for the smoothing of an
 * edge here and there; a stroke round every piece lays as many bands over each other as the line has samples across
 * its width, and on the GPU that cost each stretch of a wall among sorted children some milliseconds.
 */
function sideEdges(points: readonly Vec2[], closed: boolean, foot: Foot): Path2D {
  const path = new Path2D();
  const n = points.length;
  const low = (p: Vec2): Vec2 => [foot.k * p[0] + foot.x, foot.k * p[1] + foot.y];
  for (const line of [points, points.map(low)]) {
    line.forEach((p, i) => (i === 0 ? path.moveTo(p[0], p[1]) : path.lineTo(p[0], p[1])));
    if (closed) path.closePath();
  }
  // Twice the area of the piece from the point i to the next, as sidePath works it out: its sign says which way it winds.
  const area = (i: number): number => {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const [ax, ay] = low(a);
    const [bx, by] = low(b);
    return a[0] * b[1] - b[0] * a[1] + (b[0] * by - bx * b[1]) + (bx * ay - ax * by) + (ax * a[1] - a[0] * ay);
  };
  const pieces = closed ? n : n - 1;
  for (let j = 0; j < n; j++) {
    const before = j > 0 ? area(j - 1) : closed ? area(n - 1) : Number.NaN;
    const after = j < pieces ? area(j) : Number.NaN;
    if ((before > 0 && after > 0) || (before < 0 && after < 0)) continue;
    const p = points[j]!;
    const q = low(p);
    path.moveTo(p[0], p[1]);
    path.lineTo(q[0], q[1]);
  }
  return path;
}

/** A stroke: a line along a path, solid or dashed, as far as it is drawn, and the lights that run along it. A wall that stands up is drawn over its side. */
export function drawStroke(ctx: CanvasRenderingContext2D, item: StrokeItem, paint: Paint): void {
  if (item.foot) strokeSide(ctx, item, item.foot, paint);
  ctx.strokeStyle = paint.tone('base', item.node.colors['color']!);
  strokeLine(ctx, item);
  if (item.pulses) {
    const width = itemWidth(item);
    const pulse = item.node.colors['pulseColor'] ?? item.node.colors['color']!;
    drawStrokePulses(ctx, item, width * 1.5, width * 0.95, paint.tone('pulse', pulse), paint.tone('pulseHead', pulse), 1);
  }
}

/**
 * What a stroke feeds the halo with: the line itself, as far as the stroke
 * glows, and the lights that run along it, a little fatter. Both fade with the stroke.
 */
export function drawStrokeGlow(ctx: CanvasRenderingContext2D, item: StrokeItem, paint: Paint): void {
  const node = item.node.node as StrokeNode;
  if (node.glow > 0) {
    ctx.strokeStyle = withAlpha(paint.tone('glow', item.node.colors['color']!), node.glow * item.alpha);
    strokeLine(ctx, item);
  }
  if (item.pulses) {
    const pulse = paint.tone('base', item.node.colors['pulseColor'] ?? item.node.colors['color']!);
    const width = itemWidth(item);
    drawStrokePulses(ctx, item, width * 2.1, width * 1.5, pulse, pulse, item.alpha);
  }
}

/**
 * A streak: a capsule of radius r from the particle at (x, y) back to the end of its tail, wound as a disc is, so that
 * streaks that overlap in one path fill as one. A tail shorter than a hundredth of a unit is a disc.
 */
function addStreak(p: Path2D, x: number, y: number, dx: number, dy: number, r: number): void {
  if (Math.abs(dx) + Math.abs(dy) < 0.01) {
    p.moveTo(x + r, y);
    p.arc(x, y, r, 0, TAU);
    return;
  }
  // The angle from the tail to the head: the front half round the head, the back half round the end of the tail.
  const a = Math.atan2(-dy, -dx);
  const h = Math.PI / 2;
  p.moveTo(x + r * Math.cos(a - h), y + r * Math.sin(a - h));
  p.arc(x, y, r, a - h, a + h);
  p.arc(x + dx, y + dy, r, a + h, a + 3 * h);
  p.closePath();
}

/** Particles, batched into one path per colour, plus one for their inner discs if the emitter has a core. Streaks when the item has tails. */
export function drawParticles(ctx: CanvasRenderingContext2D, item: ParticlesItem, paint: Paint, alpha = 1): void {
  const colors = item.node.particleColors;
  const paths: (Path2D | null)[] = colors.map(() => null);
  const core = (item.node.node as EmitterNode).core;
  const cores = core ? new Path2D() : null;
  const d = item.data;
  const tails = item.tails;
  if (tails) {
    for (let i = 0, j = 0; i < d.length; i += PARTICLE_STRIDE, j += PARTICLE_TAIL_STRIDE) {
      const ci = d[i + 3]!;
      let p = paths[ci];
      if (!p) {
        p = new Path2D();
        paths[ci] = p;
      }
      const r = d[i + 2]!;
      addStreak(p, d[i]!, d[i + 1]!, tails[j]!, tails[j + 1]!, r);
      if (core && cores) addStreak(cores, d[i]!, d[i + 1]!, tails[j]!, tails[j + 1]!, r * core.size);
    }
  }
  for (let i = 0; !tails && i < d.length; i += PARTICLE_STRIDE) {
    const ci = d[i + 3]!;
    let p = paths[ci];
    if (!p) {
      p = new Path2D();
      paths[ci] = p;
    }
    const x = d[i]!;
    const y = d[i + 1]!;
    const r = d[i + 2]!;
    p.moveTo(x + r, y);
    p.arc(x, y, r, 0, TAU);
    if (core && cores) {
      const cr = r * core.size;
      cores.moveTo(x + cr, y);
      cores.arc(x, y, cr, 0, TAU);
    }
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  paths.forEach((p, ci) => {
    if (!p) return;
    ctx.fillStyle = paint.tone('base', colors[ci]!);
    ctx.fill(p);
  });
  if (cores) {
    ctx.fillStyle = paint.tone('base', item.node.colors['core']!);
    ctx.fill(cores);
  }
  ctx.restore();
}

/** An eye: a light disc, a pupil that looks somewhere, a glint toward the light. */
export function drawEye(ctx: CanvasRenderingContext2D, item: EyeItem, paint: Paint): void {
  const node = item.node.node as EyeNode;
  const { xf } = item;
  const r = node.r;
  const pr = r * 0.54;
  const travel = (r - pr) * 0.86;
  const l = vrot(paint.light, -xf.rot);
  const white = paint.tone('base', item.node.colors['white']!);
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale * item.open);
  ctx.fillStyle = white;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();
  const px = item.look[0] * travel;
  const py = item.look[1] * travel;
  ctx.fillStyle = paint.tone('base', item.node.colors['pupil']!);
  ctx.beginPath();
  ctx.arc(px, py, pr, 0, TAU);
  ctx.fill();
  ctx.fillStyle = white;
  ctx.beginPath();
  ctx.arc(px + l[0] * pr * 0.42, py + l[1] * pr * 0.42, pr * 0.3, 0, TAU);
  ctx.fill();
  ctx.restore();
}

const textPathCache = new Map<string, Path2D | null>();

/** A line of text as a path centred on x = 0 with its baseline at y = 0. */
function textPath(ctx: CanvasRenderingContext2D, text: string, size: number, weight: number): Path2D | null {
  const key = `${weight}|${size}|${text}`;
  let p = textPathCache.get(key);
  if (p === undefined) {
    ensureFonts();
    ctx.save();
    ctx.font = fontString(size, weight);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    p = ctx.outlineText(text);
    ctx.restore();
    textPathCache.set(key, p);
  }
  return p;
}

const runPathCache = new Map<string, { plain: Path2D | null; run: Path2D | null }>();

/**
 * The lines of a text or a label whose node has a second ink. A line with a run is its one outline cut glyph by glyph
 * into what is in the run and what is not, each filled in its ink, so every glyph stands where the plain line has it.
 */
function fillRunLines(
  ctx: CanvasRenderingContext2D,
  lines: readonly { readonly text: string; readonly x: number; readonly y: number; readonly runs?: readonly RunSpan[] }[],
  size: number,
  weight: number,
  ink: string,
  runInk: string,
): void {
  for (const line of lines) {
    const p = textPath(ctx, line.text, size, weight);
    if (!p) continue;
    ctx.save();
    ctx.translate(line.x, line.y);
    if (!line.runs) {
      ctx.fillStyle = ink;
      ctx.fill(p);
    } else {
      const key = `${weight}|${size}|${line.runs.map((r) => r.join(',')).join(';')}|${line.text}`;
      let parts = runPathCache.get(key);
      if (!parts) {
        parts = splitRuns(p, line.runs);
        runPathCache.set(key, parts);
      }
      if (parts.plain) {
        ctx.fillStyle = ink;
        ctx.fill(parts.plain);
      }
      if (parts.run) {
        ctx.fillStyle = runInk;
        ctx.fill(parts.run);
      }
    }
    ctx.restore();
  }
}

/** Free-standing text: its box, if it has one, and its lines, placed, turned and scaled as its node is. */
export function drawText(ctx: CanvasRenderingContext2D, item: TextItem, paint: Paint): void {
  const b = item.block;
  const { xf } = item;
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  if (b.path) {
    ctx.fillStyle = paint.tone('base', item.node.colors['box']!);
    ctx.fill(b.path);
  }
  const runInk = item.node.colors['runInk'];
  if (runInk) {
    fillRunLines(ctx, item.lines, b.size, b.weight, paint.tone('base', item.node.colors['ink']!), paint.tone('base', runInk));
    ctx.restore();
    return;
  }
  ctx.fillStyle = paint.tone('base', item.node.colors['ink']!);
  for (const line of item.lines) {
    const p = textPath(ctx, line.text, b.size, b.weight);
    if (!p) continue;
    ctx.save();
    ctx.translate(line.x, line.y);
    ctx.fill(p);
    ctx.restore();
  }
  ctx.restore();
}

/**
 * A label. The text is filled as outlines, so it scales cleanly while the label
 * pops in and looks the same on the GPU and on the CPU.
 */
export function drawLabel(ctx: CanvasRenderingContext2D, item: LabelItem, paint: Paint): void {
  const g = item.geometry;
  ctx.save();
  ctx.translate(item.tip[0], item.tip[1]);
  ctx.scale(item.scale, item.scale);
  ctx.fillStyle = paint.tone('base', item.node.colors['fill']!);
  ctx.fill(g.path);
  const runInk = item.node.colors['runInk'];
  if (runInk) {
    fillRunLines(ctx, g.lines, g.size, g.weight, paint.tone('base', item.node.colors['ink']!), paint.tone('base', runInk));
    ctx.restore();
    return;
  }
  ctx.fillStyle = paint.tone('base', item.node.colors['ink']!);
  for (const line of g.lines) {
    const p = textPath(ctx, line.text, g.size, g.weight);
    if (!p) continue;
    ctx.save();
    ctx.translate(line.x, line.y);
    ctx.fill(p);
    ctx.restore();
  }
  ctx.restore();
}
