// The space of a perspective layer: a pinhole camera that looks at a point
// from a distance, the projection of points onto the layer, and the map of a
// plane that lies in that space. Pure functions of plain data.
//
// Space: x to the right, y down, z away from the viewer, in the units of the
// layer. The picture of the camera is centred on the origin of the layer, so
// with the default camera (level, straight on, lens equal to its distance) a
// point at z = 0 is drawn where a flat layer draws it.

import { DEG, type Vec2, type Vec3, type Xf } from '../core/math.ts';
import { profileRamps, rampProgress, type MoveProfile } from '../motion/curves.ts';

/** The camera of a perspective layer. */
export interface PerspSpec {
  /** The point it looks at. */
  readonly aim: Vec3;
  /** How far it stands from that point. */
  readonly distance: number;
  /** Degrees it looks down by: 0 is level, 90 straight down on the point, negative from below. */
  readonly tilt: number;
  /** Degrees it has gone round the point, to the left as the viewer sees it. */
  readonly turn: number;
  /** Its lens: the distance at which one unit is drawn one unit large. */
  readonly lens: number;
  /** Focus by distance: what lies at the focus is sharp, what lies behind it or in front of it the softer the farther off. Left out: all of the layer is as sharp. */
  readonly focus?: PerspFocus;
}

/**
 * The focus of a perspective layer by distance. The depth of a thing is how far it is from the camera, along the line
 * of sight, over the distance of the focus, less 1, as the depth of a layer is: 1 for a thing twice as far as the
 * focus, -0.5 for one halfway to the camera. It is blurred by `far` per unit of depth behind the focus and by `near`
 * per unit in front of it, in the units of the layer, as the camera's focus blurs a layer.
 */
export interface PerspFocus {
  readonly far: number;
  readonly near: number;
  /** The distance from the camera that is sharp. Left out: the camera's distance from its aim at each frame, so that what it looks at stays sharp. */
  readonly at?: number;
}

/** How much the focus of a perspective layer blurs a thing `distance` away from its camera, when the focus is `at` away. */
export function focusBlur(focus: PerspFocus, distance: number, at: number): number {
  if (!(distance > 0) || !(at > 0)) return 0;
  const depth = distance / at - 1;
  return depth >= 0 ? focus.far * depth : focus.near * -depth;
}

export interface PerspSeg {
  readonly at: number;
  readonly dur: number;
  readonly from: PerspSpec;
  readonly to: PerspSpec;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
}

export interface PerspTrack {
  readonly base: PerspSpec;
  readonly segs: readonly PerspSeg[];
}

/** What a key of the camera may change; what it leaves out stays as it is. */
export interface PerspChange {
  readonly at: number;
  readonly dur: number;
  readonly aim?: Vec3;
  readonly distance?: number;
  readonly tilt?: number;
  readonly turn?: number;
  readonly lens?: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
}

function between(seg: PerspSeg, u: number): PerspSpec {
  if (u >= 1) return seg.to;
  const [a, b] = profileRamps(seg.profile, seg.ramp);
  const p = rampProgress(Math.max(0, u), a, b);
  const mix = (x: number, y: number): number => x + (y - x) * p;
  // A distance and a lens run as ratios: the picture grows at one apparent speed.
  const ratio = (x: number, y: number): number => (x === y ? x : x * (y / x) ** p);
  const f = seg.from;
  const t = seg.to;
  return {
    aim: [mix(f.aim[0], t.aim[0]), mix(f.aim[1], t.aim[1]), mix(f.aim[2], t.aim[2])],
    distance: ratio(f.distance, t.distance),
    tilt: mix(f.tilt, t.tilt),
    turn: mix(f.turn, t.turn),
    lens: ratio(f.lens, t.lens),
  };
}

/** The camera of a perspective layer at time t. */
export function perspAt(track: PerspTrack, t: number): PerspSpec {
  let seg: PerspSeg | null = null;
  for (const s of track.segs) {
    if (t >= s.at) seg = s;
    else break;
  }
  // A key of no time (at a hard cut) is there at once.
  return seg ? between(seg, seg.dur > 0 ? (t - seg.at) / seg.dur : 1) : track.base;
}

/** The track of a layer's camera keys. Keys chain: each takes over from where the camera is at its moment. */
export function buildPerspTrack(base: PerspSpec, keys: readonly PerspChange[]): PerspTrack {
  const segs: PerspSeg[] = [];
  for (const k of keys.slice().sort((p, q) => p.at - q.at)) {
    const from = perspAt({ base, segs }, k.at);
    const to: PerspSpec = { aim: k.aim ?? from.aim, distance: k.distance ?? from.distance, tilt: k.tilt ?? from.tilt, turn: k.turn ?? from.turn, lens: k.lens ?? from.lens };
    segs.push({ at: k.at, dur: k.dur, from, to, profile: k.profile, ramp: k.ramp });
  }
  return { base, segs };
}

