// Intents: what should happen, not how. Each function returns a timeline key
// (plain data). The engine turns keys into curves with anticipation, an arc,
// overshoot and settle; see curves.ts and tracks.ts.

import type { Vec2, Vec3 } from '../core/math.ts';
import { FPS } from '../core/time.ts';
import { DEFAULT_RAMP, MOVE_PROFILES, profileRamps, settleMoments, speedDistance, speedDuration, type MoveProfile, type SpeedKeys } from './curves.ts';
import { pathLength, type PathSpec } from './paths.ts';
import { MAX_ANTICIPATION_UNITS, MAX_OVERSHOOT_UNITS } from './tracks.ts';

/**
 * What an intent says about its sound. Left out, its events sound as the bank
 * of sounds decides; false mutes everything the intent does; a key names the
 * sound of the event at its start. It never changes the picture or the bake.
 */
export interface Voiced {
  readonly sound?: string | false;
}

export interface MoveToKey extends Voiced {
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
  /** In a perspective layer: how far away the destination is. Left out: as far as the node is. */
  readonly z?: number;
}

/** A jump: it leaves at `at`, flies a parabola and lands at `at + dur`. */
export interface HopKey extends Voiced {
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
export interface TravelKey extends Voiced {
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
  /**
   * A speed that changes on the way: [seconds after the start, units per second], joined smoothly. Left out: one
   * speed with the eased ends of the profile.
   */
  readonly speeds?: SpeedKeys;
}

export interface PopInKey extends Voiced {
  readonly kind: 'popIn';
  readonly target: string;
  readonly at: number;
  readonly dur: number;
  /** How far the scale shoots past 1 (0.18 = 118 %). */
  readonly overshoot: number;
}

export interface PopOutKey extends Voiced {
  readonly kind: 'popOut';
  readonly target: string;
  readonly at: number;
  readonly dur: number;
}

export interface TurnToKey extends Voiced {
  readonly kind: 'turnTo';
  readonly target: string;
  readonly at: number;
  /** Absolute rotation in degrees. 0 in a key that has `by`. */
  readonly to: number;
  readonly dur: number;
  readonly overshoot: number;
  /**
   * How the speed of the turn is spread over its duration: 'ease', 'steady',
   * 'in' or 'out', without an overshoot. Left out: the turn that shoots past
   * its angle and settles.
   */
  readonly profile?: Exclude<MoveProfile, 'settle'>;
  readonly ramp?: number;
  /** Degrees to turn by from wherever the node is, instead of to an absolute angle (a key made with `speed` or with `speeds`). */
  readonly by?: number;
  /**
   * A speed that changes over the turn: [seconds after the start, degrees per second], joined smoothly; after the
   * last key it stays. Left out: a turn to an angle, or at one speed with the eased ends of its profile.
   */
  readonly speeds?: SpeedKeys;
  /**
   * A hinge: the turn is about this axis of a group that lies in a plane of a
   * perspective layer, through its origin, out of the plane. Left out: the
   * turn in its own plane, as ever.
   */
  readonly about?: 'x' | 'y';
}

export interface BumpKey extends Voiced {
  readonly kind: 'bump';
  readonly target: string;
  readonly at: number;
  /** Peak extra scale (0.15 = swells to about 115 %, then settles). */
  readonly amount: number;
}

/** A quick squash or stretch that rings out: the picture gets wider and lower, or taller and narrower, and keeps its area. */
export interface SquashKey extends Voiced {
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

export interface DrawOnKey extends Voiced {
  readonly kind: 'drawOn';
  readonly target: string;
  readonly at: number;
  readonly dur: number;
  /** Strokes: the share of the line, from its first point, that is drawn when the key ends. Left out: all of it. */
  readonly to?: number;
  /** Strokes: how the speed of the drawing is spread; left out, 'ease'. */
  readonly profile?: Exclude<MoveProfile, 'settle'>;
  readonly ramp?: number;
}

/** Close or open the gaps of a dashed stroke: at 1 the line is solid, at 0 dashed as authored. */
export interface SolidToKey extends Voiced {
  readonly kind: 'solidTo';
  readonly target: string;
  readonly at: number;
  readonly to: number;
  readonly dur: number;
}

/** Change the bend of a link: it sags, pulls taut, swings. */
export interface BendToKey extends Voiced {
  readonly kind: 'bendTo';
  readonly target: string;
  readonly at: number;
  /** The new bend: the sideways bulge as a fraction of the link's length; 0 is a straight, taut line. */
  readonly to: number;
  readonly dur: number;
  /** How far it swings past the new bend, as a fraction of the change. */
  readonly overshoot: number;
}

/** Change the width of a link or of a stroke, where the line lies: it grows thick, or thins. */
export interface WidthToKey extends Voiced {
  readonly kind: 'widthTo';
  readonly target: string;
  readonly at: number;
  /** The new width, in units. */
  readonly to: number;
  readonly dur: number;
  /** How far it shoots past the new width, as a fraction of the change. */
  readonly overshoot: number;
}

export interface PulseKey extends Voiced {
  readonly kind: 'pulse';
  readonly target: string;
  readonly at: number;
  readonly dur: number;
  /** Bump given to the node at the far end when the pulse arrives (0 = none). On a stroke: to the node the key names. */
  readonly bump: number;
  /** A stroke: the shares of its length between which the light runs. Left out: from its first point (0) to its last (1). */
  readonly from?: number;
  readonly to?: number;
  /** A stroke: how the speed of the light is spread. Left out: as a pulse on a link goes. */
  readonly profile?: Exclude<MoveProfile, 'settle'>;
  readonly ramp?: number;
  /** A stroke: the length of the light, in units of the stroke. Left out: a quarter of its way, at most 120 units. */
  readonly length?: number;
  /** A stroke: the node that gets the bump when the light arrives. */
  readonly node?: string;
}

export interface ScaleToKey extends Voiced {
  readonly kind: 'scaleTo';
  readonly target: string;
  readonly at: number;
  /** New size as a multiple of the node's authored size (1 = as authored). 1 in a key that has `axes`. */
  readonly to: number;
  readonly dur: number;
  /** How far it shoots past the new size, as a fraction of the change. 0 in a key that has a `profile`. */
  readonly overshoot: number;
  /**
   * How the speed of the change is spread over its duration: 'ease', 'steady',
   * 'in' or 'out', without an overshoot, the size running evenly between its
   * two values. Left out: the change that shoots past the size and settles.
   */
  readonly profile?: Exclude<MoveProfile, 'settle'>;
  readonly ramp?: number;
  /**
   * A change along the node's own axes instead: its width and its height as
   * multiples of the authored ones. Left out in a key that changes the size evenly.
   */
  readonly axes?: Vec2;
  /** With `axes`: the point that stays in place, in the node's own units. Left out: its origin. */
  readonly pivot?: Vec2;
}

export interface FadeToKey extends Voiced {
  readonly kind: 'fadeTo';
  readonly target: string;
  readonly at: number;
  /** New opacity, 0..1. */
  readonly to: number;
  readonly dur: number;
}

/** Raise or lower the level of a shape that has one. */
export interface LevelToKey extends Voiced {
  readonly kind: 'levelTo';
  readonly target: string;
  readonly at: number;
  /** New level: 0 = empty, 1 = full. */
  readonly to: number;
  readonly dur: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
}

export interface OpenToKey extends Voiced {
  readonly kind: 'openTo';
  readonly target: string;
  readonly at: number;
  /** New lid opening: 0 = shut, 1 = open. */
  readonly to: number;
  readonly dur: number;
  /** How far the lids shoot past the new opening, as a fraction of the change. */
  readonly overshoot: number;
}

export interface BlinkKey extends Voiced {
  readonly kind: 'blink';
  readonly target: string;
  readonly at: number;
}

/** Run the number of a counter to a value. */
export interface CountToKey extends Voiced {
  readonly kind: 'countTo';
  readonly target: string;
  readonly at: number;
  readonly to: number;
  readonly dur: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
  /** The number grows as a ratio, by digits at an even pace, instead of by equal steps. Left out: equal steps. */
  readonly ratio?: boolean;
}

/**
 * A move of the camera at a moment: to a zoom, to a place, or both. It has no
 * node: it is a key of the timeline that the camera reads.
 */
export interface CameraToKey extends Voiced {
  readonly kind: 'cameraTo';
  /** A camera key has no node. */
  readonly target: null;
  readonly at: number;
  readonly dur: number;
  /** The zoom the camera has when the key ends, as a factor of the authored view. Left out: the zoom it has. */
  readonly zoom?: number;
  /** Where the camera looks when the key ends, in units of the focus plane. Left out: where it looks when the key starts. */
  readonly to?: Vec2;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
}

/**
 * A change of the camera's zoom at a moment, and of nothing else: where the
 * camera looks stays with its drift, its path and its wander, which run on
 * under the key. It has no node: it is a key of the timeline that the camera
 * reads.
 */
export interface ZoomToKey extends Voiced {
  readonly kind: 'zoomTo';
  /** A zoom key has no node. */
  readonly target: null;
  readonly at: number;
  readonly dur: number;
  /** The zoom the zoom keys give when this one ends, as a factor of the authored view. */
  readonly to: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
}

/** Change the outline of a region, or the line of a stroke, into another: every point runs to a new place. */
export interface ReshapeKey extends Voiced {
  readonly kind: 'reshape';
  readonly target: string;
  readonly at: number;
  readonly dur: number;
  /** The new outline: as many points as the node has, each where the point of the same place in the list goes. */
  readonly points: readonly Vec2[];
  /** The smoothing of the outline when the key ends, 0..1. Left out: as it is. */
  readonly smooth?: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
}

/**
 * A change of the background of the shot at a moment: its gradient, the colour
 * far layers fade toward, and its vignette. It has no node: it is a key of the
 * timeline that the background reads. What a key leaves out stays as it is.
 */
export interface BackgroundToKey extends Voiced {
  readonly kind: 'backgroundTo';
  /** A background key has no node. */
  readonly target: null;
  readonly at: number;
  readonly dur: number;
  /** Palette references: the colours of the gradient at its centre and at its edge when the key ends. */
  readonly inner?: string;
  readonly outer?: string;
  /** The centre of the gradient as fractions of the frame, and its radius in frame widths, when the key ends. */
  readonly center?: Vec2;
  readonly radius?: number;
  /** Palette reference: the colour far layers fade toward when the key ends. */
  readonly atmosphere?: string;
  /** How far the corners darken toward the outer colour when the key ends, 0..1. */
  readonly vignette?: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
}

/**
 * A node that follows a computed function of time. The key holds no function:
 * it holds what the function gave at `count` moments, evenly spaced from `at`
 * to `at + dur`, and the engine plays those samples back. Each channel is
 * there only when the key drives it.
 */
export interface DriveKey extends Voiced {
  readonly kind: 'drive';
  readonly target: string;
  readonly at: number;
  readonly dur: number;
  readonly count: number;
  /** The place at every sample, one after another: x, y, and z when `placeDims` is 3. */
  readonly place?: readonly number[];
  readonly placeDims?: 2 | 3;
  /** Degrees. */
  readonly rotation?: readonly number[];
  /** A factor of the authored size. */
  readonly scale?: readonly number[];
  readonly opacity?: readonly number[];
  /** The draw order inside the layer: what has the larger depth is drawn first. */
  readonly depth?: readonly number[];
  /** The outline of a region, or the line of a stroke, at every sample: its points one after another, `pointDims` numbers each. */
  readonly points?: readonly (readonly number[])[];
  readonly pointDims?: 2 | 3;
}

/**
 * A move of the camera of a perspective layer. It has no node: it is a key of
 * the timeline that the layer reads. What a key leaves out stays as it is.
 */
export interface PerspectiveToKey extends Voiced {
  readonly kind: 'perspectiveTo';
  /** A key of a layer's camera has no node. */
  readonly target: null;
  readonly layer: string;
  readonly at: number;
  readonly dur: number;
  readonly aim?: Vec3;
  readonly distance?: number;
  readonly tilt?: number;
  readonly turn?: number;
  readonly lens?: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
}

/** A sound placed at a moment by hand: on a word, on a cut. It always sounds. */
export interface SfxKey {
  readonly kind: 'sfx';
  /** The node the sound comes from (it is panned to where the node is), or null: the middle of the frame. */
  readonly target: string | null;
  readonly at: number;
  /** Key of the sound in the bank. */
  readonly sound: string;
  /** Multiplies the gain the bank gives the sound. */
  readonly gain: number;
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
  | SolidToKey
  | BendToKey
  | WidthToKey
  | PulseKey
  | OpenToKey
  | BlinkKey
  | CountToKey
  | CameraToKey
  | ZoomToKey
  | BackgroundToKey
  | ReshapeKey
  | DriveKey
  | PerspectiveToKey
  | SfxKey;

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

/**
 * Refuses an option an intent does not take. A misspelt option, or one that
 * belongs to another intent, would otherwise be dropped without a word and
 * the picture would quietly differ from what was asked.
 */
function only(where: string, opts: object, allowed: readonly string[]): void {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) throw new IntentError(`${where}: the second argument is an options object, e.g. { at: 1 }`);
  for (const key of Object.keys(opts)) {
    if (!allowed.includes(key)) throw new IntentError(`${where}: unknown option "${key}" (allowed: ${allowed.join(', ')})`);
  }
}

/** Sound keys look like string keys: lower-case parts joined by ".", "_" or "-", e.g. "marble" or "glass.small". */
export const SOUND_KEY = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/;

export function isSoundKey(value: unknown): value is string {
  return typeof value === 'string' && SOUND_KEY.test(value);
}

/** The sound option of an intent, as it is written into its key: nothing when it is left out. */
function voiced(where: string, opts: { sound?: string | false }): Voiced {
  if (opts.sound === undefined) return {};
  if (opts.sound !== false && !isSoundKey(opts.sound)) {
    throw new IntentError(
      `${where}: sound must be false (the intent is silent) or the key of a sound such as "marble" or "glass.small", got ${JSON.stringify(opts.sound)}`,
    );
  }
  return { sound: opts.sound };
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
 * (after the anticipation, if it has one), when it first reaches its
 * destination, and when it is farthest past it. With the profile settle the
 * rest of the duration is settling; every other profile, and a hop, arrives at
 * the very end and does not pass its destination.
 *
 *   const { arrives } = moveTimes({ dur: 1.2 });   // the defaults of moveTo
 *   moveTo('ball', { at: word - arrives, to: [200, 0], dur: 1.2 })
 */
export function moveTimes(
  opts: { dur?: number; profile?: MoveProfile; anticipation?: number; overshoot?: number; /** Length of the move in units: a long move backs away and overshoots by fewer units than its fractions say. */ distance?: number } = {},
): { leaves: number; arrives: number; peaks: number } {
  const dur = opts.dur ?? 1.1;
  const profile = opts.profile ?? 'settle';
  if (profile !== 'settle') return { leaves: 0, arrives: dur, peaks: dur };
  let anticipation = opts.anticipation ?? 0.08;
  let overshoot = opts.overshoot ?? 0.07;
  if (opts.distance !== undefined && opts.distance > 1e-9) {
    anticipation = Math.min(anticipation, MAX_ANTICIPATION_UNITS / opts.distance);
    overshoot = Math.min(overshoot, MAX_OVERSHOOT_UNITS / opts.distance);
  }
  const m = settleMoments(anticipation, overshoot);
  return { leaves: m.leaves * dur, arrives: m.arrives * dur, peaks: m.peaks * dur };
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
    /** The destination: [x, y]; in a perspective layer [x, y, z] moves it in depth too. */
    to: Vec2 | Vec3;
    dur?: number;
    anticipation?: number;
    overshoot?: number;
    arc?: number;
    profile?: MoveProfile;
    ramp?: number;
    /** false: the intent is silent. A key: the sound of its start, instead of what the bank gives its kind. */
    sound?: string | false;
  },
): MoveToKey {
  const w = `moveTo("${id}")`;
  only(w, opts, ['at', 'arrive', 'to', 'dur', 'anticipation', 'overshoot', 'arc', 'profile', 'ramp', 'sound']);
  if (!Array.isArray(opts.to) || (opts.to.length !== 2 && opts.to.length !== 3)) throw new IntentError(`${w}: to must be [x, y] (or [x, y, z] in a perspective layer)`);
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
    // A move across the layer carries no depth either.
    ...(opts.to.length === 3 ? { z: num(w, 'to[2]', opts.to[2], -1e6, 1e6) } : {}),
    ...voiced(w, opts),
  };
}

/**
 * A jump from wherever the node is to `to`: it leaves at `at`, flies a parabola
 * `height` units high and lands at `at + dur`, so both moments are known
 * exactly. Sideways it travels at one speed; the height follows gravity. Give
 * either `at`, the take-off, or `land`, the landing.
 */
export function hop(id: string, opts: { at?: number; land?: number; to: Vec2; dur?: number; height?: number; sound?: string | false }): HopKey {
  const w = `hop("${id}")`;
  only(w, opts, ['at', 'land', 'to', 'dur', 'height', 'sound']);
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
    ...voiced(w, opts),
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
    /**
     * A speed that changes on the way, instead of `speed` or `dur`: [[seconds after the start, units per second], ...],
     * the first at 0. Between two keys the speed changes smoothly; after the last it stays. The travel ends when the
     * path is covered.
     */
    speeds?: SpeedKeys;
    /** false: the intent is silent. A key: the sound of its start, instead of what the bank gives its kind. */
    sound?: string | false;
  },
): TravelKey {
  const w = `travel("${id}")`;
  only(w, opts, ['at', 'path', 'speed', 'dur', 'profile', 'ramp', 'smooth', 'closed', 'loops', 'roll', 'orient', 'only', 'speeds', 'sound']);
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
  let speeds: [number, number][] | undefined;
  if (opts.speeds !== undefined) {
    if (opts.speed !== undefined || opts.dur !== undefined || opts.profile !== undefined || opts.ramp !== undefined) {
      throw new IntentError(`${w}: speeds says how fast the travel goes at every moment; leave speed, dur, profile and ramp out`);
    }
    if (!Array.isArray(opts.speeds) || opts.speeds.length < 2) throw new IntentError(`${w}: speeds must be a list of at least two keys [seconds, units per second]`);
    speeds = opts.speeds.map((k, i) => {
      if (!Array.isArray(k) || k.length !== 2) throw new IntentError(`${w}: speeds[${i}] must be [seconds, units per second]`);
      return [num(w, `speeds[${i}][0]`, k[0], 0, 3600), num(w, `speeds[${i}][1]`, k[1], 1e-3, 1e5)] as [number, number];
    });
    if (speeds[0]![0] !== 0) throw new IntentError(`${w}: the first key of speeds is at 0 seconds: the speed the travel starts with`);
    for (let i = 1; i < speeds.length; i++) {
      if (!(speeds[i]![0] > speeds[i - 1]![0])) throw new IntentError(`${w}: the keys of speeds must be in order of time; key ${i} is at ${speeds[i]![0]} s, after ${speeds[i - 1]![0]} s`);
    }
  }
  const profile = profileOf(w, opts.profile, RAMPED, 'steady');
  if (opts.ramp !== undefined && profile === 'steady') throw new IntentError(`${w}: ramp applies to the profiles ease, in and out`);
  const ramp = num(w, 'ramp', opts.ramp ?? DEFAULT_RAMP, 0.02, 0.5);
  if (!speeds && (opts.speed === undefined) === (opts.dur === undefined)) throw new IntentError(`${w}: give either speed (units per second) or dur (seconds), or speeds (keys of speed over time)`);
  const [a, b] = profileRamps(profile, ramp);
  // `speed` is the speed of the steady stretch; the eased ends cover less ground in their time.
  const dur = speeds ? speedDuration(speeds, length) : opts.dur !== undefined ? opts.dur : length / (num(w, 'speed', opts.speed, 1e-3, 1e5) * (1 - (a + b) / 2));
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
    ...(speeds ? { speeds } : {}),
    ...voiced(w, opts),
  };
}

