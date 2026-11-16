import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  arcPoints,
  bakeShot,
  circle,
  compileShot,
  drawOn,
  evaluate,
  flatItems,
  frameRaw,
  group,
  heightFor,
  intended,
  IntentError,
  layer,
  link,
  pathTable,
  pulse,
  reviewMotion,
  sceneEvents,
  shot,
  stroke,
  type Key,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';

// A light that runs along a stroke: the pulse of a link, on a line that is not a link.

const WIDTH = 960;

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
    // A still camera: a place of the stage is that place on screen, moved by half a frame.
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
    ...extra,
  });
}

/** A straight line through the middle of the frame, 800 units long. */
const LINE: [number, number][] = [[-400, 0], [400, 0]];
const wire = (extra: object = {}): ReturnType<typeof stroke> => stroke({ id: 's', points: LINE, color: 'dark.indigo', width: 8, ...extra });

/** The lights on the stroke of a shot at a moment, as the evaluator lists them; undefined while none runs. */
async function lights(spec: ShotSpec, seconds: number): Promise<readonly { head: number; tail: number; length: number }[] | undefined> {
  const c = compileShot(spec);
  const item = flatItems(evaluate(c, await bakeShot(c), Math.round(seconds * 60), 'en').layers[0]!.items).find((i) => i.node.id === 's');
  assert.ok(item && item.kind === 'stroke', 'the stroke is drawn');
  return item.pulses;
}

/** Brightness (the largest channel) of the pixel at a place of the stage, at a frame. */
async function bright(spec: ShotSpec, frame: number, x: number, y: number): Promise<number> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
  const k = WIDTH / 1920;
  const o = (Math.round(heightFor(WIDTH) / 2 + y * k) * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4;
  return Math.max(raw[o]!, raw[o + 1]!, raw[o + 2]!);
}

async function hash(spec: ShotSpec, frame: number): Promise<string> {
  const c = compileShot(spec);
  return createHash('sha256').update(await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false })).digest('hex');
}

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

test('stroke pulse: a pulse without the options of a stroke is the key it was; with them it carries them', () => {
  assert.deepEqual(pulse('wire', { at: 2 }), { kind: 'pulse', target: 'wire', at: 2, dur: 0.7, bump: 0.14 });
  assert.deepEqual(pulse('wire', { at: 2, dur: 1.5, bump: 0 }), { kind: 'pulse', target: 'wire', at: 2, dur: 1.5, bump: 0 });
  assert.deepEqual(pulse('wire', { at: 2, from: 0.2, to: 0.9, profile: 'ease', ramp: 0.2, length: 60, node: 'lamp' }), {
    kind: 'pulse', target: 'wire', at: 2, dur: 0.7, bump: 0.14, from: 0.2, to: 0.9, profile: 'ease', ramp: 0.2, length: 60, node: 'lamp',
  });
  // A stroke without a colour for its lights is the node it was.
  assert.equal('pulseColor' in wire(), false);
  assert.equal(wire({ pulseColor: 'accent.amber' }).pulseColor, 'accent.amber');

  const bad = (opts: object, message: RegExp): void => {
    assert.throws(() => pulse('wire', { at: 0, ...opts } as never), (e: unknown) => e instanceof IntentError && message.test(e.message), String(message));
  };
  bad({ profile: 'settle' }, /profile must be one of ease, steady, in, out/);
  bad({ ramp: 0.2 }, /ramp applies to the profiles ease, in and out/);
  bad({ profile: 'steady', ramp: 0.2 }, /ramp applies to the profiles ease, in and out/);
  bad({ to: -1 }, /to must be a number in 0\.\.1000/);
  bad({ length: 0 }, /length must be a number in 1\.\.100000/);
  bad({ node: 5 }, /node must be the id of the node that the light arrives at/);
  bad({ speed: 3 }, /unknown option "speed" \(allowed: at, dur, bump, from, to, profile, ramp, length, node, sound\)/);
});

