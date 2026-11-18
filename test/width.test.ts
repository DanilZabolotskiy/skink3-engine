import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  evaluate,
  flatItems,
  frameRaw,
  group,
  heightFor,
  IntentError,
  layer,
  link,
  pulse,
  renderGraph,
  reviewMotion,
  sceneEvents,
  shot,
  stroke,
  widthTo,
  type Key,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';

// A line whose width changes over time: widthTo changes the width of a link or of a stroke where the line lies.

const WIDTH = 960;

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], seconds = 4): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 3,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    // A still camera: a place of the stage is that place on screen, moved by half a frame.
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

/** A straight link of 800 units between two anchors, a hair of 4 units. */
const wire = (extra: object = {}): LayerSpec['nodes'] => [
  link({ id: 'wire', from: 'a', to: 'b', color: 'accent.pink', pulseColor: 'accent.amber', bend: 0, gap: 0, width: 4, ...extra }),
  group({ id: 'a', at: [-400, 0] }),
  group({ id: 'b', at: [400, 0] }),
];

/** A straight stroke of 600 units, 8 units wide. */
const line = (extra: object = {}): LayerSpec['nodes'] => [stroke({ id: 's', points: [[-300, 0], [300, 0]], smooth: 0, color: 'accent.pink', width: 8, ...extra })];

/** The item of a line at a moment. */
async function itemsOf(spec: ShotSpec, id: string): Promise<(seconds: number) => { width?: number; curve?: unknown }> {
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  return (seconds) => {
    const item = flatItems(evaluate(c, bake, Math.round(seconds * 60), 'en').layers[0]!.items).find((i) => i.node.id === id);
    assert.ok(item && (item.kind === 'link' || item.kind === 'stroke'), `"${id}" is drawn at ${seconds} s`);
    return item;
  };
}

/** The width of a line at a moment, as its item carries it. */
async function widthOf(spec: ShotSpec, id = 'wire'): Promise<(seconds: number) => number> {
  const item = await itemsOf(spec, id);
  return (seconds) => {
    const w = item(seconds).width;
    assert.ok(w !== undefined, `the item of "${id}" carries its width at ${seconds} s`);
    return w;
  };
}

/** True where the pixel at a place of the stage has the colour of a line or of its light (bright, and red). */
async function filled(spec: ShotSpec, frame: number, x: number, y: number): Promise<boolean> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
  const k = WIDTH / 1920;
  return raw[(Math.round(heightFor(WIDTH) / 2 + y * k) * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4]! > 150;
}

async function hash(spec: ShotSpec, frame: number): Promise<string> {
  const c = compileShot(spec);
  return createHash('sha256').update(await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false })).digest('hex');
}

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

