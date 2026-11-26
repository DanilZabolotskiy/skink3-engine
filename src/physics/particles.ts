// Particles: emitters, forces and drag, simulated at the fixed step and stored
// per frame by the bake. Each emitter has its own random stream, so emitters do
// not disturb each other.

import { DEG, type Vec2 } from '../core/math.ts';
import { Noise } from '../core/noise.ts';
import { Rng } from '../core/rng.ts';
import { FPS, SIM_DT, SUBSTEPS } from '../core/time.ts';
import type { EmitterNode } from '../scene/types.ts';
import { PARTICLE_STRIDE, PARTICLE_TAIL_STRIDE, PARTICLE_VELOCITY_STRIDE, type ContactEvent } from './cache.ts';

/** Radius of a particle over its life (0..1): a quick swell, then a slow shrink to nothing. */
export function sizeOverLife(a: number): number {
  if (a <= 0 || a >= 1) return 0;
  const grow = a < 0.12 ? Math.sqrt(a / 0.12) : 1;
  const x = a < 0.5 ? 0 : (a - 0.5) / 0.5;
  return grow * (1 - x * x * (3 - 2 * x));
}

/** Share of its life a steady particle takes to swell at the start and to shrink at the end. */
export const STEADY_EDGE = 0.08;

/**
 * Radius of a steady particle over its life (0..1): full size for nearly all
 * of it, with a short swell and a short shrink at the ends. For particles that
 * carry something across the frame: a stream, a drift of motes.
 */
export function steadySizeOverLife(a: number): number {
  if (a <= 0 || a >= 1) return 0;
  const edge = Math.min(a, 1 - a) / STEADY_EDGE;
  if (edge >= 1) return 1;
  return edge * edge * (3 - 2 * edge);
}

/**
 * Radius of a growing particle over its life (0..1): a quick swell to nearly half its size, then on, evenly, to its
 * full size at its death. It never shrinks: a growing particle fades away instead (its `fade` ends at 0).
 */
export function growSizeOverLife(a: number): number {
  if (a <= 0 || a >= 1) return 0;
  const swell = a < 0.12 ? Math.sqrt(a / 0.12) : 1;
  return swell * (0.4 + 0.6 * a);
}

/** The opacity of a particle with a fade at a share `a` of its life: from `birth` to `death`, evenly. */
export function fadeOverLife(fade: readonly [number, number], a: number): number {
  return fade[0] + (fade[1] - fade[0]) * Math.min(1, Math.max(0, a));
}

/** A particle fainter than this is not stored: it adds nothing to the picture. */
export const FAINTEST_PARTICLE = 1 / 512;

export interface EmitterResult {
  /** frames + 1 offsets (in particles) into `data`. */
  readonly index: Uint32Array;
  /** x, y, radius, colour index per particle. */
  readonly data: Float32Array;
  /** vx, vy per particle in units per second, in the order of `data`. Nothing is drawn from it; the motion review reads it. */
  readonly velocity: Float32Array;
  /**
   * An emitter with a streak: per particle, in the order of `data`, where its streak ends, as dx, dy in units from
   * the particle. null for an emitter of round particles.
   */
  readonly tails: Float32Array | null;
  /** An emitter with a fade: the opacity of every particle, in the order of `data`. null for an emitter of opaque particles. */
  readonly alphas: Float32Array | null;
}

/**
 * Simulates one emitter for the whole shot.
 * `positionAt(frame)` gives the emitter's place at a frame (it may ride on a node). `rateAt(seconds)`, for an
 * emitter whose rate is keyed (rateTo), gives its rate at a moment; without it the emitter keeps its `rate`.
 */
