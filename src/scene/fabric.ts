// The fabric of a city on a map: its blocks as they are, irregular, with the streets between them, its open squares,
// its main streets and the sites of its landmarks kept clear, from outlines the scene gives (on the stage, as a map
// pipeline fits a city's blocks to it). It is drawn as a few flat fills of many outlines each (fillRings), a shadow
// and a lit rim from the same outlines shifted, so that a city of thousands of blocks costs a few paths a frame, and a
// layer that samples its backdrop keeps it as a picture while the camera holds. The colours are the scene's.

import type { Vec2 } from '../core/math.ts';
import { Rng } from '../core/rng.ts';
import type { ColorRef } from '../look/palette.ts';
import { REGION_MAX_FLAT_POINTS } from '../shape/geometry.ts';
import { checkKeys, fail, fillRings, group, num, stroke, vec } from './build.ts';
import { inside } from './map.ts';
import type { SceneNode } from './types.ts';

type Ring = readonly Vec2[];

export interface FabricOptions {
  id: string;
  /** The blocks of the city, closed outlines on the stage (as many as it has, each of any number of points). */
  blocks: readonly Ring[];
  /** The tone of the blocks, or a list of tones each block takes one of, drawn from the seed. */
  fills: ColorRef | readonly ColorRef[];
  /** The seed of the tones (0). */
  seed?: number | string;
  /** Open squares: closed outlines drawn over the blocks of their part in `square` (a square closed round by a block is no hole of it). */
  squares?: readonly Ring[];
  square?: ColorRef;
  /** The main streets: lines on the stage, each with its width in units, drawn over the blocks in `street`. */
  streets?: readonly { readonly line: readonly Vec2[]; readonly width: number }[];
  street?: ColorRef;
  /** Units of the frame: the least width of a main street on screen, at any zoom (as a stroke's `least`). */
  least?: number;
  /** Sites kept clear: a block whose middle lies inside one is left out (the place of a landmark drawn over the fabric). */
  clear?: readonly Ring[];
  /**
   * The shadow of the blocks: the same outlines under them, `lift` units (1.5) toward `dir` degrees (45: right and
   * down), in this colour (a dark tone of the ground: it is drawn whole, with no opacity of its own, which would cost a
   * picture). A block reads as raised from the ground.
   */
  shadow?: ColorRef;
  lift?: number;
  dir?: number;
  /** A lit rim: the same outlines shifted the other way, under the blocks, in this colour. */
  rim?: ColorRef;
  /**
   * The level of detail: `scale`, the pixels of a frame 1920 wide that a unit of the stage is drawn at in the nearest
   * view of the fabric (1); a block smaller there than a square `least` pixels across (1.5) is left out, and every outline is drawn
   * to within a third of a pixel. Merging the blocks across lanes too narrow to see is the map pipeline's.
   */
  detail?: { scale?: number; least?: number };
  /**
   * The part of the city a block belongs to, by its middle: the blocks of each part are a group of their own,
   * `<id>-<part>`, to fade or fill one part as one (a quarter that empties, a city that grows). Left out: one part,
   * `<id>-all`.
   */
  part?: (middle: Vec2) => string | number;
}

/** What a city's fabric comes to: its group, and the ids of the groups of its parts, in the order they are drawn. */
export interface Fabric {
  readonly node: SceneNode;
  readonly parts: readonly string[];
}

/** The area of a closed outline, signed: positive when it runs clockwise on the stage (y down). */
function area(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  return a / 2;
}

/** The middle of an outline: the mean of its points. */
function middleOf(ring: Ring): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}

