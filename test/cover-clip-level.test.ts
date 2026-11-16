import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  computeWorld,
  emitter,
  evaluate,
  flatItems,
  frameRaw,
  group,
  heightFor,
  label,
  layer,
  layoutText,
  levelTo,
  moveTo,
  rect,
  reviewMotion,
  runChecks,
  shot,
  squash,
  type Item,
  type Key,
  type LayerSpec,
  type MotionReport,
  type ShotSpec,
} from '../src/index.ts';
import { buildLevelTrack, buildStretchTrack, sampleLevel, sampleStretch } from '../src/motion/tracks.ts';
import { steadySizeOverLife, sizeOverLife } from '../src/physics/particles.ts';
import { levelGeometry, posesFromBake } from '../src/scene/evaluate.ts';

// Covers, clipping, contents with a level, bodies that appear at their release,
// steady particles, backdrops, no-break spaces and squashes. Each is opt-in:
// a shot that asks for none of them is the data, and the picture, it always was.

const WIDTH = 480;

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], seconds = 3): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 7,
    palette,
    strings: { en: { 'label.a': 'A label' } },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

/** A frame as pixels, and a reader of the pixel at a place of the stage (units, origin at the centre). */
async function picture(spec: ShotSpec, frame = 0): Promise<{ raw: Buffer; at: (x: number, y: number) => [number, number, number] }> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
  const k = WIDTH / 1920;
  const at = (x: number, y: number): [number, number, number] => {
    const px = Math.round((x + 960) * k);
    const py = Math.round((y + 540) * k);
    const o = (py * WIDTH + px) * 4;
    return [raw[o]!, raw[o + 1]!, raw[o + 2]!];
  };
  assert.equal(raw.length, WIDTH * heightFor(WIDTH) * 4);
  return { raw, at };
}

const far = (a: readonly number[], b: readonly number[]): number => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

async function review(spec: ShotSpec): Promise<MotionReport> {
  const c = compileShot(spec);
  return reviewMotion(c, await bakeShot(c)).report;
}
const flagged = (r: MotionReport): string[] => r.findings.map((f) => `${f.kind} ${f.subject}`).sort();

// --- Cover ----------------------------------------------------------------------

// A glowing lamp of radius 60 and a dark wall of 300 x 300: the lamp fits behind the wall with room to spare.
const lamp = (at: [number, number] = [0, 0]): ReturnType<typeof circle> => circle({ id: 'lamp', at, r: 60, fill: 'accent.amber', glow: 1 });
const wall = (cover: boolean | undefined, opacity = 1): ReturnType<typeof rect> =>
  rect({ id: 'wall', at: [0, 0], w: 300, h: 300, radius: 20, fill: 'dark.indigo', lit: false, opacity, ...(cover === undefined ? {} : { cover }) });

test('cover: a light behind a cover does not shine through it, and does not warm the sky around it', async () => {
  const bare = await picture(make([wall(undefined)]));
  const through = await picture(make([lamp(), wall(undefined)]));
  const hidden = await picture(make([lamp(), wall(true)]));
  // Without the cover the halo is drawn over the wall, and the sky beside the wall is lifted.
  assert.ok(far(through.at(0, 0), bare.at(0, 0)) > 20, 'by default a halo shows on what is drawn in front of it');
  assert.ok(far(through.at(190, 0), bare.at(190, 0)) > 3, 'and its lift reaches the sky beside the wall');
  // With the cover the picture is the one without any lamp: on the wall, at its edge, and in the sky.
  for (const [x, y] of [[0, 0], [60, 40], [-100, 100], [140, 0], [190, 0], [0, -300], [500, 300]] as const) {
    assert.deepEqual(hidden.at(x, y), bare.at(x, y), `at ${x}, ${y}`);
  }
  assert.ok(hidden.raw.equals(bare.raw), 'the whole frame is the frame without the lamp');
});