test('width: widthTo brings a line to a new width, shoots past it and settles; keys chain from the width reached', async () => {
  assert.deepEqual(widthTo('wire', { at: 2, to: 24 }), { kind: 'widthTo', target: 'wire', at: 2, to: 24, dur: 0.6, overshoot: 0.15 });
  // A hair swells: it passes its new width by 0.15 of the change, comes back and stays.
  const swell = await widthOf(make(wire(), [widthTo('wire', { at: 1, to: 24, dur: 1 })]));
  assert.ok(near(swell(0), 4) && near(swell(1), 4), 'the width it was given, until the key');
  assert.ok(near(swell(1.5), 24 + 0.15 * 20, 1e-4), `the peak is half-way, 0.15 of the change past the new width: ${swell(1.5)}`);
  let peak = -Infinity;
  for (let f = 60; f <= 120; f++) peak = Math.max(peak, swell(f / 60));
  assert.ok(near(peak, 27, 1e-4), `and nowhere wider: ${peak}`);
  assert.ok(near(swell(2), 24) && near(swell(3.9), 24), 'and then it is 24 wide');
  // Without an overshoot it only arrives.
  const plain = await widthOf(make(wire(), [widthTo('wire', { at: 1, to: 24, dur: 1, overshoot: 0 })]));
  let widest = -Infinity;
  for (let f = 60; f <= 120; f++) widest = Math.max(widest, plain(f / 60));
  assert.ok(widest <= 24 + 1e-9 && plain(1.5) > 20 && near(plain(2), 24));
  // Keys chain: it swells, and thins from where it is when the second key takes over.
  const chained = await widthOf(make(wire(), [widthTo('wire', { at: 0, to: 20, dur: 1, overshoot: 0 }), widthTo('wire', { at: 0.5, to: 6, dur: 1, overshoot: 0 }), widthTo('wire', { at: 3, to: 4, dur: 0.5, overshoot: 0 })]));
  assert.ok(near(chained(0.5), 4 + 16 * (1 - 0.5 ** 3), 1e-4), `half-way through its first key when the second takes over: ${chained(0.5)}`);
  assert.ok(chained(1) < chained(0.5) && near(chained(1.5), 6) && near(chained(2.9), 6) && near(chained(3.5), 4));
  // A line that thins dips below its new width by the overshoot of the change, but never below half of it.
  const mild = await widthOf(make(wire({ width: 24 }), [widthTo('wire', { at: 1, to: 18, dur: 1 })]));
  assert.ok(near(mild(1.5), 18 - 0.15 * 6, 1e-4) && near(mild(2), 18), `${mild(1.5)}`);
  const hair = await widthOf(make(wire({ width: 24 }), [widthTo('wire', { at: 1, to: 2, dur: 1, overshoot: 0.5 })]));
  let thinnest = Infinity;
  for (let f = 60; f <= 120; f++) thinnest = Math.min(thinnest, hair(f / 60));
  assert.ok(near(thinnest, 1, 1e-4) && near(hair(2), 2), `it stops at half of its new width: ${thinnest}`);
});

test('width: a stroke changes its width the same way, in its own units, and keeps its line', async () => {
  const spec = make(line({ scale: 2 }), [widthTo('s', { at: 1, to: 30, dur: 1 })]);
  const width = await widthOf(spec, 's');
  assert.ok(near(width(0.5), 8) && near(width(1.5), 30 + 0.15 * 22, 1e-4) && near(width(3), 30));
  // The line is where it was: drawn at twice its size, it is 60 units thick in the end and as long as before.
  assert.equal(await filled(spec, 30, 0, 14), false);
  assert.equal(await filled(spec, 200, 0, 26), true);
  assert.equal(await filled(spec, 200, 0, 34), false);
  assert.equal(await filled(spec, 200, -590, 0), true);
  assert.equal(await filled(spec, 200, 640, 0), false, 'its round end reaches 30 units past its last point, and no farther');
  // The dashes of a dashed stroke stay where they are: each gets thicker, and the gap between two closes when the line is wide enough.
  const dashed = (to: number): ShotSpec => make(line({ dash: [40, 40] }), [widthTo('s', { at: 1, to, dur: 1, overshoot: 0 })]);
  // Dashes of 40 with clear gaps of 40: the first gap runs from -256 to -216, the second dash from -216 to -168.
  assert.equal(await filled(dashed(24), 30, -236, 0), false);
  assert.equal(await filled(dashed(24), 30, -190, 0), true);
  assert.equal(await filled(dashed(24), 30, -190, 9), false);
  assert.equal(await filled(dashed(24), 200, -236, 0), false, 'the gap is where it was');
  assert.equal(await filled(dashed(24), 200, -190, 9), true, 'and the dash beside it is thicker');
  assert.equal(await filled(dashed(60), 200, -236, 0), true, 'a line wider than the gap was has closed it');
});