/** Make a node appear: it grows from nothing, overshoots its size and settles. Hidden before `at`. */
export function popIn(id: string, opts: { at: number; dur?: number; overshoot?: number; sound?: string | false }): PopInKey {
  const w = `popIn("${id}")`;
  only(w, opts, ['at', 'dur', 'overshoot', 'sound']);
  return {
    kind: 'popIn',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    dur: num(w, 'dur', opts.dur ?? 0.55, 0.05, 10),
    overshoot: num(w, 'overshoot', opts.overshoot ?? 0.18, 0, 0.5),
    ...voiced(w, opts),
  };
}

/** Make a node disappear: a small swell, then it shrinks to nothing. */
export function popOut(id: string, opts: { at: number; dur?: number; sound?: string | false }): PopOutKey {
  const w = `popOut("${id}")`;
  only(w, opts, ['at', 'dur', 'sound']);
  return {
    kind: 'popOut',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    dur: num(w, 'dur', opts.dur ?? 0.35, 0.05, 10),
    ...voiced(w, opts),
  };
}

/**
 * Turn a node to an absolute rotation (degrees), with overshoot and settle.
 *
 * With a `profile` the turn has no overshoot and its speed is spread as a
 * move's is: 'steady' at one speed, 'ease' from rest to rest, 'in' from rest
 * and on at speed, 'out' in at speed and down to rest. A turn of many
 * revolutions is a large `to`. Instead of `to`, `speed` gives the degrees
 * per second of its steady stretch, from wherever the node is: two keys with
 * one speed join without a step, so a wheel can spin and then slow down.
 *
 *   turnTo('wheel', { at: 0, dur: 14, speed: 72, profile: 'steady' })
 *   turnTo('wheel', { at: 14, dur: 6, speed: 72, profile: 'out' })
 *
 * With `speeds` the speed of the turn is keyed over time, as the speed of a
 * travel is: [[seconds after the start, degrees per second], ...], the first
 * at 0. Between two keys the speed changes smoothly; after the last it stays,
 * until `dur` ends the turn (left out: at its last key). A speed may be 0 (the
 * node rests there) and may be negative.
 *
 *   turnTo('wheel', { at: 2, speeds: [[0, 90], [1.5, 40], [4, 12]], dur: 9 })
 */
