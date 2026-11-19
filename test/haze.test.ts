import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  emitter,
  evaluate,
  frameRaw,
  group,
  hazeTo,
  heightFor,
  layer,
  rect,
  reviewMotion,
  scaleTo,
  sceneEvents,
  shot,
  stroke,
  type Key,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';

// A heat haze: a shape with a haze moves the picture drawn before it, inside its outline, by ripples that drift, so
// that it wavers like air over heat. It has no look of its own; what is drawn after it stays steady.

const WIDTH = 960;
const K = WIDTH / 1920;
const H = heightFor(WIDTH);

interface Extra {
  seconds?: number;
  seed?: number;
  layers?: LayerSpec[];
  perspective?: object;
}

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], extra: Extra = {}): ShotSpec {
  return shot({
    id: 'tiny',
    seconds: extra.seconds ?? 3,
    seed: extra.seed ?? 3,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [...(extra.layers ?? []), layer({ id: 'stage', depth: 0, tint: 0, nodes, ...(extra.perspective ? { perspective: extra.perspective } : {}) })],
    timeline,
  });
}

/** Upright bars 40 units wide, pale and dark in turn, across the middle of the stage: a picture whose every move shows. */
const bars = (): LayerSpec['nodes'] =>
  Array.from({ length: 24 }, (_, i) => rect({ id: `bar-${i}`, at: [-460 + i * 40, 0], w: 40, h: 600, radius: 0, fill: i % 2 === 0 ? 'light.snow' : 'dark.navy', lit: false }));

/** An invisible area of 400 by 200 units in the middle, with a haze. */
const air = (haze: object = {}, extra: object = {}): LayerSpec['nodes'][number] =>
  rect({ id: 'air', w: 400, h: 200, radius: 0, fill: 'accent.amber', opacity: 0, haze: { amount: 8, ...haze }, ...extra });

/** Drawn after the haze, over its middle. */
const dot = (): LayerSpec['nodes'][number] => circle({ id: 'dot', r: 40, fill: 'accent.coral', lit: false });

const scene = (haze: object = {}, extra: object = {}): LayerSpec['nodes'] => [...bars(), air(haze, extra), dot()];
const plain = (): LayerSpec['nodes'] => [...bars(), dot()];

async function raw(spec: ShotSpec, frame: number, gpu = false): Promise<Uint8Array> {
  const c = compileShot(spec);
  return frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu });
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** How many pixels differ between two frames inside a box of the stage, [x0, y0, x1, y1] about its middle. */
function changed(a: Uint8Array, b: Uint8Array, box: readonly [number, number, number, number]): number {
  let n = 0;
  for (let y = Math.round(H / 2 + box[1] * K); y < Math.round(H / 2 + box[3] * K); y++) {
    for (let x = Math.round(WIDTH / 2 + box[0] * K); x < Math.round(WIDTH / 2 + box[2] * K); x++) {
      const i = (y * WIDTH + x) * 4;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
    }
  }
  return n;
}

test('haze: the picture drawn before it wavers inside its outline; what is drawn after it and what lies outside stay as they were', async () => {
  const still = await raw(make(plain()), 60);
  const hazy = await raw(make(scene()), 60);
  // Inside the outline the bars are moved: their upright edges wave.
  const inside = changed(still, hazy, [-190, -90, -50, 90]) + changed(still, hazy, [50, -90, 190, 90]);
  assert.ok(inside > 300, `${inside} pixels moved inside`);
  // The dot is drawn after the haze: not a pixel of it moves.
  assert.equal(changed(still, hazy, [-26, -26, 26, 26]), 0);
  // Outside the outline and its narrow edge nothing changes.
  assert.equal(changed(still, hazy, [-460, -300, -220, 300]), 0);
  assert.equal(changed(still, hazy, [220, -300, 460, 300]), 0);
  assert.equal(changed(still, hazy, [-200, -300, 200, -112]), 0);
  // It wavers: the next frame is moved otherwise. Ripples that do not drift hold one picture.
  assert.ok(changed(hazy, await raw(make(scene()), 61), [-190, -90, 190, 90]) > 200);
  const frozen = make(scene({ speed: 0 }));
  assert.equal(sha(await raw(frozen, 60)), sha(await raw(frozen, 61)));
  assert.notEqual(sha(await raw(frozen, 60)), sha(still));
  // The ripples are the seed's: the same shot gives the same picture, another seed another one.
  assert.equal(sha(await raw(make(scene()), 60)), sha(hazy));
  assert.notEqual(sha(await raw(make(scene(), [], { seed: 4 }), 60)), sha(hazy));
  // More amount moves the picture more.
  const strong = changed(still, await raw(make(scene({ amount: 24 })), 60), [-190, -90, 190, 90]);
  assert.ok(strong > inside * 1.5, `${strong} against ${inside}`);
  // The layer lists the haze where it lies in the draw order: after the 24 bars, before the dot.
  const c = compileShot(make(scene()));
  const state = evaluate(c, await bakeShot(c), 60, 'en').layers[0]!;
  assert.equal(state.hazes!.length, 1);
  assert.deepEqual([state.hazes![0]!.before, state.items.length, state.hazes![0]!.amount], [24, 25, 8]);
});

