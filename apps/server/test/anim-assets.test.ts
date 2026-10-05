import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { audioCuesFor } from "../src/anim/cues";
import { composeShot } from "../src/anim/compose";
import { AssetCache } from "../src/anim/assets";
import { MANNEQUIN_INIT, diffManifest, planAssets, withoutBeings } from "../src/anim/manifest";
import { applyMatte, assessMatte } from "../src/lib/matte";
import { setLogQuiet } from "../src/lib/logger";
import { spokenText } from "../src/lib/spoken";
import { animatedShort } from "../src/profiles/animatedShort";
import { buildStory } from "../src/shots/storyBuilder";
import { DirectedShotsSchema, DirectorOutlineSchema, normalizeShots } from "../src/shots/directorSchemas";
import { DIRECTOR_OUTLINE, DIRECTOR_SHOTS } from "./fixtures-director";

beforeAll(() => setLogQuiet(true));
const anim = animatedShort.animation!;
const outline = DirectorOutlineSchema.parse(DIRECTOR_OUTLINE);
const built = buildStory(outline, DirectedShotsSchema.parse(normalizeShots(DIRECTOR_SHOTS, outline)), animatedShort, "The Last Delivery");
const manifest = planAssets(built.story, built.characters, anim);

describe("asset manifest", () => {
  it("asks only for what the shots need: views from the actions, props from the objects, one background per location", () => {
    const ids = manifest.assets.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => i.startsWith("loc-"))).toHaveLength(2);
    expect(ids).toContain("char-kai-puppet"); // ONE body picture per character, cut into a puppet
    expect(ids.some((i) => /^char-kai-(front|side|back|three-quarter)$/.test(i))).toBe(false); // no separately generated views
    expect(ids.some((i) => /head-kai-(lookL|lookR|front)/.test(i))).toBe(false); // looks are head turns, not new pictures
    expect(ids.some((i) => i.startsWith("prop-door"))).toBe(true);
    expect(ids.some((i) => i.startsWith("prop-phone"))).toBe(true);
    expect(ids.some((i) => i.startsWith("head-kai-"))).toBe(true);
  });
  it("draws every character over the mannequin, faces from the body's head crop, backgrounds checked for intruders", () => {
    const body = manifest.assets.find((a) => a.id === "char-kai-puppet")!;
    expect(body.init).toEqual({ assetId: MANNEQUIN_INIT, denoise: 0.78 });
    expect(body.prompt).toContain("arms held away from the body");
    const heads = manifest.assets.filter((a) => a.kind === "head_variant" && a.ownerId === "kai");
    expect(heads.every((h) => h.init?.assetId === body.id && h.init.denoise <= 0.56 && h.matte === "none")).toBe(true);
    const loc = manifest.assets.find((a) => a.kind === "location")!;
    expect(loc.matte).toBe("check");
    expect(loc.negative).toMatch(/person/);
    expect(withoutBeings("crowded with machinery, gentle green light from the glowing fox")).toBe("crowded with machinery");
  });
  it("is stable: planning twice gives identical ids and hashes; changing a prompt changes only that asset's hash", () => {
    const again = planAssets(built.story, built.characters, anim);
    expect(again.assets.map((a) => [a.id, a.hash])).toEqual(manifest.assets.map((a) => [a.id, a.hash]));
    const changed = planAssets(built.story, built.characters, { ...anim, location: { ...anim.location, steps: anim.location.steps + 1 } });
    const diff = manifest.assets.filter((a, i) => a.hash !== changed.assets[i]!.hash).map((a) => a.id);
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.every((i) => i.startsWith("loc-"))).toBe(true);
  });
  it("diffManifest: everything missing at first, nothing once the hashes exist", () => {
    expect(diffManifest(manifest, new Map()).missing).toHaveLength(manifest.assets.length);
    const have = new Map(manifest.assets.map((a) => [a.id, a.hash]));
    const d = diffManifest(manifest, have);
    expect(d.missing).toHaveLength(0);
    expect(d.reused).toHaveLength(manifest.assets.length);
  });
  it("AssetCache: a put asset comes back by hash, with its metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cache-"));
    const c = new AssetCache(dir);
    const src = path.join(dir, "a.png");
    await fs.writeFile(src, "png-bytes");
    expect(c.has("h1")).toBe(false);
    await c.put("h1", src, { attempt: 2 });
    const out = path.join(dir, "out", "b.png");
    expect((await c.get("h1", out))?.meta.attempt).toBe(2);
    expect(await fs.readFile(out, "utf8")).toBe("png-bytes");
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("animation compiler", () => {
  const has = (id: string): boolean => manifest.assets.some((a) => a.id === id) || id === "kai" || id === "stranger" || id.endsWith("-soft") || id.endsWith("-lit");
  const compose = (i: number, duration = 3) => composeShot({ shot: built.story.shots[i]!, story: built.story, characters: built.characters, manifest, anim, duration, fps: 30, seed: i + 1, has });
  it("is deterministic: the same shot compiles to the same layers, events and camera", () => {
    for (let i = 0; i < built.story.shots.length; i++) expect(JSON.stringify(compose(i).spec)).toBe(JSON.stringify(compose(i).spec));
  });
  it("turns 'walk toward the building' into a character that moves, in the side view, with a camera that follows; no model-given numbers", () => {
    const walkShot = built.story.shots.findIndex((s) => s.animation?.actions.some((a) => a.action === "walk"));
    const spec = compose(walkShot).spec;
    const ch = spec.layers.find((l) => l.type === "character")!;
    const moves = spec.events.filter((e) => e.targetId === ch.id && e.type === "walk");
    expect(moves.length).toBeGreaterThan(0);
    expect(spec.events.some((e) => e.type === "view" && e.targetId === ch.id)).toBe(true);
    expect(spec.events.some((e) => e.targetId === "camera")).toBe(true);
  });
  it("a door shot gets a door layer that opens, and a door sound on the frame it starts to open", () => {
    const doorShot = built.story.shots.findIndex((s) => s.animation?.objects.some((o) => o.object === "door"));
    const spec = compose(doorShot).spec;
    const open = spec.events.find((e) => e.type === "open")!;
    expect(open).toBeTruthy();
    const cue = audioCuesFor(spec).find((c) => c.kind === "door")!;
    expect(cue.at).toBeCloseTo(open.start, 5);
  });
  it("footsteps land on foot contacts of a walking character, none when nobody walks", () => {
    const walkShot = built.story.shots.findIndex((s) => s.animation?.actions.some((a) => a.action === "walk"));
    expect(audioCuesFor(compose(walkShot, 4).spec).filter((c) => c.kind === "footsteps").length).toBeGreaterThanOrEqual(3);
    const still = built.story.shots.findIndex((s) => s.subjectIds.length === 0 && !s.animation);
    expect(audioCuesFor(compose(still).spec).filter((c) => c.kind === "footsteps")).toHaveLength(0);
  });
  it("a character without art does not crash the compiler", () => {
    const spec = composeShot({ shot: built.story.shots[1]!, story: built.story, characters: built.characters, manifest, anim, duration: 3, fps: 30, seed: 1, has: () => false }).spec;
    expect(spec.layers.some((l) => l.type === "character")).toBe(false);
  });
});

