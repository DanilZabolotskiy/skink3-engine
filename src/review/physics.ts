// The physics review: is the simulation of a shot sound? It reads the bake
// (the pose of every rigid body at every frame, the springs, the particles) and
// the shapes of the scene, draws nothing, and returns findings in the form of
// the motion review:
//
//   overlap        two bodies sunk into each other deeper than a contact gives
//   tunnelling     a body that passed through a fixed body, or through a gap narrower than itself
//   escape         a body below every fixed body, still falling at the end
//   jitter         a body of a pile at rest that keeps swinging back and forth
//   unsettled      a pile that still travels at the end, long after the last body landed
//   energy-spike   speed that neither gravity nor anything in touch can have given
//   unseen-hit     a seen body knocked aside by a body that is not drawn
//   not-finite     a position that is not a number
//
// The geometry is worked out here (collide.ts) and not asked from the physics
// library, so the review does not share the solver's mistakes. Every threshold
// is in physics-thresholds.ts.
//
// When the physics of the engine changes (a new kind of body, a solver, a
// constraint, a setting), this file and test/physics-review.test.ts change in
// the same piece of work: see docs/PRINCIPLES.md.

import { cameraAt, layerView } from '../camera/camera.ts';
import { FPS, SUBSTEPS } from '../core/time.ts';
import { sampleOpacity, sampleScale } from '../motion/tracks.ts';
import { BODY_STRIDE, type Bake } from '../physics/cache.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { awaitsRelease, HIDDEN } from '../scene/evaluate.ts';
import { PHYSICS_FINDING_KINDS, STAGE_H, STAGE_W, type IntendedSpec, type PhysicsFindingKind } from '../scene/types.ts';
import { colliderOf, depthOfPoint, pathInside, placeCore, segmentsCross, separation, type Collider, type Nearest } from './collide.ts';
import { P, PHYSICS_THRESHOLDS } from './physics-thresholds.ts';

export interface PhysicsFinding {
  readonly kind: PhysicsFindingKind;
  /** A rigid body; for `not-finite` also a spring-driven node or an emitter. */
  readonly subject: string;
  /** The other body of a pair (what it is sunk into, what it went through), or null. */
  readonly other: string | null;
  /** More bodies the finding speaks for: the others of a pile that does not settle. */
  readonly group: readonly string[];
  /** First and last frame of the finding. */
  readonly from: number;
  readonly to: number;
  /** What was measured, and the threshold it is held against, both in `unit`. */
  readonly value: number;
  readonly threshold: number;
  readonly unit: string;
  /** How far past the threshold it is; findings are sorted by it. */
  readonly severity: number;
  /** One line: the measurement in words. */
  readonly detail: string;
  /** One line: what usually fixes it. */
  readonly fix: string;
  /** The frame at which it is worst and the place, in units of the bodies' layer: for the pictures. */
  readonly worst: number;
  readonly at: readonly [number, number];
}

/** What each kind of finding means and what usually fixes it. */
export const PHYSICS_KINDS: Readonly<Record<PhysicsFindingKind, { readonly means: string; readonly fix: string }>> = {
  overlap: {
    means: 'two bodies sunk into each other deeper than a soft contact gives, for long enough to be seen',
    fix: 'if it starts at a release, the body is released inside another one or inside a wall: move its start. In a pile the load presses bodies together: pour slower or less, use fewer and larger bodies, or a wider container',
  },
  tunnelling: {
    means: 'a body that passed through a fixed body, or through a gap between two fixed bodies that is narrower than itself',
    fix: 'make the wall thicker, close the gap between the walls (let them overlap), or lower the load that pressed the body through: a slower or thinner pour, a lower release velocity',
  },
  escape: {
    means: 'a body below every fixed body and still falling when the shot ends: nothing is left for it to land on',
    fix: 'widen the ground or add a wall where the body left; if it is meant to fall out of the picture, mark it as intended',
  },
  jitter: {
    means: 'a body of a pile at rest that keeps swinging back and forth by a visible amount',
    fix: 'raise physics.friction or physics.angularDamping, or lower restitution; a tall narrow stack of small bodies trembles more than a wide one of larger bodies',
  },
  unsettled: {
    means: 'a pile that still travels at the end of the shot, long after the last body landed on it',
    fix: 'end the pour earlier or make the shot longer; raise physics.linearDamping, physics.angularDamping or physics.friction so that sliding and rolling die out',
  },
  'energy-spike': {
    means: 'a body that gains speed which neither gravity nor anything touching it can have given',
    fix: 'look just before the spike for bodies released inside each other or pressed into a wall: the solver throws them apart. Release them apart, slow the pour, or thicken what they are pressed against',
  },
  'unseen-hit': {
    means: 'a seen body whose path is bent by a body that is not drawn: it bounces off nothing',
    fix: 'a body collides from its release on, whether it is drawn or not. Release it when it appears, keep bodies that are faded out or have no size yet out of the way of the seen ones, or fade it out only where nothing can meet it',
  },
  'not-finite': {
    means: 'a baked position that is not a number: the simulation broke down',
    fix: 'look for extreme values in the scene: a huge velocity or spin, a body far smaller or larger than the others, a spring with a very high frequency',
  },
};

export interface HonouredPhysicsException {
  readonly nodes: readonly string[];
  readonly kind: PhysicsFindingKind;
  readonly reason: string;
  /** The findings it covers; they are not warnings. */
  readonly findings: readonly PhysicsFinding[];
}

