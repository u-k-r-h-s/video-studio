import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MotionSchema, type Motion, type Scene } from "@studio/shared";
import { EncoderUnavailableError, RenderError } from "../src/errors";
import { ExecFileRunner, type CommandRunner } from "../src/lib/command";
import { findExecutable } from "../src/lib/exe";
import { setLogQuiet } from "../src/lib/logger";
import { assessCutout, cropToContent, decodePng, encodePng, keyOutBackground, sampleBorderColor, type Rgba } from "../src/lib/png";
import { encodeWav } from "../src/lib/wav";
import { motionComic } from "../src/profiles/motionComic";
import { FFmpegMotionRenderer } from "../src/render/FFmpegMotionRenderer";
import { buildSceneGraph } from "../src/render/filterGraph";
import { cameraExpressions, fadeFilters, layerExpressions, progress } from "../src/render/motionExpr";
import { planMotion } from "../src/render/motionPlanner";
import type { ScenePlan } from "../src/render/SceneRenderer";
import { buildCues } from "../src/render/subtitleCues";
import { buildTimeline } from "../src/render/timeline";

beforeAll(() => setLogQuiet(true));

/** Evaluate an FFmpeg expression in JS (test-only; the expression grammar we emit is a subset of JS). */
function ev(expr: string, t: number): number {
  const fn = new Function("t", "clip", "between", "gte", "lt", "abs", "sin", "cos", "PI", `return (${expr});`);
  return fn(t, (x: number, a: number, b: number) => Math.min(b, Math.max(a, x)), (x: number, a: number, b: number) => (x >= a && x <= b ? 1 : 0), (a: number, b: number) => (a >= b ? 1 : 0), (a: number, b: number) => (a < b ? 1 : 0), Math.abs, Math.sin, Math.cos, Math.PI) as number;
}
const char = { layer: "character" as const, id: "raghu" };
const m = (x: object): Motion => MotionSchema.parse(x);

