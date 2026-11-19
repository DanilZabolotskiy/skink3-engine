// Runs in a second ink: parts of the string of a label or of a text that are
// drawn in another colour, such as a date after a value. The string of the
// table marks them, so each language marks its own: "2.0 · [Aug–Oct 2026]".
//
// The marks mean something only to a node that asks for a second ink
// (`runInk`); for any other node a bracket is a bracket. The marks are taken
// out before the string is measured, so the layout (the lines, the size, the
// box) is the layout of the text without them, and the glyphs stand where
// they stand without a run: a run only chooses the colour of its glyphs.

import { Path2D } from 'skia-canvas';
import { measureText, wordsOf, type TextLayout } from './layout.ts';

/** What opens and what closes a run in a string of the tables. */
export const RUN_OPEN = '[';
export const RUN_CLOSE = ']';

/** A string without its marks, and where its runs are in it: [start, end) in UTF-16 units of `text`. */
export interface MarkedText {
  readonly text: string;
  readonly runs: readonly (readonly [number, number])[];
}

/** A span of x on a line, from the middle of the line: [left, right]. */
export type RunSpan = readonly [number, number];

export class RunMarkupError extends Error {}

/**
 * The text of a string and its runs. A run is what stands between "[" and
 * "]". Runs do not nest, every "[" is closed, every "]" closes one, and a run
 * holds at least one character that is not a space; anything else is refused,
 * with the place of the mistake. A string with no mark has no run.
 */
export function parseRuns(marked: string): MarkedText {
  let text = '';
  const runs: [number, number][] = [];
  let open = -1;
  let openedAt = 0;
  // Places in messages count characters from 1, as an editor does.
  let place = 0;
  for (const ch of marked) {
    place++;
    if (ch === RUN_OPEN) {
      if (open >= 0) throw new RunMarkupError(`"${RUN_OPEN}" at character ${place} opens a run inside the run opened at character ${openedAt}; runs do not nest`);
      open = text.length;
      openedAt = place;
    } else if (ch === RUN_CLOSE) {
      if (open < 0) throw new RunMarkupError(`"${RUN_CLOSE}" at character ${place} closes no run`);
      if (text.slice(open).trim().length === 0) throw new RunMarkupError(`the run opened at character ${openedAt} is empty`);
      runs.push([open, text.length]);
      open = -1;
    } else text += ch;
  }
  if (open >= 0) throw new RunMarkupError(`the run opened at character ${openedAt} is never closed with "${RUN_CLOSE}"`);
  return { text, runs };
}

/**
 * Where the runs fall in the lines of a layout of `marked.text`: on each line,
 * spans of x from the middle of the line, where its outline is centred. A
 * span starts where the first character of a run starts and ends where its
 * last one ends; a run that a line break cuts is a span on each line. A line
 * without a run has no span.
 */
export function runSpans(layout: TextLayout, marked: MarkedText): RunSpan[][] {
  const words = wordsOf(marked.text);
  const inRun = (at: number): boolean => marked.runs.some(([s, e]) => at >= s && at < e);
  const out: RunSpan[][] = [];
  let w = 0;
  layout.lines.forEach((line, i) => {
    // A line is its words joined by single spaces, and no word holds one.
    const count = line.length === 0 ? 0 : line.split(' ').length;
    // Which characters of the line are in a run; a space between two words is when the words on both sides of it are.
    const flags: boolean[] = [];
    for (let k = 0; k < count; k++) {
      const word = words[w + k]!;
      if (k > 0) flags.push(flags[flags.length - 1]! && inRun(word.start));
      for (let at = word.start; at < word.start + word.word.length; at++) flags.push(inRun(at));
    }
    w += count;
    const half = layout.widths[i]! / 2;
    const x = (chars: number): number => (chars === 0 ? 0 : measureText(line.slice(0, chars), layout.size, layout.weight)) - half;
    const spans: RunSpan[] = [];
    for (let k = 0; k < flags.length; k++) {
      if (!flags[k] || (k > 0 && flags[k - 1])) continue;
      let end = k;
      while (end < flags.length && flags[end]) end++;
      spans.push([x(k), x(end)]);
    }
    out.push(spans);
  });
  return out;
}

/**
 * The outline of a line cut in two by its spans, glyph by glyph: what is in a
 * run and what is not. A contour belongs to the run whose span holds the
 * middle of its bounds, so a glyph is never parted between the two, and every
 * contour stays where it was. Either part is null when it has nothing.
 */
export function splitRuns(outline: Path2D, spans: readonly RunSpan[]): { plain: Path2D | null; run: Path2D | null } {
  let plain: Path2D | null = null;
  let run: Path2D | null = null;
  for (const contour of outline.contours) {
    const b = contour.bounds;
    const mid = (b.left + b.right) / 2;
    if (spans.some(([x0, x1]) => mid >= x0 && mid < x1)) (run ??= new Path2D()).addPath(contour);
    else (plain ??= new Path2D()).addPath(contour);
  }
  return { plain, run };
}
