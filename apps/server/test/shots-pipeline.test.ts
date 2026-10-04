import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FormatProfile } from "@studio/shared";
import { ExecFileRunner } from "../src/lib/command";
import { findExecutable } from "../src/lib/exe";
import { setLogQuiet } from "../src/lib/logger";
import { cinematicAnimatedShort } from "../src/profiles/cinematicAnimatedShort";
import { FFmpegMotionRenderer } from "../src/render/FFmpegMotionRenderer";
import { FakeLLM } from "./helpers";
import { makeHarness, type Harness } from "./harness";
import { DIRECTOR_OUTLINE, DIRECTOR_SHOTS } from "./fixtures-director";

beforeAll(() => setLogQuiet(true));
const FFMPEG = findExecutable("ffmpeg"), FFPROBE = findExecutable("ffprobe");
const HELPER = path.resolve(__dirname, "../../../bin/subpng");
const ready = !!FFMPEG && !!FFPROBE && existsSync(HELPER) && process.platform === "darwin";

/** The real profile, shrunk so the real FFmpeg renders it in seconds. */
const small: FormatProfile = {
  ...cinematicAnimatedShort,
  video: { ...cinematicAnimatedShort.video, width: 270, height: 480, fps: 15, videoEncoder: "libx264", videoBitrateKbps: 2000 },
  cinematic: { ...cinematicAnimatedShort.cinematic!, bitrateKbps: 2000, captions: { ...cinematicAnimatedShort.cinematic!.captions, size: 34, maxWidth: 250, stroke: 3 } },
};
const llm = () => new FakeLLM((req) => (req.messages.some((m) => m.content.includes("story bible")) ? DIRECTOR_OUTLINE : DIRECTOR_SHOTS));

