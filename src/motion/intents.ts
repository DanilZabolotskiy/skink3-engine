// Intents: what should happen, not how. Each function returns a timeline key
// (plain data). The engine turns keys into curves with anticipation, an arc,
// overshoot and settle; see curves.ts and tracks.ts.

import type { Vec2 } from '../core/math.ts';

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

export type Key = MoveToKey | PopInKey | PopOutKey | TurnToKey | BumpKey | DrawOnKey | PulseKey;

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

const MAX_T = 3600;

/**
 * Move a node to a place. The engine adds a short anticipation, a curved path,
 * an overshoot and a settle. The move starts from wherever the node is at `at`.
 */
export function moveTo(
  id: string,
  opts: { at: number; to: Vec2; dur?: number; anticipation?: number; overshoot?: number; arc?: number },
): MoveToKey {
  const w = `moveTo("${id}")`;
  if (!Array.isArray(opts.to) || opts.to.length !== 2) throw new IntentError(`${w}: to must be [x, y]`);
  return {
    kind: 'moveTo',
    target: target(w, id),
    at: num(w, 'at', opts.at, 0, MAX_T),
    to: [num(w, 'to[0]', opts.to[0], -1e6, 1e6), num(w, 'to[1]', opts.to[1], -1e6, 1e6)],
    dur: num(w, 'dur', opts.dur ?? 1.1, 0.1, 60),
    anticipation: num(w, 'anticipation', opts.anticipation ?? 0.08, 0, 0.4),
    overshoot: num(w, 'overshoot', opts.overshoot ?? 0.07, 0, 0.4),
    arc: num(w, 'arc', opts.arc ?? 0.12, -1, 1),
  };
}

/** Make a node appear: it grows from nothing, overshoots its size and settles. Hidden before `at`. */
export function popIn(id: string, opts: { at: number; dur?: number; overshoot?: number }): PopInKey {
  const w = `popIn("${id}")`;
  return {
    kind: 'popIn',
    target: target(w, id),
    at: num(w, 'at', opts.at, 0, MAX_T),
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
    at: num(w, 'at', opts.at, 0, MAX_T),
    dur: num(w, 'dur', opts.dur ?? 0.35, 0.05, 10),
  };
}

/** Turn a node to an absolute rotation (degrees), with overshoot and settle. */
export function turnTo(id: string, opts: { at: number; to: number; dur?: number; overshoot?: number }): TurnToKey {
  const w = `turnTo("${id}")`;
  return {
    kind: 'turnTo',
    target: target(w, id),
    at: num(w, 'at', opts.at, 0, MAX_T),
    to: num(w, 'to', opts.to, -1e5, 1e5),
    dur: num(w, 'dur', opts.dur ?? 0.8, 0.05, 60),
    overshoot: num(w, 'overshoot', opts.overshoot ?? 0.1, 0, 0.5),
  };
}

/** A quick swell-and-settle of a node's scale: a reaction, a beat. */
export function bump(id: string, opts: { at: number; amount?: number }): BumpKey {
  const w = `bump("${id}")`;
  return {
    kind: 'bump',
    target: target(w, id),
    at: num(w, 'at', opts.at, 0, MAX_T),
    amount: num(w, 'amount', opts.amount ?? 0.14, -0.5, 0.5),
  };
}

/** Draw a link on from its `from` end. The link is hidden before `at`. */
export function drawOn(linkId: string, opts: { at: number; dur?: number }): DrawOnKey {
  const w = `drawOn("${linkId}")`;
  return {
    kind: 'drawOn',
    target: target(w, linkId),
    at: num(w, 'at', opts.at, 0, MAX_T),
    dur: num(w, 'dur', opts.dur ?? 0.6, 0.05, 30),
  };
}

/** Send a glowing pulse along a link, from its `from` end to its `to` end. */
export function pulse(linkId: string, opts: { at: number; dur?: number; bump?: number }): PulseKey {
  const w = `pulse("${linkId}")`;
  return {
    kind: 'pulse',
    target: target(w, linkId),
    at: num(w, 'at', opts.at, 0, MAX_T),
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
  const at = num(w, 'at', opts.at, 0, MAX_T);
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
