// The straight skeleton of a simple outline: every stretch of the outline moves inward at one speed, parallel to
// itself, and the corners between them run along the bisectors. Where a stretch shrinks to nothing its neighbours
// meet (an edge event); where a corner that points inward runs into a stretch across from it, the outline splits in
// two (a split event). The paths of the corners are the ridges, the hips and the valleys of a roof whose slopes all
// rise at one rate: the roof a building of that plan would have. Plain geometry: no drawing library here.

import type { Vec2 } from '../core/math.ts';

/** One face of the skeleton: the part of the plan that a stretch of the outline sweeps, or a flat top left when it stops early. */
export interface SkeletonFace {
  /** Its corners, three numbers each: x, y, and the time the outline reached the corner (its distance in from the edge). They run the way the outline does. */
  readonly points: number[];
  /** The stretch of the outline it belongs to (from point `edge` to the next), or -1 for a flat top. */
  readonly edge: number;
}

/** The skeleton of an outline: its faces, and the time at which the outline had moved in as far as it goes. */
export interface Skeleton {
  readonly faces: SkeletonFace[];
  /** The time of the last event: the distance in from the edge of the deepest point the slopes reach. */
  readonly depth: number;
}

/** A corner of the moving outline. */
interface Corner {
  /** Where it was at time `t0`, and how fast it moves: one unit of time moves each of its two stretches one unit in. */
  x0: number;
  y0: number;
  t0: number;
  vx: number;
  vy: number;
  /** The stretch that comes into it and the one that leaves it, as indexes of the outline. */
  ea: number;
  eb: number;
  /** The node it started from. */
  node: number;
  prev: Corner;
  next: Corner;
  alive: boolean;
  /** True when its two stretches turn away from each other on the inside: it can split the outline. */
  reflex: boolean;
  /** True when its stretches run against each other: the outline has no width there. */
  flat: boolean;
}

/**
 * The straight skeleton of a closed outline whose points run with a positive area (clockwise on a screen whose y
 * points down), no three in a line and no stretch of no length. With `stop` the outline stops moving at that time,
 * and what is left of it is flat tops. Returns null when the outline is too broken to give one.
 */
