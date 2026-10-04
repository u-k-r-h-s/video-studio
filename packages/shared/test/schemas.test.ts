import { describe, expect, it } from "vitest";
import {
  CharacterSchema,
  CreateProjectInputSchema,
  DialogueSchema,
  MotionSchema,
  PlanEditSchema,
  PlannedScenesSchema,
  ProjectSchema,
  SceneSchema,
  backgroundAssetId,
  dialogueId,
  propAssetId,
  sceneId,
  slugify,
  validatePlanIntegrity,
} from "../src";

const scene = (over: Record<string, unknown> = {}) => ({
  id: "scene-01",
  order: 1,
  duration: 6,
  location: "village shop",
  visualDescription: "A small shop at night with half-empty shelves.",
  dialogue: [{ id: "scene-01-d01", characterId: "raghu", text: "Something is wrong here." }],
  characters: ["raghu"],
  props: ["wooden mousetrap"],
  camera: { movement: "zoom_in", shot: "medium" },
  motion: { entrance: "left", emphasis: "none" },
  generatedAssets: [],
  status: "planned",
  ...over,
});

describe("SceneSchema", () => {
  it("accepts a valid scene and applies defaults", () => {
    const parsed = SceneSchema.parse(scene({ camera: { movement: "static" }, motion: {} }));
    expect(parsed.camera.shot).toBe("medium");
    expect(parsed.motion).toEqual({ entrance: "left", emphasis: "none" });
  });

  it.each([
    ["bad scene id", { id: "scene_1" }],
    ["duration too long", { duration: 600 }],
    ["duration zero", { duration: 0 }],
    ["unknown camera movement", { camera: { movement: "barrel_roll" } }],
    ["too many dialogue lines", { dialogue: Array.from({ length: 9 }, (_, i) => ({ id: `d${i}`, characterId: "raghu", text: "hi" })) }],
    ["missing visual description", { visualDescription: "" }],
    ["unknown status", { status: "weird" }],
  ])("rejects %s", (_name, over) => {
    expect(SceneSchema.safeParse(scene(over)).success).toBe(false);
  });
});

describe("DialogueSchema", () => {
  it("accepts a valid line and trims text", () => {
    expect(DialogueSchema.parse({ id: "d1", characterId: "raghu", text: "  Hello.  " }).text).toBe("Hello.");
  });
  it.each([
    ["empty text", { id: "d1", characterId: "raghu", text: "   " }],
    ["missing speaker", { id: "d1", text: "Hi" }],
    ["text too long", { id: "d1", characterId: "raghu", text: "x".repeat(301) }],
    ["negative start time", { id: "d1", characterId: "raghu", text: "Hi", startTime: -1 }],
    ["unknown emotion", { id: "d1", characterId: "raghu", text: "Hi", emotion: "melancholic" }],
  ])("rejects %s", (_n, line) => {
    expect(DialogueSchema.safeParse(line).success).toBe(false);
  });
});

describe("CharacterSchema / CreateProjectInputSchema", () => {
  it("validates characters", () => {
    expect(CharacterSchema.safeParse({ id: "raghu", name: "Raghu", description: "A clever detective", appearance: "thin, moustache, brown coat" }).success).toBe(true);
    expect(CharacterSchema.safeParse({ id: "Raghu Ji", name: "R", description: "x", appearance: "y" }).success).toBe(false);
  });
  it("applies project input defaults and rejects too-short input", () => {
    const ok = CreateProjectInputSchema.parse({ inputMode: "idea", inputText: "A detective catches a thief." });
    expect(ok).toMatchObject({ formatProfile: "motion-comic", language: "en", targetDurationSeconds: 20 });
    expect(CreateProjectInputSchema.safeParse({ inputMode: "idea", inputText: "hi" }).success).toBe(false);
    expect(CreateProjectInputSchema.safeParse({ inputMode: "video", inputText: "A detective catches a thief." }).success).toBe(false);
  });
});

