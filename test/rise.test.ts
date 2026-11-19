import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  computeWorld,
  evaluate,
  flatItems,
  frameRaw,
  group,
  heightFor,
  layer,
  perspectiveTo,
  posesFromBake,
  rect,
  region,
  reviewMotion,
  riseTo,
  sceneEvents,
  shot,
  stroke,
  type Key,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';

// A body with a height: a shape or a stroke with a rise is the top of a body that stands on its place, with its side
// under it; riseTo raises and lowers it.

const WIDTH = 960;

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], extra: object = {}, seconds = 4): ShotSpec {
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
    layers: [layer({ id: 'stage', depth: 0, tint: 0, nodes, ...extra })],
    timeline,
  });
}

/** A block of 200 by 100 units in the middle of the stage, with a pale top and a red side. */
const block = (extra: object = {}): LayerSpec['nodes'] => [rect({ id: 'b', w: 200, h: 100, radius: 0, fill: 'light.snow', lit: false, side: 'accent.coral', rise: 60, ...extra })];

/** The colour at a place of the stage: [red, green, blue]. */
async function pixel(spec: ShotSpec, frame: number, x: number, y: number): Promise<[number, number, number]> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
  const k = WIDTH / 1920;
  const i = (Math.round(heightFor(WIDTH) / 2 + y * k) * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4;
  return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
}

const pale = (p: readonly number[]): boolean => p[0]! > 200 && p[1]! > 200 && p[2]! > 200;
const red = (p: readonly number[]): boolean => p[0]! > 200 && p[1]! < 140 && p[2]! < 140;
const dark = (p: readonly number[]): boolean => p[0]! < 90 && p[1]! < 60;

async function hash(spec: ShotSpec, frame: number): Promise<string> {
  const c = compileShot(spec);
  return createHash('sha256').update(await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false })).digest('hex');
}

/** The world transforms of a shot at a moment, by node id. */
async function worldOf(spec: ShotSpec): Promise<(seconds: number, id: string) => { x: number; y: number; scale: number }> {
  const c = compileShot(spec);
  const poses = posesFromBake(await bakeShot(c));
  return (seconds, id) => computeWorld(c, Math.round(seconds * 60), poses)[c.byId.get(id)!.index]!;
}

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

test('rise: a shape with a rise is the top of a body: the top is drawn up the screen, its side under it, and its foot stays', async () => {
  const spec = make(block());
  // The top is 60 units up the screen; the foot stands where the shape was placed.
  assert.ok(pale(await pixel(spec, 0, 0, -60)), 'the top');
  assert.ok(pale(await pixel(spec, 0, 0, -100)), 'the far edge of the top');
  assert.ok(dark(await pixel(spec, 0, 0, -118)), 'above the top there is nothing');
  assert.ok(red(await pixel(spec, 0, 0, 20)), 'the side, under the near edge of the top');
  assert.ok(red(await pixel(spec, 0, -90, 40)), 'the side reaches down to the foot, corner to corner');
  assert.ok(red(await pixel(spec, 0, 90, 40)));
  assert.ok(dark(await pixel(spec, 0, 0, 58)), 'under the foot there is nothing');
  assert.ok(dark(await pixel(spec, 0, 112, 0)), 'beside it there is nothing');
  // Without a colour of its own the side is a shadow tone of the fill: darker than the top, and not the background.
  const plain = await pixel(make(block({ side: undefined, fill: 'accent.amber' })), 0, 0, 30);
  const top = await pixel(make(block({ side: undefined, fill: 'accent.amber' })), 0, 0, -60);
  assert.ok(plain[0]! < top[0]! - 40 && plain[0]! > 90, `the side ${plain} is a darker tone of the top ${top}`);
  // The item is that of the top, and it says where the foot stands; the transform of the node is that of the top.
  const c = compileShot(spec);
  const item = flatItems(evaluate(c, await bakeShot(c), 0, 'en').layers[0]!.items)[0]!;
  assert.ok(item.kind === 'shape' && item.foot);
  assert.deepEqual([item.xf.x, item.xf.y, item.foot.k, item.foot.x, item.foot.y], [0, -60, 1, 0, 60]);
  // The height is in the units of the node, and up the screen however the node is turned.
  const turned = await worldOf(make([group({ id: 'g', at: [100, 50], scale: 2, rotation: 90, children: block() })]));
  assert.ok(near(turned(0, 'b').x, 100) && near(turned(0, 'b').y, 50 - 120));
});

