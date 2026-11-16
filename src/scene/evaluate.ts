// Evaluating a shot at a frame: a pure function of the compiled shot, the bake,
// the frame number and the language. The result is a display list the renderer
// draws without further decisions.

import { cameraAt, layerView, type CameraState, type LayerView } from '../camera/camera.ts';
import { DEG, quadSub, vrot, xfCompose, XF_IDENTITY, type Quad, type Vec2, type Xf } from '../core/math.ts';
import { FPS } from '../core/time.ts';
import { pulseSpan } from '../motion/curves.ts';
import { pathTable, type PathSpec } from '../motion/paths.ts';
import {
  sampleAxis,
  sampleBend,
  sampleCount,
  sampleDrawn,
  sampleLevel,
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
} from '../motion/tracks.ts';
import type { Bake } from '../physics/cache.ts';
import { outlineOf, reach, type ShapeSpec } from '../shape/geometry.ts';
import { textBlock, type TextBlock } from '../text/block.ts';
import { COUNT_MARK, countRuns, countSlot, formatCount, widestCount, type CountSlot } from '../text/count.ts';
import { labelGeometry, LABEL_PROPORTIONS, type LabelGeometry } from '../text/label.ts';
import { layoutText, type TextLayout } from '../text/layout.ts';
import { resolveString } from '../text/strings.ts';
import { sampleBackground, type BackgroundState } from './background.ts';
import { BLINK, type CLayer, type CNode, type CompiledShot } from './compile.ts';
import { regionAt, strokePathAt } from './outline.ts';
import type { LabelSide } from './types.ts';

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

/** The shape of a shape node at time t: the one it was given, or what its reshape keys have made of it by then. */
export function shapeOf(n: CNode, t: number): ShapeSpec {
  if (n.node.type !== 'shape') throw new Error(`"${n.id}" is not a shape`);
  return n.outline ? regionAt(n.outline, t) : n.node.shape;
}

