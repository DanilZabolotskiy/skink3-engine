import type { CompiledShot } from '../scene/compile.ts';
import { selectByCell } from '../scene/map.ts';
import { xfApply, type Vec2 } from '../core/math.ts';
import { STAGE_W } from '../scene/types.ts';

interface Plan {
  view: CompiledShot;
  roofs: number;
  terrain: number;
  marks: number;
}
const plans = new WeakMap<CompiledShot, Map<number, Plan>>();

/** Select display detail for collections of small raised bodies, while keeping the compiled model and all its tracks. */
export function displayPlan(c: CompiledShot, width: number): Plan {
  let sizes = plans.get(c);
  if (!sizes) {
    sizes = new Map();
    plans.set(c, sizes);
  }
  const old = sizes.get(width);
  if (old) return old;
  let roofs = 0,
    terrain = 0,
    marks = 0;
  let view = c;
  if (c.spatial && c.nodes.length >= 256) {
    const counts = new Map<number, number>();
    for (const n of c.nodes) {
      if (n.plane >= 0 && n.node.type === 'shape' && n.node.roof && n.node.children.length === 0) {
        counts.set(n.parent, (counts.get(n.parent) ?? 0) + 1);
      }
    }
    const targets = new Set<number>();
    for (const n of c.nodes)
      for (const i of [n.clipIndex, ...n.clipAlso, n.targetIndex, n.attachIndex, n.fromIndex, n.toIndex, n.lookAtIndex]) {
        if (i >= 0) targets.add(i);
      }
    for (const id of [...(c.spec.contrast?.nodes ?? []), ...(c.spec.intended ?? []).flatMap((item) => item.nodes)]) {
      const n = c.byId.get(id);
      if (n) targets.add(n.index);
    }
    for (const k of c.spec.timeline)
      if ('target' in k && k.target) {
        const n = c.byId.get(k.target);
        if (n) targets.add(n.index);
      }
    const ink = new Float32Array(c.nodes.length);
    const facetRoofs = new Uint8Array(c.nodes.length);
    const collections = new Map<number, { index: number; at: Vec2 }[]>();
    const keep = (parent: number, index: number, at: Vec2) => {
      let items = collections.get(parent);
      if (!items) {
        items = [];
        collections.set(parent, items);
      }
      items.push({ index, at });
    };
    const stretched = new Uint8Array(c.nodes.length);
    const min = c.detail ? [...c.detail] : new Array<number>(c.nodes.length).fill(-1);
    // A plane is chosen once for the shot; a cut between moving and held frames never changes its resolution.
    // Overlays and planes containing any type remain at the full delivery resolution.
    const fullResolution = new Set(
      c.nodes
        .filter(
          ({ node }) =>
            node.type === 'label' ||
            node.type === 'text' ||
            (node.type === 'shape' && node.relief?.samplePixels) ||
            (node.type === 'stroke' && node.curveSteps) ||
            (node.type === 'group' && node.detail),
        )
        .map((n) => n.plane),
    );
    const eligiblePlanes = new Set(
      c.nodes
        .filter(
          (n) =>
            n.plane === n.index &&
            n.parent < 0 &&
            n.subtreeEnd - n.index >= 1536 &&
            width >= 960 &&
            !c.sampledBackdrops &&
            !fullResolution.has(n.index),
        )
        .map((n) => n.index),
    );
    const detailCount = new Uint32Array(c.nodes.length);
    const reliefs: number[] = [];
    const nodes = c.nodes.map((n) => {
      const shape = n.node;
      const parent = n.parent >= 0 ? c.nodes[n.parent]!.node : undefined;
      stretched[n.index] = Number(Boolean(n.axis || n.stretch || (n.parent >= 0 && stretched[n.parent])));
      if (n.plane < 0 || !parent) return n;
      if (
        !targets.has(n.index) &&
        !n.driven &&
        !n.idleNoise &&
        n.bodySlot < 0 &&
        n.springSlot < 0 &&
        n.index === n.subtreeEnd &&
        n.clipIndex < 0 &&
        !stretched[n.index]
      ) {
        if (
          shape.type === 'stroke' &&
          !shape.dash &&
          !shape.glow &&
          !n.rise &&
          !shape.path.closed &&
          shape.opacity <= 0.36 &&
          shape.path.points.length === 2 &&
          !shape.path.heights &&
          parent.type === 'group' &&
          parent.children.length >= 128
        ) {
          const [a, b] = shape.path.points;
          keep(
            n.parent,
            n.index,
            xfApply({ x: shape.at[0], y: shape.at[1], scale: shape.scale, rot: (shape.rotation * Math.PI) / 180 }, [
              (a![0] + b![0]) / 2,
              (a![1] + b![1]) / 2,
            ]),
          );
          ink[n.index] = Math.hypot(a![0] - b![0], a![1] - b![1]);
          marks++;
        } else if (
          shape.type === 'shape' &&
          shape.backdrop &&
          shape.opacity < 1 &&
          !shape.cover &&
          !shape.lit &&
          !shape.glow &&
          !shape.relief &&
          !shape.haze &&
          !shape.soft &&
          !shape.roof &&
          !shape.stands &&
          !shape.level &&
          shape.shape.kind === 'polygon' &&
          shape.shape.points.length === 4 &&
          parent.type === 'shape' &&
          parent.backdrop &&
          !parent.lit &&
          parent.children.length >= 2
        ) {
          const pts = shape.shape.points;
          keep(
            c.nodes[n.parent]!.parent,
            n.index,
            xfApply(
              { x: parent.at[0], y: parent.at[1], scale: parent.scale, rot: (parent.rotation * Math.PI) / 180 },
              shape.at,
            ),
          );
          ink[n.index] = Math.min(
            Math.hypot(pts[1]![0] - pts[0]![0], pts[1]![1] - pts[0]![1]),
            Math.hypot(pts[2]![0] - pts[1]![0], pts[2]![1] - pts[1]![1]),
          );
          marks++;
        }
      }
      if (shape.type !== 'shape' || n.plane < 0) return n;
      const repeatedRoof =
        shape.roof &&
        ((shape.roof.kind === 'dome' && shape.shape.kind === 'circle') ||
          ((shape.roof.kind === 'gable' || shape.roof.kind === 'hip') &&
            shape.shape.kind === 'polygon' &&
            shape.shape.points.length === 4 &&
            !shape.shape.smooth &&
            !shape.shape.rings &&
            shape.roof.ridge === undefined &&
            shape.roof.run === undefined));
      if (
        shape.roof &&
        repeatedRoof &&
        !shape.children.length &&
        !shape.glow &&
        !shape.cover &&
        !shape.lit &&
        !shape.openings &&
        !targets.has(n.index) &&
        (counts.get(n.parent) ?? 0) >= 12 &&
        min[n.index]! < 0
      ) {
        min[n.index] = (45 * STAGE_W) / width;
        roofs++;
        detailCount[n.plane] = detailCount[n.plane]! + 1;
        if (shape.roof.kind === 'hip' || shape.roof.kind === 'gable') facetRoofs[n.index] = 1;
      }
      if (shape.relief && !shape.relief.samplePixels && c.nodes[n.plane]!.subtreeEnd - n.plane >= 256) {
        terrain++;
        reliefs.push(n.index);
      }
      return n;
    });
    for (const items of collections.values()) {
      let x = Infinity,
        y = Infinity,
        right = -Infinity,
        bottom = -Infinity;
      for (const { at } of items) {
        x = Math.min(x, at[0]);
        right = Math.max(right, at[0]);
        y = Math.min(y, at[1]);
        bottom = Math.max(bottom, at[1]);
      }
      const size = Math.sqrt((Math.max(1, (right - x) * (bottom - y)) * 24) / items.length);
      const valid =
        Number.isFinite(size) && size > 0 && items.every((v) => v.at.every((t) => Number.isSafeInteger(Math.floor(t / size))));
      for (const sample of valid ? selectByCell(items, size, (v) => v.at) : items) {
        ink[sample.index] = 0;
        marks--;
      }
    }
    // One relief or a distant crowd on another plane must not lower the resolution of an unrelated feature.
    for (const n of c.nodes) if (ink[n.index]) detailCount[n.plane] = detailCount[n.plane]! + 1;
    for (const i of eligiblePlanes) {
      const plane = nodes[i]!;
      if (detailCount[i]! * 5 >= plane.subtreeEnd - i) nodes[i] = { ...plane, pictureScale: 0.625 };
    }
    for (const i of reliefs) {
      const n = nodes[i]!,
        shape = n.node;
      if (shape.type === 'shape' && shape.relief) {
        nodes[i] = {
          ...n,
          node: { ...shape, relief: { ...shape.relief, samplePixels: nodes[n.plane]!.pictureScale ? 2 : 4 } },
        };
      }
    }
    if (roofs || terrain || marks)
      view = { ...c, nodes, inkSize: ink, facetRoofs, inkPixels: width / STAGE_W, detail: roofs ? min : c.detail };
  }
  const plan = { view, roofs, terrain, marks };
  sizes.set(width, plan);
  return plan;
}
