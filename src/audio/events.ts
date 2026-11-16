// The events of a shot: what happens in it and when, as plain data. The sound
// track of a shot is built from this list (plan.ts, mix.ts); anything else
// that has to follow the action can read it too.
//
// Every key of the timeline is one event, or two when it has a start and an
// arrival that both matter (a hop takes off and lands, a link is drawn on and
// connects). Every recorded contact of the rigid bodies is an event, and so is
// every burst of an emitter. What has no moment of its own is not an event:
// the camera, springs, idle wander, particles in flight, an eye's own blinks.
//
// An event says what was seen of it: how large the thing is on screen, how fast
// it goes, where it is, and whether it is seen at all. Those are read from the
// motion series (review/series.ts), so "seen" means here what it means in the
// motion review. A move also says how it goes: its fastest moment, its two
// ends, the length of its way and the way itself, so that a sound can be
// fitted to it.

import { DEG } from '../core/math.ts';
import { FPS } from '../core/time.ts';
import { BUMP_SECONDS } from '../motion/curves.ts';
import { pathAt, pathTable } from '../motion/paths.ts';
import { sampleDrawn } from '../motion/tracks.ts';
import type { Bake } from '../physics/cache.ts';
import { DRAWN, IN_FRAME, sampleMotion, screenAt, type LinkSeries, type MotionSeries, type PlacedSeries } from '../review/series.ts';
import { T } from '../review/thresholds.ts';
import { BLINK, type CNode, type CompiledShot } from '../scene/compile.ts';
import { STAGE_H, STAGE_W } from '../scene/types.ts';

/**
 * Kinds of events.
 *
 *   appear, disappear   popIn and popOut of a shape, a group or an eye
 *   label               popIn of a label
 *   move                the start of a moveTo, the take-off of a hop, the start of a travel; it carries its motion
 *   land                the landing of a hop
 *   turn                turnTo
 *   grow, shrink        scaleTo, by whether the node gets larger or smaller
 *   fade                fadeTo
 *   level               levelTo
 *   bump, squash        bump and squash
 *   draw, connect       drawOn: the link starts to be drawn, and reaches its far node
 *   pulse               a pulse arrives at the far node of its link
 *   open, blink         openTo and blink (the ones the timeline asks for)
 *   contact             two rigid bodies hit each other
 *   burst               an emitter bursts: at a set time, or at a contact
 *   sfx                 a sound the scene placed by hand
 */
