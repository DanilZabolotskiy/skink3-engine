import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { palette } from '../examples/demo/palette.ts';
import {
  bakeHash,
  bakeShot,
  BankError,
  blink,
  bump,
  circle,
  compileShot,
  curveAt,
  density,
  drawOn,
  DROP_RULES,
  emitter,
  EVENT_KINDS,
  eye,
  fadeTo,
  formatReport,
  formatSoundReport,
  frameRaw,
  hop,
  label,
  layer,
  levelTo,
  link,
  loadBank,
  moveTo,
  openTo,
  parseBank,
  planSound,
  popIn,
  popOut,
  pulse,
  readWav,
  rect,
  renderSound,
  resample,
  runChecks,
  SAMPLE_RATE,
  SAMPLES_PER_FRAME,
  scaleTo,
  sceneEvents,
  sfx,
  shot,
  SOUND_CURVES,
  SOUND_RULES,
  soundOf,
  squash,
  travel,
  turnTo,
  WavError,
  writeWav,
  type DropRule,
  type Key,
  type LayerSpec,
  type SceneEvent,
  type ShotSpec,
  type SoundBank,
  type SoundPlan,
  type SoundTrack,
} from '../src/index.ts';

// The sound of a shot: its events, the bank of sounds, the rules that keep a
// track from being crowded, and the track itself. The engine holds no sound
// files, so every sound here is a tone the test makes.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'bin', 'skink3.mjs');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'sound', 'scene.ts');
const DIR = mkdtempSync(join(tmpdir(), 'skink3-sound-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

/** A tone: a cosine, so that its first sample is not silence. */
function tone(hz: number, seconds: number, rate = SAMPLE_RATE, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.cos((2 * Math.PI * hz * i) / rate);
  return out;
}

/** Rules that drop nothing; a test turns on the one it plants. */
const OFF = { minSize: 0, minSpeed: 0, minImpulse: 0, mergeWindow: 0, kindGap: 0, crowdWindow: 0, gap: 0, startsWindow: 0, voices: 1000 };
/** Curves that change nothing. */
const FLAT = { size: [[0, 1]], speed: [[0, 1]], impulse: [[0, 1]] };

interface ToneSpec {
  hz?: number;
  seconds?: number;
  rate?: number;
  takes?: number;
  gain?: number;
  pitchJitter?: number;
  gainJitter?: number;
  priority?: number;
}

let banks = 0;

/**
 * Writes a bank of tones into the temp folder and loads it the way the engine
 * loads any bank. Its rules drop nothing and its curves are flat unless the
 * test says otherwise; `defaults` leaves both to the engine.
 */
function bankOf(spec: { sounds: Record<string, ToneSpec>; kinds?: Record<string, string | null>; rules?: Record<string, unknown>; curves?: Record<string, unknown>; gain?: number; defaults?: boolean }): SoundBank {
  const dir = join(DIR, `bank${banks++}`);
  mkdirSync(dir);
  const sounds: Record<string, unknown> = {};
  for (const [key, s] of Object.entries(spec.sounds)) {
    const files: string[] = [];
    for (let i = 0; i < (s.takes ?? 1); i++) {
      const file = `${key}-${i}.wav`;
      writeFileSync(join(dir, file), writeWav([tone((s.hz ?? 440) * (i + 1), s.seconds ?? 0.1, s.rate ?? SAMPLE_RATE)], s.rate ?? SAMPLE_RATE, 16));
      files.push(file);
    }
    sounds[key] = { file: files.length === 1 ? files[0] : files, gain: s.gain ?? 1, pitchJitter: s.pitchJitter ?? 0, gainJitter: s.gainJitter ?? 0, ...(s.priority === undefined ? {} : { priority: s.priority }) };
  }
  const json = {
    sounds,
    kinds: spec.kinds ?? {},
    ...(spec.defaults ? {} : { rules: { ...OFF, ...spec.rules }, curves: { ...FLAT, ...spec.curves } }),
    ...(spec.gain === undefined ? {} : { gain: spec.gain }),
  };
  writeFileSync(join(dir, 'bank.json'), JSON.stringify(json, null, 1));
  return loadBank(join(dir, 'bank.json'));
}

function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], seconds = 4, seed = 7): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed,
    palette,
    strings: { en: { 'label.a': 'A label' } },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    // A still camera: a place of the stage is that place on screen, moved by half a frame.
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, nodes })],
    timeline,
  });
}

async function eventsOf(spec: ShotSpec): Promise<SceneEvent[]> {
  const c = compileShot(spec);
  return sceneEvents(c, await bakeShot(c));
}

async function trackOf(spec: ShotSpec, bank: SoundBank): Promise<SoundTrack> {
  const c = compileShot(spec);
  return renderSound(c, await bakeShot(c), bank);
}

const one = (events: readonly SceneEvent[], kind: string, node: string | null): SceneEvent => {
  const hits = events.filter((e) => e.kind === kind && e.node === node);
  assert.equal(hits.length, 1, `one ${kind} event of ${node}, found ${hits.length}`);
  return hits[0]!;
};

const energy = (samples: ArrayLike<number>, from: number, to: number): number => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!;
  return sum;
};

