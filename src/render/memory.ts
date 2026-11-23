import { statSync } from 'node:fs';
import { heightFor, type RenderOptions } from './frame.ts';
import type { Encoder } from './encode.ts';

export const GIB = 2 ** 30;
const MIB = 2 ** 20;

export interface RenderMemory {
  readonly ram: number;
  readonly vram: number;
}

export interface MemoryWorkload {
  readonly scene: string;
  readonly bake?: string;
  readonly width: number;
  readonly gpu: RenderOptions['gpu'];
  readonly encoder?: Encoder;
  /** Pixel count of a CPU-side review image in addition to the frame being drawn. */
  readonly sheetPixels?: number;
}

function fileBytes(file: string | undefined): number {
  if (!file) return 0;
  try {
    return statSync(file).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/** An admission estimate for the process and its encoder, in bytes. */
export function renderMemory(work: MemoryWorkload): RenderMemory {
  const frameBytes = work.width * heightFor(work.width) * 4;
  // Cache reads hold the serialized bake and a copy of its arrays. Leave room for the scene, parser and runtime.
  let ram = 512 * MIB + fileBytes(work.scene) * 8 + fileBytes(work.bake) * 3;
  let vram = 0;
  if (work.width > 0) {
    ram += frameBytes * (work.encoder ? 24 : 16) + (work.sheetPixels ?? 0) * 12;
    if (work.gpu) vram += 256 * MIB + 72 * frameBytes;
  }
  // x264 auto-sized frame threads and lookahead can hold many 4K frames at once.
  if (work.encoder === 'x264') ram += 192 * MIB + 88 * frameBytes;
  if (work.encoder === 'nvenc') {
    ram += 192 * MIB + 20 * frameBytes;
    vram += 160 * MIB + 20 * frameBytes;
  }
  return { ram, vram };
}
