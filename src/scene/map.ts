// The dressings of a map: water as a lit body, woods, trees standing alone, a texture of the ground, fields,
// houses, a road of logs and a locator inset, each made of the nodes of the scene API, and the geometry that places
// them. They draw the outlines a scene gives them (on the stage, as a map pipeline fits its layers to it) in the
// colours the scene names, and hold none of their own. What they scatter comes from seeded streams of `Rng`, so the
// same options give the same nodes at every frame and in every run.

import { DEG, type Vec2 } from '../core/math.ts';
import { Rng } from '../core/rng.ts';
import type { ColorRef } from '../look/palette.ts';
import { capsule, checkKeys, circle, fail, group, num, rect, region, stroke, vec } from './build.ts';
import type { SceneNode } from './types.ts';

/** A closed outline on the stage, without its first point repeated. */
type Ring = readonly Vec2[];
type Rings = readonly Ring[];
/** A box on the stage: [x0, y0, x1, y1]. */
type Box = readonly [number, number, number, number];
type Seed = number | string;

/** Most places a dressing may try: a step this small for its area is a mistake, and would make a picture no frame can draw. */
const MAX_CELLS = 400_000;

/** A coordinate to a tenth of a unit, and never -0. */
const tenth = (v: number): number => Math.round(v * 10) / 10 + 0;

// ---------------------------------------------------------------- checking the options

function rings(where: string, name: string, value: unknown, least = 3): Rings {
  if (!Array.isArray(value)) fail(where, `${name} must be a list of outlines, each a list of [x, y]`);
  value.forEach((ring, k) => points(where, `${name}[${k}]`, ring, least));
  return value as Rings;
}

function points(where: string, name: string, value: unknown, least: number): Ring {
  if (!Array.isArray(value) || value.length < least) fail(where, `${name} must be a list of at least ${least} points [x, y]`);
  value.forEach((p, i) => vec(where, `${name}[${i}]`, p));
  return value as Ring;
}

function seedOf(where: string, value: unknown): Seed {
  if (!(typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))) fail(where, `seed must be a number or a string, got ${JSON.stringify(value)}`);
  return value;
}

/** A palette reference or a list of them, as a list. */
function colourOrList(where: string, name: string, value: unknown): readonly ColorRef[] {
  if (typeof value === 'string') return [value as ColorRef];
  return colours(where, name, value);
}

function flagOf(where: string, name: string, value: unknown): boolean {
  if (typeof value !== 'boolean') fail(where, `${name} must be true or false, got ${JSON.stringify(value)}`);
  return value;
}

function colours(where: string, name: string, value: unknown): readonly ColorRef[] {
  if (!Array.isArray(value) || value.length === 0) fail(where, `${name} must be a list of at least one palette reference`);
  return value as readonly ColorRef[];
}

function boxOf(where: string, name: string, value: unknown): Box {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((v) => typeof v === 'number' && Number.isFinite(v)) || value[2] <= value[0] || value[3] <= value[1]) {
    fail(where, `${name} must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0, got ${JSON.stringify(value)}`);
  }
  return value as unknown as Box;
}

function fn<T>(where: string, name: string, value: unknown): T | undefined {
  if (value !== undefined && typeof value !== 'function') fail(where, `${name} must be a function`);
  return value as T | undefined;
}

// ---------------------------------------------------------------- geometry

/** Whether a point lies inside a closed outline (even-odd: a ring that winds round twice holds nothing there). */
export function inside(p: Vec2, ring: Ring): boolean {
  const [x, y] = p;
  let n = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) n = !n;
  }
  return n;
}

/** The distance from a point to the nearest edge of a set of closed outlines, in units of the stage. */
export function distTo(p: Vec2, outlines: Rings): number {
  const [x, y] = p;
  let d = Infinity;
  for (const ring of outlines) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j]!;
      const [bx, by] = ring[i]!;
      const [dx, dy] = [bx - ax, by - ay];
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      d = Math.min(d, Math.hypot(x - ax - dx * t, y - ay - dy * t));
    }
  }
  return d;
}

/** The outline of an oval round [0, 0], `n` points: `rx` across and `ry` down, turned `turn` degrees. */
export function oval(rx: number, ry: number, turn = 0, n = 40): Vec2[] {
  const where = 'oval';
  num(where, 'rx', rx, 0, 1e6);
  num(where, 'ry', ry, 0, 1e6);
  num(where, 'turn', turn, -3600, 3600);
  if (!Number.isInteger(n) || n < 3 || n > 600) fail(where, `n must be a whole number in 3..600, got ${JSON.stringify(n)}`);
  const t = turn * DEG;
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const [x, y] = [Math.cos(a) * rx, Math.sin(a) * ry];
    return [tenth(x * Math.cos(t) - y * Math.sin(t)), tenth(x * Math.sin(t) + y * Math.cos(t))] as Vec2;
  });
}