test('sound events: every intent, every contact and every burst is an event on its frame', async () => {
  const events = await eventsOf(
    make(
      [
        link({ id: 'wire', from: 'a', to: 'r', color: 'mid.mist' }),
        circle({ id: 'a', at: [-300, 0], r: 40, fill: 'accent.amber', sound: 'marble' }),
        rect({ id: 'r', at: [300, -200], w: 100, h: 60, fill: 'accent.aqua' }),
        circle({ id: 'b', at: [0, 200], r: 30, fill: 'accent.coral', children: [eye({ id: 'e', r: 8, white: 'light.snow', pupil: 'deep.abyss', blink: false })] }),
        circle({ id: 't', at: [-800, -300], r: 20, fill: 'accent.pink' }),
        rect({ id: 'cup', at: [600, 200], w: 120, h: 160, fill: 'mid.ocean', level: 0.2 }),
        rect({ id: 'floor', at: [-600, 400], w: 400, h: 40, fill: 'dark.indigo', body: { kind: 'fixed' } }),
        circle({ id: 'ball', at: [-600, 250], r: 25, fill: 'accent.azure', body: { kind: 'dynamic', release: 0.1 } }),
        emitter({ id: 'sparks', at: [0, -300], colors: ['light.cream'], size: 4, life: 0.5, bursts: [{ at: 1, count: 16 }], onContact: { count: 6, minImpulse: 0 } }),
        label({ id: 'tag', text: 'label.a', target: 'a', fill: 'light.cream', ink: 'deep.night' }),
      ],
      [
        popIn('a', { at: 0.5 }),
        popIn('tag', { at: 0.7 }),
        moveTo('a', { at: 1, to: [300, 0], dur: 1 }),
        popOut('a', { at: 3 }),
        hop('b', { at: 1, to: [200, 200], dur: 0.5, height: 100 }),
        turnTo('r', { at: 0.2, to: 90 }),
        scaleTo('r', { at: 1.2, to: 2 }),
        scaleTo('r', { at: 2.4, to: 0.5 }),
        fadeTo('r', { at: 3, to: 0.2 }),
        bump('r', { at: 0.4 }),
        squash('r', { at: 0.6 }),
        levelTo('cup', { at: 0.5, to: 0.8, dur: 1 }),
        drawOn('wire', { at: 0.25, dur: 0.5 }),
        pulse('wire', { at: 2, dur: 0.5 }),
        openTo('e', { at: 0.3, to: 0.5 }),
        blink('e', { at: 1 }),
        travel('t', { at: 0.5, path: [[-800, -300], [-400, -350], [0, -300]], dur: 1 }),
        sfx('chime', { at: 2.2 }),
        sfx('chime', { at: 2.6, node: 'b', gain: 0.5 }),
      ],
    ),
  );

  // On its frame, in order, each with an id of its own, of a known kind.
  for (const e of events) {
    assert.equal(e.time, e.frame / 60, e.id);
    assert.ok((EVENT_KINDS as readonly string[]).includes(e.kind), e.kind);
  }
  assert.deepEqual(
    events.map((e) => e.frame),
    [...events].map((e) => e.frame).sort((x, y) => x - y),
  );
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);

  // What each intent becomes, and when.
  const at = (kind: string, node: string | null): number => one(events, kind, node).time;
  assert.equal(at('appear', 'a'), 0.5);
  assert.equal(at('label', 'tag'), 0.7, 'a label that pops in is a label, not an appear');
  assert.equal(at('disappear', 'a'), 3);
  assert.deepEqual(events.filter((e) => e.kind === 'move').map((e) => [e.node, e.time]), [['t', 0.5], ['a', 1], ['b', 1]]);
  assert.equal(at('land', 'b'), 1.5, 'a hop lands at at + dur');
  assert.equal(at('turn', 'r'), 0.2);
  assert.equal(at('grow', 'r'), 1.2);
  assert.equal(at('shrink', 'r'), 2.4, 'a scaleTo to a smaller size is a shrink');
  assert.equal(at('fade', 'r'), 3);
  assert.equal(at('bump', 'r'), 0.4);
  assert.equal(at('squash', 'r'), 0.6);
  assert.equal(at('level', 'cup'), 0.5);
  assert.equal(at('draw', 'wire'), 0.25);
  assert.equal(at('connect', 'wire'), 0.75, 'a link connects when its drawOn ends');
  assert.equal(at('pulse', 'wire'), 2.5, 'a pulse is an event where it arrives');
  assert.equal(at('open', 'e'), 0.3);
  assert.equal(at('blink', 'e'), 1);

  // What is seen of it: size, speed and place on screen, in px of a 1080p frame.
  const appear = one(events, 'appear', 'a');
  assert.equal(appear.key, 'marble', 'the sound key of the node');
  assert.ok(appear.size >= 80 && appear.size <= 95, `a circle of radius 40 that pops in: ${appear.size}`);
  assert.deepEqual([appear.x, appear.y], [660, 540]);
  assert.equal(appear.seen, true);
  const move = events.find((e) => e.kind === 'move' && e.node === 'a')!;
  assert.equal(move.size, 80);
  assert.ok(move.speed > 30 && move.speed < 80, `600 px in a second, at its peak: ${move.speed} px per frame`);
  assert.equal(move.dur, 1);
  const land = one(events, 'land', 'b');
  assert.ok(land.speed > 10 && land.speed < 20, `it comes down at speed: ${land.speed}`);
  assert.deepEqual([land.x, land.y, land.dur], [1160, 740, 0]);
  const drawn = one(events, 'draw', 'wire');
  const pulsed = one(events, 'pulse', 'wire');
  assert.ok(drawn.size > 500 && drawn.size < 800, `the length of the link: ${drawn.size}`);
  assert.ok(Math.abs(pulsed.speed - pulsed.size / 30) < 0.5, 'a pulse crosses its link in its duration');
  assert.deepEqual([pulsed.x, pulsed.y], [1260, 340], 'a pulse arrives at the far node');

  // Sounds placed by hand: in the middle, or where their node is.
  const placed = events.filter((e) => e.kind === 'sfx');
  assert.deepEqual(placed.map((e) => [e.time, e.node, e.sound, e.gain, e.x, e.y, e.seen]), [
    [2.2, null, 'chime', 1, 960, 540, true],
    [2.6, 'b', 'chime', 0.5, 1160, 740, true],
  ]);

  // Contacts of the bodies, and the bursts of the emitter: its own, and one per contact.
  const contacts = events.filter((e) => e.kind === 'contact');
  assert.ok(contacts.length >= 1);
  const hit = contacts[0]!;
  assert.deepEqual([hit.node, hit.other, hit.key, hit.otherKey], ['ball', 'floor', null, null], 'the dynamic body first');
  assert.ok(hit.impulse! > 0.1 && hit.time > 0.5 && hit.time < 1.2, `impulse ${hit.impulse} at ${hit.time} s`);
  assert.ok(Math.abs(hit.x - 360) < 30 && hit.y > 880 && hit.y < 930, `where they touch: ${hit.x}, ${hit.y}`);
  const bursts = events.filter((e) => e.kind === 'burst');
  assert.equal(bursts.length, 1 + contacts.length);
  const timed = bursts.find((e) => e.impulse === undefined)!;
  assert.deepEqual([timed.time, timed.node, timed.count, timed.x, timed.y], [1, 'sparks', 16, 960, 240]);
  assert.equal(timed.size, 2 * 4 * Math.sqrt(16), 'as large as a disc that holds its particles');
  assert.ok(bursts.some((e) => e.count === 6 && e.impulse === hit.impulse && e.frame === hit.frame), 'a burst where the bodies hit');
});

test('sound events: an intent can mute its events or name its sound; what starts before the shot is no event', async () => {
  const events = await eventsOf(
    make(
      [link({ id: 'wire', from: 'a', to: 'b', color: 'mid.mist' }), circle({ id: 'a', at: [-300, 0], r: 40, fill: 'accent.amber' }), circle({ id: 'b', at: [300, 0], r: 40, fill: 'accent.aqua' })],
      [
        hop('a', { at: 1, to: [-300, -100], dur: 0.5, sound: 'boing' }),
        hop('b', { at: 1, to: [300, -100], dur: 0.5, sound: false }),
        drawOn('wire', { at: 2, dur: 0.5, sound: 'zip' }),
        moveTo('a', { at: -0.5, to: [-300, 0], dur: 1 }),
        pulse('wire', { at: 3.2, dur: 0.5 }),
        pulse('wire', { at: 3.9, dur: 0.5 }),
      ],
    ),
  );
  // A key is the sound of the start; the arrival keeps the sound it would have.
  assert.equal(one(events, 'move', 'a').sound, 'boing');
  assert.equal('sound' in one(events, 'land', 'a'), false);
  assert.equal(one(events, 'draw', 'wire').sound, 'zip');
  assert.equal('sound' in one(events, 'connect', 'wire'), false);
  // false mutes all the intent does.
  assert.equal(one(events, 'move', 'b').sound, false);
  assert.equal(one(events, 'land', 'b').sound, false);
  // A move under way at frame 0 has no start in the shot; a pulse that arrives after the end has no arrival.
  assert.equal(events.filter((e) => e.kind === 'move').length, 2);
  assert.deepEqual(events.filter((e) => e.kind === 'pulse').map((e) => e.time), [3.7]);
});

