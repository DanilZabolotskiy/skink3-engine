import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  arcPoints,
  bakeShot,
  circle,
  compileShot,
  drawOn,
  evaluate,
  fadeTo,
  flatItems,
  frameRaw,
  group,
  heightFor,
  IntentError,
  layer,
  link,
  moveTo,
  pathTable,
  popIn,
  pulse,
  reviewMotion,
  scaleTo,
  SceneError,
  sceneEvents,
  shot,
  solidTo,
  stroke,
  turnTo,
  type Key,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';

// A stroke: a line along a free-form path, drawn on over time, solid or dashed.

const WIDTH = 960;

test('visible curve subdivisions preserve the full path and timed reveal and pulses', async () => {
  const opts = { id: 'route', points: [[-260,0],[-100,-90],[80,70],[280,0]], color: 'accent.coral', width: 12, smooth: 1 } as const;
  const original = stroke(opts);
  assert.deepEqual(stroke({...opts,curveSteps:32}), original);
  assert.throws(() => stroke({...opts,curveSteps:3 as 2}), /curveSteps/);
  const coarse = stroke({...opts,curveSteps:2});
  assert.deepEqual(coarse.path, original.path);
  const keys = [drawOn('route',{at:0,dur:1}),pulse('route',{at:0,dur:1,length:80})];
  for (const frame of [10,35,60]) {
    async function current(node: typeof original) {
      const c=compileShot(make([node],keys));
      const state=evaluate(c,await bakeShot(c),frame,'en');
      const line=flatItems(state.layers[0]!.items).find(item=>item.kind==='stroke');
      assert.ok(line?.kind==='stroke');
      return [line.drawn,line.pulses];
    }
    assert.deepEqual(await current(coarse),await current(original));
  }
});

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

/** A straight line through the middle of the frame, from x = -400 to x = 400. */
const LINE = [[-400, 0], [400, 0]] as const;

/** The row of pixels through the middle of the frame at a frame of the shot: true where the line's colour is. */
async function row(spec: ShotSpec, frame: number, dy = 0): Promise<boolean[]> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
  const y = Math.round(heightFor(WIDTH) / 2 + dy * (WIDTH / 1920));
  const out: boolean[] = [];
  // accent.pink is bright and red; the background is dark.
  for (let x = 0; x < WIDTH; x++) out.push(raw[(y * WIDTH + x) * 4]! > 150);
  return out;
}

/** The share of the row between two places of the stage that is lit. */
function lit(pixels: boolean[], from: number, to: number): number {
  const a = Math.round((from + 960) * (WIDTH / 1920));
  const b = Math.round((to + 960) * (WIDTH / 1920));
  let n = 0;
  for (let x = a; x < b; x++) if (pixels[x]) n++;
  return n / (b - a);
}

/** The stroke of a shot as the evaluator lists it at a moment, or undefined while it is not drawn. */
async function itemAt(spec: ShotSpec, seconds: number, id = 's'): Promise<{ drawn: number; solid: number; xf: { x: number; y: number; rot: number; scale: number }; alpha: number } | undefined> {
  const c = compileShot(spec);
  const state = evaluate(c, await bakeShot(c), Math.round(seconds * 60), 'en');
  const hit = flatItems(state.layers[0]!.items).find((i) => i.kind === 'stroke' && i.node.id === id);
  return hit && hit.kind === 'stroke' ? hit : undefined;
}

