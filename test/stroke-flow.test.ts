import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, compileShot, evaluate, frameRaw, group, intended, layer, reviewMotion, sampleMotion, shot, stroke, type ShotSpec, type StrokeItem } from '../src/index.ts';

// Dashes that flow along a stroke (flow): the dash pattern runs along the line at a speed, or at speeds keyed over the
// shot, joined smoothly. It is opt-in: a dashed stroke without it keeps its dashes where they are.

const WIDTH = 480;

function make(o: { flow?: number | [number, number][]; least?: number; sampled?: boolean; seconds?: number; intended?: ShotSpec['intended'] } = {}): ShotSpec {
  const line = stroke({ id: 'line', points: [[-700, 0], [700, 0]], color: 'accent.aqua', width: 6, dash: [10, 10], ...(o.flow === undefined ? {} : { flow: o.flow }), ...(o.least === undefined ? {} : { least: o.least }) });
  return shot({
    id: 'tiny', seconds: o.seconds ?? 2, seed: 1, palette, strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.abyss' }, atmosphere: 'mid.mist', vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'map', depth: 0, nodes: o.sampled ? [group({ id: 'set', children: [line] })] : [line], ...(o.sampled ? { sampledBackdrop: { group: 'set', frames: [30] } } : {}) })],
    ...(o.intended ? { intended: o.intended } : {}),
  });
}

async function hash(spec: ShotSpec, frame: number): Promise<string> {
  const c = compileShot(spec);
  return createHash('sha256').update(await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false })).digest('hex');
}

async function item(spec: ShotSpec, frame: number): Promise<StrokeItem> {
  const c = compileShot(spec);
  return evaluate(c, await bakeShot(c), frame, 'en').layers[0]!.items.find((i) => i.kind === 'stroke') as StrokeItem;
}

test('flow: what it refuses', () => {
  assert.throws(() => stroke({ id: 's', points: [[0, 0], [100, 0]], color: 'accent.aqua', flow: 30 }), /flow runs the dashes of a stroke along it: give dash/);
  assert.throws(() => stroke({ id: 's', points: [[0, 0], [100, 0]], color: 'accent.aqua', dash: [4, 4], flow: 20000 }), /flow must be a number in -10000\.\.10000/);
  assert.throws(() => stroke({ id: 's', points: [[0, 0], [100, 0]], color: 'accent.aqua', dash: [4, 4], flow: [[1, 30], [2, 0]] }), /the first key of flow is at 0 seconds/);
  assert.throws(() => stroke({ id: 's', points: [[0, 0], [100, 0]], color: 'accent.aqua', dash: [4, 4], flow: [[0, 30], [2, 0], [1, 5]] }), /the keys of flow must be in order of time/);
  // A sampled backdrop blends its pictures: dashes that flow in it would cross-fade, so they are drawn outside it.
  assert.throws(() => make({ flow: 30, sampled: true }), /"line" has dashes that flow, which a sampled picture would blend/);
});

test('flow: opt-in: a dashed stroke without it is the data and the picture it was', async () => {
  const plain = make();
  assert.equal('flow' in (plain.layers[0]!.nodes[0] as object), false);
  assert.equal('flow' in (await item(plain, 60)), false);
  assert.equal(await hash(plain, 0), await hash(plain, 60), 'its dashes stay');
  // A flow of 0 is a flow that has not started: the picture is that of the stroke without it.
  assert.equal(await hash(make({ flow: 0 }), 60), await hash(plain, 60));
});

test('flow: the dashes run along the line at its speed, a period a period, and keys change it smoothly', async () => {
  // A dash of 10 and a gap of 10 with round ends of a line 6 wide: a period of 26 units. At 26 units a second the
  // pattern has run one period in a second, and the frame is the first one again.
  const flowing = make({ flow: 26 });
  assert.equal((await item(flowing, 30)).flow, 13);
  assert.notEqual(await hash(flowing, 30), await hash(flowing, 0));
  assert.equal(await hash(flowing, 60), await hash(flowing, 0));
  // Keys: at rest at first, then speeding up to 60 units a second over a second, smoothly.
  const keyed = make({ flow: [[0, 0], [1, 60]] });
  assert.equal((await item(keyed, 0)).flow, 0);
  assert.ok(Math.abs((await item(keyed, 60)).flow! - 30) < 1e-9, 'the mean of the two speeds over the second');
  assert.ok(Math.abs((await item(keyed, 90)).flow! - 60) < 1e-9, 'then 60 a second');
  // Backwards: a negative speed runs the pattern toward the first point.
  assert.equal((await item(make({ flow: -26 }), 30)).flow, -13);
});

test('flow: the motion review knows it: a flow is life, a slow flow is clean, a flow that strobes is found, and an intended one is not', async () => {
  const findings = async (spec: ShotSpec): Promise<string[]> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c)).report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel}`);
  };
  // The sound scene: dashes that run a fifth of their period a frame.
  assert.deepEqual((await findings(make({ flow: 26 * 60 * 0.2, seconds: 3 }))).filter((f) => f.includes('line')), []);
  // While it flows, the stroke changes on screen at every frame: it is life where it lies.
  const c = compileShot(make({ flow: 30 }));
  const s = sampleMotion(c, await bakeShot(c)).placed.find((p) => p?.id === 'line')!;
  assert.equal(s.still, false);
  assert.ok(s.life![60]! - s.life![59]! > 0.4);
  // The planted defect: half a period a frame and more: the pattern strobes, as a wheel's spokes do.
  assert.deepEqual(await findings(make({ flow: 26 * 60 * 0.6 })), ['too-fast line flow']);
  // What is meant is not reported.
  assert.deepEqual(await findings(make({ flow: 26 * 60 * 0.6, intended: [intended('line', 'too-fast', 'a shimmer')] })), []);
});
