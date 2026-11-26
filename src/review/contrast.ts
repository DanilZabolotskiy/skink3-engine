// The contrast review: does a thing stand out from what lies behind it?
//
// It is off unless a shot asks for it (`contrast`), names the nodes to hold
// and gives the two thresholds, which are the production's: the engine has no
// colour rule of its own. Like the other reviews it draws nothing. It reads
// the display list of a frame: what is drawn, in which order, in which colour.
//
// A named node is probed along its outline (a line and a text: along
// themselves; the runs of a second ink, `runInk`, as a part of their own).
// At every probe the colour of the node is held against the colour of what
// a viewer sees next to it there: the topmost thing drawn at
// that place, or the background. The two blend when they differ by less than
// `lightness` in CIE L* and by less than `colour` in the a*b* plane of CIELAB
// (hue and saturation): either difference alone is enough to tell them apart.
// A node whose outline blends along `edge` of its length, for `seconds` or
// longer, is a finding.
//
// What it leaves out, to stay a matter of arithmetic: the light on a shape
// (its shadow and its rim), blur, glow and the lift of the background. It
// reads flat colours, as the palette and the depth of a layer give them.

import { xfApply, type Vec2 } from '../core/math.ts';
import { FPS } from '../core/time.ts';
import { atmosphereTone, hexToLab, mix } from '../look/color.ts';
import { pathAt, pathTable } from '../motion/paths.ts';
import type { Bake } from '../physics/cache.ts';
import type { CompiledShot } from '../scene/compile.ts';
import { evaluate, itemFill, itemPath, itemShape, stretchPoint, type FrameState, type Item, type LeafItem } from '../scene/evaluate.ts';
import { planePoint } from '../scene/space.ts';
import { STAGE_H, STAGE_W, type ContrastSpec, type IntendedSpec } from '../scene/types.ts';
import { containsPoint, transformOutline } from '../shape/geometry.ts';
import { languagesOf } from '../text/strings.ts';

/** Frames between two samples of the review: ten a second. */
export const CONTRAST_SAMPLE_EVERY = 6;
/** How far beside its outline a node is probed, in px of a 1080p frame. */
export const CONTRAST_PROBE_PX = 4;
/** Probes along the outline of a node. */
const PROBES = 24;
/** A thing covers what is behind it once it is at least this opaque. */
const COVER_ALPHA = 0.5;
/** A node is judged while at least this many of its probes are seen in the frame. */
const MIN_PROBES = 4;

export interface ContrastFinding {
  readonly kind: 'low-contrast';
  /** The node that blends. */
  readonly subject: string;
  /** What of it: its outline, the line itself (a stroke), its letters, or the letters of its runs in the second ink (runInk). */
  readonly part: 'outline' | 'line' | 'letters' | 'run';
  /** First and last frame of the finding. */
  readonly from: number;
  readonly to: number;
  /** The largest share of its probes that blend, and the share that makes a finding. */
  readonly value: number;
  readonly threshold: number;
  /** At its worst frame: what it blends into most (a node id, or "(background)"), and the two colours. */
  readonly against: string;
  readonly own: string;
  readonly behind: string;
  /** The differences of those two colours: in lightness (L*) and in colour (a*b*). */
  readonly lightness: number;
  readonly colour: number;
  readonly detail: string;
  readonly fix: string;
}

export interface ContrastReport {
  readonly version: 1;
  readonly shot: string;
  readonly frames: number;
  /** What the shot asked for. */
  readonly asked: ContrastSpec;
  /** The warnings, worst first. */
  readonly findings: readonly ContrastFinding[];
  /** Exceptions marked with intended() that covered at least one finding. */
  readonly honoured: readonly { readonly nodes: readonly string[]; readonly reason: string; readonly findings: readonly ContrastFinding[] }[];
  /** Exceptions that covered nothing. */
  readonly unused: readonly IntendedSpec[];
}

export const CONTRAST_FIX = 'change one of the two colours in the palette (or in the variant of this scene), move the node onto another ground, or put an outline or a glow of another colour round it; if it is meant to blend, mark it as intended';