test('stroke: a line through its points in its colour, as wide as it says, with round ends', async () => {
  const spec = make([stroke({ id: 's', points: LINE, color: 'accent.pink', width: 16 })]);
  const on = await row(spec, 0);
  assert.equal(lit(on, -390, 390), 1, 'the whole line');
  assert.equal(lit(on, -700, -420), 0, 'nothing before its first point');
  assert.equal(lit(on, 420, 700), 0, 'nothing after its last');
  // Half its width to each side, and no more.
  assert.equal(lit(await row(spec, 0, 6), -390, 390), 1);
  assert.equal(lit(await row(spec, 0, 12), -390, 390), 0);
  // Round ends: the line reaches half its width past its last point on its middle, and less at its edge.
  assert.ok(lit(on, 400, 408) > 0.7 && lit(await row(spec, 0, 6), 404, 408) === 0);

  // Smooth by default: a curve through the points. With smooth 0 the points are joined by straight lines.
  const bent = [[-400, 0], [0, -200], [400, 0]] as const;
  const top = (smooth: number): number => {
    const table = pathTable(stroke({ id: 's', points: bent, color: 'accent.pink', smooth }).path);
    // How high the line is a quarter of the way along x.
    let best = 0;
    for (let i = 0; i < table.xs.length; i++) if (Math.abs(table.xs[i]! + 200) < 8) best = Math.min(best, table.ys[i]!);
    return best;
  };
  assert.ok(Math.abs(top(0) + 100) < 6, `straight: ${top(0)}`);
  assert.ok(top(1) < -120, `a curve bulges past the straight line: ${top(1)}`);
  // The defaults.
  const plain = stroke({ id: 's', points: LINE, color: 'accent.pink' });
  assert.deepEqual([plain.width, plain.path.closed, plain.path.smooth, plain.dash, plain.solid, plain.opacity, plain.glow, plain.at, plain.rotation, plain.scale], [7, false, 1, null, 0, 1, 0, [0, 0], 0, 1]);
  assert.deepEqual([plain.drawn, plain.clipTo, plain.sound], [undefined, undefined, undefined], 'what is not said is not in the node');
});

test('stroke: drawOn draws it on from its first point, to a share, key after key, at the speed of its profile', async () => {
  const s = stroke({ id: 's', points: LINE, color: 'accent.pink', width: 16 });
  // One steady key: hidden before it, half drawn half-way, whole at its end and after.
  const steady = make([s], [drawOn('s', { at: 1, dur: 2, profile: 'steady' })]);
  assert.equal(await itemAt(steady, 0.5), undefined, 'hidden before its drawOn');
  assert.equal((await itemAt(steady, 2))!.drawn, 0.5);
  assert.equal((await itemAt(steady, 3))!.drawn, 1);
  assert.equal((await itemAt(steady, 3.9))!.drawn, 1);
  const half = await row(steady, 120);
  assert.ok(lit(half, -390, -10) === 1 && lit(half, 14, 390) === 0, 'from its first point to its middle');
  // By default it eases: slow at both ends.
  const eased = make([s], [drawOn('s', { at: 1, dur: 2 })]);
  assert.ok((await itemAt(eased, 1.2))!.drawn < 0.03 && Math.abs((await itemAt(eased, 2))!.drawn - 0.5) < 1e-9 && (await itemAt(eased, 2.8))!.drawn > 0.97);
  // A share, and then the rest: each key starts from what is reached.
  const staged = make([s], [drawOn('s', { at: 0, dur: 1, to: 0.4, profile: 'steady' }), drawOn('s', { at: 2, dur: 1, profile: 'steady' }), drawOn('s', { at: 3.5, dur: 0.25, to: 0.7, profile: 'steady' })]);
  const shares: number[] = [];
  for (const t of [0.5, 1, 1.9, 2.5, 3, 3.75, 3.9]) shares.push((await itemAt(staged, t))!.drawn);
  assert.deepEqual(shares.map((v) => Math.round(v * 1000) / 1000), [0.2, 0.4, 0.4, 0.7, 1, 0.7, 0.7], 'and back again when a later key says less');
  const part = await row(staged, 90);
  assert.ok(lit(part, -390, -90) === 1 && lit(part, -70, 390) === 0, 'two fifths of it');
  // A stroke that says how much of it is drawn at the start starts with that.
  const begun = make([stroke({ id: 's', points: LINE, color: 'accent.pink', drawn: 0.25 })], [drawOn('s', { at: 2, dur: 1, profile: 'steady' })]);
  assert.deepEqual([(await itemAt(begun, 0))!.drawn, (await itemAt(begun, 2.5))!.drawn], [0.25, 0.625]);
  assert.equal((await itemAt(make([stroke({ id: 's', points: LINE, color: 'accent.pink', drawn: 0.3 })]), 1))!.drawn, 0.3);
  // Without a drawOn it is whole.
  assert.equal((await itemAt(make([s]), 0))!.drawn, 1);
  // The key of a link is the key it always was: what is for strokes is in a key only when it is said.
  assert.deepEqual(drawOn('wire', { at: 1 }), { kind: 'drawOn', target: 'wire', at: 1, dur: 0.6 });
  assert.deepEqual(drawOn('s', { at: 1, to: 0.4, profile: 'in', ramp: 0.2 }), { kind: 'drawOn', target: 's', at: 1, dur: 0.6, to: 0.4, profile: 'in', ramp: 0.2 });
});