test('width: the picture follows the width, the ends stay on their nodes, and the lights along the line widen with it', async () => {
  const spec = make(wire(), [widthTo('wire', { at: 1, to: 40, dur: 1 })]);
  // Beside the hair there is nothing; beside the thick line there is the line.
  assert.equal(await filled(spec, 30, 0, 0), true);
  assert.equal(await filled(spec, 30, 0, 12), false);
  assert.equal(await filled(spec, 200, 0, 12), true);
  assert.equal(await filled(spec, 200, 0, 28), false);
  // The curve between the two nodes is the curve it was.
  const item = await itemsOf(spec, 'wire');
  assert.deepEqual(item(0.5).curve, item(3).curve);
  assert.deepEqual(item(3).curve, [[-400, 0], [0, 0], [400, 0]]);
  // A light along it: its head is as wide as the line makes it at that moment.
  const lit = (keys: Key[]): ShotSpec => make(wire(), [...keys, pulse('wire', { at: 2.2, dur: 1.2, bump: 0 })]);
  const c = compileShot(lit([]));
  const bake = await bakeShot(c);
  let frame = -1;
  let head = 0;
  for (let f = 132; f < 204 && frame < 0; f++) {
    const it = flatItems(evaluate(c, bake, f, 'en').layers[0]!.items)[0]!;
    assert.ok(it.kind === 'link');
    if (it.pulses.length > 0 && it.pulses[0]!.head >= 0.5) {
      frame = f;
      head = it.pulses[0]!.head;
    }
  }
  assert.ok(frame > 0, 'the light passes the middle of the line');
  const x = -400 + 800 * head;
  assert.equal(await filled(lit([]), frame, x, 0), true);
  assert.equal(await filled(lit([]), frame, x, 26), false, 'the head of a light on a hair is a dot');
  assert.equal(await filled(lit([widthTo('wire', { at: 1, to: 40, dur: 1 })]), frame, x, 26), true, 'on the thick line it is as large as the line makes it');
});

test('width: what it refuses', () => {
  const bad = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, (e: unknown) => e instanceof Error && message.test(e.message), String(message));
  };
  bad(() => widthTo('wire', { at: 1, to: 24, ease: 'in' } as never), /widthTo\("wire"\): unknown option "ease" \(allowed: at, to, dur, overshoot\)/);
  bad(() => widthTo('wire', { at: 1 } as never), /to must be a number in 0\.5\.\.200/);
  bad(() => widthTo('wire', { at: 1, to: 0 }), /to must be a number in 0\.5\.\.200/);
  bad(() => widthTo('wire', { at: 1, to: 24, dur: 0.01 }), /dur must be a number in 0\.05\.\.60/);
  bad(() => widthTo('wire', { at: 1, to: 24, overshoot: 0.8 }), /overshoot must be a number in 0\.\.0\.5/);
  assert.ok(IntentError);
  // It is for lines: a shape has a size, not a width.
  bad(() => make([circle({ id: 'c', r: 10, fill: 'accent.aqua' })], [widthTo('c', { at: 0, to: 24 })]), /widthTo cannot target shape "c"; it applies to links and strokes/);
  // A link is at most as wide as link() lets it be.
  bad(() => make(wire(), [widthTo('wire', { at: 0, to: 120 })]), /widthTo\("wire"\): to is 120, and a link is at most 80 wide/);
  assert.doesNotThrow(() => make(line(), [widthTo('s', { at: 0, to: 120 })]));
  bad(() => make(wire(), [widthTo('wire', { at: 9, to: 24 })]), /widthTo\("wire"\) starts at 9 s, after the shot ends/);
});

test('width: it is opt-in: a line without a widthTo is the data and the picture it was', async () => {
  // No track, and an item that carries no width of its own.
  for (const [nodes, id] of [[wire(), 'wire'], [line(), 's'], [line({ dash: [40, 40] }), 's']] as const) {
    const spec = make(nodes);
    const c = compileShot(spec);
    assert.equal(c.byId.get(id)!.width, null);
    assert.equal((await itemsOf(spec, id))(1).width, undefined);
    assert.ok(!JSON.stringify(spec).includes('widthTo'));
    // The frames before a key are those of the shot without it.
    const keyed = make(nodes, [widthTo(id, { at: 1.5, to: 30 })]);
    for (const frame of [0, 45, 90]) assert.equal(await hash(keyed, frame), await hash(spec, frame), `${id}, frame ${frame}`);
    assert.notEqual(await hash(keyed, 200), await hash(spec, 200));
  }
  // A line that is given a width is the line that a key brings to that width.
  const thick = make(wire({ width: 30 }));
  const grown = make(wire(), [widthTo('wire', { at: 0.5, to: 30, dur: 0.5 })]);
  assert.equal(await hash(grown, 120), await hash(thick, 120));
});

