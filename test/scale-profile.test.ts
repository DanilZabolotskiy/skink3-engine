import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { overshootStep } from '../src/core/dynamics.ts';
import {
  bakeShot,
  compileShot,
  evaluate,
  fadeTo,
  frameRaw,
  heightFor,
  IntentError,
  layer,
  moveTo,
  popIn,
  rampProgress,
  rect,
  reviewMotion,
  scaleTo,
  sceneEvents,
  shot,
  travel,
  type Key,
  type LayerSpec,
  type ShotSpec,
  type Vec2,
} from '../src/index.ts';

// A lasting change of size on a profile: scaleTo with profile and ramp.

const WIDTH = 960;

/** A flat square of 200 units in the middle of the frame. */
const SQUARE = { id: 'box', w: 200, h: 200, radius: 0, fill: 'accent.pink', lit: false } as const;

function make(timeline: Key[], seconds = 6, nodes: LayerSpec['nodes'] = [rect(SQUARE)]): ShotSpec {
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
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

interface State {
  readonly x: number;
  readonly y: number;
  /** The even size. */
  readonly scale: number;
  /** The width and the height along the node's own axes, and what its pivot shifts the picture by. */
  readonly sx: number;
  readonly sy: number;
  readonly cx: number;
  readonly cy: number;
}

/** The place and the size of the box at a moment. */
async function watch(spec: ShotSpec): Promise<(seconds: number) => State> {
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  return (seconds) => {
    let item = evaluate(c, bake, Math.round(seconds * 60), 'en').layers[0]!.items[0]!;
    let axes = { sx: 1, sy: 1, cx: 0, cy: 0 };
    if (item.kind === 'stretch') {
      assert.ok(item.axes);
      axes = item.axes;
      item = item.items[0]!;
    }
    assert.ok(item.kind === 'shape');
    return { x: item.xf.x, y: item.xf.y, scale: item.xf.scale, sx: axes.sx, sy: axes.sy, cx: axes.cx, cy: axes.cy };
  };
}

/** The box, in stage units, round the pink pixels of a frame. */
async function box(spec: ShotSpec, seconds: number): Promise<{ x0: number; y0: number; x1: number; y1: number }> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), Math.round(seconds * 60), { width: WIDTH, lang: 'en', gpu: false });
  const h = heightFor(WIDTH);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const o = (y * WIDTH + x) * 4;
      if (!(raw[o]! > 200 && raw[o + 1]! < 140 && raw[o + 2]! > 120)) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const k = 1920 / WIDTH;
  return { x0: x0 * k - 960, y0: y0 * k - 540, x1: (x1 + 1) * k - 960, y1: (y1 + 1) * k - 540 };
}

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

const boxNear = (b: { x0: number; y0: number; x1: number; y1: number }, x0: number, y0: number, x1: number, y1: number, eps = 5): boolean =>
  Math.abs(b.x0 - x0) <= eps && Math.abs(b.y0 - y0) <= eps && Math.abs(b.x1 - x1) <= eps && Math.abs(b.y1 - y1) <= eps;

