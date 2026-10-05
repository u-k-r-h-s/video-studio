import { z } from "zod";
import {
  CAMERA_MOVEMENTS,
  EMOTIONS,
  EMPHASES,
  ENTRANCES,
  INPUT_MODES,
  LANGUAGE_IDS,
  NARRATOR_ID,
  SHOTS,
  STAGE_IDS,
  STAGE_STATUSES,
} from "./constants";
import { ID_PATTERN, SCENE_ID_PATTERN } from "./ids";
import { StorySchema } from "./story";

const IdSchema = z.string().regex(ID_PATTERN, "must be lowercase kebab-case").max(64);

// ---------------------------------------------------------------------------------------------------------------
// Story content
// ---------------------------------------------------------------------------------------------------------------

export const CharacterSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(60),
  /** Who the character is (role, personality). */
  description: z.string().min(3).max(400),
  /** Physical appearance only: reused verbatim as the visual prompt fragment for every image of this character. */
  appearance: z.string().min(3).max(400),
  /** Optional id from config/voices.json. Assigned automatically when absent. */
  voiceId: z.string().optional(),
  /** Optional user-supplied art (project-relative path). NOT used as model conditioning in this version. */
  referenceImage: z.string().optional(),
  // --- character bible (shot-based stories). All optional so older projects stay valid.
  clothing: z.string().max(300).optional(),
  colors: z.array(z.string().max(30)).max(6).optional(),
  personality: z.string().max(300).optional(),
  /** The canonical visual prompt fragment reused in EVERY image of this character. Falls back to appearance + clothing. */
  visualIdentity: z.string().max(500).optional(),
});
export type Character = z.infer<typeof CharacterSchema>;

export const DialogueSchema = z.object({
  id: z.string().min(1).max(64),
  /** A character id, or "narrator". */
  characterId: z.string().min(1).max(64),
  text: z.string().trim().min(1, "can't be empty").max(300, "is too long (max 300 characters)"),
  emotion: z.enum(EMOTIONS).optional(),
  audioAssetId: z.string().optional(),
  /** Seconds from scene start. Filled by the timeline stage. */
  startTime: z.number().min(0).optional(),
  endTime: z.number().min(0).optional(),
});
export type Dialogue = z.infer<typeof DialogueSchema>;

export const CameraSchema = z.object({
  movement: z.enum(CAMERA_MOVEMENTS),
  shot: z.enum(SHOTS).default("medium"),
});
export type Camera = z.infer<typeof CameraSchema>;

/** High-level, LLM-friendly motion hints. A deterministic MotionPlanner turns them into Motion primitives. */
export const MotionHintsSchema = z.object({
  entrance: z.enum(ENTRANCES).default("left"),
  emphasis: z.enum(EMPHASES).default("none"),
});
export type MotionHints = z.infer<typeof MotionHintsSchema>;

export const SCENE_STATUSES = ["planned", "assets_ready", "voiced", "timed", "rendered", "failed"] as const;

export const SceneSchema = z.object({
  id: z.string().regex(SCENE_ID_PATTERN),
  order: z.number().int().min(1),
  /** Seconds. The timeline stage may extend it so the spoken lines fit. */
  duration: z.number().min(1).max(60),
  location: z.string().min(2).max(60),
  visualDescription: z.string().min(5).max(500),
  dialogue: z.array(DialogueSchema).max(8),
  characters: z.array(z.string().min(1)).max(4),
  props: z.array(z.string().min(2).max(60)).max(4),
  camera: CameraSchema,
  motion: MotionHintsSchema,
  generatedAssets: z.array(z.string()),
  status: z.enum(SCENE_STATUSES),
});
export type Scene = z.infer<typeof SceneSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------------------------------------------

export const ASSET_KINDS = ["background", "character", "prop", "subtitle", "scene_audio", "scene_video", "final_video", "key_visual", "shot_video", "audio_track", "caption", "anim_location", "anim_view", "anim_head", "anim_prop"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const AssetSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(ASSET_KINDS),
  sceneId: z.string().optional(),
  characterId: z.string().optional(),
  /** Project-relative path. */
  path: z.string().min(1),
  status: z.enum(["pending", "ready", "failed"]),
  /** Hash of everything that determined this asset; a changed hash means the asset is stale. */
  inputHash: z.string(),
  meta: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});
export type Asset = z.infer<typeof AssetSchema>;

export const AudioAssetSchema = z.object({
  id: z.string().min(1),
  dialogueId: z.string(),
  sceneId: z.string(),
  path: z.string().min(1),
  durationSec: z.number().min(0),
  voiceId: z.string(),
  inputHash: z.string(),
  createdAt: z.string(),
});
export type AudioAsset = z.infer<typeof AudioAssetSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------------------------------------------

