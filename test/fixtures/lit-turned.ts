// A shot of lit shapes turned on the stage under a drifting camera, near the frame in a blurred layer and on the stage:
// a card with a corner radius of no whole number of units, and a card with parts of its own, each at an opacity of
// its own. The light of a turned shape is drawn from paths the engine keeps from frame to frame; on the GPU such a
// frame came out otherwise after other frames than alone. The test of frames drawn alone draws it.

import { palette } from '../../examples/demo/palette.ts';
import { group, layer, rect, shot } from '../../src/index.ts';

/** A card, `w` wide; with `parts`, two bars and a box on it, each at an opacity of its own. */
const card = (id: string, w: number, rotation: number, parts: boolean) =>
  rect({
    id,
    w,
    h: w * 1.3,
    radius: w * 0.06,
    rotation,
    fill: 'light.cream',
    children: parts
      ? [
          rect({ id: `${id}-bar0`, at: [w * 0.08, -w * 0.3], w: w * 0.6, h: w * 0.06, radius: w * 0.024, fill: 'dark.haze', lit: false, opacity: 0.6 }),
          rect({ id: `${id}-bar1`, at: [w * 0.08, w * 0.05], w: w * 0.6, h: w * 0.06, radius: w * 0.024, fill: 'dark.haze', lit: false, opacity: 0.6 }),
          rect({ id: `${id}-box`, at: [-w * 0.3, -w * 0.3], w: w * 0.12, h: w * 0.12, radius: 1, fill: 'dark.haze', lit: false, opacity: 0.7 }),
        ]
      : [],
  });

export default shot({
  id: 'lit-turned',
  seconds: 6,
  seed: 3,
  palette,
  strings: { en: {} },
  background: { inner: 'dark.indigo', outer: 'deep.night' },
  atmosphere: 'mid.mist',
  layers: [
    layer({ id: 'stage', depth: 0, nodes: [group({ id: 'mid', at: [0, 60], idle: { amp: 4, period: 7 }, children: [card('mid-card', 260, 12, true)] })] }),
    layer({
      id: 'near',
      depth: -0.65,
      blur: 17,
      nodes: [
        group({ id: 'near-a', at: [-880, 470], idle: { amp: 6, period: 9 }, children: [card('near-card-a', 200, -18, true)] }),
        group({ id: 'near-b', at: [920, -470], idle: { amp: 5, period: 11 }, children: [card('near-card-b', 170, 24, false)] }),
      ],
    }),
  ],
});