test('sound events: what is hidden, off the frame, behind a cover or outside its clip is not seen, and stays silent', async () => {
  const fill = 'accent.amber';
  const spec = make(
    [
      circle({ id: 'shown', at: [0, 0], r: 40, fill }),
      circle({ id: 'faded', at: [-300, 0], r: 40, fill, opacity: 0 }),
      circle({ id: 'away', at: [3000, 0], r: 40, fill }),
      circle({ id: 'behind', at: [300, 0], r: 30, fill }),
      rect({ id: 'cover', at: [300, 0], w: 200, h: 200, fill: 'dark.indigo', cover: true }),
      rect({ id: 'window', at: [-600, 300], w: 100, h: 100, fill: 'dark.navy', opacity: 0 }),
      circle({ id: 'clipped', at: [600, 300], r: 30, fill, clipTo: 'window' }),
      circle({ id: 'late', at: [0, 300], r: 40, fill }),
    ],
    [
      ...['shown', 'faded', 'away', 'behind', 'clipped'].map((id) => bump(id, { at: 1 })),
      bump('late', { at: 0.5 }),
      popIn('late', { at: 2 }),
    ],
  );
  const events = await eventsOf(spec);
  const seen = Object.fromEntries(events.map((e) => [e.id, e.seen]));
  assert.deepEqual(seen, {
    'bump:late@30': false,
    'bump:shown@60': true,
    'bump:faded@60': false,
    'bump:away@60': false,
    'bump:behind@60': false,
    'bump:clipped@60': false,
    'appear:late@120': true,
  });

  // Only what is seen sounds: the track holds the two seen events and nothing else.
  const bank = bankOf({ sounds: { pop: {} }, kinds: { bump: 'pop', appear: 'pop' } });
  const track = await trackOf(spec, bank);
  assert.deepEqual(track.plan.voices.map((v) => v.event.id), ['bump:shown@60', 'appear:late@120']);
  assert.deepEqual(track.report.dropped.unseen.map((d) => d.id).sort(), ['bump:away@60', 'bump:behind@60', 'bump:clipped@60', 'bump:faded@60', 'bump:late@30']);
  assert.equal(energy(track.left, 0, 60 * SAMPLES_PER_FRAME), 0, 'silence until the first seen event');

  // A shot in which nothing is seen is silent from end to end.
  const blind = await trackOf(make([circle({ id: 'faded', r: 40, fill, opacity: 0 })], [bump('faded', { at: 1 }), popIn('faded', { at: 2 })]), bank);
  assert.equal(blind.plan.voices.length, 0);
  assert.ok(blind.left.every((v) => v === 0) && blind.right.every((v) => v === 0));
  assert.equal(blind.report.dropped.unseen.length, 2);
});

/** An event made by hand, for the tests of what is done with events. */
let made = 0;
function ev(over: Partial<SceneEvent> = {}): SceneEvent {
  const kind = over.kind ?? 'appear';
  const frame = Math.round((over.time ?? 0) * 60);
  const node = over.node === undefined ? `n${made++}` : over.node;
  return { id: `${kind}:${node}@${frame}`, kind, dur: 0, node, key: null, size: 100, speed: 20, x: 960, y: 540, seen: true, ...over, frame, time: frame / 60 };
}

function plan(events: SceneEvent[], bank: SoundBank, lengthOf: (key: string, take: number) => number = () => 0.1): SoundPlan {
  return planSound([...events].sort((a, b) => a.frame - b.frame), bank, { seed: 1, frames: 6000, lengthOf });
}

const heard = (p: SoundPlan): string[] => p.voices.map((v) => v.event.id);
const lost = (p: SoundPlan, rule: DropRule): string[] => p.dropped.filter((d) => d.rule === rule).map((d) => d.event.id);

test('sound bank: one event makes one sound: the scene decides, then the voice of the node, then the kind', () => {
  const bank = bankOf({
    sounds: { pop: {}, tick: {}, marble: {}, 'bell.contact': {}, 'wind.move': {}, whoosh: {} },
    kinds: { appear: 'pop', contact: 'tick', move: null },
  });
  const key = (e: SceneEvent): string | null => soundOf(bank, e).key;
  assert.equal(key(ev()), 'pop', 'the kind, when nothing else decides');
  assert.equal(key(ev({ key: 'marble' })), 'marble', 'the voice of the node instead of the kind');
  assert.equal(key(ev({ kind: 'contact', key: 'bell' })), 'bell.contact', 'the voice for that kind');
  assert.equal(key(ev({ kind: 'contact', key: 'marble', otherKey: 'bell' })), 'bell.contact', 'of either body, a sound for that kind first');
  assert.equal(key(ev({ kind: 'contact', key: null, otherKey: 'marble' })), 'marble');
  assert.equal(key(ev({ kind: 'move' })), null, 'a kind the bank maps to null is silent');
  assert.equal(key(ev({ kind: 'move', key: 'marble' })), null, 'and a voice does not wake it');
  assert.equal(key(ev({ kind: 'move', key: 'wind' })), 'wind.move', 'unless the voice has a sound for that very kind');
  assert.equal(key(ev({ kind: 'fade' })), null, 'a kind the bank leaves out is silent');
  assert.deepEqual(soundOf(bank, ev({ kind: 'move', sound: 'whoosh' })), { key: 'whoosh', from: 'scene', muted: false }, 'the scene names it');
  assert.deepEqual(soundOf(bank, ev({ sound: false })), { key: null, from: 'scene', muted: true }, 'the scene mutes it');

  // A contact of a node with a voice plays that voice once, and not the sound of the kind as well.
  const p = plan([ev({ kind: 'contact', key: 'bell', impulse: 1, node: 'drop' })], bank);
  assert.deepEqual(p.voices.map((v) => v.key), ['bell.contact']);
  // What has no sound is counted apart from what the rules drop.
  const q = plan([ev({ kind: 'move' }), ev({ sound: false }), ev()], bank);
  assert.deepEqual([q.voices.length, q.silent.length, q.muted.length, q.dropped.length], [1, 1, 1, 0]);
  assert.throws(() => plan([ev({ sound: 'nope' })], bank), /asks for the sound "nope", which the bank does not have/);
});

test('sound rules: a small thing, a slow move and a weak contact are silent', () => {
  const sounds = { pop: {}, whoosh: {}, tick: {} };
  const kinds = { appear: 'pop', move: 'whoosh', land: 'whoosh', contact: 'tick', burst: 'pop' };
  const small = plan([ev({ node: 'big', size: 30 }), ev({ node: 'tiny', size: 10 }), ev({ node: 'asked', size: 10, sound: 'pop' })], bankOf({ sounds, kinds, rules: { minSize: 24 } }));
  assert.deepEqual(lost(small, 'small'), ['appear:tiny@0']);
  assert.deepEqual(heard(small).sort(), ['appear:asked@0', 'appear:big@0'], 'a sound the scene named is wanted whatever the size');

  const slow = plan(
    [ev({ kind: 'move', node: 'fast', speed: 9 }), ev({ kind: 'move', node: 'crawl', speed: 2 }), ev({ kind: 'land', node: 'soft', speed: 1 }), ev({ node: 'still', speed: 0 })],
    bankOf({ sounds, kinds, rules: { minSpeed: 4 } }),
  );
  assert.deepEqual(lost(slow, 'slow'), ['move:crawl@0', 'land:soft@0'], 'only moves and landings are held to the speed');
  assert.deepEqual(heard(slow).sort(), ['appear:still@0', 'move:fast@0']);

  const weak = plan(
    [ev({ kind: 'contact', node: 'hard', impulse: 1 }), ev({ kind: 'contact', node: 'tap', impulse: 0.1 }), ev({ kind: 'burst', node: 'puff', impulse: 0.1 }), ev({ kind: 'burst', node: 'timed' })],
    bankOf({ sounds, kinds, rules: { minImpulse: 0.25 } }),
  );
  assert.deepEqual(lost(weak, 'weak'), ['contact:tap@0', 'burst:puff@0']);
  assert.deepEqual(heard(weak).sort(), ['burst:timed@0', 'contact:hard@0']);
});

