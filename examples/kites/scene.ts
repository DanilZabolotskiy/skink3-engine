// Kites shot: 10 seconds on a windy hill by day, with neutral content.
//
// Three kites ride the wind on their lines: each wanders on a path of its
// own, leans as it goes, and trails a tail that streams behind it in waves.
// The lines are held by stakes on the hill, a flag flies from a pole, clouds
// and seeds drift with the wind, and two creatures watch.
//
// It shows: drive() with a function of time on the place and the turn of a
// node, on the points of a stroke (the lines and the tails) and on the outline
// of a region (the flag); eyes that follow a node; depth of field by day; a
// light palette of its own.

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
  stroke,
  Rng,
  type ColorRef,
  type Key,
  type SceneNode,
  type StringTables,
  type Vec2,
} from 'skink3-engine';

const SEED = 20261123;
const SECONDS = 10;
const strings: StringTables = { en: {} };

const palette = definePalette({
  deep: { pine: hsv(164, 0.82, 0.3), navy: hsv(224, 0.78, 0.36) },
  dark: { forest: hsv(148, 0.76, 0.46), grass: hsv(112, 0.74, 0.56) },
  mid: { sky: hsv(204, 0.66, 0.97), meadow: hsv(92, 0.7, 0.8), hill: hsv(136, 0.6, 0.7) },
  accent: { red: hsv(356, 0.76, 0.98), yellow: hsv(48, 0.86, 1), orange: hsv(24, 0.84, 1), magenta: hsv(322, 0.7, 0.97), blue: hsv(222, 0.74, 0.97), sun: hsv(52, 0.7, 1) },
  light: { cloud: hsv(200, 0.05, 1), haze: hsv(184, 0.3, 1), cream: hsv(50, 0.26, 1) },
});

const rng = new Rng(SEED, 'kites');
const timeline: Key[] = [];
/** Under way before the shot starts and after it ends: the wind has no first frame and no last. */
const ALWAYS = { at: -1, dur: SECONDS + 2 };

/** The top of the hill at x. */
const hillTop = (x: number): number => 330 - 120 * Math.exp(-(((x + 420) / 620) ** 2)) + 40 * Math.sin(x / 300);

// --- The kites: a place, a lean, a line and a tail, each a function of time ---

interface Kite {
  id: string;
  /** Where its line is held, and the middle of the patch of sky it wanders in. */
  peg: Vec2;
  home: Vec2;
  size: number;
  face: [ColorRef, ColorRef];
  tail: ColorRef;
  phase: number;
}
const KITES: Kite[] = [
  { id: 'kite0', peg: [-400, hillTop(-400) - 34], home: [300, -190], size: 1.15, face: ['accent.red', 'accent.yellow'], tail: 'accent.red', phase: 0 },
  { id: 'kite1', peg: [-500, hillTop(-500) - 34], home: [-150, -330], size: 0.85, face: ['accent.magenta', 'accent.blue'], tail: 'accent.magenta', phase: 2.1 },
  { id: 'kite2', peg: [-300, hillTop(-300) - 34], home: [730, -250], size: 0.7, face: ['accent.orange', 'light.cream'], tail: 'accent.orange', phase: 4.4 },
];
/** The place of a kite: two slow swings across the wind and two along it. */
const placeOf = (k: Kite, seconds: number): Vec2 => [
  k.home[0] + 70 * Math.sin(0.62 * seconds + k.phase) + 26 * Math.sin(1.7 * seconds + 2 * k.phase),
  k.home[1] + 44 * Math.sin(0.86 * seconds + 1.3 * k.phase) + 16 * Math.cos(2.1 * seconds + k.phase),
];
/** It leans the way it goes: its turn follows its sideways speed. */
const leanOf = (k: Kite, seconds: number): number => 24 + 0.2 * (70 * 0.62 * Math.cos(0.62 * seconds + k.phase) + 26 * 1.7 * Math.cos(1.7 * seconds + 2 * k.phase));
/** A point of the kite, given in its own axes, where the layer has it. */
const onKite = (k: Kite, seconds: number, [x, y]: Vec2): Vec2 => {
  const [px, py] = placeOf(k, seconds);
  const a = (leanOf(k, seconds) * Math.PI) / 180;
  return [px + k.size * (x * Math.cos(a) - y * Math.sin(a)), py + k.size * (x * Math.sin(a) + y * Math.cos(a))];
};
/** The line: from the peg to the middle of the kite, sagging under its weight. */
const lineOf = (k: Kite, seconds: number): Vec2[] => {
  const end = onKite(k, seconds, [0, 10]);
  return Array.from({ length: 9 }, (_, i) => {
    const u = i / 8;
    return [k.peg[0] + (end[0] - k.peg[0]) * u, k.peg[1] + (end[1] - k.peg[1]) * u + 90 * Math.sin(Math.PI * u) * (1 - 0.4 * u)] as Vec2;
  });
};
/** The tail: it leaves the lower corner where that corner was a moment ago, streams down the wind, and a wave runs along it. */
const TAIL = 16;
const tailOf = (k: Kite, seconds: number): Vec2[] =>
  Array.from({ length: TAIL }, (_, j) => {
    const u = j / (TAIL - 1);
    const [x, y] = onKite(k, seconds - 0.05 * j, [0, 150]);
    const wave = 34 * u * Math.sin(10 * u - 3.6 * seconds + k.phase);
    return [x + k.size * (270 * u + 0.5 * wave), y + k.size * (150 * u * u + 40 * u + wave)] as Vec2;
  });

