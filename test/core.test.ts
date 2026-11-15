import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overshootStep, SecondOrder, SPRING_PRESETS, springParams } from '../src/core/dynamics.ts';
import { ease, EASINGS, type EaseName } from '../src/core/easing.ts';
import { hashOf, stableStringify } from '../src/core/hash.ts';
import { quadAt, quadSub, xfApply, xfCompose, type Quad } from '../src/core/math.ts';
import { Noise } from '../src/core/noise.ts';
import { Rng } from '../src/core/rng.ts';
import { FPS, frameCount, frameToSeconds, secondsToFrame, SIM_DT, SUBSTEPS } from '../src/core/time.ts';

test('time: 60 fps and a 1/240 s simulation step', () => {
  assert.equal(FPS, 60);
  assert.equal(SIM_DT, 1 / 240);
  assert.equal(SUBSTEPS * SIM_DT, 1 / FPS);
  assert.equal(secondsToFrame(7.5), 450);
  assert.equal(frameToSeconds(450), 7.5);
  assert.equal(frameCount(15), 900);
});

test('rng: the same seed and name give the same numbers', () => {
  const a = new Rng(42, 'x');
  const b = new Rng(42, 'x');
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
});

test('rng: streams are independent of each other and of consumption order', () => {
  const root = new Rng(7);
  const first = root.stream('particles').next();
  // Consuming another stream, or the root itself, must not move this one.
  const again = new Rng(7);
  for (let i = 0; i < 50; i++) again.next();
  again.stream('camera').next();
  assert.equal(again.stream('particles').next(), first);
  assert.notEqual(new Rng(7).stream('camera').next(), first);
  assert.notEqual(new Rng(8).stream('particles').next(), first);
});

test('rng: ranges and helpers stay in bounds', () => {
  const r = new Rng('bounds');
  let sum = 0;
  for (let i = 0; i < 2000; i++) {
    const x = r.next();
    assert.ok(x >= 0 && x < 1);
    sum += x;
    const n = r.int(3, 6);
    assert.ok(Number.isInteger(n) && n >= 3 && n <= 6);
    const y = r.range(-2, 5);
    assert.ok(y >= -2 && y < 5);
    assert.ok(Math.abs(r.sign()) === 1);
  }
  assert.ok(Math.abs(sum / 2000 - 0.5) < 0.03, 'uniform mean');
  assert.deepEqual(r.shuffle([1, 2, 3, 4]).sort(), [1, 2, 3, 4]);
  assert.throws(() => r.pick([]));
});

test('noise: deterministic, bounded and smooth', () => {
  const a = new Noise(3, 'n');
  const b = new Noise(3, 'n');
  let maxStep = 0;
  let prev = a.n1(0);
  let lo = 1;
  let hi = -1;
  for (let i = 1; i <= 4000; i++) {
    const x = i * 0.01;
    const v = a.n1(x);
    assert.equal(v, b.n1(x));
    assert.ok(v >= -1 && v <= 1);
    maxStep = Math.max(maxStep, Math.abs(v - prev));
    prev = v;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    const w = a.n2(x, x * 0.37);
    assert.ok(w >= -1 && w <= 1);
  }
  assert.ok(maxStep < 0.06, `1D noise is continuous (max step ${maxStep})`);
  assert.ok(hi > 0.3 && lo < -0.3, 'the noise uses its range');
  assert.notEqual(new Noise(4, 'n').n1(0.37), a.n1(0.37));
  // Integer lattice points of gradient noise are zero.
  assert.equal(a.n1(5), 0);
});

test('easing: every curve starts at 0 and ends at 1', () => {
  for (const name of Object.keys(EASINGS) as EaseName[]) {
    assert.ok(Math.abs(ease(name, 0)) < 1e-9, `${name}(0)`);
    assert.ok(Math.abs(ease(name, 1) - 1) < 1e-9, `${name}(1)`);
    assert.equal(ease(name, -3), ease(name, 0));
    assert.equal(ease(name, 7), ease(name, 1));
  }
  assert.ok(ease('outBack', 0.6) > 1, 'outBack overshoots');
});

