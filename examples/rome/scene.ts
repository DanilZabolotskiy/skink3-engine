// Rome shot: 8 seconds over Rome in AD 275, inside the circuit of the Aurelian Walls, as an illustrated map of
// the real ground, seen from the south-east at a slant.
//
// The ground is real: its heights and the Tiber come from the Copernicus DEM GLO-30 and its water body mask, and
// the walls, the outlines of the Colosseum, the Circus Maximus, the Pantheon, the Mausoleum of Hadrian and the
// Forum, and the Roman roads with their bridges come from OpenHistoricalMap (prepare.mjs writes them beside this
// file). The relief is shaded from those heights: the hills rise green outside the walls and fade into the haze,
// and inside them the same light falls over the city's ground, so the seven hills show under the roofs. Thousands
// of houses with red roofs fill the walls, thinning out to gardens on the edges; the Colosseum, the Circus, the
// Pantheon, the Mausoleum and the Forum stand among them in pale stone, and the roads run out through the gates.
// The heights are those of today, smoothed; the houses are laid out for the look.
//
// It shows: relief() from a real elevation model, twice (tinted on the land, as shading alone over the city),
// fog on a plane, bodies with roofs, openings and shadows in a sorted group with a level of detail, bodies on the
// top of a body, a slow push-in of the camera, and a palette of its own.
//
// Map data: heights and the river produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence
// and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. Walls,
// landmarks and roads: OpenHistoricalMap (CC0).

import { readFileSync } from 'node:fs';
import { circle, definePalette, group, hsv, layer, Noise, perspectiveTo, rect, region, relief, Rng, shot, stroke, text, type SceneNode, type StringTables, type Vec2 } from 'skink3-engine';
import { corners, Ground, inside, toLine, type Foot } from '../town/lay.ts';

export const palette = definePalette({
  deep: { sky: hsv(214, 0.6, 0.52), shade: hsv(262, 0.6, 0.26), ink: hsv(232, 0.62, 0.24), river: hsv(204, 0.86, 0.56) },
  dark: { brick: hsv(348, 0.62, 0.42), cypress: hsv(150, 0.66, 0.3), arch: hsv(256, 0.5, 0.34) },
  mid: {
    plain: hsv(88, 0.6, 0.6), hill: hsv(72, 0.62, 0.62), ochre: hsv(44, 0.6, 0.74), slope: hsv(262, 0.48, 0.38),
    ground: hsv(30, 0.44, 0.84), garden: hsv(96, 0.56, 0.6), stone: hsv(30, 0.3, 0.74), water: hsv(196, 0.8, 0.8), sand: hsv(38, 0.46, 0.88),
  },
  accent: { roof: hsv(12, 0.76, 0.84), roof2: hsv(20, 0.8, 0.9), gold: hsv(44, 0.82, 0.96) },
  light: { haze: hsv(32, 0.26, 0.97), sun: hsv(46, 0.4, 1), marble: hsv(40, 0.12, 0.97), road: hsv(38, 0.22, 0.95), cream: hsv(42, 0.16, 0.98) },
  rules: [
    { name: 'no grey in the dark', roles: ['deep', 'dark'], saturation: [0.5, 1] },
    { name: 'light is light', roles: ['light'], lightness: [85, 100] },
  ],
});

const strings: StringTables = { en: { plate: 'Rome · AD 275' } };

const SEED = 275;
const rng = new Rng(SEED, 'rome');
const noise = new Noise(SEED, 'gardens');
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------------------------
// The ground, from prepare.mjs: metres round the centre of the map, x east and y north. A unit of the stage is
// 5 m, its y to the south, so the north lies away from the camera.

type Ring = [number, number][];
interface GroundFile {
  centre: [number, number];
  box: [number, number, number, number];
  cols: number;
  rows: number;
  river: Ring[];
  walls: Ring;
  landmarks: Record<'colosseum' | 'circus' | 'pantheon' | 'hadrian' | 'forum', Ring>;
  roads: { name: string; line: Ring }[];
}
const file = JSON.parse(readFileSync(new URL('./ground.json', import.meta.url), 'utf8')) as GroundFile;
const bin = readFileSync(new URL('./ground.bin', import.meta.url));
/** The heights, in decimetres, row by row from the north-west corner. */
const heights = Int16Array.from({ length: file.cols * file.rows }, (_, i) => bin.readInt16LE(2 * i));
const M = 5;
const stage = (ring: readonly (readonly [number, number])[]): Vec2[] => ring.map(([x, y]) => [x / M, -y / M]);
const W = (file.box[2] - file.box[0]) / M;
const H = (file.box[3] - file.box[1]) / M;

