import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, compileShot, fabric, frameRaw, layer, resolveColor, shot, type FabricOptions, type SceneNode, type Vec2 } from '../src/index.ts';

// The fabric of a city: its blocks as flat fills of many outlines each, with optional squares, main streets, sites
// kept clear, a shadow and a lit rim, parts that fade as one, and a level of detail. A dressing like the others: it
// makes plain nodes and changes nothing else.

const WIDTH = 480;
const K = WIDTH / 1920;

/** A block: a square of side `s` round (x, y), turned a little, its points clockwise or the other way. */
const block = (x: number, y: number, s: number, flip = false): Vec2[] => {
  const ring: Vec2[] = [[x - s / 2, y - s / 2], [x + s / 2, y - s / 2 + s * 0.1], [x + s / 2, y + s / 2], [x - s / 2 + s * 0.1, y + s / 2]];
  return flip ? ring.reverse() : ring;
};
/** A grid of blocks with lanes of 10 units between them, the odd ones wound the other way. */
const blocks = (n: number, s = 40): Vec2[][] =>
  Array.from({ length: n * n }, (_, i) => block(-((n - 1) * (s + 10)) / 2 + (i % n) * (s + 10), -((n - 1) * (s + 10)) / 2 + Math.floor(i / n) * (s + 10), s, i % 2 === 1));

type Tree = { id: string; type: string; children?: Tree[]; shape?: { rings?: Vec2[][] }; at?: Vec2; least?: number; fill?: string };
const all = (n: SceneNode): Tree[] => { const t = n as unknown as Tree; return [t, ...(t.children ?? []).flatMap((c) => all(c as unknown as SceneNode))]; };
const area = (r: readonly Vec2[]): number => r.reduce((a, p, i) => a + (r[(i + r.length - 1) % r.length]![0] * p[1] - p[0] * r[(i + r.length - 1) % r.length]![1]), 0) / 2;

test('fabric: what it refuses', () => {
  const ok: FabricOptions = { id: 'city', blocks: blocks(2), fills: ['accent.coral'] };
  assert.throws(() => fabric({ ...ok, blocks: [] }), /blocks must be a list of at least one outline/);
  assert.throws(() => fabric({ ...ok, blocks: [[[0, 0], [1, 0]]] }), /blocks\[0\] must be a list of at least three points/);
  assert.throws(() => fabric({ ...ok, fills: [] }), /fills must be a palette reference or a list of them/);
  assert.throws(() => fabric({ ...ok, squares: [block(0, 0, 50)] }), /squares are drawn in square: give its colour/);
  assert.throws(() => fabric({ ...ok, streets: [{ line: [[0, 0], [100, 0]], width: 8 }] }), /streets are drawn in street: give its colour/);
  assert.throws(() => fabric({ ...ok, least: 2 }), /least is the least width of the main streets on screen: give streets/);
  assert.throws(() => fabric({ ...ok, lift: 3 }), /lift and dir place the shadow and the rim: give shadow or rim/);
  assert.throws(() => fabric({ ...ok, part: () => 'a b' }), /part must give a whole number or a name of letters, digits, - and _/);
  assert.throws(() => fabric({ ...ok, detail: { scale: 0.01, least: 4 } }), /no block is left: every block is smaller than 4 px across at scale 0\.01/);
  assert.throws(() => fabric({ ...ok, roofs: ['accent.coral'] } as never), /unknown option "roofs"/);
});

