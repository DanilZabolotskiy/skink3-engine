import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  emitter,
  evaluate,
  fadeTo,
  flatItems,
  frameRaw,
  layer,
  rateTo,
  readBake,
  reviewMotion,
  reviewPhysics,
  sceneEvents,
  shot,
  writeBake,
  type Key,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';
import { fadeOverLife, growSizeOverLife } from '../src/physics/particles.ts';

// Particles that fade: an emitter's particles can each fade over their own life (fade), grow as they fade (sizing
// "grow"), and be faded together as one picture (opacity, keyed by fadeTo); its rate can be keyed over time (rateTo).
// Vapor that thins as it rises, a plume that swells and thins on a cue, a haze of lights that thins and comes back.

const WIDTH = 960;

function make(nodes: LayerSpec['nodes'], timeline: readonly Key[] = [], seconds = 4): ShotSpec {
  return shot({
    id: 'fading',
    seconds,
    seed: 5,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, tint: 0, nodes })],
    timeline,
  });
}

/** One particle that rests where it is born, from the start, for the length of its life. */
const still = (extra: object = {}): LayerSpec['nodes'] => [
  emitter({ id: 'dot', at: [0, 0], bursts: [{ at: 0, count: 1 }], colors: ['light.cream'], size: 40, sizing: 'steady', life: 3, speed: 0, drag: 0, ...extra }),
];

/** The brightest red of the frame, 0..255. */
async function brightest(spec: ShotSpec, frame: number): Promise<number> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
  let most = 0;
  for (let i = 0; i < raw.length; i += 4) most = Math.max(most, raw[i]!);
  return most;
}

/** The red of the pixel at stage units [x, y]. */
async function redAt(spec: ShotSpec, frame: number, x: number, y: number): Promise<number> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
  const k = WIDTH / 1920;
  const px = Math.round((x + 960) * k);
  const py = Math.round((y + 540) * k);
  return raw[(py * WIDTH + px) * 4]!;
}

