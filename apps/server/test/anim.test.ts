import { describe, expect, it } from "vitest";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { Track, ease, envelope } from "../src/anim/ease";
import { CharacterTimeline } from "../src/anim/character";
import { AnimEngine, AssetLibrary } from "../src/anim/engine";
import { analyzeFigure, buildRig } from "../src/anim/rig";
import type { AnimShotSpec, AnimationEvent, VisualLayer } from "../src/anim/types";
import { decodePng, type Rgba } from "../src/lib/png";
import { keyGreyBackdrop } from "../src/lib/chroma";

const layer = (over: Partial<VisualLayer> = {}): VisualLayer => ({ id: "rider", type: "character", source: "rider", x: 200, y: 1500, scale: 1, opacity: 1, zIndex: 10, height: 800, ...over });
const ev = (e: Partial<AnimationEvent> & Pick<AnimationEvent, "type" | "start" | "duration">): AnimationEvent => ({ targetId: "rider", ...e });
const tl = (events: AnimationEvent[], dur = 8, variants: string[] = []) => new CharacterTimeline(layer(), events, { nativeFacing: -1, variants: new Set(variants) }, dur);

describe("tracks and easing", () => {
  it("interpolates from the value at the event start, holds before/after, and chains events", () => {
    const t = new Track(0).moveTo(1, 2, 100, "linear").moveTo(4, 1, 0, "linear");
    expect(t.at(0)).toBe(0);
    expect(t.at(1)).toBe(0);
    expect(t.at(2)).toBeCloseTo(50, 6);
    expect(t.at(3)).toBeCloseTo(100, 6);
    expect(t.at(3.9)).toBeCloseTo(100, 6);
    expect(t.at(4.5)).toBeCloseTo(50, 6);
    expect(t.at(9)).toBe(0);
  });
  it("easings are 0 at 0, 1 at 1, monotonic for the smooth ones, and outBack overshoots", () => {
    for (const k of ["linear", "in", "out", "inOut", "outBack", "outElastic"] as const) { expect(ease(k, 0)).toBeCloseTo(0, 6); expect(ease(k, 1)).toBeCloseTo(1, 6); }
    let prev = -1;
    for (let i = 0; i <= 20; i++) { const v = ease("inOut", i / 20); expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
    expect(Math.max(...Array.from({ length: 50 }, (_, i) => ease("outBack", i / 49)))).toBeGreaterThan(1.02);
    expect(envelope(0.5, 1)).toBeCloseTo(1, 6);
    expect(envelope(-1, 1)).toBe(0);
  });
});

describe("character timeline: walking is derived from distance travelled", () => {
  const walk = [ev({ type: "walk", start: 1, duration: 4, params: { to: 900 } })];
  it("moves the character from its start to the target and faces the direction of travel", () => {
    const c = tl(walk);
    expect(c.root(0).x).toBe(200);
    expect(c.root(5).x).toBeCloseTo(900, 3);
    expect(c.root(8).x).toBeCloseTo(900, 3);
    expect(c.root(5).facing).toBe(1); // walked right
    const left = tl([ev({ type: "walk", start: 0, duration: 2, params: { to: 50 } })]);
    expect(left.root(3).facing).toBe(-1);
  });
  it("swings the legs in opposition while walking, and not at all when standing", () => {
    const c = tl(walk);
    const mid = c.pose(3, "side");
    expect(Math.abs(mid.legL.rot)).toBeGreaterThan(0);
    expect(mid.legL.rot * mid.legR.rot).toBeLessThanOrEqual(0);
    const amp = Math.max(...Array.from({ length: 120 }, (_, i) => Math.abs(c.pose(2 + i / 40, "side").legL.rot)));
    expect(amp).toBeGreaterThan(10);
    expect(amp).toBeLessThan(30);
    expect(Math.abs(c.pose(0.5, "side").legL.rot)).toBeLessThan(0.01); // before the walk
    expect(Math.abs(c.pose(7.9, "side").legL.rot)).toBeLessThan(0.5); // after arriving
  });
  it("bobs the body with each step (twice per leg cycle) and lowers it at the widest stance", () => {
    const c = tl(walk);
    const bobs = Array.from({ length: 200 }, (_, i) => c.pose(1.8 + i / 100).bob);
    expect(Math.max(...bobs)).toBeGreaterThan(0.005);
    expect(Math.min(...bobs)).toBeGreaterThanOrEqual(-1e-6);
  });
  it("derives foot contacts from distance: about one per stride, spread over the walk, none while standing", () => {
    const c = tl(walk);
    const contacts = c.footContacts();
    const expected = 700 / (c.H * 0.30);
    expect(contacts.length).toBeGreaterThanOrEqual(Math.floor(expected) - 1);
    expect(contacts.length).toBeLessThanOrEqual(Math.ceil(expected) + 1);
    expect(contacts[0]!).toBeGreaterThan(1);
    expect(contacts[contacts.length - 1]!).toBeLessThanOrEqual(5.1);
    expect(tl([]).footContacts()).toEqual([]);
  });
  it("running swings further and faster than walking, with a forward lean", () => {
    const run = tl([ev({ type: "run", start: 0, duration: 2, params: { to: 900 } })]);
    const walkc = tl([ev({ type: "walk", start: 0, duration: 7, params: { to: 900 } })]);
    const maxLeg = (c: CharacterTimeline, a: number, b: number) => Math.max(...Array.from({ length: 100 }, (_, i) => Math.abs(c.pose(a + ((b - a) * i) / 100, "side").legL.rot)));
    expect(maxLeg(run, 0.5, 1.5)).toBeGreaterThan(maxLeg(walkc, 2, 5) * 1.2);
    expect(run.pose(1).lean).toBeGreaterThan(walkc.pose(3.5).lean);
    expect(run.footContacts().length).toBeGreaterThan(walkc.footContacts().length * 0.6);
  });
  it("any horizontal move walks (no foot skating), and enter/exit start/end off screen", () => {
    const c = tl([ev({ type: "move", start: 0, duration: 2, params: { to: 600 } })]);
    expect(Math.abs(c.pose(1, "side").legL.rot)).toBeGreaterThan(5);
    const e = tl([ev({ type: "enter", start: 0, duration: 2, params: { side: "left", to: 500 } }), ev({ type: "exit", start: 4, duration: 2, params: { side: "right" } })], 8);
    expect(e.root(0).x).toBeLessThan(0);
    expect(e.root(3).x).toBeCloseTo(500, 3);
    expect(e.root(7).x).toBeGreaterThan(1080);
  });
});

describe("character timeline: head, face and reactions", () => {
  const V = ["front", "lookL", "lookR", "surprised", "smile", "worried"];
  it("turning flips the facing THROUGH a squash and never vanishes", () => {
    const c = tl([ev({ type: "walk", start: 0, duration: 1, params: { to: 600 } }), ev({ type: "turn", start: 2, duration: 0.5, params: { to: "left" } })]);
    const sxs = Array.from({ length: 60 }, (_, i) => c.root(1.9 + i / 80).sx);
    expect(Math.min(...sxs.map(Math.abs))).toBeLessThan(0.3);
    expect(Math.min(...sxs.map(Math.abs))).toBeGreaterThanOrEqual(0.05);
    expect(Math.sign(c.root(1.9).sx)).toBe(-Math.sign(c.root(3).sx));
  });
  it("looking left/right cross-fades head variants (mirroring with the body) and rotates the head", () => {
    const c = tl([ev({ type: "look-left", start: 1, duration: 1 }), ev({ type: "look-right", start: 3, duration: 1 })], 6, V);
    const before = c.pose(0.5), left = c.pose(2.5), right = c.pose(4.5);
    expect(Object.keys(before.head)).toHaveLength(0);
    const sx = c.root(2.5).sx; // native art faces left, so screen-left is native lookL when not flipped
    expect(Object.keys(left.head)[0]).toBe(sx > 0 ? "lookL" : "lookR");
    expect(Object.keys(right.head)[0]).toBe(sx > 0 ? "lookR" : "lookL");
    expect(left.headRot).toBeLessThan(0);
    expect(right.headRot).toBeGreaterThan(0);
    expect(left.head[Object.keys(left.head)[0]!]).toBeGreaterThan(0.5);
  });
  it("without variant art, looks still move the head (fallback transform)", () => {
    const c = tl([ev({ type: "look-left", start: 0, duration: 1 })], 3, []);
    const p = c.pose(1.5);
    expect(Object.keys(p.head)).toHaveLength(0);
    expect(p.headRot).toBeLessThan(-3);
    expect(p.headSquashX).toBeLessThan(1);
  });
  it("surprise pops the body, hops, throws the head back, shows the surprised face, then relaxes", () => {
    const c = tl([ev({ type: "surprise", start: 1, duration: 0.8 })], 4, V);
    const t0 = c.pose(0.9), t1 = c.pose(1.1), t2 = c.pose(3.5);
    expect(t1.pop).toBeGreaterThan(t0.pop + 0.03);
    expect(t1.head["surprised"]).toBeGreaterThan(0.5);
    expect(c.pose(1.08).bob).toBeLessThan(-0.005);
    expect(t2.pop).toBeLessThan(0.01);
    expect(t2.head["surprised"] ?? 0).toBeLessThan(0.05);
  });
  it("nod oscillates the head down; shake-head swings it side to side; both return to rest", () => {
    const c = tl([ev({ type: "nod", start: 0, duration: 1, params: { count: 2 } }), ev({ type: "shake-head", start: 2, duration: 1, params: { count: 3 } })], 5);
    const dy = Array.from({ length: 60 }, (_, i) => c.pose(i / 60).headDy);
    expect(Math.max(...dy)).toBeGreaterThan(0.01);
    const rots = Array.from({ length: 80 }, (_, i) => c.pose(2 + i / 80).headRot);
    expect(Math.max(...rots)).toBeGreaterThan(3);
    expect(Math.min(...rots)).toBeLessThan(-3);
    expect(Math.abs(c.pose(4.5).headRot)).toBeLessThan(1.5);
  });
  it("fear trembles and leans back; lean tilts the torso with an envelope", () => {
    const c = tl([ev({ type: "fear", start: 0, duration: 2 }), ev({ type: "lean", start: 3, duration: 1, params: { angle: 10 } })], 6, V);
    const tr = Array.from({ length: 50 }, (_, i) => c.pose(0.5 + i / 50).trembleX);
    expect(Math.max(...tr) - Math.min(...tr)).toBeGreaterThan(0.0005);
    expect(c.pose(3.5).lean).toBeGreaterThan(7);
    expect(Math.abs(c.pose(5.5).lean)).toBeLessThan(1);
  });
  it("is deterministic and idle breathing is always present", () => {
    const a = tl([ev({ type: "walk", start: 0, duration: 2, params: { to: 500 } })]), b = tl([ev({ type: "walk", start: 0, duration: 2, params: { to: 500 } })]);
    expect(a.pose(1.234)).toEqual(b.pose(1.234));
    const idle = Array.from({ length: 60 }, (_, i) => tl([]).pose(i / 10).pop);
    expect(Math.max(...idle) - Math.min(...idle)).toBeGreaterThan(0.003);
  });
});

/** A synthetic standing figure: round head, narrow neck, wide torso, two legs with a gap. */
function figure(): Rgba {
  const w = 120, h = 400, d = new Uint8Array(w * h * 4);
  const put = (x0: number, x1: number, y0: number, y1: number, c: [number, number, number]) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d.set([...c, 255], (y * w + x) * 4); };
  put(45, 75, 10, 60, [220, 170, 140]); // head
  put(54, 66, 60, 75, [210, 160, 130]); // neck
  put(20, 100, 75, 220, [200, 40, 40]); // torso
  put(35, 58, 220, 395, [30, 30, 120]); // left leg
  put(62, 85, 220, 395, [30, 30, 120]); // right leg
  return { width: w, height: h, data: d };
}

