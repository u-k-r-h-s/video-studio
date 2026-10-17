import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { straightLane, traffic, type VehicleKind } from "../src/anim/renderers/three3d/runtime/world/vehicles";
import { directLocation } from "../src/anim/renderers/three3d/visualPlan";

/**
 * Vehicles as actors: road-following, continuous, spaced, time-based (a pure function of t), and only where the story
 * puts them. Runs in Node (the models are procedural geometry; no canvas needed).
 */
const lanes = () => [straightLane(-75, 75, -1.4), straightLane(75, -75, -4.4)];
const run = (mix: VehicleKind[], o: Partial<Parameters<typeof traffic>[0]> = {}) => traffic({ lanes: lanes(), mix, rate: 12, duration: 12, seed: 3, night: false, wet: 0, ...o });
const sample = (tr: ReturnType<typeof traffic>, ts: number[]) => ts.map((t) => { tr.update(t); return tr.group.children.map((o) => ({ visible: o.visible, p: o.position.clone(), fwd: new THREE.Vector3(1, 0, 0).applyQuaternion(o.quaternion) })); });

describe("traffic: road-following vehicles", () => {
  const ts = Array.from({ length: 361 }, (_, i) => i / 30);
  it("moves continuously along its lane, facing the way it goes, at no more than its desired speed", () => {
    const tr = run(["car", "auto", "scooter", "bus", "bicycle", "motorcycle"]), fr = sample(tr, ts);
    let seen = 0;
    tr.vehicles.forEach((v, k) => {
      const z = v.lane === 0 ? -1.4 : -4.4, dir = v.lane === 0 ? 1 : -1;
      for (let i = 1; i < fr.length; i++) {
        const a = fr[i - 1]![k]!, b = fr[i]![k]!;
        if (!a.visible || !b.visible) continue;
        seen++;
        expect(b.p.z).toBeCloseTo(z, 5); // on the lane
        const dx = (b.p.x - a.p.x) * dir;
        expect(dx).toBeGreaterThanOrEqual(-1e-6); // never backward
        expect(dx * 30).toBeLessThan(12.5); // <= v0 (car 11 m/s), no jumps
        expect(b.fwd.x).toBeCloseTo(dir, 1); // nose along the road (a two-wheeler's lean tilts it a little)
        expect(Math.abs(b.fwd.z)).toBeLessThan(0.01);
      }
    });
    expect(seen).toBeGreaterThan(500);
  });
  it("keeps a safe gap to the vehicle ahead on the same lane (no overlaps)", () => {
    const tr = run(["car", "bus", "scooter"], { rate: 30 }), fr = sample(tr, ts);
    const len: Record<string, number> = { car: 4.2, bus: 10.5, scooter: 1.8, auto: 2.9, motorcycle: 2.1, bicycle: 1.75 };
    for (const f of fr) for (const lane of [0, 1]) {
      const on = tr.vehicles.map((v, k) => ({ v, x: f[k]!.p.x, vis: f[k]!.visible })).filter((o) => o.vis && o.v.lane === lane).sort((a, b) => a.x - b.x);
      for (let i = 1; i < on.length; i++) expect(on[i]!.x - on[i - 1]!.x).toBeGreaterThan((len[on[i]!.v.kind]! + len[on[i - 1]!.v.kind]!) / 2 + 1);
    }
  });
  it("turns its wheels by distance / radius, and a bus pulls in, stands at its stop, and leaves", () => {
    const tr = run(["bus"], { rate: 1, stop: { lane: 0, kind: "bus", s: 80, dwell: 3 } });
    const bi = tr.vehicles.findIndex((v) => v.kind === "bus");
    const fr = ts.map((t) => { tr.update(t); return { x: tr.group.children[bi]!.position.x, vis: tr.group.children[bi]!.visible }; });
    expect(fr.every((f) => f.vis)).toBe(true); // on screen-side of the lane for the whole shot
    const xs = fr.map((f) => f.x);
    const v = xs.slice(1).map((x, i) => (x - xs[i]!) * 30);
    const still = v.filter((s) => Math.abs(s) < 0.01).length;
    expect(still / 30).toBeGreaterThan(2.5); // stood at the stop for its dwell
    expect(Math.max(...v.slice(0, 30))).toBeGreaterThan(Math.max(...v.slice(150, 200))); // it arrived braking
    expect(v[v.length - 1]!).toBeGreaterThan(0.3); // and is driving off at the end
    for (let i = 1; i < v.length; i++) expect(Math.abs(v[i]! - v[i - 1]!) * 30).toBeLessThan(4); // smooth (|accel| < 4 m/s^2)
    tr.update(4); const w0 = tr.group.children[bi]!.children.find((c) => c instanceof THREE.Group)!.rotation.z, x0 = tr.group.children[bi]!.position.x;
    tr.update(1); const w1 = tr.group.children[bi]!.children.find((c) => c instanceof THREE.Group)!.rotation.z, x1 = tr.group.children[bi]!.position.x;
    expect(Math.abs(w1 - w0) * 0.5).toBeCloseTo(Math.abs(x1 - x0), 1); // angle x radius = distance
  });
  it("is a pure function of t: the same frame whichever order frames are asked in (chunks)", () => {
    const a = run(["car", "scooter"]), b = run(["car", "scooter"]);
    a.update(7.3); const pa = a.group.children.map((o) => (o.visible ? o.position.clone() : null));
    b.update(2); b.update(9); b.update(7.3); const pb = b.group.children.map((o) => (o.visible ? o.position.clone() : null));
    expect(pa.filter(Boolean).length).toBeGreaterThan(2);
    pa.forEach((p, i) => { expect(!!p).toBe(!!pb[i]); if (p) expect(p.distanceTo(pb[i]!)).toBeLessThan(1e-9); });
  });
});

