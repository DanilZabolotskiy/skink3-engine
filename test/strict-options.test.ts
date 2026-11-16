import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  arcPoints,
  backgroundTo,
  bendTo,
  blink,
  bump,
  cameraTo,
  circle,
  countTo,
  drawOn,
  fadeTo,
  hop,
  IntentError,
  layer,
  levelTo,
  loopPoints,
  moveTo,
  openTo,
  popIn,
  popOut,
  pulse,
  reshape,
  scaleTo,
  SceneError,
  sfx,
  shot,
  solidTo,
  squash,
  stagger,
  travel,
  turnTo,
} from '../src/index.ts';

// An option that an intent or a node does not take is refused, by name, with what is taken. Nothing is dropped
// without a word: a misspelt option would otherwise give a picture that quietly differs from what was asked.

/** Every intent with options it takes: adding one it does not take must be refused. */
const INTENTS: Record<string, (extra: object) => unknown> = {
  moveTo: (x) => moveTo('a', { at: 1, to: [10, 0], ...x }),
  hop: (x) => hop('a', { at: 1, to: [10, 0], ...x }),
  travel: (x) => travel('a', { at: 1, path: [[0, 0], [100, 0]], speed: 50, ...x }),
  popIn: (x) => popIn('a', { at: 1, ...x }),
  popOut: (x) => popOut('a', { at: 1, ...x }),
  turnTo: (x) => turnTo('a', { at: 1, to: 90, ...x }),
  scaleTo: (x) => scaleTo('a', { at: 1, to: 2, ...x }),
  fadeTo: (x) => fadeTo('a', { at: 1, to: 0.5, ...x }),
  levelTo: (x) => levelTo('a', { at: 1, to: 0.5, ...x }),
  bump: (x) => bump('a', { at: 1, ...x }),
  squash: (x) => squash('a', { at: 1, ...x }),
  drawOn: (x) => drawOn('a', { at: 1, ...x }),
  solidTo: (x) => solidTo('a', { at: 1, ...x }),
  bendTo: (x) => bendTo('a', { at: 1, to: 0, ...x }),
  reshape: (x) => reshape('a', { at: 1, points: [[0, 0], [10, 0], [0, 10]], ...x }),
  pulse: (x) => pulse('a', { at: 1, ...x }),
  openTo: (x) => openTo('a', { at: 1, to: 1, ...x }),
  blink: (x) => blink('a', { at: 1, ...x }),
  countTo: (x) => countTo('a', { at: 1, to: 5, ...x }),
  cameraTo: (x) => cameraTo({ at: 1, zoom: 2, ...x }),
  backgroundTo: (x) => backgroundTo({ at: 1, inner: 'deep.night', ...x }),
  sfx: (x) => sfx('chime', { at: 1, ...x }),
  stagger: (x) => stagger(['a', 'b'], { at: 1, each: 0.1, ...x }, (id, at) => popIn(id, { at })),
};

test('strict options: every intent refuses an option it does not take, names it and says what it takes', () => {
  for (const [name, make] of Object.entries(INTENTS)) {
    assert.doesNotThrow(() => make({}), name);
    assert.throws(
      () => make({ durration: 2 }),
      (e: unknown) => e instanceof IntentError && new RegExp(`^${name}(\\(.*\\))?: unknown option "durration" \\(allowed: at[,)]`).test(e.message),
      `${name} must refuse an unknown option`,
    );
  }
  // An option of another intent is refused as well: it would do nothing here.
  assert.throws(() => popIn('a', { at: 1, to: [10, 0] } as never), /popIn\("a"\): unknown option "to" \(allowed: at, dur, overshoot, sound\)/);
  assert.throws(() => fadeTo('a', { at: 1, to: 0, overshoot: 0.2 } as never), /fadeTo\("a"\): unknown option "overshoot" \(allowed: at, to, dur, sound\)/);
  assert.throws(() => bump('a', { at: 1, dur: 2 } as never), /bump\("a"\): unknown option "dur" \(allowed: at, amount, sound\)/);
  assert.throws(() => moveTo('a', { at: 1, to: [0, 0], height: 80 } as never), /moveTo\("a"\): unknown option "height" \(allowed: at, arrive, to, dur, anticipation, overshoot, arc, profile, ramp, sound\)/);
  assert.throws(() => pulse('a', { at: 1, amount: 0.2 } as never), /pulse\("a"\): unknown option "amount"/);
  assert.throws(() => blink('a', { at: 1, dur: 0.2 } as never), /blink\("a"\): unknown option "dur" \(allowed: at, sound\)/);
  assert.throws(() => openTo('a', { at: 1, to: 1, speed: 2 } as never), /openTo\("a"\): unknown option "speed"/);
  assert.throws(() => popOut('a', { at: 1, overshoot: 0.1 } as never), /popOut\("a"\): unknown option "overshoot" \(allowed: at, dur, sound\)/);
  assert.throws(() => stagger(['a'], { at: 1, each: 0.1, reverse: true } as never, (id, at) => popIn(id, { at })), /stagger: unknown option "reverse" \(allowed: at, each, order\)/);
  // What is not an options object at all.
  assert.throws(() => popIn('a', 1 as never), /popIn\("a"\): the second argument is an options object/);
  // The options they take still work, every one of them.
  assert.deepEqual(popIn('a', { at: 1, dur: 0.4, overshoot: 0.1, sound: false }), { kind: 'popIn', target: 'a', at: 1, dur: 0.4, overshoot: 0.1, sound: false });
  assert.deepEqual(moveTo('a', { arrive: 3, to: [1, 2], dur: 1, anticipation: 0, overshoot: 0, arc: 0 }).to, [1, 2]);
});

test('strict options: the helpers and the option objects of a node and of a shot are strict too', () => {
  assert.throws(() => arcPoints([0, 0], 10, 0, 90, { steps: 4 } as never), /arcPoints: unknown option "steps" \(allowed: step\)/);
  assert.throws(() => loopPoints([0, 0], 10, { count: 4 } as never), /loopPoints: unknown option "count" \(allowed: start, clockwise, points\)/);
  const base = { id: 'c', r: 10, fill: 'accent.aqua' } as const;
  const scene = (extra: object): unknown =>
    shot({ id: 's', seconds: 1, seed: 1, palette, strings: { en: {} }, background: { inner: 'deep.night', outer: 'deep.abyss' }, atmosphere: 'mid.mist', layers: [layer({ id: 'l', depth: 0, nodes: [circle(base)] })], ...extra } as never);
  const refused = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, (e: unknown) => e instanceof SceneError && message.test(e.message), String(message));
  };
  refused(() => circle({ ...base, colour: 'accent.aqua' } as never), /circle\("c"\): unknown option "colour"/);
  refused(() => circle({ ...base, follow: { f: 2, z: 0.3, r: 0, damping: 1 } as never }), /circle\("c"\) follow: unknown option "damping" \(allowed: f, z, r\)/);
  refused(() => circle({ ...base, idle: { amp: 4, period: 3, speed: 1 } as never }), /idle: unknown option "speed"/);
  refused(() => scene({ light: { from: 'top-left', strength: 2 } }), /light: unknown option "strength" \(allowed: from\)/);
  refused(() => scene({ camera: { zoom: 2 } }), /camera: unknown option "zoom"/);
  refused(() => scene({ title: 'x' }), /unknown option "title"/);
  assert.doesNotThrow(() => scene({ light: { from: 'top' } }));
  assert.doesNotThrow(() => circle({ ...base, follow: 'springy' }));
  assert.doesNotThrow(() => circle({ ...base, follow: { f: 2, z: 0.3, r: 0 } }));
});
