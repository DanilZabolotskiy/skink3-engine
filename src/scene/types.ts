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
import type { MoveProfile, SpeedKeys } from '../motion/curves.ts';
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
  /** false: the automatic light is drawn without its highlight stroke. Left out: with it. */
  readonly highlight?: boolean;
  /** 0 = no glow; 1 = full line + halo + background lift. */
  readonly glow: number;
  /** 0..1: the share of the background lift of its glow that the shape draws. Left out: all of it. */
  readonly lift?: number;
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
  /**
   * In a plane of a perspective layer: the shape stands up from the plane, flat, like a sail or a sign. Its own x
   * runs along the plane, turned with the node; its own y runs straight up from the plane, and its points with a y
   * below 0 stand over the node's place. Elsewhere it is drawn as any shape.
   */
  readonly stands?: boolean;
  /** Id of a shape of the same layer: this node and what is in it are drawn only inside that shape's outline. */
  readonly clipTo?: string | null;
  /** What is clipped to this shape is kept inside it by a mask of its outline, not by Skia's clip (which may drop a long one). */
  readonly clipMask?: boolean;
  /** The shape is a content: it fills its own outline from the bottom up to a level. */
  readonly level?: LevelSpec | null;
  /**
   * A region of a perspective layer given by points of its space, around the node's place: `shape` is then the
   * outline they have when the region is seen straight on, and the camera of the layer gives the one that is drawn.
   */
  readonly points3?: readonly Vec3[];
  /** Such a region: false does not draw it when the camera sees its back. Left out: it is drawn from both sides. */
  readonly back?: boolean;
  /** Units: the shape and what is in it are drawn as one picture, blurred this far, so its edge is soft. Left out: sharp. */
  readonly soft?: number;
  /**
   * Units: the shape is the top of a body this high. Its place is its foot on the ground; the top is drawn that far
   * up the screen (in a plane of a perspective layer: that far off the plane, toward its front), with the side of the
   * body under it, and its children ride on the top. riseTo animates it. Left out: a flat shape.
   */
  readonly rise?: number;
  /** The colour of that side. Left out: a shadow tone of the fill. */
  readonly side?: ColorRef;
  /**
   * A heat haze: the picture drawn before the shape, inside its outline, wavers like air over heat; what is drawn
   * after it stays steady. The shape itself is drawn as any shape, at its opacity (often 0). hazeTo animates the
   * amount. Left out: the shape moves nothing.
   */
  readonly haze?: HazeSpec;
  /** A body with a rise: the roof that stands on its top, in place of the flat top. Left out: a flat top. */
  readonly roof?: RoofSpec;
  /** A body with a rise: rows of openings painted on its side. Left out: a plain side. */
  readonly openings?: OpeningsSpec;
  /** A field of heights drawn as the light falls on it (relief): the shape is the rect it spans. Left out: a plain shape. */
  readonly relief?: ReliefSpec;
  /** A round body seen from space (globe): the shape is the circle of its disc. Left out: a plain shape. */
  readonly globe?: GlobeSpec;
}

/**
 * A sphere with the outlines of a body's surface on it, as it is seen from far away (an orthographic view): turned
 * so that one place faces the viewer, turning about its axis, lit from one side. Its colours are in `colors` of its
 * node: globe.layer<i> for each layer, globe.night, globe.lights and globe.air.
 */
export interface GlobeSpec {
  /** Degrees [longitude east, latitude north] of the place that faces the viewer at the start; north is up. */
  readonly view: readonly [number, number];
  /** Degrees per second it turns, east being the way the Earth turns (what faces the viewer moves left to right); or keys of that speed over the shot. */
  readonly spin: number | SpeedKeys;
  /** The layers of its surface, painted in order over the disc. */
  readonly layers: readonly GlobeLayerSpec[];
  /** Where the light comes from (degrees, 0 from the right, -90 from the top) and the share of the disc it lights; null: the whole disc in the light, and no night. */
  readonly light: { readonly from: number; readonly lit: number } | null;
  /** The night side: its colour, how far it darkens the surface (0..1), and how soft the terminator is, as a share of the radius. */
  readonly night: { readonly color: ColorRef; readonly amount: number; readonly soft: number };
  /** Lights on the night side (the lights of towns): each point x, y, z on the unit sphere and its weight, in turn. */
  readonly lights: { readonly points: Float64Array; readonly color: ColorRef; readonly size: number; readonly amount: number } | null;
  /** The thin rim of air round the disc; null: none. */
  readonly air: { readonly color: ColorRef; readonly width: number; readonly amount: number } | null;
  /** 0..1: how much the disc darkens toward its edge, so that it reads as a ball. */
  readonly shade: number;
}