/** A smooth line through `points` (a Catmull-Rom spline through each of them), as points about `step` apart. */
export function smoothLine(line: readonly Vec2[], step: number): Vec2[] {
  const where = 'smoothLine';
  points(where, 'points', line, 2);
  num(where, 'step', step, 1e-3, 1e6);
  const out: Vec2[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const [p0, p1, p2, p3] = [line[Math.max(0, i - 1)]!, line[i]!, line[i + 1]!, line[Math.min(line.length - 1, i + 2)]!];
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    if (out.length + n > MAX_CELLS) fail(where, `a step of ${step} makes more than ${MAX_CELLS} points of this line`);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const f = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
      out.push([tenth(f(p0[0], p1[0], p2[0], p3[0])), tenth(f(p0[1], p1[1], p2[1], p3[1]))]);
    }
  }
  const last = line[line.length - 1]!;
  out.push([last[0], last[1]]);
  return out;
}

/** A place of a lattice, with its row and column. */
interface Cell {
  at: Vec2;
  row: number;
  col: number;
}

/**
 * The places of a lattice turned `turn` degrees, `step` by `step * aspect` apart, each moved by up to `jitter` of a
 * step at random, inside `within` and out of every outline of `avoid`; over `bounds` alone when they are given.
 */
function lattice(where: string, o: { within: Ring; avoid: Rings; step: number; aspect: number; turn: number; jitter: number; rng: Rng; bounds?: Box }): Cell[] {
  const t = o.turn * DEG;
  const [c, s] = [Math.cos(t), Math.sin(t)];
  const [sx, sy] = [o.step, o.step * o.aspect];
  const us = o.within.map(([x, y]) => x * c + y * s);
  const vs = o.within.map(([x, y]) => -x * s + y * c);
  let [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
  const b = o.bounds;
  if (b) {
    // Only the part of the lattice over the bounds: their corners in the lattice's own axes.
    const corners = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]] as const;
    const bu = corners.map(([x, y]) => x * c + y * s);
    const bv = corners.map(([x, y]) => -x * s + y * c);
    [u0, u1, v0, v1] = [Math.max(u0, Math.min(...bu)), Math.min(u1, Math.max(...bu)), Math.max(v0, Math.min(...bv)), Math.min(v1, Math.max(...bv))];
  }
  if (u1 < u0 || v1 < v0) return [];
  const count = (Math.floor((u1 - u0) / sx) + 1) * (Math.floor((v1 - v0) / sy) + 1);
  if (count > MAX_CELLS) fail(where, `a step of ${o.step} puts ${count} places over this area, more than ${MAX_CELLS}: take a larger step or smaller bounds`);
  const out: Cell[] = [];
  for (let row = 0, v = v0; v <= v1; v += sy, row++) {
    for (let col = 0, u = u0; u <= u1; u += sx, col++) {
      const [uu, vv] = [u + (o.rng.next() * 2 - 1) * o.jitter * sx, v + (o.rng.next() * 2 - 1) * o.jitter * sy];
      const p: Vec2 = [tenth(uu * c - vv * s), tenth(uu * s + vv * c)];
      if (b && (p[0] < b[0] || p[1] < b[1] || p[0] > b[2] || p[1] > b[3])) continue;
      if (inside(p, o.within) && !o.avoid.some((a) => inside(p, a))) out.push({ at: p, row, col });
    }
  }
  return out;
}

/** The four corners of a box as an outline. */
const corners = (b: Box): Vec2[] => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];

export interface ScatterOptions {
  /** The outline the places lie in. */
  within: Ring;
  /** Outlines no place lies in (water, a square). */
  avoid?: Rings;
  /** Units between neighbours across; `aspect` times that between rows (1). */
  step: number;
  aspect?: number;
  /** Degrees the lattice is turned (0). */
  turn?: number;
  /** How far each place moves at random, a share of the step (0.35). */
  jitter?: number;
  seed: Seed;
  /** Only the places over this box: [x0, y0, x1, y1]. */
  bounds?: Box;
}

/** Places on a jittered lattice inside an outline and out of others, `step` apart: where the things of a dressing stand. */
export function scatter(o: ScatterOptions): Vec2[] {
  const where = 'scatter';
  checkKeys(where, o, ['within', 'avoid', 'step', 'aspect', 'turn', 'jitter', 'seed', 'bounds']);
  return lattice(where, {
    within: points(where, 'within', o.within, 3),
    avoid: o.avoid === undefined ? [] : rings(where, 'avoid', o.avoid),
    step: num(where, 'step', o.step, 1e-3, 1e6),
    aspect: o.aspect === undefined ? 1 : num(where, 'aspect', o.aspect, 0.05, 20),
    turn: o.turn === undefined ? 0 : num(where, 'turn', o.turn, -3600, 3600),
    jitter: o.jitter === undefined ? 0.35 : num(where, 'jitter', o.jitter, 0, 1),
    rng: new Rng(seedOf(where, o.seed), 'scatter'),
    ...(o.bounds === undefined ? {} : { bounds: boxOf(where, 'bounds', o.bounds) }),
  }).map((cell) => cell.at);
}

/**
 * A mask of round patches, for a meadow of trees here and there or a field left fallow: true inside about `share` of
 * the cells of a lattice `cell` units wide, in a patch round a place near the middle of the cell, `r` to `r * 1.8`
 * across its half and a little flattened. Seeded: the same seed gives the same patches.
 */