test('stroke pulse: what the shot refuses', () => {
  const ends = [group({ id: 'a', at: [-400, 200] }), group({ id: 'b', at: [400, 200] }), link({ id: 'l', from: 'a', to: 'b', color: 'dark.indigo' })];
  const refuse = (nodes: LayerSpec['nodes'], key: Key, message: RegExp): void => {
    assert.throws(() => make(nodes, [key]), message, String(message));
  };
  // The options of a stroke's light are not for a link, which runs from one node to the other.
  refuse([wire(), ...ends], pulse('l', { at: 1, to: 0.5 }), /pulse\("l"\): to is for a stroke; on a link a pulse runs from its first node to its second/);
  refuse([wire(), ...ends], pulse('l', { at: 1, profile: 'steady', node: 'a' }), /pulse\("l"\): profile, node are for a stroke/);
  // Shares of an open stroke lie on it; a light has a way to go.
  refuse([wire()], pulse('s', { at: 1, to: 2 }), /from and to are shares of the length of the stroke, 0 to 1; only round a closed stroke does a share above 1 run on/);
  refuse([wire()], pulse('s', { at: 1, from: 0.4, to: 0.4 }), /the light runs nowhere: from and to are both 0\.4/);
  // A stroke has no far node: a bump needs the node named.
  refuse([wire()], pulse('s', { at: 1, bump: 0.3 }), /a stroke has no far node to bump; name the node the light arrives at with node, or leave bump out/);
  refuse([wire()], pulse('s', { at: 1, node: 'lamp' }), /node names "lamp", which does not exist/);
  refuse([wire(), ...ends], pulse('s', { at: 1, node: 'l' }), /node names link "l"; the bump is for a shape, a group, an eye, a stroke, a text or a label/);
  refuse([wire(), circle({ id: 'dot', r: 20, fill: 'accent.aqua' })], pulse('dot', { at: 1 }), /pulse cannot target shape "dot"; it applies to links and strokes/);
  // Round a closed stroke a light may run on, and a bump of 0 needs no node.
  make([stroke({ id: 's', points: arcPoints([0, 0], 200, 0, 345), closed: true, color: 'dark.indigo' })], [pulse('s', { at: 1, to: 2.5, bump: 0 })]);
});

test('stroke pulse: the light runs from the first point to the last in its time, its tail behind it, and is gone a moment after it arrives', async () => {
  const spec = make([wire()], [pulse('s', { at: 1, dur: 2 })]);
  assert.equal(await lights(spec, 0.5), undefined, 'before the pulse the stroke is the item it always was');
  // Half-way through its time it is half-way along the line; its light is a quarter of its way, at most 120 units.
  const mid = (await lights(spec, 2))!;
  assert.equal(mid.length, 1);
  assert.ok(near(mid[0]!.head, 400, 1e-6) && near(mid[0]!.length, 120) && near(mid[0]!.tail, 280, 1e-6), JSON.stringify(mid));
  // As on a link it leaves and arrives at speed: the same share of its way at the same share of its time.
  const early = (await lights(spec, 1.5))![0]!;
  assert.ok(near(early.head / 800, 0.25 * 0.4 + (0.5 - 0.5 * Math.cos(Math.PI * 0.25)) * 0.6, 1e-9));
  assert.ok(near(((await lights(spec, 1 + 2 / 60))![0]!).tail, 0), 'while it leaves its source the tail is at the start');
  const there = (await lights(spec, 3))![0]!;
  assert.ok(near(there.head, 800, 1e-6) && near(there.tail, 680, 1e-6));
  // The tail catches up in 0.14 s, and then nothing is left.
  const closing = (await lights(spec, 3 + 4 / 60))![0]!;
  assert.ok(closing.head === 800 && closing.tail > 680 && closing.tail < 800);
  assert.equal(await lights(spec, 3.2), undefined);

  // Between two shares, at one speed, with a light of a set length; and the other way.
  const part = make([wire()], [pulse('s', { at: 1, dur: 2, from: 0.25, to: 0.75, profile: 'steady', length: 50 })]);
  const p = (await lights(part, 2))![0]!;
  assert.ok(near(p.head, 400, 1e-6) && near(p.tail, 350, 1e-6) && p.length === 50, JSON.stringify(p));
  assert.ok(near(((await lights(part, 1.5))![0]!).head, 300, 1e-6) && near(((await lights(part, 2.5))![0]!).head, 500, 1e-6));
  const back = make([wire()], [pulse('s', { at: 1, dur: 2, from: 1, to: 0, profile: 'steady' })]);
  const b = (await lights(back, 2))![0]!;
  assert.ok(near(b.head, 400, 1e-6) && near(b.tail, 520, 1e-6), `toward the first point the tail is on the far side: ${JSON.stringify(b)}`);
  // From rest to rest.
  const eased = make([wire()], [pulse('s', { at: 1, dur: 2, profile: 'ease' })]);
  assert.ok(((await lights(eased, 1.2))![0]!).head < 30 && near(((await lights(eased, 2))![0]!).head, 400, 1e-6));
  // Round a closed line, twice.
  const ring = make([stroke({ id: 's', points: arcPoints([0, 0], 200, 0, 345), closed: true, color: 'dark.indigo' })], [pulse('s', { at: 0.5, dur: 3, to: 2, profile: 'steady', bump: 0 })]);
  const length = pathTable({ points: arcPoints([0, 0], 200, 0, 345), closed: true, smooth: 1 }).length;
  assert.ok(near(((await lights(ring, 2.75))![0]!).head, 1.5 * length, 1e-6), 'one and a half times round');
});

