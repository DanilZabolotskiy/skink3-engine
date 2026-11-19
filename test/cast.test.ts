import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakeShot, compileShot, group, rect, reviewMotion, riseTo, stroke, type LayerSpec, type ShotSpec } from '../src/index.ts';
import { aqua, at, dark, draw, items, make, pale, refused } from './fixtures/bodies.ts';

// Shadows: the bodies of a group that says `cast` throw shadows on the ground the group lies on, each as long as
// its body is high.

/** A body of 200 by 100 units in the middle of the stage, 60 high: its foot ends at x 100 and at y 50. */
const body = (extra: object = {}): LayerSpec['nodes'] => [rect({ id: 'b', w: 200, h: 100, radius: 0, fill: 'light.snow', lit: false, side: 'accent.coral', rise: 60, ...extra })];

type Cast = NonNullable<Parameters<typeof group>[0]['cast']>;

/** A group whose bodies cast. */
const casting = (cast: Cast, children: LayerSpec['nodes']): LayerSpec['nodes'] => [group({ id: 'g', cast, children })];

/** Whole, sharp shadows to the right, as long as the bodies are high. */
const plain = { color: 'accent.aqua', opacity: 1, dir: 0, length: 1 } as const;

test('cast: a body throws a shadow on the ground, as long as it is high, the way dir says', async () => {
  const right = await draw(make(casting(plain, body())));
  assert.ok(aqua(at(right, 110, 20)) && aqua(at(right, 157, 20)), '60 units to the right of the foot');
  assert.ok(dark(at(right, 163, 20)) && dark(at(right, -110, 20)) && dark(at(right, 0, 70)), 'and no farther, and nowhere else');
  assert.ok(pale(at(right, 0, -60)), 'the body stands over it');

  // length: units of shadow to each unit of height.
  const long = await draw(make(casting({ ...plain, length: 2 }, body())));
  assert.ok(aqua(at(long, 215, 20)) && dark(at(long, 225, 20)));
  // dir: degrees, 90 is down the screen.
  const down = await draw(make(casting({ ...plain, dir: 90 }, body())));
  assert.ok(aqua(at(down, 0, 107)) && dark(at(down, 0, 113)) && dark(at(down, 130, 20)));

  // The shadow grows with the body.
  const rising = make(casting(plain, body({ rise: 0 })), [riseTo('b', { at: 0, to: 60, dur: 2 })]);
  assert.ok(dark(at(await draw(rising, 0), 110, 20)), 'a body of no height casts none');
  const half = await draw(rising, 60);
  assert.ok(aqua(at(half, 125, 20)) && dark(at(half, 135, 20)), 'half-way up it is half as long');

  // A shape that lies flat casts nothing.
  const flat = await draw(make(casting(plain, [rect({ id: 'b', w: 200, h: 100, radius: 0, fill: 'light.snow', lit: false })])));
  assert.ok(dark(at(flat, 110, 20)));

  // The shadows are an item of their own, drawn before the bodies of the group.
  const list = await items(make(casting(plain, body())));
  assert.deepEqual(list.map((i) => i.kind), ['cast', 'shape']);
});

test('cast: the shadows are a leaf like any other, read by its node and by how much of it is there', async () => {
  // What reads a list asks every leaf but particles for its node and its alpha, whatever kind it is.
  const there = (list: Awaited<ReturnType<typeof items>>, id: string): number => {
    let most = 0;
    for (const i of list) if (i.kind !== 'particles' && i.node.id === id && i.alpha > most) most = i.alpha;
    return most;
  };
  assert.equal(there(await items(make(casting(plain, body()))), 'g'), 1, 'whole bodies, whole shadows');
  const half = there(await items(make(casting(plain, body({ opacity: 0.5 })))), 'g');
  assert.ok(Math.abs(half - 0.5) < 1e-9, `a body that is half there: ${half}`);
});

test('cast: left to itself a shadow falls away from the light of the shot', async () => {
  const node = group({ id: 'g', cast: { color: 'deep.abyss' }, children: body() });
  assert.deepEqual(node.cast, { color: 'deep.abyss', opacity: 0.35, length: 0.7, soft: 0 });
  assert.ok(!('dir' in node.cast!));
  // The light of a shot comes from above: the shadow lies under the foot, darker than the ground.
  const raw = await draw(make([node]));
  const ground = at(raw, 0, 110);
  const shadow = at(raw, 0, 70);
  assert.ok(shadow[0] < ground[0] - 4 && shadow[2] < ground[2] - 4, `the shadow ${shadow} on the ground ${ground}`);
  assert.deepEqual(at(raw, 0, -130), ground, 'none on the side of the light');
});

test('cast: a roof makes the shadow longer, and a wall casts along its line', async () => {
  // The ridge of a gable is 40 over the top: its end throws a point 40 units past the shadow of the eaves.
  const flat = await draw(make(casting(plain, body())));
  const gable = await draw(make(casting(plain, body({ roof: { kind: 'gable', height: 40 } }))));
  assert.ok(dark(at(flat, 190, 0)) && aqua(at(gable, 190, 0)), 'the shadow of the ridge');
  assert.ok(dark(at(gable, 190, 45)) && dark(at(gable, 205, 0)), 'and of the eaves beside it');

  // A stroke with a rise.
  const wall = await draw(make(casting(plain, [stroke({ id: 'w', points: [[-100, 0], [100, 0]], width: 10, color: 'light.snow', rise: 60 })])));
  assert.ok(aqua(at(wall, 130, 0)) && aqua(at(wall, 160, 0)) && dark(at(wall, 175, 0)));
});

