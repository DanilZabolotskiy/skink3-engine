// The bake step: simulate everything that has history, once, at the fixed step,
// and store it per frame.
//
//   1. rigid bodies (and their contact events)
//   2. springs, which follow nodes that may themselves ride on bodies
//   3. particles, whose emitters may ride on any node and react to contacts
//
// The result is keyed by engine version, physics version, scene hash and seed.

import { existsSync } from 'node:fs';
import { SecondOrder, SWAY_MAX_RATE, swayLean, swayTurn } from '../core/dynamics.ts';
import { DEG, type Vec2 } from '../core/math.ts';
import { FPS, SIM_DT, SUBSTEPS } from '../core/time.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { computeWorld, keyedPose, posesFromBake, swayDirection, type PoseSource } from '../scene/evaluate.ts';
import { engineVersion, physicsVersion } from '../version.ts';
import {
  Bake,
  BAKE_FORMAT,
  bakeFile,
  BODY_STRIDE,
  matchesKey,
  PARTICLE_STRIDE,
  PARTICLE_TAIL_STRIDE,
  PARTICLE_VELOCITY_STRIDE,
  readBake,
  SPRING_STRIDE,
  writeBake,
  type BakeHeader,
  type BakeKey,
} from './cache.ts';
import { simulateEmitter } from './particles.ts';
import { sampleRise } from '../motion/tracks.ts';
import { simulateRigid, type RigidBodyDef } from './rigid.ts';

export function bakeKey(c: CompiledShot): BakeKey {
  return { engine: engineVersion(), physics: physicsVersion(), sceneHash: c.sceneHash, seed: c.spec.seed };
}

/**
 * Where every emitter is at every frame, by emitter slot: its own place, or
 * the place of the node it rides on plus its offset.
 */
