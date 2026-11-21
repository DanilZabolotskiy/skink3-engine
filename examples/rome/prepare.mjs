// Prepares the ground of the Rome example from public data, and writes it beside the scene:
//
//   node examples/rome/prepare.mjs [--geo ../skink3-geo] [--cache out/geo-cache]
//
// The heights and the Tiber are those of the Copernicus DEM GLO-30 and its water body mask (the tile of a degree
// that holds the city, from the open bucket of the DEM on AWS). The Aurelian Walls, the outlines of the Colosseum,
// the Circus Maximus, the Pantheon, the Mausoleum of Hadrian and the Forum, and the Roman roads that stood in
// AD 275 are those of OpenHistoricalMap (CC0), asked of its Overpass server. Both are read with the public library
// skink3-geo (https://github.com/DanilZabolotskiy/skink3-geo), checked out beside the engine or wherever --geo says.
//
//   ground.bin   the heights: Int16, little-endian, in decimetres, row by row from the north-west corner
//   ground.json  the grid (its box in metres, its cell, cols and rows), the river as rings, the walls as a ring,
//                the outlines of the landmarks and the lines of the roads, all in metres (x east, y north, round
//                the projection's centre), and what it was made from
//
// Credit: produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH
// 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. OpenHistoricalMap's data
// is under CC0 and asks for no credit.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: opt } = parseArgs({ options: { geo: { type: 'string' }, cache: { type: 'string' } } });
const geoDir = resolve(opt.geo ?? join(HERE, '..', '..', '..', 'skink3-geo'));
const cache = resolve(opt.cache ?? join(HERE, '..', '..', 'out', 'geo-cache'));
const lib = (name) => import(pathToFileURL(join(geoDir, 'lib', name)).href);
const { readGeoTiff, sampler, waterSampler } = await lib('dem.mjs');
const { projection } = await lib('project.mjs');
const { makeGrid, blur, contours } = await lib('raster.mjs');
const { area, chaikin, dedupe, simplify } = await lib('geom.mjs');
const { download, overpass } = await lib('fetch.mjs');
const { alive, areasOf, joinLines, readOverpass, waysOf } = await lib('osm.mjs');

/** The city of AD 275 inside its walls, the Tiber's bends and the hills round it: about 16 by 11 km. */
const BOX = [12.385, 41.845, 12.575, 41.945];
const CENTRE = { lon: 12.48, lat: 41.895 };
const CELL = 36;
const WET_CELL = 10;
const YEAR = 275;
const log = (line) => console.log(line);

const sources = [];
const tile = async (id, url) => {
  const got = await download({ cache, id, urls: [url], log });
  sources.push({ url: got.url, sha256: got.sha256 });
  return readGeoTiff(readFileSync(got.path));
};
const name = 'Copernicus_DSM_COG_10_N41_00_E012_00_DEM';
const BUCKET = 'https://copernicus-dem-30m.s3.amazonaws.com';
const dem = [await tile('dem-n41e012', `${BUCKET}/${name}/${name}.tif`)];
const wbm = [await tile('wbm-n41e012', `${BUCKET}/${name}/AUXFILES/${name.replace(/_DEM$/, '_WBM')}.tif`)];

const ohm = async (id, query) => {
  const got = await overpass({ cache, id, query: `[out:json][timeout:180];\n${query}\nout geom;\n`, ohm: true, log });
  sources.push({ url: got.url, query, sha256: got.sha256, fetched: got.fetched });
  return readOverpass(got.path);
};
const bbox = `(${BOX[1]},${BOX[0]},${BOX[3]},${BOX[2]})`;
const wallElements = await ohm('ohm-aurelian-walls', '(\n  relation(2693274);\n);');
const landmarkElements = await ohm('ohm-rome-landmarks', '(\n  relation(2686943);\n  relation(2686942);\n  relation(2751481);\n  way(199851193);\n  way(198576333);\n);');
const roadElements = await ohm('ohm-rome-roads', `(\n  way["highway"]${bbox};\n);`);

