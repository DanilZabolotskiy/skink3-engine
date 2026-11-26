// The detectors of the motion review. Each reads the motion series and returns
// findings; none of them draws or bakes anything.
//
// Which finding applies to what:
//
//                   timeline nodes   rigid bodies      particles        links          camera
//   jump                 yes         size, opacity         -       appearance, width    yes
//   abrupt start/stop    yes             size              -            width           yes
//   mechanical           yes             size              -              -             no
//   too-fast             yes              yes          per emitter      pulses          no
//
// A light that runs along a stroke is judged as the pulse of a link is: too
// fast when it covers half of its own length per frame or more.
//
// A line whose width is keyed (a link or a stroke with a widthTo) is judged on
// the travel of its edge: for a jump, and for a start or a stop without an
// ease. A key of the width has no steady speed, so there is no mechanical
// change of width to look for.
//
// A shape whose fill is keyed (fillTo) is judged for a jump only, on the
// largest change of a channel of its colour in one frame: a colour has no
// place and no speed to start or stop with.
//
// A layer whose focus is pulled (blurTo) is judged under the subject
// "(focus:<layer id>)", for a jump and for a start or a stop without an ease,
// on how far its blur radius changes in a frame: the travel of a blurred edge
// as it spreads or gathers. A pull is the camera's, so it is not the life of
// the background either.
//
// The camera of a perspective layer whose view is keyed (perspectiveTo) is
// judged as the camera is, under the subject "(perspective:<layer id>)": for
// a jump and for a start or a stop without an ease, on how far the picture
// slides, how far the camera turns about the point it looks at (as the travel
// of what is at the edge of the frame) and how fast the picture grows. The
// nodes of that layer are judged on what they do in its space, not on what
// the camera does to their place on the layer.
//
// A node that follows a drive is judged like any other: the engine knows only
// the samples, so a drive that leaps, or that starts or stops at full speed,
// is found as on a key. A driven group with nothing in it, to which a link
// holds on, is judged while that link is seen: the link shows its every step.
//
// A rigid body gets its place and its turn from a solver: a contact is a
// legitimate change of velocity within a frame, a nudge from a neighbour moves
// it a few pixels at once, and a body that rolls or slides at a constant speed
// is a flow. So the place and the turn of a body are checked for strobing
// speed only. Its size and its opacity are animated by the timeline and are
// checked like those of any node. Children of a body are judged on their own
// tracks. Whether the simulation itself is sound (bodies that sink into each
// other, jitter at rest, tunnelling) is a matter for physics checks, which are
// not part of this review.
//
// Every placed node is judged on its own motion: its place, turn and size in
// the space of its parent (a label: relative to its target). A defect of a
// parent is therefore reported once, on the parent, and not again on
// everything it carries.

import { DEG } from '../core/math.ts';
import { FPS } from '../core/time.ts';
import { PULSE_LENGTH, strokePulseLength } from '../motion/curves.ts';
import { pathTable } from '../motion/paths.ts';
import { focusSubject, perspectiveSubject, type CompiledShot } from '../scene/compile.ts';
import { labelLayout, shapeOf, strokePathOf } from '../scene/evaluate.ts';
import { CAMERA_SUBJECT, STAGE_H, STAGE_W, type MotionFindingKind } from '../scene/types.ts';
import { globeTurn } from '../scene/globe.ts';
import { restForms } from '../scene/outline.ts';
import { reach, shapeExtent, type ShapeSpec } from '../shape/geometry.ts';
import { IN_FRAME, visibleAt, type MotionSeries, type PlacedSeries } from './series.ts';
import { T } from './thresholds.ts';

export type Channel = 'position' | 'rotation' | 'scale' | 'opacity' | 'level' | 'outline' | 'width' | 'shadow' | 'fill' | 'particles' | 'haze' | 'pulse' | 'spring' | 'hold' | 'focus';

export interface Finding {
  readonly kind: MotionFindingKind;
  /** A node id, "(camera)", "(perspective:<layer id>)", "(frame)" or "(frame:<region>)". */
  readonly subject: string;
  readonly channel: Channel;
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
}

/** What each kind of finding means and what usually fixes it. */
export const FINDING_KINDS: Readonly<Record<MotionFindingKind, { readonly means: string; readonly fix: string }>> = {
  jump: {
    means: 'a change between two frames that is out of line with the frames around it: a teleport or a pop',
    fix: 'look at the keys at that moment: two keys at once, a duration shorter than a frame, or a wrong target. To change place unseen, do it while the node is hidden (popOut, then popIn) or faded out',
  },
  'abrupt-start': {
    means: 'a move that is at full speed within two frames of rest',
    fix: 'give the move an ease-in: an overshoot or an anticipation above 0 (with both at 0 a moveTo, turnTo, scaleTo or widthTo is a plain ease-out that starts at full speed), or a longer duration',
  },
  'abrupt-stop': {
    means: 'a move that is still at full speed two frames before it rests',
    fix: 'let it slow down into its place: use an eased intent, lengthen the move, or let it overshoot and settle',
  },
  mechanical: {
    means: 'a move between two rests at constant speed',
    fix: 'replace the constant stretch with an eased move (moveTo with anticipation and overshoot); if it is meant as a flow, let it enter and leave the frame instead of resting in view',
  },
  'too-fast': {
    means: 'travel per frame of at least half of its own size, sustained: it strobes at 60 fps',
    fix: 'slow it down or make it larger: a longer move, a lower release velocity or gravity, more drag; for particles a lower speed or a larger size',
  },
  'spring-ringing': {
    means: 'a spring that still swings visibly long after its target has stopped',
    fix: 'raise the damping z of the spring (0.26 is already bouncy) or its frequency f',
  },
  'spring-no-overshoot': {
    means: 'a spring that is bouncy by its numbers but never passes its rest place',
    fix: 'lower f so that it lags more, or lower z; or use a preset that says what you get (light, heavy); or drop the spring',
  },
  'dead-area': {
    means: 'a part of the frame, or all of it, in which nothing moves on its own for seconds (camera motion does not count)',
    fix: 'give something there a life of its own: an idle wander, a pulse, particles that cover the area, or an action staged there',
  },
};