/** An outline drawn to within `tol` units: the points that carry its form (Douglas-Peucker), at least three. */
function simplify(ring: Ring, tol: number): Vec2[] {
  const n = ring.length;
  if (n <= 3 || tol <= 0) return ring.map((p) => [p[0], p[1]]);
  // The two points farthest apart along x anchor the closed outline.
  let a = 0;
  let b = 0;
  for (let i = 1; i < n; i++) {
    if (ring[i]![0] < ring[a]![0]) a = i;
    if (ring[i]![0] > ring[b]![0]) b = i;
  }
  if (a === b) b = (a + Math.floor(n / 2)) % n;
  const keep = new Uint8Array(n);
  keep[a] = 1;
  keep[b] = 1;
  const span = (from: number, to: number): void => {
    // The points strictly between `from` and `to`, going forward round the outline.
    const stack: [number, number][] = [[from, to]];
    while (stack.length) {
      const [i, j] = stack.pop()!;
      const p = ring[i]!;
      const q = ring[j]!;
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const len = Math.hypot(dx, dy);
      let far = -1;
      let most = tol;
      for (let k = (i + 1) % n; k !== j; k = (k + 1) % n) {
        const r = ring[k]!;
        const d = len > 1e-12 ? Math.abs((r[0] - p[0]) * dy - (r[1] - p[1]) * dx) / len : Math.hypot(r[0] - p[0], r[1] - p[1]);
        if (d > most) {
          most = d;
          far = k;
        }
      }
      if (far >= 0) {
        keep[far] = 1;
        stack.push([i, far], [far, j]);
      }
    }
  };
  span(a, b);
  span(b, a);
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push([ring[i]![0], ring[i]![1]]);
  return out.length >= 3 ? out : ring.map((p) => [p[0], p[1]]);
}

/** Outlines as flat fills of at most REGION_MAX_FLAT_POINTS points each. */
function fills(id: string, outlines: readonly Ring[], fill: ColorRef, extra: { at?: Vec2 } = {}): SceneNode[] {
  const out: SceneNode[] = [];
  let batch: Ring[] = [];
  let count = 0;
  const flush = (): void => {
    if (batch.length === 0) return;
    out.push(fillRings({ id: `${id}${out.length === 0 ? '' : `-${out.length}`}`, rings: batch, fill, ...extra }));
    batch = [];
    count = 0;
  };
  for (const ring of outlines) {
    if (count + ring.length > REGION_MAX_FLAT_POINTS) flush();
    batch.push(ring);
    count += ring.length;
  }
  flush();
  return out;
}

/** A part's name as a piece of an id. */
function partId(where: string, value: unknown): string {
  if (!((typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)) || (typeof value === 'number' && Number.isInteger(value)))) {
    fail(where, `part must give a whole number or a name of letters, digits, - and _, got ${JSON.stringify(value)}`);
  }
  return String(value);
}

/**
 * The fabric of a city on a map, from its blocks (outlines on the stage): each block in one of `fills`, with the
 * streets between them left open, the squares and the main streets over them, the sites in `clear` left
 * free, an optional shadow and lit rim, and a level of detail fitted to the size it is seen at. It is a group `id` of
 * flat fills (a few paths however many blocks it has), the blocks of each part in a group of its own.
 */