test('cover: what sticks out from behind it still glows, and a light in front of it is untouched', async () => {
  const bare = await picture(make([wall(true)]));
  // Half of the lamp is behind the right edge of the wall.
  const half = await picture(make([lamp([150, 0]), wall(true)]));
  assert.ok(far(half.at(185, 0), bare.at(185, 0)) > 60, 'the half that shows is drawn');
  assert.ok(far(half.at(240, 0), bare.at(240, 0)) > 8, 'and has its halo beside it');
  assert.deepEqual(half.at(0, 0), bare.at(0, 0), 'the middle of the wall is as dark as without the lamp');
  // Without the cover the hidden half shines through the wall near its edge.
  const leak = await picture(make([lamp([150, 0]), wall(undefined)]));
  assert.ok(far(leak.at(115, 0), bare.at(115, 0)) > far(half.at(115, 0), bare.at(115, 0)) + 10, 'the cover takes the hidden half out of the halo');
  // A lamp listed after the cover is in front of it: it shines as ever.
  const front = await picture(make([wall(true), lamp()]));
  const plain = await picture(make([wall(undefined), lamp()]));
  assert.ok(front.raw.equals(plain.raw), 'a cover changes nothing for what is drawn after it');
  // A cover that is half faded hides half.
  const faint = await picture(make([lamp(), wall(true, 0.5)]));
  const faintBare = await picture(make([wall(true, 0.5)]));
  const faintThrough = await picture(make([lamp(), wall(undefined, 0.5)]));
  const some = far(faint.at(190, 0), faintBare.at(190, 0));
  assert.ok(some > 1 && some < far(faintThrough.at(190, 0), faintBare.at(190, 0)), 'through a half-faded cover half of the light gets out');
});

test('cover: opt-in, and the review does not judge what is wholly behind one', async () => {
  assert.ok(!('cover' in wall(undefined)), 'a shape that asks for no cover is the data it always was');
  assert.deepEqual(compileShot(make([lamp(), wall(undefined)])).covers, []);
  assert.throws(() => rect({ id: 'w', w: 10, h: 10, fill: 'dark.indigo', cover: 'yes' as never }), /cover must be true or false/);
  // The planted defect: a teleport in plain view.
  const jump: Key = { kind: 'moveTo', target: 'lamp', at: 1, to: [60, 50], dur: 1 / 60, anticipation: 0, overshoot: 0, arc: 0 };
  assert.deepEqual(flagged(await review(make([lamp([-60, -50]), wall(undefined)], [jump]))), ['jump lamp']);
  // The same teleport wholly behind a cover is not seen, so it is not reported.
  assert.deepEqual(flagged(await review(make([lamp([-60, -50]), wall(true)], [jump]))), []);
  // A cover drawn before the lamp hides nothing.
  assert.deepEqual(flagged(await review(make([wall(true), lamp([-60, -50])], [jump]))), ['jump lamp']);
  // A lamp that sticks out from behind the cover is seen, before and after its jump.
  const peeking: Key = { ...jump, to: [150, 80] } as Key;
  assert.deepEqual(flagged(await review(make([lamp([150, -80]), wall(true)], [peeking]))), ['jump lamp']);
  // A cover that is half faded hides nothing from the review.
  assert.deepEqual(flagged(await review(make([lamp([-60, -50]), wall(true, 0.5)], [jump]))), ['jump lamp']);
});

// --- Clipping --------------------------------------------------------------------

