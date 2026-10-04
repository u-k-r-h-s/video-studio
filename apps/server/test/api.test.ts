import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { EventBus } from "../src/events";
import { JobManager } from "../src/jobs/JobManager";
import { createPipelineTools } from "../src/tools/pipelineTools";
import { makeHarness, type Harness } from "./harness";

let h: Harness | undefined;
let server: http.Server | undefined;
let base = "";
let port = 0;
afterEach(async () => { server?.close(); server = undefined; await h?.close(); h = undefined; });

async function start() {
  h = await makeHarness();
  const bus = new EventBus();
  const jobs = new JobManager(bus, 1);
  const tools = createPipelineTools(h.runner, (id) => jobs.get(id));
  server = http.createServer();
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  const health = { check: async () => ({ services: {}, gates: { ollamaResident: false, comfyuiRunning: false }, checkedAt: "now" }) } as never;
  server.on("request", createApp({ deps: { store: h.store, studio: h.studio, jobs, bus, health, profiles: h.svc.profiles, tools }, allowedOrigins: ["http://localhost:5173"], port }));
  return { h, jobs };
}

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${url}`, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
async function settle(id: string) {
  for (let i = 0; i < 400; i++) { const r = await call("GET", `/api/projects/${id}`); if (!r.json.activeJob) return r.json.project; await new Promise((r) => setTimeout(r, 15)); }
  throw new Error("job did not finish");
}

const idea = { inputMode: "idea", inputText: "A clever village detective catches a thief who steals food at night.", language: "en", targetDurationSeconds: 20 };

describe("API: guards and metadata", () => {
  it("blocks foreign hosts/origins and non-JSON bodies", async () => {
    await start();
    expect((await call("POST", "/api/projects", idea, { Origin: "https://evil.example" })).status).toBe(403);
    const rebinding = await new Promise<number>((resolve, reject) => { http.get({ host: "127.0.0.1", port, path: "/api/profiles", headers: { Host: "evil.example" } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }).on("error", reject); });
    expect(rebinding).toBe(403);
    const res = await fetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(idea) });
    expect(res.status).toBe(415);
  });
  it("lists profiles and the six allow-listed tools", async () => {
    await start();
    expect((await call("GET", "/api/profiles")).json.profiles[0]).toMatchObject({ id: "motion-comic", video: { width: 1080, height: 1920 } });
    expect((await call("GET", "/api/tools")).json.tools.map((t: any) => t.name).sort()).toEqual(["assemble_video", "create_scene_plan", "generate_images", "generate_voice", "get_job_status", "render_scene"]);
  });
  it("validates input and returns readable errors without stack traces", async () => {
    await start();
    const bad = await call("POST", "/api/projects", { inputMode: "idea", inputText: "x" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("validation_failed");
    expect(bad.text).not.toMatch(/\.ts:\d+/);
    expect((await call("GET", "/api/projects/does-not-exist")).status).toBe(404);
    expect((await call("GET", "/api/projects/..%2F..%2Fetc")).status).toBe(400);
    expect((await call("POST", "/api/projects", { ...idea, formatProfile: "documentary" })).json.error.code).toBe("unknown_profile");
  });
});

describe("API: the whole flow", () => {
  it("create -> plan -> review/edit -> approve -> produce -> media -> regenerate one scene", async () => {
    const { h } = await start();
    const created = await call("POST", "/api/projects", idea);
    expect(created.status).toBe(201);
    expect(created.json.job).toMatchObject({ type: "pipeline", label: "scene_planning" });
    const id = created.json.project.id as string;

    let project = await settle(id);
    expect(project.status).toBe("review");
    expect(project.scenes).toHaveLength(3);

    // cannot generate before approval
    expect((await call("POST", `/api/projects/${id}/produce`)).json.error.code).toBe("not_approved");

    // human edit
    const edit = { title: "Night Watch", characters: project.characters, scenes: project.scenes.map((s: any, i: number) => (i === 0 ? { ...s, visualDescription: "A shop at midnight, rain outside." } : s)) };
    expect((await call("PUT", `/api/projects/${id}/plan`, edit)).status).toBe(200);
    expect((await call("PUT", `/api/projects/${id}/plan`, { ...edit, scenes: [] })).json.error.code).toBe("plan_invalid");

    expect((await call("POST", `/api/projects/${id}/approve`)).json.project.reviewApproved).toBe(true);
    const produce = await call("POST", `/api/projects/${id}/produce`);
    expect(produce.status).toBe(202);
    expect((await call("POST", `/api/projects/${id}/produce`)).status).toBe(409); // one job per project
    project = await settle(id);
    expect(project.status).toBe("completed");

    // media: final video with Range support, image, SRT; nothing else
    const full = await call("GET", `/api/projects/${id}/media/final/final.mp4`);
    expect(full.status).toBe(200);
    expect(full.text).toBe("final");
    const part = await fetch(`${base}/api/projects/${id}/media/final/final.mp4`, { headers: { Range: "bytes=0-2" } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("fin");
    expect((await call("GET", `/api/projects/${id}/media/images/char-raghu.png`)).headers.get("content-type")).toContain("image/png");
    expect((await call("GET", `/api/projects/${id}/media/final/subtitles.srt`)).status).toBe(200);
    expect((await call("GET", `/api/projects/${id}/media/project.json`)).status).toBe(403);       // JSON/state is not served
    expect((await call("GET", `/api/projects/${id}/media/logs/pipeline.jsonl`)).status).toBe(403);
    expect((await call("GET", `/api/projects/${id}/media/%2e%2e/%2e%2e/etc/passwd.png`)).status).toBeGreaterThanOrEqual(400);
    expect((await call("GET", `/api/projects/${id}/media/final/nope.mp4`)).status).toBe(404);

    // regenerate ONE scene via the API
    const mark = h.events.length;
    const regen = await call("POST", `/api/projects/${id}/scenes/scene-02/regenerate`, { parts: ["voice"] });
    expect(regen.status).toBe(202);
    expect(regen.json.job.label).toBe("regenerate:scene-02");
    await settle(id);
    expect(h.events.slice(mark).filter((e) => e.startsWith("render:"))).toEqual(["render:scene-02"]);
    expect((await call("POST", `/api/projects/${id}/scenes/scene-77/regenerate`, {})).status).toBe(404);
    expect((await call("POST", `/api/projects/${id}/scenes/scene-02/regenerate`, { parts: ["everything"] })).status).toBe(400);
  });

  it("reports a failed job with a readable message and keeps the project resumable", async () => {
    const { h } = await start();
    const id = (await call("POST", "/api/projects", idea)).json.project.id as string;
    await settle(id);
    await call("POST", `/api/projects/${id}/approve`);
    h.state.ttsFails = true;
    await call("POST", `/api/projects/${id}/produce`);
    const project = await settle(id);
    expect(project.status).toBe("failed");
    expect(project.stages.voice_generation.status).toBe("failed");
    const jobs = (await call("GET", "/api/jobs")).json.jobs;
    expect(jobs[0].status).toBe("failed");
    expect(jobs[0].error).toBeTruthy();
    h.state.ttsFails = false;
    await call("POST", `/api/projects/${id}/produce`); // resume
    expect((await settle(id)).status).toBe("completed");
  });

  it("serves SSE progress events", async () => {
    await start();
    const res = await fetch(`${base}/api/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: snapshot");
    await reader.cancel();
  });
});