test('sound rules: events of one kind close together sound as one, keep a least gap, and a crowd is a few voices', () => {
  const sounds = { pop: {}, tick: {} };
  const kinds = { appear: 'pop', contact: 'tick' };
  // Three pops within the window are one: the largest. A contact in the same moment is another kind.
  const merged = plan(
    [ev({ node: 'a', time: 1, size: 60 }), ev({ node: 'b', time: 1.03, size: 200 }), ev({ node: 'c', time: 1.06, size: 90 }), ev({ kind: 'contact', node: 'd', time: 1.03, impulse: 1 }), ev({ node: 'e', time: 1.2 })],
    bankOf({ sounds, kinds, rules: { mergeWindow: 0.08 }, curves: { size: SOUND_CURVES.size } }),
  );
  assert.deepEqual(lost(merged, 'merged').sort(), ['appear:a@60', 'appear:c@64']);
  assert.deepEqual(merged.dropped.map((d) => d.by), ['appear:b@62', 'appear:b@62'], 'the report names the event that sounds for them');
  assert.deepEqual(heard(merged), ['appear:b@62', 'contact:d@62', 'appear:e@72']);

  // A least gap between two sounds of one kind; another kind has its own.
  const gapped = plan(
    [ev({ node: 'a', time: 1 }), ev({ node: 'b', time: 1.4 }), ev({ node: 'c', time: 2 }), ev({ kind: 'contact', node: 'd', time: 1.2, impulse: 1 }), ev({ kind: 'contact', node: 'e', time: 1.4, impulse: 2 })],
    bankOf({ sounds, kinds, rules: { kindGap: 1, kindGaps: { contact: 0.1 } } }),
  );
  assert.deepEqual(lost(gapped, 'kind-gap'), ['appear:b@84']);
  assert.deepEqual(heard(gapped), ['appear:a@60', 'contact:d@72', 'contact:e@84', 'appear:c@120']);

  // A crowd: at most two of a kind in any five seconds, the strongest of them.
  const crowd = plan(
    [0, 1, 2, 3, 4, 5, 6].map((t, i) => ev({ node: `p${i}`, time: t, size: 50 + 10 * i })),
    bankOf({ sounds, kinds, rules: { crowdVoices: 2, crowdWindow: 5 }, curves: { size: SOUND_CURVES.size } }),
  );
  assert.deepEqual(heard(crowd), ['appear:p0@0', 'appear:p1@60', 'appear:p5@300', 'appear:p6@360'], 'the two strongest, and then what still fits');
  assert.deepEqual(lost(crowd, 'crowd'), ['appear:p4@240', 'appear:p3@180', 'appear:p2@120']);
  assert.equal(density(crowd.voices, 5).mostStarts, 2);
});

test('sound rules: any two starts keep a least gap, a window of time holds only so many starts, and so many voices sound at once', () => {
  const sounds = { pop: {}, tick: {}, thud: {}, chime: {} };
  const kinds = { appear: 'pop', contact: 'tick', land: 'thud', bump: 'pop', grow: 'pop', level: 'pop' };
  // A least gap between any two starts, whatever their kinds: the one that matters more stays.
  const gapped = plan(
    [ev({ node: 'a', time: 1 }), ev({ kind: 'contact', node: 'b', time: 1.2, impulse: 1 }), ev({ kind: 'bump', node: 'c', time: 1.6 }), ev({ kind: 'land', node: 'd', time: 3 })],
    bankOf({ sounds, kinds, rules: { gap: 0.5 } }),
  );
  assert.deepEqual(lost(gapped, 'gap').sort(), ['appear:a@60', 'bump:c@96']);
  assert.deepEqual(gapped.dropped.map((d) => d.by), ['contact:b@72', 'contact:b@72']);
  assert.deepEqual(heard(gapped), ['contact:b@72', 'land:d@180']);

  // At most four starts in any ten seconds.
  const many = [0, 1.5, 3, 4.5, 6, 7.5, 9, 10.5, 12].map((t, i) => ev({ kind: (['appear', 'contact', 'land', 'bump', 'grow', 'level'] as const)[i % 6]!, node: `m${i}`, time: t, impulse: 1 }));
  const capped = plan(many, bankOf({ sounds, kinds, rules: { starts: 4, startsWindow: 10 } }));
  assert.equal(density(capped.voices, 10).mostStarts, 4);
  assert.equal(lost(capped, 'starts').length + heard(capped).length, many.length);
  assert.ok(lost(capped, 'starts').length >= 3);
  // The same events without the cap all sound: nine starts, seven of them in ten seconds.
  assert.equal(density(plan(many, bankOf({ sounds, kinds })).voices, 10).mostStarts, 7);

  // At most two voices at once: three long sounds that overlap lose the one that matters least.
  const long = plan(
    [ev({ kind: 'land', node: 'a', time: 0 }), ev({ kind: 'contact', node: 'b', time: 1, impulse: 1 }), ev({ node: 'c', time: 2 }), ev({ node: 'd', time: 6 })],
    bankOf({ sounds, kinds, rules: { voices: 2 } }),
    () => 3,
  );
  assert.deepEqual(lost(long, 'voices'), ['appear:c@120']);
  assert.equal(density(long.voices, 10).mostVoices, 2);
  assert.deepEqual(heard(long), ['land:a@0', 'contact:b@60', 'appear:d@360']);
});

test('sound rules: what matters more keeps its sound: a placed sound, a named one, the priorities of the bank, the stronger', () => {
  const sounds = { pop: {}, tick: {}, marble: {}, gem: { priority: 1 }, chime: {}, big: { priority: 5 } };
  const kinds = { appear: 'pop', contact: 'tick', grow: 'big' };
  const pair = (a: Partial<SceneEvent>, b: Partial<SceneEvent>, rules: Record<string, unknown> = {}): string[] =>
    heard(plan([ev({ node: 'a', time: 1, ...a }), ev({ node: 'b', time: 1.2, ...b })], bankOf({ sounds, kinds, rules: { gap: 0.5, ...rules }, curves: { size: SOUND_CURVES.size } })));
  // By kind: a contact before an appearance, unless the bank puts appearances first.
  assert.deepEqual(pair({}, { kind: 'contact', impulse: 1 }), ['contact:b@72']);
  assert.deepEqual(pair({}, { kind: 'contact', impulse: 1 }, { priority: ['appear'] }), ['appear:a@60']);
  // Of one kind: the stronger.
  assert.deepEqual(pair({ size: 300 }, { size: 60 }), ['appear:a@60']);
  assert.deepEqual(pair({ size: 60 }, { size: 300 }), ['appear:b@72']);
  // The priority the bank gives a sound goes before the kind and the strength.
  assert.deepEqual(pair({ kind: 'contact', impulse: 1 }, { kind: 'grow', size: 30 }), ['grow:b@72']);
  // The voice of a node ranks as the bank ranks its sound, not by itself.
  assert.deepEqual(pair({ kind: 'contact', impulse: 1 }, { key: 'marble', size: 30 }), ['contact:a@60']);
  assert.deepEqual(pair({ kind: 'contact', impulse: 1 }, { key: 'gem', size: 30 }), ['appear:b@72']);
  // A sound the scene names on an intent goes before any priority of the bank; a placed sound goes first.
  assert.deepEqual(pair({ kind: 'grow' }, { sound: 'pop', size: 30 }), ['appear:b@72']);
  assert.deepEqual(pair({ sound: 'pop' }, { kind: 'sfx', sound: 'chime', node: null }), ['sfx:null@72']);

  // A placed sound always sounds: no rule drops it, and the others make room for it.
  const strict = bankOf({ sounds, kinds, rules: { gap: 0.5, starts: 1, startsWindow: 10, voices: 1, minSize: 500 } });
  const forced = plan([ev({ kind: 'sfx', sound: 'chime', node: null, time: 1, size: 0, seen: false }), ev({ kind: 'sfx', sound: 'chime', node: 'x', time: 1.1, size: 0 }), ev({ node: 'c', time: 3, size: 900 })], strict, () => 2);
  assert.deepEqual(heard(forced), ['sfx:null@60', 'sfx:x@66']);
  assert.deepEqual(lost(forced, 'starts'), ['appear:c@180']);
});

