import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  cameraTo,
  circle,
  compileShot,
  evaluate,
  frameRaw,
  group,
  heightFor,
  layer,
  rect,
  shot,
  stroke,
  type Item,
  type Key,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';

// A soft node: a shape or a group with `soft` is drawn as one picture that is blurred, so its edge fades out.

const WIDTH = 960;

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], extra: object = {}): ShotSpec {
  return shot({
    id: 'tiny',
    seconds: 4,
    seed: 3,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.abyss', outer: 'deep.abyss' },
    atmosphere: 'mid.mist',
    vignette: 0,
    // A still camera: a place of the stage is that place on screen, moved by half a frame.
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, tint: 0, nodes, ...extra })],
    timeline,
  });
}

/** A pale square of 400 units in the middle of the stage. */
const patch = (extra: object = {}): LayerSpec['nodes'] => [rect({ id: 'p', w: 400, h: 400, radius: 0, fill: 'light.snow', lit: false, ...extra })];

/** How light the picture is at a place of the stage, 0..255 (its red). */
async function lightAt(spec: ShotSpec, frame: number, x: number, y: number): Promise<number> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
  const k = WIDTH / 1920;
  return raw[(Math.round(heightFor(WIDTH) / 2 + y * k) * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4]!;
}

async function hash(spec: ShotSpec, frame: number): Promise<string> {
  const c = compileShot(spec);
  return createHash('sha256').update(await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false })).digest('hex');
}

async function itemsOf(spec: ShotSpec, frame = 0): Promise<readonly Item[]> {
  const c = compileShot(spec);
  return evaluate(c, await bakeShot(c), frame, 'en').layers[0]!.items;
}

test('soft: a soft shape fades out across its edge, and is whole in its middle', async () => {
  const sharp = make(patch());
  const soft = make(patch({ soft: 30 }));
  const dark = await lightAt(sharp, 0, 600, 0);
  // The sharp square ends at its edge.
  const whole = await lightAt(sharp, 0, 0, 0);
  assert.ok(whole > 225 && (await lightAt(sharp, 0, 190, 0)) === whole && (await lightAt(sharp, 0, 210, 0)) === dark);
  // The soft one is half there at its edge, still there a little way out, and gone far out; its middle is whole.
  const edge = await lightAt(soft, 0, 200, 0);
  assert.ok(edge > 90 && edge < 170, `half-way at the edge: ${edge}`);
  const inside = await lightAt(soft, 0, 190, 0);
  const outside = await lightAt(soft, 0, 210, 0);
  assert.ok(inside > edge + 30 && inside < whole - 30 && outside < edge - 30 && outside > dark + 10, `${whole} > ${inside} > ${edge} > ${outside} > ${dark}`);
  assert.equal(await lightAt(soft, 0, 0, 0), whole);
  assert.equal(await lightAt(soft, 0, 360, 0), dark);
  // A wider blur reaches farther.
  assert.ok((await lightAt(make(patch({ soft: 60 })), 0, 225, 0)) > (await lightAt(soft, 0, 225, 0)) + 10);
});

test('soft: the blur is in the units of the node, where it is drawn; a soft group is one picture', async () => {
  // The item is a picture of its own that carries the blur, in the units of the layer.
  const [one] = await itemsOf(make(patch({ soft: 30 })));
  assert.ok(one && one.kind === 'group' && one.soft === 30 && one.opacity === 1 && one.items.length === 1);
  const [twice] = await itemsOf(make([group({ id: 'g', scale: 2, children: patch({ soft: 30 }) })]));
  assert.ok(twice && twice.kind === 'group' && twice.soft === 60);
  // Under a zoom of the camera it grows with the picture: a soft edge keeps its look.
  const zoomed = make(patch({ w: 100, h: 100, soft: 8 }), [cameraTo({ at: 0.5, zoom: 4, dur: 1 })]);
  const dark = await lightAt(zoomed, 200, 600, 0);
  const edge = await lightAt(zoomed, 200, 200, 0);
  assert.ok(edge > 90 && edge < 170 && (await lightAt(zoomed, 200, 210, 0)) > dark + 10 && (await lightAt(zoomed, 200, 210, 0)) < edge - 30);
  // A soft group: its children are blurred together, and it fades as one picture.
  const cloud = make([group({ id: 'cloud', soft: 20, opacity: 0.5, children: [circle({ id: 'a', at: [-60, 0], r: 100, fill: 'light.snow', lit: false }), circle({ id: 'b', at: [60, 0], r: 100, fill: 'light.snow', lit: false })] })]);
  const [g] = await itemsOf(cloud);
  assert.ok(g && g.kind === 'group' && g.soft === 20 && g.opacity === 0.5 && g.items.length === 2);
  const middle = await lightAt(cloud, 0, 0, 0);
  const lone = await lightAt(cloud, 0, -100, 0);
  assert.ok(Math.abs(middle - lone) <= 2, `where its two discs overlap it is no denser than elsewhere: ${middle}, ${lone}`);
  assert.ok(middle > 110 && middle < 150);
  // In a plane of a perspective layer it is blurred where it lies.
  const floor = (extra: object): ShotSpec => make([group({ id: 'floor', at: [0, 0, 0], plane: 'floor', children: patch(extra) })], [], { perspective: { tilt: 90 } });
  assert.ok((await lightAt(floor({ soft: 30 }), 0, 210, 0)) > (await lightAt(floor({}), 0, 210, 0)) + 10);
});

