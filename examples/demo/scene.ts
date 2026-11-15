// Demo shot: 15 seconds through the whole engine path, with neutral content.
//
// A glowing source wakes up a small network; pulses travel along the links; a
// blob creature drifts in and watches; the network rearranges itself; a handful
// of pieces tumble into a tray. The camera drifts to the right and pushes in.
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
const NODE_ANGLES = [-22, 34, 92, 148, 197];
const NODE_ANGLES_AFTER = [8, 62, 120, 172, 209];
const RING_AFTER = 318;
const NODE_FILLS: ColorRef[] = ['accent.aqua', 'mid.rose', 'accent.azure', 'mid.violet', 'accent.pink'];

function onRing(angleDeg: number, radius: number): Vec2 {
  const a = (angleDeg * Math.PI) / 180;
  return [CORE[0] + Math.cos(a) * radius, CORE[1] + Math.sin(a) * radius * 0.92];
}

const nodeIds = NODE_ANGLES.map((_, i) => `n${i}`);
const spokeIds = NODE_ANGLES.map((_, i) => `spoke${i}`);

// Links are drawn first, so that the nodes cover their ends.
const links: SceneNode[] = [
  ...nodeIds.map((id, i) =>
    link({ id: spokeIds[i]!, from: 'core', to: id, color: 'dark.haze', pulseColor: 'accent.amber', bend: i % 2 === 0 ? 0.1 : -0.1, width: 8 }),
  ),
  link({ id: 'arc0', from: 'n0', to: 'n1', color: 'dark.haze', pulseColor: 'accent.aqua', bend: -0.22, width: 6 }),
  link({ id: 'arc1', from: 'n2', to: 'n3', color: 'dark.haze', pulseColor: 'accent.aqua', bend: -0.22, width: 6 }),
];

const nodes: SceneNode[] = [
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

const TRAY_X = 1060;
const TRAY_Y = 372;
const tray: SceneNode[] = [
  rect({ id: 'tray-floor', at: [TRAY_X, TRAY_Y], w: 430, h: 36, radius: 16, fill: 'dark.indigo', rimLight: 'mid.violet', body: { kind: 'fixed' } }),
  rect({ id: 'tray-wall-l', at: [TRAY_X - 205, TRAY_Y - 96], w: 36, h: 210, radius: 16, rotation: -9, fill: 'dark.indigo', rimLight: 'mid.violet', body: { kind: 'fixed' } }),
  rect({ id: 'tray-wall-r', at: [TRAY_X + 205, TRAY_Y - 96], w: 36, h: 210, radius: 16, rotation: 9, fill: 'dark.indigo', rimLight: 'mid.violet', body: { kind: 'fixed' } }),
];

const PIECE_FILLS: ColorRef[] = ['accent.coral', 'accent.aqua', 'mid.violet', 'accent.amber', 'accent.pink', 'accent.azure', 'mid.rose'];
const PIECE_COUNT = 14;
const pieceIds: string[] = [];
const pieces: SceneNode[] = [];
const releaseAt: number[] = [];
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
  releaseAt.push(release);
}

// --- Background layers ------------------------------------------------------

// Large soft discs far away: [x, y, radius, fill] in the layer's own space.
const DISTANCE: [number, number, number, ColorRef][] = [
  [-640, -250, 230, 'dark.indigo'],
  [90, 400, 190, 'dark.navy'],
  [770, -290, 255, 'dark.plum'],
  [930, 310, 200, 'dark.indigo'],
  [-900, 430, 170, 'dark.navy'],
  [330, -520, 135, 'dark.plum'],
];

// Low hills along the bottom of the far layer: circles whose tops peek into the frame.
const HILLS: [number, number, number, ColorRef][] = [
  [-420, 1060, 780, 'mid.violet'],
  [560, 1200, 860, 'mid.ocean'],
  [1500, 1050, 760, 'mid.violet'],
];

