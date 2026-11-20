// Public API of skink3-engine.
//
// Scene authoring is the first block; a scene module needs nothing else. The
// rest is for tools that bake, evaluate, check and render shots themselves.
// See docs/SCENES.md.

// --- Scene authoring -------------------------------------------------------
export { shot, layer, circle, capsule, polygon, rect, blob, region, group, link, label, eye, emitter, stroke, text, intended } from './scene/build.ts';
export { SceneError, CAMERA_DEFAULTS, PHYSICS_DEFAULTS, type ShapeOptions } from './scene/build.ts';
export { moveTo, popIn, popOut, turnTo, scaleTo, fadeTo, bump, drawOn, pulse, openTo, blink, stagger } from './motion/intents.ts';
export { hop, travel, levelTo, squash, moveTimes, sfx, solidTo, cameraTo, zoomTo, countTo, bendTo, widthTo, riseTo, hazeTo, fillTo, backgroundTo, reshape } from './motion/intents.ts';
export { drive, perspectiveTo, type Driven, type DriveSamples } from './motion/intents.ts';
export { IntentError, type Key, type SfxKey, type StaggerOrder } from './motion/intents.ts';
export { MOVE_PROFILES, DEFAULT_RAMP, rampProgress, profilePeak, type MoveProfile, type SpeedKeys } from './motion/curves.ts';
export { arcPoints, loopPoints, pathLength, pathTable, pathAt, type PathSpec, type PathPoint } from './motion/paths.ts';
export { matchPoints, reachedAt } from './motion/match.ts';
export { definePalette, checkPalette, resolveColor, PaletteError, ROLES } from './look/palette.ts';
export type { ColorRef, HueBand, Palette, PaletteIssue, PaletteRule, PaletteSpec, PaletteTones, Role } from './look/palette.ts';
export { hsv, hexToHsv, lightness, mix } from './look/color.ts';
export type { LightFrom, LightSpec } from './look/light.ts';
export { SPRING_PRESETS, type SpringParams, type SpringPreset, type SpringSpec } from './core/dynamics.ts';
export type { StringTables } from './text/strings.ts';
export type {
  BackgroundSpec,
  BodySpec,
  CameraPathSpec,
  CameraSpec,
  ContrastSpec,
  LevelSpec,
  EmitterNode,
  EyeNode,
  GroupNode,
  HazeSpec,
  RoofSpec,
  RoofKind,
  OpeningsSpec,
  CastSpec,
  DetailSpec,
  IdleSpec,
  IntendedSpec,
  LabelNode,
  LabelSide,
  LayerSpec,
  LinkNode,
  FindingKind,
  MotionFindingKind,
  PhysicsFindingKind,
  PhysicsSpec,
  SceneNode,
  ShapeNode,
  ShotSpec,
  TurbulenceSpec,
} from './scene/types.ts';
export { STAGE_W, STAGE_H, MOTION_FINDING_KINDS, PHYSICS_FINDING_KINDS, CONTRAST_FINDING_KINDS, CAMERA_SUBJECT, FRAME_SUBJECT, FRAME_REGIONS } from './scene/types.ts';
export type { Vec2, Vec3 } from './core/math.ts';

// --- Core helpers a scene may use to generate content ----------------------
export { Rng } from './core/rng.ts';
export { Noise } from './core/noise.ts';
export { FPS, SIM_DT, SUBSTEPS, frameToSeconds, secondsToFrame } from './core/time.ts';
export { ease, EASINGS, type EaseName } from './core/easing.ts';

