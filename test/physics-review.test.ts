import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import demo from '../examples/demo/scene.ts';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  emitter,
  fadeTo,
  formatPhysicsReport,
  formatPhysicsShort,
  formatReport,
  intended,
  layer,
  PHYSICS_FINDING_KINDS,
  PHYSICS_THRESHOLDS,
  physicsPictures,
  physicsReportJson,
  popIn,
  rect,
  renderCloseUp,
  reviewMotion,
  reviewPhysics,
  Rng,
  runChecks,
  sampleMotion,
  shot,
  type Bake,
  type CompiledShot,
  type IntendedSpec,
  type Key,
  type LayerSpec,
  type PhysicsFinding,
  type PhysicsReport,
  type PhysicsSpec,
  type SceneNode,
  type ShotSpec,
} from '../src/index.ts';
import { colliderFor, loadRapier } from '../src/physics/rigid.ts';
import { colliderOf, convexHull, depthOfPoint, pathInside, placeCore, segmentsCross, separation } from '../src/review/collide.ts';
import { blobShape, capsuleShape, circleShape, rectShape, regularPolygonShape, scaleShape } from '../src/shape/geometry.ts';

// Every kind of finding is proven by a planted defect that it catches, and by
// sound scenes next to it that it must leave alone. Two ways to plant:
//   - a scene in which the solver itself goes wrong (a body released inside another one);
//   - a sound bake whose poses are then edited (a body made to tremble, to creep, to pass
//     through a wall): the review reads the bake, so this plants exactly the defect and no other.
// The camera stands still and does not zoom, so a unit is a pixel.

