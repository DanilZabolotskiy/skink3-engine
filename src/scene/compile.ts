// Compiles a shot description into the form the evaluator, the bake and the
// renderer work with: a flat node list in draw order, resolved references and
// colours, per-node tracks built from the timeline, and slots in the bake.
// Compiling also validates the shot as a whole.

import { springParams, type SpringParams } from '../core/dynamics.ts';
import { buildCameraTrack, type CameraTrack } from '../camera/camera.ts';
import { hashOf } from '../core/hash.ts';
import type { Vec2 } from '../core/math.ts';
import { Noise } from '../core/noise.ts';
import { Rng } from '../core/rng.ts';
import { frameCount } from '../core/time.ts';
import { lightVector } from '../look/light.ts';
import { resolveColor, type Palette } from '../look/palette.ts';
import { PULSE_BUMP } from '../motion/intents.ts';
import type {
  BackgroundToKey,
  BendToKey,
  BumpKey,
  CameraToKey,
  CountToKey,
  DrawOnKey,
  FadeToKey,
  HopKey,
  Key,
  LevelToKey,
  MoveToKey,
  OpenToKey,
  PopInKey,
  PopOutKey,
  PulseKey,
  ReshapeKey,
  ScaleToKey,
  SolidToKey,
  SquashKey,
  TravelKey,
  TurnToKey,
} from '../motion/intents.ts';
import {
  buildAxisTrack,
  buildCountTrack,
  buildLevelTrack,
  buildLidTrack,
  buildLinkTrack,
  buildOpacityTrack,
  buildPosTrack,
  buildRotTrack,
  buildScaleTrack,
  buildStretchTrack,
  buildStrokeTrack,
  type AxisTrack,
  type CountTrack,
  type LevelTrack,
  type LidTrack,
  type LinkTrack,
  type OpacityTrack,
  type PosTrack,
  type RotTrack,
  type ScaleTrack,
  type StretchTrack,
  type StrokeTrack,
} from '../motion/tracks.ts';
import { COUNT_MARK } from '../text/count.ts';
import { isRegion } from '../shape/geometry.ts';
import { buildBackgroundTrack, type BackgroundTrack } from './background.ts';
import { buildOutlineTrack, type OutlineTrack } from './outline.ts';
import { resolveString } from '../text/strings.ts';
import { CAMERA_SUBJECT, FINDING_KINDS_ALL, FRAME_REGIONS, FRAME_SUBJECT, type LayerSpec, type SceneNode, type ShotSpec } from './types.ts';

export class CompileError extends Error {}

export interface CNode {
  readonly index: number;
  readonly id: string;
  readonly node: SceneNode;
  readonly layer: number;
  /** Index of the parent node, or -1 for a top-level node. */
  readonly parent: number;
  /** Index of the last node of this node's subtree (its own index if it has no children). */
  readonly subtreeEnd: number;
  /** Opacity over time; null for nodes that have none (emitters). */
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
}

export interface CLayer {
  readonly spec: LayerSpec;
  /** Node indices of this layer in draw order. */
  readonly nodes: readonly number[];
  readonly parallax: number;
  /** Blur radius in units. */
  readonly blur: number;
  /** 0..1 atmospheric tint. */
  readonly tint: number;
}

export interface CompiledShot {
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
  /** String keys the scene uses. */
  readonly stringKeys: readonly string[];
  /** Hash of everything that can influence the bake. */
  readonly sceneHash: string;
  /** Node indices of the shapes marked as covers, in draw order; empty in a shot without any. */
  readonly covers: readonly number[];
  /** True when some node is clipped to a shape. */
  readonly clips: boolean;
  /** The camera keys of the shot, or null: the camera does only what the shot's `camera` says. */
  readonly cameraTrack: CameraTrack | null;
  /** The background keys of the shot, or null: the background is what the shot says on every frame. */
  readonly backgroundTrack: BackgroundTrack | null;
}

