// Sea shot: 12 seconds over a sea at sunset, in a perspective layer, with
// neutral content.
//
// The sea is a plane of the space, seen from a little above: its bands of
// colour, the ripples on it and the path of light under the sun are drawn on
// it as on a map, and the camera of the layer makes them run to the horizon.
// Rocks, a lighthouse, boats and a buoy stand in that space at their places,
// each with its mirror image under the water line; the near ones are large
// and cover the far ones. The boats sail, the light on the water flickers,
// birds pass, and the camera moves in slowly.
//
// It shows: a perspective layer (a floor plane with things drawn on it, flat
// pictures standing at places of three numbers, near over far), a dolly of
// its camera, drive() on an opacity, glow, a sun in a flat layer behind the
// space, and a palette of its own.

import {
  capsule,
  circle,
  definePalette,
  drive,
  group,
  hsv,
  layer,
  moveTo,
  perspectiveTo,
  polygon,
  rect,
  region,
  shot,
  stroke,
  travel,
  Rng,
  type ColorRef,
  type Key,
  type SceneNode,
  type StringTables,
  type Vec2,
} from 'skink3-engine';

const SEED = 20261122;
const SECONDS = 12;
const strings: StringTables = { en: {} };

const palette = definePalette({
  deep: { night: hsv(262, 0.82, 0.3), indigo: hsv(272, 0.78, 0.4), rock: hsv(292, 0.78, 0.24) },
  dark: { plum: hsv(296, 0.7, 0.52), wine: hsv(326, 0.72, 0.62), hull: hsv(346, 0.74, 0.42) },
  mid: { rose: hsv(350, 0.64, 0.86), peach: hsv(18, 0.62, 0.98), dusk: hsv(284, 0.6, 0.62) },
  accent: { sun: hsv(46, 0.88, 1), gold: hsv(34, 0.84, 1), coral: hsv(8, 0.76, 0.99), flame: hsv(20, 0.86, 1), teal: hsv(176, 0.7, 0.86) },
  light: { sail: hsv(46, 0.2, 1), glint: hsv(50, 0.5, 1) },
});

const rng = new Rng(SEED, 'sea');
const timeline: Key[] = [];
/** Under way before the shot starts and after it ends. */
const ALWAYS = { at: -2, dur: SECONDS + 4 };

// --- The camera of the space --------------------------------------------------

const LENS = 1500;
const TILT = 7;
const AIM: [number, number, number] = [0, -120, 900];
const DISTANCE = 1500;
/** Where the camera stands when the shot starts: above the water, looking a little down. */
const EYE = { y: AIM[1] - DISTANCE * Math.sin((TILT * Math.PI) / 180), z: AIM[2] - DISTANCE * Math.cos((TILT * Math.PI) / 180) };
/** The sun stands to the right of the middle: the sideways slope of the line toward it. */
const SUN_X = 210;
const TOWARD_SUN = SUN_X / LENS;

// --- The sea: a plane, drawn as a map is -------------------------------------

/** A place of the sea in the units of its plane: x to the right, and the farther, the smaller y. */
const onSea = (x: number, z: number): Vec2 => [x, -z];
/** How long a mark must be along the view to be `px` high in the picture, at the distance of z. */
const along = (z: number, px: number): number => ((z - EYE.z) ** 2 / (LENS * -EYE.y)) * px;

const band = (id: string, from: number, to: number, fill: ColorRef): SceneNode =>
  rect({ id, at: onSea(0, (from + to) / 2), w: 120000, h: to - from, radius: 0, fill, lit: false, backdrop: true });
const bands: SceneNode[] = [
  band('band0', 14000, 60000, 'mid.peach'),
  band('band1', 7000, 14000, 'mid.rose'),
  band('band2', 3400, 7000, 'dark.wine'),
  band('band3', 1700, 3400, 'dark.plum'),
  band('band4', 500, 1700, 'deep.indigo'),
  band('band5', -1200, 500, 'deep.night'),
];

