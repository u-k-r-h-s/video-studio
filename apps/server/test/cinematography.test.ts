import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { Character, Shot } from "@studio/shared";
import { planCoverage } from "../src/anim/renderers/three3d/cinematography";
import { planVisuals } from "../src/anim/renderers/three3d/visualPlan";
import { compileShot3D } from "../src/anim/renderers/three3d/compile";
import { artStyleOf } from "../src/anim/renderers/three3d/artStyle";
import { CinematicCamera } from "../src/anim/renderers/three3d/runtime/camera";
import type { Shot3DSpec } from "../src/anim/renderers/three3d/spec";
import { storyFromPlan } from "../src/shots/director";
import { animatedShort3d } from "../src/profiles/animatedShort3d";

/** Camera Cinematography V1: scene coverage planned from the story, and the camera specs the compiler makes of it. */
let n = 0;
const shot = (o: Partial<Shot> & { say?: string }): Shot => ({
  id: `s${++n}`, sceneId: "scene-1", order: n, beat: "setup", duration: 4, shotType: "medium", emotion: "calm", action: "", visualPrompt: "", visualKey: "",
  locationId: "lane", subjectIds: ["asha", "ravi"], dialogue: o.say ? [{ characterId: o.say, text: "..." }] : [], sfx: [], characterMotion: [], transition: { type: "cut" },
  focus: { x: 0.5, y: 0.5 }, camera: {}, motion: { type: "parallax" }, ...o,
} as unknown as Shot);

// a village scene as an author writes it: the place, then an exchange of lines in mediums and close-ups
const scene = (): Shot[] => [
  shot({ shotType: "establishing", subjectIds: [], motion: { type: "pan" } as Shot["motion"] }),
  shot({ say: "asha", shotType: "medium" }),
  shot({ say: "ravi", shotType: "medium", subjectIds: ["ravi", "asha"] }),
  shot({ say: "asha", shotType: "medium" }),
  shot({ say: "asha", shotType: "medium" }),
  shot({ say: "ravi", shotType: "close-up", subjectIds: ["ravi", "asha"], motion: { type: "push-in" } as Shot["motion"] }),
  shot({ say: "asha", shotType: "close-up", motion: { type: "push-in" } as Shot["motion"] }),
  shot({ say: "ravi", shotType: "close-up", subjectIds: ["ravi", "asha"], emotion: "shock", motion: { type: "push-in" } as Shot["motion"] }),
  shot({ say: "asha", shotType: "medium" }),
  shot({ shotType: "close-up", subjectIds: ["ravi", "asha"], emotion: "sad", motion: { type: "push-in" } as Shot["motion"] }),
];

