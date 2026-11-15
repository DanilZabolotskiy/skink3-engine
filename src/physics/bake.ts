// The bake step: simulate everything that has history, once, at the fixed step,
// and store it per frame.
//
//   1. rigid bodies (and their contact events)
//   2. springs, which follow nodes that may themselves ride on bodies
//   3. particles, whose emitters may ride on any node and react to contacts
//
// The result is keyed by engine version, physics version, scene hash and seed.

import { existsSync } from 'node:fs';
import { SecondOrder } from '../core/dynamics.ts';
import { DEG, type Vec2 } from '../core/math.ts';
import { SIM_DT, SUBSTEPS } from '../core/time.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { computeWorld, posesFromBake, type PoseSource } from '../scene/evaluate.ts';
import { engineVersion, physicsVersion } from '../version.ts';
import {
  Bake,
  bakeFile,
  BODY_STRIDE,
  matchesKey,
  readBake,
  SPRING_STRIDE,
  writeBake,
  type BakeHeader,
  type BakeKey,
} from './cache.ts';
import { simulateEmitter } from './particles.ts';
import { simulateRigid, type RigidBodyDef } from './rigid.ts';

export function bakeKey(c: CompiledShot): BakeKey {
  return { engine: engineVersion(), physics: physicsVersion(), sceneHash: c.sceneHash, seed: c.spec.seed };
}

/** Runs the whole bake in memory. */
export async function bakeShot(c: CompiledShot): Promise<Bake> {
  const frames = c.frames;
  const key = bakeKey(c);

  // 1. Rigid bodies.
  const defs: RigidBodyDef[] = c.bodies.map((index) => {
    const n = c.nodes[index]!;
    const node = n.node;
    if (node.type !== 'shape' || !node.body) throw new Error(`"${n.id}" is not a rigid body`);
    return { id: n.id, shape: node.shape, x: node.at[0], y: node.at[1], rot: node.rotation * DEG, scale: node.scale, body: node.body };
  });
  const rigid = await simulateRigid(defs, c.spec.physics, frames);
  const nBodies = defs.length;
  const bodyPose = (slot: number, frame: number): { x: number; y: number; rot: number } => {
    const o = (frame * nBodies + slot) * BODY_STRIDE;
    return { x: rigid.poses[o]!, y: rigid.poses[o + 1]!, rot: rigid.poses[o + 2]! };
  };

  // 2. Springs. Frames are visited in order; within a frame parents come before
  // children, so a spring always sees the final pose of what it hangs on.
  const nSprings = c.springs.length;
  const springs = new Float32Array(frames * nSprings * SPRING_STRIDE);
  const systems: (SecondOrder | null)[] = new Array<SecondOrder | null>(nSprings).fill(null);
  const lastRest: Vec2[] = new Array<Vec2>(nSprings).fill([0, 0]);
  const stepping: PoseSource = {
    body: bodyPose,
    spring: (slot, frame, rest) => {
      let sys = systems[slot];
      let value: Vec2;
      if (!sys) {
        sys = new SecondOrder(c.nodes[c.springs[slot]!]!.springParams!, rest);
        systems[slot] = sys;
        value = rest;
      } else {
        const prev = lastRest[slot]!;
        let y = sys.value;
        for (let k = 1; k <= SUBSTEPS; k++) {
          const u = k / SUBSTEPS;
          y = sys.step(SIM_DT, [prev[0] + (rest[0] - prev[0]) * u, prev[1] + (rest[1] - prev[1]) * u]);
        }
        value = [y[0]!, y[1]!];
      }
      lastRest[slot] = rest;
      const o = (frame * nSprings + slot) * SPRING_STRIDE;
      springs[o] = value[0];
      springs[o + 1] = value[1];
      // Hand back exactly what was stored, so that parents and children agree with a later read.
      return [springs[o]!, springs[o + 1]!];
    },
  };
  if (nSprings > 0) {
    for (let f = 0; f < frames; f++) computeWorld(c, f, stepping);
  }

  // 3. Particles.
  const header = (events: BakeHeader['events'], particleCount: number): BakeHeader => ({
    format: 1,
    engine: key.engine,
    physics: key.physics,
    sceneHash: key.sceneHash,
    seed: key.seed,
    shot: c.spec.id,
    frames,
    bodies: c.bodies.map((i) => c.nodes[i]!.id),
    springs: c.springs.map((i) => c.nodes[i]!.id),
    emitters: c.emitters.map((i) => c.nodes[i]!.id),
    events,
    sizes: {
      bodies: rigid.poses.length,
      springs: springs.length,
      particleIndex: c.emitters.length * (frames + 1),
      particles: particleCount,
    },
  });
  const nEmitters = c.emitters.length;
  const particleIndex = new Uint32Array(nEmitters * (frames + 1));
  let particles = new Float32Array(0);
  if (nEmitters > 0) {
    // Where every emitter is at every frame, from the state baked so far.
    const partial = new Bake(header(rigid.events, 0), rigid.poses, springs, particleIndex, particles);
    const poses = posesFromBake(partial);
    const places: Vec2[][] = c.emitters.map(() => []);
    const anyAttached = c.emitters.some((i) => c.nodes[i]!.attachIndex >= 0);
    for (let f = 0; f < frames; f++) {
      const world = anyAttached ? computeWorld(c, f, poses) : null;
      c.emitters.forEach((index, slot) => {
        const n = c.nodes[index]!;
        const node = n.node;
        if (node.type !== 'emitter') throw new Error(`"${n.id}" is not an emitter`);
        if (n.attachIndex >= 0 && world) {
          const xf = world[n.attachIndex]!;
          places[slot]!.push([xf.x + node.at[0], xf.y + node.at[1]]);
        } else {
          places[slot]!.push(node.at);
        }
      });
    }
    const results = c.emitters.map((index, slot) => {
      const node = c.nodes[index]!.node;
      if (node.type !== 'emitter') throw new Error('not an emitter');
      return simulateEmitter(node, frames, c.spec.seed, (f) => places[slot]![f]!, rigid.events);
    });
    const total = results.reduce((a, r) => a + r.data.length, 0);
    particles = new Float32Array(total);
    let offset = 0;
    results.forEach((r, slot) => {
      particles.set(r.data, offset);
      const base = offset / 4;
      for (let f = 0; f <= frames; f++) particleIndex[slot * (frames + 1) + f] = base + r.index[f]!;
      offset += r.data.length;
    });
  }

  return new Bake(header(rigid.events, particles.length), rigid.poses, springs, particleIndex, particles);
}

export interface EnsureBakeResult {
  readonly bake: Bake;
  readonly file: string;
  /** True when the cache was missing or stale and the bake ran. */
  readonly baked: boolean;
  readonly seconds: number;
}

/** Loads the bake of a shot from the cache directory, or runs it and stores it. */
export async function ensureBake(c: CompiledShot, cacheDir: string, opts: { force?: boolean } = {}): Promise<EnsureBakeResult> {
  const key = bakeKey(c);
  const file = bakeFile(cacheDir, c.spec.id, key);
  const t0 = performance.now();
  if (!opts.force && existsSync(file)) {
    try {
      const bake = readBake(file);
      if (matchesKey(bake.header, key) && bake.header.frames === c.frames) {
        return { bake, file, baked: false, seconds: (performance.now() - t0) / 1000 };
      }
    } catch {
      // An unreadable cache file is simply replaced.
    }
  }
  const bake = await bakeShot(c);
  writeBake(file, bake);
  return { bake, file, baked: true, seconds: (performance.now() - t0) / 1000 };
}
