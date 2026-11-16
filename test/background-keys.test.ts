import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  backgroundTo,
  bakeShot,
  circle,
  compileShot,
  evaluate,
  formatMotionReport,
  frameRaw,
  heightFor,
  hexToHsv,
  IntentError,
  layer,
  moveTo,
  resolveColor,
  reviewMotion,
  sceneEvents,
  shot,
  type Key,
  type ShotSpec,
} from '../src/index.ts';

// Background keys: the gradient of a shot, the colour its far layers fade toward and its vignette change at moments of the timeline.

const WIDTH = 480;

function make(timeline: Key[], seconds = 6, extra: object = {}): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 5,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.abyss' },
    atmosphere: 'mid.rose',
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [
      layer({ id: 'far', depth: 2, blur: 0, nodes: [circle({ id: 'hill', at: [-500, 200], r: 160, fill: 'accent.amber', lit: false })] }),
      layer({ id: 'stage', depth: 0, nodes: [circle({ id: 'dot', r: 60, fill: 'accent.aqua', lit: false })] }),
    ],
    timeline,
    ...extra,
  });
}

const hex = (ref: string): string => resolveColor(palette, ref);

/** The colour of the pixel at a place of the stage, at a frame, as [r, g, b]. */
async function pixel(spec: ShotSpec, frame: number, x: number, y: number): Promise<[number, number, number]> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
  const k = WIDTH / 1920;
  const o = (Math.round(heightFor(WIDTH) / 2 + y * k) * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4;
  return [raw[o]!, raw[o + 1]!, raw[o + 2]!];
}

async function hash(spec: ShotSpec, frame: number): Promise<string> {
  const c = compileShot(spec);
  return createHash('sha256').update(await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false })).digest('hex');
}

/** The background of a shot at a moment, as the evaluator gives it. */
async function at(spec: ShotSpec, seconds: number): Promise<NonNullable<ReturnType<typeof evaluate>['background']>> {
  const c = compileShot(spec);
  const state = evaluate(c, await bakeShot(c), Math.round(seconds * 60), 'en');
  assert.ok(state.background, 'a shot with a background key says what its background is at each frame');
  return state.background;
}

const rgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const close = (a: readonly number[], b: readonly number[], eps: number): boolean => a.every((v, i) => Math.abs(v - b[i]!) <= eps);

test('background keys: backgroundTo is a key of the timeline without a node, and it refuses what it does not take', () => {
  assert.deepEqual(backgroundTo({ at: 3, inner: 'deep.ink' }), { kind: 'backgroundTo', target: null, at: 3, dur: 2, inner: 'deep.ink', profile: 'ease', ramp: 0.3 });
  assert.deepEqual(backgroundTo({ at: 3, dur: 4, outer: 'deep.abyss', center: [0.5, 0.8], radius: 1, atmosphere: 'mid.ocean', vignette: 0.7, profile: 'out', ramp: 0.2 }), {
    kind: 'backgroundTo', target: null, at: 3, dur: 4, outer: 'deep.abyss', center: [0.5, 0.8], radius: 1, atmosphere: 'mid.ocean', vignette: 0.7, profile: 'out', ramp: 0.2,
  });
  const bad = (opts: object, message: RegExp): void => {
    assert.throws(() => backgroundTo({ at: 1, ...opts } as never), (e: unknown) => e instanceof IntentError && message.test(e.message), String(message));
  };
  bad({}, /give what changes: inner, outer, center, radius, atmosphere or vignette/);
  bad({ inner: '#102030' }, /inner must be a palette reference "role\.name" such as "deep\.night", got "#102030"\. Raw colour values are not accepted/);
  bad({ atmosphere: 7 }, /atmosphere must be a palette reference/);
  bad({ inner: 'deep.ink', dur: 0.05 }, /dur must be a number in 0\.1\.\.600/);
  bad({ inner: 'deep.ink', profile: 'settle' }, /profile must be one of ease, steady, in, out/);
  bad({ inner: 'deep.ink', profile: 'steady', ramp: 0.2 }, /ramp applies to the profiles ease, in and out/);
  bad({ vignette: 2 }, /vignette must be a number in 0\.\.1/);
  bad({ inner: 'deep.ink', colour: 'x' }, /backgroundTo: unknown option "colour" \(allowed: at, dur, inner, outer, center, radius, atmosphere, vignette, profile, ramp\)/);
  // The shot refuses a colour its palette does not have, and a key after its end.
  assert.throws(() => make([backgroundTo({ at: 1, inner: 'deep.sea' })]), /backgroundTo at 1 s: inner: .*deep\.sea/);
  assert.throws(() => make([backgroundTo({ at: 9, inner: 'deep.ink' })]), /backgroundTo starts at 9 s, after the shot ends \(6 s\)/);
});