interface Extra {
  seconds?: number;
  physics?: Partial<PhysicsSpec>;
  intended?: IntendedSpec[];
  camera?: Parameters<typeof shot>[0]['camera'];
}

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], extra: Extra = {}): ShotSpec {
  return shot({
    id: 'tiny',
    seconds: extra.seconds ?? 6,
    seed: 7,
    palette,
    strings: { en: { 'label.a': 'A label' } },
    background: { inner: 'deep.night', outer: 'deep.abyss' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: extra.camera ?? { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
    ...(extra.physics ? { physics: extra.physics } : {}),
    ...(extra.intended ? { intended: extra.intended } : {}),
  });
}

interface Baked {
  readonly c: CompiledShot;
  readonly bake: Bake;
}

async function baked(spec: ShotSpec): Promise<Baked> {
  const c = compileShot(spec);
  return { c, bake: await bakeShot(c) };
}

/** Edits the baked pose of a body in place: `fn` gets the frame and the pose, and changes the pose. */
function edit(b: Baked, id: string, fn: (f: number, pose: { x: number; y: number; rot: number }) => void): void {
  const slot = b.bake.header.bodies.indexOf(id);
  assert.ok(slot >= 0, `no body "${id}"`);
  const n = b.bake.header.bodies.length;
  for (let f = 0; f < b.c.frames; f++) {
    const o = (f * n + slot) * 3;
    const pose = { x: b.bake.bodies[o]!, y: b.bake.bodies[o + 1]!, rot: b.bake.bodies[o + 2]! };
    fn(f, pose);
    b.bake.bodies[o] = pose.x;
    b.bake.bodies[o + 1] = pose.y;
    b.bake.bodies[o + 2] = pose.rot;
  }
}

const review = (b: Baked): PhysicsReport => reviewPhysics(b.c, b.bake);
/** "kind subject" of every finding, sorted: what a shot was flagged for. */
const flagged = (r: PhysicsReport): string[] => r.findings.map((f) => `${f.kind} ${f.subject}`).sort();
const of = (r: PhysicsReport, kind: string): PhysicsFinding[] => r.findings.filter((f) => f.kind === kind);
const lines = (r: PhysicsReport): string => r.findings.map((f) => `${f.kind} ${f.subject}: ${f.detail}`).join('\n');
const T = Object.fromEntries(Object.entries(PHYSICS_THRESHOLDS).map(([k, v]) => [k, v.value])) as Record<keyof typeof PHYSICS_THRESHOLDS, number>;

const FLOOR_Y = 300;
const floor = (id = 'floor', at: [number, number] = [0, FLOOR_Y + 30], w = 1400): SceneNode => rect({ id, at, w, h: 60, radius: 10, fill: 'dark.indigo', body: { kind: 'fixed' } });
const ball = (id: string, at: [number, number], release: number, r = 20, more: Record<string, unknown> = {}): SceneNode =>
  circle({ id, at, r, fill: 'accent.aqua', body: { kind: 'dynamic', release, ...more } });

/** A tray and twelve balls that drop into it within two seconds: a small pile that comes to rest. */
function pile(): SceneNode[] {
  const nodes: SceneNode[] = [
    floor('floor', [0, FLOOR_Y + 30], 520),
    rect({ id: 'wall-l', at: [-240, FLOOR_Y - 90], w: 40, h: 260, radius: 10, fill: 'dark.indigo', body: { kind: 'fixed' } }),
    rect({ id: 'wall-r', at: [240, FLOOR_Y - 90], w: 40, h: 260, radius: 10, fill: 'dark.indigo', body: { kind: 'fixed' } }),
  ];
  for (let i = 0; i < 12; i++) nodes.push(ball(`b${i}`, [-150 + (i % 4) * 100 + (i % 3) * 7, -300 - Math.floor(i / 4) * 60], 0.2 + (i * 1.8) / 11, 24));
  return nodes;
}

/** A smooth start and a smooth stop: 0 at u = 0, 1 at u = 1. An edit that eases does not also plant a jolt. */
const ease = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : (1 - Math.cos(Math.PI * u)) / 2);

test('physics: sound shots have no findings: the demo, a pile at rest, a stream in free fall', async () => {
  const d = compileShot(demo);
  const report = reviewPhysics(d, await bakeShot(d));
  assert.deepEqual(flagged(report), [], lines(report));
  assert.equal(report.counts.bodies, 17);
  assert.ok(report.world.restFrom !== null, 'the pieces of the demo come to rest');

  const p = review(await baked(make(pile(), [], { seconds: 8 })));
  assert.deepEqual(flagged(p), [], lines(p));
  assert.ok(p.world.restFrom !== null && p.world.restFrom < 400, `the pile is at rest from frame ${p.world.restFrom}`);
  assert.ok(p.world.deepest !== null && p.world.deepest.px < T.overlapPx, `resting contacts give ${p.world.deepest?.px} px`);

  // Bodies that fall through the picture and land on nothing, with no ground at all.
  const stream = review(await baked(make([0, 1, 2, 3, 4].map((i) => ball(`drop${i}`, [-200 + i * 100, -500], 0.2 + i * 0.3)))));
  assert.deepEqual(flagged(stream), [], lines(stream));
  assert.equal(stream.world.restFrom, null);
  assert.equal(stream.world.movingAtEnd, 5);

  // No bodies at all.
  const none = review(await baked(make([circle({ id: 'dot', r: 30, fill: 'accent.aqua' })])));
  assert.deepEqual([flagged(none), none.counts.bodies, none.world.deepest], [[], 0, null]);
});

test('overlap: a body released inside another one, and a body sunk into the floor', async () => {
  // The solver goes wrong by itself: a ball is released inside one that lies on the floor.
  const inside = (opacity = 1): ShotSpec =>
    make([floor(), ball('a', [0, FLOOR_Y - 20], -1), circle({ id: 'inside', at: [6, FLOOR_Y - 22], r: 20, fill: 'accent.pink', opacity, body: { kind: 'dynamic', release: 2 } })], [], { physics: { prewarm: 1 } });
  const r = review(await baked(inside()));
  assert.deepEqual(flagged(r), ['overlap a'], lines(r));
  const f = r.findings[0]!;
  assert.equal(f.other, 'inside');
  assert.deepEqual([f.from, f.worst], [121, 121], 'from the frame after the release');
  assert.ok(f.value > 25 && f.value < 40, `the measured depth is nearly the whole ball (${f.value} px)`);
  assert.deepEqual([f.threshold, f.unit], [T.overlapPx, 'px']);
  assert.match(f.detail, /^sunk 3\d\.\d px into "inside" at frame 121; deeper than 1\.5 px for \d+ frame\(s\), \d+ in a row; it starts at the release of "inside" \(frame 121\), which was put inside "a"$/);
  assert.match(f.fix, /released inside another one or inside a wall: move its start/);
  assert.ok(r.world.deepest !== null && Math.abs(r.world.deepest.px - f.value) < 0.01, 'the summary names the same depth');
  // What is not seen is not reported: the same with the second ball faded out.
  assert.deepEqual(flagged(review(await baked(inside(0)))), []);

  // Planted in a sound bake: the lowest ball of a pile lies 3 px deep in the floor for a second.
  const sunk = async (depth: number, hold: number): Promise<{ report: PhysicsReport; low: string }> => {
    const b = await baked(make(pile(), [], { seconds: 8 }));
    const last = b.c.frames - 1;
    const balls = b.bake.header.bodies.filter((id) => id.startsWith('b'));
    const low = balls.reduce((x, id) => (b.bake.bodyY(b.bake.header.bodies.indexOf(id), last) > b.bake.bodyY(b.bake.header.bodies.indexOf(x), last) ? id : x));
    // Down within 30 frames, held, and up again: slow enough to be no jolt.
    edit(b, low, (g, pose) => {
      pose.y += depth * (ease((g - 380) / 30) - ease((g - 410 - hold) / 30));
    });
    return { report: review(b), low };
  };
  const deep = await sunk(3, 60);
  assert.deepEqual(flagged(deep.report), [`overlap ${deep.low}`], lines(deep.report));
  const g = deep.report.findings[0]!;
  assert.equal(g.other, 'floor');
  assert.ok(g.value > 2.9 && g.value < 3.6, `3 px and the give of the resting contact (${g.value})`);
  assert.ok(g.from > 380 && g.from < 410 && g.to > 470 && g.to < 500, `while it is deeper than the limit (${g.from}-${g.to})`);
  assert.match(g.detail, /into the fixed body "floor"/);
  // A pixel deep is what a soft contact gives: not a finding, but the summary shows it.
  const shallow = await sunk(1, 60);
  assert.deepEqual(flagged(shallow.report), []);
  assert.ok(shallow.report.world.deepest!.px > 1 && shallow.report.world.deepest!.px < T.overlapPx);

  // The give of an impact: nearly 3 px, but for two frames only.
  const b = await baked(make(pile(), [], { seconds: 8 }));
  const low = deep.low;
  edit(b, low, (h, pose) => {
    pose.y += [1.4, 2.8, 2.8, 1.4][h - 400] ?? 0;
  });
  assert.deepEqual(flagged(review(b)), []);
});

test('overlap: a deep overlap counts even when it is short', async () => {
  // Two balls fall side by side, 4 px apart; for three frames one of them is 12 px nearer.
  const b = await baked(make([ball('a', [-22, -400], 0.2), ball('b', [22, -400], 0.2)], [], { seconds: 2 }));
  edit(b, 'b', (f, pose) => {
    if (f >= 60 && f <= 62) pose.x -= 12;
  });
  const r = review(b);
  assert.deepEqual(flagged(r), ['overlap a'], lines(r));
  assert.ok(Math.abs(r.findings[0]!.value - 8) < 0.2, `8 px deep (${r.findings[0]!.value})`);
  assert.match(r.findings[0]!.detail, /for 3 frame\(s\), 3 in a row/);
  // A single frame of it is the instant of a hit.
  const once = await baked(make([ball('a', [-22, -400], 0.2), ball('b', [22, -400], 0.2)], [], { seconds: 2 }));
  edit(once, 'b', (f, pose) => {
    if (f === 60) pose.x -= 12;
  });
  assert.deepEqual(flagged(review(once)), []);
});

/** A ball that lies on the floor left of a thin wall. */
const walled = (opacity = 1): ShotSpec =>
  make(
    [
      floor(),
      rect({ id: 'wall', at: [0, FLOOR_Y - 100], w: 24, h: 200, radius: 4, fill: 'dark.indigo', body: { kind: 'fixed' } }),
      circle({ id: 'a', at: [-200, FLOOR_Y - 20], r: 20, fill: 'accent.aqua', opacity, body: { kind: 'dynamic', release: -1 } }),
    ],
    [],
    { physics: { prewarm: 1 }, seconds: 5 },
  );

test('tunnelling: through a wall slowly, through a wall between two frames, and what is not tunnelling', async () => {
  // Slowly: the ball is pressed through the wall over a second and a half.
  const slow = await baked(walled());
  edit(slow, 'a', (f, pose) => {
    pose.x += 400 * ease((f - 60) / 200);
  });
  const r = review(slow);
  assert.deepEqual(flagged(r), ['overlap a', 'tunnelling a'], lines(r));
  const t = of(r, 'tunnelling')[0]!;
  assert.equal(t.other, 'wall');
  assert.ok(t.from > 130 && t.to < 200 && t.to - t.from > 3, `from the last frame outside to the first frame outside again (${t.from}-${t.to})`);
  assert.ok(Math.abs(t.value - 24) < 1, `the line through the wall is as long as the wall is thick (${t.value} px)`);
  assert.equal(t.threshold, T.tunnelPx);
  assert.match(t.detail, /^passed through the fixed body "wall" between frames \d+ and \d+: the line from where it was outside to where it is outside again runs 2\d\.\d px inside it$/);
  assert.match(t.fix, /make the wall thicker/);

  // In and back out on the same side: sunk deep into the wall, but it did not pass.
  const back = await baked(walled());
  edit(back, 'a', (f, pose) => {
    pose.x += 195 * (ease((f - 60) / 90) - ease((f - 180) / 90));
  });
  assert.deepEqual(flagged(review(back)), ['overlap a'], lines(review(back)));

  // Over the wall: it ends on the other side, and nothing is wrong.
  const over = await baked(walled());
  edit(over, 'a', (f, pose) => {
    const u = ease((f - 60) / 200);
    pose.x += 400 * u;
    pose.y -= 320 * Math.sin(Math.PI * u);
  });
  assert.deepEqual(flagged(review(over)), [], lines(review(over)));

  // Unseen, it is not reported.
  const unseen = await baked(walled(0));
  edit(unseen, 'a', (f, pose) => {
    pose.x += 400 * ease((f - 60) / 200);
  });
  assert.deepEqual(flagged(review(unseen)), []);

  // Between two frames: a ball that flies at 15 px per frame is moved into the path of a wall 10 px
  // thick, so that one frame shows it before the wall and the next one behind it.
  const fast = await baked(
    make(
      [rect({ id: 'slat', at: [0, 0], w: 10, h: 300, fill: 'dark.indigo', body: { kind: 'fixed' } }), ball('shot', [-307.5, -300], 0.2, 20, { velocity: [900, 0] })],
      [],
      { physics: { gravity: 0, linearDamping: 0 }, seconds: 2 },
    ),
  );
  edit(fast, 'shot', (_f, pose) => {
    pose.y += 300;
  });
  const slot = fast.bake.header.bodies.indexOf('shot');
  assert.deepEqual([Math.round(fast.bake.bodyX(slot, 32) * 10) / 10, Math.round(fast.bake.bodyX(slot, 33) * 10) / 10], [-7.5, 7.5], 'no frame shows its centre inside the wall');
  const q = review(fast);
  assert.deepEqual(flagged(q), ['overlap shot', 'tunnelling shot'], lines(q));
  const u = of(q, 'tunnelling')[0]!;
  assert.deepEqual([u.other, u.from, u.to], ['slat', 32, 33]);
  assert.ok(Math.abs(u.value - 10) < 0.5, `${u.value} px inside`);
});

test('tunnelling: a body released inside a wall is an overlap, not a passage', async () => {
  const r = review(await baked(make([floor(), rect({ id: 'wall', at: [0, FLOOR_Y - 100], w: 60, h: 200, radius: 4, fill: 'dark.indigo', body: { kind: 'fixed' } }), ball('a', [-8, FLOOR_Y - 60], 0.5)])));
  assert.deepEqual(flagged(r), ['overlap a'], lines(r));
  assert.equal(r.findings[0]!.other, 'wall');
  assert.match(r.findings[0]!.detail, /it starts at the release of "a" \(frame 31\), which was put inside "wall"$/);
});

/** A floor of two slabs with a gap between them, and a ball over the gap. */
const slabs = (gap: number, x = 0): ShotSpec =>
  make(
    [
      rect({ id: 'slab-l', at: [-250 - gap / 2, FLOOR_Y + 30], w: 500, h: 60, radius: 8, fill: 'dark.indigo', body: { kind: 'fixed' } }),
      rect({ id: 'slab-r', at: [250 + gap / 2, FLOOR_Y + 30], w: 500, h: 60, radius: 8, fill: 'dark.indigo', body: { kind: 'fixed' } }),
      ball('a', [x, FLOOR_Y - 200], 0.2),
    ],
    [],
    { seconds: 5 },
  );

test('tunnelling: through a gap narrower than the body; a gap that is wide enough is a way out', async () => {
  // The ball (40 px) comes to rest over a gap of 20 px. Then it is pressed down through it.
  const b = await baked(slabs(20));
  const slot = b.bake.header.bodies.indexOf('a');
  assert.ok(Math.abs(b.bake.bodyX(slot, 150)) < 1 && b.bake.bodyY(slot, 150) < FLOOR_Y, 'it lies on the two slabs');
  assert.deepEqual(flagged(review(b)), [], 'and that is sound');
  edit(b, 'a', (f, pose) => {
    pose.y += 160 * ease((f - 150) / 100);
  });
  const r = review(b);
  assert.deepEqual(flagged(r), ['overlap a', 'overlap a', 'tunnelling a'], lines(r));
  const t = of(r, 'tunnelling')[0]!;
  assert.deepEqual([t.other, t.group], ['slab-l', ['slab-r']]);
  assert.ok(Math.abs(t.value - 20) < 0.5, `the body is 20 px wider than the gap (${t.value})`);
  assert.match(t.detail, /^passed between the fixed bodies "slab-l" and "slab-r" between frames \d+ and \d+: the gap there is 20\.0 px wide and the body 40\.0 px$/);

  // A gap of 60 px lets the ball through: it never lay on anything, so it is not an escape either.
  const wide = review(await baked(slabs(60)));
  assert.deepEqual(flagged(wide), [], lines(wide));
});

test('escape: a body that leaves what it lay on and falls below everything', async () => {
  const ledge = (more: SceneNode[] = [], timeline: Key[] = [], extra: Extra = {}): ShotSpec =>
    make([floor('ledge', [-300, 100], 400), ball('roller', [-400, 40], 0.2, 20, { velocity: [260, 0] }), ...more], timeline, extra);
  const r = review(await baked(ledge()));
  assert.deepEqual(flagged(r), ['escape roller'], lines(r));
  const f = r.findings[0]!;
  assert.ok(f.value > 1000, `far below at the end (${f.value} px)`);
  assert.deepEqual([f.threshold, f.to], [T.escapePx, 359]);
  assert.ok(f.from > 60 && f.from < 359, `from the frame it passed below the ledge (${f.from})`);
  assert.match(f.detail, /^\d+ px below the lowest fixed body at the end of the shot and still falling at \d+\.\d px per frame; it last lay on something at frame \d+ \(\d\.\d\d s\) and passed below everything at frame \d+$/);
  assert.match(f.fix, /widen the ground or add a wall/);
  assert.equal(r.world.restFrom, null);
  assert.match(formatPhysicsReport(r), /1 still travelling at the end \(the fastest, "roller", at \d+\.\d\d px per frame, out of sight\)/);

  // A lower floor catches it: nothing to report.
  assert.deepEqual(flagged(review(await baked(ledge([floor('ground', [0, 600], 2400)])))), []);
  // It is faded out before it leaves: what happens unseen is nobody's business.
  assert.deepEqual(flagged(review(await baked(ledge([], [fadeTo('roller', { at: 0.6, to: 0, dur: 0.3 })])))), []);
  // Marked as intended, it is honoured and listed.
  const meant = review(await baked(ledge([], [], { intended: [intended('roller', 'escape', 'it rolls out of the picture')] })));
  assert.deepEqual(flagged(meant), []);
  assert.deepEqual(meant.honoured.map((h) => [h.kind, h.reason, h.findings.length]), [['escape', 'it rolls out of the picture', 1]]);
  // Without gravity nothing falls.
  assert.deepEqual(flagged(review(await baked(ledge([], [], { physics: { gravity: 0 } })))), []);
});

test('jitter: a body of a pile at rest that trembles', async () => {
  const trembling = async (plant: (b: Baked) => void, nodes: SceneNode[] = pile()): Promise<PhysicsReport> => {
    const b = await baked(make(nodes, [], { seconds: 8 }));
    plant(b);
    return review(b);
  };
  // Back and forth by 0.7 px, every frame, for a second.
  const r = await trembling((b) => edit(b, 'b5', (f, pose) => (pose.x += f >= 400 && f < 460 ? (f % 2 === 0 ? 0.35 : -0.35) : 0)));
  assert.deepEqual(flagged(r), ['jitter b5'], lines(r));
  const f = r.findings[0]!;
  assert.ok(Math.abs(f.value - 0.7) < 0.01, `the swing is measured (${f.value} px)`);
  assert.deepEqual([f.threshold, f.unit], [T.jitterPx, 'px']);
  assert.ok(f.from >= 399 && f.from <= 401 && f.to >= 458 && f.to <= 460, `over the frames of the tremble (${f.from}-${f.to})`);
  assert.match(f.detail, /^position: swings back and forth \d+ times between frames \d+ and \d+ \(\d\.\d\d-\d\.\d\d s\) while it and everything near it are at rest: 0\.70 px a swing, at most 0\.7\d px$/);
  assert.match(f.fix, /raise physics\.friction/);

  // A slow rock, six frames each way, a pixel wide.
  const rock = await trembling((b) => edit(b, 'b5', (g, pose) => (pose.x += g >= 400 && g < 460 ? 0.5 * Math.sin(((g - 400) * Math.PI) / 6) : 0)));
  assert.deepEqual(flagged(rock), ['jitter b5'], lines(rock));

  // Too small to see.
  assert.deepEqual(flagged(await trembling((b) => edit(b, 'b5', (g, pose) => (pose.x += g >= 400 && g < 460 ? (g % 2 === 0 ? 0.2 : -0.2) : 0)))), []);
  // A settle: it rocks back twice and lies still.
  assert.deepEqual(flagged(await trembling((b) => edit(b, 'b5', (g, pose) => (pose.x += [0.6, -0.5, 0.3][g - 400] ?? 0)))), []);
  // While the pile is still taking balls, a body next to them may shake.
  const during = await trembling((b) => edit(b, 'b0', (g, pose) => (pose.x += g >= 70 && g < 110 ? (g % 2 === 0 ? 0.35 : -0.35) : 0)));
  assert.deepEqual(of(during, 'jitter'), []);

  // The turn of a body shows only when it is not a plain disc.
  const turning = (id: string) => (b: Baked) => edit(b, id, (g, pose) => (pose.rot += g >= 400 && g < 460 ? (g % 2 === 0 ? 0.012 : -0.012) : 0));
  assert.deepEqual(flagged(await trembling(turning('b5'))), [], 'a disc that trembles round its centre shows nothing');
  const boxed = [...pile(), rect({ id: 'box', at: [0, -520], w: 44, h: 44, radius: 6, fill: 'accent.pink', body: { kind: 'dynamic', release: 2.3 } })];
  const t = await trembling(turning('box'), boxed);
  assert.deepEqual(flagged(t), ['jitter box'], lines(t));
  assert.match(t.findings[0]!.detail, /^rotation \(travel of its edge\): swings back and forth/);
});

/** Three balls that lie in a row on a floor and touch: the smallest pile. */
const row = (seconds: number, release = -1, extra: Extra = {}): ShotSpec =>
  make([floor(), ...[0, 1, 2].map((i) => ball(`r${i}`, [-40 + i * 40, FLOOR_Y - 20], release))], [], { physics: { prewarm: 1, ...(extra.physics ?? {}) }, seconds, ...(extra.intended ? { intended: extra.intended } : {}) });

test('unsettled: a pile that still travels at the end, long after the last body landed', async () => {
  // The row slides to the right as one, at 0.3 px per frame, for the last two seconds.
  const slide = (b: Baked, speed = 0.3): void => {
    const start = b.c.frames - 120;
    for (const id of ['r0', 'r1', 'r2']) edit(b, id, (f, pose) => (pose.x += f > start ? speed * (f - start) * ease((f - start) / 30) : 0));
  };
  const b = await baked(row(5));
  assert.deepEqual(flagged(review(b)), [], 'the row lies still');
  slide(b);
  const r = review(b);
  assert.deepEqual(of(r, 'unsettled').length, r.findings.length, lines(r));
  assert.equal(r.findings.length, 1, 'one finding for the pile, not one for each body');
  const f = r.findings[0]!;
  assert.deepEqual([f.subject, ...f.group].sort(), ['r0', 'r1', 'r2'], 'it names the fastest and lists the others that still travel');
  assert.ok(Math.abs(f.value - 0.3) < 0.02, `its speed over the last half second (${f.value} px per frame)`);
  assert.deepEqual([f.threshold, f.unit, f.to], [T.restPx, 'px per frame', 299]);
  assert.match(f.detail, /^3 of the 3 bodies of its pile still travel at the end of the shot, 5\.0 s after the last one landed \(frame 0\); this one at 0\.30 px per frame over the last 0\.25 s$/);
  assert.match(f.fix, /end the pour earlier or make the shot longer/);
  assert.equal(r.world.movingAtEnd, 3);

  // Slower than rest reads as standing still.
  const still = await baked(row(5));
  slide(still, 0.1);
  assert.deepEqual(flagged(review(still)), []);
  // The balls landed a second before the end: the pile had no time to settle, so it need not have.
  const late = await baked(row(3, 2));
  slide(late);
  assert.deepEqual(flagged(review(late)), []);
  // One ball that rolls on alone is not a pile.
  const lone = review(await baked(make([floor('floor', [0, FLOOR_Y + 30], 3000), ball('solo', [-800, FLOOR_Y - 20], 0.1, 20, { velocity: [220, 0], spin: 630 })], [], { physics: { linearDamping: 0, angularDamping: 0 }, seconds: 5 })));
  assert.deepEqual(flagged(lone), [], lines(lone));
  assert.equal(lone.world.movingAtEnd, 1);
  // Marked as intended, on any body of the pile it may land on.
  const meant = await baked(row(5, -1, { intended: [intended(['r0', 'r1', 'r2'], 'unsettled', 'the row is carried off')] }));
  slide(meant);
  assert.deepEqual([flagged(review(meant)), review(meant).honoured.length], [[], 1]);
});

test('energy-spike: speed that nothing can have given, and hits that can', async () => {
  // A ball on top of a pile at rest takes off at 6 px per frame.
  const b = await baked(make(pile(), [], { seconds: 8 }));
  const last = b.c.frames - 1;
  const top = b.bake.header.bodies.filter((id) => id.startsWith('b')).reduce((x, id) => (b.bake.bodyY(b.bake.header.bodies.indexOf(id), last) < b.bake.bodyY(b.bake.header.bodies.indexOf(x), last) ? id : x));
  edit(b, top, (f, pose) => {
    if (f >= 400) pose.y -= 6 * (f - 399);
  });
  const r = review(b);
  assert.deepEqual(flagged(r), [`energy-spike ${top}`], lines(r));
  const f = r.findings[0]!;
  assert.deepEqual([f.from, f.to, f.worst], [399, 400, 400]);
  assert.ok(f.value > 5 && f.value <= 6 - 0.3, `6 px per frame less what gravity gives in two frames and what its neighbours could give (${f.value})`);
  assert.deepEqual([f.threshold, f.unit], [T.spikePx, 'px per frame']);
  assert.match(f.detail, /^speed: from 0\.\d to 6\.0 px per frame at frame 400; gravity gives 0\.3, and the fastest body it can have touched moved at 0\.\d: 5\.\d px per frame come from nowhere$/);
  assert.match(f.fix, /released inside each other or pressed into a wall/);

  // A body that only starts to spin: a disc shows nothing, a box does.
  const spun = async (id: string): Promise<PhysicsReport> => {
    const s = await baked(make([...pile(), rect({ id: 'box', at: [0, -520], w: 44, h: 44, radius: 6, fill: 'accent.pink', body: { kind: 'dynamic', release: 2.3 } })], [], { seconds: 8 }));
    edit(s, id, (g, pose) => {
      if (g >= 400) pose.rot += 0.2 * (g - 399);
    });
    return review(s);
  };
  assert.deepEqual(flagged(await spun('b5')), []);
  const box = await spun('box');
  assert.deepEqual(of(box, 'energy-spike').map((x) => x.subject), ['box'], lines(box));
  assert.match(of(box, 'energy-spike')[0]!.detail, /^spin \(travel of its edge\): from 0\.0 to/);

  // Sound: a fast heavy ball strikes a light one at rest, which leaves faster than the striker came.
  const hit = review(
    await baked(
      make([floor('floor', [0, FLOOR_Y + 30], 9000), ball('light', [0, FLOOR_Y - 12], -1, 12), ball('heavy', [-500, FLOOR_Y - 40], 0.2, 40, { velocity: [900, 0], density: 8, restitution: 0.9 })], [], {
        physics: { prewarm: 1, restitution: 0.9, friction: 0 },
        seconds: 3,
      }),
    ),
  );
  assert.deepEqual(flagged(hit), [], lines(hit));
  assert.ok(hit.world.fastest!.px > 12, `the light ball is sent off (${hit.world.fastest!.px} px per frame)`);
  // Sound: a release with a velocity and a spin, a free fall, and a bounce.
  const thrown = review(
    await baked(
      make([floor('floor', [0, FLOOR_Y + 30], 9000), rect({ id: 'brick', at: [-300, -200], w: 60, h: 40, radius: 6, fill: 'accent.pink', body: { kind: 'dynamic', release: 0.5, velocity: [500, -300], spin: 720, restitution: 0.9 } })], [], {
        physics: { restitution: 0.9 },
      }),
    ),
  );
  assert.deepEqual(flagged(thrown), [], lines(thrown));
});

test('unseen-hit: a seen body that bounces off a body that is not drawn', async () => {
  // A ball lies on the floor and is not drawn; a seen ball drops onto it. The solver does the rest.
  const drop = (lying: SceneNode, timeline: Key[] = []): ShotSpec => make([floor(), lying, ball('a', [14, -200], 0.5, 24)], timeline, { physics: { prewarm: 1 } });
  const lying = (opacity: number): SceneNode => circle({ id: 'ghost', at: [0, FLOOR_Y - 40], r: 40, fill: 'accent.pink', opacity, body: { kind: 'dynamic', release: -1 } });
  const r = review(await baked(drop(lying(0))));
  assert.deepEqual(flagged(r), ['unseen-hit a'], lines(r));
  const f = r.findings[0]!;
  assert.equal(f.other, 'ghost');
  assert.ok(f.value > 5, `the path of the ball is bent sharply (${f.value} px per frame)`);
  assert.deepEqual([f.threshold, f.unit], [T.hitPx, 'px per frame']);
  assert.ok(f.from > 60 && f.to < 120 && f.worst >= f.from && f.worst <= f.to, `at the frames of the hit (${f.from}-${f.to})`);
  assert.match(f.detail, /^its velocity changes by \d+\.\d px per frame at frame \d+, and the only thing it touches is "ghost", which is not drawn \(faded out, or without size\)$/);
  assert.match(f.fix, /A body collides from its release on, whether it is drawn or not/i);

  // The same hit on a ball that is drawn is a hit like any other.
  assert.deepEqual(flagged(review(await baked(drop(lying(1))))), []);
  // A ball that has not popped in yet has no size: it is not drawn either.
  const late = review(await baked(drop(lying(1), [popIn('ghost', { at: 4 })])));
  assert.deepEqual(flagged(late), ['unseen-hit a'], lines(late));
  // A floor that is not drawn is a wall by design: a container drawn by other shapes rests on such walls.
  const unseenFloor = make([rect({ id: 'floor', at: [0, FLOOR_Y + 30], w: 1400, h: 60, radius: 10, fill: 'dark.indigo', opacity: 0, body: { kind: 'fixed' } }), ball('a', [14, -200], 0.5, 24)]);
  assert.deepEqual(flagged(review(await baked(unseenFloor))), []);
  // Marked as intended by naming either of the two.
  const meant = review(await baked(make([floor(), lying(0), ball('a', [14, -200], 0.5, 24)], [], { physics: { prewarm: 1 }, intended: [intended('ghost', 'unseen-hit', 'a hidden bumper')] })));
  assert.deepEqual([flagged(meant), meant.honoured.length], [[], 1]);
});

test('not-finite: a broken number in a body, a spring or a particle', async () => {
  const spec = (): ShotSpec =>
    make([
      floor(),
      ball('a', [0, 0], 0.2),
      circle({ id: 'follower', at: [300, 0], r: 20, fill: 'accent.pink', follow: 'springy' }),
      emitter({ id: 'dust', at: [-300, 0], rate: 20, colors: ['light.cream'], size: 4, life: 1 }),
    ]);
  assert.deepEqual(flagged(review(await baked(spec()))), []);

  const body = await baked(spec());
  edit(body, 'a', (f, pose) => {
    if (f >= 90) pose.y = Number.NaN;
  });
  const r = review(body);
  assert.deepEqual(flagged(r), ['not-finite a'], lines(r));
  assert.deepEqual([r.findings[0]!.from, r.findings[0]!.to], [90, 359]);
  assert.match(r.findings[0]!.detail, /^rigid body: its pose is not a number from frame 90 on$/);

  const spring = await baked(spec());
  spring.bake.springs[spring.bake.springs.length - 2] = Number.POSITIVE_INFINITY;
  assert.deepEqual(flagged(review(spring)), ['not-finite follower']);

  const dust = await baked(spec());
  dust.bake.particles[dust.bake.particles.length - 4] = Number.NaN;
  const d = review(dust);
  assert.deepEqual(flagged(d), ['not-finite dust']);
  assert.equal(d.findings[0]!.from, 359);
  // Broken numbers come first in the report.
  assert.ok(d.findings[0]!.severity > 1000);
});

test('intended: physics exceptions are honoured by the physics review, motion exceptions by the motion review', async () => {
  const scene = (list: IntendedSpec[]): ShotSpec =>
    make([floor('ledge', [-300, 100], 400), ball('roller', [-400, 40], 0.2, 20, { velocity: [260, 0] }), ball('a', [-380, 40], 1.5), ball('inside', [-374, 38], 1.5)], [], { intended: list });
  const plain = review(await baked(scene([])));
  assert.deepEqual(flagged(plain), ['escape roller', 'overlap a'], lines(plain));

  // An overlap is covered by naming either body of the pair; a window in seconds limits it.
  for (const x of [intended('a', 'overlap', 'they start as one'), intended('inside', 'overlap', 'they start as one'), intended('a', 'overlap', 'they start as one', { from: 1, to: 2 })]) {
    const r = review(await baked(scene([x])));
    assert.deepEqual([flagged(r), r.honoured.length, r.unused.length], [['escape roller'], 1, 0]);
  }
  // Another kind, another body or another moment is not covered, and is listed as unused.
  for (const x of [intended('a', 'escape', 'wrong kind'), intended('roller', 'overlap', 'wrong body'), intended('a', 'overlap', 'wrong moment', { from: 4 })]) {
    const r = review(await baked(scene([x])));
    assert.deepEqual([flagged(r), r.unused.length], [['escape roller', 'overlap a'], 1]);
    assert.match(formatPhysicsReport(r), /intended, unused: \w+ on \w+: "wrong \w+" matches no finding; remove it, or check the node and the kind/);
  }

  // Each review counts its own exceptions only.
  const both = await baked(scene([intended('roller', 'escape', 'it rolls out of the picture'), intended('roller', 'too-fast', 'never raised')]));
  const physics = review(both);
  const motion = reviewMotion(both.c, both.bake).report;
  assert.deepEqual([physics.honoured.length, physics.unused.length], [1, 0]);
  assert.deepEqual([motion.honoured.length, motion.unused.map((u) => u.kind)], [0, ['too-fast']]);

  // An exception changes neither the bake nor the picture, and must name something that exists.
  assert.equal(compileShot(scene([intended('roller', 'escape', 'meant')])).sceneHash, compileShot(scene([])).sceneHash);
  assert.throws(() => scene([intended('nobody', 'escape', 'a body that is not there')]), /intended\(\.\.\., "escape"\) names "nobody", which does not exist/);
  assert.deepEqual([...PHYSICS_FINDING_KINDS], ['overlap', 'tunnelling', 'escape', 'jitter', 'unsettled', 'energy-spike', 'unseen-hit', 'not-finite']);
});

test('report: deterministic, sorted by severity, capped as text, short in check', async () => {
  // Twenty balls released in pairs, each pair as one, and one ball that rolls off.
  const spec = (): ShotSpec =>
    make([
      floor('ledge', [0, 100], 1500),
      ball('roller', [600, 40], 0.2, 20, { velocity: [300, 0] }),
      ...Array.from({ length: 10 }, (_, i) => [ball(`one${i}`, [-600 + i * 110, 40], 1 + i * 0.1), ball(`two${i}`, [-594 + i * 110, 38], 1 + i * 0.1)]).flat(),
    ]);
  const b = await baked(spec());
  const r = review(b);
  assert.deepEqual(r.byKind, { overlap: 10, escape: 1 }, lines(r));
  assert.equal(r.findings[0]!.subject, 'roller', 'the worst comes first');
  for (let i = 1; i < r.findings.length; i++) assert.ok(r.findings[i - 1]!.severity >= r.findings[i]!.severity);
  assert.deepEqual([r.counts.bodies, r.counts.dynamic, r.counts.fixed], [22, 21, 1]);

  // The same scene compiled and baked again gives the same report, byte for byte.
  assert.equal(physicsReportJson(review(await baked(spec()))), physicsReportJson(r));
  const json = JSON.parse(physicsReportJson(r)) as PhysicsReport;
  assert.deepEqual([json.version, json.findings.length, json.thresholds.overlapPx.value], [1, 11, T.overlapPx]);
  assert.ok(json.kinds.jitter.fix.length > 0 && json.kinds.jitter.means.length > 0);

  // As text: a family of generated bodies is shown once.
  const text = formatPhysicsReport(r);
  assert.match(text, /^physics tiny: 360 frames \(6\.00 s\); 22 rigid bodies \(21 dynamic, 1 fixed\), 0 springs, 0 emitters; gravity 540\nbodies: deepest overlap \d+\.\d\d px \("one\d" and "two\d", f\d+\); fastest .*\n11 warning\(s\): 10 overlap, 1 escape\n/);
  assert.match(text, /\none\d {2}and 9 more like it: one\d, /);
  assert.match(text, /\(9 more finding\(s\) of the same kind on the others\)/);
  assert.ok(text.split('\n').length < 16, `a short report (${text.split('\n').length} lines)`);

  // The short form of `check`: one line per family, and a pointer to the full report.
  const short = formatPhysicsShort(r);
  assert.equal(short.length, 4, short.join('\n'));
  assert.match(short[0]!, /^physics: 11 warning\(s\): 10 overlap, 1 escape$/);
  assert.match(short[1]!, /~ warning: escape on "roller" at f\d+-359/);
  assert.match(short[2]!, /~ warning: overlap on "one\d" \(and 9 more like it on 9 other bodies\) at f/);
  assert.match(short[3]!, /^ {2}`skink3 physics <scene>` prints the full report, and with --pictures draws the worst$/);

  // In the checks the findings are warnings: they are shown and never fail.
  assert.equal(runChecks(b.c, b.bake).physics, null, 'the physics review runs only when asked for');
  const checks = runChecks(b.c, b.bake, undefined, { motion: true, physics: true });
  assert.equal(checks.ok, true);
  assert.equal(checks.physics!.findings.length, 11);
  assert.match(formatReport(checks), /\nphysics: 11 warning\(s\): 10 overlap, 1 escape\n {2}~ warning: escape on "roller"/);
  assert.match(formatReport(checks), /checks passed with \d+ warning\(s\)$/);
  const clean = await baked(make(pile(), [], { seconds: 8 }));
  assert.match(formatReport(runChecks(clean.c, clean.bake, undefined, { physics: true })), /\nphysics: ok\nchecks passed$/);
});

test('docs: the guide lists every threshold with its value and reason, and every kind of finding', () => {
  const guide = readFileSync(fileURLToPath(new URL('../docs/PHYSICS-REVIEW.md', import.meta.url)), 'utf8');
  for (const [name, t] of Object.entries(PHYSICS_THRESHOLDS)) {
    assert.ok(guide.includes(`| \`${name}\` | ${t.value} | ${t.unit} | ${t.why} |`), `docs/PHYSICS-REVIEW.md must hold the row of ${name} as it is in src/review/physics-thresholds.ts`);
  }
  for (const kind of PHYSICS_FINDING_KINDS) assert.ok(guide.includes(`| \`${kind}\` |`), `the guide explains ${kind}`);
  // The rule that keeps the checks in step with the physics is written where an engine agent reads it.
  assert.match(guide, /## When the physics changes/);
  assert.match(readFileSync(fileURLToPath(new URL('../docs/PRINCIPLES.md', import.meta.url)), 'utf8'), /physics checks grow with the physics/i);
});

test('pictures: a close-up, a trail or a graph, by the kind of finding', async () => {
  const b = await baked(make([floor('ledge', [-300, 100], 400), ball('roller', [-400, 40], 0.2, 20, { velocity: [260, 0] }), ball('a', [-380, 40], 1.5), ball('inside', [-374, 38], 1.5)]));
  const r = review(b);
  const series = sampleMotion(b.c, b.bake, { particles: false });
  const size = (png: Buffer): [number, number] => [png.readUInt32BE(16), png.readUInt32BE(20)];
  const pictures = await physicsPictures(b.c, b.bake, series, r, { count: 3, gpu: false, lang: 'en' });
  assert.deepEqual(pictures.map((p) => p.name), ['01_roller_escape_trail.png', '01_roller_escape_close.png', '02_a_overlap_close.png']);
  assert.ok(pictures.every((p) => p.png.subarray(1, 4).toString('ascii') === 'PNG'));
  assert.match(pictures[2]!.note, /^overlap at f\d+-\d+: frames \d+, \d+, \d+, \d+; "a" ringed in blue, "inside" in orange$/);
  assert.deepEqual(size(pictures[2]!.png), [1920, 270], 'four tiles of 480 px, 16:9');

  // The same call gives the same picture.
  const opts = { bodies: ['a', 'inside'], frames: [90, 91, 92], lang: 'en', gpu: false };
  const close = await renderCloseUp(b.c, b.bake, opts);
  assert.ok((await renderCloseUp(b.c, b.bake, opts)).equals(close), 'deterministic');
  assert.deepEqual(size(close), [1440, 270]);
  await assert.rejects(renderCloseUp(b.c, b.bake, { ...opts, bodies: ['ledge', 'nobody'] }), /"nobody" is not a rigid body/);

  // A tremble is shown as a graph, with the finding marked on it.
  const p = await baked(make(pile(), [], { seconds: 8 }));
  edit(p, 'b5', (f, pose) => (pose.x += f >= 400 && f < 460 ? (f % 2 === 0 ? 0.35 : -0.35) : 0));
  const graphs = await physicsPictures(p.c, p.bake, sampleMotion(p.c, p.bake, { particles: false }), review(p), { count: 3, gpu: false, lang: 'en' });
  assert.deepEqual(graphs.map((g) => [g.kind, g.name]), [['graph', '01_b5_jitter_graph.png']]);
});

test('geometry: distances and depths of the colliders, checked by hand', () => {
  const place = (shape: Parameters<typeof colliderOf>[0], x: number, y: number, rot = 0, scale = 1): { p: Float64Array; n: number; r: number } => {
    const col = colliderOf(shape, scale);
    const p = new Float64Array(Math.max(2, col.n * 2));
    placeCore(col, x, y, rot, p);
    return { p, n: col.n, r: col.radius };
  };
  const sep = (a: ReturnType<typeof place>, b: ReturnType<typeof place>): number => separation(a.p, a.n, a.r, b.p, b.n, b.r);
  const near = (v: number, want: number, what: string): void => assert.ok(Math.abs(v - want) < 1e-9, `${what}: ${v}, expected ${want}`);

  // Two circles: apart, touching, sunk in.
  near(sep(place(circleShape(10), 0, 0), place(circleShape(5), 20, 0)), 5, 'circles apart');
  near(sep(place(circleShape(10), 0, 0), place(circleShape(5), 15, 0)), 0, 'circles touching');
  near(sep(place(circleShape(10), 0, 0), place(circleShape(5), 9, 12)), 0, 'circles touching on a slant');
  near(sep(place(circleShape(10), 0, 0), place(circleShape(5), 3, 4)), -10, 'a circle deep in a circle');
  // A circle and a rectangle of 100 x 40: beside a face, off a corner, in a face, in the middle.
  const box = place(rectShape(100, 40, 0), 0, 0);
  near(sep(place(circleShape(10), 0, -35), box), 5, 'above a face');
  near(sep(place(circleShape(10), 53, -24), box), -5, 'off a corner, 5 units into it');
  near(sep(place(circleShape(10), 0, -25), box), -5, 'sunk into a face');
  near(sep(place(circleShape(10), 30, 0), box), -30, 'in the middle: the nearest way out is through the long face');
  // Rounded corners take their radius off the corner: the same rectangle with a corner radius of 10.
  const round = place(rectShape(100, 40, 10), 0, 0);
  near(sep(place(circleShape(10), 0, -35), round), 5, 'a rounded rectangle has the same faces');
  near(sep(place(circleShape(1), 53, -24), round), Math.hypot(13, 14) - 11, 'and a corner that is cut back');
  // The scale of a body scales its collider.
  near(sep(place(circleShape(10), 0, 0, 0, 2), place(circleShape(5), 40, 0, 0, 2)), 10, 'scaled circles');
  // Capsules: two segments with radius. Parallel, crossing, end to end.
  const cap = (x: number, y: number, rot: number): ReturnType<typeof place> => place(capsuleShape(100, 10), x, y, rot);
  near(sep(cap(0, 0, 0), cap(0, 30, 0)), 10, 'capsules side by side');
  near(sep(cap(0, 0, 0), cap(0, 0, Math.PI / 2)), -60, 'capsules that cross in the middle: half a core and both radii to part them');
  near(sep(cap(0, 0, 0), cap(100, 0, 0)), 0, 'capsules end to end');
  near(sep(cap(0, 0, 0), place(circleShape(5), 60, 0)), 5, 'a capsule and a circle beyond its end');
  // Polygons: a triangle on a box, turned boxes.
  near(sep(place(rectShape(40, 40, 0), 0, 0), place(rectShape(40, 40, 0), 50, 0)), 10, 'boxes side by side');
  near(sep(place(rectShape(40, 40, 0), 0, 0), place(rectShape(40, 40, 0), 30, 0)), -10, 'boxes sunk in');
  near(sep(place(rectShape(40, 40, 0), 0, 0), place(rectShape(40, 40, 0), 20 + 20 * Math.SQRT2 + 3, 0, Math.PI / 4)), 3, 'a box and the corner of a turned box');
  assert.ok(Math.abs(sep(place(regularPolygonShape(3, 30, 0), 0, 0), place(rectShape(200, 20, 0), 0, 30)) - 5) < 1e-6, 'a triangle 5 units above a slab');

  // A point in a shape, and a path through a shape.
  near(depthOfPoint(0, 0, box.p, box.n, box.r), 20, 'the middle of the box is 20 deep');
  near(depthOfPoint(0, -30, box.p, box.n, box.r), -10, 'a point 10 above it');
  assert.ok(Math.abs(pathInside(-200, 0, 200, 0, box.p, box.n, box.r, 1) - 100) < 1e-3, 'a path through the box runs 100 inside it');
  assert.ok(Math.abs(pathInside(-200, 0, 0, 0, box.p, box.n, box.r, 1) - 50) < 1e-3, 'a path that ends in the middle runs 50 inside');
  assert.equal(pathInside(-200, -30, 200, -30, box.p, box.n, box.r, 1), 0, 'a path that passes above runs 0 inside');
  assert.equal(segmentsCross(0, -10, 0, 10, -10, 0, 10, 0), true);
  assert.equal(segmentsCross(0, -10, 0, 10, 5, 20, 10, 0), false);

  // The hull of a blob is convex and holds its outline.
  const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [2, 8]]);
  assert.equal(hull.length, 4);
  const blob = colliderOf(blobShape(60, { points: 9, wobble: 0.3, seed: 4 }));
  assert.ok(blob.n >= 8 && blob.n <= 28 && blob.radius === 0 && blob.bound > 50 && blob.inner > 20);
});

