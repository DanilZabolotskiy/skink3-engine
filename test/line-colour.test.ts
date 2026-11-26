import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  colorTo,
  compileShot,
  evaluate,
  fillTo,
  flatItems,
  frameRaw,
  group,
  IntentError,
  layer,
  link,
  pulse,
  resolveColor,
  reviewContrast,
  reviewMotion,
  sceneEvents,
  shot,
  stroke,
  widthTo,
  type ColorRef,
  type Key,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';

// A colour key on a line: colorTo eases the colour of a stroke or of a link from the colour it has to another colour
// of the palette, as fillTo does the fill of a shape.

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

/** A broad run of light across the stage, bright until a key dims it. */
const run = (extra: object = {}): LayerSpec['nodes'] => [stroke({ id: 'run', points: [[-700, 100], [-200, 0], [600, 40]], color: 'accent.azure', width: 60, ...extra })];

/** Two posts and a wire between them. */
const wire = (extra: object = {}): LayerSpec['nodes'] => [
  circle({ id: 'a', at: [-500, -200], r: 40, fill: 'mid.mist' }),
  circle({ id: 'b', at: [500, -200], r: 40, fill: 'mid.mist' }),
  link({ id: 'wire', from: 'a', to: 'b', color: 'dark.navy', width: 14, ...extra }),
];

async function compiled(spec: ShotSpec): Promise<{ c: ReturnType<typeof compileShot>; bake: Awaited<ReturnType<typeof bakeShot>> }> {
  const c = compileShot(spec);
  return { c, bake: await bakeShot(c) };
}

/** The colour of a line at a moment, as its item carries it, or undefined when the item carries none. */
async function colourOf(spec: ShotSpec, id: string): Promise<(seconds: number) => string | undefined> {
  const { c, bake } = await compiled(spec);
  return (seconds) => {
    const item = flatItems(evaluate(c, bake, Math.round(seconds * 60), 'en').layers[0]!.items).find((i) => i.node.id === id);
    assert.ok(item && (item.kind === 'stroke' || item.kind === 'link'), `"${id}" is drawn at ${seconds} s`);
    return item.color;
  };
}

async function raw(spec: ShotSpec, frame: number): Promise<Buffer> {
  const { c, bake } = await compiled(spec);
  return frameRaw(c, bake, frame, { width: WIDTH, lang: 'en', gpu: false });
}

const hash = async (spec: ShotSpec, frame: number): Promise<string> => createHash('sha256').update(await raw(spec, frame)).digest('hex');

test('line colour: colorTo eases the colour of a stroke and of a link to another colour of the palette; keys chain', async () => {
  assert.deepEqual(colorTo('run', { at: 2, to: 'dark.navy' }), { kind: 'colorTo', target: 'run', at: 2, to: 'dark.navy', dur: 0.6, profile: 'ease', ramp: 0.3 });
  const azure = resolveColor(palette, 'accent.azure');
  const navy = resolveColor(palette, 'dark.navy');
  const amber = resolveColor(palette, 'accent.amber');
  const dimmed = await colourOf(make(run(), [colorTo('run', { at: 1, to: 'dark.navy', dur: 1 })]), 'run');
  assert.equal(dimmed(0.5), azure, 'before its key a stroke has the colour it was given');
  const midway = dimmed(1.5)!;
  assert.ok(midway !== azure && midway !== navy, `half way it is between the two: ${midway}`);
  assert.equal(dimmed(2), navy);
  assert.equal(dimmed(3.5), navy, 'and it stays');
  // A second key takes over from the colour the first has reached at its moment.
  const chained = await colourOf(make(run(), [colorTo('run', { at: 1, to: 'dark.navy', dur: 1 }), colorTo('run', { at: 1.5, to: 'accent.amber', dur: 1 })]), 'run');
  assert.equal(chained(1.5), midway);
  assert.equal(chained(3), amber);
  // A link the same.
  const warmed = await colourOf(make(wire(), [colorTo('wire', { at: 1, to: 'accent.amber', dur: 1 })]), 'wire');
  assert.equal(warmed(0.5), navy);
  assert.equal(warmed(2.5), amber);
});

