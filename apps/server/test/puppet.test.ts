import { describe, expect, it, beforeAll } from "vitest";
import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { CharacterTimeline } from "../src/anim/character";
import { mannequinPng, MANNEQUIN } from "../src/anim/mannequin";
import { buildPuppet, composePuppet, restPose, segmentFigure, type Puppet } from "../src/anim/puppet";
import { makeFlashlight } from "../src/anim/loader";
import { figureInBackground } from "../src/lib/matte";
import { slotsToAnimation } from "../src/shots/animationRules";
import type { Rgba } from "../src/lib/png";
import type { AnimationEvent, VisualLayer } from "../src/anim/types";

/** The mannequin itself, cut out (everything darker than the backdrop): a figure in exactly the pose the generator is given. */
async function mannequinCut(): Promise<Rgba> {
  const img = await loadImage(mannequinPng());
  const c = createCanvas(img.width, img.height), g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height);
  for (let i = 0; i < d.data.length; i += 4) if (d.data[i]! > 150) d.data[i + 3] = 0;
  return { width: img.width, height: img.height, data: new Uint8Array(d.data) };
}
const alphaSum = (c: Canvas, x0: number, y0: number, x1: number, y1: number): number => {
  const d = c.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0);
  let s = 0; for (let i = 3; i < d.data.length; i += 4) s += d.data[i]!; return s / 255;
};

let pup: Puppet;
beforeAll(async () => { pup = await buildPuppet("m", await mannequinCut(), { box: { x: 0, y: 0, w: MANNEQUIN.w, h: MANNEQUIN.h } }); });

describe("puppet from a figure in the mannequin pose", () => {
  it("separates arms and legs from the body and finds the joints in the right order", async () => {
    const seg = segmentFigure(await mannequinCut(), { x: 0, y: 0, w: MANNEQUIN.w, h: MANNEQUIN.h });
    expect(seg.armsSeparated).toBe(true);
    expect(seg.legsSeparated).toBe(true);
    const j = pup.joints;
    expect(j.shoulderN.y).toBeLessThan(j.elbowN.y);
    expect(j.elbowN.y).toBeLessThan(j.handN.y);
    expect(j.hipN.y).toBeLessThan(j.kneeN.y);
    expect(j.kneeN.y).toBeLessThan(j.ankleN.y);
    expect(j.handN.x).toBeLessThan(j.handF.x); // near hand on the screen left
    for (const [k, n] of Object.entries(pup.report.partPixels)) expect(n, k).toBeGreaterThan(50);
  });
  it("raising an arm moves the hand above the shoulder; a held torch follows the hand", () => {
    const rest = composePuppet((_k, w, h) => createCanvas(w, h), "a", pup, restPose());
    const up = composePuppet((_k, w, h) => createCanvas(w, h), "b", pup, { ...restPose(), shoulderN: 160, elbowN: 10 }, [{ hand: "N", image: makeFlashlight(), grip: { x: 0.2, y: 0.5 }, axis: 0, size: 0.17, opacity: 1 }]);
    expect(up.hands.N.y).toBeLessThan(rest.hands.N.y - pup.figH * 0.3);
    expect(up.hands.N.y).toBeLessThan(up.margin + pup.joints.shoulderN.y);
    // the torch is drawn around the raised hand, not where the hand was
    const r = 30;
    expect(alphaSum(up.canvas, Math.round(up.hands.N.x - r), Math.round(up.hands.N.y - r), Math.round(up.hands.N.x + r), Math.round(up.hands.N.y + r))).toBeGreaterThan(200);
  });
  it("the planted foot stays on the floor whatever the legs do (no floating, no sinking)", () => {
    const lowest = (c: Canvas): number => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height); for (let y = c.height - 1; y >= 0; y--) for (let x = 0; x < c.width; x++) if (d.data[(y * c.width + x) * 4 + 3]! > 128) return y; return -1; };
    const ys = [restPose(), { ...restPose(), hipN: 25, kneeN: 30, hipF: -25 }, { ...restPose(), hipN: -40, hipF: 40, kneeF: 70 }].map((p) => lowest(composePuppet((_k, w, h) => createCanvas(w, h), "c", pup, p).canvas));
    for (const y of ys) expect(Math.abs(y - ys[0]!)).toBeLessThan(pup.figH * 0.025);
  });
});