test('scale profile: a scaleTo without a profile is the key it was; with one it carries its profile and has no overshoot', () => {
  assert.deepEqual(scaleTo('a', { at: 1, to: 2 }), { kind: 'scaleTo', target: 'a', at: 1, to: 2, dur: 0.6, overshoot: 0.15 });
  assert.deepEqual(scaleTo('a', { at: 1, to: [1, 2.5], pivot: [0, 40] }), { kind: 'scaleTo', target: 'a', at: 1, to: 1, dur: 0.6, overshoot: 0.15, axes: [1, 2.5], pivot: [0, 40] });
  assert.deepEqual(scaleTo('a', { at: 1, to: 2, dur: 2, profile: 'ease' }), { kind: 'scaleTo', target: 'a', at: 1, to: 2, dur: 2, overshoot: 0, profile: 'ease', ramp: 0.3 });
  assert.deepEqual(scaleTo('a', { at: 1, to: 0.4, profile: 'in', ramp: 0.5 }), { kind: 'scaleTo', target: 'a', at: 1, to: 0.4, dur: 0.6, overshoot: 0, profile: 'in', ramp: 0.5 });
  assert.deepEqual(scaleTo('a', { at: 1, to: 2, profile: 'steady' }), { kind: 'scaleTo', target: 'a', at: 1, to: 2, dur: 0.6, overshoot: 0, profile: 'steady' }, 'a steady change has no eased end');
  assert.deepEqual(scaleTo('a', { at: 1, to: [1, 3], pivot: [0, 50], dur: 2, profile: 'out' }), { kind: 'scaleTo', target: 'a', at: 1, to: 1, dur: 2, overshoot: 0, axes: [1, 3], pivot: [0, 50], profile: 'out', ramp: 0.3 });
  assert.equal(scaleTo('a', { at: 1, to: 2, profile: 'ease', overshoot: 0 }).overshoot, 0, 'an overshoot of 0 may be written out');
  assert.equal(scaleTo('a', { at: 1, to: 2, profile: 'ease', sound: false }).sound, false, 'its sound is set as on any intent');

  const bad = (opts: object, message: RegExp): void => {
    assert.throws(() => scaleTo('a', opts as never), (e: unknown) => e instanceof IntentError && message.test(e.message), String(message));
  };
  bad({ at: 1, to: 2, profile: 'ease', overshoot: 0.1 }, /a change of size with a profile has no overshoot; leave overshoot out/);
  bad({ at: 1, to: [1, 2], profile: 'steady', overshoot: 0.15 }, /a change of size with a profile has no overshoot/);
  bad({ at: 1, to: 2, ramp: 0.2 }, /ramp applies to the profiles ease, in and out/);
  bad({ at: 1, to: 2, profile: 'steady', ramp: 0.2 }, /ramp applies to the profiles ease, in and out/);
  bad({ at: 1, to: 2, profile: 'ease', ramp: 0.6 }, /ramp must be a number in 0\.02\.\.0\.5/);
  bad({ at: 1, to: 2, profile: 'settle' }, /profile must be one of ease, steady, in, out; got "settle"/);
  bad({ at: 1, to: 2, profile: 'ease', speed: 3 }, /scaleTo\("a"\): unknown option "speed" \(allowed: at, to, pivot, dur, overshoot, profile, ramp, sound\)/);
});

test('scale profile: steady is one speed of the size, ease goes from rest to rest, in and out have one eased end; none passes its size', async () => {
  // From 1 to 3 in two seconds at one speed: the same step in every frame, from the first to the last.
  const steady = await watch(make([scaleTo('box', { at: 1, to: 3, dur: 2, profile: 'steady' })]));
  assert.deepEqual([steady(0.5).scale, steady(1).scale], [1, 1], 'as authored until the key starts');
  for (const t of [1, 1.5, 2, 2.9]) assert.ok(near(steady(t + 1 / 60).scale - steady(t).scale, 2 / 120), `at ${t} s`);
  assert.ok(near(steady(2).scale, 2), 'half-way in time it is half-way between the two sizes');
  assert.deepEqual([steady(3).scale, steady(5).scale], [3, 3], 'it is there exactly at at + dur, and stays');
  // The picture follows: twice as large half-way, three times at the end.
  const drawn = make([scaleTo('box', { at: 1, to: 3, dur: 2, profile: 'steady' })]);
  assert.ok(boxNear(await box(drawn, 2), -200, -200, 200, 200) && boxNear(await box(drawn, 4), -300, -300, 300, 300));

  // From rest to rest: the curve of a move with that profile, slow at both ends, the same from either end.
  const eased = await watch(make([scaleTo('box', { at: 1, to: 3, dur: 2, profile: 'ease' })]));
  let top = 0;
  for (let f = 0; f <= 300; f++) {
    const u = (f / 60 - 1) / 2;
    assert.ok(near(eased(f / 60).scale, 1 + 2 * rampProgress(u, 0.3, 0.3)), `frame ${f}`);
    top = Math.max(top, eased(f / 60).scale);
  }
  assert.equal(top, 3, 'it never passes its size');
  assert.ok(eased(1.1).scale - 1 < 0.01 && 3 - eased(2.9).scale < 0.01 && near(eased(2).scale, 2));
  for (const x of [0.1, 0.4, 0.8]) assert.ok(near(eased(1 + x).scale - 1, 3 - eased(3 - x).scale), `${x} s from either end`);
  assert.deepEqual([eased(3).scale, eased(4).scale], [3, 3]);
  // A larger ramp: both ends eased for half of the time each.
  const soft = await watch(make([scaleTo('box', { at: 1, to: 3, dur: 2, profile: 'ease', ramp: 0.5 })]));
  assert.ok(near(soft(1.5).scale, 1 + 2 * rampProgress(0.25, 0.5, 0.5)) && soft(1.5).scale < eased(1.5).scale);

  // 'in': from rest, and on at one speed to the end. 'out' is the same seen from the other end.
  const starts = await watch(make([scaleTo('box', { at: 1, to: 3, dur: 2, profile: 'in' })]));
  const speed = 2 / 120 / (1 - 0.3 / 2);
  assert.ok(starts(1 + 1 / 60).scale - 1 < 1e-4, 'from rest');
  assert.ok(near(starts(3).scale - starts(3 - 1 / 60).scale, speed) && near(starts(2).scale - starts(2 - 1 / 60).scale, speed), 'and on at one speed');
  const stops = await watch(make([scaleTo('box', { at: 1, to: 3, dur: 2, profile: 'out' })]));
  for (const x of [1 / 60, 0.3, 1, 1.7]) assert.ok(near(stops(1 + x).scale - 1, 3 - starts(3 - x).scale), `${x} s`);

  // Shrinking runs the same way: evenly between the two sizes, not as a ratio.
  const shrunk = await watch(make([scaleTo('box', { at: 1, to: 0.25, dur: 2, profile: 'ease' })]));
  assert.ok(near(shrunk(2).scale, 0.625) && shrunk(3).scale === 0.25);
  for (const x of [0.2, 0.7]) assert.ok(near((1 - shrunk(1 + x).scale) / 0.75, (eased(1 + x).scale - 1) / 2), 'the share of the change is the share a growing one has');

  // Without a profile: the change that shoots past and settles, as ever.
  const settles = await watch(make([scaleTo('box', { at: 1, to: 3, dur: 2 })]));
  let past = 0;
  for (let f = 60; f <= 200; f++) past = Math.max(past, settles(f / 60).scale);
  assert.ok(past > 3.2, `it reaches ${past}`);
});

