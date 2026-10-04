import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { FINAL_VIDEO_ASSET_ID } from "@studio/shared";
import { AppError, ComfyStopError, HttpError, StageOrderError } from "../src/errors";
import { ExecFileRunner } from "../src/lib/command";
import { findExecutable } from "../src/lib/exe";
import { ProjectStore } from "../src/storage/ProjectStore";
import { FFmpegMotionRenderer } from "../src/render/FFmpegMotionRenderer";
import { TOOL_NAMES } from "../src/tools/pipelineTools";
import { ToolDispatcher, ToolRegistry } from "../src/tools/ToolDispatcher";
import { makeHarness, type Harness } from "./harness";

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const planned = async (): Promise<{ h: Harness; id: string }> => {
  h = await makeHarness();
  const id = await h.newProject();
  await h.studio.plan(id);
  return { h, id };
};
const approved = async () => { const r = await planned(); await r.h.studio.approve(r.id); return r; };
const produced = async () => { const r = await approved(); await r.h.studio.produce(r.id); return r; };
const since = (h: Harness, mark: number) => h.events.slice(mark);
const first = (e: string[], prefix: string) => e.findIndex((x) => x.startsWith(prefix));

describe("scene planning stage", () => {
  it("produces a reviewable plan, then unloads Ollama and verifies it", async () => {
    const { h, id } = await planned();
    const p = await h.store.require(id);
    expect(p.status).toBe("review");
    expect(p.reviewApproved).toBe(false);
    expect(p.scenes).toHaveLength(3);
    expect(p.characters.map((c) => c.id)).toEqual(["raghu", "mintu"]);
    expect(p.title).toBe("The Midnight Thief");
    expect(p.stages.scene_planning.status).toBe("completed");
    expect(h.events).toEqual(["ollama:chat", "ollama:chat", "ollama:unload"]); // outline + scenes, then the gate
    expect(h.state.ollamaLoaded).toBe(false);
    expect((await fs.stat(h.store.resolve(id, "characters", "raghu", "character.json"))).isFile()).toBe(true);
  });

  it("FAILS (and keeps going no further) when Ollama cannot be unloaded", async () => {
    h = await makeHarness();
    h.state.ollamaUnloadWorks = false;
    const id = await h.newProject();
    const err = await h.studio.plan(id).catch((e: unknown) => e);
    expect((err as AppError).userMessage).toBe("Ollama model could not be unloaded.");
    const p = await h.store.require(id);
    expect(p.stages.scene_planning.status).toBe("failed");
    expect(p.stages.scene_planning.error).toContain("Ollama model could not be unloaded.");
    expect(p.scenes).toHaveLength(0);
    expect(p.status).toBe("draft");
  });

  it("unloads Ollama even when planning itself fails", async () => {
    const { FakeLLM } = await import("./helpers");
    h = await makeHarness({ llm: new FakeLLM(["not json at all"]) });
    const id = await h.newProject();
    await expect(h.studio.plan(id)).rejects.toBeInstanceOf(AppError);
    expect(h.events.at(-1)).toBe("ollama:unload");
    expect(h.state.ollamaLoaded).toBe(false);
  });

  it("refuses to load Ollama while ComfyUI is running", async () => {
    h = await makeHarness();
    h.state.comfyAlive = true;
    const id = await h.newProject();
    const err = await h.studio.plan(id).catch((e: unknown) => e);
    expect((err as AppError).code).toBe("memory_gate_violation");
    expect(h.events).not.toContain("ollama:chat");
  });
});

