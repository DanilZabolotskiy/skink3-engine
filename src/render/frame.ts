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
import { evaluate, flatItems, itemFill, itemShape, type ClipItem, type FrameState, type HazeItem, type Item, type LayerState, type LeafItem, type PlaneItem, type ShapeItem, type StretchItem } from '../scene/evaluate.ts';
import { STAGE_H, STAGE_W, type GroupNode, type LinkNode, type ShapeNode, type StrokeNode } from '../scene/types.ts';
import { outlineOf, shapeExtent } from '../shape/geometry.ts';
import {
  drawCast,
  drawEye,
  drawLabel,
  drawLink,
  drawLinkGlow,
  drawParticles,
  drawShape,
  drawShapeGlow,
  drawStroke,
  drawStrokeGlow,
  drawText,
  eraseGlow,
  makePaint,
  clipToShape,
  fillClipShape,
  type Paint,
} from './draw.ts';
import { applyHaze } from './haze.ts';
import { applyPlane, fogPlane, planeCanvas as planeCanvasOf, planeContext, seesPlane } from './plane.ts';
import { waitForGpu } from './queue.ts';

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
      // As on a link: a light that runs along it always glows.
      return (item.pulses ? Math.max((item.node.node as StrokeNode).glow, 1) : (item.node.node as StrokeNode).glow) * item.alpha;
    default:
      return 0;
  }
}

/** Radius (in layer units) that sets how wide the halo of an item is. */
function glowReach(item: LeafItem): number {
  if (item.kind === 'shape') return shapeExtent(itemShape(item)).outer * item.xf.scale;
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
/**
 * Whether things are clipped to a shape by a mask of its outline (clipMask), not by Skia's clip. Skia cuts every clip
 * out of the canvas by an operation on paths, and on a long outline that is not straight (a coast of several hundred
 * points) the operation may fail, and Skia drops the clip without a word: everything is drawn unclipped. A mask holds
 * for any outline a region may have. Opt-in: a clip to a shape without it is made as it always was.
 */
export function maskedClip(item: ClipItem): boolean {
  const node = item.node.node;
  return node.type === 'shape' && node.clipMask === true;
}

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
  stretches: readonly (StretchItem | PlaneItem)[] = NO_STRETCH,
): void {
  for (const item of items) {
    switch (item.kind) {
      case 'shape': drawShape(ctx, item, paint); break;
      case 'eye': drawEye(ctx, item, paint); break;
      case 'link': drawLink(ctx, item, paint); break;
      case 'label': drawLabel(ctx, item, paint); break;
      case 'particles': drawParticles(ctx, item, paint); break;
      case 'stroke': drawStroke(ctx, item, paint); break;
      case 'text': drawText(ctx, item, paint); break;
      case 'cast': drawCast(ctx, item, paint); break;
      case 'group': {
        // A soft group is blurred as one picture; its canvas has room around the frame for what the blur brings in.
        const softPx = item.soft === undefined ? 0 : Math.min(MAX_SOFT_PX * target.k, item.soft * target.k * target.layer.view.zoom);
        const inner = softPx > 0.05 ? { ...target, pad: Math.max(target.pad, Math.ceil(softPx * 3)) } : target;
        const { canvas, ctx: gx } = layerCanvas(inner);
        // A canvas of its own starts without the stretches and the planes it is nested in.
        for (const s of stretches) {
          if (s.kind === 'plane') applyPlane(gx, s);
          else applyStretch(gx, s);
        }
        drawItems(stretches.some((s) => s.kind === 'plane') ? planeContext(gx) : gx, item.items, paint, inner, stretches);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = item.opacity;
        if (softPx > 0.05) ctx.filter = `blur(${softPx.toFixed(3)}px)`;
        ctx.drawCanvas(canvas, target.pad - inner.pad, target.pad - inner.pad);
        ctx.restore();
        break;
      }
      case 'clip': {
        const softPx = item.soft === undefined ? 0 : Math.min(MAX_SOFT_PX * target.k, item.soft * target.k * target.layer.view.zoom);
        if (softPx > 0.05 || maskedClip(item)) {
          // A clip with a soft edge: the items are drawn whole into a picture of their own, and that picture is kept
          // as far as the blurred outline of the shape is there. A clip by a mask (clipMask) is drawn the same way with a
          // sharp edge (see maskedClip).
          const inner = { ...target, pad: Math.max(target.pad, Math.ceil(softPx * 3)) };
          const own = (): { canvas: Canvas; ctx: CanvasRenderingContext2D } => {
            const made = layerCanvas(inner);
            for (const s of stretches) {
              if (s.kind === 'plane') applyPlane(made.ctx, s);
              else applyStretch(made.ctx, s);
            }
            return made;
          };
          const { canvas, ctx: gx } = own();
          drawItems(stretches.some((s) => s.kind === 'plane') ? planeContext(gx) : gx, item.items, paint, inner, stretches);
          const { canvas: mask, ctx: mx } = own();
          fillClipShape(mx, item);
          gx.save();
          gx.setTransform(1, 0, 0, 1, 0, 0);
          gx.globalCompositeOperation = 'destination-in';
          if (softPx > 0.05) gx.filter = `blur(${softPx.toFixed(3)}px)`;
          gx.drawCanvas(mask, 0, 0);
          gx.restore();
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawCanvas(canvas, target.pad - inner.pad, target.pad - inner.pad);
          ctx.restore();
          break;
        }
        ctx.save();
        clipToShape(ctx, item);
        drawItems(ctx, item.items, paint, target, stretches);
        ctx.restore();
        break;
      }
      case 'stretch':
        ctx.save();
        applyStretch(ctx, item);
        drawItems(ctx, item.items, paint, target, [...stretches, item]);
        ctx.restore();
        break;
      case 'plane': {
        const fog = item.far === undefined ? undefined : (item.node.node as GroupNode).fog;
        if (fog) {
          // A plane with fog is drawn into a picture of its own, the fog laid over what it draws, and composited.
          const { canvas, ctx: gx } = layerCanvas(target);
          for (const s of stretches) {
            if (s.kind === 'plane') applyPlane(gx, s);
            else applyStretch(gx, s);
          }
          applyPlane(gx, item);
          if (!seesPlane(gx)) break;
          drawItems(planeContext(gx), item.items, paint, target, [...stretches, item]);
          fogPlane(gx, item.far!, fog, paint.tone('base', item.node.colors['fog']!), 'source-atop');
          // A plane that fades out with distance lets what lies behind it show through.
          if (fog.fade) fogPlane(gx, item.far!, { ...fog.fade, amount: 1 }, paint.tone('base', item.node.colors['fog']!), 'destination-out');
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawCanvas(canvas, 0, 0);
          ctx.restore();
          break;
        }
        ctx.save();
        applyPlane(ctx, item);
        if (seesPlane(ctx)) drawItems(planeContext(ctx), item.items, paint, target, [...stretches, item]);
        ctx.restore();
        break;
      }
    }
  }
}

