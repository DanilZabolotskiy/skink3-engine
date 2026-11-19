// Reef shot: 10 seconds under water, with neutral content.
//
// Light falls in shafts from the surface. A jelly rises in strokes over a
// garden of corals, its tentacles trailing behind it in waves; fish cross the
// frame, a school passes far behind, bubbles climb from the vents and motes
// drift everywhere. The camera drifts to the right and pushes in.
//
// It shows: depth of field (six layers: the far ones blurred, paler and
// closer to the colour of the water, the near one heavily blurred), a
// background lit from above, glow, sticks that sway on springs, lines that
// follow a function of time, emitters with a core, a turbulence and a
// prewarm, travel along a path, and a palette of its own.

import {
  blob,
  capsule,
  circle,
  definePalette,
  drive,
  emitter,
  eye,
  group,
  hsv,
  layer,
  moveTo,
  polygon,
  region,
  shot,
  squash,
  stroke,
  travel,
  Rng,
  type ColorRef,
  type Key,
  type SceneNode,
  type StringTables,
  type Vec2,
} from 'skink3-engine';

const SEED = 20261121;
const SECONDS = 10;
const strings: StringTables = { en: {} };

const palette = definePalette({
  deep: { trench: hsv(222, 0.9, 0.3), rock: hsv(214, 0.86, 0.27), kelp: hsv(170, 0.9, 0.2) },
  dark: { teal: hsv(190, 0.84, 0.5), moss: hsv(152, 0.8, 0.5), berry: hsv(318, 0.7, 0.5) },
  mid: { lagoon: hsv(174, 0.72, 0.92), water: hsv(196, 0.74, 0.74), ridge: hsv(204, 0.8, 0.5) },
  accent: { coral: hsv(8, 0.76, 0.99), sun: hsv(46, 0.86, 1), pink: hsv(336, 0.62, 1), violet: hsv(270, 0.6, 0.95), lime: hsv(82, 0.7, 0.9) },
  light: { foam: hsv(168, 0.16, 1), ray: hsv(150, 0.3, 1) },
});

const rng = new Rng(SEED, 'reef');
const timeline: Key[] = [];
/** Under way before the shot starts and after it ends: what follows it has no first frame and no last. */
const ALWAYS = { at: -1, dur: SECONDS + 2 };

// --- Far behind: shafts of light, rocks and a school ------------------------

const rays: SceneNode[] = [-800, -360, 40, 500, 1000].map((x, i) => {
  const w = [80, 130, 70, 160, 100][i]!;
  // A shaft breathes: its opacity follows a slow sine.
  timeline.push(drive(`ray${i}`, { ...ALWAYS, by: (t) => ({ opacity: 0.17 + 0.07 * Math.sin(0.7 * t + 1.9 * i) }) }));
  return polygon({ id: `ray${i}`, at: [x, -60], rotation: 13, points: [[-w * 0.4, -800], [w * 0.4, -800], [w * 1.5, 800], [-w * 1.5, 800]], fill: 'light.ray', lit: false, opacity: 0.17 });
});

const farRocks: SceneNode[] = [
  region({ id: 'arch', points: [[-1500, 700], [-1420, 40], [-1180, -210], [-900, -120], [-800, 150], [-930, 330], [-1060, 250], [-1160, 420], [-1040, 700]], fill: 'dark.teal', lit: false }),
  region({ id: 'stack', points: [[860, 700], [900, 230], [1010, -60], [1180, -150], [1330, 40], [1400, 700]], fill: 'dark.teal', lit: false }),
  region({ id: 'shelf', points: [[-700, 700], [-420, 380], [-60, 330], [330, 420], [700, 350], [900, 700]], fill: 'dark.teal', lit: false }),
];

const SCHOOL: Vec2[] = [[-1300, -160], [-700, -300], [-100, -190], [500, -330], [1300, -210]];
const school = group({
  id: 'school',
  at: SCHOOL[0]!,
  children: Array.from({ length: 22 }, (_, i) =>
    capsule({ id: `minnow${i}`, at: [rng.range(-230, 230), rng.range(-90, 90)], rotation: rng.range(-8, 8), length: rng.range(34, 52), r: 8, fill: 'deep.trench', lit: false, idle: { amp: 7, period: rng.range(2, 4) } }),
  ),
});
timeline.push(travel('school', { at: -6, path: SCHOOL, speed: 105 }));

// --- Behind the stage: kelp --------------------------------------------------