export interface PhysicsReport {
  readonly version: 1;
  readonly shot: string;
  readonly frames: number;
  readonly fps: number;
  readonly seconds: number;
  /** What was looked at. */
  readonly counts: {
    readonly bodies: number;
    readonly dynamic: number;
    readonly fixed: number;
    readonly springs: number;
    readonly emitters: number;
    /** Pairs of bodies whose distance was worked out, summed over all frames. */
    readonly pairs: number;
  };
  /** Numbers of the simulation as a whole, findings or not. */
  readonly world: {
    readonly gravity: number;
    /** The deepest two seen bodies are in each other at any frame, in px; null without a touching pair. */
    readonly deepest: { readonly px: number; readonly a: string; readonly b: string; readonly frame: number } | null;
    /** The fastest a seen body travels, in px per frame. */
    readonly fastest: { readonly px: number; readonly body: string; readonly frame: number } | null;
    /** The frame from which no body travels any more, to the end; null when something still travels at the end. */
    readonly restFrom: number | null;
    /** Bodies that still travel at the last frame, seen or not, and the fastest of them. */
    readonly movingAtEnd: number;
    readonly fastestAtEnd: { readonly px: number; readonly body: string; readonly seen: boolean } | null;
  };
  /** The warnings, worst first. */
  readonly findings: readonly PhysicsFinding[];
  /** Number of warnings by kind (kinds without any are left out). */
  readonly byKind: Readonly<Partial<Record<PhysicsFindingKind, number>>>;
  /** Exceptions marked with intended() that covered at least one finding. */
  readonly honoured: readonly HonouredPhysicsException[];
  /** Exceptions that covered nothing. */
  readonly unused: readonly IntendedSpec[];
  /** What each kind means and what usually fixes it. */
  readonly kinds: typeof PHYSICS_KINDS;
  readonly thresholds: typeof PHYSICS_THRESHOLDS;
}

const round = (v: number, digits = 3): number => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

interface Body {
  readonly id: string;
  readonly slot: number;
  readonly dynamic: boolean;
  readonly col: Collider;
  /** The first frame at which the solver owns it (0 for a fixed body). */
  readonly first: number;
  /** A turn of it shows: it is not a plain disc. */
  readonly turns: boolean;
}

interface PairRun {
  readonly i: number;
  readonly j: number;
  from: number;
  to: number;
  frames: number;
  run: number;
  longest: number;
  deepRun: number;
  deepest: number;
  last: number;
  maxDepth: number;
  maxAt: number;
  x: number;
  y: number;
}

/** Union-find over body slots, reset for every use. */
class Sets {
  private readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
  }
  reset(): void {
    for (let i = 0; i < this.parent.length; i++) this.parent[i] = i;
  }
  find(i: number): number {
    let r = i;
    while (this.parent[r] !== r) r = this.parent[r]!;
    while (this.parent[i] !== r) {
      const next = this.parent[i]!;
      this.parent[i] = r;
      i = next;
    }
    return r;
  }
  join(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra < rb ? rb : ra] = ra < rb ? ra : rb;
  }
}

function covers(x: IntendedSpec, f: PhysicsFinding): boolean {
  if (x.kind !== f.kind) return false;
  if (!x.nodes.includes(f.subject) && !(f.other !== null && x.nodes.includes(f.other))) return false;
  if (x.from !== null && f.to / FPS < x.from) return false;
  if (x.to !== null && f.from / FPS > x.to) return false;
  return true;
}

