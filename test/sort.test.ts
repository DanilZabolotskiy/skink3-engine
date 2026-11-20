import assert from 'node:assert/strict';
import { test } from 'node:test';
import { circle, compileShot, group, perspectiveTo, pulse, rect, stroke, type LayerSpec, type ShotSpec, type StrokeItem } from '../src/index.ts';
import { amber, aqua, at, differing, draw, items, make, pale, red, refused } from './fixtures/bodies.ts';

// Depth order: a group that says sort: 'depth' draws its children far to near for the camera of each frame, and a
// wall among them stretch by stretch, so that it goes round what stands inside it.

/** Two bodies, one behind the other and partly hidden by it. */
function pair(first: 'near' | 'far'): LayerSpec['nodes'] {
  const near = rect({ id: 'near', at: [0, 40], w: 100, h: 60, radius: 0, fill: 'accent.aqua', lit: false, side: 'accent.coral', rise: 40 });
  const far = rect({ id: 'far', at: [0, -10], w: 100, h: 60, radius: 0, fill: 'light.snow', lit: false, side: 'accent.amber', rise: 40 });
  return first === 'near' ? [near, far] : [far, near];
}

const ids = async (spec: ShotSpec, frame = 0): Promise<string[]> => (await items(spec, frame)).map((i) => i.node.id);

test('sort: the children of a group are drawn far to near, in whatever order they are listed', async () => {
  // Listed near first and drawn as listed, the far body is painted over the near one.
  const listed = make([group({ id: 'g', children: pair('near') })]);
  assert.deepEqual(await ids(listed), ['near', 'far']);
  assert.ok(amber(at(await draw(listed), 0, 0)), 'the side of the far body, over the top of the near one');
  // Sorted, the near one is in front, as if they were listed far first.
  const sorted = make([group({ id: 'g', sort: 'depth', children: pair('near') })]);
  assert.deepEqual(await ids(sorted), ['far', 'near']);
  assert.ok(aqua(at(await draw(sorted), 0, 0)), 'the top of the near body');
  assert.deepEqual(await draw(sorted), await draw(make([group({ id: 'g', children: pair('far') })])));
  // What is listed far first stays as it is.
  assert.deepEqual(await ids(make([group({ id: 'g', sort: 'depth', children: pair('far') })])), ['far', 'near']);
});

test('sort: a child is placed with everything inside it, and what is equally far keeps its order', async () => {
  const nodes: LayerSpec['nodes'] = [
    group({ id: 'house', at: [0, 100], children: [rect({ id: 'walls', w: 80, h: 60, fill: 'light.snow', rise: 30 }), circle({ id: 'lamp', at: [0, -300], r: 6, fill: 'accent.amber' })] }),
    rect({ id: 'left', at: [-200, 0], w: 80, h: 60, fill: 'light.snow', rise: 30 }),
    rect({ id: 'right', at: [200, 0], w: 80, h: 60, fill: 'light.snow', rise: 30 }),
    rect({ id: 'back', at: [0, -100], w: 80, h: 60, fill: 'light.snow', rise: 30 }),
  ];
  // The lamp is far up the screen, but it belongs to the house, which stands nearest.
  assert.deepEqual(await ids(make([group({ id: 'g', sort: 'depth', children: nodes })])), ['back', 'left', 'right', 'walls', 'lamp']);
});

test('sort: in a plane of a perspective layer the order is that of the camera, at every frame', async () => {
  const two: LayerSpec['nodes'] = [
    rect({ id: 'south', at: [0, 300], w: 100, h: 60, fill: 'accent.aqua', rise: 40 }),
    rect({ id: 'north', at: [0, -600], w: 100, h: 60, fill: 'light.snow', rise: 40 }),
  ];
  const floor = (turn: number): ShotSpec =>
    make([group({ id: 'floor', at: [0, 0, 0], plane: 'floor', children: [group({ id: 'g', sort: 'depth', children: two })] })], [perspectiveTo('stage', { at: 1, turn: turn + 180, dur: 2 })], { perspective: { tilt: 50, turn } });
  assert.deepEqual(await ids(floor(0)), ['north', 'south']);
  assert.deepEqual(await ids(floor(180)), ['south', 'north'], 'seen from the other side');
  // As the camera goes round within a shot, the order turns over with it.
  assert.deepEqual(await ids(floor(0), 200), ['south', 'north']);
});

/** A wall round a tower that stands near its front stretch and is higher than it. */
function town(order: 'wall first' | 'wall last', opts: object): ShotSpec {
  const wall = stroke({ id: 'w', points: [[-150, -100], [150, -100], [150, 100], [-150, 100]], closed: true, width: 10, color: 'light.snow', side: 'accent.amber', rise: 40 });
  const tower = rect({ id: 't', at: [0, 30], w: 60, h: 120, radius: 0, fill: 'accent.aqua', lit: false, side: 'accent.coral', rise: 100 });
  return make([group({ id: 'g', ...opts, children: order === 'wall first' ? [wall, tower] : [tower, wall] })]);
}

