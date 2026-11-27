// Relief: a field of heights drawn as the light falls on it, worked out at every pixel of the frame it covers.
//
// A grid of heights (a digital elevation model) is shaded once: at each point of the grid, how much more or less
// light its slope takes than flat ground does (hill shading, light from one side and from above). On every frame the
// pixels the field covers are walked one by one: each is taken back into the field through the transform the field is
// drawn with (a perspective of a plane included), and its shade, and its height for a tint, are read off the grid
// between its points along smooth curves (Catmull-Rom). So the relief has no pixels of its own: however near the
// camera comes, it is as smooth as the grid's curves, and it is the same on the CPU and on the GPU.
//
// The colours are the scene's: what the shade turns toward on the dark side and on the lit side, and, given, the
// tints of the ground by height. Without tints only the shading is drawn, over what lies under it.
//
// A relief that is the ground of its plane (a group with `ground`) is drawn raised: its hills stand up as the camera of
// the layer sees them. Each pixel is then a ray from the camera through the plane, walked down from the highest the
// ground reaches until it meets the ground; the shade and the tint are those of the point it meets.

import { Canvas, ImageData, type CanvasRenderingContext2D, type DOMMatrix } from 'skia-canvas';
import { parseHex } from '../look/color.ts';
import type { ShapeItem } from '../scene/evaluate.ts';
import { curveWeights as weights, fadeAt } from '../scene/ground.ts';
import type { ReliefSpec, ShapeNode } from '../scene/types.ts';
import { planeCanvas } from './plane.ts';

/** The shading of a grid, made once per field and per direction of the light in its own space. */
interface Shading {
  readonly key: string;
  /** -1 (as dark as it gets) .. 0 (flat ground) .. 1 (as lit as it gets), at each point of the grid. */
  readonly shade: Float32Array;
}

const shadings = new WeakMap<ReliefSpec, Shading>();

interface ReliefRaster {
  readonly image: ImageData;
  readonly samplePixels: number;
  readonly x: number;
  readonly y: number;
  readonly clip: boolean;
}

interface RasterEntry {
  readonly key: readonly (number | string)[];
  seen: boolean;
  raster?: ReliefRaster;
}

// Two full 4K fields, plus room for modest pass padding. Entries hold pixels only, since a live native canvas can
// affect GPU readback in later frames. The LRU also keeps no strong reference to a compiled node or its height grid.
const RASTER_LIMIT = 80 * 1024 * 1024;
const RASTER_COUNT = 32;
const rasterByNode = new WeakMap<ShapeItem['node'], RasterEntry>();
const recentRasters = new Set<RasterEntry>();
let rasterBytes = 0;

function rasterEntry(node: ShapeItem['node'], key: RasterEntry['key']): RasterEntry {
  const hit = rasterByNode.get(node);
  if (hit && hit.key.length === key.length && key.every((v, i) => Object.is(v, hit.key[i]))) return hit;
  if (hit?.raster) dropRaster(hit);
  const entry = { key, seen: false };
  rasterByNode.set(node, entry);
  return entry;
}

function dropRaster(entry: RasterEntry): void {
  rasterBytes -= entry.raster!.image.data.byteLength;
  delete entry.raster;
  recentRasters.delete(entry);
}

function rememberRaster(entry: RasterEntry, raster: ReliefRaster): void {
  // A field whose view changes every frame never retains its preceding frame's pixels.
  if (!entry.seen) {
    entry.seen = true;
    return;
  }
  const size = raster.image.data.byteLength;
  if (size > RASTER_LIMIT) return;
  while (rasterBytes + size > RASTER_LIMIT || recentRasters.size >= RASTER_COUNT) dropRaster(recentRasters.values().next().value!);
  entry.raster = raster;
  recentRasters.add(entry);
  rasterBytes += size;
}