// The path of light under the sun: marks that lie on the water and grow with their distance.
const glints: SceneNode[] = [];
for (let z = 60, i = 0; z < 30000; z *= 1.13, i++) {
  const d = z - EYE.z;
  const x = TOWARD_SUN * d + rng.range(-1, 1) * (16 + 0.02 * d);
  const w = (60 + 0.075 * d) * rng.range(0.45, 1.25);
  const h = along(z, rng.range(2.2, 4.6));
  const id = `glint${i}`;
  glints.push(rect({ id, at: onSea(x, z), w, h, radius: Math.min(w, h) * 0.45, fill: z > 5000 ? 'light.glint' : 'accent.sun', lit: false }));
  const phase = rng.range(0, 6.28);
  const rate = rng.range(1.6, 3.4);
  // The light on the water flickers: every mark on a sine of its own.
  timeline.push(drive(id, { ...ALWAYS, by: (t) => ({ opacity: 0.62 + 0.38 * Math.sin(rate * t + phase) }) }));
}

// Ripples everywhere else: fainter marks in the colour of the sky.
const ripples: SceneNode[] = [];
for (let i = 0; i < 90; i++) {
  const z = 200 * 1.052 ** rng.range(0, 90);
  const d = z - EYE.z;
  const x = rng.range(-1.1, 1.1) * d;
  const w = (50 + 0.06 * d) * rng.range(0.6, 1.4);
  const h = along(z, rng.range(1.6, 3));
  ripples.push(rect({ id: `ripple${i}`, at: onSea(x, z), w, h, radius: Math.min(w, h) * 0.45, fill: z > 3400 ? 'mid.peach' : 'dark.wine', lit: false, opacity: 0.5 }));
}

const sea = group({ id: 'sea', at: [0, 0, 0], plane: 'floor', depth: 90000, children: [...bands, ...ripples, ...glints] });

// --- What stands in the space, each thing over its mirror image ---------------

type Part = (id: string, flip: 1 | -1, fill: (c: ColorRef) => ColorRef) => SceneNode[];
/** A thing at a place of the sea: its parts, and under the water line the same parts upside down, fainter. */
const standing = (id: string, at: [number, number, number], parts: Part, mirror = 0.34): SceneNode =>
  group({
    id,
    at,
    children: [group({ id: `${id}-mirror`, opacity: mirror, children: parts(`${id}-m`, -1, () => 'deep.rock') }), ...parts(id, 1, (c) => c)],
  });
const flipped = (points: Vec2[], flip: 1 | -1): Vec2[] => (flip === 1 ? points : points.map(([x, y]) => [x, -y] as Vec2).reverse());

const rock = (outline: Vec2[]): Part => (id, flip, fill) => [region({ id: `${id}-rock`, points: flipped(outline, flip), fill: fill('deep.rock'), ...(flip === 1 ? { highlight: false } : { lit: false }) })];

const lighthouse: Part = (id, flip, fill) => [
  region({ id: `${id}-isle`, points: flipped([[-330, 0], [-260, -50], [-120, -84], [40, -70], [190, -96], [300, -40], [350, 0]], flip), fill: fill('deep.rock'), ...(flip === 1 ? { highlight: false } : { lit: false }) }),
  polygon({ id: `${id}-tower`, at: [0, -flip * 60], points: flipped([[-44, 0], [-28, -330], [28, -330], [44, 0]], flip), radius: 4, fill: fill('light.sail'), lit: flip === 1 }),
  rect({ id: `${id}-stripe0`, at: [0, -flip * 150], w: 78, h: 50, radius: 4, fill: fill('accent.coral'), lit: false }),
  rect({ id: `${id}-stripe1`, at: [0, -flip * 280], w: 66, h: 50, radius: 4, fill: fill('accent.coral'), lit: false }),
  rect({ id: `${id}-room`, at: [0, -flip * 420], w: 84, h: 64, radius: 8, fill: fill('dark.hull'), lit: false }),
  ...(flip === 1 ? [circle({ id: `${id}-lamp`, at: [0, -420], r: 22, fill: 'accent.sun', lit: false, glow: 0.9 })] : []),
  polygon({ id: `${id}-roof`, at: [0, -flip * 452], points: flipped([[-56, 0], [0, -60], [56, 0]], flip), radius: 5, fill: fill('accent.coral'), lit: false }),
];

