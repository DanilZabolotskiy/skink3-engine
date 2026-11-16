// Factory functions of the scene API. Each one validates its input, fills in
// defaults and returns plain data. Mistakes fail here, at definition time, with a
// message that says what to change.

import { springParams, type SpringSpec } from '../core/dynamics.ts';
import type { Vec2 } from '../core/math.ts';
import { lightVector, type LightSpec } from '../look/light.ts';
import { ROLES, type ColorRef, type Palette } from '../look/palette.ts';
import { DEFAULT_RAMP, type MoveProfile } from '../motion/curves.ts';
import { isSoundKey, type Key } from '../motion/intents.ts';
import { pathLength, type PathSpec } from '../motion/paths.ts';
import {
  blobShape,
  capsuleShape,
  circleShape,
  polygonShape,
  rectShape,
  regularPolygonShape,
  type ShapeSpec,
} from '../shape/geometry.ts';
import { isStringKey, type StringTables } from '../text/strings.ts';
import { compileShot } from './compile.ts';
import { FINDING_KINDS_ALL } from './types.ts';
import type {
  BackgroundSpec,
  BodySpec,
  CameraPathSpec,
  CameraSpec,
  EmitterNode,
  EyeNode,
  GroupNode,
  IdleSpec,
  IntendedSpec,
  LabelNode,
  LabelSide,
  LayerSpec,
  LevelSpec,
  LinkNode,
  FindingKind,
  PhysicsSpec,
  SceneNode,
  ShapeNode,
  ShotSpec,
  StrokeNode,
  TurbulenceSpec,
} from './types.ts';

export class SceneError extends Error {}

function fail(where: string, message: string): never {
  throw new SceneError(`${where}: ${message}`);
}

