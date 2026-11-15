// Camera: a steady drift with a low-frequency wander, a slow push-in, and the
// view of each depth layer (parallax). Everything is a closed-form function of
// the frame number, so the camera has no state to bake.

import { DEG } from '../core/math.ts';
import type { Noise } from '../core/noise.ts';
import { FPS } from '../core/time.ts';
import { STAGE_H, STAGE_W, type CameraSpec } from '../scene/types.ts';

export interface CameraState {
  /** Centre of the view in units of the focus plane. */
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
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
