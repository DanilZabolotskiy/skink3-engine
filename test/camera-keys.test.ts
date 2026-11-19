import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  cameraAt,
  cameraTo,
  circle,
  compileShot,
  evaluate,
  frameRaw,
  group,
  heightFor,
  IntentError,
  layer,
  layerView,
  popIn,
  rect,
  reviewMotion,
  SceneError,
  sceneEvents,
  shot,
  type CompiledShot,
  type Key,
  type ShotSpec,
} from '../src/index.ts';

// Camera keys: the camera zooms and moves at moments of the timeline, with its drift and its wander on top.

type Camera = NonNullable<Parameters<typeof shot>[0]['camera']>;

const STILL: Camera = { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } };

function make(timeline: Key[], camera: Camera = STILL, seconds = 6): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 5,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera,
    layers: [
      layer({ id: 'far', depth: 1, nodes: [circle({ id: 'back', at: [600, 300], r: 40, fill: 'mid.violet', lit: false })] }),
      layer({ id: 'stage', depth: 0, nodes: [circle({ id: 'dot', r: 50, fill: 'accent.pink', lit: false }), circle({ id: 'detail', at: [400, -200], r: 10, fill: 'accent.aqua', lit: false })] }),
      layer({ id: 'near', depth: -0.5, nodes: [circle({ id: 'front', at: [-700, 350], r: 30, fill: 'dark.indigo', lit: false })] }),
    ],
    timeline,
  });
}

/** The camera of a shot at a moment. */
function at(c: CompiledShot, seconds: number): ReturnType<typeof cameraAt> {
  return cameraAt(c.spec.camera, c.cameraNoise, Math.round(seconds * 60), c.frames, c.cameraTrack);
}

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

test('camera keys: cameraTo is a key of the timeline without a node, and it refuses what it does not take', () => {
  assert.deepEqual(cameraTo({ at: 2, zoom: 0.5 }), { kind: 'cameraTo', target: null, at: 2, dur: 1.2, zoom: 0.5, profile: 'ease', ramp: 0.3 });
  assert.deepEqual(cameraTo({ at: 2, to: [300, -120], dur: 2, profile: 'out', ramp: 0.2 }), { kind: 'cameraTo', target: null, at: 2, dur: 2, to: [300, -120], profile: 'out', ramp: 0.2 });
  const bad = (opts: object, message: RegExp): void => {
    assert.throws(() => cameraTo(opts as never), (e: unknown) => e instanceof IntentError && message.test(e.message), String(message));
  };
  bad({ at: 1 }, /cameraTo: give zoom, to, or both/);
  bad({ at: 1, zoom: 2, ease: 'in' }, /cameraTo: unknown option "ease" \(allowed: at, dur, zoom, to, profile, ramp\)/);
  bad({ at: 1, zoom: 0 }, /zoom must be a number in 0\.01\.\.10000/);
  bad({ at: 1, to: [1] }, /to must be \[x, y\]/);
  bad({ at: 1, zoom: 2, profile: 'settle' }, /profile must be one of ease, steady, in, out/);
  bad({ at: 1, zoom: 2, profile: 'steady', ramp: 0.2 }, /ramp applies to the profiles ease, in and out/);
  assert.throws(() => make([cameraTo({ at: 7, zoom: 2 })]), /cameraTo starts at 7 s, after the shot ends \(6 s\)/);
});