test('background keys: a shot without them is the shot it was', async () => {
  const c = compileShot(make([]));
  assert.equal(c.backgroundTrack, null);
  const state = evaluate(c, await bakeShot(c), 60, 'en');
  assert.equal('background' in state, false, 'the state of a frame carries no background');
  // A key leaves the frames before it as they were: pixel for pixel those of the shot without it.
  const keyed = make([backgroundTo({ at: 2, dur: 2, inner: 'deep.ink', outer: 'deep.ink', atmosphere: 'mid.ocean', vignette: 0.2 })]);
  for (const frame of [0, 60, 120]) assert.equal(await hash(keyed, frame), await hash(make([]), frame), `frame ${frame}`);
  assert.notEqual(await hash(keyed, 180), await hash(make([]), 180));
});

test('background keys: the colours run from one to the other round the colour wheel, arrive exactly, and keys chain', async () => {
  const spec = make([backgroundTo({ at: 1, dur: 2, inner: 'accent.amber', outer: 'accent.azure' })]);
  assert.deepEqual(await at(spec, 0.5), { inner: hex('deep.night'), outer: hex('deep.abyss'), center: [0.5, 0.46], radius: 0.72, atmosphere: hex('mid.rose'), vignette: 0.5 });
  const end = await at(spec, 3);
  assert.deepEqual([end.inner, end.outer, end.atmosphere], [hex('accent.amber'), hex('accent.azure'), hex('mid.rose')], 'it arrives at the colours of the key; what the key leaves out stays');
  assert.deepEqual(await at(spec, 5), end);
  // Half-way: half-way round the wheel along the short way, not through the middle of it. From violet (262) to amber (40)
  // the short way runs through red, and the colour keeps its saturation.
  const mid = hexToHsv((await at(spec, 2)).inner);
  const a = hexToHsv(hex('deep.night'));
  const b = hexToHsv(hex('accent.amber'));
  assert.ok(Math.abs(mid.h - 331) < 2, `hue ${mid.h}`);
  assert.ok(Math.abs(mid.s - (a.s + b.s) / 2) < 0.02 && Math.abs(mid.v - (a.v + b.v) / 2) < 0.02, `saturation ${mid.s}, value ${mid.v}`);
  // From rest to rest: slow at both ends.
  const early = hexToHsv((await at(spec, 1.2)).inner);
  assert.ok(Math.abs(early.v - a.v) < 0.05, 'a fifth of a second in it has hardly begun');

  // Keys chain: the second takes over from what the background is at its moment, also when the first is under way.
  const chained = make([backgroundTo({ at: 1, dur: 2, inner: 'accent.amber' }), backgroundTo({ at: 2, dur: 1, inner: 'deep.ink', vignette: 0.9, center: [0.3, 0.6], radius: 1.2 })]);
  const before = await at(chained, 2);
  assert.equal(before.inner, (await at(spec, 2)).inner, 'at its start nothing has jumped');
  const done = await at(chained, 3);
  assert.deepEqual([done.inner, done.vignette, done.center, done.radius], [hex('deep.ink'), 0.9, [0.3, 0.6], 1.2]);
  const between = await at(chained, 2.5);
  assert.ok(between.vignette > 0.6 && between.vignette < 0.8 && between.radius > 0.9 && between.radius < 1.05 && between.center[0] < 0.45 && between.center[0] > 0.35);
  // A key that starts before the shot is under way at the first frame.
  const underWay = make([backgroundTo({ at: -1, dur: 2, inner: 'accent.amber' })]);
  assert.equal((await at(underWay, 0)).inner, (await at(spec, 2)).inner);
});

