// The physics report as text and as JSON. The same report is printed in full
// (capped, so that a shot with hundreds of bodies stays readable), in short for
// `skink3 check`, and written as JSON (complete). The findings themselves come
// from physics.ts.

import { FPS } from '../core/time.ts';
import { PHYSICS_FINDING_KINDS } from '../scene/types.ts';
import { PHYSICS_KINDS, type PhysicsFinding, type PhysicsReport } from './physics.ts';
import { P } from './physics-thresholds.ts';

const seconds = (frame: number): string => (frame / FPS).toFixed(2);

function when(f: PhysicsFinding): string {
  return f.from === f.to ? `f${f.from} (${seconds(f.from)} s)` : `f${f.from}-${f.to} (${seconds(f.from)}-${seconds(f.to)} s)`;
}

/** "3 warning(s): 2 overlap, 1 jitter". */
export function physicsSummaryLine(report: PhysicsReport): string {
  const n = report.findings.length;
  if (n === 0) return 'no warnings';
  const parts = PHYSICS_FINDING_KINDS.filter((k) => report.byKind[k]).map((k) => `${report.byKind[k]} ${k}`);
  return `${n} warning(s): ${parts.join(', ')}`;
}

function exceptionsLine(report: PhysicsReport): string | null {
  if (report.honoured.length === 0 && report.unused.length === 0) return null;
  const parts: string[] = [];
  if (report.honoured.length > 0) {
    const covered = report.honoured.reduce((a, h) => a + h.findings.length, 0);
    parts.push(`${report.honoured.length} honoured (${covered} finding(s) left out)`);
  }
  if (report.unused.length > 0) parts.push(`${report.unused.length} unused`);
  return `intended exceptions: ${parts.join(', ')}`;
}

/** Ids that differ only in their digits belong to one family: generated bodies. */
const familyOf = (id: string): string => id.replace(/\d+/g, '#');

function worldLine(report: PhysicsReport): string {
  const w = report.world;
  const parts: string[] = [];
  parts.push(w.deepest ? `deepest overlap ${w.deepest.px.toFixed(2)} px ("${w.deepest.a}" and "${w.deepest.b}", f${w.deepest.frame})` : 'no two bodies in each other');
  if (w.fastest) parts.push(`fastest ${w.fastest.px.toFixed(1)} px per frame ("${w.fastest.body}", f${w.fastest.frame})`);
  if (w.restFrom !== null) parts.push(`all at rest from f${w.restFrom} (${seconds(w.restFrom)} s)`);
  else {
    const e = w.fastestAtEnd;
    parts.push(`${w.movingAtEnd} still travelling at the end${e ? ` (the fastest, "${e.body}", at ${e.px.toFixed(2)} px per frame${e.seen ? '' : ', out of sight'})` : ''}`);
  }
  return `bodies: ${parts.join('; ')}`;
}

/**
 * The report as text: a summary, then the findings grouped by subject, the
 * worst first. Bodies of one family with the same kinds of findings are shown
 * once. The number of subjects and of findings per subject is capped; the JSON
 * report is complete.
 */
export function formatPhysicsReport(report: PhysicsReport): string {
  const lines: string[] = [];
  const k = report.counts;
  lines.push(
    `physics ${report.shot}: ${report.frames} frames (${report.seconds.toFixed(2)} s); ${k.bodies} rigid bodies (${k.dynamic} dynamic, ${k.fixed} fixed), ${k.springs} springs, ${k.emitters} emitters; gravity ${report.world.gravity}`,
  );
  if (k.dynamic > 0) lines.push(worldLine(report));
  lines.push(physicsSummaryLine(report));
  const ex = exceptionsLine(report);
  if (ex) lines.push(ex);

  const groups = new Map<string, PhysicsFinding[]>();
  for (const f of report.findings) {
    const list = groups.get(f.subject);
    if (list) list.push(f);
    else groups.set(f.subject, [f]);
  }
  const kindsOf = (list: readonly PhysicsFinding[]): string => [...new Set(list.map((f) => f.kind))].sort().join(',');
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
    if (shown >= P.reportSubjects) {
      hiddenSubjects += 1 + alike.length;
      hiddenFindings += total;
      continue;
    }
    shown++;
    lines.push('');
    lines.push(`${subject}${alike.length > 0 ? `  and ${alike.length} more like it: ${alike.slice(0, 8).join(', ')}${alike.length > 8 ? ', ...' : ''}` : ''}`);
    const top = list.slice(0, P.reportPerSubject);
    for (const f of top) lines.push(`  ${f.kind.padEnd(13)} ${when(f)}  ${f.detail}  [${f.value} against ${f.threshold} ${f.unit}]`);
    if (list.length > top.length) lines.push(`  ... and ${list.length - top.length} more finding(s) on this body`);
    if (alike.length > 0) lines.push(`  (${total - list.length} more finding(s) of the same kind on the others)`);
    for (const kind of new Set(top.map((f) => f.kind))) lines.push(`  usual fix for ${kind}: ${PHYSICS_KINDS[kind].fix}`);
  }
  if (hiddenSubjects > 0) {
    lines.push('');
    lines.push(`... and ${hiddenFindings} finding(s) on ${hiddenSubjects} more bodies, in the JSON report`);
  }

  if (report.honoured.length > 0 || report.unused.length > 0) {
    lines.push('');
    const ids = (nodes: readonly string[]): string => (nodes.length > 4 ? `${nodes.slice(0, 4).join(', ')}, ... (${nodes.length} nodes)` : nodes.join(', '));
    for (const h of report.honoured) lines.push(`intended, honoured: ${h.kind} on ${ids(h.nodes)}: "${h.reason}" (${h.findings.length} finding(s) left out)`);
    for (const u of report.unused) lines.push(`intended, unused: ${u.kind} on ${ids(u.nodes)}: "${u.reason}" matches no finding; remove it, or check the node and the kind`);
  }
  return lines.join('\n');
}

/** The short form for `skink3 check`: the count by kind and the worst few. */
export function formatPhysicsShort(report: PhysicsReport): string[] {
  const lines: string[] = [];
  const ex = exceptionsLine(report);
  lines.push(`physics: ${report.findings.length === 0 ? 'ok' : physicsSummaryLine(report)}${ex ? `; ${ex}` : ''}`);
  // Generated bodies with the same kind of finding are one line: the worst of them, and how many more.
  const groups = new Map<string, PhysicsFinding[]>();
  for (const f of report.findings) {
    const key = `${familyOf(f.subject)}|${f.kind}`;
    const list = groups.get(key);
    if (list) list.push(f);
    else groups.set(key, [f]);
  }
  let shown = 0;
  let covered = 0;
  for (const list of groups.values()) {
    if (shown >= P.checkWorst) break;
    shown++;
    covered += list.length;
    const f = list[0]!;
    const others = new Set(list.map((x) => x.subject)).size - 1;
    const more = list.length - 1;
    const also = others > 0 ? ` (and ${more} more like it on ${others} other bodies)` : more > 0 ? ` (and ${more} more like it)` : '';
    lines.push(`  ~ warning: ${f.kind} on "${f.subject}"${also} at ${when(f)}: ${f.detail}`);
  }
  if (report.findings.length > 0) {
    const rest = report.findings.length - covered;
    lines.push(`  ${rest > 0 ? `${rest} more; ` : ''}\`skink3 physics <scene>\` prints the full report, and with --pictures draws the worst`);
  }
  return lines;
}

/** The report as JSON text: complete, stable, without anything of the machine it ran on. */
export function physicsReportJson(report: PhysicsReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
