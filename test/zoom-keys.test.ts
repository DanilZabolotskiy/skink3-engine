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
  formatMotionReport,
  frameRaw,
  heightFor,
  IntentError,
  layer,
  layerView,
  loopPoints,
  popIn,
  rect,
  reviewMotion,
  reviewPhysics,
  runChecks,
  sceneEvents,
  shot,
  zoomTo,
  type CompiledShot,
  type Key,
  type MotionReport,
  type ShotSpec,
} from '../src/index.ts';

// Zoom keys: the zoom of the camera changes at a moment of the timeline, and nothing else does. The drift, the
// path and the wander of the camera run on under the key, so a slow push toward a subject can start on a word
// while the background keeps sliding.

type Camera = NonNullable<Parameters<typeof shot>[0]['camera']>;

const STILL: Camera = { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } };
/** A loop about the subject at the speed of a drift, with nothing else on top. */
const LOOP: Camera = { path: { points: loopPoints([0, -10], [84, 30]), closed: true, speed: 0.45 }, drift: { wander: 0 }, pushIn: { from: 1, to: 1 } };

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
      layer({ id: 'stage', depth: 0, nodes: [circle({ id: 'dot', r: 50, fill: 'accent.pink', lit: false })] }),
      layer({ id: 'near', depth: -0.5, nodes: [circle({ id: 'front', at: [-700, 350], r: 30, fill: 'dark.indigo', lit: false })] }),
      layer({ id: 'frame', depth: 0, parallax: 0, nodes: [circle({ id: 'mark', at: [-800, -440], r: 12, fill: 'light.cream', lit: false })] }),
    ],
    timeline,
  });
}

/** The camera of a shot at a frame. */
function cam(c: CompiledShot, frame: number): ReturnType<typeof cameraAt> {
  return cameraAt(c.spec.camera, c.cameraNoise, frame, c.frames, c.cameraTrack);
}

/** The camera of a shot at a moment. */
const at = (c: CompiledShot, seconds: number): ReturnType<typeof cameraAt> => cam(c, Math.round(seconds * 60));

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

test('zoom keys: zoomTo is a key of the timeline without a node, and it refuses what it does not take', () => {
  assert.deepEqual(zoomTo({ at: 2, to: 1.15 }), { kind: 'zoomTo', target: null, at: 2, dur: 3, to: 1.15, profile: 'ease', ramp: 0.3 });
  assert.deepEqual(zoomTo({ at: -1, to: 0.8, dur: 6, profile: 'out', ramp: 0.2 }), { kind: 'zoomTo', target: null, at: -1, dur: 6, to: 0.8, profile: 'out', ramp: 0.2 });
  const bad = (opts: object, message: RegExp): void => {
    assert.throws(() => zoomTo(opts as never), (e: unknown) => e instanceof IntentError && message.test(e.message), String(message));
  };
  bad({ at: 1 }, /zoomTo: to is the zoom it reaches, a number such as 1\.15/);
  // A place is not a zoom: this key never moves the camera.
  bad({ at: 1, to: [300, -120] }, /zoomTo: to is the zoom it reaches.*a zoom key leaves the camera where it is \(cameraTo moves it to a place\)/);
  bad({ at: 1, to: 2, zoom: 2 }, /zoomTo: unknown option "zoom" \(allowed: at, to, dur, profile, ramp\)/);
  bad({ at: 1, to: 2, sound: 'chime' }, /zoomTo: unknown option "sound"/);
  bad({ at: 1, to: 0 }, /to must be a number in 0\.01\.\.10000/);
  bad({ at: 1, to: 2, dur: 0 }, /dur must be a number in 0\.05\.\.600/);
  bad({ at: 1, to: 2, profile: 'settle' }, /profile must be one of ease, steady, in, out/);
  bad({ at: 1, to: 2, profile: 'steady', ramp: 0.2 }, /ramp applies to the profiles ease, in and out/);
  assert.throws(() => make([zoomTo({ at: 7, to: 2 })]), /zoomTo starts at 7 s, after the shot ends \(6 s\)/);
});

