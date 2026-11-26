// The motion series of a shot: the state of every node and of the camera at
// every frame, computed without drawing anything. Everything the motion review
// reports, and everything its pictures show, is read from here.
//
// Two spaces are kept for every placed node:
//   - the layer's space ("stage"): where the node is with the camera frozen;
//     with the layer's view of a frame this gives its place on screen;
//   - the parent's space ("own"): what the node itself does, without the
//     motion of whatever it is attached to. For a label that is its offset
//     from the node it points at.

import { cameraAt, layerView } from '../camera/camera.ts';
import type { SpringParams } from '../core/dynamics.ts';
import { DEG, xfApply, type Vec2, type Vec3, type Xf } from '../core/math.ts';
import { FPS } from '../core/time.ts';
import { pulseSpan } from '../motion/curves.ts';
import { pathTable, type PathSpec } from '../motion/paths.ts';
import { sampleAxis, sampleBend, sampleCount, sampleDrawn, sampleLevel, sampleLid, sampleReveal, sampleRise, sampleRot, sampleScale, sampleSolid, sampleStrokePulses, sampleWidth } from '../motion/tracks.ts';
import { PARTICLE_STRIDE, PARTICLE_TAIL_STRIDE, PARTICLE_VELOCITY_STRIDE, type Bake } from '../physics/cache.ts';
import { backgroundStep } from '../scene/background.ts';
import { fillStep } from '../scene/fill.ts';
import type { CNode, CompiledShot } from '../scene/compile.ts';
import {
  castFall,
  computeWorld,
  eyeOpen,
  FAINT,
  HIDDEN,
  labelLayout,
  LEVEL_EMPTY,
  levelGeometry,
  newPlaces,
  shadowDrop,
  textLayout,
  opacities,
  shapeOf,
  SHUT,
  strokePathOf,
  swayDirection,
  type Places,
  type PoseSource,
} from '../scene/evaluate.ts';
import { formAt, formStep } from '../scene/form.ts';
import { globeSpins, globeTurn } from '../scene/globe.ts';
import { outlineTravel, restForms } from '../scene/outline.ts';
import { eyeOf, perspAt, project } from '../scene/space.ts';
import { STAGE_H, STAGE_W, type GroupNode } from '../scene/types.ts';
import { containsPoint, transformOutline, outlineOf, shapeExtent, type ShapeSpec } from '../shape/geometry.ts';
import { languagesOf } from '../text/strings.ts';
import { T } from './thresholds.ts';

/** Flag: the node is drawn at this frame. */
export const DRAWN = 1;
/** Flag: it is drawn and reaches into the frame. */
export const IN_FRAME = 2;

/** The frame is cut into this grid for the dead-area check (see FRAME_REGIONS). */
export const REGION_COLS = 3;
export const REGION_ROWS = 2;

/** A shape, a group, an eye, a stroke, a text or a label over the whole shot. */
export interface PlacedSeries {
  readonly node: CNode;
  readonly id: string;
  readonly type: 'shape' | 'group' | 'eye' | 'label' | 'stroke' | 'text';
  /** Its motion comes from the rigid-body solver: a body, or a label that points at one. */
  readonly solver: boolean;
  /**
   * Nothing animates it: no key, no idle wander, no spring, no solver, and
   * nothing it is attached to moves either. Its series are constant (only
   * the camera decides whether it is in frame), so the detectors pass it over.
   */
  readonly still: boolean;
  /** Place in the layer's space, per frame. For a label: the tip of its tail. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Rotation in degrees, continuous over the shot. */
  readonly rot: Float32Array;
  readonly scale: Float32Array;
  /** Opacity down the tree. */
  readonly alpha: Float32Array;
  /** The node's own opacity, without what it is nested in. */
  readonly ownAlpha: Float32Array;
  /**
   * Own motion: place in the parent's space, in the parent's units. For a label
   * and for a node on a follow spring: the offset from its target or parent in
   * the layer's units, because that is the space such a node moves in. For a
   * node listed in a perspective layer: what it does in the space of the
   * layer, as the camera of each frame sees it, in the layer's units; what
   * the camera of the layer does is left out (it is judged on that camera).
   * For a node in a group that lies in a plane: its place in that plane.
   */
  readonly ownX: Float32Array;
  readonly ownY: Float32Array;
  /** Own rotation in degrees, continuous. */
  readonly ownRot: Float32Array;
  /** Own scale: the node's size relative to its parent. */
  readonly ownScale: Float32Array;
  /** Screen px per unit of the parent's space at each frame. */
  readonly unit: Float32Array;
  /** DRAWN and IN_FRAME, per frame. */
  readonly flags: Uint8Array;
  /** Eyes: how far the lids are open (with blinks); null for other nodes. */
  readonly open: Float32Array | null;
  /** Shapes with a level: the height of the surface in the layer's space, per frame; null for other nodes. */
  readonly level: Float32Array | null;
  /** Nodes whose width and height are changed along their own axes (scaleTo with to: [sx, sy]): the two factors per frame; null for other nodes. */
  readonly axis: { readonly sx: Float32Array; readonly sy: Float32Array } | null;
  /**
   * What else changes in the node by itself, as a length in the layer's units
   * per frame: for a stroke, how much of it is drawn, how far its gaps are
   * closed and where the lights are that run along it; for a counter, the
   * number it shows, so that every change of it is a step. A step of it is a
   * change a viewer sees. null for other nodes.
   */
  readonly life: Float32Array | null;
  /**
   * Regions and strokes whose outline is keyed (reshape) or driven (drive
   * with points): how far the outline has changed by each frame, as the way
   * of the point that travels farthest, in the layer's units. It only grows;
   * null for other nodes.
   */
  readonly outline: Float32Array | null;
  /** Strokes whose width is keyed (widthTo): the width of the line in the layer's units, per frame; null for other nodes. */
  readonly width: Float32Array | null;
  /**
   * Bodies whose height is keyed (riseTo) in a group that casts shadows (cast): how long the shadow of the body is
   * on the ground, in the layer's units as the body is seen, per frame; null for other nodes.
   */
  readonly shadow: Float32Array | null;
  /**
   * Shapes whose fill is keyed (fillTo): how far the fill changes from the frame before to each frame, as the
   * largest change of a channel, a share of its full range; null for other nodes.
   */
  readonly fill: Float32Array | null;
  /** Radius, in the node's own units, of a circle around its origin that holds it and everything in it. */
  readonly radius: number;
  /** Radius at which a turn of the node shows: 0 when turning it changes nothing (a plain disc). */
  readonly turnRadius: number;
}

