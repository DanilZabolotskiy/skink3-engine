import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  computeWorld,
  evaluate,
  flatItems,
  hop,
  layer,
  loopPoints,
  moveTimes,
  moveTo,
  pathLength,
  popIn,
  profilePeak,
  rampProgress,
  rect,
  reviewMotion,
  shot,
  travel,
  turnTo,
  type Key,
  type LayerSpec,
  type MotionReport,
  type ShotSpec,
  type Vec2,
} from '../src/index.ts';
import { settleMoments } from '../src/motion/curves.ts';
import { pathAt, pathTable } from '../src/motion/paths.ts';
import { buildPosTrack, samplePathTurn, samplePos, sampleTravelling } from '../src/motion/tracks.ts';
import { posesFromBake } from '../src/scene/evaluate.ts';

// Speed profiles, hops, free-form paths, and keys that start before the shot.
// Each planted defect is next to the sound scene that must stay clean.

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], seconds = 4): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 7,
    palette,
    strings: { en: { 'label.a': 'A label' } },
    background: { inner: 'deep.night', outer: 'deep.abyss' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

async function review(spec: ShotSpec): Promise<MotionReport> {
  const c = compileShot(spec);
  return reviewMotion(c, await bakeShot(c)).report;
}

const flagged = (r: MotionReport): string[] => r.findings.map((f) => `${f.kind} ${f.subject}`).sort();
const dot = (id: string, at: Vec2 = [-300, 0], r = 40): ReturnType<typeof circle> => circle({ id, at, r, fill: 'accent.aqua' });

/** Positions of a track at every frame of a window. */
function positions(keys: Parameters<typeof buildPosTrack>[2], base: Vec2, from: number, to: number): Vec2[] {
  const track = buildPosTrack('a', base, keys);
  const out: Vec2[] = [];
  for (let f = Math.round(from * 60); f <= Math.round(to * 60); f++) out.push(samplePos(track, f / 60));
  return out;
}

const steps = (pts: readonly Vec2[]): number[] => pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]));

test('profiles: the ramp curve starts at 0, ends at 1, never goes back, and holds the speed it promises', () => {
  for (const [a, b] of [[0, 0], [0.3, 0.3], [0.5, 0.5], [0.3, 0], [0, 0.4]] as const) {
    assert.equal(rampProgress(0, a, b), 0);
    assert.equal(rampProgress(1, a, b), 1);
    let prev = 0;
    let peak = 0;
    for (let i = 1; i <= 1000; i++) {
      const p = rampProgress(i / 1000, a, b);
      assert.ok(p >= prev - 1e-12, 'monotonic');
      peak = Math.max(peak, (p - prev) * 1000);
      prev = p;
    }
    // The plateau is 1 / (1 - (a + b) / 2) times the mean speed, and nothing is faster.
    assert.ok(Math.abs(peak - 1 / (1 - (a + b) / 2)) < 0.01, `peak ${peak} for ramps ${a}, ${b}`);
  }
  assert.ok(Math.abs(profilePeak('ease', 0.3) - 1 / 0.7) < 1e-12);
  assert.equal(profilePeak('steady', 0.3), 1);
});

test('moveTo: a settle move is the key it always was; the other profiles are opt-in', () => {
  // Opt-in: without a profile the key carries no new field.
  assert.deepEqual(Object.keys(moveTo('a', { at: 1, to: [10, 0] })).sort(), ['anticipation', 'arc', 'at', 'dur', 'kind', 'overshoot', 'target', 'to']);
  assert.deepEqual(Object.keys(moveTo('a', { at: 1, to: [10, 0], profile: 'settle' })).sort(), ['anticipation', 'arc', 'at', 'dur', 'kind', 'overshoot', 'target', 'to']);
  const eased = moveTo('a', { at: 1, to: [10, 0], profile: 'ease' });
  assert.equal(eased.profile, 'ease');
  assert.equal(eased.anticipation, 0);
  assert.equal(eased.overshoot, 0);
  assert.throws(() => moveTo('a', { at: 1, to: [10, 0], profile: 'ease', overshoot: 0.1 }), /belong to the profile "settle"/);
  assert.throws(() => moveTo('a', { at: 1, to: [10, 0], profile: 'steady', ramp: 0.2 }), /ramp applies/);
  assert.throws(() => moveTo('a', { at: 1, to: [10, 0], profile: 'bouncy' as never }), /profile must be one of/);
  assert.throws(() => moveTo('a', { to: [10, 0] }), /either at .* or arrive/);
  assert.throws(() => moveTo('a', { at: 1, arrive: 2, to: [10, 0] }), /either at .* or arrive/);
});

