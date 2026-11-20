// Town shot: 8 seconds of bodies that stand on a tilted plane, with neutral content.
//
// A round walled town grew out from its middle: a square with a tower in it, ring streets round it, and six
// streets that run out from the square to the wall. Its houses stand in rows along the streets, each turned to its
// street; a hall, a market and a block stand between the rings. Outside the wall the roads run on, with farms and
// fields along them, and a stream bends past; carts go along the outer ring. Slate roofs in two close tones over
// pale walls, on olive ground. Every body throws a shadow. The camera comes nearer and turns a little, and the block
// rises out of the ground.
//
// It shows, on shapes with a rise: roof (gable, hip, cone, dome; a hip on a free outline, and contrast) and
// openings; on a wall (a stroke with a rise): openings. On a group: cast (the shadows of its bodies, here over its
// flat members), sort: 'depth' (far to near for the camera of each frame, the wall stretch by stretch) and detail
// (far farms are drawn plain: their tops alone). The rows of houses are laid by lay.ts, so that no two feet
// overlap. Run it from the repository root:
//
//   node bin/skink3.mjs check examples/town/scene.ts
//   node bin/skink3.mjs still examples/town/scene.ts --time 4
//   node bin/skink3.mjs strip examples/town/scene.ts --from 60 --count 6 --step 40

import { circle, definePalette, group, hsv, layer, perspectiveTo, rect, region, riseTo, Rng, shot, stroke, travel, type SceneNode, type Vec2 } from 'skink3-engine';
import { corners, Ground, inside, row, toLine, type Foot, type Street } from './lay.ts';

export const palette = definePalette({
  deep: { shade: hsv(250, 0.6, 0.2), night: hsv(256, 0.62, 0.27) },
  dark: { window: hsv(222, 0.6, 0.34), arch: hsv(248, 0.5, 0.4) },
  mid: { field: hsv(74, 0.58, 0.58), square: hsv(36, 0.3, 0.84), stone: hsv(30, 0.26, 0.76), water: hsv(192, 0.62, 0.78), mist: hsv(60, 0.2, 0.74), rye: hsv(44, 0.56, 0.84), green: hsv(96, 0.54, 0.54) },
  accent: { slate: hsv(214, 0.54, 0.8), slate2: hsv(204, 0.5, 0.84), copper: hsv(170, 0.5, 0.7) },
  light: { plaster: hsv(38, 0.14, 0.97), road: hsv(40, 0.24, 0.92), stone: hsv(34, 0.12, 0.96) },
  rules: [
    { name: 'no grey in the dark', roles: ['deep', 'dark'], saturation: [0.5, 1] },
    { name: 'light is light', roles: ['light'], lightness: [85, 100] },
  ],
});

const SEED = 12;
const rng = new Rng(SEED, 'town');
const DEG = Math.PI / 180;

/** A ring as a closed line of `n` straight stretches, a little out of round. */
const ringOf = (r: number, n: number): Vec2[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    const k = r * (1 + 0.025 * Math.sin(3 * a + 0.6));
    return [Math.cos(a) * k, Math.sin(a) * k];
  });
