// Small lit shapes under a camera that pushes in: capsules turned upright, circles and rounded cards, each with a rim
// light. The crescents of their light are paths of ten segments or fewer, which the drawing library keeps by their
// points rather than by their objects; on the GPU a frame of it drawn after a frame of another zoom came out with a
// few pixels of those crescents otherwise than alone. The test of frames drawn alone draws it.

import { palette } from '../../examples/demo/palette.ts';
import { capsule, circle, layer, rect, shot } from '../../src/index.ts';

export default shot({
  id: 'small-lit',
  seconds: 4,
  seed: 7,
  palette,
  strings: { en: {} },
  light: { from: 'top-left' },
  background: { inner: 'dark.indigo', outer: 'deep.night' },
  atmosphere: 'mid.mist',
  camera: { at: [-40, 0], drift: { speed: 0.15, heading: 0, wander: 0 }, pushIn: { from: 0.8, to: 1.25 } },
  layers: [
    layer({
      id: 'stage',
      depth: 0,
      nodes: [
        ...Array.from({ length: 5 }, (_, i) =>
          capsule({ id: `post${i}`, at: [-560 + i * 280, -120], length: 300 + i * 40, r: 9 + i * 3, rotation: 90, fill: 'accent.amber', lit: true, rimLight: 'accent.aqua' }),
        ),
        ...Array.from({ length: 5 }, (_, i) => circle({ id: `dot${i}`, at: [-560 + i * 280, 200], r: 14 + i * 9, fill: 'accent.aqua', lit: true, rimLight: 'accent.amber' })),
        ...Array.from({ length: 5 }, (_, i) => rect({ id: `card${i}`, at: [-560 + i * 280, 380], w: 60 + i * 30, h: 30 + i * 12, radius: 6 + i * 2, rotation: 8 * i, fill: 'light.cream', lit: true, rimLight: 'accent.aqua' })),
      ],
    }),
  ],
});