describe("full pipeline: stage ordering and memory gates", () => {
  it("runs Ollama -> unload -> ComfyUI (one session) -> stop -> Piper -> FFmpeg, strictly sequentially", async () => {
    const { h, id } = await produced();
    const e = h.events;
    const idx = (p: string) => first(e, p);
    expect(idx("ollama:unload")).toBeGreaterThan(idx("ollama:chat"));
    expect(idx("comfy:start")).toBeGreaterThan(idx("ollama:unload"));
    expect(e.filter((x) => x === "comfy:start")).toHaveLength(1);       // ONE session for the whole project
    expect(e.filter((x) => x === "comfy:stop")).toHaveLength(1);
    expect(e.filter((x) => x === "comfy:prompt")).toHaveLength(5);      // 1 shared background + 2 characters + 2 props
    expect(idx("comfy:free")).toBeGreaterThan(e.lastIndexOf("comfy:prompt"));
    expect(idx("comfy:stop")).toBeGreaterThan(idx("comfy:free"));
    expect(idx("piper:")).toBeGreaterThan(idx("comfy:stop"));
    expect(idx("subtitle:")).toBeGreaterThan(e.lastIndexOf("piper:scene-03-d02"));
    expect(idx("render:")).toBeGreaterThan(e.lastIndexOf(e.filter((x) => x.startsWith("subtitle:")).at(-1)!));
    expect(idx("assemble:")).toBeGreaterThan(e.lastIndexOf("render:scene-03"));
    const p = await h.store.require(id);
    expect(p.status).toBe("completed");
    expect(Object.values(p.stages).every((s) => s.status === "completed")).toBe(true);
    expect(p.assets.find((a) => a.id === FINAL_VIDEO_ASSET_ID)?.status).toBe("ready");
    expect(await fs.readFile(h.store.resolve(id, "final/final.mp4"), "utf8")).toBe("final");
  });

  it("derives dialogue timings and scene durations from the real audio", async () => {
    const { h, id } = await produced();
    const p = await h.store.require(id);
    const s3 = p.scenes[2]!;
    expect(s3.dialogue[0]!.startTime).toBeCloseTo(0.4, 3);
    expect(s3.dialogue[1]!.startTime!).toBeGreaterThan(s3.dialogue[0]!.endTime!); // gap between lines
    expect(s3.duration).toBeCloseTo(s3.dialogue[1]!.endTime! + 0.7, 2);
    expect(p.scenes.every((s) => s.status === "rendered")).toBe(true);
    expect(p.audio).toHaveLength(4);
    expect(p.assets.filter((a) => a.kind === "subtitle")).toHaveLength(4);
    expect((await fs.readFile(h.store.resolve(id, "final/subtitles.srt"), "utf8")).match(/-->/g)).toHaveLength(4);
  });

  it("character cut-outs are keyed to transparency and cropped", async () => {
    const { h, id } = await produced();
    const a = (await h.store.require(id)).assets.find((x) => x.id === "char-raghu")!;
    expect(Number(a.meta.width)).toBeLessThan(64);
    expect(Number(a.meta.height)).toBeLessThan(112);
    expect(a.path).toBe("images/char-raghu.png");
    expect(await h.store.exists(id, String(a.meta.rawPath))).toBe(true);
  });

  it("blocks generation until the plan is approved", async () => {
    const { h, id } = await planned();
    await expect(h.studio.produce(id)).rejects.toBeInstanceOf(StageOrderError);
    expect(h.events.some((e) => e.startsWith("comfy:"))).toBe(false);
  });

  it("stops before Piper when ComfyUI shutdown cannot be verified", async () => {
    const { h, id } = await approved();
    h.state.comfyStopVerifyFails = true; // the port still answers after stop()
    const err = await h.studio.produce(id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComfyStopError);
    expect(h.events.some((e) => e.startsWith("piper:"))).toBe(false);
    const p = await h.store.require(id);
    expect(p.stages.image_generation.status).toBe("failed");
    expect(p.status).toBe("failed");
    expect(p.errors.at(-1)!.message).toContain("ComfyUI could not be stopped.");
  });
});