test('haze: it works the same on the GPU, and a nearer layer with a haze alone moves the layers behind it', async () => {
  const gpu = await raw(make(scene()), 60, true);
  assert.equal(sha(gpu), sha(await raw(make(scene()), 60, true)), 'the same pixels from the same frame');
  assert.ok(changed(await raw(make(plain()), 60, true), gpu, [-190, -90, -50, 90]) > 150);
  const behind = (nodes: LayerSpec['nodes']): ShotSpec => make(nodes, [], { layers: [layer({ id: 'far', depth: 0.5, nodes: bars() })] });
  assert.ok(changed(await raw(behind([]), 60), await raw(behind([air()]), 60), [-150, -80, 150, 80]) > 400);
});

test('haze: soft spreads its edge, and a key on its shape spreads the area', async () => {
  const still = await raw(make(plain()), 60);
  // 10 to 40 units out of the right edge of the outline: untouched with a hard edge, moved with a soft one.
  const band = [210, -90, 240, 90] as const;
  assert.equal(changed(still, await raw(make(scene()), 60), band), 0);
  assert.ok(changed(still, await raw(make(scene({}, { soft: 80 })), 60), band) > 20);
  // The area grows to twice its size: what lay outside it is reached.
  const wide = [260, -90, 380, 90] as const;
  assert.equal(changed(still, await raw(make(scene()), 120), wide), 0);
  assert.ok(changed(still, await raw(make(scene(), [scaleTo('air', { at: 0.2, to: 2, dur: 0.6 })]), 120), wide) > 200);
});

test('haze: hazeTo ramps the amount; before its key the picture is the one without the haze, at the end the one with it', async () => {
  const still = make(plain());
  const ramped = make(scene({ amount: 0 }), [hazeTo('air', { at: 1, to: 8, dur: 0.5 })]);
  for (const frame of [0, 30, 59]) assert.equal(sha(await raw(ramped, frame)), sha(await raw(still, frame)), `frame ${frame}`);
  assert.notEqual(sha(await raw(ramped, 75)), sha(await raw(still, 75)));
  // Once the key has run, the haze moves the picture as one given that amount from the start: its ripples drifted all along.
  assert.equal(sha(await raw(ramped, 120)), sha(await raw(make(scene()), 120)));
  // Down again to still air.
  const calm = make(scene(), [hazeTo('air', { at: 0.5, to: 0, dur: 0.5 })]);
  assert.equal(sha(await raw(calm, 90)), sha(await raw(still, 90)));
  // A hazeTo is no event: it makes no sound.
  const c = compileShot(ramped);
  assert.deepEqual(sceneEvents(c, await bakeShot(c)), []);
});