export const PROJECT_STATUSES = ["draft", "planning", "review", "approved", "generating", "completed", "failed"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const StageStateSchema = z.object({
  status: z.enum(STAGE_STATUSES),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
});
export type StageState = z.infer<typeof StageStateSchema>;

export const ProjectErrorSchema = z.object({ stage: z.string(), message: z.string(), at: z.string() });

export const ProjectSchema = z.object({
  id: IdSchema,
  title: z.string(),
  inputMode: z.enum(INPUT_MODES),
  inputText: z.string(),
  formatProfile: z.string(),
  language: z.enum(LANGUAGE_IDS),
  targetDurationSeconds: z.number().min(5).max(180),
  scenes: z.array(SceneSchema),
  characters: z.array(CharacterSchema),
  /** Shot-based story (profiles whose pipeline is "shots"). Absent for scene-based projects. */
  story: StorySchema.optional(),
  assets: z.array(AssetSchema),
  audio: z.array(AudioAssetSchema),
  status: z.enum(PROJECT_STATUSES),
  /** The human has reviewed the scene plan; heavy generation may start. */
  reviewApproved: z.boolean(),
  stages: z.record(z.enum(STAGE_IDS), StageStateSchema),
  errors: z.array(ProjectErrorSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectInputSchema = z.object({
  title: z.string().trim().max(80).optional(),
  inputMode: z.enum(INPUT_MODES),
  inputText: z.string().trim().min(10, "Write at least a sentence").max(8000),
  formatProfile: z.string().default("motion-comic"),
  language: z.enum(LANGUAGE_IDS).default("en"),
  targetDurationSeconds: z.number().min(5).max(180).default(20),
});
export type CreateProjectInput = z.input<typeof CreateProjectInputSchema>;

/** The user-editable part of a project (what the review screen saves). */
export const PlanEditSchema = z.object({
  title: z.string().trim().min(1).max(80),
  characters: z.array(CharacterSchema).min(1).max(6),
  scenes: z.array(SceneSchema).min(1).max(20),
});
export type PlanEdit = z.infer<typeof PlanEditSchema>;

// ---------------------------------------------------------------------------------------------------------------
// LLM-facing plan schemas (what Ollama must return; deliberately smaller than the stored model)
// ---------------------------------------------------------------------------------------------------------------

export const PlannedCharacterSchema = z.object({
  id: IdSchema.describe("lowercase kebab-case id derived from the name"),
  name: z.string().min(1).max(60),
  description: z.string().min(3).max(400).describe("role and personality"),
  appearance: z.string().min(3).max(400).describe("physical appearance only: build, face, hair, clothing, colours"),
});

export const PlannedOutlineSchema = z.object({
  title: z.string().min(1).max(80),
  characters: z.array(PlannedCharacterSchema).min(1).max(6),
});
export type PlannedOutline = z.infer<typeof PlannedOutlineSchema>;

export const PlannedSceneSchema = z.object({
  location: z.string().min(2).max(60).describe("short name of the place"),
  visualDescription: z.string().min(5).max(500).describe("what we SEE: setting and action, one or two sentences"),
  characters: z.array(z.string().min(1)).max(4).describe("character ids visible in the scene"),
  props: z.array(z.string().min(2).max(60)).max(4).describe("important objects, e.g. 'wooden mousetrap'"),
  dialogue: z
    .array(
      z.object({
        characterId: z.string().min(1).describe(`a character id or "${NARRATOR_ID}"`),
        text: z.string().min(1).max(300),
        emotion: z.enum(EMOTIONS).optional(),
      }),
    )
    .max(8),
  camera: z.object({ movement: z.enum(CAMERA_MOVEMENTS), shot: z.enum(SHOTS).optional() }),
  motion: z.object({ entrance: z.enum(ENTRANCES).optional(), emphasis: z.enum(EMPHASES).optional() }).optional(),
  duration: z.number().min(1).max(60).optional(),
});

export const PlannedScenesSchema = z.object({ scenes: z.array(PlannedSceneSchema).min(1).max(20) });
export type PlannedScenes = z.infer<typeof PlannedScenesSchema>;

/**
 * Cross-field integrity checks that JSON Schema cannot express. Returns human-readable issues
 * (also sent back to the LLM when asking it to repair its output).
 */
export function validatePlanIntegrity(plan: { characters: { id: string }[]; scenes: Pick<Scene, "id" | "characters" | "dialogue" | "props">[] }): string[] {
  const issues: string[] = [];
  const known = new Set<string>();
  for (const c of plan.characters) {
    if (known.has(c.id)) issues.push(`Duplicate character id "${c.id}".`);
    known.add(c.id);
  }
  const list = [...known].join(", ");
  const sceneIds = new Set<string>();
  for (const scene of plan.scenes) {
    if (sceneIds.has(scene.id)) issues.push(`Duplicate scene id "${scene.id}".`);
    sceneIds.add(scene.id);
    for (const id of scene.characters) {
      if (!known.has(id)) issues.push(`${scene.id}: unknown character "${id}" (known: ${list}).`);
    }
    for (const line of scene.dialogue) {
      if (line.characterId !== NARRATOR_ID && !known.has(line.characterId)) {
        issues.push(`${scene.id}: dialogue speaker "${line.characterId}" is not a known character (known: ${list}, or "${NARRATOR_ID}").`);
      } else if (line.characterId !== NARRATOR_ID && !scene.characters.includes(line.characterId)) {
        issues.push(`${scene.id}: speaker "${line.characterId}" must be listed in the scene's characters.`);
      }
    }
  }
  return issues;
}
