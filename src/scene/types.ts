// The scene description: plain, serialisable data. A scene module builds it with
// the factory functions in build.ts; nothing here is a function or a class, so a
// shot can be hashed, compared and passed between processes.
//
// Space: the stage is 1920 x 1080 units with the origin at the centre of the
// frame, x to the right, y down. One unit is one pixel of a 1080p render at
// depth 0 and zoom 1. Times are seconds from the start of the shot. Angles in the
// scene API are degrees, clockwise on screen.

import type { SpringSpec } from '../core/dynamics.ts';
import type { Vec2 } from '../core/math.ts';
import type { LightSpec } from '../look/light.ts';
import type { ColorRef, Palette } from '../look/palette.ts';
import type { Key } from '../motion/intents.ts';
import type { ShapeSpec } from '../shape/geometry.ts';
import type { StringTables } from '../text/strings.ts';

/** Design size of the stage in units. */
export const STAGE_W = 1920;
export const STAGE_H = 1080;

/** Gentle endless wandering around the node's place: a pure function of time. */
export interface IdleSpec {
  /** How far it wanders, in units. */
  readonly amp: number;
  /** Seconds per wander, roughly. */
  readonly period: number;
}

/** A rigid body driven by the physics bake. */
export type BodySpec =
  | {
      /** Never moves; other bodies collide with it. */
      readonly kind: 'fixed';
      readonly friction?: number;
      readonly restitution?: number;
    }
  | {
      /** Stays where the scene puts it until `release`, then falls and collides. */
      readonly kind: 'dynamic';
      /**
       * Seconds: the moment the simulation takes the body over. It may be
       * negative, down to minus the shot's `physics.prewarm`: such a body is
       * already under way (or already at rest) at frame 0.
       */
      readonly release: number;
      /** Velocity at release, units per second. */
      readonly velocity?: Vec2;
      /** Spin at release, degrees per second. */
      readonly spin?: number;
      /** Mass per area relative to the default (1). */
      readonly density?: number;
      readonly friction?: number;
      readonly restitution?: number;
    };

interface NodeBase {
  /** Unique within the shot. Timeline keys, links, labels and eyes refer to nodes by id. */
  readonly id: string;
  /** Position in the parent's space (the layer's space for top-level nodes). */
  readonly at: Vec2;
  /** Degrees, clockwise. */
  readonly rotation: number;
  readonly scale: number;
}

export interface ShapeNode extends NodeBase {
  readonly type: 'shape';
  readonly shape: ShapeSpec;
  readonly fill: ColorRef;
  /** 0..1 at the start; fadeTo animates it. The shape and its children fade as one picture. */
  readonly opacity: number;
  /** Automatic light: shadow crescent, lit rim and highlight stroke. */
  readonly lit: boolean;
  /** 0 = no glow; 1 = full line + halo + background lift. */
  readonly glow: number;
  /** A thin coloured rim light on the shadow side. */
  readonly rimLight: ColorRef | null;
  readonly children: readonly SceneNode[];
  /** Position follows its rest place through a spring (lag, overshoot, settle). */
  readonly follow: SpringSpec | null;
  /** Capsules with origin 'start' only: the free end lags on a spring, so the stick sways. */
  readonly sway: SpringSpec | null;
  readonly idle: IdleSpec | null;
  readonly body: BodySpec | null;
}

export interface GroupNode extends NodeBase {
  readonly type: 'group';
  /** 0..1 at the start; the whole group fades as one picture. */
  readonly opacity: number;
  /**
   * The group keeps its own rotation in the layer's space instead of turning
   * with its parent: a face on a body that rolls stays level.
   */
  readonly upright: boolean;
  readonly children: readonly SceneNode[];
  readonly follow: SpringSpec | null;
  readonly idle: IdleSpec | null;
}

/** A curved line between two nodes of the same layer; it follows them as they move. */
export interface LinkNode {
  readonly type: 'link';
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** Sideways bulge as a fraction of the link's length; 0 is straight. */
  readonly bend: number;
  readonly width: number;
  readonly color: ColorRef;
  /** Colour of the pulses that travel along the link. */
  readonly pulseColor: ColorRef;
  /** Units to leave free at each end (in addition to the end nodes' own radius). */
  readonly gap: number;
  /** 0..1 at the start. A link also fades with the fainter of the two nodes it joins. */
  readonly opacity: number;
  /** 0 = no glow; 1 = the line itself feeds the halo. Pulses glow whatever this is. */
  readonly glow: number;
}

