import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  compileShot,
  emitter,
  evaluate,
  flatItems,
  frameRaw,
  layer,
  readBake,
  reviewMotion,
  reviewPhysics,
  shot,
  writeBake,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';

// Streaks: an emitter with a streak draws every particle as a short streak back along its way, as long as the way it
// travels in that time. Rain, sparks, a stream. The particles move as they did; only how they are drawn changes.

const WIDTH = 960;

function make(nodes: LayerSpec['nodes'], seconds = 3): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 5,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, tint: 0, nodes })],
  });
}

/** One particle, sent to the right at 600 units per second at the start of the shot. */
const stream = (extra: object = {}): LayerSpec['nodes'] => [
  emitter({ id: 'jet', at: [-600, 0], bursts: [{ at: 0, count: 1 }], colors: ['light.cream'], size: 5, sizing: 'steady', life: 2, speed: 600, direction: 0, spread: 0, drag: 0, ...extra }),
];

/** How many pixels of a frame are bright. */
async function lit(spec: ShotSpec, frame: number): Promise<number> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
  let n = 0;
  for (let i = 0; i < raw.length; i += 4) if (raw[i]! > 140 && raw[i + 1]! > 140) n++;
  return n;
}

test('streak: every particle is drawn back along its way, as long as the way of the streak, never longer than the way since birth', async () => {
  const spec = make(stream({ streak: 0.05 }));
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  // A particle a second old is 600 units on its way: its streak reaches 0.05 s back, 30 units, behind it.
  const data = bake.particlesAt(0, 60);
  const tails = bake.tailsAt(0, 60)!;
  assert.equal(data.length / 4, 1);
  assert.ok(Math.abs(tails[0]! + 30) < 1e-3 && Math.abs(tails[1]!) < 1e-3, `tail ${tails[0]}, ${tails[1]}`);
  // Two frames after its birth it has come 20 units: its streak is that long.
  const young = bake.tailsAt(0, 2)!;
  assert.ok(Math.abs(young[0]! + 20) < 1e-3, `a young streak is ${young[0]}`);
  // The item of the frame carries the tails with the particles.
  const item = flatItems(evaluate(c, bake, 60, 'en').layers[0]!.items)[0]!;
  assert.ok(item.kind === 'particles' && item.tails && item.tails.length === 2);
  // On screen: a capsule 10 units wide and 40 long instead of a disc 10 wide, about five times the pixels.
  const disc = await lit(make(stream()), 60);
  const streak = await lit(spec, 60);
  assert.ok(disc > 10 && streak > 3 * disc && streak < 7 * disc, `disc ${disc} px, streak ${streak} px`);
  // The particles themselves move as they did.
  const round = await bakeShot(compileShot(make(stream())));
  assert.deepEqual(Array.from(bake.particles), Array.from(round.particles));
  assert.deepEqual(Array.from(bake.particleVelocities), Array.from(round.particleVelocities));
});

