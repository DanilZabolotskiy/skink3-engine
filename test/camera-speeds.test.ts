// Keyed speeds of the camera: a drift or a path whose speed changes over the
// shot along smooth keys, with the parallax of the layers following, and the
// motion review judging its starts and stops.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, cameraAt, circle, compileShot, layer, loopPoints, reviewMotion, shot, type MotionReport, type ShotSpec } from '../src/index.ts';

type Cam = NonNullable<Parameters<typeof shot>[0]['camera']>;

function make(camera: Cam, seconds = 10): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 7,
    palette,
    strings: { en: { 'label.a': 'A label' } },
    background: { inner: 'deep.night', outer: 'deep.abyss' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera,
    layers: [
      layer({ id: 'far', depth: 1.5, nodes: [circle({ id: 'far-a', at: [0, 0], r: 200, fill: 'mid.violet' })] }),
      layer({ id: 'stage', depth: 0, nodes: [circle({ id: 'a', at: [0, 0], r: 60, fill: 'accent.aqua' })] }),
    ],
  });
}

/** The step of the camera from each frame to the next, in units. */
function steps(spec: ShotSpec): { x: number[]; y: number[]; step: number[] } {
  const c = compileShot(spec);
  const x: number[] = [];
  const y: number[] = [];
  const step: number[] = [];
  for (let f = 0; f < c.frames; f++) {
    const cam = cameraAt(c.spec.camera, c.cameraNoise, f, c.frames);
    x.push(cam.x);
    y.push(cam.y);
    if (f > 0) step.push(Math.hypot(cam.x - x[f - 1]!, cam.y - y[f - 1]!));
  }
  return { x, y, step };
}

async function review(spec: ShotSpec): Promise<MotionReport> {
  const c = compileShot(spec);
  return reviewMotion(c, await bakeShot(c)).report;
}

const still = { wander: 0 };
const flat = { from: 1, to: 1 };

test('camera speeds: a shot that gives none is the data it always was', () => {
  const plain = make({ drift: { speed: 0.5, heading: 0, wander: 0 } });
  assert.ok(!('speeds' in plain.camera.drift), 'no speeds key in a drift that asks for none');
  const path = make({ path: { points: loopPoints([0, 0], 80), closed: true, speed: 0.4 }, drift: still });
  assert.ok(!('speeds' in path.camera.path!), 'no speeds key in a path that asks for none');
  // And the drift without them is the straight drift at its one speed, to the last bit.
  const c = compileShot(plain);
  for (const f of [0, 1, 300, 599]) assert.equal(cameraAt(c.spec.camera, c.cameraNoise, f, c.frames).x, 0.5 * f);
});

test('camera speeds: the drift rides at one speed, steps up to a much higher one smoothly and keeps it', async () => {
  // 30 units per second (0.5 a frame) for 4 s, then up to 240 (4 a frame) over 2 s, kept to the end.
  const spec = make({ drift: { heading: 0, speeds: [[0, 30], [4, 30], [6, 240]], ...still }, pushIn: flat });
  assert.deepEqual(spec.camera.drift.speeds, [[0, 30], [4, 30], [6, 240]]);
  const t = steps(spec);
  for (let f = 0; f < 240; f++) assert.ok(Math.abs(t.step[f]! - 0.5) < 1e-9, `step ${f}: ${t.step[f]}`);
  for (let f = 361; f < t.step.length; f++) assert.ok(Math.abs(t.step[f]! - 4) < 1e-9, `step ${f}: ${t.step[f]}`);
  // Between the two it only speeds up, and never by much in one frame: the step has no kink.
  for (let f = 1; f < t.step.length; f++) {
    assert.ok(t.step[f]! >= t.step[f - 1]! - 1e-9, `it never slows (frame ${f})`);
    assert.ok(t.step[f]! - t.step[f - 1]! < 0.06, `no jolt at frame ${f}`);
  }
  // The distance is what the speeds add up to: 4 s at 30, 2 s at their mean, the rest at 240.
  assert.ok(Math.abs(t.x[599]! - (4 * 30 + 2 * 135 + (599 / 60 - 6) * 240)) < 1e-6);
  // The layers follow with their parallax: the far one slides slower, and the review has nothing to say of the camera.
  const report = await review(spec);
  assert.deepEqual(report.findings.filter((f) => f.subject === '(camera)').map((f) => f.kind), []);
  const [far, stage] = report.layers;
  assert.ok(far!.driftPx < stage!.driftPx * 0.6 && far!.driftPx > 0.1, `far ${far!.driftPx}, stage ${stage!.driftPx}`);
});