/** A layer of a globe's surface: rings filled at once. */
export interface GlobeLayerSpec {
  /**
   * Each ring as points x, y, z on the unit sphere in turn (x toward 0° E on the equator, z north), dense enough to be
   * joined straight, running counter-clockwise round its smaller side, seen from outside.
   */
  readonly rings: readonly Float64Array[];
  /** For each ring: true when it ran clockwise round its smaller side as it was given, a hole in what holds it. The rings fill non-zero, so rings that overlap fill as one. */
  readonly holes: readonly boolean[];
  readonly fill: ColorRef;
  readonly opacity: number;
  /** Degrees per second it turns east over the body (clouds that drift); 0 for what lies on it. */
  readonly drift: number;
  /** A share of the radius: the layer's edges are blurred this far (soft clouds); 0 for sharp outlines. */
  readonly soft: number;
}

/**
 * A field of heights, a grid of them laid over a rect (as a digital elevation model lies over a map), shaded by a
 * light from one side and from above. Its colours are in `colors` of its node: relief.dark, relief.bright and a
 * relief.tint<i> for each tint.
 */
export interface ReliefSpec {
  /** Width in output pixels of a shading sample. Geometry and grounding always use the full height grid. */
  readonly samplePixels?: 2 | 4;
  /** Points of the grid across and down; the first row is the top of the rect, the first point of a row its left. */
  readonly cols: number;
  readonly rows: number;
  /** cols * rows heights, row by row, in the units of the data (metres, say). */
  readonly heights: Float32Array;
  /** Units of the scene to a unit of height: how steep the slopes are drawn. */
  readonly vertical: number;
  /** Degrees, where the light comes from in the plane of the rect: 0 from its right, -90 from its top. */
  readonly from: number;
  /** Degrees, how high the light stands over the ground (1..89). */
  readonly high: number;
  /** 0..1: how far a slope turns toward the dark or the bright tone. */
  readonly amount: number;
  /** The tone of the slopes turned from the light, and of those turned to it. */
  readonly dark: ColorRef;
  readonly bright: ColorRef;
  /** Tints of the ground by height, from the lowest: [height, colour]. Left out: only the shading is drawn, over what is under it. */
  readonly tints?: readonly (readonly [number, ColorRef])[];
  /** Units of the rect: the field fades out over this distance toward its edges. Left out: it ends sharp at its edges. */
  readonly feather?: number;
}

/** How a heat haze moves the picture behind it. All lengths are in the units of the layer. */
export interface HazeSpec {
  /** How far it moves the picture at most, sideways; up and down half as far. */
  readonly amount: number;
  /** The size of its ripples: the larger ones are this long, the finer ones half as long. */
  readonly scale: number;
  /** How fast the ripples drift, units per second. */
  readonly speed: number;
  /** Degrees, 0 right, -90 up: where they drift. */
  readonly direction: number;
}

/** The kinds of roof a body may carry. */
export const ROOF_KINDS = ['gable', 'hip', 'cone', 'dome'] as const;
export type RoofKind = (typeof ROOF_KINDS)[number];

/**
 * The roof of a body with a height: what stands on its top in place of the flat top. Its slopes are the fill of the
 * shape in the tones of the light, each by the way it faces; its upright ends are the side of the body.
 */