describe("resumability and caching", () => {
  it("a failed image batch keeps finished images; the next run generates ONLY the missing ones", async () => {
    const { h, id } = await approved();
    h.state.failPromptNumber = 3;
    await expect(h.studio.produce(id)).rejects.toBeInstanceOf(AppError);
    let p = await h.store.require(id);
    expect(p.assets.filter((a) => a.status === "ready")).toHaveLength(2);
    expect(p.stages.image_generation.status).toBe("failed");
    expect(h.events.at(-1)).not.toBe("comfy:prompt");
    expect(h.state.comfyAlive).toBe(false); // memory released even though the batch failed
    h.state.failPromptNumber = undefined;
    const mark = h.events.length;
    await h.studio.produce(id);
    expect(since(h, mark).filter((e) => e === "comfy:prompt")).toHaveLength(3); // 5 needed - 2 already done
    p = await h.store.require(id);
    expect(p.status).toBe("completed");
    expect(p.stages.image_generation.status).toBe("completed");
  });

  it("a second run over finished work does nothing (no ComfyUI, Piper or FFmpeg calls)", async () => {
    const { h, id } = await produced();
    const mark = h.events.length;
    await h.studio.produce(id);
    expect(since(h, mark)).toEqual([]);
  });

  it("recovers from a crash: interrupted stages become 'failed' and the rerun skips finished work", async () => {
    const { h, id } = await produced();
    await h.store.update(id, (p) => { p.stages.scene_render = { status: "running", startedAt: "x" }; p.status = "generating"; });
    const fresh = new ProjectStore(h.dir); // a "restarted" server
    expect(await fresh.recoverInterrupted()).toEqual([id]);
    const p = await fresh.require(id);
    expect(p.stages.scene_render.status).toBe("failed");
    expect(p.status).toBe("approved");
    const mark = h.events.length;
    await h.studio.produce(id);
    expect(since(h, mark).filter((e) => e.startsWith("comfy:") || e.startsWith("piper:") || e.startsWith("render:"))).toEqual([]); // nothing regenerated
    expect((await h.store.require(id)).stages.scene_render.status).toBe("completed");
  });

  it("a failed stage is recorded with a readable error, blocks later stages, and resumes after the fix", async () => {
    const { h, id } = await approved();
    h.state.ttsFails = true;
    await expect(h.studio.produce(id)).rejects.toThrow("piper crashed");
    let p = await h.store.require(id);
    expect(p.stages.image_generation.status).toBe("completed");
    expect(p.stages.voice_generation.status).toBe("failed");
    expect(p.stages.scene_render.status).toBe("pending");
    expect(p.status).toBe("failed");
    expect(p.errors.at(-1)).toMatchObject({ stage: "voice_generation" });
    expect(h.events.some((e) => e.startsWith("render:"))).toBe(false);
    h.state.ttsFails = false;
    const mark = h.events.length;
    await h.studio.produce(id);
    expect(since(h, mark).some((e) => e.startsWith("comfy:"))).toBe(false); // images were not regenerated
    p = await h.store.require(id);
    expect(p.status).toBe("completed");
    expect(p.stages.voice_generation.error).toBeUndefined();
  });

  it("editing one dialogue line regenerates only that line's voice and that scene's clip", async () => {
    const { h, id } = await produced();
    const plan = await h.store.require(id);
    const edit = { title: plan.title, characters: plan.characters, scenes: plan.scenes.map((s) => (s.id === "scene-02" ? { ...s, dialogue: [{ ...s.dialogue[0]!, text: "He waited, very quietly, in the dark." }] } : s)) };
    await h.studio.editPlan(id, edit);
    const mark = h.events.length;
    await h.studio.produce(id);
    const e = since(h, mark);
    expect(e.filter((x) => x.startsWith("piper:"))).toEqual(["piper:scene-02-d01"]);
    expect(e.filter((x) => x.startsWith("render:"))).toEqual(["render:scene-02"]);
    expect(e.some((x) => x.startsWith("comfy:"))).toBe(false);
    expect(e.at(-1)).toBe("assemble:3");
  });
});

