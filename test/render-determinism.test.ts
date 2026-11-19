import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { palette } from '../examples/demo/palette.ts';
import demo from '../examples/demo/scene.ts';
import { bakeHash, bakeShot, circle, compileShot, evaluate, frameRaw, heightFor, layer, moveTo, rawToPng, rendererInfo, renderSheet, shot } from '../src/index.ts';
import { ffmpegAvailable } from '../src/render/encode.ts';
import { renderChunk } from '../src/render/parallel.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'bin', 'skink3.mjs');
const DEMO = join(ROOT, 'examples', 'demo', 'scene.ts');

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

test('evaluate: a frame is a pure function of scene, bake, frame and language', async () => {
  const c = compileShot(demo);
  const bake = await bakeShot(c);
  const strip = (v: unknown): string =>
    JSON.stringify(v, (key, value: unknown) => {
      // Compiled nodes and paths are shared objects; compare what is specific to the frame.
      if (key === 'node') return (value as { id: string }).id;
      if (key === 'layer') return (value as { spec: { id: string } }).spec.id;
      if (key === 'geometry' || key === 'layout') return undefined;
      if (value instanceof Float32Array) return Array.from(value);
      return value;
    });
  const alone = strip(evaluate(c, bake, 600, 'en'));
  for (const f of [0, 899, 300, 601, 599]) evaluate(c, bake, f, 'en');
  assert.equal(strip(evaluate(c, bake, 600, 'en')), alone, 'independent of the frames evaluated before');
  // A fresh compile and a fresh bake give the same frame.
  const c2 = compileShot(demo);
  assert.equal(strip(evaluate(c2, await bakeShot(c2), 600, 'en')), alone);
  assert.notEqual(strip(evaluate(c, bake, 601, 'en')), alone);
  assert.throws(() => evaluate(c, bake, 900, 'en'), RangeError);
  assert.throws(() => evaluate(c, bake, 1.5, 'en'), RangeError);
});

test('render: the same frame gives the same pixels, alone or after other frames', async () => {
  const c = compileShot(demo);
  const bake = await bakeShot(c);
  const width = 480;
  for (const gpu of [false, true]) {
    if (gpu && rendererInfo(true).renderer !== 'GPU') continue;
    const name = gpu ? 'GPU' : 'CPU';
    const opts = { width, lang: 'en', gpu };
    const alone = await frameRaw(c, bake, 620, opts);
    assert.equal(alone.length, width * heightFor(width) * 4);
    for (const f of [0, 300, 899]) await frameRaw(c, bake, f, opts);
    const after = await frameRaw(c, bake, 620, opts);
    assert.equal(sha(after), sha(alone), `${name}: frame 620 does not depend on what was drawn before`);
    assert.notEqual(sha(await frameRaw(c, bake, 621, opts)), sha(alone));
    // Sanity of the picture itself: opaque, mostly dark, with some bright pixels.
    let dark = 0;
    let bright = 0;
    for (let i = 0; i < alone.length; i += 4) {
      assert.equal(alone[i + 3], 255);
      const v = Math.max(alone[i]!, alone[i + 1]!, alone[i + 2]!);
      if (v < 80) dark++;
      if (v > 200) bright++;
    }
    const n = alone.length / 4;
    assert.ok(dark / n > 0.2 && bright / n > 0.01, `${name}: dark ${dark / n}, bright ${bright / n}`);
    // The other language changes the labels; the bake stays the same.
    assert.notEqual(sha(await frameRaw(c, bake, 880, { ...opts, lang: 'x-long' })), sha(await frameRaw(c, bake, 880, opts)));
  }
  const png = await rawToPng(await frameRaw(c, bake, 620, { width, lang: 'en', gpu: false }), width, heightFor(width));
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  const sheet = await renderSheet(c, bake, [{ frame: 100, lang: 'en' }, { frame: 800, lang: 'x-long' }], {
    cols: 2,
    tileWidth: 160,
    crop: null,
    gpu: false,
    captions: true,
    relative: false,
  });
  assert.equal(sheet.subarray(1, 4).toString('ascii'), 'PNG');
});

