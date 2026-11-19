// Drawing of the display-list items onto a Skia canvas context. The context is
// already in the layer's space; these functions only add the node's transform.
//
// Colours go through a Paint, which applies the layer's atmospheric perspective.
// Opacity is not applied here: a faded node arrives wrapped in a group, and the
// compositor fades the whole group as one picture.

import { Path2D, type CanvasRenderingContext2D } from 'skia-canvas';
import { quadAt, TAU, vrot, type Quad, type Vec2 } from '../core/math.ts';
import { atmosphereTone, HIGHLIGHT_HUE, lightTone, SHADOW_HUE, shadowTone, withAlpha } from '../look/color.ts';
import { litParts } from '../look/light.ts';
import type { ToneHues } from '../look/palette.ts';
import { PULSE_LENGTH } from '../motion/curves.ts';
import { PARTICLE_STRIDE } from '../physics/cache.ts';
import { pathAt, pathTable } from '../motion/paths.ts';
import { itemFill, itemPath, itemShape, itemWidth, type ClipItem, type EyeItem, type LabelItem, type LinkItem, type ParticlesItem, type ShapeItem, type StrokeItem, type TextItem } from '../scene/evaluate.ts';
import type { EmitterNode, EyeNode, LinkNode, ShapeNode, StrokeNode } from '../scene/types.ts';
import { shapeExtent } from '../shape/geometry.ts';
import { shapePath } from '../shape/path.ts';
import { ensureFonts, fontString } from '../text/fonts.ts';

export type ToneKind = 'base' | 'shadow1' | 'shadow2' | 'rim' | 'highlight' | 'glow' | 'pulse' | 'pulseHead';

const DEFAULT_HUES: ToneHues = { shadow: SHADOW_HUE, highlight: HIGHLIGHT_HUE };