/** Composites the raster through the supplied context, including its current clip and blend state. */
function paintRaster(raw: CanvasRenderingContext2D, m: DOMMatrix, x: number, y: number, w: number, h: number, raster: ReliefRaster): void {
  const picture = new Canvas(raster.image.width, raster.image.height);
  try {
    picture.getContext('2d').putImageData(raster.image, 0, 0);
    raw.save();
    // The outline of a flat field keeps its edge smooth where it shows.
    raw.setTransform(m);
    raw.beginPath();
    raw.rect(x, y, w, h);
    if (raster.clip) raw.clip();
    raw.setTransform(1, 0, 0, 1, 0, 0);
    const s = raster.samplePixels;
    if (s === 1) raw.drawCanvas(picture, raster.x, raster.y);
    else {
      raw.imageSmoothingEnabled = true;
      raw.drawCanvas(picture, raster.x * s, raster.y * s, raster.image.width * s, raster.image.height * s);
    }
    raw.restore();
  } finally {
    picture.dispose();
  }
}

/**
 * The shading of a field: the normal of the ground at each point of the grid (central differences, in units of the
 * scene), against the light. `from` is where the light comes from in the field's own space, in radians (0: from its
 * right, -pi/2: from its top), `high` how high, in radians over the ground.
 */
function shadingOf(spec: ReliefSpec, w: number, h: number, from: number, high: number): Shading {
  const key = `${w},${h},${from},${high}`;
  const hit = shadings.get(spec);
  if (hit && hit.key === key) return hit;
  const { cols, rows, heights, vertical } = spec;
  const dx = w / (cols - 1);
  const dy = h / (rows - 1);
  const lx = Math.cos(from) * Math.cos(high);
  const ly = Math.sin(from) * Math.cos(high);
  const lz = Math.sin(high);
  const shade = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const r0 = Math.max(0, r - 1);
    const r1 = Math.min(rows - 1, r + 1);
    for (let c = 0; c < cols; c++) {
      const c0 = Math.max(0, c - 1);
      const c1 = Math.min(cols - 1, c + 1);
      // The slope of the ground along x and along y, in units of height per unit of the scene.
      const sx = ((heights[r * cols + c1]! - heights[r * cols + c0]!) * vertical) / ((c1 - c0) * dx);
      const sy = ((heights[r1 * cols + c]! - heights[r0 * cols + c]!) * vertical) / ((r1 - r0) * dy);
      // Up is out of the ground: the normal is (-sx, -sy, 1), and y of the field runs down the map.
      const n = Math.hypot(sx, sy, 1);
      const lit = (-sx * lx - sy * ly + lz) / n;
      shade[r * cols + c] = lit >= lz ? (lit - lz) / Math.max(1e-6, 1 - lz) : (lit - lz) / Math.max(1e-6, lz);
    }
  }
  const made = { key, shade };
  shadings.set(spec, made);
  return made;
}

/** The highest a raised ground is drawn, as a share of the camera's height over the plane: as for a body's rise. */
const RAISE_NEAR = 0.9;

/** How far apart the steps of a ray are taken, across the ground, in cells of its grid. */
const RAY_STEP = 0.5;

/** The side of a block of the grid, in cells: a ray skips a stretch over blocks that are all lower than it is. */
const BLOCK = 4;

/** The highest point of each block of BLOCK x BLOCK cells of a grid (its edge points included), row by row. */
interface Blocks {
  readonly across: number;
  readonly down: number;
  readonly most: Float32Array;
}

const blockings = new WeakMap<ReliefSpec, Blocks>();

function blocksOf(spec: ReliefSpec): Blocks {
  const hit = blockings.get(spec);
  if (hit) return hit;
  const { cols, rows, heights } = spec;
  const across = Math.ceil((cols - 1) / BLOCK);
  const down = Math.ceil((rows - 1) / BLOCK);
  const most = new Float32Array(across * down).fill(-Infinity);
  for (let r = 0; r < rows; r++) {
    // A point on the edge between two blocks belongs to both.
    const b0 = Math.min(down - 1, Math.floor(r / BLOCK));
    const b1 = r % BLOCK === 0 && r > 0 ? b0 - 1 : b0;
    for (let c = 0; c < cols; c++) {
      const a0 = Math.min(across - 1, Math.floor(c / BLOCK));
      const a1 = c % BLOCK === 0 && c > 0 ? a0 - 1 : a0;
      const v = heights[r * cols + c]!;
      for (const b of [b0, b1]) for (const a of [a0, a1]) if (v > most[b * across + a]!) most[b * across + a] = v;
    }
  }
  const made = { across, down, most };
  blockings.set(spec, made);
  return made;
}

