import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import demo from '../examples/demo/scene.ts';
import { bakeHash, bakeShot, compileShot, evaluate, frameRaw, heightFor, rawToPng, rendererInfo, renderSheet } from '../src/index.ts';

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
