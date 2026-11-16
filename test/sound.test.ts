import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Canvas, loadImage } from 'skia-canvas';
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
  renderSoundSheet,
  resample,
  runChecks,
  sampleMotion,
  SAMPLE_RATE,
  SAMPLES_PER_FRAME,
  scaleTo,
  sceneEvents,
  sfx,
  shot,
  showersOf,
  SOUND_CURVES,
  SOUND_RULES,
  soundOf,
  soundTiles,
  squash,
  tileCaption,
  tileRing,
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
// track from being crowded, the rules a sound sets for its own events, the
// track itself, and the sheet that shows which event each sound belongs to.
// The engine holds no sound files, so every sound here is a tone the test
// makes.

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
  /** Rules of its own for its events, as the bank writes them. */
  rules?: Record<string, unknown>;
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
    sounds[key] = { file: files.length === 1 ? files[0] : files, gain: s.gain ?? 1, pitchJitter: s.pitchJitter ?? 0, gainJitter: s.gainJitter ?? 0, ...(s.priority === undefined ? {} : { priority: s.priority }), ...(s.rules === undefined ? {} : { rules: s.rules }) };
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
  assert.deepEqual(bank.sounds['pop'], { files: [join(DIR, 'pop.wav')], gain: 1, pitchJitter: 0.5, gainJitter: 0.1, priority: 0, rules: null });
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

test('rules of a sound: the bank reads the rules a sound names, and says what is wrong with them', () => {
  const shower = { minSize: 0, minSpeed: 0, minImpulse: 0.05, mergeWindow: 0, kindGap: 0.05, crowdVoices: 100, crowdWindow: 0, starts: 12, startsWindow: 1, voices: 8, apart: true };
  const bank = parseBank({ sounds: { pop: { file: 'pop.wav' }, 'marble.contact': { file: 'tick.wav', rules: shower }, bare: { file: 'b.wav', rules: {} } } }, DIR);
  assert.equal(bank.sounds['pop']!.rules, null, 'no rules of its own: the rules of the bank');
  assert.deepEqual(bank.sounds['marble.contact']!.rules, shower);
  assert.deepEqual(bank.sounds['bare']!.rules, {}, 'only what it names');
  assert.deepEqual(bank.rules, SOUND_RULES, 'and the rules of the bank stay what they are');

  const bad = (rules: unknown, message: RegExp): void => {
    assert.throws(() => parseBank({ sounds: { pop: { file: 'a.wav', rules } } }, DIR), (e: unknown) => e instanceof BankError && message.test(e.message));
  };
  bad([], /sound "pop": rules must be an object of rules for the events of this sound/);
  // The limits of the whole track are not a sound's to set: it can only stand apart from them.
  bad({ gap: 0 }, /unknown field "gap" \(allowed: minSize, minSpeed, minImpulse, mergeWindow, kindGap, crowdVoices, crowdWindow, starts, startsWindow, voices, apart\)/);
  bad({ kindGaps: { contact: 0 } }, /unknown field "kindGaps"/);
  bad({ apart: 1 }, /rules\.apart must be true or false, got 1/);
  bad({ starts: 0 }, /rules\.starts must be a number in 1\.\.100000, got 0/);
  bad({ voices: '8' }, /rules\.voices must be a number/);
  bad({ minImpulse: -1 }, /rules\.minImpulse must be a number/);
});