const round = (v: number, digits = 2): number => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

export function finding(
  kind: MotionFindingKind,
  subject: string,
  channel: Channel,
  from: number,
  to: number,
  value: number,
  threshold: number,
  unit: string,
  detail: string,
  severity = value / threshold,
): Finding {
  return { kind, subject, channel, from, to, value: round(value, 3), threshold, unit, severity: round(severity, 3), detail, fix: FINDING_KINDS[kind].fix };
}

/** Steps of one channel: the change from frame f - 1 to frame f in px, as components and as a length. */
interface Chan {
  readonly name: 'position' | 'rotation' | 'scale' | 'level' | 'outline' | 'width' | 'shadow' | 'focus';
  readonly a: Float32Array;
  readonly b: Float32Array;
  readonly d: Float32Array;
}

function chan(name: Chan['name'], frames: number): Chan {
  return { name, a: new Float32Array(frames), b: new Float32Array(frames), d: new Float32Array(frames) };
}

interface Steps {
  /** The node is seen at both frames of the step. */
  readonly seen: Uint8Array;
  /** It would be seen at one of them but for its size (a node that pops is at size zero while hidden). */
  readonly faintless: Uint8Array;
  /** It reaches into the frame at one of the two frames. */
  readonly inFrame: Uint8Array;
  readonly channels: readonly [Chan, Chan, Chan];
  /** The largest step of each channel, in px: a channel that never moves is passed over. */
  readonly largest: [number, number, number];
}

function newSteps(frames: number): Steps {
  return {
    seen: new Uint8Array(frames),
    faintless: new Uint8Array(frames),
    inFrame: new Uint8Array(frames),
    channels: [chan('position', frames), chan('rotation', frames), chan('scale', frames)],
    largest: [0, 0, 0],
  };
}

/** A node's own motion as steps in screen px, written into `st` (every entry from frame 1 on is overwritten). */
function ownSteps(series: MotionSeries, s: PlacedSeries, st: Steps): void {
  const F = series.frames;
  const zoom = series.views[s.node.layer]!.zoom;
  const [pos, rot, scl] = st.channels;
  const { seen, faintless, inFrame } = st;
  let maxPos = 0;
  let maxRot = 0;
  let maxScl = 0;
  for (let f = 1; f < F; f++) {
    seen[f] = visibleAt(s, f - 1) && visibleAt(s, f) ? 1 : 0;
    faintless[f] = s.alpha[f - 1]! >= T.visibleAlpha || s.alpha[f]! >= T.visibleAlpha ? 1 : 0;
    inFrame[f] = ((s.flags[f - 1]! | s.flags[f]!) & IN_FRAME) !== 0 ? 1 : 0;
    const u = s.unit[f]!;
    const a = (s.ownX[f]! - s.ownX[f - 1]!) * u;
    const b = (s.ownY[f]! - s.ownY[f - 1]!) * u;
    const d = a === 0 && b === 0 ? 0 : Math.hypot(a, b);
    pos.a[f] = a;
    pos.b[f] = b;
    pos.d[f] = d;
    if (d > maxPos) maxPos = d;
    const r = (s.ownRot[f]! - s.ownRot[f - 1]!) * DEG * s.turnRadius * s.scale[f]! * zoom[f]!;
    rot.a[f] = r;
    rot.d[f] = Math.abs(r);
    if (rot.d[f]! > maxRot) maxRot = rot.d[f]!;
    const g = (s.ownScale[f]! - s.ownScale[f - 1]!) * s.radius * u;
    scl.a[f] = g;
    scl.d[f] = Math.abs(g);
    if (s.axis) {
      // Its width and its height change apart: the travel of its edge along each axis, and the larger of the two.
      const gx = (s.ownScale[f]! * s.axis.sx[f]! - s.ownScale[f - 1]! * s.axis.sx[f - 1]!) * s.radius * u;
      const gy = (s.ownScale[f]! * s.axis.sy[f]! - s.ownScale[f - 1]! * s.axis.sy[f - 1]!) * s.radius * u;
      scl.a[f] = gx;
      scl.b[f] = gy;
      scl.d[f] = Math.max(Math.abs(gx), Math.abs(gy));
    }
    if (scl.d[f]! > maxScl) maxScl = scl.d[f]!;
  }
  st.largest[0] = maxPos;
  st.largest[1] = maxRot;
  st.largest[2] = maxScl;
}

const CHANNEL_WORDS: Readonly<Record<Chan['name'], { readonly moved: string; readonly what: string }>> = {
  position: { moved: 'moved', what: 'position' },
  rotation: { moved: 'turned by', what: 'rotation (travel of its edge)' },
  scale: { moved: 'changed size by', what: 'scale (travel of its edge)' },
  level: { moved: 'moved', what: 'level (travel of its surface)' },
  outline: { moved: 'changed by', what: 'outline (travel of its points)' },
  width: { moved: 'changed by', what: 'width (travel of its edge)' },
  shadow: { moved: 'moved', what: 'shadow (travel of its end)' },
  focus: { moved: 'changed by', what: 'focus (travel of a blurred edge)' },
};


// --- Jump ---------------------------------------------------------------------

/**
 * Steps out of line with the steps around them. `ok` says which steps may be
 * judged. Three shapes count: a spike (one large step among small ones), the
 * same spread over two frames, and a flicker (away and back within two frames).
 */
