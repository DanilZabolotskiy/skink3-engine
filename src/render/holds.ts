import { cameraAt, layerView } from '../camera/camera.ts';
import { FPS } from '../core/time.ts';
import type { Bake } from '../physics/cache.ts';
import type { CNode, CompiledShot } from '../scene/compile.ts';
import { perspAt } from '../scene/space.ts';
import type { ImageData } from 'skia-canvas';

export interface HeldRange {
  first: number;
  last: number;
  plane: number;
  layer: number;
  anchor: number;
}
interface Held {
  block: number;
  width: number;
  lang: string;
  gpu: boolean;
  bake: Bake;
  view: CompiledShot;
  ranges: HeldRange[];
  images: Map<number, ImageData>;
}
const sessions = new WeakMap<CompiledShot, Held>();
const BLOCK = 48;
const known = new Set([
  'fadeTo',
  'fillTo',
  'colorTo',
  'riseTo',
  'sunTo',
  'widthTo',
  'solidTo',
  'drawOn',
  'moveTo',
  'turnTo',
  'scaleTo',
  'reshape',
  'pulse',
  'travel',
]);

const cameraHolds = new WeakMap<CompiledShot, Map<number, Int32Array>>();
/** First frame of the uninterrupted view at each frame. Comparing all integer frames also catches a return to a former camera. */
function holdStarts(c: CompiledShot, i: number): Int32Array {
  let byLayer = cameraHolds.get(c);
  if (!byLayer) {
    byLayer = new Map();
    cameraHolds.set(c, byLayer);
  }
  const saved = byLayer.get(i);
  if (saved) return saved;
  const l = c.layers[i]!,
    starts = new Int32Array(c.frames);
  let previous = '',
    start = 0;
  for (let f = 0; f < c.frames; f++) {
    const v = layerView(cameraAt(c.spec.camera, c.cameraNoise, f, c.frames, c.cameraTrack), l.parallax);
    const p = l.persp && perspAt(l.persp, f / FPS);
    const key = JSON.stringify([v, p]);
    if (previous !== key) start = f;
    starts[f] = start;
    previous = key;
  }
  byLayer.set(i, starts);
  return starts;
}

function plan(c: CompiledShot, lo: number, hi: number): HeldRange[] {
  if (!c.spatial || c.nodes.length < 384) return [];
  const moving = new Set<number>(),
    targeted = new Set<number>();
  const lastChange = new Int32Array(c.nodes.length);
  for (const k of c.spec.timeline) {
    if (!('target' in k) || !k.target || k.kind === 'sfx') continue;
    const n = c.byId.get(k.target);
    if (!n) continue;
    targeted.add(n.index);
    if (known.has(k.kind) && 'dur' in k) {
      if (k.at > hi / FPS) continue;
      if (k.at + k.dur < lo / FPS) {
        lastChange[n.index] = Math.max(lastChange[n.index]!, Math.ceil((k.at + k.dur) * FPS));
        continue;
      }
    }
    moving.add(n.index);
  }
  const refs = new Set<number>();
  for (const n of c.nodes)
    for (const i of [n.clipIndex, ...n.clipAlso, n.targetIndex, n.fromIndex, n.toIndex, n.attachIndex, n.lookAtIndex]) if (i >= 0) refs.add(i);
  const active = (n: CNode) =>
    moving.has(n.index) ||
    n.driven ||
    n.idleNoise ||
    n.bodySlot >= 0 ||
    n.springSlot >= 0 ||
    n.emitterSlot >= 0 ||
    n.haze ||
    n.globe ||
    n.axis ||
    n.stretch;
  const ranges: HeldRange[] = [];
  for (const root of c.nodes) {
    const r = root.node,
      l = c.layers[root.layer]!;
    if (
      root.parent >= 0 ||
      r.type !== 'group' ||
      !r.plane ||
      root.subtreeEnd - root.index < 384 ||
      r.cast ||
      r.sort ||
      r.soft ||
      r.clipTo ||
      r.opacity !== 1 ||
      targeted.has(root.index) ||
      active(root) ||
      root.hinge ||
      l.focus ||
      (l.tint && c.backgroundTrack)
    )
      continue;
    const cameraStart = holdStarts(c, root.layer)[hi]!;
    if (cameraStart > lo) continue;
    const grounds = c.grounds?.get(root.index) ?? [];
    if (grounds.some((i) => active(c.nodes[i]!))) continue;
    let floorAnchor = cameraStart;
    for (const id of grounds) floorAnchor = Math.max(floorAnchor, lastChange[id]!);
    // In preorder, each subtree occupies one interval. Working upwards once avoids scanning a large mixed group
    // again at each level when a live sibling sits among several thousand still descendants.
    const count = root.subtreeEnd - root.index + 1;
    const blocked = new Uint8Array(count);
    const latest = lastChange.slice(root.index, root.subtreeEnd + 1);
    for (let j = root.subtreeEnd; j > root.index; j--) {
      const n = c.nodes[j]!,
        v = n.node,
        offset = j - root.index;
      if (
        active(n) ||
        refs.has(j) ||
        n.clipIndex >= 0 ||
        n.attachIndex >= 0 ||
        n.lookAtIndex >= 0 ||
        n.fromIndex >= 0 ||
        n.toIndex >= 0 ||
        n.targetIndex >= 0 ||
        n.hinge ||
        n.depth ||
        n.form ||
        (v.type !== 'shape' && v.type !== 'stroke' && v.type !== 'group') ||
        (v.type === 'shape' && (v.glow || v.cover || v.level || v.globe)) ||
        (v.type === 'stroke' && (v.glow || v.flow)) ||
        (v.type === 'group' && v.plane)
      )
        blocked[offset] = 1;
      const parent = n.parent - root.index;
      if (blocked[offset]) blocked[parent] = 1;
      latest[parent] = Math.max(latest[parent]!, latest[offset]!);
    }
    function visit(parent: CNode): void {
      let range: HeldRange | undefined;
      function finish(): void {
        if (range && range.last - range.first >= 96) ranges.push(range);
        range = undefined;
      }
      for (let i = parent.index + 1; i <= parent.subtreeEnd; ) {
        const child = c.nodes[i]!,
          v = child.node;
        if (!blocked[i - root.index]) {
          const anchor = Math.max(floorAnchor, latest[i - root.index]!);
          if (!range)
            range = {
              first: i,
              last: child.subtreeEnd,
              plane: root.index,
              layer: root.layer,
              anchor,
            };
          else {
            range.last = child.subtreeEnd;
            range.anchor = Math.max(range.anchor, anchor);
          }
        } else {
          finish();
          // This group contributes no item to the painter's order. Its children are still direct items of the plane.
          if (
            v.type === 'group' &&
            v.opacity === 1 &&
            !v.sort &&
            !v.cast &&
            !v.soft &&
            !v.clipTo &&
            !v.plane &&
            !active(child) &&
            !targeted.has(i) &&
            !child.hinge &&
            !child.depth &&
            !child.form &&
            child.attachIndex < 0 &&
            !refs.has(i)
          )
            visit(child);
        }
        i = child.subtreeEnd + 1;
      }
      finish();
    }
    visit(root);
  }
  return ranges.sort((a, b) => b.last - b.first - (a.last - a.first)).slice(0, 5);
}

