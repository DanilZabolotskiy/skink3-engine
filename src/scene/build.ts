// Factory functions of the scene API. Each one validates its input, fills in
// defaults and returns plain data. Mistakes fail here, at definition time, with a
// message that says what to change.

import { springParams, type SpringSpec } from '../core/dynamics.ts';
import type { Vec2, Vec3 } from '../core/math.ts';
import { lightVector, type LightSpec } from '../look/light.ts';
import { ROLES, type ColorRef, type Palette } from '../look/palette.ts';
import { DEFAULT_RAMP, speedDistance, type MoveProfile, type SpeedKeys } from '../motion/curves.ts';
import { isSoundKey, type Key } from '../motion/intents.ts';
import { pathLength, type PathSpec } from '../motion/paths.ts';
import { frameCount } from '../core/time.ts';
import { Rng } from '../core/rng.ts';
import { globeRing, unitOf } from './globe.ts';
import {
  blobShape,
  capsuleShape,
  circleShape,
  polygonShape,
  rectShape,
  isRegion,
  REGION_MAX_FLAT_POINTS,
  REGION_MAX_POINTS,
  regionShape,
  regularPolygonShape,
  type ShapeSpec,
} from '../shape/geometry.ts';
import { TEXT_ALIGNS, type TextAlign } from '../text/block.ts';
import { isStringKey, type StringTables } from '../text/strings.ts';
import { compileShot } from './compile.ts';
import { flatten as seenStraightOn, PLANES, type PerspSpec, type PlaneAxes } from './space.ts';
import { CAST_MAX_LENGTH, DETAIL_MAX, FINDING_KINDS_ALL, HAZE_MAX, LINK_MAX_WIDTH, OPENING_SHAPES, RISE_MAX, ROOF_CONTRAST_MAX, ROOF_KINDS, STREAK_MAX } from './types.ts';
import type {
  BackgroundSpec,
  BodySpec,
  CameraPathSpec,
  CameraSpec,
  CastSpec,
  FogSpec,
  GlobeLayerSpec,
  GlobeSpec,
  DetailSpec,
  ContrastSpec,
  EmitterNode,
  EyeNode,
  GroupNode,
  HazeSpec,
  IdleSpec,
  IntendedSpec,
  LabelNode,
  LabelSide,
  LayerSpec,
  LevelSpec,
  LinkNode,
  FindingKind,
  OpeningsSpec,
  PhysicsSpec,
  RoofKind,
  RoofSpec,
  SceneNode,
  ShapeNode,
  ShotSpec,
  StrokeNode,
  TextNode,
  TurbulenceSpec,
} from './types.ts';

export class SceneError extends Error {}

export function fail(where: string, message: string): never {
  throw new SceneError(`${where}: ${message}`);
}

export function checkKeys(where: string, opts: object, allowed: readonly string[]): void {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) fail(where, 'expected an options object');
  for (const key of Object.keys(opts)) {
    if (!allowed.includes(key)) fail(where, `unknown option "${key}" (allowed: ${allowed.join(', ')})`);
  }
}

function idOf(where: string, value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)) {
    fail(where, `id must be a string of letters, digits, "_", "." or "-", starting with a letter; got ${JSON.stringify(value)}`);
  }
  return value;
}

