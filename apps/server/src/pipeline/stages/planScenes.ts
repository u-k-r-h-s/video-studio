import { PIPELINE_STAGES } from "@studio/shared";
import type { StageFn } from "../types";

/**
 * Stage 1: Ollama turns the idea/script into a validated scene plan.
 * Gates: ComfyUI must be stopped before Ollama loads; Ollama is unloaded and VERIFIED gone in `finally`, whether
 * planning succeeded, failed or was cancelled, so the next heavy stage can never start with a resident model.
 */
export const planScenes = (feedback?: string): StageFn => async (svc, ctx) => {
  const project = await svc.store.require(ctx.projectId);
  const profile = svc.profiles.get(project.formatProfile);
  await svc.gate.assertSafeToLoadOllama();

  let plan;
  let failure: unknown;
  try {
    ctx.progress(5, "Asking Ollama for the scene plan...");
    const { value } = await ctx.log.time({ stage: "scene_planning" }, () =>
      svc.planner.plan(
        { mode: project.inputMode, text: project.inputText, language: project.language, targetDurationSeconds: project.targetDurationSeconds, feedback },
        profile,
        {
          signal: ctx.signal,
          onStep: (s) => ctx.progress(s === "outline" ? 10 : 50, s === "outline" ? "Writing the cast..." : "Planning the scenes..."),
          onRepair: (n) => ctx.progress(50, `Fixing invalid model output (attempt ${n})...`),
        },
      ),
    );
    plan = value;
  } catch (err) {
    failure = err;
  } finally {
    // Gate: never leave Ollama resident. A failed unload must not hide the planner's own error.
    try {
      ctx.progress(90, "Unloading Ollama...");
      await svc.gate.ensureOllamaUnloaded();
    } catch (gateErr) {
      if (!failure) failure = gateErr;
      else ctx.log.event({ stage: "scene_planning" }, "warning", { gate: "ollama unload failed after planner error" });
    }
  }
  if (failure) throw failure;

  const userTitle = project.title && project.title !== project.inputText.split(/\s+/).slice(0, 6).join(" ").slice(0, 60);
  await svc.store.update(project.id, (p) => {
    p.title = userTitle ? p.title : plan!.title;
    p.characters = plan!.characters;
    p.scenes = plan!.scenes;
    p.audio = []; // dialogue ids may have changed; assets are kept and re-used when their input hash still matches
    p.reviewApproved = false;
    p.status = "review";
    for (const s of PIPELINE_STAGES) if (s.id !== "scene_planning") p.stages[s.id] = { status: "pending" };
  });
  const saved = await svc.store.require(project.id);
  await svc.store.syncCharacterFiles(saved);
};
