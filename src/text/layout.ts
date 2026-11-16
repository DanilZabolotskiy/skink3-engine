// Auto-fit text layout: wrap to a width, balance the lines, and shrink the font
// when the string is too long. The same code runs for every language; a string
// that cannot be made to fit is reported as overflow instead of being cut.
//
// Phase 0 breaks lines at spaces only. Scripts without spaces, bidirectional
// text and complex shaping come with the full script coverage of phase 1.

import { Canvas, type CanvasRenderingContext2D } from 'skia-canvas';
import { ensureFonts, fontString } from './fonts.ts';

export interface TextStyle {
  /** Preferred font size in units. */
  readonly size: number;
  /** Smallest font size the layout may use. */
  readonly minSize: number;
  readonly weight: number;
  /** Widest a line may get, in units. */
  readonly maxWidth: number;
  readonly maxLines: number;
}

export interface TextLayout {
  readonly lines: readonly string[];
  readonly widths: readonly number[];
  /** Font size actually used. */
  readonly size: number;
  readonly weight: number;
  /** Width of the widest line. */
  readonly width: number;
  /** Distance between baselines. */
  readonly lineHeight: number;
  /** Height of a capital letter at this size. */
  readonly capHeight: number;
  /** True when the string does not fit even at the smallest size. */
  readonly overflow: boolean;
  /** What went wrong when `overflow` is true. */
  readonly overflowReason: string | null;
}

/** Distance between baselines as a multiple of the font size. */
export const LINE_HEIGHT = 1.18;

let measureCtx: CanvasRenderingContext2D | null = null;

function ctx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    ensureFonts();
    measureCtx = new Canvas(8, 8, { gpu: false }).getContext('2d');
  }
  return measureCtx;
}

const widthCache = new Map<string, number>();

/** Advance width of a single line of text. */
export function measureText(text: string, size: number, weight: number): number {
  const key = `${weight}|${size}|${text}`;
  let w = widthCache.get(key);
  if (w === undefined) {
    const c = ctx();
    c.font = fontString(size, weight);
    w = c.measureText(text).width;
    widthCache.set(key, w);
  }
  return w;
}

/** Height of a capital letter. */
export function capHeight(size: number, weight: number): number {
  const key = `cap|${weight}|${size}`;
  let h = widthCache.get(key);
  if (h === undefined) {
    const c = ctx();
    c.font = fontString(size, weight);
    h = c.measureText('H').actualBoundingBoxAscent;
    widthCache.set(key, h);
  }
  return h;
}

function wrap(words: readonly string[], size: number, weight: number, maxWidth: number): { lines: string[]; widths: number[] } {
  const lines: string[] = [];
  const widths: number[] = [];
  let line = '';
  let lineW = 0;
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    const w = measureText(candidate, size, weight);
    if (line && w > maxWidth) {
      lines.push(line);
      widths.push(lineW);
      line = word;
      lineW = measureText(word, size, weight);
    } else {
      line = candidate;
      lineW = w;
    }
  }
  if (line) {
    lines.push(line);
    widths.push(lineW);
  }
  return { lines, widths };
}

/**
 * Where a line may break: at ordinary white space. A no-break space (U+00A0),
 * a narrow no-break space (U+202F) and a figure space (U+2007) keep the words
 * on both sides of them on one line.
 */
const BREAKABLE = /[ \t\n\r\f\v]+/;

/** Lays a string out within the style's limits, shrinking the font if it has to. */
export function layoutText(text: string, style: TextStyle): TextLayout {
  const words = text.trim().split(BREAKABLE).filter((w) => w.length > 0);
  const make = (size: number, lines: string[], widths: number[], reason: string | null): TextLayout => ({
    lines,
    widths,
    size,
    weight: style.weight,
    width: widths.reduce((a, b) => Math.max(a, b), 0),
    lineHeight: size * LINE_HEIGHT,
    capHeight: capHeight(size, style.weight),
    overflow: reason !== null,
    overflowReason: reason,
  });
  if (words.length === 0) return make(style.size, [''], [0], 'the string is empty');

  const minSize = Math.min(style.minSize, style.size);
  for (let size = style.size; size >= minSize - 1e-9; size -= 1) {
    const widest = words.reduce((a, w) => Math.max(a, measureText(w, size, style.weight)), 0);
    if (widest > style.maxWidth) continue;
    const greedy = wrap(words, size, style.weight, style.maxWidth);
    if (greedy.lines.length > style.maxLines) continue;
    // Balance: the narrowest width that still gives the same number of lines.
    let lo = widest;
    let hi = style.maxWidth;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (wrap(words, size, style.weight, mid).lines.length <= greedy.lines.length) hi = mid;
      else lo = mid;
    }
    const balanced = wrap(words, size, style.weight, hi);
    return make(size, balanced.lines, balanced.widths, null);
  }
  const last = wrap(words, minSize, style.weight, style.maxWidth);
  const widest = last.widths.reduce((a, b) => Math.max(a, b), 0);
  const reason = widest > style.maxWidth
    ? `a word is wider than ${style.maxWidth} units even at size ${minSize}`
    : `${last.lines.length} lines at size ${minSize}, but at most ${style.maxLines} fit`;
  return make(minSize, last.lines, last.widths, reason);
}
