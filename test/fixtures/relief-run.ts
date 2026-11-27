// A still relief, drawn from its kept pixels on every frame after the second, under a layer with a small round dot.
// Before the pictures of a relief were freed with their frame, a run of a score of its frames filled the drawing
// library's store of canvas pixels, and from then on the dot's edge came out a level or two otherwise than in the
// frame drawn first. The test of a run of frames draws it.

import { palette } from '../../examples/demo/palette.ts';
import { circle, layer, relief, shot } from '../../src/index.ts';

const COLS = 119;
const ROWS = 74;
const values = Array.from({ length: COLS * ROWS }, (_, i) => {
  const x = i % COLS;
  const y = Math.floor(i / COLS);
  return 60 + 50 * Math.sin(x * 0.21) * Math.cos(y * 0.17) + 30 * Math.sin((x + y) * 0.09);
});

export default shot({
  id: 'relief-run',
  seconds: 1,
  seed: 3,
  palette,
  strings: { en: {} },
  background: { inner: 'dark.indigo', outer: 'deep.night' },
  atmosphere: 'mid.mist',
  camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
  layers: [
    layer({
      id: 'land',
      depth: 0,
      nodes: [relief({ id: 'hills', w: 2175, h: 1345.5, heights: { cols: COLS, rows: ROWS, values }, vertical: 0.46, sun: { from: -135, high: 45 }, amount: 0.42, dark: 'dark.indigo', bright: 'light.cream' })],
    }),
    layer({ id: 'near', depth: -0.6, blur: 0, nodes: [circle({ id: 'dot', at: [100.3, 50.7], r: 3.3, fill: 'accent.amber', lit: false })] }),
  ],
  timeline: [],
});
