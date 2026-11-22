// A counter: a number in a text that runs between values over time. The words
// round it come from the string tables, where "{n}" marks the place of the
// number; the number itself is written the way the language writes numbers.
//
// The digits stand in cells of one width, so a running number does not
// tremble; the layout of the text is made for the widest value the counter
// ever shows, so nothing is cut and the text-fit checks hold it there.

import type { TextAlign } from './block.ts';
import { measureText, type TextLayout } from './layout.ts';

/** The place of the number in the string of a counter. */
export const COUNT_MARK = '{n}';

const formats = new Map<string, Intl.NumberFormat>();

/**
 * A number as a language writes it: its grouping of digits and its decimal
 * sign, with Latin digits. A tag that is no language (a pseudo-locale) is
 * written as English. Spaces inside the number never break. With grouping
 * false the digits stand alone, in every language (a year); the decimal sign
 * is still the language's own.
 */
export function formatCount(value: number, decimals: number, lang: string, grouping = true): string {
  const key = grouping ? `${lang}|${decimals}` : `${lang}|${decimals}|g0`;
  let f = formats.get(key);
  if (!f) {
    const options = { numberingSystem: 'latn', minimumFractionDigits: decimals, maximumFractionDigits: decimals, ...(grouping ? {} : { useGrouping: false }) } as const;
    try {
      f = new Intl.NumberFormat(lang, options);
    } catch {
      f = new Intl.NumberFormat('en', options);
    }
    formats.set(key, f);
  }
  const k = 10 ** decimals;
  // No "-0": a value that rounds to nothing is written as nothing.
  const rounded = Math.round(value * k) / k;
  return f.format(rounded === 0 ? 0 : rounded).replace(/\s/g, ' ');
}

const DIGITS = '0123456789';

/** The widest digit of the font at a size and weight, and its width: the cell every digit of a counter stands in. */
export function digitCell(size: number, weight: number): { digit: string; width: number } {
  let digit = '0';
  let width = 0;
  for (const d of DIGITS) {
    const w = measureText(d, size, weight);
    if (w > width) {
      width = w;
      digit = d;
    }
  }
  return { digit, width };
}

/** The value of a counter that takes the most room, written with the widest digit in every place. */
export function widestCount(values: readonly number[], decimals: number, lang: string, size: number, weight: number, grouping = true): string {
  const { digit } = digitCell(size, weight);
  let best = '';
  let bestWidth = -1;
  for (const v of values) {
    const text = formatCount(v, decimals, lang, grouping).replace(/\d/g, digit);
    const w = measureText(text, size, weight);
    if (w > bestWidth) {
      bestWidth = w;
      best = text;
    }
  }
  return best;
}

/** Where the number of a counter is in its laid-out text. */
export interface CountSlot {
  /** Index of the line that holds the number, and what stands before and after it on that line. */
  readonly line: number;
  readonly prefix: string;
  readonly suffix: string;
}

/** Finds the number, written at its widest, in the lines of a layout. */
export function countSlot(layout: TextLayout, widest: string): CountSlot {
  for (let i = 0; i < layout.lines.length; i++) {
    const at = layout.lines[i]!.indexOf(widest);
    if (at >= 0) return { line: i, prefix: layout.lines[i]!.slice(0, at), suffix: layout.lines[i]!.slice(at + widest.length) };
  }
  throw new Error('the number of a counter is not in its lines');
}

/**
 * The line of a counter at one value, as pieces to draw: what stands before
 * the number, every character of the number (a digit in the middle of its
 * cell), and what stands after it. Each piece has the x of its middle. The
 * line is set as the text is aligned, within the width of the block.
 */
export function countRuns(layout: TextLayout, slot: CountSlot, number: string, align: TextAlign): { text: string; x: number }[] {
  const { size, weight } = layout;
  const cell = digitCell(size, weight).width;
  const prefixW = slot.prefix ? measureText(slot.prefix, size, weight) : 0;
  const suffixW = slot.suffix ? measureText(slot.suffix, size, weight) : 0;
  const chars = [...number];
  const widths = chars.map((ch) => (DIGITS.includes(ch) ? cell : measureText(ch, size, weight)));
  const total = prefixW + widths.reduce((a, b) => a + b, 0) + suffixW;
  const left = align === 'center' ? -layout.width / 2 : align === 'left' ? 0 : -layout.width;
  let x = align === 'center' ? left + (layout.width - total) / 2 : align === 'left' ? left : left + layout.width - total;
  const out: { text: string; x: number }[] = [];
  if (slot.prefix.trim()) out.push({ text: slot.prefix, x: x + prefixW / 2 });
  x += prefixW;
  chars.forEach((ch, i) => {
    if (ch.trim()) out.push({ text: ch, x: x + widths[i]! / 2 });
    x += widths[i]!;
  });
  if (slot.suffix.trim()) out.push({ text: slot.suffix, x: x + suffixW / 2 });
  return out;
}