test('zoom keys: a shot without them is the data it was, and a key that changes nothing draws the frame it drew', async () => {
  // No key at all: no track, and the camera says nothing of a keyed zoom.
  const drifting: Camera = { at: [40, -20], drift: { speed: 0.5, heading: 30, wander: 10, period: 7 }, pushIn: { from: 1, to: 1.05 } };
  const plain = compileShot(make([popIn('dot', { at: 0.5 })], drifting));
  assert.equal(plain.cameraTrack, null);
  for (const f of [0, 77, 200, 359]) assert.deepEqual(Object.keys(cam(plain, f)), ['x', 'y', 'zoom']);
  // Camera keys alone: the track they always had, without a list of zoom keys.
  const keyed = compileShot(make([cameraTo({ at: 1, zoom: 2, to: [100, 0] })], drifting));
  assert.deepEqual(Object.keys(keyed.cameraTrack!), ['segs']);
  // The scene is other data only when it holds a zoom key.
  assert.notEqual(compileShot(make([popIn('dot', { at: 0.5 }), zoomTo({ at: 1, to: 1.2 })], drifting)).sceneHash, plain.sceneHash);

  // A zoom key to the zoom the camera has: every layer keeps its view to the last bit, and the frame its pixels.
  const idle = compileShot(make([popIn('dot', { at: 0.5 }), zoomTo({ at: 1, to: 1, dur: 2 })], drifting));
  for (const f of [0, 90, 150, 359]) {
    for (const l of plain.layers) assert.deepEqual(layerView(cam(idle, f), l.parallax), layerView(cam(plain, f), l.parallax), `frame ${f}, layer ${l.spec.id}`);
  }
  const raw = async (c: CompiledShot, frame: number): Promise<Buffer> => Buffer.from(await frameRaw(c, await bakeShot(c), frame, { width: 480, lang: 'en', gpu: false }));
  assert.ok((await raw(idle, 150)).equals(await raw(plain, 150)), 'the same pixels');
});

test('zoom keys: the zoom runs as a ratio along its profile, keys chain, and it multiplies the push-in and the camera keys', () => {
  // One steady key from 1 to 4: half-way it is 2, and every frame multiplies it by the same factor.
  const steady = compileShot(make([zoomTo({ at: 1, to: 4, dur: 4, profile: 'steady' })]));
  assert.equal(at(steady, 0.5).keyZoom, 1);
  assert.ok(near(at(steady, 3).keyZoom!, 2) && near(at(steady, 5).keyZoom!, 4) && at(steady, 5.9).keyZoom === 4);
  const step = at(steady, 2 + 1 / 60).keyZoom! / at(steady, 2).keyZoom!;
  for (const t of [1.5, 3.25, 4.5]) assert.ok(near(at(steady, t + 1 / 60).keyZoom! / at(steady, t).keyZoom!, step), `at ${t} s`);
  // Eased by default: slow at both ends, the same in the middle.
  const eased = compileShot(make([zoomTo({ at: 1, to: 4, dur: 4 })]));
  assert.ok(at(eased, 1.2).keyZoom! < 1.01 && near(at(eased, 3).keyZoom!, 2) && at(eased, 4.8).keyZoom! > 3.96);
  // The default length is 3 s.
  const short = compileShot(make([zoomTo({ at: 1, to: 1.5 })]));
  assert.ok(at(short, 3.9).keyZoom! < 1.5 && at(short, 4).keyZoom === 1.5);
  // Keys chain: each starts from the zoom the keys have reached, also when the one before is still under way.
  const chained = compileShot(make([zoomTo({ at: 0, to: 4, dur: 2, profile: 'steady' }), zoomTo({ at: 1, to: 1, dur: 1, profile: 'steady' }), zoomTo({ at: 3, to: 0.25, dur: 1, profile: 'steady' })]));
  assert.deepEqual([0.5, 1, 1.5, 2, 2.9, 3.5, 4, 5].map((t) => Math.round(at(chained, t).keyZoom! * 1000) / 1000), [1.414, 2, 1.414, 1, 1, 0.5, 0.25, 0.25]);
  // A key may start before the shot: it is under way, or over, at frame 0.
  assert.ok(near(at(compileShot(make([zoomTo({ at: -1, to: 4, dur: 2, profile: 'steady' })])), 0).keyZoom!, 2));
  assert.equal(at(compileShot(make([zoomTo({ at: -5, to: 1.3, dur: 2 })])), 0).keyZoom, 1.3);
  // The push-in of the shot stays: the keyed zoom multiplies it.
  const pushed = compileShot(make([zoomTo({ at: 1, to: 2, dur: 1 })], { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1.2 } }));
  const end = at(pushed, 5.9);
  assert.ok(end.zoom > 1.19 && end.keyZoom === 2 && near(layerView(end, 1).zoom, end.zoom * 2));
  // With camera keys in the shot the two zooms multiply.
  const both = compileShot(make([cameraTo({ at: 0.5, zoom: 2, dur: 1 }), zoomTo({ at: 2, to: 1.5, dur: 1 })]));
  assert.deepEqual([at(both, 0.25).keyZoom, at(both, 1.75).keyZoom, at(both, 3.5).keyZoom], [1, 2, 3]);
});