test('width: the motion review knows it: a width that pops is a jump, an eased change is clean, and a changing width is life in the frame', async () => {
  const review = async (spec: ShotSpec): Promise<ReturnType<typeof reviewMotion>> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c));
  };
  const flagged = async (spec: ShotSpec): Promise<string[]> => (await review(spec)).report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel}`).sort();
  // The planted defect: the width of a line changes by 76 units within three frames. On a link, and on a stroke.
  assert.deepEqual(await flagged(make(wire(), [widthTo('wire', { at: 1, to: 80, dur: 0.05, overshoot: 0 })])), ['jump wire width']);
  assert.deepEqual(await flagged(make(line(), [widthTo('s', { at: 1, to: 84, dur: 0.05, overshoot: 0 })])), ['jump s width']);
  // Without an overshoot a change is a plain ease-out, which starts at full speed: a large quick one is an abrupt start.
  assert.deepEqual(await flagged(make(wire(), [widthTo('wire', { at: 1, to: 80, dur: 0.3, overshoot: 0 })])), ['abrupt-start wire width']);
  assert.deepEqual(await flagged(make(line(), [widthTo('s', { at: 1, to: 84, dur: 0.3, overshoot: 0 })])), ['abrupt-start s width']);
  // The sound scenes: a hair that swells and thins again as the key makes it by itself, and a large change that is given its time.
  assert.deepEqual(await flagged(make(wire(), [widthTo('wire', { at: 0.5, to: 24 }), widthTo('wire', { at: 2.5, to: 4 })])), []);
  assert.deepEqual(await flagged(make(line(), [widthTo('s', { at: 0.5, to: 30 }), widthTo('s', { at: 2.5, to: 8 })])), []);
  assert.deepEqual(await flagged(make(wire(), [widthTo('wire', { at: 1, to: 80, dur: 0.3 })])), []);
  // What is measured is the width of the line in the units of its layer: a stroke drawn at twice its size is twice as wide.
  const linked = (await review(make(wire(), [widthTo('wire', { at: 1, to: 24, dur: 1 })]))).series.links[0]!;
  assert.ok(linked.width !== null && near(linked.width[0]!, 4) && near(linked.width[90]!, 27, 1e-4) && near(linked.width[200]!, 24));
  const scaled = make(line({ scale: 2 }), [widthTo('s', { at: 1, to: 30, dur: 1 })]);
  const placed = (await review(scaled)).series.placed[0]!;
  assert.ok(placed.width !== null && near(placed.width[0]!, 16) && near(placed.width[200]!, 60));
  // A line without a key has no such series.
  assert.equal((await review(make(wire(), [pulse('wire', { at: 1 })]))).series.links[0]!.width, null);
  assert.equal((await review(make(line(), [pulse('s', { at: 1 })]))).series.placed[0]!.width, null);
  // Life: a line that only lies there is a hold; one whose width changes keeps its part of the frame alive.
  const breathing = (id: string, thin: number): Key[] => [0, 1.5, 3, 4.5, 6].map((at, i) => widthTo(id, { at, to: i % 2 === 0 ? 30 : thin, dur: 1.4 }));
  for (const [nodes, id, thin] of [[wire(), 'wire', 4], [line(), 's', 8]] as const) {
    const held = await flagged(make(nodes, [], 8));
    assert.ok(held.includes('dead-area (frame) hold'), held.join('; '));
    const alive = await flagged(make(nodes, breathing(id, thin), 8));
    assert.ok(!alive.some((f) => f.startsWith('dead-area (frame) ')), alive.join('; '));
  }
  // A widthTo is no event: it makes no sound.
  const c = compileShot(make(wire(), breathing('wire', 4), 8));
  assert.deepEqual(sceneEvents(c, await bakeShot(c)), []);
  // The graph of a stroke shows its width over time.
  const graph = await renderGraph((await review(scaled)).series, { subject: 's' });
  assert.ok(graph.panels.some((title) => title.startsWith('width of the line')), graph.panels.join('; '));
});
