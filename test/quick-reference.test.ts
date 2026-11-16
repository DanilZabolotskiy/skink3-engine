// The quick reference, docs/QUICK-REFERENCE.md, is what a scene author reads
// instead of the whole guide, so it has to stay complete, true and short. These
// tests fail, and name what is missing, when the engine has an export for
// scenes, a command, an option of the command line, a kind of finding or a
// section of the guide that the reference does not name; when an example in it
// no longer runs, or shows a default the engine does not have; and when it
// grows past its cap.
//
// The rule they stand for: whoever adds or changes a feature updates the quick
// reference in the same commit.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli/main.ts';
import * as engine from '../src/index.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REFERENCE = 'docs/QUICK-REFERENCE.md';
const RULE = `add it to ${REFERENCE} in the commit that adds the feature`;

/** Most characters the reference may have. It is a reference, not a second guide. */
const MAX_CHARS = 16_000;

/** In an example, the options after this mark may be left out: the values written there are their defaults. */
const DEFAULTS_MARK = '/* = */';

/** A file of the repository as text, with the line ends of the repository whatever the checkout has. */
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');

const text = read(REFERENCE);

const FENCE = /^```([a-z]*)\n([\s\S]*?)^```$/gm;

/** The fenced blocks of the reference, each with the language written after its fence. */
const blocks = [...text.matchAll(FENCE)].map((m) => ({ lang: m[1]!, code: m[2]! }));

/** Everything the reference writes as code: its fenced blocks and the spans between backticks. */
const code = [...blocks.map((b) => b.code), ...[...text.replace(FENCE, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!)].join('\n');

/** True when the name stands in the code of the reference as a word of its own. */
function named(name: string): boolean {
  return new RegExp(`(?<![\\w$-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$-])`).test(code);
}

/**
 * What the public entry exports, read from its source: every name, the
 * section its comment puts it in ("Scene authoring", "Core helpers ...",
 * "Tools ..."), and whether it is only a type.
 */
function entryExports(): { name: string; section: string; type: boolean }[] {
  const out: { name: string; section: string; type: boolean }[] = [];
  for (const part of read('src/index.ts').split(/^\/\/ --- /m)) {
    const section = part.startsWith('//') ? '' : part.slice(0, part.indexOf('\n')).replace(/[\s-]+$/, '');
    const body = (section === '' ? part : part.slice(part.indexOf('\n'))).replace(/\/\/.*$/gm, '');
    const rest = body.replace(/export\s+(type\s+)?\{([^}]*)\}\s*from\s*'[^']+';/g, (_all, allTypes: string | undefined, list: string) => {
      for (const item of list.split(',').map((p) => p.trim()).filter((p) => p.length > 0)) {
        const name = item.replace(/^type\s+/, '').split(/\s+as\s+/).pop()!;
        out.push({ name, section, type: allTypes !== undefined || item.startsWith('type ') });
      }
      return '';
    });
    // Anything else in the entry would be an export that this function does not read.
    assert.equal(rest.trim(), '', 'src/index.ts holds more than "export { ... } from" lines: teach test/quick-reference.test.ts to read them');
  }
  return out;
}

/** What `skink3 help` prints. */
async function helpText(): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.join(' '));
  };
  try {
    await main(['help']);
  } finally {
    console.log = log;
  }
  return lines.join('\n');
}

