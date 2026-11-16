// Every threshold of the motion review, in one place, with the reason for its
// value. The detectors read numbers from `T` only; the report prints the table,
// and docs/MOTION-REVIEW.md describes it.
//
// Units: "px" is a pixel of a 1080p frame. A node's own motion is measured in
// the space of its parent with the camera frozen and scaled to the screen, so
// it is in the same pixels as the picture but holds no camera motion and no
// motion of the parent. Rotation and scale are measured as the travel of the
// node's edge in px.
//
// The values are first settings, chosen from the engine's own curves and from
// the look of the examples. They are not yet calibrated against measurements
// of reference videos.

export interface Threshold {
  readonly value: number;
  readonly unit: string;
  readonly why: string;
}

export const THRESHOLDS = {
  // --- What is looked at at all ---------------------------------------------
  visibleAlpha: {
    value: 0.05,
    unit: 'opacity',
    why: 'Below this opacity a node is too faint for a defect in its motion to be seen.',
  },
  minRadiusPx: {
    value: 2,
    unit: 'px',
    why: 'A node smaller than this on screen is a dot; its motion is not judged.',
  },
  coverAlpha: {
    value: 0.95,
    unit: 'opacity',
    why: 'A cover hides what is behind it from the review only while it is nearly opaque; through a fainter one a thing is still seen.',
  },

  // --- Jump -------------------------------------------------------------------
  jumpPx: {
    value: 4,
    unit: 'px in one frame',
    why: 'A displacement of one frame below this reads as part of the motion, not as a tick.',
  },
  jumpRatio: {
    value: 4,
    unit: 'x the steps around it',
    why: 'A smooth curve sampled at 60 fps changes its step by a few percent per frame, and the hardest legitimate start (a bump) by a factor below 2; four times the largest step of the two frames on either side is out of line.',
  },
  jumpOpacity: {
    value: 0.34,
    unit: 'opacity in one frame',
    why: 'A third of full opacity in one frame is a pop: an eased fade has to be shorter than 5 frames to do that.',
  },

  // --- Abrupt start and stop ---------------------------------------------------
  restPx: {
    value: 0.15,
    unit: 'px per frame',
    why: 'Slower than this a node reads as standing still (9 px per second).',
  },
  restShare: {
    value: 0.15,
    unit: 'share of the speed reached',
    why: 'A node that idles a little is still at rest compared with the move it starts or ends.',
  },
  abruptPeakShare: {
    value: 0.9,
    unit: 'share of the peak speed',
    why: "A move is abrupt when two frames after rest it is already at its peak speed, or two frames before rest it still is. The engine's eased curves reach 2 to 84 % in two frames, down to an 18-frame pop; a linear move or an ease-out reaches 100 %.",
  },
  abruptMinPx: {
    value: 3,
    unit: 'px per frame',
    why: 'A start or stop at less than this speed (180 px per second) is too gentle to read as a jolt.',
  },
  kickFrames: {
    value: 20,
    unit: 'frames',
    why: 'A kick is a sudden excursion that comes back: a bump, a hit. Its swell and return take under a third of a second.',
  },
  kickReturn: {
    value: 0.5,
    unit: 'share of the excursion',
    why: 'A sudden start that comes back by at least half within the kick window is a reaction, not a move.',
  },

  // --- Mechanical move ---------------------------------------------------------
  mechTolerance: {
    value: 0.1,
    unit: 'share of the speed',
    why: 'Speed within 10 % of the middle of a stretch counts as constant.',
  },
  mechMinFrames: {
    value: 10,
    unit: 'frames',
    why: 'A shorter stretch of constant speed cannot be told from the middle of a quick ease.',
  },
  mechMinPx: {
    value: 24,
    unit: 'px',
    why: 'A move shorter than this is too small for its speed profile to be read.',
  },
  mechMinSpeedPx: {
    value: 0.5,
    unit: 'px per frame',
    why: 'Slower than this a constant speed reads as a drift, which is legitimate.',
  },
  mechShare: {
    value: 0.7,
    unit: 'share of the move',
    why: 'Constant speed over most of a move between two rests is what reads as mechanical; the top of an eased move stays in that band for about a third of the move.',
  },

  // --- Too fast to read ----------------------------------------------------------
  fastRatio: {
    value: 0.5,
    unit: 'own size per frame',
    why: 'There is no motion blur. At half of its own size per frame, measured along the motion, successive images overlap by half and the motion starts to strobe; at 1 they separate.',
  },
  fastMinPx: {
    value: 6,
    unit: 'px per frame',
    why: 'Below this travel per frame (360 px per second) successive images lie too close together to come apart, however small the thing is.',
  },
  fastFrames: {
    value: 6,
    unit: 'frames',
    why: 'Sustained: a tenth of a second. A single fast frame is part of an impact or a pop.',
  },
  fastParticleShare: {
    value: 0.5,
    unit: 'share of the particles in frame',
    why: 'An emitter is flagged when most of its visible particles strobe, not for a few fast ones.',
  },
  fastMinParticles: {
    value: 4,
    unit: 'particles',
    why: 'Fewer particles than this are not a stream to judge.',
  },

  // --- Springs ---------------------------------------------------------------------
  springMinResponsePx: {
    value: 4,
    unit: 'px',
    why: 'A deviation from the rest place smaller than this is idle wobble, not a response to report.',
  },
  springVisiblePx: {
    value: 1,
    unit: 'px',
    why: 'A swing smaller than a pixel is not seen.',
  },
  springSettlePx: {
    value: 0.5,
    unit: 'px',
    why: 'Within half a pixel of its rest place a spring has settled.',
  },
  springRingSeconds: {
    value: 2.5,
    unit: 's',
    why: 'The bounciest preset swings visibly for about a second after a large move; a spring still swinging after 2.5 s holds the eye long after the action.',
  },
  springBouncyDamping: {
    value: 0.4,
    unit: 'damping z',
    why: 'A spring damped this lightly is there to bounce (the springy preset is 0.26, the tidy one 0.55).',
  },
  springClearResponsePx: {
    value: 10,
    unit: 'px',
    why: 'A bouncy spring that lagged this far and then never passed its rest place by a visible amount does not read as a spring.',
  },

  // --- Dead areas ---------------------------------------------------------------------
  alivePx: {
    value: 0.1,
    unit: 'px per frame',
    why: 'Motion of its own slower than 6 px per second does not make a thing look alive. Camera motion is not counted.',
  },
  aliveOpacity: {
    value: 0.004,
    unit: 'opacity per frame',
    why: 'A fade slower than full range in four seconds does not read as change.',
  },
  aliveBackground: {
    value: 0.0005,
    unit: 'share of the range per frame',
    why: 'The colours of a background lie close together, so its change is small in numbers: a sky that turns by an eighth of the range of a channel in four seconds still reads as change; slower than that it is a hold.',
  },
  holdSeconds: {
    value: 4,
    unit: 's',
    why: 'Measured on reference videos: the longest hold of the whole frame is about 4 seconds.',
  },
  regionHoldSeconds: {
    value: 6,
    unit: 's',
    why: 'A sixth of the frame may rest longer than the whole frame, but not for most of a shot.',
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
    why: 'Findings that `skink3 check` shows before it points to `skink3 motion`.',
  },
  pictureSubjects: {
    value: 3,
    unit: 'subjects',
    why: 'Trails and graphs written by `skink3 motion --pictures`, unless a number is given.',
  },
} as const satisfies Record<string, Threshold>;

export type ThresholdName = keyof typeof THRESHOLDS;

/** The plain numbers, for the detectors. */
export const T: Readonly<Record<ThresholdName, number>> = Object.fromEntries(
  Object.entries(THRESHOLDS).map(([name, t]) => [name, t.value]),
) as Record<ThresholdName, number>;