test('camera keys: a shot without them has the camera it had; with them the zoom runs at one apparent speed and keys chain', () => {
  // No key: no track, and the camera says nothing of a keyed zoom.
  const drifting: Camera = { at: [40, -20], drift: { speed: 0.5, heading: 30, wander: 10, period: 7 }, pushIn: { from: 1, to: 1.05 } };
  const plain = compileShot(make([popIn('dot', { at: 0.5 })], drifting));
  assert.equal(plain.cameraTrack, null);
  for (const f of [0, 77, 200, 359]) {
    const cam = cameraAt(plain.spec.camera, plain.cameraNoise, f, plain.frames, plain.cameraTrack);
    assert.deepEqual(cam, cameraAt(plain.spec.camera, plain.cameraNoise, f, plain.frames));
    assert.deepEqual(Object.keys(cam), ['x', 'y', 'zoom']);
    assert.deepEqual(layerView(cam, 0.5), { zoom: Math.max(0.01, 1 + (cam.zoom - 1) * 0.5), tx: 960 - cam.x * 0.5 * (1 + (cam.zoom - 1) * 0.5), ty: 540 - cam.y * 0.5 * (1 + (cam.zoom - 1) * 0.5) });
  }
  assert.ok(!JSON.stringify(make([popIn('dot', { at: 0.5 })])).includes('cameraTo'));

  // One steady key from 1 to 100: the zoom is a ratio, so half-way it is 10, and every frame multiplies it by the same factor.
  const far = compileShot(make([cameraTo({ at: 1, zoom: 100, dur: 4, profile: 'steady' })]));
  assert.equal(at(far, 0.5).keyZoom, 1);
  assert.ok(near(at(far, 3).keyZoom!, 10, 1e-9) && near(at(far, 5).keyZoom!, 100, 1e-9) && at(far, 5.9).keyZoom === 100);
  const step = at(far, 2 + 1 / 60).keyZoom! / at(far, 2).keyZoom!;
  for (const t of [1.5, 3.25, 4.5]) assert.ok(near(at(far, t + 1 / 60).keyZoom! / at(far, t).keyZoom!, step, 1e-9), `at ${t} s`);
  // Eased by default: slow at both ends, the same in the middle.
  const eased = compileShot(make([cameraTo({ at: 1, zoom: 100, dur: 4 })]));
  assert.ok(at(eased, 1.2).keyZoom! < 1.05 && near(at(eased, 3).keyZoom!, 10, 1e-9) && at(eased, 4.8).keyZoom! > 95);
  // Keys chain: each starts from the zoom the camera has, also when the one before is still under way.
  const chained = compileShot(make([cameraTo({ at: 0, zoom: 4, dur: 2, profile: 'steady' }), cameraTo({ at: 1, zoom: 1, dur: 1, profile: 'steady' }), cameraTo({ at: 3, zoom: 0.25, dur: 1, profile: 'steady' })]));
  assert.deepEqual([0.5, 1, 1.5, 2, 2.9, 3.5, 4, 5].map((t) => Math.round(at(chained, t).keyZoom! * 1000) / 1000), [1.414, 2, 1.414, 1, 1, 0.5, 0.25, 0.25]);
  // The push-in of the shot stays: the keyed zoom multiplies it.
  const pushed = compileShot(make([cameraTo({ at: 1, zoom: 2, dur: 1 })], { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1.2 } }));
  const end = at(pushed, 5.9);
  assert.ok(end.zoom > 1.19 && end.keyZoom === 2 && near(layerView(end, 1).zoom, end.zoom * 2));
});

test('camera keys: `to` is where the camera looks when the key ends, a zoom alone holds the view, and the drift goes on as large on screen', () => {
  const drifting: Camera = { at: [40, -20], drift: { speed: 0.6, heading: 0, wander: 0 }, pushIn: { from: 1, to: 1 } };
  // Before the first key: the camera of the shot.
  const moved = compileShot(make([cameraTo({ at: 2, to: [300, -120], zoom: 4, dur: 1.5 })], drifting));
  const plain = compileShot(make([], drifting));
  for (const t of [0, 1, 2]) assert.deepEqual([at(moved, t).x, at(moved, t).y], [at(plain, t).x, at(plain, t).y], `at ${t} s`);
  // At the end of the key: exactly there, whatever the drift did meanwhile.
  assert.deepEqual([at(moved, 3.5).x, at(moved, 3.5).y, at(moved, 3.5).keyZoom], [300, -120, 4]);
  // Afterwards the drift goes on from there: 0.6 units a frame at zoom 1 is 0.15 units a frame at zoom 4, the same on screen.
  assert.ok(near(at(moved, 4.5).x - at(moved, 3.5).x, (0.6 * 60) / 4, 1e-9) && at(moved, 4.5).y === -120);
  // A zoom alone holds the view: the middle of the frame stays the middle while it zooms.
  const zoomed = compileShot(make([cameraTo({ at: 2, zoom: 3, dur: 1 })], drifting));
  const before = at(zoomed, 2);
  for (const t of [2.25, 2.5, 3]) assert.ok(near(at(zoomed, t).x, before.x) && near(at(zoomed, t).y, before.y), `at ${t} s`);
  // A place alone keeps the zoom.
  const panned = compileShot(make([cameraTo({ at: 1, to: [-200, 100], dur: 1, profile: 'steady' })]));
  assert.deepEqual([at(panned, 1.5).x, at(panned, 1.5).y, at(panned, 1.5).keyZoom, at(panned, 2).x], [-100, 50, 1, -200]);

  // A push into a detail keeps it in view: its place on screen nears the middle at one speed.
  const push = compileShot(make([cameraTo({ at: 1, to: [400, -200], zoom: 50, dur: 2, profile: 'steady' })]));
  const offset = (t: number): number => (400 - at(push, t).x) * at(push, t).keyZoom!;
  assert.ok(near(offset(1), 400) && near(offset(1.5), 300, 1e-6) && near(offset(2), 200, 1e-6) && near(offset(2.5), 100, 1e-6) && near(offset(3), 0, 1e-6));
  // A pull-back lets the place it leaves slide out at one speed.
  const pull = compileShot(make([cameraTo({ at: 0, to: [400, -200], zoom: 50, dur: 0.5 }), cameraTo({ at: 1, to: [0, 0], zoom: 1, dur: 2, profile: 'steady' })]));
  const left = (t: number): number => (400 - at(pull, t).x) * at(pull, t).keyZoom!;
  assert.ok(near(left(1), 0, 1e-6) && near(left(2), 200, 1e-6) && near(left(3), 400, 1e-6));

  // The wander stays on top, and as large on screen as without keys.
  const wandering: Camera = { drift: { speed: 0, wander: 12, period: 3 }, pushIn: { from: 1, to: 1 } };
  const w = compileShot(make([cameraTo({ at: 0, zoom: 8, dur: 0.5 })], wandering));
  const free = compileShot(make([], wandering));
  for (const t of [1, 2.2, 4]) assert.ok(near(at(w, t).x * 8, at(free, t).x, 1e-9) && near(at(w, t).y * 8, at(free, t).y, 1e-9), `at ${t} s`);
  // On a camera path the keys act from where the path has carried the camera.
  const onPath: Camera = { path: { points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true, speed: 0.5 }, drift: { wander: 0 } };
  const p = compileShot(make([cameraTo({ at: 2, to: [50, 50], zoom: 2, dur: 1 })], onPath));
  assert.deepEqual([at(p, 1).x, at(p, 1).y], [at(compileShot(make([], onPath)), 1).x, at(compileShot(make([], onPath)), 1).y]);
  assert.deepEqual([at(p, 3).x, at(p, 3).y], [50, 50]);
});