/** A link over the whole shot. */
export interface LinkSeries {
  readonly node: CNode;
  readonly id: string;
  /** Opacity times the share of the link that is drawn; 0 while it is not drawn at all. */
  readonly presence: Float32Array;
  /** Middle and half-length in the layer's space. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly half: Float32Array;
  /** 1 while a pulse travels along it, it is being drawn on, its bend or its width changes, or a driven node at one of its ends moves. */
  readonly active: Uint8Array;
  readonly flags: Uint8Array;
  /** Links whose width is keyed (widthTo): the width of the line in the layer's units, per frame; null for other links. */
  readonly width: Float32Array | null;
}

/** What the particles of an emitter do, frame by frame. Only particles in frame are counted. */
export interface EmitterSeries {
  readonly node: CNode;
  readonly id: string;
  readonly count: Uint32Array;
  /** How many of them strobe: at least `fastRatio` of their own size and `fastMinPx` in a frame. */
  readonly fast: Uint32Array;
  /** Median travel per frame as a share of the particle's size, and the median speed in px per frame. */
  readonly medianRatio: Float32Array;
  readonly medianSpeed: Float32Array;
  /** Bit r: a particle moves in region r of the frame. */
  readonly regions: Uint8Array;
}

/**
 * A heat haze over the whole shot. Its ripples drift at one speed; the finer ones, half the size of the larger, are
 * the ones that strobe first, so the haze is judged on them.
 */
export interface HazeSeries {
  readonly node: CNode;
  readonly id: string;
  /** How far it moves the picture at most, in px, per frame; 0 while it moves nothing, or nothing in frame. */
  readonly amount: Float32Array;
  /** About how far the picture under it moves from one frame to the next, in px; 0 likewise. */
  readonly shimmer: Float32Array;
  /** How far its ripples drift in a frame, in px. */
  readonly step: Float32Array;
  /** How far its finer ripples drift in a frame, as a share of their size; the camera changes both alike. */
  readonly ratio: number;
  /** Bit r: it moves the picture in region r of the frame. */
  readonly regions: Uint8Array;
}

/** A spring-driven point: where it would be without the spring, and where it is. */
export interface SpringSeries {
  readonly node: CNode;
  readonly id: string;
  readonly kind: 'follow' | 'sway';
  readonly params: SpringParams;
  readonly restX: Float32Array;
  readonly restY: Float32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
}

/**
 * The camera of a perspective layer whose view is keyed (perspectiveTo): what
 * it does from the frame before to each frame.
 */
export interface PerspectiveSeries {
  /** Index of the layer in the shot, and its id. */
  readonly layer: number;
  readonly id: string;
  /** How far the picture slides at the point the camera looks at, in px: to the right and down. */
  readonly slideX: Float32Array;
  readonly slideY: Float32Array;
  /** How far the camera goes round that point, and how far it tilts, in radians. */
  readonly round: Float32Array;
  readonly tilt: Float32Array;
  /** By what share the picture grows at that point: 0.01 is one per cent in a frame. */
  readonly grow: Float32Array;
}

/** A layer whose focus is pulled (blurTo): how its blur changes from the frame before to each frame. */
export interface FocusSeries {
  /** Index of the layer in the shot, and its id. */
  readonly layer: number;
  readonly id: string;
  /** The change of its blur radius on screen, in px (positive: it blurs): how far a blurred edge spreads or gathers. */
  readonly step: Float32Array;
}

/** How a layer is mapped to the screen at every frame: screen = layer * zoom + (tx, ty). */
export interface ViewSeries {
  readonly zoom: Float64Array;
  readonly tx: Float64Array;
  readonly ty: Float64Array;
}

export interface MotionSeries {
  readonly shot: CompiledShot;
  readonly frames: number;
  readonly lang: string;
  readonly camera: { readonly x: Float64Array; readonly y: Float64Array; readonly zoom: Float64Array };
  /** By layer index. */
  readonly views: readonly ViewSeries[];
  /** By node index; null for links and emitters. */
  readonly placed: readonly (PlacedSeries | null)[];
  readonly links: readonly LinkSeries[];
  /** By emitter slot. Empty when particles were not sampled. */
  readonly emitters: readonly EmitterSeries[];
  /** By spring slot. */
  readonly springs: readonly SpringSeries[];
  /**
   * A shot whose background is keyed (backgroundTo): how far the background
   * changes from the frame before to each frame, as a share of the full range
   * of its values (a channel of a colour, the vignette, the place and the size
   * of the gradient). Left out in a shot whose background stays as it is.
   */
  readonly background?: Float32Array;
  /** The cameras of the perspective layers whose view is keyed. Left out in a shot without one. */
  readonly perspectives?: readonly PerspectiveSeries[];
  /** The heat hazes. Left out in a shot without one. */
  readonly hazes?: readonly HazeSeries[];
  /** The layers whose focus is pulled. Left out in a shot without one. */
  readonly focus?: readonly FocusSeries[];
}

export interface SampleOptions {
  /** Language of the labels (their size depends on the string); default: the first table. */
  readonly lang?: string;
  /** Read the particles too (how fast they travel, where they move); default true. */
  readonly particles?: boolean;
}

/** Region bits of a circle on screen (0 when it is outside the frame). */
export function regionsOf(sx: number, sy: number, r: number): number {
  if (sx + r < 0 || sy + r < 0 || sx - r > STAGE_W || sy - r > STAGE_H) return 0;
  const cw = STAGE_W / REGION_COLS;
  const ch = STAGE_H / REGION_ROWS;
  const c0 = Math.max(0, Math.floor((sx - r) / cw));
  const c1 = Math.min(REGION_COLS - 1, Math.floor((sx + r) / cw));
  const r0 = Math.max(0, Math.floor((sy - r) / ch));
  const r1 = Math.min(REGION_ROWS - 1, Math.floor((sy + r) / ch));
  let bits = 0;
  for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) bits |= 1 << (row * REGION_COLS + col);
  return bits;
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}




/**
 * Clears `drawn` for shapes and eyes that cannot be seen at this frame: every
 * one of nine points of the node (its middle and eight on its edge) lies under
 * a cover drawn after it, or outside the shape the node is clipped to. A node
 * that shows at one point is still seen.
 */