/** A frond: a ribbon that leans as it rises. */
const frond = (id: string, x: number, height: number, lean: number, width: number, fill: ColorRef): SceneNode => {
  const points: Vec2[] = [];
  const steps = 7;
  const mid = (u: number): number => lean * u * u + 30 * Math.sin(5 * u);
  for (let i = 0; i <= steps; i++) points.push([mid(i / steps) - width * (1 - 0.8 * (i / steps)), -height * (i / steps)]);
  for (let i = steps; i >= 0; i--) points.push([mid(i / steps) + width * (1 - 0.8 * (i / steps)), -height * (i / steps)]);
  return region({ id, at: [x, 520], points, fill, lit: false, idle: { amp: 9, period: 5 } });
};
const kelp: SceneNode[] = [
  frond('kelp0', -900, 800, 170, 46, 'dark.moss'),
  frond('kelp1', -740, 560, 90, 36, 'dark.moss'),
  frond('kelp2', -170, 420, 60, 30, 'dark.moss'),
  frond('kelp3', 640, 560, -110, 38, 'dark.moss'),
  frond('kelp4', 1160, 860, -190, 48, 'dark.moss'),
  frond('kelp5', 1310, 600, -80, 36, 'dark.moss'),
];

// --- The stage: the garden, the jelly and the fish ---------------------------

const seabed: SceneNode[] = [
  region({ id: 'ridge', points: [[-1400, 700], [-1320, 240], [-980, 170], [-640, 250], [-260, 200], [120, 270], [520, 210], [900, 260], [1260, 190], [1600, 250], [1650, 700]], fill: 'mid.ridge', lit: false, backdrop: true }),
  region({ id: 'ground', points: [[-1400, 700], [-1380, 350], [-1040, 290], [-700, 340], [-330, 290], [80, 350], [460, 300], [860, 350], [1240, 290], [1620, 340], [1650, 700]], fill: 'deep.rock', lit: false, backdrop: true }),
];

/** A branching coral: sticks that fork, the last ones swaying. */
const branch = (id: string, at: Vec2, fill: ColorRef, size: number, forks: number[]): SceneNode =>
  group({
    id,
    at,
    children: forks.map((angle, i) =>
      capsule({
        id: `${id}-arm${i}`,
        rotation: -90 + angle,
        length: size * (1 - (0.12 * Math.abs(angle)) / 30),
        r: size * 0.1,
        origin: 'start',
        fill,
        children: [
          capsule({ id: `${id}-twig${i}a`, at: [size * 0.52, 0], rotation: -34, length: size * 0.46, r: size * 0.075, origin: 'start', fill, sway: 'light' }),
          capsule({ id: `${id}-twig${i}b`, at: [size * 0.7, 0], rotation: 38, length: size * 0.36, r: size * 0.07, origin: 'start', fill, sway: 'light' }),
        ],
      }),
    ),
  });

/** An anemone: a tuft of sticks on a foot, all of them swaying. */
const anemone = (id: string, at: Vec2, fill: ColorRef, tip: ColorRef, size: number): SceneNode =>
  group({
    id,
    at,
    idle: { amp: 5, period: 3.4 },
    children: [
      ...[-52, -30, -10, 10, 30, 52].map((angle, i) =>
        capsule({
          id: `${id}-arm${i}`,
          rotation: -90 + angle,
          length: size * (1 - Math.abs(angle) / 190),
          r: size * 0.085,
          origin: 'start',
          fill,
          sway: 'springy',
          children: [circle({ id: `${id}-tip${i}`, at: [size * (1 - Math.abs(angle) / 190) - size * 0.09, 0], r: size * 0.1, fill: tip, lit: false })],
        }),
      ),
      blob({ id: `${id}-foot`, at: [0, 8], r: size * 0.36, fill, seed: 4 }),
    ],
  });

const garden: SceneNode[] = [
  branch('fire', [-800, 400], 'accent.coral', 230, [-30, 0, 28]),
  blob({ id: 'dome0', at: [-560, 400], r: 124, fill: 'accent.violet', seed: 3, wobble: 0.1 }),
  anemone('rose', [-330, 350], 'accent.pink', 'light.foam', 170),
  blob({ id: 'dome1', at: [-90, 430], r: 96, fill: 'accent.sun', seed: 8, wobble: 0.1 }),
  blob({ id: 'dome4', at: [110, 480], r: 70, fill: 'accent.lime', seed: 2, wobble: 0.1 }),
  branch('horn', [650, 390], 'accent.sun', 200, [-24, 16]),
  blob({ id: 'dome2', at: [420, 430], r: 112, fill: 'accent.coral', seed: 5, wobble: 0.1 }),
  anemone('lilac', [900, 370], 'accent.violet', 'accent.sun', 150),
  blob({ id: 'dome3', at: [1150, 420], r: 104, fill: 'accent.lime', seed: 11, wobble: 0.1 }),
  branch('rose-tree', [1400, 400], 'accent.pink', 230, [-22, 12]),
];

