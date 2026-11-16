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
import { DEG, xfApply, type Vec2, type Xf } from '../core/math.ts';
import { FPS } from '../core/time.ts';
import { pulseSpan } from '../motion/curves.ts';
import { pathTable } from '../motion/paths.ts';
import { sampleAxis, sampleBend, sampleCount, sampleDrawn, sampleLevel, sampleLid, sampleReveal, sampleSolid, sampleStrokePulses } from '../motion/tracks.ts';
import { PARTICLE_STRIDE, PARTICLE_VELOCITY_STRIDE, type Bake } from '../physics/cache.ts';
import { backgroundStep } from '../scene/background.ts';
import type { CNode, CompiledShot } from '../scene/compile.ts';
import {
  computeWorld,
  eyeOpen,
  FAINT,
  HIDDEN,
  labelLayout,
  LEVEL_EMPTY,
  levelGeometry,
  textLayout,
  opacities,
  SHUT,
  swayDirection,
  type PoseSource,
} from '../scene/evaluate.ts';
import { STAGE_H, STAGE_W } from '../scene/types.ts';
import { outlineOf, shapeExtent } from '../shape/geometry.ts';
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
   * the layer's units, because that is the space such a node moves in.
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
  /** 1 while a pulse travels along it, it is being drawn on, or its bend changes. */
  readonly active: Uint8Array;
  readonly flags: Uint8Array;
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

