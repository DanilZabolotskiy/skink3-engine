// Parallel rendering: the frame range is split into contiguous chunks, each
// rendered by its own process into its own encoder, and the chunks are joined.
// Frames are pure, so the split changes nothing about the pixels. A worker on
// the GPU takes a render slot of the machine before it draws (queue.ts), and a
// render keeps no more workers alive than there are slots.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bake } from '../physics/cache.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { concatChunks, openEncoder, type Encoder } from './encode.ts';
import { drawFrame, heightFor, readRaw, type DrawnFrame } from './frame.ts';
import { queueConfig, renderPriority, waitForGpu, type Priority, type Waiting } from './queue.ts';

export interface RenderJob {
  /** Absolute path of the scene module. */
  readonly scene: string;
  /** Absolute path of the bake cache file. */
  readonly bakeFile: string;
  /** First frame, and one past the last frame. */
  readonly from: number;
  readonly to: number;
  /** Absolute path of the video to write. */
  readonly out: string;
  readonly lang: string;
  readonly width: number;
  readonly gpu: boolean;
  readonly encoder: Encoder;
  readonly workers: number;
  /** Also write "<out>.hashes.txt": one "frame sha256" line per frame of raw RGBA. */
  readonly hashes: boolean;
  /** Called now and then with the number of frames finished so far. */
  readonly onProgress?: (done: number, total: number, seconds: number) => void;
  /** The most frames of a chunk, after which a worker gives its render slot back; 0: one chunk per worker. Default: `chunkFrames(width)`. */
  readonly chunk?: number;
  /** The priority of the workers in the render queue. Default: `renderPriority(width)`, low above the width of a preview. */
  readonly priority?: Priority;
  /** Called once, when a worker has to wait for a render slot. */
  readonly onWait?: (waiting: Waiting) => void;
}

/** The pixels of the longest chunk: 900 frames at 1920 x 1080, 225 at 3840 x 2160. */
export const CHUNK_PIXELS = 900 * 1920 * 1080;

/** The most frames of a chunk at a width: as many pixels at any width, so that a slot is held about as long. */
export function chunkFrames(width: number): number {
  return Math.max(1, Math.round(CHUNK_PIXELS / (width * heightFor(width))));
}

export interface RenderPlan {
  /** The workers asked for, at most one a frame. */
  readonly workers: number;
  /** The workers alive at once: as many as asked for, or as many as the render queue has slots, if fewer. */
  readonly atOnce: number;
  /** Contiguous ranges of frames (from, one past the last), in order; each is drawn by a process of its own. */
  readonly chunks: readonly { readonly from: number; readonly to: number }[];
}

/**
 * How a render is split. With a chunk length, into a multiple of the workers that draw at once, each chunk of at most
 * that many frames, so that a render alone keeps every slot busy to its end and none is held for long; with 0, into
 * one chunk per worker. The split changes no frame: a frame is the same in any chunk and alone. It decides only which
 * process draws which frames, and where the encoded file has its key frames (each chunk starts with one).
 */
export function renderPlan(from: number, to: number, workers: number, opts: { readonly slots: number; readonly chunk: number }): RenderPlan {
  const total = to - from;
  if (total <= 0) throw new Error('nothing to render: the frame range is empty');
  const asked = Math.max(1, Math.min(workers, total));
  const atOnce = opts.slots > 0 ? Math.min(asked, opts.slots) : asked;
  const count = opts.chunk > 0 ? Math.min(total, atOnce * Math.ceil(Math.ceil(total / opts.chunk) / atOnce)) : asked;
  const chunks = Array.from({ length: count }, (_, i) => ({ from: from + Math.floor((total * i) / count), to: from + Math.floor((total * (i + 1)) / count) }));
  return { workers: asked, atOnce, chunks };
}

/** The plan of a job as `renderParallel` makes it: the render queue counts only on the GPU. */
export function planOf(job: Pick<RenderJob, 'from' | 'to' | 'workers' | 'width' | 'gpu' | 'chunk'>): RenderPlan {
  return renderPlan(job.from, job.to, job.workers, { slots: job.gpu ? queueConfig().slots : 0, chunk: job.chunk ?? chunkFrames(job.width) });
}

export interface RenderResult {
  readonly frames: number;
  readonly seconds: number;
  readonly fps: number;
  readonly out: string;
  readonly hashesFile: string | null;
}

