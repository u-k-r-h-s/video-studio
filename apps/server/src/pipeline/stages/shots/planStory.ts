import fs from "node:fs/promises";
import { PIPELINE_STAGES } from "@studio/shared";
import { StageOrderError } from "../../../errors";
import { storyFromPlan, type DirectResult } from "../../../shots/director";
import type { StageFn } from "../../types";
import { cinematicOf, scenesFromStory } from "./common";

/**
 * Stage 1 (shot pipeline): the AI director turns the idea into a story bible and a shot list.
 * Same gates as scene planning: ComfyUI must be stopped before Ollama loads, and Ollama is unloaded and VERIFIED gone
 * in `finally`, whether planning succeeded, failed or was cancelled.
 */
/** An authored story (the director's output format) saved with the project; when present the LLM step is skipped. */
export const DIRECTOR_PLAN_FILE = "director-plan.json";

export const planStory = (feedback?: string): StageFn => async (svc, ctx) => {
  const project = await svc.store.require(ctx.projectId);
  const profile = svc.profiles.get(project.formatProfile);
  cinematicOf(profile);
  const authored = await fs.readFile(svc.store.resolve(project.id, DIRECTOR_PLAN_FILE), "utf8").then((t) => JSON.parse(t) as unknown, () => undefined);
  // the voices and caption font come from the profile; the AI director itself only writes English
  if (!profile.voices.narrator[project.language] || !profile.voices.characters[project.language]?.length) throw new StageOrderError(`The ${profile.id} format has no ${project.language} voices.`);
  if (project.language !== "en" && authored === undefined) throw new StageOrderError("The AI director writes English only. A story in another language needs an authored plan (npm run short -- --plan <file>).");

  let result: DirectResult | undefined;
  let failure: unknown;
  if (authored !== undefined) {
    ctx.progress(20, "Directing the authored story...");
    const { advice, ...r } = storyFromPlan(authored, profile, project.targetDurationSeconds);
    for (const a of advice) ctx.log.event({ stage: "scene_planning" }, "warning", { plan: a });
    result = r;
  } else {
    if (!svc.director) throw new StageOrderError("The shot director is not configured.");
    await svc.gate.assertSafeToLoadOllama();
    try {
      ctx.progress(5, "Asking the director for the story bible...");
      const { value } = await ctx.log.time({ stage: "scene_planning" }, () =>
        svc.director!.direct({ idea: project.inputText, targetDurationSeconds: project.targetDurationSeconds, feedback }, profile, {
          signal: ctx.signal,
          onStep: (s, detail) => ctx.progress(s === "outline" ? 8 : s === "beats" ? 20 : 30 + (["hook", "setup", "curiosity", "conflict", "escalation", "payoff"].indexOf(detail ?? "") * 10), s === "outline" ? "Writing the cast and places..." : s === "beats" ? "Writing the story beats..." : `Directing the ${detail} shots...`),
          onRepair: (n) => ctx.progress(50, `Fixing invalid model output (attempt ${n})...`),
        }),
      );
      result = value;
    } catch (err) {
      failure = err;
    } finally {
      try {
        ctx.progress(90, "Unloading Ollama...");
        await svc.gate.ensureOllamaUnloaded();
      } catch (gateErr) {
        if (!failure) failure = gateErr;
        else ctx.log.event({ stage: "scene_planning" }, "warning", { gate: "ollama unload failed after director error" });
      }
    }
  }
  if (failure) throw failure;

  const userTitle = project.title && project.title !== project.inputText.split(/\s+/).slice(0, 6).join(" ").slice(0, 60);
  await svc.store.update(project.id, (p) => {
    p.title = userTitle ? p.title : result!.title;
    p.characters = result!.characters;
    p.story = result!.story;
    p.scenes = scenesFromStory(result!.story, result!.characters);
    p.audio = [];
    p.reviewApproved = false;
    p.status = "review";
    for (const s of PIPELINE_STAGES) if (s.id !== "scene_planning") p.stages[s.id] = { status: "pending" };
  });
  await svc.store.syncCharacterFiles(await svc.store.require(project.id));
};
