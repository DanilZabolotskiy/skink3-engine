// An outline that changes over time: reshape keys run every point of a region,
// or of a stroke, to a new place, so that one form turns into another. A node
// without such a key has no track and is the shape it was given.
//
// The shape at a moment is a pure function of the track. Before the first key
// and after a key has ended it is one object, the same at every frame, so
// that what is cached per shape (its path, its light) is built once. While a
// key is under way every frame has a shape of its own.

import type { Vec2 } from '../core/math.ts';
import { profileRamps, rampProgress, type MoveProfile } from '../motion/curves.ts';
import type { ReshapeKey } from '../motion/intents.ts';
import { pathLength, type PathSpec } from '../motion/paths.ts';
import { regionFault, regionShape, seedShapeExtent, shapeExtent, type RegionSpec, type ShapeExtent } from '../shape/geometry.ts';

export class OutlineError extends Error {}

/** An outline at one moment: a region, or the path of a stroke. */
type Form = RegionSpec | PathSpec;

/** One change of an outline, with what it was when the change started. */
export interface OutlineSeg {
  readonly at: number;
  readonly dur: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
  /** The outline when the key starts and when it ends. Both are whole shapes: what is cached for them is built once. */
  readonly from: Form;
  readonly to: Form;
  /** The farthest any of its points travels, in the node's own units. */
  readonly travel: number;
  /** What the keys before this one have added up to, in the same units. */
  readonly before: number;
}

export interface OutlineTrack {
  /** The outline the node was given. */
  readonly base: Form;
  readonly segs: readonly OutlineSeg[];
}

const smoothOf = (form: Form): number => form.smooth ?? 1;

const isPath = (form: Form): form is PathSpec => 'closed' in form;

function mixPoints(a: readonly Vec2[], b: readonly Vec2[], p: number): Vec2[] {
  return a.map((q, i) => [q[0] + (b[i]![0] - q[0]) * p, q[1] + (b[i]![1] - q[1]) * p] as Vec2);
}

function mixExtent(a: ShapeExtent, b: ShapeExtent, p: number): ShapeExtent {
  const mix = (x: number, y: number): number => x + (y - x) * p;
  return { center: [mix(a.center[0], b.center[0]), mix(a.center[1], b.center[1])], inner: mix(a.inner, b.inner), outer: mix(a.outer, b.outer) };
}

/** The outline between two others, `p` of the way: every point on the straight line to its place, the smoothing between the two. */
function between(from: Form, to: Form, p: number): Form {
  const points = mixPoints(from.points, to.points, p);
  const smooth = smoothOf(from) + (smoothOf(to) - smoothOf(from)) * p;
  if (isPath(from)) return { points, closed: from.closed, smooth };
  const spec: RegionSpec = { kind: 'polygon', points, radius: 0, smooth };
  // Its middle and its sizes are taken between those of the two ends: they change evenly, and the light with them.
  seedShapeExtent(spec, mixExtent(shapeExtent(from as RegionSpec), shapeExtent(to as RegionSpec), p));
  return spec;
}

/** The key that is under way at time t, or the last that has started, and how far it has gone (0..1); null before the first. */
function segAt(track: OutlineTrack, t: number): { seg: OutlineSeg; p: number } | null {
  let seg: OutlineSeg | null = null;
  for (const s of track.segs) {
    if (t >= s.at) seg = s;
    else break;
  }
  if (!seg) return null;
  const u = (t - seg.at) / seg.dur;
  if (u >= 1) return { seg, p: 1 };
  const [a, b] = profileRamps(seg.profile, seg.ramp);
  return { seg, p: rampProgress(u, a, b) };
}

/** The last outline worked out for a track: every reader of one frame gets the same object. */
const memo = new WeakMap<OutlineTrack, { t: number; form: Form }>();

