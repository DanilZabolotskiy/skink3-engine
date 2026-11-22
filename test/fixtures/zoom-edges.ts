// A shot whose camera zooms in and out over curved, concave outlines that the light cuts into crescents, with a label
// and a boxed text: on the GPU a frame of it drawn soon after a frame of another zoom comes out with a few pixels of
// those edges otherwise than alone. The test of frames drawn alone draws it.

import { palette } from '../../examples/demo/palette.ts';
import { blob, cameraTo, label, layer, region, shot, text } from '../../src/index.ts';

export default shot({
  id: 'zoom-edges',
  seconds: 4,
  seed: 5,
  palette,
  strings: { en: { 'label.hill': 'A hill', 'text.title': 'Edges' } },
  background: { inner: 'dark.indigo', outer: 'deep.night' },
  atmosphere: 'mid.mist',
  camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
  layers: [
    layer({
      id: 'stage',
      depth: 0,
      nodes: [
        region({
          id: 'hill',
          fill: 'mid.mist',
          points: [
            [-900, 420],
            [-640, 120],
            [-420, 260],
            [-180, -40],
            [60, 220],
            [300, 20],
            [520, 300],
            [900, 120],
            [900, 540],
            [-900, 540],
          ],
        }),
        ...Array.from({ length: 6 }, (_, i) =>
          blob({ id: `b${i}`, fill: i % 2 ? 'accent.amber' : 'accent.aqua', at: [-620 + i * 250, -180 + (i % 3) * 120], r: 120 + (i % 3) * 40, points: 11, wobble: 0.2, seed: 11 + i }),
        ),
        label({ id: 'note', text: 'label.hill', target: 'b2', fill: 'light.cream', ink: 'deep.night', side: 'top' }),
        text({ id: 'title', text: 'text.title', ink: 'deep.night', box: 'light.cream', at: [-120, 60], size: 44 }),
      ],
    }),
  ],
  timeline: [cameraTo({ at: 1, zoom: 2.6, to: [-120, -60], dur: 1 }), cameraTo({ at: 2.5, zoom: 1 / 2.6, to: [0, 0], dur: 1 })],
});
