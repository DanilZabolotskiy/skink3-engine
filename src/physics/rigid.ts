// Rigid bodies: a thin wrapper over Rapier 2D (deterministic build).
//
// Bodies are built from the engine's shapes. The world runs at the fixed
// simulation step with style-tuned defaults: lower gravity, more drag and softer
// impacts than real, because the goal is motion that reads well, not accuracy.
// Contacts are recorded with their peak impulse for later use (sound, particles).

import RAPIER from '@dimforge/rapier2d-deterministic-compat';
import { DEG } from '../core/math.ts';
import { FPS, SIM_DT, SUBSTEPS } from '../core/time.ts';
import { capsuleCenters, insetConvex, outline, scaleShape, type ShapeSpec } from '../shape/geometry.ts';
import type { BodySpec, PhysicsSpec } from '../scene/types.ts';
import { physicsVersion } from '../version.ts';
import { BODY_STRIDE, type ContactEvent } from './cache.ts';

/** Scene units per metre: tolerances of the solver are scaled by this. */
export const UNITS_PER_METER = 100;
/** Mass per square unit at density 1: a 100 x 100 unit square weighs 1 kg. */
export const BASE_DENSITY = 1 / (UNITS_PER_METER * UNITS_PER_METER);
/** Stiffness of contacts in Hz (the solver's default); soft landings come from low restitution and drag. */
export const CONTACT_FREQUENCY = 30;
/** Solver iterations per step: twice the default, so that a resting pile does not sink into itself. */
export const SOLVER_ITERATIONS = 8;
/** How far beyond its reach a moving kinematic body wakes the bodies asleep around it, in units. */
const WAKE_MARGIN = 4;
/** Substeps after first touch over which the peak impulse of a contact is taken. */
const IMPACT_WINDOW = 4;
/** Impacts weaker than this (kg m/s) are not recorded. */
export const MIN_RECORDED_IMPULSE = 0.01;

let ready: Promise<void> | null = null;

/** Loads the physics library once per process and checks it is the pinned version. */
export async function loadRapier(): Promise<typeof RAPIER> {
  if (!ready) {
    ready = RAPIER.init().then(() => {
      const pinned = physicsVersion();
      const actual = RAPIER.version();
      if (!pinned.endsWith(`@${actual}`)) {
        throw new Error(`physics library is ${actual}, but package.json pins ${pinned}`);
      }
    });
  }
  await ready;
  return RAPIER;
}

export interface RigidBodyDef {
  readonly id: string;
  readonly shape: ShapeSpec;
  readonly x: number;
  readonly y: number;
  /** Radians. */
  readonly rot: number;
  readonly scale: number;
  readonly body: BodySpec;
  /** A kinematic body: where its keys put it at a time in seconds from the start of the shot (rot in radians). */
  readonly track?: (seconds: number) => { readonly x: number; readonly y: number; readonly rot: number };
}

export interface RigidResult {
  /** frames x bodies x (x, y, rotation). */
  readonly poses: Float32Array;
  readonly events: ContactEvent[];
}

/**
 * The collider of a shape, as the world builds it. The physics review works out
 * the same geometry by itself (src/review/collide.ts), and a test holds the two
 * against each other: a change here is a change there.
 */
export function colliderFor(R: typeof RAPIER, shape: ShapeSpec, id: string): RAPIER.ColliderDesc {
  switch (shape.kind) {
    case 'circle':
      return R.ColliderDesc.ball(shape.r);
    case 'capsule': {
      const [c0, c1] = capsuleCenters(shape);
      // Rapier's capsule stands along y; the engine's lies along x.
      return R.ColliderDesc.capsule((c1[0] - c0[0]) / 2, shape.r)
        .setRotation(Math.PI / 2)
        .setTranslation((c0[0] + c1[0]) / 2, 0);
    }
    case 'polygon': {
      // The factory refuses a region as a body; a free-form outline has no convex collider.
      if (shape.smooth !== undefined) throw new Error(`body "${id}": a region cannot be a rigid body`);
      const pts = shape.radius > 0 ? insetConvex(shape.points, shape.radius) : shape.points;
      const flat = new Float32Array(pts.length * 2);
      pts.forEach((p, i) => {
        flat[i * 2] = p[0];
        flat[i * 2 + 1] = p[1];
      });
      const desc = shape.radius > 0 ? R.ColliderDesc.roundConvexHull(flat, shape.radius) : R.ColliderDesc.convexHull(flat);
      if (!desc) throw new Error(`body "${id}": could not build a convex collider from the polygon`);
      return desc;
    }
    case 'blob': {
      const pts = outline(shape, 28);
      const flat = new Float32Array(pts.length * 2);
      pts.forEach((p, i) => {
        flat[i * 2] = p[0];
        flat[i * 2 + 1] = p[1];
      });
      const desc = R.ColliderDesc.convexHull(flat);
      if (!desc) throw new Error(`body "${id}": could not build a convex collider from the blob`);
      return desc;
    }
  }
}