interface Leaf {
  readonly order: number;
  readonly item: LeafItem;
  /** Where a point of its layer is on screen: through the squashes and stretches round it, and the view of the layer. */
  readonly place: (p: Vec2) => Vec2;
  /** How far its colours fade toward the atmosphere. */
  readonly tint: number;
  /** The outlines it is drawn inside, on screen: the shapes it is clipped to, and its own level when it has one. */
  readonly clips: readonly Vec2[][];
}

interface Surface {
  readonly leaf: Leaf;
  readonly poly: Vec2[];
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly color: string;
  readonly alpha: number;
}

const labs = new Map<string, { l: number; a: number; b: number }>();

function lab(hex: string): { l: number; a: number; b: number } {
  let v = labs.get(hex);
  if (!v) {
    v = hexToLab(hex);
    labs.set(hex, v);
  }
  return v;
}

/** How far two colours are apart: in lightness, and in colour at one lightness. */
export function colourDistance(a: string, b: string): { lightness: number; colour: number } {
  const p = lab(a);
  const q = lab(b);
  return { lightness: Math.abs(p.l - q.l), colour: Math.hypot(p.a - q.a, p.b - q.b) };
}

/** What one frame holds, in draw order, with what the review needs of each thing. */
function leavesOf(state: FrameState): Leaf[] {
  const out: Leaf[] = [];
  // Farthest layer first, as it is drawn.
  const layers = state.layers.map((layer, i) => ({ layer, i })).sort((a, b) => b.layer.layer.spec.depth - a.layer.layer.spec.depth || a.i - b.i);
  for (const { layer } of layers) {
    const view = layer.view;
    const screen = (p: Vec2): Vec2 => [p[0] * view.zoom + view.tx, p[1] * view.zoom + view.ty];
    const walk = (items: readonly Item[], clips: readonly Vec2[][], place: (p: Vec2) => Vec2): void => {
      for (const item of items) {
        if (item.kind === 'group') walk(item.items, clips, place);
        else if (item.kind === 'stretch') walk(item.items, clips, (p) => place(stretchPoint(item, p)));
        // What lies in a plane of a perspective layer: through the picture the camera has of that plane.
        else if (item.kind === 'plane') walk(item.items, clips, (p) => place(planePoint(item.map, p)));
        else if (item.kind === 'clip') {
          const outline = transformOutline(itemShape(item), (p) => place(xfApply(item.xf, p)));
          walk(item.items, item.level ? [...clips, outline, item.level.map((p) => place(p as Vec2))] : [...clips, outline], place);
        } else {
          // A content with a level is drawn below its surface only.
          const own = item.kind === 'shape' && item.level ? [...clips, item.level.map((p) => place(p as Vec2))] : clips;
          out.push({ order: out.length, item, place, tint: layer.layer.tint, clips: own });
        }
      }
    };
    walk(layer.items, [], screen);
  }
  return out;
}

/** The background of a frame at a place of the screen: its gradient, and the vignette over it. */
function backgroundAt(c: CompiledShot, state: FrameState, x: number, y: number): string {
  const bg = state.background ?? { inner: c.background.inner, outer: c.background.outer, center: c.spec.background.center, radius: c.spec.background.radius, vignette: c.spec.vignette };
  const t = Math.min(1, Math.hypot(x - bg.center[0] * STAGE_W, y - bg.center[1] * STAGE_H) / (bg.radius * STAGE_W));
  const sky = mix(bg.inner, bg.outer, t);
  if (bg.vignette <= 0) return sky;
  const half = Math.hypot(STAGE_W / 2, STAGE_H / 2);
  const g = Math.min(1, Math.max(0, (Math.hypot(x - STAGE_W / 2, y - STAGE_H / 2) / half - 0.45) / 0.55));
  return mix(sky, bg.outer, g * bg.vignette);
}

interface Probe {
  /** Where the neighbour of the node is read, on screen. */
  readonly at: Vec2;
  /** A place just inside the node, on screen: covered there, the probe is not seen. null: the place of the probe itself. */
  readonly inner: Vec2 | null;
}

/** One thing of a node that is held: a colour, and where it is probed. */
interface Held {
  readonly part: ContrastFinding['part'];
  readonly color: string;
  readonly probes: readonly Probe[];
  /** 'edge': the neighbour is whatever is seen beside the outline. 'on': it is what lies under the line or the letters. */
  readonly mode: 'edge' | 'on';
  /** Letters on a box of their own: the colour of that box, whatever else is in the frame. */
  readonly ground: string | null;
}

