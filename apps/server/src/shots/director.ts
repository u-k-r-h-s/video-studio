import { BEATS, SHOT_TYPES, STORY_EMOTIONS, type Character, type FormatProfile, type Story } from "@studio/shared";
import { generateStructured } from "../llm/structured";
import type { LLMProvider } from "../llm/types";
import { DirectedShotsSchema, DirectorOutlineSchema, normalizeOutline, normalizeShots, type DirectedShots, type DirectorOutline } from "./directorSchemas";
import { buildStory } from "./storyBuilder";

export interface DirectInput { idea: string; targetDurationSeconds: number; feedback?: string }
export interface DirectHooks { signal?: AbortSignal; onStep?: (s: "outline" | "shots") => void; onRepair?: (attempt: number, issues: string[]) => void }
export interface DirectResult { title: string; characters: Character[]; story: Story }

const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
export const expectedShotCount = (profile: FormatProfile, target: number): number => {
  const c = profile.cinematic!;
  return Math.max(c.minShots, Math.min(c.maxShots, Math.round(target / 2.3)));
};

export const directorSystemPrompt = (profile: FormatProfile): string => `You are the director of a premium animated vertical short (YouTube Shorts style, 9:16).
You think in SHOTS, not paragraphs: every shot is one camera set-up with one clear thing to see.
Rules:
- Everything must be ORIGINAL. Never use or imitate characters, names, artwork, plots or stories from existing films, games, comics or franchises.
- Keep it family friendly. ${profile.planning.styleGuidance}
- Respond with a single JSON object that follows the provided schema. No markdown, no commentary.`;

export function outlinePrompt(i: DirectInput, profile: FormatProfile): string {
  const c = profile.cinematic!;
  return `Create the story bible for a ${i.targetDurationSeconds}-second animated short.

Idea: ${i.idea}
${i.feedback ? `\nThe user asked for these changes: ${i.feedback}\n` : ""}
Write:
- "title": a short original title.
- "logline": one sentence (who wants what, what goes wrong, the twist).
- "characters": 1 to ${profile.planning.maxCharacters}. Each has a lowercase kebab-case "id", a "role", "appearance" (face, hair, build: physical features only) and ONE distinctive "clothing" costume built from two strong colours (for example "yellow raincoat with a blue scarf"). The costume is how viewers recognise the character in every shot, so make it simple and bold.
- "locations": 1 to ${Math.min(3, profile.planning.maxLocations)}. Each has a kebab-case "id", a "look" (architecture, materials, mood; no people) and "lighting" (light colours and sources).
Everything is drawn as a cinematic 3D animated film frame, so describe things that look good in moody light.
Image budget: the film is built from about ${c.maxKeyImages} generated pictures, so keep the cast and places few and distinctive.`;
}

export function shotsPrompt(i: DirectInput, profile: FormatProfile, outline: DirectorOutline): string {
  const n = expectedShotCount(profile, i.targetDurationSeconds);
  const cast = outline.characters.map((c) => `- ${c.id}: ${c.name}, ${c.role}`).join("\n");
  const places = outline.locations.map((l) => `- ${l.id}: ${l.name}`).join("\n");
  return `Direct a ${i.targetDurationSeconds}-second short as exactly ${n} shots.

Title: ${outline.title}
Logline: ${outline.logline}
Idea: ${i.idea}
Cast (use ONLY these ids):
${cast}
Locations (use ONLY these ids):
${places}
${i.feedback ? `\nThe user asked for these changes: ${i.feedback}\n` : ""}
Shot rules:
- "beat" is one of ${BEATS.join(", ")}. The story moves hook -> setup -> curiosity -> conflict -> escalation -> payoff. Shot 1 is the "hook": an intriguing image in the first 2 seconds. The last shot is the "payoff": a twist or a punchline that reframes what we saw.
- "shotType" is one of ${SHOT_TYPES.join(", ")}. Vary the framing: never use the same shotType three times in a row, use at least 4 different types, mix wide and close shots, use a close-up for every strong emotion.
- "character" is the ONE character id who is visible, or "" for an empty place or an object (a phone, a door, a building). Never put two characters in one shot; a character can speak while another is shown.
- "emotion" is one of ${STORY_EMOTIONS.join(", ")}.
- "action": one sentence about what we SEE (present tense), concrete and visual, no camera jargon.
- "line": optional, at most one short spoken line per shot (max 12 words), with "speaker" a character id or "narrator". Use dialogue in about half of the shots; keep the rest silent so the pictures and sound can work. Total spoken words across the film: at most ${Math.round(i.targetDurationSeconds * 2.4)}.
- "onScreenText": only for a phone/message/screen close-up: the short text shown on the screen.
Be specific and surprising. Do not repeat the same shot twice.`;
}