test('rules of a sound: its thresholds stand in for the bank\'s, for its events only', () => {
  const kinds = { appear: 'pop', move: 'whoosh', contact: 'tick' };
  // A strict bank, and a voice that lets its small, slow and weak events through.
  const loose = bankOf({
    sounds: { pop: {}, whoosh: {}, tick: {}, marble: { rules: { minSize: 5 } }, 'marble.move': { rules: { minSpeed: 1 } }, 'marble.contact': { rules: { minSize: 0, minImpulse: 0.05 } } },
    kinds,
    rules: { minSize: 24, minSpeed: 4, minImpulse: 0.25 },
  });
  const p = plan(
    [
      ev({ node: 'plain', size: 10, time: 0 }),
      ev({ node: 'm1', key: 'marble', size: 10, time: 1 }),
      ev({ node: 'm2', key: 'marble', size: 4, time: 2 }),
      ev({ kind: 'move', node: 'crawl', speed: 2, time: 3 }),
      ev({ kind: 'move', node: 'm3', key: 'marble', speed: 2, time: 4 }),
      ev({ kind: 'move', node: 'm4', key: 'marble', speed: 0.5, time: 5 }),
      ev({ kind: 'move', node: 'm5', key: 'marble', speed: 2, size: 10, time: 6 }),
      ev({ kind: 'contact', node: 'tap', impulse: 0.1, time: 7 }),
      ev({ kind: 'contact', node: 'm6', key: 'marble', impulse: 0.1, size: 10, time: 8 }),
      ev({ kind: 'contact', node: 'm7', key: 'marble', impulse: 0.01, time: 9 }),
    ],
    loose,
  );
  assert.deepEqual(heard(p), ['appear:m1@60', 'move:m3@240', 'contact:m6@480']);
  assert.deepEqual(lost(p, 'small'), ['appear:plain@0', 'appear:m2@120', 'move:m5@360'], 'a threshold the sound does not name is the bank\'s');
  assert.deepEqual(lost(p, 'slow'), ['move:crawl@180', 'move:m4@300']);
  assert.deepEqual(lost(p, 'weak'), ['contact:tap@420', 'contact:m7@540']);
  assert.deepEqual(heard(plan([ev({ node: 'asked', sound: 'marble', size: 1 })], loose)), ['appear:asked@0'], 'a sound the scene named is wanted whatever the size');

  // The other way round: a bank that drops nothing, and a sound that wants more of its own events.
  const strict = bankOf({ sounds: { tick: {}, 'bell.contact': { rules: { minImpulse: 1, minSize: 50 } } }, kinds: { contact: 'tick' } });
  const q = plan(
    [
      ev({ kind: 'contact', node: 'a', impulse: 0.5 }),
      ev({ kind: 'contact', node: 'b', key: 'bell', impulse: 0.5, time: 1 }),
      ev({ kind: 'contact', node: 'c', key: 'bell', impulse: 2, size: 40, time: 2 }),
      ev({ kind: 'contact', node: 'd', otherKey: 'bell', impulse: 2, time: 3 }),
    ],
    strict,
  );
  assert.deepEqual([heard(q), lost(q, 'weak'), lost(q, 'small')], [['contact:a@0', 'contact:d@180'], ['contact:b@60'], ['contact:c@120']]);
});

test('rules of a sound: it is thinned by itself: its own merge window, least gap and crowd, apart from the other events of its kind', () => {
  const kinds = { contact: 'tick' };
  const contact = (node: string, time: number, impulse = 1, key: string | null = 'marble'): SceneEvent => ev({ kind: 'contact', node, key, time, impulse });
  const mine = (ids: string[], letter: string): string[] => ids.filter((id) => id.includes(`:${letter}`));
  // The bank merges contacts within 0.08 s, keeps a second between two and lets two sound in five seconds. The marbles ask for none of that.
  const rules = { mergeWindow: 0.08, kindGap: 1, crowdVoices: 2, crowdWindow: 5 };
  const bank = bankOf({ sounds: { tick: {}, 'marble.contact': { rules: { mergeWindow: 0, kindGap: 0.1, crowdVoices: 100, crowdWindow: 1 } } }, kinds, rules });
  const marbles = Array.from({ length: 10 }, (_, i) => contact(`m${i}`, 1 + i * 0.2));
  const p = plan([...marbles, contact('a', 1, 1, null), contact('b', 1.05, 1, null), contact('c', 1.6, 1, null), contact('d', 3, 1, null), contact('e', 9, 1, null)], bank);
  assert.equal(mine(heard(p), 'm').length, 10, 'every marble, each on its own frame');
  assert.deepEqual(heard(p).filter((id) => !id.includes(':m')), ['contact:a@60', 'contact:d@180', 'contact:e@540'], 'the other contacts under the rules of the bank, as if no marble fell');
  assert.deepEqual([lost(p, 'merged'), lost(p, 'kind-gap'), lost(p, 'crowd')], [['contact:b@63'], ['contact:c@96'], []]);
  // A rule it does not name is the bank's: without a gap of its own its sounds keep the second of the bank.
  const half = bankOf({ sounds: { tick: {}, 'marble.contact': { rules: { mergeWindow: 0, crowdWindow: 0 } } }, kinds, rules });
  assert.deepEqual(heard(plan(marbles, half)), ['contact:m0@60', 'contact:m5@120']);
  // Without rules of its own the same voice is one more contact among the contacts.
  assert.equal(heard(plan(marbles, bankOf({ sounds: { tick: {}, 'marble.contact': {} }, kinds, rules }))).length, 2);

  // A window of its own in which its events sound as one: the strongest of them.
  const one = bankOf({ sounds: { tick: {}, 'bell.contact': { rules: { mergeWindow: 0.5 } } }, kinds, curves: { impulse: SOUND_CURVES.impulse } });
  const m = plan([contact('x', 1, 0.5, 'bell'), contact('y', 1.2, 1.5, 'bell'), contact('z', 1.4, 1, 'bell'), contact('p', 1, 1, null), contact('q', 1.2, 1, null)], one);
  assert.deepEqual([heard(m), lost(m, 'merged')], [['contact:p@60', 'contact:y@72', 'contact:q@72'], ['contact:x@60', 'contact:z@84']]);
  assert.deepEqual(m.dropped.map((d) => d.by), ['contact:y@72', 'contact:y@72']);

  // A least gap of its own between two of its sounds.
  const spaced = bankOf({ sounds: { tick: {}, 'bell.contact': { rules: { kindGap: 0.3 } } }, kinds });
  const g = plan([1, 1.1, 1.2, 1.3, 1.4].flatMap((t, i) => [contact(`b${i}`, t, 1, 'bell'), contact(`t${i}`, t, 1, null)]), spaced);
  assert.deepEqual(mine(heard(g), 'b'), ['contact:b0@60', 'contact:b3@78']);
  assert.deepEqual(lost(g, 'kind-gap'), ['contact:b1@66', 'contact:b2@72', 'contact:b4@84']);
  assert.equal(mine(heard(g), 't').length, 5);

  // A crowd of its own: at most three of its sounds in any two seconds.
  const few = bankOf({ sounds: { tick: {}, 'bell.contact': { rules: { crowdVoices: 3, crowdWindow: 2 } } }, kinds });
  const c = plan([0, 0.5, 1, 1.5, 2, 2.5].flatMap((t, i) => [contact(`b${i}`, t, 1, 'bell'), contact(`t${i}`, t, 1, null)]), few);
  assert.deepEqual([mine(heard(c), 'b').length, lost(c, 'crowd'), mine(heard(c), 't').length], [5, ['contact:b3@90'], 6]);
  assert.equal(density(c.voices.filter((v) => v.key === 'bell.contact'), 2).mostStarts, 3);
});

