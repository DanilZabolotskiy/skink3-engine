// Seeded gradient noise in one and two dimensions. Output is in [-1, 1] and is a
// pure function of (seed, name, coordinates).

import { Rng } from './rng.ts';

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

const GRAD2: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2],
];

export class Noise {
  private readonly perm = new Uint8Array(512);
  private readonly grad1 = new Float64Array(256);

  constructor(seed: number | string, name = 'noise') {
    const rng = new Rng(seed, name);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const tmp = p[i]!;
      p[i] = p[j]!;
      p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!;
    for (let i = 0; i < 256; i++) this.grad1[i] = rng.range(-1, 1);
  }

  /** 1D gradient noise, roughly one feature per unit of x. */
  n1(x: number): number {
    const i0 = Math.floor(x);
    const t = x - i0;
    const g0 = this.grad1[this.perm[i0 & 255]!]!;
    const g1 = this.grad1[this.perm[(i0 + 1) & 255]!]!;
    const v = g0 * t + (g1 * (t - 1) - g0 * t) * fade(t);
    return Math.max(-1, Math.min(1, v * 2));
  }

  /** 2D gradient noise. */
  n2(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = x - xi;
    const ty = y - yi;
    const p = this.perm;
    const X = xi & 255;
    const Y = yi & 255;
    const g00 = GRAD2[p[p[X]! + Y]! & 7]!;
    const g10 = GRAD2[p[p[X + 1]! + Y]! & 7]!;
    const g01 = GRAD2[p[p[X]! + Y + 1]! & 7]!;
    const g11 = GRAD2[p[p[X + 1]! + Y + 1]! & 7]!;
    const d00 = g00[0] * tx + g00[1] * ty;
    const d10 = g10[0] * (tx - 1) + g10[1] * ty;
    const d01 = g01[0] * tx + g01[1] * (ty - 1);
    const d11 = g11[0] * (tx - 1) + g11[1] * (ty - 1);
    const u = fade(tx);
    const v = fade(ty);
    const a = d00 + (d10 - d00) * u;
    const b = d01 + (d11 - d01) * u;
    return Math.max(-1, Math.min(1, (a + (b - a) * v) * Math.SQRT2));
  }

  /** Fractal sum of 1D noise, normalised back to about [-1, 1]. */
  fbm1(x: number, octaves = 3): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += this.n1(x * f + o * 31.7) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  }
}
