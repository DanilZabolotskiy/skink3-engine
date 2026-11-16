// Timeline keys compiled into per-node tracks, and their sampling. A track is
// plain data; sampling it at a time is a pure function.

import { ease } from '../core/easing.ts';
import { overshootStep } from '../core/dynamics.ts';
import type { Vec2 } from '../core/math.ts';
import { arcBump, bumpScale, BUMP_SECONDS, DEFAULT_RAMP, moveProgress, popInScale, popOutScale, profileRamps, rampProgress, type MoveProfile } from './curves.ts';
import type {
  BumpKey,
  CountToKey,
  DrawOnKey,
  FadeToKey,
  HopKey,
  LevelToKey,
  MoveToKey,
  OpenToKey,
  PopInKey,
  PopOutKey,
  PulseKey,
  ScaleToKey,
  SolidToKey,
  SquashKey,
  TravelKey,
  TurnToKey,
} from './intents.ts';
import { pathAt, pathTable, type PathSpec } from './paths.ts';

/** A move never backs away or overshoots by more than this many units, however long it is. */
export const MAX_ANTICIPATION_UNITS = 44;
export const MAX_OVERSHOOT_UNITS = 38;
/** An arc never bulges by more than this many units. */
export const MAX_ARC_UNITS = 150;

export class TrackError extends Error {}

const EPS = 1e-9;

/** One stretch of a node's travel: a move between two places, a hop, or a path. */
export interface MoveSeg {
  /** 'move': moveTo. 'hop': a parabola. 'path': travel along a free-form path. */
  readonly kind: 'move' | 'hop' | 'path';
  readonly at: number;
  readonly dur: number;
  readonly from: Vec2;
  readonly to: Vec2;
  readonly anticipation: number;
  readonly overshoot: number;
  readonly arc: number;
  readonly profile: MoveProfile;
  readonly ramp: number;
  /** Hops: the height of the flight above the straight line, in units. */
  readonly height: number;
  /** Paths only. */
  readonly path: PathSpec | null;
  readonly loops: number;
  readonly roll: number | null;
  readonly orient: boolean;
  readonly only: boolean;
}

export interface PosTrack {
  readonly base: Vec2;
  readonly segs: readonly MoveSeg[];
  /** A path of this track turns the node (roll or orient). */
  readonly turns: boolean;
  /** A path of this track shows the node only while it travels. */
  readonly onlyWhile: boolean;
}

const NAMES = { moveTo: 'moveTo', hop: 'hop', travel: 'travel' } as const;

export function buildPosTrack(id: string, base: Vec2, keys: readonly (MoveToKey | HopKey | TravelKey)[]): PosTrack {
  const sorted = keys.slice().sort((a, b) => a.at - b.at);
  const segs: MoveSeg[] = [];
  let from = base;
  let free = -Infinity;
  for (const k of sorted) {
    if (k.at < free - EPS) {
      throw new TrackError(
        `${NAMES[k.kind]}("${id}") at ${k.at} s starts before the previous move has ended (${free.toFixed(3)} s); ` +
          'start it later or shorten the previous move',
      );
    }
    const plain = { anticipation: 0, overshoot: 0, arc: 0, profile: 'steady' as MoveProfile, ramp: 0, height: 0, path: null, loops: 1, roll: null, orient: false, only: false };
    if (k.kind === 'moveTo') {
      // Keys made before profiles existed carry none: they are settle moves.
      segs.push({ ...plain, kind: 'move', at: k.at, dur: k.dur, from, to: k.to, anticipation: k.anticipation, overshoot: k.overshoot, arc: k.arc, profile: k.profile ?? 'settle', ramp: k.ramp ?? 0 });
      from = k.to;
    } else if (k.kind === 'hop') {
      segs.push({ ...plain, kind: 'hop', at: k.at, dur: k.dur, from, to: k.to, height: k.height });
      from = k.to;
    } else {
      const table = pathTable(k.path);
      const start: Vec2 = [table.xs[0]!, table.ys[0]!];
      const end: Vec2 = k.path.closed ? start : [table.xs[table.xs.length - 1]!, table.ys[table.ys.length - 1]!];
      segs.push({ ...plain, kind: 'path', at: k.at, dur: k.dur, from: start, to: end, profile: k.profile, ramp: k.ramp, path: k.path, loops: k.loops, roll: k.roll, orient: k.orient, only: k.only });
      from = end;
    }
    free = k.at + k.dur;
  }
  return { base, segs, turns: segs.some((s) => s.roll !== null || s.orient), onlyWhile: segs.some((s) => s.only) };
}