type Placed = Extract<SceneNode, { type: 'shape' | 'group' | 'eye' | 'stroke' | 'text' }>;

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
  const pulses = new Map<number, PulseKey[]>();
  const strokePulses = new Map<number, PulseKey[]>();
  const reshapes = new Map<number, ReshapeKey[]>();
  const opens = new Map<number, OpenToKey[]>();
  const askedBlinks = new Map<number, number[]>();
  const cameraKeys: CameraToKey[] = [];
  const backgroundKeys: BackgroundToKey[] = [];
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
    if (key.kind === 'backgroundTo') {
      // A key of the background: it has no node either.
      if (key.at > spec.seconds) fail(`${where}: backgroundTo starts at ${key.at} s, after the shot ends (${spec.seconds} s)`);
      backgroundKeys.push(key);
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
        push(turns, index, key);
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
        need(node.type !== 'emitter', 'shapes, groups, eyes, strokes, texts, labels and links');
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
        if (node.type !== 'text' || !node.count) fail(`${where}: countTo cannot target ${node.type} "${node.id}"; it applies to a text that is a counter (give the text the option count)`);
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

    if (node.type !== 'label' && node.type !== 'eye' && node.clipTo) {
      const index = idIndex.get(node.clipTo);
      if (index === undefined) fail(`${where}: ${node.type} "${node.id}" clipTo refers to "${node.clipTo}", which does not exist (nodes: ${known()})`);
      const other = drafts[index]!;
      if (other.node.type !== 'shape') fail(`${where}: ${node.type} "${node.id}" clipTo refers to ${other.node.type} "${node.clipTo}"; it must be a shape`);
      if (other.layer !== d.layer) fail(`${where}: ${node.type} "${node.id}" and the shape it is clipped to, "${node.clipTo}", must be in the same layer`);
      if (index >= d.index && index <= d.subtreeEnd) fail(`${where}: ${node.type} "${node.id}" cannot be clipped to itself or to something inside it ("${node.clipTo}")`);
      clipIndex = index;
    }

    switch (node.type) {
      case 'shape':
        colors['fill'] = col(node, 'fill', node.fill);
        if (node.rimLight) colors['rimLight'] = col(node, 'rimLight', node.rimLight);
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
          try {
            resolveString(spec.strings, lang, node.text);
          } catch (e) {
            fail(`${where}: label "${node.id}": ${(e as Error).message}`);
          }
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
    try {
      if (isPlaced(node)) {
        pos = buildPosTrack(node.id, node.at, moves.get(d.index) ?? []);
        rot = buildRotTrack(node.id, node.rotation, turns.get(d.index) ?? []);
        if (pos.turns && rot.segs.length > 0) {
          fail(`"${node.id}" has a travel that rolls or orients it and a turnTo; a node is turned by one or the other`);
        }
      }
      if (isPlaced(node) || node.type === 'label') {
        scale = buildScaleTrack(node.id, popIns.get(d.index) ?? [], popOuts.get(d.index) ?? [], bumps.get(d.index) ?? [], scales.get(d.index) ?? []);
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

    return {
      index: d.index,
      id: node.id,
      node,
      layer: d.layer,
      parent: d.parent,
      subtreeEnd: d.subtreeEnd,
      opacity: node.type === 'emitter' ? null : buildOpacityTrack(node.opacity, fades.get(d.index) ?? []),
      pos,
      rot,
      scale,
      link: linkTrack,
      lid: node.type === 'eye' ? buildLidTrack(node.open, opens.get(d.index) ?? []) : null,
      level: node.type === 'shape' && node.level ? buildLevelTrack(node.level.at, levels.get(d.index) ?? []) : null,
      stretch: squashes.has(d.index) ? buildStretchTrack(squashes.get(d.index)!) : null,
      axis: axisScales.has(d.index) ? buildAxisTrack(axisScales.get(d.index)!) : null,
      count: node.type === 'text' && node.count ? countTrackOf(node.id, node.count.from, counts.get(d.index) ?? []) : null,
      stroke: node.type === 'stroke' ? buildStrokeTrack(node.drawn, node.solid, draws.get(d.index) ?? [], solids.get(d.index) ?? [], strokePulses.get(d.index) ?? []) : null,
      outline,
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
    };
  });

  // 4. Layers.
  const cam = spec.camera;
  const layers: CLayer[] = spec.layers.map((layer, li): CLayer => {
    const depth = layer.depth;
    return {
      spec: layer,
      nodes: layerNodes[li]!,
      parallax: layer.parallax ?? 1 / (1 + depth),
      blur: layer.blur ?? (depth >= 0 ? cam.focus.far * depth : cam.focus.near * -depth),
      tint: layer.tint ?? defaultTint(depth),
    };
  });

  const byId = new Map<string, CNode>();
  for (const n of nodes) byId.set(n.id, n);

  // 5. Intended exceptions to the motion review and to the physics review must
  // name things that exist, so that an exception does not outlive the node it
  // was written for.
  const subjects = new Set<string>([CAMERA_SUBJECT, FRAME_SUBJECT, ...FRAME_REGIONS.map((r) => `(frame:${r})`)]);
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
  // exceptions of the reviews, which only change a report, and for everything
  // about sound: a sound key on a node or on an intent, and a sound placed by
  // hand, change neither the bake nor a pixel.
  const sceneHash = hashOf({ ...(voiced ? withoutSound(spec) : spec), palette: spec.palette.spec, strings: null, intended: undefined });

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
    stringKeys: [...stringKeys],
    sceneHash,
    covers: nodes.filter((n) => n.node.type === 'shape' && n.node.cover === true).map((n) => n.index),
    clips: nodes.some((n) => n.clipIndex >= 0),
    cameraTrack: cameraKeys.length > 0 ? buildCameraTrack(spec.camera, frames, cameraKeys) : null,
    backgroundTrack,
  };
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
