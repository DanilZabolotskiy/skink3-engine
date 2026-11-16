// Frame compositing on Skia: background, glow lift, depth layers back to front
// (each with its blur and its atmospheric perspective), halos, vignette. The
// result is a canvas whose pixels can be read back as raw RGBA.
//
// No texture, no grain: flat fills and gradients only.

import { Canvas, type CanvasRenderingContext2D } from 'skia-canvas';
import { xfApply, type Vec2 } from '../core/math.ts';
import { withAlpha } from '../look/color.ts';
import { GLOW } from '../look/light.ts';
import type { Bake } from '../physics/cache.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { evaluate, flatItems, type FrameState, type Item, type LayerState, type LeafItem, type ShapeItem, type StretchItem } from '../scene/evaluate.ts';
import { STAGE_H, STAGE_W, type LinkNode, type ShapeNode, type StrokeNode } from '../scene/types.ts';
import { outlineOf, shapeExtent } from '../shape/geometry.ts';
import {
  drawEye,
  drawLabel,
  drawLink,
  drawLinkGlow,
  drawParticles,
  drawShape,
  drawShapeGlow,
  drawStroke,
  drawStrokeGlow,
  eraseGlow,
  makePaint,
  clipToShape,
  type Paint,
} from './draw.ts';

export interface RenderOptions {
  /** Output width in pixels; the height follows from 16:9. */
  readonly width: number;
  /** Language of the string tables to render. */
  readonly lang: string;
  /** Draw on the GPU (falls back to the CPU when no GPU is available). */
  readonly gpu: boolean;
}

/** Height in pixels for a width, always even. */
export function heightFor(width: number): number {
  return Math.round((width * STAGE_H) / STAGE_W / 2) * 2;
}

/**
 * A blur and a halo are never wider than this, in px of a 1080p frame. It is far above what a view near the authored
 * zoom reaches; it keeps a camera that has zoomed in by orders of magnitude from asking for a blur wider than the frame.
 */
export const MAX_SOFT_PX = 400;

/** Samples per pixel used when exporting from the GPU. */
export const GPU_MSAA = 4;

/** How strongly an item feeds the halo: its glow times its opacity down the tree. */
function glowStrength(item: LeafItem): number {
  switch (item.kind) {
    case 'shape':
      return (item.node.node as ShapeNode).glow * item.alpha;
    case 'link':
      // A pulse always glows; the line glows as much as the link says.
      return Math.max((item.node.node as LinkNode).glow, item.pulses.length > 0 ? 1 : 0) * item.alpha;
    case 'particles':
      return item.node.node.type === 'emitter' ? item.node.node.glow : 0;
    case 'stroke':
      return (item.node.node as StrokeNode).glow * item.alpha;
    default:
      return 0;
  }
}

/** Radius (in layer units) that sets how wide the halo of an item is. */
function glowReach(item: LeafItem): number {
  if (item.kind === 'shape') return shapeExtent((item.node.node as ShapeNode).shape).outer * item.xf.scale;
  return 12;
}

interface Scratch {
  readonly canvases: Canvas[];
}

function newCanvas(scratch: Scratch, w: number, h: number, gpu: boolean): Canvas {
  const c = new Canvas(w, h, { gpu });
  scratch.canvases.push(c);
  return c;
}

/** What is needed to open another canvas that lines up with a layer's canvas. */
interface LayerTarget {
  readonly scratch: Scratch;
  readonly layer: LayerState;
  readonly width: number;
  readonly height: number;
  readonly k: number;
  readonly pad: number;
  readonly gpu: boolean;
}

/** A canvas larger than the frame by `pad` pixels on every side, set up to draw in layer space. */
function layerCanvas(t: LayerTarget): { canvas: Canvas; ctx: CanvasRenderingContext2D } {
  const canvas = newCanvas(t.scratch, t.width + 2 * t.pad, t.height + 2 * t.pad, t.gpu);
  const ctx = canvas.getContext('2d');
  ctx.translate(t.pad, t.pad);
  ctx.scale(t.k, t.k);
  ctx.transform(t.layer.view.zoom, 0, 0, t.layer.view.zoom, t.layer.view.tx, t.layer.view.ty);
  return { canvas, ctx };
}

/**
 * Draws items in order. A group is drawn into a canvas of its own and that
 * picture is composited at the group's opacity, so a faded node fades as a
 * whole: its light, its children and anything overlapping inside it.
 */