/** The track of a kinematic body; a body without one stands where it was put. */
function trackOf(def: RigidBodyDef): (seconds: number) => { readonly x: number; readonly y: number; readonly rot: number } {
  return def.track ?? (() => ({ x: def.x, y: def.y, rot: def.rot }));
}

/**
 * Simulates the rigid bodies of a shot and returns their pose at every frame.
 * A dynamic body holds its authored pose until its release time, then joins the
 * world. A kinematic body is in the world from the start and is carried, step by
 * step, to where its track puts it at the end of the step: the solver gives the
 * dynamic bodies it meets the push of that motion, and it takes none back. The
 * pose stored for frame n is the state at time n / 60 s. With
 * `style.prewarm` the world first runs for that many seconds before frame 0;
 * bodies with a negative release join it then, and contacts from before the
 * shot are not recorded.
 */
export async function simulateRigid(defs: readonly RigidBodyDef[], style: PhysicsSpec, frames: number): Promise<RigidResult> {
  const n = defs.length;
  const poses = new Float32Array(frames * n * BODY_STRIDE);
  const events: ContactEvent[] = [];
  if (n === 0) return { poses, events };

  const R = await loadRapier();
  const world = new R.World({ x: 0, y: style.gravity });
  world.timestep = SIM_DT;
  world.lengthUnit = UNITS_PER_METER;
  world.integrationParameters.contact_natural_frequency = CONTACT_FREQUENCY;
  world.numSolverIterations = SOLVER_ITERATIONS;
  const queue = new R.EventQueue(true);

  const bodies: (RAPIER.RigidBody | null)[] = new Array<RAPIER.RigidBody | null>(n).fill(null);
  const idOfCollider = new Map<number, string>();

  const prewarmSteps = Math.round(Math.max(0, style.prewarm) * FPS * SUBSTEPS);
  const kinematic: number[] = [];
  /** How far the outline of a kinematic body reaches from its origin, in units. */
  const reach: number[] = [];
  const create = (i: number): void => {
    const def = defs[i]!;
    const spec = def.body;
    const desc = spec.kind === 'fixed' ? R.RigidBodyDesc.fixed() : spec.kind === 'kinematic' ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.dynamic();
    if (spec.kind === 'kinematic') {
      // Where its keys put it when the world starts: at the start of the prewarm, or of the shot.
      const at = trackOf(def)(-prewarmSteps * SIM_DT);
      desc.setTranslation(at.x, at.y).setRotation(at.rot).setCcdEnabled(true).setCanSleep(false);
      kinematic.push(i);
      reach[i] = outline(scaleShape(def.shape, def.scale), 48).reduce((r, p) => Math.max(r, Math.hypot(p[0], p[1])), 0);
    } else desc.setTranslation(def.x, def.y).setRotation(def.rot);
    if (spec.kind === 'dynamic') {
      const v = spec.velocity ?? [0, 0];
      desc
        .setLinvel(v[0], v[1])
        .setAngvel((spec.spin ?? 0) * DEG)
        .setLinearDamping(style.linearDamping)
        .setAngularDamping(style.angularDamping)
        .setCcdEnabled(true);
    }
    const body = world.createRigidBody(desc);
    const collider = colliderFor(R, scaleShape(def.shape, def.scale), def.id)
      .setDensity(BASE_DENSITY * (spec.kind === 'dynamic' ? spec.density ?? 1 : 1))
      .setFriction(spec.friction ?? style.friction)
      .setRestitution(spec.restitution ?? style.restitution)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
    const handle = world.createCollider(collider, body).handle;
    idOfCollider.set(handle, def.id);
    bodies[i] = body;
  };

  // Fixed and kinematic bodies exist from the start; dynamic ones join at their
  // release, in a fixed order (release time, then scene order).
  const waiting: number[] = [];
  defs.forEach((def, i) => {
    if (def.body.kind !== 'dynamic') create(i);
    else waiting.push(i);
  });
  const releaseOf = (i: number): number => {
    const b = defs[i]!.body;
    return b.kind === 'dynamic' ? b.release : 0;
  };
  waiting.sort((a, b) => releaseOf(a) - releaseOf(b) || a - b);
  let next = 0;

  interface Pending {
    h1: number;
    h2: number;
    age: number;
    peak: number;
    x: number;
    y: number;
    step: number;
  }
  const pending: Pending[] = [];
  const flush = (p: Pending): void => {
    const impulse = p.peak / UNITS_PER_METER;
    if (impulse < MIN_RECORDED_IMPULSE || p.step < 0) return;
    const a = idOfCollider.get(p.h1);
    const b = idOfCollider.get(p.h2);
    if (a === undefined || b === undefined) return;
    events.push({
      frame: Math.min(frames - 1, Math.floor(p.step / SUBSTEPS)),
      time: Math.fround((p.step + 1) * SIM_DT),
      a,
      b,
      x: Math.fround(p.x),
      y: Math.fround(p.y),
      impulse: Math.fround(impulse),
    });
  };

  /** One simulation step; `step` counts from the start of the shot and is negative during the prewarm. */
  const advance = (step: number): void => {
    const time = step * SIM_DT;
    while (next < waiting.length && releaseOf(waiting[next]!) <= time + 1e-9) {
      create(waiting[next]!);
      next++;
    }
    // Each kinematic body goes, over this step, to where its keys put it at the end of the step. What it can reach
    // on the way is woken first: a body asleep in a pile would answer its push a step late, after it has sunk in.
    for (const i of kinematic) {
      const to = trackOf(defs[i]!)(time + SIM_DT);
      const body = bodies[i]!;
      const from = body.translation();
      let turn = Math.abs(to.rot - body.rotation());
      if (turn > Math.PI) turn = 2 * Math.PI - (turn % (2 * Math.PI));
      const sweep = Math.hypot(to.x - from.x, to.y - from.y) + turn * reach[i]!;
      if (sweep > 0) {
        const half = reach[i]! + sweep + WAKE_MARGIN;
        // The query holds the world while it runs: what it finds is woken after it.
        const found: number[] = [];
        world.collidersWithAabbIntersectingAabb({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, { x: half, y: half }, (collider) => {
          found.push(collider.handle);
          return true;
        });
        for (const handle of found) {
          const other = world.getCollider(handle)?.parent();
          if (other && other.isDynamic() && other.isSleeping()) other.wakeUp();
        }
      }
      body.setNextKinematicTranslation({ x: to.x, y: to.y });
      body.setNextKinematicRotation(to.rot);
    }
    world.step(queue);
    queue.drainCollisionEvents((h1, h2, started) => {
      if (started) pending.push({ h1, h2, age: 0, peak: 0, x: 0, y: 0, step });
    });
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i]!;
      const c1 = world.getCollider(p.h1);
      const c2 = world.getCollider(p.h2);
      if (c1 && c2) {
        world.contactPair(c1, c2, (manifold) => {
          let sum = 0;
          for (let j = 0; j < manifold.numContacts(); j++) sum += manifold.contactImpulse(j);
          if (sum > p.peak) {
            p.peak = sum;
            p.step = step;
            const pt = manifold.numSolverContacts() > 0 ? manifold.solverContactPoint(0) : null;
            if (pt) {
              p.x = pt.x;
              p.y = pt.y;
            } else {
              const t1 = c1.translation();
              const t2 = c2.translation();
              p.x = (t1.x + t2.x) / 2;
              p.y = (t1.y + t2.y) / 2;
            }
          }
        });
      }
      p.age++;
      if (p.age >= IMPACT_WINDOW) {
        flush(p);
        pending.splice(i, 1);
      }
    }
  };

  for (let s = -prewarmSteps; s < 0; s++) advance(s);

  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < n; i++) {
      const body = bodies[i];
      const o = (f * n + i) * BODY_STRIDE;
      if (body) {
        const t = body.translation();
        poses[o] = t.x;
        poses[o + 1] = t.y;
        poses[o + 2] = body.rotation();
      } else {
        const def = defs[i]!;
        poses[o] = def.x;
        poses[o + 1] = def.y;
        poses[o + 2] = def.rot;
      }
    }
    for (let k = 0; k < SUBSTEPS; k++) advance(f * SUBSTEPS + k);
  }
  for (const p of pending) flush(p);
  // Order the record by time, then by ids, so that it does not depend on solver internals.
  events.sort((a, b) => a.time - b.time || (a.a < b.a ? -1 : a.a > b.a ? 1 : 0) || (a.b < b.b ? -1 : a.b > b.b ? 1 : 0));
  queue.free();
  world.free();
  return { poses, events };
}