export function turnTo(
  id: string,
  opts: {
    at: number;
    to?: number;
    speed?: number;
    /** Keys of speed over time, instead of `to` or `speed`: [[seconds after the start, degrees per second], ...], the first at 0. */
    speeds?: SpeedKeys;
    dur?: number;
    overshoot?: number;
    profile?: Exclude<MoveProfile, 'settle'>;
    ramp?: number;
    /** A hinge: turn a group that lies in a plane of a perspective layer about its own x or y axis, out of its plane. */
    about?: 'x' | 'y';
    sound?: string | false;
  },
): TurnToKey {
  const w = `turnTo("${id}")`;
  only(w, opts, ['at', 'to', 'speed', 'speeds', 'dur', 'overshoot', 'profile', 'ramp', 'about', 'sound']);
  if (opts.about !== undefined && opts.about !== 'x' && opts.about !== 'y') throw new IntentError(`${w}: about must be "x" or "y": the axis of the group the hinge runs along; got ${JSON.stringify(opts.about)}`);
  if (opts.speeds !== undefined) return turnAtSpeeds(w, id, opts);
  if ((opts.to === undefined) === (opts.speed === undefined)) throw new IntentError(`${w}: give either to (an angle in degrees) or speed (degrees per second, from where it is), or speeds (keys of speed over time)`);
  // A speed is the speed of a steady stretch: it asks for a profile, and takes 'steady' when none is named.
  const profile = opts.profile === undefined && opts.speed === undefined ? undefined : profileOf(w, opts.profile, RAMPED, 'steady');
  if (profile !== undefined && (opts.overshoot ?? 0) !== 0) throw new IntentError(`${w}: a turn with a profile has no overshoot; leave overshoot out`);
  if (opts.ramp !== undefined && (profile === undefined || profile === 'steady')) throw new IntentError(`${w}: ramp applies to the profiles ease, in and out`);
  const dur = num(w, 'dur', opts.dur ?? 0.8, 0.05, 3600);
  const ramp = num(w, 'ramp', opts.ramp ?? DEFAULT_RAMP, 0.02, 0.5);
  let by: number | undefined;
  if (opts.speed !== undefined) {
    const [a, b] = profileRamps(profile!, ramp);
    // The eased ends cover less than the steady stretch does in their time.
    by = num(w, 'speed', opts.speed, -1e5, 1e5) * dur * (1 - (a + b) / 2);
  }
  return {
    kind: 'turnTo',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    to: opts.to === undefined ? 0 : num(w, 'to', opts.to, -1e6, 1e6),
    dur,
    overshoot: profile === undefined ? num(w, 'overshoot', opts.overshoot ?? 0.1, 0, 0.5) : 0,
    // A turn without a profile is the key it always was.
    ...(profile === undefined ? {} : { profile, ...(profile === 'steady' ? {} : { ramp }) }),
    ...(by === undefined ? {} : { by }),
    ...(opts.about === undefined ? {} : { about: opts.about }),
    ...voiced(w, opts),
  };
}

