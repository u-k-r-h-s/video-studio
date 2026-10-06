import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Character, Shot } from "@studio/shared";
import { compileShot3D, kitFor, lightingFor } from "../src/anim/renderers/three3d/compile";
import { DEFAULT_CHROME, Three3DRenderer } from "../src/anim/renderers/three3d";
import { characterFile, castFor } from "../src/anim/renderers/three3d/library";
import { CinematicCamera } from "../src/anim/renderers/three3d/runtime/camera";
import { Character3D } from "../src/anim/renderers/three3d/runtime/character";
import { LocomotionStateMachine } from "../src/anim/renderers/three3d/runtime/locomotion";
import { makeProp } from "../src/anim/renderers/three3d/runtime/props";
import { findBones, findClips } from "../src/anim/renderers/three3d/runtime/rig";
import type { CharacterSpec3D } from "../src/anim/renderers/three3d/spec";

const GLB = characterFile("casual-man");
const haveGlb = fs.existsSync(GLB);
const load = async (): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> => {
  const b = fs.readFileSync(GLB);
  return new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "") as never;
};
const world = (named: Record<string, THREE.Vector3> = {}) => ({ resolve: (t: unknown) => (typeof t === "string" ? named[t]?.clone() ?? null : new THREE.Vector3((t as { x: number }).x, (t as { y?: number }).y ?? 0, (t as { z: number }).z)) });
const run = (c: Character3D, seconds: number, from = 0): void => { for (let i = Math.round(from * 30); i <= Math.round(seconds * 30); i++) c.update(i / 30, i ? 1 / 30 : 0); };

describe("locomotion state machine", () => {
  it("goes IDLE -> WALK -> RUN -> STOP -> IDLE with cross-fades, never snapping", () => {
    const m = new LocomotionStateMachine({ walkSpeed: 1.3, runSpeed: 3.5 });
    const speeds = [...Array(20).fill(0), ...Array(40).fill(1.3), ...Array(40).fill(3.5), ...Array(40).fill(0)];
    const ws = speeds.map((s, i) => m.step(i / 30, 1 / 30, s));
    expect(m.history.map((h) => h.to)).toEqual(["walk", "run", "stop", "idle"]);
    for (let i = 1; i < ws.length; i++) for (const k of ["idle", "walk", "run"] as const) expect(Math.abs(ws[i]![k] - ws[i - 1]![k])).toBeLessThan(0.2); // blended over several frames
    expect(ws[59]!.walk).toBeGreaterThan(0.9);
    expect(ws[99]!.run).toBeGreaterThan(0.9);
    expect(ws[139]!.idle).toBeGreaterThan(0.9);
  });
});

