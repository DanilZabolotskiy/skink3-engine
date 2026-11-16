// A bank of sounds: what a production gives the engine to voice its shots with.
// The engine holds no sound files. A bank is a JSON file next to its sounds:
//
//   {
//     "about":  "any note",
//     "gain":   1,
//     "sounds": { "<key>": { "file": "pop.wav", "gain": 0.8, "pitchJitter": 0.5, "gainJitter": 0.1, "priority": 0, "rules": { ... } }, ... },
//     "kinds":  { "appear": "pop", "contact": "tick", "move": null, ... },
//     "curves": { "size": [[24, 0.5], [320, 1]], "speed": [[4, 0.6], [40, 1]], "impulse": [[0.25, 0.4], [2, 1]] },
//     "rules":  { "gap": 0.5, "starts": 4, "startsWindow": 10, ... }
//   }
//
// Only "sounds" is required. A file is a path relative to the bank, a PCM WAV
// (see wav.ts); a list of files is a set of takes of one sound, and each use
// picks one by the seed. "kinds" says what a kind of event sounds like when
// nothing else decides; a kind that is left out, or set to null, is silent.
// "curves" turn the size, the speed and the impulse of an event into gain;
// "rules" keep a film from being crowded with sound. Curves and rules have
// defaults here, chosen to be quiet rather than busy. A sound may set rules
// for its own events ("rules" inside the sound): that is how a pour of many
// small things is heard as a shower of impacts, apart from the accents.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isSoundKey } from '../motion/intents.ts';
import { EVENT_KINDS, type EventKind } from './events.ts';

export class BankError extends Error {}

/** Gain against a measurement: points [x, gain] in order of x, joined by straight lines and held flat beyond the ends. */
export type Curve = readonly (readonly [number, number])[];

/**
 * Rules a sound sets for its own events, in place of the rules of the bank. A
 * sound that has any is thinned by itself: its events are merged, spaced and
 * counted among themselves, apart from the other events of their kind.
 */
export interface SoundOwnRules {
  /** The thresholds, for its events. */
  readonly minSize?: number;
  readonly minSpeed?: number;
  readonly minImpulse?: number;
  /** Among its events: the window in which they sound as one, the least gap between two of them, and the crowd. */
  readonly mergeWindow?: number;
  readonly kindGap?: number;
  readonly crowdVoices?: number;
  readonly crowdWindow?: number;
  /** Its own cap: at most `starts` of its sounds start within any `startsWindow` seconds (the window of the bank when it names none). */
  readonly starts?: number;
  readonly startsWindow?: number;
  /** At most this many of its sounds are heard at once. */
  readonly voices?: number;
  /**
   * True: its starts stand apart from the limits of the whole track. They are
   * not held to the bank's `gap`, `starts` and `voices`, and they do not count
   * toward them: a shower does not take the place of the accents. Its own
   * `starts` and `voices` are then all that caps it.
   */
  readonly apart?: boolean;
}

export interface BankSound {
  /** The takes of the sound: absolute paths of PCM WAV files. */
  readonly files: readonly string[];
  /** Gain of the sound, 1 = as recorded. */
  readonly gain: number;
  /** Each use is tuned up or down by at most this many semitones, by the seed. */
  readonly pitchJitter: number;
  /** Each use is louder or softer by at most this share of its gain, by the seed. */
  readonly gainJitter: number;
  /** When a rule has to drop some events, those of a sound with a higher priority keep theirs. 0 unless the bank says otherwise. */
  readonly priority: number;
  /** Rules of its own for its events, or null: the rules of the bank. */
  readonly rules: SoundOwnRules | null;
}

