import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  checkTextFit,
  circle,
  compileShot,
  countTo,
  evaluate,
  flatItems,
  frameRaw,
  heightFor,
  label,
  IntentError,
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

// A counter: a text whose number runs between values, written the way the language writes numbers.

const STRINGS = {
  en: { 'count.n': '{n}', 'count.km': '{n} km', 'count.total': 'Total: {n} items', 'plain.words': 'No number here' },
  de: { 'count.n': '{n}', 'count.km': '{n} km', 'count.total': 'Gesamt: {n} Stück', 'plain.words': 'Keine Zahl hier' },
  'x-long': { 'count.n': '{n}', 'count.km': '{n} kilometres so far', 'count.total': 'The total of all of them: {n} items', 'plain.words': 'There is no number in this one' },
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

/** The counter of a shot as the evaluator lists it at a moment, in a language. */
async function at(spec: ShotSpec, seconds: number, lang = 'en', id = 'n') {
  const c = compileShot(spec);
  const hit = flatItems(evaluate(c, await bakeShot(c), Math.round(seconds * 60), lang).layers[0]!.items).find((i) => i.kind === 'text' && i.node.id === id);
  assert.ok(hit && hit.kind === 'text');
  return hit;
}

const N = { id: 'n', text: 'count.n', ink: 'light.cream' } as const;

test('counter: a text with count shows a number that countTo runs, key after key, along a profile or as a ratio', async () => {
  assert.deepEqual(text({ ...N, count: 5 }).count, { from: 5, decimals: 0 });
  assert.deepEqual(text({ ...N, count: { from: 1.5, decimals: 1 } }).count, { from: 1.5, decimals: 1 });
  assert.equal('count' in text({ id: 't', text: 'plain.words', ink: 'light.cream' }), false, 'a text that is no counter says nothing of it');
  assert.deepEqual(countTo('n', { at: 2, to: 1500 }), { kind: 'countTo', target: 'n', at: 2, to: 1500, dur: 1, profile: 'ease', ramp: 0.3 });
  assert.deepEqual(countTo('n', { at: 2, to: 1500, dur: 3, profile: 'steady', ratio: true }), { kind: 'countTo', target: 'n', at: 2, to: 1500, dur: 3, profile: 'steady', ramp: 0.3, ratio: true });

  // At one pace from 0 to 100; then on to 250 from what was reached; a short key is a tick.
  const spec = make([text({ ...N, count: 0 })], [countTo('n', { at: 0, to: 100, dur: 2, profile: 'steady' }), countTo('n', { at: 1, to: 250, dur: 1, profile: 'steady' }), countTo('n', { at: 3, to: 251, dur: 0.05 })]);
  const shown: string[] = [];
  for (const t of [0, 0.5, 1, 1.5, 2, 2.9, 3.5]) shown.push((await at(spec, t)).number!);
  assert.deepEqual(shown, ['0', '25', '50', '150', '250', '250', '251']);
  // Eased by default: slow at both ends.
  const eased = make([text({ ...N, count: 0 })], [countTo('n', { at: 0, to: 1000, dur: 2 })]);
  assert.ok(Number((await at(eased, 0.2)).number) < 30, 'a tenth of the time, far less than a tenth of the way');
  assert.deepEqual([(await at(eased, 1)).number, (await at(eased, 2)).number], ['500', '1,000']);
  // As a ratio it gains its digits at an even pace.
  const ratio = make([text({ ...N, count: 1 })], [countTo('n', { at: 0, to: 1000, dur: 3, profile: 'steady', ratio: true })]);
  assert.deepEqual([(await at(ratio, 1)).number, (await at(ratio, 2)).number, (await at(ratio, 3)).number], ['10', '100', '1,000']);
  // Places after the decimal sign: the number is rounded to what it shows.
  const fine = make([text({ ...N, count: { from: 0, decimals: 1 } })], [countTo('n', { at: 0, to: 2.5, dur: 1, profile: 'steady' })]);
  assert.deepEqual([(await at(fine, 0)).number, (await at(fine, 0.5)).number, (await at(fine, 2)).number], ['0.0', '1.3', '2.5']);
  // Without a key it shows where it starts.
  assert.equal((await at(make([text({ ...N, count: 42 })]), 1)).number, '42');
});

test('counter: the number is written the way the language writes numbers; the words round it come from its string', async () => {
  assert.equal(formatCount(1234567.5, 1, 'en'), '1,234,567.5');
  assert.equal(formatCount(1234567.5, 1, 'de'), '1.234.567,5');
  assert.equal(formatCount(1234567, 0, 'fr'), '1 234 567', 'a space inside a number is one that does not break');
  assert.equal(formatCount(1234, 0, 'x-long'), '1,234', 'a tag that is no language is written as English');
  assert.deepEqual([formatCount(-0.04, 1, 'en'), formatCount(-3, 0, 'en'), formatCount(0.5, 0, 'en')], ['0.0', '-3', '1']);

  const spec = make([text({ id: 'n', text: 'count.total', ink: 'light.cream', count: 0, maxWidth: 1200 })], [countTo('n', { at: 0, to: 12500, dur: 1, profile: 'steady' })]);
  const en = await at(spec, 2, 'en');
  const de = await at(spec, 2, 'de');
  assert.deepEqual([en.number, de.number], ['12,500', '12.500']);
  const pieces = (item: Awaited<ReturnType<typeof at>>): string => item.lines.map((l) => l.text).join('|');
  assert.equal(pieces(en), 'Total: |1|2|,|5|0|0| items', 'what stands before, every character of the number, what stands after');
  assert.equal(pieces(de), 'Gesamt: |1|2|.|5|0|0| Stück');
  // In the picture: more digits, more ink.
  const ink = async (seconds: number): Promise<number> => {
    const c = compileShot(make([text({ ...N, count: 1, size: 120 })], [countTo('n', { at: 1, to: 88888, dur: 1, profile: 'steady' })]));
    const raw = await frameRaw(c, await bakeShot(c), Math.round(seconds * 60), { width: 960, lang: 'en', gpu: false });
    let n = 0;
    for (let i = 0; i < 960 * heightFor(960) * 4; i += 4) if (raw[i]! > 200 && raw[i + 1]! > 200) n++;
    return n;
  };
  assert.ok((await ink(0.5)) > 100 && (await ink(3)) > 5 * (await ink(0.5)), `${await ink(0.5)} then ${await ink(3)}`);
});

test('counter: its digits stand in cells of one width, its layout is that of its widest value, and the checks hold it there', async () => {
  // Three ones and three eights: every digit in the same place.
  const ones = await at(make([text({ ...N, count: 111, size: 80 })]), 0);
  const eights = await at(make([text({ ...N, count: 888, size: 80 })]), 0);
  assert.deepEqual(ones.lines.map((l) => l.x), eights.lines.map((l) => l.x));
  const step = ones.lines[1]!.x - ones.lines[0]!.x;
  assert.ok(step > 20 && Math.abs(ones.lines[2]!.x - ones.lines[1]!.x - step) < 1e-9, 'cells of one width');

  // The block is made for the widest value from the first frame on, and does not change.
  const growing = make([text({ id: 'n', text: 'count.km', ink: 'light.cream', count: 0, size: 60 })], [countTo('n', { at: 1, to: 250000, dur: 2 })]);
  const early = await at(growing, 0);
  const late = await at(growing, 3.5);
  assert.deepEqual(early.block.box, late.block.box);
  assert.deepEqual([early.number, late.number], ['0', '250,000']);
  // What is drawn at the widest value fills the width of the block; a smaller value takes less of it.
  const span = (item: typeof early): number => item.lines[item.lines.length - 1]!.x - item.lines[0]!.x;
  assert.ok(span(late) > 2.5 * span(early) && span(late) < late.layout.width);
  // Aligned as the text is: to the right the number ends where the widest one does; to the left it starts there.
  const right = (count: number) => at(make([text({ ...N, count, size: 60, align: 'right' })], [countTo('n', { at: 3.9, to: 99999, dur: 0.05 })]), 0);
  const last = (item: typeof early): number => item.lines[item.lines.length - 1]!.x;
  assert.ok(Math.abs(last(await right(7)) - last(await right(77777))) < 1e-9);
  const left = (count: number) => at(make([text({ ...N, count, size: 60, align: 'left' })], [countTo('n', { at: 3.9, to: 99999, dur: 0.05 })]), 0);
  assert.ok(Math.abs((await left(7)).lines[0]!.x - (await left(77777)).lines[0]!.x) < 1e-9);
  const middle = await at(make([text({ ...N, count: 7, size: 60 })], [countTo('n', { at: 3.9, to: 99999, dur: 0.05 })]), 0);
  assert.ok(Math.abs(middle.lines[0]!.x) < 1e-9, 'centred: a single digit stands in the middle');

  // The text-fit check takes the widest value: a counter that will leave the frame is reported while it still shows a small number.
  const issues = async (to: number): Promise<string[]> => {
    const c = compileShot(make([text({ ...N, at: [700, 0], size: 100, maxWidth: 1600, count: 0 })], [countTo('n', { at: 3, to, dur: 0.5 })]));
    return checkTextFit(c, await bakeShot(c), ['en']).issues.map((i) => `${i.kind}@${/frame (\d+)/.exec(i.message)?.[1] ?? '-'}`);
  };
  assert.deepEqual(await issues(99), []);
  assert.deepEqual(await issues(99999999), ['off-frame@0']);
  // And a string that cannot hold its widest number is an overflow.
  const c = compileShot(make([text({ id: 'n', text: 'count.total', ink: 'light.cream', count: 0, size: 60, minSize: 60, maxWidth: 400, maxLines: 1 })], [countTo('n', { at: 1, to: 1e9 })]));
  assert.ok(checkTextFit(c, await bakeShot(c), ['en']).issues.some((i) => i.kind === 'overflow'));
});

test('counter: what it refuses, that it is opt-in, and what the review and the events make of it', async () => {
  const bad = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, (e: unknown) => e instanceof Error && message.test(e.message), String(message));
  };
  bad(() => countTo('n', { at: 1, to: 5, speed: 2 } as never), /countTo\("n"\): unknown option "speed" \(allowed: at, to, dur, profile, ramp, ratio\)/);
  bad(() => countTo('n', { at: 1, to: 0, ratio: true }), /with ratio the number runs between values above 0; to is 0/);
  bad(() => countTo('n', { at: 1, to: 5, profile: 'steady', ramp: 0.2 }), /ramp applies to the profiles ease, in and out/);
  assert.ok(IntentError);
  bad(() => text({ ...N, count: { from: 0, decimals: 1.5 } }), /count\.decimals must be a whole number/);
  bad(() => text({ ...N, count: { from: 0, places: 2 } as never }), /text\("n"\) count: unknown option "places"/);
  bad(() => make([text({ id: 't', text: 'plain.words', ink: 'light.cream' })], [countTo('t', { at: 1, to: 5 })]), /countTo cannot target text "t"; it applies to a text or a label that is a counter \(give it the option count\)/);
  bad(() => make([circle({ id: 'c', r: 10, fill: 'accent.aqua' })], [countTo('c', { at: 1, to: 5 })]), /countTo cannot target shape "c"/);
  bad(() => make([text({ id: 't', text: 'plain.words', ink: 'light.cream', count: 0 })]), /text "t" is a counter: its string "plain\.words" \[en\] must hold \{n\} once, where the number goes/);
  bad(() => make([text({ ...N, count: 0 })], [countTo('n', { at: 1, to: 50, ratio: true })]), /with ratio the number runs between values above 0, and it starts from 0/);

  // Opt-in: a plain text draws its lines as its block has them, and a shot without a counter has none in its data.
  const plain = make([text({ id: 't', text: 'plain.words', ink: 'light.cream' })]);
  const item = await at(plain, 0, 'en', 't');
  assert.ok(item.lines === item.block.lines && item.number === undefined);
  assert.ok(!JSON.stringify(plain).includes('"count":') && compileShot(plain).nodes[0]!.count === null);

  // The running of a counter is no event, and it is life in the frame; a counter that stands still is a hold.
  const running = compileShot(make([text({ ...N, count: 0, size: 80 })], [countTo('n', { at: 0, to: 4000, dur: 7.8, profile: 'steady' })], 8));
  assert.deepEqual(sceneEvents(running, await bakeShot(running)), []);
  const findings = (c: ReturnType<typeof compileShot>, bake: Awaited<ReturnType<typeof bakeShot>>): string[] => reviewMotion(c, bake).report.findings.map((f) => `${f.kind} ${f.subject}`);
  assert.ok(!findings(running, await bakeShot(running)).includes('dead-area (frame)'));
  const still = compileShot(make([text({ ...N, count: 0, size: 80 })], [], 8));
  assert.ok(findings(still, await bakeShot(still)).includes('dead-area (frame)'));
});

