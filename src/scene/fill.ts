// The fill of a shape over time, as its fillTo keys change it. A shape without
// such a key has no track and is drawn with the fill it was given on every
// frame. The colour at a moment is a pure function of the track.

import { blendAround, parseHex } from '../look/color.ts';
import { profileRamps, rampProgress, type MoveProfile } from '../motion/curves.ts';

/** One change of the fill, from the colour it had when the change started. Colours are resolved (#RRGGBB). */
export interface FillSeg {
  readonly at: number;
  readonly dur: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
  readonly from: string;
  readonly to: string;
}

export interface FillTrack {
  /** The fill before the first key: the one the shape was given. */
  readonly base: string;
  readonly segs: readonly FillSeg[];
}

/** What a key asks for, with its colour resolved. */
export interface FillChange {
  readonly at: number;
  readonly dur: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
  readonly to: string;
}

/** The change under way at time t, or the last one before it; null before the first key. */
function segAt(track: FillTrack, t: number): FillSeg | null {
  let seg: FillSeg | null = null;
  for (const s of track.segs) {
    if (t >= s.at) seg = s;
    else break;
  }
  return seg;
}

/** How far the change of a segment has come at time t, 0..1. */
function progress(seg: FillSeg, t: number): number {
  const u = (t - seg.at) / seg.dur;
  if (u >= 1) return 1;
  if (u <= 0) return 0;
  const [a, b] = profileRamps(seg.profile, seg.ramp);
  return rampProgress(u, a, b);
}

/** The fill at time t. The colour runs round the colour wheel, as the background does. */
export function sampleFill(track: FillTrack, t: number): string {
  const seg = segAt(track, t);
  if (!seg) return track.base;
  return blendAround(seg.from, seg.to, progress(seg, t));
}

/** The track of the fill keys of a shape. Keys chain: each takes over from the colour the fill has at its moment. */
export function buildFillTrack(base: string, changes: readonly FillChange[]): FillTrack {
  const segs: FillSeg[] = [];
  for (const k of changes.slice().sort((p, q) => p.at - q.at)) {
    const from = sampleFill({ base, segs }, k.at);
    segs.push({ at: k.at, dur: k.dur, profile: k.profile, ramp: k.ramp, from, to: k.to });
  }
  return { base, segs };
}

/**
 * How far the fill changes between two moments, t0 before t1, as a share of the full range of a channel: the
 * largest change of a channel between the two colours of the change under way at t1, times how far the change
 * comes between the two moments. Worked out from the change and not from the colours of the two moments, which
 * are held to 8 bits and would give steps where the change is even.
 */
export function fillStep(track: FillTrack, t0: number, t1: number): number {
  const seg = segAt(track, t1);
  if (!seg || seg.from === seg.to) return 0;
  const p = parseHex(seg.from);
  const q = parseHex(seg.to);
  const most = Math.max(Math.abs(p.r - q.r), Math.abs(p.g - q.g), Math.abs(p.b - q.b)) / 255;
  return Math.abs(progress(seg, t1) - progress(seg, Math.max(t0, seg.at))) * most;
}
