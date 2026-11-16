import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  evaluate,
  frameRaw,
  label,
  layer,
  levelTo,
  moveTo,
  pathTable,
  polygon,
  region,
  reviewMotion,
  SceneError,
  shot,
  stroke,
  type Key,
  type LayerSpec,
  type ShotSpec,
  type Vec2,
} from '../src/index.ts';
import { isRegion, outlineOf, shapeExtent } from '../src/shape/geometry.ts';

// A region: a free-form closed outline through points, concave allowed, as one shape.

const WIDTH = 960;

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], seconds = 3): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 3,
    palette,
    strings: { en: { 'label.a': 'A' } },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    light: { from: 'top-left' },
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

/** The colour of the picture at a place of the stage, at a frame. */
async function reader(spec: ShotSpec, frame = 0): Promise<(x: number, y: number) => [number, number, number]> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
  return (x, y) => {
    const o = (Math.round((y + 540) * (WIDTH / 1920)) * WIDTH + Math.round((x + 960) * (WIDTH / 1920))) * 4;
    return [raw[o]!, raw[o + 1]!, raw[o + 2]!];
  };
}

const pink = ([r, g, b]: [number, number, number]): boolean => r > 200 && g < 140 && b > 120;

/** A "C": a square of 400 with a bay cut into its right side. Given clockwise on screen. */
const C: Vec2[] = [[-200, -200], [200, -200], [200, -100], [-50, -100], [-50, 100], [200, 100], [200, 200], [-200, 200]];

function inside(poly: readonly Vec2[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

test('region: a concave outline through its points is one shape, filled inside and nowhere else', async () => {
  const node = region({ id: 'c', points: C, fill: 'accent.pink', smooth: 0, lit: false });
  assert.equal(node.type, 'shape');
  // It is kept as a polygon with a `smooth`: the kinds of shape are the four they were.
  assert.deepEqual([node.shape.kind, isRegion(node.shape), isRegion(node.shape) && node.shape.smooth, isRegion(node.shape) && node.shape.points, isRegion(node.shape) && node.shape.radius], ['polygon', true, 0, C, 0]);
  // Given the other way round, the points are kept clockwise on screen.
  const reversed = region({ id: 'c', points: [...C].reverse(), fill: 'accent.pink', smooth: 0 }).shape;
  assert.deepEqual(isRegion(reversed) && reversed.points, C);
  const smooth = region({ id: 'c', points: [[0, 0], [100, 0], [0, 100]], fill: 'accent.pink' }).shape;
  assert.equal(isRegion(smooth) && smooth.smooth, 1, 'smooth by default');
  // A polygon made as a polygon is none: it has no `smooth` at all.
  const convex = polygon({ id: 'p', fill: 'accent.pink', points: [[0, 0], [100, 0], [0, 100]] }).shape;
  assert.ok(!isRegion(convex) && !('smooth' in convex));

  // The picture: its arms and its back are filled, its bay is not, and nothing beyond it.
  const at = await reader(make([node]));
  for (const [x, y] of [[-150, 0], [0, -150], [150, -150], [0, 150], [150, 150], [-190, -190]] as const) assert.ok(pink(at(x, y)), `filled at ${x}, ${y}`);
  for (const [x, y] of [[50, 0], [190, 0], [-40, 0], [0, 90], [230, 0], [0, -230], [-230, 0]] as const) assert.ok(!pink(at(x, y)), `empty at ${x}, ${y}`);

  // With straight edges a stroke through the same points lies on its edge; smoothed, both follow the same curve.
  for (const s of [0, 0.5, 1]) {
    const shape = region({ id: 'c', points: C, fill: 'accent.pink', smooth: s }).shape;
    const table = pathTable(stroke({ id: 's', points: C, closed: true, smooth: s, color: 'mid.mist' }).path);
    for (const p of outlineOf(shape)) {
      // The distance to the path: to the nearest of its pieces between two samples.
      let best = Infinity;
      for (let i = 1; i < table.xs.length; i++) {
        const [ax, ay, bx, by] = [table.xs[i - 1]!, table.ys[i - 1]!, table.xs[i]!, table.ys[i]!];
        const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
        const u = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / len2)) : 0;
        best = Math.min(best, Math.hypot(ax + (bx - ax) * u - p[0], ay + (by - ay) * u - p[1]));
      }
      assert.ok(best < 0.5, `smooth ${s}: an outline point is ${best} from the path of the stroke`);
    }
  }
  // Smoothed, the outline is a curve through the points: it bulges past the straight edge between two of them.
  const round = await reader(make([region({ id: 'c', points: C, fill: 'accent.pink', smooth: 1, lit: false })]));
  assert.ok(pink(round(-230, 0)) && !pink(at(-230, 0)) && pink(round(-150, 0)) && !pink(round(60, 0)));
});