const kiteNodes: SceneNode[] = [];
for (const k of KITES) {
  // The stake that holds the line.
  kiteNodes.push(capsule({ id: `${k.id}-stake`, at: [k.peg[0], k.peg[1] + 46], rotation: -84, length: 58, r: 7, origin: 'start', fill: 'light.cream' }));
  kiteNodes.push(stroke({ id: `${k.id}-line`, points: lineOf(k, 0), color: 'light.cream', width: 4 }));
  kiteNodes.push(stroke({ id: `${k.id}-tail`, points: tailOf(k, 0), color: k.tail, width: 13 * k.size }));
  kiteNodes.push(
    group({
      id: k.id,
      at: placeOf(k, 0),
      rotation: leanOf(k, 0),
      scale: k.size,
      children: [
        polygon({ id: `${k.id}-face`, points: [[0, -130], [92, -20], [0, 150], [-92, -20]], radius: 7, fill: k.face[0] }),
        polygon({ id: `${k.id}-half`, points: [[0, -130], [92, -20], [0, 150]], radius: 7, fill: k.face[1], lit: false }),
        stroke({ id: `${k.id}-spine`, points: [[0, -124], [0, 144]], color: 'deep.navy', width: 6, smooth: 0 }),
        stroke({ id: `${k.id}-spar`, points: [[-86, -20], [86, -20]], color: 'deep.navy', width: 6, smooth: 0 }),
      ],
    }),
  );
  timeline.push(drive(k.id, { ...ALWAYS, by: (t) => ({ at: placeOf(k, t), rotation: leanOf(k, t) }) }));
  timeline.push(drive(`${k.id}-line`, { ...ALWAYS, by: (t) => ({ points: lineOf(k, t) }) }));
  timeline.push(drive(`${k.id}-tail`, { ...ALWAYS, by: (t) => ({ points: tailOf(k, t) }) }));
}

// --- The flag: an outline that follows the wind -------------------------------