/** The rules that keep a shot from being crowded with sound. */
export interface SoundRules {
  /** A thing smaller than this on screen is silent (px of a 1080p frame). */
  readonly minSize: number;
  /** A move or a landing slower than this at its peak is silent (px per frame). */
  readonly minSpeed: number;
  /** A contact weaker than this is silent, and so is the burst it sets off (impulse as the bake records it). */
  readonly minImpulse: number;
  /** Events of one kind within this many seconds sound as one. */
  readonly mergeWindow: number;
  /** Least time between two sounds of one kind, in seconds; `kindGaps` sets it for single kinds. */
  readonly kindGap: number;
  readonly kindGaps: Readonly<Partial<Record<EventKind, number>>>;
  /** A crowd: at most `crowdVoices` sounds of one kind start within any `crowdWindow` seconds. */
  readonly crowdWindow: number;
  readonly crowdVoices: number;
  /** Least time between any two starts, whatever their kinds, in seconds. */
  readonly gap: number;
  /** At most `starts` sounds start within any `startsWindow` seconds, whatever their kinds. */
  readonly starts: number;
  readonly startsWindow: number;
  /** At most this many sounds are heard at once. */
  readonly voices: number;
  /**
   * Kinds of events from the one that matters most to the one that matters
   * least: when a rule has to drop some events, those of an earlier kind keep
   * their sound. A bank names the kinds it wants first; the rest follow in
   * the order of the default.
   */
  readonly priority: readonly EventKind[];
  /** How far to a side a sound at the edge of the frame is panned: 0 keeps everything in the middle, 1 puts it hard left or right. */
  readonly pan: number;
}

/** The defaults of the rules: few sounds rather than many. A bank changes the ones it names. */
export const SOUND_RULES: SoundRules = {
  minSize: 24,
  minSpeed: 4,
  minImpulse: 0.25,
  mergeWindow: 0.08,
  kindGap: 1,
  kindGaps: {},
  crowdWindow: 5,
  crowdVoices: 2,
  gap: 0.5,
  starts: 4,
  startsWindow: 10,
  voices: 3,
  // What hits and what arrives first, then what changes, then what merely moves.
  priority: ['land', 'contact', 'appear', 'disappear', 'label', 'connect', 'pulse', 'burst', 'grow', 'shrink', 'level', 'squash', 'bump', 'draw', 'move', 'turn', 'fade', 'open', 'blink', 'sfx'],
  pan: 0.6,
};

export interface SoundCurves {
  /** Against the size of the thing on screen, px: for every event but a placed sound. */
  readonly size: Curve;
  /** Against the peak speed, px per frame: for moves and landings. */
  readonly speed: Curve;
  /** Against the impulse: for contacts and the bursts they set off. */
  readonly impulse: Curve;
}

/** The defaults of the curves: a small, slow or weak event is softer, never louder than the sound's own gain. */
export const SOUND_CURVES: SoundCurves = {
  size: [
    [24, 0.5],
    [320, 1],
  ],
  speed: [
    [4, 0.6],
    [40, 1],
  ],
  impulse: [
    [0.25, 0.4],
    [2, 1],
  ],
};

export interface SoundBank {
  /** The folder the files of the bank are relative to. */
  readonly dir: string;
  /** Gain of the whole track. */
  readonly gain: number;
  readonly sounds: Readonly<Record<string, BankSound>>;
  /** What a kind of event sounds like when neither the scene nor the node's voice decides; null or left out: silent. */
  readonly kinds: Readonly<Partial<Record<EventKind, string | null>>>;
  readonly curves: SoundCurves;
  readonly rules: SoundRules;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is EventKind {
  return typeof value === 'string' && (EVENT_KINDS as readonly string[]).includes(value);
}

function known(where: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new BankError(`${where}: unknown field "${key}" (allowed: ${allowed.join(', ')})`);
  }
}

