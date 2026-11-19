// Space shot: 12 seconds in a perspective layer, with neutral content.
//
// A floor lies in the space of the layer, with a grid and an island drawn on
// it as on a map, and a pin stands upright on the island. A wire cube turns
// half a turn about a level axis, and the lamp above it throws its wire
// shadow on the floor. A moon goes round a globe, in front of it and behind
// it. A card that stands at the back falls on its hinge and lies on the
// floor; a ramp beside it is a face of four points of the space. The camera
// rises to look down on all of it and goes round it, and then moves in: what
// is near grows faster than what is far.
//
// It shows: a perspective layer and perspectiveTo(), places of three numbers,
// a group that lies in a plane, a hinge (turnTo with about), a region of
// points of the space, drive() with a function of time, links that hold the
// driven corners of a frame together, and depth.

import {
  capsule,
  circle,
  drive,
  group,
  layer,
  link,
  perspectiveTo,
  popIn,
  rect,
  region,
  shot,
  stroke,
  turnTo,
  Rng,
  type Key,
  type SceneNode,
  type StringTables,
  type Vec2,
  type Vec3,
} from 'skink3-engine';
import { palette } from '../demo/palette.ts';

const SEED = 20261119;
const SECONDS = 12;
/** The height of the floor: y grows downward, so the floor lies below the middle of the space. */
const FLOOR_Y = 260;

const strings: StringTables = { en: {} };

// --- The floor: a group that lies in a plane, drawn as a map is --------------

const ISLAND: Vec2[] = [[-560, -60], [-470, -230], [-300, -280], [-170, -190], [-200, -40], [-300, 70], [-460, 90]];
const lines: SceneNode[] = [];
for (let i = -3; i <= 3; i++) {
  lines.push(stroke({ id: `across${i + 3}`, points: [[-700, i * 160], [700, i * 160]], color: 'dark.haze', width: 4, smooth: 0 }));
  lines.push(stroke({ id: `along${i + 3}`, points: [[i * 220, -500], [i * 220, 500]], color: 'dark.haze', width: 4, smooth: 0 }));
}
const floor = group({
  id: 'floor',
  at: [0, FLOOR_Y, 0],
  plane: 'floor',
  // The ground is drawn first, behind everything that stands on it.
  depth: 4000,
  children: [rect({ id: 'ground', w: 1500, h: 1100, radius: 60, fill: 'deep.ink', lit: false }), ...lines, region({ id: 'island', points: ISLAND, fill: 'mid.jade', lit: false })],
});

// A pin stands upright on the island: an ordinary flat node at a place of the space.
const pin = group({
  id: 'pin',
  at: [-360, FLOOR_Y, 110],
  children: [
    capsule({ id: 'pin-stem', at: [0, -6], rotation: -90, length: 150, r: 9, origin: 'start', fill: 'light.cream' }),
    circle({ id: 'pin-head', at: [0, -170], r: 46, fill: 'accent.coral' }),
  ],
});

// --- The wire cube: eight driven corners, twelve links ----------------------

const CUBE: Vec3 = [360, 30, 40];
const HALF = 125;
const LAMP: Vec3 = [360, -620, 40];
const TURN = { at: 1.4, dur: 6 };
const CORNERS: Vec3[] = [];
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) CORNERS.push([x * HALF, y * HALF, z * HALF]);
const EDGES: [number, number][] = [];
for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) if (CORNERS[a]!.filter((v, k) => v !== CORNERS[b]![k]).length === 1) EDGES.push([a, b]);

/** Half a turn about the level axis through the middle of the cube, eased at both ends. */
const angleAt = (seconds: number): number => {
  const u = Math.min(1, Math.max(0, seconds / TURN.dur));
  return Math.PI * u * u * (3 - 2 * u);
};
const cornerAt = (p: Vec3, angle: number): Vec3 => [CUBE[0] + p[0], CUBE[1] + p[1] * Math.cos(angle) - p[2] * Math.sin(angle), CUBE[2] + p[1] * Math.sin(angle) + p[2] * Math.cos(angle)];
/** Where the lamp throws a point onto the floor. */
const shadowOf = (p: Vec3): Vec3 => {
  const k = (FLOOR_Y - LAMP[1]) / (p[1] - LAMP[1]);
  return [LAMP[0] + (p[0] - LAMP[0]) * k, FLOOR_Y, LAMP[2] + (p[2] - LAMP[2]) * k];
};