/** A turn whose speed is keyed over time: the angle is what the speeds add up to. */
function turnAtSpeeds(w: string, id: string, opts: Parameters<typeof turnTo>[1]): TurnToKey {
  if (opts.to !== undefined || opts.speed !== undefined || opts.profile !== undefined || opts.ramp !== undefined || opts.overshoot !== undefined) {
    throw new IntentError(`${w}: speeds says how fast the turn goes at every moment; leave to, speed, profile, ramp and overshoot out`);
  }
  if (!Array.isArray(opts.speeds) || opts.speeds.length < 2) throw new IntentError(`${w}: speeds must be a list of at least two keys [seconds, degrees per second]`);
  const speeds = opts.speeds.map((k, i) => {
    if (!Array.isArray(k) || k.length !== 2) throw new IntentError(`${w}: speeds[${i}] must be [seconds, degrees per second]`);
    return [num(w, `speeds[${i}][0]`, k[0], 0, 3600), num(w, `speeds[${i}][1]`, k[1], -1e5, 1e5)] as [number, number];
  });
  if (speeds[0]![0] !== 0) throw new IntentError(`${w}: the first key of speeds is at 0 seconds: the speed the turn starts with`);
  for (let i = 1; i < speeds.length; i++) {
    if (!(speeds[i]![0] > speeds[i - 1]![0])) throw new IntentError(`${w}: the keys of speeds must be in order of time; key ${i} is at ${speeds[i]![0]} s, after ${speeds[i - 1]![0]} s`);
  }
  const last = speeds[speeds.length - 1]![0];
  const dur = num(w, 'dur', opts.dur ?? last, 0.05, 3600);
  if (dur < last - 1e-9) throw new IntentError(`${w}: dur (${dur} s) ends the turn before its last key of speed, at ${last} s; lengthen dur or drop the key`);
  return {
    kind: 'turnTo',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    to: 0,
    dur,
    overshoot: 0,
    by: speedDistance(speeds, dur),
    speeds,
    ...(opts.about === undefined ? {} : { about: opts.about }),
    ...voiced(w, opts),
  };
}

/**
 * Change a node's size for good: it grows (or shrinks) to `to` times its
 * authored size, overshoots and settles. Several keys chain: each starts from
 * the size the node has at that moment. Pops and bumps play on top of it.
 *
 * With `to: [sx, sy]` the change is along the node's own axes: it gets `sx`
 * times as wide and `sy` times as high as authored, about `pivot` (a point
 * in its own units; its origin when left out), and stays so. A bar grows from
 * one end, a card turns edge-on, a round thing sags. Such keys chain among
 * themselves, and play on top of the even size.
 *
 *   scaleTo('bar', { at: 2, to: [1, 2.5], pivot: [0, 40] })   // 2.5 times as high, its lower edge in place
 *
 * With a `profile` the change has no overshoot and its speed is spread as a
 * move's is: 'steady' at one speed, 'ease' from rest to rest, 'in' from rest
 * and on at speed, 'out' in at speed and down to rest. The size then runs
 * evenly between its two values, as a place does along a move: with the `at`,
 * `dur`, `profile` and `ramp` of the node's straight move, a thing that comes
 * nearer or falls away changes its size in step with its place.
 *
 *   moveTo('crate', { at: 2, to: [0, 120], dur: 1.8, profile: 'ease', arc: 0 })
 *   scaleTo('crate', { at: 2, to: 3, dur: 1.8, profile: 'ease' })
 */
export function scaleTo(
  id: string,
  opts: { at: number; to: number | Vec2; pivot?: Vec2; dur?: number; overshoot?: number; profile?: Exclude<MoveProfile, 'settle'>; ramp?: number; sound?: string | false },
): ScaleToKey {
  const w = `scaleTo("${id}")`;
  only(w, opts, ['at', 'to', 'pivot', 'dur', 'overshoot', 'profile', 'ramp', 'sound']);
  const axes = Array.isArray(opts.to);
  if (!axes && opts.pivot !== undefined) throw new IntentError(`${w}: pivot goes with to: [sx, sy]; an even change of size is about the node's origin`);
  if (axes && (opts.to as readonly unknown[]).length !== 2) throw new IntentError(`${w}: to must be a number, or [sx, sy]`);
  const profile = opts.profile === undefined ? undefined : profileOf(w, opts.profile, RAMPED, 'ease');
  if (profile !== undefined && (opts.overshoot ?? 0) !== 0) throw new IntentError(`${w}: a change of size with a profile has no overshoot; leave overshoot out`);
  if (opts.ramp !== undefined && (profile === undefined || profile === 'steady')) throw new IntentError(`${w}: ramp applies to the profiles ease, in and out`);
  const ramp = num(w, 'ramp', opts.ramp ?? DEFAULT_RAMP, 0.02, 0.5);
  return {
    kind: 'scaleTo',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    to: axes ? 1 : num(w, 'to', opts.to, 0.01, 100),
    dur: num(w, 'dur', opts.dur ?? 0.6, 0.05, 60),
    overshoot: profile === undefined ? num(w, 'overshoot', opts.overshoot ?? 0.15, 0, 0.5) : 0,
    ...(axes ? { axes: [num(w, 'to[0]', (opts.to as Vec2)[0], 0.01, 100), num(w, 'to[1]', (opts.to as Vec2)[1], 0.01, 100)] as Vec2 } : {}),
    ...(opts.pivot === undefined ? {} : { pivot: point(w, 'pivot', opts.pivot) }),
    // A change of size without a profile is the key it always was.
    ...(profile === undefined ? {} : { profile, ...(profile === 'steady' ? {} : { ramp }) }),
    ...voiced(w, opts),
  };
}

/**
 * Fade a node to an opacity (0..1). A node and everything in it fade as one
 * picture, with its light and its glow. Several keys chain from the opacity the
 * node has at that moment.
 */
export function fadeTo(id: string, opts: { at: number; to: number; dur?: number; sound?: string | false }): FadeToKey {
  const w = `fadeTo("${id}")`;
  only(w, opts, ['at', 'to', 'dur', 'sound']);
  return {
    kind: 'fadeTo',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    to: num(w, 'to', opts.to, 0, 1),
    dur: num(w, 'dur', opts.dur ?? 0.5, 0.05, 60),
    ...voiced(w, opts),
  };
}

/**
 * Raise or lower the level of a shape that has one (see `level` of the shape
 * options): 0 is empty, 1 is full. The level arrives exactly at `at + dur`.
 * Several keys chain from the level reached at that moment.
 */
export function levelTo(
  id: string,
  opts: { at: number; to: number; dur?: number; profile?: Exclude<MoveProfile, 'settle'>; ramp?: number; sound?: string | false },
): LevelToKey {
  const w = `levelTo("${id}")`;
  only(w, opts, ['at', 'to', 'dur', 'profile', 'ramp', 'sound']);
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
    ...voiced(w, opts),
  };
}

/**
 * Open or close the lids of an eye: `to` 1 is open, 0 is shut (a shut eye is
 * not drawn). The change lasts; several keys chain from the opening the eye
 * has at that moment. With an overshoot the eye opens a little too wide first.
 */
