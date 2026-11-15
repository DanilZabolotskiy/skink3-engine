// Dead areas: stretches in which nothing moves on its own in a part of the
// frame, or in all of it.
//
// "Alive" means that something visible there changes by itself: a node moves,
// turns, grows, fades or blinks, a pulse runs along a link or a link is being
// drawn, a particle travels. The camera is left out on purpose: its drift
// slides the whole picture, and a picture that only slides is still a hold.
// An area with nothing in it counts as dead too.
//
// The frame is cut into a grid of 3 x 2 regions. A thing is counted in every
// region that the circle around it touches, which errs toward "alive".

import { DEG } from '../core/math.ts';
import { FPS } from '../core/time.ts';
import { FRAME_REGIONS, FRAME_SUBJECT } from '../scene/types.ts';
import { finding, type Finding } from './detect.ts';
import { DRAWN, REGION_COLS, REGION_ROWS, regionsOf, visibleAt, type MotionSeries } from './series.ts';
import { T } from './thresholds.ts';

const REGIONS = REGION_COLS * REGION_ROWS;

/** Per frame, the regions (as bits) in which something moves on its own. Frame 0 takes the value of frame 1. */
export function aliveRegions(series: MotionSeries): Uint8Array {
  const F = series.frames;
  const alive = new Uint8Array(F);
  for (const s of series.placed) {
    if (!s || s.type === 'group' || s.still) continue;
    const view = series.views[s.node.layer]!;
    for (let f = 1; f < F; f++) {
      const now = visibleAt(s, f);
      const before = visibleAt(s, f - 1);
      if (!now && !before) continue;
      const g = now ? f : f - 1;
      const zoom = view.zoom[g]!;
      const r = s.radius * s.scale[g]! * zoom;
      if (r < T.minRadiusPx) continue;
      let moves = now !== before;
      if (!moves) {
        const k = s.scale[f]! * zoom;
        moves =
          Math.hypot(s.x[f]! - s.x[f - 1]!, s.y[f]! - s.y[f - 1]!) * zoom >= T.alivePx ||
          Math.abs(s.rot[f]! - s.rot[f - 1]!) * DEG * s.turnRadius * k >= T.alivePx ||
          Math.abs(s.scale[f]! - s.scale[f - 1]!) * s.radius * zoom >= T.alivePx ||
          Math.abs(s.alpha[f]! - s.alpha[f - 1]!) >= T.aliveOpacity ||
          (s.open !== null && Math.abs(s.open[f]! - s.open[f - 1]!) * s.radius * k >= T.alivePx);
      }
      if (moves) alive[f] = alive[f]! | regionsOf(s.x[g]! * zoom + view.tx[g]!, s.y[g]! * zoom + view.ty[g]!, r);
    }
  }
  for (const l of series.links) {
    const view = series.views[l.node.layer]!;
    for (let f = 1; f < F; f++) {
      const g = (l.flags[f]! & DRAWN) !== 0 ? f : (l.flags[f - 1]! & DRAWN) !== 0 ? f - 1 : -1;
      if (g < 0) continue;
      if (!l.active[f] && Math.abs(l.presence[f]! - l.presence[f - 1]!) < T.aliveOpacity) continue;
      const zoom = view.zoom[g]!;
      alive[f] = alive[f]! | regionsOf(l.x[g]! * zoom + view.tx[g]!, l.y[g]! * zoom + view.ty[g]!, l.half[g]! * zoom);
    }
  }
  for (const e of series.emitters) {
    for (let f = 1; f < F; f++) alive[f] = alive[f]! | e.regions[f]!;
  }
  if (F > 1) alive[0] = alive[1]!;
  return alive;
}

/** Holds of the whole frame and of its regions that last too long. */
export function detectDead(series: MotionSeries): Finding[] {
  const F = series.frames;
  const alive = aliveRegions(series);
  const out: Finding[] = [];
  const holds = (mask: number, limit: number): [number, number][] => {
    const runs: [number, number][] = [];
    let start = -1;
    for (let f = 0; f <= F; f++) {
      const dead = f < F && (alive[f]! & mask) === 0;
      if (dead && start < 0) start = f;
      if (!dead && start >= 0) {
        if ((f - start) / FPS > limit) runs.push([start, f - 1]);
        start = -1;
      }
    }
    return runs;
  };
  const whole = holds((1 << REGIONS) - 1, T.holdSeconds);
  for (const [a, b] of whole) {
    const seconds = (b - a + 1) / FPS;
    out.push(finding('dead-area', FRAME_SUBJECT, 'hold', a, b, seconds, T.holdSeconds, 's', `nothing in the whole frame moves on its own for ${seconds.toFixed(1)} s`));
  }
  for (let r = 0; r < REGIONS; r++) {
    for (const [a, b] of holds(1 << r, T.regionHoldSeconds)) {
      // A hold of the whole frame already says it.
      const covered = whole.some(([wa, wb]) => Math.min(b, wb) - Math.max(a, wa) + 1 >= 0.8 * (b - a + 1));
      if (covered) continue;
      const seconds = (b - a + 1) / FPS;
      out.push(
        finding('dead-area', `(frame:${FRAME_REGIONS[r]!})`, 'hold', a, b, seconds, T.regionHoldSeconds, 's',
          `nothing in the ${FRAME_REGIONS[r]!.replace('-', ' ')} part of the frame moves on its own for ${seconds.toFixed(1)} s`),
      );
    }
  }
  return out;
}
