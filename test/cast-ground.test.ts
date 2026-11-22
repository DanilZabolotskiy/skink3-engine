import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakeShot, compileShot, evaluate, group, rect, relief, reviewMotion, riseTo, stroke, type Key, type LayerSpec, type ShotSpec, type Vec2, type Vec3 } from '../src/index.ts';
import { computeWorld, newPlaces, posesFromBake, shadowDrop, type CastItem, type Item, type Places, type StrokeItem } from '../src/scene/evaluate.ts';
import type { GroundField } from '../src/scene/ground.ts';
import { SHADOW_REACH } from '../src/scene/types.ts';
import { make, refused } from './fixtures/bodies.ts';

// Shadows on a ground (cast.ground): in a plane with a ground, the shadow of each point of a body runs from where it
// stands until it meets the ground, and the outline of the shadows is laid on the ground point by point.

/** A perspective layer whose camera looks at the middle of the stage, 60 degrees over the ground. */
const SEEN = { perspective: { aim: [0, 0, 0] as Vec3, distance: 1600, tilt: 60 } };

/** A ramp 1600 across that rises 0.2 to the unit eastward: 200 high in the middle. Its curves keep a straight ramp straight. */
const SLOPE = 0.2;
const N = 17;
const RAMP = Array.from({ length: N * N }, (_, i) => 200 + SLOPE * ((i % N) / (N - 1) - 0.5) * 1600);
const ramp = (): ReturnType<typeof relief> => relief({ id: 'ground', w: 1600, h: 1600, heights: { cols: N, rows: N, values: RAMP }, dark: 'deep.abyss', bright: 'light.snow', tints: [[0, 'mid.jade'], [400, 'light.cream']] });

/** A round hill 200 high in the middle of a field 1600 across. */
const HILL = Array.from({ length: 33 * 33 }, (_, i) => {
  const [x, y] = [((i % 33) / 32 - 0.5) * 1600, (Math.floor(i / 33) / 32 - 0.5) * 1600];
  return Math.round(200 * Math.exp(-(x * x + y * y) / (2 * 260 * 260)) * 10) / 10;
});
const hill = (): ReturnType<typeof relief> => relief({ id: 'ground', w: 1600, h: 1600, heights: { cols: 33, rows: 33, values: HILL }, dark: 'deep.abyss', bright: 'light.snow', tints: [[0, 'mid.jade'], [200, 'light.cream']] });

type Cast = NonNullable<Parameters<typeof group>[0]['cast']>;
/** Whole, sharp shadows, as long as the bodies are high, to the east unless dir says otherwise. */
const plain = { color: 'accent.aqua', opacity: 1, dir: 0, length: 1 } as const;

/** A floor on a ground, and on it a group that casts. */
const scene = (ground: LayerSpec['nodes'][number], cast: Cast, children: LayerSpec['nodes'], timeline: Key[] = []): ShotSpec =>
  make([group({ id: 'floor', plane: 'floor', ground: 'ground', children: [ground, group({ id: 'g', cast, children })] })], timeline, SEEN);

/** A block 60 across in the middle, 40 high. */
const block = (extra: object = {}): ReturnType<typeof rect> => rect({ id: 'b', w: 60, h: 60, radius: 0, fill: 'light.snow', lit: false, rise: 40, ...extra });

interface Frame {
  /** The items of the floor, in its plane: groups opened. */
  readonly items: Item[];
  readonly stand: Vec3;
  readonly ground: GroundField;
  readonly places: Places;
}

/** A frame of a scene: what is drawn in the plane of the floor, where the camera stands over it, and its ground. */
async function frameOf(spec: ShotSpec, frame = 0): Promise<Frame> {
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const items: Item[] = [];
  const open = (list: readonly Item[]): void => {
    for (const i of list) {
      if (i.kind === 'group' || i.kind === 'clip' || i.kind === 'stretch' || i.kind === 'plane') open(i.items);
      else items.push(i);
    }
  };
  open(evaluate(c, bake, frame, 'en').layers[0]!.items);
  const places = newPlaces(c);
  computeWorld(c, frame, posesFromBake(bake), places);
  const plane = c.nodes.find((n) => n.id === 'floor')!.index;
  return { items, stand: places.stands.get(plane)!, ground: places.grounds.get(plane)!, places };
}

