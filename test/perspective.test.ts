import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  cameraTo,
  circle,
  compileShot,
  computeWorld,
  drive,
  evaluate,
  eyeOf,
  frameRaw,
  group,
  heightFor,
  intended,
  IntentError,
  layer,
  link,
  moveTo,
  perspAt,
  perspectiveTo,
  planeMap,
  planePoint,
  posesFromBake,
  project,
  rect,
  region,
  reshape,
  reviewMotion,
  shot,
  stroke,
  turnTo,
  type IntendedSpec,
  type Key,
  type LayerSpec,
  type PerspSpec,
  type ShotSpec,
  type Vec2,
  type Vec3,
} from '../src/index.ts';
import { Canvas, DOMMatrix, Path2D, type CanvasRenderingContext2D } from 'skia-canvas';
import { planeContext } from '../src/render/plane.ts';
import { hingedAxes, PLANES } from '../src/scene/space.ts';

// A perspective layer: a camera in a space of three dimensions, places of three numbers, groups that lie
// in a plane, hinges, and regions and strokes through points of the space.

const WIDTH = 480;

type View = true | { aim?: Vec3; distance?: number; tilt?: number; turn?: number; lens?: number };

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], view: View | null = true, seconds = 6, exceptions: IntendedSpec[] = []): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 3,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    // A still camera of the shot: a place of the layer is that place on screen, moved by half a frame.
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'room', depth: 0, nodes, ...(view === null ? {} : { perspective: view }) })],
    timeline,
    intended: exceptions,
  });
}

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;
const pink = (extra: object = {}): ReturnType<typeof circle> => circle({ id: 'pink', r: 60, fill: 'accent.pink', lit: false, ...extra });
const aqua = (extra: object = {}): ReturnType<typeof circle> => circle({ id: 'aqua', r: 60, fill: 'accent.aqua', lit: false, ...extra });
/** The camera a view stands for, with what it leaves out filled in. */
const camera = (view: Exclude<View, true> = {}): PerspSpec => ({ aim: view.aim ?? [0, 0, 0], distance: view.distance ?? 1600, tilt: view.tilt ?? 0, turn: view.turn ?? 0, lens: view.lens ?? view.distance ?? 1600 });

/** The red of the pixel at a place of the layer: high on the pink of the tests, low on their aqua and on the background. */
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

/** Where a node is drawn on the layer at a frame, and how large. */
async function drawn(spec: ShotSpec, id: string, frame = 0): Promise<{ x: number; y: number; scale: number }> {
  const c = compileShot(spec);
  const xf = computeWorld(c, frame, posesFromBake(await bakeShot(c)))[c.byId.get(id)!.index]!;
  return { x: xf.x, y: xf.y, scale: xf.scale };
}

