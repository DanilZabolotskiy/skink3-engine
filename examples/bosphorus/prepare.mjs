// Prepares the ground of the Bosphorus example from public data, and writes it beside the scene:
//
//   node examples/bosphorus/prepare.mjs [--geo ../skink3-geo] [--cache out/geo-cache]
//
// The heights and the water are those of the Copernicus DEM GLO-30 and its water body mask, four tiles of a
// degree each, taken from the open bucket of the DEM on AWS and read with the public library skink3-geo
// (https://github.com/DanilZabolotskiy/skink3-geo), checked out beside the engine or wherever --geo says.
//
//   ground.bin   the heights: Int16, little-endian, in decimetres, row by row from the north-west corner
//   ground.json  the grid (its box in metres, its cell, cols and rows), the sea as rings in metres (x east,
//                y north, round the projection's centre), and the files it was made from with their SHA-256
//
// Credit: produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH
// 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: opt } = parseArgs({ options: { geo: { type: 'string' }, cache: { type: 'string' } } });
const geoDir = resolve(opt.geo ?? join(HERE, '..', '..', '..', 'skink3-geo'));
const cacheDir = resolve(opt.cache ?? join(HERE, '..', '..', 'out', 'geo-cache'));
const lib = (name) => import(pathToFileURL(join(geoDir, 'lib', name)).href);
const { readGeoTiff, sampler, waterSampler } = await lib('dem.mjs');
const { projection } = await lib('project.mjs');
const { makeGrid, blur, contours } = await lib('raster.mjs');
const { area, simplify } = await lib('geom.mjs');

/** The view: from the Sea of Marmara up the whole strait to the Black Sea, and the land on either side, about 70 by 49 km. */
const BOX = [28.62, 40.92, 29.46, 41.36];
const CENTRE = { lon: 29.04, lat: 41.105 };
/** Metres between two heights of the grid, and between two samples of the water traced for the coast. */
const CELL = 150;
const WET_CELL = 30;

const BUCKET = 'https://copernicus-dem-30m.s3.amazonaws.com';
const tileName = (lat, lon) => `Copernicus_DSM_COG_10_N${String(lat).padStart(2, '0')}_00_E${String(lon).padStart(3, '0')}_00_DEM`;

async function fetchTile(url, file) {
  const path = join(cacheDir, file);
  if (!existsSync(path)) {
    mkdirSync(cacheDir, { recursive: true });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  const buf = readFileSync(path);
  return { buf, source: { url, sha256: createHash('sha256').update(buf).digest('hex') } };
}

const sources = [];
const dem = [];
const wbm = [];
for (const lat of [40, 41]) {
  for (const lon of [28, 29]) {
    const name = tileName(lat, lon);
    const d = await fetchTile(`${BUCKET}/${name}/${name}.tif`, `${name}.tif`);
    const w = await fetchTile(`${BUCKET}/${name}/AUXFILES/${name.replace(/_DEM$/, '_WBM')}.tif`, `${name.replace(/_DEM$/, '_WBM')}.tif`);
    dem.push(readGeoTiff(d.buf));
    wbm.push(readGeoTiff(w.buf));
    sources.push(d.source, w.source);
  }
}

const proj = projection(CENTRE);
const height = sampler(dem, 0);
const water = waterSampler(wbm, ['ocean', 'lake', 'river']);
// The box in metres: the square that holds the corners of the degrees asked for.
const corners = [[BOX[0], BOX[1]], [BOX[2], BOX[1]], [BOX[0], BOX[3]], [BOX[2], BOX[3]]].map((p) => proj.forward(p));
const half = [Math.max(...corners.map((c) => Math.abs(c[0]))), Math.max(...corners.map((c) => Math.abs(c[1])))].map((v) => Math.floor(v / CELL) * CELL);
const box = [-half[0], -half[1], half[0], half[1]];

// The heights: sampled every 50 m, smoothed over about 200 m (the model is of the surface, buildings and trees
// in it), then taken every third sample. The sea is at 0.
const fine = makeGrid(box, CELL / 3);
for (let j = 0; j < fine.h; j++) {
  for (let i = 0; i < fine.w; i++) {
    const at = proj.inverse([fine.x0 + (i + 0.5) * fine.cell, fine.y0 + (j + 0.5) * fine.cell]);
    fine.data[j * fine.w + i] = water(at) >= 0.5 ? 0 : Math.max(0, height(at));
  }
}
const smooth = blur(fine, 4);
const cols = Math.floor(fine.w / 3);
const rows = Math.floor(fine.h / 3);
const heights = new Int16Array(cols * rows);
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    // Row 0 of the file is the north; row 0 of the grid the south.
    const j = (rows - 1 - r) * 3 + 1;
    heights[r * cols + c] = Math.round(Math.max(0, smooth.data[j * fine.w + c * 3 + 1]) * 10);
  }
}

// The sea: the water mask every 30 m, softened by a sample, traced where it is half water, simplified to 12 m.
// Only the sea is kept, the water of over 20 km² that reaches the edge of the box: lakes and reservoirs are left out.
const wet = makeGrid(box, WET_CELL);
for (let j = 0; j < wet.h; j++) {
  for (let i = 0; i < wet.w; i++) wet.data[j * wet.w + i] = water(proj.inverse([wet.x0 + (i + 0.5) * wet.cell, wet.y0 + (j + 0.5) * wet.cell]));
}
const traced = contours(blur(wet, 1), 0.5);
const round = (v) => Math.round(v);
const sea = traced.rings
  .map((ring) => simplify(ring, 12, true).map(([x, y]) => [round(x), round(y)]))
  .filter((ring) => ring.length >= 4 && area(ring) >= 20e6 && ring.some(([x, y]) => x <= box[0] + 2 * WET_CELL || x >= box[2] - 2 * WET_CELL || y <= box[1] + 2 * WET_CELL || y >= box[3] - 2 * WET_CELL))
  .sort((a, b) => area(b) - area(a));

writeFileSync(join(HERE, 'ground.bin'), Buffer.from(heights.buffer));
writeFileSync(
  join(HERE, 'ground.json'),
  JSON.stringify({
    note: 'Made by prepare.mjs from the Copernicus DEM GLO-30 and its water body mask; produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.',
    centre: [CENTRE.lon, CENTRE.lat],
    box: [box[0], box[1], box[2], box[3]],
    cell: CELL,
    cols,
    rows,
    sea,
    sources,
  }) + '\n',
);
console.log(`heights ${cols} x ${rows}, sea ${sea.length} rings, ${sea.reduce((n, r) => n + r.length, 0)} points (${sea.map((r) => r.length).join(', ')})`);
