import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeShot,
  cameraTo,
  compileShot,
  evaluate,
  flatItems,
  frameRaw,
  group,
  heightFor,
  layer,
  link,
  reviewMotion,
  shot,
  stroke,
  widthTo,
  type Key,
  type LayerSpec,
  type ShotSpec,
} from '../src/index.ts';

// A line that keeps a least width on screen: a stroke with `least` is never thinner in the frame than that, however
// far the camera has pulled back and however small its parents are drawn.

const WIDTH = 960;
/** How much smaller than the stage the detail is drawn: the camera zooms in by as much. */
const RATIO = 40;

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

/** A detail drawn at a fortieth of its size: a line across it, 4 of its units wide, which is a tenth of a unit of the frame. */
const river = (extra: object = {}): LayerSpec['nodes'] => [
  group({ id: 'detail', scale: 1 / RATIO, children: [stroke({ id: 'r', points: [[-12000, 0], [12000, 0]], smooth: 0, color: 'light.snow', width: 4, ...extra })] }),
];
const zoom: Key[] = [cameraTo({ at: 0.5, zoom: RATIO, dur: 2.5 })];

/** How light the picture is at a place of the frame, 0..255. */
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

/** The width of the line on screen at a moment, in units of the frame: the width its item carries, through its size and the zoom of the camera. */
async function onScreen(spec: ShotSpec): Promise<(seconds: number) => { own: number | undefined; seen: number }> {
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  return (seconds) => {
    const state = evaluate(c, bake, Math.round(seconds * 60), 'en').layers[0]!;
    const item = flatItems(state.items).find((i) => i.node.id === 'r');
    assert.ok(item && item.kind === 'stroke');
    return { own: item.width, seen: (item.width ?? 4) * item.xf.scale * state.view.zoom };
  };
}

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

test('least: a line with a least width stays that wide on screen through a deep zoom, and is its own width once that is wider', async () => {
  const held = await onScreen(make(river({ least: 3 }), zoom));
  const bare = await onScreen(make(river(), zoom));
  // In the wide view the bare line is a tenth of a unit: nothing. The held one is 3 units.
  assert.ok(near(bare(0).seen, 0.1) && near(held(0).seen, 3) && near(held(0).own!, 120));
  // Half-way through the zoom it is still 3 units, whatever the zoom is there.
  for (const t of [1, 1.5, 2, 2.5]) assert.ok(near(held(t).seen, 3) || held(t).seen > 3, `at ${t} s: ${held(t).seen}`);
  assert.ok(near(held(1.5).seen, 3) && bare(1.5).seen < 3);
  // At the end of the zoom its own width, 4 units of the frame, is the wider one: the line is what it was made.
  assert.ok(near(held(3.5).seen, 4) && near(held(3.5).own!, 4) && near(bare(3.5).seen, 4));
  // The picture: in the wide view the held line is there, the bare one is not.
  const dark = await lightAt(make(river(), zoom), 0, 0, 300);
  assert.ok((await lightAt(make(river({ least: 3 }), zoom), 0, 0, 0)) > 150);
  assert.ok((await lightAt(make(river(), zoom), 0, 0, 0)) < dark + 40);
  assert.equal(await lightAt(make(river({ least: 3 }), zoom), 0, 0, 6), dark);
  // In a plane of a perspective layer it holds its width where it lies.
  const floor = (extra: object): ShotSpec => make([group({ id: 'floor', at: [0, 0, 0], plane: 'floor', children: river(extra) })], [], { perspective: { tilt: 90 } });
  assert.ok(near((await onScreen(floor({ least: 3 })))(0).seen, 3, 1e-6));
});

test('least: what it refuses', () => {
  const bad = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, (e: unknown) => e instanceof Error && message.test(e.message), String(message));
  };
  bad(() => river({ least: 0 }), /least must be a number in 0\.5\.\.200/);
  bad(() => river({ least: 300 }), /least must be a number in 0\.5\.\.200/);
  bad(() => river({ least: '3' }), /least must be a number in 0\.5\.\.200/);
  // It is for strokes: a link joins two nodes of one size.
  bad(() => link({ id: 'l', from: 'a', to: 'b', color: 'light.snow', least: 3 } as never), /unknown option "least"/);
  // The width of such a line is given at every zoom: a key of its width has nothing to change.
  bad(() => make(river({ least: 3 }), [widthTo('r', { at: 1, to: 20 })]), /widthTo\("r"\): the stroke has least, which gives its width at every zoom/);
});

test('least: it is opt-in: a line without it is the data and the picture it was', async () => {
  const plain = stroke({ id: 's', points: [[-300, 0], [300, 0]], smooth: 0, color: 'light.snow', width: 8 });
  assert.ok(!('least' in plain));
  assert.equal((await onScreen(make(river(), zoom)))(1).own, undefined);
  // A line that is already wider than its least width is the line it was, at every frame.
  const wide = (extra: object = {}): ShotSpec => make([stroke({ id: 'r', points: [[-300, 0], [300, 100]], color: 'light.snow', width: 8, ...extra })], [cameraTo({ at: 0.5, zoom: 3, dur: 2 })]);
  for (const frame of [0, 90, 200]) assert.equal(await hash(wide({ least: 3 }), frame), await hash(wide(), frame), `frame ${frame}`);
  assert.notEqual(await hash(wide({ least: 30 }), 0), await hash(wide(), 0));
});

test('least: the motion review reads the zoom on the camera, not on the line', async () => {
  const c = compileShot(make(river({ least: 3 }), zoom));
  const { report, series } = reviewMotion(c, await bakeShot(c));
  // The line holds its width on screen because the camera moves: it has no width of its own that changes.
  assert.equal(series.placed.find((s) => s?.node.id === 'r')!.width, null);
  assert.deepEqual(report.findings.filter((f) => f.subject === 'r'), []);
});
