// The motion report: every finding of the review, sorted, with the intended
// exceptions taken out and listed. The same report is printed as text (capped,
// so that a shot with hundreds of nodes stays readable) and written as JSON
// (complete).
//
// Whether the simulation itself is sound is the question of the physics review
// (physics.ts); its report has the same form and its own kinds of findings.

import { FPS } from '../core/time.ts';
import type { Bake } from '../physics/cache.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { FRAME_SUBJECT, MOTION_FINDING_KINDS, type IntendedSpec, type MotionFindingKind } from '../scene/types.ts';
import { detectDead } from './dead.ts';
import { detectMotion, FINDING_KINDS, type Finding } from './detect.ts';
import { sampleMotion, type MotionSeries, type SampleOptions } from './series.ts';
import { detectSprings, type SpringReport } from './springs.ts';
import { T, THRESHOLDS } from './thresholds.ts';

export interface HonouredException {
  readonly nodes: readonly string[];
  readonly kind: MotionFindingKind;
  readonly reason: string;
  /** The findings it covers; they are not warnings. */
  readonly findings: readonly Finding[];
}

export interface MotionReport {
  readonly version: 1;
  readonly shot: string;
  readonly frames: number;
  readonly fps: number;
  readonly seconds: number;
  /** What was looked at. */
  readonly counts: {
    readonly nodes: number;
    readonly bodies: number;
    readonly springs: number;
    readonly emitters: number;
    readonly links: number;
  };
  readonly camera: {
    /** Median travel per frame in px at depth 0. */
    readonly driftPx: number;
    readonly zoomFrom: number;
    readonly zoomTo: number;
    /** Slowest and fastest travel per frame in px at depth 0 (the 5th and the 95th percentile). */
    readonly driftMinPx: number;
    readonly driftMaxPx: number;
    /** Length of the camera's path over the shot, in px at depth 0. */
    readonly travelPx: number;
    /** Width and height of the box the camera's centre stays in, in px at depth 0: how far a subject slides across the frame. */
    readonly spanPx: readonly [number, number];
  };
  /**
   * The depth layers, farthest first: how fast each slides across the screen
   * with the camera (median px per frame). Layers that move at different
   * speeds are what gives the picture depth.
   */
  readonly layers: readonly { readonly id: string; readonly depth: number; readonly parallax: number; readonly driftPx: number }[];
  /**
   * The emitters: how many particles are in frame and how fast they travel on
   * their own (medians over the frames in which the emitter has particles in
   * frame, the camera left out), and the share of those frames in which they
   * move at all. Particles that stand still are a dead background.
   */
  readonly particles: readonly { readonly id: string; readonly layer: string; readonly inFrame: number; readonly speedPx: number; readonly movingShare: number }[];
  /**
   * A shot whose background is keyed (backgroundTo): the stretches of frames
   * in which it changes fast enough to be seen. Left out in a shot whose
   * background stays as it is.
   */
  readonly background?: readonly { readonly from: number; readonly to: number }[];
  /** The warnings, worst first. */
  readonly findings: readonly Finding[];
  /** Number of warnings by kind (kinds without any are left out). */
  readonly byKind: Readonly<Partial<Record<MotionFindingKind, number>>>;
  /** Exceptions marked with intended() that covered at least one finding. */
  readonly honoured: readonly HonouredException[];
  /** Exceptions that covered nothing: the defect is gone, or the exception names the wrong node or kind. */
  readonly unused: readonly IntendedSpec[];
  readonly springs: readonly SpringReport[];
  /** What each kind means and what usually fixes it. */
  readonly kinds: typeof FINDING_KINDS;
  readonly thresholds: typeof THRESHOLDS;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)]!;
}

function covers(x: IntendedSpec, f: Finding): boolean {
  if (x.kind !== f.kind) return false;
  const named = x.nodes.includes(f.subject) || (f.subject.startsWith('(frame:') && x.nodes.includes(FRAME_SUBJECT));
  if (!named) return false;
  if (x.from !== null && f.to / FPS < x.from) return false;
  if (x.to !== null && f.from / FPS > x.to) return false;
  return true;
}

