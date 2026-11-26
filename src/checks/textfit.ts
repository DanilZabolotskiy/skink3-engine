// Text fit: for every language of the string tables, every label and every
// free-standing text must hold its string, stay inside the frame while it is
// shown, and not cover another of them. A label that covers a node other than
// the one it points at is reported too, as a warning: it is the most common
// layout mistake, but sometimes intended. A free-standing text is laid on
// things on purpose, so it is not held to that.

import { xfApply, type Vec2 } from '../core/math.ts';
import { FPS } from '../core/time.ts';
import type { Bake } from '../physics/cache.ts';
import type { CNode, CompiledShot } from '../scene/compile.ts';
import { evaluate, flatItems, itemShape, labelLayout, textLayout, type LabelItem, type LeafItem, type TextItem } from '../scene/evaluate.ts';
import { STAGE_H, STAGE_W } from '../scene/types.ts';
import { containsPoint, transformOutline } from '../shape/geometry.ts';

export interface FitIssue {
  readonly lang: string;
  readonly label: string;
  readonly kind: 'overflow' | 'off-frame' | 'overlap' | 'covers-node';
  /** A warning does not fail the checks. */
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

export interface FitStat {
  readonly lang: string;
  /** Id of the label or of the text. */
  readonly label: string;
  readonly what: 'label' | 'text';
  readonly lines: number;
  readonly size: number;
  readonly width: number;
  readonly height: number;
}

/** Frames between two samples of the on-screen checks. */
const SAMPLE_EVERY = 6;
/** A label must keep this many stage units from the frame edge. */
export const FRAME_MARGIN = 12;
/** A label counts as shown once its pop has grown past this scale and it is at least this opaque. */
const SHOWN_SCALE = 0.85;
const SHOWN_ALPHA = 0.5;
/** A node counts as visible above this opacity. */
const NODE_ALPHA = 0.25;
/** A label covers a node when it reaches at least this many units into it. */
const COVER_DEPTH = 3;

interface Box {
  readonly id: string;
  /** What it is, as a message names it. */
  readonly what: 'label' | 'text';
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const seconds = (frame: number): string => (frame / FPS).toFixed(2);

/** The outline of a drawn node in the space of its layer, or null if it has none. */
function nodeOutline(item: LeafItem): Vec2[] | null {
  if (item.kind === 'shape' && item.node.node.type === 'shape') {
    return transformOutline(itemShape(item), (p) => xfApply(item.xf, p));
  }
  if (item.kind === 'eye' && item.node.node.type === 'eye') {
    const r = item.node.node.r * item.xf.scale;
    const out: Vec2[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      out.push([item.xf.x + Math.cos(a) * r, item.xf.y + Math.sin(a) * r]);
    }
    return out;
  }
  return null;
}

/** True when the box (already shrunk by the tolerance) and the outline share some area. */
function covers(box: Box, poly: readonly Vec2[]): boolean {
  if (box.x1 <= box.x0 || box.y1 <= box.y0) return false;
  for (const p of poly) {
    if (p[0] > box.x0 && p[0] < box.x1 && p[1] > box.y0 && p[1] < box.y1) return true;
  }
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  return (
    containsPoint(poly, cx, cy) ||
    containsPoint(poly, box.x0, box.y0) ||
    containsPoint(poly, box.x1, box.y0) ||
    containsPoint(poly, box.x0, box.y1) ||
    containsPoint(poly, box.x1, box.y1)
  );
}

/** The box of a shown label in the space of its layer. */
function layerBox(item: LabelItem): Box {
  const b = item.geometry.box;
  const x0 = item.tip[0] + b.x * item.scale;
  const y0 = item.tip[1] + b.y * item.scale;
  return { id: item.node.id, what: 'label', x0, y0, x1: x0 + b.w * item.scale, y1: y0 + b.h * item.scale };
}

/** The box around a shown text in the space of its layer: upright, round the block however it is turned. */
function textBox(item: TextItem): Box {
  const b = item.block.box;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const corner of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]] as const) {
    const p = xfApply(item.xf, corner);
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  return { id: item.node.id, what: 'text', x0, y0, x1, y1 };
}

function toStage(b: Box, view: { zoom: number; tx: number; ty: number }): Box {
  return {
    id: b.id,
    what: b.what,
    x0: b.x0 * view.zoom + view.tx,
    y0: b.y0 * view.zoom + view.ty,
    x1: b.x1 * view.zoom + view.tx,
    y1: b.y1 * view.zoom + view.ty,
  };
}

/** The target of a label, everything inside it and everything it is inside of. */
function related(c: CompiledShot, label: CNode): Set<number> {
  const out = new Set<number>();
  const target = c.nodes[label.targetIndex]!;
  for (let i = target.index; i <= target.subtreeEnd; i++) out.add(i);
  for (let p = target.parent; p >= 0; p = c.nodes[p]!.parent) out.add(p);
  return out;
}