export type LabelSide = 'top' | 'bottom' | 'left' | 'right';

/** A rounded rectangle with a pointer tail, sized and wrapped to its string. */
export interface LabelNode {
  readonly type: 'label';
  readonly id: string;
  /** Key into the shot's string tables. Never the text itself. */
  readonly text: string;
  /** The node the tail points at; the label follows it. */
  readonly target: string;
  /** On which side of the target the label sits. */
  readonly side: LabelSide;
  /** Distance from the target's edge to the tip of the tail. */
  readonly gap: number;
  /** Preferred font size in units; the layout may go down to `minSize`. */
  readonly size: number;
  readonly minSize: number;
  /** Widest the text block may get before it wraps. */
  readonly maxWidth: number;
  readonly maxLines: number;
  readonly fill: ColorRef;
  readonly ink: ColorRef;
  /** 0..1 at the start. */
  readonly opacity: number;
  readonly follow: SpringSpec | null;
}

/** A simple eye: a light disc with a pupil that looks at a node, and blinks. */
export interface EyeNode extends NodeBase {
  readonly type: 'eye';
  readonly r: number;
  readonly white: ColorRef;
  readonly pupil: ColorRef;
  /** 0..1 at the start. */
  readonly opacity: number;
  /** Node to look at, or null to look straight ahead. */
  readonly lookAt: string | null;
  /** Blink now and then, on a seeded schedule. */
  readonly blink: boolean;
  /** How far the lids are open at the start: 0 = shut (the eye is not drawn), 1 = open. openTo animates it. */
  readonly open: number;
}

export interface TurbulenceSpec {
  /** Acceleration, units per second squared. */
  readonly strength: number;
  /** Size of the swirls in units. */
  readonly scale: number;
  /** How fast the field changes, in field-lengths per second. */
  readonly speed: number;
}

/** A particle emitter. Particles live in the layer's space and are baked. */
export interface EmitterNode {
  readonly type: 'emitter';
  readonly id: string;
  /** Position in the layer's space, or the offset from `attach`. */
  readonly at: Vec2;
  /** Node to ride on (its position at each moment). */
  readonly attach: string | null;
  /** Size of the spawn box around the position: [width, height]. */
  readonly area: Vec2;
  /** Continuous emission, particles per second, between `from` and `until`. */
  readonly rate: number;
  readonly from: number;
  readonly until: number;
  /** Timed bursts. */
  readonly bursts: readonly { readonly at: number; readonly count: number }[];
  /** Burst at every recorded rigid-body contact at least this strong, at the contact point. */
  readonly onContact: { readonly count: number; readonly minImpulse: number } | null;
  /** Seconds simulated before the shot starts, so the field is already populated at frame 0. */
  readonly prewarm: number;
  /** Mean direction in degrees (0 = right, -90 = up) and full spread angle. */
  readonly direction: number;
  readonly spread: number;
  /** Units per second, [min, max]. */
  readonly speed: Vec2;
  /** Seconds, [min, max]. */
  readonly life: Vec2;
  /** Radius in units, [min, max]. */
  readonly size: Vec2;
  readonly colors: readonly ColorRef[];
  /**
   * An inner disc drawn on every particle, in one colour: `size` is its radius
   * as a fraction of the particle's. null draws plain discs.
   */
  readonly core: { readonly color: ColorRef; readonly size: number } | null;
  /** Constant acceleration (gravity, wind), units per second squared. */
  readonly gravity: Vec2;
  /** Velocity lost per second, as a rate (0 = none). */
  readonly drag: number;
  readonly turbulence: TurbulenceSpec | null;
  /** 0..1: particles also feed the glow pass. */
  readonly glow: number;
}

export type SceneNode = ShapeNode | GroupNode | LinkNode | LabelNode | EyeNode | EmitterNode;

/** A depth layer. Depth 0 is the focus plane; positive is farther, negative is nearer. */
export interface LayerSpec {
  readonly id: string;
  /** Distance from the focus plane; must be above -1. */
  readonly depth: number;
  readonly nodes: readonly SceneNode[];
  /** Blur radius in units; null derives it from the depth and the camera's focus. */
  readonly blur: number | null;
  /** How strongly the camera moves this layer (1 at depth 0); null derives it from the depth. */
  readonly parallax: number | null;
  /**
   * 0..1 atmospheric perspective: every colour of the layer loses saturation and
   * moves this far toward the shot's atmosphere colour. null derives it from the depth.
   */
  readonly tint: number | null;
}

