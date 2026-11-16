import assert from 'node:assert/strict';
import { test } from 'node:test';
import demo from '../examples/demo/scene.ts';
import { palette } from '../examples/demo/palette.ts';
import {
  bump,
  capsule,
  circle,
  compileShot,
  drawOn,
  emitter,
  eye,
  group,
  label,
  layer,
  link,
  moveTo,
  popIn,
  popOut,
  pulse,
  rect,
  shot,
  stagger,
  turnTo,
  type Key,
  type LayerSpec,
} from '../src/index.ts';
import { arcBump, bumpScale, moveProgress, popInScale, popOutScale, pulseSpan } from '../src/motion/curves.ts';
import { buildPosTrack, buildScaleTrack, MAX_ANTICIPATION_UNITS, sampleReveal, samplePos, sampleScale, buildLinkTrack } from '../src/motion/tracks.ts';

test('moveProgress: anticipation, overshoot, settle, no jumps', () => {
  let lo = 0;
  let hi = 0;
  let prev = 0;
  let maxStep = 0;
  for (let i = 0; i <= 2000; i++) {
    const p = moveProgress(i / 2000, 0.1, 0.08);
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
    maxStep = Math.max(maxStep, Math.abs(p - prev));
    prev = p;
  }
  assert.equal(moveProgress(0, 0.1, 0.08), 0);
  assert.equal(moveProgress(1, 0.1, 0.08), 1);
  assert.ok(Math.abs(lo + 0.1) < 0.002, `backs away by the anticipation (${lo})`);
  assert.ok(Math.abs(hi - 1.08) < 0.004, `shoots past by the overshoot (${hi})`);
  assert.ok(maxStep < 0.004, `continuous (max step ${maxStep})`);
  // Without anticipation or overshoot the progress stays inside [0, 1].
  for (let i = 0; i <= 200; i++) {
    const p = moveProgress(i / 200, 0, 0);
    assert.ok(p >= 0 && p <= 1);
  }
});

test('pop, bump, arc and pulse curves', () => {
  assert.equal(popInScale(0, 0.2), 0);
  assert.equal(popInScale(1, 0.2), 1);
  let peak = 0;
  for (let i = 0; i <= 500; i++) peak = Math.max(peak, popInScale(i / 500, 0.2));
  assert.ok(Math.abs(peak - 1.2) < 0.01);
  assert.equal(popOutScale(0), 1);
  assert.equal(popOutScale(1), 0);
  assert.ok(popOutScale(0.2) > 1, 'swells before it shrinks');
  assert.equal(bumpScale(0, 0.2), 0);
  assert.equal(bumpScale(5, 0.2), 0);
  let bumpPeak = 0;
  for (let i = 0; i <= 700; i++) bumpPeak = Math.max(bumpPeak, bumpScale(i / 1000, 0.2));
  assert.ok(Math.abs(bumpPeak - 0.2) < 0.01, `bump peaks at its amount (${bumpPeak})`);
  assert.equal(arcBump(0), 0);
  assert.ok(Math.abs(arcBump(0.5) - 1) < 1e-12);
  assert.ok(arcBump(1) < 1e-12 && arcBump(-0.2) === 0 && arcBump(1.3) < 1e-12);
  assert.equal(pulseSpan(0.9, 1, 0.5), null);
  const mid = pulseSpan(1.25, 1, 0.5)!;
  assert.ok(mid.head > mid.tail && mid.head < 1);
  const end = pulseSpan(1.5, 1, 0.5)!;
  assert.equal(end.head, 1);
  assert.equal(pulseSpan(1.7, 1, 0.5), null);
});

test('position track: starts where the node is, lands exactly, arcs to the side', () => {
  const track = buildPosTrack('a', [0, 0], [
    moveTo('a', { at: 1, to: [400, 0], dur: 1, arc: 0.2 }),
    moveTo('a', { at: 3, to: [400, 300], dur: 1, arc: 0 }),
  ]);
  assert.deepEqual(samplePos(track, 0.5), [0, 0]);
  assert.deepEqual(samplePos(track, 2), [400, 0]);
  assert.deepEqual(samplePos(track, 2.999), [400, 0]);
  assert.deepEqual(samplePos(track, 9), [400, 300]);
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  for (let i = 0; i <= 600; i++) {
    const p = samplePos(track, 1 + i / 600);
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
  }
  assert.ok(minX < -20 && minX >= -MAX_ANTICIPATION_UNITS - 1e-6, `anticipation is visible and capped (${minX})`);
  assert.ok(maxX > 415, `overshoot is visible (${maxX})`);
  assert.ok(minY < -60, `the path arcs upward (${minY})`);
  // A second move may not start before the first has ended.
  assert.throws(() => buildPosTrack('a', [0, 0], [moveTo('a', { at: 1, to: [1, 1], dur: 2 }), moveTo('a', { at: 2, to: [5, 5] })]), /before the previous move has ended/);
});

