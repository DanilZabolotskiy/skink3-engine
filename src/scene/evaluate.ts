// Evaluating a shot at a frame: a pure function of the compiled shot, the bake,
// the frame number and the language. The result is a display list the renderer
// draws without further decisions.

import { cameraAt, layerView, type CameraState, type LayerView } from '../camera/camera.ts';
import { DEG, quadSub, vrot, xfApply, xfCompose, XF_IDENTITY, type Quad, type Vec2, type Vec3, type Xf } from '../core/math.ts';
import { FPS } from '../core/time.ts';
import { pulseSpan } from '../motion/curves.ts';
import { sampleDriven } from '../motion/drive.ts';
import { pathAt, pathTable, type PathSpec } from '../motion/paths.ts';
import {
  sampleAway,
  sampleAxis,
  sampleBend,
  sampleCount,
  sampleDrawn,
  sampleHeight,
  sampleLevel,
  sampleRise,
  sampleLid,
  sampleOpacity,
  samplePathTurn,
  samplePos,
  sampleReveal,
  sampleRot,
  sampleScale,
  sampleSolid,
  sampleStretch,
  sampleStrokePulses,
  sampleTravelling,
  sampleWidth,
} from '../motion/tracks.ts';
import type { Bake } from '../physics/cache.ts';
import { isRegion, transformOutline, outlineOf, reach, type ShapeSpec } from '../shape/geometry.ts';
import { hull, ringOf, roofFaces, sideRing, spanOf, wallOpenings, type RoofFace, type Upright } from '../shape/solid.ts';
import { textBlock, type TextBlock } from '../text/block.ts';
import { COUNT_MARK, countRuns, countSlot, formatCount, widestCount, type CountSlot } from '../text/count.ts';
import { labelGeometry, LABEL_PROPORTIONS, type LabelGeometry } from '../text/label.ts';
import { layoutText, type TextLayout } from '../text/layout.ts';
import { parseRuns, runSpans, type RunSpan } from '../text/runs.ts';
import { resolveString } from '../text/strings.ts';
import { sampleBackground, type BackgroundState } from './background.ts';
import { BLINK, type CLayer, type CNode, type CompiledShot } from './compile.ts';
import { sampleFill } from './fill.ts';
import { formAt } from './form.ts';
import { globeFade, globePlace, globeView, surfaceLine, surfacePath, surfaceRuns } from './globe.ts';
import { regionAt, strokePathAt } from './outline.ts';
import { eyeOf, hingedAxes, intoPlane, perspAt, planeMap, planePoint, project, throughPlane, type Eye, type PlaneAxes, type PlaneMap } from './space.ts';
import { SHADOW_REACH, type CastSpec, type GroupNode, type LabelSide, type StrokeNode } from './types.ts';
import { groundField, type GroundField } from './ground.ts';

/** Where the state with history comes from: the bake, or the bake in progress. */
export interface PoseSource {
  /** Pose of a rigid body at a frame. */
  body(slot: number, frame: number): { x: number; y: number; rot: number };
  /** Position of a spring-driven point at a frame; `rest` is where it would be without the spring. */
  spring(slot: number, frame: number, rest: Vec2): Vec2;
  /**
   * Direction (radians) of a swaying stick at a frame. `pivot` is its fixed
   * end, `rest` its direction without the spring, `lever` the distance from the
   * pivot to its free end, and `shown` is false while the stick has no size.
   */
  sway(slot: number, frame: number, pivot: Vec2, rest: number, lever: number, shown: boolean): number;
}

/**
 * The direction of a swaying stick from the baked place of its free end: the
 * angle from the pivot to that place, taken on the turn nearest to `rest`, so
 * that it never wraps away from the authored rotation.
 */
export function swayDirection(tipX: number, tipY: number, pivot: Vec2, rest: number): number {
  const dx = tipX - pivot[0];
  const dy = tipY - pivot[1];
  if (Math.hypot(dx, dy) <= 1e-6) return rest;
  const a = Math.atan2(dy, dx);
  return a + 2 * Math.PI * Math.round((rest - a) / (2 * Math.PI));
}

export function posesFromBake(bake: Bake): PoseSource {
  return {
    body: (slot, frame) => ({ x: bake.bodyX(slot, frame), y: bake.bodyY(slot, frame), rot: bake.bodyRot(slot, frame) }),
    spring: (slot, frame) => [bake.springX(slot, frame), bake.springY(slot, frame)],
    sway: (slot, frame, pivot, rest) => swayDirection(bake.springX(slot, frame), bake.springY(slot, frame), pivot, rest),
  };
}

const SIDE_DIR: Readonly<Record<LabelSide, Vec2>> = {
  top: [0, -1],
  bottom: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

/**
 * The shape of a shape node at time t: the one it was given, what its reshape keys have made of it by then, or,
 * for a region whose points are driven or lie in the space of a perspective layer, the outline they give at t.
 */
export function shapeOf(n: CNode, t: number): ShapeSpec {
  if (n.node.type !== 'shape') throw new Error(`"${n.id}" is not a shape`);
  if (n.form) return formAt(n, t).shape ?? n.node.shape;
  return n.outline ? regionAt(n.outline, t) : n.node.shape;
}

/** The path of a stroke at time t: the one it was given, what its reshape keys have made of it by then, or the line its driven points or its points of the space give at t. */
export function strokePathOf(n: CNode, t: number): PathSpec {
  if (n.node.type !== 'stroke') throw new Error(`"${n.id}" is not a stroke`);
  // A line on a globe: as it lies in the globe's own space at that moment, its far part included.
  if (n.globe) return surfacePath(surfaceLine(n.node.path), globeView(n.globe.spec, t), n.globe.r);
  if (n.form) return formAt(n, t).path ?? n.node.path;
  return n.outline ? strokePathAt(n.outline, t) : n.node.path;
}

/** How far a node reaches from its origin in a world direction at time t, in units of its layer. */
function reachOf(n: CNode, xf: Xf, dir: Vec2, t: number): number {
  const node = n.node;
  if (node.type === 'shape') {
    const local = vrot(dir, -xf.rot);
    const axis = n.axis ? sampleAxis(n.axis, t) : null;
    if (!axis) return reach(shapeOf(n, t), local) * xf.scale;
    // A shape whose width and height were changed: its outline as it is drawn.
    let best = -Infinity;
    for (const p of outlineOf(shapeOf(n, t))) best = Math.max(best, (p[0] * axis.sx + axis.cx) * local[0] + (p[1] * axis.sy + axis.cy) * local[1]);
    return best * xf.scale;
  }
  if (node.type === 'eye') return node.r * xf.scale;
  return 0;
}

/** A shape with a level at one moment: how full it is and where its surface lies, in the space of its layer. */
export interface LevelGeometry {
  /** 0 = empty, 1 = full. */
  readonly level: number;
  /** The box around the shape's outline. */
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  /** Height of the surface without its ripple. */
  readonly flat: number;
  /** The middle of the surface, ripple included: where the children of the shape ride. */
  readonly cx: number;
  readonly y: number;
  /** The ripple: height, length of one wave, and how far it has run. */
  readonly amp: number;
  readonly length: number;
  readonly phase: number;
}

/** Below this level a content is empty and is not drawn. */
export const LEVEL_EMPTY = 1e-4;

/**
 * Where the surface of a shape with a level lies at time t. The surface is
 * level in the layer's space whatever the shape's rotation: a content stays
 * level when its vessel tilts.
 */
export function levelGeometry(n: CNode, xf: Xf, t: number): LevelGeometry {
  const node = n.node;
  if (node.type !== 'shape' || !node.level || !n.level) throw new Error(`"${n.id}" has no level`);
  const level = Math.min(1, Math.max(0, sampleLevel(n.level, t)));
  const cos = Math.cos(xf.rot) * xf.scale;
  const sin = Math.sin(xf.rot) * xf.scale;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const p of outlineOf(shapeOf(n, t))) {
    const x = xf.x + p[0] * cos - p[1] * sin;
    const y = xf.y + p[0] * sin + p[1] * cos;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  const flat = bottom - level * (bottom - top);
  const wave = node.level.wave;
  // The ripple dies out toward empty and toward full, so that 0 is empty and 1 is full.
  const amp = wave ? wave.amp * xf.scale * Math.min(1, level / 0.06, (1 - level) / 0.06) : 0;
  const length = wave ? wave.length * xf.scale : 1;
  const phase = wave ? wave.speed * xf.scale * t : 0;
  const cx = (left + right) / 2;
  const y = amp > 0 ? flat + amp * Math.sin((2 * Math.PI * (cx - phase)) / length) : flat;
  return { level, left, right, top, bottom, flat, cx, y, amp, length, phase };
}

/** The part of the layer below the surface, as a polygon: what a content with a level is clipped to. */
export function levelClip(g: LevelGeometry): Vec2[] {
  const pad = 4;
  const x0 = g.left - pad;
  const x1 = g.right + pad;
  const out: Vec2[] = [];
  if (g.amp <= 0) {
    out.push([x0, g.flat], [x1, g.flat]);
  } else {
    const steps = Math.max(8, Math.min(512, Math.ceil(((x1 - x0) / g.length) * 20)));
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps;
      out.push([x, g.flat + g.amp * Math.sin((2 * Math.PI * (x - g.phase)) / g.length)]);
    }
  }
  out.push([x1, g.bottom + pad], [x0, g.bottom + pad]);
  return out;
}

/**
 * What a frame of a shot with a perspective layer holds beside the world
 * transforms: where its nodes lie in their planes and in the space.
 */
export interface Places {
  /** By node index: the transform of a node that lies in a plane, in that plane; undefined for every other node. */
  readonly flat: (Xf | undefined)[];
  /** By node index of a group that lies in a plane: the map of its plane at the frame, or null while the camera cannot see it. */
  readonly planes: Map<number, PlaneMap | null>;
  /** By node index, for the nodes listed in a perspective layer: how far each is from the camera, and its place in the space (three numbers each). */
  readonly far: Float64Array;
  readonly point: Float64Array;
  /** By layer index: the camera of a perspective layer at the frame; null for a flat layer. */
  readonly eyes: (Eye | null)[];
  /**
   * By node index of a group that lies in a plane, in a shot with bodies or with children drawn far to near: the
   * point of that plane the camera stands over, in the units of the plane, and how high it is over the front of it.
   */
  readonly stands: Map<number, Vec3>;
  /** By node index of a group that lies in a plane with a ground: the ground at the frame, once its relief is placed. */
  readonly grounds: Map<number, GroundField>;
  /** By node index, in a plane with a ground: how high over the plane the ground stands the node (its units); 0 for any other. */
  readonly lifted: Float64Array;
  /** By node index: 1 for a body whose transform is that of its top at the frame, so that what is inside it rides on that top. */
  readonly topped: Uint8Array;
}

export function newPlaces(c: CompiledShot): Places {
  return {
    flat: new Array<Xf | undefined>(c.nodes.length),
    planes: new Map(),
    far: new Float64Array(c.nodes.length),
    point: new Float64Array(3 * c.nodes.length),
    eyes: c.layers.map(() => null),
    stands: new Map(),
    grounds: new Map(),
    lifted: new Float64Array(c.nodes.length),
    topped: new Uint8Array(c.nodes.length),
  };
}

/**
 * Where a body with a height stands. The transform of such a node is that of
 * its top; a point p of the top, in the node's own units, stands on the ground
 * at k p + (x, y), in those units and through that transform. In a flat layer
 * the foot is the top moved down the screen (k is 1); in a plane of a
 * perspective layer it is the top drawn smaller or larger about the point of
 * the plane the camera stands over.
 *
 * It also says how the body stands (Upright): its height at the frame, and
 * where a point at any height over the ground is drawn.
 */
export interface Foot extends Upright {
  readonly k: number;
  readonly x: number;
  readonly y: number;
  /**
   * A body of a plane with `tall` that is taller than RISE_NEAR of the camera's height: where it is drawn at its
   * whole height, its top (`xf`, behind the camera in the plane when the top is higher than the eye) and its foot.
   * The foot itself says where it stands for everything else (its order, its shadow), at the height it is held to.
   */
  readonly lift?: { readonly xf: Xf; readonly foot: Foot };
}

/** A body in a plane never rises nearer the camera than this share of the camera's own height over the plane. */
const RISE_NEAR = 0.9;

/** A tall body is never drawn with its top this near the height of the eye, as a share of that height: there the top has no place in the plane. */
const LIFT_EYE_GAP = 1e-3;

/**
 * Where a body of a plane with `tall` is drawn at its whole height `high` (in the units of the plane): its top, seen
 * from the camera, is the foot drawn larger about the point the camera stands over, as for any body; higher than the
 * camera, larger by a negative factor, on the far side of that point, behind the camera. `xf` is the node's own
 * transform in the plane, (gx, gy) its place from that point, `over` that point in the units of the body.
 */
function liftOf(xf: Xf, high: number, stand: Vec3, gx: number, gy: number, over: Vec2): { xf: Xf; foot: Foot } {
  const eye = stand[2];
  const h = Math.abs(eye - high) < LIFT_EYE_GAP * eye ? eye * (1 + LIFT_EYE_GAP) : high;
  const grow = eye / (eye - h);
  const back = vrot([(gx * (1 - grow)) / (xf.scale * grow), (gy * (1 - grow)) / (xf.scale * grow)], -xf.rot);
  return {
    xf: { x: stand[0] + gx * grow, y: stand[1] + gy * grow, rot: xf.rot, scale: xf.scale * grow },
    foot: { k: 1 / grow, x: back[0], y: back[1], h: h / xf.scale, ux: over[0], uy: over[1], uh: eye / xf.scale, tall: true },
  };
}

