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
  // A sentence too long for one cue is cut into parts of about the same length: at a comma where one is near...
  const long = cuesFromWords(speak('When the first wave of pulses comes to the far end of the long line, the lamp above it lights up and stays on for a while.'));
  assert.deepEqual(long.map((c) => c.lines.join(' ')), ['When the first wave of pulses comes to the far end of the long line,', 'the lamp above it lights up and stays on for a while.']);
  // ...and where the only comma is far from the middle, near the middle and not after a short word.
  const parts = cues.filter((c) => c.end <= cues.find((x) => x.lines.join(' ').endsWith('one purpose.'))!.end).map((c) => c.lines.join(' '));
  assert.deepEqual(parts, ['Every second, more than twenty thousand units pour into', 'the machine and the parts inside it, most of it for one purpose.']);
  // As many parts as the phrase needs when each is filled, and those about even.
  const many = cuesFromWords(speak('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen.'), { maxChars: 20, maxLines: 2 });
  assert.equal(many.length, 4);
  const sizes = many.map((c) => c.lines.join(' ').length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 12, `the parts are about even: ${sizes.join(', ')}`);
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

test('subtitles: initials and the abbreviations a caller names do not end a sentence', () => {
  const said = (text: string, options = {}): string[] => cuesFromWords(speak(text), options).map((c) => c.lines.join(' '));
  // Single letters with full stops are initials, whatever the language: the sentence runs on through them.
  assert.deepEqual(said('The house of J.B. Stone lent it. Then it stopped.'), ['The house of J.B. Stone lent it.', 'Then it stopped.']);
  assert.deepEqual(said('Made in the U.S. and sold abroad. It sold well.'), ['Made in the U.S. and sold abroad.', 'It sold well.']);
  assert.deepEqual(said('A fruit, e.g. a pear, will do. So will a nut.'), ['A fruit, e.g. a pear, will do.', 'So will a nut.']);
  assert.deepEqual(said('Ask J. Smith about it. He knows.'), ['Ask J. Smith about it.', 'He knows.']);
  // Quotes or brackets around the word are no part of it.
  assert.deepEqual(said('The states (U.S.) and "U.K." agreed. Then they met.'), ['The states (U.S.) and "U.K." agreed.', 'Then they met.']);
  // A question mark or an exclamation mark after initials is an end like any other.
  assert.deepEqual(said('Is it made in the U.S.? It is.'), ['Is it made in the U.S.?', 'It is.']);
  // A word of more than one letter with a full stop is no initial: it ends a sentence unless the caller names it.
  assert.deepEqual(said('Then Mr. Smith went to St. Louis. He stayed.'), ['Then Mr.', 'Smith went to St.', 'Louis.', 'He stayed.']);
  assert.deepEqual(said('Then Mr. Smith went to St. Louis. He stayed.', { abbreviations: ['Mr.', 'St.'] }), ['Then Mr. Smith went to St. Louis.', 'He stayed.']);
  // The words are taken as they are written: another case is another word, and what is not named still ends a sentence.
  assert.deepEqual(said('Then mr. Smith left approx. then. He stayed.', { abbreviations: ['Mr.'] }), ['Then mr.', 'Smith left approx.', 'then.', 'He stayed.']);
  assert.deepEqual(said('He said "Mr. Smith" twice. Then he left.', { abbreviations: ['Mr.'] }), ['He said "Mr. Smith" twice.', 'Then he left.']);
  // A sentence that does end on initials is still cut where the voice pauses.
  const paused = [...speak('It is made in the U.S.', { at: 0.6 }), ...speak('Nobody asked where.', { at: 3.2 })];
  assert.deepEqual(cuesFromWords(paused).map((c) => c.lines.join(' ')), ['It is made in the U.S.', 'Nobody asked where.']);
  // The engine has no list of its own, and takes a list only as words with their full stops.
  assert.throws(() => cuesFromWords(speak('One two.'), { abbreviations: ['Mr'] }), /abbreviations must be a list of words as they are written, each with its full stop \("Mr\.", "St\."\), got \["Mr"\]/);
  assert.throws(() => cuesFromWords(speak('One two.'), { abbreviations: 'Mr.' as never }), /abbreviations must be a list of words/);
  assert.throws(() => cuesFromWords(speak('One two.'), { abbreviations: ['et al.'] }), /abbreviations must be a list of words/);
});