function num(where: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new BankError(`${where} must be a number in ${min}..${max}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function curve(where: string, value: unknown): Curve {
  if (!Array.isArray(value) || value.length === 0) throw new BankError(`${where} must be a list of points [x, gain], got ${JSON.stringify(value)}`);
  const points = value.map((p, i): readonly [number, number] => {
    if (!Array.isArray(p) || p.length !== 2) throw new BankError(`${where}[${i}] must be [x, gain], got ${JSON.stringify(p)}`);
    return [num(`${where}[${i}][0]`, p[0], -1e9, 1e9), num(`${where}[${i}][1]`, p[1], 0, 8)];
  });
  for (let i = 1; i < points.length; i++) {
    if (points[i]![0] <= points[i - 1]![0]) throw new BankError(`${where}: the points must be in rising order of x`);
  }
  return points;
}

/** The rules a sound sets for its own events, checked: only the ones it names. */
function ownRules(where: string, value: unknown): SoundOwnRules {
  if (!isObject(value)) throw new BankError(`${where} must be an object of rules for the events of this sound`);
  known(where, value, ['minSize', 'minSpeed', 'minImpulse', 'mergeWindow', 'kindGap', 'crowdVoices', 'crowdWindow', 'starts', 'startsWindow', 'voices', 'apart']);
  const out: { -readonly [K in keyof SoundOwnRules]: SoundOwnRules[K] } = {};
  const take = (name: Exclude<keyof SoundOwnRules, 'apart'>, min: number, max: number, whole = false): void => {
    if (value[name] === undefined) return;
    const n = num(`${where}.${name}`, value[name], min, max);
    out[name] = whole ? Math.round(n) : n;
  };
  take('minSize', 0, 4000);
  take('minSpeed', 0, 1000);
  take('minImpulse', 0, 1e6);
  take('mergeWindow', 0, 60);
  take('kindGap', 0, 600);
  take('crowdVoices', 1, 1000, true);
  take('crowdWindow', 0, 600);
  take('starts', 1, 100000, true);
  take('startsWindow', 0, 3600);
  take('voices', 1, 1000, true);
  if (value['apart'] !== undefined) {
    if (typeof value['apart'] !== 'boolean') throw new BankError(`${where}.apart must be true or false, got ${JSON.stringify(value['apart'])}`);
    out.apart = value['apart'];
  }
  return out;
}

/** The gain a curve gives a measurement. */
export function curveAt(points: Curve, x: number): number {
  const first = points[0]!;
  if (x <= first[0]) return first[1];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (x <= b[0]) return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
  }
  return points[points.length - 1]![1];
}

/**
 * Checks a bank as it stands in its JSON file and fills in the defaults.
 * `dir` is the folder its files are relative to. The files themselves are
 * read when a track is made.
 */
export function parseBank(json: unknown, dir: string): SoundBank {
  if (!isObject(json)) throw new BankError('a bank of sounds is a JSON object: { "sounds": { ... }, "kinds": { ... }, "curves": { ... }, "rules": { ... } }');
  known('bank', json, ['about', 'gain', 'sounds', 'kinds', 'curves', 'rules']);
  if (!isObject(json['sounds']) || Object.keys(json['sounds']).length === 0) throw new BankError('bank: "sounds" must hold at least one sound by its key');

  const sounds: Record<string, BankSound> = {};
  for (const [key, raw] of Object.entries(json['sounds'])) {
    const where = `bank: sound "${key}"`;
    if (!isSoundKey(key)) throw new BankError(`${where}: a key is lower-case parts joined by ".", "_" or "-", such as "pop" or "marble.contact"`);
    if (!isObject(raw)) throw new BankError(`${where} must be { "file": "<path>", "gain"?, "pitchJitter"?, "gainJitter"?, "priority"?, "rules"? }`);
    known(where, raw, ['file', 'gain', 'pitchJitter', 'gainJitter', 'priority', 'rules']);
    const list = typeof raw['file'] === 'string' ? [raw['file']] : raw['file'];
    if (!Array.isArray(list) || list.length === 0 || !list.every((f) => typeof f === 'string' && f.length > 0)) {
      throw new BankError(`${where}: "file" must be the path of a WAV file relative to the bank, or a list of such paths`);
    }
    sounds[key] = {
      files: (list as string[]).map((f) => resolve(dir, f)),
      gain: raw['gain'] === undefined ? 1 : num(`${where}: gain`, raw['gain'], 0, 8),
      pitchJitter: raw['pitchJitter'] === undefined ? 0.5 : num(`${where}: pitchJitter`, raw['pitchJitter'], 0, 12),
      gainJitter: raw['gainJitter'] === undefined ? 0.1 : num(`${where}: gainJitter`, raw['gainJitter'], 0, 0.9),
      priority: raw['priority'] === undefined ? 0 : num(`${where}: priority`, raw['priority'], -1000, 1000),
      rules: raw['rules'] === undefined ? null : ownRules(`${where}: rules`, raw['rules']),
    };
  }

  const kinds: Partial<Record<EventKind, string | null>> = {};
  if (json['kinds'] !== undefined) {
    if (!isObject(json['kinds'])) throw new BankError('bank: "kinds" must map kinds of events to keys of sounds, or to null');
    for (const [kind, key] of Object.entries(json['kinds'])) {
      if (!isKind(kind)) throw new BankError(`bank: "kinds" names "${kind}", which is not a kind of event (${EVENT_KINDS.join(', ')})`);
      if (key !== null && (typeof key !== 'string' || sounds[key] === undefined)) {
        throw new BankError(`bank: kind "${kind}" is mapped to ${JSON.stringify(key)}, which is not a sound of the bank (use a key of "sounds", or null for silence)`);
      }
      kinds[kind] = key as string | null;
    }
  }

  let curves = SOUND_CURVES;
  if (json['curves'] !== undefined) {
    if (!isObject(json['curves'])) throw new BankError('bank: "curves" must be { "size"?, "speed"?, "impulse"? }');
    known('bank: curves', json['curves'], ['size', 'speed', 'impulse']);
    const given = json['curves'];
    curves = {
      size: given['size'] === undefined ? SOUND_CURVES.size : curve('bank: curves.size', given['size']),
      speed: given['speed'] === undefined ? SOUND_CURVES.speed : curve('bank: curves.speed', given['speed']),
      impulse: given['impulse'] === undefined ? SOUND_CURVES.impulse : curve('bank: curves.impulse', given['impulse']),
    };
  }

  let rules = SOUND_RULES;
  if (json['rules'] !== undefined) {
    if (!isObject(json['rules'])) throw new BankError('bank: "rules" must be an object');
    const given = json['rules'];
    known('bank: rules', given, Object.keys(SOUND_RULES));
    const kindGaps: Partial<Record<EventKind, number>> = {};
    if (given['kindGaps'] !== undefined) {
      if (!isObject(given['kindGaps'])) throw new BankError('bank: rules.kindGaps must map kinds of events to seconds');
      for (const [kind, seconds] of Object.entries(given['kindGaps'])) {
        if (!isKind(kind)) throw new BankError(`bank: rules.kindGaps names "${kind}", which is not a kind of event`);
        kindGaps[kind] = num(`bank: rules.kindGaps.${kind}`, seconds, 0, 600);
      }
    }
    let priority = SOUND_RULES.priority;
    if (given['priority'] !== undefined) {
      const first = given['priority'];
      if (!Array.isArray(first) || !first.every(isKind) || new Set(first).size !== first.length) {
        throw new BankError(`bank: rules.priority must be a list of kinds of events, each once, the most important first (${EVENT_KINDS.join(', ')})`);
      }
      priority = [...first, ...SOUND_RULES.priority.filter((kind) => !first.includes(kind))];
    }
    type Plain = Exclude<keyof SoundRules, 'kindGaps' | 'priority'>;
    const or = (name: Plain, min: number, max: number): number => (given[name] === undefined ? SOUND_RULES[name] : num(`bank: rules.${name}`, given[name], min, max));
    rules = {
      minSize: or('minSize', 0, 4000),
      minSpeed: or('minSpeed', 0, 1000),
      minImpulse: or('minImpulse', 0, 1e6),
      mergeWindow: or('mergeWindow', 0, 60),
      kindGap: or('kindGap', 0, 600),
      kindGaps,
      crowdWindow: or('crowdWindow', 0, 600),
      crowdVoices: Math.round(or('crowdVoices', 1, 1000)),
      gap: or('gap', 0, 600),
      starts: Math.round(or('starts', 1, 100000)),
      startsWindow: or('startsWindow', 0, 3600),
      voices: Math.round(or('voices', 1, 1000)),
      priority,
      pan: or('pan', 0, 1),
    };
  }

  return { dir, gain: json['gain'] === undefined ? 1 : num('bank: gain', json['gain'], 0, 8), sounds, kinds, curves, rules };
}

/** Reads a bank from its JSON file; its sounds are relative to the folder of that file. */
export function loadBank(file: string): SoundBank {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) throw new BankError(`bank of sounds not found: ${path}`);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new BankError(`${path} is not JSON: ${(e as Error).message}`);
  }
  return parseBank(json, dirname(path));
}
