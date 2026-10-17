import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { Shot } from "@studio/shared";
import { Damp } from "../src/anim/renderers/three3d/runtime/motion";
import { loopSeam, seamlessLoop } from "../src/anim/renderers/three3d/runtime/rig";
import { LocomotionStateMachine } from "../src/anim/renderers/three3d/runtime/locomotion";
import { Character3D } from "../src/anim/renderers/three3d/runtime/character";
import { loadGlbNode } from "../src/anim/renderers/three3d/nodeGlb";
import { characterFile } from "../src/anim/renderers/three3d/library";
import { compileShot3D, endPositions } from "../src/anim/renderers/three3d/compile";
import { planVisuals } from "../src/anim/renderers/three3d/visualPlan";
import { artStyleOf } from "../src/anim/renderers/three3d/artStyle";
import { storyFromPlan } from "../src/shots/director";
import { animatedShort3d } from "../src/profiles/animatedShort3d";
import type { CharacterSpec3D } from "../src/anim/renderers/three3d/spec";

/**
 * Motion regression tests. Each one pins a root cause of jitter found in the rendered film (door-tak-saath-3d.mp4) by the
 * motion trace (scripts/lab/three3d/motion/trace.ts): it fails on the old code and passes on the fix.
 */
const deg = (r: number): number => (r * 180) / Math.PI;

describe("loop seams (gesture clips that were not loops snapped the body at every wrap)", () => {
  // a clip whose last pose is 90 degrees from its first: a trimmed performance, like the Rocketbox talking clips
  const clip = new THREE.AnimationClip("talk", 2, [new THREE.QuaternionKeyframeTrack("arm.quaternion", [0, 1, 2], [
    ...new THREE.Quaternion().toArray(), ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.8).toArray(), ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2).toArray(),
  ])]);
  it("measures the seam and makes a seamless cycle of the same motion", () => {
    expect(loopSeam(clip)).toBeGreaterThan(80);
    const loop = seamlessLoop(clip, 0.5);
    expect(loop.duration).toBeCloseTo(1.5, 5);
    expect(loopSeam(loop)).toBeLessThan(0.05); // float32 keys
    // played through the wrap, no frame-to-frame step is larger than the clip's own motion
    const o = new THREE.Object3D(); o.name = "arm";
    const m = new THREE.AnimationMixer(o); m.clipAction(loop).play();
    m.update(0);
    let prev = o.quaternion.clone(), worst = 0;
    for (let i = 1; i < 120; i++) { m.update(1 / 30); worst = Math.max(worst, deg(o.quaternion.angleTo(prev))); prev = o.quaternion.clone(); }
    expect(worst).toBeLessThan(8); // the raw clip jumps 90 degrees at its wrap
  });
});

describe("damped procedural inputs (a look target or an acceleration that steps must not step the bones)", () => {
  it("follows a step with zero initial velocity, no overshoot, and settles", () => {
    const d = new Damp(0, 0.25);
    d.step(0, 0);
    const xs = Array.from({ length: 30 }, () => d.step(1, 1 / 30));
    expect(xs[0]!).toBeLessThan(0.08); // the first frame barely moves
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]!);
    expect(Math.max(...xs)).toBeLessThanOrEqual(1);
    expect(xs[22]!).toBeGreaterThan(0.95);
  });
});

describe("locomotion blend follows the body's speed (the feet keep up when starting and stopping)", () => {
  it("below cruise: walk share x clip rate x clip speed = the body's speed", () => {
    const m = new LocomotionStateMachine({ walkSpeed: 1.0, runSpeed: 2.5 });
    let w = m.step(0, 0, 0);
    for (let i = 1; i < 60; i++) w = m.step(i / 30, 1 / 30, 0.3);
    expect(w.walk).toBeGreaterThan(0.55); expect(w.walk).toBeLessThan(0.65); // 0.3 / (0.5 x 1.0)
    expect(w.walk * w.walkRate * 1.0).toBeCloseTo(0.3, 1);
  });
});

