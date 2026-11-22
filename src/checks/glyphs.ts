// Glyphs: every character of every string a shot shows, in every language,
// must be in one of the bundled fonts. A character that is in none of them
// would be drawn with whatever font the machine offers for it, or as an empty
// box: the frame would depend on the machine, and nothing else would notice.

import type { CNode, CompiledShot } from '../scene/compile.ts';
import type { LabelNode, TextNode } from '../scene/types.ts';
import { formatCount } from '../text/count.ts';
import { describeChar, missingGlyphs } from '../text/glyphs.ts';
import { parseRuns } from '../text/runs.ts';

export interface GlyphIssue {
  readonly lang: string;
  /** The key of the string. */
  readonly key: string;
  /** The characters of it that no bundled font has. */
  readonly chars: readonly string[];
  readonly message: string;
}

/** True when the node is a label or a text that shows the string of the key. */
function isTextual(n: CNode, key: string): n is CNode & { node: LabelNode | TextNode } {
  return (n.node.type === 'label' || n.node.type === 'text') && n.node.text === key;
}

/** The characters no bundled font has, in the strings the shot uses, for the given languages. */
export function checkGlyphs(c: CompiledShot, langs: readonly string[]): GlyphIssue[] {
  const issues: GlyphIssue[] = [];
  for (const lang of langs) {
    const table = c.spec.strings[lang];
    if (!table) continue;
    for (const key of c.stringKeys) {
      const text = table[key];
      // A missing string is the finding of the strings check.
      if (typeof text !== 'string') continue;
      // A node with a second ink shows its string without the marks of its runs; any other node shows it as it is,
      // and with them every character the first shows.
      const marksOnly = c.nodes.some((n) => isTextual(n, key)) && c.nodes.every((n) => !isTextual(n, key) || n.node.runInk !== undefined);
      let shown = marksOnly ? parseRuns(text).text : text;
      // A counter also shows its number, written the way the language writes numbers: its digits, its signs.
      for (const n of c.nodes) {
        if ((n.node.type !== 'text' && n.node.type !== 'label') || n.node.text !== key || !n.node.count || !n.count) continue;
        shown += '0123456789';
        for (const value of [n.count.base, ...n.count.segs.map((s) => s.to)]) shown += formatCount(value, n.node.count.decimals, lang, n.node.count.grouping !== false);
      }
      const chars = missingGlyphs(shown);
      if (chars.length === 0) continue;
      issues.push({
        lang,
        key,
        chars,
        message:
          `"${key}" [${lang}]: no bundled font has ${chars.map(describeChar).join(', ')}; ` +
          'it would be drawn with a font of the machine, or as an empty box. Write the string without it, or have a font that has it bundled with the engine',
      });
    }
  }
  return issues;
}
