import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, compileShot, evaluate, IntentError, layer, rect, reviewMotion, shot, turnTo, type Key, type ShotSpec } from '../src/index.ts';

// A turn with a speed profile: a wheel that spins at one speed, starts from rest, or comes to rest.

function make(timeline: Key[], seconds = 6): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 3,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes: [rect({ id: 'wheel', w: 300, h: 300, fill: 'accent.aqua' })] })],
    timeline,
  });
}

/** The rotation of the wheel in degrees at a moment. */
async function turned(spec: ShotSpec): Promise<(seconds: number) => number> {
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  return (seconds) => {
    const item = evaluate(c, bake, Math.round(seconds * 60), 'en').layers[0]!.items[0]!;
    assert.ok(item.kind === 'shape');
    return (item.xf.rot * 180) / Math.PI;
  };
}

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

test('spin: a turnTo without a profile is the key it was; with one it carries its profile, and a speed is a turn by so many degrees', () => {
  assert.deepEqual(turnTo('a', { at: 2, to: 90 }), { kind: 'turnTo', target: 'a', at: 2, to: 90, dur: 0.8, overshoot: 0.1 });
  assert.deepEqual(turnTo('a', { at: 2, to: 720, dur: 10, profile: 'steady' }), { kind: 'turnTo', target: 'a', at: 2, to: 720, dur: 10, overshoot: 0, profile: 'steady' });
  assert.deepEqual(turnTo('a', { at: 2, to: 90, profile: 'ease' }), { kind: 'turnTo', target: 'a', at: 2, to: 90, dur: 0.8, overshoot: 0, profile: 'ease', ramp: 0.3 });
  // A speed: degrees per second on the steady stretch, from where the node is. Steady unless a profile is named.
  assert.deepEqual(turnTo('a', { at: 0, speed: 72, dur: 5 }), { kind: 'turnTo', target: 'a', at: 0, to: 0, dur: 5, overshoot: 0, profile: 'steady', by: 360 });
  const out = turnTo('a', { at: 0, speed: 72, dur: 6, profile: 'out' });
  assert.ok(out.profile === 'out' && near(out.by!, 72 * 6 * 0.85), 'an eased end covers half of what the steady stretch would in its time');
  assert.equal(turnTo('a', { at: 0, speed: -90, dur: 2 }).by, -180, 'a negative speed turns the other way');

  const bad = (opts: object, message: RegExp): void => {
    assert.throws(() => turnTo('a', opts as never), (e: unknown) => e instanceof IntentError && message.test(e.message), String(message));
  };
  bad({ at: 0 }, /give either to \(an angle in degrees\) or speed/);
  bad({ at: 0, to: 90, speed: 30 }, /give either to \(an angle in degrees\) or speed/);
  bad({ at: 0, to: 90, profile: 'steady', overshoot: 0.1 }, /a turn with a profile has no overshoot/);
  bad({ at: 0, to: 90, ramp: 0.2 }, /ramp applies to the profiles ease, in and out/);
  bad({ at: 0, to: 90, profile: 'steady', ramp: 0.2 }, /ramp applies to the profiles ease, in and out/);
  bad({ at: 0, to: 90, profile: 'settle' }, /profile must be one of ease, steady, in, out/);
  bad({ at: 0, to: 90, turns: 2 }, /turnTo\("a"\): unknown option "turns" \(allowed: at, to, speed, speeds, dur, overshoot, profile, ramp, sound\)/);
});

