// A heat haze: the picture of the frame as it is drawn so far is moved, inside
// the outline of a shape, by a field of ripples that drift, so that it wavers
// like air over heat. What is drawn afterwards is not moved.
//
// The field is a pure function of the shot's seed, the shape and the time: two
// scales of seeded gradient noise, the finer one at half the size, drifting
// one way and a little across it, so that the ripples change as they go. It is
// worked out on a grid of points a few pixels apart, in the space of the
// layer, so that it keeps its place when the camera moves, and each pixel takes
// the field of the points around it. The picture is read back, moved on the CPU
// and put back: the same numbers on every machine, and on the GPU the same
// pixels in every frame drawn from the same state.

import type { CanvasRenderingContext2D } from 'skia-canvas';
import { DEG, type Vec2 } from '../core/math.ts';
import type { LayerView } from '../camera/camera.ts';
import type { HazeItem } from '../scene/evaluate.ts';

/** How far apart the points of the field lie, at most and at least, in px of the frame. */
const CELL_MAX = 12;
const CELL_MIN = 2;

/** How much each scale of ripples gives: the larger ripples, and the finer ones of half their size. */
const COARSE = 0.65;
const FINE = 0.35;

/** Degrees between where the larger ripples drift and where the finer ones do. */
const FINE_TURN = 40;

/** Up and down, the picture moves this share of how far it moves sideways. */
export const HAZE_VERTICAL = 0.5;

/** The distance from a point to a closed outline: negative inside it. */
function signedDistance(poly: readonly Vec2[], x: number, y: number): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len2 = ex * ex + ey * ey;
    const u = len2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / len2)) : 0;
    const dx = a[0] + u * ex - x;
    const dy = a[1] + u * ey - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  const d = Math.sqrt(best);
  return inside ? -d : d;
}

/** 0 outside, 1 inside, smoothly across the band of half-width `half` about the outline. */
function weightOf(distance: number, half: number): number {
  const u = Math.max(0, Math.min(1, (half - distance) / (2 * half)));
  return u * u * (3 - 2 * u);
}

/** The part of the frame a haze changes, in px: its outline with the band of its edge, inside the frame; null when none. */
export function hazeBounds(h: HazeItem, view: LayerView, k: number, width: number, height: number): { x0: number; y0: number; x1: number; y1: number; half: number; cell: number } | null {
  const scale = k * view.zoom;
  const cell = Math.max(CELL_MIN, Math.min(CELL_MAX * k, Math.floor((h.scale * scale) / 8)));
  const half = Math.max(h.soft * scale, 2 * cell);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of h.outline) {
    const x = k * (p[0] * view.zoom + view.tx);
    const y = k * (p[1] * view.zoom + view.ty);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  x0 = Math.max(0, Math.floor(x0 - half));
  y0 = Math.max(0, Math.floor(y0 - half));
  x1 = Math.min(width, Math.ceil(x1 + half));
  y1 = Math.min(height, Math.ceil(y1 + half));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1, half, cell };
}

/**
 * The field of a haze over the part of the frame it changes: for every point of a grid `cell` px apart, starting at
 * (x0, y0), how far the pixel there takes its picture from, in px, sideways and up and down.
 */
