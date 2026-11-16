import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import flow from '../examples/flow/scene.ts';
import {
  bakeShot,
  bakeHash,
  cameraAt,
  circle,
  compileShot,
  layer,
  loopPoints,
  Noise,
  reviewMotion,
  reviewPhysics,
  runChecks,
  shot,
  type CameraSpec,
  type MotionReport,
  type ShotSpec,
} from '../src/index.ts';

test('the flow example: a path, a cover, a level, a clip and a hop in one shot, without a finding', async () => {
  const c = compileShot(flow);
  const bake = await bakeShot(c);
  const checks = await runChecks(c, bake, ['en', 'x-long']);
  assert.equal(checks.ok, true);
  assert.deepEqual(checks.issues.map((i) => i.message), [], 'no warnings either: the labels cover nothing');
  const { report } = reviewMotion(c, bake);
  assert.deepEqual(report.findings.map((f) => `${f.kind} ${f.subject}: ${f.detail}`), []);
  assert.deepEqual(reviewPhysics(c, bake).findings, []);
  // The background lives: the camera drifts in the norm on its loop, the layers differ, the particles move.
  assert.ok(report.camera.driftPx > 0.4 && report.camera.driftPx < 0.55, `drift ${report.camera.driftPx}`);
  assert.ok(report.camera.spanPx[0] < 200 && report.camera.spanPx[1] < 90, `the subject stays within ${report.camera.spanPx.join(' x ')} px`);
  assert.deepEqual(report.layers.map((l) => l.id), ['far', 'stage', 'near']);
  assert.ok(report.layers[0]!.driftPx < report.layers[1]!.driftPx && report.layers[1]!.driftPx < report.layers[2]!.driftPx);
  for (const p of report.particles) assert.ok(p.inFrame > 5 && p.speedPx > 0.2 && p.movingShare > 0.95, `${p.id}: ${p.speedPx} px per frame`);
  // And it is deterministic like any shot.
  assert.equal(bakeHash(await bakeShot(compileShot(flow))), bakeHash(bake));
});

// The camera on a free-form path: a long shot keeps its subject framed and
// still drifts at the speed of a short one.

type Cam = NonNullable<Parameters<typeof shot>[0]['camera']>;

function make(camera: Cam, seconds = 19): ShotSpec {
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
      layer({ id: 'far', depth: 1.5, nodes: [circle({ id: 'far-a', at: [0, 0], r: 200, fill: 'mid.violet', idle: { amp: 6, period: 5 } })] }),
      layer({ id: 'stage', depth: 0, nodes: [circle({ id: 'a', at: [0, 0], r: 60, fill: 'accent.aqua', idle: { amp: 6, period: 4 } })] }),
    ],
  });
}

async function review(spec: ShotSpec): Promise<MotionReport> {
  const c = compileShot(spec);
  return reviewMotion(c, await bakeShot(c)).report;
}

function track(spec: ShotSpec): { x: number[]; y: number[]; step: number[] } {
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

const still = { wander: 0 };
const median = (v: number[]): number => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)]!;

test('camera: without a path it is the straight drift it always was, and the shot is the data it always was', () => {
  const spec = make({ at: [8, 30], drift: { speed: 0.455, heading: -14, wander: 14, period: 6 }, pushIn: { from: 1, to: 1.05 } });
  assert.ok(!('path' in spec.camera), 'no path key in a shot that asks for none');
  const c = compileShot(spec);
  const noise = new Noise(spec.seed, 'camera');
  for (const f of [0, 1, 500, 1139]) {
    const t = f / 60;
    const h = (-14 * Math.PI) / 180;
    const cam = cameraAt(c.spec.camera, c.cameraNoise, f, c.frames);
    assert.equal(cam.x, 8 + Math.cos(h) * (0.455 * f) + 14 * noise.n1(t / 6 + 3.1));
    assert.equal(cam.y, 30 + Math.sin(h) * (0.455 * f) + 14 * 0.6 * noise.n1(t / 6 + 57.9));
    assert.equal(cam.zoom, 1 * (1.05 / 1) ** (f / 1139));
  }
});

test('camera path: a closed loop keeps one speed for the whole shot and never leaves its loop', async () => {
  // 19 seconds: on one heading at this speed the camera would travel 513 units, a quarter of the frame.
  const spec = make({ path: { points: loopPoints([0, 0], [90, 34]), closed: true, speed: 0.45 }, drift: still, pushIn: { from: 1, to: 1 } });
  const t = track(spec);
  assert.deepEqual([t.x[0], t.y[0]].map((v) => Math.round(v! * 1e6) / 1e6), [-90, 0], 'it starts at the first point of the path');
  for (const s of t.step) assert.ok(Math.abs(s - 0.45) < 0.005, `step ${s} against 0.45 units per frame`);
  assert.ok(Math.max(...t.x) <= 91 && Math.min(...t.x) >= -91 && Math.max(...t.y) <= 35.5 && Math.min(...t.y) >= -35.5, 'inside the loop');
  const report = await review(spec);
  assert.ok(Math.abs(report.camera.driftPx - 0.45) < 0.01, `median drift ${report.camera.driftPx}`);
  assert.ok(report.camera.spanPx[0] <= 182 && report.camera.spanPx[1] <= 71, `the subject stays within ${report.camera.spanPx.join(' x ')} px`);
  assert.ok(Math.abs(report.camera.travelPx - 0.45 * 1139) < 6, `it travels ${report.camera.travelPx} px all the same`);
  assert.deepEqual(report.findings.filter((f) => f.subject === '(camera)'), []);
  // The layers slide at different speeds: the far one slower than the stage.
  const [far, stage] = report.layers;
  assert.equal(far!.id, 'far');
  assert.ok(far!.driftPx < stage!.driftPx * 0.5 && far!.driftPx > 0.1, `far ${far!.driftPx}, stage ${stage!.driftPx}`);
  // With the wander on top it is still a drift in the norm.
  const wandering = await review(make({ path: { points: loopPoints([0, 0], [90, 34]), closed: true, speed: 0.45 }, drift: { wander: 14, period: 6 } }));
  assert.ok(wandering.camera.driftPx > 0.35 && wandering.camera.driftPx < 0.6, `with wander ${wandering.camera.driftPx}`);
});