test('fabric: the blocks as flat fills, one way round, a tone each from the seed; parts, squares, streets, clear', () => {
  const made = fabric({
    id: 'city', blocks: blocks(4), fills: ['accent.coral', 'accent.amber'], seed: 3,
    squares: [block(0, 300, 60)], square: 'light.cream', streets: [{ line: [[-200, 0], [200, 0]], width: 8 }], street: 'light.snow', least: 2,
    clear: [block(-25, -25, 30)], shadow: 'deep.abyss', rim: 'light.snow', lift: 2, dir: 0,
    part: ([x]) => (x < 0 ? 'west' : 'east'),
  });
  assert.deepEqual(made.parts, ['city-west', 'city-east']);
  const nodes = all(made.node);
  assert.ok(nodes.every((n) => n.type === 'group' || n.type === 'shape' || n.type === 'stroke'));
  // Every block once among the tones of its part, the one in clear left out; all of one winding.
  const tones = nodes.filter((n) => /^city-(west|east)-\d+$/.test(n.id));
  const kept = tones.flatMap((n) => n.shape!.rings!);
  assert.equal(kept.length, 16 - 1);
  assert.ok(kept.every((r) => area(r) > 0));
  // The shadow and the rim: the same outlines, shifted each way.
  const shadow = nodes.find((n) => n.id === 'city-west-shadow')!;
  const rim = nodes.find((n) => n.id === 'city-west-rim')!;
  assert.deepEqual(shadow.at, [2, 0]);
  assert.deepEqual(rim.at, [-2, 0]);
  assert.equal(shadow.shape!.rings!.length + nodes.find((n) => n.id === 'city-east-shadow')!.shape!.rings!.length, 15);
  // A square over the blocks of its part (a square closed round by a block shows), fading with it; main streets over all, held on screen.
  const squareAt = nodes.findIndex((n) => n.id === 'city-east-square');
  assert.ok(squareAt > nodes.findIndex((n) => n.id === 'city-east-1') && squareAt > nodes.findIndex((n) => n.id === 'city-east-0'));
  assert.equal(nodes.findIndex((n) => n.id === 'city-streets') > squareAt, true);
  assert.equal(nodes.find((n) => n.id === 'city-street0')!.least, 2);
  // The same seed, the same tones; another seed, others.
  const tonesOf = (seed: number): string => JSON.stringify(all(fabric({ id: 'city', blocks: blocks(4), fills: ['accent.coral', 'accent.amber'], seed }).node).filter((n) => /^city-all-\d$/.test(n.id)).map((n) => n.shape!.rings!.length));
  assert.equal(tonesOf(3), tonesOf(3));
  assert.notEqual(tonesOf(3), tonesOf(4));
});

test('fabric: many blocks are a few fills, each within the points one fill takes', () => {
  const made = fabric({ id: 'city', blocks: blocks(40, 12), fills: 'accent.coral' });
  const fills = all(made.node).filter((n) => n.type === 'shape');
  assert.equal(fills.length, 2, '1600 blocks of 4 points: two fills of at most 4000 points');
  assert.equal(fills.reduce((s, n) => s + n.shape!.rings!.length, 0), 1600);
});

test('fabric: its level of detail leaves out what is too small to see and draws outlines to a third of a pixel', () => {
  // A block with many points along a straight side keeps its corners; one of 4 units at a scale of 0.25 is 1 px: left out.
  const side = Array.from({ length: 20 }, (_, i): Vec2 => [-100 + i * 10, -50 + (i % 2) * 0.01]);
  const busy: Vec2[] = [...side, [100, -50], [100, 50], [-100, 50]];
  const made = fabric({ id: 'city', blocks: [busy, block(300, 0, 4)], fills: 'accent.coral', detail: { scale: 0.25, least: 2 } });
  const rings = all(made.node).filter((n) => n.type === 'shape').flatMap((n) => n.shape!.rings!);
  assert.equal(rings.length, 1);
  assert.equal(rings[0]!.length, 4);
});

test('fabric: it draws its blocks and leaves its lanes open', async () => {
  const made = fabric({ id: 'city', blocks: blocks(6, 120), fills: 'accent.coral', squares: [block(800, 0, 200)], square: 'light.cream' });
  const spec = shot({
    id: 'tiny', seconds: 1, seed: 1, palette, strings: { en: {} }, background: { inner: 'deep.night', outer: 'deep.night' }, atmosphere: 'mid.mist', vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'map', depth: 0, nodes: [made.node] })],
  });
  const c = compileShot(spec);
  const r = await frameRaw(c, await bakeShot(c), 0, { width: WIDTH, lang: 'en', gpu: false });
  const at = (x: number, y: number): string => {
    const o = (Math.round((540 + y) * K) * WIDTH + Math.round((960 + x) * K)) * 4;
    return `#${[r[o]!, r[o + 1]!, r[o + 2]!].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  };
  const coral = resolveColor(palette, 'accent.coral').toUpperCase();
  assert.equal(at(-25 - 130 * 2, -25 - 130 * 2), coral, 'a block');
  assert.notEqual(at(-325 + 65, 0), coral, 'a lane between two blocks');
  assert.equal(at(800, 0), resolveColor(palette, 'light.cream').toUpperCase(), 'a square');
});
