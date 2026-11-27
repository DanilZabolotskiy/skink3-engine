// Frames drawn together, drawn alone: a frame is the same frame whatever the process drew before it, in a still of
// several frames, in a sheet, in a chunk of a render and alone. On the GPU it was not: the drawing library keeps what it
// works out for a path object, and the engine kept some paths from frame to frame (the outline of a shape, the light of
// a turned shape), so a frame drawn after frames of another zoom or another place came out otherwise; now a kept path
// is drawn as a copy of each frame's own (src/render/fresh.ts). Two shots plant it: curved edges under a zoom that
// changes, and turned lit cards in a blurred layer under a drifting camera. The old drawing is planted back by
// SKINK3_TEST_KEEP_PATHS, to show that the test still finds the frames it would change. `alone` (`--alone`) still lets
// the GPU rest before each frame; it changes nothing more.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Canvas, loadImage, Path2D } from 'skia-canvas';
import { bakeShot, compileShot, frameRaw, rendererInfo } from '../src/index.ts';
import { ffmpegAvailable } from '../src/render/encode.ts';
import { GPU_FORGETS_MS } from '../src/render/frame.ts';
import { beginFrame, framePath } from '../src/render/fresh.ts';
import zoomEdges from './fixtures/zoom-edges.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'bin', 'skink3.mjs');
const SCENE = join(ROOT, 'test', 'fixtures', 'zoom-edges.ts');
const TURNED = join(ROOT, 'test', 'fixtures', 'lit-turned.ts');
const noGpu = rendererInfo(true).renderer === 'GPU' ? false : 'no GPU';

/** The paths the engine keeps drawn as themselves again, as before the fix: the dependence planted back. */
const PLANTED = { SKINK3_TEST_KEEP_PATHS: '1' };

function cli(dir: string, args: readonly string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [CLI, ...args, '--cache', join(dir, 'cache')], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
}

/** The hash `still --hash` prints for each frame of a scene (the zoom by default). */
function hashes(dir: string, args: readonly string[], scene = SCENE, env: Record<string, string> = {}): Map<number, string> {
  const r = cli(dir, ['still', scene, '--hash', ...args], env);
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
  'still: each of several frames is its still alone, in any order, with or without --alone; planted back, the old drawing differs',
  { skip: noGpu },
  withDir('alone-still', (dir) => {
    // Frame 150 is zoomed in 2.6 times; 10, 100 and 200 are drawn at other zooms after it.
    const alone = new Map<number, string>();
    for (const f of [10, 100, 200]) alone.set(f, hashes(dir, ['--frame', String(f)]).get(f)!);
    for (const order of ['150,10,120,100,200', '200,100,120,10,150']) {
      const together = hashes(dir, ['--frame', order]);
      for (const f of [10, 100, 200]) assert.equal(together.get(f), alone.get(f), `frame ${f} drawn in the order ${order} is frame ${f} alone`);
    }
    const rested = hashes(dir, ['--frame', '150,10,120,100,200', '--alone']);
    for (const f of [10, 100, 200]) assert.equal(rested.get(f), alone.get(f), `frame ${f} with --alone is frame ${f} alone`);
    // A frame alone is the frame it was: the fix changes no frame drawn alone.
    for (const f of [10, 100, 200]) assert.equal(hashes(dir, ['--frame', String(f)], SCENE, PLANTED).get(f), alone.get(f), `frame ${f} alone, drawn as before`);
    // Planted back, frames drawn soon after a frame of another zoom differ from their stills. The test must see it.
    const planted = hashes(dir, ['--frame', '150,10,120,100,200'], SCENE, PLANTED);
    assert.ok([10, 100, 200].some((f) => planted.get(f) !== alone.get(f)), 'planted: a frame drawn after a frame of another zoom differs from its still');
  }),
);

test(
  'still: turned lit cards in a blurred layer under a drifting camera: a frame after a jump is its still alone; planted back, it is not',
  { skip: noGpu },
  withDir('alone-turned', (dir) => {
    // Frames 296 and 300 come after frames of a second and a half before; 30 after frames of four seconds later.
    const frames = [296, 300, 30];
    const alone = new Map<number, string>();
    for (const f of frames) alone.set(f, hashes(dir, ['--frame', String(f)], TURNED).get(f)!);
    for (const order of ['196,200,296,300,30', '300,296,200,196,30', '30,300,200,296']) {
      const together = hashes(dir, ['--frame', order], TURNED);
      for (const f of frames) if (together.has(f)) assert.equal(together.get(f), alone.get(f), `frame ${f} drawn in the order ${order} is frame ${f} alone`);
    }
    for (const f of frames) assert.equal(hashes(dir, ['--frame', String(f)], TURNED, PLANTED).get(f), alone.get(f), `frame ${f} alone, drawn as before`);
    const planted = hashes(dir, ['--frame', '196,200,296,300,30'], TURNED, PLANTED);
    assert.ok([296, 300].some((f) => planted.get(f) !== alone.get(f)), 'planted: a frame drawn after a jump differs from its still');
  }),
);

test(
  'sheet: a frame twice in one sheet is the same tile twice, with or without --alone; planted back, after a frame of another zoom, it is not',
  { skip: noGpu },
  withDir('alone-sheet', async (dir) => {
    // 230 is zoomed out to 1/2.6, 150 in to 2.6: their curved edges differ by more than the library reuses at once.
    const tiles = async (alone: boolean, env: Record<string, string> = {}): Promise<number> => {
      const file = join(dir, `sheet-${alone}-${Object.keys(env).length}.png`);
      const r = cli(dir, ['sheet', SCENE, '--frames', '230,150,230', '--cols', '3', '--tile', '480', '--out', file, ...(alone ? ['--alone'] : [])], env);
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
    assert.equal(await tiles(false), 0, 'without --alone too');
    assert.ok((await tiles(false, PLANTED)) > 0, 'planted: the third tile comes out of the frame drawn before it');
  }),
);

test(
  'render: a chunk draws its frames as stills of them in a row and alone do, at the start of the chunk and while the zoom changes',
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
    for (const f of frames) assert.equal(rendered.get(f), alone.get(f), `frame ${f} of the chunk is its still alone`);
  }),
);

test('framePath: a kept path is itself in the first frame it is drawn in, and in each later frame one copy of that frame, of the same geometry', () => {
  const kept = new Path2D();
  kept.roundRect(-50, -40, 100, 80, 7.5);
  beginFrame();
  assert.equal(framePath(kept), kept, 'drawn for the first time: itself');
  assert.equal(framePath(kept), kept, 'again in that frame: itself');
  beginFrame();
  const copy = framePath(kept);
  assert.notEqual(copy, kept, 'in a later frame: a copy');
  assert.equal(framePath(kept), copy, 'again in that frame: the same copy');
  assert.equal(copy.d, kept.d, 'of the same geometry');
  beginFrame();
  const next = framePath(kept);
  assert.ok(next !== copy && next !== kept, 'in the next frame: a copy of its own');
  // A path made in a frame is drawn as itself.
  const made = new Path2D();
  made.rect(0, 0, 10, 10);
  assert.equal(framePath(made), made);
});

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
