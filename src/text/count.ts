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

// --- Digits that roll ---------------------------------------------------------------------------
//
// A rolling counter is a meter: a wheel for each place, the last place turning
// as the number runs and each higher one turning to its next digit while the
// places below it carry. Its wheels at a frame are a pure function of the
// number over the frames round it: each wheel's turn is the mean of where a
// meter's wheel would be over ROLL_FRAMES frames centred on the frame, so a
// carry that a meter makes within one frame is a turn spread over that time,
// and a wheel at rest stands at its whole digit.

/** The frames a carry's turn is spread over: the wheels of a fast count roll their next digit up in this time. */
export const ROLL_FRAMES = 10;
/** How far apart the digits of a wheel are, as a share of the size of the text: its line height. */
export const ROLL_PITCH = 1.18;
/** The middle of a digit above the baseline, as a share of the size: the window of a wheel is centred on it. */
export const ROLL_MIDDLE = 0.36;
/** The most places a rolling counter has: beyond them a number is not held exactly. */
export const ROLL_MAX_DIGITS = 15;

/** Why a value cannot be shown by a rolling counter, or null: it must be a whole value of the last place, 0 or more, of at most 15 digits. */
export function rollRefusal(value: number, decimals: number): string | null {
  const u = value * 10 ** decimals;
  if (!(u >= 0)) return `a counter whose digits roll runs between values of 0 or more, got ${value}`;
  if (Math.abs(u - Math.round(u)) > 1e-6 * Math.max(1, u)) return `a counter whose digits roll stops only at whole values of its last place (${decimals} decimal${decimals === 1 ? '' : 's'}), got ${value}`;
  if (Math.round(u) >= 10 ** ROLL_MAX_DIGITS) return `a counter whose digits roll has at most ${ROLL_MAX_DIGITS} digits, got ${value}`;
  return null;
}

/** How many wheels a rolling counter needs for the values it reaches: as many as the digits of the largest, the places after the decimal sign and one before it at least. */
export function rollWheels(values: readonly number[], decimals: number): number {
  let most = 0;
  for (const v of values) most = Math.max(most, Math.round(Math.abs(v) * 10 ** decimals));
  return Math.max(decimals + 1, String(most).length);
}

/** Where wheel k of a meter stands at the value u of its last place: its whole turns, and the turn it makes while every place below it carries. */
function meterWheel(u: number, k: number): number {
  const p = 10 ** k;
  const q = Math.floor(u / p);
  const m = u - q * p;
  return q + Math.min(1, Math.max(0, m - (p - 1)));
}

/** The wheels of a rolling counter at one frame. */
export interface CountWheels {
  /** Per wheel, from the last place (0) up: where it has turned to, in digits; 37.25 shows a 7 a quarter of the way to an 8. */
  readonly pos: Float64Array;
  /** Per wheel: how far it turned since the frame before, in digits; negative as the number falls. */
  readonly turn: Float64Array;
}

/**
 * The wheels of a rolling counter at a frame. `valueAt` is the number of the counter at a time in seconds, `wheels`
 * how many it has (rollWheels).
 */
export function countWheels(valueAt: (seconds: number) => number, frame: number, fps: number, decimals: number, wheels: number): CountWheels {
  const scale = 10 ** decimals;
  // The frames round the one before and round this one: ROLL_FRAMES + 1 samples, the first ROLL_FRAMES for the frame
  // before, the last ROLL_FRAMES for this one.
  const us: number[] = [];
  for (let j = 0; j <= ROLL_FRAMES; j++) {
    let u = valueAt((frame - 1 + j + 0.5 - ROLL_FRAMES / 2) / fps) * scale;
    const r = Math.round(u);
    if (Math.abs(u - r) < 1e-6) u = r;
    us.push(Math.max(0, u));
  }
  const pos = new Float64Array(wheels);
  const turn = new Float64Array(wheels);
  for (let k = 0; k < wheels; k++) {
    let before = 0;
    let now = 0;
    for (let j = 0; j <= ROLL_FRAMES; j++) {
      const w = meterWheel(us[j]!, k);
      if (j < ROLL_FRAMES) before += w;
      if (j > 0) now += w;
    }
    pos[k] = now / ROLL_FRAMES;
    turn[k] = (now - before) / ROLL_FRAMES;
  }
  return { pos, turn };
}

/**
 * How much of a wheel's turn is drawn: all of it while it turns half a digit a frame or less, none of it at a digit a
 * frame or more, where the eye sees digits that change and not a wheel that turns.
 */
export function rollDrawn(rate: number): number {
  return Math.min(1, Math.max(0, 2 - 2 * rate));
}