/** Probes just outside and just inside a closed outline given on screen. */
function edgeProbes(ring: readonly Vec2[], count: number): Probe[] {
  const out: Probe[] = [];
  const n = ring.length;
  // Which way it runs on screen (y down): its outside is to the left of a clockwise outline, to the right of the other.
  let area = 0;
  for (let i = 0; i < n; i++) area += ring[i]![0] * ring[(i + 1) % n]![1] - ring[(i + 1) % n]![0] * ring[i]![1];
  const side = area >= 0 ? 1 : -1;
  for (let k = 0; k < count; k++) {
    const i = Math.floor((k * n) / count);
    const p = ring[i]!;
    const a = ring[(i + n - 1) % n]!;
    const b = ring[(i + 1) % n]!;
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const len = Math.hypot(tx, ty);
    if (len < 1e-9) continue;
    const nx = (side * ty) / len;
    const ny = (-side * tx) / len;
    out.push({ at: [p[0] + nx * CONTRAST_PROBE_PX, p[1] + ny * CONTRAST_PROBE_PX], inner: [p[0] - nx * CONTRAST_PROBE_PX, p[1] - ny * CONTRAST_PROBE_PX] });
  }
  return out;
}

/** What is held of a node at a frame; empty when it has nothing to hold there. */
function heldOf(c: CompiledShot, state: FrameState, leaf: Leaf): Held[] {
  const { item, place: screen } = leaf;
  const atmosphere = state.background?.atmosphere ?? c.atmosphere;
  const tone = (hex: string): string => atmosphereTone(hex, atmosphere, leaf.tint);
  switch (item.kind) {
    case 'shape': {
      const shape = itemShape(item);
      const place = (p: Vec2): Vec2 => screen(xfApply(item.xf, p));
      let probes: Probe[];
      if (shape.kind === 'polygon' && shape.rings) {
        // Sample actual boundaries of a bounded set of contours; gaps between them have no edge.
        const count = Math.min(PROBES, shape.rings.length);
        probes = [];
        for (let i = 0; i < count; i++) {
          const ring = shape.rings[Math.floor(i * shape.rings.length / count)]!;
          probes.push(...edgeProbes(ring.map(place), Math.floor(PROBES / count)));
        }
      } else probes = edgeProbes(transformOutline(shape, place), PROBES);
      return [{ part: 'outline', color: tone(itemFill(item)), probes, mode: 'edge', ground: null }];
    }
    case 'stroke': {
      const probes: Probe[] = [];
      if (item.runs) {
        // A line on a globe: probes spread over the parts of it that face the viewer.
        const flat = item.runs.flatMap((run) => Array.from(run));
        const count = flat.length / 2;
        for (let k = 0; k < PROBES; k++) {
          const i = Math.min(count - 1, Math.floor(((k + 0.5) * count) / PROBES));
          probes.push({ at: screen(xfApply(item.xf, [flat[2 * i]!, flat[2 * i + 1]!])), inner: null });
        }
        return [{ part: 'line', color: tone(item.node.colors['color']!), probes, mode: 'on', ground: null }];
      }
      const table = pathTable(itemPath(item));
      const drawn = table.length * item.drawn;
      for (let k = 0; k < PROBES; k++) {
        const p = pathAt(table, (drawn * (k + 0.5)) / PROBES);
        probes.push({ at: screen(xfApply(item.xf, [p.x, p.y])), inner: null });
      }
      return [{ part: 'line', color: tone(item.node.colors['color']!), probes, mode: 'on', ground: null }];
    }
    case 'text': {
      const b = item.block.box;
      const probes: Probe[] = [];
      for (const fy of [0.3, 0.7]) for (let k = 0; k < PROBES / 2; k++) probes.push({ at: screen(xfApply(item.xf, [b.x + (b.w * (k + 0.5)) / (PROBES / 2), b.y + b.h * fy])), inner: null });
      const box = item.node.colors['box'];
      const letters: Held = { part: 'letters', color: tone(item.node.colors['ink']!), probes, mode: 'on', ground: box ? tone(box) : null };
      const runInk = item.node.colors['runInk'];
      if (!runInk) return [letters];
      // The runs are probed along themselves, half way up their letters.
      const runProbes: Probe[] = [];
      const spans = item.lines.flatMap((line) => (line.runs ?? []).map((span) => ({ line, span })));
      const each = Math.max(1, Math.ceil(PROBES / Math.max(1, spans.length)));
      for (const { line, span } of spans) {
        for (let k = 0; k < each; k++) {
          const x = line.x + span[0] + ((span[1] - span[0]) * (k + 0.5)) / each;
          runProbes.push({ at: screen(xfApply(item.xf, [x, line.y - item.layout.capHeight / 2])), inner: null });
        }
      }
      return [letters, { part: 'run', color: tone(runInk), probes: runProbes, mode: 'on', ground: letters.ground }];
    }
    case 'label': {
      const g = item.geometry.box;
      const corner = (fx: number, fy: number): Vec2 => screen([item.tip[0] + (g.x + g.w * fx) * item.scale, item.tip[1] + (g.y + g.h * fy) * item.scale]);
      // Its box as an outline, clockwise from the top left, a point every eighth of a side.
      const ring: Vec2[] = [];
      for (let k = 0; k < 8; k++) ring.push(corner(k / 8, 0));
      for (let k = 0; k < 8; k++) ring.push(corner(1, k / 8));
      for (let k = 0; k < 8; k++) ring.push(corner(1 - k / 8, 1));
      for (let k = 0; k < 8; k++) ring.push(corner(0, 1 - k / 8));
      const fill = tone(item.node.colors['fill']!);
      const held: Held[] = [
        { part: 'outline', color: fill, probes: edgeProbes(ring, PROBES), mode: 'edge', ground: null },
        { part: 'letters', color: tone(item.node.colors['ink']!), probes: [{ at: corner(0.5, 0.5), inner: null }], mode: 'on', ground: fill },
      ];
      // The letters of its runs lie on its box as well.
      const runInk = item.node.colors['runInk'];
      if (runInk) held.push({ part: 'run', color: tone(runInk), probes: [{ at: corner(0.5, 0.5), inner: null }], mode: 'on', ground: fill });
      return held;
    }
    default:
      return [];
  }
}