describe.skipIf(!haveGlb)("3D character (GLB in Node, no browser)", () => {
  let gltf: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => { gltf = await load(); });
  it("loads the GLB: skinned mesh, skeleton, and the clips the actions need", () => {
    let skinned = 0; gltf.scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned++; });
    expect(skinned).toBeGreaterThan(0);
    const bones = findBones(gltf.scene);
    for (const r of ["hips", "spine", "neck", "head", "upperArmR", "lowerArmR", "handR", "upperLegL", "footL"] as const) expect(bones[r], r).toBeTruthy();
    const clips = findClips(gltf.animations);
    for (const r of ["idle", "walk", "run", "wave", "interact", "react"] as const) expect(clips[r], r).toBeTruthy();
  });
  const spec = (events: CharacterSpec3D["events"], props: CharacterSpec3D["props"] = []): CharacterSpec3D => ({ id: "a", asset: "casual-man", start: { x: 0, z: 0, heading: 0 }, props, events });
  it("walks to a target and stops there, facing the way it walked; the feet do not slide (clip speed is calibrated)", async () => {
    const c = new Character3D(spec([{ at: 0.2, action: "walk", target: { x: 3, z: 0 } }]), await load(), world());
    expect(c.walkSpeed).toBeGreaterThan(0.8); expect(c.walkSpeed).toBeLessThan(2.2);
    run(c, 5);
    expect(c.root.position.distanceTo(new THREE.Vector3(3, 0, 0))).toBeLessThan(0.08);
    expect(Math.abs(c.currentHeading - Math.PI / 2)).toBeLessThan(0.1); // turned to +x, the way it walked
    expect(c.loco.history.map((h) => h.to)).toEqual(["walk", "stop", "idle"]);
    expect(c.cues.filter((q) => q.kind === "footsteps").length).toBeGreaterThanOrEqual(3);
  });
  it("runs faster than it walks, and turns toward a named target (a real rotation, no extra picture)", async () => {
    const c = new Character3D(spec([{ at: 0, action: "run", target: { x: 0, z: 8 } }, { at: 3.6, action: "turn", target: "door" }]), await load(), world({ door: new THREE.Vector3(-5, 0, 8) }));
    run(c, 1.5);
    expect(c.currentSpeed).toBeGreaterThan(c.walkSpeed * 1.3);
    run(c, 5, 1.5 + 1 / 30);
    expect(Math.abs(c.currentHeading - -Math.PI / 2)).toBeLessThan(0.12);
  });
  it("holds a prop in the hand and the prop follows the hand when the arm is raised and aimed", async () => {
    const target = new THREE.Vector3(0, 1.6, 6);
    const c = new Character3D(spec([{ at: 0, action: "hold", prop: "f" }, { at: 0.5, action: "raise", prop: "f", target: { x: 0, y: 1.6, z: 6 } }], [{ id: "f", kind: "flashlight", socket: "rightHand" }]), await load(), world());
    run(c, 0.3);
    const hand = c.bones.handR!.getWorldPosition(new THREE.Vector3());
    expect(c.props[0]!.object.position.distanceTo(hand)).toBeLessThan(0.15);
    const low = hand.y;
    run(c, 1.6, 0.3 + 1 / 30);
    const hand2 = c.bones.handR!.getWorldPosition(new THREE.Vector3()), fore = hand2.clone().sub(c.bones.lowerArmR!.getWorldPosition(new THREE.Vector3())).normalize();
    expect(hand2.y).toBeGreaterThan(low + 0.15); // raised
    expect(fore.dot(target.clone().sub(hand2).normalize())).toBeGreaterThan(0.9); // aimed at the target
    expect(c.props[0]!.object.position.distanceTo(hand2)).toBeLessThan(0.15); // still in the hand
    expect(c.props[0]!.on).toBeGreaterThan(0.9); // a torch switches on when raised
  });
  it("one model, several characters: props/bags attach to any socket; unknown clips fail loudly", async () => {
    const bag = makeProp({ id: "b", kind: "bag", socket: "back" });
    expect(bag.object.children.length).toBeGreaterThan(1);
    const g = await load();
    expect(() => new Character3D(spec([]), { scene: g.scene, animations: g.animations.filter((a) => !/walk/i.test(a.name)) }, world())).toThrow(/Walk clip/);
  });
  it("acting: a hand action waits until the walk has ended and the body has settled (walk -> slow -> settle -> act)", async () => {
    const c = new Character3D(spec([{ at: 0, action: "walk", target: { x: 0, z: 3 } }, { at: 0.5, action: "reach", target: "door", duration: 0.8 }]), await load(), world({ door: new THREE.Vector3(0.2, 1.2, 3.6) }));
    let arrived = -1, reached = -1;
    for (let i = 0; i <= 150; i++) {
      const t = i / 30; c.update(t, i ? 1 / 30 : 0);
      if (arrived < 0 && c.loco.state !== "walk" && t > 0.5) arrived = t;
      if (reached < 0 && c.bones.handR!.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(0.2, 1.2, 3.6)) < 0.25) reached = t;
    }
    expect(arrived).toBeGreaterThan(0.5);
    expect(reached).toBeGreaterThan(arrived + 0.3); // not while still walking; a beat after stopping
  });
  it("IK: a raised torch bends the elbow (not a straight rod) and points at the target", async () => {
    const target = new THREE.Vector3(1.5, 1.4, 5);
    const c = new Character3D(spec([{ at: 0, action: "hold", prop: "f" }, { at: 0.2, action: "raise", prop: "f", target: { x: 1.5, y: 1.4, z: 5 } }], [{ id: "f", kind: "flashlight", socket: "rightHand" }]), await load(), world());
    run(c, 1.6);
    const S = c.bones.upperArmR!.getWorldPosition(new THREE.Vector3()), E = c.bones.lowerArmR!.getWorldPosition(new THREE.Vector3()), H = c.bones.handR!.getWorldPosition(new THREE.Vector3());
    const elbowAngle = E.clone().sub(S).normalize().angleTo(H.clone().sub(E).normalize());
    expect(elbowAngle).toBeGreaterThan(0.12); // bent
    const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(c.props[0]!.object.quaternion);
    expect(axis.dot(target.clone().sub(c.props[0]!.object.position).normalize())).toBeGreaterThan(0.9); // the torch points at it
  });
  it("presentation: faceted low-poly meshes are smoothed and materials get a per-kind response", async () => {
    const c = new Character3D(spec([]), await load(), world());
    expect(c.presentation.smoothed).toBeGreaterThan(0);
    expect(c.presentation.materials["Skin"]).toBe("skin");
    expect(c.presentation.materials["Hair"]).toBe("hair");
  });
  it("gestures play skeletal layers over the locomotion (wave / push / react change the arm pose)", async () => {
    const pose = async (events: CharacterSpec3D["events"]): Promise<THREE.Vector3[]> => { const c = new Character3D(spec(events), await load(), world({ door: new THREE.Vector3(0, 1.1, 1) })); run(c, 1.0); return [c.bones.handR!, c.bones.handL!].map((b) => b.getWorldPosition(new THREE.Vector3())); };
    const moved = (a: THREE.Vector3[], b: THREE.Vector3[]): number => Math.max(a[0]!.distanceTo(b[0]!), a[1]!.distanceTo(b[1]!));
    const idle = await pose([]), wave = await pose([{ at: 0.2, action: "wave", duration: 1.5 }]), push = await pose([{ at: 0.4, action: "push", target: "door", duration: 1.2 }]);
    expect(moved(wave, idle)).toBeGreaterThan(0.2);
    expect(moved(push, idle)).toBeGreaterThan(0.1);
  });
});