describe("rig analysis and slicing", () => {
  it("finds the neck under the head and the crotch where the legs separate", () => {
    const a = analyzeFigure(figure());
    expect(a.neckY).toBeGreaterThanOrEqual(58);
    expect(a.neckY).toBeLessThanOrEqual(78);
    expect(a.crotchY).toBeGreaterThanOrEqual(215);
    expect(a.crotchY).toBeLessThanOrEqual(240);
    expect(a.splitX).toBeGreaterThan(55);
    expect(a.splitX).toBeLessThan(65);
    expect(a.hipLx).toBeLessThan(a.splitX);
    expect(a.hipRx).toBeGreaterThan(a.splitX);
    expect(a.headRect.y).toBeLessThanOrEqual(12);
  });
  it("builds parts that together cover the figure and keep each part to its own region", async () => {
    const rig = await buildRig("t", figure());
    const alpha = (c: Canvas, x: number, y: number) => c.getContext("2d").getImageData(x, y, 1, 1).data[3]!;
    const P = rig.pad;
    expect(P).toBeGreaterThan(10);
    expect(alpha(rig.head, 60, 30 + P)).toBe(255);
    expect(alpha(rig.head, 60, 5)).toBe(0); // the padding above the figure is empty
    expect(alpha(rig.head, 60, 300 + P)).toBe(0);
    expect(alpha(rig.torso, 60, 150 + P)).toBe(255);
    expect(alpha(rig.torso, 60, 30 + P)).toBe(0);
    expect(alpha(rig.shinL, 45, 360 + P)).toBe(255);
    expect(alpha(rig.shinL, 75, 360 + P)).toBe(0);
    expect(alpha(rig.shinR, 75, 360 + P)).toBe(255);
    expect(alpha(rig.thighL, 45, 235 + P)).toBe(255);
    expect(alpha(rig.thighL, 45, 360 + P)).toBe(0); // the shin belongs to the lower piece
    expect(rig.analysis.w).toBe(120);
  });
});

