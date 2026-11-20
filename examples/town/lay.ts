// The laying out of the town example: houses stand in rows along streets, side by side, and never on one another,
// on a street or on the ground a large building keeps. Plain geometry on the plan of the town, before any node is
// made: what it gives is the feet of the bodies.

import type { Rng, Vec2 } from 'skink3-engine';

/** The foot of a house: its middle, its width along the street, its depth away from it, and its turn in degrees. */
export interface Foot {
  at: Vec2;
  w: number;
  d: number;
  turn: number;
}

const DEG = Math.PI / 180;

/** The corners of a foot, grown by `grow` on every side. */
export function corners(f: Foot, grow = 0): Vec2[] {
  const [c, s] = [Math.cos(f.turn * DEG), Math.sin(f.turn * DEG)];
  const [hw, hd] = [f.w / 2 + grow, f.d / 2 + grow];
  return ([[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] as Vec2[]).map(([x, y]) => [f.at[0] + x * c - y * s, f.at[1] + x * s + y * c]);
}

/** Whether two convex outlines overlap: no stretch of either one has them on its two sides. */
export function overlap(p: readonly Vec2[], q: readonly Vec2[]): boolean {
  for (const poly of [p, q]) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const n: Vec2 = [b[1] - a[1], a[0] - b[0]];
      let [p0, p1, q0, q1] = [Infinity, -Infinity, Infinity, -Infinity];
      for (const v of p) {
        const k = v[0] * n[0] + v[1] * n[1];
        p0 = Math.min(p0, k);
        p1 = Math.max(p1, k);
      }
      for (const v of q) {
        const k = v[0] * n[0] + v[1] * n[1];
        q0 = Math.min(q0, k);
        q1 = Math.max(q1, k);
      }
      if (p1 <= q0 || q1 <= p0) return false;
    }
  }
  return true;
}

/** How far a place is from a line of points, or from a closed outline. */
export function toLine(line: readonly Vec2[], p: Vec2, closed = false): number {
  let least = Infinity;
  const n = closed ? line.length : line.length - 1;
  for (let i = 0; i < n; i++) {
    const a = line[i]!;
    const b = line[(i + 1) % line.length]!;
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    least = Math.min(least, Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t));
  }
  return least;
}

/** Whether a place lies inside a closed outline. */
export function inside(ring: readonly Vec2[], p: Vec2): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = [ring[i]!, ring[j]!];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/** The ground already built on, as convex outlines: a foot fits where it overlaps none of them. A grid of cells keeps the test short. */
export class Ground {
  private readonly cells = new Map<string, Vec2[][]>();
  private readonly cell: number;
  constructor(cell = 80) {
    this.cell = cell;
  }
  private keys(poly: readonly Vec2[]): string[] {
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const out: string[] = [];
    for (let i = Math.floor(Math.min(...xs) / this.cell); i <= Math.floor(Math.max(...xs) / this.cell); i++) {
      for (let j = Math.floor(Math.min(...ys) / this.cell); j <= Math.floor(Math.max(...ys) / this.cell); j++) out.push(`${i}:${j}`);
    }
    return out;
  }
  /** True when the outline overlaps nothing held. */
  free(poly: readonly Vec2[]): boolean {
    for (const k of this.keys(poly)) for (const o of this.cells.get(k) ?? []) if (overlap(o, poly)) return false;
    return true;
  }
  hold(poly: Vec2[]): void {
    for (const k of this.keys(poly)) {
      const list = this.cells.get(k);
      if (list) list.push(poly);
      else this.cells.set(k, [poly]);
    }
  }
}

/** A street: its line, and how wide it is. */
export interface Street {
  line: Vec2[];
  width: number;
}

/**
 * Houses in a row along one side of a street: each `front` wide along it and `deep` away from it, a `gap` apart,
 * set `back` from the edge of the street. A house that does not fit (`ok` says no, or the ground is taken) is left
 * out, and the row slides on by `slide` and tries again. Returns the feet that were laid; the ground holds them,
 * grown by `clear`.
 */
export function row(
  street: Street,
  side: 1 | -1,
  o: { rng: Rng; front: [number, number]; deep: [number, number]; gap: number; back?: number; clear?: number; ground: Ground; ok: (f: Foot) => boolean; from?: number; slide?: number },
): Foot[] {
  const out: Foot[] = [];
  const line = street.line;
  for (let i = 0; i + 1 < line.length; i++) {
    const [a, b] = [line[i]!, line[i + 1]!];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const dir: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const normal: Vec2 = [-dir[1] * side, dir[0] * side];
    const turn = Math.atan2(dir[1], dir[0]) / DEG;
    let s = o.gap + (i === 0 ? (o.from ?? 0) : 0);
    while (s < len) {
      const w = o.rng.range(o.front[0], o.front[1]);
      const d = o.rng.range(o.deep[0], o.deep[1]);
      if (s + w > len) break;
      const off = street.width / 2 + (o.back ?? 4) + d / 2;
      const f: Foot = { at: [a[0] + dir[0] * (s + w / 2) + normal[0] * off, a[1] + dir[1] * (s + w / 2) + normal[1] * off], w, d, turn };
      const poly = corners(f, o.clear ?? 2);
      if (o.ok(f) && o.ground.free(poly)) {
        o.ground.hold(poly);
        out.push(f);
        s += w + o.gap;
      } else {
        // A gap in the row is no wider than it must be.
        s += o.slide ?? 3;
      }
    }
  }
  return out;
}
