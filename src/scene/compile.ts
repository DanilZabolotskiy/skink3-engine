// Compiles a shot description into the form the evaluator, the bake and the
// renderer work with: a flat node list in draw order, resolved references and
// colours, per-node tracks built from the timeline, and slots in the bake.
// Compiling also validates the shot as a whole.

import { springParams, type SpringParams } from '../core/dynamics.ts';
import { buildCameraTrack, type CameraTrack } from '../camera/camera.ts';
import { hashOf } from '../core/hash.ts';
import type { Vec2 } from '../core/math.ts';
import { Noise } from '../core/noise.ts';
import { buildDriveTrack, type DriveSeg, type DriveTrack } from '../motion/drive.ts';
import { Rng } from '../core/rng.ts';
import { frameCount } from '../core/time.ts';
import { HIGHLIGHT_HUE, SHADOW_HUE } from '../look/color.ts';
import { lightVector } from '../look/light.ts';
import { resolveColor, toneHues, type Palette, type ToneHues } from '../look/palette.ts';
import { PULSE_BUMP } from '../motion/intents.ts';
import type {
  BackgroundToKey,
  BendToKey,
  BlurToKey,
  BumpKey,
  CameraToKey,
  CountToKey,
  DrawOnKey,
  DriveKey,
  FadeToKey,
  FillToKey,
  ColorToKey,
  HazeToKey,
  RateToKey,
  HopKey,
  Key,
  LevelToKey,
  MoveToKey,
  OpenToKey,
  PerspectiveToKey,
  PopInKey,
  PopOutKey,
  PulseKey,
  ReshapeKey,
  RiseToKey,
  ScaleToKey,
  SolidToKey,
  SquashKey,
  TravelKey,
  TurnToKey,
  WidthToKey,
  ZoomToKey,
} from '../motion/intents.ts';
import {
  buildAwayTrack,
  buildAxisTrack,
  buildCountTrack,
  buildLevelTrack,
  buildLidTrack,
  buildLinkTrack,
  buildOpacityTrack,
  buildPosTrack,
  buildRiseTrack,
  buildRotTrack,
  buildScaleTrack,
  buildStretchTrack,
  buildStrokeTrack,
  buildWidthTrack,
  type AwayTrack,
  type AxisTrack,
  type CountTrack,
  type LevelTrack,
  type LidTrack,
  type LinkTrack,
  type OpacityTrack,
  type PosTrack,
  type RiseTrack,
  type RotTrack,
  type ScaleTrack,
  type StretchTrack,
  type StrokeTrack,
  type WidthTrack,
} from '../motion/tracks.ts';
import { COUNT_MARK } from '../text/count.ts';
import { isRegion } from '../shape/geometry.ts';
import { buildBackgroundTrack, type BackgroundTrack } from './background.ts';
import { buildFillTrack, type FillTrack } from './fill.ts';
import type { FormTrack } from './form.ts';
import { buildOutlineTrack, type OutlineTrack } from './outline.ts';
import { buildPerspTrack, type PerspTrack } from './space.ts';
import { parseRuns, RUN_CLOSE, RUN_OPEN, RunMarkupError } from '../text/runs.ts';
import { resolveString, type StringTables } from '../text/strings.ts';
import { CAMERA_SUBJECT, FINDING_KINDS_ALL, FRAME_REGIONS, FRAME_SUBJECT, LINK_MAX_WIDTH, type GlobeSpec, type LayerSpec, type SceneNode, type ShapeNode, type ShotSpec } from './types.ts';

export class CompileError extends Error {}

export interface CNode {
  /** Internal display view of a dense plane whose text is composited separately. */
  readonly pictureScale?: number;
  readonly index: number;
  readonly id: string;
  readonly node: SceneNode;
  readonly layer: number;
  /** Index of the parent node, or -1 for a top-level node. */
  readonly parent: number;
  /** Index of the last node of this node's subtree (its own index if it has no children). */
  readonly subtreeEnd: number;
  /** Opacity over time; null for a node that has none (an emitter without an opacity or a fadeTo of its own). */
  readonly opacity: OpacityTrack | null;
  readonly pos: PosTrack | null;
  readonly rot: RotTrack | null;
  readonly scale: ScaleTrack | null;
  readonly link: LinkTrack | null;
  /** Eyes: how far the lids are open over time. */
  readonly lid: LidTrack | null;
  /** Shapes with a level: how full they are over time. */
  readonly level: LevelTrack | null;
  /** Squashes and stretches, or null when the node has none. */
  readonly stretch: StretchTrack | null;
  /** Lasting changes of size along its own axes, or null when the node has none. */
  readonly axis: AxisTrack | null;
  /** Counters: the number over time. */
  readonly count: CountTrack | null;
  /** Strokes: how much of the line is drawn and how far its dashes are closed, over time. */
  readonly stroke: StrokeTrack | null;
  /** Regions and strokes with a reshape: their outline over time; null for a node that keeps the outline it was given. */
  readonly outline: OutlineTrack | null;
  /** Links and strokes with a widthTo: their width over time; null for a line that keeps the width it was given. */
  readonly width: WidthTrack | null;
  /** Shapes and strokes with a rise: the height of the body over time; null for a node that lies flat. */
  readonly rise: RiseTrack | null;
  /**
   * Shapes with a fillTo and lines (strokes, links) with a colorTo: the colour they are drawn in over time, a shape's
   * fill or a line's colour; null for a node that keeps the colour it was given.
   */
  readonly fill: FillTrack | null;
  /** Shapes with a haze: its amount over time (hazeTo), and the noise of its ripples; null for every other node. */
  readonly haze: { readonly amount: RiseTrack; readonly noise: Noise } | null;
  /** An emitter with a rateTo: its rate over time, in particles per second. Left out: it keeps the rate it was given. */
  readonly rate?: RiseTrack;
  /** Index of the shape this node is clipped to, or -1. */
  readonly clipIndex: number;
  /** Slot in the bake, or -1. */
  readonly bodySlot: number;
  readonly springSlot: number;
  readonly emitterSlot: number;
  readonly springKind: 'follow' | 'sway' | null;
  readonly springParams: SpringParams | null;
  /** Indices of the nodes this one refers to, or -1. */
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly targetIndex: number;
  readonly lookAtIndex: number;
  readonly attachIndex: number;
  /** Resolved colours (hex) by the name of the property that holds the reference. */
  readonly colors: Readonly<Record<string, string>>;
  /** Emitters: resolved particle colours. */
  readonly particleColors: readonly string[];
  /** Idle wandering noise, if the node has `idle`. */
  readonly idleNoise: Noise | null;
  /** Eyes: the moments (seconds) a blink starts, scheduled and asked for, in order. */
  readonly blinks: readonly number[];
  /** A node listed in a perspective layer: how far away it is over time, and the camera of its layer; null for every other node. */
  readonly away: AwayTrack | null;
  readonly persp: PerspTrack | null;
  /** Index of the group that lies in a plane and holds this node (its own index for that group), or -1. */
  readonly plane: number;
  /** A group that lies in a plane and turns on a hinge: its turn about its own x axis and about its own y axis; null for any other node. */
  readonly hinge: { readonly x: RotTrack | null; readonly y: RotTrack | null } | null;
  /** A node whose place in the draw order of its layer is driven: its depth over time; null for a node that keeps the depth it was given. */
  readonly depth: DriveTrack | null;
  /**
   * A region or a stroke whose outline is worked out at every frame: its points follow a drive, or they are points
   * of the space of a perspective layer; null for a node that is the outline it was given.
   */
  readonly form: FormTrack | null;
  /** True when a drive sets something of the node. */
  readonly driven: boolean;
  /**
   * A node that stands on a globe (a child of a shape with a globe): the index of the globe, its spec and its radius.
   * A stroke is then a line on its surface, any other node a thing placed on it by [lon, lat]. Left out: not on one.
   */
  readonly globe?: { readonly index: number; readonly spec: GlobeSpec; readonly r: number };
}

export interface CLayer {
  /** In a render-only evaluation view, marks the group whose pixels stand in for its descendants. */
  readonly sampledIndex?: number;
  readonly spec: LayerSpec;
  /** Node indices of this layer in draw order. */
  readonly nodes: readonly number[];
  readonly parallax: number;
  /** Blur radius in units: the layer's own, or what its depth and the camera's focus give it. */
  readonly blur: number;
  /** The blur over time, in a layer whose focus is pulled (blurTo); left out: it stays at `blur`. */
  readonly focus?: RiseTrack;
  /** 0..1 atmospheric tint. */
  readonly tint: number;
  /** A perspective layer: its camera over time; null for a flat layer. */
  readonly persp: PerspTrack | null;
  /** True when the layer orders what it draws: it is a perspective layer, or a node listed in it has a depth. */
  readonly ordered: boolean;
  /** True when a group of the layer draws its children in an order of its own: far to near (sort: 'depth'), or its flat ones first (cast over: 'flat'). */
  readonly sorted: boolean;
}