test('stroke pulse: it lights the line where it is, glows beside it, and leaves the other frames as they were', async () => {
  const plain = make([wire()]);
  const lit = make([wire()], [pulse('s', { at: 1, dur: 2, profile: 'steady' })]);
  // Half-way: the head is in the middle of the frame, the light reaches 120 units back.
  const f = 120;
  assert.ok((await bright(lit, f, -20, 0)) > (await bright(plain, f, -20, 0)) + 40, 'on the line behind the head it is brighter');
  assert.ok((await bright(lit, f, -20, 16)) > (await bright(plain, f, -20, 16)) + 6, 'beside the line the light glows');
  assert.equal(await bright(lit, f, 200, 0), await bright(plain, f, 200, 0), 'ahead of the head the line is as it was');
  assert.equal(await bright(lit, f, -300, 0), await bright(plain, f, -300, 0), 'and so it is behind the tail');
  assert.ok((await bright(lit, f, -110, 0)) < (await bright(lit, f, -20, 0)), 'the light fades toward its tail');
  // Before the pulse and after it the frames are those of the shot without it.
  for (const frame of [0, 59, 200, 239]) assert.equal(await hash(lit, frame), await hash(plain, frame), `frame ${frame}`);
  assert.notEqual(await hash(lit, f), await hash(plain, f));
  // A colour for the lights: the light is drawn in it.
  const coloured = make([wire({ pulseColor: 'accent.amber' })], [pulse('s', { at: 1, dur: 2, profile: 'steady' })]);
  assert.notEqual(await hash(coloured, f), await hash(lit, f));
  assert.equal(await hash(coloured, 0), await hash(plain, 0), 'without a light the colour changes nothing');
  // It shows only on the part of the line that is drawn.
  const half = make([wire({ drawn: 0.4 })], [pulse('s', { at: 1, dur: 2, profile: 'steady' })]);
  const halfPlain = make([wire({ drawn: 0.4 })]);
  assert.equal(await hash(half, 150), await hash(halfPlain, 150), 'past the end of what is drawn there is no light');
  assert.notEqual(await hash(half, 80), await hash(halfPlain, 80));
});

