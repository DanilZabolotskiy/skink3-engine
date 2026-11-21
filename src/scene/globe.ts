// A globe: a sphere seen from far away (an orthographic view), turned so that one place faces the viewer and turning
// about its axis, with the outlines of a body's surface on it.
//
// A point of the body is a unit vector fixed to it: x toward 0° E on the equator, y toward 90° E, z north. The view
// turns it so that the place that faces the viewer lies on the view's z axis: x right, y up, z toward the viewer.
// In the globe's own space a point is drawn at (x r, -y r): y down, as everywhere in a scene. A point faces the
// viewer while its z is above 0; the edge of the disc (the limb) is where z is 0.
//
// Everything here is a pure function of the spec and the moment: the turn is the integral of the spin, so a globe
// that turns at keyed speeds starts and stops without a jump.

import { DEG, smoothstep } from '../core/math.ts';
import { speedDistance, type SpeedKeys } from '../motion/curves.ts';
import { pathTable, type PathSpec } from '../motion/paths.ts';
import type { GlobeSpec } from './types.ts';

/** Degrees a globe has turned east after `t` seconds. */
export function globeTurn(spin: number | SpeedKeys, t: number): number {
  return typeof spin === 'number' ? spin * t : speedDistance(spin, t);
}

/** True when the globe turns at some moment. */
export function globeSpins(spec: GlobeSpec): boolean {
  return typeof spec.spin === 'number' ? spec.spin !== 0 : spec.spin.some((k) => k[1] !== 0);
}

/** A view of a globe at one moment: the sines and cosines of the longitude and latitude that face the viewer. */
export interface GlobeView {
  readonly cl: number;
  readonly sl: number;
  readonly cp: number;
  readonly sp: number;
}

/** The view of a globe at time t; `drift` (degrees per second) turns a layer east over the body. */
export function globeView(spec: GlobeSpec, t: number, drift = 0): GlobeView {
  const lon = (spec.view[0] - globeTurn(spec.spin, t) - drift * t) * DEG;
  const lat = spec.view[1] * DEG;
  return { cl: Math.cos(lon), sl: Math.sin(lon), cp: Math.cos(lat), sp: Math.sin(lat) };
}

/** A place [lon, lat] in degrees as a unit vector of the body. */
export function unitOf(lon: number, lat: number): [number, number, number] {
  const l = lon * DEG;
  const p = lat * DEG;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}

/** A vector of the body in the view's space: x right, y up, z toward the viewer. */
export function toView(v: GlobeView, x: number, y: number, z: number): [number, number, number] {
  const c = x * v.cl + y * v.sl;
  return [-x * v.sl + y * v.cl, v.cp * z - v.sp * c, v.sp * z + v.cp * c];
}

/** Where the sun is, in the view's space, for a light from `from` degrees (0 from the right, -90 from the top) that lights the share `lit` of the disc. */
export function sunOf(light: { readonly from: number; readonly lit: number }): [number, number, number] {
  const b = Math.acos(Math.max(-1, Math.min(1, 2 * light.lit - 1)));
  const a = light.from * DEG;
  return [Math.sin(b) * Math.cos(a), -Math.sin(b) * Math.sin(a), Math.cos(b)];
}

/** What a thing placed on a globe is at one moment: where it stands in the globe's own space, how it is turned (degrees), and how far it faces the viewer (the z of its place). */
export interface GlobePlace {
  readonly x: number;
  readonly y: number;
  readonly rot: number;
  readonly z: number;
}

/**
 * A thing placed on a globe of radius r at [lon, lat], `height` units over its surface, heading `heading` degrees
 * (0 east, 90 north): its x axis lies along the heading as the viewer sees it, its y axis across it.
 */