/** The surface a leaf is for what lies behind it or beside it, or null: a line, letters, particles and eyes are no ground for anything. */
function surfaceOf(c: CompiledShot, state: FrameState, leaf: Leaf): Surface | null {
  const { item, place: screen } = leaf;
  const atmosphere = state.background?.atmosphere ?? c.atmosphere;
  let poly: Vec2[];
  let color: string;
  let alpha: number;
  if (item.kind === 'shape') {
    poly = transformOutline(itemShape(item), (p) => screen(xfApply(item.xf, p)));
    color = itemFill(item);
    alpha = item.alpha;
  } else if (item.kind === 'label') {
    const g = item.geometry.box;
    poly = ([[g.x, g.y], [g.x + g.w, g.y], [g.x + g.w, g.y + g.h], [g.x, g.y + g.h]] as Vec2[]).map((p) => screen([item.tip[0] + p[0] * item.scale, item.tip[1] + p[1] * item.scale]));
    color = item.node.colors['fill']!;
    alpha = item.alpha;
  } else if (item.kind === 'text' && item.node.colors['box']) {
    const b = item.block.box;
    poly = ([[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]] as Vec2[]).map((p) => screen(xfApply(item.xf, p)));
    color = item.node.colors['box']!;
    alpha = item.alpha;
  } else return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  return { leaf, poly, x0, y0, x1, y1, color: atmosphereTone(color, atmosphere, leaf.tint), alpha };
}

/** A sample of one held thing at one frame. */
interface Sample {
  readonly frame: number;
  readonly share: number;
  readonly against: string;
  readonly own: string;
  readonly behind: string;
}

function covers(x: IntendedSpec, f: ContrastFinding): boolean {
  if (x.kind !== f.kind || !x.nodes.includes(f.subject)) return false;
  if (x.from !== null && f.to / FPS < x.from) return false;
  if (x.to !== null && f.from / FPS > x.to) return false;
  return true;
}

