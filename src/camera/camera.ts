// Camera: a steady drift with a low-frequency wander, a slow push-in, and the
// view of each depth layer (parallax). Instead of the straight drift it can
// travel along a free-form path. Keys of the timeline can move it and zoom it
// at their moments, with the drift and the wander on top; zoom keys change its
// zoom alone, with the drift or the path running on under them. Everything is
// a closed-form function of the frame number, so the camera has no state to bake.

import { DEG, type Vec2 } from '../core/math.ts';
import type { Noise } from '../core/noise.ts';
import { FPS } from '../core/time.ts';
import { profileRamps, rampProgress, type MoveProfile } from '../motion/curves.ts';
import type { CameraToKey, ZoomToKey } from '../motion/intents.ts';
import { pathAt, pathTable } from '../motion/paths.ts';
import { STAGE_H, STAGE_W, type CameraPathSpec, type CameraSpec } from '../scene/types.ts';

export interface CameraState {
  /** Centre of the view in units of the focus plane. */
  readonly x: number;
  readonly y: number;
  /** The slow push-in of the shot. */
  readonly zoom: number;
  /** The zoom the camera keys and the zoom keys add, as a factor; left out in a shot without either. */
  readonly keyZoom?: number;
}

/** One camera key, with where the camera is when it starts. */
export interface CameraSeg {
  readonly at: number;
  readonly dur: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
  readonly zoomFrom: number;
  readonly zoomTo: number;
  /** Centre of the view, without the wander, when the key starts and when it ends. */
  readonly from: Vec2;
  readonly to: Vec2;
}

/** One zoom key, with the zoom the zoom keys give when it starts. */
export interface ZoomSeg {
  readonly at: number;
  readonly dur: number;
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
  readonly from: number;
  readonly to: number;
}

/** The keys of a shot that the camera reads, in order of time. */
export interface CameraTrack {
  /** The camera keys (cameraTo); none in a shot that has only zoom keys. */
  readonly segs: readonly CameraSeg[];
  /** The zoom keys (zoomTo). Left out in a shot without any. */
  readonly zooms?: readonly ZoomSeg[];
}

/** Where the drift, or the path, has carried the camera from its first place by a frame (which may fall between two frames). */
function carried(spec: CameraSpec, frame: number, frames: number): Vec2 {
  const path = spec.path ?? null;
  if (path) {
    const table = pathTable(path);
    const p = pathAt(table, cameraPathDistance(path, table.length, frame, frames));
    return [p.x - table.xs[0]!, p.y - table.ys[0]!];
  }
  const h = spec.drift.heading * DEG;
  const travel = spec.drift.speed * frame;
  return [Math.cos(h) * travel, Math.sin(h) * travel];
}

/** The first place of the camera: its `at`, or the first point of its path. */
function firstPlace(spec: CameraSpec): Vec2 {
  const path = spec.path ?? null;
  if (!path) return spec.at;
  const table = pathTable(path);
  return [table.xs[0]!, table.ys[0]!];
}

/**
 * What the keys make of the camera at a frame: the factor of its zoom, and the
 * centre of its view without the wander.
 *
 * Before the first key the camera is where its drift or its path has carried
 * it. During a key the zoom runs from one factor to the other at one apparent
 * speed (as a ratio), and the centre goes to its new place so that the place
 * it is heading for, or when it pulls back the place it leaves, crosses the
 * screen at one speed too: a push into a detail keeps the detail in view.
 * After a key the drift goes on from where the key ended, as large on screen
 * as ever, which is the smaller in units the more the camera has zoomed in.
 */