test('clipTo: a node is drawn only inside the outline of a shape, with its glow', async () => {
  const windowShape = rect({ id: 'window', at: [0, 0], w: 300, h: 300, radius: 10, fill: 'dark.indigo', opacity: 0 });
  const ball = (clipTo?: string, at: [number, number] = [150, 0], glow = 0): ReturnType<typeof circle> =>
    circle({ id: 'ball', at, r: 60, fill: 'accent.amber', glow, ...(clipTo ? { clipTo } : {}) });
  const empty = await picture(make([windowShape]));
  const free = await picture(make([windowShape, ball()]));
  const clipped = await picture(make([windowShape, ball('window')]));
  // The ball is half inside the window: that half is there, the other half is not.
  assert.ok(far(clipped.at(120, 0), empty.at(120, 0)) > 60, 'inside the window');
  assert.deepEqual(clipped.at(185, 0), empty.at(185, 0), 'the half outside the window is not drawn');
  assert.ok(far(free.at(185, 0), empty.at(185, 0)) > 60, 'without the clip it is');
  // A glowing ball wholly outside the shape it is clipped to leaves nothing: no ball, no halo, no lift of the sky.
  assert.ok((await picture(make([windowShape, ball('window', [400, 0], 1)]))).raw.equals(empty.raw), 'nothing of it outside its clip');
  assert.ok(!(await picture(make([windowShape, ball(undefined, [400, 0], 1)]))).raw.equals(empty.raw));
  // Half inside, it glows, and less than it would unclipped.
  const glowing = await picture(make([windowShape, ball('window', [150, 0], 1)]));
  const glowingFree = await picture(make([windowShape, ball(undefined, [150, 0], 1)]));
  const lifted = far(glowing.at(60, 0), empty.at(60, 0));
  assert.ok(lifted > 4 && lifted < far(glowingFree.at(60, 0), empty.at(60, 0)), 'half of the light for half of the ball');
  // The display list holds the node inside a clip; neighbours with the same clip share it.
  const c = compileShot(make([windowShape, ball('window'), circle({ id: 'other', r: 10, fill: 'accent.aqua', clipTo: 'window' })]));
  const items = evaluate(c, await bakeShot(c), 0, 'en').layers[0]!.items;
  const clips = items.filter((i: Item) => i.kind === 'clip');
  assert.equal(clips.length, 1);
  assert.deepEqual(flatItems(clips).map((i) => i.node.id), ['ball', 'other']);
  assert.ok(!('clipTo' in ball()), 'opt-in');
  assert.throws(() => make([windowShape, circle({ id: 'x', r: 10, fill: 'accent.aqua', clipTo: 'nobody' })]), /clipTo refers to "nobody", which does not exist/);
  assert.throws(() => make([group({ id: 'g' }), circle({ id: 'x', r: 10, fill: 'accent.aqua', clipTo: 'g' })]), /it must be a shape/);
  assert.throws(() => make([circle({ id: 'x', r: 10, fill: 'accent.aqua', clipTo: 'x' })]), /cannot be clipped to itself/);
});

test('clipTo: a node wholly outside its clip is not seen by the review; particles stay inside a vessel', async () => {
  const windowShape = rect({ id: 'window', at: [0, 0], w: 300, h: 300, radius: 10, fill: 'dark.indigo', opacity: 0 });
  const jump: Key = { kind: 'moveTo', target: 'ball', at: 1, to: [600, 100], dur: 1 / 60, anticipation: 0, overshoot: 0, arc: 0 };
  const ball = (clipTo?: string): ReturnType<typeof circle> => circle({ id: 'ball', at: [500, 0], r: 30, fill: 'accent.amber', ...(clipTo ? { clipTo } : {}) });
  assert.deepEqual(flagged(await review(make([windowShape, ball()], [jump]))), ['jump ball']);
  assert.deepEqual(flagged(await review(make([windowShape, ball('window')], [jump]))), [], 'outside its clip nothing of it is drawn');
  // Particles clipped to a shape: none of them is drawn outside it.
  const spray = (clipTo?: string) =>
    make([
      windowShape,
      emitter({ id: 'spray', at: [0, 0], rate: 400, life: 2, size: 14, speed: [200, 400], colors: ['accent.amber'], drag: 0, prewarm: 2, ...(clipTo ? { clipTo } : {}) }),
    ]);
  const empty = await picture(make([windowShape]));
  const loose = await picture(spray());
  const kept = await picture(spray('window'));
  let looseOutside = 0;
  let keptOutside = 0;
  let keptInside = 0;
  for (let x = -900; x <= 900; x += 20) {
    for (let y = -500; y <= 500; y += 20) {
      const inside = Math.abs(x) < 140 && Math.abs(y) < 140;
      const outside = Math.abs(x) > 160 || Math.abs(y) > 160;
      if (outside && far(loose.at(x, y), empty.at(x, y)) > 30) looseOutside++;
      if (outside && far(kept.at(x, y), empty.at(x, y)) > 0) keptOutside++;
      if (inside && far(kept.at(x, y), empty.at(x, y)) > 30) keptInside++;
    }
  }
  assert.ok(looseOutside > 20, `without the clip the particles fly everywhere (${looseOutside} samples)`);
  assert.equal(keptOutside, 0, 'with it nothing is drawn outside the shape');
  assert.ok(keptInside > 5, `and they are there inside it (${keptInside} samples)`);
});

