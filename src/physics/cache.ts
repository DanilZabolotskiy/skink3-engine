// The bake: per-frame state of everything that has history, plus the contact
// events of the rigid-body world. It is the only source the evaluator reads
// such state from, in memory or from the on-disk cache, as 32-bit floats either
// way, so a frame looks the same whichever process draws it.
//
// File layout (little-endian):
//   8 bytes   magic "SK3BAKE1"
//   4 bytes   header length in bytes (u32)
//   header    UTF-8 JSON, padded with spaces to a multiple of 8 bytes
//   sections  bodies (f32), springs (f32), particleIndex (u32), particles (f32)

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256Hex } from '../core/hash.ts';

/** One rigid-body contact, recorded for later use (sound, particles). */
export interface ContactEvent {
  /** Frame in which the impact peaked. */
  readonly frame: number;
  /** Seconds from the start of the shot. */
  readonly time: number;
  /** Ids of the two nodes. */
  readonly a: string;
  readonly b: string;
  /** Contact point in the layer's space. */
  readonly x: number;
  readonly y: number;
  /** Peak normal impulse, in kg m/s for the default density (100 units = 1 m). */
  readonly impulse: number;
}

export interface BakeHeader {
  readonly format: 1;
  /** Engine version and source fingerprint. */
  readonly engine: string;
  /** Physics library and version. */
  readonly physics: string;
  readonly sceneHash: string;
  readonly seed: number;
  readonly shot: string;
  readonly frames: number;
  /** Node ids by slot. */
  readonly bodies: readonly string[];
  readonly springs: readonly string[];
  readonly emitters: readonly string[];
  readonly events: readonly ContactEvent[];
  /** Element counts of the binary sections. */
  readonly sizes: { readonly bodies: number; readonly springs: number; readonly particleIndex: number; readonly particles: number };
}

/** Floats per rigid body per frame: x, y, rotation (radians). */
export const BODY_STRIDE = 3;
/** Floats per spring per frame: x, y. */
export const SPRING_STRIDE = 2;
/** Floats per particle: x, y, radius, colour index. */
export const PARTICLE_STRIDE = 4;

export class Bake {
  readonly header: BakeHeader;
  readonly bodies: Float32Array;
  readonly springs: Float32Array;
  /** For emitter e and frame f, particles [index[e * (frames + 1) + f], index[e * (frames + 1) + f + 1]). */
  readonly particleIndex: Uint32Array;
  readonly particles: Float32Array;

  constructor(header: BakeHeader, bodies: Float32Array, springs: Float32Array, particleIndex: Uint32Array, particles: Float32Array) {
    this.header = header;
    this.bodies = bodies;
    this.springs = springs;
    this.particleIndex = particleIndex;
    this.particles = particles;
  }

  private frameOf(frame: number): number {
    const f = Math.round(frame);
    if (f < 0 || f >= this.header.frames) throw new RangeError(`frame ${frame} is outside the bake (0..${this.header.frames - 1})`);
    return f;
  }

  bodyX(slot: number, frame: number): number {
    return this.bodies[(this.frameOf(frame) * this.header.bodies.length + slot) * BODY_STRIDE]!;
  }

  bodyY(slot: number, frame: number): number {
    return this.bodies[(this.frameOf(frame) * this.header.bodies.length + slot) * BODY_STRIDE + 1]!;
  }

  bodyRot(slot: number, frame: number): number {
    return this.bodies[(this.frameOf(frame) * this.header.bodies.length + slot) * BODY_STRIDE + 2]!;
  }

  springX(slot: number, frame: number): number {
    return this.springs[(this.frameOf(frame) * this.header.springs.length + slot) * SPRING_STRIDE]!;
  }

  springY(slot: number, frame: number): number {
    return this.springs[(this.frameOf(frame) * this.header.springs.length + slot) * SPRING_STRIDE + 1]!;
  }

  /** The particles of an emitter at a frame: x, y, radius, colour index per particle. */
  particlesAt(slot: number, frame: number): Float32Array {
    const base = slot * (this.header.frames + 1) + this.frameOf(frame);
    const start = this.particleIndex[base]!;
    const end = this.particleIndex[base + 1]!;
    return this.particles.subarray(start * PARTICLE_STRIDE, end * PARTICLE_STRIDE);
  }
}

const MAGIC = 'SK3BAKE1';

export function serializeBake(bake: Bake): Uint8Array {
  let json = JSON.stringify(bake.header);
  let headerBytes = Buffer.from(json, 'utf8');
  const pad = (8 - (headerBytes.length % 8)) % 8;
  if (pad) {
    json += ' '.repeat(pad);
    headerBytes = Buffer.from(json, 'utf8');
  }
  const sections = [bake.bodies, bake.springs, bake.particleIndex, bake.particles];
  const total = 8 + 4 + 4 + headerBytes.length + sections.reduce((a, s) => a + s.byteLength, 0);
  const out = Buffer.alloc(total);
  out.write(MAGIC, 0, 'ascii');
  out.writeUInt32LE(headerBytes.length, 8);
  // 4 bytes of padding keep the sections 8-byte aligned.
  headerBytes.copy(out, 16);
  let offset = 16 + headerBytes.length;
  for (const s of sections) {
    Buffer.from(s.buffer, s.byteOffset, s.byteLength).copy(out, offset);
    offset += s.byteLength;
  }
  return out;
}

export function parseBake(bytes: Uint8Array): Bake {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 16 || buf.toString('ascii', 0, 8) !== MAGIC) throw new Error('not a bake cache file');
  const headerLen = buf.readUInt32LE(8);
  const header = JSON.parse(buf.toString('utf8', 16, 16 + headerLen)) as BakeHeader;
  if (header.format !== 1) throw new Error(`unsupported bake format ${String(header.format)}`);
  let offset = 16 + headerLen;
  // Copy each section into its own aligned buffer.
  const take = (count: number, bytesPer: number): ArrayBuffer => {
    const len = count * bytesPer;
    if (offset + len > buf.length) throw new Error('bake cache file is truncated');
    const ab = new ArrayBuffer(len);
    new Uint8Array(ab).set(buf.subarray(offset, offset + len));
    offset += len;
    return ab;
  };
  const bodies = new Float32Array(take(header.sizes.bodies, 4));
  const springs = new Float32Array(take(header.sizes.springs, 4));
  const particleIndex = new Uint32Array(take(header.sizes.particleIndex, 4));
  const particles = new Float32Array(take(header.sizes.particles, 4));
  return new Bake(header, bodies, springs, particleIndex, particles);
}

/** Hash of a bake exactly as it is stored. */
export function bakeHash(bake: Bake): string {
  return sha256Hex(serializeBake(bake));
}

export interface BakeKey {
  readonly engine: string;
  readonly physics: string;
  readonly sceneHash: string;
  readonly seed: number;
}

/** The cache file of a shot for a given key: <dir>/<shot>-<key>.bake */
export function bakeFile(dir: string, shotId: string, key: BakeKey): string {
  const digest = sha256Hex(`${key.engine}\n${key.physics}\n${key.sceneHash}\n${key.seed}`).slice(0, 16);
  return join(dir, `${shotId}-${digest}.bake`);
}

export function matchesKey(header: BakeHeader, key: BakeKey): boolean {
  return header.engine === key.engine && header.physics === key.physics && header.sceneHash === key.sceneHash && header.seed === key.seed;
}

export function writeBake(file: string, bake: Bake): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, serializeBake(bake));
  renameSync(tmp, file);
}

export function readBake(file: string): Bake {
  return parseBake(readFileSync(file));
}
