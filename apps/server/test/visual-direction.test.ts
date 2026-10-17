import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { Character, Shot } from "@studio/shared";
import { envelope, speechTrack, textVisemes } from "../src/anim/lipsync";
import { encodeWav } from "../src/lib/wav";
import { FaceRig } from "../src/anim/renderers/three3d/runtime/face";
import { planVisuals } from "../src/anim/renderers/three3d/visualPlan";
import { castStory, type CatalogEntry } from "../src/anim/renderers/three3d/casting";
import { compileShot3D } from "../src/anim/renderers/three3d/compile";
import { artStyleOf } from "../src/anim/renderers/three3d/artStyle";
import { storyFromPlan } from "../src/shots/director";
import { animatedShort3d } from "../src/profiles/animatedShort3d";

const plan = (name: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../scripts/lab/stories/${name}.json`), "utf8"));
const tone = (silent: number, voiced: number, sr = 22050): Buffer => {
  const n = Math.round((silent + voiced) * sr), s = new Int16Array(n);
  for (let i = Math.round(silent * sr); i < n; i++) s[i] = Math.round(Math.sin((i / sr) * 2 * Math.PI * 180) * 12000);
  return encodeWav({ sampleRate: sr, samples: s });
};

describe("lip-sync from the voice and the text", () => {
  it("maps Devanagari to visemes (vowel matras, consonant classes, nukta letters, inherent 'a')", () => {
    expect(textVisemes("तो चलिए").map((v) => v.v)).toEqual(["DD", "O", "sil", "CH", "aa", "nn", "I", "E"]);
    expect(textVisemes("पढ़ाई").map((v) => v.v).slice(0, 3)).toEqual(["PP", "aa", "DD"]);
    expect(textVisemes("hello").map((v) => v.v)).toEqual(["E", "nn", "nn", "O"]);
  });
  it("the mouth follows the audio: closed in silence, open where the voice is loud; shapes only on voiced frames", () => {
    const env = envelope({ sampleRate: 22050, samples: new Int16Array(encodeWav({ sampleRate: 22050, samples: new Int16Array(0) }).length) }, 30);
    expect(env.every((e) => e === 0)).toBe(true);
    const tr = speechTrack(tone(0.5, 1), "नमस्ते", 30);
    expect(Math.max(...tr.env.slice(0, 12))).toBeLessThan(0.05); // the first 0.4 s are silent
    expect(Math.min(...tr.env.slice(20, 40))).toBeGreaterThan(0.6); // the voice
    expect(tr.visemes[0]!.t).toBeGreaterThanOrEqual(0.45); // no mouth shape before the voice starts
  });
});

describe("face rig (blend shapes found by name, whatever the model)", () => {
  const head = (names: string[]): THREE.Mesh => {
    const g = new THREE.BoxGeometry(1, 1, 1);
    g.morphAttributes.position = names.map(() => g.attributes.position!.clone());
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial()); m.updateMorphTargets();
    m.morphTargetDictionary = Object.fromEntries(names.map((n, i) => [n, i])); m.morphTargetInfluences = names.map(() => 0);
    return m;
  };
  const names = ["blendShape1.AA_VI_00_Sil", "AA_VI_01_PP", "AA_VI_10_aa", "AA_VI_11_E", "AA_VI_13_O", "AK_09_EyeBlinkLeft", "AK_10_EyeBlinkRight", "AK_25_JawOpen", "AK_44_MouthSmileLeft", "AK_45_MouthSmileRight", "AK_03_BrowInnerUp"];
  it("drives the viseme with the voice, eases expressions, and reports what the face can do", () => {
    const m = head(names), rig = new FaceRig(m, 3);
    expect(rig.capabilities).toMatchObject({ visemes: 5, lipSync: "visemes", blink: true });
    const speech = [{ at: 1, duration: 1, fps: 30, env: Array(30).fill(0.9), visemes: [{ t: 0, v: "aa" }, { t: 0.5, v: "O" }] }];
    rig.update(0.5, 1 / 30, speech, "neutral");
    expect(m.morphTargetInfluences![2]).toBe(0); // not speaking yet
    for (let t = 0.5; t < 1.3; t += 1 / 30) rig.update(t, 1 / 30, speech, "happy");
    expect(m.morphTargetInfluences![2]).toBeGreaterThan(0.6); // "aa" while the voice is loud
    expect(m.morphTargetInfluences![8]).toBeGreaterThan(0.1); // smiling (softened on the mouth while talking)
    for (let t = 1.3; t < 2.6; t += 1 / 30) rig.update(t, 1 / 30, speech, "happy");
    expect(m.morphTargetInfluences![2]).toBeLessThan(0.05); // the line is over: the mouth closes
    expect(m.morphTargetInfluences![4]).toBeLessThan(0.05);
  });
  it("a model without face shapes or a jaw is reported as having none (nothing is faked)", () => {
    const rig = new FaceRig(new THREE.Mesh(new THREE.BoxGeometry()), 1);
    expect(rig.capabilities.lipSync).toBe("none");
    expect(rig.hasFace).toBe(false);
  });
});

describe("story-driven visual direction", () => {
  const story = (p: unknown) => storyFromPlan(p, animatedShort3d, 15).story;
  it("different stories get different worlds: a rainy night village, a sunny market", () => {
    const night = planVisuals(story(plan("validate-rainy-night"))), day = planVisuals(story(plan("validate-sunny-market")));
    expect(night.locations[0]).toMatchObject({ kit: "village", timeOfDay: "night", weather: "rain", lighting: "rainy-night" });
    expect(night.locations[0]!.rain).toBeGreaterThan(0.5);
    expect(day.locations[0]).toMatchObject({ kit: "market", timeOfDay: "day", lighting: "sunny-day", rain: 0 });
  });
  it("other places and moods: a power cut at home, a foggy dawn road", () => {
    const s = story(plan("validate-rainy-night"));
    s.locations[0] = { ...s.locations[0]!, name: "Living room", visualIdentity: "the living room inside the house, power cut, only a candle", description: "interior", lighting: "candle light", timeOfDay: "night", weather: undefined };
    expect(planVisuals(s).locations[0]).toMatchObject({ kit: "interior", lighting: "power-outage", lightsOut: true, rain: 0 });
    s.locations[0] = { ...s.locations[0]!, name: "Village road", visualIdentity: "a dirt road between fields at dawn, thick mist", description: "the road to town", lighting: "pale dawn", timeOfDay: "morning", weather: "fog" };
    expect(planVisuals(s).locations[0]).toMatchObject({ kit: "road", lighting: "foggy-dawn" });
    // one tea stall at a bus stop is still a road, not a market
    s.locations[0] = { ...s.locations[0]!, visualIdentity: "the village road at dawn by the tea stall where the bus stops" };
    expect(planVisuals(s).locations[0]!.kit).toBe("road");
  });
  it("continuity: every shot of a location shares its weather/light; the camera never repeats the previous angle", () => {
    const p = planVisuals(story(plan("validate-sunny-market")));
    expect(new Set(p.shots.map((s) => s.locationId)).size).toBe(1);
    for (let i = 1; i < p.shots.length; i++) expect(Math.abs(p.shots[i]!.angle - p.shots[i - 1]!.angle)).toBeGreaterThan(0.1);
  });
  it("a raised object is the one the shot names: no torch appears unless the story has one", () => {
    const st = story(plan("validate-rainy-night")), vp = planVisuals(st);
    const shot: Shot = { ...st.shots[0]!, animation: { actions: [{ character: "dadaji", action: "raise-object", when: "mid" }], objects: [] } };
    const compile = (s: Shot) => compileShot3D({ shot: s, story: st, characters: storyFromPlan(plan("validate-rainy-night"), animatedShort3d, 15).characters, duration: 4, width: 108, height: 192, fps: 30, seed: 1, cast: () => ({ asset: "rb-elder-man" }), direction: { location: vp.locations[0]!, shot: vp.shots[0], style: artStyleOf(vp.artStyle) } }).spec;
    expect(compile(shot).characters.flatMap((c) => c.props ?? []).some((p) => p.kind === "flashlight")).toBe(false);
    const torch: Shot = { ...shot, animation: { actions: shot.animation!.actions, objects: [{ object: "torch", action: "hold", when: "start" }] } };
    expect(compile(torch).characters.flatMap((c) => c.props ?? []).some((p) => p.kind === "flashlight")).toBe(true);
  });
  it("a close-up frames only the face (no door two-shot even on a reaction); a still conversation stays at the meeting point", () => {
    const st = story(plan("validate-sunny-market")), vp = planVisuals(st), chars = storyFromPlan(plan("validate-sunny-market"), animatedShort3d, 15).characters;
    const two = st.shots.find((s) => s.subjectIds.length > 1)!;
    const base: Shot = { ...two, animation: { actions: [{ character: two.subjectIds[0]!, action: "surprise", when: "early" }], objects: [] } };
    const compile = (s: Shot) => compileShot3D({ shot: s, story: st, characters: chars, duration: 4, width: 108, height: 192, fps: 30, seed: 1, cast: () => ({ asset: "rb-girl" }), direction: { location: vp.locations[0]!, shot: vp.shots[0], style: artStyleOf(vp.artStyle) } }).spec;
    const cu = compile({ ...base, shotType: "close-up" });
    expect(cu.camera.shot).toBe("closeup");
    expect(cu.camera.frameWith).toBeUndefined();
    const lead = compile({ ...base, shotType: "medium" }).characters[0]!;
    expect(lead.start.z).toBeGreaterThan(2); // in front of the house with the others, not back at the door
    // indoors the same conversation stands in the lit middle of the room, not out at the open front
    const room = { ...vp.locations[0]!, kit: "interior" as const, lighting: "warm-interior" as const };
    const inside = compileShot3D({ shot: { ...base, shotType: "medium" }, story: st, characters: chars, duration: 4, width: 108, height: 192, fps: 30, seed: 1, cast: () => ({ asset: "rb-girl" }), direction: { location: room, shot: vp.shots[0], style: artStyleOf(vp.artStyle) } }).spec;
    expect(inside.characters[0]!.start.z).toBeLessThan(-3);
  });
});

describe("casting from the story (no default courier)", () => {
  const cat: Record<string, CatalogEntry> = {
    "rb-young-man": { style: "semi-realistic", gender: "male", age: "adult", tags: ["young", "hoodie"], face: "visemes", license: "", source: "" },
    "rb-elder-man": { style: "semi-realistic", gender: "male", age: "elder", tags: ["old", "beard"], face: "visemes", license: "", source: "" },
    "rb-girl": { style: "semi-realistic", gender: "female", age: "child", tags: ["girl", "kurta"], face: "visemes", license: "", source: "" },
    "casual-man": { style: "stylized-lowpoly", gender: "male", age: "adult", tags: ["man"], face: "none", license: "", source: "" },
  };
  const c = (id: string, appearance: string, role = "x"): Character => ({ id, name: id, appearance, description: role } as Character);
  it("fits gender and age, and never gives two characters the same model while others are free", () => {
    const cast = castStory([c("g", "a 10-year-old girl"), c("o", "an old man with a grey beard"), c("y", "a young man"), c("y2", "a man in his thirties")], cat, "semi-realistic");
    expect(cast).toMatchObject({ g: "rb-girl", o: "rb-elder-man", y: "rb-young-man", y2: "casual-man" });
  });
});