/**
 * Points of a region or a stroke of a plane with a ground, in the node's own units, laid on the ground point by point:
 * each as the camera sees it at the height of the ground under it (its parent's height `base` taken off first), and
 * a stretch longer than a cell of the ground's grid cut into pieces that each follow it.
 */
function laidOn(points: readonly Vec2[], closed: boolean, xf: Xf, base: number, ground: GroundField, stand: Vec3): Vec2[] {
  const eye = stand[2];
  const back = (eye - base) / eye;
  const cos = Math.cos(xf.rot);
  const sin = Math.sin(xf.rot);
  const step = ground.cell / Math.max(1e-9, xf.scale);
  const out: Vec2[] = [];
  const put = (px: number, py: number): void => {
    const ux = stand[0] + (xf.x + (px * cos - py * sin) * xf.scale - stand[0]) * back;
    const uy = stand[1] + (xf.y + (px * sin + py * cos) * xf.scale - stand[1]) * back;
    const grow = eye / (eye - Math.min(ground.at(ux, uy), RISE_NEAR * eye));
    const dx = (stand[0] + (ux - stand[0]) * grow - xf.x) / xf.scale;
    const dy = (stand[1] + (uy - stand[1]) * grow - xf.y) / xf.scale;
    out.push([dx * cos + dy * sin, -dx * sin + dy * cos]);
  };
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    put(a[0], a[1]);
    if (i === n - 1 && !closed) break;
    const b = points[(i + 1) % n]!;
    const pieces = Math.min(64, Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k < pieces; k++) put(a[0] + ((b[0] - a[0]) * k) / pieces, a[1] + ((b[1] - a[1]) * k) / pieces);
  }
  return out;
}

/** The camera's place over a plane, as seen from a height `base` over it: the same point, that much lower. */
function lowered(stand: Vec3 | undefined, base: number): Vec3 | undefined {
  return stand && base !== 0 ? [stand[0], stand[1], stand[2] - base] : stand;
}

/** A node of a plane drawn point by point on its ground, not as a whole: a region and a stroke. */
function followsPointwise(n: CNode): boolean {
  return n.node.type === 'stroke' || (n.node.type === 'shape' && n.node.shape.kind === 'polygon' && (n.node.shape.smooth !== undefined || n.node.shape.rings !== undefined) && !n.node.relief);
}

/** A relief of the ground of its plane: it is drawn raised, and is not lifted as a whole. */
function isGround(c: CompiledShot, n: CNode): boolean {
  return c.grounds?.get(n.plane)?.includes(n.index) === true;
}

/**
 * A node of a plane with a ground, at the height of the ground under its place: its transform in the plane grown about
 * the point the camera stands over, as a body's top is (the transform of its parent was grown for the parent's own
 * height), and that height. A node inside a body rides on its top; a region and a stroke follow the ground point by
 * point where they are drawn; what comes before the relief lies flat.
 */
function onGround(c: CompiledShot, n: CNode, xf: Xf, space: Places): [Xf, number] {
  const base = n.parent >= 0 ? space.lifted[n.parent]! : 0;
  const ground = space.grounds.get(n.plane);
  const stand = space.stands.get(n.plane);
  if (!ground || !stand || !(stand[2] > 0) || (n.parent >= 0 && space.topped[n.parent]) || followsPointwise(n) || isGround(c, n)) return [xf, base];
  const eye = stand[2];
  // Where the node would be on the plane without its parent's height, and the ground there.
  const back = (eye - base) / eye;
  const z = Math.min(ground.at(stand[0] + (xf.x - stand[0]) * back, stand[1] + (xf.y - stand[1]) * back), RISE_NEAR * eye);
  const grow = (eye - base) / (eye - z);
  return [{ x: stand[0] + (xf.x - stand[0]) * grow, y: stand[1] + (xf.y - stand[1]) * grow, rot: xf.rot, scale: xf.scale * grow }, z];
}

/**
 * World transforms of all nodes at a frame, in the space of their layer.
 * For a label the transform holds the tip of its tail and its pop scale.
 * Nodes without a place of their own (links, emitters) get the identity.
 *
 * In a perspective layer the transform of a node is where the camera of the
 * layer draws it: its place, and its size there. For a node that lies in a
 * plane that is its place exactly and its size and its turn as they are at
 * that place; what such a node is in its plane goes to `places`.
 *
 * The transform of a body with a height (a rise) is that of its top, and what
 * is inside it rides on that top; where its foot stands goes to `feet`.
 */
export function computeWorld(c: CompiledShot, frame: number, poses: PoseSource, places?: Places, feet?: Map<number, Foot>): Xf[] {
  const t = frame / FPS;
  const out: Xf[] = new Array<Xf>(c.nodes.length).fill(XF_IDENTITY);
  // The children of a shape with a level ride on its surface: their frame is the middle of the surface.
  let surfaces: Map<number, Xf> | null = null;
  // A shot with a perspective layer: the cameras of this frame, and the planes as they are found.
  const space = c.spatial ? places ?? newPlaces(c) : null;
  if (space) {
    space.planes.clear();
    space.stands.clear();
    space.flat.fill(undefined);
    if (c.grounds) {
      space.grounds.clear();
      space.lifted.fill(0);
      space.topped.fill(0);
    }
    c.layers.forEach((layer, li) => {
      space.eyes[li] = layer.persp ? eyeOf(perspAt(layer.persp, t)) : null;
    });
  }

  for (const n of c.activeNodes ?? c.nodes) {
    const node = n.node;
    if (node.type !== 'shape' && node.type !== 'group' && node.type !== 'eye' && node.type !== 'stroke' && node.type !== 'text') continue;
    const scale = node.scale * (n.scale ? sampleScale(n.scale, t) : 1);
    if (n.bodySlot >= 0) {
      const p = poses.body(n.bodySlot, frame);
      out[n.index] = { x: p.x, y: p.y, rot: p.rot, scale };
      continue;
    }
    let [x, y] = samplePos(n.pos!, t);
    if (n.idleNoise && (node.type === 'shape' || node.type === 'group') && node.idle) {
      const u = t / node.idle.period;
      x += node.idle.amp * n.idleNoise.n1(u);
      y += node.idle.amp * n.idleNoise.n1(u + 71.3);
    }
    // A node inside a group that lies in a plane is placed in that plane.
    const inPlane = space !== null && n.plane >= 0;
    const parent = n.parent >= 0 ? surfaces?.get(n.parent) ?? (inPlane ? space.flat[n.parent]! : out[n.parent]!) : XF_IDENTITY;
    // A travel may turn the node: it rolls along its path, or faces along it.
    const rot = (n.pos!.turns ? sampleRot(n.rot!, t) + samplePathTurn(n.pos!, t) : sampleRot(n.rot!, t)) * DEG;
    let xf: Xf;
    if (space && n.persp) {
      // Listed in a perspective layer: a place of the space, seen through the camera of the layer.
      const eye = space.eyes[n.layer]!;
      const z = sampleAway(n.away!, t);
      space.point[3 * n.index] = x;
      space.point[3 * n.index + 1] = y;
      space.point[3 * n.index + 2] = z;
      if (node.type === 'group' && node.plane) {
        // It lies in a plane: everything in it is drawn through the map of that plane.
        const axes = n.hinge ? hingedAxes(node.plane, n.hinge.x ? sampleRot(n.hinge.x, t) : 0, n.hinge.y ? sampleRot(n.hinge.y, t) : 0) : node.plane;
        let map = planeMap(eye, [x, y, z], axes);
        if (map && !map.front && node.back === false) map = null;
        // In a shot with bodies, or with children drawn far to near: where the camera stands in that plane, and how high over it.
        if (c.risen || c.sorted || c.grounds?.has(n.index)) space.stands.set(n.index, standOf(eye, [x, y, z], axes));
        const flat: Xf = { x: 0, y: 0, rot, scale };
        space.flat[n.index] = flat;
        space.planes.set(n.index, map);
        space.far[n.index] = project(eye, [x, y, z]).far;
        out[n.index] = map ? throughPlane(map, flat) : { x: 0, y: 0, rot, scale: 0 };
        continue;
      }
      if (n.form && n.form.dims === 3) {
        // Its outline is points of the space: it is drawn around the picture of their middle.
        const state = formAt(n, t);
        space.far[n.index] = state.far;
        xf = { x: state.x, y: state.y, rot, scale: scale * state.k };
      } else {
        const p = project(eye, [x, y, z]);
        space.far[n.index] = p.far;
        xf = { x: p.x, y: p.y, rot, scale: scale * p.k };
      }
    } else if (n.globe) {
      // On a globe: a line lies on its surface, in the globe's own space; a thing stands at its place [lon, lat], turned to its heading.
      if (node.type === 'stroke') xf = parent;
      else {
        const at = globePlace(n.globe.spec, n.globe.r, x, y, node.z ?? 0, rot / DEG, t);
        xf = xfCompose(parent, { x: at.x, y: at.y, rot: at.rot * DEG, scale });
        if (node.type === 'group' && node.upright) xf = { ...xf, rot };
      }
    } else {
      xf = xfCompose(parent, { x, y, rot, scale });
      // An upright group keeps its own rotation, whatever it is attached to.
      if (node.type === 'group' && node.upright) xf = { ...xf, rot };
    }
    if (n.springKind === 'follow') {
      const p = poses.spring(n.springSlot, frame, [xf.x, xf.y]);
      xf = { ...xf, x: p[0], y: p[1] };
    } else if (n.springKind === 'sway' && node.type === 'shape' && node.shape.kind === 'capsule') {
      // The stick keeps its first end and its length; the spring only turns it.
      const lever = (node.shape.length - 2 * node.shape.r) * Math.max(xf.scale, 0.05);
      xf = { ...xf, rot: poses.sway(n.springSlot, frame, [xf.x, xf.y], xf.rot, lever, xf.scale > HIDDEN) };
    }
    // On a plane with a ground: how high the ground stands the node, and the camera's height over that.
    let base = 0;
    if (inPlane && c.grounds) {
      [xf, base] = onGround(c, n, xf, space);
      space.lifted[n.index] = base;
    }
    if (n.pos?.lifts) {
      // A travel along a path with heights: the node is drawn as high over the ground as the path runs.
      const z = sampleHeight(n.pos, t) * parent.scale;
      if (z !== 0) {
        const stand = inPlane ? lowered(space.stands.get(n.plane), base) : undefined;
        if (stand && stand[2] > 0) {
          // In a plane, as the top of a body that high: drawn larger about the point the camera stands over.
          const grow = stand[2] / (stand[2] - Math.min(z, RISE_NEAR * stand[2]));
          xf = { x: stand[0] + (xf.x - stand[0]) * grow, y: stand[1] + (xf.y - stand[1]) * grow, rot: xf.rot, scale: xf.scale * grow };
        } else if (!inPlane && !n.persp) xf = { ...xf, y: xf.y - z };
      }
    }
    if (n.rise) {
      // A body with a height: from here on its transform is that of its top.
      const rise = sampleRise(n.rise, t);
      // A body with a roof keeps its roof while it lies flat: the roof stands on the ground then.
      if (rise > RISE_FLAT || (node.type === 'shape' && node.roof !== undefined)) {
        const stand = inPlane ? lowered(space.stands.get(n.plane), base) : undefined;
        if (inPlane && c.grounds) space.topped[n.index] = 1;
        if (stand) {
          // In a plane the body stands on the plane, toward its front. Seen from the camera, a point that high over a
          // place of the plane lies on the line from the point the camera stands over through that place, farther
          // out the higher it is: the top is the foot drawn larger about that point.
          const height = stand[2] > 0 ? Math.min(rise * xf.scale, RISE_NEAR * stand[2]) : rise * xf.scale;
          const grow = stand[2] / (stand[2] - height);
          const gx = xf.x - stand[0];
          const gy = xf.y - stand[1];
          const back = vrot([(gx * (1 - grow)) / (xf.scale * grow), (gy * (1 - grow)) / (xf.scale * grow)], -xf.rot);
          // The point the camera stands over, and the height of the camera, in the units of the body.
          const over = vrot([-gx / xf.scale, -gy / xf.scale], -xf.rot);
          // In a plane with tall: a body that, with its roof, reaches past what the others are held to is drawn whole.
          const roofed = node.type === 'shape' && node.roof ? node.roof.height : 0;
          const lift = stand[2] > 0 && (rise + roofed) * xf.scale > RISE_NEAR * stand[2] && (c.nodes[n.plane]!.node as GroupNode).tall ? liftOf(xf, rise * xf.scale, stand, gx, gy, over) : undefined;
          feet?.set(n.index, { k: 1 / grow, x: back[0], y: back[1], h: height / xf.scale, ux: over[0], uy: over[1], uh: stand[2] / xf.scale, ...(lift ? { lift } : {}) });
          xf = { x: stand[0] + gx * grow, y: stand[1] + gy * grow, rot: xf.rot, scale: xf.scale * grow };
        } else {
          // In a flat layer the top is the foot moved up the screen.
          const down = vrot([0, rise], -xf.rot);
          const unit = vrot([0, 1], -xf.rot);
          feet?.set(n.index, { k: 1, x: down[0], y: down[1], h: rise, ux: unit[0], uy: unit[1], uh: 0 });
          xf = { ...xf, y: xf.y - rise * xf.scale };
        }
      }
    }
    if (inPlane) {
      space.flat[n.index] = xf;
      // The ground of the plane, once its relief is placed: what comes after it stands on it.
      if (c.grounds?.get(n.plane)?.includes(n.index) && node.type === 'shape' && node.relief && node.shape.kind === 'polygon') {
        space.grounds.set(n.plane, groundField(n.index, node.relief, node.shape.points, xf, space.grounds.get(n.plane)));
      }
      const map = space.planes.get(n.plane);
      out[n.index] = map ? throughPlane(map, xf) : { ...xf, scale: 0 };
    } else out[n.index] = xf;
    if (n.level && n.subtreeEnd > n.index) {
      const g = levelGeometry(n, xf, t);
      (surfaces ??= new Map<number, Xf>()).set(n.index, { x: g.cx, y: g.y, rot: xf.rot, scale: xf.scale });
    }
  }

  for (const n of c.activeNodes ?? c.nodes) {
    const node = n.node;
    if (node.type !== 'label') continue;
    const target = c.nodes[n.targetIndex]!;
    const txf = out[n.targetIndex]!;
    const dir = SIDE_DIR[node.side];
    const d = reachOf(target, txf, dir, t) + node.gap;
    let tip: Vec2 = [txf.x + dir[0] * d, txf.y + dir[1] * d];
    if (n.springKind === 'follow') tip = poses.spring(n.springSlot, frame, tip);
    out[n.index] = { x: tip[0], y: tip[1], rot: 0, scale: n.scale ? sampleScale(n.scale, t) : 1 };
  }
  return out;
}