async function flagged(spec: ShotSpec): Promise<string[]> {
  const c = compileShot(spec);
  return reviewMotion(c, await bakeShot(c))
    .report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel}`)
    .sort();
}

test('perspective: the option of a layer and the key of its camera, and what they refuse', () => {
  const flat = layer({ id: 'room', depth: 0, nodes: [] });
  assert.equal('perspective' in flat, false, 'a layer without the option carries no camera');
  assert.deepEqual(layer({ id: 'room', depth: 0, nodes: [], perspective: true }).perspective, { aim: [0, 0, 0], distance: 1600, tilt: 0, turn: 0, lens: 1600 });
  // A lens that is left out is the distance: what stands at the point the camera looks at is drawn at its own size.
  assert.deepEqual(layer({ id: 'room', depth: 0, nodes: [], perspective: { aim: [0, 100, 50], distance: 2000, tilt: 30 } }).perspective, { aim: [0, 100, 50], distance: 2000, tilt: 30, turn: 0, lens: 2000 });
  const badLayer = (view: unknown, message: RegExp): void => {
    assert.throws(() => layer({ id: 'room', depth: 0, nodes: [], perspective: view as never }), message, String(message));
  };
  badLayer('yes', /perspective must be true or \{ aim, distance, tilt, turn, lens \}/);
  badLayer({ tilt: 120 }, /perspective\.tilt must be a number in -90\.\.90/);
  badLayer({ aim: [0, 0] }, /perspective\.aim must be \[x, y, z\]/);
  badLayer({ fov: 40 }, /unknown option "fov" \(allowed: aim, distance, tilt, turn, lens\)/);

  assert.deepEqual(perspectiveTo('room', { at: 2, tilt: 40 }), { kind: 'perspectiveTo', target: null, layer: 'room', at: 2, dur: 1.6, tilt: 40, profile: 'ease', ramp: 0.3 });
  assert.deepEqual(perspectiveTo('room', { at: 2, dur: 4, aim: [1, 2, 3], distance: 900, turn: 30, lens: 1200, profile: 'out', ramp: 0.2 }), {
    kind: 'perspectiveTo', target: null, layer: 'room', at: 2, dur: 4, aim: [1, 2, 3], distance: 900, turn: 30, lens: 1200, profile: 'out', ramp: 0.2,
  });
  const bad = (opts: object, message: RegExp): void => {
    assert.throws(() => perspectiveTo('room', { at: 1, ...opts } as never), (e: unknown) => e instanceof IntentError && message.test(e.message), String(message));
  };
  bad({}, /give at least one of aim, distance, tilt, turn, lens/);
  bad({ tilt: 100 }, /tilt must be a number in -90\.\.90/);
  bad({ aim: [0, 0] }, /aim must be \[x, y, z\]: the point the camera looks at/);
  bad({ distance: 0 }, /distance must be a number in 1\.\.1000000/);
  bad({ tilt: 10, profile: 'settle' }, /profile must be one of ease, steady, in, out/);
  bad({ tilt: 10, profile: 'steady', ramp: 0.2 }, /ramp applies to the profiles ease, in and out/);
  bad({ tilt: 10, zoom: 2 }, /perspectiveTo\("room"\): unknown option "zoom" \(allowed: at, dur, aim, distance, tilt, turn, lens, profile, ramp\)/);
});

test('perspective: it is opt-in: a shot without it holds none of it', () => {
  const c = compileShot(make([pink(), group({ id: 'g', children: [aqua()] })], [moveTo('pink', { at: 1, to: [100, 0] }), turnTo('g', { at: 1, to: 90 })], null));
  assert.equal(c.spatial, false);
  assert.deepEqual(c.layers.map((l) => [l.persp, l.ordered]), [[null, false]]);
  for (const n of c.nodes) assert.deepEqual([n.persp, n.plane, n.hinge, n.away, n.form, n.depth, n.driven], [null, -1, null, null, null, null, false], n.id);
  // The nodes and the keys are the data they were: nothing of the space is written unless it is given.
  for (const key of ['z', 'depth', 'points3', 'back', 'plane']) {
    assert.equal(key in pink(), false, key);
    assert.equal(key in group({ id: 'g' }), false, key);
    assert.equal(key in region({ id: 'r', points: [[0, 0], [10, 0], [0, 10]], fill: 'accent.pink' }), false, key);
    assert.equal(key in stroke({ id: 's', points: [[0, 0], [10, 0]], color: 'accent.pink' }), false, key);
  }
  assert.equal('z' in moveTo('pink', { at: 1, to: [100, 0] }), false);
  assert.equal('about' in turnTo('g', { at: 1, to: 90 }), false);
});

test('perspective: with the camera it starts with, what is at z = 0 is drawn where a flat layer draws it; what is farther is smaller and nearer the middle', async () => {
  const nodes = (): LayerSpec['nodes'] => [pink({ at: [300, 100] }), aqua({ at: [-200, -150] }), stroke({ id: 's', points: [[-400, 200], [400, 260]], color: 'accent.pink', width: 14 })];
  // The same picture as the flat layer, pixel for pixel.
  for (const frame of [0, 100]) assert.equal(await hash(make(nodes()), frame), await hash(make(nodes(), [], null), frame));
  assert.deepEqual(await drawn(make([pink({ at: [300, 100] })]), 'pink'), { x: 300, y: 100, scale: 1 });
  assert.deepEqual(await drawn(make([pink({ at: [300, 100, 0] })]), 'pink'), { x: 300, y: 100, scale: 1 });
  // Twice as far from the camera: half the size, half as far from the middle.
  assert.deepEqual(await drawn(make([pink({ at: [300, 100, 1600] })]), 'pink'), { x: 150, y: 50, scale: 0.5 });
  // Nearer: larger. And behind the camera, or too near it: not drawn.
  assert.deepEqual(await drawn(make([pink({ at: [300, 100, -800] })]), 'pink'), { x: 600, y: 200, scale: 2 });
  assert.equal((await drawn(make([pink({ at: [0, 0, -1600] })]), 'pink')).scale, 0);
  assert.equal((await drawn(make([pink({ at: [0, 0, -2000] })]), 'pink')).scale, 0);
  // The parts of a node stand upright on its place and take its size.
  const stand = make([group({ id: 'g', at: [0, 0, 1600], children: [pink({ at: [100, -40] })] })]);
  assert.deepEqual(await drawn(stand, 'pink'), { x: 50, y: -20, scale: 0.5 });
  // A lens other than the distance is a zoom of the whole picture.
  assert.deepEqual(await drawn(make([pink({ at: [300, 100] })], [], { lens: 800 }), 'pink'), { x: 150, y: 50, scale: 0.5 });
});

test('perspective: the camera tilts, goes round, comes nearer and looks elsewhere; its keys chain', async () => {
  const at = async (view: View, p: Vec3): Promise<{ x: number; y: number; scale: number }> => drawn(make([pink({ at: p })], [], view), 'pink');
  const same = (got: { x: number; y: number; scale: number }, x: number, y: number, scale: number): boolean => near(got.x, x, 1e-9) && near(got.y, y, 1e-9) && near(got.scale, scale, 1e-9);
  // Straight down: the ground is seen as a map, and what is farther away is higher on screen.
  assert.ok(same(await at({ tilt: 90 }, [300, 0, 200]), 300, -200, 1));
  assert.ok(same(await at({ tilt: 90 }, [0, 400, 0]), 0, 0, 0.8), 'and what lies lower is farther from it');
  // Gone a quarter round to the left: what was far is on the left, what was on the right is far.
  assert.ok(same(await at({ turn: 90 }, [0, 0, 400]), -400, 0, 1));
  assert.ok(same(await at({ turn: 90 }, [1600, 0, 0]), 0, 0, 0.5));
  // It looks at its aim: that point is in the middle, at its own size.
  assert.ok(same(await at({ aim: [200, 50, 300], tilt: 20, turn: 35 }, [200, 50, 300]), 0, 0, 1));
  // The functions the layer uses are the ones a scene may use.
  const view = { aim: [100, 40, 0] as Vec3, distance: 1200, tilt: 25, turn: -15 };
  const p = project(eyeOf(camera(view)), [240, -60, 130]);
  assert.ok(same(await at(view, [240, -60, 130]), p.x, p.y, p.k));

  // A dolly: the camera comes nearer, and what is near grows faster than what is far.
  const dolly = make([pink({ at: [0, 0, 0] }), aqua({ at: [0, 0, 800] })], [perspectiveTo('room', { at: 1, dur: 2, distance: 800 })]);
  assert.deepEqual([(await drawn(dolly, 'pink', 0)).scale, (await drawn(dolly, 'aqua', 0)).scale], [1, 2 / 3]);
  const [nearBy, farOff] = [(await drawn(dolly, 'pink', 200)).scale, (await drawn(dolly, 'aqua', 200)).scale];
  assert.ok(near(nearBy, 2) && near(farOff, 1) && nearBy / 1 > farOff / (2 / 3));
  // A longer lens grows both alike: that is a zoom, not a dolly.
  const zoom = make([pink({ at: [0, 0, 0] }), aqua({ at: [0, 0, 800] })], [perspectiveTo('room', { at: 1, dur: 2, lens: 3200 })]);
  assert.ok(near((await drawn(zoom, 'pink', 200)).scale, 2) && near((await drawn(zoom, 'aqua', 200)).scale, 4 / 3));

  // Keys chain: each takes over from where the camera is, and what a key leaves out stays.
  const keys = [perspectiveTo('room', { at: 1, dur: 2, tilt: 40, profile: 'steady' }), perspectiveTo('room', { at: 2, dur: 2, turn: 30, profile: 'steady' }), perspectiveTo('room', { at: 5, dur: 0.5, distance: 400, profile: 'steady' })];
  const c = compileShot(make([pink()], keys, { distance: 1600 }));
  const track = c.layers[0]!.persp!;
  assert.deepEqual(perspAt(track, 0.5), camera());
  assert.ok(near(perspAt(track, 1.5).tilt, 10) && perspAt(track, 1.5).turn === 0);
  assert.ok(near(perspAt(track, 3).tilt, 20) && near(perspAt(track, 3).turn, 15), 'the second key takes over the tilt as it is at 2 s');
  assert.deepEqual(perspAt(track, 4.5), { ...camera(), tilt: 20, turn: 30 });
  // A distance runs as a ratio: half-way from 1600 to 400 it is 800.
  assert.ok(near(perspAt(track, 5.25).distance, 800, 1e-9) && perspAt(track, 5.25).lens === 1600);

  const refuse = (key: Key, message: RegExp, view: View | null = true): void => {
    assert.throws(() => make([pink()], [key], view), message, String(message));
  };
  refuse(perspectiveTo('room', { at: 1, tilt: 10 }), /perspectiveTo\("room"\): the layer is flat; give it the option perspective to make it a perspective layer/, null);
  refuse(perspectiveTo('hall', { at: 1, tilt: 10 }), /perspectiveTo names the layer "hall", which does not exist \(layers: room\)/);
  refuse(perspectiveTo('room', { at: 9, tilt: 10 }), /perspectiveTo\("room"\) starts at 9 s, after the shot ends/);
});

test('perspective: what is nearer is drawn over what is farther, whatever the order of the list; a depth shifts it', async () => {
  // Two discs that overlap on screen. In a flat layer the one listed last is on top.
  assert.ok((await red(make([pink({ at: [-30, 0] }), aqua({ at: [30, 0] })], [], null), 0, 0, 0)) < 100);
  // In the space the nearer one is, whichever is listed first.
  assert.ok((await red(make([pink({ at: [-30, 0, -100] }), aqua({ at: [30, 0, 100] })]), 0, 0, 0)) > 150);
  assert.ok((await red(make([aqua({ at: [30, 0, 100] }), pink({ at: [-30, 0, -100] })]), 0, 0, 0)) > 150);
  assert.ok((await red(make([pink({ at: [-30, 0, 100] }), aqua({ at: [30, 0, -100] })]), 0, 0, 0)) < 100);
  // Equally far: as listed.
  assert.ok((await red(make([pink({ at: [-30, 0] }), aqua({ at: [30, 0] })]), 0, 0, 0)) < 100);
  // A depth is added to the distance: a ground that is to lie behind everything is given a large one.
  assert.ok((await red(make([pink({ at: [-30, 0, -100], depth: 500 }), aqua({ at: [30, 0, 100] })]), 0, 0, 0)) < 100);
  // A body that goes round another passes in front of it and behind it.
  const round = make([pink({ id: 'pink', r: 90 }), aqua({ r: 40, at: [200, 0, 0] })], [drive('aqua', { dur: 4, by: (t) => ({ at: [200 * Math.cos((Math.PI * t) / 2), 0, -200 * Math.sin((Math.PI * t) / 2)] }) })], true, 4);
  assert.ok((await red(round, 60, 0, 0)) < 100, 'after a quarter of the way round it is in front, and hides the middle');
  assert.ok((await red(round, 180, 0, 0)) > 150, 'after three quarters it is behind');
  // The camera decides what is near: seen from behind, the order is the other way round.
  assert.ok((await red(make([pink({ at: [30, 0, -100] }), aqua({ at: [-30, 0, 100] })], [], { turn: 180 }), 0, 0, 0)) < 100);
});

test('perspective: a group that lies in a plane is drawn through the map of that plane, and a node of the space stands on it', async () => {
  const view = { aim: [0, 150, 0] as Vec3, distance: 1500, tilt: 35 };
  const floor = (extra: object = {}): ReturnType<typeof group> =>
    group({ id: 'floor', at: [0, 300, 0], plane: 'floor', children: [rect({ id: 'tile', w: 500, h: 500, radius: 0, fill: 'accent.pink', lit: false }), circle({ id: 'spot', at: [200, -150], r: 20, fill: 'accent.aqua', lit: false })], ...extra });
  const spec = make([floor()], [], view);
  const map = planeMap(eyeOf(camera(view)), [0, 300, 0], PLANES.floor)!;
  assert.equal(map.front, true);
  // The picture of the tile is where the map of its plane puts its points: inside its corners it is pink, outside it is not.
  for (const [u, v] of [[0, 0], [235, 235], [-235, 235], [235, -235], [-235, -235]] as Vec2[]) {
    const [x, y] = planePoint(map, [u, v]);
    assert.ok((await red(spec, 0, x, y)) > 150, `inside at ${u}, ${v}`);
  }
  for (const [u, v] of [[270, 0], [0, 270], [-270, 0], [0, -270], [262, 262]] as Vec2[]) {
    const [x, y] = planePoint(map, [u, v]);
    assert.ok((await red(spec, 0, x, y)) < 100, `outside at ${u}, ${v}`);
  }
  // Foreshortened: the far edge is shorter on screen than the near one, and the tile is wider than it is high.
  const [nearL, nearR, farL, farR] = [planePoint(map, [-250, 250]), planePoint(map, [250, 250]), planePoint(map, [-250, -250]), planePoint(map, [250, -250])];
  assert.ok(nearR[0] - nearL[0] > farR[0] - farL[0] + 40 && nearR[0] - nearL[0] > 1.3 * (nearL[1] - farL[1]));
  // What reads a place of the layer gets the place of a node in the plane, as it is drawn.
  const spot = await drawn(spec, 'spot');
  const want = planePoint(map, [200, -150]);
  assert.ok(near(spot.x, want[0], 1e-9) && near(spot.y, want[1], 1e-9) && spot.scale > 0.5 && spot.scale < 1);
  assert.ok((await red(spec, 0, want[0], want[1])) < 100, 'the spot is drawn there, over the tile');
  // Seen straight down, the plane is the flat drawing it is.
  const top = make([floor()], [], { aim: [0, 300, 0], tilt: 90 });
  assert.deepEqual(await drawn(top, 'spot'), { x: 200, y: -150, scale: 1 });
  // A wall faces the viewer, and a side wall runs away from the viewer: its x is the depth.
  const wall = make([group({ id: 'wall', at: [0, 0, 400], plane: 'wall', children: [pink({ at: [100, 50] })] })]);
  assert.deepEqual(await drawn(wall, 'pink'), { x: 80, y: 40, scale: 0.8 });
  const side = make([group({ id: 'side', at: [400, 0, 0], plane: 'side', children: [pink({ at: [1600, 0] })] })]);
  assert.ok(near((await drawn(side, 'pink')).x, 200, 1e-9));
  // Axes of one's own: a plane that leans.
  const lean = make([group({ id: 'lean', plane: { x: [1, 0, 0], y: [0, 3, -4] }, children: [pink({ at: [0, 500] })] })]);
  const leant = project(eyeOf(camera()), [0, 300, -400]);
  assert.ok(near((await drawn(lean, 'pink')).y, leant.y, 1e-9));

  // A node of the space stands on the plane: its foot is at the place of the plane it was given.
  const standing = make([floor(), aqua({ id: 'post', r: 30, at: [200, 300, 150] })], [], view);
  const post = await drawn(standing, 'post');
  assert.ok(near(post.x, want[0], 1e-9) && near(post.y, want[1], 1e-9), 'the point (200, -150) of the floor is the point (200, 300, 150) of the space');
  // A plane seen from behind is drawn mirrored, unless its back is not to be drawn.
  const behind = { aim: [0, 300, 0] as Vec3, distance: 1500, tilt: -35 };
  const under = planeMap(eyeOf(camera(behind)), [0, 300, 0], PLANES.floor)!;
  assert.equal(under.front, false);
  const [bx, by] = planePoint(under, [0, 0]);
  assert.ok((await red(make([floor()], [], behind), 0, bx, by)) > 150);
  assert.ok((await red(make([floor({ back: false })], [], behind), 0, bx, by)) < 100);
});

test('perspective: when the shot camera pushes past the horizon of a plane, the plane is left out and what was drawn before it stays', async () => {
  // A side wall of panes runs off to the left; the shot camera pushes in to the right, until the whole frame lies
  // beyond the horizon of that wall. A pink post stands in the room, drawn before the wall.
  const view = { aim: [0, 0, 0] as Vec3, distance: 1600, tilt: 8, turn: 7 };
  const panes = Array.from({ length: 12 }, (_, i) => rect({ id: `pane${i}`, at: [160 + i * 340, -120], w: 320, h: 200, fill: 'accent.aqua', lit: false }));
  const room = (wall: boolean): LayerSpec['nodes'] => [pink({ id: 'post', at: [330, 300, 0], r: 80 }), ...(wall ? [group({ id: 'wall', at: [-640, 520, -760], plane: 'side', children: panes })] : [])];
  const push: Key[] = [cameraTo({ at: 0.5, zoom: 2.8, to: [440, 290], dur: 2 })];
  const withWall = make(room(true), push, view, 4);
  const without = make(room(false), push, view, 4);
  // Before the push the wall is seen and drawn.
  assert.notEqual(await hash(withWall, 0), await hash(without, 0));
  // After it, nothing of the wall can be seen: the frame is the frame of the room without it, and the post is there.
  // (A filled shape of the wall used to throw away everything drawn on the layer before it.)
  for (const frame of [180, 239]) assert.equal(await hash(withWall, frame), await hash(without, frame), `frame ${frame}`);
  const c = compileShot(withWall);
  const seen = evaluate(c, await bakeShot(c), 180, 'en').layers[0]!.view;
  const post = await drawn(withWall, 'post', 180);
  assert.ok((await red(withWall, 180, post.x * seen.zoom + seen.tx - 960, post.y * seen.zoom + seen.ty - 540)) > 150, 'the post is drawn');
});

test('perspective: what of a plane lies behind the camera is not drawn; the rest of it is', async () => {
  // A camera low and close over a floor: strokes and a strip of the floor run from far in front of the eye to far
  // behind it. What lies behind the eye used to come back from the other side of it, as lines up into the sky.
  const view = { aim: [0, 300, 0] as Vec3, distance: 1000, tilt: 8 };
  const map = planeMap(eyeOf(camera(view)), [0, 300, 0], PLANES.floor)!;
  const w = (v: number): number => map.h * v + 1;
  const [far, behind] = [-3000, 3000].map((v) => Math.sign(map.h) * -v) as [number, number];
  assert.ok(w(far) > 1 && w(behind) < 0, 'the far end lies in front of the eye and the near end behind it');
  const floor = (child: ReturnType<typeof stroke> | ReturnType<typeof rect>): ReturnType<typeof group> => group({ id: 'floor', at: [0, 300, 0], plane: 'floor', depth: 6000, children: [child] });
  const along = (extra: object = {}): ReturnType<typeof stroke> => stroke({ id: 'along', points: [[0, far], [0, behind]], color: 'accent.pink', width: 48, smooth: 0, ...extra });
  const strip = rect({ id: 'strip', at: [0, (far + behind) / 2], w: 120, h: Math.abs(behind - far), radius: 0, fill: 'accent.pink', lit: false });
  // On screen, the far end and the horizon of the floor, above it.
  const top = planePoint(map, [0, far])[1];
  const horizon = planePoint(map, [0, far * 1000])[1];
  assert.ok(horizon < top - 20, 'the horizon is above the far end');
  // Points in front of the eye, along a stretch longer than a dash and a gap.
  const inFront = Array.from({ length: 9 }, (_, i) => planePoint(map, [0, far / 6 + (i - 4) * 12]));
  for (const [name, child] of [['a stroke', along()], ['a dashed stroke', along({ dash: [40, 30] })], ['a fill of the plane', strip]] as const) {
    const spec = make([floor(child)], [], view);
    // What lies in front of the eye is drawn as the camera sees it.
    const reds = await Promise.all(inFront.map(([x, y]) => red(spec, 0, x, y)));
    assert.ok(Math.max(...reds) > 150, `${name}: drawn in front`);
    // Nothing of it is drawn between its far end and the horizon, or above the horizon.
    for (const y of [top - 12, (top + horizon) / 2, horizon - 12, horizon - 120]) assert.ok((await red(spec, 0, 0, y)) < 100, `${name}: nothing at ${Math.round(y)}`);
  }
  // As the camera rises and looks straight down, all of it comes in front and is drawn whole.
  const risen = make([floor(along())], [perspectiveTo('room', { at: 0.5, dur: 3, tilt: 90, distance: 6000 })], view);
  const down = planeMap(eyeOf(perspAt(compileShot(risen).layers[0]!.persp!, 5)), [0, 300, 0], PLANES.floor)!;
  for (const v of [far * 0.8, 0, behind * 0.8]) {
    const [x, y] = planePoint(down, [0, v]);
    assert.ok((await red(risen, 300, x, y)) > 150, `drawn at ${v} from above`);
  }
});

test('perspective: the context of a plane cuts a current path that reaches behind the camera, leaves one in front as it was, and what it refuses', async () => {
  // A plane seen through w = 1 - v / 120, about the point (100, 150) of the canvas: in front of the eye where v < 120,
  // behind it where v > 120. Its horizon is the row y = 30, and the point v = -120 is drawn at y = 90. The paths below
  // run from there to behind the eye; drawn as they were given, they wrap round between y = 90 and the horizon.
  const canvas = (through: boolean): { canvas: Canvas; ctx: CanvasRenderingContext2D } => {
    const c = new Canvas(200, 200, { gpu: false });
    const raw = c.getContext('2d');
    raw.fillStyle = '#000000';
    raw.fillRect(0, 0, 200, 200);
    const m = new DOMMatrix();
    m.m24 = -1 / 120;
    raw.translate(100, 150);
    raw.transform(m);
    raw.strokeStyle = '#ff0000';
    raw.fillStyle = '#ff0000';
    raw.lineWidth = 12;
    return { canvas: c, ctx: through ? planeContext(raw) : raw };
  };
  // The most red in a band of rows.
  const most = async (c: Canvas, from: number, to: number): Promise<number> => {
    const raw = await c.toBuffer('raw', { colorType: 'rgba' });
    let m = 0;
    for (let i = from * 200; i < to * 200; i++) m = Math.max(m, raw[i * 4]!);
    return m;
  };
  // Above the far end of the paths, and in front of the eye.
  const above = (c: Canvas): Promise<number> => most(c, 0, 72);
  const inFront = (c: Canvas): Promise<number> => most(c, 160, 200);
  const bytes = async (c: Canvas): Promise<string> => createHash('sha256').update(await c.toBuffer('raw', { colorType: 'rgba' })).digest('hex');
  const draws: Record<string, (ctx: CanvasRenderingContext2D) => void> = {
    stroke: (ctx) => {
      ctx.beginPath();
      ctx.moveTo(0, -120);
      ctx.lineTo(0, 300);
      ctx.stroke();
    },
    dashes: (ctx) => {
      ctx.setLineDash([12, 8]);
      ctx.beginPath();
      ctx.moveTo(0, -120);
      ctx.lineTo(0, 300);
      ctx.stroke();
    },
    fill: (ctx) => {
      ctx.beginPath();
      ctx.rect(-6, -120, 12, 420);
      ctx.fill();
    },
    arc: (ctx) => {
      ctx.beginPath();
      ctx.arc(0, -20, 150, 0, 2 * Math.PI);
      ctx.fill();
    },
  };
  for (const [name, draw] of Object.entries(draws)) {
    // Drawn as it was given, what lies behind the eye wraps round beyond the far end.
    const plain = canvas(false);
    draw(plain.ctx);
    assert.ok((await above(plain.canvas)) > 128, `${name}: wraps on a plain canvas`);
    // Through the context of the plane, nothing is drawn beyond the far end, and what is in front still is.
    const cut = canvas(true);
    draw(cut.ctx);
    assert.ok((await above(cut.canvas)) < 8, `${name}: nothing beyond its far end`);
    assert.ok((await inFront(cut.canvas)) > 128, `${name}: drawn in front`);
  }
  // What lies wholly in front of the eye is drawn as it always was, to the byte.
  const front: ((ctx: CanvasRenderingContext2D) => void)[] = [
    (ctx) => {
      ctx.setLineDash([12, 8]);
      ctx.beginPath();
      ctx.moveTo(-60, -200);
      ctx.bezierCurveTo(0, -100, 40, 0, 20, 60);
      ctx.lineTo(-30, 80);
      ctx.closePath();
      ctx.stroke();
    },
    (ctx) => {
      ctx.beginPath();
      ctx.arc(0, 40, 30, 0, 2 * Math.PI);
      ctx.ellipse(-50, -80, 20, 10, 0.3, 0, 2 * Math.PI);
      ctx.fill('evenodd');
    },
  ];
  for (const draw of front) {
    const [plain, through] = [canvas(false), canvas(true)];
    draw(plain.ctx);
    draw(through.ctx);
    assert.equal(await bytes(through.canvas), await bytes(plain.canvas));
  }
  // A current path is begun in the context and built and drawn under one transform.
  assert.throws(() => canvas(true).ctx.stroke(), /must be begun there/);
  const moved = canvas(true).ctx;
  moved.beginPath();
  moved.moveTo(0, 0);
  moved.translate(10, 0);
  moved.lineTo(0, 50);
  assert.throws(() => moved.stroke(), /under one transform/);
  // A path given whole is skia's to cut, and is passed on.
  const given = canvas(true);
  const path = new Path2D();
  path.moveTo(0, -120);
  path.lineTo(0, 300);
  given.ctx.stroke(path);
  assert.ok((await above(given.canvas)) < 8 && (await inFront(given.canvas)) > 128);
});

test('perspective: a hinge turns a plane about its own axis, out of its plane', async () => {
  // A card that stands on its bottom edge, faces the viewer, and falls on its back.
  const card = (): ReturnType<typeof group> => group({ id: 'card', at: [0, 200, 0], plane: 'wall', children: [rect({ id: 'face', at: [0, -150], w: 200, h: 300, radius: 0, fill: 'accent.pink', lit: false })] });
  const view = { aim: [0, 100, 0] as Vec3, distance: 1500, tilt: 30 };
  const spec = make([card()], [turnTo('card', { at: 1, to: 90, about: 'x', dur: 2, profile: 'steady' })], view);
  const eye = eyeOf(camera(view));
  const middle = async (frame: number): Promise<{ x: number; y: number; scale: number }> => drawn(spec, 'face', frame);
  const seen = (p: Vec3): { x: number; y: number } => project(eye, p);
  const same = (got: { x: number; y: number }, want: { x: number; y: number }): boolean => near(got.x, want.x, 1e-9) && near(got.y, want.y, 1e-9);
  // Standing: its middle is 150 above the hinge. Lying: 150 behind it, on the ground. Half-way: both by 106.
  assert.ok(same(await middle(30), seen([0, 50, 0])));
  assert.ok(same(await middle(200), seen([0, 200, 150])));
  assert.ok(same(await middle(120), seen([0, 200 - 150 * Math.SQRT1_2, 150 * Math.SQRT1_2])));
  for (const [frame, p] of [[30, [0, 50, 0]], [120, [0, 200 - 150 * Math.SQRT1_2, 150 * Math.SQRT1_2]], [200, [0, 200, 150]]] as [number, Vec3][]) {
    const at = seen(p);
    assert.ok((await red(spec, frame, at.x, at.y)) > 150, `the face is drawn there at frame ${frame}`);
  }
  // Where it stood there is nothing when it lies.
  assert.ok((await red(spec, 200, seen([0, -60, 0]).x, seen([0, -60, 0]).y)) < 100);
  // The hinge keeps its place, and a wall that has turned a quarter about its x is a floor.
  assert.deepEqual(hingedAxes(PLANES.wall, 90, 0).y.map((v) => Math.round(v * 1e9) / 1e9 + 0), [...PLANES.floor.y]);
  // The other hinge: a door that opens about its upright edge.
  const door = make([group({ id: 'door', plane: 'wall', children: [pink({ at: [300, 0] })] })], [turnTo('door', { at: 1, to: 60, about: 'y', dur: 2, profile: 'steady' })]);
  assert.ok(same(await drawn(door, 'pink', 30), { x: 300, y: 0 }));
  assert.ok(same(await drawn(door, 'pink', 200), project(eyeOf(camera()), [150, 0, -300 * Math.sin(Math.PI / 3)])), 'its free edge has come toward the viewer');
  // Turned until the camera looks along it, a plane is not drawn: it has no picture.
  const edge = make([group({ id: 'door', plane: 'wall', children: [pink({ at: [300, 0] })] })], [turnTo('door', { at: 1, to: 90, about: 'y', dur: 2, profile: 'steady' })]);
  assert.ok((await red(edge, 30, 300, 0)) > 150 && (await red(edge, 200, 0, 0)) < 100 && (await red(edge, 200, 300, 0)) < 100);
  // Without about, a group in a plane turns in its plane, as ever.
  const spin = make([group({ id: 'floor', at: [0, 300, 0], plane: 'floor', children: [pink({ at: [200, 0] })] })], [turnTo('floor', { at: 1, to: 90, dur: 2 })], { aim: [0, 300, 0], tilt: 90 });
  assert.ok(same(await drawn(spin, 'pink', 200), { x: 0, y: 200 }));

  assert.throws(() => make([group({ id: 'g', children: [pink()] })], [turnTo('g', { at: 1, to: 90, about: 'x' })]), /turnTo\("g"\) with about turns a plane on a hinge; it applies to a group that lies in a plane of a perspective layer \(give the group the option plane\)/);
  assert.throws(() => turnTo('g', { at: 1, to: 90, about: 'z' as never }), /about must be "x" or "y"/);
});

test('perspective: a region and a stroke through points of the space are seen through the camera, and their points may be driven', async () => {
  // A ramp: four points of the space, clockwise as its front, the side one walks up, is seen.
  const RAMP: Vec3[] = [[-150, 200, -150], [-150, 0, 150], [150, 0, 150], [150, 200, -150]];
  const ramp = (extra: object = {}): ReturnType<typeof region> => region({ id: 'ramp', points: RAMP, smooth: 0, fill: 'accent.pink', lit: false, ...extra });
  const view = { aim: [0, 100, 0] as Vec3, distance: 1500, tilt: 25, turn: 20 };
  const eye = eyeOf(camera(view));
  const spec = make([ramp()], [], view);
  const mix = (u: number, v: number): Vec3 => [-150 + 300 * u, 200 - 200 * v, -150 + 300 * v];
  for (const [u, v] of [[0.5, 0.5], [0.06, 0.06], [0.94, 0.06], [0.94, 0.94], [0.06, 0.94]]) {
    const p = project(eye, mix(u!, v!));
    assert.ok((await red(spec, 0, p.x, p.y)) > 150, `inside at ${u}, ${v}`);
  }
  for (const [u, v] of [[-0.08, 0.5], [1.08, 0.5], [0.5, -0.08], [0.5, 1.08]]) {
    const p = project(eye, mix(u!, v!));
    assert.ok((await red(spec, 0, p.x, p.y)) < 100, `outside at ${u}, ${v}`);
  }
  // Its place moves it as a whole.
  const moved = make([ramp({ at: [300, -50, 200] })], [], view);
  const q = project(eye, [300, 50, 200]);
  assert.ok((await red(moved, 0, q.x, q.y)) > 150);
  // From behind it is drawn too, unless its back is not to be.
  const behind = { ...view, tilt: 0, turn: 180 };
  const b = project(eyeOf(camera(behind)), mix(0.5, 0.5));
  assert.ok((await red(make([ramp()], [], behind), 0, b.x, b.y)) > 150);
  assert.ok((await red(make([ramp({ back: false })], [], behind), 0, b.x, b.y)) < 100);
  assert.ok((await red(make([ramp({ back: false })], [], view), 0, project(eye, mix(0.5, 0.5)).x, project(eye, mix(0.5, 0.5)).y)) > 150);

  // A stroke through points of the space.
  const rail = make([stroke({ id: 'rail', points: [[-300, 100, -200], [0, 100, 300], [300, -100, 300]], smooth: 0, color: 'accent.pink', width: 16 })], [], view);
  for (const p of [[-150, 100, 50], [150, 0, 300]] as Vec3[]) assert.ok((await red(rail, 0, project(eye, p).x, project(eye, p).y)) > 150);
  assert.ok((await red(rail, 0, project(eye, [150, 100, 300]).x, project(eye, [150, 100, 300]).y)) < 100);

  // Driven points: a flap that folds down about its lower edge.
  const fold = (t: number): Vec3[] => {
    const a = (Math.PI / 2) * Math.min(1, t / 2);
    const far = -150 + 300 * Math.cos(a) + 360 * Math.sin(a);
    return [[-150, 200, -150], [-150, 200 - 200 * Math.cos(a), far], [150, 200 - 200 * Math.cos(a), far], [150, 200, -150]];
  };
  const flap = make([ramp()], [drive('ramp', { at: 1, dur: 2, by: (t) => ({ points: fold(t) }) })], view);
  assert.equal(await hash(flap, 30), await hash(spec, 30));
  const top = project(eye, mix(0.5, 0.9));
  const flat = project(eye, [0, 200, 150]);
  assert.ok((await red(flap, 30, top.x, top.y)) > 150 && (await red(flap, 200, top.x, top.y)) < 100 && (await red(flap, 200, flat.x, flat.y)) > 150);

  const refuse = (nodes: () => LayerSpec['nodes'], keys: Key[], message: RegExp, layerView: View | null = true): void => {
    assert.throws(() => make(nodes(), keys, layerView), message, String(message));
  };
  refuse(() => [ramp()], [], /shape "ramp" has points of three numbers, \[x, y, z\]/, null);
  refuse(() => [group({ id: 'g', children: [ramp()] })], [], /shape "ramp" has points of three numbers, \[x, y, z\]/);
  refuse(() => [ramp()], [reshape('ramp', { at: 1, points: [[0, 0], [1, 0], [1, 1], [0, 1]] })], /reshape cannot target "ramp": its points are points of the space of a perspective layer; drive them with drive\(\)/);
  refuse(() => [ramp()], [drive('ramp', { dur: 1, by: () => ({ points: [[0, 0], [1, 0], [1, 1], [0, 1]] }) })], /drive\("ramp"\) sets points of two numbers, and the node has points of the space, \[x, y, z\]/);
  assert.throws(() => region({ id: 'r', points: [[0, 0], [10, 0], [0, 10]], fill: 'accent.pink', back: false }), /back is for a region of points of the space of a perspective layer/);
  assert.throws(() => region({ id: 'r', points: RAMP, fill: 'accent.pink', level: 0.5 }), /a region of points \[x, y, z\] cannot have a level/);
  assert.throws(() => region({ id: 'r', points: [[0, 0, 0], [10, 0], [0, 10, 0]] as never, fill: 'accent.pink' }), /points\[1\] must be \[x, y, z\]/);
});

test('perspective: a move with three numbers goes in depth too, and a link joins what stands in the space', async () => {
  const spec = make([pink({ at: [200, 0, 0] })], [moveTo('pink', { at: 1, to: [200, 0, 1600], dur: 2, profile: 'steady' })]);
  assert.deepEqual(await drawn(spec, 'pink', 30), { x: 200, y: 0, scale: 1 });
  const half = await drawn(spec, 'pink', 120);
  assert.ok(near(half.x, 200 / 1.5, 1e-9) && near(half.scale, 1 / 1.5, 1e-9), 'half-way it is 800 away');
  assert.deepEqual(await drawn(spec, 'pink', 240), { x: 100, y: 0, scale: 0.5 });
  // A move with two numbers keeps the distance it has.
  const across = make([pink({ at: [200, 0, 1600] })], [moveTo('pink', { at: 1, to: [-200, 0], dur: 2 })]);
  assert.deepEqual(await drawn(across, 'pink', 240), { x: -100, y: 0, scale: 0.5 });
  // A link runs between the pictures of its two nodes.
  const joined = make([group({ id: 'p', at: [-300, 0, 0] }), group({ id: 'q', at: [600, 0, 1600] }), link({ id: 'stick', from: 'p', to: 'q', color: 'accent.pink', width: 14, bend: 0, gap: 0 })]);
  assert.ok((await red(joined, 0, 0, 0)) > 150 && (await red(joined, 0, 290, 0)) > 150 && (await red(joined, 0, 330, 0)) < 100);
});

test('perspective: what the shot refuses', () => {
  const refuse = (nodes: () => LayerSpec['nodes'], keys: Key[], message: RegExp, view: View | null = true): void => {
    assert.throws(() => make(nodes(), keys, view), message, String(message));
  };
  const listed = /it must be listed directly in the nodes of a perspective layer|listed directly in a layer's nodes/;
  refuse(() => [pink({ at: [0, 0, 100] })], [], /shape "pink" has a place of three numbers, \[x, y, z\]/, null);
  refuse(() => [group({ id: 'g', children: [pink({ at: [0, 0, 100] })] })], [], /shape "pink" has a place of three numbers, \[x, y, z\]/);
  refuse(() => [group({ id: 'floor', plane: 'floor' })], [], /group "floor" lies in a plane/, null);
  refuse(() => [group({ id: 'g', children: [group({ id: 'floor', plane: 'floor' })] })], [], /group "floor" lies in a plane/);
  refuse(() => [group({ id: 'floor', plane: 'floor', upright: true })], [], /group "floor" lies in a plane: it cannot also have follow, upright or clipTo/);
  refuse(() => [pink()], [moveTo('pink', { at: 1, to: [0, 0, 100] })], /moveTo\("pink"\) has a place of three numbers, \[x, y, z\]/, null);
  refuse(() => [group({ id: 'g', children: [pink()] })], [moveTo('pink', { at: 1, to: [0, 0, 100] })], /moveTo\("pink"\) has a place of three numbers, \[x, y, z\]/);
  refuse(() => [pink({ body: { kind: 'dynamic', release: 0 } })], [], /rigid body "pink" is in the perspective layer "room"; the physics bake is flat: put the bodies in a flat layer/);
  refuse(
    () => [group({ id: 'floor', plane: 'floor', children: [rect({ id: 'tile', w: 100, h: 100, fill: 'accent.pink' })] }), aqua({ clipTo: 'tile' })],
    [],
    /shape "aqua" and the shape it is clipped to, "tile", must lie in the same plane/,
  );
  assert.throws(() => group({ id: 'g', plane: 'ceiling' as never }), /plane must be one of floor, wall, side, or \{ x, y \} with two directions \[x, y, z\]/);
  assert.throws(() => group({ id: 'g', plane: { x: [1, 0, 0], y: [1, 1, 0] } }), /plane\.x and plane\.y must be at right angles/);
  assert.throws(() => group({ id: 'g', plane: { x: [0, 0, 0], y: [0, 1, 0] } }), /plane\.x must be a direction; it has no length/);
  assert.throws(() => group({ id: 'g', back: false }), /back is for a group that lies in a plane of a perspective layer: give plane/);
  assert.match('it must be listed directly in the nodes of a perspective layer', listed);
});

test('perspective: the motion review judges the camera of the layer, not the nodes it moves on the layer; a set that only the camera moves is a hold', async () => {
  const set = (): LayerSpec['nodes'] => [
    group({ id: 'floor', at: [0, 300, 0], plane: 'floor', depth: 4000, children: [rect({ id: 'tile', w: 900, h: 700, fill: 'dark.indigo', lit: false })] }),
    pink({ at: [-250, 240, 100] }),
    aqua({ at: [300, 240, -150] }),
  ];
  const view = { aim: [0, 200, 0] as Vec3, distance: 1700, tilt: 20 };
  // The sound scene: the camera rises and goes round from rest to rest. Nothing is found, on it or on what it shows.
  assert.deepEqual(await flagged(make(set(), [perspectiveTo('room', { at: 1, dur: 2, tilt: 70, turn: 40 })], view, 4)), []);
  // Planted: it rises at one speed, from a standing start to a dead stop.
  assert.deepEqual(await flagged(make(set(), [perspectiveTo('room', { at: 1, dur: 2, tilt: 70, profile: 'steady' })], view, 4)), [
    'abrupt-start (perspective:room) rotation',
    'abrupt-stop (perspective:room) rotation',
  ]);
  // Planted: a dolly that starts at full speed, and a look elsewhere that does.
  assert.deepEqual(await flagged(make(set(), [perspectiveTo('room', { at: 1, dur: 2, distance: 700, profile: 'out' })], view, 4)), ['abrupt-start (perspective:room) scale']);
  assert.deepEqual(await flagged(make(set(), [perspectiveTo('room', { at: 1, dur: 2, aim: [500, 200, 0], profile: 'out' })], view, 4)), ['abrupt-start (perspective:room) position']);
  // Planted: the shortest move a key can ask for, three frames long. It is far too fast to ease.
  assert.deepEqual(await flagged(make(set(), [perspectiveTo('room', { at: 2, dur: 0.05, turn: 60, profile: 'steady' })], view, 4)), [
    'abrupt-start (perspective:room) rotation',
    'abrupt-stop (perspective:room) rotation',
  ]);
  // An intended exception names the camera of the layer as a subject.
  const meant = compileShot(make(set(), [perspectiveTo('room', { at: 1, dur: 2, distance: 700, profile: 'out' })], view, 4, [intended('(perspective:room)', 'abrupt-start', 'the camera is thrown forward')]));
  const report = reviewMotion(meant, await bakeShot(meant)).report;
  assert.deepEqual([report.findings.length, report.honoured.length, report.unused.length], [0, 1, 0]);
  assert.throws(() => make(set(), [], view, 4, [intended('(perspective:hall)', 'abrupt-start', 'no such layer')]), /\(perspective:hall\)/);

  // A node is judged on what it does in the space: one speed between two rests is mechanical, with the camera at rest or on its way.
  const slide = moveTo('pink', { at: 1, to: [250, 240, 100], dur: 2, profile: 'steady' });
  assert.deepEqual(await flagged(make(set(), [slide], view, 4)), ['mechanical pink position']);
  assert.deepEqual(await flagged(make(set(), [slide, perspectiveTo('room', { at: 0.5, dur: 3, tilt: 60, turn: 30 })], view, 4)), ['mechanical pink position']);
  // A hinge that turns is judged on the travel of the edge of its plane.
  const lid = (profile: 'steady' | 'ease'): ShotSpec =>
    make([group({ id: 'lid', at: [0, 300, 0], plane: 'floor', children: [rect({ id: 'tile', at: [0, -200], w: 500, h: 400, fill: 'accent.pink', lit: false })] })], [turnTo('lid', { at: 1, to: 80, about: 'x', dur: 2, profile })], view, 4);
  assert.deepEqual(await flagged(lid('steady')), ['abrupt-start lid rotation', 'abrupt-stop lid rotation']);
  assert.deepEqual(await flagged(lid('ease')), []);

  // Life: a set that only the camera moves is a hold of the whole frame, as under the camera of the shot.
  const held = await flagged(make(set(), [perspectiveTo('room', { at: 0.5, dur: 8, tilt: 60, turn: 50 })], view, 9));
  assert.ok(held.includes('dead-area (frame) hold'), held.join('; '));
  // Something that moves in the space keeps it alive.
  const alive = await flagged(
    make(set(), [perspectiveTo('room', { at: 0.5, dur: 8, tilt: 60, turn: 50 }), drive('pink', { dur: 9, by: (t) => ({ at: [-250 + 200 * Math.sin(t), 240, 100 + 200 * Math.cos(t)] }) })], view, 9),
  );
  assert.ok(!alive.some((f) => f.startsWith('dead-area (frame) ')), alive.join('; '));
});
