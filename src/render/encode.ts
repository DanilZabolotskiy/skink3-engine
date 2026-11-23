// Video encoding: raw RGBA frames are piped into ffmpeg; chunks rendered by
// parallel workers are joined without re-encoding.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { FPS } from '../core/time.ts';

export type Encoder = 'x264' | 'nvenc';

/** The ffmpeg binary: the FFMPEG environment variable, or "ffmpeg" on PATH. */
export function ffmpegBinary(): string {
  return process.env['FFMPEG'] || 'ffmpeg';
}

export function ffmpegAvailable(): boolean {
  const r = spawnSync(ffmpegBinary(), ['-hide_banner', '-version'], { stdio: 'ignore' });
  return r.status === 0;
}

function encoderArgs(encoder: Encoder): string[] {
  // Constant quality, high enough that the encode does not blur flat vector edges.
  return encoder === 'nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '18', '-b:v', '0', '-bf', '0', '-g', String(FPS)]
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '15', '-bf', '0', '-g', String(FPS)];
}

export interface FrameSink {
  /** Writes one frame of raw RGBA and waits if the encoder is busy. */
  write(frame: Buffer): Promise<void>;
  /** Finishes the file. */
  close(): Promise<void>;
  /** Stops the encoder without finishing the file. */
  abort(): Promise<void>;
}

/**
 * Starts an encoder that takes raw RGBA frames of the given size on its input
 * and writes an H.264 file. Colours are tagged and converted as BT.709, so that
 * players and measuring tools read back the colours that were drawn.
 */
export function openEncoder(file: string, width: number, height: number, encoder: Encoder, onChild?: (pid: number) => void): FrameSink {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(FPS), '-i', 'pipe:0',
    '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p',
    ...encoderArgs(encoder),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-r', String(FPS), '-video_track_timescale', String(FPS * 256),
    // A bare file name with the working directory set: paths with a drive colon are fragile in ffmpeg options.
    basename(file),
  ];
  const child: ChildProcess = spawn(ffmpegBinary(), args, { cwd: dirname(file), stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  let failed: Error | null = null;
  child.on('error', (e) => {
    failed = new Error(`could not start ffmpeg (${ffmpegBinary()}): ${e.message}`);
  });
  child.stdin?.on('error', (e) => {
    failed = failed ?? new Error(`ffmpeg closed its input: ${e.message}\n${stderr}`);
  });
  const exited = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 1)));
  try {
    if (child.pid !== undefined) onChild?.(child.pid);
  } catch (error) {
    child.stdin?.destroy();
    child.kill();
    throw error;
  }
  return {
    async write(frame: Buffer): Promise<void> {
      if (failed) throw failed;
      const stdin = child.stdin!;
      if (!stdin.write(frame)) await once(stdin, 'drain');
    },
    async close(): Promise<void> {
      child.stdin?.end();
      const code = await exited;
      if (failed) throw failed;
      if (code !== 0) throw new Error(`ffmpeg failed with code ${code}:\n${stderr}`);
    },
    async abort(): Promise<void> {
      child.stdin?.destroy();
      child.kill();
      await exited;
    },
  };
}

/** Joins chunk files (all in the directory of `out`) into one file without re-encoding. */
export function concatChunks(chunks: readonly string[], out: string): void {
  const dir = dirname(out);
  const list = `${basename(out)}.chunks.txt`;
  for (const c of chunks) {
    if (dirname(c) !== dir) throw new Error('chunks must be in the same directory as the output');
  }
  writeFileSync(`${dir}/${list}`, chunks.map((c) => `file '${basename(c)}'`).join('\n') + '\n');
  const r = spawnSync(
    ffmpegBinary(),
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', basename(out)],
    { cwd: dir, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`ffmpeg concat failed:\n${r.stderr}`);
}