export interface CompiledShot {
  /** Global node indices and bake slots are preserved when drawing only the live part of a sampled scene. */
  readonly activeNodes?: readonly CNode[];
  /** Size in stage units of a repeated, unkeyed decorative mark in a render-only view. */
  readonly inkSize?: Float32Array;
  readonly inkPixels?: number;
  readonly facetRoofs?: Uint8Array;
  readonly retainedMask?: Uint8Array;
  readonly sampledBackdrops?: readonly { readonly layer: number; readonly group: CNode; readonly frames: readonly number[]; readonly liveGlow?: true }[];
  readonly spec: ShotSpec;
  readonly frames: number;
  readonly nodes: readonly CNode[];
  readonly byId: ReadonlyMap<string, CNode>;
  readonly layers: readonly CLayer[];
  /** Node indices by bake slot. */
  readonly bodies: readonly number[];
  readonly springs: readonly number[];
  readonly emitters: readonly number[];
  /** Unit vector toward the light, in screen space. */
  readonly light: Vec2;
  readonly cameraNoise: Noise;
  readonly background: { readonly inner: string; readonly outer: string };
  readonly atmosphere: string;
  /** The hues the automatic light leans to: those of the palette, or the engine's default lean. */
  readonly tones: ToneHues;
  /** String keys the scene uses. */
  readonly stringKeys: readonly string[];
  /** Hash of everything that can influence the bake. */
  readonly sceneHash: string;
  /** Node indices of the shapes marked as covers, in draw order; empty in a shot without any. */
  readonly covers: readonly number[];
  /** True when some node is clipped to a shape. */
  readonly clips: boolean;
  /** The camera keys and the zoom keys of the shot, or null: the camera does only what the shot's `camera` says. */
  readonly cameraTrack: CameraTrack | null;
  /** The background keys of the shot, or null: the background is what the shot says on every frame. */
  readonly backgroundTrack: BackgroundTrack | null;
  /** True when some layer of the shot is a perspective layer. */
  readonly spatial: boolean;
  /** True when a node of the shot is a body with a height (a rise), or travels a path with heights. */
  readonly risen: boolean;
  /** True when a group of the shot draws its children far to near (sort: 'depth'). */
  readonly sorted: boolean;
  /** By node index of a group in a plane with a ground: the node indices of its reliefs, in the order they are listed. Null in a shot without any. */
  readonly grounds: ReadonlyMap<number, readonly number[]> | null;
  /**
   * By node index: the least size on screen at which a body is drawn in full, from the nearest group above the node
   * that says so (detail), and -1 for a node under no such group. Null in a shot without any.
   */
  readonly detail: readonly number[] | null;
}

type Placed = Extract<SceneNode, { type: 'shape' | 'group' | 'eye' | 'stroke' | 'text' }>;

/** True for a group that draws its children far to near. */
function sortsChildren(node: SceneNode): boolean {
  return node.type === 'group' && node.sort === 'depth';
}

/** True for a group that draws its children in an order of its own: far to near, or its flat ones first (cast over: 'flat'). */
function ordersChildren(node: SceneNode): boolean {
  return sortsChildren(node) || (node.type === 'group' && node.cast?.over === 'flat');
}

/** True for the nodes that have a place of their own: a position, a rotation and a size in their parent's space. */
export function isPlaced(node: SceneNode): node is Placed {
  return node.type === 'shape' || node.type === 'group' || node.type === 'eye' || node.type === 'stroke' || node.type === 'text';
}

function fail(message: string): never {
  throw new CompileError(message);
}

/**
 * Atmospheric perspective by depth: 0 at the focus plane and in front of it,
 * rising quickly behind it (0.55 at depth 1, 0.80 at depth 2) up to 0.9.
 */
export function defaultTint(depth: number): number {
  return depth > 0 ? Math.min(0.9, 1 - Math.exp(-0.8 * depth)) : 0;
}

/** Seconds between two blinks, and how long a blink lasts. */
export const BLINK = { minGap: 2.2, maxGap: 5.2, seconds: 0.2 } as const;