/** Builds the report from the series of a shot. */
export function buildReport(series: MotionSeries): MotionReport {
  const c = series.shot;
  const springs = detectSprings(series);
  const all = [...detectMotion(series), ...springs.findings, ...detectDead(series)];
  all.sort((a, b) => b.severity - a.severity || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0) || a.from - b.from || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  // Exceptions to the physics review are honoured, and counted as unused, by that review.
  const intended = (c.spec.intended ?? []).filter((x) => (MOTION_FINDING_KINDS as readonly string[]).includes(x.kind));
  const taken: Finding[][] = intended.map(() => []);
  const findings: Finding[] = [];
  for (const f of all) {
    const i = intended.findIndex((x) => covers(x, f));
    if (i >= 0) taken[i]!.push(f);
    else findings.push(f);
  }
  const honoured: HonouredException[] = [];
  const unused: IntendedSpec[] = [];
  intended.forEach((x, i) => {
    if (taken[i]!.length > 0) honoured.push({ nodes: x.nodes, kind: x.kind as MotionFindingKind, reason: x.reason, findings: taken[i]! });
    else unused.push(x);
  });

  const byKind: Partial<Record<MotionFindingKind, number>> = {};
  for (const kind of MOTION_FINDING_KINDS) {
    const n = findings.filter((f) => f.kind === kind).length;
    if (n > 0) byKind[kind] = n;
  }

  const drift: number[] = [];
  for (let f = 1; f < series.frames; f++) {
    drift.push(Math.hypot(series.camera.x[f]! - series.camera.x[f - 1]!, series.camera.y[f]! - series.camera.y[f - 1]!) * series.camera.zoom[f]!);
  }
  const r3 = (v: number): number => Math.round(v * 1000) / 1000;

  // The camera's path: how far it goes, and the box its centre stays in.
  let travel = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let zoomSum = 0;
  for (let f = 0; f < series.frames; f++) {
    zoomSum += series.camera.zoom[f]!;
    x0 = Math.min(x0, series.camera.x[f]!);
    x1 = Math.max(x1, series.camera.x[f]!);
    y0 = Math.min(y0, series.camera.y[f]!);
    y1 = Math.max(y1, series.camera.y[f]!);
  }
  // The box in px: the camera's range in units at the mean zoom of the shot.
  const meanZoom = zoomSum / series.frames;
  x0 *= meanZoom;
  x1 *= meanZoom;
  y0 *= meanZoom;
  y1 *= meanZoom;
  for (const d of drift) travel += d;
  const sortedDrift = drift.slice().sort((a, b) => a - b);
  const pct = (p: number): number => (sortedDrift.length === 0 ? 0 : sortedDrift[Math.min(sortedDrift.length - 1, Math.floor(p * sortedDrift.length))]!);

  // How fast each layer slides across the screen: the camera's travel as that layer sees it.
  const layers = c.layers
    .map((layer, li) => {
      const v = series.views[li]!;
      const steps: number[] = [];
      for (let f = 1; f < series.frames; f++) steps.push(Math.hypot(v.tx[f]! - v.tx[f - 1]!, v.ty[f]! - v.ty[f - 1]!));
      return { id: layer.spec.id, depth: layer.spec.depth, parallax: r3(layer.parallax), driftPx: r3(median(steps)) };
    })
    .sort((a, b) => b.depth - a.depth);

  const particles = series.emitters.map((e) => {
    const speeds: number[] = [];
    const counts: number[] = [];
    let moving = 0;
    for (let f = 0; f < series.frames; f++) {
      if (e.count[f]! === 0) continue;
      speeds.push(e.medianSpeed[f]!);
      counts.push(e.count[f]!);
      if (e.medianSpeed[f]! >= T.alivePx) moving++;
    }
    return {
      id: e.id,
      layer: c.layers[e.node.layer]!.spec.id,
      inFrame: median(counts),
      speedPx: r3(median(speeds)),
      movingShare: speeds.length === 0 ? 0 : r3(moving / speeds.length),
    };
  });

  // The stretches in which a keyed background changes visibly.
  let background: { from: number; to: number }[] | null = null;
  if (series.background) {
    background = [];
    let start = -1;
    for (let f = 1; f <= series.frames; f++) {
      const changes = f < series.frames && series.background[f]! >= T.aliveBackground;
      if (changes && start < 0) start = f - 1;
      if (!changes && start >= 0) {
        background.push({ from: start, to: f - 1 });
        start = -1;
      }
    }
  }

  return {
    version: 1,
    shot: c.spec.id,
    frames: series.frames,
    fps: FPS,
    seconds: r3(series.frames / FPS),
    counts: {
      nodes: series.placed.filter((s) => s !== null).length,
      bodies: c.bodies.length,
      springs: c.springs.length,
      emitters: c.emitters.length,
      links: series.links.length,
    },
    camera: {
      driftPx: r3(median(drift)),
      zoomFrom: r3(series.camera.zoom[0]!),
      zoomTo: r3(series.camera.zoom[series.frames - 1]!),
      driftMinPx: r3(pct(0.05)),
      driftMaxPx: r3(pct(0.95)),
      travelPx: r3(travel),
      spanPx: [r3(Math.max(0, x1 - x0)), r3(Math.max(0, y1 - y0))],
    },
    layers,
    particles,
    ...(background === null ? {} : { background }),
    findings,
    byKind,
    honoured,
    unused,
    springs: springs.springs,
    kinds: FINDING_KINDS,
    thresholds: THRESHOLDS,
  };
}