test('line colour: what is drawn from the colour follows it, so a line keyed to a colour is the line made in it', async () => {
  const keyedTo = (nodes: LayerSpec['nodes'], id: string, extra: Key[] = []): ShotSpec => make(nodes, [colorTo(id, { at: 0.5, to: 'accent.amber', dur: 0.5 }), ...extra]);
  // A stroke: its line, its glow, and the light that runs along it in the colour of the line.
  const lit: Key[] = [pulse('run', { at: 1.5, dur: 1.5 })];
  assert.equal(await hash(keyedTo(run({ glow: 0.7 }), 'run', lit), 150), await hash(make(run({ glow: 0.7, color: 'accent.amber' }), lit), 150));
  // A wall: its side follows the colour of its line when it has no side of its own.
  const wall = (color: ColorRef): LayerSpec['nodes'] => [stroke({ id: 'w', points: [[-300, 0], [300, 0]], smooth: 0, color, width: 10, rise: 50 })];
  assert.equal(await hash(keyedTo(wall('accent.azure'), 'w'), 120), await hash(make(wall('accent.amber')), 120));
  // A link: its line, its glow and its pulses, which have no colour of their own.
  const sent: Key[] = [pulse('wire', { at: 1.5, dur: 1.5, bump: 0 })];
  assert.equal(await hash(keyedTo(wire({ glow: 0.6 }), 'wire', sent), 150), await hash(make(wire({ glow: 0.6, color: 'accent.amber' }), sent), 150));
  // Lights with a colour of their own keep it.
  const own = { pulseColor: 'light.mint' };
  assert.equal(await hash(keyedTo(wire(own), 'wire', sent), 150), await hash(make(wire({ ...own, color: 'accent.amber' }), sent), 150));
  assert.equal(await hash(keyedTo(run(own), 'run', lit), 150), await hash(make(run({ ...own, color: 'accent.amber' }), lit), 150));
  // A key of the colour and a key of the width go together.
  const both: Key[] = [widthTo('run', { at: 0.5, to: 20, dur: 0.6 })];
  assert.equal(await hash(keyedTo(run(), 'run', both), 150), await hash(make(run({ color: 'accent.amber' }), both), 150));
});

test('line colour: the contrast review judges a stroke by the colour it has at the frame it looks at', async () => {
  const asked = { contrast: { nodes: ['run'], lightness: 10, colour: 18 } };
  const contrast = async (spec: ShotSpec): Promise<string[]> => {
    const { c, bake } = await compiled(spec);
    const report = reviewContrast(c, bake);
    assert.ok(report, 'the shot asks for the review');
    return report.findings.map((f) => `${f.subject} ${f.from}-${f.to}`);
  };
  assert.deepEqual(await contrast(make(run(), [], 4, asked)), []);
  const fading = await contrast(make(run(), [colorTo('run', { at: 1, to: 'deep.night', dur: 0.5 })], 4, asked));
  assert.ok(fading.length === 1 && /^run (\d+)-239$/.test(fading[0]!) && Number(fading[0]!.split(' ')[1]!.split('-')[0]) > 60, fading.join('; '));
});

test('line colour: colorTo is refused where it means nothing, and fillTo on a line points to it', () => {
  const refused = (make: () => unknown, words: RegExp): void => {
    assert.throws(make, (e: unknown) => e instanceof IntentError && words.test(e.message));
  };
  refused(() => colorTo('run', { at: 1, to: '#ff0000' }), /palette reference/);
  refused(() => colorTo('run', { at: 1, to: 'accent.amber', dur: 0 }), /dur must be a number/);
  refused(() => colorTo('run', { at: 1, to: 'accent.amber', profile: 'settle' as 'ease' }), /profile/);
  refused(() => colorTo('run', { at: 1, to: 'accent.amber', profile: 'steady', ramp: 0.2 }), /ramp applies/);
  refused(() => colorTo('run', { at: 1, to: 'accent.amber', sound: 'chime' } as never), /unknown option "sound"/);
  // A shape has a fill, a group has no colour; a colour the palette does not have is refused when the shot is compiled.
  const lamp = [circle({ id: 'lamp', r: 80, fill: 'dark.indigo' })];
  assert.throws(() => compileShot(make(lamp, [colorTo('lamp', { at: 1, to: 'accent.amber' })])), /colorTo cannot target shape "lamp"; it applies to strokes and links; the colour of a shape is keyed by fillTo/);
  assert.throws(() => compileShot(make([group({ id: 'g', children: lamp })], [colorTo('g', { at: 1, to: 'accent.amber' })])), /colorTo cannot target group "g"; it applies to strokes and links$/);
  assert.throws(() => compileShot(make(run(), [colorTo('run', { at: 1, to: 'accent.nothing' })])), /run.*colorTo at 1 s/);
  assert.throws(() => compileShot(make(run(), [fillTo('run', { at: 1, to: 'accent.amber' })])), /fillTo cannot target stroke "run"; it applies to shapes; the colour of a line is keyed by colorTo/);
  assert.throws(() => compileShot(make(wire(), [fillTo('wire', { at: 1, to: 'accent.amber' })])), /fillTo cannot target link "wire"; it applies to shapes; the colour of a line is keyed by colorTo/);
});

