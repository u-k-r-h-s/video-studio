import fs from "node:fs";
import { z } from "zod";
import { NARRATOR_ID, LANGUAGE_IDS, type Character, type FormatProfile, type LanguageId } from "@studio/shared";
import type { VoiceInfo } from "./TTSProvider";

const CatalogSchema = z.object({
  voices: z.record(
    z.string(),
    z.object({ language: z.enum(LANGUAGE_IDS), model: z.string().min(1), speaker: z.number().int().min(0).optional(), license: z.string().optional() }),
  ),
});

/** Voice configuration is data (config/voices.json). The repository ships NO voice weights. */
export function loadVoiceCatalog(file: string): VoiceInfo[] {
  const parsed = CatalogSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  return Object.entries(parsed.voices).map(([id, v]) => ({ id, ...v }));
}

/**
 * Which voice speaks a line. Narrator -> the profile's narrator voice for the language. Characters -> their own
 * `voiceId` if set, else deterministic round-robin over the profile's character voices, so the same character
 * always gets the same voice across scenes and re-runs.
 */
export function resolveVoiceId(characterId: string, characters: Character[], language: LanguageId, profile: FormatProfile): string {
  if (characterId === NARRATOR_ID) return profile.voices.narrator[language];
  const index = characters.findIndex((c) => c.id === characterId);
  const own = index >= 0 ? characters[index]!.voiceId : undefined;
  if (own) return own;
  const pool = profile.voices.characters[language];
  return pool[Math.max(0, index) % pool.length]!;
}