export function globePlace(spec: GlobeSpec, r: number, lon: number, lat: number, height: number, heading: number, t: number): GlobePlace {
  const v = globeView(spec, t);
  // At a pole east and north have no direction: a hair off it they have.
  const la = Math.max(-89.999, Math.min(89.999, lat));
  const l = lon * DEG;
  const p = la * DEG;
  const [px, py, pz] = toView(v, Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p));
  const h = heading * DEG;
  const ch = Math.cos(h);
  const sh = Math.sin(h);
  // The heading: east and north of the place, mixed.
  const dx = -Math.sin(l) * ch - Math.sin(p) * Math.cos(l) * sh;
  const dy = Math.cos(l) * ch - Math.sin(p) * Math.sin(l) * sh;
  const dz = Math.cos(p) * sh;
  const [hx, hy] = toView(v, dx, dy, dz);
  const k = r * (1 + height / r);
  return { x: px * k, y: -py * k, rot: Math.atan2(-hy, hx) / DEG, z: pz };
}

/** How much of a thing placed on a globe shows: nothing behind the disc, all of it a little in front of the limb. `height` and `r` in units. */
export function globeFade(z: number, height: number, r: number): number {
  const rho = 1 + Math.max(0, height) / r;
  const hidden = -Math.sqrt(Math.max(0, 1 - 1 / (rho * rho)));
  return smoothstep(hidden, hidden + 0.12, z);
}

/** Degrees between two points of an arc of the limb that is drawn round. */
const ARC_STEP = 3 * DEG;

/** Angular distance from a to b going counter-clockwise, 0..2pi. */
function ccw(a: number, b: number): number {
  const d = (b - a) % (2 * Math.PI);
  return d < 0 ? d + 2 * Math.PI : d;
}

interface Piece {
  readonly pts: number[];
  readonly in: number;
  readonly out: number;
}

/**
 * The parts of rings that face the viewer, as closed outlines in the globe's own space (x, y in turn, units, y down):
 * what each ring holds on the near side, closed along the limb. Each ring must run counter-clockwise round its
 * smaller side, seen from outside; a ring marked as a hole comes out the other way round, so that the outlines fill
 * non-zero as the rings would.
 */
export function visibleRings(rings: readonly Float64Array[], holes: readonly boolean[], v: GlobeView, r: number): Float64Array[] {
  const out: Float64Array[] = [];
  let X = new Float64Array(0);
  let Y = new Float64Array(0);
  let Z = new Float64Array(0);
  rings.forEach((ring, ri) => {
    const n = ring.length / 3;
    if (X.length < n) {
      X = new Float64Array(n);
      Y = new Float64Array(n);
      Z = new Float64Array(n);
    }
    let front = 0;
    let firstHidden = -1;
    for (let i = 0; i < n; i++) {
      const x = ring[3 * i]!;
      const y = ring[3 * i + 1]!;
      const z = ring[3 * i + 2]!;
      const c = x * v.cl + y * v.sl;
      X[i] = -x * v.sl + y * v.cl;
      Y[i] = v.cp * z - v.sp * c;
      Z[i] = v.sp * z + v.cp * c;
      if (Z[i]! > 0) front++;
      else if (firstHidden < 0) firstHidden = i;
    }
    if (front === 0) return;
    const loops: number[][] = [];
    if (front === n) {
      const loop: number[] = [];
      for (let i = 0; i < n; i++) loop.push(X[i]!, Y[i]!);
      loops.push(loop);
    } else {
      // Pieces that face the viewer, each from where it comes over the limb to where it goes behind it.
      const pieces: Piece[] = [];
      let open: { pts: number[]; in: number } | null = null;
      for (let k = 0; k < n; k++) {
        const i = (firstHidden + k) % n;
        const j = (i + 1) % n;
        const zi = Z[i]!;
        const zj = Z[j]!;
        if ((zi > 0) !== (zj > 0)) {
          const u = zi / (zi - zj);
          const cx = X[i]! + (X[j]! - X[i]!) * u;
          const cy = Y[i]! + (Y[j]! - Y[i]!) * u;
          const len = Math.hypot(cx, cy) || 1;
          const a = Math.atan2(cy, cx);
          if (zj > 0) open = { pts: [cx / len, cy / len], in: a };
          else if (open) {
            open.pts.push(cx / len, cy / len);
            pieces.push({ pts: open.pts, in: open.in, out: a });
            open = null;
          }
        }
        if (zj > 0 && open) open.pts.push(X[j]!, Y[j]!);
      }
      // From where a piece goes behind, the outline runs counter-clockwise along the limb to where the nearest comes over it.
      const used = new Uint8Array(pieces.length);
      for (let s = 0; s < pieces.length; s++) {
        if (used[s]) continue;
        const loop: number[] = [];
        let p = s;
        while (!used[p]) {
          used[p] = 1;
          const piece = pieces[p]!;
          for (const q of piece.pts) loop.push(q);
          let next = p;
          let best = Infinity;
          for (let q = 0; q < pieces.length; q++) {
            const d = ccw(piece.out, pieces[q]!.in);
            if (d < best) {
              best = d;
              next = q;
            }
          }
          const steps = Math.floor(best / ARC_STEP);
          for (let m = 1; m <= steps; m++) {
            const a = piece.out + m * ARC_STEP;
            loop.push(Math.cos(a), Math.sin(a));
          }
          p = next;
        }
        loops.push(loop);
      }
    }
    for (const loop of loops) {
      const m = loop.length / 2;
      const flat = new Float64Array(loop.length);
      for (let i = 0; i < m; i++) {
        // A hole runs the other way round.
        const s = holes[ri] ? m - 1 - i : i;
        flat[2 * i] = loop[2 * s]! * r;
        flat[2 * i + 1] = -loop[2 * s + 1]! * r;
      }
      out.push(flat);
    }
  });
  return out;
}

