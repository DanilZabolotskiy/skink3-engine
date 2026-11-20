import assert from 'node:assert/strict';
import { test } from 'node:test';
import { circle, group, rect, riseTo, stroke, type LayerSpec, type StrokeItem } from '../src/index.ts';
import { aqua, at, dark, differing, draw, items, make, pale, red, refused, type Rgb } from './fixtures/bodies.ts';

// Openings: rows of windows, arches or the gaps of a colonnade, painted on the side of a body with a height.

/** A body of 200 by 100 units in the middle of the stage, 60 high: its front face runs from x -100 to 100 and from y -10 down to its foot at 50. */
const body = (extra: object = {}): LayerSpec['nodes'] => [rect({ id: 'b', w: 200, h: 100, radius: 0, fill: 'light.snow', lit: false, side: 'accent.coral', rise: 60, ...extra })];

/** The colour openings have when they are given none: a deep shadow tone of the red side. */
const deep = (p: Rgb): boolean => p[0] > 50 && p[0] < 130 && p[1] < 40;

test('openings: a row is painted on the side the viewer sees, a step apart, each in the middle of the height', async () => {
  const raw = await draw(make(body({ openings: { width: 20, height: 30, step: 40 } })));
  // Five fit the face, with the same plain wall at both corners.
  for (const x of [-80, -40, 0, 40, 80]) assert.ok(deep(at(raw, x, 20)), `an opening at ${x}: ${at(raw, x, 20)}`);
  for (const x of [-98, -60, -20, 20, 60, 98]) assert.ok(red(at(raw, x, 20)), `plain wall at ${x}: ${at(raw, x, 20)}`);
  // 30 of the 60 units of the height, in the middle of them.
  assert.ok(red(at(raw, 0, 0)) && deep(at(raw, 0, 9)) && deep(at(raw, 0, 31)) && red(at(raw, 0, 40)));
  assert.ok(pale(at(raw, 0, -60)), 'the top is what it was');

  // A colour of their own.
  const lit = await draw(make(body({ openings: { width: 20, height: 30, step: 40, color: 'accent.aqua' } })));
  assert.ok(aqua(at(lit, 40, 20)) && red(at(lit, 20, 20)));

  // inset: the least plain wall at a corner. With 50 units of it only three fit.
  const inset = await draw(make(body({ openings: { width: 20, height: 30, step: 40, inset: 50, color: 'accent.aqua' } })));
  assert.ok(red(at(inset, -80, 20)) && aqua(at(inset, -40, 20)) && aqua(at(inset, 0, 20)) && aqua(at(inset, 40, 20)) && red(at(inset, 80, 20)));
});

test('openings: rows share the height, sill sets an opening over the foot of its row, and an arch has a round head', async () => {
  const rows = await draw(make(body({ openings: { width: 20, height: 16, step: 40, rows: 2, color: 'accent.aqua' } })));
  assert.ok(aqua(at(rows, 0, 5)) && red(at(rows, 0, 20)) && aqua(at(rows, 0, 35)), 'two rows, each in its half of the height');

  const sill = await draw(make(body({ openings: { width: 20, height: 30, step: 40, sill: 0, color: 'accent.aqua' } })));
  assert.ok(red(at(sill, 0, 10)) && aqua(at(sill, 0, 25)) && aqua(at(sill, 0, 46)), 'with a sill of 0 an opening stands on the foot: a door, an arcade');

  const arch = await draw(make(body({ openings: { shape: 'arch', width: 20, height: 30, step: 40, color: 'accent.aqua' } })));
  const square = await draw(make(body({ openings: { shape: 'rect', width: 20, height: 30, step: 40, color: 'accent.aqua' } })));
  assert.ok(aqua(at(square, 8, 7)) && red(at(arch, 8, 7)), 'the corner of the head is cut off round');
  assert.ok(aqua(at(arch, 0, 7)) && aqua(at(arch, 8, 20)) && aqua(at(arch, -8, 30)), 'the head and the foot of an arch');
});