export interface RoofSpec {
  /** 'gable': two slopes and a ridge; 'hip': four slopes; 'cone': slopes to one point over the middle; 'dome': a round cap. */
  readonly kind: RoofKind;
  /** Units: how high the roof stands over the top of the body. */
  readonly height: number;
  /** 'gable' and 'hip': where the ridge runs, in degrees in the shape's own space (0 along its x). Left out: along the longer side of the shape. */
  readonly ridge?: number;
  /**
   * A 'hip' on a region: units, how far in from the edge the slopes run; past that the roof is flat at `height`.
   * Left out: as far as the middle, so that the slopes meet in ridges and the roof is `height` at its highest point.
   */
  readonly run?: number;
  /**
   * How far the tones of the slopes lie from the fill: 1 as the light gives them, 0 every slope in the fill itself,
   * up to 2 twice as far (within the darkest and the lightest tone). Left out: 1.
   */
  readonly contrast?: number;
}

/** The outlines an opening may have. */
export const OPENING_SHAPES = ['rect', 'arch'] as const;

/**
 * Rows of openings on the side of a body with a height: windows, arches, the gaps of a colonnade. They are painted on
 * each face of the side the viewer sees, and follow its length, its height and the camera. A face runs from one sharp
 * corner of the outline to the next; a round outline is one face all the way round.
 */
export interface OpeningsSpec {
  /** 'rect', or 'arch': a rect with a round head. */
  readonly shape: (typeof OPENING_SHAPES)[number];
  /** Units: the width and the height of one opening. */
  readonly width: number;
  readonly height: number;
  /** Units: from the middle of one opening to the middle of the next along a face. */
  readonly step: number;
  /** How many rows, one over the other: they share the height of the body at its highest. */
  readonly rows: number;
  /** Units: how far the foot of an opening is over the foot of its row. Left out: the opening sits in the middle of its row. */
  readonly sill?: number;
  /** Units: the least plain wall between a sharp corner and the first opening. */
  readonly inset: number;
  /** The colour of the openings. Left out: a deep shadow tone of the side. */
  readonly color?: ColorRef;
}

/**
 * The shadows of the bodies of a group on the ground the group lies on: every shape and stroke with a rise inside
 * it casts one, as long as the body is high. They are one picture, drawn before everything else of the group, or,
 * with over: 'flat', over its flat members and under its raised ones.
 */
/**
 * Depth haze on a plane: from `near` to `far` units from the camera (measured along its line of sight), what the
 * plane draws turns toward the colour, smoothly, up to `amount` of the way; beyond `far` it stays there.
 */
export interface FogSpec {
  readonly color: ColorRef;
  readonly near: number;
  readonly far: number;
  /** 0..1: how far toward the colour the farthest ground turns. */
  readonly amount: number;
  /**
   * Distances from the camera: the plane is drawn whole up to `near` and fades out to nothing at `far`, so that what
   * lies behind it (the sky, the background) shows through, and its far edge melts away. Left out: it ends where its
   * things end.
   */
  readonly fade?: { readonly near: number; readonly far: number };
}

export interface CastSpec {
  readonly color: ColorRef;
  /** 0..1: how strong that one picture is. */
  readonly opacity: number;
  /** Degrees: where the shadows fall (0 to the right, 90 down). Left out: away from the light of the shot. */
  readonly dir?: number;
  /** How long a shadow is, in units to each unit of the height of its body. */
  readonly length: number;
  /** Units: how far the picture of the shadows is blurred. 0 is sharp. */
  readonly soft: number;
  /**
   * 'flat': the shadows lie over the flat members of the group (the children with no rise in them: a ground, a floor,
   * a yard), which are drawn first, as listed, and under its raised members. Left out: under all of them.
   */
  readonly over?: 'flat';
  /**
   * true: in a plane with a ground, the shadows lie on that ground. The shadow of each point of a body runs from where
   * it stands until it meets the ground (shorter where the ground rises toward the light, longer where it falls away,
   * at most SHADOW_REACH times as long as on level ground), and the outline of the shadows is laid on the ground point
   * by point, as a region of the plane is; the shadow of a raised line starts at its foot all along it. Left out:
   * each shadow lies level, at the height of the foot of its body.
   */
  readonly ground?: true;
}