/** A body lower than this, in its units, lies flat: it is drawn as the shape or the line it is. */
const RISE_FLAT = 1e-6;

/** Where the camera stands in a plane: the point of the plane it is over, in the units of the plane, and how high it is over the front of the plane. */
function standOf(eye: Eye, origin: Vec3, axes: PlaneAxes): Vec3 {
  const o: Vec3 = [eye.pos[0] - origin[0], eye.pos[1] - origin[1], eye.pos[2] - origin[2]];
  const along = (a: Vec3): number => o[0] * a[0] + o[1] * a[1] + o[2] * a[2];
  // The front of a plane is the side its picture reads from: y x x.
  const front: Vec3 = [axes.y[1] * axes.x[2] - axes.y[2] * axes.x[1], axes.y[2] * axes.x[0] - axes.y[0] * axes.x[2], axes.y[0] * axes.x[1] - axes.y[1] * axes.x[0]];
  return [along(axes.x), along(axes.y), along(front)];
}

/**
 * Every drawn item carries `alpha`: the product of its own opacity and the
 * opacities of everything it is nested in. The picture itself gets that opacity
 * from the groups around the item (see GroupItem); `alpha` is what the glow and
 * the checks use.
 */
export interface ShapeItem {
  readonly kind: 'shape';
  readonly node: CNode;
  readonly xf: Xf;
  readonly alpha: number;
  /**
   * A shape with a level that is neither empty nor full: the polygon, in the
   * layer's space, of everything below its surface. The shape is drawn inside it.
   */
  readonly level?: readonly Vec2[];
  /** A region whose outline is keyed (reshape), driven, or given by points of the space: the shape it has at this frame. Left out: the shape of its node. */
  readonly shape?: ShapeSpec;
  /** A shape whose fill is keyed (fillTo): the fill it has at this frame (#RRGGBB). Left out: the fill of its node. */
  readonly fill?: string;
  /** A globe: the moment, in seconds, its turn and the drift of its layers are drawn at. Left out: any other shape. */
  readonly globeAt?: number;
  /** A body that stands up at this frame (a rise above 0): `xf` is its top, and this is where its foot stands. Left out: it lies flat. */
  readonly foot?: Foot;
  /**
   * A body of a group that says what detail its bodies are worth (detail): how large it is on screen, and whether it
   * is so small that its top alone is drawn (it has no `foot` then). Left out: a body of no such group.
   */
  readonly detail?: Worth;
  /**
   * A shape that stands up from its plane (stands): the point of the plane the camera stands over and how high over
   * the plane the camera is, in the units of the plane. Left out: it lies in the plane, or in no plane.
   */
  readonly upon?: Vec3;
  /**
   * The relief that is the ground of its plane (ground): the point the camera stands over and how high over the plane
   * the camera is, in the relief's own units. It is drawn raised. Left out: it is drawn flat.
   */
  readonly raise?: Vec3;
}

export interface EyeItem {
  readonly kind: 'eye';
  readonly node: CNode;
  readonly xf: Xf;
  readonly alpha: number;
  /** Pupil offset in the eye's local space, as a fraction of its free travel (length 0..1). */
  readonly look: Vec2;
  /** 1 = open, near 0 = closed; a little above 1 while an opening overshoots. */
  readonly open: number;
}

export interface LinkItem {
  readonly kind: 'link';
  readonly node: CNode;
  /** The whole link between its two nodes, already trimmed at both ends. */
  readonly curve: Quad;
  /** How much of it is drawn, 0..1 from the start. */
  readonly reveal: number;
  readonly pulses: readonly { readonly head: number; readonly tail: number }[];
  readonly alpha: number;
  /** A link whose width is keyed (widthTo): the width it has at this frame. Left out: the width of its node. */
  readonly width?: number;
  /** A link whose colour is keyed (colorTo): the colour it has at this frame (#RRGGBB). Left out: the colour of its node. */
  readonly color?: string;
}

export interface StrokeItem {
  readonly kind: 'stroke';
  readonly node: CNode;
  readonly xf: Xf;
  readonly alpha: number;
  /** The share of the line that is drawn, 0..1 from its first point. */
  readonly drawn: number;
  /** How far the gaps of its dashes are closed: 0 as authored, 1 a solid line. */
  readonly solid: number;
  /**
   * The lights that run along it at this frame: head and tail of each as
   * distances along the line from its first point, and the length of the
   * light, in units of the stroke. Left out while none runs.
   */
  readonly pulses?: readonly { readonly head: number; readonly tail: number; readonly length: number }[];
  /** A stroke whose line is keyed (reshape): the path it has at this frame. Left out: the path of its node. */
  readonly path?: PathSpec;
  /** A stroke whose width is keyed (widthTo) or held on screen (least): the width it has at this frame, in its own units. Left out: the width of its node. */
  readonly width?: number;
  /** A stroke whose colour is keyed (colorTo): the colour it has at this frame (#RRGGBB). Left out: the colour of its node. */
  readonly color?: string;
  /** A wall that stands up at this frame (a rise above 0): `xf` is its top, and this is where its foot stands. Left out: it lies flat. */
  readonly foot?: Foot;
  /**
   * A wall among children that are drawn far to near: this item is one stretch of it, from one length along the line
   * to another, in the units of the stroke. Left out: the whole line.
   */
  readonly part?: readonly [number, number];
  /**
   * A line on a globe: the parts of it that face the viewer, as far as it is drawn, each a polyline (x, y in turn) in
   * the globe's own space. Left out: any other stroke.
   */
  readonly runs?: readonly Float64Array[];
}

/** The shadow of one body on the ground. */
export interface CastShadow {
  /** Closed outlines, x and y in turn, in the space the group is drawn in; together they are the shadow. All run one way round. */
  readonly outlines: readonly ArrayLike<number>[];
  /** A wall: its shadow is these outlines and a line of this width round each of them. 0 for any other body. */
  readonly width: number;
  /** How much of the body is there, 0..1: a body that fades takes its shadow with it. */
  readonly alpha: number;
}

/**
 * The shadows the bodies of a group cast on the ground under it (cast), in
 * one colour. It comes inside a GroupItem of the group, which makes one
 * picture of them and gives that picture its opacity and its blur.
 */
export interface CastItem {
  readonly kind: 'cast';
  readonly node: CNode;
  /** How much of the picture is there, 0..1: as much as the body that is there most. Each shadow has its own share in `shadows`. */
  readonly alpha: number;
  readonly shadows: readonly CastShadow[];
}

export interface TextItem {
  readonly kind: 'text';
  readonly node: CNode;
  readonly xf: Xf;
  readonly alpha: number;
  readonly block: TextBlock;
  readonly layout: TextLayout;
  /**
   * What is drawn at this frame: pieces of text, each with the x of its middle and the y of its baseline, and on a
   * line with a run of the second ink its spans. For a counter: the line with its number as it is now.
   */
  readonly lines: readonly { readonly text: string; readonly x: number; readonly y: number; readonly runs?: readonly RunSpan[] }[];
  /** A counter: the number it shows at this frame, as it is written. */
  readonly number?: string;
  /** How far its pops and its lasting size have grown it: 1 at its authored size. */
  readonly grown: number;
}

export interface LabelItem {
  readonly kind: 'label';
  readonly node: CNode;
  /** Tip of the pointer tail. */
  readonly tip: Vec2;
  readonly scale: number;
  readonly geometry: LabelGeometry;
  readonly layout: TextLayout;
  readonly alpha: number;
  /**
   * A counter: what is drawn at this frame, relative to the tip, as the lines of its geometry are, with the line of
   * its number set for the number it shows now. Left out: the lines of the geometry.
   */
  readonly lines?: readonly { readonly text: string; readonly x: number; readonly y: number }[];
  /** A counter: the number it shows at this frame, as it is written. */
  readonly number?: string;
}

export interface ParticlesItem {
  readonly kind: 'particles';
  readonly node: CNode;
  /** x, y, radius, colour index per particle. */
  readonly data: Float32Array;
  /** An emitter of streaks: dx, dy per particle, in the order of `data`, from the particle to the end of its streak. Left out: round particles. */
  readonly tails?: Float32Array;
}

/**
 * A heat haze at its frame: the picture drawn before it, inside `outline`,
 * is moved by a field of ripples, as far as `amount` at most. It is not one of
 * the items of its layer; the layer lists it in `hazes`, with the place in the
 * draw order it takes.
 */
export interface HazeItem {
  readonly kind: 'haze';
  readonly node: CNode;
  /** The outline of its shape at this frame, in the layer's space. */
  readonly outline: readonly Vec2[];
  /** How far its edge fades to each side of the outline, in the units of the layer; 0: over a few pixels. */
  readonly soft: number;
  /** How far it moves the picture at most at this frame, in the units of the layer (up and down half as far). */
  readonly amount: number;
  /** The size of its ripples, their speed (units per second) and where they drift (degrees). */
  readonly scale: number;
  readonly speed: number;
  readonly direction: number;
  /** Seconds from the start of the shot: where the ripples have drifted to. */
  readonly time: number;
  /** How many of the items of the layer are drawn before it: it moves those, and what the layers behind have drawn. */
  readonly before: number;
}

/**
 * A node that is not fully opaque, together with everything inside it. The
 * renderer draws the items into one picture and composites that picture at
 * `opacity`, so overlapping parts do not show through each other. Groups nest:
 * opacity multiplies down the tree.
 */
export interface GroupItem {
  /** A render-only placeholder for a captured image at this place in the item list. */
  readonly sampled?: true;
  readonly retained?: true;
  readonly kind: 'group';
  readonly node: CNode;
  readonly opacity: number;
  readonly items: readonly Item[];
  /** A soft node: how far that one picture is blurred, in the units of the layer. Left out: it is sharp. */
  readonly soft?: number;
}

/**
 * Nodes that are drawn only inside the outline of a shape, together with
 * everything inside them. `node` is that shape and `xf` its place at this
 * frame; the shape itself is not drawn by this item.
 */
export interface ClipItem {
  readonly kind: 'clip';
  readonly node: CNode;
  readonly xf: Xf;
  /** When the shape is a content with a level that is not full: the polygon below its surface. The items are drawn inside both. */
  readonly level?: readonly Vec2[];
  /** When the outline of the shape is keyed (reshape): the shape it has at this frame. */
  readonly shape?: ShapeSpec;
  /** When the shape is soft: how far the edge of the clip is blurred, in the units of the layer, so the items fade out across it. Left out: a sharp edge. */
  readonly soft?: number;
  readonly items: readonly Item[];
}

/**
 * A node that is being squashed or stretched, together with everything inside
 * it: the picture is `height` times as high and 1 / `height` times as wide,
 * about the point `at` of the layer.
 *
 * With `axes` it is a node whose width and height were changed for good
 * (scaleTo with to: [sx, sy]): `at` is its origin in the layer, and a point p
 * of the node, in its own units, is drawn where (sx * p.x + cx, sy * p.y + cy)
 * would be; `rot` and `scale` are the node's own.
 */
export interface StretchItem {
  readonly kind: 'stretch';
  readonly node: CNode;
  readonly at: Vec2;
  readonly height: number;
  readonly axes?: { readonly rot: number; readonly scale: number; readonly sx: number; readonly sy: number; readonly cx: number; readonly cy: number };
  readonly items: readonly Item[];
}

/**
 * A group that lies in a plane of a perspective layer, together with
 * everything inside it: the items are placed in the plane, and the renderer
 * draws them through `map`, the picture the camera of the layer has of that
 * plane at this frame.
 */
export interface PlaneItem {
  readonly kind: 'plane';
  readonly node: CNode;
  readonly map: PlaneMap;
  readonly items: readonly Item[];
  /** A plane with fog: how far its origin is from the camera, along its line of sight. */
  readonly far?: number;
}

/** The shape an item is drawn with, or clips to, at its frame. */
export function itemShape(item: { readonly node: CNode; readonly shape?: ShapeSpec }): ShapeSpec {
  if (item.shape) return item.shape;
  if (item.node.node.type !== 'shape') throw new Error(`"${item.node.id}" is not a shape`);
  return item.node.node.shape;
}

/** The path a stroke is drawn along at its frame. */
export function itemPath(item: StrokeItem): PathSpec {
  if (item.path) return item.path;
  if (item.node.node.type !== 'stroke') throw new Error(`"${item.node.id}" is not a stroke`);
  return item.node.node.path;
}

/** The fill a shape is drawn with at its frame (#RRGGBB). */
export function itemFill(item: ShapeItem): string {
  return item.fill ?? item.node.colors['fill']!;
}

