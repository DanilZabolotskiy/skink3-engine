import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec2 } from '../src/core/math.ts';
import { straightSkeleton, type SkeletonFace } from '../src/shape/skeleton.ts';

// The straight skeleton of an outline: what the hip of a roof on a free outline is built on. Every stretch of the
// outline moves in at one speed; each sweeps one face, and the faces together are the plan.

/** Twice the area of a face, seen from above: positive when it runs the way the outline does. */
const area = (f: SkeletonFace): number => {
  let a = 0;
  const m = f.points.length / 3;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    a += f.points[3 * i]! * f.points[3 * j + 1]! - f.points[3 * j]! * f.points[3 * i + 1]!;
  }
  return a;
};
const plan = (pts: readonly Vec2[]): number => pts.reduce((a, p, i) => a + p[0] * pts[(i + 1) % pts.length]![1] - pts[(i + 1) % pts.length]![0] * p[1], 0);
const times = (f: SkeletonFace): number[] => f.points.filter((_, i) => i % 3 === 2);

/** Outlines that run clockwise on screen (y down), as the outline of a shape does. */
const OUTLINES: Record<string, Vec2[]> = {
  rect: [[0, 0], [100, 0], [100, 60], [0, 60]],
  L: [[0, 0], [100, 0], [100, 40], [40, 40], [40, 100], [0, 100]],
  T: [[0, 0], [120, 0], [120, 30], [75, 30], [75, 100], [45, 100], [45, 30], [0, 30]],
  // A block and a lower one beside it, a step between them.
  steps: [[0, -50], [40, -50], [40, -30], [80, -30], [80, 0], [0, 0]],
  comb: [[0, 0], [200, 0], [200, 100], [170, 100], [170, 30], [130, 30], [130, 100], [100, 100], [100, 30], [60, 30], [60, 100], [30, 100], [30, 30], [0, 30]],
  oval: Array.from({ length: 40 }, (_, i) => [140 * Math.cos((Math.PI * i) / 20), 60 * Math.sin((Math.PI * i) / 20)] as Vec2),
  star: Array.from({ length: 14 }, (_, i) => [(i % 2 ? 40 : 100) * Math.cos((Math.PI * i) / 7), (i % 2 ? 40 : 100) * Math.sin((Math.PI * i) / 7)] as Vec2),
};

test('skeleton: each stretch of an outline sweeps one face, and the faces together are the plan', () => {
  for (const [name, pts] of Object.entries(OUTLINES)) {
    const s = straightSkeleton(pts);
    assert.ok(s, name);
    assert.deepEqual(s.faces.map((f) => f.edge).sort((a, b) => a - b), pts.map((_, i) => i), `${name}: a face to each stretch`);
    for (const f of s.faces) assert.ok(area(f) > 0, `${name}: face ${f.edge} runs the way the outline does`);
    const sum = s.faces.reduce((a, f) => a + area(f), 0);
    assert.ok(Math.abs(sum - plan(pts)) < 1e-6 * plan(pts), `${name}: the faces cover the plan once (${sum} of ${plan(pts)})`);
    // A face starts on its stretch, at time 0, and rises no higher than the deepest point; the time of each of its
    // points is how far that point lies in from the stretch.
    for (const f of s.faces) {
      const [a, b] = [pts[f.edge]!, pts[(f.edge + 1) % pts.length]!];
      assert.deepEqual(f.points.slice(0, 6), [a[0], a[1], 0, b[0], b[1], 0]);
      assert.ok(Math.max(...times(f)) <= s.depth + 1e-9);
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let i = 0; i < f.points.length; i += 3) {
        const inward = ((f.points[i]! - a[0]) * -(b[1] - a[1]) + (f.points[i + 1]! - a[1]) * (b[0] - a[0])) / l;
        assert.ok(Math.abs(inward - f.points[i + 2]!) < 1e-6, `${name}: face ${f.edge}, point ${i / 3} is ${inward} in at time ${f.points[i + 2]}`);
      }
    }
  }
});

test('skeleton: a rectangle has a ridge half its width in, and two wings meet in a valley', () => {
  const rect = straightSkeleton(OUTLINES['rect']!)!;
  assert.equal(rect.depth, 30);
  // The long sides are trapezoids up to the ridge, the short ones triangles: the hip ends.
  assert.deepEqual(rect.faces.map((f) => f.points.length / 3).sort(), [3, 3, 4, 4]);
  const ridge = rect.faces.flatMap((f) => [...f.points].filter((_, i) => i % 3 === 2)).filter((t) => t === 30).length;
  assert.ok(ridge >= 4, 'the ends of the ridge are on four faces');
  // An L: its inner corner runs to the place where the ridges of the two wings meet.
  const L = straightSkeleton(OUTLINES['L']!)!;
  assert.equal(L.depth, 20);
  // The steps: a block 40 by 50 and a lower one 40 by 30 beside it. The low one closes first, 15 in, where two of its
  // stretches run against each other; the rest of the outline moves on, and the high one closes 20 in.
  assert.ok(Math.abs(straightSkeleton(OUTLINES['steps']!)!.depth - 20) < 1e-9);
  const inner = L.faces.filter((f) => f.edge === 2 || f.edge === 3);
  for (const f of inner) assert.ok(f.points.some((v, i) => i % 3 === 0 && Math.abs(v - 20) < 1e-9 && Math.abs(f.points[i + 1]! - 20) < 1e-9), `face ${f.edge} reaches (20, 20)`);
});

test('skeleton: with stop the outline stops moving there, and what is left is a flat top', () => {
  const s = straightSkeleton(OUTLINES['L']!, 8)!;
  assert.equal(s.depth, 8);
  const tops = s.faces.filter((f) => f.edge < 0);
  assert.equal(tops.length, 1);
  assert.ok(times(tops[0]!).every((t) => t === 8));
  const sum = s.faces.reduce((a, f) => a + area(f), 0);
  assert.ok(Math.abs(sum - plan(OUTLINES['L']!)) < 1e-6 * plan(OUTLINES['L']!));
  // Past the deepest point a stop changes nothing.
  assert.deepEqual(straightSkeleton(OUTLINES['L']!, 50), straightSkeleton(OUTLINES['L']!));
});

test('skeleton: an outline it cannot take gives none', () => {
  assert.equal(straightSkeleton([[0, 0], [10, 0]]), null, 'two points');
  assert.equal(straightSkeleton([[0, 0], [10, 0], [10, 0], [0, 10]]), null, 'a stretch without length');
});