/**
 * The contrast review of a shot, or null when the shot does not ask for one.
 * A pure function of the shot and its bake.
 */
export function reviewContrast(c: CompiledShot, bake: Bake, opts: { lang?: string } = {}): ContrastReport | null {
  const asked = c.spec.contrast;
  if (!asked) return null;
  const lang = opts.lang ?? languagesOf(c.spec.strings)[0]!;
  const named = asked.nodes.map((id) => c.byId.get(id)!);
  const samples = new Map<string, Sample[]>();
  const blends = (own: string, behind: string): boolean => {
    const d = colourDistance(own, behind);
    return d.lightness < asked.lightness && d.colour < asked.colour;
  };

  for (let frame = 0; frame < c.frames; frame += CONTRAST_SAMPLE_EVERY) {
    const state = evaluate(c, bake, frame, lang);
    const leaves = leavesOf(state);
    let surfaces: Surface[] | null = null;
    const ground = (): Surface[] => (surfaces ??= leaves.map((leaf) => surfaceOf(c, state, leaf)).filter((s): s is Surface => s !== null && s.alpha >= COVER_ALPHA));
    const holds = (s: Surface, x: number, y: number): boolean =>
      x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1 && containsPoint(s.poly, x, y) && s.leaf.clips.every((clip) => containsPoint(clip, x, y));
    /** The topmost surface at a place among those the test lets through. */
    const topAt = (x: number, y: number, ok: (order: number) => boolean): Surface | null => {
      const list = ground();
      for (let i = list.length - 1; i >= 0; i--) if (ok(list[i]!.leaf.order) && holds(list[i]!, x, y)) return list[i]!;
      return null;
    };

    for (const n of named) {
      const leaf = leaves.find((l) => l.item.node === n);
      if (!leaf) continue;
      const alpha = 'alpha' in leaf.item ? leaf.item.alpha : 1;
      for (const held of heldOf(c, state, leaf)) {
        let judged = 0;
        let low = 0;
        const tally = new Map<string, { n: number; own: string; behind: string }>();
        for (const probe of held.probes) {
          const [x, y] = probe.at;
          if (x < 0 || x > STAGE_W || y < 0 || y > STAGE_H) continue;
          // Not seen there: something drawn after the node lies over it, or the node is cut away by its clip.
          const [ix, iy] = probe.inner ?? probe.at;
          if (topAt(ix, iy, (order) => order > leaf.order)) continue;
          if (!leaf.clips.every((clip) => containsPoint(clip, ix, iy))) continue;
          let behind: string;
          let id: string;
          if (held.ground !== null) {
            behind = held.ground;
            id = '(its own box)';
          } else {
            const s = topAt(x, y, held.mode === 'edge' ? (order) => order !== leaf.order : (order) => order < leaf.order);
            behind = s ? s.color : backgroundAt(c, state, x, y);
            id = s ? s.leaf.item.node.id : '(background)';
          }
          // A node that is not opaque shows what is behind it through itself.
          const own = alpha >= 0.999 ? held.color : mix(behind, held.color, alpha);
          judged++;
          if (!blends(own, behind)) continue;
          low++;
          const t = tally.get(id);
          if (t) t.n++;
          else tally.set(id, { n: 1, own, behind });
        }
        if (judged < Math.min(MIN_PROBES, held.probes.length)) continue;
        const key = `${n.id}\u0000${held.part}`;
        let most = { id: '', n: 0, own: held.color, behind: held.color };
        for (const [id, t] of tally) if (t.n > most.n) most = { id, ...t };
        const list = samples.get(key) ?? [];
        list.push({ frame, share: low / judged, against: most.id, own: most.own, behind: most.behind });
        samples.set(key, list);
      }
    }
  }

  // Runs of samples in which enough of the node blends, long enough to be seen.
  const all: ContrastFinding[] = [];
  const seconds = (frame: number): string => (frame / FPS).toFixed(2);
  for (const [key, list] of samples) {
    const [subject, part] = key.split('\u0000') as [string, ContrastFinding['part']];
    let run: Sample[] = [];
    const close = (): void => {
      if (run.length > 0) {
        const from = run[0]!.frame;
        const to = Math.min(c.frames - 1, run[run.length - 1]!.frame + CONTRAST_SAMPLE_EVERY - 1);
        if ((to - from + 1) / FPS >= asked.seconds) {
          const worst = run.reduce((a, s) => (s.share > a.share ? s : a));
          const d = colourDistance(worst.own, worst.behind);
          const what = part === 'outline' ? 'its outline' : part === 'line' ? 'the line' : part === 'run' ? 'the letters of its runs' : 'its letters';
          const where = worst.against === '(background)' ? 'the background' : worst.against === '(its own box)' ? 'its own box' : `"${worst.against}"`;
          all.push({
            kind: 'low-contrast',
            subject,
            part,
            from,
            to,
            value: Math.round(worst.share * 1000) / 1000,
            threshold: asked.edge,
            against: worst.against,
            own: worst.own,
            behind: worst.behind,
            lightness: Math.round(d.lightness * 10) / 10,
            colour: Math.round(d.colour * 10) / 10,
            detail:
              `${Math.round(worst.share * 100)} % of ${what} blends into ${where}: ${worst.own} on ${worst.behind} differ by ${d.lightness.toFixed(1)} in lightness (asked: ${asked.lightness}) ` +
              `and by ${d.colour.toFixed(1)} in colour (asked: ${asked.colour}), from ${seconds(from)} s to ${seconds(to)} s (worst at frame ${worst.frame})`,
            fix: CONTRAST_FIX,
          });
        }
      }
      run = [];
    };
    let last = -Infinity;
    for (const s of list) {
      // A sample that is missing (the node was not drawn, or not seen) ends a run, as one that stands out does.
      if (s.frame - last > CONTRAST_SAMPLE_EVERY || s.share < asked.edge) close();
      if (s.share >= asked.edge) run.push(s);
      last = s.frame;
    }
    close();
  }
  all.sort((a, b) => b.value - a.value || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0) || a.from - b.from);

  // Exceptions of this review's kind; those of the other reviews are theirs to honour.
  const intended = (c.spec.intended ?? []).filter((x) => x.kind === 'low-contrast');
  const taken: ContrastFinding[][] = intended.map(() => []);
  const findings: ContrastFinding[] = [];
  for (const f of all) {
    const i = intended.findIndex((x) => covers(x, f));
    if (i >= 0) taken[i]!.push(f);
    else findings.push(f);
  }
  const honoured: { nodes: readonly string[]; reason: string; findings: ContrastFinding[] }[] = [];
  const unused: IntendedSpec[] = [];
  intended.forEach((x, i) => {
    if (taken[i]!.length > 0) honoured.push({ nodes: x.nodes, reason: x.reason, findings: taken[i]! });
    else unused.push(x);
  });
  return { version: 1, shot: c.spec.id, frames: c.frames, asked, findings, honoured, unused };
}

