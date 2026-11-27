import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  checkGlyphs,
  checkTextFit,
  circle,
  compileShot,
  countTo,
  evaluate,
  flatItems,
  frameRaw,
  heightFor,
  label,
  layer,
  reviewMotion,
  sceneEvents,
  shot,
  text,
  type Key,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';
import { formatCount } from '../src/text/count.ts';

// A label that is a counter, and a counter whose digits stand alone (count.grouping: false).

const STRINGS = {
  en: { 'tag.year': '{n}', 'tag.km': '{n} km', 'tag.plain': 'A plain tag', 'tag.marked': 'Open [{n}]' },
  de: { 'tag.year': '{n}', 'tag.km': '{n} km', 'tag.plain': 'Ein Schild', 'tag.marked': 'Offen [{n}]' },
  fr: { 'tag.year': '{n}', 'tag.km': '{n} km', 'tag.plain': 'Une étiquette', 'tag.marked': 'Ouvert [{n}]' },
};

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], seconds = 4): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 3,
    palette,
    strings: STRINGS,
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

const DOT = circle({ id: 'dot', r: 12, fill: 'accent.aqua', at: [0, 120] });
const TAG = { id: 'tag', text: 'tag.km', target: 'dot', fill: 'light.cream', ink: 'deep.night' } as const;

/** The label of a shot as the evaluator lists it at a moment, in a language. */
async function at(spec: ShotSpec, seconds: number, lang = 'en', id = 'tag') {
  const c = compileShot(spec);
  const hit = flatItems(evaluate(c, await bakeShot(c), Math.round(seconds * 60), lang).layers[0]!.items).find((i) => i.kind === 'label' && i.node.id === id);
  assert.ok(hit && hit.kind === 'label');
  return hit;
}

test('label count: the number of a label runs as countTo sends it, in a box made for its widest value, the tail on its target', async () => {
  const spec = make([DOT, label({ ...TAG, count: 0, size: 50 })], [countTo('tag', { at: 1, to: 12500, dur: 2, profile: 'steady' })]);
  const early = await at(spec, 0);
  const middle = await at(spec, 2);
  const late = await at(spec, 3.5);
  assert.deepEqual([early.number, middle.number, late.number], ['0', '6,250', '12,500']);
  assert.equal((await at(spec, 3.5, 'de')).number, '12.500', 'written the way the language writes numbers');
  const pieces = (item: typeof early): string => item.lines!.map((l) => l.text).join('|');
  assert.equal(pieces(late), '1|2|,|5|0|0| km', 'every character of the number, then what stands after it');
  // One box from the first frame to the last, and the tail where a plain label's would be.
  assert.deepEqual(early.geometry.box, late.geometry.box);
  const plain = await at(make([DOT, label({ ...TAG, text: 'tag.plain', size: 50 })]), 0);
  assert.deepEqual(early.tip, plain.tip);
  // The number stands in the middle of the box: a single digit there, the widest value filling the width of the text.
  const box = late.geometry.box;
  const mid = box.x + box.w / 2;
  const ones = await at(make([DOT, label({ ...TAG, text: 'tag.year', count: 7, size: 50 })], [countTo('tag', { at: 3.9, to: 99999, dur: 0.05 })]), 0);
  assert.ok(Math.abs(ones.lines![0]!.x - (ones.geometry.box.x + ones.geometry.box.w / 2)) < 1e-9);
  const span = late.lines![late.lines!.length - 1]!.x - late.lines![0]!.x;
  assert.ok(span > 0.6 * late.layout.width && span < late.layout.width && late.lines!.every((l) => l.x > box.x && l.x < box.x + box.w), `${span} in ${late.layout.width}`);
  assert.ok(Math.abs(late.lines!.reduce((s, l) => s + l.x, 0) / late.lines!.length - mid) < late.layout.width / 2);
  // In the picture: more digits, more ink in the box.
  const ink = async (seconds: number): Promise<number> => {
    const c = compileShot(make([DOT, label({ ...TAG, text: 'tag.year', count: 1, size: 120, fill: 'deep.night', ink: 'light.cream' })], [countTo('tag', { at: 1, to: 88888, dur: 1, profile: 'steady' })]));
    const raw = await frameRaw(c, await bakeShot(c), Math.round(seconds * 60), { width: 960, lang: 'en', gpu: false });
    let n = 0;
    for (let i = 0; i < 960 * heightFor(960) * 4; i += 4) if (raw[i]! > 200 && raw[i + 1]! > 200 && raw[i + 2]! > 150) n++;
    return n;
  };
  const [one, five] = [await ink(0.5), await ink(3)];
  assert.ok(one > 50 && five > 3 * one, `${one} then ${five}`);
});

