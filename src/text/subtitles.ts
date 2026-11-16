// Subtitles from the word timings of a narration. The words of a voice take,
// each with its start and its end, are cut into cues that read well (a set
// number of characters and lines, breaks at the ends of sentences and at
// pauses) and written out as SubRip (.srt), WebVTT (.vtt) or YouTube timed
// text (.ytt). Pure functions: the same words always give the same files.
//
// Nothing here knows a language. Lines break at ordinary spaces; a no-break
// space keeps two words together, as in the label layout.

export interface SpokenWord {
  /** The word as it is written, with its punctuation. */
  readonly w: string;
  /** Seconds from the start of the video. */
  readonly start: number;
  readonly end: number;
}

export interface Cue {
  readonly start: number;
  readonly end: number;
  /** The lines shown, top first. */
  readonly lines: readonly string[];
}

export interface CueOptions {
  /** Most characters on a line; default 42. */
  readonly maxChars?: number;
  /** Most lines in a cue; default 2. */
  readonly maxLines?: number;
  /** A cue is not kept on screen longer than this; default 6 s. */
  readonly maxSeconds?: number;
  /** A cue stays at least this long when the next one leaves room; default 1 s. */
  readonly minSeconds?: number;
  /** A silence at least this long ends a cue; default 0.5 s. */
  readonly pause?: number;
  /** A cue appears this long before its first word; default 0.05 s. */
  readonly lead?: number;
  /** A cue stays this long after its last word, if the next one leaves room; default 0.2 s. */
  readonly hold?: number;
  /** Time between two cues; default 0.04 s. */
  readonly gap?: number;
}

const DEFAULTS: Required<CueOptions> = { maxChars: 42, maxLines: 2, maxSeconds: 6, minSeconds: 1, pause: 0.5, lead: 0.05, hold: 0.2, gap: 0.04 };

/** The same words, later (or earlier) by a number of seconds: a take placed in a video. */
export function shiftWords(words: readonly SpokenWord[], seconds: number): SpokenWord[] {
  return words.map((x) => ({ w: x.w, start: x.start + seconds, end: x.end + seconds }));
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const CLAUSE_END = /[,;:—–]["'”’)\]]*$/;

/** Splits a text into at most `maxLines` lines of at most `maxChars`, as even as they can be; null if it does not fit. */
export function wrapCue(text: string, maxChars: number, maxLines: number): string[] | null {
  const words = text.split(/[ \t\n\r\f\v]+/).filter((w) => w.length > 0);
  if (words.length === 0) return [''];
  if (words.some((w) => w.length > maxChars)) return words.length === 1 ? [words[0]!] : null;
  const fits = (width: number): string[] | null => {
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && next.length > width) {
        lines.push(line);
        line = w;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    return lines.length <= maxLines ? lines : null;
  };
  const widest = fits(maxChars);
  if (!widest) return null;
  // The narrowest width that still gives this number of lines: the lines come out even.
  let best = widest;
  for (let width = maxChars - 1; width >= 1; width--) {
    const lines = fits(width);
    if (!lines || lines.length > widest.length) break;
    best = lines;
  }
  return best;
}

/**
 * Cuts the words of a narration into subtitle cues.
 *
 * A cue ends at the end of a sentence, at a pause, or where another word would
 * not fit; when it has to end inside a sentence it prefers the last comma. No
 * cue overlaps the next one, and every word is in exactly one cue, in order.
 */
export function cuesFromWords(words: readonly SpokenWord[], options: CueOptions = {}): Cue[] {
  const o = { ...DEFAULTS, ...options };
  if (!(o.maxChars >= 8) || !(o.maxLines >= 1)) throw new Error('subtitles: maxChars must be at least 8 and maxLines at least 1');
  for (let i = 0; i < words.length; i++) {
    const x = words[i]!;
    if (!(x.end >= x.start) || (i > 0 && x.start < words[i - 1]!.start)) throw new Error(`subtitles: the words are not in order of time at "${x.w}" (${x.start} s)`);
  }

  // 1. Groups of words: [first, last] indices.
  const groups: [number, number][] = [];
  let first = 0;
  while (first < words.length) {
    let last = first;
    let comma = -1;
    for (;;) {
      const w = words[last]!;
      if (SENTENCE_END.test(w.w)) break;
      const next = words[last + 1];
      if (!next) break;
      if (next.start - w.end >= o.pause) break;
      const text = words.slice(first, last + 2).map((x) => x.w).join(' ');
      const tooLong = wrapCue(text, o.maxChars, o.maxLines) === null || next.end - words[first]!.start > o.maxSeconds;
      if (tooLong) {
        // Inside a sentence: back to the last comma, if that leaves a cue of a fair length.
        if (comma >= first && comma - first + 1 >= 2 && words.slice(first, comma + 1).map((x) => x.w).join(' ').length >= (o.maxChars * o.maxLines) / 3) last = comma;
        break;
      }
      if (CLAUSE_END.test(w.w)) comma = last;
      last++;
    }
    groups.push([first, last]);
    first = last + 1;
  }

  // 2. Times: a little before the first word, a little after the last, never into the next cue.
  const cues: Cue[] = [];
  groups.forEach(([a, b], i) => {
    const text = words.slice(a, b + 1).map((x) => x.w).join(' ');
    const lines = wrapCue(text, o.maxChars, o.maxLines) ?? [text];
    const prevEnd = cues.length > 0 ? cues[cues.length - 1]!.end : -Infinity;
    const start = Math.max(words[a]!.start - o.lead, prevEnd + o.gap, 0);
    const nextGroup = groups[i + 1];
    const limit = nextGroup ? Math.max(words[b]!.end, words[nextGroup[0]]!.start - o.lead - o.gap) : Infinity;
    let end = Math.min(words[b]!.end + o.hold, limit);
    if (end - start < o.minSeconds) end = Math.min(start + o.minSeconds, limit);
    cues.push({ start, end: Math.max(end, start + 0.001), lines });
  });
  return cues;
}

function clock(seconds: number, separator: string): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (v: number, n: number): string => String(v).padStart(n, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${separator}${pad(ms % 1000, 3)}`;
}

/** SubRip: numbered cues, "00:00:01,000 --> 00:00:02,500". */
export function formatSrt(cues: readonly Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${clock(c.start, ',')} --> ${clock(c.end, ',')}\n${c.lines.join('\n')}\n`).join('\n');
}

/** WebVTT. */
export function formatVtt(cues: readonly Cue[]): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `WEBVTT\n\n${cues.map((c) => `${clock(c.start, '.')} --> ${clock(c.end, '.')}\n${c.lines.map(esc).join('\n')}\n`).join('\n')}`;
}

