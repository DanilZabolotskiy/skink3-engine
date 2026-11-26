import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  blurTo,
  circle,
  compileShot,
  evaluate,
  frameRaw,
  group,
  heightFor,
  intended,
  IntentError,
  layer,
  moveTo,
  reviewMotion,
  sceneEvents,
  shot,
  type Key,
  type ShotSpec,
} from '../src/index.ts';

// A pull of focus: the blur of a layer changes at a moment of the timeline (blurTo), as the focus of a lens is pulled
// from what is near to what is far. It is opt-in: a shot without it is the shot it was.

const WIDTH = 480;

function make(timeline: Key[], o: { seconds?: number; farBlur?: number; intended?: ShotSpec['intended']; sampled?: boolean } = {}): ShotSpec {
  return shot({
    id: 'tiny',
    seconds: o.seconds ?? 4,
    seed: 3,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.abyss' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [
      layer({
        id: 'far',
        depth: 1,
        ...(o.farBlur === undefined ? {} : { blur: o.farBlur }),
        nodes: o.sampled
          ? [group({ id: 'set', children: [circle({ id: 'hill', at: [-400, 0], r: 200, fill: 'accent.amber', lit: false })] })]
          : [circle({ id: 'hill', at: [-400, 0], r: 200, fill: 'accent.amber', lit: false })],
        ...(o.sampled ? { sampledBackdrop: { group: 'set', frames: [60] } } : {}),
      }),
      layer({ id: 'stage', depth: 0, nodes: [circle({ id: 'dot', at: [400, 0], r: 120, fill: 'accent.aqua', lit: false })] }),
    ],
    timeline,
    ...(o.intended ? { intended: o.intended } : {}),
  });
}

async function raw(spec: ShotSpec, frame: number): Promise<Buffer> {
  const c = compileShot(spec);
  return frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
}

const hash = async (spec: ShotSpec, frame: number): Promise<string> => createHash('sha256').update(await raw(spec, frame)).digest('hex');