test('label count: grouping false writes the digits alone in every language, on a label and on a text', async () => {
  for (const lang of ['en', 'de', 'fr', 'x-none']) assert.equal(formatCount(1309, 0, lang, false), '1309', lang);
  assert.deepEqual([formatCount(1309.5, 1, 'en', false), formatCount(1309.5, 1, 'de', false), formatCount(1309.5, 1, 'fr', false)], ['1309.5', '1309,5', '1309,5'], 'the decimal sign is still the language\'s own');
  assert.deepEqual([formatCount(1309, 0, 'en'), formatCount(1309, 0, 'de')], ['1,309', '1.309'], 'grouped as before when it is left out');
  assert.equal(formatCount(-1, 0, 'en', false), '-1');

  const years = make([DOT, label({ ...TAG, text: 'tag.year', count: { from: 1100, grouping: false } })], [countTo('tag', { at: 1, to: 1309, dur: 1 })]);
  for (const lang of ['en', 'de', 'fr']) assert.equal((await at(years, 3, lang)).number, '1309', lang);
  assert.equal((await at(years, 0, 'de')).number, '1100');
  const grouped = make([DOT, label({ ...TAG, text: 'tag.year', count: 1100 })], [countTo('tag', { at: 1, to: 1309, dur: 1 })]);
  assert.deepEqual([(await at(grouped, 3, 'en')).number, (await at(grouped, 3, 'fr')).number], ['1,309', formatCount(1309, 0, 'fr')]);
  assert.match(formatCount(1309, 0, 'fr'), /^1\u00a0309$/u, 'French groups with a space that does not break');
  // Without its separator the widest value is narrower: the box is made for the digits alone.
  assert.ok((await at(years, 0, 'en')).geometry.box.w < (await at(grouped, 0, 'en')).geometry.box.w);

  const c = compileShot(make([text({ id: 'n', text: 'tag.year', ink: 'light.cream', count: { from: 0, grouping: false } })], [countTo('n', { at: 0, to: 25000, dur: 1 })]));
  const item = flatItems(evaluate(c, await bakeShot(c), 120, 'de').layers[0]!.items).find((i) => i.kind === 'text');
  assert.ok(item && item.kind === 'text' && item.number === '25000');
  // The glyph check takes the label's number, as it is written.
  assert.deepEqual(checkGlyphs(compileShot(years), ['en', 'de', 'fr']), []);
});

test('label count: what it refuses, and that it is opt-in', async () => {
  const bad = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, (e: unknown) => e instanceof Error && message.test(e.message), String(message));
  };
  bad(() => make([DOT, label({ ...TAG, text: 'tag.plain' })], [countTo('tag', { at: 1, to: 5 })]), /countTo cannot target label "tag"; it applies to a text or a label that is a counter \(give it the option count\)/);
  bad(() => make([DOT, label({ ...TAG, text: 'tag.plain', count: 0 })]), /label "tag" is a counter: its string "tag\.plain" \[en\] must hold \{n\} once, where the number goes/);
  bad(() => label({ ...TAG, text: 'tag.marked', count: 0, runInk: 'accent.aqua' }), /label\("tag"\): a counter takes no runInk/);
  bad(() => label({ ...TAG, count: { from: 0, grouping: 'no' } as never }), /label\("tag"\): count\.grouping must be true or false/);
  bad(() => text({ id: 'n', text: 'tag.year', ink: 'light.cream', count: { from: 0, grouping: 0 } as never }), /text\("n"\): count\.grouping must be true or false/);
  bad(() => label({ ...TAG, count: { from: 0, group: false } as never }), /label\("tag"\) count: unknown option "group" \(allowed: from, decimals, grouping, roll\)/);
  bad(() => label({ ...TAG, count: { from: 0, decimals: 0.5 } }), /count\.decimals must be a whole number/);

  // Opt-in: a plain label lists no lines of its own and has no counter in its data; grouping true is written as nothing.
  const plain = make([DOT, label({ ...TAG, text: 'tag.plain' })]);
  const item = await at(plain, 0);
  assert.ok(item.lines === undefined && item.number === undefined && !('lines' in item));
  assert.ok(!JSON.stringify(plain).includes('"count":') && compileShot(plain).nodes.every((n) => n.count === null));
  assert.deepEqual(label({ ...TAG, count: { from: 3, grouping: true } }), label({ ...TAG, count: 3 }));
  assert.deepEqual(text({ id: 'n', text: 'tag.year', ink: 'light.cream', count: { from: 3, decimals: 0, grouping: true } }), text({ id: 'n', text: 'tag.year', ink: 'light.cream', count: 3 }));
  assert.ok(!JSON.stringify(label({ ...TAG, count: 3 })).includes('grouping'));
  assert.deepEqual(label({ ...TAG, count: { from: 3, grouping: false } }).count, { from: 3, decimals: 0, grouping: false });
});

test('label count: no event, life in the frame while it runs, a hold when it stands, and the text-fit check holds its widest value', async () => {
  const running = compileShot(make([DOT, label({ ...TAG, count: 0, size: 60 })], [countTo('tag', { at: 0, to: 4000, dur: 7.8, profile: 'steady' })], 8));
  assert.deepEqual(sceneEvents(running, await bakeShot(running)), []);
  const findings = async (c: ReturnType<typeof compileShot>): Promise<string[]> => reviewMotion(c, await bakeShot(c)).report.findings.map((f) => `${f.kind} ${f.subject}`);
  assert.ok(!(await findings(running)).includes('dead-area (frame)'), (await findings(running)).join('; '));
  const still = compileShot(make([DOT, label({ ...TAG, count: 0, size: 60 })], [], 8));
  assert.ok((await findings(still)).includes('dead-area (frame)'));

  // A label whose number will grow past the frame is reported from the first frame on, while it still shows a small number.
  const issues = async (to: number): Promise<string[]> => {
    const c = compileShot(make([circle({ id: 'dot', r: 12, fill: 'accent.aqua', at: [500, 0] }), label({ ...TAG, side: 'right', size: 60, maxWidth: 1600, count: 0 })], [countTo('tag', { at: 3, to, dur: 0.5 })]));
    return checkTextFit(c, await bakeShot(c), ['en']).issues.map((i) => `${i.kind}@${/frame (\d+)/.exec(i.message)?.[1] ?? '-'}`);
  };
  assert.deepEqual(await issues(9), []);
  assert.ok((await issues(99999999)).includes('off-frame@0'), (await issues(99999999)).join('; '));
});
