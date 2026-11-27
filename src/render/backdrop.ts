// A sampled group has the same frame schedule in a still, a render worker and a resumed chunk.
import { ImageData } from 'skia-canvas';
import { cameraAt, layerView } from '../camera/camera.ts';
import { FPS } from '../core/time.ts';
import { sampleAway, samplePathTurn, samplePos, sampleRot, sampleScale } from '../motion/tracks.ts';
import type { Bake } from '../physics/cache.ts';
import { sampleBackground } from '../scene/background.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { perspAt } from '../scene/space.ts';

type Backdrop = NonNullable<CompiledShot['sampledBackdrops']>[number];
type Capture = (group: Backdrop, frame: number) => ImageData;

const glowViews = new WeakMap<CompiledShot, Map<number, CompiledShot>>();

/** Only the original nodes needed for a sampled group's halos, with their original indices and bake slots. */
export function glowView(c: CompiledShot, source: Backdrop): CompiledShot {
  let views = glowViews.get(c);
  if (!views) { views = new Map(); glowViews.set(c, views); }
  const saved = views.get(source.group.index);
  if (saved) return saved;
  const needed = new Set<number>();
  for (let i = source.group.index; i <= source.group.subtreeEnd; i++) {
    const node = c.nodes[i]!.node;
    if ((node.type === 'shape' || node.type === 'stroke') && node.glow > 0) needed.add(i);
  }
  let ordinaryOrder = true;
  for (const i of needed) {
    const n = c.nodes[i]!;
    // New entries are visited in turn, including the parents and references of a sibling used as a mask.
    for (const index of [n.parent, n.plane, n.globe?.index ?? -1, n.clipIndex, ...n.clipAlso, n.lookAtIndex,
      n.targetIndex, n.fromIndex, n.toIndex, n.attachIndex]) {
      if (index >= 0) needed.add(index);
    }
    if (n.clipIndex >= 0) {
      const mask = c.nodes[n.clipIndex]!.node;
      // Skipping an intervening item can combine neighbouring clips; soft masks composite those differently.
      if ((mask.type === 'shape' && (mask.soft || mask.clipMask)) || n.clipAlso.length > 0) ordinaryOrder = false;
    }
    for (const ground of c.grounds?.get(i) ?? []) needed.add(ground);
    // A sorted or shadow-casting group's draw order may depend on the geometry of its unlit children.
    if (n.node.type === 'group' && (n.node.sort || n.node.cast)) ordinaryOrder = false;
  }
  // The sampled group is the only top-level item here. Within it, ordinary children stay in source order.
  const view = ordinaryOrder ? {
    ...c,
    activeNodes: c.nodes.filter(n => needed.has(n.index)),
    layers: c.layers.map((layer, i) => ({ ...layer, ordered: false, sorted: false,
      nodes: i === source.layer ? layer.nodes.filter(index => needed.has(index)) : [] })),
  } : c;
  views.set(source.group.index, view);
  return view;
}

/** Compact live traversal, leaving all indices used by the evaluator, its references and the original bake intact. */
function liveView(c: CompiledShot, groups: readonly Backdrop[]): CompiledShot {
  const nodes = [...c.nodes];
  const omitted = new Uint8Array(nodes.length);
  const layers = [...c.layers];
  for (const { group, layer } of groups) {
    nodes[group.index] = { ...group, subtreeEnd: group.index };
    omitted.fill(1, group.index + 1, group.subtreeEnd + 1);
    const old = layers[layer]!;
    layers[layer] = { ...old, sampledIndex: group.index, nodes: old.nodes.filter(i => !omitted[i]) };
  }
  return { ...c, nodes, layers, activeNodes: nodes.filter(n => !omitted[n.index]) };
}

/** Check every integer frame: matching endpoint cameras alone would miss an excursion and return. */
function heldIntervals(c: CompiledShot, source: Backdrop): boolean[] {
  const layer = c.layers[source.layer]!;
  const root = source.group;
  // These transforms depend on a bake, noise or a changing stretch pivot. Keep the whole group live.
  if (root.springSlot >= 0 || root.idleNoise || root.axis || root.stretch) return source.frames.slice(1).map(() => false);
  const viewAt = (f: number) => {
    const t = f / FPS;
    const view = layerView(cameraAt(c.spec.camera, c.cameraNoise, f, c.frames, c.cameraTrack), layer.parallax);
    const p = layer.persp ? perspAt(layer.persp, t) : null;
    return [view.tx, view.ty, view.zoom, ...(p ? [...p.aim, p.distance, p.tilt, p.turn, p.lens] : []),
      ...samplePos(root.pos!, t), sampleRot(root.rot!, t), sampleScale(root.scale!, t),
      root.pos!.turns ? samplePathTurn(root.pos!, t) : 0, root.away ? sampleAway(root.away, t) : 0,
      root.hinge?.x ? sampleRot(root.hinge.x, t) : 0, root.hinge?.y ? sampleRot(root.hinge.y, t) : 0,
      layer.tint && c.backgroundTrack ? sampleBackground(c.backgroundTrack, t).atmosphere : ''];
  };
  return source.frames.slice(1).map((end, i) => {
    const start = source.frames[i]!;
    if (end - start <= 1) return false;
    const first = viewAt(start);
    for (let f = start + 1; f <= end; f++) {
      if (viewAt(f).some((v, j) => v !== first[j])) return false;
    }
    return true;
  });
}