function drawItems(
  ctx: CanvasRenderingContext2D,
  items: readonly Item[],
  paint: Paint,
  target: LayerTarget,
  stretches: readonly StretchItem[] = NO_STRETCH,
): void {
  for (const item of items) {
    switch (item.kind) {
      case 'shape': drawShape(ctx, item, paint); break;
      case 'eye': drawEye(ctx, item, paint); break;
      case 'link': drawLink(ctx, item, paint); break;
      case 'label': drawLabel(ctx, item, paint); break;
      case 'particles': drawParticles(ctx, item, paint); break;
      case 'stroke': drawStroke(ctx, item, paint); break;
      case 'group': {
        const { canvas, ctx: gx } = layerCanvas(target);
        // A canvas of its own starts without the stretches it is nested in.
        for (const s of stretches) applyStretch(gx, s);
        drawItems(gx, item.items, paint, target, stretches);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = item.opacity;
        ctx.drawCanvas(canvas, 0, 0);
        ctx.restore();
        break;
      }
      case 'clip':
        ctx.save();
        clipToShape(ctx, item);
        drawItems(ctx, item.items, paint, target, stretches);
        ctx.restore();
        break;
      case 'stretch':
        ctx.save();
        applyStretch(ctx, item);
        drawItems(ctx, item.items, paint, target, [...stretches, item]);
        ctx.restore();
        break;
    }
  }
}

const NO_STRETCH: readonly StretchItem[] = [];

/** Squashes or stretches what is drawn next: `height` times as high, 1 / `height` times as wide, about a point. */
function applyStretch(ctx: CanvasRenderingContext2D, s: StretchItem): void {
  ctx.translate(s.at[0], s.at[1]);
  ctx.scale(1 / s.height, s.height);
  ctx.translate(-s.at[0], -s.at[1]);
}

/**
 * Draws what feeds the halo of a layer, in draw order. A cover erases the glow
 * drawn before it where it lies over it, so nothing shines through it; what is
 * clipped to a shape glows only inside that shape.
 */
function drawGlow(
  ctx: CanvasRenderingContext2D,
  items: readonly Item[],
  paint: Paint,
  covers: boolean,
  seen: ReadonlyMap<LeafItem, number> | null,
  state: { drawn: boolean } = { drawn: false },
): void {
  for (const item of items) {
    switch (item.kind) {
      case 'group':
        drawGlow(ctx, item.items, paint, covers, seen, state);
        break;
      case 'clip':
        ctx.save();
        clipToShape(ctx, item);
        drawGlow(ctx, item.items, paint, covers, seen, state);
        ctx.restore();
        break;
      case 'stretch':
        ctx.save();
        applyStretch(ctx, item);
        drawGlow(ctx, item.items, paint, covers, seen, state);
        ctx.restore();
        break;
      default: {
        // A cover has something to hide only once some glow has been drawn.
        if (covers && state.drawn && item.kind === 'shape' && (item.node.node as ShapeNode).cover === true) eraseGlow(ctx, item);
        const s = glowStrength(item);
        if (s <= 0 || (seen !== null && seen.get(item) === 0)) break;
        state.drawn = true;
        if (item.kind === 'shape') drawShapeGlow(ctx, item, paint);
        else if (item.kind === 'link') drawLinkGlow(ctx, item, paint);
        else if (item.kind === 'particles') drawParticles(ctx, item, paint, s);
        else if (item.kind === 'stroke') drawStrokeGlow(ctx, item, paint);
      }
    }
  }
}

