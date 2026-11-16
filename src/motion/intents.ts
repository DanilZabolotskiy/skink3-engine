// Intents: what should happen, not how. Each function returns a timeline key
// (plain data). The engine turns keys into curves with anticipation, an arc,
// overshoot and settle; see curves.ts and tracks.ts.

import type { Vec2 } from '../core/math.ts';
import { DEFAULT_RAMP, MOVE_PROFILES, profileRamps, settleMoments, type MoveProfile } from './curves.ts';
import { pathLength, type PathSpec } from './paths.ts';
import { MAX_ANTICIPATION_UNITS, MAX_OVERSHOOT_UNITS } from './tracks.ts';

export interface MoveToKey {
  readonly kind: 'moveTo';
  readonly target: string;
  /** Seconds: when the move starts (the anticipation is part of the move). */
  readonly at: number;
  /** Destination in the node's parent space. */
  readonly to: Vec2;
  readonly dur: number;
  /** How far it first backs away, as a fraction of the distance (capped in units). */
  readonly anticipation: number;
  /** How far it shoots past the destination, as a fraction of the distance (capped in units). */
  readonly overshoot: number;
  /** Height of the path's arc as a fraction of the distance; the sign picks the side. */
  readonly arc: number;
  /**
   * How the speed is spread over the move. Left out, it is 'settle': the curve
   * with anticipation and overshoot.
   */
  readonly profile?: MoveProfile;
  /** Share of the duration each eased end takes, for the profiles ease, in and out. */
  readonly ramp?: number;
}

/** A jump: it leaves at `at`, flies a parabola and lands at `at + dur`. */
export interface HopKey {
  readonly kind: 'hop';
  readonly target: string;
  /** Seconds: the take-off. */
  readonly at: number;
  /** Where it lands, in the node's parent space. */
  readonly to: Vec2;
  /** Seconds in the air. */
  readonly dur: number;
  /** How far the top of the flight is above the straight line from take-off to landing, in units. */
  readonly height: number;
}

/** Travel along a free-form path. */
export interface TravelKey {
  readonly kind: 'travel';
  readonly target: string;
  readonly at: number;
  readonly path: PathSpec;
  readonly dur: number;
  /** How many times round a closed path. */
  readonly loops: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
  /** Radius of the wheel the node turns as while it travels (it rolls along the path), or null. */
  readonly roll: number | null;
  /** The node turns to face along the path. */
  readonly orient: boolean;
  /** The node is drawn only while it travels. */
  readonly only: boolean;
}

export interface PopInKey {
  readonly kind: 'popIn';
  readonly target: string;
  readonly at: number;
  readonly dur: number;
  /** How far the scale shoots past 1 (0.18 = 118 %). */
  readonly overshoot: number;
}

export interface PopOutKey {
  readonly kind: 'popOut';
  readonly target: string;
  readonly at: number;
  readonly dur: number;
}

export interface TurnToKey {
  readonly kind: 'turnTo';
  readonly target: string;
  readonly at: number;
  /** Absolute rotation in degrees. */
  readonly to: number;
  readonly dur: number;
  readonly overshoot: number;
}

export interface BumpKey {
  readonly kind: 'bump';
  readonly target: string;
  readonly at: number;
  /** Peak extra scale (0.15 = swells to about 115 %, then settles). */
  readonly amount: number;
}

/** A quick squash or stretch that rings out: the picture gets wider and lower, or taller and narrower, and keeps its area. */
export interface SquashKey {
  readonly kind: 'squash';
  readonly target: string;
  readonly at: number;
  /** Peak change of the height: -0.25 squashes to about 75 % of the height, 0.25 stretches to about 125 %. */
  readonly amount: number;
  /** Seconds until it has rung out. */
  readonly dur: number;
  /** The point that stays in place, in the node's own units (for a landing: its lowest point). */
  readonly pivot: Vec2;
}

export interface DrawOnKey {
  readonly kind: 'drawOn';
  readonly target: string;
  readonly at: number;
  readonly dur: number;
}