/** Progress (0..1) of a segment with a profile other than settle. */
function plainProgress(seg: MoveSeg, u: number): number {
  if (seg.profile === 'steady' || seg.profile === 'settle') return u;
  const [a, b] = profileRamps(seg.profile, seg.ramp);
  return rampProgress(u, a, b);
}

export function samplePos(track: PosTrack, t: number): Vec2 {
  let seg: MoveSeg | null = null;
  for (const s of track.segs) {
    if (t >= s.at) seg = s;
    else break;
  }
  if (!seg) return track.base;
  const u = (t - seg.at) / seg.dur;
  if (u >= 1) return seg.to;
  if (seg.kind === 'path') {
    const table = pathTable(seg.path!);
    const p = pathAt(table, plainProgress(seg, u) * table.length * seg.loops);
    return [p.x, p.y];
  }
  const dx = seg.to[0] - seg.from[0];
  const dy = seg.to[1] - seg.from[1];
  if (seg.kind === 'hop') {
    // Sideways at one speed; the height is a parabola, as under gravity. Up is the top of the frame.
    return [seg.from[0] + dx * u, seg.from[1] + dy * u - seg.height * 4 * u * (1 - u)];
  }
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-9) return seg.to;
  let p: number;
  if (seg.profile === 'settle') {
    const a = Math.min(seg.anticipation, MAX_ANTICIPATION_UNITS / dist);
    const o = Math.min(seg.overshoot, MAX_OVERSHOOT_UNITS / dist);
    p = moveProgress(u, a, o);
  } else {
    p = plainProgress(seg, u);
  }
  // The arc bulges toward the top of the frame for a positive `arc` (to the left for a vertical move).
  let px = dy / dist;
  let py = -dx / dist;
  if (py > 1e-9 || (Math.abs(py) <= 1e-9 && px > 0)) {
    px = -px;
    py = -py;
  }
  const h = Math.sign(seg.arc) * Math.min(Math.abs(seg.arc) * dist, MAX_ARC_UNITS) * arcBump(p);
  return [seg.from[0] + dx * p + px * h, seg.from[1] + dy * p + py * h];
}

/**
 * The turn (degrees) that the paths of a track add to the node's rotation at
 * time t: what it has rolled so far, and the direction of the path it faces
 * along. Before its first path a node that faces along paths already looks the
 * way that path sets off, so it does not snap round when it starts.
 */
export function samplePathTurn(track: PosTrack, t: number): number {
  if (!track.turns) return 0;
  let turn = 0;
  let facing: number | null = null;
  let firstFacing: number | null = null;
  for (const seg of track.segs) {
    if (seg.kind !== 'path' || (seg.roll === null && !seg.orient)) continue;
    const table = pathTable(seg.path!);
    const total = table.length * seg.loops;
    const started = t >= seg.at;
    const u = started ? Math.min(1, (t - seg.at) / seg.dur) : 0;
    // The direction at the very end is taken a hair before it, where the path still has one.
    const p = pathAt(table, Math.min(plainProgress(seg, u) * total, total - 1e-6));
    if (seg.roll !== null && started) turn += ((p.roll / seg.roll) * 180) / Math.PI;
    if (seg.orient) {
      const deg = (p.angle * 180) / Math.PI;
      if (firstFacing === null) firstFacing = deg;
      if (started) facing = deg;
    }
  }
  return turn + (facing ?? firstFacing ?? 0);
}

