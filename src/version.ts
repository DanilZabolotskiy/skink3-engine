// Versions that key the bake cache.
//
// The engine version is the package version plus a fingerprint of the engine's
// own sources, so that any change to the engine invalidates old caches even when
// the package version has not been bumped yet. The physics version is the exact
// pin of the rigid-body library in package.json.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from './core/hash.ts';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));

export const PHYSICS_PACKAGE = '@dimforge/rapier2d-deterministic-compat';

interface PackageJson {
  version: string;
  dependencies: Record<string, string>;
}

let pkg: PackageJson | null = null;

function packageJson(): PackageJson {
  if (!pkg) pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as PackageJson;
  return pkg;
}

function listSources(dir: string, rel: string, out: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.isDirectory()) listSources(join(dir, entry.name), `${rel}${entry.name}/`, out);
    else if (entry.name.endsWith('.ts')) out.push(`${rel}${entry.name}`);
  }
}

let engine: string | null = null;

/** "<package version>+<source fingerprint>", e.g. "0.1.0+3fa9c1d2e4b5a697". */
export function engineVersion(): string {
  if (!engine) {
    const files: string[] = [];
    listSources(SRC_DIR, '', files);
    let all = '';
    for (const rel of files) {
      // Line endings are normalised so that a checkout with CRLF fingerprints the same.
      const text = readFileSync(join(SRC_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
      all += `${rel}\n${sha256Hex(text)}\n`;
    }
    engine = `${packageJson().version}+${sha256Hex(all).slice(0, 16)}`;
  }
  return engine;
}

/** The pinned physics library, e.g. "@dimforge/rapier2d-deterministic-compat@0.21.0". */
export function physicsVersion(): string {
  const pin = packageJson().dependencies[PHYSICS_PACKAGE];
  if (!pin || !/^\d+\.\d+\.\d+$/.test(pin)) {
    throw new Error(`${PHYSICS_PACKAGE} must be pinned to an exact version in package.json, got ${JSON.stringify(pin)}`);
  }
  return `${PHYSICS_PACKAGE}@${pin}`;
}
