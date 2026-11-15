// The motion report: every finding of the review, sorted, with the intended
// exceptions taken out and listed. The same report is printed as text (capped,
// so that a shot with hundreds of nodes stays readable) and written as JSON
// (complete).
//
// The report is built to grow: a finding is plain data with a kind, a subject
// and a measurement, and `kinds` lists what each kind means. Physics checks
// will add kinds and findings; nothing else here has to change.

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
  };
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

  const intended = c.spec.intended ?? [];
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
    if (taken[i]!.length > 0) honoured.push({ nodes: x.nodes, kind: x.kind, reason: x.reason, findings: taken[i]! });
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
    camera: { driftPx: r3(median(drift)), zoomFrom: r3(series.camera.zoom[0]!), zoomTo: r3(series.camera.zoom[series.frames - 1]!) },
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
  const worst = report.findings.slice(0, T.checkWorst);
  for (const f of worst) lines.push(`  ~ warning: ${f.kind} on "${f.subject}" at ${when(f)}: ${f.detail}`);
  if (report.findings.length > 0) {
    const more = report.findings.length - worst.length;
    lines.push(`  ${more > 0 ? `${more} more; ` : ''}\`skink3 motion <scene>\` prints the full report, and with --pictures draws the worst`);
  }
  return lines;
}

/** The report as JSON text: complete, stable, without anything of the machine it ran on. */
export function motionReportJson(report: MotionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