test('openings: they keep their place on the wall as the body rises, and the wall uncovers them', async () => {
  const openings = { width: 20, height: 30, step: 40, color: 'accent.aqua' } as const;
  const spec = make(body({ rise: 0, openings }), [riseTo('b', { at: 0, to: 60, dur: 2 })]);
  // Half-way up the body is 30 high: the top edge is at y 20, and the opening shows from there down to its own foot at 35.
  const half = await draw(spec, 60);
  assert.ok(pale(at(half, 0, 16)) && aqua(at(half, 0, 24)) && aqua(at(half, 0, 31)) && red(at(half, 0, 40)));
  assert.deepEqual(await draw(spec, 130), await draw(make(body({ openings }))));
});

test('openings: a round body carries them all the way round, and in a plane they are seen as the camera sees the wall', async () => {
  const round = await draw(make([circle({ id: 'b', r: 80, fill: 'light.snow', lit: false, side: 'accent.coral', rise: 60, openings: { width: 16, height: 30, step: 32, color: 'accent.aqua' } })]));
  assert.ok(aqua(at(round, -40, 50)) && red(at(round, -30, 50)) && aqua(at(round, -10, 50)) && red(at(round, 0, 50)) && aqua(at(round, 10, 50)));

  const floor = make([group({ id: 'floor', at: [0, 0, 0], plane: 'floor', children: body({ openings: { width: 20, height: 30, step: 40, color: 'accent.aqua' } }) })], [], { perspective: { tilt: 50 } });
  const seen = await draw(floor);
  for (const x of [-84, -42, 0, 42, 84]) assert.ok(aqua(at(seen, x, 20)), `an opening at ${x}`);
  for (const x of [-62, -21, 21, 62]) assert.ok(red(at(seen, x, 20)), `plain wall at ${x}`);
  assert.ok(red(at(seen, 0, 2)) && red(at(seen, 0, 33)), 'the wall over and under the row');
});

/** A wall 60 high and 10 wide along y 0, from x -100 to 100: its near face runs from y 5 up to y -55. */
const wall = (extra: object = {}): LayerSpec['nodes'] => [stroke({ id: 'w', points: [[-100, 0], [100, 0]], smooth: 0, width: 10, color: 'light.snow', side: 'accent.coral', rise: 60, ...extra })];
/** A closed wall round a square of 200: its near stretch at y 100, its far one at y -100. */
const pen = (extra: object = {}): LayerSpec['nodes'] => [stroke({ id: 'w', points: [[-100, -100], [100, -100], [100, 100], [-100, 100]], closed: true, smooth: 0, width: 10, color: 'light.snow', side: 'accent.coral', rise: 60, ...extra })];
const windows = { width: 20, height: 30, step: 40, color: 'accent.aqua' } as const;

test('openings: a wall carries them along its line, on whichever of its faces the viewer sees, as far as it is drawn', async () => {
  const raw = await draw(make(wall({ openings: windows })));
  for (const x of [-80, -40, 0, 40, 80]) assert.ok(aqua(at(raw, x, -25)), `an opening at ${x}: ${at(raw, x, -25)}`);
  for (const x of [-60, -20, 20, 60]) assert.ok(red(at(raw, x, -25)), `plain wall at ${x}`);
  assert.ok(red(at(raw, 0, -45)) && aqua(at(raw, 0, -38)) && aqua(at(raw, 0, -12)) && red(at(raw, 0, -5)), '30 of the 60 units, in the middle of them');
  // Drawn half-way, the wall shows the openings of its half.
  const half = await draw(make(wall({ openings: windows, drawn: 0.5 })));
  assert.ok(aqua(at(half, -80, -25)) && aqua(at(half, -40, -25)) && dark(at(half, 40, -25)) && dark(at(half, 80, -25)));
  // Round a square: the outer face of the near stretch and the inner face of the far one.
  const round = await draw(make(pen({ openings: windows })));
  assert.ok(aqua(at(round, 0, 75)) && red(at(round, 20, 75)), 'the near stretch, outside');
  assert.ok(aqua(at(round, 0, -125)) && red(at(round, 20, -125)), 'the far stretch, inside');
});

