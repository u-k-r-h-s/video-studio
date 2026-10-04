import { describe, expect, it } from "vitest";
import { StorySchema, shotId } from "@studio/shared";
import { checkShots, ShotDirector } from "../src/shots/director";
import { DirectedShotsSchema, DirectorOutlineSchema, normalizeOutline, normalizeShots } from "../src/shots/directorSchemas";
import { planKeyVisuals } from "../src/shots/keyVisuals";
import { buildStory } from "../src/shots/storyBuilder";
import { cinematicAnimatedShort } from "../src/profiles/cinematicAnimatedShort";
import { FakeLLM } from "./helpers";
import { DIRECTOR_OUTLINE, DIRECTOR_SHOTS } from "./fixtures-director";
import { setLogQuiet } from "../src/lib/logger";
import { beforeAll } from "vitest";

beforeAll(() => setLogQuiet(true));
const profile = cinematicAnimatedShort;
const outline = DirectorOutlineSchema.parse(DIRECTOR_OUTLINE);
const directed = DirectedShotsSchema.parse(normalizeShots(DIRECTOR_SHOTS, outline));
const built = () => buildStory(outline, directed, profile, "The Last Delivery");

describe("director output normalisation", () => {
  it("maps near-miss enums, ids and shapes from a small model onto valid values", () => {
    const raw = { shots: [{ beat: "intro", shot_type: "Close-Up", location: "Sundial Alley", character: "Kai", emotion: "Scared", action: " a thing happens ", line: { speaker: "KAI", text: " hi " } },
      { beat: "twist", shotType: "wide shot", location: "lobby", character: "none", emotion: "mysterious", action: "an empty lobby" }, { beat: "setup", shotType: "ots", location: "alley", character: "", emotion: "happy", action: "over the shoulder" }] };
    const out = DirectedShotsSchema.parse(normalizeShots(raw, outline));
    expect(out.shots[0]).toMatchObject({ beat: "hook", shotType: "close-up", location: "alley", character: "kai", emotion: "fear", action: "a thing happens", line: { speaker: "kai", text: "hi" } });
    expect(out.shots[1]).toMatchObject({ beat: "payoff", shotType: "wide", character: "", emotion: "eerie" });
    expect(out.shots[2]).toMatchObject({ shotType: "over-shoulder", emotion: "joy" });
  });
  it("slugifies ids in the outline", () => {
    const o = DirectorOutlineSchema.parse(normalizeOutline({ ...DIRECTOR_OUTLINE, characters: [{ ...DIRECTOR_OUTLINE.characters[0]!, id: "Kai The Rider" }], locations: [{ ...DIRECTOR_OUTLINE.locations[0]!, id: "Sundial Alley!" }] }));
    expect(o.characters[0]!.id).toBe("kai-the-rider");
    expect(o.locations[0]!.id).toBe("sundial-alley");
  });
  it("leaves unknown enum values alone so validation fails and the model is asked to repair", () => {
    expect(DirectedShotsSchema.safeParse(normalizeShots({ shots: [{ beat: "hook", shotType: "dutch-zoom", location: "alley", character: "", emotion: "calm", action: "x y z" }] }, outline)).success).toBe(false);
  });
});

describe("director integrity checks", () => {
  const expected = 11;
  it("accepts a good shot list", () => expect(checkShots(directed, outline, profile, expected, 25)).toEqual([]));
  it("reports unknown ids, repetition, missing speech and a wrong shot count", () => {
    const bad = DirectedShotsSchema.parse({ shots: Array.from({ length: 3 }, () => ({ beat: "setup", shotType: "wide", location: "moon", character: "ghost", emotion: "calm", action: "nothing happens here" })) });
    const issues = checkShots(bad, outline, profile, expected, 25).join(" | ");
    expect(issues).toMatch(/about 11 shots/);
    expect(issues).toMatch(/unknown location "moon"/);
    expect(issues).toMatch(/unknown character "ghost"/);
    expect(issues).toMatch(/same shotType/);
    expect(issues).toMatch(/spoken dialogue/);
  });
  it("rejects too much speech", () => {
    const talky = { shots: directed.shots.map((s) => ({ ...s, line: { speaker: "kai", text: "word ".repeat(12).trim() } })) };
    expect(checkShots(DirectedShotsSchema.parse(talky), outline, profile, expected, 25).join(" ")).toMatch(/Too much speech/);
  });
});

