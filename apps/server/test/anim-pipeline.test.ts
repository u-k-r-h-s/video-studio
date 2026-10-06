import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shotVideoAssetId, type FormatProfile } from "@studio/shared";
import { ExecFileRunner } from "../src/lib/command";
import { findExecutable } from "../src/lib/exe";
import { setLogQuiet } from "../src/lib/logger";
import { animatedShort } from "../src/profiles/animatedShort";
import { FFmpegMotionRenderer } from "../src/render/FFmpegMotionRenderer";
import { animTimelineOf } from "../src/pipeline/stages/animated/common";
import { assembleAnimShots } from "../src/pipeline/stages/animated/assembleAnimShots";
import { upsertAsset } from "../src/pipeline/assets";
import { FakeLLM } from "./helpers";
import { makeHarness, type Harness } from "./harness";
import { directorResponder } from "./fixtures-director";

beforeAll(() => setLogQuiet(true));
const FFMPEG = findExecutable("ffmpeg"), FFPROBE = findExecutable("ffprobe");
const HELPER = path.resolve(__dirname, "../../../bin/subpng");
const ready = !!FFMPEG && !!FFPROBE && existsSync(HELPER) && process.platform === "darwin";

/** The real animated profile at a low frame rate (the stage is always 1080x1920) and software H.264, so the test is fast and deterministic. */
const lowFps: FormatProfile = { ...animatedShort, video: { ...animatedShort.video, fps: 8, videoEncoder: "libx264" } };

describe.skipIf(!ready)("animated pipeline end to end (fake Ollama/ComfyUI/Piper, REAL animation renderer + FFmpeg)", () => {
  let h: Harness;
  let id = "";
  beforeAll(async () => {
    const runner = new ExecFileRunner([FFMPEG!, FFPROBE!, HELPER]);
    const renderer = new FFmpegMotionRenderer(runner, { ffmpeg: FFMPEG!, ffprobe: FFPROBE!, timeoutMs: 120_000, encoderOverride: "libx264" });
    h = await makeHarness({ profile: lowFps, llm: new FakeLLM((req) => directorResponder(req)), media: { runner, ffmpeg: FFMPEG!, ffprobe: FFPROBE!, captionHelper: HELPER, renderer } });
    id = await h.newProject({ inputText: "Create a 25 second animated mystery short about a delivery rider.", formatProfile: lowFps.id, targetDurationSeconds: 25 });
  }, 60_000);
  afterAll(async () => { await h.close(); });

  it("Director -> asset planning: the shots carry semantic actions and the manifest lists exactly what they need", async () => {
    await h.studio.plan(id);
    const p = await h.store.require(id);
    expect(p.status).toBe("review");
    const acts = p.story!.shots.flatMap((s) => s.animation?.actions ?? []);
    expect(acts.some((a) => a.action === "walk" && a.toward === "the building")).toBe(true);
    expect(p.story!.shots.some((s) => s.animation?.objects.some((o) => o.object === "door" && o.action === "open"))).toBe(true);
    const manifest = JSON.parse(await fs.readFile(h.svc.store.resolve(id, "manifest.json"), "utf8"));
    const ids: string[] = manifest.assets.map((a: { id: string }) => a.id);
    expect(ids.filter((x) => x.startsWith("loc-"))).toHaveLength(2);
    expect(ids).toContain("char-kai-puppet"); // one body picture, cut into a puppet
    expect(ids.some((x) => x.includes("flashlight"))).toBe(false); // the torch is drawn, not generated
    expect(ids.some((x) => x.startsWith("prop-"))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length); // nothing is generated twice
  });

  it("produces a valid 1080x1920 video with every clip drawn by the animation renderer (never the still-image renderer)", async () => {
    await h.studio.approve(id);
    h.events.length = 0;
    await h.studio.produce(id);
    const p = await h.store.require(id);
    expect(p.status).toBe("completed");
    const ev = h.events;
    expect(ev.filter((e) => e === "comfy:start")).toHaveLength(1);
    expect(ev.filter((e) => e === "comfy:matte").length).toBeGreaterThan(0); // cut-outs come from the matting model
    expect(ev.findIndex((e) => e.startsWith("piper:"))).toBeGreaterThan(ev.indexOf("comfy:stop"));

    const clips = p.assets.filter((a) => a.kind === "shot_video");
    expect(clips).toHaveLength(p.story!.shots.length);
    for (const c of clips) {
      expect(c.meta.renderer).toBe("anim");
      expect(c.meta.frames as number).toBeGreaterThan(8);
      expect(existsSync(h.svc.store.resolve(id, `shots/${c.meta.shotId}.compiled.json`))).toBe(true);
    }
    // picture and sound stay in step: every clip is as long as its slot in the timeline (a clip that is even 0.1 s too long drifts all later shots off the audio)
    const tl = animTimelineOf(p, p.story!);
    for (const [i, shot] of p.story!.shots.entries()) {
      const c = clips.find((x) => x.meta.shotId === shot.id)!;
      expect(Math.abs((c.meta.durationSec as number) - tl.shots[i]!.duration)).toBeLessThan(1 / lowFps.video.fps + 0.02);
    }
    expect(p.assets.some((a) => a.kind === "key_visual")).toBe(false);
    // the torch the director asked for is carried in the hand (parented to the character) and raised
    const torchShot = p.story!.shots.find((s) => s.animation?.objects.some((o) => o.object === "flashlight"))!;
    const compiled = JSON.parse(await fs.readFile(h.svc.store.resolve(id, `shots/${torchShot.id}.compiled.json`), "utf8"));
    expect(compiled.spec.layers.find((l: { id: string }) => l.id === "obj-flashlight")?.parent?.layerId).toBe("kai");
    expect(compiled.spec.events.some((e: { type: string }) => e.type === "raise-object")).toBe(true); // no still key images in this pipeline
    const fin = p.assets.find((a) => a.kind === "final_video")!;
    expect(fin.meta.width).toBe(1080);
    expect(fin.meta.height).toBe(1920);
    expect(fin.meta.durationSec as number).toBeGreaterThan(10);
  }, 240_000);

  it("a second run reuses every asset and clip: zero generation requests", async () => {
    h.events.length = 0;
    await h.studio.produce(id);
    expect(h.events.filter((e) => e === "comfy:prompt" || e === "comfy:matte")).toHaveLength(0);
    expect(h.events.some((e) => e.startsWith("render:"))).toBe(false);
  }, 120_000);

  it("assembly FAILS if a clip did not come from the animation renderer", async () => {
    await h.store.update(id, (p) => {
      const shot = p.story!.shots[0]!;
      const a = p.assets.find((x) => x.id === shotVideoAssetId(shot.id))!;
      upsertAsset(p, { ...a, meta: { ...a.meta, renderer: undefined } });
    });
    await expect(h.runner.runStage(id, "assembly", assembleAnimShots, { force: true })).rejects.toThrow(/animation renderer/);
  });
});