test('zoom keys: the camera looks where it looks without them, at every frame: the drift, the path and the wander run on under the key', () => {
  const cameras: Record<string, Camera> = {
    'a heading': { at: [40, -20], drift: { speed: 0.5, heading: 30, wander: 10, period: 7 }, pushIn: { from: 1, to: 1.05 } },
    'a closed path': { path: { points: loopPoints([0, -10], [84, 30]), closed: true, speed: 0.45 }, drift: { wander: 14, period: 6 } },
    'an open path, there and back': { path: { points: [[-60, 0], [0, -30], [60, 0]], speed: 0.6, turn: 1.2 }, drift: { wander: 0 } },
    'a path covered once': { path: { points: [[-200, 0], [0, 40], [200, 60]], profile: 'ease' } },
  };
  const zooms = [zoomTo({ at: 1, to: 1.3, dur: 2 }), zoomTo({ at: 4, to: 0.9, dur: 1.5, profile: 'out' })];
  for (const [name, camera] of Object.entries(cameras)) {
    const plain = compileShot(make([], camera));
    const zoomed = compileShot(make(zooms, camera));
    let changed = 0;
    for (let f = 0; f < plain.frames; f++) {
      const a = cam(plain, f);
      const b = cam(zoomed, f);
      assert.deepEqual([b.x, b.y, b.zoom], [a.x, a.y, a.zoom], `${name}, frame ${f}`);
      if (b.keyZoom !== 1) changed++;
    }
    assert.ok(changed > 250, `${name}: the zoom is another one from the first key on`);
  }
  // The same on top of camera keys: they place the view as they did, the zoom keys only multiply the zoom.
  const moved = [cameraTo({ at: 2, to: [300, -120], zoom: 2, dur: 1.5 })];
  const plain = compileShot(make(moved, cameras['a closed path']));
  const zoomed = compileShot(make([...moved, ...zooms], cameras['a closed path']));
  for (let f = 0; f < plain.frames; f++) {
    const a = cam(plain, f);
    const b = cam(zoomed, f);
    assert.deepEqual([b.x, b.y, b.zoom], [a.x, a.y, a.zoom], `frame ${f}`);
  }
  assert.ok(near(at(zoomed, 3.5).keyZoom!, 2 * 1.3) && near(at(zoomed, 5.9).keyZoom!, 2 * 0.9));

  // What it is for: under a zoom key the camera keeps the speed of its path, in units; on screen the zoom multiplies it.
  const pushed = compileShot(make([zoomTo({ at: 1, to: 1.2, dur: 4 })], LOOP));
  // A camera key that zooms holds the view for as long as it runs: the path stops under it.
  const held = compileShot(make([cameraTo({ at: 1, zoom: 1.2, dur: 4 })], LOOP));
  for (let f = 61; f <= 300; f++) {
    const units = Math.hypot(cam(pushed, f).x - cam(pushed, f - 1).x, cam(pushed, f).y - cam(pushed, f - 1).y);
    assert.ok(units > 0.44 && units < 0.4501, `frame ${f}: ${units} units`);
    assert.equal(Math.hypot(cam(held, f).x - cam(held, f - 1).x, cam(held, f).y - cam(held, f - 1).y), 0, `frame ${f}`);
  }
});

