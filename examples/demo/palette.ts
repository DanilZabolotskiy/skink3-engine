// The demo palette: the colour scheme of the examples. Colours are given as
// hue, saturation and value so that the construction stays visible.
//
// The engine has no rule about colour. The `rules` below are this palette's
// own: what the examples promise about their colours, held by `skink3 check`.
// A palette without `rules` is not checked for anything.

import { definePalette, hsv } from 'skink3-engine';

export const palette = definePalette({
  deep: {
    abyss: hsv(238, 0.9, 0.12),
    night: hsv(262, 0.86, 0.23),
    ink: hsv(246, 0.84, 0.17),
  },
  dark: {
    indigo: hsv(258, 0.8, 0.5),
    plum: hsv(284, 0.78, 0.44),
    navy: hsv(230, 0.74, 0.46),
    haze: hsv(246, 0.6, 0.52),
  },
  mid: {
    violet: hsv(266, 0.68, 0.84),
    rose: hsv(324, 0.72, 0.76),
    ocean: hsv(214, 0.7, 0.8),
    jade: hsv(166, 0.64, 0.6),
    mist: hsv(250, 0.46, 0.74),
  },
  accent: {
    amber: hsv(40, 0.86, 0.99),
    aqua: hsv(176, 0.72, 0.93),
    coral: hsv(8, 0.72, 0.95),
    azure: hsv(204, 0.8, 0.95),
    pink: hsv(326, 0.7, 0.96),
  },
  light: {
    cream: hsv(52, 0.34, 0.99),
    mint: hsv(158, 0.22, 0.98),
    snow: hsv(222, 0.06, 0.99),
  },
  pairs: [
    ['amber', 'aqua'],
    ['coral', 'azure'],
  ],
  rules: [
    { name: 'deep is the darkest', roles: ['deep'], lightness: [0, 12] },
    { name: 'dark stays dark', roles: ['dark'], lightness: [12, 30] },
    { name: 'mid lies between', roles: ['mid'], lightness: [30, 60] },
    { name: 'light is light', roles: ['light'], lightness: [85, 100] },
    { name: 'no gray in the dark', roles: ['deep', 'dark'], saturation: [0.5, 1] },
    { name: 'accents are vivid', roles: ['accent'], saturation: [0.6, 1] },
    { name: 'accents are bright', roles: ['accent'], value: [0.7, 1] },
    { name: 'a warm accent with a cool one', pairs: { atLeast: 1, first: [330, 75], second: [150, 270], apart: 90 } },
  ],
});
