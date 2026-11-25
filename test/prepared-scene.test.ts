import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadShot } from '../src/cli/load.ts';
import { prepareScene, readPreparedScene } from '../src/render/prepared.ts';

test('prepared chunks preserve source and language data, verify bytes and have independent lifetimes', async () => {
  const scene = fileURLToPath(new URL('../examples/minimal/scene.ts', import.meta.url));
  const { compiled } = await loadShot(scene);
  const dir = mkdtempSync(join(tmpdir(), 'engine-prepared-'));
  try {
    const first = prepareScene(dir, scene, compiled);
    const next = prepareScene(dir, scene, compiled);
    assert.notEqual(first.file, next.file);
    const loaded = readPreparedScene(scene, first.file, first.digest);
    assert.equal(loaded?.compiled.sceneHash, compiled.sceneHash);
    assert.deepEqual(loaded?.compiled.spec.strings, compiled.spec.strings);
    assert.equal(readPreparedScene(scene + '.other', first.file, first.digest), undefined);
    assert.equal(readPreparedScene(scene, first.file, 'different digest'), undefined);
    writeFileSync(first.file, 'partial write');
    assert.equal(readPreparedScene(scene, first.file, first.digest), undefined);
    first.close();
    assert.equal(existsSync(first.file), false);
    assert.ok(readPreparedScene(scene, next.file, next.digest));
    next.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
