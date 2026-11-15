// The detectors of the motion review. Each reads the motion series and returns
// findings; none of them draws or bakes anything.
//
// Which finding applies to what:
//
//                   timeline nodes   rigid bodies   particles     links        camera
//   jump                 yes             yes            -        appearance     yes
//   abrupt start/stop    yes             no             -            -          yes
//   mechanical           yes             no             -            -          no
//   too-fast             yes             yes        per emitter    pulses        no
//
// A rigid body gets its motion from a solver: an impact is a legitimate change
// of velocity within a frame, and a body that rolls or slides at a constant
// speed is a flow. So bodies are checked for jumps (a pop out of a contact) and
// for speed, and not for ease. Children of a body are judged on their own
// tracks, like any other node.
//
// Every placed node is judged on its own motion: its place, turn and size in
// the space of its parent (a label: relative to its target). A defect of a
// parent is therefore reported once, on the parent, and not again on
// everything it carries.

import { DEG } from '../core/math.ts';
import { FPS } from '../core/time.ts';
import { PULSE_LENGTH } from '../motion/curves.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { labelLayout } from '../scene/evaluate.ts';
import { CAMERA_SUBJECT, STAGE_W, type MotionFindingKind } from '../scene/types.ts';
import { reach, shapeExtent } from '../shape/geometry.ts';
import { IN_FRAME, visibleAt, type MotionSeries, type PlacedSeries } from './series.ts';
import { T } from './thresholds.ts';

export type Channel = 'position' | 'rotation' | 'scale' | 'opacity' | 'particles' | 'pulse' | 'spring' | 'hold';

export interface Finding {
  readonly kind: MotionFindingKind;
  /** A node id, "(camera)", "(frame)" or "(frame:<region>)". */
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
}

