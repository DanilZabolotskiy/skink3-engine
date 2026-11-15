import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  bump,
  capsule,
  circle,
  compileShot,
  drawOn,
  emitter,
  fadeTo,
  formatMotionReport,
  formatMotionShort,
  formatReport,
  FRAME_SUBJECT,
  group,
  intended,
  label,
  layer,
  link,
  motionPictures,
  motionReportJson,
  MOTION_FINDING_KINDS,
  moveTo,
  popIn,
  popOut,
  pulse,
  rect,
  renderGraph,
  renderTrail,
  reviewMotion,
  runChecks,
  scaleTo,
  shot,
  THRESHOLDS,
  turnTo,
  type Finding,
  type IntendedSpec,
  type Key,
  type LayerSpec,
  type MotionReport,
  type ShotSpec,
} from '../src/index.ts';

// Small synthetic scenes, each with one planted defect, and clean scenes that
// must stay clean. The camera stands still unless a test says otherwise.

interface Extra {
  seconds?: number;
  camera?: Parameters<typeof shot>[0]['camera'];
  intended?: IntendedSpec[];
  layers?: LayerSpec[];
  id?: string;
}

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], extra: Extra = {}): ShotSpec {
  return shot({
    id: extra.id ?? 'tiny',
    seconds: extra.seconds ?? 3,
    seed: 7,
    palette,
    strings: { en: { 'label.a': 'A label' } },
    background: { inner: 'deep.night', outer: 'deep.abyss' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: extra.camera ?? { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [...(extra.layers ?? []), layer({ id: 'stage', depth: 0, nodes })],
    timeline,
    ...(extra.intended ? { intended: extra.intended } : {}),
  });
}

async function review(spec: ShotSpec): Promise<MotionReport> {
  const c = compileShot(spec);
  return reviewMotion(c, await bakeShot(c)).report;
}

/** "kind subject" of every finding, sorted: what a scene was flagged for. */
const flagged = (r: MotionReport): string[] => r.findings.map((f) => `${f.kind} ${f.subject}`).sort();

const only = (r: MotionReport, kind: string, subject: string): Finding => {
  assert.deepEqual(flagged(r), [`${kind} ${subject}`], r.findings.map((f) => f.detail).join('\n'));
  return r.findings[0]!;
};

/** A raw key: what a hand-written or generated timeline could hold. The intents themselves cannot make these. */
const rawMove = (target: string, at: number, to: [number, number], dur: number): Key => ({ kind: 'moveTo', target, at, to, dur, anticipation: 0, overshoot: 0, arc: 0 });

/** A move at constant speed, one key per frame: `frames` steps of `dx` units starting at frame `f0`. */
function linearMove(target: string, f0: number, x0: number, y: number, dx: number, frames: number): Key[] {
  const keys: Key[] = [];
  for (let k = 0; k < frames; k++) keys.push(rawMove(target, (f0 + k) / 60, [x0 + (k + 1) * dx, y], 1 / 60));
  return keys;
}

const dot = (id: string, at: [number, number] = [-300, 0], r = 40): ReturnType<typeof circle> => circle({ id, at, r, fill: 'accent.aqua' });

test('motion: a teleport is a jump on the right node and frames', async () => {
  // The node changes place between frames 60 and 61.
  const f = only(await review(make([dot('a')], [rawMove('a', 1, [200, 0], 1 / 60)])), 'jump', 'a');
  assert.equal(f.channel, 'position');
  assert.deepEqual([f.from, f.to], [60, 61]);
  assert.ok(Math.abs(f.value - 500) < 1, `the measured step is the distance (${f.value})`);
  assert.equal(f.threshold, THRESHOLDS.jumpPx.value);
  assert.match(f.detail, /moved 500\.0 px between frames 60 and 61/);
  assert.ok(f.fix.length > 20, 'a finding says what usually fixes it');

  // The same jump spread over two frames is still one jump.
  const two = only(await review(make([dot('a')], [rawMove('a', 1, [200, 0], 2 / 60)])), 'jump', 'a');
  assert.deepEqual([two.from, two.to], [60, 62]);

  // There and back within two frames: a flicker.
  const flick = only(await review(make([dot('a')], [rawMove('a', 1, [200, 0], 1 / 60), rawMove('a', 1 + 1 / 60, [-300, 0], 1 / 60)])), 'jump', 'a');
  assert.deepEqual([flick.from, flick.to], [60, 62]);
  assert.match(flick.detail, /came back/);

  // A jump in the middle of a smooth move stands out against it.
  const mid = await review(make([dot('a')], [moveTo('a', { at: 0.5, to: [0, 0], dur: 1 }), rawMove('a', 1.5, [300, 200], 1 / 60), moveTo('a', { at: 1.6, to: [400, 200], dur: 1 })]));
  assert.deepEqual(flagged(mid), ['jump a']);

  // While the node is hidden it may go wherever it likes.
  const hidden = await review(make([dot('a')], [popOut('a', { at: 0.4 }), rawMove('a', 1, [200, 0], 1 / 60), popIn('a', { at: 1.5 })]));
  assert.deepEqual(flagged(hidden), []);
  // And outside the frame nobody sees it.
  const outside = await review(make([dot('a', [-3000, 0])], [rawMove('a', 1, [-2400, 0], 1 / 60)]));
  assert.deepEqual(flagged(outside), []);
});

test('motion: an opacity pop and a size pop are jumps', async () => {
  const fade = only(await review(make([dot('a')], [{ kind: 'fadeTo', target: 'a', at: 1, to: 0, dur: 1 / 60 }])), 'jump', 'a');
  assert.equal(fade.channel, 'opacity');
  assert.deepEqual([fade.from, fade.to], [60, 61]);
  assert.equal(fade.value, 1);
  assert.equal(fade.threshold, THRESHOLDS.jumpOpacity.value);

  // A node that appears at full size within a frame.
  const size = only(await review(make([dot('a')], [{ kind: 'popIn', target: 'a', at: 1, dur: 1 / 60, overshoot: 0 }])), 'jump', 'a');
  assert.equal(size.channel, 'scale');
  assert.deepEqual([size.from, size.to], [60, 61]);

  // A link that is simply there when its end node starts to pop in: it appears within a frame.
  const snap = await review(
    make([link({ id: 'l', from: 'a', to: 'b', color: 'dark.haze' }), dot('a'), dot('b', [300, 0])], [popIn('b', { at: 1 })]),
  );
  assert.deepEqual(flagged(snap), ['jump l']);
  // Drawn on after the node has arrived, it is fine.
  const drawn = await review(
    make([link({ id: 'l', from: 'a', to: 'b', color: 'dark.haze' }), dot('a'), dot('b', [300, 0])], [popIn('b', { at: 1 }), drawOn('l', { at: 1.6 })]),
  );
  assert.deepEqual(flagged(drawn), []);

  // The engine's own fades and pops are no pops, down to short ones.
  const eased = await review(make([dot('a'), dot('b', [300, 0])], [fadeTo('a', { at: 1, to: 0.2, dur: 0.15 }), popIn('b', { at: 0.5, dur: 0.3 }), popOut('b', { at: 2, dur: 0.25 })]));
  assert.deepEqual(flagged(eased), []);
});

test('motion: a move with no ease is an abrupt start; the eased intents are not', async () => {
  // With anticipation and overshoot at 0 a moveTo is a plain ease-out: full speed from the first frame.
  const start = only(await review(make([dot('a')], [moveTo('a', { at: 1, to: [300, 0], dur: 1, anticipation: 0, overshoot: 0, arc: 0 })])), 'abrupt-start', 'a');
  assert.equal(start.channel, 'position');
  assert.equal(start.from, 60);
  assert.ok(start.value > 25 && start.value < 32, `600 px in a second as an ease-out starts at about 30 px per frame (${start.value})`);
  assert.match(start.detail, /100 % of the peak speed/);

  // The mirror image: a move that runs into its place at full speed.
  const keys: Key[] = [];
  for (let k = 0; k < 40; k++) keys.push(rawMove('a', (60 + k) / 60, [-300 + 300 * ((k + 1) / 40) ** 3, 0], 1 / 60));
  const stop = only(await review(make([dot('a')], keys)), 'abrupt-stop', 'a');
  assert.equal(stop.to, 100);

  // A turn and a growth without ease are caught on their own channels.
  const turn = only(await review(make([rect({ id: 'a', w: 200, h: 60, fill: 'accent.aqua' })], [turnTo('a', { at: 1, to: 170, dur: 1, overshoot: 0 })])), 'abrupt-start', 'a');
  assert.equal(turn.channel, 'rotation');
  const grow = only(await review(make([dot('a', [0, 0], 120)], [scaleTo('a', { at: 1, to: 2, dur: 1, overshoot: 0 })])), 'abrupt-start', 'a');
  assert.equal(grow.channel, 'scale');

  // A defect of a parent is reported once, on the parent, not on what it carries.
  const family = await review(
    make(
      [group({ id: 'g', at: [-300, 0], children: [dot('c1', [0, 0], 50), dot('c2', [90, 0], 20), group({ id: 'inner', at: [0, 80], children: [dot('c3', [0, 0], 20)] })] })],
      [moveTo('g', { at: 1, to: [300, 0], dur: 1, anticipation: 0, overshoot: 0, arc: 0 })],
    ),
  );
  assert.deepEqual(flagged(family), ['abrupt-start g']);
});

test('motion: a constant-speed move between two rests is mechanical', async () => {
  // 40 frames at 8 px per frame, from rest to rest, in full view.
  const f = only(await review(make([dot('a')], linearMove('a', 60, -300, 0, 8, 40))), 'mechanical', 'a');
  assert.equal(f.channel, 'position');
  assert.deepEqual([f.from, f.to], [60, 100]);
  assert.equal(f.value, 1, 'the whole move is at constant speed');
  assert.match(f.detail, /constant 8\.0 px per frame .* over 40 of the 40 frames of a move of 320 px/);

  // Eased ends do not help if most of the move is still a ramp.
  const keys: Key[] = [];
  let x = -300;
  for (let k = 0; k < 50; k++) {
    const speed = k < 5 ? 2 * (k + 1) : k >= 45 ? 2 * (50 - k) : 10;
    x += speed;
    keys.push(rawMove('a', (60 + k) / 60, [x, 0], 1 / 60));
  }
  const trapezoid = only(await review(make([dot('a')], keys)), 'mechanical', 'a');
  assert.ok(trapezoid.value >= 0.7 && trapezoid.value < 1, `most of the move is flat (${trapezoid.value})`);
});

test('motion: a move too fast to read strobes, as a node, a rigid body and a stream of particles', async () => {
  // A small dot crosses 1500 units in half a second.
  const r = await review(make([dot('a', [-800, 0], 12)], [moveTo('a', { at: 1, to: [700, 0], dur: 0.5 })]));
  const f = only(r, 'too-fast', 'a');
  assert.ok(f.from >= 60 && f.to <= 91 && f.to - f.from >= 6, `inside the move (${f.from}-${f.to})`);
  assert.ok(f.value > 2, `several times its own size per frame (${f.value})`);
  assert.equal(f.threshold, THRESHOLDS.fastRatio.value);

  // The same distance with a large shape is readable.
  assert.deepEqual(flagged(await review(make([dot('a', [-800, 0], 200)], [moveTo('a', { at: 1, to: [700, 0], dur: 0.9 })]))), []);

  // A rigid body thrown across the frame: speed applies to bodies too.
  const body = await review(
    make([circle({ id: 'ball', at: [-900, -200], r: 9, fill: 'accent.coral', body: { kind: 'dynamic', release: 0.5, velocity: [1500, 0] } })], [], { seconds: 2 }),
  );
  assert.deepEqual(flagged(body), ['too-fast ball']);

  // A stream of small particles at 25 px per frame.
  const stream = await review(
    make([emitter({ id: 'jet', at: [-900, 0], rate: 40, colors: ['accent.amber'], size: 4, life: 2, speed: 1500, direction: 0, spread: 2, drag: 0 })], [], { seconds: 2 }),
  );
  const s = only(stream, 'too-fast', 'jet');
  assert.equal(s.channel, 'particles');
  assert.match(s.detail, /% of its particles in frame/);

  // A pulse that crosses its link in six frames.
  const quick = await review(
    make([link({ id: 'l', from: 'a', to: 'b', color: 'dark.haze' }), dot('a'), dot('b', [300, 0])], [pulse('l', { at: 1, dur: 0.1 })]),
  );
  assert.deepEqual(flagged(quick), ['too-fast l']);
});

test('motion: springs are measured; one that rings too long and one that never bounces are flagged', async () => {
  const scene = (spring: { f: number; z: number; r: number }, keys: Key[]): ShotSpec =>
    make([group({ id: 'carrier', at: [-300, 0], children: [dot('carrier-body', [0, 0], 30), circle({ id: 'bob', at: [0, -90], r: 16, fill: 'accent.pink', follow: spring })] })], keys, { seconds: 6 });

  // Almost no damping: it swings for seconds after the carrier has stopped.
  const ringing = await review(scene({ f: 2, z: 0.03, r: 0 }, [moveTo('carrier', { at: 0.5, to: [-240, 0], dur: 0.8 })]));
  const ring = only(ringing, 'spring-ringing', 'bob');
  assert.equal(ring.channel, 'spring');
  assert.ok(ring.value > THRESHOLDS.springRingSeconds.value, `rings for ${ring.value} s`);
  assert.ok(ring.from >= 50 && ring.from <= 80, `counted from the moment the carrier came to rest (${ring.from})`);
  const report = ringing.springs.find((s) => s.id === 'bob')!;
  assert.equal(report.kind, 'follow');
  const response = report.responses[0]!;
  assert.ok(response.overshootPx > 20 && response.swings >= 8, `overshoot ${response.overshootPx} px, ${response.swings} swings`);

  // The same spring behind a violent move also strobes as it swings: one finding for all the swings.
  const violent = await review(scene({ f: 2, z: 0.03, r: 0 }, [moveTo('carrier', { at: 0.5, to: [200, 0], dur: 0.8 })]));
  assert.deepEqual(flagged(violent), ['spring-ringing bob', 'too-fast bob']);
  assert.match(violent.findings.find((f) => f.kind === 'too-fast')!.detail, /in \d+ bursts/);

  // The springy preset on a moderate move: it bounces a few times and settles. Nothing to report.
  const settled = await review(scene({ f: 2.4, z: 0.26, r: 0 }, [moveTo('carrier', { at: 0.5, to: [-100, 0], dur: 1.6 })]));
  assert.deepEqual(flagged(settled), []);
  const good = settled.springs[0]!.responses[0]!;
  assert.ok(good.overshootPx > 5 && good.swings >= 2 && good.swings <= 8, `overshoot ${good.overshootPx} px, ${good.swings} swings`);
  assert.ok(good.settleSeconds !== null && good.settleSeconds < 2, `settles in ${good.settleSeconds} s`);
  assert.match(formatMotionReport(settled, compileShot(scene({ f: 2.4, z: 0.26, r: 0 }, []))), /springs: 1 spring-driven node\(s\), 1 responded\n {2}bob \(follow, f 2\.4, z 0\.26, r 0\): 1 response\(s\)/);

  // A bouncy spring behind a carrier that slows down for four seconds: it lags and creeps home, and never passes its place.
  const creeping = await review(scene({ f: 3, z: 0.3, r: 0 }, [moveTo('carrier', { at: 0.5, to: [500, 0], dur: 4, anticipation: 0, overshoot: 0, arc: 0 })]));
  const flat = creeping.findings.filter((f) => f.subject === 'bob');
  assert.deepEqual(flat.map((f) => f.kind), ['spring-no-overshoot'], creeping.findings.map((f) => `${f.kind} ${f.subject}: ${f.detail}`).join('\n'));
  assert.match(flat[0]!.detail, /came to rest without passing it/);
});

test('motion: a frame in which nothing moves is a dead area; camera motion does not make it alive', async () => {
  const still = [dot('a', [-500, -200]), rect({ id: 'b', at: [400, 250], w: 300, h: 120, fill: 'mid.violet' })];
  // Six seconds of two shapes that only sit there, while the camera drifts and pushes in.
  const dead = await review(make(still, [], { seconds: 6, camera: { drift: { speed: 0.6, wander: 8 }, pushIn: { from: 1, to: 1.06 } } }));
  const f = only(dead, 'dead-area', FRAME_SUBJECT);
  assert.deepEqual([f.from, f.to], [0, 359]);
  assert.equal(f.value, 6);
  assert.equal(f.threshold, THRESHOLDS.holdSeconds.value);

  // Under four seconds it is a hold, not a defect.
  assert.deepEqual(flagged(await review(make(still, [], { seconds: 3.9 }))), []);

  // Life on the left only: the frame is alive, the right side is not.
  const half = await review(make([circle({ id: 'a', at: [-640, 0], r: 60, fill: 'accent.aqua', idle: { amp: 30, period: 2 } }), still[1]!], [], { seconds: 7 }));
  assert.deepEqual(flagged(half), ['dead-area (frame:bottom-center)', 'dead-area (frame:bottom-right)', 'dead-area (frame:top-center)', 'dead-area (frame:top-right)']);
  assert.ok(half.findings.every((x) => x.value === 7 && x.threshold === THRESHOLDS.regionHoldSeconds.value));

  // Drifting particles all over the frame keep every part of it alive.
  const dusty = await review(
    make([...still, emitter({ id: 'dust', area: [1900, 1060], rate: 30, prewarm: 6, colors: ['light.cream'], size: [3, 5], life: [5, 8], speed: [10, 30], drag: 0 })], [], { seconds: 7 }),
  );
  assert.deepEqual(flagged(dusty), []);
});

/** Moves, pops, turns, growth, fades, bumps, a pulse, a spring, idle: all with the engine's own ease. */
function cleanScene(): ShotSpec {
  return make(
    [
      link({ id: 'wire', from: 'a', to: 'b', color: 'dark.haze', pulseColor: 'accent.amber' }),
      circle({ id: 'a', at: [-500, -100], r: 70, fill: 'accent.amber', glow: 0.6 }),
      circle({ id: 'b', at: [100, 150], r: 50, fill: 'accent.aqua', idle: { amp: 6, period: 3 }, children: [circle({ id: 'b-sat', at: [70, -50], r: 12, fill: 'light.cream', follow: 'springy' })] }),
      rect({ id: 'bar', at: [500, -250], w: 220, h: 60, fill: 'mid.violet' }),
      group({ id: 'creature', at: [550, 250], children: [capsule({ id: 'stick', at: [0, -60], rotation: -90, length: 70, r: 7, origin: 'start', fill: 'mid.jade', sway: 'springy' }), circle({ id: 'body', r: 60, fill: 'mid.jade' })] }),
      label({ id: 'tag', text: 'label.a', target: 'a', fill: 'light.cream', ink: 'deep.night', follow: 'light' }),
    ],
    [
      popIn('a', { at: 0.2 }),
      bump('a', { at: 1.2, amount: 0.2 }),
      drawOn('wire', { at: 0.9 }),
      pulse('wire', { at: 1.6 }),
      moveTo('b', { at: 2.4, to: [250, -50] }),
      scaleTo('b', { at: 2.4, to: 1.4 }),
      turnTo('bar', { at: 0.6, to: 80 }),
      fadeTo('bar', { at: 2, to: 0.4 }),
      moveTo('creature', { at: 1, to: [350, 300], dur: 1.4 }),
      popIn('tag', { at: 1.1 }),
      popOut('tag', { at: 3.4 }),
      moveTo('a', { at: 3.2, to: [-420, 60], dur: 1.2, anticipation: 0.2, overshoot: 0.14, arc: 0.3 }),
    ],
    { seconds: 5 },
  );
}

test('motion: a scene of eased moves and settled springs has no warnings', async () => {
  const report = await review(cleanScene());
  assert.deepEqual(flagged(report), [], report.findings.map((f) => `${f.kind} ${f.subject}: ${f.detail}`).join('\n'));
  assert.equal(report.springs.length, 3);
  const text = formatMotionReport(report, compileShot(cleanScene()));
  assert.match(text, /^motion tiny: 300 frames \(5\.00 s\); 8 placed nodes, 0 of them rigid bodies, 3 springs, 0 emitters, 1 links\ncamera: .*\nno warnings/);
  assert.deepEqual(formatMotionShort(report), ['motion: ok']);
});

test('motion: flows at constant speed are legitimate', async () => {
  const flows = make(
    [
      // A pulse that runs along a link, again and again.
      link({ id: 'wire', from: 'a', to: 'b', color: 'dark.haze' }),
      dot('a', [-600, -300], 30),
      dot('b', [600, -300], 30),
      // A thing that crosses the whole frame at constant speed: it never rests in view.
      rect({ id: 'belt', at: [-1300, 0], w: 160, h: 80, fill: 'mid.violet' }),
      // A ball that rolls along a floor on its own momentum.
      rect({ id: 'floor', at: [0, 420], w: 2600, h: 40, fill: 'dark.indigo', body: { kind: 'fixed', friction: 0 } }),
      circle({ id: 'ball', at: [-800, 370], r: 30, fill: 'accent.coral', body: { kind: 'dynamic', release: 0, velocity: [300, 0], friction: 0 } }),
      // Particles in flight.
      emitter({ id: 'rain', at: [0, -560], area: [1800, 0], rate: 30, prewarm: 3, colors: ['light.cream'], size: [5, 8], life: 4, speed: 300, direction: 90, spread: 0, drag: 0 }),
    ],
    [...[0.5, 1.6, 2.7, 3.8].map((at) => pulse('wire', { at, dur: 0.9, bump: 0 })), ...linearMove('belt', 30, -1300, 0, 12, 216)],
    { seconds: 5, camera: { drift: { speed: 0.7, wander: 0 }, pushIn: { from: 1, to: 1.05 } } },
  );
  const report = await review(flows);
  assert.deepEqual(flagged(report), [], report.findings.map((f) => `${f.kind} ${f.subject}: ${f.detail}`).join('\n'));

  // The same belt with both rests in view is a mechanical move.
  const resting = await review(make([rect({ id: 'belt', at: [-700, 0], w: 160, h: 80, fill: 'mid.violet' })], linearMove('belt', 30, -700, 0, 12, 100), { seconds: 5 }));
  assert.deepEqual(flagged(resting), ['mechanical belt']);
});

test('motion: a rigid body that lands and a pile that settles are not reported for ease or jumps', async () => {
  const pieces = Array.from({ length: 12 }, (_, i) =>
    rect({ id: `piece${i}`, at: [-150 + (i % 4) * 100, -420 + Math.floor(i / 4) * 90], w: 70, h: 70, rotation: 13 * i, fill: 'accent.aqua', body: { kind: 'dynamic', release: 0.2 + 0.07 * i, spin: 90 } }),
  );
  const report = await review(make([rect({ id: 'floor', at: [0, 380], w: 1200, h: 50, fill: 'dark.indigo', body: { kind: 'fixed' } }), ...pieces], [], { seconds: 4 }));
  assert.deepEqual(flagged(report), [], report.findings.map((f) => `${f.kind} ${f.subject}: ${f.detail}`).join('\n'));
  assert.equal(report.counts.bodies, 13);
});

test('motion: intended() takes a finding out of the warnings and the report says so', async () => {
  const keys = [moveTo('a', { at: 1, to: [300, 0], dur: 1, anticipation: 0, overshoot: 0, arc: 0 })];
  const marked = make([dot('a'), dot('b', [0, 300])], keys, {
    intended: [intended('a', 'abrupt-start', 'it is shot out of a tube'), intended(['a', 'b'], 'jump', 'left over from an earlier version')],
  });
  const report = await review(marked);
  assert.deepEqual(flagged(report), []);
  assert.equal(report.honoured.length, 1);
  assert.deepEqual(report.honoured[0]!.nodes, ['a']);
  assert.equal(report.honoured[0]!.reason, 'it is shot out of a tube');
  assert.equal(report.honoured[0]!.findings.length, 1);
  assert.equal(report.honoured[0]!.findings[0]!.kind, 'abrupt-start');
  assert.equal(report.unused.length, 1, 'an exception that matches nothing is reported as unused');
  const text = formatMotionReport(report, compileShot(marked));
  assert.match(text, /no warnings\nintended exceptions: 1 honoured \(1 finding\(s\) left out\), 1 unused/);
  assert.match(text, /intended, honoured: abrupt-start on a: "it is shot out of a tube" \(1 finding\(s\) left out\)/);
  assert.match(text, /intended, unused: jump on a, b: "left over from an earlier version" matches no finding/);

  // Another kind, another node or another moment is not covered.
  for (const x of [intended('a', 'abrupt-stop', 'wrong kind'), intended('b', 'abrupt-start', 'wrong node'), intended('a', 'abrupt-start', 'wrong moment', { from: 2 })]) {
    assert.deepEqual(flagged(await review(make([dot('a'), dot('b', [0, 300])], keys, { intended: [x] }))), ['abrupt-start a']);
  }
  assert.deepEqual(flagged(await review(make([dot('a'), dot('b', [0, 300])], keys, { intended: [intended('a', 'abrupt-start', 'the right moment', { from: 0.5, to: 1.5 })] }))), []);

  // A hold of the whole frame is marked on the frame, and covers its regions.
  const hold = make([dot('a')], [], { seconds: 7, intended: [intended(FRAME_SUBJECT, 'dead-area', 'a title card holds here')] });
  assert.deepEqual(flagged(await review(hold)), []);

  // An exception never changes the bake or the picture, and it must name something that exists.
  assert.equal(compileShot(marked).sceneHash, compileShot(make([dot('a'), dot('b', [0, 300])], keys)).sceneHash);
  assert.throws(() => make([dot('a')], [], { intended: [intended('nobody', 'jump', 'a node that is not there')] }), /intended\(\.\.\., "jump"\) names "nobody", which does not exist/);
  assert.throws(() => intended('a', 'wobble' as 'jump', 'no such kind'), /unknown kind of finding/);
  assert.throws(() => intended('a', 'jump', ''), /give the reason/);
  assert.deepEqual([...MOTION_FINDING_KINDS], ['jump', 'abrupt-start', 'abrupt-stop', 'mechanical', 'too-fast', 'spring-ringing', 'spring-no-overshoot', 'dead-area']);
});

test('motion: the report is deterministic, sorted by severity and capped as text', async () => {
  // Forty generated nodes with the same defect, one node with a worse one.
  const ids = Array.from({ length: 40 }, (_, i) => `item${i}`);
  const spec = (): ShotSpec =>
    make(
      [...ids.map((id, i) => dot(id, [-900 + (i % 10) * 190, -400 + Math.floor(i / 10) * 220], 30)), dot('lone', [0, 480], 30)],
      [...ids.map((id, i) => moveTo(id, { at: 1, to: [-900 + (i % 10) * 190 + 60 + i, -400 + Math.floor(i / 10) * 220], dur: 0.5, anticipation: 0, overshoot: 0, arc: 0 })), rawMove('lone', 1, [300, 480], 1 / 60)],
    );
  const c = compileShot(spec());
  const { report } = reviewMotion(c, await bakeShot(c));
  assert.equal(report.findings.length, 41);
  assert.deepEqual(report.byKind, { jump: 1, 'abrupt-start': 40 });
  assert.equal(report.findings[0]!.subject, 'lone', 'the worst comes first');
  for (let i = 1; i < report.findings.length; i++) assert.ok(report.findings[i - 1]!.severity >= report.findings[i]!.severity);

  // The same scene compiled and baked again gives the same report, byte for byte.
  const c2 = compileShot(spec());
  assert.equal(motionReportJson(reviewMotion(c2, await bakeShot(c2)).report), motionReportJson(report));
  const json = JSON.parse(motionReportJson(report)) as MotionReport;
  assert.equal(json.findings.length, 41, 'the JSON report is complete');
  assert.equal(json.version, 1);
  assert.equal(json.thresholds.jumpPx.value, THRESHOLDS.jumpPx.value);
  assert.ok(json.kinds['too-fast'].fix.length > 0);

  // As text: one family is shown once, and the whole thing stays short.
  const text = formatMotionReport(report, c);
  assert.match(text, /41 warning\(s\): 1 jump, 40 abrupt-start/);
  assert.match(text, /item39 \(circle\) {2}and 39 more like it: item38, item37, /);
  assert.match(text, /\(39 more finding\(s\) of the same kind on the others\)/);
  assert.ok(text.split('\n').length < 20, `a short report (${text.split('\n').length} lines)`);

  // Unrelated nodes are capped, with a pointer to the JSON report.
  const many = compileShot(
    make(
      ['ant', 'bee', 'cat', 'dog', 'eel', 'fox', 'gnu', 'hen', 'ibis', 'jay', 'kiwi', 'lynx', 'mole', 'newt', 'owl', 'pig'].map((id, i) => dot(id, [-900 + (i % 8) * 240, -300 + Math.floor(i / 8) * 400], 30)),
      ['ant', 'bee', 'cat', 'dog', 'eel', 'fox', 'gnu', 'hen', 'ibis', 'jay', 'kiwi', 'lynx', 'mole', 'newt', 'owl', 'pig'].map((id, i) =>
        moveTo(id, { at: 1, to: [-900 + (i % 8) * 240 + 80 + i, -300 + Math.floor(i / 8) * 400], dur: 0.5, anticipation: 0, overshoot: 0, arc: 0 }),
      ),
    ),
  );
  const capped = formatMotionReport(reviewMotion(many, await bakeShot(many)).report, many);
  assert.equal(capped.split('\n').filter((l) => / \(circle\)$/.test(l)).length, THRESHOLDS.reportSubjects.value);
  assert.match(capped, /\.\.\. and 4 finding\(s\) on 4 more subject\(s\), in the JSON report/);
});

test('docs: the guide lists every threshold with its value and reason, and every kind of finding', () => {
  const guide = readFileSync(fileURLToPath(new URL('../docs/MOTION-REVIEW.md', import.meta.url)), 'utf8');
  for (const [name, t] of Object.entries(THRESHOLDS)) {
    assert.ok(guide.includes(`| \`${name}\` | ${t.value} | ${t.unit} | ${t.why} |`), `docs/MOTION-REVIEW.md must hold the row of ${name} as it is in src/review/thresholds.ts`);
  }
  for (const kind of MOTION_FINDING_KINDS) assert.ok(guide.includes(`| \`${kind}\` |`), `the guide explains ${kind}`);
});

test('check: motion findings are shown in short form and never fail the checks', async () => {
  const c = compileShot(make([dot('a'), dot('b', [0, 300])], [rawMove('a', 1, [200, 0], 1 / 60), moveTo('b', { at: 1, to: [300, 300], dur: 1, anticipation: 0, overshoot: 0, arc: 0 })]));
  const bake = await bakeShot(c);
  assert.equal(runChecks(c, bake).motion, null, 'the motion review runs only when asked for');
  const report = runChecks(c, bake, undefined, { motion: true });
  assert.equal(report.ok, true);
  assert.equal(report.motion!.findings.length, 2);
  const text = formatReport(report);
  assert.match(text, /motion: 2 warning\(s\): 1 jump, 1 abrupt-start\n {2}~ warning: jump on "a" at f60-61 \(1\.00-1\.02 s\): position: moved 500\.0 px/);
  assert.match(text, /`skink3 motion <scene>` prints the full report, and with --pictures draws the worst/);
  assert.match(text, /checks passed with 2 warning\(s\)$/);
});

test('trail and graph: pictures in which time is visible', async () => {
  const c = compileShot(
    make(
      [dot('eased', [-300, -150], 50), dot('linear', [-300, 150], 50), emitter({ id: 'jet', at: [-900, 400], rate: 40, colors: ['accent.amber'], size: 4, life: 2, speed: 1500, direction: 0, spread: 2, drag: 0 })],
      [moveTo('eased', { at: 1, to: [300, -150], dur: 1, arc: 0 }), ...linearMove('linear', 60, -300, 150, 10, 60)],
      { camera: { drift: { speed: 0.6, wander: 6 }, pushIn: { from: 1, to: 1.05 } } },
    ),
  );
  const bake = await bakeShot(c);
  const { series, report } = reviewMotion(c, bake);
  const size = (png: Buffer): [number, number] => [png.readUInt32BE(16), png.readUInt32BE(20)];

  const trail = await renderTrail(c, bake, series, { nodes: ['eased', 'linear'], gpu: false });
  assert.equal(trail.png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.deepEqual(size(trail.png), [trail.width, trail.height]);
  assert.ok(trail.width <= 1920 && trail.width > 900 && trail.height <= 1200, `framed on the path (${trail.width} x ${trail.height})`);
  assert.equal(trail.space, 'stage');
  assert.ok(trail.from <= 60 && trail.to >= 120 && trail.to < 140, `the window is the move by default (${trail.from}-${trail.to})`);
  assert.ok(trail.ghosts >= 20 && trail.ghosts <= 60);

  // A chosen window, every frame, in screen space; the same call gives the same picture.
  const opts = { nodes: ['linear'], from: 55, to: 80, every: 1, space: 'screen' as const, gpu: false };
  const screen = await renderTrail(c, bake, series, opts);
  assert.deepEqual([screen.from, screen.to, screen.every, screen.ghosts, screen.space], [55, 80, 1, 26, 'screen']);
  assert.ok((await renderTrail(c, bake, series, opts)).png.equals(screen.png), 'deterministic');
  assert.ok(!(await renderTrail(c, bake, series, { ...opts, space: 'stage' })).png.equals(screen.png), 'the camera moves, so the two spaces differ');
  // An emitter leaves a trail of its particles.
  assert.equal((await renderTrail(c, bake, series, { nodes: ['jet'], gpu: false })).png.subarray(1, 4).toString('ascii'), 'PNG');
  await assert.rejects(renderTrail(c, bake, series, { nodes: ['nobody'], gpu: false }), /there is no node "nobody"/);

  // Graphs: a node, the camera, an emitter.
  const graph = await renderGraph(series, { subject: 'linear', findings: report.findings });
  assert.equal(graph.png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.deepEqual(size(graph.png), [graph.width, graph.height]);
  assert.deepEqual(graph.panels, ['speed, px per frame', 'position in its layer, units'], 'only what changes gets a panel');
  assert.ok((await renderGraph(series, { subject: 'linear', findings: report.findings })).png.equals(graph.png), 'deterministic');
  const zoomed = await renderGraph(series, { subject: 'eased', from: 50, to: 130 });
  assert.deepEqual([zoomed.from, zoomed.to], [50, 130]);
  const camera = await renderGraph(series, { subject: '(camera)' });
  assert.deepEqual(camera.panels, ['speed of the camera at depth 0, px per frame', 'position, units', 'zoom']);
  assert.equal((await renderGraph(series, { subject: 'jet' })).panels.length, 3);
  await assert.rejects(renderGraph(series, { subject: 'nobody' }), /there is no node "nobody"/);

  // One call for the worst subjects of a report: a trail and a graph of each.
  assert.deepEqual(flagged(report), ['mechanical linear', 'too-fast jet']);
  const pictures = await motionPictures(c, bake, series, report, { count: 3, gpu: false, lang: 'en' });
  assert.deepEqual(pictures.map((p) => p.name).sort(), ['01_jet_graph.png', '01_jet_trail.png', '02_linear_graph.png', '02_linear_trail.png']);
  assert.ok(pictures.every((p) => p.png.subarray(1, 4).toString('ascii') === 'PNG'));
});

test('cli: motion, trail and graph write their files under out/<shot id>, and check shows the short form', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const cli = join(root, 'bin', 'skink3.mjs');
  const demo = join(root, 'examples', 'demo', 'scene.ts');
  const dir = mkdtempSync(join(tmpdir(), 'skink3-motion-'));
  const run = (...args: string[]): string => {
    const r = spawnSync(process.execPath, [cli, ...args, '--cache', join(dir, 'cache'), '--cpu'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `${args.join(' ')}\n${r.stderr}`);
    return r.stdout;
  };
  try {
    // Findings are warnings: the command succeeds, prints them and writes the JSON report.
    const text = run('motion', demo, '--pictures', '--top', '2');
    assert.match(text, /^motion demo: 900 frames \(15\.00 s\); 64 placed nodes, 17 of them rigid bodies, 8 springs, 8 emitters, 7 links\n/);
    assert.match(text, /\n\d+ warning\(s\): /);
    assert.match(text, /\nsprings: 8 spring-driven node\(s\), 8 responded\n/);
    const json = JSON.parse(readFileSync(join(dir, 'out', 'demo', 'motion.json'), 'utf8')) as MotionReport;
    assert.equal(json.shot, 'demo');
    assert.equal(text.includes(`${json.findings.length} warning(s)`), true);
    const pictures = readdirSync(join(dir, 'out', 'demo', 'motion')).sort();
    assert.equal(pictures.length, 4, pictures.join(', '));
    assert.ok(pictures.every((f) => /^0[12]_[A-Za-z0-9_.-]+_(trail|graph)\.png$/.test(f)), pictures.join(', '));

    assert.match(run('trail', demo, '--node', 'n2,n3', '--time', '6.4,8'), /trail of n2, n3: frames 384-480, a ghost every 3 \(33 ghosts\), stage space, \d+x\d+: /);
    assert.ok(existsSync(join(dir, 'out', 'demo', 'trail_n2+n3_00384-00480.png')));
    assert.match(run('trail', demo, '--node', 'n2', '--from', '400', '--to', '440', '--every', '1', '--space', 'screen'), /frames 400-440, a ghost every 1 \(41 ghosts\), screen space/);
    assert.ok(existsSync(join(dir, 'out', 'demo', 'trail_n2_00400-00440_screen.png')));
    assert.match(run('graph', demo, '--camera'), /graph of \(camera\): frames 0-899, 3 panel\(s\): /);
    assert.ok(existsSync(join(dir, 'out', 'demo', 'graph_camera.png')));
    assert.match(run('graph', demo, '--node', 'core', '--time', '0,3'), /graph of core: frames 0-180, /);
    assert.ok(existsSync(join(dir, 'out', 'demo', 'graph_core_00000-00180.png')));

    const check = run('check', demo);
    assert.match(check, /\nmotion: \d+ warning\(s\): .*\n {2}~ warning: /);
    assert.match(check, /`skink3 motion <scene>` prints the full report, and with --pictures draws the worst\nchecks passed with \d+ warning\(s\)\n$/);

    const bad = spawnSync(process.execPath, [cli, 'trail', demo, '--node', 'nobody', '--cache', join(dir, 'cache')], { cwd: dir, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /skink3: trail: there is no node "nobody"/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
