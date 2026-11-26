// Bands shot: 9 seconds of a banded planet, with neutral content.
//
// A planet of pale and darker bands turns slowly against a dark sky, lit from the upper left, its night side to the
// right; its bands drift a little, each at its own speed, and two storms ride on them. From the north down, one band
// after another brightens on a beat and dims again, then one band fades out, showing the disc under it, and comes
// back. The camera holds.
//
// It shows: a globe's layers with ids, keyed by fillTo (a band brightens and dims, key after key) and by fadeTo (a
// band fades out and back), while the globe turns and its layers drift; the bands are rings of [lon, lat] made here,
// each a cap round a pole less a smaller cap (a hole).

import { definePalette, fadeTo, fillTo, globe, globeBlob, hsv, layer, shot, type ColorRef, type LonLat, type StringTables } from 'skink3-engine';

export const palette = definePalette({
  deep: { space: hsv(244, 0.72, 0.14), void: hsv(250, 0.8, 0.08), night: hsv(236, 0.8, 0.1) },
  dark: { rust: hsv(22, 0.62, 0.5) },
  mid: { sand: hsv(36, 0.46, 0.8), clay: hsv(18, 0.52, 0.66), storm: hsv(12, 0.6, 0.72) },
  accent: { flare: hsv(44, 0.82, 1) },
  light: { cream: hsv(44, 0.2, 0.98), air: hsv(30, 0.3, 1) },
});

const strings: StringTables = { en: {} };

/** A parallel as a ring of [lon, lat], every 5 degrees: east (counter-clockwise round the north pole, seen from outside), or west. */
const parallel = (lat: number, east: boolean): LonLat[] => {
  const ring = Array.from({ length: 72 }, (_, k): LonLat => [-180 + 5 * k, lat]);
  return east ? ring : ring.reverse();
};

/** A band between two latitudes of one hemisphere: the cap round its pole from the nearer latitude, less the cap from the farther. */
const band = (a: number, b: number): LonLat[][] => {
  const north = a > 0;
  const [near, far] = north ? [Math.min(a, b), Math.max(a, b)] : [Math.max(a, b), Math.min(a, b)];
  // Round the north pole a cap runs east; round the south pole, west. The hole runs the other way.
  return [parallel(near, north), parallel(far, !north)];
};

const BANDS: [number, number][] = [[54, 76], [30, 46], [8, 22], [-22, -8], [-46, -30], [-76, -54]];
const FILLS: ColorRef[] = ['mid.clay', 'mid.sand', 'dark.rust', 'mid.sand', 'mid.clay', 'dark.rust'];

export default shot({
  id: 'bands',
  seconds: 9,
  seed: 5,
  palette,
  strings,
  background: { inner: 'deep.space', outer: 'deep.void' },
  atmosphere: 'deep.space',
  vignette: 0.4,
  camera: { drift: { speed: 0, wander: 6, period: 7 }, pushIn: { from: 1, to: 1.03 } },
  layers: [
    layer({
      id: 'sky',
      depth: 0,
      nodes: [
        globe({
          id: 'planet',
          r: 400,
          fill: 'mid.sand',
          view: [0, 22],
          spin: [[0, 0], [1.5, 8]],
          layers: [
            ...BANDS.map(([a, b], k) => ({ id: `band-${k + 1}`, rings: band(a, b), fill: FILLS[k]!, drift: (k % 2 === 0 ? 1 : -1) * (1 + k * 0.4) })),
            { rings: [globeBlob({ at: [30, 16], r: 6, stretch: 1.8, seed: 3 })], fill: 'mid.storm', drift: 2 },
            { rings: [globeBlob({ at: [-70, -40], r: 4, stretch: 1.6, seed: 4 })], fill: 'light.cream', opacity: 0.8, drift: -1.5 },
          ],
          light: { from: -150, lit: 0.7, night: 'deep.night' },
          air: { color: 'light.air', amount: 0.5 },
        }),
      ],
    }),
  ],
  timeline: [
    // One band after another, from the north down, brightens on a beat and dims again.
    ...BANDS.flatMap((_, k) => [
      fillTo(`band-${k + 1}`, { at: 1.2 + k * 0.9, to: 'accent.flare', dur: 0.45 }),
      fillTo(`band-${k + 1}`, { at: 1.2 + k * 0.9 + 0.55, to: FILLS[k]!, dur: 0.8 }),
    ]),
    // A band fades out, showing the disc under it, and comes back.
    fadeTo('band-3', { at: 7, to: 0, dur: 0.7 }),
    fadeTo('band-3', { at: 8, to: 1, dur: 0.7 }),
  ],
});
