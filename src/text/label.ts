// Label geometry: a rounded rectangle with a pointer tail, sized to its text.
// Everything is expressed relative to the tip of the tail at (0, 0).

import { Path2D } from 'skia-canvas';
import type { LabelSide } from '../scene/types.ts';
import { roundPath, unionPath } from '../shape/path.ts';
import type { TextLayout } from './layout.ts';
import type { RunSpan } from './runs.ts';

/** Label proportions as multiples of the font size actually used. */
export const LABEL_PROPORTIONS = {
  padX: 0.7,
  padY: 0.46,
  radius: 0.48,
  tailLength: 0.5,
  tailWidth: 0.8,
  weight: 800,
} as const;

export interface LabelGeometry {
  /** The box, relative to the tip of the tail. */
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** Box and tail as one outline. */
  readonly path: Path2D;
  /** Centre x and baseline y of each line, relative to the tip; a line with a run of the second ink has its spans (see runs.ts). */
  readonly lines: readonly { readonly text: string; readonly x: number; readonly y: number; readonly runs?: readonly RunSpan[] }[];
  readonly size: number;
  readonly weight: number;
}

export function labelGeometry(layout: TextLayout, side: LabelSide): LabelGeometry {
  const P = LABEL_PROPORTIONS;
  const s = layout.size;
  const w = layout.width + 2 * P.padX * s;
  const textH = layout.capHeight + (layout.lines.length - 1) * layout.lineHeight;
  const h = textH + 2 * P.padY * s;
  const tail = P.tailLength * s;
  const half = (P.tailWidth * s) / 2;
  const r = Math.min(P.radius * s, h / 2, w / 2);

  let x: number;
  let y: number;
  const tri = new Path2D();
  // The tail's base sits a little inside the box so that the union is one clean outline.
  const sink = Math.min(r, tail);
  switch (side) {
    case 'top':
      x = -w / 2;
      y = -tail - h;
      tri.moveTo(-half, -tail - sink);
      tri.lineTo(half, -tail - sink);
      tri.lineTo(0, 0);
      break;
    case 'bottom':
      x = -w / 2;
      y = tail;
      tri.moveTo(half, tail + sink);
      tri.lineTo(-half, tail + sink);
      tri.lineTo(0, 0);
      break;
    case 'left':
      x = -tail - w;
      y = -h / 2;
      tri.moveTo(-tail - sink, half);
      tri.lineTo(-tail - sink, -half);
      tri.lineTo(0, 0);
      break;
    case 'right':
      x = tail;
      y = -h / 2;
      tri.moveTo(tail + sink, -half);
      tri.lineTo(tail + sink, half);
      tri.lineTo(0, 0);
      break;
  }
  tri.closePath();

  const box = new Path2D();
  box.roundRect(x, y, w, h, r);
  const path = unionPath(box, roundPath(tri, Math.max(1, s * 0.08)));

  const lines = layout.lines.map((text, i) => ({
    text,
    x: x + w / 2,
    y: y + P.padY * s + layout.capHeight + i * layout.lineHeight,
  }));
  return { box: { x, y, w, h }, path, lines, size: s, weight: layout.weight };
}