function insidePolygon(poly: readonly Vec2[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

function outlineInLayer(item: { readonly node: { readonly node: unknown }; readonly xf: ShapeItem['xf'] }): Vec2[] {
  return outlineOf((item.node.node as ShapeNode).shape).map((p) => xfApply(item.xf, p));
}

/**
 * How much of each glowing shape of a layer can be seen, 0..1: the share of
 * nine points of it (its middle and eight around it) that lie inside the shape
 * it is clipped to and under no cover drawn after it. The background lift of a
 * glowing shape is scaled by it, so a light behind a cover does not warm the
 * sky around the cover.
 */
function seenShares(items: readonly Item[]): Map<LeafItem, number> {
  const glowing: { item: ShapeItem; order: number; clips: readonly Vec2[][] }[] = [];
  const covers: { order: number; alpha: number; poly: Vec2[] }[] = [];
  let order = 0;
  const walk = (list: readonly Item[], clips: readonly Vec2[][]): void => {
    for (const item of list) {
      if (item.kind === 'group' || item.kind === 'stretch') walk(item.items, clips);
      else if (item.kind === 'clip') walk(item.items, item.level ? [...clips, outlineInLayer(item), item.level as Vec2[]] : [...clips, outlineInLayer(item)]);
      else {
        order++;
        if (item.kind !== 'shape') continue;
        const node = item.node.node as ShapeNode;
        if (node.glow > 0) glowing.push({ item, order, clips });
        if (node.cover === true && item.alpha > 0.02) covers.push({ order, alpha: Math.min(1, item.alpha), poly: outlineInLayer(item) });
      }
    }
  };
  walk(items, []);
  const out = new Map<LeafItem, number>();
  for (const g of glowing) {
    const node = g.item.node.node as ShapeNode;
    const { center } = shapeExtent(node.shape);
    const ring = outlineOf(node.shape);
    const points: Vec2[] = [xfApply(g.item.xf, center)];
    for (let i = 0; i < 8; i++) {
      const p = ring[Math.floor((i * ring.length) / 8)]!;
      points.push(xfApply(g.item.xf, [center[0] + (p[0] - center[0]) * 0.6, center[1] + (p[1] - center[1]) * 0.6]));
    }
    let seen = 0;
    for (const p of points) {
      if (g.clips.some((poly) => !insidePolygon(poly, p[0], p[1]))) continue;
      // Of a content with a level only the part below its surface is there.
      if (g.item.level && !insidePolygon(g.item.level, p[0], p[1])) continue;
      let hidden = 0;
      for (const cover of covers) {
        if (cover.order > g.order && cover.alpha > hidden && insidePolygon(cover.poly, p[0], p[1])) hidden = cover.alpha;
      }
      seen += 1 - hidden;
    }
    out.set(g.item, seen / points.length);
  }
  return out;
}

export interface DrawnFrame {
  readonly canvas: Canvas;
  /** Frees the native memory of the frame and of its scratch canvases. */
  dispose(): void;
}

/** Draws a display list. */
export function drawState(c: CompiledShot, state: FrameState, opts: RenderOptions): DrawnFrame {
  const width = opts.width;
  const height = heightFor(width);
  const k = width / STAGE_W;
  const scratch: Scratch = { canvases: [] };
  const out = newCanvas(scratch, width, height, opts.gpu);
  const ctx = out.getContext('2d');
  const spec = c.spec;

  // In a shot with covers or clips, a glowing shape lights its surroundings only as far as it can be seen.
  const hides = c.covers.length > 0 || c.clips;
  // Farthest layer first.
  const layers = state.layers
    .map((layer, i) => ({ layer, i }))
    .sort((a, b) => b.layer.layer.spec.depth - a.layer.layer.spec.depth || a.i - b.i)
    .map((x) => ({
      layer: x.layer,
      leaves: flatItems(x.layer.items),
      paint: makePaint(c.light, c.atmosphere, x.layer.layer.tint),
      seen: hides ? seenShares(x.layer.items) : null,
    }));

  // 1. Background gradient.
  ctx.save();
  ctx.scale(k, k);
  const bx = spec.background.center[0] * STAGE_W;
  const by = spec.background.center[1] * STAGE_H;
  const bg = ctx.createRadialGradient(bx, by, 0, bx, by, spec.background.radius * STAGE_W);
  bg.addColorStop(0, c.background.inner);
  bg.addColorStop(1, c.background.outer);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);

  // 2. Background lift: every glowing shape brightens what is behind it.
  ctx.globalCompositeOperation = 'screen';
  for (const { layer, leaves, paint, seen } of layers) {
    for (const item of leaves) {
      if (item.kind !== 'shape') continue;
      const node = item.node.node as ShapeNode;
      const strength = node.glow * item.alpha * Math.min(1, item.xf.scale);
      if (strength <= 0) continue;
      const share = seen ? seen.get(item) ?? 1 : 1;
      if (share <= 0) continue;
      const v = layer.view;
      const x = item.xf.x * v.zoom + v.tx;
      const y = item.xf.y * v.zoom + v.ty;
      const r = shapeExtent(node.shape).outer * item.xf.scale * v.zoom * GLOW.liftRadius;
      if (r < 1) continue;
      const color = paint.tone('base', item.node.colors['fill']!);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const a = seen ? GLOW.liftAlpha * strength * share : GLOW.liftAlpha * strength;
      g.addColorStop(0, withAlpha(color, a));
      g.addColorStop(0.35, withAlpha(color, a * 0.45));
      g.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
  }
  ctx.restore();

  // 3. Layers.
  for (const { layer, leaves, paint, seen } of layers) {
    if (leaves.length === 0) continue;
    const blurPx = Math.min(MAX_SOFT_PX * k, layer.layer.blur * k * layer.view.zoom);
    // Draw past the frame edge, so that a blur does not fade toward the border.
    const pad = blurPx > 0.05 ? Math.ceil(blurPx * 3) : 0;
    const target: LayerTarget = { scratch, layer, width, height, k, pad, gpu: opts.gpu };
    const { canvas: lc, ctx: lx } = layerCanvas(target);
    drawItems(lx, layer.items, paint, target);

    let glowReachMax = 0;
    let anyGlow = false;
    for (const item of leaves) {
      // What cannot be seen at all (wholly behind a cover, or outside its clip) has no halo.
      if (glowStrength(item) > 0 && !(seen !== null && seen.get(item) === 0)) {
        anyGlow = true;
        glowReachMax = Math.max(glowReachMax, glowReach(item));
      }
    }

    // Halo: the glowing parts again, blurred. The wide pass goes under the layer,
    // so that it surrounds the glowing thing without washing it out; the tight
    // pass goes on top and makes its edge bloom.
    let halo: { canvas: Canvas; pad: number; tight: number; wide: number } | null = null;
    if (anyGlow) {
      const scale = k * layer.view.zoom;
      const tight = Math.min(MAX_SOFT_PX * k, Math.min(GLOW.haloTight.max, Math.max(GLOW.haloTight.min, glowReachMax * GLOW.haloTight.k)) * scale + blurPx);
      const wide = Math.min(MAX_SOFT_PX * k, Math.min(GLOW.haloWide.max, Math.max(GLOW.haloWide.min, glowReachMax * GLOW.haloWide.k)) * scale + blurPx);
      const gpad = Math.ceil(wide * 3);
      const { canvas: gc, ctx: gx } = layerCanvas({ ...target, pad: gpad });
      drawGlow(gx, layer.items, paint, c.covers.length > 0, seen);
      halo = { canvas: gc, pad: gpad, tight, wide };
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.filter = `blur(${wide.toFixed(3)}px)`;
      ctx.globalAlpha = GLOW.haloWideAlpha;
      ctx.drawCanvas(gc, -gpad, -gpad);
      ctx.restore();
    }

    ctx.save();
    ctx.filter = blurPx > 0.05 ? `blur(${blurPx.toFixed(3)}px)` : 'none';
    ctx.drawCanvas(lc, -pad, -pad);
    ctx.restore();

    if (halo) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.filter = `blur(${halo.tight.toFixed(3)}px)`;
      ctx.globalAlpha = GLOW.haloTightAlpha;
      ctx.drawCanvas(halo.canvas, -halo.pad, -halo.pad);
      ctx.restore();
    }
  }

  // 4. Vignette toward the background's outer colour (never toward gray or black).
  if (spec.vignette > 0) {
    ctx.save();
    const cx = width / 2;
    const cy = height / 2;
    const half = Math.hypot(cx, cy);
    const g = ctx.createRadialGradient(cx, cy, half * 0.45, cx, cy, half);
    g.addColorStop(0, withAlpha(c.background.outer, 0));
    g.addColorStop(1, withAlpha(c.background.outer, spec.vignette));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  return {
    canvas: out,
    dispose: () => {
      for (const cv of scratch.canvases) cv.dispose();
    },
  };
}

/** Evaluates and draws one frame. */
export function drawFrame(c: CompiledShot, bake: Bake, frame: number, opts: RenderOptions): DrawnFrame {
  return drawState(c, evaluate(c, bake, frame, opts.lang), opts);
}

/** One frame as raw RGBA bytes (width * height * 4). */
export async function frameRaw(c: CompiledShot, bake: Bake, frame: number, opts: RenderOptions): Promise<Buffer> {
  const drawn = drawFrame(c, bake, frame, opts);
  try {
    return await drawn.canvas.toBuffer('raw', { colorType: 'rgba', msaa: opts.gpu ? GPU_MSAA : false });
  } finally {
    drawn.dispose();
  }
}

/** One frame as PNG bytes. */
export async function framePng(c: CompiledShot, bake: Bake, frame: number, opts: RenderOptions): Promise<Buffer> {
  const drawn = drawFrame(c, bake, frame, opts);
  try {
    return await drawn.canvas.toBuffer('png', { msaa: opts.gpu ? GPU_MSAA : false });
  } finally {
    drawn.dispose();
  }
}

/** Which renderer skia-canvas actually uses for the given preference. */
export function rendererInfo(gpu: boolean): { renderer: string; api: string | null; device: string } {
  const probe = new Canvas(8, 8, { gpu });
  const e = probe.engine;
  probe.dispose();
  return { renderer: e.renderer, api: e.api, device: e.device };
}
