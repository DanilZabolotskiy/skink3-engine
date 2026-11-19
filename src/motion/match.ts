// Helpers for an outline that changes (`reshape`): two outlines of any number
// of points made to match point for point, and the moment at which an outline
// on its way from one to the other first holds a place.
//
// Both are plain functions of their arguments: a scene calls them while it is
// built, and gives what they return to `region`, `stroke`, `reshape` and the
// keys of what appears.

import type { Vec2 } from '../core/math.ts';
import { DEFAULT_RAMP, profileRamps, rampProgress, type MoveProfile } from './curves.ts';

/** Most points an outline of the engine may have: as many as a region that is drawn flat (see `region`). */
const MAX_POINTS = 4000;

function outline(where: string, name: string, value: unknown, least: number): Vec2[] {
  if (!Array.isArray(value) || value.length < least) throw new Error(`${where}: ${name} must be a list of at least ${least} points [x, y]`);
  return value.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error(`${where}: ${name}[${i}] must be a point [x, y] of two finite numbers`);
    return [p[0], p[1]] as Vec2;
  });
}

/** Twice the area of a closed outline; positive when its points run clockwise on screen (y down). */
function turnOf(points: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum;
}

/** `n` points along a line through `points`, each the same share of its length after the one before; a closed line returns to its first point. */
function spread(points: readonly Vec2[], n: number, closed: boolean): Vec2[] {
  const spans = closed ? points.length : points.length - 1;
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i < spans; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    lens.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
    total += lens[i]!;
  }
  const out: Vec2[] = [];
  let span = 0;
  let before = 0;
  for (let k = 0; k < n; k++) {
    const want = closed ? (total * k) / n : (total * k) / (n - 1);
    while (span < spans - 1 && before + lens[span]! < want) before += lens[span++]!;
    const a = points[span]!;
    const b = points[(span + 1) % points.length]!;
    const u = lens[span]! > 0 ? Math.min(1, (want - before) / lens[span]!) : 0;
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return out;
}

/**
 * Two outlines made to match point for point, for a `reshape` from the first
 * to the second: each is returned as the same number of points, a set share
 * of its own length apart.
 *
 * Closed outlines (the default) are both turned clockwise, the first starts
 * at its first point, and the second starts where the points have the least
 * way to go in all, so neither the place the lists start from nor the way
 * round they are given matters. Lines that are not closed (`closed: false`)
 * are matched from their first points to their last.
 *
 * `points`: how many (the larger of the two counts and 24 unless given; 4000
 * at most, as a region that is drawn flat has, and 600 for one that is lit).
 */