/** The outline at time t. */
function formAt(track: OutlineTrack, t: number): Form {
  const now = segAt(track, t);
  if (!now) return track.base;
  if (now.p >= 1) return now.seg.to;
  if (now.p <= 0) return now.seg.from;
  const hit = memo.get(track);
  if (hit && hit.t === t) return hit.form;
  const form = between(now.seg.from, now.seg.to, now.p);
  memo.set(track, { t, form });
  return form;
}

/** The shape of a region at time t: the one it was given, or what its reshape keys have made of it by then. */
export function regionAt(track: OutlineTrack, t: number): RegionSpec {
  return formAt(track, t) as RegionSpec;
}

/** The path of a stroke at time t. */
export function strokePathAt(track: OutlineTrack, t: number): PathSpec {
  return formAt(track, t) as PathSpec;
}

/**
 * How far the outline has changed by time t, in the node's own units: for
 * every key the way of the point that travels farthest, as far as the key has
 * gone. It only grows; its step from frame to frame is what a viewer sees move.
 */
export function outlineTravel(track: OutlineTrack, t: number): number {
  const now = segAt(track, t);
  return now ? now.seg.before + now.seg.travel * now.p : 0;
}

/** Every outline the node ever rests in: the one it was given and the end of every key. */
export function restForms(track: OutlineTrack): Form[] {
  return [track.base, ...track.segs.map((s) => s.to)];
}

/** Shares of a change at which the outline of a region is held against the rules of a region. */
const CHECKED = [1 / 16, 2 / 16, 3 / 16, 4 / 16, 5 / 16, 6 / 16, 7 / 16, 8 / 16, 9 / 16, 10 / 16, 11 / 16, 12 / 16, 13 / 16, 14 / 16, 15 / 16];

/**
 * The track of the reshape keys of a node: `base` is the region or the path
 * it was given. Keys chain: each starts from the outline reached at its
 * moment. A region must stay a region all the way: its outline may not cross
 * itself, and may not turn inside out.
 */
export function buildOutlineTrack(id: string, base: Form, keys: readonly ReshapeKey[]): OutlineTrack {
  const segs: OutlineSeg[] = [];
  for (const k of keys.slice().sort((p, q) => p.at - q.at)) {
    const w = `reshape("${id}") at ${k.at} s`;
    const track: OutlineTrack = { base, segs };
    const from = formAt(track, k.at);
    const done = outlineTravel(track, k.at);
    if (k.points.length !== from.points.length) {
      throw new OutlineError(`${w}: the new outline has ${k.points.length} points, and "${id}" has ${from.points.length}; give as many, each where the point of the same place in the list goes`);
    }
    const smooth = k.smooth ?? smoothOf(from);
    let to: Form;
    if (isPath(from)) {
      to = { points: k.points.map((p) => [p[0], p[1]] as Vec2), closed: from.closed, smooth };
      if (!(pathLength(to) > 1e-6)) throw new OutlineError(`${w}: the new points give a line without length`);
    } else {
      try {
        to = regionShape(k.points, smooth);
      } catch (e) {
        throw new OutlineError(`${w}: the new outline is no region: ${(e as Error).message.replace(/^region: /, '')}`);
      }
      // On the way every point runs straight to its place. The outline must stay one that has an inside.
      for (const p of CHECKED) {
        const fault = regionFault(mixPoints(from.points, to.points, p), smoothOf(from) + (smooth - smoothOf(from)) * p, 1);
        if (fault !== null) {
          throw new OutlineError(
            `${w}: on the way to its new outline the region is no region (${fault}, ${Math.round(p * 100)} % of the way). ` +
              'Give both outlines the same way round and from the same place, so that every point runs to its place without crossing the outline; or reshape in two steps',
          );
        }
      }
    }
    let travel = 0;
    for (let i = 0; i < from.points.length; i++) travel = Math.max(travel, Math.hypot(to.points[i]![0] - from.points[i]![0], to.points[i]![1] - from.points[i]![1]));
    segs.push({ at: k.at, dur: k.dur, profile: k.profile, ramp: k.ramp, from, to, travel, before: done });
  }
  return { base, segs };
}
