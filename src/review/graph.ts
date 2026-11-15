// Speed graph: one picture of what a node does over time. The large panel is
// its speed; small panels below show whatever else changes on it (position,
// rotation, scale, opacity). Findings of the motion review, or of the physics
// review, are marked where they were raised. It works for a placed node, an
// emitter and the camera.
//
// Every panel has one scale of its own. A move with ease is a hump; a linear
// move is a plateau with vertical sides; a jump is a single spike; a spring is
// a train of humps that die out.

import { Canvas } from 'skia-canvas';
import { FPS } from '../core/time.ts';
import { CAMERA_SUBJECT } from '../scene/types.ts';
import { ensureFonts, fontString } from '../text/fonts.ts';
import { relativeSteps } from './detect.ts';
import { DRAWN, type MotionSeries } from './series.ts';
import { T } from './thresholds.ts';

/** What a graph needs of a finding to mark it: a finding of the motion review or of the physics review. */
export interface GraphMark {
  readonly subject: string;
  readonly kind: string;
  readonly from: number;
  readonly to: number;
}

export interface GraphOptions {
  /** A node id, or "(camera)". */
  readonly subject: string;
  /** First and last frame shown; default: the whole shot. */
  readonly from?: number;
  readonly to?: number;
  /** Findings to mark (those of other subjects are ignored). */
  readonly findings?: readonly GraphMark[];
  /** Width in px; default 1600. */
  readonly width?: number;
}

export interface GraphResult {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  readonly from: number;
  readonly to: number;
  /** Titles of the panels that were drawn. */
  readonly panels: readonly string[];
}

// Colours of a dark chart surface: quiet chrome, two series hues that stay
// apart for colour-blind readers, and one warning colour for the findings.
const SURFACE = '#1a1a19';
const HOLD = '#0d0d0d';
const INK = '#f0efec';
const INK2 = '#c3c2b7';
const MUTED = '#898781';
const GRID = '#2c2c2a';
const AXIS = '#383835';
const SERIES = ['#3987e5', '#d95926'];
const WARN = '#fab219';

interface Line {
  readonly name: string;
  /** One value per frame of the shot; NaN where there is none. */
  readonly data: ArrayLike<number>;
}

interface Panel {
  readonly title: string;
  readonly lines: readonly Line[];
  /** The scale starts at zero (speeds, counts, shares). */
  readonly fromZero: boolean;
  readonly height: number;
  /** Label the highest point of the first line. */
  readonly peak: boolean;
}

/** A step of 1, 2 or 5 times a power of ten that cuts `span` into about `count` parts. */
function niceStep(span: number, count: number): number {
  const raw = Math.max(span, 1e-12) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const lead = raw / mag;
  return (lead <= 1 ? 1 : lead <= 2 ? 2 : lead <= 5 ? 5 : 10) * mag;
}

function tickText(v: number, step: number): string {
  const digits = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
  return v.toFixed(digits);
}

