// Every threshold of the physics review, in one place, with the reason for its
// value. The detectors read numbers from `P` only; the report prints the table,
// and docs/PHYSICS-REVIEW.md describes it.
//
// Units: "px" is a pixel of a 1080p frame: a unit of the bodies' layer times
// the zoom of that layer at the frame. "units" are stage units, where a
// measure belongs to the simulation and not to the picture.
//
// The values were set on the engine's demo shot and on shots with piles of up
// to 540 bodies: they pass what a solver does on a sound shot (a contact that
// gives a little, a pile that takes an impact) and catch the planted defects
// of test/physics-review.test.ts.

import type { Threshold } from './thresholds.ts';

export const PHYSICS_THRESHOLDS = {
  // --- What is looked at at all ---------------------------------------------
  seenAlpha: {
    value: 0.05,
    unit: 'opacity',
    why: 'Below this opacity a body is too faint for a defect of it to be seen. What happens unseen is not reported; only broken numbers are, wherever they are.',
  },
  touchUnits: {
    value: 0.75,
    unit: 'units',
    why: 'Bodies whose surfaces are this near touch: the solver keeps resting contacts within a fraction of a unit. Touching bodies form one pile.',
  },

  // --- Overlap ---------------------------------------------------------------
  overlapPx: {
    value: 1.5,
    unit: 'px',
    why: 'Contacts are soft: a resting pile sinks into itself by a few tenths of a pixel, an impact by more for a frame or two. Past a pixel and a half an edge is seen to cut into its neighbour.',
  },
  overlapFrames: {
    value: 6,
    unit: 'frames',
    why: 'A tenth of a second. A shorter overlap of this depth is the give of an impact and reads as a squash.',
  },
  overlapDeepShare: {
    value: 0.25,
    unit: 'share of the smaller body',
    why: 'Sunk in by a quarter of the half-width of the smaller body, two shapes read as one inside the other, even for two frames.',
  },
  overlapDeepPx: {
    value: 4,
    unit: 'px',
    why: 'A deep overlap must still be large enough to see on small bodies.',
  },

  // --- Tunnelling --------------------------------------------------------------
  tunnelPx: {
    value: 2,
    unit: 'px',
    why: 'The straight line from where a body was outside a fixed body to where it is outside again must run at least this far inside it; less is a graze of a corner.',
  },

  // --- Escape ------------------------------------------------------------------
  escapePx: {
    value: 40,
    unit: 'px',
    why: 'A body this far below the lowest fixed body has nothing left to land on.',
  },

  // --- Rest, shared by jitter and unsettled piles -----------------------------------
  restPx: {
    value: 0.15,
    unit: 'px per frame',
    why: 'Slower than this, measured over half a second, a body reads as standing still (9 px per second). The same limit as in the motion review.',
  },
  restFrames: {
    value: 30,
    unit: 'frames',
    why: 'Half a second: the span over which the travel of a body is taken to tell rest from motion. A tremble has no travel over it; a slide has.',
  },

  // --- Jitter --------------------------------------------------------------------
  jitterPx: {
    value: 0.5,
    unit: 'px',
    why: 'A body that swings back and forth by half a pixel or more makes its edges shimmer; below that the anti-aliased edge hides it.',
  },
  jitterTurns: {
    value: 4,
    unit: 'reversals',
    why: 'A body that settles rocks back once or twice. Four reversals within the window is a tremble, not a settle.',
  },
  jitterFrames: {
    value: 30,
    unit: 'frames',
    why: 'Half a second: the window in which the reversals are counted. All of it must be calm: neither the body nor anything near it travels.',
  },
  jitterClear: {
    value: 6,
    unit: 'x its own radius',
    why: 'A pile rocks for a moment where a body lands or slides: nothing may travel within three body widths for a swing to count as a tremble.',
  },
  jitterStepPx: {
    value: 0.05,
    unit: 'px',
    why: 'A step smaller than this is the noise of 32-bit positions, not a move; it does not count as a reversal.',
  },

  // --- Piles that do not settle ----------------------------------------------------
  settleSeconds: {
    value: 2,
    unit: 's',
    why: 'Time a pile is given after the last body landed on it. The piles of the examples are at rest within a second and a half.',
  },

  // --- Energy spike ------------------------------------------------------------------
  spikePx: {
    value: 2,
    unit: 'px per frame',
    why: 'A gain of speed of 120 px per second that neither gravity nor anything touching the body can have given is a visible kick.',
  },
  spikeBounce: {
    value: 2,
    unit: 'x the speed of the fastest body in touch',
    why: 'The most a body can take from a hit: a light body struck by a heavy one leaves at twice the speed of the striker, if nothing is lost.',
  },

  // --- Hit by something that is not drawn ------------------------------------------------
  hitPx: {
    value: 2,
    unit: 'px per frame',
    why: 'A change of velocity of 120 px per second within a frame is a visible kink in the path of a body. When the only thing in touch is not drawn, it is a bounce off nothing.',
  },

  // --- Size of the printed report --------------------------------------------------------
  reportSubjects: {
    value: 12,
    unit: 'subjects',
    why: 'The text report shows the worst subjects; the JSON file holds everything.',
  },
  reportPerSubject: {
    value: 4,
    unit: 'findings',
    why: 'Findings shown per subject in the text report.',
  },
  checkWorst: {
    value: 5,
    unit: 'findings',
    why: 'Findings that `skink3 check` shows before it points to `skink3 physics`.',
  },
  pictureSubjects: {
    value: 3,
    unit: 'subjects',
    why: 'Pictures written by `skink3 physics --pictures`, unless a number is given.',
  },
} as const satisfies Record<string, Threshold>;

export type PhysicsThresholdName = keyof typeof PHYSICS_THRESHOLDS;

/** The plain numbers, for the detectors. */
export const P: Readonly<Record<PhysicsThresholdName, number>> = Object.fromEntries(
  Object.entries(PHYSICS_THRESHOLDS).map(([name, t]) => [name, t.value]),
) as Record<PhysicsThresholdName, number>;
