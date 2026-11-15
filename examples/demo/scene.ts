// Demo shot: 15 seconds through the whole engine path, with neutral content.
//
// A glowing source feeds a small network: with every wave of pulses its field
// grows a step and, later, so do the nodes. A blob creature drifts in and
// watches; the network rearranges itself; a tray fades in and a handful of
// pieces tumble into it. The camera drifts to the right and pushes in.
//
// Everything on screen is a simple form (circle, capsule, rounded polygon,
// blob), and every word on screen comes from the string tables.

import {
  blob,
  bump,
  capsule,
  circle,
  drawOn,
  emitter,
  eye,
  fadeTo,
  group,
  label,
  layer,
  link,
  moveTo,
  polygon,
  popIn,
  pulse,
  rect,
  Rng,
  scaleTo,
  shot,
  stagger,
  type ColorRef,
  type Key,
  type SceneNode,
  type Vec2,
} from 'skink3-engine';
import { palette } from './palette.ts';
import { strings } from './strings.ts';

const SEED = 20261115;
const rng = new Rng(SEED, 'demo-layout');

// --- The network -----------------------------------------------------------

const CORE: Vec2 = [150, -40];
const RING = 270;
const NODE_ANGLES = [-16, 34, 92, 148, 194];
const NODE_ANGLES_AFTER = [8, 62, 120, 172, 209];
const RING_AFTER = 318;
const NODE_FILLS: ColorRef[] = ['accent.aqua', 'mid.rose', 'accent.azure', 'mid.violet', 'accent.pink'];

function onRing(angleDeg: number, radius: number): Vec2 {
  const a = (angleDeg * Math.PI) / 180;
  return [CORE[0] + Math.cos(a) * radius, CORE[1] + Math.sin(a) * radius * 0.92];
}

const nodeIds = NODE_ANGLES.map((_, i) => `n${i}`);
const spokeIds = NODE_ANGLES.map((_, i) => `spoke${i}`);

// The field of the source: a translucent disc under the network. It is there
// from the first frame and grows a step with every wave.
const field = circle({ id: 'field', at: CORE, r: 150, fill: 'mid.violet', lit: false, opacity: 0.15 });

// Links are drawn first, so that the nodes cover their ends.
const links: SceneNode[] = [
  ...nodeIds.map((id, i) =>
    link({ id: spokeIds[i]!, from: 'core', to: id, color: 'dark.haze', pulseColor: 'accent.amber', bend: i % 2 === 0 ? 0.1 : -0.1, width: 8 }),
  ),
  link({ id: 'arc0', from: 'n0', to: 'n1', color: 'dark.haze', pulseColor: 'accent.aqua', bend: -0.22, width: 6 }),
  link({ id: 'arc1', from: 'n2', to: 'n3', color: 'dark.haze', pulseColor: 'accent.aqua', bend: -0.22, width: 6 }),
];

const nodes: SceneNode[] = [
  // The source is on screen from the first frame: the shot opens on something alive.
  circle({ id: 'core', at: CORE, r: 76, fill: 'accent.amber', glow: 1 }),
  ...nodeIds.map((id, i) =>
    circle({
      id,
      at: onRing(NODE_ANGLES[i]!, RING),
      r: 42 + (i % 2) * 5,
      fill: NODE_FILLS[i]!,
      rimLight: i % 2 === 0 ? 'light.cream' : 'accent.aqua',
      idle: { amp: 5, period: 3.4 + i * 0.3 },
      // A small satellite that lags behind its node on a spring.
      // The two nodes on the left carry theirs on the outer side, away from the label.
      children: [circle({ id: `${id}-sat`, at: [(i >= 3 ? -1 : 1) * (46 + (i % 2) * 5), -40], r: 10, fill: 'light.cream', follow: { f: 2.8, z: 0.34, r: 0.2 } })],
    }),
  ),
];

// --- The creature: a blob with eyes and two antennae that sway on springs ---

function antenna(id: string, at: Vec2, rotation: number): SceneNode {
  return capsule({
    id,
    at,
    rotation,
    length: 66,
    r: 6.5,
    origin: 'start',
    fill: 'mid.jade',
    sway: { f: 2.1, z: 0.22, r: 0 },
    children: [circle({ id: `${id}-tip`, at: [56, 0], r: 12, fill: 'accent.pink' })],
  });
}

