// Small 2D math used everywhere. All angles inside the engine are radians;
// the scene API takes degrees and converts at the boundary.

export type Vec2 = readonly [number, number];

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function vadd(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}

export function vsub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

export function vscale(a: Vec2, k: number): Vec2 {
  return [a[0] * k, a[1] * k];
}

export function vlen(a: Vec2): number {
  return Math.hypot(a[0], a[1]);
}

export function vdot(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

export function vnorm(a: Vec2): Vec2 {
  const l = Math.hypot(a[0], a[1]);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0];
}

export function vlerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function vrot(a: Vec2, rad: number): Vec2 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
}

/** Shortest signed difference between two angles in degrees, in (-180, 180]. */
export function angleDiffDeg(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * A similarity transform: translation, rotation and uniform scale.
 * Every node transform in the engine is one of these, which keeps the automatic
 * light simple: a shape never shears, so its light direction is just a rotation.
 */
export interface Xf {
  readonly x: number;
  readonly y: number;
  /** Rotation in radians. */
  readonly rot: number;
  readonly scale: number;
}

export const XF_IDENTITY: Xf = { x: 0, y: 0, rot: 0, scale: 1 };

/** The transform of a child expressed in the space its parent lives in. */
export function xfCompose(parent: Xf, child: Xf): Xf {
  const c = Math.cos(parent.rot);
  const s = Math.sin(parent.rot);
  return {
    x: parent.x + (child.x * c - child.y * s) * parent.scale,
    y: parent.y + (child.x * s + child.y * c) * parent.scale,
    rot: parent.rot + child.rot,
    scale: parent.scale * child.scale,
  };
}

export function xfApply(xf: Xf, p: Vec2): Vec2 {
  const c = Math.cos(xf.rot);
  const s = Math.sin(xf.rot);
  return [xf.x + (p[0] * c - p[1] * s) * xf.scale, xf.y + (p[0] * s + p[1] * c) * xf.scale];
}

/** A quadratic Bezier curve: start, control, end. */
export type Quad = readonly [Vec2, Vec2, Vec2];

/** A point on a quadratic curve at parameter t. */
export function quadAt(q: Quad, t: number): Vec2 {
  const u = 1 - t;
  return [
    u * u * q[0][0] + 2 * u * t * q[1][0] + t * t * q[2][0],
    u * u * q[0][1] + 2 * u * t * q[1][1] + t * t * q[2][1],
  ];
}

/** The part of a quadratic curve between parameters a and b, as a quadratic curve. */
export function quadSub(q: Quad, a: number, b: number): Quad {
  const k0 = (1 - a) * (1 - b);
  const k1 = (1 - a) * b + a * (1 - b);
  const k2 = a * b;
  return [
    quadAt(q, a),
    [k0 * q[0][0] + k1 * q[1][0] + k2 * q[2][0], k0 * q[0][1] + k1 * q[1][1] + k2 * q[2][1]],
    quadAt(q, b),
  ];
}