export interface YttStyle {
  /** Text colour, "#RRGGBB"; default "#FEFEFE" (the player drops pure white). */
  readonly color?: string;
  /** Colour of the outline and of the box behind the line; default "#080808". */
  readonly edge?: string;
  /** Opacity of the box behind the line, 0..255; default 150. */
  readonly box?: number;
  /** Size in percent of the viewer's own size; default 100. */
  readonly size?: number;
  /** Bold; default true. */
  readonly bold?: boolean;
  /** Where the lower middle of the cue sits, in whole percent of the frame; default [50, 96]. */
  readonly position?: readonly [number, number];
}

/**
 * YouTube timed text (the "srv3" format of the player, saved as .ytt): unlike
 * .srt it carries the colour, the outline, the size and the place of the text.
 * One pen and one position for the whole file.
 */
export function formatYtt(cues: readonly Cue[], style: YttStyle = {}): string {
  const hex = (name: string, v: string): string => {
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw new Error(`subtitles: ${name} must be "#RRGGBB", got ${JSON.stringify(v)}`);
    return v.toUpperCase();
  };
  const color = hex('color', style.color ?? '#FEFEFE');
  const edge = hex('edge', style.edge ?? '#080808');
  const box = Math.max(0, Math.min(255, Math.round(style.box ?? 150)));
  const size = Math.round(style.size ?? 100);
  const [ah, av] = (style.position ?? [50, 96]).map((v) => Math.max(0, Math.min(100, Math.round(v)))) as [number, number];
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const body = cues
    .map((c) => {
      const t = Math.max(0, Math.round(c.start * 1000));
      const d = Math.max(1, Math.round(c.end * 1000) - t);
      return `<p t="${t}" d="${d}" wp="1" ws="1"><s p="1">${c.lines.map(esc).join('\n')}</s></p>`;
    })
    .join('\n');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<timedtext format="3">',
    '<head>',
    // fs 4 is the proportional sans-serif of the player; et 3 is an outline; fo and bo are opacities out of 255.
    `<pen id="1" b="${style.bold === false ? 0 : 1}" fc="${color}" fo="254" bc="${edge}" bo="${box}" et="3" ec="${edge}" fs="4" sz="${size}"/>`,
    // ju 2 centres the lines. ap 7 anchors the window by the middle of its lower edge; ah and av must be whole numbers.
    '<ws id="1" ju="2" pd="0" sd="0"/>',
    `<wp id="1" ap="7" ah="${ah}" av="${av}"/>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</timedtext>',
    '',
  ].join('\n');
}
