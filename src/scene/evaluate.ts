// Evaluating a shot at a frame: a pure function of the compiled shot, the bake,
// the frame number and the language. The result is a display list the renderer
// draws without further decisions.

import { cameraAt, layerView, type CameraState, type LayerView } from '../camera/camera.ts';
import { DEG, quadSub, vrot, xfCompose, XF_IDENTITY, type Quad, type Vec2, type Xf } from '../core/math.ts';
import { FPS } from '../core/time.ts';
import { pulseSpan } from '../motion/curves.ts';
import { samplePos, sampleReveal, sampleRot, sampleScale } from '../motion/tracks.ts';
import type { Bake } from '../physics/cache.ts';
import { reach } from '../shape/geometry.ts';
import { labelGeometry, LABEL_PROPORTIONS, type LabelGeometry } from '../text/label.ts';
import { layoutText, type TextLayout } from '../text/layout.ts';
import { resolveString } from '../text/strings.ts';
import { BLINK, type CLayer, type CNode, type CompiledShot } from './compile.ts';
import type { LabelSide } from './types.ts';

/** Where the state with history comes from: the bake, or the bake in progress. */
export interface PoseSource {
  /** Pose of a rigid body at a frame. */
  body(slot: number, frame: number): { x: number; y: number; rot: number };
  /** Position of a spring-driven point at a frame; `rest` is where it would be without the spring. */
  spring(slot: number, frame: number, rest: Vec2): Vec2;
}

export function posesFromBake(bake: Bake): PoseSource {
  return {
    body: (slot, frame) => ({ x: bake.bodyX(slot, frame), y: bake.bodyY(slot, frame), rot: bake.bodyRot(slot, frame) }),
    spring: (slot, frame) => [bake.springX(slot, frame), bake.springY(slot, frame)],
  };
}

