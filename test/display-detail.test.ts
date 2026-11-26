import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  compileShot,
  evaluate,
  fadeTo,
  frameRaw,
  group,
  layer,
  moveTo,
  rect,
  region,
  shot,
  stroke,
  text,
  type SceneNode,
} from '../src/index.ts';
import { pathAt, pathTable } from '../src/motion/paths.ts';
import { displayPlan } from '../src/render/detail.ts';
import { drawState } from '../src/render/frame.ts';
import { heldFrame } from '../src/render/holds.ts';
import { projectedLine } from '../src/render/projected-line.ts';
import type { Item } from '../src/scene/evaluate.ts';
import type { Vec2 } from '../src/core/math.ts';

const opts = { width: 320, lang: 'en', gpu: false };
const tile = (id: string, x: number, y: number) =>
  rect({
    id,
    at: [x, y],
    w: 26,
    h: 25,
    radius: 0,
    fill: 'accent.amber',
    lit: false,
  });
function planeScene(children: SceneNode[], motion: ReturnType<typeof moveTo>[] = []) {
  return shot({
    id: 'buildings',
    seconds: 2.5,
    seed: 9,
    palette,
    strings: { en: { title: 'On the map' } },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [
      layer({
        id: 'surface',
        depth: 0,
        perspective: true,
        nodes: [group({ id: 'plane', plane: 'wall', children })],
      }),
    ],
    timeline: motion,
  });
}
const matrix = {
  m11: 2,
  m12: 0,
  m14: 0.001,
  m21: 0,
  m22: 1.4,
  m24: 0.0002,
  m41: 230,
  m42: 41,
  m44: 1,
};
test('the original arc-length interval is drawn within a quarter pixel through a perspective', () => {
  const table = pathTable({
    points: [
      [-90, 15],
      [-40, 18],
      [5, -40],
      [82, 20],
      [100, 5],
    ],
    smooth: 1,
    closed: false,
  });
  const result: Vec2[] = [];
  const lo = table.length * 0.17,
    hi = table.length * 0.86;
  projectedLine(table, lo, hi, matrix, (x, y) => result.push([x, y]));
  assert.deepEqual(result[0], [pathAt(table, lo).x, pathAt(table, lo).y]);
  assert.deepEqual(result.at(-1), [pathAt(table, hi).x, pathAt(table, hi).y]);
  const project = ([x, y]: Vec2): Vec2 => [
    (2 * x + 230) / (1 + 0.001 * x + 0.0002 * y),
    (1.4 * y + 41) / (1 + 0.001 * x + 0.0002 * y),
  ];
  const visible = result.map(project);
  for (let i = 0; i < table.cum.length; i++) {
    if (table.cum[i]! <= lo || table.cum[i]! >= hi) continue;
    const [u, v] = project([table.xs[i]!, table.ys[i]!]);
    let least = Infinity;
    for (let j = 1; j < visible.length; j++) {
      const [a, b] = visible[j - 1]!,
        [c, d] = visible[j]!,
        dx = c - a,
        dy = d - b;
      const t = Math.max(0, Math.min(1, ((u - a) * dx + (v - b) * dy) / (dx * dx + dy * dy || 1)));
      least = Math.min(least, Math.hypot(u - a - t * dx, v - b - t * dy));
    }
    assert.ok(least <= 0.25000001);
  }
  assert.ok(result.length < table.cum.length / 2);
  const all: Vec2[] = [];
  projectedLine(table, 0, table.length, { ...matrix, m14: 0, m24: 0, m44: -1 }, (x, y) => all.push([x, y]));
  assert.equal(all.length, table.xs.length);
});

test('held colour ranges preserve their actual pixels, live sibling and markers over independent chunks', async () => {
  const cells = Array.from({ length: 400 }, (_, i) => tile('tile-' + i, ((i % 20) - 10) * 32, (Math.floor(i / 20) - 10) * 32));
  const moving = tile('actor', 0, 0);
  const model = planeScene(
    [
      group({
        id: 'assembly',
        at: [5, -8],
        children: [...cells.slice(0, 200), moving, ...cells.slice(200)],
      }),
    ],
    [moveTo('actor', { at: 0.2, to: [160, 30], dur: 1.8 })],
  );
  const c = compileShot(model),
    bake = await bakeShot(c),
    held = heldFrame(c, bake, 24, opts)!;
  assert.equal(held.ranges.length, 2);
  const live = evaluate(held.view, bake, 24, 'en').layers[0]!.items;
  const visit = (items: readonly Item[]): number =>
    items.reduce(
      (total, item) => total + ('items' in item ? visit(item.items) : 0) + (item.kind === 'group' && item.retained ? 1 : 0),
      0,
    );
  assert.equal(visit(live), 2);
  assert.equal(c.nodes.length, 403);
  assert.equal(c.spec, model);
  const full = drawState(c, evaluate(c, bake, 24, 'en'), opts);
  let original: Buffer;
  try {
    original = full.canvas.toBufferSync('raw', {
      colorType: 'rgba',
      msaa: false,
    });
  } finally {
    full.dispose();
  }
  const initial = await frameRaw(c, bake, 24, opts);
  const large = initial.reduce((sum, value, i) => sum + (Math.abs(value - original[i]!) > 6 ? 1 : 0), 0);
  assert.ok(large < initial.length / 150, 'held colours and the moving actor remain drawn over the background');
  await frameRaw(c, bake, 109, opts);
  const again = await frameRaw(c, bake, 24, opts),
    fresh = compileShot(model);
  assert.deepEqual(again, initial);
  assert.deepEqual(await frameRaw(fresh, bake, 24, opts), initial);
  assert.ok(heldFrame(c, bake, 76, opts)!.ranges.every((r) => r.anchor === 0));
});