test('zoom keys: a far layer grows less than the focus plane, a near one more, and a layer of the frame not at all', async () => {
  const c = compileShot(make([zoomTo({ at: 0, to: 4, dur: 1, profile: 'steady' })]));
  const views = c.layers.map((l) => layerView(at(c, 2), l.parallax).zoom);
  assert.deepEqual(views.map((z) => Math.round(z * 1000) / 1000), [2, 4, 16, 1], 'parallax 0.5, 1, 2 and 0: the zoom to the power of the parallax');
  // The display list carries it: the view of the focus plane, and the centre of the frame where it was.
  const state = evaluate(c, await bakeShot(c), 120, 'en');
  assert.deepEqual(state.layers.map((l) => [l.layer.spec.id, Math.round(l.view.zoom * 1000) / 1000]), [['far', 2], ['stage', 4], ['near', 16], ['frame', 1]]);
  assert.deepEqual([state.layers[1]!.view.tx, state.layers[1]!.view.ty], [960, 540]);

  // In the picture: at zoom 2 the dot in the middle is twice as wide.
  const width = async (spec: ShotSpec, frame: number): Promise<number> => {
    const cs = compileShot(spec);
    const raw = await frameRaw(cs, await bakeShot(cs), frame, { width: 960, lang: 'en', gpu: false });
    const y = heightFor(960) / 2;
    let n = 0;
    for (let x = 0; x < 960; x++) if (raw[(y * 960 + x) * 4]! > 180 && raw[(y * 960 + x) * 4 + 1]! < 140) n++;
    return n;
  };
  const twice = make([zoomTo({ at: 0, to: 2, dur: 1 })]);
  const one = await width(twice, 0);
  const two = await width(twice, 90);
  assert.ok(Math.abs(one - 50) <= 2 && Math.abs(two - 100) <= 2, `${one} px, then ${two} px`);
});

test('zoom keys: the motion review judges the zoom, and says how the camera drifts under each key', async () => {
  const drifting: Camera = { path: { points: loopPoints([0, -10], [84, 30]), closed: true, speed: 0.45 }, drift: { wander: 10, period: 6 }, pushIn: { from: 1, to: 1.05 } };
  const review = async (timeline: Key[], camera: Camera = drifting): Promise<{ report: MotionReport; text: string }> => {
    const c = compileShot(make([popIn('dot', { at: 0.2 }), ...timeline], camera, 12));
    const { report } = reviewMotion(c, await bakeShot(c));
    return { report, text: formatMotionReport(report, c) };
  };
  const flagged = (report: MotionReport): string[] =>
    report.findings
      .filter((f) => f.subject === '(camera)')
      .map((f) => `${f.kind} ${f.channel}`)
      .sort();

  // Sound: a slow eased push on a camera path. No finding on the camera, and the numbers are those of the composed
  // camera: the zoom of the push-in times the key, and a drift under the key that is the path's.
  const push = await review([zoomTo({ at: 2, to: 1.2, dur: 6 })]);
  assert.deepEqual(flagged(push.report), []);
  assert.ok(near(push.report.camera.zoomFrom, 1) && near(push.report.camera.zoomTo, 1.26), `zoom ${push.report.camera.zoomFrom} to ${push.report.camera.zoomTo}`);
  assert.equal(push.report.zooms!.length, 1);
  const key = push.report.zooms![0]!;
  assert.deepEqual([key.from, key.to], [120, 480]);
  assert.ok(key.zoomFrom > 1 && key.zoomFrom < 1.02 && key.zoomTo > 1.22 && key.zoomTo < 1.25, `zoom ${key.zoomFrom} to ${key.zoomTo}`);
  assert.ok(key.driftPx > 0.4 && key.driftPx < 0.6, `the camera drifts ${key.driftPx} px per frame under the key`);
  assert.ok(push.report.camera.driftPx > 0.4 && push.report.camera.driftPx < 0.6, `drift ${push.report.camera.driftPx}`);
  assert.ok(push.report.camera.driftMinPx > 0.4, `the camera never stops: at least ${push.report.camera.driftMinPx} px per frame`);
  assert.match(push.text, /^zoom keys: 1\.0\d+ to 1\.2\d+ at 2\.00-8\.00 s, the camera drifting 0\.\d\d px per frame meanwhile$/m);
  // The layers slide against each other, each as fast as its depth says.
  const slide = (id: string): number => push.report.layers.find((l) => l.id === id)!.driftPx;
  assert.ok(slide('far') > 0.15 && slide('far') < slide('stage') && slide('stage') < slide('near'), `far ${slide('far')}, stage ${slide('stage')}, near ${slide('near')}`);
  assert.equal(slide('frame'), 0, 'a layer of the frame does not slide');

  // The same push as a camera key holds the view for half of the shot: the report shows a camera that stands, and
  // has nothing to say of zoom keys.
  const held = await review([cameraTo({ at: 2, zoom: 1.2, dur: 6 })]);
  assert.ok(held.report.camera.driftPx < 0.1 && held.report.camera.driftMinPx < 0.05, `drift ${held.report.camera.driftPx}`);
  assert.ok(!('zooms' in held.report) && !held.text.includes('zoom keys'));
  // And a shot without any key has neither.
  const none = await review([]);
  assert.ok(!('zooms' in none.report) && !none.text.includes('zoom keys'));

  // Planted: one speed from rest to rest starts and stops abruptly; so does a zoom squeezed into three frames.
  assert.deepEqual(flagged((await review([zoomTo({ at: 2, to: 3, dur: 2, profile: 'steady' })])).report), ['abrupt-start scale', 'abrupt-stop scale']);
  assert.deepEqual(flagged((await review([zoomTo({ at: 2, to: 2, dur: 0.05 })])).report), ['abrupt-start scale', 'abrupt-stop scale']);
  // A push as gentle as the one above is no jolt even at one speed: its edge travels a third of a pixel per frame.
  assert.deepEqual(flagged((await review([zoomTo({ at: 2, to: 1.2, dur: 6, profile: 'steady' })])).report), []);

  // Under zoom keys the slide of a layer is taken in the middle of the frame. A camera that stands still far from
  // the origin and zooms slides nothing, though the zoom moves the origin of every layer across the screen.
  const far = await review([zoomTo({ at: 1, to: 1.5, dur: 10 })], { at: [700, 300], drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } });
  assert.deepEqual(far.report.layers.map((l) => l.driftPx), [0, 0, 0, 0]);
  assert.deepEqual([far.report.camera.driftPx, far.report.zooms![0]!.driftPx, far.report.zooms![0]!.zoomTo], [0, 0, 1.5]);

  // Two keys are two entries; a key that is over before the shot starts has no frames to report.
  const two = await review([zoomTo({ at: 1, to: 1.3, dur: 3 }), zoomTo({ at: 6, to: 1, dur: 3 })]);
  assert.deepEqual(two.report.zooms!.map((z) => [z.from, z.to]), [[60, 240], [360, 540]]);
  assert.ok(two.report.zooms![0]!.zoomTo > 1.3 && two.report.zooms![1]!.zoomTo < 1.05);
  const before = await review([zoomTo({ at: -5, to: 1.3, dur: 3 })]);
  assert.deepEqual(before.report.zooms, []);
  assert.match(before.text, /^zoom keys: none runs within the shot$/m);
  assert.ok(near(before.report.camera.zoomFrom, 1.3), 'the zoom is there at frame 0');

  // The zoom is no event, and the checks of a shot hold with it.
  const c = compileShot(make([popIn('dot', { at: 0.2 }), zoomTo({ at: 1, to: 1.2 })], drifting));
  const bake = await bakeShot(c);
  assert.deepEqual(sceneEvents(c, bake).map((e) => e.kind), ['appear']);
  assert.equal((await runChecks(c, bake, ['en'])).ok, true);
});

