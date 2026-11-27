import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, circle, compileShot, frameRaw, layer, relief, reviewMotion, shot, sunTo, type Key, type ShapeNode, type ShotSpec } from '../src/index.ts';

// The shadows a relief casts on itself (shadows) and a light that moves over it (sunTo). A ridge across a plain, lit
// low from the left: with shadows, the plain behind the ridge lies in its shadow as far as the ridge stands higher than
// the light; the plain before it, and the plain far behind it, are lit as they were. Both are opt-in: a relief without
// them is drawn as it always was.

const WIDTH = 480;
const COLS = 121;
const ROWS = 41;
// The ridge stands 300 high at a fifth of the way from the left edge of the frame (u = 0.4 of the field).
const values = Array.from({ length: COLS * ROWS }, (_, i) => 300 * Math.exp(-(((i % COLS) / (COLS - 1) - 0.4) ** 2) * 400));

const ridge = (extra: Partial<Parameters<typeof relief>[0]> = {}): ShapeNode =>
  relief({ id: 'ridge', w: 2400, h: 1400, heights: { cols: COLS, rows: ROWS, values }, vertical: 1, sun: { from: 180, high: 25 }, dark: 'deep.night', bright: 'light.cream', tints: [[0, 'mid.jade'], [300, 'mid.rose']], ...extra });

function make(field: ShapeNode, timeline: Key[] = [], seconds = 2): ShotSpec {
  return shot({
    id: 'ridge', seconds, seed: 1, palette, strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.abyss' }, atmosphere: 'mid.mist', vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'map', depth: 0, nodes: [field] })],
    timeline,
  });
}

async function raw(spec: ShotSpec, frame: number): Promise<Buffer> {
  const c = compileShot(spec);
  return frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
}

/** The mean brightness (0..255, the three channels) of the columns x0..x1 of a frame, over its middle rows. */
function columns(frame: Buffer, x0: number, x1: number): number {
  const height = frame.length / 4 / WIDTH;
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(height * 0.25); y < Math.floor(height * 0.75); y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * WIDTH + x) * 4;
      sum += frame[o]! + frame[o + 1]! + frame[o + 2]!;
      n += 3;
    }
  }
  return sum / n;
}

/** The greatest difference of a channel between two frames, and the mean. */
function difference(a: Buffer, b: Buffer): { mean: number; most: number } {
  let sum = 0;
  let most = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    const d = Math.abs(a[i]! - b[i]!);
    sum += d;
    most = Math.max(most, d);
  }
  return { mean: sum / ((a.length / 4) * 3), most };
}

test('relief shadows: what they refuse', () => {
  assert.throws(() => ridge({ shadows: 'yes' as never }), /shadows must be true or \{ color\?, amount\?, soft\? \}/);
  assert.throws(() => ridge({ shadows: { amount: 2 } }), /shadows\.amount must be a number in 0\.\.1/);
  assert.throws(() => ridge({ shadows: { soft: 0.1 } }), /shadows\.soft must be a number in 0\.25\.\.30/);
  assert.throws(() => ridge({ shadows: { length: 3 } as never }), /unknown option "length"/);
  assert.throws(() => ridge({ shadows: { color: 'no.such' as never } }), /no\.such/);
});

test('relief shadows: the plain behind a ridge lies in its shadow as far as the ridge stands over the light, and the rest is lit as before', async () => {
  const plain = await raw(make(ridge()), 0);
  const shadowed = await raw(make(ridge({ shadows: true })), 0);
  // Before the ridge (the light comes from the left): the same.
  assert.ok(Math.abs(columns(shadowed, 10, 100) - columns(plain, 10, 100)) < 0.01);
  // Just behind it, on the plain: darker, by much.
  const behind = columns(plain, 250, 320) - columns(shadowed, 250, 320);
  assert.ok(behind > 15, `the plain behind the ridge is darker by ${behind.toFixed(1)} levels`);
  // Far behind it, where the ridge stands lower than the light: lit again.
  assert.ok(Math.abs(columns(shadowed, 400, 470) - columns(plain, 400, 470)) < 0.01);
  // A shadow of its own colour, all the way.
  const toned = await raw(make(ridge({ shadows: { color: 'accent.amber', amount: 1 } })), 0);
  const o = (Math.floor(toned.length / 4 / WIDTH / 2) * WIDTH + 285) * 4;
  assert.ok(toned[o]! > toned[o + 2]! + 60, `the shadow is amber: ${toned[o]}, ${toned[o + 1]}, ${toned[o + 2]}`);
  // A light high over the ridge throws no shadow on the plain.
  const noon = await raw(make(ridge({ sun: { from: 180, high: 80 }, shadows: true })), 0);
  const noonPlain = await raw(make(ridge({ sun: { from: 180, high: 80 } })), 0);
  assert.ok(Math.abs(columns(noon, 250, 470) - columns(noonPlain, 250, 470)) < 0.01);
  // The same with the picture of the field (picture): its shadows are made into it.
  const pictured = await raw(make(ridge({ shadows: true, picture: 2 })), 0);
  assert.ok(difference(pictured, shadowed).mean < 1.5);
});