/** False while a node that is drawn only while it travels is not travelling. */
export function sampleTravelling(track: PosTrack, t: number): boolean {
  if (!track.onlyWhile) return true;
  for (const seg of track.segs) {
    if (seg.kind === 'path' && t >= seg.at && t < seg.at + seg.dur) return true;
  }
  return false;
}

export interface LevelSeg {
  readonly at: number;
  readonly dur: number;
  readonly from: number;
  readonly to: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
}

/** The level of a shape that fills from the bottom, over time. */
export interface LevelTrack {
  /** Level before the first levelTo: 0 = empty, 1 = full. */
  readonly base: number;
  readonly segs: readonly LevelSeg[];
}

/** Level at time t, 0..1. */
export function sampleLevel(track: LevelTrack, t: number): number {
  let seg: LevelSeg | null = null;
  for (const s of track.segs) {
    if (t >= s.at) seg = s;
    else break;
  }
  if (!seg) return track.base;
  const u = (t - seg.at) / seg.dur;
  if (u >= 1) return seg.to;
  const [a, b] = profileRamps(seg.profile, seg.ramp);
  return seg.from + (seg.to - seg.from) * rampProgress(u, a, b);
}

export function buildLevelTrack(base: number, keys: readonly LevelToKey[]): LevelTrack {
  const segs: LevelSeg[] = [];
  for (const k of keys.slice().sort((a, b) => a.at - b.at)) {
    // Like fadeTo, a levelTo takes over from the level reached at that moment.
    segs.push({ at: k.at, dur: k.dur, from: sampleLevel({ base, segs }, k.at), to: k.to, profile: k.profile, ramp: k.ramp });
  }
  return { base, segs };
}

/** Squashes and stretches of a node, in order of time. */
export interface StretchTrack {
  readonly kicks: readonly { readonly at: number; readonly amount: number; readonly dur: number; readonly pivot: Vec2 }[];
}

export function buildStretchTrack(keys: readonly SquashKey[]): StretchTrack {
  return { kicks: keys.map((k) => ({ at: k.at, amount: k.amount, dur: k.dur, pivot: k.pivot })).sort((a, b) => a.at - b.at) };
}

/** The height may not go below or above these shares of itself, whatever kicks add up. */
const STRETCH_MIN = 0.4;
const STRETCH_MAX = 1.9;

/**
 * The stretch of a node at time t: the factor of its height (its width takes
 * the inverse, so the area stays) and the point that stays in place; null
 * while nothing squashes or stretches it.
 */
export function sampleStretch(track: StretchTrack, t: number): { readonly height: number; readonly pivot: Vec2 } | null {
  let extra = 0;
  let pivot: Vec2 | null = null;
  for (const k of track.kicks) {
    if (k.at > t) break;
    const tau = t - k.at;
    if (tau >= k.dur) continue;
    // The curve of a bump, stretched to the kick's own length.
    extra += bumpScale((tau * BUMP_SECONDS) / k.dur, k.amount);
    pivot = k.pivot;
  }
  if (pivot === null || Math.abs(extra) < 1e-5) return null;
  return { height: Math.min(STRETCH_MAX, Math.max(STRETCH_MIN, 1 + extra)), pivot };
}

export interface PopSeg {
  readonly kind: 'in' | 'out';
  readonly at: number;
  readonly dur: number;
  readonly overshoot: number;
}

export interface GrowSeg {
  readonly at: number;
  readonly dur: number;
  readonly from: number;
  readonly to: number;
  readonly overshoot: number;
}

export interface ScaleTrack {
  readonly pops: readonly PopSeg[];
  /** Lasting changes of size (scaleTo), each starting from the size reached before it. */
  readonly grows: readonly GrowSeg[];
  readonly bumps: readonly { readonly at: number; readonly amount: number }[];
}

