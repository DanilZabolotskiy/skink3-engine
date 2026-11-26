import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, circle, compileShot, eye, frameRaw, heightFor, layer, moveTo, reviewMotion, SceneError, shot, type Key, type LayerSpec, type ShotSpec } from '../src/index.ts';

// The reach of a pupil: how far the middle of the pupil may go from the middle of the eye, as a share of its radius.
// Left out, the pupil stays wholly inside the white; given, the white clips it, and its glint stays on it.

const WIDTH = 960;
const K = WIDTH / 1920;

function make(nodes: LayerSpec['nodes'], timeline: Key[] = []): ShotSpec {
  return shot({
    id: 'tiny',
    seconds: 2,
    seed: 3,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

/** A large eye in the middle of the stage, looking at a small target far off at `to` (or nowhere). */
const big = (extra: object = {}, to?: [number, number]): LayerSpec['nodes'] => [
  ...(to ? [circle({ id: 'target', at: to, r: 6, fill: 'mid.mist', lit: false })] : []),
  eye({ id: 'e', r: 300, white: 'light.snow', pupil: 'deep.abyss', blink: false, ...(to ? { lookAt: 'target' } : {}), ...extra }),
];

async function raw(spec: ShotSpec, frame = 0): Promise<Buffer> {
  const c = compileShot(spec);
  return frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
}

/** The sum of the three channels of the pixel at a place of the stage (units, origin at the centre). */
function brightness(pixels: Buffer, x: number, y: number): number {
  const i = (Math.round(heightFor(WIDTH) / 2 + y * K) * WIDTH + Math.round(WIDTH / 2 + x * K)) * 4;
  return pixels[i]! + pixels[i + 1]! + pixels[i + 2]!;
}

const hash = async (spec: ShotSpec, frame = 0): Promise<string> => createHash('sha256').update(await raw(spec, frame)).digest('hex');

/** The white of the eye, its pupil and the night behind it, told apart by brightness. */
const isWhite = (v: number): boolean => v > 600;
const isDark = (v: number): boolean => v < 120;

test('eye reach: it is opt-in: an eye made without it has none, and an eye at rest is drawn alike with it or without it', async () => {
  const plain = eye({ id: 'e', r: 30, white: 'light.snow', pupil: 'deep.abyss' });
  assert.ok(!('reach' in plain), 'an eye without a reach carries none');
  assert.equal(eye({ id: 'e', r: 30, white: 'light.snow', pupil: 'deep.abyss', reach: 0.7 }).reach, 0.7);
  // A pupil that looks straight ahead lies wholly inside the white: clipping it to the white changes no pixel.
  assert.equal(await hash(make(big({ reach: 0.8 }))), await hash(make(big())));
  // The motion review does not measure pupils: an eye that reaches farther is judged as one that does not.
  const findings = async (spec: ShotSpec): Promise<string> => {
    const c = compileShot(spec);
    return JSON.stringify(reviewMotion(c, await bakeShot(c)).report.findings.map((f) => [f.kind, f.subject, f.channel, f.from, f.to]));
  };
  const swing: Key[] = [moveTo('target', { at: 0.3, to: [900, 300], dur: 1 })];
  assert.equal(await findings(make(big({ reach: 0.8 }, [-900, -300]), swing)), await findings(make(big({}, [-900, -300]), swing)));
});

test('eye reach: it is refused outside 0..0.8', () => {
  for (const reach of [0.81, -0.1, '0.5', Number.NaN]) {
    assert.throws(() => eye({ id: 'e', r: 30, white: 'light.snow', pupil: 'deep.abyss', reach: reach as number }), (e: unknown) => e instanceof SceneError && /reach must be a number in 0\.\.0\.8/.test(e.message));
  }
});

test('eye reach: the pupil goes farther, the white clips it, and its glint stays on it', async () => {
  // Looking right: without a reach the middle of the pupil goes about 0.4 of the radius (119 units), with 0.7 it goes 210.
  const plain = await raw(make(big({}, [1200, 0])));
  const far = await raw(make(big({ reach: 0.7 }, [1200, 0])));
  assert.ok(isDark(brightness(plain, 0, 0)) && isWhite(brightness(far, 0, 0)), 'the middle of the eye is pupil at the plain reach, white at the far one');
  assert.ok(isWhite(brightness(plain, 288, 0)) && isDark(brightness(far, 288, 0)), 'near the edge it is white at the plain reach, pupil at the far one');
  // Nothing of the pupil is drawn past the white: just outside it the night is as it is round an eye that looks ahead.
  const ahead = await raw(make(big()));
  for (const x of [312, 330]) assert.equal(brightness(far, x, 0), brightness(ahead, x, 0), `at ${x} units`);
  // Looking up with half-shut lids, the pupil stays inside the white the lids leave.
  const lidded = await raw(make(big({ reach: 0.8, open: 0.5 }, [0, -1200])));
  assert.ok(isDark(brightness(lidded, 0, -140)), 'the top of the lidded white is pupil');
  assert.equal(brightness(lidded, 0, -170), brightness(await raw(make(big({ open: 0.5 }))), 0, -170), 'and above it is the night');
  // Looking toward the light (top left), the glint stays where pupil lies between it and the white's edge.
  const d = Math.SQRT1_2;
  const toLight = await raw(make(big({ reach: 0.8 }, [-1200 * d, -1200 * d])));
  const along = (s: number): number => brightness(toLight, -s * d, -s * d);
  assert.ok(isDark(along(110)), 'pupil inside the glint');
  assert.ok(isWhite(along(222)), 'the glint, drawn in the white of the eye');
  assert.ok(isDark(along(288)), 'pupil between the glint and the edge of the white');
});
