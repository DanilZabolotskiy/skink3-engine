import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, bendTo, circle, compileShot, evaluate, group, IntentError, layer, link, reviewMotion, sceneEvents, shot, type Key, type ShotSpec } from '../src/index.ts';

// A line whose slack changes: bendTo changes the bend of a link over time.

function make(timeline: Key[], bend = 0.2, seconds = 4): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 3,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes: [link({ id: 'rope', from: 'a', to: 'b', color: 'mid.mist', bend, gap: 0 }), group({ id: 'a', at: [-400, 0] }), group({ id: 'b', at: [400, 0] })] })],
    timeline,
  });
}

/** How far the middle of the line is below the straight line between its ends, as a fraction of its length. */
async function sag(spec: ShotSpec): Promise<(seconds: number) => number> {
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  return (seconds) => {
    const item = evaluate(c, bake, Math.round(seconds * 60), 'en').layers[0]!.items.find((i) => i.kind === 'link');
    assert.ok(item && item.kind === 'link');
    // The middle control point of the curve lies at the bend times the length to the side.
    return item.curve[1][1] / 800;
  };
}

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

test('bend: bendTo brings a link to a new bend, swings past it and settles; keys chain from the bend reached', async () => {
  assert.deepEqual(bendTo('rope', { at: 2, to: 0 }), { kind: 'bendTo', target: 'rope', at: 2, to: 0, dur: 0.8, overshoot: 0.25 });
  // A slack line pulls taut: it passes the straight line, swings back and stays straight.
  const taut = await sag(make([bendTo('rope', { at: 1, to: 0, dur: 1 })]));
  assert.ok(near(taut(0), 0.2) && near(taut(1), 0.2), 'the bend it was given, until the key');
  let past = Infinity;
  for (let f = 60; f <= 120; f++) past = Math.min(past, taut(f / 60));
  assert.ok(past < -0.02, `it swings past the straight line, to ${past}`);
  assert.ok(near(taut(2), 0) && near(taut(3.9), 0), 'and then it is straight');
  // Without an overshoot it only arrives.
  const plain = await sag(make([bendTo('rope', { at: 1, to: 0, dur: 1, overshoot: 0 })]));
  let low = Infinity;
  for (let f = 60; f <= 120; f++) low = Math.min(low, plain(f / 60));
  assert.ok(low >= -1e-9 && plain(1.5) < 0.1);
  // Keys chain: it sags, then goes slack the other way, each from where it is.
  const chained = await sag(make([bendTo('rope', { at: 0, to: 0.4, dur: 1, overshoot: 0 }), bendTo('rope', { at: 0.5, to: -0.3, dur: 1, overshoot: 0 }), bendTo('rope', { at: 3, to: 0, dur: 0.5, overshoot: 0 })], 0));
  const half = chained(0.5);
  assert.ok(half > 0.2 && half < 0.4, `half-way to its first bend when the second key takes over: ${half}`);
  assert.ok(near(chained(1.5), -0.3) && near(chained(2.9), -0.3) && near(chained(3.5), 0));
});

test('bend: what it refuses, that it is opt-in, and what the review and the events make of it', async () => {
  const bad = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, (e: unknown) => e instanceof Error && message.test(e.message), String(message));
  };
  bad(() => bendTo('rope', { at: 1, to: 0, ease: 'in' } as never), /bendTo\("rope"\): unknown option "ease" \(allowed: at, to, dur, overshoot\)/);
  bad(() => bendTo('rope', { at: 1, to: 2 }), /to must be a number in -1\.\.1/);
  assert.ok(IntentError);
  bad(
    () =>
      shot({
        id: 'tiny',
        seconds: 2,
        seed: 1,
        palette,
        strings: { en: {} },
        background: { inner: 'deep.night', outer: 'deep.night' },
        atmosphere: 'mid.mist',
        layers: [layer({ id: 'stage', depth: 0, nodes: [circle({ id: 'c', r: 10, fill: 'accent.aqua' })] })],
        timeline: [bendTo('c', { at: 0, to: 0 })],
      }),
    /bendTo cannot target shape "c"; it applies to links/,
  );

  // A link without a bendTo has no change of bend in its track, and the curve it had.
  const plain = compileShot(make([]));
  assert.deepEqual(plain.nodes[0]!.link!.bends, []);
  assert.ok(near((await sag(make([])))(2), 0.2));
  assert.ok(!JSON.stringify(make([])).includes('bendTo'));

  // No event; and a line that sags and pulls taut is life in the frame, while a line that only hangs is a hold.
  const moving = compileShot(make([0, 1.5, 3, 4.5, 6].map((at, i) => bendTo('rope', { at, to: i % 2 === 0 ? 0 : 0.3, dur: 1.4 })), 0.3, 8));
  assert.deepEqual(sceneEvents(moving, await bakeShot(moving)), []);
  const holds = async (c: ReturnType<typeof compileShot>): Promise<boolean> => reviewMotion(c, await bakeShot(c)).report.findings.some((f) => f.kind === 'dead-area' && f.subject === '(frame)');
  assert.equal(await holds(moving), false);
  assert.equal(await holds(compileShot(make([], 0.3, 8))), true);
});
