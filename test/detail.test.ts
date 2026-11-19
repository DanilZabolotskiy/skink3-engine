import assert from 'node:assert/strict';
import { test } from 'node:test';
import { circle, compileShot, group, rect, region, riseTo, stroke, type LayerSpec, type SceneNode, type ShapeItem, type ShotSpec } from '../src/index.ts';
import { seenRuns, SIDE_TOLERANCE, sideRing } from '../src/shape/solid.ts';
import { amber, at, dark, differing, draw, items, make, pale, red, refused } from './fixtures/bodies.ts';

// Level of detail: a group that says detail: { min } draws a body that is smaller on screen than min plain (its top
// alone), and the side of every other body as one outline with the corners that can be told on screen.

/** A body of 100 by 60 units, 40 high: 100 units across on screen at scale 1. */
const small = (extra: object = {}): LayerSpec['nodes'] => [rect({ id: 'b', w: 100, h: 60, radius: 0, fill: 'light.snow', lit: false, side: 'accent.coral', rise: 40, ...extra })];

const inGroup = (opts: object, children: LayerSpec['nodes']): ShotSpec => make([group({ id: 'g', ...opts, children })]);

/** The body "b" of a frame as it is drawn. */
async function drawn(spec: ShotSpec, frame = 0): Promise<{ plain: boolean | undefined; unit: number | undefined; foot: boolean }> {
  const item = (await items(spec, frame)).find((i) => i.node.id === 'b')!;
  const detail = (item as ShapeItem).detail;
  return { plain: detail?.plain, unit: detail?.unit, foot: 'foot' in item && item.foot !== undefined };
}

test('detail: a body smaller on screen than min is drawn plain: its top alone, where it stands raised, in its own fill', async () => {
  const dressed = { openings: { width: 10, height: 20, step: 20, color: 'accent.amber' } } as const;
  const cast = { color: 'accent.aqua', opacity: 1, dir: 0, length: 1 } as const;
  // 100 units across: under a min of 120 it is plain.
  const plain = inGroup({ detail: { min: 120 }, cast }, small(dressed));
  const raw = await draw(plain);
  assert.ok(pale(at(raw, 0, -65)) && pale(at(raw, 0, -15)), 'the top, 40 units up the screen');
  assert.ok(dark(at(raw, 0, 0)) && dark(at(raw, 0, 20)), 'no side and no openings');
  assert.ok(dark(at(raw, 70, 0)), 'no shadow');
  assert.deepEqual(await drawn(plain), { plain: true, unit: 1, foot: false });
  assert.deepEqual((await items(plain)).map((i) => i.kind), ['shape'], 'a group whose bodies are all plain draws no shadows');
  // A roof is detail too: the plain body is its flat top.
  const roofed = await draw(inGroup({ detail: { min: 120 } }, small({ roof: { kind: 'gable', height: 30 } })));
  assert.ok(pale(at(roofed, 0, -65)) && pale(at(roofed, 0, -15)) && dark(at(roofed, 0, -85)) && dark(at(roofed, 0, 0)));

  // At a min of 80 it is drawn in full.
  const full = inGroup({ detail: { min: 80 }, cast }, small(dressed));
  const whole = await draw(full);
  assert.ok(pale(at(whole, 0, -40)) && amber(at(whole, 0, 0)) && red(at(whole, 0, 20)) && !dark(at(whole, 70, 0)));
  assert.deepEqual(await drawn(full), { plain: false, unit: 1, foot: true });
});

test('detail: the size is that on screen, of the outline across or of the height, whichever is more', async () => {
  // Half the scale, half the size.
  assert.deepEqual(await drawn(make([group({ id: 'g', scale: 0.5, detail: { min: 80 }, children: small() })])), { plain: true, unit: 0.5, foot: false });
  assert.deepEqual(await drawn(make([group({ id: 'g', scale: 2, detail: { min: 180 }, children: small() })])), { plain: false, unit: 2, foot: true });
  // A thin tower counts by its height, and becomes a body in full as it rises past min.
  const tower = inGroup({ detail: { min: 80 } }, [rect({ id: 'b', w: 20, h: 20, fill: 'light.snow', rise: 0 })]);
  const rising: ShotSpec = { ...tower, timeline: [riseTo('b', { at: 0, to: 160, dur: 2 })] };
  assert.equal((await drawn(rising, 30)).plain, true);
  assert.equal((await drawn(rising, 60)).plain, false, 'half-way up it is 80 high');
  assert.equal((await drawn(rising, 119)).plain, false);
  // The nearest group that says detail decides; a shape that lies flat is no body, and is the item it was.
  const nested = make([group({ id: 'outer', detail: { min: 120 }, children: [group({ id: 'inner', detail: { min: 0 }, children: small() })] })]);
  assert.equal((await drawn(nested)).plain, false);
  assert.deepEqual(await drawn(inGroup({ detail: { min: 120 } }, [rect({ id: 'b', w: 100, h: 60, fill: 'light.snow' })])), { plain: undefined, unit: undefined, foot: false });
});

