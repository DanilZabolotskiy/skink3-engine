// Ghost trail: one picture in which time is visible. The chosen nodes are drawn
// at every k-th frame over a dimmed frame of the scene, faint for the early
// frames and solid for the late ones. The spacing of the ghosts is the
// reading: even spacing is constant speed, ghosts that bunch up at the ends of
// a move are ease, a gap is a jump.
//
// By default the camera is frozen at the last frame of the window ("stage"
// space), so the spacing shows what the node itself does. In "screen" space
// every ghost is where it is on screen at its own frame, camera included.

import { Canvas, ImageData, type CanvasRenderingContext2D } from 'skia-canvas';
import { FPS } from '../core/time.ts';
import type { Bake } from '../physics/cache.ts';
import { PARTICLE_STRIDE } from '../physics/cache.ts';
import { drawEye, drawLabel, drawParticles, drawShape, makePaint } from '../render/draw.ts';
import { frameRaw, heightFor } from '../render/frame.ts';
import type { CNode, CompiledShot } from '../scene/compile.ts';
import { evaluate, flatItems, type LeafItem } from '../scene/evaluate.ts';
import { STAGE_H, STAGE_W } from '../scene/types.ts';
import { ensureFonts, fontString } from '../text/fonts.ts';
import { DRAWN, type MotionSeries, type PlacedSeries } from './series.ts';
import { T } from './thresholds.ts';

export interface TrailOptions {
  /** Ids of shapes, groups, eyes, labels or emitters. */
  readonly nodes: readonly string[];
  /** First and last frame of the window. Default: the frames in which the nodes move. */
  readonly from?: number;
  readonly to?: number;
  /** A ghost every k-th frame. Default: about 40 ghosts over the window. */
  readonly every?: number;
  /** 'stage': camera frozen at the last frame (default). 'screen': as seen, camera included. */
  readonly space?: 'stage' | 'screen';
  readonly lang?: string;
  readonly gpu?: boolean;
  /** Widest the picture may get, in px; default 1920. */
  readonly maxWidth?: number;
}

export interface TrailResult {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  readonly from: number;
  readonly to: number;
  readonly every: number;
  readonly ghosts: number;
  readonly space: 'stage' | 'screen';
}

/** Most ghosts one picture holds; `every` is raised to stay under it. */
const MAX_GHOSTS = 120;
/** Marker colours of the nodes, in order (blue, orange, aqua, yellow, magenta, green). */
const MARKS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c'];
const STAMP_INK = '#FFE14D';

interface View {
  readonly zoom: number;
  readonly tx: number;
  readonly ty: number;
}

/** The frames in which the nodes move while they are drawn, with a little air; the whole shot if they never do. */
export function activeWindow(series: MotionSeries, nodes: readonly CNode[]): [number, number] {
  const F = series.frames;
  let first = F;
  let last = -1;
  for (const n of nodes) {
    const s = series.placed[n.index];
    if (s) {
      const zoom = series.views[n.layer]!.zoom;
      for (let f = 1; f < F; f++) {
        if ((s.flags[f]! & DRAWN) === 0) continue;
        const k = zoom[f]!;
        const moved =
          Math.hypot(s.x[f]! - s.x[f - 1]!, s.y[f]! - s.y[f - 1]!) * k > T.restPx ||
          Math.abs(s.scale[f]! - s.scale[f - 1]!) * s.radius * k > T.restPx ||
          Math.abs(s.rot[f]! - s.rot[f - 1]!) * (Math.PI / 180) * s.turnRadius * s.scale[f]! * k > T.restPx;
        if (!moved) continue;
        first = Math.min(first, f - 1);
        last = Math.max(last, f);
      }
    } else if (n.emitterSlot >= 0) {
      const e = series.emitters[n.emitterSlot];
      if (!e) continue;
      for (let f = 0; f < F; f++) {
        if (e.count[f]! === 0) continue;
        first = Math.min(first, f);
        last = Math.max(last, f);
      }
      // A stream is the same all along: a second of it shows its spacing.
      if (last - first > FPS) last = first + FPS;
    }
  }
  if (last < 0) return [0, F - 1];
  return [Math.max(0, first - 8), Math.min(F - 1, last + 8)];
}