/** Samples the shot and builds its motion report. */
export function reviewMotion(c: CompiledShot, bake: Bake, opts: SampleOptions = {}): { series: MotionSeries; report: MotionReport } {
  const series = sampleMotion(c, bake, opts);
  return { series, report: buildReport(series) };
}

// --- Text -------------------------------------------------------------------------

const seconds = (frame: number): string => (frame / FPS).toFixed(2);

function when(f: Finding): string {
  return f.from === f.to ? `f${f.from} (${seconds(f.from)} s)` : `f${f.from}-${f.to} (${seconds(f.from)}-${seconds(f.to)} s)`;
}

function limit(f: Finding): string {
  return `${f.value} against ${f.threshold} ${f.unit}`;
}

/** "3 warning(s): 2 jump, 1 too-fast". */
export function summaryLine(report: MotionReport): string {
  const n = report.findings.length;
  if (n === 0) return 'no warnings';
  const parts = MOTION_FINDING_KINDS.filter((k) => report.byKind[k]).map((k) => `${report.byKind[k]} ${k}`);
  return `${n} warning(s): ${parts.join(', ')}`;
}

function exceptionsLine(report: MotionReport): string | null {
  if (report.honoured.length === 0 && report.unused.length === 0) return null;
  const parts: string[] = [];
  if (report.honoured.length > 0) {
    const covered = report.honoured.reduce((a, h) => a + h.findings.length, 0);
    parts.push(`${report.honoured.length} honoured (${covered} finding(s) left out)`);
  }
  if (report.unused.length > 0) parts.push(`${report.unused.length} unused`);
  return `intended exceptions: ${parts.join(', ')}`;
}

/** What a subject is, for the reader of the report. */
function describe(c: CompiledShot, subject: string): string {
  const n = c.byId.get(subject);
  if (!n) return '';
  const node = n.node;
  const notes: string[] = [node.type === 'shape' ? node.shape.kind : node.type];
  if (n.bodySlot >= 0) notes.push('rigid body');
  if (n.springKind) notes.push(`${n.springKind} spring`);
  if (n.parent >= 0) notes.push(`in "${c.nodes[n.parent]!.id}"`);
  return ` (${notes.join(', ')})`;
}

/** Ids that differ only in their digits belong to one family: generated nodes with the same motion. */
export const familyOf = (id: string): string => id.replace(/\d+/g, '#');

/**
 * The report as text: a summary, then the findings grouped by subject, the
 * worst first. Subjects of one family with the same kinds of findings are
 * shown once. The number of subjects and of findings per subject is capped;
 * the JSON report is complete.
 */
