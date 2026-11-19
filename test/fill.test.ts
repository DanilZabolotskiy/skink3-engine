import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  evaluate,
  fillTo,
  flatItems,
  frameRaw,
  group,
  heightFor,
  IntentError,
  layer,
  renderGraph,
  resolveColor,
  reviewContrast,
  reviewMotion,
  scaleTo,
  sceneEvents,
  shot,
  stroke,
  type Key,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';

// A colour key: fillTo eases the fill of a shape from the colour it has to another colour of the palette.

const WIDTH = 480;

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], seconds = 4, extra: object = {}): ShotSpec {
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
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
    ...extra,
  });
}

/** A lamp of radius 80 in the middle of the stage, dark until a key lights it. */
const lamp = (extra: object = {}): LayerSpec['nodes'] => [circle({ id: 'lamp', r: 80, fill: 'dark.indigo', lit: false, ...extra })];

/** The fill of the lamp at a moment, as its item carries it, or undefined when the item carries none. */
async function fillOf(spec: ShotSpec, id = 'lamp'): Promise<(seconds: number) => string | undefined> {
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  return (seconds) => {
    const item = flatItems(evaluate(c, bake, Math.round(seconds * 60), 'en').layers[0]!.items).find((i) => i.node.id === id);
    assert.ok(item && item.kind === 'shape', `"${id}" is drawn at ${seconds} s`);
    return item.fill;
  };
}

async function raw(spec: ShotSpec, frame: number): Promise<Buffer> {
  const c = compileShot(spec);
  return frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
}

