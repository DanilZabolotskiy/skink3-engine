// Frames drawn together, drawn alone: with `alone` (`--alone`), a still of several frames and every tile of a strip or
// a sheet is the frame a still of it alone draws, whatever the process drew before it. Without it, nothing changes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Canvas, loadImage } from 'skia-canvas';
import { bakeShot, compileShot, frameRaw, rendererInfo } from '../src/index.ts';
import { ffmpegAvailable } from '../src/render/encode.ts';
import { GPU_FORGETS_MS } from '../src/render/frame.ts';
import zoomEdges from './fixtures/zoom-edges.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'bin', 'skink3.mjs');
const SCENE = join(ROOT, 'test', 'fixtures', 'zoom-edges.ts');
const noGpu = rendererInfo(true).renderer === 'GPU' ? false : 'no GPU';

function cli(dir: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [CLI, ...args, '--cache', join(dir, 'cache')], { cwd: dir, encoding: 'utf8' });
}

/** The hash `still --hash` prints for each frame. */
function hashes(dir: string, args: readonly string[]): Map<number, string> {
  const r = cli(dir, ['still', SCENE, '--hash', ...args]);
  assert.equal(r.status, 0, r.stderr);
  const out = new Map<number, string>();
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^frame (\d+) .*sha256 ([0-9a-f]{64})/.exec(line);
    if (m) out.set(Number(m[1]), m[2]!);
  }
  return out;
}

function withDir(name: string, body: (dir: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), `skink3-${name}-`));
    try {
      await body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  };
}

test(
  'still --alone: each of several frames is its still alone; without it a frame drawn after another zoom differs, as before',
  { skip: noGpu },
  withDir('alone-still', (dir) => {
    // Frame 150 is zoomed in 2.6 times; 10, 100 and 200 are drawn at other zooms after it.
    const alone = new Map<number, string>();
    for (const f of [10, 100, 200]) alone.set(f, hashes(dir, ['--frame', String(f)]).get(f)!);
    const together = hashes(dir, ['--frame', '150,10,120,100,200', '--alone']);
    for (const f of [10, 100, 200]) assert.equal(together.get(f), alone.get(f), `frame ${f} after other frames is frame ${f} alone`);
    // The dependence planted back: the same frames drawn without the wait. The test must see it.
    const planted = hashes(dir, ['--frame', '150,10,120,100,200']);
    assert.ok(
      [10, 100, 200].some((f) => planted.get(f) !== alone.get(f)),
      'without --alone a frame drawn soon after a frame of another zoom differs from its still',
    );
    // Opt-in: a still of one frame is the same frame with and without it.
    assert.equal(hashes(dir, ['--frame', '10', '--alone']).get(10), alone.get(10));
  }),
);

test(
  'sheet --alone: a frame twice in one sheet is the same tile twice; without it, after a frame of another zoom, it is not',
  { skip: noGpu },
  withDir('alone-sheet', async (dir) => {
    // 230 is zoomed out to 1/2.6, 150 in to 2.6: their curved edges differ by more than the library reuses at once.
    const tiles = async (alone: boolean): Promise<number> => {
      const file = join(dir, `sheet-${alone}.png`);
      const r = cli(dir, ['sheet', SCENE, '--frames', '230,150,230', '--cols', '3', '--tile', '480', '--out', file, ...(alone ? ['--alone'] : [])]);
      assert.equal(r.status, 0, r.stderr);
      const img = await loadImage(readFileSync(file));
      const canvas = new Canvas(img.width, img.height, { gpu: false });
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const a = ctx.getImageData(0, 0, 480, img.height).data;
      const b = ctx.getImageData(960, 0, 480, img.height).data;
      canvas.dispose();
      let differ = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differ++;
      return differ;
    };
    assert.equal(await tiles(true), 0, 'with --alone the first and the third tile are the same frame, pixel for pixel');
    assert.ok((await tiles(false)) > 0, 'planted: without --alone the third tile comes out of the frame drawn before it');
  }),
);

test(
  'render: unchanged; a chunk draws its frames in a row, as a still of those frames without --alone does',
  { skip: noGpu || (!ffmpegAvailable() && 'no ffmpeg') },
  withDir('alone-chunk', (dir) => {
    // Frames 150..154 zoom out: one chunk of them, against the same frames as stills drawn in a row, with and without --alone.
    const frames = [150, 151, 152, 153, 154];
    const r = cli(dir, ['render', SCENE, '--from', '150', '--to', '155', '--workers', '1', '--chunk', '0', '--hashes']);
    assert.equal(r.status, 0, r.stderr);
    const file = /(\S+\.hashes\.txt)/.exec(r.stdout)?.[1];
    assert.ok(file, r.stdout);
    const rendered = new Map(
      readFileSync(file, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((l) => [Number(l.split(' ')[0]), l.split(' ')[1]!] as const),
    );
    const inRow = hashes(dir, ['--frame', frames.join(',')]);
    const alone = hashes(dir, ['--frame', frames.join(','), '--alone']);
    for (const f of frames) assert.equal(rendered.get(f), inRow.get(f), `frame ${f} of the chunk is frame ${f} of the stills in a row`);
    assert.equal(rendered.get(150), alone.get(150), 'the first frame of a chunk is its still alone');
    assert.ok(
      frames.some((f) => rendered.get(f) !== alone.get(f)),
      'while the zoom changes, a frame of the chunk is not its still alone: --alone changes no render',
    );
  }),
);

test('alone: on the GPU a frame waits until the GPU has rested from the frames before; on the CPU nothing waits', async () => {
  const c = compileShot(zoomEdges);
  const bake = await bakeShot(c);
  const time = async (gpu: boolean): Promise<number> => {
    await frameRaw(c, bake, 10, { width: 320, lang: 'en', gpu });
    const t0 = performance.now();
    await frameRaw(c, bake, 200, { width: 320, lang: 'en', gpu, alone: true });
    return performance.now() - t0;
  };
  assert.ok((await time(false)) < GPU_FORGETS_MS / 2, 'on the CPU a frame drawn alone does not wait');
  if (!noGpu) assert.ok((await time(true)) >= GPU_FORGETS_MS - 5, 'on the GPU it waits for the rest');
});

test('--alone: refused by every command but still, strip and sheet', withDir('alone-refused', (dir) => {
  for (const command of ['render', 'check', 'trail', 'bake']) {
    const r = cli(dir, [command, SCENE, '--alone']);
    assert.notEqual(r.status, 0, `${command} --alone must fail`);
    assert.match(r.stderr, new RegExp(`${command}: --alone is an option of still, strip and sheet`));
  }
}));
