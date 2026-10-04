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
  it("cut-out prompts ask for isolation on a plain background and trim the appearance", () => {
    expect(characterPrompt(motionComic, chars[0]!).prompt).toContain("full body character design of slender, grey cloak,");
    expect(characterPrompt(motionComic, chars[0]!).prompt).toContain("isolated on a plain white background");
    expect(propPrompt(motionComic, "wooden mousetrap").prompt).toContain("simple icon of a wooden mousetrap");
  });
});
