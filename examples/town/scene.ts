// Town shot: 8 seconds of bodies that stand on a tilted plane, with neutral
// content.
//
// A walled town lies on a plain by a river, seen from above and to one side.
// Its houses have gables and hips, a hall carries a dome on a drum, a round
// tower ends in a cone, a long house has an arcade and a block has rows of
// windows. A wall goes round the town, and huts are scattered over the plain
// as far as the eye reaches. Every body throws a shadow on the ground. The
// camera goes slowly round, and the block rises out of the ground.
//
// It shows: roof (gable, hip, cone, dome) and openings on shapes with a rise,
// and on a group cast (the shadows of its bodies), sort: 'depth' (far to
// near for the camera of each frame, a wall stretch by stretch) and detail
// (far huts are drawn plain: their tops alone). Run it from the repository
// root:
//
//   node bin/skink3.mjs check examples/town/scene.ts
//   node bin/skink3.mjs still examples/town/scene.ts --time 4
//   node bin/skink3.mjs strip examples/town/scene.ts --from 60 --count 6 --step 40

import { circle, group, layer, perspectiveTo, rect, riseTo, Rng, shot, stroke, type SceneNode, type Vec2 } from 'skink3-engine';
import { palette } from '../demo/palette.ts';

const SEED = 11;
const rng = new Rng(SEED, 'town');

/** The wall: a closed line round the middle of the plain, a little out of round. */
const wallAt = (angle: number): number => 620 * (1 + 0.06 * Math.sin(3 * angle) + 0.04 * Math.cos(5 * angle));
const WALL: Vec2[] = Array.from({ length: 28 }, (_, i) => {
  const a = (i / 28) * Math.PI * 2;
  return [Math.cos(a) * wallAt(a), Math.sin(a) * wallAt(a) * 0.82];
});

const RIVER: Vec2[] = [[-2600, -420], [-1500, -300], [-700, -180], [-380, -40], [-80, 40], [240, 30], [560, 130], [1300, 260], [2600, 300]];

/** How far a place is from the middle of the river. */
function riverDistance(x: number, y: number): number {
  let least = Infinity;
  for (let i = 0; i + 1 < RIVER.length; i++) {
    const a = RIVER[i]!;
    const b = RIVER[i + 1]!;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)));
    least = Math.min(least, Math.hypot(x - a[0] - (b[0] - a[0]) * t, y - a[1] - (b[1] - a[1]) * t));
  }
  return least;
}

/** The large buildings: where each stands and how much room it takes. */
const HALL: Vec2 = [-220, -260];
const TOWER: Vec2 = [260, -200];
const LONG: Vec2 = [120, 280];
const BLOCK: Vec2 = [-330, 200];
const ROOM: readonly (readonly [Vec2, number])[] = [[HALL, 150], [TOWER, 90], [LONG, 180], [BLOCK, 110]];

const ROOFS = ['accent.coral', 'accent.amber', 'mid.rose', 'accent.coral', 'mid.violet'] as const;
const WALLS = ['light.cream', 'light.snow', 'light.mint'] as const;
const pick = <T>(list: readonly T[]): T => list[Math.floor(rng.next() * list.length)]!;

/** Houses inside the wall, clear of it, of the river and of the large buildings. */
const houses: SceneNode[] = [];
for (let tries = 0; houses.length < 260 && tries < 20000; tries++) {
  const a = rng.next() * Math.PI * 2;
  const d = Math.sqrt(rng.next()) * (wallAt(a) - 70);
  const x = Math.cos(a) * d;
  const y = Math.sin(a) * d * 0.82;
  if (riverDistance(x, y) < 75 || ROOM.some(([at, r]) => Math.hypot(x - at[0], y - at[1]) < r)) continue;
  const w = 26 + 18 * rng.next();
  const h = 18 + 12 * rng.next();
  houses.push(
    rect({
      id: `house-${houses.length}`,
      at: [x, y],
      rotation: Math.round(rng.next() * 4) * 22.5,
      w,
      h,
      radius: 0,
      lit: false,
      fill: pick(ROOFS),
      side: pick(WALLS),
      rise: 14 + 14 * rng.next(),
      roof: { kind: rng.next() < 0.75 ? 'gable' : 'hip', height: h * 0.45 },
    }),
  );
}