export function num(where: string, name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(where, `${name} must be a number in ${min}..${max}, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function vec(where: string, name: string, value: unknown): Vec2 {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    fail(where, `${name} must be [x, y], got ${JSON.stringify(value)}`);
  }
  return [value[0] as number, value[1] as number];
}

function vec3(where: string, name: string, value: unknown): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    fail(where, `${name} must be [x, y, z], got ${JSON.stringify(value)}`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

/** A place: [x, y], or [x, y, z] for a node listed in a perspective layer. The third number is written only when it is given. */
function place(where: string, at: unknown): { at: Vec2; z?: number } {
  if (at === undefined) return { at: [0, 0] };
  if (Array.isArray(at) && at.length === 3) {
    const [x, y, z] = vec3(where, 'at', at);
    return { at: [x, y], z };
  }
  return { at: vec(where, 'at', at) };
}

/** The place of a node in the draw order of its layer, written only when it is given. */
function order(where: string, depth: unknown): { depth?: number } {
  return depth === undefined ? {} : { depth: num(where, 'depth', depth, -1e6, 1e6) };
}

/** Points of the space of a perspective layer, [x, y, z] each, or null: points of two numbers. */
function spacePoints(where: string, points: readonly unknown[]): Vec3[] | null {
  if (!points.some((p) => Array.isArray(p) && p.length === 3)) return null;
  return points.map((p, i) => vec3(where, `points[${i}]`, p));
}

/** The axes of the plane a group lies in: a name, or two directions of the space at right angles. */
function planeAxes(where: string, value: unknown): PlaneAxes {
  const expected = `plane must be one of ${Object.keys(PLANES).join(', ')}, or { x, y } with two directions [x, y, z]; got ${JSON.stringify(value)}`;
  if (typeof value === 'string') {
    if (!Object.hasOwn(PLANES, value)) fail(where, expected);
    return PLANES[value as keyof typeof PLANES];
  }
  if (value === null || typeof value !== 'object') fail(where, expected);
  checkKeys(`${where} plane`, value, ['x', 'y']);
  const unit = (name: string, v: unknown): Vec3 => {
    const d = vec3(where, `plane.${name}`, v);
    const len = Math.hypot(d[0], d[1], d[2]);
    if (!(len > 1e-9)) fail(where, `plane.${name} must be a direction; it has no length`);
    return [d[0] / len, d[1] / len, d[2] / len];
  };
  const x = unit('x', (value as { x?: unknown }).x);
  const y = unit('y', (value as { y?: unknown }).y);
  if (Math.abs(x[0] * y[0] + x[1] * y[1] + x[2] * y[2]) > 1e-6) fail(where, 'plane.x and plane.y must be at right angles');
  return { x, y };
}

/** The camera of a perspective layer, with what is left out filled in. */
function perspective(where: string, value: unknown): PerspSpec {
  const o = (value === true ? {} : value) as { aim?: unknown; distance?: unknown; tilt?: unknown; turn?: unknown; lens?: unknown };
  if (o === null || typeof o !== 'object' || Array.isArray(o)) fail(where, `perspective must be true or { aim, distance, tilt, turn, lens }, got ${JSON.stringify(value)}`);
  checkKeys(`${where} perspective`, o, ['aim', 'distance', 'tilt', 'turn', 'lens']);
  const distance = o.distance === undefined ? 1600 : num(where, 'perspective.distance', o.distance, 1, 1e6);
  return {
    aim: o.aim === undefined ? [0, 0, 0] : vec3(where, 'perspective.aim', o.aim),
    distance,
    tilt: o.tilt === undefined ? 0 : num(where, 'perspective.tilt', o.tilt, -90, 90),
    turn: o.turn === undefined ? 0 : num(where, 'perspective.turn', o.turn, -36000, 36000),
    lens: o.lens === undefined ? distance : num(where, 'perspective.lens', o.lens, 1, 1e6),
  };
}

function range(where: string, name: string, value: unknown, min: number, max: number): Vec2 {
  const v = typeof value === 'number' ? [value, value] : value;
  const [lo, hi] = vec(where, name, v);
  if (lo < min || hi > max || lo > hi) fail(where, `${name} must be [min, max] within ${min}..${max}, got ${JSON.stringify(value)}`);
  return [lo, hi];
}

function color(where: string, name: string, value: unknown): ColorRef {
  if (typeof value !== 'string' || !ROLES.some((r) => value.startsWith(`${r}.`))) {
    fail(where, `${name} must be a palette reference "role.name" with role one of ${ROLES.join(', ')}; got ${JSON.stringify(value)}. Raw colour values are not accepted in scenes`);
  }
  return value as ColorRef;
}

/** The sound key of a node, written into it only when it is given: a node without one is the data it always was. */
function voice(where: string, value: unknown): { sound?: string } {
  if (value === undefined) return {};
  if (!isSoundKey(value)) {
    fail(where, `sound must be the key of a sound such as "marble" or "glass.small" (lower-case parts joined by ".", "_" or "-"), got ${JSON.stringify(value)}`);
  }
  return { sound: value };
}

function spring(where: string, name: string, value: SpringSpec | undefined): SpringSpec | null {
  if (value === undefined) return null;
  // A spring is the name of a preset, or its three numbers and nothing else.
  if (value !== null && typeof value === 'object') checkKeys(`${where} ${name}`, value, ['f', 'z', 'r']);
  try {
    springParams(value);
  } catch (e) {
    fail(where, `${name}: ${(e as Error).message}`);
  }
  return value;
}

function idle(where: string, value: IdleSpec | undefined): IdleSpec | null {
  if (value === undefined) return null;
  checkKeys(`${where} idle`, value, ['amp', 'period']);
  return { amp: num(where, 'idle.amp', value.amp, 0, 400), period: num(where, 'idle.period', value.period, 0.2, 120) };
}

function body(where: string, value: BodySpec | undefined): BodySpec | null {
  if (value === undefined) return null;
  if (value.kind === 'fixed') {
    checkKeys(`${where} body`, value, ['kind', 'friction', 'restitution']);
    return value;
  }
  if (value.kind === 'dynamic') {
    checkKeys(`${where} body`, value, ['kind', 'release', 'velocity', 'spin', 'density', 'friction', 'restitution', 'appear']);
    num(where, 'body.release', value.release, -120, 3600);
    if (value.velocity !== undefined) vec(where, 'body.velocity', value.velocity);
    if (value.spin !== undefined) num(where, 'body.spin', value.spin, -3600, 3600);
    if (value.density !== undefined) num(where, 'body.density', value.density, 0.01, 100);
    if (value.appear !== undefined && value.appear !== 'always' && value.appear !== 'release') {
      fail(where, `body.appear must be "always" or "release", got ${JSON.stringify(value.appear)}`);
    }
    return value;
  }
  return fail(where, `body.kind must be "fixed" or "dynamic", got ${JSON.stringify((value as { kind?: unknown }).kind)}`);
}

function children(where: string, value: readonly SceneNode[] | undefined): readonly SceneNode[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(where, 'children must be an array of nodes');
  return value;
}

/** Options every shape factory accepts. */
export interface ShapeOptions {
  id: string;
  /** Palette reference, e.g. "mid.violet". */
  fill: ColorRef;
  /** Position in the parent's space; default [0, 0]. */
  /** [x, y]; listed in a perspective layer, [x, y, z]: the third number is how far away it is. */
  at?: Vec2 | Vec3;
  /** Listed in a layer: its place in the draw order. The larger depth is drawn first, behind the rest; default 0. */
  depth?: number;
  /** Degrees, clockwise; default 0. */
  rotation?: number;
  /** Default 1. */
  scale?: number;
  /** 0..1 at the start; default 1. Animate it with fadeTo(). */
  opacity?: number;
  /** Automatic light; default true. */
  lit?: boolean;
  /** false: the automatic light without its highlight stroke, for an outline with deep bays and long capes. */
  highlight?: boolean;
  /** 0..1; default 0. */
  glow?: number;
  /** 0..1: how much of its glow's lift of the background a glowing shape draws; default 1. 0 keeps the halo alone. */
  lift?: number;
  /** Thin coloured rim light on the shadow side. */
  rimLight?: ColorRef;
  /** Nodes that move with this shape and are drawn on top of it. */
  children?: readonly SceneNode[];
  /** Follow the rest position through a spring: a preset name or { f, z, r }. */
  follow?: SpringSpec;
  /** Gentle endless wandering. */
  idle?: IdleSpec;
  /** Make it a rigid body of the physics bake. */
  body?: BodySpec;
  /** An opaque thing in front: the glow of what is drawn before it in its layer does not shine through it; default false. */
  cover?: boolean;
  /** Labels may lie over it without a covers-node warning (ground, a wall, a backdrop); default false. */
  backdrop?: boolean;
  /**
   * In a plane of a perspective layer: true stands the shape up from the plane, flat, as a sail or a sign stands. Its
   * own x runs along the plane, turned with its rotation; its own y runs straight up, and the points with a y below 0
   * stand over its place (a sail: [[-30, 0], [30, 0], [0, -80]]). Not for a body (rise). Elsewhere it is drawn as any
   * shape. Default false.
   */
  stands?: boolean;
  /** Id of a shape of the same layer: this shape and its children are drawn only inside that shape's outline. */
  clipTo?: string;
  /**
   * What is clipped to this shape is kept inside it by a mask of its outline, not by Skia's clip: Skia cuts a clip out
   * of the canvas by an operation on paths, which may fail on an outline of several hundred bends (a coast) and drop the
   * clip without a word. A soft group clipped to it keeps its blur inside it. Costs a picture of the frame's size for
   * each clip. Default false: a clip is made as it always was.
   */
  clipMask?: boolean;
  /**
   * Makes the shape a content that fills its outline from the bottom: a number
   * 0..1 (how full it is at the start), or { at, wave } with a ripple of the
   * surface, wave: { amp, length?, speed? }. Animate it with levelTo().
   */
  level?: number | { at: number; wave?: { amp: number; length?: number; speed?: number } };
  /** Units, up to 200: the shape and what is in it are drawn as one picture, blurred this far: a soft edge, a soft shadow. */
  soft?: number;
  /**
   * Units, 0 to 2000: the shape is the top of a body this high, standing on its place: the top is drawn that far up
   * the screen, the side of the body under it, and its children ride on the top. In a plane of a perspective layer
   * the body stands on the plane and is seen in perspective. 0 lies flat until a riseTo() raises it.
   */
  rise?: number;
  /** With rise: the colour of the side of the body; default a shadow tone of the fill. */
  side?: ColorRef;
  /**
   * A heat haze: the picture drawn before the shape, inside its outline (fading out across it with soft), wavers like
   * air over heat, and what is drawn after it stays steady. amount: units of the layer, up to 60, how far it moves
   * the picture at most; scale: the size of its ripples (40); speed: units per second they drift (30); direction:
   * degrees where they drift (-90, up). For a shape listed directly in a flat layer. Animate it with hazeTo().
   */
  haze?: { amount: number; scale?: number; speed?: number; direction?: number };
  /**
   * With rise, on a circle, a capsule, a rect or a polygon: a roof on the body in place of its flat top. kind:
   * 'gable' (two slopes and a ridge), 'hip' (four slopes), 'cone' (slopes to one point) or 'dome' (a round cap);
   * height: units over the top of the body, 0.01 to 2000; ridge: where the ridge of a gable or a hip runs, in degrees
   * (default: along the longer side). The slopes are the fill in the tones of the light, the upright ends the side.
   * On a region, a 'hip' alone: a slope on every stretch of the outline, all as steep, meeting in ridges and valleys;
   * height is its highest point, and run (units) how far in the slopes run before the roof is flat at that height
   * (default: to the middle). contrast: how far the tones of the slopes lie from the fill (default 1; 0 to 2).
   */
  roof?: { kind: RoofKind; height: number; ridge?: number; run?: number; contrast?: number };
  /**
   * With rise: rows of openings painted on the side of the body, on every face the viewer sees. width and height of
   * one opening, in units; shape 'rect' (default) or 'arch'; step: from one middle to the next (default twice the
   * width); rows (default 1): they share the height of the body at its highest; sill: the foot of an opening over the
   * foot of its row (default: the opening sits in the middle of its row); inset: the least plain wall at a corner
   * (default half a gap); color (default: a deep shadow tone of the side).
   */
  openings?: { shape?: 'rect' | 'arch'; width: number; height: number; step?: number; rows?: number; sill?: number; inset?: number; color?: ColorRef };
  /** Key of the node's voice in the bank of sounds: what its intents and its contacts sound like. */
  sound?: string;
}

const SHAPE_KEYS = [
  'id', 'fill', 'at', 'rotation', 'scale', 'opacity', 'lit', 'highlight', 'glow', 'lift', 'rimLight', 'children', 'follow', 'idle', 'body',
  'cover', 'backdrop', 'clipTo', 'level', 'sound', 'depth', 'soft', 'rise', 'side', 'haze', 'roof', 'openings', 'stands', 'clipMask',
];

/** What a heat haze is when only its amount is given. */
export const HAZE_DEFAULTS = { scale: 40, speed: 30, direction: -90 } as const;

/** A heat haze: written only when it is given, so that a shape without it is the data it always was. */
function hazy(where: string, o: ShapeOptions): { haze?: HazeSpec } {
  const h = o.haze;
  if (h === undefined) return {};
  if (h === null || typeof h !== 'object') fail(where, `haze must be { amount, scale?, speed?, direction? }, got ${JSON.stringify(h)}`);
  checkKeys(`${where} haze`, h, ['amount', 'scale', 'speed', 'direction']);
  const busy = (['body', 'level', 'rise', 'clipTo'] as const).filter((name) => o[name] !== undefined);
  if (busy.length > 0) {
    fail(where, `a shape with a haze cannot have ${busy.join(', ')}: the haze moves the picture behind a plain outline; give the ${busy.join(', ')} to another shape`);
  }
  return {
    haze: {
      amount: num(where, 'haze.amount', h.amount, 0, HAZE_MAX),
      scale: h.scale === undefined ? HAZE_DEFAULTS.scale : num(where, 'haze.scale', h.scale, 4, 4000),
      speed: h.speed === undefined ? HAZE_DEFAULTS.speed : num(where, 'haze.speed', h.speed, 0, 10000),
      direction: h.direction === undefined ? HAZE_DEFAULTS.direction : num(where, 'haze.direction', h.direction, -3600, 3600),
    },
  };
}

/** The widest blur of a soft node, in its units. */
const SOFT_MAX = 200;

/** A soft node: written only when it is given, so that a node without it is the data it always was. */
function softness(where: string, value: unknown): { soft?: number } {
  return value === undefined ? {} : { soft: num(where, 'soft', value, 0, SOFT_MAX) };
}

/** A body with a height: written only when it is given, so that a node without it is the data it always was. */
function risen(where: string, o: { rise?: number; side?: ColorRef }, what: string): { rise?: number; side?: ColorRef } {
  if (o.rise === undefined) {
    if (o.side !== undefined) fail(where, `side is the colour of the side of a ${what} with a height: give rise, or leave side out`);
    return {};
  }
  return { rise: num(where, 'rise', o.rise, 0, RISE_MAX), ...(o.side === undefined ? {} : { side: color(where, 'side', o.side) }) };
}

/** The roof of a body: written only when it is given, so that a node without it is the data it always was. */
function roofOf(where: string, o: ShapeOptions, shape: ShapeSpec): { roof?: RoofSpec } {
  const r = o.roof;
  if (r === undefined) return {};
  if (o.rise === undefined) fail(where, 'roof is the roof of a shape with a height: give rise (0 lies flat until a riseTo), or leave roof out');
  checkKeys(`${where}: roof`, r, ['kind', 'height', 'ridge', 'run', 'contrast']);
  if (!ROOF_KINDS.includes(r.kind)) fail(where, `roof.kind must be one of ${ROOF_KINDS.join(', ')}; got ${JSON.stringify(r.kind)}`);
  if (shape.kind === 'blob') fail(where, 'a roof stands on a circle, a capsule, a rect, a polygon or a region; a blob has a free outline and keeps its flat top: leave roof out');
  const region = isRegion(shape);
  if (region && r.kind !== 'hip') fail(where, `a region takes a hip roof alone: a slope on every stretch of its outline; a ${r.kind} stands on a circle, a capsule, a rect or a polygon`);
  if (r.ridge !== undefined && r.kind !== 'gable' && r.kind !== 'hip') fail(where, `roof.ridge is where the ridge of a gable or a hip runs; a ${r.kind} has no ridge: leave ridge out`);
  if (r.ridge !== undefined && region) fail(where, 'the ridges of a hip on a region follow its outline: leave ridge out');
  if (r.run !== undefined && !region) fail(where, 'roof.run is how far in the slopes of a hip on a region run; on this shape the slopes meet in the ridge: leave run out');
  return {
    roof: {
      kind: r.kind,
      height: num(where, 'roof.height', r.height, 0.01, RISE_MAX),
      ...(r.ridge === undefined ? {} : { ridge: num(where, 'roof.ridge', r.ridge, -1e5, 1e5) }),
      ...(r.run === undefined ? {} : { run: num(where, 'roof.run', r.run, 0.01, 1e5) }),
      ...(r.contrast === undefined ? {} : { contrast: num(where, 'roof.contrast', r.contrast, 0, ROOF_CONTRAST_MAX) }),
    },
  };
}

/** The openings of the side of a body: written only when they are given, so that a node without them is the data it always was. */
function openingsOf(where: string, o: { rise?: number; openings?: ShapeOptions['openings'] }, what = 'shape'): { openings?: OpeningsSpec } {
  const g = o.openings;
  if (g === undefined) return {};
  if (o.rise === undefined) fail(where, `openings are painted on the side of a ${what} with a height: give rise (0 lies flat until a riseTo), or leave openings out`);
  checkKeys(`${where}: openings`, g, ['shape', 'width', 'height', 'step', 'rows', 'sill', 'inset', 'color']);
  const shape = g.shape ?? 'rect';
  if (!OPENING_SHAPES.includes(shape)) fail(where, `openings.shape must be one of ${OPENING_SHAPES.join(', ')}; got ${JSON.stringify(shape)}`);
  const width = num(where, 'openings.width', g.width, 0.01, RISE_MAX);
  const height = num(where, 'openings.height', g.height, 0.01, RISE_MAX);
  const step = g.step === undefined ? 2 * width : num(where, 'openings.step', g.step, 0.01, 1e5);
  if (step < width) fail(where, `openings.step is ${step} and the openings are ${width} wide: they would lie over each other; give a step of ${width} at least`);
  const rows = g.rows === undefined ? 1 : num(where, 'openings.rows', g.rows, 1, 64);
  if (!Number.isInteger(rows)) fail(where, `openings.rows must be a whole number, got ${rows}`);
  return {
    openings: {
      shape,
      width,
      height,
      step,
      rows,
      ...(g.sill === undefined ? {} : { sill: num(where, 'openings.sill', g.sill, 0, RISE_MAX) }),
      inset: g.inset === undefined ? (step - width) / 2 : num(where, 'openings.inset', g.inset, 0, 1e5),
      ...(g.color === undefined ? {} : { color: color(where, 'openings.color', g.color) }),
    },
  };
}

/** The shadows the bodies of a group cast: written only when they are given, so that a group without them is the data it always was. */
function castOf(where: string, value: unknown): { cast?: CastSpec } {
  if (value === undefined) return {};
  const c = value as { color?: unknown; opacity?: unknown; dir?: unknown; length?: unknown; soft?: unknown; over?: unknown };
  checkKeys(`${where}: cast`, c, ['color', 'opacity', 'dir', 'length', 'soft', 'over']);
  if (c.color === undefined) fail(where, 'cast needs a color: the colour of the shadows, a palette reference; the engine has none of its own');
  if (c.over !== undefined && c.over !== 'flat') fail(where, `cast.over must be "flat" (the shadows lie over the flat members of the group and under its raised ones), got ${JSON.stringify(c.over)}; leave it out to draw them under all the members`);
  return {
    cast: {
      color: color(where, 'cast.color', c.color),
      opacity: c.opacity === undefined ? CAST_DEFAULTS.opacity : num(where, 'cast.opacity', c.opacity, 0, 1),
      ...(c.dir === undefined ? {} : { dir: num(where, 'cast.dir', c.dir, -1e5, 1e5) }),
      length: c.length === undefined ? CAST_DEFAULTS.length : num(where, 'cast.length', c.length, 0, CAST_MAX_LENGTH),
      soft: c.soft === undefined ? CAST_DEFAULTS.soft : num(where, 'cast.soft', c.soft, 0, SOFT_MAX),
      // Written only when it is given: a cast without it is the data it always was.
      ...(c.over === undefined ? {} : { over: 'flat' as const }),
    },
  };
}

/** The detail the bodies of a group are worth: written only when it is given, so that a group without it is the data it always was. */
function detailOf(where: string, value: unknown): { detail?: DetailSpec } {
  if (value === undefined) return {};
  const d = value as { min?: unknown };
  checkKeys(`${where}: detail`, d, ['min']);
  if (d.min === undefined) fail(where, 'detail needs min: the size on screen, in units of the stage, below which a body is drawn plain (0: none is)');
  return { detail: { min: num(where, 'detail.min', d.min, 0, DETAIL_MAX) } };
}

/** The depth haze of a group in a plane: written only when it is given, so that a group without it is the data it always was. */
/** The ground of a plane: one id, or a list of at least one, as given. */
function groundOf(where: string, value: unknown): string | readonly string[] {
  if (typeof value === 'string') return idOf(where, value);
  if (!Array.isArray(value) || value.length === 0) fail(where, 'ground must be the id of a relief among the group\'s children, or a list of such ids');
  return value.map((id) => idOf(where, id));
}

function fogOf(where: string, value: unknown): { fog?: FogSpec } {
  if (value === undefined) return {};
  const f = value as { color?: unknown; near?: unknown; far?: unknown; amount?: unknown; fade?: { near?: unknown; far?: unknown } | null };
  checkKeys(`${where}: fog`, f, ['color', 'near', 'far', 'amount', 'fade']);
  if (f.color === undefined) fail(where, 'fog needs a color: what the far ground turns toward, a palette reference; the engine has none of its own');
  const near = num(where, 'fog.near', f.near, 0, 1e7);
  const far = num(where, 'fog.far', f.far, 0, 1e7);
  if (!(far > near)) fail(where, `fog.far (${far}) must lie beyond fog.near (${near})`);
  let fade: { near: number; far: number } | undefined;
  if (f.fade !== undefined) {
    if (f.fade === null || typeof f.fade !== 'object') fail(where, 'fog.fade must be { near, far }: the distances over which the plane fades out');
    checkKeys(`${where}: fog.fade`, f.fade, ['near', 'far']);
    fade = { near: num(where, 'fog.fade.near', f.fade.near, 0, 1e7), far: num(where, 'fog.fade.far', f.fade.far, 0, 1e7) };
    if (!(fade.far > fade.near)) fail(where, `fog.fade.far (${fade.far}) must lie beyond fog.fade.near (${fade.near})`);
  }
  return { fog: { color: color(where, 'fog.color', f.color), near, far, amount: f.amount === undefined ? 1 : num(where, 'fog.amount', f.amount, 0, 1), ...(fade ? { fade } : {}) } };
}

/** What a cast is when it says nothing more than its colour. */
export const CAST_DEFAULTS = { opacity: 0.35, length: 0.7, soft: 0 } as const;

function flag(where: string, name: string, value: unknown): boolean {
  if (typeof value !== 'boolean') fail(where, `${name} must be true or false, got ${JSON.stringify(value)}`);
  return value;
}

function level(where: string, value: ShapeOptions['level']): LevelSpec {
  if (typeof value === 'number') return { at: num(where, 'level', value, 0, 1), wave: null };
  if (value === null || typeof value !== 'object') fail(where, `level must be a number 0..1 or { at, wave }, got ${JSON.stringify(value)}`);
  checkKeys(`${where} level`, value, ['at', 'wave']);
  let wave: LevelSpec['wave'] = null;
  if (value.wave !== undefined) {
    checkKeys(`${where} level.wave`, value.wave, ['amp', 'length', 'speed']);
    wave = {
      amp: num(where, 'level.wave.amp', value.wave.amp, 0, 200),
      length: num(where, 'level.wave.length', value.wave.length ?? 160, 4, 1e5),
      speed: num(where, 'level.wave.speed', value.wave.speed ?? 40, -1e4, 1e4),
    };
  }
  return { at: num(where, 'level.at', value.at, 0, 1), wave };
}

/** Options that are written into a node only when they are given, so that a node without them is the data it always was. */
function extras(where: string, o: { cover?: boolean; backdrop?: boolean; clipTo?: string; level?: ShapeOptions['level']; stands?: boolean; rise?: unknown; clipMask?: boolean }): {
  cover?: boolean;
  backdrop?: boolean;
  clipTo?: string;
  level?: LevelSpec;
  stands?: boolean;
  clipMask?: boolean;
} {
  if (o.stands && o.rise !== undefined) fail(where, 'stands is for a flat shape that stands up from its plane; a body with a rise stands already: leave one out');
  return {
    ...(o.stands ? { stands: flag(where, 'stands', o.stands) } : {}),
    ...(o.clipMask ? { clipMask: flag(where, 'clipMask', o.clipMask) } : {}),
    ...(o.cover === undefined ? {} : { cover: flag(where, 'cover', o.cover) }),
    ...(o.backdrop === undefined ? {} : { backdrop: flag(where, 'backdrop', o.backdrop) }),
    ...(o.clipTo === undefined ? {} : { clipTo: idOf(where, o.clipTo) }),
    ...(o.level === undefined ? {} : { level: level(where, o.level) }),
  };
}

/** The options of the light and the glow that are written into a node only when they are given. */
function lightExtras(where: string, o: ShapeOptions): { highlight?: boolean; lift?: number } {
  const out: { highlight?: boolean; lift?: number } = {};
  if (o.highlight !== undefined) {
    out.highlight = flag(where, 'highlight', o.highlight);
    if (o.lit === false) fail(where, 'highlight is a part of the automatic light, and the shape is not lit (lit: false); leave highlight out');
  }
  if (o.lift !== undefined) {
    out.lift = num(where, 'lift', o.lift, 0, 1);
    if (!(typeof o.glow === 'number' && o.glow > 0)) fail(where, 'lift is the share of the lift of the background that the glow of the shape draws, and the shape has no glow; give it a glow, or leave lift out');
  }
  return out;
}

function shapeNode(where: string, o: ShapeOptions, shape: ShapeSpec, sway: SpringSpec | null): ShapeNode {
  if (o.level !== undefined && o.body !== undefined) fail(where, 'a rigid body cannot have a level');
  if (o.rise !== undefined && o.body !== undefined) fail(where, 'a rigid body cannot have a rise: the simulation knows its outline alone');
  if (o.rise !== undefined && o.level !== undefined) fail(where, 'a shape with a level cannot have a rise: a content fills an outline that lies flat');
  return {
    ...extras(where, o),
    ...lightExtras(where, o),
    ...softness(where, o.soft),
    ...risen(where, o, 'shape'),
    ...hazy(where, o),
    ...roofOf(where, o, shape),
    ...openingsOf(where, o),
    ...order(where, o.depth),
    ...voice(where, o.sound),
    type: 'shape',
    id: idOf(where, o.id),
    shape,
    fill: color(where, 'fill', o.fill),
    ...place(where, o.at),
    rotation: o.rotation === undefined ? 0 : num(where, 'rotation', o.rotation, -1e5, 1e5),
    scale: o.scale === undefined ? 1 : num(where, 'scale', o.scale, 0.01, 100),
    opacity: o.opacity === undefined ? 1 : num(where, 'opacity', o.opacity, 0, 1),
    lit: o.lit ?? true,
    glow: o.glow === undefined ? 0 : num(where, 'glow', o.glow, 0, 1),
    rimLight: o.rimLight === undefined ? null : color(where, 'rimLight', o.rimLight),
    children: children(where, o.children),
    follow: spring(where, 'follow', o.follow),
    sway,
    idle: idle(where, o.idle),
    body: body(where, o.body),
  };
}

function wrapShape<T>(where: string, make: () => T): T {
  try {
    return make();
  } catch (e) {
    if (e instanceof SceneError) throw e;
    return fail(where, (e as Error).message);
  }
}

/** A circle of radius r. */
export function circle(o: ShapeOptions & { r: number }): ShapeNode {
  const where = `circle("${o?.id}")`;
  checkKeys(where, o, [...SHAPE_KEYS, 'r']);
  return shapeNode(where, o, wrapShape(where, () => circleShape(o.r)), null);
}

/**
 * A capsule (a stick with round ends) along its local x axis. With origin
 * 'start' its first end is a pivot, and `sway` lets the free end lag on a spring.
 */
export function capsule(o: ShapeOptions & { length: number; r: number; origin?: 'center' | 'start'; sway?: SpringSpec }): ShapeNode {
  const where = `capsule("${o?.id}")`;
  checkKeys(where, o, [...SHAPE_KEYS, 'length', 'r', 'origin', 'sway']);
  const origin = o.origin ?? 'center';
  if (origin !== 'center' && origin !== 'start') fail(where, `origin must be "center" or "start", got ${JSON.stringify(origin)}`);
  if (o.sway !== undefined && origin !== 'start') fail(where, 'sway needs origin: "start" (the stick sways around its first end)');
  if (o.sway !== undefined && o.follow !== undefined) fail(where, 'use either sway or follow, not both');
  return shapeNode(where, o, wrapShape(where, () => capsuleShape(o.length, o.r, origin)), spring(where, 'sway', o.sway));
}

/**
 * A rounded convex polygon: regular ({ sides, r }) or from explicit corners
 * ({ points }). `radius` is the corner radius.
 */
export function polygon(
  o: ShapeOptions & ({ sides: number; r: number; radius?: number } | { points: readonly Vec2[]; radius?: number }),
): ShapeNode {
  const where = `polygon("${o?.id}")`;
  checkKeys(where, o, [...SHAPE_KEYS, 'sides', 'r', 'points', 'radius']);
  const shape = wrapShape(where, () => {
    if ('points' in o && o.points !== undefined) return polygonShape(o.points.map((p) => vec(where, 'points[]', p)), o.radius ?? 0);
    if ('sides' in o) return regularPolygonShape(o.sides, o.r, o.radius ?? o.r * 0.16);
    return fail(where, 'give either { sides, r } or { points }');
  });
  return shapeNode(where, o, shape, null);
}

/**
 * A free-form closed outline through `points`, as one shape: the outline of
 * a map, an island, a pool. It may be concave, with bays and capes; it may not
 * cross itself. `smooth` 1 joins the points with a smooth curve, 0 with
 * straight edges. It is lit, glows, fades, clips and fills like any shape; it
 * cannot be a rigid body.
 */
export function region(o: ShapeOptions & { points: readonly Vec2[] | readonly Vec3[]; smooth?: number; back?: boolean }): ShapeNode {
  const where = `region("${o?.id}")`;
  checkKeys(where, o, [...SHAPE_KEYS, 'points', 'smooth', 'back']);
  if (o.body !== undefined) fail(where, 'a region cannot be a rigid body: a body is a convex shape (compose the ground of several)');
  if (!Array.isArray(o.points)) fail(where, 'points must be a list of points [x, y]');
  // A region that is drawn flat takes more points than a lit one: the light is cut out of the outline, and that fails on thousands of points.
  const most = o.lit === false ? REGION_MAX_FLAT_POINTS : REGION_MAX_POINTS;
  if (o.points.length > most) fail(where, `region: at most ${most} points, got ${o.points.length}${o.lit === false ? '' : `; a region without the light (lit: false) takes up to ${REGION_MAX_FLAT_POINTS}`}`);
  // Points of three numbers: a region of the space of a perspective layer. Its shape is then the outline seen straight on.
  const solid = spacePoints(where, o.points);
  if (o.back !== undefined && !solid) fail(where, 'back is for a region of points of the space of a perspective layer, [x, y, z] each');
  if (solid && o.level !== undefined) fail(where, 'a region of points [x, y, z] cannot have a level');
  if (solid && o.rise !== undefined) fail(where, 'a region of points [x, y, z] cannot have a rise: its points give its place in the space; put a flat region with a rise into a group that lies in a plane');
  const shape = wrapShape(where, () => regionShape(solid ? seenStraightOn(solid).flat : o.points.map((p, i) => vec(where, `points[${i}]`, p)), o.smooth === undefined ? 1 : num(where, 'smooth', o.smooth, 0, 1), most));
  const node = shapeNode(where, o, shape, null);
  return solid ? { ...node, points3: solid, ...(o.back === undefined ? {} : { back: flag(where, 'back', o.back) }) } : node;
}

/** A rounded rectangle centred on its position. */
export function rect(o: ShapeOptions & { w: number; h: number; radius?: number }): ShapeNode {
  const where = `rect("${o?.id}")`;
  checkKeys(where, o, [...SHAPE_KEYS, 'w', 'h', 'radius']);
  return shapeNode(where, o, wrapShape(where, () => rectShape(o.w, o.h, o.radius ?? Math.min(o.w, o.h) * 0.22)), null);
}

/**
 * A field of heights drawn as the light falls on it: relief shading of a map from a grid of elevations (a digital
 * elevation model), over a rect `w` by `h` around its place. The grid's first row lies along the top of the rect, its
 * first point at the left. Each pixel the field covers is worked out at the size the frame draws it, the grid read
 * between its points along smooth curves, so a camera that comes near finds no pixels in it. In a plane of a
 * perspective layer it lies on the plane, as any shape does; with clipTo it is drawn inside another shape (the land).
 *
 * - heights: { cols, rows, values }: cols * rows heights, row by row, in any unit (metres, say).
 * - vertical: units of the scene to one unit of height (default 1): how steep the slopes are drawn.
 * - sun: { from, high }: degrees, where the light comes from in the rect's plane (0 from its right, -90 from its top;
 *   default -135, the top left) and how high it stands over the ground (default 45).
 * - dark, bright: palette references: the tone of the slopes turned from the light and of those turned to it.
 * - amount: 0..1, how far a slope turns toward them (default 0.7).
 * - tints: [[height, colour], ...] from the lowest: the ground tinted by its height, shaded over it. Left out: only
 *   the shading is drawn, the dark and the bright tones as strong as each slope is, over what lies under the field.
 * - feather: units of the rect: the field fades out smoothly over this distance toward its edges, so that it melts
 *   into what lies under it (a far edge into the haze, a fine field into a coarse one under it). Left out: it ends
 *   sharp at its edges.
 */
export function relief(o: {
  id: string;
  at?: Vec2 | Vec3;
  depth?: number;
  rotation?: number;
  scale?: number;
  opacity?: number;
  clipTo?: string;
  w: number;
  h: number;
  heights: { cols: number; rows: number; values: ArrayLike<number> };
  vertical?: number;
  sun?: { from?: number; high?: number };
  dark: ColorRef;
  bright: ColorRef;
  amount?: number;
  tints?: readonly (readonly [number, ColorRef])[];
  feather?: number;
}): ShapeNode {
  const where = `relief("${o?.id}")`;
  checkKeys(where, o, ['id', 'at', 'depth', 'rotation', 'scale', 'opacity', 'clipTo', 'w', 'h', 'heights', 'vertical', 'sun', 'dark', 'bright', 'amount', 'tints', 'feather']);
  const g = o.heights;
  if (g === null || typeof g !== 'object') fail(where, 'heights must be { cols, rows, values }');
  checkKeys(`${where} heights`, g, ['cols', 'rows', 'values']);
  const cols = num(where, 'heights.cols', g.cols, 2, 8192);
  const rows = num(where, 'heights.rows', g.rows, 2, 8192);
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) fail(where, `heights.cols and heights.rows must be whole numbers, got ${cols} and ${rows}`);
  if (!g.values || typeof g.values.length !== 'number' || g.values.length !== cols * rows) fail(where, `heights.values must hold cols * rows = ${cols * rows} heights, got ${g.values?.length}`);
  const heights = Float32Array.from(g.values);
  for (let i = 0; i < heights.length; i++) if (!Number.isFinite(heights[i])) fail(where, `heights.values[${i}] is not a finite number`);
  if (o.sun !== undefined) checkKeys(`${where} sun`, o.sun, ['from', 'high']);
  let tints: [number, ColorRef][] | undefined;
  if (o.tints !== undefined) {
    if (!Array.isArray(o.tints) || o.tints.length === 0) fail(where, 'tints must be a list of [height, colour], from the lowest');
    tints = o.tints.map((t, k) => {
      if (!Array.isArray(t) || t.length !== 2) fail(where, `tints[${k}] must be [height, colour]`);
      return [num(where, `tints[${k}][0]`, t[0], -1e6, 1e6), color(where, `tints[${k}][1]`, t[1])];
    });
    for (let k = 1; k < tints.length; k++) if (!(tints[k]![0] > tints[k - 1]![0])) fail(where, `tints must run from the lowest height up; tints[${k}] is at ${tints[k]![0]}, after ${tints[k - 1]![0]}`);
  }
  const base = shapeNode(where, { id: o.id, fill: o.dark, lit: false, ...(o.at === undefined ? {} : { at: o.at }), ...(o.depth === undefined ? {} : { depth: o.depth }), ...(o.rotation === undefined ? {} : { rotation: o.rotation }), ...(o.scale === undefined ? {} : { scale: o.scale }), ...(o.opacity === undefined ? {} : { opacity: o.opacity }), ...(o.clipTo === undefined ? {} : { clipTo: o.clipTo }) }, wrapShape(where, () => rectShape(num(where, 'w', o.w, 1, 1e6), num(where, 'h', o.h, 1, 1e6), 0)), null);
  return {
    ...base,
    relief: {
      cols,
      rows,
      heights,
      vertical: o.vertical === undefined ? 1 : num(where, 'vertical', o.vertical, 1e-6, 1e6),
      from: o.sun?.from === undefined ? -135 : num(where, 'sun.from', o.sun.from, -3600, 3600),
      high: o.sun?.high === undefined ? 45 : num(where, 'sun.high', o.sun.high, 1, 89),
      amount: o.amount === undefined ? 0.7 : num(where, 'amount', o.amount, 0, 1),
      dark: color(where, 'dark', o.dark),
      bright: color(where, 'bright', o.bright),
      ...(tints ? { tints } : {}),
      ...(o.feather === undefined ? {} : { feather: num(where, 'feather', o.feather, 0, 1e6) }),
    },
  };
}

/** A ring of a globe's layer, or a line on a globe: places [lon, lat] in degrees. */
export type LonLat = readonly [number, number];

/**
 * A globe: a round body seen from far away, turned so that one place faces the viewer, turning about its axis, with
 * the outlines of its surface on it (the land and seas of the Earth, the dark seas of the Moon: any polygons in
 * degrees, such as skink3-geo's globe.mjs writes). Light from one side leaves a night side with a soft terminator;
 * lights may shine on the night side alone; a thin rim of air may stand round the disc.
 *
 * Its children stand on it. A child placed at [lon, lat] (at: [lon, lat, height] for one over the surface, in units)
 * rides the turn and hides behind the disc; its rotation is its heading (0 east, 90 north), so a travel with orient
 * faces along its way. A stroke among its children is a line on the surface: its points are [lon, lat], joined as on
 * a map, and the part of it on the far side is hidden. Neither is darkened by the night.
 */
export function globe(o: {
  id: string;
  /** Units: the radius of the disc. */
  r: number;
  /** The colour of the disc under its layers: the sea of the Earth, the highlands of the Moon. */
  fill: ColorRef;
  /** Degrees [lon, lat] of the place that faces the viewer at the start; default [0, 0]. 90 looks down on the north pole. */
  view?: LonLat;
  /** Degrees per second it turns east (the way the Earth turns: what faces the viewer moves left to right), or keys [seconds, degrees per second], smooth between them; default 0. */
  spin?: number | SpeedKeys;
  /**
   * The layers of the surface, painted in order: rings of [lon, lat], outer rings counter-clockwise seen from
   * outside and holes clockwise (as skink3-geo writes them), filled non-zero. drift turns a layer east over the
   * body (clouds), degrees per second; soft blurs its edges, a share of the radius.
   */
  layers?: readonly { rings: readonly (readonly LonLat[])[]; fill: ColorRef; opacity?: number; drift?: number; soft?: number }[];
  /**
   * The sun: from (degrees, 0 from the right, -90 from the top; default -135), lit (the share of the disc it lights,
   * 0 a new moon, 0.5 a half, 1 full; default 0.7), and the night: its colour, amount (0..1, how dark; default 0.8)
   * and soft (a share of the radius, how soft the terminator is; default 0.05). Left out: lit all over.
   */
  light?: { from?: number; lit?: number; night: ColorRef; amount?: number; soft?: number };
  /** Lights on the night side: places [lon, lat] or [lon, lat, weight] (weight default 1; 4 is twice as wide), their colour, size (units, default 1.5) and amount (0..1, default 0.9). */
  lights?: { points: readonly (LonLat | readonly [number, number, number])[]; color: ColorRef; size?: number; amount?: number };
  /** A thin rim of air round the disc, brighter on the lit side: its colour, width (units, default 3 % of r) and amount (0..1, default 0.7). */
  air?: { color: ColorRef; width?: number; amount?: number };
  /** 0..1: how much the disc darkens toward its edge, so that it reads as a ball; default 0.25. */
  shade?: number;
  at?: Vec2 | Vec3;
  depth?: number;
  rotation?: number;
  scale?: number;
  opacity?: number;
  children?: readonly SceneNode[];
  /** Key of the node's voice in the bank of sounds. */
  sound?: string;
}): ShapeNode {
  const where = `globe("${o?.id}")`;
  checkKeys(where, o, ['id', 'r', 'fill', 'view', 'spin', 'layers', 'light', 'lights', 'air', 'shade', 'at', 'depth', 'rotation', 'scale', 'opacity', 'children', 'sound']);
  const r = num(where, 'r', o.r, 1, 1e5);
  const lonLat = (w: string, name: string, p: unknown): [number, number] => {
    if (!Array.isArray(p) || p.length !== 2) fail(w, `${name} must be [lon, lat] in degrees, got ${JSON.stringify(p)}`);
    return [num(w, `${name}[0]`, p[0], -3600, 3600), num(w, `${name}[1]`, p[1], -90, 90)];
  };
  const view = o.view === undefined ? ([0, 0] as const) : lonLat(where, 'view', o.view);
  const spin = o.spin === undefined ? 0 : typeof o.spin === 'number' ? num(where, 'spin', o.spin, -GLOBE_SPIN_MAX, GLOBE_SPIN_MAX) : speedKeyList(where, 'spin', o.spin, -GLOBE_SPIN_MAX, GLOBE_SPIN_MAX, 'degrees per second');
  if (o.layers !== undefined && !Array.isArray(o.layers)) fail(where, 'layers must be a list of { rings, fill }');
  const layers: GlobeLayerSpec[] = (o.layers ?? []).map((l, k) => {
    const lw = `${where} layers[${k}]`;
    if (l === null || typeof l !== 'object') fail(lw, 'must be { rings, fill }');
    checkKeys(lw, l, ['rings', 'fill', 'opacity', 'drift', 'soft']);
    if (!Array.isArray(l.rings) || l.rings.length === 0) fail(lw, 'rings must be a list of rings, each a list of [lon, lat]');
    const rings: Float64Array[] = [];
    const holes: boolean[] = [];
    l.rings.forEach((ring: readonly LonLat[], j: number) => {
      if (!Array.isArray(ring) || ring.length < 3) fail(lw, `rings[${j}] must be a list of at least three places [lon, lat]`);
      const made = globeRing(ring.map((p, i) => lonLat(lw, `rings[${j}][${i}]`, p)));
      if (made.ring.length < 9) fail(lw, `rings[${j}] has fewer than three different places`);
      rings.push(made.ring);
      holes.push(made.hole);
    });
    return {
      rings,
      holes,
      fill: color(lw, 'fill', l.fill),
      opacity: l.opacity === undefined ? 1 : num(lw, 'opacity', l.opacity, 0, 1),
      drift: l.drift === undefined ? 0 : num(lw, 'drift', l.drift, -GLOBE_SPIN_MAX, GLOBE_SPIN_MAX),
      soft: l.soft === undefined ? 0 : num(lw, 'soft', l.soft, 0, 0.2),
    };
  });
  let light: GlobeSpec['light'] = null;
  let night: GlobeSpec['night'] = { color: o.fill, amount: 0, soft: 0 };
  if (o.light !== undefined) {
    const lw = `${where} light`;
    if (o.light === null || typeof o.light !== 'object') fail(lw, 'must be { night, from?, lit?, amount?, soft? }');
    checkKeys(lw, o.light, ['from', 'lit', 'night', 'amount', 'soft']);
    if (o.light.night === undefined) fail(lw, 'night is the colour of the night side; it is needed');
    light = { from: o.light.from === undefined ? -135 : num(lw, 'from', o.light.from, -3600, 3600), lit: o.light.lit === undefined ? 0.7 : num(lw, 'lit', o.light.lit, 0, 1) };
    night = { color: color(lw, 'night', o.light.night), amount: o.light.amount === undefined ? 0.8 : num(lw, 'amount', o.light.amount, 0, 1), soft: o.light.soft === undefined ? 0.05 : num(lw, 'soft', o.light.soft, 0, 0.5) };
  }
  let lights: GlobeSpec['lights'] = null;
  if (o.lights !== undefined) {
    const lw = `${where} lights`;
    if (o.lights === null || typeof o.lights !== 'object') fail(lw, 'must be { points, color, size?, amount? }');
    checkKeys(lw, o.lights, ['points', 'color', 'size', 'amount']);
    if (!light) fail(lw, 'they shine on the night side: give the globe a light, which makes one');
    if (!Array.isArray(o.lights.points) || o.lights.points.length === 0) fail(lw, 'points must be a list of [lon, lat] or [lon, lat, weight]');
    const points = new Float64Array(4 * o.lights.points.length);
    o.lights.points.forEach((p, i) => {
      if (!Array.isArray(p) || (p.length !== 2 && p.length !== 3)) fail(lw, `points[${i}] must be [lon, lat] or [lon, lat, weight], got ${JSON.stringify(p)}`);
      const [x, y, z] = unitOf(num(lw, `points[${i}][0]`, p[0], -3600, 3600), num(lw, `points[${i}][1]`, p[1], -90, 90));
      points.set([x, y, z, p.length === 3 ? num(lw, `points[${i}][2]`, p[2], 0, 1e4) : 1], 4 * i);
    });
    lights = { points, color: color(lw, 'color', o.lights.color), size: o.lights.size === undefined ? 1.5 : num(lw, 'size', o.lights.size, 0.1, 100), amount: o.lights.amount === undefined ? 0.9 : num(lw, 'amount', o.lights.amount, 0, 1) };
  }
  let air: GlobeSpec['air'] = null;
  if (o.air !== undefined) {
    const lw = `${where} air`;
    if (o.air === null || typeof o.air !== 'object') fail(lw, 'must be { color, width?, amount? }');
    checkKeys(lw, o.air, ['color', 'width', 'amount']);
    air = { color: color(lw, 'color', o.air.color), width: o.air.width === undefined ? 0.03 * r : num(lw, 'width', o.air.width, 0.5, r), amount: o.air.amount === undefined ? 0.7 : num(lw, 'amount', o.air.amount, 0, 1) };
  }
  const base = shapeNode(
    where,
    {
      id: o.id,
      fill: o.fill,
      lit: false,
      ...(o.at === undefined ? {} : { at: o.at }),
      ...(o.depth === undefined ? {} : { depth: o.depth }),
      ...(o.rotation === undefined ? {} : { rotation: o.rotation }),
      ...(o.scale === undefined ? {} : { scale: o.scale }),
      ...(o.opacity === undefined ? {} : { opacity: o.opacity }),
      ...(o.children === undefined ? {} : { children: o.children }),
      ...(o.sound === undefined ? {} : { sound: o.sound }),
    },
    wrapShape(where, () => circleShape(r)),
    null,
  );
  return { ...base, globe: { view, spin, layers, light, night, lights, air, shade: o.shade === undefined ? 0.25 : num(where, 'shade', o.shade, 0, 1) } };
}

/** The fastest a globe turns, or a layer drifts over it, in degrees per second. */
const GLOBE_SPIN_MAX = 360;

/**
 * A soft round patch on a globe, for a layer: a ring of [lon, lat] round `at`, `r` degrees of arc across at its mean,
 * its edge wobbling by up to `wobble` of that (0..0.6, default 0.25), stretched east and west by `stretch` (default
 * 1); the same seed always gives the same ring. Clouds, a lake, a patch of ice.
 */
export function globeBlob(o: { at: LonLat; r: number; points?: number; wobble?: number; stretch?: number; seed?: number }): LonLat[] {
  const where = 'globeBlob()';
  checkKeys(where, o, ['at', 'r', 'points', 'wobble', 'stretch', 'seed']);
  if (!Array.isArray(o.at) || o.at.length !== 2) fail(where, `at must be [lon, lat] in degrees, got ${JSON.stringify(o.at)}`);
  const lon = num(where, 'at[0]', o.at[0], -3600, 3600) * (Math.PI / 180);
  const lat = num(where, 'at[1]', o.at[1], -90, 90) * (Math.PI / 180);
  const r = num(where, 'r', o.r, 0.01, 60);
  const n = o.points === undefined ? 28 : num(where, 'points', o.points, 6, 400);
  if (!Number.isInteger(n)) fail(where, `points must be a whole number, got ${n}`);
  const wobble = o.wobble === undefined ? 0.25 : num(where, 'wobble', o.wobble, 0, 0.6);
  const stretch = o.stretch === undefined ? 1 : num(where, 'stretch', o.stretch, 0.2, 5);
  const rng = new Rng(o.seed === undefined ? 1 : num(where, 'seed', o.seed, -1e9, 1e9), 'globeBlob');
  // A few waves round the edge: smooth, never a spike.
  const waves = [2, 3, 5].map((k) => ({ k, a: rng.range(0.4, 1) / k, p: rng.range(0, 2 * Math.PI) }));
  const norm = waves.reduce((sum, w) => sum + w.a, 0);
  const out: LonLat[] = [];
  for (let i = 0; i < n; i++) {
    // Counter-clockwise seen from outside: from east to north.
    const th = (2 * Math.PI * i) / n;
    const wave = waves.reduce((sum, w) => sum + w.a * Math.sin(w.k * th + w.p), 0) / norm;
    const e = Math.cos(th) * stretch;
    const nn = Math.sin(th);
    // How far from the middle, in radians, and the bearing (clockwise from north) it lies on.
    const d = (r / 2) * (1 + wobble * wave) * Math.hypot(e, nn) * (Math.PI / 180);
    const bearing = Math.atan2(e, nn);
    const lat2 = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(bearing));
    const lon2 = lon + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(lat2));
    let lonDeg = (lon2 * 180) / Math.PI;
    lonDeg -= 360 * Math.round(lonDeg / 360);
    out.push([Math.round(lonDeg * 1e6) / 1e6, Math.round(((lat2 * 180) / Math.PI) * 1e6) / 1e6]);
  }
  return out;
}

/** A soft irregular blob of mean radius r; the same seed always gives the same outline. */
export function blob(o: ShapeOptions & { r: number; points?: number; wobble?: number; seed?: number }): ShapeNode {
  const where = `blob("${o?.id}")`;
  checkKeys(where, o, [...SHAPE_KEYS, 'r', 'points', 'wobble', 'seed']);
  const opts: { points?: number; wobble?: number; seed?: number } = {};
  if (o.points !== undefined) opts.points = o.points;
  if (o.wobble !== undefined) opts.wobble = o.wobble;
  if (o.seed !== undefined) opts.seed = o.seed;
  return shapeNode(where, o, wrapShape(where, () => blobShape(o.r, opts)), null);
}

/** An invisible parent: its children move, turn and scale with it. */
export function group(o: {
  id: string;
  /** [x, y]; listed in a perspective layer, [x, y, z]: the third number is how far away it is. */
  at?: Vec2 | Vec3;
  /** Listed in a layer: its place in the draw order. The larger depth is drawn first, behind the rest; default 0. */
  depth?: number;
  rotation?: number;
  /** Default 1; 0.002 to 500 (other nodes 0.01 to 100): a detail drawn in its own units sits in a wide view at its true size, for a deep zoom. */
  scale?: number;
  /** 0..1 at the start; default 1. The group fades as one picture. */
  opacity?: number;
  /** Keep the group's own rotation in the layer's space, whatever its parent does; default false. */
  upright?: boolean;
  children?: readonly SceneNode[];
  follow?: SpringSpec;
  idle?: IdleSpec;
  /** Id of a shape of the same layer: the group is drawn only inside that shape's outline. */
  clipTo?: string;
  /**
   * Listed in a perspective layer: the group lies in a plane of its space, through its place, and everything in it is
   * drawn on that plane. 'floor': the ground seen from above; 'wall': it faces the viewer; 'side': it runs away from
   * the viewer and faces right; or { x, y }: where its own x and y point, as two directions [x, y, z] at right angles.
   */
  plane?: 'floor' | 'wall' | 'side' | { x: Vec3; y: Vec3 };
  /** With plane: false does not draw the group when the camera sees the back of its plane; default true. */
  back?: boolean;
  /**
   * With plane: true lets a body in the group (a shape with a rise) stand taller than the camera is high over the
   * plane: a tower on a map seen from low down. It is drawn whole, its top seen from below. Left out: a body is drawn
   * at most 0.9 of the camera's height tall.
   */
  tall?: boolean;
  /**
   * With plane: the id of a relief among the group's own children that is the ground of the plane, or the ids of a few
   * (a finer relief over part of a coarser one, listed after it, blended into it over its feather). The reliefs are
   * drawn raised, their hills standing up as the camera of the layer sees them, at their own vertical; and everything
   * the group lists after the first of them stands on the ground: a shape, a group or a body at the height of the
   * ground under its place (a travel rides over the hills), a region and a stroke point by point. What is listed
   * before it lies flat, under it.
   */
  ground?: string | readonly string[];
  /**
   * With plane: depth haze. What the group draws turns toward color (a palette reference) with its distance from the
   * camera, measured along its line of sight in units of the layer: not at all nearer than near, smoothly more up to
   * far, and amount of the way (0..1, default 1) at far and beyond. The far land of a tilted map fades into the air.
   */
  fog?: { color: ColorRef; near: number; far: number; amount?: number; fade?: { near: number; far: number } };
  /** Units, up to 200: the group is drawn as one picture, blurred this far: soft shadows, a haze, a cloud. */
  soft?: number;
  /**
   * 'depth': the children are drawn far to near at every frame, whatever order they were listed in: bodies that stand
   * in a plane of a perspective layer hide each other rightly from every side the camera turns to, and in a flat layer
   * what stands lower on the screen is drawn over what stands higher. A stroke with a rise among them (a wall, a
   * ring) is taken stretch by stretch, each in its place among the others.
   */
  sort?: 'depth';
  /**
   * The bodies in the group (shapes and strokes with a rise) cast shadows on the ground under it, drawn as one picture
   * before the group's children. color: a palette reference; opacity (default 0.35); length: units of shadow to each
   * unit of height (default 0.7, up to 8); dir: where they fall, in degrees (default: away from the light of the
   * shot); soft: units of blur (default 0); over: 'flat' draws the children with no rise in them first, as listed,
   * then the shadows over them, then the raised children (default: the shadows under every child).
   */
  cast?: { color: ColorRef; opacity?: number; dir?: number; length?: number; soft?: number; over?: 'flat' };
  /**
   * For a group of many bodies (shapes and strokes with a rise): how much detail they are worth. A body smaller on
   * screen than min (units of the stage: the pixels of a frame 1920 wide), across and in height, is drawn plain: its
   * top alone, without its side, its openings, its roof, its light and its shadow. Every other body is drawn with all
   * it has, and its side as one outline, several times faster than outside such a group. min 0: no body is plain.
   */
  detail?: { min: number };
  /** Key of the node's voice in the bank of sounds: what its intents and its contacts sound like. */
  sound?: string;
}): GroupNode {
  const where = `group("${o?.id}")`;
  checkKeys(where, o, ['id', 'at', 'rotation', 'scale', 'opacity', 'upright', 'children', 'follow', 'idle', 'clipTo', 'sound', 'depth', 'plane', 'back', 'tall', 'ground', 'fog', 'soft', 'sort', 'cast', 'detail']);
  if (o.sort !== undefined && o.sort !== 'depth') fail(where, `sort must be "depth" (the children are drawn far to near), got ${JSON.stringify(o.sort)}; leave it out to draw them as listed`);
  if (o.upright !== undefined && typeof o.upright !== 'boolean') fail(where, `upright must be true or false, got ${JSON.stringify(o.upright)}`);
  if (o.back !== undefined && o.plane === undefined) fail(where, 'back is for a group that lies in a plane of a perspective layer: give plane');
  if (o.tall !== undefined && o.plane === undefined) fail(where, 'tall is for a group that lies in a plane of a perspective layer: give plane');
  if (o.fog !== undefined && o.plane === undefined) fail(where, 'fog is for a group that lies in a plane of a perspective layer: give plane');
  if (o.ground !== undefined && o.plane === undefined) fail(where, 'ground is for a group that lies in a plane of a perspective layer: give plane');
  return {
    ...fogOf(where, o.fog),
    ...(o.clipTo === undefined ? {} : { clipTo: idOf(where, o.clipTo) }),
    ...order(where, o.depth),
    // Written only when it is given: a group without a plane is the data it always was.
    ...(o.plane === undefined ? {} : { plane: planeAxes(where, o.plane), ...(o.back === undefined ? {} : { back: flag(where, 'back', o.back) }), ...(o.tall ? { tall: flag(where, 'tall', o.tall) } : {}), ...(o.ground === undefined ? {} : { ground: groundOf(where, o.ground) }) }),
    ...softness(where, o.soft),
    // Written only when they are given: a group without them is the data it always was.
    ...(o.sort === undefined ? {} : { sort: o.sort }),
    ...castOf(where, o.cast),
    ...detailOf(where, o.detail),
    ...voice(where, o.sound),
    type: 'group',
    id: idOf(where, o.id),
    ...place(where, o.at),
    rotation: o.rotation === undefined ? 0 : num(where, 'rotation', o.rotation, -1e5, 1e5),
    // A group is drawn through its children, so it may be far smaller than a shape: a detail of a wide view at its true size, for a deep zoom.
    // Its floor is twice the size at which a node counts as hidden (HIDDEN of the evaluation).
    scale: o.scale === undefined ? 1 : num(where, 'scale', o.scale, 0.002, 500),
    opacity: o.opacity === undefined ? 1 : num(where, 'opacity', o.opacity, 0, 1),
    upright: o.upright ?? false,
    children: children(where, o.children),
    follow: spring(where, 'follow', o.follow),
    idle: idle(where, o.idle),
  };
}

/** A curved line between two nodes; it follows them. Animate it with drawOn() and pulse(). */
export function link(o: {
  id: string;
  from: string;
  to: string;
  color: ColorRef;
  /** Default: the link's own colour. */
  pulseColor?: ColorRef;
  /** Sideways bulge as a fraction of the length; default 0.12. */
  bend?: number;
  /** Default 7. */
  width?: number;
  /** Extra free space at each end; default 6. */
  gap?: number;
  /** 0..1 at the start; default 1. */
  opacity?: number;
  /** 0..1: the line itself glows (a halo around it); default 0. */
  glow?: number;
  /** Id of a shape of the same layer: the link is drawn only inside that shape's outline. */
  clipTo?: string;
  /** Key of the node's voice in the bank of sounds: what its intents and its contacts sound like. */
  sound?: string;
}): LinkNode {
  const where = `link("${o?.id}")`;
  checkKeys(where, o, ['id', 'from', 'to', 'color', 'pulseColor', 'bend', 'width', 'gap', 'opacity', 'glow', 'clipTo', 'sound']);
  const c = color(where, 'color', o.color);
  return {
    ...(o.clipTo === undefined ? {} : { clipTo: idOf(where, o.clipTo) }),
    ...voice(where, o.sound),
    type: 'link',
    id: idOf(where, o.id),
    from: idOf(where, o.from),
    to: idOf(where, o.to),
    bend: o.bend === undefined ? 0.12 : num(where, 'bend', o.bend, -1, 1),
    width: o.width === undefined ? 7 : num(where, 'width', o.width, 0.5, LINK_MAX_WIDTH),
    color: c,
    pulseColor: o.pulseColor === undefined ? c : color(where, 'pulseColor', o.pulseColor),
    gap: o.gap === undefined ? 6 : num(where, 'gap', o.gap, 0, 400),
    opacity: o.opacity === undefined ? 1 : num(where, 'opacity', o.opacity, 0, 1),
    glow: o.glow === undefined ? 0 : num(where, 'glow', o.glow, 0, 1),
  };
}

/**
 * A stroke: a line with round ends along a free-form path. `points` are the
 * places it runs through, in its own space; they are joined as the path of a
 * travel is (`smooth` 1: a smooth curve; 0: straight lines), open or closed.
 * `dash: [dash, gap]` makes it dashed (a dash of 0 is a dot). drawOn() draws
 * it on from its first point, solidTo() closes its gaps, pulse() sends a
 * light along it. It is placed like a shape and may be the child of a shape
 * or a group.
 */
export function stroke(o: {
  id: string;
  /** The points of the line: [x, y] each; listed in a perspective layer, [x, y, z] each: points of its space. */
  points: readonly Vec2[] | readonly Vec3[];
  color: ColorRef;
  /** Default 7. */
  width?: number;
  /** Back to the first point after the last; default false. */
  closed?: boolean;
  /** 0 = straight lines between the points, 1 = a smooth curve through them; default 1. */
  smooth?: number;
  /** [dash, gap] in units: the straight part of a dash (0 = a dot) and the clear gap between two. Default: a solid line. */
  dash?: readonly [number, number];
  /** 0..1: how far the gaps of a dashed line are closed at the start; default 0. */
  solid?: number;
  /** 0..1: the share that is drawn before the first drawOn; default all of it, or none when the stroke has a drawOn. */
  drawn?: number;
  /** [x, y]; listed in a perspective layer, [x, y, z]: the third number is how far away it is. */
  at?: Vec2 | Vec3;
  /** Listed in a layer: its place in the draw order. The larger depth is drawn first, behind the rest; default 0. */
  depth?: number;
  rotation?: number;
  scale?: number;
  /** 0..1 at the start; default 1. */
  opacity?: number;
  /** 0..1: the line glows (a halo around it); default 0. */
  glow?: number;
  /** Colour of the lights that pulse() sends along the stroke; default: the stroke's own colour. */
  pulseColor?: ColorRef;
  /** Id of a shape of the same layer: the stroke is drawn only inside that shape's outline. */
  clipTo?: string;
  /**
   * Units of the frame, 0.5 to 200: the line is never thinner on screen than this, however far the camera has pulled
   * back and however small its parents are drawn: a river or a road stays a line through a deep zoom.
   */
  least?: number;
  /** Units, 0 to 2000: the line is the top of a wall this high, standing on its place, as the rise of a shape. */
  rise?: number;
  /** With rise: the colour of the side of the wall; default a shadow tone of the line's colour. */
  side?: ColorRef;
  /**
   * With rise: rows of openings painted on both faces of the wall, wherever the viewer sees one, as on the side of a
   * shape (the same options); a face runs from one sharp corner of the line to the next, a smooth curve is one face.
   */
  openings?: ShapeOptions['openings'];
  /** Key of the node's voice in the bank of sounds. */
  sound?: string;
}): StrokeNode {
  const where = `stroke("${o?.id}")`;
  checkKeys(where, o, ['id', 'points', 'color', 'width', 'closed', 'smooth', 'dash', 'solid', 'drawn', 'at', 'rotation', 'scale', 'opacity', 'glow', 'pulseColor', 'clipTo', 'sound', 'depth', 'least', 'rise', 'side', 'openings']);
  if (!Array.isArray(o.points) || o.points.length < 2) fail(where, 'points must be a list of at least two points [x, y]');
  // Points of three numbers: a line of the space of a perspective layer. Its path is then the line seen straight on.
  const solid = spacePoints(where, o.points);
  const closed = o.closed === undefined ? false : flag(where, 'closed', o.closed);
  if (closed && o.points.length < 3) fail(where, 'a closed stroke needs at least three points');
  const path: PathSpec = { points: solid ? seenStraightOn(solid).flat : o.points.map((p, i) => vec(where, `points[${i}]`, p)), closed, smooth: o.smooth === undefined ? 1 : num(where, 'smooth', o.smooth, 0, 1) };
  if (!(pathLength(path) > 1e-6)) fail(where, 'the points give a line without length');
  const width = o.width === undefined ? 7 : num(where, 'width', o.width, 0.5, 200);
  let dash: [number, number] | null = null;
  if (o.dash !== undefined) {
    if (!Array.isArray(o.dash) || o.dash.length !== 2) fail(where, `dash must be [dash, gap] in units (a dash of 0 is a dot), got ${JSON.stringify(o.dash)}`);
    dash = [num(where, 'dash[0]', o.dash[0], 0, 1e4), num(where, 'dash[1]', o.dash[1], 0.5, 1e4)];
  }
  if (o.solid !== undefined && dash === null) fail(where, 'solid is for a dashed stroke: give dash');
  if (solid && o.rise !== undefined) fail(where, 'a stroke of points [x, y, z] cannot have a rise: its points give its place in the space; put a flat stroke with a rise into a group that lies in a plane');
  return {
    // Written only when they are given: a stroke without them is the data it always was.
    ...(o.least === undefined ? {} : { least: num(where, 'least', o.least, 0.5, 200) }),
    ...risen(where, o, 'stroke'),
    ...openingsOf(where, o, 'stroke'),
    ...(o.clipTo === undefined ? {} : { clipTo: idOf(where, o.clipTo) }),
    ...(o.drawn === undefined ? {} : { drawn: num(where, 'drawn', o.drawn, 0, 1) }),
    // Written only when it is given: a stroke without it is the data it always was.
    ...(o.pulseColor === undefined ? {} : { pulseColor: color(where, 'pulseColor', o.pulseColor) }),
    ...(solid ? { points3: solid } : {}),
    ...order(where, o.depth),
    ...voice(where, o.sound),
    type: 'stroke',
    id: idOf(where, o.id),
    path,
    width,
    color: color(where, 'color', o.color),
    dash,
    solid: o.solid === undefined ? 0 : num(where, 'solid', o.solid, 0, 1),
    ...place(where, o.at),
    rotation: o.rotation === undefined ? 0 : num(where, 'rotation', o.rotation, -1e5, 1e5),
    scale: o.scale === undefined ? 1 : num(where, 'scale', o.scale, 0.01, 100),
    opacity: o.opacity === undefined ? 1 : num(where, 'opacity', o.opacity, 0, 1),
    glow: o.glow === undefined ? 0 : num(where, 'glow', o.glow, 0, 1),
  };
}

/**
 * A label: a rounded rectangle with a pointer tail aimed at `target`. `text` is
 * a key of the shot's string tables; the label sizes and wraps itself to the
 * string of the language being rendered.
 */
export function label(o: {
  id: string;
  /** String-table key, e.g. "label.core". */
  text: string;
  /** Id of the node to point at. */
  target: string;
  fill: ColorRef;
  ink: ColorRef;
  /** The ink of the runs its string marks with "[" and "]"; default none: a bracket is a bracket. */
  runInk?: ColorRef;
  /** Default "top". */
  side?: LabelSide;
  /** Default 14. */
  gap?: number;
  /** Preferred font size; default 38. */
  size?: number;
  /** Smallest font size; default 62 % of size. */
  minSize?: number;
  /** Default 420. */
  maxWidth?: number;
  /** Default 3. */
  maxLines?: number;
  /** 0..1 at the start; default 1. */
  opacity?: number;
  follow?: SpringSpec;
  /** Key of the node's voice in the bank of sounds: what its intents and its contacts sound like. */
  sound?: string;
}): LabelNode {
  const where = `label("${o?.id}")`;
  checkKeys(where, o, ['id', 'text', 'target', 'fill', 'ink', 'runInk', 'side', 'gap', 'size', 'minSize', 'maxWidth', 'maxLines', 'opacity', 'follow', 'sound']);
  if (typeof o.text !== 'string' || !isStringKey(o.text)) {
    fail(where, `text must be a string-table key such as "label.core", got ${JSON.stringify(o.text)}. On-screen text never appears in scene code: put the words in the shot's string tables`);
  }
  const side = o.side ?? 'top';
  if (!['top', 'bottom', 'left', 'right'].includes(side)) fail(where, `side must be top, bottom, left or right, got ${JSON.stringify(side)}`);
  const size = o.size === undefined ? 38 : num(where, 'size', o.size, 8, 400);
  return {
    ...voice(where, o.sound),
    ...(o.runInk === undefined ? {} : { runInk: color(where, 'runInk', o.runInk) }),
    type: 'label',
    id: idOf(where, o.id),
    text: o.text,
    target: idOf(where, o.target),
    side,
    gap: o.gap === undefined ? 14 : num(where, 'gap', o.gap, 0, 600),
    size,
    minSize: o.minSize === undefined ? Math.round(size * 0.62) : num(where, 'minSize', o.minSize, 6, size),
    maxWidth: o.maxWidth === undefined ? 420 : num(where, 'maxWidth', o.maxWidth, 40, 1800),
    maxLines: o.maxLines === undefined ? 3 : num(where, 'maxLines', o.maxLines, 1, 12),
    fill: color(where, 'fill', o.fill),
    ink: color(where, 'ink', o.ink),
    opacity: o.opacity === undefined ? 1 : num(where, 'opacity', o.opacity, 0, 1),
    follow: spring(where, 'follow', o.follow),
  };
}