/**
 * The AI director. Two small structured Ollama calls (story bible, then shots) whose output is normalised, validated
 * and repaired; everything numeric or visual is then DERIVED by `buildStory` (camera language, durations, SFX, image
 * prompts and image reuse). The model never writes a camera value, a prompt or a filter.
 */
export class ShotDirector {
  constructor(private readonly llm: LLMProvider, private readonly opts: { maxRepairs: number; temperature: number }) {}

  async direct(input: DirectInput, profile: FormatProfile, hooks: DirectHooks = {}): Promise<DirectResult> {
    const cin = profile.cinematic;
    if (!cin) throw new Error(`profile ${profile.id} has no cinematic settings`);
    const sys = { role: "system" as const, content: directorSystemPrompt(profile) };
    const common = { llm: this.llm, maxRepairs: this.opts.maxRepairs, temperature: this.opts.temperature, signal: hooks.signal, onRepair: hooks.onRepair };

    hooks.onStep?.("outline");
    const outline = await generateStructured({
      ...common, label: "story bible", schema: DirectorOutlineSchema, messages: [sys, { role: "user", content: outlinePrompt(input, profile) }], normalize: normalizeOutline,
      refine: (v) => ({
        value: v,
        issues: [
          ...(v.characters.length > profile.planning.maxCharacters ? [`Too many characters (${v.characters.length}); use at most ${profile.planning.maxCharacters}.`] : []),
          ...(new Set(v.characters.map((c) => c.id)).size !== v.characters.length ? ["Character ids must be unique."] : []),
          ...(new Set(v.locations.map((l) => l.id)).size !== v.locations.length ? ["Location ids must be unique."] : []),
          ...(v.locations.length > profile.planning.maxLocations ? [`Too many locations; use at most ${profile.planning.maxLocations}.`] : []),
        ],
      }),
    });

    hooks.onStep?.("shots");
    const expected = expectedShotCount(profile, input.targetDurationSeconds);
    const directed = await generateStructured({
      ...common, label: "shot list", schema: DirectedShotsSchema, messages: [sys, { role: "user", content: shotsPrompt(input, profile, outline) }], normalize: (raw) => normalizeShots(raw, outline),
      refine: (v) => ({ value: v, issues: checkShots(v, outline, profile, expected, input.targetDurationSeconds) }),
    });
    const title = outline.title.trim();
    const built = buildStory(outline, directed, profile, title);
    return { title, ...built };
  }
}

export function checkShots(v: DirectedShots, outline: DirectorOutline, profile: FormatProfile, expected: number, targetSeconds: number): string[] {
  const cin = profile.cinematic!;
  const issues: string[] = [];
  const n = v.shots.length;
  if (n < cin.minShots || n > cin.maxShots || Math.abs(n - expected) > 3) issues.push(`Write about ${expected} shots (between ${Math.max(cin.minShots, expected - 3)} and ${Math.min(cin.maxShots, expected + 3)}); you wrote ${n}.`);
  const chars = new Set(outline.characters.map((c) => c.id)), locs = new Set(outline.locations.map((l) => l.id));
  v.shots.forEach((s, i) => {
    if (!locs.has(s.location)) issues.push(`shot ${i + 1}: unknown location "${s.location}" (known: ${[...locs].join(", ")}).`);
    if (s.character && !chars.has(s.character)) issues.push(`shot ${i + 1}: unknown character "${s.character}" (known: ${[...chars].join(", ")}; use "" for none).`);
    if (s.line && s.line.speaker !== "narrator" && !chars.has(s.line.speaker)) issues.push(`shot ${i + 1}: unknown speaker "${s.line.speaker}".`);
  });
  for (let i = 2; i < n; i++) if (v.shots[i]!.shotType === v.shots[i - 1]!.shotType && v.shots[i]!.shotType === v.shots[i - 2]!.shotType) { issues.push(`shots ${i - 1}-${i + 1} use the same shotType "${v.shots[i]!.shotType}" three times in a row; vary the framing.`); break; }
  if (new Set(v.shots.map((s) => s.shotType)).size < Math.min(4, n)) issues.push("Use at least 4 different shot types.");
  const words = v.shots.reduce((s, x) => s + (x.line ? wordCount(x.line.text) : 0), 0);
  if (words === 0) issues.push("The film needs some spoken dialogue or narration (at least 3 lines).");
  if (words > targetSeconds * 2.6) issues.push(`Too much speech (${words} words); keep it under ${Math.round(targetSeconds * 2.4)} words so the pictures can breathe.`);
  if (v.shots.filter((s) => s.line).length < 2) issues.push("Give at least 2 shots a spoken line.");
  return issues;
}