test('second-order dynamics: settles on the target, overshoots when underdamped', () => {
  for (const [name, params] of Object.entries(SPRING_PRESETS)) {
    const sys = new SecondOrder(params, [0, 0]);
    let peak = 0;
    for (let i = 0; i < 240 * 8; i++) {
      const y = sys.step(SIM_DT, [1, -2]);
      peak = Math.max(peak, y[0]!);
      assert.ok(Number.isFinite(y[0]!) && Number.isFinite(y[1]!));
    }
    assert.ok(Math.abs(sys.value[0]! - 1) < 0.01, `${name} settles in x`);
    assert.ok(Math.abs(sys.value[1]! + 2) < 0.02, `${name} settles in y`);
    if (params.z < 0.6) assert.ok(peak > 1.05, `${name} overshoots`);
    if (params.z >= 1) assert.ok(peak <= 1.001, `${name} does not overshoot`);
  }
  // A huge time step must not blow up.
  const stiff = new SecondOrder({ f: 30, z: 0.1, r: 0 }, [0]);
  for (let i = 0; i < 100; i++) assert.ok(Math.abs(stiff.step(0.1, [1])[0]!) < 10);
  assert.throws(() => springParams({ f: 0, z: 1, r: 0 }));
  assert.throws(() => springParams('bouncy' as never));
});

test('overshootStep: 0 -> past 1 by the given amount -> exactly 1, smoothly', () => {
  assert.equal(overshootStep(0, 0.2), 0);
  assert.equal(overshootStep(1, 0.2), 1);
  let peak = 0;
  let prev = 0;
  let maxStep = 0;
  for (let i = 1; i <= 1000; i++) {
    const v = overshootStep(i / 1000, 0.2, 0.5);
    peak = Math.max(peak, v);
    maxStep = Math.max(maxStep, Math.abs(v - prev));
    prev = v;
  }
  assert.ok(Math.abs(peak - 1.2) < 0.005, `peak ${peak}`);
  assert.ok(maxStep < 0.01, 'no jumps');
  assert.ok(Math.abs(overshootStep(0.999, 0.2) - 1) < 1e-3, 'lands on 1');
  // No overshoot requested: stays within [0, 1].
  for (let i = 0; i <= 100; i++) assert.ok(overshootStep(i / 100, 0) <= 1);
});

test('math: similarity transforms compose, quadratic sub-curves match the curve', () => {
  const parent = { x: 10, y: 20, rot: Math.PI / 2, scale: 2 };
  const child = { x: 3, y: 0, rot: 0.1, scale: 0.5 };
  const c = xfCompose(parent, child);
  assert.ok(Math.abs(c.x - 10) < 1e-9 && Math.abs(c.y - 26) < 1e-9);
  assert.equal(c.scale, 1);
  const p = xfApply(c, [1, 0]);
  const q = xfApply(parent, xfApply(child, [1, 0]));
  assert.ok(Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9);

  const quad: Quad = [[0, 0], [50, 100], [100, 0]];
  const sub = quadSub(quad, 0.2, 0.7);
  for (const t of [0, 0.3, 1]) {
    const a = quadAt(sub, t);
    const b = quadAt(quad, 0.2 + 0.5 * t);
    assert.ok(Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9);
  }
});

test('hash: independent of key order, sensitive to values', () => {
  assert.equal(stableStringify({ b: 1, a: [1, 2, { z: 0, y: 'q' }] }), '{"a":[1,2,{"y":"q","z":0}],"b":1}');
  assert.equal(hashOf({ a: 1, b: 2 }), hashOf({ b: 2, a: 1 }));
  assert.notEqual(hashOf({ a: 1, b: 2 }), hashOf({ a: 1, b: 3 }));
  assert.throws(() => stableStringify({ f: () => 1 }));
  assert.throws(() => stableStringify({ x: NaN }));
});