export function checkTextFit(c: CompiledShot, bake: Bake, langs: readonly string[]): { issues: FitIssue[]; stats: FitStat[] } {
  const issues: FitIssue[] = [];
  const stats: FitStat[] = [];
  const labels = c.nodes.filter((n) => n.node.type === 'label');
  const texts = c.nodes.filter((n) => n.node.type === 'text');
  // Compilation keeps parents, targets, clips and other node references in one layer.
  // Keep the whole layer for label coverage; projected text boxes still meet across layers.
  const textLayers = new Set([...labels, ...texts].map((n) => n.layer));
  const fitScene: CompiledShot = textLayers.size === c.layers.length ? c : {
    ...c,
    activeNodes: (c.activeNodes ?? c.nodes).filter((n) => textLayers.has(n.layer)),
    layers: c.layers.map((layer, i) => textLayers.has(i) ? layer : { ...layer, nodes: [] }),
  };
  // With no text, one empty sample preserves the evaluator's bake check.
  const frames = textLayers.size ? c.frames : Math.min(1, c.frames);
  const relatedOf = new Map<string, Set<number>>();
  for (const n of labels) relatedOf.set(n.id, related(c, n));

  for (const lang of langs) {
    for (const n of labels) {
      const { layout, geometry } = labelLayout(c, n, lang);
      stats.push({ lang, label: n.id, what: 'label', lines: layout.lines.length, size: layout.size, width: geometry.box.w, height: geometry.box.h });
      if (layout.overflow) {
        issues.push({
          lang,
          label: n.id,
          kind: 'overflow',
          severity: 'error',
          message: `label "${n.id}" [${lang}]: the string does not fit: ${layout.overflowReason}`,
        });
      }
    }
    for (const n of texts) {
      const { layout, block } = textLayout(c, n, lang);
      stats.push({ lang, label: n.id, what: 'text', lines: layout.lines.length, size: layout.size, width: block.box.w, height: block.box.h });
      if (layout.overflow) {
        issues.push({ lang, label: n.id, kind: 'overflow', severity: 'error', message: `text "${n.id}" [${lang}]: the string does not fit: ${layout.overflowReason}` });
      }
    }
    const offFrame = new Set<string>();
    const overlaps = new Set<string>();
    // label id + node id -> first and last sampled frame at which the label covers the node
    const covered = new Map<string, { label: string; node: string; first: number; last: number }>();

    for (let f = 0; f < frames; f += SAMPLE_EVERY) {
      const state = evaluate(fitScene, bake, f, lang);
      const stageBoxes: Box[] = [];
      for (const layer of state.layers) {
        const leaves = flatItems(layer.items);
        const shown = leaves.filter((i): i is LabelItem => i.kind === 'label' && i.scale >= SHOWN_SCALE && i.alpha >= SHOWN_ALPHA);
        // A free-standing text is held to the frame and to the other texts and labels, not to the nodes it lies on.
        for (const item of leaves) {
          if (item.kind === 'text' && item.grown >= SHOWN_SCALE && item.alpha >= SHOWN_ALPHA) stageBoxes.push(toStage(textBox(item), layer.view));
        }
        if (shown.length === 0) continue;
        for (const item of shown) {
          const box = layerBox(item);
          stageBoxes.push(toStage(box, layer.view));
          const inner: Box = { id: box.id, what: 'label', x0: box.x0 + COVER_DEPTH, y0: box.y0 + COVER_DEPTH, x1: box.x1 - COVER_DEPTH, y1: box.y1 - COVER_DEPTH };
          const skip = relatedOf.get(item.node.id)!;
          for (const other of leaves) {
            if (other.kind !== 'shape' && other.kind !== 'eye') continue;
            if (other.alpha < NODE_ALPHA || skip.has(other.node.index)) continue;
            // A backdrop (ground, a wall) is there to have things in front of it.
            if (other.kind === 'shape' && other.node.node.type === 'shape' && other.node.node.backdrop === true) continue;
            const poly = nodeOutline(other);
            if (!poly || !covers(inner, poly)) continue;
            const key = `${item.node.id}\u0000${other.node.id}`;
            const seen = covered.get(key);
            if (seen) seen.last = f;
            else covered.set(key, { label: item.node.id, node: other.node.id, first: f, last: f });
          }
        }
      }
      for (const b of stageBoxes) {
        const out = Math.max(FRAME_MARGIN - b.x0, FRAME_MARGIN - b.y0, b.x1 - (STAGE_W - FRAME_MARGIN), b.y1 - (STAGE_H - FRAME_MARGIN));
        if (out > 0 && !offFrame.has(b.id)) {
          offFrame.add(b.id);
          issues.push({
            lang,
            label: b.id,
            kind: 'off-frame',
            severity: 'error',
            message: `${b.what} "${b.id}" [${lang}]: leaves the frame by ${out.toFixed(0)} units at frame ${f} (${seconds(f)} s)`,
          });
        }
      }
      for (let i = 0; i < stageBoxes.length; i++) {
        for (let j = i + 1; j < stageBoxes.length; j++) {
          const a = stageBoxes[i]!;
          const b = stageBoxes[j]!;
          const key = `${a.id}\u0000${b.id}`;
          if (overlaps.has(key)) continue;
          if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) {
            overlaps.add(key);
            issues.push({
              lang,
              label: a.id,
              kind: 'overlap',
              severity: 'error',
              message: `${a.what === 'label' && b.what === 'label' ? 'labels' : a.what === 'text' && b.what === 'text' ? 'texts' : `${a.what} and ${b.what}`} "${a.id}" and "${b.id}" [${lang}]: overlap at frame ${f} (${seconds(f)} s)`,
            });
          }
        }
      }
    }
    for (const hit of covered.values()) {
      issues.push({
        lang,
        label: hit.label,
        kind: 'covers-node',
        severity: 'warning',
        message:
          `label "${hit.label}" [${lang}]: covers node "${hit.node}" ` +
          (hit.last > hit.first ? `from ${seconds(hit.first)} s to ${seconds(hit.last)} s` : `at ${seconds(hit.first)} s`) +
          ` (first at frame ${hit.first})`,
      });
    }
  }
  return { issues, stats };
}