test('moveTo: ease goes from rest to rest and arrives exactly at the end; steady holds one speed', () => {
  const ease = positions([moveTo('a', { at: 1, to: [600, 0], dur: 2, profile: 'ease', arc: 0 })], [0, 0], 0.5, 3.5);
  const e = steps(ease);
  assert.deepEqual(ease[30], [0, 0], 'still at the start');
  assert.deepEqual(ease[150], [600, 0], 'there at at + dur');
  assert.ok(e[30]! < 0.2 && e[149]! < 0.2, `both ends are eased (${e[30]}, ${e[149]})`);
  // 600 units in 120 frames is 5 per frame; with ramps of 0.3 the plateau is 5 / 0.7.
  assert.ok(Math.abs(Math.max(...e) - 5 / 0.7) < 0.02, `peak ${Math.max(...e)}`);
  const steady = steps(positions([moveTo('a', { at: 1, to: [600, 0], dur: 2, profile: 'steady', arc: 0 })], [0, 0], 1, 3));
  for (const s of steady) assert.ok(Math.abs(s - 5) < 1e-6, `steady step ${s}`);
  // "in" leaves at speed, "out" arrives at speed.
  const into = steps(positions([moveTo('a', { at: 1, to: [600, 0], dur: 2, profile: 'in', arc: 0 })], [0, 0], 1, 3));
  assert.ok(into[0]! < 0.2 && Math.abs(into[into.length - 1]! - 5 / 0.85) < 0.02);
  const out = steps(positions([moveTo('a', { at: 1, to: [600, 0], dur: 2, profile: 'out', arc: 0 })], [0, 0], 1, 3));
  assert.ok(out[out.length - 1]! < 0.2 && Math.abs(out[0]! - 5 / 0.85) < 0.02);
});

test('moveTimes: the moment a settle move leaves and the moment it arrives are known, and arrive places a key by its landing', () => {
  const m = settleMoments(0.08, 0.07);
  assert.equal(m.leaves, 0.24);
  assert.ok(m.arrives > 0.4 && m.arrives < 0.6, `arrives at ${m.arrives} of the duration`);
  // Measured on the track: the first frame within a unit of the destination is the arrival.
  const dur = 1.2;
  const { leaves, arrives } = moveTimes({ dur });
  const pts = positions([moveTo('a', { at: 1, to: [500, 0], dur, arc: 0 })], [0, 0], 1, 1 + dur);
  const first = pts.findIndex((p) => p[0] >= 499.5);
  assert.ok(Math.abs(first / 60 - arrives) <= 1 / 60 + 1e-9, `first there at ${first / 60} s, promised ${arrives} s`);
  const lowest = pts.reduce((a, p, i) => (p[0] < pts[a]![0] ? i : a), 0);
  assert.ok(Math.abs(lowest / 60 - leaves) <= 1 / 60 + 1e-9, `backs away until ${lowest / 60} s, promised ${leaves} s`);
  // Without an overshoot a settle move is an ease-out and arrives at its very end; so does every other profile.
  assert.equal(moveTimes({ dur: 2, overshoot: 0 }).arrives, 2);
  assert.deepEqual(moveTimes({ dur: 2, profile: 'ease' }), { leaves: 0, arrives: 2, peaks: 2 });
  // The overshoot is largest at `peaks`: the frame farthest past the destination.
  const farthest = pts.reduce((a, p, i) => (p[0] > pts[a]![0] ? i : a), 0);
  assert.ok(Math.abs(farthest / 60 - moveTimes({ dur }).peaks) <= 1 / 60 + 1e-9, `farthest at ${farthest / 60} s, promised ${moveTimes({ dur }).peaks} s`);
  // A long move backs away and overshoots by fewer units than its fractions say; its distance says by how much.
  assert.ok(moveTimes({ dur: 1, distance: 2000 }).arrives > moveTimes({ dur: 1 }).arrives);
  // `arrive` is the same move, placed by the moment it lands.
  const key = moveTo('a', { arrive: 5, to: [500, 0], dur });
  assert.ok(Math.abs(key.at - (5 - arrives)) < 1e-12);
});

