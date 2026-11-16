// From the events of a shot to the sounds that are heard in it.
//
// A film is never crowded with sound: a sound marks an event that matters. So
// most events make none. An event is heard only when
//
//   1. it has a sound: the scene names one, or the bank has one for the node's
//      voice or for the kind of event. One event makes one sound;
//   2. it is seen;
//   3. it is large, fast and strong enough (the thresholds);
//   4. and the density rules leave room for it: events of one kind close
//      together sound as one, sounds of one kind keep a least gap and a crowd
//      of them is a few voices; any two starts keep a least gap, any window of
//      time holds only so many starts, and only so many voices sound at once.
//
// Where a rule has to choose, the event that matters more keeps its sound: a
// sound the scene placed by hand, then one it named on an intent, then the
// priority the bank gives the sound, then the order of the kinds, then the
// stronger event.
//
// Every event that is not heard is kept with the reason, so the report of a
// track says what each rule took out. Planning draws nothing and reads no
// file; it is a pure function of the events, the bank and the seed.

import { Rng } from '../core/rng.ts';
import { FPS } from '../core/time.ts';
import { curveAt, type SoundBank } from './bank.ts';
import type { SceneEvent } from './events.ts';

/**
 * Why an event that has a sound is not heard.
 *
 *   unseen     it is not seen
 *   small      smaller on screen than rules.minSize
 *   slow       a move or a landing slower than rules.minSpeed
 *   weak       a contact, or the burst it sets off, weaker than rules.minImpulse
 *   merged     an event of its kind within rules.mergeWindow matters more: the two sound as one
 *   kind-gap   a sound of its kind starts within the least gap of that kind (rules.kindGap, rules.kindGaps)
 *   crowd      its kind already has rules.crowdVoices sounds within rules.crowdWindow
 *   gap        another sound starts within rules.gap
 *   starts     rules.starts sounds already start within rules.startsWindow
 *   voices     rules.voices sounds are already heard at that moment
 */
export const DROP_RULES = ['unseen', 'small', 'slow', 'weak', 'merged', 'kind-gap', 'crowd', 'gap', 'starts', 'voices'] as const;

export type DropRule = (typeof DROP_RULES)[number];

/** One sound of the track. */
export interface Voice {
  readonly event: SceneEvent;
  /** Key of the sound in the bank, and which of its takes. */
  readonly key: string;
  readonly take: number;
  readonly frame: number;
  readonly time: number;
  /** Its gain with everything in it: the track, the sound, the curves, the scene's own gain, the jitter. */
  readonly gain: number;
  /** Playback speed: 1 as recorded; above 1 it is higher and shorter. */
  readonly pitch: number;
  /** -1 hard left, 0 the middle, 1 hard right. */
  readonly pan: number;
  /** Seconds it is heard. */
  readonly seconds: number;
}

export interface Dropped {
  readonly rule: DropRule;
  readonly event: SceneEvent;
  /** Id of the event that is heard instead, where the rule names one. */
  readonly by: string | null;
}

export interface SoundPlan {
  /** The sounds of the track, in order of time. */
  readonly voices: readonly Voice[];
  /** Events without a sound: their kind is silent in the bank and nothing else names one. */
  readonly silent: readonly SceneEvent[];
  /** Events the scene muted. */
  readonly muted: readonly SceneEvent[];
  /** Events that have a sound and are not heard, each with the rule that took it out. */
  readonly dropped: readonly Dropped[];
}

export interface PlanOptions {
  /** Seed of the jitter: the seed of the shot. */
  readonly seed: number;
  /** Length of the shot in frames: a sound is cut where the shot ends. */
  readonly frames: number;
  /** Seconds a take of a sound lasts as recorded. */
  readonly lengthOf: (key: string, take: number) => number;
}

/** Who chose the sound of an event: the scene (on the intent, or with sfx), the voice of a node, or the bank's table of kinds. */
export type SoundSource = 'scene' | 'voice' | 'kind';

/**
 * The sound of an event: one key of the bank, or none.
 *
 *   1. The scene decides first: `sound: false` on the intent mutes it, a key on
 *      the intent or in sfx() names the sound.
 *   2. Then the voice of the node (for a contact: of either body): the sound
 *      "<voice>.<kind>", when the bank has it.
 *   3. Then the kind: when the bank maps it to nothing, the event is silent.
 *   4. Otherwise the sound "<voice>", when the bank has it, and only without
 *      one the sound the bank maps the kind to.
 */
