// Drawing of the display-list items onto a Skia canvas context. The context is
// already in the layer's space; these functions only add the node's transform.
//
// Colours go through a Paint, which applies the layer's atmospheric perspective.
// Opacity is not applied here: a faded node arrives wrapped in a group, and the
// compositor fades the whole group as one picture.

import { Path2D, type CanvasRenderingContext2D } from 'skia-canvas';
import { quadAt, TAU, vrot, type Quad, type Vec2 } from '../core/math.ts';
import { atmosphereTone, lightTone, shadowTone, withAlpha } from '../look/color.ts';
import { litParts } from '../look/light.ts';
import { PULSE_LENGTH } from '../motion/curves.ts';
import { PARTICLE_STRIDE } from '../physics/cache.ts';
import type { EyeItem, LabelItem, LinkItem, ParticlesItem, ShapeItem } from '../scene/evaluate.ts';
import type { EmitterNode, EyeNode, LinkNode, ShapeNode } from '../scene/types.ts';
import { shapePath } from '../shape/path.ts';
import { ensureFonts, fontString } from '../text/fonts.ts';

export type ToneKind = 'base' | 'shadow1' | 'shadow2' | 'rim' | 'highlight' | 'glow' | 'pulse' | 'pulseHead';

function derive(kind: ToneKind, hex: string): string {
  switch (kind) {
    case 'base': return hex;
    case 'shadow1': return shadowTone(hex, 1);
    case 'shadow2': return shadowTone(hex, 2);
    case 'rim': return lightTone(hex, 0.36);
    case 'highlight': return lightTone(hex, 0.7);
    case 'glow': return lightTone(hex, 0.22);
    case 'pulse': return lightTone(hex, 0.4);
    case 'pulseHead': return lightTone(hex, 0.72);
  }
}

/** How colours are painted in one layer. */
export interface Paint {
  /** Unit vector toward the light, in screen space. */
  readonly light: Vec2;
  /** A tone derived from a palette colour, as it appears at this layer's depth. */
  tone(kind: ToneKind, hex: string): string;
}

const paints = new Map<string, Paint>();

/**
 * The paint of a layer: the shot's light, and atmospheric perspective of the
 * given strength (0..1) toward the atmosphere colour. Cached; the result for the
 * same arguments is always the same.
 */
export function makePaint(light: Vec2, atmosphere: string, tint: number): Paint {
  const key = `${light[0]},${light[1]}|${atmosphere}|${tint}`;
  let paint = paints.get(key);
  if (!paint) {
    const cache = new Map<string, string>();
    paint = {
      light,
      tone(kind, hex) {
        const k = `${kind}${hex}`;
        let v = cache.get(k);
        if (!v) {
          v = atmosphereTone(derive(kind, hex), atmosphere, tint);
          cache.set(k, v);
        }
        return v;
      },
    };
    paints.set(key, paint);
  }
  return paint;
}

/** A shape with its automatic light. */
export function drawShape(ctx: CanvasRenderingContext2D, item: ShapeItem, paint: Paint): void {
  const node = item.node.node as ShapeNode;
  const { xf } = item;
  const base = item.node.colors['fill']!;
  const path = shapePath(node.shape);
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  ctx.fillStyle = paint.tone('base', base);
  ctx.fill(path);
  if (node.lit) {
    // The light direction in the shape's own space: the crescents stay on the
    // correct side however the shape is turned.
    const parts = litParts(node.shape, vrot(paint.light, -xf.rot));
    ctx.fillStyle = paint.tone('shadow1', base);
    ctx.fill(parts.shadow);
    ctx.fillStyle = paint.tone('shadow2', base);
    ctx.fill(parts.deepShadow);
    const rimLight = item.node.colors['rimLight'];
    if (rimLight) {
      ctx.fillStyle = paint.tone('base', rimLight);
      ctx.fill(parts.rimLight);
    }
    ctx.fillStyle = paint.tone('rim', base);
    ctx.fill(parts.rim);
    ctx.strokeStyle = paint.tone('highlight', base);
    ctx.lineWidth = parts.highlightWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(parts.highlight);
  }
  ctx.restore();
}

/** The part of a glowing shape that feeds the halo; it fades with the shape. */
export function drawShapeGlow(ctx: CanvasRenderingContext2D, item: ShapeItem, paint: Paint): void {
  const node = item.node.node as ShapeNode;
  const { xf } = item;
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  ctx.fillStyle = withAlpha(paint.tone('glow', item.node.colors['fill']!), node.glow * item.alpha);
  ctx.fill(shapePath(node.shape));
  ctx.restore();
}