/**
 * The night side of a globe of radius r in its own space (x, y in turn, y down): the part of the disc past the
 * terminator, closed by an arc well outside the disc, for a picture clipped to the disc. Null when no part of the
 * disc is in the night.
 */
export function nightOutline(light: { readonly from: number; readonly lit: number }, r: number): Float64Array | null {
  if (light.lit >= 1 - 1e-6) return null;
  const [sx, sy, sz] = sunOf(light);
  const far = 2 * r;
  const pts: number[] = [];
  const side = Math.hypot(sx, sy);
  if (side < 1e-6) {
    // The sun behind the body: all the disc is night.
    for (let m = 0; m < 120; m++) pts.push(far * Math.cos((m * Math.PI) / 60), far * Math.sin((m * Math.PI) / 60));
    return Float64Array.from(pts);
  }
  // The terminator is the great circle square to the sun: the half of it that faces the viewer, from U to -U.
  const ux = -sy / side;
  const uy = sx / side;
  let vx = sy * 0 - sz * uy;
  let vy = sz * ux - sx * 0;
  let vz = sx * uy - sy * ux;
  if (vz < 0) {
    vx = -vx;
    vy = -vy;
    vz = -vz;
  }
  const N = 96;
  for (let m = 0; m <= N; m++) {
    const th = (m * Math.PI) / N;
    const x = Math.cos(th) * ux + Math.sin(th) * vx;
    const y = Math.cos(th) * uy + Math.sin(th) * vy;
    pts.push(x * r, -y * r);
  }
  // Out round the night side, from -U back to U.
  const a1 = Math.atan2(uy, -ux);
  const night = Math.atan2(sy, -sx);
  const dir = ccw(a1, night) < Math.PI ? 1 : -1;
  for (let m = 0; m <= 36; m++) {
    const a = a1 + (dir * m * Math.PI) / 36;
    pts.push(far * Math.cos(a), far * Math.sin(a));
  }
  return Float64Array.from(pts);
}