export function soundOf(bank: SoundBank, event: SceneEvent): { key: string | null; from: SoundSource; muted: boolean } {
  if (event.sound === false) return { key: null, from: 'scene', muted: true };
  if (typeof event.sound === 'string') return { key: event.sound, from: 'scene', muted: false };
  const voices = [event.key, event.otherKey].filter((v): v is string => typeof v === 'string');
  for (const voice of voices) if (bank.sounds[`${voice}.${event.kind}`]) return { key: `${voice}.${event.kind}`, from: 'voice', muted: false };
  const kit = bank.kinds[event.kind] ?? null;
  if (kit === null) return { key: null, from: 'kind', muted: false };
  for (const voice of voices) if (bank.sounds[voice]) return { key: voice, from: 'voice', muted: false };
  return { key: kit, from: 'kind', muted: false };
}

interface Candidate {
  readonly event: SceneEvent;
  readonly order: number;
  /** The scene placed it by hand: it always sounds. */
  readonly forced: boolean;
  /** What ranks it when a rule has to choose, the most important first; smaller comes first. */
  readonly rank: readonly number[];
  readonly voice: Voice;
}

/** Orders candidates from the one that keeps its sound first to the one that loses it first. */
function byRank(a: Candidate, b: Candidate): number {
  for (let i = 0; i < a.rank.length; i++) {
    const d = a.rank[i]! - b.rank[i]!;
    if (d !== 0) return d;
  }
  return a.event.frame - b.event.frame || a.order - b.order;
}

/** True when a start at `t` leaves at most `most` of the starts in every stretch of `window` seconds. */
function fits(starts: readonly number[], t: number, most: number, window: number): boolean {
  if (window <= 0) return true;
  const all = [...starts, t].sort((a, b) => a - b);
  const at = all.indexOf(t);
  // Any most + 1 starts in a row must span the window; only rows that hold the new start can break that.
  for (let i = Math.max(0, at - most); i <= at && i + most < all.length; i++) {
    if (all[i + most]! - all[i]! < window - 1e-9) return false;
  }
  return true;
}

