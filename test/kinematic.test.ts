import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  capsule,
  circle,
  compileShot,
  group,
  layer,
  moveTo,
  rect,
  reviewMotion,
  reviewPhysics,
  scaleTo,
  shot,
  turnTo,
  type Bake,
  type CompiledShot,
  type Key,
  type PhysicsReport,
  type SceneNode,
  type ShotSpec,
} from '../src/index.ts';
import { keyedPose } from '../src/scene/evaluate.ts';

// A body of kind "kinematic" is moved by its keys, not by the simulation: it pushes and carries
// the dynamic bodies it meets, and nothing they do moves it.

/** A blade that drives along the ground into three boxes, and a dish on which five balls land, then sinks. */
function yard(moves: Key[], seconds = 5, extra: SceneNode[] = [], keep: (n: SceneNode) => boolean = () => true): ShotSpec {
  const nodes: SceneNode[] = [
    // Its lower edge runs below the ground's top, so that nothing slips under it.
    rect({ id: 'blade', at: [-520, 232], w: 36, h: 150, radius: 8, fill: 'accent.amber', body: { kind: 'kinematic' } }),
    rect({ id: 'ground', at: [0, 330], w: 1600, h: 60, radius: 8, fill: 'dark.indigo', body: { kind: 'fixed' } }),
    rect({ id: 'pan', at: [320, -100], w: 190, h: 20, radius: 6, fill: 'light.cream', body: { kind: 'kinematic' } }),
    rect({ id: 'lip-l', at: [235, -135], w: 20, h: 70, radius: 6, fill: 'light.cream', body: { kind: 'kinematic' } }),
    rect({ id: 'lip-r', at: [405, -135], w: 20, h: 70, radius: 6, fill: 'light.cream', body: { kind: 'kinematic' } }),
    ...extra,
  ];
  for (let i = 0; i < 3; i++) nodes.push(rect({ id: `box${i}`, at: [-330 + i * 70, 278], w: 50, h: 44, radius: 6, fill: 'accent.aqua', body: { kind: 'dynamic', release: -1 } }));
  for (let i = 0; i < 5; i++) nodes.push(circle({ id: `ball${i}`, at: [272 + (i % 3) * 48, -220 - i * 56], r: 24, fill: 'accent.pink', body: { kind: 'dynamic', release: 0.1 + i * 0.12 } }));
  return shot({
    id: 'yard',
    seconds,
    seed: 3,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.abyss' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    physics: { prewarm: 1 },
    layers: [layer({ id: 'stage', depth: 0, nodes: nodes.filter(keep) })],
    timeline: moves,
  });
}

/** The dish and its two lips sink together by `dy`. */
const sink = (at: number, dy: number, dur: number): Key[] =>
  (
    [
      ['pan', 320, -100],
      ['lip-l', 235, -135],
      ['lip-r', 405, -135],
    ] as const
  ).map(([id, x, y]) => moveTo(id, { at, to: [x, y + dy], dur, profile: 'ease', arc: 0 }));
/** The sound yard: the blade drives in along the ground, and the dish sinks slowly from 2.6 s to past the end. */
const sound = (): Key[] => [moveTo('blade', { at: 0.5, to: [-60, 232], dur: 3, profile: 'ease', arc: 0 }), ...sink(2.6, 300, 4)];

interface Baked {
  readonly c: CompiledShot;
  readonly bake: Bake;
}
async function baked(spec: ShotSpec): Promise<Baked> {
  const c = compileShot(spec);
  return { c, bake: await bakeShot(c) };
}
const pose = (b: Baked, id: string, f: number): { x: number; y: number; rot: number } => {
  const slot = b.bake.header.bodies.indexOf(id);
  assert.ok(slot >= 0, `no body "${id}"`);
  return { x: b.bake.bodyX(slot, f), y: b.bake.bodyY(slot, f), rot: b.bake.bodyRot(slot, f) };
};
const flagged = (r: PhysicsReport): string[] => r.findings.map((f) => `${f.kind} ${f.subject}`).sort();
const lines = (r: PhysicsReport): string => r.findings.map((f) => `${f.kind} ${f.subject}: ${f.detail}`).join('\n');

