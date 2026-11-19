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
  reshape,
  reviewMotion,
  Rng,
  SceneError,
  shot,
  stroke,
  type Key,
  type LayerSpec,
  type ShotSpec,
  type Vec2,
} from '../src/index.ts';
import { firstCrossing, isRegion, outlineOf, REGION_MAX_FLAT_POINTS, REGION_MAX_POINTS, regionFault, regionShape, shapeExtent } from '../src/shape/geometry.ts';

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

// --- Outlines of many points --------------------------------------------------

/** A coast: `n` points round a middle, never crossing: a wavy ring with a little noise. */
function coast(n: number, seed = 5): Vec2[] {
  const rng = new Rng(seed, 'coast');
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    const r = 300 + 50 * Math.sin(5 * a) + rng.range(-1, 1);
    return [r * Math.cos(a), 0.8 * r * Math.sin(a)] as Vec2;
  });
}

/** The search the engine made before: every pair of pieces in turn. */
function everyPair(ring: readonly Vec2[]): [number, number] | null {
  const side = (p: Vec2, q: Vec2, r: Vec2): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const m = ring.length;
  for (let i = 0; i < m; i++) {
    for (let j = i + 2; j < m; j++) {
      if (i === 0 && j === m - 1) continue;
      const [a, b, c, d] = [ring[i]!, ring[(i + 1) % m]!, ring[j]!, ring[(j + 1) % m]!];
      const d1 = side(c, d, a);
      const d2 = side(c, d, b);
      const d3 = side(a, b, c);
      const d4 = side(a, b, d);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return [i, j];
    }
  }
  return null;
}

test('region: an outline may have 600 points; it is one shape as a small one is, and more points are refused', async () => {
  assert.equal(REGION_MAX_POINTS, 600);
  const big = coast(600);
  const spec = make([region({ id: 'r', points: big, fill: 'accent.pink', lit: false })]);
  const at = await reader(spec);
  assert.ok(pink(at(0, 0)) && pink(at(270, 0)) && pink(at(0, -170)), 'filled inside');
  assert.ok(!pink(at(380, 0)) && !pink(at(0, 300)) && !pink(at(-330, -230)), 'and nowhere else');
  // Its points are kept as they are given, as those of a small outline are.
  assert.deepEqual(regionShape(big, 1).points, big);
  assert.throws(() => region({ id: 'r', fill: 'accent.pink', points: coast(601) }), (e: unknown) => e instanceof SceneError && /region: at most 600 points, got 601/.test(e.message));
  // A crossing among that many points is found, and named by its two points.
  const knot = big.slice();
  [knot[100], knot[400]] = [knot[400]!, knot[100]!];
  assert.match(regionFault(knot, 0) ?? '', /^the outline crosses itself near point \d+ and point \d+$/);
  assert.throws(() => region({ id: 'r', fill: 'accent.pink', points: knot, smooth: 0 }), (e: unknown) => e instanceof SceneError && /region: the outline crosses itself near point 99 and point 400; move the points apart or lower smooth/.test(e.message));
});

