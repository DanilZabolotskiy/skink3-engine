import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  evaluate,
  frameRaw,
  group,
  heightFor,
  IntentError,
  label,
  layer,
  link,
  moveTo,
  popIn,
  rect,
  reviewMotion,
  scaleTo,
  sceneEvents,
  shot,
  turnTo,
  type Key,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';

// A lasting change of size along one axis: scaleTo with to: [sx, sy] and a pivot.

const WIDTH = 960;

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], seconds = 4): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 3,
    palette,
    strings: { en: { 'label.a': 'A' } },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

/** The box, in stage units, round the pink pixels of a frame. */
async function box(spec: ShotSpec, seconds: number): Promise<{ x0: number; y0: number; x1: number; y1: number }> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), Math.round(seconds * 60), { width: WIDTH, lang: 'en', gpu: false });
  const h = heightFor(WIDTH);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const o = (y * WIDTH + x) * 4;
      if (!(raw[o]! > 200 && raw[o + 1]! < 140 && raw[o + 2]! > 120)) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const k = 1920 / WIDTH;
  return { x0: x0 * k - 960, y0: y0 * k - 540, x1: (x1 + 1) * k - 960, y1: (y1 + 1) * k - 540 };
}

const near = (b: { x0: number; y0: number; x1: number; y1: number }, x0: number, y0: number, x1: number, y1: number, eps = 5): boolean =>
  Math.abs(b.x0 - x0) <= eps && Math.abs(b.y0 - y0) <= eps && Math.abs(b.x1 - x1) <= eps && Math.abs(b.y1 - y1) <= eps;

/** A flat square of 100 units in the middle of the frame. */
const SQUARE = { id: 'bar', w: 100, h: 100, radius: 0, fill: 'accent.pink', lit: false } as const;

test('axis scale: the key of an even scaleTo is what it was; with to: [sx, sy] it carries its axes and its pivot', () => {
  assert.deepEqual(scaleTo('a', { at: 1, to: 2 }), { kind: 'scaleTo', target: 'a', at: 1, to: 2, dur: 0.6, overshoot: 0.15 });
  assert.deepEqual(scaleTo('a', { at: 1, to: [1, 2.5], pivot: [0, 40], dur: 1, overshoot: 0 }), { kind: 'scaleTo', target: 'a', at: 1, to: 1, dur: 1, overshoot: 0, axes: [1, 2.5], pivot: [0, 40] });
  assert.deepEqual(scaleTo('a', { at: 1, to: [0.5, 1] }).pivot, undefined, 'without a pivot the origin stays in place');
  const bad = (opts: object, message: RegExp): void => {
    assert.throws(() => scaleTo('a', opts as never), (e: unknown) => e instanceof IntentError && message.test(e.message), String(message));
  };
  bad({ at: 1, to: 2, pivot: [0, 40] }, /pivot goes with to: \[sx, sy\]/);
  bad({ at: 1, to: [1, 2, 3] }, /to must be a number, or \[sx, sy\]/);
  bad({ at: 1, to: [1, 0] }, /to\[1\] must be a number in 0\.01\.\.100/);
  bad({ at: 1, to: [1, 2], pivot: [0] }, /pivot must be \[x, y\]/);
  bad({ at: 1, to: [1, 2], axis: 'y' }, /scaleTo\("a"\): unknown option "axis" \(allowed: at, to, pivot, dur, overshoot, sound\)/);
  // In a shot: not for a label, and not for a rigid body.
  const pointed = [circle({ id: 'c', r: 20, fill: 'accent.aqua' }), label({ id: 'l', text: 'label.a', target: 'c', fill: 'light.cream', ink: 'deep.abyss' })];
  assert.throws(() => make(pointed, [scaleTo('l', { at: 1, to: [1, 2] })]), /scaleTo\("l"\) with to: \[sx, sy\] cannot target a label/);
  assert.throws(() => make([rect({ ...SQUARE, body: { kind: 'fixed' } })], [scaleTo('bar', { at: 1, to: [1, 2] })]), /the size of a rigid body is fixed/);
});

