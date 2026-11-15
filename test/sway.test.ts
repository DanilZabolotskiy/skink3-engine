import assert from 'node:assert/strict';
import { test } from 'node:test';
import demo from '../examples/demo/scene.ts';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  bump,
  capsule,
  circle,
  compileShot,
  group,
  layer,
  moveTo,
  popIn,
  popOut,
  reviewMotion,
  sampleMotion,
  shot,
  turnTo,
  type Key,
  type ShotSpec,
  type SpringSpec,
} from '../src/index.ts';
import { SWAY_MAX_LEAN, SWAY_MAX_RATE, swayLean, swayTurn } from '../src/core/dynamics.ts';

// A swaying stick is a spring on its angle: it leans against the sideways
// travel of its free end and swings back when that stops. Its angle cannot
// jump, and it cannot turn more than SWAY_MAX_LEAN from its rest direction,
// whatever its parent does and whatever the numbers of the spring are.

/** The authored rotation of the stick against its parent, in degrees. */
const REST = -90;

function scene(timeline: Key[], sway: SpringSpec = 'springy', seconds = 4, at: [number, number] = [-300, 0]): ShotSpec {
  return shot({
    id: 'sway',
    seconds,
    seed: 5,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.abyss' },
    atmosphere: 'mid.mist',
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [
      layer({
        id: 'stage',
        depth: 0,
        nodes: [
          group({
            id: 'creature',
            at,
            children: [
              capsule({ id: 'stick', at: [0, -60], rotation: -90, length: 70, r: 7, origin: 'start', fill: 'mid.jade', sway, children: [circle({ id: 'tip', at: [56, 0], r: 12, fill: 'accent.pink' })] }),
              circle({ id: 'body', r: 60, fill: 'mid.jade' }),
            ],
          }),
        ],
      }),
    ],
    timeline,
  });
}

/**
 * The lean of the stick at every frame: its angle against its rest direction on
 * its parent, in radians; NaN while it is not drawn. Read from the series of
 * the motion review, which holds the rotation of a node against its parent.
 */
async function leans(spec: ShotSpec): Promise<number[]> {
  const c = compileShot(spec);
  const series = sampleMotion(c, await bakeShot(c), { particles: false });
  const stick = series.placed[c.byId.get('stick')!.index]!;
  const out: number[] = [];
  for (let f = 0; f < c.frames; f++) out.push((stick.flags[f]! & 1) !== 0 ? ((stick.ownRot[f]! - REST) * Math.PI) / 180 : Number.NaN);
  return out;
}

const largest = (v: readonly number[], from = 0, to = v.length - 1): number => v.slice(from, to + 1).reduce((a, x) => (Number.isNaN(x) ? a : Math.max(a, Math.abs(x))), 0);
/** The largest change of the lean between two frames at which the stick is drawn. */
const steepest = (v: readonly number[]): number => {
  let m = 0;
  for (let f = 1; f < v.length; f++) if (!Number.isNaN(v[f]!) && !Number.isNaN(v[f - 1]!)) m = Math.max(m, Math.abs(v[f]! - v[f - 1]!));
  return m;
};

test('sway: the stick leans against the motion, swings back past its rest and settles', async () => {
  // The creature moves 600 units to the right in 1.2 s and stops with a small overshoot; the stick points up.
  const v = await leans(scene([moveTo('creature', { at: 0.5, to: [300, 0], dur: 1.2, anticipation: 0, arc: 0 })]));
  assert.ok(Math.abs(v[0]!) < 1e-9 && largest(v, 0, 29) < 1e-9, 'at rest before the move');
  // Moving right, a stick that points up leans to the left: its angle (clockwise) goes down.
  const back = Math.min(...v.slice(30, 100));
  assert.ok(back < -0.3, `it leans back during the move (${back.toFixed(2)} rad)`);
  const forward = Math.max(...v.slice(60, 200));
  assert.ok(forward > 0.03, `and swings past its rest direction when the move ends (${forward.toFixed(3)} rad)`);
  assert.ok(largest(v, 220) < 0.01, `then it settles (${largest(v, 220).toFixed(4)} rad left)`);
  // The lean is smooth: the stick never turns by more than a few degrees in a frame.
  assert.ok(steepest(v) < 0.15, `the largest turn in one frame is ${steepest(v).toFixed(3)} rad`);
});

test('sway: no motion of the parent makes the stick snap or whip round', async () => {
  // Raw keys, as a generated timeline could hold them: a teleport within one frame, there and back.
  const teleport = (at: number, to: [number, number]): Key => ({ kind: 'moveTo', target: 'creature', at, to, dur: 1 / 60, anticipation: 0, overshoot: 0, arc: 0 });
  const violent: Key[] = [
    popIn('creature', { at: 0.2, dur: 0.3 }),
    teleport(0.8, [500, 0]),
    teleport(1.2, [-500, 200]),
    moveTo('creature', { at: 1.4, to: [400, -200], dur: 0.4, anticipation: 0.3, overshoot: 0.3, arc: 0.4 }),
    turnTo('creature', { at: 2, to: 720, dur: 0.5 }),
    bump('creature', { at: 2.6, amount: 0.5 }),
    popOut('creature', { at: 3, dur: 0.2 }),
    popIn('creature', { at: 3.3, dur: 0.2 }),
  ];
  for (const spring of ['heavy', 'light', 'springy', 'viscous', { f: 9, z: 0.02, r: 2 }, { f: 0.3, z: 0, r: -2 }] as SpringSpec[]) {
    const v = await leans(scene(violent, spring));
    const name = typeof spring === 'string' ? spring : JSON.stringify(spring);
    assert.ok(v.every((x) => Number.isNaN(x) || Number.isFinite(x)), `${name}: every angle is a number`);
    assert.ok(largest(v) < SWAY_MAX_LEAN, `${name}: never more than ${SWAY_MAX_LEAN} rad from its rest direction (${largest(v).toFixed(3)})`);
  }
  // With the presets the stick is never flicked either, even through the teleports: the lean it
  // follows changes by at most SWAY_MAX_RATE, and the spring adds its own overshoot to that.
  for (const spring of ['heavy', 'light', 'springy', 'viscous'] as const) {
    const v = await leans(scene(violent, spring));
    assert.ok(steepest(v) < (2 * SWAY_MAX_RATE) / 60, `${spring}: the largest turn in one frame is ${steepest(v).toFixed(3)} rad`);
  }
});