/** An arc of radius r from one angle to another, in degrees, as n straight stretches. */
const arc = (r: number, from: number, to: number, n: number): Vec2[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = (from + ((to - from) * i) / n) * DEG;
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
const closed = (ring: Vec2[]): Vec2[] => [...ring, ring[0]!];

const WALL = ringOf(600, 30);
const SQUARE = 120;
/** The six streets out from the square, in degrees. */
const SPOKES = [15, 75, 135, 195, 255, 315];
const rings: Street[] = [
  { line: closed(ringOf(SQUARE + 12, 16)), width: 24 },
  { line: closed(ringOf(300, 28)), width: 22 },
  { line: closed(ringOf(470, 36)), width: 20 },
];
const spokes: Street[] = SPOKES.map((d) => ({ line: [[Math.cos(d * DEG) * (SQUARE + 12), Math.sin(d * DEG) * (SQUARE + 12)], [Math.cos(d * DEG) * 595, Math.sin(d * DEG) * 595]] as Vec2[], width: 26 }));
const streets = [...rings, ...spokes];
/** The roads of the country: on from the wall, bending a little as they go. */
const roads: Street[] = SPOKES.map((d, i) => {
  const out = (r: number, bend: number): Vec2 => [Math.cos((d + bend) * DEG) * r, Math.sin((d + bend) * DEG) * r];
  const b = i % 2 === 0 ? 4 : -4;
  return { line: [out(600, 0), out(1200, b), out(2000, -b), out(3000, b)], width: 24 };
});
const STREAM: Vec2[] = [[-2800, -900], [-1800, -880], [-1100, -760], [-760, -420], [-820, 80], [-760, 600], [-1100, 1100], [-1700, 1500], [-2800, 1700]];

// The large buildings, and the ground each keeps: the hall and the block are rectangles; the market is a long
// house bent along the inner ring, between two of the streets out from the square.
const HALL: Vec2 = [Math.cos(45 * DEG) * 212, Math.sin(45 * DEG) * 212];
const BLOCK: Vec2 = [Math.cos(285 * DEG) * 385, Math.sin(285 * DEG) * 385];
const MARKET = { inner: 186, outer: 246, from: 145, to: 185, n: 16 };
const ground = new Ground();
for (const f of [
  { at: [0, 0], w: 2 * SQUARE, d: 2 * SQUARE, turn: 0 },
  { at: HALL, w: 150, d: 130, turn: 45 + 90 },
  { at: BLOCK, w: 140, d: 120, turn: 285 + 90 },
] as Foot[]) {
  ground.hold(corners(f));
}
{
  // The bent house keeps its ground as the convex pieces between its arcs, a little wider than it is.
  const out = arc(MARKET.outer + 6, MARKET.from - 2, MARKET.to + 2, MARKET.n);
  const inn = arc(MARKET.inner - 6, MARKET.from - 2, MARKET.to + 2, MARKET.n);
  for (let i = 0; i < MARKET.n; i++) ground.hold([out[i]!, out[i + 1]!, inn[i + 1]!, inn[i]!]);
}
const clearOf = (list: readonly Street[], f: Foot, margin: number): boolean => corners(f).every((p) => list.every((s) => toLine(s.line, p) >= s.width / 2 + margin));
const tone = (f: Foot): 'accent.slate' | 'accent.slate2' => ((Math.floor(f.at[0] * 5.13 + f.at[1] * 8.71) & 7) < 3 ? 'accent.slate2' : 'accent.slate');

// The houses: along both sides of every street, the rings first, so that each corner goes to its ring.
const townFeet: Foot[] = [];
for (const s of streets) {
  for (const side of [1, -1] as const) {
    townFeet.push(
      ...row(s, side, {
        rng, front: [20, 30], deep: [24, 36], gap: 2.5, back: 3, clear: 1.5, ground,
        ok: (f) => corners(f).every((p) => inside(WALL, p) && toLine(WALL, p, true) > 22 && Math.hypot(p[0], p[1]) > SQUARE + 6) && clearOf(streets.filter((o) => o !== s), f, 3),
      }),
    );
  }
}
const windows = { width: 4, height: 6, step: 11, sill: 7, color: 'dark.window' } as const;
const houses: SceneNode[] = townFeet.map((f, i) =>
  rect({
    id: `house-${i}`, at: f.at, rotation: f.turn, w: f.w, h: f.d, radius: 0, lit: false, fill: tone(f), side: 'light.plaster', rise: rng.range(16, 28),
    roof: { kind: rng.next() < 0.6 ? 'gable' : 'hip', height: 0.5 * Math.min(f.w, f.d) }, openings: windows,
  }),
);

// The farms along the roads, a field behind each.
const farFeet: Foot[] = [];
const fields: SceneNode[] = [];
for (const r of roads) {
  for (const side of [1, -1] as const) {
    const laid = row(r, side, {
      rng, front: [28, 40], deep: [20, 28], gap: 110, back: 10, clear: 2, ground, from: 80,
      ok: (f) => corners(f).every((p) => Math.hypot(p[0], p[1]) > 680 && toLine(STREAM, p) > 60),
    });
    for (const f of laid) {
      const t = f.turn * DEG;
      const field = { at: [f.at[0] - Math.sin(t) * side * (f.d / 2 + 80), f.at[1] + Math.cos(t) * side * (f.d / 2 + 80)] as Vec2, w: 130, d: 130, turn: f.turn };
      const poly = corners(field);
      if (poly.every((p) => Math.hypot(p[0], p[1]) > 660 && toLine(STREAM, p) > 50) && clearOf(roads, field, 6) && ground.free(poly)) {
        ground.hold(poly);
        fields.push(rect({ id: `field-${fields.length}`, at: field.at, rotation: f.turn, w: field.w, h: field.d, radius: 4, fill: fields.length % 3 === 1 ? 'mid.rye' : 'mid.green', lit: false }));
      }
    }
    farFeet.push(...laid);
  }
}
// The farms are far: their roofs keep closer tones (contrast under 1), as the haze draws light and shade together.
const farms: SceneNode[] = farFeet.map((f, i) =>
  rect({
    id: `farm-${i}`, at: f.at, rotation: f.turn, w: f.w, h: f.d, radius: 0, lit: false, fill: tone(f), side: 'light.plaster', rise: rng.range(10, 15),
    roof: { kind: rng.next() < 0.5 ? 'gable' : 'hip', height: 0.45 * Math.min(f.w, f.d), contrast: 0.6 },
  }),
);

const large: SceneNode[] = [
  // The tower in the middle of the square: round, with a cone and four rows of windows.
  circle({ id: 'tower', at: [0, 0], r: 46, lit: false, fill: 'accent.slate', side: 'light.stone', rise: 210, roof: { kind: 'cone', height: 150 }, openings: { width: 8, height: 16, step: 24, rows: 4, color: 'dark.arch' } }),
  // The hall: a hipped roof, a row of arched windows, and on it a drum with a dome.
  rect({
    id: 'hall', at: HALL, rotation: 45 + 90, w: 130, h: 100, radius: 0, lit: false, fill: 'accent.slate2', side: 'light.stone', rise: 64,
    roof: { kind: 'hip', height: 34 }, openings: { shape: 'arch', width: 12, height: 32, step: 26, sill: 8, color: 'dark.arch' },
    children: [circle({ id: 'drum', r: 32, lit: false, fill: 'accent.copper', side: 'light.stone', rise: 40, roof: { kind: 'dome', height: 36 }, openings: { width: 7, height: 18, step: 18, color: 'dark.arch' } })],
  }),
  // The market: a region, bent along the ring. A hip on a free outline has a slope on every stretch of it, and
  // its ridge follows the bend; an arcade of arches stands on the ground all round it.
  region({
    id: 'market', points: [...arc(MARKET.outer, MARKET.from, MARKET.to, MARKET.n), ...arc(MARKET.inner, MARKET.to, MARKET.from, MARKET.n)], smooth: 0,
    lit: false, fill: 'accent.slate', side: 'light.stone', rise: 48,
    roof: { kind: 'hip', height: 26 }, openings: { shape: 'arch', width: 12, height: 30, step: 24, sill: 0, color: 'dark.arch' },
  }),
  // A block with a flat top and rows of windows; it rises out of the ground.
  rect({ id: 'block', at: BLOCK, rotation: 285 + 90, w: 110, h: 84, radius: 6, fill: 'light.stone', side: 'mid.stone', rise: 0, openings: { width: 10, height: 14, step: 20, rows: 5, color: 'dark.window' } }),
];

// Carts on the outer ring street, one in each quarter of the town, each a little way along it.
const carts = [[30, 4], [145, 4], [215, -4], [330, -4]].map(([start, step], i) => ({
  id: `cart-${i}`,
  path: Array.from({ length: 7 }, (_, k) => {
    const a = (start! + step! * k) * DEG;
    const r = 470 * (1 + 0.025 * Math.sin(3 * a + 0.6));
    return [Math.cos(a) * r, Math.sin(a) * r] as Vec2;
  }),
}));

// The wall, with a row of slits high up on both its faces.
const wall = stroke({ id: 'wall', points: WALL, closed: true, color: 'light.stone', side: 'mid.stone', width: 14, rise: 44, openings: { width: 5, height: 11, step: 40, sill: 24, color: 'dark.arch' } });

export default shot({
  id: 'town',
  seconds: 8,
  seed: SEED,
  palette,
  strings: { en: {} },
  background: { inner: 'deep.night', outer: 'deep.shade' },
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
            rect({ id: 'ground', w: 6000, h: 6000, radius: 120, fill: 'mid.field', lit: false }),
            stroke({ id: 'stream', points: STREAM, color: 'mid.water', width: 46 }),
            ...roads.map((r, i) => stroke({ id: `road-${i}`, points: r.line, color: 'light.road', width: r.width })),
            ...streets.map((s, i) => stroke({ id: `street-${i}`, points: s.line, color: 'light.road', width: s.width })),
            // What stands, with the square and the fields it stands on: the flat members are drawn first, the
            // shadows over them (over: 'flat'), and the bodies far to near, plain where they are small on screen.
            group({
              id: 'standing',
              sort: 'depth',
              cast: { color: 'deep.shade', opacity: 0.35, length: 0.8, soft: 1.5, over: 'flat' },
              detail: { min: 11 },
              children: [
                circle({ id: 'square', r: SQUARE, fill: 'mid.square', lit: false }),
                ...fields,
                ...farms,
                ...houses,
                ...large,
                wall,
                ...carts.map((c) => rect({ id: c.id, at: c.path[0]!, w: 16, h: 9, radius: 1, lit: false, fill: 'mid.rye', side: 'mid.stone', rise: 7 })),
              ],
            }),
          ],
        }),
      ],
    }),
  ],
  timeline: [
    perspectiveTo('stage', { at: 0.4, turn: -6, tilt: 50, distance: 1800, dur: 7 }),
    riseTo('block', { at: 1.2, to: 150, dur: 2.4 }),
    ...carts.map((c) => travel(c.id, { at: 0, path: c.path, dur: 8, profile: 'steady', orient: true })),
  ],
});