// --- Level -----------------------------------------------------------------------

const vessel = (level?: Parameters<typeof rect>[0]['level'], children: LayerSpec['nodes'] = []): ReturnType<typeof rect> =>
  rect({ id: 'content', at: [0, 0], w: 300, h: 400, radius: 20, fill: 'accent.aqua', lit: false, children, ...(level === undefined ? {} : { level }) });

test('level: a content fills its outline from the bottom up to its level', async () => {
  const empty = await picture(make([]));
  const half = await picture(make([vessel(0.5)]));
  assert.ok(far(half.at(0, 100), empty.at(0, 100)) > 60, 'below the surface it is drawn');
  assert.deepEqual(half.at(0, -100), empty.at(0, -100), 'above the surface nothing is');
  assert.ok(far(half.at(0, 6), empty.at(0, 6)) > 60, 'just below the middle');
  assert.deepEqual(half.at(0, -6), empty.at(0, -6), 'just above the middle');
  // Empty is nothing at all; full is the shape itself.
  assert.ok((await picture(make([vessel(0)]))).raw.equals(empty.raw), 'level 0 draws nothing');
  assert.ok((await picture(make([vessel(1)]))).raw.equals((await picture(make([vessel()]))).raw), 'level 1 is the whole shape');
  assert.ok(!('level' in vessel()), 'opt-in');
  assert.throws(() => rect({ id: 'c', w: 10, h: 10, fill: 'accent.aqua', level: 2 }), /level must be a number in 0\.\.1/);
  assert.throws(() => rect({ id: 'c', w: 10, h: 10, fill: 'accent.aqua', level: 0.5, body: { kind: 'fixed' } }), /a rigid body cannot have a level/);
  assert.throws(() => make([circle({ id: 'a', r: 10, fill: 'accent.aqua' })], [levelTo('a', { at: 0, to: 1 })]), /applies to a shape with a level/);
});

test('level: levelTo raises it and arrives exactly; children ride on the surface; the surface stays level when the shape turns', async () => {
  const track = buildLevelTrack(0.2, [levelTo('c', { at: 1, to: 0.8, dur: 2 }), levelTo('c', { at: 4, to: 0.5, dur: 1, profile: 'steady' })]);
  assert.equal(sampleLevel(track, 0.5), 0.2);
  assert.equal(sampleLevel(track, 3), 0.8);
  assert.ok(Math.abs(sampleLevel(track, 4.5) - 0.65) < 1e-12, 'steady: half-way at half time');
  assert.equal(sampleLevel(track, 9), 0.5);
  let prev = 0.2;
  for (let i = 0; i <= 200; i++) {
    const v = sampleLevel(track, 1 + i / 100);
    assert.ok(v >= prev - 1e-12, 'it rises without going back');
    prev = v;
  }
  const spec = make([vessel(0.25, [group({ id: 'surface' }), group({ id: 'edge', at: [150, 0] })])], [levelTo('content', { at: 1, to: 0.75, dur: 1 })]);
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const y = (f: number, id: string): number => computeWorld(c, f, posesFromBake(bake))[c.byId.get(id)!.index]!.y;
  // The outline runs from -200 to 200: a quarter full is y = 100, three quarters is y = -100.
  assert.ok(Math.abs(y(0, 'surface') - 100) < 1e-6 && Math.abs(y(120, 'surface') + 100) < 1e-6 && Math.abs(y(90, 'surface')) < 2);
  assert.equal(computeWorld(c, 0, posesFromBake(bake))[c.byId.get('edge')!.index]!.x, 150, 'children keep their place along the surface');
  assert.equal(y(0, 'content'), 0, 'the shape itself does not move');
  // Turned by 90 degrees the shape is 300 high in the layer: the surface is level in the layer's space.
  const turned = compileShot(make([rect({ id: 'content', at: [0, 0], w: 300, h: 400, radius: 20, fill: 'accent.aqua', rotation: 90, level: 0.5 })]));
  const g = levelGeometry(turned.byId.get('content')!, { x: 0, y: 0, rot: Math.PI / 2, scale: 1 }, 0);
  assert.ok(Math.abs(g.top + 150) < 0.5 && Math.abs(g.bottom - 150) < 0.5 && Math.abs(g.flat) < 0.5);
});

