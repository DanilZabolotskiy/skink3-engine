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
// A path of ten segments or fewer the library keeps by its points, not by its object, so a copy alone does not part
// it from what was worked out for the same points in another frame. Of such paths it keeps the triangles of a curved
// fill that is not convex (the crescents of a small lit shape), worked out for the scale it was drawn at: a frame of
// another zoom drawn soon after came out with a few pixels of that edge otherwise than alone. Such a path is handed
// to the canvas, in every frame, as a copy of that frame's own with lines of no length at its last point, past ten
// segments: the library keeps it by the copy, new in every frame. The lines of no length change no pixel. Paths of
// the same points share one copy within a frame, as alone they share what the library keeps of them. A convex path,
// a path of straight lines only and a longer path are drawn as before.

import { Path2D } from 'skia-canvas';

/** The frame being drawn in this process: a count, one more for every frame. */
let drawing = 0;

/** Where each path drawn so far was last handed out: the frame, and the copy made for it (null: the path itself). */
const handed = new WeakMap<Path2D, { frame: number; copy: Path2D | null }>();

/** The most segments (verbs, its moves and closes among them) of a path the drawing library keeps by its points. */
export const KEPT_BY_POINTS = 10;

/** For each path seen: its points as a key when the library keeps it by them and works it out by the scale, else null. */
const byPoints = new WeakMap<Path2D, string | null>();

/** The copies of the frame being drawn of the paths kept by their points, one for the same points. */
let copies = new Map<string, Path2D>();

/** Starts a frame: a kept path drawn from now on is drawn as a copy of this frame's own. */
export function beginFrame(): void {
  drawing++;
  copies = new Map();
}

/**
 * Set only by the test that holds this to the GPU (test/frames-alone.test.ts): every path is drawn as itself, as before
 * this file, so that the test can show it still finds the frames that differ.
 */
const KEEP = process.env['SKINK3_TEST_KEEP_PATHS'] === '1';

/** One segment of a path as the library gives it: its verb, then its numbers. */
type Edge = readonly [string, ...number[]];

const CURVES: ReadonlySet<string> = new Set(['quadraticCurveTo', 'bezierCurveTo', 'conicCurveTo']);
const VERBS: ReadonlySet<string> = new Set(['moveTo', 'lineTo', 'closePath', ...CURVES]);

/**
 * Whether the library takes a path for convex: one contour whose points, its control points among them, turn one way,
 * once round. (Where the two might differ, a convex path is taken for one that is not and given lines of no length,
 * which change none of its pixels.)
 */
function convex(edges: readonly Edge[]): boolean {
  const pts: [number, number][] = [];
  for (const [verb, ...a] of edges) {
    if (verb === 'moveTo') {
      if (pts.length > 1) return false;
      pts.length = 0;
      pts.push([a[0]!, a[1]!]);
    } else if (verb !== 'closePath') {
      // The last number of a conic is its weight.
      const n = verb === 'conicCurveTo' ? 4 : a.length;
      for (let i = 0; i + 1 < n; i += 2) pts.push([a[i]!, a[i + 1]!]);
    }
  }
  const steps: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    if (q[0] !== p[0] || q[1] !== p[1]) steps.push([q[0] - p[0], q[1] - p[1]]);
  }
  let side = 0;
  let turned = 0;
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i]!;
    const b = steps[(i + 1) % steps.length]!;
    const cross = a[0] * b[1] - a[1] * b[0];
    if (cross !== 0) {
      if (side !== 0 && Math.sign(cross) !== side) return false;
      side = Math.sign(cross);
    }
    turned += Math.atan2(cross, a[0] * b[0] + a[1] * b[1]);
  }
  return Math.abs(turned) < 2 * Math.PI + 1e-3;
}

/** The key of a path the library keeps by its points and works out by the scale (see the head of this file), or null. */
function pointsKey(path: Path2D): string | null {
  let key = byPoints.get(path);
  if (key === undefined) {
    key = null;
    const edges = path.edges as unknown as readonly Edge[];
    if (
      edges.length <= KEPT_BY_POINTS &&
      edges.every(([verb]) => VERBS.has(verb)) &&
      edges.some(([verb]) => CURVES.has(verb)) &&
      !convex(edges)
    ) {
      key = JSON.stringify(edges);
    }
    byPoints.set(path, key);
  }
  return key;
}

/** A copy of a path past ten segments: the same segments, with lines of no length at its last point before its last close. */
function lengthened(path: Path2D): Path2D {
  const edges = path.edges as unknown as readonly Edge[];
  const copy = new Path2D();
  const more = KEPT_BY_POINTS + 1 - edges.length;
  const end = edges.length - 1;
  const closed = edges[end]![0] === 'closePath';
  let x = 0;
  let y = 0;
  edges.forEach(([verb, ...a], i) => {
    if (i === end && closed) for (let k = 0; k < more; k++) copy.lineTo(x, y);
    if (verb === 'moveTo') copy.moveTo(a[0]!, a[1]!);
    else if (verb === 'lineTo') copy.lineTo(a[0]!, a[1]!);
    else if (verb === 'quadraticCurveTo') copy.quadraticCurveTo(a[0]!, a[1]!, a[2]!, a[3]!);
    else if (verb === 'bezierCurveTo') copy.bezierCurveTo(a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!);
    else if (verb === 'conicCurveTo') copy.conicCurveTo(a[0]!, a[1]!, a[2]!, a[3]!, a[4]!);
    else copy.closePath();
    if (verb !== 'closePath') {
      const n = verb === 'conicCurveTo' ? 4 : a.length;
      x = a[n - 2]!;
      y = a[n - 1]!;
    }
  });
  if (!closed) for (let k = 0; k < more; k++) copy.lineTo(x, y);
  return copy;
}

/** The path to hand to a canvas for `path` in the frame being drawn (see the head of this file). */
export function framePath(path: Path2D): Path2D {
  if (KEEP) return path;
  const key = pointsKey(path);
  if (key !== null) {
    let copy = copies.get(key);
    if (!copy) {
      copy = lengthened(path);
      copies.set(key, copy);
    }
    return copy;
  }
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