test('camera keys: a far layer grows less than the focus plane, a near one more, and none turns inside out', async () => {
  const c = compileShot(make([cameraTo({ at: 0, zoom: 4, dur: 1, profile: 'steady' }), cameraTo({ at: 3, zoom: 0.01, dur: 1, profile: 'steady' })]));
  const cam = at(c, 2);
  const views = c.layers.map((l) => layerView(cam, l.parallax).zoom);
  assert.deepEqual(views.map((z) => Math.round(z * 1000) / 1000), [2, 4, 16], 'parallax 0.5, 1 and 2: the zoom to the power of the parallax');
  const wide = at(c, 5);
  for (const l of c.layers) assert.ok(layerView(wide, l.parallax).zoom > 0, l.spec.id);
  assert.ok(near(layerView(wide, 2).zoom, 1e-4, 1e-12));

  // In the picture: at zoom 2 the dot in the middle is twice as wide.
  const width = async (spec: ShotSpec, frame: number): Promise<number> => {
    const cs = compileShot(spec);
    const raw = await frameRaw(cs, await bakeShot(cs), frame, { width: 960, lang: 'en', gpu: false });
    const y = heightFor(960) / 2;
    let n = 0;
    for (let x = 0; x < 960; x++) if (raw[(y * 960 + x) * 4]! > 180 && raw[(y * 960 + x) * 4 + 1]! < 140) n++;
    return n;
  };
  const twice = make([cameraTo({ at: 0, zoom: 2, dur: 1 })]);
  const one = await width(twice, 0);
  const two = await width(twice, 90);
  assert.ok(Math.abs(one - 50) <= 2 && Math.abs(two - 100) <= 2, `${one} px, then ${two} px`);
  // A zoom by orders of magnitude draws: the blur of the far layer and the halos do not grow past the frame.
  const deep = make([cameraTo({ at: 0, zoom: 2000, dur: 1, profile: 'steady' })]);
  const cd = compileShot(deep);
  const state = evaluate(cd, await bakeShot(cd), 90, 'en');
  assert.ok(near(state.layers[1]!.view.zoom, 2000, 1e-6));
  const raw = await frameRaw(cd, await bakeShot(cd), 90, { width: 480, lang: 'en', gpu: false });
  assert.equal(raw.length, 480 * heightFor(480) * 4);
  assert.ok(raw[(heightFor(480) / 2) * 480 * 4 + 240 * 4]! > 180, 'the dot fills the middle of the frame');
});

