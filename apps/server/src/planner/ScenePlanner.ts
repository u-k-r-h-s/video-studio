import {
  PlannedOutlineSchema,
  PlannedScenesSchema,
  dialogueId,
  locationKey,
  sceneId,
  validatePlanIntegrity,
  type Character,
  type FormatProfile,
  type PlannedOutline,
  type Scene,
} from "@studio/shared";
import { generateStructured } from "../llm/structured";
import type { LLMProvider } from "../llm/types";
import { normalizeForCompare, normalizeOutline, normalizeScenes } from "./normalize";
import { groupLines, parseScript, scriptCast, type ScriptLine } from "./script";
import { expectedSceneCount, outlinePrompt, scenesPrompt, systemPrompt, type PlanInput } from "./prompts";

export interface PlanResult {
  title: string;
  characters: Character[];
  scenes: Scene[];
}

export interface PlanHooks {
  signal?: AbortSignal;
  onStep?: (step: "outline" | "scenes") => void;
  onRepair?: (attempt: number, issues: string[]) => void;
}

const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/** Spoken time of a scene from its text alone (before real audio exists). */
export function estimateSceneSeconds(dialogue: { text: string }[], profile: FormatProfile): number {
  const t = profile.timing;
  if (dialogue.length === 0) return t.defaultSceneSeconds;
  const speech = dialogue.reduce((s, d) => s + wordCount(d.text) / t.wordsPerSecond, 0);
  return t.leadInSeconds + speech + t.gapSeconds * (dialogue.length - 1) + t.tailSeconds;
}

/**
 * Turns an idea or an existing script into a validated scene plan using Ollama.
 * Constrained orchestration: the model only returns structured data (schema-validated, normalized, repaired on
 * failure). It is never given tools or a shell, and its output is never executed.
 */
export class ScenePlanner {
  constructor(
    private readonly llm: LLMProvider,
    private readonly opts: { maxRepairs: number; temperature: number },
  ) {}

  async plan(input: PlanInput, profile: FormatProfile, hooks: PlanHooks = {}): Promise<PlanResult> {
    const sys = { role: "system" as const, content: systemPrompt(profile) };
    const common = { llm: this.llm, maxRepairs: this.opts.maxRepairs, temperature: this.opts.temperature, signal: hooks.signal, onRepair: hooks.onRepair };

    const script = input.mode === "script" && !input.allowRewrite ? parseScript(input.text) : undefined;
    const groups = script ? groupLines(script, expectedSceneCount(profile, input.targetDurationSeconds)) : undefined;
    hooks.onStep?.("outline");
    const outline = await generateStructured({
      ...common,
      label: "story outline",
      schema: PlannedOutlineSchema,
      messages: [sys, { role: "user", content: outlinePrompt(input, profile, script) }],
      normalize: normalizeOutline,
      refine: (value) => {
        const issues: string[] = [];
        if (value.characters.length > profile.planning.maxCharacters) {
          issues.push(`Too many characters (${value.characters.length}); use at most ${profile.planning.maxCharacters}.`);
        }
        if (script) {
          const want = scriptCast(script);
          const have = new Set(value.characters.map((c) => c.id));
          const missing = want.filter((w) => !have.has(w.id));
          const extra = value.characters.filter((c) => !want.some((w) => w.id === c.id));
          if (missing.length || extra.length) {
            issues.push(`The cast must be exactly the script's speakers. Missing ids: ${missing.map((m) => `"${m.id}"`).join(", ") || "none"}. Not allowed: ${extra.map((e) => `"${e.id}"`).join(", ") || "none"}.`);
          }
        }
        return { value, issues };
      },
    });

    hooks.onStep?.("scenes");
    const expected = expectedSceneCount(profile, input.targetDurationSeconds);
    const scriptNorm = input.mode === "script" ? normalizeForCompare(input.text) : "";
    const planned = await generateStructured({
      ...common,
      label: "scene plan",
      schema: PlannedScenesSchema,
      messages: [sys, { role: "user", content: scenesPrompt(input, profile, outline, groups) }],
      normalize: (raw) => normalizeScenes(raw, outline.characters),
      refine: (value) => ({ value, issues: this.checkScenes(value.scenes, outline, profile, input, expected, scriptNorm, groups) }),
    });

    const scenes = groups ? this.applyGroups(planned.scenes, groups) : planned.scenes;
    return { title: outline.title, characters: outline.characters.map((c) => ({ ...c })), scenes: this.assemble(scenes, profile) };
  }

