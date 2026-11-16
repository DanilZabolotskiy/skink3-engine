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
// A sound may be fitted to a move: its loudest point placed on the fastest
// moment of the move, its pan moving with the node, its take picked by the
// length of the move. Without those words in the bank a sound starts where
// its event starts and stays where it started.
//
// A sound may set rules for its own events. It is then thinned by itself, and
// when it stands apart from the limits of the whole track it is a shower: a
// pour of many small things is heard impact by impact, beside the accents and
// not in their place.
//
// Every event that is not heard is kept with the reason, so the report of a
// track says what each rule took out. Planning draws nothing and reads no
// file; it is a pure function of the events, the bank and the seed.

import { Rng } from '../core/rng.ts';
import { FPS } from '../core/time.ts';
import { curveAt, type SoundAnchor, type SoundBank, type SoundOwnRules } from './bank.ts';
import type { SceneEvent } from './events.ts';
import { panAt, SAMPLE_RATE, SAMPLES_PER_FRAME } from './mix.ts';

/**
 * Why an event that has a sound is not heard.
 *
 *   unseen         it is not seen
 *   small          smaller on screen than minSize
 *   slow           a move or a landing slower than minSpeed
 *   weak           a contact, or the burst it sets off, weaker than minImpulse
 *   merged         an event of its kind within mergeWindow matters more: the two sound as one
 *   kind-gap       a sound of its kind starts within the least gap of that kind (kindGap, kindGaps)
 *   crowd          its kind already has crowdVoices sounds within crowdWindow
 *   sound-starts   its sound already has its own `starts` within its own `startsWindow`
 *   sound-voices   its sound already has its own `voices` heard at that moment
 *   gap            another sound starts within rules.gap
 *   starts         rules.starts sounds already start within rules.startsWindow
 *   voices         rules.voices sounds are already heard at that moment
 *
 * From `small` to `crowd` the values are those of the sound where it has rules
 * of its own, and "its kind" is then "its sound". The last three are the
 * limits of the whole track; a sound that stands apart is not held to them.
 */
export const DROP_RULES = ['unseen', 'small', 'slow', 'weak', 'merged', 'kind-gap', 'crowd', 'sound-starts', 'sound-voices', 'gap', 'starts', 'voices'] as const;

export type DropRule = (typeof DROP_RULES)[number];