describe("cinematic camera", () => {
  const subj = { position: new THREE.Vector3(0, 0, 0), heading: 0, height: 1.8 };
  it("frames by shot size, pushes in over the shot, and moves smoothly (no jumps)", () => {
    const dist = (shot: "wide" | "medium" | "closeup", move: "static" | "push_in"): number[] => {
      const cam = new CinematicCamera({ shot, move, target: "a", handheld: 0 }, 9 / 16, 4, () => subj);
      return Array.from({ length: 120 }, (_, i) => cam.step(i / 30, i ? 1 / 30 : 1).position.distanceTo(new THREE.Vector3(0, 1.4, 0)));
    };
    const w = dist("wide", "static"), m = dist("medium", "static"), c = dist("closeup", "static"), p = dist("medium", "push_in");
    expect(w[0]!).toBeGreaterThan(m[0]!); expect(m[0]!).toBeGreaterThan(c[0]!);
    expect(p[119]!).toBeLessThan(p[0]! * 0.85);
    for (let i = 1; i < p.length; i++) expect(Math.abs(p[i]! - p[i - 1]!)).toBeLessThan(0.08);
  });
  it("follows a moving subject with a lag but keeps it in frame", () => {
    const s = { position: new THREE.Vector3(0, 0, 0), heading: 0, height: 1.8 };
    const cam = new CinematicCamera({ shot: "wide", move: "follow", target: "a", handheld: 0 }, 9 / 16, 4, () => s);
    for (let i = 0; i < 120; i++) { s.position.z = i * 0.05; const c = cam.step(i / 30, i ? 1 / 30 : 1); const ndc = s.position.clone().setY(1.2).project(c); expect(Math.abs(ndc.x)).toBeLessThan(0.9); expect(Math.abs(ndc.y)).toBeLessThan(0.95); }
  });
});

