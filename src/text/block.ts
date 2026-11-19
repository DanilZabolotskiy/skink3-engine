// Free-standing text: a block of lines laid out around the origin of its node,
// with an optional rounded box behind it. Unlike a label it has no pointer:
// it belongs to the frame, or to the shape it lies on.

import { Path2D } from 'skia-canvas';
import { LABEL_PROPORTIONS } from './label.ts';
import type { TextLayout } from './layout.ts';
import type { RunSpan } from './runs.ts';

export type TextAlign = 'left' | 'center' | 'right';

export const TEXT_ALIGNS: readonly TextAlign[] = ['left', 'center', 'right'];

export interface TextBlock {
  /** What is drawn, relative to the origin of the node: the box when there is one, else the lines themselves. */
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** The rounded box behind the lines, or null. */
  readonly path: Path2D | null;
  /** Centre x and baseline y of each line, relative to the origin; a line with a run of the second ink has its spans (see runs.ts). */
  readonly lines: readonly { readonly text: string; readonly x: number; readonly y: number; readonly runs?: readonly RunSpan[] }[];
  readonly size: number;
  readonly weight: number;
}

/**
 * The block of a laid-out text. Up and down it is centred on the origin.
 * Sideways the origin is its middle ('center'), where its lines start
 * ('left') or where they end ('right'). A box, when asked for, lies round the
 * lines with the padding and the corners of a label.
 */
export function textBlock(layout: TextLayout, align: TextAlign, boxed: boolean): TextBlock {
  const P = LABEL_PROPORTIONS;
  const s = layout.size;
  const w = layout.width;
  const h = layout.capHeight + (layout.lines.length - 1) * layout.lineHeight;
  const left = align === 'center' ? -w / 2 : align === 'left' ? 0 : -w;
  const top = -h / 2;
  const lines = layout.lines.map((text, i) => {
    const lw = layout.widths[i]!;
    return { text, x: align === 'center' ? left + w / 2 : align === 'left' ? left + lw / 2 : left + w - lw / 2, y: top + layout.capHeight + i * layout.lineHeight };
  });
  if (!boxed) return { box: { x: left, y: top, w, h }, path: null, lines, size: s, weight: layout.weight };
  const box = { x: left - P.padX * s, y: top - P.padY * s, w: w + 2 * P.padX * s, h: h + 2 * P.padY * s };
  const path = new Path2D();
  path.roundRect(box.x, box.y, box.w, box.h, Math.min(P.radius * s, box.h / 2, box.w / 2));
  return { box, path, lines, size: s, weight: layout.weight };
}