/** Edits the baked pose of a body in place, as the physics review's own tests plant their defects. */
function edit(b: Baked, id: string, fn: (f: number, p: { x: number; y: number; rot: number }) => void): void {
  const slot = b.bake.header.bodies.indexOf(id);
  const n = b.bake.header.bodies.length;
  for (let f = 0; f < b.c.frames; f++) {
    const o = (f * n + slot) * 3;
    const p = { x: b.bake.bodies[o]!, y: b.bake.bodies[o + 1]!, rot: b.bake.bodies[o + 2]! };
    fn(f, p);
    b.bake.bodies[o] = p.x;
    b.bake.bodies[o + 1] = p.y;
    b.bake.bodies[o + 2] = p.rot;
  }
}
/** 0 before `a`, 1 after `b`, eased between: an edit that does not also plant a jolt. */
const ramp = (f: number, a: number, b: number): number => (f <= a ? 0 : f >= b ? 1 : (1 - Math.cos((Math.PI * (f - a)) / (b - a))) / 2);

test('kinematic body: it follows its keys, pushes and carries dynamic bodies, nothing moves it, and its contacts are recorded', async () => {
  const b = await baked(yard(sound()));
  // It stands exactly where its keys put it, at every frame, though boxes and balls press on it.
  for (const id of ['blade', 'pan', 'lip-l', 'lip-r']) {
    const n = b.c.byId.get(id)!;
    for (let f = 0; f < b.c.frames; f++) {
      const want = keyedPose(n, f / 60);
      const got = pose(b, id, f);
      assert.ok(Math.abs(got.x - want.x) < 1e-3 && Math.abs(got.y - want.y) < 1e-3 && Math.abs(got.rot - want.rot) < 1e-6, `${id} at frame ${f}: ${JSON.stringify(got)} against ${JSON.stringify(want)}`);
    }
  }
  const last = b.c.frames - 1;
  // The blade drove the boxes ahead of it, and none of them is behind it or under it.
  for (let i = 0; i < 3; i++) {
    const start = pose(b, `box${i}`, 0);
    const end = pose(b, `box${i}`, last);
    assert.ok(end.x - start.x > 150, `box${i} was pushed: from ${start.x.toFixed(1)} to ${end.x.toFixed(1)}`);
    assert.ok(end.x > pose(b, 'blade', last).x, `box${i} is ahead of the blade`);
  }
  // The dish carries its balls down with it: each sinks as far as the dish does, give or take a little.
  const before = 150;
  const panDrop = pose(b, 'pan', last).y - pose(b, 'pan', before).y;
  assert.ok(panDrop > 100, `the dish sank ${panDrop.toFixed(1)}`);
  for (let i = 0; i < 5; i++) {
    const drop = pose(b, `ball${i}`, last).y - pose(b, `ball${i}`, before).y;
    assert.ok(Math.abs(drop - panDrop) < 4, `ball${i} sank ${drop.toFixed(1)} with the dish's ${panDrop.toFixed(1)}`);
  }
  // Its contacts are recorded, as any body's are, for sounds and for emitters that burst on contact.
  const touched = (a: string, prefix: string): boolean => b.bake.header.events.some((e) => (e.a === a && e.b.startsWith(prefix)) || (e.b === a && e.a.startsWith(prefix)));
  assert.ok(touched('blade', 'box'), 'a contact of the blade and a box is recorded');
  assert.ok(touched('pan', 'ball'), 'a contact of the dish and a ball is recorded');

  // A turn pushes too: a plank that tilts rolls the ball on it off downhill, and nothing tips the plank back.
  const plank = shot({
    id: 'plank',
    seconds: 3,
    seed: 2,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    physics: { prewarm: 0.5 },
    layers: [
      layer({
        id: 'stage',
        depth: 0,
        nodes: [
          rect({ id: 'plank', at: [0, 100], w: 500, h: 24, radius: 8, fill: 'light.cream', body: { kind: 'kinematic' } }),
          circle({ id: 'ball', at: [-60, 70], r: 18, fill: 'accent.pink', body: { kind: 'dynamic', release: -0.5 } }),
        ],
      }),
    ],
    timeline: [turnTo('plank', { at: 0.5, to: 18, dur: 1.5 })],
  });
  const p = await baked(plank);
  const n = p.c.byId.get('plank')!;
  for (let f = 0; f < p.c.frames; f++) assert.ok(Math.abs(pose(p, 'plank', f).rot - keyedPose(n, f / 60).rot) < 1e-6, `the plank at frame ${f} is turned as its keys say`);
  assert.ok(pose(p, 'ball', 170).x - pose(p, 'ball', 0).x > 80, 'the ball rolled downhill, to the right');
});

