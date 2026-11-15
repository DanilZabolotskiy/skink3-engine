// Frame compositing on Skia: background, glow lift, depth layers back to front
// (each with its blur and atmospheric tint), halos, vignette. The result is a
// canvas whose pixels can be read back as raw RGBA.
//
// No texture, no grain: flat fills and gradients only.

import { Canvas, type CanvasRenderingContext2D } from 'skia-canvas';
import { withAlpha } from '../look/color.ts';
import { GLOW } from '../look/light.ts';
import type { Bake } from '../physics/cache.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { evaluate, type FrameState, type Item, type LayerState } from '../scene/evaluate.ts';
import { STAGE_H, STAGE_W, type ShapeNode } from '../scene/types.ts';
import { shapeExtent } from '../shape/geometry.ts';
import { drawEye, drawLabel, drawLink, drawLinkGlow, drawParticles, drawShape, drawShapeGlow } from './draw.ts';

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

/** Samples per pixel used when exporting from the GPU. */
export const GPU_MSAA = 4;

function glowStrength(item: Item): number {
  switch (item.kind) {
    case 'shape':
      return (item.node.node as ShapeNode).glow;
    case 'link':
      return item.pulses.length > 0 ? 1 : 0;
    case 'particles':
      return item.node.node.type === 'emitter' ? item.node.node.glow : 0;
    default:
      return 0;
  }
}

/** Radius (in layer units) that sets how wide the halo of an item is. */
function glowReach(item: Item): number {
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

/** A canvas larger than the frame by `pad` pixels on every side, set up to draw in layer space. */
function layerCanvas(
  scratch: Scratch,
  layer: LayerState,
  width: number,
  height: number,
  k: number,
  pad: number,
  gpu: boolean,
): { canvas: Canvas; ctx: CanvasRenderingContext2D } {
  const canvas = newCanvas(scratch, width + 2 * pad, height + 2 * pad, gpu);
  const ctx = canvas.getContext('2d');
  ctx.translate(pad, pad);
  ctx.scale(k, k);
  ctx.transform(layer.view.zoom, 0, 0, layer.view.zoom, layer.view.tx, layer.view.ty);
  return { canvas, ctx };
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

  // Farthest layer first.
  const layers = state.layers
    .map((layer, i) => ({ layer, i }))
    .sort((a, b) => b.layer.layer.spec.depth - a.layer.layer.spec.depth || a.i - b.i)
    .map((x) => x.layer);

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
  for (const layer of layers) {
    for (const item of layer.items) {
      if (item.kind !== 'shape') continue;
      const node = item.node.node as ShapeNode;
      if (node.glow <= 0) continue;
      const v = layer.view;
      const x = item.xf.x * v.zoom + v.tx;
      const y = item.xf.y * v.zoom + v.ty;
      const r = shapeExtent(node.shape).outer * item.xf.scale * v.zoom * GLOW.liftRadius;
      if (r < 1) continue;
      const color = item.node.colors['fill']!;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const a = GLOW.liftAlpha * node.glow * node.opacity * Math.min(1, item.xf.scale);
      g.addColorStop(0, withAlpha(color, a));
      g.addColorStop(0.35, withAlpha(color, a * 0.45));
      g.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
  }
  ctx.restore();

  // 3. Layers.
  for (const layer of layers) {
    if (layer.items.length === 0) continue;
    const blurPx = layer.layer.blur * k * layer.view.zoom;
    // Draw past the frame edge, so that a blur does not fade toward the border.
    const pad = blurPx > 0.05 ? Math.ceil(blurPx * 3) : 0;
    const { canvas: lc, ctx: lx } = layerCanvas(scratch, layer, width, height, k, pad, opts.gpu);

    let glowReachMax = 0;
    let anyGlow = false;
    for (const item of layer.items) {
      switch (item.kind) {
        case 'shape': drawShape(lx, item, c.light); break;
        case 'eye': drawEye(lx, item, c.light); break;
        case 'link': drawLink(lx, item); break;
        case 'label': drawLabel(lx, item); break;
        case 'particles': drawParticles(lx, item); break;
      }
      if (glowStrength(item) > 0) {
        anyGlow = true;
        glowReachMax = Math.max(glowReachMax, glowReach(item));
      }
    }
    if (layer.layer.tint > 0) {
      // Atmosphere: tint what was drawn, and only that, toward the far colour.
      lx.setTransform(1, 0, 0, 1, 0, 0);
      lx.globalCompositeOperation = 'source-atop';
      lx.fillStyle = withAlpha(c.atmosphere, layer.layer.tint);
      lx.fillRect(0, 0, width + 2 * pad, height + 2 * pad);
    }
    // Halo: the glowing parts again, blurred. The wide pass goes under the layer,
    // so that it surrounds the glowing thing without washing it out; the tight
    // pass goes on top and makes its edge bloom.
    let halo: { canvas: Canvas; pad: number; tight: number; wide: number } | null = null;
    if (anyGlow) {
      const scale = k * layer.view.zoom;
      const tight = Math.min(GLOW.haloTight.max, Math.max(GLOW.haloTight.min, glowReachMax * GLOW.haloTight.k)) * scale + blurPx;
      const wide = Math.min(GLOW.haloWide.max, Math.max(GLOW.haloWide.min, glowReachMax * GLOW.haloWide.k)) * scale + blurPx;
      const gpad = Math.ceil(wide * 3);
      const { canvas: gc, ctx: gx } = layerCanvas(scratch, layer, width, height, k, gpad, opts.gpu);
      for (const item of layer.items) {
        const s = glowStrength(item);
        if (s <= 0) continue;
        if (item.kind === 'shape') drawShapeGlow(gx, item);
        else if (item.kind === 'link') drawLinkGlow(gx, item);
        else if (item.kind === 'particles') drawParticles(gx, item, s);
      }
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
