// Globe shot: 10 seconds of the Earth and the Moon seen from space, with neutral content.
//
// The Earth fills the left of the frame, lit from the upper left, its night side to the right. It starts to turn,
// gently, and what faces the viewer moves into the night, where the lights of its towns come up; clouds drift over
// it a little faster than it turns. A line runs round it near the equator, three turns side by side, drawn on as its
// front goes round, the part of it on the far side hidden. A small craft flies round the north pole, over the
// surface, and passes behind the disc for a moment; a beacon stands on a coast. The Moon hangs to the right,
// half lit, with its dark seas, and turns a little too. The camera holds.
//
// The outlines are real: the Earth's land, lakes and ice and its towns are Natural Earth's, the Moon's maria the LROC
// Global Mare Boundaries', as the library skink3-geo builds them (prepare.mjs writes them beside this file).
//
// It shows: globe() with layers from polygon data, a light, lights on the night side and a rim of air, a spin with
// keys of speed, a drifting layer of clouds made with globeBlob(), a line on the surface (a stroke among the
// children, drawn on), a thing placed by [lon, lat] (a beacon), a thing travelling round the pole facing its way
// (travel with orient, at a height), and a second body with layers of its own.
//
// Map data: Made with Natural Earth. Lunar maria: LROC Global Mare Boundaries (Nelson et al. 2014),
// NASA/GSFC/Arizona State University. Both in the public domain.

import { readFileSync } from 'node:fs';
import { capsule, circle, definePalette, drawOn, globe, globeBlob, group, hsv, layer, popIn, shot, stroke, travel, type LonLat, type StringTables } from 'skink3-engine';

export const palette = definePalette({
  deep: { space: hsv(236, 0.78, 0.16), void: hsv(248, 0.82, 0.09), night: hsv(232, 0.86, 0.12) },
  dark: { sea: hsv(212, 0.82, 0.52), basalt: hsv(228, 0.3, 0.46) },
  mid: { land: hsv(96, 0.5, 0.62), dune: hsv(38, 0.52, 0.78), highland: hsv(36, 0.12, 0.74), lake: hsv(200, 0.7, 0.78) },
  accent: { amber: hsv(40, 0.86, 0.99), coral: hsv(8, 0.72, 0.95), gold: hsv(46, 0.62, 1) },
  light: { ice: hsv(206, 0.06, 0.99), cloud: hsv(220, 0.04, 1), air: hsv(196, 0.42, 1) },
});

const strings: StringTables = { en: {} };

const data = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as T;
const earthData = data<{ land: LonLat[][]; lakes: LonLat[][]; ice: LonLat[][]; towns: [number, number, number][] }>('./earth.json');
const moonData = data<{ maria: LonLat[][] }>('./moon.json');

// Clouds: soft patches here and there, the same every time.
const CLOUDS: [number, number, number][] = [
  [-28, 52, 14], [-8, 58, 10], [12, 62, 12], [-40, 38, 9], [-20, 8, 8], [6, 4, 10], [22, -6, 7], [-34, -22, 11],
  [-12, -38, 13], [18, -48, 15], [40, -30, 9], [48, 12, 8], [60, 46, 12], [-56, 18, 9], [-70, 44, 11], [34, 30, 6],
];
const clouds = CLOUDS.map(([lon, lat, r], i) => globeBlob({ at: [lon, lat], r, stretch: 1.6, wobble: 0.35, seed: i + 1 }));

// A line round the Earth near the equator: three turns side by side, from 6 degrees south to 6 north.
const COIL: LonLat[] = [];
for (let lon = -60; lon <= -60 + 3 * 360; lon += 15) COIL.push([lon, -6 + (12 * (lon + 60)) / (3 * 360)]);

// The craft's way round the north pole, along the 50th parallel: a turn and a little more, its longitudes running on past 180.
const ROUND: LonLat[] = [];
for (let lon = -40; lon <= 400; lon += 20) ROUND.push([lon, 50]);

const earth = globe({
  id: 'earth',
  at: [-360, 40],
  r: 400,
  fill: 'dark.sea',
  view: [0, 22],
  // From rest to five degrees a second over two seconds: a gentle start.
  spin: [[0, 0], [2, 5]],
  layers: [
    { rings: earthData.land, fill: 'mid.land' },
    { rings: earthData.lakes, fill: 'mid.lake' },
    { rings: earthData.ice, fill: 'light.ice' },
    { rings: clouds, fill: 'light.cloud', opacity: 0.55, drift: 1.5, soft: 0.012 },
  ],
  light: { from: -150, lit: 0.62, night: 'deep.night', amount: 0.82, soft: 0.06 },
  lights: { points: earthData.towns, color: 'accent.gold', size: 1.2 },
  air: { color: 'light.air', width: 14 },
  children: [
    stroke({ id: 'coil', points: COIL, color: 'accent.amber', width: 5, drawn: 0 }),
    group({
      id: 'beacon',
      at: [-9.1, 38.7],
      children: [circle({ id: 'beacon-ring', r: 15, fill: 'light.cloud', lit: false }), circle({ id: 'beacon-core', r: 10, fill: 'accent.coral' })],
    }),
    group({
      id: 'craft',
      at: [ROUND[0]![0], ROUND[0]![1], 10],
      children: [capsule({ id: 'craft-body', length: 34, r: 7, fill: 'light.cloud' }), circle({ id: 'craft-nose', at: [9, 0], r: 4.5, fill: 'accent.coral', lit: false })],
    }),
  ],
});

const moon = globe({
  id: 'moon',
  at: [580, -20],
  r: 190,
  fill: 'mid.highland',
  view: [0, 0],
  spin: [[0, 0], [3, 3]],
  layers: [{ rings: moonData.maria, fill: 'dark.basalt' }],
  light: { from: -150, lit: 0.55, night: 'deep.night', amount: 0.9, soft: 0.05 },
  shade: 0.3,
});

export default shot({
  id: 'globe',
  seconds: 10,
  seed: 20261121,
  palette,
  strings,
  background: { inner: 'deep.space', outer: 'deep.void' },
  atmosphere: 'deep.space',
  camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
  layers: [layer({ id: 'sky', depth: 0, nodes: [moon, earth] })],
  timeline: [
    drawOn('coil', { at: 1, dur: 7, profile: 'ease' }),
    popIn('beacon', { at: 2 }),
    // Round the pole and a little more, starting and stopping smoothly.
    travel('craft', { at: 0.5, path: ROUND, orient: true, speeds: [[0, 1], [1.5, 40], [8, 40], [9.2, 1]] }),
  ],
});
