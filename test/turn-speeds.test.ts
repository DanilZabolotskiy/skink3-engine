import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, circle, compileShot, evaluate, IntentError, layer, rect, reviewMotion, shot, travel, turnTo, type Key, type ShotSpec } from '../src/index.ts';

// A turn whose speed is keyed over time: a wheel that slows in steps and turns on, rollers that turn faster and faster.

function make(timeline: Key[], seconds = 8): ShotSpec {
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
    layers: [
      layer({
        id: 'stage',
        depth: 0,
        nodes: [rect({ id: 'wheel', w: 300, h: 300, fill: 'accent.aqua' }), circle({ id: 'bead', at: [-900, 300], r: 30, fill: 'accent.amber' })],
      }),
    ],
    timeline,
  });
}

/** The rotation of a node in degrees at a moment. */
async function turned(spec: ShotSpec, id = 'wheel'): Promise<(seconds: number) => number> {
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  return (seconds) => {
    const item = evaluate(c, bake, Math.round(seconds * 60), 'en').layers[0]!.items.find((i) => i.node.id === id)!;
    assert.ok(item.kind === 'shape');
    return (item.xf.rot * 180) / Math.PI;
  };
}

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

test('turn speeds: the key carries its speeds and the angle they add up to; a turn without them is the key it was', () => {
  // Opt-in: the keys of the turns that were there before are what they were.
  assert.deepEqual(turnTo('a', { at: 2, to: 90 }), { kind: 'turnTo', target: 'a', at: 2, to: 90, dur: 0.8, overshoot: 0.1 });
  assert.deepEqual(turnTo('a', { at: 0, speed: 72, dur: 5 }), { kind: 'turnTo', target: 'a', at: 0, to: 0, dur: 5, overshoot: 0, profile: 'steady', by: 360 });
  // 90 degrees a second, 30 from the second second on: 120 degrees in the two seconds of the change.
  const key = turnTo('a', { at: 1, speeds: [[0, 90], [2, 30]] });
  assert.deepEqual(key, { kind: 'turnTo', target: 'a', at: 1, to: 0, dur: 2, overshoot: 0, by: 120, speeds: [[0, 90], [2, 30]] });
  // A longer dur: after the last key the speed stays.
  assert.ok(near(turnTo('a', { at: 1, speeds: [[0, 90], [2, 30]], dur: 5 }).by!, 120 + 3 * 30, 1e-9));
  // Down to rest, and the other way round.
  assert.ok(near(turnTo('a', { at: 0, speeds: [[0, 60], [3, 0]] }).by!, 90, 1e-9));
  assert.ok(near(turnTo('a', { at: 0, speeds: [[0, -60], [3, 0]] }).by!, -90, 1e-9));

  const bad = (opts: object, message: RegExp): void => {
    assert.throws(() => turnTo('a', { at: 0, ...opts } as never), (e: unknown) => e instanceof IntentError && message.test(e.message), String(message));
  };
  const speeds = [[0, 90], [2, 30]];
  bad({ speeds, to: 90 }, /speeds says how fast the turn goes at every moment; leave to, speed, profile, ramp and overshoot out/);
  bad({ speeds, speed: 40 }, /leave to, speed, profile, ramp and overshoot out/);
  bad({ speeds, profile: 'ease' }, /leave to, speed, profile, ramp and overshoot out/);
  bad({ speeds, ramp: 0.2 }, /leave to, speed, profile, ramp and overshoot out/);
  bad({ speeds, overshoot: 0.1 }, /leave to, speed, profile, ramp and overshoot out/);
  bad({ speeds: [[0, 90]] }, /speeds must be a list of at least two keys \[seconds, degrees per second\]/);
  bad({ speeds: [[1, 90], [2, 30]] }, /the first key of speeds is at 0 seconds: the speed the turn starts with/);
  bad({ speeds: [[0, 90], [2, 30], [2, 10]] }, /the keys of speeds must be in order of time; key 2 is at 2 s, after 2 s/);
  bad({ speeds: [[0, 90], [2]] }, /speeds\[1\] must be \[seconds, degrees per second\]/);
  bad({ speeds: [[0, 90], [2, 1e6]] }, /speeds\[1\]\[1\] must be a number in -100000\.\.100000/);
  bad({ speeds, dur: 1.5 }, /dur \(1\.5 s\) ends the turn before its last key of speed, at 2 s/);
  bad({}, /give either to \(an angle in degrees\) or speed .*, or speeds \(keys of speed over time\)/);
  bad({ speeds, turns: 2 }, /unknown option "turns" \(allowed: at, to, speed, speeds, dur, overshoot, profile, ramp, about, sound\)/);
});

