// Atlas shot: lines, with neutral content.
//
// A route draws itself across the frame behind a bead that travels along it;
// its last stretch is dotted at first and then closes into a solid line. A
// jagged line falls, a dashed outline runs round a block, and a ring fills
// part of the way round.
//
// It shows: stroke() with points, dash and glow, drawOn() with a share and a
// profile, solidTo(), and arcPoints().

import { arcPoints, circle, drawOn, fadeTo, layer, popIn, rect, shot, solidTo, stroke, travel, type Key, type StringTables, type Vec2 } from 'skink3-engine';
import { palette } from '../demo/palette.ts';

const SEED = 20261117;

// The route: its first part is certain, its last part is not yet.
const ROUTE: Vec2[] = [[-760, 250], [-520, 60], [-260, 150], [-40, -40], [200, 40]];
const AHEAD: Vec2[] = [[200, 40], [380, 120], [560, -20], [700, -190]];
const CHART: Vec2[] = [[-760, -330], [-690, -380], [-630, -300], [-560, -350], [-490, -240], [-420, -290], [-350, -170]];

const strings: StringTables = { en: {}, 'x-long': {} };

const timeline: Key[] = [
  // The bead and the line behind it share a path, a start, a length and a profile.
  popIn('bead', { at: 0.4 }),
  travel('bead', { at: 1, path: ROUTE, dur: 3, profile: 'ease' }),
  drawOn('route', { at: 1, dur: 3, profile: 'ease' }),
  // What lies ahead appears as dots, and is made a line later.
  drawOn('ahead', { at: 4.2, dur: 1.4 }),
  solidTo('ahead', { at: 7, dur: 1.2 }),
  // A share: the ring fills to 62 % and stays there.
  drawOn('share', { at: 2, dur: 1.6, to: 0.62 }),
  drawOn('chart', { at: 0.6, dur: 2.2, profile: 'steady' }),
  fadeTo('fence', { at: 5.5, to: 1, dur: 0.8 }),
];

export default shot({
  id: 'atlas',
  seconds: 10,
  seed: SEED,
  palette,
  strings,
  background: { inner: 'deep.night', outer: 'deep.abyss' },
  atmosphere: 'mid.mist',
  layers: [
    layer({
      id: 'stage',
      depth: 0,
      nodes: [
        stroke({ id: 'route', points: ROUTE, color: 'accent.amber', width: 9, glow: 0.5 }),
        stroke({ id: 'ahead', points: AHEAD, color: 'accent.amber', width: 9, dash: [0, 22] }),
        circle({ id: 'bead', at: ROUTE[0]!, r: 20, fill: 'light.cream', glow: 0.6 }),
        stroke({ id: 'chart', points: CHART, color: 'accent.coral', width: 7, smooth: 0 }),
        rect({ id: 'block', at: [560, 300], w: 240, h: 150, fill: 'dark.indigo' }),
        stroke({ id: 'fence', at: [560, 300], points: [[-150, -105], [150, -105], [150, 105], [-150, 105]], closed: true, smooth: 0.25, color: 'mid.mist', width: 5, dash: [18, 14], opacity: 0 }),
        stroke({ id: 'ring', at: [-560, -40], points: arcPoints([0, 0], 70, 0, 360), closed: true, color: 'dark.haze', width: 16 }),
        stroke({ id: 'share', at: [-560, -40], points: arcPoints([0, 0], 70, -90, 270), color: 'accent.aqua', width: 16, glow: 0.4 }),
      ],
    }),
  ],
  timeline,
});
