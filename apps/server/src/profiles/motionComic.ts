import type { FormatProfile } from "@studio/shared";

/**
 * The first format profile. Everything comic-specific (style prompt, layout, planner guidance) lives here as data;
 * the pipeline itself only reads a FormatProfile.
 */
export const motionComic: FormatProfile = {
  id: "motion-comic",
  name: "Motion comic (vertical short)",
  description: "Still illustrations with camera moves and sliding cut-out characters, narrated and subtitled. 1080x1920 for Shorts.",
  video: { width: 1080, height: 1920, fps: 30, videoEncoder: "auto", videoBitrateKbps: 10000, crf: 20, audioBitrateKbps: 160, audioSampleRate: 44100 },
  sceneRenderer: "ffmpeg-motion",
  imageProvider: "comfyui",
  ttsProvider: "piper",
  subtitleRenderer: "coretext",
  visualStyle: {
    name: "Original comic",
    promptPrefix: "flat colour comic book illustration, bold black ink outlines, simple clean shapes, vibrant but controlled palette",
    negativePrompt: "photo, photorealistic, blurry, text, watermark, signature, deformed, extra limbs, ugly",
  },
  images: { background: { width: 512, height: 896 }, character: { width: 512, height: 896 }, prop: { width: 512, height: 512 } },
  timing: { minSceneSeconds: 3, maxSceneSeconds: 14, defaultSceneSeconds: 6, secondsPerScene: 7, minScenes: 2, maxScenes: 8, leadInSeconds: 0.4, gapSeconds: 0.35, tailSeconds: 0.7, wordsPerSecond: 2.6 },
  planning: {
    maxCharacters: 3,
    maxLocations: 2,
    maxPropsPerScene: 2,
    styleGuidance:
      "Comic short: a hook in scene 1, a clear escalation, and a satisfying twist or punchline in the last scene. Keep dialogue short and punchy (at most 15 words per line). Characters must be original: never reuse characters, names or plots from existing comics, films or franchises.",
  },
  layout: {
    characterHeight: 0.53,
    characterBaseline: 1.015,
    propHeight: 0.13,
    propBaseline: 0.93,
    subtitleY: 0.7,
    subtitleWidthPx: 980,
    subtitleFontPx: 68,
    subtitleStrokePercent: 5,
    subtitleFonts: { en: "Helvetica Neue", hi: "Kohinoor Devanagari" },
  },
  voices: { narrator: { en: "en-narrator", hi: "hi-rohan" }, characters: { en: ["en-a", "en-b"], hi: ["hi-rohan"] } },
};