test('level: a ripple moves the surface and dies out toward empty and full', () => {
  const rippling = compileShot(make([vessel({ at: 0.5, wave: { amp: 8, length: 100, speed: 50 } })]));
  const n = rippling.byId.get('content')!;
  const xf = { x: 0, y: 0, rot: 0, scale: 1 };
  const ys = [0, 0.2, 0.4, 0.6, 0.8].map((t) => levelGeometry(n, xf, t).y);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 4 && Math.max(...ys.map(Math.abs)) <= 8 + 1e-9, `the middle of the surface bobs within the ripple (${ys.join(', ')})`);
  for (const at of [0, 1]) {
    const flat = compileShot(make([vessel({ at, wave: { amp: 8 } })]));
    assert.equal(levelGeometry(flat.byId.get('content')!, xf, 0.3).amp, 0, 'no ripple at empty or full');
  }
  assert.throws(() => vessel({ at: 0.5, wave: { amp: 8, height: 2 } as never }), /unknown option "height"/);
});

test('level in the review: a level that jumps is a jump, one speed between two rests is mechanical, an eased one is clean', async () => {
  // The planted defects. A level that changes within a frame (a raw key: the intent itself asks for at least 0.05 s).
  const jump = await review(make([vessel(0.2)], [{ kind: 'levelTo', target: 'content', at: 1, to: 0.8, dur: 1 / 60, profile: 'steady', ramp: 0.3 }]));
  assert.deepEqual(flagged(jump), ['jump content']);
  assert.equal(jump.findings[0]!.channel, 'level');
  assert.ok(Math.abs(jump.findings[0]!.value - 240) < 1, 'six tenths of 400 units');
  // One that takes three frames starts and stops abruptly.
  const snap = await review(make([vessel(0.2)], [levelTo('content', { at: 1, to: 0.8, dur: 0.05, profile: 'steady' })]));
  assert.ok(flagged(snap).includes('abrupt-start content') || flagged(snap).includes('jump content'), flagged(snap).join(', '));
  const flat = await review(make([vessel(0.2)], [levelTo('content', { at: 0.5, to: 0.8, dur: 2, profile: 'steady' })]));
  assert.deepEqual(flagged(flat), ['mechanical content']);
  // The sound scenes: the default, and a level that fills the whole shot at one speed (a flow has no rest in view).
  assert.deepEqual(flagged(await review(make([vessel(0.2)], [levelTo('content', { at: 0.5, to: 0.8, dur: 2 })]))), []);
  assert.deepEqual(flagged(await review(make([vessel(0.2)], [levelTo('content', { at: -1, to: 0.9, dur: 6, profile: 'steady' })]))), []);
  // A level that moves keeps its part of the frame alive: without it this shot holds for too long.
  const dead = await review(make([vessel(0.5)], [], 6));
  assert.ok(flagged(dead).includes('dead-area (frame)'));
  const alive = await review(make([vessel(0.1)], [levelTo('content', { at: 0, to: 0.9, dur: 6, profile: 'in' })], 6));
  assert.ok(!flagged(alive).includes('dead-area (frame)'));
  assert.ok(!flagged(await review(make([vessel({ at: 0.5, wave: { amp: 14, length: 120, speed: 80 } })], [], 6))).includes('dead-area (frame)'), 'a ripple is alive too');
});

test('clipTo a content: what is clipped to it is drawn only in its filled part', async () => {
  const speck = circle({ id: 'speck', at: [0, 0], r: 60, fill: 'light.snow', lit: false, clipTo: 'content' });
  const without = await picture(make([vessel(0.5)]));
  const withIt = await picture(make([vessel(0.5), speck]));
  assert.ok(far(withIt.at(0, 30), without.at(0, 30)) > 60, 'its lower half, in the content, is drawn');
  assert.deepEqual(withIt.at(0, -30), without.at(0, -30), 'its upper half, above the surface, is not');
  // In an empty content nothing is drawn at all.
  assert.ok((await picture(make([vessel(0), speck]))).raw.equals((await picture(make([]))).raw));
});