function scatter(prefix: string, count: number, box: [number, number, number, number], radius: Vec2, fills: ColorRef[], idleAmp: number): SceneNode[] {
  const r = new Rng(SEED, `scatter/${prefix}`);
  const out: SceneNode[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${prefix}${i}`;
    const at: Vec2 = [r.range(box[0], box[2]), r.range(box[1], box[3])];
    const size = r.range(radius[0], radius[1]);
    const fill = r.pick(fills);
    const idle = { amp: idleAmp, period: r.range(5, 9) };
    out.push(
      i % 3 === 0
        ? blob({ id, at, r: size, points: 8, wobble: 0.12, seed: i + 1, fill, idle })
        : circle({ id, at, r: size, fill, idle }),
    );
  }
  return out;
}

// --- Timeline ---------------------------------------------------------------

/** A wave of pulses from the source along every spoke; each arrival throws a few sparks. */
function wave(at: number, each = 0.11): { keys: Key[]; arrivals: number[] } {
  const dur = 0.62;
  return {
    keys: [bump('core', { at, amount: 0.1 }), ...stagger(spokeIds, { at: at + 0.05, each }, (id, t) => pulse(id, { at: t, dur }))],
    arrivals: spokeIds.map((_, i) => at + 0.05 + i * each + dur),
  };
}

const waves = [2.5, 4.7, 9.4, 11.7, 13.5].map((at) => wave(at));

const timeline: Key[] = [
  // The source appears, then its nodes, one after another.
  popIn('core', { at: 0.35, dur: 0.7, overshoot: 0.22 }),
  ...stagger(nodeIds, { at: 0.95, each: 0.11 }, (id, at) => popIn(id, { at })),
  ...stagger(spokeIds, { at: 1.55, each: 0.11 }, (id, at) => drawOn(id, { at, dur: 0.55 })),
  ...waves.flatMap((w) => w.keys),
  popIn('label-source', { at: 3.15 }),
  ...stagger(['arc0', 'arc1'], { at: 3.6, each: 0.2 }, (id, at) => drawOn(id, { at, dur: 0.6 })),
  pulse('arc0', { at: 5.5, dur: 0.6 }),
  pulse('arc1', { at: 5.75, dur: 0.6 }),
  pulse('arc0', { at: 12.4, dur: 0.6 }),
  pulse('arc1', { at: 12.65, dur: 0.6 }),

  // The creature drifts in and comes closer.
  popIn('buddy', { at: 4.05, dur: 0.6 }),
  moveTo('buddy', { at: 5.3, to: [-150, 300], dur: 1.2, arc: 0.3 }),

  // The network rearranges itself: anticipation, arc, overshoot, one node after another.
  ...stagger(nodeIds, { at: 6.5, each: 0.1 }, (id, at, i) =>
    moveTo(id, { at, to: onRing(NODE_ANGLES_AFTER[i]!, RING_AFTER), dur: 1.1, anticipation: 0.2, overshoot: 0.14, arc: 0.2 }),
  ),

  // Pieces appear above the tray and are released into it.
  ...stagger(pieceIds, { at: 7.35, each: 0.07 }, (id, at) => popIn(id, { at, dur: 0.45 })),
  moveTo('focus', { at: 8.3, to: [TRAY_X, 120], dur: 1.2, anticipation: 0, overshoot: 0, arc: 0 }),
  moveTo('buddy', { at: 10.3, to: [590, 285], dur: 1.7, arc: -0.12 }),
  popIn('label-landing', { at: 12.6 }),
  bump('buddy', { at: 13.9, amount: 0.12 }),
];

// Sparks: one emitter per node, bursting whenever a pulse arrives.
const sparks: SceneNode[] = nodeIds.map((id, i) =>
  emitter({
    id: `sparks-${id}`,
    attach: id,
    bursts: waves.map((w) => ({ at: w.arrivals[i]!, count: 9 })),
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
  vignette: 0.45,
  camera: {
    drift: { speed: 0.7, heading: 0, wander: 9, period: 6 },
    pushIn: { from: 1, to: 1.07 },
  },
  layers: [
    layer({
      id: 'distance',
      depth: 2.4,
      tint: 0.86,
      nodes: DISTANCE.map(([x, y, r, fill], i) => circle({ id: `distance${i}`, at: [x, y], r, fill })),
    }),
    layer({
      id: 'far',
      depth: 1,
      nodes: [
        ...HILLS.map(([x, y, r, fill], i) => circle({ id: `hill${i}`, at: [x, y], r, fill })),
        ...scatter('far-blob', 16, [-900, -500, 1500, 250], [30, 88], ['mid.violet', 'mid.ocean', 'dark.plum', 'mid.violet', 'dark.navy'], 12),
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
        ...scatter('near-blob', 7, [-700, 690, 2900, 730], [270, 310], ['deep.night', 'dark.indigo', 'dark.navy'], 0),
        ...scatter('near-top', 4, [-500, -770, 2900, -730], [270, 310], ['deep.night', 'dark.indigo'], 0),
      ],
    }),
  ],
  timeline,
});