function jumps(subject: string, ch: Chan, ok: Uint8Array, frames: number, out: Finding[]): void {
  const words = CHANNEL_WORDS[ch.name];
  const largest = (steps: readonly number[]): number | null => {
    let m: number | null = null;
    for (const g of steps) if (g >= 1 && g < frames && ok[g]) m = Math.max(m ?? 0, ch.d[g]!);
    return m;
  };
  for (let f = 1; f < frames; f++) {
    if (!ok[f]) continue;
    const step = ch.d[f]!;
    if (step < T.jumpPx / 2) continue;
    // Two steps that stand out together.
    if (f + 1 < frames && ok[f + 1] && ch.d[f + 1]! >= T.jumpPx / 2) {
      const next = ch.d[f + 1]!;
      const small = Math.min(step, next);
      const outer = largest([f - 2, f - 1, f + 2, f + 3]);
      if (outer !== null && small >= T.jumpRatio * outer) {
        const sum = Math.hypot(ch.a[f]! + ch.a[f + 1]!, ch.b[f]! + ch.b[f + 1]!);
        if (sum <= 0.25 * small && Math.max(step, next) >= T.jumpPx) {
          out.push(
            finding('jump', subject, ch.name, f - 1, f + 1, Math.max(step, next), T.jumpPx, 'px in one frame',
              `${words.what}: left its course by ${step.toFixed(1)} px for one frame and came back (frame ${f}); the steps around are at most ${outer.toFixed(1)} px`),
          );
          f++;
          continue;
        }
        if (sum >= 0.75 * (step + next) && sum >= T.jumpPx) {
          out.push(
            finding('jump', subject, ch.name, f - 1, f + 1, sum, T.jumpPx, 'px in two frames',
              `${words.what}: ${words.moved} ${sum.toFixed(1)} px within two frames (${f - 1} to ${f + 1}); the steps around are at most ${outer.toFixed(1)} px`),
          );
          f++;
          continue;
        }
      }
    }
    if (step < T.jumpPx) continue;
    const around = largest([f - 2, f - 1, f + 1, f + 2]);
    if (around !== null && step >= T.jumpRatio * around) {
      out.push(
        finding('jump', subject, ch.name, f - 1, f, step, T.jumpPx, 'px in one frame',
          `${words.what}: ${words.moved} ${step.toFixed(1)} px between frames ${f - 1} and ${f}; the steps around it are at most ${around.toFixed(1)} px`),
      );
    }
  }
}

// --- Abrupt start and stop --------------------------------------------------------

/** Frames at which a bump starts on a node or on something it is in (a label: on its target). */
function bumpOnsets(c: CompiledShot, index: number): Set<number> {
  const out = new Set<number>();
  const add = (i: number): void => {
    for (let k = i; k >= 0; k = c.nodes[k]!.parent) {
      for (const b of c.nodes[k]!.scale?.bumps ?? []) {
        const f = Math.ceil(b.at * FPS - 1e-6);
        out.add(f);
        out.add(f + 1);
      }
    }
  };
  add(index);
  const n = c.nodes[index]!;
  if (n.node.type === 'label') add(n.targetIndex);
  return out;
}

/**
 * Frames at which a hop of the node takes off, and at which it lands, with the
 * frame on either side. A hop leaves the ground at speed and comes down at
 * speed: that is what a jump is, so neither end is an abrupt start or stop.
 */
function hopEdges(c: CompiledShot, index: number): { launches: Set<number>; landings: Set<number> } {
  const launches = new Set<number>();
  const landings = new Set<number>();
  for (const seg of c.nodes[index]!.pos?.segs ?? []) {
    if (seg.kind !== 'hop') continue;
    const a = Math.ceil(seg.at * FPS - 1e-6);
    const b = Math.floor((seg.at + seg.dur) * FPS + 1e-6);
    for (const d of [-1, 0, 1, 2]) launches.add(a + d);
    for (const d of [-2, -1, 0, 1]) landings.add(b + d);
  }
  return { launches, landings };
}

const NO_FRAMES: ReadonlySet<number> = new Set<number>();

function abrupt(
  subject: string,
  ch: Chan,
  st: Pick<Steps, 'seen' | 'inFrame'>,
  frames: number,
  onsets: ReadonlySet<number>,
  out: Finding[],
  launches: ReadonlySet<number> = NO_FRAMES,
  landings: ReadonlySet<number> = NO_FRAMES,
): void {
  const { seen, inFrame } = st;
  const words = CHANNEL_WORDS[ch.name];
  // Starts: step f is the first of a move; steps f - 1 and f - 2 are rest.
  for (let f = 3; f + 1 < frames; f++) {
    if (!(seen[f - 2] && seen[f - 1] && seen[f] && seen[f + 1]) || !inFrame[f]) continue;
    const reached = Math.max(ch.d[f]!, ch.d[f + 1]!);
    if (reached < T.abruptMinPx) continue;
    const rest = Math.max(T.restPx, T.restShare * reached);
    if (ch.d[f]! <= rest || ch.d[f - 1]! > rest || ch.d[f - 2]! > rest) continue;
    let end = f;
    let peak = ch.d[f]!;
    while (end + 1 < frames && seen[end + 1] && ch.d[end + 1]! > rest) {
      end++;
      peak = Math.max(peak, ch.d[end]!);
    }
    if (reached < T.abruptPeakShare * peak) continue;
    // A bump is a hit: its sudden start is the point. It may be the first or the second step of the start.
    if (onsets.has(f) || onsets.has(f + 1)) continue;
    // So is the take-off of a hop.
    if (launches.has(f)) continue;
    // So is any other kick: an excursion that comes back.
    let cx = 0;
    let cy = 0;
    let far = 0;
    let kick = false;
    for (let g = f; g < frames && g < f + T.kickFrames && seen[g]; g++) {
      cx += ch.a[g]!;
      cy += ch.b[g]!;
      const m = Math.hypot(cx, cy);
      if (m > far) far = m;
      else if (m <= (1 - T.kickReturn) * far) {
        kick = true;
        break;
      }
    }
    if (kick) continue;
    out.push(
      finding('abrupt-start', subject, ch.name, f - 1, Math.min(end, f + 1), reached, T.abruptMinPx, 'px per frame',
        `${words.what}: from rest to ${reached.toFixed(1)} px per frame within two frames (frames ${f - 1}-${f + 1}), ${Math.round((100 * reached) / peak)} % of the peak speed of the move (limit ${Math.round(100 * T.abruptPeakShare)} %)`),
    );
  }
  // Stops: step f is the last of a move; steps f + 1 and f + 2 are rest.
  for (let f = 2; f + 2 < frames; f++) {
    if (!(seen[f - 1] && seen[f] && seen[f + 1] && seen[f + 2]) || !inFrame[f]) continue;
    const reached = Math.max(ch.d[f]!, ch.d[f - 1]!);
    if (reached < T.abruptMinPx) continue;
    const rest = Math.max(T.restPx, T.restShare * reached);
    if (ch.d[f]! <= rest || ch.d[f + 1]! > rest || ch.d[f + 2]! > rest) continue;
    let begin = f;
    let peak = ch.d[f]!;
    while (begin - 1 >= 1 && seen[begin - 1] && ch.d[begin - 1]! > rest) {
      begin--;
      peak = Math.max(peak, ch.d[begin]!);
    }
    if (reached < T.abruptPeakShare * peak) continue;
    // A hop lands at speed.
    if (landings.has(f)) continue;
    out.push(
      finding('abrupt-stop', subject, ch.name, Math.max(begin - 1, f - 2), f, reached, T.abruptMinPx, 'px per frame',
        `${words.what}: still at ${reached.toFixed(1)} px per frame two frames before rest (frames ${f - 2}-${f}), ${Math.round((100 * reached) / peak)} % of the peak speed of the move (limit ${Math.round(100 * T.abruptPeakShare)} %)`),
    );
  }
}