test('geometry: the review and the physics library agree on how far two colliders are apart', async () => {
  // The review does not ask the solver, so that it does not share its mistakes. This test holds
  // the two against each other on many pairs of every kind of shape at random poses. When the
  // colliders of the world change, this fails until the review follows.
  const R = await loadRapier();
  const world = new R.World({ x: 0, y: 0 });
  const shapes = [
    circleShape(24),
    capsuleShape(90, 14),
    capsuleShape(70, 12, 'start'),
    rectShape(80, 50, 12),
    rectShape(60, 60, 0),
    regularPolygonShape(3, 40, 8),
    regularPolygonShape(6, 36, 0),
    blobShape(40, { points: 9, wobble: 0.2, seed: 3 }),
  ];
  const rng = new Rng(11, 'pairs');
  let compared = 0;
  let sunk = 0;
  let worst = 0;
  for (let k = 0; k < 600; k++) {
    const sa = rng.pick(shapes);
    const sb = rng.pick(shapes);
    const scaleA = rng.pick([1, 1, 1.5]);
    const scaleB = rng.pick([1, 0.6]);
    const a = { x: rng.range(-20, 20), y: rng.range(-20, 20), rot: rng.range(-Math.PI, Math.PI) };
    const b = { x: rng.range(-110, 110), y: rng.range(-110, 110), rot: rng.range(-Math.PI, Math.PI) };
    const bodyA = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(a.x, a.y).setRotation(a.rot));
    const bodyB = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(b.x, b.y).setRotation(b.rot));
    const colA = world.createCollider(colliderFor(R, scaleShape(sa, scaleA), 'a'), bodyA);
    const colB = world.createCollider(colliderFor(R, scaleShape(sb, scaleB), 'b'), bodyB);
    const theirs = colA.contactCollider(colB, 1000);
    const ca = colliderOf(sa, scaleA);
    const cb = colliderOf(sb, scaleB);
    const pa = new Float64Array(Math.max(2, ca.n * 2));
    const pb = new Float64Array(Math.max(2, cb.n * 2));
    placeCore(ca, a.x, a.y, a.rot, pa);
    placeCore(cb, b.x, b.y, b.rot, pb);
    const ours = separation(pa, ca.n, ca.radius, pb, cb.n, cb.radius);
    world.removeRigidBody(bodyA);
    world.removeRigidBody(bodyB);
    if (!theirs) continue;
    compared++;
    if (ours < 0) sunk++;
    worst = Math.max(worst, Math.abs(ours - theirs.distance));
    // The library finds the distance of shapes that are apart by iteration, to about a thousandth of
    // the distance (a brute-force search along the outlines sides with the review). Near a contact,
    // where the review judges, the two agree closely.
    const slack = 0.02 + 0.002 * Math.abs(theirs.distance);
    assert.ok(Math.abs(ours - theirs.distance) < slack, `pair ${k} (${sa.kind} x${scaleA}, ${sb.kind} x${scaleB}): the review says ${ours.toFixed(3)}, the library ${theirs.distance.toFixed(3)}`);
  }
  world.free();
  assert.ok(compared > 500 && sunk > 100, `${compared} pairs compared, ${sunk} of them sunk into each other (largest difference ${worst})`);
});

