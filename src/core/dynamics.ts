// Second-order dynamics: a target is followed through a system described by
// three numbers an animator can reason about.
//
//   f  frequency in Hz: how fast the system reacts and how fast it oscillates;
//   z  damping: 0 rings forever, below 1 overshoots and settles, 1 and above never overshoots;
//   r  initial response: 0 starts gently, above 0 reacts at once, above 1 overshoots
//      the target at the start, below 0 anticipates (moves the other way first).
//
// The state has history, so it is always advanced at the fixed simulation step
// and stored by the bake; nothing reads it "live" at render time.

export interface SpringParams {
  readonly f: number;
  readonly z: number;
  readonly r: number;
}

export const SPRING_PRESETS = {
  /** Slow to start, no overshoot: large bodies. */
  heavy: { f: 1.1, z: 0.9, r: 0 },
  /** Quick and tidy with a small overshoot: small parts. */
  light: { f: 3.2, z: 0.55, r: 0.4 },
  /** Bounces a few times before it settles: antennae, tails. */
  springy: { f: 2.4, z: 0.26, r: 0 },
  /** Lags as if moving through honey, never overshoots. */
  viscous: { f: 0.8, z: 1.4, r: 0 },
} as const satisfies Record<string, SpringParams>;

export type SpringPreset = keyof typeof SPRING_PRESETS;
export type SpringSpec = SpringPreset | SpringParams;

export function springParams(spec: SpringSpec): SpringParams {
  if (typeof spec === 'string') {
    const preset = SPRING_PRESETS[spec];
    if (!preset) {
      throw new Error(`unknown spring preset "${spec}" (use one of: ${Object.keys(SPRING_PRESETS).join(', ')})`);
    }
    return preset;
  }
  if (!(spec.f > 0) || !(spec.z >= 0) || !Number.isFinite(spec.r)) {
    throw new Error(`invalid spring parameters ${JSON.stringify(spec)}: need f > 0, z >= 0, finite r`);
  }
  return spec;
}

/** One second-order system over a small vector (1 or 2 components in practice). */
export class SecondOrder {
  private readonly k1: number;
  private readonly k2: number;
  private readonly k3: number;
  private readonly y: Float64Array;
  private readonly yd: Float64Array;
  private readonly xp: Float64Array;

  constructor(params: SpringParams, x0: readonly number[]) {
    const { f, z, r } = params;
    this.k1 = z / (Math.PI * f);
    this.k2 = 1 / (2 * Math.PI * f) ** 2;
    this.k3 = (r * z) / (2 * Math.PI * f);
    this.y = Float64Array.from(x0);
    this.yd = new Float64Array(x0.length);
    this.xp = Float64Array.from(x0);
  }

  /** Advances by dt toward the target and returns the new value (a live view, copy to keep). */
  step(dt: number, target: readonly number[]): Float64Array {
    // Clamp k2 so that the semi-implicit Euler step stays stable at any dt.
    const k2 = Math.max(this.k2, (dt * dt) / 2 + (dt * this.k1) / 2, dt * this.k1);
    for (let i = 0; i < this.y.length; i++) {
      const x = target[i]!;
      const xd = (x - this.xp[i]!) / dt;
      this.xp[i] = x;
      const y = this.y[i]! + dt * this.yd[i]!;
      this.y[i] = y;
      this.yd[i] = this.yd[i]! + (dt * (x + this.k3 * xd - y - this.k1 * this.yd[i]!)) / k2;
    }
    return this.y;
  }

  get value(): Float64Array {
    return this.y;
  }
}

/** The farthest a swaying stick turns away from its rest direction, in radians (about 57 degrees). */
export const SWAY_MAX_LEAN = 1;

/**
 * The fastest the lean a swaying stick wants may change, in radians per second.
 * A parent that jumps, or reverses within a frame, asks for the new lean over a
 * few frames instead of at once, so the stick swings over and is not flicked.
 * An eased move asks for less than half of this.
 */
export const SWAY_MAX_RATE = 6;

/** Levels an angle off at SWAY_MAX_LEAN: unchanged while small, never beyond the limit. */
function levelOff(angle: number): number {
  return SWAY_MAX_LEAN * Math.tanh(angle / SWAY_MAX_LEAN);
}

/**
 * Where a swaying stick wants to lean: the angle (radians) by which its free
 * end trails when that end travels sideways at `lateralSpeed` (units per
 * second, positive toward a positive turn) on a lever of `lever` units.
 *
 * The free end trails by the distance it travels in 1 / (2 pi f) seconds, so a
 * softer spring leans more; the angle is that distance over the lever, levelled
 * off, so no motion of the parent, however sudden, asks for more than the
 * limit. The spring then follows this angle with its f, z and r.
 */
export function swayLean(params: SpringParams, lateralSpeed: number, lever: number): number {
  const trail = lateralSpeed / (2 * Math.PI * params.f);
  return 0 - levelOff(trail / Math.max(lever, 1e-6));
}

/**
 * The turn of a swaying stick for the state of its spring. The spring may pass
 * the lean it follows (that is its overshoot); levelling its state off keeps
 * the stick within SWAY_MAX_LEAN of its rest direction whatever f, z and r are.
 */
export function swayTurn(state: number): number {
  return levelOff(state);
}

/**
 * Closed-form step response of an underdamped spring that starts at 0 with zero
 * velocity and settles at 1, overshooting once by `overshoot` (0..0.5) at
 * `peakAt` (a fraction of the unit interval). The tail is windowed so that the
 * value is exactly 1 with zero velocity at u = 1. Pure, no state.
 */
export function overshootStep(u: number, overshoot: number, peakAt = 0.55): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (overshoot <= 1e-4) {
    // No overshoot wanted: a plain smooth ease-out.
    return 1 - (1 - u) ** 3;
  }
  const lo = Math.log(overshoot);
  const z = -lo / Math.sqrt(Math.PI * Math.PI + lo * lo);
  const wd = Math.PI / peakAt;
  const wn = wd / Math.sqrt(1 - z * z);
  const k = z * wn;
  const osc = Math.exp(-k * u) * (Math.cos(wd * u) + (k / wd) * Math.sin(wd * u));
  // Window: 1 until the peak, then eases to 0 at u = 1, removing the residual.
  const w = u <= peakAt ? 1 : 1 - ((u - peakAt) / (1 - peakAt)) ** 3;
  return 1 - osc * w;
}