function strokeQuad(ctx: CanvasRenderingContext2D, q: Quad, from: number, to: number): void {
  const steps = 24;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const p = quadAt(q, from + ((to - from) * i) / steps);
    if (i === 0) ctx.moveTo(p[0], p[1]);
    else ctx.lineTo(p[0], p[1]);
  }
  ctx.stroke();
}

/** Unit normal of a quadratic curve at t (to the left of its direction). */
function quadNormal(q: Quad, t: number): Vec2 {
  const dx = (1 - t) * (q[1][0] - q[0][0]) + t * (q[2][0] - q[1][0]);
  const dy = (1 - t) * (q[1][1] - q[0][1]) + t * (q[2][1] - q[1][1]);
  const l = Math.hypot(dx, dy);
  return l > 1e-9 ? [-dy / l, dx / l] : [0, 1];
}

/**
 * Pulses as travelling light: a tapered body that is widest and brightest at
 * the head and fades to nothing at the tail, plus a bright head.
 */
function drawPulses(
  ctx: CanvasRenderingContext2D,
  item: LinkItem,
  width: number,
  headRadius: number,
  body: string,
  head: string,
  alpha: number,
): void {
  const steps = 14;
  for (const p of item.pulses) {
    const h = Math.min(p.head, item.reveal);
    const t = Math.min(p.tail, h);
    const headPoint = quadAt(item.curve, h);
    if (h - t > 1e-4) {
      // Thickness and brightness follow the distance from the head, so the tail
      // stays a tail while the pulse is still leaving its source or arriving.
      const left: Vec2[] = [];
      const right: Vec2[] = [];
      for (let i = 0; i <= steps; i++) {
        const u = t + ((h - t) * i) / steps;
        const near = 1 - Math.min(1, (h - u) / PULSE_LENGTH);
        const half = (width / 2) * (0.12 + 0.88 * near ** 1.5);
        const c = quadAt(item.curve, u);
        const n = quadNormal(item.curve, u);
        left.push([c[0] + n[0] * half, c[1] + n[1] * half]);
        right.push([c[0] - n[0] * half, c[1] - n[1] * half]);
      }
      const tailPoint = quadAt(item.curve, t);
      const startNear = 1 - Math.min(1, (h - t) / PULSE_LENGTH);
      const g = ctx.createLinearGradient(tailPoint[0], tailPoint[1], headPoint[0], headPoint[1]);
      g.addColorStop(0, withAlpha(body, alpha * startNear ** 1.5));
      g.addColorStop(1, withAlpha(body, alpha));
      ctx.fillStyle = g;
      ctx.beginPath();
      left.forEach((q, i) => (i === 0 ? ctx.moveTo(q[0], q[1]) : ctx.lineTo(q[0], q[1])));
      for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i]![0], right[i]![1]);
      ctx.closePath();
      ctx.fill();
    }
    if (p.head <= item.reveal + 1e-9) {
      ctx.fillStyle = withAlpha(head, alpha);
      ctx.beginPath();
      ctx.arc(headPoint[0], headPoint[1], headRadius, 0, TAU);
      ctx.fill();
    }
  }
}

/** A link and the pulses travelling along it. */
export function drawLink(ctx: CanvasRenderingContext2D, item: LinkItem, paint: Paint): void {
  const node = item.node.node as LinkNode;
  ctx.save();
  ctx.strokeStyle = paint.tone('base', item.node.colors['color']!);
  ctx.lineWidth = node.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  strokeQuad(ctx, item.curve, 0, item.reveal);
  const pulse = item.node.colors['pulseColor']!;
  drawPulses(ctx, item, node.width * 1.5, node.width * 0.95, paint.tone('pulse', pulse), paint.tone('pulseHead', pulse), 1);
  ctx.restore();
}

/**
 * What a link feeds the halo with: the line itself, as far as the link glows,
 * and its pulses, a little fatter. Both fade with the link.
 */
