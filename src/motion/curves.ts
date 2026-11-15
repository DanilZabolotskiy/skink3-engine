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
