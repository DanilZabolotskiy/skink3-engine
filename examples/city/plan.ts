// The plan of a made-up city for the example: irregular blocks with the streets between them, its squares, its main
// streets, a river through it and the site of a hall at its heart, all on the stage. A real city's blocks come from a
// map pipeline (skink3-geo's blocks of a city, fitted to the stage); these are made here, from a seed, so that the
// example needs no data.
//
// The blocks are the cells of a Voronoi diagram of scattered places, denser at the old heart than at the edge, each
// cell moved in from its neighbours by half the width of the street between them, and cut to the city's edge.

import { inside, Rng, type Vec2 } from 'skink3-engine';

export interface Plan {
  readonly blocks: Vec2[][];
  readonly squares: Vec2[][];
  readonly streets: { line: Vec2[]; width: number }[];
  readonly river: Vec2[];
  /** The bank lines of the river, and its middle. */
  readonly middle: Vec2[];
  readonly edge: Vec2[];
  readonly hall: Vec2;
  readonly site: Vec2[];
}

/** A closed outline of n points round a middle, a little out of round. */
function roundish(at: Vec2, r: number, n: number, wobble: number, phase: number): Vec2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    const k = r * (1 + wobble * Math.sin(3 * a + phase) + wobble * 0.5 * Math.sin(5 * a + 2 * phase));
    return [at[0] + Math.cos(a) * k, at[1] + Math.sin(a) * k];
  });
}

/** A convex outline cut by the half-plane of the points p with (p - a) . n <= d. */
function cut(poly: Vec2[], a: Vec2, n: Vec2, d: number): Vec2[] {
  const out: Vec2[] = [];
  const side = (p: Vec2): number => (p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1] - d;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const sp = side(p);
    const sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** The distance from a point to a polyline. */
function distance(p: Vec2, line: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

const round1 = (p: Vec2): Vec2 => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];

/** The city, from a seed: `radius` units across its half, about `count` blocks. */
export function plan(seed: number, radius = 900, count = 1400): Plan {
  const rng = new Rng(seed, 'city');
  const edge = roundish([0, 0], radius, 72, 0.05, 0.7);
  // The river: a bend from the west to the east, south of the heart.
  const middle: Vec2[] = Array.from({ length: 41 }, (_, i) => {
    const x = -1400 + (2800 * i) / 40;
    return [x, 150 + 120 * Math.sin(x / 420) - 0.00008 * x * x];
  });
  const half = 34;
  const river: Vec2[] = [...middle.map(([x, y]): Vec2 => [x, y - half]), ...[...middle].reverse().map(([x, y]): Vec2 => [x, y + half])];
  // The main streets: six out from the heart, and a ring.
  const spokes = [20, 80, 140, 200, 260, 320].map((deg, k): Vec2[] => {
    const a = (deg * Math.PI) / 180;
    return Array.from({ length: 13 }, (_, i) => {
      const r = 60 + ((radius - 40) * i) / 12;
      const bend = 0.12 * Math.sin(i * 0.7 + k);
      return round1([Math.cos(a + bend) * r, Math.sin(a + bend) * r]);
    });
  });
  const ring = roundish([0, 0], radius * 0.52, 48, 0.04, 1.9);
  const streets = [...spokes.map((line) => ({ line, width: 13 })), { line: [...ring, ring[0]!].map(round1), width: 11 }];
  // The places the blocks grow round: on a jittered lattice, denser at the heart.
  const sites: Vec2[] = [];
  const step = Math.sqrt((Math.PI * radius * radius) / count);
  for (let y = -radius; y <= radius; y += step * 0.86) {
    for (let x = -radius; x <= radius; x += step) {
      const r = Math.hypot(x, y) / radius;
      const p: Vec2 = [x + rng.range(-0.45, 0.45) * step, y + rng.range(-0.45, 0.45) * step];
      if (!inside(p, edge)) continue;
      sites.push(p);
      // The old heart: one more place in most cells there.
      if (r < 0.45 && rng.next() < 0.8) sites.push([p[0] + rng.range(-0.4, 0.4) * step, p[1] + rng.range(-0.4, 0.4) * step]);
    }
  }
  // Neighbours by cells of a grid.
  const cell = step * 1.6;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number): string => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  sites.forEach((p, i) => {
    const k = key(p[0], p[1]);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  });
  const hall: Vec2 = [40, -60];
  const site = roundish(hall, 95, 24, 0.02, 0);
  const blocks: Vec2[][] = [];
  const squares: Vec2[][] = [];
  sites.forEach((p, i) => {
    const r = Math.hypot(p[0], p[1]) / radius;
    // Lanes are narrow at the heart and wider at the edge.
    const lane = 7 + 6 * r;
    let poly: Vec2[] = [[p[0] - cell, p[1] - cell], [p[0] + cell, p[1] - cell], [p[0] + cell, p[1] + cell], [p[0] - cell, p[1] + cell]];
    const [gx, gy] = [Math.floor(p[0] / cell), Math.floor(p[1] / cell)];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (j === i) continue;
          const q = sites[j]!;
          const n: Vec2 = [q[0] - p[0], q[1] - p[1]];
          const len = Math.hypot(n[0], n[1]);
          if (len < 1e-9) continue;
          poly = cut(poly, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], [n[0] / len, n[1] / len], -lane / 2);
          if (poly.length < 3) return;
        }
      }
    }
    // Cut to the city's edge, a street in from it.
    for (let k = 0; k < edge.length; k++) {
      const a = edge[k]!;
      const b = edge[(k + 1) % edge.length]!;
      const t: Vec2 = [b[0] - a[0], b[1] - a[1]];
      const len = Math.hypot(t[0], t[1]);
      // The edge runs round with its angle growing: its outward normal is (t.y, -t.x).
      poly = cut(poly, a, [t[1] / len, -t[0] / len], -lane / 2);
      if (poly.length < 3) return;
    }
    const mid: Vec2 = [poly.reduce((s, q) => s + q[0], 0) / poly.length, poly.reduce((s, q) => s + q[1], 0) / poly.length];
    if (distance(mid, middle) < half + lane) return;
    // A few cells near the heart are squares.
    if (r > 0.12 && r < 0.6 && rng.next() < 0.035) {
      squares.push(poly.map(round1));
      return;
    }
    blocks.push(poly.map(round1));
  });
  return { blocks, squares, streets, river: river.map(round1), middle: middle.map(round1), edge: edge.map(round1), hall, site: site.map(round1) };
}