test('camera keys: the motion review judges a camera key, and the events of the shot do not hold it', async () => {
  const flagged = async (timeline: Key[]): Promise<string[]> => {
    const c = compileShot(make([popIn('dot', { at: 0.2 }), ...timeline]));
    return reviewMotion(c, await bakeShot(c))
      .report.findings.filter((f) => f.subject === '(camera)')
      .map((f) => `${f.kind} ${f.channel}`)
      .sort();
  };
  // Sound: eased keys, also across orders of magnitude and while the camera moves.
  assert.deepEqual(await flagged([cameraTo({ at: 1, zoom: 60, to: [400, -200], dur: 2 }), cameraTo({ at: 3.5, zoom: 1, to: [0, 0], dur: 2 })]), []);
  // Planted: one speed from rest to rest starts and stops abruptly, for a zoom as for a move.
  assert.deepEqual(await flagged([cameraTo({ at: 1, zoom: 3, dur: 2, profile: 'steady' })]), ['abrupt-start scale', 'abrupt-stop scale']);
  assert.deepEqual(await flagged([cameraTo({ at: 1, to: [500, 0], dur: 2, profile: 'steady' })]), ['abrupt-start position', 'abrupt-stop position']);
  // The camera is no event.
  const c = compileShot(make([popIn('dot', { at: 0.2 }), cameraTo({ at: 1, zoom: 2 })]));
  assert.deepEqual(sceneEvents(c, await bakeShot(c)).map((e) => e.kind), ['appear']);
});

test('camera keys: a detail drawn in its own units sits in a wide view at its true size, and a deep zoom shows it as it was drawn', async () => {
  // A yard 800 units wide with a gate 200 wide in its middle, a five-hundredth as large in the wide view, to the right of the middle.
  const yard = (scale: number): ReturnType<typeof group> =>
    group({
      id: 'yard',
      at: [300, 0],
      scale,
      children: [rect({ id: 'ground', w: 800, h: 800, fill: 'accent.pink', lit: false }), rect({ id: 'gate', w: 200, h: 200, fill: 'deep.night', lit: false })],
    });
  const spec = (scale: number, timeline: Key[]): ShotSpec =>
    shot({
      id: 'tiny',
      seconds: 6,
      seed: 5,
      palette,
      strings: { en: {} },
      background: { inner: 'deep.night', outer: 'deep.night' },
      atmosphere: 'mid.mist',
      vignette: 0,
      camera: STILL,
      layers: [layer({ id: 'stage', depth: 0, nodes: [yard(scale)] })],
      timeline,
    });
  const WIDTH = 480;
  const red = async (s: ShotSpec, frame: number, x: number, y: number): Promise<boolean> => {
    const c = compileShot(s);
    const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
    const k = WIDTH / 1920;
    return raw[(Math.round(heightFor(WIDTH) / 2 + y * k) * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4]! > 150;
  };
  const deep = spec(0.002, [cameraTo({ at: 1, zoom: 500, to: [300, 0], dur: 3 })]);
  // In the wide view the yard is under two units wide: it is no more than a speck.
  assert.equal(await red(deep, 30, 300, 0), false);
  // At the end of the zoom it fills the frame as a yard of 800 units drawn at scale 1 would: its ground, and the gate in its middle.
  assert.equal(await red(deep, 300, 300, 0), true);
  assert.equal(await red(deep, 300, -300, 300), true);
  assert.equal(await red(deep, 300, 0, 0), false);
  assert.equal(await red(deep, 300, 500, 0), false);
  // The picture is the one the same yard gives at scale 1 under a camera that looks at it without a zoom.
  const plain = compileShot(spec(1, [cameraTo({ at: 1, to: [300, 0], dur: 3 })]));
  const zoomed = compileShot(deep);
  const a = await frameRaw(zoomed, await bakeShot(zoomed), 300, { width: WIDTH, lang: 'en', gpu: false });
  const b = await frameRaw(plain, await bakeShot(plain), 300, { width: WIDTH, lang: 'en', gpu: false });
  let off = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i]! - b[i]!) > 24) off++;
  assert.ok(off < (a.length / 4) * 0.002, `${off} pixels differ`);
  // A group may be far smaller and larger than a shape, down to twice the size at which a node counts as hidden.
  assert.doesNotThrow(() => yard(500));
  assert.throws(() => yard(0.001), (e: unknown) => e instanceof SceneError && /group\("yard"\): scale must be a number in 0\.002\.\.500/.test(e.message));
  assert.throws(() => rect({ id: 'r', w: 10, h: 10, fill: 'accent.pink', scale: 0.001 }), /rect\("r"\): scale must be a number in 0\.01\.\.100/);
});