/** The colour a link or a stroke is drawn with at its frame (#RRGGBB). */
export function itemColor(item: LinkItem | StrokeItem): string {
  return item.color ?? item.node.colors['color']!;
}

/** The width a link or a stroke is drawn with at its frame, in its own units. */
export function itemWidth(item: LinkItem | StrokeItem): number {
  if (item.width !== undefined) return item.width;
  const node = item.node.node;
  if (node.type !== 'link' && node.type !== 'stroke') throw new Error(`"${item.node.id}" is not a line`);
  return node.width;
}

export type Item = ShapeItem | EyeItem | LinkItem | LabelItem | ParticlesItem | StrokeItem | TextItem | CastItem | GroupItem | ClipItem | StretchItem | PlaneItem;
/**
 * What a list comes to when its groups are opened. Every leaf carries its
 * node, and every leaf but particles how much of it is there (alpha): what
 * reads a list relies on both, so a new kind of leaf carries them too.
 */
export type LeafItem = Exclude<Item, GroupItem | ClipItem | StretchItem | PlaneItem>;

/**
 * An item that lies in a plane as the layer sees it: its place exactly, its
 * size and its turn as they are at that place. For what measures the layer;
 * the renderer draws the item itself, through the map.
 */
export function seenThrough(item: LeafItem, map: PlaneMap): LeafItem {
  if (item.kind !== 'shape' && item.kind !== 'eye' && item.kind !== 'stroke' && item.kind !== 'text') return item;
  const xf = throughPlane(map, item.xf);
  if (item.kind === 'shape' && item.level) return { ...item, xf, level: item.level.map((p) => planePoint(map, p)) };
  return { ...item, xf };
}

/**
 * All items of a list with the groups, clips, stretches and planes opened up,
 * in draw order. What lies in a plane comes as the layer sees it (seenThrough).
 */
export function flatItems(items: readonly Item[], out: LeafItem[] = []): LeafItem[] {
  for (const item of items) {
    if (item.kind === 'group' || item.kind === 'clip' || item.kind === 'stretch') flatItems(item.items, out);
    else if (item.kind === 'plane') for (const leaf of flatItems(item.items)) out.push(seenThrough(leaf, item.map));
    else out.push(item);
  }
  return out;
}

export interface LayerState {
  readonly layer: CLayer;
  readonly view: LayerView;
  readonly items: readonly Item[];
  /** The heat hazes of the layer at this frame, in draw order. Left out in a layer without one. */
  readonly hazes?: readonly HazeItem[];
  /** The blur radius at this frame, in units, in a layer whose focus is pulled (blurTo). Left out: the layer's `blur`. */
  readonly blur?: number;
}

export interface FrameState {
  readonly frame: number;
  readonly time: number;
  readonly lang: string;
  readonly camera: CameraState;
  readonly layers: readonly LayerState[];
  /** The background at this frame, in a shot whose background is keyed (backgroundTo). Left out: it is what the shot says. */
  readonly background?: BackgroundState;
}

const labelCache = new WeakMap<CompiledShot, Map<string, { layout: TextLayout; geometry: LabelGeometry; slot?: CountSlot }>>();

/**
 * Layout and geometry of a label in a language (cached; the result depends on nothing else). A counter is laid out
 * with the widest number it ever shows, so its box holds every value; `slot` says where its number is.
 */
export function labelLayout(c: CompiledShot, n: CNode, lang: string): { layout: TextLayout; geometry: LabelGeometry; slot?: CountSlot } {
  if (n.node.type !== 'label') throw new Error(`"${n.id}" is not a label`);
  let cache = labelCache.get(c);
  if (!cache) {
    cache = new Map();
    labelCache.set(c, cache);
  }
  const key = `${lang}\u0000${n.id}`;
  let hit = cache.get(key);
  if (!hit) {
    const node = n.node;
    let words = resolveString(c.spec.strings, lang, node.text);
    // With a second ink the marks of the runs are taken out first: the label is laid out as the text without them.
    const marked = node.runInk ? parseRuns(words) : null;
    // A counter (it has no runs): every value it starts from or is sent to; what lies between them is never wider.
    const widest = node.count && n.count ? widestCount([n.count.base, ...n.count.segs.map((s) => s.to)], node.count.decimals, lang, node.size, LABEL_PROPORTIONS.weight, node.count.grouping !== false) : null;
    if (widest !== null) words = words.replace(COUNT_MARK, widest);
    const layout = layoutText(marked ? marked.text : words, {
      size: node.size,
      minSize: node.minSize,
      weight: LABEL_PROPORTIONS.weight,
      maxWidth: node.maxWidth,
      maxLines: node.maxLines,
    });
    const geometry = labelGeometry(layout, node.side);
    hit = { layout, geometry: marked ? { ...geometry, lines: withRuns(geometry.lines, runSpans(layout, marked)) } : geometry };
    if (widest !== null) hit.slot = countSlot(layout, widest);
    cache.set(key, hit);
  }
  return hit;
}

const textCache = new WeakMap<CompiledShot, Map<string, { layout: TextLayout; block: TextBlock; slot: CountSlot | null }>>();

/**
 * Layout and block of a free-standing text in a language (cached; the result
 * depends on nothing else). A counter is laid out with the widest number it
 * ever shows, so the layout holds every value; `slot` says where its number is.
 */
export function textLayout(c: CompiledShot, n: CNode, lang: string): { layout: TextLayout; block: TextBlock; slot: CountSlot | null } {
  if (n.node.type !== 'text') throw new Error(`"${n.id}" is not a text`);
  let cache = textCache.get(c);
  if (!cache) {
    cache = new Map();
    textCache.set(c, cache);
  }
  const key = `${lang}\u0000${n.id}`;
  let hit = cache.get(key);
  if (!hit) {
    const node = n.node;
    const style = { size: node.size, minSize: node.minSize, weight: node.weight, maxWidth: node.maxWidth, maxLines: node.maxLines };
    let words = resolveString(c.spec.strings, lang, node.text);
    // With a second ink the marks of the runs are taken out first (a counter has none): it is laid out as the text without them.
    const marked = node.runInk ? parseRuns(words) : null;
    if (marked) words = marked.text;
    let widest: string | null = null;
    if (node.count && n.count) {
      // Every value the counter starts from or is sent to; what lies between them is never wider.
      widest = widestCount([n.count.base, ...n.count.segs.map((s) => s.to)], node.count.decimals, lang, node.size, node.weight, node.count.grouping !== false);
      words = words.replace(COUNT_MARK, widest);
    }
    const layout = layoutText(words, style);
    const block = textBlock(layout, node.align, node.box !== null);
    hit = { layout, block: marked ? { ...block, lines: withRuns(block.lines, runSpans(layout, marked)) } : block, slot: widest === null ? null : countSlot(layout, widest) };
    cache.set(key, hit);
  }
  return hit;
}

/** The lines of a layout with the spans of their runs; a line without a run is left as it is. */
function withRuns<L extends { readonly text: string }>(lines: readonly L[], spans: readonly (readonly RunSpan[])[]): L[] {
  return lines.map((line, i) => (spans[i]!.length > 0 ? { ...line, runs: spans[i]! } : line));
}

/** Scale below which a node is treated as hidden. */
export const HIDDEN = 1e-3;
/** Lid opening below which an eye is shut and not drawn. */
export const SHUT = 0.02;
/** Opacity below which a node is not drawn, and above which it is drawn without a group. */
export const FAINT = 0.002;
const OPAQUE = 0.998;

/** Drops groups that ended up with nothing to draw. */
function prune(items: readonly Item[]): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    if (item.kind !== 'group' && item.kind !== 'clip' && item.kind !== 'stretch' && item.kind !== 'plane') out.push(item);
    else {
      const inner = prune(item.items);
      if (inner.length > 0 || (item.kind === 'group' && (item.sampled || item.retained))) out.push({ ...item, items: inner });
    }
  }
  return out;
}

/**
 * The items of a layer without what holds nothing, and its hazes, each with the number of those items drawn before
 * it. `marks` are the hazes in draw order, each with the number of the unpruned items before it.
 */
function pruneWithHazes(root: readonly Item[], marks: readonly { readonly at: number; readonly haze: Omit<HazeItem, 'before'> }[]): { items: Item[]; hazes: HazeItem[] } {
  const items: Item[] = [];
  const hazes: HazeItem[] = [];
  let m = 0;
  root.forEach((item, i) => {
    for (; m < marks.length && marks[m]!.at <= i; m++) hazes.push({ ...marks[m]!.haze, before: items.length });
    items.push(...prune([item]));
  });
  for (; m < marks.length; m++) hazes.push({ ...marks[m]!.haze, before: items.length });
  return { items, hazes };
}

/** Where a point of the layer is drawn through a squash or a stretch, or through a change of size along a node's own axes. */
export function stretchPoint(s: Pick<StretchItem, 'at' | 'height' | 'axes'>, p: Vec2): Vec2 {
  const x = p[0] - s.at[0];
  const y = p[1] - s.at[1];
  if (!s.axes) return [s.at[0] + x / s.height, s.at[1] + y * s.height];
  // Along the node's own axes: out of the layer into the node, the change, and back.
  const a = s.axes;
  const cos = Math.cos(a.rot);
  const sin = Math.sin(a.rot);
  const u = (x * cos + y * sin) * a.sx + a.cx * a.scale;
  const v = (-x * sin + y * cos) * a.sy + a.cy * a.scale;
  return [s.at[0] + u * cos - v * sin, s.at[1] + u * sin + v * cos];
}

/** The heat haze of a shape at time t, or null while it moves nothing: it is too small, or its amount is 0. */
function hazeAt(n: CNode, xf: Xf, t: number): Omit<HazeItem, 'before'> | null {
  const node = n.node;
  if (node.type !== 'shape' || !node.haze || !n.haze || xf.scale <= HIDDEN) return null;
  const amount = Math.max(0, sampleLevel(n.haze.amount, t));
  if (amount <= 1e-4) return null;
  // Its outline as the shape is drawn: through its place, then through a squash, then through a change along its axes.
  let outline = transformOutline(shapeOf(n, t), (p) => xfApply(xf, p));
  const squash = n.stretch ? sampleStretch(n.stretch, t) : null;
  if (squash) {
    const s = { at: [xf.x + squash.pivot[0] * xf.scale, xf.y + squash.pivot[1] * xf.scale] as Vec2, height: squash.height };
    outline = outline.map((p) => stretchPoint(s, p));
  }
  const axis = n.axis ? sampleAxis(n.axis, t) : null;
  if (axis) {
    const s = { at: [xf.x, xf.y] as Vec2, height: 1, axes: { rot: xf.rot, scale: xf.scale, ...axis } };
    outline = outline.map((p) => stretchPoint(s, p));
  }
  const h = node.haze;
  return { kind: 'haze', node: n, outline, soft: (node.soft ?? 0) * xf.scale, amount, scale: h.scale, speed: h.speed, direction: h.direction, time: t };
}

/** True while a rigid body that appears at its release still waits for it. */
export function awaitsRelease(n: CNode, t: number): boolean {
  const node = n.node;
  return node.type === 'shape' && node.body !== null && node.body.kind === 'dynamic' && node.body.appear === 'release' && t < node.body.release - 1e-9;
}

/** How far a blink leaves an eye open at time t: 1 between blinks. */
export function eyeOpen(blinks: readonly number[], t: number): number {
  for (const b of blinks) {
    if (b > t) break;
    const tau = t - b;
    if (tau < BLINK.seconds) return Math.max(0.06, 1 - Math.sin((Math.PI * tau) / BLINK.seconds));
  }
  return 1;
}

/**
 * Opacity of every node at time t: its own (`own`), and the product down the
 * tree (`alpha`). A link also takes the fainter of the two nodes it joins.
 */
export function opacities(c: CompiledShot, t: number): { own: Float64Array; alpha: Float64Array } {
  const own = new Float64Array(c.nodes.length).fill(1);
  const alpha = new Float64Array(c.nodes.length).fill(1);
  for (const n of c.activeNodes ?? c.nodes) {
    own[n.index] = n.opacity ? sampleOpacity(n.opacity, t) : 1;
    // Not drawn at all: a node that shows only while it travels, outside its travel; a body that waits for its release.
    if ((n.pos !== null && n.pos.onlyWhile && !sampleTravelling(n.pos, t)) || (n.bodySlot >= 0 && awaitsRelease(n, t))) own[n.index] = 0;
    // A thing placed on a globe hides behind its disc.
    if (n.globe && n.pos && n.node.type !== 'stroke') {
      const [lon, lat] = samplePos(n.pos, t);
      const height = (n.node as { z?: number }).z ?? 0;
      own[n.index] = own[n.index]! * globeFade(globePlace(n.globe.spec, n.globe.r, lon, lat, height, 0, t).z, height, n.globe.r);
    }
    alpha[n.index] = own[n.index]! * (n.parent >= 0 ? alpha[n.parent]! : 1);
  }
  for (const n of c.activeNodes ?? c.nodes) {
    if (n.node.type !== 'link') continue;
    own[n.index] = own[n.index]! * Math.min(alpha[n.fromIndex]!, alpha[n.toIndex]!);
    alpha[n.index] = own[n.index]!;
  }
  return { own, alpha };
}

/**
 * The place of a node in the draw order of a layer that orders what it draws:
 * in a perspective layer its distance from the camera, plus its depth. The
 * larger, the earlier it is drawn.
 */
export function orderKey(c: CompiledShot, layer: CLayer, index: number, t: number, places: Places | undefined): number {
  const n = c.nodes[index]!;
  const given = (n.node as { depth?: number }).depth ?? 0;
  return (layer.persp && places ? places.far[index]! : 0) + (n.depth ? sampleDriven(n.depth, t, given) : given);
}

