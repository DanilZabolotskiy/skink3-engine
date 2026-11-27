// Paths that are kept from one frame to the next are drawn as copies of the frame's own.
//
// The engine builds some paths once and keeps them: a shape's outline, the crescents and the highlight of its light,
// the outline of a line of text, the box of a label. A hit of those caches returns the same geometry a miss would
// build, but not to the GPU: the drawing library's GPU backend keeps what it works out for a path object and uses it
// again when the same object is drawn again, also in a later frame under another transform. A frame then came out
// with other pixels after other frames than alone, by a few levels along the edges of such a path (a lit shape turned
// on the stage, the camera moving): a render, a still of several frames and a still of one frame differed.
//
// So a kept path is handed to the canvas, in every frame after the first it was drawn in, as a copy made for that
// frame: the same geometry, new to the GPU, drawn as a path made in that frame is. Within a frame the copy is one,
// as the path was, so a frame draws exactly what it draws alone. A path made within the frame is drawn as itself.
//
// The library keeps a path of ten segments or fewer by its points, not by its object, so a copy does not part such a
// path from what was worked out for it in another frame; drawn soon after a frame of a much different zoom it may
// still differ by a few pixels of its edge (`RenderOptions.alone` waits that out).

import { Path2D } from 'skia-canvas';

/** The frame being drawn in this process: a count, one more for every frame. */
let drawing = 0;

/** Where each path drawn so far was last handed out: the frame, and the copy made for it (null: the path itself). */
const handed = new WeakMap<Path2D, { frame: number; copy: Path2D | null }>();

/** Starts a frame: a kept path drawn from now on is drawn as a copy of this frame's own. */
export function beginFrame(): void {
  drawing++;
}

/**
 * Set only by the test that holds this to the GPU (test/frames-alone.test.ts): every path is drawn as itself, as before
 * this file, so that the test can show it still finds the frames that differ.
 */
const KEEP = process.env['SKINK3_TEST_KEEP_PATHS'] === '1';

/** The path to hand to a canvas for `path` in the frame being drawn (see the head of this file). */
export function framePath(path: Path2D): Path2D {
  if (KEEP) return path;
  const was = handed.get(path);
  if (!was) {
    handed.set(path, { frame: drawing, copy: null });
    return path;
  }
  if (was.frame === drawing) return was.copy ?? path;
  const copy = new Path2D();
  copy.addPath(path);
  handed.set(path, { frame: drawing, copy });
  return copy;
}
