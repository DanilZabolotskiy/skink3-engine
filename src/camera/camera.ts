// Camera: a steady drift with a low-frequency wander, a slow push-in, and the
// view of each depth layer (parallax). Instead of the straight drift it can
// travel along a free-form path. Everything is a closed-form function of the
// frame number, so the camera has no state to bake.

import { DEG } from '../core/math.ts';
import type { Noise } from '../core/noise.ts';
import { FPS } from '../core/time.ts';
import { profileRamps, rampProgress } from '../motion/curves.ts';
import { pathAt, pathTable } from '../motion/paths.ts';
import { STAGE_H, STAGE_W, type CameraPathSpec, type CameraSpec } from '../scene/types.ts';

export interface CameraState {
  /** Centre of the view in units of the focus plane. */
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
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

/** The camera at a frame. `frames` is the length of the shot (the push-in spans all of it). */
export function cameraAt(spec: CameraSpec, noise: Noise, frame: number, frames: number): CameraState {
  const t = frame / FPS;
  const h = spec.drift.heading * DEG;
  const travel = spec.drift.speed * frame;
  // Two decorrelated noise lines; the vertical wander is smaller than the horizontal one.
  const wx = spec.drift.wander * noise.n1(t / spec.drift.period + 3.1);
  const wy = spec.drift.wander * 0.6 * noise.n1(t / spec.drift.period + 57.9);
  const u = frames > 1 ? frame / (frames - 1) : 0;
  // Exponential interpolation: the push-in has a constant apparent speed.
  const zoom = spec.pushIn.from * (spec.pushIn.to / spec.pushIn.from) ** u;
  const path = spec.path ?? null;
  if (path) {
    // The path replaces the straight drift; the wander stays on top of it.
    const table = pathTable(path);
    const p = pathAt(table, cameraPathDistance(path, table.length, frame, frames));
    return { x: p.x + wx, y: p.y + wy, zoom };
  }
  return {
    x: spec.at[0] + Math.cos(h) * travel + wx,
    y: spec.at[1] + Math.sin(h) * travel + wy,
    zoom,
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
 * separates the depth levels on screen.
 */
export function layerView(camera: CameraState, parallax: number): LayerView {
  const zoom = Math.max(0.01, 1 + (camera.zoom - 1) * parallax);
  return {
    zoom,
    tx: STAGE_W / 2 - camera.x * parallax * zoom,
    ty: STAGE_H / 2 - camera.y * parallax * zoom,
  };
}
