// Frame compositing on Skia: background, glow lift, depth layers back to front
// (each with its blur and its atmospheric perspective), halos, vignette. The
// result is a canvas whose pixels can be read back as raw RGBA.
//
// No texture, no grain: flat fills and gradients only.

import { Canvas, ImageData, type CanvasRenderingContext2D, type DOMMatrix } from 'skia-canvas';
import { xfApply, type Vec2 } from '../core/math.ts';
import { withAlpha } from '../look/color.ts';
import { GLOW } from '../look/light.ts';
import type { Bake } from '../physics/cache.ts';
import type { CNode, CompiledShot } from '../scene/compile.ts';
import { evaluate, flatItems, itemFill, itemPath, itemShape, itemWidth, type ClipItem, type FrameState, type GroupItem, type HazeItem, type Item, type LayerState, type LeafItem, type PlaneItem, type ShapeItem, type StretchItem, type StrokeItem } from '../scene/evaluate.ts';
import { STAGE_H, STAGE_W, type GroupNode, type LinkNode, type ShapeNode, type StrokeNode } from '../scene/types.ts';
import { containsPoint, transformOutline, outlineOf, shapeExtent } from '../shape/geometry.ts';
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
import { heldFrame, type HeldRange } from './holds.ts';
import { shapePath } from '../shape/path.ts';
import { outsideShape } from './bounds.ts';
import { drawFootprints } from './footprints.ts';
import { displayPlan } from './detail.ts';
import { applyHaze } from './haze.ts';
import { glowView, sampledFrame } from './backdrop.ts';
import { applyPlane, fogPlane, planeCanvas as planeCanvasOf, planeContext, seesPlane } from './plane.ts';
import { intoPlane, planePoint, type PlaneMap } from '../scene/space.ts';