/** One sound of the track. */
export interface Voice {
  readonly event: SceneEvent;
  /** Key of the sound in the bank, and which of its takes. */
  readonly key: string;
  readonly take: number;
  /** The moment of its event it is placed on: its start, its fastest moment or its end. */
  readonly anchor: SoundAnchor;
  /**
   * The frame it is placed on. Anchored on the start, it starts on the first
   * sample of this frame; anchored on the peak or the end, its loudest point
   * lands on the first sample of this frame.
   */
  readonly frame: number;
  /** Seconds into the shot at which it starts to be heard. */
  readonly time: number;
  /** Seconds of the sound, as it is played, that are left out at its beginning: it would have started before the shot. */
  readonly skip: number;
  /** Its gain with everything in it: the track, the sound, the curves, the scene's own gain, the jitter. */
  readonly gain: number;
  /** Playback speed: 1 as recorded; above 1 it is higher and shorter. */
  readonly pitch: number;
  /** -1 hard left, 0 the middle, 1 hard right. For a pan that moves: where it is when the sound starts to be heard. */
  readonly pan: number;
  /** A pan that moves with the node: the pan on every frame from `frame` on. Before that frame it is the first, after the last it stays. */
  readonly follow?: { readonly frame: number; readonly pans: readonly number[] };
  /** Seconds it is heard. */
  readonly seconds: number;
  /** Its sound stands apart from the limits of the whole track: it is part of a shower. */
  readonly apart: boolean;
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
  /**
   * Seconds into a take, as recorded, of its loudest point: asked for a sound
   * that is placed by that point and whose bank entry does not give it
   * (`peakAt`). Without it such a sound is placed by its first sample.
   */
  readonly peakOf?: (key: string, take: number) => number;
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
  /** The rules its sound sets for its own events, or null. */
  readonly own: SoundOwnRules | null;
  /** What it is thinned with: the events of its sound when the sound has rules of its own, else the events of its kind. */
  readonly pool: string;
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

/** The most of `heard` that sound at one moment while `c` does: at its own start, or where one of them starts in it. */
function overlap(heard: readonly Candidate[], c: Candidate): number {
  const from = c.voice.time;
  const to = from + c.voice.seconds;
  // Only what sounds somewhere in its span can be heard with it; a long shower stays cheap this way.
  const near = heard.filter((h) => h.voice.time <= to + 1e-9 && h.voice.time + h.voice.seconds >= from - 1e-9);
  const at = (t: number): number => near.filter((h) => h.voice.time <= t + 1e-9 && t < h.voice.time + h.voice.seconds - 1e-9).length;
  return Math.max(at(from), ...near.filter((h) => h.voice.time > from && h.voice.time < to - 1e-9).map((h) => at(h.voice.time)));
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
    // A placed sound sounds as it is placed: the rules of its sound are for the events that find it by themselves.
    const own = forced ? null : sound.rules;
    const moving = event.kind === 'move' || event.kind === 'land';
    const curves = forced
      ? (event.gain ?? 1)
      : curveAt(bank.curves.size, event.size) * (moving ? curveAt(bank.curves.speed, event.speed) : 1) * (event.impulse === undefined ? 1 : curveAt(bank.curves.impulse, event.impulse));
    const base = bank.gain * sound.gain * curves;
    // The jitter of an event depends on the event alone, so another event more or less does not change it.
    const rng = new Rng(opts.seed, `sound/${event.id}`);
    const pitch = 2 ** ((rng.range(-1, 1) * sound.pitchJitter) / 12);
    const gain = base * (1 + rng.range(-1, 1) * sound.gainJitter);
    const seeded = Math.min(sound.files.length - 1, Math.floor(rng.next() * sound.files.length));
    // The take: by the seed, or the one that lasts most nearly as long as the action; the earlier of two that are as near.
    let take = seeded;
    if (sound.pick === 'duration') {
      take = 0;
      for (let i = 1; i < sound.files.length; i++) {
        if (Math.abs(opts.lengthOf(key, i) - event.dur) < Math.abs(opts.lengthOf(key, take) - event.dur) - 1e-9) take = i;
      }
    }
    // Where it is placed: on the start of its event, or with its loudest point on the fastest moment or on the end of the action.
    const anchor = sound.anchor;
    const last = event.track ? event.frame + event.track.length - 1 : Math.min(opts.frames - 1, Math.round((event.time + event.dur) * FPS));
    const frame = anchor === 'peak' ? (event.peakFrame ?? event.frame) : anchor === 'end' ? last : event.frame;
    let time = event.time;
    let skip = 0;
    if (anchor !== 'start') {
      const peakAt = sound.peakAt ? sound.peakAt[take]! : opts.peakOf ? opts.peakOf(key, take) : 0;
      const first = frame * SAMPLES_PER_FRAME - Math.round((peakAt / pitch) * SAMPLE_RATE);
      time = Math.max(0, first) / SAMPLE_RATE;
      skip = Math.max(0, -first) / SAMPLE_RATE;
    }
    const seconds = Math.max(0, Math.min(opts.lengthOf(key, take) / pitch - skip, shotSeconds - time));
    // Its pan: where it is placed; with "follow", where the node is from frame to frame.
    const track = event.track && event.track.length > 1 ? event.track : null;
    const panOf = (x: number): number => Math.max(-1, Math.min(1, (x - 960) / 960)) * rules.pan;
    const follow = sound.pan === 'follow' && track ? { frame: event.frame, pans: track.map(([x]) => panOf(x)) } : null;
    const placedX = anchor === 'start' || !track ? event.x : track[Math.max(0, Math.min(track.length - 1, frame - event.frame))]![0];
    const pan = follow ? panAt(follow, time * FPS) : panOf(placedX);
    // What matters more keeps its sound: a sound placed by hand, one the scene named on an intent, then the
    // priority the bank gives the sound, the place of the kind in rules.priority, and the gain.
    const source = forced ? 0 : from === 'scene' ? 1 : 2;
    const kindRank = rules.priority.indexOf(event.kind);
    const rank = [source, -sound.priority, kindRank < 0 ? rules.priority.length : kindRank, -base];
    const c: Candidate = {
      event,
      order,
      forced,
      own,
      pool: own ? `sound:${key}` : `kind:${event.kind}`,
      rank,
      voice: { event, key, take, anchor, frame, time, skip, gain, pitch, pan, ...(follow ? { follow } : {}), seconds, apart: own?.apart === true },
    };
    if (forced) return void live.push(c);
    if (!event.seen) return drop('unseen', c);
    if (from !== 'scene') {
      // A sound the scene named itself is wanted whatever the size of the thing.
      if (event.size < (own?.minSize ?? rules.minSize)) return drop('small', c);
      if (moving && event.speed < (own?.minSpeed ?? rules.minSpeed)) return drop('slow', c);
      if (event.impulse !== undefined && event.impulse < (own?.minImpulse ?? rules.minImpulse)) return drop('weak', c);
    }
    live.push(c);
  });

  const without = (lost: ReadonlySet<Candidate>): void => {
    live = live.filter((c) => !lost.has(c));
  };
  /** What is still live, by pool: the events of a kind, or of a sound that has rules of its own. */
  const pools = (): Candidate[][] => {
    const by = new Map<string, Candidate[]>();
    for (const c of live) {
      if (c.forced) continue;
      const list = by.get(c.pool);
      if (list) list.push(c);
      else by.set(c.pool, [c]);
    }
    return [...by.values()];
  };

  // 2. Events of one pool close together sound as one: the one that matters most.
  {
    const lost = new Set<Candidate>();
    for (const members of pools()) {
      const window = members[0]!.own?.mergeWindow ?? rules.mergeWindow;
      const row = [...members].sort((a, b) => a.event.frame - b.event.frame || a.order - b.order);
      for (let i = 0; i < row.length; ) {
        let j = i + 1;
        while (j < row.length && row[j]!.event.time - row[i]!.event.time < window - 1e-9) j++;
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

  // 3. A least gap between two sounds of one pool, and 4. a crowd of them as a few voices.
  {
    const lost = new Set<Candidate>();
    for (const members of pools()) {
      const own = members[0]!.own;
      const gap = own ? (own.kindGap ?? rules.kindGap) : (rules.kindGaps[members[0]!.event.kind] ?? rules.kindGap);
      const crowdVoices = own?.crowdVoices ?? rules.crowdVoices;
      const crowdWindow = own?.crowdWindow ?? rules.crowdWindow;
      const kept: Candidate[] = [];
      for (const c of [...members].sort(byRank)) {
        const near = kept.find((k) => Math.abs(k.event.time - c.event.time) < gap - 1e-9);
        if (near) {
          lost.add(c);
          drop('kind-gap', c, near);
        } else kept.push(c);
      }
      const starts: number[] = [];
      for (const c of kept) {
        if (fits(starts, c.event.time, crowdVoices, crowdWindow)) starts.push(c.event.time);
        else {
          lost.add(c);
          drop('crowd', c);
        }
      }
    }
    without(lost);
  }

  // 5. The cap a sound sets for itself: on its starts in a window of time, and on its voices at once.
  {
    const lost = new Set<Candidate>();
    for (const members of pools()) {
      const own = members[0]!.own;
      if (!own) continue;
      let kept = [...members].sort(byRank);
      if (own.starts !== undefined) {
        const starts: number[] = [];
        const next: Candidate[] = [];
        for (const c of kept) {
          if (fits(starts, c.event.time, own.starts, own.startsWindow ?? rules.startsWindow)) {
            starts.push(c.event.time);
            next.push(c);
          } else {
            lost.add(c);
            drop('sound-starts', c);
          }
        }
        kept = next;
      }
      if (own.voices !== undefined) {
        const heard: Candidate[] = [];
        for (const c of kept) {
          if (overlap(heard, c) < own.voices) heard.push(c);
          else {
            lost.add(c);
            drop('sound-voices', c);
          }
        }
      }
    }
    without(lost);
  }

  // The limits of the whole track. A sound that stands apart is not held to them and does not count toward them.
  const counted = (c: Candidate): boolean => !c.voice.apart;

  // 6. A least gap between any two starts. What the scene placed by hand is in first, and always.
  {
    const lost = new Set<Candidate>();
    const kept: Candidate[] = [];
    for (const c of live.filter(counted).sort(byRank)) {
      const near = c.forced ? undefined : kept.find((k) => Math.abs(k.event.time - c.event.time) < rules.gap - 1e-9);
      if (near) {
        lost.add(c);
        drop('gap', c, near);
      } else kept.push(c);
    }
    without(lost);
  }

  // 7. A cap on the starts in any window of time, whatever the kinds.
  {
    const lost = new Set<Candidate>();
    const starts: number[] = [];
    for (const c of live.filter(counted).sort(byRank)) {
      if (c.forced || fits(starts, c.event.time, rules.starts, rules.startsWindow)) starts.push(c.event.time);
      else {
        lost.add(c);
        drop('starts', c);
      }
    }
    without(lost);
  }

  // 8. A cap on the voices at once.
  {
    const lost = new Set<Candidate>();
    const heard: Candidate[] = [];
    for (const c of live.filter(counted).sort(byRank)) {
      if (c.forced || overlap(heard, c) < rules.voices) heard.push(c);
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

/** Starts of one sound that stands apart are one shower while each follows the one before by less than this many seconds. */
export const SHOWER_GAP = 1;

/** A run of a sound that stands apart: many starts close together, heard as one thing. */
export interface Shower {
  /** Key of the sound. */
  readonly sound: string;
  /** Its starts, in order of time. */
  readonly voices: readonly Voice[];
  /** When its first sound starts, and the seconds from there to the end of its last. */
  readonly time: number;
  readonly seconds: number;
  /** The most of its starts within any one second, and the most of its sounds heard at one moment. */
  readonly mostStartsInASecond: number;
  readonly mostVoices: number;
}

/** The showers of a plan: the runs of its sounds that stand apart, in order of time. */
export function showersOf(voices: readonly Voice[]): Shower[] {
  const bySound = new Map<string, Voice[]>();
  for (const v of voices) {
    if (!v.apart) continue;
    const list = bySound.get(v.key);
    if (list) list.push(v);
    else bySound.set(v.key, [v]);
  }
  const out: Shower[] = [];
  for (const [sound, list] of bySound) {
    const row = [...list].sort((a, b) => a.time - b.time);
    for (let i = 0; i < row.length; ) {
      let j = i + 1;
      while (j < row.length && row[j]!.time - row[j - 1]!.time < SHOWER_GAP - 1e-9) j++;
      const run = row.slice(i, j);
      const end = run.reduce((m, v) => Math.max(m, v.time + v.seconds), 0);
      const { mostStarts, mostVoices } = density(run, 1);
      out.push({ sound, voices: run, time: run[0]!.time, seconds: end - run[0]!.time, mostStartsInASecond: mostStarts, mostVoices });
      i = j;
    }
  }
  return out.sort((a, b) => a.time - b.time || (a.sound < b.sound ? -1 : 1));
}
