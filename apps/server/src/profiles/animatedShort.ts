import type { FormatProfile } from "@studio/shared";
import { cinematicAnimatedShort } from "./cinematicAnimatedShort";

const STYLE =
  "stylized 3D animated film character design, soft cinematic lighting, rich colours, clean shapes, highly detailed";
const NEG = "photo, blurry, low quality, text, watermark, deformed, ugly, extra limbs, cartoon flat, clip art, cropped, cut off, multiple people, collage, frame, border";

/**
 * "Animated short": the layered 2D/2.5D animation pipeline. The director writes SEMANTIC actions (walk toward the building,
 * look at the phone, open the door); the animation compiler turns them into layers, timed events and camera; the engine draws
 * every frame from generated assets (locations, character views, face variants, props) cut out with a foreground matte.
 * This is the default format of `npm run short`.
 */
export const animatedShort: FormatProfile = {
  ...cinematicAnimatedShort,
  id: "animated-short",
  name: "Animated short (layered animation)",
  description: "Vertical short with real animation: characters walk, turn and react, props and doors move, weather and camera work, SFX locked to the action. 1080x1920 at 30 fps.",
  pipeline: "animated",
  animation: {
    imageModel: "ds8",
    stylePrefix: STYLE,
    negativePrompt: NEG,
    location: { width: 512, height: 896, steps: 6, cfg: 1.8 },
    character: { width: 512, height: 896, steps: 6, cfg: 2.4, viewDenoise: 0.7 },
    head: { size: 512, steps: 6 },
    prop: { width: 512, height: 512, steps: 6, cfg: 2.4 },
    characterHeight: 900,
    voiceLengthScale: 1.35,
    wordsPerSecond: 4,
    bitrateKbps: 14000,
    minShots: 6,
    maxShots: 12,
    maxPropKinds: 4,
    captions: { font: "Impact", size: 112, maxWidth: 960, stroke: 7, highlight: "FFD23F", emphasisColour: "FF4D3D" },
  },
  cinematic: { ...cinematicAnimatedShort.cinematic!, minShots: 6, maxShots: 12, stylePrefix: STYLE, negativePrompt: NEG },
};