describe("grey backdrop keyer", () => {
  it("removes a grey gradient backdrop and its shadow but keeps saturated clothing and enclosed white", () => {
    const w = 60, h = 80, d = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const g = 150 + x; d.set([g, g, g, 255], (y * w + x) * 4); }
    for (let y = 20; y < 70; y++) for (let x = 20; x < 40; x++) d.set([200, 30, 30, 255], (y * w + x) * 4); // red body
    for (let y = 30; y < 40; y++) for (let x = 25; x < 35; x++) d.set([250, 250, 250, 255], (y * w + x) * 4); // white shirt panel (enclosed)
    const k = keyGreyBackdrop({ width: w, height: h, data: d }, { erode: 0, feather: 0 });
    const a = (x: number, y: number) => k.data[(y * w + x) * 4 + 3]!;
    expect(a(5, 5)).toBe(0);
    expect(a(55, 75)).toBe(0);
    expect(a(30, 60)).toBe(255);
    expect(a(30, 35)).toBe(255);
  });
});

describe("engine: compile and evaluate", () => {
  const spec = (events: AnimationEvent[], layers: VisualLayer[], extra: Partial<AnimShotSpec> = {}): AnimShotSpec => ({
    id: "s", duration: 5, width: 270, height: 480, fps: 10, layers, events, effects: [], camera: { x: 135, y: 240, zoom: 1, rotation: 0 }, ...extra,
  });
  const lib = async () => {
    const l = new AssetLibrary();
    l.addRig(await buildRig("rider", figure()));
    const c = createCanvas(40, 40);
    const bg = c.getContext("2d"); bg.fillStyle = "#ffffff"; bg.fillRect(0, 0, 40, 40);
    l.images.set("box", c);
    return l;
  };
  const rider = layer({ x: 60, y: 440, height: 200 });
  const box = (over: Partial<VisualLayer> = {}): VisualLayer => ({ id: "box", type: "prop", source: "box", x: 100, y: 300, scale: 1, opacity: 1, zIndex: 5, height: 40, ...over });

  it("camera follow tracks a walking character with smoothing, and push/pan/shake/flash behave", async () => {
    const e = new AnimEngine(spec([ev({ type: "walk", start: 0, duration: 4, params: { to: 600 } }), { start: 0.2, duration: 4.3, targetId: "camera", type: "camera", params: { mode: "follow", target: "rider", tau: 0.2 } },
      { start: 1, duration: 1, targetId: "camera", type: "camera", params: { mode: "push", zoom: 1.5 } }, { start: 3, duration: 1, targetId: "camera", type: "camera", params: { mode: "shake", amount: 20 } },
      { start: 4, duration: 1, targetId: "camera", type: "camera", params: { mode: "flash", amount: 0.8 } }], [rider]), await lib());
    expect(e.camera(0).x).toBeCloseTo(135, 1);
    expect(e.camera(2).x).toBeGreaterThan(e.camera(1).x);
    expect(e.camera(2).x).toBeLessThan(600);
    expect(e.camera(0.5).zoom).toBe(1);
    expect(e.camera(2.5).zoom).toBeCloseTo(1.5, 2);
    const shake = Array.from({ length: 40 }, (_, i) => e.camera(3 + i / 40).x - e.camera(3).x);
    expect(Math.max(...shake) - Math.min(...shake)).toBeGreaterThan(2);
    expect(e.camera(4.02).flash).toBeGreaterThan(0.3);
    expect(e.camera(4.9).flash).toBeLessThan(0.05);
  });
  it("object events: appear pops in from 0, move interpolates, fade out, door opens", async () => {
    const e = new AnimEngine(spec([
      { start: 1, duration: 0.5, targetId: "box", type: "appear" },
      { start: 2, duration: 1, targetId: "box", type: "move", params: { x: 200, y: 200 } },
      { start: 4, duration: 0.5, targetId: "box", type: "fade", params: { to: 0 } },
    ], [box()]), await lib());
    const render = (t: number) => { const c = createCanvas(270, 480); e.renderFrame(c.getContext("2d"), t); return c.getContext("2d").getImageData(0, 0, 270, 480).data; };
    const lit = (d: Uint8ClampedArray) => { let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i]! > 200 && d[i + 1]! > 200) n++; return n; };
    expect(lit(render(0.5))).toBe(0); // not yet visible
    expect(lit(render(1.6))).toBeGreaterThan(300); // appeared
    expect(lit(render(3.2))).toBeGreaterThan(300);
    expect(lit(render(4.8))).toBe(0); // faded out
  });
  it("renders a character that visibly changes pose between frames, deterministically", async () => {
    const e = new AnimEngine(spec([ev({ type: "walk", start: 0, duration: 4, params: { to: 200 } })], [rider]), await lib());
    const frame = (t: number) => { const c = createCanvas(270, 480); e.renderFrame(c.getContext("2d"), t); return Buffer.from(c.getContext("2d").getImageData(0, 0, 270, 480).data.buffer); };
    const a = frame(1.0), b = frame(1.15), a2 = frame(1.0);
    expect(a.equals(a2)).toBe(true);
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i]! - b[i]!) > 40) diff++;
    expect(diff).toBeGreaterThan(300);
  });
  it("derives sound cues from the animation (footsteps from the gait, door, explicit sfx, camera impacts)", async () => {
    const e = new AnimEngine(spec([
      ev({ type: "walk", start: 0, duration: 3, params: { to: 500 } }),
      { start: 3, duration: 0.5, targetId: "box", type: "open" },
      { start: 3.2, duration: 0.4, targetId: "box", type: "glow", params: { sfx: "ping" } },
      { start: 4, duration: 0.5, targetId: "camera", type: "camera", params: { mode: "shake", amount: 24 } },
    ], [rider, box({ door: { hinge: "left", glow: "#ffcc88" } })]), await lib());
    const cues = e.audioCues();
    expect(cues.filter((c) => c.kind === "footsteps").length).toBeGreaterThanOrEqual(3);
    expect(cues.find((c) => c.kind === "door")?.at).toBe(3);
    expect(cues.find((c) => c.kind === "ping")?.at).toBe(3.2);
    expect(cues.find((c) => c.kind === "impact")?.at).toBe(4);
    expect(cues.map((c) => c.at)).toEqual([...cues.map((c) => c.at)].sort((a, b) => a - b));
  });
  it("refuses a character without a rig and a prop without an image", async () => {
    expect(() => new AnimEngine(spec([], [layer({ source: "nobody" })]), new AssetLibrary())).toThrow(/no rig/);
    const e = new AnimEngine(spec([], [box({ source: "missing" })]), await lib());
    expect(() => e.renderFrame(createCanvas(270, 480).getContext("2d"), 0)).toThrow(/no image/);
  });
});