const RB = characterFile("rb-young-man");
describe.skipIf(!fs.existsSync(RB))("Rocketbox character: walk -> stop -> turn -> speak, transform continuity", () => {
  const world = (named: Record<string, THREE.Vector3> = {}) => ({ resolve: (t: unknown) => (typeof t === "string" ? named[t]?.clone() ?? null : new THREE.Vector3((t as { x: number }).x, 0, (t as { z: number }).z)) });
  const speech = [{ at: 5.2, duration: 6, fps: 30, env: Array(180).fill(0.6), visemes: [{ t: 0, v: "aa" as const }] }];
  const spec = (events: CharacterSpec3D["events"]): CharacterSpec3D => ({ id: "arjun", asset: "rb-young-man", start: { x: 0, z: 0, heading: 0 }, events, speech });
  const ROLES = ["hips", "spine", "chest", "neck", "head", "upperArmL", "upperArmR", "handL", "handR"] as const;
  /** Per-frame transform record of a run. */
  const run = async (events: CharacterSpec3D["events"], seconds: number, named?: Record<string, THREE.Vector3>) => {
    const c = new Character3D(spec(events), await loadGlbNode(RB), world(named));
    const frames: { root: THREE.Vector3; heading: number; q: Record<string, THREE.Quaternion>; fl: THREE.Vector3; fr: THREE.Vector3; speed: number }[] = [];
    for (let i = 0; i < seconds * 30; i++) {
      c.update(i / 30, i ? 1 / 30 : 0);
      const q: Record<string, THREE.Quaternion> = {};
      // bone rotations relative to the character's root: the root's own turn is measured separately (a deliberate turn)
      const inv = c.root.getWorldQuaternion(new THREE.Quaternion()).invert();
      for (const r of ROLES) q[r] = inv.clone().multiply(c.bones[r]!.getWorldQuaternion(new THREE.Quaternion()));
      frames.push({ root: c.root.position.clone(), heading: c.currentHeading, q, fl: c.bones.footL!.getWorldPosition(new THREE.Vector3()), fr: c.bones.footR!.getWorldPosition(new THREE.Vector3()), speed: c.currentSpeed });
    }
    return { c, frames };
  };
  /** Snaps per bone: a frame-to-frame rotation over 4 degrees AND over 3x what the frames around it do (a walk's own arm
   *  swing is fast but steady; a snap stands out from its neighbours). Same criterion as the motion trace tool. */
  const snaps = (frames: Awaited<ReturnType<typeof run>>["frames"]): Record<string, string[]> => Object.fromEntries(ROLES.map((r) => {
    const v = frames.map((f, i) => (i ? deg(f.q[r]!.angleTo(frames[i - 1]!.q[r]!)) : 0));
    const out: string[] = [];
    for (let i = 3; i < v.length - 2; i++) {
      const nb = [v[i - 2]!, v[i - 1]!, v[i + 1]!, v[i + 2]!].sort((a, b) => a - b), base = (nb[1]! + nb[2]!) / 2;
      if (v[i]! > 4 && v[i]! > 3 * base + 2) out.push(`${(i / 30).toFixed(2)}s ${v[i]!.toFixed(1)} deg`);
    }
    return [r, out];
  }));

  it("walks to a point behind it, stops, turns to someone and talks for 6 s: no bone ever snaps", async () => {
    // the target is behind: it must turn first (no walking backward), arrive, then face the listener and speak past the
    // talking clip's old wrap point (5.16 s for this character: the clip used to snap the arms 25-53 degrees there)
    const { frames } = await run([{ at: 0.2, action: "walk", target: { x: 0.5, z: -3 } }, { at: 4.5, action: "turn", target: "friend" }, { at: 4.6, action: "look", target: "friend", duration: 7 }], 12, { friend: new THREE.Vector3(3, 1.6, -3) });
    const sn = snaps(frames);
    for (const r of ROLES) expect(sn[r], r).toEqual([]);
    // the body turns at a human rate (<= 4 rad/s) and the rate itself changes smoothly (no turn that starts at full speed)
    const turn = frames.slice(1).map((f, i) => Math.atan2(Math.sin(f.heading - frames[i]!.heading), Math.cos(f.heading - frames[i]!.heading)) * 30);
    expect(Math.max(...turn.map(Math.abs))).toBeLessThan(4.05);
    for (let i = 2; i < turn.length; i++) expect(Math.abs(turn[i]! - turn[i - 1]!)).toBeLessThan(1.2);
    // never moves more than ~20 degrees off the way it faces (no moonwalk / crab walk), except the last half metre
    for (let i = 1; i < frames.length; i++) {
      const d = frames[i]!.root.clone().sub(frames[i - 1]!.root); const step = d.length();
      if (step < 0.004 || frames[i]!.root.distanceTo(new THREE.Vector3(0.5, 0, -3)) < 0.5) continue;
      const fwd = new THREE.Vector3(Math.sin(frames[i]!.heading), 0, Math.cos(frames[i]!.heading));
      expect(deg(Math.acos(Math.min(1, d.normalize().dot(fwd))))).toBeLessThan(25);
    }
    expect(frames[frames.length - 1]!.root.distanceTo(new THREE.Vector3(0.5, 0, -3))).toBeLessThan(0.1); // arrived exactly
  });

  it("a look that switches to a new target crosses over smoothly (it used to drop to neutral in one frame)", async () => {
    const named = { a: new THREE.Vector3(-3, 1.6, 2), b: new THREE.Vector3(3, 1.6, 2) };
    const { frames } = await run([{ at: 0, action: "look", target: "a", duration: 4 }, { at: 2, action: "look", target: "b", duration: 3 }], 4, named);
    const head = frames.slice(1).map((f, i) => deg(f.q.head!.angleTo(frames[i]!.q.head!)));
    expect(Math.max(...head)).toBeLessThan(10); // the old code dropped the head ~56 degrees to neutral in one frame
    expect(head.filter((x) => x > 1).length).toBeGreaterThan(8); // a crossing of ~110 degrees takes many frames
  });

  it("the planted foot holds while walking at cruise (the walk is aligned with the way the clip really travels)", async () => {
    const { c, frames } = await run([{ at: 0, action: "walk", target: { x: 0, z: 40 } }], 8);
    const lowL = Math.min(...frames.map((f) => f.fl.y)), lowR = Math.min(...frames.map((f) => f.fr.y)), slips: number[] = [];
    for (let i = 120; i < frames.length; i++) {
      const f = frames[i]!, p = frames[i - 1]!, sp: number[] = [];
      if (f.fl.y - lowL < 0.02) sp.push(Math.hypot(f.fl.x - p.fl.x, f.fl.z - p.fl.z) * 30);
      if (f.fr.y - lowR < 0.02) sp.push(Math.hypot(f.fr.x - p.fr.x, f.fr.z - p.fr.z) * 30);
      if (sp.length) slips.push(Math.min(...sp));
    }
    slips.sort((a, b) => a - b);
    expect(c.currentSpeed).toBeCloseTo(c.walkSpeed, 1);
    expect(slips[slips.length >> 1]!).toBeLessThan(0.15); // was 0.32 m/s: the clip travels 16 degrees off the toe axis
  });
});