export function straightSkeleton(points: readonly Vec2[], stop = Infinity): Skeleton | null {
  const n = points.length;
  if (n < 3) return null;
  let size = 0;
  for (const p of points) size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]));
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    size = Math.max(size, Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  if (!(size > 0)) return null;
  const eps = 1e-9 * size;
  // Each stretch: its way along, the way inward (one unit long) and where its line lies: nx x + ny y = c.
  const dx: number[] = [];
  const dy: number[] = [];
  const nx: number[] = [];
  const ny: number[] = [];
  const nc: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(l > eps)) return null;
    dx.push((b[0] - a[0]) / l);
    dy.push((b[1] - a[1]) / l);
    nx.push(-(b[1] - a[1]) / l);
    ny.push((b[0] - a[0]) / l);
    nc.push(nx[i]! * a[0] + ny[i]! * a[1]);
  }
  // The nodes of the skeleton: where corners start and stop, with their time.
  const nodes: number[] = [];
  const node = (x: number, y: number, t: number): number => {
    nodes.push(x, y, t);
    return nodes.length / 3 - 1;
  };
  // The bounds of each face: pairs of nodes, by the stretch whose face they bound; the flat tops are kept apart.
  const bounds: [number, number][][] = Array.from({ length: n }, () => []);
  const tops: number[][] = [];
  const bound = (face: number, a: number, b: number): void => {
    if (a !== b) bounds[face]!.push([a, b]);
  };

  const make = (x: number, y: number, t: number, ea: number, eb: number, at: number): Corner => {
    const cross = dx[ea]! * dy[eb]! - dy[ea]! * dx[eb]!;
    const det = nx[ea]! * ny[eb]! - ny[ea]! * nx[eb]!;
    let vx: number;
    let vy: number;
    let flat = false;
    if (Math.abs(det) > 1e-9) {
      // nx_a vx + ny_a vy = 1 and nx_b vx + ny_b vy = 1.
      vx = (ny[eb]! - ny[ea]!) / det;
      vy = (nx[ea]! - nx[eb]!) / det;
    } else {
      vx = nx[ea]!;
      vy = ny[ea]!;
      flat = nx[ea]! * nx[eb]! + ny[ea]! * ny[eb]! < 0;
    }
    const c = { x0: x, y0: y, t0: t, vx, vy, ea, eb, node: at, alive: true, reflex: cross < -1e-12 && !flat, flat } as Corner;
    c.prev = c;
    c.next = c;
    return c;
  };
  const xAt = (c: Corner, t: number): number => c.x0 + c.vx * (t - c.t0);
  const yAt = (c: Corner, t: number): number => c.y0 + c.vy * (t - c.t0);

  // The outline at time 0.
  const first: Corner[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    first.push(make(p[0], p[1], 0, (i - 1 + n) % n, i, node(p[0], p[1], 0)));
  }
  for (let i = 0; i < n; i++) {
    first[i]!.next = first[(i + 1) % n]!;
    first[i]!.prev = first[(i - 1 + n) % n]!;
    bound(i, i, (i + 1) % n);
  }
  let alive = first.slice();
  const loopOf = (c: Corner): Corner[] => {
    const out: Corner[] = [c];
    for (let k = c.next; k !== c && out.length <= 4 * n + 8; k = k.next) out.push(k);
    return out;
  };

  // A loop that is done: its corners stop at time t; its stretches close their faces there, and with `top` what is
  // left of it is a flat top.
  const finish = (loop: Corner[], t: number, top: boolean): void => {
    const at: number[] = [];
    const placed: number[] = [];
    for (const c of loop) {
      const x = xAt(c, t);
      const y = yAt(c, t);
      // Corners that meet are one node, and a corner that has not moved is its own node.
      let found = -1;
      if (Math.abs(t - nodes[3 * c.node + 2]!) <= eps && Math.hypot(nodes[3 * c.node]! - x, nodes[3 * c.node + 1]! - y) <= 1e3 * eps) found = c.node;
      for (let k = 0; found < 0 && k < placed.length; k++) {
        const m = placed[k]!;
        if (Math.hypot(nodes[3 * m]! - x, nodes[3 * m + 1]! - y) <= 1e3 * eps) found = m;
      }
      if (found < 0) found = node(x, y, t);
      placed.push(found);
      at.push(found);
      if (found !== c.node) {
        bound(c.ea, c.node, found);
        bound(c.eb, c.node, found);
      }
      c.alive = false;
    }
    for (let k = 0; k < loop.length; k++) bound(loop[k]!.eb, at[k]!, at[(k + 1) % loop.length]!);
    if (top) {
      const ring: number[] = [];
      for (const m of at) if (ring[ring.length - 1] !== m && ring[0] !== m) ring.push(m);
      if (ring.length >= 3) tops.push(ring);
    }
  };
  // Twice the area of a loop at time t.
  const areaOf = (loop: Corner[], t: number): number => {
    let area = 0;
    for (const c of loop) area += xAt(c, t) * yAt(c.next, t) - xAt(c.next, t) * yAt(c, t);
    return area;
  };
  // A corner stops at time t: at a node of its own there, or at `at`. Its path bounds the faces of its two stretches.
  const halt = (c: Corner, t: number, at = -1): number => {
    const x = xAt(c, t);
    const y = yAt(c, t);
    let m = at;
    if (m < 0) m = Math.abs(t - nodes[3 * c.node + 2]!) <= eps && Math.hypot(nodes[3 * c.node]! - x, nodes[3 * c.node + 1]! - y) <= 1e3 * eps ? c.node : node(x, y, t);
    bound(c.ea, c.node, m);
    bound(c.eb, c.node, m);
    c.alive = false;
    return m;
  };
  // A corner between two stretches that run against each other: the strip between them has closed, and they lie on
  // one line, folded back at the corner. The shorter of the two closes along the longer one, and the corner moves on
  // to where it ends. Returns the corner that goes on from there, or null when nothing of the loop does.
  const unfold = (c: Corner, t: number): Corner | null => {
    const a = c.prev;
    const b = c.next;
    if (a === b || a.prev === b) {
      finish(loopOf(c), t, false);
      return null;
    }
    const x = xAt(c, t);
    const y = yAt(c, t);
    const la = Math.hypot(xAt(a, t) - x, yAt(a, t) - y);
    const lb = Math.hypot(xAt(b, t) - x, yAt(b, t) - y);
    const here = halt(c, t);
    const tie = Math.abs(la - lb) <= 1e3 * eps;
    let next: Corner;
    if (tie || la < lb) {
      // The stretch before the corner closes, all of it, along the one after it: a ridge from a to the corner.
      const pa = halt(a, t);
      bound(c.ea, pa, here);
      bound(c.eb, pa, here);
      if (tie) halt(b, t, pa);
      next = make(xAt(a, t), yAt(a, t), t, a.ea, tie ? b.eb : c.eb, pa);
      next.prev = a.prev;
      next.next = tie ? b.next : b;
    } else {
      const pb = halt(b, t);
      bound(c.ea, here, pb);
      bound(c.eb, here, pb);
      next = make(xAt(b, t), yAt(b, t), t, c.ea, b.eb, pb);
      next.prev = a;
      next.next = b.next;
    }
    next.prev.next = next;
    next.next.prev = next;
    alive.push(next);
    return next;
  };
  // A loop with new corners: done when it has no area left; a corner in it that is folded back is unfolded.
  const settle = (c: Corner, t: number): void => {
    for (let guard = 0; guard <= 4 * n + 8 && c.alive; guard++) {
      const loop = loopOf(c);
      if (loop.length < 3 || Math.abs(areaOf(loop, t)) <= 1e3 * eps * size) {
        finish(loop, t, false);
        return;
      }
      const folded = loop.find((k) => k.flat);
      if (!folded) return;
      const next = unfold(folded, t);
      if (!next) return;
      c = next;
    }
  };

  let time = 0;
  for (let round = 0; round < 8 * n * n + 64; round++) {
    alive = alive.filter((c) => c.alive);
    if (alive.length === 0) return { faces: facesOf(), depth: time };
    // The next event: the earliest edge event, or, sooner still, a split event.
    let best = Infinity;
    let edgeA: Corner | null = null;
    let splitR: Corner | null = null;
    let splitC: Corner | null = null;
    for (const a of alive) {
      const b = a.next;
      const e = a.eb;
      // How long the stretch from a to b is now, and how fast that changes.
      const len = (xAt(b, time) - xAt(a, time)) * dx[e]! + (yAt(b, time) - yAt(a, time)) * dy[e]!;
      const rate = (b.vx - a.vx) * dx[e]! + (b.vy - a.vy) * dy[e]!;
      let t = Infinity;
      if (len <= 1e3 * eps) {
        if (rate <= 1e-12) t = time;
      } else if (rate < -1e-12) t = time - len / rate;
      if (t < best - 1e-12 * size) {
        best = t;
        edgeA = a;
      }
    }
    for (const r of alive) {
      if (!r.reflex) continue;
      const rx = xAt(r, time);
      const ry = yAt(r, time);
      for (let c = r.next.next; c !== r.prev; c = c.next) {
        const e = c.eb;
        if (e === r.ea || e === r.eb) continue;
        // How far r is inside the line of the stretch, and how fast it closes on it.
        const gap = nx[e]! * rx + ny[e]! * ry - (nc[e]! + time);
        const rate = nx[e]! * r.vx + ny[e]! * r.vy - 1;
        if (gap < -1e3 * eps || rate >= -1e-12) continue;
        const t = time - Math.max(0, gap) / rate;
        if (!(t < best - 1e-12 * size)) continue;
        // It splits the outline only where it meets the stretch between its two corners.
        const hx = xAt(r, t);
        const hy = yAt(r, t);
        const along = (hx - xAt(c, t)) * dx[e]! + (hy - yAt(c, t)) * dy[e]!;
        const span = (xAt(c.next, t) - xAt(c, t)) * dx[e]! + (yAt(c.next, t) - yAt(c, t)) * dy[e]!;
        if (along < -1e3 * eps || along > span + 1e3 * eps) continue;
        best = t;
        edgeA = null;
        splitR = r;
        splitC = c;
      }
    }
    if (best === Infinity) return null;
    if (best > stop) {
      // The outline stops before its next event: what is left of it is flat.
      const seen = new Set<Corner>();
      for (const c of alive) {
        if (!c.alive || seen.has(c)) continue;
        const loop = loopOf(c);
        for (const k of loop) seen.add(k);
        finish(loop, stop, true);
      }
      return { faces: facesOf(), depth: stop };
    }
    time = Math.max(time, best);
    if (edgeA) {
      const a = edgeA;
      const b = a.next;
      const x = (xAt(a, time) + xAt(b, time)) / 2;
      const y = (yAt(a, time) + yAt(b, time)) / 2;
      const at = node(x, y, time);
      for (const c of [a, b]) {
        bound(c.ea, c.node, at);
        bound(c.eb, c.node, at);
        c.alive = false;
      }
      if (a.prev === b) {
        // A loop of two corners closes at the point where they meet.
        continue;
      }
      const v = make(x, y, time, a.ea, b.eb, at);
      v.prev = a.prev;
      v.next = b.next;
      a.prev.next = v;
      b.next.prev = v;
      alive.push(v);
      settle(v, time);
      continue;
    }
    const r = splitR!;
    const c = splitC!;
    const d = c.next;
    const e = c.eb;
    const x = xAt(r, time);
    const y = yAt(r, time);
    const at = node(x, y, time);
    bound(r.ea, r.node, at);
    bound(r.eb, r.node, at);
    r.alive = false;
    // One loop goes on from the corner before r along the far part of the stretch, the other from the near part on to the corner after r.
    const v1 = make(x, y, time, r.ea, e, at);
    const v2 = make(x, y, time, e, r.eb, at);
    v1.prev = r.prev;
    v1.next = d;
    v2.prev = c;
    v2.next = r.next;
    r.prev.next = v1;
    d.prev = v1;
    c.next = v2;
    r.next.prev = v2;
    alive.push(v1, v2);
    settle(v1, time);
    settle(v2, time);
  }
  return null;

  // Each face as one outline: the stretch of the outline, then its bounds back to where it started.
  function facesOf(): SkeletonFace[] {
    const faces: SkeletonFace[] = [];
    const corner = (m: number): number[] => [nodes[3 * m]!, nodes[3 * m + 1]!, nodes[3 * m + 2]!];
    for (let e = 0; e < n; e++) {
      const links = new Map<number, number[]>();
      for (const [a, b] of bounds[e]!) {
        // A bound found twice (a ridge closed by both its stretches) is one bound.
        if ((links.get(a) ?? []).includes(b)) continue;
        links.set(a, [...(links.get(a) ?? []), b]);
        links.set(b, [...(links.get(b) ?? []), a]);
      }
      const start = e;
      const ring = [start];
      let before = start;
      let here = (e + 1) % n;
      let ok = true;
      while (here !== start) {
        ring.push(here);
        const ways = links.get(here) ?? [];
        const next = ways.find((m) => m !== before && !(ring.length === 2 && m === start));
        if (next === undefined || ring.length > nodes.length) {
          ok = false;
          break;
        }
        before = here;
        here = next;
      }
      if (!ok || ring.length < 3) continue;
      faces.push({ points: ring.flatMap(corner), edge: e });
    }
    for (const top of tops) faces.push({ points: top.flatMap(corner), edge: -1 });
    return faces;
  }
}