/** The height of a grid at a place of it, in points of it, between its four nearest points; -Infinity outside it. */
function nearHeight(heights: Float32Array, cols: number, rows: number, gx: number, gy: number): number {
  if (!(gx >= 0 && gy >= 0 && gx <= cols - 1 && gy <= rows - 1)) return -Infinity;
  const c0 = Math.min(cols - 2, Math.floor(gx));
  const r0 = Math.min(rows - 2, Math.floor(gy));
  const tx = gx - c0;
  const ty = gy - r0;
  const at = r0 * cols + c0;
  const top = heights[at]! + (heights[at + 1]! - heights[at]!) * tx;
  const low = heights[at + cols]! + (heights[at + cols + 1]! - heights[at + cols]!) * tx;
  return top + (low - top) * ty;
}

/** A raised ground as one ray of it sees it: its grid, and where the camera stands over it (field units). */
interface Ray {
  heights: Float32Array;
  cols: number;
  rows: number;
  /** From the field's units to points of the grid: g = (p - x0) * sx. */
  x0: number;
  y0: number;
  sx: number;
  sy: number;
  vertical: number;
  /** Where the camera stands over the field and how high, and the highest the ground is drawn. */
  s0: number;
  s1: number;
  eye: number;
  top: number;
  /** The heights the ground spans, and a step across it, in its units. */
  zLo: number;
  zHi: number;
  step: number;
  blocks: Blocks;
}

/** The highest the ground stands (field units) in the blocks a stretch of a ray crosses, from grid point (ga, ha) to (gb, hb). */
function stretchTop(r: Ray, ga: number, ha: number, gb: number, hb: number): number {
  const { across, down, most } = r.blocks;
  const a0 = Math.max(0, Math.min(across - 1, Math.floor(Math.min(ga, gb) / BLOCK)));
  const a1 = Math.max(0, Math.min(across - 1, Math.floor(Math.max(ga, gb) / BLOCK)));
  const b0 = Math.max(0, Math.min(down - 1, Math.floor(Math.min(ha, hb) / BLOCK)));
  const b1 = Math.max(0, Math.min(down - 1, Math.floor(Math.max(ha, hb) / BLOCK)));
  let top = -Infinity;
  for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) top = Math.max(top, most[b * across + a]!);
  return top * r.vertical;
}

/** The ground's height (field units, held under the top) where the ray through (qx, qy) from the point the camera stands over is at height z. */
function rayGround(r: Ray, qx: number, qy: number, z: number): number {
  const t = 1 - z / r.eye;
  return Math.min(nearHeight(r.heights, r.cols, r.rows, (r.s0 + qx * t - r.x0) * r.sx, (r.s1 + qy * t - r.y0) * r.sy) * r.vertical, r.top);
}

/**
 * The height at which the ray through the point (qx, qy) of the plane (from the point the camera stands over) first
 * meets the ground, walked down from the highest the ground reaches; NaN when it misses it. Only the heights at which
 * the ray is over the field are walked.
 */