void decodePng;

describe("director actions -> animation events", () => {
  const act = (o: object) => ({ character: "mira", when: "mid", ...o }) as never;
  it("places actions by coarse timing inside the shot and gives each a sensible duration", async () => {
    const { compileAnimation } = await import("../src/anim/actions");
    const ev = compileAnimation({ duration: 4, width: 1080, actions: [act({ action: "walk", when: "start", to: "right" }), act({ action: "turn", when: "late", to: "left" }), act({ action: "nod", when: "end" })], objects: [{ object: "door", action: "open", when: "late" } as never] });
    expect(ev.map((e) => e.type)).toEqual(["walk", "turn", "door" === ev[2]!.targetId ? "open" : "nod", ev[3]!.type]);
    for (const e of ev) { expect(e.start).toBeGreaterThanOrEqual(0); expect(e.start + e.duration).toBeLessThanOrEqual(4.001); }
    const walk = ev.find((e) => e.type === "walk")!;
    expect(walk.params?.to).toBe(890); // "right" maps to a screen position
    expect(walk.duration).toBeGreaterThan(3); // walking fills the shot
    expect(ev.find((e) => e.type === "turn")!.params?.to).toBe("left");
    expect(ev.find((e) => e.type === "open")!.targetId).toBe("door");
    expect(ev.map((e) => e.start)).toEqual([...ev.map((e) => e.start)].sort((a, b) => a - b));
  });
  it("is deterministic and never emits an event that starts after the shot ends", async () => {
    const { compileAnimation } = await import("../src/anim/actions");
    const input = { duration: 1.2, width: 1080, actions: ["walk", "run", "react", "smile", "fear"].map((a) => act({ action: a, when: "end" })), objects: [] };
    expect(compileAnimation(input)).toEqual(compileAnimation(input));
    for (const e of compileAnimation(input)) expect(e.start).toBeLessThan(1.2);
  });
  it("compiled events animate for real: a walk event makes the character cross the screen with swinging legs", async () => {
    const { compileAnimation } = await import("../src/anim/actions");
    const events = compileAnimation({ duration: 3, width: 1080, actions: [act({ action: "walk", when: "start", to: "right" })], objects: [], ids: { mira: "rider" } });
    const c = tl(events, 3);
    expect(c.root(2.8).x).toBeGreaterThan(c.root(0.2).x + 300);
    expect(Math.max(...Array.from({ length: 60 }, (_, i) => Math.abs(c.pose(0.5 + i / 30, "side").legL.rot)))).toBeGreaterThan(8);
  });
  it("the camera follows a walker, shakes for a startle and pushes in harder when tense", async () => {
    const { cameraForActions } = await import("../src/anim/actions");
    const calm = cameraForActions({ duration: 3, tense: false, width: 1080, actions: [act({ action: "walk", when: "start" })] });
    expect(calm.some((e) => e.params?.mode === "follow")).toBe(true);
    const tense = cameraForActions({ duration: 3, tense: true, width: 1080, actions: [act({ action: "surprise", when: "mid" })] });
    expect(tense.some((e) => e.params?.mode === "shake")).toBe(true);
    expect(Number(tense.find((e) => e.params?.mode === "push")!.params!.zoom)).toBeGreaterThan(Number(calm.find((e) => e.params?.mode === "push")!.params!.zoom));
  });
});

