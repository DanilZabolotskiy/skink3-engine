// The shapes of motion: closed-form curves with anticipation, overshoot and
// settle. All of them are pure functions of normalised time, so a frame can be
// evaluated alone.

import { overshootStep } from '../core/dynamics.ts';
import { clamp01 } from '../core/math.ts';

/** Share of a move's duration spent backing away before it goes. */
export const ANTICIPATION_SHARE = 0.24;

/**
 * Progress of a move along its path for u in [0, 1].
 * Backs away to -anticipation, accelerates, shoots past 1 by `overshoot`, settles at 1.
 * Continuous in value and velocity; exactly 0 at u = 0 and 1 at u = 1.
 */
export function moveProgress(u: number, anticipation: number, overshoot: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const ua = anticipation > 1e-6 ? ANTICIPATION_SHARE : 0;
  if (u < ua) {
    const x = u / ua;
    return -anticipation * (0.5 - 0.5 * Math.cos(Math.PI * x));
  }
  const v = (u - ua) / (1 - ua);
  const travel = 1 + anticipation;
  return -anticipation + travel * overshootStep(v, overshoot / travel, 0.5);
}

/** Sideways displacement of an arced path at progress p: 0 at both ends, 1 in the middle, smooth. */
export function arcBump(p: number): number {
  const s = Math.sin(Math.PI * clamp01(p));
  return s * s;
}

/** Scale of a node popping in: 0 -> past 1 -> 1. */
export function popInScale(u: number, overshoot: number): number {
  return overshootStep(u, overshoot, 0.42);
}

/** Scale of a node popping out: a small swell, then down to 0. */
export function popOutScale(u: number): number {
  if (u <= 0) return 1;
  if (u >= 1) return 0;
  const swell = 0.3;
  if (u < swell) return 1 + 0.1 * (0.5 - 0.5 * Math.cos((Math.PI * u) / swell));
  const x = (u - swell) / (1 - swell);
  return 1.1 * (1 - x * x * x);
}

/** How long a bump lasts, in seconds. */
export const BUMP_SECONDS = 0.7;

const BUMP_DECAY = 0.11;
const BUMP_PERIOD = 0.34;
const BUMP_NORM = 0.519;

/** Extra scale `tau` seconds after a bump of the given amount: a quick swell that rings out. */
export function bumpScale(tau: number, amount: number): number {
  if (tau <= 0 || tau >= BUMP_SECONDS) return 0;
  const window = 1 - (tau / BUMP_SECONDS) ** 4;
  return ((amount * Math.exp(-tau / BUMP_DECAY) * Math.sin((2 * Math.PI * tau) / BUMP_PERIOD)) / BUMP_NORM) * window;
}

/** Fraction of a link's length that a pulse covers. */
export const PULSE_LENGTH = 0.24;
/** Seconds the tail takes to arrive after the head has. */
export const PULSE_TAIL_SECONDS = 0.14;

/** Head and tail of a pulse along a link (0 = start, 1 = end), or null when it is not on the link. */
export function pulseSpan(t: number, at: number, dur: number): { head: number; tail: number } | null {
  if (t < at || t > at + dur + PULSE_TAIL_SECONDS) return null;
  if (t <= at + dur) {
    const u = (t - at) / dur;
    const eased = u * 0.4 + (0.5 - 0.5 * Math.cos(Math.PI * u)) * 0.6;
    return { head: eased, tail: Math.max(0, eased - PULSE_LENGTH) };
  }
  const x = (t - at - dur) / PULSE_TAIL_SECONDS;
  return { head: 1, tail: 1 - PULSE_LENGTH * (1 - x) };
}

/**
 * How the speed of a move is spread over its duration.
 *
 *   settle   backs away, goes, shoots past, settles (the default of moveTo)
 *   ease     from rest to rest: the speed ramps up, holds, ramps down
 *   steady   one speed from the first frame to the last: a flow
 *   in       from rest, then steady: it leaves at speed
 *   out      steady, then down to rest: it arrives at speed and stops
 */
export type MoveProfile = 'settle' | 'ease' | 'steady' | 'in' | 'out';

export const MOVE_PROFILES: readonly MoveProfile[] = ['settle', 'ease', 'steady', 'in', 'out'];

/** Share of the duration each eased end of a move takes, unless the key says otherwise. */
export const DEFAULT_RAMP = 0.3;

/**
 * Progress along a path for u in [0, 1] when the speed ramps up over the share
 * `a` of the duration, holds, and ramps down over the share `b` (a + b <= 1).
 * The ramps are raised cosines, so the speed is continuous and zero at an
 * eased end. With a = b = 0 it is u itself.
 *
 * The speed on the plateau is 1 / (1 - (a + b) / 2) times the mean speed.
 */
export function rampProgress(u: number, a: number, b: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const v = 1 / (1 - (a + b) / 2);
  if (u < a) {
    const x = u / a;
    return v * a * (x / 2 - Math.sin(Math.PI * x) / (2 * Math.PI));
  }
  if (u > 1 - b) {
    const y = (1 - u) / b;
    return 1 - v * b * (y / 2 - Math.sin(Math.PI * y) / (2 * Math.PI));
  }
  return v * (a / 2 + (u - a));
}

/** The ramps (at the start, at the end) of a profile other than settle, as shares of the duration. */
export function profileRamps(profile: Exclude<MoveProfile, 'settle'>, ramp: number): [number, number] {
  switch (profile) {
    case 'ease': return [ramp, ramp];
    case 'in': return [ramp, 0];
    case 'out': return [0, ramp];
    case 'steady': return [0, 0];
  }
}

/** Peak speed of a profile other than settle, as a multiple of distance / duration. */
export function profilePeak(profile: Exclude<MoveProfile, 'settle'>, ramp: number): number {
  const [a, b] = profileRamps(profile, ramp);
  return 1 / (1 - (a + b) / 2);
}

/**
 * The moments of a settle move as shares of its duration: when it stops
 * backing away and goes (`leaves`), when it first reaches its destination
 * (`arrives`), and when it is farthest past it (`peaks`); after that it
 * settles. Without an overshoot the move is an ease-out: it arrives at the
 * very end and never passes its destination.
 */
export function settleMoments(anticipation: number, overshoot: number): { leaves: number; arrives: number; peaks: number } {
  const leaves = anticipation > 1e-6 ? ANTICIPATION_SHARE : 0;
  if (overshoot <= 1e-4) return { leaves, arrives: 1, peaks: 1 };
  // The first time the progress is 1: by bisection between the start of the travel and its peak.
  let lo = leaves;
  let hi = leaves + (1 - leaves) * 0.5;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (moveProgress(mid, anticipation, overshoot) < 1) lo = mid;
    else hi = mid;
  }
  // The overshoot peaks half-way through the travel that follows the anticipation.
  return { leaves, arrives: hi, peaks: leaves + (1 - leaves) * 0.5 };
}
