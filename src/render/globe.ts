// A globe as it is drawn: the disc, the layers of its surface on the side that faces the viewer, a shade toward its
// edge, the night side past a soft terminator, the lights of the night side, and a thin rim of air round the disc.
// Everything is drawn in the globe's own space, so its rotation turns the light with it. The geometry is that of
// scene/globe.ts; here are only the paints.

import { Path2D, type CanvasRenderingContext2D } from 'skia-canvas';
import { smoothstep, TAU } from '../core/math.ts';
import { withAlpha } from '../look/color.ts';
import { itemFill, type ShapeItem } from '../scene/evaluate.ts';
import { globeView, nightOutline, sunOf, toView, visibleRings } from '../scene/globe.ts';
import type { ShapeNode } from '../scene/types.ts';

/** Levels of brightness the lights of a night side are drawn in: each level one path. */
const LIGHT_LEVELS = 8;

/** A closed outline of x, y in turn added to a path. */
function addLoop(path: Path2D, loop: Float64Array): void {
  path.moveTo(loop[0]!, loop[1]!);
  for (let i = 2; i < loop.length; i += 2) path.lineTo(loop[i]!, loop[i + 1]!);
  path.closePath();
}

/** Draws a shape with a globe. `tone` gives a colour as the layer's atmosphere has it. */
export function drawGlobe(ctx: CanvasRenderingContext2D, item: ShapeItem, tone: (hex: string) => string): void {
  const node = item.node.node as ShapeNode;
  const g = node.globe!;
  const colors = item.node.colors;
  const r = node.shape.kind === 'circle' ? node.shape.r : 1;
  const t = item.globeAt ?? 0;
  const { xf } = item;
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  const m = ctx.getTransform();
  // Pixels of the canvas to a unit of the globe: blurs are given in pixels.
  const px = Math.max(1e-6, Math.hypot(m.a, m.b));
  const blur = (units: number): string => `blur(${(units * px).toFixed(3)}px)`;
  const disc = new Path2D();
  disc.arc(0, 0, r, 0, TAU);
  ctx.fillStyle = tone(itemFill(item));
  ctx.fill(disc);

  ctx.save();
  ctx.clip(disc);
  g.layers.forEach((layer, k) => {
    // A keyed layer (fadeTo, fillTo on its id) is drawn at its opacity and in its fill of this frame.
    const keyed = item.globeLayers?.[k] ?? null;
    const opacity = keyed ? keyed.opacity : layer.opacity;
    if (keyed && opacity <= 1e-4) return;
    const loops = visibleRings(layer.rings, layer.holes, globeView(g, t, layer.drift), r);
    if (loops.length === 0) return;
    const path = new Path2D();
    for (const loop of loops) addLoop(path, loop);
    const colour = tone(keyed ? keyed.fill : colors[`globe.layer${k}`]!);
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = colour;
    if (layer.soft > 0) {
      ctx.filter = blur(layer.soft * r * 0.5);
      ctx.fill(path, 'nonzero');
    } else {
      ctx.fill(path, 'nonzero');
      // A hairline of its own colour closes the seams between polygons that meet, each thinned alone. A keyed layer
      // loses it gradually as it fades from 1 to 0.9, so that it neither pops nor darkens the edge of a faded layer.
      const hairline = keyed ? Math.min(1, Math.max(0, (opacity - 0.9) / 0.1)) : layer.opacity >= 1 ? 1 : 0;
      if (hairline > 0) {
        ctx.globalAlpha = opacity * hairline;
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.2 / px;
        ctx.lineJoin = 'round';
        ctx.stroke(path);
      }
    }
    ctx.restore();
  });

  const night = tone(colors['globe.night']!);
  const sun = g.light ? sunOf(g.light) : null;
  if (g.shade > 0) {
    // Darker toward the edge, least so where the light falls.
    const cx = sun ? sun[0] * r * 0.35 : 0;
    const cy = sun ? -sun[1] * r * 0.35 : 0;
    const shade = ctx.createRadialGradient(cx, cy, r * 0.15, 0, 0, r);
    shade.addColorStop(0, withAlpha(night, 0));
    shade.addColorStop(0.55, withAlpha(night, g.shade * 0.18));
    shade.addColorStop(1, withAlpha(night, g.shade * 0.75));
    ctx.fillStyle = shade;
    ctx.fill(disc);
  }

  if (g.light && g.night.amount > 0) {
    const outline = nightOutline(g.light, r);
    if (outline) {
      const path = new Path2D();
      addLoop(path, outline);
      ctx.save();
      if (g.night.soft > 0) ctx.filter = blur(g.night.soft * r * 0.5);
      ctx.fillStyle = withAlpha(night, g.night.amount);
      ctx.fill(path);
      ctx.restore();
    }
  }

  if (g.lights && sun && g.lights.amount > 0) {
    const v = globeView(g, t);
    const pts = g.lights.points;
    const least = 0.6 / px;
    const levels: Path2D[] = Array.from({ length: LIGHT_LEVELS }, () => new Path2D());
    const halos: Path2D[] = Array.from({ length: LIGHT_LEVELS }, () => new Path2D());
    let any = false;
    for (let i = 0; i < pts.length; i += 4) {
      const [x, y, z] = toView(v, pts[i]!, pts[i + 1]!, pts[i + 2]!);
      if (z <= 0) continue;
      // Deeper in the night, brighter; at the limb, none.
      const dark = -(x * sun[0] + y * sun[1] + z * sun[2]);
      const a = smoothstep(0.02, 0.24, dark) * smoothstep(0, 0.12, z);
      const level = Math.round(a * LIGHT_LEVELS);
      if (level <= 0) continue;
      const size = Math.max(least, g.lights.size * Math.min(4, Math.sqrt(pts[i + 3]!)));
      const sx = x * r;
      const sy = -y * r;
      levels[level - 1]!.moveTo(sx + size, sy);
      levels[level - 1]!.arc(sx, sy, size, 0, TAU);
      halos[level - 1]!.moveTo(sx + size * 2.6, sy);
      halos[level - 1]!.arc(sx, sy, size * 2.6, 0, TAU);
      any = true;
    }
    if (any) {
      const colour = tone(colors['globe.lights']!);
      for (let k = 0; k < LIGHT_LEVELS; k++) {
        const a = (g.lights.amount * (k + 1)) / LIGHT_LEVELS;
        ctx.fillStyle = withAlpha(colour, a * 0.22);
        ctx.fill(halos[k]!);
        ctx.fillStyle = withAlpha(colour, a);
        ctx.fill(levels[k]!);
      }
    }
  }
  ctx.restore();

  if (g.air && g.air.amount > 0) {
    // The air: a soft ring that reaches a little over the edge of the disc, faint on the night side.
    const w = g.air.width;
    const colour = tone(colors['globe.air']!);
    const ring = ctx.createConicGradient(0, 0, 0);
    const from = g.light ? (g.light.from * Math.PI) / 180 : 0;
    const side = sun ? Math.hypot(sun[0], sun[1]) : 0;
    for (let k = 0; k <= 36; k++) {
      const a = (k / 36) * TAU;
      const lit = g.light ? smoothstep(-0.35, 0.45, side * Math.cos(a - from) + (sun![2] > 0 ? sun![2] * 0.6 : 0)) : 1;
      ring.addColorStop(k / 36, withAlpha(colour, g.air.amount * (0.12 + 0.88 * lit)));
    }
    ctx.save();
    ctx.strokeStyle = ring;
    ctx.lineWidth = w;
    ctx.filter = blur(w * 0.35);
    ctx.beginPath();
    ctx.arc(0, 0, r + w * 0.25, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}