const boat = (size: number, main: ColorRef, jib: ColorRef): Part => (id, flip, fill) => [
  polygon({ id: `${id}-main`, points: flipped([[10, -0.26 * size], [10, -1.36 * size], [0.66 * size, -0.26 * size]], flip), radius: 0.02 * size, fill: fill(main), lit: false }),
  polygon({ id: `${id}-jib`, points: flipped([[-10, -0.26 * size], [-0.46 * size, -0.26 * size], [-10, -1.18 * size]], flip), radius: 0.02 * size, fill: fill(jib), lit: false }),
  capsule({ id: `${id}-mast`, at: [0, -flip * 0.14 * size], rotation: -90 * flip, length: 1.28 * size, r: 0.022 * size, origin: 'start', fill: fill('dark.hull'), lit: false }),
  polygon({ id: `${id}-hull`, points: flipped([[-0.52 * size, 0], [-0.6 * size, -0.19 * size], [0.62 * size, -0.19 * size], [0.42 * size, 0]], flip), radius: 0.03 * size, fill: fill('dark.hull'), lit: flip === 1 }),
];

const buoy: Part = (id, flip, fill) => [
  capsule({ id: `${id}-pole`, at: [0, -flip * 40], rotation: -90 * flip, length: 110, r: 6, origin: 'start', fill: fill('dark.hull'), lit: false }),
  circle({ id: `${id}-float`, at: [0, -flip * 30], r: 36, fill: fill('accent.teal'), lit: flip === 1 }),
  ...(flip === 1 ? [circle({ id: `${id}-light`, at: [0, -150], r: 12, fill: 'accent.flame', lit: false, glow: 0.8 })] : []),
];

const things: SceneNode[] = [
  standing('arch', [1500, 0, 6200], rock([[-900, 0], [-860, -420], [-640, -900], [-260, -1160], [240, -1220], [700, -1000], [900, -520], [980, 0], [560, 0], [520, -400], [300, -640], [-40, -660], [-300, -470], [-380, 0]])),
  standing('stack0', [-2500, 0, 5200], rock([[-560, 0], [-520, -360], [-380, -900], [-200, -1300], [-40, -1180], [100, -1500], [300, -1060], [460, -520], [560, 0]])),
  standing('stack1', [3700, 0, 7200], rock([[-240, 0], [-210, -300], [-110, -640], [10, -720], [130, -420], [220, 0]])),
  standing('far-boat', [520, 0, 3900], boat(330, 'light.sail', 'accent.flame')),
  standing('lighthouse', [-1300, 0, 2500], lighthouse),
  standing('mid-boat', [900, 0, 2100], boat(300, 'accent.coral', 'light.sail')),
  standing('near-boat', [-180, 0, 1050], boat(250, 'light.sail', 'accent.gold'), 0.4),
  standing('buoy', [620, 0, 620], buoy, 0.4),
];
timeline.push(moveTo('far-boat', { ...ALWAYS, to: [300, 0, 3900], profile: 'steady', anticipation: 0, overshoot: 0, arc: 0 }));
timeline.push(moveTo('mid-boat', { ...ALWAYS, to: [1160, 0, 2100], profile: 'steady', anticipation: 0, overshoot: 0, arc: 0 }));
timeline.push(moveTo('near-boat', { ...ALWAYS, to: [-520, 0, 1050], profile: 'steady', anticipation: 0, overshoot: 0, arc: 0 }));
// The buoy rides the swell: it leans a little one way and the other.
timeline.push(drive('buoy', { ...ALWAYS, by: (t) => ({ rotation: 5 * Math.sin(1.7 * t) }) }));

