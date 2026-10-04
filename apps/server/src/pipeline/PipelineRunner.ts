import { PIPELINE_STAGES, type StageId } from "@studio/shared";
import { CancelledError, describeError, diagnostics } from "../errors";
import { StageLog } from "../lib/stagelog";
import type { PipelineServices, Scope, StageFn } from "./types";

export interface RunHooks {
  signal?: AbortSignal;
  progress?: (pct: number, message: string) => void;
}

/**
 * Executes ONE stage with persistent state tracking. project.json always reflects reality:
 *   running (startedAt) -> completed (durationMs) | failed (error) | cancelled
 * A crash leaves the stage "running"; ProjectStore.recoverInterrupted() turns that into "failed" on restart,
 * and the idempotent stages then resume by skipping everything that is already fresh.
 */
export class PipelineRunner {
  constructor(private readonly svc: PipelineServices) {}

  async runStage(projectId: string, stage: StageId, fn: StageFn, scope: Scope = {}, hooks: RunHooks = {}): Promise<void> {
    const { store } = this.svc;
    const log = new StageLog(projectId, store.logSink(projectId));
    const t0 = Date.now();
    await store.update(projectId, (p) => {
      p.stages[stage] = { status: "running", startedAt: new Date().toISOString() };
      p.status = stage === "scene_planning" ? "planning" : "generating";
    });
    try {
      await fn(this.svc, { projectId, scope, signal: hooks.signal, progress: hooks.progress ?? (() => {}), log });
      if (hooks.signal?.aborted) throw new CancelledError();
      await store.update(projectId, (p) => {
        p.stages[stage] = { ...p.stages[stage]!, status: "completed", completedAt: new Date().toISOString(), durationMs: Date.now() - t0, error: undefined };
        if (stage === "assembly") p.status = "completed";
        else if (stage !== "scene_planning") p.status = "generating";
      });
    } catch (err) {
      const cancelled = err instanceof CancelledError || !!hooks.signal?.aborted;
      const message = cancelled ? "Cancelled." : describeError(err);
      log.event({ stage }, cancelled ? "cancelled" : "failed", { durationMs: Date.now() - t0 });
      if (!cancelled) store.logSink(projectId).write({ project: projectId, stage, status: "diagnostics", ...diagnostics(err) });
      await store.update(projectId, (p) => {
        p.stages[stage] = { ...p.stages[stage]!, status: cancelled ? "cancelled" : "failed", durationMs: Date.now() - t0, error: message };
        if (!cancelled) p.errors = [...p.errors, { stage, message, at: new Date().toISOString() }].slice(-20);
        p.status = p.scenes.length === 0 ? "draft" : p.reviewApproved ? "approved" : "review";
        if (!cancelled && stage !== "scene_planning") p.status = "failed";
      }).catch(() => {});
      throw err;
    }
  }

  /** Stage ids in pipeline order (for UIs and the orchestrator). */
  static readonly stageIds = PIPELINE_STAGES.map((s) => s.id);
}
