// The sound sheet: one picture that shows which event each sound of a track
// belongs to. An author who cannot hear the track sees it instead: a tile per
// sound, with the frame at which it starts, the node it comes from ringed
// where it is at that frame, and the sound, the kind of event and the time
// written on it. A shower is one tile, at its first start, with its count and
// its length, and a dashed ring.

import { Canvas, ImageData } from 'skia-canvas';
import type { Bake } from '../physics/cache.ts';
import { frameRaw, heightFor } from '../render/frame.ts';
import { sampleMotion, screenAt, type MotionSeries } from '../review/series.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { STAGE_H, STAGE_W } from '../scene/types.ts';
import { ensureFonts, fontString } from '../text/fonts.ts';
import type { EventKind } from './events.ts';
import { showersOf, type SoundPlan, type Voice } from './plan.ts';

/** One tile of the sheet: a sound of the track, or a shower. */
export interface SoundTile {
  /** The frame the tile shows: where the sound starts; for a shower, where its first sound starts. */
  readonly frame: number;
  readonly time: number;
  /** The event of the sound (for a shower: of its first sound), the node it comes from, and its kind. */
  readonly id: string;
  readonly node: string | null;
  readonly kind: EventKind;
  /** A contact: the other body. */
  readonly other?: string;
  /** Key of the sound in the bank. */
  readonly sound: string;
  /** Where the event is on screen, and how large, in px of a 1080p frame. */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  /** A shower: how many starts it has, and the seconds from its first start to the end of its last sound. */
  readonly shower?: { readonly starts: number; readonly seconds: number };
}

/** The tiles of a plan, in order of time: one for every accent, one for every shower. */
export function soundTiles(plan: SoundPlan): SoundTile[] {
  const tile = (v: Voice): SoundTile => ({
    frame: v.frame,
    time: v.time,
    id: v.event.id,
    node: v.event.node,
    kind: v.event.kind,
    ...(v.event.other === undefined ? {} : { other: v.event.other }),
    sound: v.key,
    x: v.event.x,
    y: v.event.y,
    size: v.event.size,
  });
  const tiles = plan.voices.filter((v) => !v.apart).map(tile);
  for (const s of showersOf(plan.voices)) tiles.push({ ...tile(s.voices[0]!), shower: { starts: s.voices.length, seconds: s.seconds } });
  return tiles.sort((a, b) => a.frame - b.frame);
}

/**
 * The lines written on a tile: when and which sound; which event of which node
 * (for a contact: on which other body); and for a shower its count and length.
 */
export function tileCaption(t: SoundTile): string[] {
  const from = t.node ?? 'placed by hand';
  const lines = [`${t.time.toFixed(2)} s  f${t.frame}  ${t.sound}`, `${t.kind}  ${from}${t.other === undefined ? '' : ` on ${t.other}`}`];
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

/** Colour of the rings and of the writing. */
export const SHEET_INK = '#FFE14D';

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
    // The ring around the node, dark under bright so that it shows on any picture; dashed for a shower.
    const ring = tileRing(c, series, t);
    if (ring) {
      for (const [color, width] of [
        ['rgba(0,0,0,0.75)', 5],
        [SHEET_INK, 2.5],
      ] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash(t.shower ? [9, 6] : []);
        ctx.beginPath();
        ctx.arc(ox + ring.x * k, oy + ring.y * k, ring.radius * k + 6, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    // The caption: when, which sound, which event of which node.
    const lines = tileCaption(t);
    ctx.font = fontString(size, 700);
    ctx.textBaseline = 'top';
    const width = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const height = size * 1.35 * lines.length + size * 0.3;
    ctx.fillStyle = 'rgba(0,0,0,0.68)';
    ctx.fillRect(ox, oy + tileH - height, Math.min(tileW, width + size * 0.8), height);
    ctx.fillStyle = SHEET_INK;
    lines.forEach((line, n) => ctx.fillText(line, ox + size * 0.4, oy + tileH - height + size * 0.2 + n * size * 1.35));
    ctx.restore();
  }
  try {
    return { png: await sheet.toBuffer('png'), tiles, more: all.length - tiles.length };
  } finally {
    sheet.dispose();
  }
}
