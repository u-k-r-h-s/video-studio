import { diagnostics } from "../errors";
import { createLogger, type Fields, type JsonlSink } from "./logger";

const log = createLogger("pipeline");

export interface StageContext {
  stage: string;
  scene?: string;
  asset?: string;
}

/**
 * Structured per-project stage logging. Every unit of work logs `status=started` and then
 * `status=completed durationMs=...` (or `status=failed`), to the console and to projects/<id>/logs/pipeline.jsonl.
 */
export class StageLog {
  constructor(
    readonly projectId: string,
    private readonly sink?: JsonlSink,
    private readonly now: () => number = Date.now,
  ) {}

  event(ctx: StageContext, status: string, extra: Fields = {}): void {
    const fields: Fields = { project: this.projectId, stage: ctx.stage, scene: ctx.scene, asset: ctx.asset, status, ...extra };
    (status === "failed" ? log.error : status === "warning" ? log.warn : log.info)("stage", fields);
    this.sink?.write(fields);
  }

  /** Run `fn`, logging started/completed(durationMs)/failed. Returns the result and the measured duration. */
  async time<T>(ctx: StageContext, fn: () => Promise<T>, extra: Fields = {}): Promise<{ value: T; durationMs: number }> {
    const t0 = this.now();
    this.event(ctx, "started", extra);
    try {
      const value = await fn();
      const durationMs = this.now() - t0;
      this.event(ctx, "completed", { durationMs, ...extra });
      return { value, durationMs };
    } catch (err) {
      const durationMs = this.now() - t0;
      const d = diagnostics(err);
      this.event(ctx, "failed", { durationMs, error: String(d.message), code: typeof d.code === "string" ? d.code : undefined });
      this.sink?.write({ project: this.projectId, stage: ctx.stage, scene: ctx.scene, status: "diagnostics", ...d });
      throw err;
    }
  }
}
