// Drive shot: 10 seconds of things that follow a computed function of time,
// with neutral content, on a flat layer.
//
// On the left a sheet curls into a tube and unrolls again, and the mark on
// its outer face bends with it: the outline of the sheet and the line of the
// mark are worked out for every frame. On the right a body goes round a
// centre on an orbit that winds inward, along the path that is drawn ahead of
// it, and a trail follows it. Below, a ball sinks through a surface, and the
// ring where the surface cuts it grows and shrinks as the square root says.
//
// It shows: drive() with a function of time on the place, the scale, the
// opacity and the points of a region and of a stroke.

import { circle, drive, layer, rect, region, shot, stroke, Rng, type StringTables, type Vec2 } from 'skink3-engine';
import { palette } from '../demo/palette.ts';

const SEED = 20261120;
const SECONDS = 10;
const strings: StringTables = { en: {} };

/** 0 to 1 over half the shot, from rest to rest. */
const there = (seconds: number): number => {
  const u = Math.min(1, Math.max(0, seconds / (SECONDS / 2)));
  return u * u * (3 - 2 * u);
};
/** There and back again over the whole shot. */
const andBack = (seconds: number): number => (seconds <= SECONDS / 2 ? there(seconds) : there(SECONDS - seconds));

// --- The sheet: a region whose outline is worked out at every frame ---------

const SHEET: Vec2 = [-520, -60];
const LENGTH = 520;
const HALF_WIDTH = 150;
const ALONG = 28;
/** A point of the sheet, s along it and w across it, when it is curled by `curl` turns: seen from the side and a little from above. */
const onSheet = (s: number, w: number, curl: number): Vec2 => {
  const angle = 2 * Math.PI * curl;
  // A flat sheet is the limit of a very wide curl.
  const x = angle < 1e-6 ? s : (LENGTH / angle) * Math.sin((s / LENGTH) * angle);
  const up = angle < 1e-6 ? 0 : (LENGTH / angle) * (1 - Math.cos((s / LENGTH) * angle));
  return [SHEET[0] + x * 0.9 + w * 0.5, SHEET[1] - up + x * 0.25 - w * 0.42];
};
const outlineAt = (curl: number): Vec2[] => [
  ...Array.from({ length: ALONG }, (_, i) => onSheet((LENGTH * i) / (ALONG - 1), HALF_WIDTH, curl)),
  ...Array.from({ length: ALONG }, (_, i) => onSheet(LENGTH - (LENGTH * i) / (ALONG - 1), -HALF_WIDTH, curl)),
];
/** The mark on the sheet: a closed line near its first edge. */
const MARK: Vec2[] = Array.from({ length: 16 }, (_, i) => [90 + 55 * Math.cos((2 * Math.PI * i) / 16), 85 * Math.sin((2 * Math.PI * i) / 16)] as Vec2);
const markAt = (curl: number): Vec2[] => MARK.map(([s, w]) => onSheet(s, w, curl));
const curlAt = (seconds: number): number => 0.82 * andBack(seconds);

// --- The orbit: a place that follows a spiral, and the trail behind it -------

const SUN: Vec2 = [520, -120];
const orbitAt = (seconds: number): Vec2 => {
  const angle = 0.5 + 1.5 * seconds;
  const r = 330 - 21 * seconds;
  return [SUN[0] + r * Math.cos(angle), SUN[1] + 0.62 * r * Math.sin(angle)];
};
const TRAIL = 18;
const trailAt = (seconds: number): Vec2[] => Array.from({ length: TRAIL }, (_, i) => orbitAt(seconds - 0.05 * i));
const AHEAD: Vec2[] = Array.from({ length: 80 }, (_, i) => orbitAt((SECONDS * i) / 79));

// --- The ring: a size that follows a square root ----------------------------

const POOL: Vec2 = [0, 330];
const BALL = 70;
/** How deep the middle of the ball is below the surface. */
const sinkAt = (seconds: number): number => -150 + 300 * there(seconds / 2);
const cutAt = (seconds: number): number => Math.sqrt(Math.max(0, 1 - (sinkAt(seconds) / BALL) ** 2));

const rng = new Rng(SEED, 'far');
const far = Array.from({ length: 26 }, (_, i) => circle({ id: `far${i}`, at: [rng.range(-1400, 1400), rng.range(-800, 800)], r: rng.range(5, 11), fill: 'mid.violet', lit: false, opacity: 0.5 }));

export default shot({
  id: 'drive',
  seconds: SECONDS,
  seed: SEED,
  palette,
  strings,
  background: { inner: 'deep.night', outer: 'deep.abyss' },
  atmosphere: 'mid.mist',
  layers: [
    layer({ id: 'far', depth: 1.6, nodes: far }),
    layer({
      id: 'stage',
      depth: 0,
      nodes: [
        region({ id: 'sheet', points: outlineAt(0), smooth: 0, fill: 'mid.ocean', lit: false }),
        stroke({ id: 'mark', points: markAt(0), closed: true, color: 'light.cream', width: 9 }),
        stroke({ id: 'ahead', points: AHEAD, color: 'mid.violet', width: 5, dash: [0, 22] }),
        circle({ id: 'sun', at: SUN, r: 54, fill: 'accent.amber', glow: 0.6, idle: { amp: 4, period: 5 } }),
        stroke({ id: 'trail', points: trailAt(0), color: 'accent.aqua', width: 8, opacity: 0.55 }),
        circle({ id: 'body', at: orbitAt(0), r: 26, fill: 'accent.aqua', glow: 0.4 }),
        // The ball is drawn only above the surface: it is clipped to the air.
        rect({ id: 'air', at: [POOL[0], POOL[1] - 300], w: 700, h: 600, radius: 0, fill: 'deep.night', lit: false, opacity: 0 }),
        circle({ id: 'ball', at: [POOL[0] - 190, POOL[1] + sinkAt(0)], r: BALL, fill: 'accent.coral', clipTo: 'air' }),
        stroke({ id: 'surface', points: [[POOL[0] - 330, POOL[1]], [POOL[0] - 50, POOL[1]]], color: 'light.cream', width: 7, smooth: 0 }),
        // Seen from above: the ring where the surface cuts the ball.
        stroke({ id: 'ring', at: [POOL[0] + 190, POOL[1] - 40], points: Array.from({ length: 24 }, (_, i) => [BALL * Math.cos((2 * Math.PI * i) / 24), BALL * Math.sin((2 * Math.PI * i) / 24)] as Vec2), closed: true, color: 'accent.coral', width: 10 }),
      ],
    }),
  ],
  timeline: [
    drive('sheet', { dur: SECONDS, by: (t) => ({ points: outlineAt(curlAt(t)) }) }),
    drive('mark', { dur: SECONDS, by: (t) => ({ points: markAt(curlAt(t)) }) }),
    drive('body', { dur: SECONDS, by: (t) => ({ at: orbitAt(t) }) }),
    drive('trail', { dur: SECONDS, by: (t) => ({ points: trailAt(t) }) }),
    drive('ball', { dur: SECONDS, by: (t) => ({ at: [POOL[0] - 190, POOL[1] + sinkAt(t)] }) }),
    // A square root leaves its zero at once: the ring would pop into view. It fades in with the square of its size instead.
    drive('ring', { dur: SECONDS, by: (t) => ({ scale: cutAt(t), opacity: Math.min(1, 3 * cutAt(t) ** 2) }) }),
  ],
});
