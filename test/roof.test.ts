import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blob, circle, group, rect, region, riseTo, type LayerSpec, type ShapeNode } from '../src/index.ts';
import type { ShapeSpec } from '../src/shape/geometry.ts';
import { roofFaces } from '../src/shape/solid.ts';
import { at, dark, differing, draw, make, pale, red, refused, shade } from './fixtures/bodies.ts';

// A roof: a body with a height may carry a gable, a hip, a cone or a dome in place of its flat top. Its slopes are
// the fill in the tones of the light, each by the way it faces; its upright ends are the side of the body.

/** A body of 200 by 100 units in the middle of the stage, 60 high, with a pale top and a red side. */
const body = (extra: object = {}): LayerSpec['nodes'] => [rect({ id: 'b', w: 200, h: 100, radius: 0, fill: 'light.snow', lit: false, side: 'accent.coral', rise: 60, ...extra })];
/** A round body of radius 80, 60 high. */
const disc = (extra: object = {}): LayerSpec['nodes'] => [circle({ id: 'b', r: 80, fill: 'light.snow', lit: false, side: 'accent.coral', rise: 60, ...extra })];

test('roof: a gable stands on the top of a body, its two slopes in two tones of the fill, and its upright ends are the side', async () => {
  // The flat top is one tone, and nothing stands over it.
  const flat = await draw(make(body()));
  assert.ok(pale(at(flat, 0, -105)) && pale(at(flat, 0, -60)) && dark(at(flat, 0, -130)));
  // Left to itself the ridge runs along the longer side. The slope that faces the light is the fill, the other a shadow tone of it.
  const gable = await draw(make(body({ roof: { kind: 'gable', height: 40 } })));
  assert.ok(pale(at(gable, 0, -105)), 'the far slope faces the light');
  assert.ok(shade(at(gable, 0, -60)) && shade(at(gable, 0, -15)), 'the near slope is turned from it');
  assert.ok(red(at(gable, 0, 20)), 'the side is under the roof as it was');
  assert.ok(dark(at(gable, 0, 58)), 'and the foot stays');
  // ridge turns it: now the slopes are left and right, the roof stands 40 over the top, and its end is the side.
  const across = await draw(make(body({ roof: { kind: 'gable', height: 40, ridge: 90 } })));
  assert.ok(pale(at(across, -50, -80)), 'the left slope');
  assert.ok(shade(at(across, 50, -80)), 'the right slope');
  assert.ok(shade(at(across, 0, -140)), 'the ridge stands over where the flat top ended');
  assert.ok(dark(at(across, 0, -155)));
  assert.ok(red(at(across, 0, -20)), 'the upright end under the ridge is the side');
  assert.ok(pale(at(flat, 0, -20)), 'where the flat top was');
});

test('roof: a hip has four slopes, a cone runs to a point over the middle, a dome is round', async () => {
  const hip = await draw(make(body({ roof: { kind: 'hip', height: 40 } })));
  const near = at(hip, 0, -60);
  const right = at(hip, 90, -80);
  assert.ok(pale(at(hip, -90, -80)), 'the left end of a hip is a slope, and faces the light');
  assert.ok(shade(near) && shade(right) && right[0] < near[0] - 5, `the right end ${right} is darker than the near slope ${near}`);
  assert.ok(pale(at(hip, 0, -105)), 'the far slope');

  // A cone: the point is over the middle, so in a flat layer it stands no higher on screen than the far edge did.
  const cone = await draw(make(disc({ roof: { kind: 'cone', height: 80 } })));
  assert.ok(pale(at(cone, -40, -70)) && shade(at(cone, 40, -70)), 'a lit half and a half in shadow');
  assert.ok(dark(at(cone, 0, -150)));
  assert.ok(red(at(cone, 0, 70)), 'the round side under it');

  // A dome bulges over the far edge, and is shaded in more than two tones.
  const dome = await draw(make(disc({ roof: { kind: 'dome', height: 80 } })));
  assert.ok(pale(at(dome, 0, -170)), 'the dome stands over the far edge');
  assert.ok(dark(at(dome, 0, -200)));
  const tones = [at(dome, -40, -70)[0], at(dome, 10, -70)[0], at(dome, 70, -70)[0]];
  assert.ok(tones[0]! > tones[1]! + 20 && tones[1]! > tones[2]! + 20, `from the light round to the shadow: ${tones}`);
});

test('roof: it rides on the body as riseTo raises it, and a body of height 0 keeps its roof', async () => {
  const roof = { kind: 'gable', height: 40 } as const;
  const spec = make(body({ rise: 0, roof }), [riseTo('b', { at: 0.5, to: 60, dur: 1 })]);
  // On the ground: the roof alone, with no side under it.
  const low = await draw(spec, 0);
  assert.ok(pale(at(low, 0, -45)) && shade(at(low, 0, 0)) && dark(at(low, 0, 58)));
  // Raised: the picture of a body that is 60 high.
  assert.deepEqual(await draw(spec, 120), await draw(make(body({ roof }))));
});

