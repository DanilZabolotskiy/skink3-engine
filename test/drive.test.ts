import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  computeWorld,
  drive,
  evaluate,
  eye,
  fadeTo,
  flatItems,
  frameRaw,
  group,
  heightFor,
  IntentError,
  layer,
  link,
  moveTo,
  posesFromBake,
  rect,
  region,
  reshape,
  reviewMotion,
  scaleTo,
  sceneEvents,
  shot,
  stroke,
  turnTo,
  type Key,
  type LayerSpec,
  type ShotSpec,
  type Vec2,
} from '../src/index.ts';
import { opacities } from '../src/scene/evaluate.ts';

// A node that follows a computed function of time: its place, its turn, its size, its opacity, its place
// in the draw order of its layer, and the points of a region or a stroke.

const WIDTH = 480;

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], seconds = 6): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 3,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    // A still camera: a place of the stage is that place on screen, moved by half a frame.
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;
const dot = (extra: object = {}): ReturnType<typeof circle> => circle({ id: 'a', r: 40, fill: 'accent.pink', lit: false, ...extra });
/** From rest to rest: 0 at 0, 1 at 1, no speed at either end. */
const ease = (u: number): number => {
  const v = Math.min(1, Math.max(0, u));
  return v * v * (3 - 2 * v);
};

/** The red of the pixel at a place of the stage: high on the pink of the tests, low on their aqua and on the background. */
async function red(spec: ShotSpec, frame: number, x: number, y: number): Promise<number> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
  const k = WIDTH / 1920;
  return raw[(Math.round(heightFor(WIDTH) / 2 + y * k) * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4]!;
}

async function hash(spec: ShotSpec, frame: number): Promise<string> {
  const c = compileShot(spec);
  return createHash('sha256').update(await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false })).digest('hex');
}

