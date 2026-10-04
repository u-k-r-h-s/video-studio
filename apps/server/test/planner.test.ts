import { beforeAll, describe, expect, it } from "vitest";
import { SceneSchema, type FormatProfile } from "@studio/shared";
import { LlmValidationError } from "../src/errors";
import { setLogQuiet } from "../src/lib/logger";
import { parseModelJson } from "../src/llm/structured";
import { normalizeScenes, prettifyTitle } from "../src/planner/normalize";
import { ScenePlanner } from "../src/planner/ScenePlanner";
import { motionComic } from "../src/profiles/motionComic";
import { FakeLLM } from "./helpers";

beforeAll(() => setLogQuiet(true));

const profile: FormatProfile = motionComic;
const opts = { maxRepairs: 2, temperature: 0.5 };
const outline = {
  title: "The Night Thief",
  characters: [
    { id: "Inspector Raghu", name: "Inspector Raghu", description: "A clever village detective", appearance: "thin old man, white moustache, brown coat" },
    { id: "mintu", name: "Mintu", description: "A hungry monkey", appearance: "small brown monkey, red vest" },
  ],
};
const sc = (over: Record<string, unknown> = {}) => ({
  location: "Village Shop",
  visualDescription: "Raghu inspects the empty shelves of the shop.",
  characters: ["inspector-raghu"],
  props: ["wooden mousetrap"],
  dialogue: [{ characterId: "inspector-raghu", text: "Someone is stealing our food.", emotion: "suspicious" }],
  camera: { movement: "zoom_in", shot: "medium" },
  motion: { entrance: "left", emphasis: "none" },
  duration: 6,
  ...over,
});
const threeScenes = { scenes: [sc(), sc({ characters: ["inspector-raghu", "mintu"], dialogue: [] }), sc({ motion: { entrance: "right", emphasis: "impact" } })] };
const idea = { mode: "idea" as const, text: "A clever detective catches a thief.", language: "en" as const, targetDurationSeconds: 20 };

/** Answers by prompt so retries and order do not matter. */
const llmFor = (scenes: unknown, outlineResp: unknown = outline) =>
  new FakeLLM((req) => (req.messages.some((m) => m.content.includes("title and cast")) ? (outlineResp as object) : (scenes as object)));

describe("ScenePlanner: idea mode", () => {
  it("returns a validated plan with deterministic ids and normalized characters", async () => {
    const plan = await new ScenePlanner(llmFor(threeScenes), opts).plan(idea, profile);
    expect(plan.title).toBe("The Night Thief");
    expect(plan.characters.map((c) => c.id)).toEqual(["inspector-raghu", "mintu"]);
    expect(plan.scenes.map((s) => s.id)).toEqual(["scene-01", "scene-02", "scene-03"]);
    for (const s of plan.scenes) expect(SceneSchema.safeParse(s).success).toBe(true);
    expect(plan.scenes[0]!.dialogue[0]).toMatchObject({ id: "scene-01-d01", characterId: "inspector-raghu" });
    expect(plan.scenes.every((s) => s.status === "planned" && s.generatedAssets.length === 0)).toBe(true);
    // the same location in all scenes shares one canonical name -> one shared background later
    expect(new Set(plan.scenes.map((s) => s.location)).size).toBe(1);
  });

  it("sizes scenes to fit their spoken lines", async () => {
    const long = sc({ dialogue: [{ characterId: "inspector-raghu", text: Array(30).fill("word").join(" ") }] });
    const plan = await new ScenePlanner(llmFor({ scenes: [long, sc(), sc()] }), opts).plan(idea, profile);
    expect(plan.scenes[0]!.duration).toBeGreaterThan(10); // 30 words / 2.6 wps + lead-in + tail
    expect(plan.scenes[0]!.duration).toBeLessThanOrEqual(profile.timing.maxSceneSeconds);
  });

  it("repairs a response that breaks the rules (too many locations) via a repair round", async () => {
    const bad = { scenes: [sc({ location: "Shop" }), sc({ location: "Park" }), sc({ location: "Beach" })] };
    const llm = new FakeLLM((req) => {
      if (req.messages.some((m) => m.content.includes("title and cast"))) return outline;
      return req.messages.some((m) => m.content.includes("Too many different locations")) ? threeScenes : bad;
    });
    const repairs: number[] = [];
    const plan = await new ScenePlanner(llm, opts).plan(idea, profile, { onRepair: (n) => repairs.push(n) });
    expect(plan.scenes).toHaveLength(3);
    expect(repairs).toEqual([1]);
  });

  it("flags unknown characters and fails with LlmValidationError once repairs are exhausted", async () => {
    const bad = { scenes: [sc({ characters: ["ghost"] }), sc(), sc()] };
    const err = await new ScenePlanner(llmFor(bad), { ...opts, maxRepairs: 1 }).plan(idea, profile).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmValidationError);
    expect((err as LlmValidationError).issues.join(" ")).toContain('unknown character "ghost"');
  });

  it("enforces the character limit from the format profile", async () => {
    const many = { ...outline, characters: ["a-one", "b-two", "c-three", "d-four"].map((id) => ({ id, name: id, description: "role here", appearance: "looks here" })) };
    const err = await new ScenePlanner(llmFor(threeScenes, many), { ...opts, maxRepairs: 0 }).plan(idea, profile).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmValidationError);
    expect((err as LlmValidationError).issues.join(" ")).toContain("Too many characters");
  });
});