  private checkScenes(
    scenes: ReturnType<typeof PlannedScenesSchema.parse>["scenes"],
    outline: PlannedOutline,
    profile: FormatProfile,
    input: PlanInput,
    expected: number,
    scriptNorm: string,
    groups?: ScriptLine[][],
  ): string[] {
    const issues: string[] = [];
    if (groups && scenes.length !== groups.length) {
      issues.push(`Write exactly ${groups.length} scenes (one for each group of script lines) but got ${scenes.length}.`);
    } else if (input.mode === "idea" && Math.abs(scenes.length - expected) > 1) {
      issues.push(`Expected exactly ${expected} scenes but got ${scenes.length}.`);
    }
    if (scenes.length > profile.timing.maxScenes) issues.push(`Too many scenes (${scenes.length}); use at most ${profile.timing.maxScenes}.`);
    const locations = new Set(scenes.map((s) => locationKey(s.location)));
    if (locations.size > profile.planning.maxLocations) {
      issues.push(`Too many different locations (${locations.size}); use at most ${profile.planning.maxLocations} and reuse the same location name.`);
    }
    scenes.forEach((s, i) => {
      if (s.props.length > profile.planning.maxPropsPerScene) issues.push(`scene ${i + 1}: too many props (${s.props.length}); use at most ${profile.planning.maxPropsPerScene}.`);
    });
    const provisional = scenes.map((s, i) => ({
      id: sceneId(i + 1),
      characters: s.characters,
      props: s.props,
      // for NAME: line scripts the model's own dialogue is discarded, so it must not be validated either
      dialogue: groups ? [] : s.dialogue.map((d, n) => ({ id: dialogueId(sceneId(i + 1), n + 1), characterId: d.characterId, text: d.text })),
    }));
    issues.push(...validatePlanIntegrity({ characters: outline.characters, scenes: provisional }));
    if (!groups && input.mode === "script" && !input.allowRewrite) {
      const offenders = scenes.flatMap((s) => s.dialogue).filter((d) => !scriptNorm.includes(normalizeForCompare(d.text)));
      if (offenders.length > 0) {
        issues.push(
          `Dialogue must be copied verbatim from the script. These lines do not appear in it: ${offenders.slice(0, 4).map((d) => `"${d.text}"`).join(", ")}.`,
        );
      }
    }
    return issues;
  }

  /**
   * For `NAME: line` scripts the dialogue comes from the script itself, never from the model: each scene gets exactly
   * its group of lines (original text, order and speaker), and each speaker is made visible in its scene.
   */
  private applyGroups(planned: ReturnType<typeof PlannedScenesSchema.parse>["scenes"], groups: ScriptLine[][]): ReturnType<typeof PlannedScenesSchema.parse>["scenes"] {
    return planned.map((s, i) => {
      const dialogue = (groups[i] ?? []).map((l) => ({ characterId: l.speakerId, text: l.text }));
      const characters = [...new Set([...s.characters, ...dialogue.map((d) => d.characterId).filter((c) => c !== "narrator")])];
      return { ...s, dialogue, characters };
    });
  }

  private assemble(planned: ReturnType<typeof PlannedScenesSchema.parse>["scenes"], profile: FormatProfile): Scene[] {
    const firstSeen = new Map<string, string>();
    return planned.map((s, i) => {
      const id = sceneId(i + 1);
      const key = locationKey(s.location);
      if (!firstSeen.has(key)) firstSeen.set(key, s.location);
      const dialogue = s.dialogue.map((d, n) => ({ id: dialogueId(id, n + 1), characterId: d.characterId, text: d.text, ...(d.emotion ? { emotion: d.emotion } : {}) }));
      const t = profile.timing;
      const duration = Math.round(Math.max(t.minSceneSeconds, Math.min(t.maxSceneSeconds, Math.max(s.duration ?? t.defaultSceneSeconds, estimateSceneSeconds(dialogue, profile)))) * 10) / 10;
      return {
        id,
        order: i + 1,
        duration,
        location: firstSeen.get(key)!, // identical locations share one canonical name -> one shared background
        visualDescription: s.visualDescription,
        dialogue,
        characters: s.characters,
        props: s.props,
        camera: { movement: s.camera.movement, shot: s.camera.shot ?? "medium" },
        motion: { entrance: s.motion?.entrance ?? "left", emphasis: s.motion?.emphasis ?? "none" },
        generatedAssets: [],
        status: "planned" as const,
      };
    });
  }
}