/** The outline of a cloth that flies from a pole: a wave runs along it and grows toward its free end. */
const clothOf = (length: number, height: number, taper: number, seconds: number, phase: number): Vec2[] => {
  const n = 10;
  const edge = (u: number, side: number): Vec2 => {
    const wave = (10 + 34 * u) * Math.sin(8 * u - 5 * seconds + phase);
    return [length * u * (1 - 0.04 * Math.sin(5 * seconds + phase)), side * (height / 2) * (1 - taper * u) + wave + 26 * u * u];
  };
  return [...Array.from({ length: n }, (_, i) => edge(i / (n - 1), -1)), ...Array.from({ length: n }, (_, i) => edge(1 - i / (n - 1), 1))];
};
const pole = (id: string, at: Vec2, height: number, cloth: { length: number; height: number; taper: number; fill: ColorRef; phase: number }): SceneNode => {
  timeline.push(drive(`${id}-cloth`, { ...ALWAYS, by: (t) => ({ points: clothOf(cloth.length, cloth.height, cloth.taper, t, cloth.phase) }) }));
  return group({
    id,
    at,
    children: [
      capsule({ id: `${id}-pole`, rotation: -90, length: height, r: 8, origin: 'start', fill: 'light.cream' }),
      region({ id: `${id}-cloth`, at: [6, -height + cloth.height / 2 + 14], points: clothOf(cloth.length, cloth.height, cloth.taper, 0, cloth.phase), fill: cloth.fill, highlight: false }),
      circle({ id: `${id}-knob`, at: [0, -height], r: 13, fill: 'accent.yellow' }),
    ],
  });
};

// --- The hill, the creatures and the meadow ----------------------------------

/** A creature: a blob with two eyes that follow a kite. */
const creature = (id: string, at: Vec2, r: number, fill: ColorRef, watches: string): SceneNode =>
  group({
    id,
    at,
    idle: { amp: 4, period: 3 },
    children: [
      blob({ id: `${id}-body`, r, wobble: 0.08, seed: 5, fill }),
      eye({ id: `${id}-eye-l`, at: [-r * 0.2, -r * 0.2], r: r * 0.24, white: 'light.cloud', pupil: 'deep.navy', lookAt: watches }),
      eye({ id: `${id}-eye-r`, at: [r * 0.42, -r * 0.24], r: r * 0.24, white: 'light.cloud', pupil: 'deep.navy', lookAt: watches }),
    ],
  });

const flowers: SceneNode[] = Array.from({ length: 34 }, (_, i) => {
  const x = rng.range(-1250, 1350);
  // The top of the hill at x, a little below it.
  const y = 330 - 120 * Math.exp(-(((x + 420) / 620) ** 2)) + 40 * Math.sin(x / 300) + rng.range(40, 190);
  return circle({ id: `flower${i}`, at: [x, y], r: rng.range(7, 13), fill: rng.pick(['accent.yellow', 'accent.red', 'light.cream', 'accent.magenta'] as ColorRef[]), lit: false });
});

const hill = region({
  id: 'hill',
  points: [[-1500, 800], ...Array.from({ length: 16 }, (_, i) => [-1500 + 200 * i, hillTop(-1500 + 200 * i)] as Vec2), [1500, 800]],
  fill: 'mid.meadow',
  highlight: false,
  backdrop: true,
});

// --- Behind: hills, trees, clouds and the sun ----------------------------------

const cloud = (id: string, at: Vec2, size: number): SceneNode =>
  group({
    id,
    at,
    scale: size,
    children: [
      circle({ id: `${id}-a`, at: [-110, 20], r: 70, fill: 'light.cloud', lit: false }),
      circle({ id: `${id}-b`, at: [-20, -30], r: 100, fill: 'light.cloud', lit: false }),
      circle({ id: `${id}-c`, at: [100, 10], r: 80, fill: 'light.cloud', lit: false }),
      capsule({ id: `${id}-d`, at: [0, 60], length: 420, r: 44, fill: 'light.cloud', lit: false }),
    ],
  });