test('line colour: it is opt-in: a line without a key has no track, its item carries no colour, and the frames before a key are the same', async () => {
  for (const [nodes, id] of [[run({ glow: 0.5 }), 'run'], [wire({ glow: 0.5 }), 'wire']] as const) {
    const spec = make(nodes);
    const c = compileShot(spec);
    assert.equal(c.byId.get(id)!.fill, null);
    assert.equal((await colourOf(spec, id))(1), undefined);
    assert.ok(!JSON.stringify(spec).includes('colorTo'));
    const keyed = make(nodes, [colorTo(id, { at: 1.5, to: 'accent.amber' })]);
    for (const frame of [0, 45, 89]) assert.equal(await hash(keyed, frame), await hash(spec, frame), `${id} frame ${frame}`);
    assert.notEqual(await hash(keyed, 200), await hash(spec, 200));
  }
});

test('line colour: the motion review knows it: a colour that pops is a jump, an eased change is clean, and a changing colour is life', async () => {
  const review = async (spec: ShotSpec): Promise<ReturnType<typeof reviewMotion>> => {
    const { c, bake } = await compiled(spec);
    return reviewMotion(c, bake);
  };
  const flagged = async (spec: ShotSpec): Promise<string[]> => (await review(spec)).report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel}`).sort();
  // The planted defects: a bright run goes dark, and a dark wire bright, within three frames.
  const popped = await review(make(run(), [colorTo('run', { at: 1, to: 'deep.night', dur: 0.05 })]));
  assert.deepEqual(popped.report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel}`), ['jump run fill']);
  assert.match(popped.report.findings[0]!.detail, /^colour: a channel of the colour of the line changed by/);
  assert.deepEqual(await flagged(make(wire(), [colorTo('wire', { at: 1, to: 'accent.amber', dur: 0.05 })])), ['jump wire fill']);
  // The sound scenes: the same changes given their time, and a flash that comes and goes.
  assert.deepEqual(await flagged(make(run(), [colorTo('run', { at: 1, to: 'deep.night' })])), []);
  assert.deepEqual(await flagged(make(wire(), [colorTo('wire', { at: 1, to: 'accent.amber' })])), []);
  assert.deepEqual(await flagged(make(run(), [colorTo('run', { at: 1, to: 'light.mint', dur: 0.2 }), colorTo('run', { at: 1.3, to: 'accent.azure', dur: 0.5 })])), []);
  // A colour is judged where it is seen: a line too small to see, or one drawn nowhere yet, pops unseen.
  assert.deepEqual(await flagged(make(run({ points: [[-100, 0], [100, 0]], scale: 0.01 }), [colorTo('run', { at: 1, to: 'deep.night', dur: 0.05 })])), []);
  assert.deepEqual(await flagged(make(wire({ opacity: 0 }), [colorTo('wire', { at: 1, to: 'accent.amber', dur: 0.05 })])), []);
  // The series hold the change of the colour per frame; a line without a key has none.
  const series = (await review(make(run(), [colorTo('run', { at: 1, to: 'dark.navy', dur: 1 })]))).series;
  const s = series.placed.find((p) => p?.id === 'run')!;
  assert.ok(s.fill !== null && s.fill[30] === 0 && s.fill[90]! > 0.01 && s.fill[200] === 0);
  const linkSeries = (await review(make(wire(), [colorTo('wire', { at: 1, to: 'accent.amber', dur: 1 })]))).series.links[0]!;
  assert.ok(linkSeries.fill !== null && linkSeries.fill[30] === 0 && linkSeries.fill[90]! > 0.01 && linkSeries.fill[200] === 0);
  assert.equal((await review(make(run()))).series.placed.find((p) => p?.id === 'run')!.fill, null);
  assert.equal((await review(make(wire()))).series.links[0]!.fill, null);
  // Life: lines that only lie there are a hold; a line whose colour breathes keeps its part of the frame alive.
  const breathing = (id: string): Key[] => [0, 1.5, 3, 4.5, 6].map((at, i) => colorTo(id, { at, to: i % 2 === 0 ? 'accent.amber' : 'dark.navy', dur: 1.4 }));
  for (const [nodes, id] of [[run(), 'run'], [wire(), 'wire']] as const) {
    const held = await flagged(make(nodes, [], 8));
    assert.ok(held.includes('dead-area (frame) hold'), held.join('; '));
    const alive = await flagged(make(nodes, breathing(id), 8));
    assert.ok(!alive.some((f) => f.startsWith('dead-area (frame) ')), `${id}: ${alive.join('; ')}`);
    // A colorTo is no event: it makes no sound.
    const { c, bake } = await compiled(make(nodes, breathing(id), 8));
    assert.deepEqual(sceneEvents(c, bake), []);
  }
});
