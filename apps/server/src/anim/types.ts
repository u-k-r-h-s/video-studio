/**
 * Layered 2D/2.5D animation model. A shot is a stack of VisualLayers (background -> foreground), characters built from
 * body-part rigs, a list of timed AnimationEvents that move/animate any target, a camera, and procedural effects.
 * Everything is DATA: the director (or a hand-written script) produces it, the engine evaluates and renders it.
 */
export const LAYER_TYPES = ["background", "midground", "character", "prop", "foreground", "effect"] as const;
export type LayerType = (typeof LAYER_TYPES)[number];

export interface VisualLayer {
  id: string;
  type: LayerType;
  /** Characters: rig id (defaults to `source`). */
  rig?: string;
  /** Asset id in the AssetLibrary (a PNG with or without alpha). For characters: the rig id. */
  source: string;
  /** World position in stage pixels (1080x1920 at camera zoom 1). Characters/props: bottom-centre; backgrounds: centre. */
  x: number;
  y: number;
  scale: number;
  opacity: number;
  zIndex: number;
  /** Degrees. */
  rotation?: number;
  /** How much the layer follows the camera: 1 = locked to the world (characters, ground), < 1 = distant, > 1 = foreground. */
  parallax?: number;
  /** On-screen height in px at scale 1 (props/characters/backgrounds). Width follows the aspect ratio. */
  height?: number;
  flipX?: boolean;
  /** CSS colour mixed over the layer ("#203050") with `tintAmount` 0..1 (lighting match). */
  tint?: string;
  tintAmount?: number;
  /** Gaussian blur in px (depth of field for far/near layers). */
  blur?: number;
  blend?: "normal" | "screen" | "multiply" | "lighter";
  /** Follow another layer's position/scale/rotation (a lit variant of a prop, a hand-held item) while keeping own opacity. */
  attach?: string;
  /** Characters: contact shadow under the feet. */
  shadow?: boolean;
  /** Characters: rim-light colour and side (+1 = light from the right). */
  rim?: { color: string; side: 1 | -1; amount?: number };
  /** Props that act as a door: hinge side and the colour of the light behind it. */
  door?: { hinge: "left" | "right"; glow: string };
  /** Drawn only inside this world rectangle (e.g. a door's interior). */
  hidden?: boolean;
}

export const CHARACTER_PRIMITIVES = [
  "idle", "walk", "run", "enter", "exit", "turn", "look-left", "look-right", "look-up", "look-down", "look-center", "head-turn", "nod", "shake-head",
  "lean", "step-forward", "step-back", "hand-gesture", "point", "react", "surprise", "fear", "anger", "smile", "neutral", "stop",
] as const;
export const OBJECT_PRIMITIVES = ["move", "scale", "rotate", "fade", "appear", "disappear", "shake", "flicker", "open", "close", "glow", "drive", "particle"] as const;
export const CAMERA_PRIMITIVES = ["camera"] as const;
export const EVENT_TYPES = [...CHARACTER_PRIMITIVES, ...OBJECT_PRIMITIVES, ...CAMERA_PRIMITIVES] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type ParamValue = number | string | boolean;
export interface AnimationEvent {
  /** Seconds from the start of the shot. */
  start: number;
  duration: number;
  /** A layer id, or "camera". */
  targetId: string;
  type: EventType;
  params?: Record<string, ParamValue>;
}

export type EffectType = "rain" | "fog" | "dust" | "snow" | "smoke" | "leaves" | "lightFlicker" | "sparks" | "streaks";
export interface EffectSpec {
  type: EffectType;
  /** 0..1 amount. */
  intensity?: number;
  /** Draw behind characters ("back"), or over everything ("front"). */
  layer?: "back" | "front";
  /** Seconds the effect is active; default the whole shot. */
  start?: number;
  end?: number;
  color?: string;
  /** Wind / fall angle in degrees from vertical (rain/snow/leaves). */
  angle?: number;
  speed?: number;
  /** Position for local effects (lightFlicker, smoke, sparks) in world px. */
  x?: number;
  y?: number;
  radius?: number;
  seed?: number;
}

export interface CameraState { x: number; y: number; zoom: number; rotation: number }

export interface AnimShotSpec {
  id: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  /** Background colour behind everything. */
  backdrop?: string;
  layers: VisualLayer[];
  events: AnimationEvent[];
  effects: EffectSpec[];
  camera: CameraState;
  seed?: number;
}

/** Sound cues implied by the animation (footsteps on foot contacts, door creaks, phone pings, impacts). */
export interface AudioCue { kind: "footsteps" | "door" | "ping" | "impact" | "whoosh" | "glitch" | "heartbeat" | "ding"; at: number; volume?: number }
