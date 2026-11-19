// The outline of a region, or the line of a stroke, that is worked out anew at
// every frame: its points follow a drive, or they are points of the space of a
// perspective layer and are seen through its camera, or both.

import type { Vec2 } from '../core/math.ts';
import { sampleDrive, type DriveTrack } from '../motion/drive.ts';
import type { PathSpec } from '../motion/paths.ts';
import { sampleAway, samplePos } from '../motion/tracks.ts';
import { seedShapeExtent, type RegionSpec } from '../shape/geometry.ts';
import type { CNode } from './compile.ts';
import { eyeOf, perspAt, project, type PerspTrack } from './space.ts';

export interface FormTrack {
  readonly kind: 'region' | 'stroke';
  /** Numbers per point: 2 in the node's own flat space, 3 in the space of its perspective layer. */
  readonly dims: 2 | 3;
  /** The points as authored, one after another. */
  readonly base: readonly number[];
  readonly smooth: number;
  /** A stroke: the line runs back to its first point. */
  readonly closed: boolean;
  /** A region in space: it is drawn from behind too. */
  readonly back: boolean;
  /** The samples its points follow, or null: they stay as authored. */
  readonly drive: DriveTrack | null;
  /** The camera of its layer, for points of three numbers. */
  readonly persp: PerspTrack | null;
}

/** A form at one moment. */
export interface FormState {
  /** Points of three numbers: where the middle of the form is drawn on the layer, how large one unit is there, and how far it is. */
  readonly x: number;
  readonly y: number;
  readonly k: number;
  readonly far: number;
  /** Not drawn at this moment: too near the camera or behind it, edge-on, or seen from a back that is not drawn. */
  readonly hidden: boolean;
  /** The outline of a region, in the node's own units around (x, y). */
  readonly shape?: RegionSpec;
  /** The line of a stroke, likewise. */
  readonly path?: PathSpec;
}

/** The points of a form at time t, one after another, as authored or as driven. */
export function formPoints(track: FormTrack, t: number): readonly number[] {
  return (track.drive ? sampleDrive(track.drive, t) : null) ?? track.base;
}

/** How far the point of a form that travels farthest goes between two moments, in the node's own units. */
export function formStep(track: FormTrack, t0: number, t1: number): number {
  if (!track.drive) return 0;
  const a = formPoints(track, t0);
  const b = formPoints(track, t1);
  let best = 0;
  for (let i = 0; i < a.length; i += track.dims) {
    let d = 0;
    for (let k = 0; k < track.dims; k++) d += (b[i + k]! - a[i + k]!) ** 2;
    if (d > best) best = d;
  }
  return Math.sqrt(best);
}

function area(points: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

/**
 * A region through points that are clockwise on screen, with a middle and
 * sizes that change evenly from frame to frame. The middle is that of the
 * outline as a line, each edge weighed by its length: it does not depend on
 * how many points an edge is given, and it stays where it is when the outline
 * crosses itself and the area it encloses passes through nothing.
 */
function regionOf(points: Vec2[], smooth: number): RegionSpec {
  const spec: RegionSpec = { kind: 'polygon', points, radius: 0, smooth };
  let cx = 0;
  let cy = 0;
  let around = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    cx += ((p[0] + q[0]) / 2) * len;
    cy += ((p[1] + q[1]) / 2) * len;
    around += len;
  }
  cx /= around;
  cy /= around;
  let inner = Infinity;
  let outer = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    outer = Math.max(outer, Math.hypot(p[0] - cx, p[1] - cy));
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const len2 = ex * ex + ey * ey;
    const u = len2 > 0 ? Math.min(1, Math.max(0, ((cx - p[0]) * ex + (cy - p[1]) * ey) / len2)) : 0;
    inner = Math.min(inner, Math.hypot(p[0] + ex * u - cx, p[1] + ey * u - cy));
  }
  seedShapeExtent(spec, { center: [cx, cy], inner: Math.max(inner, 1e-3), outer: Math.max(outer, 1e-3) });
  return spec;
}

const HIDDEN: FormState = { x: 0, y: 0, k: 0, far: 0, hidden: true };
const memo = new WeakMap<FormTrack, { t: number; state: FormState }>();

/**
 * The form of a node at time t. Every reader of a frame gets the same object,
 * so what is worked out for an outline is worked out once.
 */
export function formAt(n: CNode, t: number): FormState {
  const track = n.form!;
  const hit = memo.get(track);
  if (hit && hit.t === t) return hit.state;
  const state = work(n, track, t);
  memo.set(track, { t, state });
  return state;
}

function work(n: CNode, track: FormTrack, t: number): FormState {
  const raw = formPoints(track, t);
  let local: Vec2[] = [];
  let at = { x: 0, y: 0, k: 1, far: 0 };
  if (track.dims === 2) {
    for (let i = 0; i < raw.length; i += 2) local.push([raw[i]!, raw[i + 1]!]);
  } else {
    // Points of the space: seen through the camera of the layer, around the picture of their middle.
    const eye = eyeOf(perspAt(track.persp!, t));
    const [ox, oy] = samplePos(n.pos!, t);
    const oz = n.away ? sampleAway(n.away, t) : 0;
    const count = raw.length / 3;
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (let i = 0; i < raw.length; i += 3) {
      mx += raw[i]!;
      my += raw[i + 1]!;
      mz += raw[i + 2]!;
    }
    const middle = project(eye, [ox + mx / count, oy + my / count, oz + mz / count]);
    if (middle.k === 0) return HIDDEN;
    for (let i = 0; i < raw.length; i += 3) {
      const p = project(eye, [ox + raw[i]!, oy + raw[i + 1]!, oz + raw[i + 2]!]);
      if (p.k === 0) return HIDDEN;
      local.push([(p.x - middle.x) / middle.k, (p.y - middle.y) / middle.k]);
    }
    at = middle;
  }
  if (track.kind === 'stroke') {
    let size = 0;
    for (const p of local) size = Math.max(size, Math.abs(p[0] - local[0]![0]), Math.abs(p[1] - local[0]![1]));
    if (!(size > 1e-6)) return { ...at, hidden: true };
    return { ...at, hidden: false, path: { points: local, closed: track.closed, smooth: track.smooth } };
  }
  let size = 0;
  for (const p of local) size = Math.max(size, Math.abs(p[0] - local[0]![0]), Math.abs(p[1] - local[0]![1]));
  if (!(size > 1e-6)) return { ...at, hidden: true };
  const signed = area(local);
  if (track.dims === 3) {
    // The points of a region of the space run clockwise as its front is seen; the other way round, it is seen
    // from behind. Seen edge-on it has no picture.
    if (!(Math.abs(signed) > 1e-6) || (signed < 0 && !track.back)) return { ...at, hidden: true };
  }
  // A flat outline that crosses itself may enclose no area on balance, and is still drawn: two lobes, as a sheet
  // that is seen edge-on where it turns over.
  if (signed < 0) local = local.reverse();
  return { ...at, hidden: false, shape: regionOf(local, track.smooth) };
}