test('rise: what is inside a body rides on its top, and bodies stack', async () => {
  const nodes: LayerSpec['nodes'] = [
    rect({ id: 'base', at: [0, 100], w: 400, h: 200, fill: 'dark.navy', lit: false, rise: 40, children: [
      circle({ id: 'dot', at: [50, 0], r: 10, fill: 'accent.aqua', lit: false }),
      rect({ id: 'tower', at: [-100, 0], w: 60, h: 60, fill: 'light.snow', lit: false, rise: 80 }),
    ] }),
  ];
  const world = await worldOf(make(nodes, [riseTo('base', { at: 1, to: 100, dur: 1 })]));
  assert.ok(near(world(0, 'base').y, 60) && near(world(0, 'dot').y, 60) && near(world(0, 'tower').y, 60 - 80));
  assert.ok(near(world(3, 'base').y, 0) && near(world(3, 'dot').y, 0) && near(world(3, 'tower').y, -80));
  assert.ok(near(world(3, 'dot').x, 50) && near(world(3, 'tower').x, -100));
});

test('rise: riseTo raises a body out of the ground and lowers it again; keys chain from the height reached', async () => {
  const spec = make(block({ rise: 0 }), [riseTo('b', { at: 1, to: 80, dur: 1 }), riseTo('b', { at: 2.5, to: 20, dur: 0.5 })]);
  const world = await worldOf(spec);
  assert.equal(world(0.5, 'b').y, 0);
  assert.ok(world(1.5, 'b').y < -30 && world(1.5, 'b').y > -50, 'half-way up at half of its time');
  assert.ok(near(world(2, 'b').y, -80), 'it arrives exactly');
  assert.ok(near(world(3.5, 'b').y, -20));
  // It eases in and out: it is slower at the start and at the end than in the middle.
  const step = (t: number): number => Math.abs(world(t + 1 / 60, 'b').y - world(t, 'b').y);
  assert.ok(step(1) < step(1.5) / 3 && step(2 - 2 / 60) < step(1.5) / 3);
  // A body that has not risen yet is the flat shape: no side, and no foot on its item.
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const at = (frame: number): { foot?: unknown } => flatItems(evaluate(c, bake, frame, 'en').layers[0]!.items)[0]! as { foot?: unknown };
  assert.equal(at(30).foot, undefined);
  assert.ok(at(120).foot);
  assert.ok(pale(await pixel(spec, 30, 0, 40)) && dark(await pixel(spec, 30, 0, -70)));
  assert.ok(red(await pixel(spec, 120, 0, 40)) && pale(await pixel(spec, 120, 0, -70)));
  // A riseTo is no event: it makes no sound.
  assert.deepEqual(sceneEvents(c, bake), []);
});

test('rise: a stroke with a rise is a wall: the line is its top, and its side reaches down to where it stands', async () => {
  const wall = (extra: object = {}): LayerSpec['nodes'] => [stroke({ id: 'w', points: [[-300, 0], [300, 0]], smooth: 0, color: 'light.snow', side: 'accent.coral', width: 10, rise: 50, ...extra })];
  const spec = make(wall());
  assert.ok(pale(await pixel(spec, 0, 0, -50)), 'the line, 50 units up');
  assert.ok(red(await pixel(spec, 0, 0, -25)) && red(await pixel(spec, 0, 0, 2)), 'its side');
  assert.ok(dark(await pixel(spec, 0, 0, 14)) && dark(await pixel(spec, 0, 0, -64)));
  // The side follows the part of the line that is drawn.
  const half = make(wall({ drawn: 0.5 }));
  assert.ok(red(await pixel(half, 0, -150, -25)) && dark(await pixel(half, 0, 150, -25)));
  // A wall that runs straight down the screen still has a side: it is as wide as the line.
  const down = make([stroke({ id: 'w', points: [[0, -100], [0, 100]], smooth: 0, color: 'light.snow', side: 'accent.coral', width: 20, rise: 40 })]);
  assert.ok(red(await pixel(down, 0, 0, 80)) && red(await pixel(down, 0, 6, 104)) && pale(await pixel(down, 0, 0, -100)));
});

