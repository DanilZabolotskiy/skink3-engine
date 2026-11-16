import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  computeWorld,
  drawOn,
  evaluate,
  flatItems,
  frameRaw,
  heightFor,
  IntentError,
  label,
  layer,
  pathTable,
  posesFromBake,
  region,
  reshape,
  reviewMotion,
  sceneEvents,
  shot,
  stroke,
  type Key,
  type LayerSpec,
  type ShotSpec,
  type Vec2,
} from '../src/index.ts';
import { shapeExtent, type ShapeSpec } from '../src/shape/geometry.ts';

// An outline that changes over time: a region, or a stroke, whose points run to new places.

const WIDTH = 480;

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], seconds = 6, strings: Record<string, string> = {}): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 3,
    palette,
    strings: { en: strings },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    // A still camera: a place of the stage is that place on screen, moved by half a frame.
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

/** A square of 200 units, as eight points with straight edges: its corners and the middles of its sides, clockwise from the top left. */
const SQUARE: Vec2[] = [[-100, -100], [0, -100], [100, -100], [100, 0], [100, 100], [0, 100], [-100, 100], [-100, 0]];
/** A coast with as many points, the same way round and from the same place. */
const COAST: Vec2[] = [[-160, -60], [0, -140], [150, -90], [220, 10], [120, 110], [-20, 70], [-140, 120], [-230, 20]];

const isle = (extra: object = {}): ReturnType<typeof region> => region({ id: 'isle', fill: 'accent.pink', lit: false, points: SQUARE, smooth: 0, ...extra });

/** The shape the region is drawn with at a moment. */
async function shapeAt(spec: ShotSpec, seconds: number): Promise<{ shape: ShapeSpec | undefined; node: ShapeSpec }> {
  const c = compileShot(spec);
  const item = flatItems(evaluate(c, await bakeShot(c), Math.round(seconds * 60), 'en').layers[0]!.items).find((i) => i.node.id === 'isle')!;
  assert.ok(item.kind === 'shape' && item.node.node.type === 'shape');
  return { shape: item.shape, node: item.node.node.shape };
}

/** True where the pixel at a place of the stage has the colour of the region (bright, and red). */
async function filled(spec: ShotSpec, frame: number, x: number, y: number): Promise<boolean> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
  const k = WIDTH / 1920;
  return raw[(Math.round(heightFor(WIDTH) / 2 + y * k) * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4]! > 150;
}

async function hash(spec: ShotSpec, frame: number): Promise<string> {
  const c = compileShot(spec);
  return createHash('sha256').update(await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false })).digest('hex');
}

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;
const samePoints = (a: readonly Vec2[], b: readonly Vec2[], eps = 1e-6): boolean => a.length === b.length && a.every((p, i) => near(p[0], b[i]![0], eps) && near(p[1], b[i]![1], eps));

test('reshape: the key carries the new outline, and refuses what it does not take', () => {
  assert.deepEqual(reshape('isle', { at: 2, points: COAST }), { kind: 'reshape', target: 'isle', at: 2, dur: 1.2, points: COAST, profile: 'ease', ramp: 0.3 });
  assert.deepEqual(reshape('isle', { at: 2, points: COAST, dur: 3, smooth: 1, profile: 'out', ramp: 0.2 }), { kind: 'reshape', target: 'isle', at: 2, dur: 3, points: COAST, smooth: 1, profile: 'out', ramp: 0.2 });
  const bad = (opts: object, message: RegExp): void => {
    assert.throws(() => reshape('isle', { at: 1, points: COAST, ...opts } as never), (e: unknown) => e instanceof IntentError && message.test(e.message), String(message));
  };
  bad({ points: 'coast' }, /points must be the new outline: a list of points \[x, y\], as many as the node has/);
  bad({ points: [[0, 0], [1]] }, /points\[1\] must be \[x, y\]/);
  bad({ dur: 0.05 }, /dur must be a number in 0\.1\.\.600/);
  bad({ smooth: 2 }, /smooth must be a number in 0\.\.1/);
  bad({ profile: 'settle' }, /profile must be one of ease, steady, in, out/);
  bad({ profile: 'steady', ramp: 0.2 }, /ramp applies to the profiles ease, in and out/);
  bad({ to: COAST }, /reshape\("isle"\): unknown option "to" \(allowed: at, points, dur, smooth, profile, ramp\)/);
});