export interface PulseKey {
  readonly kind: 'pulse';
  readonly target: string;
  readonly at: number;
  readonly dur: number;
  /** Bump given to the node at the far end when the pulse arrives (0 = none). */
  readonly bump: number;
}

export interface ScaleToKey {
  readonly kind: 'scaleTo';
  readonly target: string;
  readonly at: number;
  /** New size as a multiple of the node's authored size (1 = as authored). */
  readonly to: number;
  readonly dur: number;
  /** How far it shoots past the new size, as a fraction of the change. */
  readonly overshoot: number;
}

export interface FadeToKey {
  readonly kind: 'fadeTo';
  readonly target: string;
  readonly at: number;
  /** New opacity, 0..1. */
  readonly to: number;
  readonly dur: number;
}

/** Raise or lower the level of a shape that has one. */
export interface LevelToKey {
  readonly kind: 'levelTo';
  readonly target: string;
  readonly at: number;
  /** New level: 0 = empty, 1 = full. */
  readonly to: number;
  readonly dur: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
}

export interface OpenToKey {
  readonly kind: 'openTo';
  readonly target: string;
  readonly at: number;
  /** New lid opening: 0 = shut, 1 = open. */
  readonly to: number;
  readonly dur: number;
  /** How far the lids shoot past the new opening, as a fraction of the change. */
  readonly overshoot: number;
}

export interface BlinkKey {
  readonly kind: 'blink';
  readonly target: string;
  readonly at: number;
}

export type Key =
  | MoveToKey
  | HopKey
  | TravelKey
  | PopInKey
  | PopOutKey
  | TurnToKey
  | ScaleToKey
  | FadeToKey
  | LevelToKey
  | BumpKey
  | SquashKey
  | DrawOnKey
  | PulseKey
  | OpenToKey
  | BlinkKey;

export class IntentError extends Error {}