// --- Mechanical move ------------------------------------------------------------------

function mechanical(subject: string, ch: Chan, st: Steps, s: PlacedSeries, frames: number, out: Finding[]): void {
  const { seen } = st;
  const words = CHANNEL_WORDS[ch.name];
  const inView = (frame: number): boolean => (s.flags[frame]! & IN_FRAME) !== 0;
  let f = 1;
  while (f < frames) {
    if (!seen[f] || ch.d[f]! < T.mechMinSpeedPx) {
      f++;
      continue;
    }
    // A stretch of constant speed, grown greedily from step f.
    let lo = ch.d[f]!;
    let hi = lo;
    let last = f;
    while (last + 1 < frames && seen[last + 1]) {
      const v = ch.d[last + 1]!;
      const nlo = Math.min(lo, v);
      const nhi = Math.max(hi, v);
      if (nhi > nlo * (1 + 2 * T.mechTolerance)) break;
      lo = nlo;
      hi = nhi;
      last++;
    }
    const n = last - f + 1;
    if (n < T.mechMinFrames) {
      f = last + 1;
      continue;
    }
    // The move around the stretch, out to rest on both sides.
    const speed = (lo + hi) / 2;
    const rest = Math.max(T.restPx, T.restShare * speed);
    let start = f;
    while (start - 1 >= 1 && seen[start - 1] && ch.d[start - 1]! > rest) start--;
    let end = last;
    while (end + 1 < frames && seen[end + 1] && ch.d[end + 1]! > rest) end++;
    // Both rests must be seen in the frame. A thing that enters, leaves, appears
    // or vanishes while it moves is a flow, and a flow may be constant.
    const restBefore = start - 1 >= 1 && seen[start - 1] === 1 && inView(start - 1);
    const restAfter = end + 1 < frames && seen[end + 1] === 1 && inView(end);
    let dist = 0;
    for (let g = start; g <= end; g++) dist += ch.d[g]!;
    const share = n / (end - start + 1);
    if (restBefore && restAfter && dist >= T.mechMinPx && share >= T.mechShare) {
      out.push(
        finding('mechanical', subject, ch.name, start - 1, end, share, T.mechShare, 'share of the move at constant speed',
          `${words.what}: constant ${speed.toFixed(1)} px per frame (within ${Math.round(100 * T.mechTolerance)} %) over ${n} of the ${end - start + 1} frames of a move of ${dist.toFixed(0)} px between two rests`),
      );
    }
    f = end + 1;
  }
}

// --- Too fast -------------------------------------------------------------------------------

/** Size of a node along a direction on screen, in px. */
function sizeAlong(series: MotionSeries, s: PlacedSeries, f: number, ux: number, uy: number): number {
  const node = s.node.node;
  const k = s.scale[f]! * series.views[s.node.layer]!.zoom[f]!;
  if (node.type === 'shape') {
    const rot = s.rot[f]! * DEG;
    const cos = Math.cos(-rot);
    const sin = Math.sin(-rot);
    const lx = ux * cos - uy * sin;
    const ly = ux * sin + uy * cos;
    const shape = shapeOf(s.node, f / FPS);
    return (reach(shape, [lx, ly]) + reach(shape, [-lx, -ly])) * k;
  }
  if (node.type === 'eye') return 2 * node.r * k;
  if (node.type === 'label') {
    const box = labelLayout(series.shot, s.node, series.lang).geometry.box;
    return (Math.abs(box.w * ux) + Math.abs(box.h * uy)) * k;
  }
  return 2 * s.radius * k;
}

/**
 * The step of a node from frame f - 1 to f in screen px, against what it is
 * attached to. A node attached to nothing moves against the screen, camera
 * included. A child is measured in the frame of its parent as it is turned at
 * each moment: its own move inside the parent counts, and so does the swing a
 * turning parent gives it, but not the parent's travel or growth, which move
 * the whole thing as one. A label is measured against its target.
 */
export function relativeSteps(series: MotionSeries, s: PlacedSeries): { dx: Float32Array; dy: Float32Array } {
  const F = series.frames;
  const view = series.views[s.node.layer]!;
  const dx = new Float32Array(F);
  const dy = new Float32Array(F);
  const node = s.node.node;
  if (node.type === 'label' || (s.node.parent >= 0 && s.node.springKind === 'follow')) {
    // Their own place is already an offset in the layer's space.
    for (let f = 1; f < F; f++) {
      dx[f] = (s.ownX[f]! - s.ownX[f - 1]!) * s.unit[f]!;
      dy[f] = (s.ownY[f]! - s.ownY[f - 1]!) * s.unit[f]!;
    }
  } else if (s.node.parent >= 0) {
    const parent = series.placed[s.node.parent]!;
    // A globe's turn is in its rotation, but it turns its surface, not the frame its children are placed in.
    const holder = parent.node.node;
    const spin = holder.type === 'shape' && holder.globe ? holder.globe.spin : null;
    let px = 0;
    let py = 0;
    for (let f = 0; f < F; f++) {
      const a = (parent.rot[f]! - (spin === null ? 0 : globeTurn(spin, f / FPS))) * DEG;
      const x = s.ownX[f]! * Math.cos(a) - s.ownY[f]! * Math.sin(a);
      const y = s.ownX[f]! * Math.sin(a) + s.ownY[f]! * Math.cos(a);
      if (f > 0) {
        dx[f] = (x - px) * s.unit[f]!;
        dy[f] = (y - py) * s.unit[f]!;
      }
      px = x;
      py = y;
    }
  } else {
    for (let f = 1; f < F; f++) {
      dx[f] = s.x[f]! * view.zoom[f]! + view.tx[f]! - (s.x[f - 1]! * view.zoom[f - 1]! + view.tx[f - 1]!);
      dy[f] = s.y[f]! * view.zoom[f]! + view.ty[f]! - (s.y[f - 1]! * view.zoom[f - 1]! + view.ty[f - 1]!);
    }
  }
  return { dx, dy };
}