describe("scene-level regeneration (never the whole project)", () => {
  it("voice only: re-synthesizes that scene's lines, re-renders that scene, re-assembles", async () => {
    const { h, id } = await produced();
    const mark = h.events.length;
    await h.studio.regenerateScene(id, "scene-03", { parts: ["voice"] });
    const e = since(h, mark);
    expect(e.filter((x) => x.startsWith("piper:"))).toEqual(["piper:scene-03-d01", "piper:scene-03-d02"]);
    expect(e.filter((x) => x.startsWith("render:"))).toEqual(["render:scene-03"]);
    expect(e.some((x) => x.startsWith("comfy:"))).toBe(false);
    expect(e.at(-1)).toBe("assemble:3");
  });

  it("assets only: regenerates ONLY that scene's props in a single ComfyUI session, with a new seed", async () => {
    const { h, id } = await produced();
    const before = (await h.store.require(id)).assets.find((a) => a.id === "prop-scene-01-wooden-mousetrap")!;
    const mark = h.events.length;
    await h.studio.regenerateScene(id, "scene-01", { parts: ["assets"] });
    const e = since(h, mark);
    expect(e.filter((x) => x === "comfy:prompt")).toHaveLength(1);                 // the mousetrap, not the shared background/characters
    expect(e.filter((x) => x === "comfy:start")).toHaveLength(1);
    expect(e.filter((x) => x === "comfy:stop")).toHaveLength(1);
    expect(e.filter((x) => x.startsWith("render:"))).toEqual(["render:scene-01"]); // new image invalidates only this clip
    expect(e.filter((x) => x.startsWith("piper:"))).toEqual([]);
    const after = (await h.store.require(id)).assets.find((a) => a.id === before.id)!;
    expect(after.meta.attempt).toBe(1);
    expect(after.meta.seed).not.toBe(before.meta.seed);
  });

  it("can give one scene its own background without touching the others", async () => {
    const { h, id } = await produced();
    const mark = h.events.length;
    await h.studio.regenerateScene(id, "scene-02", { parts: ["assets"], includeBackground: true });
    const e = since(h, mark);
    expect(e.filter((x) => x === "comfy:prompt")).toHaveLength(1); // the override background (scene-02 has no props)
    expect(e.filter((x) => x.startsWith("render:"))).toEqual(["render:scene-02"]);
    expect((await h.store.require(id)).assets.some((a) => a.id === "bg-scene-02")).toBe(true);
  });

  it("render only: re-renders the scene (forced) and nothing else", async () => {
    const { h, id } = await produced();
    const mark = h.events.length;
    await h.studio.regenerateScene(id, "scene-02", { parts: ["render"] });
    expect(since(h, mark)).toEqual(["render:scene-02", "assemble:3"]);
  });

  it("rejects unknown scenes", async () => {
    const { h, id } = await produced();
    await expect(h.studio.regenerateScene(id, "scene-99")).rejects.toMatchObject({ code: "scene_not_found" });
  });
});

describe("tool registry: allow-listed, one dispatcher, no shell", () => {
  it("exposes exactly the six MVP tools", async () => {
    h = await makeHarness();
    expect(h.dispatcher).toBeInstanceOf(ToolDispatcher);
    const { createPipelineTools } = await import("../src/tools/pipelineTools");
    const names = createPipelineTools(h.runner, () => undefined).names();
    expect(names.sort()).toEqual([...TOOL_NAMES].sort());
    expect(names.some((n) => /shell|exec|command|bash|run/i.test(n))).toBe(false);
  });
  it("refuses unknown tools and registered-but-not-allow-listed tools", async () => {
    h = await makeHarness();
    await expect(h.dispatcher.dispatch("rm_rf", {})).rejects.toMatchObject({ code: "tool_not_allowed" });
    const reg = new ToolRegistry().register({ name: "danger", description: "x", inputSchema: (await import("zod")).z.object({}), execute: async () => "pwned" });
    await expect(new ToolDispatcher(reg, ["safe_only"]).dispatch("danger", {})).rejects.toMatchObject({ code: "tool_not_allowed" });
  });
  it("validates tool input before executing", async () => {
    h = await makeHarness();
    await expect(h.dispatcher.dispatch("generate_images", { projectId: 123 })).rejects.toBeInstanceOf(HttpError);
    await expect(h.dispatcher.dispatch("generate_images", {})).rejects.toMatchObject({ code: "invalid_tool_input" });
    expect(h.events).toEqual([]);
  });
  it("describes tools with JSON Schema for a future LLM director", async () => {
    h = await makeHarness();
    const { createPipelineTools } = await import("../src/tools/pipelineTools");
    const d = createPipelineTools(h.runner, () => undefined).describe();
    expect(d.find((t) => t.name === "generate_images")!.inputSchema).toMatchObject({ type: "object" });
  });
});