export function simulateEmitter(
  spec: EmitterNode,
  frames: number,
  seed: number,
  positionAt: (frame: number) => Vec2,
  contacts: readonly ContactEvent[],
  rateAt: ((seconds: number) => number) | null = null,
): EmitterResult {
  const rng = new Rng(seed, `particles/${spec.id}`);
  const field = spec.turbulence ? new Noise(seed, `turbulence/${spec.id}`) : null;
  const nColors = spec.colors.length;
  const steady = spec.sizing === 'steady';
  const grow = spec.sizing === 'grow';
  const sizeOf = (a: number): number => (steady ? steadySizeOverLife(a) : grow ? growSizeOverLife(a) : sizeOverLife(a));
  // A fade gives every particle an opacity of its own; without one they are opaque, and nothing more is stored.
  const fade = spec.fade ?? null;
  // A streak is the way of the last `streak` seconds, along the velocity, and never longer than the way since birth.
  const streak = spec.streak ?? 0;

  // Structure of arrays; dead particles are compacted in birth order.
  const px: number[] = [];
  const py: number[] = [];
  const vx: number[] = [];
  const vy: number[] = [];
  const age: number[] = [];
  const life: number[] = [];
  const size: number[] = [];
  const colour: number[] = [];

  const spawn = (at: Vec2, boost: number): void => {
    const a = (spec.direction + (rng.next() - 0.5) * spec.spread) * DEG;
    const speed = rng.range(spec.speed[0], spec.speed[1]) * boost;
    px.push(at[0] + (rng.next() - 0.5) * spec.area[0]);
    py.push(at[1] + (rng.next() - 0.5) * spec.area[1]);
    vx.push(Math.cos(a) * speed);
    vy.push(Math.sin(a) * speed);
    age.push(0);
    life.push(rng.range(spec.life[0], spec.life[1]));
    size.push(rng.range(spec.size[0], spec.size[1]));
    colour.push(Math.min(nColors - 1, Math.floor(rng.next() * nColors)));
  };

  let carry = 0;
  const step = (time: number, at: Vec2): void => {
    // Emit. Before the shot starts (prewarm) the emitter runs as it does at its
    // first moment, so that the field is already populated at frame 0.
    const emitting = time < 0 ? spec.from <= 1e-9 : time >= spec.from - 1e-9 && time < spec.until;
    // A keyed rate runs before the shot as it is at its first moment, as everything of the emitter does.
    const rate = rateAt ? Math.max(0, rateAt(Math.max(0, time))) : spec.rate;
    if (rate > 0 && emitting) {
      carry += rate * SIM_DT;
      while (carry >= 1) {
        carry -= 1;
        spawn(at, 1);
      }
    }
    for (const b of spec.bursts) {
      if (b.at >= time - 1e-9 && b.at < time + SIM_DT - 1e-9) for (let i = 0; i < b.count; i++) spawn(at, 1);
    }
    // Integrate.
    const damp = Math.exp(-spec.drag * SIM_DT);
    const n = px.length;
    let alive = 0;
    for (let i = 0; i < n; i++) {
      const a = age[i]! + SIM_DT;
      if (a >= life[i]!) continue;
      let ax = spec.gravity[0];
      let ay = spec.gravity[1];
      if (field && spec.turbulence) {
        const s = spec.turbulence.scale;
        const w = time * spec.turbulence.speed;
        ax += spec.turbulence.strength * field.n2(px[i]! / s + w, py[i]! / s);
        ay += spec.turbulence.strength * field.n2(px[i]! / s + 91.7, py[i]! / s + w + 47.3);
      }
      const nvx = (vx[i]! + ax * SIM_DT) * damp;
      const nvy = (vy[i]! + ay * SIM_DT) * damp;
      px[alive] = px[i]! + nvx * SIM_DT;
      py[alive] = py[i]! + nvy * SIM_DT;
      vx[alive] = nvx;
      vy[alive] = nvy;
      age[alive] = a;
      life[alive] = life[i]!;
      size[alive] = size[i]!;
      colour[alive] = colour[i]!;
      alive++;
    }
    px.length = py.length = vx.length = vy.length = age.length = life.length = size.length = colour.length = alive;
  };

  // Prewarm with the emitter where it is at frame 0.
  if (spec.prewarm > 0) {
    const at0 = positionAt(0);
    const steps = Math.round(spec.prewarm * FPS * SUBSTEPS);
    for (let s = steps; s > 0; s--) step(-s * SIM_DT, at0);
  }

  const contactsByFrame = new Map<number, ContactEvent[]>();
  if (spec.onContact) {
    for (const ev of contacts) {
      if (ev.impulse < spec.onContact.minImpulse) continue;
      const list = contactsByFrame.get(ev.frame);
      if (list) list.push(ev);
      else contactsByFrame.set(ev.frame, [ev]);
    }
  }

  const index = new Uint32Array(frames + 1);
  const chunks: Float32Array[] = [];
  const velocityChunks: Float32Array[] = [];
  const tailChunks: Float32Array[] = [];
  const alphaChunks: Float32Array[] = [];
  let total = 0;
  for (let f = 0; f < frames; f++) {
    // Record the state at the start of the frame.
    const n = px.length;
    const rec = new Float32Array(n * PARTICLE_STRIDE);
    const vel = new Float32Array(n * PARTICLE_VELOCITY_STRIDE);
    const tail = streak > 0 ? new Float32Array(n * PARTICLE_TAIL_STRIDE) : null;
    const alpha = fade ? new Float32Array(n) : null;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const r = size[i]! * sizeOf(age[i]! / life[i]!);
      if (r <= 0.05) continue;
      if (alpha) {
        const o = fadeOverLife(fade!, age[i]! / life[i]!);
        if (o < FAINTEST_PARTICLE) continue;
        alpha[m] = o;
      }
      rec[m * PARTICLE_STRIDE] = px[i]!;
      rec[m * PARTICLE_STRIDE + 1] = py[i]!;
      rec[m * PARTICLE_STRIDE + 2] = r;
      rec[m * PARTICLE_STRIDE + 3] = colour[i]!;
      vel[m * PARTICLE_VELOCITY_STRIDE] = vx[i]!;
      vel[m * PARTICLE_VELOCITY_STRIDE + 1] = vy[i]!;
      if (tail) {
        const back = Math.min(streak, age[i]!);
        tail[m * PARTICLE_TAIL_STRIDE] = -vx[i]! * back;
        tail[m * PARTICLE_TAIL_STRIDE + 1] = -vy[i]! * back;
      }
      m++;
    }
    chunks.push(rec.subarray(0, m * PARTICLE_STRIDE));
    velocityChunks.push(vel.subarray(0, m * PARTICLE_VELOCITY_STRIDE));
    if (tail) tailChunks.push(tail.subarray(0, m * PARTICLE_TAIL_STRIDE));
    if (alpha) alphaChunks.push(alpha.subarray(0, m));
    index[f] = total;
    total += m;

    const at = positionAt(f);
    const hits = contactsByFrame.get(f);
    if (hits && spec.onContact) {
      for (const ev of hits) {
        const boost = Math.min(2.2, Math.sqrt(ev.impulse / Math.max(spec.onContact.minImpulse, 1e-6)));
        for (let i = 0; i < spec.onContact.count; i++) spawn([ev.x, ev.y], boost);
      }
    }
    for (let k = 0; k < SUBSTEPS; k++) step((f * SUBSTEPS + k) * SIM_DT, at);
  }
  index[frames] = total;

  const data = new Float32Array(total * PARTICLE_STRIDE);
  const velocity = new Float32Array(total * PARTICLE_VELOCITY_STRIDE);
  let o = 0;
  for (const c of chunks) {
    data.set(c, o);
    o += c.length;
  }
  o = 0;
  for (const c of velocityChunks) {
    velocity.set(c, o);
    o += c.length;
  }
  let alphas: Float32Array | null = null;
  if (fade) {
    alphas = new Float32Array(total);
    o = 0;
    for (const c of alphaChunks) {
      alphas.set(c, o);
      o += c.length;
    }
  }
  if (streak <= 0) return { index, data, velocity, tails: null, alphas };
  const tails = new Float32Array(total * PARTICLE_TAIL_STRIDE);
  o = 0;
  for (const c of tailChunks) {
    tails.set(c, o);
    o += c.length;
  }
  return { index, data, velocity, tails, alphas };
}