/** The lasting size multiplier at time t: 1 before the first scaleTo. */
function sampleGrow(segs: readonly GrowSeg[], t: number): number {
  let seg: GrowSeg | null = null;
  for (const g of segs) {
    if (t >= g.at) seg = g;
    else break;
  }
  if (!seg) return 1;
  const u = (t - seg.at) / seg.dur;
  if (u >= 1) return seg.to;
  // Sizes are interpolated as ratios, so growing and shrinking overshoot alike
  // and the size can never pass through zero.
  return seg.from * (seg.to / seg.from) ** overshootStep(u, seg.overshoot, 0.5);
}

export function buildScaleTrack(
  id: string,
  ins: readonly PopInKey[],
  outs: readonly PopOutKey[],
  bumps: readonly { at: number; amount: number }[],
  scales: readonly ScaleToKey[] = [],
): ScaleTrack {
  const pops: PopSeg[] = [
    ...ins.map((k): PopSeg => ({ kind: 'in', at: k.at, dur: k.dur, overshoot: k.overshoot })),
    ...outs.map((k): PopSeg => ({ kind: 'out', at: k.at, dur: k.dur, overshoot: 0 })),
  ].sort((a, b) => a.at - b.at);
  let free = -Infinity;
  let prev: PopSeg | null = null;
  for (const p of pops) {
    if (p.at < free - EPS) {
      throw new TrackError(`"${id}": a pop at ${p.at} s starts before the previous one has ended (${free.toFixed(3)} s)`);
    }
    if (prev && prev.kind === p.kind) {
      throw new TrackError(`"${id}": two pop${p.kind === 'in' ? 'In' : 'Out'} keys in a row; popIn and popOut must alternate`);
    }
    prev = p;
    free = p.at + p.dur;
  }
  // A scaleTo starts from the size the node has at that moment, also when the
  // previous one is still under way.
  const grows: GrowSeg[] = [];
  for (const k of scales.slice().sort((a, b) => a.at - b.at)) {
    grows.push({ at: k.at, dur: k.dur, from: sampleGrow(grows, k.at), to: k.to, overshoot: k.overshoot });
  }
  return { pops, grows, bumps: bumps.slice().sort((a, b) => a.at - b.at) };
}

/** The scale multiplier of a node at time t: pops times lasting size times bumps. */
export function sampleScale(track: ScaleTrack, t: number): number {
  let s = 1;
  const first = track.pops[0];
  if (first) {
    let seg: PopSeg | null = null;
    for (const p of track.pops) {
      if (t >= p.at) seg = p;
      else break;
    }
    if (!seg) {
      s = first.kind === 'in' ? 0 : 1;
    } else {
      const u = (t - seg.at) / seg.dur;
      s = seg.kind === 'in' ? (u >= 1 ? 1 : popInScale(u, seg.overshoot)) : u >= 1 ? 0 : popOutScale(u);
    }
  }
  if (s === 0) return 0;
  let extra = 0;
  for (const b of track.bumps) {
    if (b.at > t) break;
    const tau = t - b.at;
    if (tau < BUMP_SECONDS) extra += bumpScale(tau, b.amount);
  }
  return s * sampleGrow(track.grows, t) * (1 + extra);
}

/** The number of a counter over time. */
export interface CountTrack {
  /** The number before the first countTo. */
  readonly base: number;
  readonly segs: readonly { readonly at: number; readonly dur: number; readonly from: number; readonly to: number; readonly profile: Exclude<MoveProfile, 'settle'>; readonly ramp: number; readonly ratio: boolean }[];
}

/** The number of a counter at time t, before it is rounded to the places it shows. */
export function sampleCount(track: CountTrack, t: number): number {
  let seg: CountTrack['segs'][number] | null = null;
  for (const s of track.segs) {
    if (t >= s.at) seg = s;
    else break;
  }
  if (!seg) return track.base;
  const u = (t - seg.at) / seg.dur;
  if (u >= 1) return seg.to;
  const [a, b] = profileRamps(seg.profile, seg.ramp);
  const p = rampProgress(u, a, b);
  return seg.ratio ? seg.from * (seg.to / seg.from) ** p : seg.from + (seg.to - seg.from) * p;
}