const SIDE_DIR: Readonly<Record<LabelSide, Vec2>> = {
  top: [0, -1],
  bottom: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

/** How far a node reaches from its origin in a world direction, in units of its layer. */
function reachOf(n: CNode, xf: Xf, dir: Vec2): number {
  const node = n.node;
  if (node.type === 'shape') return reach(node.shape, vrot(dir, -xf.rot)) * xf.scale;
  if (node.type === 'eye') return node.r * xf.scale;
  return 0;
}

/**
 * World transforms of all nodes at a frame, in the space of their layer.
 * For a label the transform holds the tip of its tail and its pop scale.
 * Nodes without a place of their own (links, emitters) get the identity.
 */
export function computeWorld(c: CompiledShot, frame: number, poses: PoseSource): Xf[] {
  const t = frame / FPS;
  const out: Xf[] = new Array<Xf>(c.nodes.length).fill(XF_IDENTITY);

  for (const n of c.nodes) {
    const node = n.node;
    if (node.type !== 'shape' && node.type !== 'group' && node.type !== 'eye') continue;
    const scale = node.scale * (n.scale ? sampleScale(n.scale, t) : 1);
    if (n.bodySlot >= 0) {
      const p = poses.body(n.bodySlot, frame);
      out[n.index] = { x: p.x, y: p.y, rot: p.rot, scale };
      continue;
    }
    let [x, y] = samplePos(n.pos!, t);
    if (n.idleNoise && node.type !== 'eye' && node.idle) {
      const u = t / node.idle.period;
      x += node.idle.amp * n.idleNoise.n1(u);
      y += node.idle.amp * n.idleNoise.n1(u + 71.3);
    }
    const parent = n.parent >= 0 ? out[n.parent]! : XF_IDENTITY;
    let xf = xfCompose(parent, { x, y, rot: sampleRot(n.rot!, t) * DEG, scale });
    if (n.springKind === 'follow') {
      const p = poses.spring(n.springSlot, frame, [xf.x, xf.y]);
      xf = { ...xf, x: p[0], y: p[1] };
    } else if (n.springKind === 'sway' && node.type === 'shape' && node.shape.kind === 'capsule') {
      // The free end is the spring-driven point; the stick turns to reach it.
      const lever = (node.shape.length - 2 * node.shape.r) * Math.max(xf.scale, 0.05);
      const rest: Vec2 = [xf.x + Math.cos(xf.rot) * lever, xf.y + Math.sin(xf.rot) * lever];
      const tip = poses.spring(n.springSlot, frame, rest);
      const dx = tip[0] - xf.x;
      const dy = tip[1] - xf.y;
      if (Math.hypot(dx, dy) > 1e-6) xf = { ...xf, rot: Math.atan2(dy, dx) };
    }
    out[n.index] = xf;
  }

  for (const n of c.nodes) {
    const node = n.node;
    if (node.type !== 'label') continue;
    const target = c.nodes[n.targetIndex]!;
    const txf = out[n.targetIndex]!;
    const dir = SIDE_DIR[node.side];
    const d = reachOf(target, txf, dir) + node.gap;
    let tip: Vec2 = [txf.x + dir[0] * d, txf.y + dir[1] * d];
    if (n.springKind === 'follow') tip = poses.spring(n.springSlot, frame, tip);
    out[n.index] = { x: tip[0], y: tip[1], rot: 0, scale: n.scale ? sampleScale(n.scale, t) : 1 };
  }
  return out;
}

export interface ShapeItem {
  readonly kind: 'shape';
  readonly node: CNode;
  readonly xf: Xf;
}

export interface EyeItem {
  readonly kind: 'eye';
  readonly node: CNode;
  readonly xf: Xf;
  /** Pupil offset in the eye's local space, as a fraction of its free travel (length 0..1). */
  readonly look: Vec2;
  /** 1 = open, near 0 = closed. */
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
}

export interface LabelItem {
  readonly kind: 'label';
  readonly node: CNode;
  /** Tip of the pointer tail. */
  readonly tip: Vec2;
  readonly scale: number;
  readonly geometry: LabelGeometry;
  readonly layout: TextLayout;
}

export interface ParticlesItem {
  readonly kind: 'particles';
  readonly node: CNode;
  /** x, y, radius, colour index per particle. */
  readonly data: Float32Array;
}

export type Item = ShapeItem | EyeItem | LinkItem | LabelItem | ParticlesItem;

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

/** Scale below which a node is treated as hidden. */
const HIDDEN = 1e-3;

function eyeOpen(blinks: readonly number[], t: number): number {
  for (const b of blinks) {
    if (b > t) break;
    const tau = t - b;
    if (tau < BLINK.seconds) return Math.max(0.06, 1 - Math.sin((Math.PI * tau) / BLINK.seconds));
  }
  return 1;
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
  const camera = cameraAt(c.spec.camera, c.cameraNoise, frame, c.frames);

  const layers = c.layers.map((layer): LayerState => {
    const items: Item[] = [];
    for (const index of layer.nodes) {
      const n = c.nodes[index]!;
      const node = n.node;
      const xf = world[index]!;
      switch (node.type) {
        case 'group':
          break;
        case 'shape':
          if (xf.scale > HIDDEN && node.opacity > 0) items.push({ kind: 'shape', node: n, xf });
          break;
        case 'eye': {
          if (xf.scale <= HIDDEN) break;
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
          items.push({ kind: 'eye', node: n, xf, look, open: eyeOpen(n.blinks, t) });
          break;
        }
        case 'link': {
          const a = world[n.fromIndex]!;
          const b = world[n.toIndex]!;
          if (a.scale <= HIDDEN || b.scale <= HIDDEN) break;
          const reveal = sampleReveal(n.link!, t);
          if (reveal <= 0) break;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          if (len < 1e-6) break;
          const dir: Vec2 = [dx / len, dy / len];
          const r0 = reachOf(c.nodes[n.fromIndex]!, a, dir) + node.gap;
          const r1 = reachOf(c.nodes[n.toIndex]!, b, [-dir[0], -dir[1]]) + node.gap;
          if (len <= r0 + r1 + 1) break;
          const mid: Vec2 = [(a.x + b.x) / 2 - dir[1] * node.bend * len, (a.y + b.y) / 2 + dir[0] * node.bend * len];
          const curve = quadSub([[a.x, a.y], mid, [b.x, b.y]], r0 / len, 1 - r1 / len);
          const pulses: { head: number; tail: number }[] = [];
          for (const p of n.link!.pulses) {
            const span = pulseSpan(t, p.at, p.dur);
            if (span && span.head > span.tail) pulses.push(span);
          }
          items.push({ kind: 'link', node: n, curve, reveal, pulses });
          break;
        }
        case 'label': {
          if (xf.scale <= HIDDEN) break;
          const { layout, geometry } = labelLayout(c, n, lang);
          items.push({ kind: 'label', node: n, tip: [xf.x, xf.y], scale: xf.scale, geometry, layout });
          break;
        }
        case 'emitter': {
          const data = bake.particlesAt(n.emitterSlot, frame);
          if (data.length > 0) items.push({ kind: 'particles', node: n, data });
          break;
        }
      }
    }
    return { layer, view: layerView(camera, layer.parallax), items };
  });

  return { frame, time: t, lang, camera, layers };
}