export function cameraKeyed(spec: CameraSpec, track: CameraTrack, frame: number, frames: number): { zoom: number; x: number; y: number } {
  const t = frame / FPS;
  let seg: CameraSeg | null = null;
  for (const s of track.segs) {
    if (t >= s.at) seg = s;
    else break;
  }
  if (!seg) {
    const o = firstPlace(spec);
    const b = carried(spec, frame, frames);
    return { zoom: 1, x: o[0] + b[0], y: o[1] + b[1] };
  }
  const u = (t - seg.at) / seg.dur;
  if (u >= 1) {
    const now = carried(spec, frame, frames);
    const then = carried(spec, (seg.at + seg.dur) * FPS, frames);
    return { zoom: seg.zoomTo, x: seg.to[0] + (now[0] - then[0]) / seg.zoomTo, y: seg.to[1] + (now[1] - then[1]) / seg.zoomTo };
  }
  const [a, b] = profileRamps(seg.profile, seg.ramp);
  const p = rampProgress(Math.max(0, u), a, b);
  const zoom = seg.zoomFrom * (seg.zoomTo / seg.zoomFrom) ** p;
  const dx = seg.to[0] - seg.from[0];
  const dy = seg.to[1] - seg.from[1];
  // Zooming in: the place ahead nears the middle of the frame at one speed on screen. Pulling back: the place behind leaves it so.
  const k = seg.zoomTo >= seg.zoomFrom ? 1 - ((1 - p) * seg.zoomFrom) / zoom : (p * seg.zoomTo) / zoom;
  return { zoom, x: seg.from[0] + dx * k, y: seg.from[1] + dy * k };
}

/**
 * The factor the zoom keys give at a moment: 1 before the first of them, then
 * from one factor to the next at one apparent speed (as a ratio) along the
 * profile of each key, and the factor of the last key from its end on. It says
 * nothing about where the camera looks: a zoom key leaves that alone.
 */
export function zoomKeyed(zooms: readonly ZoomSeg[], t: number): number {
  let seg: ZoomSeg | null = null;
  for (const s of zooms) {
    if (t >= s.at) seg = s;
    else break;
  }
  if (!seg) return 1;
  const u = (t - seg.at) / seg.dur;
  if (u >= 1) return seg.to;
  const [a, b] = profileRamps(seg.profile, seg.ramp);
  return seg.from * (seg.to / seg.from) ** rampProgress(Math.max(0, u), a, b);
}

/**
 * The track of the camera keys and of the zoom keys of a shot. Keys chain:
 * a camera key takes over from where the camera is at its moment, a zoom key
 * from the zoom the zoom keys have reached at its moment.
 */
export function buildCameraTrack(spec: CameraSpec, frames: number, keys: readonly CameraToKey[], zoomKeys: readonly ZoomToKey[] = []): CameraTrack {
  const segs: CameraSeg[] = [];
  for (const k of keys.slice().sort((p, q) => p.at - q.at)) {
    const now = cameraKeyed(spec, { segs }, k.at * FPS, frames);
    segs.push({ at: k.at, dur: k.dur, profile: k.profile, ramp: k.ramp, zoomFrom: now.zoom, zoomTo: k.zoom ?? now.zoom, from: [now.x, now.y], to: k.to ?? [now.x, now.y] });
  }
  // A shot without zoom keys has the track it always had.
  if (zoomKeys.length === 0) return { segs };
  const zooms: ZoomSeg[] = [];
  for (const k of zoomKeys.slice().sort((p, q) => p.at - q.at)) {
    zooms.push({ at: k.at, dur: k.dur, profile: k.profile, ramp: k.ramp, from: zoomKeyed(zooms, k.at), to: k.to });
  }
  return { segs, zooms };
}

/**
 * How far along its path the camera is at a frame, in units from the start.
 *
 * With a speed it travels at that speed for the whole shot: round and round a
 * closed path; on an open one to the end and back again, slowing into each
 * turn and out of it. Without a speed it covers the path once over the shot,
 * with the eased ends of its profile.
 */