export interface CameraSpec {
  /** Where the camera looks at the start, in units of the focus plane. */
  readonly at: Vec2;
  readonly drift: {
    /** Steady travel in units per frame (the norm is 0.3 to 0.7). */
    readonly speed: number;
    /** Direction of travel in degrees (0 = the camera moves right). */
    readonly heading: number;
    /** Low-frequency wander added on top, in units. */
    readonly wander: number;
    /** Seconds per wander. */
    readonly period: number;
  };
  /** Slow zoom across the whole shot. */
  readonly pushIn: { readonly from: number; readonly to: number };
  /** Depth of field: blur in units per unit of depth, behind and in front of the focus plane. */
  readonly focus: { readonly far: number; readonly near: number };
}

export interface BackgroundSpec {
  /** Colour at the centre of the gradient and at its edge. */
  readonly inner: ColorRef;
  readonly outer: ColorRef;
  /** Centre as fractions of the frame, [0..1, 0..1]. */
  readonly center: Vec2;
  /** Radius as a fraction of the frame width. */
  readonly radius: number;
}

/** Style of the rigid-body world: tuned for readability, not realism. */
export interface PhysicsSpec {
  /** Downward acceleration, units per second squared (100 units = 1 m). */
  readonly gravity: number;
  readonly linearDamping: number;
  readonly angularDamping: number;
  readonly restitution: number;
  readonly friction: number;
  /**
   * Seconds the world is simulated before the shot starts, so that a pile
   * already lies there, or a stream already falls, at frame 0.
   */
  readonly prewarm: number;
}

/** Kinds of findings of the motion review (src/review, docs/MOTION-REVIEW.md). */
export const MOTION_FINDING_KINDS = [
  'jump',
  'abrupt-start',
  'abrupt-stop',
  'mechanical',
  'too-fast',
  'spring-ringing',
  'spring-no-overshoot',
  'dead-area',
] as const;

export type MotionFindingKind = (typeof MOTION_FINDING_KINDS)[number];

/** Kinds of findings of the physics review (src/review/physics.ts, docs/PHYSICS-REVIEW.md). */
export const PHYSICS_FINDING_KINDS = ['overlap', 'tunnelling', 'escape', 'jitter', 'unsettled', 'energy-spike', 'unseen-hit', 'not-finite'] as const;

export type PhysicsFindingKind = (typeof PHYSICS_FINDING_KINDS)[number];

export type FindingKind = MotionFindingKind | PhysicsFindingKind;

/** Every kind of finding a shot can mark as intended. */
export const FINDING_KINDS_ALL: readonly FindingKind[] = [...MOTION_FINDING_KINDS, ...PHYSICS_FINDING_KINDS];

/** The camera as the subject of a motion finding. Node ids cannot hold parentheses, so these never collide with one. */
export const CAMERA_SUBJECT = '(camera)';
/** The whole frame as the subject of a dead-area finding; a region is "(frame:top-left)" and so on. */
export const FRAME_SUBJECT = '(frame)';
/** The regions of the frame a dead-area finding can name, row by row. */
export const FRAME_REGIONS = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const;

/**
 * An intended exception to the motion review or to the physics review: findings
 * of this kind on these subjects are what the author wants. The review leaves
 * them out of its warnings and lists them as honoured. It never influences the
 * picture.
 */
export interface IntendedSpec {
  /** Node ids, or the camera or frame subjects above. */
  readonly nodes: readonly string[];
  readonly kind: FindingKind;
  /** Why it is intended: one line for the reviewer. */
  readonly reason: string;
  /** Seconds: only findings that overlap this window are covered; null leaves that side open. */
  readonly from: number | null;
  readonly to: number | null;
}

export interface ShotSpec {
  readonly id: string;
  readonly seconds: number;
  readonly seed: number;
  readonly palette: Palette;
  readonly strings: StringTables;
  readonly light: LightSpec;
  readonly background: BackgroundSpec;
  /** Colour far layers fade toward. */
  readonly atmosphere: ColorRef;
  /** 0..1 darkening of the frame's corners toward the background's outer colour. */
  readonly vignette: number;
  readonly camera: CameraSpec;
  readonly physics: PhysicsSpec;
  readonly layers: readonly LayerSpec[];
  readonly timeline: readonly Key[];
  /** Intended exceptions to the motion review and to the physics review. */
  readonly intended: readonly IntendedSpec[];
}