test('rules of a sound: its own cap on its starts in a window of time, and on its voices at once', () => {
  const kinds = { contact: 'tick' };
  const contact = (node: string, time: number, impulse = 1, key: string | null = 'marble'): SceneEvent => ev({ kind: 'contact', node, key, time, impulse });
  // At most three of its starts in any second: the strongest keep theirs. The other contacts are not counted with them.
  const capped = bankOf({ sounds: { tick: {}, 'marble.contact': { rules: { starts: 3, startsWindow: 1 } } }, kinds, curves: { impulse: SOUND_CURVES.impulse } });
  const strength = [1, 0.3, 2, 0.5, 1.5, 0.4, 0.6, 1.2, 0.7, 0.35, 1.8, 0.45];
  const p = plan(
    strength.flatMap((impulse, i) => [contact(`m${i}`, 1 + i * 0.1, impulse), contact(`t${i}`, 1 + i * 0.1, impulse, null)]),
    capped,
  );
  const marbles = p.voices.filter((v) => v.key === 'marble.contact');
  assert.deepEqual(marbles.map((v) => v.event.id), ['contact:m0@60', 'contact:m2@72', 'contact:m4@84', 'contact:m10@120']);
  assert.equal(density(marbles, 1).mostStarts, 3);
  assert.equal(lost(p, 'sound-starts').length, 8);
  assert.ok(lost(p, 'sound-starts').every((id) => id.includes(':m')));
  assert.equal(p.voices.length - marbles.length, 12, 'every other contact');
  assert.deepEqual(lost(p, 'starts'), [], 'the cap of the track is another rule');

  // A cap without a window of its own uses the window of the bank.
  const wide = bankOf({ sounds: { tick: {}, 'marble.contact': { rules: { starts: 2 } } }, kinds, rules: { starts: 1000, startsWindow: 10 } });
  assert.deepEqual(heard(plan([0, 3, 6, 9, 12].map((t, i) => contact(`w${i}`, t)), wide)), ['contact:w0@0', 'contact:w1@180', 'contact:w4@720']);

  // At most two of its voices at once; a long sound of another key is not counted with them.
  const thin = bankOf({ sounds: { tick: {}, 'marble.contact': { rules: { voices: 2 } } }, kinds });
  const v = plan([contact('a', 0), contact('b', 1), contact('c', 2), contact('d', 6), contact('other', 2, 1, null)], thin, () => 3);
  assert.deepEqual([heard(v), lost(v, 'sound-voices'), lost(v, 'voices')], [['contact:a@0', 'contact:b@60', 'contact:other@120', 'contact:d@360'], ['contact:c@120'], []]);
});