describe("depth walking, visibility and effects", () => {
  it("walking toward the camera changes y and scale, covers ground (legs swing) and keeps the gait relative to the character size", () => {
    const c = tl([ev({ type: "walk", start: 0, duration: 3, params: { to: 200, y: 1800, scale: 1.5 } })], 4);
    expect(c.root(3).y).toBeCloseTo(1800, 3);
    expect(c.root(3).scale).toBeCloseTo(1.5, 3);
    expect(c.root(1.5).scale).toBeGreaterThan(1);
    expect(Math.max(...Array.from({ length: 60 }, (_, i) => Math.abs(c.pose(0.5 + i / 30, "side").legL.rot)))).toBeGreaterThan(8);
  });
  it("characters fade in/out and flicker like a glitch", () => {
    const c = tl([ev({ type: "fade", start: 1, duration: 1, params: { to: 0.8 } }), ev({ type: "flicker", start: 3, duration: 1, params: { rate: 12, depth: 0.6, threshold: 0 } })], 5);
    expect(c.alpha(0.5)).toBe(1);
    expect(c.alpha(2.5)).toBeCloseTo(0.8, 3);
    const during = Array.from({ length: 80 }, (_, i) => c.alpha(3 + i / 80));
    expect(Math.min(...during)).toBeLessThan(0.6);
    expect(Math.max(...during)).toBeGreaterThan(0.75);
  });
  it("every effect renders, draws something, and is a pure function of time", async () => {
    const { EffectPainter } = await import("../src/anim/effects");
    for (const type of ["rain", "fog", "dust", "snow", "smoke", "leaves", "lightFlicker", "sparks", "streaks"] as const) {
      const paint = (t: number) => { const c = createCanvas(270, 480), g = c.getContext("2d"); g.fillStyle = "#000"; g.fillRect(0, 0, 270, 480); new EffectPainter(270, 480, 3).draw(g, { type, intensity: 1, x: 135, y: 300, start: 0 }, t, (x, y) => ({ x, y })); return Buffer.from(g.getImageData(0, 0, 270, 480).data.buffer); };
      const a = paint(0.6), b = paint(0.6), later = paint(1.4);
      expect(a.equals(b)).toBe(true);
      expect(a.some((v, i) => i % 4 !== 3 && v > 8)).toBe(true);
      if (type !== "lightFlicker") expect(a.equals(later)).toBe(false); // it moves
    }
  });
});