// --- A body that appears at its release ---------------------------------------------

test('body.appear: a body that waits for its release is not drawn, and adds no glow, until it is released', async () => {
  const drop = (appear?: 'release'): ShotSpec =>
    make([circle({ id: 'drop', at: [0, -200], r: 30, fill: 'accent.amber', glow: 1, body: { kind: 'dynamic', release: 1, ...(appear ? { appear } : {}) } })]);
  const empty = await picture(make([]));
  assert.ok((await picture(drop('release'), 30)).raw.equals(empty.raw), 'before its release there is nothing, not even its lift');
  assert.ok(!(await picture(drop(), 30)).raw.equals(empty.raw), 'by default it is drawn where it waits');
  assert.ok((await picture(drop('release'), 90)).raw.equals((await picture(drop(), 90)).raw), 'from its release on it is the same body');
  assert.throws(() => circle({ id: 'd', r: 3, fill: 'accent.amber', body: { kind: 'dynamic', release: 0, appear: 'later' as never } }), /body\.appear must be/);
});

// --- Particles of steady size ---------------------------------------------------------

test('emitter sizing: steady particles keep their size for nearly all of their life', async () => {
  assert.equal(steadySizeOverLife(0.5), 1);
  assert.equal(steadySizeOverLife(0.9), 1);
  assert.ok(sizeOverLife(0.9) < 0.15, 'a spark has all but gone by then');
  assert.equal(steadySizeOverLife(0), 0);
  assert.equal(steadySizeOverLife(1), 0);
  assert.ok(steadySizeOverLife(0.04) > 0.4 && steadySizeOverLife(0.04) < 0.6, 'a short swell at the start');
  const stream = (sizing?: 'steady') =>
    make([emitter({ id: 'e', at: [0, 0], rate: 30, life: 2, size: 10, speed: 100, colors: ['accent.amber'], prewarm: 2, ...(sizing ? { sizing } : {}) })]);
  const radii = async (spec: ShotSpec): Promise<number[]> => {
    const c = compileShot(spec);
    const data = (await bakeShot(c)).particlesAt(0, 60);
    const out: number[] = [];
    for (let i = 2; i < data.length; i += 4) out.push(data[i]!);
    return out;
  };
  const steady = await radii(stream('steady'));
  const spark = await radii(stream());
  const full = (r: number[]): number => r.filter((v) => v > 9.9).length / r.length;
  assert.ok(full(steady) > 0.8, `most steady particles are at full size (${full(steady)})`);
  assert.ok(full(spark) < 0.5, `most sparks are not (${full(spark)})`);
  assert.throws(() => emitter({ id: 'e', rate: 1, life: 1, size: 1, colors: ['accent.amber'], sizing: 'big' as never }), /sizing must be "spark" or "steady"/);
});

// --- Backdrop and no-break spaces ----------------------------------------------------------

test('backdrop: a label may lie over a backdrop without a warning; over anything else it is still reported', async () => {
  const scene = (backdrop?: boolean): ShotSpec =>
    make([
      rect({ id: 'ground', at: [0, -60], w: 1200, h: 300, radius: 0, fill: 'dark.indigo', ...(backdrop === undefined ? {} : { backdrop }) }),
      circle({ id: 'a', at: [0, 40], r: 30, fill: 'accent.aqua' }),
      label({ id: 'tag', text: 'label.a', target: 'a', fill: 'light.cream', ink: 'deep.abyss' }),
    ]);
  const warnings = async (spec: ShotSpec): Promise<string[]> => {
    const c = compileShot(spec);
    const report = await runChecks(c, await bakeShot(c), ['en']);
    return report.issues.filter((i) => i.message.includes('covers node')).map((i) => i.message);
  };
  assert.equal((await warnings(scene())).length, 1);
  assert.match((await warnings(scene()))[0]!, /covers node "ground"/);
  assert.deepEqual(await warnings(scene(true)), []);
});