test('scale profile: keys chain from the size reached, with and without a profile, and two keys with one speed join without a step', async () => {
  // After a key that settles: from its size.
  const after = await watch(make([scaleTo('box', { at: 0, to: 2, dur: 0.6 }), scaleTo('box', { at: 1, to: 3, dur: 1, profile: 'ease' })]));
  assert.ok(near(after(1).scale, 2) && near(after(1.5).scale, 2.5) && after(2).scale === 3);
  // While another is still under way: from the size it has at that moment, without a jump.
  const cut = await watch(make([scaleTo('box', { at: 1, to: 3, dur: 2, profile: 'steady' }), scaleTo('box', { at: 2, to: 1, dur: 1, profile: 'ease' })]));
  assert.ok(near(cut(2 - 1 / 60).scale, 2 - 1 / 60) && near(cut(2).scale, 2) && near(cut(2.5).scale, 1.5) && cut(3).scale === 1 && cut(4).scale === 1);
  // A key that settles takes over from a key with a profile.
  const then = await watch(make([scaleTo('box', { at: 0, to: 2, dur: 1, profile: 'ease' }), scaleTo('box', { at: 2, to: 4, dur: 1, overshoot: 0.2 })]));
  let peak = 0;
  for (let f = 120; f <= 180; f++) peak = Math.max(peak, then(f / 60).scale);
  assert.ok(near(then(2).scale, 2) && peak > 4.3 && near(then(3).scale, 4, 1e-6), `it reaches ${peak}`);
  // From rest up to a speed, and from that speed down to rest: one change of size.
  const joined = await watch(make([scaleTo('box', { at: 1, to: 2, dur: 1, profile: 'in' }), scaleTo('box', { at: 2, to: 3, dur: 1, profile: 'out' })]));
  const step = 1 / 60 / (1 - 0.3 / 2);
  assert.ok(near(joined(2).scale - joined(2 - 1 / 60).scale, step) && near(joined(2 + 1 / 60).scale - joined(2).scale, step), 'the step from frame to frame is the same on both sides');
  assert.ok(joined(1 + 1 / 60).scale - 1 < 1e-3 && 3 - joined(3 - 1 / 60).scale < 1e-3 && joined(3).scale === 3);
});