/**
 * The nodes of a layer that orders what it draws, in the order they are drawn
 * at time t: the nodes listed in the layer farthest first, each with
 * everything inside it. A link is as far as the middle between the two nodes
 * it joins. A label and an emitter have no place in the space: in a
 * perspective layer they are drawn last, over everything else; in a flat
 * layer they keep their place in the list, among the nodes without a depth.
 * What is equally far keeps the order it was listed in.
 */
export function drawOrder(c: CompiledShot, layer: CLayer, t: number, places: Places | undefined): number[] {
  const listed = (index: number): number => {
    let i = index;
    while (c.nodes[i]!.parent >= 0) i = c.nodes[i]!.parent;
    return i;
  };
  const units: { index: number; key: number; at: number }[] = [];
  for (const index of layer.nodes) {
    const n = c.nodes[index]!;
    if (n.parent >= 0) continue;
    let key: number;
    if (n.node.type === 'link') key = (orderKey(c, layer, listed(n.fromIndex), t, places) + orderKey(c, layer, listed(n.toIndex), t, places)) / 2;
    else if (n.node.type === 'label' || n.node.type === 'emitter') key = layer.persp ? -Infinity : 0;
    else key = orderKey(c, layer, index, t, places);
    units.push({ index, key, at: units.length });
  }
  units.sort((p, q) => (p.key === q.key ? p.at - q.at : q.key - p.key));
  const out: number[] = [];
  for (const u of units) for (let i = u.index; i <= c.nodes[u.index]!.subtreeEnd; i++) out.push(i);
  return out;
}

/** A wall among children that are drawn far to near is taken in no more stretches than this. */
const WALL_STRETCHES = 200;

/**
 * Moves the cuts between the stretches of a wall with openings (lengths along its line, the first and the last its
 * ends) that lie nearer an opening than `clear` from its middle (half the opening and half the wall: the end of a
 * stretch is drawn that far round) to the middle of the plain wall between two openings, so that each opening is
 * drawn whole by one stretch and no other covers it; two cuts that come together are one.
 */
function clearOpenings(cuts: number[], middles: readonly number[], clear: number): void {
  const end = cuts[cuts.length - 1]!;
  for (let j = 1; j + 1 < cuts.length; j++) {
    const cut = cuts[j]!;
    // The first opening whose clear room ends past the cut.
    let k = 0;
    while (k < middles.length && middles[k]! + clear <= cut) k++;
    if (k === middles.length || middles[k]! - clear >= cut) continue;
    const before = k > 0 ? (middles[k - 1]! + middles[k]!) / 2 : middles[k]! - clear;
    const after = k + 1 < middles.length ? (middles[k]! + middles[k + 1]!) / 2 : middles[k]! + clear;
    cuts[j] = cut - before <= after - cut ? before : after;
  }
  // In order, inside the line, and none twice.
  let w = 1;
  for (let j = 1; j < cuts.length; j++) {
    const cut = j + 1 === cuts.length ? end : Math.min(end, cuts[j]!);
    if (cut > cuts[w - 1]! + 1e-9) cuts[w++] = cut;
    else if (j + 1 === cuts.length) cuts[w - 1] = end;
  }
  cuts.length = w;
}

/** The width a stroke is drawn with at a frame, in its own units: the one it was given, what a widthTo has made of it, or what holds it on screen (least). */
function strokeWidthAt(n: CNode, t: number, seen: number): number {
  const node = n.node as StrokeNode;
  if (node.least !== undefined) return Math.max(node.width, node.least / Math.max(seen, 1e-9));
  return n.width ? sampleWidth(n.width, t) : node.width;
}

/**
 * The steps in which a layer with children drawn far to near (sort: 'depth')
 * is drawn at a frame: the nodes of `base`, with the children of every such
 * group far to near, each with everything inside it. A stroke with a rise
 * among them comes as several steps, one to each stretch of it (`parts`), each
 * in its own place among the others.
 *
 * How far a child is: where it stands on the ground (the foot of a body, the
 * place of anything else), in a plane of a perspective layer by its distance
 * from the point the camera stands over, in a flat layer by how high up the
 * screen it is. What is equally far keeps the order it was listed in; a link,
 * a label and an emitter have no place and are drawn last.
 *
 * A group whose shadows lie over its flat members (cast over: 'flat') draws
 * the children with no rise in them first, as listed, and then the others, far
 * to near when it sorts them; `casts` gives, by step, the group whose shadows
 * are drawn before that step: the first of its raised children.
 */
function sortedSteps(
  c: CompiledShot,
  base: readonly number[],
  t: number,
  zoom: number,
  world: readonly Xf[],
  places: Places | undefined,
  feet: Map<number, Foot> | undefined,
): { order: number[]; parts: (readonly [number, number] | null)[]; casts: Map<number, number> } {
  const order: number[] = [];
  const parts: (readonly [number, number] | null)[] = [];
  const casts = new Map<number, number>();
  // A child with a rise in it: a body, or something that holds one.
  const raised = (index: number): boolean => {
    for (let i = index; i <= c.nodes[index]!.subtreeEnd; i++) if (c.nodes[i]!.rise) return true;
    return false;
  };
  const emit = (index: number): void => {
    const retained = c.retainedMask?.[index];
    if (retained) {
      if (retained === 1) {
        order.push(index);
        parts.push(null);
      }
      return;
    }
    const n = c.nodes[index]!;
    order.push(index);
    parts.push(null);
    const flatFirst = n.node.type === 'group' && n.node.cast?.over === 'flat';
    // The children of a group whose shadows lie over its flat members: those first, as listed; the raised ones after the shadows.
    const children: number[] = [];
    for (let i = index + 1; i <= n.subtreeEnd; i = c.nodes[i]!.subtreeEnd + 1) {
      if (flatFirst && raised(i)) children.push(i);
      else if (flatFirst) emit(i);
      else children.push(i);
    }
    if (flatFirst && children.length > 0) casts.set(order.length, index);
    if (!(n.node.type === 'group' && n.node.sort === 'depth')) {
      for (const i of children) emit(i);
      return;
    }
    const stand = n.plane >= 0 ? places?.stands.get(n.plane) : undefined;
    // The larger, the farther: drawn first.
    const far = (xf: Xf, x: number, y: number): number => {
      const p = xfApply(xf, [x, y]);
      return stand ? (p[0] - stand[0]) ** 2 + (p[1] - stand[1]) ** 2 : -p[1];
    };
    const units: { index: number; key: number; at: number; part: readonly [number, number] | null }[] = [];
    for (const i of children) {
      const child = c.nodes[i]!;
      const type = child.node.type;
      if (type === 'link' || type === 'label' || type === 'emitter') {
        units.push({ index: i, key: -Infinity, at: units.length, part: null });
        continue;
      }
      const xf = places?.flat[i] ?? world[i]!;
      const foot = feet?.get(i);
      if (type === 'stroke' && child.rise) {
        // A wall: stretch by stretch, each as far as the ground under its middle.
        const table = pathTable(strokePathOf(child, t));
        const upTo = table.length * Math.min(1, Math.max(0, sampleDrawn(child.stroke!, t)));
        if (upTo > 1e-9) {
          const width = strokeWidthAt(child, t, world[i]!.scale * zoom);
          const count = Math.max(1, Math.ceil(upTo / Math.max(2 * width, upTo / WALL_STRETCHES)));
          const cuts = Array.from({ length: count + 1 }, (_, j) => (upTo * j) / count);
          const openings = (child.node as StrokeNode).openings;
          if (openings) clearOpenings(cuts, wallOpenings(table, openings), openings.width / 2 + width / 2);
          for (let j = 0; j + 1 < cuts.length; j++) {
            const from = cuts[j]!;
            const to = cuts[j + 1]!;
            const mid = pathAt(table, (from + to) / 2);
            units.push({ index: i, key: foot ? far(xf, foot.k * mid.x + foot.x, foot.k * mid.y + foot.y) : far(xf, mid.x, mid.y), at: units.length, part: [from, to] });
          }
          continue;
        }
      }
      units.push({ index: i, key: foot ? far(xf, foot.x, foot.y) : far(xf, 0, 0), at: units.length, part: null });
    }
    units.sort((p, q) => (p.key === q.key ? p.at - q.at : q.key - p.key));
    for (const u of units) {
      if (u.part) {
        order.push(u.index);
        parts.push(u.part);
      } else emit(u.index);
    }
  };
  // `base` lists every node with everything inside it straight after it.
  for (let i = 0; i < base.length; i += c.nodes[base[i]!]!.subtreeEnd - base[i]! + 1) emit(base[i]!);
  return { order, parts, casts };
}

/** What a body of a group that says what detail its bodies are worth (detail) is drawn with at a frame. */
export interface Worth {
  readonly facet?: Foot;
  /** The size of one unit of the body on screen, in units of the stage. */
  readonly unit: number;
  /** True while the body is smaller on screen than the least size of that group, across and in height: its top alone is drawn. */
  readonly plain: boolean;
}

/**
 * How a body of a group that says what detail its bodies are worth is drawn at a frame; null for a node that is no
 * body at this frame, or stands in no such group. `unit` is the size of one of its units on screen.
 */
function worthOf(c: CompiledShot, n: CNode, t: number, foot: Foot | undefined, unit: number): Worth | null {
  const min = c.detail ? c.detail[n.index]! : -1;
  if (min < 0 || !foot) return null;
  const node = n.node;
  if (node.type !== 'shape' && node.type !== 'stroke') return null;
  // A wall is as large as it is high; any other body as its outline is across, or as it is high.
  const across = node.type === 'shape' ? spanOf(n.outline || n.form ? shapeOf(n, t) : node.shape) : 0;
  const plain = Math.max(across, foot.h) * unit < min;
  return { unit, plain, ...(plain && c.facetRoofs?.[n.index] ? { facet: foot } : {}) };
}

/** Below this height, in its units, a body casts no shadow worth drawing. */
const CAST_FLAT = 1e-3;

interface RoofSamples {
  readonly points: Float64Array;
  readonly order: Uint32Array;
}

const samplesByRoof = new WeakMap<readonly RoofFace[], RoofSamples>();

/** Shared vertices of a roof only need one terrain ray each. Its original point order is kept for the hull. */
function roofSamples(faces: readonly RoofFace[]): RoofSamples {
  const saved = samplesByRoof.get(faces);
  if (saved) return saved;
  const points: number[] = [];
  const order: number[] = [];
  const vertex = new Map<string, number>();
  const exact = (v: number): number | string => Object.is(v, -0) ? '-0' : v;
  for (const face of faces) {
    for (let s = 0; s < face.points.length; s += 3) {
      const z = face.points[s + 2]!;
      if (z <= 0) continue;
      const x = face.points[s]!;
      const y = face.points[s + 1]!;
      const key = `${exact(x)},${exact(y)},${exact(z)}`;
      let index = vertex.get(key);
      if (index === undefined) {
        index = points.length / 3;
        vertex.set(key, index);
        points.push(x, y, z);
      }
      order.push(index);
    }
  }
  const made = { points: Float64Array.from(points), order: Uint32Array.from(order) };
  samplesByRoof.set(faces, made);
  return made;
}

interface SavedShadow {
  readonly key: readonly number[];
  readonly outlines: CastShadow['outlines'];
  readonly bytes: number;
}

interface GroundShadowCache {
  readonly field: WeakRef<GroundField>;
  readonly stand: Vec3;
  readonly bodies: Map<number, SavedShadow>;
  bytes: number;
}

// Render workers draw one shot. Keep a bounded cache for the most recent shot in tools that draw more than one.
const SHADOW_CACHE_LIMIT = 24 * 1024 * 1024;
let shadowShot: WeakRef<CompiledShot> | undefined;
let shadowGroups = new WeakMap<CNode, GroundShadowCache>();
let shadowBytes = 0;

/** Only keep projected outlines while the ground and the position of the eye over it stay exactly the same. */
function groundShadowCache(c: CompiledShot, group: CNode, field: GroundField, stand: Vec3): GroundShadowCache | undefined {
  if (shadowShot?.deref() !== c) {
    shadowShot = new WeakRef(c);
    shadowGroups = new WeakMap();
    shadowBytes = 0;
  }
  const saved = shadowGroups.get(group);
  if (saved?.field.deref() === field && stand.every((v, i) => Object.is(v, saved.stand[i]))) return saved;
  if (saved) shadowBytes -= saved.bytes;
  shadowGroups.set(group, { field: new WeakRef(field), stand, bodies: new Map(), bytes: 0 });
  return undefined;
}

function rememberShadow(cache: GroundShadowCache, index: number, key: readonly number[], outlines: CastShadow['outlines']): void {
  const old = cache.bodies.get(index);
  if (old) {
    cache.bodies.delete(index);
    cache.bytes -= old.bytes;
    shadowBytes -= old.bytes;
  }
  const bytes = 256 + outlines.reduce((total, o) => total + o.length * 8, 0);
  if (shadowBytes + bytes > SHADOW_CACHE_LIMIT) return;
  cache.bodies.set(index, { key, outlines, bytes });
  cache.bytes += bytes;
  shadowBytes += bytes;
}

/**
 * The shadows the bodies inside a group cast on the ground under it at a
 * frame, in the space the group is drawn in (its plane, or its layer). A
 * shadow is what the body passes over when it is pushed along the ground in
 * the direction of the shadows, as far as each of its points is high: `fall`
 * is that direction, as long as the shadow of one unit of height.
 *
 * A body that stands on another casts from the height it stands at. A body
 * inside a group that casts its own shadows is left to that group.
 */