describe("motion primitive -> FFmpeg expression", () => {
  it("translate: holds `from` before start, eases to `to`, holds after (ease_out midpoint = 75%)", () => {
    const e = layerExpressions([m({ type: "translate", target: char, from: [-0.6, 0.1], to: [0, 0], start: 1, end: 2, easing: "ease_out" })], "t");
    expect(ev(e.dx, 0)).toBeCloseTo(-0.6, 6);
    expect(ev(e.dx, 1)).toBeCloseTo(-0.6, 6);
    expect(ev(e.dx, 1.5)).toBeCloseTo(-0.6 + 0.6 * 0.75, 6);
    expect(ev(e.dx, 2)).toBeCloseTo(0, 6);
    expect(ev(e.dx, 9)).toBeCloseTo(0, 6);
    expect(ev(e.dy, 0)).toBeCloseTo(0.1, 6);
    expect(ev(e.dy, 9)).toBeCloseTo(0, 6);
  });
  it("all easings start at 0, end at 1 and are monotone-ish where expected", () => {
    for (const easing of ["linear", "ease_in", "ease_out", "ease_in_out", "ease_out_back"] as const) {
      const p = progress("t", 0, 1, easing);
      expect(ev(p, -1)).toBeCloseTo(0, 6);
      expect(ev(p, 0)).toBeCloseTo(0, 6);
      expect(ev(p, 1)).toBeCloseTo(1, 6);
      expect(ev(p, 5)).toBeCloseTo(1, 6);
    }
    expect(ev(progress("t", 0, 1, "ease_in"), 0.5)).toBeCloseTo(0.25, 6);
    expect(ev(progress("t", 0, 1, "ease_in_out"), 0.5)).toBeCloseTo(0.5, 6);
    expect(Math.max(...[0.5, 0.6, 0.7, 0.8, 0.9].map((u) => ev(progress("t", 0, 1, "ease_out_back"), u)))).toBeGreaterThan(1); // overshoot
  });
  it("zero-length motions become a step", () => {
    const p = progress("t", 2, 2, "linear");
    expect(ev(p, 1.99)).toBe(0);
    expect(ev(p, 2)).toBe(1);
  });
  it("scale factors multiply; translates add (independent primitives compose)", () => {
    const e = layerExpressions([
      m({ type: "scale", target: char, from: 1, to: 2, start: 0, end: 1 }),
      m({ type: "scale", target: char, from: 1, to: 3, start: 0, end: 1 }),
      m({ type: "translate", target: char, from: [0, 0], to: [0.1, 0], start: 0, end: 1 }),
      m({ type: "translate", target: char, from: [0, 0], to: [0.2, 0], start: 0, end: 1 }),
    ], "t");
    expect(ev(e.scale, 1)).toBeCloseTo(6, 6);
    expect(ev(e.dx, 1)).toBeCloseTo(0.3, 6);
  });
  it("shake is zero outside its window and bounded inside; pulse stays within amplitude", () => {
    const e = layerExpressions([m({ type: "shake", target: char, amplitude: 0.01, frequency: 15, start: 2, end: 2.5 })], "t");
    expect(Math.abs(ev(e.dx, 1.9))).toBe(0);
    expect(Math.abs(ev(e.dx, 2.6))).toBe(0);
    for (let t = 2; t <= 2.5; t += 0.013) expect(Math.abs(ev(e.dx, t))).toBeLessThanOrEqual(0.0100001);
    const p = layerExpressions([m({ type: "pulse", target: char, axis: "scale", amplitude: 0.02, frequency: 1.2, start: 0, end: 5 })], "t");
    for (let t = 0; t <= 5; t += 0.07) expect(Math.abs(ev(p.scale, t) - 1)).toBeLessThanOrEqual(0.0200001);
    expect(ev(p.scale, 6)).toBe(1);
  });
  it("camera: zoom multiplies, pan composes around the centre, using the zoompan time variable", () => {
    const cam = { layer: "camera" as const };
    const c = cameraExpressions([m({ type: "zoom", target: cam, from: 1, to: 1.2, start: 0, end: 10 }), m({ type: "pan", target: cam, from: [0.2, 0.5], to: [0.8, 0.5], start: 0, end: 10 })], "(on/30)");
    const at = (e: string, sec: number) => new Function("on", "clip", "between", "gte", "cos", "PI", `return (${e});`)(sec * 30, (x: number, a: number, b: number) => Math.min(b, Math.max(a, x)), () => 0, () => 0, Math.cos, Math.PI) as number;
    expect(at(c.zoom, 0)).toBeCloseTo(1, 6);
    expect(at(c.zoom, 10)).toBeCloseTo(1.2, 6);
    expect(at(c.panX, 0)).toBeCloseTo(0.2, 6);
    expect(at(c.panX, 10)).toBeCloseTo(0.8, 6);
    expect(at(c.panY, 5)).toBeCloseTo(0.5, 6);
    expect(c.zoom).toContain("(on/30)");
  });
  it("fade primitives compile to alpha fade filters", () => {
    const f = fadeFilters([m({ type: "fade", target: char, from: 1, to: 0, start: 4, end: 4.5 }), m({ type: "fade", target: char, from: 0, to: 1, start: 1, end: 1.2 })]);
    expect(f).toEqual(["fade=t=in:st=1:d=0.2:alpha=1", "fade=t=out:st=4:d=0.5:alpha=1"]);
  });
});

const baseScene = (over: Partial<Scene> = {}): Scene => ({
  id: "scene-01", order: 1, duration: 8, location: "village shop", visualDescription: "a shop at night",
  dialogue: [{ id: "scene-01-d01", characterId: "raghu", text: "Something is wrong here.", startTime: 0.4, endTime: 2.5 }, { id: "scene-01-d02", characterId: "narrator", text: "Night fell.", startTime: 2.85, endTime: 4 }],
  characters: ["raghu", "mintu"], props: ["wooden mousetrap"], camera: { movement: "zoom_in", shot: "medium" }, motion: { entrance: "left", emphasis: "impact" },
  generatedAssets: [], status: "planned", ...over,
});