describe("story-driven world: elements appear only where the story puts them", () => {
  const pal = { wall: "", door: "", trim: "", roof: "" };
  const loc = (look: string, timeOfDay: string, weather?: string) => directLocation({ id: "x", name: "x", visualIdentity: look, description: "", lighting: "", timeOfDay, weather } as never, pal);
  it("a quiet room: no sky, birds, vehicles or landscape", () => {
    const l = loc("a quiet living room inside the house", "day");
    expect(l.kit).toBe("interior");
    expect(l.world.sky).toBeUndefined(); expect(l.world.traffic).toBeUndefined(); expect(l.world.landscape).toBeUndefined();
  });
  it("a sunny river in the mountains: landscape with river and mountains, birds, clouds, the sun lighting it; no traffic", () => {
    const l = loc("a river flowing past snowy mountains, pine forest", "day", "sunny");
    expect(l).toMatchObject({ kit: "nature", lighting: "sunny-day", sunAzimuth: 30 });
    expect(l.world.landscape).toMatchObject({ relief: "mountains", water: "river", snow: true });
    expect(l.world.sky!.birds).toBeGreaterThan(0);
    expect(l.world.traffic).toBeUndefined();
  });
  it("a rainy city street at night: traffic, streetlights, wet; no birds and no sun", () => {
    const l = loc("a busy city street with traffic, shops and buildings", "night", "rain");
    expect(l).toMatchObject({ kit: "city", lighting: "rainy-night" });
    expect(l.rain).toBeGreaterThan(0.5);
    expect(l.world.traffic!.mix).toContain("car"); expect(l.world.streetlights).toBe(true);
    expect(l.world.sky!.birds).toBe(0); expect(l.sunAzimuth).toBeUndefined();
  });
  it("a road gets vehicles only when the story names them; a forest never does", () => {
    expect(loc("a dirt road between fields", "day").world.traffic).toBeUndefined();
    expect(loc("the village road at the bus stop", "morning").world.traffic).toMatchObject({ mix: expect.arrayContaining(["bus"]), stop: { kind: "bus" } });
    expect(loc("a dark forest by a lake", "night").world.traffic).toBeUndefined();
  });
});