test('hop: take-off and landing are exact, the top is where it says, sideways it keeps one speed', () => {
  const key = hop('a', { at: 1, to: [300, -100], dur: 0.5, height: 120 });
  const pts = positions([key], [0, 0], 1, 1.5);
  assert.deepEqual(pts[0], [0, 0]);
  assert.deepEqual(pts[30], [300, -100]);
  // At half time it is `height` above the middle of the straight line.
  assert.ok(Math.abs(pts[15]![0] - 150) < 1e-9 && Math.abs(pts[15]![1] - (-50 - 120)) < 1e-9);
  for (let i = 1; i < pts.length; i++) assert.ok(Math.abs(pts[i]![0] - pts[i - 1]![0] - 10) < 1e-9, 'one speed sideways');
  // `land` places the same hop by its landing.
  assert.equal(hop('a', { land: 1.5, to: [300, -100], dur: 0.5 }).at, 1);
  // A hop on the spot is a hop too.
  const up = positions([hop('a', { at: 0, to: [0, 0], dur: 0.4, height: 60 })], [0, 0], 0, 0.4);
  assert.ok(Math.abs(up[12]![1] + 60) < 1e-9);
  assert.throws(() => hop('a', { to: [0, 0] }), /either at .* or land/);
});

test('travel: one speed along a curved path, measured by its own length', () => {
  const path: Vec2[] = [[-600, 0], [-200, -200], [200, 200], [600, 0]];
  const key = travel('a', { at: 1, path, speed: 300 });
  const length = pathLength(key.path);
  assert.ok(length > Math.hypot(1200, 0), `the curve is longer than the straight line (${length})`);
  assert.ok(Math.abs(key.dur - length / 300) < 1e-9, 'the duration follows from the speed');
  const pts = positions([key], [0, 0], 1, 1 + key.dur - 1 / 60);
  assert.deepEqual(pts[0], [-600, 0], 'it starts at the first point of the path');
  const s = steps(pts);
  for (const d of s) assert.ok(Math.abs(d - 5) < 0.02, `step ${d} against 5 units per frame`);
  // It passes through every point of the path (the last one is checked below, after the travel).
  for (const p of path.slice(0, -1)) assert.ok(pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 3), `through ${p.join(',')}`);
  const track = buildPosTrack('a', [0, 0], [key]);
  assert.deepEqual(samplePos(track, 1 + key.dur + 1), [600, 0], 'it stays at the last point');
  // smooth 0 is the polyline; a closed path comes back to its start.
  assert.ok(Math.abs(pathLength(travel('a', { at: 0, path, dur: 1, smooth: 0 }).path) - (2 * Math.hypot(400, 200) + Math.hypot(400, 400))) < 1e-6);
  const loop = travel('a', { at: 0, path: loopPoints([0, 0], 100), closed: true, loops: 2, dur: 4 });
  const lt = buildPosTrack('a', [0, 0], [loop]);
  const start = samplePos(lt, 0);
  const again = samplePos(lt, 2);
  assert.ok(Math.hypot(start[0] - again[0], start[1] - again[1]) < 1e-6, 'after one of two loops it is at the start again');
  assert.ok(Math.abs(pathLength(loop.path) - 2 * Math.PI * 100) < 12, 'a loop of eight points is close to its circle');
  assert.throws(() => travel('a', { at: 0, path: [[0, 0]], dur: 1 }), /at least two points/);
  assert.throws(() => travel('a', { at: 0, path, dur: 1, speed: 5 }), /either speed .* or dur/);
  assert.throws(() => travel('a', { at: 0, path, dur: 1, loops: 2 }), /loops needs closed/);
  assert.throws(() => travel('a', { at: 0, path: [[0, 0], [0, 0]], dur: 1 }), /no length/);
});

