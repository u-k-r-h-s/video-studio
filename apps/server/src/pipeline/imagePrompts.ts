import type { Character, FormatProfile, Scene } from "@studio/shared";

/** Bump when the workflow or prompt construction changes, so cached images are regenerated. */
export const IMAGE_RECIPE_VERSION = "sd15-lcm-v1";

export interface ImagePrompt {
  prompt: string;
  negative: string;
}

const NO_PEOPLE = "people, person, human, man, woman, character, figure, face";
const FLAT_BG = "plain flat solid single-colour background, no scenery, no shadow";

export function backgroundPrompt(profile: FormatProfile, scene: Scene): ImagePrompt {
  const s = profile.visualStyle;
  return {
    prompt: `${s.promptPrefix}, ${scene.location}, ${scene.visualDescription}, empty scene, no people, background illustration, vertical composition`,
    negative: `${s.negativePrompt}, ${NO_PEOPLE}`,
  };
}

export function characterPrompt(profile: FormatProfile, c: Character): ImagePrompt {
  const s = profile.visualStyle;
  return {
    prompt: `${s.promptPrefix}, full body character design of ${c.appearance}, standing, facing the viewer, centered, ${FLAT_BG}`,
    negative: `${s.negativePrompt}, cropped, multiple people, background scenery, text`,
  };
}

export function propPrompt(profile: FormatProfile, name: string): ImagePrompt {
  const s = profile.visualStyle;
  return {
    prompt: `${s.promptPrefix}, a single ${name}, centered, isolated object, ${FLAT_BG}`,
    negative: `${s.negativePrompt}, ${NO_PEOPLE}, multiple objects, scenery`,
  };
}