test('stroke pulse: the node it names gets a bump when the light arrives', async () => {
  const nodes = [wire(), circle({ id: 'lamp', at: [460, 0], r: 40, fill: 'accent.amber' })];
  const size = async (key: Key, seconds: number): Promise<number> => {
    const c = compileShot(make(nodes, [key]));
    const item = flatItems(evaluate(c, await bakeShot(c), Math.round(seconds * 60), 'en').layers[0]!.items).find((i) => i.node.id === 'lamp')!;
    return item.kind === 'shape' ? item.xf.scale : NaN;
  };
  const key = pulse('s', { at: 1, dur: 1, node: 'lamp' });
  assert.equal(await size(key, 1.9), 1, 'not before it arrives');
  assert.ok((await size(key, 2.08)) > 1.08, 'a kick of its size on arrival');
  assert.ok(near(await size(key, 3), 1, 1e-6), 'that rings out');
  assert.ok((await size(pulse('s', { at: 1, dur: 1, node: 'lamp', bump: 0.3 }), 2.08)) > (await size(key, 2.08)) + 0.05, 'as large as the key says');
  assert.equal(await size(pulse('s', { at: 1, dur: 1, node: 'lamp', bump: 0 }), 2.08), 1, 'and none with bump: 0');
  assert.equal(await size(pulse('s', { at: 1, dur: 1 }), 2.08), 1, 'without a node nothing is bumped');
});

test('stroke pulse: the motion review knows it: a light too quick to follow is found, one at a pace is clean, and it counts as life in the frame', async () => {
  const flagged = async (spec: ShotSpec): Promise<string[]> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c))
      .report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel}`)
      .sort();
  };
  // The planted defect: 800 units in a tenth of a second, a light of 120 units: more than its own length per frame.
  const quick = make([wire()], [pulse('s', { at: 1, dur: 0.1 })], 3);
  assert.deepEqual(await flagged(quick), ['too-fast s pulse']);
  const c = compileShot(quick);
  const found = reviewMotion(c, await bakeShot(c)).report.findings[0]!;
  assert.match(found.detail, /a light of 120 units runs 800 units along the stroke in 6\.0 frames: 1\.11 of its own length per frame \(it needs at least 14 frames\)/);
  // A longer light may run faster; a marked finding is honoured.
  assert.deepEqual(await flagged(make([wire()], [pulse('s', { at: 1, dur: 0.1, length: 400 })], 3)), []);
  assert.deepEqual(await flagged(make([wire()], [pulse('s', { at: 1, dur: 0.1 })], 3, { intended: [intended('s', 'too-fast', 'a flash along the wire')] })), []);
  // The sound scene: the same way in a second.
  assert.deepEqual(await flagged(make([wire()], [pulse('s', { at: 1, dur: 1 })], 3)), []);

  // Life: a line that only lies there is a hold of the frame; lights that run along it keep its part of the frame alive.
  const held = await flagged(make([wire()], [drawOn('s', { at: 0.2, dur: 0.5 })], 9));
  assert.ok(held.includes('dead-area (frame) hold'), held.join('; '));
  const alive = await flagged(make([wire()], [drawOn('s', { at: 0.2, dur: 0.5 }), ...[1, 3, 5, 7].map((at) => pulse('s', { at, dur: 1.9 }))], 9));
  assert.ok(!alive.some((f) => f.startsWith('dead-area (frame) ')), alive.join('; '));
  assert.ok(!alive.includes('too-fast s pulse'));
});

test('stroke pulse: its arrival is an event at the end of its way, as the arrival of a link\'s pulse is', async () => {
  const c = compileShot(make([wire({ sound: 'wire' })], [pulse('s', { at: 1, dur: 1.5, to: 0.75 }), pulse('s', { at: 3, dur: 0.5, sound: false })]));
  const events = sceneEvents(c, await bakeShot(c)).filter((e) => e.kind === 'pulse');
  assert.deepEqual(events.map((e) => [e.id, e.frame, e.node, e.key, e.dur, e.seen]), [['pulse:s@150', 150, 's', 'wire', 0, true], ['pulse:s@210', 210, 's', 'wire', 0, true]]);
  // Where the light arrives: three quarters along the line, on screen; its speed is that of the light.
  assert.ok(near(events[0]!.x, 960 + 200, 0.01) && near(events[0]!.y, 540, 0.01), `${events[0]!.x}, ${events[0]!.y}`);
  assert.ok(near(events[0]!.size, 800, 0.01) && near(events[0]!.speed, (0.75 * 800) / 90, 0.01));
  assert.equal(events[1]!.sound, false, 'a muted pulse says so');
});