export function formatMotionReport(report: MotionReport, c: CompiledShot): string {
  const lines: string[] = [];
  const k = report.counts;
  lines.push(
    `motion ${report.shot}: ${report.frames} frames (${report.seconds.toFixed(2)} s); ${k.nodes} placed nodes, ${k.bodies} of them rigid bodies, ${k.springs} springs, ${k.emitters} emitters, ${k.links} links`,
  );
  lines.push(`camera: median drift ${report.camera.driftPx.toFixed(2)} px per frame at depth 0, zoom ${report.camera.zoomFrom} to ${report.camera.zoomTo}`);
  lines.push(summaryLine(report));
  const ex = exceptionsLine(report);
  if (ex) lines.push(ex);
  // The life of the background: the camera's path, the layers against each other, the particles.
  const cam = report.camera;
  lines.push(
    `camera path: ${cam.travelPx.toFixed(0)} px long, inside a box of ${cam.spanPx[0].toFixed(0)} x ${cam.spanPx[1].toFixed(0)} px; drift between ${cam.driftMinPx.toFixed(2)} and ${cam.driftMaxPx.toFixed(2)} px per frame`,
  );
  if (report.layers.length > 1) lines.push(`layers, farthest first: ${report.layers.map((l) => `${l.id} ${l.driftPx.toFixed(2)}`).join(', ')} px per frame`);
  if (report.particles.length > 0) {
    lines.push(
      `particles: ${report.particles
        .map((p) => (p.inFrame === 0 ? `${p.id} never in frame` : `${p.id} ${p.speedPx.toFixed(2)} px per frame (${p.inFrame} in frame, moving ${Math.round(100 * p.movingShare)} % of the time)`))
        .join('; ')}`,
    );
  }

  if (report.background) {
    lines.push(
      report.background.length === 0
        ? 'background: keyed, but it never changes fast enough to be seen'
        : `background: changes at ${report.background.map((b) => `${seconds(b.from)}-${seconds(b.to)} s`).join(', ')}`,
    );
  }

  // Group by subject, keeping the order of severity.
  const groups = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const list = groups.get(f.subject);
    if (list) list.push(f);
    else groups.set(f.subject, [f]);
  }
  const kindsOf = (list: readonly Finding[]): string => [...new Set(list.map((f) => f.kind))].sort().join(',');
  const families = new Map<string, string[]>();
  for (const [subject, list] of groups) {
    const key = `${familyOf(subject)}|${kindsOf(list)}`;
    const members = families.get(key);
    if (members) members.push(subject);
    else families.set(key, [subject]);
  }
  let shown = 0;
  let hiddenSubjects = 0;
  let hiddenFindings = 0;
  const done = new Set<string>();
  for (const [subject, list] of groups) {
    if (done.has(subject)) continue;
    const members = families.get(`${familyOf(subject)}|${kindsOf(list)}`)!;
    const alike = members.length >= 3 ? members.filter((m) => m !== subject) : [];
    for (const m of alike) done.add(m);
    done.add(subject);
    const total = list.length + alike.reduce((a, m) => a + groups.get(m)!.length, 0);
    if (shown >= T.reportSubjects) {
      hiddenSubjects += 1 + alike.length;
      hiddenFindings += total;
      continue;
    }
    shown++;
    lines.push('');
    lines.push(`${subject}${describe(c, subject)}${alike.length > 0 ? `  and ${alike.length} more like it: ${alike.slice(0, 8).join(', ')}${alike.length > 8 ? ', ...' : ''}` : ''}`);
    const top = list.slice(0, T.reportPerSubject);
    for (const f of top) lines.push(`  ${f.kind.padEnd(13)} ${when(f)}  ${f.detail}  [${limit(f)}]`);
    if (list.length > top.length) lines.push(`  ... and ${list.length - top.length} more finding(s) on this subject`);
    if (alike.length > 0) lines.push(`  (${total - list.length} more finding(s) of the same kind on the others)`);
    for (const kind of new Set(top.map((f) => f.kind))) lines.push(`  usual fix for ${kind}: ${FINDING_KINDS[kind].fix}`);
  }
  if (hiddenSubjects > 0) {
    lines.push('');
    lines.push(`... and ${hiddenFindings} finding(s) on ${hiddenSubjects} more subject(s), in the JSON report`);
  }

  // Springs: one line per spring that responded, the longest ring first.
  const responded = report.springs.filter((s) => s.responses.length > 0);
  if (report.springs.length > 0) {
    lines.push('');
    lines.push(`springs: ${report.springs.length} spring-driven node(s), ${responded.length} responded`);
    const worst = (s: SpringReport, pick: (r: SpringReport['responses'][number]) => number | null): number =>
      s.responses.reduce((a, r) => Math.max(a, pick(r) ?? 0), 0);
    const rows = responded
      .map((s) => ({
        s,
        lag: worst(s, (r) => r.lagPx),
        over: worst(s, (r) => r.overshootPx),
        swings: worst(s, (r) => r.swings),
        ring: worst(s, (r) => r.ringSeconds),
        settle: worst(s, (r) => r.settleSeconds),
      }))
      .sort((a, b) => b.ring - a.ring || b.over - a.over || (a.s.id < b.s.id ? -1 : 1));
    for (const row of rows.slice(0, T.reportSubjects)) {
      lines.push(
        `  ${row.s.id} (${row.s.kind}, f ${row.s.f}, z ${row.s.z}, r ${row.s.r}): ${row.s.responses.length} response(s); at most: lag ${row.lag.toFixed(1)} px, overshoot ${row.over.toFixed(1)} px, ${row.swings} visible swing(s), swinging for ${row.ring.toFixed(2)} s, settled after ${row.settle.toFixed(2)} s`,
      );
    }
    if (rows.length > T.reportSubjects) lines.push(`  ... and ${rows.length - T.reportSubjects} more spring(s), in the JSON report`);
  }

  if (report.honoured.length > 0 || report.unused.length > 0) {
    lines.push('');
    for (const h of report.honoured) {
      const ids = h.nodes.length > 4 ? `${h.nodes.slice(0, 4).join(', ')}, ... (${h.nodes.length} nodes)` : h.nodes.join(', ');
      lines.push(`intended, honoured: ${h.kind} on ${ids}: "${h.reason}" (${h.findings.length} finding(s) left out)`);
    }
    for (const u of report.unused) {
      const ids = u.nodes.length > 4 ? `${u.nodes.slice(0, 4).join(', ')}, ... (${u.nodes.length} nodes)` : u.nodes.join(', ');
      lines.push(`intended, unused: ${u.kind} on ${ids}: "${u.reason}" matches no finding; remove it, or check the node and the kind`);
    }
  }
  return lines.join('\n');
}

