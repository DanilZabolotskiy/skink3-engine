import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cuesFromWords, formatSrt, formatVtt, formatYtt, shiftWords, wrapCue, type Cue, type SpokenWord } from '../src/index.ts';

/** Words spoken at an even pace, with a pause after every sentence. */
function speak(text: string, opts: { at?: number; word?: number; pause?: number } = {}): SpokenWord[] {
  const word = opts.word ?? 0.3;
  let t = opts.at ?? 0.6;
  return text.split(' ').map((w) => {
    const start = t;
    const end = t + word * 0.85;
    t += word + (/[.!?]$/.test(w) ? (opts.pause ?? 0.35) : 0);
    return { w, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) };
  });
}

const TEXT =
  'Every second, more than twenty thousand units pour into the machine and the parts inside it, most of it for one purpose. ' +
  'It turns into metal, stone and power. And with every pulse, something above them grows a little bigger.';

const textOf = (cues: readonly Cue[]): string => cues.map((c) => c.lines.join(' ')).join(' ');

test('subtitles: every word is in exactly one cue, in order, and every cue fits its lines', () => {
  const words = speak(TEXT);
  const cues = cuesFromWords(words);
  assert.equal(textOf(cues), TEXT);
  for (const c of cues) {
    assert.ok(c.lines.length >= 1 && c.lines.length <= 2, `lines: ${JSON.stringify(c.lines)}`);
    for (const line of c.lines) assert.ok(line.length <= 42, `"${line}" is ${line.length} characters`);
    assert.ok(c.end > c.start);
    assert.ok(c.end - c.start <= 6.3, `a cue of ${c.end - c.start} s`);
  }
  // Tighter limits are kept too.
  const narrow = cuesFromWords(words, { maxChars: 20, maxLines: 1 });
  assert.equal(textOf(narrow), TEXT);
  for (const c of narrow) assert.ok(c.lines.length === 1 && c.lines[0]!.length <= 20, JSON.stringify(c.lines));
  assert.ok(narrow.length > cues.length);
});

test('subtitles: cues never overlap, appear just before their first word and stay a little after their last', () => {
  const words = speak(TEXT);
  const cues = cuesFromWords(words);
  let at = 0;
  cues.forEach((c, i) => {
    const count = c.lines.join(' ').split(' ').length;
    const first = words[at]!;
    const last = words[at + count - 1]!;
    at += count;
    assert.ok(c.start <= first.start && first.start - c.start <= 0.051, `cue ${i} starts ${first.start - c.start} s before its first word`);
    assert.ok(c.end >= last.end - 1e-9, `cue ${i} holds until its last word has ended`);
    if (i > 0) assert.ok(c.start >= cues[i - 1]!.end + 0.04 - 1e-9, `cue ${i} starts after the one before it has gone`);
  });
  assert.equal(at, words.length);
});

test('subtitles: a sentence ends a cue, a pause ends a cue, and a long sentence is cut at a comma', () => {
  const cues = cuesFromWords(speak(TEXT));
  // The three sentences end three cues.
  for (const tail of ['one purpose.', 'stone and power.', 'a little bigger.']) {
    assert.ok(cues.some((c) => c.lines.join(' ').endsWith(tail)), `a cue ends with "${tail}"`);
  }
  // A sentence too long for one cue is cut after its last comma when that leaves a cue of a fair length...
  const long = cuesFromWords(speak('When the first wave of pulses comes to the far end of the long line, the lamp above it lights up and stays on for a while.'));
  assert.equal(long[0]!.lines.join(' '), 'When the first wave of pulses comes to the far end of the long line,');
  // ...and where the only comma is too early for that, it is filled as far as it goes.
  const firstCut = cues[0]!.lines.join(' ');
  assert.ok(firstCut.length > 60 && !/,$/.test(firstCut), `the first cue is filled: "${firstCut}"`);
  // A pause inside a sentence ends a cue even though the text would fit.
  const paused: SpokenWord[] = [
    { w: 'Wait', start: 1, end: 1.3 },
    { w: 'for', start: 1.35, end: 1.5 },
    { w: 'it', start: 2.4, end: 2.6 },
    { w: 'now.', start: 2.65, end: 2.9 },
  ];
  assert.deepEqual(cuesFromWords(paused).map((c) => c.lines.join(' ')), ['Wait for', 'it now.']);
  assert.deepEqual(cuesFromWords(paused, { pause: 2 }).map((c) => c.lines.join(' ')), ['Wait for it now.']);
  // A short cue is held for a second when there is room, and never into the next one.
  const [a, b] = cuesFromWords(paused);
  assert.ok(Math.abs(a!.end - a!.start - 1) < 1e-9 && b!.start >= a!.end + 0.04 - 1e-9);
  assert.throws(() => cuesFromWords([{ w: 'b', start: 2, end: 2.1 }, { w: 'a', start: 1, end: 1.1 }]), /not in order of time/);
  assert.deepEqual(cuesFromWords([]), []);
});

