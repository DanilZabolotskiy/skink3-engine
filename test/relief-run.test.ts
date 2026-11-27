// A run of frames of a relief is the frame drawn first, frame after frame. The picture a relief draws into a frame is
// freed with that frame's canvases, after its readback, so it leaves nothing behind in the drawing library's store of
// canvas pixels; freed before it, as it once was, a score of frames filled that store and every later frame came out
// otherwise at its edges. A render chunk, whose frames are recorded while the frame before is read back, is the same.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Canvas, ImageData } from 'skia-canvas';
import { bakeShot, compileShot, frameRaw, rendererInfo } from '../src/index.ts';
import { ffmpegAvailable } from '../src/render/encode.ts';
import reliefRun from './fixtures/relief-run.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'bin', 'skink3.mjs');
const SCENE = join(ROOT, 'test', 'fixtures', 'relief-run.ts');
const WIDTH = 1920;
const devices = rendererInfo(true).renderer === 'GPU' ? [false, true] : [false];
const hash = (raw: Buffer): string => createHash('sha256').update(raw).digest('hex');

const c = compileShot(reliefRun);
const bake = await bakeShot(c);
const frame = (gpu: boolean): Promise<Buffer> => frameRaw(c, bake, 0, { width: WIDTH, lang: 'en', gpu });

test('relief run: each of 24 frames drawn in a row is the frame drawn first, on the CPU and on the GPU', async () => {
  for (const gpu of devices) {
    const first = hash(await frame(gpu));
    for (let i = 1; i < 24; i++) assert.equal(hash(await frame(gpu)), first, `${gpu ? 'GPU' : 'CPU'}: frame ${i} of the run is the first`);
  }
});

test('relief run: a render chunk of 30 frames, each recorded while the one before is read back, is its still frame after frame', { skip: !ffmpegAvailable() && 'no ffmpeg' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'skink3-relief-run-'));
  try {
    const run = (args: readonly string[]) => spawnSync(process.execPath, [CLI, ...args, '--cache', join(dir, 'cache')], { cwd: dir, encoding: 'utf8' });
    const r = run(['render', SCENE, '--from', '0', '--to', '30', '--workers', '1', '--chunk', '0', '--hashes', '--out', join(dir, 'run.mp4')]);
    assert.equal(r.status, 0, r.stderr);
    const still = run(['still', SCENE, '--frame', '0', '--hash', '--out', join(dir, 'still.png')]);
    assert.equal(still.status, 0, still.stderr);
    const want = /sha256 ([0-9a-f]{64})/.exec(still.stdout)?.[1];
    assert.ok(want, still.stdout);
    const lines = readFileSync(join(dir, 'run.mp4.hashes.txt'), 'utf8').trim().split(/\r?\n/);
    assert.equal(lines.length, 30);
    for (const line of lines) assert.equal(line.split(' ')[1], want, `frame ${line.split(' ')[0]} of the chunk is its still`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

// Last in this file: what it plants stays in the library's store for seconds.
test('relief run, planted: canvases freed before their frame is read back, as relief pictures were, change the frames after them', async () => {
  const first = new Map<boolean, string>();
  for (const gpu of devices) first.set(gpu, hash(await frame(gpu)));
  // The store is the library's, for every canvas of the process, on the CPU and on the GPU alike.
  const host = new Canvas(WIDTH, 1080, { gpu: false });
  const hx = host.getContext('2d');
  for (let i = 0; i < 20; i++) {
    const picture = new Canvas(WIDTH, 1080);
    picture.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(WIDTH * 1080 * 4).fill(90 + i), WIDTH, 1080), 0, 0);
    hx.drawCanvas(picture, 0, 0);
    picture.dispose();
  }
  host.toBufferSync('raw', { colorType: 'rgba' });
  host.dispose();
  for (const gpu of devices) {
    assert.notEqual(hash(await frame(gpu)), first.get(gpu), `${gpu ? 'GPU' : 'CPU'}: with the store filled the frame comes out otherwise: the run would see a picture left behind`);
  }
});
