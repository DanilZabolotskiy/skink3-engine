// The sound sheet: one picture that shows which event each sound of a track
// belongs to. An author who cannot hear the track sees it instead: a tile per
// sound, with the frame the sound is placed on, the node it comes from ringed
// where it is at that frame, and the sound, the kind of event and the time
// written on it. A sound of a move has an arrow along the way of the move; one
// that is placed by its loudest point is shown on the frame that point lands
// on. A shower is one tile, at its first start, with its count and its length,
// and a dashed ring.

import { Canvas, ImageData } from 'skia-canvas';
import { FPS } from '../core/time.ts';
import type { Bake } from '../physics/cache.ts';
import { frameRaw, heightFor } from '../render/frame.ts';
import { sampleMotion, screenAt, type MotionSeries } from '../review/series.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { STAGE_H, STAGE_W } from '../scene/types.ts';
import { ensureFonts, fontString } from '../text/fonts.ts';
import type { SoundAnchor } from './bank.ts';
import type { EventKind } from './events.ts';
import { showersOf, type SoundPlan, type Voice } from './plan.ts';

/** One tile of the sheet: a sound of the track, or a shower. */
export interface SoundTile {
  /**
   * The frame the tile shows: the frame the sound is placed on. That is where
   * it starts, or, for a sound placed by its loudest point, where that point
   * lands: the fastest moment of the move, or its end. For a shower: where its
   * first sound starts.
   */
  readonly frame: number;
  readonly time: number;
  /** The event of the sound (for a shower: of its first sound), the node it comes from, and its kind. */
  readonly id: string;
  readonly node: string | null;
  readonly kind: EventKind;
  /** A contact: the other body. */
  readonly other?: string;
  /** Key of the sound in the bank, and the moment of its event it is placed on. */
  readonly sound: string;
  readonly anchor: SoundAnchor;
  /** Where the event is on screen, and how large, in px of a 1080p frame. */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  /** A move: when it starts and when it ends, in seconds, and where the node is on screen on every frame between. */
  readonly move?: { readonly from: number; readonly to: number; readonly track: readonly (readonly [number, number])[] };
  /** A shower: how many starts it has, and the seconds from its first start to the end of its last sound. */
  readonly shower?: { readonly starts: number; readonly seconds: number };
}

/** The tiles of a plan, in order of time: one for every accent, one for every shower. */
export function soundTiles(plan: SoundPlan): SoundTile[] {
  const tile = (v: Voice): SoundTile => {
    const track = v.event.track;
    return {
      frame: v.frame,
      time: v.frame / FPS,
      id: v.event.id,
      node: v.event.node,
      kind: v.event.kind,
      ...(v.event.other === undefined ? {} : { other: v.event.other }),
      sound: v.key,
      anchor: v.anchor,
      x: v.event.x,
      y: v.event.y,
      size: v.event.size,
      ...(track && track.length > 1 ? { move: { from: v.event.time, to: v.event.time + (track.length - 1) / FPS, track } } : {}),
    };
  };
  const tiles = plan.voices.filter((v) => !v.apart).map(tile);
  for (const s of showersOf(plan.voices)) tiles.push({ ...tile(s.voices[0]!), shower: { starts: s.voices.length, seconds: s.seconds } });
  return tiles.sort((a, b) => a.frame - b.frame);
}

/**
 * The lines written on a tile: when and which sound; which event of which node
 * (for a contact: on which other body); for a sound placed by its loudest
 * point, on what; and for a shower its count and length.
 */
export function tileCaption(t: SoundTile): string[] {
  const from = t.node ?? 'placed by hand';
  const lines = [`${t.time.toFixed(2)} s  f${t.frame}  ${t.sound}`, `${t.kind}  ${from}${t.other === undefined ? '' : ` on ${t.other}`}`];
  if (t.anchor !== 'start') lines.push(`loudest on the ${t.anchor}${t.move ? ` of ${t.move.from.toFixed(2)}-${t.move.to.toFixed(2)} s` : ''}`);
  if (t.shower) lines.push(`shower: ${t.shower.starts} start${t.shower.starts === 1 ? '' : 's'} in ${t.shower.seconds.toFixed(1)} s`);
  return lines;
}

/** Radius of the ring around what has no size of its own: the end of a link, the place of a burst. */
const POINT_RADIUS = 20;

/**
 * The ring of a tile, in px of a 1080p frame: around the node where it is at
 * that frame, as large as the node is during the event. A link and an emitter
 * have no place of their own: their ring is small, where the event is. A sound
 * placed by hand without a node has no ring.
 */
export function tileRing(c: CompiledShot, series: MotionSeries, t: SoundTile): { x: number; y: number; radius: number } | null {
  if (t.node === null) return null;
  const n = c.byId.get(t.node);
  const s = n ? series.placed[n.index] : null;
  if (!s) return { x: t.x, y: t.y, radius: POINT_RADIUS };
  const [x, y] = screenAt(series, s, t.frame);
  const now = s.radius * s.scale[t.frame]! * series.views[s.node.layer]!.zoom[t.frame]!;
  return { x, y, radius: Math.max(12, Math.min(0.45 * STAGE_H, Math.max(now, t.size / 2))) };
}

/** A way shorter than this on screen, in px, gets no arrow: the ring says all there is. */
const SHORTEST_ARROW = 40;

/**
 * The arrow of a tile, in px of a 1080p frame: the way of the move from its
 * first frame to its last, which is where the head of the arrow is. Null for
 * a sound that is not of a move, and for a move that hardly goes anywhere.
 */