/** The path of a stroke at time t: the one it was given, or what its reshape keys have made of it by then. */
export function strokePathOf(n: CNode, t: number): PathSpec {
  if (n.node.type !== 'stroke') throw new Error(`"${n.id}" is not a stroke`);
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
 * World transforms of all nodes at a frame, in the space of their layer.
 * For a label the transform holds the tip of its tail and its pop scale.
 * Nodes without a place of their own (links, emitters) get the identity.
 */
export function computeWorld(c: CompiledShot, frame: number, poses: PoseSource): Xf[] {
  const t = frame / FPS;
  const out: Xf[] = new Array<Xf>(c.nodes.length).fill(XF_IDENTITY);
  // The children of a shape with a level ride on its surface: their frame is the middle of the surface.
  let surfaces: Map<number, Xf> | null = null;

  for (const n of c.nodes) {
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
    const parent = n.parent >= 0 ? surfaces?.get(n.parent) ?? out[n.parent]! : XF_IDENTITY;
    // A travel may turn the node: it rolls along its path, or faces along it.
    const rot = (n.pos!.turns ? sampleRot(n.rot!, t) + samplePathTurn(n.pos!, t) : sampleRot(n.rot!, t)) * DEG;
    let xf = xfCompose(parent, { x, y, rot, scale });
    // An upright group keeps its own rotation, whatever it is attached to.
    if (node.type === 'group' && node.upright) xf = { ...xf, rot };
    if (n.springKind === 'follow') {
      const p = poses.spring(n.springSlot, frame, [xf.x, xf.y]);
      xf = { ...xf, x: p[0], y: p[1] };
    } else if (n.springKind === 'sway' && node.type === 'shape' && node.shape.kind === 'capsule') {
      // The stick keeps its first end and its length; the spring only turns it.
      const lever = (node.shape.length - 2 * node.shape.r) * Math.max(xf.scale, 0.05);
      xf = { ...xf, rot: poses.sway(n.springSlot, frame, [xf.x, xf.y], xf.rot, lever, xf.scale > HIDDEN) };
    }
    out[n.index] = xf;
    if (n.level && n.subtreeEnd > n.index) {
      const g = levelGeometry(n, xf, t);
      (surfaces ??= new Map<number, Xf>()).set(n.index, { x: g.cx, y: g.y, rot: xf.rot, scale: xf.scale });
    }
  }

  for (const n of c.nodes) {
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
  /** A region whose outline is keyed (reshape): the shape it has at this frame. Left out: the shape of its node. */
  readonly shape?: ShapeSpec;
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
}

export interface TextItem {
  readonly kind: 'text';
  readonly node: CNode;
  readonly xf: Xf;
  readonly alpha: number;
  readonly block: TextBlock;
  readonly layout: TextLayout;
  /** What is drawn at this frame: pieces of text, each with the x of its middle and the y of its baseline. For a counter: the line with its number as it is now. */
  readonly lines: readonly { readonly text: string; readonly x: number; readonly y: number }[];
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
}

export interface ParticlesItem {
  readonly kind: 'particles';
  readonly node: CNode;
  /** x, y, radius, colour index per particle. */
  readonly data: Float32Array;
}

/**
 * A node that is not fully opaque, together with everything inside it. The
 * renderer draws the items into one picture and composites that picture at
 * `opacity`, so overlapping parts do not show through each other. Groups nest:
 * opacity multiplies down the tree.
 */
export interface GroupItem {
  readonly kind: 'group';
  readonly node: CNode;
  readonly opacity: number;
  readonly items: readonly Item[];
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

export type Item = ShapeItem | EyeItem | LinkItem | LabelItem | ParticlesItem | StrokeItem | TextItem | GroupItem | ClipItem | StretchItem;
export type LeafItem = Exclude<Item, GroupItem | ClipItem | StretchItem>;

/** All items of a list with the groups, clips and stretches opened up, in draw order. */
export function flatItems(items: readonly Item[], out: LeafItem[] = []): LeafItem[] {
  for (const item of items) {
    if (item.kind === 'group' || item.kind === 'clip' || item.kind === 'stretch') flatItems(item.items, out);
    else out.push(item);
  }
  return out;
}

export interface LayerState {
  readonly layer: CLayer;
  readonly view: LayerView;
  readonly items: readonly Item[];
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

const labelCache = new WeakMap<CompiledShot, Map<string, { layout: TextLayout; geometry: LabelGeometry }>>();

/** Layout and geometry of a label in a language (cached; the result depends on nothing else). */
export function labelLayout(c: CompiledShot, n: CNode, lang: string): { layout: TextLayout; geometry: LabelGeometry } {
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
    const layout = layoutText(resolveString(c.spec.strings, lang, node.text), {
      size: node.size,
      minSize: node.minSize,
      weight: LABEL_PROPORTIONS.weight,
      maxWidth: node.maxWidth,
      maxLines: node.maxLines,
    });
    hit = { layout, geometry: labelGeometry(layout, node.side) };
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
    let widest: string | null = null;
    if (node.count && n.count) {
      // Every value the counter starts from or is sent to; what lies between them is never wider.
      widest = widestCount([n.count.base, ...n.count.segs.map((s) => s.to)], node.count.decimals, lang, node.size, node.weight);
      words = words.replace(COUNT_MARK, widest);
    }
    const layout = layoutText(words, style);
    hit = { layout, block: textBlock(layout, node.align, node.box !== null), slot: widest === null ? null : countSlot(layout, widest) };
    cache.set(key, hit);
  }
  return hit;
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
    if (item.kind !== 'group' && item.kind !== 'clip' && item.kind !== 'stretch') out.push(item);
    else {
      const inner = prune(item.items);
      if (inner.length > 0) out.push({ ...item, items: inner });
    }
  }
  return out;
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
  for (const n of c.nodes) {
    own[n.index] = n.opacity ? sampleOpacity(n.opacity, t) : 1;
    // Not drawn at all: a node that shows only while it travels, outside its travel; a body that waits for its release.
    if ((n.pos !== null && n.pos.onlyWhile && !sampleTravelling(n.pos, t)) || (n.bodySlot >= 0 && awaitsRelease(n, t))) own[n.index] = 0;
    alpha[n.index] = own[n.index]! * (n.parent >= 0 ? alpha[n.parent]! : 1);
  }
  for (const n of c.nodes) {
    if (n.node.type !== 'link') continue;
    own[n.index] = own[n.index]! * Math.min(alpha[n.fromIndex]!, alpha[n.toIndex]!);
    alpha[n.index] = own[n.index]!;
  }
  return { own, alpha };
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
  const world = computeWorld(c, frame, posesFromBake(bake));
  const camera = cameraAt(c.spec.camera, c.cameraNoise, frame, c.frames, c.cameraTrack);

  const { own, alpha } = opacities(c, t);

  // A region whose outline is keyed carries the shape it has at this frame; any other item is what it always was.
  const reshaped = (n: CNode): { shape?: ShapeSpec } => (n.outline ? { shape: shapeOf(n, t) } : {});

  const layers = c.layers.map((layer): LayerState => {
    const root: Item[] = [];
    // Open groups: the items of a faded node and of its subtree go into its group.
    const open: { end: number; items: Item[] }[] = [];
    let skipUntil = -1;
    for (const index of layer.nodes) {
      if (index <= skipUntil) continue;
      while (open.length > 0 && index > open[open.length - 1]!.end) open.pop();
      const n = c.nodes[index]!;
      const node = n.node;
      const xf = world[index]!;
      const a = alpha[index]!;
      if (own[index]! <= FAINT) {
        // Invisible, and so is everything inside it.
        skipUntil = n.subtreeEnd;
        continue;
      }
      let items = open.length > 0 ? open[open.length - 1]!.items : root;
      if (n.clipIndex >= 0) {
        // Drawn only inside the outline of a shape. Neighbours clipped to the same shape share one clip.
        const clipNode = c.nodes[n.clipIndex]!;
        const last = items[items.length - 1];
        let inner: Item[];
        if (last && last.kind === 'clip' && last.node === clipNode) {
          inner = last.items as Item[];
        } else if (clipNode.level) {
          // Clipped to a content: only its filled part holds anything.
          const g = levelGeometry(clipNode, world[n.clipIndex]!, t);
          if (g.level <= LEVEL_EMPTY) {
            skipUntil = n.subtreeEnd;
            continue;
          }
          inner = [];
          if (g.level < 1 - 1e-6) items.push({ kind: 'clip', node: clipNode, xf: world[n.clipIndex]!, level: levelClip(g), ...reshaped(clipNode), items: inner });
          else items.push({ kind: 'clip', node: clipNode, xf: world[n.clipIndex]!, ...reshaped(clipNode), items: inner });
        } else {
          inner = [];
          items.push({ kind: 'clip', node: clipNode, xf: world[n.clipIndex]!, ...reshaped(clipNode), items: inner });
        }
        open.push({ end: n.subtreeEnd, items: inner });
        items = inner;
      }
      if (n.axis && xf.scale > HIDDEN) {
        // Its width and its height were changed: everything in it is drawn through that change.
        const s = sampleAxis(n.axis, t);
        if (s) {
          const inner: Item[] = [];
          items.push({ kind: 'stretch', node: n, at: [xf.x, xf.y], height: 1, axes: { rot: xf.rot, scale: xf.scale, ...s }, items: inner });
          open.push({ end: n.subtreeEnd, items: inner });
          items = inner;
        }
      }
      if (n.stretch) {
        const s = sampleStretch(n.stretch, t);
        if (s) {
          const inner: Item[] = [];
          // The pivot is measured from the node's origin in the layer's directions, in the node's units.
          items.push({ kind: 'stretch', node: n, at: [xf.x + s.pivot[0] * xf.scale, xf.y + s.pivot[1] * xf.scale], height: s.height, items: inner });
          open.push({ end: n.subtreeEnd, items: inner });
          items = inner;
        }
      }
      if (own[index]! < OPAQUE) {
        const group: Item[] = [];
        items.push({ kind: 'group', node: n, opacity: own[index]!, items: group });
        open.push({ end: n.subtreeEnd, items: group });
        items = group;
      }
      switch (node.type) {
        case 'group':
          break;
        case 'shape':
          if (xf.scale <= HIDDEN) break;
          if (n.level) {
            // A content: nothing of it while it is empty, all of it when it is full, else the part below its surface.
            const g = levelGeometry(n, xf, t);
            if (g.level <= LEVEL_EMPTY) break;
            if (g.level < 1 - 1e-6) {
              items.push({ kind: 'shape', node: n, xf, alpha: a, level: levelClip(g), ...reshaped(n) });
              break;
            }
          }
          items.push({ kind: 'shape', node: n, xf, alpha: a, ...reshaped(n) });
          break;
        case 'eye': {
          if (xf.scale <= HIDDEN) break;
          const lid = n.lid ? sampleLid(n.lid, t) : 1;
          if (lid <= SHUT) break;
          let look: Vec2 = [0, 0];
          if (n.lookAtIndex >= 0) {
            const target = world[n.lookAtIndex]!;
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
            const number = formatCount(sampleCount(n.count, t), node.count.decimals, lang);
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
          // A stroke without a pulse is the item it always was.
          const pulses = n.stroke!.pulses.length > 0 ? sampleStrokePulses(n.stroke!, pathTable(strokePathOf(n, t)).length, t) : [];
          items.push({ kind: 'stroke', node: n, xf, alpha: a, drawn: Math.min(1, drawn), solid: node.dash ? sampleSolid(n.stroke!, t) : 1, ...(pulses.length > 0 ? { pulses } : {}), ...(n.outline ? { path: strokePathOf(n, t) } : {}) });
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
          items.push({ kind: 'link', node: n, curve, reveal, pulses, alpha: a });
          break;
        }
        case 'label': {
          if (xf.scale <= HIDDEN) break;
          const { layout, geometry } = labelLayout(c, n, lang);
          items.push({ kind: 'label', node: n, tip: [xf.x, xf.y], scale: xf.scale, geometry, layout, alpha: a });
          break;
        }
        case 'emitter': {
          const data = bake.particlesAt(n.emitterSlot, frame);
          if (data.length > 0) items.push({ kind: 'particles', node: n, data });
          break;
        }
      }
    }
    return { layer, view: layerView(camera, layer.parallax), items: prune(root) };
  });

  // A shot whose background is not keyed is the state it always was.
  if (c.backgroundTrack) return { frame, time: t, lang, camera, layers, background: sampleBackground(c.backgroundTrack, t) };
  return { frame, time: t, lang, camera, layers };
}
