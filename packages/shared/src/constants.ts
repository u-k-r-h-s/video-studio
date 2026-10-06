/** Reserved speaker id for narration lines. */
export const NARRATOR_ID = "narrator";

export const LANGUAGES = [
  { id: "en", label: "English" },
  { id: "hi", label: "Hindi" },
] as const;
export type LanguageId = (typeof LANGUAGES)[number]["id"];
export const LANGUAGE_IDS = LANGUAGES.map((l) => l.id) as [LanguageId, ...LanguageId[]];

export const INPUT_MODES = ["idea", "script"] as const;
export type InputMode = (typeof INPUT_MODES)[number];

/** Pipeline stages in execution order. Heavy stages are strictly sequential (see MemoryGate). */
export const PIPELINE_STAGES = [
  { id: "scene_planning", label: "Scene Planning" },
  { id: "image_generation", label: "Image Generation" },
  { id: "voice_generation", label: "Voice Generation" },
  { id: "subtitles", label: "Subtitles & Timeline" },
  { id: "scene_render", label: "Scene Render" },
  { id: "assembly", label: "Final Assembly" },
] as const;
export type StageId = (typeof PIPELINE_STAGES)[number]["id"];
export const STAGE_IDS = PIPELINE_STAGES.map((s) => s.id) as [StageId, ...StageId[]];

export const STAGE_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const CAMERA_MOVEMENTS = ["static", "zoom_in", "zoom_out", "pan_left", "pan_right"] as const;
export const SHOTS = ["wide", "medium", "close_up"] as const;
export const EMOTIONS = ["neutral", "happy", "angry", "surprised", "suspicious", "thinking", "scared", "sad", "excited"] as const;
export const ENTRANCES = ["left", "right", "none"] as const;
export const EMPHASES = ["none", "impact", "surprise"] as const;
export const EASINGS = ["linear", "ease_in", "ease_out", "ease_in_out", "ease_out_back"] as const;
export type Easing = (typeof EASINGS)[number];

// ---------------------------------------------------------------------------------------------------------------
// Shot-based storytelling (profile pipeline "shots")
// ---------------------------------------------------------------------------------------------------------------
export const SHOT_TYPES = [
  "extreme-close-up", "close-up", "medium-close", "medium", "medium-wide", "wide", "establishing",
  "over-shoulder", "pov", "low-angle", "high-angle", "tracking", "action",
] as const;
export type ShotType = (typeof SHOT_TYPES)[number];

/** Story pacing beats the director plans explicitly. */
export const BEATS = ["hook", "setup", "curiosity", "conflict", "escalation", "payoff"] as const;
export type Beat = (typeof BEATS)[number];

export const SHOT_MOTIONS = ["static", "push-in", "pull-out", "pan", "tilt", "tracking", "shake", "parallax", "action"] as const;
export type ShotMotion = (typeof SHOT_MOTIONS)[number];

export const TRANSITIONS = ["cut", "fade", "zoom", "match-cut"] as const;

export const STORY_EMOTIONS = ["neutral", "calm", "curious", "uneasy", "tense", "fear", "shock", "anger", "sad", "joy", "awe", "eerie"] as const;
export type StoryEmotion = (typeof STORY_EMOTIONS)[number];

/** Reusable character-motion primitives (image transforms + keyframe cuts, not rigging). */
export const CHARACTER_ACTIONS = [
  "idle", "breathing", "head-turn", "look-left", "look-right", "nod", "shake-head", "gesture",
  "step-forward", "step-back", "lean", "reaction", "surprise", "fear", "anger", "smile", "impact",
] as const;

export const SFX_KINDS = ["whoosh", "whoosh-rise", "impact", "ping", "ding", "door", "footsteps", "heartbeat", "riser", "glitch"] as const;
export type SfxKind = (typeof SFX_KINDS)[number];

/** Animation vocabulary for the layered engine (see docs/animation.md). `when` places an action in its shot without the model writing numbers. */
export const ANIM_ACTIONS = ["idle", "walk", "run", "enter", "exit", "turn", "look-left", "look-right", "look-up", "look-down", "look-center", "head-turn", "nod", "shake-head", "lean", "step-forward", "step-back", "hand-gesture", "point", "react", "surprise", "fear", "anger", "smile", "raise-hand", "wave", "reach", "push", "pull", "raise-object", "lower-object", "hold-phone", "listen", "press", "adjust", "hesitate"] as const;
export type AnimActionName = (typeof ANIM_ACTIONS)[number];
export const ANIM_WHEN = ["start", "early", "mid", "late", "end"] as const;
export type AnimWhenName = (typeof ANIM_WHEN)[number];
export const OBJECT_ACTIONS = ["appear", "disappear", "move", "open", "close", "glow", "shake", "drive", "flicker", "hold"] as const;
export type ObjectActionName = (typeof OBJECT_ACTIONS)[number];