/** The longest shadow a body may cast, in units to each unit of its height. */
export const CAST_MAX_LENGTH = 8;

/** With cast.ground, a shadow that runs down a slope is at most this many times as long as on level ground. */
export const SHADOW_REACH = 2;

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
  /**
   * Such a group: a body in it may stand taller than the camera is high over the plane, and is drawn whole, its top
   * seen from below. Left out: a body is drawn at most 0.9 of the camera's height tall.
   */
  readonly tall?: boolean;
  /**
   * Such a group: the id of a relief among its own children that is its ground, or the ids of a few (a finer one over
   * part of a coarser one, listed after it). The reliefs are drawn raised, and what the group lists after the first
   * of them stands on them, each thing at the height of the ground under its place. Left out: the plane is flat.
   */
  readonly ground?: string | readonly string[];
  /** Units: the group is drawn as one picture, blurred this far. Left out: sharp. */
  readonly soft?: number;
  /**
   * 'depth': the children of the group are drawn far to near at every frame, whatever order they were listed in.
   * In a plane of a perspective layer the far ones are those far from the camera; in a flat layer, those higher up
   * the screen. A stroke with a rise among them is taken stretch by stretch. Left out: they are drawn as listed.
   */
  readonly sort?: 'depth';
  /** The bodies in the group cast shadows on the ground it lies on. Left out: no shadows. */
  readonly cast?: CastSpec;
  /** A group in a plane: what it draws fades toward a colour with its distance from the camera. Left out: no fog. */
  readonly fog?: FogSpec;
  /**
   * How much detail the bodies inside the group are worth. A body that is smaller on screen than `min` is drawn
   * plain: its top alone. Every other body is drawn with everything it has, its side as one outline. Left out: every
   * body is drawn as it is anywhere.
   */
  readonly detail?: DetailSpec;
}

/** How much detail the bodies of a group are drawn with. */
export interface DetailSpec {
  /**
   * Units on screen: those of the stage, the pixels of a frame 1920 wide. A body that is smaller than this both
   * across and in height is drawn plain. 0: none is.
   */
  readonly min: number;
}

/** The largest `min` of a `detail`, in units on screen: a body larger than this is never drawn plain. */
export const DETAIL_MAX = 200;

/** The widest a link can be, in units: the limit of its `width`, and of a `widthTo` on it. */
export const LINK_MAX_WIDTH = 80;

/** The most a roof may stretch the tones of its slopes away from its fill (`roof.contrast`). */
export const ROOF_CONTRAST_MAX = 2;

/** The highest a body may rise, in its units: the limit of its `rise`, and of a `riseTo` on it. */
export const RISE_MAX = 2000;

/** The farthest a heat haze may move the picture, in units of the layer: the limit of its `amount`, and of a `hazeTo` on it. */
export const HAZE_MAX = 60;

/** The longest streak of a particle, in seconds of its way. */
export const STREAK_MAX = 1;