/** A heading as the index names it: without backticks, and of a signature only the name of the function. */
const headingKey = (heading: string): string => heading.replace(/`/g, '').replace(/\(.*$/, '').trim();

/** The headings of a document under its title, as keys; `depth` is the number of # signs. */
function headings(path: string): { key: string; depth: number }[] {
  return [...read(path).replace(FENCE, '').matchAll(/^(#{2,6}) (.+)$/gm)].map((m) => ({ key: headingKey(m[2]!), depth: m[1]!.length }));
}

test('quick reference: it names every value the public entry exports for scenes', () => {
  const all = entryExports();
  const values = all.filter((e) => !e.type);
  assert.deepEqual(values.map((e) => e.name).sort(), Object.keys(engine).sort(), 'the values read from src/index.ts are the ones it exports when it runs');
  // The entry says which of its sections a scene module needs; what is under "Tools" (compile, bake, evaluate, review,
  // render) is for the programs around a scene, and docs/SCENES.md, "Programmatic use", is its reference. Types are
  // not asked for: the options they describe are in the examples.
  const forScenes = values.filter((e) => !e.section.startsWith('Tools'));
  assert.ok(forScenes.length > 0 && forScenes.length < values.length, 'src/index.ts still has its sections for scenes and its section "Tools"');
  const missing = forScenes.map((e) => e.name).filter((name) => !named(name));
  assert.deepEqual(missing, [], `${missing.length} export(s) of src/index.ts for scenes are not named: ${missing.join(', ')}; ${RULE}`);
});

test('quick reference: it has a line for every command of the CLI and names every option the help lists', async () => {
  const help = await helpText();
  const commands = [...help.slice(help.indexOf('Commands'), help.indexOf('Common options')).matchAll(/^ {2}([a-z]+) +\S/gm)].map((m) => m[1]!);
  assert.ok(commands.includes('check') && commands.includes('render'), 'the commands could not be read from the help of the CLI');
  const fenced = blocks.map((b) => b.code).join('\n');
  const noLine = commands.filter((c) => !new RegExp(`^${c} `, 'm').test(fenced));
  assert.deepEqual(noLine, [], `no line of a fenced block starts with the command(s) ${noLine.join(', ')}; ${RULE}`);
  const options = [...new Set(help.match(/--[a-z][a-z-]*/g) ?? [])];
  assert.ok(options.includes('--lang'), 'the options could not be read from the help of the CLI');
  const noOption = options.filter((o) => !named(o));
  assert.deepEqual(noOption, [], `the option(s) ${noOption.join(', ')} of the CLI are not named; ${RULE}`);
});

test('quick reference: it names every kind of finding of the two reviews', () => {
  const missing = [...engine.MOTION_FINDING_KINDS, ...engine.PHYSICS_FINDING_KINDS].filter((kind) => !named(kind));
  assert.deepEqual(missing, [], `the kind(s) of finding ${missing.join(', ')} have no line under "Reading the reviews"; ${RULE}`);
});

test('quick reference: every example in it runs, and the defaults it shows are the defaults of the engine', async () => {
  // The ts blocks are one module. Its import of the engine and its export are taken out, and the rest is run with
  // the engine's exports in scope.
  let body = blocks
    .filter((b) => b.lang === 'ts')
    .map((b) => b.code)
    .join('\n')
    .replace(/^import .* from 'skink3-engine';$/gm, '')
    .replace(/^export default .*$/gm, '');
  assert.ok(body.includes('shot('), 'the reference holds a whole scene among its ts blocks');
  // A call with the mark is run twice, as written and without what follows the mark: both must give the same data.
  const call = /^(.*?)(,?) \/\* = \*\/ (.*) \}\);( *\/\/.*)?$/;
  const lines = body.split('\n');
  const marked = lines.filter((line) => line.includes(DEFAULTS_MARK));
  assert.ok(marked.length > 0, `the reference shows defaults after ${DEFAULTS_MARK}`);
  const unread = marked.filter((line) => !call.test(line));
  assert.deepEqual(unread, [], `a line with ${DEFAULTS_MARK} is one call on one line that ends with " });"`);
  body = lines
    .map((line) =>
      line.replace(
        call,
        (_all, head: string, comma: string, defaults: string) => `__same(${JSON.stringify(line)}, ${head}${comma} ${defaults} }), ${head} }), { ${defaults} });`,
      ),
    )
    .join('\n');
  /** True when the value, or an object inside it, has the key. */
  const hasKey = (value: unknown, key: string): boolean =>
    typeof value === 'object' && value !== null && (key in value || Object.values(value).some((inner) => hasKey(inner, key)));
  const same = (line: string, written: unknown, bare: unknown, shown: Record<string, unknown>): void => {
    assert.deepEqual(written, bare, `the options after ${DEFAULTS_MARK} are not the defaults of the engine in: ${line}`);
    // An option the engine no longer knows would be left out of both runs. What a factory or an intent returns is
    // data built from its options, so every option shown must be in it.
    if (Array.isArray(written)) return;
    const unknown = Object.keys(shown).filter((key) => !hasKey(written, key));
    assert.deepEqual(unknown, [], `the engine does not keep the option(s) ${unknown.join(', ')} shown after ${DEFAULTS_MARK} in: ${line}`);
  };
  const AsyncFunction: new (...args: string[]) => (...args: unknown[]) => Promise<unknown> = Object.getPrototypeOf(async () => {}).constructor;
  let failure = '';
  try {
    await new AsyncFunction('__same', ...Object.keys(engine), body)(same, ...Object.values(engine));
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  assert.equal(failure, '', `an example in a ts block of ${REFERENCE} does not hold: ${failure}`);
});

test('quick reference: its index names every section of the guide, and only sections that exist', () => {
  // In the index a paragraph starts with the name of a document, and what it sets in bold are sections of it.
  const start = text.indexOf('\n## Index');
  assert.ok(start >= 0, `${REFERENCE} has a section "Index ..."`);
  const index = new Map<string, string[]>();
  for (const line of text.slice(start + 1).split('\n## ')[0]!.split('\n')) {
    const file = /^([A-Z-]+\.md):/.exec(line)?.[1];
    if (file === undefined) continue;
    index.set(file, [...line.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => headingKey(m[1]!)));
  }
  assert.ok(index.has('SCENES.md'), 'the index has a paragraph for SCENES.md');
  for (const [file, listed] of index) {
    const there = headings(`docs/${file}`);
    const gone = listed.filter((key) => !there.some((h) => h.key === key));
    assert.deepEqual(gone, [], `the index names section(s) that docs/${file} does not have: ${gone.join(', ')}`);
  }
  const unlisted = headings('docs/SCENES.md').filter((h) => h.depth === 2 && !index.get('SCENES.md')!.includes(h.key)).map((h) => h.key);
  assert.deepEqual(unlisted, [], `the index does not name the section(s) of docs/SCENES.md: ${unlisted.join(', ')}`);
});

test('quick reference: the guide and both review documents point to it at their head', () => {
  for (const file of ['docs/SCENES.md', 'docs/MOTION-REVIEW.md', 'docs/PHYSICS-REVIEW.md']) {
    const head = read(file).split(/^## /m)[0]!;
    assert.ok(head.includes('QUICK-REFERENCE.md'), `${file} points to QUICK-REFERENCE.md before its first section`);
  }
});

test(`quick reference: it has at most ${MAX_CHARS} characters`, () => {
  assert.ok(
    text.length <= MAX_CHARS,
    `${REFERENCE} has ${text.length} characters, the cap is ${MAX_CHARS}: say it shorter, or move the detail to docs/SCENES.md and point to its section`,
  );
});