function interval(frames: readonly number[], f: number): number {
  let low = 0, high = frames.length - 1;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (frames[mid]! <= f) low = mid;
    else high = mid;
  }
  return low;
}

interface Sample { frame: number; image: ImageData }

class RasterPair {
  private first?: Sample;
  private second?: Sample;
  private changed?: Uint32Array;

  image(source: Backdrop, lo: number, hi: number, f: number, capture: Capture): ImageData {
    const fetch = (frame: number): Sample => {
      if (this.first?.frame === frame) return this.first;
      if (this.second?.frame === frame) return this.second;
      return { frame, image: capture(source, frame) };
    };
    // A still on an anchor only needs that one image. Keep the other endpoint when already materialized.
    if (f === lo || f === hi) {
      const sample = fetch(f);
      if (sample !== this.first && sample !== this.second) {
        this.first = sample; this.second = undefined; this.changed = undefined;
      }
      return sample.image;
    }
    const left = fetch(lo), right = fetch(hi);
    const a = left.image.data, b = right.image.data;
    if (this.first !== left || this.second !== right || !this.changed) {
      this.first = left; this.second = right;
      const n = a.length / 4;
      const aw = new Uint32Array(a.buffer, a.byteOffset, n), bw = new Uint32Array(b.buffer, b.byteOffset, n);
      const dirty = new Uint32Array(n);
      let count = 0;
      for (let i = 0; i < n; i++) if (aw[i] !== bw[i]) dirty[count++] = i * 4;
      this.changed = dirty.subarray(0, count);
    }
    if (!this.changed.length) return left.image;
    // Interpolate once in premultiplied colour. Common opaque or identical pixels avoid extra rounding and flicker.
    const t = (f - lo) / (hi - lo), result = new Uint8ClampedArray(a);
    for (const i of this.changed) {
      const aa = a[i + 3]!, ab = b[i + 3]!;
      const alpha = aa + (ab - aa) * t;
      const mix = aa === ab ? t : alpha > 0 ? ab * t / alpha : 0;
      for (let j = i; j < i + 3; j++) result[j] = a[j]! + (b[j]! - a[j]!) * mix;
      result[i + 3] = alpha;
    }
    return new ImageData(result, left.image.width, left.image.height);
  }
}

interface Session {
  bake: Bake; width: number; lang: string; gpu: boolean;
  groups: { source: Backdrop; held: boolean[]; pair: RasterPair }[];
  active: Backdrop[]; live: CompiledShot;
}
const sessions = new WeakMap<CompiledShot, Session>();

export function sampledFrame(c: CompiledShot, bake: Bake, f: number, opts: { width: number; lang: string; gpu: boolean; alone?: boolean }, capture: Capture) {
  // Leave invalid requests to evaluate(), which reports the same error as an ordinary frame.
  if (!Number.isInteger(f) || f < 0 || f >= c.frames) return { live: c, images: undefined };
  let session = sessions.get(c);
  if (!session || (opts.gpu && opts.alone) || session.bake !== bake || session.width !== opts.width || session.lang !== opts.lang || session.gpu !== opts.gpu) {
    session = { bake, width: opts.width, lang: opts.lang, gpu: opts.gpu, active: [], live: c,
      groups: c.sampledBackdrops!.map(source => ({ source, held: heldIntervals(c, source), pair: new RasterPair() })) };
    sessions.set(c, session);
  }
  const active: Backdrop[] = [];
  const images = new Map<number, ImageData>();
  for (const { source, held, pair } of session.groups) {
    let i = interval(source.frames, f);
    // An anchor at the end of a hold may also start a moving interval.
    if (!held[i] && i > 0 && source.frames[i] === f) i--;
    if (!held[i]) continue;
    images.set(source.group.index, pair.image(source, source.frames[i]!, source.frames[i + 1]!, f, capture));
    active.push(source);
  }
  if (active.length !== session.active.length || active.some((g, i) => session!.active[i] !== g)) {
    session.live = active.length ? liveView(c, active) : c;
    session.active = active;
  }
  return { live: session.live, images };
}