/** The outlines of the shadows of a frame, as drawn in the plane. */
function shadowOutlines(f: Frame): ArrayLike<number>[] {
  const out: ArrayLike<number>[] = [];
  for (const i of f.items) if (i.kind === 'cast') for (const s of (i as CastItem).shadows) out.push(...s.outlines);
  return out;
}

/** How far a point is from the nearest edge of the outlines. */
function distanceTo(outlines: readonly ArrayLike<number>[], x: number, y: number): number {
  let best = Infinity;
  for (const o of outlines) {
    const m = o.length / 2;
    for (let k = 0; k < m; k++) {
      const e = (k + 1) % m;
      const [ax, ay, bx, by] = [o[2 * k]!, o[2 * k + 1]!, o[2 * e]!, o[2 * e + 1]!];
      const len = (bx - ax) ** 2 + (by - ay) ** 2;
      const u = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len)) : 0;
      best = Math.min(best, Math.hypot(ax + (bx - ax) * u - x, ay + (by - ay) * u - y));
    }
  }
  return best;
}

/** The points of the outlines of the shadows of a frame, as drawn in the plane. */
function shadowPoints(f: Frame): Vec2[] {
  const out: Vec2[] = [];
  for (const i of f.items) {
    if (i.kind !== 'cast') continue;
    for (const s of (i as CastItem).shadows) for (const o of s.outlines) for (let k = 0; k < o.length; k += 2) out.push([o[k]!, o[k + 1]!]);
  }
  return out;
}

/** The true place in the plane of a point drawn on the ground: undoes the camera's view of the height of the ground there. */
function underground(f: Frame, p: Vec2): Vec2 {
  const [sx, sy, eye] = f.stand;
  let q: Vec2 = p;
  for (let k = 0; k < 40; k++) {
    const back = (eye - f.ground.at(q[0], q[1])) / eye;
    q = [sx + (p[0] - sx) * back, sy + (p[1] - sy) * back];
  }
  return q;
}

/** A ground of one height, or of a straight ramp, for shadowDrop. */
const field = (at: (x: number, y: number) => number): GroundField => ({ index: 0, at, low: -1e9, high: 1e9, cell: 10 });

test('cast.ground: the shadow of a point runs until it meets the ground: as far as it is high on level ground, less uphill, more downhill', () => {
  const level = field(() => 50);
  assert.ok(Math.abs(shadowDrop(level, 0, 0, 50, 40, [1, 0]) - 40) < 1e-9, 'level: as long as it is high');
  assert.ok(Math.abs(shadowDrop(level, 0, 0, 50, 40, [2, 0]) - 40) < 1e-9, 'it falls 40, whatever the length of the cast');
  // A ramp up 0.25 to the unit eastward: the shadow meets it after 40 / 1.25 eastward, after 40 / 0.75 westward.
  const up = field((x) => 0.25 * x);
  assert.ok(Math.abs(shadowDrop(up, 0, 0, 0, 40, [1, 0]) - 32) < 1e-6);
  assert.ok(Math.abs(shadowDrop(up, 0, 0, 0, 40, [-1, 0]) - 160 / 3) < 1e-6);
  assert.ok(Math.abs(shadowDrop(up, 0, 0, 0, 40, [0, 1]) - 40) < 1e-9, 'across the ramp: as on level ground');
  // A slope steeper than the light: at most SHADOW_REACH times as far as on level ground.
  assert.equal(shadowDrop(field((x) => -0.8 * x), 0, 0, 0, 40, [1, 0]), SHADOW_REACH * 40);
  // A point under the ground, and a point with no height, land where they are.
  assert.equal(shadowDrop(level, 0, 0, 20, 10, [1, 0]), 0);
  assert.equal(shadowDrop(level, 0, 0, 50, 0, [1, 0]), 0);
});