export function patches(o: { cell: number; share: number; r: number; seed?: Seed }): (p: Vec2) => boolean {
  const where = 'patches';
  checkKeys(where, o, ['cell', 'share', 'r', 'seed']);
  const cell = num(where, 'cell', o.cell, 1e-3, 1e6);
  const share = num(where, 'share', o.share, 0, 1);
  const r = num(where, 'r', o.r, 0, 1e6);
  const seed = o.seed === undefined ? 0 : seedOf(where, o.seed);
  // The four numbers of a cell: whether it holds a patch, where its middle lies, and its size. Kept, as a cell is asked often.
  const known = new Map<string, readonly number[]>();
  const of = (i: number, j: number): readonly number[] => {
    const key = `${i} ${j}`;
    let h = known.get(key);
    if (!h) {
      const rng = new Rng(seed, `patches/${key}`);
      h = [rng.next(), rng.next(), rng.next(), rng.next()];
      known.set(key, h);
    }
    return h;
  };
  return ([x, y]) => {
    const [i, j] = [Math.floor(x / cell), Math.floor(y / cell)];
    const h = of(i, j);
    if (h[0]! > share) return false;
    const [cx, cy] = [(i + 0.3 + h[1]! * 0.4) * cell, (j + 0.3 + h[2]! * 0.4) * cell];
    return Math.hypot(x - cx, (y - cy) * 1.3) < r * (1 + h[3]! * 0.8);
  };
}

// ---------------------------------------------------------------- water

export interface WaterOptions {
  id: string;
  /** The outlines of the water on the stage. The first is the main body, which the sheen and the ripples lie on. */
  rings: Rings;
  /** The shore as open lines, where the outlines run along a cut (the edge of the map) that is not a shore; default the outlines themselves. */
  shores?: readonly (readonly Vec2[])[];
  fill: ColorRef;
  /** The lighter water along the shore. */
  shallow: ColorRef;
  /** The shore line, the sheen and the ripples. */
  glint: ColorRef;
  /** The width of the band of shallows, units. */
  band: number;
  /** How round the outlines are drawn, 0..1 (0.3). */
  smooth?: number;
  /** Broad soft patches of sheen on the main body: [x, y, rx, ry] each. */
  sheen?: readonly (readonly [number, number, number, number])[];
  /** Short pale arcs over the main body (or over `within`), `step` apart and `len` long, each drifting on its own; `opacity` 0.45. */
  ripples?: { step: number; len: number; seed: Seed; within?: Ring; opacity?: number };
}

/** One ripple: a short pale arc, drifting slowly on its own, clipped to the water. */
function ripple(id: string, at: Vec2, len: number, color: ColorRef, clip: string, opacity: number, i: number): SceneNode {
  const h = len * 0.16;
  return group({
    id,
    at,
    idle: { amp: len * 0.12, period: 5 + (i % 5) * 0.7 },
    children: [stroke({ id: `${id}-arc`, points: [[-len / 2, h], [0, -h], [len / 2, h]], smooth: 1, color, width: Math.max(2, len * 0.08), opacity, clipTo: clip })],
  });
}

/**
 * Water as a body with a surface: the fill, a band of lighter shallows inside the shore, a sheen, ripples that drift,
 * and a thin pale shore line. The outlines are regions with ids `id`, `id1`, `id2`, ...; the rest is clipped to them.
 * Nothing is blurred, so no glow spills over the land.
 */
export function water(o: WaterOptions): SceneNode[] {
  const where = `water("${o?.id}")`;
  checkKeys(where, o, ['id', 'rings', 'shores', 'fill', 'shallow', 'glint', 'band', 'smooth', 'sheen', 'ripples']);
  const body = rings(where, 'rings', o.rings);
  if (body.length === 0) fail(where, 'rings must hold at least one outline');
  const band = num(where, 'band', o.band, 0, 1e4);
  const smooth = o.smooth === undefined ? 0.3 : num(where, 'smooth', o.smooth, 0, 1);
  const ids = body.map((_, i) => (i === 0 ? o.id : `${o.id}${i}`));
  const out: SceneNode[] = body.map((ring, i) => region({ id: ids[i]!, points: [...ring], smooth, fill: o.fill, lit: false, backdrop: true }));
  const closed = o.shores === undefined;
  const shores = closed ? body : rings(where, 'shores', o.shores, 2);
  // The shallows: three bands along the shore, each clipped to the water and none blurred, so that the water is
  // lighter toward its shore and the shore stays a calm line.
  out.push(group({
    id: `${o.id}-shallows`,
    children: shores.flatMap((line, i) => [2, 1.3, 0.7].map((k, j) =>
      stroke({ id: `${o.id}-shallow${i}-${j}`, points: [...line], closed, smooth, color: o.shallow, width: tenth(band * k), opacity: 0.28, clipTo: closed ? ids[i]! : o.id }))),
  }));
  // The sheen: broad ovals of light, each three steps fainter outward, clipped to the main body.
  if (o.sheen !== undefined && o.sheen.length > 0) {
    out.push(group({
      id: `${o.id}-sheen`,
      children: o.sheen.flatMap(([x, y, rx, ry], i) => [1, 0.7, 0.42].map((k, j) =>
        region({ id: `${o.id}-sheen${i}-${j}`, at: [x, y], points: oval(rx * k, ry * k), smooth: 1, fill: o.glint, opacity: 0.08, lit: false, clipTo: o.id }))),
    }));
  }
  if (o.ripples !== undefined) {
    const r = o.ripples;
    checkKeys(`${where} ripples`, r, ['step', 'len', 'seed', 'within', 'opacity']);
    const len = num(where, 'ripples.len', r.len, 0.1, 1e4);
    const opacity = r.opacity === undefined ? 0.45 : num(where, 'ripples.opacity', r.opacity, 0, 1);
    const at = lattice(where, {
      within: r.within === undefined ? body[0]! : points(where, 'ripples.within', r.within, 3),
      avoid: [],
      step: num(where, 'ripples.step', r.step, 1e-3, 1e6),
      aspect: 1,
      turn: 0,
      jitter: 0.45,
      rng: new Rng(seedOf(where, r.seed), 'water/ripples'),
    }).filter((cell) => inside(cell.at, body[0]!));
    out.push(...at.map((cell, i) => ripple(`${o.id}-ripple${i}`, cell.at, len * (0.75 + ((i * 37) % 10) / 20), o.glint, o.id, opacity, i)));
  }
  out.push(...shores.map((line, i) => stroke({ id: `${o.id}-shore${i}`, points: [...line], closed, smooth, color: o.glint, width: Math.max(2, band * 0.14), opacity: 0.55 })));
  return out;
}