test('detail: in a plane of a perspective layer the far bodies are plain and the near ones in full', async () => {
  const two: LayerSpec['nodes'] = [
    rect({ id: 'far', at: [0, -600], w: 100, h: 60, fill: 'light.snow', rise: 40 }),
    rect({ id: 'near', at: [0, 300], w: 100, h: 60, fill: 'accent.aqua', rise: 40 }),
  ];
  const floor = (min: number): ShotSpec => make([group({ id: 'floor', at: [0, 0, 0], plane: 'floor', children: [group({ id: 'g', detail: { min }, children: two })] })], [], { perspective: { tilt: 50 } });
  const plains = async (min: number): Promise<(boolean | undefined)[]> => (await items(floor(min))).map((i) => (i as ShapeItem).detail?.plain);
  // The far body is about 64 units across on screen, the near one about 108.
  assert.deepEqual(await plains(0), [false, false]);
  assert.deepEqual(await plains(80), [true, false]);
  assert.deepEqual(await plains(120), [true, true]);
});

test('detail: a wall that is too small is a flat line', async () => {
  const wall = (min: number): ShotSpec => inGroup({ detail: { min } }, [stroke({ id: 'b', points: [[-100, 0], [100, 0]], width: 10, color: 'light.snow', side: 'accent.coral', rise: 60 })]);
  // A wall is as large as it is high: 60 units here.
  assert.equal((await drawn(wall(40))).foot, true);
  assert.equal((await drawn(wall(80))).foot, false);
  const raw = await draw(wall(80));
  assert.ok(pale(at(raw, 0, -60)) && dark(at(raw, 0, -30)), 'the line at its height, and no side under it');
  assert.ok(red(at(await draw(wall(40)), 0, -30)));
});

test('detail: a body drawn in full looks as it did without detail, but for the rim of its side', async () => {
  // Sixty bodies: round ones, turned ones, with round and with sharp corners.
  const many: SceneNode[] = [];
  for (let i = 0; i < 60; i++) {
    const place: [number, number] = [-700 + (i % 10) * 150, -400 + Math.floor(i / 10) * 150];
    many.push(
      i % 3 === 0
        ? circle({ id: `c${i}`, at: place, r: 40, fill: 'accent.aqua', side: 'accent.coral', rise: 30 + i })
        : rect({ id: `r${i}`, at: place, rotation: i * 7, w: 90, h: 50, fill: 'light.snow', side: 'accent.amber', rise: 20 + i, ...(i % 2 ? { radius: 0 } : {}) }),
    );
  }
  const floor = (opts: object): LayerSpec['nodes'] => [group({ id: 'floor', at: [0, 0, 0], plane: 'floor', children: [group({ id: 'g', ...opts, children: many })] })];
  const views: [string, (opts: object) => ShotSpec][] = [
    ['a flat layer', (opts) => make([group({ id: 'g', ...opts, children: many })])],
    ['a plane', (opts) => make(floor(opts), [], { perspective: { tilt: 55, turn: 20 } })],
    // Here the camera stands among the bodies, and some of them reach behind it.
    ['a plane with the camera among the bodies', (opts) => make(floor(opts), [], { perspective: { tilt: 70, turn: 20, distance: 400 } })],
  ];
  for (const [name, view] of views) {
    const before = await draw(view({}));
    const after = await draw(view({ detail: { min: 0 } }));
    const pixels = before.length / 4;
    // Only anti-aliased pixels along the rims may differ.
    const rim = differing(before, after, 32);
    assert.ok(rim < pixels / 2000, `${name}: ${rim} of ${pixels} pixels differ by more than an eighth of the range`);
    assert.ok(differing(before, after, 96) === 0, `${name}: none differs by much`);
  }
});