// --- Digits that roll -------------------------------------------------------------------------------

const ROLL = { id: 'n', text: 'count.n', ink: 'light.cream', size: 100 } as const;
/** The pieces of a counter's line: a digit at rest as itself, one on its way as "from>next@share". */
const rolled = (item: Awaited<ReturnType<typeof at>>): string[] => item.lines.map((l) => (l.roll ? `${l.text}>${l.roll.next}@${l.roll.share.toFixed(2)}` : l.text));

test('counter roll: its digits roll as the wheels of a meter, the last place fastest, a higher one as the places below it carry', async () => {
  assert.deepEqual(text({ ...ROLL, count: { from: 0, roll: true } }).count, { from: 0, decimals: 0, roll: true });
  assert.deepEqual(label({ id: 'l', text: 'count.n', target: 'c', fill: 'dark.indigo', ink: 'light.cream', count: { from: 2, roll: true } }).count, { from: 2, decimals: 0, roll: true });

  // A slow count from 7 to 12 over 5 s at one pace: one digit a second. The last place turns all the way, and the
  // tens wheel turns from blank to 1 only while the 9 turns to 0.
  const slow = make([text({ ...ROLL, count: { from: 7, roll: true } })], [countTo('n', { at: 0, to: 12, dur: 5, profile: 'steady' })], 6);
  assert.deepEqual(rolled(await at(slow, 1.5)), ['8>9@0.50'], 'half way from 8 to 9: the 8 half up, the 9 half come');
  assert.deepEqual(rolled(await at(slow, 2.25)), ['>1@0.25', '9>0@0.25'], 'a quarter of the carry: the 1 comes in from blank as the 9 turns to 0');
  assert.deepEqual(rolled(await at(slow, 3)), ['>1@0.98', '0'], 'at 10 the last place is at rest, the carry all but through');
  assert.deepEqual(rolled(await at(slow, 5.5)), ['1', '2'], 'and at the end it stands at the number reached');
  assert.equal((await at(slow, 2.25)).number, '9', 'the number as it stands: the digits on their way at the ones they leave');

  // A fast count: the last places change in place, whole digits, while the high ones roll; it ends at rest.
  const fast = make([text({ ...ROLL, count: { from: 0, roll: true } })], [countTo('n', { at: 0, to: 1_000_000, dur: 3 })], 4);
  const mid = await at(fast, 1.5);
  const last = mid.lines[mid.lines.length - 1]!;
  assert.ok(!last.roll && /^\d$/.test(last.text), 'the last place turns faster than the eye follows: a whole digit');
  assert.ok(mid.lines.some((l) => l.roll), 'some higher wheel is on its way');
  const end = await at(fast, 3.5);
  assert.deepEqual([end.number, end.lines.some((l) => l.roll)], ['1,000,000', false]);

  // A sign between groups comes in with the digit before it; the language's own signs; places after the decimal sign.
  const grouped = make([text({ ...ROLL, count: { from: 998, roll: true } })], [countTo('n', { at: 0, to: 1002, dur: 4, profile: 'steady' })], 5);
  assert.deepEqual(rolled(await at(grouped, 1.25)), ['>1@0.25', '>,@0.25', '9>0@0.25', '9>0@0.25', '9>0@0.25']);
  assert.deepEqual(rolled(await at(grouped, 1.25, 'de')), ['>1@0.25', '>.@0.25', '9>0@0.25', '9>0@0.25', '9>0@0.25']);
  const fine = make([text({ ...ROLL, count: { from: 0, decimals: 1, roll: true } })], [countTo('n', { at: 0, to: 0.4, dur: 4, profile: 'steady' })], 5);
  assert.deepEqual(rolled(await at(fine, 1.5)), ['0', '.', '1>2@0.50']);
  // Running down, the wheels turn back.
  const down = make([text({ ...ROLL, count: { from: 10, roll: true } })], [countTo('n', { at: 0, to: 8, dur: 2, profile: 'steady' })], 3);
  assert.deepEqual(rolled(await at(down, 0.25)), ['>1@0.75', '9>0@0.75'], 'a quarter of the way from 10 down to 9');

  // In the picture: the window of a digit on its way holds the two digits, each in part.
  const ink = async (spec: ShotSpec, seconds: number): Promise<Buffer> => {
    const c = compileShot(spec);
    return frameRaw(c, await bakeShot(c), Math.round(seconds * 60), { width: 960, lang: 'en', gpu: false });
  };
  const still = (n: number) => make([text({ ...ROLL, count: { from: n, roll: true } })], [], 6);
  const [eight, nine, half] = [await ink(still(8), 1.5), await ink(still(9), 1.5), await ink(slow, 1.5)];
  assert.ok(!half.equals(eight) && !half.equals(nine), 'half way is neither digit');
});