test('kinematic body: what it refuses, and that it is opt-in', async () => {
  const at = (extra: SceneNode[], moves: Key[] = []): ShotSpec => yard(moves, 2, extra);
  // Its body takes a kind, a friction and a restitution, and nothing that belongs to a falling body.
  assert.throws(() => rect({ id: 'k', w: 40, h: 40, fill: 'accent.amber', body: { kind: 'kinematic', release: 1 } as never }), /release/);
  assert.throws(() => rect({ id: 'k', w: 40, h: 40, fill: 'accent.amber', body: { kind: 'floating' } as never }), /"fixed", "dynamic" or "kinematic"/);
  // Its size is its collider's: no scale keys. A spring that follows or sways is not its keys either.
  assert.throws(() => compileShot(yard([scaleTo('blade', { at: 0.5, to: 1.2, dur: 0.5 })], 2)), /blade/);
  assert.throws(() => compileShot(at([rect({ id: 'k', at: [0, -300], w: 40, h: 40, fill: 'accent.amber', follow: 'light', body: { kind: 'kinematic' } })])), /follow or sway/);
  assert.throws(
    () => compileShot(at([capsule({ id: 'k', at: [0, -300], length: 80, r: 10, origin: 'start', fill: 'accent.amber', sway: 'springy', body: { kind: 'kinematic' } })])),
    /follow or sway/,
  );
  // As every body, it is listed directly in its layer, not inside a group.
  assert.throws(() => compileShot(at([group({ id: 'g', at: [0, -300], children: [rect({ id: 'k', w: 40, h: 40, fill: 'accent.amber', body: { kind: 'kinematic' } })] })])), /k/);
  // A fixed or a dynamic body is still placed by the bake alone, and says how to move one by keys.
  assert.throws(() => compileShot(yard([moveTo('box0', { at: 0.5, to: [0, 0], dur: 1 })], 2)), /dynamic rigid body is moved by the physics bake \(a body of kind "kinematic" follows its keys\)/);
  assert.throws(() => compileShot(yard([turnTo('ground', { at: 0.5, to: 10, dur: 1 })], 2)), /fixed rigid body is turned by the physics bake/);
  assert.throws(() => compileShot(at([rect({ id: 'k', at: [0, -300], w: 40, h: 40, fill: 'accent.amber', idle: { amp: 4, period: 3 }, body: { kind: 'fixed' } })])), /cannot also have idle/);
  // And a kinematic body may idle: its idle is part of what its keys say.
  const idle = await baked(at([rect({ id: 'k', at: [0, -300], w: 40, h: 40, fill: 'accent.amber', idle: { amp: 4, period: 3 }, body: { kind: 'kinematic' } })]));
  const k = idle.c.byId.get('k')!;
  assert.ok(Math.abs(pose(idle, 'k', 60).x - keyedPose(k, 1).x) < 1e-3 && Math.abs(pose(idle, 'k', 60).x) > 0.01, 'the kinematic body wanders with its idle');

  // Opt-in: a shot without one reports no kinematic count; the motion review judges a kinematic body as a node of
  // the timeline, by its keys, and a dynamic body as the solver's.
  const plain = await baked(yard(sound()));
  assert.equal(reviewPhysics(plain.c, plain.bake).counts.kinematic, 4);
  const w = await baked(yard([], 2, [], (n) => !(n.type === 'shape' && n.body?.kind === 'kinematic')));
  assert.equal('kinematic' in reviewPhysics(w.c, w.bake).counts, false);
  const { series } = reviewMotion(plain.c, plain.bake);
  const placed = (id: string) => series.placed[plain.c.byId.get(id)!.index]!;
  assert.equal(placed('blade').solver, false);
  assert.equal(placed('box0').solver, true);
});