test('sway: a stick is at rest when it appears, whatever its parent did while hidden', async () => {
  // The creature crosses the stage while it has no size, then pops in and stands still.
  const v = await leans(scene([popOut('creature', { at: 0, dur: 0.05 }), moveTo('creature', { at: 0.2, to: [300, 0], dur: 0.8, anticipation: 0, overshoot: 0, arc: 0 }), popIn('creature', { at: 1.2, dur: 0.4 })]));
  const first = v.findIndex((x, f) => f > 30 && !Number.isNaN(x));
  assert.ok(first > 60, `it is not drawn during the move (first drawn at frame ${first})`);
  assert.ok(largest(v, first) < 0.02, `it appears at rest and stays there (${largest(v, first).toFixed(4)} rad)`);
});

test('sway: the presets keep their character', async () => {
  // A move at constant speed that stops dead, one raw key per frame: 8 units a frame for a second.
  const move: Key[] = Array.from({ length: 60 }, (_, k) => ({ kind: 'moveTo', target: 'creature', at: (30 + k) / 60, to: [-300 + (k + 1) * 8, 0], dur: 1 / 60, anticipation: 0, overshoot: 0, arc: 0 }));
  const after = async (spring: SpringSpec): Promise<{ back: number; forward: number }> => {
    const v = await leans(scene(move, spring, 6));
    return { back: -Math.min(...v.slice(30, 95)), forward: Math.max(...v.slice(90, 360)) };
  };
  const springy = await after('springy');
  const viscous = await after('viscous');
  const heavy = await after('heavy');
  const light = await after('light');
  assert.ok(springy.forward > 0.05, `springy swings past its rest (${springy.forward.toFixed(3)} rad)`);
  assert.ok(viscous.forward < 0.005 && heavy.forward < 0.02, `viscous and heavy do not (${viscous.forward.toFixed(4)}, ${heavy.forward.toFixed(4)})`);
  // A softer spring (a lower f) leans more than a stiff one.
  assert.ok(viscous.back > light.back && heavy.back > light.back && springy.back > light.back, `lean: viscous ${viscous.back.toFixed(2)}, heavy ${heavy.back.toFixed(2)}, springy ${springy.back.toFixed(2)}, light ${light.back.toFixed(2)}`);
});

test('sway: the lean law is bounded and odd, and small leans are untouched', () => {
  const p = { f: 2, z: 0.3, r: 0 };
  assert.equal(swayLean(p, 0, 50), 0);
  assert.ok(Math.abs(swayLean(p, 100, 50) + swayLean(p, -100, 50)) < 1e-12, 'odd in the speed');
  assert.ok(swayLean(p, 100, 50) < 0, 'against the travel');
  // A slow travel: the free end trails by speed / (2 pi f), and the angle is that over the lever.
  assert.ok(Math.abs(swayLean(p, 10, 50) + 10 / (2 * Math.PI * 2) / 50) < 1e-4);
  for (const speed of [1e3, 1e6, 1e12, Infinity]) assert.ok(Math.abs(swayLean(p, speed, 50)) <= SWAY_MAX_LEAN, `bounded at speed ${speed}`);
  assert.ok(Math.abs(swayLean(p, 500, 0)) <= SWAY_MAX_LEAN, 'a stick without length does not divide by zero');
  assert.ok(Math.abs(swayTurn(0.01) - 0.01) < 1e-6 && Math.abs(swayTurn(100)) <= SWAY_MAX_LEAN && swayTurn(-3) === -swayTurn(3));
});

test('sway: the demo creature has no motion findings', async () => {
  // Its antennae once snapped out of its body while it popped in and whipped round during its
  // fast move: four jumps and a strobing tip. This is the regression test of that defect.
  const c = compileShot(demo);
  const { report } = reviewMotion(c, await bakeShot(c));
  assert.deepEqual(report.findings.map((f) => `${f.kind} ${f.subject}`), []);
  const antennae = report.springs.filter((s) => s.kind === 'sway');
  assert.deepEqual(antennae.map((s) => s.id).sort(), ['buddy-ant-l', 'buddy-ant-r']);
  for (const s of antennae) {
    // The free end of a stick 53 units long cannot be farther from its rest place than a chord of 57 degrees.
    for (const r of s.responses) assert.ok(r.lagPx < 2 * 53 * 1.07 * Math.sin(SWAY_MAX_LEAN / 2), `${s.id} lags ${r.lagPx} px`);
    assert.ok(s.responses.some((r) => r.overshootPx > 5), `${s.id} still swings past its rest (${s.responses.map((r) => r.overshootPx).join(', ')} px)`);
  }
});