// ---------------------------------------------------------------- woods, trees, the ground, fields, houses

/** The shadows of a group of bodies, when the scene gives their colour. */
const shadows = (color: ColorRef | undefined, opacity: number, soft: number): { cast?: { color: ColorRef; opacity: number; length: number; soft: number } } =>
  color === undefined ? {} : { cast: { color, opacity, length: 0.9, soft } };

export interface WoodsOptions {
  id: string;
  /** The outlines of the woods. */
  within: Rings;
  avoid?: Rings;
  /** Units between crowns, and the radius of a crown (each 0.75 to 1.25 of it). */
  step: number;
  r: number;
  seed: Seed;
  /** The greens of the crowns, each crown one of them at random. */
  crowns: readonly ColorRef[];
  /** A soft shade on the ground under the woods. */
  under?: ColorRef;
  /** The colour of the short shadows the crowns cast; none without it. */
  shadow?: ColorRef;
  bounds?: Box;
  /** A share of the step (0.45). */
  jitter?: number;
}

/** Woods: a soft shade on the ground under them and many small round crowns over it, each a low dome, drawn far to near. */
export function woods(o: WoodsOptions): SceneNode[] {
  const where = `woods("${o?.id}")`;
  checkKeys(where, o, ['id', 'within', 'avoid', 'step', 'r', 'seed', 'crowns', 'under', 'shadow', 'bounds', 'jitter']);
  const within = rings(where, 'within', o.within);
  const avoid = o.avoid === undefined ? [] : rings(where, 'avoid', o.avoid);
  const step = num(where, 'step', o.step, 1e-3, 1e6);
  const r = num(where, 'r', o.r, 0.1, 1e4);
  const crowns = colours(where, 'crowns', o.crowns);
  const jitter = o.jitter === undefined ? 0.45 : num(where, 'jitter', o.jitter, 0, 1);
  const bounds = o.bounds === undefined ? undefined : boxOf(where, 'bounds', o.bounds);
  const root = new Rng(seedOf(where, o.seed), 'woods');
  const size = root.stream('crowns');
  const places = within.flatMap((ring, k) => lattice(where, { within: ring, avoid, step, aspect: 1, turn: 0, jitter, rng: root.stream(`grid${k}`), ...(bounds ? { bounds } : {}) }));
  const children = places.map(({ at }, i) => {
    const rr = tenth(r * (0.75 + size.next() * 0.5));
    return circle({ id: `${o.id}-crown${i}`, at, r: rr, fill: crowns[Math.floor(size.next() * crowns.length)]!, lit: false, rise: rr * 0.35, roof: { kind: 'dome', height: rr * 0.55 } });
  });
  return [
    ...(o.under === undefined ? [] : [group({ id: `${o.id}-under`, soft: r * 1.4, opacity: 0.7, children: within.map((ring, i) => region({ id: `${o.id}-under${i}`, points: [...ring], smooth: 0, fill: o.under!, lit: false })) })]),
    group({ id: `${o.id}-crowns`, sort: 'depth', ...shadows(o.shadow, 0.45, 1.5), children }),
  ];
}

export interface TreesOptions {
  id: string;
  /** The box the trees may stand in: [x0, y0, x1, y1]. */
  bounds: Box;
  avoid?: Rings;
  step: number;
  r: number;
  seed: Seed;
  crowns: readonly ColorRef[];
  /** Where a tree stands, of the places of the lattice: a bank, a hedge, a patch (`patches`); `random()` is a seeded number in 0..1. All of them by default. */
  keep?: (p: Vec2, random: () => number) => boolean;
  shadow?: ColorRef;
}