/** What each kind of finding means and what usually fixes it. */
export const FINDING_KINDS: Readonly<Record<MotionFindingKind, { readonly means: string; readonly fix: string }>> = {
  jump: {
    means: 'a change between two frames that is out of line with the frames around it: a teleport or a pop',
    fix: 'look at the keys at that moment: two keys at once, a duration shorter than a frame, or a wrong target. To change place unseen, do it while the node is hidden (popOut, then popIn) or faded out',
  },
  'abrupt-start': {
    means: 'a move that is at full speed within two frames of rest',
    fix: 'give the move an ease-in: an overshoot or an anticipation above 0 (with both at 0 a moveTo, turnTo or scaleTo is a plain ease-out that starts at full speed), or a longer duration',
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

function finding(
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
  return { kind, subject, channel, from, to, value: round(value, 3), threshold, unit, severity: round(severity, 3), detail };
}

/** Steps of one channel: the change from frame f - 1 to frame f in px, as components and as a length. */
interface Chan {
  readonly name: 'position' | 'rotation' | 'scale';
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
}

/** A node's own motion as steps in screen px. */
function ownSteps(series: MotionSeries, s: PlacedSeries): Steps {
  const F = series.frames;
  const zoom = series.views[s.node.layer]!.zoom;
  const pos = chan('position', F);
  const rot = chan('rotation', F);
  const scl = chan('scale', F);
  const seen = new Uint8Array(F);
  const faintless = new Uint8Array(F);
  const inFrame = new Uint8Array(F);
  for (let f = 1; f < F; f++) {
    seen[f] = visibleAt(s, f - 1) && visibleAt(s, f) ? 1 : 0;
    faintless[f] = s.alpha[f - 1]! >= T.visibleAlpha || s.alpha[f]! >= T.visibleAlpha ? 1 : 0;
    inFrame[f] = ((s.flags[f - 1]! | s.flags[f]!) & IN_FRAME) !== 0 ? 1 : 0;
    const u = s.unit[f]!;
    pos.a[f] = (s.ownX[f]! - s.ownX[f - 1]!) * u;
    pos.b[f] = (s.ownY[f]! - s.ownY[f - 1]!) * u;
    pos.d[f] = Math.hypot(pos.a[f]!, pos.b[f]!);
    rot.a[f] = (s.ownRot[f]! - s.ownRot[f - 1]!) * DEG * s.turnRadius * s.scale[f]! * zoom[f]!;
    rot.d[f] = Math.abs(rot.a[f]!);
    scl.a[f] = (s.ownScale[f]! - s.ownScale[f - 1]!) * s.radius * u;
    scl.d[f] = Math.abs(scl.a[f]!);
  }
  return { seen, faintless, inFrame, channels: [pos, rot, scl] };
}

const CHANNEL_WORDS: Readonly<Record<Chan['name'], { readonly moved: string; readonly what: string }>> = {
  position: { moved: 'moved', what: 'position' },
  rotation: { moved: 'turned by', what: 'rotation (travel of its edge)' },
  scale: { moved: 'changed size by', what: 'scale (travel of its edge)' },
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

function abrupt(subject: string, ch: Chan, st: Steps, frames: number, onsets: ReadonlySet<number>, out: Finding[]): void {
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
    // A bump is a hit: its sudden start is the point.
    if (onsets.has(f)) continue;
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
    return (reach(node.shape, [lx, ly]) + reach(node.shape, [-lx, -ly])) * k;
  }
  if (node.type === 'eye') return 2 * node.r * k;
  if (node.type === 'label') {
    const box = labelLayout(series.shot, s.node, series.lang).geometry.box;
    return (Math.abs(box.w * ux) + Math.abs(box.h * uy)) * k;
  }
  return 2 * s.radius * k;
}

function tooFast(series: MotionSeries, s: PlacedSeries, out: Finding[]): void {
  const F = series.frames;
  const view = series.views[s.node.layer]!;
  const node = s.node.node;
  // Judged against what it is attached to: a part that rides on a moving thing
  // does not strobe by itself.
  const refIndex = node.type === 'label' ? s.node.targetIndex : s.node.parent;
  const ref = refIndex >= 0 ? series.placed[refIndex]! : null;
  // No direction of a shape is narrower than twice its inner radius: a cheap first test.
  const narrow = node.type === 'shape' ? 2 * shapeExtent(node.shape).inner : 0;
  let runStart = -1;
  let peak = 0;
  let peakSpeed = 0;
  const close = (endFrame: number): void => {
    if (runStart >= 0 && endFrame - runStart + 1 >= T.fastFrames) {
      out.push(
        finding('too-fast', s.id, 'position', runStart - 1, endFrame, peak, T.fastRatio, 'own size per frame',
          `travels up to ${peak.toFixed(2)} of its own size per frame (${peakSpeed.toFixed(1)} px per frame) for ${endFrame - runStart + 1} frames`),
      );
    }
    runStart = -1;
    peak = 0;
    peakSpeed = 0;
  };
  for (let f = 1; f < F; f++) {
    let ratio = 0;
    let step = 0;
    if (visibleAt(s, f - 1) && visibleAt(s, f) && (s.flags[f]! & IN_FRAME) !== 0) {
      let dx = s.x[f]! * view.zoom[f]! + view.tx[f]! - (s.x[f - 1]! * view.zoom[f - 1]! + view.tx[f - 1]!);
      let dy = s.y[f]! * view.zoom[f]! + view.ty[f]! - (s.y[f - 1]! * view.zoom[f - 1]! + view.ty[f - 1]!);
      if (ref) {
        dx -= ref.x[f]! * view.zoom[f]! + view.tx[f]! - (ref.x[f - 1]! * view.zoom[f - 1]! + view.tx[f - 1]!);
        dy -= ref.y[f]! * view.zoom[f]! + view.ty[f]! - (ref.y[f - 1]! * view.zoom[f - 1]! + view.ty[f - 1]!);
      }
      step = Math.hypot(dx, dy);
      const k = s.scale[f]! * view.zoom[f]!;
      if (step >= T.fastRatio * Math.max(narrow * k, 2 * T.minRadiusPx)) {
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
}

// --- Everything on placed nodes, links, emitters and the camera -----------------------------------

/** Jumps, abrupt starts and stops, mechanical moves and strobing speed of every node, link, emitter and the camera. */
export function detectMotion(series: MotionSeries): Finding[] {
  const c = series.shot;
  const F = series.frames;
  const out: Finding[] = [];

  for (const s of series.placed) {
    if (!s) continue;
    // A group with nothing in it is an anchor: it is never seen.
    if (s.type === 'group' && s.radius <= 0) continue;
    const st = ownSteps(series, s);
    const zoom = series.views[s.node.layer]!.zoom;
    const big = new Uint8Array(F);
    for (let f = 1; f < F; f++) {
      const r = s.radius * Math.max(s.scale[f - 1]!, s.scale[f]!) * zoom[f]!;
      big[f] = r >= T.minRadiusPx ? 1 : 0;
    }
    const mine: Finding[] = [];
    const [pos, rot, scl] = st.channels;

    // Jumps. Position and rotation need the node seen on both sides; size is
    // judged across a pop too, where the hidden side counts as size zero.
    const okSeen = new Uint8Array(F);
    const okSize = new Uint8Array(F);
    for (let f = 1; f < F; f++) {
      okSeen[f] = st.seen[f] && st.inFrame[f] && big[f] ? 1 : 0;
      okSize[f] = st.faintless[f] && st.inFrame[f] && big[f] ? 1 : 0;
    }
    jumps(s.id, pos, okSeen, F, mine);
    jumps(s.id, rot, okSeen, F, mine);
    jumps(s.id, scl, okSize, F, mine);
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

    if (!s.solver) {
      const onsets = bumpOnsets(c, s.node.index);
      const eased: Finding[] = [];
      const flat: Finding[] = [];
      for (const ch of st.channels) {
        abrupt(s.id, ch, st, F, onsets, eased);
        mechanical(s.id, ch, st, s, F, flat);
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

    if (s.type !== 'group' || s.node.parent < 0) tooFast(series, s, mine);
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
      // A zoom moves the edge of the frame by half the frame width times its change.
      scl.a[f] = (z - series.camera.zoom[f - 1]!) * (STAGE_W / 2);
      scl.d[f] = Math.abs(scl.a[f]!);
    }
    const st: Steps = { seen: all, faintless: all, inFrame: all, channels: [pos, chan('rotation', F), scl] };
    for (const ch of [pos, scl]) {
      jumps(CAMERA_SUBJECT, ch, all, F, out);
      abrupt(CAMERA_SUBJECT, ch, st, F, new Set(), out);
    }
  }

  return out;
}

/** The own speed of a node per frame in px, per channel: what the graphs plot. */
export function ownSpeeds(series: MotionSeries, s: PlacedSeries): { position: Float32Array; rotation: Float32Array; scale: Float32Array } {
  const st = ownSteps(series, s);
  return { position: st.channels[0].d, rotation: st.channels[1].d, scale: st.channels[2].d };
}
