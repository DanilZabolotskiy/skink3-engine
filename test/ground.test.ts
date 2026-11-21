import assert from 'node:assert/strict';
import { test } from 'node:test';
import { circle, compileShot, group, rect, region, relief, reliefHeight, stroke, travel, type LayerSpec, type ShapeItem, type StrokeItem, type Vec2, type Vec3 } from '../src/index.ts';
import { at, differing, draw, items, make, refused, type Rgb } from './fixtures/bodies.ts';

// The ground of a plane: a relief that a group in a plane names as its ground is drawn raised, and what the group
// lists after it stands on it; a relief that fades toward its edges; a plane that fades out with distance.

/** A perspective layer whose camera looks at the middle of the stage, `tilt` degrees over the ground. */
const seen = (tilt: number, distance = 1600): object => ({ perspective: { aim: [0, 0, 0] as Vec3, distance, tilt } });

/** A round hill in the middle of a field 1600 across: 200 high at its top, its heights a grid of 33 x 33. */
const N = 33;
const HILL = Array.from({ length: N * N }, (_, i) => {
  const [x, y] = [((i % N) / (N - 1) - 0.5) * 1600, (Math.floor(i / N) / (N - 1) - 0.5) * 1600];
  return Math.round(200 * Math.exp(-(x * x + y * y) / (2 * 260 * 260)) * 10) / 10;
});
const hill = (extra: object = {}): ReturnType<typeof relief> =>
  relief({ id: 'hill', w: 1600, h: 1600, heights: { cols: N, rows: N, values: HILL }, dark: 'deep.abyss', bright: 'light.snow', tints: [[0, 'mid.jade'], [200, 'light.cream']], ...extra });

/** A floor through the middle of the space, standing its things on the hill or not. */
const floor = (children: LayerSpec['nodes'], grounded: boolean, extra: object = {}): ReturnType<typeof group> =>
  group({ id: 'floor', plane: 'floor', children, ...(grounded ? { ground: 'hill' } : {}), ...extra });

const dot = (id: string, p: Vec2): ReturnType<typeof circle> => circle({ id, at: p, r: 12, fill: 'accent.coral', lit: false });

test('ground: the height of a relief at a place, read along the curves it is drawn with', () => {
  const height = reliefHeight(hill({ vertical: 1.5 }));
  assert.ok(Math.abs(height([0, 0]) - 300) < 1e-6, `at its top ${height([0, 0])}`);
  assert.ok(height([300, 0]) > 30 && height([300, 0]) < 200);
  assert.ok(Math.abs(height([300, 0]) - height([0, 300])) < 1e-6, 'a round hill is round');
  assert.equal(height([5000, 0]), height([800, 0]), 'past its edge, that of the edge');
  // Placed, turned and scaled as the node is.
  const moved = reliefHeight(hill({ at: [400, 0], scale: 2 }));
  assert.ok(Math.abs(moved([400, 0]) - 400) < 1e-6);
  assert.ok(refused(() => reliefHeight(rect({ id: 'r', w: 10, h: 10, fill: 'mid.ocean', lit: false })), /made by relief/));
});

test('ground: what is listed after the relief stands on it; what is listed before lies flat; without ground all lies flat', async () => {
  const nodes = (grounded: boolean): LayerSpec['nodes'] => [floor([dot('before', [0, 0]), hill(), dot('top', [0, 0]), dot('foot', [700, 0])], grounded)];
  const shapes = async (grounded: boolean): Promise<Map<string, ShapeItem>> => new Map((await items(make(nodes(grounded), [], seen(40)))).map((i) => [i.node.id, i as ShapeItem]));
  const flat = await shapes(false);
  const raised = await shapes(true);
  assert.equal(flat.get('hill')!.raise, undefined, 'a relief that is no ground is drawn flat');
  assert.ok(raised.get('hill')!.raise, 'the ground is drawn raised');
  assert.deepEqual(raised.get('before')!.xf, flat.get('before')!.xf, 'listed before the ground: flat');
  // On the hill's top, 200 over the plane: drawn higher on the screen and larger, as the top of a body that high is.
  const [up, down] = [raised.get('top')!.xf, flat.get('top')!.xf];
  assert.ok(up.y < down.y - 100 && up.scale > down.scale, `${up.y}, ${up.scale} against ${down.y}, ${down.scale}`);
  // At its foot, where the ground is all but flat (5 high): close to where it was.
  const [a, b] = [raised.get('foot')!.xf, flat.get('foot')!.xf];
  assert.ok(Math.abs(a.x - b.x) < 6 && Math.abs(a.y - b.y) < 6, `${a.x}, ${a.y} against ${b.x}, ${b.y}`);
  // A shot without a ground compiles as it always did.
  assert.equal(compileShot(make(nodes(false), [], seen(40))).grounds, null);
});