test('rise: in a plane of a perspective layer a body stands on the plane and is seen as the camera sees it', async () => {
  const view = { aim: [0, 0, 0] as [number, number, number], distance: 1800, tilt: 40, turn: 15 };
  // A block of the floor, 120 high, and a second floor 120 over the first (y runs down) with a tile at the same place.
  const nodes: LayerSpec['nodes'] = [
    group({ id: 'floor', at: [0, 0, 0], plane: 'floor', children: [
      rect({ id: 'low', at: [300, 200], w: 80, h: 80, fill: 'dark.navy', lit: false }),
      rect({ id: 'b', at: [300, 200], w: 80, h: 80, fill: 'light.snow', lit: false, rise: 120, children: [circle({ id: 'rider', at: [20, 0], r: 5, fill: 'accent.aqua', lit: false })] }),
    ] }),
    group({ id: 'upper', at: [0, -120, 0], plane: 'floor', children: [
      rect({ id: 'high', at: [300, 200], w: 80, h: 80, fill: 'accent.pink', lit: false }),
      circle({ id: 'high2', at: [320, 200], r: 5, fill: 'accent.pink', lit: false }),
    ] }),
  ];
  const world = await worldOf(make(nodes, [perspectiveTo('stage', { at: 1, tilt: 65, turn: -10, dur: 1 })], { perspective: view }));
  for (const t of [0, 1.5, 3]) {
    const top = world(t, 'b');
    const point = world(t, 'high');
    assert.ok(near(top.x, point.x, 1e-6) && near(top.y, point.y, 1e-6), `at ${t} s the top is where that place of the upper floor is drawn`);
    assert.ok(near(top.scale, point.scale, 1e-9), 'and as large as things are there');
    // It is nearer the camera than its foot: larger, and elsewhere on screen.
    assert.ok(top.scale > world(t, 'low').scale && Math.hypot(top.x - world(t, 'low').x, top.y - world(t, 'low').y) > 20);
    const rider = world(t, 'rider');
    assert.ok(near(rider.x, world(t, 'high2').x, 1e-6) && near(rider.y, world(t, 'high2').y, 1e-6), 'what is inside it rides on its top');
  }
  // The review reads such a scene as it reads any other: a body that stands while the camera moves is no finding.
  const c = compileShot(make(nodes, [perspectiveTo('stage', { at: 1, tilt: 65, turn: -10, dur: 1.6 })], { perspective: view }));
  assert.deepEqual(reviewMotion(c, await bakeShot(c)).report.findings.filter((f) => f.subject === 'b' || f.subject === 'rider'), []);
});

test('rise: what it refuses', () => {
  const bad = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, (e: unknown) => e instanceof Error && message.test(e.message), String(message));
  };
  bad(() => block({ rise: -1 }), /rise must be a number in 0\.\.2000/);
  bad(() => block({ rise: 2001 }), /rise must be a number in 0\.\.2000/);
  bad(() => block({ rise: undefined }), /side is the colour of the side of a shape with a height: give rise, or leave side out/);
  bad(() => block({ body: 'dynamic' }), /a rigid body cannot have a rise/);
  bad(() => block({ level: 0.5 }), /a shape with a level cannot have a rise/);
  bad(() => region({ id: 'r', points: [[0, 0, 0], [100, 0, 0], [100, 0, 100]], fill: 'dark.navy', rise: 10 }), /a region of points \[x, y, z\] cannot have a rise/);
  bad(() => stroke({ id: 's', points: [[0, 0, 0], [100, 0, 0]], color: 'light.snow', rise: 10 }), /a stroke of points \[x, y, z\] cannot have a rise/);
  bad(() => stroke({ id: 's', points: [[0, 0], [100, 0]], color: 'light.snow', side: 'dark.navy' }), /side is the colour of the side of a stroke with a height/);
  bad(() => make([stroke({ id: 's', points: [[0, 0], [100, 0]], color: 'light.snow', dash: [20, 20], rise: 10 })]), /stroke "s" has a rise and dashes; a wall is a solid line/);
  bad(() => make(block({ side: 'accent.nothing' })), /shape "b" side:/);
  bad(() => group({ id: 'g', rise: 10 } as never), /unknown option "rise"/);
  bad(() => riseTo('b', { at: 1, to: 50, overshoot: 0.2 } as never), /riseTo\("b"\): unknown option "overshoot" \(allowed: at, to, dur, profile, ramp\)/);
  bad(() => riseTo('b', { at: 1 } as never), /to must be a number in 0\.\.2000/);
  bad(() => riseTo('b', { at: 1, to: -5 }), /to must be a number in 0\.\.2000/);
  bad(() => riseTo('b', { at: 1, to: 50, dur: 0.01 }), /dur must be a number in 0\.05\.\.3600/);
  bad(() => riseTo('b', { at: 1, to: 50, profile: 'settle' as never }), /profile/);
  bad(() => riseTo('b', { at: 1, to: 50, profile: 'steady', ramp: 0.2 }), /ramp applies to the profiles ease, in and out/);
  // It is for bodies: a shape that was not given a rise lies flat.
  bad(() => make([rect({ id: 'flat', w: 50, h: 50, fill: 'dark.navy' })], [riseTo('flat', { at: 0, to: 20 })]), /riseTo cannot target shape "flat"; it applies to a shape or a stroke with a rise \(give it the option rise; 0 lies flat until it is raised\)/);
  bad(() => make([group({ id: 'g' })], [riseTo('g', { at: 0, to: 20 })]), /riseTo cannot target group "g"/);
  bad(() => make(block(), [riseTo('b', { at: 9, to: 20 })]), /riseTo\("b"\) starts at 9 s, after the shot ends/);
});