function markHidden(c: CompiledShot, world: readonly Xf[], alpha: Float64Array, drawn: Uint8Array, t: number): void {
  const polys = new Map<number, { poly: Vec2[]; x0: number; y0: number; x1: number; y1: number }>();
  const polyOf = (index: number): { poly: Vec2[]; x0: number; y0: number; x1: number; y1: number } => {
    let hit = polys.get(index);
    if (!hit) {
      const node = c.nodes[index]!.node;
      const poly = node.type === 'shape' ? transformOutline(shapeOf(c.nodes[index]!, t), (p) => xfApply(world[index]!, p)) : [];
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of poly) {
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
      }
      hit = { poly, x0, y0, x1, y1 };
      polys.set(index, hit);
    }
    return hit;
  };
  // Covers that hide at this frame: drawn, nearly opaque, and not themselves a content with a level.
  const covers = c.covers.filter((i) => drawn[i] === 1 && alpha[i]! >= T.coverAlpha && c.nodes[i]!.level === null);
  for (const n of c.nodes) {
    const i = n.index;
    const node = n.node;
    if (!drawn[i] || (node.type !== 'shape' && node.type !== 'eye')) continue;
    // What lies in a plane of a perspective layer is taken as seen: the layer has its place only roughly.
    if (n.plane >= 0) continue;
    const xf = world[i]!;
    const points: Vec2[] = [];
    if (node.type === 'shape') {
      const { center } = shapeExtent(shapeOf(n, t));
      const ring = outlineOf(shapeOf(n, t));
      points.push(xfApply(xf, center));
      for (let k = 0; k < 8; k++) points.push(xfApply(xf, ring[Math.floor((k * ring.length) / 8)]!));
    } else {
      points.push([xf.x, xf.y]);
      for (let k = 0; k < 8; k++) points.push([xf.x + Math.cos((k * Math.PI) / 4) * node.r * xf.scale, xf.y + Math.sin((k * Math.PI) / 4) * node.r * xf.scale]);
    }
    // The shapes this node is clipped to: its own and those of everything it is in.
    const clips: number[] = [];
    for (let k = i; k >= 0; k = c.nodes[k]!.parent) if (c.nodes[k]!.clipIndex >= 0) clips.push(c.nodes[k]!.clipIndex);
    // A layer that orders what it draws has no fixed "after": there a cover hides nothing from the review.
    const later = c.layers[n.layer]!.ordered ? [] : covers.filter((ci) => ci > n.subtreeEnd && c.nodes[ci]!.layer === n.layer);
    if (clips.length === 0 && later.length === 0) continue;
    let seen = false;
    for (const p of points) {
      let hidden = false;
      for (const ci of clips) {
        if (!containsPoint(polyOf(ci).poly, p[0], p[1])) {
          hidden = true;
          break;
        }
      }
      for (let k = 0; !hidden && k < later.length; k++) {
        const cover = polyOf(later[k]!);
        if (p[0] < cover.x0 || p[0] > cover.x1 || p[1] < cover.y0 || p[1] > cover.y1) continue;
        hidden = containsPoint(cover.poly, p[0], p[1]);
      }
      if (!hidden) {
        seen = true;
        break;
      }
    }
    if (!seen) drawn[i] = 0;
  }
}

/**
 * How long the shadow of a node is to each unit of its height: the length of the cast of the nearest group above it
 * that casts shadows, 0 under none.
 */
function castLength(c: CompiledShot, n: CNode): number {
  for (let p = n.parent; p >= 0; p = c.nodes[p]!.parent) {
    const above = c.nodes[p]!.node;
    if (above.type === 'group' && above.cast) return above.cast.length;
  }
  return 0;
}

/**
 * Under a cast that lies on the ground (cast.ground): how much longer the shadow of the top of a body is than on level
 * ground, where the body stands at this frame (less than 1 where the ground rises toward the shadow). 1 for any other
 * node. `rise` is the body's height in its own units.
 */
function groundShare(c: CompiledShot, n: CNode, places: Places | undefined, rise: number): number {
  if (!places || n.plane < 0 || !(rise > 0)) return 1;
  let p = n.parent;
  while (p >= 0 && !(c.nodes[p]!.node.type === 'group' && (c.nodes[p]!.node as { cast?: unknown }).cast)) p = c.nodes[p]!.parent;
  const cast = p >= 0 ? (c.nodes[p]!.node as GroupNode).cast : undefined;
  const ground = places.grounds.get(n.plane);
  const stand = places.stands.get(n.plane);
  const top = places.flat[n.index];
  if (!cast?.ground || !ground || !stand || !(stand[2] > 0) || !top || n.index < c.grounds!.get(n.plane)![0]!) return 1;
  // The top is the foot drawn larger about the point the camera stands over: the body's height over the ground under
  // it, and the true place of its foot.
  const z = places.lifted[n.index]!;
  const eye = stand[2] - z;
  const r = rise * top.scale;
  const high = Math.min((r * eye) / (eye + r), 0.9 * eye);
  const x = stand[0] + ((top.x - stand[0]) * (eye - high)) / stand[2];
  const y = stand[1] + ((top.y - stand[1]) * (eye - high)) / stand[2];
  return high > 1e-9 ? shadowDrop(ground, x, y, z, high, castFall(c, cast)) / high : 1;
}