test('rules of a sound: a sound apart is not held to the limits of the whole track, and does not count toward them', () => {
  const kinds = { appear: 'pop', contact: 'tick' };
  const limits = { gap: 0.5, starts: 2, startsWindow: 10 };
  const accents = [ev({ node: 'a', time: 1 }), ev({ node: 'b', time: 5 }), ev({ node: 'c', time: 7 })];
  const pour = Array.from({ length: 20 }, (_, i) => ev({ kind: 'contact', node: `m${i}`, key: 'marble', time: 0.9 + i * 0.1, impulse: 1 }));
  const apart = bankOf({ sounds: { pop: {}, tick: {}, 'marble.contact': { rules: { apart: true } } }, kinds, rules: limits });
  const p = plan([...accents, ...pour], apart);
  // Every impact of the pour, and the accents exactly as without it.
  assert.equal(p.voices.filter((v) => v.apart).length, 20);
  assert.deepEqual(p.voices.filter((v) => !v.apart).map((v) => v.event.id), ['appear:a@60', 'appear:b@300']);
  assert.deepEqual(heard(plan(accents, apart)), ['appear:a@60', 'appear:b@300']);
  assert.deepEqual([lost(p, 'gap'), lost(p, 'starts'), lost(p, 'voices')], [[], ['appear:c@420'], []]);

  // The same pour of a sound that is not apart takes the place of the accents: a contact goes before an appearance.
  const counted = bankOf({ sounds: { pop: {}, tick: {}, 'marble.contact': { rules: {} } }, kinds, rules: limits });
  const q = plan([...accents, ...pour], counted);
  assert.deepEqual(heard(q), ['contact:m0@54', 'contact:m5@84']);
  assert.ok(q.voices.every((v) => !v.apart));
  assert.deepEqual([lost(q, 'gap').length, lost(q, 'starts').length], [17, 4]);

  // Voices at once: a sound apart is neither counted nor cut by the cap of the track.
  const long = [ev({ node: 'a', time: 1 }), ev({ kind: 'contact', node: 'm0', key: 'marble', time: 1.1, impulse: 1 }), ev({ kind: 'contact', node: 'm1', key: 'marble', time: 1.2, impulse: 1 }), ev({ node: 'b', time: 2 })];
  const r = plan(long, bankOf({ sounds: { pop: {}, tick: {}, 'marble.contact': { rules: { apart: true } } }, kinds, rules: { voices: 1 } }), () => 2);
  assert.deepEqual([heard(r), lost(r, 'voices')], [['appear:a@60', 'contact:m0@66', 'contact:m1@72'], ['appear:b@120']]);
  const s = plan(long, bankOf({ sounds: { pop: {}, tick: {}, 'marble.contact': { rules: { apart: false } } }, kinds, rules: { voices: 1 } }), () => 2);
  assert.deepEqual(heard(s), ['contact:m0@66']);

  // A sound placed by hand is an accent whatever the rules of its sound: it always sounds, and it is counted.
  const placed = plan([ev({ kind: 'sfx', sound: 'marble.contact', node: null, time: 1 }), ev({ node: 'a', time: 1.2 })], apart);
  assert.deepEqual([heard(placed), placed.voices[0]!.apart, lost(placed, 'gap')], [['sfx:null@60'], false, ['appear:a@72']]);
});