function meet(r: Ray, qx: number, qy: number): number {
  // The ray is over the point s + q (1 - z / H): over the field between two heights, as the field spans it.
  let zTop = r.zHi;
  let zBottom = r.zLo;
  const ends: [number, number, number][] = [
    [qx, r.x0 - r.s0, r.x0 + (r.cols - 1) / r.sx - r.s0],
    [qy, r.y0 - r.s1, r.y0 + (r.rows - 1) / r.sy - r.s1],
  ];
  for (const [q, lo, hi] of ends) {
    if (Math.abs(q) < 1e-12) {
      if (lo > 0 || hi < 0) return Number.NaN;
      continue;
    }
    // 1 - z / H between lo / q and hi / q, so z between H (1 - hi / q) and H (1 - lo / q), the order by the sign of q.
    const za = r.eye * (1 - hi / q);
    const zb = r.eye * (1 - lo / q);
    zTop = Math.min(zTop, Math.max(za, zb));
    zBottom = Math.max(zBottom, Math.min(za, zb));
  }
  if (!(zTop >= zBottom)) return Number.NaN;
  // Stretches BLOCK cells long across the ground: one over blocks all lower than its lower end is skipped whole; in
  // the others the ray is walked in steps.
  const across = Math.hypot(qx, qy) / r.eye;
  const span = zTop - zBottom;
  const stretches = Math.min(4096, Math.max(1, Math.ceil((across * span) / (r.step * (BLOCK / RAY_STEP)))));
  const dzStretch = span / stretches;
  const fine = Math.max(1, Math.ceil(BLOCK / RAY_STEP));
  const dz = dzStretch / fine;
  for (let k = 0; k < stretches; k++) {
    const za = zTop - k * dzStretch;
    const zb = za - dzStretch;
    const ta = 1 - za / r.eye;
    const tb = 1 - zb / r.eye;
    const top = stretchTop(r, (r.s0 + qx * ta - r.x0) * r.sx, (r.s1 + qy * ta - r.y0) * r.sy, (r.s0 + qx * tb - r.x0) * r.sx, (r.s1 + qy * tb - r.y0) * r.sy);
    if (Math.min(top, r.top) < zb) continue;
    let hi = za + dz;
    for (let j = 0; j <= fine; j++) {
      const z = za - j * dz;
      if (rayGround(r, qx, qy, z) < z) {
        hi = z;
        continue;
      }
      let lo = z;
      for (let n = 0; n < 6; n++) {
        const mid = (lo + hi) / 2;
        if (rayGround(r, qx, qy, mid) >= mid) lo = mid;
        else hi = mid;
      }
      return lo;
    }
  }
  return Number.NaN;
}

/** The side of a tile of pixels, of which a raised ground walks the rays of the corners and the middle first. */
const TILE = 4;

/** How far the middle of a tile may lie from what its corners give it, in cells of the grid, for the tile to be filled from its corners. */
const TILE_TRUE = 0.2;

/**
 * Where on the grid (in points of it) each pixel of a band of TILE rows of a raised ground shows the ground, NaN where
 * it shows none. The rays of the corners of each tile and of its middle are walked; where the middle lies where its
 * corners put it (no hill's edge crosses the tile), the tile is filled between its corners, and otherwise every pixel
 * of it walks its own ray. `top` and `low` hold the corners of the band's upper and lower edge, `low` filled here.
 */
function band(
  hit: (X: number, Y: number, out: Float64Array, k: number) => void,
  bx0: number,
  Y0: number,
  bw: number,
  rows: number,
  top: Float64Array,
  low: Float64Array,
  outX: Float32Array,
  outY: Float32Array,
): void {
  const tiles = Math.ceil(bw / TILE);
  for (let i = 0; i <= tiles; i++) hit(bx0 + i * TILE + 0.5, Y0 + TILE + 0.5, low, i);
  const mid = new Float64Array(2);
  const one = new Float64Array(2);
  for (let i = 0; i < tiles; i++) {
    const [ax, ay, bx, by] = [top[2 * i]!, top[2 * i + 1]!, top[2 * i + 2]!, top[2 * i + 3]!];
    const [cx, cy, dx, dy] = [low[2 * i]!, low[2 * i + 1]!, low[2 * i + 2]!, low[2 * i + 3]!];
    let smooth = !Number.isNaN(ax) && !Number.isNaN(bx) && !Number.isNaN(cx) && !Number.isNaN(dx);
    if (smooth) {
      hit(bx0 + i * TILE + TILE / 2 + 0.5, Y0 + TILE / 2 + 0.5, mid, 0);
      smooth = !Number.isNaN(mid[0]!) && Math.hypot(mid[0]! - (ax + bx + cx + dx) / 4, mid[1]! - (ay + by + cy + dy) / 4) <= TILE_TRUE;
    }
    for (let r = 0; r < rows; r++) {
      const v = r / TILE;
      for (let c = 0; c < TILE; c++) {
        const px = i * TILE + c;
        if (px >= bw) break;
        const o = r * bw + px;
        if (smooth) {
          const u = c / TILE;
          outX[o] = (ax * (1 - u) + bx * u) * (1 - v) + (cx * (1 - u) + dx * u) * v;
          outY[o] = (ay * (1 - u) + by * u) * (1 - v) + (cy * (1 - u) + dy * u) * v;
        } else {
          hit(bx0 + px + 0.5, Y0 + r + 0.5, one, 0);
          outX[o] = one[0]!;
          outY[o] = one[1]!;
        }
      }
    }
  }
}