function castShadows(
  c: CompiledShot,
  group: CNode,
  t: number,
  zoom: number,
  fall: Vec2,
  world: readonly Xf[],
  places: Places | undefined,
  feet: Map<number, Foot>,
  alpha: Float64Array,
): CastShadow[] {
  const out: CastShadow[] = [];
  const stand = group.plane >= 0 ? places?.stands.get(group.plane) : undefined;
  // Seen from behind its plane a body is not drawn as it stands, and casts nothing.
  if (stand && !(stand[2] > 0)) return out;
  const whole = alpha[group.index]!;
  // With cast.ground, the ground of the plane, which the bodies listed after its first relief stand on.
  const field = stand && (group.node as GroupNode).cast?.ground ? places?.grounds.get(group.plane) : undefined;
  const after = field ? c.grounds!.get(group.plane)![0]! : 0;
  const cache = field && stand ? groundShadowCache(c, group, field, stand) : undefined;
  for (let i = group.index + 1; i <= group.subtreeEnd; i++) {
    const n = c.nodes[i]!;
    const node = n.node;
    if (node.type === 'group' && node.cast) {
      i = n.subtreeEnd;
      continue;
    }
    const foot = feet.get(i);
    if (!foot || alpha[i]! <= FAINT) continue;
    if (node.type !== 'shape' && node.type !== 'stroke') continue;
    const xf = places?.flat[i] ?? world[i]!;
    if (xf.scale <= HIDDEN) continue;
    const roof = node.type === 'shape' ? node.roof : undefined;
    if (foot.h <= CAST_FLAT && !roof) continue;
    // A body that is drawn plain has no shadow.
    if (c.detail && worthOf(c, n, t, foot, world[i]!.scale * zoom)?.plain) continue;
    // How high the body stands, and how high its top is: in a plane as shares of the camera's height over the plane, in a flat layer in units of the layer.
    let top = stand ? foot.k : foot.h * xf.scale;
    for (let p = n.parent; p > group.index; p = c.nodes[p]!.parent) {
      const f = feet.get(p);
      if (!f) continue;
      if (stand) top *= f.k;
      else top += f.h * (places?.flat[p] ?? world[p]!).scale;
    }
    const base = stand ? top / foot.k : top - foot.h * xf.scale;
    const cos = Math.cos(xf.rot) * xf.scale;
    const sin = Math.sin(xf.rot) * xf.scale;
    // On the ground (cast.ground): the height the body stands at, and the camera's height over it. Its shadow is worked
    // out at the true places of the plane, under the camera's height over its foot, and then laid on the ground.
    const ground = field && i > after ? field : undefined;
    // A raised line is drawn standing on the ground under its place seen from its top: its shadow goes by that ground.
    const laid = ground && node.type === 'stroke' ? seenFromTop(ground, stand!, 1 / foot.k) : ground;
    const z = ground ? places!.lifted[i]! : 0;
    const eye = ground ? stand![2] - z : stand ? stand[2] : 0;
    // From a point of the top to the place under it: the foot as drawn, or on the ground its true place.
    const reach = ground ? (top * eye) / stand![2] : top;
    // The place on the ground under a point of the top, and the shadow of a point `over` it (in the units of the body) or of its foot.
    let gx = 0;
    let gy = 0;
    const onGround = (x: number, y: number): void => {
      const px = xf.x + x * cos - y * sin;
      const py = xf.y + x * sin + y * cos;
      if (stand) {
        gx = stand[0] + (px - stand[0]) * reach;
        gy = stand[1] + (py - stand[1]) * reach;
      } else {
        gx = px;
        gy = py + top;
      }
    };
    // The length of the shadow of the top, of the foot, and of one more unit of the body over the top.
    const high = stand ? eye * (1 - top) : top;
    const low = stand ? eye * (1 - base) : base;
    const unit = stand ? xf.scale * reach : xf.scale;
    const opacity = whole > FAINT ? Math.min(1, alpha[i]! / whole) : 1;
    // Convex shapes with fixed outlines do not use screen scale to sample their rings. Other bodies keep the
    // frame's sampling, including a stroke's width and draw progress, or the detail of a region's outline.
    const memo = cache && ground && node.type === 'shape' && !n.outline && !n.form &&
      node.shape.kind !== 'blob' && !isRegion(node.shape) ? cache : undefined;
    const key = memo ? [xf.x, xf.y, cos, sin, reach, high, low, unit, z] : undefined;
    const saved = memo?.bodies.get(i);
    if (saved && key!.every((v, j) => Object.is(v, saved.key[j]))) {
      out.push({ outlines: saved.outlines, width: 0, alpha: opacity });
      continue;
    }
    // Where the shadow of a point `far` over the foot lands: that far along the fall, or on the ground where it meets it.
    let sx = 0;
    let sy = 0;
    const shift = (x: number, y: number, far: number): void => {
      const d = ground ? shadowDrop(ground, x, y, z, far, fall) : far;
      sx = x + fall[0] * d;
      sy = y + fall[1] * d;
    };
    const outlines: ArrayLike<number>[] = [];
    let width = 0;
    if (node.type === 'stroke') {
      const table = pathTable(strokePathOf(n, t));
      const upTo = table.length * Math.min(1, Math.max(0, sampleDrawn(n.stroke!, t)));
      if (upTo <= 1e-9) continue;
      // As wide as the line is drawn at its foot.
      width = strokeWidthAt(n, t, world[i]!.scale * zoom) * (stand ? xf.scale * top : unit);
      // The line as far as it is drawn, sample by sample.
      const line: number[] = [];
      const m = table.cum.length;
      for (let s = 0; s < m; s++) {
        if (table.cum[s]! <= upTo) {
          onGround(table.xs[s]!, table.ys[s]!);
          line.push(gx, gy);
          continue;
        }
        const span = table.cum[s]! - table.cum[s - 1]!;
        const u = span > 1e-12 ? (upTo - table.cum[s - 1]!) / span : 0;
        if (u > 1e-9) {
          onGround(table.xs[s - 1]! + (table.xs[s]! - table.xs[s - 1]!) * u, table.ys[s - 1]! + (table.ys[s]! - table.ys[s - 1]!) * u);
          line.push(gx, gy);
        }
        break;
      }
      if (laid) {
        // On the ground every sample of the line stands on the ground under it, and its shadow runs from there.
        const lows: number[] = [];
        const highs: number[] = [];
        for (let s = 0; s + 1 < line.length; s += 2) {
          const x = line[s]!;
          const y = line[s + 1]!;
          const under = Math.min(laid.at(x, y), RISE_NEAR * stand![2]);
          let d = shadowDrop(laid, x, y, under, low, fall);
          lows.push(x + fall[0] * d, y + fall[1] * d);
          d = shadowDrop(laid, x, y, under, high, fall);
          highs.push(x + fall[0] * d, y + fall[1] * d);
        }
        for (let s = 0; s + 3 < line.length; s += 2) quad(outlines, lows[s]!, lows[s + 1]!, lows[s + 2]!, lows[s + 3]!, highs[s + 2]!, highs[s + 3]!, highs[s]!, highs[s + 1]!);
      } else for (let s = 0; s + 3 < line.length; s += 2) sweep(outlines, line[s]!, line[s + 1]!, line[s + 2]!, line[s + 3]!, fall, low, high);
    } else {
      const shape = n.outline || n.form ? shapeOf(n, t) : node.shape;
      if (shape.kind === 'blob' || isRegion(shape)) {
        // An outline that may have bays, with the corners that can be told on screen: the outline itself at both
        // ends, and between them what each run of its stretches that lead the way passes over.
        const { points: pts, convex } = sideRing(shape, world[i]!.scale * zoom);
        const m = pts.length;
        const ring = new Float64Array(2 * m);
        let area = 0;
        for (let s = 0; s < m; s++) {
          onGround(pts[s]![0], pts[s]![1]);
          ring[2 * s] = gx;
          ring[2 * s + 1] = gy;
        }
        for (let s = 0; s < m; s++) {
          const e = s + 1 === m ? 0 : s + 1;
          area += ring[2 * s]! * ring[2 * e + 1]! - ring[2 * e]! * ring[2 * s + 1]!;
        }
        if (area < 0) {
          // The other way round, so that every outline of the shadow runs one way.
          for (let s = 0, e = m - 1; s < e; s++, e--) {
            const x = ring[2 * s]!;
            const y = ring[2 * s + 1]!;
            ring[2 * s] = ring[2 * e]!;
            ring[2 * s + 1] = ring[2 * e + 1]!;
            ring[2 * e] = x;
            ring[2 * e + 1] = y;
          }
        }
        // A hip on the outline: the shadow of each of its slopes, wound as the rest.
        const slopes: number[][] = [];
        if (roof) {
          for (const face of roofFaces(shape, roof)) {
            const q: number[] = [];
            let turn = 0;
            for (let s = 0; s < face.points.length; s += 3) {
              const far = high + face.points[s + 2]! * unit;
              onGround(face.points[s]!, face.points[s + 1]!);
              shift(gx, gy, far);
              q.push(sx, sy);
            }
            for (let s = 0; s < q.length; s += 2) {
              const e = (s + 2) % q.length;
              turn += q[s]! * q[e + 1]! - q[e]! * q[s + 1]!;
            }
            if (turn < 0) {
              const back: number[] = [];
              for (let s = q.length - 2; s >= 0; s -= 2) back.push(q[s]!, q[s + 1]!);
              slopes.push(back);
            } else slopes.push(q);
          }
        }
        if (convex) {
          const points: number[] = [];
          for (let s = 0; s < 2 * m; s += 2) {
            shift(ring[s]!, ring[s + 1]!, low);
            const lx = sx;
            const ly = sy;
            shift(ring[s]!, ring[s + 1]!, high);
            points.push(lx, ly, sx, sy);
          }
          for (const q of slopes) points.push(...q);
          outlines.push(hull(points));
        } else {
          outlines.push(...slopes);
          for (const far of [low, high]) {
            const end = new Float64Array(2 * m);
            for (let s = 0; s < 2 * m; s += 2) {
              shift(ring[s]!, ring[s + 1]!, far);
              end[s] = sx;
              end[s + 1] = sy;
            }
            outlines.push(end);
          }
          // A stretch leads the way when the shadows fall out of the outline across it.
          const leads = (s: number): boolean => {
            const e = s + 1 === m ? 0 : s + 1;
            return (ring[2 * e + 1]! - ring[2 * s + 1]!) * fall[0] - (ring[2 * e]! - ring[2 * s]!) * fall[1] > 0;
          };
          let start = 0;
          while (start < m && leads(start)) start++;
          for (let k = 1; start < m && k < m && high > low; ) {
            const first = (start + k) % m;
            if (!leads(first)) {
              k++;
              continue;
            }
            let len = 1;
            while (k + len < m && leads((start + k + len) % m)) len++;
            const strip = new Float64Array(4 * (len + 1));
            for (let j = 0; j <= len; j++) {
              const q = 2 * ((first + j) % m);
              shift(ring[q]!, ring[q + 1]!, high);
              strip[2 * j] = sx;
              strip[2 * j + 1] = sy;
              const back = 2 * (2 * len + 1 - j);
              shift(ring[q]!, ring[q + 1]!, low);
              strip[back] = sx;
              strip[back + 1] = sy;
            }
            outlines.push(strip);
            k += len;
          }
        }
      } else {
        // A convex body: the outline round the shadows of its corners, those of its roof among them.
        const points: number[] = [];
        for (const p of ringOf(shape).points) {
          onGround(p[0], p[1]);
          shift(gx, gy, low);
          const lx = sx;
          const ly = sy;
          shift(gx, gy, high);
          points.push(lx, ly, sx, sy);
        }
        if (roof) {
          const faces = roofFaces(shape, roof);
          if (ground) {
            const samples = roofSamples(faces);
            const projected: number[] = [];
            for (let s = 0; s < samples.points.length; s += 3) {
              onGround(samples.points[s]!, samples.points[s + 1]!);
              shift(gx, gy, high + samples.points[s + 2]! * unit);
              projected.push(sx, sy);
            }
            for (const s of samples.order) points.push(projected[2 * s]!, projected[2 * s + 1]!);
          } else {
            for (const face of faces) {
              for (let s = 0; s < face.points.length; s += 3) {
                const over = face.points[s + 2]!;
                if (over <= 0) continue;
                onGround(face.points[s]!, face.points[s + 1]!);
                shift(gx, gy, high + over * unit);
                points.push(sx, sy);
              }
            }
          }
        }
        outlines.push(hull(points));
      }
    }
    // On the ground the outlines, worked out at the true places of the plane, are laid on it.
    if (laid) for (let o = 0; o < outlines.length; o++) outlines[o] = drape(outlines[o]!, laid, stand!);
    if (outlines.length > 0) {
      if (memo && key) rememberShadow(memo, i, key, outlines);
      out.push({ outlines, width, alpha: opacity });
    }
  }
  return out;
}

/** Where the shadows of a cast fall, as long as the shadow of one unit of height: its dir, or away from the light of the shot. */
export function castFall(c: CompiledShot, cast: CastSpec): Vec2 {
  return cast.dir === undefined ? [-c.light[0] * cast.length, -c.light[1] * cast.length] : [Math.cos(cast.dir * DEG) * cast.length, Math.sin(cast.dir * DEG) * cast.length];
}

/**
 * How far the shadow of a point falls on the ground of a plane (cast.ground): the point stands `far` over the height
 * `from`, at the place (x, y) of the plane; its shadow moves `fall` along the plane for each unit it falls, and lands
 * where it meets the ground. On level ground at `from` that is `far`; where the ground rises toward the shadow, less;
 * where it falls away, more, at most SHADOW_REACH times `far`. A point under the ground lands where it is.
 */
