// The sound track of a shot: its planned voices laid into two channels at
// 48 kHz, exactly as long as the shot. Every step is a pure function of its
// input, so the same scene, bank and seed give the same bytes.
//
// A voice starts on the first sample of its frame (a frame is 800 samples). Its
// take is brought to 48 kHz and to its pitch in one resampling; it is panned
// by where its event is on screen, and cut, with a short fade, where the shot
// ends.

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

/** Samples over which a voice that the end of the shot cuts is faded out: 10 ms. */
const CUT_FADE = SAMPLE_RATE / 100;

/**
 * Lays the voices into a stereo track of `frames` frames. Pan is of constant
 * power with the middle at the gain of the voice: a sound hard to one side is
 * 3 dB up there and silent on the other.
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
    const start = v.frame * SAMPLES_PER_FRAME;
    const n = Math.min(l.length, total - start);
    const angle = ((v.pan + 1) * Math.PI) / 4;
    const gl = v.pan === 0 ? v.gain : v.gain * Math.cos(angle) * Math.SQRT2;
    const gr = v.pan === 0 ? v.gain : v.gain * Math.sin(angle) * Math.SQRT2;
    const cut = l.length > n;
    for (let i = 0; i < n; i++) {
      const fade = cut && n - i <= CUT_FADE ? (n - i - 1) / CUT_FADE : 1;
      left[start + i] = left[start + i]! + l[i]! * gl * fade;
      right[start + i] = right[start + i]! + r[i]! * gr * fade;
    }
  }
  return { left, right };
}
