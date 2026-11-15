// Public API of skink3-engine.
//
// Scene authoring is the first block; a scene module needs nothing else. The
// rest is for tools that bake, evaluate, check and render shots themselves.
// See docs/SCENES.md.

// --- Scene authoring -------------------------------------------------------
export { shot, layer, circle, capsule, polygon, rect, blob, group, link, label, eye, emitter } from './scene/build.ts';
export { SceneError, CAMERA_DEFAULTS, PHYSICS_DEFAULTS, type ShapeOptions } from './scene/build.ts';
export { moveTo, popIn, popOut, turnTo, scaleTo, fadeTo, bump, drawOn, pulse, stagger } from './motion/intents.ts';
export { IntentError, type Key, type StaggerOrder } from './motion/intents.ts';
export { definePalette, checkPalette, resolveColor, PALETTE_LAWS, PaletteError, ROLES } from './look/palette.ts';
export type { ColorRef, Palette, PaletteIssue, PaletteSpec, Role } from './look/palette.ts';
export { hsv, hexToHsv, lightness, mix } from './look/color.ts';
export type { LightFrom, LightSpec } from './look/light.ts';
export { SPRING_PRESETS, type SpringParams, type SpringPreset, type SpringSpec } from './core/dynamics.ts';
export type { StringTables } from './text/strings.ts';
export type {
  BackgroundSpec,
  BodySpec,
  CameraSpec,
  EmitterNode,
  EyeNode,
  GroupNode,
  IdleSpec,
  LabelNode,
  LabelSide,
  LayerSpec,
  LinkNode,
  PhysicsSpec,
  SceneNode,
  ShapeNode,
  ShotSpec,
  TurbulenceSpec,
} from './scene/types.ts';
export { STAGE_W, STAGE_H } from './scene/types.ts';
export type { Vec2 } from './core/math.ts';

// --- Core helpers a scene may use to generate content ----------------------
export { Rng } from './core/rng.ts';
export { Noise } from './core/noise.ts';
export { FPS, SIM_DT, SUBSTEPS, frameToSeconds, secondsToFrame } from './core/time.ts';
export { ease, EASINGS, type EaseName } from './core/easing.ts';

// --- Tools: compile, bake, evaluate, check, render -------------------------
export { compileShot, defaultTint, CompileError, type CompiledShot, type CNode, type CLayer } from './scene/compile.ts';
export { evaluate, computeWorld, flatItems, labelLayout, type FrameState, type GroupItem, type Item, type LayerState, type LeafItem } from './scene/evaluate.ts';
export { bakeShot, ensureBake, bakeKey } from './physics/bake.ts';
export { Bake, bakeHash, readBake, writeBake, type BakeHeader, type ContactEvent } from './physics/cache.ts';
export { runChecks, formatReport, checkTextFit, type CheckReport, type CheckIssue } from './checks/index.ts';
export { drawFrame, frameRaw, framePng, heightFor, rendererInfo, type RenderOptions } from './render/frame.ts';
export { renderSheet, rawToPng, type SheetOptions, type SheetTile } from './render/sheet.ts';
export { renderParallel, type RenderJob, type RenderResult } from './render/parallel.ts';
export { cameraAt, layerView, type CameraState, type LayerView } from './camera/camera.ts';
export { layoutText, measureText, type TextLayout, type TextStyle } from './text/layout.ts';
export { FONT_FAMILY } from './text/fonts.ts';
export { engineVersion, physicsVersion } from './version.ts';
export { loadShot } from './cli/load.ts';
