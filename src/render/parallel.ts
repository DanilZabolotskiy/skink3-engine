// Parallel rendering: the frame range is split into contiguous chunks, each
// rendered by its own process into its own encoder, and the chunks are joined.
// Frames are pure, so the split changes nothing about the pixels.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bake } from '../physics/cache.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { concatChunks, openEncoder, type Encoder } from './encode.ts';
import { frameRaw, heightFor } from './frame.ts';

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
  const height = heightFor(opts.width);
  const sink = openEncoder(opts.out, opts.width, height, opts.encoder);
  const lines: string[] = [];
  let unreported = 0;
  try {
    // Draw one frame ahead while the previous one is being handed to the encoder.
    let pending: Promise<Buffer> | null = null;
    for (let f = opts.from; f <= opts.to; f++) {
      if (f === opts.failAtFrame) throw new Error(`injected failure at frame ${f}`);
      const next = f < opts.to ? frameRaw(c, bake, f, { width: opts.width, lang: opts.lang, gpu: opts.gpu }) : null;
      if (pending) {
        const raw = await pending;
        if (raw.length !== opts.width * height * 4) throw new Error(`frame ${f - 1}: unexpected raw size ${raw.length}`);
        if (opts.hashesFile) lines.push(`${f - 1} ${createHash('sha256').update(raw).digest('hex')}`);
        await sink.write(raw);
        if (++unreported >= REPORT_EVERY) {
          opts.onFrames?.(unreported);
          unreported = 0;
        }
      }
      pending = next;
    }
    await sink.close();
  } catch (error) {
    // Do not leave an encoder behind that waits for frames that will never come.
    sink.abort();
    throw error;
  }
  if (unreported > 0) opts.onFrames?.(unreported);
  if (opts.hashesFile) writeFileSync(opts.hashesFile, lines.join('\n') + '\n');
}

/**
 * Splits a job among worker processes, waits for them, and joins their chunks.
 * If one worker fails, the others are stopped at once, the partial files are
 * removed, and the error names the frame range of the worker that failed.
 */
export async function renderParallel(job: RenderJob): Promise<RenderResult> {
  const total = job.to - job.from;
  if (total <= 0) throw new Error('nothing to render: the frame range is empty');
  const workers = Math.max(1, Math.min(job.workers, total));
  const dir = dirname(job.out);
  mkdirSync(dir, { recursive: true });
  const stem = basename(job.out).replace(/\.[^.]+$/, '');
  const t0 = performance.now();

  const chunks: { file: string; hashes: string | null; from: number; to: number }[] = [];
  for (let w = 0; w < workers; w++) {
    const a = job.from + Math.floor((total * w) / workers);
    const b = job.from + Math.floor((total * (w + 1)) / workers);
    const tag = `${stem}.chunk${String(w).padStart(3, '0')}`;
    chunks.push({ file: join(dir, `${tag}.mp4`), hashes: job.hashes ? join(dir, `${tag}.hashes.txt`) : null, from: a, to: b });
  }
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
  await new Promise<void>((resolve) => {
    let running = chunks.length;
    const finished = (): void => {
      if (--running === 0) resolve();
    };
    const fail = (error: Error): void => {
      if (failure) return;
      failure = error;
      // One chunk is lost, so the whole render is: stop the others now.
      for (const child of children) if (child.exitCode === null) child.kill();
    };
    for (const chunk of chunks) {
      const args = [
        CLI_ENTRY, '_chunk', job.scene,
        '--bake', job.bakeFile,
        '--from', String(chunk.from), '--to', String(chunk.to),
        '--out', chunk.file, '--lang', job.lang, '--width', String(job.width), '--encoder', job.encoder,
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
        finished();
      };
      child.on('message', (message: unknown) => {
        const frames = (message as { frames?: unknown } | null)?.frames;
        if (typeof frames !== 'number') return;
        done += frames;
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
    }
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
