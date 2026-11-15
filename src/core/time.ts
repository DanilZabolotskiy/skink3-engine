// Time base. The engine renders at one frame rate only; the simulation runs at a
// fixed multiple of it, so that a bake never depends on how frames are requested.

/** Frames per second of every render. */
export const FPS = 60;

/** Simulation substeps per frame. */
export const SUBSTEPS = 4;

/** Fixed simulation timestep in seconds (1/240 s). */
export const SIM_DT = 1 / (FPS * SUBSTEPS);

export function frameToSeconds(frame: number): number {
  return frame / FPS;
}

/** The frame that shows the moment `seconds` (rounded to the nearest frame). */
export function secondsToFrame(seconds: number): number {
  return Math.round(seconds * FPS);
}

/** Number of frames of a shot of the given length. */
export function frameCount(seconds: number): number {
  return Math.max(1, Math.round(seconds * FPS));
}