test('roof: in a plane of a perspective layer a slope keeps its tone as the camera goes round it', async () => {
  const floor = (turn: number): Parameters<typeof make> => [[group({ id: 'floor', at: [0, 0, 0], plane: 'floor', children: body({ roof: { kind: 'gable', height: 40, ridge: 90 } }) })], [], { perspective: { tilt: 50, turn } }];
  const front = await draw(make(...floor(0)));
  assert.ok(pale(at(front, -50, -40)) && shade(at(front, 50, -40)), 'the lit slope is on the left');
  assert.ok(red(at(front, 0, 20)), 'the side');
  // From the other side the same slope is on the right: the light is that of the shot, not of the screen.
  const back = await draw(make(...floor(180)));
  assert.ok(shade(at(back, -50, -40)) && pale(at(back, 50, -40)));
});

test('roof: what cannot be a roof is refused', () => {
  const where = { id: 'b', w: 200, h: 100, fill: 'light.snow' } as const;
  assert.ok(refused(() => rect({ ...where, roof: { kind: 'gable', height: 40 } }), /roof is the roof of a shape with a height: give rise/), 'a roof without a height under it');
  assert.ok(refused(() => rect({ ...where, rise: 60, roof: { kind: 'flat' as 'gable', height: 40 } }), /roof\.kind must be one of gable, hip, cone, dome/));
  assert.ok(refused(() => rect({ ...where, rise: 60, roof: { kind: 'gable', height: 0 } }), /roof\.height must be a number in 0\.01\.\./));
  assert.ok(refused(() => circle({ id: 'c', r: 50, fill: 'light.snow', rise: 60, roof: { kind: 'cone', height: 40, ridge: 30 } }), /a cone has no ridge: leave ridge out/));
  assert.ok(refused(() => rect({ ...where, rise: 60, roof: { kind: 'gable', height: 40, pitch: 3 } as never }), /unknown option "pitch"/));
  // A region takes a hip alone, and its ridges follow its outline; a blob keeps its flat top.
  const points = [[0, 0], [100, 0], [100, 100], [50, 40], [0, 100]] as [number, number][];
  const free = (roof: object): unknown => region({ id: 'r', points, fill: 'light.snow', rise: 60, roof: roof as never });
  assert.ok(refused(() => free({ kind: 'gable', height: 40 }), /a region takes a hip roof alone: a slope on every stretch of its outline; a gable stands on/));
  assert.ok(refused(() => free({ kind: 'hip', height: 40, ridge: 30 }), /the ridges of a hip on a region follow its outline: leave ridge out/));
  assert.ok(refused(() => free({ kind: 'hip', height: 40, run: 0 }), /roof\.run must be a number in 0\.01\.\./));
  assert.ok(refused(() => rect({ ...where, rise: 60, roof: { kind: 'hip', height: 40, run: 20 } }), /roof\.run is how far in the slopes of a hip on a region run; on this shape the slopes meet in the ridge/));
  assert.ok(refused(() => blob({ id: 'r', r: 60, fill: 'light.snow', rise: 60, roof: { kind: 'dome', height: 40 } }), /a roof stands on a circle, a capsule, a rect, a polygon or a region; a blob has a free outline/));
  // contrast: from 0 (every slope in the fill) to 2.
  assert.ok(refused(() => rect({ ...where, rise: 60, roof: { kind: 'gable', height: 40, contrast: 2.5 } }), /roof\.contrast must be a number in 0\.\.2/));
  assert.ok(refused(() => rect({ ...where, rise: 60, roof: { kind: 'gable', height: 40, contrast: -1 } }), /roof\.contrast must be a number in 0\.\.2/));
});

test('roof: it is opt-in: a body without one is the data it was', () => {
  const plain = rect({ id: 'b', w: 200, h: 100, fill: 'light.snow', rise: 60 });
  assert.ok(!('roof' in plain));
  const roofed = rect({ id: 'b', w: 200, h: 100, fill: 'light.snow', rise: 60, roof: { kind: 'hip', height: 40 } });
  assert.deepEqual(roofed.roof, { kind: 'hip', height: 40 });
  assert.deepEqual({ ...roofed, roof: undefined }, { ...plain, roof: undefined });
  // run and contrast are written only when they are given.
  assert.ok(!('contrast' in roofed.roof!) && !('run' in roofed.roof!));
});