test('sound rules: the defaults are quiet, and a bank changes only what it names', () => {
  assert.deepEqual(
    [SOUND_RULES.gap, SOUND_RULES.starts, SOUND_RULES.startsWindow, SOUND_RULES.minSize, SOUND_RULES.minSpeed, SOUND_RULES.minImpulse],
    [0.5, 4, 10, 24, 4, 0.25],
    'a least gap of half a second, four starts in any ten seconds',
  );
  assert.deepEqual([...SOUND_RULES.priority].sort(), [...EVENT_KINDS].sort(), 'every kind has its place in the order');
  const bank = parseBank({ sounds: { pop: { file: 'pop.wav' } }, rules: { gap: 1, priority: ['move', 'appear'] }, curves: { speed: [[0, 0.2], [10, 1]] } }, DIR);
  assert.deepEqual(bank.rules, { ...SOUND_RULES, gap: 1, priority: ['move', 'appear', ...SOUND_RULES.priority.filter((k) => k !== 'move' && k !== 'appear')] });
  assert.deepEqual(bank.curves, { ...SOUND_CURVES, speed: [[0, 0.2], [10, 1]] });
  assert.deepEqual(bank.sounds['pop'], { files: [join(DIR, 'pop.wav')], gain: 1, pitchJitter: 0.5, gainJitter: 0.1, priority: 0 });
  assert.equal(curveAt(bank.curves.speed, -5), 0.2);
  assert.ok(Math.abs(curveAt(bank.curves.speed, 5) - 0.6) < 1e-12, 'half-way between two points');
  assert.equal(curveAt(bank.curves.speed, 50), 1);

  // A busy second under the defaults: twenty pops and twenty contacts leave a handful of sounds.
  const busy = [...Array.from({ length: 20 }, (_, i) => ev({ node: `p${i}`, time: 1 + i * 0.05 })), ...Array.from({ length: 20 }, (_, i) => ev({ kind: 'contact', node: `c${i}`, time: 1 + i * 0.05, impulse: 0.2 + i * 0.1 }))];
  const p = plan(busy, bankOf({ sounds: { pop: {}, tick: {} }, kinds: { appear: 'pop', contact: 'tick' }, defaults: true }));
  assert.ok(p.voices.length >= 1 && p.voices.length <= 3, `${p.voices.length} sounds`);
  assert.equal(p.voices.length + p.dropped.length, busy.length);

  // A bank that is not one says what is wrong with it.
  const bad = (json: unknown, message: RegExp): void => {
    assert.throws(() => parseBank(json, DIR), (e: unknown) => e instanceof BankError && message.test(e.message));
  };
  bad({}, /"sounds" must hold at least one sound/);
  bad({ sounds: { 'Bad Key': { file: 'a.wav' } } }, /a key is lower-case parts/);
  bad({ sounds: { pop: {} } }, /"file" must be the path of a WAV file/);
  bad({ sounds: { pop: { file: 'a.wav', loud: 2 } } }, /unknown field "loud"/);
  bad({ sounds: { pop: { file: 'a.wav' } }, kinds: { appear: 'plop' } }, /kind "appear" is mapped to "plop", which is not a sound of the bank/);
  bad({ sounds: { pop: { file: 'a.wav' } }, kinds: { explode: 'pop' } }, /"explode", which is not a kind of event/);
  bad({ sounds: { pop: { file: 'a.wav' } }, rules: { startsPerSecond: 4 } }, /unknown field "startsPerSecond"/);
  bad({ sounds: { pop: { file: 'a.wav' } }, curves: { size: [[10, 1], [5, 0.5]] } }, /rising order of x/);
  assert.throws(() => loadBank(join(DIR, 'no-such-bank.json')), /bank of sounds not found/);
});

test('sound track: 48 kHz stereo, exactly as long as the shot, each sound on the first sample of its frame', async () => {
  const bank = bankOf({ sounds: { pop: { hz: 480, seconds: 0.1 }, chime: { hz: 480, seconds: 2 } }, kinds: { appear: 'pop' }, gain: 0.5, curves: { size: [[0, 0.5]] } });
  const spec = make([circle({ id: 'a', r: 40, fill: 'accent.amber' })], [popIn('a', { at: 0.5 }), sfx('chime', { at: 2.5, gain: 2 })], 3);
  const track = await trackOf(spec, bank);
  const frames = 180;
  const samples = frames * SAMPLES_PER_FRAME;
  assert.equal(SAMPLES_PER_FRAME, 800);

  // The file: a 24-bit PCM WAV with nothing but its header and its samples.
  assert.equal(track.wav.length, 44 + samples * 2 * 3);
  const view = new DataView(track.wav.buffer, track.wav.byteOffset);
  assert.deepEqual([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true), view.getUint32(40, true)], [1, 2, 48000, 24, samples * 6]);
  const back = readWav(track.wav);
  assert.deepEqual([back.rate, back.channels.length, back.channels[0]!.length], [48000, 2, samples]);
  assert.deepEqual([track.left.length, track.right.length], [samples, samples]);

  // The pop starts on the first sample of frame 30, at the gain of the track, the sound and the curve.
  const start = 30 * SAMPLES_PER_FRAME;
  assert.equal(energy(track.left, 0, start), 0);
  assert.ok(Math.abs(track.left[start]! - 0.5 * 0.5 * 0.5) < 1e-4, `first sample ${track.left[start]}`);
  assert.equal(track.left[start], track.right[start], 'in the middle of the frame: the same in both channels');
  assert.ok(Math.abs(back.channels[0]![start]! - 0.125) < 1e-4, 'and so it stands in the file');
  assert.equal(energy(track.left, start + 4800 + 1, 150 * SAMPLES_PER_FRAME), 0, 'silence after its tenth of a second');

  // The placed sound takes its own gain and no curve, and is cut, faded, where the shot ends.
  const placed = track.plan.voices[1]!;
  assert.deepEqual([placed.frame, placed.seconds, placed.gain], [150, 0.5, 0.5 * 2]);
  assert.ok(Math.abs(track.left[150 * SAMPLES_PER_FRAME]! - 0.5) < 1e-4);
  assert.equal(track.left[samples - 1], 0);
  assert.ok(Math.abs(track.left[samples - 200]!) < 0.25, 'fading');

  // The report: how dense the track is, and what was heard.
  const r = track.report;
  assert.deepEqual([r.frames, r.seconds, r.sampleRate, r.channels, r.bits, r.samples, r.events, r.starts, r.startsPerMinute], [180, 3, 48000, 2, 24, samples, 2, 2, 40]);
  assert.deepEqual(r.voices.map((v) => [v.id, v.time, v.sound]), [['appear:a@30', 0.5, 'pop'], ['sfx:chime@150', 2.5, 'chime']]);
  assert.ok(Math.abs(r.peak - 0.5) < 1e-3 && r.clipped === 0);
  assert.deepEqual(Object.keys(r.dropped), [...DROP_RULES]);
});

