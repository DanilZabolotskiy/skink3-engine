// The background of a shot over time: its gradient, the colour far layers fade
// toward and its vignette, as the keys of the timeline change them. A shot
// without such keys has no track, and its background is what the shot says on
// every frame. The state at a moment is a pure function of the track.

import type { Vec2 } from '../core/math.ts';
import { blendAround, parseHex } from '../look/color.ts';
import { profileRamps, rampProgress, type MoveProfile } from '../motion/curves.ts';

/** The background at one moment. Colours are resolved (#RRGGBB). */
export interface BackgroundState {
  /** Colour at the centre of the gradient and at its edge. */
  readonly inner: string;
  readonly outer: string;
  /** Centre as fractions of the frame, and radius as a fraction of the frame width. */
  readonly center: Vec2;
  readonly radius: number;
  /** The colour far layers fade toward. */
  readonly atmosphere: string;
  /** 0..1 darkening of the corners toward the outer colour. */
  readonly vignette: number;
}

/** One change of the background, with what it was when the change started. */
export interface BackgroundSeg {
  readonly at: number;
  readonly dur: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
  readonly from: BackgroundState;
  readonly to: BackgroundState;
}

export interface BackgroundTrack {
  /** The background before the first key: what the shot says. */
  readonly base: BackgroundState;
  readonly segs: readonly BackgroundSeg[];
}

/** What a key changes, with its colours resolved; what it leaves out stays as it is. */
export interface BackgroundChange {
  readonly at: number;
  readonly dur: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
  readonly to: Partial<BackgroundState>;
}

/** The background at time t. Colours run round the colour wheel; the numbers run straight. */
export function sampleBackground(track: BackgroundTrack, t: number): BackgroundState {
  let seg: BackgroundSeg | null = null;
  for (const s of track.segs) {
    if (t >= s.at) seg = s;
    else break;
  }
  if (!seg) return track.base;
  // A key of no time (at a hard cut) is there at once.
  const u = seg.dur > 0 ? (t - seg.at) / seg.dur : 1;
  if (u >= 1) return seg.to;
  const [a, b] = profileRamps(seg.profile, seg.ramp);
  const p = rampProgress(u, a, b);
  if (p <= 0) return seg.from;
  const mix = (x: number, y: number): number => x + (y - x) * p;
  return {
    inner: blendAround(seg.from.inner, seg.to.inner, p),
    outer: blendAround(seg.from.outer, seg.to.outer, p),
    center: [mix(seg.from.center[0], seg.to.center[0]), mix(seg.from.center[1], seg.to.center[1])],
    radius: mix(seg.from.radius, seg.to.radius),
    atmosphere: blendAround(seg.from.atmosphere, seg.to.atmosphere, p),
    vignette: mix(seg.from.vignette, seg.to.vignette),
  };
}

/** The track of the background keys of a shot. Keys chain: each takes over from what the background is at its moment. */
export function buildBackgroundTrack(base: BackgroundState, changes: readonly BackgroundChange[]): BackgroundTrack {
  const segs: BackgroundSeg[] = [];
  for (const k of changes.slice().sort((p, q) => p.at - q.at)) {
    const from = sampleBackground({ base, segs }, k.at);
    segs.push({ at: k.at, dur: k.dur, profile: k.profile, ramp: k.ramp, from, to: { ...from, ...k.to } });
  }
  return { base, segs };
}

/**
 * How far the background changes from one state to another, as the largest
 * change of any of its values, each as a share of its full range: a channel of
 * a colour, the vignette, the place and the size of the gradient.
 */
export function backgroundChange(a: BackgroundState, b: BackgroundState): number {
  if (a === b) return 0;
  let most = Math.max(Math.abs(a.vignette - b.vignette), Math.abs(a.radius - b.radius), Math.abs(a.center[0] - b.center[0]), Math.abs(a.center[1] - b.center[1]));
  for (const [x, y] of [[a.inner, b.inner], [a.outer, b.outer], [a.atmosphere, b.atmosphere]] as const) {
    if (x === y) continue;
    const p = parseHex(x);
    const q = parseHex(y);
    most = Math.max(most, Math.abs(p.r - q.r) / 255, Math.abs(p.g - q.g) / 255, Math.abs(p.b - q.b) / 255);
  }
  return most;
}

/**
 * How far the background changes between two moments, t0 before t1, as a share
 * of the full range of its values. It is worked out from the change that is
 * under way at t1 and not from the colours of the two moments, which are held
 * to 8 bits and would give steps where the change is even.
 */
export function backgroundStep(track: BackgroundTrack, t0: number, t1: number): number {
  let seg: BackgroundSeg | null = null;
  for (const s of track.segs) {
    if (t1 >= s.at) seg = s;
    else break;
  }
  if (!seg) return 0;
  const [a, b] = profileRamps(seg.profile, seg.ramp);
  const at = (t: number): number => (seg.dur > 0 ? rampProgress(Math.min(1, Math.max(0, (t - seg.at) / seg.dur)), a, b) : t >= seg.at ? 1 : 0);
  return Math.abs(at(t1) - at(t0)) * backgroundChange(seg.from, seg.to);
}
