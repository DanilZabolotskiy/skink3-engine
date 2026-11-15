// Non-Latin script fixture: this file holds Cyrillic strings on purpose, to check
// that the bundled font measures, wraps and draws a script other than Latin.
// (The repository is English-only everywhere else; see CLAUDE.md.)

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, circle, compileShot, frameRaw, label, layer, layoutText, measureText, popIn, runChecks, shot } from '../src/index.ts';

const CYRILLIC = 'Привет, это длинная подпись на другом языке';

test('layout: Cyrillic text is measured with the bundled font and wraps at spaces', () => {
  const style = { size: 40, minSize: 24, weight: 800, maxWidth: 360, maxLines: 3 };
  const layout = layoutText(CYRILLIC, style);
  assert.ok(!layout.overflow);
  assert.ok(layout.lines.length >= 2 && layout.lines.length <= 3);
  assert.equal(layout.lines.join(' '), CYRILLIC);
  for (const w of layout.widths) assert.ok(w > 0 && w <= 360 + 1e-6);
  // Real glyphs, not a fallback box of one fixed width: a wide and a narrow letter differ.
  assert.notEqual(measureText('Щ', 40, 800), measureText('г', 40, 800));
  assert.ok(measureText('Привет', 40, 800) > measureText('Hi', 40, 800));
});

test('render: a Cyrillic label passes the checks and changes the picture', async () => {
  const make = (text: string): ReturnType<typeof shot> =>
    shot({
      id: 'cyrillic',
      seconds: 1,
      seed: 1,
      palette,
      strings: { en: { 'label.a': 'Caption' }, ru: { 'label.a': text } },
      background: { inner: 'deep.night', outer: 'deep.abyss' },
      atmosphere: 'mid.mist',
      camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
      layers: [
        layer({
          id: 'stage',
          depth: 0,
          nodes: [
            circle({ id: 'a', at: [0, 120], r: 60, fill: 'accent.amber' }),
            label({ id: 'la', text: 'label.a', target: 'a', fill: 'light.cream', ink: 'deep.night' }),
          ],
        }),
      ],
      timeline: [popIn('la', { at: 0 })],
    });
  const c = compileShot(make(CYRILLIC));
  const bake = await bakeShot(c);
  const report = runChecks(c, bake);
  assert.deepEqual(report.issues, []);
  assert.ok(report.labels.find((l) => l.lang === 'ru')!.lines >= 2);
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
  const en = sha(await frameRaw(c, bake, 59, { width: 480, lang: 'en', gpu: false }));
  const ru = sha(await frameRaw(c, bake, 59, { width: 480, lang: 'ru', gpu: false }));
  assert.notEqual(en, ru);
  // The same Cyrillic frame twice is the same picture.
  assert.equal(sha(await frameRaw(c, bake, 59, { width: 480, lang: 'ru', gpu: false })), ru);
});