describe("post chain and keyers", () => {
  it("builds the grade chain with fades and one overlay per caption, and no unsupported operators", async () => {
    const { animPostGraph } = await import("../src/anim/video");
    const cap = { png: "/c.png", start: 0.5, end: 1, width: 900, height: 120 };
    const g = animPostGraph(1080, 1920, 3, 30, { ffmpeg: "ffmpeg", encoder: "libx264", bitrateKbps: 1000, fadeIn: 0.3, fadeOut: 0.8, captions: [cap, cap], insert: { ...cap, centerY: 0.4 } });
    for (const part of ["eq=contrast", "colorbalance", "vignette", "noise=", "fade=t=in", "fade=t=out:st=2.2"]) expect(g.filter).toContain(part);
    expect(g.inputs.filter((a) => a === "-i")).toHaveLength(3);
    expect(g.filter).not.toMatch(/>=|<=|==/);
  });
  it("closeAlpha fills small notches; keepMainBody drops specks", async () => {
    const { closeAlpha, keepMainBody } = await import("../src/lib/chroma");
    const w = 40, h = 40, d = new Uint8Array(w * h * 4);
    for (let y = 5; y < 35; y++) for (let x = 5; x < 35; x++) d.set([10, 10, 10, 255], (y * w + x) * 4);
    for (let y = 5; y < 8; y++) for (let x = 18; x < 21; x++) d[(y * w + x) * 4 + 3] = 0; // a notch bitten out of the top edge
    d.set([200, 0, 0, 255], (2 * w + 2) * 4); // a stray speck
    const closed = closeAlpha({ width: w, height: h, data: d }, 4);
    expect(closed.data[(6 * w + 19) * 4 + 3]).toBe(255);
    const clean = keepMainBody({ width: w, height: h, data: d });
    expect(clean.data[(2 * w + 2) * 4 + 3]).toBe(0);
    expect(clean.data[(20 * w + 20) * 4 + 3]).toBe(255);
  });
});