const CLOUDS: [string, Vec2, number][] = [['cloud0', [-900, -330], 1.3], ['cloud1', [80, -470], 0.9], ['cloud2', [1050, -250], 1.5], ['cloud3', [-300, -130], 0.7]];
CLOUDS.forEach(([id, at]) => timeline.push(moveTo(id, { ...ALWAYS, to: [at[0] + 150, at[1]], profile: 'steady', anticipation: 0, overshoot: 0, arc: 0 })));

const farHills: SceneNode[] = [
  region({ id: 'far-hill0', points: [[-1700, 700], [-1500, 260], [-1050, 90], [-600, 220], [-200, 320], [-100, 700]], fill: 'mid.hill', lit: false }),
  region({ id: 'far-hill1', points: [[-300, 700], [-100, 330], [400, 190], [820, 150], [1250, 230], [1700, 330], [1800, 700]], fill: 'mid.hill', lit: false }),
];
const trees: SceneNode[] = [[-1180, 150, 60], [-1060, 120, 46], [-930, 150, 54], [250, 250, 50], [370, 215, 62], [1240, 240, 56], [1370, 270, 44]].map(([x, y, r], i) =>
  group({
    id: `tree${i}`,
    at: [x!, y!],
    children: [capsule({ id: `tree${i}-trunk`, rotation: -90, length: r! * 1.5, r: r! * 0.14, origin: 'start', fill: 'deep.pine', lit: false }), circle({ id: `tree${i}-crown`, at: [0, -r! * 1.7], r: r!, fill: 'dark.forest', lit: false })],
  }),
);

// --- In front, out of focus: grass ---------------------------------------------

const blades: SceneNode[] = Array.from({ length: 16 }, (_, i) => {
  const left = i < 8;
  const x = (left ? -1100 : 620) + rng.range(0, 460);
  return capsule({ id: `blade${i}`, at: [x, 640], rotation: -90 + rng.range(-8, 26), length: rng.range(260, 520), r: 16, origin: 'start', fill: i % 3 === 0 ? 'dark.forest' : 'dark.grass', lit: false, sway: 'springy', idle: { amp: 8, period: rng.range(2, 3.4) } });
});

export default shot({
  id: 'kites',
  seconds: SECONDS,
  seed: SEED,
  palette,
  strings,
  background: { inner: 'light.haze', outer: 'mid.sky', center: [0.46, 0.78], radius: 0.74 },
  atmosphere: 'light.haze',
  vignette: 0.2,
  light: { from: 'top-left' },
  camera: { at: [0, 0], drift: { speed: 0.4, heading: -24, wander: 8, period: 7 }, pushIn: { from: 1, to: 1.04 } },
  layers: [
    layer({ id: 'sky', depth: 3, tint: 0, nodes: [circle({ id: 'sun', at: [-640, -360], r: 110, fill: 'accent.sun', lit: false, glow: 0.8 }), ...CLOUDS.map(([id, at, size]) => cloud(id, at, size))] }),
    layer({ id: 'far', depth: 1.2, nodes: [...farHills, ...trees] }),
    layer({
      id: 'stage',
      depth: 0,
      nodes: [
        hill,
        ...flowers,
        pole('flag', [700, hillTop(700) + 12], 240, { length: 250, height: 150, taper: 0.1, fill: 'accent.blue', phase: 0 }),
        creature('watcher0', [-690, hillTop(-690) - 50], 66, 'accent.orange', 'kite0'),
        creature('watcher1', [-175, hillTop(-175) - 34], 46, 'accent.magenta', 'kite2'),
        ...kiteNodes,
        emitter({ id: 'seeds', at: [-200, 0], area: [3000, 1300], colors: ['light.cloud', 'light.cream'], size: [3, 6], life: [5, 9], rate: 14, prewarm: 9, sizing: 'steady', direction: -8, spread: 30, speed: [60, 130], gravity: [26, 0], drag: 0.2, turbulence: { strength: 46, scale: 340, speed: 0.4 } }),
      ],
    }),
    layer({ id: 'near', depth: -0.5, nodes: blades }),
  ],
  timeline,
});
