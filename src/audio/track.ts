// The sound track of a shot from end to end: its events, the plan of what is
// heard, the mix, and a report that says how dense the track is and what each
// rule took out. Also the check of a shot's sound keys against a bank.

import { FPS } from '../core/time.ts';
import type { Bake } from '../physics/cache.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { BankError, type SoundBank, type SoundOwnRules, type SoundRules } from './bank.ts';
import { EVENT_KINDS, sceneEvents, type EventKind, type SceneEvent } from './events.ts';
import { loadTakes, mixVoices, SAMPLE_RATE } from './mix.ts';
import { density, DROP_RULES, planSound, showersOf, soundOf, type DropRule, type SoundPlan } from './plan.ts';
import { writeWav } from './wav.ts';

/** Bits of a sample of the track that is written. */
export const TRACK_BITS = 24;

/**
 * The sound keys of a shot that the bank does not know, one message each.
 *
 * A key on a node is its voice: the bank knows it when it has the sound
 * "<key>" or a sound "<key>.<kind>". A key on an intent, and the key of
 * sfx(), is a sound: the bank must have it by that name.
 */
export function checkSound(c: CompiledShot, bank: SoundBank): { keys: string[]; issues: string[] } {
  const keys = new Set<string>();
  const issues: string[] = [];
  const have = `the bank has: ${Object.keys(bank.sounds).sort().slice(0, 24).join(', ')}${Object.keys(bank.sounds).length > 24 ? ', ...' : ''}`;
  for (const n of c.nodes) {
    const voice = n.node.sound;
    if (voice === undefined) continue;
    keys.add(voice);
    if (bank.sounds[voice] || EVENT_KINDS.some((kind) => bank.sounds[`${voice}.${kind}`])) continue;
    issues.push(`${n.node.type} "${n.id}" has the sound key "${voice}", which the bank does not know: it has no sound "${voice}" and none of "${voice}.<kind>" (${have})`);
  }
  for (const key of c.spec.timeline) {
    if (typeof key.sound !== 'string') continue;
    keys.add(key.sound);
    if (bank.sounds[key.sound]) continue;
    const who = key.kind === 'sfx' ? `sfx("${key.sound}") at ${key.at} s` : `${key.kind}("${key.target}") at ${key.at} s`;
    issues.push(`${who} asks for the sound "${key.sound}", which the bank does not have (${have})`);
  }
  return { keys: [...keys].sort(), issues };
}

export interface SoundReport {
  readonly shot: string;
  readonly frames: number;
  readonly seconds: number;
  readonly seed: number;
  /** The track: samples per second, channels, bits per sample, samples per channel. */
  readonly sampleRate: number;
  readonly channels: number;
  readonly bits: number;
  readonly samples: number;
  /** Events of the shot, and how many of them are heard: every sound of the track. */
  readonly events: number;
  readonly heard: number;
  /** The accents: the starts that the limits of the whole track count, which is every sound but those of showers. */
  readonly starts: number;
  readonly startsPerMinute: number;
  /** The most of those starts within any `startsWindow` seconds: the window of the rule `starts`. */
  readonly mostStarts: number;
  readonly startsWindow: number;
  /** The most of those sounds heard at one moment. */
  readonly mostVoicesAtOnce: number;
  /** The starts of sounds that stand apart from those limits, and their runs. */
  readonly showerStarts: number;
  readonly showers: readonly {
    readonly sound: string;
    /** Its first start: the event, its node, its time. */
    readonly id: string;
    readonly node: string | null;
    readonly time: number;
    /** From its first start to the end of its last sound. */
    readonly seconds: number;
    readonly starts: number;
    readonly mostStartsInASecond: number;
    readonly mostVoicesAtOnce: number;
  }[];
  /** Largest sample of the mix, 1 = full scale, and how many samples had to be held there. */
  readonly peak: number;
  readonly clipped: number;
  /** Events without a sound (their kind is silent in the bank), and events the scene muted. */
  readonly silent: number;
  readonly muted: number;
  /** By kind: its events, and how many are heard. */
  readonly byKind: Readonly<Partial<Record<EventKind, { readonly events: number; readonly heard: number }>>>;
  /** What each rule took out. `by` is the event that is heard instead, where the rule names one. */
  readonly dropped: Readonly<Record<DropRule, readonly { readonly id: string; readonly time: number; readonly kind: EventKind; readonly node: string | null; readonly by: string | null }[]>>;
  /** Every sound of the track, in order of time: its event, the node it comes from, and how it is played. */
  readonly voices: readonly {
    readonly id: string;
    readonly time: number;
    readonly kind: EventKind;
    /** Id of the node the sound comes from; null for a sound placed by hand without one. */
    readonly node: string | null;
    readonly sound: string;
    readonly take: number;
    readonly gain: number;
    readonly pitch: number;
    readonly pan: number;
    readonly seconds: number;
    /** Left out for an accent; for a sound of a shower, which one: its place in `showers`. */
    readonly shower?: number;
  }[];
  /** The rules as they were applied: the bank's, with the engine's defaults for the ones it leaves out. */
  readonly rules: SoundRules;
  /** The rules that sounds set for their own events, by the key of the sound. */
  readonly soundRules: Readonly<Record<string, SoundOwnRules>>;
}

