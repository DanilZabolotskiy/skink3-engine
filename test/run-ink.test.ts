import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Canvas } from 'skia-canvas';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  checkGlyphs,
  circle,
  compileShot,
  evaluate,
  fadeTo,
  flatItems,
  frameRaw,
  heightFor,
  label,
  labelLayout,
  layer,
  popIn,
  resolveColor,
  runChecks,
  shot,
  text,
  type ColorRef,
  type Key,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';
import type { LabelItem, TextItem } from '../src/scene/evaluate.ts';
import { ensureFonts, fontString } from '../src/text/fonts.ts';
import { layoutText } from '../src/text/layout.ts';
import { parseRuns, runSpans, splitRuns } from '../src/text/runs.ts';

// A second ink for runs of a label's or a text's string: the string marks them with "[" and "]", each language its
// own; the marks are taken out before the text is measured, and the glyphs of a run are drawn in `runInk`.

const WIDTH = 960;
const STRINGS = {
  en: {
    'v.now': '2.0 · [Aug–Oct 2026]',
    'v.plain': '2.0 · Aug–Oct 2026',
    'v.two': '[record] 2.4 · [1982–83]',
    'v.wrap': 'about sixty in a hundred · [as read in November 2026]',
    'v.wrap-plain': 'about sixty in a hundred · as read in November 2026',
    'v.brackets': 'range [2–4] m',
  },
  de: {
    'v.now': '2,0 · [Aug.–Okt. 2026]',
    'v.plain': '2,0 · Aug.–Okt. 2026',
    'v.two': '[Rekord] 2,4 · [1982–83]',
    'v.wrap': 'etwa sechzig von hundert · [gelesen im November 2026]',
    'v.wrap-plain': 'etwa sechzig von hundert · gelesen im November 2026',
    'v.brackets': 'Bereich [2–4] m',
  },
};

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], strings: ShotSpec['strings'] = STRINGS): ShotSpec {
  return shot({
    id: 'tiny',
    seconds: 2,
    seed: 3,
    palette,
    strings,
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

const spot = (id: string, at: [number, number]): ReturnType<typeof circle> => circle({ id, at, r: 20, fill: 'accent.aqua', lit: false });
const tag = (id: string, key: string, target: string, runInk?: ColorRef): ReturnType<typeof label> =>
  label({ id, text: key, target, side: 'right', fill: 'light.cream', ink: 'deep.ink', size: 40, ...(runInk ? { runInk } : {}) });

function itemOf<K extends 'label' | 'text'>(state: ReturnType<typeof evaluate>, kind: K, id: string): K extends 'label' ? LabelItem : TextItem {
  for (const l of state.layers) {
    const hit = flatItems(l.items).find((i) => i.kind === kind && i.node.id === id);
    if (hit) return hit as K extends 'label' ? LabelItem : TextItem;
  }
  throw new Error(`no ${kind} "${id}"`);
}

/** The pixels of a frame drawn on the CPU, at half size. */
async function pixels(spec: ShotSpec, frame = 0, lang = 'en'): Promise<Uint8Array> {
  const c = compileShot(spec);
  return frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang, gpu: false });
}

/** How many pixels inside a box of the stage (x0..x1, y0..y1) are near a colour of the palette. */
function near(raw: Uint8Array, ref: ColorRef, box: { x0: number; x1: number; y0: number; y1: number }, within = 40): number {
  const hex = resolveColor(palette, ref);
  const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const k = WIDTH / 1920;
  let n = 0;
  for (let y = Math.max(0, Math.round((box.y0 + 540) * k)); y < Math.min(heightFor(WIDTH), Math.round((box.y1 + 540) * k)); y++) {
    for (let x = Math.max(0, Math.round((box.x0 + 960) * k)); x < Math.min(WIDTH, Math.round((box.x1 + 960) * k)); x++) {
      const o = (y * WIDTH + x) * 4;
      if (Math.abs(raw[o]! - want[0]!) + Math.abs(raw[o + 1]! - want[1]!) + Math.abs(raw[o + 2]! - want[2]!) < within) n++;
    }
  }
  return n;
}

test('runs: the marks of a string are taken out, and where they stood is where the runs are', () => {
  assert.deepEqual(parseRuns('2.0 · [Aug–Oct 2026]'), { text: '2.0 · Aug–Oct 2026', runs: [[6, 18]] });
  assert.deepEqual(parseRuns('[record] 2.4 · [1982–83]'), { text: 'record 2.4 · 1982–83', runs: [[0, 6], [13, 20]] });
  assert.deepEqual(parseRuns('12[%]'), { text: '12%', runs: [[2, 3]] });
  assert.deepEqual(parseRuns('no marks at all'), { text: 'no marks at all', runs: [] });
  // What is refused, with the place of the mistake, counted in characters from 1.
  assert.throws(() => parseRuns('a [b [c] d]'), /"\[" at character 6 opens a run inside the run opened at character 3; runs do not nest/);
  assert.throws(() => parseRuns('a b] c'), /"\]" at character 4 closes no run/);
  assert.throws(() => parseRuns('2.0 · [Aug'), /the run opened at character 7 is never closed with "\]"/);
  assert.throws(() => parseRuns('a [] b'), /the run opened at character 3 is empty/);
  assert.throws(() => parseRuns('a [  ] b'), /the run opened at character 3 is empty/);
});

test('runs: a label with a second ink is laid out as its text without the marks: lines, size, box and places as without a run', () => {
  const spec = make([spot('a', [-600, -300]), spot('b', [-600, 0]), spot('c', [-600, 300]), spot('d', [100, 300]), tag('now', 'v.now', 'a', 'mid.rose'), tag('plain', 'v.plain', 'b'), tag('wrap', 'v.wrap', 'c', 'mid.rose'), tag('wrapPlain', 'v.wrap-plain', 'd')]);
  const c = compileShot(spec);
  const lay = (id: string, lang: string): ReturnType<typeof labelLayout> => labelLayout(c, c.byId.get(id)!, lang);
  for (const lang of ['en', 'de']) {
    for (const [marked, plain] of [['now', 'plain'], ['wrap', 'wrapPlain']] as const) {
      const a = lay(marked, lang);
      const b = lay(plain, lang);
      assert.deepEqual(a.layout, b.layout, `[${lang}] ${marked}: the layout of the marked string is the layout of the plain one`);
      assert.deepEqual(a.geometry.box, b.geometry.box, `[${lang}] ${marked}: the box`);
      assert.deepEqual(a.geometry.lines.map(({ text: t, x, y }) => ({ text: t, x, y })), b.geometry.lines, `[${lang}] ${marked}: the lines stand where they stand`);
      assert.ok(!b.geometry.lines.some((l) => 'runs' in l), 'a label without a second ink has no runs');
    }
    // The run starts after the separator and its space, and ends where the line ends.
    const now = lay('now', lang);
    const line = now.geometry.lines[0]!;
    const half = now.layout.widths[0]! / 2;
    assert.equal(line.runs!.length, 1);
    assert.ok(Math.abs(line.runs![0]![1] - half) < 1e-6, `[${lang}] the run ends at the end of the line`);
    assert.ok(line.runs![0]![0] > -half && line.runs![0]![0] < 0, `[${lang}] the run starts inside the line, before its middle`);
  }
  // A run that a line break cuts is a span on each line it is on; a line without a run has none.
  const wrap = lay('wrap', 'en');
  assert.ok(wrap.layout.lines.length >= 2, wrap.layout.lines.join(' / '));
  assert.ok(wrap.geometry.lines.filter((l) => l.runs).length >= 2, `the run goes on over a line break: ${wrap.layout.lines.join(' / ')}`);
  assert.ok(!wrap.geometry.lines[0]!.runs, `the first line, "${wrap.geometry.lines[0]!.text}", holds no run`);
  // Two runs on one line are two spans.
  const two = labelLayout(compileShot(make([spot('a', [0, 0]), tag('two', 'v.two', 'a', 'mid.rose')])), compileShot(make([spot('a', [0, 0]), tag('two', 'v.two', 'a', 'mid.rose')])).byId.get('two')!, 'en');
  assert.equal(two.geometry.lines[0]!.runs!.length, 2);
});

test('runs: a line is cut glyph by glyph, every contour where it was, and no glyph is parted', () => {
  ensureFonts();
  const ctx = new Canvas(8, 8, { gpu: false }).getContext('2d');
  for (const marked of ['2.0 · [Aug–Oct 2026]', '[record] 2.4 · [1982–83]', '12[%] of [½]']) {
    const m = parseRuns(marked);
    const layout = layoutText(m.text, { size: 40, minSize: 40, weight: 800, maxWidth: 1800, maxLines: 1 });
    const spans = runSpans(layout, m)[0]!;
    ctx.font = fontString(40, 800);
    ctx.textAlign = 'center';
    const outline = ctx.outlineText(m.text)!;
    const { plain, run } = splitRuns(outline, spans);
    const edges = (p: { contours: readonly { edges: readonly unknown[] }[] } | null): string[] => (p ? p.contours.map((k) => JSON.stringify(k.edges)) : []);
    assert.deepEqual([...edges(plain), ...edges(run)].sort(), edges(outline).sort(), `${marked}: the two parts hold the contours of the line, unmoved`);
    assert.ok(plain && run, `${marked}: both parts have glyphs`);
    // Each contour lies, by its middle, on its side of every edge of a span.
    const mid = (k: { bounds: { left: number; right: number } }): number => (k.bounds.left + k.bounds.right) / 2;
    assert.ok(run.contours.every((k) => spans.some(([x0, x1]) => mid(k) >= x0 && mid(k) < x1)), marked);
    assert.ok(plain.contours.every((k) => !spans.some(([x0, x1]) => mid(k) >= x0 && mid(k) < x1)), marked);
  }
});

test('runs: the glyphs of a run are drawn in the second ink, the rest in the ink, where a plain label draws them', async () => {
  const one = (runInk?: ColorRef, key = 'v.now'): ShotSpec => make([spot('a', [-500, 0]), tag('t', key, 'a', runInk)]);
  const c = compileShot(one('mid.rose'));
  const item = itemOf(evaluate(c, await bakeShot(c), 0, 'en'), 'label', 't');
  const g = item.geometry;
  const line = g.lines[0]!;
  const start = item.tip[0] + line.x + line.runs![0]![0];
  // The band of the letters, clear of the round corners of the box.
  const band = { y0: item.tip[1] + line.y - item.layout.capHeight - 4, y1: item.tip[1] + line.y + 4 };
  const before = { x0: item.tip[0] + g.box.x + 6, x1: start - 2, ...band };
  const after = { x0: start + 2, x1: item.tip[0] + g.box.x + g.box.w - 6, ...band };
  const raw = await pixels(one('mid.rose'));
  assert.ok(near(raw, 'deep.ink', before) > 80 && near(raw, 'mid.rose', before) === 0, 'the value is in the ink alone');
  assert.ok(near(raw, 'mid.rose', after) > 300 && near(raw, 'deep.ink', after) === 0, 'the date is in the second ink alone');
  // With the ink as its second ink, a label draws what a plain label of the same text draws, but for the rounding of
  // the edges of its glyphs: not one glyph has moved.
  const same = await pixels(one('deep.ink'));
  const plainLabel = await pixels(one(undefined, 'v.plain'));
  let differ = 0;
  let most = 0;
  for (let i = 0; i < same.length; i++) {
    const d = Math.abs(same[i]! - plainLabel[i]!);
    if (d > 0) differ++;
    most = Math.max(most, d);
  }
  assert.ok(most <= 24 && differ < 400, `the same glyphs in the same places: ${differ} values differ, by at most ${most}`);
  // A pop and a fade are those of a plain label: the same scale and opacity at every frame.
  const timed = (runInk: ColorRef | undefined, key: string): ShotSpec => make([spot('a', [-500, 0]), tag('t', key, 'a', runInk)], [popIn('t', { at: 0.2 }), fadeTo('t', { at: 1, to: 0.4 })]);
  const ca = compileShot(timed('mid.rose', 'v.now'));
  const cb = compileShot(timed(undefined, 'v.plain'));
  const ba = await bakeShot(ca);
  const bb = await bakeShot(cb);
  for (const f of [14, 18, 24, 70, 90]) {
    const a = itemOf(evaluate(ca, ba, f, 'en'), 'label', 't');
    const b = itemOf(evaluate(cb, bb, f, 'en'), 'label', 't');
    assert.deepEqual([a.tip, a.scale, a.alpha, a.geometry.box], [b.tip, b.scale, b.alpha, b.geometry.box], `frame ${f}`);
  }
});

test('runs: a text takes a second ink as a label does; a counter does not', async () => {
  const words = (runInk?: ColorRef, key = 'v.now'): ShotSpec => make([text({ id: 'w', text: key, ink: 'light.cream', at: [0, 0], size: 60, maxWidth: 1600, ...(runInk ? { runInk } : {}) })]);
  const c = compileShot(words('mid.rose'));
  const cp = compileShot(words(undefined, 'v.plain'));
  const a = itemOf(evaluate(c, await bakeShot(c), 0, 'en'), 'text', 'w');
  const b = itemOf(evaluate(cp, await bakeShot(cp), 0, 'en'), 'text', 'w');
  assert.deepEqual(a.layout, b.layout);
  assert.deepEqual(a.block.box, b.block.box);
  assert.deepEqual(a.lines.map(({ text: t, x, y }) => ({ text: t, x, y })), b.lines);
  const start = a.lines[0]!.x + a.lines[0]!.runs![0]![0];
  const raw = await pixels(words('mid.rose'));
  const band = { y0: a.block.box.y, y1: a.block.box.y + a.block.box.h };
  assert.ok(near(raw, 'light.cream', { x0: a.block.box.x, x1: start - 2, ...band }) > 150 && near(raw, 'mid.rose', { x0: a.block.box.x, x1: start - 2, ...band }) === 0);
  assert.ok(near(raw, 'mid.rose', { x0: start + 2, x1: a.block.box.x + a.block.box.w, ...band }) > 300 && near(raw, 'light.cream', { x0: start + 2, x1: a.block.box.x + a.block.box.w, ...band }) === 0);
  // A counter's line is set anew for every number: it takes no second ink.
  assert.throws(() => text({ id: 'n', text: 'v.now', ink: 'light.cream', count: 0, runInk: 'mid.rose' }), /text\("n"\): a counter takes no runInk/);
});

test('runs: what is refused, in the factory and for each language of the tables', () => {
  const refused = (make0: () => unknown, message: RegExp): void => {
    assert.throws(make0, (e: unknown) => e instanceof Error && message.test(e.message), String(message));
  };
  refused(() => label({ id: 'l', text: 'v.now', target: 'a', fill: 'light.cream', ink: 'deep.ink', runInk: '#888888' as never }), /label\("l"\): runInk must be a palette reference/);
  refused(() => text({ id: 'w', text: 'v.now', ink: 'light.cream', runInk: 'grey' as never }), /text\("w"\): runInk must be a palette reference/);
  refused(() => make([spot('a', [0, 0]), tag('l', 'v.now', 'a', 'mid.none' as ColorRef)]), /label "l" runInk/);
  // A mistake in the marks of one language names the node, the key, the language, the string and the place.
  const broken = { en: { k: '2.0 · [Aug–Oct 2026]' }, de: { k: '2,0 · [Aug.–Okt. 2026' } };
  refused(() => make([spot('a', [0, 0]), label({ id: 'l', text: 'k', target: 'a', fill: 'light.cream', ink: 'deep.ink', runInk: 'mid.rose' })], [], broken), /label "l" has runInk: its string "k" \[de\] is "2,0 · \[Aug\.–Okt\. 2026", and the run opened at character 7 is never closed/);
  refused(() => make([text({ id: 'w', text: 'k', ink: 'light.cream', runInk: 'mid.rose' })], [], { en: { k: '[a] [b [c]]' } }), /text "w" has runInk: its string "k" \[en\].*runs do not nest/);
  // A language that lost its marks would be drawn in one ink unseen.
  const lost = { en: { k: '2.0 · [Aug–Oct 2026]' }, 'x-long': { k: 'Two point oh on the index, for August to October of 2026' } };
  refused(() => make([spot('a', [0, 0]), label({ id: 'l', text: 'k', target: 'a', fill: 'light.cream', ink: 'deep.ink', runInk: 'mid.rose' })], [], lost), /label "l" has runInk, but its string "k" \[x-long\] marks no run/);
});

test('runs: they are opt-in: without a second ink a bracket is a bracket and the data is what it was', async () => {
  const plain = make([spot('a', [-500, 0]), tag('l', 'v.brackets', 'a'), text({ id: 'w', text: 'v.brackets', ink: 'light.cream', at: [0, 300] })]);
  assert.ok(!JSON.stringify(plain).includes('runInk'), 'no node of it names a second ink');
  const c = compileShot(plain);
  assert.ok(c.nodes.every((n) => !('runInk' in n.colors)));
  const state = evaluate(c, await bakeShot(c), 0, 'en');
  const l = itemOf(state, 'label', 'l');
  const w = itemOf(state, 'text', 'w');
  assert.deepEqual(l.layout.lines, ['range [2–4] m']);
  assert.deepEqual(w.lines.map((x) => x.text), ['range [2–4] m']);
  assert.ok(!l.geometry.lines.some((x) => 'runs' in x) && !w.lines.some((x) => 'runs' in x));
});

test('runs: the checks see the text without its marks', async () => {
  // The text fit: the marked label has the size and the box of the plain one in every language, the long one too.
  const long = {
    en: { m: '2.0 · [Aug–Oct 2026]', p: '2.0 · Aug–Oct 2026' },
    'x-long': { m: 'Two point oh on the official index · [for August to October of 2026]', p: 'Two point oh on the official index · for August to October of 2026' },
  };
  const c = compileShot(make([spot('a', [-700, -200]), spot('b', [-700, 200]), tag('m', 'm', 'a', 'mid.rose'), tag('p', 'p', 'b')], [], long));
  const report = runChecks(c, await bakeShot(c));
  assert.ok(report.ok, report.issues.map((i) => i.message).join('\n'));
  for (const lang of ['en', 'x-long']) {
    const [m, p] = ['m', 'p'].map((id) => report.labels.find((s) => s.label === id && s.lang === lang)!);
    assert.deepEqual({ ...m, label: '' }, { ...p, label: '' }, `[${lang}]`);
  }
  // The glyph check reads the shown text: a character no bundled font has is found inside a run too.
  const odd = compileShot(make([spot('a', [0, 0]), tag('l', 'k', 'a', 'mid.rose')], [], { en: { k: 'value · [日 2026]' } }));
  assert.deepEqual(checkGlyphs(odd, ['en']).map((i) => [i.key, i.chars]), [['k', ['日']]]);
  const clean = compileShot(make([spot('a', [0, 0]), tag('l', 'k', 'a', 'mid.rose')], [], { en: { k: 'value · [2026]' } }));
  assert.deepEqual(checkGlyphs(clean, ['en']), []);
});