test('region: its middle is inside it, it is lit as one shape, and a label, a clip and a level use its outline', async () => {
  // The middle of a concave shape is the middle of the largest circle that fits in it: inside it, not in its bay.
  const shape = region({ id: 'c', points: C, fill: 'accent.pink', smooth: 0 }).shape;
  const ext = shapeExtent(shape);
  assert.ok(inside(outlineOf(shape), ext.center[0], ext.center[1]), `its middle ${ext.center} is inside`);
  assert.ok(ext.center[0] < -50 && Math.abs(ext.inner - 75) < 6, `the back of the C is 150 wide: a circle of ${ext.inner} fits, at ${ext.center}`);
  assert.ok(ext.outer > 300 && ext.outer < 480, `${ext.outer}`);
  // A convex region: the middle of a square.
  const square = shapeExtent(region({ id: 'q', points: [[-100, -100], [100, -100], [100, 100], [-100, 100]], fill: 'accent.pink', smooth: 0 }).shape);
  assert.ok(Math.hypot(square.center[0], square.center[1]) < 6 && Math.abs(square.inner - 100) < 6);

  // Lit: one shadow on the side away from the light, across the whole form, and none on the lit side.
  const lit = await reader(make([region({ id: 'c', points: C, fill: 'accent.pink', smooth: 0 })]));
  const flat = await reader(make([region({ id: 'c', points: C, fill: 'accent.pink', smooth: 0, lit: false })]));
  const darker = (x: number, y: number): boolean => lit(x, y)[0] < flat(x, y)[0] - 25;
  assert.ok(darker(190, 190) && darker(190, -110) && darker(-60, 0), 'shadow along its lower and right edges, in the bay too');
  assert.ok(!darker(-150, -100) && !darker(0, -150), 'none in the body of the shape on the lit side');

  // A label points at its upper edge.
  const c = compileShot(make([region({ id: 'c', at: [0, 50], points: C, fill: 'accent.pink', smooth: 0 }), label({ id: 'l', text: 'label.a', target: 'c', fill: 'light.cream', ink: 'deep.abyss', gap: 10 })]));
  const tip = evaluate(c, await bakeShot(c), 0, 'en').layers[0]!.items.find((i) => i.kind === 'label');
  assert.ok(tip && tip.kind === 'label' && Math.abs(tip.tip[1] + 160) < 1.5, 'ten units above its top, which is at -150');
  // What is clipped to it shows only inside it: not in the bay.
  const clipped = await reader(make([region({ id: 'c', points: C, fill: 'deep.ink', smooth: 0, lit: false }), circle({ id: 'dot', r: 180, fill: 'accent.pink', lit: false, clipTo: 'c' })]));
  assert.ok(pink(clipped(-120, 0)) && pink(clipped(0, -150)) && !pink(clipped(50, 0)) && !pink(clipped(100, 0)));
  // A level fills it from the bottom.
  const filling = make([region({ id: 'c', points: C, fill: 'accent.pink', smooth: 0, lit: false, level: 0.25 })], [levelTo('c', { at: 0.5, to: 0.75, dur: 1 })]);
  const low = await reader(filling, 0);
  const high = await reader(filling, 150);
  assert.ok(pink(low(-150, 150)) && !pink(low(-150, 50)) && !pink(low(0, -150)), 'a quarter full: its lower arm');
  assert.ok(pink(high(-150, -50)) && !pink(high(0, -150)), 'three quarters full: up to the middle of its upper arm');
});

test('region: what it refuses, and that the other shapes are what they were', async () => {
  const bad = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, (e: unknown) => e instanceof SceneError && message.test(e.message), String(message));
  };
  const base = { id: 'r', fill: 'accent.pink' } as const;
  bad(() => region({ ...base, points: [[0, 0], [100, 0]] }), /region: at least 3 points are required/);
  bad(() => region({ ...base, points: [[0, -100], [59, 81], [-95, -31], [95, -31], [-59, 81]], smooth: 0 }), /region: the outline crosses itself near point \d+ and point \d+; move the points apart or lower smooth/);
  bad(() => region({ ...base, points: [[0, 0], [100, 0], [200, 0]], smooth: 0 }), /region: the points enclose no area/);
  bad(() => region({ ...base, points: [[0, 0], [0, 0], [100, 0], [0, 100]] }), /region: two neighbouring points coincide/);
  bad(() => region({ ...base, points: C, smooth: 2 }), /smooth must be a number in 0\.\.1/);
  bad(() => region({ ...base, points: C, radius: 8 } as never), /region\("r"\): unknown option "radius"/);
  bad(() => region({ ...base, points: C, body: { kind: 'fixed' } }), /region\("r"\): a region cannot be a rigid body/);
  bad(() => region({ ...base, points: [[0, 0], [1]] as never }), /points\[1\] must be \[x, y\]/);
  // A polygon is still convex, and says where a concave form goes now.
  bad(() => polygon({ id: 'p', fill: 'accent.pink', points: C }), /corners must form a convex polygon/);

  // The motion review knows a region as a shape: one speed from rest to rest is found.
  const cs = compileShot(make([region({ id: 'r', points: C, fill: 'accent.pink', smooth: 0.5, scale: 0.5 })], [moveTo('r', { at: 0.5, to: [0, 250], dur: 1.5, profile: 'steady', arc: 0 })]));
  const kinds = reviewMotion(cs, await bakeShot(cs)).report.findings.filter((f) => f.subject === 'r').map((f) => f.kind);
  assert.ok(kinds.some((k) => k === 'mechanical' || k === 'abrupt-start'), kinds.join(', '));
});