export function openTo(eyeId: string, opts: { at: number; to: number; dur?: number; overshoot?: number; sound?: string | false }): OpenToKey {
  const w = `openTo("${eyeId}")`;
  only(w, opts, ['at', 'to', 'dur', 'overshoot', 'sound']);
  return {
    kind: 'openTo',
    target: target(w, eyeId),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    to: num(w, 'to', opts.to, 0, 1),
    dur: num(w, 'dur', opts.dur ?? 0.3, 0.03, 60),
    overshoot: num(w, 'overshoot', opts.overshoot ?? 0.12, 0, 0.5),
    ...voiced(w, opts),
  };
}

/** Make an eye blink at a chosen moment, in addition to its own schedule. */
export function blink(eyeId: string, opts: { at: number; sound?: string | false }): BlinkKey {
  const w = `blink("${eyeId}")`;
  only(w, opts, ['at', 'sound']);
  return { kind: 'blink', target: target(w, eyeId), at: num(w, 'at', opts.at, MIN_T, MAX_T), ...voiced(w, opts) };
}

/** A quick swell-and-settle of a node's scale: a reaction, a beat. */
export function bump(id: string, opts: { at: number; amount?: number; sound?: string | false }): BumpKey {
  const w = `bump("${id}")`;
  only(w, opts, ['at', 'amount', 'sound']);
  return {
    kind: 'bump',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    amount: num(w, 'amount', opts.amount ?? 0.14, -0.5, 0.5),
    ...voiced(w, opts),
  };
}

/**
 * A quick squash (a negative amount) or stretch (a positive one) that rings
 * out: the node and everything in it get lower and wider, or taller and
 * narrower, and keep their area. `pivot` is the point that stays in place, in
 * the node's own units: for a landing its lowest point, so that it squashes
 * against the ground. It is a look only, like a bump.
 */
export function squash(id: string, opts: { at: number; amount?: number; dur?: number; pivot?: Vec2; sound?: string | false }): SquashKey {
  const w = `squash("${id}")`;
  only(w, opts, ['at', 'amount', 'dur', 'pivot', 'sound']);
  return {
    kind: 'squash',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    amount: num(w, 'amount', opts.amount ?? -0.22, -0.6, 0.6),
    dur: num(w, 'dur', opts.dur ?? 0.6, 0.1, 5),
    pivot: opts.pivot === undefined ? [0, 0] : point(w, 'pivot', opts.pivot),
    ...voiced(w, opts),
  };
}

/**
 * Draw a link on from its `from` end, or a stroke from its first point. It is
 * hidden before `at`. A stroke also takes `to`, the share of its length that
 * is drawn when the key ends (keys chain: each starts from the share reached),
 * and a `profile` with its `ramp`, as a travel does, so that a line can be
 * drawn at the speed of the thing that draws it.
 */
export function drawOn(
  id: string,
  opts: { at: number; dur?: number; to?: number; profile?: Exclude<MoveProfile, 'settle'>; ramp?: number; sound?: string | false },
): DrawOnKey {
  const w = `drawOn("${id}")`;
  only(w, opts, ['at', 'dur', 'to', 'profile', 'ramp', 'sound']);
  const profile = opts.profile === undefined ? undefined : profileOf(w, opts.profile, RAMPED, 'ease');
  if (opts.ramp !== undefined && (profile === undefined || profile === 'steady')) throw new IntentError(`${w}: ramp applies to the profiles ease, in and out`);
  return {
    kind: 'drawOn',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    dur: num(w, 'dur', opts.dur ?? 0.6, 0.05, 600),
    // A key that says none of this is the key a link always had.
    ...(opts.to === undefined ? {} : { to: num(w, 'to', opts.to, 0, 1) }),
    ...(profile === undefined ? {} : { profile }),
    ...(opts.ramp === undefined ? {} : { ramp: num(w, 'ramp', opts.ramp, 0.02, 0.5) }),
    ...voiced(w, opts),
  };
}

/**
 * Close the gaps of a dashed stroke, or open them again: `to` 1 is a solid
 * line, 0 the dashes as authored. The dashes grow where they are until they
 * join. Several keys chain from what is reached at that moment.
 */
export function solidTo(strokeId: string, opts: { at: number; to?: number; dur?: number }): SolidToKey {
  const w = `solidTo("${strokeId}")`;
  only(w, opts, ['at', 'to', 'dur']);
  return {
    kind: 'solidTo',
    target: target(w, strokeId),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    to: num(w, 'to', opts.to ?? 1, 0, 1),
    dur: num(w, 'dur', opts.dur ?? 0.6, 0.05, 600),
  };
}

/**
 * Change the bend of a link over time: `to` is its new bulge as a fraction of
 * its length (0 is a taut, straight line; the sign picks the side, as for the
 * link's own `bend`). It swings past the new bend by `overshoot` and settles,
 * so a line pulls taut, sags or goes slack. Several keys chain from the bend
 * reached at that moment.
 */
export function bendTo(linkId: string, opts: { at: number; to: number; dur?: number; overshoot?: number }): BendToKey {
  const w = `bendTo("${linkId}")`;
  only(w, opts, ['at', 'to', 'dur', 'overshoot']);
  return {
    kind: 'bendTo',
    target: target(w, linkId),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    to: num(w, 'to', opts.to, -1, 1),
    dur: num(w, 'dur', opts.dur ?? 0.8, 0.05, 60),
    overshoot: num(w, 'overshoot', opts.overshoot ?? 0.25, 0, 0.5),
  };
}

/**
 * Change the width of a link or of a stroke over time: `to` is its new width
 * in units, as for the line's own `width`. The line stays where it is: the
 * ends of a link stay on its nodes, and what is drawn from the width (its
 * round ends, its glow, the lights that run along it) follows. It shoots past
 * the new width by `overshoot` and settles, so a hair grows thick and thins
 * again. Several keys chain from the width reached at that moment.
 *
 * `to` may be as wide as a stroke may be; a link is narrower, and the shot
 * holds a key of a link to the limit of `link`.
 */
export function widthTo(id: string, opts: { at: number; to: number; dur?: number; overshoot?: number }): WidthToKey {
  const w = `widthTo("${id}")`;
  only(w, opts, ['at', 'to', 'dur', 'overshoot']);
  return {
    kind: 'widthTo',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    to: num(w, 'to', opts.to, 0.5, 200),
    dur: num(w, 'dur', opts.dur ?? 0.6, 0.05, 60),
    overshoot: num(w, 'overshoot', opts.overshoot ?? 0.15, 0, 0.5),
  };
}

/** The bump a pulse gives on arrival, unless its key says otherwise. */
export const PULSE_BUMP = 0.14;

/**
 * Send a glowing pulse along a link, from its `from` end to its `to` end; the
 * node at the far end gets a bump when it arrives.
 *
 * On a stroke the same light runs along the line: from its first point to
 * its last, or between two shares of its length (`from`, `to`; `from` above
 * `to` runs it the other way; on a closed stroke a share above 1 is another
 * time round). `profile` spreads its speed as a move's is; left out, it goes
 * as a pulse on a link does. `length` is the length of the light in units.
 * `node` names the node that gets the bump when the light arrives.
 *
 *   pulse('wire', { at: 2, dur: 1.6 })
 *   pulse('ring', { at: 4, dur: 3, to: 2, profile: 'steady', node: 'lamp' })
 */
export function pulse(
  id: string,
  opts: {
    at: number;
    dur?: number;
    bump?: number;
    /** A stroke: the share of its length where the light starts; default 0, its first point. */
    from?: number;
    /** A stroke: the share of its length where the light arrives; default 1, its last point. */
    to?: number;
    /** A stroke: how the speed of the light is spread; default: as a pulse on a link goes. */
    profile?: Exclude<MoveProfile, 'settle'>;
    ramp?: number;
    /** A stroke: the length of the light in units; default a quarter of its way, at most 120. */
    length?: number;
    /** A stroke: the node that gets the bump when the light arrives. */
    node?: string;
    sound?: string | false;
  },
): PulseKey {
  const w = `pulse("${id}")`;
  only(w, opts, ['at', 'dur', 'bump', 'from', 'to', 'profile', 'ramp', 'length', 'node', 'sound']);
  const profile = opts.profile === undefined ? undefined : profileOf(w, opts.profile, RAMPED, 'steady');
  if (opts.ramp !== undefined && (profile === undefined || profile === 'steady')) throw new IntentError(`${w}: ramp applies to the profiles ease, in and out`);
  return {
    kind: 'pulse',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    dur: num(w, 'dur', opts.dur ?? 0.7, 0.05, 30),
    bump: num(w, 'bump', opts.bump ?? PULSE_BUMP, 0, 0.5),
    // A key that says none of this is the key a link always had.
    ...(opts.from === undefined ? {} : { from: num(w, 'from', opts.from, 0, 1000) }),
    ...(opts.to === undefined ? {} : { to: num(w, 'to', opts.to, 0, 1000) }),
    ...(profile === undefined ? {} : { profile }),
    ...(opts.ramp === undefined ? {} : { ramp: num(w, 'ramp', opts.ramp, 0.02, 0.5) }),
    ...(opts.length === undefined ? {} : { length: num(w, 'length', opts.length, 1, 1e5) }),
    ...(opts.node === undefined ? {} : { node: arrivalNode(w, opts.node) }),
    ...voiced(w, opts),
  };
}

