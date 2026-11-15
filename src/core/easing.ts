// Easing curves on [0, 1] -> [0, 1] (a few overshoot on purpose).

export type EaseName =
  | 'linear'
  | 'inQuad' | 'outQuad' | 'inOutQuad'
  | 'inCubic' | 'outCubic' | 'inOutCubic'
  | 'inOutSine'
  | 'outExpo'
  | 'inBack' | 'outBack';

const BACK = 1.70158;

export const EASINGS: Readonly<Record<EaseName, (t: number) => number>> = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - 4 * (1 - t) ** 3),
  inOutSine: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),
  outExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  inBack: (t) => (BACK + 1) * t * t * t - BACK * t * t,
  outBack: (t) => 1 + (BACK + 1) * (t - 1) ** 3 + BACK * (t - 1) ** 2,
};

/** Evaluates a named easing; the input is clamped to [0, 1]. */
export function ease(name: EaseName, t: number): number {
  return EASINGS[name](t < 0 ? 0 : t > 1 ? 1 : t);
}
