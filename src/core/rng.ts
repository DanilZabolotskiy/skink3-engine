// Seeded random numbers with named sub-streams.
//
// A stream is identified by (seed, name) only, never by how much another stream
// has been consumed. Adding a new consumer therefore cannot shift the numbers of
// an existing one, and nothing that affects pixels ever touches Math.random.

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

export class Rng {
  readonly seed: string;
  readonly name: string;
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number | string, name = 'root') {
    this.seed = String(seed);
    this.name = name;
    const h = xmur3(`${this.seed}\u0000${name}`);
    this.a = h();
    this.b = h();
    this.c = h();
    this.d = h();
    // Warm up: the first outputs of sfc32 correlate with the seed words.
    for (let i = 0; i < 12; i++) this.next();
  }

  /** An independent stream derived from this stream's seed and the given name. */
  stream(name: string): Rng {
    return new Rng(this.seed, `${this.name}/${name}`);
  }

  /** Uniform in [0, 1). */
  next(): number {
    // sfc32
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Uniform integer in [lo, hi], both inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** -1 or 1. */
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Standard normal (Box-Muller). */
  gauss(): number {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** A shuffled copy (Fisher-Yates). */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  }
}