/** Plans the sounds of a shot from its events. */
export function planSound(events: readonly SceneEvent[], bank: SoundBank, opts: PlanOptions): SoundPlan {
  const rules = bank.rules;
  const silent: SceneEvent[] = [];
  const muted: SceneEvent[] = [];
  const dropped: Dropped[] = [];
  const drop = (rule: DropRule, c: Candidate, by: Candidate | null = null): void => {
    dropped.push({ rule, event: c.event, by: by ? by.event.id : null });
  };
  const shotSeconds = opts.frames / FPS;

  // 1. The sound of each event, what is seen, and the thresholds.
  let live: Candidate[] = [];
  events.forEach((event, order) => {
    const { key, from, muted: isMuted } = soundOf(bank, event);
    if (isMuted) return void muted.push(event);
    if (key === null) return void silent.push(event);
    const sound = bank.sounds[key];
    if (!sound) throw new Error(`event ${event.id} asks for the sound "${key}", which the bank does not have (skink3 check --bank names such keys)`);
    const forced = event.kind === 'sfx';
    const moving = event.kind === 'move' || event.kind === 'land';
    const curves = forced
      ? (event.gain ?? 1)
      : curveAt(bank.curves.size, event.size) * (moving ? curveAt(bank.curves.speed, event.speed) : 1) * (event.impulse === undefined ? 1 : curveAt(bank.curves.impulse, event.impulse));
    const base = bank.gain * sound.gain * curves;
    // The jitter of an event depends on the event alone, so another event more or less does not change it.
    const rng = new Rng(opts.seed, `sound/${event.id}`);
    const pitch = 2 ** ((rng.range(-1, 1) * sound.pitchJitter) / 12);
    const gain = base * (1 + rng.range(-1, 1) * sound.gainJitter);
    const take = Math.min(sound.files.length - 1, Math.floor(rng.next() * sound.files.length));
    const seconds = Math.max(0, Math.min(opts.lengthOf(key, take) / pitch, shotSeconds - event.time));
    const pan = Math.max(-1, Math.min(1, (event.x - 960) / 960)) * rules.pan;
    // What matters more keeps its sound: a sound placed by hand, one the scene named on an intent, then the
    // priority the bank gives the sound, the place of the kind in rules.priority, and the gain.
    const source = forced ? 0 : from === 'scene' ? 1 : 2;
    const kindRank = rules.priority.indexOf(event.kind);
    const rank = [source, -sound.priority, kindRank < 0 ? rules.priority.length : kindRank, -base];
    const c: Candidate = { event, order, forced, rank, voice: { event, key, take, frame: event.frame, time: event.time, gain, pitch, pan, seconds } };
    if (forced) return void live.push(c);
    if (!event.seen) return drop('unseen', c);
    if (from !== 'scene') {
      // A sound the scene named itself is wanted whatever the size of the thing.
      if (event.size < rules.minSize) return drop('small', c);
      if (moving && event.speed < rules.minSpeed) return drop('slow', c);
      if (event.impulse !== undefined && event.impulse < rules.minImpulse) return drop('weak', c);
    }
    live.push(c);
  });

  const kinds = [...new Set(live.filter((c) => !c.forced).map((c) => c.event.kind))];
  const without = (lost: ReadonlySet<Candidate>): void => {
    live = live.filter((c) => !lost.has(c));
  };

  // 2. Events of one kind close together sound as one: the one that matters most.
  {
    const lost = new Set<Candidate>();
    for (const kind of kinds) {
      const row = live.filter((c) => !c.forced && c.event.kind === kind).sort((a, b) => a.event.frame - b.event.frame || a.order - b.order);
      for (let i = 0; i < row.length; ) {
        let j = i + 1;
        while (j < row.length && row[j]!.event.time - row[i]!.event.time < rules.mergeWindow - 1e-9) j++;
        const cluster = row.slice(i, j);
        const best = [...cluster].sort(byRank)[0]!;
        for (const c of cluster) {
          if (c === best) continue;
          lost.add(c);
          drop('merged', c, best);
        }
        i = j;
      }
    }
    without(lost);
  }

  // 3. A least gap between two sounds of one kind, and 4. a crowd of one kind as a few voices.
  {
    const lost = new Set<Candidate>();
    for (const kind of kinds) {
      const gap = rules.kindGaps[kind] ?? rules.kindGap;
      const kept: Candidate[] = [];
      for (const c of live.filter((x) => !x.forced && x.event.kind === kind).sort(byRank)) {
        const near = kept.find((k) => Math.abs(k.event.time - c.event.time) < gap - 1e-9);
        if (near) {
          lost.add(c);
          drop('kind-gap', c, near);
        } else kept.push(c);
      }
      const starts: number[] = [];
      for (const c of kept) {
        if (fits(starts, c.event.time, rules.crowdVoices, rules.crowdWindow)) starts.push(c.event.time);
        else {
          lost.add(c);
          drop('crowd', c);
        }
      }
    }
    without(lost);
  }

  // 5. A least gap between any two starts. What the scene placed by hand is in first, and always.
  {
    const lost = new Set<Candidate>();
    const kept: Candidate[] = [];
    for (const c of [...live].sort(byRank)) {
      const near = c.forced ? undefined : kept.find((k) => Math.abs(k.event.time - c.event.time) < rules.gap - 1e-9);
      if (near) {
        lost.add(c);
        drop('gap', c, near);
      } else kept.push(c);
    }
    without(lost);
  }

  // 6. A cap on the starts in any window of time, whatever the kinds.
  {
    const lost = new Set<Candidate>();
    const starts: number[] = [];
    for (const c of [...live].sort(byRank)) {
      if (c.forced || fits(starts, c.event.time, rules.starts, rules.startsWindow)) starts.push(c.event.time);
      else {
        lost.add(c);
        drop('starts', c);
      }
    }
    without(lost);
  }

  // 7. A cap on the voices at once.
  {
    const lost = new Set<Candidate>();
    const heard: Candidate[] = [];
    const at = (t: number): number => heard.filter((h) => h.voice.time <= t + 1e-9 && t < h.voice.time + h.voice.seconds - 1e-9).length;
    for (const c of [...live].sort(byRank)) {
      const from = c.voice.time;
      const to = from + c.voice.seconds;
      // The most voices are heard at its own start, or where one of the others starts while it sounds.
      const most = Math.max(at(from), ...heard.filter((h) => h.voice.time > from && h.voice.time < to - 1e-9).map((h) => at(h.voice.time)));
      if (c.forced || most < rules.voices) heard.push(c);
      else {
        lost.add(c);
        drop('voices', c);
      }
    }
    without(lost);
  }

  const voices = live.sort((a, b) => a.event.frame - b.event.frame || a.order - b.order).map((c) => c.voice);
  return { voices, silent, muted, dropped };
}

/** The most starts within any stretch of `window` seconds, and the most voices heard at one moment. */
export function density(voices: readonly Voice[], window: number): { mostStarts: number; mostVoices: number } {
  const starts = voices.map((v) => v.time).sort((a, b) => a - b);
  let mostStarts = 0;
  for (let i = 0, j = 0; i < starts.length; i++) {
    if (j <= i) j = i + 1;
    while (j < starts.length && starts[j]! - starts[i]! < window - 1e-9) j++;
    mostStarts = Math.max(mostStarts, j - i);
  }
  let mostVoices = 0;
  for (const v of voices) {
    mostVoices = Math.max(mostVoices, voices.filter((o) => o.time <= v.time + 1e-9 && v.time < o.time + o.seconds - 1e-9).length);
  }
  return { mostStarts, mostVoices };
}
