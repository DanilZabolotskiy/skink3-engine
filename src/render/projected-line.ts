import type { DOMMatrix } from 'skia-canvas';
import { pathAt, SAMPLES, type PathTable } from '../motion/paths.ts';
type Matrix = Pick<DOMMatrix, 'm11' | 'm12' | 'm14' | 'm21' | 'm22' | 'm24' | 'm41' | 'm42' | 'm44'>;

/** Draw a polyline simplified in output pixels. Keep the original length table, reveal endpoint, and all near-eye samples. */
export function projectedLine(
  table: PathTable,
  from: number,
  to: number,
  m: Matrix,
  emit: (x: number, y: number) => void,
  foot?: { readonly k: number; readonly x: number; readonly y: number },
): void {
  const start = pathAt(table, from),
    end = pathAt(table, to);
  const { xs, ys, cum } = table;
  const x = new Float64Array(SAMPLES + 2),
    y = new Float64Array(SAMPLES + 2),
    px = new Float64Array(SAMPLES + 2),
    py = new Float64Array(SAMPLES + 2);
  const lowX = foot ? new Float64Array(SAMPLES + 2) : undefined;
  const lowY = foot ? new Float64Array(SAMPLES + 2) : undefined;
  let count = 0;
  const project = (u: number, v: number, sx: Float64Array, sy: Float64Array): void => {
    const w = m.m14 * u + m.m24 * v + m.m44;
    sx[count] = w > 0.125 ? (m.m11 * u + m.m21 * v + m.m41) / w : NaN;
    sy[count] = w > 0.125 ? (m.m12 * u + m.m22 * v + m.m42) / w : NaN;
  };
  const add = (u: number, v: number): void => {
    x[count] = u;
    y[count] = v;
    project(u, v, px, py);
    if (foot) project(foot.k * u + foot.x, foot.k * v + foot.y, lowX!, lowY!);
    count++;
  };
  const flat = (
    sx: Float64Array,
    sy: Float64Array,
    first: number,
    last: number,
    tolerance: number,
  ): { error: number; split: number } => {
    const a = sx[first]!,
      b = sy[first]!,
      dx = sx[last]! - a,
      dy = sy[last]! - b,
      d = dx * dx + dy * dy;
    let error = tolerance,
      split = -1;
    if (!Number.isFinite(d)) return { error: Infinity, split: -1 };
    for (let j = first + 1; j < last; j++) {
      const u = sx[j]! - a,
        v = sy[j]! - b,
        t = d ? Math.max(0, Math.min(1, (u * dx + v * dy) / d)) : 0;
      const e = (u - t * dx) ** 2 + (v - t * dy) ** 2;
      if (!Number.isFinite(e)) return { error: Infinity, split: -1 };
      if (e > error) {
        split = j;
        error = e;
      }
    }
    return { error, split };
  };
  const draw = (first: number, last: number): void => {
    let hit = flat(px, py, first, last, 0.25 ** 2);
    if (foot && Number.isFinite(hit.error)) {
      const base = flat(lowX!, lowY!, first, last, hit.error);
      if (base.error > hit.error) hit = base;
    }
    if (!Number.isFinite(hit.error)) {
      for (let i = first + 1; i <= last; i++) emit(x[i]!, y[i]!);
      return;
    }
    if (hit.split < 0) emit(x[last]!, y[last]!);
    else {
      draw(first, hit.split);
      draw(hit.split, last);
    }
  };
  const span = (): void => {
    let first = 0;
    if (foot) {
      // Retain every silhouette turn. A wall strokes an upright wherever consecutive swept quads change winding.
      let previous = 0;
      for (let j = 0; j < count - 1; j++) {
        const ax = x[j]!,
          ay = y[j]!,
          bx = x[j + 1]!,
          by = y[j + 1]!;
        const sign = Math.sign((bx - ax) * ((foot.k - 1) * ay + foot.y) - (by - ay) * ((foot.k - 1) * ax + foot.x));
        if (j > first && sign !== previous) {
          draw(first, j);
          first = j;
        }
        previous = sign;
      }
    }
    draw(first, count - 1);
  };
  emit(start.x, start.y);
  add(start.x, start.y);
  let low = 0,
    high = cum.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >>> 1;
    if (cum[mid]! <= from) low = mid;
    else high = mid;
  }
  for (let i = high; i < cum.length - 1 && cum[i]! < to; i++) {
    add(xs[i]!, ys[i]!);
    if (i % SAMPLES === 0) {
      span();
      count = 0;
      add(xs[i]!, ys[i]!);
    }
  }
  add(end.x, end.y);
  span();
}