export interface RenderOptions {
  /** Output width in pixels; the height follows from 16:9. */
  readonly width: number;
  /** Language of the string tables to render. */
  readonly lang: string;
  /** Draw on the GPU (falls back to the CPU when no GPU is available). */
  readonly gpu: boolean;
  /**
   * Draw the frame as a still of it alone draws it, whatever this process drew before it (`frameRaw` and `framePng`;
   * off by default). On the GPU the drawing library keeps the triangles of a curved outline for about a second and
   * draws that outline again with them, also at another scale: a frame drawn soon after a frame of another zoom may
   * differ from its still by a few pixels of such an edge. With `alone` a frame drawn after another first lets the GPU
   * rest from it for `GPU_FORGETS_MS`, so every frame after the first is slower by that much.
   */
  readonly alone?: boolean;
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

/**
 * How long a frame drawn `alone` waits after the frame of this process drawn on the GPU before it, in ms. The drawing
 * library drops what it keeps of the paths of earlier frames once nothing has used it for about a second, and offers no
 * way to drop it sooner: after 950 ms of rest a frame came out as its still, after 900 ms not always.
 */
export const GPU_FORGETS_MS = 1250;

/** How strongly an item feeds the halo: its glow times its opacity down the tree. */
function glowStrength(item: LeafItem): number {
  switch (item.kind) {
    case 'shape':
      return (item.node.node as ShapeNode).glow * item.alpha;
    case 'link':
      // A pulse always glows; the line glows as much as the link says.
      return Math.max((item.node.node as LinkNode).glow, item.pulses.length > 0 ? 1 : 0) * item.alpha;
    case 'particles':
      // An emitter faded as one picture glows as faintly as it is drawn.
      return item.node.node.type === 'emitter' ? item.node.node.glow * (item.faded ?? 1) : 0;
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
  readonly backdrop?: ImageData;
  readonly retained?: ReadonlyMap<number, ImageData>;
  readonly scratch: Scratch;
  readonly layer: LayerState;
  readonly width: number;
  readonly height: number;
  readonly k: number;
  readonly pad: number;
  readonly gpu: boolean;
  /** The most pixels a picture drawn for a blur, a soft node or a halo reaches past the canvas: the canvas of a lens. Left out: no limit. */
  readonly padCap?: number;
  /** Draws a magnifier inset (lens) of the frame onto a canvas of this layer. Left out in a frame without one. */
  readonly lens?: (ctx: CanvasRenderingContext2D, item: ShapeItem, paint: Paint, target: LayerTarget) => void;
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

/** Large projected outlines require an expensive intersection at every native clip; paint their alpha once instead. */
function rasterClip(item: ClipItem): boolean {
  if (maskedClip(item)) return true;
  if (item.node.plane < 0 || item.node.node.type !== 'shape' || item.node.node.clipMask === false) return false;
  const shape = itemShape(item);
  return shape.kind === 'polygon' && (shape.points.length >= 96 || Boolean(shape.rings?.some((r) => r.length >= 96)));
}

function layerCanvas(t: LayerTarget): { canvas: Canvas; ctx: CanvasRenderingContext2D } {
  const canvas = newCanvas(t.scratch, t.width + 2 * t.pad, t.height + 2 * t.pad, t.gpu);
  const ctx = canvas.getContext('2d');
  ctx.translate(t.pad, t.pad);
  ctx.scale(t.k, t.k);
  ctx.transform(t.layer.view.zoom, 0, 0, t.layer.view.zoom, t.layer.view.tx, t.layer.view.ty);
  return { canvas, ctx };
}

/** Size and offset of a plane's own colour surface. Cached ranges use exactly this same pixel grid. */
function pictureTarget(target: LayerTarget, ratio: number): LayerTarget {
  return ratio === 1 ? target : {
    ...target,
    width: Math.ceil(target.width * ratio),
    height: Math.ceil(target.height * ratio),
    k: target.k * ratio,
    pad: Math.ceil(target.pad * ratio),
  };
}

type DrawingMatrix = Pick<DOMMatrix, 'm11' | 'm12' | 'm14' | 'm21' | 'm22' | 'm24' | 'm41' | 'm42' | 'm44'>;

/**
 * Is the entire picture of an isolated, faded line outside its own padded canvas? Two open path points and their
 * spline controls lie along the same segment. Its round stroke lies in the axis-aligned box of the segment,
 * expanded by half its width. When the whole box is in front of the eye, the four corners bound the projection.
 * This check deliberately keeps other paths, and ones near the edge of the canvas or the eye.
 */
export function fadedStrokeOutside(item: GroupItem, transform: () => DrawingMatrix, width: number, height: number): boolean {
  if (item.soft !== undefined || item.items.length !== 1) return false;
  const leaf = item.items[0]!;
  if (leaf.kind !== 'stroke' || leaf.node !== item.node || leaf.foot || leaf.part || leaf.pulses || leaf.runs) return false;
  const node = leaf.node.node as StrokeNode;
  if (node.dash || node.glow > 0) return false;
  const path = itemPath(leaf);
  if (path.closed || path.heights || path.points.length !== 2) return false;
  const xf = leaf.xf;
  if (xf.rot !== 0 || !(xf.scale > 0)) return false;

  const a = path.points[0]!;
  const b = path.points[1]!;
  const stroke = itemWidth(leaf);
  // The path and matrix are narrowed to floats in Skia. Include roundoff in the local stroke bounds and in the
  // projection below. Keep extra pixels for antialiasing and decline boxes that approach the projection's singularity.
  const roundoff = 2 ** -16;
  const radius = stroke / 2 + roundoff * (1 + stroke + Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1])));
  const loX = Math.min(a[0], b[0]) - radius;
  const hiX = Math.max(a[0], b[0]) + radius;
  const loY = Math.min(a[1], b[1]) - radius;
  const hiY = Math.max(a[1], b[1]) + radius;
  const { m11, m12, m14, m21, m22, m24, m41, m42, m44 } = transform();

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < 4; i++) {
    const x = (i < 2 ? loX : hiX) * xf.scale;
    const y = (i % 2 === 0 ? loY : hiY) * xf.scale;
    const u = xf.x + x;
    const v = xf.y + y;
    // Bound the magnitude of terms before cancellation, including the stroke's own translation and scale.
    const absU = Math.abs(xf.x) + Math.abs(x);
    const absV = Math.abs(xf.y) + Math.abs(y);
    const w = m14 * u + m24 * v + m44;
    const errW = roundoff * (1 + Math.abs(m14) * absU + Math.abs(m24) * absV + Math.abs(m44));
    const safeW = w - errW;
    if (!(safeW >= 0.125)) return false;
    const px = (m11 * u + m21 * v + m41) / w;
    const py = (m12 * u + m22 * v + m42) / w;
    if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
    const errX = roundoff * (1 + Math.abs(m11) * absU + Math.abs(m21) * absV + Math.abs(m41));
    const errY = roundoff * (1 + Math.abs(m12) * absU + Math.abs(m22) * absV + Math.abs(m42));
    const padX = (errX + Math.abs(px) * errW) / safeW;
    const padY = (errY + Math.abs(py) * errW) / safeW;
    left = Math.min(left, px - padX);
    top = Math.min(top, py - padY);
    right = Math.max(right, px + padX);
    bottom = Math.max(bottom, py + padY);
  }
  const margin = 8;
  return right < -margin || bottom < -margin || left > width + margin || top > height + margin;
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
  const planeView = planeCanvasOf(ctx);
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind === 'shape' && item.detail?.facet) {
      const drawn = drawFootprints(ctx, items, i, paint);
      if (drawn) i += drawn - 1;
      else drawShape(ctx, { ...item, detail: undefined, foot: item.detail.facet }, paint);
      continue;
    }
    switch (item.kind) {
      case 'shape':
        if (item.lens && target.lens) target.lens(ctx, item, paint, target);
        else if (!planeView || !outsideShape(item, planeView)) drawShape(ctx, item, paint);
        break;
      case 'eye':
        drawEye(ctx, item, paint);
        break;
      case 'link':
        drawLink(ctx, item, paint);
        break;
      case 'label':
        drawLabel(ctx, item, paint);
        break;
      case 'particles':
        drawParticles(ctx, item, paint);
        break;
      case 'stroke':
        drawStroke(ctx, item, paint);
        break;
      case 'text':
        drawText(ctx, item, paint);
        break;
      case 'cast':
        drawCast(ctx, item, paint);
        break;
      case 'group': {
        if (item.retained) {
          const image = target.retained!.get(item.node.index)!;
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(image, 0, 0);
          ctx.restore();
          break;
        }
        if (target.backdrop && item.node.index === target.layer.layer.sampledIndex) {
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(target.backdrop, 0, 0);
          ctx.restore();
          break;
        }
        // A faded line outside the actual layer canvas has no pixels to composite, even in its blur padding.
        const plane = planeCanvasOf(ctx);
        if (plane && fadedStrokeOutside(item, plane.transform, target.width + 2 * target.pad, target.height + 2 * target.pad)) break;
        const leaf = item.items.length === 1 ? item.items[0] : undefined;
        if (
          plane &&
          item.soft === undefined &&
          leaf?.kind === 'stroke' &&
          leaf.node === item.node &&
          !leaf.foot &&
          !leaf.pulses &&
          !leaf.runs
        ) {
          ctx.save();
          ctx.globalAlpha *= item.opacity;
          drawStroke(ctx, leaf, paint);
          ctx.restore();
          break;
        }
        if (
          plane &&
          item.soft === undefined &&
          leaf?.kind === 'shape' &&
          leaf.node === item.node &&
          leaf.node.node.type === 'shape' &&
          !leaf.node.node.lit &&
          !leaf.node.node.rimLight &&
          !leaf.node.node.relief &&
          !leaf.node.node.globe &&
          !leaf.foot &&
          !leaf.detail?.facet &&
          !leaf.upon &&
          !leaf.level &&
          !leaf.lens
        ) {
          ctx.save();
          ctx.globalAlpha *= item.opacity;
          drawShape(ctx, leaf, paint);
          ctx.restore();
          break;
        }
        // A soft group is blurred as one picture; its canvas has room around the frame for what the blur brings in.
        const softPx = item.soft === undefined ? 0 : Math.min(MAX_SOFT_PX * target.k, item.soft * target.k * target.layer.view.zoom);
        const inner = softPx > 0.05 ? { ...target, pad: Math.max(target.pad, Math.min(target.padCap ?? Infinity, Math.ceil(softPx * 3))) } : target;
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
        if (softPx > 0.05 || rasterClip(item)) {
          // A clip with a soft edge: the items are drawn whole into a picture of their own, and that picture is kept
          // as far as the blurred outline of the shape is there. A clip by a mask (clipMask) is drawn the same way with a
          // sharp edge (see maskedClip).
          const inner = { ...target, pad: Math.max(target.pad, Math.min(target.padCap ?? Infinity, Math.ceil(softPx * 3))) };
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
        const ratio = item.node.pictureScale ?? 1;
        if (fog || ratio < 1) {
          const inner = pictureTarget(target, ratio);
          const { canvas, ctx: gx } = layerCanvas(inner);
          for (const s of stretches) {
            if (s.kind === 'plane') applyPlane(gx, s);
            else applyStretch(gx, s);
          }
          applyPlane(gx, item);
          if (!seesPlane(gx)) break;
          drawItems(planeContext(gx), item.items, paint, inner, [...stretches, item]);
          if (fog) {
            fogPlane(gx, item.far!, fog, paint.tone('base', item.node.colors['fog']!), 'source-atop');
            if (fog.fade) fogPlane(gx, item.far!, { ...fog.fade, amount: 1 }, paint.tone('base', item.node.colors['fog']!), 'destination-out');
          }
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          if (ratio === 1) ctx.drawCanvas(canvas, 0, 0);
          else {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'medium';
            ctx.drawCanvas(canvas, target.pad - inner.pad / ratio, target.pad - inner.pad / ratio, canvas.width / ratio, canvas.height / ratio);
          }
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

function outlineInLayer(item: ShapeItem | ClipItem): Vec2[] {
  return transformOutline(itemShape(item), (p) => xfApply(item.xf, p));
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
      if (g.clips.some((poly) => !containsPoint(poly, p[0], p[1]))) continue;
      // Of a content with a level only the part below its surface is there.
      if (g.item.level && !containsPoint(g.item.level, p[0], p[1])) continue;
      let hidden = 0;
      for (const cover of covers) {
        if (cover.order > g.order && cover.alpha > hidden && containsPoint(cover.poly, p[0], p[1])) hidden = cover.alpha;
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
    const gpad = Math.min(target.padCap ?? Infinity, Math.ceil(wide * 3));
    const { canvas: gc, ctx: gx } = layerCanvas({ ...target, pad: gpad });
    drawGlow(gx, layer.layer.persp ? glowItems(items, c.covers.length > 0) : items, paint, c.covers.length > 0, seen, undefined, () => {
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

/** Where a lens looks in a state of the frame: the item of the lens node, found among the items of its layers. */
function lensOf(state: FrameState, index: number): ShapeItem['lens'] {
  const find = (items: readonly Item[]): ShapeItem['lens'] => {
    for (const item of items) {
      if (item.kind === 'shape' && item.node.index === index) return item.lens;
      if ('items' in item) {
        const hit = find(item.items);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  for (const layer of state.layers) {
    const hit = find(layer.items);
    if (hit) return hit;
  }
  return undefined;
}

/** What a magnifier inset needs of the frame it is drawn in. */
interface LensFrame {
  readonly c: CompiledShot;
  /** The layers of the frame, farthest first, each with the index of its layer in the shot. */
  readonly layers: readonly {
    readonly layer: LayerState;
    readonly index: number;
    readonly leaves: readonly LeafItem[];
    readonly paint: Paint;
    readonly seen: ReadonlyMap<LeafItem, number> | null;
  }[];
  readonly bg: { readonly inner: string; readonly outer: string; readonly center: readonly [number, number]; readonly radius: number };
  readonly k: number;
  readonly scratch: Scratch;
  readonly gpu: boolean;
}

/** A box of a layer, [x0, y0, x1, y1] in its units. */
type LensBox = readonly [number, number, number, number];

/** How far round the part of a layer a lens shows its items are still drawn: a share of the lens's size, and, for what glows, units of the layer for its halo. */
const LENS_REACH = 0.25;
const LENS_HALO = 80;
/** A plain line of this many points or more is cut to the part of it a lens shows. */
const LENS_RUN_POINTS = 16;

/** The local box of the points of a path, kept per path. */
const pathBoxes = new WeakMap<object, LensBox>();
function pathBox(points: readonly Vec2[]): LensBox {
  let hit = pathBoxes.get(points);
  if (!hit) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of points) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    // A smooth curve through the points may bulge past them a little.
    const bulge = 0.15 * Math.max(x1 - x0, y1 - y0);
    hit = [x0 - bulge, y0 - bulge, x1 + bulge, y1 + bulge];
    pathBoxes.set(points, hit);
  }
  return hit;
}

/** Whether points of a node's own space, placed by `xf` (and drawn through `map`), all lie outside a box of the layer. */
function pointsOutside(corners: readonly Vec2[], xf: { x: number; y: number; rot: number; scale: number }, map: PlaneMap | null, box: LensBox, pad: number): boolean {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of corners) {
    let p = xfApply(xf, c);
    if (map) {
      // A point near or behind the camera of the plane: drawn whatever it is.
      if (!(map.g * p[0] + map.h * p[1] + 1 > 0.05)) return false;
      p = planePoint(map, p);
    }
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  return x1 + pad < box[0] || y1 + pad < box[1] || x0 - pad > box[2] || y0 - pad > box[3];
}

/** Whether a leaf lies wholly outside a box of its layer, its halo too. Only flat shapes and lines are judged: anything else is drawn. */
function leafOutside(item: LeafItem, box: LensBox, map: PlaneMap | null): boolean {
  const halo = glowStrength(item) > 0 ? LENS_HALO : 0;
  if (item.kind === 'shape') {
    const node = item.node.node as ShapeNode;
    if (item.lens || item.foot || item.raise || item.upon || item.detail || item.level || node.relief || node.globe || node.haze || node.soft) return false;
    const shape = itemShape(item);
    // An outline of points: the box of its points (a region bulges a little past them); any other shape: its reach.
    let b: LensBox;
    if (shape.kind === 'polygon') b = pathBox(shape.points);
    else {
      const { center, outer } = shapeExtent(shape);
      b = [center[0] - outer, center[1] - outer, center[0] + outer, center[1] + outer];
    }
    return pointsOutside([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], item.xf, map, box, halo);
  }
  if (item.kind === 'stroke') {
    if (item.foot || item.runs) return false;
    const b = pathBox(itemPath(item).points);
    return pointsOutside([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], item.xf, map, box, itemWidth(item) * item.xf.scale + halo);
  }
  return false;
}

/** A long plain line cut to a box of its layer: the runs of its stretches that reach into it, each one point longer at both ends. */
function strokeRuns(item: StrokeItem, box: LensBox, map: PlaneMap | null): StrokeItem[] | null {
  const node = item.node.node as StrokeNode;
  if (node.dash || item.pulses || item.runs || item.foot || item.part || item.drawn < 1) return null;
  const path = itemPath(item);
  const pts = path.points;
  if (pts.length < LENS_RUN_POINTS) return null;
  const pad = itemWidth(item) * item.xf.scale + (glowStrength(item) > 0 ? LENS_HALO : 0);
  const n = pts.length;
  const seg = path.closed ? n : n - 1;
  // Where each point lies on the layer; null where it lies near or behind the camera of its plane.
  const at = pts.map((p): Vec2 | null => {
    const q = xfApply(item.xf, p);
    if (!map) return q;
    return map.g * q[0] + map.h * q[1] + 1 > 0.05 ? planePoint(map, q) : null;
  });
  const keep = new Uint8Array(seg);
  let kept = 0;
  for (let i = 0; i < seg; i++) {
    const a = at[i];
    const b = at[(i + 1) % n];
    if (!a || !b) return null;
    if (!(Math.max(a[0], b[0]) + pad < box[0] || Math.max(a[1], b[1]) + pad < box[1] || Math.min(a[0], b[0]) - pad > box[2] || Math.min(a[1], b[1]) - pad > box[3])) {
      keep[i] = 1;
      kept++;
    }
  }
  if (kept === seg) return null;
  const out: StrokeItem[] = [];
  for (let i = 0; i < seg; i++) {
    if (!keep[i] || (i > 0 && keep[i - 1])) continue;
    let j = i;
    while (j + 1 < seg && keep[j + 1]) j++;
    // The run from point i to point j + 1, one more point at each end, so that a smooth line keeps its bends there.
    const run: Vec2[] = [];
    for (let k = i - 1; k <= j + 2; k++) {
      if (path.closed) run.push(pts[(k + n) % n]!);
      else if (k >= 0 && k < n) run.push(pts[k]!);
    }
    out.push({ ...item, path: runOf(path, i, j, run) });
  }
  return out;
}

/** The runs of a line, kept per line and per stretch, so that the measure of each is made once while it is shown. */
const runPaths = new WeakMap<object, Map<string, ReturnType<typeof itemPath>>>();
function runOf(path: ReturnType<typeof itemPath>, i: number, j: number, points: Vec2[]): ReturnType<typeof itemPath> {
  let byRun = runPaths.get(path.points);
  if (!byRun) runPaths.set(path.points, (byRun = new Map()));
  const key = `${i},${j},${path.smooth}`;
  let made = byRun.get(key);
  if (!made) byRun.set(key, (made = { ...path, points, closed: false }));
  return made;
}

/** A closed outline cut to a convex one (Sutherland-Hodgman); `side` is 1 when the convex one runs with a positive area, else -1. */
function clipTo(points: readonly Vec2[], hull: readonly Vec2[], side: number): Vec2[] {
  let out: Vec2[] = [...points];
  for (let k = 0; k < hull.length && out.length > 0; k++) {
    const a = hull[k]!;
    const b = hull[(k + 1) % hull.length]!;
    const inner = (p: Vec2): number => side * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const was = out;
    out = [];
    for (let i = 0; i < was.length; i++) {
      const p = was[i]!;
      const q = was[(i + 1) % was.length]!;
      const sp = inner(p);
      const sq = inner(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}

/**
 * A large flat outline of points, cut to a box of its layer: the box taken back into the shape's own space (through
 * its plane and its place), and the outline, or each of its rings, cut to it. What is cut away lies outside the box,
 * where nothing of the lens is seen. Null when it is not to be cut: a lit shape (its light is made from the outline),
 * a curved one, a small one, or one whose plane does not hold the whole box in front of its camera.
 */
function regionInBox(item: ShapeItem, box: LensBox, map: PlaneMap | null): ShapeItem | null | 'none' {
  const node = item.node.node as ShapeNode;
  const shape = itemShape(item);
  if (node.lit || node.rimLight || shape.kind !== 'polygon') return null;
  const rings = shape.rings ?? (shape.smooth === 0 ? [shape.points] : null);
  if (!rings || rings.reduce((n, r) => n + r.length, 0) < LENS_RUN_POINTS) return null;
  const { xf } = item;
  if (!(xf.scale > 0)) return null;
  const cos = Math.cos(-xf.rot);
  const sin = Math.sin(-xf.rot);
  const hull: Vec2[] = [];
  for (const [x, y] of [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]] as const) {
    let p: Vec2 = [x, y];
    if (map) {
      const q = intoPlane(map, { x, y });
      // The corner must lie in front of the camera of the plane, and come back to where it was.
      if (!(map.g * q.x + map.h * q.y + 1 > 0.05)) return null;
      const back = planePoint(map, [q.x, q.y]);
      if (Math.abs(back[0] - x) + Math.abs(back[1] - y) > 1e-3 * (1 + Math.abs(x) + Math.abs(y))) return null;
      p = [q.x, q.y];
    }
    const dx = (p[0] - xf.x) / xf.scale;
    const dy = (p[1] - xf.y) / xf.scale;
    hull.push([dx * cos - dy * sin, dx * sin + dy * cos]);
  }
  let area = 0;
  for (let i = 0; i < 4; i++) area += hull[i]![0] * hull[(i + 1) % 4]![1] - hull[(i + 1) % 4]![0] * hull[i]![1];
  if (Math.abs(area) < 1e-9) return null;
  const cut = rings.map((r) => clipTo(r, hull, area > 0 ? 1 : -1)).filter((r) => r.length >= 3);
  if (cut.length === 0) return 'none';
  if (shape.rings) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const r of cut) for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { ...item, shape: { ...shape, rings: cut, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] } };
  }
  return { ...item, shape: { ...shape, points: cut[0]! } };
}

/** The items of a layer that reach into a box of it: what lies wholly outside it is left out, and so are groups left empty. */
function within(items: readonly Item[], box: LensBox, map: PlaneMap | null): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    switch (item.kind) {
      case 'group':
      case 'clip': {
        if (item.kind === 'group' && (item.sampled || item.retained)) {
          out.push(item);
          break;
        }
        const inner = within(item.items, box, map);
        if (inner.length > 0) out.push(inner.length === item.items.length ? item : { ...item, items: inner });
        break;
      }
      case 'plane': {
        // A plane in a plane is drawn whole.
        const inner = map ? item.items : within(item.items, box, item.map);
        if (inner.length > 0) out.push(inner.length === item.items.length ? item : { ...item, items: inner });
        break;
      }
      case 'stretch':
        out.push(item);
        break;
      default: {
        if (leafOutside(item, box, map)) break;
        const runs = item.kind === 'stroke' ? strokeRuns(item, box, map) : null;
        const region = item.kind === 'shape' && !item.lens && !item.foot && !item.level && !item.detail ? regionInBox(item, box, map) : null;
        if (runs) out.push(...runs);
        else if (region === 'none') break;
        else out.push(region ?? item);
      }
    }
  }
  return out;
}

/** How wide the leader of a lens is drawn: a share of the width of its ring. */
const LEADER_WIDTH = 0.6;

/**
 * A magnifier inset (lens). The frame as drawn up to the layer it shows (the background and every layer from the
 * farthest to that one) is drawn again into a canvas of the lens's own size, enlarged `zoom` times about the place on
 * the frame of the node it looks at, which comes to the middle of the lens: the same display list through a second
 * camera, its halos and blurs enlarged with it; what lies outside the lens is culled or cut by that small canvas. It is
 * drawn from the whole frame: a part of a plane the frame holds as a picture, or a sampled backdrop, is drawn as it is. The
 * picture is laid inside the outline of the lens, the outline is drawn round it as a ring in the lens's fill, and
 * with `leader` the part of the frame it shows is marked by the same outline, made smaller, joined to the lens by a line.
 */
function drawLens(ctx: CanvasRenderingContext2D, item: ShapeItem, paint: Paint, target: LayerTarget, f: LensFrame): void {
  const node = item.node.node as ShapeNode;
  const spec = node.lens!;
  const at = item.lens!;
  const shape = itemShape(item);
  // From the lens's own space to the pixels of the canvas it is drawn on.
  const m = ctx.getTransform().translate(item.xf.x, item.xf.y).rotate((item.xf.rot * 180) / Math.PI).scale(item.xf.scale, item.xf.scale);
  const device = (p: readonly number[]): Vec2 => [m.a * p[0]! + m.c * p[1]! + m.e, m.b * p[0]! + m.d * p[1]! + m.f];
  const outline = outlineOf(shape).map(device);
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of outline) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const bx0 = Math.max(0, Math.floor(x0) - 1);
  const by0 = Math.max(0, Math.floor(y0) - 1);
  const bx1 = Math.min(ctx.canvas.width, Math.ceil(x1) + 1);
  const by1 = Math.min(ctx.canvas.height, Math.ceil(y1) + 1);
  // Where the lens is drawn and where it looks, on this canvas; how much larger a unit of the stage is in it.
  const centre = device(shapeExtent(shape).center);
  const look: Vec2 = [at.look[0] * f.k + target.pad, at.look[1] * f.k + target.pad];
  const kz = f.k * spec.zoom;
  const tone = paint.tone('base', itemFill(item));

  if (bx1 - bx0 >= 2 && by1 - by0 >= 2) {
    const cw = bx1 - bx0;
    const ch = by1 - by0;
    const content = newCanvas(f.scratch, cw, ch, f.gpu);
    const cx = content.getContext('2d');
    // A point s of the stage lands at (centre - corner) + zoom k (s - look) of the canvas of the lens.
    const ox = centre[0] - bx0 - kz * at.look[0];
    const oy = centre[1] - by0 - kz * at.look[1];
    cx.save();
    cx.setTransform(kz, 0, 0, kz, ox, oy);
    const bx = f.bg.center[0] * STAGE_W;
    const by = f.bg.center[1] * STAGE_H;
    const sky = cx.createRadialGradient(bx, by, 0, bx, by, f.bg.radius * STAGE_W);
    sky.addColorStop(0, f.bg.inner);
    sky.addColorStop(1, f.bg.outer);
    cx.fillStyle = sky;
    cx.fillRect(-ox / kz, -oy / kz, cw / kz, ch / kz);
    cx.restore();
    // Its pictures reach no farther past it than it is wide: what a blur brings in from farther is not seen in it.
    const cap = Math.max(cw, ch);
    for (const l of f.layers) {
      const view = l.layer.view;
      const tx = view.tx + ox / kz;
      const ty = view.ty + oy / kz;
      const shown: LayerState = { ...l.layer, view: { zoom: view.zoom, tx, ty } };
      const blurPx = Math.min(MAX_SOFT_PX * kz, (l.layer.blur ?? l.layer.layer.blur) * kz * view.zoom);
      const lensTarget: LayerTarget = { scratch: f.scratch, layer: shown, width: cw, height: ch, k: kz, pad: blurPx > 0.05 ? Math.min(cap, Math.ceil(blurPx * 3)) : 0, gpu: f.gpu, padCap: cap };
      // The part of the layer the lens shows, in its units, with room for what a halo or a blur brings into it.
      const unit = kz * view.zoom;
      const margin = (LENS_REACH * Math.max(cw, ch)) / unit;
      const box: LensBox = [-tx / view.zoom - margin, -ty / view.zoom - margin, (cw / kz - tx) / view.zoom + margin, (ch / kz - ty) / view.zoom + margin];
      const items = within(l.layer.items, box, null);
      // Only what is drawn in the lens lights its halo there.
      if (items.length > 0) drawLayerPart(cx, f.c, items, flatItems(items), l.paint, l.seen, lensTarget, blurPx);
      if (l.index === at.layer) break;
    }
    // The picture, inside the outline of the lens.
    ctx.save();
    ctx.setTransform(m);
    ctx.clip(shapePath(shape));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawCanvas(content, bx0, by0);
    ctx.restore();
  }

  ctx.save();
  ctx.strokeStyle = tone;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (spec.leader) {
    // The part of the frame the lens shows, marked by its outline made smaller, and a line from it to the lens.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = spec.width * Math.hypot(m.a, m.b) * LEADER_WIDTH;
    const dx = centre[0] - look[0];
    const dy = centre[1] - look[1];
    const away = Math.hypot(dx, dy);
    if (away > 1e-6) {
      const ux = dx / away;
      const uy = dy / away;
      const big = reach(outline, centre, -ux, -uy);
      const small = big / spec.zoom;
      // Only while the mark lies outside the lens is there a line between them.
      if (away > big + small) {
        ctx.beginPath();
        ctx.moveTo(look[0] + ux * small, look[1] + uy * small);
        ctx.lineTo(centre[0] - ux * big, centre[1] - uy * big);
        ctx.stroke();
      }
    }
    ctx.beginPath();
    outline.forEach(([x, y], i) => {
      const p: Vec2 = [look[0] + (x - centre[0]) / spec.zoom, look[1] + (y - centre[1]) / spec.zoom];
      if (i === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    });
    ctx.closePath();
    ctx.stroke();
  }
  // The ring round the lens.
  ctx.setTransform(m);
  ctx.lineWidth = spec.width;
  ctx.stroke(shapePath(shape));
  ctx.restore();
}

/** How far a closed outline reaches from a point inside it along a direction: its farthest crossing of that ray. */
function reach(outline: readonly Vec2[], from: Vec2, ux: number, uy: number): number {
  let best = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const ax = a[0] - from[0];
    const ay = a[1] - from[1];
    const t = (ax * ey - ay * ex) / den;
    const u = (ax * uy - ay * ux) / den;
    if (t > 0 && u >= 0 && u <= 1) best = Math.max(best, t);
  }
  return best;
}

export interface DrawnFrame {
  readonly canvas: Canvas;
  /** Frees the native memory of the frame and of its scratch canvases. */
  dispose(): void;
}

/** Draws a display list. */
export function drawState(c: CompiledShot, state: FrameState, opts: RenderOptions, backdrops?: ReadonlyMap<number, ImageData>, retained?: ReadonlyMap<number, ImageData>, whole?: FrameState): DrawnFrame {
  const width = opts.width;
  const height = heightFor(width);
  const k = width / STAGE_W;
  const scratch: Scratch = { canvases: [] };
  const out = newCanvas(scratch, width, height, opts.gpu);
  const ctx = out.getContext('2d');
  const spec = c.spec;
  const retainedLayers = new Set<number>();
  for (const index of retained?.keys() ?? []) retainedLayers.add(c.nodes[index]!.layer);
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
      index: x.i,
      leaves: flatItems(x.layer.items),
      paint: makePaint(c.light, bg.atmosphere, x.layer.layer.tint, c.tones),
      seen: hides ? seenShares(x.layer.items) : null,
    }));
  // A magnifier inset draws the frame again through a camera of its own, inside its outline: from the whole frame, also
  // where the frame itself draws a held picture of a still part of a plane or a sampled backdrop.
  let shown: LensFrame['layers'] | undefined;
  const lens = c.lenses
    ? (lx: CanvasRenderingContext2D, item: ShapeItem, paint: Paint, target: LayerTarget): void => {
        shown ??= !whole || whole === state ? layers : whole.layers
          .map((layer, i) => ({ layer, i }))
          .sort((a, b) => b.layer.layer.spec.depth - a.layer.layer.spec.depth || a.i - b.i)
          .map((x) => ({ layer: x.layer, index: x.i, leaves: flatItems(x.layer.items), paint: makePaint(c.light, bg.atmosphere, x.layer.layer.tint, c.tones), seen: hides ? seenShares(x.layer.items) : null }));
        // Where it looks, as the whole frame has it: the node it looks at may lie in a part the frame draws as a picture.
        const look = whole && whole !== state ? lensOf(whole, item.node.index) : undefined;
        drawLens(lx, look ? { ...item, lens: look } : item, paint, target, { c, layers: shown, bg, k, scratch, gpu: opts.gpu });
      }
    : undefined;

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
    const backdrop = layer.layer.sampledIndex === undefined ? undefined : backdrops?.get(layer.layer.sampledIndex);
    if (leaves.length === 0 && !layer.hazes && !backdrop && !retainedLayers.has(c.layers.indexOf(layer.layer))) continue;
    // A layer whose focus is pulled has the blur of this frame.
    const blurPx = Math.min(MAX_SOFT_PX * k, (layer.blur ?? layer.layer.blur) * k * layer.view.zoom);
    // Draw past the frame edge, so that a blur does not fade toward the border.
    const pad = blurPx > 0.05 ? Math.ceil(blurPx * 3) : 0;
    const target: LayerTarget = { scratch, layer, width, height, k, pad, gpu: opts.gpu, backdrop, retained, ...(lens ? { lens } : {}) };
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
      if (partLeaves.length > 0 || (backdrop && part.some(item => item.node.index === layer.layer.sampledIndex))) {
        drawLayerPart(ctx, c, part, partLeaves, paint, seen, target, blurPx);
      }
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
  c = displayPlan(c, opts.width).view;
  if (!c.sampledBackdrops) {
    const held = heldFrame(c, bake, frame, opts);
    if (!held?.ranges.length) return drawState(c, evaluate(c, bake, frame, opts.lang), opts);
    if (held.images.size < held.ranges.length) {
      const states = new Map<number, FrameState>();
      for (const range of held.ranges) {
        if (held.images.has(range.first)) continue;
        let state = states.get(range.anchor);
        if (!state) {
          state = evaluate(c, bake, range.anchor, opts.lang);
          states.set(range.anchor, state);
        }
        held.images.set(range.first, captureRange(c, state, range, opts));
      }
    }
    return drawState(held.view, evaluate(held.view, bake, frame, opts.lang), opts, undefined, held.images, c.lenses ? evaluate(c, bake, frame, opts.lang) : undefined);
  }
  let current: FrameState | undefined;
  const full = (f: number): FrameState => (f === frame ? (current ??= evaluate(c, bake, f, opts.lang)) : evaluate(c, bake, f, opts.lang));
  const { live, images } = sampledFrame(c, bake, frame, opts, ({ group }, f) => captureBackdrop(c, full(f), group, opts));
  if (!images?.size) return drawState(c, full(frame), opts);
  const state = evaluate(live, bake, frame, opts.lang);
  if (!c.sampledBackdrops.some((source) => source.liveGlow && images.has(source.group.index))) return drawState(live, state, opts, images, undefined, c.lenses ? full(frame) : undefined);
  const layers = [...state.layers];
  for (const source of c.sampledBackdrops) {
    const { group, layer, liveGlow } = source;
    if (!liveGlow || !images.has(group.index)) continue;
    const view = glowView(c, source);
    const frameView = current ?? (view === c ? full(frame) : evaluate(view, bake, frame, opts.lang));
    const original = frameView.layers[layer]!.items.filter((item) => group.index <= item.node.index && item.node.index <= group.subtreeEnd);
    const glows = glowItems(original);
    const active = layers[layer]!;
    layers[layer] = {
      ...active,
      items: active.items.map((item) =>
        item.kind === 'group' && item.sampled && item.node.index === group.index ? { ...item, items: glows } : item,
      ),
    };
  }
  return drawState(live, { ...state, layers }, opts, images, undefined, c.lenses ? full(frame) : undefined);
}

/** The live halo traverses its original group, plane and clip wrappers. The colour pass paints the cached group image. */
function glowItems(items: readonly Item[], covers = false): Item[] {
  const result: Item[] = [];
  for (const item of items) {
    if ('items' in item) {
      const children = glowItems(item.items, covers);
      if (children.length) result.push({ ...item, items: children });
    } else if (glowStrength(item) > 0 || covers && item.kind === 'shape' && item.node.node.type === 'shape' && item.node.node.cover) result.push(item);
  }
  return result;
}

/** Capture the contiguous source-order colour contribution inside its original plane. */
function captureRange(c: CompiledShot, state: FrameState, r: HeldRange, opts: RenderOptions): ImageData {
  const layer = state.layers[r.layer]!;
  const p = layer.items.find((item): item is PlaneItem => item.kind === 'plane' && item.node.index === r.plane);
  const k = opts.width / STAGE_W,
    blur = Math.min(MAX_SOFT_PX * k, layer.layer.blur * k * layer.view.zoom);
  const target = pictureTarget({
    scratch: { canvases: [] },
    layer,
    k,
    width: opts.width,
    height: heightFor(opts.width),
    gpu: opts.gpu,
    pad: blur > 0.05 ? Math.ceil(blur * 3) : 0,
  }, p?.node.pictureScale ?? 1);
  try {
    const { canvas, ctx } = layerCanvas(target);
    if (p) {
      applyPlane(ctx, p);
      if (seesPlane(ctx))
        drawItems(
          planeContext(ctx),
          p.items.filter((x) => x.node.index >= r.first && x.node.index <= r.last),
          makePaint(c.light, state.background?.atmosphere ?? c.atmosphere, layer.layer.tint, c.tones),
          target,
          [p],
        );
    }
    return new ImageData(canvas.toBufferSync('raw', { colorType: 'rgba', msaa: opts.gpu ? GPU_MSAA : false }), canvas.width, canvas.height);
  } finally {
    for (const cv of target.scratch.canvases) cv.dispose();
  }
}

/** Rasterize the group's own transparent contribution, before layer blur, live halos and vignette. */
function captureBackdrop(c: CompiledShot, state: FrameState, group: CNode, opts: RenderOptions): ImageData {
  const layer = state.layers[group.layer]!;
  const items = layer.items.filter(item => item.node.index >= group.index && item.node.index <= group.subtreeEnd);
  const k = opts.width / STAGE_W;
  const blurPx = Math.min(MAX_SOFT_PX * k, layer.layer.blur * k * layer.view.zoom);
  const target: LayerTarget = { scratch: { canvases: [] }, layer, k, width: opts.width, height: heightFor(opts.width),
    gpu: opts.gpu, pad: blurPx > 0.05 ? Math.ceil(blurPx * 3) : 0 };
  try {
    const { canvas, ctx } = layerCanvas(target);
    drawItems(ctx, items, makePaint(c.light, state.background?.atmosphere ?? c.atmosphere, layer.layer.tint, c.tones), target);
    const raw = canvas.toBufferSync('raw', { colorType: 'rgba', msaa: opts.gpu ? GPU_MSAA : false });
    return new ImageData(raw, canvas.width, canvas.height);
  } finally {
    for (const canvas of target.scratch.canvases) canvas.dispose();
  }
}

/** Draws a frame and frees its canvases when readback has finished. */
async function drawnAndRead<T>(c: CompiledShot, bake: Bake, frame: number, opts: RenderOptions, read: (drawn: DrawnFrame) => Promise<T>): Promise<T> {
  const drawn = drawFrame(c, bake, frame, opts);
  try {
    return await read(drawn);
  } finally {
    drawn.dispose();
    if (opts.gpu) drewOnGpu = true;
  }
}

/** The frame of this process that is being drawn and read back, if there is one. */
let frameInHand: Promise<unknown> = Promise.resolve();

/**
 * Runs the drawing and the read-back of a frame when no other frame of this process is drawn or read back, and the
 * canvases of the one before are freed. On the GPU a frame is not the same frame while the canvases of another are
 * alive: a heavy frame (many layers, several of them blurred) is drawn with other edges, by a few levels, when the
 * canvases of the frame before still exist, also when that frame was read back before this one was drawn. So frames
 * are made one at a time, whoever asks for them and however many are asked for at once. What the library keeps of the
 * paths of the frames before is another matter: see `RenderOptions.alone`.
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

/** Whether `frameRaw` or `framePng` has drawn a frame of this process on the GPU. */
let drewOnGpu = false;

/** Before a frame drawn `alone` on the GPU after another: lets the GPU rest from the frames before for `GPU_FORGETS_MS`. */
async function restFromEarlierFrames(opts: RenderOptions): Promise<void> {
  if (opts.alone && opts.gpu && drewOnGpu) await new Promise((done) => setTimeout(done, GPU_FORGETS_MS));
}

/**
 * One frame as raw RGBA bytes (width * height * 4). With `alone`, the GPU has rested from earlier frames.
 */
export function frameRaw(c: CompiledShot, bake: Bake, frame: number, opts: RenderOptions): Promise<Buffer> {
  return oneFrameAtATime(async () => {
    await restFromEarlierFrames(opts);
    return drawnAndRead(c, bake, frame, opts, (drawn) => readRaw(drawn, opts.gpu));
  });
}

/** One frame as PNG bytes, with `alone` as for `frameRaw`. */
export function framePng(c: CompiledShot, bake: Bake, frame: number, opts: RenderOptions): Promise<Buffer> {
  return oneFrameAtATime(async () => {
    await restFromEarlierFrames(opts);
    return drawnAndRead(c, bake, frame, opts, (drawn) => drawn.canvas.toBuffer('png', { msaa: opts.gpu ? GPU_MSAA : false }));
  });
}

/** Which renderer skia-canvas actually uses for the given preference. */
export function rendererInfo(gpu: boolean): { renderer: string; api: string | null; device: string } {
  const probe = new Canvas(8, 8, { gpu });
  const e = probe.engine;
  probe.dispose();
  return { renderer: e.renderer, api: e.api, device: e.device };
}
