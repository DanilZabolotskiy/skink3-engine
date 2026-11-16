// Non-Latin fixture: this file holds symbols, Greek and Cyrillic letters and two CJK characters on purpose, to check which
// characters the bundled fonts can draw, that a symbol the main typeface lacks comes from a bundled family, and
// that a character none of them has fails the checks. (The repository is English-only everywhere else; see CLAUDE.md.)

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Canvas } from 'skia-canvas';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  BUNDLED_FONTS,
  checkGlyphs,
  circle,
  compileShot,
  countTo,
  FONT_FAMILY,
  fontOf,
  formatReport,
  frameRaw,
  label,
  layer,
  measureText,
  missingGlyphs,
  popIn,
  runChecks,
  shot,
  text,
  type ShotSpec,
} from '../src/index.ts';
import { fontCodePoints } from '../src/text/glyphs.ts';
import { fontString } from '../src/text/fonts.ts';

const SRC_TEXT = fileURLToPath(new URL('../src/text/', import.meta.url));

function make(strings: Record<string, Record<string, string>>): ShotSpec {
  return shot({
    id: 'tiny',
    seconds: 2,
    seed: 1,
    palette,
    strings,
    background: { inner: 'deep.night', outer: 'deep.abyss' },
    atmosphere: 'mid.mist',
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [
      layer({
        id: 'stage',
        depth: 0,
        nodes: [
          circle({ id: 'a', at: [0, 160], r: 60, fill: 'accent.amber' }),
          label({ id: 'la', text: 'label.a', target: 'a', fill: 'light.cream', ink: 'deep.night' }),
          text({ id: 'note', text: 'note.b', ink: 'light.cream', at: [0, -300] }),
          text({ id: 'count', text: 'count.c', ink: 'light.cream', at: [0, 400], count: { from: -1200.5, decimals: 1 } }),
        ],
      }),
    ],
    timeline: [popIn('la', { at: 0 }), countTo('count', { at: 0.5, to: 2500000, dur: 1 })],
  });
}

test('fonts: every bundled family ships with its licence, an open one, and has the characters it is there for', () => {
  assert.deepEqual(BUNDLED_FONTS.map((f) => f.name), ['Nunito', 'Noto Sans', 'Noto Sans Symbols']);
  assert.equal(BUNDLED_FONTS[0]!.family, FONT_FAMILY, 'the first family is the typeface of the engine');
  for (const font of BUNDLED_FONTS) {
    const file = join(SRC_TEXT, font.file);
    assert.ok(existsSync(file), `${font.name}: ${font.file}`);
    const licence = readFileSync(join(dirname(file), 'OFL.txt'), 'utf8');
    assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/, `${font.name} is under the SIL Open Font License 1.1`);
    assert.match(licence.split('\n')[0]!, /^Copyright \d{4} The .* Project Authors/, `${font.name}: the licence names its authors`);
    assert.ok(!/with Reserved Font Name/i.test(licence.split('\n').slice(0, 3).join('\n')), `${font.name} reserves no font name`);
    assert.ok(fontCodePoints(file).size > 900, `${font.name}: its character map is read`);
  }
  const has = (name: string, chars: string): boolean => {
    const map = fontCodePoints(join(SRC_TEXT, BUNDLED_FONTS.find((f) => f.name === name)!.file));
    return [...chars].every((ch) => map.has(ch.codePointAt(0)!));
  };
  assert.ok(has('Nunito', 'AaZzЯя≈≤≥−×÷¢·¼½¾…–—“”€'));
  assert.ok(!has('Nunito', '→') && !has('Nunito', '⅕'), 'the main typeface has neither arrows nor the other fractions');
  assert.ok(has('Noto Sans', '⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞αβγΩ№™′″'));
  assert.ok(has('Noto Sans Symbols', '←↑→↓↔↕↖↗↘↙'));
  // A file that is no font is refused with a message, not read as one.
  assert.throws(() => fontCodePoints(fileURLToPath(new URL('../package.json', import.meta.url))), /not a TrueType font the engine can read/);
});

test('glyphs: a character is drawn by the first bundled family that has it, and one that none has is found', () => {
  const by = (ch: string): string | null => fontOf(ch)?.name ?? null;
  assert.deepEqual(['A', 'я', '≈', '¾', '→', '↔', '⅕', '⅔', 'α', '№'].map(by), ['Nunito', 'Nunito', 'Nunito', 'Nunito', 'Noto Sans Symbols', 'Noto Sans Symbols', 'Noto Sans', 'Noto Sans', 'Noto Sans', 'Nunito']);
  assert.deepEqual(['日', '⇒', '∈', '✓', '♪'].map(by), [null, null, null, null, 'Noto Sans Symbols']);
  assert.deepEqual(missingGlyphs('From 3 → 7 steps, ⅕ of the way: ≈ 40 km'), []);
  assert.deepEqual(missingGlyphs('a 日本 b 日 ⇒'), ['日', '本', '⇒'], 'each character once, in the order they come');
  // What needs no glyph: every kind of space (the shaper works their width out), line ends, and what is not drawn by itself.
  assert.deepEqual(missingGlyphs('a b c d e f　g\nh\ti‍j️k­l'), []);
});