/** Colours as 0..255 numbers. */
type Rgb = readonly [number, number, number];

function rgbOf(hex: string): Rgb {
  const c = parseHex(hex);
  return [c.r, c.g, c.b];
}

/** The tint of the ground at a height: between the two stops around it, the ends held. */
function tintAt(stops: readonly { at: number; rgb: Rgb }[], z: number, out: number[]): void {
  if (z <= stops[0]!.at) {
    out[0] = stops[0]!.rgb[0];
    out[1] = stops[0]!.rgb[1];
    out[2] = stops[0]!.rgb[2];
    return;
  }
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i]!;
    if (z <= b.at) {
      const a = stops[i - 1]!;
      const t = (z - a.at) / Math.max(1e-9, b.at - a.at);
      out[0] = a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t;
      out[1] = a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t;
      out[2] = a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t;
      return;
    }
  }
  const last = stops[stops.length - 1]!;
  out[0] = last.rgb[0];
  out[1] = last.rgb[1];
  out[2] = last.rgb[2];
}

/** The picture of a field (picture): made once per field, size, light and colours, and kept as pixels alone. */
const pictures = new WeakMap<ReliefSpec, { readonly key: string; readonly image: ImageData }>();

/**
 * The shading of a field made into a picture, `picture` pixels to a cell of its grid, each pixel on a point of the grid
 * or between them: its shade and its height read off the grid along the same curves the field is drawn with pixel by
 * pixel, tinted, shaded and feathered as there.
 */
function pictureOf(spec: ReliefSpec, fw: number, fh: number, from: number, darkHex: string, brightHex: string, tintHexes: readonly string[]): ImageData {
  const key = [fw, fh, from, darkHex, brightHex, ...tintHexes].join(',');
  const hit = pictures.get(spec);
  if (hit && hit.key === key) return hit.image;
  const k = spec.picture!;
  const { cols, rows, heights, amount } = spec;
  const { shade } = shadingOf(spec, fw, fh, from, (spec.high * Math.PI) / 180);
  const dark = rgbOf(darkHex);
  const bright = rgbOf(brightHex);
  const stops = spec.tints?.map((t, n) => ({ at: t[0], rgb: rgbOf(tintHexes[n]!) })) ?? null;
  const feather = spec.feather ?? 0;
  const w = (cols - 1) * k + 1;
  const h = (rows - 1) * k + 1;
  const data = new Uint8ClampedArray(w * h * 4);
  const wx = new Float64Array(4);
  const wy = new Float64Array(4);
  const tint = [0, 0, 0];
  for (let py = 0; py < h; py++) {
    const gy = py / k;
    const r0 = Math.min(rows - 2, Math.floor(gy));
    weights(gy - r0, wy);
    for (let px = 0; px < w; px++) {
      const gx = px / k;
      const shown = feather > 0 ? fadeAt((gx * fw) / (cols - 1), (gy * fh) / (rows - 1), 0, 0, fw, fh, feather) : 1;
      if (!(shown > 0)) continue;
      const c0 = Math.min(cols - 2, Math.floor(gx));
      weights(gx - c0, wx);
      let s = 0;
      let z = 0;
      for (let j = 0; j < 4; j++) {
        const r = Math.max(0, Math.min(rows - 1, r0 - 1 + j)) * cols;
        let rs = 0;
        let rz = 0;
        for (let n = 0; n < 4; n++) {
          const at = r + Math.max(0, Math.min(cols - 1, c0 - 1 + n));
          rs += wx[n]! * shade[at]!;
          if (stops) rz += wx[n]! * heights[at]!;
        }
        s += wy[j]! * rs;
        z += wy[j]! * rz;
      }
      s = Math.max(-1, Math.min(1, s)) * amount;
      const o = (py * w + px) * 4;
      const to = s < 0 ? dark : bright;
      const t = Math.abs(s);
      if (stops) {
        tintAt(stops, z, tint);
        data[o] = tint[0]! + (to[0] - tint[0]!) * t;
        data[o + 1] = tint[1]! + (to[1] - tint[1]!) * t;
        data[o + 2] = tint[2]! + (to[2] - tint[2]!) * t;
        data[o + 3] = 255 * shown;
      } else {
        data[o] = to[0];
        data[o + 1] = to[1];
        data[o + 2] = to[2];
        data[o + 3] = t * 255 * shown;
      }
    }
  }
  // Premultiplied by the canvas when it is drawn: the colour of a pixel with no alpha is never seen.
  const image = new ImageData(data, w, h);
  pictures.set(spec, { key, image });
  return image;
}