async function flagged(spec: ShotSpec): Promise<string[]> {
  const c = compileShot(spec);
  return reviewMotion(c, await bakeShot(c))
    .report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel}`)
    .sort();
}

test('drive: the key holds what its function gave at every frame, not the function, and refuses what it does not take', () => {
  const key = drive('a', { at: 1, dur: 2, by: (t) => ({ at: [100 * t, -50 * t], rotation: 90 * t }) });
  assert.equal(key.kind, 'drive');
  assert.deepEqual([key.target, key.at, key.dur, key.count, key.placeDims], ['a', 1, 2, 121, 2]);
  assert.equal(key.place!.length, 242);
  assert.ok(near(key.place![2]!, 100 / 60) && near(key.place![3]!, -50 / 60) && near(key.place![240]!, 200) && near(key.rotation![120]!, 180));
  // Only what the function returns is there, and the key is plain data.
  assert.deepEqual(Object.keys(key).sort(), ['at', 'count', 'dur', 'kind', 'place', 'placeDims', 'rotation', 'target']);
  assert.deepEqual(JSON.parse(JSON.stringify(key)), key);
  // The function is called with the seconds since the key starts, once per frame of the key.
  const asked: number[] = [];
  drive('a', { at: 5, dur: 0.05, by: (t) => (asked.push(t), { opacity: 1 }) });
  assert.deepEqual(asked.map((t) => Math.round(t * 600) / 600), [0, 1 / 60, 2 / 60, 0.05].map((t) => Math.round(t * 600) / 600));
  // Samples given ready: the same key, with as many samples as were given.
  assert.deepEqual(drive('a', { at: 2, dur: 3, samples: { rotation: [0, 90, 180] } }), { kind: 'drive', target: 'a', at: 2, dur: 3, count: 3, rotation: [0, 90, 180] });
  assert.deepEqual(drive('a', { dur: 1, samples: { at: [[0, 0, 0], [10, 0, 50]], depth: [1, 2] } }), { kind: 'drive', target: 'a', at: 0, dur: 1, count: 2, place: [0, 0, 0, 10, 0, 50], placeDims: 3, depth: [1, 2] });
  const outline = drive('a', { dur: 1, samples: { points: [[[0, 0], [10, 0], [0, 10]], [[0, 0], [20, 0], [0, 20]]] } });
  assert.deepEqual([outline.points, outline.pointDims], [[[0, 0, 10, 0, 0, 10], [0, 0, 20, 0, 0, 20]], 2]);

  const bad = (opts: object, message: RegExp): void => {
    assert.throws(() => drive('a', opts as never), (e: unknown) => e instanceof IntentError && message.test(e.message), String(message));
  };
  bad({ dur: 1 }, /give either by \(a function of the seconds since the key starts\) or samples/);
  bad({ dur: 1, by: () => ({ at: [0, 0] }), samples: { at: [[0, 0], [1, 1]] } }, /give either by .* or samples/);
  bad({ dur: 1, by: 5 }, /by must be a function of the seconds since the key starts/);
  bad({ dur: 1, by: () => 5 }, /by must return an object such as \{ at: \[x, y\] \}; at 0\.000 s it returned 5/);
  bad({ dur: 1, by: () => ({}) }, /nothing is driven; give at least one of at, rotation, scale, opacity, depth, points/);
  bad({ dur: 1, by: () => ({ x: 4 }) }, /what by returns: unknown option "x" \(allowed: at, rotation, scale, opacity, depth, points\)/);
  bad({ dur: 1, by: (t: number) => (t < 0.5 ? { at: [0, 0] } : { rotation: 3 }) }, /by must return the same channels every time; at 0 s it returned at, at 0\.500 s rotation/);
  bad({ dur: 1, by: (t: number) => ({ at: t < 0.5 ? [0, 0] : [0, 0, 0] }) }, /at has 2 numbers at 0 s and 3 at 0\.500 s; a place keeps its form/);
  bad({ dur: 1, by: () => ({ at: [0] }) }, /at at 0\.000 s must be \[x, y\], or \[x, y, z\] in a perspective layer/);
  bad({ dur: 1, by: (t: number) => ({ at: [1 / (t - 0.5), 0] }) }, /at\[0\] at 0\.500 s must be a number/);
  bad({ dur: 1, by: () => ({ opacity: 1.5 }) }, /opacity at 0\.000 s must be a number in 0\.\.1/);
  bad({ dur: 1, by: (t: number) => ({ points: t < 0.5 ? [[0, 0], [1, 1]] : [[0, 0], [1, 1], [2, 2]] }) }, /points holds 2 points at 0 s and 3 at 0\.500 s; an outline keeps its number of points/);
  bad({ dur: 1, samples: { rotation: [1] } }, /samples\.rotation must be a list of at least two samples, evenly spaced over dur/);
  bad({ dur: 1, samples: { rotation: [1, 2], scale: [1, 2, 3] } }, /every channel of samples holds one value per sample; rotation has 2, scale has 3/);
  bad({ dur: 1, samples: { speed: [1, 2] } }, /samples: unknown option "speed"/);
  bad({ dur: 0.001, by: () => ({ at: [0, 0] }) }, /dur must be a number in/);
  bad({ dur: 1, to: [0, 0] }, /drive\("a"\): unknown option "to" \(allowed: at, dur, by, samples\)/);
});

test('drive: a node without it is the node it was; with it the node is what its function says at every frame, and stays as the last sample left it', async () => {
  const plain = compileShot(make([dot({ at: [-300, 0] })]));
  const p = plain.byId.get('a')!;
  assert.deepEqual([p.driven, p.pos!.drive, p.rot!.drive, p.depth, p.form, plain.layers[0]!.ordered, plain.spatial], [false, undefined, undefined, null, null, false, false]);

  const by = (t: number): object => ({ at: [-300 + 100 * t, 80 * Math.sin(t)], rotation: 90 * t, scale: 1 + t / 2, opacity: 1 - t / 4 });
  const spec = make([dot({ at: [-300, 0] })], [drive('a', { at: 1, dur: 2, by })]);
  const c = compileShot(spec);
  assert.equal(c.byId.get('a')!.driven, true);
  const bake = await bakeShot(c);
  const at = (frame: number): { x: number; y: number; rot: number; scale: number; opacity: number } => {
    const xf = computeWorld(c, frame, posesFromBake(bake))[c.byId.get('a')!.index]!;
    return { x: xf.x, y: xf.y, rot: (xf.rot * 180) / Math.PI, scale: xf.scale, opacity: opacities(c, frame / 60).own[c.byId.get('a')!.index]! };
  };
  const want = (t: number): { x: number; y: number; rot: number; scale: number; opacity: number } => ({ x: -300 + 100 * t, y: 80 * Math.sin(t), rot: 90 * t, scale: 1 + t / 2, opacity: 1 - t / 4 });
  const same = (got: ReturnType<typeof at>, exp: ReturnType<typeof want>): boolean => near(got.x, exp.x, 1e-6) && near(got.y, exp.y, 1e-6) && near(got.rot, exp.rot, 1e-6) && near(got.scale, exp.scale, 1e-6) && near(got.opacity, exp.opacity, 1e-6);
  // Before the key: as authored.
  assert.deepEqual(at(30), { x: -300, y: 0, rot: 0, scale: 1, opacity: 1 });
  // At every frame of the key: what the function says of the seconds since the key started.
  for (const frame of [60, 61, 97, 120, 179, 180]) assert.ok(same(at(frame), want((frame - 60) / 60)), `frame ${frame}: ${JSON.stringify(at(frame))}`);
  // After the key: as the last sample left it.
  assert.ok(same(at(181), want(2)) && same(at(300), want(2)));
  // The frames before the key are those of the shot without it.
  for (const frame of [0, 45]) assert.equal(await hash(spec, frame), await hash(make([dot({ at: [-300, 0] })]), frame), `frame ${frame}`);
  // And the picture follows: the dot is where the function put it.
  // (It is half faded there, over a dark ground.)
  assert.ok((await red(spec, 240, -100, 80 * Math.sin(2))) > 110 && (await red(spec, 240, -300, 0)) < 60);

  // Samples given ready are played back smoothly: exactly a sample at its moment, between two a curve through them.
  const track = make([dot()], [drive('a', { at: 1, dur: 3, samples: { at: [[0, 0], [90, 30], [180, 0], [270, -60]] } })]);
  const tc = compileShot(track);
  const tb = await bakeShot(tc);
  const place = (frame: number): Vec2 => {
    const xf = computeWorld(tc, frame, posesFromBake(tb))[0]!;
    return [xf.x, xf.y];
  };
  assert.deepEqual([place(60), place(120), place(180), place(240)], [[0, 0], [90, 30], [180, 0], [270, -60]]);
  const mid = place(150);
  assert.ok(near(mid[0], 135, 1e-6) && mid[1] > 15 && mid[1] < 30, `${mid}`);
  // No step larger than its neighbours allow: the curve has no corner at a sample.
  let worst = 0;
  for (let f = 62; f < 240; f++) {
    const a = place(f - 1);
    const b = place(f);
    const d = place(f + 1);
    worst = Math.max(worst, Math.hypot(d[0] - 2 * b[0] + a[0], d[1] - 2 * b[1] + a[1]));
  }
  assert.ok(worst < 0.25, `the largest change of a step is ${worst}`);
  // Two drives of a node follow one another; a drive is no event and makes no sound.
  const two = compileShot(make([dot()], [drive('a', { at: 0, dur: 1, by: (t) => ({ at: [100 * t, 0] }) }), drive('a', { at: 2, dur: 1, by: (t) => ({ at: [100, 100 * t] }) })]));
  const tw = await bakeShot(two);
  const xy = (frame: number): Vec2 => [computeWorld(two, frame, posesFromBake(tw))[0]!.x, computeWorld(two, frame, posesFromBake(tw))[0]!.y];
  assert.deepEqual([xy(60), xy(90), xy(150), xy(200)], [[100, 0], [100, 0], [100, 50], [100, 100]]);
  assert.deepEqual(sceneEvents(two, tw), []);
});

test('drive: links hold on to driven corners, so a stick keeps both its ends wherever they go', async () => {
  // Two corners of a frame that is turned: the picture of the stick grows short and long again.
  const A = (t: number): Vec2 => [-200 * Math.cos(t), -120];
  const B = (t: number): Vec2 => [200 * Math.cos(t), 120 * Math.cos(2 * t)];
  const spec = make(
    [group({ id: 'p' }), group({ id: 'q' }), link({ id: 'stick', from: 'p', to: 'q', color: 'accent.pink', width: 12, bend: 0, gap: 0 })],
    [drive('p', { dur: 5, by: (t) => ({ at: A(t) }) }), drive('q', { dur: 5, by: (t) => ({ at: B(t) }) })],
  );
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  for (const frame of [0, 47, 94, 200, 299]) {
    const t = frame / 60;
    const item = flatItems(evaluate(c, bake, frame, 'en').layers[0]!.items).find((i) => i.node.id === 'stick')!;
    assert.ok(item.kind === 'link');
    const [a, , b] = item.curve;
    assert.ok(near(a[0], A(t)[0], 1e-6) && near(a[1], A(t)[1], 1e-6) && near(b[0], B(t)[0], 1e-6) && near(b[1], B(t)[1], 1e-6), `frame ${frame}`);
  }
  // The stick is drawn between them: its middle is pink.
  const t = 94 / 60;
  assert.ok((await red(spec, 94, (A(t)[0] + B(t)[0]) / 2, (A(t)[1] + B(t)[1]) / 2)) > 150);
});

test('drive: the points of a region and of a stroke follow their function', async () => {
  const SQUARE: Vec2[] = [[-100, -100], [100, -100], [100, 100], [-100, 100]];
  // A square whose right side travels 200 units to the right and back.
  const wide = (t: number): Vec2[] => SQUARE.map((p) => [p[0] > 0 ? p[0] + 200 * Math.sin((Math.PI * t) / 4) : p[0], p[1]]);
  const isle = region({ id: 'isle', fill: 'accent.pink', lit: false, points: SQUARE, smooth: 0 });
  const spec = make([isle], [drive('isle', { at: 1, dur: 4, by: (t) => ({ points: wide(t) }) })]);
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const shapeAt = (frame: number): { points: readonly Vec2[] } | undefined => {
    const item = flatItems(evaluate(c, bake, frame, 'en').layers[0]!.items).find((i) => i.node.id === 'isle')!;
    assert.ok(item.kind === 'shape');
    return item.shape as { points: readonly Vec2[] } | undefined;
  };
  assert.equal(compileShot(make([isle])).byId.get('isle')!.form, null);
  assert.ok(near(Math.max(...shapeAt(180)!.points.map((p) => p[0])), 300, 1e-6), 'half-way its right side is at 300');
  assert.ok(near(Math.max(...shapeAt(300)!.points.map((p) => p[0])), 100, 1e-6), 'and at the end where it was');
  assert.ok((await red(spec, 180, 250, 0)) > 150 && (await red(spec, 30, 250, 0)) < 100 && (await red(spec, 320, 250, 0)) < 100 && (await red(spec, 180, 0, 0)) > 150);
  assert.equal(await hash(spec, 30), await hash(make([isle]), 30), 'before the key it is the region it was');

  // An outline that crosses itself and encloses no area on balance is still drawn: two lobes, as a sheet that
  // turns over is seen. Its right side goes down past its left side going up, and both lobes are filled.
  const twist = (t: number): Vec2[] => [[-100, -100 + 200 * Math.min(1, t)], [100, -100], [100, 100], [-100, 100 - 200 * Math.min(1, t)]];
  const turned = make([isle], [drive('isle', { dur: 1, by: (t) => ({ points: twist(t) }) })]);
  assert.ok((await red(turned, 120, 60, 0)) > 150 && (await red(turned, 120, -60, 0)) > 150, 'both lobes of the bow');
  assert.ok((await red(turned, 120, 0, 70)) < 100 && (await red(turned, 120, 0, -70)) < 100, 'and nothing above and below where they cross');
  // An outline without size has no picture at that frame.
  const gone = make([isle], [drive('isle', { dur: 1, by: (t) => ({ points: SQUARE.map((p) => [p[0] * (1 - t), p[1] * (1 - t)] as Vec2) }) })]);
  assert.ok((await red(gone, 30, 0, 0)) > 150 && (await red(gone, 90, 0, 0)) < 100);

  // A stroke: its line runs through the points of each frame.
  const line = stroke({ id: 's', points: [[-300, 0], [0, 0], [300, 0]], smooth: 0, color: 'accent.pink', width: 12 });
  const bent = make([line], [drive('s', { at: 1, dur: 2, by: (t) => ({ points: [[-300, 0], [0, -100 * t], [300, 0]] }) })]);
  assert.ok((await red(bent, 30, 0, 0)) > 150 && (await red(bent, 200, 0, 0)) < 100 && (await red(bent, 200, 0, -200)) > 150 && (await red(bent, 120, 0, -100)) > 150);

  const refuse = (nodes: LayerSpec['nodes'], keys: Key[], message: RegExp): void => {
    assert.throws(() => make(nodes, keys), message, String(message));
  };
  refuse([dot()], [drive('a', { dur: 1, by: () => ({ points: SQUARE }) })], /drive\("a"\) sets points: that is for a region or a stroke, whose outline is a list of points/);
  refuse([isle], [drive('isle', { dur: 1, by: () => ({ points: SQUARE.slice(0, 3) }) })], /drive\("isle"\) sets 3 points, and the node has 4; an outline keeps its number of points/);
  refuse([isle], [drive('isle', { dur: 1, by: () => ({ points: SQUARE }) }), reshape('isle', { at: 2, points: SQUARE })], /"isle" has a drive that sets its points and a reshape; an outline is driven or keyed, not both/);
  refuse([isle], [drive('isle', { dur: 1, by: () => ({ points: SQUARE.map((p) => [p[0], p[1], 0]) }) })], /drive\("isle"\) sets points of three numbers, \[x, y, z\]: give the node itself points of three numbers, in a perspective layer/);
});

test('drive: depth orders what a layer draws; without a depth the list is the order', async () => {
  // Two discs that overlap at the middle: pink is listed first, so aqua is drawn over it.
  const pink = (extra: object = {}): ReturnType<typeof circle> => circle({ id: 'pink', at: [-30, 0], r: 80, fill: 'accent.pink', lit: false, ...extra });
  const aqua = (extra: object = {}): ReturnType<typeof circle> => circle({ id: 'aqua', at: [30, 0], r: 80, fill: 'accent.aqua', lit: false, ...extra });
  assert.ok((await red(make([pink(), aqua()]), 0, 0, 0)) < 100);
  assert.equal('depth' in pink(), false, 'a node without the option carries no depth');
  // The larger depth is drawn first, behind the rest.
  assert.ok((await red(make([pink(), aqua({ depth: 1 })]), 0, 0, 0)) > 150);
  assert.ok((await red(make([pink({ depth: -1 }), aqua()]), 0, 0, 0)) > 150);
  assert.ok((await red(make([pink({ depth: 2 }), aqua({ depth: 1 })]), 0, 0, 0)) < 100);
  assert.equal(compileShot(make([pink(), aqua({ depth: 1 })])).layers[0]!.ordered, true);
  // A driven depth: the order at each frame. Pink passes in front for the middle second of three.
  const spec = make([pink(), aqua()], [drive('pink', { at: 1, dur: 3, by: (t) => ({ depth: t >= 1 && t < 2 ? -1 : 1 }) })]);
  assert.ok((await red(spec, 30, 0, 0)) < 100, 'before the key: as listed');
  assert.ok((await red(spec, 90, 0, 0)) < 100 && (await red(spec, 150, 0, 0)) > 150 && (await red(spec, 210, 0, 0)) < 100);
  // A depth is for what a layer lists: inside a parent the order of the children is the order.
  const child = (): ShotSpec => make([group({ id: 'g', children: [pink({ depth: 1 })] })]);
  assert.throws(child, /shape "pink" has a depth: that is for a node listed directly in a layer's nodes; inside a parent, the order of the children is the draw order/);
  assert.throws(() => make([group({ id: 'g', children: [pink()] })], [drive('pink', { dur: 1, by: () => ({ depth: 1 }) })]), /drive\("pink"\) sets a depth: that is for a node listed directly in a layer's nodes/);
});

test('drive: what the shot refuses: a channel is driven or keyed, not both', () => {
  const refuse = (nodes: LayerSpec['nodes'], keys: Key[], message: RegExp): void => {
    assert.throws(() => make(nodes, keys), message, String(message));
  };
  const place = drive('a', { at: 1, dur: 1, by: (t) => ({ at: [t, 0] }) });
  refuse([dot()], [place, moveTo('a', { at: 3, to: [10, 10] })], /"a" has a drive that sets its place and a moveTo, a hop or a travel; a place is driven or keyed, not both: put the node in a group and move that/);
  refuse([dot()], [drive('a', { dur: 1, by: (t) => ({ rotation: t }) }), turnTo('a', { at: 3, to: 90 })], /"a" has a drive that sets its rotation and a turnTo, or a travel that rolls or orients it/);
  refuse([dot()], [drive('a', { dur: 1, by: () => ({ scale: 2 }) }), scaleTo('a', { at: 3, to: 2 })], /"a" has a drive that sets its scale and a scaleTo; a size is driven or keyed, not both \(popIn, popOut and bump still apply\)/);
  refuse([dot()], [drive('a', { dur: 1, by: () => ({ opacity: 0.5 }) }), fadeTo('a', { at: 3, to: 0 })], /"a" has a drive that sets its opacity and a fadeTo; an opacity is driven or keyed, not both/);
  refuse([dot()], [place, drive('a', { at: 1.5, dur: 1, by: (t) => ({ at: [t, 0] }) })], /drive\("a"\) at 1\.5 s drives its place before the previous drive of it has ended \(2\.000 s\)/);
  refuse([dot()], [drive('a', { at: 7, dur: 1, by: (t) => ({ at: [t, 0] }) })], /drive\("a"\) starts at 7 s, after the shot ends/);
  refuse([dot()], [drive('b', { dur: 1, by: (t) => ({ at: [t, 0] }) })], /drive targets "b", which does not exist/);
  refuse([dot({ body: { kind: 'dynamic', release: 0 } })], [place], /drive\("a"\) cannot set the place of a rigid body: it is moved by the physics bake/);
  refuse([eye({ id: 'e', r: 20, white: 'light.snow', pupil: 'deep.abyss' })], [drive('e', { dur: 1, by: (t) => ({ rotation: t }) })], /drive\("e"\) cannot set the rotation of an eye/);
  refuse([dot()], [drive('a', { dur: 1, by: (t) => ({ at: [t, 0, 0] }) })], /drive\("a"\) sets a place of three numbers, \[x, y, z\]/);
  refuse([dot(), dot({ id: 'b' }), link({ id: 'l', from: 'a', to: 'b', color: 'accent.pink' })], [drive('l', { dur: 1, by: () => ({ opacity: 1 }) })], /drive cannot target link "l"; it applies to shapes, groups, eyes, strokes and texts/);
  // A different channel of the same node may be keyed, and a group around a driven node may move.
  make([group({ id: 'g', children: [dot()] })], [place, fadeTo('a', { at: 2, to: 0.5 }), turnTo('a', { at: 2, to: 90 }), moveTo('g', { at: 2, to: [50, 0] })]);
});

test('drive: the motion review judges it like any other move: a leap, one speed between two rests, a start at full speed; an eased drive is clean', async () => {
  // The sound scene: from rest to rest.
  const eased = make([dot({ at: [-400, 0] })], [drive('a', { at: 1, dur: 2, by: (t) => ({ at: [-400 + 800 * ease(t / 2), 0] }) })], 4);
  assert.deepEqual(await flagged(eased), []);
  // Planted: one speed from the first frame to the last, between two rests.
  const steady = make([dot({ at: [-400, 0] })], [drive('a', { at: 1, dur: 2, by: (t) => ({ at: [-400 + 400 * t, 0] }) })], 4);
  assert.deepEqual(await flagged(steady), ['mechanical a position']);
  // Planted: it starts at full speed and slows into its place.
  const kicked = make([dot({ at: [-400, 0] })], [drive('a', { at: 1, dur: 2, by: (t) => ({ at: [-400 + 800 * (1 - (1 - t / 2) ** 3), 0] }) })], 4);
  assert.deepEqual(await flagged(kicked), ['abrupt-start a position']);
  // Planted: half-way, the function leaps.
  const leap = make([dot({ at: [-400, 0] })], [drive('a', { at: 1, dur: 2, by: (t) => ({ at: [-400 + 600 * ease(t / 2) + (t >= 1 ? 200 : 0), 0] }) })], 4);
  assert.deepEqual(await flagged(leap), ['jump a position']);
  // A driven turn and a driven size are judged on the travel of the edge, as keyed ones are.
  const spun = make([rect({ id: 'r', w: 300, h: 80, fill: 'accent.pink' })], [drive('r', { at: 1, dur: 2, by: (t) => ({ rotation: 90 * t }) })], 4);
  assert.deepEqual(await flagged(spun), ['mechanical r rotation']);

  // A driven outline: the travel of its points.
  const SQUARE: Vec2[] = [[-100, -100], [100, -100], [100, 100], [-100, 100]];
  const grown = (k: number): Vec2[] => SQUARE.map((p) => [p[0] > 0 ? p[0] + 240 * k : p[0], p[1]]);
  const isle = region({ id: 'isle', fill: 'accent.pink', lit: false, points: SQUARE, smooth: 0 });
  assert.deepEqual(await flagged(make([isle], [drive('isle', { at: 1, dur: 2, by: (t) => ({ points: grown(t / 2) }) })], 4)), ['mechanical isle outline']);
  assert.deepEqual(await flagged(make([isle], [drive('isle', { at: 1, dur: 2, by: (t) => ({ points: grown(ease(t / 2)) }) })], 4)), []);
  const c = compileShot(make([isle], [drive('isle', { at: 1, dur: 2, by: (t) => ({ points: grown(ease(t / 2)) }) })], 4));
  const way = reviewMotion(c, await bakeShot(c)).series.placed[0]!.outline!;
  assert.ok(near(way[0]!, 0) && near(way[239]!, 240, 1e-2) && near(way[120]!, 120, 1e-2), `${way[120]}, ${way[239]}`);
});

test('drive: a driven corner that a link holds on to is judged through the link, and a stick between driven corners is life in the frame', async () => {
  const frame = (by: (t: number) => number, seconds = 4, links = true): ShotSpec =>
    make(
      [group({ id: 'p', at: [-300, -100] }), group({ id: 'q', at: [-300, 100] }), ...(links ? [link({ id: 'stick', from: 'p', to: 'q', color: 'accent.pink', width: 12, bend: 0, gap: 0 })] : [])],
      [drive('q', { at: 1, dur: 2, by: (t) => ({ at: [-300 + by(t), 100] }) })],
      seconds,
    );
  // The sound scene: the free end of the stick swings out from rest to rest.
  assert.deepEqual(await flagged(frame((t) => 600 * ease(t / 2))), []);
  // Planted: it goes at one speed, and the stick shows it.
  assert.deepEqual(await flagged(frame((t) => 300 * t)), ['mechanical q position']);
  // Planted: it leaps.
  assert.deepEqual(await flagged(frame((t) => 400 * ease(t / 2) + (t >= 1 ? 200 : 0))), ['jump q position']);
  // A corner that nothing holds on to is never seen: there is nothing to judge.
  assert.deepEqual(await flagged(frame((t) => 300 * t, 4, false)), []);

  // Life: a stick that only lies there is a hold; one whose corner is driven all the while keeps the frame alive.
  const still = await flagged(make([group({ id: 'p', at: [-300, -100] }), group({ id: 'q', at: [300, 100] }), link({ id: 'stick', from: 'p', to: 'q', color: 'accent.pink', width: 12 })], [], 9));
  assert.ok(still.includes('dead-area (frame) hold'), still.join('; '));
  const swung = await flagged(
    make(
      [group({ id: 'p', at: [-300, -100] }), group({ id: 'q', at: [300, 100] }), link({ id: 'stick', from: 'p', to: 'q', color: 'accent.pink', width: 12 })],
      [drive('q', { at: 0, dur: 9, by: (t) => ({ at: [300 * Math.cos(t), 100 + 200 * Math.sin(t)] }) })],
      9,
    ),
  );
  assert.ok(!swung.some((f) => f.startsWith('dead-area (frame) ')), swung.join('; '));
});