const NO_STRETCH: readonly StretchItem[] = [];

/** Squashes or stretches what is drawn next: `height` times as high, 1 / `height` times as wide, about a point. */
function applyStretch(ctx: CanvasRenderingContext2D, s: StretchItem): void {
  if (s.axes) {
    // Along the node's own axes: out of the layer into the node, the change, and back.
    const a = s.axes;
    ctx.translate(s.at[0], s.at[1]);
    ctx.rotate(a.rot);
    ctx.translate(a.cx * a.scale, a.cy * a.scale);
    ctx.scale(a.sx, a.sy);
    ctx.rotate(-a.rot);
    ctx.translate(-s.at[0], -s.at[1]);
    return;
  }
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
  /** Opens a blank canvas the size of the one drawn on, for what is clipped by a mask (clipMask). */
  open?: () => { canvas: Canvas; ctx: CanvasRenderingContext2D },
): void {
  for (const item of items) {
    switch (item.kind) {
      case 'group':
        drawGlow(ctx, item.items, paint, covers, seen, state, open);
        break;
      case 'clip':
        if (maskedClip(item) && open) {
          // A clip by a mask (clipMask): the glow is drawn into a canvas of its own, kept inside the outline.
          const { canvas, ctx: gx } = open();
          const m = ctx.getTransform();
          gx.setTransform(m);
          drawGlow(planeCanvasOf(ctx) ? planeContext(gx) : gx, item.items, paint, covers, seen, state, open);
          const { canvas: mask, ctx: mx } = open();
          mx.setTransform(m);
          fillClipShape(mx, item);
          gx.save();
          gx.setTransform(1, 0, 0, 1, 0, 0);
          gx.globalCompositeOperation = 'destination-in';
          gx.drawCanvas(mask, 0, 0);
          gx.restore();
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawCanvas(canvas, 0, 0);
          ctx.restore();
          break;
        }
        ctx.save();
        clipToShape(ctx, item);
        drawGlow(ctx, item.items, paint, covers, seen, state, open);
        ctx.restore();
        break;
      case 'stretch':
        ctx.save();
        applyStretch(ctx, item);
        drawGlow(ctx, item.items, paint, covers, seen, state, open);
        ctx.restore();
        break;
      case 'plane': {
        ctx.save();
        applyPlane(ctx, item);
        const fog = item.far === undefined ? undefined : (item.node.node as GroupNode).fog;
        if (seesPlane(ctx) && fog && open) {
          // A glow on a plane with fog fades as the ground it lies on does.
          const { canvas, ctx: gx } = open();
          gx.setTransform(ctx.getTransform());
          drawGlow(planeContext(gx), item.items, paint, covers, seen, state, open);
          // Taking away keeps no colour: the fog's own stands in for any.
          fogPlane(gx, item.far!, fog, paint.tone('base', item.node.colors['fog']!), 'destination-out');
          if (fog.fade) fogPlane(gx, item.far!, { ...fog.fade, amount: 1 }, paint.tone('base', item.node.colors['fog']!), 'destination-out');
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawCanvas(canvas, 0, 0);
        } else if (seesPlane(ctx)) drawGlow(planeContext(ctx), item.items, paint, covers, seen, state, open);
        ctx.restore();
        break;
      }
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

function outlineInLayer(item: ShapeItem | ClipItem): Vec2[] {
  return outlineOf(itemShape(item)).map((p) => xfApply(item.xf, p));
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
      // What lies in a plane of a perspective layer is taken as seen: its place under a cover is not worked out.
      else if (item.kind === 'plane') continue;
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
    const { center } = shapeExtent(itemShape(g.item));
    const ring = outlineOf(itemShape(g.item));
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

/**
 * Draws items of a layer onto the frame: the wide pass of their halo under them, the items through the blur of the
 * layer, the tight pass of the halo on top.
 */
function drawLayerPart(
  ctx: CanvasRenderingContext2D,
  c: CompiledShot,
  items: readonly Item[],
  leaves: readonly LeafItem[],
  paint: Paint,
  seen: ReadonlyMap<LeafItem, number> | null,
  target: LayerTarget,
  blurPx: number,
): void {
  const { layer, k, pad } = target;
  const { canvas: lc, ctx: lx } = layerCanvas(target);
  drawItems(lx, items, paint, target);

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
    drawGlow(gx, items, paint, c.covers.length > 0, seen, undefined, () => {
      const made = newCanvas(target.scratch, gc.width, gc.height, target.gpu);
      return { canvas: made, ctx: made.getContext('2d') };
    });
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

/** The items of a layer cut at its hazes: what is drawn before the first, between each two, and after the last. */
function hazeParts(items: readonly Item[], hazes: readonly HazeItem[]): (readonly Item[])[] {
  const parts: (readonly Item[])[] = [];
  let from = 0;
  for (const h of hazes) {
    parts.push(items.slice(from, h.before));
    from = h.before;
  }
  parts.push(items.slice(from));
  return parts;
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
  // The background of this frame: what the shot says, or what its keys have made of it by now.
  const bg = state.background ?? { inner: c.background.inner, outer: c.background.outer, center: spec.background.center, radius: spec.background.radius, atmosphere: c.atmosphere, vignette: spec.vignette };

  // In a shot with covers or clips, a glowing shape lights its surroundings only as far as it can be seen.
  const hides = c.covers.length > 0 || c.clips;
  // Farthest layer first.
  const layers = state.layers
    .map((layer, i) => ({ layer, i }))
    .sort((a, b) => b.layer.layer.spec.depth - a.layer.layer.spec.depth || a.i - b.i)
    .map((x) => ({
      layer: x.layer,
      leaves: flatItems(x.layer.items),
      paint: makePaint(c.light, bg.atmosphere, x.layer.layer.tint, c.tones),
      seen: hides ? seenShares(x.layer.items) : null,
    }));

  // 1. Background gradient.
  ctx.save();
  ctx.scale(k, k);
  const bx = bg.center[0] * STAGE_W;
  const by = bg.center[1] * STAGE_H;
  const sky = ctx.createRadialGradient(bx, by, 0, bx, by, bg.radius * STAGE_W);
  sky.addColorStop(0, bg.inner);
  sky.addColorStop(1, bg.outer);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);

  // 2. Background lift: every glowing shape brightens what is behind it.
  ctx.globalCompositeOperation = 'screen';
  for (const { layer, leaves, paint, seen } of layers) {
    for (const item of leaves) {
      if (item.kind !== 'shape') continue;
      const node = item.node.node as ShapeNode;
      // A shape with a lift draws that share of it; one without draws all of it (a product with 1 is exact).
      const strength = node.glow * item.alpha * Math.min(1, item.xf.scale) * (node.lift ?? 1);
      if (strength <= 0) continue;
      const share = seen ? seen.get(item) ?? 1 : 1;
      if (share <= 0) continue;
      const v = layer.view;
      const x = item.xf.x * v.zoom + v.tx;
      const y = item.xf.y * v.zoom + v.ty;
      const r = shapeExtent(itemShape(item)).outer * item.xf.scale * v.zoom * GLOW.liftRadius;
      if (r < 1) continue;
      const color = paint.tone('base', itemFill(item));
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
    // A layer may hold nothing to draw and still a haze, which moves what the layers behind it have drawn.
    if (leaves.length === 0 && !layer.hazes) continue;
    const blurPx = Math.min(MAX_SOFT_PX * k, layer.layer.blur * k * layer.view.zoom);
    // Draw past the frame edge, so that a blur does not fade toward the border.
    const pad = blurPx > 0.05 ? Math.ceil(blurPx * 3) : 0;
    const target: LayerTarget = { scratch, layer, width, height, k, pad, gpu: opts.gpu };
    if (!layer.hazes) {
      drawLayerPart(ctx, c, layer.items, leaves, paint, seen, target, blurPx);
      continue;
    }
    // A layer with hazes is drawn in parts: what comes before a haze, its glow with it, is moved by it; what comes after is not.
    const parts = hazeParts(layer.items, layer.hazes);
    for (let h = 0; h < parts.length; h++) {
      if (h > 0) applyHaze(ctx, layer.hazes[h - 1]!, layer.view, k, width, height, opts.gpu ? GPU_MSAA : false);
      const part = parts[h]!;
      const partLeaves = flatItems(part);
      if (partLeaves.length > 0) drawLayerPart(ctx, c, part, partLeaves, paint, seen, target, blurPx);
    }
  }

  // 4. Vignette toward the background's outer colour (never toward gray or black).
  if (bg.vignette > 0) {
    ctx.save();
    const cx = width / 2;
    const cy = height / 2;
    const half = Math.hypot(cx, cy);
    const g = ctx.createRadialGradient(cx, cy, half * 0.45, cx, cy, half);
    g.addColorStop(0, withAlpha(bg.outer, 0));
    g.addColorStop(1, withAlpha(bg.outer, bg.vignette));
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

/**
 * Evaluates and draws one frame. Its canvases hold native memory until `dispose`; while they are alive, another frame
 * drawn on the GPU may come out with other pixels (see `oneFrameAtATime`), so dispose of it before the next one.
 */
export function drawFrame(c: CompiledShot, bake: Bake, frame: number, opts: RenderOptions): DrawnFrame {
  return drawState(c, evaluate(c, bake, frame, opts.lang), opts);
}

/** The frame of this process that is being drawn and read back, if there is one. */
let frameInHand: Promise<unknown> = Promise.resolve();

/**
 * Runs the drawing and the read-back of a frame when no other frame of this process is drawn or read back, and the
 * canvases of the one before are freed. On the GPU a frame is not the same frame while the canvases of another are
 * alive: a heavy frame (many layers, several of them blurred) is drawn with other edges, by a few levels, when the
 * canvases of the frame before still exist, also when that frame was read back before this one was drawn. So frames
 * are made one at a time, whoever asks for them and however many are asked for at once: a frame is the same in a
 * still, in a sheet, and at any place of a chunk of a render.
 */
function oneFrameAtATime<T>(job: () => Promise<T>): Promise<T> {
  const run = frameInHand.then(job, job);
  frameInHand = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The pixels of a drawn frame as raw RGBA bytes. */
export function readRaw(drawn: DrawnFrame, gpu: boolean): Promise<Buffer> {
  return drawn.canvas.toBuffer('raw', { colorType: 'rgba', msaa: gpu ? GPU_MSAA : false });
}

/** One frame as raw RGBA bytes (width * height * 4). On the GPU it waits for the render slot of the process, if any. */
export function frameRaw(c: CompiledShot, bake: Bake, frame: number, opts: RenderOptions): Promise<Buffer> {
  return oneFrameAtATime(async () => {
    if (opts.gpu) await waitForGpu();
    const drawn = drawFrame(c, bake, frame, opts);
    try {
      return await readRaw(drawn, opts.gpu);
    } finally {
      drawn.dispose();
    }
  });
}

/** One frame as PNG bytes. On the GPU it waits for the render slot of the process, if any. */
export function framePng(c: CompiledShot, bake: Bake, frame: number, opts: RenderOptions): Promise<Buffer> {
  return oneFrameAtATime(async () => {
    if (opts.gpu) await waitForGpu();
    const drawn = drawFrame(c, bake, frame, opts);
    try {
      return await drawn.canvas.toBuffer('png', { msaa: opts.gpu ? GPU_MSAA : false });
    } finally {
      drawn.dispose();
    }
  });
}

/** Which renderer skia-canvas actually uses for the given preference. */
export function rendererInfo(gpu: boolean): { renderer: string; api: string | null; device: string } {
  const probe = new Canvas(8, 8, { gpu });
  const e = probe.engine;
  probe.dispose();
  return { renderer: e.renderer, api: e.api, device: e.device };
}
