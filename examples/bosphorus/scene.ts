// Bosphorus shot: 8 seconds over the strait between the Sea of Marmara and the Black Sea, as an illustrated map
// of the real ground, seen from over the Marmara looking north up the strait.
//
// The ground is real: its heights and its water come from the Copernicus DEM GLO-30 and its water body mask
// (prepare.mjs writes them beside this file from the open tiles of the DEM). The relief is shaded from those
// heights and tinted by them, from the green shores to the ochre hills; the sea is drawn over it, with its
// shallows along the coast, and the far land fades into the haze. On the tip of the old peninsula the walled
// city is a fabric of roofs between its land walls and its sea walls, dense in the east and thinning out to
// gardens toward the land walls; Galata faces it across the Golden Horn, with its tower; the two castles stand
// at the narrows; villages lie along the shores and woods on the northern hills. Ships sail up and down the
// strait under lateen sails. The places of the walls, the streets, the castles, the villages and the ships are
// given by longitude and latitude, approximate, and drawn for the look.
//
// It shows: relief() from a real elevation model, fog on a plane, a clip to a coast of more than a thousand
// points with a soft group inside it (the shallows), bodies with roofs and shadows in a sorted group with a level
// of detail, shapes that stand up from the plane (the sails), a slow push-in of the camera, and a palette of
// its own.
//
// Map data: produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH
// 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.

import { readFileSync } from 'node:fs';
import { circle, definePalette, group, hsv, layer, Noise, perspectiveTo, polygon, rect, region, relief, Rng, shot, stroke, text, travel, type SceneNode, type StringTables, type Vec2 } from 'skink3-engine';
import { corners, Ground, inside, row, toLine, type Foot, type Street } from '../town/lay.ts';

export const palette = definePalette({
  deep: { sky: hsv(218, 0.66, 0.5), sea: hsv(210, 0.92, 0.5), shade: hsv(248, 0.62, 0.26), ink: hsv(232, 0.62, 0.24) },
  dark: { wood: hsv(16, 0.66, 0.4), forest: hsv(140, 0.66, 0.36), pine: hsv(158, 0.62, 0.3) },
  mid: {
    shallow: hsv(196, 0.84, 0.74), ripple: hsv(194, 0.62, 0.86), shore: hsv(96, 0.62, 0.56), hill: hsv(74, 0.6, 0.6),
    ochre: hsv(42, 0.62, 0.72), rock: hsv(26, 0.46, 0.78), slope: hsv(252, 0.5, 0.36), town: hsv(36, 0.36, 0.82),
    garden: hsv(86, 0.56, 0.62), stone: hsv(32, 0.3, 0.72),
  },
  accent: { roof: hsv(10, 0.74, 0.8), roof2: hsv(20, 0.78, 0.86), lead: hsv(204, 0.42, 0.78), gold: hsv(44, 0.82, 0.96) },
  light: { haze: hsv(30, 0.3, 0.97), sun: hsv(46, 0.4, 1), foam: hsv(186, 0.16, 0.99), cream: hsv(42, 0.16, 0.98), stone: hsv(38, 0.18, 0.94) },
  rules: [
    { name: 'no grey in the dark', roles: ['deep', 'dark'], saturation: [0.5, 1] },
    { name: 'light is light', roles: ['light'], lightness: [85, 100] },
  ],
});

const strings: StringTables = { en: { plate: 'Bosphorus · 1452' } };

const SEED = 1452;
const rng = new Rng(SEED, 'bosphorus');
const noise = new Noise(SEED, 'woods');
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------------------------
// The ground, from prepare.mjs: metres round the centre of the map, x east and y north. A unit of the stage is
// 10 m, its y to the south, so the north lies away from the camera.

interface GroundFile {
  centre: [number, number];
  box: [number, number, number, number];
  cell: number;
  cols: number;
  rows: number;
  sea: [number, number][][];
}
const file = JSON.parse(readFileSync(new URL('./ground.json', import.meta.url), 'utf8')) as GroundFile;
const bin = readFileSync(new URL('./ground.bin', import.meta.url));
/** The heights, in decimetres, row by row from the north-west corner. */
const heights = Int16Array.from({ length: file.cols * file.rows }, (_, i) => bin.readInt16LE(2 * i));
const M = 10;
const stage = ([x, y]: readonly [number, number]): Vec2 => [x / M, -y / M];
const W = (file.box[2] - file.box[0]) / M;
const H = (file.box[3] - file.box[1]) / M;