test('ground: a region and a stroke follow it point by point; a travel rides over it; a body stands on it', async () => {
  const line: Vec2[] = [[-700, 0], [700, 0]];
  const pond: Vec2[] = [[-100, -60], [100, -60], [100, 60], [-100, 60]];
  const shed = rect({ id: 'shed', at: [0, 0], w: 40, h: 30, fill: 'mid.rose', side: 'dark.plum', lit: false, rise: 30 });
  const list = (grounded: boolean): LayerSpec['nodes'] => [
    floor([hill(), stroke({ id: 'road', points: line, smooth: 0, color: 'dark.plum', width: 10 }), region({ id: 'pond', points: pond, smooth: 0, fill: 'mid.ocean', lit: false }), group({ id: 'town', sort: 'depth', children: [shed] }), dot('boat', [-700, 0])], grounded),
  ];
  const timeline = [travel('boat', { at: 0, path: line, dur: 2, profile: 'steady' })];
  const frame = async (grounded: boolean): Promise<Map<string, ShapeItem | StrokeItem>> => new Map((await items(make(list(grounded), timeline, seen(40)), 60)).map((i) => [i.node.id, i as ShapeItem | StrokeItem]));
  const flat = await frame(false);
  const raised = await frame(true);
  const road = raised.get('road') as StrokeItem;
  assert.equal((flat.get('road') as StrokeItem).path, undefined, 'without a ground, the line of its node');
  assert.ok(road.path && road.path.points.length > 20, 'cut into pieces about a cell of the grid long');
  // The middle of the line, over the hill's top, is drawn up the screen; its ends, where the hill is all but flat, near where they were.
  const mid = road.path.points.reduce((m, p) => (Math.abs(p[0]) < Math.abs(m[0]) ? p : m));
  assert.ok(mid[1] < -200, `the middle of the road at ${mid}`);
  const ends = [road.path.points[0]!, road.path.points[road.path.points.length - 1]!];
  assert.ok(ends.every((p) => Math.abs(p[1]) < 10), `its ends at ${ends}`);
  const pondShape = (raised.get('pond') as ShapeItem).shape!;
  assert.ok(pondShape.kind === 'polygon' && pondShape.points.length > 4 && pondShape.points.every((p) => p[1] < 60), 'the pond lies on the hill');
  // Half-way, the boat is over the hill's top: up the screen.
  assert.ok(raised.get('boat')!.xf.y < flat.get('boat')!.xf.y - 40);
  // The shed stands on the hill: its foot and its top both higher on the screen than on the flat.
  const [shedUp, shedFlat] = [raised.get('shed') as ShapeItem, flat.get('shed') as ShapeItem];
  assert.ok(shedUp.foot && shedFlat.foot && shedUp.xf.y < shedFlat.xf.y - 40);
});

test('ground: drawn raised, the same frame twice is the same, and a hill hides the plane behind it', async () => {
  const spec = (grounded: boolean): ReturnType<typeof make> => make([floor([hill()], grounded)], [], seen(30));
  const raised = await draw(spec(true));
  assert.equal(differing(raised, await draw(spec(true))), 0);
  const flat = await draw(spec(false));
  assert.ok(differing(raised, flat, 8) > 5000, 'the hill stands up');
  // The top of the hill, raised, is drawn where the flat field shows ground farther away: there it is the hill's colour.
  const sum = (p: Rgb): number => p[0] + p[1] + p[2];
  let higher = 0;
  for (let y = -300; y < 0; y += 10) if (sum(at(raised, 0, y)) > sum(at(flat, 0, y)) + 20) higher++;
  assert.ok(higher > 3, `${higher} places where the lit top shows`);
});