/** Trees alone or in short rows, as on an illustrated map: round crowns, each a low dome, where `keep` says, drawn far to near. */
export function trees(o: TreesOptions): SceneNode {
  const where = `trees("${o?.id}")`;
  checkKeys(where, o, ['id', 'bounds', 'avoid', 'step', 'r', 'seed', 'crowns', 'keep', 'shadow']);
  const bounds = boxOf(where, 'bounds', o.bounds);
  const r = num(where, 'r', o.r, 0.1, 1e4);
  const crowns = colours(where, 'crowns', o.crowns);
  const keep = fn<(p: Vec2, random: () => number) => boolean>(where, 'keep', o.keep);
  const root = new Rng(seedOf(where, o.seed), 'trees');
  const chance = root.stream('keep');
  const random = (): number => chance.next();
  const size = root.stream('crowns');
  const places = lattice(where, { within: corners(bounds), avoid: o.avoid === undefined ? [] : rings(where, 'avoid', o.avoid), step: num(where, 'step', o.step, 1e-3, 1e6), aspect: 1, turn: 0, jitter: 0.5, rng: root.stream('grid') })
    .map((cell) => cell.at)
    .filter((p) => (keep ? keep(p, random) : true));
  return group({
    id: o.id,
    sort: 'depth',
    ...shadows(o.shadow, 0.45, 1.5),
    children: places.map((p, i) => {
      const rr = tenth(r * (0.75 + size.next() * 0.5));
      return circle({ id: `${o.id}-${i}`, at: p, r: rr, fill: crowns[Math.floor(size.next() * crowns.length)]!, lit: false, rise: rr * 0.4, roof: { kind: 'dome', height: rr * 0.6 } });
    }),
  });
}

export interface FlecksOptions {
  id: string;
  bounds: Box;
  avoid?: Rings;
  step: number;
  /** The length of a fleck (each 0.6 to 1.2 of it). */
  len: number;
  seed: Seed;
  /** A little lighter and a little darker than the ground, taken in turn. */
  colors: readonly ColorRef[];
  /** 0.3. */
  opacity?: number;
}

/** A quiet texture of the ground, as on a painted map: short flecks, tilted up to 25 degrees, `step` apart over `bounds`. In a plane seen at a tilt they shrink with the distance. */
export function flecks(o: FlecksOptions): SceneNode {
  const where = `flecks("${o?.id}")`;
  checkKeys(where, o, ['id', 'bounds', 'avoid', 'step', 'len', 'seed', 'colors', 'opacity']);
  const bounds = boxOf(where, 'bounds', o.bounds);
  const len = num(where, 'len', o.len, 0.1, 1e4);
  const colors = colours(where, 'colors', o.colors);
  const opacity = o.opacity === undefined ? 0.3 : num(where, 'opacity', o.opacity, 0, 1);
  const root = new Rng(seedOf(where, o.seed), 'flecks');
  const shape = root.stream('shape');
  const places = lattice(where, { within: corners(bounds), avoid: o.avoid === undefined ? [] : rings(where, 'avoid', o.avoid), step: num(where, 'step', o.step, 1e-3, 1e6), aspect: 1, turn: 0, jitter: 0.5, rng: root.stream('grid') });
  return group({
    id: o.id,
    children: places.map(({ at }, i) => {
      const l = len * (0.6 + shape.next() * 0.6);
      const t = (shape.next() * 2 - 1) * 25 * DEG;
      const [dx, dy] = [tenth(Math.cos(t) * l * 0.5), tenth(Math.sin(t) * l * 0.5)];
      return stroke({ id: `${o.id}-${i}`, points: [[at[0] - dx, at[1] - dy], [at[0] + dx, at[1] + dy]], color: colors[i % colors.length]!, width: Math.max(1.5, len * 0.22), opacity });
    }),
  });
}

export interface ParcelsOptions {
  id: string;
  within: Ring;
  avoid?: Rings;
  /** The width of a parcel's cell, and its depth as a share of that (0.7). */
  step: number;
  aspect?: number;
  /** Degrees the lattice of the fields is turned (0). */
  turn?: number;
  seed: Seed;
  fills: readonly ColorRef[];
  /** The colour of the rows of the striped parcels (about three in ten): vineyards, furrows. None striped without it. */
  rows?: ColorRef;
  /** 0.9. */
  opacity?: number;
  bounds?: Box;
  keep?: (p: Vec2) => boolean;
}

/** Fields: parcels on a turned lattice, each a little smaller than its cell so that the ground between reads as hedges and tracks. Only whole parcels inside `within`. */
export function parcels(o: ParcelsOptions): SceneNode {
  const where = `parcels("${o?.id}")`;
  checkKeys(where, o, ['id', 'within', 'avoid', 'step', 'aspect', 'turn', 'seed', 'fills', 'rows', 'opacity', 'bounds', 'keep']);
  const within = points(where, 'within', o.within, 3);
  const avoid = o.avoid === undefined ? [] : rings(where, 'avoid', o.avoid);
  const step = num(where, 'step', o.step, 1e-3, 1e6);
  const aspect = o.aspect === undefined ? 0.7 : num(where, 'aspect', o.aspect, 0.05, 20);
  const turn = o.turn === undefined ? 0 : num(where, 'turn', o.turn, -3600, 3600);
  const fills = colours(where, 'fills', o.fills);
  const opacity = o.opacity === undefined ? 0.9 : num(where, 'opacity', o.opacity, 0, 1);
  const keep = fn<(p: Vec2) => boolean>(where, 'keep', o.keep);
  const root = new Rng(seedOf(where, o.seed), 'parcels');
  const look = root.stream('look');
  const [w, h] = [step * 0.9, step * aspect * 0.88];
  const t = turn * DEG;
  const corner = ([x, y]: Vec2, du: number, dv: number): Vec2 => [x + du * Math.cos(t) - dv * Math.sin(t), y + du * Math.sin(t) + dv * Math.cos(t)];
  const whole = (at: Vec2): boolean =>
    ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).every(([a, b]) => {
      const p = corner(at, (a * w) / 2, (b * h) / 2);
      return inside(p, within) && !avoid.some((v) => inside(p, v));
    });
  const cells = lattice(where, { within, avoid, step, aspect, turn, jitter: 0.04, rng: root.stream('grid'), ...(o.bounds === undefined ? {} : { bounds: boxOf(where, 'bounds', o.bounds) }) })
    .filter(({ at }) => (keep ? keep(at) : true) && whole(at));
  return group({
    id: o.id,
    opacity,
    children: cells.map(({ at }, i) => {
      const [pw, ph] = [tenth(w * (0.8 + look.next() * 0.2)), tenth(h * (0.8 + look.next() * 0.2))];
      const striped = o.rows !== undefined && look.next() < 0.3;
      return rect({
        id: `${o.id}-${i}`,
        at,
        w: pw,
        h: ph,
        radius: 2,
        rotation: tenth(turn + (look.next() * 2 - 1) * 4),
        fill: fills[Math.floor(look.next() * fills.length)]!,
        lit: false,
        children: striped ? [0, 1, 2, 3].map((k) => rect({ id: `${o.id}-${i}-row${k}`, at: [0, tenth((k - 1.5) * ph * 0.22)], w: pw * 0.86, h: Math.max(1.5, ph * 0.08), radius: 0, fill: o.rows!, opacity: 0.6, lit: false })) : [],
      });
    }),
  });
}