describe("scene blocking and cuts (a cut must not move anyone)", () => {
  const plan = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../scripts/lab/stories/validate-sunny-market.json"), "utf8"));
  it("two consecutive shots of one scene with different speakers keep every character where the last shot left them", () => {
    const r = storyFromPlan(plan, animatedShort3d, 15), st = r.story, vp = planVisuals(st), style = artStyleOf(vp.artStyle);
    const ids = r.characters.slice(0, 2).map((c) => c.id) as [string, string];
    const shot = (lead: string, other: string, k: number): Shot => ({ ...st.shots[0]!, id: `s${k}`, subjectIds: [lead, other], animation: { actions: [], objects: [] }, dialogue: [] });
    const compile = (s: Shot, carry?: ReturnType<typeof endPositions>) => compileShot3D({ shot: s, story: st, characters: r.characters, duration: 3, width: 108, height: 192, fps: 30, seed: 1, cast: () => ({ asset: "casual-man" }), direction: { location: vp.locations[0]!, shot: vp.shots[0], style }, scene: { order: ids, before: ids, ...(carry ? { carry } : {}) } }).spec;
    const a = compile(shot(ids[0], ids[1], 1));
    const b = compile(shot(ids[1], ids[0], 2), endPositions(a)); // the speaker changes at the cut
    const endA = endPositions(a);
    for (const id of ids) {
      const pa = endA[id]!, pb = b.characters.find((c) => c.id === id)!.start;
      expect(Math.hypot(pa.x - pb.x, pa.z - pb.z), id).toBeLessThan(0.01);
      expect(Math.abs(pa.heading - Number(pb.heading)), id).toBeLessThan(0.01);
    }
    // and the marks hold whoever speaks: without a walk, nobody moves at all between the two shots
    const still = (lead: string, other: string): Shot => ({ ...shot(lead, other, 3), shotType: "medium", beat: "setup", emotion: "calm" });
    const c1 = compile(still(ids[0], ids[1])), c2 = compile(still(ids[1], ids[0]));
    for (const id of ids) { const p1 = c1.characters.find((c) => c.id === id)!.start, p2 = c2.characters.find((c) => c.id === id)!.start; expect(Math.hypot(p1.x - p2.x, p1.z - p2.z), id).toBeLessThan(0.01); }
  });
});