test('reshape: what the shot refuses', () => {
  const refuse = (nodes: LayerSpec['nodes'], key: Key, message: RegExp): void => {
    assert.throws(() => make(nodes, [key]), message, String(message));
  };
  refuse([circle({ id: 'c', r: 40, fill: 'accent.aqua' })], reshape('c', { at: 1, points: COAST }), /reshape cannot target circle "c"; it applies to regions and strokes, whose outline is a list of points/);
  refuse([isle()], reshape('isle', { at: 1, points: COAST.slice(0, 6) }), /reshape\("isle"\) at 1 s: the new outline has 6 points, and "isle" has 8; give as many/);
  // The new outline must be a region itself.
  const knot: Vec2[] = [[-100, -100], [0, -100], [100, -100], [-150, 30], [100, 100], [0, 100], [-100, 100], [-100, 0]];
  refuse([isle()], reshape('isle', { at: 1, points: knot }), /reshape\("isle"\) at 1 s: the new outline is no region: the outline crosses itself near point \d+ and point \d+/);
  // And the region must stay one on the way: here every point runs to the opposite one, through the middle.
  const turned = [...SQUARE.slice(4), ...SQUARE.slice(0, 4)];
  refuse([isle()], reshape('isle', { at: 1, points: turned }), /reshape\("isle"\) at 1 s: on the way to its new outline the region is no region \(.*, 50 % of the way\)\. Give both outlines the same way round and from the same place/);
  refuse([stroke({ id: 's', points: [[-100, 0], [100, 0]], color: 'accent.pink' })], reshape('s', { at: 1, points: [[5, 5], [5, 5]] }), /reshape\("s"\) at 1 s: the new points give a line without length/);
  refuse([isle()], reshape('isle', { at: 9, points: COAST }), /reshape\("isle"\) starts at 9 s, after the shot ends/);
});

test('reshape: a region without it is the shape it was; with it every point runs to its place, and the change lasts', async () => {
  const plain = compileShot(make([isle()]));
  assert.equal(plain.byId.get('isle')!.outline, null);
  assert.equal((await shapeAt(make([isle()]), 1)).shape, undefined, 'its item carries no shape of its own');

  const spec = make([isle()], [reshape('isle', { at: 1, dur: 2, points: COAST, smooth: 1 })]);
  const before = await shapeAt(spec, 0.5);
  assert.equal(before.shape, before.node, 'before the key it is the very shape of the node');
  // Half-way: every point half-way to its place, and the edges half rounded.
  const mid = (await shapeAt(spec, 2)).shape!;
  assert.ok(mid.kind === 'polygon' && near(mid.smooth!, 0.5));
  assert.ok(samePoints(mid.points, SQUARE.map((p, i) => [(p[0] + COAST[i]![0]) / 2, (p[1] + COAST[i]![1]) / 2] as Vec2)));
  // From rest to rest: a little after its start it has hardly begun.
  const early = (await shapeAt(spec, 1.2)).shape!;
  assert.ok(early.kind === 'polygon' && Math.abs(early.points[1]![1] - -100) < 2);
  // When the key has ended it is the new outline, one and the same shape on every frame.
  const after = (await shapeAt(spec, 3)).shape!;
  assert.ok(after.kind === 'polygon' && after.smooth === 1 && samePoints(after.points, COAST));
  assert.equal((await shapeAt(spec, 5)).shape!.kind, 'polygon');
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const at = (frame: number): unknown => flatItems(evaluate(c, bake, frame, 'en').layers[0]!.items).find((i) => i.node.id === 'isle');
  assert.equal((at(200) as { shape: unknown }).shape, (at(300) as { shape: unknown }).shape);
  // Between two outlines the light has a middle and a size between theirs: they change evenly.
  const inner = [shapeExtent(before.node).inner, shapeExtent(mid).inner, shapeExtent(after).inner];
  assert.ok(near(inner[1]!, (inner[0]! + inner[2]!) / 2, 1e-6), inner.join(', '));

  // Keys chain: the second starts from the outline reached, also when the first is under way.
  const pointsAt = async (of: ShotSpec, seconds: number): Promise<readonly Vec2[]> => {
    const { shape } = await shapeAt(of, seconds);
    assert.ok(shape && shape.kind === 'polygon');
    return shape.points;
  };
  const back = make([isle()], [reshape('isle', { at: 1, dur: 2, points: COAST, profile: 'steady' }), reshape('isle', { at: 2, dur: 1, points: SQUARE, profile: 'steady' })]);
  assert.ok(samePoints(await pointsAt(back, 2), SQUARE.map((p, i) => [(p[0] + COAST[i]![0]) / 2, (p[1] + COAST[i]![1]) / 2] as Vec2)));
  assert.ok(samePoints(await pointsAt(back, 3), SQUARE));
  assert.ok(near((await pointsAt(back, 2.5))[3]![0], 100 + (220 - 100) / 4, 1e-6), 'half-way back from half-way there');
  // An outline given the other way round is read the same way round as the first.
  const reversed = make([region({ id: 'isle', fill: 'accent.pink', points: SQUARE.slice().reverse(), smooth: 0 })], [reshape('isle', { at: 1, dur: 2, points: COAST.slice().reverse() })]);
  assert.ok(samePoints(await pointsAt(reversed, 3), COAST));
});

