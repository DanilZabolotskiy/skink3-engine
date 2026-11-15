// Automatic light. One direction per shot; every lit part is derived from the
// shape itself:
//
//   shadow crescent  = shape minus the shape shifted toward the light
//   deeper shadow    = the same with a smaller shift, stacked on top
//   lit rim          = shape minus the shape shifted away from the light
//   highlight stroke = a short round-capped stroke just inside the lit edge
//
// Glow is described here as numbers (line, halo, background lift); the renderer
// composites it.

import type { Path2D } from 'skia-canvas';
import { DEG, TAU, type Vec2 } from '../core/math.ts';
import { outlineOf, shapeExtent, type ShapeSpec } from '../shape/geometry.ts';
import { polylinePath, shapePath, shiftPath, subtractPath } from '../shape/path.ts';

export type LightFrom =
  | 'top-left' | 'top' | 'top-right'
  | 'left' | 'right'
  | 'bottom-left' | 'bottom' | 'bottom-right';

export interface LightSpec {
  /** Where the light comes from: a named side, or an angle in degrees (0 = right, -90 = top). */
  readonly from: LightFrom | number;
}

const LIGHT_ANGLES: Readonly<Record<LightFrom, number>> = {
  right: 0,
  'bottom-right': 45,
  bottom: 90,
  'bottom-left': 135,
  left: 180,
  'top-left': -135,
  top: -90,
  'top-right': -45,
};

/** Unit vector that points from a shape toward the light, in screen space (y down). */
export function lightVector(light: LightSpec): Vec2 {
  const deg = typeof light.from === 'number' ? light.from : LIGHT_ANGLES[light.from];
  if (deg === undefined || !Number.isFinite(deg)) {
    throw new Error(`light.from must be an angle in degrees or one of: ${Object.keys(LIGHT_ANGLES).join(', ')}`);
  }
  return [Math.cos(deg * DEG), Math.sin(deg * DEG)];
}

/** Proportions of the lit parts, as fractions of the shape's inner radius. */
export const LIGHT_PROPORTIONS = {
  shadowShift: 0.3,
  deepShadowShift: 0.11,
  rimShift: 0.07,
  rimLightShift: 0.05,
  /** How far inside the edge the highlight stroke runs. */
  highlightInset: 0.26,
  /** Half of the stroke's length as a share of the perimeter, and its cap in inner radii. */
  highlightSpan: 0.085,
  highlightMaxSpan: 1.15,
  highlightWidth: 0.075,
  /** Sharpness of the soft maximum that places the stroke (higher = closer to the single farthest point). */
  highlightFocus: 10,
} as const;

export interface LitParts {
  /** Crescent on the side away from the light. */
  readonly shadow: Path2D;
  /** Narrower crescent stacked on the shadow, for the deepest tone. */
  readonly deepShadow: Path2D;
  /** Thin crescent on the lit side. */
  readonly rim: Path2D;
  /** Very thin crescent at the far edge of the shadow side, for an optional coloured rim light. */
  readonly rimLight: Path2D;
  /** Open stroke just inside the lit edge. */
  readonly highlight: Path2D;
  readonly highlightWidth: number;
}

const partsCache = new WeakMap<ShapeSpec, { lx: number; ly: number; parts: LitParts }>();

function highlightStroke(spec: ShapeSpec, lightLocal: Vec2): Path2D {
  const pts = outlineOf(spec);
  const n = pts.length;
  const { center, inner, outer } = shapeExtent(spec);
  const P = LIGHT_PROPORTIONS;

  // Where the stroke is centred: the part of the outline that reaches farthest
  // toward the light. A soft maximum (a weighted circular mean of the outline
  // positions) is used instead of the single farthest point, so that the stroke
  // slides along a flat edge as the shape turns instead of jumping between corners.
  let best = -Infinity;
  const toward = new Float64Array(n);
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % n]!;
    toward[i] = (p[0] - center[0]) * lightLocal[0] + (p[1] - center[1]) * lightLocal[1];
    if (toward[i]! > best) best = toward[i]!;
    perimeter += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.exp((P.highlightFocus * (toward[i]! - best)) / outer);
    const a = (i / n) * TAU;
    sx += w * Math.cos(a);
    sy += w * Math.sin(a);
  }
  const at = (Math.atan2(sy, sx) / TAU) * n;

  // Half of the stroke's length: a share of the perimeter, but never longer than
  // the shape is thick, so that it does not wrap around the end of a long shape.
  const halfLength = Math.min(P.highlightSpan * perimeter, P.highlightMaxSpan * inner);
  const half = (halfLength / perimeter) * n;
  const inset = inner * P.highlightInset;
  const steps = 14;
  const out: Vec2[] = [];
  for (let k = 0; k <= steps; k++) {
    const f = at - half + (2 * half * k) / steps;
    const i0 = Math.floor(f);
    const t = f - i0;
    const a = pts[((i0 % n) + n) % n]!;
    const b = pts[(((i0 + 1) % n) + n) % n]!;
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    // Step in from the edge along its inward normal (the outline runs clockwise on
    // screen), so that the stroke stays parallel to the lit edge on any shape.
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty);
    out.push(tl > 1e-9 ? [x - (ty / tl) * inset, y + (tx / tl) * inset] : [x, y]);
  }
  return polylinePath(out);
}

/**
 * The lit parts of a shape for a light direction given in the shape's local
 * space (the shot's light vector rotated by minus the shape's rotation).
 */
export function litParts(spec: ShapeSpec, lightLocal: Vec2): LitParts {
  const cached = partsCache.get(spec);
  if (cached && cached.lx === lightLocal[0] && cached.ly === lightLocal[1]) return cached.parts;
  const P = LIGHT_PROPORTIONS;
  const size = shapeExtent(spec).inner;
  const base = shapePath(spec);
  const [lx, ly] = lightLocal;
  const parts: LitParts = {
    shadow: subtractPath(base, shiftPath(base, lx * size * P.shadowShift, ly * size * P.shadowShift)),
    deepShadow: subtractPath(base, shiftPath(base, lx * size * P.deepShadowShift, ly * size * P.deepShadowShift)),
    rim: subtractPath(base, shiftPath(base, -lx * size * P.rimShift, -ly * size * P.rimShift)),
    rimLight: subtractPath(base, shiftPath(base, lx * size * P.rimLightShift, ly * size * P.rimLightShift)),
    highlight: highlightStroke(spec, lightLocal),
    highlightWidth: Math.max(1.5, size * P.highlightWidth),
  };
  partsCache.set(spec, { lx, ly, parts });
  return parts;
}

/** How a glow is built, in units of the glowing shape's outer radius (at strength 1). */
export const GLOW = {
  /** Blur radii of the two halo passes, as fractions of the outer radius, with bounds in units. */
  haloTight: { k: 0.2, min: 5, max: 14 },
  haloWide: { k: 0.9, min: 18, max: 64 },
  /** Opacity of the wide halo (under the layer) and of the tight one (over it). */
  haloWideAlpha: 0.9,
  haloTightAlpha: 0.5,
  /** The background lift is a soft disc this many outer radii wide. */
  liftRadius: 5.5,
  liftAlpha: 0.2,
} as const;