/** The review for `skink3 check`: one line, and one for every finding. */
export function formatContrastShort(report: ContrastReport): string[] {
  const a = report.asked;
  const lines: string[] = [];
  const parts: string[] = [];
  if (report.honoured.length > 0) parts.push(`${report.honoured.length} honoured (${report.honoured.reduce((n, h) => n + h.findings.length, 0)} finding(s) left out)`);
  if (report.unused.length > 0) parts.push(`${report.unused.length} unused`);
  const ex = parts.length > 0 ? `; intended exceptions: ${parts.join(', ')}` : '';
  lines.push(`contrast: ${report.findings.length === 0 ? 'ok' : `${report.findings.length} warning(s)`} (${a.nodes.length} node(s) held: lightness ${a.lightness}, colour ${a.colour})${ex}`);
  const when = (f: ContrastFinding): string => `f${f.from}-${f.to}`;
  for (const f of report.findings) lines.push(`  ~ warning: low-contrast on "${f.subject}" at ${when(f)}: ${f.detail}`);
  for (const u of report.unused) lines.push(`  ~ intended, unused: low-contrast on ${u.nodes.join(', ')}: "${u.reason}" matches no finding; remove it, or check the node`);
  if (report.findings.length > 0) lines.push(`  usual fix: ${CONTRAST_FIX}`);
  return lines;
}