describe("MotionSchema", () => {
  const cam = { layer: "camera" as const };
  it("accepts each primitive type", () => {
    const ok = [
      { type: "zoom", target: cam, from: 1, to: 1.2, start: 0, end: 5 },
      { type: "pan", target: cam, from: [0.2, 0.5], to: [0.8, 0.5], start: 0, end: 5, easing: "ease_in_out" },
      { type: "translate", target: { layer: "character", id: "raghu" }, from: [-0.6, 0], to: [0, 0], start: 0, end: 1.4, easing: "ease_out" },
      { type: "scale", target: { layer: "prop", id: "prop-trap" }, from: 0, to: 1, start: 1, end: 1.4, easing: "ease_out_back" },
      { type: "shake", target: { layer: "character", id: "raghu" }, amplitude: 0.01, frequency: 14, start: 2, end: 2.4 },
      { type: "fade", target: { layer: "subtitle", id: "s1" }, from: 0, to: 1, start: 0.4, end: 0.6 },
      { type: "pulse", target: { layer: "character", id: "raghu" }, axis: "scale", amplitude: 0.012, frequency: 1.2, start: 0, end: 6 },
    ];
    for (const m of ok) expect(MotionSchema.safeParse(m).success, JSON.stringify(m)).toBe(true);
  });
  it.each([
    ["end before start", { type: "zoom", target: cam, from: 1, to: 1.2, start: 5, end: 1 }],
    ["zoom below 1", { type: "zoom", target: cam, from: 0.5, to: 1.2, start: 0, end: 1 }],
    ["unknown type", { type: "wobble", target: cam, start: 0, end: 1 }],
    ["shake without amplitude", { type: "shake", target: cam, frequency: 5, start: 0, end: 1 }],
    ["bad easing", { type: "zoom", target: cam, from: 1, to: 2, start: 0, end: 1, easing: "bouncy" }],
  ])("rejects %s", (_n, m) => {
    expect(MotionSchema.safeParse(m).success).toBe(false);
  });
});

describe("planning schemas and integrity", () => {
  it("rejects a malformed planner response", () => {
    expect(PlannedScenesSchema.safeParse({ scenes: "three" }).success).toBe(false);
    expect(PlannedScenesSchema.safeParse({ scenes: [] }).success).toBe(false);
    expect(PlannedScenesSchema.safeParse({}).success).toBe(false);
  });
  it("flags unknown characters and speakers not in the scene", () => {
    const issues = validatePlanIntegrity({
      characters: [{ id: "raghu" }, { id: "mintu" }],
      scenes: [
        { id: "scene-01", characters: ["ghost"], dialogue: [], props: [] },
        { id: "scene-02", characters: ["raghu"], dialogue: [{ id: "d", characterId: "mintu", text: "hi" }], props: [] },
        { id: "scene-03", characters: ["raghu"], dialogue: [{ id: "d", characterId: "narrator", text: "hi" }], props: [] },
      ],
    });
    expect(issues.join(" ")).toContain('unknown character "ghost"');
    expect(issues.join(" ")).toContain('speaker "mintu" must be listed');
    expect(issues).toHaveLength(2);
  });
});

describe("project + ids", () => {
  it("builds deterministic ids", () => {
    expect(sceneId(3)).toBe("scene-03");
    expect(dialogueId("scene-03", 2)).toBe("scene-03-d02");
    expect(backgroundAssetId("Village Shop!")).toBe("bg-village-shop");
    expect(propAssetId("scene-02", "Wooden Mouse-trap")).toBe("prop-scene-02-wooden-mouse-trap");
    expect(slugify("Café Âmbar")).toBe("cafe-ambar");
  });
  it("validates a full project and a plan edit", () => {
    const stages = Object.fromEntries(["scene_planning", "image_generation", "voice_generation", "subtitles", "scene_render", "assembly"].map((s) => [s, { status: "pending" }]));
    const now = new Date().toISOString();
    const project = {
      id: "demo-1", title: "Demo", inputMode: "idea", inputText: "A detective catches a thief.", formatProfile: "motion-comic",
      language: "en", targetDurationSeconds: 20, scenes: [scene()], assets: [], audio: [], status: "review", reviewApproved: false,
      stages, errors: [], createdAt: now, updatedAt: now,
      characters: [{ id: "raghu", name: "Raghu", description: "A detective", appearance: "thin, moustache" }],
    };
    expect(ProjectSchema.safeParse(project).success).toBe(true);
    expect(ProjectSchema.safeParse({ ...project, inputMode: "video" }).success).toBe(false);
    expect(PlanEditSchema.safeParse({ title: "T", characters: project.characters, scenes: project.scenes }).success).toBe(true);
  });
});