export function shadowDrop(ground: GroundField, x: number, y: number, from: number, far: number, fall: Vec2): number {
  if (!(far > 0)) return 0;
  const along = Math.hypot(fall[0], fall[1]);
  if (!(along > 1e-9)) return far;
  const top = from + far;
  const gap = (d: number): number => top - d - ground.at(x + fall[0] * d, y + fall[1] * d);
  let a = 0;
  let ga = gap(0);
  if (ga <= 0) return 0;
  const most = SHADOW_REACH * far;
  // Steps of about a cell of the ground's grid along the plane, until the shadow is under the ground.
  const steps = Math.min(64, Math.max(1, Math.ceil((most * along) / ground.cell)));
  for (let k = 1; k <= steps; k++) {
    const b = k === steps ? most : (most * k) / steps;
    const gb = gap(b);
    if (gb > 0) {
      a = b;
      ga = gb;
      continue;
    }
    // Between the last two places: a few steps of false position, exact where the ground runs straight.
    let lo = a;
    let glo = ga;
    let hi = b;
    let ghi = gb;
    for (let r = 0; r < 4; r++) {
      const d = lo + ((hi - lo) * glo) / (glo - ghi);
      const g = gap(d);
      if (Math.abs(g) <= 1e-9 * (1 + Math.abs(top))) return d;
      if (g > 0) {
        lo = d;
        glo = g;
      } else {
        hi = d;
        ghi = g;
      }
    }
    return lo + ((hi - lo) * glo) / (glo - ghi);
  }
  return most;
}

/**
 * The ground of a plane as a raised line stands on it: a point of its foot at a place of the plane is drawn at the
 * height of the ground under the place its top is drawn over, `grow` times as far from the point the camera stands over.
 */
function seenFromTop(ground: GroundField, stand: Vec3, grow: number): GroundField {
  return { index: ground.index, low: ground.low, high: ground.high, cell: ground.cell, at: (x, y) => ground.at(stand[0] + (x - stand[0]) * grow, stand[1] + (y - stand[1]) * grow) };
}

/** An outline of a plane laid on its ground point by point, as a region is: a stretch longer than a cell of the ground's grid cut into pieces that each follow it. */
function drape(outline: ArrayLike<number>, ground: GroundField, stand: Vec3): Float64Array {
  const eye = stand[2];
  const out: number[] = [];
  const put = (x: number, y: number): void => {
    const grow = eye / (eye - Math.min(ground.at(x, y), RISE_NEAR * eye));
    out.push(stand[0] + (x - stand[0]) * grow, stand[1] + (y - stand[1]) * grow);
  };
  const m = outline.length >> 1;
  for (let s = 0; s < m; s++) {
    const ax = outline[2 * s]!;
    const ay = outline[2 * s + 1]!;
    const e = s + 1 === m ? 0 : s + 1;
    const bx = outline[2 * e]!;
    const by = outline[2 * e + 1]!;
    put(ax, ay);
    const pieces = Math.min(64, Math.floor(Math.hypot(bx - ax, by - ay) / ground.cell));
    for (let k = 1; k < pieces; k++) put(ax + ((bx - ax) * k) / pieces, ay + ((by - ay) * k) / pieces);
  }
  return Float64Array.from(out);
}

/** Four corners, from a to b and on, wound one way round. */
function quad(out: ArrayLike<number>[], ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): void {
  const q = [ax, ay, bx, by, cx, cy, dx, dy];
  let area = 0;
  for (let s = 0; s < 8; s += 2) area += q[s]! * q[(s + 3) % 8]! - q[(s + 2) % 8]! * q[s + 1]!;
  out.push(area < 0 ? [dx, dy, cx, cy, bx, by, ax, ay] : q);
}

/** What a stretch of the ground from a to b passes over when it is pushed along `fall` from `low` to `high`: four corners, wound one way round. */
function sweep(out: ArrayLike<number>[], ax: number, ay: number, bx: number, by: number, fall: Vec2, low: number, high: number): void {
  const quad = [ax + fall[0] * low, ay + fall[1] * low, bx + fall[0] * low, by + fall[1] * low, bx + fall[0] * high, by + fall[1] * high, ax + fall[0] * high, ay + fall[1] * high];
  let area = 0;
  for (let s = 0; s < 8; s += 2) area += quad[s]! * quad[(s + 3) % 8]! - quad[(s + 2) % 8]! * quad[s + 1]!;
  if (area < 0) out.push([quad[6]!, quad[7]!, quad[4]!, quad[5]!, quad[2]!, quad[3]!, quad[0]!, quad[1]!]);
  else out.push(quad);
}