test('cast: the shadows of a group are one picture: where two meet they are no darker; soft blurs it, and a fading body takes its shadow with it', async () => {
  // Two bodies whose shadows overlap, at half strength.
  const two: LayerSpec['nodes'] = [
    rect({ id: 'a', at: [-100, -20], w: 100, h: 100, radius: 0, fill: 'light.snow', lit: false, rise: 60 }),
    rect({ id: 'b', at: [-100, 30], w: 100, h: 100, radius: 0, fill: 'light.snow', lit: false, rise: 100 }),
  ];
  const raw = await draw(make(casting({ ...plain, opacity: 0.5 }, two)));
  const both = at(raw, -20, 10);
  assert.ok(!dark(both) && !aqua(both), `half a shadow: ${both}`);
  assert.deepEqual(at(raw, -20, -50), both, 'the shadow of one');
  assert.deepEqual(at(raw, 30, 50), both, 'the shadow of the other');
  assert.ok(dark(at(raw, 30, -50)));

  // soft: the edge is a ramp.
  const sharp = await draw(make(casting(plain, body())));
  const soft = await draw(make(casting({ ...plain, soft: 10 }, body())));
  assert.ok(aqua(at(sharp, 158, 20)) && dark(at(sharp, 164, 20)));
  const inside = at(soft, 158, 20);
  const outside = at(soft, 164, 20);
  assert.ok(!aqua(inside) && !dark(inside) && !dark(outside) && outside[1] < inside[1], `a ramp across the edge: ${inside}, ${outside}`);
  assert.ok(aqua(at(soft, 130, 20)) && dark(at(soft, 185, 20)));

  // A body that is half there casts half a shadow.
  const faded = at(await draw(make(casting(plain, body({ opacity: 0.5 })))), 130, 20);
  assert.ok(!aqua(faded) && !dark(faded) && faded[1] > 90 && faded[1] < 160, `half a shadow: ${faded}`);
});

test('cast: in a plane of a perspective layer the shadows lie on the plane, and stay where they fall as the camera goes round', async () => {
  const floor = (turn: number, cast?: Cast): ShotSpec =>
    make([group({ id: 'floor', at: [0, 0, 0], plane: 'floor', children: [group({ id: 'g', ...(cast ? { cast } : {}), children: body() })] })], [], { perspective: { tilt: 50, turn } });
  const front = await draw(floor(0, plain));
  assert.ok(aqua(at(front, 130, 20)) && dark(at(front, -130, 20)) && dark(at(front, 170, 20)));
  // Seen from the other side the same shadow is on the left.
  const back = await draw(floor(180, plain));
  assert.ok(aqua(at(back, -130, 20)) && dark(at(back, 130, 20)));
  assert.ok(dark(at(await draw(floor(0)), 130, 20)), 'no cast, no shadow');
});

test('cast: the motion review judges the end of a shadow, which travels farther than its body rises', async () => {
  const review = async (spec: ShotSpec): Promise<string[]> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c)).report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel}`);
  };
  const small = (extra: object = {}): LayerSpec['nodes'] => [rect({ id: 'b', w: 100, h: 60, radius: 0, fill: 'light.snow', lit: false, rise: 0, ...extra })];
  const long = { ...plain, length: 8 };
  // The planted defect: a body rises 20 units at one speed. The body is too slow to read as mechanical, but its
  // shadow is eight times as long as the body is high, and its end runs 160 units at one speed.
  assert.deepEqual(await review(make(casting(long, small()), [riseTo('b', { at: 1, to: 20, dur: 1, profile: 'steady' })])), ['mechanical b shadow']);
  // The sound scene: the same rise, eased.
  assert.deepEqual(await review(make(casting(long, small()), [riseTo('b', { at: 1, to: 20, dur: 1 })])), []);
  // Without a cast, or with a shadow no longer than the body is high, the same steady rise is too small to judge.
  assert.deepEqual(await review(make([group({ id: 'g', children: small() })], [riseTo('b', { at: 1, to: 20, dur: 1, profile: 'steady' })])), []);
  assert.deepEqual(await review(make(casting(plain, small()), [riseTo('b', { at: 1, to: 20, dur: 1, profile: 'steady' })])), []);
});

test('cast: what cannot be a cast is refused', () => {
  const g = (cast: object): unknown => group({ id: 'g', cast: cast as never, children: [] });
  assert.ok(refused(() => g({}), /cast needs a color: the colour of the shadows, a palette reference/), 'the engine has no colour of its own');
  assert.ok(refused(() => g({ color: 'deep.abyss', length: 9 }), /cast\.length must be a number in 0\.\.8/));
  assert.ok(refused(() => g({ color: 'deep.abyss', opacity: 2 }), /cast\.opacity must be a number in 0\.\.1/));
  assert.ok(refused(() => g({ color: 'deep.abyss', soft: -1 }), /cast\.soft must be a number in 0\.\./));
  assert.ok(refused(() => g({ color: 'deep.abyss', blur: 4 }), /unknown option "blur"/));
  assert.ok(refused(() => compileShot(make([group({ id: 'g', cast: { color: 'no.such' as never }, children: [] })])), /no\.such/), 'a colour the palette does not have');
});

test('cast: it is opt-in: a group without it is the data it was, and draws no item for shadows', async () => {
  const bare = group({ id: 'g', children: body() });
  assert.ok(!('cast' in bare));
  assert.deepEqual((await items(make([bare]))).map((i) => i.kind), ['shape']);
  assert.deepEqual({ ...group({ id: 'g', cast: plain, children: body() }), cast: undefined }, { ...bare, cast: undefined });
});