/** The track of a counter. Keys chain: each starts from the number reached at its moment. */
export function buildCountTrack(id: string, base: number, keys: readonly CountToKey[]): CountTrack {
  const segs: CountTrack['segs'][number][] = [];
  for (const k of keys.slice().sort((a, b) => a.at - b.at)) {
    const from = sampleCount({ base, segs }, k.at);
    if (k.ratio === true && !(from > 0)) throw new TrackError(`countTo("${id}") at ${k.at} s: with ratio the number runs between values above 0, and it starts from ${from}`);
    segs.push({ at: k.at, dur: k.dur, from, to: k.to, profile: k.profile, ramp: k.ramp, ratio: k.ratio === true });
  }
  return { base, segs };
}

/** One lasting change of size along the node's own axes. */
export interface AxisSeg {
  readonly at: number;
  readonly dur: number;
  readonly from: Vec2;
  readonly to: Vec2;
  readonly overshoot: number;
  /** The point that stays in place during this change, in the node's own units. */
  readonly pivot: Vec2;
  /** What the changes before this one, about other points, have moved the picture by: it does not jump when the pivot changes. */
  readonly shift: Vec2;
}

/** The width and the height of a node as multiples of the authored ones, over time (scaleTo with to: [sx, sy]). */
export interface AxisTrack {
  readonly segs: readonly AxisSeg[];
}

/**
 * The size of a node along its own axes at time t: a point p of the node, in
 * its own units, is drawn at (sx * p.x + cx, sy * p.y + cy). null before the
 * first key, and while the node is as authored.
 */
export function sampleAxis(track: AxisTrack, t: number): { readonly sx: number; readonly sy: number; readonly cx: number; readonly cy: number } | null {
  let seg: AxisSeg | null = null;
  for (const s of track.segs) {
    if (t >= s.at) seg = s;
    else break;
  }
  if (!seg) return null;
  const u = (t - seg.at) / seg.dur;
  // As for an even size: ratios, so that growing and shrinking overshoot alike and no side passes through nothing.
  const p = u >= 1 ? 1 : overshootStep(u, seg.overshoot, 0.5);
  const sx = seg.from[0] * (seg.to[0] / seg.from[0]) ** p;
  const sy = seg.from[1] * (seg.to[1] / seg.from[1]) ** p;
  const cx = (1 - sx) * seg.pivot[0] + seg.shift[0];
  const cy = (1 - sy) * seg.pivot[1] + seg.shift[1];
  if (Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9 && Math.abs(cx) < 1e-9 && Math.abs(cy) < 1e-9) return null;
  return { sx, sy, cx, cy };
}

/** The track of the keys of a node that change its size along its axes. Keys chain: each starts from what is reached at its moment. */
export function buildAxisTrack(keys: readonly ScaleToKey[]): AxisTrack {
  const segs: AxisSeg[] = [];
  for (const k of keys.slice().sort((a, b) => a.at - b.at)) {
    const now = sampleAxis({ segs }, k.at) ?? { sx: 1, sy: 1, cx: 0, cy: 0 };
    const pivot = k.pivot ?? [0, 0];
    // The picture at this moment is (s * p + c). With the new pivot it must be the same picture.
    segs.push({ at: k.at, dur: k.dur, from: [now.sx, now.sy], to: k.axes!, overshoot: k.overshoot, pivot, shift: [now.cx - (1 - now.sx) * pivot[0], now.cy - (1 - now.sy) * pivot[1]] });
  }
  return { segs };
}

export interface FadeSeg {
  readonly at: number;
  readonly dur: number;
  readonly from: number;
  readonly to: number;
}