/** Evaluates the shot at every frame and returns the series of everything in it. */
export function sampleMotion(c: CompiledShot, bake: Bake, opts: SampleOptions = {}): MotionSeries {
  if (bake.header.sceneHash !== c.sceneHash || bake.header.frames !== c.frames) {
    throw new Error('the bake does not belong to this shot (scene hash or length differs); bake again');
  }
  const frames = c.frames;
  const lang = opts.lang ?? languagesOf(c.spec.strings)[0]!;
  const N = c.nodes.length;

  // Static sizes: a circle around the node's origin that holds its subtree, and
  // the radius at which a turn shows. Children come after their parent in the
  // node list, so one pass from the end folds every subtree into its root.
  const radius = new Float64Array(N);
  const turnRadius = new Float64Array(N);
  for (const n of c.nodes) {
    const node = n.node;
    if (node.type === 'shape') {
      // A region whose outline is keyed: the largest of the outlines it rests in.
      for (const shape of n.outline ? (restForms(n.outline) as ShapeSpec[]) : [node.shape]) {
        const ext = shapeExtent(shape);
        radius[n.index] = Math.max(radius[n.index]!, Math.hypot(ext.center[0], ext.center[1]) + ext.outer);
      }
      // A globe turns its surface: its turn shows at its rim.
      turnRadius[n.index] = node.shape.kind === 'circle' && !node.globe ? 0 : radius[n.index]!;
    } else if (node.type === 'eye') {
      radius[n.index] = node.r;
    } else if (node.type === 'stroke' && n.globe) {
      // A line on a globe lies on its disc.
      radius[n.index] = n.globe.r + node.width / 2;
      turnRadius[n.index] = radius[n.index]!;
    } else if (node.type === 'stroke') {
      // The farthest point of the line from its origin, with half its width.
      let far = 0;
      for (const path of n.outline ? (restForms(n.outline) as PathSpec[]) : [node.path]) {
        const table = pathTable(path);
        for (let i = 0; i < table.xs.length; i++) far = Math.max(far, Math.hypot(table.xs[i]!, table.ys[i]!));
      }
      // A stroke whose width is keyed: the widest it comes to rest at.
      radius[n.index] = far + Math.max(node.width, ...(n.width ? n.width.segs.map((seg) => seg.to) : [])) / 2;
      turnRadius[n.index] = radius[n.index]!;
    } else if (node.type === 'label' || node.type === 'text') {
      const box = node.type === 'label' ? labelLayout(c, n, lang).geometry.box : textLayout(c, n, lang).block.box;
      if (node.type === 'text') turnRadius[n.index] = Math.hypot(Math.max(Math.abs(box.x), Math.abs(box.x + box.w)), Math.max(Math.abs(box.y), Math.abs(box.y + box.h)));
      radius[n.index] = Math.max(
        Math.hypot(box.x, box.y),
        Math.hypot(box.x + box.w, box.y),
        Math.hypot(box.x, box.y + box.h),
        Math.hypot(box.x + box.w, box.y + box.h),
      );
    }
  }
  for (let i = N - 1; i >= 0; i--) {
    const n = c.nodes[i]!;
    const node = n.node;
    if (n.parent < 0 || (node.type !== 'shape' && node.type !== 'group' && node.type !== 'eye' && node.type !== 'stroke' && node.type !== 'text')) continue;
    // On a globe, a place is [lon, lat]: a thing stands at most its height off the disc, and a line lies on it.
    const offset = n.globe ? (node.type === 'stroke' ? 0 : n.globe.r + (node.z ?? 0)) : Math.hypot(node.at[0], node.at[1]);
    radius[n.parent] = Math.max(radius[n.parent]!, offset + radius[i]! * node.scale);
    turnRadius[n.parent] = Math.max(turnRadius[n.parent]!, offset + turnRadius[i]! * node.scale);
  }

  const isBody = (index: number): boolean => {
    for (let i = index; i >= 0; i = c.nodes[i]!.parent) if (c.nodes[i]!.bodySlot >= 0) return true;
    return false;
  };

  // Nodes that nothing animates. Parents come before their children in the
  // node list; a label whose target comes later is simply taken as animated.
  const still = new Uint8Array(N);
  for (const n of c.nodes) {
    const node = n.node;
    if (node.type === 'link' || node.type === 'emitter') continue;
    const animated =
      (n.pos?.segs.length ?? 0) > 0 ||
      (n.rot?.segs.length ?? 0) > 0 ||
      (n.scale ? n.scale.pops.length + n.scale.grows.length + n.scale.bumps.length > 0 : false) ||
      (n.opacity?.segs.length ?? 0) > 0 ||
      n.springKind !== null ||
      (node.type === 'shape' && node.body?.kind === 'dynamic') ||
      ((node.type === 'shape' || node.type === 'group') && node.idle !== null && node.idle.amp > 0) ||
      (node.type === 'eye' && ((n.lid?.segs.length ?? 0) > 0 || n.blinks.length > 0)) ||
      // A content whose level changes or whose surface ripples; a node that is squashed or stretched.
      (n.level !== null && (n.level.segs.length > 0 || (node.type === 'shape' && (node.level?.wave?.amp ?? 0) > 0))) ||
      n.stretch !== null ||
      n.axis !== null ||
      n.outline !== null ||
      n.width !== null ||
      // A body whose height is keyed: its top moves, and what rides on it.
      (n.rise !== null && n.rise.segs.length > 0) ||
      n.fill !== null ||
      // A globe that turns.
      (node.type === 'shape' && node.globe !== undefined && globeSpins(node.globe)) ||
      // A drive, a hinge that turns, and the camera of a perspective layer: where the node is drawn changes with each.
      n.driven ||
      n.hinge !== null ||
      (c.layers[n.layer]!.persp?.segs.length ?? 0) > 0 ||
      (n.count !== null && n.count.segs.length > 0) ||
      (n.stroke !== null && n.stroke.draws.length + n.stroke.solids.length + n.stroke.pulses.length > 0) ||
      (n.parent >= 0 && still[n.parent] === 0) ||
      (node.type === 'label' && still[n.targetIndex] === 0);
    still[n.index] = animated ? 0 : 1;
  }

  const f32 = (): Float32Array => new Float32Array(frames);
  const placed: (PlacedSeries | null)[] = c.nodes.map((n): PlacedSeries | null => {
    const type = n.node.type;
    if (type === 'link' || type === 'emitter') return null;
    return {
      node: n,
      id: n.id,
      type,
      solver: type === 'label' ? isBody(n.targetIndex) : n.bodySlot >= 0,
      still: still[n.index] === 1,
      x: f32(),
      y: f32(),
      rot: f32(),
      scale: f32(),
      alpha: f32(),
      ownAlpha: f32(),
      ownX: f32(),
      ownY: f32(),
      ownRot: f32(),
      ownScale: f32(),
      unit: f32(),
      flags: new Uint8Array(frames),
      open: type === 'eye' ? f32() : null,
      level: n.level ? f32() : null,
      axis: n.axis ? { sx: f32().fill(1), sy: f32().fill(1) } : null,
      life: type === 'stroke' || n.count !== null ? f32() : null,
      outline: n.outline || n.form?.drive ? f32() : null,
      width: n.width ? f32() : null,
      shadow: n.rise !== null && n.rise.segs.length > 0 && castLength(c, n) > 0 ? f32() : null,
      fill: n.fill ? f32() : null,
      radius: radius[n.index]!,
      turnRadius: turnRadius[n.index]!,
    };
  });
  const links: LinkSeries[] = c.nodes
    .filter((n) => n.node.type === 'link')
    .map((n) => ({ node: n, id: n.id, presence: f32(), x: f32(), y: f32(), half: f32(), active: new Uint8Array(frames), flags: new Uint8Array(frames), width: n.width ? f32() : null }));
  const springs: SpringSeries[] = c.springs.map((index) => {
    const n = c.nodes[index]!;
    return { node: n, id: n.id, kind: n.springKind!, params: n.springParams!, restX: f32(), restY: f32(), x: f32(), y: f32() };
  });
  const camera = { x: new Float64Array(frames), y: new Float64Array(frames), zoom: new Float64Array(frames) };
  const perspectives: PerspectiveSeries[] = [];
  c.layers.forEach((layer, li) => {
    if (layer.persp && layer.persp.segs.length > 0) perspectives.push({ layer: li, id: layer.spec.id, slideX: f32(), slideY: f32(), round: f32(), tilt: f32(), grow: f32() });
  });
  const views: ViewSeries[] = c.layers.map(() => ({ zoom: new Float64Array(frames), tx: new Float64Array(frames), ty: new Float64Array(frames) }));

  // The bake, read through a source that also notes where each spring would rest.
  const poses: PoseSource = {
    body: (slot, frame) => ({ x: bake.bodyX(slot, frame), y: bake.bodyY(slot, frame), rot: bake.bodyRot(slot, frame) }),
    spring: (slot, frame, rest) => {
      const s = springs[slot]!;
      const x = bake.springX(slot, frame);
      const y = bake.springY(slot, frame);
      s.restX[frame] = rest[0];
      s.restY[frame] = rest[1];
      s.x[frame] = x;
      s.y[frame] = y;
      return [x, y];
    },
    // A swaying stick: the spring-driven point is its free end.
    sway: (slot, frame, pivot, rest, lever) => {
      const s = springs[slot]!;
      const x = bake.springX(slot, frame);
      const y = bake.springY(slot, frame);
      s.restX[frame] = pivot[0] + Math.cos(rest) * lever;
      s.restY[frame] = pivot[1] + Math.sin(rest) * lever;
      s.x[frame] = x;
      s.y[frame] = y;
      return swayDirection(x, y, pivot, rest);
    },
  };

  const drawn = new Uint8Array(N);
  const faint = new Uint8Array(N);
  const hides = c.covers.length > 0 || c.clips;
  // Raw rotations of the previous frame, to keep the series continuous across the wrap at 180 degrees.
  const prevRot = new Float64Array(N);
  const prevOwnRot = new Float64Array(N);
  const trigFrame = new Int32Array(N).fill(-1);
  const trigCos = new Float64Array(N);
  const trigSin = new Float64Array(N);
  // Length of the current run of frames in which a node's parent has no size.
  const gap = new Uint32Array(N);
  // A shot with a perspective layer: what lies in its planes, and for every node listed in such a layer where
  // it was in the space at the frame before, and what its own motion has come to (x, y, and the size its
  // distance gives it).
  const places = c.spatial ? newPlaces(c) : undefined;
  const before = new Float64Array(places ? 3 * N : 0);
  const ownAt = new Float64Array(places ? 3 * N : 0);
  // How far the points of a driven outline have travelled so far, in the layer's units.
  const formWay = new Float64Array(N);
  // Driven nodes above each end of a link, the end itself included: by link, by end.
  const drivers = links.map((l): number[][] =>
    [l.node.fromIndex, l.node.toIndex].map((end) => {
      const list: number[] = [];
      for (let k = end; k >= 0; k = c.nodes[k]!.parent) if (c.nodes[k]!.driven) list.push(k);
      return list;
    }),
  );
  const unwrap = (prev: number, prevRaw: number, raw: number): number => {
    const step = raw - prevRaw;
    if (step > -180 && step <= 180) return prev + step;
    let d = step % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return prev + d;
  };

  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    const world = computeWorld(c, f, poses, places);
    const cam = cameraAt(c.spec.camera, c.cameraNoise, f, frames, c.cameraTrack);
    camera.x[f] = cam.x;
    camera.y[f] = cam.y;
    camera.zoom[f] = cam.keyZoom === undefined ? cam.zoom : cam.zoom * cam.keyZoom;
    c.layers.forEach((layer, li) => {
      const v = layerView(cam, layer.parallax);
      views[li]!.zoom[f] = v.zoom;
      views[li]!.tx[f] = v.tx;
      views[li]!.ty[f] = v.ty;
    });
    const { own, alpha } = opacities(c, t);
    for (const p of perspectives) {
      if (f === 0) continue;
      const track = c.layers[p.layer]!.persp!;
      const now = perspAt(track, t);
      const was = perspAt(track, (f - 1) / FPS);
      const eye = eyeOf(now);
      const step: Vec3 = [now.aim[0] - was.aim[0], now.aim[1] - was.aim[1], now.aim[2] - was.aim[2]];
      const along = (axis: Vec3): number => step[0] * axis[0] + step[1] * axis[1] + step[2] * axis[2];
      const k = (now.lens / now.distance) * views[p.layer]!.zoom[f]!;
      p.slideX[f] = along(eye.right) * k;
      p.slideY[f] = along(eye.down) * k;
      p.round[f] = (now.turn - was.turn) * DEG * Math.cos(now.tilt * DEG);
      p.tilt[f] = (now.tilt - was.tilt) * DEG;
      // A camera that comes nearer makes the picture grow, as a longer lens does.
      p.grow[f] = now.lens / now.distance / (was.lens / was.distance) - 1 + along(eye.fwd) / now.distance;
    }

    // What is drawn: the rules of the evaluator.
    drawn.fill(0);
    for (const n of c.nodes) {
      const i = n.index;
      const node = n.node;
      faint[i] = own[i]! <= FAINT || (n.parent >= 0 && faint[n.parent] === 1) ? 1 : 0;
      if (faint[i]) continue;
      const xf = world[i]!;
      if (node.type === 'shape' || node.type === 'label' || node.type === 'text') drawn[i] = xf.scale > HIDDEN && (n.level === null || sampleLevel(n.level, t) > LEVEL_EMPTY) ? 1 : 0;
      else if (node.type === 'eye') drawn[i] = xf.scale > HIDDEN && (n.lid ? sampleLid(n.lid, t) : 1) > SHUT ? 1 : 0;
      else if (node.type === 'stroke') drawn[i] = xf.scale > HIDDEN && sampleDrawn(n.stroke!, t) > 1e-6 ? 1 : 0;
      // An outline that is worked out at each frame may have nothing to show: seen edge-on, or from a back that is not drawn.
      if (drawn[i] && n.form && formAt(n, t).hidden) drawn[i] = 0;
    }
    // What lies wholly behind a cover, or wholly outside the shape it is clipped to, is not seen.
    if (hides) markHidden(c, world, alpha, drawn, t);
    // A group is on screen while something in it is.
    for (let i = N - 1; i >= 0; i--) {
      const n = c.nodes[i]!;
      if (drawn[i] && n.parent >= 0 && c.nodes[n.parent]!.node.type === 'group') drawn[n.parent] = 1;
    }

    for (const n of c.nodes) {
      const s = placed[n.index];
      if (!s) continue;
      const i = n.index;
      const node = n.node;
      const xf = world[i]!;
      const view = views[n.layer]!;
      const zoom = view.zoom[f]!;
      if (s.still && f > 0) {
        // Only the camera changes anything for it: whether it is in frame.
        if (drawn[i]) {
          const sx = xf.x * zoom + view.tx[f]!;
          const sy = xf.y * zoom + view.ty[f]!;
          const r = s.radius * xf.scale * zoom;
          const inFrame = sx + r >= 0 && sy + r >= 0 && sx - r <= STAGE_W && sy - r <= STAGE_H;
          s.flags[f] = DRAWN | (inFrame ? IN_FRAME : 0);
        }
        s.unit[f] = n.parent >= 0 && node.type !== 'label' ? world[n.parent]!.scale * zoom : zoom;
        continue;
      }
      s.x[f] = xf.x;
      s.y[f] = xf.y;
      s.scale[f] = xf.scale;
      s.alpha[f] = alpha[i]!;
      s.ownAlpha[f] = own[i]!;
      const rawRot = xf.rot / DEG;
      // A globe: its turn is a turn of the node, as far round as its surface has gone, though the node itself is not turned.
      const turn = node.type === 'shape' && node.globe ? globeTurn(node.globe.spin, t) : 0;
      s.rot[f] = f === 0 ? rawRot + turn : unwrap(s.rot[f - 1]!, prevRot[i]!, rawRot + turn);
      prevRot[i] = rawRot + turn;

      // Own motion: relative to the parent (a label: to its target).
      let ownRaw = rawRot;
      if (node.type === 'label') {
        const target = world[n.targetIndex]!;
        s.ownX[f] = xf.x - target.x;
        s.ownY[f] = xf.y - target.y;
        s.ownScale[f] = xf.scale;
        s.unit[f] = zoom;
      } else if (places && n.persp && node.type !== 'link' && node.type !== 'emitter') {
        // Listed in a perspective layer: its own motion is what it does in the space, as the camera of
        // this frame sees it. What the camera does is judged on the camera.
        const eye = places.eyes[n.layer]!;
        const at: Vec3 = [places.point[3 * i]!, places.point[3 * i + 1]!, places.point[3 * i + 2]!];
        const now = project(eye, at);
        if (f === 0) {
          ownAt[3 * i] = now.x;
          ownAt[3 * i + 1] = now.y;
          ownAt[3 * i + 2] = 1;
        } else {
          const was = project(eye, [before[3 * i]!, before[3 * i + 1]!, before[3 * i + 2]!]);
          // While it is behind the camera it has no place on the layer, and no step.
          if (now.k > 0 && was.k > 0) {
            ownAt[3 * i] = ownAt[3 * i]! + now.x - was.x;
            ownAt[3 * i + 1] = ownAt[3 * i + 1]! + now.y - was.y;
            ownAt[3 * i + 2] = (ownAt[3 * i + 2]! * now.k) / was.k;
          }
        }
        before.set(at, 3 * i);
        s.ownX[f] = ownAt[3 * i]!;
        s.ownY[f] = ownAt[3 * i + 1]!;
        s.ownScale[f] = node.scale * (n.scale ? sampleScale(n.scale, t) : 1) * ownAt[3 * i + 2]!;
        s.unit[f] = zoom;
        // A group that lies in a plane: its turn in the plane, and the turns of its hinges.
        const flat = places.flat[i];
        if (flat) ownRaw = flat.rot / DEG + (n.hinge?.x ? sampleRot(n.hinge.x, t) : 0) + (n.hinge?.y ? sampleRot(n.hinge.y, t) : 0);
      } else if (n.parent >= 0) {
        const p = world[n.parent]!;
        // In a group that lies in a plane, a node moves in that plane.
        const inPlane = places !== undefined && n.plane >= 0;
        const me = inPlane ? places.flat[i] ?? xf : xf;
        const base = inPlane ? places.flat[n.parent] ?? p : p;
        if (n.springKind === 'follow') {
          // A follower lives in the layer's space: its spring pulls it toward a place, not along
          // with the parent's size or turn. Its own motion is its offset from the parent's origin.
          s.ownX[f] = me.x - base.x;
          s.ownY[f] = me.y - base.y;
          s.ownScale[f] = me.scale / Math.max(base.scale, 1e-9);
          s.unit[f] = inPlane ? (p.scale / Math.max(base.scale, 1e-9)) * zoom : zoom;
        } else if (p.scale <= HIDDEN || base.scale <= HIDDEN) {
          // The parent has no size: the node's place inside it is not defined. It is filled in below.
          gap[i] = gap[i]! + 1;
        } else {
          const dx = me.x - base.x;
          const dy = me.y - base.y;
          // The parent's turn is the same for all its children: its sine and cosine are worked out once per frame.
          if (trigFrame[n.parent] !== f) {
            trigFrame[n.parent] = f;
            trigCos[n.parent] = Math.cos(-base.rot);
            trigSin[n.parent] = Math.sin(-base.rot);
          }
          const cos = trigCos[n.parent]!;
          const sin = trigSin[n.parent]!;
          s.ownX[f] = (dx * cos - dy * sin) / base.scale;
          s.ownY[f] = (dx * sin + dy * cos) / base.scale;
          s.ownScale[f] = me.scale / base.scale;
          s.unit[f] = p.scale * zoom;
          // Frames without a parent size take the first values after them, so that no step appears where the parent pops in.
          for (let g = f - gap[i]!; g < f; g++) {
            s.ownX[g] = s.ownX[f]!;
            s.ownY[g] = s.ownY[f]!;
            s.ownScale[g] = s.ownScale[f]!;
          }
          gap[i] = 0;
        }
        // An upright group keeps its rotation in the layer's space: that is its own.
        if (!(node.type === 'group' && node.upright)) ownRaw = (me.rot - base.rot) / DEG;
        else if (inPlane) ownRaw = me.rot / DEG;
      } else {
        s.ownX[f] = xf.x;
        s.ownY[f] = xf.y;
        s.ownScale[f] = xf.scale;
        s.unit[f] = zoom;
      }
      ownRaw += turn;
      s.ownRot[f] = f === 0 ? ownRaw : unwrap(s.ownRot[f - 1]!, prevOwnRot[i]!, ownRaw);
      prevOwnRot[i] = ownRaw;

      if (s.open && n.lid) s.open[f] = sampleLid(n.lid, t) * eyeOpen(n.blinks, t);
      if (s.level) s.level[f] = levelGeometry(n, xf, t).y;
      if (s.shadow && n.rise) {
        s.shadow[f] = castLength(c, n) * Math.max(0, sampleRise(n.rise, t)) * xf.scale;
        // On the ground, the shadow is as long as the ground under it makes it.
        if (c.grounds) s.shadow[f] = s.shadow[f]! * groundShare(c, n, places, sampleRise(n.rise, t));
      }
      if (s.axis && n.axis) {
        const a = sampleAxis(n.axis, t);
        s.axis.sx[f] = a ? a.sx : 1;
        s.axis.sy[f] = a ? a.sy : 1;
      }
      if (s.life && (node.type === 'text' || node.type === 'label') && node.count && n.count) {
        // The number as it is shown: a change of its last place is a change on screen.
        const k = 10 ** node.count.decimals;
        s.life[f] = Math.round(sampleCount(n.count, t) * k) * 16;
      }
      if (s.life && node.type === 'stroke') {
        const length = pathTable(strokePathOf(n, t)).length;
        let life = (sampleDrawn(n.stroke!, t) + (node.dash ? sampleSolid(n.stroke!, t) : 0)) * length;
        // A light that runs along the line: where its head and its tail are.
        if (n.stroke!.pulses.length > 0) for (const p of sampleStrokePulses(n.stroke!, length, t)) life += p.head + p.tail;
        s.life[f] = life * xf.scale;
      }
      if (s.outline && n.outline) s.outline[f] = outlineTravel(n.outline, t) * xf.scale;
      if (s.outline && n.form?.drive) {
        // A driven outline: the way of its points, summed step by step at the size the node has at each.
        if (f > 0) formWay[i] = formWay[i]! + formStep(n.form, (f - 1) / FPS, t) * xf.scale;
        s.outline[f] = formWay[i]!;
      }
      if (s.width && n.width) s.width[f] = sampleWidth(n.width, t) * xf.scale;
      if (s.fill && n.fill && f > 0) s.fill[f] = fillStep(n.fill, (f - 1) / FPS, t);

      if (drawn[i]) {
        const sx = xf.x * zoom + view.tx[f]!;
        const sy = xf.y * zoom + view.ty[f]!;
        const r = s.radius * xf.scale * zoom;
        const inFrame = sx + r >= 0 && sy + r >= 0 && sx - r <= STAGE_W && sy - r <= STAGE_H;
        s.flags[f] = DRAWN | (inFrame ? IN_FRAME : 0);
      }
    }

    for (let li = 0; li < links.length; li++) {
      const s = links[li]!;
      const n = s.node;
      const from = world[n.fromIndex]!;
      const to = world[n.toIndex]!;
      const view = views[n.layer]!;
      const zoom = view.zoom[f]!;
      const half = Math.hypot(to.x - from.x, to.y - from.y) / 2;
      s.x[f] = (from.x + to.x) / 2;
      s.y[f] = (from.y + to.y) / 2;
      s.half[f] = half;
      if (s.width && n.width) s.width[f] = sampleWidth(n.width, t);
      const reveal = sampleReveal(n.link!, t);
      const isDrawn = own[n.index]! > FAINT && from.scale > HIDDEN && to.scale > HIDDEN && reveal > 0 && half > 0.5;
      if (!isDrawn) continue;
      s.presence[f] = alpha[n.index]! * reveal;
      const sx = s.x[f]! * zoom + view.tx[f]!;
      const sy = s.y[f]! * zoom + view.ty[f]!;
      const r = half * zoom;
      const inFrame = sx + r >= 0 && sy + r >= 0 && sx - r <= STAGE_W && sy - r <= STAGE_H;
      s.flags[f] = DRAWN | (inFrame ? IN_FRAME : 0);
      let active = reveal < 1;
      for (const p of n.link!.pulses) {
        if (p.at > t) break;
        if (pulseSpan(t, p.at, p.dur)) active = true;
      }
      // A bend that changes moves the middle of the line sideways.
      if (!active && n.link!.bends.length > 0 && n.node.type === 'link') {
        active = Math.abs(sampleBend(n.link!, n.node.bend, t) - sampleBend(n.link!, n.node.bend, t - 1 / FPS)) * 2 * half * zoom >= T.alivePx;
      }
      // A width that changes moves the edge of the line by half the change.
      if (!active && n.width) active = (Math.abs(sampleWidth(n.width, t) - sampleWidth(n.width, t - 1 / FPS)) / 2) * zoom >= T.alivePx;
      for (const end of drivers[li]!) {
        for (const k of end) {
          const d = placed[k]!;
          // A driven node with nothing in it is a place for links to hold on to: it is seen while one of them is.
          if (d.type === 'group' && d.radius <= 0) d.flags[f] = d.flags[f]! | s.flags[f]!;
          // A link moves with a driven node at its end.
          if (!active && f > 0) active = Math.hypot(d.ownX[f]! - d.ownX[f - 1]!, d.ownY[f]! - d.ownY[f - 1]!) * d.unit[f]! >= T.alivePx;
        }
      }
      s.active[f] = active ? 1 : 0;
    }
  }

  // What never changes was sampled at the first frame only.
  for (const s of placed) {
    if (!s || !s.still) continue;
    for (const a of [s.x, s.y, s.rot, s.scale, s.alpha, s.ownAlpha, s.ownX, s.ownY, s.ownRot, s.ownScale]) a.fill(a[0]!);
    if (s.open) s.open.fill(s.open[0]!);
    if (s.level) s.level.fill(s.level[0]!);
    if (s.life) s.life.fill(s.life[0]!);
    if (s.outline) s.outline.fill(s.outline[0]!);
  }

  // Particles: the bake keeps the velocity of every stored particle beside its place.
  const emitters: EmitterSeries[] = [];
  if (opts.particles !== false) {
    c.emitters.forEach((index, slot) => {
      const n = c.nodes[index]!;
      const view = views[n.layer]!;
      const s: EmitterSeries = {
        node: n,
        id: n.id,
        count: new Uint32Array(frames),
        fast: new Uint32Array(frames),
        medianRatio: f32(),
        medianSpeed: f32(),
        regions: new Uint8Array(frames),
      };
      const ratios: number[] = [];
      const speeds: number[] = [];
      // Streaks are as long, along their way, as their tails make them.
      const streak = n.node.type === 'emitter' && n.node.streak !== undefined;
      for (let f = 0; f < frames; f++) {
        const data = bake.particlesAt(slot, f);
        const vel = bake.velocitiesAt(slot, f);
        const tails = streak ? bake.tailsAt(slot, f) : null;
        const zoom = view.zoom[f]!;
        const tx = view.tx[f]!;
        const ty = view.ty[f]!;
        ratios.length = 0;
        speeds.length = 0;
        let fast = 0;
        let regions = 0;
        for (let i = 0, k = 0; i < data.length; i += PARTICLE_STRIDE, k += PARTICLE_VELOCITY_STRIDE) {
          const sx = data[i]! * zoom + tx;
          const sy = data[i + 1]! * zoom + ty;
          const pr = data[i + 2]! * zoom;
          if (sx + pr < 0 || sy + pr < 0 || sx - pr > STAGE_W || sy - pr > STAGE_H) continue;
          const speed = (Math.hypot(vel[k]!, vel[k + 1]!) / FPS) * zoom;
          const length = tails ? Math.hypot(tails[(k / PARTICLE_VELOCITY_STRIDE) * PARTICLE_TAIL_STRIDE]!, tails[(k / PARTICLE_VELOCITY_STRIDE) * PARTICLE_TAIL_STRIDE + 1]!) * zoom : 0;
          const ratio = speed / (2 * pr + length);
          ratios.push(ratio);
          speeds.push(speed);
          if (pr < 0.5) continue;
          if (ratio >= T.fastRatio && speed >= T.fastMinPx) fast++;
          if (speed >= T.alivePx) regions |= regionsOf(sx, sy, pr);
        }
        if (ratios.length === 0) continue;
        ratios.sort((x, y) => x - y);
        speeds.sort((x, y) => x - y);
        s.count[f] = ratios.length;
        s.fast[f] = fast;
        s.medianRatio[f] = median(ratios);
        s.medianSpeed[f] = median(speeds);
        s.regions[f] = regions;
      }
      emitters.push(s);
    });
  }

  // Heat hazes: their ripples drift through the outline of their shape, wherever that is.
  const hazes: HazeSeries[] = [];
  for (const n of c.nodes) {
    const s = placed[n.index];
    if (!n.haze || !s || n.node.type !== 'shape' || !n.node.haze) continue;
    const { speed, scale } = n.node.haze;
    const soft = n.node.soft ?? 0;
    const view = views[n.layer]!;
    // A point under a ripple of size d that drifts v a frame moves by up to 2 pi v / d times the amount.
    const drift = Math.min(2, (4 * Math.PI * speed) / (FPS * scale));
    const h: HazeSeries = { node: n, id: n.id, amount: f32(), shimmer: f32(), step: f32(), ratio: (2 * speed) / (FPS * scale), regions: new Uint8Array(frames) };
    for (let f = 0; f < frames; f++) {
      const zoom = view.zoom[f]!;
      h.step[f] = (speed / FPS) * zoom;
      const amount = sampleLevel(n.haze.amount, f / FPS);
      if (amount <= 1e-4 || s.scale[f]! <= HIDDEN) continue;
      const regions = regionsOf(s.x[f]! * zoom + view.tx[f]!, s.y[f]! * zoom + view.ty[f]!, (s.radius + soft) * s.scale[f]! * zoom);
      if (regions === 0) continue;
      h.amount[f] = amount * zoom;
      h.shimmer[f] = amount * zoom * drift;
      if (h.shimmer[f]! >= T.alivePx) h.regions[f] = regions;
    }
    hazes.push(h);
  }
  // Pulls of focus: the blur of a layer, as the picture shows it at the zoom of the layer.
  const focus: FocusSeries[] = [];
  c.layers.forEach((layer, li) => {
    if (!layer.focus) return;
    const step = f32();
    for (let f = 1; f < frames; f++) step[f] = (sampleRise(layer.focus, f / FPS) - sampleRise(layer.focus, (f - 1) / FPS)) * views[li]!.zoom[f]!;
    focus.push({ layer: li, id: layer.spec.id, step });
  });
  const more = { ...(perspectives.length > 0 ? { perspectives } : {}), ...(hazes.length > 0 ? { hazes } : {}), ...(focus.length > 0 ? { focus } : {}) };

  if (c.backgroundTrack) {
    const background = f32();
    for (let f = 1; f < frames; f++) background[f] = backgroundStep(c.backgroundTrack, (f - 1) / FPS, f / FPS);
    return { shot: c, frames, lang, camera, views, placed, links, emitters, springs, background, ...more };
  }
  return { shot: c, frames, lang, camera, views, placed, links, emitters, springs, ...more };
}

/** Place of a node on screen at a frame, in px of a 1080p frame. */
export function screenAt(series: MotionSeries, s: PlacedSeries, f: number): [number, number] {
  const v = series.views[s.node.layer]!;
  return [s.x[f]! * v.zoom[f]! + v.tx[f]!, s.y[f]! * v.zoom[f]! + v.ty[f]!];
}

/** True when the node is drawn at the frame and clear enough for its motion to be judged. */
export function visibleAt(s: PlacedSeries, f: number): boolean {
  return (s.flags[f]! & DRAWN) !== 0 && s.alpha[f]! >= T.visibleAlpha;
}