/**
 * Free-standing text: a title, a caption, a note, words on a card. `text` is
 * a key of the shot's string tables; the lines wrap, balance and shrink as a
 * label's do, and the text-fit checks hold them. There is no pointer. It is
 * placed like a shape: at `at`, turned and scaled, alone or as the child of a
 * shape or a group, with which it moves, turns and fades. `box` puts a
 * rounded box of that colour behind the lines.
 */
export function text(o: {
  id: string;
  /** String-table key, e.g. "title.main". */
  text: string;
  ink: ColorRef;
  /** The ink of the runs its string marks with "[" and "]"; default none: a bracket is a bracket. Not on a counter. */
  runInk?: ColorRef;
  /** [x, y]; listed in a perspective layer, [x, y, z]: the third number is how far away it is. */
  at?: Vec2 | Vec3;
  /** Listed in a layer: its place in the draw order. The larger depth is drawn first, behind the rest; default 0. */
  depth?: number;
  rotation?: number;
  scale?: number;
  /** 0..1 at the start; default 1. */
  opacity?: number;
  /** Preferred font size; default 38. */
  size?: number;
  /** Smallest font size; default 62 % of size. */
  minSize?: number;
  /** Default 600. */
  maxWidth?: number;
  /** Default 3. */
  maxLines?: number;
  /** Weight of the letters, 200 to 1000; default 800. */
  weight?: number;
  /** Where `at` is in the block, sideways, and how the lines are set: 'left', 'center' (the default) or 'right'. */
  align?: TextAlign;
  /** A rounded box of this colour behind the lines; default none. */
  box?: ColorRef;
  /**
   * Makes the text a counter. Its string holds "{n}" where the number goes; the number starts at this value (or at
   * `from`, with `decimals` places after the decimal sign) and countTo() runs it.
   */
  count?: number | { from: number; decimals?: number };
  /** Id of a shape of the same layer: the text is drawn only inside that shape's outline. */
  clipTo?: string;
  /** Key of the node's voice in the bank of sounds. */
  sound?: string;
}): TextNode {
  const where = `text("${o?.id}")`;
  checkKeys(where, o, ['id', 'text', 'ink', 'at', 'rotation', 'scale', 'opacity', 'size', 'minSize', 'maxWidth', 'maxLines', 'weight', 'align', 'box', 'runInk', 'count', 'clipTo', 'sound', 'depth']);
  if (typeof o.text !== 'string' || !isStringKey(o.text)) {
    fail(where, `text must be a string-table key such as "title.main", got ${JSON.stringify(o.text)}. On-screen text never appears in scene code: put the words in the shot's string tables`);
  }
  const align = o.align ?? 'center';
  if (!TEXT_ALIGNS.includes(align)) fail(where, `align must be left, center or right, got ${JSON.stringify(align)}`);
  const size = o.size === undefined ? 38 : num(where, 'size', o.size, 8, 600);
  let count: TextNode['count'];
  if (o.count !== undefined) {
    if (typeof o.count === 'number') count = { from: num(where, 'count', o.count, -1e15, 1e15), decimals: 0 };
    else {
      if (o.count === null || typeof o.count !== 'object') fail(where, `count must be a number, or { from, decimals }, got ${JSON.stringify(o.count)}`);
      checkKeys(`${where} count`, o.count, ['from', 'decimals']);
      const decimals = o.count.decimals === undefined ? 0 : num(where, 'count.decimals', o.count.decimals, 0, 6);
      if (!Number.isInteger(decimals)) fail(where, `count.decimals must be a whole number, got ${decimals}`);
      count = { from: num(where, 'count.from', o.count.from, -1e15, 1e15), decimals };
    }
    // The line of a counter is set anew for every number it shows, piece by piece; a run has no place in it.
    if (o.runInk !== undefined) fail(where, 'a counter takes no runInk: its number is set anew at every value. Put the words of the second ink in a text of their own');
  }
  return {
    ...(o.clipTo === undefined ? {} : { clipTo: idOf(where, o.clipTo) }),
    ...(count === undefined ? {} : { count }),
    ...order(where, o.depth),
    ...voice(where, o.sound),
    ...(o.runInk === undefined ? {} : { runInk: color(where, 'runInk', o.runInk) }),
    type: 'text',
    id: idOf(where, o.id),
    text: o.text,
    ink: color(where, 'ink', o.ink),
    size,
    minSize: o.minSize === undefined ? Math.round(size * 0.62) : num(where, 'minSize', o.minSize, 6, size),
    maxWidth: o.maxWidth === undefined ? 600 : num(where, 'maxWidth', o.maxWidth, 40, 1800),
    maxLines: o.maxLines === undefined ? 3 : num(where, 'maxLines', o.maxLines, 1, 12),
    weight: o.weight === undefined ? 800 : num(where, 'weight', o.weight, 200, 1000),
    align,
    box: o.box === undefined ? null : color(where, 'box', o.box),
    ...place(where, o.at),
    rotation: o.rotation === undefined ? 0 : num(where, 'rotation', o.rotation, -1e5, 1e5),
    scale: o.scale === undefined ? 1 : num(where, 'scale', o.scale, 0.01, 100),
    opacity: o.opacity === undefined ? 1 : num(where, 'opacity', o.opacity, 0, 1),
  };
}

