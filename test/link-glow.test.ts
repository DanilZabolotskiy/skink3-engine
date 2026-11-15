import assert from 'node:assert/strict';
import { test } from 'node:test';
import { palette } from '../examples/demo/palette.ts';
import { bakeShot, compileShot, frameRaw, group, heightFor, layer, link, shot } from '../src/index.ts';

const WIDTH = 480;

/** A straight horizontal link through the middle of the frame, with the given glow. */
function line(glow?: number): ReturnType<typeof shot> {
  return shot({
    id: 'tiny',
    seconds: 1,
    seed: 1,
    palette,
    strings: { en: { 'label.a': 'A' } },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [
      layer({
        id: 'stage',
        depth: 0,
        nodes: [
          link({ id: 'l', from: 'a', to: 'b', color: 'accent.pink', bend: 0, width: 8, gap: 0, ...(glow === undefined ? {} : { glow }) }),
          group({ id: 'a', at: [-400, 0] }),
          group({ id: 'b', at: [400, 0] }),
        ],
      }),
    ],
  });
}

/** Brightness (the largest channel) of the pixel `dy` stage units below the middle of the frame. */
async function below(spec: ReturnType<typeof shot>, dy: number): Promise<number> {
  const c = compileShot(spec);
  const raw = await frameRaw(c, await bakeShot(c), 0, { width: WIDTH, lang: 'en', gpu: false });
  const y = Math.round(heightFor(WIDTH) / 2 + dy * (WIDTH / 1920));
  const o = (y * WIDTH + WIDTH / 2) * 4;
  return Math.max(raw[o]!, raw[o + 1]!, raw[o + 2]!);
}

test('link glow: the line itself gets a halo; without it the picture is as before', async () => {
  // On the line the colour is the same with and without the glow.
  assert.ok(Math.abs((await below(line(1), 0)) - (await below(line(), 0))) <= 12);
  // Beside the line, where there is only background, the glow lifts the picture, more the stronger it is.
  const dark = await below(line(), 10);
  const half = await below(line(0.5), 10);
  const full = await below(line(1), 10);
  assert.ok(half > dark + 4, `half glow ${half} against none ${dark}`);
  assert.ok(full > half + 4, `full glow ${full} against half ${half}`);
  // Far from the line nothing changes.
  assert.equal(await below(line(1), 300), await below(line(), 300));
  // The default is no glow.
  assert.equal(await below(line(0), 10), dark);
  assert.throws(() => link({ id: 'l', from: 'a', to: 'b', color: 'accent.pink', glow: 2 }), /glow must be a number in 0\.\.1/);
});