/**
 * Draws a field of heights (a rect with relief) where it lies, through the transform of `ctx`: every pixel of the
 * canvas the field covers, worked out by itself. `tone` gives the colour of a palette hex as the layer paints it.
 */
export function drawRelief(ctx: CanvasRenderingContext2D, item: ShapeItem, tone: (hex: string) => string): void {
  const node = item.node.node as ShapeNode;
  const spec = node.relief!;
  const shape = node.shape;
  if (shape.kind !== 'polygon') return;
  // The field spans the rect: its corners are the outer points of the shape.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of shape.points) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  const fw = x1 - x0;
  const fh = y1 - y0;
  if (!(fw > 0 && fh > 0)) return;
  const raw = planeCanvas(ctx)?.raw ?? ctx;
  const { xf } = item;
  // From the field's own space to the pixels of the canvas.
  const m = ctx.getTransform().translate(xf.x, xf.y).rotate((xf.rot * 180) / Math.PI).scale(xf.scale, xf.scale);
  const samplePixels = spec.samplePixels ?? 1;
  const width = Math.ceil(raw.canvas.width / samplePixels);
  const height = Math.ceil(raw.canvas.height / samplePixels);

  const { cols, rows, heights } = spec;
  const raise = item.raise;
  // Divide the projected screen coordinates; the homogeneous denominator and the ground's world coordinates stay intact.
  const [a, b, c, d, e, f, g, hh, i] = [m.m11 / samplePixels, m.m12 / samplePixels, m.m21 / samplePixels, m.m22 / samplePixels, m.m41 / samplePixels, m.m42 / samplePixels, m.m14, m.m24, m.m44];
  const colors = item.node.colors;
  const darkHex = tone(colors['relief.dark']!);
  const brightHex = tone(colors['relief.bright']!);
  const tintHexes = spec.tints?.map((_, k) => tone(colors[`relief.tint${k}`]!)) ?? [];
  if (spec.picture) {
    // Shaded once into a picture of the field, drawn as one image through its transform.
    const from = (spec.from * Math.PI) / 180 - xf.rot;
    const image = pictureOf(spec, fw, fh, from, darkHex, brightHex, tintHexes);
    // The pixels of the picture stand on the points of the grid: it reaches half a pixel past the field, which it is cut to.
    const px = fw / (image.width - 1);
    const py = fh / (image.height - 1);
    raw.save();
    raw.setTransform(m);
    raw.beginPath();
    raw.rect(x0, y0, fw, fh);
    raw.clip();
    raw.imageSmoothingEnabled = true;
    raw.imageSmoothingQuality = 'high';
    raw.drawImage(image, x0 - px / 2, y0 - py / 2, fw + px, fh + py);
    raw.restore();
    return;
  }
  const key = [width, height, a, b, c, d, e, f, g, hh, i, xf.rot, ...(raise ?? []), darkHex, brightHex, ...tintHexes];
  const entry = rasterEntry(item.node, key);
  if (entry.raster) {
    recentRasters.delete(entry);
    recentRasters.add(entry);
    paintRaster(raw, m, x0, y0, fw, fh, entry.raster);
    return;
  }

  // A raised ground: where the camera stands over it and how high (in the field's own units), and the heights it spans.
  let zLo = 0;
  let zHi = 0;
  if (raise) {
    zLo = Infinity;
    zHi = -Infinity;
    for (const v of heights) {
      zLo = Math.min(zLo, v * spec.vertical);
      zHi = Math.max(zHi, v * spec.vertical);
    }
    zHi = Math.min(zHi, RAISE_NEAR * raise[2]);
    zLo = Math.min(zLo, zHi);
  }

  // The pixels the field may cover: around its corners, or the whole canvas when a corner lies behind the camera. A
  // raised ground also covers its corners as high and as low as it reaches, drawn larger or smaller about the camera.
  let bx0 = 0;
  let by0 = 0;
  let bx1 = width;
  let by1 = height;
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  if (raise) {
    for (const z of [zLo, zHi]) {
      const k = raise[2] / (raise[2] - z);
      for (const [x, y] of corners.slice(0, 4)) corners.push([raise[0] + (x - raise[0]) * k, raise[1] + (y - raise[1]) * k]);
    }
  }
  let behind = false;
  let cx0 = Infinity;
  let cy0 = Infinity;
  let cx1 = -Infinity;
  let cy1 = -Infinity;
  for (const [x, y] of corners) {
    const w = g * x + hh * y + i;
    if (!(w > 1e-6)) {
      behind = true;
      break;
    }
    const X = (a * x + c * y + e) / w;
    const Y = (b * x + d * y + f) / w;
    cx0 = Math.min(cx0, X);
    cy0 = Math.min(cy0, Y);
    cx1 = Math.max(cx1, X);
    cy1 = Math.max(cy1, Y);
  }
  if (!behind) {
    bx0 = Math.max(0, Math.floor(cx0) - 1);
    by0 = Math.max(0, Math.floor(cy0) - 1);
    bx1 = Math.min(width, Math.ceil(cx1) + 1);
    by1 = Math.min(height, Math.ceil(cy1) + 1);
  }
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  if (bw <= 0 || bh <= 0) return;

  // From a pixel back into the field: the inverse of the 3 x 3 of m.
  const det = a * (d * i - f * hh) - c * (b * i - f * g) + e * (b * hh - d * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return;
  const ia = (d * i - f * hh) / det;
  const ic = -(c * i - e * hh) / det;
  const ie = (c * f - e * d) / det;
  const ib = -(b * i - f * g) / det;
  const id = (a * i - e * g) / det;
  const if_ = -(a * f - e * b) / det;
  const ig = (b * hh - d * g) / det;
  const ih = -(a * hh - c * g) / det;
  const ii = (a * d - c * b) / det;

  // The light in the field's own space: it comes from where the scene says on the map, the field turned with it.
  const from = (spec.from * Math.PI) / 180 - xf.rot;
  const { shade } = shadingOf(spec, fw, fh, from, (spec.high * Math.PI) / 180);
  const dark = rgbOf(darkHex);
  const bright = rgbOf(brightHex);
  const stops = spec.tints?.map((t, k) => ({ at: t[0], rgb: rgbOf(tintHexes[k]!) })) ?? null;
  const amount = spec.amount;
  const sx = (cols - 1) / fw;
  const sy = (rows - 1) / fh;
  const feather = spec.feather ?? 0;
  // A raised ground: its rays are walked in steps a share of a cell of the grid apart, across it.
  const ray: Ray | null = raise
    ? { heights, cols, rows, x0, y0, sx, sy, vertical: spec.vertical, s0: raise[0], s1: raise[1], eye: raise[2], top: RAISE_NEAR * raise[2], zLo, zHi, step: RAY_STEP * Math.min(fw / (cols - 1), fh / (rows - 1)), blocks: blocksOf(spec) }
    : null;

  const data = new Uint8ClampedArray(bw * bh * 4);
  const wx = new Float64Array(4);
  const wy = new Float64Array(4);
  const tint = [0, 0, 0];
  // A raised ground: the point of the grid each pixel shows, found a band of rows at a time.
  const hit = (X: number, Y: number, out: Float64Array, k: number): void => {
    out[2 * k] = Number.NaN;
    out[2 * k + 1] = Number.NaN;
    const w = ig * X + ih * Y + ii;
    if (!ray || !(w > 0)) return;
    // The ray from the camera through this point q of the plane: at a height z it is over the point
    // s + (q - s) (1 - z / H). The pixel shows the point where it first meets the ground.
    const qx = (ia * X + ic * Y + ie) / w - ray.s0;
    const qy = (ib * X + id * Y + if_) / w - ray.s1;
    const z = meet(ray, qx, qy);
    if (Number.isNaN(z)) return;
    const t = 1 - z / ray.eye;
    out[2 * k] = (ray.s0 + qx * t - x0) * sx;
    out[2 * k + 1] = (ray.s1 + qy * t - y0) * sy;
  };
  const corners0 = ray ? new Float64Array(2 * (Math.ceil(bw / TILE) + 1)) : null;
  const corners1 = ray ? new Float64Array(2 * (Math.ceil(bw / TILE) + 1)) : null;
  const shownX = ray ? new Float32Array(bw * TILE) : null;
  const shownY = ray ? new Float32Array(bw * TILE) : null;
  let [upper, lower] = [corners0, corners1];
  if (upper) for (let i = 0; i <= Math.ceil(bw / TILE); i++) hit(bx0 + i * TILE + 0.5, by0 + 0.5, upper, i);
  for (let py = 0; py < bh; py++) {
    const Y = by0 + py + 0.5;
    if (ray && py % TILE === 0) {
      band(hit, bx0, by0 + py, bw, Math.min(TILE, bh - py), upper!, lower!, shownX!, shownY!);
      [upper, lower] = [lower, upper];
    }
    for (let px = 0; px < bw; px++) {
      const X = bx0 + px + 0.5;
      let gx: number;
      let gy: number;
      if (ray) {
        gx = shownX![(py % TILE) * bw + px]!;
        gy = shownY![(py % TILE) * bw + px]!;
        if (Number.isNaN(gx)) continue;
      } else {
        const w = ig * X + ih * Y + ii;
        if (!(w > 0)) continue;
        // Where the pixel lies on the grid, in points of it.
        gx = (((ia * X + ic * Y + ie) / w - x0) * sx);
        gy = (((ib * X + id * Y + if_) / w - y0) * sy);
      }
      if (!(gx >= 0 && gy >= 0 && gx <= cols - 1 && gy <= rows - 1)) continue;
      const shown = feather > 0 ? fadeAt(x0 + gx / sx, y0 + gy / sy, x0, y0, x1, y1, feather) : 1;
      if (!(shown > 0)) continue;
      const c0 = Math.min(cols - 2, Math.floor(gx));
      const r0 = Math.min(rows - 2, Math.floor(gy));
      weights(gx - c0, wx);
      weights(gy - r0, wy);
      let s = 0;
      let z = 0;
      for (let j = 0; j < 4; j++) {
        const r = Math.max(0, Math.min(rows - 1, r0 - 1 + j)) * cols;
        let rs = 0;
        let rz = 0;
        for (let k = 0; k < 4; k++) {
          const at = r + Math.max(0, Math.min(cols - 1, c0 - 1 + k));
          rs += wx[k]! * shade[at]!;
          if (stops) rz += wx[k]! * heights[at]!;
        }
        s += wy[j]! * rs;
        z += wy[j]! * rz;
      }
      s = Math.max(-1, Math.min(1, s)) * amount;
      const o = (py * bw + px) * 4;
      if (stops) {
        // The tint of its height, turned toward the dark or the lit tone by its shade.
        tintAt(stops, z, tint);
        const to = s < 0 ? dark : bright;
        const t = Math.abs(s);
        data[o] = tint[0]! + (to[0] - tint[0]!) * t;
        data[o + 1] = tint[1]! + (to[1] - tint[1]!) * t;
        data[o + 2] = tint[2]! + (to[2] - tint[2]!) * t;
        data[o + 3] = 255 * shown;
      } else {
        // The shading alone: the dark or the lit tone, as strong as the shade, over what lies under it.
        const to = s < 0 ? dark : bright;
        data[o] = to[0];
        data[o + 1] = to[1];
        data[o + 2] = to[2];
        data[o + 3] = Math.abs(s) * 255 * shown;
      }
    }
  }
  const made = { image: new ImageData(data, bw, bh), x: bx0, y: by0, samplePixels, clip: !behind && !ray };
  paintRaster(raw, m, x0, y0, fw, fh, made);
  rememberRaster(entry, made);
}