export interface SoundTrack {
  /** The track as a WAV file: 48 kHz, stereo, 24-bit PCM, exactly as long as the shot. */
  readonly wav: Uint8Array;
  readonly left: Float64Array;
  readonly right: Float64Array;
  readonly events: readonly SceneEvent[];
  readonly plan: SoundPlan;
  readonly report: SoundReport;
}

const round = (v: number, digits = 3): number => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

/** The report of a plan and of the track mixed from it. */
export function soundReport(c: CompiledShot, bank: SoundBank, events: readonly SceneEvent[], plan: SoundPlan, mix: { left: ArrayLike<number>; right: ArrayLike<number> }): SoundReport {
  let peak = 0;
  let clipped = 0;
  for (const channel of [mix.left, mix.right]) {
    for (let i = 0; i < channel.length; i++) {
      const a = Math.abs(channel[i]!);
      if (a > peak) peak = a;
      if (a > 1) clipped++;
    }
  }
  const byKind: Partial<Record<EventKind, { events: number; heard: number }>> = {};
  for (const e of events) (byKind[e.kind] ??= { events: 0, heard: 0 }).events++;
  for (const v of plan.voices) byKind[v.event.kind]!.heard++;
  const dropped = Object.fromEntries(DROP_RULES.map((rule) => [rule, [] as { id: string; time: number; kind: EventKind; node: string | null; by: string | null }[]])) as Record<
    DropRule,
    { id: string; time: number; kind: EventKind; node: string | null; by: string | null }[]
  >;
  for (const d of plan.dropped) dropped[d.rule].push({ id: d.event.id, time: round(d.event.time), kind: d.event.kind, node: d.event.node, by: d.by });
  const seconds = c.frames / FPS;
  // The limits of the whole track are about the accents; the showers are counted by themselves.
  const accents = plan.voices.filter((v) => !v.apart);
  const showers = showersOf(plan.voices);
  const showerOf = new Map(showers.flatMap((s, i) => s.voices.map((v) => [v, i] as const)));
  const { mostStarts, mostVoices } = density(accents, bank.rules.startsWindow);
  return {
    shot: c.spec.id,
    frames: c.frames,
    seconds: round(seconds),
    seed: c.spec.seed,
    sampleRate: SAMPLE_RATE,
    channels: 2,
    bits: TRACK_BITS,
    samples: mix.left.length,
    events: events.length,
    heard: plan.voices.length,
    starts: accents.length,
    startsPerMinute: round((accents.length / seconds) * 60, 1),
    mostStarts,
    startsWindow: bank.rules.startsWindow,
    mostVoicesAtOnce: mostVoices,
    showerStarts: plan.voices.length - accents.length,
    showers: showers.map((s) => ({
      sound: s.sound,
      id: s.voices[0]!.event.id,
      node: s.voices[0]!.event.node,
      time: round(s.time),
      seconds: round(s.seconds),
      starts: s.voices.length,
      mostStartsInASecond: s.mostStartsInASecond,
      mostVoicesAtOnce: s.mostVoices,
    })),
    peak: round(peak, 4),
    clipped,
    silent: plan.silent.length,
    muted: plan.muted.length,
    byKind,
    dropped,
    voices: plan.voices.map((v) => ({
      id: v.event.id,
      time: round(v.time),
      kind: v.event.kind,
      node: v.event.node,
      sound: v.key,
      take: v.take,
      gain: round(v.gain, 4),
      pitch: round(v.pitch, 4),
      pan: round(v.pan, 3),
      seconds: round(v.seconds),
      ...(showerOf.has(v) ? { shower: showerOf.get(v)! } : {}),
    })),
    rules: bank.rules,
    soundRules: Object.fromEntries(Object.entries(bank.sounds).flatMap(([key, s]) => (s.rules ? [[key, s.rules] as const] : []))),
  };
}

/**
 * Makes the sound track of a shot from its events and a bank of sounds. The
 * same shot, bank and seed give the same bytes. Throws when the shot asks for
 * a sound key the bank does not know, or a file of the bank cannot be read.
 */