test('cast.ground: on a ramp a body\'s shadow lies on the ground, shorter where it climbs, longer where it runs down', async () => {
  // The east edge of the block's shadow (dir 0, up the ramp) and its west edge (dir 180, down it), at their true places.
  const reach = async (dir: number): Promise<{ far: number; high: number }> => {
    const f = await frameOf(scene(ramp(), { ...plain, dir, ground: true }, [block()]));
    let far = -Infinity;
    for (const p of shadowPoints(f)) far = Math.max(far, (dir === 0 ? 1 : -1) * underground(f, p)[0]);
    // The block is drawn as high as its 40 units are at the height of the ground under it.
    const eye = f.stand[2];
    return { far: far - 30, high: (40 * eye) / (eye - f.ground.at(0, 0)) };
  };
  // Its edge 30 from its middle stands 6 higher or lower than its foot; its top's shadow meets the ramp there.
  const east = await reach(0);
  assert.ok(Math.abs(east.far - (east.high - SLOPE * 30) / (1 + SLOPE)) < 0.5, `up the ramp: ${east.far}`);
  const west = await reach(180);
  assert.ok(Math.abs(west.far - (west.high + SLOPE * 30) / (1 - SLOPE)) < 0.5, `down the ramp: ${west.far}`);
  // Every point of the shadow is drawn on the ground: the place it is drawn at is that of its true place at the height of the ground there.
  const f = await frameOf(scene(ramp(), { ...plain, ground: true }, [block()]));
  for (const p of shadowPoints(f)) {
    const q = underground(f, p);
    const lift = f.stand[2] / (f.stand[2] - f.ground.at(q[0], q[1]));
    assert.ok(Math.hypot(f.stand[0] + (q[0] - f.stand[0]) * lift - p[0], f.stand[1] + (q[1] - f.stand[1]) * lift - p[1]) < 1e-6);
  }
});

test('cast.ground: the shadow of a raised line starts at its foot all along it; without it, it lies at one height, off the foot on a hill', async () => {
  const wall = stroke({ id: 'wall', points: [[-600, -250], [0, 0], [600, 250]], smooth: 0, color: 'light.snow', side: 'accent.coral', width: 12, rise: 30 });
  // How far the farthest point of the wall's foot is from the nearest point of its shadow.
  const gap = async (ground: boolean): Promise<number> => {
    const f = await frameOf(scene(hill(), { ...plain, dir: 90, ...(ground ? { ground: true } : {}) }, [wall]));
    const shadow = shadowOutlines(f);
    const item = f.items.find((i) => i.kind === 'stroke' && i.node.id === 'wall') as StrokeItem;
    const { xf, foot } = item;
    const cos = Math.cos(xf.rot) * xf.scale;
    const sin = Math.sin(xf.rot) * xf.scale;
    let worst = 0;
    for (const p of item.path!.points) {
      const fx = foot!.k * p[0] + foot!.x;
      const fy = foot!.k * p[1] + foot!.y;
      const [x, y] = [xf.x + fx * cos - fy * sin, xf.y + fx * sin + fy * cos];
      worst = Math.max(worst, distanceTo(shadow, x, y));
    }
    return worst;
  };
  const on = await gap(true);
  assert.ok(on < 1, `on the ground the shadow starts at the foot: ${on}`);
  const off = await gap(false);
  assert.ok(off > 60, `level at one height, it is far from the foot where the hill lifts the wall: ${off}`);
});

