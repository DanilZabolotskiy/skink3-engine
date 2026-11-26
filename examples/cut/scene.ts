// Cut shot: 8 seconds, three pictures in one shot, joined by two hard cuts, with neutral content.
//
// A warm day: a sun over soft hills, motes drifting in the air. At 3 s a match cut: the sun is a moon at the same
// place and size, the sky is night, the air holds stars that come up and go out, and the far hills take the night's
// tint. At 5.5 s a cut to a close view of the moon: the camera is on it at once, larger, and the hills behind it are
// out of focus. Nothing dissolves: each picture is there whole on its first frame. The camera drifts throughout,
// and its push-in starts again at each cut.
//
// It shows: cut(); keys of no time on the frame of a cut (fadeTo, cameraTo, backgroundTo, blurTo with dur: 0);
// an emitter that runs unseen from the start (opacity 0) and is faded in at the cut, full; a set faded out at once.
// `skink3 motion` reports no finding: each side of a cut is judged as a shot of its own.

import { backgroundTo, blurTo, bump, cameraTo, circle, cut, emitter, fadeTo, group, layer, shot, type StringTables } from 'skink3-engine';
import { palette } from '../demo/palette.ts';

const strings: StringTables = { en: {} };

const DAY_TO_NIGHT = 3;
const CLOSE = 5.5;
const SUN: [number, number] = [320, -150];

export default shot({
  id: 'cut',
  seconds: 8,
  seed: 11,
  palette,
  strings,
  background: { inner: 'mid.rose', outer: 'dark.plum', center: [0.62, 0.3] },
  atmosphere: 'mid.violet',
  vignette: 0.45,
  camera: { drift: { speed: 0.45, heading: 0, wander: 10, period: 6 }, pushIn: { from: 1, to: 1.04 } },
  layers: [
    layer({
      id: 'far',
      depth: 1.2,
      nodes: [
        circle({ id: 'hill-1', at: [-560, 430], r: 420, fill: 'mid.jade', idle: { amp: 4, period: 7 } }),
        circle({ id: 'hill-2', at: [180, 520], r: 480, fill: 'dark.indigo', idle: { amp: 4, period: 8 } }),
        circle({ id: 'hill-3', at: [820, 470], r: 380, fill: 'mid.jade', idle: { amp: 4, period: 6 } }),
      ],
    }),
    layer({
      id: 'stage',
      depth: 0,
      nodes: [
        // The day: the sun and the motes in the air.
        group({ id: 'day', children: [circle({ id: 'sun', at: SUN, r: 110, fill: 'accent.amber', glow: 0.5, idle: { amp: 5, period: 3 } })] }),
        emitter({ id: 'motes', at: [0, 0], area: [2200, 1000], colors: ['light.cream'], size: [3, 5], life: [3, 4], rate: 24, prewarm: 4, speed: [14, 26], drag: 0.1, direction: -60, spread: 80, sizing: 'steady' }),
        // The night: the moon at the place and size of the sun, and stars that run unseen until the cut.
        group({
          id: 'night',
          opacity: 0,
          children: [
            circle({
              id: 'moon',
              at: SUN,
              r: 110,
              fill: 'light.snow',
              glow: 0.3,
              idle: { amp: 5, period: 3 },
              children: [
                circle({ id: 'crater-1', at: [-34, -20], r: 22, fill: 'light.mint', lit: false }),
                circle({ id: 'crater-2', at: [30, 28], r: 15, fill: 'light.mint', lit: false }),
                circle({ id: 'crater-3', at: [42, -40], r: 9, fill: 'light.mint', lit: false }),
              ],
            }),
          ],
        }),
        emitter({ id: 'stars', at: [0, -160], area: [2400, 700], colors: ['light.snow'], size: [2, 4], life: [2, 3], rate: 70, prewarm: 3, speed: [1, 4], sizing: 'steady', fade: [0, 0.9], opacity: 0 }),
      ],
    }),
  ],
  timeline: [
    bump('sun', { at: 1.4 }),
    // The match cut: day to night, whole on its first frame.
    cut({ at: DAY_TO_NIGHT }),
    fadeTo('day', { at: DAY_TO_NIGHT, to: 0, dur: 0 }),
    fadeTo('motes', { at: DAY_TO_NIGHT, to: 0, dur: 0 }),
    fadeTo('night', { at: DAY_TO_NIGHT, to: 1, dur: 0 }),
    fadeTo('stars', { at: DAY_TO_NIGHT, to: 1, dur: 0 }),
    backgroundTo({ at: DAY_TO_NIGHT, dur: 0, inner: 'deep.night', outer: 'deep.abyss', atmosphere: 'dark.navy', vignette: 0.65 }),
    bump('moon', { at: 4.4 }),
    // The cut to the close view: the camera on the moon, the hills out of focus.
    cut({ at: CLOSE }),
    cameraTo({ at: CLOSE, dur: 0, zoom: 2.4, to: SUN }),
    blurTo('far', { at: CLOSE, dur: 0, to: 14 }),
    bump('moon', { at: 6.6, amount: 0.08 }),
  ],
});
