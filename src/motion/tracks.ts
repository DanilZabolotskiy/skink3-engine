// Timeline keys compiled into per-node tracks, and their sampling. A track is
// plain data; sampling it at a time is a pure function.

import { ease } from '../core/easing.ts';
import { overshootStep } from '../core/dynamics.ts';
import type { Vec2 } from '../core/math.ts';
import { arcBump, bumpScale, BUMP_SECONDS, moveProgress, popInScale, popOutScale } from './curves.ts';
import type { BumpKey, DrawOnKey, MoveToKey, PopInKey, PopOutKey, PulseKey, TurnToKey } from './intents.ts';

/** A move never backs away or overshoots by more than this many units, however long it is. */
export const MAX_ANTICIPATION_UNITS = 44;
export const MAX_OVERSHOOT_UNITS = 38;
/** An arc never bulges by more than this many units. */
export const MAX_ARC_UNITS = 150;

export class TrackError extends Error {}

const EPS = 1e-9;

export interface MoveSeg {
  readonly at: number;
  readonly dur: number;
  readonly from: Vec2;
  readonly to: Vec2;
  readonly anticipation: number;
  readonly overshoot: number;
  readonly arc: number;
}

export interface PosTrack {
  readonly base: Vec2;
  readonly segs: readonly MoveSeg[];
}

export function buildPosTrack(id: string, base: Vec2, keys: readonly MoveToKey[]): PosTrack {
  const sorted = keys.slice().sort((a, b) => a.at - b.at);
  const segs: MoveSeg[] = [];
  let from = base;
  let free = -Infinity;
  for (const k of sorted) {
    if (k.at < free - EPS) {
      throw new TrackError(
        `moveTo("${id}") at ${k.at} s starts before the previous move has ended (${free.toFixed(3)} s); ` +
          'start it later or shorten the previous move',
      );
    }
    segs.push({ at: k.at, dur: k.dur, from, to: k.to, anticipation: k.anticipation, overshoot: k.overshoot, arc: k.arc });
    from = k.to;
    free = k.at + k.dur;
  }
  return { base, segs };
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
  const dx = seg.to[0] - seg.from[0];
  const dy = seg.to[1] - seg.from[1];
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-9) return seg.to;
  const a = Math.min(seg.anticipation, MAX_ANTICIPATION_UNITS / dist);
  const o = Math.min(seg.overshoot, MAX_OVERSHOOT_UNITS / dist);
  const p = moveProgress(u, a, o);
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

export interface PopSeg {
  readonly kind: 'in' | 'out';
  readonly at: number;
  readonly dur: number;
  readonly overshoot: number;
}

export interface ScaleTrack {
  readonly pops: readonly PopSeg[];
  readonly bumps: readonly { readonly at: number; readonly amount: number }[];
}

export function buildScaleTrack(
  id: string,
  ins: readonly PopInKey[],
  outs: readonly PopOutKey[],
  bumps: readonly { at: number; amount: number }[],
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
  return { pops, bumps: bumps.slice().sort((a, b) => a.at - b.at) };
}

/** The scale multiplier of a node at time t: pops times bumps. */
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
  return s * (1 + extra);
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

/** Bumps that pulses give to the node at the far end of their link. */
export function pulseArrivalBumps(pulses: readonly PulseKey[]): BumpKey[] {
  return pulses
    .filter((p) => p.bump > 0)
    .map((p): BumpKey => ({ kind: 'bump', target: '', at: p.at + p.dur, amount: p.bump }));
}