function insidePolygon(poly: readonly Vec2[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}




/**
 * Clears `drawn` for shapes and eyes that cannot be seen at this frame: every
 * one of nine points of the node (its middle and eight on its edge) lies under
 * a cover drawn after it, or outside the shape the node is clipped to. A node
 * that shows at one point is still seen.
 */
function markHidden(c: CompiledShot, world: readonly Xf[], alpha: Float64Array, drawn: Uint8Array): void {
  const polys = new Map<number, { poly: Vec2[]; x0: number; y0: number; x1: number; y1: number }>();
  const polyOf = (index: number): { poly: Vec2[]; x0: number; y0: number; x1: number; y1: number } => {
    let hit = polys.get(index);
    if (!hit) {
      const node = c.nodes[index]!.node;
      const poly = node.type === 'shape' ? outlineOf(node.shape).map((p) => xfApply(world[index]!, p)) : [];
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
    const xf = world[i]!;
    const points: Vec2[] = [];
    if (node.type === 'shape') {
      const { center } = shapeExtent(node.shape);
      const ring = outlineOf(node.shape);
      points.push(xfApply(xf, center));
      for (let k = 0; k < 8; k++) points.push(xfApply(xf, ring[Math.floor((k * ring.length) / 8)]!));
    } else {
      points.push([xf.x, xf.y]);
      for (let k = 0; k < 8; k++) points.push([xf.x + Math.cos((k * Math.PI) / 4) * node.r * xf.scale, xf.y + Math.sin((k * Math.PI) / 4) * node.r * xf.scale]);
    }
    // The shapes this node is clipped to: its own and those of everything it is in.
    const clips: number[] = [];
    for (let k = i; k >= 0; k = c.nodes[k]!.parent) if (c.nodes[k]!.clipIndex >= 0) clips.push(c.nodes[k]!.clipIndex);
    const later = covers.filter((ci) => ci > n.subtreeEnd && c.nodes[ci]!.layer === n.layer);
    if (clips.length === 0 && later.length === 0) continue;
    let seen = false;
    for (const p of points) {
      let hidden = false;
      for (const ci of clips) {
        if (!insidePolygon(polyOf(ci).poly, p[0], p[1])) {
          hidden = true;
          break;
        }
      }
      for (let k = 0; !hidden && k < later.length; k++) {
        const cover = polyOf(later[k]!);
        if (p[0] < cover.x0 || p[0] > cover.x1 || p[1] < cover.y0 || p[1] > cover.y1) continue;
        hidden = insidePolygon(cover.poly, p[0], p[1]);
      }
      if (!hidden) {
        seen = true;
        break;
      }
    }
    if (!seen) drawn[i] = 0;
  }
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
      const ext = shapeExtent(node.shape);
      radius[n.index] = Math.hypot(ext.center[0], ext.center[1]) + ext.outer;
      turnRadius[n.index] = node.shape.kind === 'circle' ? 0 : radius[n.index]!;
    } else if (node.type === 'eye') {
      radius[n.index] = node.r;
    } else if (node.type === 'stroke') {
      // The farthest point of the line from its origin, with half its width.
      const table = pathTable(node.path);
      let far = 0;
      for (let i = 0; i < table.xs.length; i++) far = Math.max(far, Math.hypot(table.xs[i]!, table.ys[i]!));
      radius[n.index] = far + node.width / 2;
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
    const offset = Math.hypot(node.at[0], node.at[1]);
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
      radius: radius[n.index]!,
      turnRadius: turnRadius[n.index]!,
    };
  });
  const links: LinkSeries[] = c.nodes
    .filter((n) => n.node.type === 'link')
    .map((n) => ({ node: n, id: n.id, presence: f32(), x: f32(), y: f32(), half: f32(), active: new Uint8Array(frames), flags: new Uint8Array(frames) }));
  const springs: SpringSeries[] = c.springs.map((index) => {
    const n = c.nodes[index]!;
    return { node: n, id: n.id, kind: n.springKind!, params: n.springParams!, restX: f32(), restY: f32(), x: f32(), y: f32() };
  });
  const camera = { x: new Float64Array(frames), y: new Float64Array(frames), zoom: new Float64Array(frames) };
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
    const world = computeWorld(c, f, poses);
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
    }
    // What lies wholly behind a cover, or wholly outside the shape it is clipped to, is not seen.
    if (hides) markHidden(c, world, alpha, drawn);
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
      s.rot[f] = f === 0 ? rawRot : unwrap(s.rot[f - 1]!, prevRot[i]!, rawRot);
      prevRot[i] = rawRot;

      // Own motion: relative to the parent (a label: to its target).
      let ownRaw = rawRot;
      if (node.type === 'label') {
        const target = world[n.targetIndex]!;
        s.ownX[f] = xf.x - target.x;
        s.ownY[f] = xf.y - target.y;
        s.ownScale[f] = xf.scale;
        s.unit[f] = zoom;
      } else if (n.parent >= 0) {
        const p = world[n.parent]!;
        if (n.springKind === 'follow') {
          // A follower lives in the layer's space: its spring pulls it toward a place, not along
          // with the parent's size or turn. Its own motion is its offset from the parent's origin.
          s.ownX[f] = xf.x - p.x;
          s.ownY[f] = xf.y - p.y;
          s.ownScale[f] = xf.scale / Math.max(p.scale, 1e-9);
          s.unit[f] = zoom;
        } else if (p.scale <= HIDDEN) {
          // The parent has no size: the node's place inside it is not defined. It is filled in below.
          gap[i] = gap[i]! + 1;
        } else {
          const dx = xf.x - p.x;
          const dy = xf.y - p.y;
          // The parent's turn is the same for all its children: its sine and cosine are worked out once per frame.
          if (trigFrame[n.parent] !== f) {
            trigFrame[n.parent] = f;
            trigCos[n.parent] = Math.cos(-p.rot);
            trigSin[n.parent] = Math.sin(-p.rot);
          }
          const cos = trigCos[n.parent]!;
          const sin = trigSin[n.parent]!;
          s.ownX[f] = (dx * cos - dy * sin) / p.scale;
          s.ownY[f] = (dx * sin + dy * cos) / p.scale;
          s.ownScale[f] = xf.scale / p.scale;
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
        if (!(node.type === 'group' && node.upright)) ownRaw = (xf.rot - p.rot) / DEG;
      } else {
        s.ownX[f] = xf.x;
        s.ownY[f] = xf.y;
        s.ownScale[f] = xf.scale;
        s.unit[f] = zoom;
      }
      s.ownRot[f] = f === 0 ? ownRaw : unwrap(s.ownRot[f - 1]!, prevOwnRot[i]!, ownRaw);
      prevOwnRot[i] = ownRaw;

      if (s.open && n.lid) s.open[f] = sampleLid(n.lid, t) * eyeOpen(n.blinks, t);
      if (s.level) s.level[f] = levelGeometry(n, xf, t).y;
      if (s.axis && n.axis) {
        const a = sampleAxis(n.axis, t);
        s.axis.sx[f] = a ? a.sx : 1;
        s.axis.sy[f] = a ? a.sy : 1;
      }
      if (s.life && node.type === 'text' && node.count && n.count) {
        // The number as it is shown: a change of its last place is a change on screen.
        const k = 10 ** node.count.decimals;
        s.life[f] = Math.round(sampleCount(n.count, t) * k) * 16;
      }
      if (s.life && node.type === 'stroke') {
        const length = pathTable(node.path).length;
        let life = (sampleDrawn(n.stroke!, t) + (node.dash ? sampleSolid(n.stroke!, t) : 0)) * length;
        // A light that runs along the line: where its head and its tail are.
        if (n.stroke!.pulses.length > 0) for (const p of sampleStrokePulses(n.stroke!, length, t)) life += p.head + p.tail;
        s.life[f] = life * xf.scale;
      }

      if (drawn[i]) {
        const sx = xf.x * zoom + view.tx[f]!;
        const sy = xf.y * zoom + view.ty[f]!;
        const r = s.radius * xf.scale * zoom;
        const inFrame = sx + r >= 0 && sy + r >= 0 && sx - r <= STAGE_W && sy - r <= STAGE_H;
        s.flags[f] = DRAWN | (inFrame ? IN_FRAME : 0);
      }
    }

    for (const s of links) {
      const n = s.node;
      const from = world[n.fromIndex]!;
      const to = world[n.toIndex]!;
      const view = views[n.layer]!;
      const zoom = view.zoom[f]!;
      const half = Math.hypot(to.x - from.x, to.y - from.y) / 2;
      s.x[f] = (from.x + to.x) / 2;
      s.y[f] = (from.y + to.y) / 2;
      s.half[f] = half;
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
      for (let f = 0; f < frames; f++) {
        const data = bake.particlesAt(slot, f);
        const vel = bake.velocitiesAt(slot, f);
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
          const ratio = speed / (2 * pr);
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

  if (c.backgroundTrack) {
    const background = f32();
    for (let f = 1; f < frames; f++) background[f] = backgroundStep(c.backgroundTrack, (f - 1) / FPS, f / FPS);
    return { shot: c, frames, lang, camera, views, placed, links, emitters, springs, background };
  }
  return { shot: c, frames, lang, camera, views, placed, links, emitters, springs };
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
