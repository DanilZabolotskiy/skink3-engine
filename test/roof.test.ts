import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blob, circle, group, rect, region, riseTo, type LayerSpec } from '../src/index.ts';
import { at, dark, draw, make, pale, red, refused, shade } from './fixtures/bodies.ts';

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
  // A free outline keeps its flat top.
  const points = [[0, 0], [100, 0], [100, 100], [50, 40], [0, 100]] as [number, number][];
  assert.ok(refused(() => region({ id: 'r', points, fill: 'light.snow', rise: 60, roof: { kind: 'hip', height: 40 } }), /a roof stands on a circle, a capsule, a rect or a polygon/));
  assert.ok(refused(() => blob({ id: 'r', r: 60, fill: 'light.snow', rise: 60, roof: { kind: 'dome', height: 40 } }), /a roof stands on a circle, a capsule, a rect or a polygon/));
});

test('roof: it is opt-in: a body without one is the data it was', () => {
  const plain = rect({ id: 'b', w: 200, h: 100, fill: 'light.snow', rise: 60 });
  assert.ok(!('roof' in plain));
  const roofed = rect({ id: 'b', w: 200, h: 100, fill: 'light.snow', rise: 60, roof: { kind: 'hip', height: 40 } });
  assert.deepEqual(roofed.roof, { kind: 'hip', height: 40 });
  assert.deepEqual({ ...roofed, roof: undefined }, { ...plain, roof: undefined });
});