describe("walking that looks like a person: knees, arms, views", () => {
  const walk = [ev({ type: "walk", start: 0, duration: 6, params: { to: 1500 } })];
  const samples = (c: CharacterTimeline, view: "front" | "side" | "three-quarter") => Array.from({ length: 180 }, (_, i) => c.pose(1 + i / 60, view));
  it("bends the knee only on the leg that is swinging forward, and keeps the planted leg straight", () => {
    const c = tl(walk, 8);
    for (const p of samples(c, "side")) {
      expect(p.legL.knee).toBeGreaterThanOrEqual(0);
      expect(Math.min(p.legL.knee, p.legR.knee)).toBeLessThan(1.5); // never both bent at once
    }
    expect(Math.max(...samples(c, "side").map((p) => p.legL.knee))).toBeGreaterThan(15);
    expect(Math.max(...samples(c, "side").map((p) => p.legR.knee))).toBeGreaterThan(15);
  });
  it("swings the arms opposite to the legs, only in views where the arms are separate", () => {
    const c = tl(walk, 8);
    const ps = samples(c, "three-quarter");
    expect(Math.max(...ps.map((p) => p.armL.rot))).toBeGreaterThan(5);
    for (const p of ps) expect(p.armL.rot * p.legL.rot).toBeLessThanOrEqual(1e-9); // left arm back while left leg forward
    expect(Math.max(...samples(c, "side").map((p) => Math.abs(p.armL.rot)))).toBe(0);
    expect(Math.abs(tl([], 4).pose(1).armL.rot)).toBeLessThan(0.01); // still when standing
  });
  it("walks differently from the front (mostly lifting and bobbing) than from the side (wide swing)", () => {
    const c = tl(walk, 8);
    const amp = (v: "front" | "side") => Math.max(...samples(c, v).map((p) => Math.abs(p.legL.rot)));
    expect(amp("side")).toBeGreaterThan(amp("front") * 2);
    expect(Math.max(...samples(c, "front").map((p) => p.legL.lift))).toBeGreaterThan(Math.max(...samples(c, "side").map((p) => p.legL.lift)));
  });
  it("gestures raise an arm; a startle throws both up", () => {
    const g = tl([ev({ type: "point", start: 0, duration: 1.2 }), ev({ type: "surprise", start: 3, duration: 0.8 })], 6);
    expect(g.pose(0.6, "three-quarter").armR.rot).toBeGreaterThan(50);
    expect(g.pose(3.05, "three-quarter").armL.rot).toBeGreaterThan(10);
  });
  it("cross-fades between camera views: front, then three-quarter, then side, with weights that sum to 1", () => {
    const views = { front: { nativeFacing: -1 as const, variants: new Set<string>() }, "three-quarter": { nativeFacing: -1 as const, variants: new Set<string>() }, side: { nativeFacing: -1 as const, variants: new Set<string>() } };
    const c = new CharacterTimeline(layer(), [ev({ type: "view", start: 1, duration: 0.3, params: { to: "three-quarter" } }), ev({ type: "view", start: 2, duration: 0.3, params: { to: "side" } })], { nativeFacing: -1, variants: new Set(), views }, 4);
    expect(c.viewWeights(0.5)).toEqual({ front: 1 });
    const mid = c.viewWeights(1.15);
    expect(Object.keys(mid).sort()).toEqual(["front", "three-quarter"]);
    expect(Object.values(mid).reduce((a, b) => a + (b ?? 0), 0)).toBeCloseTo(1, 6);
    expect(c.viewWeights(1.6)).toEqual({ "three-quarter": 1 });
    expect(c.viewWeights(3)).toEqual({ side: 1 });
  });
  it("a view that has no art falls back to the nearest one (no back view -> three-quarter, then front)", () => {
    const views = { front: { nativeFacing: -1 as const, variants: new Set<string>() }, "three-quarter": { nativeFacing: -1 as const, variants: new Set<string>() } };
    const c = new CharacterTimeline(layer(), [ev({ type: "view", start: 0, duration: 0.1, params: { to: "back" } })], { nativeFacing: -1, variants: new Set(), views }, 3);
    expect(c.viewWeights(2)).toEqual({ "three-quarter": 1 });
  });
});