export interface HousesOptions {
  id: string;
  within: Ring;
  avoid?: Rings;
  /** Units between houses across (rows are 0.82 of it apart). */
  step: number;
  turn?: number;
  seed: Seed;
  roofs: readonly ColorRef[];
  /** The walls under the roofs. */
  side: ColorRef;
  /** The height of a house's walls (each 0.75 to 1.35 of it); its roof is 0.6 of its walls. */
  rise: number;
  /** A street every `street` rows and every `street + 1` columns (4). */
  street?: number;
  bounds?: Box;
  /** A share of the step (0.12). */
  jitter?: number;
  keep?: (p: Vec2) => boolean;
  shadow?: ColorRef;
  /**
   * The roofs: `kind` 'hip' (four slopes), 'gable' (two slopes and a ridge along the longer side) or 'mixed' (each
   * house one of the two, about half each); `pitch`, how high a roof stands as a share of its house's shorter side
   * (0.45 makes a steep roof that reads from far); `contrast`, how far its lit and its shaded slopes lie from its
   * colour (1 as the light gives them, up to 2). Left out: a hipped roof 0.6 of its walls high.
   */
  roof?: { kind?: 'hip' | 'gable' | 'mixed'; pitch?: number; contrast?: number };
}

/** A town as a dense fabric of small houses, each a low block under a hipped roof, on a turned lattice with streets, drawn far to near. */
export function houses(o: HousesOptions): SceneNode {
  const where = `houses("${o?.id}")`;
  checkKeys(where, o, ['id', 'within', 'avoid', 'step', 'turn', 'seed', 'roofs', 'side', 'rise', 'street', 'bounds', 'jitter', 'keep', 'shadow', 'roof']);
  const step = num(where, 'step', o.step, 1e-3, 1e6);
  const turn = o.turn === undefined ? 0 : num(where, 'turn', o.turn, -3600, 3600);
  const roofs = colours(where, 'roofs', o.roofs);
  const rise = num(where, 'rise', o.rise, 0, 1e4);
  const street = o.street === undefined ? 4 : num(where, 'street', o.street, 2, 1000);
  if (!Number.isInteger(street)) fail(where, `street must be a whole number, got ${street}`);
  const keep = fn<(p: Vec2) => boolean>(where, 'keep', o.keep);
  if (o.roof !== undefined) {
    if (o.roof === null || typeof o.roof !== 'object') fail(where, 'roof must be { kind, pitch, contrast }');
    checkKeys(`${where} roof`, o.roof, ['kind', 'pitch', 'contrast']);
    if (o.roof.kind !== undefined && !['hip', 'gable', 'mixed'].includes(o.roof.kind)) fail(where, `roof.kind must be 'hip', 'gable' or 'mixed', got ${JSON.stringify(o.roof.kind)}`);
  }
  const pitch = o.roof?.pitch === undefined ? null : num(where, 'roof.pitch', o.roof.pitch, 0.05, 2);
  const contrast = o.roof?.contrast === undefined ? null : num(where, 'roof.contrast', o.roof.contrast, 0, 2);
  const root = new Rng(seedOf(where, o.seed), 'houses');
  const look = root.stream('look');
  // A stream of its own for the kinds of the roofs, so that the houses are the same with or without it.
  const kinds = root.stream('roofs');
  const roofOf = (up: number, w: number, h: number): { kind: 'hip' | 'gable'; height: number; contrast?: number } => {
    const kind = o.roof?.kind === 'gable' ? 'gable' : o.roof?.kind === 'mixed' ? (kinds.next() < 0.5 ? 'gable' : 'hip') : 'hip';
    const height = pitch === null ? tenth(up * 0.6) : tenth(pitch * Math.min(w, h));
    return { kind, height, ...(contrast === null ? {} : { contrast }) };
  };
  const n = street;
  const children = lattice(where, {
    within: points(where, 'within', o.within, 3),
    avoid: o.avoid === undefined ? [] : rings(where, 'avoid', o.avoid),
    step,
    aspect: 0.82,
    turn,
    jitter: o.jitter === undefined ? 0.12 : num(where, 'jitter', o.jitter, 0, 1),
    rng: root.stream('grid'),
    ...(o.bounds === undefined ? {} : { bounds: boxOf(where, 'bounds', o.bounds) }),
  })
    .filter(({ at, row, col }) => row % n !== n - 1 && col % (n + 1) !== n && (keep ? keep(at) : true))
    .map(({ at }, i) => {
      const [w, h] = [tenth(step * (0.62 + look.next() * 0.22)), tenth(step * 0.82 * (0.6 + look.next() * 0.22))];
      const up = tenth(rise * (0.75 + look.next() * 0.6));
      return rect({ id: `${o.id}-${i}`, at, w, h, radius: 0, rotation: tenth(turn + (look.next() * 2 - 1) * 5), fill: roofs[Math.floor(look.next() * roofs.length)]!, side: o.side, lit: false, rise: up, roof: roofOf(up, w, h) });
    });
  return group({ id: o.id, sort: 'depth', ...shadows(o.shadow, 0.4, 1.2), children });
}