test('reshape: the picture follows the outline, and the frames before the key are those of the shot without it', async () => {
  const plain = make([isle()]);
  const spec = make([isle()], [reshape('isle', { at: 1, dur: 2, points: COAST, smooth: 1 })]);
  for (const frame of [0, 30, 60]) assert.equal(await hash(spec, frame), await hash(plain, frame), `frame ${frame}`);
  // A place inside the coast and outside the square: filled when the key has ended, not before, and on the way when the edge has passed it.
  assert.equal(await filled(spec, 30, 170, 10), false);
  assert.equal(await filled(spec, 200, 170, 10), true);
  assert.equal(await filled(spec, 120, 170, 10), false, 'half-way the edge is at 160');
  assert.equal(await filled(spec, 120, 140, 10), true);
  // And back: the place the coast leaves is empty in the end.
  const shrink = make([region({ id: 'isle', fill: 'accent.pink', lit: false, points: COAST })], [reshape('isle', { at: 1, dur: 2, points: SQUARE, smooth: 0 })]);
  assert.equal(await filled(shrink, 30, 170, 10), true);
  assert.equal(await filled(shrink, 200, 170, 10), false);
  assert.equal(await filled(shrink, 200, 90, -90), true);
  // The middle stays filled all the way.
  for (const frame of [30, 90, 120, 150, 200]) assert.equal(await filled(spec, frame, 0, 0), true, `frame ${frame}`);
});

test('reshape: what reads the outline follows it: a label at its edge, and what is clipped to it', async () => {
  // A label on top of the region: its tail stays at the edge as the top of the outline rises from -100 to -140.
  const spec = make([isle(), label({ id: 'tag', text: 'tag', target: 'isle', fill: 'light.cream', ink: 'deep.night', gap: 10 })], [reshape('isle', { at: 1, dur: 2, points: COAST, smooth: 0 })], 6, { tag: 'Isle' });
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const tip = (seconds: number): number => computeWorld(c, Math.round(seconds * 60), posesFromBake(bake))[c.byId.get('tag')!.index]!.y;
  assert.ok(near(tip(0.5), -110, 1e-6) && near(tip(3.5), -150, 3) && tip(2) < -125 && tip(2) > -135, `${tip(0.5)}, ${tip(2)}, ${tip(3.5)}`);
  // A disc clipped to the region: where the coast reaches past the square it shows only when the coast is there.
  const clipped = make(
    [region({ id: 'isle', fill: 'deep.ink', lit: false, points: SQUARE, smooth: 0 }), circle({ id: 'sun', r: 400, fill: 'accent.pink', lit: false, clipTo: 'isle' })],
    [reshape('isle', { at: 1, dur: 2, points: COAST, smooth: 1 })],
  );
  assert.equal(await filled(clipped, 30, 170, 10), false);
  assert.equal(await filled(clipped, 200, 170, 10), true);
  assert.equal(await filled(clipped, 200, 300, 10), false);
});

