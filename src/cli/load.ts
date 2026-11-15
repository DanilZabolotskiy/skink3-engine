// Loading a scene module. The module may live anywhere, also outside this
// repository: it is resolved against the caller's working directory.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileShot, type CompiledShot } from '../scene/compile.ts';
import type { ShotSpec } from '../scene/types.ts';

function looksLikeShot(value: unknown): value is ShotSpec {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['id'] === 'string' && Array.isArray(v['layers']) && typeof v['seconds'] === 'number' && !!v['palette'];
}

/** Imports a scene module and compiles the shot it exports (default export, or an export named `shot`). */
export async function loadShot(scenePath: string): Promise<{ compiled: CompiledShot; file: string }> {
  const file = resolve(process.cwd(), scenePath);
  if (!existsSync(file)) throw new Error(`scene module not found: ${file}`);
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const candidate = mod['default'] ?? mod['shot'];
  if (!looksLikeShot(candidate)) {
    throw new Error(`${file} must export a shot made with shot({ ... }) as its default export (or as "shot")`);
  }
  return { compiled: compileShot(candidate), file };
}