const cube: SceneNode[] = [];
const cubeKeys: Key[] = [];
CORNERS.forEach((p, i) => {
  // A corner is a group with nothing in it: a place for the links to hold on to.
  cube.push(group({ id: `corner${i}`, at: cornerAt(p, 0) }));
  cube.push(group({ id: `shade${i}`, at: shadowOf(cornerAt(p, 0)), depth: 2000 }));
  cubeKeys.push(drive(`corner${i}`, { ...TURN, by: (t) => ({ at: cornerAt(p, angleAt(t)) }) }));
  cubeKeys.push(drive(`shade${i}`, { ...TURN, by: (t) => ({ at: shadowOf(cornerAt(p, angleAt(t))) }) }));
});
EDGES.forEach(([a, b], i) => {
  cube.push(link({ id: `shadow${i}`, from: `shade${a}`, to: `shade${b}`, color: 'deep.abyss', width: 9, bend: 0, gap: 0 }));
  cube.push(link({ id: `stick${i}`, from: `corner${a}`, to: `corner${b}`, color: 'accent.amber', width: 9, bend: 0, gap: 0, glow: 0.3 }));
});

// --- The globe and its moon: what is nearer is drawn over what is farther ----

const GLOBE: Vec3 = [-180, 40, 380];
const ROUND = 5;
const moonAt = (seconds: number): Vec3 => {
  const a = (2 * Math.PI * seconds) / ROUND;
  return [GLOBE[0] + 250 * Math.cos(a), GLOBE[1] - 50 * Math.sin(a), GLOBE[2] - 250 * Math.sin(a)];
};

// --- The card on its hinge, and the ramp -------------------------------------

const card = group({
  id: 'card',
  at: [470, FLOOR_Y, 430],
  plane: 'wall',
  children: [
    rect({ id: 'card-face', at: [0, -170], w: 300, h: 340, radius: 26, fill: 'mid.rose', lit: false }),
    circle({ id: 'card-sun', at: [0, -210], r: 70, fill: 'light.cream', lit: false }),
    stroke({ id: 'card-line', points: [[-100, -70], [100, -70]], color: 'light.cream', width: 14 }),
  ],
});
const ramp = region({
  id: 'ramp',
  at: [-640, FLOOR_Y, 330],
  points: [[-110, 0, -90], [110, 0, -90], [110, -150, 90], [-110, -150, 90]],
  smooth: 0,
  fill: 'mid.ocean',
  lit: false,
});

// A far layer of faint dots, flat as every layer without the option is.
const rng = new Rng(SEED, 'far');
const far = Array.from({ length: 30 }, (_, i) => circle({ id: `far${i}`, at: [rng.range(-1500, 1500), rng.range(-800, 100)], r: rng.range(5, 11), fill: 'mid.violet', lit: false, opacity: 0.5 }));

export default shot({
  id: 'space',
  seconds: SECONDS,
  seed: SEED,
  palette,
  strings,
  background: { inner: 'deep.night', outer: 'deep.abyss' },
  atmosphere: 'mid.mist',
  layers: [
    layer({ id: 'far', depth: 1.6, nodes: far }),
    layer({
      id: 'room',
      depth: 0,
      perspective: { aim: [0, 120, 120], distance: 2000, tilt: 14 },
      nodes: [
        floor,
        ramp,
        card,
        circle({ id: 'globe', at: GLOBE, r: 120, fill: 'mid.violet' }),
        circle({ id: 'moon', at: moonAt(0), r: 34, fill: 'light.cream', glow: 0.5 }),
        pin,
        ...cube,
      ],
    }),
  ],
  timeline: [
    drive('moon', { at: 0, dur: SECONDS, by: (t) => ({ at: moonAt(t) }) }),
    ...cubeKeys,
    popIn('pin', { at: 0.6 }),
    // The card falls back on its bottom edge and lies face up.
    turnTo('card', { at: 5.2, to: 90, about: 'x', dur: 1.6, profile: 'ease' }),
    // The camera rises and goes round; then it moves in.
    perspectiveTo('room', { at: 1, dur: 5.5, tilt: 44, turn: 26 }),
    perspectiveTo('room', { at: 8, dur: 3.2, distance: 1250, aim: [150, 120, 80] }),
  ],
});