test('sound track: pan follows the place on screen, and a sound of another rate keeps its pitch', async () => {
  const bank = bankOf({ sounds: { pop: { hz: 600, seconds: 0.1 }, low: { hz: 600, seconds: 0.1, rate: 22050 } }, kinds: { appear: 'pop', bump: 'low' }, rules: { pan: 0.6 } });
  const track = await trackOf(
    make(
      [circle({ id: 'l', at: [-800, 0], r: 40, fill: 'accent.amber' }), circle({ id: 'm', at: [0, 0], r: 40, fill: 'accent.amber' }), circle({ id: 'r', at: [800, 0], r: 40, fill: 'accent.amber' })],
      [popIn('l', { at: 0.5 }), popIn('m', { at: 1 }), popIn('r', { at: 1.5 }), bump('m', { at: 2.5 })],
    ),
    bank,
  );
  const span = (frame: number): [number, number] => [energy(track.left, frame * 800, frame * 800 + 4800), energy(track.right, frame * 800, frame * 800 + 4800)];
  const [ll, lr] = span(30);
  const [ml, mr] = span(60);
  const [rl, rr] = span(90);
  assert.ok(ll > 3 * lr && rr > 3 * rl, `left ${ll}/${lr}, right ${rl}/${rr}`);
  assert.equal(ml, mr);
  assert.ok(Math.abs(ll + lr - (ml + mr)) < 0.01 * (ml + mr), 'the power of a sound does not change with its place');
  assert.deepEqual(track.plan.voices.map((v) => v.pan), [-0.5, 0, 0.5, 0]);

  // A take recorded at 22.05 kHz sounds as long and as high as it was: 600 Hz for a tenth of a second.
  const from = 150 * 800;
  let crossings = 0;
  for (let i = from + 1; i < from + 4800; i++) if (track.left[i - 1]! < 0 !== track.left[i]! < 0) crossings++;
  assert.ok(Math.abs(crossings - 120) <= 2, `${crossings} zero crossings in a tenth of a second`);
  assert.ok(energy(track.left, from + 5000, from + 9600) < 1e-6 * energy(track.left, from, from + 4800));
});

test('sound track: the same scene, bank and seed give the same bytes; the seed turns the jitter', async () => {
  const bank = bankOf({ sounds: { pop: { takes: 3, pitchJitter: 2, gainJitter: 0.3 }, tick: { pitchJitter: 2, gainJitter: 0.3 } }, kinds: { appear: 'pop', contact: 'tick', bump: 'pop' } });
  const nodes = (): LayerSpec['nodes'] => [
    circle({ id: 'a', at: [-300, -200], r: 40, fill: 'accent.amber' }),
    circle({ id: 'b', at: [300, -200], r: 40, fill: 'accent.aqua' }),
    rect({ id: 'floor', at: [0, 400], w: 800, h: 40, fill: 'dark.indigo', body: { kind: 'fixed' } }),
    circle({ id: 'ball', at: [0, 100], r: 25, fill: 'accent.azure', body: { kind: 'dynamic', release: 0.1 } }),
  ];
  const keys = (): Key[] => [popIn('a', { at: 0.5 }), popIn('b', { at: 1 }), bump('a', { at: 2 }), bump('b', { at: 2.5 }), bump('a', { at: 3 })];
  const first = await trackOf(make(nodes(), keys()), bank);
  const again = await trackOf(make(nodes(), keys()), bank);
  assert.ok(first.plan.voices.length >= 6);
  assert.equal(Buffer.compare(first.wav, again.wav), 0, 'two runs from scratch');
  assert.deepEqual(first.report, again.report);
  const other = await trackOf(make(nodes(), keys(), 4, 8), bank);
  assert.notEqual(Buffer.compare(first.wav, other.wav), 0, 'another seed');

  // The jitter stays within what the bank allows, and two repeats do not sound the same.
  const pops = first.plan.voices.filter((v) => v.key === 'pop');
  for (const v of pops) {
    assert.ok(v.pitch >= 2 ** (-2 / 12) && v.pitch <= 2 ** (2 / 12) && v.gain >= 0.7 && v.gain <= 1.3, `pitch ${v.pitch}, gain ${v.gain}`);
    assert.ok(v.take >= 0 && v.take <= 2);
  }
  assert.ok(new Set(pops.map((v) => v.pitch)).size === pops.length && new Set(pops.map((v) => v.take)).size >= 2);

  // The jitter of an event is its own: an event more, before all the others, does not change them.
  const more = await trackOf(make(nodes(), [bump('b', { at: 0.2 }), ...keys()]), bank);
  assert.equal(more.events[0]!.id, 'bump:b@12');
  for (const v of first.plan.voices) {
    const same = more.plan.voices.find((w) => w.event.id === v.event.id)!;
    assert.deepEqual([same.pitch, same.gain, same.take], [v.pitch, v.gain, v.take], v.event.id);
  }
});

test('sound check: with a bank, a sound key it does not know fails the checks, as a missing string does', async () => {
  const spec = make(
    [circle({ id: 'a', r: 40, fill: 'accent.amber', sound: 'marble' }), circle({ id: 'b', at: [200, 0], r: 40, fill: 'accent.aqua', sound: 'bell' }), circle({ id: 'c', at: [-200, 0], r: 40, fill: 'accent.aqua', sound: 'gong' })],
    [popIn('a', { at: 0.5 }), moveTo('a', { at: 1, to: [0, 200], sound: 'whoosh' }), bump('a', { at: 2.5, sound: false }), sfx('chime', { at: 3 })],
  );
  const c = compileShot(spec);
  const bake = await bakeShot(c);

  // Without a bank the checks say nothing about sound.
  const plain = runChecks(c, bake);
  assert.deepEqual([plain.ok, plain.sound, plain.issues.length], [true, null, 0]);
  assert.doesNotMatch(formatReport(plain), /sound/);

  // A voice is known by its own sound or by one for a kind; a named sound by its name.
  const good = runChecks(c, bake, undefined, { bank: bankOf({ sounds: { marble: {}, 'bell.contact': {}, 'gong.appear': {}, whoosh: {}, chime: {} } }) });
  assert.deepEqual([good.ok, good.sound], [true, ['bell', 'chime', 'gong', 'marble', 'whoosh']]);
  assert.match(formatReport(good), /^sound: ok$/m);

  const bank = bankOf({ sounds: { pop: {}, 'marble.contact': {} }, kinds: { appear: 'pop' } });
  const report = runChecks(c, bake, undefined, { bank });
  assert.equal(report.ok, false);
  const messages = report.issues.filter((i) => i.check === 'sound').map((i) => i.message);
  assert.equal(messages.length, 4, messages.join('\n'));
  assert.match(messages[0]!, /shape "b" has the sound key "bell", which the bank does not know/);
  assert.match(messages[1]!, /shape "c" has the sound key "gong"/);
  assert.match(messages[2]!, /moveTo\("a"\) at 1 s asks for the sound "whoosh", which the bank does not have \(the bank has: marble\.contact, pop\)/);
  assert.match(messages[3]!, /sfx\("chime"\) at 3 s asks for the sound "chime"/);
  assert.match(formatReport(report), /sound: 4 problem\(s\)[\s\S]*checks FAILED/);
  // A track is not made from a shot that asks for sounds the bank does not know, or from a file that is not there.
  assert.throws(() => renderSound(c, bake, bank), (e: unknown) => e instanceof BankError && /asks for sounds the bank does not know/.test(e.message));
  const gone = parseBank({ sounds: { marble: { file: 'gone.wav' }, bell: { file: 'gone.wav' }, gong: { file: 'gone.wav' }, whoosh: { file: 'gone.wav' }, chime: { file: 'gone.wav' } } }, DIR);
  assert.throws(() => renderSound(c, bake, gone), (e: unknown) => e instanceof BankError && /gone\.wav cannot be read/.test(e.message));
});