// The jelly: a bell with a scalloped rim and four rings in it, and tentacles that trail in waves.
const BELL = 150;
const bell: Vec2[] = [];
for (let i = 0; i <= 12; i++) {
  const a = Math.PI + (Math.PI * i) / 12;
  bell.push([BELL * Math.cos(a), BELL * 0.92 * Math.sin(a)]);
}
for (let i = 0; i < 7; i++) {
  const x = BELL - (2 * BELL * (i + 0.5)) / 7;
  bell.push([x + BELL / 7, 26], [x, i % 2 === 0 ? 4 : 8]);
}
bell.push([-BELL, 26]);
const JELLY: Vec2 = [330, 60];
const TENTACLES = [-108, -66, -24, 20, 62, 104].map((x, i) => ({ x, length: [250, 330, 390, 370, 310, 240][i]!, phase: 1.3 * i }));
/** The line of a tentacle: a wave runs down it, wider toward its free end. */
const tentacleAt = (k: number, seconds: number): Vec2[] => {
  const { x, length, phase } = TENTACLES[k]!;
  return Array.from({ length: 10 }, (_, j) => {
    const u = j / 9;
    return [x * (1 - 0.25 * u) + 34 * u * Math.sin(5.2 * u - 2.1 * seconds + phase), 14 + length * u] as Vec2;
  });
};
const jelly = group({
  id: 'jelly',
  at: JELLY,
  children: [
    ...TENTACLES.map((_, k) => stroke({ id: `tentacle${k}`, points: tentacleAt(k, 0), color: k % 2 === 0 ? 'accent.pink' : 'accent.violet', width: 17 })),
    region({
      id: 'bell',
      points: bell,
      fill: 'accent.pink',
      glow: 0.6,
      rimLight: 'light.foam',
      children: [
        ...[[-34, -84], [34, -84], [-34, -22], [34, -22]].map(([x, y], i) => circle({ id: `ring${i}`, at: [x!, y!], r: 27, fill: 'light.foam', lit: false, opacity: 0.8 })),
        ...[[-34, -84], [34, -84], [-34, -22], [34, -22]].map(([x, y], i) => circle({ id: `ring${i}-in`, at: [x!, y!], r: 15, fill: 'accent.pink', lit: false })),
        circle({ id: 'spot0', at: [-102, -34], r: 13, fill: 'accent.violet', lit: false, opacity: 0.85 }),
        circle({ id: 'spot1', at: [104, -38], r: 11, fill: 'accent.violet', lit: false, opacity: 0.85 }),
      ],
    }),
  ],
});
TENTACLES.forEach((_, k) => timeline.push(drive(`tentacle${k}`, { ...ALWAYS, by: (t) => ({ points: tentacleAt(k, t) }) })));
// It rises in strokes: the bell closes, and the whole of it glides up and comes to rest.
for (let k = 0; k < 4; k++) {
  const at = 0.4 + 2.4 * k;
  timeline.push(squash('bell', { at, amount: 0.16, dur: 0.9, pivot: [0, 20] }));
  timeline.push(moveTo('jelly', { at: at + 0.1, to: [JELLY[0] - 28 * (k + 1), JELLY[1] - 62 * (k + 1)], dur: 2.1, profile: 'ease', anticipation: 0, overshoot: 0, arc: 0 }));
}

/** A fish: a body, a tail, a fin and an eye. It faces the way it goes. */
const fish = (id: string, at: Vec2, fill: ColorRef, fin: ColorRef, size: number): SceneNode =>
  group({
    id,
    at,
    children: [
      polygon({ id: `${id}-tail`, at: [-size * 0.95, 0], points: [[size * 0.5, 0], [-size * 0.35, -size * 0.5], [-size * 0.35, size * 0.5]], radius: size * 0.1, fill: fin }),
      capsule({ id: `${id}-body`, length: size * 2, r: size * 0.52, fill }),
      polygon({ id: `${id}-fin`, at: [-size * 0.1, -size * 0.5], points: [[size * 0.45, 0], [-size * 0.5, -size * 0.42], [-size * 0.4, 0]], radius: size * 0.08, fill: fin }),
      eye({ id: `${id}-eye`, at: [size * 0.55, -size * 0.08], r: size * 0.2, white: 'light.foam', pupil: 'deep.trench' }),
    ],
  });
