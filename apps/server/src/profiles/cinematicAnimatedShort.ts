import type { FormatProfile } from "@studio/shared";

/**
 * "Cinematic animated short": a story of SHOTS (not scenes), each built from one of a handful of generated key images
 * with a 2.5D camera, parallax, depth of field, character micro-motion, grade, procedural sound and word-timed captions.
 * Everything format-specific is data; the shot pipeline stages read it.
 */
export const cinematicAnimatedShort: FormatProfile = {
  id: "cinematic-animated-short",
  name: "Cinematic animated short (2.5D)",
  description: "Premium-looking vertical short: a director's shot list, ~6-8 generated key images, 2.5D camera moves, SFX, music and animated captions. 1080x1920.",
  pipeline: "shots",
  video: { width: 1080, height: 1920, fps: 30, videoEncoder: "auto", videoBitrateKbps: 14000, crf: 17, audioBitrateKbps: 192, audioSampleRate: 44100 },
  sceneRenderer: "ffmpeg-motion",
  imageProvider: "comfyui",
  ttsProvider: "piper",
  subtitleRenderer: "coretext",
  visualStyle: {
    name: "Moody 3D animated film",
    promptPrefix: "cinematic still from a stylized 3D animated film, dramatic lighting, volumetric haze, rich colour grading, shallow depth of field, highly detailed",
    cutoutStyle: "",
    negativePrompt: "photo, blurry, low quality, text, watermark, deformed, ugly, extra limbs, cartoon flat, clip art, cropped",
  },
  images: { background: { width: 512, height: 896 }, character: { width: 512, height: 896 }, prop: { width: 512, height: 512 } },
  timing: { minSceneSeconds: 1, maxSceneSeconds: 30, defaultSceneSeconds: 6, secondsPerScene: 8, minScenes: 1, maxScenes: 8, leadInSeconds: 0.3, gapSeconds: 0.22, tailSeconds: 0.35, wordsPerSecond: 2.4 },
  planning: {
    maxCharacters: 3,
    maxLocations: 3,
    maxPropsPerScene: 0,
    styleGuidance:
      "Mystery/thriller tone unless the idea says otherwise: moody, a strong hook, escalating tension, a twist at the end. Dialogue is short and punchy (at most 12 words per line). Characters must be original.",
  },
  layout: { characterHeight: 0.5, characterBaseline: 1, propHeight: 0.1, propBaseline: 0.9, subtitleY: 0.7, subtitleWidthPx: 960, subtitleFontPx: 112, subtitleStrokePercent: 7, subtitleBoxAlpha: 0, subtitleFonts: { en: "Impact", hi: "Kohinoor Devanagari" } },
  voices: { narrator: { en: "en-narrator", hi: "hi-rohan" }, characters: { en: ["en-a", "en-b", "en-c"], hi: ["hi-rohan"] } },
  cinematic: {
    imageModel: "ds8",
    keyImage: { width: 512, height: 896, steps: 6, cfg: 1.8 },
    maxKeyImages: 8,
    minShots: 6,
    maxShots: 14,
    stylePrefix: "cinematic still from a stylized 3D animated film, dramatic lighting, volumetric haze, rich colour grading, shallow depth of field, highly detailed",
    negativePrompt: "photo, blurry, low quality, text, watermark, deformed, ugly, extra limbs, cartoon flat, clip art, cropped",
    voiceLengthScale: 1.35,
    // measured with libritts_r at length-scale 1.35: 2.8-5 words/s depending on line length; a low estimate only means
    // the timeline (real audio) extends the shot, a high one would leave dead air
    wordsPerSecond: 4,
    bitrateKbps: 14000,
    captions: { font: "Impact", size: 112, maxWidth: 960, stroke: 7, highlight: "FFD23F", emphasisColour: "FF4D3D" },
  },
};