/** A place of the map given by longitude and latitude, on the stage (the projection of prepare.mjs). */
function geo(lon: number, lat: number): Vec2 {
  const R = 6371008.8;
  const [l0, p0] = [file.centre[0] * DEG, file.centre[1] * DEG];
  const [dl, p] = [lon * DEG - l0, lat * DEG];
  const k = Math.sqrt(2 / (1 + Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(dl)));
  return stage([R * k * Math.cos(p) * Math.sin(dl), R * k * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(dl))]);
}
const geoLine = (pts: readonly [number, number][]): Vec2[] => pts.map(([lon, lat]) => geo(lon, lat));

/** The height of the ground at a place of the stage, in metres. */
function heightAt([x, y]: Vec2): number {
  const c = Math.round(((x + W / 2) / W) * (file.cols - 1));
  const r = Math.round(((y + H / 2) / H) * (file.rows - 1));
  if (c < 0 || r < 0 || c >= file.cols || r >= file.rows) return 0;
  return heights[r * file.cols + c]! / 10;
}

const SEA = file.sea[0]!.map(stage);
const wet = (p: Vec2): boolean => inside(SEA, p);
const toCoast = (p: Vec2): number => toLine(SEA, p, true);

// ---------------------------------------------------------------------------------------------------------------
// The old city: its land walls from the Golden Horn to the Marmara, and the coast of the peninsula round from the
// one end to the other.

const LAND_WALLS = geoLine([
  [28.9436, 41.0418], [28.9398, 41.0372], [28.9402, 41.0334], [28.9334, 41.0287], [28.927, 41.0248], [28.9219, 41.0208],
  [28.9178, 41.0152], [28.9168, 41.0072], [28.9195, 41.0003], [28.9226, 40.9946], [28.9216, 40.9918],
]);

/** The stretch of the coast between the places nearest two points, the shorter way round. */
function coastBetween(a: Vec2, b: Vec2): Vec2[] {
  const nearest = (p: Vec2): number => SEA.reduce((best, q, i) => (Math.hypot(q[0] - p[0], q[1] - p[1]) < Math.hypot(SEA[best]![0] - p[0], SEA[best]![1] - p[1]) ? i : best), 0);
  const [i, j] = [nearest(a), nearest(b)];
  const n = SEA.length;
  const forward = Array.from({ length: ((j - i + n) % n) + 1 }, (_, k) => SEA[(i + k) % n]!);
  const back = Array.from({ length: ((i - j + n) % n) + 1 }, (_, k) => SEA[(i - k + n) % n]!);
  const length = (line: Vec2[]): number => line.reduce((s, p, k) => (k === 0 ? 0 : s + Math.hypot(p[0] - line[k - 1]![0], p[1] - line[k - 1]![1])), 0);
  return length(forward) < length(back) ? forward : back;
}
const SEA_WALLS = coastBetween(LAND_WALLS[LAND_WALLS.length - 1]!, LAND_WALLS[0]!);
const CITY = [...LAND_WALLS, ...SEA_WALLS.slice(1, -1)];

const MILION = geo(28.9767, 41.0083);
const STREETS: Street[] = [
  { line: geoLine([[28.9767, 41.0083], [28.9714, 41.0086], [28.964, 41.0105], [28.957, 41.013]]), width: 9 },
  { line: geoLine([[28.957, 41.013], [28.9497, 41.0195], [28.9334, 41.0287]]), width: 8 },
  { line: geoLine([[28.957, 41.013], [28.951, 41.008], [28.9395, 41.0035], [28.9226, 40.9946]]), width: 8 },
  { line: geoLine([[28.9497, 41.0195], [28.9219, 41.0208]]), width: 6 },
  { line: geoLine([[28.9168, 41.0072], [28.9395, 41.0035]]), width: 6 },
  { line: geoLine([[28.946, 41.0345], [28.958, 41.0265], [28.97, 41.0185]]), width: 6 },
  { line: geoLine([[28.93, 40.9975], [28.95, 41.0005], [28.972, 41.0035]]), width: 6 },
  { line: geoLine([[28.9497, 41.0195], [28.946, 41.0345]]), width: 6 },
  { line: geoLine([[28.964, 41.0105], [28.97, 41.0185]]), width: 6 },
  { line: geoLine([[28.951, 41.008], [28.95, 41.0005]]), width: 6 },
];

