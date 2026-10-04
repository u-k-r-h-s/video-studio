import { z } from "zod";
import { LANGUAGE_IDS } from "./constants";

/**
 * A FormatProfile is DATA that selects and configures pipeline components. The core pipeline never assumes a
 * "comic": it reads everything format-specific (resolution, providers, style, timing, layout) from the profile.
 * Adding a new video type means adding a profile, not changing the pipeline.
 */
export const FormatProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  description: z.string(),
  video: z.object({
    width: z.number().int().min(2).max(4096),
    height: z.number().int().min(2).max(4096),
    fps: z.number().int().min(1).max(60),
    /** "auto" prefers h264_videotoolbox and falls back to libx264. */
    videoEncoder: z.enum(["auto", "h264_videotoolbox", "libx264"]),
    videoBitrateKbps: z.number().int().min(500),
    crf: z.number().int().min(0).max(51),
    audioBitrateKbps: z.number().int().min(32),
    audioSampleRate: z.number().int().min(8000),
  }),
  /** Registry keys of the components used for this format. */
  sceneRenderer: z.string(),
  imageProvider: z.string(),
  ttsProvider: z.string(),
  subtitleRenderer: z.string(),
  visualStyle: z.object({
    name: z.string(),
    /** Prepended to every image prompt. */
    promptPrefix: z.string(),
    negativePrompt: z.string(),
  }),
  /** Generated image sizes per asset kind (provider-agnostic). */
  images: z.object({
    background: z.object({ width: z.number().int(), height: z.number().int() }),
    character: z.object({ width: z.number().int(), height: z.number().int() }),
    prop: z.object({ width: z.number().int(), height: z.number().int() }),
  }),
  timing: z.object({
    minSceneSeconds: z.number().min(1),
    maxSceneSeconds: z.number().min(2),
    defaultSceneSeconds: z.number().min(2),
    secondsPerScene: z.number().min(2),
    minScenes: z.number().int().min(1),
    maxScenes: z.number().int().min(1),
    leadInSeconds: z.number().min(0),
    gapSeconds: z.number().min(0),
    tailSeconds: z.number().min(0),
    wordsPerSecond: z.number().min(0.5),
  }),
  planning: z.object({
    maxCharacters: z.number().int().min(1),
    maxLocations: z.number().int().min(1),
    maxPropsPerScene: z.number().int().min(0),
    /** Format-specific guidance appended to the planner's system prompt. */
    styleGuidance: z.string(),
  }),
  /** Layout in canvas fractions (1.0 = full width / height) unless noted. */
  layout: z.object({
    characterHeight: z.number().min(0.05).max(1),
    characterBaseline: z.number().min(0).max(1.2),
    propHeight: z.number().min(0.02).max(1),
    propBaseline: z.number().min(0).max(1.2),
    subtitleY: z.number().min(0).max(1),
    subtitleWidthPx: z.number().int().min(100),
    subtitleFontPx: z.number().int().min(10),
    subtitleStrokePercent: z.number().min(0).max(30),
    subtitleFonts: z.record(z.enum(LANGUAGE_IDS), z.string()),
  }),
  /** Candidate voice ids per language (resolved against config/voices.json). Characters are assigned round-robin. */
  voices: z.object({
    narrator: z.record(z.enum(LANGUAGE_IDS), z.string()),
    characters: z.record(z.enum(LANGUAGE_IDS), z.array(z.string()).min(1)),
  }),
});
export type FormatProfile = z.infer<typeof FormatProfileSchema>;
