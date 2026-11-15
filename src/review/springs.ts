// Springs: what every spring-driven node does after it is disturbed. A response
// starts when the node leaves its rest place (where it would be without the
// spring) and ends when it is back within half a pixel of it.

import { FPS } from '../core/time.ts';
import { finding, type Finding } from './detect.ts';
import { visibleAt, type MotionSeries, type SpringSeries } from './series.ts';
import { T } from './thresholds.ts';

export interface SpringResponse {
  /** First and last frame at which the node is away from its rest place. */
  readonly from: number;
  readonly to: number;
  /** Largest distance from the rest place, in px: how far it lagged. */
  readonly lagPx: number;
  /** How far it then passed the rest place on the other side, in px; 0 when it never did. */
  readonly overshootPx: number;
  /** Swings past the rest place large enough to see, counted once the target has come to rest (over the whole response if it never does). */
  readonly swings: number;
  /** Seconds from the moment the target came to rest to the last visible swing; null while the target keeps moving. */
  readonly ringSeconds: number | null;
  /** Seconds from that moment until the node stayed at its rest place; null when the shot ends first or the target keeps moving. */
  readonly settleSeconds: number | null;
}

export interface SpringReport {
  readonly id: string;
  readonly kind: 'follow' | 'sway';
  readonly f: number;
  readonly z: number;
  readonly r: number;
  readonly responses: readonly SpringResponse[];
}

/** Frames of quiet that still belong to one response: a swing passes through its rest place. */
const MERGE_GAP = 8;

const round = (v: number, digits = 2): number => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

function analyse(series: MotionSeries, s: SpringSeries, findings: Finding[]): SpringReport {
  const F = series.frames;
  const placed = series.placed[s.node.index]!;
  const zoom = series.views[s.node.layer]!.zoom;
  const ex = new Float64Array(F);
  const ey = new Float64Array(F);
  const mag = new Float64Array(F);
  const target = new Float64Array(F);
  for (let f = 0; f < F; f++) {
    if (!visibleAt(placed, f)) continue;
    ex[f] = (s.x[f]! - s.restX[f]!) * zoom[f]!;
    ey[f] = (s.y[f]! - s.restY[f]!) * zoom[f]!;
    mag[f] = Math.hypot(ex[f]!, ey[f]!);
    if (f > 0) target[f] = Math.hypot(s.restX[f]! - s.restX[f - 1]!, s.restY[f]! - s.restY[f - 1]!) * zoom[f]!;
  }

  // Stretches away from the rest place, joined across the short quiet of a zero crossing.
  const spans: [number, number][] = [];
  let start = -1;
  let last = -1;
  for (let f = 0; f < F; f++) {
    if (mag[f]! < T.springSettlePx) continue;
    if (start >= 0 && f - last > MERGE_GAP) {
      spans.push([start, last]);
      start = -1;
    }
    if (start < 0) start = f;
    last = f;
  }
  if (start >= 0) spans.push([start, last]);

  const responses: SpringResponse[] = [];
  for (const [a, b] of spans) {
    let p = a;
    for (let f = a; f <= b; f++) if (mag[f]! > mag[p]!) p = f;
    const lag = mag[p]!;
    if (lag < T.springMinResponsePx) continue;
    // Along the line of the largest lag: positive is behind the target, negative is past it.
    const ux = ex[p]! / lag;
    const uy = ey[p]! / lag;
    const lobes: { sign: number; peak: number; at: number }[] = [{ sign: 1, peak: lag, at: p }];
    for (let f = p + 1; f <= b; f++) {
      const v = ex[f]! * ux + ey[f]! * uy;
      if (v === 0) continue;
      const sign = v > 0 ? 1 : -1;
      const lobe = lobes[lobes.length - 1]!;
      if (sign !== lobe.sign) lobes.push({ sign, peak: Math.abs(v), at: f });
      else if (Math.abs(v) > lobe.peak) {
        lobe.peak = Math.abs(v);
        lobe.at = f;
      }
    }
    const overshoot = lobes[1]?.peak ?? 0;

    // When the target came to rest.
    let peakTarget = 0;
    for (let f = Math.max(1, a - 10); f <= b; f++) peakTarget = Math.max(peakTarget, target[f]!);
    const rest = Math.max(T.restPx, T.restShare * peakTarget);
    let stopped = a;
    for (let f = a; f <= b; f++) if (target[f]! > rest) stopped = f;
    const targetRests = stopped < b - 1;
    // While the target still moves, the spring is driven; its free swings are those that follow.
    const visible = lobes.slice(1).filter((l) => l.peak >= T.springVisiblePx && (!targetRests || l.at > stopped));
    const cut = b >= F - 1;
    const lastSwing = visible.length > 0 ? visible[visible.length - 1]!.at : null;
    const ring = !targetRests ? null : lastSwing === null ? 0 : Math.max(0, lastSwing - stopped) / FPS;
    const settle = targetRests && !cut ? (b - stopped) / FPS : null;
    responses.push({
      from: a,
      to: b,
      lagPx: round(lag),
      overshootPx: round(overshoot),
      swings: visible.length,
      ringSeconds: ring === null ? null : round(ring),
      settleSeconds: settle === null ? null : round(settle),
    });

    if (ring !== null && ring > T.springRingSeconds && lastSwing !== null) {
      findings.push(
        finding('spring-ringing', s.id, 'spring', stopped, lastSwing, ring, T.springRingSeconds, 's',
          `still swings visibly ${ring.toFixed(1)} s after its target stopped at frame ${stopped} (${visible.length} swings past the rest place; f ${s.params.f}, z ${s.params.z})`),
      );
    }
    if (s.params.z <= T.springBouncyDamping && lag >= T.springClearResponsePx && overshoot < T.springVisiblePx && targetRests && !cut) {
      findings.push(
        finding('spring-no-overshoot', s.id, 'spring', a, b, overshoot, T.springVisiblePx, 'px',
          `lagged ${lag.toFixed(1)} px behind its target and came to rest without passing it (overshoot ${overshoot.toFixed(2)} px, visible from ${T.springVisiblePx} px; z ${s.params.z} is set to bounce)`,
          lag / T.springClearResponsePx),
      );
    }
  }
  return { id: s.id, kind: s.kind, f: s.params.f, z: s.params.z, r: s.params.r, responses };
}

/** Responses of every spring of the shot, and the findings about them. */
export function detectSprings(series: MotionSeries): { springs: SpringReport[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const springs = series.springs.map((s) => analyse(series, s, findings));
  return { springs, findings };
}
