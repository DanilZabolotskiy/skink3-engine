// Pre-render checks of a shot: palette laws, string tables, text fit in every
// language, and, when asked for, the motion review in short form. `tsc` and
// the unit tests are separate steps (see the npm scripts).

import { checkPalette } from '../look/palette.ts';
import type { Bake } from '../physics/cache.ts';
import { formatMotionShort, reviewMotion, type MotionReport } from '../review/report.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { checkStrings, languagesOf } from '../text/strings.ts';
import { checkTextFit, type FitStat } from './textfit.ts';

export { checkTextFit, type FitIssue, type FitStat } from './textfit.ts';

export interface CheckIssue {
  readonly check: 'palette' | 'strings' | 'text-fit';
  /** An error fails the checks; a warning is only reported. */
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

export interface CheckReport {
  /** True when there is no error (warnings do not count). */
  readonly ok: boolean;
  readonly issues: readonly CheckIssue[];
  /** Label sizes per language, for the report. */
  readonly labels: readonly FitStat[];
  readonly languages: readonly string[];
  /** The motion review, when it was asked for. Its findings are warnings: they never fail the checks. */
  readonly motion: MotionReport | null;
}

export interface CheckOptions {
  /** Also run the motion review (jumps, ease, speed, springs, dead areas); default false. */
  readonly motion?: boolean;
}

/** Runs every scene-level check. `langs` defaults to all languages of the string tables. */
export function runChecks(c: CompiledShot, bake: Bake, langs?: readonly string[], opts: CheckOptions = {}): CheckReport {
  const languages = langs ?? languagesOf(c.spec.strings);
  const issues: CheckIssue[] = [];
  for (const i of checkPalette(c.spec.palette)) issues.push({ check: 'palette', severity: 'error', message: `${i.law}: ${i.message}` });
  for (const i of checkStrings(c.spec.strings, c.stringKeys)) issues.push({ check: 'strings', severity: 'error', message: i.message });
  const fit = checkTextFit(c, bake, languages);
  for (const i of fit.issues) issues.push({ check: 'text-fit', severity: i.severity, message: `${i.kind}: ${i.message}` });
  const motion = opts.motion ? reviewMotion(c, bake, { lang: languages[0] ?? languagesOf(c.spec.strings)[0]! }).report : null;
  return { ok: !issues.some((i) => i.severity === 'error'), issues, labels: fit.stats, languages, motion };
}

export function formatReport(report: CheckReport): string {
  const lines: string[] = [];
  lines.push(`languages: ${report.languages.join(', ')}`);
  for (const s of report.labels) {
    lines.push(`  label ${s.label} [${s.lang}]: ${s.lines} line(s), size ${s.size}, box ${s.width.toFixed(0)} x ${s.height.toFixed(0)}`);
  }
  for (const check of ['palette', 'strings', 'text-fit'] as const) {
    const list = report.issues.filter((i) => i.check === check);
    const errors = list.filter((i) => i.severity === 'error').length;
    const warnings = list.length - errors;
    const parts: string[] = [];
    if (errors > 0) parts.push(`${errors} problem(s)`);
    if (warnings > 0) parts.push(`${warnings} warning(s)`);
    lines.push(`${check}: ${errors === 0 ? 'ok' : ''}${errors === 0 && warnings > 0 ? ', ' : ''}${parts.join(', ')}`);
    for (const i of list) lines.push(`  ${i.severity === 'error' ? '-' : '~'} ${i.severity === 'warning' ? 'warning: ' : ''}${i.message}`);
  }
  if (report.motion) lines.push(...formatMotionShort(report.motion));
  const warnings = report.issues.filter((i) => i.severity === 'warning').length + (report.motion?.findings.length ?? 0);
  lines.push(report.ok ? `checks passed${warnings > 0 ? ` with ${warnings} warning(s)` : ''}` : 'checks FAILED');
  return lines.join('\n');
}
