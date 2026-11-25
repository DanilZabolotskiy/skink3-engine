import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { sha256Hex } from '../core/hash.ts';
import { compileShot, type CompiledShot } from '../scene/compile.ts';
import { engineVersion } from '../version.ts';

interface Snapshot {
  readonly source: string;
  readonly engine: string;
  readonly sceneHash: string;
  readonly spec: CompiledShot['spec'];
}

/** A single render owns this file. A new invocation always prepares its current module again. */
export function prepareScene(dir: string, scene: string, compiled: Pick<CompiledShot, 'spec' | 'sceneHash'>) {
  const snapshot: Snapshot = { source: resolve(scene), engine: engineVersion(), sceneHash: compiled.sceneHash, spec: compiled.spec };
  const bytes = serialize(snapshot);
  const digest = sha256Hex(bytes);
  const folder = mkdtempSync(join(dir, '.render-scene-'));
  const file = join(folder, 'data.bin');
  const close = (): void => rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  try {
    writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    return { file, digest, close };
  } catch (error) {
    close();
    throw error;
  }
}

/** Check the digest from the parent before decoding. It covers the entire description, including the language tables. */
export function readPreparedScene(scene: string, path: string, digest: string): { compiled: CompiledShot; file: string } | undefined {
  try {
    const bytes = readFileSync(path);
    if (sha256Hex(bytes) !== digest) return undefined;
    const snapshot = deserialize(bytes) as Snapshot;
    const file = resolve(scene);
    if (snapshot.source !== file || snapshot.engine !== engineVersion()) return undefined;
    const compiled = compileShot(snapshot.spec);
    return compiled.sceneHash === snapshot.sceneHash ? { compiled, file } : undefined;
  } catch {
    return undefined;
  }
}
