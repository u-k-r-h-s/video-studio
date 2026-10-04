import { LANGUAGES, NARRATOR_ID, type FormatProfile, type PlannedOutline, type LanguageId } from "@studio/shared";

export interface PlanInput {
  mode: "idea" | "script";
  text: string;
  language: LanguageId;
  targetDurationSeconds: number;
  /** Script mode only: allow the model to rewrite dialogue. Default false: dialogue is preserved verbatim. */
  allowRewrite?: boolean;
  /** Optional user note for a re-plan ("make it funnier"). */
  feedback?: string;
}

export function systemPrompt(profile: FormatProfile): string {
  return `You are the story director of a local AI video studio that produces short vertical (9:16) videos.
Format: ${profile.name}. ${profile.planning.styleGuidance}
Rules:
- Everything must be ORIGINAL. Never use or imitate characters, names, artwork, plots or stories from existing comics, films, shows or franchises.
- Keep it family friendly.
- Respond with a single JSON object that follows the provided schema. No markdown, no commentary.`;
}

const langName = (id: LanguageId) => LANGUAGES.find((l) => l.id === id)?.label ?? id;

function languageNote(language: LanguageId): string {
  return language === "hi"
    ? "Dialogue text must be written in Hindi (Devanagari script). Everything else (ids, names, descriptions, locations) stays in English."
    : `All text is in ${langName(language)}.`;
}

export function expectedSceneCount(profile: FormatProfile, targetSeconds: number): number {
  const n = Math.round(targetSeconds / profile.timing.secondsPerScene);
  return Math.max(profile.timing.minScenes, Math.min(profile.timing.maxScenes, n));
}

export function outlinePrompt(input: PlanInput, profile: FormatProfile): string {
  const scenes = expectedSceneCount(profile, input.targetDurationSeconds);
  const source =
    input.mode === "script"
      ? `Here is an existing SCRIPT. Identify its title and its cast. Do not change the story.\n\nSCRIPT:\n"""\n${input.text}\n"""`
      : `Story idea: ${input.text}`;
  return `${input.mode === "script" ? "Extract the title and cast from the script." : `Create the title and cast for a ${input.targetDurationSeconds}-second short.`}

${source}
Planned length: about ${scenes} scenes.
${languageNote(input.language)}
${input.feedback ? `\nThe user asked for these changes: ${input.feedback}\n` : ""}
Cast rules:
- 1 to ${profile.planning.maxCharacters} characters, each visually distinct and easy to draw as a 2D cartoon.
- "id" is the character's name in lowercase kebab-case (words joined by hyphens). Do not reuse names from these instructions.
- "description" is the role and personality. "appearance" is physical appearance ONLY (build, face, hair, clothing, colours) so the character can be drawn identically every time.
- Do not include the narrator in the cast.`;
}

export function scenesPrompt(input: PlanInput, profile: FormatProfile, outline: PlannedOutline): string {
  const cast = outline.characters.map((c) => `- ${c.id}: ${c.name} (${c.appearance})`).join("\n");
  const scenes = expectedSceneCount(profile, input.targetDurationSeconds);
  const base = `Cast (use ONLY these ids in "characters" and as dialogue speakers):
${cast}

Scene rules:
- "location" is a short name of the place. Use at most ${profile.planning.maxLocations} different locations in total and reuse the same name when scenes share a place.
- "visualDescription" is one or two sentences about what we SEE (it becomes an illustration).
- "characters" lists the cast ids visible in the scene. "props": 0 to ${profile.planning.maxPropsPerScene} important physical objects (short names like "wooden mousetrap").
- "dialogue": 0 to 4 lines per scene. A speaker is a cast id or "${NARRATOR_ID}" for narration (use narration sparingly). "emotion" is how the line is delivered.
- "camera.movement" is one of: static, zoom_in, zoom_out, pan_left, pan_right. "camera.shot" is wide, medium or close_up.
- "motion.entrance" (left, right, none) is where the characters enter from; "motion.emphasis" is none, impact or surprise (use impact/surprise for the big moment).
- "duration" is the scene length in seconds.`;
  if (input.mode === "script") {
    return `Break this existing SCRIPT into scenes (about ${scenes}, but follow the script's own structure).

SCRIPT:
"""
${input.text}
"""

Title: ${outline.title}
${base}
${input.allowRewrite ? "You may lightly adapt the wording." : 'IMPORTANT: copy every dialogue line EXACTLY as written in the script. Do not rewrite, shorten, translate or invent dialogue. If something is narration in the script, use the speaker "narrator".'}
${languageNote(input.language)}
${input.feedback ? `\nThe user asked for these changes: ${input.feedback}\n` : ""}`;
  }
  return `Break this story into exactly ${scenes} scenes for a ${input.targetDurationSeconds}-second vertical short.

Title: ${outline.title}
Story idea: ${input.text}
${base}
- Scene 1 hooks the viewer; the last scene delivers the twist or punchline.
${languageNote(input.language)}
${input.feedback ? `\nThe user asked for these changes: ${input.feedback}\n` : ""}`;
}