const creature = group({
  id: 'buddy',
  at: [-330, 250],
  idle: { amp: 8, period: 3.1 },
  children: [
    antenna('buddy-ant-l', [-26, -58], -112),
    antenna('buddy-ant-r', [26, -58], -68),
    blob({ id: 'buddy-body', r: 78, points: 9, wobble: 0.09, seed: 5, fill: 'mid.jade', rimLight: 'accent.aqua' }),
    eye({ id: 'buddy-eye-l', at: [-27, -14], r: 19, white: 'light.snow', pupil: 'deep.abyss', lookAt: 'focus' }),
    eye({ id: 'buddy-eye-r', at: [27, -14], r: 19, white: 'light.snow', pupil: 'deep.abyss', lookAt: 'focus' }),
  ],
});

// --- The tray and the pieces that tumble into it ----------------------------

// The tray is invisible at first and fades in once the camera has brought its
// place fully into the frame, well before the pieces are released.
const TRAY_X = 950;
const TRAY_Y = 372;
const trayIds = ['tray-floor', 'tray-wall-l', 'tray-wall-r'];
const tray: SceneNode[] = [
  rect({ id: 'tray-floor', at: [TRAY_X, TRAY_Y], w: 430, h: 36, radius: 16, fill: 'dark.indigo', rimLight: 'mid.violet', opacity: 0, body: { kind: 'fixed' } }),
  rect({ id: 'tray-wall-l', at: [TRAY_X - 205, TRAY_Y - 96], w: 36, h: 210, radius: 16, rotation: -9, fill: 'dark.indigo', rimLight: 'mid.violet', opacity: 0, body: { kind: 'fixed' } }),
  rect({ id: 'tray-wall-r', at: [TRAY_X + 205, TRAY_Y - 96], w: 36, h: 210, radius: 16, rotation: 9, fill: 'dark.indigo', rimLight: 'mid.violet', opacity: 0, body: { kind: 'fixed' } }),
];

const PIECE_FILLS: ColorRef[] = ['accent.coral', 'accent.aqua', 'mid.violet', 'accent.amber', 'accent.pink', 'accent.azure', 'mid.rose'];
const PIECE_COUNT = 14;
const pieceIds: string[] = [];
const pieces: SceneNode[] = [];
for (let i = 0; i < PIECE_COUNT; i++) {
  const id = `piece${i}`;
  const col = i % 4;
  const row = Math.floor(i / 4);
  const at: Vec2 = [TRAY_X - 135 + col * 90 + rng.range(-12, 12), -345 + row * 84 + rng.range(-10, 10)];
  // The lowest row goes first.
  const release = 8.8 + (3 - row) * 0.36 + col * 0.1 + rng.range(0, 0.05);
  const common = {
    id,
    at,
    fill: PIECE_FILLS[i % PIECE_FILLS.length]!,
    rotation: rng.range(-25, 25),
    body: { kind: 'dynamic' as const, release, spin: rng.range(60, 190) * rng.sign(), velocity: [rng.range(-35, 35), 0] as Vec2 },
  };
  const kind = i % 5;
  if (kind === 0) pieces.push(circle({ ...common, r: rng.range(25, 31) }));
  else if (kind === 1) pieces.push(rect({ ...common, w: 58, h: 58, radius: 13 }));
  else if (kind === 2) pieces.push(polygon({ ...common, sides: 3, r: 38, radius: 9 }));
  else if (kind === 3) pieces.push(capsule({ ...common, length: 92, r: 17 }));
  else pieces.push(polygon({ ...common, sides: 6, r: 32, radius: 8 }));
  pieceIds.push(id);
}

// --- Background layers ------------------------------------------------------
//
// Far shapes are pale and close to one tone (the depth tint does that), and
// they keep clear of the place where the network is: the middle of the frame
// stays deep, so the diagram reads against it. Coordinates are in each layer's
// own space; a far layer moves less than the stage, so "behind the network" is
// a wide band there.

// [x, y, radius, fill]
type Disc = [number, number, number, ColorRef];

// Large soft discs far away, at the far left and the far right.
const DISTANCE: Disc[] = [
  [-930, -200, 250, 'dark.indigo'],
  [1200, -250, 245, 'dark.indigo'],
  [1215, 290, 205, 'dark.navy'],
];

// The far layer frames the stage: low hills along the bottom and a ceiling of
// the same kind along the top (circles whose edges peek into the frame).
const HILLS: Disc[] = [
  [-420, 960, 780, 'mid.violet'],
  [560, 1090, 860, 'dark.haze'],
  [1500, 950, 760, 'mid.violet'],
];
const CEILING: Disc[] = [
  [-560, -1120, 760, 'dark.haze'],
  [420, -1225, 860, 'mid.violet'],
  [1380, -1110, 760, 'dark.haze'],
];

