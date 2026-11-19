// The scene description: plain, serialisable data. A scene module builds it with
// the factory functions in build.ts; nothing here is a function or a class, so a
// shot can be hashed, compared and passed between processes.
//
// Space: the stage is 1920 x 1080 units with the origin at the centre of the
// frame, x to the right, y down. One unit is one pixel of a 1080p render at
// depth 0 and zoom 1. Times are seconds from the start of the shot. Angles in the
// scene API are degrees, clockwise on screen.

import type { SpringSpec } from '../core/dynamics.ts';
import type { Vec2, Vec3 } from '../core/math.ts';
import type { LightSpec } from '../look/light.ts';
import type { ColorRef, Palette } from '../look/palette.ts';
import type { MoveProfile } from '../motion/curves.ts';
import type { Key } from '../motion/intents.ts';
import type { PathSpec } from '../motion/paths.ts';
import type { ShapeSpec } from '../shape/geometry.ts';
import type { TextAlign } from '../text/block.ts';
import type { StringTables } from '../text/strings.ts';
import type { PerspSpec, PlaneAxes } from './space.ts';

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
      /**
       * 'release': the body is not drawn while it waits for its release, so a
       * heap of pieces that wait above the frame adds no glow to it. Default 'always'.
       */
      readonly appear?: 'always' | 'release';
    };

/** A shape that fills from the bottom: how full it is, and how its surface moves. */
export interface LevelSpec {
  /** 0 = empty, 1 = full, at the start; levelTo animates it. */
  readonly at: number;
  /**
   * A ripple of the surface: its height in units, the length of one wave in
   * units, and how fast it runs, in units per second. null is a flat surface.
   */
  readonly wave: { readonly amp: number; readonly length: number; readonly speed: number } | null;
}

interface NodeBase {
  /** Unique within the shot. Timeline keys, links, labels and eyes refer to nodes by id. */
  readonly id: string;
  /** Position in the parent's space (the layer's space for top-level nodes). */
  readonly at: Vec2;
  /** Degrees, clockwise. */
  readonly rotation: number;
  readonly scale: number;
  /**
   * Key of the node's voice in the bank of sounds: what its intents and its
   * contacts sound like. It never changes the picture or the bake.
   */
  readonly sound?: string;
  /** A node listed in a perspective layer: how far away it is, the third number of its place. Left out: a place of two numbers. */
  readonly z?: number;
  /**
   * A node listed in a layer: its place in the draw order of that layer. What has the larger depth is drawn first, behind
   * the rest; in a perspective layer it is added to the node's distance from the camera. Left out: 0.
   */
  readonly depth?: number;
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
  /**
   * An opaque thing in front: what is drawn before it in its layer does not
   * shine through it. Glow is hidden where the cover lies over it, and the
   * motion review does not judge what is wholly behind it.
   */
  readonly cover?: boolean;
  /** Labels may lie over it (ground, a wall, a backdrop): the covers-node warning leaves it out. */
  readonly backdrop?: boolean;
  /** Id of a shape of the same layer: this node and what is in it are drawn only inside that shape's outline. */
  readonly clipTo?: string | null;
  /** The shape is a content: it fills its own outline from the bottom up to a level. */
  readonly level?: LevelSpec | null;
  /**
   * A region of a perspective layer given by points of its space, around the node's place: `shape` is then the
   * outline they have when the region is seen straight on, and the camera of the layer gives the one that is drawn.
   */
  readonly points3?: readonly Vec3[];
  /** Such a region: false does not draw it when the camera sees its back. Left out: it is drawn from both sides. */
  readonly back?: boolean;
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
  /** Id of a shape of the same layer: the group is drawn only inside that shape's outline. */
  readonly clipTo?: string | null;
  /**
   * A group listed in a perspective layer that lies in a plane of its space: the two axes of the plane, through the
   * group's place. Everything in the group is drawn on that plane, as on a page or a map seen through the camera.
   */
  readonly plane?: PlaneAxes;
  /** Such a group: false does not draw it when the camera sees the back of its plane. Left out: it is drawn from both sides. */
  readonly back?: boolean;
}

/** The widest a link can be, in units: the limit of its `width`, and of a `widthTo` on it. */
export const LINK_MAX_WIDTH = 80;

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
  /** Id of a shape of the same layer: the link is drawn only inside that shape's outline. */
  readonly clipTo?: string | null;
  /**
   * Key of the node's voice in the bank of sounds: what its intents and its
   * contacts sound like. It never changes the picture or the bake.
   */
  readonly sound?: string;
}

/**
 * A stroke along a free-form path: a line with round ends, solid or dashed,
 * that can be drawn on over time. It is placed like a shape (at, rotation,
 * scale, a parent) and its points are in its own space.
 */
export interface StrokeNode extends NodeBase {
  readonly type: 'stroke';
  /** The points the line runs through, open or closed, joined as the path of a travel is. */
  readonly path: PathSpec;
  readonly width: number;
  readonly color: ColorRef;
  /**
   * Dashes: the length of the straight part of a dash (0 is a dot) and the
   * clear gap between two dashes, in units. null is a solid line.
   */
  readonly dash: readonly [number, number] | null;
  /** 0..1 at the start: how far the gaps of a dashed line are closed; 1 is a solid line. solidTo animates it. */
  readonly solid: number;
  /** 0..1 at the start. */
  readonly opacity: number;
  /** 0 = no glow; 1 = the line feeds the halo. */
  readonly glow: number;
  /**
   * The share of the line that is drawn before its first drawOn, 0..1 from its
   * first point. Left out: all of it, or none of it when the line has a drawOn.
   */
  readonly drawn?: number;
  /** Colour of the lights that run along the stroke (pulse). Left out: the stroke's own colour. */
  readonly pulseColor?: ColorRef;
  /** Id of a shape of the same layer: the stroke is drawn only inside that shape's outline. */
  readonly clipTo?: string | null;
  /**
   * A stroke of a perspective layer given by points of its space, around the node's place: `path` is then the line
   * they make seen straight on, and the camera of the layer gives the one that is drawn.
   */
  readonly points3?: readonly Vec3[];
}

