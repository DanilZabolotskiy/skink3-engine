// Text fit: for every language of the string tables, every label must hold its
// string, stay inside the frame while it is shown, and not cover another label.

import type { Bake } from '../physics/cache.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { evaluate, labelLayout, type LabelItem } from '../scene/evaluate.ts';
import { STAGE_H, STAGE_W } from '../scene/types.ts';

export interface FitIssue {
  readonly lang: string;
  readonly label: string;
  readonly kind: 'overflow' | 'off-frame' | 'overlap';
  readonly message: string;
}

export interface FitStat {
  readonly lang: string;
  readonly label: string;
  readonly lines: number;
  readonly size: number;
  readonly width: number;
  readonly height: number;
}

/** Frames between two samples of the on-screen checks. */
const SAMPLE_EVERY = 6;
/** A label must keep this many stage units from the frame edge. */
export const FRAME_MARGIN = 12;
/** A label counts as shown once its pop has grown past this scale. */
const SHOWN = 0.85;

interface Box {
  readonly id: string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export function checkTextFit(c: CompiledShot, bake: Bake, langs: readonly string[]): { issues: FitIssue[]; stats: FitStat[] } {
  const issues: FitIssue[] = [];
  const stats: FitStat[] = [];
  const labels = c.nodes.filter((n) => n.node.type === 'label');
  for (const lang of langs) {
    for (const n of labels) {
      const { layout, geometry } = labelLayout(c, n, lang);
      stats.push({ lang, label: n.id, lines: layout.lines.length, size: layout.size, width: geometry.box.w, height: geometry.box.h });
      if (layout.overflow) {
        issues.push({ lang, label: n.id, kind: 'overflow', message: `label "${n.id}" [${lang}]: the string does not fit: ${layout.overflowReason}` });
      }
    }
    const offFrame = new Set<string>();
    const overlaps = new Set<string>();
    for (let f = 0; f < c.frames; f += SAMPLE_EVERY) {
      const state = evaluate(c, bake, f, lang);
      const boxes: Box[] = [];
      for (const layer of state.layers) {
        for (const item of layer.items) {
          if (item.kind !== 'label' || item.scale < SHOWN) continue;
          boxes.push(stageBox(item, layer.view));
        }
      }
      for (const b of boxes) {
        const out = Math.max(FRAME_MARGIN - b.x0, FRAME_MARGIN - b.y0, b.x1 - (STAGE_W - FRAME_MARGIN), b.y1 - (STAGE_H - FRAME_MARGIN));
        if (out > 0 && !offFrame.has(b.id)) {
          offFrame.add(b.id);
          issues.push({
            lang,
            label: b.id,
            kind: 'off-frame',
            message: `label "${b.id}" [${lang}]: leaves the frame by ${out.toFixed(0)} units at frame ${f} (${(f / 60).toFixed(2)} s)`,
          });
        }
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          const key = `${a.id}\u0000${b.id}`;
          if (overlaps.has(key)) continue;
          if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) {
            overlaps.add(key);
            issues.push({
              lang,
              label: a.id,
              kind: 'overlap',
              message: `labels "${a.id}" and "${b.id}" [${lang}]: overlap at frame ${f} (${(f / 60).toFixed(2)} s)`,
            });
          }
        }
      }
    }
  }
  return { issues, stats };
}

function stageBox(item: LabelItem, view: { zoom: number; tx: number; ty: number }): Box {
  const b = item.geometry.box;
  const x0 = (item.tip[0] + b.x * item.scale) * view.zoom + view.tx;
  const y0 = (item.tip[1] + b.y * item.scale) * view.zoom + view.ty;
  return {
    id: item.node.id,
    x0,
    y0,
    x1: x0 + b.w * item.scale * view.zoom,
    y1: y0 + b.h * item.scale * view.zoom,
  };
}