export function hazeField(h: HazeItem, view: LayerView, k: number, b: NonNullable<ReturnType<typeof hazeBounds>>): { nx: number; ny: number; dx: Float64Array; dy: Float64Array } {
  const noise = h.node.haze!.noise;
  const scale = k * view.zoom;
  const amount = h.amount * scale;
  const nx = Math.ceil((b.x1 - b.x0) / b.cell) + 1;
  const ny = Math.ceil((b.y1 - b.y0) / b.cell) + 1;
  const dx = new Float64Array(nx * ny);
  const dy = new Float64Array(nx * ny);
  const poly: Vec2[] = h.outline.map((p) => [k * (p[0] * view.zoom + view.tx), k * (p[1] * view.zoom + view.ty)]);
  // The two scales drift at the same speed, the finer one turned a little off the way of the larger ones.
  const a = h.direction * DEG;
  const f = (h.direction + FINE_TURN) * DEG;
  const way = h.speed * h.time;
  const s1 = h.scale;
  const s2 = h.scale / 2;
  for (let j = 0; j < ny; j++) {
    const py = b.y0 + j * b.cell;
    for (let i = 0; i < nx; i++) {
      const px = b.x0 + i * b.cell;
      const w = weightOf(signedDistance(poly, px, py), b.half);
      if (w <= 0) continue;
      // The point in the space of the layer, so that the ripples keep their place under the camera.
      const X = (px / k - view.tx) / view.zoom;
      const Y = (py / k - view.ty) / view.zoom;
      const u1 = (-X * Math.sin(a) + Y * Math.cos(a)) / s1;
      const v1 = (X * Math.cos(a) + Y * Math.sin(a) - way) / s1;
      const u2 = (-X * Math.sin(f) + Y * Math.cos(f)) / s2;
      const v2 = (X * Math.cos(f) + Y * Math.sin(f) - way) / s2;
      const sx = COARSE * noise.n2(u1, v1) + FINE * noise.n2(u2 + 31.7, v2 + 11.3);
      const sy = COARSE * noise.n2(u1 + 57.1, v1 + 13.9) + FINE * noise.n2(u2 + 23.3, v2 + 71.9);
      dx[j * nx + i] = amount * w * sx;
      dy[j * nx + i] = amount * w * HAZE_VERTICAL * sy;
    }
  }
  return { nx, ny, dx, dy };
}

/**
 * Moves the picture of `ctx` inside the outline of the haze. The canvas holds the frame as it is drawn so far, opaque
 * everywhere, with no transform set; `msaa` is how it is read on the GPU.
 */
export function applyHaze(ctx: CanvasRenderingContext2D, h: HazeItem, view: LayerView, k: number, width: number, height: number, msaa: number | false): void {
  const b = hazeBounds(h, view, k, width, height);
  if (!b) return;
  const field = hazeField(h, view, k, b);
  // What is read: the part it changes and as far around it as a pixel may take its picture from.
  const reach = Math.ceil(h.amount * k * view.zoom) + 2;
  const rx0 = Math.max(0, b.x0 - reach);
  const ry0 = Math.max(0, b.y0 - reach);
  const rx1 = Math.min(width, b.x1 + reach);
  const ry1 = Math.min(height, b.y1 + reach);
  const rw = rx1 - rx0;
  const rh = ry1 - ry0;
  const image = ctx.getImageData(rx0, ry0, rw, rh, msaa === false ? undefined : { msaa });
  const src = image.data;
  const out = new Uint8ClampedArray(src);
  const { nx, dx, dy } = field;
  const cell = b.cell;
  const maxX = rw - 1.000001;
  const maxY = rh - 1.000001;
  for (let y = b.y0; y < b.y1; y++) {
    const gy = (y - b.y0) / cell;
    const j = Math.floor(gy);
    const ty = gy - j;
    for (let x = b.x0; x < b.x1; x++) {
      const gx = (x - b.x0) / cell;
      const i = Math.floor(gx);
      const tx = gx - i;
      const g00 = j * nx + i;
      const g10 = g00 + 1;
      const g01 = g00 + nx;
      const g11 = g01 + 1;
      const ddx = (dx[g00]! * (1 - tx) + dx[g10]! * tx) * (1 - ty) + (dx[g01]! * (1 - tx) + dx[g11]! * tx) * ty;
      const ddy = (dy[g00]! * (1 - tx) + dy[g10]! * tx) * (1 - ty) + (dy[g01]! * (1 - tx) + dy[g11]! * tx) * ty;
      // A pixel the field leaves where it is keeps its colour exactly.
      if (Math.abs(ddx) < 1 / 512 && Math.abs(ddy) < 1 / 512) continue;
      const sx = Math.max(0, Math.min(maxX, x - rx0 + ddx));
      const sy = Math.max(0, Math.min(maxY, y - ry0 + ddy));
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      const fx = sx - ix;
      const fy = sy - iy;
      const i00 = (iy * rw + ix) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + rw * 4;
      const i11 = i01 + 4;
      const o = ((y - ry0) * rw + (x - rx0)) * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c]! + (src[i10 + c]! - src[i00 + c]!) * fx;
        const bottom = src[i01 + c]! + (src[i11 + c]! - src[i01 + c]!) * fx;
        out[o + c] = top + (bottom - top) * fy;
      }
    }
  }
  image.data.set(out);
  ctx.putImageData(image, rx0, ry0);
}
