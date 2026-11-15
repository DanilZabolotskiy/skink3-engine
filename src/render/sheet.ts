// Review images built from single frames: stills, motion strips and contact
// sheets. Because frames are pure, none of this needs a rendered video.

import { Canvas, ImageData } from 'skia-canvas';
import { FPS } from '../core/time.ts';
import type { Bake } from '../physics/cache.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { STAGE_H, STAGE_W } from '../scene/types.ts';
import { ensureFonts, fontString } from '../text/fonts.ts';
import { frameRaw, heightFor } from './frame.ts';

/** Raw RGBA pixels as PNG bytes: exactly the pixels a render would send to the encoder. */
export async function rawToPng(raw: Buffer, width: number, height: number): Promise<Buffer> {
  const canvas = new Canvas(width, height, { gpu: false });
  canvas.getContext('2d').putImageData(new ImageData(raw, width, height), 0, 0);
  try {
    return await canvas.toBuffer('png');
  } finally {
    canvas.dispose();
  }
}

export interface SheetTile {
  readonly frame: number;
  readonly lang: string;
}

export interface SheetOptions {
  readonly cols: number;
  /** Width of one tile in pixels. */
  readonly tileWidth: number;
  /** Part of the stage to show, in stage units from the top-left corner: [x, y, w, h]. */
  readonly crop: readonly [number, number, number, number] | null;
  readonly gpu: boolean;
  /** Write frame number, time and language on each tile. */
  readonly captions: boolean;
  /** Prefix captions with "+n" frames from the first tile (motion strips). */
  readonly relative: boolean;
}

/** A grid of frames as one image (PNG bytes). */
export async function renderSheet(c: CompiledShot, bake: Bake, tiles: readonly SheetTile[], opts: SheetOptions): Promise<Buffer> {
  if (tiles.length === 0) throw new Error('a sheet needs at least one frame');
  const crop = opts.crop ?? [0, 0, STAGE_W, STAGE_H];
  const tileW = opts.tileWidth;
  const tileH = Math.round((tileW * crop[3]) / crop[2]);
  const cols = Math.min(opts.cols, tiles.length);
  const rows = Math.ceil(tiles.length / cols);
  // Render large enough that the crop is not upscaled, and at least twice the tile for clean downscaling.
  const need = (tileW * STAGE_W) / crop[2];
  const wanted = need * 2 <= STAGE_W ? need * 2 : Math.max(need, STAGE_W);
  const renderW = Math.min(STAGE_W * 2, Math.max(480, Math.ceil(wanted / 2) * 2));
  const renderH = heightFor(renderW);
  const k = renderW / STAGE_W;

  const sheet = new Canvas(cols * tileW, rows * tileH, { gpu: false });
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ensureFonts();
  const first = tiles[0]!.frame;
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i]!;
    const raw = await frameRaw(c, bake, tile.frame, { width: renderW, lang: tile.lang, gpu: opts.gpu });
    const x = (i % cols) * tileW;
    const y = Math.floor(i / cols) * tileH;
    ctx.drawImage(new ImageData(raw, renderW, renderH), crop[0] * k, crop[1] * k, crop[2] * k, crop[3] * k, x, y, tileW, tileH);
    if (opts.captions) {
      const size = Math.max(11, Math.round(tileW / 34));
      const text = opts.relative
        ? `+${tile.frame - first}f`
        : `f${tile.frame}  ${(tile.frame / FPS).toFixed(2)}s  ${tile.lang}`;
      ctx.font = fontString(size, 700);
      ctx.textBaseline = 'top';
      const w = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x, y, w + size * 0.8, size * 1.5);
      ctx.fillStyle = '#FFE14D';
      ctx.fillText(text, x + size * 0.4, y + size * 0.22);
    }
  }
  try {
    return await sheet.toBuffer('png');
  } finally {
    sheet.dispose();
  }
}
