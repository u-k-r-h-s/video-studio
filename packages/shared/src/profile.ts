import { z } from "zod";
import { LANGUAGE_IDS } from "./constants";

/**
 * A FormatProfile is DATA that selects and configures pipeline components. The core pipeline never assumes a
 * "comic": it reads everything format-specific (resolution, providers, style, timing, layout) from the profile.
 * Adding a new video type means adding a profile, not changing the pipeline.
 */
/** Settings of the shot-based pipeline (`pipeline: "shots"`): a story of shots built from a few key images. */
export const CinematicSettingsSchema = z.object({
  /** Image model id registered in the image provider (see config: COMFYUI models). */
  imageModel: z.string().min(1),
  keyImage: z.object({ width: z.number().int().min(256), height: z.number().int().min(256), steps: z.number().int().min(1).max(50), cfg: z.number().min(0.5).max(12) }),
  /** Budget: at most this many generated images per video; shots share and vary them. */
  maxKeyImages: z.number().int().min(2).max(14),
  minShots: z.number().int().min(3),
  maxShots: z.number().int().max(24),
  /** Prepended to every key-image prompt (the look of the whole video). */
  stylePrefix: z.string().min(3),
  negativePrompt: z.string(),
  /** Piper --length-scale for dialogue (>1 = slower, more dramatic). */
  voiceLengthScale: z.number().min(0.7).max(2),
  /** Estimated speaking speed with that scale (words per second), used before real audio exists. */
  wordsPerSecond: z.number().min(0.8),
  bitrateKbps: z.number().int().min(2000),
  captions: z.object({ font: z.string(), size: z.number().int().min(20), maxWidth: z.number().int().min(200), stroke: z.number().min(0).max(20), highlight: z.string().regex(/^[0-9A-Fa-f]{6}$/), emphasisColour: z.string().regex(/^[0-9A-Fa-f]{6}$/) }),
  /** Post-production look (all optional overrides of the renderer defaults). */
  grade: z.object({ contrast: z.number(), saturation: z.number(), vignette: z.number(), grain: z.number(), bloom: z.number(), haze: z.number(), gamma: z.number() }).partial().optional(),
});
export type CinematicSettings = z.infer<typeof CinematicSettingsSchema>;

/** Settings of the animated pipeline (`pipeline: "animated"`): which assets are generated at which size, and how. */
export const AnimationSettingsSchema = z.object({
  imageModel: z.string().min(1),
  /** Prepended to every asset prompt. */
  stylePrefix: z.string().min(3),
  negativePrompt: z.string(),
  location: z.object({ width: z.number().int().min(256), height: z.number().int().min(256), steps: z.number().int().min(1).max(50), cfg: z.number().min(0.5).max(12) }),
  character: z.object({ width: z.number().int().min(256), height: z.number().int().min(256), steps: z.number().int().min(1).max(50), cfg: z.number().min(0.5).max(12), viewDenoise: z.number().min(0.2).max(0.95) }),
  head: z.object({ size: z.number().int().min(256), steps: z.number().int().min(1).max(50) }),
  prop: z.object({ width: z.number().int().min(256), height: z.number().int().min(256), steps: z.number().int().min(1).max(50), cfg: z.number().min(0.5).max(12) }),
  /** Character height on the stage (px of the 1920 high frame) in a wide shot. */
  characterHeight: z.number().int().min(300).max(1600),
  voiceLengthScale: z.number().min(0.7).max(2),
  wordsPerSecond: z.number().min(0.8),
  bitrateKbps: z.number().int().min(2000),
  minShots: z.number().int().min(3),
  maxShots: z.number().int().max(24),
  maxPropKinds: z.number().int().min(0).max(8),
  /** Shot renderer: the 2D puppet engine (default) or rigged 3D characters in Three.js (`npm run short -- --renderer=3d`). */
  renderer: z.enum(["canvas2d", "three3d"]).optional(),
  captions: z.object({ font: z.string(), size: z.number().int().min(20), maxWidth: z.number().int().min(200), stroke: z.number().min(0).max(20), highlight: z.string().regex(/^[0-9A-Fa-f]{6}$/), emphasisColour: z.string().regex(/^[0-9A-Fa-f]{6}$/) }),
  grade: z.object({ contrast: z.number(), saturation: z.number(), vignette: z.number(), grain: z.number(), bloom: z.number(), haze: z.number(), gamma: z.number() }).partial().optional(),
});
export type AnimationSettings = z.infer<typeof AnimationSettingsSchema>;

export const FormatProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  description: z.string(),
  /** "scenes": background + cut-out characters per scene (motion comic). "shots": story -> shots -> key images -> 2.5D camera. */
  pipeline: z.enum(["scenes", "shots", "animated"]).optional(),
  /** Required when `pipeline` is "animated": sizes and settings of the generated assets and the layered renderer. */
  animation: AnimationSettingsSchema.optional(),
  /** Required when `pipeline` is "shots". */
  cinematic: CinematicSettingsSchema.optional(),
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
    /** Prepended to background image prompts. */
    promptPrefix: z.string(),
    /**
     * Style words for characters and props (cut-outs). Kept separate from `promptPrefix` on purpose: measured on the
     * target model, "comic illustration / character design" wording makes SD 1.5 draw framed posters that cannot be cut out.
     */
    cutoutStyle: z.string(),
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
    /** Opacity of the dark box behind subtitles (0 = none). */
    subtitleBoxAlpha: z.number().min(0).max(1),
    subtitleFonts: z.record(z.enum(LANGUAGE_IDS), z.string()),
  }),
  /** Candidate voice ids per language (resolved against config/voices.json). Characters are assigned round-robin. */
  voices: z.object({
    narrator: z.record(z.enum(LANGUAGE_IDS), z.string()),
    characters: z.record(z.enum(LANGUAGE_IDS), z.array(z.string()).min(1)),
  }),
});
export type FormatProfile = z.infer<typeof FormatProfileSchema>;