function arrivalNode(where: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new IntentError(`${where}: node must be the id of the node that the light arrives at, got ${JSON.stringify(value)}`);
  return value;
}

/**
 * A sound placed at a moment by hand, for example on a word of the narration:
 * `key` is a sound of the bank. It always sounds, whatever else happens then.
 * With `node` it is panned to where that node is on screen; without, to the
 * middle. `gain` multiplies the gain the bank gives the sound.
 *
 *   sfx('chime', { at: 6.5 })
 *   sfx('marble', { at: 3.2, node: 'jar', gain: 0.7 })
 */
export function sfx(key: string, opts: { at: number; node?: string; gain?: number }): SfxKey {
  const w = `sfx(${JSON.stringify(key)})`;
  if (!isSoundKey(key)) throw new IntentError(`${w}: the first argument is the key of a sound such as "chime" or "glass.small"`);
  only(w, opts, ['at', 'node', 'gain']);
  return {
    kind: 'sfx',
    target: opts.node === undefined ? null : target(w, opts.node),
    at: num(w, 'at', opts.at, 0, MAX_T),
    sound: key,
    gain: num(w, 'gain', opts.gain ?? 1, 0, 8),
  };
}

/**
 * Run the number of a counter (a text with `count`) to `to`, over `dur`
 * seconds, along a profile: 'ease' from rest to rest (the default), 'steady'
 * at one pace, 'in', 'out'. Keys chain from the value reached. A short key is
 * a tick. With `ratio: true` the number grows as a ratio: it gains its
 * digits at an even pace (both ends must be above 0).
 *
 *   countTo('total', { at: 2, to: 1500, dur: 3 })
 */
export function countTo(id: string, opts: { at: number; to: number; dur?: number; profile?: Exclude<MoveProfile, 'settle'>; ramp?: number; ratio?: boolean }): CountToKey {
  const w = `countTo("${id}")`;
  only(w, opts, ['at', 'to', 'dur', 'profile', 'ramp', 'ratio']);
  const profile = profileOf(w, opts.profile, RAMPED, 'ease');
  if (opts.ramp !== undefined && profile === 'steady') throw new IntentError(`${w}: ramp applies to the profiles ease, in and out`);
  if (opts.ratio !== undefined && typeof opts.ratio !== 'boolean') throw new IntentError(`${w}: ratio must be true or false`);
  const to = num(w, 'to', opts.to, -1e15, 1e15);
  if (opts.ratio === true && !(to > 0)) throw new IntentError(`${w}: with ratio the number runs between values above 0; to is ${to}`);
  return {
    kind: 'countTo',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    to,
    dur: num(w, 'dur', opts.dur ?? 1, 0.02, 3600),
    profile,
    ramp: num(w, 'ramp', opts.ramp ?? DEFAULT_RAMP, 0.02, 0.5),
    ...(opts.ratio === true ? { ratio: true } : {}),
  };
}

/**
 * Move the camera at a moment: `zoom` is the zoom it reaches, as a factor of
 * the authored view (2 shows the focus plane twice as large); `to` is the
 * place it looks at when the key ends. Give one or both. Keys chain: each
 * takes over from where the camera is at its moment. The zoom runs at one
 * apparent speed along its profile, so it may span orders of magnitude; the
 * drift and the wander of the camera stay on top, as large on screen as ever.
 *
 *   cameraTo({ at: 2, zoom: 0.5, dur: 1.6 })               // pull back
 *   cameraTo({ at: 5, zoom: 4, to: [300, -120] })          // push into a detail
 */
export function cameraTo(opts: { at: number; dur?: number; zoom?: number; to?: Vec2; profile?: Exclude<MoveProfile, 'settle'>; ramp?: number }): CameraToKey {
  const w = 'cameraTo';
  only(w, opts, ['at', 'dur', 'zoom', 'to', 'profile', 'ramp']);
  if (opts.zoom === undefined && opts.to === undefined) throw new IntentError(`${w}: give zoom, to, or both`);
  const profile = profileOf(w, opts.profile, RAMPED, 'ease');
  if (opts.ramp !== undefined && profile === 'steady') throw new IntentError(`${w}: ramp applies to the profiles ease, in and out`);
  return {
    kind: 'cameraTo',
    target: null,
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    dur: num(w, 'dur', opts.dur ?? 1.2, 0.05, 600),
    ...(opts.zoom === undefined ? {} : { zoom: num(w, 'zoom', opts.zoom, 0.01, 10000) }),
    ...(opts.to === undefined ? {} : { to: point(w, 'to', opts.to) }),
    profile,
    ramp: num(w, 'ramp', opts.ramp ?? DEFAULT_RAMP, 0.02, 0.5),
  };
}

/**
 * Zoom the camera at a moment and leave it where it is: `to` is the zoom the
 * key reaches, as a factor of the authored view (1.15 shows the focus plane
 * 15 % larger). The drift, the path and the wander of the camera run on under
 * the key as if it were not there: it changes how large the picture is, never
 * where the camera looks. So a slow push toward a subject can start on a word
 * while the background keeps sliding. The zoom runs at one apparent speed
 * along its profile and multiplies the push-in of the shot, and the zoom of
 * its `cameraTo` keys if it has any. Keys chain: each starts from the zoom the
 * zoom keys have reached at its moment.
 *
 *   zoomTo({ at: 6, to: 1.15, dur: 8 })                    // a slow push, the camera path running on
 *   zoomTo({ at: 15, to: 1, dur: 2 })                      // and back
 */
export function zoomTo(opts: { at: number; to: number; dur?: number; profile?: Exclude<MoveProfile, 'settle'>; ramp?: number }): ZoomToKey {
  const w = 'zoomTo';
  only(w, opts, ['at', 'to', 'dur', 'profile', 'ramp']);
  if (typeof opts.to !== 'number') {
    throw new IntentError(`${w}: to is the zoom it reaches, a number such as 1.15: a zoom key leaves the camera where it is (cameraTo moves it to a place)`);
  }
  const profile = profileOf(w, opts.profile, RAMPED, 'ease');
  if (opts.ramp !== undefined && profile === 'steady') throw new IntentError(`${w}: ramp applies to the profiles ease, in and out`);
  return {
    kind: 'zoomTo',
    target: null,
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    dur: num(w, 'dur', opts.dur ?? 3, 0.05, 600),
    to: num(w, 'to', opts.to, 0.01, 10000),
    profile,
    ramp: num(w, 'ramp', opts.ramp ?? DEFAULT_RAMP, 0.02, 0.5),
  };
}

/**
 * Change the outline of a region, or the line of a stroke, into another one:
 * a square softens into a coast, two banks smooth into one. `points` is the
 * new outline: as many points as the node has, given the same way round and
 * from the same place, because the point at each place in the list runs
 * straight to the point at that place in the new one. `smooth` changes how
 * the points are joined (0: straight edges, 1: a smooth curve). The change
 * lasts; several keys chain from the outline reached at their moment. A
 * region stays one shape with one light all the way; it may not cross itself
 * on the way.
 *
 *   reshape('isle', { at: 2, dur: 1.6, points: COAST, smooth: 1 })
 */