test('fade: every particle runs from the opacity of its birth to that of its death, and a cache file keeps it', async () => {
  assert.equal(fadeOverLife([0.8, 0], 0), 0.8);
  assert.equal(fadeOverLife([0.8, 0], 0.5), 0.4);
  assert.equal(fadeOverLife([0, 1], 0.25), 0.25);
  const spec = make(still({ fade: [0.8, 0.2] }));
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  assert.equal(bake.header.sizes.particleAlphas, bake.particles.length / 4);
  // Half-way through its life of 3 s (frame 90) it is half-way between its two opacities.
  const half = bake.alphasAt(0, 90)!;
  assert.equal(half.length, 1);
  assert.ok(Math.abs(half[0]! - 0.5) < 0.01, `half-way: ${half[0]}`);
  assert.ok(bake.alphasAt(0, 3)![0]! > 0.79);
  // The item of the frame carries the opacities with the particles.
  const item = flatItems(evaluate(c, bake, 90, 'en').layers[0]!.items)[0]!;
  assert.ok(item.kind === 'particles' && item.alphas && item.alphas.length === 1);
  // On screen: the particle is as bright over the background as its opacity says.
  const ground = await brightest(make(still({ fade: [0, 0] })), 90);
  const full = await brightest(make(still()), 90);
  const faded = await brightest(spec, 90);
  const share = (faded - ground) / (full - ground);
  assert.ok(Math.abs(share - 0.5) < 0.05, `drawn at ${share.toFixed(3)} of its full brightness`);
  const dir = mkdtempSync(join(tmpdir(), 'skink3-fade-'));
  try {
    const file = join(dir, 'bake.bin');
    writeBake(file, bake);
    const again = readBake(file);
    assert.equal(again.header.sizes.particleAlphas, bake.particleAlphas.length);
    assert.deepEqual(Array.from(again.alphasAt(0, 90)!), Array.from(half));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fade: particles that fade are each drawn on their own, so where they crowd they add up', async () => {
  // Two particles of one colour at a quarter of their opacity, half over each other.
  const pair = (opacityOfEmitter?: number): ShotSpec =>
    make([
      emitter({ id: 'a', at: [-20, 0], bursts: [{ at: 0, count: 1 }], colors: ['light.cream'], size: 40, sizing: 'steady', life: 3, speed: 0, drag: 0, fade: [0.25, 0.25] }),
      emitter({ id: 'b', at: [20, 0], bursts: [{ at: 0, count: 1 }], colors: ['light.cream'], size: 40, sizing: 'steady', life: 3, speed: 0, drag: 0, fade: [0.25, 0.25], ...(opacityOfEmitter === undefined ? {} : { opacity: opacityOfEmitter }) }),
    ]);
  const one = await redAt(pair(), 60, -50, 0);
  const both = await redAt(pair(), 60, 0, 0);
  assert.ok(both > one + 8, `where they crowd (${both}) it is denser than one alone (${one})`);
});

test('grow: a growing particle swells to nearly half its size, then grows evenly to its full size at its death', async () => {
  assert.equal(growSizeOverLife(0), 0);
  assert.ok(Math.abs(growSizeOverLife(0.12) - (0.4 + 0.6 * 0.12)) < 1e-12);
  assert.ok(Math.abs(growSizeOverLife(0.5) - 0.7) < 1e-12);
  assert.ok(growSizeOverLife(0.999) > 0.99);
  for (let a = 0.01; a < 1; a += 0.01) assert.ok(growSizeOverLife(a) > growSizeOverLife(a - 0.01), 'it never shrinks');
  const c = compileShot(make(still({ sizing: 'grow', fade: [0.8, 0] })));
  const bake = await bakeShot(c);
  const r = (frame: number): number => bake.particlesAt(0, frame)[2]!;
  assert.ok(r(30) < r(90) && r(90) < r(170), `${r(30)} < ${r(90)} < ${r(170)}`);
  assert.ok(Math.abs(r(90) - 40 * 0.7) < 0.5, `half-way it is at 0.7 of its size: ${r(90)}`);
});

test('emitter opacity: its particles are faded together as one picture, and fadeTo keys it', async () => {
  // Two opaque particles of one colour over each other: faded as one picture, where they overlap is as bright as one.
  const pair = (extra: object, timeline: readonly Key[] = []): ShotSpec =>
    make(
      [emitter({ id: 'pair', at: [0, 0], area: [0, 0], bursts: [{ at: 0, count: 2 }], colors: ['light.cream'], size: 40, sizing: 'steady', life: 3, speed: 0, drag: 0, ...extra })],
      timeline,
    );
  const ground = await redAt(pair({ opacity: 0 }), 60, 0, 0);
  const full = await redAt(pair({}), 60, 0, 0);
  const half = await redAt(pair({ opacity: 0.5 }), 60, 0, 0);
  const share = (half - ground) / (full - ground);
  assert.ok(Math.abs(share - 0.5) < 0.05, `at opacity 0.5 the two are drawn at ${share.toFixed(3)} as one picture`);
  // A fadeTo takes it from its opacity to another: half-way through, half-way between.
  const keyed = pair({ opacity: 1 }, [fadeTo('pair', { at: 1, to: 0, dur: 1 })]);
  const c = compileShot(keyed);
  const bake = await bakeShot(c);
  const groupAt = (frame: number): { opacity: number } | undefined => {
    const items = evaluate(c, bake, frame, 'en').layers[0]!.items;
    const g = items.find((i) => i.kind === 'group');
    return g && g.kind === 'group' ? g : undefined;
  };
  assert.equal(groupAt(30), undefined, 'at full opacity it is drawn as it always was');
  assert.ok(Math.abs(groupAt(90)!.opacity - 0.5) < 0.02, `half-way: ${groupAt(90)!.opacity}`);
  assert.equal(evaluate(c, bake, 150, 'en').layers[0]!.items.length, 0, 'faded out, nothing of it is drawn');
  // Its glow fades with it.
  const glowing = compileShot(pair({ opacity: 0.4, glow: 1 }));
  const gb = await bakeShot(glowing);
  const item = flatItems(evaluate(glowing, gb, 60, 'en').layers[0]!.items)[0]!;
  assert.ok(item.kind === 'particles' && item.faded === 0.4);
  // A fade of an emitter is no event of the sound track.
  assert.deepEqual(sceneEvents(c, bake).filter((e) => e.node === 'pair' && e.kind === 'fade'), []);
});

test('rateTo: the rate of an emitter is keyed over time, smoothly, chained, between its from and until', async () => {
  const counted = async (extra: object, timeline: readonly Key[]): Promise<number[]> => {
    const c = compileShot(make([emitter({ id: 'jet', at: [0, 0], colors: ['light.cream'], size: 4, life: 0.5, speed: 0, drag: 0, sizing: 'steady', rate: 0, ...extra })], timeline, 6));
    const bake = await bakeShot(c);
    // Particles live half a second: a frame holds the births of the last half second, the rate times 0.5.
    return [30, 90, 150, 210, 270, 330].map((f) => bake.particlesAt(0, f).length / 4);
  };
  const keyed = await counted({}, [rateTo('jet', { at: 1, to: 100, dur: 1 }), rateTo('jet', { at: 4, to: 20, dur: 0.5 })]);
  assert.equal(keyed[0], 0, 'rate 0 before the first key');
  assert.ok(Math.abs(keyed[2]! - 50) <= 2 && Math.abs(keyed[3]! - 50) <= 2, `100 a second after the first key: ${keyed}`);
  assert.ok(Math.abs(keyed[5]! - 10) <= 2, `20 a second after the second: ${keyed}`);
  // Half-way through a key the rate is half-way, and it changes smoothly: no step between two frames.
  const c = compileShot(make([emitter({ id: 'jet', at: [0, 0], colors: ['light.cream'], size: 4, life: 0.25, speed: 0, drag: 0, sizing: 'steady', rate: 0 })], [rateTo('jet', { at: 1, to: 240, dur: 2 })], 4));
  const bake = await bakeShot(c);
  const n = (f: number): number => bake.particlesAt(0, f).length / 4;
  // The particles of frame 128 were born in the quarter of a second round the middle of the key, at about 120 a second.
  assert.ok(Math.abs(n(128) - 30) <= 3, `half-way through the key, about half the rate: ${n(128)}`);
  for (let f = 61; f < 200; f++) assert.ok(Math.abs(n(f) - n(f - 1)) <= 3, `a smooth change at frame ${f}`);
  // A keyed rate keeps to the window of the emitter.
  const windowed = await counted({ until: 3 }, [rateTo('jet', { at: 1, to: 100, dur: 1 })]);
  assert.equal(windowed[4], 0);
});

test('fade, grow, opacity and rateTo: what they refuse', () => {
  const bad = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, (e: unknown) => e instanceof Error && message.test(e.message), String(message));
  };
  bad(() => still({ fade: [1.2, 0] }), /fade is \[birth, death\], each an opacity 0\.\.1/);
  bad(() => still({ fade: [0.5, -0.1] }), /fade is \[birth, death\], each an opacity 0\.\.1/);
  bad(() => still({ fade: 0.5 }), /fade must be \[x, y\]/);
  bad(() => still({ fade: [1, 1] }), /fade \[1, 1\] fades nothing/);
  bad(() => still({ sizing: 'grow' }), /sizing "grow" makes every particle largest when it dies.*no fade/);
  bad(() => still({ sizing: 'grow', fade: [0.5, 0.2] }), /give it fade: \[birth, 0\]/);
  bad(() => still({ sizing: 'big' }), /sizing must be "spark", "steady" or "grow"/);
  bad(() => still({ opacity: 1.5 }), /opacity must be a number in 0\.\.1/);
  bad(() => rateTo('jet', { at: 1, to: -1 }), /to must be a number in 0\.\.5000/);
  bad(() => rateTo('jet', { at: 1, to: 10, dur: 0 }), /dur must be a number in 0\.05\.\.3600/);
  bad(() => rateTo('jet', { at: 1, to: 10, speed: 2 } as never), /unknown option "speed"/);
  bad(() => compileShot(make([circle({ id: 'disc', r: 10, fill: 'light.cream' })], [rateTo('disc', { at: 1, to: 10 })])), /rateTo cannot target shape "disc"; it applies to emitters/);
  bad(() => compileShot(make(still({ bursts: undefined, rate: 0 }))), /emitter "dot" never emits: its rate is 0 and no rateTo raises it/);
  bad(() => emitter({ id: 'e', colors: ['light.cream'], size: 3, life: 1 }), /never emits/);
  bad(() => compileShot(make(still(), [fadeTo('dot', { at: 1, to: 0, sound: 'hiss' })])), /fades the particles of an emitter, which makes no event to sound/);
  // An emitter that starts at rate 0 and is raised by a rateTo is sound.
  assert.doesNotThrow(() => compileShot(make(still({ bursts: undefined, rate: 0 }), [rateTo('dot', { at: 1, to: 5 })])));
});