export function matchPoints(from: readonly Vec2[], to: readonly Vec2[], opts: { points?: number; closed?: boolean } = {}): [Vec2[], Vec2[]] {
  const where = 'matchPoints';
  for (const key of Object.keys(opts)) if (key !== 'points' && key !== 'closed') throw new Error(`${where}: unknown option "${key}" (allowed: points, closed)`);
  if (opts.closed !== undefined && typeof opts.closed !== 'boolean') throw new Error(`${where}: closed must be true or false`);
  const closed = opts.closed ?? true;
  const least = closed ? 3 : 2;
  const a = outline(where, 'the first outline', from, least);
  const b = outline(where, 'the second outline', to, least);
  const n = opts.points ?? Math.min(MAX_POINTS, Math.max(a.length, b.length, 24));
  if (!Number.isInteger(n) || n < least || n > MAX_POINTS) throw new Error(`${where}: points must be a whole number in ${least}..${MAX_POINTS}, got ${String(opts.points)}`);
  if (!closed) return [spread(a, n, false), spread(b, n, false)];
  if (turnOf(a) === 0 || turnOf(b) === 0) throw new Error(`${where}: a closed outline must enclose an area; for lines, give closed: false`);
  // An outline given the other way round is read backwards from its first point, which stays its first.
  const clockwise = (points: Vec2[]): Vec2[] => (turnOf(points) > 0 ? points : [points[0]!, ...points.slice(1).reverse()]);
  const first = spread(clockwise(a), n, true);
  const second = spread(clockwise(b), n, true);
  // The start of the second outline that gives the points the least way to go: the sum of the squares of their ways.
  let best = 0;
  let least2 = Infinity;
  for (let shift = 0; shift < n; shift++) {
    let sum = 0;
    for (let i = 0; i < n && sum < least2; i++) {
      const p = first[i]!;
      const q = second[(i + shift) % n]!;
      sum += (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
    }
    if (sum < least2) [least2, best] = [sum, shift];
  }
  return [first, second.map((_, i) => second[(i + best) % n]!)];
}

/** True when the straight outline through the points, each `p` of its way from `from` to `to`, holds the place. */
function holds(from: readonly Vec2[], to: readonly Vec2[], p: number, [x, y]: Vec2): boolean {
  const n = from.length;
  let inside = false;
  let jx = from[n - 1]![0] + (to[n - 1]![0] - from[n - 1]![0]) * p;
  let jy = from[n - 1]![1] + (to[n - 1]![1] - from[n - 1]![1]) * p;
  for (let i = 0; i < n; i++) {
    const ix = from[i]![0] + (to[i]![0] - from[i]![0]) * p;
    const iy = from[i]![1] + (to[i]![1] - from[i]![1]) * p;
    if (iy > y !== jy > y && x < ((jx - ix) * (y - iy)) / (jy - iy) + ix) inside = !inside;
    jx = ix;
    jy = iy;
  }
  return inside;
}

/**
 * When an outline that is reshaped from `from` to `to` first holds a place:
 * the share of the `dur` of that `reshape`, 0 when the first outline holds it
 * already, and `undefined` when the outline never does. So a thing at that
 * place appears as the edge passes it: `at: key.at + key.dur * share`.
 *
 * The two outlines match point for point (see `matchPoints`), and `profile`
 * and `ramp` are those of the `reshape` (its defaults unless given). The
 * outline is taken with straight edges, as `smooth: 0` draws it.
 */
export function reachedAt(from: readonly Vec2[], to: readonly Vec2[], place: Vec2, opts: { profile?: Exclude<MoveProfile, 'settle'>; ramp?: number } = {}): number | undefined {
  const where = 'reachedAt';
  for (const key of Object.keys(opts)) if (key !== 'profile' && key !== 'ramp') throw new Error(`${where}: unknown option "${key}" (allowed: profile, ramp)`);
  const a = outline(where, 'the first outline', from, 3);
  const b = outline(where, 'the second outline', to, 3);
  if (a.length !== b.length) throw new Error(`${where}: the two outlines must have as many points (${a.length} and ${b.length}); matchPoints(from, to) makes them so`);
  const [spot] = outline(where, 'the place', [place], 1);
  const profile = opts.profile ?? 'ease';
  if (!['ease', 'steady', 'in', 'out'].includes(profile)) throw new Error(`${where}: profile must be one of ease, steady, in, out, got ${JSON.stringify(opts.profile)}`);
  if (opts.ramp !== undefined && profile === 'steady') throw new Error(`${where}: ramp applies to the profiles ease, in and out`);
  const ramp = opts.ramp ?? DEFAULT_RAMP;
  if (!Number.isFinite(ramp) || ramp < 0.02 || ramp > 0.5) throw new Error(`${where}: ramp must be a number in 0.02..0.5, got ${String(opts.ramp)}`);
  if (holds(a, b, 0, spot!)) return 0;
  // The first step of the way at which the outline holds the place, then the moment between it and the step before.
  const STEPS = 128;
  let step = 1;
  while (step <= STEPS && !holds(a, b, step / STEPS, spot!)) step++;
  if (step > STEPS) return undefined;
  let lo = (step - 1) / STEPS;
  let hi = step / STEPS;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (holds(a, b, mid, spot!)) hi = mid;
    else lo = mid;
  }
  // The share of the duration at which the profile has come that far: the profile only rises.
  const [up, down] = profileRamps(profile, ramp);
  let early = 0;
  let late = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (early + late) / 2;
    if (rampProgress(mid, up, down) < hi) early = mid;
    else late = mid;
  }
  return late;
}