/** The short form for `skink3 check`: the count by kind and the worst few. */
export function formatMotionShort(report: MotionReport): string[] {
  const lines: string[] = [];
  const ex = exceptionsLine(report);
  lines.push(`motion: ${report.findings.length === 0 ? 'ok' : summaryLine(report)}${ex ? `; ${ex}` : ''}`);
  // Generated nodes with the same kind of finding are one line: the worst of them, and how many more.
  const groups = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const key = `${familyOf(f.subject)}|${f.kind}`;
    const list = groups.get(key);
    if (list) list.push(f);
    else groups.set(key, [f]);
  }
  let shown = 0;
  let covered = 0;
  for (const list of groups.values()) {
    if (shown >= T.checkWorst) break;
    shown++;
    covered += list.length;
    const f = list[0]!;
    const others = new Set(list.map((x) => x.subject)).size - 1;
    const more = list.length - 1;
    const also = others > 0 ? ` (and ${more} more like it on ${others} other node(s))` : more > 0 ? ` (and ${more} more like it)` : '';
    lines.push(`  ~ warning: ${f.kind} on "${f.subject}"${also} at ${when(f)}: ${f.detail}`);
  }
  if (report.findings.length > 0) {
    const rest = report.findings.length - covered;
    lines.push(`  ${rest > 0 ? `${rest} more; ` : ''}\`skink3 motion <scene>\` prints the full report, and with --pictures draws the worst`);
  }
  return lines;
}

/** The report as JSON text: complete, stable, without anything of the machine it ran on. */
export function motionReportJson(report: MotionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
