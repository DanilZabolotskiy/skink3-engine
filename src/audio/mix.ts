// The sound track of a shot: its planned voices laid into two channels at
// 48 kHz, exactly as long as the shot. Every step is a pure function of its
// input, so the same scene, bank and seed give the same bytes.
//
// A voice starts on the first sample of its frame (a frame is 800 samples), or,
// when it is placed by its loudest point, that point lands on the first sample
// of the frame it is placed on. Its take is brought to 48 kHz and to its pitch
// in one resampling; it is panned by where its event is on screen, or its pan
// moves with its node; and it is cut, with a short fade, where the shot begins
// or ends.

import { readFileSync } from 'node:fs';
import { FPS } from '../core/time.ts';
import { BankError, type SoundBank } from './bank.ts';
import type { Voice } from './plan.ts';
import { readWav } from './wav.ts';

/** Samples per second of every track. */
export const SAMPLE_RATE = 48000;
/** Samples per frame of the picture: 800. */
export const SAMPLES_PER_FRAME = SAMPLE_RATE / FPS;

/** One take of a sound, decoded. A mono take has the same samples in both channels. */
export interface Take {
  readonly rate: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
}

/** The decoded takes of the sounds of a bank, by key. */
export type Takes = ReadonlyMap<string, readonly Take[]>;

/** Reads and decodes the takes of the given sounds of a bank. */
export function loadTakes(bank: SoundBank, keys: Iterable<string>): Map<string, Take[]> {
  const out = new Map<string, Take[]>();
  for (const key of new Set(keys)) {
    const sound = bank.sounds[key];
    if (!sound) throw new BankError(`the bank has no sound "${key}"`);
    out.set(
      key,
      sound.files.map((file): Take => {
        let bytes: Uint8Array;
        try {
          bytes = readFileSync(file);
        } catch {
          throw new BankError(`sound "${key}": the file ${file} cannot be read`);
        }
        const wav = readWav(bytes, file);
        const left = wav.channels[0]!;
        return { rate: wav.rate, left, right: wav.channels[1] ?? left };
      }),
    );
  }
  return out;
}

/** Seconds of a take over which its loudness is measured. */
const PEAK_WINDOW = 0.03;
/** A take is at its loudest while its level is within this of the top: 1 dB. */
const PEAK_LEVEL = 10 ** (-1 / 20);

/**
 * Seconds into a take, as recorded, of its loudest point: the middle of the
 * stretch around its loudest 30 ms in which it stays within 1 dB of them. A
 * swell has it at its top, a burst in its middle. 0 for silence.
 */
export function takePeak(take: Take): number {
  const n = take.left.length;
  if (n === 0) return 0;
  const stereo = take.right !== take.left;
  // Running sums of the squares, so that the energy of any window is one subtraction.
  const sums = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sums[i + 1] = sums[i]! + take.left[i]! * take.left[i]! + (stereo ? take.right[i]! * take.right[i]! : 0);
  const half = Math.max(1, Math.round((PEAK_WINDOW / 2) * take.rate));
  // A window that reaches past an end of the take holds silence there.
  const energy = (centre: number): number => sums[Math.min(n, centre + half)]! - sums[Math.max(0, centre - half)]!;
  const hop = Math.max(1, Math.round(take.rate / 1000));
  let top = 0;
  let best = -1;
  for (let c = 0; c < n; c += hop) {
    const e = energy(c);
    if (e > top) {
      top = e;
      best = c;
    }
  }
  if (best < 0) return 0;
  const floor = top * PEAK_LEVEL * PEAK_LEVEL;
  let from = best;
  let to = best;
  while (from - hop >= 0 && energy(from - hop) >= floor) from -= hop;
  while (to + hop < n && energy(to + hop) >= floor) to += hop;
  return (from + to) / 2 / take.rate;
}

/** The pan of a voice whose pan moves, at a moment given in frames: between two frames it goes in a straight line; before the first and after the last it stays. */
export function panAt(follow: { readonly frame: number; readonly pans: readonly number[] }, at: number): number {
  const p = at - follow.frame;
  const last = follow.pans.length - 1;
  if (p <= 0) return follow.pans[0]!;
  if (p >= last) return follow.pans[last]!;
  const i = Math.floor(p);
  return follow.pans[i]! + (follow.pans[i + 1]! - follow.pans[i]!) * (p - i);
}