/**
 * A simple eye. The pupil looks at the node `lookAt`; the eye blinks now and
 * then. `open` sets its lids at the start (0 = shut and not drawn); openTo()
 * opens and closes them, blink() asks for a blink at a chosen moment.
 */
export function eye(o: {
  id: string;
  r: number;
  white: ColorRef;
  pupil: ColorRef;
  /** [x, y]; listed in a perspective layer, [x, y, z]: the third number is how far away it is. */
  at?: Vec2 | Vec3;
  /** Listed in a layer: its place in the draw order. The larger depth is drawn first, behind the rest; default 0. */
  depth?: number;
  scale?: number;
  /** 0..1 at the start; default 1. */
  opacity?: number;
  lookAt?: string;
  /** Default true. */
  blink?: boolean;
  /** Lids at the start, 0 (shut) .. 1 (open); default 1. */
  open?: number;
  /** Key of the node's voice in the bank of sounds: what its intents and its contacts sound like. */
  sound?: string;
}): EyeNode {
  const where = `eye("${o?.id}")`;
  checkKeys(where, o, ['id', 'r', 'white', 'pupil', 'at', 'scale', 'opacity', 'lookAt', 'blink', 'open', 'sound', 'depth']);
  return {
    ...order(where, o.depth),
    ...voice(where, o.sound),
    type: 'eye',
    id: idOf(where, o.id),
    ...place(where, o.at),
    rotation: 0,
    scale: o.scale === undefined ? 1 : num(where, 'scale', o.scale, 0.01, 100),
    r: num(where, 'r', o.r, 1, 2000),
    white: color(where, 'white', o.white),
    pupil: color(where, 'pupil', o.pupil),
    opacity: o.opacity === undefined ? 1 : num(where, 'opacity', o.opacity, 0, 1),
    lookAt: o.lookAt === undefined ? null : idOf(where, o.lookAt),
    blink: o.blink ?? true,
    open: o.open === undefined ? 1 : num(where, 'open', o.open, 0, 1),
  };
}