test('axis scale: a bar grows from one end, overshoots, stays so; keys chain, and a new pivot does not make it jump', async () => {
  // Three times as high, its lower edge in place.
  const grown = make([rect(SQUARE)], [scaleTo('bar', { at: 1, to: [1, 3], pivot: [0, 50], dur: 1, overshoot: 0.2 })]);
  assert.ok(near(await box(grown, 0.5), -50, -50, 50, 50), 'as authored before the key');
  assert.ok(near(await box(grown, 2.5), -50, -250, 50, 50), JSON.stringify(await box(grown, 2.5)));
  assert.ok(near(await box(grown, 3.9), -50, -250, 50, 50), 'and it stays so');
  // On the way it shoots past: higher than it will be.
  let top = 0;
  for (const t of [1.3, 1.4, 1.5, 1.6, 1.7]) top = Math.min(top, (await box(grown, t)).y0);
  assert.ok(top < -262, `it reaches ${top}`);
  assert.ok(near(await box(make([rect(SQUARE)], [scaleTo('bar', { at: 1, to: [1, 3], pivot: [0, 50], dur: 1, overshoot: 0 })]), 1.5), -50, -205, 50, 50, 60), 'without an overshoot it only arrives');
  // Without a pivot: about its origin.
  assert.ok(near(await box(make([rect(SQUARE)], [scaleTo('bar', { at: 0, to: [2, 0.5], dur: 0.5 })]), 2), -100, -25, 100, 25));

  // Keys chain. Down in two steps, each from what was reached.
  const steps = make([rect(SQUARE)], [scaleTo('bar', { at: 0, to: [1, 3], pivot: [0, 50], dur: 0.5 }), scaleTo('bar', { at: 1, to: [1, 2], pivot: [0, 50], dur: 0.5 }), scaleTo('bar', { at: 2, to: [1, 0.5], pivot: [0, 50], dur: 0.5 })]);
  assert.ok(near(await box(steps, 0.9), -50, -250, 50, 50) && near(await box(steps, 1.9), -50, -150, 50, 50) && near(await box(steps, 3), -50, 0, 50, 50));
  // A new pivot: the picture is the same at the moment the key starts, and from then on the new point stays in place.
  const lifted = make([rect(SQUARE)], [scaleTo('bar', { at: 0, to: [1, 3], pivot: [0, 50], dur: 0.5 }), scaleTo('bar', { at: 2, to: [1, 1], pivot: [0, -50], dur: 1, overshoot: 0 })]);
  assert.ok(near(await box(lifted, 119 / 60), -50, -250, 50, 50) && near(await box(lifted, 2), -50, -250, 50, 50), 'no jump where the pivot changes');
  assert.ok(near(await box(lifted, 3.5), -50, -250, 50, -150), 'its upper edge stayed while its lower edge rose');
});

test('axis scale: it is along the node\'s own axes, with everything in the node, on top of its even size, its moves and its turns', async () => {
  // Turned a quarter, its own width is up and down on screen.
  const turned = make([rect({ ...SQUARE, rotation: 90 })], [scaleTo('bar', { at: 0, to: [3, 1], dur: 0.5 })]);
  assert.ok(near(await box(turned, 2), -50, -150, 50, 150), JSON.stringify(await box(turned, 2)));
  // A card edge-on: almost no width.
  const edge = make([rect({ ...SQUARE, w: 400 })], [scaleTo('bar', { at: 0, to: [0.05, 1], dur: 0.5, overshoot: 0 })]);
  const thin = await box(edge, 2);
  assert.ok(Math.abs(thin.x1 - thin.x0 - 20) <= 5 && Math.abs(thin.y1 - thin.y0 - 100) <= 5 && Math.abs(thin.x0 + thin.x1) <= 4, JSON.stringify(thin));
  // What is in the node goes with it: a child half as far out when the node is half as wide.
  const withChild = make([group({ id: 'g', children: [circle({ id: 'dot', at: [200, 0], r: 20, fill: 'accent.pink', lit: false })] })], [scaleTo('g', { at: 0, to: [0.5, 1], dur: 0.5, overshoot: 0 })]);
  assert.ok(near(await box(withChild, 2), 90, -20, 110, 20), JSON.stringify(await box(withChild, 2)));
  // With an even size, a move and a turn: twice as large, at its new place, turned, and three times as long along its own height.
  const all = make([rect(SQUARE)], [scaleTo('bar', { at: 0, to: 2, dur: 0.5, overshoot: 0 }), moveTo('bar', { at: 0, to: [300, 100], dur: 0.5, profile: 'ease' }), turnTo('bar', { at: 0, to: 90, dur: 0.5, overshoot: 0 }), scaleTo('bar', { at: 1, to: [1, 3], dur: 0.5, overshoot: 0 })]);
  assert.ok(near(await box(all, 3), 0, 0, 600, 200), JSON.stringify(await box(all, 3)));
  // A label points at the edge the shape has now, and a link ends there.
  const labelled = make(
    [rect(SQUARE), label({ id: 'l', text: 'label.a', target: 'bar', fill: 'light.cream', ink: 'deep.abyss', gap: 10 }), link({ id: 'wire', from: 'bar', to: 'far', color: 'mid.mist', bend: 0, gap: 0 }), group({ id: 'far', at: [600, 0] })],
    [scaleTo('bar', { at: 0, to: [2, 3], pivot: [0, 50], dur: 0.5, overshoot: 0 })],
  );
  const c = compileShot(labelled);
  const state = evaluate(c, await bakeShot(c), 120, 'en');
  const items = state.layers[0]!.items;
  const tip = items.find((i) => i.kind === 'label');
  assert.ok(tip && tip.kind === 'label' && Math.abs(tip.tip[1] + 260) < 0.5, 'ten units above its upper edge, which is at -250');
  const wire = items.find((i) => i.kind === 'link');
  assert.ok(wire && wire.kind === 'link' && Math.abs(wire.curve[0][0] - 100) < 0.5, 'the link starts at its right edge, which is at 100');
});