describe("plan editing and approval", () => {
  it("applies a valid edit, renumbers dialogue ids and resets changed scenes", async () => {
    const { h, id } = await planned();
    const p = await h.store.require(id);
    const scenes = p.scenes.map((s, i) => (i === 0 ? { ...s, visualDescription: "A shop at midnight, rain outside.", dialogue: [...s.dialogue, { id: "tmp", characterId: "raghu", text: "Who is there?" }] } : s));
    await h.studio.editPlan(id, { title: "Night Watch", characters: p.characters, scenes });
    const after = await h.store.require(id);
    expect(after.title).toBe("Night Watch");
    expect(after.scenes[0]!.dialogue.map((d) => d.id)).toEqual(["scene-01-d01", "scene-01-d02"]);
    expect(after.scenes[0]!.status).toBe("planned");
  });
  it("rejects invalid edits with readable messages", async () => {
    const { h, id } = await planned();
    const p = await h.store.require(id);
    const bad = { title: "T", characters: p.characters, scenes: p.scenes.map((s, i) => (i === 0 ? { ...s, characters: ["ghost"] } : s)) };
    await expect(h.studio.editPlan(id, bad)).rejects.toMatchObject({ code: "plan_invalid" });
    await expect(h.studio.editPlan(id, { title: "", characters: [], scenes: [] })).rejects.toMatchObject({ code: "plan_invalid" });
  });
  it("cannot approve an empty project or edit while a stage is running", async () => {
    h = await makeHarness();
    const id = await h.newProject();
    await expect(h.studio.approve(id)).rejects.toBeInstanceOf(StageOrderError);
    await h.studio.plan(id);
    await h.store.update(id, (p) => { p.status = "generating"; });
    const p = await h.store.require(id);
    await expect(h.studio.editPlan(id, { title: p.title, characters: p.characters, scenes: p.scenes })).rejects.toMatchObject({ code: "project_busy" });
  });
});

describe("observability", () => {
  it("writes structured stage logs with per-asset start/complete and durations", async () => {
    const { h, id } = await produced();
    const lines = (await fs.readFile(h.store.resolve(id, "logs", "pipeline.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const forAsset = lines.filter((l) => l.stage === "image_generation" && l.asset === "char-raghu");
    expect(forAsset.map((l) => l.status)).toEqual(["started", "completed"]);
    expect(forAsset[1]).toMatchObject({ project: id, stage: "image_generation", asset: "char-raghu" });
    expect(typeof forAsset[1].durationMs).toBe("number");
    expect(lines.some((l) => l.stage === "scene_render" && l.scene === "scene-02" && l.status === "completed" && typeof l.durationMs === "number")).toBe(true);
    expect(lines.some((l) => l.stage === "image_generation" && l.status === "memory" && l.freePercent === 60)).toBe(true);
  });
  it("records diagnostics for failures in the log but only a user message in the project", async () => {
    const { h, id } = await approved();
    h.state.ttsFails = true;
    await h.studio.produce(id).catch(() => {});
    const lines = (await fs.readFile(h.store.resolve(id, "logs", "pipeline.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((l) => l.status === "diagnostics" && l.stage === "voice_generation")).toBe(true);
    expect((await h.store.require(id)).errors.at(-1)!.message).not.toMatch(/\bat \S+\.ts/);
  });
});

const FFMPEG = findExecutable("ffmpeg");
const FFPROBE = findExecutable("ffprobe");
describe.skipIf(!FFMPEG || !FFPROBE)("end-to-end with the REAL FFmpeg renderer", () => {
  it("produces a valid 1080x1920 30fps MP4 with audio, matching the scene timeline", async () => {
    const runner = new ExecFileRunner([FFMPEG!, FFPROBE!]);
    const real = new FFmpegMotionRenderer(runner, { ffmpeg: FFMPEG!, ffprobe: FFPROBE!, timeoutMs: 180_000, encoderOverride: "libx264" });
    h = await makeHarness({ renderer: real });
    const id = await h.newProject();
    await h.studio.plan(id);
    await h.studio.approve(id);
    await h.studio.produce(id);
    const p = await h.store.require(id);
    const fin = p.assets.find((a) => a.id === FINAL_VIDEO_ASSET_ID)!;
    const probe = await real.probe(h.store.resolve(id, fin.path));
    expect([probe.width, probe.height, probe.fps]).toEqual([1080, 1920, 30]);
    expect(probe.hasAudio).toBe(true);
    const expected = p.scenes.reduce((n, s) => n + s.duration, 0);
    expect(Math.abs(probe.durationSec - expected)).toBeLessThan(0.6);
    expect(p.status).toBe("completed");
  }, 240_000);
});