test('sound: a scene with sound is the same picture: the same scene hash, the same bake, the same pixels', async () => {
  const build = (voiced: boolean): ShotSpec =>
    make(
      [
        link({ id: 'wire', from: 'a', to: 'b', color: 'mid.mist', ...(voiced ? { sound: 'zip' } : {}) }),
        circle({ id: 'a', at: [-300, 0], r: 40, fill: 'accent.amber', follow: 'springy', ...(voiced ? { sound: 'marble' } : {}) }),
        circle({ id: 'b', at: [300, 0], r: 40, fill: 'accent.aqua', children: [eye({ id: 'e', r: 8, white: 'light.snow', pupil: 'deep.abyss', ...(voiced ? { sound: 'eye' } : {}) })] }),
        rect({ id: 'floor', at: [0, 400], w: 800, h: 40, fill: 'dark.indigo', body: { kind: 'fixed' } }),
        circle({ id: 'ball', at: [0, 100], r: 25, fill: 'accent.azure', body: { kind: 'dynamic', release: 0.1 }, ...(voiced ? { sound: 'ball' } : {}) }),
        emitter({ id: 'sparks', at: [0, -300], colors: ['light.cream'], size: 4, life: 0.5, rate: 20, ...(voiced ? { sound: 'spark' } : {}) }),
        label({ id: 'tag', text: 'label.a', target: 'a', fill: 'light.cream', ink: 'deep.night', ...(voiced ? { sound: 'tag' } : {}) }),
      ],
      [
        popIn('a', { at: 0.5, ...(voiced ? { sound: 'pop' } : {}) }),
        moveTo('a', { at: 1, to: [-300, -200], ...(voiced ? { sound: false as const } : {}) }),
        pulse('wire', { at: 2, ...(voiced ? { sound: 'tick' } : {}) }),
        ...(voiced ? [sfx('chime', { at: 1.5, node: 'b' }), sfx('chime', { at: 3 })] : []),
      ],
    );
  const plain = compileShot(build(false));
  const voiced = compileShot(build(true));
  assert.equal(voiced.sceneHash, plain.sceneHash);
  const [bakePlain, bakeVoiced] = [await bakeShot(plain), await bakeShot(voiced)];
  assert.equal(bakeHash(bakeVoiced), bakeHash(bakePlain));
  for (const frame of [0, 45, 100, 130, 239]) {
    const a = await frameRaw(plain, bakePlain, frame, { width: 320, lang: 'en', gpu: false });
    const b = await frameRaw(voiced, bakeVoiced, frame, { width: 320, lang: 'en', gpu: false });
    assert.equal(Buffer.compare(a, b), 0, `frame ${frame}`);
  }
  // A bake made for the one serves the other.
  assert.equal(sceneEvents(voiced, bakePlain).length, sceneEvents(voiced, bakeVoiced).length);

  // A node and a key that say nothing about sound are the data they always were.
  assert.equal('sound' in circle({ id: 'x', r: 10, fill: 'accent.amber' }), false);
  assert.equal('sound' in popIn('x', { at: 1 }), false);
  assert.equal(circle({ id: 'x', r: 10, fill: 'accent.amber', sound: 'marble.small' }).sound, 'marble.small');
  assert.deepEqual(sfx('chime', { at: 1 }), { kind: 'sfx', target: null, at: 1, sound: 'chime', gain: 1 });

  // A sound key is a key, and a placed sound names a node that has a place.
  assert.throws(() => circle({ id: 'x', r: 10, fill: 'accent.amber', sound: 'A sound' }), /sound must be the key of a sound/);
  assert.throws(() => popIn('x', { at: 1, sound: 'Loud!' }), /sound must be false \(the intent is silent\) or the key of a sound/);
  assert.throws(() => hop('x', { at: 1, to: [0, 0], sound: 3 as unknown as string }), /sound must be false/);
  assert.throws(() => sfx('Chime', { at: 1 }), /the first argument is the key of a sound/);
  assert.throws(() => sfx('chime', { at: -1 }), /at must be a number in 0\.\.3600/);
  assert.throws(() => make([circle({ id: 'a', r: 10, fill: 'accent.amber' })], [sfx('chime', { at: 1, node: 'nobody' })]), /sfx\("chime"\) names the node "nobody", which does not exist/);
  assert.throws(() => make([circle({ id: 'a', r: 10, fill: 'accent.amber' })], [sfx('chime', { at: 9 })]), /sfx\("chime"\) is placed at 9 s, after the shot ends/);
  assert.throws(
    () => make([circle({ id: 'a', r: 10, fill: 'accent.amber' }), emitter({ id: 'em', colors: ['light.cream'], size: 4, life: 1, rate: 5 })], [sfx('chime', { at: 1, node: 'em' })]),
    /it must be a shape, a group, an eye or a label/,
  );
});

test('wav: PCM of 8, 16, 24 and 32 bits and float, mono and stereo, is read; anything else says what it is', () => {
  const left = tone(440, 0.01);
  const right = tone(660, 0.01, SAMPLE_RATE, 0.25);
  for (const bits of [16, 24, 32] as const) {
    const wav = readWav(writeWav([left, right], 44100, bits));
    assert.deepEqual([wav.rate, wav.channels.length, wav.channels[0]!.length], [44100, 2, left.length]);
    const tolerance = bits === 16 ? 1 / 32000 : 1e-6;
    for (let i = 0; i < left.length; i++) {
      assert.ok(Math.abs(wav.channels[0]![i]! - left[i]!) <= tolerance && Math.abs(wav.channels[1]![i]! - right[i]!) <= tolerance, `${bits} bits, sample ${i}`);
    }
  }
  assert.equal(readWav(writeWav([left], 48000, 16)).channels.length, 1);
  // Full scale is held, not wrapped.
  assert.deepEqual(Array.from(readWav(writeWav([[2, -2, 1, -1]], 48000, 24)).channels[0]!).map((v) => Math.round(v * 1000) / 1000), [1, -1, 1, -1]);

  // By hand: 8-bit unsigned, 32-bit integer, the extensible header, a chunk before the format, an odd chunk.
  const riff = (format: number, channels: number, bits: number, data: number[], opts: { extensible?: boolean; junk?: boolean } = {}): Uint8Array => {
    const fmtSize = opts.extensible ? 40 : 16;
    const junk = opts.junk ? [0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0] : [];
    const out = new Uint8Array(12 + junk.length + 8 + fmtSize + 8 + data.length);
    const view = new DataView(out.buffer);
    out.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    out.set(junk, 12);
    let at = 12 + junk.length;
    out.set([0x66, 0x6d, 0x74, 0x20], at);
    view.setUint32(at + 4, fmtSize, true);
    view.setUint16(at + 8, opts.extensible ? 0xfffe : format, true);
    view.setUint16(at + 10, channels, true);
    view.setUint32(at + 12, 8000, true);
    view.setUint16(at + 20, (channels * bits) / 8, true);
    view.setUint16(at + 22, bits, true);
    if (opts.extensible) view.setUint16(at + 32, format, true);
    at += 8 + fmtSize;
    out.set([0x64, 0x61, 0x74, 0x61], at);
    view.setUint32(at + 4, data.length, true);
    out.set(data, at + 8);
    return out;
  };
  assert.deepEqual(Array.from(readWav(riff(1, 1, 8, [128, 255, 0, 192])).channels[0]!), [0, 127 / 128, -1, 0.5]);
  assert.deepEqual(Array.from(readWav(riff(1, 1, 32, [0, 0, 0, 0x40, 0, 0, 0, 0x80])).channels[0]!), [0.5, -1]);
  assert.deepEqual(Array.from(readWav(riff(1, 2, 16, [0, 0x40, 0, 0xc0], { extensible: true, junk: true })).channels.map((c) => c[0])), [0.5, -0.5]);
  assert.equal(readWav(riff(3, 1, 32, [0, 0, 0, 0x3f])).channels[0]![0], 0.5);

  const refuses = (bytes: Uint8Array, message: RegExp): void => {
    assert.throws(() => readWav(bytes, 'take.wav'), (e: unknown) => e instanceof WavError && message.test(e.message));
  };
  refuses(new Uint8Array([1, 2, 3]), /take\.wav is not a WAV file/);
  refuses(riff(85, 2, 16, [0, 0, 0, 0]), /compressed WAV \(format 85\); only PCM/);
  refuses(riff(1, 6, 16, new Array(12).fill(0) as number[]), /6 channels; a sound is mono or stereo/);
  refuses(riff(1, 1, 12, [0, 0]), /12-bit integer samples/);
  assert.throws(() => writeWav([left, tone(440, 0.02)], 48000), /same length/);
});