describe("3D compiler: the Director's shot -> a 3D shot", () => {
  const rider: Character = { id: "rider", name: "Sam", description: "a delivery rider", appearance: "a young man", clothing: "orange courier jacket and dark trousers", visualIdentity: "" };
  const loc = { id: "w", name: "Warehouse", description: "abandoned warehouse at night", visualIdentity: "abandoned warehouse at night, rain", lighting: "cold moonlight", importantObjects: [] };
  const shot = { id: "shot-01", sceneId: "s", order: 1, beat: "setup", duration: 5, shotType: "tracking", emotion: "tense", action: "", visualPrompt: "", visualKey: "", locationId: "w", subjectIds: ["rider"], dialogue: [], sfx: [], characterMotion: [], transition: { type: "cut" }, focus: { x: 0.5, y: 0.5 }, camera: {}, motion: { type: "tracking" },
    animation: { actions: [{ character: "rider", action: "walk", when: "start", toward: "the warehouse door" }, { character: "rider", action: "raise-object", when: "late", toward: "the door" }, { character: "rider", action: "push", when: "end" }], objects: [{ object: "flashlight", action: "glow", when: "late" }] } } as unknown as Shot;
  it("turns semantic actions into timed 3D events, a hand prop, a door that opens, a follow camera and a lighting preset", () => {
    const { spec } = compileShot3D({ shot, story: { locations: [loc] }, characters: [rider], duration: 5, width: 1080, height: 1920, fps: 30, seed: 1, cast: (c) => castFor(c, ["casual-man"]) });
    const c = spec.characters[0]!;
    expect(c.events.find((e) => e.action === "walk")?.target).toBe("door-front");
    expect(c.events.filter((e) => e.action === "raise")).toHaveLength(1);
    expect(c.props!.map((p) => [p.kind, p.socket])).toEqual(expect.arrayContaining([["flashlight", "rightHand"], ["bag", "back"]]));
    expect(spec.environment.objects.find((o) => o.kind === "door")!.events!.some((e) => e.action === "open")).toBe(true);
    expect(spec.camera).toMatchObject({ shot: "wide", target: "rider" });
    expect(["follow", "tracking"]).toContain(spec.camera.move);
    expect(spec.lighting).toBe("rainy-night");
    expect(c.wardrobe).toMatchObject({ LightBrown: "#e0641c", LightBlue: "#22252b" }); // jacket and trousers from the costume words
    expect(JSON.stringify(compileShot3D({ shot, story: { locations: [loc] }, characters: [rider], duration: 5, width: 1080, height: 1920, fps: 30, seed: 1, cast: (x) => castFor(x, ["casual-man"]) }).spec)).toBe(JSON.stringify(spec)); // deterministic
    expect(JSON.stringify(spec)).not.toMatch(/quaternion|rotation"\s*:\s*\[/); // no bone angles anywhere in the shot data
  });
  it("picks lighting presets from the place", () => {
    expect(lightingFor({ visualIdentity: "a sunny park", lighting: "bright midday", description: "" })).toBe("sunny-day");
    expect(lightingFor({ visualIdentity: "old factory hall", lighting: "night", description: "industrial warehouse" })).toBe("cinematic-night");
    expect(lightingFor({ visualIdentity: "cozy kitchen at night", lighting: "warm lamp light", description: "interior" })).toBe("warm-interior");
    expect(lightingFor({ visualIdentity: "cozy kitchen", lighting: "window light", description: "interior" })).toBe("indoor-daylight");
    // the Director's timeOfDay/weather win over the words: a dark-sounding place can still be a sunny day
    const place = { visualIdentity: "abandoned warehouse", lighting: "harsh light", description: "industrial" };
    expect(lightingFor({ ...place, timeOfDay: "day", weather: "sunny" })).toBe("sunny-day");
    expect(lightingFor({ ...place, timeOfDay: "golden_hour" })).toBe("golden-hour");
    expect(lightingFor({ ...place, timeOfDay: "sunset" })).toBe("sunset");
    expect(lightingFor({ ...place, timeOfDay: "day", weather: "cloudy" })).toBe("cloudy-day");
    expect(lightingFor({ ...place, timeOfDay: "day", weather: "overcast" })).toBe("overcast");
    expect(lightingFor({ ...place, timeOfDay: "day", weather: "rain" })).toBe("rainy-day");
    expect(lightingFor({ ...place, timeOfDay: "night", weather: "rain" })).toBe("rainy-night");
    expect(kitFor({ name: "Maple Street", visualIdentity: "suburban houses", description: "" })).toBe("neighborhood");
    expect(kitFor({ name: "Bay 13", visualIdentity: "industrial warehouse", description: "" })).toBe("warehouse-exterior");
  });
});

const haveChrome = Three3DRenderer.available(process.env.CHROME_PATH ?? DEFAULT_CHROME) && haveGlb && process.platform === "darwin";
describe.skipIf(!haveChrome)("Three.js renderer (headless Chrome, WebGL)", () => {
  const r = new Three3DRenderer({ characterFile, chrome: process.env.CHROME_PATH });
  afterAll(async () => { await r.close(); });
  it("initialises, loads the GLB in the browser, renders frames in order, and reports transitions and cues", async () => {
    const spec = {
      id: "t", duration: 1.2, width: 180, height: 320, fps: 15, seed: 1, lighting: "night" as const,
      environment: { kind: "warehouse-exterior" as const, objects: [{ id: "door", kind: "door" as const, x: 0, z: -6, events: [{ at: 0.3, action: "open" as const }] }] },
      characters: [{ id: "a", asset: "casual-man", start: { x: 0, z: -1, heading: Math.PI }, props: [{ id: "f", kind: "flashlight" as const, socket: "rightHand" as const }], events: [{ at: 0, action: "walk" as const, target: "door-front" }, { at: 0.4, action: "raise" as const, prop: "f", target: "doorway" }] }],
      camera: { shot: "wide" as const, move: "follow" as const, target: "a", behind: true },
    };
    const res = await r.stills(spec, [0, 8, 17]);
    expect([...res.frames.keys()]).toEqual([0, 8, 17]);
    for (const png of res.frames.values()) { expect(png.subarray(1, 4).toString()).toBe("PNG"); expect(png.length).toBeGreaterThan(2000); }
    expect(res.frames.get(0)!.equals(res.frames.get(17)!)).toBe(false); // something moved
    const ch = (res.info.characters as { transitions: string[] }[])[0]!;
    expect(ch.transitions.some((x) => x.includes("idle->walk"))).toBe(true);
    expect(res.cues.some((q) => q.kind === "door")).toBe(true);
  }, 60_000);
  it("renders a clip through the shared FFmpeg post chain", async () => {
    const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((f) => fs.existsSync(f));
    if (!ffmpeg) return;
    const out = path.join(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "r3d-")), "clip.mp4");
    const res = await r.render({ id: "c", duration: 0.6, width: 180, height: 320, fps: 15, seed: 2, lighting: "day", environment: { kind: "warehouse-exterior", objects: [{ id: "door", kind: "door", x: 0, z: -6 }] }, characters: [{ id: "a", asset: "casual-man", start: { x: 0, z: -2 }, events: [{ at: 0, action: "wave" }] }], camera: { shot: "medium", move: "static", target: "a" } }, out, { ffmpeg, encoder: "libx264", bitrateKbps: 1000 });
    expect(res.frames).toBe(9);
    expect(fs.statSync(out).size).toBeGreaterThan(1000);
  }, 60_000);
});
