// Drawing of the display-list items onto a Skia canvas context. The context is
// already in the layer's space; these functions only add the node's transform.

import { Path2D, type CanvasRenderingContext2D } from 'skia-canvas';
import { quadAt, quadSub, TAU, vrot, type Quad, type Vec2 } from '../core/math.ts';
import { lightTone, shadowTone, withAlpha } from '../look/color.ts';
import { litParts } from '../look/light.ts';
import type { EyeItem, LabelItem, LinkItem, ParticlesItem, ShapeItem } from '../scene/evaluate.ts';
import type { EyeNode, LinkNode, ShapeNode } from '../scene/types.ts';
import { shapePath } from '../shape/path.ts';
import { PARTICLE_STRIDE } from '../physics/cache.ts';
import { ensureFonts, fontString } from '../text/fonts.ts';

const toneCache = new Map<string, string>();

function tone(kind: 'shadow1' | 'shadow2' | 'rim' | 'highlight' | 'glow' | 'pulse', hex: string): string {
  const key = `${kind}${hex}`;
  let v = toneCache.get(key);
  if (!v) {
    switch (kind) {
      case 'shadow1': v = shadowTone(hex, 1); break;
      case 'shadow2': v = shadowTone(hex, 2); break;
      case 'rim': v = lightTone(hex, 0.36); break;
      case 'highlight': v = lightTone(hex, 0.7); break;
      case 'glow': v = lightTone(hex, 0.22); break;
      case 'pulse': v = lightTone(hex, 0.55); break;
    }
    toneCache.set(key, v);
  }
  return v;
}

/** A shape with its automatic light. `light` is the shot's light vector in screen space. */
export function drawShape(ctx: CanvasRenderingContext2D, item: ShapeItem, light: Vec2): void {
  const node = item.node.node as ShapeNode;
  const { xf } = item;
  const base = item.node.colors['fill']!;
  const path = shapePath(node.shape);
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  ctx.globalAlpha = node.opacity;
  ctx.fillStyle = base;
  ctx.fill(path);
  if (node.lit) {
    // The light direction in the shape's own space: the crescents stay on the
    // correct side however the shape is turned.
    const parts = litParts(node.shape, vrot(light, -xf.rot));
    ctx.fillStyle = tone('shadow1', base);
    ctx.fill(parts.shadow);
    ctx.fillStyle = tone('shadow2', base);
    ctx.fill(parts.deepShadow);
    const rimLight = item.node.colors['rimLight'];
    if (rimLight) {
      ctx.fillStyle = rimLight;
      ctx.fill(parts.rimLight);
    }
    ctx.fillStyle = tone('rim', base);
    ctx.fill(parts.rim);
    ctx.strokeStyle = tone('highlight', base);
    ctx.lineWidth = parts.highlightWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(parts.highlight);
  }
  ctx.restore();
}

/** The part of a glowing shape that feeds the halo. */
export function drawShapeGlow(ctx: CanvasRenderingContext2D, item: ShapeItem): void {
  const node = item.node.node as ShapeNode;
  const { xf } = item;
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale);
  ctx.fillStyle = withAlpha(tone('glow', item.node.colors['fill']!), node.glow * node.opacity);
  ctx.fill(shapePath(node.shape));
  ctx.restore();
}

function strokeQuad(ctx: CanvasRenderingContext2D, q: Quad): void {
  ctx.beginPath();
  ctx.moveTo(q[0][0], q[0][1]);
  ctx.quadraticCurveTo(q[1][0], q[1][1], q[2][0], q[2][1]);
  ctx.stroke();
}

function drawPulses(ctx: CanvasRenderingContext2D, item: LinkItem, width: number, headRadius: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  for (const p of item.pulses) {
    const head = Math.min(p.head, item.reveal);
    const tail = Math.min(p.tail, head);
    if (head - tail > 1e-4) strokeQuad(ctx, quadSub(item.curve, tail, head));
    if (p.head <= item.reveal + 1e-9) {
      const q = quadAt(item.curve, head);
      ctx.beginPath();
      ctx.arc(q[0], q[1], headRadius, 0, TAU);
      ctx.fill();
    }
  }
}

/** A link and the pulses travelling along it. */
export function drawLink(ctx: CanvasRenderingContext2D, item: LinkItem): void {
  const node = item.node.node as LinkNode;
  ctx.save();
  ctx.strokeStyle = item.node.colors['color']!;
  ctx.lineWidth = node.width;
  ctx.lineCap = 'round';
  strokeQuad(ctx, quadSub(item.curve, 0, item.reveal));
  drawPulses(ctx, item, node.width * 1.2, node.width * 1.05, tone('pulse', item.node.colors['pulseColor']!));
  ctx.restore();
}

/** The pulses again, a little fatter, for the halo. */
export function drawLinkGlow(ctx: CanvasRenderingContext2D, item: LinkItem): void {
  if (item.pulses.length === 0) return;
  const node = item.node.node as LinkNode;
  ctx.save();
  drawPulses(ctx, item, node.width * 1.5, node.width * 1.5, item.node.colors['pulseColor']!);
  ctx.restore();
}

/** Particles, batched into one path per colour. */
export function drawParticles(ctx: CanvasRenderingContext2D, item: ParticlesItem, alpha = 1): void {
  const colors = item.node.particleColors;
  const paths: (Path2D | null)[] = colors.map(() => null);
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
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  paths.forEach((p, ci) => {
    if (!p) return;
    ctx.fillStyle = colors[ci]!;
    ctx.fill(p);
  });
  ctx.restore();
}

/** An eye: a light disc, a pupil that looks somewhere, a glint toward the light. */
export function drawEye(ctx: CanvasRenderingContext2D, item: EyeItem, light: Vec2): void {
  const node = item.node.node as EyeNode;
  const { xf } = item;
  const r = node.r;
  const pr = r * 0.54;
  const travel = (r - pr) * 0.86;
  const l = vrot(light, -xf.rot);
  ctx.save();
  ctx.translate(xf.x, xf.y);
  ctx.rotate(xf.rot);
  ctx.scale(xf.scale, xf.scale * item.open);
  ctx.fillStyle = item.node.colors['white']!;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();
  const px = item.look[0] * travel;
  const py = item.look[1] * travel;
  ctx.fillStyle = item.node.colors['pupil']!;
  ctx.beginPath();
  ctx.arc(px, py, pr, 0, TAU);
  ctx.fill();
  ctx.fillStyle = item.node.colors['white']!;
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
export function drawLabel(ctx: CanvasRenderingContext2D, item: LabelItem): void {
  const g = item.geometry;
  ctx.save();
  ctx.translate(item.tip[0], item.tip[1]);
  ctx.scale(item.scale, item.scale);
  ctx.fillStyle = item.node.colors['fill']!;
  ctx.fill(g.path);
  ctx.fillStyle = item.node.colors['ink']!;
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