test('camera speeds: round and round a closed path, and from rest to rest along an open one', async () => {
  const loop = steps(make({ path: { points: loopPoints([0, 0], [90, 34]), closed: true, speeds: [[0, 12], [3, 48]] }, drift: still, pushIn: flat }));
  assert.ok(Math.abs(loop.step[0]! - 0.2) < 0.01 && Math.abs(loop.step[loop.step.length - 1]! - 0.8) < 0.01, 'from 12 to 48 units a second');
  assert.ok(Math.max(...loop.x) <= 91 && Math.min(...loop.x) >= -91 && Math.max(...loop.y) <= 35.5 && Math.min(...loop.y) >= -35.5, 'it never leaves its loop');
  // An open path 240 units long, covered in 6 s from rest to rest.
  const spec = make({ path: { points: [[-120, 0], [120, 0]], speeds: [[0, 0], [2, 60], [4, 60], [6, 0]] }, drift: still, pushIn: flat }, 6);
  const open = steps(spec);
  assert.equal(open.x[0], -120);
  assert.ok(open.x[open.x.length - 1]! > 119.99 && open.x[open.x.length - 1]! <= 120, `it ends at the end: ${open.x[open.x.length - 1]}`);
  assert.ok(open.step[0]! < 0.01 && open.step[open.step.length - 1]! < 0.01, 'from rest to rest');
  assert.deepEqual((await review(spec)).findings.filter((f) => f.subject === '(camera)').map((f) => f.kind), []);
});

test('camera speeds: the motion review catches a camera that leaps from rest to speed, and not one that eases into it', async () => {
  // At rest for 2 s, then 8 units a frame within a hundredth of a second.
  const leap = await review(make({ drift: { heading: 0, speeds: [[0, 0], [2, 0], [2.01, 480]], ...still }, pushIn: flat }, 5));
  const found = leap.findings.filter((f) => f.subject === '(camera)');
  assert.ok(found.some((f) => f.kind === 'abrupt-start'), `found ${found.map((f) => f.kind).join(', ')}`);
  // The same speed reached over two seconds is a sound start.
  const ease = await review(make({ drift: { heading: 0, speeds: [[0, 0], [2, 0], [4, 480]], ...still }, pushIn: flat }, 5));
  assert.deepEqual(ease.findings.filter((f) => f.subject === '(camera)').map((f) => f.kind), []);
});

test('camera speeds: what does not go together is refused with a message that says what to change', () => {
  const points = loopPoints([0, 0], 80);
  assert.throws(() => make({ drift: { speed: 0.5, speeds: [[0, 30], [2, 60]] } }), /leave speed out/);
  assert.throws(() => make({ path: { points, closed: true, speeds: [[0, 30], [2, 60]] }, drift: { speeds: [[0, 30], [2, 60]] } }), /give camera\.path\.speeds/);
  for (const extra of [{ speed: 0.4 }, { profile: 'ease' as const }, { ramp: 0.2 }, { turn: 2 }]) {
    assert.throws(() => make({ path: { points: [[0, 0], [400, 0]], speeds: [[0, 30], [2, 60]], ...extra } }), /leave speed, profile, ramp and turn out/);
  }
  assert.throws(() => make({ drift: { speeds: [[0, 30]] } }), /at least two keys/);
  assert.throws(() => make({ drift: { speeds: [[1, 30], [2, 60]] } }), /first key of speeds is at 0 seconds/);
  assert.throws(() => make({ drift: { speeds: [[0, 30], [2, 60], [2, 90]] } }), /in order of time/);
  assert.throws(() => make({ drift: { speeds: [[0, -30], [2, 60]] } }), /speeds\[0\]\[1\]/);
  assert.throws(() => make({ drift: { speeds: [[0, 30], [2, 60, 1]] as never } }), /speeds\[1\] must be \[seconds, units per second\]/);
  // An open path that the speeds would run past: the numbers say by how much.
  assert.throws(() => make({ path: { points: [[-100, 0], [100, 0]], speeds: [[0, 30], [2, 60]] } }), /carry the camera 569\.0 units by the last frame \(9\.98 s\), and the open path is 200\.0 units long/);
});
