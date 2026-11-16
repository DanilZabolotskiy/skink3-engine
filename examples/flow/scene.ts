// Flow shot: 10 seconds of things that travel, fill and hide, with neutral content.
//
// Beads run along a curved path at one speed and vanish behind a block. Smaller
// beads leave the block along a second path and sink into a vessel, whose
// content rises with a rippling surface; fizz stays inside the content, a
// float rides on it and a label follows it. A blob creature hops onto a step
// and squashes as it lands. The camera goes round a loop, so the subject stays
// framed while the background keeps sliding.
//
// It shows: travel() along a free-form path, keys that start before the shot,
// cover, level and levelTo(), clipTo, hop() and squash(), the "steady" size of
// particles, a backdrop for labels, and a camera path.

import {
  blob,
  capsule,
  circle,
  emitter,
  eye,
  fadeTo,
  group,
  hop,
  label,
  layer,
  levelTo,
  loopPoints,
  popIn,
  rect,
  shot,
  squash,
  stagger,
  travel,
  type Key,
  type SceneNode,
  type StringTables,
  type Vec2,
} from 'skink3-engine';
import { palette } from '../demo/palette.ts';

const SEED = 20261116;
const SECONDS = 10;
const GROUND_Y = 300;

const strings: StringTables = {
  en: { 'label.block': 'Sorter', 'label.level': 'Level' },
  'x-long': { 'label.block': 'The block where every bead is sorted', 'label.level': 'How much has been gathered so far' },
};

// --- The block the beads vanish behind --------------------------------------

const BLOCK: Vec2 = [-300, 150];

// --- Beads in: one speed along a curved path, under way before the shot starts ---

const IN_PATH: Vec2[] = [[-1180, -260], [-860, -300], [-600, -60], BLOCK];
const IN_SPEED = 250;
const IN_EVERY = 0.52;
const inIds = Array.from({ length: 24 }, (_, i) => `in${i}`);
const inBeads: SceneNode[] = inIds.map((id) =>
  circle({
    id,
    at: IN_PATH[0]!,
    r: 17,
    fill: 'accent.amber',
    glow: 0.7,
    // A dot off the centre shows that the bead rolls.
    children: [circle({ id: `${id}-dot`, at: [8, 0], r: 4.5, fill: 'light.cream', lit: false })],
  }),
);
const inKeys: Key[] = stagger(inIds, { at: -4.6, each: IN_EVERY }, (id, at) =>
  travel(id, { at, path: IN_PATH, speed: IN_SPEED, roll: 17, only: true }),
);

// --- Beads out: they wait behind the block, leave it, and sink into the vessel ---

const VESSEL_X = 330;
const OUT_PATH: Vec2[] = [BLOCK, [-60, -40], [150, -236], [VESSEL_X, -150], [VESSEL_X, 246]];
const OUT_SECONDS = 2.9;
const outIds = Array.from({ length: 9 }, (_, i) => `out${i}`);
const outBeads: SceneNode[] = outIds.map((id) => circle({ id, at: BLOCK, r: 11, fill: 'accent.aqua', glow: 0.6 }));
const outKeys: Key[] = stagger(outIds, { at: 0.5, each: 0.8 }, (id, at) => [
  travel(id, { at, path: OUT_PATH, dur: OUT_SECONDS, profile: 'in', ramp: 0.2 }),
  // It dissolves in the content at the end of its way.
  fadeTo(id, { at: at + OUT_SECONDS - 0.4, to: 0, dur: 0.4 }),
]);

// --- The vessel and its content ----------------------------------------------

const vessel: SceneNode[] = [
  rect({ id: 'glass', at: [VESSEL_X, 110], w: 300, h: 380, radius: 44, fill: 'dark.navy', opacity: 0.5 }),
  rect({
    id: 'content',
    at: [VESSEL_X, 116],
    w: 264,
    h: 344,
    radius: 30,
    fill: 'mid.ocean',
    glow: 0.25,
    level: { at: 0.1, wave: { amp: 5, length: 150, speed: 36 } },
    // Children ride on the surface: a float, and an anchor at the edge for the label.
    children: [
      circle({ id: 'float', at: [44, -5], r: 15, fill: 'light.cream', idle: { amp: 3, period: 2.4 } }),
      group({ id: 'surface-edge', at: [-152, 0] }),
      group({ id: 'surface', at: [0, 0] }),
    ],
  }),
  // Fizz rises in the content and is drawn only inside it.
  emitter({
    id: 'fizz',
    at: [VESSEL_X, 280],
    area: [220, 16],
    rate: 9,
    direction: -90,
    spread: 26,
    speed: [34, 58],
    life: [3.2, 4.4],
    size: [4, 8],
    drag: 0.1,
    colors: ['light.mint', 'accent.aqua'],
    sizing: 'steady',
    prewarm: 3,
    clipTo: 'content',
  }),
];

// --- A creature that hops onto a step ------------------------------------------

