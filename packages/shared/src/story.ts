import { z } from "zod";
import {
  ANIM_ACTIONS,
  ANIM_WHEN,
  OBJECT_ACTIONS,
  BEATS,
  CHARACTER_ACTIONS,
  EMOTIONS,
  SFX_KINDS,
  SHOT_MOTIONS,
  SHOT_TYPES,
  STORY_EMOTIONS,
  TRANSITIONS,
} from "./constants";

const norm = z.number().min(0).max(1);

/** A spoken line inside a shot (same fields as scene Dialogue, plus words to emphasise in captions). */
export const ShotDialogueSchema = z.object({
  id: z.string().min(1).max(64),
  /** A character id, or "narrator". */
  characterId: z.string().min(1).max(64),
  text: z.string().trim().min(1, "can't be empty").max(300),
  emotion: z.enum(EMOTIONS).optional(),
  audioAssetId: z.string().optional(),
  startTime: z.number().min(0).optional(),
  endTime: z.number().min(0).optional(),
  emphasis: z.array(z.string()).max(4).optional(),
});

/** Environments are established once and reused: every shot there derives its prompt from `visualIdentity`. */
export const LocationSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(48),
  name: z.string().min(1).max(80),
  description: z.string().min(3).max(400),
  /** Canonical visual prompt fragment (architecture, materials, atmosphere) reused for every shot in this place. */
  visualIdentity: z.string().min(3).max(500),
  lighting: z.string().min(3).max(200),
  importantObjects: z.array(z.string().max(60)).max(6),
});
export type Location = z.infer<typeof LocationSchema>;

/**
 * Camera rig in normalised units. `scale` >= 1 is zoom relative to the frame; x/y are the crop position inside the
 * available slack (0 = left/top, 0.5 = centre, 1 = right/bottom); rotation in degrees.
 */
export const CameraRigSchema = z.object({
  startScale: z.number().min(1).max(1.6),
  endScale: z.number().min(1).max(1.6),
  startX: norm,
  endX: norm,
  startY: norm,
  endY: norm,
  rotation: z.number().min(-12).max(12).optional(),
  endRotation: z.number().min(-12).max(12).optional(),
});
export type CameraRig = z.infer<typeof CameraRigSchema>;

/** What happens physically in a shot, as the director states it: the engine places and times it. */
export const AnimActionSchema = z.object({
  character: z.string().min(1).max(64),
  action: z.enum(ANIM_ACTIONS),
  when: z.enum(ANIM_WHEN).default("mid"),
  /** Seconds; derived from the action when absent. */
  duration: z.number().min(0.1).max(8).optional(),
  /** walk/run/enter: a screen position ("left" | "center" | "right") or an x in stage px; turn/head-turn: "left" | "right" | "camera". */
  to: z.union([z.enum(["left", "center", "right", "camera"]), z.number()]).optional(),
});
export const ObjectActionSchema = z.object({
  object: z.string().min(1).max(64),
  action: z.enum(OBJECT_ACTIONS),
  when: z.enum(ANIM_WHEN).default("mid"),
  duration: z.number().min(0.1).max(8).optional(),
});
export type ShotAnimAction = z.infer<typeof AnimActionSchema>;
export type ShotObjectAction = z.infer<typeof ObjectActionSchema>;

export const ShotSchema = z.object({
  id: z.string().regex(/^shot-\d{2,3}$/),
  sceneId: z.string(),
  order: z.number().int().min(1),
  beat: z.enum(BEATS),
  /** Seconds. Extended by the timeline when a spoken line needs more room. */
  duration: z.number().min(0.6).max(10),
  shotType: z.enum(SHOT_TYPES),
  subjectIds: z.array(z.string()).max(3),
  locationId: z.string(),
  emotion: z.enum(STORY_EMOTIONS),
  /** What happens in this shot (used for the image prompt and the camera language). */
  action: z.string().min(3).max(300),
  /** Extra visual direction for the key image (pose, expression, props, framing details). */
  visualPrompt: z.string().min(3).max(500),
  /** Which key visual (generated image) this shot is built from; shots may share one. */
  visualKey: z.string().min(1).max(64),
  /** Soft subject region (normalised) used for depth-of-field and parallax. */
  focus: z.object({ x: norm, y: norm, rx: z.number().min(0.05).max(0.8), ry: z.number().min(0.05).max(0.8) }).optional(),
  camera: CameraRigSchema,
  motion: z.object({ type: z.enum(SHOT_MOTIONS), shake: z.number().min(0).max(0.02).optional() }),
  transition: z.object({ type: z.enum(TRANSITIONS), duration: z.number().min(0.05).max(1.5).optional() }),
  characterMotion: z.array(z.object({ action: z.enum(CHARACTER_ACTIONS), at: z.number().min(0).optional(), strength: z.number().min(0).max(1).optional() })).max(4),
  dialogue: z.array(ShotDialogueSchema).max(2),
  sfx: z.array(z.object({ kind: z.enum(SFX_KINDS), at: z.number().min(0), volume: z.number().min(0).max(1).optional() })).max(4),
  /** UI-style text drawn into the frame (phone message, title card). */
  insert: z.object({ kind: z.enum(["phone", "title"]), text: z.string().min(1).max(80) }).optional(),
  effects: z.object({ flash: z.boolean().optional(), impact: z.boolean().optional() }).optional(),
  /** Physical action for the layered animation engine. */
  animation: z.object({ actions: z.array(AnimActionSchema).max(8), objects: z.array(ObjectActionSchema).max(6) }).optional(),
});
export type Shot = z.infer<typeof ShotSchema>;

export const KEY_VISUAL_KINDS = ["environment", "portrait", "action", "insert"] as const;
/** A generated image that one or more shots are built from. */
export const KeyVisualSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(KEY_VISUAL_KINDS),
  locationId: z.string(),
  subjectIds: z.array(z.string()),
  prompt: z.string().min(3),
  shotIds: z.array(z.string()),
  /** img2img from another key visual so identity carries over (portrait variants, the "double"). */
  initFrom: z.object({ keyId: z.string(), denoise: z.number().min(0.2).max(0.9) }).optional(),
});
export type KeyVisual = z.infer<typeof KeyVisualSchema>;

export const StorySceneSchema = z.object({ id: z.string(), locationId: z.string(), beat: z.enum(BEATS), summary: z.string().min(3).max(300), shotIds: z.array(z.string()) });

export const StorySchema = z.object({
  logline: z.string().min(5).max(300),
  beats: z.array(z.object({ kind: z.enum(BEATS), summary: z.string().min(3).max(300) })).min(2).max(8),
  locations: z.array(LocationSchema).min(1).max(5),
  scenes: z.array(StorySceneSchema).min(1).max(8),
  shots: z.array(ShotSchema).min(3).max(20),
  keyVisuals: z.array(KeyVisualSchema).max(14),
});
export type Story = z.infer<typeof StorySchema>;

/** One element on the audio timeline (voice, music, SFX, ambience). */
export const AudioTrackSchema = z.object({
  type: z.enum(["voice", "music", "sfx", "ambient"]),
  path: z.string().min(1),
  startTime: z.number().min(0),
  duration: z.number().min(0).optional(),
  volume: z.number().min(0).max(2),
});
export type AudioTrack = z.infer<typeof AudioTrackSchema>;
