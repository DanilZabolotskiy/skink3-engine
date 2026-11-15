import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  emitter,
  formatReport,
  group,
  label,
  layer,
  popIn,
  runChecks,
  shot,
  type Key,
  type LayerSpec,
  type StringTables,
} from '../src/index.ts';
import { ffmpegAvailable } from '../src/render/encode.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'bin', 'skink3.mjs');
const MINIMAL = join(ROOT, 'examples', 'minimal', 'scene.ts');

function make(nodes: LayerSpec['nodes'], timeline: Key[], strings: StringTables, extraLayers: LayerSpec[] = []): ReturnType<typeof shot> {
  return shot({
    id: 'tiny',
    seconds: 2,
    seed: 1,
    palette,
    strings,
    background: { inner: 'deep.night', outer: 'deep.abyss' },
    atmosphere: 'mid.mist',
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [...extraLayers, layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

test('check: a shown label that covers a node other than its target is a warning, per language', async () => {
  const strings: StringTables = {
    en: { 'label.a': 'Short' },
    xx: { 'label.a': 'A caption that is very much longer than the short one' },
  };
  const s = make(
    [
      circle({ id: 'a', r: 40, fill: 'accent.amber', children: [circle({ id: 'a-child', r: 10, at: [0, -60], fill: 'light.cream' })] }),
      // To the upper right of "a": only the long label reaches it.
      circle({ id: 'neighbour', r: 30, at: [170, -110], fill: 'accent.aqua' }),
      // Under the label in both languages, but not counted: faint, not yet shown, or on another layer.
      circle({ id: 'faint', r: 30, at: [0, -110], fill: 'mid.violet', opacity: 0.15 }),
      circle({ id: 'later', r: 30, at: [20, -110], fill: 'mid.rose' }),
      label({ id: 'la', text: 'label.a', target: 'a', fill: 'light.cream', ink: 'deep.night', maxWidth: 400 }),
    ],
    [popIn('la', { at: 0.5 }), popIn('later', { at: 1.95 })],
    strings,
    [layer({ id: 'far', depth: 1, nodes: [circle({ id: 'backdrop', r: 200, at: [0, -110], fill: 'dark.indigo' })] })],
  );
  const c = compileShot(s);
  const report = runChecks(c, await bakeShot(c));
  assert.equal(report.ok, true, 'a warning does not fail the checks');
  const warnings = report.issues.filter((i) => i.severity === 'warning');
  assert.equal(report.issues.length, warnings.length, 'nothing but warnings');
  assert.equal(warnings.length, 1, warnings.map((w) => w.message).join('\n'));
  const w = warnings[0]!;
  assert.equal(w.check, 'text-fit');
  assert.match(w.message, /covers-node: label "la" \[xx\]: covers node "neighbour" from \d+\.\d\d s to \d+\.\d\d s/);
  const text = formatReport(report);
  assert.match(text, /text-fit: ok, 1 warning\(s\)/);
  assert.match(text, /~ warning: covers-node/);
  assert.match(text, /checks passed with 1 warning\(s\)/);

  // The same scene with the neighbour moved away is clean in both languages.
  const clean = compileShot(
    make(
      [
        circle({ id: 'a', r: 40, fill: 'accent.amber' }),
        circle({ id: 'neighbour', r: 30, at: [420, -110], fill: 'accent.aqua' }),
        label({ id: 'la', text: 'label.a', target: 'a', fill: 'light.cream', ink: 'deep.night', maxWidth: 400 }),
      ],
      [popIn('la', { at: 0.5 })],
      strings,
    ),
  );
  assert.deepEqual(runChecks(clean, await bakeShot(clean)).issues, []);

  // A label on an anchor inside a body does not "cover" that body: ancestors of the target are its own.
  const nested = compileShot(
    make(
      [
        circle({ id: 'body', r: 120, fill: 'mid.jade', children: [group({ id: 'anchor', at: [0, 40] })] }),
        label({ id: 'la', text: 'label.a', target: 'anchor', fill: 'light.cream', ink: 'deep.night' }),
      ],
      [],
      { en: { 'label.a': 'Short' } },
    ),
  );
  assert.deepEqual(runChecks(nested, await bakeShot(nested)).issues, []);
});

test('particles: prewarm populates the field before frame 0', async () => {
  const bake = async (prewarm: number, from = 0): Promise<number> => {
    const c = compileShot(
      make([emitter({ id: 'e', rate: 20, from, prewarm, colors: ['accent.aqua'], size: [3, 5], life: 4, speed: [5, 10], area: [400, 400] })], [], { en: {} }),
    );
    return (await bakeShot(c)).particlesAt(0, 0).length / 4;
  };
  assert.equal(await bake(0), 0);
  const warm = await bake(6);
  // Twenty a second, four seconds of life each: about eighty alive (a few are too small to store).
  assert.ok(warm > 60 && warm <= 80, `a steady population at frame 0 (${warm})`);
  assert.equal(await bake(6, 1), 0, 'an emitter that starts later is not prewarmed');
});

test('render: a failing worker stops the others, leaves nothing behind and names its frames', { skip: !ffmpegAvailable() }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'skink3-render-'));
  try {
    const args = [CLI, 'render', MINIMAL, '--from', '0', '--to', '120', '--workers', '4', '--width', '480', '--cpu', '--out', join(dir, 'clip.mp4')];
    const failed = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', env: { ...process.env, SKINK3_TEST_FAIL_AT_FRAME: '70' } });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /skink3: the render worker for frames 60\.\.89 failed \(exit code 1\); the other workers were stopped and nothing was written/);
    assert.match(failed.stderr, /injected failure at frame 70/);
    const left = readdirSync(dir).filter((f) => f !== 'cache');
    assert.deepEqual(left, [], `nothing is left of the failed render: ${left.join(', ')}`);

    // The same render without the fault: finishes, reports progress, writes the file.
    const ok = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /120\/120 frames, 100 %, \d+ frames\/s/);
    assert.match(ok.stdout, /120 frames in \d+\.\d\d s/);
    assert.ok(existsSync(join(dir, 'clip.mp4')) && statSync(join(dir, 'clip.mp4')).size > 1000);
    assert.deepEqual(readdirSync(dir).filter((f) => f !== 'cache').sort(), ['clip.mp4']);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