test('screen detail leaves the public compiled graph and explicitly animated thin marks intact', () => {
  const strokes = Array.from({ length: 404 }, (_, i) =>
    stroke({
      id: 'mark-' + i,
      points: [
        [i % 70, Math.floor(i / 70) * 10],
        [(i % 70) + 2, Math.floor(i / 70) * 10 + 1],
      ],
      width: 1,
      opacity: 0.12,
      color: 'accent.amber',
    }),
  );
  const base = planeScene([group({ id: 'marks', children: strokes })]);
  const c = compileShot({
    ...base,
    timeline: [fadeTo('mark-3', { at: 0.3, to: 0.2, dur: 0.2 })],
  });
  const p = displayPlan(c, 1920);
  assert.ok(p.marks > 300);
  assert.equal(p.view.inkSize![c.byId.get('mark-3')!.index], 0);
  assert.deepEqual(
    p.view.nodes.map((n) => n.id),
    c.nodes.map((n) => n.id),
  );
  assert.equal(c.inkSize, undefined);
  assert.equal(c.byId, p.view.byId);
  assert.equal(c.spec, p.view.spec);
});

test('a long projected clip matches the explicit alpha mask, including the animated content behind its edge', async () => {
  const ring: Vec2[] = Array.from({ length: 128 }, (_, i) => {
    const turn = (Math.PI * 2 * i) / 128;
    return [Math.cos(turn) * 270, Math.sin(turn) * 190];
  });
  const render = async (explicit: boolean) => {
    const coast = region({
      id: 'boundary',
      points: ring,
      smooth: 0,
      fill: 'mid.mist',
      opacity: 0,
      lit: false,
      ...(explicit ? { clipMask: true } : {}),
    });
    const band = rect({
      id: 'band',
      w: 620,
      h: 140,
      fill: 'accent.amber',
      lit: false,
      clipTo: 'boundary',
    });
    const c = compileShot(planeScene([coast, band], [moveTo('band', { at: 0, dur: 1.5, to: [100, 65] })]));
    const bake = await bakeShot(c);
    return Promise.all([0, 21, 42].map((f) => frameRaw(c, bake, f, opts)));
  };
  const a = await render(false),
    b = await render(true);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a[0], a[2]);
});

test('a dense colour plane uses one fixed grid across independent holds and keeps text planes at delivery size', async () => {
  const cells = Array.from({ length: 1540 }, (_, i) =>
    stroke({
      id: 'texture-' + i,
      points: [
        [(i % 70) * 6 - 200, Math.floor(i / 70) * 8 - 100],
        [(i % 70) * 6 - 197, Math.floor(i / 70) * 8 - 99],
      ],
      width: 1,
      color: 'accent.amber',
      opacity: 0.16,
    }),
  );
  const wrapped = group({ id: 'texture', children: cells });
  const spec = planeScene([wrapped, tile('pin', 4, 2)]);
  const c = compileShot(spec),
    full = { ...opts, width: 960 };
  const view = displayPlan(c, 960).view,
    root = c.byId.get('plane')!;
  assert.equal(view.nodes[root.index]!.pictureScale, 0.625);
  const bake = await bakeShot(c),
    raw = await frameRaw(c, bake, 26, full);
  const held = heldFrame(view, bake, 26, full)!;
  assert.ok(held.images.size > 0);
  for (const image of held.images.values()) assert.equal(image.width, 600);
  assert.deepEqual(await frameRaw(compileShot(spec), bake, 73, full), raw);
  const base = planeScene([wrapped, text({ id: 'caption', text: 'title', ink: 'accent.amber' })]);
  const withText = compileShot(base);
  assert.equal(displayPlan(withText, 960).view.nodes[root.index]!.pictureScale, undefined);
  const subject = group({
    id: 'subject-plane',
    plane: 'wall',
    children: Array.from({ length: 1540 }, (_, i) => tile('subject-' + i, i % 40, Math.floor(i / 40))),
  });
  const together = compileShot({ ...spec, layers: [{ ...spec.layers[0]!, nodes: [...spec.layers[0]!.nodes, subject] }] });
  const work = displayPlan(together, 960).view;
  assert.equal(work.nodes[together.byId.get('plane')!.index]!.pictureScale, 0.625);
  assert.equal(work.nodes[together.byId.get('subject-plane')!.index]!.pictureScale, undefined);
  assert.equal(displayPlan(c, 480).view.nodes[root.index]!.pictureScale, undefined);
});
