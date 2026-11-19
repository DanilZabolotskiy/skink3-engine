// Dead areas: stretches in which nothing moves on its own in a part of the
// frame, or in all of it.
//
// "Alive" means that something visible there changes by itself: a node moves,
// turns, grows, fades, blinks or changes its outline, a pulse runs along a link, a link or a stroke
// is being drawn, the dashes of a stroke close, a light runs along a stroke, a
// link sags or pulls taut, a link or a stroke grows thick or thins, a particle
// travels, or the background itself
// changes (which is seen everywhere). The camera is left out on purpose: its
// drift slides the whole picture, and a picture that only slides is still a
// hold. The camera of a perspective layer is left out in the same way: a
// node of such a layer is alive while it, or something it is in, moves in the
// space of the layer. An area with nothing in it counts as dead too.
//
// The frame is cut into a grid of 3 x 2 regions. A thing is counted in every
// region that the circle around it touches, which errs toward "alive".

import { DEG } from '../core/math.ts';
import { FPS } from '../core/time.ts';
import { FRAME_REGIONS, FRAME_SUBJECT } from '../scene/types.ts';
import { finding, type Finding } from './detect.ts';
import { DRAWN, REGION_COLS, REGION_ROWS, regionsOf, visibleAt, type MotionSeries, type PlacedSeries } from './series.ts';
import { T } from './thresholds.ts';

const REGIONS = REGION_COLS * REGION_ROWS;

/**
 * The nodes of perspective layers: per frame, 1 while the node, or something
 * it is in, moves, turns or grows in the space of its layer. By node index;
 * null for the nodes of flat layers and for what nothing animates.
 */
function spaceMoves(series: MotionSeries): (Uint8Array | null)[] {
  const c = series.shot;
  const F = series.frames;
  const out: (Uint8Array | null)[] = series.placed.map(() => null);
  const fill = (s: PlacedSeries, up: Uint8Array | null): void => {
    const zoom = series.views[s.node.layer]!.zoom;
    const moves = new Uint8Array(F);
    for (let f = 1; f < F; f++) {
      const u = s.unit[f]!;
      moves[f] =
        (up !== null && up[f] === 1) ||
        Math.hypot(s.ownX[f]! - s.ownX[f - 1]!, s.ownY[f]! - s.ownY[f - 1]!) * u >= T.alivePx ||
        Math.abs(s.ownRot[f]! - s.ownRot[f - 1]!) * DEG * s.turnRadius * s.scale[f]! * zoom[f]! >= T.alivePx ||
        Math.abs(s.ownScale[f]! - s.ownScale[f - 1]!) * s.radius * u >= T.alivePx
          ? 1
          : 0;
    }
    out[s.node.index] = moves;
  };
  // Parents come before their children in the node list. A label takes what its target does, so labels come last.
  for (const s of series.placed) {
    if (!s || s.still || s.type === 'label' || !c.layers[s.node.layer]!.persp) continue;
    fill(s, s.node.parent >= 0 ? out[s.node.parent] ?? null : null);
  }
  for (const s of series.placed) {
    if (!s || s.still || s.type !== 'label' || !c.layers[s.node.layer]!.persp) continue;
    fill(s, out[s.node.targetIndex] ?? null);
  }
  return out;
}

/** Per frame, the regions (as bits) in which something moves on its own. Frame 0 takes the value of frame 1. */
export function aliveRegions(series: MotionSeries): Uint8Array {
  const F = series.frames;
  const alive = new Uint8Array(F);
  const inSpace = series.shot.spatial ? spaceMoves(series) : null;
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
        const mine = inSpace ? inSpace[s.node.index]! : null;
        // What is measured at the size of the node (how much of a line is drawn, a keyed outline, a width): in a
        // perspective layer that size changes with the camera, so there the step is taken at the size of this frame.
        const hold = mine === null ? 1 : s.scale[f - 1]! > 1e-9 ? s.scale[f]! / s.scale[f - 1]! : NaN;
        moves =
          (mine !== null
            ? mine[f] === 1
            : Math.hypot(s.x[f]! - s.x[f - 1]!, s.y[f]! - s.y[f - 1]!) * zoom >= T.alivePx ||
              Math.abs(s.rot[f]! - s.rot[f - 1]!) * DEG * s.turnRadius * k >= T.alivePx ||
              Math.abs(s.scale[f]! - s.scale[f - 1]!) * s.radius * zoom >= T.alivePx) ||
          Math.abs(s.alpha[f]! - s.alpha[f - 1]!) >= T.aliveOpacity ||
          (s.open !== null && Math.abs(s.open[f]! - s.open[f - 1]!) * s.radius * k >= T.alivePx) ||
          (s.level !== null && Math.abs(s.level[f]! - s.level[f - 1]!) * zoom >= T.alivePx) ||
          (s.life !== null && Math.abs(s.life[f]! - s.life[f - 1]! * hold) * zoom >= T.alivePx) ||
          // The way of a driven outline is summed step by step: it holds no size to take out.
          (s.outline !== null && Math.abs(s.outline[f]! - s.outline[f - 1]! * (s.node.form?.drive ? 1 : hold)) * zoom >= T.alivePx) ||
          // A width that changes moves the edge of the line by half the change.
          (s.width !== null && (Math.abs(s.width[f]! - s.width[f - 1]! * hold) / 2) * zoom >= T.alivePx) ||
          (s.axis !== null && Math.max(Math.abs(s.axis.sx[f]! - s.axis.sx[f - 1]!), Math.abs(s.axis.sy[f]! - s.axis.sy[f - 1]!)) * s.radius * k >= T.alivePx);
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
  // A background that changes is seen in every part of the frame.
  if (series.background) {
    for (let f = 1; f < F; f++) if (series.background[f]! >= T.aliveBackground) alive[f] = (1 << REGIONS) - 1;
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