test('streak: a streak follows the way of each particle, and a cache file keeps it', async () => {
  // Particles that fall: gravity turns their way down, and their streaks with it.
  const rain = make(stream({ streak: 0.1, gravity: [0, 900], bursts: undefined, rate: 20, life: 1.5, speed: 200 }));
  const bake = await bakeShot(compileShot(rain));
  const data = bake.particlesAt(0, 120);
  const vel = bake.velocitiesAt(0, 120);
  const tails = bake.tailsAt(0, 120)!;
  assert.ok(data.length / 4 > 10);
  for (let p = 0; p < data.length / 4; p++) {
    const back = Math.hypot(tails[2 * p]!, tails[2 * p + 1]!);
    const speed = Math.hypot(vel[2 * p]!, vel[2 * p + 1]!);
    assert.ok(back <= speed * 0.1 + 1e-3, 'never longer than the way of the streak');
    // It points against the velocity.
    assert.ok(tails[2 * p]! * vel[2 * p]! + tails[2 * p + 1]! * vel[2 * p + 1]! <= 0);
  }
  const dir = mkdtempSync(join(tmpdir(), 'skink3-streak-'));
  try {
    const file = join(dir, 'bake.bin');
    writeBake(file, bake);
    const again = readBake(file);
    assert.equal(again.header.sizes.particleTails, bake.particleTails.length);
    assert.deepEqual(Array.from(again.tailsAt(0, 120)!), Array.from(tails));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('streak: what it refuses', () => {
  const bad = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, (e: unknown) => e instanceof Error && message.test(e.message), String(message));
  };
  bad(() => stream({ streak: 0 }), /streak must be a number in 0\.001\.\.1/);
  bad(() => stream({ streak: 1.5 }), /streak must be a number in 0\.001\.\.1/);
  bad(() => stream({ streak: -0.1 }), /streak must be a number in 0\.001\.\.1/);
  bad(() => stream({ streak: '0.05' }), /streak must be a number in 0\.001\.\.1/);
  bad(() => stream({ streak: Number.NaN }), /streak must be a number in 0\.001\.\.1/);
});

test('streak: it is opt-in: an emitter without a streak is the data, the bake and the picture it was', async () => {
  const node = stream()[0]!;
  assert.ok(!('streak' in node));
  const c = compileShot(make(stream()));
  const bake = await bakeShot(c);
  assert.ok(!('particleTails' in bake.header.sizes), 'the bake names no tails');
  assert.equal(bake.particleTails.length, 0);
  assert.equal(bake.tailsAt(0, 60), null);
  const item = flatItems(evaluate(c, bake, 60, 'en').layers[0]!.items)[0]!;
  assert.ok(item.kind === 'particles' && !('tails' in item));
  // Beside an emitter of streaks, an emitter without one still draws round particles, and the same ones.
  const both = make([...stream({ streak: 0.05 }), emitter({ id: 'dots', at: [-600, 200], bursts: [{ at: 0, count: 1 }], colors: ['light.cream'], size: 5, sizing: 'steady', life: 2, speed: 600, direction: 0, spread: 0, drag: 0 })]);
  const cb = compileShot(both);
  const bb = await bakeShot(cb);
  const items = flatItems(evaluate(cb, bb, 60, 'en').layers[0]!.items);
  assert.deepEqual(items.map((i) => i.kind === 'particles' && 'tails' in i), [true, false]);
  assert.deepEqual(Array.from(bb.particlesAt(1, 60)), Array.from(bake.particlesAt(0, 60)).map((v, i) => (i === 1 ? v + 200 : v)));
});

test('streak: the motion review knows it: a streak at least as long as the way of two frames does not strobe, a shorter one does', async () => {
  const fast = (extra: object): ShotSpec =>
    make([emitter({ id: 'jet', at: [-900, 0], rate: 40, colors: ['accent.amber'], size: 4, life: 2, speed: 1500, direction: 0, spread: 2, drag: 0, ...extra })], 2);
  const flagged = async (spec: ShotSpec): Promise<string[]> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c)).report.findings.filter((f) => !f.kind.startsWith('dead-area')).map((f) => `${f.kind} ${f.subject} ${f.channel}`);
  };
  // The planted defect: round particles 25 px a frame apart, and streaks too short to close the gaps.
  assert.deepEqual(await flagged(fast({})), ['too-fast jet particles']);
  assert.deepEqual(await flagged(fast({ streak: 0.01 })), ['too-fast jet particles']);
  // The sound scene: each streak reaches back over the way of two frames, and the stream reads as one motion.
  assert.deepEqual(await flagged(fast({ streak: 0.04 })), []);
});

test('streak: the physics review knows it: a streak that is not a number is a broken bake, a sound one is clean', async () => {
  const c = compileShot(make(stream({ streak: 0.05, bursts: undefined, rate: 20 })));
  const bake = await bakeShot(c);
  assert.deepEqual(reviewPhysics(c, bake).findings.map((f) => f.kind), []);
  bake.particleTails[bake.particleTails.length - 1] = Number.NaN;
  const r = reviewPhysics(c, bake);
  assert.deepEqual(r.findings.map((f) => `${f.kind} ${f.subject}`), ['not-finite jet']);
  assert.match(r.findings[0]!.detail, /^particles: the streak of a particle of this emitter is not a number at frame 179$/);
});
