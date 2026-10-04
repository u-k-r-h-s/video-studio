import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CameraRigSchema, SHOT_TYPES, ShotSchema, StorySchema, type Shot } from "@studio/shared";
import { ExecFileRunner, type CommandRunner } from "../src/lib/command";
import { findExecutable } from "../src/lib/exe";
import { setLogQuiet } from "../src/lib/logger";
import { captionCenterY, chunkLine, renderCaptionStates } from "../src/shots/captions";
import { defaultFocus, intensity, planCamera } from "../src/shots/cameraLanguage";
import { buildShotGraph, renderShot, type ShotRenderSpec } from "../src/shots/shotRenderer";
import { planTimeline } from "../src/shots/timeline";

beforeAll(() => setLogQuiet(true));

const mkShot = (over: Partial<Shot> = {}): Shot => {
  const cam = planCamera({ shotType: "close-up", beat: "setup", emotion: "uneasy", duration: 2, order: 1 });
  return {
    id: "shot-01", sceneId: "scene-1", order: 1, beat: "setup", duration: 2, shotType: "close-up", subjectIds: ["kai"], locationId: "street", emotion: "uneasy",
    action: "Kai looks up", visualPrompt: "rider", visualKey: "k1", camera: cam.camera, motion: cam.motion, transition: { type: "cut" }, characterMotion: [], dialogue: [], sfx: [], ...over,
  };
};

describe("shot schema", () => {
  it("accepts a complete shot and rejects an unknown shot type, a bad id and too many dialogue lines", () => {
    expect(ShotSchema.safeParse(mkShot()).success).toBe(true);
    expect(ShotSchema.safeParse({ ...mkShot(), shotType: "dutch-angle" }).success).toBe(false);
    expect(ShotSchema.safeParse({ ...mkShot(), id: "shot-x" }).success).toBe(false);
    const line = { id: "d", characterId: "kai", text: "hi" };
    expect(ShotSchema.safeParse({ ...mkShot(), dialogue: [line, line, line] }).success).toBe(false);
  });
  it("has every shot type the brief asks for", () => {
    for (const t of ["extreme-close-up", "close-up", "medium-close", "medium", "medium-wide", "wide", "establishing", "over-shoulder", "pov", "low-angle", "high-angle", "tracking", "action"]) expect(SHOT_TYPES).toContain(t);
  });
  it("validates a whole story and rejects camera values outside the rig limits", () => {
    const shots = [mkShot({ id: "shot-01", order: 1 }), mkShot({ id: "shot-02", order: 2 }), mkShot({ id: "shot-03", order: 3 })];
    const story = {
      logline: "A rider finds a strange order.", beats: [{ kind: "hook", summary: "phone buzzes" }, { kind: "payoff", summary: "twist" }],
      locations: [{ id: "street", name: "Street", description: "an alley", visualIdentity: "alley at night", lighting: "lanterns", importantObjects: [] }],
      scenes: [{ id: "scene-1", locationId: "street", beat: "setup", summary: "alley scene", shotIds: shots.map((s) => s.id) }], shots, keyVisuals: [],
    };
    expect(StorySchema.safeParse(story).success).toBe(true);
    expect(CameraRigSchema.safeParse({ ...shots[0]!.camera, startScale: 0.8 }).success).toBe(false);
  });
});