test('region: drawn flat (lit: false), an outline may have 4000 points; a lit one keeps to 600, and says where more go', async () => {
  assert.equal(REGION_MAX_FLAT_POINTS, 4000);
  const big = coast(4000);
  const flat = { id: 'r', fill: 'accent.pink', smooth: 0, lit: false } as const;
  const wider = big.map(([x, y]) => [x * 1.2, y * 1.2] as Vec2);
  // It is one shape as a small one is, it changes its outline, and what is clipped to it shows inside it only.
  const spec = make([region({ ...flat, points: big })], [reshape('r', { at: 0.5, dur: 1, points: wider })]);
  const before = await reader(spec, 0);
  const after = await reader(spec, 120);
  assert.ok(pink(before(0, 0)) && pink(before(270, 0)) && pink(before(0, -170)), 'filled inside');
  assert.ok(!pink(before(330, 0)) && !pink(before(0, 300)) && !pink(before(-330, -230)), 'and nowhere else');
  assert.ok(pink(after(330, 0)) && !pink(after(380, 0)), 'the outline has grown by a fifth: 360 wide to the right');
  const clipped = await reader(make([region({ ...flat, fill: 'deep.ink', points: big }), circle({ id: 'dot', at: [300, 0], r: 60, fill: 'accent.pink', lit: false, clipTo: 'r' })]));
  assert.ok(pink(clipped(270, 0)) && !pink(clipped(330, 0)), 'the dot is seen up to the edge, at 300');
  // Its points are kept as they are given.
  assert.deepEqual(region({ ...flat, points: big }).shape, { kind: 'polygon', points: big, radius: 0, smooth: 0 });
  // More points are refused; and a lit region keeps to its own limit, since its light is cut out of the outline.
  const bad = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, (e: unknown) => e instanceof SceneError && message.test(e.message), String(message));
  };
  bad(() => region({ ...flat, points: coast(4001) }), /region\("r"\): region: at most 4000 points, got 4001$/);
  bad(() => region({ id: 'r', fill: 'accent.pink', smooth: 0, points: coast(601) }), /region\("r"\): region: at most 600 points, got 601; a region without the light \(lit: false\) takes up to 4000$/);
  bad(() => region({ id: 'r', fill: 'accent.pink', smooth: 0, lit: true, points: big }), /region: at most 600 points, got 4000; a region without the light \(lit: false\) takes up to 4000$/);
  // A crossing among that many points is found, and named by its two points.
  const knot = big.slice();
  [knot[100], knot[3000]] = [knot[3000]!, knot[100]!];
  assert.equal(regionFault(big, 0), null);
  bad(() => region({ ...flat, points: knot }), /region: the outline crosses itself near point \d+ and point \d+; move the points apart or lower smooth/);
  // A change of its outline is held to the points it has, not to the limit of a lit region.
  assert.throws(() => compileShot(make([region({ ...flat, points: big })], [reshape('r', { at: 0.5, dur: 1, points: wider.slice(1) })])), /reshape\("r"\) at 0\.5 s: the new outline has 3999 points, and "r" has 4000; give as many/);
});

test('region: the search for a crossing gives the answer that a search of every pair gives, and its work does not grow with the square of the points', () => {
  // Sound outlines and outlines that cross themselves, with straight and with curved runs, even and clustered.
  const rng = new Rng(11, 'rings');
  let crossing = 0;
  for (let k = 0; k < 1500; k++) {
    const n = rng.int(4, 90);
    const wild = k % 2 === 0;
    const near = k % 5 === 0;
    const ring = Array.from({ length: n }, (_, i) => {
      const a = (2 * Math.PI * i) / n;
      const r = wild ? rng.range(20, 400) : 300 + rng.range(-30, 30);
      // Every fifth outline is crowded into a corner, with one point far off.
      const shrink = near && i > 0 ? 0.001 : 1;
      return [shrink * (r * Math.cos(a) + (wild ? rng.range(-150, 150) : 0)), shrink * (r * Math.sin(a) + (wild ? rng.range(-150, 150) : 0))] as Vec2;
    });
    const want = everyPair(ring);
    assert.deepEqual(firstCrossing(ring), want, `outline ${k}`);
    if (want) crossing++;
  }
  assert.ok(crossing > 300 && crossing < 1200, `${crossing} of 1500 cross themselves`);
  // Pieces on one line, a line without width, and too few pieces to cross.
  assert.equal(firstCrossing([[0, 0], [100, 0], [200, 0], [300, 0], [200, 0], [100, 0]]), null);
  assert.equal(firstCrossing([[0, 0], [0, 100], [0, 300], [0, 200]]), null);
  assert.equal(firstCrossing([[0, 0], [100, 0], [0, 100]]), null);
  assert.deepEqual(firstCrossing([[0, 0], [100, 100], [100, 0], [0, 100]]), [0, 2]);

  // An outline at the limit, as the engine walks it (12 pieces to a point): the search of every pair holds 26
  // million pairs against each other, this one a few thousand. The better of five runs each, so that a busy
  // machine does not decide it.
  const ring: Vec2[] = [];
  const big = coast(600);
  for (let i = 0; i < 600; i++) {
    const [a, b] = [big[i]!, big[(i + 1) % 600]!];
    for (let k = 0; k < 12; k++) ring.push([a[0] + ((b[0] - a[0]) * k) / 12, a[1] + ((b[1] - a[1]) * k) / 12]);
  }
  const best = (run: () => unknown): number => {
    let ms = Infinity;
    for (let k = 0; k < 5; k++) {
      const from = performance.now();
      run();
      ms = Math.min(ms, performance.now() - from);
    }
    return ms;
  };
  assert.equal(firstCrossing(ring), null);
  const slow = best(() => everyPair(ring));
  const quick = best(() => firstCrossing(ring));
  assert.ok(quick < slow / 4, `the search took ${quick.toFixed(1)} ms, every pair ${slow.toFixed(1)} ms`);
});