const HAGIA = geo(28.9802, 41.0086);
const HIPPODROME: [Vec2, Vec2] = [geo(28.9762, 41.0068), geo(28.9733, 41.0038)];
const held = new Ground(40);
const hippoAt: Vec2 = [(HIPPODROME[0][0] + HIPPODROME[1][0]) / 2, (HIPPODROME[0][1] + HIPPODROME[1][1]) / 2];
const hippoTurn = Math.atan2(HIPPODROME[0][1] - HIPPODROME[1][1], HIPPODROME[0][0] - HIPPODROME[1][0]) / DEG;
const hippoLength = Math.hypot(HIPPODROME[0][0] - HIPPODROME[1][0], HIPPODROME[0][1] - HIPPODROME[1][1]) + 24;
for (const f of [
  { at: HAGIA, w: 52, d: 46, turn: 0 },
  { at: hippoAt, w: hippoLength + 10, d: 30, turn: hippoTurn },
] as Foot[]) {
  held.hold(corners(f));
}

/** How built up the city is at a place: dense round the Milion, thinning out to gardens by the land walls. */
const density = (p: Vec2): number => Math.max(0.28, Math.min(0.98, 1.08 - Math.hypot(p[0] - MILION[0], p[1] - MILION[1]) / 520));
const inCity = (p: Vec2, margin: number): boolean => inside(CITY, p) && toLine(CITY, p, true) > margin;
const tone = (f: Foot): 'accent.roof' | 'accent.roof2' => ((Math.floor(f.at[0] * 5.13 + f.at[1] * 8.71) & 7) < 3 ? 'accent.roof2' : 'accent.roof');

const cityFeet: Foot[] = [];
for (const s of STREETS) {
  for (const side of [1, -1] as const) {
    cityFeet.push(
      ...row(s, side, {
        rng, front: [11, 16], deep: [11, 16], gap: 2, back: 2, clear: 1, ground: held,
        ok: (f) => corners(f).every((p) => inCity(p, 7)) && rng.next() < density(f.at) + 0.1,
      }),
    );
  }
}
// The blocks between the streets: houses on a loose grid turned with the peninsula, gardens where there are none.
const gardens: SceneNode[] = [];
const GRID_TURN = -28;
{
  const [c, s] = [Math.cos(GRID_TURN * DEG), Math.sin(GRID_TURN * DEG)];
  const xs = CITY.map((p) => p[0]);
  const ys = CITY.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const centre: Vec2 = [(x0 + x1) / 2, (y0 + y1) / 2];
  const reach = Math.hypot(x1 - x0, y1 - y0) / 2;
  for (let u = -reach; u <= reach; u += 17) {
    for (let v = -reach; v <= reach; v += 17) {
      const at: Vec2 = [centre[0] + u * c - v * s + rng.range(-2, 2), centre[1] + u * s + v * c + rng.range(-2, 2)];
      const f: Foot = { at, w: rng.range(11, 15), d: rng.range(11, 15), turn: GRID_TURN + rng.range(-4, 4) };
      const poly = corners(f);
      if (!poly.every((p) => inCity(p, 7)) || !held.free(poly)) continue;
      if (rng.next() < density(at)) {
        held.hold(corners(f, 1));
        cityFeet.push(f);
      } else if (rng.next() < 0.5) {
        const g = corners({ ...f, w: 16, d: 16 });
        if (held.free(g)) {
          held.hold(g);
          gardens.push(rect({ id: `garden-${gardens.length}`, at, rotation: f.turn, w: 16, h: 16, radius: 2, fill: 'mid.garden', lit: false }));
        }
      }
    }
  }
}