/** A line on a globe: its samples as unit vectors of the body (x, y, z in turn) and the arc length up to each, in radians. */
export interface SurfaceLine {
  readonly units: Float64Array;
  readonly cum: Float64Array;
  readonly length: number;
}

const lines = new WeakMap<PathSpec, SurfaceLine>();

/** Degrees between two samples of a line on a globe at most. */
const LINE_STEP = 0.5;

/**
 * A stroke's path read as a line on a globe: its points are [lon, lat] in degrees, joined as the path joins them on a
 * map (a run along one latitude stays on it), sampled every half degree at most.
 */
export function surfaceLine(path: PathSpec): SurfaceLine {
  const hit = lines.get(path);
  if (hit) return hit;
  const table = pathTable(path);
  const units: number[] = [];
  const push = (lon: number, lat: number): void => {
    const [x, y, z] = unitOf(lon, Math.max(-90, Math.min(90, lat)));
    units.push(x, y, z);
  };
  push(table.xs[0]!, table.ys[0]!);
  for (let i = 1; i < table.xs.length; i++) {
    const lon0 = table.xs[i - 1]!;
    const lat0 = table.ys[i - 1]!;
    const lon1 = table.xs[i]!;
    const lat1 = table.ys[i]!;
    const k = Math.max(1, Math.ceil(Math.max(Math.abs(lon1 - lon0), Math.abs(lat1 - lat0)) / LINE_STEP));
    for (let m = 1; m <= k; m++) push(lon0 + ((lon1 - lon0) * m) / k, lat0 + ((lat1 - lat0) * m) / k);
  }
  const n = units.length / 3;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(units[3 * i]! - units[3 * i - 3]!, units[3 * i + 1]! - units[3 * i - 2]!, units[3 * i + 2]! - units[3 * i - 1]!);
    cum[i] = cum[i - 1]! + 2 * Math.asin(Math.min(1, d / 2));
  }
  const line = { units: Float64Array.from(units), cum, length: cum[n - 1]! };
  lines.set(path, line);
  return line;
}

/**
 * The parts of a line on a globe that face the viewer, as far as `drawn` (0..1 of its arc length from its first point)
 * is drawn: polylines in the globe's own space (x, y in turn, units, y down).
 */
export function surfaceRuns(line: SurfaceLine, v: GlobeView, r: number, drawn: number): Float64Array[] {
  const { units, cum } = line;
  const n = cum.length;
  const upTo = line.length * Math.max(0, Math.min(1, drawn));
  const runs: Float64Array[] = [];
  let run: number[] | null = null;
  const end = (): void => {
    if (run && run.length >= 4) runs.push(Float64Array.from(run));
    run = null;
  };
  let prev: [number, number, number] | null = null;
  for (let i = 0; i < n; i++) {
    let x = units[3 * i]!;
    let y = units[3 * i + 1]!;
    let z = units[3 * i + 2]!;
    let last = false;
    if (i > 0 && cum[i]! > upTo) {
      // The line ends between two samples.
      const span = cum[i]! - cum[i - 1]!;
      const u = span > 1e-12 ? (upTo - cum[i - 1]!) / span : 0;
      x = units[3 * i - 3]! + (x - units[3 * i - 3]!) * u;
      y = units[3 * i - 2]! + (y - units[3 * i - 2]!) * u;
      z = units[3 * i - 1]! + (z - units[3 * i - 1]!) * u;
      last = true;
    }
    const p = toView(v, x, y, z);
    if (prev && (prev[2] > 0) !== (p[2] > 0)) {
      // It crosses the limb between the two.
      const u = prev[2] / (prev[2] - p[2]);
      const cx = prev[0] + (p[0] - prev[0]) * u;
      const cy = prev[1] + (p[1] - prev[1]) * u;
      if (p[2] > 0) run = [cx * r, -cy * r];
      else {
        run?.push(cx * r, -cy * r);
        end();
      }
    }
    if (p[2] > 0) {
      run ??= [];
      run.push(p[0] * r, -p[1] * r);
    }
    prev = p;
    if (last) break;
  }
  end();
  return runs;
}

