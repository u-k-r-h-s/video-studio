import { describe, expect, it } from "vitest";
import type { Character, Scene } from "@studio/shared";
import { motionComic } from "../src/profiles/motionComic";
import { backgroundPrompt, characterPrompt, propPrompt, stripPeople } from "../src/pipeline/imagePrompts";

const chars: Character[] = [{ id: "daiquan", name: "Daiquan Sharp Eyes", description: "detective", appearance: " slender, grey cloak " }, { id: "kaito", name: "Kaito", description: "thief", appearance: "lean, black jacket" }];
const scene = { id: "scene-01", location: "village shop", visualDescription: "Detective Daiquan stands behind a counter, warm lamp light, shelves of jars." } as Scene;

describe("image prompts", () => {
  it("shared location backgrounds describe the PLACE only (LCM ignores negative prompts, so people must not appear)", () => {
    const p = backgroundPrompt(motionComic, scene, chars, false);
    expect(p.prompt).toContain("interior of a village shop");
    expect(p.prompt).not.toMatch(/Daiquan|detective|stands|counter/i);
    expect(p.prompt).toContain("no people");
  });
  it("scene-specific backgrounds keep only the people-free parts of the description", () => {
    const p = backgroundPrompt(motionComic, scene, chars, true);
    expect(p.prompt).toContain("warm lamp light");
    expect(p.prompt).toContain("shelves of jars");
    expect(p.prompt).not.toMatch(/Daiquan|detective|stands/i);
  });
  it("strips named characters and person words", () => {
    expect(stripPeople("Kaito sneaks in. A candle burns, he looks around, the door creaks.", chars)).toBe("A candle burns, the door creaks");
  });
  it("cut-out prompts are simple (measured: poster-style wording breaks cut-outs) and trim the appearance", () => {
    const c = characterPrompt(motionComic, chars[0]!).prompt;
    expect(c).toBe("full body cartoon character with slender, grey cloak, standing, simple flat colours, clean outlines, white background");
    expect(c).not.toMatch(/character design|sticker|illustration|poster/i); // wording measured to produce framed posters
    expect(propPrompt(motionComic, "wooden mousetrap").prompt).toContain("a single wooden mousetrap");
    expect(propPrompt(motionComic, "wooden mousetrap").prompt).toContain("white background");
  });
});