/** The values of a series that change by more than `eps` within the window. */
function changes(data: ArrayLike<number>, from: number, to: number, eps: number): boolean {
  let lo = Infinity;
  let hi = -Infinity;
  for (let f = from; f <= to; f++) {
    const v = data[f]!;
    if (Number.isNaN(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return hi - lo > eps;
}

/** Draws the speed graph of a subject. */
export async function renderGraph(series: MotionSeries, opts: GraphOptions): Promise<GraphResult> {
  const c = series.shot;
  const F = series.frames;
  if (F < 2) throw new Error('graph: a shot of one frame has no motion to plot');
  const from = Math.max(0, Math.min(F - 2, opts.from ?? 0));
  const to = Math.max(from + 1, Math.min(F - 1, opts.to ?? F - 1));
  const nan = (): Float32Array => new Float32Array(F).fill(NaN);
  const panels: Panel[] = [];
  /** Frames at which the subject is not drawn: the lines break there and the band is shaded. */
  const hidden = new Uint8Array(F);
  let what: string;

  if (opts.subject === CAMERA_SUBJECT) {
    what = 'camera';
    const speed = nan();
    for (let f = 1; f < F; f++) {
      speed[f] = Math.hypot(series.camera.x[f]! - series.camera.x[f - 1]!, series.camera.y[f]! - series.camera.y[f - 1]!) * series.camera.zoom[f]!;
    }
    panels.push({ title: 'speed of the camera at depth 0, px per frame', lines: [{ name: 'speed', data: speed }], fromZero: true, height: 300, peak: true });
    panels.push({ title: 'position, units', lines: [{ name: 'x', data: series.camera.x }, { name: 'y', data: series.camera.y }], fromZero: false, height: 120, peak: false });
    if (changes(series.camera.zoom, from, to, 1e-4)) panels.push({ title: 'zoom', lines: [{ name: 'zoom', data: series.camera.zoom }], fromZero: false, height: 120, peak: false });
  } else {
    const n = c.byId.get(opts.subject);
    if (!n) throw new Error(`graph: there is no node "${opts.subject}" (for the camera use --camera)`);
    const s = series.placed[n.index];
    if (s) {
      what = `${n.id} (${n.node.type === 'shape' ? n.node.shape.kind : n.node.type}${n.bodySlot >= 0 ? ', rigid body' : ''}${n.springKind ? `, ${n.springKind} spring` : ''})`;
      const zoom = series.views[n.layer]!.zoom;
      const stage = nan();
      const x = nan();
      const y = nan();
      const rot = nan();
      const scale = nan();
      for (let f = 0; f < F; f++) {
        if ((s.flags[f]! & DRAWN) === 0) {
          hidden[f] = 1;
          continue;
        }
        x[f] = s.x[f]!;
        y[f] = s.y[f]!;
        rot[f] = s.rot[f]!;
        scale[f] = s.scale[f]!;
        if (f > 0 && (s.flags[f - 1]! & DRAWN) !== 0) stage[f] = Math.hypot(s.x[f]! - s.x[f - 1]!, s.y[f]! - s.y[f - 1]!) * zoom[f]!;
      }
      const lines: Line[] = [{ name: 'on the stage (camera frozen)', data: stage }];
      const attached = n.node.type === 'label' || n.parent >= 0;
      if (attached) {
        // Against the place of what it is attached to: what the strobing check measures.
        const rel = relativeSteps(series, s);
        const data = nan();
        for (let f = 1; f < F; f++) if (!hidden[f] && !hidden[f - 1]) data[f] = Math.hypot(rel.dx[f]!, rel.dy[f]!);
        lines.push({ name: n.node.type === 'label' ? `relative to "${c.nodes[n.targetIndex]!.id}"` : `relative to "${c.nodes[n.parent]!.id}"`, data });
      }
      panels.push({ title: 'speed, px per frame', lines, fromZero: true, height: 300, peak: true });
      if (changes(x, from, to, 0.5) || changes(y, from, to, 0.5)) {
        panels.push({ title: 'position in its layer, units', lines: [{ name: 'x', data: x }, { name: 'y', data: y }], fromZero: false, height: 120, peak: false });
      }
      if (changes(rot, from, to, 0.5)) panels.push({ title: 'rotation, degrees', lines: [{ name: 'rotation', data: rot }], fromZero: false, height: 120, peak: false });
      if (changes(scale, from, to, 0.005)) panels.push({ title: 'scale', lines: [{ name: 'scale', data: scale }], fromZero: false, height: 120, peak: false });
      if (changes(s.alpha, from, to, 0.005)) panels.push({ title: 'opacity', lines: [{ name: 'opacity', data: s.alpha }], fromZero: true, height: 120, peak: false });
    } else if (n.emitterSlot >= 0 && series.emitters[n.emitterSlot]) {
      const e = series.emitters[n.emitterSlot]!;
      what = `${n.id} (emitter)`;
      const speed = nan();
      const share = nan();
      const count = new Float32Array(F);
      for (let f = 0; f < F; f++) {
        count[f] = e.count[f]!;
        if (e.count[f]! === 0) continue;
        speed[f] = e.medianSpeed[f]!;
        share[f] = e.fast[f]! / e.count[f]!;
      }
      panels.push({ title: 'median speed of its particles in frame, px per frame', lines: [{ name: 'speed', data: speed }], fromZero: true, height: 300, peak: true });
      panels.push({ title: 'particles in frame', lines: [{ name: 'count', data: count }], fromZero: true, height: 120, peak: false });
      panels.push({ title: `share that travels at least ${T.fastRatio} of its own size per frame`, lines: [{ name: 'share', data: share }], fromZero: true, height: 120, peak: false });
    } else {
      throw new Error(`graph: "${opts.subject}" is a ${n.node.type}; a graph shows shapes, groups, eyes, labels, emitters and the camera`);
    }
  }

  const W = opts.width ?? 1600;
  const left = 72;
  const right = 28;
  const top = 64;
  const gap = 22;
  const bottom = 58;
  const plotW = W - left - right;
  const xOf = (f: number): number => left + ((f - from) / (to - from)) * plotW;
  ensureFonts();
  // The height depends on how many rows the names of the findings take, which takes a context to measure.
  const probe = new Canvas(8, 8, { gpu: false });
  let ctx = probe.getContext('2d');
  const text = (s: string, x: number, y: number, size: number, colour: string, align: 'left' | 'right' | 'center' = 'left', weight = 600): void => {
    ctx.font = fontString(size, weight);
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = colour;
    ctx.fillText(s, x, y);
  };

  const mine = (opts.findings ?? []).filter((f) => f.subject === opts.subject && f.to >= from && f.from <= to);

  // Names of the findings sit in rows of their own above the first plot, so that they never cover a line.
  const names: { label: string; x: number; row: number }[] = [];
  {
    ctx.font = fontString(12, 700);
    const ends: number[] = [];
    const seen = new Set<string>();
    for (const f of mine.slice().sort((a, b) => a.from - b.from || (a.kind < b.kind ? -1 : 1))) {
      const key = `${f.kind}@${f.from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = `${f.kind} f${f.from}${f.to > f.from ? `-${f.to}` : ''}`;
      const w = ctx.measureText(label).width + 16;
      const x = Math.min(left + plotW - w, Math.max(left, xOf(Math.max(from, f.from)) - 5));
      let row = ends.findIndex((end) => end + 8 < x);
      if (row < 0) {
        if (ends.length >= 4) continue;
        row = ends.length;
        ends.push(0);
      }
      ends[row] = x + w;
      names.push({ label, x, row });
    }
  }
  const nameRows = names.reduce((a, m) => Math.max(a, m.row + 1), 0);
  const strip = nameRows > 0 ? nameRows * 17 + 6 : 0;
  probe.dispose();

  const H = top + strip + panels.reduce((a, p) => a + p.height, 0) + gap * (panels.length - 1) + bottom;
  const canvas = new Canvas(W, H, { gpu: false });
  ctx = canvas.getContext('2d');
  ctx.fillStyle = SURFACE;
  ctx.fillRect(0, 0, W, H);
  text(`${c.spec.id}  /  ${what}`, left, 30, 22, INK, 'left', 800);
  text(`frames ${from}-${to} (${(from / FPS).toFixed(2)}-${(to / FPS).toFixed(2)} s) at ${FPS} fps`, left, 51, 14, INK2);

  // Time axis: ticks in seconds, the frame number under each.
  const step = niceStep((to - from) / FPS, 12);
  const ticks: number[] = [];
  for (let t = Math.ceil(from / FPS / step - 1e-9) * step; t <= to / FPS + 1e-9; t += step) ticks.push(t);

  let y = top;
  panels.forEach((p, pi) => {
    const y0 = y;
    // The plot starts under the panel's title, and in the first panel under the names of the findings.
    const plotTop = y0 + 26 + (pi === 0 ? strip : 0);
    const y1 = plotTop + p.height - 26;
    // Scale.
    let lo = Infinity;
    let hi = -Infinity;
    for (const line of p.lines) {
      for (let f = from; f <= to; f++) {
        const v = line.data[f]!;
        if (Number.isNaN(v)) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    if (p.fromZero) lo = Math.min(0, lo);
    if (hi - lo < 1e-9) hi = lo + (Math.abs(lo) > 1e-9 ? Math.abs(lo) * 0.1 : 1);
    const yStep = niceStep(hi - lo, p.height > 200 ? 5 : 3);
    lo = Math.floor(lo / yStep + 1e-9) * yStep;
    hi = Math.ceil(hi / yStep - 1e-9) * yStep;
    const yOf = (v: number): number => y1 - ((v - lo) / (hi - lo)) * (y1 - plotTop);

    // Frames at which the subject is not drawn.
    ctx.fillStyle = HOLD;
    let run = -1;
    for (let f = from; f <= to + 1; f++) {
      const h = f <= to && hidden[f] === 1;
      if (h && run < 0) run = f;
      if (!h && run >= 0) {
        ctx.fillRect(xOf(Math.max(from, run - 0.5)), plotTop, xOf(Math.min(to, f - 0.5)) - xOf(Math.max(from, run - 0.5)), y1 - plotTop);
        run = -1;
      }
    }
    // Grid and scale.
    ctx.lineWidth = 1;
    for (let v = lo; v <= hi + yStep * 1e-6; v += yStep) {
      const gy = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = Math.abs(v) < yStep * 1e-6 || v === lo ? AXIS : GRID;
      ctx.beginPath();
      ctx.moveTo(left, gy);
      ctx.lineTo(left + plotW, gy);
      ctx.stroke();
      text(tickText(v, yStep), left - 8, gy + 4, 13, MUTED, 'right', 500);
    }
    for (const t of ticks) {
      const gx = Math.round(xOf(t * FPS)) + 0.5;
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(gx, plotTop);
      ctx.lineTo(gx, y1);
      ctx.stroke();
    }
    // Findings: a band over their frames.
    for (const f of mine) {
      const a = xOf(Math.max(from, f.from));
      const b = xOf(Math.min(to, f.to));
      ctx.fillStyle = 'rgba(250,178,25,0.16)';
      ctx.fillRect(Math.min(a, b - 2), plotTop, Math.max(2, b - a), y1 - plotTop);
      ctx.fillStyle = 'rgba(250,178,25,0.55)';
      ctx.fillRect(Math.round(a), plotTop, 1, y1 - plotTop);
    }
    // Lines.
    p.lines.forEach((line, li) => {
      ctx.strokeStyle = SERIES[li % SERIES.length]!;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      let pen = false;
      for (let f = from; f <= to; f++) {
        const v = line.data[f]!;
        if (Number.isNaN(v)) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(xOf(f), yOf(v));
        else ctx.moveTo(xOf(f), yOf(v));
        pen = true;
      }
      ctx.stroke();
    });
    // Title and keys.
    text(p.title, left, y0 + 16, 15, INK2, 'left', 700);
    if (p.lines.length > 1) {
      let kx = left + plotW;
      for (let li = p.lines.length - 1; li >= 0; li--) {
        const name = p.lines[li]!.name;
        ctx.font = fontString(13, 600);
        const w = ctx.measureText(name).width;
        text(name, kx, y0 + 16, 13, INK2, 'right');
        ctx.strokeStyle = SERIES[li % SERIES.length]!;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(kx - w - 26, y0 + 11.5);
        ctx.lineTo(kx - w - 8, y0 + 11.5);
        ctx.stroke();
        kx -= w + 44;
      }
    }
    // The peak of the first line, by its value.
    if (p.peak) {
      const data = p.lines[0]!.data;
      let best = -1;
      for (let f = from; f <= to; f++) if (!Number.isNaN(data[f]!) && (best < 0 || data[f]! > data[best]!)) best = f;
      if (best >= 0 && data[best]! > 0) {
        const px = xOf(best);
        const py = yOf(data[best]!);
        ctx.fillStyle = SURFACE;
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = SERIES[0]!;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
        const label = `${data[best]!.toFixed(1)} at f${best}`;
        const alignRight = px > left + plotW - 140;
        text(label, alignRight ? px - 10 : px + 10, Math.max(plotTop + 14, py - 8), 13, INK, alignRight ? 'right' : 'left', 700);
      }
    }
    // Names of the findings: a mark and the name beside it, so the colour never stands alone.
    if (pi === 0) {
      for (const m of names) {
        const ly = y0 + 26 + 13 + m.row * 17;
        ctx.fillStyle = WARN;
        ctx.beginPath();
        ctx.moveTo(m.x, ly - 9);
        ctx.lineTo(m.x + 10, ly - 9);
        ctx.lineTo(m.x + 5, ly);
        ctx.closePath();
        ctx.fill();
        text(m.label, m.x + 14, ly, 12, INK, 'left', 700);
      }
    }
    y = y1 + gap;
  });

  // Time axis under the last panel.
  const axisY = y - gap;
  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, Math.round(axisY) + 0.5);
  ctx.lineTo(left + plotW, Math.round(axisY) + 0.5);
  ctx.stroke();
  for (const t of ticks) {
    const gx = xOf(t * FPS);
    text(`${tickText(t, step)} s`, gx, axisY + 20, 13, INK2, 'center', 600);
    text(`f${Math.round(t * FPS)}`, gx, axisY + 37, 12, MUTED, 'center', 500);
  }
  if (mine.length > 0 || hidden.subarray(from, to + 1).includes(1)) {
    const notes: string[] = [];
    if (mine.length > 0) notes.push('yellow band: a finding of the review');
    if (hidden.subarray(from, to + 1).includes(1)) notes.push('dark band: not drawn');
    text(notes.join('     '), left + plotW, 51, 13, MUTED, 'right', 500);
  }

  try {
    return { png: await canvas.toBuffer('png'), width: W, height: H, from, to, panels: panels.map((p) => p.title) };
  } finally {
    canvas.dispose();
  }
}