const BUDDY_R = 50;
const STEP: Vec2 = [672, 240];
const STEP_TOP = STEP[1] - 60;
const buddyStart: Vec2 = [824, GROUND_Y - BUDDY_R];
const buddyOnStep: Vec2 = [STEP[0], STEP_TOP - BUDDY_R];
const HOP_AT = 4.3;
const HOP_SECONDS = 0.72;
const buddy: SceneNode = blob({
  id: 'buddy',
  at: buddyStart,
  r: BUDDY_R,
  wobble: 0.1,
  seed: 5,
  fill: 'accent.coral',
  children: [
    capsule({ id: 'buddy-arm-l', at: [-40, 12], rotation: 115, length: 46, r: 8, fill: 'accent.coral', origin: 'start', sway: 'springy' }),
    capsule({ id: 'buddy-arm-r', at: [40, 12], rotation: 65, length: 46, r: 8, fill: 'accent.coral', origin: 'start', sway: 'springy' }),
    eye({ id: 'buddy-eye-l', at: [-17, -10], r: 13, white: 'light.snow', pupil: 'deep.abyss', lookAt: 'surface' }),
    eye({ id: 'buddy-eye-r', at: [17, -10], r: 13, white: 'light.snow', pupil: 'deep.abyss', lookAt: 'surface' }),
  ],
});
const buddyKeys: Key[] = [
  // It crouches, leaves at a known moment, lands at a known moment, and squashes against the step.
  squash('buddy', { at: HOP_AT - 0.3, amount: -0.16, dur: 0.34, pivot: [0, BUDDY_R] }),
  hop('buddy', { at: HOP_AT, to: buddyOnStep, dur: HOP_SECONDS, height: 150 }),
  squash('buddy', { at: HOP_AT + HOP_SECONDS, amount: -0.26, dur: 0.7, pivot: [0, BUDDY_R] }),
];

// --- The set ---------------------------------------------------------------------

const far: SceneNode[] = [
  circle({ id: 'far-a', at: [-620, -40], r: 250, fill: 'mid.violet', lit: false, opacity: 0.5 }),
  circle({ id: 'far-b', at: [780, -260], r: 190, fill: 'mid.ocean', lit: false, opacity: 0.45 }),
  circle({ id: 'far-c', at: [1500, 120], r: 300, fill: 'mid.violet', lit: false, opacity: 0.4 }),
  emitter({
    id: 'motes',
    at: [0, 0],
    area: [3000, 1500],
    rate: 16,
    life: [5, 8],
    size: [2.5, 6],
    speed: [10, 26],
    drag: 0.05,
    turbulence: { strength: 16, scale: 320, speed: 0.12 },
    colors: ['light.cream', 'mid.mist'],
    glow: 0.4,
    sizing: 'steady',
    prewarm: 8,
  }),
];

const near: SceneNode[] = [
  blob({ id: 'near-a', at: [-1160, 640], r: 260, seed: 3, fill: 'dark.plum', idle: { amp: 14, period: 7 } }),
  blob({ id: 'near-b', at: [1240, -660], r: 240, seed: 8, fill: 'dark.navy', idle: { amp: 14, period: 8 } }),
];

export default shot({
  id: 'flow',
  seconds: SECONDS,
  seed: SEED,
  palette,
  strings,
  background: { inner: 'deep.night', outer: 'deep.abyss' },
  atmosphere: 'mid.mist',
  camera: {
    // A loop round the middle of the stage: the speed of a drift, without ever leaving the subject.
    path: { points: loopPoints([0, -10], [84, 30]), closed: true, speed: 0.45 },
    drift: { wander: 10, period: 6 },
    pushIn: { from: 1, to: 1.05 },
  },
  layers: [
    layer({ id: 'far', depth: 1.5, nodes: far }),
    layer({
      id: 'stage',
      depth: 0,
      nodes: [
        rect({ id: 'ground', at: [0, GROUND_Y + 300], w: 3200, h: 600, radius: 0, fill: 'deep.ink', lit: false, backdrop: true }),
        ...inBeads,
        ...outBeads,
        // The block is a cover: beads behind it do not shine through it, and the review does not judge what it hides.
        rect({
          id: 'block',
          at: BLOCK,
          w: 250,
          h: 300,
          radius: 34,
          fill: 'dark.indigo',
          cover: true,
          children: [circle({ id: 'block-lamp', at: [0, -70], r: 22, fill: 'accent.pink', glow: 0.8, idle: { amp: 2, period: 3 } })],
        }),
        ...vessel,
        rect({ id: 'step', at: STEP, w: 190, h: 120, radius: 26, fill: 'dark.plum' }),
        buddy,
        label({ id: 'label-block', text: 'label.block', target: 'block', side: 'top', fill: 'light.cream', ink: 'deep.abyss', maxWidth: 300 }),
        label({ id: 'label-level', text: 'label.level', target: 'surface-edge', side: 'left', fill: 'light.cream', ink: 'deep.abyss', size: 34, maxWidth: 210, follow: 'light' }),
      ],
    }),
    layer({ id: 'near', depth: -0.5, nodes: near }),
  ],
  timeline: [
    inKeys,
    outKeys,
    // The content rises as the beads arrive, at one speed, with eased ends: it is full of what came in at 9 s.
    levelTo('content', { at: 2.4, to: 0.82, dur: 6.6, profile: 'ease', ramp: 0.15 }),
    buddyKeys,
    popIn('label-block', { at: 0.5 }),
    popIn('label-level', { at: 2.8 }),
  ],
});