const proj = projection(CENTRE);
const metres = (line) => line.map((p) => proj.forward(p).map((v) => Math.round(v * 10) / 10));
const corners = [[BOX[0], BOX[1]], [BOX[2], BOX[1]], [BOX[0], BOX[3]], [BOX[2], BOX[3]]].map((p) => proj.forward(p));
const half = [Math.max(...corners.map((c) => Math.abs(c[0]))), Math.max(...corners.map((c) => Math.abs(c[1])))].map((v) => Math.floor(v / CELL) * CELL);
const box = [-half[0], -half[1], half[0], half[1]];

// The heights: sampled every 12 m, smoothed over about 120 m (the model is of the surface of today, the city's
// buildings in it), then taken every third sample.
const height = sampler(dem, 0);
const fine = makeGrid(box, CELL / 3);
for (let j = 0; j < fine.h; j++) {
  for (let i = 0; i < fine.w; i++) fine.data[j * fine.w + i] = height(proj.inverse([fine.x0 + (i + 0.5) * fine.cell, fine.y0 + (j + 0.5) * fine.cell]));
}
const smooth = blur(fine, 10);
const cols = Math.floor(fine.w / 3);
const rows = Math.floor(fine.h / 3);
const heights = new Int16Array(cols * rows);
let low = Infinity;
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const v = smooth.data[((rows - 1 - r) * 3 + 1) * fine.w + c * 3 + 1];
    heights[r * cols + c] = Math.round(v * 10);
    low = Math.min(low, v);
  }
}

// The Tiber: the river of the water mask every 10 m, softened, traced where it is half water.
const water = waterSampler(wbm, ['river', 'lake']);
const wet = makeGrid(box, WET_CELL);
for (let j = 0; j < wet.h; j++) {
  for (let i = 0; i < wet.w; i++) wet.data[j * wet.w + i] = water(proj.inverse([wet.x0 + (i + 0.5) * wet.cell, wet.y0 + (j + 0.5) * wet.cell]));
}
const round = (ring) => ring.map(([x, y]) => [Math.round(x), Math.round(y)]);
const river = contours(blur(wet, 2.5), 0.5)
  .rings.map((ring) => round(chaikin(simplify(ring, 6, true), 2, true)))
  .filter((ring) => area(ring) >= 40_000)
  .sort((a, b) => area(b) - area(a));

// The walls: the ways of the circuit, members of its relation, joined into a ring.
const wallLines = wallElements.flatMap((e) => (e.members ?? []).filter((m) => m.type === 'way' && m.geometry).map((m) => m.geometry.filter(Boolean).map((p) => [p.lon, p.lat])));
const wallRings = joinLines(wallLines, { eps: 1e-6 }).sort((a, b) => b.line.length - a.line.length);
const walls = dedupe(metres(wallRings[0].line), 0.5, true);

// The landmarks: the outer ring of each.
const LANDMARKS = { colosseum: 'relation/2686943', circus: 'relation/2686942', pantheon: 'relation/2751481', hadrian: 'way/199851193', forum: 'way/198576333' };
const outlines = {};
for (const a of areasOf(landmarkElements)) {
  const key = Object.keys(LANDMARKS).find((k) => LANDMARKS[k] === a.id);
  if (key && a.outer.length > 0) outlines[key] = metres(a.outer.sort((p, q) => q.length - p.length)[0]);
}

// The roads that stood in AD 275, with their names.
const roads = waysOf(roadElements, (tags) => alive(tags, YEAR) && tags.start_date !== undefined).map((w) => ({ name: w.tags.name ?? w.tags['name:la'] ?? '', line: metres(w.line) }));

writeFileSync(join(HERE, 'ground.bin'), Buffer.from(heights.buffer));
writeFileSync(
  join(HERE, 'ground.json'),
  JSON.stringify({
    note: 'Made by prepare.mjs. Heights and the river: produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. Walls, landmarks and roads: OpenHistoricalMap, CC0.',
    centre: [CENTRE.lon, CENTRE.lat],
    box,
    cell: CELL,
    cols,
    rows,
    river,
    walls,
    landmarks: outlines,
    roads,
    sources,
  }) + '\n',
);
const sum = createHash('sha256').update(Buffer.from(heights.buffer)).digest('hex').slice(0, 12);
console.log(`heights ${cols} x ${rows} (lowest ${low.toFixed(1)} m, ${sum}), river ${river.length} rings (${river.map((r) => r.length).join(', ')}), walls ${walls.length} points, landmarks ${Object.keys(outlines).join(' ')}, roads ${roads.length}`);