/** A particle emitter. Give it `rate`, `bursts` or `onContact` (or several). */
export function emitter(o: {
  id: string;
  colors: readonly ColorRef[];
  /** Radius [min, max] or one number. */
  size: Vec2 | number;
  /** Seconds [min, max] or one number. */
  life: Vec2 | number;
  /** Position in the layer, or the offset from `attach`; default [0, 0]. */
  at?: Vec2;
  /** Id of a node to ride on. */
  attach?: string;
  /** Spawn box [width, height]; default [0, 0]. */
  area?: Vec2;
  /** Particles per second. */
  rate?: number;
  /** Seconds between which `rate` applies; default the whole shot. */
  from?: number;
  until?: number;
  bursts?: readonly { at: number; count: number }[];
  onContact?: { count: number; minImpulse: number };
  /** Seconds simulated before frame 0; default 0. */
  prewarm?: number;
  /** Degrees, 0 = right, -90 = up; default -90. */
  direction?: number;
  /** Full spread angle in degrees; default 360. */
  spread?: number;
  /** Units per second [min, max] or one number; default [20, 60]. */
  speed?: Vec2 | number;
  /** Constant acceleration, units per second squared; default [0, 0]. */
  gravity?: Vec2;
  /** Default 0.8. */
  drag?: number;
  turbulence?: TurbulenceSpec;
  /** 0..1; default 0. */
  glow?: number;
  /** An inner disc on every particle: its colour and its radius as a fraction of the particle's (0..1). */
  core?: { color: ColorRef; size: number };
  /** How the size runs over a particle's life: "spark" (default: swells, then shrinks away) or "steady" (full size nearly all its life). */
  sizing?: 'spark' | 'steady';
  /** Id of a shape of the same layer: the particles are drawn only inside that shape's outline. */
  clipTo?: string;
  /** Seconds, up to 1: each particle is drawn as a streak as long as the way it travels in that time: rain, sparks. */
  streak?: number;
  /** Key of the emitter's voice in the bank of sounds: what its bursts sound like. */
  sound?: string;
}): EmitterNode {
  const where = `emitter("${o?.id}")`;
  checkKeys(where, o, [
    'id', 'colors', 'size', 'life', 'at', 'attach', 'area', 'rate', 'from', 'until', 'bursts', 'onContact', 'prewarm',
    'direction', 'spread', 'speed', 'gravity', 'drag', 'turbulence', 'glow', 'core', 'sizing', 'clipTo', 'streak', 'sound',
  ]);
  if (o.sizing !== undefined && o.sizing !== 'spark' && o.sizing !== 'steady') fail(where, `sizing must be "spark" or "steady", got ${JSON.stringify(o.sizing)}`);
  if (!Array.isArray(o.colors) || o.colors.length === 0) fail(where, 'colors must be a non-empty array of palette references');
  const rate = o.rate === undefined ? 0 : num(where, 'rate', o.rate, 0, 5000);
  const bursts = (o.bursts ?? []).map((b, i) => {
    checkKeys(`${where} bursts[${i}]`, b, ['at', 'count']);
    return { at: num(where, `bursts[${i}].at`, b.at, 0, 3600), count: num(where, `bursts[${i}].count`, b.count, 1, 5000) };
  });
  let onContact: EmitterNode['onContact'] = null;
  if (o.onContact !== undefined) {
    checkKeys(`${where} onContact`, o.onContact, ['count', 'minImpulse']);
    onContact = {
      count: num(where, 'onContact.count', o.onContact.count, 1, 500),
      minImpulse: num(where, 'onContact.minImpulse', o.onContact.minImpulse, 0, 1e6),
    };
  }
  if (rate === 0 && bursts.length === 0 && !onContact) fail(where, 'the emitter never emits: give rate, bursts or onContact');
  let turbulence: TurbulenceSpec | null = null;
  if (o.turbulence !== undefined) {
    checkKeys(`${where} turbulence`, o.turbulence, ['strength', 'scale', 'speed']);
    turbulence = {
      strength: num(where, 'turbulence.strength', o.turbulence.strength, 0, 1e5),
      scale: num(where, 'turbulence.scale', o.turbulence.scale, 1, 1e5),
      speed: num(where, 'turbulence.speed', o.turbulence.speed, 0, 100),
    };
  }
  let core: EmitterNode['core'] = null;
  if (o.core !== undefined) {
    checkKeys(`${where} core`, o.core, ['color', 'size']);
    core = { color: color(where, 'core.color', o.core.color), size: num(where, 'core.size', o.core.size, 0.05, 0.95) };
  }
  return {
    ...(o.sizing === undefined ? {} : { sizing: o.sizing }),
    ...(o.clipTo === undefined ? {} : { clipTo: idOf(where, o.clipTo) }),
    ...(o.streak === undefined ? {} : { streak: num(where, 'streak', o.streak, 0.001, STREAK_MAX) }),
    ...voice(where, o.sound),
    type: 'emitter',
    id: idOf(where, o.id),
    at: o.at === undefined ? [0, 0] : vec(where, 'at', o.at),
    attach: o.attach === undefined ? null : idOf(where, o.attach),
    area: o.area === undefined ? [0, 0] : vec(where, 'area', o.area),
    rate,
    from: o.from === undefined ? 0 : num(where, 'from', o.from, 0, 3600),
    until: o.until === undefined ? 3600 : num(where, 'until', o.until, 0, 3600),
    bursts,
    onContact,
    prewarm: o.prewarm === undefined ? 0 : num(where, 'prewarm', o.prewarm, 0, 120),
    direction: o.direction === undefined ? -90 : num(where, 'direction', o.direction, -3600, 3600),
    spread: o.spread === undefined ? 360 : num(where, 'spread', o.spread, 0, 360),
    speed: o.speed === undefined ? [20, 60] : range(where, 'speed', o.speed, 0, 1e5),
    life: range(where, 'life', o.life, 0.05, 600),
    size: range(where, 'size', o.size, 0.1, 500),
    colors: o.colors.map((c, i) => color(where, `colors[${i}]`, c)),
    core,
    gravity: o.gravity === undefined ? [0, 0] : vec(where, 'gravity', o.gravity),
    drag: o.drag === undefined ? 0.8 : num(where, 'drag', o.drag, 0, 100),
    turbulence,
    glow: o.glow === undefined ? 0 : num(where, 'glow', o.glow, 0, 1),
  };
}

