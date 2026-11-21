// Relief: a field of heights drawn as the light falls on it, worked out at every pixel of the frame it covers.
//
// A grid of heights (a digital elevation model) is shaded once: at each point of the grid, how much more or less
// light its slope takes than flat ground does (hill shading, light from one side and from above). On every frame the
// pixels the field covers are walked one by one: each is taken back into the field through the transform the field is
// drawn with (a perspective of a plane included), and its shade, and its height for a tint, are read off the grid
// between its points along smooth curves (Catmull-Rom). So the relief has no pixels of its own: however near the
// camera comes, it is as smooth as the grid's curves, and it is the same on the CPU and on the GPU.
//
// The colours are the scene's: what the shade turns toward on the dark side and on the lit side, and, given, the
// tints of the ground by height. Without tints only the shading is drawn, over what lies under it.

import { Canvas, ImageData, type CanvasRenderingContext2D } from 'skia-canvas';
import { parseHex } from '../look/color.ts';
import type { ShapeItem } from '../scene/evaluate.ts';
import type { ReliefSpec, ShapeNode } from '../scene/types.ts';
import { planeCanvas } from './plane.ts';

/** The shading of a grid, made once per field and per direction of the light in its own space. */
interface Shading {
  readonly key: string;
  /** -1 (as dark as it gets) .. 0 (flat ground) .. 1 (as lit as it gets), at each point of the grid. */
  readonly shade: Float32Array;
}

const shadings = new WeakMap<ReliefSpec, Shading>();

/**
 * The shading of a field: the normal of the ground at each point of the grid (central differences, in units of the
 * scene), against the light. `from` is where the light comes from in the field's own space, in radians (0: from its
 * right, -pi/2: from its top), `high` how high, in radians over the ground.
 */
function shadingOf(spec: ReliefSpec, w: number, h: number, from: number, high: number): Shading {
  const key = `${w},${h},${from},${high}`;
  const hit = shadings.get(spec);
  if (hit && hit.key === key) return hit;
  const { cols, rows, heights, vertical } = spec;
  const dx = w / (cols - 1);
  const dy = h / (rows - 1);
  const lx = Math.cos(from) * Math.cos(high);
  const ly = Math.sin(from) * Math.cos(high);
  const lz = Math.sin(high);
  const shade = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const r0 = Math.max(0, r - 1);
    const r1 = Math.min(rows - 1, r + 1);
    for (let c = 0; c < cols; c++) {
      const c0 = Math.max(0, c - 1);
      const c1 = Math.min(cols - 1, c + 1);
      // The slope of the ground along x and along y, in units of height per unit of the scene.
      const sx = ((heights[r * cols + c1]! - heights[r * cols + c0]!) * vertical) / ((c1 - c0) * dx);
      const sy = ((heights[r1 * cols + c]! - heights[r0 * cols + c]!) * vertical) / ((r1 - r0) * dy);
      // Up is out of the ground: the normal is (-sx, -sy, 1), and y of the field runs down the map.
      const n = Math.hypot(sx, sy, 1);
      const lit = (-sx * lx - sy * ly + lz) / n;
      shade[r * cols + c] = lit >= lz ? (lit - lz) / Math.max(1e-6, 1 - lz) : (lit - lz) / Math.max(1e-6, lz);
    }
  }
  const made = { key, shade };
  shadings.set(spec, made);
  return made;
}

/** Catmull-Rom weights of the four points around a place t (0..1) between the second and the third. */
function weights(t: number, out: Float64Array): void {
  const t2 = t * t;
  const t3 = t2 * t;
  out[0] = 0.5 * (-t3 + 2 * t2 - t);
  out[1] = 0.5 * (3 * t3 - 5 * t2 + 2);
  out[2] = 0.5 * (-3 * t3 + 4 * t2 + t);
  out[3] = 0.5 * (t3 - t2);
}

/** Colours as 0..255 numbers. */
type Rgb = readonly [number, number, number];