/** A village: houses scattered round a place on the land, clear of the water. */
function village(at: Vec2, count: number, reach: number): Foot[] {
  const feet: Foot[] = [];
  for (let tries = 0; feet.length < count && tries < count * 30; tries++) {
    const a = rng.range(0, 2 * Math.PI);
    const r = reach * Math.sqrt(rng.next());
    const f: Foot = { at: [at[0] + Math.cos(a) * r, at[1] + Math.sin(a) * r], w: rng.range(9, 13), d: rng.range(9, 13), turn: rng.range(-30, 30) };
    const poly = corners(f);
    if (poly.some((p) => wet(p) || toCoast(p) < 5) || !held.free(poly)) continue;
    held.hold(corners(f, 2));
    feet.push(f);
  }
  return feet;
}

// Galata across the Horn, walled, with its tower; the villages along the shores.
const GALATA = geoLine([[28.9688, 41.0222], [28.9731, 41.0289], [28.9776, 41.0283], [28.9842, 41.0247], [28.9805, 41.0219]]);
const GALATA_TOWER = geo(28.9741, 41.0256);
held.hold(corners({ at: GALATA_TOWER, w: 24, d: 24, turn: 0 }));
const galataFeet: Foot[] = [];
{
  for (let u = -60; u <= 60; u += 15) {
    for (let v = -40; v <= 40; v += 15) {
      const at: Vec2 = [GALATA_TOWER[0] + u + 20 + rng.range(-2, 2), GALATA_TOWER[1] + v + 10 + rng.range(-2, 2)];
      const f: Foot = { at, w: rng.range(10, 13), d: rng.range(10, 13), turn: -32 + rng.range(-4, 4) };
      const poly = corners(f);
      if (poly.every((p) => inside(GALATA, p) && toLine(GALATA, p, true) > 4 && !wet(p)) && held.free(poly)) {
        held.hold(corners(f, 1));
        galataFeet.push(f);
      }
    }
  }
}
const VILLAGES: { at: Vec2; count: number; reach: number }[] = [
  { at: geo(29.016, 41.0255), count: 36, reach: 70 },
  { at: geo(29.0285, 40.9905), count: 34, reach: 70 },
  { at: geo(29.005, 41.0425), count: 14, reach: 40 },
  { at: geo(29.0425, 41.0675), count: 12, reach: 36 },
  { at: geo(29.0615, 41.0745), count: 10, reach: 32 },
  { at: geo(29.0985, 41.1345), count: 16, reach: 44 },
  { at: geo(29.0535, 41.1675), count: 14, reach: 40 },
  { at: geo(29.0585, 41.1395), count: 10, reach: 32 },
];
const villageFeet = VILLAGES.flatMap((v) => village(v.at, v.count, v.reach));

// The two castles at the narrows.
const RUMELI = geo(29.0562, 41.0848);
const ANADOLU = geo(29.0668, 41.0823);
for (const at of [RUMELI, ANADOLU]) held.hold(corners({ at, w: 60, d: 60, turn: 0 }));