function tooFast(series: MotionSeries, s: PlacedSeries, ownLargest: number, out: Finding[]): void {
  const F = series.frames;
  const view = series.views[s.node.layer]!;
  const node = s.node.node;
  // A part that neither moves inside its parent nor rides on one that turns cannot strobe by itself.
  if (node.type !== 'label' && s.node.parent >= 0 && s.node.springKind !== 'follow' && ownLargest < T.fastMinPx) {
    const parent = series.placed[s.node.parent]!;
    let turns = parent.still === false && parent.rot[0] !== parent.rot[F - 1];
    for (let f = 1; !turns && f < F; f += 1) turns = parent.rot[f] !== parent.rot[f - 1];
    if (!turns) return;
  }
  const rel = relativeSteps(series, s);
  // No direction of a shape is narrower than twice its inner radius: a cheap first test.
  // For a region whose outline is keyed: the narrowest of the outlines it rests in.
  const narrow = node.type !== 'shape' ? 0 : 2 * (s.node.outline ? Math.min(...(restForms(s.node.outline) as ShapeSpec[]).map((shape) => shapeExtent(shape).inner)) : shapeExtent(node.shape).inner);
  // Runs of frames above the limit, each long enough to count.
  const runs: { from: number; to: number; peak: number; speed: number }[] = [];
  let runStart = -1;
  let peak = 0;
  let peakSpeed = 0;
  const close = (endFrame: number): void => {
    if (runStart >= 0 && endFrame - runStart + 1 >= T.fastFrames) runs.push({ from: runStart, to: endFrame, peak, speed: peakSpeed });
    runStart = -1;
    peak = 0;
    peakSpeed = 0;
  };
  for (let f = 1; f < F; f++) {
    let ratio = 0;
    let step = 0;
    if (visibleAt(s, f - 1) && visibleAt(s, f) && (s.flags[f]! & IN_FRAME) !== 0) {
      const dx = rel.dx[f]!;
      const dy = rel.dy[f]!;
      step = Math.hypot(dx, dy);
      const k = s.scale[f]! * view.zoom[f]!;
      if (step >= T.fastMinPx && step >= T.fastRatio * Math.max(narrow * k, 2 * T.minRadiusPx)) {
        const size = sizeAlong(series, s, f, dx / step, dy / step);
        if (size >= 2 * T.minRadiusPx) ratio = step / size;
      }
    }
    if (ratio >= T.fastRatio) {
      if (runStart < 0) runStart = f;
      if (ratio > peak) {
        peak = ratio;
        peakSpeed = step;
      }
    } else {
      close(f - 1);
    }
  }
  close(F - 1);
  // Runs less than half a second apart are one thing that keeps strobing: a swing, a bounce.
  for (let i = 0; i < runs.length; ) {
    let j = i;
    let frames = runs[i]!.to - runs[i]!.from + 1;
    let best = runs[i]!;
    while (j + 1 < runs.length && runs[j + 1]!.from - runs[j]!.to <= FPS / 2) {
      j++;
      frames += runs[j]!.to - runs[j]!.from + 1;
      if (runs[j]!.peak > best.peak) best = runs[j]!;
    }
    const from = runs[i]!.from - 1;
    const to = runs[j]!.to;
    out.push(
      finding('too-fast', s.id, 'position', from, to, best.peak, T.fastRatio, 'own size per frame',
        `travels up to ${best.peak.toFixed(2)} of its own size per frame (${best.speed.toFixed(1)} px per frame); above the limit for ${frames} frames${j > i ? `, in ${j - i + 1} bursts` : ''}`),
    );
    i = j + 1;
  }
}

// --- The width of a line ---------------------------------------------------------------------------

/**
 * The width of a line over the shot as a channel: the travel of its edge,
 * which is half the change of its width, in px. null when it never changes
 * enough for a detector to have anything to say.
 */
function widthSteps(width: Float32Array, zoom: ArrayLike<number>, frames: number, quiet: number): Chan | null {
  const ch = chan('width', frames);
  let largest = 0;
  for (let f = 1; f < frames; f++) {
    ch.b[f] = ((width[f]! - width[f - 1]!) / 2) * zoom[f]!;
    ch.d[f] = Math.abs(ch.b[f]!);
    if (ch.d[f]! > largest) largest = ch.d[f]!;
  }
  return largest >= quiet ? ch : null;
}

// --- Everything on placed nodes, links, emitters and the camera -----------------------------------

/** A colour that pops: the fill of a shape, or the colour of a line, changed a channel by `step` of its range in frame f. */
function colourJump(subject: string, line: boolean, f: number, step: number): Finding {
  return finding('jump', subject, 'fill', f - 1, f, step, T.jumpFill, 'share of the range of a channel in one frame',
    `${line ? 'colour: a channel of the colour of the line' : 'fill: a channel of its colour'} changed by ${step.toFixed(2)} of its range between frames ${f - 1} and ${f}`);
}