test('sort: a closed wall goes round what stands inside it: its far stretches behind, its near stretches in front', async () => {
  // Drawn as listed, a wall is wholly behind the tower or wholly in front of it, and one of the two places is wrong.
  const behind = await draw(town('wall first', {}));
  assert.ok(aqua(at(behind, 0, -128)), 'the top of the tower hides the far stretch');
  assert.ok(red(at(behind, 0, 80)), 'but the side of the tower is painted over the near stretch');
  const before = await draw(town('wall last', {}));
  assert.ok(pale(at(before, 0, 80)), 'the near stretch hides the foot of the tower');
  assert.ok(amber(at(before, 0, -128)), 'but the far stretch is painted over its top');
  // Sorted, both are right, in either order.
  for (const order of ['wall first', 'wall last'] as const) {
    const raw = await draw(town(order, { sort: 'depth' }));
    assert.ok(aqua(at(raw, 0, -128)) && pale(at(raw, 0, 80)), order);
    assert.ok(amber(at(raw, 0, -145)) && amber(at(raw, 0, 95)), 'the wall itself');
  }

  // The wall comes as stretches, each a part of the line, some before the tower and some after it.
  const list = await items(town('wall first', { sort: 'depth' }));
  const place = list.findIndex((i) => i.node.id === 't');
  assert.ok(place > 4 && place < list.length - 5, `the tower is drawn among the stretches, at ${place} of ${list.length}`);
  const parts = list.filter((i): i is StrokeItem => i.kind === 'stroke').map((i) => i.part!);
  assert.ok(parts.every((p) => p !== undefined && p[1] > p[0]));
  // Together the parts are the whole line, each once.
  const along = [...parts].sort((a, b) => a[0] - b[0]);
  assert.equal(along[0]![0], 0);
  for (let i = 1; i < along.length; i++) assert.ok(Math.abs(along[i]![0] - along[i - 1]![1]) < 1e-6, `stretch ${i} starts where the one before it ends`);
  // Drawn as listed, a wall is one item with no part.
  const whole = (await items(town('wall first', {}))).filter((i): i is StrokeItem => i.kind === 'stroke');
  assert.ok(whole.length === 1 && whole[0]!.part === undefined);
});

test('sort: a wall drawn stretch by stretch looks as it does drawn whole, where its side turns over as well', async () => {
  // Each stretch draws the edges of its own piece of the side, so that a wall of many stretches costs as many
  // pieces, not as many whole walls; the stretches meet with no more than the smoothing of an edge between them.
  const wavy = stroke({ id: 'w', points: [[-300, 0], [-150, -80], [0, 0], [150, 80], [300, 0]], width: 12, color: 'light.snow', side: 'accent.coral', rise: 50 });
  const oval = stroke({ id: 'w', points: Array.from({ length: 48 }, (_, i) => [300 * Math.cos((Math.PI * i) / 24), 150 * Math.sin((Math.PI * i) / 24)] as [number, number]), closed: true, width: 12, color: 'light.snow', side: 'accent.coral', rise: 50 });
  for (const wall of [wavy, oval]) {
    const whole = await draw(make([wall]));
    const cut = await draw(make([group({ id: 'g', sort: 'depth', children: [wall] })]));
    assert.ok(differing(whole, cut, 60) < 60, `${differing(whole, cut, 60)} pixels differ`);
  }
});

test('sort: what it cannot do is refused', () => {
  assert.ok(refused(() => group({ id: 'g', sort: 'near' as 'depth', children: [] }), /sort must be "depth" \(the children are drawn far to near\)/));
  // A light that runs along a line needs the line in one piece.
  const wall = stroke({ id: 'w', points: [[-150, 0], [150, 0]], width: 10, color: 'light.snow', rise: 40 });
  const lit = (opts: object): ShotSpec => make([group({ id: 'g', ...opts, children: [wall] })], [pulse('w', { at: 1 })]);
  assert.ok(refused(() => compileShot(lit({ sort: 'depth' })), /pulse cannot target "w": it is a wall among children drawn far to near/));
  compileShot(lit({}));
});

test('sort: it is opt-in: a group without it is the data it was and draws its children as listed', async () => {
  const bare = group({ id: 'g', children: pair('near') });
  assert.ok(!('sort' in bare));
  assert.deepEqual({ ...group({ id: 'g', sort: 'depth', children: pair('near') }), sort: undefined }, { ...bare, sort: undefined });
  assert.deepEqual(await ids(make([bare])), ['near', 'far']);
});