test('counter roll: what it refuses, that it is opt-in, and what the motion review makes of it', async () => {
  const bad = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, (e: unknown) => e instanceof Error && message.test(e.message), String(message));
  };
  bad(() => text({ ...ROLL, count: { from: 0, roll: 'yes' } as never }), /count\.roll must be true or false/);
  bad(() => text({ ...ROLL, count: { from: -5, roll: true } }), /count\.from: a counter whose digits roll runs between values of 0 or more, got -5/);
  bad(() => text({ ...ROLL, count: { from: 1.25, decimals: 1, roll: true } }), /stops only at whole values of its last place \(1 decimal\), got 1\.25/);
  bad(() => text({ ...ROLL, count: { from: 1e15, roll: true } }), /has at most 15 digits/);
  bad(() => make([text({ ...ROLL, count: { from: 0, roll: true } })], [countTo('n', { at: 0, to: 2.5 })]), /countTo\("n"\) to: a counter whose digits roll stops only at whole values of its last place \(0 decimals\), got 2\.5/);
  bad(() => make([text({ ...ROLL, count: { from: 5, roll: true } })], [countTo('n', { at: 0, to: -1 })]), /runs between values of 0 or more, got -1/);
  // Without roll the same values are fine, as they always were.
  assert.ok(make([text({ ...ROLL, count: { from: -5, decimals: 0 } })], [countTo('n', { at: 0, to: 2.5 })]));

  // Opt-in: a counter without roll says nothing of it and draws no digit on its way; at rest a rolling counter draws
  // what a plain one draws, pixel for pixel.
  const plain = make([text({ ...ROLL, count: 7 })], [countTo('n', { at: 0, to: 12, dur: 5, profile: 'steady' })], 6);
  assert.ok(!JSON.stringify(plain).includes('"roll"'));
  assert.ok((await at(plain, 1.5)).lines.every((l) => l.roll === undefined));
  const pixels = async (spec: ShotSpec, seconds: number): Promise<Buffer> => {
    const c = compileShot(spec);
    return frameRaw(c, await bakeShot(c), Math.round(seconds * 60), { width: 960, lang: 'en', gpu: false });
  };
  const rolling = make([text({ ...ROLL, count: { from: 7, roll: true } })], [countTo('n', { at: 0, to: 12, dur: 5, profile: 'steady' })], 6);
  assert.ok((await pixels(plain, 5.5)).equals(await pixels(rolling, 5.5)));

  // The motion review: digits that roll at one pace between two rests are mechanical; an eased count is sound; a
  // counter that does not roll has no travel of its digits.
  const review = async (spec: ShotSpec): Promise<string[]> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c)).report.findings.filter((f) => f.subject === 'n').map((f) => `${f.kind} ${f.channel}`);
  };
  const run = (count: { from: number; roll?: boolean }, profile: 'ease' | 'steady') => make([text({ ...ROLL, size: 120, count })], [countTo('n', { at: 1, to: 40, dur: 5, profile })], 8);
  assert.deepEqual(await review(run({ from: 0, roll: true }, 'steady')), ['mechanical roll']);
  assert.deepEqual(await review(run({ from: 0, roll: true }, 'ease')), []);
  assert.deepEqual(await review(run({ from: 0 }, 'steady')), []);
});
