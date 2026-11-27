// The ground of a plane: a relief that the things of its plane stand on.
//
// A group in a plane of a perspective layer may name a relief among its children as its ground (`ground`), or a few,
// a finer one over part of a coarser one. The reliefs are then drawn raised, as hills seen through the camera of the
// layer, and what comes after the first of them in the group stands on them: a body, a ship, a tree at the height of
// the ground under its place, a region and a stroke point by point. The height of the ground at a place is read off a
// relief's grid along the same smooth curves (Catmull-Rom) the relief is drawn with, in the units of the plane: its
// heights times its `vertical`, times its own scale. Where a later relief lies over an earlier one, its height is
// taken, blended into the earlier one's over its feather.
//
// `reliefHeight` gives the same height to a scene, for a relief node as it is built.

import { type Vec2, type Xf } from '../core/math.ts';
import type { ReliefSpec, SceneNode, ShapeNode } from './types.ts';

/** The ground of a plane at a frame: the height over the plane at a place of it, in its units. */
export interface GroundField {
  /** The node index of the relief. */
  readonly index: number;
  /** The height over the plane at a place of the plane (its units), from the relief's grid; past its edges, that of the nearest edge. */
  at(x: number, y: number): number;
  /** The lowest and the highest the ground reaches, in the units of the plane. */
  readonly low: number;
  readonly high: number;
  /** The distance between two points of the grid, the shorter way, in the units of the plane. */
  readonly cell: number;
}

/** The most cells a relief's heights may be smoothed by (`smooth`, the deviation of the bell, in cells of its grid). */
export const RELIEF_SMOOTH_MAX = 16;

/**
 * Heights smoothed by a bell (a Gaussian) of `cells` cells of the grid (its standard deviation), across and then down,
 * the edge points standing for the ground beyond the edge. What is finer than a cell or two, the steps of a coarse grid
 * seen close, goes; a range many cells across keeps its form and nearly its height. 0: the heights as they are.
 */
export function smoothHeights(values: Float32Array, cols: number, rows: number, cells: number): Float32Array {
  if (!(cells > 0)) return values;
  const reach = Math.ceil(3 * cells);
  const bell = new Float64Array(2 * reach + 1);
  let sum = 0;
  for (let k = -reach; k <= reach; k++) sum += bell[k + reach] = Math.exp(-(k * k) / (2 * cells * cells));
  for (let k = 0; k < bell.length; k++) bell[k]! /= sum;
  const across = new Float32Array(values.length);
  for (let r = 0; r < rows; r++) {
    const row = r * cols;
    for (let c = 0; c < cols; c++) {
      let v = 0;
      for (let k = -reach; k <= reach; k++) v += bell[k + reach]! * values[row + Math.max(0, Math.min(cols - 1, c + k))]!;
      across[row + c] = v;
    }
  }
  const out = new Float32Array(values.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let v = 0;
      for (let k = -reach; k <= reach; k++) v += bell[k + reach]! * across[Math.max(0, Math.min(rows - 1, r + k)) * cols + c]!;
      out[r * cols + c] = v;
    }
  }
  return out;
}

/** Catmull-Rom weights of the four points around a place t (0..1) between the second and the third. */
export function curveWeights(t: number, out: Float64Array): void {
  const t2 = t * t;
  const t3 = t2 * t;
  out[0] = 0.5 * (-t3 + 2 * t2 - t);
  out[1] = 0.5 * (3 * t3 - 5 * t2 + 2);
  out[2] = 0.5 * (-3 * t3 + 4 * t2 + t);
  out[3] = 0.5 * (t3 - t2);
}

/** The rect a relief spans in its own units: the outer points of its shape. */
export function reliefRect(points: readonly Vec2[]): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  return [x0, y0, x1, y1];
}

/** The height of a grid at a place of it, in points of the grid (clamped to it), along smooth curves. */
export function gridHeight(spec: ReliefSpec, gx: number, gy: number, wx: Float64Array, wy: Float64Array): number {
  const { cols, rows, heights } = spec;
  const x = Math.max(0, Math.min(cols - 1, gx));
  const y = Math.max(0, Math.min(rows - 1, gy));
  const c0 = Math.min(cols - 2, Math.floor(x));
  const r0 = Math.min(rows - 2, Math.floor(y));
  curveWeights(x - c0, wx);
  curveWeights(y - r0, wy);
  const left = Math.max(0, c0 - 1);
  const right = Math.min(cols - 1, c0 + 2);
  const w0 = wx[0]!;
  const w1 = wx[1]!;
  const w2 = wx[2]!;
  const w3 = wx[3]!;
  let z = 0;
  for (let j = 0; j < 4; j++) {
    const r = Math.max(0, Math.min(rows - 1, r0 - 1 + j)) * cols;
    let rz = 0;
    rz += w0 * heights[r + left]!;
    rz += w1 * heights[r + c0]!;
    rz += w2 * heights[r + c0 + 1]!;
    rz += w3 * heights[r + right]!;
    z += wy[j]! * rz;
  }
  return z;
}