const CLI_ENTRY = fileURLToPath(new URL('../../bin/skink3.mjs', import.meta.url));

/** A worker tells its parent how far it is after this many frames. */
const REPORT_EVERY = 5;

/** A frame whose pixels are being read back, and the canvases it was drawn on. */
interface Reading {
  readonly frame: number;
  readonly drawn: DrawnFrame;
  readonly raw: Promise<Buffer>;
}

/** Renders one contiguous range of frames into one video file (used by each worker). */
export async function renderChunk(
  c: CompiledShot,
  bake: Bake,
  opts: {
    from: number;
    to: number;
    out: string;
    lang: string;
    width: number;
    gpu: boolean;
    encoder: Encoder;
    hashesFile: string | null;
    /** Called with the number of frames written since the previous call. */
    onFrames?: (count: number) => void;
    /** Fault injection for the tests: fail when this frame is reached. */
    failAtFrame?: number;
  },
): Promise<void> {
  // A render slot of the machine first, if the process holds one for its frames on the GPU (the command line does).
  if (opts.gpu) await waitForGpu();
  const height = heightFor(opts.width);
  const sink = openEncoder(opts.out, opts.width, height, opts.encoder);
  const lines: string[] = [];
  let unreported = 0;
  const ropts = { width: opts.width, lang: opts.lang, gpu: opts.gpu };
  // The frame whose pixels are being read back, and the frame recorded meanwhile.
  let reading: Reading | null = null;
  let recorded: DrawnFrame | null = null;
  /** Starts reading back a recorded frame. Its failure is reported when it is awaited, in turn. */
  const start = (frame: number, drawn: DrawnFrame): Reading => {
    const raw = readRaw(drawn, opts.gpu);
    raw.catch(() => undefined);
    return { frame, drawn, raw };
  };
  /** The pixels of a frame being read back; its canvases are freed as soon as they are in. */
  const finish = async (r: Reading): Promise<Buffer> => {
    try {
      return await r.raw;
    } finally {
      r.drawn.dispose();
    }
  };
  const put = async (frame: number, raw: Buffer): Promise<void> => {
    if (raw.length !== opts.width * height * 4) throw new Error(`frame ${frame}: unexpected raw size ${raw.length}`);
    if (opts.hashesFile) lines.push(`${frame} ${createHash('sha256').update(raw).digest('hex')}`);
    await sink.write(raw);
    if (++unreported >= REPORT_EVERY) {
      opts.onFrames?.(unreported);
      unreported = 0;
    }
  };
  try {
    // A frame is recorded while the one before is read back. It is read back itself only once the canvases of the one
    // before are freed, and the one before is then hashed and handed to the encoder. On the GPU a frame read back while
    // the canvases of another frame are alive can have other pixels, so that a frame would depend on its place in the
    // chunk; a frame that is only recorded holds nothing there and changes nothing of the frame being read back.
    for (let f = opts.from; f < opts.to; f++) {
      if (f === opts.failAtFrame) throw new Error(`injected failure at frame ${f}`);
      recorded = drawFrame(c, bake, f, ropts);
      const before = reading;
      reading = null;
      const raw = before ? await finish(before) : null;
      reading = start(f, recorded);
      recorded = null;
      if (before && raw) await put(before.frame, raw);
    }
    if (reading) {
      const last: Reading = reading;
      reading = null;
      await put(last.frame, await finish(last));
    }
    await sink.close();
  } catch (error) {
    // Do not leave an encoder behind that waits for frames that will never come.
    sink.abort();
    const left = reading as Reading | null;
    if (left) await finish(left).catch(() => undefined);
    (recorded as DrawnFrame | null)?.dispose();
    throw error;
  }
  if (unreported > 0) opts.onFrames?.(unreported);
  if (opts.hashesFile) writeFileSync(opts.hashesFile, lines.join('\n') + '\n');
}

/**
 * Splits a job into chunks (`renderPlan`), draws them in worker processes, as
 * many at once as the plan allows, and joins them. On the GPU each worker waits
 * for a render slot of the machine before it draws. If one worker fails, the
 * others are stopped at once, no chunk is started any more, the partial files
 * are removed, and the error names the frame range of the worker that failed.
 */