export function renderSound(c: CompiledShot, bake: Bake, bank: SoundBank, opts: { lang?: string; events?: readonly SceneEvent[] } = {}): SoundTrack {
  const { issues } = checkSound(c, bank);
  if (issues.length > 0) throw new BankError(`the shot "${c.spec.id}" asks for sounds the bank does not know:\n  - ${issues.join('\n  - ')}`);
  const events = opts.events ?? sceneEvents(c, bake, opts.lang === undefined ? {} : { lang: opts.lang });
  const wanted = events.map((e) => soundOf(bank, e).key).filter((key): key is string => key !== null);
  const takes = loadTakes(bank, wanted);
  const plan = planSound(events, bank, {
    seed: c.spec.seed,
    frames: c.frames,
    lengthOf: (key, take) => {
      const t = takes.get(key)![take]!;
      return t.left.length / t.rate;
    },
  });
  const mix = mixVoices(plan.voices, takes, c.frames);
  return { wav: writeWav([mix.left, mix.right], SAMPLE_RATE, TRACK_BITS), left: mix.left, right: mix.right, events, plan, report: soundReport(c, bank, events, plan, mix) };
}

/** Most ids of dropped events the text report prints per rule; the JSON report holds them all. */
const SHOWN_PER_RULE = 6;

/** The report as text. */
export function formatSoundReport(r: SoundReport): string {
  const lines: string[] = [];
  lines.push(`sfx ${r.shot}: ${r.frames} frames (${r.seconds.toFixed(2)} s), ${r.sampleRate / 1000} kHz, ${r.channels} channels, ${r.bits} bits, seed ${r.seed}`);
  const dense = `${r.startsPerMinute} per minute; at most ${r.mostStarts} in any ${r.startsWindow} s (limit ${r.rules.starts}); at most ${r.mostVoicesAtOnce} voice(s) at once (limit ${r.rules.voices})`;
  if (r.showers.length === 0) lines.push(`starts: ${r.starts} of ${r.events} event(s) are heard: ${dense}`);
  else {
    lines.push(`starts: ${r.heard} of ${r.events} event(s) are heard: ${r.showerStarts} in ${r.showers.length} shower(s), and ${r.starts} accent(s): ${dense}`);
    lines.push('showers (apart from those limits):');
    for (const s of r.showers) {
      lines.push(
        `  ${s.time.toFixed(2).padStart(7)} s  ${s.sound.padEnd(16)} ${s.starts} start(s) over ${s.seconds.toFixed(2)} s; at most ${s.mostStartsInASecond} in a second, ${s.mostVoicesAtOnce} at once; from ${s.id}`,
      );
    }
  }
  lines.push(`level: peak ${r.peak.toFixed(3)} of full scale${r.clipped > 0 ? `; ${r.clipped} sample(s) clipped: lower the gains` : ''}`);
  const kinds = EVENT_KINDS.filter((kind) => r.byKind[kind]);
  if (kinds.length > 0) lines.push(`by kind (heard of events): ${kinds.map((kind) => `${kind} ${r.byKind[kind]!.heard}/${r.byKind[kind]!.events}`).join(', ')}`);
  lines.push(`without a sound: ${r.silent} event(s) of kinds the bank keeps silent; ${r.muted} muted by the scene`);
  const lost = DROP_RULES.reduce((n, rule) => n + r.dropped[rule].length, 0);
  lines.push(lost === 0 ? 'dropped by the rules: none' : `dropped by the rules: ${lost}`);
  for (const rule of DROP_RULES) {
    const list = r.dropped[rule];
    if (list.length === 0) continue;
    const shown = list.slice(0, SHOWN_PER_RULE).map((d) => `${d.id}${d.by ? ` (for ${d.by})` : ''}`);
    lines.push(`  ${rule.padEnd(12)} ${String(list.length).padStart(4)}  ${shown.join(', ')}${list.length > shown.length ? `, and ${list.length - shown.length} more` : ''}`);
  }
  // The sounds of a shower are listed by their shower above; the JSON report has each of them.
  const accents = r.voices.filter((v) => v.shower === undefined);
  if (accents.length > 0) lines.push('heard:');
  for (const v of accents) {
    lines.push(`  ${v.time.toFixed(2).padStart(7)} s  ${v.kind.padEnd(9)} ${(v.node ?? '-').padEnd(16)} ${v.sound.padEnd(16)} gain ${v.gain.toFixed(2)}  pan ${v.pan >= 0 ? '+' : ''}${v.pan.toFixed(2)}  pitch ${v.pitch.toFixed(3)}`);
  }
  return lines.join('\n');
}

/** The report as JSON: everything, also what the text report cuts short. */
export function soundReportJson(report: SoundReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