/** How soft the edge of the far hill is at a frame: the number of pixels along a row across its left edge that are neither the sky nor the hill. */
async function softness(spec: ShotSpec, frame: number): Promise<number> {
  const r = await raw(spec, frame);
  const k = WIDTH / 1920;
  const y = Math.round(heightFor(WIDTH) / 2);
  const at = (x: number): number => r[(y * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4]!;
  const sky = at(-900);
  const hill = at(-400);
  let soft = 0;
  for (let x = -900; x <= -400; x += 1 / k) {
    const v = at(x);
    if (Math.abs(v - sky) > 6 && Math.abs(v - hill) > 6) soft++;
  }
  return soft;
}

test('blurTo: a key of the timeline without a node; what it refuses', () => {
  assert.deepEqual(blurTo('far', { at: 2, to: 0 }), { kind: 'blurTo', target: null, layer: 'far', at: 2, to: 0, dur: 1.2, profile: 'ease', ramp: 0.3 });
  assert.deepEqual(blurTo('far', { at: 1, to: 12, dur: 3, profile: 'in', ramp: 0.2 }), { kind: 'blurTo', target: null, layer: 'far', at: 1, to: 12, dur: 3, profile: 'in', ramp: 0.2 });
  const bad = (opts: object, message: RegExp): void => {
    assert.throws(() => blurTo('far', { at: 1, to: 4, ...opts } as never), (e: unknown) => e instanceof IntentError && message.test(e.message), String(message));
  };
  bad({ to: -1 }, /to must be a number in 0\.\.200/);
  bad({ dur: 0.01 }, /dur must be a number in 0\.05\.\.600/); // 0 is taken on the frame of a hard cut (test/cut.test.ts)
  bad({ profile: 'settle' }, /profile must be one of ease, steady, in, out/);
  bad({ profile: 'steady', ramp: 0.2 }, /ramp applies to the profiles ease, in and out/);
  bad({ zoom: 2 }, /blurTo\("far"\): unknown option "zoom" \(allowed: at, to, dur, profile, ramp\)/);
  assert.throws(() => blurTo('', { at: 1, to: 2 }), /the first argument is the id of a layer/);
  // The shot refuses a layer it does not have, a key after its end, and a layer whose backdrop is sampled at one blur.
  assert.throws(() => make([blurTo('sky', { at: 1, to: 2 })]), /blurTo names the layer "sky", which does not exist \(layers: far, stage\)/);
  assert.throws(() => make([blurTo('far', { at: 9, to: 2 })]), /blurTo\("far"\) starts at 9 s, after the shot ends \(4 s\)/);
  assert.throws(() => make([blurTo('far', { at: 1, to: 2 })], { sampled: true }), /blurTo\("far"\): the layer samples a backdrop \(sampledBackdrop\)/);
  // An intended exception may name the focus of a layer that is pulled, and only that.
  assert.doesNotThrow(() => make([blurTo('far', { at: 1, to: 2 })], { intended: [intended('(focus:far)', 'abrupt-start', 'a snap of focus')] }));
  assert.throws(() => make([], { intended: [intended('(focus:far)', 'abrupt-start', 'a snap of focus')] }), /names "\(focus:far\)", which does not exist/);
});

test('blurTo: opt-in: a shot without it is the shot it was, and a layer without keys keeps its blur', async () => {
  const plain = compileShot(make([], { farBlur: 6 }));
  assert.equal(plain.layers[0]!.blur, 6);
  assert.equal('focus' in plain.layers[0]!, false);
  const state = evaluate(plain, await bakeShot(plain), 60, 'en');
  assert.equal(state.layers.some((l) => 'blur' in l), false, 'no layer of the frame carries a blur of its own');
  // Before its key a pulled shot is pixel for pixel the shot without it; the layer it does not name stays so throughout.
  const pulled = make([blurTo('far', { at: 2, to: 0, dur: 1 })], { farBlur: 6 });
  for (const frame of [0, 60, 119]) assert.equal(await hash(pulled, frame), await hash(make([], { farBlur: 6 }), frame), `frame ${frame}`);
  assert.notEqual(await hash(pulled, 200), await hash(make([], { farBlur: 6 }), 200));
  assert.equal('focus' in compileShot(pulled).layers[1]!, false);
});

test('blurTo: the blur runs from what it is to the key\'s value along its profile, arrives exactly, keys chain, and the picture follows', async () => {
  const spec = make([blurTo('far', { at: 1, to: 0, dur: 1 }), blurTo('far', { at: 2.5, to: 10, dur: 0.5, profile: 'steady' })], { farBlur: 8 });
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const blur = (frame: number): number => evaluate(c, bake, frame, 'en').layers[0]!.blur!;
  assert.equal(blur(30), 8);
  assert.ok(blur(90) > 0 && blur(90) < 8);
  assert.equal(blur(120), 0);
  assert.equal(blur(150), 0);
  assert.ok(Math.abs(blur(165) - 5) < 1e-9, `${blur(165)}`);
  assert.equal(blur(180), 10);
  assert.equal(blur(230), 10);
  // The layer it does not name has no blur of its own at any frame.
  assert.equal(evaluate(c, bake, 90, 'en').layers[1]!.blur, undefined);
  // The far hill's edge is soft at 8, sharp at 0, softer still at 10.
  const [before, sharp, after] = [await softness(spec, 30), await softness(spec, 150), await softness(spec, 230)];
  assert.ok(sharp <= 1 && before > 3 && after > before, `${before} ${sharp} ${after}`);
  // A pull of focus is no event: it makes no sound.
  assert.deepEqual(sceneEvents(c, bake), []);
});

test('blurTo: the motion review knows it: an eased pull is clean, a snap of focus is found, and an intended snap is not', async () => {
  const findings = async (spec: ShotSpec): Promise<string[]> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c)).report.findings.filter((f) => f.subject.startsWith('(focus:')).map((f) => `${f.kind} ${f.subject} ${f.channel}`);
  };
  // The sound scene: the focus goes from near to far over a second and a half, eased at both ends.
  assert.deepEqual(await findings(make([moveTo('dot', { at: 0.2, to: [380, 20] }), blurTo('far', { at: 1, to: 0, dur: 1.5 }), blurTo('stage', { at: 1, to: 10, dur: 1.5 })], { farBlur: 12 })), []);
  // The planted defects: a pull at one speed that starts and stops at full speed, and one over three frames.
  assert.deepEqual(await findings(make([blurTo('far', { at: 1, to: 60, dur: 0.2, profile: 'steady' })])), ['abrupt-start (focus:far) focus', 'abrupt-stop (focus:far) focus']);
  const snap = await findings(make([blurTo('stage', { at: 1, to: 24, dur: 0.05 })]));
  assert.ok(snap.length > 0 && snap.every((f) => f.endsWith('(focus:stage) focus')), snap.join('; '));
  // What is meant is not reported.
  assert.deepEqual(await findings(make([blurTo('far', { at: 1, to: 60, dur: 0.2, profile: 'steady' })], { intended: [intended('(focus:far)', 'abrupt-start', 'a snap of focus'), intended('(focus:far)', 'abrupt-stop', 'a snap of focus')] })), []);
});