// ---------------------------------------------------------------- a road of logs, a locator

export interface LogRoadOptions {
  id: string;
  /** The middle of the road, a dense line (`smoothLine`). */
  path: readonly Vec2[];
  width: number;
  /** Units between the logs. */
  step: number;
  bed: ColorRef;
  /** The colour of the logs, or a list of colours each log takes one of. */
  log: ColorRef | readonly ColorRef[];
  /** The pale rail along each side; not needed with rails: false. */
  rail?: ColorRef;
  /**
   * Round logs: each a lit stick with round ends, so that it reads as a log with a lit and a shaded side, laid at an
   * even `step` along the road. Left out: flat bars, each where the line has run a step since the last.
   */
  round?: boolean;
  /** How thick a log is, as a share of the step: 0.9 lays them side by side with a thin gap between. Left out: 0.38. */
  share?: number;
  /** 0..1: how unevenly the logs lie, each a little longer or shorter, out of line and turned. Left out: 0, all alike. */
  jitter?: number;
  /** The seed of the jitter and of the colours of the logs (0). */
  seed?: Seed;
  /** False: no rails along the sides. Left out: true. */
  rails?: boolean;
}

/** Where a log of a road lies: its middle, and the direction of the road there (radians). */
type LogAt = { at: Vec2; ang: number };

/** Places evenly `step` apart along a line, from its first point, each with the direction of the line there. */
function evenAlong(path: readonly Vec2[], step: number): LogAt[] {
  const out: LogAt[] = [];
  let next = 0;
  let run = 0;
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1]!, path[i]!];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len <= 0) continue;
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    while (next <= run + len) {
      const t = (next - run) / len;
      out.push({ at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], ang });
      next += step;
    }
    run += len;
  }
  return out;
}

/**
 * A road laid over the ground, as a map shows one: a bed of earth, logs laid across it every `step` units, and a pale
 * rail along each side. With `round`, `share`, `jitter` and `rails: false` it is a corduroy road of round logs laid
 * side by side, each a little out of line.
 */