test('detail: the outline of a side has the corners that can be told on screen, and only the stretches turned to the viewer are drawn', () => {
  // A rect with sharp corners: four corners, whatever its size, and no bay.
  const box = rect({ id: 'b', w: 100, h: 60, radius: 0, fill: 'light.snow' }).shape;
  const ring = sideRing(box);
  assert.equal(ring.points.length, 4);
  assert.equal(ring.convex, true);
  assert.equal(sideRing(box, 0.01).points.length, 4);
  // A circle: fewer corners the smaller it is on screen, never off by more than the tolerance, and the same object for the same size.
  const round = circle({ id: 'c', r: 50, fill: 'light.snow' }).shape;
  const every = sideRing(round).points.length;
  const large = sideRing(round, 4);
  const little = sideRing(round, 0.05);
  assert.ok(every > 60 && large.points.length <= every && little.points.length < large.points.length && little.points.length >= 3, `${every}, ${large.points.length}, ${little.points.length}`);
  assert.equal(sideRing(round, 4), large);
  for (const [unit, thin] of [[4, large], [0.05, little]] as const) {
    for (const p of thin.points) assert.ok(Math.abs(Math.hypot(p[0], p[1]) - 50) * unit <= SIDE_TOLERANCE, 'a corner that is kept is a point of the outline');
    // The middle of a stretch is the farthest it is from the circle.
    const n = thin.points.length;
    for (let i = 0; i < n; i++) {
      const a = thin.points[i]!;
      const b = thin.points[(i + 1) % n]!;
      assert.ok((50 - Math.hypot((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) * unit <= SIDE_TOLERANCE * 1.01, `a stretch of ${n} is within the tolerance at ${unit}`);
    }
  }
  // An outline with a bay.
  const bay = region({ id: 'r', points: [[0, 0], [100, 0], [100, 100], [70, 100], [70, 40], [30, 40], [30, 100], [0, 100]], smooth: 0, fill: 'light.snow' }).shape;
  assert.equal(sideRing(bay).convex, false);
  assert.equal(sideRing(bay).points.length, 8);

  // Which stretches are seen: the foot of a point p of the top stands at k p + (x, y).
  const count = (runs: number[]): number => runs.reduce((sum, v, i) => (i % 2 ? sum + v : sum), 0);
  // In a flat layer the foot is straight down the screen: one stretch of the box, the near one.
  assert.equal(count(seenRuns(ring, { k: 1, x: 0, y: 40 })), 1);
  // Down and to the side: two stretches, in one run.
  const two = seenRuns(ring, { k: 1, x: 30, y: 40 });
  assert.deepEqual([two.length, count(two)], [2, 2]);
  // In a plane, seen from straight above, the foot is smaller and lies under the top: no stretch is seen.
  assert.deepEqual(seenRuns(ring, { k: 0.8, x: 0, y: 0 }), []);
  // The outline with the bay, seen from the side the bay opens to: the feet of its two arms and the end of the bay,
  // three runs of one stretch. From a little to the side, the walls that face that way join them: two runs, five stretches.
  const open = seenRuns(sideRing(bay), { k: 1, x: 0, y: 40 });
  assert.deepEqual([open.length, count(open)], [6, 3]);
  const aside = seenRuns(sideRing(bay), { k: 1, x: 20, y: 40 });
  assert.deepEqual([aside.length, count(aside)], [4, 5]);
});

test('detail: what it cannot be is refused', () => {
  const g = (detail: object): unknown => group({ id: 'g', detail: detail as never, children: [] });
  assert.ok(refused(() => g({}), /detail needs min: the size on screen, in units of the stage, below which a body is drawn plain/));
  assert.ok(refused(() => g({ min: -1 }), /detail\.min must be a number in 0\.\.200/));
  assert.ok(refused(() => g({ min: 500 }), /detail\.min must be a number in 0\.\.200/));
  assert.ok(refused(() => g({ min: 4, far: 2 }), /unknown option "far"/));
});

test('detail: it is opt-in: a group without it is the data it was, and its bodies are the items they were', async () => {
  const bare = group({ id: 'g', children: small() });
  assert.ok(!('detail' in bare));
  assert.deepEqual({ ...group({ id: 'g', detail: { min: 4 }, children: small() }), detail: undefined }, { ...bare, detail: undefined });
  assert.equal(compileShot(make([bare])).detail, null);
  const item = (await items(make([bare])))[0]!;
  assert.ok(!('detail' in item) && 'foot' in item);
});
