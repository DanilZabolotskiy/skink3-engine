import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  backgroundTo,
  bakeShot,
  blurTo,
  cameraTo,
  capsule,
  circle,
  compileShot,
  cut,
  drive,
  emitter,
  evaluate,
  fadeTo,
  fillTo,
  formatMotionReport,
  frameRaw,
  group,
  heightFor,
  intended,
  IntentError,
  layer,
  moveTo,
  perspectiveTo,
  reviewMotion,
  reviewPhysics,
  sceneEvents,
  shot,
  zoomTo,
  type Key,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';

// A hard cut inside one shot (cut): one take of narration over two pictures. On the frame of the cut the camera, the
// background, a perspective layer, a layer's focus and fades may take their new values at once (dur: 0), the push-in
// starts again, springs start again at rest, and the motion review judges each side as a shot of its own. It is
// opt-in: a shot without a cut is the shot it was.

const WIDTH = 480;
const AT = 2; // the moment of the cut: frame 120
const F = 120;

type Options = { seconds?: number; camera?: Parameters<typeof shot>[0]['camera']; intended?: ShotSpec['intended']; extra?: LayerSpec[]; nodes?: LayerSpec['nodes'] };

function make(timeline: Key[], o: Options = {}): ShotSpec {
  return shot({
    id: 'cutting',
    seconds: o.seconds ?? 4,
    seed: 3,
    palette,
    strings: { en: {} },
    background: { inner: 'dark.indigo', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0.4,
    camera: o.camera ?? { drift: { speed: 0.5, wander: 0 }, pushIn: { from: 1, to: 1.04 } },
    layers: [
      layer({ id: 'far', depth: 1, blur: 4, nodes: [circle({ id: 'hill', at: [-500, 200], r: 260, fill: 'mid.jade', lit: false, idle: { amp: 6, period: 3 } })] }),
      layer({
        id: 'stage',
        depth: 0,
        nodes: o.nodes ?? [
          // The first picture: an amber set.
          group({ id: 'first', children: [circle({ id: 'puck', at: [-200, 0], r: 120, fill: 'accent.amber', idle: { amp: 8, period: 2.5 } })] }),
          // The second: a blue one, at the place of the first, faded in on the frame of the cut.
          group({ id: 'second', opacity: 0, children: [circle({ id: 'ball', at: [-200, 0], r: 120, fill: 'accent.azure', idle: { amp: 8, period: 2.5 } })] }),
          emitter({ id: 'motes', at: [0, 0], area: [1600, 800], colors: ['light.snow'], size: [3, 5], life: 3, rate: 30, prewarm: 3, speed: [10, 20], sizing: 'steady', opacity: 0 }),
        ],
      }),
      ...(o.extra ?? []),
    ],
    timeline,
    ...(o.intended ? { intended: o.intended } : {}),
  });
}

/** The keys of a cut from the amber set to the blue one, at AT. */
const swap = (): Key[] => [
  cut({ at: AT }),
  fadeTo('first', { at: AT, to: 0, dur: 0 }),
  fadeTo('second', { at: AT, to: 1, dur: 0 }),
  fadeTo('motes', { at: AT, to: 1, dur: 0 }),
  cameraTo({ at: AT, dur: 0, zoom: 1.6, to: [-200, 0] }),
  backgroundTo({ at: AT, dur: 0, inner: 'deep.ink', outer: 'deep.abyss', atmosphere: 'dark.navy', vignette: 0.7 }),
  blurTo('far', { at: AT, dur: 0, to: 10 }),
];

async function raw(spec: ShotSpec, frame: number): Promise<Buffer> {
  const c = compileShot(spec);
  return frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
}

const hash = async (spec: ShotSpec, frame: number): Promise<string> => createHash('sha256').update(await raw(spec, frame)).digest('hex');

/** The colour of a pixel, at a place of the stage. */
async function pixel(spec: ShotSpec, frame: number, x: number, y: number): Promise<[number, number, number]> {
  const r = await raw(spec, frame);
  const k = WIDTH / 1920;
  const i = (Math.round(heightFor(WIDTH) / 2 + y * k) * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4;
  return [r[i]!, r[i + 1]!, r[i + 2]!];
}

async function findings(spec: ShotSpec): Promise<string[]> {
  const c = compileShot(spec);
  return reviewMotion(c, await bakeShot(c)).report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel} f${f.from}-${f.to}`);
}

test('cut: a key of the timeline without a node; what it refuses', () => {
  assert.deepEqual(cut({ at: 2.5 }), { kind: 'cut', target: null, at: 2.5 });
  assert.throws(() => cut({ at: 0 }), (e: unknown) => e instanceof IntentError && /at must be after the start of the shot/.test(e.message));
  assert.throws(() => cut({ at: 1, dur: 0 } as never), /cut: unknown option "dur" \(allowed: at\)/);
  // Six keys may take no time; the others keep their least duration, and none takes one shorter than its least.
  assert.equal(cameraTo({ at: 1, zoom: 2, dur: 0 }).dur, 0);
  assert.equal(zoomTo({ at: 1, to: 2, dur: 0 }).dur, 0);
  assert.equal(backgroundTo({ at: 1, inner: 'deep.ink', dur: 0 }).dur, 0);
  assert.equal(perspectiveTo('first', { at: 1, tilt: 30, dur: 0 }).dur, 0);
  assert.equal(blurTo('far', { at: 1, to: 2, dur: 0 }).dur, 0);
  assert.equal(fadeTo('puck', { at: 1, to: 0, dur: 0 }).dur, 0);
  assert.throws(() => cameraTo({ at: 1, zoom: 2, dur: 0.01 }), /dur must be a number in 0\.05\.\.600, or 0 on the frame of a hard cut/);
  assert.throws(() => backgroundTo({ at: 1, inner: 'deep.ink', dur: 0.05 }), /dur must be a number in 0\.1\.\.600, or 0 on the frame of a hard cut/);
  assert.throws(() => fillTo('puck', { at: 1, to: 'accent.coral', dur: 0 }), /dur must be a number in 0\.05\.\.600/);
  assert.throws(() => moveTo('puck', { at: 1, to: [0, 0], dur: 0 }), /dur must be a number in 0\.1\.\.60/);
  // The shot holds a key of no time to a cut on its frame.
  assert.throws(() => make([fadeTo('first', { at: AT, to: 0, dur: 0 })]), /fadeTo\("first"\) at 2 s takes no time \(dur: 0\); that is for the frame of a hard cut: add cut\(\{ at: 2 \}\)/);
  assert.throws(() => make([cut({ at: 1 }), cameraTo({ at: AT, zoom: 2, dur: 0 })]), /cameraTo at 2 s takes no time/);
  assert.throws(() => make([cut({ at: AT }), blurTo('far', { at: AT + 0.1, to: 2, dur: 0 })]), /blurTo\("far"\) at 2\.1 s takes no time/);
  assert.throws(() => make([cut({ at: AT }), fadeTo('first', { at: AT, to: 0, dur: 0, sound: 'tick' })]), /a part of the cut, which makes no sound/);
  // A cut lies inside the shot, once to a frame, and each picture lasts a tenth of a second at least.
  assert.throws(() => make([cut({ at: 9 })]), /cut at 9 s comes after the last frame of the shot/);
  assert.throws(() => make([cut({ at: AT }), cut({ at: AT - 0.005 })]), /two cuts fall on frame 120/);
  assert.throws(() => make([cut({ at: AT }), cut({ at: AT + 0.05 })]), /lasts 3 frame\(s\); a picture lasts 6 frames \(0\.1 s\) at least/);
  assert.throws(() => make([cut({ at: 0.05 })]), /from frame 0 to frame 2 between cuts lasts 3 frame/);
  // The speed of the camera may step only at a cut.
  const stepping = { drift: { speeds: [[0, 30], [AT, 30], [AT, 0]] as [number, number][], wander: 0 } };
  assert.throws(() => make([], { camera: stepping }), /two keys may share a moment only at a hard cut/);
  assert.doesNotThrow(() => make([cut({ at: AT })], { camera: stepping }));
});

test('cut: opt-in: a shot without one is the data and the picture it was; a cut alone changes nothing before it', async () => {
  const plain = compileShot(make([]));
  assert.equal('cuts' in plain, false);
  assert.equal(plain.cameraTrack, null);
  const level = { drift: { speed: 0.5, wander: 0 }, pushIn: { from: 1, to: 1 } };
  const bare = make([], { camera: level });
  const marked = make([cut({ at: AT })], { camera: level });
  assert.deepEqual(compileShot(marked).cuts, [F]);
  // Without a push-in a cut that nothing else marks draws every frame as the shot without it.
  for (const frame of [0, F - 1, F, 200]) assert.equal(await hash(marked, frame), await hash(bare, frame), `frame ${frame}`);
  // With a push-in, the first picture is as it was; the second pushes in from the start again.
  for (const frame of [0, 60, F - 1]) assert.equal(await hash(make([cut({ at: AT })]), frame), await hash(make([]), frame), `frame ${frame}`);
  assert.notEqual(await hash(make([cut({ at: AT })]), F), await hash(make([]), F));
});

test('cut: on its frame the second picture is there whole: camera, background, focus, fades, emitters', async () => {
  const spec = make(swap());
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const at = (frame: number) => evaluate(c, bake, frame, 'en');
  const [before, after] = [at(F - 1), at(F)];
  // The camera jumps to its key at once; the push-in starts again from its from.
  assert.ok(Math.abs(before.camera.keyZoom! - 1) < 1e-9 && Math.abs(after.camera.keyZoom! - 1.6) < 1e-9, `${before.camera.keyZoom} ${after.camera.keyZoom}`);
  assert.ok(Math.abs(after.camera.x - -200) < 1e-6 && Math.abs(after.camera.y) < 1e-6, `${after.camera.x} ${after.camera.y}`);
  // It pushes in at the speed it has over the shot: the first picture as without the cut, the second from 1 again.
  const push = (u: number): number => 1.04 ** u;
  assert.ok(Math.abs(before.camera.zoom - push(119 / 239)) < 1e-12 && Math.abs(after.camera.zoom - 1) < 1e-12, `${before.camera.zoom} ${after.camera.zoom}`);
  assert.ok(Math.abs(at(c.frames - 1).camera.zoom - push(119 / 239)) < 1e-12);
  // The background, the atmosphere and the focus of the far layer: the old values to the last frame, the new on the cut.
  assert.equal(before.background!.inner, c.background.inner);
  assert.equal(after.background!.inner, c.backgroundTrack!.segs[0]!.to.inner);
  assert.notEqual(after.background!.inner, before.background!.inner);
  assert.equal(after.background!.vignette, 0.7);
  assert.equal(before.layers[0]!.blur, 4);
  assert.equal(after.layers[0]!.blur, 10);
  // The fades: the amber set is gone and the blue one there, with the particles that ran unseen from the start.
  const seen = (state: typeof before, id: string): boolean => JSON.stringify(state.layers[1]!.items, (k, v) => (k === 'node' ? v.id : v)).includes(`"${id}"`);
  assert.ok(seen(before, 'puck') && !seen(before, 'ball') && !seen(before, 'motes'));
  assert.ok(!seen(after, 'puck') && seen(after, 'ball') && seen(after, 'motes'));
  // In the picture: the sky in the corner is the first one up to the cut and the second one on it; the set swaps.
  const corner = async (frame: number) => pixel(spec, frame, -900, -500);
  const [sky0, sky1] = [await corner(F - 1), await corner(F)];
  assert.ok(Math.abs(sky0[0] - sky1[0]) + Math.abs(sky0[2] - sky1[2]) > 20, `${sky0} ${sky1}`);
  assert.deepEqual(await corner(F), await corner(F + 1), 'the new sky is there whole on the first frame');
  // The puck stands left of the middle in the first picture; the camera is on the ball in the second.
  const [puck, ball] = [await pixel(spec, F - 1, -265, 0), await pixel(spec, F, 0, 0)];
  assert.ok(puck[0] > puck[2] && ball[2] > ball[0], `${puck} ${ball}`);
  // A cut, and what takes no time on it, makes no event of the sound track.
  assert.deepEqual(sceneEvents(c, bake).map((e) => e.kind), []);
});

test('cut: a perspective layer and a zoom key take their values at once, and the speed of the camera steps', async () => {
  const space = layer({ id: 'space', depth: 0, perspective: { aim: [0, 0, 0], distance: 1600, tilt: 10 }, nodes: [circle({ id: 'post', at: [300, 0, 200], r: 60, fill: 'accent.coral' })] });
  const camera = { drift: { speeds: [[0, 30], [AT, 30], [AT, 0]] as [number, number][], wander: 0 }, pushIn: { from: 1, to: 1 } };
  const spec = make([cut({ at: AT }), perspectiveTo('space', { at: AT, dur: 0, tilt: 60, distance: 900 }), zoomTo({ at: AT, dur: 0, to: 1.3 })], { extra: [space], camera });
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const persp = c.layers[2]!.persp!;
  const { perspAt } = await import('../src/scene/space.ts');
  assert.equal(perspAt(persp, (F - 1) / 60).tilt, 10);
  assert.equal(perspAt(persp, F / 60).tilt, 60);
  assert.equal(perspAt(persp, F / 60).distance, 900);
  const cam = (f: number) => evaluate(c, bake, f, 'en').camera;
  assert.equal(cam(F - 1).keyZoom, 1);
  assert.equal(cam(F).keyZoom, 1.3);
  // The drift ran at 30 units a second up to the cut, and stands from it on.
  assert.ok(Math.abs(cam(F).x - cam(F - 1).x - 0.5) < 1e-9, `${cam(F).x - cam(F - 1).x}`);
  assert.ok(Math.abs(cam(200).x - cam(F).x) < 1e-9);
});

test('cut: springs start again at rest on its frame', async () => {
  const swinging = [
    group({ id: 'arm', at: [0, 0], children: [capsule({ id: 'stick', at: [0, 0], length: 160, r: 12, origin: 'start', fill: 'mid.rose', sway: 'springy' })] }),
  ];
  const keys = [moveTo('arm', { at: 1.4, to: [500, 0], dur: 0.6, profile: 'ease' })];
  const c = compileShot(make([...keys, cut({ at: AT })], { nodes: swinging }));
  const bake = await bakeShot(c);
  const free = compileShot(make(keys, { nodes: swinging }));
  const freeBake = await bakeShot(free);
  const slot = c.byId.get('stick')!.springSlot;
  const lean = (b: typeof bake, frame: number): number => Math.hypot(b.springX(slot, frame) - b.springX(slot, frame - 1), b.springY(slot, frame) - b.springY(slot, frame - 1));
  // Without the cut the stick still swings after the arm has stopped; with it, it hangs at rest from the cut on.
  assert.ok(lean(freeBake, F + 10) > 0.05, `${lean(freeBake, F + 10)}`);
  assert.ok(lean(bake, F + 10) < 1e-9, `${lean(bake, F + 10)}`);
});

test('cut: the motion review judges each side as a shot of its own: the sound cut is clean, its old stand-ins are not', async () => {
  // The sound scene: the set swaps, the camera jumps, the sky and the focus change, all on the frame of the cut.
  assert.deepEqual(await findings(make(swap())), []);
  // The planted defects: the same picture without the cut, one frame of opacity and of camera instead.
  const oneFrame: Key[] = [
    drive('first', { at: AT - 1 / 60, dur: 1 / 60, by: (t) => ({ opacity: t > 0 ? 0 : 1 }) }),
    drive('second', { at: AT - 1 / 60, dur: 1 / 60, by: (t) => ({ opacity: t > 0 ? 1 : 0 }) }),
    cameraTo({ at: AT - 0.05, dur: 0.05, zoom: 1.6, to: [-200, 0], profile: 'steady' }),
  ];
  const leaps = await findings(make(oneFrame));
  for (const subject of ['first', 'second']) assert.ok(leaps.some((f) => f.startsWith(`jump ${subject} opacity`)), `${subject}: ${leaps.join('; ')}`);
  // A camera key takes three frames at least: there it starts and stops at full speed.
  assert.ok(leaps.some((f) => f.startsWith('abrupt-start (camera)')) && leaps.some((f) => f.startsWith('abrupt-stop (camera)')), leaps.join('; '));
  // Each side is still judged: a move that starts at full speed after the cut is found there.
  const late = await findings(make([...swap(), moveTo('ball', { at: 3, to: [200, 0], dur: 0.6, anticipation: 0, overshoot: 0 })]));
  assert.ok(late.some((f) => f.startsWith('abrupt-start ball position')), late.join('; '));
  // A hold of the whole frame that the cut parts is two short holds; one as long within one picture is found.
  const still = { drift: { speed: 0.5, wander: 0 }, pushIn: { from: 1, to: 1 } };
  const calm = [circle({ id: 'stone', at: [0, 0], r: 200, fill: 'mid.violet' })];
  assert.deepEqual((await findings(make([cut({ at: 3.5 })], { seconds: 7, camera: still, nodes: calm }))).filter((f) => f.startsWith('dead-area')), []);
  assert.ok((await findings(make([cut({ at: 5.5 })], { seconds: 7, camera: still, nodes: calm }))).some((f) => f.startsWith('dead-area (frame)')));
});

test('cut: the report leaves the steps across a cut out of the life of the background, and says where the cuts are', async () => {
  const c = compileShot(make(swap()));
  const bake = await bakeShot(c);
  const { report } = reviewMotion(c, bake);
  assert.deepEqual(report.cuts, [F]);
  // The camera drifts 0.5 units a frame, so about half a pixel; the jump of the cut would make it hundreds.
  assert.ok(report.camera.driftMaxPx < 2, `${report.camera.driftMaxPx}`);
  assert.ok(report.camera.travelPx < 300, `${report.camera.travelPx}`);
  assert.ok(report.camera.spanPx[0] < 200, `${report.camera.spanPx}`);
  assert.deepEqual(report.background, []);
  assert.match(formatMotionReport(report, c), /cuts: 2\.00 s \(frame 120\); each side is judged as a shot of its own/);
  // A shot without a cut has no such line.
  const plain = compileShot(make([]));
  const r = reviewMotion(plain, await bakeShot(plain)).report;
  assert.equal('cuts' in r, false);
  assert.doesNotMatch(formatMotionReport(r, plain), /cuts:/);
  // The physics review reads the fades of no time as the motion review does: a body faded out at the cut is not seen after it.
  assert.deepEqual(reviewPhysics(c, bake).findings, []);
});

test('cut: a sampled backdrop is never blended across a cut', () => {
  const backdrop = (timeline: Key[]) =>
    compileShot({
      ...make([]),
      layers: [
        layer({ id: 'map', depth: 0, nodes: [group({ id: 'land', children: [circle({ id: 'isle', r: 100, fill: 'mid.jade', lit: false })] })], sampledBackdrop: { group: 'land', frames: [60, 180] } }),
      ],
      timeline,
    }).sampledBackdrops![0]!.frames;
  assert.deepEqual(backdrop([]), [0, 60, 180, 239]);
  assert.deepEqual(backdrop([cut({ at: AT })]), [0, 60, F - 1, F, 180, 239]);
});

test('cut: an intended exception still names what it names; a cut needs none', async () => {
  // A jump inside one picture is still a jump, and may be marked as meant.
  const keys = [...swap(), drive('ball', { at: 3, dur: 1 / 60, by: (t) => ({ at: [t > 0 ? 100 : -200, 0] }) })];
  assert.ok((await findings(make(keys))).some((f) => f.startsWith('jump ball position')));
  assert.deepEqual(await findings(make(keys, { intended: [intended('ball', 'jump', 'it is kicked')] })), []);
});