test('fade, opacity and rateTo are opt-in: an emitter without them is the data, the bake and the picture it was', async () => {
  const node = still()[0]!;
  assert.ok(!('fade' in node) && !('opacity' in node));
  const c = compileShot(make(still()));
  assert.equal(c.nodes[0]!.opacity, null, 'no track of opacity');
  assert.ok(!('rate' in c.nodes[0]!), 'no track of rate');
  const bake = await bakeShot(c);
  assert.ok(!('particleAlphas' in bake.header.sizes), 'the bake names no opacities');
  assert.equal(bake.particleAlphas.length, 0);
  assert.equal(bake.alphasAt(0, 60), null);
  const item = flatItems(evaluate(c, bake, 60, 'en').layers[0]!.items)[0]!;
  assert.ok(item.kind === 'particles' && !('alphas' in item) && !('faded' in item));
  // A fade moves nothing, and a rateTo to the rate it has sends out the same particles.
  const moving = (extra: object, timeline: readonly Key[] = []): ShotSpec =>
    make([emitter({ id: 'jet', at: [-300, 0], rate: 30, colors: ['light.cream'], size: 6, life: 2, speed: [80, 160], spread: 90, direction: 0, ...extra })], timeline);
  const plain = await bakeShot(compileShot(moving({})));
  const faded = await bakeShot(compileShot(moving({ fade: [0.6, 0.6] })));
  const keyed = await bakeShot(compileShot(moving({}, [rateTo('jet', { at: 1, to: 30 })])));
  assert.deepEqual(Array.from(faded.particles), Array.from(plain.particles));
  assert.deepEqual(Array.from(keyed.particles), Array.from(plain.particles));
  // Beside an emitter that fades, one without a fade draws opaque particles, and the same ones.
  const both = compileShot(make([...still({ fade: [0.5, 0.5] }), emitter({ id: 'other', at: [0, 200], bursts: [{ at: 0, count: 1 }], colors: ['light.cream'], size: 40, sizing: 'steady', life: 3, speed: 0, drag: 0 })]));
  const bb = await bakeShot(both);
  const items = flatItems(evaluate(both, bb, 60, 'en').layers[0]!.items);
  assert.deepEqual(items.map((i) => i.kind === 'particles' && 'alphas' in i), [true, false]);
  assert.deepEqual(Array.from(bb.alphasAt(1, 60)!), [1]);
});