test('subtitles: a cue too short to read joins its neighbour in the same sentence, when the two fit one cue', () => {
  /** Words with their times: [word, start, end]. */
  const at = (list: [string, number, number][]): SpokenWord[] => list.map(([w, start, end]) => ({ w, start, end }));
  const said = (cues: readonly Cue[]): string[] => cues.map((c) => c.lines.join(' '));
  // A silence just over the pause before the last word of a sentence, and the next sentence right behind it:
  // cut at the pause, the word would be a cue of its own for two thirds of a second.
  const lone = at([
    ['The', 1, 1.15], ['bridge', 1.2, 1.5], ['is', 1.55, 1.65], ['still', 1.7, 1.95], ['under', 2, 2.25],
    ['renovation.', 2.77, 3.37],
    ['Nobody', 3.45, 3.8], ['knows', 3.85, 4.1], ['when', 4.15, 4.35], ['it', 4.4, 4.5], ['opens.', 4.55, 4.95],
  ]);
  const cut = cuesFromWords(lone, { minSeconds: 0 });
  assert.deepEqual(said(cut), ['The bridge is still under', 'renovation.', 'Nobody knows when it opens.']);
  assert.ok(cut[1]!.end - cut[1]!.start < 0.7, `the lone cue lasts ${cut[1]!.end - cut[1]!.start} s`);
  // By default it joins the cue before it, which is in the same sentence.
  const joined = cuesFromWords(lone);
  assert.deepEqual(said(joined), ['The bridge is still under renovation.', 'Nobody knows when it opens.']);
  assert.ok(joined[0]!.start <= 1 && joined[0]!.end >= 3.37 && joined[1]!.start >= joined[0]!.end + 0.04 - 1e-9);
  // A short cue that has room is held for its second and stays a cue: nothing to join.
  const room = at([['Wait', 1, 1.3], ['for', 1.35, 1.5], ['it', 2.4, 2.6], ['now.', 2.65, 2.9]]);
  assert.deepEqual(said(cuesFromWords(room)), ['Wait for', 'it now.']);
  // A short first cue of a sentence joins the cue after it.
  const first = at([['Wait,', 1, 1.3], ['for', 1.85, 2], ['it', 2.05, 2.2], ['now.', 2.25, 2.5]]);
  assert.deepEqual(said(cuesFromWords(first, { minSeconds: 0 })), ['Wait,', 'for it now.']);
  assert.deepEqual(said(cuesFromWords(first)), ['Wait, for it now.']);
  // Never across the end of a sentence: a short sentence stays a cue of its own.
  const yes = at([['Yes.', 1, 1.3], ['Then', 1.4, 1.6], ['it', 1.65, 1.75], ['all', 1.8, 1.95], ['began', 2, 2.3], ['again.', 2.35, 2.7]]);
  assert.deepEqual(said(cuesFromWords(yes)), ['Yes.', 'Then it all began again.']);
  // Nor through initials taken for an end: the sentence runs on through them, so the cue joins.
  const initials = at([['Made', 1, 1.2], ['in', 1.25, 1.35], ['the', 1.4, 1.5], ['U.S.', 1.55, 1.9], ['today.', 2.45, 2.85], ['Sold', 2.95, 3.2], ['abroad.', 3.25, 3.7]]);
  assert.deepEqual(said(cuesFromWords(initials)), ['Made in the U.S. today.', 'Sold abroad.']);
  // Only when the two fit one cue: its lines...
  const full = at([
    ['Every', 1, 1.2], ['second,', 1.25, 1.6], ['more', 1.65, 1.8], ['than', 1.85, 2], ['twenty', 2.05, 2.35], ['thousand', 2.4, 2.8], ['units', 2.85, 3.1], ['pour', 3.15, 3.35], ['into', 3.4, 3.6],
    ['the', 3.65, 3.75], ['machine', 3.8, 4.15], ['that', 4.2, 4.35], ['is', 4.4, 4.5], ['under', 4.55, 4.8],
    ['renovation.', 5.32, 5.92],
    ['Nobody', 6, 6.35], ['knows.', 6.4, 6.75],
  ]);
  const kept = cuesFromWords(full);
  assert.deepEqual(kept.map((c) => c.lines), [['Every second, more than twenty thousand', 'units pour into the machine that is under'], ['renovation.'], ['Nobody knows.']]);
  // ... and its seconds.
  const slow = at([['The', 1, 1.2], ['bridge', 3, 3.4], ['is', 5, 5.2], ['under', 6.5, 6.8], ['renovation.', 7.32, 7.92], ['Nobody', 8, 8.3], ['knows.', 8.35, 8.7]]);
  assert.deepEqual(said(cuesFromWords(slow, { pause: 3 })), ['The bridge is under', 'renovation.', 'Nobody knows.']);
  assert.deepEqual(said(cuesFromWords(slow, { pause: 3, maxSeconds: 8 })), ['The bridge is under renovation.', 'Nobody knows.']);
  // Whatever is joined, every word is in one cue, in order, and no cue overlaps the next.
  for (const words of [lone, first, yes, initials, full, slow]) {
    const cues = cuesFromWords(words);
    assert.equal(said(cues).join(' '), words.map((x) => x.w).join(' '));
    cues.forEach((c, i) => assert.ok(c.end > c.start && (i === 0 || c.start >= cues[i - 1]!.end + 0.04 - 1e-9), `cue ${i}`));
  }
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
  const ytt = formatYtt(cues, { color: '#ffd24d', edge: '#080808', position: [50, 90] });
  assert.match(ytt, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<timedtext format="3">\n<head>\n/);
  assert.match(ytt, /<pen id="1" b="1" fc="#FFD24D" fo="254" bc="#080808" bo="150" et="3" ec="#080808" fs="4" sz="100"\/>/);
  assert.match(ytt, /<wp id="1" ap="7" ah="50" av="90"\/>/);
  assert.match(ytt, /<p t="550" d="1850" wp="1" ws="1"><s p="1">Fish &amp; chips,\nhe said\.<\/s><\/p>/);
  assert.match(ytt, /<p t="3723004" d="2496" wp="1" ws="1"><s p="1">&lt;later&gt;<\/s><\/p>\n<\/body>\n<\/timedtext>\n$/);
  // The player drops fractional positions: they are rounded.
  const pen = { color: '#fefefe', edge: '#101010' };
  assert.match(formatYtt(cues, pen), /fc="#FEFEFE".* bc="#101010".* ec="#101010"/);
  assert.match(formatYtt(cues, { ...pen, position: [49.6, 95.4] }), /ah="50" av="95"/);
  assert.throws(() => formatYtt(cues, { ...pen, color: 'white' }), /color must be "#RRGGBB"/);
  // The engine has no colour of its own for a subtitle: the two colours are the production's to give.
  assert.throws(() => formatYtt(cues, { edge: '#101010' } as never), /color must be "#RRGGBB", got undefined; the colours of a subtitle are the production's to give/);
  assert.throws(() => formatYtt(cues, { color: '#fefefe' } as never), /edge must be "#RRGGBB"/);
  assert.throws(() => (formatYtt as unknown as (c: Cue[]) => string)(cues), /color must be "#RRGGBB"/);
  // The same cues always give the same files.
  assert.equal(formatYtt(cues, pen), formatYtt(cues, pen));
});