test('spin: steady is one speed, ease goes from rest to rest, and two keys with one speed join without a step', async () => {
  // Ten revolutions at one speed: six degrees a frame, from the first frame to the last.
  const steady = await turned(make([turnTo('wheel', { at: 1, to: 3600, dur: 10 / 2.5, profile: 'steady' })]));
  assert.deepEqual([steady(0.5), steady(1)], [0, 0]);
  const step = steady(2 + 1 / 60) - steady(2);
  assert.ok(near(step, 15, 1e-4), `${step} degrees a frame`);
  for (const t of [1, 1.5, 3, 4.9]) assert.ok(near(steady(t + 1 / 60) - steady(t), step, 1e-4), `at ${t} s`);
  assert.ok(near(steady(5), 3600, 1e-3) && near(steady(5.9), 3600, 1e-3), 'it arrives at its angle and stays');
  // From rest to rest: slow at both ends, half-way in the middle, no overshoot.
  const eased = await turned(make([turnTo('wheel', { at: 1, to: 180, dur: 2, profile: 'ease' })]));
  assert.ok(eased(1.1) < 2 && near(eased(2), 90, 1e-3) && eased(2.9) > 178 && eased(2.9) <= 180 && near(eased(3.5), 180, 1e-3));
  let top = 0;
  for (let f = 60; f <= 200; f++) top = Math.max(top, eased(f / 60));
  assert.ok(top <= 180 + 1e-6, 'it never passes its angle');
  // Without a profile: the turn that shoots past and settles, as ever.
  const settle = await turned(make([turnTo('wheel', { at: 1, to: 180, dur: 2 })]));
  let past = 0;
  for (let f = 60; f <= 200; f++) past = Math.max(past, settle(f / 60));
  assert.ok(past > 185, `it reaches ${past}`);

  // A spin, and then a slowing down at the same speed: the step from frame to frame does not jump where they meet.
  const wheel = await turned(make([turnTo('wheel', { at: -2, speed: 72, dur: 5 }), turnTo('wheel', { at: 3, speed: 72, dur: 2.5, profile: 'out' })]));
  assert.ok(near(wheel(0), 144, 1e-3), 'under way at the first frame: two seconds of it lie before the shot');
  const before = wheel(3) - wheel(3 - 1 / 60);
  const after = wheel(3 + 2 / 60) - wheel(3 + 1 / 60);
  assert.ok(near(before, 1.2, 1e-4) && near(after, 1.2, 1e-3), `${before} then ${after} degrees a frame`);
  assert.ok(near(wheel(5.9), 360 + 72 * 2.5 * 0.85, 1e-3) && wheel(5.4) - wheel(5.4 - 1 / 60) < 0.2, 'and it comes to rest');
  // From rest and on at speed.
  const start = await turned(make([turnTo('wheel', { at: 1, speed: 72, dur: 2, profile: 'in' }), turnTo('wheel', { at: 3, speed: 72, dur: 2 })]));
  assert.ok(start(1.05) < 0.2 && near(start(3 + 1 / 60) - start(3), 1.2, 1e-3) && near(start(3) - start(3 - 1 / 60), 1.2, 1e-3));
});

test('spin: the motion review judges it: one speed between two rests in view is mechanical, an eased turn and a spin that never rests are clean', async () => {
  const flagged = async (timeline: Key[]): Promise<string[]> => {
    const c = compileShot(make(timeline));
    return reviewMotion(c, await bakeShot(c))
      .report.findings.filter((f) => f.subject === 'wheel')
      .map((f) => `${f.kind} ${f.channel}`)
      .sort();
  };
  assert.deepEqual(await flagged([turnTo('wheel', { at: 1, to: 360, dur: 2, profile: 'ease' })]), []);
  // A wheel that is under way when the shot starts, and slows to rest: clean.
  assert.deepEqual(await flagged([turnTo('wheel', { at: -1, speed: 72, dur: 4 }), turnTo('wheel', { at: 3, speed: 72, dur: 2.5, profile: 'out' })]), []);
  // From rest to rest with one speed for most of the way: eased ends do not hide that it is mechanical.
  assert.deepEqual(await flagged([turnTo('wheel', { at: 1, speed: 72, dur: 2, profile: 'in' }), turnTo('wheel', { at: 3, speed: 72, dur: 2, profile: 'out' })]), ['mechanical rotation']);
  const steady = await flagged([turnTo('wheel', { at: 1, to: 360, dur: 2, profile: 'steady' })]);
  assert.deepEqual(steady, ['mechanical rotation'], 'one speed between two rests in view');
  // A wheel that turns through the whole shot is a flow.
  assert.deepEqual(await flagged([turnTo('wheel', { at: -1, speed: 40, dur: 8 })]), []);
});
