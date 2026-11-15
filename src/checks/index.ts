// Pre-render checks of a shot: palette laws, string tables, text fit in every
// language. `tsc` and the unit tests are separate steps (see the npm scripts).

import { checkPalette } from '../look/palette.ts';
import type { Bake } from '../physics/cache.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { checkStrings, languagesOf } from '../text/strings.ts';
import { checkTextFit, type FitStat } from './textfit.ts';

export { checkTextFit, type FitIssue, type FitStat } from './textfit.ts';

export interface CheckIssue {
  readonly check: 'palette' | 'strings' | 'text-fit';
  readonly message: string;
}

export interface CheckReport {
  readonly ok: boolean;
  readonly issues: readonly CheckIssue[];
  /** Label sizes per language, for the report. */
  readonly labels: readonly FitStat[];
  readonly languages: readonly string[];
}

/** Runs every scene-level check. `langs` defaults to all languages of the string tables. */
export function runChecks(c: CompiledShot, bake: Bake, langs?: readonly string[]): CheckReport {
  const languages = langs ?? languagesOf(c.spec.strings);
  const issues: CheckIssue[] = [];
  for (const i of checkPalette(c.spec.palette)) issues.push({ check: 'palette', message: `${i.law}: ${i.message}` });
  for (const i of checkStrings(c.spec.strings, c.stringKeys)) issues.push({ check: 'strings', message: i.message });
  const fit = checkTextFit(c, bake, languages);
  for (const i of fit.issues) issues.push({ check: 'text-fit', message: `${i.kind}: ${i.message}` });
  return { ok: issues.length === 0, issues, labels: fit.stats, languages };
}

export function formatReport(report: CheckReport): string {
  const lines: string[] = [];
  lines.push(`languages: ${report.languages.join(', ')}`);
  for (const s of report.labels) {
    lines.push(`  label ${s.label} [${s.lang}]: ${s.lines} line(s), size ${s.size}, box ${s.width.toFixed(0)} x ${s.height.toFixed(0)}`);
  }
  for (const check of ['palette', 'strings', 'text-fit'] as const) {
    const list = report.issues.filter((i) => i.check === check);
    lines.push(`${check}: ${list.length === 0 ? 'ok' : `${list.length} problem(s)`}`);
    for (const i of list) lines.push(`  - ${i.message}`);
  }
  lines.push(report.ok ? 'checks passed' : 'checks FAILED');
  return lines.join('\n');
}
