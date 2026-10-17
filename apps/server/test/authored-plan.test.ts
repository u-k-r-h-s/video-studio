import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StorySchema } from "@studio/shared";
import { storyFromPlan } from "../src/shots/director";
import { DirectedShotsSchema, DirectorOutlineSchema, normalizeShots } from "../src/shots/directorSchemas";
import { buildStory } from "../src/shots/storyBuilder";
import { animatedShort } from "../src/profiles/animatedShort";
import { resolveVoiceId } from "../src/providers/tts/voices";
import { impliedActions } from "../src/anim/semantics";

// the authored 3-minute Hindi story that ships with the repository (scripts/lab/stories)
const PLAN = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../scripts/lab/stories/meera-lost-purse.json"), "utf8"));
const clone = (): { outline: Record<string, unknown>; shots: Record<string, unknown>[] } => JSON.parse(JSON.stringify(PLAN));

describe("authored story plans (the director's format, no LLM)", () => {
  it("a 37-shot Hindi plan goes through the same derivation into a valid Story", () => {
    const r = storyFromPlan(PLAN, animatedShort, 180);
    expect(r.story.shots).toHaveLength(37);
    expect(StorySchema.safeParse(r.story).success).toBe(true);
    expect(r.characters.map((c) => c.id)).toEqual(["meera", "ramu-kaka", "amma"]);
    // Devanagari dialogue survives untouched
    expect(r.story.shots[2]!.dialogue[0]).toMatchObject({ characterId: "meera", text: "अरे! ये लाल-लाल क्या पड़ा है मिट्टी में?" });
    // every shot keeps its location and on-screen character
    PLAN.shots.forEach((s: { location: string; character: string }, i: number) => {
      expect(r.story.shots[i]!.locationId).toBe(s.location);
      expect(r.story.shots[i]!.subjectIds).toEqual(s.character ? [s.character] : []);
    });
  });

  it("keeps the authored beats (a payoff spanning several shots), while the AI director's guard is unchanged", () => {
    const r = storyFromPlan(PLAN, animatedShort, 180);
    expect(r.story.shots.slice(30).every((s) => s.beat === "payoff")).toBe(true);
    const outline = DirectorOutlineSchema.parse(PLAN.outline);
    const directed = DirectedShotsSchema.parse(normalizeShots({ shots: PLAN.shots.slice(0, 20) }, outline));
    directed.shots[10]!.beat = "payoff";
    const llm = buildStory(outline, directed, { ...animatedShort, cinematic: { ...animatedShort.cinematic!, maxShots: 20 } }, "T");
    expect(llm.story.shots[10]!.beat).not.toBe("payoff"); // a model's mid-film "payoff" is still re-derived from the order
  });

  it("an authored plan is not silently repaired: unknown ids and beats are errors", () => {
    const bad = clone();
    bad.shots[3]!.location = "moon-base";
    bad.shots[4]!.character = "ghost";
    bad.shots[5]!.line = { speaker: "stranger", text: "नमस्ते" };
    bad.shots[6]!.beat = "twist";
    expect(() => storyFromPlan(bad, animatedShort, 180)).toThrow(/shot 4: unknown location "moon-base".*shot 5: unknown character "ghost".*shot 6: unknown speaker "stranger".*shot 7: beat must be one of/);
  });

  it("whole-film checks still apply (e.g. too much speech for the length)", () => {
    expect(() => storyFromPlan(PLAN, animatedShort, 60)).toThrow(/Too much speech/);
  });

  it("a plan's cast sets each character's 3D model and voice; unknown ids are errors", () => {
    const p = clone() as ReturnType<typeof clone> & { cast?: unknown };
    p.cast = { meera: { asset: "woman-casual", voice: "hi-priyamvada" }, "ramu-kaka": { asset: "farmer", voice: "hi-pratham-elder" } };
    const r = storyFromPlan(p, animatedShort, 180);
    expect(r.characters.find((c) => c.id === "meera")).toMatchObject({ asset3d: "woman-casual", voiceId: "hi-priyamvada" });
    expect(r.characters.find((c) => c.id === "ramu-kaka")).toMatchObject({ asset3d: "farmer", voiceId: "hi-pratham-elder" });
    expect(resolveVoiceId("ramu-kaka", r.characters, "hi", animatedShort)).toBe("hi-pratham-elder"); // the cast wins over the pool
    p.cast = { ghost: { voice: "hi-rohan" } };
    expect(() => storyFromPlan(p, animatedShort, 180)).toThrow(/cast: unknown character "ghost"/);
  });

  it("partners ('with') join the shot and act under their own id; the lead keeps only its own actions", () => {
    const p = clone() as ReturnType<typeof clone>;
    (p.shots[30] as Record<string, unknown>).with = [{ character: "ramu-kaka", actions: [{ action: "nod", when: "late" }] }];
    const shot = storyFromPlan(p, animatedShort, 180).story.shots[30]!;
    expect(shot.subjectIds).toEqual(["meera", "ramu-kaka"]);
    expect(shot.animation!.actions.filter((a) => a.character === "ramu-kaka").map((a) => a.action)).toEqual(["nod"]);
    expect(impliedActions(shot).every((a) => a.character === "meera" && a.action !== "nod")).toBe(true);
  });

  it("the Hindi cast gets distinct voices: female/male models at different speaking rates", () => {
    const r = storyFromPlan(PLAN, animatedShort, 180);
    const v = (id: string) => resolveVoiceId(id, r.characters, "hi", animatedShort);
    expect([v("meera"), v("ramu-kaka"), v("amma"), v("narrator")]).toEqual(["hi-priyamvada", "hi-rohan-elder", "hi-priyamvada-calm", "hi-rohan-narrator"]);
  });
});