test('travel: eased ends, a wheel that rolls, a node that faces along its path, and one that shows only while it travels', () => {
  const path: Vec2[] = [[0, 0], [400, 0]];
  // `speed` is the speed of the steady stretch: with eased ends the travel takes longer.
  const eased = travel('a', { at: 0, path, speed: 200, profile: 'ease', ramp: 0.25 });
  assert.ok(Math.abs(eased.dur - 2 / 0.75) < 1e-9);
  const e = steps(positions([eased], [0, 0], 0, eased.dur));
  assert.ok(e[0]! < 0.1 && e[e.length - 1]! < 0.1 && Math.abs(Math.max(...e) - 200 / 60) < 0.01);

  // Rolling: a wheel of radius 20 turns length / radius radians, clockwise when it goes right.
  const rolling = buildPosTrack('a', [0, 0], [travel('a', { at: 1, path, dur: 2, roll: 20 })]);
  assert.equal(samplePathTurn(rolling, 0.5), 0);
  assert.ok(Math.abs(samplePathTurn(rolling, 2) - ((200 / 20) * 180) / Math.PI) < 1e-6);
  assert.ok(Math.abs(samplePathTurn(rolling, 9) - ((400 / 20) * 180) / Math.PI) < 1e-3, 'it keeps the turn it ended with');
  const back = buildPosTrack('a', [0, 0], [travel('a', { at: 0, path: [[400, 0], [0, 0]], dur: 2, roll: 20 })]);
  assert.ok(samplePathTurn(back, 1) < 0, 'to the left it turns the other way');

  // Facing along the path: before the travel it already looks the way the path sets off.
  const facing = buildPosTrack('a', [0, 0], [travel('a', { at: 1, path: [[0, 0], [0, 300], [300, 300]], dur: 2, orient: true, smooth: 0 })]);
  assert.ok(Math.abs(samplePathTurn(facing, 0) - 90) < 1e-6, 'down is 90 degrees');
  assert.ok(Math.abs(samplePathTurn(facing, 1.5) - 90) < 1e-6);
  assert.ok(Math.abs(samplePathTurn(facing, 2.9)) < 1e-6, 'then to the right');

  const once = buildPosTrack('a', [0, 0], [travel('a', { at: 1, path, dur: 2, only: true })]);
  assert.deepEqual([0.5, 1, 2.9, 3, 4].map((t) => sampleTravelling(once, t)), [false, true, true, false, false]);
  assert.equal(sampleTravelling(buildPosTrack('a', [0, 0], [travel('a', { at: 1, path, dur: 2 })]), 0), true, 'without `only` it is always drawn');
  assert.throws(() => travel('a', { at: 0, path, dur: 1, roll: 10, orient: true }), /either roll or orient/);
});

test('travel in a shot: it turns the node, hides it outside its travel, and may start before the shot', async () => {
  const path: Vec2[] = [[-400, 0], [400, 0]];
  const spec = make(
    [
      rect({ id: 'wheel', at: [-400, 0], w: 60, h: 60, fill: 'accent.amber' }),
      circle({ id: 'early', at: [0, 300], r: 20, fill: 'accent.aqua' }),
      circle({ id: 'ghost', at: [0, -300], r: 20, fill: 'accent.aqua' }),
    ],
    [
      travel('wheel', { at: 1, path, dur: 2, roll: 30 }),
      // Under way since two seconds before the shot: at frame 0 it is half-way.
      travel('early', { at: -2, path: [[-400, 300], [400, 300]], dur: 4 }),
      travel('ghost', { at: 1, path: [[-400, -300], [400, -300]], dur: 1, only: true }),
    ],
  );
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const world = (f: number, id: string) => computeWorld(c, f, posesFromBake(bake))[c.byId.get(id)!.index]!;
  assert.ok(Math.abs(world(120, 'wheel').x) < 1e-6, 'half-way after half the time');
  assert.ok(Math.abs(world(120, 'wheel').rot - 400 / 30) < 1e-6, 'it has rolled its travel over its radius');
  assert.ok(Math.abs(world(0, 'early').x) < 1e-6, 'a key that started before the shot is under way at frame 0');
  const drawn = (f: number): string[] => flatItems(evaluate(c, bake, f, 'en').layers[0]!.items).map((i) => i.node.id);
  assert.ok(!drawn(30).includes('ghost') && drawn(90).includes('ghost') && !drawn(150).includes('ghost'), 'drawn only while it travels');
  // A node is turned by its travel or by turnTo, not by both; a rigid body is moved by the bake.
  assert.throws(() => make([dot('a')], [travel('a', { at: 0, path, dur: 1, roll: 20 }), turnTo('a', { at: 2, to: 90 })]), /turned by one or the other/);
  assert.throws(() => make([dot('a')], [travel('a', { at: 0, path, dur: 2 }), moveTo('a', { at: 1, to: [0, 0] })]), /starts before the previous move has ended/);
  assert.throws(
    () => make([circle({ id: 'b', r: 20, fill: 'accent.aqua', body: { kind: 'dynamic', release: 0 } })], [hop('b', { at: 1, to: [0, 0] })]),
    /rigid body is moved by the physics bake/,
  );
});

