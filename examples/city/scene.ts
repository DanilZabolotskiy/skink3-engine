// City shot: 8 seconds of a made-up city on a map, with neutral content.
//
// A city on a river, its hills behind it, seen from above at a tilt. Its fabric is its blocks as they are, irregular,
// in three close tones of roof, with the lanes between them, its squares, its main streets over them and the site of
// its domed hall kept clear; a shadow and a lit rim lift each block from the ground. A water channel runs down from
// the hills into the city, its dashes flowing. Boats go up the river, each held at a size on screen that reads. A
// lens in the corner of the frame follows the first boat, three times as large. The camera comes slowly nearer, and
// the eastern quarter of the city grows in.
//
// It shows: fabric (the blocks of a city, its parts, its level of detail), a relief drawn from a picture (picture),
// a stroke whose dashes flow (flow) and keep their width on screen (least), groups that keep a size on screen
// (screen) and a magnifier inset (lens). plan.ts makes the city from a seed. Run it from the repository root:
//
//   node bin/skink3.mjs check examples/city/scene.ts
//   node bin/skink3.mjs still examples/city/scene.ts --time 4
//   node bin/skink3.mjs strip examples/city/scene.ts --from 60 --count 6 --step 60

import { circle, definePalette, fabric, fadeTo, group, hsv, layer, lens, perspectiveTo, popIn, rect, region, relief, shot, stroke, travel, type Vec2 } from 'skink3-engine';
import { plan } from './plan.ts';

export const palette = definePalette({
  deep: { shade: hsv(236, 0.7, 0.22), ink: hsv(240, 0.62, 0.3) },
  dark: { ground: hsv(96, 0.62, 0.42), lane: hsv(60, 0.5, 0.48), hull: hsv(20, 0.66, 0.4) },
  mid: { water: hsv(198, 0.72, 0.78), square: hsv(42, 0.34, 0.82), stone: hsv(34, 0.24, 0.8), haze: hsv(210, 0.4, 0.86) },
  accent: { roof: hsv(12, 0.78, 0.8), tile: hsv(22, 0.74, 0.86), clay: hsv(4, 0.7, 0.72), flow: hsv(186, 0.82, 1), dome: hsv(170, 0.5, 0.74) },
  light: { cream: hsv(44, 0.14, 1), rim: hsv(40, 0.3, 0.96), sail: hsv(46, 0.1, 1) },
});

const SEED = 7;
const SECONDS = 8;
const city = plan(SEED);

// The hills behind the city: a grid of heights, rising to the north, shaded once into a picture.
const COLS = 241;
const ROWS = 141;
const heights = Array.from({ length: COLS * ROWS }, (_, i) => {
  const x = (i % COLS) / (COLS - 1);
  const y = Math.floor(i / COLS) / (ROWS - 1);
  const north = Math.max(0, 0.55 - y) / 0.55;
  return 420 * north * north * (0.6 + 0.4 * Math.sin(x * 19 + y * 7) * Math.cos(x * 7 - y * 11)) + 60 * Math.sin(x * 41) * Math.sin(y * 37) * north;
});

// Where a block is: its quarter, by its bearing from the heart. The eastern one grows in.
const quarter = ([x, y]: Vec2): number => (Math.atan2(y, x) > -0.6 && Math.atan2(y, x) < 1.2 ? 1 : 0);
const town = fabric({
  id: 'town', blocks: city.blocks, fills: ['accent.roof', 'accent.tile', 'accent.clay'], seed: SEED,
  squares: city.squares, square: 'mid.square', streets: city.streets, street: 'light.cream', least: 2,
  clear: [city.site], shadow: 'deep.shade', rim: 'light.rim', lift: 2.2, dir: 50,
  detail: { scale: 0.9, least: 2 }, part: quarter,
});

// The channel from the hills to the heart.
const channel: Vec2[] = [[1500, -1500], [1150, -1100], [820, -800], [560, -520], [300, -300], [120, -150]];

// Boats up the river, from its mouth in the east.
const way = [...city.middle].reverse();
const boats = [0, 1, 2].map((k) => group({
  id: `boat${k}`, at: way[0], screen: { size: 26, least: 22, most: 60 },
  children: [
    region({ id: `boat${k}-hull`, points: [[-13, -4], [10, -5], [14, 0], [10, 5], [-13, 4]], smooth: 0.4, fill: 'dark.hull', lit: false }),
    region({ id: `boat${k}-sail`, points: [[-4, -12], [6, -2], [-4, -2]], smooth: 0, fill: 'light.sail', lit: false }),
  ],
}));

export default shot({
  id: 'city', seconds: SECONDS, seed: SEED, palette, strings: { en: {} },
  light: { from: 'top-left' },
  background: { inner: 'mid.haze', outer: 'deep.ink', center: [0.5, 0.2], radius: 1 },
  atmosphere: 'mid.haze', vignette: 0.35,
  camera: { at: [0, 0], drift: { speed: 0.15, heading: 180, wander: 0 } },
  layers: [
    layer({ id: 'map', depth: 0, tint: 0, perspective: { aim: [0, 0, 0], distance: 2300, lens: 1150, tilt: 44, turn: -6 }, nodes: [
      group({ id: 'floor', plane: 'floor', fog: { color: 'mid.haze', near: 1800, far: 5200, amount: 0.8 }, children: [
        rect({ id: 'land', w: 9000, h: 9000, fill: 'dark.ground', lit: false, backdrop: true }),
        relief({ id: 'hills', at: [0, -700], w: 4800, h: 2800, heights: { cols: COLS, rows: ROWS, values: heights }, vertical: 1.2, dark: 'deep.shade', bright: 'light.cream', amount: 0.55, feather: 300, picture: 2, backdrop: true }),
        region({ id: 'river', points: city.river, smooth: 0.5, fill: 'mid.water', lit: false, backdrop: true }),
        town.node,
        stroke({ id: 'channel', points: channel, color: 'accent.flow', width: 7, least: 4, glow: 0.8, dash: [16, 10], flow: 45 }),
        circle({ id: 'hall', at: city.hall, r: 70, fill: 'accent.dome', side: 'mid.stone', rise: 24, lit: false, roof: { kind: 'dome', height: 50 } }),
        ...boats,
      ] }),
    ] }),
    layer({ id: 'frame', depth: -0.2, parallax: 0, blur: 0, tint: 0, nodes: [
      lens({ id: 'loupe', of: 'map', look: 'boat0', zoom: 3, r: 150, at: [-700, -330], fill: 'light.cream', opacity: 0 }),
    ] }),
  ],
  timeline: [
    perspectiveTo('map', { at: 0, distance: 1900, dur: SECONDS, profile: 'ease' }),
    fadeTo('town-1', { at: -1, to: 0, dur: 0.5 }),
    fadeTo('town-1', { at: 3, to: 1, dur: 2.5 }),
    ...boats.map((_, k) => travel(`boat${k}`, { at: -2 - 3 * k, path: way, speed: 60, orient: true })),
    popIn('loupe', { at: 1.2 }),
    fadeTo('loupe', { at: 1.2, to: 1, dur: 0.3 }),
  ],
});