test('glyphs: a symbol the main typeface lacks is measured and drawn from the bundled family, in the weight of the text', () => {
  // The engine's own measure of the arrow is that of the bundled symbols family, whatever fonts the machine has.
  const width = measureText('→', 40, 800);
  const ctx = new Canvas(8, 8, { gpu: false }).getContext('2d');
  ctx.font = `800 40px ${BUNDLED_FONTS[2]!.family}`;
  assert.equal(width, ctx.measureText('→').width);
  ctx.font = `800 40px ${BUNDLED_FONTS[1]!.family}`;
  assert.equal(measureText('⅕', 40, 800), ctx.measureText('⅕').width);
  // A string of the main typeface alone is measured as it always was: the fallbacks behind it change nothing.
  ctx.font = `800 40px ${FONT_FAMILY}`;
  for (const s of ['Caption', 'A long way round: ≈ 40 km', 'Привет', '1 234,5 ¢ ¾']) assert.equal(measureText(s, 40, 800), ctx.measureText(s).width, s);
  // The arrow is heavier in heavy text: its outline covers more at weight 800 than at weight 300.
  const ink = (weight: number): number => {
    const c = new Canvas(120, 80, { gpu: false });
    const x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, 120, 80);
    x.fillStyle = '#000';
    x.font = fontString(60, weight);
    x.fillText('→', 20, 60);
    const raw = c.toBufferSync('raw');
    let dark = 0;
    for (let i = 0; i < raw.length; i += 4) if (raw[i]! < 128) dark++;
    return dark;
  };
  assert.ok(ink(300) > 40 && ink(800) > ink(300) * 1.4, `${ink(300)} dark pixels at weight 300, ${ink(800)} at 800`);
});

test('check: a character that no bundled font has fails the checks, with the key, the language and the character', async () => {
  const strings = {
    en: { 'label.a': 'Steps: 3 → 7 a day', 'note.b': '⅕ of the way, every day', 'count.c': 'Total: {n} €' },
    ja: { 'label.a': '日本 → 25', 'note.b': 'a ⇒ b', 'count.c': '{n}' },
    fr: { 'label.a': 'De 15 à 25 ans', 'note.b': 'Un cinquième', 'count.c': '{n} €' },
  };
  const c = compileShot(make(strings));
  const bake = await bakeShot(c);
  const report = runChecks(c, bake);
  assert.equal(report.ok, false);
  const glyphs = report.issues.filter((i) => i.check === 'glyphs');
  assert.deepEqual(glyphs.map((i) => i.severity), ['error', 'error']);
  assert.match(glyphs[0]!.message, /^"label\.a" \[ja\]: no bundled font has "日" \(U\+65E5\), "本" \(U\+672C\); it would be drawn with a font of the machine, or as an empty box\./);
  assert.match(glyphs[1]!.message, /^"note\.b" \[ja\]: no bundled font has "⇒" \(U\+21D2\);/);
  assert.match(formatReport(report), /\nglyphs: 2 problem\(s\)\n {2}- "label\.a" \[ja\]/);
  assert.match(formatReport(report), /checks FAILED$/);
  // The language that is rendered is the one that is held: English and French pass, with the arrow, the fraction and
  // the numbers of the counter as each language writes them.
  for (const lang of ['en', 'fr']) {
    const one = runChecks(c, bake, [lang]);
    assert.deepEqual(one.issues.filter((i) => i.check === 'glyphs'), [], lang);
  }
  assert.equal(runChecks(c, bake, ['en', 'fr']).ok, true);
  assert.equal(runChecks(c, bake, ['ja']).ok, false, 'a render of that language is stopped before it starts');
  assert.match(formatReport(runChecks(c, bake, ['en'])), /\nglyphs: ok\n/);
  assert.deepEqual(checkGlyphs(c, ['ja']).map((i) => [i.key, i.chars]), [['label.a', ['日', '本']], ['note.b', ['⇒']]]);
});

test('render: the arrow and the fraction are drawn, the same picture twice, and not the picture without them', async () => {
  const c = compileShot(make({ en: { 'label.a': '15 → 25', 'note.b': '⅕ of it', 'count.c': '{n}' }, plain: { 'label.a': '15 to 25', 'note.b': 'a fifth of it', 'count.c': '{n}' } }));
  const bake = await bakeShot(c);
  const sha = async (lang: string): Promise<string> => createHash('sha256').update(await frameRaw(c, bake, 90, { width: 480, lang, gpu: false })).digest('hex');
  assert.equal(await sha('en'), await sha('en'));
  assert.notEqual(await sha('en'), await sha('plain'));
});
