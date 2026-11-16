// Pictures for the worst findings of a physics report. What helps depends on
// the kind of finding:
//
//   overlap                              a close-up of the frames around the deepest moment
//   tunnelling, escape, energy-spike     a ghost trail of the body, and a close-up
//   jitter, unsettled                    a speed graph of the body: at rest the line is at zero, a tremble lifts it
//
// In a close-up the body is ringed in blue and the other body of a pair in
// orange, so that a reviewer finds them in a pile of bodies that look alike.

import { Canvas, ImageData } from 'skia-canvas';
import { cameraAt, layerView } from '../camera/camera.ts';
import { FPS } from '../core/time.ts';
import type { Bake } from '../physics/cache.ts';
import { frameRaw, heightFor } from '../render/frame.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { STAGE_H, STAGE_W } from '../scene/types.ts';
import { shapeExtent } from '../shape/geometry.ts';
import { ensureFonts, fontString } from '../text/fonts.ts';
import { renderGraph } from './graph.ts';
import type { PhysicsReport } from './physics.ts';
import type { MotionSeries } from './series.ts';
import { renderTrail } from './trail.ts';

export interface PhysicsPicture {
  readonly subject: string;
  readonly kind: 'close' | 'trail' | 'graph';
  /** File name without a directory, e.g. "01_piece12_overlap_close.png". */
  readonly name: string;
  readonly png: Buffer;
  /** What it shows, for the listing. */
  readonly note: string;
}

export interface CloseUpOptions {
  /** Ids of the bodies to ring: the first in blue, the second in orange. */
  readonly bodies: readonly string[];
  readonly frames: readonly number[];
  /** Centre of the picture in units of the bodies' layer; default: the first body at the first frame. */
  readonly at?: readonly [number, number];
  /** Width of the part of the stage that is shown, in stage units; default: ten times the body, at least 200. */
  readonly span?: number;
  /** Width of one tile in px; default 480. */
  readonly tile?: number;
  readonly lang: string;
  readonly gpu: boolean;
}

const RINGS = ['#3987e5', '#d95926'];
const INK = '#FFE14D';

/**
 * A strip of enlarged frames around a place, with the named bodies ringed. The
 * same part of the stage is shown in every tile, so a body that moves is seen
 * to move.
 */