// The roads out of the city by land, west from the Golden Gate and on along the Asian shore, with fields and farms
// along them.
const ROADS: Street[] = [
  { line: geoLine([[28.9226, 40.9946], [28.895, 40.9915], [28.86, 40.9905], [28.82, 40.9935], [28.78, 40.9985], [28.72, 41.004]]), width: 6 },
  { line: geoLine([[28.9178, 41.0152], [28.89, 41.025], [28.85, 41.04], [28.8, 41.055]]), width: 5 },
  { line: geoLine([[29.0285, 40.9905], [29.06, 40.996], [29.1, 40.99], [29.15, 40.97], [29.2, 40.945]]), width: 5 },
];
const fields: SceneNode[] = [];
const farmFeet: Foot[] = [];
for (const r of ROADS) {
  for (const side of [1, -1] as const) {
    const laid = row(r, side, {
      rng, front: [12, 15], deep: [10, 13], gap: 95, back: 4, clear: 2, ground: held, from: 60,
      ok: (f) => corners(f).every((p) => !wet(p) && toCoast(p) > 14 && !inside(CITY, p)),
    });
    for (const f of laid) {
      const t = f.turn * DEG;
      const off = rng.range(24, 60);
      const field: Foot = { at: [f.at[0] - Math.sin(t) * side * (f.d / 2 + off), f.at[1] + Math.cos(t) * side * (f.d / 2 + off)], w: rng.range(30, 48), d: rng.range(26, 40), turn: f.turn + rng.range(-14, 14) };
      const poly = corners(field);
      if (poly.every((p) => !wet(p) && toCoast(p) > 10 && !inside(CITY, p)) && held.free(poly)) {
        held.hold(poly);
        fields.push(rect({ id: `field-${fields.length}`, at: field.at, rotation: field.turn, w: field.w, h: field.d, radius: 3, fill: fields.length % 3 === 1 ? 'mid.ochre' : 'mid.garden', lit: false, opacity: 0.8 }));
      }
    }
    farmFeet.push(...laid);
  }
}

// Woods on the northern hills, where the ground is high, away from the shores and the villages.
const trees: SceneNode[] = [];
for (let y = -H / 2 + 30; y < -260; y += 26) {
  for (let x = -W / 2 + 30; x < W / 2 - 30; x += 26) {
    const at: Vec2 = [x + rng.range(-9, 9), y + rng.range(-9, 9)];
    const n = noise.n2(at[0] / 260, at[1] / 260) + 0.4 * noise.n2(at[0] / 70, at[1] / 70);
    if (n < 0.18 || heightAt(at) < 45 || wet(at) || toCoast(at) < 30) continue;
    const poly = corners({ at, w: 16, d: 16, turn: 0 });
    if (!held.free(poly)) continue;
    const r = rng.range(7, 10);
    trees.push(circle({ id: `tree-${trees.length}`, at, r, lit: false, fill: rng.next() < 0.5 ? 'dark.forest' : 'dark.pine', side: 'dark.pine', rise: rng.range(5, 9), roof: { kind: 'dome', height: r * 0.9, contrast: 0.8 } }));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// What stands.

const house = (f: Foot, i: number, prefix: string, rise: [number, number]): SceneNode =>
  rect({
    id: `${prefix}-${i}`, at: f.at, rotation: f.turn, w: f.w, h: f.d, radius: 0, lit: false, fill: tone(f), side: 'light.stone', rise: rng.range(rise[0], rise[1]),
    roof: { kind: rng.next() < 0.55 ? 'hip' : 'gable', height: 0.45 * Math.min(f.w, f.d) },
  });

/** Towers along a wall, every `step` units. */
function towers(id: string, line: readonly Vec2[], step: number, size: number, rise: number): SceneNode[] {
  const out: SceneNode[] = [];
  let carry = step / 2;
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1]!, line[i]!];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const turn = Math.atan2(b[1] - a[1], b[0] - a[0]) / DEG;
    for (; carry < len; carry += step) {
      const t = carry / len;
      out.push(rect({ id: `${id}-${out.length}`, at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], rotation: turn, w: size, h: size, radius: 0, lit: false, fill: 'light.stone', side: 'mid.stone', rise }));
    }
    carry -= len;
  }
  return out;
}

/** A castle: round towers with cones, joined by a wall. */
function castle(id: string, at: Vec2, ring: Vec2[], big: number[]): SceneNode[] {
  const pts = ring.map(([x, y]) => [at[0] + x, at[1] + y] as Vec2);
  return [
    stroke({ id: `${id}-wall`, points: pts, closed: true, smooth: 0, color: 'light.stone', side: 'mid.stone', width: 5, rise: 16 }),
    ...pts.map((p, i) =>
      circle({ id: `${id}-tower-${i}`, at: p, r: big.includes(i) ? 9 : 5, lit: false, fill: 'light.stone', side: 'mid.stone', rise: big.includes(i) ? 44 : 22, roof: { kind: 'cone', height: big.includes(i) ? 22 : 10 } }),
    ),
  ];
}