describe("puppet motion", () => {
  const layer: VisualLayer = { id: "m", type: "character", source: "m", x: 100, y: 1600, scale: 1, opacity: 1, zIndex: 1, height: 900 };
  const tl = (events: AnimationEvent[]): CharacterTimeline => new CharacterTimeline(layer, events, { nativeFacing: -1, variants: new Set() }, 4);
  it("walking: legs alternate, arms counter-swing the legs, the body leans forward", () => {
    const t = tl([{ targetId: "m", type: "walk", start: 0, duration: 4, params: { to: 2200, ease: "linear" } }]);
    const poses = Array.from({ length: 40 }, (_, i) => t.puppetPose(0.5 + i * 0.075));
    expect(Math.max(...poses.map((p) => p.hipN))).toBeGreaterThan(12);
    expect(Math.min(...poses.map((p) => p.hipN))).toBeLessThan(-12);
    for (const p of poses) if (Math.abs(p.hipN) > 8) expect(Math.sign(p.shoulderN)).toBe(-Math.sign(p.hipN));
    expect(poses.every((p) => p.lean > 0)).toBe(true);
    expect(new Set(poses.map((p) => Math.round(p.coat))).size).toBeGreaterThan(2); // the coat swings
  });
  it("running swings harder and leans more than walking", () => {
    const w = tl([{ targetId: "m", type: "walk", start: 0, duration: 4, params: { to: 2200, ease: "linear" } }]);
    const r = tl([{ targetId: "m", type: "run", start: 0, duration: 4, params: { to: 4600, ease: "linear" } }]);
    const amp = (x: CharacterTimeline, k: "hipN" | "shoulderF" | "lean"): number => Math.max(...Array.from({ length: 60 }, (_, i) => Math.abs(x.puppetPose(0.5 + i * 0.05)[k])));
    expect(amp(r, "hipN")).toBeGreaterThan(amp(w, "hipN") * 1.4);
    expect(amp(r, "shoulderF")).toBeGreaterThan(amp(w, "shoulderF") * 1.6);
    expect(amp(r, "lean")).toBeGreaterThan(amp(w, "lean") * 2);
  });
  it("gestures move the arm: hold, raise and aim a torch, lower it; point; react", () => {
    const t = tl([
      { targetId: "m", type: "hold", start: 0, duration: 0.01 },
      { targetId: "m", type: "raise-object", start: 1, duration: 0.4 },
      { targetId: "m", type: "lower-object", start: 2.5, duration: 0.3 },
      { targetId: "m", type: "surprise", start: 3.2, duration: 0.6 },
    ]);
    expect(t.puppetPose(0.5).shoulderN).toBeGreaterThan(10); // holding in front
    expect(t.puppetPose(2).shoulderN).toBeGreaterThan(70); // aimed forward
    expect(t.puppetPose(3).shoulderN).toBeLessThan(30); // lowered
    expect(t.puppetPose(3.35).elbowF).toBeGreaterThan(40); // arms come up in a flinch
  });
  it("the hair and the coat lag behind the body", () => {
    const t = tl([{ targetId: "m", type: "run", start: 0.2, duration: 3, params: { to: 3000 } }]);
    expect(t.puppetPose(1.5).hair).toBeLessThan(0); // blown back while running
  });
});

describe("director slots and background checks", () => {
  it("turns plain-words slots into actions and objects", () => {
    const a = slotsToAnimation({ move: "walk to the door", gesture: "raise the flashlight", reaction: "stop and listen" });
    expect(a.actions.map((x) => x.action)).toEqual(["walk", "raise-object", "listen"]);
    expect(a.actions[0]!.toward).toBe("the door");
    expect(a.objects).toContainEqual(expect.objectContaining({ object: "flashlight", action: "glow" }));
    const b = slotsToAnimation({ move: "none", gesture: "push the door open", reaction: "none" });
    expect(b.actions.map((x) => x.action)).toEqual(["push"]);
    expect(b.objects).toContainEqual(expect.objectContaining({ object: "door", action: "open" }));
  });
  it("flags an upright figure standing in a background, not architecture", () => {
    const m = (draw: (x: number, y: number) => boolean): Rgba => { const w = 200, h = 350, d = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = draw(x, y) ? 255 : 0; d.set([v, v, v, 255], (y * w + x) * 4); } return { width: w, height: h, data: d }; };
    expect(figureInBackground(m((x, y) => Math.hypot((x - 100) / 14, (y - 170) / 60) < 1))).toMatch(/figure/);
    expect(figureInBackground(m((x, y) => y > 250))).toBeNull(); // a floor
    expect(figureInBackground(m(() => false))).toBeNull();
  });
});