/**
 * Free-standing text: a block of lines from a string of the tables, without a
 * pointer. It is placed like a shape (at, rotation, scale, a parent), so as
 * the child of a shape it lies on it and moves, turns and grows with it.
 */
export interface TextNode extends NodeBase {
  readonly type: 'text';
  /** Key into the shot's string tables. Never the text itself. */
  readonly text: string;
  readonly ink: ColorRef;
  /** Preferred font size in units; the layout may go down to `minSize`. */
  readonly size: number;
  readonly minSize: number;
  /** Widest a line may get before the text wraps. */
  readonly maxWidth: number;
  readonly maxLines: number;
  /** Weight of the letters, 200 (light) to 1000 (black). */
  readonly weight: number;
  /** Where the origin of the node is in the block, sideways, and how its lines are set. */
  readonly align: TextAlign;
  /** Colour of a rounded box behind the lines, or null: the lines alone. */
  readonly box: ColorRef | null;
  /**
   * Makes the text a counter: its string holds "{n}", the place of a number
   * that starts at `from` and runs where countTo sends it, written with
   * `decimals` places after the decimal sign, the way the language writes numbers.
   */
  readonly count?: { readonly from: number; readonly decimals: number };
  /** 0..1 at the start. */
  readonly opacity: number;
  /** Id of a shape of the same layer: the text is drawn only inside that shape's outline. */
  readonly clipTo?: string | null;
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
  /**
   * Key of the node's voice in the bank of sounds: what its intents and its
   * contacts sound like. It never changes the picture or the bake.
   */
  readonly sound?: string;
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
  /**
   * How the size of a particle runs over its life. 'spark': a quick swell,
   * then a slow shrink to nothing over the second half. 'steady': full size
   * for nearly all of its life, with a short swell and a short shrink.
   */
  readonly sizing?: 'spark' | 'steady';
  /** Id of a shape of the same layer: the particles are drawn only inside that shape's outline. */
  readonly clipTo?: string | null;
  /**
   * Key of the node's voice in the bank of sounds: what its intents and its
   * contacts sound like. It never changes the picture or the bake.
   */
  readonly sound?: string;
}

export type SceneNode = ShapeNode | GroupNode | LinkNode | LabelNode | EyeNode | EmitterNode | StrokeNode | TextNode;

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
  /**
   * Makes the layer a perspective layer: its nodes take a place of three numbers and are seen through this camera.
   * Left out: a flat layer.
   */
  readonly perspective?: PerspSpec;
}

/** A free-form path for the camera: the places it looks at, in units of the focus plane. */
export interface CameraPathSpec extends PathSpec {
  /**
   * Units per frame along the path (the norm is 0.3 to 0.7). The camera keeps
   * that speed for the whole shot: round and round a closed path, there and
   * back on an open one. null: it covers the path once over the shot.
   */
  readonly speed: number | null;
  /** How the speed is spread when the path is covered once. */
  readonly profile: Exclude<MoveProfile, 'settle'>;
  readonly ramp: number;
  /** Seconds the camera takes to slow down, turn round and be back at speed at an end of an open path. */
  readonly turn: number;
}

export interface CameraSpec {
  /**
   * A free-form path instead of the straight drift: `at`, `drift.speed` and
   * `drift.heading` are then not used; the wander stays on top of it.
   */
  readonly path?: CameraPathSpec | null;
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

/** Kinds of findings of the contrast review (src/review/contrast.ts), which a shot turns on with `contrast`. */
export const CONTRAST_FINDING_KINDS = ['low-contrast'] as const;

export type ContrastFindingKind = (typeof CONTRAST_FINDING_KINDS)[number];

export type FindingKind = MotionFindingKind | PhysicsFindingKind | ContrastFindingKind;

/** Every kind of finding a shot can mark as intended. */
export const FINDING_KINDS_ALL: readonly FindingKind[] = [...MOTION_FINDING_KINDS, ...PHYSICS_FINDING_KINDS, ...CONTRAST_FINDING_KINDS];

/**
 * What a shot asks of the contrast review: the nodes that must stand out from
 * what lies behind them, and how far. The numbers are the production's: the
 * engine has no threshold of its own. It never influences the picture.
 */
export interface ContrastSpec {
  /** Ids of the nodes that are held: shapes, strokes, texts and labels. */
  readonly nodes: readonly string[];
  /** The least difference in lightness (CIE L*, 0..100) that is enough by itself. */
  readonly lightness: number;
  /** The least difference in colour (hue and saturation: the distance in the a*b* plane of CIELAB) that is enough by itself. */
  readonly colour: number;
  /** The share of the node's outline that has to blend before it is a finding. */
  readonly edge: number;
  /** The seconds it has to last. */
  readonly seconds: number;
}

/** The camera as the subject of a motion finding. Node ids cannot hold parentheses, so these never collide with one. */
export const CAMERA_SUBJECT = '(camera)';
/** The whole frame as the subject of a dead-area finding; a region is "(frame:top-left)" and so on. */
export const FRAME_SUBJECT = '(frame)';
/** The regions of the frame a dead-area finding can name, row by row. */
export const FRAME_REGIONS = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const;

/**
 * An intended exception to the motion review, to the physics review or to the contrast review: findings
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
  /** The contrast review of the shot. Left out: it is off. */
  readonly contrast?: ContrastSpec;
}
