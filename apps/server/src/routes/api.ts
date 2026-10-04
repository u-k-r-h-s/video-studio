import { Router } from "express";
import { z } from "zod";
import { CreateProjectInputSchema, isJobActive, type Job } from "@studio/shared";
import type { EventBus } from "../events";
import { HttpError } from "../errors";
import type { JobContext, JobManager } from "../jobs/JobManager";
import { assertSafeId } from "../lib/paths";
import type { Studio } from "../pipeline/Studio";
import type { ProfileRegistry } from "../profiles";
import type { HealthService } from "../services/HealthService";
import type { ProjectStore } from "../storage/ProjectStore";
import type { ToolRegistry } from "../tools/ToolDispatcher";

export interface ApiDeps {
  store: ProjectStore;
  studio: Studio;
  jobs: JobManager;
  bus: EventBus;
  health: Pick<HealthService, "check">;
  profiles: ProfileRegistry;
  tools: ToolRegistry;
}

const MEDIA_EXTENSIONS = new Set([".png", ".mp4", ".wav", ".srt"]);

function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new HttpError(400, "validation_failed", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), r.error.issues);
  return r.data;
}

const RegenerateInput = z.object({
  parts: z.array(z.enum(["assets", "voice", "render"])).optional(),
  includeBackground: z.boolean().optional(),
  includeCharacters: z.boolean().optional(),
});

/** Only fixed, allow-listed operations are exposed. There is no endpoint that runs commands or reads arbitrary paths. */
export function createApiRouter(deps: ApiDeps): Router {
  const { store, studio, jobs, bus, health, profiles, tools } = deps;
  const router = Router();

  /** One pipeline job per project at a time; heavy work is serialised by the JobManager (concurrency 1). */
  const enqueue = (projectId: string, label: string, run: (ctx: JobContext) => Promise<void>, sceneId?: string): Job => {
    if (jobs.findActive(projectId)) throw new HttpError(409, "job_active", "This project is already being processed. Wait for it to finish or cancel it first.");
    return jobs.enqueue({ type: "pipeline", projectId, label, sceneId }, run);
  };
  const projectId = (raw: string | string[] | undefined) => assertSafeId(Array.isArray(raw) ? raw[0] : raw, "project id");

  router.get("/health", async (_req, res) => res.json(await health.check()));
  router.get("/profiles", (_req, res) => res.json({ profiles: profiles.list().map((p) => ({ id: p.id, pipeline: p.pipeline ?? "scenes", name: p.name, description: p.description, video: p.video, visualStyle: p.visualStyle.name, planning: p.planning, timing: { minSceneSeconds: p.timing.minSceneSeconds, maxSceneSeconds: p.timing.maxSceneSeconds } })) }));
  router.get("/tools", (_req, res) => res.json({ tools: tools.describe() }));

  router.get("/projects", async (_req, res) => res.json({ projects: await store.list() }));

  router.post("/projects", async (req, res) => {
    const input = parseBody(CreateProjectInputSchema, req.body);
    const profile = profiles.get(input.formatProfile);
    const project = await store.create(input, profile);
    const job = enqueue(project.id, "scene_planning", (ctx) => studio.plan(project.id, { signal: ctx.signal, progress: ctx.setProgress }));
    res.status(201).json({ project, job });
  });

  router.get("/projects/:id", async (req, res) => {
    const id = projectId(req.params.id);
    const activeJob = jobs.findActive(id) ?? null; // read the job first so "no active job" implies the files are final
    res.json({ project: await store.require(id), activeJob });
  });

  router.put("/projects/:id/plan", async (req, res) => {
    const id = projectId(req.params.id);
    if (jobs.findActive(id)) throw new HttpError(409, "job_active", "The project is being processed. Wait for it to finish or cancel it first.");
    await studio.editPlan(id, req.body);
    res.json({ project: await store.require(id) });
  });

  router.post("/projects/:id/approve", async (req, res) => {
    const id = projectId(req.params.id);
    await studio.approve(id);
    res.json({ project: await store.require(id) });
  });

  router.post("/projects/:id/replan", async (req, res) => {
    const id = projectId(req.params.id);
    await store.require(id);
    const { feedback } = parseBody(z.object({ feedback: z.string().trim().max(500).optional() }), req.body);
    res.status(202).json({ job: enqueue(id, "scene_planning", (ctx) => studio.plan(id, { signal: ctx.signal, progress: ctx.setProgress }, feedback || undefined)) });
  });

  /** images -> voices -> timeline -> render -> assemble. Resumable: finished work is skipped. */
  router.post("/projects/:id/produce", async (req, res) => {
    const id = projectId(req.params.id);
    const p = await store.require(id);
    if (!p.reviewApproved) throw new HttpError(409, "not_approved", "Review and approve the scene plan before generating.");
    res.status(202).json({ job: enqueue(id, "produce", (ctx) => studio.produce(id, { signal: ctx.signal, progress: ctx.setProgress })) });
  });

  router.post("/projects/:id/scenes/:sceneId/regenerate", async (req, res) => {
    const id = projectId(req.params.id);
    const sceneId = String(req.params.sceneId);
    const opts = parseBody(RegenerateInput, req.body);
    const p = await store.require(id);
    if (!p.scenes.some((s) => s.id === sceneId)) throw new HttpError(404, "scene_not_found", `Scene "${sceneId}" does not exist`);
    res.status(202).json({ job: enqueue(id, `regenerate:${sceneId}`, (ctx) => studio.regenerateScene(id, sceneId, opts, { signal: ctx.signal, progress: ctx.setProgress }), sceneId) });
  });

  /** Serves generated media (images, audio, video, SRT) from inside the project folder only. Supports Range requests. */
  router.get("/projects/:id/media/*path", async (req, res) => {
    const id = projectId(req.params.id);
    const segments = ([] as string[]).concat((req.params as Record<string, string | string[]>).path ?? []);
    const abs = store.resolve(id, ...segments); // throws on traversal
    const ext = segments.at(-1)?.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() ?? "";
    if (!MEDIA_EXTENSIONS.has(ext) || segments.some((s) => s.startsWith("."))) throw new HttpError(403, "media_forbidden", "That file type cannot be served.");
    if (req.query.download === "1") return res.download(abs, segments.at(-1)!, (err) => { if (err && !res.headersSent) res.status(404).json({ error: { code: "not_found", message: "File not found" } }); });
    res.sendFile(abs, { dotfiles: "deny", headers: { "Cache-Control": "no-cache" } }, (err) => { if (err && !res.headersSent) res.status(404).json({ error: { code: "not_found", message: "File not found" } }); });
  });

  router.get("/jobs", (_req, res) => res.json({ jobs: jobs.list() }));
  router.get("/jobs/:id", (req, res) => {
    const job = jobs.get(String(req.params.id));
    if (!job) throw new HttpError(404, "job_not_found", "Job not found");
    res.json({ job });
  });
  router.post("/jobs/:id/cancel", (req, res) => {
    const job = jobs.cancel(String(req.params.id));
    if (!job) throw new HttpError(404, "job_not_found", "Job not found");
    res.json({ job });
  });

  /** Server-Sent Events: job progress and project changes. */
  router.get("/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("snapshot", { jobs: jobs.list().filter(isJobActive) });
    const offJob = bus.on("job", (job) => send("job", job));
    const offProject = bus.on("project", (p) => send("project", p));
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => { clearInterval(heartbeat); offJob(); offProject(); });
  });

  return router;
}
