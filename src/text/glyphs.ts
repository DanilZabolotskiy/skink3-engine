// Which characters the bundled fonts can draw. The canvas library does not say
// whether a glyph came from a family it was given or from a font of the
// machine, so the engine reads the character maps of its own font files: a
// character that is in none of them would make a frame depend on the machine,
// or would be drawn as an empty box.
//
// Only the `cmap` table of a TrueType file is read, in its two usual formats
// (4: the basic plane as segments; 12: all planes as groups).

import { readFileSync } from 'node:fs';
import { BUNDLED_FONTS, fontFile, type BundledFont } from './fonts.ts';

/** The code points a TrueType file has a glyph for. */
export function fontCodePoints(file: string): Set<number> {
  const b = readFileSync(file);
  const fail = (what: string): never => {
    throw new Error(`${file}: not a TrueType font the engine can read (${what})`);
  };
  if (b.length < 12) fail('too short');
  const tables = b.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < tables; i++) {
    const record = 12 + i * 16;
    if (b.toString('latin1', record, record + 4) === 'cmap') cmap = b.readUInt32BE(record + 8);
  }
  if (cmap < 0) fail('no cmap table');
  const out = new Set<number>();
  const count = b.readUInt16BE(cmap + 2);
  let read = 0;
  for (let i = 0; i < count; i++) {
    const record = cmap + 4 + i * 8;
    const platform = b.readUInt16BE(record);
    const encoding = b.readUInt16BE(record + 2);
    // Unicode tables only: platform 0, and platform 3 (Windows) with the encodings 1 (basic plane) and 10 (all planes).
    if (!(platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))) continue;
    const at = cmap + b.readUInt32BE(record + 4);
    const format = b.readUInt16BE(at);
    if (format === 4) {
      const twice = b.readUInt16BE(at + 6);
      const ends = at + 14;
      const starts = ends + twice + 2;
      const deltas = starts + twice;
      const ranges = deltas + twice;
      for (let s = 0; s < twice; s += 2) {
        const end = b.readUInt16BE(ends + s);
        const start = b.readUInt16BE(starts + s);
        const delta = b.readInt16BE(deltas + s);
        const range = b.readUInt16BE(ranges + s);
        for (let c = start; c <= end && c < 0xffff; c++) {
          let glyph: number;
          if (range === 0) glyph = (c + delta) & 0xffff;
          else {
            glyph = b.readUInt16BE(ranges + s + range + (c - start) * 2);
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph !== 0) out.add(c);
        }
      }
      read++;
    } else if (format === 12) {
      const groups = b.readUInt32BE(at + 12);
      for (let g = 0; g < groups; g++) {
        const group = at + 16 + g * 12;
        const start = b.readUInt32BE(group);
        const end = b.readUInt32BE(group + 4);
        const first = b.readUInt32BE(group + 8);
        for (let c = start; c <= end; c++) if (first + (c - start) !== 0) out.add(c);
      }
      read++;
    }
  }
  if (read === 0) fail('no Unicode character map in format 4 or 12');
  return out;
}

let maps: readonly { readonly font: BundledFont; readonly has: ReadonlySet<number> }[] | null = null;

function bundled(): readonly { readonly font: BundledFont; readonly has: ReadonlySet<number> }[] {
  if (!maps) maps = BUNDLED_FONTS.map((font) => ({ font, has: fontCodePoints(fontFile(font)) }));
  return maps;
}

/**
 * Characters that need no glyph: white space, where a line may break or whose
 * width the shaper works out from the main font (every space of Unicode), and
 * the characters Unicode says are not drawn by themselves (joiners, variation
 * selectors, a soft hyphen).
 */
const NO_GLYPH = /[\s\p{Zs}\p{Default_Ignorable_Code_Point}]/u;

/** The bundled font that draws a character: the first of the list that has it; null when none has. */
export function fontOf(char: string): BundledFont | null {
  const code = char.codePointAt(0);
  if (code === undefined) return null;
  for (const m of bundled()) if (m.has.has(code)) return m.font;
  return null;
}

/** The characters of a text that no bundled font has, each once, in the order they come. */
export function missingGlyphs(text: string): string[] {
  const out: string[] = [];
  for (const char of text) {
    if (NO_GLYPH.test(char) || out.includes(char)) continue;
    if (fontOf(char) === null) out.push(char);
  }
  return out;
}

/** A character as a message names it: itself, and its code point. */
export function describeChar(char: string): string {
  return `"${char}" (U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`;
}