test('scale profile: keyed with a move on the same profile, place and size run together: every point of the node goes straight', async () => {
  const A: Vec2 = [-600, 200];
  const B: Vec2 = [300, -100];
  const node = [rect({ ...SQUARE, at: A })];
  /** The largest difference, over the move, between the share of the way and the share of the change of size; and how far a corner leaves its straight line. */
  const apart = async (timeline: Key[]): Promise<{ share: number; line: number }> => {
    const at = await watch(make(timeline, 6, node));
    const corner = (s: State): Vec2 => [s.x + 100 * s.scale, s.y + 100 * s.scale];
    const from = corner(at(1));
    const to = corner(at(3));
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    let share = 0;
    let line = 0;
    for (let f = 60; f <= 180; f++) {
      const s = at(f / 60);
      share = Math.max(share, Math.abs((s.x - A[0]) / (B[0] - A[0]) - (s.scale - 1) / 2));
      const p = corner(s);
      line = Math.max(line, Math.abs((p[0] - from[0]) * (to[1] - from[1]) - (p[1] - from[1]) * (to[0] - from[0])) / length);
    }
    return { share, line };
  };
  for (const [profile, ramp] of [['ease', 0.3], ['ease', 0.5], ['in', 0.3], ['out', 0.2]] as const) {
    const both = await apart([moveTo('box', { at: 1, to: B, dur: 2, profile, ramp, arc: 0 }), scaleTo('box', { at: 1, to: 3, dur: 2, profile, ramp })]);
    assert.ok(both.share < 1e-9 && both.line < 1e-6, `${profile} ${ramp}: ${JSON.stringify(both)}`);
  }
  const flow = await apart([moveTo('box', { at: 1, to: B, dur: 2, profile: 'steady', arc: 0 }), scaleTo('box', { at: 1, to: 3, dur: 2, profile: 'steady' })]);
  assert.ok(flow.share < 1e-9 && flow.line < 1e-6, JSON.stringify(flow));
  // Along a path, with a travel of the same keys.
  const ridden = await apart([travel('box', { at: 1, path: [A, B], dur: 2, profile: 'ease' }), scaleTo('box', { at: 1, to: 3, dur: 2, profile: 'ease' })]);
  assert.ok(ridden.share < 1e-6 && ridden.line < 1e-3, JSON.stringify(ridden));
  // The change that settles is not in step with such a move: it has most of its size while the node has hardly left.
  const loose = await apart([moveTo('box', { at: 1, to: B, dur: 2, profile: 'ease', arc: 0 }), scaleTo('box', { at: 1, to: 3, dur: 2 })]);
  assert.ok(loose.share > 0.5 && loose.line > 40, JSON.stringify(loose));
});

test('scale profile: along the node\'s own axes it runs on the profile too, about its pivot, and chains with keys that settle', async () => {
  // Three times as high at one speed, its lower edge in place.
  const bar = await watch(make([scaleTo('box', { at: 1, to: [1, 3], pivot: [0, 100], dur: 2, profile: 'steady' })]));
  for (const t of [1, 1.5, 2.9]) assert.ok(near(bar(t + 1 / 60).sy - bar(t).sy, 2 / 120), `at ${t} s`);
  const half = bar(2);
  assert.ok(near(half.sy, 2) && half.sx === 1 && near(half.cy, -100) && half.cx === 0, JSON.stringify(half));
  assert.deepEqual([bar(3).sy, bar(3).cy, bar(5).sy], [3, -200, 3]);
  const drawn = make([scaleTo('box', { at: 1, to: [1, 3], pivot: [0, 100], dur: 2, profile: 'steady' })]);
  assert.ok(boxNear(await box(drawn, 2), -100, -300, 100, 100) && boxNear(await box(drawn, 4), -100, -500, 100, 100), 'its upper edge rises, its lower edge stays');
  // Both axes from rest to rest: each evenly between its two values, and neither past its own.
  const both = await watch(make([scaleTo('box', { at: 1, to: [0.5, 2], dur: 2, profile: 'ease' })]));
  let widest = 0;
  for (let f = 60; f <= 200; f++) {
    const s = both(f / 60);
    const p = rampProgress((f / 60 - 1) / 2, 0.3, 0.3);
    assert.ok(near(s.sx, 1 - 0.5 * p) && near(s.sy, 1 + p), `frame ${f}`);
    widest = Math.max(widest, s.sy);
  }
  assert.equal(widest, 2);
  // After a key that settles, and with another pivot: from what is reached, and the picture does not jump.
  const lifted = await watch(make([scaleTo('box', { at: 0, to: [1, 3], pivot: [0, 100], dur: 0.5 }), scaleTo('box', { at: 2, to: [1, 1], pivot: [0, -100], dur: 1, profile: 'ease' })]));
  const upper = (s: State): number => s.sy * -100 + s.cy;
  assert.ok(near(lifted(2 - 1 / 60).sy, 3, 1e-6) && near(lifted(2).sy, 3, 1e-6) && near(upper(lifted(2 - 1 / 60)), -500, 1e-6));
  for (const t of [2, 2.3, 2.7, 3, 4]) assert.ok(near(upper(lifted(t)), -500, 1e-6), `its upper edge stays in place at ${t} s`);
  assert.ok(near(lifted(2.5).sy, 2) && lifted(3).sy === 1);
});