/** Huts over the plain outside the wall, as far as it reaches. */
const huts: SceneNode[] = [];
for (let tries = 0; huts.length < 1400 && tries < 40000; tries++) {
  const x = (rng.next() * 2 - 1) * 2500;
  const y = (rng.next() * 2 - 1) * 1850;
  const a = Math.atan2(y / 0.82, x);
  if (Math.hypot(x, y / 0.82) < wallAt(a) + 60 || riverDistance(x, y) < 70) continue;
  const w = 20 + 14 * rng.next();
  huts.push(
    rect({
      id: `hut-${huts.length}`,
      at: [x, y],
      rotation: Math.round(rng.next() * 4) * 22.5,
      w,
      h: w * 0.7,
      radius: 0,
      lit: false,
      fill: pick(ROOFS),
      side: pick(WALLS),
      rise: 9 + 8 * rng.next(),
      roof: { kind: 'gable', height: w * 0.3 },
    }),
  );
}

const large: SceneNode[] = [
  // A hall with a hipped roof and a row of arched windows, and on it a drum with a dome.
  rect({
    id: 'hall',
    at: HALL,
    w: 200,
    h: 130,
    radius: 0,
    lit: false,
    fill: 'accent.amber',
    side: 'light.cream',
    rise: 70,
    roof: { kind: 'hip', height: 40 },
    openings: { shape: 'arch', width: 12, height: 34, step: 26, sill: 8, color: 'dark.plum' },
    children: [circle({ id: 'drum', r: 42, lit: false, fill: 'accent.aqua', side: 'light.snow', rise: 50, roof: { kind: 'dome', height: 46 }, openings: { width: 7, height: 22, step: 18, color: 'dark.navy' } })],
  }),
  // A round tower with a cone and four rows of windows.
  circle({ id: 'tower', at: TOWER, r: 44, lit: false, fill: 'accent.azure', side: 'light.mint', rise: 200, roof: { kind: 'cone', height: 150 }, openings: { width: 8, height: 16, step: 24, rows: 4, color: 'dark.navy' } }),
  // A long house with a gable and an arcade: arches that stand on the ground.
  rect({ id: 'long', at: LONG, rotation: -12, w: 280, h: 110, radius: 0, lit: false, fill: 'accent.coral', side: 'light.cream', rise: 90, roof: { kind: 'gable', height: 60 }, openings: { shape: 'arch', width: 16, height: 60, step: 30, sill: 0, color: 'dark.indigo' } }),
  // A block with a flat top and rows of windows; it rises out of the ground.
  rect({ id: 'block', at: BLOCK, w: 120, h: 90, radius: 8, fill: 'light.snow', side: 'mid.ocean', rise: 0, openings: { width: 10, height: 14, step: 20, rows: 5, color: 'accent.amber' } }),
];

const wall = stroke({ id: 'wall', points: WALL, closed: true, color: 'light.cream', side: 'mid.violet', width: 14, rise: 46 });

export default shot({
  id: 'town',
  seconds: 8,
  seed: SEED,
  palette,
  strings: { en: {} },
  background: { inner: 'dark.navy', outer: 'deep.night' },
  atmosphere: 'mid.mist',
  camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
  layers: [
    layer({
      id: 'stage',
      depth: 0,
      tint: 0,
      perspective: { aim: [0, 0, 0], distance: 2300, tilt: 40, turn: 16 },
      nodes: [
        group({
          id: 'plain',
          at: [0, 0, 0],
          plane: 'floor',
          children: [
            rect({ id: 'ground', w: 5400, h: 4000, radius: 120, fill: 'mid.jade', lit: false }),
            stroke({ id: 'river', points: RIVER, color: 'accent.azure', width: 70 }),
            // Everything that stands: drawn far to near, with shadows, and plain where it is small on screen.
            group({
              id: 'standing',
              sort: 'depth',
              cast: { color: 'deep.abyss', opacity: 0.4, length: 0.8, soft: 1.5 },
              detail: { min: 11 },
              children: [...huts, ...houses, ...large, wall],
            }),
          ],
        }),
      ],
    }),
  ],
  timeline: [perspectiveTo('stage', { at: 0.4, turn: -6, tilt: 50, distance: 1800, dur: 7 }), riseTo('block', { at: 1.2, to: 150, dur: 2.4 })],
});