export function tileArrow(t: SoundTile): readonly (readonly [number, number])[] | null {
  if (!t.move) return null;
  const track = t.move.track;
  let length = 0;
  for (let i = 1; i < track.length; i++) length += Math.hypot(track[i]![0] - track[i - 1]![0], track[i]![1] - track[i - 1]![1]);
  return length < SHORTEST_ARROW ? null : track;
}

export interface SoundSheetOptions {
  /** Tiles in a row; default 4. */
  readonly cols?: number;
  /** Width of a tile in px; default 480. */
  readonly tileWidth?: number;
  /** Most tiles on the sheet; default 60. The first ones in time are drawn. */
  readonly most?: number;
  readonly lang: string;
  readonly gpu: boolean;
  /** The motion series of the shot, when the caller has sampled it already. */
  readonly series?: MotionSeries;
}

/** Colour of the rings, the arrows and the writing. */
export const SHEET_INK = '#FFE14D';

/** Dark under bright, so that a mark shows on any picture: the colour and the width of each of the two strokes. */
const STROKES = [
  ['rgba(0,0,0,0.75)', 5],
  [SHEET_INK, 2.5],
] as const;

/** Length of the two strokes of the head of an arrow, in px of the sheet, and the angle each makes with the way. */
const HEAD = 11;
const HEAD_ANGLE = (28 * Math.PI) / 180;

/**
 * Draws the sound sheet of a plan. Returns the picture as PNG bytes, the tiles
 * that are on it, and how many more the plan has than the sheet holds.
 */
export async function renderSoundSheet(c: CompiledShot, bake: Bake, plan: SoundPlan, opts: SoundSheetOptions): Promise<{ png: Buffer; tiles: SoundTile[]; more: number }> {
  const all = soundTiles(plan);
  if (all.length === 0) throw new Error('a sound sheet needs at least one sound: this track is silent');
  const tiles = all.slice(0, opts.most ?? 60);
  const series = opts.series ?? sampleMotion(c, bake, { lang: opts.lang, particles: false });
  const tileW = opts.tileWidth ?? 480;
  const tileH = Math.round((tileW * STAGE_H) / STAGE_W);
  const cols = Math.min(opts.cols ?? 4, tiles.length);
  const rows = Math.ceil(tiles.length / cols);
  // Rendered at twice the tile, so that the frame is scaled down cleanly.
  const renderW = Math.min(STAGE_W * 2, Math.max(480, Math.ceil(tileW) * 2));
  const renderH = heightFor(renderW);
  const k = tileW / STAGE_W;

  const sheet = new Canvas(cols * tileW, rows * tileH, { gpu: false });
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ensureFonts();
  const size = Math.max(11, Math.round(tileW / 34));
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i]!;
    const raw = await frameRaw(c, bake, t.frame, { width: renderW, lang: opts.lang, gpu: opts.gpu });
    const ox = (i % cols) * tileW;
    const oy = Math.floor(i / cols) * tileH;
    ctx.drawImage(new ImageData(raw, renderW, renderH), 0, 0, renderW, renderH, ox, oy, tileW, tileH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, tileW, tileH);
    ctx.clip();
    // The arrow of a move: its way from its first frame to its last, with a head where it ends.
    const way = tileArrow(t);
    if (way) {
      const at = (p: readonly [number, number]): [number, number] => [ox + p[0] * k, oy + p[1] * k];
      const [hx, hy] = at(way[way.length - 1]!);
      // The head points the way the move arrives: from the last place that is far enough back to give a direction.
      let back = at(way[0]!);
      for (let j = way.length - 2; j >= 0; j--) {
        const p = at(way[j]!);
        if (Math.hypot(hx - p[0], hy - p[1]) >= HEAD) {
          back = p;
          break;
        }
      }
      const heading = Math.atan2(hy - back[1], hx - back[0]);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const [color, width] of STROKES) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        way.forEach((p, j) => (j === 0 ? ctx.moveTo(...at(p)) : ctx.lineTo(...at(p))));
        for (const side of [-1, 1]) {
          ctx.moveTo(hx, hy);
          ctx.lineTo(hx - HEAD * Math.cos(heading + side * HEAD_ANGLE), hy - HEAD * Math.sin(heading + side * HEAD_ANGLE));
        }
        ctx.stroke();
      }
    }
    // The ring around the node; dashed for a shower.
    const ring = tileRing(c, series, t);
    if (ring) {
      for (const [color, width] of STROKES) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash(t.shower ? [9, 6] : []);
        ctx.beginPath();
        ctx.arc(ox + ring.x * k, oy + ring.y * k, ring.radius * k + 6, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    // The caption: when, which sound, which event of which node. In the bottom-left corner; in the top-left one when the ring is there.
    const lines = tileCaption(t);
    ctx.font = fontString(size, 700);
    ctx.textBaseline = 'top';
    const width = Math.min(tileW, Math.max(...lines.map((line) => ctx.measureText(line).width)) + size * 0.8);
    const height = size * 1.35 * lines.length + size * 0.3;
    const inTheWay = ring !== null && ring.x * k - (ring.radius * k + 6) < width && ring.y * k + ring.radius * k + 6 > tileH - height;
    const top = inTheWay ? oy : oy + tileH - height;
    ctx.fillStyle = 'rgba(0,0,0,0.68)';
    ctx.fillRect(ox, top, width, height);
    ctx.fillStyle = SHEET_INK;
    lines.forEach((line, n) => ctx.fillText(line, ox + size * 0.4, top + size * 0.2 + n * size * 1.35));
    ctx.restore();
  }
  try {
    return { png: await sheet.toBuffer('png'), tiles, more: all.length - tiles.length };
  } finally {
    sheet.dispose();
  }
}