export function cameraPathDistance(path: CameraPathSpec, length: number, frame: number, frames: number): number {
  if (path.speed === null) {
    const u = frames > 1 ? frame / (frames - 1) : 0;
    const [a, b] = profileRamps(path.profile, path.ramp);
    return rampProgress(u, a, b) * length;
  }
  const v = path.speed * FPS;
  if (path.closed || length <= 1e-9 || v <= 1e-9) return path.speed * frame;
  // An open path at a set speed: legs there and back. The camera slows to a
  // stop over half of `turn` seconds, turns round and takes the other half to
  // be back at speed. The first leg starts at speed.
  const t = frame / FPS;
  const half = Math.min(path.turn / 2, (0.4 * length) / v);
  const first = length / v + half / 2;
  if (t < first) return rampProgress(t / first, 0, half / first) * length;
  const leg = length / v + half;
  const k = Math.floor((t - first) / leg);
  const u = (t - first) / leg - k;
  const p = rampProgress(u, half / leg, half / leg) * length;
  // The leg after the first runs back to the start; the next one out again.
  return k % 2 === 0 ? length - p : p;
}

/**
 * The camera at a frame. `frames` is the length of the shot (the push-in spans
 * all of it). `track` holds the camera keys and the zoom keys of the shot, or
 * is null.
 *
 * A zoom key changes the zoom and nothing else: the centre of the view is, at
 * every frame, where it is in the same shot without its zoom keys.
 */
export function cameraAt(spec: CameraSpec, noise: Noise, frame: number, frames: number, track: CameraTrack | null = null): CameraState {
  const t = frame / FPS;
  const h = spec.drift.heading * DEG;
  const travel = spec.drift.speed * frame;
  // Two decorrelated noise lines; the vertical wander is smaller than the horizontal one.
  const wx = spec.drift.wander * noise.n1(t / spec.drift.period + 3.1);
  const wy = spec.drift.wander * 0.6 * noise.n1(t / spec.drift.period + 57.9);
  const u = frames > 1 ? frame / (frames - 1) : 0;
  // Exponential interpolation: the push-in has a constant apparent speed.
  const zoom = spec.pushIn.from * (spec.pushIn.to / spec.pushIn.from) ** u;
  // The zoom keys: a factor of the zoom, on top of whatever places the view.
  const lens = track?.zooms ? zoomKeyed(track.zooms, t) : null;
  if (track && track.segs.length > 0) {
    // Keyed: the keys place the view; the wander stays on top, as large on screen as ever.
    const k = cameraKeyed(spec, track, frame, frames);
    return { x: k.x + wx / k.zoom, y: k.y + wy / k.zoom, zoom, keyZoom: lens === null ? k.zoom : k.zoom * lens };
  }
  const keyZoom = lens === null ? {} : { keyZoom: lens };
  const path = spec.path ?? null;
  if (path) {
    // The path replaces the straight drift; the wander stays on top of it.
    const table = pathTable(path);
    const p = pathAt(table, cameraPathDistance(path, table.length, frame, frames));
    return { x: p.x + wx, y: p.y + wy, zoom, ...keyZoom };
  }
  return {
    x: spec.at[0] + Math.cos(h) * travel + wx,
    y: spec.at[1] + Math.sin(h) * travel + wy,
    zoom,
    ...keyZoom,
  };
}

/** How a layer is mapped to the stage: p_stage = p_layer * zoom + (tx, ty), origin at the top-left. */
export interface LayerView {
  readonly zoom: number;
  readonly tx: number;
  readonly ty: number;
}

/**
 * The view of a layer with the given parallax factor. A layer with parallax p
 * sees the camera move p times as far and zoom p times as much, which is what
 * separates the depth levels on screen. The zoom of the camera keys and of the
 * zoom keys, which may be far from 1, reaches a layer as its p-th power: a far
 * layer grows less, a near one more, and none turns inside out.
 */
export function layerView(camera: CameraState, parallax: number): LayerView {
  const push = Math.max(0.01, 1 + (camera.zoom - 1) * parallax);
  const zoom = camera.keyZoom === undefined ? push : push * camera.keyZoom ** parallax;
  return {
    zoom,
    tx: STAGE_W / 2 - camera.x * parallax * zoom,
    ty: STAGE_H / 2 - camera.y * parallax * zoom,
  };
}