test('scale track: hidden before popIn, pops alternate, bumps add', () => {
  const t = buildScaleTrack('a', [popIn('a', { at: 1, dur: 0.5 })], [popOut('a', { at: 3, dur: 0.5 })], [{ at: 2, amount: 0.2 }]);
  assert.equal(sampleScale(t, 0.5), 0);
  assert.equal(sampleScale(t, 1.9), 1);
  assert.ok(sampleScale(t, 2.06) > 1.15);
  assert.equal(sampleScale(t, 2.9), 1);
  assert.equal(sampleScale(t, 4), 0);
  const visible = buildScaleTrack('b', [], [], []);
  assert.equal(sampleScale(visible, 0), 1);
  assert.throws(() => buildScaleTrack('a', [popIn('a', { at: 1 }), popIn('a', { at: 3 })], [], []), /alternate/);
  const lt = buildLinkTrack('l', [drawOn('l', { at: 1, dur: 1 })], [pulse('l', { at: 2 })]);
  assert.equal(sampleReveal(lt, 0.5), 0);
  assert.equal(sampleReveal(lt, 2.5), 1);
  assert.equal(sampleReveal(buildLinkTrack('l', [], []), 0), 1);
  assert.throws(() => buildLinkTrack('l', [drawOn('l', { at: 1 }), drawOn('l', { at: 2 })], []), /once/);
});

test('stagger: one key per node, each later than the previous', () => {
  const keys = stagger(['a', 'b', 'c'], { at: 1, each: 0.25 }, (id, at) => popIn(id, { at }));
  assert.deepEqual(keys.map((k) => [k.target, k.at]), [['a', 1], ['b', 1.25], ['c', 1.5]]);
  const rev = stagger(['a', 'b', 'c'], { at: 1, each: 0.25, order: 'reverse' }, (id, at) => popIn(id, { at }));
  assert.deepEqual(rev.map((k) => k.at), [1.5, 1.25, 1]);
  const centre = stagger(['a', 'b', 'c'], { at: 0, each: 1, order: 'center-out' }, (id, at) => [popIn(id, { at }), bump(id, { at: at + 1 })]);
  assert.equal(centre.length, 6);
  assert.deepEqual(centre.filter((k) => k.kind === 'popIn').map((k) => k.at), [1, 0, 1]);
  // A key may start before the shot does (its move is then under way at frame 0), but not without limit.
  assert.equal(moveTo('a', { at: -1, to: [0, 0] }).at, -1);
  assert.throws(() => moveTo('a', { at: -601, to: [0, 0] }), /at must be/);
  assert.throws(() => moveTo('a', { at: 1, to: [0] as never }), /to must be/);
  assert.throws(() => popIn('', { at: 1 }), /id of the node/);
});

function stage(nodes: LayerSpec['nodes']): LayerSpec[] {
  return [layer({ id: 'stage', depth: 0, nodes })];
}

function tiny(nodes: LayerSpec['nodes'], timeline: Key[] = [], strings = { en: { 'label.a': 'A' } }): ReturnType<typeof shot> {
  return shot({
    id: 'tiny',
    seconds: 2,
    seed: 1,
    palette,
    strings,
    background: { inner: 'deep.night', outer: 'deep.abyss' },
    atmosphere: 'mid.mist',
    layers: stage(nodes),
    timeline,
  });
}