function num(where: string, name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new IntentError(`${where}: ${name} must be a number in ${min}..${max}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function target(where: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new IntentError(`${where}: the first argument is the id of the node to animate`);
  }
  return value;
}

function point(where: string, name: string, value: unknown): Vec2 {
  if (!Array.isArray(value) || value.length !== 2) throw new IntentError(`${where}: ${name} must be [x, y]`);
  return [num(where, `${name}[0]`, value[0], -1e6, 1e6), num(where, `${name}[1]`, value[1], -1e6, 1e6)];
}

function only(where: string, opts: object, allowed: readonly string[]): void {
  for (const key of Object.keys(opts)) {
    if (!allowed.includes(key)) throw new IntentError(`${where}: unknown option "${key}" (allowed: ${allowed.join(', ')})`);
  }
}

/** A key may start this long before the shot does: what it does is then already under way, or over, at frame 0. */
const MIN_T = -600;
const MAX_T = 3600;

function profileOf<P extends MoveProfile>(where: string, value: unknown, allowed: readonly P[], fallback: P): P {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new IntentError(`${where}: profile must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`);
  }
  return value as P;
}

const RAMPED: readonly Exclude<MoveProfile, 'settle'>[] = ['ease', 'steady', 'in', 'out'];

/**
 * The moments of a move, in seconds after its `at`: when it leaves its place
 * (after the anticipation, if it has one), and when it first reaches its
 * destination. With the profile settle the rest of the duration is overshoot
 * and settle; every other profile, and a hop, arrives at the very end.
 *
 *   const { arrives } = moveTimes({ dur: 1.2 });   // the defaults of moveTo
 *   moveTo('ball', { at: word - arrives, to: [200, 0], dur: 1.2 })
 */
export function moveTimes(
  opts: { dur?: number; profile?: MoveProfile; anticipation?: number; overshoot?: number; /** Length of the move in units: a long move backs away and overshoots by fewer units than its fractions say. */ distance?: number } = {},
): { leaves: number; arrives: number } {
  const dur = opts.dur ?? 1.1;
  const profile = opts.profile ?? 'settle';
  if (profile !== 'settle') return { leaves: 0, arrives: dur };
  let anticipation = opts.anticipation ?? 0.08;
  let overshoot = opts.overshoot ?? 0.07;
  if (opts.distance !== undefined && opts.distance > 1e-9) {
    anticipation = Math.min(anticipation, MAX_ANTICIPATION_UNITS / opts.distance);
    overshoot = Math.min(overshoot, MAX_OVERSHOOT_UNITS / opts.distance);
  }
  const m = settleMoments(anticipation, overshoot);
  return { leaves: m.leaves * dur, arrives: m.arrives * dur };
}

/**
 * Move a node to a place. By default (profile "settle") the engine adds a short
 * anticipation, a curved path, an overshoot and a settle. The other profiles
 * spread the speed plainly over the duration and arrive exactly at its end:
 * "ease" from rest to rest, "steady" at one speed, "in" from rest and away at
 * speed, "out" in at speed and down to rest. The move starts from wherever the
 * node is. Give either `at`, the start, or `arrive`, the moment it first
 * reaches the destination.
 */
export function moveTo(
  id: string,
  opts: {
    at?: number;
    arrive?: number;
    to: Vec2;
    dur?: number;
    anticipation?: number;
    overshoot?: number;
    arc?: number;
    profile?: MoveProfile;
    ramp?: number;
  },
): MoveToKey {
  const w = `moveTo("${id}")`;
  if (!Array.isArray(opts.to) || opts.to.length !== 2) throw new IntentError(`${w}: to must be [x, y]`);
  const profile = profileOf(w, opts.profile, MOVE_PROFILES, 'settle');
  const settle = profile === 'settle';
  if (!settle && ((opts.anticipation ?? 0) !== 0 || (opts.overshoot ?? 0) !== 0)) {
    throw new IntentError(`${w}: anticipation and overshoot belong to the profile "settle"; the profile "${profile}" has neither`);
  }
  if (opts.ramp !== undefined && (settle || profile === 'steady')) {
    throw new IntentError(`${w}: ramp applies to the profiles ease, in and out`);
  }
  const dur = num(w, 'dur', opts.dur ?? 1.1, 0.1, 60);
  const anticipation = settle ? num(w, 'anticipation', opts.anticipation ?? 0.08, 0, 0.4) : 0;
  const overshoot = settle ? num(w, 'overshoot', opts.overshoot ?? 0.07, 0, 0.4) : 0;
  if ((opts.at === undefined) === (opts.arrive === undefined)) {
    throw new IntentError(`${w}: give either at (when the move starts) or arrive (when it first reaches its destination)`);
  }
  const at =
    opts.at !== undefined
      ? num(w, 'at', opts.at, MIN_T, MAX_T)
      : num(w, 'arrive', opts.arrive, MIN_T, MAX_T) - moveTimes({ dur, profile, anticipation, overshoot }).arrives;
  return {
    kind: 'moveTo',
    target: target(w, id),
    at: num(w, 'at', at, MIN_T, MAX_T),
    to: [num(w, 'to[0]', opts.to[0], -1e6, 1e6), num(w, 'to[1]', opts.to[1], -1e6, 1e6)],
    dur,
    anticipation,
    overshoot,
    arc: num(w, 'arc', opts.arc ?? 0.12, -1, 1),
    // A settle move carries no profile: its key is what it always was.
    ...(settle ? {} : { profile, ramp: num(w, 'ramp', opts.ramp ?? DEFAULT_RAMP, 0.02, 0.5) }),
  };
}

/**
 * A jump from wherever the node is to `to`: it leaves at `at`, flies a parabola
 * `height` units high and lands at `at + dur`, so both moments are known
 * exactly. Sideways it travels at one speed; the height follows gravity. Give
 * either `at`, the take-off, or `land`, the landing.
 */
export function hop(id: string, opts: { at?: number; land?: number; to: Vec2; dur?: number; height?: number }): HopKey {
  const w = `hop("${id}")`;
  only(w, opts, ['at', 'land', 'to', 'dur', 'height']);
  const dur = num(w, 'dur', opts.dur ?? 0.6, 0.1, 30);
  if ((opts.at === undefined) === (opts.land === undefined)) throw new IntentError(`${w}: give either at (the take-off) or land (the landing)`);
  const at = opts.at !== undefined ? opts.at : num(w, 'land', opts.land, MIN_T, MAX_T) - dur;
  return {
    kind: 'hop',
    target: target(w, id),
    at: num(w, 'at', at, MIN_T, MAX_T),
    to: point(w, 'to', opts.to),
    dur,
    height: num(w, 'height', opts.height ?? 80, 0, 4000),
  };
}

/**
 * Travel along a free-form path at a known speed. `path` is the list of points
 * the node passes through, the first being where it starts; the engine joins
 * them with a smooth curve and measures it, so the speed along it is exactly
 * what the profile says. Give `speed` (units per second on the steady stretch)
 * or `dur` (seconds for the whole path).
 */
export function travel(
  id: string,
  opts: {
    at: number;
    path: readonly Vec2[];
    speed?: number;
    dur?: number;
    profile?: Exclude<MoveProfile, 'settle'>;
    ramp?: number;
    /** 0 = straight lines between the points, 1 = a smooth curve through them; default 1. */
    smooth?: number;
    /** After the last point, back to the first. */
    closed?: boolean;
    /** Times round a closed path; default 1. */
    loops?: number;
    /** The node turns as a wheel of this radius that rolls along the path. */
    roll?: number;
    /** The node turns to face along the path. */
    orient?: boolean;
    /** The node is drawn only while it travels: hidden before `at` and after it arrives. */
    only?: boolean;
  },
): TravelKey {
  const w = `travel("${id}")`;
  only(w, opts, ['at', 'path', 'speed', 'dur', 'profile', 'ramp', 'smooth', 'closed', 'loops', 'roll', 'orient', 'only']);
  if (!Array.isArray(opts.path) || opts.path.length < 2) throw new IntentError(`${w}: path must be a list of at least two points [x, y]`);
  const closed = opts.closed ?? false;
  if (closed && opts.path.length < 3) throw new IntentError(`${w}: a closed path needs at least three points`);
  const path: PathSpec = {
    points: opts.path.map((p, i) => point(w, `path[${i}]`, p)),
    closed,
    smooth: num(w, 'smooth', opts.smooth ?? 1, 0, 1),
  };
  const loops = num(w, 'loops', opts.loops ?? 1, 1, 1000);
  if (!closed && loops !== 1) throw new IntentError(`${w}: loops needs closed: true`);
  const length = pathLength(path) * loops;
  if (!(length > 1e-6)) throw new IntentError(`${w}: the path has no length`);
  const profile = profileOf(w, opts.profile, RAMPED, 'steady');
  if (opts.ramp !== undefined && profile === 'steady') throw new IntentError(`${w}: ramp applies to the profiles ease, in and out`);
  const ramp = num(w, 'ramp', opts.ramp ?? DEFAULT_RAMP, 0.02, 0.5);
  if ((opts.speed === undefined) === (opts.dur === undefined)) throw new IntentError(`${w}: give either speed (units per second) or dur (seconds)`);
  const [a, b] = profileRamps(profile, ramp);
  // `speed` is the speed of the steady stretch; the eased ends cover less ground in their time.
  const dur = opts.dur !== undefined ? opts.dur : length / (num(w, 'speed', opts.speed, 1e-3, 1e5) * (1 - (a + b) / 2));
  if (opts.roll !== undefined && opts.orient) throw new IntentError(`${w}: use either roll or orient, not both`);
  return {
    kind: 'travel',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    path,
    dur: num(w, 'dur', dur, 0.05, 3600),
    loops,
    profile,
    ramp,
    roll: opts.roll === undefined ? null : num(w, 'roll', opts.roll, 0.5, 1e5),
    orient: opts.orient ?? false,
    only: opts.only ?? false,
  };
}

/** Make a node appear: it grows from nothing, overshoots its size and settles. Hidden before `at`. */
export function popIn(id: string, opts: { at: number; dur?: number; overshoot?: number }): PopInKey {
  const w = `popIn("${id}")`;
  return {
    kind: 'popIn',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    dur: num(w, 'dur', opts.dur ?? 0.55, 0.05, 10),
    overshoot: num(w, 'overshoot', opts.overshoot ?? 0.18, 0, 0.5),
  };
}

/** Make a node disappear: a small swell, then it shrinks to nothing. */
export function popOut(id: string, opts: { at: number; dur?: number }): PopOutKey {
  const w = `popOut("${id}")`;
  return {
    kind: 'popOut',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    dur: num(w, 'dur', opts.dur ?? 0.35, 0.05, 10),
  };
}

/** Turn a node to an absolute rotation (degrees), with overshoot and settle. */
export function turnTo(id: string, opts: { at: number; to: number; dur?: number; overshoot?: number }): TurnToKey {
  const w = `turnTo("${id}")`;
  return {
    kind: 'turnTo',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    to: num(w, 'to', opts.to, -1e5, 1e5),
    dur: num(w, 'dur', opts.dur ?? 0.8, 0.05, 60),
    overshoot: num(w, 'overshoot', opts.overshoot ?? 0.1, 0, 0.5),
  };
}

/**
 * Change a node's size for good: it grows (or shrinks) to `to` times its
 * authored size, overshoots and settles. Several keys chain: each starts from
 * the size the node has at that moment. Pops and bumps play on top of it.
 */
export function scaleTo(id: string, opts: { at: number; to: number; dur?: number; overshoot?: number }): ScaleToKey {
  const w = `scaleTo("${id}")`;
  return {
    kind: 'scaleTo',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    to: num(w, 'to', opts.to, 0.01, 100),
    dur: num(w, 'dur', opts.dur ?? 0.6, 0.05, 60),
    overshoot: num(w, 'overshoot', opts.overshoot ?? 0.15, 0, 0.5),
  };
}

/**
 * Fade a node to an opacity (0..1). A node and everything in it fade as one
 * picture, with its light and its glow. Several keys chain from the opacity the
 * node has at that moment.
 */
export function fadeTo(id: string, opts: { at: number; to: number; dur?: number }): FadeToKey {
  const w = `fadeTo("${id}")`;
  return {
    kind: 'fadeTo',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    to: num(w, 'to', opts.to, 0, 1),
    dur: num(w, 'dur', opts.dur ?? 0.5, 0.05, 60),
  };
}

/**
 * Raise or lower the level of a shape that has one (see `level` of the shape
 * options): 0 is empty, 1 is full. The level arrives exactly at `at + dur`.
 * Several keys chain from the level reached at that moment.
 */
export function levelTo(
  id: string,
  opts: { at: number; to: number; dur?: number; profile?: Exclude<MoveProfile, 'settle'>; ramp?: number },
): LevelToKey {
  const w = `levelTo("${id}")`;
  only(w, opts, ['at', 'to', 'dur', 'profile', 'ramp']);
  const profile = profileOf(w, opts.profile, RAMPED, 'ease');
  if (opts.ramp !== undefined && profile === 'steady') throw new IntentError(`${w}: ramp applies to the profiles ease, in and out`);
  return {
    kind: 'levelTo',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    to: num(w, 'to', opts.to, 0, 1),
    dur: num(w, 'dur', opts.dur ?? 1.5, 0.05, 3600),
    profile,
    ramp: num(w, 'ramp', opts.ramp ?? DEFAULT_RAMP, 0.02, 0.5),
  };
}

/**
 * Open or close the lids of an eye: `to` 1 is open, 0 is shut (a shut eye is
 * not drawn). The change lasts; several keys chain from the opening the eye
 * has at that moment. With an overshoot the eye opens a little too wide first.
 */
export function openTo(eyeId: string, opts: { at: number; to: number; dur?: number; overshoot?: number }): OpenToKey {
  const w = `openTo("${eyeId}")`;
  return {
    kind: 'openTo',
    target: target(w, eyeId),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    to: num(w, 'to', opts.to, 0, 1),
    dur: num(w, 'dur', opts.dur ?? 0.3, 0.03, 60),
    overshoot: num(w, 'overshoot', opts.overshoot ?? 0.12, 0, 0.5),
  };
}

/** Make an eye blink at a chosen moment, in addition to its own schedule. */
export function blink(eyeId: string, opts: { at: number }): BlinkKey {
  const w = `blink("${eyeId}")`;
  return { kind: 'blink', target: target(w, eyeId), at: num(w, 'at', opts.at, MIN_T, MAX_T) };
}

/** A quick swell-and-settle of a node's scale: a reaction, a beat. */
export function bump(id: string, opts: { at: number; amount?: number }): BumpKey {
  const w = `bump("${id}")`;
  return {
    kind: 'bump',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    amount: num(w, 'amount', opts.amount ?? 0.14, -0.5, 0.5),
  };
}

/**
 * A quick squash (a negative amount) or stretch (a positive one) that rings
 * out: the node and everything in it get lower and wider, or taller and
 * narrower, and keep their area. `pivot` is the point that stays in place, in
 * the node's own units: for a landing its lowest point, so that it squashes
 * against the ground. It is a look only, like a bump.
 */
export function squash(id: string, opts: { at: number; amount?: number; dur?: number; pivot?: Vec2 }): SquashKey {
  const w = `squash("${id}")`;
  only(w, opts, ['at', 'amount', 'dur', 'pivot']);
  return {
    kind: 'squash',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    amount: num(w, 'amount', opts.amount ?? -0.22, -0.6, 0.6),
    dur: num(w, 'dur', opts.dur ?? 0.6, 0.1, 5),
    pivot: opts.pivot === undefined ? [0, 0] : point(w, 'pivot', opts.pivot),
  };
}

/** Draw a link on from its `from` end. The link is hidden before `at`. */
export function drawOn(linkId: string, opts: { at: number; dur?: number }): DrawOnKey {
  const w = `drawOn("${linkId}")`;
  return {
    kind: 'drawOn',
    target: target(w, linkId),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    dur: num(w, 'dur', opts.dur ?? 0.6, 0.05, 30),
  };
}

/** Send a glowing pulse along a link, from its `from` end to its `to` end. */
export function pulse(linkId: string, opts: { at: number; dur?: number; bump?: number }): PulseKey {
  const w = `pulse("${linkId}")`;
  return {
    kind: 'pulse',
    target: target(w, linkId),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    dur: num(w, 'dur', opts.dur ?? 0.7, 0.05, 30),
    bump: num(w, 'bump', opts.bump ?? 0.14, 0, 0.5),
  };
}

export type StaggerOrder = 'forward' | 'reverse' | 'center-out' | 'edges-in';

/**
 * The same intent for a group of nodes, each a little later than the previous
 * one. `make` receives the node id, its start time and its index.
 *
 *   stagger(['a', 'b', 'c'], { at: 1, each: 0.08 }, (id, at) => popIn(id, { at }))
 */
export function stagger(
  ids: readonly string[],
  opts: { at: number; each: number; order?: StaggerOrder },
  make: (id: string, at: number, index: number) => Key | readonly Key[],
): Key[] {
  const w = 'stagger';
  const at = num(w, 'at', opts.at, MIN_T, MAX_T);
  const each = num(w, 'each', opts.each, 0, 60);
  const n = ids.length;
  const rank = (i: number): number => {
    switch (opts.order ?? 'forward') {
      case 'forward': return i;
      case 'reverse': return n - 1 - i;
      case 'center-out': return Math.abs(i - (n - 1) / 2);
      case 'edges-in': return (n - 1) / 2 - Math.abs(i - (n - 1) / 2);
      default: throw new IntentError(`${w}: unknown order ${JSON.stringify(opts.order)}`);
    }
  };
  const out: Key[] = [];
  ids.forEach((id, i) => {
    const made = make(id, at + rank(i) * each, i);
    if (Array.isArray(made)) out.push(...(made as readonly Key[]));
    else out.push(made as Key);
  });
  return out;
}