function stamp(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number): void {
  ctx.font = fontString(size, 700);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0,0,0,0.66)';
  ctx.fillRect(x, y, w + size * 0.8, size * 1.5);
  ctx.fillStyle = STAMP_INK;
  ctx.fillText(text, x + size * 0.4, y + size * 0.22);
}

/** Draws the ghost trail of the given nodes. */
export async function renderTrail(c: CompiledShot, bake: Bake, series: MotionSeries, opts: TrailOptions): Promise<TrailResult> {
  if (opts.nodes.length === 0) throw new Error('trail: name at least one node');
  const nodes = opts.nodes.map((id) => {
    const n = c.byId.get(id);
    if (!n) throw new Error(`trail: there is no node "${id}"`);
    if (n.node.type === 'link') throw new Error(`trail: "${id}" is a link; a trail shows shapes, groups, eyes, labels and emitters`);
    return n;
  });
  const space = opts.space ?? 'stage';
  const lang = opts.lang ?? series.lang;
  const F = series.frames;
  const auto = activeWindow(series, nodes);
  const from = Math.max(0, Math.min(F - 1, opts.from ?? auto[0]));
  const to = Math.max(from, Math.min(F - 1, opts.to ?? auto[1]));
  let every = Math.max(1, Math.round(opts.every ?? Math.ceil((to - from + 1) / 40)));
  while ((to - from) / every + 1 > MAX_GHOSTS) every++;
  const frames: number[] = [];
  for (let f = from; f <= to; f += every) frames.push(f);
  if (frames[frames.length - 1] !== to) frames.push(to);
  const ref = to;

  const viewOf = (layer: number, f: number): View => {
    const v = series.views[layer]!;
    const g = space === 'stage' ? ref : f;
    return { zoom: v.zoom[g]!, tx: v.tx[g]!, ty: v.ty[g]! };
  };

  // What to draw for each ghost, and where it reaches.
  interface Ghost {
    readonly frame: number;
    readonly node: number;
    readonly items: LeafItem[];
    readonly view: View;
    readonly alpha: number;
    /** Centre and radius in the picture's units; null for an emitter. */
    readonly at: readonly [number, number, number] | null;
  }
  const ghosts: Ghost[] = [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (x: number, y: number, r: number): void => {
    x0 = Math.min(x0, x - r);
    y0 = Math.min(y0, y - r);
    x1 = Math.max(x1, x + r);
    y1 = Math.max(y1, y + r);
  };
  for (const f of frames) {
    const state = evaluate(c, bake, f, lang);
    nodes.forEach((n, ni) => {
      const leaves = flatItems(state.layers[n.layer]!.items);
      const items = leaves.filter((item) => item.node.index >= n.index && item.node.index <= n.subtreeEnd);
      if (items.length === 0) return;
      const view = viewOf(n.layer, f);
      const s: PlacedSeries | null = series.placed[n.index] ?? null;
      let at: Ghost['at'] = null;
      let alpha = 1;
      if (s) {
        at = [s.x[f]! * view.zoom + view.tx, s.y[f]! * view.zoom + view.ty, s.radius * s.scale[f]! * view.zoom];
        grow(at[0], at[1], at[2]);
        alpha = s.alpha[f]!;
      } else {
        // Particles: only those near the frame set the picture's extent.
        for (const item of items) {
          if (item.kind !== 'particles') continue;
          for (let i = 0; i < item.data.length; i += PARTICLE_STRIDE) {
            const px = item.data[i]! * view.zoom + view.tx;
            const py = item.data[i + 1]! * view.zoom + view.ty;
            if (px < -60 || py < -60 || px > STAGE_W + 60 || py > STAGE_H + 60) continue;
            grow(px, py, item.data[i + 2]! * view.zoom);
          }
        }
      }
      ghosts.push({ frame: f, node: ni, items, view, alpha, at });
    });
  }
  if (ghosts.length === 0 || x1 < x0) {
    throw new Error(`trail: ${opts.nodes.join(', ')} ${opts.nodes.length > 1 ? 'are' : 'is'} not drawn between frames ${from} and ${to}`);
  }

  // Frame the picture on the path, with a margin, and never thinner than a strip.
  const margin = Math.max(48, 0.12 * Math.max(x1 - x0, y1 - y0));
  x0 -= margin;
  y0 -= margin;
  x1 += margin;
  y1 += margin;
  const minW = 360;
  const minH = 220;
  if (x1 - x0 < minW) {
    const mid = (x0 + x1) / 2;
    x0 = mid - minW / 2;
    x1 = mid + minW / 2;
  }
  if (y1 - y0 < minH) {
    const mid = (y0 + y1) / 2;
    y0 = mid - minH / 2;
    y1 = mid + minH / 2;
  }
  if (x1 - x0 > 5 * (y1 - y0)) {
    const mid = (y0 + y1) / 2;
    const h = (x1 - x0) / 5;
    y0 = mid - h / 2;
    y1 = mid + h / 2;
  }
  if (y1 - y0 > 2 * (x1 - x0)) {
    const mid = (x0 + x1) / 2;
    const w = (y1 - y0) / 2;
    x0 = mid - w / 2;
    x1 = mid + w / 2;
  }
  const maxWidth = opts.maxWidth ?? 1920;
  const k = Math.min(maxWidth / (x1 - x0), 1200 / (y1 - y0), 4);
  const W = Math.max(2, Math.round((x1 - x0) * k));
  const H = Math.max(2, Math.round((y1 - y0) * k));

  const scratch: Canvas[] = [];
  const out = new Canvas(W, H, { gpu: false });
  scratch.push(out);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ensureFonts();

  // 1. The scene at the last frame of the window, dimmed. Outside the frame there is nothing.
  ctx.fillStyle = '#07070c';
  ctx.fillRect(0, 0, W, H);
  const renderW = Math.min(STAGE_W * 2, Math.max(960, Math.ceil((STAGE_W * k) / 2) * 2));
  const renderH = heightFor(renderW);
  const rk = renderW / STAGE_W;
  const raw = await frameRaw(c, bake, ref, { width: renderW, lang, gpu: opts.gpu ?? true });
  const ix0 = Math.max(0, x0);
  const iy0 = Math.max(0, y0);
  const ix1 = Math.min(STAGE_W, x1);
  const iy1 = Math.min(STAGE_H, y1);
  if (ix1 > ix0 && iy1 > iy0) {
    ctx.drawImage(new ImageData(raw, renderW, renderH), ix0 * rk, iy0 * rk, (ix1 - ix0) * rk, (iy1 - iy0) * rk, (ix0 - x0) * k, (iy0 - y0) * k, (ix1 - ix0) * k, (iy1 - iy0) * k);
    ctx.fillStyle = 'rgba(6,6,12,0.6)';
    ctx.fillRect((ix0 - x0) * k, (iy0 - y0) * k, (ix1 - ix0) * k, (iy1 - iy0) * k);
  }
  // The edge of the frame, where the picture reaches past it.
  if (x0 < 0 || y0 < 0 || x1 > STAGE_W || y1 > STAGE_H) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect((0 - x0) * k + 0.5, (0 - y0) * k + 0.5, STAGE_W * k, STAGE_H * k);
  }

  // 2. Ghosts, early to late. Each is drawn as one picture and then faded, so
  // that its parts do not show through each other.
  const count = frames.length;
  const order = new Map(frames.map((f, i) => [f, i] as const));
  for (const g of ghosts) {
    const i = order.get(g.frame)!;
    const u = count > 1 ? i / (count - 1) : 1;
    const layer = c.layers[nodes[g.node]!.layer]!;
    const paint = makePaint(c.light, c.atmosphere, layer.tint, c.tones);
    const one = new Canvas(W, H, { gpu: false });
    scratch.push(one);
    const gx = one.getContext('2d');
    gx.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
    gx.transform(g.view.zoom, 0, 0, g.view.zoom, g.view.tx, g.view.ty);
    for (const item of g.items) {
      if (item.kind === 'shape') drawShape(gx, item, paint);
      else if (item.kind === 'eye') drawEye(gx, item, paint);
      else if (item.kind === 'label') drawLabel(gx, item, paint);
      else if (item.kind === 'particles') drawParticles(gx, item, paint);
    }
    ctx.save();
    // A faded node stays faint, but never so faint that its ghost is lost.
    ctx.globalAlpha = (0.2 + 0.8 * u * u) * Math.max(0.35, Math.min(1, g.alpha));
    ctx.drawCanvas(one, 0, 0);
    ctx.restore();
  }

  // 3. The path through the ghosts, a dot at each, and the frame number at a few.
  const size = Math.max(13, Math.round(W / 96));
  // Where numbers already stand: a number that would cover another is left out.
  const taken: [number, number, number, number][] = [[0, 0, W, size * 1.6 * (nodes.length > 1 ? nodes.length + 1 : 1)]];
  nodes.forEach((_, ni) => {
    const mine = ghosts.filter((g) => g.node === ni && g.at);
    if (mine.length === 0) return;
    const colour = MARKS[ni % MARKS.length]!;
    const pt = (g: Ghost): [number, number] => [(g.at![0] - x0) * k, (g.at![1] - y0) * k];
    // A dark line under a light one, and dots with a dark and a white ring: they read on any ghost and any background.
    ctx.lineJoin = 'round';
    for (const [style, width] of [['rgba(7,7,12,0.7)', 4], ['rgba(255,255,255,0.9)', 1.5]] as const) {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.beginPath();
      mine.forEach((g, i) => {
        const [x, y] = pt(g);
        // A node that is hidden between two ghosts leaves a break in the line.
        const joined = i > 0 && order.get(g.frame)! - order.get(mine[i - 1]!.frame)! === 1;
        if (joined) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
    for (const g of mine) {
      const [x, y] = pt(g);
      for (const [style, r] of [['#07070c', 6], ['#ffffff', 4.6], [colour, 3]] as const) {
        ctx.fillStyle = style;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // The first and the last ghost come first, so that they keep their numbers.
    const want = Math.min(mine.length, 7);
    const marks = [0, mine.length - 1];
    for (let i = 1; i < want - 1; i++) marks.push(Math.round((i * (mine.length - 1)) / Math.max(1, want - 1)));
    for (const i of new Set(marks)) {
      const g = mine[i]!;
      const [x, y] = pt(g);
      // Beside the path, on the side away from the travel, so the number does not sit on the next ghost.
      const a = pt(mine[Math.max(0, i - 1)]!);
      const b = pt(mine[Math.min(mine.length - 1, i + 1)]!);
      let nx = -(b[1] - a[1]);
      let ny = b[0] - a[0];
      const len = Math.hypot(nx, ny);
      if (len < 1e-6) {
        nx = 0;
        ny = -1;
      } else {
        nx /= len;
        ny /= len;
        if (ny > 0) {
          nx = -nx;
          ny = -ny;
        }
      }
      const text = `f${g.frame}`;
      ctx.font = fontString(size, 700);
      const tw = ctx.measureText(text).width + size * 0.8;
      const reach = Math.min(g.at![2] * k, 90) + 10;
      let sx = x + nx * reach - (nx < -0.3 ? tw : nx > 0.3 ? 0 : tw / 2);
      let sy = y + ny * reach - (ny < -0.3 ? size * 1.5 : ny > 0.3 ? 0 : size * 0.75);
      sx = Math.max(2, Math.min(W - tw - 2, sx));
      sy = Math.max(size * 1.7, Math.min(H - size * 1.5 - 2, sy));
      const th = size * 1.5;
      if (taken.some(([ax, ay, aw, ah]) => sx < ax + aw + 3 && ax < sx + tw + 3 && sy < ay + ah + 3 && ay < sy + th + 3)) continue;
      taken.push([sx, sy, tw, th]);
      ctx.strokeStyle = 'rgba(255,225,77,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(sx + tw / 2, sy + size * 0.75);
      ctx.stroke();
      stamp(ctx, text, sx, sy, size);
    }
  });

  // 4. What this picture is.
  const what =
    `trail  ${c.spec.id}  ${opts.nodes.join(', ')}  f${from}-${to} (${(from / FPS).toFixed(2)}-${(to / FPS).toFixed(2)} s)  every ${every}  ` +
    (space === 'stage' ? `stage space, camera frozen at f${ref}` : 'screen space, camera included');
  stamp(ctx, what, 0, 0, size);
  if (nodes.length > 1) {
    nodes.forEach((n, ni) => {
      const y = size * 1.6 * (ni + 1);
      stamp(ctx, `   ${n.id}`, 0, y, size);
      ctx.fillStyle = MARKS[ni % MARKS.length]!;
      ctx.beginPath();
      ctx.arc(size * 0.75, y + size * 0.75, size * 0.3, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  try {
    return { png: await out.toBuffer('png'), width: W, height: H, from, to, every, ghosts: count, space };
  } finally {
    for (const cv of scratch) cv.dispose();
  }
}