test('resample: a step of one is the signal itself; another step keeps the tone and changes its length', () => {
  const source = tone(1000, 0.05);
  assert.deepEqual(resample(source, 1), source);
  const count = (signal: Float32Array): number => {
    let crossings = 0;
    for (let i = 1; i < signal.length; i++) if (signal[i - 1]! < 0 !== signal[i]! < 0) crossings++;
    return crossings;
  };
  // Twice as fast: half as long, the same number of periods; the level stays.
  const up = resample(source, 2);
  assert.equal(up.length, source.length / 2);
  assert.ok(Math.abs(count(up) - count(source)) <= 1);
  const peak = (signal: Float32Array): number => signal.slice(200, signal.length - 200).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(Math.abs(peak(up) - 0.5) < 0.01 && Math.abs(peak(resample(source, 0.7)) - 0.5) < 0.01, 'a tone keeps its level');
  assert.ok(Math.abs(resample(source, 0.5).length - 2 * source.length) <= 1);
  // What a step above one could not carry is taken out, not folded back: 20 kHz read at every second sample is silence.
  assert.ok(peak(resample(tone(20000, 0.05), 2)) < 0.01);
  assert.throws(() => resample(source, 0), /positive/);
});

test('cli: events and sfx write their files; check --bank holds the sound keys against the bank', () => {
  const cwd = mkdtempSync(join(DIR, 'cli-'));
  const run = (...args: string[]): { status: number | null; out: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  };
  const bank = bankOf({ sounds: { pop: {}, 'bell.contact': {}, whoosh: { seconds: 0.3 }, chime: { seconds: 0.4 } }, kinds: { appear: 'pop' }, defaults: true });
  const bankFile = join(bank.dir, 'bank.json');

  const events = run('events', FIXTURE);
  assert.equal(events.status, 0, events.out);
  assert.match(events.out, /events sound: \d+ event\(s\) in 180 frames, \d+ of them seen/);
  const list = JSON.parse(readFileSync(join(cwd, 'out', 'sound', 'events.json'), 'utf8')) as { shot: string; frames: number; kinds: string[]; events: SceneEvent[] };
  assert.deepEqual([list.shot, list.frames, list.kinds], ['sound', 180, [...EVENT_KINDS]]);
  assert.deepEqual(list.events.filter((e) => e.kind !== 'contact').map((e) => [e.kind, e.node, e.key, e.sound, e.time]), [
    ['appear', 'bell', 'bell', undefined, 0.5],
    ['move', 'mover', null, 'whoosh', 1],
    ['appear', 'quiet', null, false, 1.5],
    ['sfx', null, null, 'chime', 2.5],
  ]);
  assert.ok(list.events.some((e) => e.kind === 'contact' && e.node === 'drop' && e.key === 'bell' && e.other === 'ledge'));

  const first = run('sfx', FIXTURE, '--bank', bankFile);
  assert.equal(first.status, 0, first.out);
  assert.match(first.out, /sfx sound: 180 frames \(3\.00 s\), 48 kHz, 2 channels, 24 bits, seed 5/);
  assert.match(first.out, /at most \d in any 10 s \(limit 4\)/);
  const wavFile = join(cwd, 'out', 'sound', 'sound_sfx.wav');
  assert.equal(statSync(wavFile).size, 44 + 180 * 800 * 2 * 3);
  const report = JSON.parse(readFileSync(join(cwd, 'out', 'sound', 'sfx.json'), 'utf8')) as { starts: number; mostStarts: number; startsWindow: number; muted: number; dropped: Record<string, unknown[]>; voices: { sound: string }[] };
  assert.ok(report.starts >= 2 && report.mostStarts <= 4 && report.startsWindow === 10);
  assert.equal(report.muted, 1);
  assert.deepEqual(Object.keys(report.dropped), [...DROP_RULES]);
  assert.ok(report.voices.some((v) => v.sound === 'whoosh') && report.voices.some((v) => v.sound === 'chime'));
  // Run again: the same bytes.
  const bytes = readFileSync(wavFile);
  assert.equal(run('sfx', FIXTURE, '--bank', bankFile).status, 0);
  assert.equal(Buffer.compare(bytes, readFileSync(wavFile)), 0);
  // Somewhere else: the report lies next to the track.
  assert.equal(run('sfx', FIXTURE, '--bank', bankFile, '--out', 'mix/track.wav').status, 0);
  assert.ok(existsSync(join(cwd, 'mix', 'track.wav')) && existsSync(join(cwd, 'mix', 'track.wav.json')));

  const needsBank = run('sfx', FIXTURE);
  assert.equal(needsBank.status, 1);
  assert.match(needsBank.out, /sfx: give --bank <bank\.json>/);

  // check: fine with a bank that knows the keys, failing with one that does not, silent about sound without one.
  const ok = run('check', FIXTURE, '--bank', bankFile);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /^sound: ok$/m);
  const poor = bankOf({ sounds: { pop: {} }, kinds: { appear: 'pop' } });
  const failing = run('check', FIXTURE, '--bank', join(poor.dir, 'bank.json'));
  assert.equal(failing.status, 1, failing.out);
  assert.match(failing.out, /sound: 4 problem\(s\)/);
  assert.match(failing.out, /shape "bell" has the sound key "bell", which the bank does not know/);
  assert.match(failing.out, /moveTo\("mover"\) at 1 s asks for the sound "whoosh"/);
  assert.match(failing.out, /checks FAILED/);
  const plain = run('check', FIXTURE);
  assert.equal(plain.status, 0, plain.out);
  assert.doesNotMatch(plain.out, /^sound:/m);
  const noTrack = run('sfx', FIXTURE, '--bank', join(poor.dir, 'bank.json'));
  assert.equal(noTrack.status, 1);
  assert.match(noTrack.out, /asks for sounds the bank does not know/);
  assert.equal(formatSoundReport(JSON.parse(readFileSync(join(cwd, 'out', 'sound', 'sfx.json'), 'utf8'))).split('\n')[0], first.out.split('\n')[0]);
});