/** The way of a fish across the frame: a gentle wave, in many short spans so that it turns smoothly along it. */
const swim = (y: number, amp: number, waves: number, phase: number): Vec2[] => Array.from({ length: 29 }, (_, i) => [-1300 + 100 * i, y + amp * Math.sin((2 * Math.PI * waves * i) / 28 + phase)] as Vec2);
const FISH: { id: string; fill: ColorRef; fin: ColorRef; size: number; path: Vec2[]; speed: number; at: number }[] = [
  { id: 'gold', fill: 'accent.sun', fin: 'accent.coral', size: 56, path: swim(-390, 70, 1.1, 2.2), speed: 150, at: -3.4 },
  { id: 'lime', fill: 'accent.lime', fin: 'accent.sun', size: 38, path: swim(110, 46, 2.2, 0.4), speed: 120, at: -1.4 },
  { id: 'ruby', fill: 'accent.coral', fin: 'accent.pink', size: 44, path: swim(-210, 60, 1.6, 4), speed: 132, at: 1.6 },
];
const fishes = FISH.map((f) => fish(f.id, f.path[0]!, f.fill, f.fin, f.size));
FISH.forEach((f) => timeline.push(travel(f.id, { at: f.at, path: f.path, speed: f.speed, orient: true })));

const bubbles = (id: string, x: number, rate: number): SceneNode =>
  emitter({
    id,
    at: [x, 300],
    area: [60, 10],
    colors: ['light.foam'],
    core: { color: 'mid.water', size: 0.74 },
    size: [5, 15],
    life: [5, 8],
    rate,
    prewarm: 8,
    sizing: 'steady',
    direction: -90,
    spread: 26,
    speed: [70, 120],
    gravity: [0, -26],
    drag: 0.25,
    turbulence: { strength: 40, scale: 260, speed: 0.4 },
  });

// --- In front, out of focus: fronds, a coral, a sponge and two bubbles -----------------

const near: SceneNode[] = [
  region({ id: 'near-left', points: [[-1300, 800], [-1240, 60], [-1090, -420], [-940, -600], [-850, -330], [-930, 100], [-790, 420], [-760, 800]], fill: 'dark.moss', lit: false }),
  region({ id: 'near-right', points: [[1000, 800], [1060, 300], [1200, 60], [1250, -260], [1400, -480], [1520, -100], [1560, 800]], fill: 'dark.moss', lit: false }),
  blob({ id: 'near-coral', at: [960, 600], r: 250, fill: 'accent.coral', lit: false, seed: 6 }),
  blob({ id: 'near-sponge', at: [-760, 660], r: 210, fill: 'accent.violet', lit: false, seed: 9 }),
  circle({ id: 'near-bubble0', at: [-640, 300], r: 46, fill: 'light.foam', lit: false, opacity: 0.28 }),
  circle({ id: 'near-bubble1', at: [760, 420], r: 30, fill: 'light.foam', lit: false, opacity: 0.25 }),
];
timeline.push(moveTo('near-bubble0', { at: -2, to: [-570, -700], dur: 16, profile: 'steady', anticipation: 0, overshoot: 0, arc: 0.06 }));
timeline.push(moveTo('near-bubble1', { at: -1, to: [810, -700], dur: 19, profile: 'steady', anticipation: 0, overshoot: 0, arc: 0.05 }));

export default shot({
  id: 'reef',
  seconds: SECONDS,
  seed: SEED,
  palette,
  strings,
  background: { inner: 'mid.lagoon', outer: 'deep.trench', center: [0.4, -0.08], radius: 0.86 },
  atmosphere: 'mid.water',
  vignette: 0.45,
  light: { from: 'top' },
  camera: { at: [-60, 0], drift: { speed: 0.5, heading: 0, wander: 10, period: 7 }, pushIn: { from: 1, to: 1.06 } },
  layers: [
    layer({ id: 'rays', depth: 2.4, tint: 0, nodes: rays }),
    layer({ id: 'far', depth: 1.5, nodes: [...farRocks, school] }),
    layer({
      id: 'motes',
      depth: 0.9,
      nodes: [
        emitter({ id: 'plankton', area: [3400, 1500], colors: ['light.foam', 'light.ray'], size: [2, 5], life: [6, 10], rate: 26, prewarm: 10, sizing: 'steady', speed: [6, 22], drag: 0.2, turbulence: { strength: 26, scale: 300, speed: 0.3 } }),
      ],
    }),
    layer({ id: 'back', depth: 0.5, tint: 0.2, nodes: kelp }),
    layer({
      id: 'stage',
      depth: 0,
      nodes: [...seabed, ...garden, bubbles('vent0', -450, 2.2), bubbles('vent1', 770, 1.6), bubbles('vent2', 1280, 1.2), jelly, ...fishes],
    }),
    layer({ id: 'near', depth: -0.55, nodes: near }),
  ],
  timeline,
});