test('cast.ground: what cannot be a ground for the shadows is refused', () => {
  const g = (cast: object): unknown => group({ id: 'g', cast: cast as never, children: [] });
  assert.ok(refused(() => g({ color: 'deep.abyss', ground: 'yes' }), /cast\.ground must be true or false/));
  assert.ok(refused(() => g({ color: 'deep.abyss', ground: 1 }), /cast\.ground must be true or false/));
  // In a flat layer, and in a plane without a ground.
  assert.ok(refused(() => compileShot(make([group({ id: 'g', cast: { ...plain, ground: true }, children: [block()] })])), /group "g" lays its shadows on the ground \(cast\.ground\), and it lies in no plane with a ground/));
  assert.ok(refused(() => compileShot(make([group({ id: 'floor', plane: 'floor', children: [group({ id: 'g', cast: { ...plain, ground: true }, children: [block()] })] })], [], SEEN)), /lies in no plane with a ground/));
  // The plane group itself may cast on its ground.
  assert.doesNotThrow(() => compileShot(make([group({ id: 'floor', plane: 'floor', ground: 'ground', cast: { ...plain, over: 'flat', ground: true }, children: [hill(), block()] })], [], SEEN)));
});

test('cast.ground: it is opt-in: a cast without it is the data it was, and on level ground it lies where the level shadow lies', async () => {
  assert.ok(!('ground' in group({ id: 'g', cast: plain, children: [] }).cast!));
  assert.deepEqual(group({ id: 'g', cast: { ...plain, ground: false }, children: [] }), group({ id: 'g', cast: plain, children: [] }), 'false is written as nothing');
  assert.equal(group({ id: 'g', cast: { ...plain, ground: true }, children: [] }).cast!.ground, true);
  // On a ground of one height the shadow on the ground is the level shadow, its outline cut into pieces a cell long.
  const flat = relief({ id: 'ground', w: 1600, h: 1600, heights: { cols: 33, rows: 33, values: Array(33 * 33).fill(0) }, dark: 'deep.abyss', bright: 'light.snow' });
  const level = shadowPoints(await frameOf(scene(flat, plain, [block({ at: [200, 100] })])));
  const laid = shadowPoints(await frameOf(scene(flat, { ...plain, ground: true }, [block({ at: [200, 100] })])));
  assert.ok(laid.length > level.length);
  for (const p of level) assert.ok(laid.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6), `a corner of the level shadow (${p}) is a corner of the one on the ground`);
  const [x0, x1] = [Math.min(...level.map((p) => p[0])), Math.max(...level.map((p) => p[0]))];
  const [y0, y1] = [Math.min(...level.map((p) => p[1])), Math.max(...level.map((p) => p[1]))];
  assert.ok(laid.every((p) => p[0] > x0 - 1e-6 && p[0] < x1 + 1e-6 && p[1] > y0 - 1e-6 && p[1] < y1 + 1e-6), 'and nothing of it lies outside');
});

test('cast.ground: the motion review judges the end of the shadow as the ground makes it, down a slope farther than on level ground', async () => {
  const review = async (spec: ShotSpec): Promise<string[]> => {
    const c = compileShot(spec);
    return reviewMotion(c, await bakeShot(c)).report.findings.map((f) => `${f.kind} ${f.subject} ${f.channel}`);
  };
  const rising = (cast: Cast, profile?: 'steady'): ShotSpec => scene(ramp(), { ...cast, length: 1.5 }, [block({ rise: 0 })], [riseTo('b', { at: 1, to: 14, dur: 0.75, ...(profile ? { profile } : {}) })]);
  // The planted defect: a block rises 14 at one speed. Its shadow, 21 long on level ground, is too short to judge;
  // down the ramp it is 30 long, and its end runs at one speed.
  assert.deepEqual(await review(rising({ ...plain, dir: 180, ground: true }, 'steady')), ['mechanical b shadow']);
  // The sound scene: the same rise, eased.
  assert.deepEqual(await review(rising({ ...plain, dir: 180, ground: true })), []);
  // Up the ramp the shadow is shorter, and without cast.ground it lies level: the same steady rise is too small to judge.
  assert.deepEqual(await review(rising({ ...plain, dir: 0, ground: true }, 'steady')), []);
  assert.deepEqual(await review(rising({ ...plain, dir: 180 }, 'steady')), []);
});
