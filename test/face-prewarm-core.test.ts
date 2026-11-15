import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  blink,
  circle,
  compileShot,
  emitter,
  evaluate,
  eye,
  flatItems,
  frameRaw,
  group,
  heightFor,
  layer,
  openTo,
  rect,
  shot,
  turnTo,
  type Key,
  type LayerSpec,
  type LeafItem,
} from '../src/index.ts';
import { parseHex } from '../src/look/color.ts';
import { buildLidTrack, sampleLid } from '../src/motion/tracks.ts';
import { simulateRigid } from '../src/physics/rigid.ts';
import { PHYSICS_DEFAULTS } from '../src/scene/build.ts';
import { circleShape, rectShape } from '../src/shape/geometry.ts';

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], physics: { prewarm?: number } = {}): ReturnType<typeof shot> {
  return shot({
    id: 'tiny',
    seconds: 3,
    seed: 1,
    palette,
    strings: { en: { 'label.a': 'A' } },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    physics,
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

async function itemsAt(spec: ReturnType<typeof shot>, frame: number): Promise<LeafItem[]> {
  const c = compileShot(spec);
  return flatItems(evaluate(c, await bakeShot(c), frame, 'en').layers[0]!.items);
}

const eyeOf = (items: LeafItem[], id: string): Extract<LeafItem, { kind: 'eye' }> | undefined =>
  items.find((i): i is Extract<LeafItem, { kind: 'eye' }> => i.kind === 'eye' && i.node.id === id);

const anEye = (id: string, extra: { open?: number; blink?: boolean } = {}): ReturnType<typeof eye> =>
  eye({ id, at: [20, 0], r: 8, white: 'light.snow', pupil: 'deep.abyss', blink: false, ...extra });

test('upright group: keeps its own rotation while it rides on a parent that turns', async () => {
  const face = (upright: boolean): ReturnType<typeof shot> =>
    make(
      [circle({ id: 'wheel', at: [100, 50], r: 40, rotation: 90, fill: 'accent.amber', children: [group({ id: 'face', upright, children: [anEye('e')] })] })],
      [turnTo('wheel', { at: 0.5, to: 270, dur: 1, overshoot: 0 })],
    );
  for (const frame of [0, 60, 179]) {
    const level = eyeOf(await itemsAt(face(true), frame), 'e')!;
    assert.equal(level.xf.rot, 0, `frame ${frame}: the face stays level`);
    assert.ok(Math.abs(level.xf.x - 120) < 1e-9 && Math.abs(level.xf.y - 50) < 1e-9, 'its parts keep their place beside the centre');
  }
  // Without the option the eye turns with the wheel and travels around its centre.
  const turned = eyeOf(await itemsAt(face(false), 0), 'e')!;
  assert.ok(Math.abs(turned.xf.rot - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(turned.xf.x - 100) < 1e-9 && Math.abs(turned.xf.y - 70) < 1e-9);
  // The group's own rotation still applies.
  const tilted = make([circle({ id: 'wheel', r: 40, rotation: 90, fill: 'accent.amber', children: [group({ id: 'face', upright: true, rotation: 30, children: [anEye('e')] })] })]);
  assert.ok(Math.abs(eyeOf(await itemsAt(tilted, 0), 'e')!.xf.rot - Math.PI / 6) < 1e-9);
  assert.throws(() => group({ id: 'g', upright: 1 as unknown as boolean }), /upright must be true or false/);
});

test('upright group: a face on a rigid body that rolls stays level', async () => {
  const spec = make([
    rect({ id: 'floor', at: [0, 300], w: 1600, h: 40, fill: 'dark.indigo', body: { kind: 'fixed' } }),
    circle({
      id: 'wheel',
      at: [-300, 250],
      r: 30,
      fill: 'accent.amber',
      body: { kind: 'dynamic', release: 0, velocity: [260, 0], spin: 500 },
      children: [group({ id: 'face', upright: true, children: [anEye('e')] })],
    }),
  ]);
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const slot = bake.header.bodies.indexOf('wheel');
  assert.ok(Math.abs(bake.bodyRot(slot, 90)) > 1, 'the wheel has turned');
  const item = eyeOf(flatItems(evaluate(c, bake, 90, 'en').layers[0]!.items), 'e')!;
  assert.equal(item.xf.rot, 0);
  assert.ok(Math.abs(item.xf.x - (bake.bodyX(slot, 90) + 20)) < 1e-4 && Math.abs(item.xf.y - bake.bodyY(slot, 90)) < 1e-4, 'the eye rides on the body');
});

test('eye lids: openTo opens and closes them, overshoots, chains; a shut eye is not drawn', async () => {
  const t = buildLidTrack(0, [openTo('e', { at: 1, to: 1, dur: 0.5, overshoot: 0.2 }), openTo('e', { at: 2, to: 0, dur: 0.25, overshoot: 0 })]);
  assert.equal(sampleLid(t, 0.5), 0);
  assert.equal(sampleLid(t, 1.6), 1);
  assert.equal(sampleLid(t, 3), 0);
  let peak = 0;
  let prev = 0;
  let maxStep = 0;
  for (let i = 0; i <= 1500; i++) {
    const v = sampleLid(t, 1 + i / 1000);
    assert.ok(v >= 0, 'never below shut');
    peak = Math.max(peak, v);
    maxStep = Math.max(maxStep, Math.abs(v - prev));
    prev = v;
  }
  assert.ok(peak > 1.15 && peak < 1.25, `opens a little too wide first (${peak})`);
  assert.ok(maxStep < 0.02, 'continuous');
  // An openTo that starts while another is under way takes over from the opening reached.
  const cut = buildLidTrack(1, [openTo('e', { at: 0, to: 0, dur: 1, overshoot: 0 }), openTo('e', { at: 0.5, to: 1, dur: 0.5, overshoot: 0 })]);
  assert.ok(Math.abs(sampleLid(cut, 0.5001) - sampleLid(cut, 0.4999)) < 0.01, 'no jump at the hand-over');

  const spec = make([circle({ id: 'body', r: 40, fill: 'accent.amber', children: [anEye('e', { open: 0 })] })], [openTo('e', { at: 1, to: 1, dur: 0.5 })]);
  assert.equal(eyeOf(await itemsAt(spec, 30), 'e'), undefined, 'shut: not drawn');
  const opening = eyeOf(await itemsAt(spec, 66), 'e')!;
  assert.ok(opening.open > 0.02 && opening.open < 1, `partly open (${opening.open})`);
  assert.equal(eyeOf(await itemsAt(spec, 120), 'e')!.open, 1);
  // By default an eye is open from the start.
  assert.equal(eyeOf(await itemsAt(make([anEye('e')]), 0), 'e')!.open, 1);

  assert.throws(() => anEye('e', { open: 2 }), /open must be a number in 0\.\.1/);
  assert.throws(() => openTo('e', { at: 0, to: 1.5 }), /to must be a number in 0\.\.1/);
  assert.throws(() => make([circle({ id: 'c', r: 10, fill: 'accent.amber' })], [openTo('c', { at: 0, to: 1 })]), /openTo cannot target shape "c"; it applies to eyes/);
});

test('blink: an eye blinks at the moment the timeline asks for, on top of its own schedule', async () => {
  const spec = make([anEye('e')], [blink('e', { at: 1 })]);
  assert.equal(eyeOf(await itemsAt(spec, 59), 'e')!.open, 1);
  const mid = eyeOf(await itemsAt(spec, 66), 'e')!;
  assert.ok(mid.open < 0.2, `closed in the middle of the blink (${mid.open})`);
  assert.equal(eyeOf(await itemsAt(spec, 75), 'e')!.open, 1, 'open again 0.25 s later');
  // The asked blink joins the eye's own schedule, in order.
  const c = compileShot(make([anEye('e', { blink: true })], [blink('e', { at: 1 })]));
  const blinks = c.byId.get('e')!.blinks;
  assert.ok(blinks.includes(1));
  assert.deepEqual([...blinks], [...blinks].sort((a, b) => a - b));
  assert.throws(() => make([circle({ id: 'c', r: 10, fill: 'accent.amber' })], [blink('c', { at: 0 })]), /blink cannot target shape "c"/);
});

test('physics prewarm: bodies released before the shot are already under way at frame 0', async () => {
  const defs = (release: number) => [
    { id: 'floor', shape: rectShape(600, 40, 10), x: 0, y: 300, rot: 0, scale: 1, body: { kind: 'fixed' as const } },
    { id: 'ball', shape: circleShape(30), x: 0, y: -100, rot: 0, scale: 1, body: { kind: 'dynamic' as const, release } },
  ];
  const y = (poses: Float32Array, f: number): number => poses[(f * 2 + 1) * 3 + 1]!;
  const warm = await simulateRigid(defs(-3), { ...PHYSICS_DEFAULTS, prewarm: 3 }, 120);
  assert.ok(Math.abs(y(warm.poses, 0) - 250) < 1.5, `at rest on the floor at frame 0 (y ${y(warm.poses, 0)})`);
  assert.equal(warm.events.length, 0, 'contacts from before the shot are not recorded');
  // A release inside the prewarm: falling at frame 0, landing during the shot.
  const falling = await simulateRigid(defs(-0.4), { ...PHYSICS_DEFAULTS, prewarm: 1 }, 120);
  assert.ok(y(falling.poses, 0) > -100 && y(falling.poses, 0) < 200, `in the air at frame 0 (y ${y(falling.poses, 0)})`);
  assert.ok(falling.events.length > 0 && falling.events.every((e) => e.time >= 0 && e.frame >= 0));
  // The prewarm is the same simulation, only earlier: the pose 0.4 s after a release at 0 is the pose at frame 0 here.
  const plain = await simulateRigid(defs(0), PHYSICS_DEFAULTS, 120);
  assert.equal(y(plain.poses, 0), -100);
  assert.ok(Math.abs(y(plain.poses, 24) - y(falling.poses, 0)) < 1e-3);
  // Deterministic.
  const again = await simulateRigid(defs(-0.4), { ...PHYSICS_DEFAULTS, prewarm: 1 }, 120);
  assert.deepEqual(Buffer.from(again.poses.buffer), Buffer.from(falling.poses.buffer));

  const ball = (release: number) => circle({ id: 'ball', r: 20, fill: 'accent.amber', body: { kind: 'dynamic', release } });
  assert.throws(() => make([ball(-1)]), /released at -1 s, before the simulation starts \(physics\.prewarm is 0 s\)/);
  assert.doesNotThrow(() => make([ball(-1)], [], { prewarm: 1 }));
  // The prewarm is part of the scene, so it is part of the bake key.
  assert.notEqual(compileShot(make([ball(0)], [], { prewarm: 1 })).sceneHash, compileShot(make([ball(0)])).sceneHash);
});

test('particle core: every particle gets an inner disc in the core colour', async () => {
  const dust = (core: boolean) =>
    make([
      emitter({
        id: 'dust',
        bursts: [{ at: 0, count: 1 }],
        colors: ['accent.amber'],
        size: 120,
        life: 60,
        speed: 0,
        drag: 0,
        ...(core ? { core: { color: 'accent.aqua', size: 0.5 } } : {}),
      }),
    ]);
  const width = 480;
  const pixel = async (core: boolean, dx: number): Promise<[number, number, number]> => {
    const c = compileShot(dust(core));
    const raw = await frameRaw(c, await bakeShot(c), 120, { width, lang: 'en', gpu: false });
    const x = Math.round(width / 2 + dx * (width / 1920));
    const o = ((heightFor(width) / 2) * width + x) * 4;
    return [raw[o]!, raw[o + 1]!, raw[o + 2]!];
  };
  const near = (a: [number, number, number], hex: string): boolean => {
    const c = parseHex(hex);
    return Math.abs(a[0] - c.r) < 6 && Math.abs(a[1] - c.g) < 6 && Math.abs(a[2] - c.b) < 6;
  };
  const amber = palette.colors.get('accent.amber')!;
  const aqua = palette.colors.get('accent.aqua')!;
  assert.ok(near(await pixel(true, 0), aqua), 'the middle is the core colour');
  assert.ok(near(await pixel(true, 45), amber), 'the rim keeps the particle colour');
  assert.ok(near(await pixel(false, 0), amber), 'without a core the particle is plain');
  assert.equal(compileShot(dust(true)).byId.get('dust')!.colors['core'], aqua);
  const bad = (core: { color: string; size: number }) => () =>
    emitter({ id: 'd', rate: 1, colors: ['accent.amber'], size: 2, life: 1, core: core as { color: 'accent.aqua'; size: number } });
  assert.throws(bad({ color: 'accent.aqua', size: 1.5 }), /core\.size must be a number in 0\.05\.\.0\.95/);
  assert.throws(bad({ color: '#ffffff', size: 0.5 }), /core\.color must be a palette reference/);
});