// --- The sky: a flat layer behind the space ----------------------------------

const cloud = (id: string, at: Vec2, length: number, fill: ColorRef, opacity: number): SceneNode =>
  group({
    id,
    at,
    opacity,
    children: [
      capsule({ id: `${id}-a`, length, r: 17, fill, lit: false }),
      capsule({ id: `${id}-b`, at: [length * 0.16, -22], length: length * 0.56, r: 15, fill, lit: false }),
      capsule({ id: `${id}-c`, at: [-length * 0.2, 20], length: length * 0.5, r: 12, fill, lit: false }),
    ],
  });
const sky: SceneNode[] = [
  circle({ id: 'sun', at: [SUN_X, -232], r: 132, fill: 'accent.sun', lit: false, glow: 1 }),
  cloud('cloud0', [-560, -400], 620, 'mid.rose', 0.9),
  cloud('cloud1', [640, -330], 460, 'mid.peach', 0.9),
  cloud('cloud2', [-150, -300], 300, 'mid.peach', 0.8),
  cloud('cloud3', [980, -470], 520, 'dark.wine', 0.8),
  cloud('cloud4', [-1040, -290], 380, 'dark.wine', 0.7),
];
['cloud0', 'cloud1', 'cloud2', 'cloud3', 'cloud4'].forEach((id, i) => {
  const from = (sky[i + 1] as { at: Vec2 }).at;
  timeline.push(moveTo(id, { ...ALWAYS, to: [from[0] + 60 + 14 * i, from[1]], profile: 'steady', anticipation: 0, overshoot: 0, arc: 0 }));
});

// Birds: two strokes each, crossing the sky on a slow wave.
const birds: SceneNode[] = [];
[[-1300, -250, 0], [-1380, -210, 0.5], [-1250, -180, 1.1]].forEach(([x, y, phase], i) => {
  const id = `bird${i}`;
  const wings = (lift: number): Vec2[] => [[-30, -8 - lift], [-12, -16 + lift * 0.4], [0, 0], [12, -16 + lift * 0.4], [30, -8 - lift]];
  birds.push(group({ id, at: [x!, y!], children: [stroke({ id: `${id}-wings`, points: wings(0), color: 'deep.rock', width: 7 })] }));
  timeline.push(travel(id, { at: -3 - 0.4 * i, path: Array.from({ length: 30 }, (_, k) => [x! + 100 * k, y! - 60 * Math.sin(k / 6 + phase!) - 3 * k] as Vec2), speed: 150 }));
  timeline.push(drive(`${id}-wings`, { ...ALWAYS, by: (t) => ({ points: wings(9 * Math.sin(7 * t + 2 * phase!)) }) }));
});

export default shot({
  id: 'sea',
  seconds: SECONDS,
  seed: SEED,
  palette,
  strings,
  background: { inner: 'accent.gold', outer: 'dark.plum', center: [0.5 + SUN_X / 1920, 0.3], radius: 0.78 },
  atmosphere: 'mid.peach',
  vignette: 0.4,
  light: { from: 'top-right' },
  camera: { at: [0, 0], drift: { speed: 0.3, heading: 0, wander: 6, period: 8 }, pushIn: { from: 1, to: 1.03 } },
  layers: [
    layer({ id: 'sky', depth: 3, tint: 0, blur: 0, nodes: sky }),
    layer({ id: 'birds', depth: 1.2, tint: 0, blur: 0, nodes: birds }),
    layer({ id: 'space', depth: 0, perspective: { aim: AIM, distance: DISTANCE, tilt: TILT, lens: LENS }, nodes: [sea, ...things] }),
  ],
  timeline: [
    ...timeline,
    // The camera moves in over the water: what is near grows faster than what is far.
    perspectiveTo('space', { ...ALWAYS, distance: 1260, aim: [40, -120, 900], profile: 'steady' }),
  ],
});