/** How much of a field shows at a place, by its distance from the nearest edge: 1 past `feather`, fading to 0 at the edge. */
export function fadeAt(x: number, y: number, x0: number, y0: number, x1: number, y1: number, feather: number): number {
  const d = Math.min(x - x0, x1 - x, y - y0, y1 - y) / feather;
  if (d >= 1) return 1;
  if (d <= 0) return 0;
  return d * d * (3 - 2 * d);
}

const spans = new WeakMap<ReliefSpec, readonly [number, number]>();

/** The lowest and the highest height of a grid. */
function span(spec: ReliefSpec): readonly [number, number] {
  const saved = spans.get(spec);
  if (saved) return saved;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of spec.heights) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const bounds = [lo, hi] as const;
  spans.set(spec, bounds);
  return bounds;
}

interface GroundPlacement {
  readonly points: readonly Vec2[];
  readonly xf: Xf;
  readonly under: GroundField | undefined;
  readonly field: GroundField;
}

const placements = new WeakMap<ReliefSpec, GroundPlacement>();

/**
 * The ground a relief makes of its plane, where the relief lies at `xf` (its place, turn and size in the plane). Over
 * the ground of reliefs before it (`under`), it is that ground outside its rect and its own inside, blended into it
 * over its feather.
 */
export function groundField(index: number, spec: ReliefSpec, points: readonly Vec2[], xf: Xf, under?: GroundField): GroundField {
  const saved = placements.get(spec);
  if (saved?.field.index === index && saved.points === points && saved.under === under &&
      Object.is(saved.xf.x, xf.x) && Object.is(saved.xf.y, xf.y) &&
      Object.is(saved.xf.rot, xf.rot) && Object.is(saved.xf.scale, xf.scale)) return saved.field;
  const [x0, y0, x1, y1] = reliefRect(points);
  const sx = (spec.cols - 1) / (x1 - x0);
  const sy = (spec.rows - 1) / (y1 - y0);
  const cos = Math.cos(-xf.rot);
  const sin = Math.sin(-xf.rot);
  const k = spec.vertical * xf.scale;
  const wx = new Float64Array(4);
  const wy = new Float64Array(4);
  const [lo, hi] = span(spec);
  const feather = spec.feather ?? 0;
  const field: GroundField = {
    index,
    at(x: number, y: number): number {
      // From the plane into the relief's own units, then into points of its grid.
      const dx = (x - xf.x) / xf.scale;
      const dy = (y - xf.y) / xf.scale;
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      if (!under) return gridHeight(spec, (lx - x0) * sx, (ly - y0) * sy, wx, wy) * k;
      const own = lx >= x0 && lx <= x1 && ly >= y0 && ly <= y1 ? (feather > 0 ? fadeAt(lx, ly, x0, y0, x1, y1, feather) : 1) : 0;
      const below = own < 1 ? under.at(x, y) : 0;
      return own > 0 ? below + (gridHeight(spec, (lx - x0) * sx, (ly - y0) * sy, wx, wy) * k - below) * own : below;
    },
    low: Math.min(lo * k, hi * k, under?.low ?? Infinity),
    high: Math.max(lo * k, hi * k, under?.high ?? -Infinity),
    cell: Math.min(Math.min(1 / sx, 1 / sy) * xf.scale, under?.cell ?? Infinity),
  };
  placements.set(spec, { points, xf, under, field });
  return field;
}

/**
 * The height of the ground a relief makes, at a place of its parent (a group with `plane`): its height there times its
 * `vertical`, in the units of the plane, read along the curves it is drawn with. Past its edges, the height of the
 * nearest edge. It is the height at which a group with `ground` stands a thing at that place, for a scene that needs
 * the number (a travel along a path with heights in another layer, a label above a hill).
 */
export function reliefHeight(node: SceneNode): (p: Vec2) => number {
  const shape = node as ShapeNode;
  if (shape?.type !== 'shape' || !shape.relief || shape.shape.kind !== 'polygon') throw new Error('reliefHeight: give it a node made by relief()');
  const field = groundField(-1, shape.relief, shape.shape.points, { x: shape.at[0], y: shape.at[1], rot: (shape.rotation * Math.PI) / 180, scale: shape.scale });
  return (p) => field.at(p[0], p[1]);
}