/**
 * How far the digits of a rolling counter are seen to travel from the frame before, in pitches of its wheels: the
 * turn of the wheel whose turn is drawn the farthest, negative as the number falls. A wheel too fast to be drawn
 * turning changes its digits in place, which is no travel.
 */
export function rollTravel(w: CountWheels): number {
  let best = 0;
  for (let k = 0; k < w.turn.length; k++) {
    const turn = w.turn[k]!;
    const seen = turn * rollDrawn(Math.abs(turn));
    if (Math.abs(seen) > Math.abs(best)) best = seen;
  }
  return best;
}

/** A piece of the line of a rolling counter. */
export interface RollRun {
  readonly text: string;
  readonly x: number;
  /** A digit on its way: the one coming up from below, how far it has come (0..1), and the width of its cell. */
  readonly roll?: { readonly next: string; readonly share: number; readonly width: number };
}

/**
 * The line of a rolling counter at a frame, as countRuns sets it: the number has as many places as its wheels show,
 * each digit in its cell, a digit on its way with the next one and its share, and a sign between groups that comes in
 * with the digit before it. `number` is the number as it stands, the digits on their way at the ones they leave.
 */
export function rollRuns(layout: TextLayout, slot: CountSlot, w: CountWheels, decimals: number, lang: string, grouping: boolean, align: TextAlign): { runs: RollRun[]; number: string } {
  const n = w.pos.length;
  const digit: number[] = [];
  const share: number[] = [];
  for (let k = 0; k < n; k++) {
    let d = Math.floor(w.pos[k]!);
    let s = w.pos[k]! - d;
    if (s > 1 - 1e-9) {
      d += 1;
      s = 0;
    }
    if (s < 1e-6) s = 0;
    digit.push(d);
    share.push(s * rollDrawn(Math.abs(w.turn[k]!)));
  }
  // The highest wheel that shows a digit, and the highest that turns one in from blank.
  let top = decimals;
  for (let k = n - 1; k > decimals; k--) {
    if (digit[k]! >= 1) {
      top = k;
      break;
    }
  }
  let high = top;
  for (let k = n - 1; k > top; k--) {
    if (share[k]! > 0) {
      high = k;
      break;
    }
  }
  // The number as the language writes one of that many places, its digits replaced by the wheels'.
  const shape = [...formatCount(10 ** (high - decimals), decimals, lang, grouping)];
  const { size, weight } = layout;
  const cell = digitCell(size, weight).width;
  const prefixW = slot.prefix ? measureText(slot.prefix, size, weight) : 0;
  const suffixW = slot.suffix ? measureText(slot.suffix, size, weight) : 0;
  const widths = shape.map((ch) => (DIGITS.includes(ch) ? cell : measureText(ch, size, weight)));
  const total = prefixW + widths.reduce((a, b) => a + b, 0) + suffixW;
  const left = align === 'center' ? -layout.width / 2 : align === 'left' ? 0 : -layout.width;
  let x = align === 'center' ? left + (layout.width - total) / 2 : align === 'left' ? left : left + layout.width - total;
  // Which wheel each digit of the shape is, counted from the right.
  const wheelOf: number[] = new Array(shape.length).fill(-1);
  for (let i = shape.length - 1, k = 0; i >= 0; i--) if (DIGITS.includes(shape[i]!)) wheelOf[i] = k++;
  const runs: RollRun[] = [];
  let number = '';
  if (slot.prefix.trim()) runs.push({ text: slot.prefix, x: x + prefixW / 2 });
  x += prefixW;
  // A sign between groups to the left of the highest digit shown comes in with the wheel before it.
  const topAt = wheelOf.indexOf(top);
  let incoming = 0;
  shape.forEach((ch, i) => {
    const mid = x + widths[i]! / 2;
    x += widths[i]!;
    const k = wheelOf[i]!;
    if (k >= 0) {
      const blank = k > top;
      const from = blank ? '' : String(digit[k]! % 10);
      const next = String((digit[k]! + 1) % 10);
      const s = share[k]!;
      if (blank) incoming = s;
      number += from;
      if (s > 0) runs.push({ text: from, x: mid, roll: { next, share: s, width: widths[i]! } });
      else if (from) runs.push({ text: from, x: mid });
      return;
    }
    if (i < topAt) {
      if (incoming > 0 && ch.trim()) runs.push({ text: '', x: mid, roll: { next: ch, share: incoming, width: widths[i]! } });
      return;
    }
    number += ch;
    if (ch.trim()) runs.push({ text: ch, x: mid });
  });
  if (slot.suffix.trim()) runs.push({ text: slot.suffix, x: x + suffixW / 2 });
  return { runs, number };
}