function derive(kind: ToneKind, hex: string, hues: ToneHues): string {
  switch (kind) {
    case 'base': return hex;
    case 'shadow1': return shadowTone(hex, 1, hues.shadow);
    case 'shadow2': return shadowTone(hex, 2, hues.shadow);
    case 'rim': return lightTone(hex, 0.36, hues.highlight);
    case 'highlight': return lightTone(hex, 0.7, hues.highlight);
    case 'glow': return lightTone(hex, 0.22, hues.highlight);
    case 'pulse': return lightTone(hex, 0.4, hues.highlight);
    case 'pulseHead': return lightTone(hex, 0.72, hues.highlight);
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
 * The paint of a layer: the shot's light, atmospheric perspective of the
 * given strength (0..1) toward the atmosphere colour, and the hues the tones
 * lean to (those of the shot's palette). Cached; the result for the same
 * arguments is always the same.
 */
export function makePaint(light: Vec2, atmosphere: string, tint: number, hues: ToneHues = DEFAULT_HUES): Paint {
  const key = `${light[0]},${light[1]}|${atmosphere}|${tint}|${hues.shadow}|${hues.highlight}`;
  let paint = paints.get(key);
  if (!paint) {
    const cache = new Map<string, string>();
    paint = {
      light,
      tone(kind, hex) {
        const k = `${kind}${hex}`;
        let v = cache.get(k);
        if (!v) {
          v = atmosphereTone(derive(kind, hex, hues), atmosphere, tint);
          // A fill that changes gives every frame colours of its own: the cache is emptied before it grows without end.
          if (cache.size >= 4096) cache.clear();
          cache.set(k, v);
        }
        return v;
      },
    };
    // While a background changes, every frame has an atmosphere of its own: the cache is emptied before it grows without end.
    if (paints.size >= 512) paints.clear();
    paints.set(key, paint);
  }
  return paint;
}

/** The outline of a shape as a path in the space of its layer: the shape it has at the frame of the item. */
export function placedPath(item: ShapeItem | ClipItem): Path2D {
  const { xf } = item;
  const cos = Math.cos(xf.rot) * xf.scale;
  const sin = Math.sin(xf.rot) * xf.scale;
  return shapePath(itemShape(item)).transform(cos, sin, -sin, cos, xf.x, xf.y);
}

function polygonPath(points: readonly Vec2[], upTo = points.length): Path2D {
  const p = new Path2D();
  for (let i = 0; i < upTo; i++) {
    if (i === 0) p.moveTo(points[i]![0], points[i]![1]);
    else p.lineTo(points[i]![0], points[i]![1]);
  }
  return p;
}

/** Narrows what is drawn next to the outline of a shape; for a content with a level, to its filled part. */
export function clipToShape(ctx: CanvasRenderingContext2D, item: ClipItem): void {
  ctx.clip(placedPath(item));
  if (item.level) {
    const below = polygonPath(item.level);
    below.closePath();
    ctx.clip(below);
  }
}

/** A shape with its automatic light. A content with a level is drawn below its surface only. */
export function drawShape(ctx: CanvasRenderingContext2D, item: ShapeItem, paint: Paint): void {
  if (!item.level) {
    fillShape(ctx, item, paint);
    return;
  }
  const node = item.node.node as ShapeNode;
  const below = polygonPath(item.level);
  below.closePath();
  ctx.save();
  ctx.clip(below);
  fillShape(ctx, item, paint);
  if (node.lit) {
    // The surface catches the light: a pale line along it, inside the shape.
    ctx.clip(placedPath(item));
    const width = Math.max(2, Math.min(5, shapeExtent(itemShape(item)).inner * 0.06)) * item.xf.scale;
    ctx.strokeStyle = paint.tone('rim', itemFill(item));
    // Half of the stroke lies above the surface, where nothing is drawn.
    ctx.lineWidth = 2 * width;
    ctx.lineJoin = 'round';
    ctx.stroke(polygonPath(item.level, item.level.length - 2));
  }
  ctx.restore();
}

function fillShape(ctx: CanvasRenderingContext2D, item: ShapeItem, paint: Paint): void {
  const node = item.node.node as ShapeNode;
  const { xf } = item;
  const base = itemFill(item);
  const shape = itemShape(item);
  const path = shapePath(shape);
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  ctx.fillStyle = paint.tone('base', base);
  ctx.fill(path);
  if (node.lit) {
    // The light direction in the shape's own space: the crescents stay on the
    // correct side however the shape is turned.
    const parts = litParts(shape, vrot(paint.light, -xf.rot));
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
    // highlight: false keeps the crescents alone: on a long outline with deep bays the stroke would cut across it.
    if (node.highlight !== false) {
      ctx.strokeStyle = paint.tone('highlight', base);
      ctx.lineWidth = parts.highlightWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(parts.highlight);
    }
  }
  ctx.restore();
}

/** The part of a glowing shape that feeds the halo; it fades with the shape. */
export function drawShapeGlow(ctx: CanvasRenderingContext2D, item: ShapeItem, paint: Paint): void {
  const node = item.node.node as ShapeNode;
  const { xf } = item;
  ctx.save();
  if (item.level) {
    const below = polygonPath(item.level);
    below.closePath();
    ctx.clip(below);
  }
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  ctx.fillStyle = withAlpha(paint.tone('glow', itemFill(item)), node.glow * item.alpha);
  ctx.fill(shapePath(itemShape(item)));
  ctx.restore();
}

/**
 * Takes out of the halo what lies behind a cover: the shape of the cover is
 * erased from the glow drawn so far, as far as the cover is opaque.
 */
export function eraseGlow(ctx: CanvasRenderingContext2D, item: ShapeItem): void {
  const { xf } = item;
  ctx.save();
  if (item.level) {
    const below = polygonPath(item.level);
    below.closePath();
    ctx.clip(below);
  }
  ctx.globalCompositeOperation = 'destination-out';
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  ctx.fillStyle = `rgba(0,0,0,${Math.min(1, Math.max(0, item.alpha)).toFixed(4)})`;
  ctx.fill(shapePath(itemShape(item)));
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
  // The width the link has at this frame: the lights along it are as large as the line is now.
  const width = itemWidth(item);
  ctx.save();
  ctx.strokeStyle = paint.tone('base', item.node.colors['color']!);
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  strokeQuad(ctx, item.curve, 0, item.reveal);
  const pulse = item.node.colors['pulseColor']!;
  drawPulses(ctx, item, width * 1.5, width * 0.95, paint.tone('pulse', pulse), paint.tone('pulseHead', pulse), 1);
  ctx.restore();
}

/**
 * What a link feeds the halo with: the line itself, as far as the link glows,
 * and its pulses, a little fatter. Both fade with the link.
 */
export function drawLinkGlow(ctx: CanvasRenderingContext2D, item: LinkItem, paint: Paint): void {
  const node = item.node.node as LinkNode;
  if (item.pulses.length === 0 && node.glow <= 0) return;
  const width = itemWidth(item);
  ctx.save();
  if (node.glow > 0) {
    ctx.strokeStyle = withAlpha(paint.tone('glow', item.node.colors['color']!), node.glow * item.alpha);
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokeQuad(ctx, item.curve, 0, item.reveal);
  }
  if (item.pulses.length > 0) {
    const pulse = paint.tone('base', item.node.colors['pulseColor']!);
    drawPulses(ctx, item, width * 2.1, width * 1.5, pulse, pulse, item.alpha);
  }
  ctx.restore();
}

/**
 * Strokes the drawn part of a stroke in the current colour. The dashes are
 * anchored at the first point of the line, so they stay where they are while
 * the line is drawn on; closing the gaps lengthens every dash in place. They
 * are laid out by the width the stroke was given: a width that is keyed makes
 * every dash thicker where it is, and moves none.
 */
function strokeLine(ctx: CanvasRenderingContext2D, item: StrokeItem): void {
  const node = item.node.node as StrokeNode;
  const table = pathTable(itemPath(item));
  const { xf } = item;
  const upTo = table.length * item.drawn;
  const whole = item.drawn >= 1 - 1e-9;
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  ctx.lineWidth = itemWidth(item);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (node.dash && item.solid < 1 - 1e-6) {
    // A dash has round ends, so a gap between two of them is one width longer than it looks.
    const gap = node.dash[1] + node.width;
    ctx.setLineDash([node.dash[0] + gap * item.solid, gap * (1 - item.solid)]);
  }
  ctx.beginPath();
  ctx.moveTo(table.xs[0]!, table.ys[0]!);
  const m = table.cum.length;
  for (let i = 1; i < m; i++) {
    if (table.cum[i]! <= upTo) {
      ctx.lineTo(table.xs[i]!, table.ys[i]!);
      continue;
    }
    // The line ends between two samples.
    const span = table.cum[i]! - table.cum[i - 1]!;
    const u = span > 1e-12 ? (upTo - table.cum[i - 1]!) / span : 0;
    if (u > 1e-9) ctx.lineTo(table.xs[i - 1]! + (table.xs[i]! - table.xs[i - 1]!) * u, table.ys[i - 1]! + (table.ys[i]! - table.ys[i - 1]!) * u);
    break;
  }
  if (whole && node.path.closed) ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/**
 * The lights that run along a stroke, as the pulses of a link: a tapered body
 * that is widest and brightest at the head and fades to nothing at the tail,
 * plus a bright head. They show on the part of the line that is drawn.
 */
function drawStrokePulses(ctx: CanvasRenderingContext2D, item: StrokeItem, width: number, headRadius: number, body: string, head: string, alpha: number): void {
  const table = pathTable(itemPath(item));
  const { xf } = item;
  const whole = item.drawn >= 1 - 1e-9;
  const drawnTo = table.length * item.drawn;
  const within = (s: number): number => (whole ? s : Math.max(0, Math.min(drawnTo, s)));
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  for (const p of item.pulses ?? []) {
    const h = within(p.head);
    const t = within(p.tail);
    const span = Math.abs(h - t);
    const headPoint = pathAt(table, h);
    if (span > 1e-4 * p.length) {
      // The middle line of the light, tail first; then its two sides, each as far out as the light is thick there.
      const steps = Math.max(14, Math.min(64, Math.ceil(span / 5)));
      const mid: Vec2[] = [];
      for (let i = 0; i <= steps; i++) {
        const q = pathAt(table, t + ((h - t) * i) / steps);
        mid.push([q.x, q.y]);
      }
      const left: Vec2[] = [];
      const right: Vec2[] = [];
      for (let i = 0; i <= steps; i++) {
        // The direction of the line there, taken across its neighbours, so that a corner is rounded off and not notched.
        const a = mid[Math.max(0, i - 1)]!;
        const b = mid[Math.min(steps, i + 1)]!;
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const nx = l > 1e-9 ? -(b[1] - a[1]) / l : 0;
        const ny = l > 1e-9 ? (b[0] - a[0]) / l : 1;
        // Thickness and brightness follow the distance from the head, as on a link.
        const near = 1 - Math.min(1, (span * (steps - i)) / steps / p.length);
        const half = (width / 2) * (0.12 + 0.88 * near ** 1.5);
        left.push([mid[i]![0] + nx * half, mid[i]![1] + ny * half]);
        right.push([mid[i]![0] - nx * half, mid[i]![1] - ny * half]);
      }
      const tailPoint = mid[0]!;
      const startNear = 1 - Math.min(1, span / p.length);
      if (Math.hypot(headPoint.x - tailPoint[0], headPoint.y - tailPoint[1]) > 1e-3) {
        const g = ctx.createLinearGradient(tailPoint[0], tailPoint[1], headPoint.x, headPoint.y);
        g.addColorStop(0, withAlpha(body, alpha * startNear ** 1.5));
        g.addColorStop(1, withAlpha(body, alpha));
        ctx.fillStyle = g;
      } else ctx.fillStyle = withAlpha(body, alpha);
      ctx.beginPath();
      left.forEach((q, i) => (i === 0 ? ctx.moveTo(q[0], q[1]) : ctx.lineTo(q[0], q[1])));
      for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i]![0], right[i]![1]);
      ctx.closePath();
      ctx.fill();
    }
    // The head itself, while it is on the part of the line that is drawn.
    if (whole || (p.head >= -1e-9 && p.head <= drawnTo + 1e-9)) {
      ctx.fillStyle = withAlpha(head, alpha);
      ctx.beginPath();
      ctx.arc(headPoint.x, headPoint.y, headRadius, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** A stroke: a line along a path, solid or dashed, as far as it is drawn, and the lights that run along it. */
export function drawStroke(ctx: CanvasRenderingContext2D, item: StrokeItem, paint: Paint): void {
  ctx.strokeStyle = paint.tone('base', item.node.colors['color']!);
  strokeLine(ctx, item);
  if (item.pulses) {
    const width = itemWidth(item);
    const pulse = item.node.colors['pulseColor'] ?? item.node.colors['color']!;
    drawStrokePulses(ctx, item, width * 1.5, width * 0.95, paint.tone('pulse', pulse), paint.tone('pulseHead', pulse), 1);
  }
}

/**
 * What a stroke feeds the halo with: the line itself, as far as the stroke
 * glows, and the lights that run along it, a little fatter. Both fade with the stroke.
 */
export function drawStrokeGlow(ctx: CanvasRenderingContext2D, item: StrokeItem, paint: Paint): void {
  const node = item.node.node as StrokeNode;
  if (node.glow > 0) {
    ctx.strokeStyle = withAlpha(paint.tone('glow', item.node.colors['color']!), node.glow * item.alpha);
    strokeLine(ctx, item);
  }
  if (item.pulses) {
    const pulse = paint.tone('base', item.node.colors['pulseColor'] ?? item.node.colors['color']!);
    const width = itemWidth(item);
    drawStrokePulses(ctx, item, width * 2.1, width * 1.5, pulse, pulse, item.alpha);
  }
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

/** Free-standing text: its box, if it has one, and its lines, placed, turned and scaled as its node is. */
export function drawText(ctx: CanvasRenderingContext2D, item: TextItem, paint: Paint): void {
  const b = item.block;
  const { xf } = item;
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  if (b.path) {
    ctx.fillStyle = paint.tone('base', item.node.colors['box']!);
    ctx.fill(b.path);
  }
  ctx.fillStyle = paint.tone('base', item.node.colors['ink']!);
  for (const line of item.lines) {
    const p = textPath(ctx, line.text, b.size, b.weight);
    if (!p) continue;
    ctx.save();
    ctx.translate(line.x, line.y);
    ctx.fill(p);
    ctx.restore();
  }
  ctx.restore();
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