test('motion review: a kinematic body is judged by its keys, as a node of the timeline is', async () => {
  // A blade driven at one steady speed, as a machine with no weight: its keys are mechanical, whatever the bodies do.
  const hard = await baked(yard([moveTo('blade', { at: 0.5, to: [-60, 232], dur: 3, profile: 'steady', arc: 0 })], 4));
  const found = reviewMotion(hard.c, hard.bake).report.findings.filter((f) => f.subject === 'blade').map((f) => f.kind);
  assert.ok(found.includes('mechanical'), `a blade at one steady speed is flagged: ${found.join(', ')}`);
  // Eased, it is clean.
  const soft = await baked(yard(sound(), 4));
  const clean = reviewMotion(soft.c, soft.bake).report.findings.filter((f) => f.subject === 'blade').map((f) => f.kind);
  assert.deepEqual(clean, []);
});

test('physics review: kinematic bodies: a blade that pushes and a dish that carries are sound; a body pressed into one, passed through one or flung by one is caught', async () => {
  // Sound: the blade drives the boxes along, the balls land in the dish and sink with it, and the pile it carries
  // still travels at the end of the shot, which is not a pile that fails to settle.
  const sound1 = await baked(yard(sound()));
  const r = reviewPhysics(sound1.c, sound1.bake);
  assert.deepEqual(flagged(r), [], lines(r));
  assert.equal(r.counts.kinematic, 4);
  assert.equal(r.counts.fixed, 1);
  assert.ok(r.world.movingAtEnd >= 3, `the carried pile still travels at the end: ${r.world.movingAtEnd}`);

  // Pressed into the blade: a box sunk 8 px into it for half a second while it pushes.
  const pressed = await baked(yard(sound()));
  edit(pressed, 'box0', (f, p) => {
    p.x -= 8 * ramp(f, 112, 118) * (1 - ramp(f, 148, 154));
  });
  const rp = reviewPhysics(pressed.c, pressed.bake);
  const overlap = rp.findings.find((f) => f.kind === 'overlap' && f.subject === 'box0');
  assert.ok(overlap, lines(rp));
  assert.equal(overlap.other, 'blade');
  assert.match(overlap.detail, /the kinematic body "blade"/);

  // Passed through the dish: a ball that drops through the sinking dish in one frame. The dish moves, so the way the
  // ball went is judged as seen from the dish.
  const through = await baked(yard(sound()));
  const lowest = [0, 1, 2, 3, 4].map((i) => `ball${i}`).sort((a, c) => pose(through, c, 250).y - pose(through, a, 250).y)[0]!;
  edit(through, lowest, (f, p) => {
    if (f >= 250) p.y += 80;
  });
  const rt = reviewPhysics(through.c, through.bake);
  const tunnel = rt.findings.find((f) => f.kind === 'tunnelling' && f.subject === lowest);
  assert.ok(tunnel, lines(rt));
  assert.equal(tunnel.other, 'pan');
  assert.match(tunnel.detail, /passed through the kinematic body "pan"/);

  // Flung: a box that leaves the blade at three times its speed. The blade's own speed is what it may give.
  const flung = await baked(yard(sound()));
  edit(flung, 'box2', (f, p) => {
    if (f > 150) p.x += Math.min(f - 150, 4) * 14;
  });
  const rf = reviewPhysics(flung.c, flung.bake);
  assert.ok(
    rf.findings.some((f) => f.kind === 'energy-spike' && f.subject === 'box2'),
    lines(rf),
  );
});