// --- Tools: compile, bake, evaluate, check, render -------------------------
export { compileShot, defaultTint, CompileError, type CompiledShot, type CNode, type CLayer } from './scene/compile.ts';
export { evaluate, computeWorld, flatItems, labelLayout, posesFromBake, type FrameState, type GroupItem, type Item, type LayerState, type LeafItem } from './scene/evaluate.ts';
export { levelGeometry, type CastItem, type CastShadow, type ClipItem, type LevelGeometry, type ShapeItem, type StretchItem, type StrokeItem, type Worth } from './scene/evaluate.ts';
export { drawOrder, newPlaces, seenThrough, type Places, type PlaneItem } from './scene/evaluate.ts';
export { eyeOf, perspAt, planeMap, planePoint, project, type Eye, type PerspSpec, type PlaneAxes, type PlaneMap } from './scene/space.ts';
export { bakeShot, ensureBake, bakeKey } from './physics/bake.ts';
export { Bake, bakeHash, readBake, writeBake, type BakeHeader, type ContactEvent } from './physics/cache.ts';
export { runChecks, formatReport, checkTextFit, checkGlyphs, type CheckReport, type CheckIssue, type CheckOptions, type GlyphIssue } from './checks/index.ts';
export { sampleMotion, type MotionSeries, type PlacedSeries, type EmitterSeries, type LinkSeries, type SpringSeries, type SampleOptions } from './review/series.ts';
export { reviewMotion, buildReport, formatMotionReport, formatMotionShort, motionReportJson, type MotionReport, type HonouredException } from './review/report.ts';
export { FINDING_KINDS, type Finding, type Channel } from './review/detect.ts';
export type { SpringReport, SpringResponse } from './review/springs.ts';
export { THRESHOLDS, type Threshold, type ThresholdName } from './review/thresholds.ts';
export { renderTrail, type TrailOptions, type TrailResult } from './review/trail.ts';
export { renderGraph, type GraphMark, type GraphOptions, type GraphResult } from './review/graph.ts';
export { motionPictures, type MotionPicture } from './review/pictures.ts';
export { reviewPhysics, PHYSICS_KINDS, type PhysicsReport, type PhysicsFinding, type HonouredPhysicsException } from './review/physics.ts';
export { formatPhysicsReport, formatPhysicsShort, physicsReportJson } from './review/physics-report.ts';
export { PHYSICS_THRESHOLDS, type PhysicsThresholdName } from './review/physics-thresholds.ts';
export { physicsPictures, renderCloseUp, type PhysicsPicture, type CloseUpOptions } from './review/physics-pictures.ts';
export { reviewContrast, formatContrastShort, colourDistance, type ContrastReport, type ContrastFinding } from './review/contrast.ts';
export { drawFrame, frameRaw, framePng, heightFor, rendererInfo, type RenderOptions } from './render/frame.ts';
export { renderSheet, rawToPng, type SheetOptions, type SheetTile } from './render/sheet.ts';
export { renderParallel, renderPlan, chunkFrames, type RenderJob, type RenderPlan, type RenderResult } from './render/parallel.ts';
export { acquireSlot, queueConfig, queueState, DEFAULT_SLOTS, type Priority, type QueueConfig, type QueueEntry, type Slot, type SlotRequest, type Waiting } from './render/queue.ts';
export { cameraAt, layerView, type CameraState, type LayerView } from './camera/camera.ts';
export { layoutText, measureText, type TextLayout, type TextStyle } from './text/layout.ts';
export { FONT_FAMILY, BUNDLED_FONTS, type BundledFont } from './text/fonts.ts';
export { fontOf, missingGlyphs } from './text/glyphs.ts';
export { cuesFromWords, formatSrt, formatVtt, formatYtt, shiftWords, wrapCue, type Cue, type CueOptions, type SpokenWord, type YttStyle } from './text/subtitles.ts';
export { sceneEvents, EVENT_KINDS, PEAK_BAND, type EventKind, type EventsOptions, type SceneEvent } from './audio/events.ts';
export { loadBank, parseBank, curveAt, BankError, SOUND_RULES, SOUND_CURVES, SOUND_ANCHORS, type BankSound, type Curve, type SoundAnchor, type SoundBank, type SoundCurves, type SoundOwnRules, type SoundRules } from './audio/bank.ts';
export { planSound, soundOf, density, showersOf, DROP_RULES, SHOWER_GAP, type DropRule, type Dropped, type PlanOptions, type Shower, type SoundPlan, type SoundSource, type Voice } from './audio/plan.ts';
export { renderSoundSheet, soundTiles, tileArrow, tileCaption, tileRing, SHEET_INK, type SoundSheetOptions, type SoundTile } from './audio/sheet.ts';
export { loadTakes, mixVoices, panAt, resample, takePeak, SAMPLE_RATE, SAMPLES_PER_FRAME, type Take, type Takes } from './audio/mix.ts';
export { renderSound, checkSound, soundReport, formatSoundReport, soundReportJson, TRACK_BITS, type SoundReport, type SoundTrack } from './audio/track.ts';
export { readWav, writeWav, WavError, type Wav } from './audio/wav.ts';
export { engineVersion, physicsVersion } from './version.ts';
export { loadShot } from './cli/load.ts';