/** Isolate only contiguous, immutable children of a held plane. All live references still use original node indices. */
export function heldFrame(
  c: CompiledShot,
  bake: Bake,
  frame: number,
  opts: { width: number; lang: string; gpu: boolean },
): Held | undefined {
  if (!c.spatial || c.nodes.length < 384 || frame < 0 || frame >= c.frames) return;
  const block = Math.floor(frame / BLOCK);
  let s = sessions.get(c);
  if (s && s.block === block && s.width === opts.width && s.lang === opts.lang && s.gpu === opts.gpu && s.bake === bake)
    return s;
  const first = block * BLOCK;
  let bytes = 0;
  const ranges = plan(c, first, Math.min(c.frames - 1, (block + 1) * BLOCK - 1)).filter((range) => {
    const layer = c.layers[range.layer]!;
    const k = opts.width / 1920;
    const view = layerView(cameraAt(c.spec.camera, c.cameraNoise, first, c.frames, c.cameraTrack), layer.parallax);
    const pad = Math.ceil(3 * Math.min(400 * k, layer.blur * k * view.zoom));
    const size = 4 * (opts.width + 2 * pad) * (Math.ceil((opts.width * 9) / 16) + 2 * pad + 1);
    if (bytes + size > 128 * 1024 * 1024) return false;
    bytes += size;
    return true;
  });
  let view = c;
  if (ranges.length) {
    const masks = new Uint8Array(c.nodes.length),
      ground = new Set<number>();
    for (const ids of c.grounds?.values() ?? []) for (const i of ids) ground.add(i);
    for (const r of ranges) {
      masks.fill(2, r.first, r.last + 1);
      masks[r.first] = 1;
    }
    view = {
      ...c,
      retainedMask: masks,
      activeNodes: c.nodes.filter((n) => !masks[n.index] || ground.has(n.index)),
    };
  }
  const images = new Map<number, ImageData>();
  if (s && s.bake === bake && s.width === opts.width && s.lang === opts.lang && s.gpu === opts.gpu) {
    for (const range of ranges) {
      const same = s.ranges.find((r) => r.first === range.first && r.last === range.last && r.anchor === range.anchor);
      const image = same && s.images?.get(same.first);
      if (image) images.set(range.first, image);
    }
  }
  s = {
    block,
    width: opts.width,
    lang: opts.lang,
    gpu: opts.gpu,
    bake,
    view,
    ranges,
    images,
  };
  sessions.set(c, s);
  return s;
}