test('haze: what it refuses', () => {
  const bad = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, (e: unknown) => e instanceof Error && message.test(e.message), String(message));
  };
  bad(() => air({ amount: -1 }), /haze\.amount must be a number in 0\.\.60/);
  bad(() => air({ amount: 61 }), /haze\.amount must be a number in 0\.\.60/);
  bad(() => air({ amount: undefined }), /haze\.amount must be a number in 0\.\.60/);
  bad(() => air({ scale: 2 }), /haze\.scale must be a number in 4\.\.4000/);
  bad(() => air({ speed: -1 }), /haze\.speed must be a number in 0\.\.10000/);
  bad(() => air({ direction: Number.NaN }), /haze\.direction must be a number in -3600\.\.3600/);
  bad(() => air({ size: 3 }), /haze: unknown option "size" \(allowed: amount, scale, speed, direction\)/);
  bad(() => rect({ id: 'air', w: 10, h: 10, fill: 'accent.amber', haze: 3 as never }), /haze must be \{ amount, scale\?, speed\?, direction\? \}/);
  bad(() => air({}, { body: 'fixed' }), /a shape with a haze cannot have body/);
  bad(() => air({}, { level: 0.5 }), /a shape with a haze cannot have level/);
  bad(() => air({}, { rise: 10 }), /a shape with a haze cannot have rise/);
  bad(() => air({}, { clipTo: 'dot' }), /a shape with a haze cannot have clipTo/);
  bad(() => group({ id: 'g', haze: { amount: 1 } } as never), /unknown option "haze"/);
  bad(() => stroke({ id: 's', points: [[0, 0], [100, 0]], color: 'light.snow', haze: { amount: 1 } } as never), /unknown option "haze"/);
  bad(() => emitter({ id: 'e', rate: 1, colors: ['light.snow'], haze: { amount: 1 } } as never), /unknown option "haze"/);
  // It moves what its layer has drawn so far: it lies directly in a flat layer.
  bad(() => make([group({ id: 'g', children: [air()] })]), /shape "air" has a haze: that is for a shape listed directly in a layer's nodes; put the haze beside the group/);
  bad(() => make([rect({ id: 'air', at: [0, 0, 0], w: 100, h: 100, fill: 'accent.amber', opacity: 0, haze: { amount: 2 } })], [], { perspective: { tilt: 50 } }), /shape "air" has a haze, and the layer "stage" is a perspective layer/);
  bad(() => hazeTo('air', { at: 1, to: 4, overshoot: 0.2 } as never), /hazeTo\("air"\): unknown option "overshoot" \(allowed: at, to, dur, profile, ramp\)/);
  bad(() => hazeTo('air', { at: 1 } as never), /to must be a number in 0\.\.60/);
  bad(() => hazeTo('air', { at: 1, to: 61 }), /to must be a number in 0\.\.60/);
  bad(() => hazeTo('air', { at: 1, to: 4, dur: 0.01 }), /dur must be a number in 0\.05\.\.3600/);
  bad(() => hazeTo('air', { at: 1, to: 4, profile: 'settle' as never }), /profile/);
  bad(() => hazeTo('air', { at: 1, to: 4, profile: 'steady', ramp: 0.2 }), /ramp applies to the profiles ease, in and out/);
  bad(() => make(plain(), [hazeTo('dot', { at: 0, to: 4 })]), /hazeTo cannot target shape "dot"; it applies to a shape with a haze/);
  bad(() => make([group({ id: 'g' })], [hazeTo('g', { at: 0, to: 4 })]), /hazeTo cannot target group "g"/);
  bad(() => make(scene(), [hazeTo('air', { at: 9, to: 4 })]), /hazeTo\("air"\) starts at 9 s, after the shot ends/);
});

test('haze: it is opt-in: a shape without a haze is the data and the picture it was', async () => {
  const node = rect({ id: 'air', w: 400, h: 200, fill: 'accent.amber', opacity: 0 });
  assert.ok(!('haze' in node));
  const c = compileShot(make([...bars(), node, dot()]));
  assert.equal(c.byId.get('air')!.haze, null);
  const state = evaluate(c, await bakeShot(c), 60, 'en').layers[0]!;
  assert.ok(!('hazes' in state));
  // The same invisible shape with a haze of amount 0 draws the very same picture.
  const none = await raw(make([...bars(), node, dot()]), 60);
  assert.equal(sha(await raw(make(scene({ amount: 0 })), 60)), sha(none));
  assert.equal(sha(await raw(make(plain()), 60)), sha(none));
  // Its defaults are written into the data, so that what the shot means does not hang on them.
  assert.deepEqual((air() as { haze?: unknown }).haze, { amount: 8, scale: 40, speed: 30, direction: -90 });
});

test('haze: the motion review knows it: ripples that drift too fast strobe, a gentle haze is clean and keeps its part of the frame alive', async () => {
  const review = async (spec: ShotSpec): Promise<string[]> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c)).report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel}`).sort();
  };
  // The planted defect: ripples 20 units long that drift 400 units a second, two thirds of the finer ones a frame.
  assert.deepEqual(await review(make(scene({ scale: 20, speed: 400 }))), ['too-fast air haze']);
  // The sound scene: the default ripples drift a few hundredths of their size a frame.
  assert.deepEqual(await review(make(scene())), []);
  // Too faint to be seen: a tenth of a pixel of reach does not strobe, however fast.
  assert.deepEqual(await review(make(scene({ amount: 0.1, scale: 20, speed: 400 }))), []);
  // Seven seconds of a frame where nothing else moves: a haze over all of it keeps it alive, frozen ripples do not.
  const over = (haze: object): ShotSpec => make([...plain(), rect({ id: 'air', w: 1920, h: 1080, fill: 'accent.amber', opacity: 0, haze: { amount: 3, ...haze } })], [], { seconds: 7 });
  assert.deepEqual(await review(over({})), []);
  assert.deepEqual(await review(over({ speed: 0 })), ['dead-area (frame) hold']);
  // A haze in the top left corner keeps that sixth of the frame alive, and the rest of it is dead.
  const corner = await review(make([...plain(), rect({ id: 'air', at: [-700, -300], w: 300, h: 300, fill: 'accent.amber', opacity: 0, haze: { amount: 3 } })], [], { seconds: 7 }));
  assert.deepEqual(corner, ['bottom-center', 'bottom-left', 'bottom-right', 'top-center', 'top-right'].map((r) => `dead-area (frame:${r}) hold`));
});