export function compileShot(spec: ShotSpec): CompiledShot {
  const where = `shot "${spec.id}"`;
  const palette: Palette = spec.palette;
  const frames = frameCount(spec.seconds);

  // 1. Flatten the node trees in draw order: a parent, then its children.
  interface Draft {
    index: number;
    node: SceneNode;
    layer: number;
    parent: number;
    subtreeEnd: number;
  }
  const drafts: Draft[] = [];
  // True once a node or a key of the shot says anything about sound.
  let voiced = false;
  const idIndex = new Map<string, number>();
  const layerIds = new Set<string>();
  const layerNodes: number[][] = [];

  const visit = (node: SceneNode, layer: number, parent: number): void => {
    if (!node || typeof node !== 'object' || typeof (node as { type?: unknown }).type !== 'string') {
      fail(`${where}: a node in layer "${spec.layers[layer]!.id}" is not a scene node (use the factory functions)`);
    }
    if (idIndex.has(node.id)) fail(`${where}: duplicate node id "${node.id}"; ids must be unique within the shot`);
    if (node.sound !== undefined) voiced = true;
    const index = drafts.length;
    idIndex.set(node.id, index);
    const draft: Draft = { index, node, layer, parent, subtreeEnd: index };
    drafts.push(draft);
    layerNodes[layer]!.push(index);
    if (parent >= 0 && !isPlaced(node)) {
      fail(`${where}: ${node.type} "${node.id}" must be listed directly in a layer's nodes, not as a child of "${drafts[parent]!.node.id}"`);
    }
    if (node.type === 'shape' || node.type === 'group') {
      for (const child of node.children) visit(child, layer, index);
    }
    draft.subtreeEnd = drafts.length - 1;
  };
  spec.layers.forEach((layer, li) => {
    if (layerIds.has(layer.id)) fail(`${where}: duplicate layer id "${layer.id}"`);
    layerIds.add(layer.id);
    layerNodes.push([]);
    for (const node of layer.nodes) visit(node, li, -1);
  });

  const known = (): string => [...idIndex.keys()].join(', ');
  const ref = (owner: SceneNode, prop: string, id: string, sameLayer = true): number => {
    const index = idIndex.get(id);
    if (index === undefined) fail(`${where}: ${owner.type} "${owner.id}" ${prop} refers to "${id}", which does not exist (nodes: ${known()})`);
    const other = drafts[index]!;
    if (!isPlaced(other.node)) fail(`${where}: ${owner.type} "${owner.id}" ${prop} refers to ${other.node.type} "${id}"; it must be a shape, a group, an eye, a stroke or a text`);
    if (sameLayer && other.layer !== drafts[idIndex.get(owner.id)!]!.layer) {
      fail(`${where}: ${owner.type} "${owner.id}" and its ${prop} "${id}" must be in the same layer`);
    }
    return index;
  };
  const col = (owner: SceneNode, prop: string, value: string): string => {
    try {
      return resolveColor(palette, value);
    } catch (e) {
      return fail(`${where}: ${owner.type} "${owner.id}" ${prop}: ${(e as Error).message}`);
    }
  };

  // 2. Sort the timeline by target.
  const moves = new Map<number, (MoveToKey | HopKey | TravelKey)[]>();
  const levels = new Map<number, LevelToKey[]>();
  const squashes = new Map<number, SquashKey[]>();
  const turns = new Map<number, TurnToKey[]>();
  const popIns = new Map<number, PopInKey[]>();
  const popOuts = new Map<number, PopOutKey[]>();
  const bumps = new Map<number, { at: number; amount: number }[]>();
  const scales = new Map<number, ScaleToKey[]>();
  const axisScales = new Map<number, ScaleToKey[]>();
  const fades = new Map<number, FadeToKey[]>();
  const draws = new Map<number, DrawOnKey[]>();
  const solids = new Map<number, SolidToKey[]>();
  const counts = new Map<number, CountToKey[]>();
  const bends = new Map<number, BendToKey[]>();
  const widths = new Map<number, WidthToKey[]>();
  const rises = new Map<number, RiseToKey[]>();
  const hazes = new Map<number, HazeToKey[]>();
  const rates = new Map<number, RateToKey[]>();
  const fills = new Map<number, FillToKey[]>();
  const lineColours = new Map<number, ColorToKey[]>();
  const pulses = new Map<number, PulseKey[]>();
  const strokePulses = new Map<number, PulseKey[]>();
  const reshapes = new Map<number, ReshapeKey[]>();
  const opens = new Map<number, OpenToKey[]>();
  const askedBlinks = new Map<number, number[]>();
  const cameraKeys: CameraToKey[] = [];
  const zoomKeys: ZoomToKey[] = [];
  const backgroundKeys: BackgroundToKey[] = [];
  const drives = new Map<number, DriveKey[]>();
  // Hinges of the groups that lie in a plane: their turns about their own x axis and about their own y axis.
  const hingesX = new Map<number, TurnToKey[]>();
  const hingesY = new Map<number, TurnToKey[]>();
  // The camera keys of the perspective layers, by layer.
  const perspKeys = new Map<number, PerspectiveToKey[]>();
  // The pulls of focus, by layer.
  const blurKeys = new Map<number, BlurToKey[]>();
  const push =<T>(map: Map<number, T[]>, index: number, item: T): void => {
    const list = map.get(index);
    if (list) list.push(item);
    else map.set(index, [item]);
  };
  for (const key of spec.timeline as readonly Key[]) {
    if (!key || typeof key !== 'object' || typeof key.kind !== 'string') fail(`${where}: the timeline holds something that is not a key (use moveTo, popIn, ...)`);
    if (key.sound !== undefined) voiced = true;
    if (key.kind === 'sfx') {
      // A sound placed by hand: it animates nothing. With a node, it comes from where that node is.
      if (key.at > spec.seconds) fail(`${where}: sfx("${key.sound}") is placed at ${key.at} s, after the shot ends (${spec.seconds} s)`);
      if (key.target !== null) {
        const at = idIndex.get(key.target);
        if (at === undefined) fail(`${where}: sfx("${key.sound}") names the node "${key.target}", which does not exist (nodes: ${known()})`);
        const from = drafts[at]!.node;
        if (!isPlaced(from) && from.type !== 'label') fail(`${where}: sfx("${key.sound}") names ${from.type} "${key.target}"; it must be a shape, a group, an eye or a label`);
      }
      continue;
    }
    if (key.kind === 'cameraTo') {
      // A key of the camera: it has no node.
      if (key.at > spec.seconds) fail(`${where}: cameraTo starts at ${key.at} s, after the shot ends (${spec.seconds} s)`);
      cameraKeys.push(key);
      continue;
    }
    if (key.kind === 'zoomTo') {
      // A key of the camera's zoom: it has no node either.
      if (key.at > spec.seconds) fail(`${where}: zoomTo starts at ${key.at} s, after the shot ends (${spec.seconds} s)`);
      zoomKeys.push(key);
      continue;
    }
    if (key.kind === 'backgroundTo') {
      // A key of the background: it has no node either.
      if (key.at > spec.seconds) fail(`${where}: backgroundTo starts at ${key.at} s, after the shot ends (${spec.seconds} s)`);
      backgroundKeys.push(key);
      continue;
    }
    if (key.kind === 'perspectiveTo') {
      // A key of the camera of a perspective layer: it has no node either.
      if (key.at > spec.seconds) fail(`${where}: perspectiveTo("${key.layer}") starts at ${key.at} s, after the shot ends (${spec.seconds} s)`);
      const li = spec.layers.findIndex((layer) => layer.id === key.layer);
      if (li < 0) fail(`${where}: perspectiveTo names the layer "${key.layer}", which does not exist (layers: ${spec.layers.map((layer) => layer.id).join(', ')})`);
      if (!spec.layers[li]!.perspective) fail(`${where}: perspectiveTo("${key.layer}"): the layer is flat; give it the option perspective to make it a perspective layer`);
      push(perspKeys, li, key);
      continue;
    }
    if (key.kind === 'blurTo') {
      // A pull of the focus of a layer: it has no node either.
      if (key.at > spec.seconds) fail(`${where}: blurTo("${key.layer}") starts at ${key.at} s, after the shot ends (${spec.seconds} s)`);
      const li = spec.layers.findIndex((layer) => layer.id === key.layer);
      if (li < 0) fail(`${where}: blurTo names the layer "${key.layer}", which does not exist (layers: ${spec.layers.map((layer) => layer.id).join(', ')})`);
      if (spec.layers[li]!.sampledBackdrop !== undefined) fail(`${where}: blurTo("${key.layer}"): the layer samples a backdrop (sampledBackdrop), whose pictures are drawn at one blur; pull the focus of another layer, or leave sampledBackdrop out`);
      push(blurKeys, li, key);
      continue;
    }
    const index = idIndex.get(key.target);
    if (index === undefined) fail(`${where}: ${key.kind} targets "${key.target}", which does not exist (nodes: ${known()})`);
    const node = drafts[index]!.node;
    if (key.at > spec.seconds) fail(`${where}: ${key.kind}("${key.target}") starts at ${key.at} s, after the shot ends (${spec.seconds} s)`);
    const need = (ok: boolean, what: string): void => {
      if (!ok) fail(`${where}: ${key.kind} cannot target ${node.type} "${node.id}"; it applies to ${what}`);
    };
    switch (key.kind) {
      case 'moveTo':
        need(isPlaced(node), 'shapes, groups, eyes, strokes and texts');
        if (node.type === 'shape' && node.body) fail(`${where}: moveTo cannot target "${node.id}": a rigid body is moved by the physics bake`);
        push(moves, index, key);
        break;
      case 'hop':
      case 'travel':
        need(isPlaced(node), 'shapes, groups, eyes, strokes and texts');
        if (node.type === 'shape' && node.body) fail(`${where}: ${key.kind} cannot target "${node.id}": a rigid body is moved by the physics bake`);
        if (key.kind === 'travel' && (key.roll !== null || key.orient) && node.type === 'eye') {
          fail(`${where}: travel("${node.id}") cannot roll or orient an eye: an eye does not turn; put it in a group and move that`);
        }
        push(moves, index, key);
        break;
      case 'levelTo':
        if (node.type !== 'shape' || !node.level) {
          fail(`${where}: levelTo cannot target ${node.type} "${node.id}"; it applies to a shape with a level (give the shape the option level)`);
        }
        push(levels, index, key);
        break;
      case 'squash':
        need(isPlaced(node), 'shapes, groups, eyes, strokes and texts');
        push(squashes, index, key);
        break;
      case 'turnTo':
        need(node.type === 'shape' || node.type === 'group' || node.type === 'stroke' || node.type === 'text', 'shapes, groups, strokes and texts');
        if (node.type === 'shape' && node.body) fail(`${where}: turnTo cannot target "${node.id}": a rigid body is turned by the physics bake`);
        if (key.about !== undefined) {
          // A hinge: the plane of a group turns about one of its own axes.
          if (node.type !== 'group' || !node.plane) {
            fail(`${where}: turnTo("${node.id}") with about turns a plane on a hinge; it applies to a group that lies in a plane of a perspective layer (give the group the option plane)`);
          }
          push(key.about === 'x' ? hingesX : hingesY, index, key);
        } else push(turns, index, key);
        break;
      case 'drive':
        need(isPlaced(node), 'shapes, groups, eyes, strokes and texts');
        push(drives, index, key);
        break;
      case 'popIn':
        need(isPlaced(node) || node.type === 'label', 'shapes, groups, eyes, strokes, texts and labels');
        push(popIns, index, key);
        break;
      case 'popOut':
        need(isPlaced(node) || node.type === 'label', 'shapes, groups, eyes, strokes, texts and labels');
        push(popOuts, index, key);
        break;
      case 'scaleTo':
        need(isPlaced(node) || node.type === 'label', 'shapes, groups, eyes, strokes, texts and labels');
        if (node.type === 'shape' && node.body) fail(`${where}: scaleTo cannot target "${node.id}": the size of a rigid body is fixed by the physics bake`);
        if (key.axes) {
          // Along its own axes: for what has a place and a turn of its own.
          if (!isPlaced(node)) fail(`${where}: scaleTo("${node.id}") with to: [sx, sy] cannot target a label; it applies to shapes, groups, eyes, strokes and texts`);
          push(axisScales, index, key);
        } else push(scales, index, key);
        break;
      case 'fadeTo':
        // An emitter fades its particles as one picture; the fade makes no sound of its own.
        if (node.type === 'emitter' && key.sound !== undefined) fail(`${where}: fadeTo("${node.id}") fades the particles of an emitter, which makes no event to sound; leave sound out`);
        push(fades, index, key);
        break;
      case 'bump':
        need(isPlaced(node) || node.type === 'label', 'shapes, groups, eyes, strokes, texts and labels');
        push(bumps, index, { at: (key as BumpKey).at, amount: (key as BumpKey).amount });
        break;
      case 'drawOn':
        need(node.type === 'link' || node.type === 'stroke', 'links and strokes');
        if (node.type === 'link' && (key.to !== undefined || key.profile !== undefined || key.ramp !== undefined)) {
          fail(`${where}: drawOn("${node.id}"): to, profile and ramp are for a stroke; a link is drawn on whole`);
        }
        push(draws, index, key);
        break;
      case 'countTo':
        if ((node.type !== 'text' && node.type !== 'label') || !node.count) fail(`${where}: countTo cannot target ${node.type} "${node.id}"; it applies to a text or a label that is a counter (give it the option count)`);
        push(counts, index, key);
        break;
      case 'solidTo':
        need(node.type === 'stroke', 'strokes');
        if (node.type === 'stroke' && node.dash === null) fail(`${where}: solidTo cannot target "${node.id}": the stroke has no dash to close`);
        push(solids, index, key);
        break;
      case 'pulse': {
        need(node.type === 'link' || node.type === 'stroke', 'links and strokes');
        const w = `${where}: pulse("${node.id}")`;
        if (node.type === 'link') {
          const extra = (['from', 'to', 'profile', 'ramp', 'length', 'node'] as const).filter((name) => key[name] !== undefined);
          if (extra.length > 0) fail(`${w}: ${extra.join(', ')} ${extra.length > 1 ? 'are' : 'is'} for a stroke; on a link a pulse runs from its first node to its second, which gets the bump`);
          push(pulses, index, key);
          break;
        }
        if (node.type !== 'stroke') break;
        // A light along a stroke: between two shares of its length; a share above 1 is another time round a closed one.
        const from = key.from ?? 0;
        const to = key.to ?? 1;
        if (!node.path.closed && (from > 1 || to > 1)) fail(`${w}: from and to are shares of the length of the stroke, 0 to 1; only round a closed stroke does a share above 1 run on (from ${from}, to ${to})`);
        if (Math.abs(to - from) < 1e-6) fail(`${w}: the light runs nowhere: from and to are both ${from}`);
        if (key.node === undefined) {
          if (key.bump > 0 && key.bump !== PULSE_BUMP) fail(`${w}: a stroke has no far node to bump; name the node the light arrives at with node, or leave bump out`);
        } else {
          const at = idIndex.get(key.node);
          if (at === undefined) fail(`${w}: node names "${key.node}", which does not exist (nodes: ${known()})`);
          const hit = drafts[at]!.node;
          if (!isPlaced(hit) && hit.type !== 'label') fail(`${w}: node names ${hit.type} "${key.node}"; the bump is for a shape, a group, an eye, a stroke, a text or a label`);
          if (key.bump > 0) push(bumps, at, { at: key.at + key.dur, amount: key.bump });
        }
        push(strokePulses, index, key);
        break;
      }
      case 'bendTo':
        need(node.type === 'link', 'links');
        push(bends, index, key);
        break;
      case 'widthTo':
        need(node.type === 'link' || node.type === 'stroke', 'links and strokes');
        // The key may be as wide as a stroke may be; a link is held to its own limit.
        if (node.type === 'link' && key.to > LINK_MAX_WIDTH) fail(`${where}: widthTo("${node.id}"): to is ${key.to}, and a link is at most ${LINK_MAX_WIDTH} wide`);
        if (node.type === 'stroke' && node.least !== undefined) fail(`${where}: widthTo("${node.id}"): the stroke has least, which gives its width at every zoom; leave least out, or leave the widthTo out`);
        push(widths, index, key);
        break;
      case 'riseTo':
        if ((node.type !== 'shape' && node.type !== 'stroke') || node.rise === undefined) {
          fail(`${where}: riseTo cannot target ${node.type} "${node.id}"; it applies to a shape or a stroke with a rise (give it the option rise; 0 lies flat until it is raised)`);
        }
        push(rises, index, key);
        break;
      case 'rateTo':
        need(node.type === 'emitter', 'emitters');
        push(rates, index, key);
        break;
      case 'hazeTo':
        if (node.type !== 'shape' || node.haze === undefined) {
          fail(`${where}: hazeTo cannot target ${node.type} "${node.id}"; it applies to a shape with a haze (give the shape the option haze; amount 0 is still air until a hazeTo stirs it)`);
        }
        push(hazes, index, key);
        break;
      case 'fillTo':
        need(node.type === 'shape', node.type === 'stroke' || node.type === 'link' ? 'shapes; the colour of a line is keyed by colorTo' : 'shapes');
        push(fills, index, key);
        break;
      case 'colorTo':
        need(node.type === 'stroke' || node.type === 'link', node.type === 'shape' ? 'strokes and links; the colour of a shape is keyed by fillTo' : 'strokes and links');
        push(lineColours, index, key);
        break;
      case 'reshape':
        if (!(node.type === 'stroke' || (node.type === 'shape' && isRegion(node.shape)))) {
          fail(`${where}: reshape cannot target ${node.type === 'shape' ? node.shape.kind : node.type} "${node.id}"; it applies to regions and strokes, whose outline is a list of points`);
        }
        push(reshapes, index, key);
        break;
      case 'openTo':
        need(node.type === 'eye', 'eyes');
        push(opens, index, key);
        break;
      case 'blink':
        need(node.type === 'eye', 'eyes');
        push(askedBlinks, index, key.at);
        break;
      default:
        fail(`${where}: unknown timeline key kind ${JSON.stringify((key as { kind: unknown }).kind)}`);
    }
  }
  // A pulse that arrives gives the node at the far end of its link a bump.
  for (const [linkIndex, list] of pulses) {
    const linkNode = drafts[linkIndex]!.node;
    if (linkNode.type !== 'link') continue;
    const toIndex = idIndex.get(linkNode.to);
    if (toIndex === undefined) continue;
    for (const p of list) if (p.bump > 0) push(bumps, toIndex, { at: p.at + p.dur, amount: p.bump });
  }

  // The cameras of the perspective layers, and the group that lies in a plane around each node.
  const perspTracks: (PerspTrack | null)[] = spec.layers.map((layer, li) => (layer.perspective ? buildPerspTrack(layer.perspective, perspKeys.get(li) ?? []) : null));
  const planeOf: number[] = [];
  for (const d of drafts) planeOf.push(d.node.type === 'group' && d.node.plane ? d.index : d.parent >= 0 ? planeOf[d.parent]! : -1);
  /** The track of one channel of the drives of a node, or null when none of them sets it. */
  const driveTrack = (id: string, channel: string, stride: number, keys: readonly DriveKey[], pick: (k: DriveKey) => readonly number[] | undefined): DriveTrack | null => {
    const segs: DriveSeg[] = [];
    for (const k of keys) {
      const data = pick(k);
      if (data) segs.push({ at: k.at, dur: k.dur, count: k.count, data });
    }
    return segs.length > 0 ? buildDriveTrack(id, channel, stride, segs) : null;
  };

  // 3. Build the compiled nodes.
  const bodies: number[] = [];
  const springs: number[] = [];
  const emitters: number[] = [];
  const stringKeys = new Set<string>();
  let bodyLayer = -1;

  const nodes: CNode[] = drafts.map((d): CNode => {
    const node = d.node;
    const colors: Record<string, string> = {};
    let particleColors: string[] = [];
    let fromIndex = -1;
    let toIndex = -1;
    let targetIndex = -1;
    let lookAtIndex = -1;
    let attachIndex = -1;
    let bodySlot = -1;
    let springSlot = -1;
    let emitterSlot = -1;
    let springKind: CNode['springKind'] = null;
    let springSpec = null;
    let blinks: number[] = [];
    let idleNoise: Noise | null = null;
    let clipIndex = -1;
    // What the node is in the space of a perspective layer, if its layer is one.
    const view = spec.layers[d.layer]!.perspective;
    const top = d.parent < 0;
    const listed = `that is for a node listed directly in a perspective layer (a layer with the option perspective)`;
    // A child of a globe stands on it.
    const holder = d.parent >= 0 ? drafts[d.parent]!.node : null;
    const onGlobe: ShapeNode | null = holder?.type === 'shape' && holder.globe ? holder : null;
    if (isPlaced(node)) {
      if (onGlobe && node.z !== undefined) {
        if (node.type === 'stroke') fail(`${where}: stroke "${node.id}" is a line on the globe "${onGlobe.id}": it lies on the surface and has no height`);
        if (!(node.z >= 0)) fail(`${where}: ${node.type} "${node.id}" stands on the globe "${onGlobe.id}" at a height of ${node.z} units: a height is 0 or more`);
      } else if (node.z !== undefined && !(top && view)) fail(`${where}: ${node.type} "${node.id}" has a place of three numbers, [x, y, z]: ${listed}`);
      if (node.depth !== undefined && !top) fail(`${where}: ${node.type} "${node.id}" has a depth: that is for a node listed directly in a layer's nodes; inside a parent, the order of the children is the draw order`);
    }
    if (node.type === 'group' && node.plane) {
      if (!(top && view)) fail(`${where}: group "${node.id}" lies in a plane: ${listed}`);
      if (node.follow || node.upright || node.clipTo) fail(`${where}: group "${node.id}" lies in a plane: it cannot also have follow, upright or clipTo`);
    }
    if ((node.type === 'shape' || node.type === 'stroke') && node.points3) {
      if (!(top && view)) fail(`${where}: ${node.type} "${node.id}" has points of three numbers, [x, y, z]: ${listed}`);
      if (reshapes.has(d.index)) fail(`${where}: reshape cannot target "${node.id}": its points are points of the space of a perspective layer; drive them with drive()`);
      if (node.type === 'shape' && node.idle) fail(`${where}: region "${node.id}" has points of three numbers, [x, y, z]: it cannot also have idle; put it in motion with drive()`);
    }
    if (view && node.type === 'shape' && node.body) {
      fail(`${where}: rigid body "${node.id}" is in the perspective layer "${spec.layers[d.layer]!.id}"; the physics bake is flat: put the bodies in a flat layer`);
    }

    if (node.type !== 'label' && node.type !== 'eye' && node.clipTo) {
      const index = idIndex.get(node.clipTo);
      if (index === undefined) fail(`${where}: ${node.type} "${node.id}" clipTo refers to "${node.clipTo}", which does not exist (nodes: ${known()})`);
      const other = drafts[index]!;
      if (other.node.type !== 'shape') fail(`${where}: ${node.type} "${node.id}" clipTo refers to ${other.node.type} "${node.clipTo}"; it must be a shape`);
      if (other.layer !== d.layer) fail(`${where}: ${node.type} "${node.id}" and the shape it is clipped to, "${node.clipTo}", must be in the same layer`);
      if (index >= d.index && index <= d.subtreeEnd) fail(`${where}: ${node.type} "${node.id}" cannot be clipped to itself or to something inside it ("${node.clipTo}")`);
      if (planeOf[index] !== planeOf[d.index]) fail(`${where}: ${node.type} "${node.id}" and the shape it is clipped to, "${node.clipTo}", must lie in the same plane`);
      clipIndex = index;
    }

    switch (node.type) {
      case 'shape':
        colors['fill'] = col(node, 'fill', node.fill);
        if (node.rimLight) colors['rimLight'] = col(node, 'rimLight', node.rimLight);
        if (node.side) colors['side'] = col(node, 'side', node.side);
        if (node.haze) {
          // The haze moves the frame as it is drawn so far: it belongs to the draw order of its layer, not to a parent.
          if (d.parent >= 0) fail(`${where}: shape "${node.id}" has a haze: that is for a shape listed directly in a layer's nodes; put the haze beside the group, not in it`);
          if (view) fail(`${where}: shape "${node.id}" has a haze, and the layer "${spec.layers[d.layer]!.id}" is a perspective layer; a haze lies in a flat layer`);
        }
        if (node.openings?.color) colors['openings'] = col(node, 'openings.color', node.openings.color);
        if (node.globe) {
          const g = node.globe;
          g.layers.forEach((l, k) => (colors[`globe.layer${k}`] = col(node, `layers[${k}].fill`, l.fill)));
          colors['globe.night'] = col(node, 'light.night', g.night.color);
          if (g.lights) colors['globe.lights'] = col(node, 'lights.color', g.lights.color);
          if (g.air) colors['globe.air'] = col(node, 'air.color', g.air.color);
          if (planeOf[d.index]! >= 0) fail(`${where}: globe "${node.id}" is in a group that lies in a plane; a globe is seen from far away, straight on: put it in a flat layer or list it directly in a perspective layer`);
        }
        if (node.relief) {
          colors['relief.dark'] = col(node, 'relief.dark', node.relief.dark);
          colors['relief.bright'] = col(node, 'relief.bright', node.relief.bright);
          node.relief.tints?.forEach((t, k) => (colors[`relief.tint${k}`] = col(node, `relief.tints[${k}]`, t[1])));
        }
        if (node.body) {
          if (d.parent >= 0) fail(`${where}: rigid body "${node.id}" must be listed directly in a layer's nodes`);
          if (node.follow || node.sway || node.idle) fail(`${where}: rigid body "${node.id}" cannot also have follow, sway or idle`);
          if (bodyLayer >= 0 && bodyLayer !== d.layer) {
            fail(`${where}: rigid bodies must all be in one layer ("${node.id}" is in "${spec.layers[d.layer]!.id}", others are in "${spec.layers[bodyLayer]!.id}")`);
          }
          if (node.body.kind === 'dynamic' && node.body.release > spec.seconds) {
            fail(`${where}: body "${node.id}" is released at ${node.body.release} s, after the shot ends`);
          }
          if (node.body.kind === 'dynamic' && node.body.release < -spec.physics.prewarm - 1e-9) {
            fail(
              `${where}: body "${node.id}" is released at ${node.body.release} s, before the simulation starts ` +
                `(physics.prewarm is ${spec.physics.prewarm} s); raise physics.prewarm or release it later`,
            );
          }
          bodyLayer = d.layer;
          bodySlot = bodies.length;
          bodies.push(d.index);
        }
        if (node.sway) {
          springKind = 'sway';
          springSpec = node.sway;
        } else if (node.follow) {
          springKind = 'follow';
          springSpec = node.follow;
        }
        break;
      case 'group':
        if (node.cast) colors['cast'] = col(node, 'cast.color', node.cast.color);
        if (node.fog) colors['fog'] = col(node, 'fog.color', node.fog.color);
        if (node.follow) {
          springKind = 'follow';
          springSpec = node.follow;
        }
        break;
      case 'eye':
        colors['white'] = col(node, 'white', node.white);
        colors['pupil'] = col(node, 'pupil', node.pupil);
        if (node.lookAt) lookAtIndex = ref(node, 'lookAt', node.lookAt);
        if (node.blink) {
          // Eyes of one parent share a blink schedule, so a creature blinks instead of winking.
          const owner = d.parent >= 0 ? drafts[d.parent]!.node.id : node.id;
          const rng = new Rng(spec.seed, `blink/${owner}`);
          let t = rng.range(0.8, BLINK.maxGap);
          while (t < spec.seconds) {
            blinks.push(t);
            t += rng.range(BLINK.minGap, BLINK.maxGap);
          }
        }
        // Blinks the timeline asks for join the schedule.
        blinks = [...blinks, ...(askedBlinks.get(d.index) ?? [])].sort((a, b) => a - b);
        break;
      case 'stroke':
        colors['color'] = col(node, 'color', node.color);
        if (node.pulseColor) colors['pulseColor'] = col(node, 'pulseColor', node.pulseColor);
        if (node.side) colors['side'] = col(node, 'side', node.side);
        if (node.openings?.color) colors['openings'] = col(node, 'openings.color', node.openings.color);
        if (node.rise !== undefined && node.dash) fail(`${where}: stroke "${node.id}" has a rise and dashes; a wall is a solid line: leave dash out`);
        if (node.rise !== undefined && d.parent >= 0 && sortsChildren(drafts[d.parent]!.node) && strokePulses.has(d.index)) {
          fail(`${where}: pulse cannot target "${node.id}": it is a wall among children drawn far to near (sort: 'depth'), which is drawn stretch by stretch; run the light along a flat stroke drawn over the group`);
        }
        break;
      case 'text':
        colors['ink'] = col(node, 'ink', node.ink);
        if (node.box) colors['box'] = col(node, 'box', node.box);
        for (const lang of Object.keys(spec.strings)) {
          let words: string;
          try {
            words = resolveString(spec.strings, lang, node.text);
          } catch (e) {
            return fail(`${where}: text "${node.id}": ${(e as Error).message}`);
          }
          // The string of a counter says where its number goes, once, in every language.
          if (node.count && words.split(COUNT_MARK).length !== 2) {
            fail(`${where}: text "${node.id}" is a counter: its string "${node.text}" [${lang}] must hold ${COUNT_MARK} once, where the number goes; it is ${JSON.stringify(words)}`);
          }
        }
        if (node.runInk) {
          colors['runInk'] = col(node, 'runInk', node.runInk);
          markedRuns(spec.strings, `${where}: text "${node.id}"`, node.text);
        }
        stringKeys.add(node.text);
        break;
      case 'link':
        colors['color'] = col(node, 'color', node.color);
        colors['pulseColor'] = col(node, 'pulseColor', node.pulseColor);
        fromIndex = ref(node, 'from', node.from);
        toIndex = ref(node, 'to', node.to);
        if (fromIndex === toIndex) fail(`${where}: link "${node.id}" joins "${node.from}" to itself`);
        break;
      case 'label': {
        colors['fill'] = col(node, 'fill', node.fill);
        colors['ink'] = col(node, 'ink', node.ink);
        targetIndex = ref(node, 'target', node.target);
        for (const lang of Object.keys(spec.strings)) {
          let words = '';
          try {
            words = resolveString(spec.strings, lang, node.text);
          } catch (e) {
            fail(`${where}: label "${node.id}": ${(e as Error).message}`);
          }
          // The string of a counter says where its number goes, once, in every language.
          if (node.count && words.split(COUNT_MARK).length !== 2) {
            fail(`${where}: label "${node.id}" is a counter: its string "${node.text}" [${lang}] must hold ${COUNT_MARK} once, where the number goes; it is ${JSON.stringify(words)}`);
          }
        }
        if (node.runInk) {
          colors['runInk'] = col(node, 'runInk', node.runInk);
          markedRuns(spec.strings, `${where}: label "${node.id}"`, node.text);
        }
        stringKeys.add(node.text);
        if (node.follow) {
          springKind = 'follow';
          springSpec = node.follow;
        }
        break;
      }
      case 'emitter':
        particleColors = node.colors.map((c, i) => col(node, `colors[${i}]`, c));
        if (node.core) colors['core'] = col(node, 'core.color', node.core.color);
        if (node.attach) attachIndex = ref(node, 'attach', node.attach);
        emitterSlot = emitters.length;
        emitters.push(d.index);
        break;
      default:
        fail(`${where}: unknown node type ${JSON.stringify((node as { type: unknown }).type)}`);
    }
    if ((node.type === 'shape' || node.type === 'group') && node.idle) {
      idleNoise = new Noise(spec.seed, `idle/${node.id}`);
    }
    if (springKind) {
      springSlot = springs.length;
      springs.push(d.index);
    }

    let pos: PosTrack | null = null;
    let rot: RotTrack | null = null;
    let scale: ScaleTrack | null = null;
    let linkTrack: LinkTrack | null = null;
    let outline: OutlineTrack | null = null;
    let opacity: OpacityTrack | null = null;
    let away: AwayTrack | null = null;
    let hinge: CNode['hinge'] = null;
    let depth: DriveTrack | null = null;
    let form: FormTrack | null = null;
    const driven = drives.get(d.index) ?? [];
    try {
      if (isPlaced(node)) {
        pos = buildPosTrack(node.id, node.at, moves.get(d.index) ?? []);
        rot = buildRotTrack(node.id, node.rotation, turns.get(d.index) ?? []);
        if (pos.turns && rot.segs.length > 0) {
          fail(`"${node.id}" has a travel that rolls or orients it and a turnTo; a node is turned by one or the other`);
        }
        // Listed in a perspective layer: its third coordinate rides its moves.
        if (top && view) away = buildAwayTrack(node.z ?? 0, pos, moves.get(d.index) ?? []);
        else if ((moves.get(d.index) ?? []).some((k) => k.kind === 'moveTo' && k.z !== undefined)) {
          fail(`moveTo("${node.id}") has a place of three numbers, [x, y, z]: ${listed}`);
        }
        const body = node.type === 'shape' && node.body !== null;
        // A drive sets a channel instead of the keys of that channel, never beside them.
        const place = driveTrack(node.id, 'place', 2, driven, (k) => (k.place && k.placeDims === 3 ? k.place.filter((_, i) => i % 3 !== 2) : k.place));
        if (place) {
          if (body) fail(`drive("${node.id}") cannot set the place of a rigid body: it is moved by the physics bake`);
          if (pos.segs.length > 0) fail(`"${node.id}" has a drive that sets its place and a moveTo, a hop or a travel; a place is driven or keyed, not both: put the node in a group and move that`);
          const dims = new Set(driven.filter((k) => k.place).map((k) => k.placeDims));
          if (dims.size > 1) fail(`the drives of "${node.id}" set its place with two numbers and with three; a place keeps its form`);
          if (dims.has(3) && !away) fail(`drive("${node.id}") sets a place of three numbers, [x, y, z]: ${listed}`);
          pos = { ...pos, drive: place };
          if (dims.has(3)) away = { ...away!, drive: driveTrack(node.id, 'place', 1, driven, (k) => k.place && k.place.filter((_, i) => i % 3 === 2))! };
        }
        const turn = driveTrack(node.id, 'rotation', 1, driven, (k) => k.rotation);
        if (turn) {
          if (node.type === 'eye') fail(`drive("${node.id}") cannot set the rotation of an eye: an eye does not turn; put it in a group and drive that`);
          if (body) fail(`drive("${node.id}") cannot set the rotation of a rigid body: it is turned by the physics bake`);
          if (rot.segs.length > 0 || pos.turns) fail(`"${node.id}" has a drive that sets its rotation and a turnTo, or a travel that rolls or orients it; a rotation is driven or keyed, not both`);
          rot = { ...rot, drive: turn };
        }
        depth = driveTrack(node.id, 'depth', 1, driven, (k) => k.depth);
        if (depth && !top) fail(`drive("${node.id}") sets a depth: that is for a node listed directly in a layer's nodes; inside a parent, the order of the children is the draw order`);
        if (node.type === 'group' && node.plane && (hingesX.has(d.index) || hingesY.has(d.index))) {
          hinge = {
            x: hingesX.has(d.index) ? buildRotTrack(node.id, 0, hingesX.get(d.index)!) : null,
            y: hingesY.has(d.index) ? buildRotTrack(node.id, 0, hingesY.get(d.index)!) : null,
          };
        }
      }
      if (isPlaced(node) || node.type === 'label') {
        scale = buildScaleTrack(node.id, popIns.get(d.index) ?? [], popOuts.get(d.index) ?? [], bumps.get(d.index) ?? [], scales.get(d.index) ?? []);
        const size = driveTrack(node.id, 'scale', 1, driven, (k) => k.scale);
        if (size) {
          if (node.type === 'shape' && node.body) fail(`drive("${node.id}") cannot set the scale of a rigid body: its size is fixed by the physics bake`);
          if (scale.grows.length > 0) fail(`"${node.id}" has a drive that sets its scale and a scaleTo; a size is driven or keyed, not both (popIn, popOut and bump still apply)`);
          scale = { ...scale, drive: size };
        }
      }
      if (node.type === 'emitter') {
        // An emitter with an opacity of its own, or a fadeTo, fades its particles as one picture; any other has no track.
        if (node.opacity !== undefined || fades.has(d.index)) opacity = buildOpacityTrack(node.opacity ?? 1, fades.get(d.index) ?? []);
        if (node.rate === 0 && node.bursts.length === 0 && !node.onContact && !rates.has(d.index)) {
          fail(`emitter "${node.id}" never emits: its rate is 0 and no rateTo raises it; give it a rate, bursts or onContact, or a rateTo`);
        }
      } else {
        opacity = buildOpacityTrack(node.opacity, fades.get(d.index) ?? []);
        const shown = driveTrack(node.id, 'opacity', 1, driven, (k) => k.opacity);
        if (shown) {
          if (opacity.segs.length > 0) fail(`"${node.id}" has a drive that sets its opacity and a fadeTo; an opacity is driven or keyed, not both`);
          opacity = { ...opacity, drive: shown };
        }
      }
      // An outline that is worked out at every frame: its points are driven, or they are points of the space.
      const outlined = node.type === 'stroke' || (node.type === 'shape' && isRegion(node.shape));
      const solid = node.type === 'shape' || node.type === 'stroke' ? node.points3 : undefined;
      const shaped = driven.filter((k) => k.points);
      if (shaped.length > 0 && !outlined) fail(`drive("${node.id}") sets points: that is for a region or a stroke, whose outline is a list of points`);
      if (outlined && (shaped.length > 0 || solid)) {
        const flat = node.type === 'stroke' ? node.path.points : node.type === 'shape' && isRegion(node.shape) ? node.shape.points : [];
        const dims = solid ? 3 : 2;
        const base = (solid ?? flat).flatMap((point) => [...point]);
        if (shaped.length > 0 && reshapes.has(d.index)) fail(`"${node.id}" has a drive that sets its points and a reshape; an outline is driven or keyed, not both`);
        for (const k of shaped) {
          if (k.pointDims !== dims) {
            fail(
              solid
                ? `drive("${node.id}") sets points of two numbers, and the node has points of the space, [x, y, z]`
                : `drive("${node.id}") sets points of three numbers, [x, y, z]: give the node itself points of three numbers, in a perspective layer`,
            );
          }
          if (k.points![0]!.length !== base.length) fail(`drive("${node.id}") sets ${k.points![0]!.length / dims} points, and the node has ${base.length / dims}; an outline keeps its number of points`);
        }
        form = {
          kind: node.type === 'stroke' ? 'stroke' : 'region',
          dims,
          base,
          smooth: node.type === 'stroke' ? node.path.smooth : node.type === 'shape' && isRegion(node.shape) ? node.shape.smooth : 0,
          closed: node.type === 'stroke' ? node.path.closed : true,
          back: node.type === 'shape' ? node.back !== false : true,
          drive: shaped.length > 0 ? buildDriveTrack(node.id, 'points', base.length, shaped.map((k) => ({ at: k.at, dur: k.dur, count: k.count, data: k.points!.flat() }))) : null,
          persp: solid ? perspTracks[d.layer]! : null,
        };
      }
      if (node.type === 'link') {
        linkTrack = buildLinkTrack(node.id, draws.get(d.index) ?? [], pulses.get(d.index) ?? [], bends.get(d.index) ?? [], node.bend);
      }
      // A node without a reshape has no track: it is the shape it was given.
      const reshaped = reshapes.get(d.index);
      if (reshaped && node.type === 'stroke') outline = buildOutlineTrack(node.id, node.path, reshaped);
      else if (reshaped && node.type === 'shape' && isRegion(node.shape)) outline = buildOutlineTrack(node.id, node.shape, reshaped);
    } catch (e) {
      fail(`${where}: ${(e as Error).message}`);
    }
    if (onGlobe && node.type === 'stroke') {
      const w = `${where}: stroke "${node.id}" is a line on the globe "${onGlobe.id}"`;
      if (node.rise !== undefined) fail(`${w}: it lies on the surface; it cannot have a rise`);
      if (node.dash) fail(`${w}: it is drawn as a solid line; leave dash out`);
      if (strokePulses.has(d.index)) fail(`${w}: pulse cannot run along it; send a thing placed on the globe along its places instead`);
      if (reshapes.has(d.index) || driven.length > 0) fail(`${w}: its points are places on the globe; they are not reshaped or driven`);
      const keyed = [moves, turns, scales, popIns, popOuts, bumps].some((m) => (m.get(d.index)?.length ?? 0) > 0);
      if (node.at[0] !== 0 || node.at[1] !== 0 || node.rotation !== 0 || node.scale !== 1 || keyed) {
        fail(`${w}: its points are its places, and it turns with the globe: it has no at, rotation or scale of its own, and nothing moves, turns or scales it`);
      }
    }

    return {
      ...(onGlobe ? { globe: { index: d.parent, spec: onGlobe.globe!, r: onGlobe.shape.kind === 'circle' ? onGlobe.shape.r : 1 } } : {}),
      index: d.index,
      id: node.id,
      node,
      layer: d.layer,
      parent: d.parent,
      subtreeEnd: d.subtreeEnd,
      opacity,
      pos,
      rot,
      scale,
      link: linkTrack,
      lid: node.type === 'eye' ? buildLidTrack(node.open, opens.get(d.index) ?? []) : null,
      level: node.type === 'shape' && node.level ? buildLevelTrack(node.level.at, levels.get(d.index) ?? []) : null,
      stretch: squashes.has(d.index) ? buildStretchTrack(squashes.get(d.index)!) : null,
      axis: axisScales.has(d.index) ? buildAxisTrack(axisScales.get(d.index)!) : null,
      count: (node.type === 'text' || node.type === 'label') && node.count ? countTrackOf(node.id, node.count.from, counts.get(d.index) ?? []) : null,
      stroke: node.type === 'stroke' ? buildStrokeTrack(node.drawn, node.solid, draws.get(d.index) ?? [], solids.get(d.index) ?? [], strokePulses.get(d.index) ?? []) : null,
      outline,
      // A line without a widthTo has no track: it is as wide as it was made.
      width: (node.type === 'link' || node.type === 'stroke') && widths.has(d.index) ? buildWidthTrack(node.width, widths.get(d.index)!) : null,
      // A node without a rise has no track: it lies flat, as it always did.
      rise: (node.type === 'shape' || node.type === 'stroke') && node.rise !== undefined ? buildRiseTrack(node.rise, rises.get(d.index) ?? []) : null,
      // A shape without a fillTo, and a line without a colorTo, have no track: each keeps the colour it was given.
      fill:
        node.type === 'shape' && fills.has(d.index)
          ? buildFillTrack(
              colors['fill']!,
              fills.get(d.index)!.map((k) => ({ at: k.at, dur: k.dur, profile: k.profile, ramp: k.ramp, to: col(node, `fillTo at ${k.at} s: to`, k.to) })),
            )
          : (node.type === 'stroke' || node.type === 'link') && lineColours.has(d.index)
            ? buildFillTrack(
                colors['color']!,
                lineColours.get(d.index)!.map((k) => ({ at: k.at, dur: k.dur, profile: k.profile, ramp: k.ramp, to: col(node, `colorTo at ${k.at} s: to`, k.to) })),
              )
            : null,
      // A shape without a haze has none: it moves nothing.
      haze: node.type === 'shape' && node.haze ? { amount: buildRiseTrack(node.haze.amount, hazes.get(d.index) ?? []), noise: new Noise(spec.seed, `haze/${node.id}`) } : null,
      // An emitter without a rateTo has no track: it sends out the rate it was given.
      ...(node.type === 'emitter' && rates.has(d.index) ? { rate: buildRiseTrack(node.rate, rates.get(d.index)!) } : {}),
      clipIndex,
      bodySlot,
      springSlot,
      emitterSlot,
      springKind,
      springParams: springSpec ? springParams(springSpec) : null,
      fromIndex,
      toIndex,
      targetIndex,
      lookAtIndex,
      attachIndex,
      colors,
      particleColors,
      idleNoise,
      blinks,
      away,
      persp: away ? perspTracks[d.layer]! : null,
      plane: planeOf[d.index]!,
      hinge,
      depth,
      form,
      driven: driven.length > 0,
    };
  });

  // 4. Layers.
  const cam = spec.camera;
  const layers: CLayer[] = spec.layers.map((layer, li): CLayer => {
    const depth = layer.depth;
    const blur = layer.blur ?? (depth >= 0 ? cam.focus.far * depth : cam.focus.near * -depth);
    const pulls = blurKeys.get(li);
    return {
      spec: layer,
      nodes: layerNodes[li]!,
      parallax: layer.parallax ?? 1 / (1 + depth),
      blur,
      ...(pulls ? { focus: buildRiseTrack(blur, pulls) } : {}),
      tint: layer.tint ?? defaultTint(depth),
      persp: perspTracks[li]!,
      ordered: layer.perspective !== undefined || layerNodes[li]!.some((i) => nodes[i]!.depth !== null || (nodes[i]!.node as { depth?: number }).depth !== undefined),
      sorted: layerNodes[li]!.some((i) => ordersChildren(nodes[i]!.node)),
    };
  });

  const byId = new Map<string, CNode>();
  for (const n of nodes) byId.set(n.id, n);

  const sampledBackdrops = layers.flatMap((layer, li) => {
    const option = layer.spec.sampledBackdrop;
    if (option === undefined) return [];
    const why = `${where}: sampledBackdrop in layer "${layer.spec.id}"`;
    if (!option || typeof option !== 'object' || Object.keys(option).some(k => k !== 'group' && k !== 'frames' && k !== 'liveGlow')) fail(`${why}: expected {group, frames, liveGlow?}`);
    if (option.liveGlow !== undefined && typeof option.liveGlow !== 'boolean') fail(`${why}: liveGlow must be a boolean`);
    const root = byId.get(option.group);
    if (!root || root.layer !== li || root.parent !== -1 || root.node.type !== 'group') fail(`${why}: group must name a top-level group of this layer`);
    if (!Array.isArray(option.frames)) fail(`${why}: frames must be an array of global shot frame numbers`);
    let previous = -1;
    for (const f of option.frames) {
      if (!Number.isSafeInteger(f) || f < 0 || f >= frames || f <= previous) fail(`${why}: frames must be strictly increasing integers in 0..${frames - 1}`);
      previous = f;
    }
    const inside = (i: number) => root.index <= i && i <= root.subtreeEnd;
    let liveGlow = false;
    for (const n of nodes) {
      const captured = inside(n.index);
      const glowing = 'glow' in n.node && n.node.glow > 0;
      const keepGlow = option.liveGlow && (n.node.type === 'shape' || n.node.type === 'stroke');
      if (captured && glowing && keepGlow) liveGlow = true;
      if (captured && ((n.node.type === 'shape' && (n.node.cover || n.haze)) ||
        (glowing && !keepGlow) || n.stroke?.pulses.length || n.link?.pulses.length)) {
        fail(`${why}: "${n.id}" uses glow, a pulse, a cover or heat haze that interacts with live drawing`);
      }
      const refs = [n.clipIndex, n.fromIndex, n.toIndex, n.targetIndex, n.lookAtIndex, n.attachIndex];
      if (refs.some(i => i >= 0 && inside(i) !== captured)) fail(`${why}: "${n.id}" has a reference across the sampled group boundary`);
    }
    return [{ layer: li, group: root, frames: [...new Set([0, ...option.frames, frames - 1])], ...(liveGlow ? { liveGlow: true as const } : {}) }];
  });

  // A plane that stands things on a ground: the ground is a relief among its own children.
  let grounds: Map<number, number[]> | null = null;
  for (const n of nodes) {
    if (n.node.type !== 'group' || n.node.ground === undefined) continue;
    const ids = typeof n.node.ground === 'string' ? [n.node.ground] : n.node.ground;
    const list = ids.map((id) => {
      const g = byId.get(id);
      if (!g || g.parent !== n.index || g.node.type !== 'shape' || !g.node.relief) {
        fail(`${where}: group "${n.id}" stands on the ground "${id}": that is a relief listed among the group's own children`);
      }
      return g.index;
    });
    if (new Set(list).size !== list.length) fail(`${where}: group "${n.id}" names a relief of its ground twice`);
    (grounds ??= new Map()).set(n.index, list.sort((a, b) => a - b));
  }
  // Shadows laid on a ground need one under them.
  for (const n of nodes) {
    if (n.node.type !== 'group' || !n.node.cast?.ground) continue;
    if (!(n.plane >= 0 && grounds?.has(n.plane))) {
      fail(`${where}: group "${n.id}" lays its shadows on the ground (cast.ground), and it lies in no plane with a ground: give its plane a ground (a relief among the plane group's children), or leave cast.ground out`);
    }
  }

  // 5. Intended exceptions to the motion review and to the physics review must
  // name things that exist, so that an exception does not outlive the node it
  // was written for.
  const subjects = new Set<string>([
    CAMERA_SUBJECT,
    FRAME_SUBJECT,
    ...FRAME_REGIONS.map((r) => `(frame:${r})`),
    ...spec.layers.filter((layer) => layer.perspective).map((layer) => perspectiveSubject(layer.id)),
    ...spec.layers.filter((_, li) => blurKeys.has(li)).map((layer) => focusSubject(layer.id)),
  ]);
  for (const x of spec.intended ?? []) {
    if (!x || typeof x !== 'object' || !Array.isArray(x.nodes) || !FINDING_KINDS_ALL.includes(x.kind)) {
      fail(`${where}: intended holds something that was not made with intended()`);
    }
    for (const id of x.nodes) {
      if (!byId.has(id) && !subjects.has(id)) {
        fail(`${where}: intended(..., "${x.kind}") names "${id}", which does not exist (nodes: ${known()}; or ${[...subjects].join(', ')})`);
      }
    }
  }

  // Text does not influence the bake, so the tables stay out of the hash; a
  // translation re-renders without re-baking. The same holds for the intended
  // exceptions of the reviews and their settings, which only change a report, and for everything
  // about sound: a sound key on a node or on an intent, and a sound placed by
  // hand, change neither the bake nor a pixel.
  // The contrast review reads the shot and changes nothing in it either.
  for (const id of spec.contrast?.nodes ?? []) {
    const n = byId.get(id);
    if (!n) fail(`${where}: contrast names "${id}", which does not exist (nodes: ${known()})`);
    if (!['shape', 'stroke', 'text', 'label'].includes(n.node.type)) {
      fail(`${where}: contrast names ${n.node.type} "${id}"; it holds shapes, strokes, texts and labels: name the shapes that are in the group`);
    }
  }
  // Of the palette it takes what a frame is drawn with: the colours, and the hues its light leans to when they
  // are not the default lean (a palette that names the default is the picture of one that names nothing). The
  // rules a palette declares only change a report.
  const tones = toneHues(palette);
  const ownTones = tones.shadow === SHADOW_HUE && tones.highlight === HIGHLIGHT_HUE ? undefined : tones;
  const sceneHash = hashOf({
    ...(voiced ? withoutSound(spec) : spec),
    palette: { ...spec.palette.spec, rules: undefined, tones: ownTones },
    strings: null,
    intended: undefined,
    contrast: undefined,
  });

  const background = {
    inner: resolveColorOrFail(palette, spec.background.inner, `${where} background.inner`),
    outer: resolveColorOrFail(palette, spec.background.outer, `${where} background.outer`),
  };
  const atmosphere = resolveColorOrFail(palette, spec.atmosphere, `${where} atmosphere`);
  // The keys of the background, with their colours resolved. A shot without any has no track.
  const backgroundTrack =
    backgroundKeys.length === 0
      ? null
      : buildBackgroundTrack(
          { ...background, center: spec.background.center, radius: spec.background.radius, atmosphere, vignette: spec.vignette },
          backgroundKeys.map((k) => {
            const colour = (name: 'inner' | 'outer' | 'atmosphere'): Record<string, string> =>
              k[name] === undefined ? {} : { [name]: resolveColorOrFail(palette, k[name], `${where}: backgroundTo at ${k.at} s: ${name}`) };
            return {
              at: k.at,
              dur: k.dur,
              profile: k.profile,
              ramp: k.ramp,
              to: {
                ...colour('inner'),
                ...colour('outer'),
                ...colour('atmosphere'),
                ...(k.center === undefined ? {} : { center: k.center }),
                ...(k.radius === undefined ? {} : { radius: k.radius }),
                ...(k.vignette === undefined ? {} : { vignette: k.vignette }),
              },
            };
          }),
        );

  return {
    spec,
    frames,
    nodes,
    byId,
    layers,
    bodies,
    springs,
    emitters,
    light: lightVector(spec.light),
    cameraNoise: new Noise(spec.seed, 'camera'),
    background,
    atmosphere,
    tones,
    stringKeys: [...stringKeys],
    sceneHash,
    ...(sampledBackdrops.length ? { sampledBackdrops } : {}),
    covers: nodes.filter((n) => n.node.type === 'shape' && n.node.cover === true).map((n) => n.index),
    clips: nodes.some((n) => n.clipIndex >= 0),
    cameraTrack: cameraKeys.length > 0 || zoomKeys.length > 0 ? buildCameraTrack(spec.camera, frames, cameraKeys, zoomKeys) : null,
    backgroundTrack,
    spatial: perspTracks.some((track) => track !== null),
    risen: nodes.some((n) => n.rise !== null || n.pos?.lifts === true || (n.node.type === 'shape' && n.node.stands === true)),
    sorted: nodes.some((n) => sortsChildren(n.node)),
    grounds,
    detail: detailLevels(nodes),
  };
}