test('rules of a sound: a pour is heard as a shower: every impact on its own frame, its gain from its impulse, about ten starts a second', () => {
  // Three seconds of a pour: twenty impacts a second, of every strength, each on a frame of its own.
  const pour = Array.from({ length: 60 }, (_, i) => ev({ kind: 'contact', node: `m${i}`, key: 'marble', other: 'jar', time: 2 + i * 0.05, impulse: 0.1 + ((i * 37) % 60) / 30, size: 30, x: 400 + (i % 7) * 60 }));
  const accents = [ev({ node: 'title', time: 1 }), ev({ node: 'jar', time: 3 }), ev({ kind: 'sfx', sound: 'chime', node: null, time: 4 })];
  const shower = { minSize: 0, minImpulse: 0.05, mergeWindow: 0, kindGap: 0, crowdWindow: 0, starts: 10, startsWindow: 1, voices: 8, apart: true };
  // The rules and the curves of the bank are the engine's defaults: quiet.
  const bank = bankOf({ sounds: { pop: {}, chime: {}, 'marble.contact': { takes: 3, pitchJitter: 2, gainJitter: 0.2, rules: shower } }, kinds: { appear: 'pop' }, defaults: true });
  const p = plan([...accents, ...pour], bank);

  const showers = showersOf(p.voices);
  assert.equal(showers.length, 1);
  const run = showers[0]!;
  assert.deepEqual([run.sound, run.mostStartsInASecond], ['marble.contact', 10], 'ten starts a second while it pours');
  assert.ok(run.time >= 2 && run.time < 2.2, `it starts with the pour: ${run.time} s`);
  assert.ok(run.voices.length >= 24 && run.voices.length <= 30, `${run.voices.length} starts in three seconds`);
  assert.ok(run.seconds > 2.5 && run.seconds < 3.2, `${run.seconds} s`);
  // Each on the frame of its contact, no two on one frame.
  assert.ok(run.voices.every((v) => v.frame === v.event.frame && v.event.kind === 'contact'));
  assert.equal(new Set(run.voices.map((v) => v.frame)).size, run.voices.length);
  // The gain of each is its impulse on the curve, within the jitter; each has a pitch of its own, and the takes vary.
  const base = (v: (typeof run.voices)[number]): number => curveAt(SOUND_CURVES.size, 30) * curveAt(SOUND_CURVES.impulse, v.event.impulse!);
  assert.ok(run.voices.every((v) => Math.abs(v.gain / base(v) - 1) <= 0.2 + 1e-9));
  assert.ok(Math.max(...run.voices.map(base)) / Math.min(...run.voices.map(base)) > 1.5, 'a hard impact is louder than a light one');
  assert.equal(new Set(run.voices.map((v) => v.pitch)).size, run.voices.length);
  assert.ok(run.voices.every((v) => Math.abs(12 * Math.log2(v.pitch)) <= 2));
  assert.ok(new Set(run.voices.map((v) => v.take)).size > 1);
  // Where the cap has to choose, the harder impacts keep their sound.
  const mean = (list: number[]): number => list.reduce((a, b) => a + b, 0) / list.length;
  const cut = p.dropped.filter((d) => d.rule === 'sound-starts').map((d) => d.event.impulse!);
  assert.equal(cut.length + run.voices.length, pour.length);
  assert.ok(mean(run.voices.map((v) => v.event.impulse!)) > mean(cut) + 0.3);

  // The accents are what they are without the pour.
  assert.deepEqual(p.voices.filter((v) => !v.apart).map((v) => v.event.id), ['appear:title@60', 'appear:jar@180', 'sfx:null@240']);
  assert.deepEqual(heard(plan(accents, bank)), ['appear:title@60', 'appear:jar@180', 'sfx:null@240']);
  // The same pour of a sound without rules of its own, under the defaults: one sound or two.
  const quiet = plan([...accents, ...pour], bankOf({ sounds: { pop: {}, chime: {}, 'marble.contact': { takes: 3 } }, kinds: { appear: 'pop' }, defaults: true }));
  const ticks = quiet.voices.filter((v) => v.event.kind === 'contact').length;
  assert.ok(ticks >= 1 && ticks <= 2, `${ticks} of sixty impacts`);

  // A pause of a second ends a shower: what falls after it is another one.
  const twice = showersOf(plan([...pour.slice(0, 10), ...pour.slice(40, 50)], bank).voices);
  assert.deepEqual(twice.map((s) => [s.time, s.voices.length, s.mostStartsInASecond]), [[2, 10, 10], [4, 10, 10]]);
  assert.ok(twice.every((s) => s.seconds > 0.5 && s.seconds < 0.6), 'from its first start to the end of its last sound');
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

test('sound sheet: a tile for every sound and one for a shower, the node ringed where it is, and what it is written on it', async () => {
  // A pour of marbles onto a ledge, an accent before it and a sound placed by hand after it.
  const marbles = Array.from({ length: 12 }, (_, i) =>
    circle({ id: `m${i}`, at: [-200 + (i % 6) * 80 + (i >= 6 ? 30 : 0), -300 - Math.floor(i / 6) * 80], r: 16, fill: 'accent.aqua', sound: 'marble', body: { kind: 'dynamic', release: 0.6 + i * 0.1 } }),
  );
  const spec = make(
    [rect({ id: 'ledge', at: [0, 150], w: 900, h: 50, fill: 'dark.indigo', body: { kind: 'fixed' } }), circle({ id: 'bell', at: [-600, -100], r: 50, fill: 'accent.pink' }), ...marbles],
    [popIn('bell', { at: 0.5 }), sfx('chime', { at: 3.5 })],
    4,
  );
  const shower = { minSize: 0, minImpulse: 0.02, mergeWindow: 0, kindGap: 0, crowdWindow: 0, starts: 12, startsWindow: 1, voices: 8, apart: true };
  const bank = bankOf({ sounds: { pop: {}, chime: { seconds: 0.3 }, 'marble.contact': { hz: 1200, seconds: 0.08, pitchJitter: 2, gainJitter: 0.2, rules: shower } }, kinds: { appear: 'pop' }, defaults: true });
  const c = compileShot(spec);
  const bake = await bakeShot(c);
  const track = renderSound(c, bake, bank);
  const r = track.report;

  // The report: the accents are counted as before, the shower by itself, and every start names its node.
  assert.deepEqual([r.starts, r.mostStarts, r.heard], [2, 2, 2 + r.showerStarts]);
  assert.ok(r.showers.length >= 1 && r.showerStarts >= 12, `${r.showerStarts} impacts in ${r.showers.length} shower(s)`);
  const first = r.showers[0]!;
  assert.equal(first.sound, 'marble.contact');
  assert.match(first.node ?? '', /^m\d+$/);
  assert.ok(first.mostStartsInASecond >= 6 && first.mostStartsInASecond <= 12, `${first.mostStartsInASecond} starts in its busiest second`);
  assert.ok(r.showers.reduce((n, s) => n + s.starts, 0) === r.showerStarts);
  assert.deepEqual(r.voices.filter((v) => v.shower === undefined).map((v) => [v.id, v.node, v.sound]), [['appear:bell@30', 'bell', 'pop'], ['sfx:chime@210', null, 'chime']]);
  const inShower = r.voices.filter((v) => v.shower !== undefined);
  assert.equal(inShower.length, r.showerStarts);
  assert.ok(inShower.every((v) => v.kind === 'contact' && /^m\d+$/.test(v.node ?? '') && v.sound === 'marble.contact'));
  assert.deepEqual([inShower[0]!.id, inShower[0]!.time, inShower[0]!.shower], [first.id, first.time, 0]);
  assert.deepEqual(r.soundRules, { 'marble.contact': shower });
  assert.equal(r.dropped['sound-starts'].length + r.dropped['sound-voices'].length + r.dropped.weak.length + r.dropped.unseen.length + r.showerStarts, track.events.filter((e) => e.kind === 'contact').length);
  // It is in the track: sound where the first impact starts, silence just before it.
  const at = track.plan.voices.find((v) => v.apart)!.frame * SAMPLES_PER_FRAME;
  assert.ok(energy(track.left, at, at + 400) + energy(track.right, at, at + 400) > 0);
  const text = formatSoundReport(r);
  assert.match(text, new RegExp(`starts: ${r.heard} of ${r.events} event\\(s\\) are heard: ${r.showerStarts} in ${r.showers.length} shower\\(s\\), and 2 accent\\(s\\): 30 per minute; at most 2 in any 10 s \\(limit 4\\)`));
  assert.match(text, /^showers \(apart from those limits\):$/m);
  assert.match(text, new RegExp(`marble\\.contact +${first.starts} start\\(s\\) over ${first.seconds.toFixed(2)} s; at most ${first.mostStartsInASecond} in a second, \\d at once; from ${first.id}$`, 'm'));
  assert.deepEqual(
    text
      .slice(text.indexOf('\nheard:\n') + 8)
      .split('\n')
      .map((line) => line.trim().split(/\s+/).slice(2, 5)),
    [
      ['appear', 'bell', 'pop'],
      ['sfx', '-', 'chime'],
    ],
    'the list of accents names the node of each; the sounds of a shower are in its line',
  );

  // The tiles: every accent, and the shower once, at its first start.
  const tiles = soundTiles(track.plan);
  assert.equal(tiles.length, 2 + r.showers.length);
  assert.deepEqual(tiles.map((t) => t.frame), [...tiles.map((t) => t.frame)].sort((a, b) => a - b), 'in order of time');
  const [bell, rain, chime] = [tiles.find((t) => t.node === 'bell')!, tiles.find((t) => t.shower)!, tiles.find((t) => t.kind === 'sfx')!];
  assert.deepEqual([rain.id, rain.frame, rain.node, rain.kind, rain.sound, rain.shower], [first.id, Math.round(first.time * 60), first.node, 'contact', 'marble.contact', { starts: first.starts, seconds: showersOf(track.plan.voices)[0]!.seconds }]);
  assert.ok(Math.abs(rain.shower!.seconds - first.seconds) < 1e-3);
  assert.deepEqual(tileCaption(bell), ['0.50 s  f30  pop', 'appear  bell']);
  assert.deepEqual(tileCaption(chime), ['3.50 s  f210  chime', 'sfx  placed by hand']);
  assert.match(rain.other ?? '', /^(ledge|m\d+)$/, 'a contact names the body it hits');
  assert.deepEqual(tileCaption(rain), [`${first.time.toFixed(2)} s  f${rain.frame}  marble.contact`, `contact  ${first.node} on ${rain.other}`, `shower: ${first.starts} starts in ${rain.shower!.seconds.toFixed(1)} s`]);
  assert.equal(tileCaption({ ...rain, shower: { starts: 1, seconds: 0.08 } })[2], 'shower: 1 start in 0.1 s');

  // The rings: the bell where it stands, as large as it gets; the marble where it is when it lands; none for the placed sound.
  const series = sampleMotion(c, bake, { particles: false });
  const ring = (t: (typeof tiles)[number]): { x: number; y: number; radius: number } => tileRing(c, series, t)!;
  assert.deepEqual([Math.round(ring(bell).x), Math.round(ring(bell).y)], [360, 440]);
  assert.ok(ring(bell).radius >= 50 && ring(bell).radius < 70, `${ring(bell).radius}`);
  const marble = series.placed[c.byId.get(rain.node!)!.index]!;
  assert.ok(Math.hypot(ring(rain).x - 960 - marble.x[rain.frame]!, ring(rain).y - 540 - marble.y[rain.frame]!) < 1e-6 && Math.abs(ring(rain).radius - 16) < 1e-6, 'around the marble, where it is on that frame');
  assert.ok(Math.hypot(ring(rain).x - rain.x, ring(rain).y - rain.y) < 16 + 12, `the contact is on the rim of the marble that is ringed: ${Math.hypot(ring(rain).x - rain.x, ring(rain).y - rain.y)} px from its middle`);
  assert.equal(tileRing(c, series, chime), null);

  // The picture: tiles of 320 by 180 in rows of two, each a frame of the shot with its ring and its writing.
  const sheet = await renderSoundSheet(c, bake, track.plan, { cols: 2, tileWidth: 320, lang: 'en', gpu: false, series });
  assert.deepEqual([sheet.tiles, sheet.more], [tiles, 0]);
  const image = await loadImage(sheet.png);
  assert.deepEqual([image.width, image.height], [640, 180 * Math.ceil(tiles.length / 2)]);
  const canvas = new Canvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const px = ctx.getImageData(0, 0, image.width, image.height).data;
  const ink = (x: number, y: number): boolean => {
    const i = 4 * (Math.round(y) * image.width + Math.round(x));
    return px[i]! > 200 && px[i + 1]! > 170 && px[i + 2]! < 150;
  };
  /** The share of the ring of a tile that is drawn in ink. */
  const drawn = (t: (typeof tiles)[number]): number => {
    const n = tiles.indexOf(t);
    const [ox, oy, k] = [(n % 2) * 320, Math.floor(n / 2) * 180, 320 / 1920];
    const { x, y, radius } = ring(t);
    let hits = 0;
    for (let a = 0; a < 120; a++) {
      const [px0, py0] = [ox + x * k + (radius * k + 6) * Math.cos((a * Math.PI) / 60), oy + y * k + (radius * k + 6) * Math.sin((a * Math.PI) / 60)];
      // The pixel under the line, or the one beside it: the line is thinner than three pixels.
      if ([-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) => ink(px0 + dx, py0 + dy)))) hits++;
    }
    return hits / 120;
  };
  /** Ink in the picture of a tile, above its writing. */
  const inkAbove = (t: (typeof tiles)[number]): number => {
    const n = tiles.indexOf(t);
    let count = 0;
    for (let y = 0; y < 140; y++) for (let x = 0; x < 320; x++) if (ink((n % 2) * 320 + x, Math.floor(n / 2) * 180 + y)) count++;
    return count;
  };
  assert.equal(drawn(bell), 1, 'the ring of an accent is whole');
  assert.ok(drawn(rain) > 0.3 && drawn(rain) < 0.9, `the ring of a shower is dashed: ${drawn(rain)}`);
  assert.equal(inkAbove(chime), 0, 'a sound placed by hand without a node has no ring');
  assert.ok(inkAbove(bell) > 50 && inkAbove(rain) > 20);
  // The picture of a tile is the frame of its start: the marble is under its ring as it lands; the bell is not there yet when its pop starts, and is there later.
  const colour = (t: (typeof tiles)[number], x: number, y: number): number[] => {
    const n = tiles.indexOf(t);
    const i = 4 * ((Math.floor(n / 2) * 180 + Math.round(y / 6)) * image.width + (n % 2) * 320 + Math.round(x / 6));
    return [px[i]!, px[i + 1]!, px[i + 2]!];
  };
  const aqua = ([red, green, blue]: number[]): boolean => red! < 140 && green! > 130 && blue! > 130;
  const pink = ([red, green, blue]: number[]): boolean => red! > 180 && green! < 130 && blue! > 110;
  assert.ok(aqua(colour(rain, ring(rain).x, ring(rain).y)), `the marble under its ring: ${colour(rain, ring(rain).x, ring(rain).y)}`);
  assert.ok(!pink(colour(bell, 360, 440)) && pink(colour(chime, 360, 440)), `the bell: ${colour(bell, 360, 440)} and then ${colour(chime, 360, 440)}`);
  // The writing: ink in the bottom-left corner of every tile.
  for (const t of tiles) {
    const n = tiles.indexOf(t);
    let count = 0;
    for (let y = 150; y < 180; y++) for (let x = 0; x < 120; x++) if (ink((n % 2) * 320 + x, Math.floor(n / 2) * 180 + y)) count++;
    assert.ok(count > 40, `tile ${n}: ${count}`);
  }
  // The same picture again; and the first tiles only when the sheet is told to hold fewer.
  const again = await renderSoundSheet(c, bake, track.plan, { cols: 2, tileWidth: 320, lang: 'en', gpu: false });
  assert.equal(Buffer.compare(again.png, sheet.png), 0);
  const short = await renderSoundSheet(c, bake, track.plan, { most: 1, tileWidth: 160, lang: 'en', gpu: false, series });
  assert.deepEqual([short.tiles, short.more], [[tiles[0]], tiles.length - 1]);
  // A track without a sound has no sheet.
  const silent = renderSound(c, bake, bank, { events: [] });
  await assert.rejects(renderSoundSheet(c, bake, silent.plan, { lang: 'en', gpu: false }), /a sound sheet needs at least one sound/);
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

test('cli: events and sfx write their files, sfx --sheet the sound sheet; check --bank holds the sound keys against the bank', () => {
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
  const report = JSON.parse(readFileSync(join(cwd, 'out', 'sound', 'sfx.json'), 'utf8')) as {
    starts: number;
    heard: number;
    showerStarts: number;
    showers: unknown[];
    mostStarts: number;
    startsWindow: number;
    muted: number;
    dropped: Record<string, unknown[]>;
    voices: { sound: string; node: string | null }[];
  };
  assert.ok(report.starts >= 2 && report.mostStarts <= 4 && report.startsWindow === 10);
  assert.equal(report.muted, 1);
  assert.deepEqual(Object.keys(report.dropped), [...DROP_RULES]);
  assert.ok(report.voices.some((v) => v.sound === 'whoosh') && report.voices.some((v) => v.sound === 'chime'));
  // Every start names the node it comes from; a sound placed by hand without one has none.
  assert.deepEqual([report.voices.find((v) => v.sound === 'whoosh')!.node, report.voices.find((v) => v.sound === 'chime')!.node], ['mover', null]);
  assert.deepEqual([report.heard, report.showerStarts, report.showers], [report.starts, 0, []], 'no sound of this bank stands apart');
  assert.ok(!existsSync(join(cwd, 'out', 'sound', 'sfx_sheet.png')), 'no sheet unless it is asked for');
  // Run again: the same bytes.
  const bytes = readFileSync(wavFile);
  assert.equal(run('sfx', FIXTURE, '--bank', bankFile).status, 0);
  assert.equal(Buffer.compare(bytes, readFileSync(wavFile)), 0);
  // Somewhere else: the report lies next to the track.
  assert.equal(run('sfx', FIXTURE, '--bank', bankFile, '--out', 'mix/track.wav').status, 0);
  assert.ok(existsSync(join(cwd, 'mix', 'track.wav')) && existsSync(join(cwd, 'mix', 'track.wav.json')));

  // The sound sheet: one picture next to the report, a tile for every sound.
  const isPng = (file: string): boolean => readFileSync(file).subarray(1, 4).toString('ascii') === 'PNG';
  const size = (file: string): number[] => {
    const head = readFileSync(file);
    return [head.readUInt32BE(16), head.readUInt32BE(20)];
  };
  const sheet = run('sfx', FIXTURE, '--bank', bankFile, '--sheet', '--cols', '2', '--tile', '240', '--cpu');
  assert.equal(sheet.status, 0, sheet.out);
  const sheetFile = join(cwd, 'out', 'sound', 'sfx_sheet.png');
  assert.match(sheet.out, new RegExp(`^sheet: ${report.starts} tile\\(s\\), 0 of them shower\\(s\\): .*sfx_sheet\\.png$`, 'm'));
  assert.ok(isPng(sheetFile));
  assert.deepEqual(size(sheetFile), [480, 135 * Math.ceil(report.starts / 2)]);
  assert.equal(Buffer.compare(bytes, readFileSync(wavFile)), 0, 'the track is the same with a sheet');
  assert.equal(run('sfx', FIXTURE, '--bank', bankFile, '--out', 'mix/track.wav', '--sheet', '--cpu').status, 0);
  assert.ok(isPng(join(cwd, 'mix', 'track.wav.sheet.png')), 'next to the track when the track is put somewhere else');
  // A bank that sets the contacts of the bell apart: they are a shower, one tile, and no accent.
  const apart = bankOf({ sounds: { pop: {}, 'bell.contact': { rules: { minImpulse: 0, mergeWindow: 0, kindGap: 0, crowdWindow: 0, apart: true } }, whoosh: { seconds: 0.3 }, chime: { seconds: 0.4 } }, kinds: { appear: 'pop' }, defaults: true });
  const rain = run('sfx', FIXTURE, '--bank', join(apart.dir, 'bank.json'), '--sheet', '--cpu');
  assert.equal(rain.status, 0, rain.out);
  assert.match(rain.out, /^showers \(apart from those limits\):$/m);
  assert.match(rain.out, /bell\.contact +\d+ start\(s\) over \d+\.\d\d s; at most \d+ in a second, \d+ at once; from contact:drop@\d+$/m);
  assert.match(rain.out, /^sheet: \d+ tile\(s\), 1 of them shower\(s\): /m);
  assert.equal(run('sfx', FIXTURE, '--bank', bankFile).status, 0);

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