/** A depth layer. depth 0 is in focus; positive is farther (smaller parallax, paler), negative is nearer (blurred). */
export function layer(o: {
  id: string;
  depth: number;
  nodes: readonly SceneNode[];
  /** Blur radius in units; default derived from depth. */
  blur?: number;
  /** Default 1 / (1 + depth). */
  parallax?: number;
  /** 0..1 atmospheric perspective (paler, less saturated, toward the atmosphere colour); default derived from depth. */
  tint?: number;
  /**
   * Makes the layer a perspective layer: the nodes listed in it take a place [x, y, z] and are seen through a camera
   * that looks at `aim` (default [0, 0, 0]) from `distance` (default 1600), `tilt` degrees down (0 level, 90 straight
   * down) and `turn` degrees round it, with the lens `lens` (default: the distance, so that what lies at the aim is
   * drawn at its own size). true takes every default. Move the camera with perspectiveTo().
   */
  perspective?: true | { aim?: Vec3; distance?: number; tilt?: number; turn?: number; lens?: number };
}): LayerSpec {
  const where = `layer("${o?.id}")`;
  checkKeys(where, o, ['id', 'depth', 'nodes', 'blur', 'parallax', 'tint', 'perspective']);
  if (!Array.isArray(o.nodes)) fail(where, 'nodes must be an array');
  return {
    id: idOf(where, o.id),
    depth: num(where, 'depth', o.depth, -0.9, 50),
    nodes: o.nodes,
    blur: o.blur === undefined ? null : num(where, 'blur', o.blur, 0, 200),
    parallax: o.parallax === undefined ? null : num(where, 'parallax', o.parallax, 0, 20),
    tint: o.tint === undefined ? null : num(where, 'tint', o.tint, 0, 1),
    // Written only when it is given: a flat layer is the data it always was.
    ...(o.perspective === undefined ? {} : { perspective: perspective(where, o.perspective) }),
  };
}

