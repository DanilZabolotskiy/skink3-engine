// Pictures for the worst findings of a motion report: a ghost trail and a speed
// graph of each of the few subjects that head the list. One command then gives
// a reviewer both the list of problems and the pictures of them.

import type { Bake } from '../physics/cache.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { CAMERA_SUBJECT } from '../scene/types.ts';
import type { Finding } from './detect.ts';
import { renderGraph } from './graph.ts';
import { familyOf, type MotionReport } from './report.ts';
import type { MotionSeries } from './series.ts';
import { renderTrail } from './trail.ts';

export interface MotionPicture {
  readonly subject: string;
  readonly kind: 'trail' | 'graph';
  /** File name without a directory, e.g. "01_n3_trail.png". */
  readonly name: string;
  readonly png: Buffer;
  /** What it shows, for the listing. */
  readonly note: string;
}

/** Frames of air around a finding in a trail, and around a subject's findings in a graph. */
const TRAIL_PAD = 24;
const GRAPH_PAD = 90;

/**
 * Trails and graphs of the `count` worst subjects of a report. Subjects that
 * have no place of their own (a region of the frame, a link) are passed over,
 * and of generated nodes that share their findings only the worst is drawn.
 */
export async function motionPictures(
  c: CompiledShot,
  bake: Bake,
  series: MotionSeries,
  report: MotionReport,
  opts: { count: number; gpu: boolean; lang: string },
): Promise<MotionPicture[]> {
  const out: MotionPicture[] = [];
  const bySubject = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const list = bySubject.get(f.subject);
    if (list) list.push(f);
    else bySubject.set(f.subject, [f]);
  }
  const F = series.frames;
  let made = 0;
  // Generated nodes with the same findings show the same thing: one of a family is enough.
  const families = new Set<string>();
  for (const [subject, list] of bySubject) {
    if (made >= opts.count) break;
    const node = c.byId.get(subject);
    const camera = subject === CAMERA_SUBJECT;
    if (!camera && (!node || node.node.type === 'link')) continue;
    const family = `${familyOf(subject)}|${[...new Set(list.map((f) => f.kind))].sort().join(',')}`;
    if (families.has(family)) continue;
    families.add(family);
    made++;
    const prefix = `${String(made).padStart(2, '0')}_${camera ? 'camera' : subject}`;
    const worst = list[0]!;

    if (!camera) {
      // An emitter is a stream: a second of it is enough to see the spacing of its particles.
      const emitter = node!.node.type === 'emitter';
      const from = Math.max(0, worst.from - (emitter ? 0 : TRAIL_PAD));
      const to = Math.min(F - 1, emitter ? Math.min(worst.to, worst.from + 30) : worst.to + TRAIL_PAD);
      try {
        const trail = await renderTrail(c, bake, series, { nodes: [subject], from, to, every: Math.max(1, Math.ceil((to - from + 1) / 48)), gpu: opts.gpu, lang: opts.lang });
        out.push({
          subject,
          kind: 'trail',
          name: `${prefix}_trail.png`,
          png: trail.png,
          note: `${worst.kind} at f${worst.from}-${worst.to}: frames ${trail.from}-${trail.to}, a ghost every ${trail.every}`,
        });
      } catch {
        // Nothing of it is drawn in that window: the graph still tells its story.
      }
    }

    let from = Math.max(0, Math.min(...list.map((f) => f.from)) - GRAPH_PAD);
    let to = Math.min(F - 1, Math.max(...list.map((f) => f.to)) + GRAPH_PAD);
    if (to - from > 0.6 * F) {
      from = 0;
      to = F - 1;
    }
    const graph = await renderGraph(series, { subject, from, to, findings: report.findings });
    out.push({
      subject,
      kind: 'graph',
      name: `${prefix}_graph.png`,
      png: graph.png,
      note: `${list.length} finding(s): frames ${graph.from}-${graph.to}`,
    });
  }
  return out;
}