const RIVER = file.river.map(stage);
const WALLS = stage(file.walls);
const ROADS = file.roads.map((r) => ({ main: /^Via |^Alta Semita|^Vicus Longus|^Sacra Via/.test(r.name), bridge: /^Pons /.test(r.name), line: stage(r.line) }));
const mid = (ring: readonly Vec2[]): Vec2 => [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
/** The long axis of an outline: its middle, its length and width along and across it, and its turn in degrees. */
function axis(ring: readonly Vec2[]): { at: Vec2; long: number; wide: number; turn: number } {
  const at = mid(ring);
  let [sxx, syy, sxy] = [0, 0, 0];
  for (const [x, y] of ring) {
    sxx += (x - at[0]) ** 2;
    syy += (y - at[1]) ** 2;
    sxy += (x - at[0]) * (y - at[1]);
  }
  const turn = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const [c, s] = [Math.cos(turn), Math.sin(turn)];
  const along = ring.map(([x, y]) => (x - at[0]) * c + (y - at[1]) * s);
  const across = ring.map(([x, y]) => -(x - at[0]) * s + (y - at[1]) * c);
  return { at, long: Math.max(...along) - Math.min(...along), wide: Math.max(...across) - Math.min(...across), turn: turn / DEG };
}

const wet = (p: Vec2): boolean => RIVER.some((r) => inside(r, p));
const toRiver = (p: Vec2): number => Math.min(...RIVER.map((r) => toLine(r, p, true)));
const inWalls = (p: Vec2): boolean => inside(WALLS, p);

// ---------------------------------------------------------------------------------------------------------------
// The landmarks, at their outlines.

const COLOSSEUM = axis(stage(file.landmarks.colosseum));
const CIRCUS = axis(stage(file.landmarks.circus));
const PANTHEON = axis(stage(file.landmarks.pantheon));
const HADRIAN = axis(stage(file.landmarks.hadrian));
const FORUM = stage(file.landmarks.forum);
const held = new Ground(40);
for (const a of [COLOSSEUM, CIRCUS, PANTHEON, HADRIAN]) held.hold(corners({ at: a.at, w: a.long + 14, d: a.wide + 14, turn: a.turn }));
held.hold(FORUM.map(([x, y]) => [x, y] as Vec2));
held.hold(corners({ at: mid(FORUM), w: 70, d: 50, turn: 0 }));

const ellipse = (rx: number, ry: number, n = 40): Vec2[] => Array.from({ length: n }, (_, i) => [Math.cos((i / n) * 2 * Math.PI) * rx, Math.sin((i / n) * 2 * Math.PI) * ry]);
const marble = { lit: false, fill: 'light.marble', side: 'mid.stone' } as const;
const arches = { shape: 'arch', width: 3, height: 6, step: 5, sill: 2, color: 'dark.arch' } as const;

const landmarks: SceneNode[] = [
  // The Colosseum: its oval body with arches round it, the seats in shade inside, the arena of sand.
  region({
    id: 'colosseum', at: COLOSSEUM.at, rotation: COLOSSEUM.turn, points: ellipse(COLOSSEUM.long / 2, COLOSSEUM.wide / 2), smooth: 0, ...marble, rise: 24,
    openings: { ...arches, rows: 3 },
    children: [
      region({ id: 'colosseum-seats', points: ellipse(COLOSSEUM.long / 2 - 4, COLOSSEUM.wide / 2 - 4), smooth: 0, fill: 'mid.stone', lit: false }),
      region({ id: 'colosseum-arena', points: ellipse(COLOSSEUM.long / 4.4, COLOSSEUM.wide / 4.6), smooth: 0, fill: 'mid.sand', lit: false }),
    ],
  }),
  // The Circus Maximus: its track of sand inside its stands, the barrier down the middle.
  rect({
    id: 'circus', at: CIRCUS.at, rotation: CIRCUS.turn, w: CIRCUS.long, h: CIRCUS.wide, radius: CIRCUS.wide / 2 - 1, ...marble, rise: 7,
    children: [
      rect({ id: 'circus-track', w: CIRCUS.long - 14, h: CIRCUS.wide - 10, radius: (CIRCUS.wide - 10) / 2 - 0.5, fill: 'mid.sand', lit: false }),
      rect({ id: 'circus-spina', w: CIRCUS.long * 0.62, h: 2.4, radius: 1, ...marble, rise: 3 }),
    ],
  }),
  // The Pantheon: its drum under a dome, its porch to the north.
  circle({ id: 'pantheon', at: PANTHEON.at, r: 9, ...marble, rise: 11, roof: { kind: 'dome', height: 8 }, openings: { width: 2, height: 4, step: 6, sill: 4, color: 'dark.arch' } }),
  rect({ id: 'pantheon-porch', at: [PANTHEON.at[0], PANTHEON.at[1] - 11], w: 13, h: 7, radius: 0, ...marble, rise: 9, roof: { kind: 'gable', height: 3 } }),
  // The Mausoleum of Hadrian: a square base, a round drum on it, and a smaller one on top.
  rect({
    id: 'hadrian', at: HADRIAN.at, rotation: HADRIAN.turn, w: 24, h: 24, radius: 0, ...marble, rise: 6,
    children: [circle({ id: 'hadrian-drum', r: 11, ...marble, rise: 9, children: [circle({ id: 'hadrian-top', r: 5, ...marble, rise: 5, roof: { kind: 'cone', height: 4 } })] })],
  }),
  // The Forum: its paving, with temples and halls round it.
  region({ id: 'forum', points: FORUM, smooth: 0, fill: 'light.road', lit: false }),
  ...([[-16, -8, 0, 12, 18], [14, 10, 90, 10, 16], [4, -22, 0, 22, 9], [-6, 22, 0, 26, 9]] as const).map(([dx, dy, turn, w, d], i) => {
    const c = mid(FORUM);
    return rect({ id: `forum-${i}`, at: [c[0] + dx, c[1] + dy], rotation: turn, w, h: d, radius: 0, ...marble, rise: 8, roof: { kind: 'gable', height: 3 }, openings: { width: 1.6, height: 5, step: 3, sill: 1, color: 'dark.arch' } });
  }),
];

// ---------------------------------------------------------------------------------------------------------------
// The houses: on a loose grid inside the walls, clear of the river, the roads and the landmarks; gardens where the
// city thins out on its edges.

const toRoad = (p: Vec2): number => Math.min(...ROADS.filter((r) => !r.bridge).map((r) => toLine(r.line, p) - (r.main ? 4 : 2.5)));
const tone = (f: Foot): 'accent.roof' | 'accent.roof2' => ((Math.floor(f.at[0] * 5.13 + f.at[1] * 8.71) & 7) < 3 ? 'accent.roof2' : 'accent.roof');
const houses: SceneNode[] = [];
const gardens: SceneNode[] = [];
{
  const xs = WALLS.map((p) => p[0]);
  const ys = WALLS.map((p) => p[1]);
  const TURN = 14;
  const [c, s] = [Math.cos(TURN * DEG), Math.sin(TURN * DEG)];
  const centre: Vec2 = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const reach = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2;
  for (let u = -reach; u <= reach; u += 13) {
    for (let v = -reach; v <= reach; v += 13) {
      const at: Vec2 = [centre[0] + u * c - v * s + rng.range(-1.5, 1.5), centre[1] + u * s + v * c + rng.range(-1.5, 1.5)];
      if (!inWalls(at)) continue;
      const f: Foot = { at, w: rng.range(8, 11.5), d: rng.range(8, 11.5), turn: TURN + rng.range(-5, 5) };
      const poly = corners(f);
      if (!poly.every((p) => inWalls(p) && toLine(WALLS, p, true) > 6 && !wet(p) && toRiver(p) > 4 && toRoad(p) > 0) || !held.free(poly)) continue;
      // Gardens on the edges of the city and in patches across it.
      const edge = Math.min(1, toLine(WALLS, at, true) / 90);
      const patch = noise.n2(at[0] / 120, at[1] / 120);
      if (patch > 0.32 - 0.25 * (1 - edge)) {
        if (rng.next() < 0.5) gardens.push(rect({ id: `garden-${gardens.length}`, at, rotation: f.turn + rng.range(-8, 8), w: rng.range(8, 12), h: rng.range(8, 12), radius: 1.5, fill: 'mid.garden', lit: false, opacity: 0.8 }));
        else if (rng.next() < 0.35) houses.push(circle({ id: `cypress-${houses.length}`, at, r: 2.4, lit: false, fill: 'dark.cypress', side: 'dark.cypress', rise: 4, roof: { kind: 'cone', height: 9 } }));
        continue;
      }
      held.hold(corners(f, 0.8));
      houses.push(
        rect({
          id: `house-${houses.length}`, at: f.at, rotation: f.turn, w: f.w, h: f.d, radius: 0, lit: false, fill: tone(f), side: 'light.cream', rise: rng.range(4, 9),
          roof: { kind: rng.next() < 0.6 ? 'hip' : 'gable', height: 0.4 * Math.min(f.w, f.d) },
        }),
      );
    }
  }
}

// Outside the walls: villas and tombs along the roads, pines and cypresses on the hills.
const country: SceneNode[] = [];
for (let tries = 0; country.length < 520 && tries < 20000; tries++) {
  const at: Vec2 = [rng.range(-900, 1000), rng.range(-950, 900)];
  if (inWalls(at) || toLine(WALLS, at, true) < 14 || wet(at) || toRiver(at) < 8) continue;
  const road = toRoad(at);
  const f: Foot = { at, w: rng.range(9, 14), d: rng.range(8, 12), turn: rng.range(-20, 20) };
  if (!held.free(corners(f, 3)) || road < 1) continue;
  if (road < 22 && rng.next() < 0.7) {
    held.hold(corners(f, 3));
    country.push(rect({ id: `villa-${country.length}`, at, rotation: f.turn, w: f.w, h: f.d, radius: 0, lit: false, fill: tone(f), side: 'light.cream', rise: rng.range(4, 7), roof: { kind: 'hip', height: 3.5 } }));
  } else if (noise.n2(at[0] / 160 + 40, at[1] / 160) > 0.05) {
    held.hold(corners({ ...f, w: 8, d: 8 }));
    const pine = rng.next() < 0.5;
    country.push(circle({ id: `tree-${country.length}`, at, r: pine ? 6 : 2.6, lit: false, fill: pine ? 'mid.garden' : 'dark.cypress', side: 'dark.cypress', rise: pine ? 9 : 4, roof: { kind: pine ? 'dome' : 'cone', height: pine ? 4 : 10 } }));
  }
}

// The walls: a brick circuit with towers along it.
function towers(line: readonly Vec2[], step: number): SceneNode[] {
  const out: SceneNode[] = [];
  let carry = step / 2;
  for (let i = 0; i < line.length; i++) {
    const [a, b] = [line[i]!, line[(i + 1) % line.length]!];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const turn = Math.atan2(b[1] - a[1], b[0] - a[0]) / DEG;
    for (; carry < len; carry += step) {
      const t = carry / len;
      out.push(rect({ id: `tower-${out.length}`, at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], rotation: turn, w: 6, h: 6, radius: 0, lit: false, fill: 'dark.brick', side: 'dark.brick', rise: 15 }));
    }
    carry -= len;
  }
  return out;
}