test('layout: a no-break space keeps two words on one line', () => {
  const style = { size: 30, minSize: 30, weight: 700, maxWidth: 150, maxLines: 4 };
  // U+00A0, named here so that it can be seen in this file.
  const NBSP = String.fromCharCode(0xa0);
  const plain = layoutText('about 50 per year', style);
  const glued = layoutText(`about 50${NBSP}per${NBSP}year`, style);
  assert.ok(plain.lines.length >= 2 && !plain.lines.some((l) => l.includes('50 per year')), `with ordinary spaces the words wrap: ${JSON.stringify(plain.lines)}`);
  assert.ok(glued.lines.some((l) => l.includes(`50${NBSP}per${NBSP}year`)), `the glued words share a line: ${JSON.stringify(glued.lines)}`);
  // A narrow no-break space and a figure space glue too.
  for (const code of [0x202f, 0x2007]) {
    const g = String.fromCharCode(code);
    assert.ok(layoutText(`about 50${g}per${g}year`, style).lines.some((l) => l.includes(`50${g}per${g}year`)));
  }
  // Strings without one lay out as before.
  assert.deepEqual(layoutText('one two three', style).lines.join(' '), 'one two three');
});

// --- Squash and stretch ---------------------------------------------------------------------

test('squash: a kick that makes the picture lower and wider about a point, and rings out', async () => {
  const track = buildStretchTrack([squash('a', { at: 1, amount: -0.25, dur: 0.6, pivot: [0, 50] })]);
  assert.equal(sampleStretch(track, 0.9), null);
  assert.equal(sampleStretch(track, 1.7), null, 'it has rung out');
  let low = 1;
  let high = 1;
  for (let i = 1; i < 60; i++) {
    const s = sampleStretch(track, 1 + i / 100);
    if (!s) continue;
    low = Math.min(low, s.height);
    high = Math.max(high, s.height);
  }
  assert.ok(Math.abs(low - 0.75) < 0.02, `it squashes to about three quarters (${low})`);
  assert.ok(high > 1.01 && high < 1.15, `and springs back a little past its size (${high})`);
  // In the picture: lower at the top, wider at the sides, and its foot stays where it was.
  const ball = make([circle({ id: 'a', at: [0, 0], r: 50, fill: 'accent.amber', lit: false })], [squash('a', { at: 0.5, amount: -0.3, dur: 0.6, pivot: [0, 50] })]);
  const rest = await picture(ball, 0);
  const worst = await picture(ball, 35);
  const empty = await picture(make([]));
  assert.ok(far(rest.at(0, -42), empty.at(0, -42)) > 60 && far(worst.at(0, -42), empty.at(0, -42)) === 0, 'its top comes down');
  assert.ok(far(rest.at(58, 14), empty.at(58, 14)) === 0 && far(worst.at(58, 14), empty.at(58, 14)) > 60, 'its sides go out');
  assert.ok(far(worst.at(0, 44), empty.at(0, 44)) > 60, 'its foot stays');
  assert.ok((await picture(ball, 100)).raw.equals(rest.raw), 'afterwards it is the picture it was');
  // Opt-in: no key, no wrapper in the display list.
  const c = compileShot(ball);
  const bake = await bakeShot(c);
  assert.deepEqual(evaluate(c, bake, 0, 'en').layers[0]!.items.map((i) => i.kind), ['shape']);
  assert.deepEqual(evaluate(c, bake, 35, 'en').layers[0]!.items.map((i) => i.kind), ['stretch']);
  assert.throws(() => make([label({ id: 'l', text: 'label.a', target: 'a', fill: 'light.cream', ink: 'deep.abyss' }), circle({ id: 'a', r: 9, fill: 'accent.aqua' })], [squash('l', { at: 0 })]), /applies to shapes, groups, eyes, strokes and texts/);
  // A move that is squashed on the way is still judged as a move.
  const moved = await review(make([circle({ id: 'a', at: [-200, 0], r: 50, fill: 'accent.amber' })], [moveTo('a', { at: 0.5, to: [200, 0] }), squash('a', { at: 1.2, amount: -0.2 })]));
  assert.deepEqual(flagged(moved), []);
});
