import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, circle, compileShot, frameRaw, group, heightFor, layer, rect, region, SceneError, shot, type LayerSpec, type ShotSpec, type Vec2 } from '../src/index.ts';

// Two options of the light of a shape. lift: how much of the lift of the background its glow draws, for a glowing
// shape whose light belongs inside something. highlight: false, the automatic light without its highlight stroke,
// for an outline with deep bays and long capes, where the stroke would cut across the shape. Both are opt-in: a shape
// that leaves them out is the data, and the picture, it always was.

const WIDTH = 480;

function make(nodes: LayerSpec['nodes']): ShotSpec {
  return shot({
    id: 'tiny',
    seconds: 1,
    seed: 5,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline: [],
  });
}

async function raw(spec: ShotSpec): Promise<Buffer> {
  const c = compileShot(spec);
  return frameRaw(c, await bakeShot(c), 0, { width: WIDTH, lang: 'en', gpu: false });
}

/** A frame as pixels, and a reader of the pixel at a place of the stage (units, origin at the centre). */
async function picture(spec: ShotSpec): Promise<(x: number, y: number) => [number, number, number]> {
  const pixels = await raw(spec);
  const k = WIDTH / 1920;
  return (x, y) => {
    const i = (Math.round(heightFor(WIDTH) / 2 + y * k) * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4;
    return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
  };
}

const hash = async (spec: ShotSpec): Promise<string> => createHash('sha256').update(await raw(spec)).digest('hex');
const far = (a: readonly number[], b: readonly number[]): number => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

/** A glowing core inside a dark shell, as a light that belongs inside a thing. */
const core = (extra: object = {}): LayerSpec['nodes'] => [
  rect({ id: 'shell', w: 360, h: 240, fill: 'dark.navy' }),
  group({ id: 'in', clipTo: 'shell', children: [circle({ id: 'core', r: 60, fill: 'accent.aqua', glow: 1, ...extra })] }),
];

/** An outline with five long capes and deep, narrow bays between them, as a coast cut by fjords. */
function bays(): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < 5; i++) {
    const x0 = -300 + i * 120;
    pts.push([x0 + 12, -180], [x0 + 54, -190], [x0 + 74, -176], [x0 + 89, 60], [x0 + 103, 62], [x0 + 114, -172]);
  }
  pts.push([300, 180], [-300, 180]);
  return pts;
}

test('lift: a glowing shape draws that share of the lift of the background; 0 keeps the halo alone', async () => {
  const dark = await picture(make([rect({ id: 'shell', w: 360, h: 240, fill: 'dark.navy' })]));
  const whole = await picture(make(core()));
  const none = await picture(make(core({ lift: 0 })));
  const half = await picture(make(core({ lift: 0.5 })));
  // Out in the sky, beyond the shell and beyond the halo of the core, the lift is all there is of the glow.
  const sky: [number, number] = [0, -260];
  const lifted = far(whole(sky[0], sky[1]), dark(sky[0], sky[1]));
  assert.ok(lifted >= 4, `the whole lift brightens the sky by ${lifted}`);
  assert.equal(far(none(sky[0], sky[1]), dark(sky[0], sky[1])), 0, 'without its lift the sky is the sky without the core');
  const partly = far(half(sky[0], sky[1]), dark(sky[0], sky[1]));
  assert.ok(partly > 0 && partly < lifted, `half of the lift brightens it by ${partly}, less than ${lifted}`);
  // The core itself, its halo and the shell it lies in are drawn as they were.
  for (const [x, y] of [[0, 0], [62, 0], [70, 0], [100, 40]] as const) assert.equal(far(none(x, y), whole(x, y)), 0, `at ${x}, ${y} inside the shell`);
});

test('highlight: false keeps the crescents of the light and leaves out the stroke that would cut across a shape', async () => {
  const lit = await raw(make([region({ id: 'coast', points: bays(), smooth: 0.3, fill: 'mid.jade' })]));
  const plain = await raw(make([region({ id: 'coast', points: bays(), smooth: 0.3, fill: 'mid.jade', highlight: false })]));
  const unlit = await raw(make([region({ id: 'coast', points: bays(), smooth: 0.3, fill: 'mid.jade', lit: false })]));
  let gone = 0;
  let darker = 0;
  for (let i = 0; i < lit.length; i += 4) {
    if (lit[i] === plain[i] && lit[i + 1] === plain[i + 1] && lit[i + 2] === plain[i + 2]) continue;
    gone++;
    // What the stroke drew is lighter than what lies under it.
    if (lit[i]! + lit[i + 1]! + lit[i + 2]! < plain[i]! + plain[i + 1]! + plain[i + 2]!) darker++;
  }
  assert.ok(gone > 0, 'the highlight stroke is gone');
  assert.equal(darker, 0, 'only the pale stroke is taken out');
  // The crescents stay: the shape is still lit, not flat.
  assert.notDeepEqual(plain, unlit);
});

test('lift and highlight are refused where they mean nothing, and are opt-in', async () => {
  const refused = (make: () => unknown, words: RegExp): void => {
    assert.throws(make, (e: unknown) => e instanceof SceneError && words.test(e.message));
  };
  refused(() => circle({ id: 'a', r: 10, fill: 'accent.aqua', lift: 0 }), /lift .*has no glow/);
  refused(() => circle({ id: 'a', r: 10, fill: 'accent.aqua', glow: 0, lift: 0 }), /lift .*has no glow/);
  refused(() => circle({ id: 'a', r: 10, fill: 'accent.aqua', glow: 1, lift: 1.5 }), /lift must be a number in 0\.\.1/);
  refused(() => circle({ id: 'a', r: 10, fill: 'accent.aqua', lit: false, highlight: false }), /highlight .*not lit/);
  refused(() => circle({ id: 'a', r: 10, fill: 'accent.aqua', highlight: 'no' as unknown as boolean }), /highlight/);
  // Left out, neither is written into the node, so the data of a shot that does not ask for them is what it was.
  const node = circle({ id: 'a', r: 10, fill: 'accent.aqua', glow: 1 });
  assert.ok(!('lift' in node) && !('highlight' in node));
  // Given at their defaults, they draw the pixels of a shape that leaves them out.
  assert.equal(await hash(make(core({ lift: 1 }))), await hash(make(core())));
  const coast = (extra: object): LayerSpec['nodes'] => [region({ id: 'coast', points: bays(), smooth: 0.3, fill: 'mid.jade', ...extra })];
  assert.equal(await hash(make(coast({ highlight: true }))), await hash(make(coast({}))));
});