describe("timeline + motion planner", () => {
  it("builds the timeline from real audio durations (lead-in, gaps, tail)", () => {
    const tl = buildTimeline(baseScene({ dialogue: baseScene().dialogue.map(({ startTime, endTime, ...d }) => d) }), new Map([["scene-01-d01", 2.1], ["scene-01-d02", 1.15]]), motionComic);
    expect(tl.lines).toEqual([{ dialogueId: "scene-01-d01", start: 0.4, end: 2.5 }, { dialogueId: "scene-01-d02", start: 2.85, end: 4 }]);
    expect(tl.duration).toBe(5); // last end + tail = 4.7 s, raised to the profile minimum (5 s)
  });
  it("uses the planned duration for silent scenes and rejects missing audio", () => {
    expect(buildTimeline(baseScene({ dialogue: [], duration: 5 }), new Map(), motionComic).duration).toBe(5);
    expect(() => buildTimeline(baseScene(), new Map(), motionComic)).toThrow(/no audio duration/);
  });
  it("plans valid primitives for camera, entrances, talking, impact, props and subtitles", () => {
    const scene = baseScene();
    const cues = buildCues(scene);
    const motions = planMotion({ scene, profile: motionComic, duration: 5, propIds: ["prop-wooden-mousetrap"], cues });
    for (const x of motions) expect(MotionSchema.safeParse(x).success, JSON.stringify(x)).toBe(true);
    const has = (type: string, layer: string, id?: string) => motions.some((x) => x.type === type && x.target.layer === layer && (!id || x.target.id === id));
    expect(has("zoom", "camera")).toBe(true);
    expect(has("translate", "character", "raghu")).toBe(true);   // slide-in
    expect(has("pulse", "character", "mintu")).toBe(true);       // idle breathing
    expect(has("shake", "character", "raghu")).toBe(true);       // impact emphasis
    expect(has("scale", "prop", "prop-wooden-mousetrap")).toBe(true); // pop-in
    expect(has("fade", "subtitle", cues[0]!.id)).toBe(true);
    // the first character starts off-screen to the left and ends at its slot
    const slide = motions.find((x) => x.type === "translate" && x.target.id === "raghu")!;
    expect(slide.type === "translate" && slide.from[0]).toBeLessThan(-0.5);
  });
  it("has no entrance primitives for entrance=none, and pans use a constant zoom for slack", () => {
    const motions = planMotion({ scene: baseScene({ motion: { entrance: "none", emphasis: "none" }, camera: { movement: "pan_left", shot: "wide" } }), profile: motionComic, duration: 5, propIds: [], cues: [] });
    expect(motions.some((x) => x.type === "translate" && x.target.layer === "character")).toBe(false);
    const zoom = motions.find((x) => x.type === "zoom");
    expect(zoom && zoom.type === "zoom" && zoom.from).toBeGreaterThanOrEqual(1.15);
    expect(motions.some((x) => x.type === "pan")).toBe(true);
  });
});