export interface OpacityTrack {
  /** Opacity before the first fadeTo. */
  readonly base: number;
  readonly segs: readonly FadeSeg[];
}

/** Opacity at time t, 0..1. */
export function sampleOpacity(track: OpacityTrack, t: number): number {
  let seg: FadeSeg | null = null;
  for (const f of track.segs) {
    if (t >= f.at) seg = f;
    else break;
  }
  if (!seg) return track.base;
  const u = (t - seg.at) / seg.dur;
  if (u >= 1) return seg.to;
  return seg.from + (seg.to - seg.from) * ease('inOutSine', u);
}

export function buildOpacityTrack(base: number, keys: readonly FadeToKey[]): OpacityTrack {
  const segs: FadeSeg[] = [];
  for (const k of keys.slice().sort((a, b) => a.at - b.at)) {
    // Like scaleTo, a fade takes over from the opacity reached at that moment.
    segs.push({ at: k.at, dur: k.dur, from: sampleOpacity({ base, segs }, k.at), to: k.to });
  }
  return { base, segs };
}

export interface LidSeg {
  readonly at: number;
  readonly dur: number;
  readonly from: number;
  readonly to: number;
  readonly overshoot: number;
}

/** How far the lids of an eye are open over time. */
export interface LidTrack {
  /** Opening before the first openTo: 0 = shut, 1 = open. */
  readonly base: number;
  readonly segs: readonly LidSeg[];
}

/** Lid opening at time t: 0 = shut; it may pass 1 briefly while an opening overshoots. */
export function sampleLid(track: LidTrack, t: number): number {
  let seg: LidSeg | null = null;
  for (const s of track.segs) {
    if (t >= s.at) seg = s;
    else break;
  }
  if (!seg) return track.base;
  const u = (t - seg.at) / seg.dur;
  if (u >= 1) return seg.to;
  return Math.max(0, seg.from + (seg.to - seg.from) * overshootStep(u, seg.overshoot, 0.5));
}

export function buildLidTrack(base: number, keys: readonly OpenToKey[]): LidTrack {
  const segs: LidSeg[] = [];
  for (const k of keys.slice().sort((a, b) => a.at - b.at)) {
    // Like fadeTo, an openTo takes over from the opening reached at that moment.
    segs.push({ at: k.at, dur: k.dur, from: Math.min(1, sampleLid({ base, segs }, k.at)), to: k.to, overshoot: k.overshoot });
  }
  return { base, segs };
}

export interface TurnSeg {
  readonly at: number;
  readonly dur: number;
  readonly from: number;
  readonly to: number;
  readonly overshoot: number;
}

export interface RotTrack {
  /** Degrees. */
  readonly base: number;
  readonly segs: readonly TurnSeg[];
}

export function buildRotTrack(id: string, base: number, keys: readonly TurnToKey[]): RotTrack {
  const sorted = keys.slice().sort((a, b) => a.at - b.at);
  const segs: TurnSeg[] = [];
  let from = base;
  let free = -Infinity;
  for (const k of sorted) {
    if (k.at < free - EPS) {
      throw new TrackError(`turnTo("${id}") at ${k.at} s starts before the previous turn has ended (${free.toFixed(3)} s)`);
    }
    segs.push({ at: k.at, dur: k.dur, from, to: k.to, overshoot: k.overshoot });
    from = k.to;
    free = k.at + k.dur;
  }
  return { base, segs };
}

/** Rotation in degrees at time t. */
export function sampleRot(track: RotTrack, t: number): number {
  let seg: TurnSeg | null = null;
  for (const s of track.segs) {
    if (t >= s.at) seg = s;
    else break;
  }
  if (!seg) return track.base;
  const u = (t - seg.at) / seg.dur;
  if (u >= 1) return seg.to;
  return seg.from + (seg.to - seg.from) * overshootStep(u, seg.overshoot, 0.5);
}