test('axis scale: it is opt-in, its change is a grow or a shrink event, and the motion review judges it', async () => {
  // No key with axes: no wrapper in the display list, nothing of it in the compiled node.
  const plain = compileShot(make([rect(SQUARE)], [scaleTo('bar', { at: 1, to: 2 }), popIn('bar', { at: 0.2 })]));
  assert.equal(plain.nodes[0]!.axis, null);
  assert.deepEqual(evaluate(plain, await bakeShot(plain), 120, 'en').layers[0]!.items.map((i) => i.kind), ['shape']);
  const keyed = compileShot(make([rect(SQUARE)], [scaleTo('bar', { at: 1, to: [1, 2] })]));
  const bake = await bakeShot(keyed);
  assert.deepEqual(evaluate(keyed, bake, 30, 'en').layers[0]!.items.map((i) => i.kind), ['shape'], 'as authored until the key starts');
  const wrapped = evaluate(keyed, bake, 120, 'en').layers[0]!.items[0]!;
  assert.ok(wrapped.kind === 'stretch' && wrapped.axes !== undefined && wrapped.axes.sx === 1 && wrapped.axes.sy === 2 && wrapped.items[0]!.kind === 'shape');
  // Back at its authored size about the same point, it is the plain node again.
  const back = compileShot(make([rect(SQUARE)], [scaleTo('bar', { at: 0, to: [1, 2], pivot: [0, 50], dur: 0.5 }), scaleTo('bar', { at: 1, to: [1, 1], pivot: [0, 50], dur: 0.5 })]));
  assert.deepEqual(evaluate(back, await bakeShot(back), 200, 'en').layers[0]!.items.map((i) => i.kind), ['shape']);

  // Events: it grows when it covers more than before, shrinks when it covers less.
  const c = compileShot(make([rect(SQUARE)], [scaleTo('bar', { at: 0.5, to: [1, 3] }), scaleTo('bar', { at: 2, to: [0.5, 3] }), scaleTo('bar', { at: 3, to: [0.4, 1] })]));
  assert.deepEqual(sceneEvents(c, await bakeShot(c)).map((e) => [e.kind, e.frame]), [['grow', 30], ['shrink', 120], ['shrink', 180]]);

  // The motion review. With its overshoot the change is clean; without one it starts at full speed, as an even scaleTo does.
  const flagged = async (timeline: Key[], seconds = 4): Promise<string[]> => {
    const cs = compileShot(make([rect({ ...SQUARE, w: 200, h: 200 })], timeline, seconds));
    return reviewMotion(cs, await bakeShot(cs)).report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel}`).sort();
  };
  assert.deepEqual((await flagged([scaleTo('bar', { at: 1, to: [1, 2.5], pivot: [0, 100], dur: 0.8 })])).filter((f) => f.includes(' bar ')), []);
  assert.deepEqual((await flagged([scaleTo('bar', { at: 1, to: [1, 2.5], pivot: [0, 100], dur: 0.8, overshoot: 0 })])).filter((f) => f.includes(' bar ')), ['abrupt-start bar scale']);
  // A change along an axis is life in the frame; a square that only stands there is a hold.
  const held = await flagged([], 8);
  assert.ok(held.includes('dead-area (frame) hold'), held.join(', '));
  const alive = await flagged([0, 1.5, 3, 4.5, 6].map((at, i) => scaleTo('bar', { at, to: [1, i % 2 === 0 ? 2 : 1], pivot: [0, 100], dur: 1.4 })), 8);
  assert.ok(!alive.includes('dead-area (frame) hold'), alive.join(', '));
});
