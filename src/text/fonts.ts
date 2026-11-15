// Fonts. The engine draws text only with the family it ships, registered under
// its own name, so a render never depends on what is installed on the machine.

import { fileURLToPath } from 'node:url';
import { FontLibrary } from 'skia-canvas';

/** The family name text is drawn with. It maps to the bundled font files only. */
export const FONT_FAMILY = 'skink3-sans';

/** Bundled files (SIL Open Font License; see assets/fonts/nunito/OFL.txt). */
const FONT_FILES = ['../../assets/fonts/nunito/Nunito-wght.ttf'];

let registered = false;

/** Registers the bundled family once per process. */
export function ensureFonts(): void {
  if (registered) return;
  const files = FONT_FILES.map((rel) => fileURLToPath(new URL(rel, import.meta.url)));
  const fonts = FontLibrary.use(FONT_FAMILY, files);
  if (fonts.length === 0) throw new Error(`could not load the bundled font from ${files.join(', ')}`);
  registered = true;
}

/** A canvas font string for the bundled family. */
export function fontString(size: number, weight: number): string {
  return `${weight} ${size}px ${FONT_FAMILY}`;
}