const standing: SceneNode[] = [
  ...gardens,
  ...fields,
  ...farmFeet.map((f, i) => house(f, i, 'farm', [5, 8])),
  region({ id: 'hippodrome', at: hippoAt, rotation: hippoTurn, points: [[-hippoLength / 2, -11], [hippoLength / 2 - 8, -11], [hippoLength / 2, 0], [hippoLength / 2 - 8, 11], [-hippoLength / 2, 11]], smooth: 0, fill: 'light.cream', side: 'mid.stone', lit: false, rise: 5 }),
  rect({
    id: 'hagia', at: HAGIA, w: 44, h: 38, radius: 0, lit: false, fill: 'accent.lead', side: 'light.stone', rise: 16, roof: { kind: 'hip', height: 10 },
    children: [circle({ id: 'hagia-dome', r: 15, lit: false, fill: 'accent.lead', side: 'light.stone', rise: 12, roof: { kind: 'dome', height: 15 } })],
  }),
  ...cityFeet.map((f, i) => house(f, i, 'house', [7, 12])),
  ...galataFeet.map((f, i) => house(f, i, 'galata', [7, 11])),
  ...villageFeet.map((f, i) => house(f, i, 'village', [5, 9])),
  stroke({ id: 'land-walls', points: LAND_WALLS, smooth: 0, color: 'light.stone', side: 'mid.stone', width: 7, rise: 16 }),
  ...towers('land-tower', LAND_WALLS, 26, 10, 24),
  stroke({ id: 'sea-walls', points: SEA_WALLS, smooth: 0, color: 'light.stone', side: 'mid.stone', width: 4, rise: 9 }),
  stroke({ id: 'galata-walls', points: GALATA, closed: true, smooth: 0, color: 'light.stone', side: 'mid.stone', width: 4, rise: 10 }),
  circle({ id: 'galata-tower', at: GALATA_TOWER, r: 8, lit: false, fill: 'light.stone', side: 'mid.stone', rise: 62, roof: { kind: 'cone', height: 26 } }),
  ...castle('rumeli', RUMELI, [[-26, 18], [-12, -24], [20, -16], [24, 20]], [0, 1, 2]),
  ...castle('anadolu', ANADOLU, [[-14, -12], [12, -12], [12, 12], [-14, 12]], [0]),
  ...trees,
];

// Ships: a hull, a mast, and a lateen sail that stands up from the water, with the wake they leave; each runs on
// along its way through the shot.
const SHIPS: { from: [number, number]; to: [number, number]; size: number; sail: number }[] = [
  { from: [28.9925, 41.0205], to: [29.0055, 41.0335], size: 1.84, sail: 40 },
  { from: [29.0395, 41.0725], to: [29.0335, 41.0615], size: 1.6, sail: 40 },
  { from: [29.0612, 41.1095], to: [29.0688, 41.1225], size: 1.6, sail: 40 },
  { from: [29.0905, 41.1735], to: [29.0835, 41.1615], size: 1.52, sail: 40 },
  { from: [28.9985, 40.9905], to: [28.9805, 40.9925], size: 2.0, sail: 40 },
  { from: [28.9605, 40.9845], to: [28.9785, 40.9815], size: 1.76, sail: 40 },
  { from: [29.0145, 41.0025], to: [29.0205, 41.0145], size: 1.6, sail: 40 },
];
const ships = SHIPS.map((s, i) => {
  const [from, to] = [geo(...s.from), geo(...s.to)];
  const k = s.size;
  return {
    id: `ship-${i}`,
    path: [from, to] as Vec2[],
    node: group({
      id: `ship-${i}`,
      at: from,
      rotation: Math.atan2(to[1] - from[1], to[0] - from[0]) / DEG,
      children: [
        stroke({ id: `ship-${i}-wake`, points: [[-22 * k, 0], [-40 * k, 1 * k], [-60 * k, 0]], color: 'light.foam', width: 4 * k, opacity: 0.5 }),
        polygon({ id: `ship-${i}-hull`, points: [[-22 * k, -5 * k], [12 * k, -5 * k], [24 * k, 0], [12 * k, 5 * k], [-22 * k, 5 * k]], lit: false, fill: 'mid.stone', side: 'dark.wood', rise: 5 * k }),
        circle({ id: `ship-${i}-mast`, r: 1.6 * k, lit: false, fill: 'dark.wood', side: 'dark.wood', rise: 46 * k }),
        polygon({ id: `ship-${i}-sail`, rotation: s.sail, points: [[-24 * k, -8 * k], [22 * k, -14 * k], [-4 * k, -58 * k]], fill: 'light.cream', lit: false, stands: true }),
      ],
    }),
  };
});