export async function renderCloseUp(c: CompiledShot, bake: Bake, opts: CloseUpOptions): Promise<Buffer> {
  if (opts.frames.length === 0) throw new Error('a close-up needs at least one frame');
  const nodes = opts.bodies.map((id) => {
    const n = c.byId.get(id);
    if (!n || n.bodySlot < 0) throw new Error(`close-up: "${id}" is not a rigid body`);
    return n;
  });
  const layer = c.layers[nodes[0]!.layer]!;
  const view = (f: number): { zoom: number; tx: number; ty: number } => layerView(cameraAt(c.spec.camera, c.cameraNoise, f, c.frames, c.cameraTrack), layer.parallax);
  const radiusOf = (i: number): number => {
    const node = nodes[i]!.node;
    if (node.type !== 'shape') return 0;
    const ext = shapeExtent(node.shape);
    return (Math.hypot(ext.center[0], ext.center[1]) + ext.outer) * node.scale;
  };
  const first = opts.frames[0]!;
  const v0 = view(first);
  const at = opts.at ?? [bake.bodyX(nodes[0]!.bodySlot, first), bake.bodyY(nodes[0]!.bodySlot, first)];
  // The part of the stage that is shown: the same for every tile, 16:9, inside the frame where it can be.
  const w = Math.min(STAGE_W, opts.span ?? Math.max(200, 10 * radiusOf(0) * v0.zoom));
  const h = (w * 9) / 16;
  const x = Math.max(0, Math.min(STAGE_W - w, at[0] * v0.zoom + v0.tx - w / 2));
  const y = Math.max(0, Math.min(STAGE_H - h, at[1] * v0.zoom + v0.ty - h / 2));

  const tileW = opts.tile ?? 480;
  const tileH = Math.round((tileW * 9) / 16);
  // Rendered as large as the engine goes, so that the crop is enlarged as little as possible.
  const renderW = STAGE_W * 2;
  const renderH = heightFor(renderW);
  const k = renderW / STAGE_W;
  const cols = Math.min(4, opts.frames.length);
  const rows = Math.ceil(opts.frames.length / cols);
  const sheet = new Canvas(cols * tileW, rows * tileH, { gpu: false });
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ensureFonts();
  const scale = tileW / w;
  for (let i = 0; i < opts.frames.length; i++) {
    const f = opts.frames[i]!;
    const raw = await frameRaw(c, bake, f, { width: renderW, lang: opts.lang, gpu: opts.gpu });
    const ox = (i % cols) * tileW;
    const oy = Math.floor(i / cols) * tileH;
    ctx.drawImage(new ImageData(raw, renderW, renderH), x * k, y * k, w * k, h * k, ox, oy, tileW, tileH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, tileW, tileH);
    ctx.clip();
    const v = view(f);
    nodes.forEach((n, b) => {
      const sx = bake.bodyX(n.bodySlot, f) * v.zoom + v.tx;
      const sy = bake.bodyY(n.bodySlot, f) * v.zoom + v.ty;
      const r = radiusOf(b) * v.zoom;
      // A fixed body larger than the picture gets no ring: it is the wall or the floor in view.
      if (r * 2 > w) return;
      ctx.strokeStyle = RINGS[b % RINGS.length]!;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.arc(ox + (sx - x) * scale, oy + (sy - y) * scale, r * scale + 5, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.restore();
    const size = Math.max(12, Math.round(tileW / 34));
    const text = `f${f}  ${(f / FPS).toFixed(2)}s  x${scale.toFixed(1)}`;
    ctx.font = fontString(size, 700);
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(ox, oy, tw + size * 0.8, size * 1.5);
    ctx.fillStyle = INK;
    ctx.fillText(text, ox + size * 0.4, oy + size * 0.22);
  }
  try {
    return await sheet.toBuffer('png');
  } finally {
    sheet.dispose();
  }
}

/** Ids that differ only in their digits belong to one family: generated bodies. */
const familyOf = (id: string): string => id.replace(/\d+/g, '#');

/** Frames of air around a finding in a trail and in a graph. */
const TRAIL_PAD = 12;
const GRAPH_PAD = 60;

/**
 * Pictures of the `count` worst findings of a report. Of generated bodies with
 * the same kind of finding only the worst is drawn. `series` is the motion
 * series of the shot (sampleMotion); the trail and the graph are drawn from it.
 */
export async function physicsPictures(
  c: CompiledShot,
  bake: Bake,
  series: MotionSeries,
  report: PhysicsReport,
  opts: { count: number; gpu: boolean; lang: string },
): Promise<PhysicsPicture[]> {
  const out: PhysicsPicture[] = [];
  const F = c.frames;
  const families = new Set<string>();
  let made = 0;
  const clamp = (f: number): number => Math.max(0, Math.min(F - 1, f));
  for (const f of report.findings) {
    if (made >= opts.count) break;
    const node = c.byId.get(f.subject);
    if (f.kind === 'not-finite' || !node || node.bodySlot < 0) continue;
    const family = `${familyOf(f.subject)}|${f.kind}`;
    if (families.has(family)) continue;
    families.add(family);
    made++;
    const prefix = `${String(made).padStart(2, '0')}_${f.subject}_${f.kind}`;
    const other = f.other !== null && c.byId.get(f.other)?.bodySlot !== undefined && c.byId.get(f.other)!.bodySlot >= 0 ? f.other : null;
    const pair = other ? [f.subject, other] : [f.subject];
    const what = `${f.kind} at f${f.from}-${f.to}`;

    if (f.kind === 'jitter' || f.kind === 'unsettled') {
      const graph = await renderGraph(series, { subject: f.subject, from: clamp(f.from - GRAPH_PAD), to: clamp(f.to + GRAPH_PAD), findings: report.findings });
      out.push({ subject: f.subject, kind: 'graph', name: `${prefix}_graph.png`, png: graph.png, note: `${what}: frames ${graph.from}-${graph.to}` });
      continue;
    }

    if (f.kind !== 'overlap') {
      const from = clamp(Math.min(f.from, f.worst) - TRAIL_PAD);
      const to = clamp(Math.min(Math.max(f.to, f.worst), from + 90) + TRAIL_PAD);
      try {
        const trail = await renderTrail(c, bake, series, { nodes: [f.subject], from, to, every: Math.max(1, Math.ceil((to - from + 1) / 48)), gpu: opts.gpu, lang: opts.lang });
        out.push({ subject: f.subject, kind: 'trail', name: `${prefix}_trail.png`, png: trail.png, note: `${what}: frames ${trail.from}-${trail.to}, a ghost every ${trail.every}` });
      } catch {
        // Nothing of it is drawn in that window: the close-up still shows the place.
      }
    }

    // A close-up of four frames: before, at the worst moment, and after.
    const span = f.kind === 'overlap' ? [f.worst - 4, f.worst - 1, f.worst, f.worst + 4] : [f.worst - 3, f.worst - 1, f.worst, f.worst + 2];
    const frames = [...new Set(span.map(clamp))].sort((a, b) => a - b);
    const png = await renderCloseUp(c, bake, { bodies: pair, frames, at: f.at, lang: opts.lang, gpu: opts.gpu });
    out.push({ subject: f.subject, kind: 'close', name: `${prefix}_close.png`, png, note: `${what}: frames ${frames.join(', ')}${other ? `; "${f.subject}" ringed in blue, "${other}" in orange` : `; "${f.subject}" ringed in blue`}` });
  }
  return out;
}
