import type { FormatProfile } from "@studio/shared";
import { animatedShort } from "./animatedShort";

/**
 * "Animated short (3D)": the same Director, timeline, voices, captions, soundtrack and assembly as `animated-short`, but
 * shots are rendered by the Three.js renderer: rigged 3D characters from the local library (assets/3d/characters), a small
 * lit 3D set, an AI-painted plate for the far background. Selected with `npm run short -- --renderer=3d`.
 */
export const animatedShort3d: FormatProfile = {
  ...animatedShort,
  id: "animated-short-3d",
  name: "Animated short (3D characters)",
  description: "Rigged 3D characters in a lit Three.js set over an AI-painted background plate: real turns, skeletal walk/run, hand props, door interaction, cinematic camera. 1080x1920 at 30 fps.",
  animation: { ...animatedShort.animation!, renderer: "three3d" },
};