export function logRoad(o: LogRoadOptions): SceneNode[] {
  const where = `logRoad("${o?.id}")`;
  checkKeys(where, o, ['id', 'path', 'width', 'step', 'bed', 'log', 'rail', 'round', 'share', 'jitter', 'seed', 'rails']);
  const path = points(where, 'path', o.path, 2);
  const w = num(where, 'width', o.width, 0.1, 1e4);
  const step = num(where, 'step', o.step, 0.1, 1e6);
  const round = o.round === undefined ? false : flagOf(where, 'round', o.round);
  const rails = o.rails === undefined ? true : flagOf(where, 'rails', o.rails);
  if (rails && o.rail === undefined) fail(where, 'rail is the colour of the rails: give it, or rails: false');
  const share = o.share === undefined ? 0.38 : num(where, 'share', o.share, 0.05, 1.5);
  const jitter = o.jitter === undefined ? 0 : num(where, 'jitter', o.jitter, 0, 1);
  const tones = colourOrList(where, 'log', o.log);
  // The plain road of the first version, exactly as it was made: flat bars of one colour where the line has run a step.
  const plain = !round && o.share === undefined && o.jitter === undefined && o.seed === undefined && typeof o.log === 'string';
  const rng = new Rng(o.seed === undefined ? 0 : seedOf(where, o.seed), 'logRoad');
  const logs: SceneNode[] = [];
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  let run = 0;
  for (let i = 0; i < path.length; i++) {
    const [a, b] = [path[Math.max(0, i - 1)]!, path[Math.min(path.length - 1, i + 1)]!];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const [nx, ny] = [-Math.sin(ang), Math.cos(ang)];
    const p = path[i]!;
    left.push([tenth(p[0] + nx * w * 0.42), tenth(p[1] + ny * w * 0.42)]);
    right.push([tenth(p[0] - nx * w * 0.42), tenth(p[1] - ny * w * 0.42)]);
    if (i > 0) run += Math.hypot(p[0] - path[i - 1]![0], p[1] - path[i - 1]![1]);
    if (plain && (i === 0 || run >= step)) {
      run = 0;
      logs.push(rect({ id: `${o.id}-log${logs.length}`, at: p, w: Math.max(2, step * 0.38), h: w * 0.94, radius: 0, rotation: tenth(ang / DEG), fill: o.log as ColorRef, lit: false }));
    }
  }
  if (!plain) {
    const thick = Math.max(1, step * share);
    const places = round ? evenAlong(path, step) : [];
    if (!round) {
      // Flat bars where the line has run a step, as the plain road lays them.
      let since = 0;
      for (let i = 0; i < path.length; i++) {
        const [a, b] = [path[Math.max(0, i - 1)]!, path[Math.min(path.length - 1, i + 1)]!];
        if (i > 0) since += Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]);
        if (i === 0 || since >= step) {
          since = 0;
          places.push({ at: path[i]!, ang: Math.atan2(b[1] - a[1], b[0] - a[0]) });
        }
      }
    }
    for (const { at, ang } of places) {
      // Each log a little longer or shorter, out of line along itself, and turned; its colour one of the list.
      const [u1, u2, u3, u4] = [rng.next(), rng.next(), rng.next(), rng.next()];
      const length = Math.max(2 * thick, w * 0.94 * (1 - jitter * 0.14 * u1));
      const off = (u2 * 2 - 1) * jitter * w * 0.05;
      const turn = ang + (u3 * 2 - 1) * jitter * 5 * DEG;
      const fill = tones[Math.floor(u4 * tones.length)]!;
      const across: Vec2 = [tenth(at[0] - Math.sin(ang) * off), tenth(at[1] + Math.cos(ang) * off)];
      const id = `${o.id}-log${logs.length}`;
      logs.push(
        round
          ? capsule({ id, at: across, length: tenth(length), r: tenth(thick / 2), rotation: tenth(turn / DEG + 90), fill, lit: true })
          : rect({ id, at: across, w: tenth(thick), h: tenth(length), radius: 0, rotation: tenth(turn / DEG), fill, lit: false }),
      );
    }
  }
  return [
    stroke({ id: o.id, points: [...path], smooth: 0, color: o.bed, width: w, opacity: 0.95 }),
    group({ id: `${o.id}-logs`, children: logs }),
    ...(rails
      ? [
          stroke({ id: `${o.id}-rail0`, points: left, smooth: 0, color: o.rail!, width: Math.max(2, w * 0.07), opacity: 0.85 }),
          stroke({ id: `${o.id}-rail1`, points: right, smooth: 0, color: o.rail!, width: Math.max(2, w * 0.07), opacity: 0.85 }),
        ]
      : []),
  ];
}

export interface LocatorOptions {
  id: string;
  /** The middle of the panel on the stage, and its size. */
  at: Vec2;
  w: number;
  h: number;
  /** The land of the region and the country the place lies in, already fitted to the panel. */
  land: Rings;
  country?: Rings;
  /** The place, on the panel. */
  spot: Vec2;
  sea: ColorRef;
  landFill: ColorRef;
  countryFill?: ColorRef;
  /** The border round the panel. */
  frame: ColorRef;
  /** The dot on the place and its halo. */
  mark: ColorRef;
  /** A soft shadow under the panel; none without it. */
  shadow?: ColorRef;
}

/** A locator inset: a small panel of the real region (its sea, its land, the country lit), with a bright dot on the place. */
export function locator(o: LocatorOptions): SceneNode[] {
  const where = `locator("${o?.id}")`;
  checkKeys(where, o, ['id', 'at', 'w', 'h', 'land', 'country', 'spot', 'sea', 'landFill', 'countryFill', 'frame', 'mark', 'shadow']);
  const at = vec(where, 'at', o.at);
  const spot = vec(where, 'spot', o.spot);
  const w = num(where, 'w', o.w, 1, 1e4);
  const h = num(where, 'h', o.h, 1, 1e4);
  const land = rings(where, 'land', o.land);
  const country = o.country === undefined ? [] : rings(where, 'country', o.country);
  const panel = `${o.id}-panel`;
  return [
    ...(o.shadow === undefined ? [] : [rect({ id: `${o.id}-shadow`, at: [at[0] + 8, at[1] + 10], w, h, radius: 18, fill: o.shadow, opacity: 0.35, lit: false, soft: 14 })]),
    rect({ id: `${o.id}-border`, at, w: w + 12, h: h + 12, radius: 24, fill: o.frame, lit: false, backdrop: true }),
    rect({ id: panel, at, w, h, radius: 18, fill: o.sea, lit: false, backdrop: true }),
    ...land.map((ring, i) => region({ id: `${o.id}-land${i}`, points: [...ring], smooth: 0, fill: o.landFill, lit: false, clipTo: panel })),
    ...country.map((ring, i) => region({ id: `${o.id}-country${i}`, points: [...ring], smooth: 0, fill: o.countryFill ?? o.landFill, lit: false, clipTo: panel })),
    circle({ id: `${o.id}-halo`, at: spot, r: 22, fill: o.mark, opacity: 0.3, lit: false, soft: 8 }),
    circle({ id: `${o.id}-spot`, at: spot, r: 9, fill: o.mark, lit: false, glow: 0.5 }),
  ];
}