export async function renderParallel(job: RenderJob): Promise<RenderResult> {
  const total = job.to - job.from;
  if (total <= 0) throw new Error('nothing to render: the frame range is empty');
  const plan = planOf(job);
  const priority = job.priority ?? renderPriority(job.width);
  const dir = dirname(job.out);
  mkdirSync(dir, { recursive: true });
  const stem = basename(job.out).replace(/\.[^.]+$/, '');
  const t0 = performance.now();

  const chunks = plan.chunks.map((ch, i) => {
    const tag = `${stem}.chunk${String(i).padStart(3, '0')}`;
    return { file: join(dir, `${tag}.mp4`), hashes: job.hashes ? join(dir, `${tag}.hashes.txt`) : null, from: ch.from, to: ch.to };
  });
  const remove = (file: string): void => {
    try {
      // Retries: a stopped worker's encoder may hold its file for a moment longer.
      rmSync(file, { force: true, recursive: true, maxRetries: 30, retryDelay: 100 });
    } catch {
      // A leftover part must not hide the reason the render stopped.
    }
  };
  const removeParts = (): void => {
    for (const ch of chunks) {
      remove(ch.file);
      if (ch.hashes) remove(ch.hashes);
    }
    remove(join(dir, `${basename(job.out)}.chunks.txt`));
  };

  const children: ChildProcess[] = [];
  let done = 0;
  let failure: Error | null = null;
  let toldWaiting = false;
  await new Promise<void>((resolve) => {
    let next = 0;
    let running = 0;
    /** Starts chunks while the plan allows more workers at once; resolves when none runs and none is left to start. */
    const startMore = (): void => {
      while (!failure && running < plan.atOnce && next < chunks.length) start(chunks[next++]!);
      if (running === 0) resolve();
    };
    const fail = (error: Error): void => {
      if (failure) return;
      failure = error;
      // One chunk is lost, so the whole render is: stop the others now.
      for (const child of children) if (child.exitCode === null) child.kill();
    };
    const start = (chunk: (typeof chunks)[number]): void => {
      running++;
      const args = [
        CLI_ENTRY, '_chunk', job.scene,
        '--bake', job.bakeFile,
        '--from', String(chunk.from), '--to', String(chunk.to),
        '--out', chunk.file, '--lang', job.lang, '--width', String(job.width), '--encoder', job.encoder,
        '--priority', priority,
      ];
      if (!job.gpu) args.push('--cpu');
      if (chunk.hashes) args.push('--hashes-file', chunk.hashes);
      const child = spawn(process.execPath, args, {
        // The fourth channel carries progress messages from the worker.
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        // Each worker rasterises one frame at a time; a large thread pool per process only adds contention.
        env: { ...process.env, SKIA_CANVAS_THREADS: process.env['SKIA_CANVAS_THREADS'] ?? '2' },
      });
      children.push(child);
      const range = `frames ${chunk.from}..${chunk.to - 1}`;
      let ended = false;
      const end = (): void => {
        if (ended) return;
        ended = true;
        running--;
        startMore();
      };
      child.on('message', (message: unknown) => {
        const m = message as { frames?: unknown; waiting?: Waiting } | null;
        if (m?.waiting && !toldWaiting) {
          toldWaiting = true;
          job.onWait?.(m.waiting);
        }
        if (typeof m?.frames !== 'number') return;
        done += m.frames;
        job.onProgress?.(done, total, (performance.now() - t0) / 1000);
      });
      child.on('error', (e) => {
        fail(new Error(`the render worker for ${range} could not start: ${e.message}`));
        end();
      });
      child.on('close', (code, signal) => {
        if (code !== 0) {
          fail(new Error(`the render worker for ${range} failed (${signal ? `signal ${signal}` : `exit code ${code}`}); the other workers were stopped and nothing was written`));
        }
        end();
      });
    };
    startMore();
  });

  if (failure) {
    removeParts();
    throw failure;
  }

  rmSync(job.out, { force: true });
  concatChunks(chunks.map((ch) => ch.file), job.out);
  let hashesFile: string | null = null;
  if (job.hashes) {
    hashesFile = `${job.out}.hashes.txt`;
    writeFileSync(hashesFile, chunks.map((ch) => readFileSync(ch.hashes!, 'utf8')).join(''));
  }
  removeParts();

  const seconds = (performance.now() - t0) / 1000;
  return { frames: total, seconds, fps: total / seconds, out: job.out, hashesFile };
}
