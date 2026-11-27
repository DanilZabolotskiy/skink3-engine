import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  circle,
  compileShot,
  evaluate,
  frameRaw,
  group,
  heightFor,
  layer,
  moveTo,
  perspectiveTo,
  rect,
  reviewMotion,
  shot,
  type Item,
  type Key,
  type SceneNode,
  type ShotSpec,
} from '../src/index.ts';

// A focus by distance in a perspective layer (perspective.focus): what lies at the focus is sharp, a thing behind it is
// blurred by `far` per unit of depth and one in front of it by `near`, the depth of a thing being its distance from the
// camera over that of the focus, less 1. A node listed in the layer and each child of a group that lies in a plane is
// blurred as one picture by its distance at its place, at every frame. It is opt-in: a layer without it is the layer it was.
//
// The camera of these shots is level and straight on, 1600 from its aim at the origin: it stands at z = -1600, and the
// distance of a thing is its z + 1600.

const WIDTH = 480;
type Focus = { far?: number; near?: number; at?: number };

function make(nodes: SceneNode[], o: { focus?: Focus; timeline?: Key[]; seconds?: number } = {}): ShotSpec {
  return shot({
    id: 'tiny',
    seconds: o.seconds ?? 3,
    seed: 3,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.abyss' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'space', depth: 0, perspective: o.focus ? { focus: o.focus } : true, nodes })],
    timeline: o.timeline ?? [],
  });
}

const dot = (id: string, z: number, x = 0, soft?: number): SceneNode => circle({ id, at: [x, 0, z], r: 60, fill: 'accent.aqua', lit: false, ...(soft === undefined ? {} : { soft }) });

/** The blur of each node that a frame draws as a soft picture, by id. */
async function blurs(spec: ShotSpec, frames: readonly number[]): Promise<Map<string, number>[]> {
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  return frames.map((frame) => {
    const out = new Map<string, number>();
    const walk = (items: readonly Item[]): void => {
      for (const item of items) {
        if (item.kind === 'group' && item.soft !== undefined) out.set(item.node.id, item.soft);
        if ('items' in item && item.items) walk(item.items as readonly Item[]);
      }
    };
    for (const l of evaluate(c, bake, frame, 'en').layers) walk(l.items);
    return out;
  });
}

async function hash(spec: ShotSpec, frame: number): Promise<string> {
  const c = compileShot(spec);
  return createHash('sha256').update(await frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false })).digest('hex');
}

const near = (a: number | undefined, b: number, what: string): void => assert.ok(a !== undefined && Math.abs(a - b) < 1e-6, `${what}: ${a} against ${b}`);

test('perspective focus: a listed node is blurred by its depth behind or in front of the focus, and its own blur adds to it', async () => {
  const [at0] = await blurs(make([dot('sharp', 0), dot('back', 1600, -300), dot('far', 4800, 300), dot('front', -800, 200), dot('own', 1600, -600, 4)], { focus: { far: 6, near: 40 } }), [0]);
  assert.equal(at0!.has('sharp'), false, 'what lies at the focus is drawn sharp');
  near(at0!.get('back'), 6, 'twice as far as the focus: depth 1');
  near(at0!.get('far'), 18, 'four times as far: depth 3');
  near(at0!.get('front'), 20, 'halfway to the camera: depth -0.5');
  // Its own soft is that of its units where it is drawn (half its size, at twice the distance), and the two add as two blurs one after the other.
  near(at0!.get('own'), Math.hypot(2, 6), 'its own blur and the focus');
  // Only a side that is given blurs: in front of the focus nothing does with far alone.
  const [only] = await blurs(make([dot('back', 1600), dot('front', -800, 200)], { focus: { far: 6 } }), [0]);
  near(only!.get('back'), 6, 'far alone');
  assert.equal(only!.has('front'), false);
});

test('perspective focus: the focus is at the aim unless it is given, and follows the camera as perspectiveTo moves it', async () => {
  // Given: the focus lies 3200 away, and what is there is sharp.
  const [given] = await blurs(make([dot('sharp', 1600), dot('front', 0, 200)], { focus: { far: 6, near: 40, at: 3200 } }), [0]);
  assert.equal(given!.has('sharp'), false);
  near(given!.get('front'), 20, 'at 1600 of a focus at 3200');
  // Left out: the camera's distance from its aim at each frame. Moved back to 3200, the aim stays sharp and the node behind it sharpens.
  const moved = make([dot('aim', 0), dot('back', 1600)], { focus: { far: 6 }, timeline: [perspectiveTo('space', { at: 0.5, dur: 1, distance: 3200 })] });
  const [before, after] = await blurs(moved, [0, 150]);
  assert.equal(before!.has('aim'), false);
  assert.equal(after!.has('aim'), false);
  near(before!.get('back'), 6, 'at 3200 of a focus at 1600');
  near(after!.get('back'), 3, 'at 4800 of a focus at 3200');
});