/** The display list of a shot at a frame. */
export function evaluate(c: CompiledShot, bake: Bake, frame: number, lang: string): FrameState {
  if (!Number.isInteger(frame) || frame < 0 || frame >= c.frames) {
    throw new RangeError(`frame ${frame} is outside the shot (0..${c.frames - 1})`);
  }
  if (bake.header.sceneHash !== c.sceneHash || bake.header.frames !== c.frames) {
    throw new Error('the bake does not belong to this shot (scene hash or length differs); bake again');
  }
  const t = frame / FPS;
  // A shot with a perspective layer also says where its nodes lie in their planes and in the space.
  const places = c.spatial ? newPlaces(c) : undefined;
  // A shot with bodies also says where each of them stands.
  const feet = c.risen ? new Map<number, Foot>() : undefined;
  const world = computeWorld(c, frame, posesFromBake(bake), places, feet);
  const camera = cameraAt(c.spec.camera, c.cameraNoise, frame, c.frames, c.cameraTrack);

  const { own, alpha } = opacities(c, t);

  // A region whose outline is keyed, driven or seen in perspective carries the shape it has at this frame; any other item is what it always was.
  const reshaped = (n: CNode): { shape?: ShapeSpec } => {
    const shape = n.outline || n.form ? shapeOf(n, t) : null;
    // A region on a plane with a ground lies on it point by point.
    const laid = c.grounds && n.plane >= 0 && followsPointwise(n) ? groundOf(n.plane) : null;
    if (laid && n.node.type === 'shape') {
      const spec = shape ?? n.node.shape;
      if (spec.kind === 'polygon' && spec.rings) {
        const projectRing = (points: readonly Vec2[]): Vec2[] => laidOn(points, true, placeOf(n.index), places!.lifted[n.parent] ?? 0, laid[0], laid[1]);
        return { shape: { ...spec, points: projectRing(spec.points), rings: spec.rings.map(projectRing) } };
      }
      if (spec.kind === 'polygon') return { shape: { ...spec, points: laidOn(spec.points, true, placeOf(n.index), places!.lifted[n.parent] ?? 0, laid[0], laid[1]) } };
    }
    return shape ? { shape } : {};
  };
  // The ground of a plane and where the camera stands over it, at this frame; null for a plane without one.
  const groundOf = (plane: number): [GroundField, Vec3] | null => {
    const ground = places?.grounds.get(plane);
    const stand = places?.stands.get(plane);
    return ground && stand && stand[2] > 0 ? [ground, stand] : null;
  };
  // The relief that is the ground of its plane is drawn raised: where the camera stands, in the relief's own units.
  const raised = (n: CNode): { raise?: Vec3 } => {
    if (!c.grounds || n.plane < 0 || !isGround(c, n)) return {};
    const stand = places?.stands.get(n.plane);
    if (!stand || !(stand[2] > 0)) return {};
    const xf = placeOf(n.index);
    const [x, y] = vrot([(stand[0] - xf.x) / xf.scale, (stand[1] - xf.y) / xf.scale], -xf.rot);
    return { raise: [x, y, stand[2] / xf.scale] };
  };
  // A stroke on a plane with a ground lies on it point by point.
  let splitPaths: Map<number, PathSpec> | undefined;
  const strokeLaid = (n: CNode, split: boolean): { path?: PathSpec } => {
    const previous = split ? splitPaths?.get(n.index) : undefined;
    if (previous) return { path: previous };
    const keyed = n.outline || n.form ? strokePathOf(n, t) : null;
    const laid = c.grounds && n.plane >= 0 ? groundOf(n.plane) : null;
    if (!laid || n.node.type !== 'stroke') return keyed ? { path: keyed } : {};
    const path = keyed ?? n.node.path;
    if (path.heights) return keyed ? { path: keyed } : {};
    const projected = { ...path, points: laidOn(path.points, path.closed, placeOf(n.index), places!.lifted[n.parent] ?? 0, laid[0], laid[1]) };
    // Depth-sorted stretches share their parent's complete path and arc-length table within this frame.
    if (split) (splitPaths ??= new Map()).set(n.index, projected);
    return { path: projected };
  };
  // A shape without a fillTo is the item it always was.
  const filled = (n: CNode): { fill?: string } => (n.fill ? { fill: sampleFill(n.fill, t) } : {});
  // So is a line without a colorTo.
  const coloured = (n: CNode): { color?: string } => (n.fill ? { color: sampleFill(n.fill, t) } : {});
  // Where an item is drawn: in its plane for a node that lies in one, else in its layer.
  const placeOf = (index: number): Xf => places?.flat[index] ?? world[index]!;
  // A body that stands up carries where its foot stands; any other item is what it always was.
  const standing = (index: number): { foot?: Foot } => {
    const foot = feet?.get(index);
    return foot ? { foot } : {};
  };
  // A shape that stands up from its plane carries where the camera stands over that plane; any other is what it always was.
  const upon = (n: CNode): { upon?: Vec3 } => {
    if (n.node.type !== 'shape' || !n.node.stands || n.plane < 0) return {};
    // On a plane with a ground, it stands up from the ground under it: the camera is that much lower over it.
    const stand = lowered(places?.stands.get(n.plane), places?.lifted[n.index] ?? 0);
    return stand ? { upon: stand } : {};
  };

  const layers = c.layers.map((layer): LayerState => {
    const view = layerView(camera, layer.parallax);
    const root: Item[] = [];
    // The hazes of the layer, each with the number of items of the root drawn before it.
    const marks: { at: number; haze: Omit<HazeItem, 'before'> }[] = [];
    // Open groups: the items of a faded node and of its subtree go into its group. Each is open for the nodes from `start` to `end`.
    const open: { start: number; end: number; items: Item[] }[] = [];
    // The nodes from `skipFrom` to `skipUntil` are not drawn.
    let skipFrom = 0;
    let skipUntil = -1;
    // A layer that orders what it draws lists its nodes farthest first; any other layer as they were given.
    const listed = layer.ordered ? drawOrder(c, layer, t, places) : layer.nodes;
    // A layer with children drawn far to near takes them in that order, and a wall among them stretch by stretch.
    const steps = layer.sorted ? sortedSteps(c, listed, t, view.zoom, world, places, feet) : null;
    const order = steps ? steps.order : listed;
    // The shadows of a group that lie over its flat members, held from the group until its first raised child: each with the list it goes into.
    const shadowsHeld = new Map<number, { items: Item[]; item: Item }>();
    const placeShadows = (group: number): void => {
      const h = shadowsHeld.get(group);
      if (!h) return;
      h.items.push(h.item);
      shadowsHeld.delete(group);
    };
    for (let step = 0; step < order.length; step++) {
      const index = order[step]!;
      const part = steps ? steps.parts[step]! : null;
      const landing = steps?.casts.get(step);
      if (landing !== undefined) placeShadows(landing);
      const n = c.nodes[index]!;
      if (layer.ordered && n.parent < 0) {
        // The next node of the order: nothing of the one before it is open.
        open.length = 0;
        skipFrom = 0;
        skipUntil = -1;
      }
      if (index >= skipFrom && index <= skipUntil) continue;
      // What is open belongs to the nodes around this one. In a layer drawn as listed the nodes only go up; among
      // children drawn far to near they also go back, and a wall comes again with its next stretch.
      while (open.length > 0 && (index > open[open.length - 1]!.end || index <= open[open.length - 1]!.start)) open.pop();
      const retained = c.retainedMask?.[index];
      if (retained) {
        if (retained === 1)
          (open.length ? open[open.length - 1]!.items : root).push({ kind: 'group', node: n, opacity: 1, items: [], retained: true });
        continue;
      }
      if (index === layer.sampledIndex) {
        // This top-level placeholder follows the same draw order as its full group, including perspective sorting.
        root.push({ kind: 'group', node: n, opacity: 1, items: [], sampled: true });
        continue;
      }
      const node = n.node;
      const xf = placeOf(index);
      const a = alpha[index]!;
      if (n.haze) {
        // A haze moves the picture whatever the opacity of its shape: it takes its place in the draw order before the shape.
        const haze = hazeAt(n, xf, t);
        if (haze) marks.push({ at: root.length, haze });
      }
      if (own[index]! <= FAINT) {
        // Invisible, and so is everything inside it.
        skipFrom = index;
        skipUntil = n.subtreeEnd;
        continue;
      }
      let displayOpacity = own[index]!;
      const ink = c.inkSize?.[index];
      if (ink && places) {
        const map = places.planes.get(n.plane);
        if (map) {
          let extent = Infinity;
          const project = (p: Vec2): Vec2 | undefined => {
            const u = xfApply(xf, p);
            if (map.g * u[0] + map.h * u[1] + 1 < 0.125) return;
            return planePoint(map, u);
          };
          const pixels = (a: Vec2 | undefined, b: Vec2 | undefined): number =>
            a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) * view.zoom * c.inkPixels! : Infinity;
          if (node.type === 'stroke') {
            const path = strokeLaid(n, false).path ?? node.path;
            if (path.points.length === 2) {
              const [a, b] = path.points,
                radius = node.width / 2;
              const x = Math.min(a![0], b![0]) - radius,
                y = Math.min(a![1], b![1]) - radius;
              const right = Math.max(a![0], b![0]) + radius,
                bottom = Math.max(a![1], b![1]) + radius;
              const rect = [project([x, y]), project([right, y]), project([right, bottom]), project([x, bottom])];
              extent = 0;
              for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) extent = Math.max(extent, pixels(rect[i]!, rect[j]!));
            }
          } else if (node.type === 'shape' && node.shape.kind === 'polygon') {
            const [a, b, d, e] = node.shape.points.map(project);
            extent = Math.min(Math.max(pixels(a!, b!), pixels(d!, e!)), Math.max(pixels(b!, d!), pixels(e!, a!)));
          }
          displayOpacity *= Math.max(0, Math.min(1, (extent - 10) / 12));
          if (displayOpacity <= FAINT) continue;
        }
      }
      let items = open.length > 0 ? open[open.length - 1]!.items : root;
      if (n.plane === index) {
        // A group that lies in a plane: everything in it is drawn through the map of that plane.
        const map = places?.planes.get(index);
        if (!map) {
          // The camera cannot see the plane at this frame.
          skipFrom = index;
          skipUntil = n.subtreeEnd;
          continue;
        }
        const inner: Item[] = [];
        items.push({ kind: 'plane', node: n, map, items: inner, ...((node as GroupNode).fog ? { far: places!.far[index]! } : {}) });
        open.push({ start: index, end: n.subtreeEnd, items: inner });
        items = inner;
      }
      if (n.clipIndex >= 0) {
        // Drawn only inside the outline of a shape. Neighbours clipped to the same shape share one clip.
        const clipNode = c.nodes[n.clipIndex]!;
        const last = items[items.length - 1];
        // What is clipped to a soft shape fades out across its edge, as the shape does.
        const softness = clipNode.node.type === 'shape' && clipNode.node.soft ? { soft: clipNode.node.soft * world[n.clipIndex]!.scale } : {};
        let inner: Item[];
        if (last && last.kind === 'clip' && last.node === clipNode) {
          inner = last.items as Item[];
        } else if (clipNode.level) {
          // Clipped to a content: only its filled part holds anything.
          const g = levelGeometry(clipNode, placeOf(n.clipIndex), t);
          if (g.level <= LEVEL_EMPTY) {
            skipFrom = index;
            skipUntil = n.subtreeEnd;
            continue;
          }
          inner = [];
          if (g.level < 1 - 1e-6) items.push({ kind: 'clip', node: clipNode, xf: placeOf(n.clipIndex), level: levelClip(g), ...reshaped(clipNode), ...softness, items: inner });
          else items.push({ kind: 'clip', node: clipNode, xf: placeOf(n.clipIndex), ...reshaped(clipNode), ...softness, items: inner });
        } else {
          inner = [];
          items.push({ kind: 'clip', node: clipNode, xf: placeOf(n.clipIndex), ...reshaped(clipNode), ...softness, items: inner });
        }
        open.push({ start: index, end: n.subtreeEnd, items: inner });
        items = inner;
      }
      if (n.axis && xf.scale > HIDDEN) {
        // Its width and its height were changed: everything in it is drawn through that change.
        const s = sampleAxis(n.axis, t);
        if (s) {
          const inner: Item[] = [];
          items.push({ kind: 'stretch', node: n, at: [xf.x, xf.y], height: 1, axes: { rot: xf.rot, scale: xf.scale, ...s }, items: inner });
          open.push({ start: index, end: n.subtreeEnd, items: inner });
          items = inner;
        }
      }
      if (n.stretch) {
        const s = sampleStretch(n.stretch, t);
        if (s) {
          const inner: Item[] = [];
          // The pivot is measured from the node's origin in the layer's directions, in the node's units.
          items.push({ kind: 'stretch', node: n, at: [xf.x + s.pivot[0] * xf.scale, xf.y + s.pivot[1] * xf.scale], height: s.height, items: inner });
          open.push({ start: index, end: n.subtreeEnd, items: inner });
          items = inner;
        }
      }
      // A soft node is one picture, as a faded one is; its blur is that of its units where it is drawn.
      const soft = (node.type === 'shape' || node.type === 'group') && node.soft !== undefined ? node.soft * world[index]!.scale : 0;
      if (soft > 0) {
        const group: Item[] = [];
        items.push({ kind: 'group', node: n, opacity: Math.min(1, own[index]!), items: group, soft });
        open.push({ start: index, end: n.subtreeEnd, items: group });
        items = group;
      } else if (displayOpacity < OPAQUE) {
        const group: Item[] = [];
        items.push({ kind: 'group', node: n, opacity: displayOpacity, items: group });
        open.push({ start: index, end: n.subtreeEnd, items: group });
        items = group;
      }
      // What detail a body is worth at this frame; null for anything that is not a body of a group that says so.
      const worth = c.detail && feet ? worthOf(c, n, t, feet.get(index), world[index]!.scale * view.zoom) : null;
      switch (node.type) {
        case 'group':
          if (node.cast && feet && xf.scale > HIDDEN) {
            // The shadows of its bodies: one picture under everything else of the group, at the opacity and with the blur of the cast.
            const fall = castFall(c, node.cast);
            const shadows = castShadows(c, n, t, view.zoom, fall, world, places, feet, alpha);
            if (shadows.length > 0 && node.cast.opacity > FAINT) {
              const blur = node.cast.soft * world[index]!.scale;
              let most = 0;
              for (const s of shadows) if (s.alpha > most) most = s.alpha;
              const item: Item = { kind: 'group', node: n, opacity: node.cast.opacity, items: [{ kind: 'cast', node: n, alpha: most, shadows }], ...(blur > 0 ? { soft: blur } : {}) };
              // Over the flat members: drawn when the first raised one is.
              if (node.cast.over === 'flat') shadowsHeld.set(index, { items, item });
              else items.push(item);
            }
          }
          break;
        case 'shape':
          if (xf.scale <= HIDDEN) break;
          // An outline worked out at this frame may have nothing to show: it is edge-on, or seen from a back that is not drawn.
          if (n.form && formAt(n, t).hidden) break;
          if (n.level) {
            // A content: nothing of it while it is empty, all of it when it is full, else the part below its surface.
            const g = levelGeometry(n, xf, t);
            if (g.level <= LEVEL_EMPTY) break;
            if (g.level < 1 - 1e-6) {
              items.push({ kind: 'shape', node: n, xf, alpha: a, level: levelClip(g), ...reshaped(n), ...filled(n) });
              break;
            }
          }
          // A body of a group that says what detail its bodies are worth is plain while it is small: its top alone, where its top is.
          items.push({ kind: 'shape', node: n, xf, alpha: a, ...reshaped(n), ...filled(n), ...(worth?.plain ? {} : standing(index)), ...(worth ? { detail: worth } : {}), ...upon(n), ...raised(n), ...(node.globe ? { globeAt: t } : {}) });
          break;
        case 'eye': {
          if (xf.scale <= HIDDEN) break;
          const lid = n.lid ? sampleLid(n.lid, t) : 1;
          if (lid <= SHUT) break;
          let look: Vec2 = [0, 0];
          if (n.lookAtIndex >= 0) {
            // An eye that lies in a plane looks at where its target is in that plane.
            const map = n.plane >= 0 ? places?.planes.get(n.plane) : undefined;
            const there = world[n.lookAtIndex]!;
            const target = map ? (c.nodes[n.lookAtIndex]!.plane === n.plane ? placeOf(n.lookAtIndex) : { ...there, ...intoPlane(map, there) }) : there;
            const dx = target.x - xf.x;
            const dy = target.y - xf.y;
            const dist = Math.hypot(dx, dy);
            if (dist > 1e-6) {
              const m = Math.min(1, dist / 160);
              look = vrot([(dx / dist) * m, (dy / dist) * m], -xf.rot);
            }
          }
          items.push({ kind: 'eye', node: n, xf, look, open: lid * eyeOpen(n.blinks, t), alpha: a });
          break;
        }
        case 'text': {
          if (xf.scale <= HIDDEN) break;
          const { layout, block, slot } = textLayout(c, n, lang);
          const grown = n.scale ? sampleScale(n.scale, t) : 1;
          if (slot && n.count && node.count) {
            // A counter: the line of the number is set anew for the number it shows now.
            const number = formatCount(sampleCount(n.count, t), node.count.decimals, lang, node.count.grouping !== false);
            const y = block.lines[slot.line]!.y;
            const lines = [...block.lines.filter((_, i) => i !== slot.line), ...countRuns(layout, slot, number, node.align).map((r) => ({ ...r, y }))];
            items.push({ kind: 'text', node: n, xf, alpha: a, block, layout, lines, number, grown });
          } else items.push({ kind: 'text', node: n, xf, alpha: a, block, layout, lines: block.lines, grown });
          break;
        }
        case 'stroke': {
          if (xf.scale <= HIDDEN) break;
          const drawn = sampleDrawn(n.stroke!, t);
          if (drawn <= 1e-6) break;
          if (n.form && formAt(n, t).hidden) break;
          // A stroke without a pulse is the item it always was.
          const pulses = n.stroke!.pulses.length > 0 ? sampleStrokePulses(n.stroke!, pathTable(strokePathOf(n, t)).length, t) : [];
          // A line with a least width is as wide, in its own units, as it takes to be that wide on screen; never thinner than it was made.
          const held = node.least === undefined ? {} : { width: Math.max(node.width, node.least / Math.max(world[index]!.scale * view.zoom, 1e-9)) };
          // A line on a globe: the parts of it that face the viewer.
          const runs = n.globe ? surfaceRuns(surfaceLine(node.path), globeView(n.globe.spec, t), n.globe.r, Math.min(1, drawn)) : null;
          if (runs && runs.length === 0) break;
          items.push({ kind: 'stroke', ...(runs ? { runs } : {}), node: n, xf, alpha: a, drawn: Math.min(1, drawn), solid: node.dash ? sampleSolid(n.stroke!, t) : 1, ...(pulses.length > 0 ? { pulses } : {}), ...strokeLaid(n, !!part), ...(n.width ? { width: sampleWidth(n.width, t) } : {}), ...held, ...coloured(n), ...(worth?.plain ? {} : standing(index)), ...(part ? { part } : {}) });
          break;
        }
        case 'link': {
          const from = world[n.fromIndex]!;
          const to = world[n.toIndex]!;
          if (from.scale <= HIDDEN || to.scale <= HIDDEN) break;
          const reveal = sampleReveal(n.link!, t);
          if (reveal <= 0) break;
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const len = Math.hypot(dx, dy);
          if (len < 1e-6) break;
          const dir: Vec2 = [dx / len, dy / len];
          const r0 = reachOf(c.nodes[n.fromIndex]!, from, dir, t) + node.gap;
          const r1 = reachOf(c.nodes[n.toIndex]!, to, [-dir[0], -dir[1]], t) + node.gap;
          if (len <= r0 + r1 + 1) break;
          // The bend the link was given, or the one a bendTo has brought it to.
          const bend = n.link!.bends.length > 0 ? sampleBend(n.link!, node.bend, t) : node.bend;
          const mid: Vec2 = [(from.x + to.x) / 2 - dir[1] * bend * len, (from.y + to.y) / 2 + dir[0] * bend * len];
          const curve = quadSub([[from.x, from.y], mid, [to.x, to.y]], r0 / len, 1 - r1 / len);
          const pulses: { head: number; tail: number }[] = [];
          for (const p of n.link!.pulses) {
            const span = pulseSpan(t, p.at, p.dur);
            if (span && span.head > span.tail) pulses.push(span);
          }
          // A link without a widthTo or a colorTo is the item it always was.
          items.push({ kind: 'link', node: n, curve, reveal, pulses, alpha: a, ...(n.width ? { width: sampleWidth(n.width, t) } : {}), ...coloured(n) });
          break;
        }
        case 'label': {
          if (xf.scale <= HIDDEN) break;
          const { layout, geometry, slot } = labelLayout(c, n, lang);
          if (slot && n.count && node.count) {
            // A counter: the line of its number is set anew for the number it shows now, in the middle of the box.
            const number = formatCount(sampleCount(n.count, t), node.count.decimals, lang, node.count.grouping !== false);
            const { x, y } = geometry.lines[slot.line]!;
            const lines = [...geometry.lines.filter((_, i) => i !== slot.line), ...countRuns(layout, slot, number, 'center').map((r) => ({ text: r.text, x: x + r.x, y }))];
            items.push({ kind: 'label', node: n, tip: [xf.x, xf.y], scale: xf.scale, geometry, layout, alpha: a, lines, number });
          } else items.push({ kind: 'label', node: n, tip: [xf.x, xf.y], scale: xf.scale, geometry, layout, alpha: a });
          break;
        }
        case 'emitter': {
          const data = bake.particlesAt(n.emitterSlot, frame);
          // An emitter of streaks carries their tails; an emitter of round particles is the item it always was.
          if (data.length > 0) items.push({ kind: 'particles', node: n, data, ...(node.streak === undefined ? {} : { tails: bake.tailsAt(n.emitterSlot, frame)! }) });
          break;
        }
      }
    }
    // Shadows whose raised bodies were not drawn at all go after the flat members still.
    for (const group of [...shadowsHeld.keys()]) placeShadows(group);
    const focus = layer.focus ? { blur: sampleRise(layer.focus, t) } : {};
    if (marks.length === 0) return { layer, view, items: prune(root), ...focus };
    const { items, hazes } = pruneWithHazes(root, marks);
    return { layer, view, items, hazes, ...focus };
  });

  // A shot whose background is not keyed is the state it always was.
  if (c.backgroundTrack) return { frame, time: t, lang, camera, layers, background: sampleBackground(c.backgroundTrack, t) };
  return { frame, time: t, lang, camera, layers };
}