test('ground: a finer relief over a coarser one: things stand on the finer where it lies', async () => {
  const fine = relief({ id: 'fine', at: [0, 0], w: 400, h: 400, heights: { cols: 3, rows: 3, values: [300, 300, 300, 300, 300, 300, 300, 300, 300] }, dark: 'deep.abyss', bright: 'light.snow', feather: 100 });
  const spec = (ground: string | string[]): ReturnType<typeof make> => make([group({ id: 'floor', plane: 'floor', ground, children: [hill(), fine, dot('in', [0, 0]), dot('edge', [150, 0])] })], [], seen(40));
  const one = new Map((await items(spec('hill'))).map((i) => [i.node.id, i as ShapeItem]));
  const two = new Map((await items(spec(['hill', 'fine']))).map((i) => [i.node.id, i as ShapeItem]));
  assert.ok(two.get('fine')!.raise && !one.get('fine')!.raise);
  assert.ok(two.get('in')!.xf.y < one.get('in')!.xf.y - 20, 'in the middle of the finer one, at its height');
  assert.ok(two.get('edge')!.xf.y < one.get('edge')!.xf.y, 'in its feather, part way to it');
  assert.ok(refused(() => compileShot(spec(['hill', 'nothing'])), /stands on the ground "nothing"/));
  assert.ok(refused(() => compileShot(spec(['hill', 'hill'])), /twice/));
  assert.ok(refused(() => group({ id: 'g', ground: 'hill', children: [] }), /ground is for a group that lies in a plane/));
});

test('relief feather and fog fade: a field melts into what lies under it; a plane fades out into what lies behind it', async () => {
  const ground = rect({ id: 'g', w: 1800, h: 1000, radius: 0, fill: 'mid.ocean', lit: false });
  const level = (extra: object = {}): ReturnType<typeof relief> => relief({ id: 'r', w: 800, h: 400, heights: { cols: 2, rows: 2, values: [50, 50, 50, 50] }, dark: 'deep.abyss', bright: 'light.snow', tints: [[0, 'accent.coral'], [100, 'accent.coral']], ...extra });
  const sharp = await draw(make([ground, level()]));
  const soft = await draw(make([ground, level({ feather: 100 })]));
  const under = at(await draw(make([ground])), 390, 0);
  assert.deepEqual(at(soft, 0, 0), at(sharp, 0, 0), 'inside its feather, the field as it was');
  const edge = at(soft, 390, 0);
  assert.ok(Math.abs(edge[0] - under[0]) < Math.abs(at(sharp, 390, 0)[0] - under[0]) / 3, `near its edge, mostly what lies under it: ${edge} over ${under}`);
  // A plane that fades out with distance: its far part shows the ground of the shot, its near part is as it was.
  const plane = (fade: boolean): ReturnType<typeof make> =>
    make([group({ id: 'floor', plane: 'floor', fog: { color: 'mid.mist', near: 1000, far: 3000, amount: 0.001, ...(fade ? { fade: { near: 1500, far: 1800 } } : {}) }, children: [rect({ id: 'land', w: 4000, h: 4000, fill: 'accent.coral', lit: false })] })], [], seen(25));
  const [kept, faded, sky] = [await draw(plane(false)), await draw(plane(true)), await draw(make([]))];
  assert.deepEqual(at(faded, 0, 400), at(kept, 0, 400), 'near, as it was');
  assert.deepEqual(at(faded, 0, -150), at(sky, 0, -150), 'far, the ground of the shot');
  assert.notDeepEqual(at(kept, 0, -150), at(sky, 0, -150));
  assert.ok(refused(() => group({ id: 'f', plane: 'floor', fog: { color: 'mid.mist', near: 1, far: 2, fade: { near: 5, far: 4 } }, children: [] }), /fade.far/));
});