export interface LinkTrack {
  /** null: the link is fully drawn from the start. */
  readonly drawOn: { readonly at: number; readonly dur: number } | null;
  readonly pulses: readonly { readonly at: number; readonly dur: number }[];
}

export function buildLinkTrack(id: string, draws: readonly DrawOnKey[], pulses: readonly PulseKey[]): LinkTrack {
  if (draws.length > 1) throw new TrackError(`link "${id}" has ${draws.length} drawOn keys; a link is drawn on once`);
  const d = draws[0];
  return {
    drawOn: d ? { at: d.at, dur: d.dur } : null,
    pulses: pulses.map((p) => ({ at: p.at, dur: p.dur })).sort((a, b) => a.at - b.at),
  };
}

/** How much of the link is drawn at time t, 0..1. */
export function sampleReveal(track: LinkTrack, t: number): number {
  if (!track.drawOn) return 1;
  const u = (t - track.drawOn.at) / track.drawOn.dur;
  return u <= 0 ? 0 : u >= 1 ? 1 : ease('inOutCubic', u);
}

/** How much of a stroke is drawn, and how far its dashes are closed, over time. */
export interface StrokeTrack {
  /** The share drawn before the first drawOn. */
  readonly base: number;
  readonly draws: readonly { readonly at: number; readonly dur: number; readonly from: number; readonly to: number; readonly profile: Exclude<MoveProfile, 'settle'>; readonly ramp: number }[];
  /** How far the gaps are closed before the first solidTo. */
  readonly solidBase: number;
  readonly solids: readonly FadeSeg[];
}

/** The share of a stroke that is drawn at time t, 0..1 from its first point. */
export function sampleDrawn(track: StrokeTrack, t: number): number {
  let seg: StrokeTrack['draws'][number] | null = null;
  for (const s of track.draws) {
    if (t >= s.at) seg = s;
    else break;
  }
  if (!seg) return track.base;
  const u = (t - seg.at) / seg.dur;
  if (u >= 1) return seg.to;
  const [a, b] = profileRamps(seg.profile, seg.ramp);
  return seg.from + (seg.to - seg.from) * rampProgress(u, a, b);
}

/** How far the gaps of a dashed stroke are closed at time t: 0 as authored, 1 solid. */
export function sampleSolid(track: StrokeTrack, t: number): number {
  return sampleOpacity({ base: track.solidBase, segs: track.solids }, t);
}

/**
 * The track of a stroke. `drawn` is the share the node says is drawn at the
 * start; left out, a stroke with a drawOn starts undrawn and one without is
 * whole. Keys chain: each starts from what is reached at its moment.
 */
export function buildStrokeTrack(drawn: number | undefined, solid: number, draws: readonly DrawOnKey[], solids: readonly SolidToKey[]): StrokeTrack {
  const base = drawn ?? (draws.length > 0 ? 0 : 1);
  const segs: StrokeTrack['draws'][number][] = [];
  for (const k of draws.slice().sort((a, b) => a.at - b.at)) {
    segs.push({ at: k.at, dur: k.dur, from: sampleDrawn({ base, draws: segs, solidBase: solid, solids: [] }, k.at), to: k.to ?? 1, profile: k.profile ?? 'ease', ramp: k.ramp ?? DEFAULT_RAMP });
  }
  const closes: FadeSeg[] = [];
  for (const k of solids.slice().sort((a, b) => a.at - b.at)) {
    closes.push({ at: k.at, dur: k.dur, from: sampleOpacity({ base: solid, segs: closes }, k.at), to: k.to });
  }
  return { base, draws: segs, solidBase: solid, solids: closes };
}

/** Bumps that pulses give to the node at the far end of their link. */
export function pulseArrivalBumps(pulses: readonly PulseKey[]): BumpKey[] {
  return pulses
    .filter((p) => p.bump > 0)
    .map((p): BumpKey => ({ kind: 'bump', target: '', at: p.at + p.dur, amount: p.bump }));
}