test('rise: it is opt-in: a node without a rise is the data and the picture it was', async () => {
  const flat = make(block({ rise: undefined, side: undefined }));
  const node = flat.layers[0]!.nodes[0]!;
  assert.ok(!('rise' in node) && !('side' in node));
  assert.ok(!('rise' in stroke({ id: 's', points: [[0, 0], [100, 0]], color: 'light.snow' })));
  const c = compileShot(flat);
  assert.equal(c.risen, false);
  assert.equal(c.byId.get('b')!.rise, null);
  const item = flatItems(evaluate(c, await bakeShot(c), 0, 'en').layers[0]!.items)[0]!;
  assert.ok(item.kind === 'shape' && !('foot' in item));
  // A body that lies flat is the picture of the flat shape, and so are the frames before it rises.
  const lying = make(block({ rise: 0 }));
  const rising = make(block({ rise: 0 }), [riseTo('b', { at: 1.5, to: 60 })]);
  for (const frame of [0, 45, 90]) {
    assert.equal(await hash(lying, frame), await hash(flat, frame), `frame ${frame}`);
    assert.equal(await hash(rising, frame), await hash(flat, frame), `frame ${frame}`);
  }
  assert.notEqual(await hash(rising, 200), await hash(flat, 200));
  // A body that is given a height is the body that a key brings to that height.
  assert.equal(await hash(rising, 200), await hash(make(block()), 200));
  // The same in a plane of a perspective layer.
  const floor = (nodes: LayerSpec['nodes'], keys: Key[] = []): ShotSpec => make([group({ id: 'floor', at: [0, 0, 0], plane: 'floor', children: nodes })], keys, { perspective: { tilt: 50 } });
  assert.equal(await hash(floor(block({ rise: 0 })), 0), await hash(floor(block({ rise: undefined, side: undefined })), 0));
  assert.notEqual(await hash(floor(block()), 0), await hash(floor(block({ rise: 0 })), 0));
});

test('rise: the motion review knows it: a body that shoots up starts and stops abruptly, one that rises in its time is clean', async () => {
  const flagged = async (spec: ShotSpec): Promise<string[]> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c))
      .report.findings.filter((f) => !f.kind.startsWith('dead-area'))
      .map((f) => `${f.kind} ${f.subject} ${f.channel}`)
      .sort();
  };
  const floor = (nodes: LayerSpec['nodes'], keys: Key[]): ShotSpec => make([group({ id: 'floor', at: [0, 0, 0], plane: 'floor', children: nodes })], keys, { perspective: { tilt: 50 } });
  // The planted defect: a body is 300 units high within three frames. In a flat layer, and on the floor of a perspective layer.
  assert.deepEqual(await flagged(make(block({ rise: 0 }), [riseTo('b', { at: 1, to: 300, dur: 0.05 })])), ['abrupt-start b position', 'abrupt-stop b position']);
  // There its top also comes nearer the camera, and grows as fast.
  assert.deepEqual(await flagged(floor(block({ rise: 0 }), [riseTo('b', { at: 1, to: 300, dur: 0.05 })])), ['abrupt-start b position', 'abrupt-start b scale', 'abrupt-stop b position', 'abrupt-stop b scale']);
  // A steady rise has one speed from its first frame to its last: the move of a machine.
  assert.deepEqual(await flagged(make(block({ rise: 0 }), [riseTo('b', { at: 1, to: 300, dur: 0.4, profile: 'steady' })])), ['mechanical b position']);
  // The sound scenes: bodies that rise and sink as the key makes them by itself.
  assert.deepEqual(await flagged(make(block({ rise: 0 }), [riseTo('b', { at: 0.5, to: 120 }), riseTo('b', { at: 2.5, to: 0 })])), []);
  assert.deepEqual(await flagged(floor(block({ rise: 0 }), [riseTo('b', { at: 0.5, to: 120 }), riseTo('b', { at: 2.5, to: 0 })])), []);
  const wall = stroke({ id: 'w', points: [[-300, 0], [300, 0]], smooth: 0, color: 'light.snow', width: 10, rise: 0 });
  assert.deepEqual(await flagged(make([wall], [riseTo('w', { at: 0.5, to: 60 })])), []);
  // A body that only stands there is still: nothing of it is measured frame by frame.
  const c = compileShot(make(block()));
  assert.equal(reviewMotion(c, await bakeShot(c)).series.placed[0]!.still, true);
});
