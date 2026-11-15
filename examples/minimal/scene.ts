// The smallest useful shot: one lit shape that pops in, moves and gets a label.
// Run it from the repository root:
//
//   node bin/skink3.mjs check examples/minimal/scene.ts
//   node bin/skink3.mjs still examples/minimal/scene.ts --time 2.5

import { circle, definePalette, hsv, label, layer, moveTo, popIn, shot } from 'skink3-engine';

const palette = definePalette({
  deep: { night: hsv(250, 0.88, 0.2), abyss: hsv(240, 0.9, 0.11) },
  dark: { indigo: hsv(258, 0.8, 0.5) },
  mid: { violet: hsv(266, 0.68, 0.84), mist: hsv(250, 0.46, 0.74) },
  accent: { amber: hsv(40, 0.86, 0.99), aqua: hsv(176, 0.72, 0.93) },
  light: { cream: hsv(52, 0.34, 0.99) },
  pairs: [['amber', 'aqua']],
});

export default shot({
  id: 'minimal',
  seconds: 4,
  seed: 1,
  palette,
  strings: {
    en: { 'label.dot': 'A dot' },
  },
  background: { inner: 'deep.night', outer: 'deep.abyss' },
  atmosphere: 'mid.mist',
  layers: [
    layer({
      id: 'stage',
      depth: 0,
      nodes: [
        circle({ id: 'dot', at: [-300, 60], r: 90, fill: 'accent.aqua' }),
        label({ id: 'dot-label', text: 'label.dot', target: 'dot', fill: 'light.cream', ink: 'deep.night' }),
      ],
    }),
  ],
  timeline: [
    popIn('dot', { at: 0.3 }),
    moveTo('dot', { at: 1.2, to: [260, -40] }),
    popIn('dot-label', { at: 2.4 }),
  ],
});
