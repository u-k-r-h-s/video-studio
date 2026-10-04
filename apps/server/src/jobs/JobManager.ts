import { randomUUID } from "node:crypto";
import type { Job, JobType } from "@studio/shared";
import { isJobActive } from "@studio/shared";
import { describeError } from "../errors";
import type { EventBus } from "../events";
import { createLogger } from "../lib/logger";

export interface JobContext {
  /** Aborted when the job is cancelled. Pass it to every long-running call. */
  signal: AbortSignal;
  setProgress(progress: number, message?: string): void;
}
export type JobRunner = (ctx: JobContext) => Promise<void>;

interface Entry {
  job: Job;
  runner: JobRunner;
  controller: AbortController;
}

const MAX_FINISHED_JOBS = 200;
const log = createLogger("jobs");

/**
 * In-memory job queue. Jobs are not persisted: after a restart the project's own
 * stage state (project.json) is what survives. Concurrency defaults to 1 because
 * local GPU/CPU-bound tools (Ollama, ComfyUI, Blender) should not run in parallel.
 */
export class JobManager {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: string[] = [];
  private running = 0;

  constructor(
    private readonly bus: EventBus,
    private readonly concurrency = 1,
  ) {}

  enqueue(spec: { type: JobType; projectId: string; label: string; sceneId?: string | null }, runner: JobRunner): Job {
    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      type: spec.type,
      projectId: spec.projectId,
      label: spec.label,
      sceneId: spec.sceneId ?? null,
      progress: 0,
      status: "queued",
      message: "Queued",
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.set(job.id, { job, runner, controller: new AbortController() });
    this.queue.push(job.id);
    this.bus.emit("job", { ...job });
    log.info(`queued ${job.type}`, { id: job.id, projectId: job.projectId });
    queueMicrotask(() => this.pump());
    return { ...job };
  }

  list(): Job[] {
    return [...this.entries.values()].map((e) => ({ ...e.job })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Job | undefined {
    const e = this.entries.get(id);
    return e ? { ...e.job } : undefined;
  }

  findActive(projectId: string, type?: JobType): Job | undefined {
    return this.list().find((j) => j.projectId === projectId && isJobActive(j) && (!type || j.type === type));
  }

  cancel(id: string): Job | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (!isJobActive(entry.job)) return { ...entry.job };
    if (entry.job.status === "queued") {
      const idx = this.queue.indexOf(id);
      if (idx >= 0) this.queue.splice(idx, 1);
      entry.controller.abort();
      this.update(entry, { status: "cancelled", message: "Cancelled" });
    } else {
      entry.controller.abort(); // the runner observes the signal; run() records the final state
    }
    return { ...entry.job };
  }

  private update(entry: Entry, patch: Partial<Job>): void {
    Object.assign(entry.job, patch, { updatedAt: new Date().toISOString() });
    this.bus.emit("job", { ...entry.job });
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const id = this.queue.shift();
      if (!id) return;
      const entry = this.entries.get(id);
      if (entry && entry.job.status === "queued") void this.run(entry);
    }
  }

  private async run(entry: Entry): Promise<void> {
    this.running++;
    this.update(entry, { status: "running", progress: 1, message: "Starting" });
    const { signal } = entry.controller;
    try {
      await entry.runner({
        signal,
        setProgress: (progress, message) => {
          if (entry.job.status !== "running") return;
          this.update(entry, {
            progress: Math.max(0, Math.min(100, Math.round(progress))),
            ...(message !== undefined ? { message } : {}),
          });
        },
      });
      if (signal.aborted) this.update(entry, { status: "cancelled", message: "Cancelled" });
      else this.update(entry, { status: "completed", progress: 100, message: "Done" });
    } catch (err) {
      if (signal.aborted) {
        this.update(entry, { status: "cancelled", message: "Cancelled" });
      } else {
        const error = describeError(err);
        log.error(`job failed: ${error}`, { id: entry.job.id, type: entry.job.type });
        this.update(entry, { status: "failed", error, message: "Failed" });
      }
    } finally {
      this.running--;
      this.prune();
      this.pump();
    }
  }

  private prune(): void {
    const finished = [...this.entries.values()].filter((e) => !isJobActive(e.job));
    if (finished.length <= MAX_FINISHED_JOBS) return;
    finished
      .sort((a, b) => a.job.updatedAt.localeCompare(b.job.updatedAt))
      .slice(0, finished.length - MAX_FINISHED_JOBS)
      .forEach((e) => this.entries.delete(e.job.id));
  }
}
