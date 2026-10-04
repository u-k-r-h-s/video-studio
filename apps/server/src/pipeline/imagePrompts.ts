import type { Character, FormatProfile, Scene } from "@studio/shared";

/** Bump when the workflow or prompt construction changes, so cached images are regenerated. */
export const IMAGE_RECIPE_VERSION = "sd15-lcm-v3";

export interface ImagePrompt {
  prompt: string;
  negative: string;
}

// LCM runs at cfg ~1.5, where negative prompts barely work: anything we do not want must simply NOT appear in the
// positive prompt. Backgrounds therefore never mention people; cut-outs ask for isolation on a plain background.
const NO_PEOPLE = "people, person, human, man, woman, character, figure, face";
const ISOLATED = "isolated on a plain white background, sticker style, no frame, no border, no text, no scenery";
const PEOPLE_WORDS = /\b(he|she|they|him|her|his|man|woman|boy|girl|person|people|detective|thief|character|stands?|standing|walks?|sits?|sitting|holds?|holding|looks?|looking)\b/i;

/** Drops clauses that mention a character (by name) or any person-like word, so only the setting remains. */
export function stripPeople(description: string, characters: Character[]): string {
  const nameTokens = characters.flatMap((c) => c.name.split(/[^\p{L}\p{N}]+/u)).filter((t) => t.length >= 3).map((t) => t.toLowerCase());
  return description
    .split(/[.;,]\s*/)
    .map((c) => c.trim())
    .filter((c) => c && !PEOPLE_WORDS.test(c) && !nameTokens.some((t) => c.toLowerCase().includes(t)))
    .join(", ");
}

/**
 * Shared per-location backgrounds are described by the LOCATION only (they are reused by every scene there).
 * A scene-specific background may add the people-free parts of that scene's description.
 */
export function backgroundPrompt(profile: FormatProfile, scene: Scene, characters: Character[], sceneSpecific: boolean): ImagePrompt {
  const s = profile.visualStyle;
  const setting = sceneSpecific ? stripPeople(scene.visualDescription, characters) : "";
  return {
    prompt: `${s.promptPrefix}, interior of a ${scene.location}${setting ? `, ${setting}` : ""}, wide view of the empty place, no people, no characters, background illustration, vertical composition`,
    negative: `${s.negativePrompt}, ${NO_PEOPLE}`,
  };
}

export function characterPrompt(profile: FormatProfile, c: Character): ImagePrompt {
  const s = profile.visualStyle;
  return {
    prompt: `${s.promptPrefix}, full body character design of ${c.appearance.trim()}, standing, facing the viewer, centered, ${ISOLATED}`,
    negative: `${s.negativePrompt}, cropped, multiple people, background scenery, text, frame, border, poster`,
  };
}

export function propPrompt(profile: FormatProfile, name: string): ImagePrompt {
  const s = profile.visualStyle;
  return {
    prompt: `${s.promptPrefix}, simple icon of a ${name}, single object, centered, ${ISOLATED}`,
    negative: `${s.negativePrompt}, ${NO_PEOPLE}, multiple objects, scenery, frame, border`,
  };
}