test('scene API: mistakes are rejected where the scene is defined', () => {
  const a = (): ReturnType<typeof circle> => circle({ id: 'a', r: 20, fill: 'accent.amber' });
  // Unknown option, raw colour, on-screen text instead of a key.
  assert.throws(() => circle({ id: 'a', r: 20, fill: 'accent.amber', colour: 'x' } as never), /unknown option "colour"/);
  assert.throws(() => circle({ id: 'a', r: 20, fill: '#FF0000' as never }), /palette reference/);
  assert.throws(() => label({ id: 'l', text: 'Hello world', target: 'a', fill: 'light.cream', ink: 'deep.night' }), /string-table key/);
  assert.throws(() => capsule({ id: 'c', length: 80, r: 10, fill: 'mid.jade', sway: 'springy' }), /origin: "start"/);
  assert.throws(() => emitter({ id: 'e', colors: ['accent.aqua'], size: 3, life: 1 }), /never emits/);
  assert.throws(() => circle({ id: 'a', r: 20, fill: 'accent.amber', follow: 'wobbly' as never }), /spring preset/);
  assert.throws(() => circle({ id: 'bad id', r: 20, fill: 'accent.amber' }), /id must be/);
  // Whole-shot validation.
  assert.throws(() => tiny([a(), a()]), /duplicate node id "a"/);
  assert.throws(() => tiny([circle({ id: 'a', r: 20, fill: 'accent.nope' as never })]), /unknown colour "accent.nope"/);
  assert.throws(() => tiny([a()], [popIn('b', { at: 1 })]), /targets "b", which does not exist/);
  assert.throws(() => tiny([a()], [pulse('a', { at: 1 })]), /pulse cannot target shape "a"/);
  assert.throws(() => tiny([a()], [popIn('a', { at: 5 })]), /after the shot ends/);
  assert.throws(() => tiny([a(), link({ id: 'l', from: 'a', to: 'zz', color: 'dark.haze' })]), /refers to "zz"/);
  assert.throws(() => tiny([a(), link({ id: 'l', from: 'a', to: 'a', color: 'dark.haze' })]), /to itself/);
  assert.throws(() => tiny([a(), label({ id: 'l', text: 'label.missing', target: 'a', fill: 'light.cream', ink: 'deep.night' })]), /"label.missing" is missing in language "en"/);
  assert.throws(() => tiny([group({ id: 'g', children: [label({ id: 'l', text: 'label.a', target: 'g', fill: 'light.cream', ink: 'deep.night' })] })]), /directly in a layer/);
  assert.throws(
    () => tiny([rect({ id: 'b', w: 40, h: 40, fill: 'mid.violet', body: { kind: 'dynamic', release: 0.5 } })], [moveTo('b', { at: 1, to: [0, 0] })]),
    /rigid body is moved by the physics bake/,
  );
  assert.throws(() => tiny([group({ id: 'g', children: [rect({ id: 'b', w: 40, h: 40, fill: 'mid.violet', body: { kind: 'fixed' } })] })]), /directly in a layer/);
  assert.throws(() => tiny([a(), eye({ id: 'e', r: 10, white: 'light.snow', pupil: 'deep.abyss', lookAt: 'nobody' })]), /refers to "nobody"/);
  assert.throws(() => tiny([a()], [turnTo('a', { at: 0.5, to: 90 }), turnTo('a', { at: 0.6, to: 10 })]), /before the previous turn has ended/);
});

test('compile: draw order, slots, pulse arrivals bump the far node', () => {
  const s = tiny(
    [
      link({ id: 'l', from: 'a', to: 'b', color: 'dark.haze' }),
      circle({ id: 'a', r: 20, fill: 'accent.amber', children: [circle({ id: 'a-sat', r: 5, at: [30, 0], fill: 'light.cream', follow: 'light' })] }),
      circle({ id: 'b', r: 20, at: [200, 0], fill: 'accent.aqua' }),
      rect({ id: 'floor', w: 300, h: 20, at: [0, 300], fill: 'dark.indigo', body: { kind: 'fixed' } }),
      emitter({ id: 'e', attach: 'b', rate: 10, colors: ['accent.aqua'], size: 3, life: 1 }),
    ],
    [pulse('l', { at: 0.5, dur: 0.5, bump: 0.2 })],
  );
  const c = compileShot(s);
  assert.deepEqual(c.nodes.map((n) => n.id), ['l', 'a', 'a-sat', 'b', 'floor', 'e']);
  assert.equal(c.byId.get('a-sat')!.parent, c.byId.get('a')!.index);
  assert.deepEqual(c.springs.map((i) => c.nodes[i]!.id), ['a-sat']);
  assert.deepEqual(c.bodies.map((i) => c.nodes[i]!.id), ['floor']);
  assert.deepEqual(c.emitters.map((i) => c.nodes[i]!.id), ['e']);
  assert.deepEqual(c.byId.get('b')!.scale!.bumps, [{ at: 1, amount: 0.2 }]);
  assert.equal(c.frames, 120);
});

test('scene hash: stable, sensitive to the scene, blind to the string tables', () => {
  const nodes = (): LayerSpec['nodes'] => [
    circle({ id: 'a', r: 20, fill: 'accent.amber' }),
    label({ id: 'l', text: 'label.a', target: 'a', fill: 'light.cream', ink: 'deep.night' }),
  ];
  const h1 = compileShot(tiny(nodes())).sceneHash;
  assert.equal(compileShot(tiny(nodes())).sceneHash, h1);
  assert.equal(compileShot(tiny(nodes(), [], { en: { 'label.a': 'Something much longer' } })).sceneHash, h1, 'a translation does not re-bake');
  assert.notEqual(compileShot(tiny(nodes(), [popIn('a', { at: 1 })])).sceneHash, h1);
  assert.equal(compileShot(demo).sceneHash, compileShot(demo).sceneHash);
});
