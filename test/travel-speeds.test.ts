import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, circle, compileShot, evaluate, IntentError, layer, reviewMotion, shot, travel, type Key, type ShotSpec, type Vec2 } from '../src/index.ts';

// A travel whose speed changes on the way: keys of speed over time, joined smoothly.

/** A straight way of 1000 units from left to right. */
const WAY: Vec2[] = [[-500, 0], [500, 0]];

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
    layers: [layer({ id: 'stage', depth: 0, nodes: [circle({ id: 'bead', at: WAY[0]!, r: 30, fill: 'accent.aqua' })] })],
    timeline,
  });
}

/** How far along the way the bead is at a moment, in units. */
async function gone(spec: ShotSpec): Promise<(seconds: number) => number> {
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  return (seconds) => {
    const item = evaluate(c, bake, Math.round(seconds * 60), 'en').layers[0]!.items[0]!;
    assert.ok(item.kind === 'shape');
    return item.xf.x + 500;
  };
}

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

test('travel speeds: the key carries its speeds, and its length in time is the time the way takes at them', () => {
  const plain = travel('bead', { at: 1, path: WAY, speed: 250 });
  assert.equal('speeds' in plain, false, 'a travel at one speed is the key it was');
  // 100 units a second, 300 from the second second on: 400 units in the first two seconds, 600 in the next two.
  const key = travel('bead', { at: 1, path: WAY, speeds: [[0, 100], [2, 300]] });
  assert.deepEqual([key.speeds, key.dur, key.profile], [[[0, 100], [2, 300]], 4, 'steady']);
  // The way ends inside the keys: the travel ends there.
  assert.ok(near(travel('bead', { at: 1, path: [[0, 0], [300, 0]], speeds: [[0, 100], [10, 100]] }).dur, 3, 1e-9));
  // Round a closed path twice: twice the way.
  const loop = travel('bead', { at: 0, path: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true, smooth: 0, loops: 2, speeds: [[0, 100], [1, 100]] });
  assert.ok(near(loop.dur, 8, 1e-9));

  const bad = (opts: object, message: RegExp): void => {
    assert.throws(() => travel('bead', { at: 0, path: WAY, ...opts } as never), (e: unknown) => e instanceof IntentError && message.test(e.message), String(message));
  };
  bad({ speeds: [[0, 100], [2, 300]], speed: 200 }, /speeds says how fast the travel goes at every moment; leave speed, dur, profile and ramp out/);
  bad({ speeds: [[0, 100], [2, 300]], dur: 3 }, /leave speed, dur, profile and ramp out/);
  bad({ speeds: [[0, 100], [2, 300]], profile: 'ease' }, /leave speed, dur, profile and ramp out/);
  bad({ speeds: [[0, 100]] }, /speeds must be a list of at least two keys/);
  bad({ speeds: [[1, 100], [2, 300]] }, /the first key of speeds is at 0 seconds/);
  bad({ speeds: [[0, 100], [2, 300], [2, 400]] }, /the keys of speeds must be in order of time; key 2 is at 2 s, after 2 s/);
  bad({ speeds: [[0, 100], [2, 0]] }, /speeds\[1\]\[1\] must be a number in 0\.001\.\.100000/);
  bad({ speeds: [[0, 100], [2]] }, /speeds\[1\] must be \[seconds, units per second\]/);
  bad({}, /give either speed \(units per second\) or dur \(seconds\), or speeds/);
});

test('travel speeds: the speed is what the keys say at their moments, changes smoothly between them, and stays after the last', async () => {
  const at = await gone(make([travel('bead', { at: 1, path: WAY, speeds: [[0, 100], [2, 300]] })]));
  assert.deepEqual([at(0.5), at(1)], [0, 0]);
  // Half-way through the change it has gone 137.5 units: 100 a second and a quarter of the gain so far.
  assert.ok(near(at(2), 137.5, 1e-3) && near(at(3), 400, 1e-3) && near(at(4), 700, 1e-3) && near(at(5), 1000, 1e-3) && near(at(6), 1000, 1e-3));
  const step = (t: number): number => at(t + 1 / 60) - at(t);
  assert.ok(near(step(1), 100 / 60, 0.02), `it starts at 100 a second: ${step(1) * 60}`);
  assert.ok(near(step(2), 200 / 60, 0.05), 'half-way between the keys: half-way between the speeds');
  assert.ok(near(step(3.5), 300 / 60, 1e-3) && near(step(4.9), 300 / 60, 1e-3), 'after the last key the speed stays');
  // No kink: from frame to frame the speed changes by little, everywhere on the way.
  for (let f = 61; f < 298; f++) {
    const jerk = Math.abs(step(f / 60) - step((f - 1) / 60));
    assert.ok(jerk < 0.06, `frame ${f}: the step changes by ${jerk}`);
  }
  // Faster and faster: three keys, each speed reached at its moment.
  const faster = await gone(make([travel('bead', { at: 0, path: WAY, speeds: [[0, 60], [2, 180], [4, 420]] })]));
  const speedAt = (t: number): number => (faster(t + 1 / 60) - faster(t)) * 60;
  assert.ok(near(speedAt(0), 60, 1.5) && near(speedAt(2), 180, 1.5) && near(speedAt(3.9), 420, 6));
  // A wheel on the way turns as far as it has gone.
  const c = compileShot(make([travel('bead', { at: 0, path: WAY, speeds: [[0, 100], [2, 300]], roll: 30 })]));
  const bake = await bakeShot(c);
  const rot = (seconds: number): number => {
    const item = evaluate(c, bake, Math.round(seconds * 60), 'en').layers[0]!.items[0]!;
    return item.kind === 'shape' ? item.xf.rot : NaN;
  };
  assert.ok(near(rot(1), 137.5 / 30, 1e-3) && near(rot(4), 1000 / 30, 1e-3));
});

test('travel speeds: the motion review judges it as a travel: a start at speed from rest in view is found, a start from next to nothing is not', async () => {
  const flagged = async (speeds: [number, number][]): Promise<string[]> => {
    // The way leaves the frame, so only its start is judged.
    const c = compileShot(make([travel('bead', { at: 1, path: [[-500, 0], [1300, 0]], speeds })]));
    return reviewMotion(c, await bakeShot(c))
      .report.findings.filter((f) => f.subject === 'bead')
      .map((f) => f.kind)
      .sort();
  };
  assert.deepEqual(await flagged([[0, 4], [1.5, 500]]), []);
  assert.deepEqual(await flagged([[0, 600], [1.5, 620]]), ['abrupt-start']);
});