test('stroke: dashes and dots stay where they are while it is drawn on, and solidTo closes their gaps', async () => {
  const dashed = (dash: [number, number], more: object = {}): ReturnType<typeof stroke> => stroke({ id: 's', points: LINE, color: 'accent.pink', width: 8, dash, ...more });
  // A dash of 40 with round ends, a gap of 24: 48 lit of every 72 along the line.
  const whole = await row(make([dashed([40, 24])]), 0);
  assert.ok(Math.abs(lit(whole, -396, 396) - 48 / 72) < 0.04, `${lit(whole, -396, 396)}`);
  // Dots: a dash of no length is a dot as wide as the line.
  const dots = await row(make([dashed([0, 24])]), 0);
  assert.ok(Math.abs(lit(dots, -396, 396) - 8 / 32) < 0.05, `${lit(dots, -396, 396)}`);
  let runs = 0;
  for (let x = 1; x < dots.length; x++) if (dots[x] && !dots[x - 1]) runs++;
  assert.equal(runs, 25, 'a dot every 32 units over 800');
  // Drawn on half-way, the dashes of the first half are the dashes they will be.
  const drawing = make([dashed([40, 24])], [drawOn('s', { at: 0, dur: 2, profile: 'steady' })]);
  const half = await row(drawing, 60);
  const a = Math.round(560 * (WIDTH / 1920));
  const b = Math.round(940 * (WIDTH / 1920));
  assert.deepEqual(half.slice(a, b), whole.slice(a, b));
  assert.equal(lit(half, 20, 396), 0);

  // solidTo: the gaps close where they are, until the line is solid; and open again.
  const closing = make([dashed([40, 24])], [solidTo('s', { at: 1, dur: 1 }), solidTo('s', { at: 3, to: 0, dur: 0.5 })]);
  const open = lit(await row(closing, 30), -396, 396);
  const mid = lit(await row(closing, 90), -396, 396);
  assert.ok(Math.abs(open - 48 / 72) < 0.04 && mid > open + 0.1 && mid < 0.97, `${open}, then ${mid}`);
  assert.equal(lit(await row(closing, 130), -396, 396), 1, 'solid');
  assert.ok(Math.abs(lit(await row(closing, 230), -396, 396) - 48 / 72) < 0.04, 'and dashed again');
  assert.deepEqual([(await itemAt(closing, 0.5))!.solid, (await itemAt(closing, 1.5))!.solid, (await itemAt(closing, 2.5))!.solid, (await itemAt(closing, 3.6))!.solid].map((v) => Math.round(v * 1000) / 1000), [0, 0.5, 1, 0]);
  // While they close, a dash that was lit stays lit: the dashes grow where they are.
  const before = await row(closing, 30);
  const during = await row(closing, 90);
  assert.ok(before.every((v, x) => !v || during[x]), 'no dash moves or shrinks');
  // A stroke may start part of the way closed, or closed.
  assert.equal(lit(await row(make([dashed([40, 24], { solid: 1 })]), 0), -396, 396), 1);
  assert.deepEqual(solidTo('s', { at: 2 }), { kind: 'solidTo', target: 's', at: 2, to: 1, dur: 0.6 });
});

test('stroke: it is placed like a shape: it moves, turns, grows, pops and fades, alone or in a group', async () => {
  const s = stroke({ id: 's', at: [100, 50], points: LINE, color: 'accent.pink', width: 16 });
  const moved = make([s], [moveTo('s', { at: 0, to: [100, 250], dur: 1, profile: 'ease' }), turnTo('s', { at: 1, to: 90, dur: 1, overshoot: 0 }), scaleTo('s', { at: 2, to: 0.5, dur: 0.5, overshoot: 0 }), fadeTo('s', { at: 3, to: 0.5, dur: 0.5 })]);
  const last = (await itemAt(moved, 3.9))!;
  assert.deepEqual([last.xf.x, last.xf.y, Math.round((last.xf.rot * 180) / Math.PI), last.xf.scale, last.alpha], [100, 250, 90, 0.5, 0.5]);
  // In a group: the group's place, turn and size are the stroke's.
  const inGroup = make([group({ id: 'g', at: [200, 0], rotation: 90, scale: 2, children: [stroke({ id: 's', at: [10, 0], points: LINE, color: 'accent.pink' })] })]);
  const child = (await itemAt(inGroup, 0))!;
  assert.deepEqual([Math.round(child.xf.x), Math.round(child.xf.y), Math.round((child.xf.rot * 180) / Math.PI), child.xf.scale], [200, 20, 90, 2]);
  // Hidden before it pops in.
  const popped = make([s], [popIn('s', { at: 1 })]);
  assert.equal(await itemAt(popped, 0.5), undefined);
  assert.ok((await itemAt(popped, 2))!.xf.scale === 1);
  // A link may join it, and a glow makes a halo beside the line.
  compileShot(make([link({ id: 'l', from: 's', to: 'c', color: 'mid.mist' }), s, circle({ id: 'c', at: [0, 300], r: 20, fill: 'accent.aqua' })]));
  const beside = async (glow: number): Promise<number> => {
    const c = compileShot(make([stroke({ id: 's', points: LINE, color: 'accent.pink', width: 8, glow })]));
    const raw = await frameRaw(c, await bakeShot(c), 0, { width: WIDTH, lang: 'en', gpu: false });
    const o = ((heightFor(WIDTH) / 2 + 6) * WIDTH + WIDTH / 2) * 4;
    return Math.max(raw[o]!, raw[o + 1]!, raw[o + 2]!);
  };
  assert.ok((await beside(1)) > (await beside(0)) + 8, `${await beside(1)} against ${await beside(0)}`);
});

