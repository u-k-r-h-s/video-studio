import { PIPELINE_STAGES } from "@studio/shared";
import { StageOrderError } from "../../../errors";
import type { StageFn } from "../../types";
import { cinematicOf, scenesFromStory } from "./common";

/**
 * Stage 1 (shot pipeline): the AI director turns the idea into a story bible and a shot list.
 * Same gates as scene planning: ComfyUI must be stopped before Ollama loads, and Ollama is unloaded and VERIFIED gone
 * in `finally`, whether planning succeeded, failed or was cancelled.
 */
export const planStory = (feedback?: string): StageFn => async (svc, ctx) => {
  const project = await svc.store.require(ctx.projectId);
  const profile = svc.profiles.get(project.formatProfile);
  cinematicOf(profile);
  if (!svc.director) throw new StageOrderError("The shot director is not configured.");
  if (project.language !== "en") throw new StageOrderError("The cinematic format currently supports English only (caption font and voices).");
  await svc.gate.assertSafeToLoadOllama();

  let result;
  let failure: unknown;
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
