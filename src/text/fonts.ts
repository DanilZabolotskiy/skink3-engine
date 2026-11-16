// Fonts. The engine draws text only with the families it ships, registered
// under its own names, so a render never depends on what is installed on the
// machine.
//
// The first family is the typeface of the engine. The ones after it are drawn
// where it has no glyph: a character is taken from the first family of the
// list that has it. A character that none of them has would be drawn with a
// font of the machine, or as an empty box; the glyph check (glyphs.ts) fails
// on it before anything is rendered.

import { fileURLToPath } from 'node:url';
import { FontLibrary } from 'skia-canvas';

/** The family name text is drawn with. It maps to the bundled font files only. */
export const FONT_FAMILY = 'skink3-sans';

export interface BundledFont {
  /** The name the family is registered under. */
  readonly family: string;
  /** The typeface, as its makers call it. */
  readonly name: string;
  /** Its file, relative to this module. */
  readonly file: string;
}

/**
 * The bundled families, in the order they are tried for a character. All are
 * under the SIL Open Font License 1.1 (the OFL.txt next to each file) and are
 * the files their projects publish, unmodified:
 *
 *   Nunito              github.com/googlefonts/nunito: Latin, Latin Extended, Cyrillic, Vietnamese, the common signs
 *   Noto Sans           2.015, github.com/google/fonts, ofl/notosans, commit 2984c57: fractions, super- and
 *                       subscripts, letterlike signs, punctuation, Greek, more Latin and Cyrillic
 *   Noto Sans Symbols   2.003, github.com/google/fonts, ofl/notosanssymbols, commit caa8c83: arrows, Roman
 *                       numerals, technical and other symbols
 *
 * All three have a weight axis, so a character from a fallback family is
 * drawn in the weight of the text around it (the two Noto families up to 900).
 */
export const BUNDLED_FONTS: readonly BundledFont[] = [
  { family: FONT_FAMILY, name: 'Nunito', file: '../../assets/fonts/nunito/Nunito-wght.ttf' },
  { family: 'skink3-sans-fallback', name: 'Noto Sans', file: '../../assets/fonts/noto-sans/NotoSans-wdth-wght.ttf' },
  { family: 'skink3-symbols', name: 'Noto Sans Symbols', file: '../../assets/fonts/noto-sans-symbols/NotoSansSymbols-wght.ttf' },
];

/** Where a bundled font file is on disk. */
export function fontFile(font: BundledFont): string {
  return fileURLToPath(new URL(font.file, import.meta.url));
}

let registered = false;

/** Registers the bundled families once per process. */
export function ensureFonts(): void {
  if (registered) return;
  for (const font of BUNDLED_FONTS) {
    const file = fontFile(font);
    const fonts = FontLibrary.use(font.family, [file]);
    if (fonts.length === 0) throw new Error(`could not load the bundled font from ${file}`);
  }
  registered = true;
}

const FAMILIES = BUNDLED_FONTS.map((font) => font.family).join(', ');

/** A canvas font string for the bundled families: the engine's typeface, then its fallbacks. */
export function fontString(size: number, weight: number): string {
  return `${weight} ${size}px ${FAMILIES}`;
}