test('turn speeds: the speed is what the keys say at their moments, changes smoothly between them, and stays after the last', async () => {
  const at = await turned(make([turnTo('wheel', { at: 1, speeds: [[0, 90], [2, 30]], dur: 4 })]));
  assert.deepEqual([at(0.5), at(1)], [0, 0]);
  // Half-way through the change: 90 a second for a second, less what the speed has lost by then (the integral of a smooth step).
  assert.ok(near(at(2), 90 - 60 * 2 * (1 / 8 - 1 / 32), 1e-3) && near(at(3), 120, 1e-3) && near(at(4), 150, 1e-3), `${at(2)}, ${at(3)}, ${at(4)}`);
  assert.ok(near(at(5), 180, 1e-3) && near(at(7), 180, 1e-3), 'it ends at the angle the speeds add up to, and stays');
  const step = (t: number): number => at(t + 1 / 60) - at(t);
  assert.ok(near(step(1), 90 / 60, 0.01), `it starts at 90 degrees a second: ${step(1) * 60}`);
  assert.ok(near(step(2), 60 / 60, 0.02), 'half-way between the keys: half-way between the speeds');
  assert.ok(near(step(3.5), 30 / 60, 1e-3) && near(step(4.9), 30 / 60, 1e-3), 'after the last key the speed stays');
  // No kink: from frame to frame the speed changes by little.
  for (let f = 61; f < 298; f++) {
    const jerk = Math.abs(step(f / 60) - step((f - 1) / 60));
    assert.ok(jerk < 0.02, `frame ${f}: the step changes by ${jerk}`);
  }
});

test('turn speeds: a wheel slows in two steps and turns on, and joins the key before it and the key after it without a step', async () => {
  const wheel = await turned(
    make([
      turnTo('wheel', { at: -1, speed: 90, dur: 2 }), // under way when the shot starts
      turnTo('wheel', { at: 1, speeds: [[0, 90], [1, 40], [2.5, 12]], dur: 3 }), // slower, and slower again
      turnTo('wheel', { at: 4, speed: 12, dur: 4 }), // and on
    ]),
  );
  const step = (t: number): number => wheel(t + 1 / 60) - wheel(t);
  assert.ok(near(wheel(0), 90, 1e-3));
  assert.ok(near(step(1 - 2 / 60), 1.5, 1e-3) && near(step(1), 1.5, 0.01), `into the keys at the speed before them: ${step(1)}`);
  assert.ok(near(step(2), 40 / 60, 0.01) && near(step(3.5), 12 / 60, 0.005), `${step(2) * 60}, ${step(3.5) * 60}`);
  assert.ok(near(step(4 - 1 / 60), 0.2, 1e-3) && near(step(4), 0.2, 1e-3) && near(step(6), 0.2, 1e-3), 'and on at the last speed');
  for (let f = 1; f < 470; f++) assert.ok(Math.abs(step(f / 60) - step((f - 1) / 60)) < 0.03, `frame ${f}`);
});

test('turn speeds: a roller turns in step with a thing on the belt whose travel has the same keys', async () => {
  // A belt that speeds up, a bead that rides on it and rolls, and a roller of the same radius under it.
  const r = 30;
  const belt: [number, number][] = [[0, 60], [2, 180], [4, 420]];
  const degrees = (v: number): number => (v / r) * (180 / Math.PI);
  const spec = make([
    travel('bead', { at: 1, path: [[-900, 300], [900, 300]], speeds: belt, roll: r }),
    turnTo('wheel', { at: 1, speeds: belt.map(([t, v]) => [t, degrees(v)] as [number, number]), dur: 5 }),
  ]);
  const roller = await turned(spec);
  const bead = await turned(spec, 'bead');
  for (const t of [1, 1.5, 2.25, 3, 4, 4.75, 5.5]) assert.ok(near(roller(t), bead(t), 1e-2), `at ${t} s: ${roller(t)} against ${bead(t)}`);
  assert.ok(roller(5.5) > 1000, 'and they have turned far');
});

test('turn speeds: the motion review judges it as a turn: a start at speed from rest in view is found; from rest and back to rest, or under way all shot long, it is clean', async () => {
  const flagged = async (timeline: Key[]): Promise<string[]> => {
    const c = compileShot(make(timeline));
    return reviewMotion(c, await bakeShot(c))
      .report.findings.filter((f) => f.subject === 'wheel')
      .map((f) => `${f.kind} ${f.channel}`)
      .sort();
  };
  // The planted defect: the wheel stands, and is at full speed on the next frame.
  assert.deepEqual(await flagged([turnTo('wheel', { at: 1, speeds: [[0, 200], [2, 40], [4, 0]] })]), ['abrupt-start rotation']);
  // And it runs into its rest.
  assert.deepEqual(await flagged([turnTo('wheel', { at: 1, speeds: [[0, 0], [2, 200]], dur: 3 })]), ['abrupt-stop rotation']);
  // Sound scenes: from rest, faster, slower, and to rest.
  assert.deepEqual(await flagged([turnTo('wheel', { at: 1, speeds: [[0, 0], [1.5, 200], [3, 60], [5, 0]] })]), []);
  // A wheel that is already turning when the shot starts and still turns when it ends, slower by then: a flow.
  assert.deepEqual(await flagged([turnTo('wheel', { at: -1, speeds: [[0, 120], [3, 120], [5, 50], [7, 20]], dur: 10 })]), []);
});