test('zoom keys: the physics review sees the frame of the zoomed camera', async () => {
  // Planted off the frame: a ball released inside another one, 1300 units right of the middle. The frame is 960
  // units to either side, so nothing of it is seen, and what is not seen is not reported.
  const off = (timeline: Key[]): ShotSpec =>
    shot({
      id: 'tiny',
      seconds: 6,
      seed: 7,
      palette,
      strings: { en: {} },
      background: { inner: 'deep.night', outer: 'deep.abyss' },
      atmosphere: 'mid.mist',
      vignette: 0,
      camera: STILL,
      physics: { prewarm: 1 },
      layers: [
        layer({
          id: 'stage',
          depth: 0,
          nodes: [
            rect({ id: 'floor', at: [1300, 330], w: 600, h: 60, radius: 10, fill: 'dark.indigo', body: { kind: 'fixed' } }),
            circle({ id: 'a', at: [1300, 280], r: 20, fill: 'accent.aqua', body: { kind: 'dynamic', release: -1 } }),
            circle({ id: 'inside', at: [1306, 278], r: 20, fill: 'accent.pink', body: { kind: 'dynamic', release: 2 } }),
          ],
        }),
      ],
      timeline,
    });
  const flagged = async (timeline: Key[]): Promise<string[]> => {
    const c = compileShot(off(timeline));
    return reviewPhysics(c, await bakeShot(c))
      .findings.map((f) => `${f.kind} ${f.subject}`)
      .sort();
  };
  assert.deepEqual(await flagged([]), []);
  // The camera pulls back before the release: the place is in the frame now, and the defect is found.
  assert.deepEqual(await flagged([zoomTo({ at: 0.5, to: 0.5, dur: 1 })]), ['overlap a']);
  // It pushes in instead: still out of the frame, still nothing to report.
  assert.deepEqual(await flagged([zoomTo({ at: 0.5, to: 1.5, dur: 1 })]), []);
});