test('perspective focus: a node that travels toward the focus sharpens at every frame, and the motion review finds nothing in it', async () => {
  const spec = make([dot('comer', 4800)], { focus: { far: 6 }, seconds: 3, timeline: [moveTo('comer', { at: 0.5, to: [0, 0, 0], dur: 2, profile: 'ease', arc: 0 })] });
  const frames = [0, 30, 60, 90, 120, 150, 179];
  const seen = await blurs(spec, frames);
  near(seen[0]!.get('comer'), 18, 'at the start');
  const series = seen.map((m) => m.get('comer') ?? 0);
  for (let i = 1; i < series.length; i++) assert.ok(series[i]! <= series[i - 1]! + 1e-9, `it never grows softer: ${series.join(' ')}`);
  assert.equal(series[series.length - 1], 0, 'it ends sharp, at the focus');
  // The blur follows the motion, which the review already judges: an eased move leaves nothing to find.
  const c = compileShot(spec);
  assert.deepEqual(reviewMotion(c, await bakeShot(c)).report.findings.map((f) => `${f.kind} ${f.subject}`), []);
});

test('perspective focus: each child of a group that lies in a plane is blurred by the distance of its place on the plane', async () => {
  // The floor 200 below the camera; its v runs away from the camera (v = -1600 lies at z = 1600).
  const floor = group({
    id: 'floor',
    at: [0, 200, 0],
    plane: 'floor',
    children: [
      rect({ id: 'mid', at: [0, 0], w: 200, h: 200, fill: 'mid.jade', lit: false }),
      rect({ id: 'back', at: [0, -1600], w: 200, h: 200, fill: 'mid.jade', lit: false }),
      rect({ id: 'front', at: [0, 800], w: 200, h: 200, fill: 'mid.jade', lit: false }),
      group({ id: 'pair', at: [400, -4800], children: [circle({ id: 'pair-a', at: [0, 0], r: 30, fill: 'light.cream', lit: false }), circle({ id: 'pair-b', at: [0, 3000], r: 30, fill: 'light.cream', lit: false })] }),
    ],
  });
  const [at0] = await blurs(make([floor], { focus: { far: 6, near: 40 } }), [0]);
  assert.equal(at0!.has('floor'), false, 'the plane is not one picture: its children are');
  assert.equal(at0!.has('mid'), false);
  near(at0!.get('back'), 6, 'twice as far');
  near(at0!.get('front'), 20, 'halfway');
  // A group in the plane is one picture, blurred by the distance of its own place, whatever its children's are.
  near(at0!.get('pair'), 18, 'four times as far');
  assert.equal(at0!.has('pair-b'), false);
});

test('perspective focus: the picture: a far node is drawn soft, and a focus that blurs nothing it holds draws the same pixels as none', async () => {
  // How soft a node's edge is: the pixels along the middle row from beside it to its middle that are neither the sky nor the node.
  const softness = async (spec: ShotSpec, from: number, to: number): Promise<number> => {
    const c = compileShot(spec);
    const r = await frameRaw(c, await bakeShot(c), 0, { width: WIDTH, lang: 'en', gpu: false });
    const k = WIDTH / 1920;
    const y = Math.round(heightFor(WIDTH) / 2);
    const at = (x: number): number => r[(y * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4 + 1]!;
    const [sky, body] = [at(from), at(to)];
    let n = 0;
    for (let x = from; x <= to; x += 1 / k) if (Math.abs(at(x) - sky) > 6 && Math.abs(at(x) - body) > 6) n++;
    return n;
  };
  const big = (z: number): SceneNode => circle({ id: 'disc', at: [0, 0, z], r: 300, fill: 'accent.aqua', lit: false });
  const sharp = await softness(make([big(1600)]), -700, 0);
  const soft = await softness(make([big(1600)], { focus: { far: 12 } }), -700, 0);
  assert.ok(sharp <= 1 && soft > 4, `${sharp} ${soft}`);
  // Everything at the focus: the pixels of the layer without it.
  const nodes = [big(0), dot('beside', 0, 500)];
  assert.equal(await hash(make(nodes, { focus: { far: 12, near: 40 } }), 0), await hash(make(nodes), 0));
});

test('perspective focus: what it refuses, and opt-in: a layer without it is the data and the picture it was', async () => {
  const bad = (focus: unknown, message: RegExp): void => {
    assert.throws(() => make([dot('a', 0)], { focus: focus as Focus }), (e: unknown) => e instanceof Error && message.test(e.message), String(message));
  };
  bad({}, /perspective\.focus blurs nothing: give far \(blur per unit of depth behind the focus\) or near \(in front of it\) above 0/);
  bad({ far: 0, near: 0 }, /perspective\.focus blurs nothing/);
  bad({ far: -1 }, /perspective\.focus\.far must be a number in 0\.\.100/);
  bad({ near: 500 }, /perspective\.focus\.near must be a number in 0\.\.400/);
  bad({ far: 2, at: 0 }, /perspective\.focus\.at must be a number in 1\.\.1000000/);
  bad({ far: 2, depth: 3 }, /perspective\.focus: unknown option "depth" \(allowed: far, near, at\)/);
  bad(5, /perspective\.focus must be \{ far, near, at \}, got 5/);
  assert.throws(() => layer({ id: 'flat', depth: 0, perspective: { blur: 2 } as never, nodes: [] }), /unknown option "blur" \(allowed: aim, distance, tilt, turn, lens, focus\)/);
  // Without it: no focus in the data, and no node of a perspective layer is drawn soft.
  const plain = make([dot('a', 1600), dot('b', -800)]);
  assert.equal('focus' in plain.layers[0]!.perspective!, false);
  const [none] = await blurs(plain, [0]);
  assert.equal(none!.size, 0);
  // Given: the data carries what it was given, with what is left out at 0.
  assert.deepEqual(make([dot('a', 0)], { focus: { near: 30 } }).layers[0]!.perspective!.focus, { far: 0, near: 30 });
});