export function drawLinkGlow(ctx: CanvasRenderingContext2D, item: LinkItem, paint: Paint): void {
  const node = item.node.node as LinkNode;
  if (item.pulses.length === 0 && node.glow <= 0) return;
  ctx.save();
  if (node.glow > 0) {
    ctx.strokeStyle = withAlpha(paint.tone('glow', item.node.colors['color']!), node.glow * item.alpha);
    ctx.lineWidth = node.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokeQuad(ctx, item.curve, 0, item.reveal);
  }
  if (item.pulses.length > 0) {
    const pulse = paint.tone('base', item.node.colors['pulseColor']!);
    drawPulses(ctx, item, node.width * 2.1, node.width * 1.5, pulse, pulse, item.alpha);
  }
  ctx.restore();
}

/** Particles, batched into one path per colour, plus one for their inner discs if the emitter has a core. */
export function drawParticles(ctx: CanvasRenderingContext2D, item: ParticlesItem, paint: Paint, alpha = 1): void {
  const colors = item.node.particleColors;
  const paths: (Path2D | null)[] = colors.map(() => null);
  const core = (item.node.node as EmitterNode).core;
  const cores = core ? new Path2D() : null;
  const d = item.data;
  for (let i = 0; i < d.length; i += PARTICLE_STRIDE) {
    const ci = d[i + 3]!;
    let p = paths[ci];
    if (!p) {
      p = new Path2D();
      paths[ci] = p;
    }
    const x = d[i]!;
    const y = d[i + 1]!;
    const r = d[i + 2]!;
    p.moveTo(x + r, y);
    p.arc(x, y, r, 0, TAU);
    if (core && cores) {
      const cr = r * core.size;
      cores.moveTo(x + cr, y);
      cores.arc(x, y, cr, 0, TAU);
    }
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  paths.forEach((p, ci) => {
    if (!p) return;
    ctx.fillStyle = paint.tone('base', colors[ci]!);
    ctx.fill(p);
  });
  if (cores) {
    ctx.fillStyle = paint.tone('base', item.node.colors['core']!);
    ctx.fill(cores);
  }
  ctx.restore();
}

/** An eye: a light disc, a pupil that looks somewhere, a glint toward the light. */
export function drawEye(ctx: CanvasRenderingContext2D, item: EyeItem, paint: Paint): void {
  const node = item.node.node as EyeNode;
  const { xf } = item;
  const r = node.r;
  const pr = r * 0.54;
  const travel = (r - pr) * 0.86;
  const l = vrot(paint.light, -xf.rot);
  const white = paint.tone('base', item.node.colors['white']!);
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale * item.open);
  ctx.fillStyle = white;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();
  const px = item.look[0] * travel;
  const py = item.look[1] * travel;
  ctx.fillStyle = paint.tone('base', item.node.colors['pupil']!);
  ctx.beginPath();
  ctx.arc(px, py, pr, 0, TAU);
  ctx.fill();
  ctx.fillStyle = white;
  ctx.beginPath();
  ctx.arc(px + l[0] * pr * 0.42, py + l[1] * pr * 0.42, pr * 0.3, 0, TAU);
  ctx.fill();
  ctx.restore();
}

const textPathCache = new Map<string, Path2D | null>();

/** A line of text as a path centred on x = 0 with its baseline at y = 0. */
function textPath(ctx: CanvasRenderingContext2D, text: string, size: number, weight: number): Path2D | null {
  const key = `${weight}|${size}|${text}`;
  let p = textPathCache.get(key);
  if (p === undefined) {
    ensureFonts();
    ctx.save();
    ctx.font = fontString(size, weight);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    p = ctx.outlineText(text);
    ctx.restore();
    textPathCache.set(key, p);
  }
  return p;
}

/**
 * A label. The text is filled as outlines, so it scales cleanly while the label
 * pops in and looks the same on the GPU and on the CPU.
 */
export function drawLabel(ctx: CanvasRenderingContext2D, item: LabelItem, paint: Paint): void {
  const g = item.geometry;
  ctx.save();
  ctx.translate(item.tip[0], item.tip[1]);
  ctx.scale(item.scale, item.scale);
  ctx.fillStyle = paint.tone('base', item.node.colors['fill']!);
  ctx.fill(g.path);
  ctx.fillStyle = paint.tone('base', item.node.colors['ink']!);
  for (const line of g.lines) {
    const p = textPath(ctx, line.text, g.size, g.weight);
    if (!p) continue;
    ctx.save();
    ctx.translate(line.x, line.y);
    ctx.fill(p);
    ctx.restore();
  }
  ctx.restore();
}