export const EVENT_KINDS = [
  'appear',
  'disappear',
  'label',
  'move',
  'land',
  'turn',
  'grow',
  'shrink',
  'fade',
  'level',
  'bump',
  'squash',
  'draw',
  'connect',
  'pulse',
  'open',
  'blink',
  'contact',
  'burst',
  'sfx',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export interface SceneEvent {
  /** Unique in the shot and the same from run to run: "<kind>:<node>@<frame>", with "#2", "#3" for more of the same. */
  readonly id: string;
  readonly kind: EventKind;
  /** The frame the moment falls on, and that frame in seconds (frame / 60). */
  readonly frame: number;
  readonly time: number;
  /** Seconds the action lasts from that moment; 0 for an instant: a landing, an arrival, a contact, a burst. */
  readonly dur: number;
  /**
   * Id of the node: the target of the intent, a body of the contact (a dynamic
   * and seen one first), the emitter of the burst, the node of a placed sound
   * (null when it has none).
   */
  readonly node: string | null;
  /** The sound key of that node, or null. */
  readonly key: string | null;
  /** What the scene asked for this event: false (silent) or the key of a sound. Left out when it asked for nothing. */
  readonly sound?: string | false;
  /** A placed sound: the gain the scene gave it. */
  readonly gain?: number;
  /** A contact, and a burst set off by one: the peak impulse. */
  readonly impulse?: number;
  /** A contact: the other body and its sound key. */
  readonly other?: string;
  readonly otherKey?: string | null;
  /** A burst: how many particles. */
  readonly count?: number;
  /**
   * A move (a moveTo, a travel, the take-off of a hop): its fastest moment.
   * The fastest frames of a move are those within a tenth of its highest speed on
   * screen, the camera left out. Among them the moment is the frame on which
   * the node is nearest the middle of the frame: a thing that crosses the
   * frame at one speed has its moment where it passes the middle, and a move
   * with one top of speed has it at that top. A move that goes nowhere has it
   * at its start.
   */
  readonly peakFrame?: number;
  readonly peakTime?: number;
  /** A move: where the node is on screen on its first and on its last frame, in px from the top-left corner. */
  readonly from?: readonly [number, number];
  readonly to?: readonly [number, number];
  /** A move: the length of its way on screen, in px, the camera left out. */
  readonly distance?: number;
  /** A move: where the node is on screen on every frame of it, from its first frame to its last. */
  readonly track?: readonly (readonly [number, number])[];
  /**
   * Largest size on screen during the action, in px of a 1080p frame: the
   * diameter of the circle that holds the node and what is in it; the length
   * of a link; for a burst the diameter of a disc as large as all its
   * particles together. 0 for a placed sound.
   */
  readonly size: number;
  /** Peak speed on screen during the action, in px per frame, the camera left out: of the node, of the end of a link that is drawn, of a pulse. */
  readonly speed: number;
  /** Where it is on screen at that moment, in px of a 1080p frame from the top-left corner. */
  readonly x: number;
  readonly y: number;
  /**
   * Whether it is seen at some frame of the action: drawn, at least 5 %
   * opaque, reaching into the frame, and not wholly behind a cover or outside
   * the shape it is clipped to. A placed sound counts as seen.
   */
  readonly seen: boolean;
}

export interface EventsOptions {
  /** Language of the labels (their size depends on the string); default: the first table. */
  readonly lang?: string;
  /** The motion series of the shot, when the caller has sampled it already. */
  readonly series?: MotionSeries;
}

type Draft = Omit<SceneEvent, 'id' | 'time'>;

/** Share of its highest speed within which a frame of a move is one of its fastest. */
export const PEAK_BAND = 0.1;

const round = (v: number): number => Math.round(v * 100) / 100;

/** The events of a shot, in order of time. A pure function of the shot and its bake. */
export function sceneEvents(c: CompiledShot, bake: Bake, opts: EventsOptions = {}): SceneEvent[] {
  const series = opts.series ?? sampleMotion(c, bake, { ...(opts.lang === undefined ? {} : { lang: opts.lang }), particles: false });
  const F = c.frames;
  const drafts: Draft[] = [];
  const frameOf = (seconds: number): number => Math.round(seconds * FPS);
  const inShot = (frame: number): boolean => frame >= 0 && frame < F;
  const clamp = (frame: number): number => Math.max(0, Math.min(F - 1, frame));
  const keyOf = (n: CNode): string | null => n.node.sound ?? null;
  const onScreen = (layer: number, x: number, y: number, frame: number): [number, number] => {
    const v = series.views[layer]!;
    return [x * v.zoom[frame]! + v.tx[frame]!, y * v.zoom[frame]! + v.ty[frame]!];
  };
  const links = new Map<number, LinkSeries>(series.links.map((l) => [l.node.index, l]));

  /** What is seen of a placed node between two frames: its largest size, its peak speed, and whether it shows at all. */
  const watch = (s: PlacedSeries, from: number, to: number, kind: EventKind): { size: number; speed: number; seen: boolean } => {
    const view = series.views[s.node.layer]!;
    let size = 0;
    let speed = 0;
    let seen = false;
    const f0 = clamp(from);
    for (let f = f0; f <= clamp(to); f++) {
      const zoom = view.zoom[f]!;
      size = Math.max(size, 2 * s.radius * s.scale[f]! * zoom);
      if (f > f0) {
        let step = Math.hypot(s.x[f]! - s.x[f - 1]!, s.y[f]! - s.y[f - 1]!);
        // A turn is the travel of the node's edge; a level, the travel of its surface.
        if (kind === 'turn') step = Math.max(step, Math.abs(s.rot[f]! - s.rot[f - 1]!) * DEG * s.turnRadius * s.scale[f]!);
        if (kind === 'level' && s.level) step = Math.max(step, Math.abs(s.level[f]! - s.level[f - 1]!));
        speed = Math.max(speed, step * zoom);
      }
      if ((s.flags[f]! & DRAWN) !== 0 && (s.flags[f]! & IN_FRAME) !== 0 && s.alpha[f]! >= T.visibleAlpha) seen = true;
    }
    return { size, speed, seen };
  };

  /** The same for a link: its length on screen, and whether any of it is drawn in the frame. */
  const watchLink = (l: LinkSeries, from: number, to: number): { size: number; seen: boolean } => {
    const view = series.views[l.node.layer]!;
    let size = 0;
    let seen = false;
    for (let f = clamp(from); f <= clamp(to); f++) {
      size = Math.max(size, 2 * l.half[f]! * view.zoom[f]!);
      if ((l.flags[f]! & DRAWN) !== 0 && (l.flags[f]! & IN_FRAME) !== 0 && l.presence[f]! > 0) seen = true;
    }
    return { size, seen };
  };

  /** How a move goes between its first and its last frame: its fastest moment, its ends, its way on screen. */
  const motionOf = (s: PlacedSeries, first: number, last: number): Pick<Draft, 'peakFrame' | 'peakTime' | 'from' | 'to' | 'distance' | 'track'> => {
    const view = series.views[s.node.layer]!;
    const track: [number, number][] = [];
    const speeds: number[] = [];
    let distance = 0;
    let top = 0;
    for (let f = first; f <= last; f++) {
      const [x, y] = screenAt(series, s, f);
      track.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
      // As in the speed of an event: the step of the node in its layer, as large as it is on screen, so the camera is left out.
      const step = f > first ? Math.hypot(s.x[f]! - s.x[f - 1]!, s.y[f]! - s.y[f - 1]!) * view.zoom[f]! : 0;
      speeds.push(step);
      distance += step;
      top = Math.max(top, step);
    }
    // Among its fastest frames, the one nearest the middle of the frame; the earlier of two that are as near.
    let peak = 0;
    if (top > 1e-9) {
      let nearest = Infinity;
      for (let i = 1; i < speeds.length; i++) {
        if (speeds[i]! < top * (1 - PEAK_BAND)) continue;
        const d = Math.hypot(track[i]![0] - STAGE_W / 2, track[i]![1] - STAGE_H / 2);
        if (d < nearest - 1e-6) {
          nearest = d;
          peak = i;
        }
      }
    }
    return { peakFrame: first + peak, peakTime: (first + peak) / FPS, from: track[0]!, to: track[track.length - 1]!, distance: round(distance), track };
  };

  /** An event of a node that has a place: from `start` (seconds), lasting `dur`; `back` frames before it are watched too. */
  const placed = (kind: EventKind, n: CNode, start: number, dur: number, asked: string | false | undefined, back = 0): void => {
    const frame = frameOf(start);
    if (!inShot(frame)) return;
    const s = series.placed[n.index]!;
    const seenOf = watch(s, frame - back, frameOf(start + dur), kind);
    const [x, y] = screenAt(series, s, frame);
    const motion = kind === 'move' ? motionOf(s, frame, clamp(frameOf(start + dur))) : {};
    drafts.push({ kind, frame, dur, node: n.id, key: keyOf(n), ...(asked === undefined ? {} : { sound: asked }), ...seenOf, x, y, ...motion });
  };

  /** An event of a link, at one of its two ends. */
  const linked = (kind: EventKind, n: CNode, start: number, dur: number, end: 'from' | 'to', span: number, asked: string | false | undefined, back = 0): void => {
    const frame = frameOf(start);
    if (!inShot(frame)) return;
    const l = links.get(n.index)!;
    const { size, seen } = watchLink(l, frame - back, frameOf(start + dur));
    const [x, y] = screenAt(series, series.placed[end === 'from' ? n.fromIndex : n.toIndex]!, frame);
    // The end of a line that is drawn on, and a pulse, cross the link in `span` seconds.
    const speed = span > 0 ? size / (span * FPS) : 0;
    drafts.push({ kind, frame, dur, node: n.id, key: keyOf(n), ...(asked === undefined ? {} : { sound: asked }), size, speed, x, y, seen });
  };

  /** An event of a stroke that is drawn on: at the end of what is drawn at that moment. `from` and `span`: the drawOn it belongs to. */
  const drawn = (kind: EventKind, n: CNode, start: number, dur: number, from: number, span: number, asked: string | false | undefined): void => {
    const frame = frameOf(start);
    if (!inShot(frame) || n.node.type !== 'stroke' || !n.stroke) return;
    const s = series.placed[n.index]!;
    const view = series.views[n.layer]!;
    const table = pathTable(n.node.path);
    const k = s.scale[frame]! * view.zoom[frame]!;
    // Where the line ends at that moment: a hair along it, so that the start of a drawing has a place too.
    const p = pathAt(table, Math.max(1e-6, sampleDrawn(n.stroke, frame / FPS) * table.length));
    const rot = s.rot[frame]! * DEG;
    const [x, y] = onScreen(n.layer, s.x[frame]! + (p.x * Math.cos(rot) - p.y * Math.sin(rot)) * s.scale[frame]!, s.y[frame]! + (p.x * Math.sin(rot) + p.y * Math.cos(rot)) * s.scale[frame]!, frame);
    // As for a link: its size is its length on screen, its speed that of the end that is drawn.
    const size = table.length * k;
    const grown = Math.abs(sampleDrawn(n.stroke, from + span) - sampleDrawn(n.stroke, from - 1e-6)) * size;
    let seen = false;
    for (let f = clamp(frame - (dur > 0 ? 0 : 2)); f <= clamp(frameOf(start + dur)); f++) {
      if ((s.flags[f]! & DRAWN) !== 0 && (s.flags[f]! & IN_FRAME) !== 0 && s.alpha[f]! >= T.visibleAlpha) seen = true;
    }
    drafts.push({ kind, frame, dur, node: n.id, key: keyOf(n), ...(asked === undefined ? {} : { sound: asked }), size, speed: span > 0 ? grown / (span * FPS) : 0, x, y, seen });
  };

  // 1. The timeline: every key is an event, or two.
  for (const key of c.spec.timeline) {
    if (key.kind === 'sfx') {
      const frame = frameOf(key.at);
      if (!inShot(frame)) continue;
      const from = key.target === null ? null : c.byId.get(key.target)!;
      const [x, y] = from ? screenAt(series, series.placed[from.index]!, frame) : [STAGE_W / 2, STAGE_H / 2];
      drafts.push({ kind: 'sfx', frame, dur: 0, node: key.target, key: from ? keyOf(from) : null, sound: key.sound, gain: key.gain, size: 0, speed: 0, x, y, seen: true });
      continue;
    }
    // The keys of the camera are no event, and neither is the running of a counter.
    if (key.kind === 'cameraTo' || key.kind === 'countTo') continue;
    const n = c.byId.get(key.target)!;
    // A muted intent is silent in all it does; a key it names is the sound of its start.
    const after = key.sound === false ? false : undefined;
    switch (key.kind) {
      case 'popIn':
        placed(n.node.type === 'label' || n.node.type === 'text' ? 'label' : 'appear', n, key.at, key.dur, key.sound);
        break;
      case 'popOut':
        placed('disappear', n, key.at, key.dur, key.sound);
        break;
      case 'moveTo':
      case 'travel':
        placed('move', n, key.at, key.dur, key.sound);
        break;
      case 'hop':
        placed('move', n, key.at, key.dur, key.sound);
        // The landing is judged on the last frames of the flight.
        placed('land', n, key.at + key.dur, 0, after, 2);
        break;
      case 'turnTo':
        placed('turn', n, key.at, key.dur, key.sound);
        break;
      case 'scaleTo': {
        // A scaleTo starts from the size the node has at that moment.
        if (key.axes) {
          // Along its axes: it grows when it covers more than before.
          const seg = n.axis?.segs.find((g) => g.at === key.at && g.to === key.axes);
          placed(key.axes[0] * key.axes[1] >= (seg ? seg.from[0] * seg.from[1] : 1) ? 'grow' : 'shrink', n, key.at, key.dur, key.sound);
          break;
        }
        const before = n.scale?.grows.find((g) => g.at === key.at && g.to === key.to)?.from ?? 1;
        placed(key.to >= before ? 'grow' : 'shrink', n, key.at, key.dur, key.sound);
        break;
      }
      case 'fadeTo':
        if (n.node.type === 'link') linked('fade', n, key.at, key.dur, 'from', 0, key.sound);
        else placed('fade', n, key.at, key.dur, key.sound);
        break;
      case 'levelTo':
        placed('level', n, key.at, key.dur, key.sound);
        break;
      case 'bump':
        placed('bump', n, key.at, BUMP_SECONDS, key.sound);
        break;
      case 'squash':
        placed('squash', n, key.at, key.dur, key.sound);
        break;
      case 'drawOn':
        if (n.node.type === 'stroke') {
          drawn('draw', n, key.at, key.dur, key.at, key.dur, key.sound);
          drawn('connect', n, key.at + key.dur, 0, key.at, key.dur, after);
          break;
        }
        linked('draw', n, key.at, key.dur, 'from', key.dur, key.sound);
        linked('connect', n, key.at + key.dur, 0, 'to', key.dur, after, 2);
        break;
      case 'pulse':
        linked('pulse', n, key.at + key.dur, 0, 'to', key.dur, key.sound, 2);
        break;
      case 'openTo':
        placed('open', n, key.at, key.dur, key.sound);
        break;
      case 'blink':
        placed('blink', n, key.at, BLINK.seconds, key.sound);
        break;
    }
  }

  // 2. Contacts of the rigid bodies, as the bake recorded them.
  const contacts = bake.header.events.filter((ev) => inShot(ev.frame));
  for (const ev of contacts) {
    const a = c.byId.get(ev.a);
    const b = c.byId.get(ev.b);
    if (!a || !b) continue;
    const seenOf = (n: CNode): { size: number; speed: number; seen: boolean } => watch(series.placed[n.index]!, ev.frame - 2, ev.frame, 'contact');
    // The event belongs to the body one would say made the sound: a dynamic one before a fixed one, a seen one before an unseen one.
    const rank = (n: CNode): number => (n.node.type === 'shape' && n.node.body?.kind === 'dynamic' ? 2 : 0) + (seenOf(n).seen ? 1 : 0);
    const [node, other] = rank(b) > rank(a) ? [b, a] : [a, b];
    const { size, speed, seen } = seenOf(node);
    const [x, y] = onScreen(node.layer, ev.x, ev.y, ev.frame);
    const inFrame = x >= 0 && x <= STAGE_W && y >= 0 && y <= STAGE_H;
    drafts.push({ kind: 'contact', frame: ev.frame, dur: 0, node: node.id, key: keyOf(node), impulse: ev.impulse, other: other.id, otherKey: keyOf(other), size, speed, x, y, seen: seen && inFrame });
  }

  // 3. Bursts of the emitters: at their set times, and where bodies hit.
  for (const index of c.emitters) {
    const n = c.nodes[index]!;
    const node = n.node;
    if (node.type !== 'emitter') continue;
    const burst = (frame: number, at: readonly [number, number], count: number, impulse?: number): void => {
      const [x, y] = onScreen(n.layer, at[0], at[1], frame);
      // As large as a disc that holds all its particles side by side.
      const size = 2 * node.size[1] * Math.sqrt(count) * series.views[n.layer]!.zoom[frame]!;
      const seen = x + size / 2 >= 0 && x - size / 2 <= STAGE_W && y + size / 2 >= 0 && y - size / 2 <= STAGE_H;
      drafts.push({ kind: 'burst', frame, dur: 0, node: n.id, key: keyOf(n), ...(impulse === undefined ? {} : { impulse }), count, size, speed: 0, x, y, seen });
    };
    for (const b of node.bursts) {
      const frame = frameOf(b.at);
      if (!inShot(frame)) continue;
      const ride = n.attachIndex >= 0 ? series.placed[n.attachIndex]! : null;
      burst(frame, ride ? [ride.x[frame]! + node.at[0], ride.y[frame]! + node.at[1]] : node.at, b.count);
    }
    if (node.onContact) {
      for (const ev of contacts) if (ev.impulse >= node.onContact.minImpulse) burst(ev.frame, [ev.x, ev.y], node.onContact.count, ev.impulse);
    }
  }

  // In order of time; what falls on one frame keeps the order it was found in.
  const sorted = drafts.map((d, order) => ({ d, order })).sort((p, q) => p.d.frame - q.d.frame || p.order - q.order);
  const seen = new Map<string, number>();
  return sorted.map(({ d }): SceneEvent => {
    const base = `${d.kind}:${d.node ?? d.sound}@${d.frame}`;
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    return {
      id: nth === 1 ? base : `${base}#${nth}`,
      kind: d.kind,
      frame: d.frame,
      time: d.frame / FPS,
      dur: d.dur,
      node: d.node,
      key: d.key,
      ...(d.sound === undefined ? {} : { sound: d.sound }),
      ...(d.gain === undefined ? {} : { gain: d.gain }),
      ...(d.impulse === undefined ? {} : { impulse: Math.round(d.impulse * 1000) / 1000 }),
      ...(d.other === undefined ? {} : { other: d.other, otherKey: d.otherKey ?? null }),
      ...(d.count === undefined ? {} : { count: d.count }),
      size: round(d.size),
      speed: round(d.speed),
      x: round(d.x),
      y: round(d.y),
      seen: d.seen,
      ...(d.peakFrame === undefined ? {} : { peakFrame: d.peakFrame, peakTime: d.peakTime!, from: d.from!, to: d.to!, distance: d.distance!, track: d.track! }),
    };
  });
}
