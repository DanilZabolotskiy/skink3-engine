// String tables: language -> key -> text. Scene code only ever holds keys.

/** Tables by language tag, e.g. { en: { 'label.core': 'Core' } }. */
export type StringTables = Readonly<Record<string, Readonly<Record<string, string>>>>;

export class StringsError extends Error {}

/** Keys look like identifiers with dots, so a sentence cannot be passed where a key belongs. */
export const KEY_PATTERN = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/;

export function isStringKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

export function languagesOf(tables: StringTables): string[] {
  return Object.keys(tables);
}

/** The text of a key in a language; throws with a precise message if it is missing. */
export function resolveString(tables: StringTables, lang: string, key: string): string {
  const table = tables[lang];
  if (!table) {
    throw new StringsError(`no string table for language "${lang}" (available: ${Object.keys(tables).join(', ') || 'none'})`);
  }
  const text = table[key];
  if (typeof text !== 'string') {
    throw new StringsError(`string key "${key}" is missing in language "${lang}"`);
  }
  return text;
}

export interface StringsIssue {
  readonly lang: string;
  readonly key: string;
  readonly message: string;
}

/** Every key used by the scene must exist, non-empty, in every language. */
export function checkStrings(tables: StringTables, usedKeys: readonly string[]): StringsIssue[] {
  const issues: StringsIssue[] = [];
  for (const lang of Object.keys(tables)) {
    const table = tables[lang]!;
    for (const key of usedKeys) {
      const text = table[key];
      if (typeof text !== 'string') issues.push({ lang, key, message: `"${key}" is missing in "${lang}"` });
      else if (text.trim().length === 0) issues.push({ lang, key, message: `"${key}" is empty in "${lang}"` });
    }
  }
  return issues;
}