export default shot({
  id: 'rome',
  seconds: 8,
  seed: SEED,
  palette,
  strings,
  background: { inner: 'light.haze', outer: 'deep.sky', center: [0.5, 0.95], radius: 0.95 },
  atmosphere: 'light.haze',
  camera: { drift: { speed: 0, wander: 0 } },
  layers: [
    layer({
      id: 'map',
      depth: 0,
      tint: 0,
      perspective: { aim: [10, 90, 0], distance: 940, tilt: 40, turn: -20, lens: 1150 },
      nodes: [
        group({
          id: 'floor',
          plane: 'floor',
          fog: { color: 'light.haze', near: 700, far: 1900, amount: 1 },
          children: [
            rect({ id: 'land', w: W * 3, h: H * 3, fill: 'mid.plain', lit: false }),
            relief({
              id: 'relief', w: W, h: H, heights: { cols: file.cols, rows: file.rows, values: heights }, vertical: 0.06,
              dark: 'mid.slope', bright: 'light.sun', amount: 0.85,
              tints: [[100, 'mid.plain'], [300, 'mid.plain'], [550, 'mid.hill'], [1000, 'mid.ochre']],
            }),
            region({ id: 'city', points: WALLS, smooth: 0, fill: 'mid.ground', lit: false }),
            relief({ id: 'city-relief', w: W, h: H, heights: { cols: file.cols, rows: file.rows, values: heights }, vertical: 0.09, dark: 'mid.slope', bright: 'light.sun', amount: 0.85, clipTo: 'city' }),
            ...RIVER.map((r, i) => region({ id: `river-${i}`, points: r, smooth: 0, fill: 'deep.river', lit: false })),
            ...RIVER.map((r, i) => stroke({ id: `bank-${i}`, points: r, closed: true, smooth: 0, color: 'mid.water', width: 2.5 })),
            ...ROADS.map((r, i) => stroke({ id: `road-${i}`, points: r.line, smooth: 0, color: 'light.road', width: r.bridge ? 6 : r.main ? 5 : 3 })),
            group({
              id: 'standing',
              sort: 'depth',
              cast: { color: 'deep.shade', opacity: 0.3, length: 0.7, soft: 1.2, over: 'flat' },
              detail: { min: 7 },
              children: [
                ...gardens,
                ...landmarks,
                ...houses,
                ...country,
                stroke({ id: 'walls', points: WALLS, closed: true, smooth: 0, color: 'dark.brick', side: 'dark.brick', width: 4, rise: 11 }),
                ...towers(WALLS, 22),
              ],
            }),
          ],
        }),
      ],
    }),
    layer({
      id: 'frame',
      depth: 0,
      parallax: 0,
      nodes: [text({ id: 'plate', text: 'plate', ink: 'deep.ink', box: 'light.cream', at: [-640, -430], align: 'left', size: 46, weight: 800 })],
    }),
  ],
  timeline: [perspectiveTo('map', { at: 0, distance: 870, dur: 8, profile: 'ease' })],
});