/** An L of two wings 80 wide, 60 high, its corner at the middle of the stage: one wing runs right, the other down. */
const ell = (roof?: NonNullable<Parameters<typeof region>[0]['roof']>): LayerSpec['nodes'] => [
  region({
    id: 'b',
    points: [[-40, -40], [160, -40], [160, 40], [40, 40], [40, 160], [-40, 160]],
    smooth: 0,
    fill: 'light.snow',
    lit: false,
    side: 'accent.coral',
    rise: 60,
    ...(roof ? { roof } : {}),
  }),
];

/** The outline of a node of the stage. */
const shapeOf = (nodes: LayerSpec['nodes']): ShapeSpec => (nodes[0] as ShapeNode).shape;

test('roof: a hip on a region has a slope on every stretch of its outline, and the slopes meet in ridges and valleys', () => {
  const faces = roofFaces(shapeOf(ell()), { kind: 'hip', height: 40 });
  assert.equal(faces.length, 6, 'a slope to each of the six stretches');
  assert.ok(faces.every((f) => !f.wall && f.normal[2] > 0), 'all of them slopes, none upright');
  // The ridges are 40 over the top, half a wing (40 units) in from the edge: every slope is as steep.
  const z = faces.flatMap((f) => [...f.points].filter((_, i) => i % 3 === 2));
  assert.ok(Math.abs(Math.max(...z) - 40) < 1e-9);
  for (const f of faces) assert.ok(Math.abs(f.normal[2] - faces[0]!.normal[2]) < 1e-9);
  // run: the slopes stop 10 units in, at the height, and the rest is flat.
  const flat = roofFaces(shapeOf(ell()), { kind: 'hip', height: 40, run: 10 });
  assert.equal(flat.length, 7, 'six slopes and a flat top');
  assert.ok(flat.some((f) => f.normal[2] === 1 && [...f.points].every((v, i) => i % 3 !== 2 || Math.abs(v - 40) < 1e-9)));
  assert.ok(flat.filter((f) => f.normal[2] < 1).every((f) => Math.abs(f.normal[2] - Math.cos(Math.atan(4))) < 1e-9), 'each slope rises 40 over 10');
});

test('roof: a hip on a region whose outline is a rectangle is the hip of the rect', async () => {
  const roof = { kind: 'hip', height: 40 } as const;
  const box = await draw(make(body({ roof })));
  const free = await draw(make([region({ id: 'b', points: [[-100, -50], [100, -50], [100, 50], [-100, 50]], smooth: 0, fill: 'light.snow', lit: false, side: 'accent.coral', rise: 60, roof })]));
  assert.ok(differing(box, free, 24) < 40, `${differing(box, free, 24)} pixels differ`);
});

test('roof: a hip on an L stands on its top, each slope in the tone its turn to the light gives', async () => {
  const raw = await draw(make(ell({ kind: 'hip', height: 20 })));
  const top = await draw(make(ell()));
  // The flat top is the fill all over; the roof's slopes that look away from the viewer face the light.
  assert.ok(pale(at(top, 100, -50)) && shade(at(raw, 100, -50)), 'the near slope of the right wing is turned from the light');
  assert.ok(pale(at(raw, 100, -90)), 'its far slope faces it');
  assert.ok(pale(at(raw, -20, 60)) && shade(at(raw, 20, 60)), 'the two long slopes of the down wing');
  assert.ok(red(at(raw, 100, 10)), 'the side under the roof');
  assert.ok(dark(at(raw, 100, -104)), 'a low roof stays within the top it stands on');
});

test('roof: contrast spreads the tones of the slopes from the fill, or draws them in', async () => {
  const roof = { kind: 'gable', height: 40 } as const;
  const plain = await draw(make(body({ roof })));
  assert.deepEqual(await draw(make(body({ roof: { ...roof, contrast: 1 } }))), plain, 'a contrast of 1 is the light as it is');
  // 0: both slopes in the fill.
  const none = await draw(make(body({ roof: { ...roof, contrast: 0 } })));
  assert.ok(pale(at(none, 0, -105)) && pale(at(none, 0, -60)), 'the near slope in the fill too');
  // 2: the slope turned from the light is darker than it is with the light as it is, and the lit one stays.
  const strong = await draw(make(body({ roof: { ...roof, contrast: 2 } })));
  const [a, b] = [at(plain, 0, -60), at(strong, 0, -60)];
  assert.ok(shade(a) && b[0] < a[0] - 20, `darker: ${b} under ${a}`);
  assert.ok(pale(at(strong, 0, -105)));
  // A round roof as well, corner by corner.
  const dome = await draw(make(disc({ roof: { kind: 'dome', height: 80 } })));
  const flatDome = await draw(make(disc({ roof: { kind: 'dome', height: 80, contrast: 0 } })));
  assert.ok(shade(at(dome, 70, -70)) && pale(at(flatDome, 70, -70)));
});