describe("camera language", () => {
  const base = { beat: "conflict" as const, emotion: "neutral" as const, duration: 2, order: 1 };
  it("is deterministic and always produces a valid rig for every shot type, beat and emotion", () => {
    for (const shotType of SHOT_TYPES) for (const beat of ["hook", "setup", "curiosity", "conflict", "escalation", "payoff"] as const) for (const emotion of ["calm", "uneasy", "fear", "shock", "joy"] as const) {
      const a = planCamera({ shotType, beat, emotion, duration: 2, order: 3 }), b = planCamera({ shotType, beat, emotion, duration: 2, order: 3 });
      expect(a).toEqual(b);
      expect(CameraRigSchema.safeParse(a.camera).success).toBe(true);
      expect(a.motion.shake ?? 0).toBeLessThanOrEqual(0.02);
    }
  });
  it("tense/shocked moments move harder than calm ones", () => {
    expect(intensity("shock", "escalation")).toBeGreaterThan(intensity("calm", "setup"));
    const calm = planCamera({ ...base, shotType: "close-up", emotion: "calm", beat: "setup" }), shock = planCamera({ ...base, shotType: "close-up", emotion: "shock", beat: "escalation", action: "he lunges" });
    const travel = (p: typeof calm): number => p.camera.endScale - p.camera.startScale;
    expect(travel(shock)).toBeGreaterThan(travel(calm));
    expect(shock.motion.shake ?? 0).toBeGreaterThan(calm.motion.shake ?? 0);
  });
  it("derives the motion from the framing: close shots push in, wide shots pull out, tracking shots track", () => {
    expect(planCamera({ ...base, shotType: "close-up" }).motion.type).toBe("push-in");
    expect(planCamera({ ...base, shotType: "wide" }).motion.type).toBe("pull-out");
    expect(planCamera({ ...base, shotType: "tracking" }).motion.type).toBe("tracking");
    const push = planCamera({ ...base, shotType: "close-up" }).camera, pull = planCamera({ ...base, shotType: "wide" }).camera;
    expect(push.endScale).toBeGreaterThan(push.startScale);
    expect(pull.endScale).toBeLessThan(pull.startScale);
  });
  it("alternates pan direction between consecutive shots and a reveal starts at the frame edge", () => {
    const a = planCamera({ ...base, shotType: "establishing", order: 1 }).camera, b = planCamera({ ...base, shotType: "establishing", order: 2 }).camera;
    expect(Math.sign(a.endX - a.startX)).toBe(-Math.sign(b.endX - b.startX));
    const reveal = planCamera({ ...base, shotType: "medium-wide", order: 2, action: "the door reveals a figure" }).camera;
    expect(Math.min(reveal.startX, reveal.endX)).toBeLessThan(0.1);
  });
  it("honours an explicit motion from the director and gives every framing a focus region inside the frame", () => {
    expect(planCamera({ ...base, shotType: "close-up", motion: "static" }).camera.endScale).toBe(planCamera({ ...base, shotType: "close-up", motion: "static" }).camera.startScale);
    for (const t of SHOT_TYPES) { const f = defaultFocus(t); expect(f.x).toBeGreaterThan(0); expect(f.x).toBeLessThan(1); expect(f.rx).toBeGreaterThan(0.1); }
  });
});

describe("timeline", () => {
  const line = (id: string, text = "hello there") => ({ id, characterId: "kai", text });
  it("extends a shot to fit its spoken lines and lays shots end to end", () => {
    const shots = [mkShot({ id: "shot-01", order: 1, duration: 1, dialogue: [line("d1")] }), mkShot({ id: "shot-02", order: 2, duration: 3 })];
    const tl = planTimeline(shots, { d1: 2.5 });
    expect(tl.shots[0]!.duration).toBeCloseTo(0.3 + 2.5 + 0.35, 6);
    expect(tl.shots[1]!.start).toBeCloseTo(tl.shots[0]!.end, 6);
    expect(tl.shots[1]!.duration).toBe(3); // no speech: planned duration is kept
    expect(tl.totalSec).toBeCloseTo(tl.shots[1]!.end, 6);
  });
  it("places two lines in one shot without overlap and inside the shot; the hook speaks sooner", () => {
    const tl = planTimeline([mkShot({ beat: "hook", dialogue: [line("d1"), line("d2")] })], { d1: 1, d2: 1.2 });
    const [a, b] = tl.shots[0]!.lines;
    expect(a!.localStart).toBeCloseTo(0.15, 6);
    expect(b!.localStart).toBeGreaterThanOrEqual(a!.localEnd);
    expect(b!.localEnd).toBeLessThanOrEqual(tl.shots[0]!.duration);
    const normal = planTimeline([mkShot({ beat: "setup", dialogue: [line("d1")] })], { d1: 1 });
    expect(normal.shots[0]!.lines[0]!.localStart).toBeGreaterThan(a!.localStart);
  });
  it("refuses to plan a line whose audio is missing", () => {
    expect(() => planTimeline([mkShot({ dialogue: [line("dx")] })], {})).toThrow(/no audio duration/);
  });
});

