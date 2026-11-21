// Country shot: 6 seconds of one small country among its neighbours, on a flat map, with neutral content.
//
// The countries round Slovenia lie on the plane of their region, each in one of four quiet tints so that no two
// neighbours share one, the Adriatic and the lakes in blue. Slovenia's border draws itself round it, the country fills
// with gold to its real borders, and its name comes up inside it. The camera pushes in toward it, slowly.
//
// The outlines are real: Natural Earth's admin-0 countries at 1:10m, thinned together so that neighbours share their
// borders, as the library skink3-geo builds them with its world.mjs for a box (prepare.mjs puts them on the stage and
// writes them beside this file).
//
// It shows: a map of countries as flat regions over a land that hides the seams between them, tints picked so that
// neighbours differ (from the borders the map holds), one country picked by its code and filled, its outline drawn on
// as a closed stroke, one short name from the string table, and a push-in toward a point.
//
// Map data: Made with Natural Earth (public domain).

import { readFileSync } from 'node:fs';
import { definePalette, drawOn, fadeTo, fillTo, group, hsv, layer, region, shot, stroke, text, type ColorRef, type StringTables, type Vec2 } from 'skink3-engine';

export const palette = definePalette({
  deep: { ground: hsv(214, 0.7, 0.3), rim: hsv(222, 0.75, 0.18), ink: hsv(232, 0.62, 0.2) },
  dark: { sea: hsv(203, 0.72, 0.62), border: hsv(250, 0.42, 0.34) },
  mid: { land: hsv(38, 0.22, 0.86), sage: hsv(96, 0.26, 0.82), lilac: hsv(262, 0.2, 0.86), sand: hsv(38, 0.3, 0.92), rose: hsv(12, 0.26, 0.92), lake: hsv(198, 0.62, 0.78) },
  accent: { gold: hsv(44, 0.86, 0.98) },
  light: { cream: hsv(46, 0.12, 1) },
  rules: [
    { name: 'no grey in the dark', roles: ['deep', 'dark'], saturation: [0.4, 1] },
    { name: 'light is light', roles: ['light'], lightness: [85, 100] },
  ],
});

const strings: StringTables = { en: { 'name.svn': 'Slovenia' } };

type Country = { id: string; name: string; label: Vec2; rings: Vec2[][] };
const map = JSON.parse(readFileSync(new URL('./country.json', import.meta.url), 'utf8')) as {
  land: Vec2[][];
  gaps: Vec2[][];
  countries: Country[];
  borders: { id: string; lines: Vec2[][] }[];
  lakes: Vec2[][];
};

/** Four tints, each country the first one none of its neighbours has taken: the map's borders say who is a neighbour. */
const TINTS: ColorRef[] = ['mid.sage', 'mid.lilac', 'mid.sand', 'mid.rose'];
const tint = new Map<string, ColorRef>();
for (const c of map.countries) {
  const near = map.borders.filter((b) => b.id.split('-').includes(c.id)).map((b) => tint.get(b.id.split('-').find((id) => id !== c.id)!));
  tint.set(c.id, TINTS.find((t) => !near.includes(t)) ?? TINTS[0]!);
}

const svn = map.countries.find((c) => c.id === 'svn')!;
const flat = (id: string, rings: Vec2[][], fill: ColorRef) => rings.map((points, i) => region({ id: `${id}-${i}`, points, smooth: 0, fill, lit: false }));
const W = 1200;
const H = 700;

export default shot({
  id: 'country',
  seconds: 6,
  seed: 20261121,
  palette,
  strings,
  background: { inner: 'deep.ground', outer: 'deep.rim' },
  atmosphere: 'deep.ground',
  vignette: 0.2,
  camera: { at: svn.label, drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1.12 } },
  layers: [
    layer({
      id: 'map',
      depth: 0,
      nodes: [
        region({ id: 'sea', points: [[-W, -H], [W, -H], [W, H], [-W, H]], smooth: 0, fill: 'dark.sea', lit: false }),
        // The land as one under the countries: where two neighbours meet, their edges blend into it, not into the sea.
        ...flat('land', map.land, 'mid.land'),
        ...map.countries.flatMap((c) => flat(c.id, c.rings, tint.get(c.id)!)),
        ...flat('gap', map.gaps, 'dark.sea'),
        ...flat('lake', map.lakes, 'mid.lake'),
        group({ id: 'borders', opacity: 0.55, children: map.borders.flatMap((b) => b.lines.map((points, i) => stroke({ id: `border-${b.id}-${i}`, points, smooth: 0, color: 'dark.border', width: 1.6 }))) }),
        stroke({ id: 'svn-edge', points: svn.rings[0]!, closed: true, smooth: 0, color: 'light.cream', width: 4, drawn: 0 }),
        text({ id: 'svn-name', text: 'name.svn', ink: 'deep.ink', at: svn.label, size: 40, weight: 800, align: 'center', opacity: 0 }),
      ],
    }),
  ],
  timeline: [
    drawOn('svn-edge', { at: 0.6, dur: 2, profile: 'ease' }),
    fillTo('svn-0', { at: 1.4, to: 'accent.gold', dur: 1.2, profile: 'ease' }),
    fadeTo('svn-name', { at: 2.6, to: 1, dur: 0.8 }),
  ],
});