/** The pixel at a place of the stage (units, origin at the centre). */
async function pixel(spec: ShotSpec, frame: number, x: number, y: number): Promise<[number, number, number]> {
  const pixels = await raw(spec, frame);
  const k = WIDTH / 1920;
  const i = (Math.round(heightFor(WIDTH) / 2 + y * k) * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4;
  return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
}

const hash = async (spec: ShotSpec, frame: number): Promise<string> => createHash('sha256').update(await raw(spec, frame)).digest('hex');

test('fill: fillTo eases the fill of a shape to another colour of the palette; keys chain from the colour reached', async () => {
  assert.deepEqual(fillTo('lamp', { at: 2, to: 'accent.amber' }), { kind: 'fillTo', target: 'lamp', at: 2, to: 'accent.amber', dur: 0.6, profile: 'ease', ramp: 0.3 });
  const amber = resolveColor(palette, 'accent.amber');
  const indigo = resolveColor(palette, 'dark.indigo');
  const coral = resolveColor(palette, 'accent.coral');
  const lit = await fillOf(make(lamp(), [fillTo('lamp', { at: 1, to: 'accent.amber', dur: 1 })]));
  assert.equal(lit(0.5), indigo, 'before its key a shape has the fill it was given');
  const midway = lit(1.5)!;
  assert.ok(midway !== indigo && midway !== amber, `half way it is between the two: ${midway}`);
  assert.equal(lit(2), amber);
  assert.equal(lit(3.5), amber, 'and it stays');
  // A second key takes over from the colour the first has reached at its moment.
  const chained = await fillOf(make(lamp(), [fillTo('lamp', { at: 1, to: 'accent.amber', dur: 1 }), fillTo('lamp', { at: 1.5, to: 'accent.coral', dur: 1 })]));
  assert.equal(chained(1.5), midway);
  assert.equal(chained(3), coral);
  // Everything drawn from the fill follows it: a lamp keyed to amber is the lamp that was made amber.
  const keyed = make(lamp({ glow: 0.8, lit: true }), [fillTo('lamp', { at: 0.5, to: 'accent.amber', dur: 0.5 })]);
  const made = make(lamp({ glow: 0.8, lit: true, fill: 'accent.amber' }));
  assert.equal(await hash(keyed, 120), await hash(made, 120));
  // Its glow lifts the sky in its new colour: around a lamp that is amber now the sky is warmer than around the dark one.
  const before = await pixel(keyed, 0, 0, -200);
  const after = await pixel(keyed, 120, 0, -200);
  assert.ok(after[0] > before[0], `the lift turns warm: red ${before[0]} -> ${after[0]}`);
  // The contrast review judges the shape by the fill it has at the frame it looks at.
  const asked = { contrast: { nodes: ['lamp'], lightness: 10, colour: 18 } };
  const contrast = async (spec: ShotSpec): Promise<string[]> => {
    const c = compileShot(spec);
    const report = reviewContrast(c, await bakeShot(c));
    assert.ok(report, 'the shot asks for the review');
    return report.findings.map((f) => `${f.subject} ${f.from}-${f.to}`);
  };
  assert.deepEqual(await contrast(make(lamp(), [], 4, asked)), []);
  const fading = await contrast(make(lamp(), [fillTo('lamp', { at: 1, to: 'deep.night', dur: 0.5 })], 4, asked));
  assert.ok(fading.length === 1 && /^lamp (\d+)-239$/.test(fading[0]!) && Number(fading[0]!.split(' ')[1]!.split('-')[0]) > 60, fading.join('; '));
});

test('fill: fillTo is refused where it means nothing', async () => {
  const refused = (make: () => unknown, words: RegExp): void => {
    assert.throws(make, (e: unknown) => e instanceof IntentError && words.test(e.message));
  };
  refused(() => fillTo('lamp', { at: 1, to: '#ff0000' }), /palette reference/);
  refused(() => fillTo('lamp', { at: 1, to: 'accent.amber', dur: 0 }), /dur must be a number/);
  refused(() => fillTo('lamp', { at: 1, to: 'accent.amber', profile: 'settle' as 'ease' }), /profile/);
  refused(() => fillTo('lamp', { at: 1, to: 'accent.amber', profile: 'steady', ramp: 0.2 }), /ramp applies/);
  // A node that has no fill of its own, and a colour the palette does not have, are refused when the shot is compiled.
  const line = [stroke({ id: 's', points: [[-100, 0], [100, 0]], color: 'accent.pink', width: 8 })];
  assert.throws(() => compileShot(make(line, [fillTo('s', { at: 1, to: 'accent.amber' })])), /fillTo cannot target stroke "s"; it applies to shapes/);
  assert.throws(() => compileShot(make([group({ id: 'g', children: lamp() })], [fillTo('g', { at: 1, to: 'accent.amber' })])), /fillTo cannot target group "g"/);
  assert.throws(() => compileShot(make(lamp(), [fillTo('lamp', { at: 1, to: 'accent.nothing' })])), /lamp.*fillTo at 1 s/);
});

test('fill: it is opt-in: a shape without a key has no track, its item carries no fill, and the frames before a key are the same', async () => {
  const spec = make(lamp({ glow: 0.6, lit: true }));
  const c = compileShot(spec);
  assert.equal(c.byId.get('lamp')!.fill, null);
  assert.equal((await fillOf(spec))(1), undefined);
  assert.ok(!JSON.stringify(spec).includes('fillTo'));
  const keyed = make(lamp({ glow: 0.6, lit: true }), [fillTo('lamp', { at: 1.5, to: 'accent.amber' })]);
  for (const frame of [0, 45, 90]) assert.equal(await hash(keyed, frame), await hash(spec, frame), `frame ${frame}`);
  assert.notEqual(await hash(keyed, 200), await hash(spec, 200));
});

test('fill: the motion review knows it: a fill that pops is a jump, an eased change is clean, and a changing fill is life in the frame', async () => {
  const review = async (spec: ShotSpec): Promise<ReturnType<typeof reviewMotion>> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c));
  };
  const flagged = async (spec: ShotSpec): Promise<string[]> => (await review(spec)).report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel}`).sort();
  // The planted defect: a dark lamp turns bright within three frames.
  assert.deepEqual(await flagged(make(lamp(), [fillTo('lamp', { at: 1, to: 'accent.amber', dur: 0.05 })])), ['jump lamp fill']);
  // The sound scenes: the same change given its time, and a flash that comes and goes.
  assert.deepEqual(await flagged(make(lamp(), [fillTo('lamp', { at: 1, to: 'accent.amber' })])), []);
  assert.deepEqual(await flagged(make(lamp(), [fillTo('lamp', { at: 1, to: 'light.mint', dur: 0.2 }), fillTo('lamp', { at: 1.3, to: 'dark.indigo', dur: 0.5 })])), []);
  // A fill is judged where it is seen: a lamp too small to see pops unseen.
  assert.deepEqual(await flagged(make(lamp({ scale: 0.01 }), [fillTo('lamp', { at: 1, to: 'accent.amber', dur: 0.05 })])), []);
  // The series holds the change of the fill per frame, and a shape without a key has none.
  const series = (await review(make(lamp(), [fillTo('lamp', { at: 1, to: 'accent.amber', dur: 1 })]))).series.placed[0]!;
  assert.ok(series.fill !== null && series.fill[30] === 0 && series.fill[90]! > 0.01 && series.fill[200] === 0);
  assert.equal((await review(make(lamp(), [scaleTo('lamp', { at: 1, to: 1.2 })]))).series.placed[0]!.fill, null);
  // Life: a lamp that only stands there is a hold; one whose colour breathes keeps its part of the frame alive.
  const breathing: Key[] = [0, 1.5, 3, 4.5, 6].map((at, i) => fillTo('lamp', { at, to: i % 2 === 0 ? 'accent.amber' : 'dark.indigo', dur: 1.4 }));
  const held = await flagged(make(lamp(), [], 8));
  assert.ok(held.includes('dead-area (frame) hold'), held.join('; '));
  const alive = await flagged(make(lamp(), breathing, 8));
  assert.ok(!alive.some((f) => f.startsWith('dead-area (frame) ')), alive.join('; '));
  // A fillTo is no event: it makes no sound.
  const c = compileShot(make(lamp(), breathing, 8));
  assert.deepEqual(sceneEvents(c, await bakeShot(c)), []);
  // The graph of the shape shows how fast its colour changes.
  const graph = await renderGraph((await review(make(lamp(), breathing, 8))).series, { subject: 'lamp' });
  assert.ok(graph.panels.some((title) => title.startsWith('change of its fill')), graph.panels.join('; '));
});