describe("matte cut-outs", () => {
  const rgba = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
    return { width: w, height: h, data };
  };
  it("keeps white, black and grey regions exactly where the matte says foreground (no colour heuristics)", () => {
    const img = rgba(40, 40, (x) => (x < 14 ? [255, 255, 255, 255] : x < 27 ? [0, 0, 0, 255] : [128, 128, 128, 255]));
    const matte = rgba(40, 40, (x, y) => (y > 4 && y < 36 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const cut = applyMatte(img, matte);
    for (const x of [5, 20, 33]) expect(cut.data[(20 * 40 + x) * 4 + 3]).toBe(255);
    expect(cut.data[(1 * 40 + 5) * 4 + 3]).toBe(0);
  });
  it("rejects an empty matte, a full-frame matte and a figure cropped by the frame", () => {
    const solid = (cover: (x: number, y: number) => boolean) => rgba(60, 100, (x, y) => [10, 10, 10, cover(x, y) ? 255 : 0]);
    expect(assessMatte(solid(() => false)).ok).toBe(false);
    expect(assessMatte(solid(() => true)).ok).toBe(false);
    expect(assessMatte(solid((x, y) => x > 18 && x < 42 && y > 8 && y < 92)).ok).toBe(true);
    expect(assessMatte(solid((x, y) => x > 18 && x < 42 && y > 8)).ok).toBe(false); // feet run off the bottom edge
  });
});

describe("spoken text", () => {
  it("spells digits out so the voice never guesses: apartment 13 -> thirteen", () => {
    expect(spokenText("Apartment 13, please.")).toBe("Apartment thirteen, please.");
    expect(spokenText("It is 2:30 and 45% done")).toBe("It is two thirty and forty-five percent done");
    expect(spokenText("Order 1042 costs 3.5")).toBe("Order one thousand forty-two costs three point five");
    expect(spokenText("No digits here")).toBe("No digits here");
  });
});

import { actionsFromText, enrichAnimation, objectsFromText } from "../src/shots/animationRules";
import type { Shot } from "@studio/shared";

describe("physical verbs from the director's sentence", () => {
  it("reads walk/turn/look and the target, ignoring 'turn the handle'", () => {
    const a = actionsFromText("Trent walks toward the building, then turns around to look up at the tower.");
    expect(a.map((x) => x.action)).toEqual(["walk", "turn", "look-up"]);
    expect(a[0]!.toward).toBe("the building");
    expect(actionsFromText("He turns the cold, damp handle toward the door.").some((x) => x.action === "turn")).toBe(false);
  });
  it("reads doors and phones as objects that move", () => {
    expect(objectsFromText("The old door creaks open by itself.")).toEqual([{ object: "door", action: "open", when: "early" }]);
    expect(objectsFromText("The door slams shut behind him.").map((o) => o.action)).toEqual(["close"]);
    expect(objectsFromText("The phone buzzes on the desk.").map((o) => o.action)).toEqual(["shake", "glow"]);
    expect(objectsFromText("A quiet empty corridor.")).toEqual([]);
  });
  it("makes the film travel: a quarter of the character shots walk, never a startled close-up, always one screen direction", () => {
    const base = built.story.shots.map((s) => ({ ...s, animation: undefined, action: "He stands there." })) as Shot[];
    const out = enrichAnimation(base);
    const walkers = out.filter((s) => s.animation?.actions.some((a) => a.action === "walk"));
    expect(walkers.length).toBeGreaterThanOrEqual(2);
    expect(walkers.every((s) => s.animation!.actions[0]!.toward === "right")).toBe(true);
    expect(walkers.every((s) => s.shotType !== "extreme-close-up")).toBe(true);
  });
  it("keeps the model's own actions first and does not duplicate a movement class", () => {
    const s = { ...built.story.shots[1]!, action: "Kai runs down the alley.", animation: { actions: [{ character: "kai", action: "walk" as const, when: "mid" as const, toward: "the door" }], objects: [] } };
    const out = enrichAnimation([s])[0]!;
    expect(out.animation!.actions.map((a) => a.action)).toEqual(["walk"]);
  });
});