describe("ScenePlanner: malformed LLM responses", () => {
  it("accepts JSON wrapped in markdown fences and with a trailing comma (safe deterministic repair)", () => {
    const r = parseModelJson('Here you go:\n```json\n{"a": [1, 2,], "b": "x",}\n```');
    expect(r).toMatchObject({ ok: true, repaired: true, value: { a: [1, 2], b: "x" } });
  });
  it("reports unparseable output instead of guessing", () => {
    expect(parseModelJson("totally not json").ok).toBe(false);
    expect(parseModelJson('{"a": ').ok).toBe(false);
  });
  it("asks the model to repair non-JSON and recovers", async () => {
    const llm = new FakeLLM(["I cannot do that", outline, threeScenes]);
    const plan = await new ScenePlanner(llm, opts).plan(idea, profile);
    expect(plan.scenes).toHaveLength(3);
    expect(llm.requests[1]!.messages.at(-1)!.content).toContain("not valid JSON");
  });
  it("never accepts output that does not match the schema", async () => {
    const llm = new FakeLLM([outline, { scenes: "three scenes please" }]);
    const err = await new ScenePlanner(llm, { ...opts, maxRepairs: 1 }).plan(idea, profile).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmValidationError);
  });
});

describe("ScenePlanner: script mode preserves dialogue", () => {
  const script = `Inspector Raghu: Someone is stealing our food.\nMintu: I was only a little hungry!\nNarrator: And so the mystery ended.`;
  const input = { mode: "script" as const, text: script, language: "en" as const, targetDurationSeconds: 20 };
  const faithful = {
    scenes: [
      sc({ dialogue: [{ characterId: "inspector-raghu", text: "Someone is stealing our food." }] }),
      sc({ characters: ["mintu"], dialogue: [{ characterId: "mintu", text: "I was only a little hungry!" }] }),
      sc({ characters: [], dialogue: [{ characterId: "narrator", text: "And so the mystery ended." }] }),
    ],
  };

  it("keeps verbatim dialogue untouched", async () => {
    const plan = await new ScenePlanner(llmFor(faithful), opts).plan(input, profile);
    expect(plan.scenes.flatMap((s) => s.dialogue.map((d) => d.text))).toEqual(["Someone is stealing our food.", "I was only a little hungry!", "And so the mystery ended."]);
  });

  it("rejects rewritten dialogue and asks the model to copy it exactly", async () => {
    const rewritten = { scenes: [sc({ dialogue: [{ characterId: "inspector-raghu", text: "Thieves are taking all of the food!" }] }), sc(), sc()] };
    const llm = new FakeLLM((req) => {
      if (req.messages.some((m) => m.content.includes("title and cast"))) return outline;
      return req.messages.some((m) => m.content.includes("verbatim from the script. These lines")) ? faithful : rewritten;
    });
    const plan = await new ScenePlanner(llm, opts).plan(input, profile);
    expect(plan.scenes[0]!.dialogue[0]!.text).toBe("Someone is stealing our food.");
    expect(llm.requests.some((r) => r.messages.at(-1)!.content.includes("Thieves are taking all"))).toBe(true);
  });

  it("fails if the model keeps rewriting", async () => {
    const rewritten = { scenes: [sc({ dialogue: [{ characterId: "inspector-raghu", text: "Invented line." }] }), sc(), sc()] };
    const err = await new ScenePlanner(llmFor(rewritten), { ...opts, maxRepairs: 1 }).plan(input, profile).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmValidationError);
  });

  it("allows rewriting only when explicitly requested", async () => {
    const rewritten = { scenes: [sc({ dialogue: [{ characterId: "inspector-raghu", text: "Invented line." }] }), sc(), sc()] };
    const plan = await new ScenePlanner(llmFor(rewritten), opts).plan({ ...input, allowRewrite: true }, profile);
    expect(plan.scenes[0]!.dialogue[0]!.text).toBe("Invented line.");
  });
});

describe("normalizeScenes", () => {
  const cast = [{ id: "raghu", name: "Inspector Raghu" }, { id: "mintu", name: "Mintu" }];
  it("maps enum synonyms, drops unknown emotions and adds speakers / mentioned characters to the scene", () => {
    const out = normalizeScenes({ scenes: [{ visualDescription: "Mintu grabs a banana.", characters: [], camera: { movement: "slow zoom in" }, motion: { entrance: "Top", emphasis: "BIG" },
      dialogue: [{ character: "Raghu", text: " hi ", emotion: "melancholic" }] }] }, cast) as { scenes: any[] };
    const s = out.scenes[0];
    expect(s.camera.movement).toBe("zoom_in");
    expect(s.motion).toEqual({ entrance: "left", emphasis: "none" });
    expect(s.dialogue[0]).toEqual({ characterId: "raghu", text: "hi" });
    expect(s.characters.sort()).toEqual(["mintu", "raghu"]);
  });
  it("does not match name fragments inside other words and passes unknown shapes through", () => {
    const out = normalizeScenes({ scenes: [{ visualDescription: "A mintuous crowd.", characters: [] }] }, cast) as { scenes: any[] };
    expect(out.scenes[0].characters).toEqual([]);
    expect(normalizeScenes("nope", cast)).toBe("nope");
  });
  it("prettifies slug-style titles", () => {
    expect(prettifyTitle("market-thief")).toBe("Market Thief");
    expect(prettifyTitle("The Night Thief")).toBe("The Night Thief");
  });
});
