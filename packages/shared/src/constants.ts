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
