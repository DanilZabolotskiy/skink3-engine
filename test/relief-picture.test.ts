import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, compileShot, frameRaw, group, layer, perspectiveTo, rect, relief, shot, type Key, type ShapeNode, type ShotSpec } from '../src/index.ts';

// A relief drawn from a picture (picture): its shading is made once into an image of the field, a few pixels to a cell
// of its grid, and every frame draws that one image through the field's transform. It is opt-in: a relief without it
// is worked out pixel by pixel, as it always was.

const WIDTH = 480;
const COLS = 61;
const ROWS = 41;
const values = Array.from({ length: COLS * ROWS }, (_, i) => {
  const x = (i % COLS) / (COLS - 1);
  const y = Math.floor(i / COLS) / (ROWS - 1);
  return 300 * Math.exp(-((x - 0.4) ** 2 + (y - 0.5) ** 2) * 18) + 120 * Math.sin(x * 9) * Math.cos(y * 7);
});

const hills = (extra: Partial<Parameters<typeof relief>[0]> = {}): ShapeNode =>
  relief({ id: 'hills', w: 1600, h: 1000, heights: { cols: COLS, rows: ROWS, values }, vertical: 1, dark: 'deep.night', bright: 'light.cream', tints: [[-100, 'mid.jade'], [300, 'mid.rose']], ...extra });

function make(o: { picture?: 1 | 2 | 4; persp?: boolean; timeline?: Key[]; feather?: number; empty?: boolean } = {}): ShotSpec {
  const field = hills({ ...(o.picture === undefined ? {} : { picture: o.picture }), ...(o.feather === undefined ? {} : { feather: o.feather }) });
  return shot({
    id: 'tiny', seconds: 2, seed: 1, palette, strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.abyss' }, atmosphere: 'mid.mist', vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [o.empty
      ? layer({ id: 'map', depth: 0, nodes: [] })
      : o.persp
        ? layer({ id: 'map', depth: 0, perspective: { aim: [0, 0, 0], distance: 1600, lens: 1200, tilt: 40, turn: 0 }, nodes: [group({ id: 'floor', plane: 'floor', children: [rect({ id: 'ground', w: 3000, h: 3000, fill: 'dark.navy', lit: false }), field] })] })
        : layer({ id: 'map', depth: 0, nodes: [field] })],
    timeline: o.timeline ?? [],
  });
}

async function raw(spec: ShotSpec, frame: number): Promise<Buffer> {
  const c = compileShot(spec);
  return frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
}

/** The mean and the greatest difference of two frames, per channel, and the share of the pixels off by more than 24 levels. */
function difference(a: Buffer, b: Buffer): { mean: number; most: number; off: number } {
  let sum = 0;
  let most = 0;
  let off = 0;
  for (let i = 0; i < a.length; i += 4) {
    let pixel = 0;
    for (let j = i; j < i + 3; j++) {
      const d = Math.abs(a[j]! - b[j]!);
      sum += d;
      pixel = Math.max(pixel, d);
    }
    most = Math.max(most, pixel);
    if (pixel > 24) off++;
  }
  return { mean: sum / ((a.length / 4) * 3), most, off: off / (a.length / 4) };
}

test('relief picture: what it refuses', () => {
  assert.throws(() => hills({ picture: 3 as never }), /picture must be 1, 2 or 4/);
  assert.throws(() => hills({ picture: 2, samplePixels: 2 }), /a relief with a picture is not shaded pixel by pixel: leave samplePixels out/);
  assert.throws(() => relief({ id: 'big', w: 100, h: 100, heights: { cols: 3000, rows: 2, values: new Array(6000).fill(0) }, dark: 'deep.night', bright: 'light.cream', picture: 4 }), /its picture would be 11997 by 5 pixels; a picture is at most 8192 a side/);
  // The ground of a plane is drawn raised, ray by ray: a picture lies flat, so it is no ground.
  assert.throws(() => shot({
    id: 'ground', seconds: 1, seed: 1, palette, strings: { en: {} }, background: { inner: 'deep.night', outer: 'deep.abyss' }, atmosphere: 'mid.mist',
    layers: [layer({ id: 'map', depth: 0, perspective: true, nodes: [group({ id: 'floor', plane: 'floor', ground: 'hills', children: [hills({ picture: 2 })] })] })],
  }), /stands on the ground "hills", a relief with a picture: a ground is drawn raised, ray by ray, and a picture lies flat/);
});

test('relief picture: opt-in: a relief without it is the data it was', () => {
  assert.equal('picture' in hills().relief!, false);
  assert.equal(hills({ picture: 2 }).relief!.picture, 2);
  const { picture: _, ...rest } = hills({ picture: 2 }).relief!;
  assert.deepEqual(rest, hills().relief);
});

test('relief picture: it draws the shading the pixel-by-pixel relief draws, flat and in a plane, its feather too', async () => {
  for (const o of [{}, { persp: true }, { feather: 120 }]) {
    const exact = await raw(make(o), 30);
    const pictured = await raw(make({ ...o, picture: 2 }), 30);
    const d = difference(exact, pictured);
    // The same shading: only the interpolation between the points of the grid differs, by a few levels.
    assert.ok(d.mean < 1.5, `mean difference ${d.mean.toFixed(2)} with ${JSON.stringify(o)}`);
    // Off by more than a little only along its edge, where the picture's own pixels meet the frame's.
    assert.ok(d.off < 0.004, `${(100 * d.off).toFixed(2)} % of the pixels differ by more than 24 levels with ${JSON.stringify(o)}`);
    // And it is a picture of the field, not the empty frame.
    const empty = await raw(make({ empty: true }), 30);
    assert.ok(difference(empty, pictured).mean > 10);
  }
});

test('relief picture: the same frame is the same picture, while the camera moves', async () => {
  const moving = make({ persp: true, picture: 2, timeline: [perspectiveTo('map', { at: 0, tilt: 55, dur: 2 })] });
  const a = await raw(moving, 40);
  const b = await raw(moving, 60);
  const again = await raw(moving, 40);
  assert.ok(difference(a, b).mean > 0.5, 'the picture moves with the camera');
  assert.equal(difference(a, again).most, 0, 'and frame 40 drawn again is frame 40');
});