describe("the door is built from pieces", () => {
  it("draws frame, interior, leaf and light spill; the free edge swings in toward the hinge and the interior fills with light as it opens", async () => {
    const { drawDoor } = await import("../src/anim/props");
    const leaf = createCanvas(100, 200);
    const lg = leaf.getContext("2d"); lg.fillStyle = "#7a5230"; lg.fillRect(0, 0, 100, 200);
    const shot = (open: number) => {
      const c = createCanvas(400, 500), g = c.getContext("2d");
      g.fillStyle = "#000"; g.fillRect(0, 0, 400, 500);
      drawDoor(g, { x: 200, y: 400, w: 120, h: 240, open, hinge: "left", glow: "#ffcf8a", leaf, opacity: 1, zoom: 1 });
      return g.getImageData(0, 0, 400, 500).data;
    };
    const px = (d: Uint8ClampedArray, x: number, y: number): [number, number, number] => [d[(y * 400 + x) * 4]!, d[(y * 400 + x) * 4 + 1]!, d[(y * 400 + x) * 4 + 2]!];
    const closed = shot(0), half = shot(0.5), wide = shot(1);
    expect(px(closed, 200, 300)[0]).toBeGreaterThan(80); // the leaf covers the opening
    expect(px(closed, 200, 300)[2]).toBeLessThan(80);
    expect(px(wide, 230, 300)[0]).toBeGreaterThan(120); // light fills the interior (leaf has swung away from the right half)
    expect(px(wide, 230, 300)[2]).toBeGreaterThan(px(closed, 230, 300)[2]);
    expect(px(half, 200, 420)[0]).toBeGreaterThan(px(closed, 200, 420)[0]); // light spills across the floor
    let different = 0;
    for (let i = 0; i < closed.length; i += 4) if (Math.abs(closed[i]! - half[i]!) > 20) different++;
    expect(different).toBeGreaterThan(2000);
  });
  it("drawQuad maps an image onto a slanted quadrilateral (a perspective strip fill)", async () => {
    const { drawQuad } = await import("../src/anim/props");
    const img = createCanvas(40, 40); img.getContext("2d").fillStyle = "#ff0000"; img.getContext("2d").fillRect(0, 0, 40, 40);
    const c = createCanvas(200, 200), g = c.getContext("2d");
    drawQuad(g, img, [{ x: 20, y: 40 }, { x: 160, y: 10 }, { x: 160, y: 150 }, { x: 20, y: 120 }]);
    const d = g.getImageData(0, 0, 200, 200).data;
    const lit = (x: number, y: number) => d[(y * 200 + x) * 4]! > 200;
    expect(lit(30, 80)).toBe(true);
    expect(lit(150, 80)).toBe(true);
    expect(lit(150, 5)).toBe(false); // above the slanted top edge
    expect(lit(30, 20)).toBe(false);
  });
});
