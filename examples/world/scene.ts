// World shot: 8 seconds of the whole world on one flat map, with neutral content.
//
// The world lies on the Equal Earth projection, its sea filling the edge of the world on a dark ground, every country
// in a pale sand with its borders faint. A soft wash spreads out from the Gulf of Guinea over every continent, and the
// equator draws itself across the map; then the countries it crosses deepen one after another, west to east, each to
// its real borders. The camera pushes in a little, slowly.
//
// The outlines are real: Natural Earth's admin-0 countries at 1:50m, thinned together so that neighbours share their
// borders, as the library skink3-geo builds them with its world.mjs (prepare.mjs fits them to the stage and writes
// them beside this file).
//
// It shows: flat regions of up to a few thousand points (the land, every country), a land under the countries so that
// no seam opens between neighbours, a wash clipped to a soft circle that grows (it fades out across its edge), countries
// picked by their codes and faded in on a stagger, a dashed line drawn on, faint strokes along every land border (faded as one group), and
// a slow push-in.
//
// Map data: Made with Natural Earth (public domain).

import { readFileSync } from 'node:fs';
import { circle, definePalette, drawOn, fadeTo, group, hsv, layer, region, scaleTo, shot, stagger, stroke, type ColorRef, type StringTables, type Vec2 } from 'skink3-engine';

export const palette = definePalette({
  deep: { ground: hsv(238, 0.72, 0.2), rim: hsv(246, 0.78, 0.12) },
  dark: { sea: hsv(204, 0.8, 0.58), border: hsv(24, 0.55, 0.42) },
  mid: { sand: hsv(40, 0.3, 0.93), lake: hsv(198, 0.66, 0.72) },
  accent: { coral: hsv(14, 0.62, 0.95), ember: hsv(4, 0.82, 0.8) },
  light: { cream: hsv(44, 0.16, 1) },
  rules: [
    { name: 'no grey in the dark', roles: ['deep', 'dark'], saturation: [0.5, 1] },
    { name: 'light is light', roles: ['light'], lightness: [85, 100] },
  ],
});

const strings: StringTables = { en: {} };

type Country = { id: string; name: string; rings: Vec2[][] };
const map = JSON.parse(readFileSync(new URL('./world.json', import.meta.url), 'utf8')) as {
  sea: Vec2[];
  equator: Vec2[];
  land: Vec2[][];
  gaps: Vec2[][];
  countries: Country[];
  borders: { id: string; lines: Vec2[][] }[];
  lakes: Vec2[][];
};

/** The countries the equator crosses, by their codes, west to east. */
const EQUATOR = ['ecu', 'col', 'bra', 'gab', 'cog', 'cod', 'uga', 'ken', 'som', 'idn'];
const picked = EQUATOR.map((id) => map.countries.find((c) => c.id === id)!);

const flat = (id: string, rings: Vec2[][], fill: ColorRef, opacity = 1) =>
  rings.map((points, i) => region({ id: `${id}-${i}`, points, smooth: 0, fill, lit: false, opacity }));

export default shot({
  id: 'world',
  seconds: 8,
  seed: 20261121,
  palette,
  strings,
  background: { inner: 'deep.ground', outer: 'deep.rim' },
  atmosphere: 'deep.ground',
  camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1.04 } },
  layers: [
    layer({
      id: 'map',
      depth: 0,
      nodes: [
        region({ id: 'sea', points: map.sea, smooth: 0, fill: 'dark.sea', lit: false }),
        // The land as one under the countries: where two neighbours meet, their edges blend into it, not into the sea.
        ...flat('land', map.land, 'mid.sand'),
        ...map.countries.flatMap((c) => flat(c.id, c.rings, 'mid.sand')),
        // The wash: the land again in coral, seen only inside a soft circle that grows from the Gulf of Guinea.
        circle({ id: 'spread', at: [12, -14], r: 13, soft: 1.6, fill: 'accent.coral', lit: false, opacity: 0 }),
        group({ id: 'wash', clipTo: 'spread', opacity: 0.5, children: flat('wash', map.land, 'accent.coral') }),
        group({ id: 'deep', children: picked.map((c) => group({ id: `deep-${c.id}`, opacity: 0, children: flat(`deep-${c.id}`, c.rings, 'accent.ember') })) }),
        // The inland sea and the lakes over the land and its wash, so they stay water.
        ...flat('gap', map.gaps, 'dark.sea'),
        ...flat('lake', map.lakes, 'mid.lake'),
        // The borders faded as one group: a faded stroke each would cost a layer each.
        group({ id: 'borders', opacity: 0.5, children: map.borders.flatMap((b) => b.lines.map((points, i) => stroke({ id: `border-${b.id}-${i}`, points, smooth: 0, color: 'dark.border', width: 1.1 }))) }),
        stroke({ id: 'equator', points: map.equator, smooth: 0, color: 'light.cream', width: 2.2, dash: [12, 9], opacity: 0.75, drawn: 0 }),
      ],
    }),
  ],
  timeline: [
    scaleTo('spread', { at: 0.3, to: 90, dur: 5.6, profile: 'ease' }),
    drawOn('equator', { at: 1.8, dur: 2.6, profile: 'ease' }),
    stagger(picked.map((c) => `deep-${c.id}`), { at: 4.4, each: 0.22 }, (id, at) => fadeTo(id, { at, to: 0.95, dur: 0.9 })),
  ],
});