import { animatedShort3d } from "../src/profiles/animatedShort3d";
import { DEFAULT_CHROME, Three3DRenderer } from "../src/anim/renderers/three3d";
import { characterFile as glbFile } from "../src/anim/renderers/three3d/library";
import { existsSync as exists3d } from "node:fs";

const small3d: FormatProfile = { ...animatedShort3d, video: { ...animatedShort3d.video, width: 216, height: 384, fps: 10, videoEncoder: "libx264" } };
const ready3d = ready && Three3DRenderer.available(process.env.CHROME_PATH ?? DEFAULT_CHROME) && exists3d(glbFile("casual-man"));
describe.skipIf(!ready3d)("animated pipeline with the 3D renderer (--renderer=3d): same Director/timeline/assembly, Three.js shots", () => {
  let h: Harness;
  let id = "";
  beforeAll(async () => {
    const runner = new ExecFileRunner([FFMPEG!, FFPROBE!, HELPER]);
    const renderer = new FFmpegMotionRenderer(runner, { ffmpeg: FFMPEG!, ffprobe: FFPROBE!, timeoutMs: 120_000, encoderOverride: "libx264" });
    h = await makeHarness({ profile: small3d, llm: new FakeLLM((req) => directorResponder(req)), media: { runner, ffmpeg: FFMPEG!, ffprobe: FFPROBE!, captionHelper: HELPER, renderer } });
    id = await h.newProject({ inputText: "Create a 25 second animated mystery short about a delivery rider.", formatProfile: small3d.id, targetDurationSeconds: 25 });
  }, 60_000);
  afterAll(async () => { await h.close(); });
  it("renders every shot with Three.js, generates only location plates (characters come from the 3D library), and assembles a video", async () => {
    await h.studio.plan(id);
    await h.studio.approve(id);
    h.events.length = 0;
    await h.studio.produce(id);
    const p = await h.store.require(id);
    expect(p.status).toBe("completed");
    expect(p.assets.filter((a) => a.kind === "anim_view" || a.kind === "anim_head")).toHaveLength(0);
    expect(p.assets.filter((a) => a.kind === "anim_location").length).toBeGreaterThan(0);
    const clips = p.assets.filter((a) => a.kind === "shot_video");
    expect(clips).toHaveLength(p.story!.shots.length);
    expect(clips.every((c) => c.meta.engine === "three3d" && c.meta.renderer === "anim")).toBe(true);
    const fin = p.assets.find((a) => a.kind === "final_video")!;
    expect([fin.meta.width, fin.meta.height]).toEqual([216, 384]);
    // footsteps simulated headless for the soundtrack, from the same character code the browser runs
    const mix = p.assets.find((a) => a.id === "soundtrack-mix")!;
    expect(mix.status).toBe("ready");
  }, 400_000);
});
