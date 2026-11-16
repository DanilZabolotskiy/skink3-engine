import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('package: every dependency is pinned to an exact version', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    exports: Record<string, string>;
    bin: Record<string, string>;
  };
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be pinned exactly, got "${version}"`);
  }
  assert.equal(pkg.exports['.'], './src/index.ts');
  assert.equal(pkg.bin['skink3'], './bin/skink3.mjs');
});

test('sources: nothing that draws may read a clock or an unseeded random number', () => {
  const banned = [/Math\.random/, /Date\.now/, /new Date\(/, /process\.hrtime/];
  // performance.now() is allowed only where a duration is reported to the user.
  const timers = new Set(['physics/bake.ts', 'render/parallel.ts']);
  for (const file of walk(join(ROOT, 'src')).filter((f) => f.endsWith('.ts'))) {
    const rel = file.slice(join(ROOT, 'src').length + 1).replaceAll('\\', '/');
    const code = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    for (const re of banned) assert.ok(!re.test(code), `${rel} uses ${re.source}`);
    if (!timers.has(rel)) assert.ok(!/performance\.now/.test(code), `${rel} reads the clock`);
  }
});

test('fonts: every bundled family ships with its licence', () => {
  const families = readdirSync(join(ROOT, 'assets', 'fonts'));
  assert.ok(families.includes('nunito') && families.length >= 3, 'the typeface of the engine and its fallbacks');
  for (const family of families) {
    const dir = join(ROOT, 'assets', 'fonts', family);
    const files = readdirSync(dir);
    assert.ok(files.some((f) => f.endsWith('.ttf')), `${family} holds a font file`);
    assert.match(readFileSync(join(dir, 'OFL.txt'), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/, `${family} holds its licence`);
  }
});