test('relief shadows and sunTo: opt-in: a relief without them is the data, and the picture, it was', async () => {
  assert.equal('shadows' in ridge().relief!, false);
  assert.deepEqual(ridge({ shadows: true }).relief!.shadows, { color: 'deep.night', amount: 0.6, soft: 3 });
  const { shadows: _, ...rest } = ridge({ shadows: true }).relief!;
  assert.deepEqual(rest, ridge().relief);
  // A shot without sunTo has no light track on its relief.
  assert.equal(compileShot(make(ridge({ shadows: true }))).nodes.find((n) => n.id === 'ridge')!.sun, null);
});

test('sunTo: what it refuses', () => {
  assert.throws(() => sunTo('ridge', { at: 0 }), /give from, high or both/);
  assert.throws(() => sunTo('ridge', { at: 0, high: 95 }), /high must be a number in 1\.\.89/);
  assert.throws(() => sunTo('ridge', { at: 0, from: 90, dur: 0 }), /dur must be a number in 0\.05\.\.3600/);
  assert.throws(() => sunTo('ridge', { at: 0, from: 90, profile: 'steady', ramp: 0.2 }), /ramp applies to the profiles ease, in and out/);
  assert.throws(() => sunTo('ridge', { at: 0, from: 90, to: 3 } as never), /to/);
  assert.throws(() => compileShot(make(circle({ id: 'ridge', r: 10, fill: 'mid.jade' }), [sunTo('ridge', { at: 0, from: 0 })])), /sunTo cannot target shape "ridge"; it moves the light of a relief/);
  assert.throws(() => compileShot(make(ridge({ picture: 2 }), [sunTo('ridge', { at: 0, from: 0 })])), /a relief with a picture is shaded once, under one light/);
});

test('sunTo: the light moves from the light given to the light keyed, its shading and its shadows with it', async () => {
  const turned = make(ridge({ shadows: true }), [sunTo('ridge', { at: 0.2, from: 0, high: 40, dur: 1 })]);
  // Before the key: the light it was given; after it: the light keyed, as a relief given that light draws it.
  assert.deepEqual(await raw(turned, 0), await raw(make(ridge({ shadows: true })), 0));
  const after = await raw(turned, 90);
  const still = await raw(make(ridge({ shadows: true, sun: { from: 0, high: 40 } })), 0);
  const d = difference(after, still);
  assert.ok(d.mean < 0.05 && d.most <= 2, `the light keyed against the light given: mean ${d.mean.toFixed(3)}, most ${d.most}`);
  // Halfway through, the shadows lie where neither light puts them: the frame is neither.
  const half = await raw(turned, 36);
  assert.ok(difference(half, still).mean > 1 && difference(half, await raw(turned, 0)).mean > 1);
  // A frame of a turning light is the same picture drawn alone or after the frames before it.
  const c = compileShot(turned);
  const bake = await bakeShot(c);
  const run: Buffer[] = [];
  for (const f of [30, 31, 32, 33]) run.push(await frameRaw(c, bake, f, { width: WIDTH, lang: 'en', gpu: false }));
  const alone = await raw(turned, 33);
  assert.deepEqual(run[3], alone);
});

test('sunTo: the motion review: a light that swings in a few frames flashes, a slow turn is clean and is life', async () => {
  const findings = async (keys: Key[], seconds = 3): Promise<string[]> => {
    const c = compileShot(make(ridge({ shadows: true }), keys, seconds));
    return reviewMotion(c, await bakeShot(c)).report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel}`);
  };
  // Planted: a light that swings 120 degrees in a tenth of a second.
  assert.ok((await findings([sunTo('ridge', { at: 1, from: 60, dur: 0.1 })])).includes('jump ridge light'));
  // Sound: a light that goes over the sky in three seconds, and with it no hold of the frame.
  const slow = await findings([sunTo('ridge', { at: 0, from: 60, high: 40, dur: 3 })]);
  assert.deepEqual(slow.filter((f) => !f.startsWith('dead-area')), []);
  assert.deepEqual(slow.filter((f) => f.startsWith('dead-area (frame)')), []);
  // Without it, the relief alone holds still: the whole frame is a hold.
  assert.ok((await findings([], 6)).some((f) => f.startsWith('dead-area')));
});