test('scale profile: it is opt-in, its change is a grow or a shrink event, and the motion review judges it', async () => {
  // Keys without a profile: the tracks say so, and every frame has the size it always had.
  const plain = compileShot(make([scaleTo('box', { at: 1, to: 3, dur: 2 }), scaleTo('box', { at: 4, to: [1, 2], pivot: [0, 100], dur: 1, overshoot: 0.3 }), popIn('box', { at: 0.2 })]));
  assert.deepEqual(plain.nodes[0]!.scale!.grows.map((g) => g.profile), [null]);
  assert.deepEqual(plain.nodes[0]!.axis!.segs.map((g) => g.profile), [null]);
  const old = await watch(make([scaleTo('box', { at: 1, to: 3, dur: 2 }), scaleTo('box', { at: 4, to: [1, 2], pivot: [0, 100], dur: 1, overshoot: 0.3 })]));
  for (let f = 0; f <= 359; f++) {
    const t = f / 60;
    const s = old(t);
    const even = t < 1 ? 1 : t >= 3 ? 3 : 3 ** overshootStep((t - 1) / 2, 0.15, 0.5);
    const high = t < 4 ? 1 : 2 ** (t >= 5 ? 1 : overshootStep(t - 4, 0.3, 0.5));
    assert.ok(near(s.scale, even, 1e-12) && near(s.sy, high, 1e-12) && near(s.cy, (1 - high) * 100, 1e-9) && s.sx === 1, `frame ${f}: ${JSON.stringify(s)}`);
  }

  // Events: a change on a profile is the grow or the shrink that any scaleTo is.
  const c = compileShot(make([scaleTo('box', { at: 1, to: 3, dur: 1, profile: 'ease' }), scaleTo('box', { at: 3, to: 0.5, dur: 1, profile: 'in' }), scaleTo('box', { at: 4.5, to: [2, 1], dur: 0.5, profile: 'out' })]));
  assert.deepEqual(sceneEvents(c, await bakeShot(c)).map((e) => [e.kind, e.frame]), [['grow', 60], ['shrink', 180], ['grow', 270]]);

  // The motion review judges it as a change of size, by the travel of the edge of the node.
  const flagged = async (timeline: Key[], nodes: LayerSpec['nodes'] = [rect(SQUARE)]): Promise<string[]> => {
    const cs = compileShot(make(timeline, 6, nodes));
    return reviewMotion(cs, await bakeShot(cs))
      .report.findings.filter((f) => f.subject === 'box')
      .map((f) => `${f.kind} ${f.channel}`)
      .sort();
  };
  // Sound: from rest to rest, evenly or along one axis, and together with a move on the same profile.
  assert.deepEqual(await flagged([scaleTo('box', { at: 1, to: 3, dur: 1, profile: 'ease' })]), []);
  assert.deepEqual(await flagged([scaleTo('box', { at: 1, to: 0.3, dur: 1, profile: 'ease', ramp: 0.5 })]), []);
  assert.deepEqual(await flagged([scaleTo('box', { at: 1, to: [1, 3], pivot: [0, 100], dur: 1, profile: 'ease' })]), []);
  assert.deepEqual(await flagged([moveTo('box', { at: 1, to: [300, -100], dur: 1.6, profile: 'ease', arc: 0 }), scaleTo('box', { at: 1, to: 2.5, dur: 1.6, profile: 'ease' })], [rect({ ...SQUARE, at: [-500, 150] })]), []);
  // Sound: a thing that falls away, faster and faster, and is gone when its change ends: a flow.
  assert.deepEqual(await flagged([scaleTo('box', { at: 1, to: 0.2, dur: 1.5, profile: 'in', ramp: 0.5 }), fadeTo('box', { at: 2, to: 0, dur: 0.5 })]), []);
  // Planted: one speed between two rests in view.
  assert.deepEqual(await flagged([scaleTo('box', { at: 1, to: 3, dur: 1, profile: 'steady' })]), ['mechanical scale']);
  assert.deepEqual(await flagged([scaleTo('box', { at: 1, to: [1, 3], pivot: [0, 100], dur: 1, profile: 'steady' })]), ['mechanical scale']);
  // Planted: one eased end between two rests in view. Most of the change is at one speed, and one finding says it.
  assert.deepEqual(await flagged([scaleTo('box', { at: 1, to: 3, dur: 1, profile: 'out' })]), ['mechanical scale']);
  assert.deepEqual(await flagged([scaleTo('box', { at: 1, to: 0.3, dur: 1, profile: 'in' })]), ['mechanical scale']);
  // Planted: a short change that is still at its top speed when it stops in view.
  assert.deepEqual(await flagged([scaleTo('box', { at: 1, to: 3, dur: 0.5, profile: 'in', ramp: 0.5 })]), ['abrupt-stop scale']);
});