test('reshape: a stroke changes its line the same way, and what is drawn of it is a share of the line it has', async () => {
  const flat: Vec2[] = [[-300, 0], [-100, 0], [100, 0], [300, 0]];
  const hill: Vec2[] = [[-300, 0], [-100, -120], [100, -120], [300, 0]];
  const spec = make([stroke({ id: 's', points: flat, smooth: 0, color: 'accent.pink', width: 10 })], [reshape('s', { at: 1, dur: 2, points: hill, profile: 'steady' })]);
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const item = (seconds: number): { path?: { points: readonly Vec2[] } } => {
    const it = flatItems(evaluate(c, bake, Math.round(seconds * 60), 'en').layers[0]!.items).find((i) => i.node.id === 's')!;
    assert.ok(it.kind === 'stroke');
    return it;
  };
  assert.ok(samePoints(item(2).path!.points, [[-300, 0], [-100, -60], [100, -60], [300, 0]]) && samePoints(item(4).path!.points, hill));
  // The line is where its points are: on the ridge after the change, on the flat before it.
  assert.equal(await filled(spec, 30, 0, 0), true);
  assert.equal(await filled(spec, 200, 0, 0), false);
  assert.equal(await filled(spec, 200, 0, -120), true);
  assert.equal(await filled(spec, 120, 0, -60), true);
  assert.equal(await hash(spec, 30), await hash(make([stroke({ id: 's', points: flat, smooth: 0, color: 'accent.pink', width: 10 })]), 30));
  // A stroke without a reshape carries no path of its own.
  const still = compileShot(make([stroke({ id: 's', points: flat, color: 'accent.pink' })]));
  const plainItem = flatItems(evaluate(still, await bakeShot(still), 0, 'en').layers[0]!.items)[0]!;
  assert.ok(plainItem.kind === 'stroke' && plainItem.path === undefined && still.byId.get('s')!.outline === null);
  // Half of the line is half of the line it has now: the motion series follows its length.
  const half = compileShot(make([stroke({ id: 's', points: flat, smooth: 0, color: 'accent.pink', drawn: 0.5 })], [reshape('s', { at: 1, dur: 2, points: hill }), drawOn('s', { at: 4, dur: 1 })]));
  const life = reviewMotion(half, await bakeShot(half)).series.placed[half.byId.get('s')!.index]!.life!;
  assert.ok(near(life[0]!, 300, 1e-3) && near(life[200]!, pathTable({ points: hill, closed: false, smooth: 0 }).length / 2, 1e-3), `${life[0]}, ${life[200]}`);
});

test('reshape: the motion review knows it: one speed between two rests is mechanical, an eased change is clean, and a changing outline is life in the frame', async () => {
  const flagged = async (spec: ShotSpec): Promise<string[]> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c))
      .report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel}`)
      .sort();
  };
  // The planted defect: the outline starts to change at full speed, changes at one speed and stops dead.
  const steady = await flagged(make([isle()], [reshape('isle', { at: 1, dur: 2, points: COAST, profile: 'steady' })], 4));
  assert.deepEqual(steady, ['mechanical isle outline']);
  // The sound scene: from rest to rest.
  assert.deepEqual(await flagged(make([isle()], [reshape('isle', { at: 1, dur: 2, points: COAST })], 4)), []);
  // The measure is the way of the point that travels farthest, here 133 units, in px.
  const c = compileShot(make([isle()], [reshape('isle', { at: 1, dur: 2, points: COAST })], 4));
  const series = reviewMotion(c, await bakeShot(c)).series.placed[c.byId.get('isle')!.index]!;
  assert.ok(near(series.outline![0]!, 0) && near(series.outline![239]!, Math.hypot(130, 20), 1e-3) && near(series.outline![120]!, Math.hypot(130, 20) / 2, 1e-3), `${series.outline![239]}`);
  // Life: a region that only lies there is a hold; one whose outline changes keeps its part of the frame alive.
  const held = await flagged(make([isle()], [], 9));
  assert.ok(held.includes('dead-area (frame) hold'), held.join('; '));
  const alive = await flagged(make([isle()], [reshape('isle', { at: 1, dur: 3.5, points: COAST }), reshape('isle', { at: 5, dur: 3.5, points: SQUARE })], 9));
  assert.ok(!alive.some((f) => f.startsWith('dead-area (frame) ')), alive.join('; '));
  // A reshape is no event: it makes no sound.
  assert.deepEqual(sceneEvents(c, await bakeShot(c)), []);
});
