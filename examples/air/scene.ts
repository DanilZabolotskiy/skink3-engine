// Air that moves the picture, and particles drawn along their way: a heat haze
// over a hot plate, with a lamp in front of it that stays steady, and rain
// drawn as streaks. Run it from the repository root:
//
//   node bin/skink3.mjs check examples/air/scene.ts
//   node bin/skink3.mjs still examples/air/scene.ts --time 3
//   node bin/skink3.mjs strip examples/air/scene.ts --from 150 --count 6 --step 2 --crop 900,140,960,560

import { circle, definePalette, emitter, hazeTo, hsv, layer, popIn, rect, region, shot } from 'skink3-engine';

const palette = definePalette({
  deep: { night: hsv(232, 0.7, 0.22), abyss: hsv(236, 0.82, 0.12) },
  dark: { indigo: hsv(250, 0.62, 0.42), slate: hsv(228, 0.4, 0.3) },
  mid: { mist: hsv(214, 0.32, 0.78), violet: hsv(262, 0.5, 0.66) },
  accent: { amber: hsv(32, 0.88, 0.99), coral: hsv(10, 0.72, 0.96) },
  light: { cream: hsv(48, 0.3, 0.99) },
});

/** A row of blocks far away: what the haze moves. */
const towers = [-860, -640, -420, -200, 20, 240, 460, 680, 900].map((x, i) =>
  rect({ id: `tower-${i}`, at: [x, 160 - (i % 3) * 70], w: 150, h: 520 + (i % 3) * 140, radius: 10, fill: i % 2 === 0 ? 'dark.indigo' : 'dark.slate' }),
);

export default shot({
  id: 'air',
  seconds: 6,
  seed: 3,
  palette,
  strings: { en: {} },
  background: { inner: 'deep.night', outer: 'deep.abyss' },
  atmosphere: 'mid.mist',
  layers: [
    layer({
      id: 'far',
      depth: 0.6,
      nodes: [
        region({ id: 'hills', points: [[-1100, 320], [-700, 120], [-300, 260], [100, 90], [500, 230], [1100, 80], [1100, 600], [-1100, 600]], fill: 'dark.slate', lit: false }),
        ...towers,
      ],
    }),
    layer({
      id: 'stage',
      depth: 0,
      nodes: [
        rect({ id: 'ground', at: [0, 470], w: 2200, h: 260, radius: 0, fill: 'deep.night', lit: false, backdrop: true }),
        rect({ id: 'plate', at: [430, 350], w: 760, h: 40, radius: 12, fill: 'accent.coral', glow: 0.5 }),
        // The haze: an invisible area over the plate, soft at its edge; it moves what is drawn before it.
        rect({ id: 'shimmer', at: [430, 60], w: 820, h: 560, opacity: 0, fill: 'accent.amber', soft: 70, haze: { amount: 1.5, scale: 34, speed: 46 } }),
        // Drawn after the haze, so it stays steady in front of the air that moves.
        circle({ id: 'lamp', at: [430, -40], r: 34, fill: 'accent.amber', glow: 0.8 }),
        emitter({
          id: 'rain', at: [-520, -620], area: [1000, 10], rate: 240, life: 1.6, size: [1.4, 2.2], speed: [950, 1150],
          direction: 100, spread: 3, drag: 0, colors: ['mid.mist'], sizing: 'steady', prewarm: 2, streak: 0.045,
        }),
      ],
    }),
  ],
  timeline: [popIn('lamp', { at: 0.4 }), hazeTo('shimmer', { at: 1, to: 6, dur: 2.5 })],
});