/** Zero crossings of the resampling kernel on each side of its middle. */
const SINC_REACH = 8;

/** sinc under a Blackman window that reaches SINC_REACH zero crossings. */
function kernel(u: number): number {
  const a = Math.abs(u);
  if (a >= SINC_REACH) return 0;
  const sinc = a < 1e-9 ? 1 : Math.sin(Math.PI * a) / (Math.PI * a);
  const x = a / SINC_REACH;
  return sinc * (0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x));
}

/**
 * Reads a signal at every `step`-th of its samples: a step of 2 halves its
 * length and plays it an octave higher. Band-limited (a windowed sinc, with
 * its cut-off lowered when the step is above 1), so that a sound tuned up or
 * brought down to 48 kHz does not alias.
 */
export function resample(source: Float32Array, step: number): Float32Array {
  if (!(step > 0) || !Number.isFinite(step)) throw new Error(`resample: the step must be a positive number, got ${step}`);
  if (step === 1 || source.length === 0) return source.slice();
  const out = new Float32Array(Math.floor((source.length - 1) / step) + 1);
  const cutoff = Math.min(1, 1 / step);
  const reach = SINC_REACH / cutoff;
  for (let i = 0; i < out.length; i++) {
    const at = i * step;
    let sum = 0;
    let weight = 0;
    for (let k = Math.ceil(at - reach); k <= Math.floor(at + reach); k++) {
      const w = kernel((at - k) * cutoff);
      weight += w;
      // Beyond its ends the signal is silence.
      if (k >= 0 && k < source.length) sum += source[k]! * w;
    }
    out[i] = sum / weight;
  }
  return out;
}

/** Samples over which a voice that an end of the shot cuts is faded there: 10 ms. */
const CUT_FADE = SAMPLE_RATE / 100;

/**
 * Lays the voices into a stereo track of `frames` frames. Pan is of constant
 * power with the middle at the gain of the voice: a sound hard to one side is
 * 3 dB up there and silent on the other. A pan that moves is worked out for
 * every sample, so the power stays the same while it moves.
 */
export function mixVoices(voices: readonly Voice[], takes: Takes, frames: number): { left: Float64Array; right: Float64Array } {
  const total = frames * SAMPLES_PER_FRAME;
  const left = new Float64Array(total);
  const right = new Float64Array(total);
  for (const v of voices) {
    const take = takes.get(v.key)?.[v.take];
    if (!take) throw new Error(`the take ${v.take} of the sound "${v.key}" was not loaded`);
    const step = (take.rate / SAMPLE_RATE) * v.pitch;
    const l = resample(take.left, step);
    const r = take.right === take.left ? l : resample(take.right, step);
    // Where its first heard sample goes, and how much of the take is left out before it (a sound that would start before the shot).
    const start = Math.round(v.time * SAMPLE_RATE);
    const skip = Math.round(v.skip * SAMPLE_RATE);
    const n = Math.min(l.length - skip, total - start);
    const angle = ((v.pan + 1) * Math.PI) / 4;
    const gl = v.pan === 0 ? v.gain : v.gain * Math.cos(angle) * Math.SQRT2;
    const gr = v.pan === 0 ? v.gain : v.gain * Math.sin(angle) * Math.SQRT2;
    const cut = l.length - skip > n;
    for (let i = 0; i < n; i++) {
      let fade = cut && n - i <= CUT_FADE ? (n - i - 1) / CUT_FADE : 1;
      if (skip > 0 && i < CUT_FADE) fade *= (i + 1) / CUT_FADE;
      if (v.follow) {
        const turn = ((panAt(v.follow, (start + i) / SAMPLES_PER_FRAME) + 1) * Math.PI) / 4;
        left[start + i] = left[start + i]! + l[skip + i]! * v.gain * Math.cos(turn) * Math.SQRT2 * fade;
        right[start + i] = right[start + i]! + r[skip + i]! * v.gain * Math.sin(turn) * Math.SQRT2 * fade;
      } else {
        left[start + i] = left[start + i]! + l[skip + i]! * gl * fade;
        right[start + i] = right[start + i]! + r[skip + i]! * gr * fade;
      }
    }
  }
  return { left, right };
}