export function reshape(
  id: string,
  opts: { at: number; points: readonly Vec2[]; dur?: number; smooth?: number; profile?: Exclude<MoveProfile, 'settle'>; ramp?: number },
): ReshapeKey {
  const w = `reshape("${id}")`;
  only(w, opts, ['at', 'points', 'dur', 'smooth', 'profile', 'ramp']);
  if (!Array.isArray(opts.points) || opts.points.length < 2) throw new IntentError(`${w}: points must be the new outline: a list of points [x, y], as many as the node has`);
  const profile = profileOf(w, opts.profile, RAMPED, 'ease');
  if (opts.ramp !== undefined && profile === 'steady') throw new IntentError(`${w}: ramp applies to the profiles ease, in and out`);
  return {
    kind: 'reshape',
    target: target(w, id),
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    // A tenth of a second at least: an outline does not change within a frame.
    dur: num(w, 'dur', opts.dur ?? 1.2, 0.1, 600),
    points: opts.points.map((p, i) => point(w, `points[${i}]`, p)),
    ...(opts.smooth === undefined ? {} : { smooth: num(w, 'smooth', opts.smooth, 0, 1) }),
    profile,
    ramp: num(w, 'ramp', opts.ramp ?? DEFAULT_RAMP, 0.02, 0.5),
  };
}

/** What a drive may set at one moment. Each is left out when the drive does not drive it. */
export interface Driven {
  /** The place of the node in its parent's space: [x, y], or [x, y, z] for a node of a perspective layer. */
  readonly at?: Vec2 | Vec3;
  /** Degrees, clockwise. */
  readonly rotation?: number;
  /** A factor of the authored size. */
  readonly scale?: number;
  /** 0..1. */
  readonly opacity?: number;
  /** The draw order inside the layer: what has the larger depth is drawn first, behind the rest. */
  readonly depth?: number;
  /** The outline of a region or the line of a stroke: as many points as the node has. */
  readonly points?: readonly (Vec2 | Vec3)[];
}

/** The samples of a drive given ready: per channel, one value per sample. */
export interface DriveSamples {
  readonly at?: readonly (Vec2 | Vec3)[];
  readonly rotation?: readonly number[];
  readonly scale?: readonly number[];
  readonly opacity?: readonly number[];
  readonly depth?: readonly number[];
  readonly points?: readonly (readonly (Vec2 | Vec3)[])[];
}

const DRIVE_CHANNELS = ['at', 'rotation', 'scale', 'opacity', 'depth', 'points'] as const;
/** The most numbers one drive key may hold. */
export const DRIVE_MAX_NUMBERS = 6_000_000;
/** The most points a driven outline may have: as many as a region may. */
const DRIVE_MAX_POINTS = 600;

/**
 * Drive a node by a computed function of time: what no move profile says. A
 * corner of a frame that is turned in more dimensions than the screen has, a
 * body on an orbit, the outline of a sheet that curls. `by` is a function of
 * the seconds since the key starts; it returns what the node is at that
 * moment: its place (`at`), its `rotation`, its `scale` (a factor of the
 * authored size), its `opacity`, its `depth` (the draw order in its layer)
 * and, for a region or a stroke, its `points`. It returns the same channels
 * every time. The function must be pure: the same seconds, the same answer.
 * It is called once for every frame of the key when the shot is built, and
 * the shot keeps those samples, not the function.
 *
 *   drive('moon', { at: 1, dur: 6, by: (t) => ({ at: [300 * Math.cos(t), 120 * Math.sin(t)], depth: Math.sin(t) }) })
 *
 * Instead of `by`, `samples` gives the values themselves, evenly spaced over
 * `dur`, at least two per channel: a track computed elsewhere. Between two
 * samples the node follows a smooth curve through them.
 *
 *   drive('probe', { dur: 4, samples: { at: [[0, 0], [40, -10], [90, -12], [150, 0]] } })
 *
 * Before the key the node is as authored; after it, it stays as the last
 * sample left it. A channel that a drive sets is not also keyed: a driven
 * place takes no moveTo, hop or travel, a driven rotation no turnTo, a driven
 * scale no scaleTo, a driven opacity no fadeTo, driven points no reshape. Put
 * the node in a group to add such a move. The motion review judges a driven
 * node like any other.
 */
export function drive(id: string, opts: { at?: number; dur: number; by?: (seconds: number) => Driven; samples?: DriveSamples }): DriveKey {
  const w = `drive("${id}")`;
  only(w, opts, ['at', 'dur', 'by', 'samples']);
  const at = num(w, 'at', opts.at ?? 0, MIN_T, MAX_T);
  const dur = num(w, 'dur', opts.dur, 1 / FPS, 3600);
  if ((opts.by === undefined) === (opts.samples === undefined)) {
    throw new IntentError(`${w}: give either by (a function of the seconds since the key starts) or samples (the values themselves, evenly spaced over dur)`);
  }
  let count: number;
  let names: string[];
  let read: (name: string, i: number) => unknown;
  if (opts.by !== undefined) {
    if (typeof opts.by !== 'function') throw new IntentError(`${w}: by must be a function of the seconds since the key starts, e.g. (t) => ({ at: [100 * t, 0] })`);
    count = Math.max(2, Math.round(dur * FPS) + 1);
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i++) {
      const seconds = (dur * i) / (count - 1);
      const row = opts.by(seconds) as unknown;
      if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new IntentError(`${w}: by must return an object such as { at: [x, y] }; at ${seconds.toFixed(3)} s it returned ${JSON.stringify(row)}`);
      only(`${w}: what by returns`, row, DRIVE_CHANNELS);
      rows.push(row as Record<string, unknown>);
    }
    names = Object.keys(rows[0]!).filter((name) => rows[0]![name] !== undefined);
    rows.forEach((row, i) => {
      const mine = Object.keys(row).filter((name) => row[name] !== undefined);
      if (mine.length !== names.length || mine.some((name) => !names.includes(name))) {
        throw new IntentError(`${w}: by must return the same channels every time; at 0 s it returned ${names.join(', ') || 'none'}, at ${((dur * i) / (count - 1)).toFixed(3)} s ${mine.join(', ') || 'none'}`);
      }
    });
    read = (name, i) => rows[i]![name];
  } else {
    const given = opts.samples as Record<string, unknown>;
    only(`${w}: samples`, given, DRIVE_CHANNELS);
    names = Object.keys(given).filter((name) => given[name] !== undefined);
    count = 0;
    for (const name of names) {
      const list = given[name];
      if (!Array.isArray(list) || list.length < 2) throw new IntentError(`${w}: samples.${name} must be a list of at least two samples, evenly spaced over dur`);
      if (count !== 0 && list.length !== count) throw new IntentError(`${w}: every channel of samples holds one value per sample; ${names[0]} has ${count}, ${name} has ${list.length}`);
      count = list.length;
    }
    read = (name, i) => (given[name] as unknown[])[i];
  }
  if (names.length === 0) throw new IntentError(`${w}: nothing is driven; give at least one of ${DRIVE_CHANNELS.join(', ')}`);

  const when = (i: number): string => `at ${((dur * i) / (count - 1)).toFixed(3)} s`;
  // A sample of -0 is kept as 0: the key is the same data when it has been written out and read back.
  const scalars = (name: string, min: number, max: number): number[] => Array.from({ length: count }, (_, i) => num(w, `${name} ${when(i)}`, read(name, i), min, max) + 0);
  const dimsOf = (name: string, p: unknown, i: number): 2 | 3 => {
    if (!Array.isArray(p) || (p.length !== 2 && p.length !== 3)) throw new IntentError(`${w}: ${name} ${when(i)} must be [x, y], or [x, y, z] in a perspective layer; got ${JSON.stringify(p)}`);
    return p.length as 2 | 3;
  };
  let total = 0;
  const key: { -readonly [K in keyof DriveKey]: DriveKey[K] } = { kind: 'drive', target: target(w, id), at, dur, count };
  if (names.includes('at')) {
    const dims = dimsOf('at', read('at', 0), 0);
    const place: number[] = [];
    for (let i = 0; i < count; i++) {
      const p = read('at', i) as unknown[];
      if (dimsOf('at', p, i) !== dims) throw new IntentError(`${w}: at has ${dims} numbers at 0 s and ${p.length} ${when(i)}; a place keeps its form`);
      for (let k = 0; k < dims; k++) place.push(num(w, `at[${k}] ${when(i)}`, p[k], -1e6, 1e6) + 0);
    }
    key.place = place;
    key.placeDims = dims;
    total += place.length;
  }
  if (names.includes('rotation')) key.rotation = scalars('rotation', -1e7, 1e7);
  if (names.includes('scale')) key.scale = scalars('scale', 0, 1000);
  if (names.includes('opacity')) key.opacity = scalars('opacity', 0, 1);
  if (names.includes('depth')) key.depth = scalars('depth', -1e6, 1e6);
  if (names.includes('points')) {
    const first = read('points', 0);
    if (!Array.isArray(first) || first.length < 2 || first.length > DRIVE_MAX_POINTS) throw new IntentError(`${w}: points must be the outline: a list of 2 to ${DRIVE_MAX_POINTS} points, as many as the node has`);
    const dims = dimsOf('points[0]', first[0], 0);
    const points: number[][] = [];
    for (let i = 0; i < count; i++) {
      const list = read('points', i);
      if (!Array.isArray(list) || list.length !== first.length) throw new IntentError(`${w}: points holds ${first.length} points at 0 s and ${Array.isArray(list) ? list.length : 'none'} ${when(i)}; an outline keeps its number of points`);
      const flat: number[] = [];
      list.forEach((p: unknown, j: number) => {
        if (dimsOf(`points[${j}]`, p, i) !== dims) throw new IntentError(`${w}: points[${j}] ${when(i)} has not the ${dims} numbers the first point has`);
        for (let k = 0; k < dims; k++) flat.push(num(w, `points[${j}][${k}] ${when(i)}`, (p as unknown[])[k], -1e6, 1e6) + 0);
      });
      points.push(flat);
      total += flat.length;
    }
    key.points = points;
    key.pointDims = dims;
  }
  total += count * names.filter((name) => name !== 'at' && name !== 'points').length;
  if (total > DRIVE_MAX_NUMBERS) throw new IntentError(`${w}: the key holds ${total} numbers, more than ${DRIVE_MAX_NUMBERS}; shorten it, split it, or drive fewer points`);
  return key;
}