export function emitterPlaces(c: CompiledShot, poses: PoseSource): Vec2[][] {
  const places: Vec2[][] = c.emitters.map(() => []);
  const anyAttached = c.emitters.some((i) => c.nodes[i]!.attachIndex >= 0);
  for (let f = 0; f < c.frames; f++) {
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
  return places;
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
    // A kinematic body is carried where its keys put it.
    const track = node.body.kind === 'kinematic' ? { track: (t: number) => keyedPose(n, t) } : {};
    return { id: n.id, shape: node.shape, x: node.at[0], y: node.at[1], rot: node.rotation * DEG, scale: node.scale, body: node.body, ...track };
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
  /** Swaying sticks: the lean the spring was following at the previous frame. */
  const swayTarget = new Float64Array(nSprings);
  // A hard cut starts every spring again at rest: the picture after it is a shot of its own.
  const cuts = new Set(c.cuts ?? []);
  const stepping: PoseSource = {
    body: bodyPose,
    spring: (slot, frame, rest) => {
      let sys = systems[slot];
      let value: Vec2;
      if (!sys || cuts.has(frame)) {
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
    // A swaying stick is a spring on its angle. It leans against the sideways
    // travel of its free end, by a bounded amount (swayLean), and the spring
    // follows that lean: so the stick lags when its parent moves or turns and
    // swings back, overshoots and settles when the parent stops. The angle is
    // the state, so it cannot jump; it is levelled off (swayTurn), so it cannot
    // whip round; and the lean it follows changes at a limited rate, so it is
    // not flicked, whatever the parent does. What is stored is the place of
    // the free end, at the lever's length from the pivot.
    sway: (slot, frame, pivot, rest, lever, shown) => {
      const params = c.nodes[c.springs[slot]!]!.springParams!;
      const tip: Vec2 = [pivot[0] + Math.cos(rest) * lever, pivot[1] + Math.sin(rest) * lever];
      let sys = systems[slot];
      let lean = 0;
      if (!sys || !shown || cuts.has(frame)) {
        // At rest at the start, and while the stick has no size: what happens unseen leaves no swing behind.
        sys = new SecondOrder(params, [0]);
        systems[slot] = sys;
        swayTarget[slot] = 0;
      } else {
        const prev = lastRest[slot]!;
        const lateral = (-(tip[0] - prev[0]) * Math.sin(rest) + (tip[1] - prev[1]) * Math.cos(rest)) * FPS;
        const from = swayTarget[slot]!;
        // The wanted lean changes no faster than SWAY_MAX_RATE: a jump of the parent is taken over a few frames.
        const most = SWAY_MAX_RATE / FPS;
        const target = Math.max(from - most, Math.min(from + most, swayLean(params, lateral, lever)));
        let y = sys.value;
        for (let k = 1; k <= SUBSTEPS; k++) y = sys.step(SIM_DT, [from + ((target - from) * k) / SUBSTEPS]);
        lean = swayTurn(y[0]!);
        swayTarget[slot] = target;
      }
      lastRest[slot] = tip;
      const o = (frame * nSprings + slot) * SPRING_STRIDE;
      springs[o] = pivot[0] + Math.cos(rest + lean) * lever;
      springs[o + 1] = pivot[1] + Math.sin(rest + lean) * lever;
      return swayDirection(springs[o]!, springs[o + 1]!, pivot, rest);
    },
  };
  if (nSprings > 0) {
    for (let f = 0; f < frames; f++) computeWorld(c, f, stepping);
  }

  // 3. Particles.
  const streaks = c.emitters.some((i) => { const node = c.nodes[i]!.node; return node.type === 'emitter' && node.streak !== undefined; });
  const fading = c.emitters.some((i) => { const node = c.nodes[i]!.node; return node.type === 'emitter' && node.fade !== undefined; });
  const header = (events: BakeHeader['events'], particleCount: number): BakeHeader => ({
    format: BAKE_FORMAT,
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
      particleVelocities: (particleCount / PARTICLE_STRIDE) * PARTICLE_VELOCITY_STRIDE,
      // Only a shot with an emitter of streaks names its tails.
      ...(streaks ? { particleTails: (particleCount / PARTICLE_STRIDE) * PARTICLE_TAIL_STRIDE } : {}),
      // Only a shot with an emitter that fades its particles names their opacities.
      ...(fading ? { particleAlphas: particleCount / PARTICLE_STRIDE } : {}),
    },
  });
  const nEmitters = c.emitters.length;
  const particleIndex = new Uint32Array(nEmitters * (frames + 1));
  let particles = new Float32Array(0);
  let velocities = new Float32Array(0);
  let tails = new Float32Array(0);
  let alphas = new Float32Array(0);
  if (nEmitters > 0) {
    // Where every emitter is at every frame, from the state baked so far.
    const partial = new Bake(header(rigid.events, 0), rigid.poses, springs, particleIndex, particles, velocities);
    const places = emitterPlaces(c, posesFromBake(partial));
    const results = c.emitters.map((index, slot) => {
      const n = c.nodes[index]!;
      const node = n.node;
      if (node.type !== 'emitter') throw new Error('not an emitter');
      // An emitter with a rateTo sends out the rate its track gives at each moment.
      const rate = n.rate;
      return simulateEmitter(node, frames, c.spec.seed, (f) => places[slot]![f]!, rigid.events, rate ? (t) => sampleRise(rate, t) : null);
    });
    const total = results.reduce((a, r) => a + r.data.length, 0);
    particles = new Float32Array(total);
    velocities = new Float32Array((total / PARTICLE_STRIDE) * PARTICLE_VELOCITY_STRIDE);
    // Round particles have no tail: theirs stay 0, 0.
    if (streaks) tails = new Float32Array((total / PARTICLE_STRIDE) * PARTICLE_TAIL_STRIDE);
    // Opaque particles of an emitter without a fade keep an opacity of 1.
    if (fading) alphas = new Float32Array(total / PARTICLE_STRIDE).fill(1);
    let offset = 0;
    results.forEach((r, slot) => {
      particles.set(r.data, offset);
      const base = offset / PARTICLE_STRIDE;
      velocities.set(r.velocity, base * PARTICLE_VELOCITY_STRIDE);
      if (r.tails) tails.set(r.tails, base * PARTICLE_TAIL_STRIDE);
      if (r.alphas) alphas.set(r.alphas, base);
      for (let f = 0; f <= frames; f++) particleIndex[slot * (frames + 1) + f] = base + r.index[f]!;
      offset += r.data.length;
    });
  }

  return new Bake(header(rigid.events, particles.length), rigid.poses, springs, particleIndex, particles, velocities, tails, alphas);
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