// Smaller far shapes at the sides.
const FAR: Disc[] = [
  [-860, -150, 82, 'mid.violet'],
  [-770, 110, 54, 'dark.indigo'],
  [-905, 250, 66, 'mid.violet'],
  [1090, -230, 74, 'dark.indigo'],
  [1235, -20, 86, 'mid.violet'],
  [1125, 180, 58, 'dark.indigo'],
];

function discs(prefix: string, list: Disc[], idleAmp: number): SceneNode[] {
  return list.map(([x, y, r, fill], i) => {
    const idle = idleAmp > 0 ? { amp: idleAmp, period: 5.5 + (i % 4) } : undefined;
    return i % 3 === 0 && r < 120
      ? blob({ id: `${prefix}${i}`, at: [x, y], r, points: 8, wobble: 0.12, seed: i + 1, fill, ...(idle ? { idle } : {}) })
      : circle({ id: `${prefix}${i}`, at: [x, y], r, fill, ...(idle ? { idle } : {}) });
  });
}

function scatter(prefix: string, count: number, box: [number, number, number, number], radius: Vec2, fills: ColorRef[]): SceneNode[] {
  const r = new Rng(SEED, `scatter/${prefix}`);
  const out: SceneNode[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${prefix}${i}`;
    const at: Vec2 = [r.range(box[0], box[2]), r.range(box[1], box[3])];
    const size = r.range(radius[0], radius[1]);
    const fill = r.pick(fills);
    out.push(i % 3 === 0 ? blob({ id, at, r: size, points: 8, wobble: 0.12, seed: i + 1, fill }) : circle({ id, at, r: size, fill }));
  }
  return out;
}

// --- Timeline ---------------------------------------------------------------

const PULSE_DUR = 0.62;
const WAVE_EACH = 0.11;
const WAVES = [2.2, 4.6, 9.3, 11.6, 13.4];
/** When the pulse of wave `w` reaches node `i`. */
const arrival = (w: number, i: number): number => WAVES[w]! + 0.05 + i * WAVE_EACH + PULSE_DUR;
/** Size of the field after each wave, as a multiple of its first size. */
const FIELD_STEPS = [1.22, 1.45, 1.68, 1.9, 2.1];

const timeline: Key[] = [
  // The source is already there and beats once; its nodes appear one after another.
  bump('core', { at: 0.12, amount: 0.12 }),
  ...stagger(nodeIds, { at: 0.45, each: 0.11 }, (id, at) => popIn(id, { at })),
  ...stagger(spokeIds, { at: 1.1, each: 0.1 }, (id, at) => drawOn(id, { at, dur: 0.5 })),

  // Waves: the source beats, a pulse runs down every spoke, the field grows a step (scaleTo).
  ...WAVES.flatMap((at, w) => [
    bump('core', { at, amount: 0.1 }),
    ...stagger(spokeIds, { at: at + 0.05, each: WAVE_EACH }, (id, t) => pulse(id, { at: t, dur: PULSE_DUR })),
    scaleTo('field', { at: at + 0.1, to: FIELD_STEPS[w]!, dur: 0.9, overshoot: 0.2 }),
  ]),
  // The first wave also switches the field on a little brighter (fadeTo).
  fadeTo('field', { at: WAVES[0]!, to: 0.24, dur: 0.7 }),
  // Nodes that have been fed twice, then four times, grow a step when the pulse arrives.
  ...nodeIds.flatMap((id, i) => [
    scaleTo(id, { at: arrival(1, i), to: 1.18 }),
    scaleTo(id, { at: arrival(3, i), to: 1.36 }),
  ]),

  popIn('label-source', { at: 2.95 }),
  ...stagger(['arc0', 'arc1'], { at: 3.5, each: 0.2 }, (id, at) => drawOn(id, { at, dur: 0.6 })),
  pulse('arc0', { at: 5.6, dur: 0.6 }),
  pulse('arc1', { at: 5.85, dur: 0.6 }),
  pulse('arc0', { at: 12.5, dur: 0.6 }),
  pulse('arc1', { at: 12.75, dur: 0.6 }),

  // The creature drifts in and comes closer.
  popIn('buddy', { at: 4.05, dur: 0.6 }),
  moveTo('buddy', { at: 5.3, to: [-150, 300], dur: 1.2, arc: 0.3 }),

  // The network rearranges itself: anticipation, arc, overshoot, one node after another.
  ...stagger(nodeIds, { at: 6.5, each: 0.1 }, (id, at, i) =>
    moveTo(id, { at, to: onRing(NODE_ANGLES_AFTER[i]!, RING_AFTER), dur: 1.1, anticipation: 0.2, overshoot: 0.14, arc: 0.2 }),
  ),

  // The tray fades in (fadeTo); pieces appear above it and are released into it.
  ...stagger(trayIds, { at: 6.2, each: 0.12 }, (id, at) => fadeTo(id, { at, to: 1, dur: 0.7 })),
  ...stagger(pieceIds, { at: 7.35, each: 0.07 }, (id, at) => popIn(id, { at, dur: 0.45 })),
  moveTo('focus', { at: 8.3, to: [TRAY_X, 120], dur: 1.2, anticipation: 0, overshoot: 0, arc: 0 }),
  moveTo('buddy', { at: 10.3, to: [540, 285], dur: 1.7, arc: -0.12 }),
  popIn('label-landing', { at: 12.6 }),
  bump('buddy', { at: 13.9, amount: 0.12 }),
];

// Sparks: one emitter per node, bursting whenever a pulse arrives.
const sparks: SceneNode[] = nodeIds.map((id, i) =>
  emitter({
    id: `sparks-${id}`,
    attach: id,
    bursts: WAVES.map((_, w) => ({ at: arrival(w, i), count: 9 })),
    colors: ['accent.amber', 'light.cream'],
    size: [3, 6.5],
    life: [0.45, 0.9],
    speed: [70, 210],
    spread: 360,
    drag: 3.2,
    glow: 0.8,
  }),
);

// --- The shot ---------------------------------------------------------------

export default shot({
  id: 'demo',
  seconds: 15,
  seed: SEED,
  palette,
  strings,
  light: { from: 'top-left' },
  background: { inner: 'deep.night', outer: 'deep.abyss', center: [0.46, 0.44], radius: 0.7 },
  atmosphere: 'mid.mist',
  vignette: 0.3,
  camera: {
    drift: { speed: 0.7, heading: 0, wander: 9, period: 6 },
    pushIn: { from: 1, to: 1.07 },
  },
  layers: [
    layer({ id: 'distance', depth: 2.4, nodes: discs('distance', DISTANCE, 0) }),
    layer({
      id: 'far',
      depth: 1,
      nodes: [
        ...discs('ceiling', CEILING, 0),
        ...discs('hill', HILLS, 0),
        ...discs('far', FAR, 12),
        emitter({
          id: 'far-dust',
          at: [300, 0],
          area: [2800, 1300],
          rate: 8,
          prewarm: 14,
          life: [9, 15],
          size: [2.5, 5],
          speed: [4, 12],
          drag: 0.3,
          turbulence: { strength: 14, scale: 300, speed: 0.04 },
          colors: ['light.mint', 'accent.aqua', 'light.cream'],
        }),
      ],
    }),
    layer({
      id: 'stage',
      depth: 0,
      nodes: [
        emitter({
          id: 'motes',
          at: [500, 0],
          area: [3000, 1250],
          rate: 11,
          prewarm: 12,
          life: [7, 12],
          size: [2.5, 6],
          speed: [6, 18],
          drag: 0.4,
          turbulence: { strength: 26, scale: 260, speed: 0.05 },
          colors: ['accent.aqua', 'light.cream', 'accent.pink', 'mid.violet'],
          glow: 0.5,
        }),
        field,
        ...links,
        ...sparks,
        ...nodes,
        creature,
        ...tray,
        ...pieces,
        emitter({
          id: 'puffs',
          onContact: { count: 5, minImpulse: 0.35 },
          colors: ['light.cream', 'mid.violet', 'light.mint'],
          size: [3, 7],
          life: [0.35, 0.75],
          speed: [50, 150],
          direction: -90,
          spread: 170,
          gravity: [0, 180],
          drag: 3,
        }),
        // Invisible helpers: what the creature looks at, and where the second label points.
        group({ id: 'focus', at: CORE }),
        group({ id: 'pile-top', at: [TRAY_X, TRAY_Y - 215] }),
        label({ id: 'label-source', text: 'label.source', target: 'core', side: 'top', fill: 'light.cream', ink: 'deep.night', maxWidth: 360, follow: 'light' }),
        label({ id: 'label-landing', text: 'label.landing', target: 'pile-top', side: 'top', fill: 'light.cream', ink: 'deep.night', maxWidth: 360 }),
      ],
    }),
    layer({
      id: 'near',
      depth: -0.5,
      nodes: [
        ...scatter('near-blob', 5, [-700, 720, 2900, 760], [270, 310], ['deep.night', 'dark.indigo', 'dark.navy']),
        ...scatter('near-top', 3, [-500, -800, 2900, -760], [270, 310], ['deep.night', 'dark.indigo']),
      ],
    }),
  ],
  timeline,
});