/** A line on a globe as one path in the globe's own space at one moment, its far part included and thinned to a few hundred points: where its drawn end is, and how long it looks. */
export function surfacePath(line: SurfaceLine, v: GlobeView, r: number): PathSpec {
  const n = line.cum.length;
  const step = Math.max(1, Math.ceil(n / 240));
  const points: [number, number][] = [];
  for (let i = 0; i < n; i += step) {
    const p = toView(v, line.units[3 * i]!, line.units[3 * i + 1]!, line.units[3 * i + 2]!);
    points.push([p[0] * r, -p[1] * r]);
  }
  if ((n - 1) % step !== 0) {
    const p = toView(v, line.units[3 * n - 3]!, line.units[3 * n - 2]!, line.units[3 * n - 1]!);
    points.push([p[0] * r, -p[1] * r]);
  }
  // A closed line's samples come back to its first point already.
  return { points, closed: false, smooth: 0 };
}

/**
 * A ring of [lon, lat] points made ready for a globe: as unit vectors, every edge longer than a degree cut into
 * pieces of one (joined as on a map, the shorter way round in longitude), counter-clockwise round its smaller side.
 * `hole` says whether it ran clockwise round that side as it was given.
 */
export function globeRing(points: readonly (readonly [number, number])[]): { ring: Float64Array; hole: boolean } {
  const out: number[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [lon0, lat0] = points[i]!;
    const [lon1raw, lat1] = points[(i + 1) % n]!;
    let dl = lon1raw - lon0;
    dl -= 360 * Math.round(dl / 360);
    const k = Math.max(1, Math.ceil(Math.max(Math.abs(dl), Math.abs(lat1 - lat0))));
    for (let m = 0; m < k; m++) {
      const [x, y, z] = unitOf(lon0 + (dl * m) / k, lat0 + ((lat1 - lat0) * m) / k);
      const j = out.length;
      // A point on the one before it is no point.
      if (j >= 3 && Math.abs(out[j - 3]! - x) + Math.abs(out[j - 2]! - y) + Math.abs(out[j - 1]! - z) < 1e-12) continue;
      out.push(x, y, z);
    }
  }
  const ring = Float64Array.from(out);
  const hole = solidAngle(ring) < 0;
  if (hole) {
    const m = ring.length / 3;
    const rev = new Float64Array(ring.length);
    for (let i = 0; i < m; i++) rev.set(ring.subarray(3 * (m - 1 - i), 3 * (m - i)), 3 * i);
    return { ring: rev, hole };
  }
  return { ring, hole };
}

/** The signed solid angle a ring of unit vectors holds, seen from outside: above 0 counter-clockwise round its middle. */
function solidAngle(ring: Float64Array): number {
  const n = ring.length / 3;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[3 * i]!;
    cy += ring[3 * i + 1]!;
    cz += ring[3 * i + 2]!;
  }
  let len = Math.hypot(cx, cy, cz);
  if (len < 1e-9) {
    cx = ring[0]!;
    cy = ring[1]!;
    cz = ring[2]!;
    len = 1;
  }
  cx /= len;
  cy /= len;
  cz /= len;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[3 * i]!;
    const ay = ring[3 * i + 1]!;
    const az = ring[3 * i + 2]!;
    const bx = ring[3 * j]!;
    const by = ring[3 * j + 1]!;
    const bz = ring[3 * j + 2]!;
    // The triangle middle, a, b (Van Oosterom and Strackee).
    const det = cx * (ay * bz - az * by) - cy * (ax * bz - az * bx) + cz * (ax * by - ay * bx);
    const den = 1 + (cx * ax + cy * ay + cz * az) + (ax * bx + ay * by + az * bz) + (bx * cx + by * cy + bz * cz);
    sum += 2 * Math.atan2(det, den);
  }
  return sum;
}