test('soft: what is clipped to a soft shape fades out across its edge', async () => {
  // A long line, seen through a window of 400 units that is not drawn itself.
  const road = (extra: object = {}): LayerSpec['nodes'] => [
    rect({ id: 'window', w: 400, h: 400, radius: 0, fill: 'dark.navy', lit: false, opacity: 0, ...extra }),
    stroke({ id: 'road', points: [[-800, 0], [800, 0]], smooth: 0, color: 'light.snow', width: 20, clipTo: 'window' }),
  ];
  const hard = make(road());
  const soft = make(road({ soft: 30 }));
  const dark = await lightAt(hard, 0, 600, 200);
  const whole = await lightAt(hard, 0, 0, 0);
  // A sharp window cuts the line at its edge.
  assert.ok(whole > 225 && (await lightAt(hard, 0, 190, 0)) === whole && (await lightAt(hard, 0, 210, 0)) === dark);
  // A soft one lets it fade: whole in the middle, half there at the edge, gone a little way out.
  const edge = await lightAt(soft, 0, 200, 0);
  assert.equal(await lightAt(soft, 0, 0, 0), whole);
  assert.ok(edge > 90 && edge < 170, `half-way at the edge: ${edge}`);
  assert.ok((await lightAt(soft, 0, 190, 0)) > edge + 30 && (await lightAt(soft, 0, 210, 0)) < edge - 30 && (await lightAt(soft, 0, 210, 0)) > dark + 10);
  assert.equal(await lightAt(soft, 0, 300, 0), dark);
  // Only the line is drawn: the window gives nothing of its own.
  assert.equal(await lightAt(soft, 0, 0, 100), dark);
  // The item says how far the edge of the clip is blurred; a sharp clip says nothing.
  const clip = (await itemsOf(soft)).find((i) => i.kind === 'clip');
  assert.ok(clip && clip.kind === 'clip' && clip.soft === 30);
  const sharp = (await itemsOf(hard)).find((i) => i.kind === 'clip');
  assert.ok(sharp && !('soft' in sharp));
  assert.equal(await hash(make(road({ soft: 0 })), 0), await hash(hard, 0));
  // In a plane of a perspective layer, seen from straight above, it fades as it does in a flat layer.
  const floor = (extra: object): ShotSpec => make([group({ id: 'floor', at: [0, 0, 0], plane: 'floor', children: road(extra) })], [], { perspective: { tilt: 90 } });
  const lying = await lightAt(floor({ soft: 30 }), 0, 200, 0);
  assert.ok(Math.abs(lying - edge) <= 6, `${lying} against ${edge}`);
  assert.equal(await lightAt(floor({}), 0, 210, 0), dark);
  assert.ok((await lightAt(floor({ soft: 30 }), 0, 210, 0)) > dark + 10);
});

test('soft: what it refuses', () => {
  const bad = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, (e: unknown) => e instanceof Error && message.test(e.message), String(message));
  };
  bad(() => patch({ soft: -1 }), /soft must be a number in 0\.\.200/);
  bad(() => patch({ soft: 201 }), /soft must be a number in 0\.\.200/);
  bad(() => patch({ soft: true }), /soft must be a number in 0\.\.200/);
  bad(() => group({ id: 'g', soft: 500 }), /soft must be a number in 0\.\.200/);
  // It is for shapes and groups: a line that should be soft goes into a soft group.
  bad(() => stroke({ id: 's', points: [[0, 0], [100, 0]], color: 'light.snow', soft: 5 } as never), /unknown option "soft"/);
});

test('soft: it is opt-in: a node without it is the data and the picture it was', async () => {
  const plain = make(patch());
  assert.ok(!('soft' in plain.layers[0]!.nodes[0]!));
  assert.ok(!('soft' in group({ id: 'g' })));
  // An opaque shape is drawn straight into its layer, with no picture of its own.
  const [item] = await itemsOf(plain);
  assert.ok(item && item.kind === 'shape');
  // A faded node is the group it always was: it carries no blur.
  const [faded] = await itemsOf(make(patch({ opacity: 0.5 })));
  assert.ok(faded && faded.kind === 'group' && !('soft' in faded));
  // A blur of nothing is no blur.
  assert.equal(await hash(make(patch({ soft: 0 })), 0), await hash(plain, 0));
  assert.equal(await hash(make(patch({ soft: 0, opacity: 0.5 })), 0), await hash(make(patch({ opacity: 0.5 })), 0));
  assert.notEqual(await hash(make(patch({ soft: 30 })), 0), await hash(plain, 0));
});