function rgbOf(hex: string): Rgb {
  const c = parseHex(hex);
  return [c.r, c.g, c.b];
}

/** The tint of the ground at a height: between the two stops around it, the ends held. */
function tintAt(stops: readonly { at: number; rgb: Rgb }[], z: number, out: number[]): void {
  if (z <= stops[0]!.at) {
    out[0] = stops[0]!.rgb[0];
    out[1] = stops[0]!.rgb[1];
    out[2] = stops[0]!.rgb[2];
    return;
  }
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i]!;
    if (z <= b.at) {
      const a = stops[i - 1]!;
      const t = (z - a.at) / Math.max(1e-9, b.at - a.at);
      out[0] = a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t;
      out[1] = a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t;
      out[2] = a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t;
      return;
    }
  }
  const last = stops[stops.length - 1]!;
  out[0] = last.rgb[0];
  out[1] = last.rgb[1];
  out[2] = last.rgb[2];
}

/**
 * Draws a field of heights (a rect with relief) where it lies, through the transform of `ctx`: every pixel of the
 * canvas the field covers, worked out by itself. `tone` gives the colour of a palette hex as the layer paints it.
 */
export function drawRelief(ctx: CanvasRenderingContext2D, item: ShapeItem, tone: (hex: string) => string): void {
  const node = item.node.node as ShapeNode;
  const spec = node.relief!;
  const shape = node.shape;
  if (shape.kind !== 'polygon') return;
  // The field spans the rect: its corners are the outer points of the shape.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of shape.points) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  const fw = x1 - x0;
  const fh = y1 - y0;
  if (!(fw > 0 && fh > 0)) return;
  const raw = planeCanvas(ctx)?.raw ?? ctx;
  const { xf } = item;
  // From the field's own space to the pixels of the canvas.
  const m = ctx.getTransform().translate(xf.x, xf.y).rotate((xf.rot * 180) / Math.PI).scale(xf.scale, xf.scale);
  const width = raw.canvas.width;
  const height = raw.canvas.height;

  // The pixels the field may cover: around its corners, or the whole canvas when a corner lies behind the camera.
  let bx0 = 0;
  let by0 = 0;
  let bx1 = width;
  let by1 = height;
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  let behind = false;
  let cx0 = Infinity;
  let cy0 = Infinity;
  let cx1 = -Infinity;
  let cy1 = -Infinity;
  for (const [x, y] of corners) {
    const w = m.m14 * x + m.m24 * y + m.m44;
    if (!(w > 1e-6)) {
      behind = true;
      break;
    }
    const X = (m.m11 * x + m.m21 * y + m.m41) / w;
    const Y = (m.m12 * x + m.m22 * y + m.m42) / w;
    cx0 = Math.min(cx0, X);
    cy0 = Math.min(cy0, Y);
    cx1 = Math.max(cx1, X);
    cy1 = Math.max(cy1, Y);
  }
  if (!behind) {
    bx0 = Math.max(0, Math.floor(cx0) - 1);
    by0 = Math.max(0, Math.floor(cy0) - 1);
    bx1 = Math.min(width, Math.ceil(cx1) + 1);
    by1 = Math.min(height, Math.ceil(cy1) + 1);
  }
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  if (bw <= 0 || bh <= 0) return;

  // From a pixel back into the field: the inverse of the 3 x 3 of m.
  const [a, b, c, d, e, f, g, hh, i] = [m.m11, m.m12, m.m21, m.m22, m.m41, m.m42, m.m14, m.m24, m.m44];
  const det = a * (d * i - f * hh) - c * (b * i - f * g) + e * (b * hh - d * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return;
  const ia = (d * i - f * hh) / det;
  const ic = -(c * i - e * hh) / det;
  const ie = (c * f - e * d) / det;
  const ib = -(b * i - f * g) / det;
  const id = (a * i - e * g) / det;
  const if_ = -(a * f - e * b) / det;
  const ig = (b * hh - d * g) / det;
  const ih = -(a * hh - c * g) / det;
  const ii = (a * d - c * b) / det;

  // The light in the field's own space: it comes from where the scene says on the map, the field turned with it.
  const from = (spec.from * Math.PI) / 180 - xf.rot;
  const { shade } = shadingOf(spec, fw, fh, from, (spec.high * Math.PI) / 180);
  const { cols, rows, heights } = spec;
  const colors = item.node.colors;
  const dark = rgbOf(tone(colors['relief.dark']!));
  const bright = rgbOf(tone(colors['relief.bright']!));
  const stops = spec.tints?.map((t, k) => ({ at: t[0], rgb: rgbOf(tone(colors[`relief.tint${k}`]!)) })) ?? null;
  const amount = spec.amount;
  const sx = (cols - 1) / fw;
  const sy = (rows - 1) / fh;

  const data = new Uint8ClampedArray(bw * bh * 4);
  const wx = new Float64Array(4);
  const wy = new Float64Array(4);
  const tint = [0, 0, 0];
  for (let py = 0; py < bh; py++) {
    const Y = by0 + py + 0.5;
    for (let px = 0; px < bw; px++) {
      const X = bx0 + px + 0.5;
      const w = ig * X + ih * Y + ii;
      if (!(w > 0)) continue;
      // Where the pixel lies on the grid, in points of it.
      const gx = (((ia * X + ic * Y + ie) / w - x0) * sx);
      const gy = (((ib * X + id * Y + if_) / w - y0) * sy);
      if (!(gx >= 0 && gy >= 0 && gx <= cols - 1 && gy <= rows - 1)) continue;
      const c0 = Math.min(cols - 2, Math.floor(gx));
      const r0 = Math.min(rows - 2, Math.floor(gy));
      weights(gx - c0, wx);
      weights(gy - r0, wy);
      let s = 0;
      let z = 0;
      for (let j = 0; j < 4; j++) {
        const r = Math.max(0, Math.min(rows - 1, r0 - 1 + j)) * cols;
        let rs = 0;
        let rz = 0;
        for (let k = 0; k < 4; k++) {
          const at = r + Math.max(0, Math.min(cols - 1, c0 - 1 + k));
          rs += wx[k]! * shade[at]!;
          if (stops) rz += wx[k]! * heights[at]!;
        }
        s += wy[j]! * rs;
        z += wy[j]! * rz;
      }
      s = Math.max(-1, Math.min(1, s)) * amount;
      const o = (py * bw + px) * 4;
      if (stops) {
        // The tint of its height, turned toward the dark or the lit tone by its shade.
        tintAt(stops, z, tint);
        const to = s < 0 ? dark : bright;
        const t = Math.abs(s);
        data[o] = tint[0]! + (to[0] - tint[0]!) * t;
        data[o + 1] = tint[1]! + (to[1] - tint[1]!) * t;
        data[o + 2] = tint[2]! + (to[2] - tint[2]!) * t;
        data[o + 3] = 255;
      } else {
        // The shading alone: the dark or the lit tone, as strong as the shade, over what lies under it.
        const to = s < 0 ? dark : bright;
        data[o] = to[0];
        data[o + 1] = to[1];
        data[o + 2] = to[2];
        data[o + 3] = Math.abs(s) * 255;
      }
    }
  }
  const picture = new Canvas(bw, bh);
  try {
    picture.getContext('2d').putImageData(new ImageData(data, bw, bh), 0, 0);
    raw.save();
    // The outline of the field keeps its edge smooth where it shows.
    raw.setTransform(m);
    raw.beginPath();
    raw.rect(x0, y0, fw, fh);
    if (!behind) raw.clip();
    raw.setTransform(1, 0, 0, 1, 0, 0);
    raw.drawCanvas(picture, bx0, by0);
    raw.restore();
  } finally {
    picture.dispose();
  }
}