test('openings: among children drawn far to near a wall is cut between its openings, never through one', async () => {
  const sorted = (nodes: LayerSpec['nodes']): LayerSpec['nodes'] => [group({ id: 'g', sort: 'depth', children: nodes })];
  const line = await draw(make(wall({ openings: windows })));
  const cut = await draw(make(sorted(wall({ openings: windows }))));
  assert.ok(differing(line, cut, 24) < 150, `${differing(line, cut, 24)} pixels differ`);
  for (const x of [-80, -40, 0, 40, 80]) assert.ok(aqua(at(cut, x, -25)), `an opening at ${x}`);
  // The openings of the square lie 20 + 40 k along its line, and each with the wall round it is 30 wide: no cut
  // between two stretches lies within 15 of the middle of one.
  const parts = (await items(make(sorted(pen({ openings: windows }))))).filter((i): i is StrokeItem => i.kind === 'stroke').map((i) => i.part!);
  assert.ok(parts.length > 4);
  for (const end of parts.flat()) {
    const off = Math.abs((((end - 20) % 40) + 40) % 40);
    assert.ok(Math.min(off, 40 - off) >= 15 - 1e-6, `a cut at ${end}`);
  }
});

test('openings: what cannot be painted is refused', () => {
  const where = { id: 'b', w: 200, h: 100, fill: 'light.snow' } as const;
  const o = { width: 20, height: 30 } as const;
  assert.ok(refused(() => rect({ ...where, openings: o }), /openings are painted on the side of a shape with a height: give rise/));
  assert.ok(refused(() => rect({ ...where, rise: 60, openings: { ...o, shape: 'round' as 'rect' } }), /openings\.shape must be one of rect, arch/));
  assert.ok(refused(() => rect({ ...where, rise: 60, openings: { ...o, step: 10 } }), /they would lie over each other; give a step of 20 at least/));
  assert.ok(refused(() => rect({ ...where, rise: 60, openings: { ...o, rows: 1.5 } }), /openings\.rows must be a whole number/));
  assert.ok(refused(() => rect({ ...where, rise: 60, openings: { ...o, width: 0 } }), /openings\.width must be a number in 0\.01\.\./));
  assert.ok(refused(() => rect({ ...where, rise: 60, openings: { ...o, gap: 4 } as never }), /unknown option "gap"/));
  // A wall: a stroke with a rise.
  assert.ok(refused(() => stroke({ id: 'w', points: [[0, 0], [100, 0]], color: 'light.snow', openings: o }), /openings are painted on the side of a stroke with a height: give rise/));
  assert.ok(refused(() => stroke({ id: 'w', points: [[0, 0], [100, 0]], color: 'light.snow', rise: 40, openings: { ...o, step: 10 } }), /they would lie over each other/));
});

test('openings: they are opt-in: a body without them is the data it was', () => {
  const plain = rect({ id: 'b', w: 200, h: 100, fill: 'light.snow', rise: 60 });
  assert.ok(!('openings' in plain));
  const windowed = rect({ id: 'b', w: 200, h: 100, fill: 'light.snow', rise: 60, openings: { width: 20, height: 30 } });
  // What is left out is written as what it stands for: openings two widths apart, one row, half a gap at a corner.
  assert.deepEqual(windowed.openings, { shape: 'rect', width: 20, height: 30, step: 40, rows: 1, inset: 10 });
  assert.deepEqual({ ...windowed, openings: undefined }, { ...plain, openings: undefined });
  // A wall as well.
  const bare = stroke({ id: 'w', points: [[0, 0], [100, 0]], color: 'light.snow', rise: 40 });
  assert.ok(!('openings' in bare));
  assert.deepEqual({ ...stroke({ id: 'w', points: [[0, 0], [100, 0]], color: 'light.snow', rise: 40, openings: { width: 20, height: 30 } }), openings: undefined }, { ...bare, openings: undefined });
});