test('path table: points are found by distance; a closed path wraps; an open one is held at its ends', () => {
  const t = pathTable({ points: [[0, 0], [100, 0], [100, 100]], closed: false, smooth: 0 });
  assert.equal(t.length, 200);
  assert.deepEqual([pathAt(t, 50).x, pathAt(t, 50).y], [50, 0]);
  assert.ok(Math.abs(pathAt(t, 150).x - 100) < 1e-9 && Math.abs(pathAt(t, 150).y - 50) < 1e-9);
  assert.deepEqual([pathAt(t, -5).x, pathAt(t, 999).y], [0, 100]);
  assert.ok(Math.abs(pathAt(t, 150).angle - Math.PI / 2) < 1e-9);
  const loop = pathTable({ points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true, smooth: 0 });
  assert.equal(loop.length, 400);
  assert.ok(Math.abs(pathAt(loop, 450).x - 50) < 1e-9 && Math.abs(pathAt(loop, 450).y) < 1e-9);
});

test('motion review: a flow that enters and leaves is clean; steady between two rests in view is mechanical; ease is clean', async () => {
  // A flow: steady along a path from outside the frame to outside the frame.
  const flow = make([dot('a', [-1200, 0])], [travel('a', { at: 0.2, path: [[-1200, 0], [0, -150], [1200, 0]], speed: 800 })]);
  assert.deepEqual(flagged(await review(flow)), []);
  // The planted defect: one speed between two rests that are both seen.
  const flat = await review(make([dot('a')], [moveTo('a', { at: 1, to: [300, 0], dur: 1.5, profile: 'steady', arc: 0 })]));
  assert.deepEqual(flagged(flat), ['mechanical a']);
  // The same move eased is sound, and so is the default.
  assert.deepEqual(flagged(await review(make([dot('a')], [moveTo('a', { at: 1, to: [300, 0], dur: 1.5, profile: 'ease', arc: 0 })]))), []);
  assert.deepEqual(flagged(await review(make([dot('a')], [moveTo('a', { at: 1, to: [300, 0], dur: 1.5 })]))), []);
  // "in" from rest is sound while it leaves the frame at speed; "out" into rest likewise.
  assert.deepEqual(flagged(await review(make([dot('a')], [moveTo('a', { at: 1, to: [1300, 0], dur: 2, profile: 'in', arc: 0 })]))), []);
  // A travel that starts at speed from a rest in view is an abrupt start: the review still says so.
  const kick = await review(make([dot('a', [-300, 0])], [travel('a', { at: 1, path: [[-300, 0], [1300, 0]], speed: 500 })]));
  assert.deepEqual(flagged(kick), ['abrupt-start a']);
});

test('motion review: a hop leaves and lands at speed without a finding; the same move without a flight is abrupt', async () => {
  const jump = await review(make([dot('a', [-200, 100])], [hop('a', { at: 1, to: [200, 100], dur: 0.6, height: 140 })]));
  assert.deepEqual(flagged(jump), [], jump.findings.map((f) => f.detail).join('\n'));
  // A hop on the spot, and one that lands higher than it left.
  assert.deepEqual(flagged(await review(make([dot('a', [0, 100])], [hop('a', { at: 1, to: [0, 100], dur: 0.5, height: 120 })]))), []);
  assert.deepEqual(flagged(await review(make([dot('a', [-200, 200])], [hop('a', { at: 1, to: [150, -40], dur: 0.7, height: 90 })]))), []);
  // The planted defect: the same travel at one speed, with no flight to explain it.
  const slide = await review(make([dot('a', [-200, 100])], [moveTo('a', { at: 1, to: [200, 100], dur: 0.6, profile: 'steady', arc: 0 })]));
  assert.ok(flagged(slide).some((f) => f === 'mechanical a' || f === 'abrupt-start a'), flagged(slide).join(', '));
  // A hop that is too fast for its size still strobes, and the review still says so.
  const fast = await review(make([dot('a', [-300, 200], 14)], [hop('a', { at: 1, to: [300, 200], dur: 0.3, height: 200 })]));
  assert.deepEqual(flagged(fast), ['too-fast a']);
});

test('keys before the shot: a node may pop in or move before frame 0 and is simply there', async () => {
  const spec = make([dot('a')], [popIn('a', { at: -1 }), moveTo('a', { at: -3, to: [200, 0], dur: 2 })]);
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const world = computeWorld(c, 0, posesFromBake(bake))[c.byId.get('a')!.index]!;
  assert.deepEqual([world.x, world.y, world.scale], [200, 0, 1]);
  assert.deepEqual(flagged(await review(spec)), []);
});