// Ripples on the open water, away from the shores.
const ripples: SceneNode[] = [];
for (let tries = 0; ripples.length < 170 && tries < 6000; tries++) {
  const at: Vec2 = [rng.range(-1500, 1500), rng.range(-1600, 1800)];
  if (!wet(at) || toCoast(at) < 22) continue;
  const w = rng.range(7, 12);
  ripples.push(stroke({ id: `ripple-${ripples.length}`, points: [[at[0] - w, at[1]], [at[0], at[1] - w * 0.35], [at[0] + w, at[1]]], color: 'mid.ripple', width: 2.2 }));
}

export default shot({
  id: 'bosphorus',
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
      perspective: { aim: [-420, 560, 0], distance: 2700, tilt: 36, turn: 12, lens: 1150 },
      nodes: [
        group({
          id: 'floor',
          plane: 'floor',
          fog: { color: 'light.haze', near: 2200, far: 5200, amount: 1 },
          children: [
            rect({ id: 'land', w: W * 3, h: H * 3, fill: 'mid.hill', lit: false }),
            // The Black Sea runs on beyond the north edge of the map, into the haze.
            rect({ id: 'open-sea', at: [0, -H / 2 - H], w: W * 3, h: H * 2, fill: 'deep.sea', lit: false }),
            relief({
              id: 'relief', w: W, h: H, heights: { cols: file.cols, rows: file.rows, values: heights }, vertical: 0.03,
              dark: 'mid.slope', bright: 'light.sun', amount: 0.8,
              tints: [[0, 'mid.shore'], [600, 'mid.shore'], [1400, 'mid.hill'], [2600, 'mid.ochre'], [4200, 'mid.rock']],
            }),
            // The trodden ground of the villages, under the sea where it reaches the shore.
            ...VILLAGES.map((v, i) => circle({ id: `hamlet-${i}`, at: v.at, r: v.reach * 0.85, fill: 'mid.town', lit: false, soft: 26, opacity: 0.55 })),
            region({ id: 'sea', points: SEA, smooth: 0, fill: 'deep.sea', lit: false }),
            group({ id: 'shallows', clipTo: 'sea', soft: 14, children: [stroke({ id: 'shallow', points: SEA, closed: true, smooth: 0, color: 'mid.shallow', width: 34 })] }),
            stroke({ id: 'coast', points: SEA, closed: true, smooth: 0, color: 'light.foam', width: 2.4 }),
            ...ripples,
            region({ id: 'city', points: CITY, smooth: 0, fill: 'mid.town', lit: false }),
            region({ id: 'galata', points: GALATA, smooth: 0, fill: 'mid.town', lit: false }),
            ...STREETS.map((s, i) => stroke({ id: `street-${i}`, points: s.line, color: 'light.cream', width: s.width })),
            ...ROADS.map((s, i) => stroke({ id: `road-${i}`, points: s.line, color: 'light.cream', width: s.width, opacity: 0.85 })),
            group({
              id: 'standing',
              sort: 'depth',
              cast: { color: 'deep.shade', opacity: 0.32, length: 0.7, soft: 1.5, over: 'flat' },
              detail: { min: 9 },
              children: [...standing, ...ships.map((s) => s.node)],
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
  timeline: [
    perspectiveTo('map', { at: 0, distance: 2500, dur: 8, profile: 'ease' }),
    ...ships.map((s) => travel(s.id, { at: 0, path: s.path, dur: 8, profile: 'steady', orient: true })),
  ],
});