export const CAMERA_DEFAULTS: CameraSpec = {
  at: [0, 0],
  drift: { speed: 0.5, heading: 0, wander: 10, period: 7 },
  pushIn: { from: 1, to: 1.05 },
  focus: { far: 6, near: 60 },
};

/** Style defaults of the rigid-body world: less gravity, more drag, softer impacts than real. */
export const PHYSICS_DEFAULTS: PhysicsSpec = {
  gravity: 540,
  linearDamping: 0.35,
  angularDamping: 0.6,
  restitution: 0.12,
  friction: 0.7,
  prewarm: 0,
};

/**
 * Marks a finding of the motion review or of the physics review as intended:
 * `skink3 motion`, `skink3 physics` and `skink3 check` then leave it out of
 * their warnings and list it as honoured, with the reason. `nodes` is one id or
 * several; for the camera use "(camera)", for a hold of the whole frame
 * "(frame)", for a region "(frame:top-left)". `window` limits it to findings
 * between two moments.
 *
 *   intended('door', 'abrupt-start', 'it is kicked open')
 *   intended(sparkIds, 'too-fast', 'sparks are meant to streak', { from: 4, to: 6 })
 *   intended(crumbIds, 'escape', 'the crumbs fall out of the picture')
 */
export function intended(
  nodes: string | readonly string[],
  kind: FindingKind,
  reason: string,
  window: { from?: number; to?: number } = {},
): IntendedSpec {
  const where = `intended(${JSON.stringify(nodes)}, ${JSON.stringify(kind)})`;
  const list = typeof nodes === 'string' ? [nodes] : nodes;
  if (!Array.isArray(list) || list.length === 0 || !list.every((n) => typeof n === 'string' && n.length > 0)) {
    fail(where, 'the first argument is a node id or a non-empty array of node ids');
  }
  if (!FINDING_KINDS_ALL.includes(kind)) fail(where, `unknown kind of finding (use one of: ${FINDING_KINDS_ALL.join(', ')})`);
  if (typeof reason !== 'string' || reason.trim().length < 3) fail(where, 'give the reason as the third argument: one line that says why this is intended');
  checkKeys(`${where} window`, window, ['from', 'to']);
  const from = window.from === undefined ? null : num(where, 'from', window.from, 0, 3600);
  const to = window.to === undefined ? null : num(where, 'to', window.to, 0, 3600);
  if (from !== null && to !== null && to < from) fail(where, `the window ends (${to} s) before it starts (${from} s)`);
  return { nodes: [...list], kind, reason: reason.trim(), from, to };
}

type Nested<T> = T | readonly Nested<T>[];

function flatten<T>(items: Nested<T>, out: T[] = []): T[] {
  if (Array.isArray(items)) for (const it of items as readonly Nested<T>[]) flatten(it, out);
  else out.push(items as T);
  return out;
}

/**
 * Keys of the speed of the camera over a shot: [seconds from the start of the shot, units per second], at least two,
 * the first at 0, in order of time. A speed may be 0: the camera starts or ends at rest.
 */
function cameraSpeeds(where: string, value: unknown): SpeedKeys {
  return speedKeyList(where, 'speeds', value, 0, CAMERA_SPEED_MAX * 60, 'units per second');
}

