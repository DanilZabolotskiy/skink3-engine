// A value that follows a computed function of time. The function is not kept:
// it is sampled when the key is made (drive in intents.ts), and the samples are
// played back here, so a driven node is plain data like everything else in a
// shot, and frame n stays a pure function of the shot.

export class DriveError extends Error {}

/** One drive key of one channel: `count` samples of `stride` numbers each, evenly spaced from `at` to `at + dur`. */
export interface DriveSeg {
  readonly at: number;
  readonly dur: number;
  readonly count: number;
  readonly data: readonly number[];
}

/** The samples of one channel of a node, key after key. */
export interface DriveTrack {
  /** Numbers per sample: 1 for an angle, a size, an opacity or a depth; 2 for a place; more for an outline. */
  readonly stride: number;
  readonly segs: readonly DriveSeg[];
}

/** The track of a channel from the keys that drive it. Keys of one channel may not overlap. */
export function buildDriveTrack(id: string, channel: string, stride: number, segs: readonly DriveSeg[]): DriveTrack {
  const sorted = segs.slice().sort((a, b) => a.at - b.at);
  let free = -Infinity;
  for (const s of sorted) {
    if (s.at < free - 1e-9) throw new DriveError(`drive("${id}") at ${s.at} s drives its ${channel} before the previous drive of it has ended (${free.toFixed(3)} s)`);
    if (s.data.length !== s.count * stride) throw new DriveError(`drive("${id}") at ${s.at} s: its ${channel} holds ${s.data.length} numbers, not ${s.count} samples of ${stride}`);
    free = s.at + s.dur;
  }
  return { stride, segs: sorted };
}

/**
 * The value of a driven channel at time t, or null before its first key:
 * exactly a sample at the moment of one, a smooth curve through the samples
 * between two, and the last sample of a key once it has ended.
 */
export function sampleDrive(track: DriveTrack, t: number): number[] | null {
  let seg: DriveSeg | null = null;
  for (const s of track.segs) {
    if (t >= s.at - 1e-9) seg = s;
    else break;
  }
  if (!seg) return null;
  const n = track.stride;
  const last = seg.count - 1;
  const u = Math.min(1, Math.max(0, (t - seg.at) / seg.dur)) * last;
  let i = Math.floor(u + 1e-7);
  if (i > last) i = last;
  const f = u - i;
  const out = new Array<number>(n);
  const d = seg.data;
  if (f <= 1e-7 || i >= last) {
    for (let k = 0; k < n; k++) out[k] = d[i * n + k]!;
    return out;
  }
  // Between two samples: the curve through the four around the moment.
  const i0 = Math.max(0, i - 1) * n;
  const i1 = i * n;
  const i2 = (i + 1) * n;
  const i3 = Math.min(last, i + 2) * n;
  const f2 = f * f;
  const f3 = f2 * f;
  for (let k = 0; k < n; k++) {
    const p0 = d[i0 + k]!;
    const p1 = d[i1 + k]!;
    const p2 = d[i2 + k]!;
    const p3 = d[i3 + k]!;
    out[k] = 0.5 * (2 * p1 + (p2 - p0) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (3 * p1 - p0 - 3 * p2 + p3) * f3);
  }
  return out;
}

/** A driven channel of one number at time t; `base` before its first key. */
export function sampleDriven(track: DriveTrack, t: number, base: number): number {
  const v = sampleDrive(track, t);
  return v ? v[0]! : base;
}