describe("story builder (deterministic derivation from the director's output)", () => {
  it("produces a valid story: ids, hook first, payoff + title last, scenes by location, every shot has a key image", () => {
    const { story, characters } = built();
    expect(StorySchema.safeParse(story).success).toBe(true);
    expect(story.shots.map((s) => s.id)).toEqual(directed.shots.map((_, i) => shotId(i + 1)));
    expect(story.shots[0]!.beat).toBe("hook");
    expect(story.shots.at(-1)!.beat).toBe("payoff");
    expect(story.shots.at(-1)!.insert).toEqual({ kind: "title", text: "THE LAST DELIVERY" });
    expect(story.shots.at(-1)!.transition.type).toBe("fade");
    expect(story.scenes.map((s) => s.locationId)).toEqual(["alley", "lobby", "alley", "lobby", "alley"]);
    expect(story.scenes.flatMap((s) => s.shotIds)).toEqual(story.shots.map((s) => s.id));
    const keys = new Set(story.keyVisuals.map((k) => k.id));
    for (const s of story.shots) expect(keys.has(s.visualKey)).toBe(true);
    expect(characters.map((c) => c.id)).toEqual(["kai", "stranger"]);
  });
  it("derives camera, durations, SFX, effects and transitions from shot type, beat, emotion and action", () => {
    const { story } = built();
    const [hook, , , , , , shock, phone] = story.shots;
    expect(hook!.motion.type).toBe("push-in");
    expect(hook!.camera.endScale).toBeGreaterThan(hook!.camera.startScale);
    expect(hook!.insert).toEqual({ kind: "phone", text: "DELIVER TO: KAI" });
    expect(hook!.sfx.some((x) => x.kind === "ping")).toBe(true); // "A phone buzzes"
    expect(hook!.duration).toBeLessThanOrEqual(4.5); // strong first seconds
    expect(shock!.characterMotion.map((m) => m.action)).toEqual(["surprise", "fear"]);
    expect(shock!.effects).toEqual({ impact: true });
    expect(shock!.sfx.some((x) => x.kind === "impact")).toBe(true);
    expect(story.shots[5]!.transition.type).toBe("zoom"); // the cut into the shock shot is punched
    expect(phone!.insert?.kind).toBe("phone");
    for (const s of story.shots) { expect(s.duration).toBeGreaterThanOrEqual(1.5); expect(s.duration).toBeLessThanOrEqual(9); }
  });
  it("lengthens a spoken shot to fit its line and never shows two characters in one shot", () => {
    const { story } = built();
    const long = story.shots[0]!;
    const words = long.dialogue[0]!.text.split(/\s+/).length;
    expect(long.duration).toBeGreaterThanOrEqual(words / profile.cinematic!.wordsPerSecond);
    for (const s of story.shots) expect(s.subjectIds.length).toBeLessThanOrEqual(1);
  });
  it("is deterministic", () => expect(built().story).toEqual(built().story));
});

describe("character and location persistence in image prompts", () => {
  it("puts the character's costume-coded identity in EVERY image of that character, and the place's identity in every environment image", () => {
    const { story, characters } = built();
    const kai = characters.find((c) => c.id === "kai")!;
    const kaiKeys = story.keyVisuals.filter((k) => k.subjectIds[0] === "kai");
    expect(kaiKeys.length).toBeGreaterThanOrEqual(2);
    for (const k of kaiKeys) {
      expect(k.prompt).toContain("orange jacket with black stripes");
      expect(k.prompt).toContain(kai.appearance);
      expect(k.prompt.startsWith(profile.cinematic!.stylePrefix)).toBe(true);
    }
    const stranger = story.keyVisuals.find((k) => k.subjectIds[0] === "stranger")!;
    expect(stranger.prompt).toContain("mustard-yellow coat");
    expect(stranger.prompt).not.toContain("orange jacket");
    for (const k of story.keyVisuals.filter((x) => x.kind === "environment")) {
      const loc = story.locations.find((l) => l.id === k.locationId)!;
      expect(k.prompt).toContain(loc.visualIdentity);
    }
  });
  it("makes other portraits of a character img2img variants of its first portrait (identity carries over), anchors first", () => {
    const { story } = built();
    const ids = story.keyVisuals.map((k) => k.id);
    const variants = story.keyVisuals.filter((k) => k.initFrom);
    expect(variants.length).toBeGreaterThanOrEqual(1);
    for (const v of variants) {
      const anchor = story.keyVisuals.find((k) => k.id === v.initFrom!.keyId)!;
      expect(anchor.subjectIds[0]).toBe(v.subjectIds[0]);
      expect(anchor.initFrom).toBeUndefined();
      expect(ids.indexOf(anchor.id)).toBeLessThan(ids.indexOf(v.id));
      expect(v.initFrom!.denoise).toBeGreaterThan(0.3);
      expect(v.initFrom!.denoise).toBeLessThan(0.8);
    }
  });
});