/** The farthest the middle of the pupil of an eye may be set to go from its middle, as a share of its radius (`reach`). */
export const EYE_MAX_REACH = 0.8;

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
  /** Subdivisions of each authored curve span for the visible stroke. Motion uses the full path table. */
  readonly curveSteps?: 1 | 2 | 4 | 8 | 16;
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
  /**
   * Units of the frame: the line is never thinner on screen than this, however far the camera has pulled back and
   * however small its parents are drawn. Left out: it is as wide as `width` says, at every zoom.
   */
  readonly least?: number;
  /** Units: the line is the top of a wall this high, as the rise of a shape. Left out: a flat line. */
  readonly rise?: number;
  /** The colour of the side of that wall. Left out: a shadow tone of the line's colour. */
  readonly side?: ColorRef;
  /** A wall: rows of openings painted on both its faces, wherever the viewer sees one. Left out: plain faces. */
  readonly openings?: OpeningsSpec;
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
  /**
   * The ink of the runs its string marks with "[" and "]", in every language: they are drawn in this colour, the
   * rest in `ink`. The marks are not drawn and take no room. Left out: a bracket is a bracket.
   */
  readonly runInk?: ColorRef;
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
  readonly count?: CountSpec;
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
  /**
   * The ink of the runs its string marks with "[" and "]", in every language: they are drawn in this colour, the
   * rest in `ink`. The marks are not drawn and take no room. Left out: a bracket is a bracket.
   */
  readonly runInk?: ColorRef;
  /** 0..1 at the start. */
  readonly opacity: number;
  readonly follow: SpringSpec | null;
  /**
   * Makes the label a counter, as a text with count is: its string holds "{n}", the place of the number countTo
   * runs; the box is made for the widest value it ever shows, and the tail keeps pointing at its target.
   */
  readonly count?: CountSpec;
  /**
   * Key of the node's voice in the bank of sounds: what its intents and its
   * contacts sound like. It never changes the picture or the bake.
   */
  readonly sound?: string;
}

/** The number of a counter: a text or a label whose string holds "{n}". */
export interface CountSpec {
  /** Where the number starts; countTo runs it from there. */
  readonly from: number;
  /** Places after the decimal sign. */
  readonly decimals: number;
  /**
   * false: the digits stand alone, with no sign between their groups, in every language (a year: 1309, not 1,309;
   * the decimal sign stays the language's own). Left out: the number is grouped the way the language groups it.
   */
  readonly grouping?: false;
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
  /**
   * How far the middle of the pupil may go from the middle of the eye, as a share of its radius; the pupil is clipped
   * to the white. Left out: about 0.4, where the whole pupil stays inside the white.
   */
  readonly reach?: number;
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
   * 'grow': a quick swell to nearly half its size, then on to its full size
   * at its death (it fades away meanwhile: `fade` ends at 0).
   */
  readonly sizing?: 'spark' | 'steady' | 'grow';
  /**
   * The opacity of the particles as one picture at the start, 0..1: they are drawn together and faded as a group is.
   * fadeTo keys it. Left out: opaque, as it always was.
   */
  readonly opacity?: number;
  /**
   * The opacity of every particle over its own life: from `fade[0]` at its birth to `fade[1]` at its death, evenly.
   * Each particle is then drawn on its own, so where they crowd they add up. Left out: every particle opaque.
   */
  readonly fade?: Vec2;
  /** Id of a shape of the same layer: the particles are drawn only inside that shape's outline. */
  readonly clipTo?: string | null;
  /**
   * Seconds: every particle is drawn as a streak along its way, as long as the way it travels in that time (and no
   * longer than the way it has come since it was born): rain, sparks, a stream. Left out: round particles.
   */
  readonly streak?: number;
  /**
   * Key of the node's voice in the bank of sounds: what its intents and its
   * contacts sound like. It never changes the picture or the bake.
   */
  readonly sound?: string;
}

export type SceneNode = ShapeNode | GroupNode | LinkNode | LabelNode | EyeNode | EmitterNode | StrokeNode | TextNode;

/** A depth layer. Depth 0 is the focus plane; positive is farther, negative is nearer. */
export interface LayerSpec {
  /** Rasterize this top-level group at global shot frames and interpolate between them while the camera holds. */
  readonly sampledBackdrop?: { readonly group: string; readonly frames: readonly number[]; readonly liveGlow?: boolean };
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
  /**
   * Keys of its speed over the shot: [seconds from the start of the shot, units
   * per second], the first at 0, smooth from one key to the next, the last kept
   * to the end. They replace speed, profile, ramp and turn: round and round a
   * closed path; on an open one they must not carry the camera past its end.
   * Written only when they are given.
   */
  readonly speeds?: SpeedKeys;
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
    /**
     * Keys of the speed of the travel over the shot: [seconds from the start of
     * the shot, units per second], the first at 0, smooth from one key to the
     * next, the last kept to the end; `speed` is then not used. Written only
     * when they are given.
     */
    readonly speeds?: SpeedKeys;
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