/** Keys of a speed over the shot: [seconds from its start, speed], at least two, the first at 0, in order of time. */
function speedKeyList(where: string, name: string, value: unknown, min: number, max: number, unit: string): SpeedKeys {
  if (!Array.isArray(value) || value.length < 2) fail(where, `${name} must be a list of at least two keys [seconds from the start of the shot, ${unit}]`);
  const keys = value.map((k, i) => {
    if (!Array.isArray(k) || k.length !== 2) fail(where, `${name}[${i}] must be [seconds, ${unit}]`);
    return [num(where, `${name}[${i}][0]`, k[0], 0, 3600), num(where, `${name}[${i}][1]`, k[1], min, max)] as const;
  });
  if (keys[0]![0] !== 0) fail(where, `the first key of ${name} is at 0 seconds: the speed the shot starts with`);
  for (let i = 1; i < keys.length; i++) {
    if (!(keys[i]![0] > keys[i - 1]![0])) fail(where, `the keys of ${name} must be in order of time; key ${i} is at ${keys[i]![0]} s, after ${keys[i - 1]![0]} s`);
  }
  return keys;
}

/** The fastest the camera travels, in units per frame (1200 units per second). */
const CAMERA_SPEED_MAX = 20;

/**
 * A shot: everything needed to bake and render it. The result is validated as
 * a whole (ids, references, colours, string keys, timeline), so a shot that is
 * returned is a shot that can be rendered.
 */
export function shot(o: {
  id: string;
  seconds: number;
  /** Seed of everything random in the shot. */
  seed: number;
  palette: Palette;
  /** Language -> key -> text. */
  strings: StringTables;
  background: { inner: ColorRef; outer: ColorRef; center?: Vec2; radius?: number };
  /** Colour far layers fade toward. */
  atmosphere: ColorRef;
  layers: readonly LayerSpec[];
  /** Keys in any order; nested arrays (e.g. from stagger()) are flattened. */
  timeline?: Nested<Key>;
  /** Default { from: 'top-left' }. */
  light?: LightSpec;
  /** 0..1; default 0.5. */
  vignette?: number;
  camera?: {
    at?: Vec2;
    /** speeds: keys [seconds from the start of the shot, units per second] in place of the one speed (units per frame). */
    drift?: { speed?: number; heading?: number; wander?: number; period?: number; speeds?: readonly (readonly [number, number])[] };
    /**
     * A free-form path instead of the straight drift: the places the camera
     * looks at, the first being where it starts. With `speed` (units per frame)
     * it keeps that speed for the whole shot, round a closed path or there and
     * back on an open one; without it, it covers the path once over the shot.
     */
    path?: {
      points: readonly Vec2[];
      closed?: boolean;
      /** 0 = straight lines, 1 = a smooth curve through the points; default 1. */
      smooth?: number;
      speed?: number;
      /** When the path is covered once: steady (default), ease, in or out. */
      profile?: Exclude<MoveProfile, 'settle'>;
      ramp?: number;
      /** Seconds for a turn at the end of an open path; default 1.6. */
      turn?: number;
      /** Keys [seconds from the start of the shot, units per second] in place of speed, profile, ramp and turn. */
      speeds?: readonly (readonly [number, number])[];
    };
    pushIn?: { from?: number; to?: number };
    focus?: { far?: number; near?: number };
  };
  physics?: Partial<PhysicsSpec>;
  /** Intended exceptions to the motion review and the physics review, made with intended(); nested arrays are flattened. */
  intended?: Nested<IntendedSpec>;
  /**
   * Turns the contrast review on: the nodes named must stand out from what
   * lies behind them in the frame. A node blends when it differs from what is
   * behind it by less than `lightness` (CIE L*) and by less than `colour` (hue
   * and saturation, in CIELAB) along at least `edge` of its outline (default
   * 0.5), for `seconds` or longer (default 0.5). The two thresholds are the
   * production's to set. Left out: the review is off.
   */
  contrast?: { nodes: readonly string[]; lightness: number; colour: number; edge?: number; seconds?: number };
}): ShotSpec {
  const where = `shot("${o?.id}")`;
  checkKeys(where, o, [
    'id', 'seconds', 'seed', 'palette', 'strings', 'background', 'atmosphere', 'layers', 'timeline', 'light', 'vignette', 'camera', 'physics', 'intended', 'contrast',
  ]);
  if (!o.palette || !(o.palette.colors instanceof Map)) fail(where, 'palette must be made with definePalette()');
  if (!o.strings || typeof o.strings !== 'object' || Object.keys(o.strings).length === 0) {
    fail(where, 'strings must hold at least one language table, e.g. { en: { ... } }');
  }
  if (!Array.isArray(o.layers) || o.layers.length === 0) fail(where, 'layers must be a non-empty array');
  checkKeys(`${where} background`, o.background, ['inner', 'outer', 'center', 'radius']);
  const background: BackgroundSpec = {
    inner: color(where, 'background.inner', o.background.inner),
    outer: color(where, 'background.outer', o.background.outer),
    center: o.background.center === undefined ? [0.5, 0.46] : vec(where, 'background.center', o.background.center),
    radius: o.background.radius === undefined ? 0.72 : num(where, 'background.radius', o.background.radius, 0.05, 5),
  };
  const cam = o.camera ?? {};
  checkKeys(`${where} camera`, cam, ['at', 'drift', 'path', 'pushIn', 'focus']);
  if (cam.drift) checkKeys(`${where} camera.drift`, cam.drift, ['speed', 'heading', 'wander', 'period', 'speeds']);
  if (cam.drift?.speeds !== undefined && cam.drift.speed !== undefined) {
    fail(`${where} camera.drift`, 'speeds says how fast the camera drifts at every moment of the shot; leave speed out');
  }
  if (cam.pushIn) checkKeys(`${where} camera.pushIn`, cam.pushIn, ['from', 'to']);
  if (cam.focus) checkKeys(`${where} camera.focus`, cam.focus, ['far', 'near']);
  let cameraPath: CameraPathSpec | null = null;
  if (cam.path !== undefined) {
    const p = cam.path;
    const w = `${where} camera.path`;
    checkKeys(w, p, ['points', 'closed', 'smooth', 'speed', 'profile', 'ramp', 'turn', 'speeds']);
    if (cam.at !== undefined || cam.drift?.speed !== undefined || cam.drift?.heading !== undefined) {
      fail(w, 'a path replaces camera.at, camera.drift.speed and camera.drift.heading: leave them out (the first point of the path is where the camera starts)');
    }
    if (cam.drift?.speeds !== undefined) fail(w, 'a path takes its own speeds: give camera.path.speeds, and leave camera.drift.speeds out');
    if (p.speeds !== undefined && (p.speed !== undefined || p.profile !== undefined || p.ramp !== undefined || p.turn !== undefined)) {
      fail(w, 'speeds says how fast the camera goes along the path at every moment of the shot; leave speed, profile, ramp and turn out');
    }
    if (!Array.isArray(p.points) || p.points.length < 2) fail(w, 'points must be a list of at least two places [x, y]');
    const closed = p.closed ?? false;
    if (typeof closed !== 'boolean') fail(w, `closed must be true or false, got ${JSON.stringify(closed)}`);
    if (closed && p.points.length < 3) fail(w, 'a closed path needs at least three points');
    const profile = p.profile ?? 'steady';
    if (!['steady', 'ease', 'in', 'out'].includes(profile)) fail(w, `profile must be steady, ease, in or out; got ${JSON.stringify(profile)}`);
    if (p.speed !== undefined && (p.profile !== undefined || p.ramp !== undefined)) {
      fail(w, 'with a speed the camera keeps that speed for the whole shot; profile and ramp apply when the path is covered once (no speed)');
    }
    if (p.turn !== undefined && (p.speed === undefined || closed)) fail(w, 'turn applies to an open path with a speed: the time the camera takes to turn round at an end');
    cameraPath = {
      points: p.points.map((q, i) => vec(w, `points[${i}]`, q)),
      closed,
      smooth: num(w, 'smooth', p.smooth ?? 1, 0, 1),
      speed: p.speed === undefined ? null : num(w, 'speed', p.speed, 0, 20),
      profile,
      ramp: num(w, 'ramp', p.ramp ?? DEFAULT_RAMP, 0.02, 0.5),
      turn: num(w, 'turn', p.turn ?? 1.6, 0.1, 30),
      // Written only when they are given: a path without them is the data it always was.
      ...(p.speeds === undefined ? {} : { speeds: cameraSpeeds(w, p.speeds) }),
    };
    const length = pathLength(cameraPath);
    if (!(length > 1e-6)) fail(w, 'the path has no length');
    if (cameraPath.speeds && !closed) {
      const seconds = (frameCount(num(where, 'seconds', o.seconds, 1 / 60, 3600)) - 1) / 60;
      const reach = speedDistance(cameraPath.speeds, seconds);
      if (reach > length + 1e-6) {
        fail(w, `the speeds carry the camera ${reach.toFixed(1)} units by the last frame (${seconds.toFixed(2)} s), and the open path is ${length.toFixed(1)} units long: lower them, end them at 0 sooner, or close the path`);
      }
    }
  }
  const D = CAMERA_DEFAULTS;
  const camera: CameraSpec = {
    // A shot without a camera path is the data it always was.
    ...(cameraPath ? { path: cameraPath } : {}),
    at: cam.at === undefined ? (cameraPath ? cameraPath.points[0]! : D.at) : vec(where, 'camera.at', cam.at),
    drift: {
      speed: num(where, 'camera.drift.speed', cam.drift?.speed ?? D.drift.speed, 0, 20),
      heading: num(where, 'camera.drift.heading', cam.drift?.heading ?? D.drift.heading, -3600, 3600),
      wander: num(where, 'camera.drift.wander', cam.drift?.wander ?? D.drift.wander, 0, 400),
      period: num(where, 'camera.drift.period', cam.drift?.period ?? D.drift.period, 0.5, 600),
      // Written only when they are given: a drift without them is the data it always was.
      ...(cam.drift?.speeds === undefined ? {} : { speeds: cameraSpeeds(`${where} camera.drift`, cam.drift.speeds) }),
    },
    pushIn: {
      from: num(where, 'camera.pushIn.from', cam.pushIn?.from ?? D.pushIn.from, 0.1, 20),
      to: num(where, 'camera.pushIn.to', cam.pushIn?.to ?? D.pushIn.to, 0.1, 20),
    },
    focus: {
      far: num(where, 'camera.focus.far', cam.focus?.far ?? D.focus.far, 0, 100),
      near: num(where, 'camera.focus.near', cam.focus?.near ?? D.focus.near, 0, 400),
    },
  };
  const ph = o.physics ?? {};
  checkKeys(`${where} physics`, ph, ['gravity', 'linearDamping', 'angularDamping', 'restitution', 'friction', 'prewarm']);
  const P = PHYSICS_DEFAULTS;
  const physics: PhysicsSpec = {
    gravity: num(where, 'physics.gravity', ph.gravity ?? P.gravity, -5000, 5000),
    linearDamping: num(where, 'physics.linearDamping', ph.linearDamping ?? P.linearDamping, 0, 50),
    angularDamping: num(where, 'physics.angularDamping', ph.angularDamping ?? P.angularDamping, 0, 50),
    restitution: num(where, 'physics.restitution', ph.restitution ?? P.restitution, 0, 1),
    friction: num(where, 'physics.friction', ph.friction ?? P.friction, 0, 5),
    prewarm: num(where, 'physics.prewarm', ph.prewarm ?? P.prewarm, 0, 120),
  };
  const light: LightSpec = o.light ?? { from: 'top-left' };
  checkKeys(`${where} light`, light, ['from']);
  try {
    lightVector(light);
  } catch (e) {
    fail(where, (e as Error).message);
  }
  let contrast: ContrastSpec | null = null;
  if (o.contrast !== undefined) {
    const w = `${where} contrast`;
    checkKeys(w, o.contrast, ['nodes', 'lightness', 'colour', 'edge', 'seconds']);
    if (!Array.isArray(o.contrast.nodes) || o.contrast.nodes.length === 0 || !o.contrast.nodes.every((n) => typeof n === 'string' && n.length > 0)) {
      fail(w, 'nodes must be a non-empty list of the ids of the nodes to hold');
    }
    if (o.contrast.lightness === undefined || o.contrast.colour === undefined) {
      fail(w, 'give both thresholds, lightness and colour: the least differences that are enough. The engine has none of its own');
    }
    contrast = {
      nodes: [...o.contrast.nodes],
      lightness: num(w, 'lightness', o.contrast.lightness, 0, 100),
      colour: num(w, 'colour', o.contrast.colour, 0, 200),
      edge: num(w, 'edge', o.contrast.edge ?? 0.5, 0.05, 1),
      seconds: num(w, 'seconds', o.contrast.seconds ?? 0.5, 0, 60),
    };
  }
  const spec: ShotSpec = {
    id: idOf(where, o.id),
    seconds: num(where, 'seconds', o.seconds, 1 / 60, 3600),
    seed: num(where, 'seed', o.seed, -2147483648, 2147483647),
    palette: o.palette,
    strings: o.strings,
    light,
    background,
    atmosphere: color(where, 'atmosphere', o.atmosphere),
    vignette: o.vignette === undefined ? 0.5 : num(where, 'vignette', o.vignette, 0, 1),
    camera,
    physics,
    layers: o.layers,
    timeline: flatten<Key>(o.timeline ?? []),
    intended: flatten<IntendedSpec>(o.intended ?? []),
    // A shot that does not ask for the contrast review is the data it always was.
    ...(contrast ? { contrast } : {}),
  };
  // Validate the shot as a whole now, so that mistakes surface where it is defined.
  compileShot(spec);
  return spec;
}
