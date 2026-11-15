// A small shot with planted defects, for the tests of the command line: both
// reviews have something to report here, which the demo shot must not have.
//
//   motion    "mover" starts at full speed (a move without ease-in);
//   physics   "inside" is released inside "host" (an overlap), and "roller"
//             rolls off the ledge and falls out of the picture (an escape).

import { circle, layer, moveTo, rect, shot } from 'skink3-engine';
import { palette } from '../../../examples/demo/palette.ts';

export default shot({
  id: 'defects',
  seconds: 4,
  seed: 3,
  palette,
  strings: { en: {} },
  background: { inner: 'deep.night', outer: 'deep.abyss' },
  atmosphere: 'mid.mist',
  vignette: 0,
  camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
  layers: [
    layer({
      id: 'stage',
      depth: 0,
      nodes: [
        circle({ id: 'mover', at: [-600, -300], r: 40, fill: 'accent.amber' }),
        rect({ id: 'ledge', at: [-200, 130], w: 700, h: 60, radius: 10, fill: 'dark.indigo', body: { kind: 'fixed' } }),
        circle({ id: 'roller', at: [-100, 80], r: 20, fill: 'accent.aqua', body: { kind: 'dynamic', release: 0.2, velocity: [300, 0] } }),
        circle({ id: 'host', at: [-400, 80], r: 20, fill: 'accent.pink', body: { kind: 'dynamic', release: 1 } }),
        circle({ id: 'inside', at: [-394, 78], r: 20, fill: 'accent.azure', body: { kind: 'dynamic', release: 1 } }),
      ],
    }),
  ],
  timeline: [moveTo('mover', { at: 1, to: [0, -300], dur: 1, anticipation: 0, overshoot: 0, arc: 0 })],
});
