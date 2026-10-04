import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Scene } from "@studio/shared";
import { SubtitleRenderError } from "../src/errors";
import { ExecFileRunner, type CommandRunner } from "../src/lib/command";
import { setLogQuiet } from "../src/lib/logger";
import { CoreTextSubtitleRenderer } from "../src/providers/subtitle/CoreTextSubtitleRenderer";
import { buildCues, splitText, srtTime, toSrt } from "../src/render/subtitleCues";

beforeAll(() => setLogQuiet(true));

const scene = (dialogue: Scene["dialogue"]): Scene => ({
  id: "scene-01", order: 1, duration: 8, location: "shop", visualDescription: "a shop at night", dialogue, characters: ["raghu"], props: [],
  camera: { movement: "static", shot: "medium" }, motion: { entrance: "left", emphasis: "none" }, generatedAssets: [], status: "planned",
});

describe("subtitle timing", () => {
  it("builds one cue per dialogue line with the timeline's times and deterministic ids", () => {
    const cues = buildCues(scene([
      { id: "scene-01-d01", characterId: "raghu", text: "Hello there.", startTime: 0.4, endTime: 2.5 },
      { id: "scene-01-d02", characterId: "narrator", text: "Night fell.", startTime: 2.85, endTime: 4.0 },
    ]));
    expect(cues).toEqual([
      { id: "sub-scene-01-d01-1", dialogueId: "scene-01-d01", text: "Hello there.", start: 0.4, end: 2.5 },
      { id: "sub-scene-01-d02-1", dialogueId: "scene-01-d02", text: "Night fell.", start: 2.85, end: 4 },
    ]);
  });

  it("splits long lines at sentence boundaries and shares the time proportionally, without gaps", () => {
    const text = "This is the first sentence of the line. Here comes a second sentence that is longer than the first one. Done!";
    const cues = buildCues(scene([{ id: "scene-01-d01", characterId: "raghu", text, startTime: 1, endTime: 7 }]), 60);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0]!.start).toBe(1);
    expect(cues.at(-1)!.end).toBe(7);
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.start).toBeCloseTo(cues[i - 1]!.end, 2);
    expect(cues.map((c) => c.text).join(" ")).toBe(text);
    expect(cues.map((c) => c.id)).toEqual(cues.map((_, i) => `sub-scene-01-d01-${i + 1}`));
  });

  it("splits on the Devanagari danda", () => {
    expect(splitText("पहला वाक्य यहाँ है। दूसरा वाक्य भी यहाँ है।", 25)).toHaveLength(2);
  });

  it("refuses to build cues before the timeline exists", () => {
    expect(() => buildCues(scene([{ id: "scene-01-d01", characterId: "raghu", text: "Hi" }]))).toThrow(/no timing/);
  });

  it("formats SRT", () => {
    expect(srtTime(3723.456)).toBe("01:02:03,456");
    expect(toSrt([{ text: "A", start: 0.4, end: 2.5 }, { text: "B", start: 3, end: 4 }])).toBe("1\n00:00:00,400 --> 00:00:02,500\nA\n\n2\n00:00:03,000 --> 00:00:04,000\nB\n");
  });
});

describe("CoreTextSubtitleRenderer", () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-sub-")); });
  afterEach(async () => fs.rm(dir, { recursive: true, force: true }));
  const req = (out: string) => ({ text: "कोई हर रात", language: "hi" as const, fontFamily: "Kohinoor Devanagari", fontSizePx: 68, widthPx: 980, strokePercent: 5, outPath: out });

  it("passes text/font/size as literal arguments and parses the helper's output", async () => {
    const helper = path.join(dir, "helper"); await fs.writeFile(helper, "");
    const calls: readonly string[][] = [];
    const runner: CommandRunner = {
      async run(_f, args) { (calls as string[][]).push([...args]); await fs.writeFile(args[4]!, "png"); return { stdout: `${args[4]} 980x237 font=KohinoorDevanagari-Bold\n`, stderr: "", code: 0 }; },
      spawn() { throw new Error("x"); },
    };
    const img = await new CoreTextSubtitleRenderer(runner, helper).render(req(path.join(dir, "out", "s.png")));
    expect(img).toEqual({ path: path.join(dir, "out", "s.png"), width: 980, height: 237 });
    expect(calls[0]).toEqual(["कोई हर रात", "Kohinoor Devanagari", "68", "980", path.join(dir, "out", "s.png"), "5"]);
  });

  it("fails with a readable error when the helper is missing or fails", async () => {
    const runner: CommandRunner = { async run() { return { stdout: "", stderr: "boom", code: 1 }; }, spawn() { throw new Error("x"); } };
    await expect(new CoreTextSubtitleRenderer(runner, path.join(dir, "missing")).render(req(path.join(dir, "a.png")))).rejects.toBeInstanceOf(SubtitleRenderError);
    const helper = path.join(dir, "helper"); await fs.writeFile(helper, "");
    const err = await new CoreTextSubtitleRenderer(runner, helper).render(req(path.join(dir, "a.png"))).catch((e: unknown) => e);
    expect((err as SubtitleRenderError).userMessage).toBe("Subtitle images could not be rendered.");
  });

  it("reports health based on whether the helper is built", async () => {
    const runner: CommandRunner = { async run() { throw new Error("x"); }, spawn() { throw new Error("x"); } };
    expect((await new CoreTextSubtitleRenderer(runner, path.join(dir, "nope")).health()).status).toBe("unavailable");
  });

  // Real CoreText rendering on the target machine (macOS + built helper). Skipped elsewhere.
  const helper = path.resolve(__dirname, "../../../bin/subpng");
  it.skipIf(process.platform !== "darwin" || !existsSync(helper))("really renders Hindi conjuncts to a non-trivial transparent PNG", async () => {
    const r = new CoreTextSubtitleRenderer(new ExecFileRunner([helper]), helper);
    const hindi = await r.render({ ...req(path.join(dir, "hi.png")), text: "प्रश्न विज्ञान कृष्ण क्षत्रिय" });
    const latin = await r.render({ ...req(path.join(dir, "en.png")), text: "Hello world", fontFamily: "Helvetica Neue" });
    expect(hindi.width).toBe(980);
    expect(hindi.height).toBeGreaterThan(80);
    expect((await fs.stat(hindi.path)).size).toBeGreaterThan(5000);
    expect(latin.path).not.toBe(hindi.path);
  });
});