/**
 * A heavy picture: many layers, every third of them blurred. On the GPU such a frame came out with other pixels when
 * it was drawn while the canvases of another frame were still alive, as a chunk drew the next frame while the one
 * before was read back.
 */
const heavy = shot({
  id: 'heavy',
  seconds: 1,
  seed: 1,
  palette,
  strings: { en: {} },
  background: { inner: 'deep.night', outer: 'deep.abyss' },
  atmosphere: 'mid.mist',
  layers: Array.from({ length: 28 }, (_, i) =>
    layer({
      id: `l${i}`,
      depth: 3 - i * 0.12,
      blur: i % 3 === 0 ? 6 + i : 0,
      nodes: [
        ...(i === 10 ? [circle({ id: 'a', r: 80, fill: 'accent.amber' })] : []),
        ...Array.from({ length: 6 }, (_, k) => circle({ id: `d${i}x${k}`, at: [-800 + k * 160, -300 + (k % 4) * 160], r: 60, fill: 'accent.aqua' })),
      ],
    }),
  ),
  timeline: [moveTo('a', { at: 0, to: [300, 100], dur: 1 })],
});

test('render: a frame of a chunk is the frame of a still, wherever the chunk starts and on the GPU too', { skip: !ffmpegAvailable() }, async () => {
  const c = compileShot(heavy);
  const bake = await bakeShot(c);
  const dir = mkdtempSync(join(tmpdir(), 'skink3-chunk-'));
  try {
    for (const gpu of [false, true]) {
      if (gpu && rendererInfo(true).renderer !== 'GPU') continue;
      const name = gpu ? 'GPU' : 'CPU';
      const opts = { width: 1920, lang: 'en', gpu };
      const stills = new Map<number, string>();
      for (let f = 28; f < 33; f++) stills.set(f, sha(await frameRaw(c, bake, f, opts)));
      // Chunks that start one frame apart: each frame of them is the still of that frame.
      for (const from of [28, 29]) {
        const out = join(dir, `${name}-${from}.mp4`);
        await renderChunk(c, bake, { from, to: 33, out, lang: 'en', width: 1920, gpu, encoder: 'x264', hashesFile: `${out}.txt` });
        const lines = readFileSync(`${out}.txt`, 'utf8').trim().split(/\r?\n/);
        assert.equal(lines.length, 33 - from);
        for (const line of lines) {
          const [frame, hash] = line.split(' ');
          assert.equal(hash, stills.get(Number(frame)), `${name}: frame ${frame} of a chunk from ${from} is its still`);
        }
      }
      // Frames asked for at once are drawn one at a time, each as it is alone.
      const together = await Promise.all([28, 29, 30].map((f) => frameRaw(c, bake, f, opts)));
      assert.deepEqual(together.map(sha), [28, 29, 30].map((f) => stills.get(f)), `${name}: frames asked for at once`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('bake: two separate processes write the same cache, byte for byte', () => {
  const dirs = [mkdtempSync(join(tmpdir(), 'skink3-bake-a-')), mkdtempSync(join(tmpdir(), 'skink3-bake-b-'))];
  try {
    const hashes = dirs.map((dir) => {
      const r = spawnSync(process.execPath, [CLI, 'bake', DEMO, '--force', '--cache', dir], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const file = readdirSync(dir).find((f) => f.endsWith('.bake'));
      assert.ok(file, 'the cache file was written under the given directory');
      const printed = /sha256\s+([0-9a-f]{64})/.exec(r.stdout)?.[1];
      const actual = sha(readFileSync(join(dir, file)));
      assert.equal(printed, actual, 'the printed hash is the hash of the file');
      return actual;
    });
    assert.equal(hashes[0], hashes[1]);
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});

test('bake in memory equals the bake of a separate process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skink3-bake-c-'));
  try {
    const r = spawnSync(process.execPath, [CLI, 'bake', DEMO, '--cache', dir], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const printed = /sha256\s+([0-9a-f]{64})/.exec(r.stdout)?.[1];
    assert.equal(bakeHash(await bakeShot(compileShot(demo))), printed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