describe("captions", () => {
  it("chunks a line into short phrases whose word times are monotonic and stay inside the line", () => {
    const chunks = chunkLine("The last order of the night. The name on it was mine.", 1, 4);
    expect(chunks.length).toBeGreaterThan(3);
    let prev = 1;
    for (const c of chunks) {
      expect(c.words.length).toBeLessThanOrEqual(3);
      expect(c.words.join(" ").length).toBeLessThanOrEqual(24);
      c.wordStart.forEach((s, i) => { expect(s).toBeGreaterThanOrEqual(prev - 1e-9); expect(c.wordEnd[i]!).toBeGreaterThanOrEqual(s); prev = s; });
    }
    expect(chunks[0]!.start).toBeCloseTo(1, 6);
    expect(chunks[chunks.length - 1]!.end).toBeLessThanOrEqual(4 + 1e-9);
  });
  it("breaks at sentence punctuation and flags emphasised words", () => {
    const chunks = chunkLine("Wait. It was mine!", 0, 2, ["mine"]);
    expect(chunks.map((c) => c.words.join(" "))).toEqual(["Wait.", "It was mine!"]);
    expect(chunks[1]!.emphasised).toEqual([false, false, true]);
  });
  it("gives longer words more time", () => {
    const [c] = chunkLine("a extraordinary", 0, 3);
    expect(c!.wordEnd[1]! - c!.wordStart[1]!).toBeGreaterThan(c!.wordEnd[0]! - c!.wordStart[0]!);
  });
  it("returns nothing for empty text or an empty time range", () => {
    expect(chunkLine("  ", 0, 1)).toEqual([]);
    expect(chunkLine("hello", 1, 1)).toEqual([]);
  });
  it("puts captions low normally and at the top when the subject is low in the frame", () => {
    expect(captionCenterY({ y: 0.45 })).toBeGreaterThan(0.6);
    expect(captionCenterY({ y: 0.78 })).toBeLessThan(0.3);
  });
  it("renders one state per word and never lets two states overlap in time", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caps-"));
    const calls: string[][] = [];
    const fake = { run: async (_exe: string, args: string[]) => {
      calls.push(args);
      const png = Buffer.alloc(24); png.writeUInt32BE(900, 16); png.writeUInt32BE(120, 20);
      await fs.writeFile(args[4]!, png);
      return { code: 0, stdout: "x 900x120", stderr: "" };
    } } as unknown as CommandRunner;
    const chunks = [...chunkLine("You always", 0.3, 1.2), ...chunkLine("come back.", 1.0, 2.0)]; // deliberately overlapping chunks
    const states = await renderCaptionStates(fake, "helper", chunks, dir);
    expect(states).toHaveLength(4);
    for (let i = 0; i + 1 < states.length; i++) expect(states[i]!.end).toBeLessThanOrEqual(states[i + 1]!.start + 1e-9);
    expect(calls.map((a) => a[7])).toEqual(["0", "1", "0", "1"]); // highlighted word index per state
    expect(calls[0]![0]).toBe("YOU ALWAYS");
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("shot render graph", () => {
  const spec = (shot: Shot, over: Partial<ShotRenderSpec> = {}): ShotRenderSpec => ({ shot, imagePath: "/x/k.png", duration: 2, width: 1080, height: 1920, fps: 30, transitionIn: "cut", isFirst: false, isLast: false, captions: [], captionCenterY: 0.7, ...over });
  it("builds a far + mid layered 2.5D graph with the grade stack and never emits comparison operators FFmpeg lacks", () => {
    const g = buildShotGraph(spec(mkShot({ motion: { type: "push-in" }, characterMotion: [{ action: "surprise", at: 0.1 }, { action: "nod", at: 0.5 }, { action: "fear" }], effects: { flash: true, impact: true } }), { flashAt: [0.4] }));
    expect((g.filter.match(/zoompan=/g) ?? []).length).toBe(3); // far, mask, mid
    for (const part of ["gblur", "alphamerge", "vignette", "noise=", "unsharp", "colorbalance", "blend=all_mode=screen"]) expect(g.filter).toContain(part);
    expect(g.filter).not.toMatch(/>=|<=|==/);
    expect(g.filter).toContain("eq=brightness="); // flash
    expect(g.filter).toContain("rotate="); // impact shake
    expect(g.outLabel).toBe("vout");
  });
  it("only rolls/shakes when the camera asks for it, and fades for fade transitions and the last shot", () => {
    const calm = buildShotGraph(spec(mkShot({ camera: { startScale: 1.05, endScale: 1.1, startX: 0.5, endX: 0.5, startY: 0.5, endY: 0.5 }, motion: { type: "push-in" }, characterMotion: [] })));
    expect(calm.filter).not.toContain("rotate=");
    expect(calm.filter).not.toContain("fade=");
    const faded = buildShotGraph(spec(mkShot({ transition: { type: "fade" } }), { transitionIn: "fade" }));
    expect(faded.filter).toContain("fade=t=in");
    expect(faded.filter).toContain("fade=t=out");
    const last = buildShotGraph(spec(mkShot(), { isLast: true }));
    expect(last.filter).toMatch(/fade=t=out:st=1\.3:d=0\.7/);
  });
  it("zoom transitions punch the camera on the way out and in; shake adds a roll/shake stage", () => {
    const out = buildShotGraph(spec(mkShot({ transition: { type: "zoom" } })));
    expect(out.filter).toMatch(/pow\(max\(0,\(on-/);
    const into = buildShotGraph(spec(mkShot(), { transitionIn: "zoom" }));
    expect(into.filter).toMatch(/pow\(max\(0,1-on\//);
    const sh = buildShotGraph(spec(mkShot({ motion: { type: "shake", shake: 0.01 } })));
    expect(sh.filter).toContain("rotate=");
  });
  it("adds one overlay input per caption/insert, gated by time", () => {
    const cap = { png: "/c.png", start: 0.5, end: 1.2, width: 900, height: 120 };
    const g = buildShotGraph(spec(mkShot(), { captions: [cap, { ...cap, start: 1.2, end: 1.8 }], insert: { ...cap, centerY: 0.4 } }));
    expect(g.inputArgs.filter((a) => a === "-i")).toHaveLength(4);
    expect(g.filter.match(/overlay=x=/g)).toHaveLength(3);
    expect(g.filter).toContain("enable='between(t,0.5,1.2)'");
  });
  it("keeps the camera-driven subject mask centred on the shot focus", () => {
    const g = buildShotGraph(spec(mkShot({ focus: { x: 0.3, y: 0.6, rx: 0.2, ry: 0.25 } })));
    expect(g.filter).toContain("X/W-0.3");
    expect(g.filter).toContain("Y/H-0.6");
  });
});

const FFMPEG = findExecutable("ffmpeg"), FFPROBE = findExecutable("ffprobe");
describe.skipIf(!FFMPEG || !FFPROBE)("shot renderer with the REAL FFmpeg", () => {
  let dir = "";
  beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "shot-")); });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  it("renders a layered shot with rotation, flash and an overlay to the exact size, rate and duration", async () => {
    const runner = new ExecFileRunner([FFMPEG!, FFPROBE!]);
    const img = path.join(dir, "k.png"), cap = path.join(dir, "c.png");
    await runner.run(FFMPEG!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=256x448", "-frames:v", "1", img], { timeoutMs: 30_000 });
    await runner.run(FFMPEG!, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=200x50", "-frames:v", "1", cap], { timeoutMs: 30_000 });
    const shot = mkShot({ duration: 1, camera: { startScale: 1.05, endScale: 1.2, startX: 0.3, endX: 0.7, startY: 0.5, endY: 0.5, rotation: 2, endRotation: 0 }, motion: { type: "pan", shake: 0.004 }, characterMotion: [{ action: "surprise", at: 0.2 }] });
    const out = path.join(dir, "shot.mp4");
    await renderShot(runner, { shot, imagePath: img, duration: 1, width: 270, height: 480, fps: 30, transitionIn: "cut", isFirst: false, isLast: false, flashAt: [0.3], captions: [{ png: cap, start: 0.2, end: 0.8, width: 200, height: 50 }], captionCenterY: 0.7, working: 2 }, out, { ffmpeg: FFMPEG!, ffprobe: FFPROBE!, encoder: "libx264", bitrateKbps: 2000, timeoutMs: 120_000 });
    expect(existsSync(out)).toBe(true);
    const p = await runner.run(FFPROBE!, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,nb_frames:format=duration", "-of", "json", out], { timeoutMs: 30_000 });
    const j = JSON.parse(p.stdout) as { streams: { width: number; height: number; r_frame_rate: string; nb_frames: string }[]; format: { duration: string } };
    expect(j.streams[0]).toMatchObject({ width: 270, height: 480, r_frame_rate: "30/1" });
    expect(Number(j.streams[0]!.nb_frames)).toBe(30);
    expect(Number(j.format.duration)).toBeCloseTo(1, 1);
  }, 120_000);
});