export function fabric(o: FabricOptions): Fabric {
  const where = `fabric("${o?.id}")`;
  checkKeys(where, o, ['id', 'blocks', 'fills', 'seed', 'squares', 'square', 'streets', 'street', 'least', 'clear', 'shadow', 'lift', 'dir', 'rim', 'detail', 'part']);
  if (typeof o.id !== 'string' || o.id.length === 0) fail(where, 'id must be a name');
  if (!Array.isArray(o.blocks) || o.blocks.length === 0) fail(where, 'blocks must be a list of at least one outline, each a list of [x, y]');
  const tones = typeof o.fills === 'string' ? [o.fills] : Array.isArray(o.fills) && o.fills.length > 0 ? (o.fills as readonly ColorRef[]) : fail(where, 'fills must be a palette reference or a list of them');
  if (o.squares !== undefined && o.square === undefined) fail(where, 'squares are drawn in square: give its colour');
  if (o.streets !== undefined && o.street === undefined) fail(where, 'streets are drawn in street: give its colour');
  if (o.least !== undefined && o.streets === undefined) fail(where, 'least is the least width of the main streets on screen: give streets');
  if ((o.lift !== undefined || o.dir !== undefined) && o.shadow === undefined && o.rim === undefined) fail(where, 'lift and dir place the shadow and the rim: give shadow or rim');
  if (o.part !== undefined && typeof o.part !== 'function') fail(where, 'part must be a function of the middle of a block');
  if (o.detail !== undefined) checkKeys(`${where} detail`, o.detail, ['scale', 'least']);
  const scale = o.detail?.scale === undefined ? 1 : num(where, 'detail.scale', o.detail.scale, 1e-4, 1e4);
  const least = o.detail?.least === undefined ? 1.5 : num(where, 'detail.least', o.detail.least, 0, 1000);
  const lift = o.lift === undefined ? 1.5 : num(where, 'lift', o.lift, 0, 1000);
  const dir = ((o.dir === undefined ? 45 : num(where, 'dir', o.dir, -3600, 3600)) * Math.PI) / 180;
  const clear = (o.clear ?? []).map((ring, k) => ring.map((p, i) => vec(where, `clear[${k}][${i}]`, p)));
  const rng = new Rng(o.seed ?? 0, 'fabric');
  // The tones are drawn for every block given, kept or not, so a block keeps its tone whatever the detail.
  const tol = 1 / (3 * scale);
  const smallest = (least / scale) ** 2;
  const parts = new Map<string, Ring[][]>();
  o.blocks.forEach((block, k) => {
    if (!Array.isArray(block) || block.length < 3) fail(where, `blocks[${k}] must be a list of at least three points [x, y]`);
    const tone = Math.floor(rng.next() * tones.length);
    const ring = block.map((p, i) => vec(where, `blocks[${k}][${i}]`, p));
    const size = Math.abs(area(ring));
    if (size < smallest) return;
    const middle = middleOf(ring);
    if (clear.some((c) => inside(middle, c))) return;
    let drawn = simplify(ring, tol);
    // One way round for all: fills of one winding share their colour.
    if (area(drawn) < 0) drawn = drawn.reverse();
    const key = o.part ? partId(where, o.part(middle)) : 'all';
    let byTone = parts.get(key);
    if (!byTone) parts.set(key, (byTone = tones.map(() => [])));
    byTone[tone]!.push(drawn);
  });
  // The squares go with the part of their middle, drawn over its blocks: a part that fades takes its squares with it.
  const squaresOf = new Map<string, Ring[]>();
  (o.squares ?? []).forEach((ring, k) => {
    const pts = ring.map((p, i) => vec(where, `squares[${k}][${i}]`, p));
    if (pts.length < 3) fail(where, `squares[${k}] must be a list of at least three points [x, y]`);
    if (area(pts) < 0) pts.reverse();
    const key = o.part ? partId(where, o.part(middleOf(pts))) : 'all';
    if (!parts.has(key)) parts.set(key, tones.map(() => []));
    (squaresOf.get(key) ?? squaresOf.set(key, []).get(key)!).push(pts);
  });
  const children: SceneNode[] = [];
  const ids: string[] = [];
  for (const [key, byTone] of parts) {
    const all = byTone.flat();
    const id = `${o.id}-${key}`;
    const inner: SceneNode[] = [];
    // To a thousandth of a unit, and never -0.
    const [ux, uy] = [Math.round(Math.cos(dir) * lift * 1000) / 1000 + 0, Math.round(Math.sin(dir) * lift * 1000) / 1000 + 0];
    if (o.rim && all.length > 0) inner.push(...fills(`${id}-rim`, all, o.rim, { at: [-ux + 0, -uy + 0] }));
    if (o.shadow && all.length > 0) inner.push(...fills(`${id}-shadow`, all, o.shadow, { at: [ux, uy] }));
    byTone.forEach((list, t) => list.length > 0 && inner.push(...fills(`${id}-${t}`, list, tones[t]!)));
    const open = squaresOf.get(key);
    if (open) inner.push(...fills(`${id}-square`, open, o.square!));
    children.push(group({ id, children: inner }));
    ids.push(id);
  }
  if (o.streets && o.streets.length > 0) {
    children.push(group({
      id: `${o.id}-streets`,
      children: o.streets.map((s, k) => stroke({ id: `${o.id}-street${k}`, points: s.line, smooth: 0, curveSteps: 1, width: s.width, color: o.street!, ...(o.least === undefined ? {} : { least: o.least }) })),
    }));
  }
  if (ids.length === 0 && children.length === 0) fail(where, `no block is left: every block is smaller than ${least} px across at scale ${scale}, or lies in clear`);
  return { node: group({ id: o.id, children }), parts: ids };
}