test('camera path: on an open path it goes there and back, slowing into each turn, and never jumps', async () => {
  const spec = make({ path: { points: [[-120, 0], [0, -50], [120, 0]], speed: 0.45, turn: 1.6 }, drift: still, pushIn: { from: 1, to: 1 } });
  const t = track(spec);
  assert.ok(Math.abs(t.step[0]! - 0.45) < 0.005, 'the first leg starts at speed');
  assert.ok(Math.max(...t.step) <= 0.455, `never faster than its speed (${Math.max(...t.step)})`);
  assert.ok(Math.min(...t.step) < 0.02, 'it slows to a stop where it turns');
  assert.ok(Math.abs(median(t.step) - 0.45) < 0.01, `most of the time at speed (${median(t.step)})`);
  // The step never changes by more than a ramp allows: no jerk at the turn.
  for (let i = 1; i < t.step.length; i++) assert.ok(Math.abs(t.step[i]! - t.step[i - 1]!) < 0.02, `step change at frame ${i}`);
  assert.ok(Math.max(...t.x) <= 120.001 && Math.min(...t.x) >= -120.001, 'between its two ends');
  // It has turned at least once in 19 s: 240-odd units at 27 units a second is nine seconds a leg.
  const far = t.x.indexOf(Math.max(...t.x));
  assert.ok(far > 300 && far < 800 && t.x[t.x.length - 1]! < 60, 'it came back');
  assert.deepEqual((await review(spec)).findings.filter((f) => f.subject === '(camera)'), []);
});

test('camera path: without a speed it covers the path once over the shot, with the eased ends of its profile', async () => {
  const points: [number, number][] = [[-100, 20], [0, -40], [100, 20]];
  const once = track(make({ path: { points, profile: 'ease', ramp: 0.2 }, drift: still, pushIn: { from: 1, to: 1 } }, 6));
  assert.deepEqual([Math.round(once.x[0]!), Math.round(once.x[once.x.length - 1]!)], [-100, 100]);
  assert.ok(once.step[0]! < 0.05 && once.step[once.step.length - 1]! < 0.05, 'from rest to rest');
  const steady = track(make({ path: { points }, drift: still, pushIn: { from: 1, to: 1 } }, 6));
  const mean = steady.step.reduce((a, b) => a + b, 0) / steady.step.length;
  for (const s of steady.step) assert.ok(Math.abs(s - mean) < 0.01 * mean + 1e-4, 'steady by default');
  // An eased start and stop of the camera is sound; the review has nothing to say.
  const report = await review(make({ path: { points, profile: 'ease' }, drift: still, pushIn: { from: 1, to: 1 } }, 6));
  assert.deepEqual(report.findings.filter((f) => f.subject === '(camera)'), []);
});

test('camera path: what does not go together is refused with a message that says what to change', () => {
  const points = loopPoints([0, 0], 80);
  assert.throws(() => make({ at: [0, 0], path: { points, closed: true, speed: 0.4 } }), /a path replaces camera\.at/);
  assert.throws(() => make({ drift: { speed: 0.5 }, path: { points, closed: true, speed: 0.4 } }), /a path replaces camera\.at, camera\.drift\.speed/);
  assert.throws(() => make({ path: { points, closed: true, speed: 0.4, profile: 'ease' } }), /with a speed the camera keeps that speed/);
  assert.throws(() => make({ path: { points: [[0, 0]], speed: 0.4 } }), /at least two places/);
  assert.throws(() => make({ path: { points, closed: true, speed: 0.4, turn: 2 } }), /turn applies to an open path/);
  assert.throws(() => make({ path: { points: [[0, 0], [0, 0]] } }), /no length/);
  assert.throws(() => make({ path: { points, closed: true, speed: 0.4, bank: 1 } as never }), /unknown option "bank"/);
  // The defaults of a path, as data.
  const spec = make({ path: { points: [[0, 0], [50, 0]] } });
  const path = (spec.camera as CameraSpec).path!;
  assert.deepEqual([path.closed, path.smooth, path.speed, path.profile, path.turn], [false, 1, null, 'steady', 1.6]);
});