test('fade and opacity: the motion review knows them', async () => {
  const findings = async (spec: ShotSpec): Promise<string[]> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c)).report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel}`);
  };
  // A stream of particles that strobes, seen: the planted defect. The same stream faded too far to be seen: no finding.
  const fast = (extra: object): ShotSpec =>
    make([emitter({ id: 'jet', at: [-900, 0], rate: 40, colors: ['accent.amber'], size: 4, life: 2, speed: 1500, direction: 0, spread: 2, drag: 0, ...extra })], [], 2);
  const strobes = (list: string[]): string[] => list.filter((f) => f.startsWith('too-fast'));
  assert.deepEqual(strobes(await findings(fast({ fade: [0.9, 0.3] }))), ['too-fast jet particles']);
  assert.deepEqual(strobes(await findings(fast({ fade: [0.04, 0.01] }))), []);
  assert.deepEqual(strobes(await findings(fast({ opacity: 0.03 }))), []);
  // An emitter faded out within a frame pops: the planted defect. Faded out over a second: no finding.
  const plume = (dur: number): ShotSpec =>
    make([emitter({ id: 'plume', at: [0, 200], rate: 30, colors: ['light.cream'], size: 10, life: 2, speed: [40, 80], prewarm: 2 })], [fadeTo('plume', { at: 2, to: 0, dur })]);
  assert.deepEqual((await findings(plume(0.05))).filter((f) => f.startsWith('jump')), ['jump plume opacity']);
  assert.deepEqual((await findings(plume(1))).filter((f) => f.startsWith('jump')), []);
  // Particles that drift too slowly to count as moving, and fade in and out over their life: seen to change, they keep
  // the frame alive. The same particles too faint to be seen leave it dead: the planted defect.
  const twinkle = (fade: [number, number]): ShotSpec =>
    make([emitter({ id: 'lights', at: [0, 0], area: [1900, 1060], rate: 120, prewarm: 3, colors: ['light.cream'], size: 30, sizing: 'steady', life: 2, speed: 0, drag: 0, fade })], [], 8);
  const dead = (list: string[]): string[] => list.filter((f) => f.startsWith('dead-area'));
  assert.deepEqual(dead(await findings(twinkle([0, 0.9]))), []);
  assert.ok(dead(await findings(twinkle([0.02, 0.04]))).some((f) => f === 'dead-area (frame) hold'));
});

test('rateTo: the motion review judges what it sends out: a rate keyed to 0 leaves the frame dead once its particles are gone', async () => {
  const stream = (to: number): ShotSpec =>
    make([emitter({ id: 'mist', at: [0, 0], area: [1900, 1060], rate: 80, prewarm: 2, colors: ['light.cream'], size: 20, life: 1.5, speed: [30, 60] })], [rateTo('mist', { at: 1, to, dur: 0.5 })], 9);
  const dead = async (spec: ShotSpec): Promise<string[]> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c)).report.findings.filter((f) => f.kind === 'dead-area').map((f) => f.subject);
  };
  assert.ok((await dead(stream(0))).includes('(frame)'), 'the planted defect: the mist stops');
  assert.deepEqual(await dead(stream(40)), [], 'the sound scene: it thins and goes on');
});

test('fade: the physics review knows it: an opacity that is not a number is a broken bake, a sound one is clean', async () => {
  const c = compileShot(make([emitter({ id: 'jet', at: [-300, 0], rate: 20, colors: ['light.cream'], size: 6, life: 2, speed: 100, direction: 0, fade: [0.8, 0] })]));
  const bake = await bakeShot(c);
  assert.deepEqual(reviewPhysics(c, bake).findings.map((f) => f.kind), []);
  bake.particleAlphas[bake.particleAlphas.length - 1] = Number.NaN;
  const r = reviewPhysics(c, bake);
  assert.deepEqual(r.findings.map((f) => `${f.kind} ${f.subject}`), ['not-finite jet']);
  assert.match(r.findings[0]!.detail, /^particles: the opacity of a particle of this emitter is not a number at frame 239$/);
});
