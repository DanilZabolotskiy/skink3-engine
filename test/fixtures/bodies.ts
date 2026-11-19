// What the tests of bodies share: a tiny shot with a still camera, the colour at a place of the stage, and the items
// of a frame. It holds no test of its own.

import { palette } from '../../examples/demo/palette.ts';
import { bakeShot, compileShot, evaluate, flatItems, frameRaw, heightFor, layer, shot, type Key, type LayerSpec, type LeafItem, type ShotSpec } from '../../src/index.ts';

export const WIDTH = 960;

export type Rgb = readonly [number, number, number];

/** A shot of one layer on a dark ground, with a still camera: a place of the stage is that place on screen, moved by half a frame. */
export function make(nodes: LayerSpec['nodes'], timeline: Key[] = [], extra: object = {}, seconds = 4): ShotSpec {
  return shot({
    id: 'tiny',
    seconds,
    seed: 3,
    palette,
    strings: { en: {} },
    background: { inner: 'deep.night', outer: 'deep.night' },
    atmosphere: 'mid.mist',
    vignette: 0,
    camera: { drift: { speed: 0, wander: 0 }, pushIn: { from: 1, to: 1 } },
    layers: [layer({ id: 'stage', depth: 0, tint: 0, nodes, ...extra })],
    timeline,
  });
}

/** The pixels of a frame, drawn on the processor. */
export async function draw(spec: ShotSpec, frame = 0): Promise<Buffer> {
  const c = compileShot(spec);
  return frameRaw(c, await bakeShot(c), frame, { width: WIDTH, lang: 'en', gpu: false });
}

/** The colour of drawn pixels at a place of the stage. */
export function at(raw: Uint8Array, x: number, y: number): Rgb {
  const k = WIDTH / 1920;
  const i = (Math.round(heightFor(WIDTH) / 2 + y * k) * WIDTH + Math.round(WIDTH / 2 + x * k)) * 4;
  return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
}

/** The colour at a place of the stage. */
export async function pixel(spec: ShotSpec, frame: number, x: number, y: number): Promise<Rgb> {
  return at(await draw(spec, frame), x, y);
}

/** The items of a frame, groups opened. */
export async function items(spec: ShotSpec, frame = 0): Promise<LeafItem[]> {
  const c = compileShot(spec);
  return flatItems(evaluate(c, await bakeShot(c), frame, 'en').layers[0]!.items);
}

/** How many pixels of two frames differ by more than `by` in a channel. */
export function differing(a: Uint8Array, b: Uint8Array, by = 0): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!)) > by) n++;
  }
  return n;
}

// The colours of the palette of the demo, as these tests tell them apart.
/** light.snow as it is. */
export const pale = (p: Rgb): boolean => p[0] > 225 && p[1] > 225 && p[2] > 225;
/** A shadow tone of light.snow: grey, darker than the fill and lighter than the ground. */
export const shade = (p: Rgb): boolean => p[0] > 50 && p[0] < 215 && Math.abs(p[0] - p[1]) < 25 && p[2] >= p[0];
/** accent.coral. */
export const red = (p: Rgb): boolean => p[0] > 200 && p[1] < 140 && p[2] < 140;
/** accent.aqua. */
export const aqua = (p: Rgb): boolean => p[0] < 120 && p[1] > 200 && p[2] > 180;
/** accent.amber. */
export const amber = (p: Rgb): boolean => p[0] > 220 && p[1] > 140 && p[1] < 210 && p[2] < 90;
/** The ground of the shot: deep.night. */
export const dark = (p: Rgb): boolean => p[0] < 50 && p[1] < 40;

/** Asserts that building a scene is refused with a message that says why. */
export function refused(run: () => unknown, message: RegExp): boolean {
  try {
    run();
  } catch (e) {
    return e instanceof Error && message.test(e.message);
  }
  return false;
}