/**
 * Move the camera of a perspective layer at a moment (a layer made with the
 * option `perspective`). `aim` is the point it looks at; `distance` how far it
 * stands from it (a dolly: what is near grows faster than what is far);
 * `tilt` the degrees it looks down by (0 level, 90 straight down); `turn` the
 * degrees it has gone round the point; `lens` its zoom. Give at least one;
 * what is left out stays. Keys chain: each takes over from where the camera
 * is at its moment. The camera moves one way along its profile.
 *
 *   perspectiveTo('room', { at: 2, dur: 4, tilt: 90, distance: 2400 })    // rise and look straight down
 */
export function perspectiveTo(
  layerId: string,
  opts: { at: number; dur?: number; aim?: Vec3; distance?: number; tilt?: number; turn?: number; lens?: number; profile?: Exclude<MoveProfile, 'settle'>; ramp?: number },
): PerspectiveToKey {
  const w = `perspectiveTo("${layerId}")`;
  if (typeof layerId !== 'string' || layerId.length === 0) throw new IntentError('perspectiveTo: the first argument is the id of the perspective layer');
  only(w, opts, ['at', 'dur', 'aim', 'distance', 'tilt', 'turn', 'lens', 'profile', 'ramp']);
  if (opts.aim === undefined && opts.distance === undefined && opts.tilt === undefined && opts.turn === undefined && opts.lens === undefined) {
    throw new IntentError(`${w}: give at least one of aim, distance, tilt, turn, lens`);
  }
  if (opts.aim !== undefined && (!Array.isArray(opts.aim) || opts.aim.length !== 3)) throw new IntentError(`${w}: aim must be [x, y, z]: the point the camera looks at`);
  const profile = profileOf(w, opts.profile, RAMPED, 'ease');
  if (opts.ramp !== undefined && profile === 'steady') throw new IntentError(`${w}: ramp applies to the profiles ease, in and out`);
  return {
    kind: 'perspectiveTo',
    target: null,
    layer: layerId,
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    dur: num(w, 'dur', opts.dur ?? 1.6, 0.05, 600),
    ...(opts.aim === undefined ? {} : { aim: [num(w, 'aim[0]', opts.aim[0], -1e6, 1e6), num(w, 'aim[1]', opts.aim[1], -1e6, 1e6), num(w, 'aim[2]', opts.aim[2], -1e6, 1e6)] as Vec3 }),
    ...(opts.distance === undefined ? {} : { distance: num(w, 'distance', opts.distance, 1, 1e6) }),
    ...(opts.tilt === undefined ? {} : { tilt: num(w, 'tilt', opts.tilt, -90, 90) }),
    ...(opts.turn === undefined ? {} : { turn: num(w, 'turn', opts.turn, -36000, 36000) }),
    ...(opts.lens === undefined ? {} : { lens: num(w, 'lens', opts.lens, 1, 1e6) }),
    profile,
    ramp: num(w, 'ramp', opts.ramp ?? DEFAULT_RAMP, 0.02, 0.5),
  };
}

/**
 * Change the background of the shot at a moment, while everything in it goes
 * on: one sky turns into another. `inner` and `outer` are the colours of its
 * gradient (palette references), `center` and `radius` its place and size,
 * `atmosphere` the colour far layers fade toward, `vignette` how far the
 * corners darken. Give at least one; what is left out stays as it is. The
 * colours run round the colour wheel, hue along the short way, so a change
 * never passes through gray; the corners darken toward the outer colour of
 * each frame, and every layer is tinted toward the atmosphere of each frame.
 * Keys chain: each takes over from what the background is at its moment.
 *
 *   backgroundTo({ at: 6, dur: 3, inner: 'deep.sea', outer: 'deep.abyss', atmosphere: 'mid.ocean' })
 */
export function backgroundTo(opts: {
  at: number;
  dur?: number;
  inner?: string;
  outer?: string;
  center?: Vec2;
  radius?: number;
  atmosphere?: string;
  vignette?: number;
  profile?: Exclude<MoveProfile, 'settle'>;
  ramp?: number;
}): BackgroundToKey {
  const w = 'backgroundTo';
  only(w, opts, ['at', 'dur', 'inner', 'outer', 'center', 'radius', 'atmosphere', 'vignette', 'profile', 'ramp']);
  const given = (['inner', 'outer', 'center', 'radius', 'atmosphere', 'vignette'] as const).filter((name) => opts[name] !== undefined);
  if (given.length === 0) throw new IntentError(`${w}: give what changes: inner, outer, center, radius, atmosphere or vignette`);
  const profile = profileOf(w, opts.profile, RAMPED, 'ease');
  if (opts.ramp !== undefined && profile === 'steady') throw new IntentError(`${w}: ramp applies to the profiles ease, in and out`);
  const ref = (name: 'inner' | 'outer' | 'atmosphere'): string => {
    const value = opts[name];
    if (typeof value !== 'string' || !/^[a-z]+\.\S+$/.test(value)) {
      throw new IntentError(`${w}: ${name} must be a palette reference "role.name" such as "deep.night", got ${JSON.stringify(value)}. Raw colour values are not accepted in scenes`);
    }
    return value;
  };
  return {
    kind: 'backgroundTo',
    target: null,
    at: num(w, 'at', opts.at, MIN_T, MAX_T),
    // A tenth of a second at least: a background does not change within a frame.
    dur: num(w, 'dur', opts.dur ?? 2, 0.1, 600),
    ...(opts.inner === undefined ? {} : { inner: ref('inner') }),
    ...(opts.outer === undefined ? {} : { outer: ref('outer') }),
    ...(opts.center === undefined ? {} : { center: point(w, 'center', opts.center) }),
    ...(opts.radius === undefined ? {} : { radius: num(w, 'radius', opts.radius, 0.05, 5) }),
    ...(opts.atmosphere === undefined ? {} : { atmosphere: ref('atmosphere') }),
    ...(opts.vignette === undefined ? {} : { vignette: num(w, 'vignette', opts.vignette, 0, 1) }),
    profile,
    ramp: num(w, 'ramp', opts.ramp ?? DEFAULT_RAMP, 0.02, 0.5),
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
  only(w, opts, ['at', 'each', 'order']);
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
