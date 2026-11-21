// Prepares the bodies of the globe example from public data, and writes them beside the scene:
//
//   node examples/globe/prepare.mjs [--geo ../skink3-geo]
//
// The Earth's land, lakes, ice and towns are those of Natural Earth (public domain); the Moon's maria, its dark seas
// of basalt, are those of the LROC Global Mare Boundaries (Nelson et al. 2014) in NASA's Planetary Data System
// (public domain). Both are the globes the public library skink3-geo
// (https://github.com/DanilZabolotskiy/skink3-geo) builds with its globe.mjs and keeps in its examples, checked out
// beside the engine or wherever --geo says; this script takes what the scene draws from them.
//
//   earth.json   the land, the large lakes and the ice as rings of [lon, lat], and the 1500 largest towns as
//                [lon, lat, millions of people]
//   moon.json    the maria as rings of [lon, lat]
//
// Credit (a courtesy: the data is in the public domain): Made with Natural Earth. Lunar maria: LROC Global Mare
// Boundaries (Nelson et al. 2014), NASA/GSFC/Arizona State University.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: opt } = parseArgs({ options: { geo: { type: 'string' } } });
const geoDir = resolve(opt.geo ?? join(HERE, '..', '..', '..', 'skink3-geo'));
const read = (body) => {
  const globe = JSON.parse(readFileSync(join(geoDir, 'examples', body, 'globe.json'), 'utf8'));
  if (globe.format !== 'globe-geo/1') throw new Error(`${body}: not a globe of skink3-geo (format ${globe.format})`);
  return globe;
};
const rings = (list) => list.flatMap((p) => p.rings);
// An entry a line, so that a change shows as the lines it changes.
const text = (o) => `{\n${Object.entries(o).map(([k, v]) => (Array.isArray(v) ? `  ${JSON.stringify(k)}: [\n${v.map((e) => `    ${JSON.stringify(e)}`).join(',\n')}\n  ]` : `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)).join(',\n')}\n}\n`;

const earth = read('earth');
writeFileSync(
  join(HERE, 'earth.json'),
  text({
    source: `skink3-geo examples/earth: Natural Earth, 1:${earth.made.scale}m, thinned to ${earth.made.tolerance} degrees of arc; Made with Natural Earth.`,
    land: rings(earth.layers.land),
    lakes: rings(earth.layers.lakes),
    ice: rings(earth.layers.ice),
    towns: earth.places.slice(0, 1500).map((p) => [p.at[0], p.at[1], Math.round(p.pop / 1e4) / 100]),
  }),
);
const moon = read('moon');
writeFileSync(
  join(HERE, 'moon.json'),
  text({
    source: `skink3-geo examples/moon: LROC Global Mare Boundaries (Nelson et al. 2014), thinned to ${moon.made.tolerance} degrees of arc; NASA/GSFC/Arizona State University.`,
    maria: rings(moon.layers.maria),
  }),
);
console.log(`wrote ${join(HERE, 'earth.json')} and ${join(HERE, 'moon.json')}`);
