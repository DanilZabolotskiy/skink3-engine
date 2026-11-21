// Prepares the maps of the world example from public data, and writes them beside the scenes:
//
//   node examples/world/prepare.mjs [--geo ../skink3-geo]
//
// The countries are Natural Earth's admin-0 countries (public domain), as the public library skink3-geo
// (https://github.com/DanilZabolotskiy/skink3-geo) builds them with its world.mjs and keeps in its examples: the whole
// world at 1:50m on the Equal Earth projection, and the countries round Slovenia at 1:10m. The library is checked out
// beside the engine or wherever --geo says; this script puts each map on the stage with the library's map.ts
// (`worldOnStage`, which keeps a border the same points in both its countries) and writes the outlines the scenes
// draw, in stage units.
//
//   world.json     the whole world on a stage 1800 wide: the edge of the world (the sea), the land, the water inside
//                  it, every country by its code, each land border once, the large lakes, and the equator
//   country.json   Slovenia among its neighbours on the whole stage: the land, every country, the borders, the lakes
//
// Credit (a courtesy: the data is in the public domain): Made with Natural Earth.

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: opt } = parseArgs({ options: { geo: { type: 'string' } } });
const geoDir = resolve(opt.geo ?? join(HERE, '..', '..', '..', 'skink3-geo'));
const { fitView, loadWorld, toFrame, worldOnStage } = await import(pathToFileURL(join(geoDir, 'map.ts')).href);
// An entry a line, so that a change shows as the lines it changes.
const text = (o) => `{\n${Object.entries(o).map(([k, v]) => (Array.isArray(v) ? `  ${JSON.stringify(k)}: [\n${v.map((e) => `    ${JSON.stringify(e)}`).join(',\n')}\n  ]` : `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)).join(',\n')}\n}\n`;

/** A map on the stage, as the scenes read it. */
function onStage(world, view) {
  const map = worldOnStage(view, world);
  return {
    land: map.land,
    gaps: map.gaps,
    countries: map.countries.map((c) => ({ id: c.id, name: c.name, label: c.label, rings: c.rings })),
    borders: map.borders.map((b) => ({ id: b.id, lines: b.lines })),
    lakes: map.lakes.flatMap((l) => l.rings),
  };
}

const world = loadWorld(join(geoDir, 'examples', 'world', 'world.json'));
const wide = fitView(world.frame.box, { w: 1800, h: 1000 }, { mode: 'contain' });
const project = (lonlat) => wide.project(toFrame(world.frame)(lonlat));
const equator = [];
for (let lon = -180; lon <= 180; lon += 10) equator.push(project([lon, 0]));
writeFileSync(
  join(HERE, 'world.json'),
  text({
    source: `skink3-geo examples/world: Natural Earth, 1:${world.made.scale}m admin-0 countries and lakes, Equal Earth, thinned together to ${world.made.detail} m; Made with Natural Earth.`,
    sea: worldOnStage(wide, world).sea[0],
    equator,
    ...onStage(world, wide),
  }),
);

const box = loadWorld(join(geoDir, 'examples', 'slovenia', 'world.json'));
// A little closer than the box covers the stage, so the land still fills the frame when the camera aims at the country.
const near = fitView(box.frame.box, { w: 1920, h: 1080 }, { mode: 'cover', zoom: 1.04 });
writeFileSync(
  join(HERE, 'country.json'),
  text({
    source: `skink3-geo examples/slovenia: Natural Earth, 1:${box.made.scale}m admin-0 countries and lakes, cut to ${box.made.bbox.join(', ')}, thinned together to ${box.made.detail} m; Made with Natural Earth.`,
    ...onStage(box, near),
  }),
);
console.log(`wrote ${join(HERE, 'world.json')} and ${join(HERE, 'country.json')}`);