/** The camera as the projection reads it: where it stands and its three directions. */
export interface Eye {
  readonly pos: Vec3;
  readonly right: Vec3;
  readonly down: Vec3;
  readonly fwd: Vec3;
  readonly lens: number;
}

export function eyeOf(p: PerspSpec): Eye {
  const st = Math.sin(p.tilt * DEG);
  const ct = Math.cos(p.tilt * DEG);
  const sp = Math.sin(p.turn * DEG);
  const cp = Math.cos(p.turn * DEG);
  const fwd: Vec3 = [ct * sp, st, ct * cp];
  return {
    pos: [p.aim[0] - fwd[0] * p.distance, p.aim[1] - fwd[1] * p.distance, p.aim[2] - fwd[2] * p.distance],
    right: [cp, 0, -sp],
    down: [-st * sp, ct, -st * cp],
    fwd,
    lens: p.lens,
  };
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A point is drawn when it is at least this share of the lens in front of the camera; nearer, it would fill the frame. */
export const NEAR_SHARE = 0.02;

/** A point of the space on the layer: where it is drawn, how large one unit is there (0: not drawn, it is too near or behind), and how far it is. */
export interface Projected {
  readonly x: number;
  readonly y: number;
  readonly k: number;
  readonly far: number;
}

export function project(eye: Eye, p: Vec3): Projected {
  const v: Vec3 = [p[0] - eye.pos[0], p[1] - eye.pos[1], p[2] - eye.pos[2]];
  const far = dot(v, eye.fwd);
  if (!(far > eye.lens * NEAR_SHARE)) return { x: 0, y: 0, k: 0, far };
  const k = eye.lens / far;
  return { x: dot(v, eye.right) * k, y: dot(v, eye.down) * k, k, far };
}

/** The two axes of a plane in the space, as unit vectors: where its own x and its own y point. */
export interface PlaneAxes {
  readonly x: Vec3;
  readonly y: Vec3;
}

/** Planes by name: the ground seen from above, a wall that faces the viewer, a wall that runs away from the viewer and faces right. */
export const PLANES: Readonly<Record<'floor' | 'wall' | 'side', PlaneAxes>> = {
  floor: { x: [1, 0, 0], y: [0, 0, -1] },
  wall: { x: [1, 0, 0], y: [0, 1, 0] },
  side: { x: [0, 0, 1], y: [0, 1, 0] },
};

/**
 * The axes of a plane that has turned on its hinges: `aboutX` degrees about
 * its own x axis (a positive turn lifts its +y edge toward its front), then
 * `aboutY` degrees about its own y axis (a positive turn lifts its +x edge
 * toward its front). The front of a plane is the side its picture reads from.
 */
export function hingedAxes(base: PlaneAxes, aboutX: number, aboutY: number): PlaneAxes {
  if (aboutX === 0 && aboutY === 0) return base;
  const front = cross(base.y, base.x);
  const sx = Math.sin(aboutX * DEG);
  const cx = Math.cos(aboutX * DEG);
  const y: Vec3 = [base.y[0] * cx + front[0] * sx, base.y[1] * cx + front[1] * sx, base.y[2] * cx + front[2] * sx];
  if (aboutY === 0) return { x: base.x, y };
  const turned = cross(y, base.x);
  const sy = Math.sin(aboutY * DEG);
  const cy = Math.cos(aboutY * DEG);
  return { x: [base.x[0] * cy + turned[0] * sy, base.x[1] * cy + turned[1] * sy, base.x[2] * cy + turned[2] * sy], y };
}

/**
 * The map of a plane onto the layer: the point (u, v) of the plane is drawn at
 * ((a u + c v + e) / w, (b u + d v + f) / w) with w = g u + h v + 1.
 */
export interface PlaneMap {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
  readonly g: number;
  readonly h: number;
  /** True when the camera sees the front of the plane. */
  readonly front: boolean;
}

/** The map of the plane through `origin` with the given axes, or null when the camera cannot see it: its origin is too near or behind, or it is edge-on. */
export function planeMap(eye: Eye, origin: Vec3, axes: PlaneAxes): PlaneMap | null {
  const o: Vec3 = [origin[0] - eye.pos[0], origin[1] - eye.pos[1], origin[2] - eye.pos[2]];
  const far = dot(o, eye.fwd);
  if (!(far > eye.lens * NEAR_SHARE)) return null;
  const facing = -dot(o, cross(axes.y, axes.x));
  if (Math.abs(facing) < 1e-6 * far) return null;
  const k = eye.lens / far;
  return {
    a: dot(axes.x, eye.right) * k,
    b: dot(axes.x, eye.down) * k,
    c: dot(axes.y, eye.right) * k,
    d: dot(axes.y, eye.down) * k,
    e: dot(o, eye.right) * k,
    f: dot(o, eye.down) * k,
    g: dot(axes.x, eye.fwd) / far,
    h: dot(axes.y, eye.fwd) / far,
    front: facing > 0,
  };
}

/** Where a point of a plane is drawn on the layer. */
export function planePoint(m: PlaneMap, p: Vec2): Vec2 {
  const w = m.g * p[0] + m.h * p[1] + 1;
  return [(m.a * p[0] + m.c * p[1] + m.e) / w, (m.b * p[0] + m.d * p[1] + m.f) / w];
}

/** The point of a plane that is drawn at a place of the layer: planePoint the other way round. */
export function intoPlane(m: PlaneMap, at: { readonly x: number; readonly y: number }): { x: number; y: number } {
  // (a - X g) u + (c - X h) v = X - e, and likewise for Y.
  const p = m.a - at.x * m.g;
  const q = m.c - at.x * m.h;
  const r = m.b - at.y * m.g;
  const w = m.d - at.y * m.h;
  const det = p * w - q * r;
  if (Math.abs(det) < 1e-12) return { x: 0, y: 0 };
  const dx = at.x - m.e;
  const dy = at.y - m.f;
  return { x: (dx * w - q * dy) / det, y: (p * dy - r * dx) / det };
}

/**
 * A transform in a plane as the layer sees it: its place exactly, its size
 * and its turn as they are at that place (a plane in perspective has no one
 * size). For what measures the layer: links, labels, the reviews.
 */
export function throughPlane(m: PlaneMap, xf: Xf): Xf {
  const w = m.g * xf.x + m.h * xf.y + 1;
  if (!(w > NEAR_SHARE)) return { x: 0, y: 0, rot: xf.rot, scale: 0 };
  const x = (m.a * xf.x + m.c * xf.y + m.e) / w;
  const y = (m.b * xf.x + m.d * xf.y + m.f) / w;
  const xu = (m.a - x * m.g) / w;
  const xv = (m.c - x * m.h) / w;
  const yu = (m.b - y * m.g) / w;
  const yv = (m.d - y * m.h) / w;
  return { x, y, rot: xf.rot + Math.atan2(yu, xu), scale: xf.scale * Math.sqrt(Math.abs(xu * yv - xv * yu)) };
}

/**
 * The plane a set of points of the space lies in best, as two unit axes
 * through their middle: for the outline a region or a stroke of such points
 * has when it is seen straight on.
 */
export function flatten(points: readonly Vec3[]): { readonly middle: Vec3; readonly flat: Vec2[] } {
  const n = points.length;
  const middle: Vec3 = [0, 0, 0].map((_, k) => points.reduce((s, p) => s + p[k]!, 0) / n) as unknown as Vec3;
  // Newell: the normal of a polygon that need not be quite flat.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % n]!;
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
  }
  let normal: Vec3 = [nx, ny, nz];
  let x: Vec3 = [0, 0, 0];
  // The first axis: toward the point farthest from the middle.
  let best = 0;
  for (const p of points) {
    const v: Vec3 = [p[0] - middle[0], p[1] - middle[1], p[2] - middle[2]];
    const len = Math.hypot(v[0], v[1], v[2]);
    if (len > best) {
      best = len;
      x = [v[0] / len, v[1] / len, v[2] / len];
    }
  }
  if (best === 0) return { middle, flat: points.map(() => [0, 0] as Vec2) };
  if (Math.hypot(normal[0], normal[1], normal[2]) < 1e-9) {
    // The points lie on one line: any plane through it will do.
    normal = cross(x, Math.abs(x[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
  }
  let y = cross(normal, x);
  const len = Math.hypot(y[0], y[1], y[2]);
  y = [y[0] / len, y[1] / len, y[2] / len];
  return { middle, flat: points.map((p) => [dot([p[0] - middle[0], p[1] - middle[1], p[2] - middle[2]], x), dot([p[0] - middle[0], p[1] - middle[1], p[2] - middle[2]], y)] as Vec2) };
}