function checkKeys(where: string, opts: object, allowed: readonly string[]): void {
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

function num(where: string, name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(where, `${name} must be a number in ${min}..${max}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function vec(where: string, name: string, value: unknown): Vec2 {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    fail(where, `${name} must be [x, y], got ${JSON.stringify(value)}`);
  }
  return [value[0] as number, value[1] as number];
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
  at?: Vec2;
  /** Degrees, clockwise; default 0. */
  rotation?: number;
  /** Default 1. */
  scale?: number;
  /** 0..1 at the start; default 1. Animate it with fadeTo(). */
  opacity?: number;
  /** Automatic light; default true. */
  lit?: boolean;
  /** 0..1; default 0. */
  glow?: number;
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
  /** Id of a shape of the same layer: this shape and its children are drawn only inside that shape's outline. */
  clipTo?: string;
  /**
   * Makes the shape a content that fills its outline from the bottom: a number
   * 0..1 (how full it is at the start), or { at, wave } with a ripple of the
   * surface, wave: { amp, length?, speed? }. Animate it with levelTo().
   */
  level?: number | { at: number; wave?: { amp: number; length?: number; speed?: number } };
  /** Key of the node's voice in the bank of sounds: what its intents and its contacts sound like. */
  sound?: string;
}

const SHAPE_KEYS = [
  'id', 'fill', 'at', 'rotation', 'scale', 'opacity', 'lit', 'glow', 'rimLight', 'children', 'follow', 'idle', 'body',
  'cover', 'backdrop', 'clipTo', 'level', 'sound',
];

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
function extras(where: string, o: { cover?: boolean; backdrop?: boolean; clipTo?: string; level?: ShapeOptions['level'] }): {
  cover?: boolean;
  backdrop?: boolean;
  clipTo?: string;
  level?: LevelSpec;
} {
  return {
    ...(o.cover === undefined ? {} : { cover: flag(where, 'cover', o.cover) }),
    ...(o.backdrop === undefined ? {} : { backdrop: flag(where, 'backdrop', o.backdrop) }),
    ...(o.clipTo === undefined ? {} : { clipTo: idOf(where, o.clipTo) }),
    ...(o.level === undefined ? {} : { level: level(where, o.level) }),
  };
}

function shapeNode(where: string, o: ShapeOptions, shape: ShapeSpec, sway: SpringSpec | null): ShapeNode {
  if (o.level !== undefined && o.body !== undefined) fail(where, 'a rigid body cannot have a level');
  return {
    ...extras(where, o),
    ...voice(where, o.sound),
    type: 'shape',
    id: idOf(where, o.id),
    shape,
    fill: color(where, 'fill', o.fill),
    at: o.at === undefined ? [0, 0] : vec(where, 'at', o.at),
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

/** A rounded rectangle centred on its position. */
export function rect(o: ShapeOptions & { w: number; h: number; radius?: number }): ShapeNode {
  const where = `rect("${o?.id}")`;
  checkKeys(where, o, [...SHAPE_KEYS, 'w', 'h', 'radius']);
  return shapeNode(where, o, wrapShape(where, () => rectShape(o.w, o.h, o.radius ?? Math.min(o.w, o.h) * 0.22)), null);
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
  at?: Vec2;
  rotation?: number;
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
  /** Key of the node's voice in the bank of sounds: what its intents and its contacts sound like. */
  sound?: string;
}): GroupNode {
  const where = `group("${o?.id}")`;
  checkKeys(where, o, ['id', 'at', 'rotation', 'scale', 'opacity', 'upright', 'children', 'follow', 'idle', 'clipTo', 'sound']);
  if (o.upright !== undefined && typeof o.upright !== 'boolean') fail(where, `upright must be true or false, got ${JSON.stringify(o.upright)}`);
  return {
    ...(o.clipTo === undefined ? {} : { clipTo: idOf(where, o.clipTo) }),
    ...voice(where, o.sound),
    type: 'group',
    id: idOf(where, o.id),
    at: o.at === undefined ? [0, 0] : vec(where, 'at', o.at),
    rotation: o.rotation === undefined ? 0 : num(where, 'rotation', o.rotation, -1e5, 1e5),
    scale: o.scale === undefined ? 1 : num(where, 'scale', o.scale, 0.01, 100),
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
    width: o.width === undefined ? 7 : num(where, 'width', o.width, 0.5, 80),
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
 * it on from its first point, solidTo() closes its gaps. It is placed like a
 * shape and may be the child of a shape or a group.
 */
export function stroke(o: {
  id: string;
  points: readonly Vec2[];
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
  at?: Vec2;
  rotation?: number;
  scale?: number;
  /** 0..1 at the start; default 1. */
  opacity?: number;
  /** 0..1: the line glows (a halo around it); default 0. */
  glow?: number;
  /** Id of a shape of the same layer: the stroke is drawn only inside that shape's outline. */
  clipTo?: string;
  /** Key of the node's voice in the bank of sounds. */
  sound?: string;
}): StrokeNode {
  const where = `stroke("${o?.id}")`;
  checkKeys(where, o, ['id', 'points', 'color', 'width', 'closed', 'smooth', 'dash', 'solid', 'drawn', 'at', 'rotation', 'scale', 'opacity', 'glow', 'clipTo', 'sound']);
  if (!Array.isArray(o.points) || o.points.length < 2) fail(where, 'points must be a list of at least two points [x, y]');
  const closed = o.closed === undefined ? false : flag(where, 'closed', o.closed);
  if (closed && o.points.length < 3) fail(where, 'a closed stroke needs at least three points');
  const path: PathSpec = { points: o.points.map((p, i) => vec(where, `points[${i}]`, p)), closed, smooth: o.smooth === undefined ? 1 : num(where, 'smooth', o.smooth, 0, 1) };
  if (!(pathLength(path) > 1e-6)) fail(where, 'the points give a line without length');
  const width = o.width === undefined ? 7 : num(where, 'width', o.width, 0.5, 200);
  let dash: [number, number] | null = null;
  if (o.dash !== undefined) {
    if (!Array.isArray(o.dash) || o.dash.length !== 2) fail(where, `dash must be [dash, gap] in units (a dash of 0 is a dot), got ${JSON.stringify(o.dash)}`);
    dash = [num(where, 'dash[0]', o.dash[0], 0, 1e4), num(where, 'dash[1]', o.dash[1], 0.5, 1e4)];
  }
  if (o.solid !== undefined && dash === null) fail(where, 'solid is for a dashed stroke: give dash');
  return {
    ...(o.clipTo === undefined ? {} : { clipTo: idOf(where, o.clipTo) }),
    ...(o.drawn === undefined ? {} : { drawn: num(where, 'drawn', o.drawn, 0, 1) }),
    ...voice(where, o.sound),
    type: 'stroke',
    id: idOf(where, o.id),
    path,
    width,
    color: color(where, 'color', o.color),
    dash,
    solid: o.solid === undefined ? 0 : num(where, 'solid', o.solid, 0, 1),
    at: o.at === undefined ? [0, 0] : vec(where, 'at', o.at),
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
  checkKeys(where, o, ['id', 'text', 'target', 'fill', 'ink', 'side', 'gap', 'size', 'minSize', 'maxWidth', 'maxLines', 'opacity', 'follow', 'sound']);
  if (typeof o.text !== 'string' || !isStringKey(o.text)) {
    fail(where, `text must be a string-table key such as "label.core", got ${JSON.stringify(o.text)}. On-screen text never appears in scene code: put the words in the shot's string tables`);
  }
  const side = o.side ?? 'top';
  if (!['top', 'bottom', 'left', 'right'].includes(side)) fail(where, `side must be top, bottom, left or right, got ${JSON.stringify(side)}`);
  const size = o.size === undefined ? 38 : num(where, 'size', o.size, 8, 400);
  return {
    ...voice(where, o.sound),
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
 * A simple eye. The pupil looks at the node `lookAt`; the eye blinks now and
 * then. `open` sets its lids at the start (0 = shut and not drawn); openTo()
 * opens and closes them, blink() asks for a blink at a chosen moment.
 */
export function eye(o: {
  id: string;
  r: number;
  white: ColorRef;
  pupil: ColorRef;
  at?: Vec2;
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
  checkKeys(where, o, ['id', 'r', 'white', 'pupil', 'at', 'scale', 'opacity', 'lookAt', 'blink', 'open', 'sound']);
  return {
    ...voice(where, o.sound),
    type: 'eye',
    id: idOf(where, o.id),
    at: o.at === undefined ? [0, 0] : vec(where, 'at', o.at),
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
  /** Key of the emitter's voice in the bank of sounds: what its bursts sound like. */
  sound?: string;
}): EmitterNode {
  const where = `emitter("${o?.id}")`;
  checkKeys(where, o, [
    'id', 'colors', 'size', 'life', 'at', 'attach', 'area', 'rate', 'from', 'until', 'bursts', 'onContact', 'prewarm',
    'direction', 'spread', 'speed', 'gravity', 'drag', 'turbulence', 'glow', 'core', 'sizing', 'clipTo', 'sound',
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
}): LayerSpec {
  const where = `layer("${o?.id}")`;
  checkKeys(where, o, ['id', 'depth', 'nodes', 'blur', 'parallax', 'tint']);
  if (!Array.isArray(o.nodes)) fail(where, 'nodes must be an array');
  return {
    id: idOf(where, o.id),
    depth: num(where, 'depth', o.depth, -0.9, 50),
    nodes: o.nodes,
    blur: o.blur === undefined ? null : num(where, 'blur', o.blur, 0, 200),
    parallax: o.parallax === undefined ? null : num(where, 'parallax', o.parallax, 0, 20),
    tint: o.tint === undefined ? null : num(where, 'tint', o.tint, 0, 1),
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
    drift?: { speed?: number; heading?: number; wander?: number; period?: number };
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
    };
    pushIn?: { from?: number; to?: number };
    focus?: { far?: number; near?: number };
  };
  physics?: Partial<PhysicsSpec>;
  /** Intended exceptions to the motion review and the physics review, made with intended(); nested arrays are flattened. */
  intended?: Nested<IntendedSpec>;
}): ShotSpec {
  const where = `shot("${o?.id}")`;
  checkKeys(where, o, [
    'id', 'seconds', 'seed', 'palette', 'strings', 'background', 'atmosphere', 'layers', 'timeline', 'light', 'vignette', 'camera', 'physics', 'intended',
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
  if (cam.drift) checkKeys(`${where} camera.drift`, cam.drift, ['speed', 'heading', 'wander', 'period']);
  if (cam.pushIn) checkKeys(`${where} camera.pushIn`, cam.pushIn, ['from', 'to']);
  if (cam.focus) checkKeys(`${where} camera.focus`, cam.focus, ['far', 'near']);
  let cameraPath: CameraPathSpec | null = null;
  if (cam.path !== undefined) {
    const p = cam.path;
    const w = `${where} camera.path`;
    checkKeys(w, p, ['points', 'closed', 'smooth', 'speed', 'profile', 'ramp', 'turn']);
    if (cam.at !== undefined || cam.drift?.speed !== undefined || cam.drift?.heading !== undefined) {
      fail(w, 'a path replaces camera.at, camera.drift.speed and camera.drift.heading: leave them out (the first point of the path is where the camera starts)');
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
    };
    if (!(pathLength(cameraPath) > 1e-6)) fail(w, 'the path has no length');
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
  try {
    lightVector(light);
  } catch (e) {
    fail(where, (e as Error).message);
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
  };
  // Validate the shot as a whole now, so that mistakes surface where it is defined.
  compileShot(spec);
  return spec;
}