test('background keys: the picture follows: the gradient, the tint of the far layers and the vignette', async () => {
  const still = make([], 6, { vignette: 0 });
  const sky = make([backgroundTo({ at: 1, dur: 2, inner: 'deep.ink', outer: 'deep.ink' })], 6, { vignette: 0 });
  // The middle of the sky, away from every node: the colour of the key when it has ended.
  assert.ok(close(await pixel(sky, 300, 300, -400), rgb(hex('deep.ink')), 2), `${await pixel(sky, 300, 300, -400)}`);
  assert.ok(!close(await pixel(still, 300, 300, -400), rgb(hex('deep.ink')), 6));
  // Half-way the pixel is between the two.
  const half = await pixel(sky, 120, 300, -400);
  const from = await pixel(still, 120, 300, -400);
  const to = rgb(hex('deep.ink'));
  assert.ok(half.every((v, i) => v >= Math.min(from[i]!, to[i]!) - 2 && v <= Math.max(from[i]!, to[i]!) + 2) && !close(half, from, 1) && !close(half, to, 1), `${half} between ${from} and ${to}`);

  // The atmosphere: the far layer is tinted toward the atmosphere of the frame.
  const air = make([backgroundTo({ at: 1, dur: 2, atmosphere: 'mid.jade' })], 6, { vignette: 0 });
  const hillBefore = await pixel(air, 30, -500, 200);
  const hillAfter = await pixel(air, 300, -500, 200);
  assert.deepEqual(hillBefore, await pixel(still, 30, -500, 200));
  assert.ok(hillAfter[1]! > hillBefore[1]! + 20 && hillAfter[0]! < hillBefore[0]! - 20, `the far hill turns from rose toward jade: ${hillBefore} -> ${hillAfter}`);
  assert.deepEqual(await pixel(air, 300, 0, 0), await pixel(still, 300, 0, 0), 'the stage is not tinted');
  assert.deepEqual(await pixel(air, 300, 300, -400), await pixel(still, 300, 300, -400), 'and the sky keeps its gradient');

  // The vignette: its strength is keyed, and the corners darken toward the outer colour of the frame.
  const dark = make([backgroundTo({ at: 1, dur: 2, vignette: 1 })], 6, { vignette: 0, background: { inner: 'accent.amber', outer: 'accent.amber' } });
  const corner = await pixel(dark, 300, -940, -520);
  assert.ok(close(corner, rgb(hex('accent.amber')), 3), 'a vignette toward the colour of the sky itself changes nothing');
  const toward = make([backgroundTo({ at: 1, dur: 2, vignette: 1, outer: 'deep.abyss' })], 6, { vignette: 0, background: { inner: 'accent.amber', outer: 'accent.amber' } });
  assert.ok(close(await pixel(toward, 300, -940, -520), rgb(hex('deep.abyss')), 8), `${await pixel(toward, 300, -940, -520)}`);
  assert.ok(close(await pixel(toward, 0, -940, -520), rgb(hex('accent.amber')), 3), 'and before the key the corner is as it was');
});

test('background keys: the motion review knows them: a background that changes is life in every part of the frame, one that changes too slowly to see is a hold', async () => {
  const report = async (spec: ShotSpec): Promise<ReturnType<typeof reviewMotion>['report']> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c)).report;
  };
  const holds = (r: Awaited<ReturnType<typeof report>>): string[] => r.findings.filter((f) => f.kind === 'dead-area').map((f) => `${f.subject} ${f.from}-${f.to}`);
  // Nothing moves for nine seconds: a hold of the whole frame.
  const dead = await report(make([moveTo('dot', { at: 0.1, to: [40, 0], dur: 0.5 })], 9));
  assert.ok(holds(dead).some((h) => h.startsWith('(frame) ')), holds(dead).join('; '));
  assert.equal(dead.background, undefined, 'a shot without background keys reports nothing about its background');
  // The sound scene: the sky turns during the hold. No part of the frame is dead for long.
  const turning = await report(make([moveTo('dot', { at: 0.1, to: [40, 0], dur: 0.5 }), backgroundTo({ at: 2, dur: 5, inner: 'deep.ink', outer: 'deep.ink', atmosphere: 'mid.ocean' })], 9));
  assert.deepEqual(holds(turning), []);
  assert.equal(turning.background!.length, 1);
  assert.ok(turning.background![0]!.from >= 120 && turning.background![0]!.from < 150 && turning.background![0]!.to > 390 && turning.background![0]!.to <= 420, JSON.stringify(turning.background));
  // The planted defect: the same hold, with a change of the sky that is too slow and too small to be seen.
  const creeping = await report(make([moveTo('dot', { at: 0.1, to: [40, 0], dur: 0.5 }), backgroundTo({ at: 2, dur: 6.5, inner: 'deep.ink' })], 9));
  assert.ok(holds(creeping).some((h) => h.startsWith('(frame) ')), holds(creeping).join('; '));
  assert.deepEqual(creeping.background, []);
  const c = compileShot(make([backgroundTo({ at: 2, dur: 6.5, inner: 'deep.ink' })], 9));
  assert.match(formatMotionReport(reviewMotion(c, await bakeShot(c)).report, c), /background: keyed, but it never changes fast enough to be seen/);
  const t = compileShot(make([backgroundTo({ at: 2, dur: 1, inner: 'accent.amber' })], 9));
  // The stretch it names is the one in which the change is fast enough to see: the eased ends of the key are left out.
  assert.match(formatMotionReport(reviewMotion(t, await bakeShot(t)).report, t), /background: changes at 2\.0\d-2\.9\d s/);
  // A background key is no event: it makes no sound.
  assert.deepEqual(sceneEvents(t, await bakeShot(t)), []);
});