describe("key image budget and reuse", () => {
  it("generates fewer images than shots by sharing, and never more than the budget", () => {
    const { story } = built();
    expect(story.keyVisuals.length).toBeLessThan(story.shots.length);
    expect(story.keyVisuals.length).toBeLessThanOrEqual(profile.cinematic!.maxKeyImages);
  });
  it("merges the least-used images into their closest relative when over budget, keeping every shot covered", () => {
    const { story } = built();
    const ctx = { style: "style", characters: [], locations: story.locations };
    const tight = planKeyVisuals(story.shots, { ...ctx, characters: built().characters }, 3);
    expect(tight.keyVisuals.length).toBe(3);
    expect(Object.keys(tight.shotKey).sort()).toEqual(story.shots.map((s) => s.id).sort());
    expect(new Set(tight.keyVisuals.flatMap((k) => k.shotIds)).size).toBe(story.shots.length);
    const one = planKeyVisuals(story.shots, { ...ctx, characters: built().characters }, 1);
    expect(one.keyVisuals).toHaveLength(1);
  });
});

describe("ShotDirector with a model", () => {
  it("runs the outline then the shot list and returns a valid story", async () => {
    const llm = new FakeLLM((req) => (req.messages.some((m) => m.content.includes("story bible")) ? DIRECTOR_OUTLINE : DIRECTOR_SHOTS));
    const d = new ShotDirector(llm, { maxRepairs: 1, temperature: 0.5 });
    const steps: string[] = [];
    const out = await d.direct({ idea: "Create a 25 second animated mystery short about a delivery rider.", targetDurationSeconds: 25 }, profile, { onStep: (s) => steps.push(s) });
    expect(steps).toEqual(["outline", "shots"]);
    expect(out.title).toBe("The Last Delivery");
    expect(out.story.shots.length).toBe(10);
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.messages.at(-1)!.content).toContain("exactly 11 shots");
    expect(llm.requests[1]!.format).toBeDefined(); // structured output
  });
  it("sends the exact problems back and accepts the corrected answer", async () => {
    const wrong = { shots: DIRECTOR_SHOTS.shots.map((s, i) => (i === 3 ? { ...s, location: "moon" } : s)) };
    let shotCalls = 0;
    const llm = new FakeLLM((req) => {
      if (req.messages.some((m) => m.content.includes("story bible"))) return DIRECTOR_OUTLINE;
      return shotCalls++ === 0 ? wrong : DIRECTOR_SHOTS;
    });
    const repairs: string[][] = [];
    const out = await new ShotDirector(llm, { maxRepairs: 2, temperature: 0.5 }).direct({ idea: "x".repeat(12), targetDurationSeconds: 25 }, profile, { onRepair: (_n, issues) => repairs.push(issues) });
    expect(out.story.shots).toHaveLength(10);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.join(" ")).toMatch(/unknown location "moon"/);
    expect(llm.requests.at(-1)!.messages.at(-1)!.content).toMatch(/unknown location "moon"/);
  });
  it("fails with a readable error after the repair budget is spent", async () => {
    const llm = new FakeLLM((req) => (req.messages.some((m) => m.content.includes("story bible")) ? DIRECTOR_OUTLINE : { shots: [] }));
    await expect(new ShotDirector(llm, { maxRepairs: 1, temperature: 0.5 }).direct({ idea: "x".repeat(12), targetDurationSeconds: 25 }, profile)).rejects.toThrow(/shot list/);
  });
});
