import { describe, expect, it } from "vitest";
import { StorySchema, shotId, type Shot } from "@studio/shared";
import { checkShots, dropRepeatedLines, shotsPerBeat, ShotDirector, varyFraming } from "../src/shots/director";
import { BeatShotsSchema, DirectedShotsSchema, DirectorOutlineSchema, normalizeBeats, normalizeOutline, normalizeShots } from "../src/shots/directorSchemas";
import { actionCue, planKeyVisuals } from "../src/shots/keyVisuals";
import { buildStory } from "../src/shots/storyBuilder";
import { cinematicAnimatedShort } from "../src/profiles/cinematicAnimatedShort";
import { FakeLLM } from "./helpers";
import { DIRECTOR_OUTLINE, DIRECTOR_SHOTS, directorResponder } from "./fixtures-director";
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
  it("accepts a good shot list", () => expect(checkShots(directed, outline, profile, expected, 25)).toEqual({ hard: [], advice: [] }));
  it("reports unknown ids, repetition, missing speech and a wrong shot count", () => {
    const bad = DirectedShotsSchema.parse({ shots: Array.from({ length: 3 }, () => ({ beat: "setup", shotType: "wide", location: "moon", character: "ghost", emotion: "calm", action: "nothing happens here" })) });
    const r = checkShots(bad, outline, profile, expected, 25);
    const issues = [...r.hard, ...r.advice].join(" | ");
    expect(issues).toMatch(/about 11 shots/);
    expect(issues).toMatch(/unknown location "moon"/);
    expect(issues).toMatch(/unknown character "ghost"/);
    expect(issues).toMatch(/same shotType/);
    expect(issues).toMatch(/spoken dialogue/);
  });
  it("rejects too much speech", () => {
    const talky = { shots: directed.shots.map((s) => ({ ...s, line: { speaker: "kai", text: "word ".repeat(12).trim() } })) };
    expect(checkShots(DirectedShotsSchema.parse(talky), outline, profile, expected, 25).hard.join(" ")).toMatch(/Too much speech/);
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
      // only portraits are variants (wider framings stayed portrait-composed when started from the anchor)
      expect(v.kind).toBe("portrait");
      expect(v.initFrom!.denoise).toBe(v.id.includes("intense") || v.id.includes("eerie") ? 0.66 : 0.6);
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

describe("ShotDirector with a model (beat by beat)", () => {
  const ask = { idea: "Create a 25 second animated mystery short about a delivery rider.", targetDurationSeconds: 25 };
  it("writes the bible, the six beats, then the shots of each beat, and returns a valid story", async () => {
    const llm = new FakeLLM((req) => directorResponder(req));
    const steps: string[] = [];
    const out = await new ShotDirector(llm, { maxRepairs: 1, temperature: 0.5 }).direct(ask, profile, { onStep: (s, d) => steps.push(d ? `${s}:${d}` : s) });
    expect(steps).toEqual(["outline", "beats", "shots:hook", "shots:setup", "shots:curiosity", "shots:conflict", "shots:escalation", "shots:payoff"]);
    expect(out.title).toBe("The Last Delivery");
    expect(out.story.shots.length).toBe(10);
    expect(llm.requests).toHaveLength(8);
    expect(llm.requests.every((r) => r.format !== undefined)).toBe(true); // structured output on every call
    expect(llm.requests[2]!.messages.at(-1)!.content).toContain("(this is the first shot)");
    expect(llm.requests[3]!.messages.at(-1)!.content).toContain("Shots so far:\n1. [extreme-close-up]"); // each call sees the story so far
  });
  it("allocates the shot budget over the beats: 1 hook, 2 payoff, the rest spread through the middle", () => {
    expect(shotsPerBeat(11)).toEqual({ hook: 1, setup: 2, curiosity: 2, conflict: 2, escalation: 2, payoff: 2 });
    expect(shotsPerBeat(8)).toEqual({ hook: 1, setup: 2, curiosity: 1, conflict: 1, escalation: 1, payoff: 2 });
    expect(Object.values(shotsPerBeat(14)).reduce((a, b) => a + b, 0)).toBe(14);
  });
  it("repairs one beat with the exact problem, without redoing the others", async () => {
    let conflictCalls = 0;
    const llm = new FakeLLM((req) => directorResponder(req, { shotsFor: (beat) => {
      const good = DIRECTOR_SHOTS.shots.filter((s) => s.beat === beat);
      if (beat === "conflict" && conflictCalls++ === 0) return good.map((s) => ({ ...s, line: { speaker: "stranger", text: "Sundial Alley" } }));
      return good;
    } }));
    const repairs: string[][] = [];
    const out = await new ShotDirector(llm, { maxRepairs: 2, temperature: 0.5 }).direct(ask, profile, { onRepair: (_n, i) => repairs.push(i) });
    expect(out.story.shots).toHaveLength(10);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.join(" ")).toMatch(/place label/);
    expect(llm.requests).toHaveLength(9);
  });
  it("repairs invented ids deterministically instead of failing: an unknown place keeps the previous place, an unknown speaker becomes the person on screen", async () => {
    const llm = new FakeLLM((req) => directorResponder(req, { shotsFor: (beat) => DIRECTOR_SHOTS.shots.filter((s) => s.beat === beat).map((s) => ({ ...s, location: "john-doe", ...(s.line ? { line: { ...s.line, speaker: "voice-on-hold-1" } } : {}) })) }));
    const out = await new ShotDirector(llm, { maxRepairs: 1, temperature: 0.5 }).direct(ask, profile);
    expect(out.story.shots.every((s) => out.story.locations.some((l) => l.id === s.locationId))).toBe(true);
    const spoken = out.story.shots.flatMap((s) => s.dialogue);
    expect(spoken.every((d) => d.characterId === "narrator" || out.characters.some((c) => c.id === d.characterId))).toBe(true);
    expect(llm.requests.length).toBeLessThanOrEqual(12); // at most one soft advice round per beat
  });
  it("applies the variety pass: no framing three times in a row and at least 4 different framings", async () => {
    const llm = new FakeLLM((req) => directorResponder(req, { shotsFor: (beat) => DIRECTOR_SHOTS.shots.filter((s) => s.beat === beat).map((s) => ({ ...s, shotType: "wide" })) }));
    const out = await new ShotDirector(llm, { maxRepairs: 1, temperature: 0.5 }).direct(ask, profile);
    const types = out.story.shots.map((s) => s.shotType);
    for (let i = 2; i < types.length; i++) expect(types[i] === types[i - 1] && types[i] === types[i - 2]).toBe(false);
    expect(new Set(types).size).toBeGreaterThanOrEqual(4);
  });
  it("fails with a readable error when a beat cannot be repaired, and when the film would be too short", async () => {
    const stuck = new FakeLLM((req) => directorResponder(req, { shotsFor: () => [] }));
    await expect(new ShotDirector(stuck, { maxRepairs: 1, temperature: 0.5 }).direct(ask, profile)).rejects.toThrow(/shots/);
  });
  it("puts the faithful-to-the-idea rule, the hero and the place rules in the prompts", async () => {
    const llm = new FakeLLM((req) => directorResponder(req));
    await new ShotDirector(llm, { maxRepairs: 1, temperature: 0.5 }).direct(ask, profile);
    expect(llm.requests[0]!.messages.at(-1)!.content).toContain("Stay faithful to the idea");
    expect(llm.requests[1]!.messages.at(-1)!.content).toContain("hook -> setup -> curiosity -> conflict -> escalation -> payoff");
    expect(llm.requests[2]!.messages.at(-1)!.content).toContain('the hero is "kai"');
  });
});

describe("cleaning a small model's speech", () => {
  it("drops junk lines and repeated lines, keeping the first", () => {
    const out = DirectedShotsSchema.parse(normalizeShots({ shots: [
      { beat: "hook", shotType: "close-up", location: "alley", character: "kai", emotion: "calm", action: "Kai waits.", line: { speaker: "kai", text: "-" } },
      { beat: "setup", shotType: "medium", location: "alley", character: "kai", emotion: "calm", action: "Kai looks.", line: { speaker: "kai", text: "What's going on?" } },
      { beat: "setup", shotType: "wide", location: "alley", character: "kai", emotion: "calm", action: "Kai turns.", line: { speaker: "kai", text: "What's going on?!" } },
    ] }, outline));
    expect(out.shots[0]!.line).toBeUndefined();
    expect(dropRepeatedLines(out.shots).map((s) => s.line?.text)).toEqual([undefined, "What's going on?", undefined]);
  });
});

describe("variety pass", () => {
  it("is a no-op when the framing already varies", () => {
    expect(varyFraming(directed.shots).map((s) => s.shotType)).toEqual(directed.shots.map((s) => s.shotType));
  });
});

describe("small-model robustness", () => {
  it("infers who is on screen from the action text or the speaker when the model left `character` empty", () => {
    const out = DirectedShotsSchema.parse(normalizeShots({ shots: [
      { beat: "hook", shotType: "close-up", location: "alley", character: "", emotion: "calm", action: "Kai looks up at the dark window." },
      { beat: "setup", shotType: "medium", location: "alley", character: "", emotion: "calm", action: "A man waits.", line: { speaker: "stranger", text: "You are late." } },
      { beat: "setup", shotType: "extreme-close-up", location: "alley", character: "", emotion: "calm", action: "A phone buzzes.", line: { speaker: "kai", text: "What?" }, onScreenText: "NEW ORDER" },
      { beat: "payoff", shotType: "wide", location: "alley", character: "", emotion: "calm", action: "Rain falls on the empty street." },
    ] }, outline));
    expect(out.shots.map((s) => s.character)).toEqual(["kai", "stranger", "", ""]);
  });
  it("normalises the beats: strings, synonyms and a wrong count", () => {
    const ok = normalizeBeats({ beats: ["a b c d e", "f g h i j", "k l m n o", "p q r s t", "u v w x y", "z z z z z"] }) as { beats: { beat: string }[] };
    expect(ok.beats.map((b) => b.beat)).toEqual(["hook", "setup", "curiosity", "conflict", "escalation", "payoff"]);
    const syn = normalizeBeats({ beats: [{ beat: "intro", summary: "something happens" }, { name: "twist", description: "another thing" }] }) as { beats: { beat: string; what: string }[] };
    expect(syn.beats[0]).toEqual({ beat: "hook", what: "something happens" });
    expect(syn.beats[1]).toEqual({ beat: "payoff", what: "another thing" });
  });
});

describe("image sharing limit", () => {
  it("never lets more than 3 shots share one picture: extra shots get another take (same prompt, new image)", () => {
    const { story, characters } = built();
    const many = Array.from({ length: 8 }, (_, i) => ({ ...story.shots[2]!, id: shotId(i + 1), order: i + 1, visualKey: "" }));
    const { keyVisuals, shotKey } = planKeyVisuals(many, { style: "s", characters, locations: story.locations }, 8);
    expect(keyVisuals.length).toBeGreaterThanOrEqual(3);
    for (const k of keyVisuals) expect(k.shotIds.length).toBeLessThanOrEqual(3);
    expect(Object.keys(shotKey)).toHaveLength(8);
    expect(new Set(keyVisuals.map((k) => k.prompt)).size).toBe(1); // same prompt; the seed (asset id) differs
  });
});

describe("portrait variety", () => {
  it("anchors identity on the calmest portrait and varies the gaze of further takes of the same character", () => {
    const { story, characters } = built();
    const mk = (n: number, emotion: Shot["emotion"], shotType: Shot["shotType"] = "close-up"): Shot => ({ ...story.shots[3]!, id: shotId(n), order: n, emotion, shotType, subjectIds: ["kai"], insert: undefined });
    // first portrait is intense, a calmer one comes later: the calm one must become the anchor
    const shots = [mk(1, "shock"), mk(2, "calm"), mk(3, "calm"), mk(4, "calm"), mk(5, "calm"), mk(6, "uneasy")];
    const { keyVisuals } = planKeyVisuals(shots, { style: "s", characters, locations: story.locations }, 8);
    const anchor = keyVisuals.find((k) => !k.initFrom && k.subjectIds[0] === "kai")!;
    expect(anchor.id).toContain("base");
    for (const v of keyVisuals.filter((k) => k.initFrom)) expect(v.initFrom!.keyId).toBe(anchor.id);
    const calm = keyVisuals.filter((k) => k.id.includes("base"));
    expect(calm.length).toBeGreaterThanOrEqual(2); // 4 calm shots -> 2 takes (max 3 per image)
    expect(new Set(keyVisuals.map((k) => k.prompt)).size).toBe(keyVisuals.length); // gaze phrases make takes differ
  });
});

describe("action cue in image prompts", () => {
  it("adds the shot's action without character names, and keeps wide/figure shots text-to-image", () => {
    const { story, characters } = built();
    expect(actionCue("Kai's hand trembles as Kai touches the package.", characters)).toBe("the person hand trembles as the person touches the package.");
    expect(actionCue("x ".repeat(80), characters).length).toBeLessThanOrEqual(100);
    const hook = story.keyVisuals.find((k) => k.shotIds.includes("shot-01"))!;
    expect(hook.prompt.toLowerCase()).toContain("phone");
    for (const k of story.keyVisuals.filter((x) => x.kind !== "portrait")) expect(k.initFrom).toBeUndefined();
    expect(story.keyVisuals.some((k) => k.prompt.includes("Kai"))).toBe(false);
  });
});

describe("director states the physical action", () => {
  it("normalises action names and timing words, and keeps them on the shot as animation", () => {
    const out = BeatShotsSchema.parse(normalizeShots({ shots: [
      { beat: "hook", shotType: "wide", location: "alley", character: "kai", emotion: "calm", action: "Kai walks down the alley.", actions: [{ action: "Walking", when: "beginning" }, { action: "Turns Head", when: "after" }], objects: [{ object: "Street Lamp", action: "flicker", when: "middle" }] },
    ] }, outline));
    expect(out.shots[0]!.actions).toEqual([{ action: "walk", when: "start" }, { action: "head-turn", when: "late" }]);
    expect(out.shots[0]!.objects).toEqual([{ object: "street-lamp", action: "flicker", when: "mid" }]);
  });
  it("a built story carries each shot's actions for the engine (only when a character is on screen)", () => {
    const withActions = DirectedShotsSchema.parse(normalizeShots({ shots: DIRECTOR_SHOTS.shots.map((s, i) => ({ ...s, ...(i === 3 ? { actions: [{ action: "look-down", when: "early" }, { action: "nod", when: "late" }] } : {}) })) }, outline));
    const { story } = buildStory(outline, withActions, profile, "T");
    expect(story.shots[3]!.animation?.actions.map((a) => a.action)).toEqual(["look-down", "nod"]);
    expect(story.shots[3]!.animation?.actions[0]!.character).toBe("kai");
    expect(story.shots[2]!.animation).toBeUndefined();
    expect(StorySchema.safeParse(story).success).toBe(true);
  });
  it("the shot prompt asks for physical actions", () => {
    const llm = new FakeLLM((req) => directorResponder(req));
    return new ShotDirector(llm, { maxRepairs: 1, temperature: 0.5 }).direct({ idea: "A rider.", targetDurationSeconds: 25 }, profile).then(() => {
      expect(llm.requests[2]!.messages.at(-1)!.content).toContain("PHYSICAL");
    });
  });
});