test('subtitles: lines are even, and a no-break space keeps two words together', () => {
  assert.deepEqual(wrapCue('one two three four five six', 16, 2), ['one two three', 'four five six']);
  assert.deepEqual(wrapCue('short', 42, 2), ['short']);
  assert.equal(wrapCue('one two three four five six seven eight nine ten', 12, 2), null);
  const NBSP = String.fromCharCode(0xa0);
  assert.deepEqual(wrapCue('it costs 50 units a year', 16, 2), ['it costs 50', 'units a year']);
  assert.deepEqual(wrapCue(`it costs 50${NBSP}units a year`, 16, 2), ['it costs', `50${NBSP}units a year`]);
});

test('subtitles: a take is placed in a video by shifting its words', () => {
  const words = speak('One two. Three four.', { at: 0 });
  const later = shiftWords(words, 73.5);
  assert.equal(later[0]!.start, 73.5);
  assert.equal(later[3]!.w, 'four.');
  const cues = cuesFromWords([...shiftWords(words, 10), ...shiftWords(words, 20)]);
  assert.equal(cues.length, 4);
  assert.ok(cues[2]!.start >= 19.9);
});

test('subtitles: the three formats', () => {
  const cues: Cue[] = [
    { start: 0.55, end: 2.4, lines: ['Fish & chips,', 'he said.'] },
    { start: 3723.004, end: 3725.5, lines: ['<later>'] },
  ];
  assert.equal(formatSrt(cues), '1\n00:00:00,550 --> 00:00:02,400\nFish & chips,\nhe said.\n\n2\n01:02:03,004 --> 01:02:05,500\n<later>\n');
  assert.equal(formatVtt(cues), 'WEBVTT\n\n00:00:00.550 --> 00:00:02.400\nFish &amp; chips,\nhe said.\n\n01:02:03.004 --> 01:02:05.500\n&lt;later&gt;\n');
  const ytt = formatYtt(cues, { color: '#ffd24d', position: [50, 90] });
  assert.match(ytt, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<timedtext format="3">\n<head>\n/);
  assert.match(ytt, /<pen id="1" b="1" fc="#FFD24D" fo="254" bc="#080808" bo="150" et="3" ec="#080808" fs="4" sz="100"\/>/);
  assert.match(ytt, /<wp id="1" ap="7" ah="50" av="90"\/>/);
  assert.match(ytt, /<p t="550" d="1850" wp="1" ws="1"><s p="1">Fish &amp; chips,\nhe said\.<\/s><\/p>/);
  assert.match(ytt, /<p t="3723004" d="2496" wp="1" ws="1"><s p="1">&lt;later&gt;<\/s><\/p>\n<\/body>\n<\/timedtext>\n$/);
  // The player drops pure white and fractional positions: the defaults avoid both.
  assert.match(formatYtt(cues), /fc="#FEFEFE"/);
  assert.match(formatYtt(cues, { position: [49.6, 95.4] }), /ah="50" av="95"/);
  assert.throws(() => formatYtt(cues, { color: 'white' }), /color must be "#RRGGBB"/);
  // The same cues always give the same files.
  assert.equal(formatYtt(cues), formatYtt(cues));
});
