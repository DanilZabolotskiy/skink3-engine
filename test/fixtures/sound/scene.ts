// A small shot that says something about its sound, for the tests of the
// command line: a node with a voice of its own, an intent that names its
// sound, an intent that is muted, and a sound placed by hand. The tests bring
// the bank: tones they synthesise themselves.

import { circle, layer, moveTo, popIn, rect, sfx, shot } from 'skink3-engine';
import { palette } from '../../../examples/demo/palette.ts';

export default shot({
  id: 'sound',
  seconds: 3,
  seed: 5,
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
        circle({ id: 'bell', at: [-500, -200], r: 60, fill: 'accent.amber', sound: 'bell' }),
        circle({ id: 'mover', at: [-600, 200], r: 40, fill: 'accent.aqua' }),
        circle({ id: 'quiet', at: [500, -200], r: 40, fill: 'accent.coral' }),
        rect({ id: 'ledge', at: [200, 300], w: 700, h: 60, radius: 10, fill: 'dark.indigo', body: { kind: 'fixed' } }),
        circle({ id: 'drop', at: [200, 0], r: 30, fill: 'accent.pink', sound: 'bell', body: { kind: 'dynamic', release: 0.2 } }),
      ],
    }),
  ],
  timeline: [
    popIn('bell', { at: 0.5 }),
    moveTo('mover', { at: 1, to: [0, 200], dur: 1, sound: 'whoosh' }),
    popIn('quiet', { at: 1.5, sound: false }),
    sfx('chime', { at: 2.5 }),
  ],
});
