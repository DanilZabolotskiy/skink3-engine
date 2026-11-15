// Stable hashing of plain data. Object keys are sorted, so the hash does not
// depend on the order in which a scene happened to list its properties.

import { createHash } from 'node:crypto';

export function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) throw new Error('stableStringify: non-finite number');
      // -0 and 0 print the same; that is fine for hashing a scene description.
      return JSON.stringify(value);
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'undefined':
      return 'null';
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
      if (ArrayBuffer.isView(value)) {
        return `[${Array.from(value as unknown as ArrayLike<number>).map(stableStringify).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`stableStringify: cannot hash a value of type ${typeof value}`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hashOf(value: unknown): string {
  return sha256Hex(stableStringify(value));
}
