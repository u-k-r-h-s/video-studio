/**
 * The 3D shot description: what the Three.js renderer draws for ONE shot. It is DATA (JSON), produced by the 3D animation
 * compiler (compile.ts) from the Director's semantic shot, and read by the renderer runtime inside the browser. Units are
 * metres and seconds; no bone angles: the runtime decides how an action is performed with the character's clips.
 */

/** Semantic character actions the runtime knows how to perform (clips + layered procedural motion). */
export const ACTIONS_3D = [
  "idle", "walk", "run", "stop", "turn", "look", "look-around", "wave", "point", "reach", "push", "pull",
  "hold", "raise", "lower", "release", "react", "fear", "surprise", "nod", "shake-head", "step-back", "press", "adjust", "hesitate",
] as const;
export type Action3D = (typeof ACTIONS_3D)[number];

export const EXPRESSIONS = ["neutral", "happy", "sad", "angry", "worried", "surprised", "fear"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

/** A point in the set, or a named thing in it ("door", "camera", another character's id). */
export type Target = { x: number; y?: number; z: number } | string;

export interface CharacterEvent3D {
  at: number;
  action: Action3D;
  /** Movement goal (walk/run), facing / look target (turn/look/point), or object (reach/push/pull/raise). */
  target?: Target;
  duration?: number;
  /** For hold/raise/lower/release: which prop; for push/pull: which set object. */
  prop?: string;
}

/** One spoken line of this character (lip-sync): the audio envelope per frame and the visemes over time, shot-local seconds. */
export interface SpeechSpec3D { at: number; duration: number; fps: number; env: number[]; visemes: { t: number; v: string }[]; expression?: Expression }

export interface CharacterSpec3D {
  id: string;
  /** Asset key in the 3D character library (assets/3d/characters/<key>/character.glb). */
  asset: string;
  start: { x: number; z: number; heading?: Target | number };
  /** Material colour overrides (material name -> CSS colour): one base model dressed for the story. */
  wardrobe?: Record<string, string>;
  scale?: number;
  props?: PropSpec3D[];
  expression?: Expression;
  /** Lines this character speaks in the shot: the mouth follows them, and the body uses its talking gestures. */
  speech?: SpeechSpec3D[];
  /** When the others in the shot speak (this character listens). */
  listen?: { at: number; duration: number }[];
  /** Changes of expression during the shot (a listener's face reacting to what it hears). */
  expressions?: { at: number; expression: Expression }[];
  events: CharacterEvent3D[];
}

export const PROP_KINDS = ["flashlight", "phone", "bag", "box", "keys", "tool", "weapon", "generic"] as const;
export type PropKind3D = (typeof PROP_KINDS)[number];
/** A prop attached to a socket of the character ("rightHand", "leftHand", "back", "hip"). */
export interface PropSpec3D {
  id: string; kind: PropKind3D; socket: "rightHand" | "leftHand" | "back" | "hip"; color?: string; on?: boolean;
  /** The prop starts in the world here (on a table, a step) and goes to its socket when a `hold` event picks it up. */
  restAt?: { x: number; y: number; z: number; rotation?: number };
}

export const CAMERA_SHOTS = ["wide", "medium", "closeup", "over_shoulder"] as const;
export const CAMERA_MOVES = ["static", "follow", "tracking", "push_in", "pull_out", "pan", "tilt", "handheld"] as const;
export interface CameraSpec3D {
  shot: (typeof CAMERA_SHOTS)[number];
  move: (typeof CAMERA_MOVES)[number];
  /** Character id the camera frames, or a named set point ("door"). */
  target: string;
  /** Second target the movement goes toward (e.g. push toward the door at the end). */
  toward?: string;
  /** Which side of the subject the camera sits on (-1 left, +1 right) and whether it looks over the shoulder from behind. */
  side?: number;
  behind?: boolean;
  /** Camera angle around the subject, from its facing direction (rad): 0 = in front, PI/2 = profile, PI = behind. Overrides `behind`. */
  angle?: number;
  /** Keep this named thing in the frame too (a door that opens, what the character looks at): the camera widens and re-centres. */
  frameWith?: string;
  /** Timed changes: at `at` seconds blend to a new framing/target over `blend` seconds. */
  keys?: { at: number; shot?: CameraSpec3D["shot"]; target?: string; behind?: boolean; side?: number; blend?: number; frameWith?: string | null }[];
  handheld?: number;
  /** Camera height relative to the framing's (m): negative = a low angle looking up, positive = looking down. */
  heightOffset?: number;
  /** Lens: < 1 a longer lens (narrower, the camera backs off to keep the framing), > 1 wider. */
  fovScale?: number;
  /** The set's open front (a direction on the ground): a two-shot with both sides free is taken from there, facade behind. */
  front?: { x: number; z: number };
}

export const LIGHTING_PRESETS = [
  "sunny-day", "cloudy-day", "overcast", "golden-hour", "sunset", "rainy-day", "night", "cinematic-night", "rainy-night",
  "indoor-daylight", "warm-interior", "cold-interior", "foggy-dawn", "power-outage",
  // older names, kept as aliases
  "day", "warehouse", "street", "rain", "horror",
] as const;
export type LightingPreset = (typeof LIGHTING_PRESETS)[number];

export interface SetObject3D {
  id: string;
  kind: "door" | "lamp" | "crate" | "barrel" | "pallet" | "dumpster" | "pipe" | "puddle" | "sign" | "tree" | "car" | "mailbox" | "hedge" | "streetlamp" | "bench" | "cable";
  x: number; z: number; y?: number; rotation?: number; scale?: number;
  /** door: width/height, hinge side and the light behind it; lamp: colour/intensity. */
  params?: Record<string, number | string | boolean>;
  /** door: open/close events. */
  events?: { at: number; action: "open" | "close" | "flicker" | "on" | "off"; duration?: number }[];
}

export interface EnvironmentSpec3D {
  /** Built-in set kit name ("warehouse-exterior") or "glb" with a path. */
  kind: "warehouse-exterior" | "neighborhood" | "village" | "market" | "interior" | "road" | "street" | "nature" | "city" | "glb" | "plate";
  /** The lights are off (a power cut): an interior lit only by a candle and the window. */
  lightsOut?: boolean;
  glb?: string;
  /** AI-painted plate placed behind the 3D set (hybrid 2.5D): a file path, resolved by the host. */
  backdrop?: string;
  /** Texture for the main wall (AI-generated or procedural). */
  wallTexture?: string;
  groundTexture?: string;
  objects: SetObject3D[];
  weather?: { rain?: number; fog?: number; wind?: number };
  /** House / building colours for kits that have them (neighbourhood siding, door). */
  palette?: { wall?: string; door?: string; trim?: string; roof?: string };
  /** The living world around the set, decided by the visual plan from the story (visualPlan.ts planWorld). Only what is
   *  listed is built: no traffic indoors, no sun at night, no birds in a storm. */
  world?: WorldSpec3D;
}

export type VehicleKind3D = "car" | "auto" | "bus" | "scooter" | "motorcycle" | "bicycle";
export interface WorldSpec3D {
  /** Natural surroundings (the "nature" kit builds them; others ignore relief/water). */
  landscape?: { relief: "flat" | "hills" | "mountains"; water?: "river" | "lake" | "sea" | "waterfall"; forest?: number; grass?: number; crop?: "wheat" | "mustard" | "paddy"; palms?: boolean; snow?: boolean };
  /** Clouds (count, drift in m/s) and birds (flocks of a few). */
  sky?: { clouds: number; cloudSpeed: number; birds: number };
  /** Vehicles on the kit's road (behind the action, never through the camera). rate = vehicles per minute per lane. */
  traffic?: { mix: VehicleKind3D[]; rate: number; lanes: 1 | 2 | 4; stop?: { kind: VehicleKind3D; dwell: number } };
  /** Background walkers on the far sidewalk (models from the character library). */
  pedestrians?: { assets: string[]; count: number };
  streetlights?: boolean;
  /** Why each element is there (or not): the story words / fields that decided it. */
  why?: string[];
}

export interface Shot3DSpec {
  id: string;
  /** Art direction: the shading model and exposure bias of the style (artStyle.ts). */
  style?: { id: string; shading: "pbr" | "toon"; exposure: number };
  duration: number;
  width: number;
  height: number;
  fps: number;
  seed: number;
  lighting: LightingPreset;
  /** Sun direction around the set (degrees azimuth; the preset keeps its elevation). Undefined: the preset's own. */
  sunAzimuth?: number;
  environment: EnvironmentSpec3D;
  characters: CharacterSpec3D[];
  camera: CameraSpec3D;
  /** Records every drawn frame's character transforms (root, heading, bone world rotations, feet) in info().trace:
   *  evidence of what the renderer actually drew, for motion-continuity checks. Off in production. */
  trace?: boolean;
}

/** Sounds the 3D animation implies (footsteps on foot contacts, door creak, impacts), in shot seconds. */
export interface Cue3D { kind: "footsteps" | "door" | "impact" | "whoosh" | "ping"; at: number; volume?: number }