/** The detail each node is worth: that of the nearest group above it that says so. A node comes after its parent. */
function detailLevels(nodes: readonly CNode[]): number[] | null {
  if (!nodes.some((n) => n.node.type === 'group' && n.node.detail !== undefined)) return null;
  const out: number[] = [];
  for (const n of nodes) {
    const above = n.parent >= 0 ? out[n.parent]! : -1;
    out.push(n.node.type === 'group' && n.node.detail !== undefined ? n.node.detail.min : above);
  }
  return out;
}

/** The name the camera of a perspective layer has in the motion review, and in intended(). */
export function perspectiveSubject(layerId: string): string {
  return `(perspective:${layerId})`;
}

/** The name the focus of a layer whose focus is pulled (blurTo) has in the motion review, and in intended(). */
export function focusSubject(layerId: string): string {
  return `(focus:${layerId})`;
}

/**
 * A node with a second ink marks its runs in its string, in every language: the marks must be sound, and every
 * language must mark at least one run, or a translation that lost its marks would be drawn in one ink unseen.
 */
function markedRuns(tables: StringTables, what: string, key: string): void {
  for (const lang of Object.keys(tables)) {
    const words = resolveString(tables, lang, key);
    let runs: number;
    try {
      runs = parseRuns(words).runs.length;
    } catch (e) {
      if (!(e instanceof RunMarkupError)) throw e;
      return fail(`${what} has runInk: its string "${key}" [${lang}] is ${JSON.stringify(words)}, and ${e.message}. Mark a run as ${RUN_OPEN}words${RUN_CLOSE}; a bracket of the text cannot be written in a node with runInk`);
    }
    if (runs === 0) fail(`${what} has runInk, but its string "${key}" [${lang}] marks no run: ${JSON.stringify(words)}. Mark what the second ink draws as ${RUN_OPEN}words${RUN_CLOSE} in every language, or leave runInk out`);
  }
}

/** The track of a counter; a key that cannot be is reported as a mistake of the shot. */
function countTrackOf(id: string, from: number, keys: readonly CountToKey[]): CountTrack {
  try {
    return buildCountTrack(id, from, keys);
  } catch (e) {
    return fail((e as Error).message);
  }
}

/** The shot as it is without its sound: no sound key on a node or on an intent, no sound placed by hand. */
function withoutSound(spec: ShotSpec): ShotSpec {
  const mute = (node: SceneNode): SceneNode => {
    const quiet = { ...node, sound: undefined };
    return quiet.type === 'shape' || quiet.type === 'group' ? { ...quiet, children: quiet.children.map(mute) } : quiet;
  };
  return {
    ...spec,
    layers: spec.layers.map((layer) => ({ ...layer, nodes: layer.nodes.map(mute) })),
    timeline: spec.timeline.filter((key) => key.kind !== 'sfx').map((key) => ({ ...key, sound: undefined })),
  };
}

function resolveColorOrFail(palette: Palette, value: string, what: string): string {
  try {
    return resolveColor(palette, value);
  } catch (e) {
    return fail(`${what}: ${(e as Error).message}`);
  }
}