/** Reviews the physics of a baked shot. Synchronous, draws nothing. */
export function reviewPhysics(c: CompiledShot, bake: Bake): PhysicsReport {
  if (bake.header.sceneHash !== c.sceneHash || bake.header.frames !== c.frames) {
    throw new Error('the bake does not belong to this shot (scene hash or length differs); bake again');
  }
  const F = c.frames;
  const N = c.bodies.length;
  const out: PhysicsFinding[] = [];
  const make = (
    kind: PhysicsFindingKind,
    subject: string,
    other: string | null,
    from: number,
    to: number,
    value: number,
    threshold: number,
    unit: string,
    detail: string,
    worst: number,
    at: readonly [number, number],
    group: readonly string[] = [],
    severity = threshold > 0 ? value / threshold : value,
  ): void => {
    out.push({ kind, subject, other, group, from, to, value: round(value), threshold, unit, severity: round(severity), detail, fix: PHYSICS_KINDS[kind].fix, worst, at: [round(at[0], 1), round(at[1], 1)] });
  };

  // --- Broken numbers: looked for first, in everything the bake holds ---------------
  const broken = new Set<number>();
  {
    const B = bake.bodies;
    for (let i = 0; i < N; i++) {
      for (let f = 0; f < F; f++) {
        const o = (f * N + i) * BODY_STRIDE;
        if (Number.isFinite(B[o]!) && Number.isFinite(B[o + 1]!) && Number.isFinite(B[o + 2]!)) continue;
        broken.add(i);
        const id = bake.header.bodies[i]!;
        make('not-finite', id, null, f, F - 1, 1, 0, 'broken frames', `rigid body: its pose is not a number from frame ${f} on`, f, [0, 0], [], 1e6);
        break;
      }
    }
    const S = bake.header.springs.length;
    for (let s = 0; s < S; s++) {
      for (let f = 0; f < F; f++) {
        if (Number.isFinite(bake.springX(s, f)) && Number.isFinite(bake.springY(s, f))) continue;
        make('not-finite', bake.header.springs[s]!, null, f, F - 1, 1, 0, 'broken frames', `spring: its position is not a number from frame ${f} on`, f, [0, 0], [], 1e6);
        break;
      }
    }
    bake.header.emitters.forEach((id, e) => {
      for (let f = 0; f < F; f++) {
        const data = bake.particlesAt(e, f);
        let bad = false;
        for (let k = 0; k < data.length && !bad; k++) bad = !Number.isFinite(data[k]!);
        if (!bad) continue;
        make('not-finite', id, null, f, F - 1, 1, 0, 'broken frames', `particles: a particle of this emitter has a position or a size that is not a number at frame ${f}`, f, [0, 0], [], 1e6);
        return;
      }
      // An emitter with streaks: the tail of every particle is baked with it.
      for (let f = 0; f < F; f++) {
        const tails = bake.tailsAt(e, f);
        if (!tails) return;
        let bad = false;
        for (let k = 0; k < tails.length && !bad; k++) bad = !Number.isFinite(tails[k]!);
        if (!bad) continue;
        make('not-finite', id, null, f, F - 1, 1, 0, 'broken frames', `particles: the streak of a particle of this emitter is not a number at frame ${f}`, f, [0, 0], [], 1e6);
        return;
      }
    });
  }

  // --- The bodies ------------------------------------------------------------------
  const bodies: Body[] = c.bodies.map((index, slot) => {
    const n = c.nodes[index]!;
    const node = n.node;
    if (node.type !== 'shape' || !node.body) throw new Error(`"${n.id}" is not a rigid body`);
    const dynamic = node.body.kind === 'dynamic';
    // The solver creates the body at the first step at or after its release;
    // the pose of a frame is stored before that frame's steps are taken.
    const step = node.body.kind === 'dynamic' ? Math.ceil(node.body.release * FPS * SUBSTEPS - 1e-6) : 0;
    const first = dynamic ? Math.max(0, Math.floor(step / SUBSTEPS) + 1) : 0;
    return { id: n.id, slot, dynamic, col: colliderOf(node.shape, node.scale), first: Math.min(first, F), turns: node.shape.kind !== 'circle' || node.children.length > 0 };
  });
  const dyn = bodies.filter((b) => b.dynamic && !broken.has(b.slot));
  const fixed = bodies.filter((b) => !b.dynamic && !broken.has(b.slot));
  const K = fixed.length;
  const gravity = c.spec.physics.gravity;

  const counts = { bodies: N, dynamic: bodies.filter((b) => b.dynamic).length, fixed: bodies.filter((b) => !b.dynamic).length, springs: c.springs.length, emitters: c.emitters.length, pairs: 0 };
  const finish = (world: PhysicsReport['world']): PhysicsReport => {
    out.sort((a, b) => b.severity - a.severity || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0) || a.from - b.from || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    // Exceptions to the motion review are honoured, and counted as unused, by that review.
    const intended = (c.spec.intended ?? []).filter((x) => (PHYSICS_FINDING_KINDS as readonly string[]).includes(x.kind));
    const taken: PhysicsFinding[][] = intended.map(() => []);
    const findings: PhysicsFinding[] = [];
    for (const f of out) {
      const i = intended.findIndex((x) => covers(x, f));
      if (i >= 0) taken[i]!.push(f);
      else findings.push(f);
    }
    const honoured: HonouredPhysicsException[] = [];
    const unused: IntendedSpec[] = [];
    intended.forEach((x, i) => {
      if (taken[i]!.length > 0) honoured.push({ nodes: x.nodes, kind: x.kind as PhysicsFindingKind, reason: x.reason, findings: taken[i]! });
      else unused.push(x);
    });
    const byKind: Partial<Record<PhysicsFindingKind, number>> = {};
    for (const kind of PHYSICS_FINDING_KINDS) {
      const n = findings.filter((f) => f.kind === kind).length;
      if (n > 0) byKind[kind] = n;
    }
    return { version: 1, shot: c.spec.id, frames: F, fps: FPS, seconds: round(F / FPS), counts, world, findings, byKind, honoured, unused, kinds: PHYSICS_KINDS, thresholds: PHYSICS_THRESHOLDS };
  };
  if (dyn.length === 0) return finish({ gravity, deepest: null, fastest: null, restFrom: 0, movingAtEnd: 0, fastestAtEnd: null });

  // --- The view of the bodies' layer, and what is seen -----------------------------------
  const layer = c.layers[c.nodes[c.bodies[0]!]!.layer]!;
  const zoom = new Float64Array(F);
  const tx = new Float64Array(F);
  const ty = new Float64Array(F);
  for (let f = 0; f < F; f++) {
    const v = layerView(cameraAt(c.spec.camera, c.cameraNoise, f, F, c.cameraTrack), layer.parallax);
    zoom[f] = v.zoom;
    tx[f] = v.tx;
    ty[f] = v.ty;
  }
  const B = bake.bodies;
  const X = (f: number, i: number): number => B[(f * N + i) * BODY_STRIDE]!;
  const Y = (f: number, i: number): number => B[(f * N + i) * BODY_STRIDE + 1]!;
  const R = (f: number, i: number): number => B[(f * N + i) * BODY_STRIDE + 2]!;
  /** The turn of a body from frame f - 1 to f. The solver keeps its angle within one turn, so the step is taken the short way round. */
  const turned = (f: number, i: number): number => {
    let d = R(f, i) - R(f - 1, i);
    if (d > Math.PI) d -= 2 * Math.PI;
    else if (d < -Math.PI) d += 2 * Math.PI;
    return d;
  };
  /** A body is drawn clearly enough (`drawn`), and also reaches into the frame (`seen`). */
  const drawn = new Uint8Array(F * N);
  const seen = new Uint8Array(F * N);
  for (const b of bodies) {
    const n = c.nodes[c.bodies[b.slot]!]!;
    const node = n.node;
    const authored = node.type === 'shape' ? node.scale : 1;
    for (let f = 0; f < F; f++) {
      const t = f / FPS;
      const alpha = n.opacity ? sampleOpacity(n.opacity, t) : 1;
      const k = n.scale ? sampleScale(n.scale, t) : 1;
      // A body that appears at its release is not drawn while it waits for it.
      if (alpha < P.seenAlpha || authored * k <= HIDDEN || awaitsRelease(n, t)) continue;
      drawn[f * N + b.slot] = 1;
      const z = zoom[f]!;
      const sx = X(f, b.slot) * z + tx[f]!;
      const sy = Y(f, b.slot) * z + ty[f]!;
      const r = b.col.bound * k * z;
      if (sx + r >= 0 && sy + r >= 0 && sx - r <= STAGE_W && sy - r <= STAGE_H) seen[f * N + b.slot] = 1;
    }
  }

  // The reference point of a body: a point inside its shape.
  const cx = new Float64Array(N);
  const cy = new Float64Array(N);
  const centre = (f: number, i: number): void => {
    const col = bodies[i]!.col;
    const x = X(f, i);
    const y = Y(f, i);
    if (col.center[0] === 0 && col.center[1] === 0) {
      cx[i] = x;
      cy[i] = y;
      return;
    }
    const rot = R(f, i);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    cx[i] = x + col.center[0] * cos - col.center[1] * sin;
    cy[i] = y + col.center[0] * sin + col.center[1] * cos;
  };

  // --- Rest and motion: the travel of a body over half a second, in px per frame -------
  const half = Math.round(P.restFrames / 2);
  const netSpeed = (f: number, i: number): number => {
    const a = Math.max(0, f - half);
    const b = Math.min(F - 1, f + half);
    if (b <= a) return 0;
    return (Math.hypot(X(b, i) - X(a, i), Y(b, i) - Y(a, i)) * zoom[f]!) / (b - a);
  };
  const moving = new Uint8Array(F * N);
  for (const b of dyn) for (let f = b.first; f < F; f++) if (netSpeed(f, b.slot) > P.restPx) moving[f * N + b.slot] = 1;

  // --- Fixed bodies never move: placed once ------------------------------------------------
  const cores: Float64Array[] = bodies.map((b) => new Float64Array(Math.max(2, b.col.n * 2)));
  const boxes = fixed.map((b) => {
    placeCore(b.col, X(0, b.slot), Y(0, b.slot), R(0, b.slot), cores[b.slot]!);
    const p = cores[b.slot]!;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < b.col.n; k++) {
      x0 = Math.min(x0, p[k * 2]!);
      x1 = Math.max(x1, p[k * 2]!);
      y0 = Math.min(y0, p[k * 2 + 1]!);
      y1 = Math.max(y1, p[k * 2 + 1]!);
    }
    const r = b.col.radius;
    return { x0: x0 - r, x1: x1 + r, y0: y0 - r, y1: y1 + r };
  });
  // Gaps between fixed bodies that a body cannot pass: narrower than the widest disc inside any dynamic body.
  const widest = dyn.reduce((a, b) => Math.max(a, 2 * b.col.inner), 0);
  const gaps: { ax: number; ay: number; bx: number; by: number; gap: number; k: number; l: number }[] = [];
  {
    const near: Nearest = { ax: 0, ay: 0, bx: 0, by: 0 };
    for (let k = 0; k < K; k++) {
      for (let l = k + 1; l < K; l++) {
        const a = fixed[k]!;
        const b = fixed[l]!;
        const gap = separation(cores[a.slot]!, a.col.n, a.col.radius, cores[b.slot]!, b.col.n, b.col.radius, near);
        if (gap > 0 && gap < widest) gaps.push({ ax: near.ax, ay: near.ay, bx: near.bx, by: near.by, gap, k, l });
      }
    }
  }

  // --- Per-frame state ------------------------------------------------------------------------
  /** Travel of the body and of its edge (by turning) in the last frame, in units. */
  const stepLin = new Float32Array(F * N);
  const stepSpin = new Float32Array(F * N);
  for (const b of dyn) {
    for (let f = Math.max(1, b.first); f < F; f++) {
      stepLin[f * N + b.slot] = Math.hypot(X(f, b.slot) - X(f - 1, b.slot), Y(f, b.slot) - Y(f - 1, b.slot));
      stepSpin[f * N + b.slot] = Math.abs(turned(f, b.slot)) * b.col.bound;
    }
  }
  /** The body does not travel at this frame, and neither does anything near it. */
  const calm = new Uint8Array(F * N);
  /** Slots of the bodies that travel at this frame. */
  const travelling: number[] = [];
  /** The frame after the last one at which the body lay on a fixed body or in a pile that stands on one; 0 if it never did. */
  const grounded = new Int32Array(N);
  /** The frame at which it came to lie there, this time; -1 if it never did. */
  const groundedSince = new Int32Array(N).fill(-1);
  const pairs = new Map<number, PairRun>();
  const islands = new Sets(N);
  const groups = new Sets(N);
  const standing = new Uint8Array(N);
  const supported = new Uint8Array(N);
  /** Pairs of bodies near enough to have touched within a frame, for the last three frames. */
  const nearPairs: [number[], number[], number[]] = [[], [], []];
  // Tunnelling: per dynamic body and fixed body, whether its centre is inside, and the last frame it was outside before it went in.
  const insideFixed = new Uint8Array(N * Math.max(1, K));
  const enteredFrom = new Int32Array(N * Math.max(1, K)).fill(-1);
  const prevCx = new Float64Array(N);
  const prevCy = new Float64Array(N);
  const spikes: { i: number; f: number; gain: number; from: number; to: number; spin: boolean; fastest: number; own: number }[] = [];
  // What a body can have touched at this frame and at the one before: something solid to the
  // eye (a fixed body, or a dynamic one that is seen), and a dynamic body that is not drawn.
  const solidNow = new Uint8Array(N);
  const solidBefore = new Uint8Array(N);
  const ghostNow = new Int32Array(N).fill(-1);
  const ghostBefore = new Int32Array(N).fill(-1);
  const hits: { i: number; j: number; f: number; change: number }[] = [];
  const tunnels: { i: number; k: number; l: number; a: number; b: number; inside: number; gap: number; x: number; y: number }[] = [];
  let deepest: { px: number; a: number; b: number; frame: number } | null = null;
  let fastest: { px: number; body: number; frame: number } | null = null;
  const order: number[] = dyn.map((b) => b.slot);
  const minX = new Float64Array(N);
  const reach = new Float64Array(N);
  const gFrame = Math.abs(gravity) / (FPS * FPS);
  const top1 = new Float64Array(N);
  const top2 = new Float64Array(N);
  const topOwner = new Int32Array(N);
  let lastIslands: Int32Array | null = null;
  let lastSupported: Uint8Array | null = null;

  const touch = (f: number, i: number, j: number, jFixed: boolean, sep: number): void => {
    counts.pairs++;
    if (sep <= P.touchUnits) {
      if (jFixed) supported[i] = 1;
      else islands.join(i, j);
    }
    if (sep <= P.touchUnits + stepLin[f * N + i]! + (jFixed ? 0 : stepLin[f * N + j]!)) {
      if (jFixed) solidNow[i] = 1;
      else {
        nearPairs[0].push(i, j);
        // A body outside the frame is still a thing: what counts here is whether it is drawn at all.
        if (drawn[f * N + j]) solidNow[i] = 1;
        else ghostNow[i] = j;
        if (drawn[f * N + i]) solidNow[j] = 1;
        else ghostNow[j] = i;
      }
    }
    if (sep >= 0) return;
    if (!seen[f * N + i] || (!jFixed && !seen[f * N + j])) return;
    const depth = -sep * zoom[f]!;
    if (!deepest || depth > deepest.px) deepest = { px: depth, a: i, b: j, frame: f };
    if (depth < P.overlapPx) return;
    const key = i * N + j;
    let p = pairs.get(key);
    if (!p) {
      p = { i, j, from: f, to: f, frames: 0, run: 0, longest: 0, deepRun: 0, deepest: 0, last: -2, maxDepth: 0, maxAt: f, x: 0, y: 0 };
      pairs.set(key, p);
    }
    const small = Math.min(bodies[i]!.col.inner, bodies[j]!.col.inner) * zoom[f]!;
    const deep = depth >= Math.max(P.overlapDeepPx, P.overlapDeepShare * small);
    const follows = p.last === f - 1;
    p.run = follows ? p.run + 1 : 1;
    p.deepRun = deep ? (follows ? p.deepRun + 1 : 1) : 0;
    p.longest = Math.max(p.longest, p.run);
    p.deepest = Math.max(p.deepest, p.deepRun);
    p.frames++;
    p.last = f;
    p.to = f;
    if (depth > p.maxDepth) {
      p.maxDepth = depth;
      p.maxAt = f;
      p.x = (cx[i]! + (jFixed ? cx[i]! : cx[j]!)) / 2;
      p.y = (cy[i]! + (jFixed ? cy[i]! : cy[j]!)) / 2;
    }
  };

  for (let f = 0; f < F; f++) {
    const z = zoom[f]!;
    // Bodies the solver owns at this frame, at their poses.
    let active = 0;
    for (const b of dyn) {
      const i = b.slot;
      if (f < b.first) continue;
      active++;
      placeCore(b.col, X(f, i), Y(f, i), R(f, i), cores[i]!);
      prevCx[i] = cx[i]!;
      prevCy[i] = cy[i]!;
      centre(f, i);
      if (f === b.first) {
        // Where it stood before the solver took it.
        const keepX = cx[i]!;
        const keepY = cy[i]!;
        if (f > 0) {
          centre(f - 1, i);
          prevCx[i] = cx[i]!;
          prevCy[i] = cy[i]!;
        } else {
          prevCx[i] = keepX;
          prevCy[i] = keepY;
        }
        cx[i] = keepX;
        cy[i] = keepY;
      }
      reach[i] = b.col.bound + P.touchUnits / 2 + stepLin[f * N + i]!;
      minX[i] = X(f, i) - reach[i]!;
      if (seen[f * N + i]) {
        const px = stepLin[f * N + i]! * z;
        if (!fastest || px > fastest.px) fastest = { px, body: i, frame: f };
      }
    }
    nearPairs.unshift(nearPairs.pop()!);
    nearPairs[0].length = 0;
    if (active === 0) continue;
    islands.reset();
    supported.fill(0);
    solidBefore.set(solidNow);
    ghostBefore.set(ghostNow);
    solidNow.fill(0);
    ghostNow.fill(-1);

    // Dynamic against fixed.
    for (const b of dyn) {
      const i = b.slot;
      if (f < b.first) continue;
      const x = X(f, i);
      const y = Y(f, i);
      const r = reach[i]! + P.touchUnits;
      const travel = Math.hypot(cx[i]! - prevCx[i]!, cy[i]! - prevCy[i]!);
      for (let k = 0; k < K; k++) {
        const box = boxes[k]!;
        const fb = fixed[k]!;
        const state = i * K + k;
        const nearBox = x + r >= box.x0 && x - r <= box.x1 && y + r >= box.y0 && y - r <= box.y1;
        if (nearBox) touch(f, i, fb.slot, true, separation(cores[i]!, b.col.n, b.col.radius, cores[fb.slot]!, fb.col.n, fb.col.radius));

        // Tunnelling: the centre of the body against the fixed body.
        const reachable = cx[i]! + travel >= box.x0 && cx[i]! - travel <= box.x1 && cy[i]! + travel >= box.y0 && cy[i]! - travel <= box.y1;
        if (!reachable) {
          if (insideFixed[state]) {
            // It is clear of the fixed body again without having been near: handled as an exit.
            exit(f, i, k);
          }
          continue;
        }
        const depth = depthOfPoint(cx[i]!, cy[i]!, cores[fb.slot]!, fb.col.n, fb.col.radius);
        if (depth > 0) {
          if (!insideFixed[state]) {
            insideFixed[state] = 1;
            enteredFrom[state] = f > b.first ? f - 1 : -1;
          }
        } else if (insideFixed[state]) {
          exit(f, i, k);
        } else if (f > b.first && -depth <= travel) {
          // Outside before and after: did it pass through between the two frames?
          const inside = pathInside(prevCx[i]!, prevCy[i]!, cx[i]!, cy[i]!, cores[fb.slot]!, fb.col.n, fb.col.radius, 1);
          if (inside * z >= P.tunnelPx) tunnels.push({ i, k, l: -1, a: f - 1, b: f, inside, gap: 0, x: (prevCx[i]! + cx[i]!) / 2, y: (prevCy[i]! + cy[i]!) / 2 });
        }
      }
      // A gap between two fixed bodies that is narrower than the body.
      if (f > b.first) {
        for (const g of gaps) {
          if (2 * b.col.inner - g.gap < (2 * P.overlapPx) / z) continue;
          if (!segmentsCross(prevCx[i]!, prevCy[i]!, cx[i]!, cy[i]!, g.ax, g.ay, g.bx, g.by)) continue;
          tunnels.push({ i, k: g.k, l: g.l, a: f - 1, b: f, inside: 0, gap: g.gap, x: (g.ax + g.bx) / 2, y: (g.ay + g.by) / 2 });
        }
      }
    }

    // Dynamic against dynamic: sweep along x. The order changes little from frame to frame.
    for (let a = 1; a < order.length; a++) {
      const v = order[a]!;
      const key = bodies[v]!.first <= f ? minX[v]! : Infinity;
      let b = a - 1;
      while (b >= 0) {
        const w = order[b]!;
        const kw = bodies[w]!.first <= f ? minX[w]! : Infinity;
        if (kw <= key) break;
        order[b + 1] = w;
        b--;
      }
      order[b + 1] = v;
    }
    for (let a = 0; a < order.length; a++) {
      const i = order[a]!;
      const bi = bodies[i]!;
      if (bi.first > f) break;
      const xi = X(f, i);
      const yi = Y(f, i);
      const maxX = xi + reach[i]!;
      for (let b = a + 1; b < order.length; b++) {
        const j = order[b]!;
        const bj = bodies[j]!;
        if (bj.first > f || minX[j]! > maxX) break;
        const rr = reach[i]! + reach[j]!;
        const dy = Y(f, j) - yi;
        if (dy > rr || dy < -rr) continue;
        const dx = X(f, j) - xi;
        if (dx * dx + dy * dy > rr * rr) continue;
        const lo = i < j ? i : j;
        const hi = i < j ? j : i;
        touch(f, lo, hi, false, separation(cores[lo]!, bodies[lo]!.col.n, bodies[lo]!.col.radius, cores[hi]!, bodies[hi]!.col.n, bodies[hi]!.col.radius));
      }
    }

    // A body is calm while neither it nor anything near it travels: a pile takes
    // an impact or a slide by rocking for a moment, and that is not a tremble.
    travelling.length = 0;
    for (const b of dyn) if (f >= b.first && moving[f * N + b.slot]) travelling.push(b.slot);
    for (const b of dyn) {
      const i = b.slot;
      if (f < b.first || moving[f * N + i]) continue;
      const clear = P.jitterClear * b.col.bound;
      const x = X(f, i);
      const y = Y(f, i);
      let near = false;
      for (let m = 0; m < travelling.length && !near; m++) {
        const dx = X(f, travelling[m]!) - x;
        const dy = Y(f, travelling[m]!) - y;
        near = dx * dx + dy * dy < clear * clear;
      }
      if (!near) calm[f * N + i] = 1;
    }
    // Piles: bodies that touch. A pile stands when one of its bodies lies on a fixed body.
    standing.fill(0);
    for (const b of dyn) if (f >= b.first && supported[b.slot]) standing[islands.find(b.slot)] = 1;
    for (const b of dyn) {
      if (f < b.first || !standing[islands.find(b.slot)]) continue;
      // It lay there at the frame before when `grounded` names this frame; frame 0 has no frame before.
      if (f === 0 || grounded[b.slot] !== f) groundedSince[b.slot] = f;
      grounded[b.slot] = f + 1;
    }
    if (f === F - 1) {
      lastIslands = new Int32Array(N).fill(-1);
      lastSupported = new Uint8Array(N);
      for (const b of dyn) {
        if (f < b.first) continue;
        const root = islands.find(b.slot);
        lastIslands[b.slot] = root;
        if (standing[root]) lastSupported[root] = 1;
      }
    }

    // A seen body whose velocity changes within a frame while the only thing it can have touched is
    // a dynamic body that is not drawn: to the eye it bounces off nothing.
    if (f >= 2) {
      for (const b of dyn) {
        const i = b.slot;
        if (f < b.first + 2 || !seen[f * N + i] || !seen[(f - 1) * N + i]) continue;
        const ghost = ghostNow[i]! >= 0 ? ghostNow[i]! : ghostBefore[i]!;
        if (ghost < 0 || solidNow[i] || solidBefore[i]) continue;
        const ax = X(f, i) - 2 * X(f - 1, i) + X(f - 2, i);
        const ay = Y(f, i) - 2 * Y(f - 1, i) + Y(f - 2, i);
        const change = (Math.hypot(ax, ay) - gFrame) * z;
        if (change >= P.hitPx) hits.push({ i, j: ghost, f, change });
      }
    }

    // Energy: the speed of a body against what gravity and the bodies in touch can have given.
    if (f >= 2) {
      groups.reset();
      for (const list of nearPairs) for (let k = 0; k < list.length; k += 2) groups.join(list[k]!, list[k + 1]!);
      top1.fill(0);
      top2.fill(0);
      topOwner.fill(-1);
      const had = (i: number): number => {
        const b = bodies[i]!;
        let s = Math.max(stepLin[(f - 1) * N + i]! + stepSpin[(f - 1) * N + i]!, stepLin[(f - 2) * N + i]! + stepSpin[(f - 2) * N + i]!);
        // A body released a moment ago brings the speed it was released with.
        if (b.first + 1 >= f) s = Math.max(s, stepLin[f * N + i]! + stepSpin[f * N + i]!);
        return s;
      };
      for (const b of dyn) {
        if (f < b.first) continue;
        const i = b.slot;
        const root = groups.find(i);
        const s = had(i);
        if (s > top1[root]!) {
          top2[root] = top1[root]!;
          top1[root] = s;
          topOwner[root] = i;
        } else if (s > top2[root]!) top2[root] = s;
      }
      for (const b of dyn) {
        const i = b.slot;
        // The first frames after a release hold the release itself.
        if (f < b.first + 2 || !seen[f * N + i]) continue;
        const root = groups.find(i);
        const own = had(i);
        const others = topOwner[root] === i ? top2[root]! : top1[root]!;
        const budget = own + 2 * gFrame + P.spikeBounce * others;
        const lin = stepLin[f * N + i]!;
        const spin = stepSpin[f * N + i]!;
        const gain = Math.max(lin, b.turns ? spin : 0) - budget;
        if (gain * z >= P.spikePx) spikes.push({ i, f, gain: gain * z, from: own * z, to: Math.max(lin, b.turns ? spin : 0) * z, spin: b.turns && spin > lin, fastest: others * z, own: own * z });
      }
    }
  }

  function exit(f: number, i: number, k: number): void {
    const state = i * K + k;
    insideFixed[state] = 0;
    const a = enteredFrom[state]!;
    enteredFrom[state] = -1;
    // Released inside the fixed body: it never was outside before, so it did not pass through.
    if (a < 0) return;
    const fb = fixed[k]!;
    const col = bodies[i]!.col;
    let ax = X(a, i);
    let ay = Y(a, i);
    if (col.center[0] !== 0 || col.center[1] !== 0) {
      const rot = R(a, i);
      ax += col.center[0] * Math.cos(rot) - col.center[1] * Math.sin(rot);
      ay += col.center[0] * Math.sin(rot) + col.center[1] * Math.cos(rot);
    }
    const inside = pathInside(ax, ay, cx[i]!, cy[i]!, cores[fb.slot]!, fb.col.n, fb.col.radius, 1);
    if (inside * zoom[f]! >= P.tunnelPx) tunnels.push({ i, k, l: -1, a, b: f, inside, gap: 0, x: (ax + cx[i]!) / 2, y: (ay + cy[i]!) / 2 });
  }

  const id = (i: number): string => bodies[i]!.id;
  const secs = (f: number): string => (f / FPS).toFixed(2);

  // --- Overlap ---------------------------------------------------------------------------
  for (const p of pairs.values()) {
    const long = p.longest >= P.overlapFrames;
    const deep = p.deepest >= 2;
    if (!long && !deep) continue;
    const a = bodies[p.i]!;
    const b = bodies[p.j]!;
    // At a release: the body was put inside the other one. Of two released together, the second is named.
    const released = [b, a].find((x) => x.dynamic && p.from <= x.first + 1);
    const where = released ? `; it starts at the release of "${released.id}" (frame ${released.first}), which was put inside "${released === a ? b.id : a.id}"` : '';
    make(
      'overlap',
      a.id,
      b.id,
      p.from,
      p.to,
      p.maxDepth,
      P.overlapPx,
      'px',
      `sunk ${p.maxDepth.toFixed(1)} px into ${b.dynamic ? '' : 'the fixed body '}"${b.id}" at frame ${p.maxAt}; deeper than ${P.overlapPx} px for ${p.frames} frame(s), ${p.longest} in a row${where}`,
      p.maxAt,
      [p.x, p.y],
    );
  }

  // --- Tunnelling --------------------------------------------------------------------------
  {
    const done = new Set<string>();
    for (const t of tunnels) {
      const key = `${t.i}|${t.k}|${t.l}`;
      if (done.has(key)) continue;
      done.add(key);
      // What passes unseen is not reported.
      if (!seen[t.a * N + t.i] && !seen[t.b * N + t.i]) continue;
      const z = zoom[t.b]!;
      const through = fixed[t.k]!.id;
      if (t.l < 0) {
        const px = t.inside * z;
        make(
          'tunnelling',
          id(t.i),
          through,
          t.a,
          t.b,
          px,
          P.tunnelPx,
          'px',
          `passed through the fixed body "${through}" between frames ${t.a} and ${t.b}: the line from where it was outside to where it is outside again runs ${px.toFixed(1)} px inside it`,
          t.b,
          [t.x, t.y],
        );
      } else {
        const width = 2 * bodies[t.i]!.col.inner * z;
        make(
          'tunnelling',
          id(t.i),
          through,
          t.a,
          t.b,
          width - t.gap * z,
          2 * P.overlapPx,
          'px',
          `passed between the fixed bodies "${through}" and "${fixed[t.l]!.id}" between frames ${t.a} and ${t.b}: the gap there is ${(t.gap * z).toFixed(1)} px wide and the body ${width.toFixed(1)} px`,
          t.b,
          [t.x, t.y],
          [fixed[t.l]!.id],
        );
      }
    }
  }

  // --- Escape --------------------------------------------------------------------------------
  if (gravity !== 0 && K > 0) {
    const down = gravity > 0 ? 1 : -1;
    const floor = boxes.reduce((a, b) => Math.max(a, down > 0 ? b.y1 : -b.y0), -Infinity);
    const last = F - 1;
    for (const b of dyn) {
      const i = b.slot;
      // A body that never lay on anything was not meant to land: a stream that crosses the picture.
      if (b.first >= last || grounded[i] === 0) continue;
      const below = (down * Y(last, i) - floor) * zoom[last]!;
      const speed = stepLin[last * N + i]! * zoom[last]!;
      if (below < P.escapePx || speed <= P.restPx) continue;
      // And one that nobody saw leave is nobody's business.
      let watched = false;
      for (let f = grounded[i]!; f < F && !watched; f++) watched = seen[f * N + i] === 1;
      if (!watched) continue;
      let from = last;
      while (from > b.first && down * Y(from - 1, i) > floor) from--;
      make(
        'escape',
        b.id,
        null,
        from,
        last,
        below,
        P.escapePx,
        'px',
        `${below.toFixed(0)} px below the lowest fixed body at the end of the shot and still falling at ${speed.toFixed(1)} px per frame; it last lay on something at frame ${grounded[i]! - 1} (${secs(grounded[i]! - 1)} s) and passed below everything at frame ${from}`,
        grounded[i]! - 1,
        [X(grounded[i]! - 1, i), Y(grounded[i]! - 1, i)],
      );
    }
  }

  // --- Jitter ----------------------------------------------------------------------------------
  for (const b of dyn) {
    const i = b.slot;
    for (const channel of b.turns ? (['position', 'rotation'] as const) : (['position'] as const)) {
      // The step from frame f - 1 to f, in px: two components for the place, one for the turn.
      const sx = new Float64Array(F);
      const sy = new Float64Array(F);
      // The turn so far, as the travel of the edge in px.
      const edge = new Float64Array(F);
      for (let f = b.first + 1; f < F; f++) {
        if (channel === 'position') {
          sx[f] = (X(f, i) - X(f - 1, i)) * zoom[f]!;
          sy[f] = (Y(f, i) - Y(f - 1, i)) * zoom[f]!;
        } else {
          sx[f] = turned(f, i) * b.col.bound * zoom[f]!;
          edge[f] = edge[f - 1]! + sx[f]!;
        }
      }
      // Turning points: frames at which the motion reverses.
      const turns: number[] = [];
      for (let f = b.first + 1; f + 1 < F; f++) {
        if (Math.hypot(sx[f]!, sy[f]!) < P.jitterStepPx || Math.hypot(sx[f + 1]!, sy[f + 1]!) < P.jitterStepPx) continue;
        if (sx[f]! * sx[f + 1]! + sy[f]! * sy[f + 1]! < 0) turns.push(f);
      }
      // A swing is the way from one turning point to the next. A tremble is a run of swings, each
      // large enough to see and soon after the one before, while the pile is calm and the body seen.
      // How far the body is at frame t from where it was at frame a, in px. The zoom of one frame
      // is used for both, so that a camera that pushes in does not count as travel.
      const apart = (a: number, t: number): number => (channel === 'position' ? Math.hypot(X(t, i) - X(a, i), Y(t, i) - Y(a, i)) * zoom[t]! : Math.abs(edge[t]! - edge[a]!));
      const quiet = (from: number, to: number): boolean => {
        for (let f = from; f <= to; f++) if (!calm[f * N + i] || !seen[f * N + i]) return false;
        return true;
      };
      let k = 1;
      while (k < turns.length) {
        const swings: number[] = [];
        const start = k;
        while (k < turns.length) {
          const a = turns[k - 1]!;
          const t = turns[k]!;
          const swing = apart(a, t);
          if (swing < P.jitterPx || t - a > P.jitterFrames / 2 || !quiet(a, t)) break;
          swings.push(swing);
          k++;
        }
        if (swings.length >= P.jitterTurns) {
          const from = turns[start - 1]!;
          const to = turns[k - 1]!;
          // As many swings as asked for must fall within one window.
          let dense = false;
          for (let s = start - 1; s + P.jitterTurns < k && !dense; s++) dense = turns[s + P.jitterTurns]! - turns[s]! <= P.jitterFrames;
          if (dense) {
            const sorted = swings.slice().sort((x, y) => x - y);
            const typical = sorted[Math.floor(sorted.length / 2)]!;
            make(
              'jitter',
              b.id,
              null,
              from,
              to,
              typical,
              P.jitterPx,
              'px',
              `${channel === 'position' ? 'position' : 'rotation (travel of its edge)'}: swings back and forth ${swings.length} times between frames ${from} and ${to} (${secs(from)}-${secs(to)} s) while it and everything near it are at rest: ${typical.toFixed(2)} px a swing, at most ${sorted[sorted.length - 1]!.toFixed(2)} px`,
              from,
              [X(from, i), Y(from, i)],
            );
          }
        }
        if (k === start) k++;
      }
    }
  }

  // --- Piles that do not settle ---------------------------------------------------------------------
  let movingAtEnd = 0;
  let fastestAtEnd: { px: number; body: string; seen: boolean } | null = null;
  {
    const last = F - 1;
    for (const b of dyn) {
      if (b.first >= last || !moving[last * N + b.slot]) continue;
      movingAtEnd++;
      const px = netSpeed(last, b.slot);
      if (!fastestAtEnd || px > fastestAtEnd.px) fastestAtEnd = { px: round(px, 2), body: b.id, seen: seen[last * N + b.slot] === 1 };
    }
    if (gravity !== 0 && lastIslands && lastSupported) {
      const byRoot = new Map<number, number[]>();
      for (const b of dyn) {
        const root = lastIslands[b.slot]!;
        if (root < 0 || !lastSupported[root]) continue;
        const list = byRoot.get(root);
        if (list) list.push(b.slot);
        else byRoot.set(root, [b.slot]);
      }
      for (const members of byRoot.values()) {
        // A pile is bodies that lie on each other; one body that rolls along the ground is not one.
        if (members.length < 3) continue;
        // The pile was last joined when the latest of its bodies came to lie in it.
        const landedLast = members.reduce((a, m) => Math.max(a, groundedSince[m]!), -1);
        const waited = (last - landedLast) / FPS;
        if (landedLast < 0 || waited < P.settleSeconds) continue;
        const movers = members.filter((m) => moving[last * N + m] && seen[last * N + m]).sort((x, y) => netSpeed(last, y) - netSpeed(last, x) || x - y);
        if (movers.length === 0) continue;
        const m = movers[0]!;
        const speed = netSpeed(last, m);
        let from = last;
        while (from > landedLast && moving[(from - 1) * N + m]) from--;
        make(
          'unsettled',
          id(m),
          null,
          from,
          last,
          speed,
          P.restPx,
          'px per frame',
          `${movers.length} of the ${members.length} bodies of its pile still travel at the end of the shot, ${waited.toFixed(1)} s after the last one landed (frame ${landedLast}); this one at ${speed.toFixed(2)} px per frame over the last ${(half / FPS).toFixed(2)} s`,
          last,
          [X(last, m), Y(last, m)],
          movers.slice(1).map(id),
        );
      }
    }
  }

  // --- Energy spikes: frames close together are one spike ------------------------------------------------
  {
    spikes.sort((a, b) => a.i - b.i || a.f - b.f);
    for (let s = 0; s < spikes.length; ) {
      let e = s;
      let best = spikes[s]!;
      while (e + 1 < spikes.length && spikes[e + 1]!.i === best.i && spikes[e + 1]!.f - spikes[e]!.f <= 6) {
        e++;
        if (spikes[e]!.gain > best.gain) best = spikes[e]!;
      }
      const first = spikes[s]!;
      const lastOne = spikes[e]!;
      make(
        'energy-spike',
        id(best.i),
        null,
        first.f - 1,
        lastOne.f,
        best.gain,
        P.spikePx,
        'px per frame',
        `${best.spin ? 'spin (travel of its edge)' : 'speed'}: from ${best.own.toFixed(1)} to ${best.to.toFixed(1)} px per frame at frame ${best.f}; gravity gives ${(2 * gFrame * zoom[best.f]!).toFixed(1)}, and the fastest body it can have touched moved at ${best.fastest.toFixed(1)}: ${best.gain.toFixed(1)} px per frame come from nowhere`,
        best.f,
        [X(best.f, best.i), Y(best.f, best.i)],
      );
      s = e + 1;
    }
  }

  // --- Hits by bodies that are not drawn: frames close together are one hit ----------------------------
  {
    hits.sort((a, b) => a.i - b.i || a.j - b.j || a.f - b.f);
    for (let s = 0; s < hits.length; ) {
      let e = s;
      let best = hits[s]!;
      while (e + 1 < hits.length && hits[e + 1]!.i === best.i && hits[e + 1]!.j === best.j && hits[e + 1]!.f - hits[e]!.f <= 6) {
        e++;
        if (hits[e]!.change > best.change) best = hits[e]!;
      }
      make(
        'unseen-hit',
        id(best.i),
        id(best.j),
        hits[s]!.f - 1,
        hits[e]!.f,
        best.change,
        P.hitPx,
        'px per frame',
        `its velocity changes by ${best.change.toFixed(1)} px per frame at frame ${best.f}, and the only thing it touches is "${id(best.j)}", which is not drawn (faded out, or without size)`,
        best.f,
        [X(best.f, best.i), Y(best.f, best.i)],
      );
      s = e + 1;
    }
  }

  // --- The world as a whole ---------------------------------------------------------------------
  let restFrom: number | null = null;
  if (movingAtEnd === 0) {
    restFrom = F - 1;
    outer: for (let f = F - 1; f >= 0; f--) {
      for (const b of dyn) if (f >= b.first && moving[f * N + b.slot]) break outer;
      restFrom = f;
    }
    // A body that is not released yet has still to move.
    const lastRelease = dyn.reduce((a, b) => Math.max(a, Math.min(b.first, F - 1)), 0);
    restFrom = Math.max(restFrom, lastRelease);
  }
  const d = deepest as { px: number; a: number; b: number; frame: number } | null;
  const q = fastest as { px: number; body: number; frame: number } | null;
  return finish({
    gravity,
    deepest: d ? { px: round(d.px, 2), a: id(d.a), b: id(d.b), frame: d.frame } : null,
    fastest: q ? { px: round(q.px, 2), body: id(q.body), frame: q.frame } : null,
    restFrom,
    movingAtEnd,
    fastestAtEnd,
  });
}