describe.skipIf(!ready)("shot pipeline end to end (fake Ollama/ComfyUI/Piper, REAL FFmpeg + CoreText)", () => {
  let h: Harness;
  let id = "";
  beforeAll(async () => {
    const runner = new ExecFileRunner([FFMPEG!, FFPROBE!, HELPER]);
    const renderer = new FFmpegMotionRenderer(runner, { ffmpeg: FFMPEG!, ffprobe: FFPROBE!, timeoutMs: 120_000, encoderOverride: "libx264" });
    h = await makeHarness({ profile: small, llm: llm(), media: { runner, ffmpeg: FFMPEG!, ffprobe: FFPROBE!, captionHelper: HELPER, renderer } });
    id = await h.newProject({ inputText: "Create a 25 second animated mystery short about a delivery rider.", formatProfile: small.id, targetDurationSeconds: 25 });
  }, 60_000);
  afterAll(async () => { await h.close(); });

  it("plans a story: director output -> shots, scenes derived for the review screen, Ollama unloaded and verified", async () => {
    await h.studio.plan(id);
    const p = await h.store.require(id);
    expect(p.status).toBe("review");
    expect(p.story!.shots).toHaveLength(10);
    expect(p.scenes.length).toBe(p.story!.scenes.length);
    expect(p.scenes[0]!.id).toBe("scene-01");
    expect(p.characters.map((c) => c.id)).toEqual(["kai", "stranger"]);
    expect(p.title).not.toBe("");
    expect(h.state.ollamaLoaded).toBe(false);
    expect(h.events.filter((e) => e === "ollama:unload").length).toBeGreaterThanOrEqual(1);
  });

  it("refuses to edit a shot project through the scene editor", async () => {
    await expect(h.studio.editPlan(id, { title: "x", characters: [], scenes: [] })).rejects.toThrow(/Shot-based/);
  });

  it("will not generate before approval", async () => {
    await expect(h.studio.produce(id)).rejects.toThrow(/approve/i);
  });

  it("produces a valid video: images in ONE ComfyUI session after Ollama, voices after ComfyUI, one clip per shot, final 270x480 with audio", async () => {
    await h.studio.approve(id);
    h.events.length = 0;
    await h.studio.produce(id);
    const p = await h.store.require(id);
    expect(p.status).toBe("completed");
    const story = p.story!;

    // memory-gate order: comfy started once, stopped, and only then Piper ran
    const ev = h.events;
    expect(ev.filter((e) => e === "comfy:start")).toHaveLength(1);
    expect(ev.indexOf("comfy:stop")).toBeGreaterThan(ev.lastIndexOf("comfy:prompt"));
    expect(ev.findIndex((e) => e.startsWith("piper:"))).toBeGreaterThan(ev.indexOf("comfy:stop"));

    // few images, shared between shots; variants were uploaded as img2img inits
    const keys = p.assets.filter((a) => a.kind === "key_visual");
    expect(keys.length).toBe(story.keyVisuals.length);
    expect(keys.length).toBeLessThan(story.shots.length);
    expect(ev.filter((e) => e === "comfy:prompt")).toHaveLength(keys.length);
    expect(ev.filter((e) => e === "comfy:upload").length).toBe(story.keyVisuals.filter((k) => k.initFrom).length);
    expect(keys.every((k) => k.meta.model === "ds8")).toBe(true);

    // voices: one per spoken shot, distinct characters resolved to voice ids
    expect(p.audio).toHaveLength(story.shots.filter((s) => s.dialogue.length).length);
    expect(new Set(p.audio.map((a) => a.voiceId)).size).toBeGreaterThanOrEqual(2);

    // timeline artifacts
    expect(p.assets.filter((a) => a.kind === "caption")).toHaveLength(story.shots.length);
    expect(p.assets.find((a) => a.id === "soundtrack-mix")?.status).toBe("ready");
    expect(p.assets.filter((a) => a.kind === "shot_video")).toHaveLength(story.shots.length);

    // the final video
    const fin = p.assets.find((a) => a.kind === "final_video")!;
    expect(fin.status).toBe("ready");
    const file = h.store.resolve(id, fin.path);
    const probe = await new FFmpegMotionRenderer(new ExecFileRunner([FFMPEG!, FFPROBE!]), { ffmpeg: FFMPEG!, ffprobe: FFPROBE!, timeoutMs: 30_000 }).probe(file);
    expect(probe).toMatchObject({ width: 270, height: 480, hasAudio: true, videoCodec: "h264" });
    const expected = story.shots.reduce((s, x) => s + x.duration, 0);
    expect(probe.durationSec).toBeGreaterThanOrEqual(expected - 0.5);
    expect(await fs.readFile(h.store.resolve(id, "final/subtitles.srt"), "utf8")).toContain("Again");
  }, 240_000);

  it("a second run does nothing (everything is cached by input hash)", async () => {
    const before = (await h.store.require(id)).assets.map((a) => [a.id, a.createdAt]);
    h.events.length = 0;
    await h.studio.produce(id);
    expect(h.events.filter((e) => e.startsWith("comfy:") || e.startsWith("piper:"))).toEqual([]);
    expect((await h.store.require(id)).assets.map((a) => [a.id, a.createdAt])).toEqual(before);
  }, 120_000);

  it("regenerating ONE scene re-renders only that scene's shots (new seed for its images) and re-assembles", async () => {
    const p0 = await h.store.require(id);
    const story = p0.story!;
    const scene = story.scenes[1]!;
    const shotIds = new Set(scene.shotIds);
    const before = new Map(p0.assets.map((a) => [a.id, a.createdAt]));
    await h.studio.regenerateScene(id, p0.scenes[1]!.id, { parts: ["assets", "render"] });
    const p1 = await h.store.require(id);
    const changed = p1.assets.filter((a) => before.get(a.id) !== a.createdAt).map((a) => a.id);
    expect(changed).toContain("final-video");
    const changedClips = new Set(changed.filter((c) => c.startsWith("shot-video-")).map((c) => c.replace("shot-video-", "")));
    // a regenerated image changes every clip built from it, so the affected set is: shots sharing an image with the scene
    const affected = new Set(story.keyVisuals.filter((k) => k.shotIds.some((x) => shotIds.has(x))).flatMap((k) => k.shotIds));
    for (const sid of shotIds) expect(changedClips.has(sid)).toBe(true);
    for (const c of changedClips) expect(affected.has(c)).toBe(true);
    const outside = story.shots.filter((s) => !affected.has(s.id));
    expect(outside.length).toBeGreaterThan(0); // the test would be vacuous otherwise
    for (const s of outside) expect(changedClips.has(s.id)).toBe(false);
  }, 240_000);
});

describe("shot pipeline without the media tools", () => {
  it("fails with a readable error instead of crashing", async () => {
    const h = await makeHarness({ profile: small, llm: llm() });
    try {
      const id = await h.newProject({ inputText: "Create a short about a rider.", formatProfile: small.id });
      await h.studio.plan(id);
      await h.studio.approve(id);
      await expect(h.studio.produce(id)).rejects.toThrow();
      const p = await h.store.require(id);
      expect(p.status).toBe("failed");
    } finally {
      await h.close();
    }
  }, 60_000);
});