describe("filter graph", () => {
  const plan = (): ScenePlan => {
    const scene = baseScene();
    const cues = buildCues(scene);
    return {
      sceneId: "scene-01", duration: 5, video: motionComic.video, background: { path: "/p/bg.png" },
      characters: [{ id: "raghu", path: "/p/raghu.png", width: 400, height: 900, anchorX: 0.3, anchorY: "bottom", y: 1.015, heightFrac: 0.53 }, { id: "mintu", path: "/p/mintu.png", width: 380, height: 880, anchorX: 0.7, anchorY: "bottom", y: 1.015, heightFrac: 0.53 }],
      props: [{ id: "prop-wooden-mousetrap", path: "/p/trap.png", width: 400, height: 400, anchorX: 0.5, anchorY: "bottom", y: 0.93, heightFrac: 0.13 }],
      subtitles: cues.map((c) => ({ id: c.id, path: `/p/${c.id}.png`, width: 980, height: 200, anchorX: 0.5, anchorY: "top" as const, y: 0.7, window: [c.start, c.end] as [number, number] })),
      audioPath: "/p/audio.wav", motions: planMotion({ scene, profile: motionComic, duration: 5, propIds: ["prop-wooden-mousetrap"], cues }),
    };
  };
  it("wires background -> characters -> props -> subtitles, with the audio as the last input", () => {
    const g = buildSceneGraph(plan());
    expect(g.inputArgs.filter((a) => a === "-i")).toHaveLength(1 + 2 + 1 + 2 + 1);
    expect(g.inputArgs.at(-1)).toBe("/p/audio.wav");
    expect(g.audioInputIndex).toBe(6);
    expect(g.filterGraph).toMatch(/^\[0:v\]scale=2160:3840.*zoompan=z='.*':d=150:s=1080x1920:fps=30.*\[bg\];/);
    const overlays = [...g.filterGraph.matchAll(/overlay=/g)];
    expect(overlays).toHaveLength(5); // 2 characters + 1 prop + 2 subtitles
    expect(g.filterGraph.indexOf("[L1]")).toBeLessThan(g.filterGraph.indexOf("[L3]")); // characters before props
    expect(g.filterGraph).toContain("enable='between(t,0.4,2.5)'"); // subtitle window = dialogue timing
    expect(g.filterGraph).toMatch(/enable='between\(t,0\.9,1000000\)'/); // prop hidden until its pop-in
    expect(g.filterGraph).toContain("fade=t=in:st=0.4:d=0.2:alpha=1");
    expect(g.filterGraph.endsWith("format=yuv420p[vout]")).toBe(true);
  });
  it("never contains shell metacharacters or user text (only ids/paths as inputs)", () => {
    const g = buildSceneGraph(plan());
    expect(g.filterGraph).not.toMatch(/[`$|<>]/);
    expect(g.filterGraph).not.toContain("Something is wrong"); // dialogue text lives in subtitle PNGs, not in the graph
  });
});

describe("png toolkit", () => {
  const make = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]): Rgba => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
    return { width: w, height: h, data };
  };
  it("round-trips encode/decode", () => {
    const img = make(7, 5, (x, y) => [x * 30, y * 40, 7, 255 - x]);
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(7); expect(back.height).toBe(5);
    expect(Array.from(back.data)).toEqual(Array.from(img.data));
  });
  it("keys out the connected background, keeps background-coloured parts INSIDE the figure, and crops", () => {
    const bg: [number, number, number, number] = [245, 245, 245, 255];
    // a dark outlined figure on near-white with a WHITE face enclosed by the outline
    const img = make(60, 80, (x, y) => {
      const d = Math.hypot(x - 30, y - 40);
      if (d > 18 && d < 20) return [20, 20, 20, 255];        // outline ring
      return bg;                                              // outer background AND the enclosed white interior
    });
    expect(sampleBorderColor(img)).toEqual([245, 245, 245]);
    const keyed = keyOutBackground(img);
    const a = (x: number, y: number) => keyed.data[(y * 60 + x) * 4 + 3]!;
    expect(a(2, 2)).toBe(0);          // outer background removed
    expect(a(30, 40)).toBe(255);      // enclosed white (a face) preserved: a global colour key would delete it
    expect(a(30, 40 - 19)).toBeGreaterThan(100); // thin outline kept (softened by the edge blur)
    const cropped = cropToContent(keyed, 20, 2);
    expect(cropped.width).toBeLessThan(60); expect(cropped.width).toBeGreaterThanOrEqual(36);
  });
  it("follows a smooth gradient background but does not leak into a differently coloured interior", () => {
    const img = make(80, 100, (x, y) => {
      const inside = x > 25 && x < 55 && y > 20 && y < 90;
      return inside ? [15, 15, 25, 255] : [200 + (y >> 3), 120 + (x >> 3), 110, 255]; // pink gradient vs near-black coat
    });
    const keyed = keyOutBackground(img);
    expect(keyed.data[(5 * 80 + 5) * 4 + 3]).toBe(0);
    expect(keyed.data[(95 * 80 + 70) * 4 + 3]).toBe(0);
    expect(keyed.data[(50 * 80 + 40) * 4 + 3]).toBe(255);
  });
  it("peels a poster/frame around the subject (white margin + black line + brown panel)", () => {
    const W = 100, H = 140;
    const img = make(W, H, (x, y) => {
      const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
      if (edge < 8) return [250, 250, 250, 255];
      if (edge < 11) return [15, 15, 15, 255];
      const inFigure = x > 35 && x < 65 && y > 40 && y < 120;
      return inFigure ? [40, 90, 200, 255] : [100, 70, 50, 255];
    });
    const keyed = keyOutBackground(img);
    const a = (x: number, y: number) => keyed.data[(y * W + x) * 4 + 3]!;
    expect(a(3, 3)).toBe(0);
    expect(a(15, 70)).toBe(0);
    expect(a(50, 80)).toBe(255);
  });
  it("does not treat a real full-height figure as a panel", () => {
    const img = make(60, 100, (x) => (x > 15 && x < 45 ? [30, 120, 60, 255] : [240, 240, 240, 255]));
    expect(keyOutBackground(img).data[(50 * 60 + 30) * 4 + 3]).toBe(255);
  });
  it("assesses cut-outs: accepts a figure, rejects a surviving panel or an empty result", () => {
    const figure = keyOutBackground(make(100, 140, (x, y) => (x > 35 && x < 65 && y > 20 && y < 130 ? [200, 40, 40, 255] : [245, 245, 245, 255])));
    expect(assessCutout(figure, "character").ok).toBe(true);
    expect(assessCutout(make(100, 140, () => [100, 70, 50, 255]), "character")).toMatchObject({ ok: false });
    expect(assessCutout(make(100, 140, () => [0, 0, 0, 0]), "prop").reason).toContain("almost nothing");
  });
  it("rejects unsupported/corrupt PNGs", () => {
    expect(() => decodePng(Buffer.from("nope"))).toThrow(/not a PNG/);
  });
  const real = path.resolve(__dirname, "../../../comfyui/output/char_detective_00001_.png");
  it.skipIf(!existsSync(real))("decodes and keys a REAL ComfyUI output", () => {
    const img = decodePng(readFileSync(real));
    expect([img.width, img.height]).toEqual([512, 896]);
    const keyed = keyOutBackground(img);
    const cut = cropToContent(keyed);
    expect(cut.height).toBeGreaterThan(600); expect(cut.width).toBeLessThan(512);
    const transparent = keyed.data.filter((_, i) => i % 4 === 3 && keyed.data[i] === 0).length;
    expect(transparent / (512 * 896)).toBeGreaterThan(0.3);
  });
});

describe("FFmpegMotionRenderer: encoder selection (mock runner)", () => {
  const runner = (encoders: string): CommandRunner => ({ async run() { return { stdout: encoders, stderr: "", code: 0 }; }, spawn() { throw new Error("x"); } });
  const opts = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", timeoutMs: 1000 };
  it("prefers VideoToolbox and falls back to libx264 when it is missing", async () => {
    const both = " V....D h264_videotoolbox  VT\n V....D libx264  x264\n";
    expect(await new FFmpegMotionRenderer(runner(both), opts).resolveEncoders(motionComic.video)).toEqual(["h264_videotoolbox", "libx264"]);
    expect(await new FFmpegMotionRenderer(runner(" V....D libx264  x264\n"), opts).resolveEncoders(motionComic.video)).toEqual(["libx264"]);
  });
  it("reports 'VideoToolbox encoder is unavailable' when it is forced but missing", async () => {
    const err = await new FFmpegMotionRenderer(runner(" V....D libx264  x\n"), { ...opts, encoderOverride: "h264_videotoolbox" }).resolveEncoders(motionComic.video).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EncoderUnavailableError);
    expect((err as EncoderUnavailableError).userMessage).toBe("FFmpeg VideoToolbox encoder is unavailable.");
  });
  it("fails when no H.264 encoder exists at all", async () => {
    await expect(new FFmpegMotionRenderer(runner(""), opts).resolveEncoders(motionComic.video)).rejects.toBeInstanceOf(EncoderUnavailableError);
  });
});

// ---- Real FFmpeg: renders an actual 1080x1920 scene from synthetic assets and validates the file -------------------
const FFMPEG = findExecutable("ffmpeg");
const FFPROBE = findExecutable("ffprobe");
describe.skipIf(!FFMPEG || !FFPROBE)("FFmpegMotionRenderer: real FFmpeg", () => {
  let dir: string;
  let runner: ExecFileRunner;
  beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-render-")); runner = new ExecFileRunner([FFMPEG!, FFPROBE!]); });
  afterAll(async () => fs.rm(dir, { recursive: true, force: true }));

  async function asset(name: string, img: Rgba): Promise<{ path: string; width: number; height: number }> {
    const p = path.join(dir, name);
    await fs.writeFile(p, encodePng(img));
    return { path: p, width: img.width, height: img.height };
  }
  const solid = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]): Rgba => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
    return { width: w, height: h, data };
  };

  async function makePlan(duration: number): Promise<ScenePlan> {
    const bg = await asset("bg.png", solid(512, 896, (x, y) => [40 + (x >> 2), 80 + (y >> 3), 160, 255]));
    const ch = await asset("ch.png", solid(200, 400, (x, y) => (Math.hypot(x - 100, y - 200) < 95 ? [200, 60, 60, 255] : [0, 0, 0, 0])));
    const pr = await asset("pr.png", solid(120, 120, (x, y) => (Math.hypot(x - 60, y - 60) < 55 ? [250, 220, 20, 255] : [0, 0, 0, 0])));
    const sub = await asset("sub.png", solid(980, 120, (x, y) => (y > 30 && y < 90 && x > 40 && x < 940 ? [255, 255, 255, 255] : [0, 0, 0, 0])));
    const tone = new Int16Array(Math.round(22050 * duration)).map((_, i) => Math.round(6000 * Math.sin((2 * Math.PI * 330 * i) / 22050)));
    const audio = path.join(dir, `a-${duration}.wav`);
    await fs.writeFile(audio, encodeWav({ sampleRate: 22050, samples: tone }));
    const scene = baseScene({ characters: ["raghu"], dialogue: [{ id: "scene-01-d01", characterId: "raghu", text: "Hello", startTime: 0.5, endTime: duration - 0.5 }] });
    const cues = buildCues(scene);
    return {
      sceneId: "scene-01", duration, video: motionComic.video, background: { path: bg.path },
      characters: [{ id: "raghu", ...ch, anchorX: 0.5, anchorY: "bottom", y: 1.015, heightFrac: 0.53 }],
      props: [{ id: "prop-wooden-mousetrap", ...pr, anchorX: 0.5, anchorY: "bottom", y: 0.93, heightFrac: 0.13 }],
      subtitles: cues.map((c) => ({ id: c.id, ...sub, path: sub.path, anchorX: 0.5, anchorY: "top" as const, y: 0.7, window: [c.start, c.end] as [number, number] })),
      audioPath: audio, motions: planMotion({ scene, profile: motionComic, duration, propIds: ["prop-wooden-mousetrap"], cues }),
    };
  }
  const frameHash = async (video: string, t: number): Promise<string> => {
    const out = path.join(dir, `f-${path.basename(video)}-${t}.png`);
    await runner.run(FFMPEG!, ["-v", "error", "-y", "-ss", String(t), "-i", video, "-frames:v", "1", out]);
    return crypto.createHash("sha1").update(await fs.readFile(out)).digest("hex");
  };

  it("renders a valid 1080x1920 30fps H.264+AAC clip with real motion (libx264)", async () => {
    const r = new FFmpegMotionRenderer(runner, { ffmpeg: FFMPEG!, ffprobe: FFPROBE!, timeoutMs: 120_000, encoderOverride: "libx264" });
    const out = await r.renderScene(await makePlan(3), path.join(dir, "scene-x264.mp4"));
    expect(out).toMatchObject({ width: 1080, height: 1920, fps: 30, encoder: "libx264" });
    expect(out.durationSec).toBeGreaterThan(2.8);
    expect(out.durationSec).toBeLessThan(3.2);
    const probe = await r.probe(out.path);
    expect(probe.hasAudio).toBe(true);
    const hashes = new Set(await Promise.all([0.2, 1.0, 1.8, 2.6].map((t) => frameHash(out.path, t))));
    expect(hashes.size).toBe(4); // every sampled frame differs: camera/character/subtitle motion is really happening
    expect(existsSync(`${out.path}.filtergraph.txt`)).toBe(true);
  }, 120_000);

  it.skipIf(process.platform !== "darwin")("renders with h264_videotoolbox when available and assembles clips", async () => {
    const r = new FFmpegMotionRenderer(runner, { ffmpeg: FFMPEG!, ffprobe: FFPROBE!, timeoutMs: 120_000, encoderOverride: "auto" });
    const plan = await makePlan(2);
    const a = await r.renderScene(plan, path.join(dir, "s1.mp4"));
    const b = await r.renderScene({ ...plan, sceneId: "scene-02" }, path.join(dir, "s2.mp4"));
    expect(["h264_videotoolbox", "libx264"]).toContain(a.encoder);
    const final = await r.assemble([a.path, b.path], path.join(dir, "final.mp4"), motionComic.video);
    expect(final.durationSec).toBeGreaterThan(3.8);
    expect(final.durationSec).toBeLessThan(4.4);
    expect([final.width, final.height, final.fps]).toEqual([1080, 1920, 30]);
  }, 180_000);

  it("fails with a readable RenderError (not a stack trace) when an input is missing", async () => {
    const r = new FFmpegMotionRenderer(runner, { ffmpeg: FFMPEG!, ffprobe: FFPROBE!, timeoutMs: 60_000, encoderOverride: "libx264" });
    const plan = await makePlan(2);
    const err = await r.renderScene({ ...plan, background: { path: "/nonexistent/bg.png" } }, path.join(dir, "bad.mp4")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RenderError);
    expect((err as RenderError).userMessage).toBe("FFmpeg could not render the video.");
  }, 60_000);
});