test('stroke: arcPoints gives the points of an arc, and a smooth stroke through them is the arc', () => {
  const quarter = arcPoints([100, 50], 80, 0, 90);
  assert.deepEqual([quarter.length, quarter[0], quarter[quarter.length - 1]!.map((v) => Math.round(v * 1e6) / 1e6)], [7, [180, 50], [100, 130]], 'from the right of the centre to below it, a point every 15 degrees');
  assert.equal(arcPoints([0, 0], 10, -90, 270, { step: 30 }).length, 13);
  assert.ok(arcPoints([0, 0], 10, 90, 0).every((p) => p[0] >= -1e-9 && p[1] >= -1e-9), 'backwards runs the other way round');
  const ring = stroke({ id: 'r', points: arcPoints([0, 0], 100, 0, 360).slice(0, -1), closed: true, color: 'accent.aqua' });
  const table = pathTable(ring.path);
  for (let i = 0; i < table.xs.length; i++) assert.ok(Math.abs(Math.hypot(table.xs[i]!, table.ys[i]!) - 100) < 0.2, `sample ${i}`);
  assert.ok(Math.abs(table.length - 2 * Math.PI * 100) < 1);
});

test('stroke: what it refuses', () => {
  const s = { id: 's', points: LINE, color: 'accent.pink' } as const;
  const bad = (make: () => unknown, message: RegExp): void => {
    assert.throws(make, (e: unknown) => (e instanceof SceneError || e instanceof IntentError || e instanceof Error) && message.test((e as Error).message), String(message));
  };
  bad(() => stroke({ ...s, colour: 'accent.pink' } as never), /stroke\("s"\): unknown option "colour" \(allowed: id, points, color, width,/);
  bad(() => stroke({ ...s, points: [[0, 0]] }), /points must be a list of at least two points/);
  bad(() => stroke({ ...s, points: [[0, 0], [1, 1]], closed: true }), /a closed stroke needs at least three points/);
  bad(() => stroke({ ...s, points: [[5, 5], [5, 5]] }), /a line without length/);
  bad(() => stroke({ ...s, color: '#ff0000' as never }), /color must be a palette reference/);
  bad(() => stroke({ ...s, dash: [10] as never }), /dash must be \[dash, gap\]/);
  bad(() => stroke({ ...s, dash: [10, 0] }), /dash\[1\] must be a number in 0\.5\.\.10000/);
  bad(() => stroke({ ...s, solid: 0.5 }), /solid is for a dashed stroke: give dash/);
  bad(() => stroke({ ...s, drawn: 2 }), /drawn must be a number in 0\.\.1/);
  bad(() => drawOn('s', { at: 0, to: 1.5 }), /to must be a number in 0\.\.1/);
  bad(() => drawOn('s', { at: 0, speed: 3 } as never), /drawOn\("s"\): unknown option "speed"/);
  bad(() => drawOn('s', { at: 0, ramp: 0.2 }), /ramp applies to the profiles ease, in and out/);
  bad(() => solidTo('s', { at: 0, dur: 1, ease: 'in' } as never), /solidTo\("s"\): unknown option "ease"/);
  // In a shot.
  bad(() => make([stroke(s)], [solidTo('s', { at: 0 })]), /solidTo cannot target "s": the stroke has no dash to close/);
  bad(() => make([circle({ id: 'c', r: 10, fill: 'accent.aqua' })], [solidTo('c', { at: 0 })]), /solidTo cannot target shape "c"; it applies to strokes/);
  bad(() => make([circle({ id: 'c', r: 10, fill: 'accent.aqua' })], [drawOn('c', { at: 0 })]), /drawOn cannot target shape "c"; it applies to links and strokes/);
  const linked = [link({ id: 'l', from: 'a', to: 'b', color: 'mid.mist' }), group({ id: 'a' }), group({ id: 'b', at: [100, 0] })];
  bad(() => make(linked, [drawOn('l', { at: 0, to: 0.5 })]), /drawOn\("l"\): to, profile and ramp are for a stroke; a link is drawn on whole/);
  bad(() => make([stroke({ ...s, clipTo: 'nope' })]), /clipTo refers to "nope", which does not exist/);
  bad(() => make([stroke({ ...s, color: 'accent.none' as never })]), /stroke "s" color/);
});

test('stroke: it is opt-in: a shot without one is the data it was, and its events and its review know a stroke', async () => {
  // A shot without strokes has nothing of them in its data.
  const plain = make([circle({ id: 'c', r: 30, fill: 'accent.aqua' }), link({ id: 'l', from: 'c', to: 'd', color: 'mid.mist' }), group({ id: 'd', at: [200, 0] })], [drawOn('l', { at: 1 })]);
  const text = JSON.stringify(plain);
  for (const word of ['stroke', 'dash', 'solid', 'drawn', 'profile']) assert.ok(!text.includes(word), word);
  assert.ok(compileShot(plain).nodes.every((n) => n.stroke === null));

  // The events of a drawOn: the line starts to be drawn, and its end arrives.
  const drawing = make([stroke({ id: 's', at: [0, 100], points: LINE, color: 'accent.pink', sound: 'pen' })], [drawOn('s', { at: 1, dur: 2, profile: 'steady', to: 0.5 })]);
  const c = compileShot(drawing);
  const events = sceneEvents(c, await bakeShot(c));
  assert.deepEqual(events.map((e) => [e.kind, e.node, e.key, e.frame, e.dur, e.size, e.x, e.y, e.seen]), [
    ['draw', 's', 'pen', 60, 2, 800, 560, 640, true],
    ['connect', 's', 'pen', 180, 0, 800, 960, 640, true],
  ]);
  assert.ok(Math.abs(events[0]!.speed - 400 / 120) < 0.01, 'the end of the line travels 400 units in two seconds');

  // The motion review. A line that is being drawn keeps its part of the frame alive; one that only lies there does not.
  const alive = (timeline: Key[]): string[] =>
    reviewMotion(compileShot(make([stroke({ id: 's', points: LINE, color: 'accent.pink', dash: [20, 20] })], timeline, 8)), bakeOf).report.findings.map((f) => `${f.kind} ${f.subject}`);
  let bakeOf = await bakeShot(compileShot(make([stroke({ id: 's', points: LINE, color: 'accent.pink', dash: [20, 20] })], [], 8)));
  assert.ok(alive([]).includes('dead-area (frame)'), 'a still line is a hold');
  bakeOf = await bakeShot(compileShot(make([stroke({ id: 's', points: LINE, color: 'accent.pink', dash: [20, 20] })], [drawOn('s', { at: 0, dur: 4.5, profile: 'steady' }), solidTo('s', { at: 4.5, dur: 3.5 })], 8)));
  assert.deepEqual(
    alive([drawOn('s', { at: 0, dur: 4.5, profile: 'steady' }), solidTo('s', { at: 4.5, dur: 3.5 })]).filter((f) => f.startsWith('dead-area (frame)')),
    [],
    'drawing it on, and closing its dashes, is life',
  );
  // And a stroke that is moved badly is found as any node is: one speed from rest to rest.
  const pushed = make([stroke({ id: 's', points: [[-100, 0], [100, 0]], color: 'accent.pink', width: 20 })], [moveTo('s', { at: 1, to: [0, 300], dur: 1.5, profile: 'steady', arc: 0 })]);
  const cp = compileShot(pushed);
  const found = reviewMotion(cp, await bakeShot(cp)).report.findings.filter((f) => f.subject === 's').map((f) => f.kind);
  assert.ok(found.includes('abrupt-start') || found.includes('mechanical'), `found: ${found.join(', ')}`);
});