test('cli: physics writes its report and its pictures under out/<shot id>, and check shows the short form', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const cli = join(root, 'bin', 'skink3.mjs');
  const defects = join(root, 'test', 'fixtures', 'defects', 'scene.ts');
  const dir = mkdtempSync(join(tmpdir(), 'skink3-physics-'));
  const run = (...args: string[]): string => {
    const r = spawnSync(process.execPath, [cli, ...args, '--cache', join(dir, 'cache'), '--cpu'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `${args.join(' ')}\n${r.stderr}`);
    return r.stdout;
  };
  try {
    // Findings are warnings: the command succeeds, prints them and writes the JSON report.
    const text = run('physics', defects, '--pictures', '--top', '2');
    assert.match(text, /^physics defects: 240 frames \(4\.00 s\); 4 rigid bodies \(3 dynamic, 1 fixed\), 0 springs, 0 emitters; gravity 540\nbodies: /);
    assert.match(text, /\n2 warning\(s\): 1 overlap, 1 escape\n/);
    const json = JSON.parse(readFileSync(join(dir, 'out', 'defects', 'physics.json'), 'utf8')) as PhysicsReport;
    assert.deepEqual([json.shot, json.findings.map((f) => f.kind)], ['defects', ['escape', 'overlap']]);
    const pictures = readdirSync(join(dir, 'out', 'defects', 'physics')).sort();
    assert.deepEqual(pictures, ['01_roller_escape_close.png', '01_roller_escape_trail.png', '02_host_overlap_close.png']);
    assert.match(text, /\nclose of host \(overlap at f61-\d+: frames 57, 60, 61, 65; "host" ringed in blue, "inside" in orange\): .*02_host_overlap_close\.png\n/);

    // check: both reviews in short form, and the checks pass.
    const check = run('check', defects);
    assert.match(check, /\nmotion: 1 warning\(s\): 1 abrupt-start\n {2}~ warning: abrupt-start on "mover"/);
    assert.match(check, /\nphysics: 2 warning\(s\): 1 overlap, 1 escape\n {2}~ warning: escape on "roller" at f\d+-239/);
    assert.match(check, /`skink3 physics <scene>` prints the full report, and with --pictures draws the worst\nchecks passed with 3 warning\(s\)\n$/);

    // The demo shot is sound: neither review has anything to say about it.
    const demoScene = join(root, 'examples', 'demo', 'scene.ts');
    assert.match(run('physics', demoScene), /\nno warnings\n\nfull report: .*physics\.json\n$/);
    assert.ok(existsSync(join(dir, 'out', 'demo', 'physics.json')));
    assert.match(run('check', demoScene), /\nmotion: ok\nphysics: ok\nchecks passed\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