describe("scene coverage (planCoverage)", () => {
  it("covers a conversation: the place, a two-shot, shot / reverse shot over the shoulder, singles, a reaction, then back to the two-shot", () => {
    const c = planCoverage(scene()).map((x) => x.purpose);
    expect(c[0]).toBe("establishing");
    expect(c[1]).toBe("two-shot"); // the conversation starts with both in frame
    expect(c[2]).toBe("ots"); // a reply: over the listener's shoulder
    expect(c[3]).toBe("ots");
    expect(c[4]).toBe(c[3]); // the same speaker continues: the same framing, no cut-for-cut change
    expect(c.slice(5, 8)).toEqual(["single", "single", "single"]); // close lines: faces
    expect(c[8]).toBe("two-shot"); // after a run of tight shots the geography is re-established
    expect(c[9]).toBe("reaction"); // a silent sad close-up of a listener
    expect(new Set(c).size).toBeGreaterThanOrEqual(5);
  });
  it("moves follow the beat, not the shot size: close-ups hold; a push-in only on a strong turn", () => {
    const c = planCoverage(scene());
    expect(c[5]!.move).toBe("static"); expect(c[6]!.move).toBe("static"); // author close-ups with motion push-in: held
    expect(c[7]!.move).toBe("push_in"); // the shock line
    expect(c.filter((x) => x.move === "push_in").length).toBeLessThanOrEqual(2);
    // the same close-up, calm or shocked, gets a different camera
    const calm = planCoverage([shot({ say: "asha", subjectIds: ["asha"], shotType: "close-up" })])[0]!;
    const shock = planCoverage([shot({ say: "asha", subjectIds: ["asha"], shotType: "close-up", emotion: "shock" })])[0]!;
    expect(calm.move).toBe("static"); expect(shock.move).toBe("push_in");
    expect(planCoverage([shot({ say: "asha", subjectIds: ["asha"], shotType: "low-angle", emotion: "anger" })])[0]!.heightOffset).toBeLessThan(-0.4);
  });
  it("an establishing shot frames the place (the stage), a moving character is tracked, a story object gets an insert", () => {
    const c = planCoverage([
      shot({ shotType: "establishing", subjectIds: [] }),
      shot({ subjectIds: ["asha"], shotType: "medium-wide", animation: { actions: [{ character: "asha", action: "walk", when: "start" }], objects: [] } } as Partial<Shot>),
      shot({ subjectIds: ["asha"], shotType: "close-up", action: "Asha works the hand pump; water gushes into the bucket" }),
    ]);
    expect(c[0]).toMatchObject({ purpose: "establishing", target: "stage", shot: "wide" });
    expect(c[0]!.heightOffset).toBeGreaterThan(1); // raised: the place, not a face
    expect(c[1]).toMatchObject({ purpose: "tracking", move: "follow" });
    expect(c[2]).toMatchObject({ purpose: "insert", shot: "insert", target: "object", object: "pump" });
  });
  it("is deterministic and scene-local (a shot's coverage depends only on its scene so far)", () => {
    const a = planCoverage(scene()), b = planCoverage(scene());
    expect(b.map(({ reason: _r, ...x }) => x)).toEqual(a.map(({ reason: _r, ...x }) => x));
    // a new scene starts fresh: its first line is a two-shot again
    const two = planCoverage([...scene(), shot({ sceneId: "scene-2", say: "asha" })]);
    expect(two.at(-1)!.purpose).toBe("master");
  });
  it("on real story plans: no single camera dominates the way push-in did, and the old size->move rule is gone", () => {
    for (const name of ["andheri-raat-ka-ujala", "bharose-ka-parcel", "door-tak-saath"]) {
      const st = storyFromPlan(JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../scripts/lab/stories/${name}.json`), "utf8")), animatedShort3d, 200).story;
      const c = planCoverage(st.shots);
      const count = (k: string) => c.filter((x) => `${x.purpose}/${x.shot}/${x.move}` === k).length;
      const top = Math.max(...c.map((x) => count(`${x.purpose}/${x.shot}/${x.move}`)));
      expect(top / c.length, name).toBeLessThan(0.4);
      expect(new Set(c.map((x) => x.purpose)).size, name).toBeGreaterThanOrEqual(4);
      expect(c.filter((x) => x.move === "push_in").length / c.length, name).toBeLessThan(0.25);
      // the Director's close-ups all pushed in before; now a calm one is held, only a strong emotion pushes
      const calmCloseUps = st.shots.map((s, i) => [s, c[i]!] as const).filter(([s]) => s.shotType === "close-up" && ["calm", "joy", "neutral", "curious"].includes(s.emotion));
      expect(calmCloseUps.length, name).toBeGreaterThan(0);
      for (const [, x] of calmCloseUps) expect(x.move, name).not.toBe("push_in");
    }
  });
});

describe("compiled camera specs from the coverage", () => {
  const chars: Character[] = [
    { id: "asha", name: "Asha", description: "a girl", appearance: "", clothing: "", visualIdentity: "" },
    { id: "ravi", name: "Ravi", description: "a boy", appearance: "", clothing: "", visualIdentity: "" },
  ] as Character[];
  const village = { id: "lane", name: "Village lane", description: "a village lane with a hand pump", visualIdentity: "an Indian village lane, hand pump, morning", lighting: "morning sun", importantObjects: [] };
  const compile = (shots: Shot[], i: number, kit?: "village" | "neighborhood") => {
    const story = { locations: [village], shots, characters: chars } as never;
    const vp = planVisuals(story);
    const location = { ...vp.locations[0]!, ...(kit ? { kit } : {}) };
    return compileShot3D({ shot: shots[i]!, story, characters: chars, duration: 4, width: 108, height: 192, fps: 30, seed: 1, cast: () => ({ asset: "rb-girl" }),
      indexInScene: i, scene: { order: ["asha", "ravi"] }, direction: { location, shot: vp.shots[i], style: artStyleOf(vp.artStyle) } }).spec;
  };
  it("an establishing shot targets the stage; a two-shot frames both; OTS sits behind the listener looking at the speaker", () => {
    const s = scene();
    expect(compile(s, 0, "village").camera).toMatchObject({ purpose: "establishing", target: "stage", shot: "wide" });
    expect(compile(s, 1, "village").camera).toMatchObject({ purpose: "two-shot", shot: "medium", target: "asha", frameWith: "ravi" });
    const ots = compile(s, 2, "village");
    expect(ots.camera).toMatchObject({ purpose: "ots", shot: "over_shoulder", target: "asha", toward: "ravi", behind: true });
    // the shoulder toward the open front of the set: the camera stays on the audience's side of the line of action
    const a = ots.characters.find((c) => c.id === "asha")!.start, r = ots.characters.find((c) => c.id === "ravi")!.start;
    expect(ots.camera.side).toBe(Math.sign(r.x - a.x));
    expect(compile(s, 5, "village").camera).toMatchObject({ purpose: "single", shot: "closeup", target: "ravi", move: "static" });
  });
  it("a pump shot works the pump (handle, flow, bucket) and its insert looks at the spout; off the village set it falls back to a face", () => {
    const s = [shot({ subjectIds: ["asha"], shotType: "close-up", action: "Asha works the hand pump; water gushes into the bucket" })];
    const v = compile(s, 0, "village");
    expect(v.camera).toMatchObject({ shot: "insert", target: "pump-spout", move: "static" });
    expect(v.environment.interactions?.handpump).toBeTruthy();
    expect(v.characters[0]!.events[0]).toMatchObject({ action: "reach", target: "pump-handle" });
    const n2 = compile(s, 0, "neighborhood");
    expect(n2.camera).toMatchObject({ shot: "closeup", target: "asha" });
  });
  it("is deterministic: the same story compiles to the same camera specs", () => {
    const s = scene();
    for (let i = 0; i < s.length; i++) expect(compile(s, i, "village").camera).toEqual(compile(s, i, "village").camera);
  });
});

describe("camera runtime: inserts, OTS aim, fixed and keys", () => {
  const A = { position: new THREE.Vector3(0, 0, 0), heading: Math.PI / 2, height: 1.7, head: new THREE.Vector3(0, 1.6, 0) };
  const B = { position: new THREE.Vector3(1.4, 0, 0), heading: -Math.PI / 2, height: 1.7, head: new THREE.Vector3(1.4, 1.6, 0) };
  const spout = { position: new THREE.Vector3(3, 0, -2), heading: 0, height: 1.8, head: new THREE.Vector3(3, 0.96, -2) };
  const resolve = (id: string) => ({ a: A, b: B, spout } as Record<string, typeof A>)[id] ?? null;
  const run = (cam: CinematicCamera, frames = 60) => { let c!: THREE.PerspectiveCamera; for (let i = 0; i < frames; i++) c = cam.step(i / 30, i ? 1 / 30 : 1); return c; };
  const ndc = (c: THREE.PerspectiveCamera, p: THREE.Vector3) => p.clone().project(c);
  it("an insert is close to the object's own point: centred across, the point in the upper frame (what falls from it below)", () => {
    const c = run(new CinematicCamera({ shot: "insert", move: "static", target: "spout", angle: 0.5, side: 1, handheld: 0 }, 9 / 16, 2, resolve));
    expect(c.position.distanceTo(spout.head)).toBeLessThan(1.4);
    const p = ndc(c, spout.head); expect(Math.abs(p.x)).toBeLessThan(0.1); expect(p.y).toBeGreaterThan(0.1); expect(p.y).toBeLessThan(0.85);
  });
  it("over the shoulder: behind the listener, the speaker's face near the centre, the listener's head at the frame edge", () => {
    const c = run(new CinematicCamera({ shot: "over_shoulder", move: "static", target: "a", toward: "b", behind: true, side: 1, handheld: 0 }, 9 / 16, 2, resolve));
    expect(c.position.x).toBeLessThan(A.position.x); // behind the listener, away from the speaker
    const sp = ndc(c, B.head!), ls = ndc(c, A.head!);
    expect(Math.abs(sp.x)).toBeLessThan(0.3); expect(Math.abs(sp.y)).toBeLessThan(0.4);
    expect(Math.abs(ls.x)).toBeGreaterThan(Math.abs(sp.x)); // the shoulder is off to one side
  });
  it("a fixed camera is exactly where it is told, and eases to `to`", () => {
    const cam = new CinematicCamera({ shot: "wide", move: "static", target: "a", fixed: { position: [1, 2, 3], lookAt: [0, 1, 0], fov: 40, to: { position: [3, 2, 3], lookAt: [0, 1, 0] } } }, 9 / 16, 2, resolve);
    expect(cam.step(0, 1 / 30).position.toArray()).toEqual([1, 2, 3]);
    expect(cam.step(1, 1 / 30).position.x).toBeCloseTo(2, 6);
    expect(cam.step(2, 1 / 30).position.x).toBeCloseTo(3, 6);
  });
  it("keys change the framing over the shot without a jump", () => {
    const cam = new CinematicCamera({ shot: "wide", move: "static", target: "a", handheld: 0, keys: [{ at: 1, shot: "closeup", blend: 1 }] }, 9 / 16, 3, resolve);
    const d: number[] = [];
    for (let i = 0; i < 90; i++) d.push(cam.step(i / 30, i ? 1 / 30 : 1).position.distanceTo(A.head!));
    expect(d[89]!).toBeLessThan(d[0]! * 0.75);
  });
});

describe("Camera V2: smooth moves inside a shot, intentional cuts between shots", () => {
  const A = { position: new THREE.Vector3(0, 0, 0), heading: 0, height: 1.7, head: new THREE.Vector3(0, 1.6, 0) };
  const B = { position: new THREE.Vector3(1.2, 0, 0.2), heading: -Math.PI / 2, height: 1.7, head: new THREE.Vector3(1.2, 1.6, 0.2) };
  const stage = { position: new THREE.Vector3(0, 0, -3), heading: 0, height: 1.8, head: new THREE.Vector3(0, 0, -3), place: true };
  const resolve = (id: string) => ({ a: A, b: B, stage } as Record<string, typeof A>)[id] ?? null;
  type Spec = ConstructorParameters<typeof CinematicCamera>[0];
  const poses = (spec: Spec, seconds: number, fps = 30) => {
    const cam = new CinematicCamera({ handheld: 0, ...spec }, 9 / 16, seconds, resolve);
    return Array.from({ length: Math.round(seconds * fps) + 1 }, (_, i) => { const c = cam.step(i / fps, i ? 1 / fps : 1); return { P: c.position.clone(), q: c.quaternion.clone(), fov: c.fov }; });
  };
  const speeds = (ps: { P: THREE.Vector3 }[]) => ps.slice(1).map((p, i) => p.P.distanceTo(ps[i]!.P));

  it("a key is a designed move: it starts and settles at rest, arrives on time, never overshoots, and the lens eases with it", () => {
    const ps = poses({ shot: "wide", move: "static", target: "a", keys: [{ at: 1, shot: "closeup", blend: 1.5 }] }, 4);
    const v = speeds(ps), peak = Math.max(...v);
    expect(v.slice(0, 29).every((x) => x < 1e-9)).toBe(true); // holds before the key
    expect(v[30]!).toBeLessThan(peak * 0.05); // starts from rest
    expect(v[73]!).toBeLessThan(peak * 0.05); // settles at rest
    for (let i = 1; i < v.length; i++) expect(Math.abs(v[i]! - v[i - 1]!)).toBeLessThan(peak * 0.12); // no jolt
    // arrives at the key's composition when the blend ends (1 + 1.5 s) and stays: no spring tail, no overshoot
    const end = ps[75]!.P;
    for (let i = 75; i < ps.length; i++) expect(ps[i]!.P.distanceTo(end)).toBeLessThan(1e-6);
    const d = ps.map((p) => p.P.distanceTo(A.head)); for (let i = 31; i <= 75; i++) expect(d[i]!).toBeLessThanOrEqual(d[i - 1]! + 1e-9);
    const fovs = ps.map((p) => p.fov); for (let i = 1; i < fovs.length; i++) expect(Math.abs(fovs[i]! - fovs[i - 1]!)).toBeLessThan(0.6);
    expect(fovs.at(-1)!).toBeCloseTo(32, 6);
  });
  it("a move is time-based: 30 and 60 fps give the same camera at the same time", () => {
    const spec: Spec = { shot: "medium", move: "static", target: "a", frameWith: "b", keys: [{ at: 0.5, shot: "closeup", frameWith: null, target: "b", blend: 1.6 }] };
    const p30 = poses(spec, 3, 30), p60 = poses(spec, 3, 60);
    for (const t of [0.4, 0.9, 1.3, 1.8, 2.5]) expect(p30[Math.round(t * 30)]!.P.distanceTo(p60[Math.round(t * 60)]!.P)).toBeLessThan(1e-3);
  });
  it("a move arcs around what it looks at: switching sides never passes through the subject", () => {
    const ps = poses({ shot: "medium", move: "static", target: "a", angle: 0.9, side: 1, keys: [{ at: 0.2, angle: 0.9, side: -1, blend: 2 }] }, 3);
    const dEnds = Math.min(ps[0]!.P.distanceTo(A.position), ps.at(-1)!.P.distanceTo(A.position));
    for (const p of ps) expect(p.P.clone().setY(0).distanceTo(A.position)).toBeGreaterThan(dEnds * 0.8);
  });
  it("an entry move opens exactly on the previous composition (the cut is invisible) and ends on its own", () => {
    const prev = poses({ shot: "wide", move: "pull_out", target: "stage", heightOffset: 1.5, fovScale: 1.14, angle: 0.35, side: 1 }, 2.6);
    const own = poses({ shot: "medium", move: "static", target: "a", frameWith: "b" }, 4);
    const ps = poses({ shot: "medium", move: "static", target: "a", frameWith: "b", enter: { from: { shot: "wide", move: "pull_out", target: "stage", heightOffset: 1.5, fovScale: 1.14, angle: 0.35, side: 1, frameWith: null, atEnd: true }, duration: 2.4 } }, 4);
    expect(ps[0]!.P.distanceTo(prev.at(-1)!.P)).toBeLessThan(0.02); // the previous shot's last frame
    expect(ps[0]!.q.angleTo(prev.at(-1)!.q)).toBeLessThan(0.01);
    expect(ps[0]!.fov).toBeCloseTo(prev.at(-1)!.fov, 6);
    expect(ps[90]!.P.distanceTo(own[90]!.P)).toBeLessThan(1e-6); // then exactly the shot's own composition
    const v = speeds(ps), peak = Math.max(...v);
    expect(v[0]!).toBeLessThan(peak * 0.02);
    for (let i = 1; i < 72; i++) expect(Math.abs(v[i]! - v[i - 1]!)).toBeLessThan(peak * 0.12);
  });
  it("a cut starts at the shot's designed composition: no settling from somewhere else on the first frames", () => {
    for (const shot of ["wide", "medium", "closeup", "over_shoulder", "insert"] as const) {
      const ps = poses({ shot, move: "static", target: shot === "insert" ? "stage" : "a", ...(shot === "over_shoulder" ? { toward: "b", behind: true, side: 1 } : {}) }, 1);
      expect(Math.max(...speeds(ps)), shot).toBeLessThan(1e-9);
    }
  });
  it("designed moves follow their curve exactly: a pull-out ends 35 % further out, not lagging behind on a spring", () => {
    const ps = poses({ shot: "wide", move: "pull_out", target: "a", angle: 0, side: 1 }, 3);
    const flat = (p: THREE.Vector3) => Math.hypot(p.x - A.position.x, p.z - A.position.z);
    expect(flat(ps.at(-1)!.P) / flat(ps[0]!.P)).toBeCloseTo(1.35, 2);
  });
  it("a two-shot keeps its side of the pair when the subject turns around (it used to flip across them)", () => {
    const S = { position: new THREE.Vector3(0, 0, 0), heading: 0, height: 1.7, head: new THREE.Vector3(0, 1.6, 0) };
    const cam = new CinematicCamera({ shot: "medium", move: "follow", target: "s", frameWith: "b", handheld: 0 }, 9 / 16, 4, (id) => (id === "s" ? S : id === "b" ? B : null));
    let sign = 0;
    for (let i = 0; i < 120; i++) {
      S.heading = i < 60 ? 0 : Math.PI; // turns around half-way
      const c = cam.step(i / 30, i ? 1 / 30 : 1), s = Math.sign(c.position.z - 0.1);
      if (i === 0) sign = s; else expect(s).toBe(sign);
    }
  });
  it("is deterministic: the same steps give bit-identical cameras", () => {
    const spec: Spec = { shot: "wide", move: "static", target: "stage", enter: { from: { shot: "wide", move: "static", target: "stage", heightOffset: 2 }, duration: 1 }, keys: [{ at: 1.5, target: "a", shot: "medium", frameWith: "b", blend: 1 }] };
    const a = poses(spec, 3), b = poses(spec, 3);
    a.forEach((p, i) => { expect(p.P.equals(b[i]!.P)).toBe(true); expect(p.q.equals(b[i]!.q)).toBe(true); });
  });
});

describe("Camera V2: which shots move in and which cut", () => {
  const t = (c: { transition: string }[]) => c.map((x) => x.transition);
  it("dialogue: the place moves down into the two-shot; a new speaker, a close line and a reaction cut; the same speaker continues seamlessly", () => {
    const c = planCoverage(scene());
    expect(t(c).slice(0, 5)).toEqual(["cut", "move", "cut", "cut", "move"]);
    expect(c[1]!.transitionReason).toMatch(/place/);
    expect(c[2]!.transitionReason).toMatch(/new speaker/);
    expect(c[4]!.transitionReason).toMatch(/same framing/);
    expect(c[9]!.transition).toBe("cut"); // the reaction
  });
  it("action: a wide of the pump moves in closer on the hands; the insert and the shock beat cut; a new scene cuts", () => {
    const pump = (o: Partial<Shot>) => shot({ sceneId: "pump", subjectIds: ["asha"], action: "Asha works the hand pump", ...o });
    const c = planCoverage([pump({ shotType: "medium-wide" }), pump({ shotType: "medium" }), pump({ shotType: "close-up", action: "water from the pump fills the bucket" }),
      pump({ shotType: "medium", emotion: "shock" }), shot({ sceneId: "next", subjectIds: ["asha"], shotType: "medium" })]);
    expect(c.map((x) => x.purpose).slice(0, 3)).toEqual(["master", "single", "insert"]);
    expect(t(c)).toEqual(["cut", "move", "cut", "cut", "cut"]);
  });
  it("the compiler opens a moving shot on the previous camera (a pull-out at its end point) and only when that framing is on this set", () => {
    const chars = [{ id: "asha", name: "Asha" }, { id: "ravi", name: "Ravi" }] as Character[];
    const village = { id: "lane", name: "Village lane", description: "a village lane", visualIdentity: "an Indian village lane", lighting: "morning sun", importantObjects: [] };
    const s = scene(), story = { locations: [village], shots: s, characters: chars } as never, vp = planVisuals(story);
    const compile = (i: number, prevCamera?: Shot3DSpec["camera"]) => compileShot3D({ shot: s[i]!, story, characters: chars, duration: 4, width: 108, height: 192, fps: 30, seed: 1, cast: () => ({ asset: "rb-girl" }),
      indexInScene: i, scene: { order: ["asha", "ravi"] }, ...(prevCamera ? { prevCamera } : {}), direction: { location: { ...vp.locations[0]!, kit: "village" }, shot: vp.shots[i], style: artStyleOf(vp.artStyle) } }).spec.camera;
    const est = compile(0), two = compile(1, est);
    // from the place down into the scene: 3.2 s wanted, at most 75 % of this 4 s shot
    expect(two.enter).toMatchObject({ from: { target: "stage", shot: "wide", move: "pull_out", atEnd: true }, duration: 3 });
    expect(compile(2, two).enter).toBeUndefined(); // a new speaker: a cut
    // the previous camera framed someone who is not in this shot: it cannot open on it, so it cuts
    expect(compile(1, { ...est, target: "ghost" } as never).enter).toBeDefined(); // a set point it does not know is still allowed
    expect(compile(1, { ...est, target: "ravi", frameWith: "nobody-here" } as never).enter).toBeDefined();
    const onlyAsha = { ...s[1]!, subjectIds: ["asha"] };
    const st2 = { locations: [village], shots: [s[0]!, onlyAsha], characters: chars } as never, vp2 = planVisuals(st2);
    const cam2 = compileShot3D({ shot: onlyAsha, story: st2, characters: chars, duration: 4, width: 108, height: 192, fps: 30, seed: 1, cast: () => ({ asset: "rb-girl" }), indexInScene: 1, scene: { order: ["asha"] },
      prevCamera: { ...est, target: "ravi" }, direction: { location: { ...vp2.locations[0]!, kit: "village" }, shot: vp2.shots[1], style: artStyleOf(vp2.artStyle) } }).spec.camera;
    expect(cam2.enter).toBeUndefined();
  });
});