/** Jumps, abrupt starts and stops, mechanical moves and strobing speed of every node, link, emitter and the camera. */
export function detectMotion(series: MotionSeries): Finding[] {
  const c = series.shot;
  const F = series.frames;
  const out: Finding[] = [];
  // One set of buffers for all nodes.
  const st = newSteps(F);
  const big = new Uint8Array(F);
  const okSeen = new Uint8Array(F);
  const okSize = new Uint8Array(F);
  // Below this no detector has anything to say about a channel.
  const quiet = Math.min(T.jumpPx / 2, T.abruptMinPx, T.mechMinSpeedPx);

  for (const s of series.placed) {
    if (!s) continue;
    // A group with nothing in it is an anchor: it is never seen, unless it is driven and a link holds on to
    // it. And what nothing animates has no motion to judge.
    const anchor = s.type === 'group' && s.radius <= 0;
    if (s.still || (anchor && !s.node.driven)) continue;
    ownSteps(series, s, st);
    const zoom = series.views[s.node.layer]!.zoom;
    for (let f = 1; f < F; f++) {
      const r = s.radius * Math.max(s.scale[f - 1]!, s.scale[f]!) * zoom[f]!;
      big[f] = anchor || r >= T.minRadiusPx ? 1 : 0;
    }
    const mine: Finding[] = [];
    const [pos, rot, scl] = st.channels;

    // Jumps. Position and rotation need the node seen on both sides; size is
    // judged across a pop too, where the hidden side counts as size zero.
    for (let f = 1; f < F; f++) {
      okSeen[f] = st.seen[f] && st.inFrame[f] && big[f] ? 1 : 0;
      okSize[f] = st.faintless[f] && st.inFrame[f] && big[f] ? 1 : 0;
    }
    // The place and the turn of a rigid body come from the solver, where a
    // contact changes them within a frame; its size and opacity are animated
    // like those of any node.
    if (!s.solver) {
      if (st.largest[0] >= quiet) jumps(s.id, pos, okSeen, F, mine);
      if (st.largest[1] >= quiet) jumps(s.id, rot, okSeen, F, mine);
    }
    if (st.largest[2] >= quiet) jumps(s.id, scl, okSize, F, mine);
    // Opacity: a third of full opacity in one frame is a pop.
    for (let f = 1; f < F; f++) {
      if (!st.inFrame[f] || !big[f]) continue;
      const step = Math.abs(s.ownAlpha[f]! - s.ownAlpha[f - 1]!);
      if (step < T.jumpOpacity || Math.max(s.alpha[f - 1]!, s.alpha[f]!) < T.jumpOpacity) continue;
      mine.push(
        finding('jump', s.id, 'opacity', f - 1, f, step, T.jumpOpacity, 'opacity in one frame',
          `opacity: changed by ${step.toFixed(2)} between frames ${f - 1} and ${f} (from ${s.ownAlpha[f - 1]!.toFixed(2)} to ${s.ownAlpha[f]!.toFixed(2)})`),
      );
    }
    // Fill: a shape whose fill is keyed, or a stroke whose colour is, pops when a channel of its colour changes by a
    // third of its range in one frame.
    if (s.fill) {
      for (let f = 1; f < F; f++) {
        if (!st.seen[f] || !st.inFrame[f] || !big[f]) continue;
        const step = s.fill[f]!;
        if (step < T.jumpFill) continue;
        mine.push(colourJump(s.id, s.type === 'stroke', f, step));
      }
    }

    {
      const onsets = bumpOnsets(c, s.node.index);
      const hops = hopEdges(c, s.node.index);
      const eased: Finding[] = [];
      const flat: Finding[] = [];
      st.channels.forEach((ch, i) => {
        if ((s.solver && ch !== scl) || st.largest[i]! < quiet) return;
        if (ch === pos) abrupt(s.id, ch, st, F, onsets, eased, hops.launches, hops.landings);
        else abrupt(s.id, ch, st, F, onsets, eased);
        mechanical(s.id, ch, st, s, F, flat);
      });
      // A content with a level: the travel of its surface is judged like a move.
      if (s.level) {
        const lvl = chan('level', F);
        const zoomOf = series.views[s.node.layer]!.zoom;
        let largest = 0;
        for (let f = 1; f < F; f++) {
          lvl.b[f] = (s.level[f]! - s.level[f - 1]!) * zoomOf[f]!;
          lvl.d[f] = Math.abs(lvl.b[f]!);
          if (lvl.d[f]! > largest) largest = lvl.d[f]!;
        }
        if (largest >= quiet) {
          jumps(s.id, lvl, okSeen, F, mine);
          abrupt(s.id, lvl, st, F, NO_FRAMES, eased);
          mechanical(s.id, lvl, st, s, F, flat);
        }
      }
      // A body whose height is keyed in a group that casts shadows: the travel of the end of its shadow is judged
      // like a move. A shadow longer than its body is high travels farther than the body does.
      if (s.shadow) {
        const end = chan('shadow', F);
        const zoomOf = series.views[s.node.layer]!.zoom;
        let largest = 0;
        for (let f = 1; f < F; f++) {
          end.b[f] = (s.shadow[f]! - s.shadow[f - 1]!) * zoomOf[f]!;
          end.d[f] = Math.abs(end.b[f]!);
          if (end.d[f]! > largest) largest = end.d[f]!;
        }
        if (largest >= quiet) {
          jumps(s.id, end, okSeen, F, mine);
          abrupt(s.id, end, st, F, NO_FRAMES, eased);
          mechanical(s.id, end, st, s, F, flat);
        }
      }
      // A region or a stroke whose outline is keyed: the travel of its points is judged like a move.
      if (s.outline) {
        const form = chan('outline', F);
        const zoomOf = series.views[s.node.layer]!.zoom;
        let largest = 0;
        for (let f = 1; f < F; f++) {
          form.b[f] = (s.outline[f]! - s.outline[f - 1]!) * zoomOf[f]!;
          form.d[f] = Math.abs(form.b[f]!);
          if (form.d[f]! > largest) largest = form.d[f]!;
        }
        if (largest >= quiet) {
          jumps(s.id, form, okSeen, F, mine);
          abrupt(s.id, form, st, F, NO_FRAMES, eased);
          mechanical(s.id, form, st, s, F, flat);
        }
      }
      // A stroke whose width is keyed: the travel of its edge is judged for a jump and for its ease.
      const wide = s.width ? widthSteps(s.width, series.views[s.node.layer]!.zoom, F, quiet) : null;
      if (wide) {
        jumps(s.id, wide, okSeen, F, mine);
        abrupt(s.id, wide, st, F, NO_FRAMES, eased);
      }
      // A constant-speed move starts and stops abruptly by nature, and a jump is
      // a start and a stop at once: one finding says it.
      const leaps = mine.filter((j) => j.kind === 'jump');
      for (const e of eased) {
        const covered =
          flat.some((m) => m.channel === e.channel && e.from >= m.from - 2 && e.to <= m.to + 2) ||
          leaps.some((j) => j.channel === e.channel && e.from <= j.to && e.to >= j.from);
        if (!covered) mine.push(e);
      }
      mine.push(...flat);
    }

    if (s.type !== 'group' || s.node.parent < 0) tooFast(series, s, st.largest[0], mine);
    out.push(...mine);
  }

  // Links: a link that appears or vanishes within a frame, and pulses too quick to follow.
  for (const l of series.links) {
    const n = l.node;
    const from = series.placed[n.fromIndex]!;
    const to = series.placed[n.toIndex]!;
    for (let f = 1; f < F; f++) {
      if (((l.flags[f - 1]! | l.flags[f]!) & IN_FRAME) === 0) continue;
      const step = Math.abs(l.presence[f]! - l.presence[f - 1]!);
      if (step < T.jumpOpacity) continue;
      // An end node that pops is reported on that node.
      if (Math.abs(from.alpha[f]! - from.alpha[f - 1]!) >= T.jumpOpacity || Math.abs(to.alpha[f]! - to.alpha[f - 1]!) >= T.jumpOpacity) continue;
      out.push(
        finding('jump', l.id, 'opacity', f - 1, f, step, T.jumpOpacity, 'opacity in one frame',
          `the link ${l.presence[f]! > l.presence[f - 1]! ? 'appears' : 'vanishes'} within one frame (drawn share times opacity changes by ${step.toFixed(2)} between frames ${f - 1} and ${f})`),
      );
    }
    // A link whose colour is keyed: a pop of its colour while it is seen, in frame and long enough to judge.
    if (l.fill) {
      const zoom = series.views[n.layer]!.zoom;
      for (let f = 1; f < F; f++) {
        if (l.presence[f - 1]! < T.visibleAlpha || l.presence[f]! < T.visibleAlpha || ((l.flags[f - 1]! | l.flags[f]!) & IN_FRAME) === 0) continue;
        if (Math.max(l.half[f - 1]!, l.half[f]!) * zoom[f]! < T.minRadiusPx) continue;
        const step = l.fill[f]!;
        if (step >= T.jumpFill) out.push(colourJump(l.id, true, f, step));
      }
    }
    // A link whose width is keyed: the travel of its edge, judged as on a stroke while the link is seen.
    const wide = l.width ? widthSteps(l.width, series.views[n.layer]!.zoom, F, quiet) : null;
    if (wide) {
      const seen = new Uint8Array(F);
      const inFrame = new Uint8Array(F);
      const ok = new Uint8Array(F);
      for (let f = 1; f < F; f++) {
        seen[f] = l.presence[f - 1]! >= T.visibleAlpha && l.presence[f]! >= T.visibleAlpha ? 1 : 0;
        inFrame[f] = ((l.flags[f - 1]! | l.flags[f]!) & IN_FRAME) !== 0 ? 1 : 0;
        ok[f] = seen[f] && inFrame[f] ? 1 : 0;
      }
      const leaps: Finding[] = [];
      const eased: Finding[] = [];
      jumps(l.id, wide, ok, F, leaps);
      abrupt(l.id, wide, { seen, inFrame }, F, NO_FRAMES, eased);
      // A jump is a start and a stop at once: one finding says it.
      out.push(...leaps, ...eased.filter((e) => !leaps.some((j) => e.from <= j.to && e.to >= j.from)));
    }
    const limit = 1 / (T.fastRatio * PULSE_LENGTH);
    for (const p of n.link!.pulses) {
      const count = p.dur * FPS;
      if (count >= limit) continue;
      const f0 = Math.min(F - 1, Math.max(0, Math.ceil(p.at * FPS)));
      const f1 = Math.min(F - 1, Math.floor((p.at + p.dur) * FPS));
      if ((l.flags[f0]! & IN_FRAME) === 0) continue;
      const ratio = 1 / (count * PULSE_LENGTH);
      out.push(
        finding('too-fast', l.id, 'pulse', f0, Math.max(f0, f1), ratio, T.fastRatio, 'own length per frame',
          `a pulse crosses the link in ${count.toFixed(1)} frames: ${ratio.toFixed(2)} of its own length per frame (a pulse needs at least ${Math.ceil(limit)} frames)`),
      );
    }
  }

  // Strokes: a light that runs along the line too quick to follow. As on a link, it is held against its own length.
  for (const s of series.placed) {
    if (!s || s.node.node.type !== 'stroke' || !s.node.stroke) continue;
    for (const p of s.node.stroke.pulses) {
      // The line as it is when the light sets off.
      const length = pathTable(strokePathOf(s.node, p.at)).length;
      const way = Math.abs(p.to - p.from) * length;
      const light = strokePulseLength(p, length);
      const count = p.dur * FPS;
      const ratio = way / count / light;
      if (ratio < T.fastRatio) continue;
      const f0 = Math.min(F - 1, Math.max(0, Math.ceil(p.at * FPS)));
      const f1 = Math.min(F - 1, Math.floor((p.at + p.dur) * FPS));
      if ((s.flags[f0]! & IN_FRAME) === 0 || !visibleAt(s, f0)) continue;
      out.push(
        finding('too-fast', s.id, 'pulse', f0, Math.max(f0, f1), ratio, T.fastRatio, 'own length per frame',
          `a light of ${light.toFixed(0)} units runs ${way.toFixed(0)} units along the stroke in ${count.toFixed(1)} frames: ${ratio.toFixed(2)} of its own length per frame (it needs at least ${Math.ceil(way / (T.fastRatio * light))} frames)`),
      );
    }
  }

  // Emitters: most of the particles in frame strobe, for a while.
  for (const e of series.emitters) {
    let start = -1;
    let last = -1;
    const runs: [number, number][] = [];
    for (let f = 0; f < F; f++) {
      const hot = e.count[f]! >= T.fastMinParticles && e.fast[f]! / e.count[f]! >= T.fastParticleShare;
      if (hot) {
        // Runs half a second apart are one stream.
        if (start >= 0 && f - last > FPS / 2) {
          runs.push([start, last]);
          start = f;
        }
        if (start < 0) start = f;
        last = f;
      }
    }
    if (start >= 0) runs.push([start, last]);
    for (const [a, b] of runs) {
      if (b - a + 1 < T.fastFrames) continue;
      const ratios: number[] = [];
      const speeds: number[] = [];
      let share = 0;
      let counted = 0;
      let particles = 0;
      for (let f = a; f <= b; f++) {
        if (e.count[f]! < T.fastMinParticles) continue;
        ratios.push(e.medianRatio[f]!);
        speeds.push(e.medianSpeed[f]!);
        share += e.fast[f]! / e.count[f]!;
        particles += e.count[f]!;
        counted++;
      }
      ratios.sort((x, y) => x - y);
      speeds.sort((x, y) => x - y);
      const mid = ratios[Math.floor(ratios.length / 2)]!;
      out.push(
        finding('too-fast', e.id, 'particles', a, b, mid, T.fastRatio, 'own size per frame',
          `${Math.round((100 * share) / counted)} % of its particles in frame (about ${Math.round(particles / counted)}) travel at least half of their own size per frame: median ${mid.toFixed(2)} of the size, ${speeds[Math.floor(speeds.length / 2)]!.toFixed(1)} px per frame`),
      );
    }
  }

  // Heat hazes: ripples that drift half their size or more in a frame strobe, as a pattern on a wheel does.
  for (const h of series.hazes ?? []) {
    if (h.ratio < T.fastRatio) continue;
    let start = -1;
    for (let f = 0; f <= F; f++) {
      const hot = f < F && h.amount[f]! >= T.hazeMinPx && h.step[f]! >= T.fastMinPx;
      if (hot && start < 0) start = f;
      if (!hot && start >= 0) {
        if (f - start >= T.fastFrames) {
          const step = h.step[Math.floor((start + f - 1) / 2)]!;
          out.push(
            finding('too-fast', h.id, 'haze', start, f - 1, h.ratio, T.fastRatio, 'own size per frame',
              `its finer ripples drift ${h.ratio.toFixed(2)} of their own size per frame (${step.toFixed(1)} px): the haze strobes; give it a lower speed or a larger scale`),
          );
        }
        start = -1;
      }
    }
  }

  // The camera: jumps and abrupt starts and stops. Its steady drift is a flow.
  {
    const pos = chan('position', F);
    const scl = chan('scale', F);
    const all = new Uint8Array(F).fill(1);
    all[0] = 0;
    for (let f = 1; f < F; f++) {
      const z = series.camera.zoom[f]!;
      pos.a[f] = (series.camera.x[f]! - series.camera.x[f - 1]!) * z;
      pos.b[f] = (series.camera.y[f]! - series.camera.y[f - 1]!) * z;
      pos.d[f] = Math.hypot(pos.a[f]!, pos.b[f]!);
      // A zoom moves the edge of the frame by half the frame width times its change. With camera keys or zoom keys the
      // zoom may be far from 1, and its change is what it is to the eye: a ratio.
      scl.a[f] = (series.shot.cameraTrack ? z / series.camera.zoom[f - 1]! - 1 : z - series.camera.zoom[f - 1]!) * (STAGE_W / 2);
      scl.d[f] = Math.abs(scl.a[f]!);
    }
    const cam: Steps = { seen: all, faintless: all, inFrame: all, channels: [pos, chan('rotation', F), scl], largest: [0, 0, 0] };
    for (const ch of [pos, scl]) {
      jumps(CAMERA_SUBJECT, ch, all, F, out);
      abrupt(CAMERA_SUBJECT, ch, cam, F, new Set(), out);
    }
  }

  // The camera of a perspective layer: the same, on its slide, its turn and the growth of its picture.
  for (const p of series.perspectives ?? []) {
    const subject = perspectiveSubject(p.id);
    const pos = chan('position', F);
    const rot = chan('rotation', F);
    const scl = chan('scale', F);
    const all = new Uint8Array(F).fill(1);
    all[0] = 0;
    for (let f = 1; f < F; f++) {
      pos.a[f] = p.slideX[f]!;
      pos.b[f] = p.slideY[f]!;
      pos.d[f] = Math.hypot(pos.a[f]!, pos.b[f]!);
      // A turn about the point the camera looks at moves what is at the edge of the frame by the angle times half the frame height.
      rot.a[f] = p.round[f]! * (STAGE_H / 2);
      rot.b[f] = p.tilt[f]! * (STAGE_H / 2);
      rot.d[f] = Math.hypot(rot.a[f]!, rot.b[f]!);
      // A picture that grows moves the edge of the frame by half the frame width times the share it grows by.
      scl.a[f] = p.grow[f]! * (STAGE_W / 2);
      scl.d[f] = Math.abs(scl.a[f]!);
    }
    const cam: Steps = { seen: all, faintless: all, inFrame: all, channels: [pos, rot, scl], largest: [0, 0, 0] };
    for (const ch of [pos, rot, scl]) {
      jumps(subject, ch, all, F, out);
      abrupt(subject, ch, cam, F, new Set(), out);
    }
  }

  // A pull of focus: how far the blur radius of its layer changes in a frame.
  for (const p of series.focus ?? []) {
    const ch = chan('focus', F);
    const all = new Uint8Array(F).fill(1);
    all[0] = 0;
    for (let f = 1; f < F; f++) {
      ch.a[f] = p.step[f]!;
      ch.d[f] = Math.abs(ch.a[f]!);
    }
    jumps(focusSubject(p.id), ch, all, F, out);
    abrupt(focusSubject(p.id), ch, { seen: all, inFrame: all }, F, new Set(), out);
  }

  return out;
}

