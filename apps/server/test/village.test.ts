import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { BUCKET_LITRES, handleAngle, litres, pumpFlow, pumpHandle, tapFlow } from "../src/anim/renderers/three3d/runtime/world/interactions";
import { auditAssets, loadAssetRegistry, resolveAsset } from "../src/anim/renderers/three3d/assets";
import { Animal3D } from "../src/anim/renderers/three3d/runtime/animal";
import { loadGlbNode } from "../src/anim/renderers/three3d/nodeGlb";

/** V5: village interactions, the asset registry and timeline-driven animals. */
describe("hand pump and tap: pure functions of t", () => {
  const pump = { from: 1, to: 6, rate: 0.9 };
  it("the handle is at rest outside the pumping window and strokes inside it, smoothly", () => {
    expect(pumpHandle(pump, 0.5)).toBe(0);
    expect(pumpHandle(pump, 7)).toBe(0);
    const xs = Array.from({ length: 300 }, (_, i) => handleAngle(pumpHandle(pump, i / 30)));
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.5); // a full stroke (0.6 rad)
    for (let i = 1; i < xs.length; i++) expect(Math.abs(xs[i]! - xs[i - 1]!)).toBeLessThan(0.1); // no jumps
  });
  it("water flows only on the down-stroke, never before pumping starts, and the bucket never empties or overflows", () => {
    expect(pumpFlow(pump, 0.9)).toBe(0);
    let prev = 0, flowed = 0;
    for (let i = 0; i <= 330; i++) {
      const t = i / 30, f = pumpFlow(pump, t), l = litres((x) => pumpFlow(pump, x), pump.from, t);
      expect(f).toBeGreaterThanOrEqual(0);
      if (f > 0) { flowed++; expect(pumpHandle(pump, t - 0.18)).toBeLessThan(0); }
      expect(l).toBeGreaterThanOrEqual(prev - 1e-9); expect(l).toBeLessThanOrEqual(BUCKET_LITRES);
      prev = l;
    }
    expect(flowed).toBeGreaterThan(30); expect(prev).toBeGreaterThan(0.5);
  });
  it("any frame is the same whether reached directly or after others (no carried state)", () => {
    const a = litres((x) => pumpFlow(pump, x), pump.from, 4.2);
    litres((x) => pumpFlow(pump, x), pump.from, 2); // unrelated evaluation in between
    expect(litres((x) => pumpFlow(pump, x), pump.from, 4.2)).toBe(a);
  });
  it("the tap opens and closes with eased flow; the level stops rising once it is closed", () => {
    const tap = { open: 1, close: 3 };
    expect(tapFlow(tap, 0.9)).toBe(0); expect(tapFlow(tap, 2)).toBeGreaterThan(0.1); expect(tapFlow(tap, 3.5)).toBe(0);
    const l = (t: number) => litres((x) => tapFlow(tap, x), tap.open, t);
    expect(l(4)).toBeCloseTo(l(5), 9); expect(l(4)).toBeGreaterThan(l(2));
  });
});

describe("asset registry", () => {
  it("every registered asset has a source and a licence; registered files exist with their recorded size", () => {
    const problems = auditAssets();
    // files are git-ignored downloads: on a fresh clone they may be missing, which must be reported, not thrown
    for (const p of problems) expect(p).toMatch(/file missing|differs/);
    for (const [id, e] of Object.entries(loadAssetRegistry())) { expect(e.licence, id).toBeTruthy(); expect(e.source, id).toBeTruthy(); }
  });
  it("an unknown id or a missing file resolves to a diagnostic, never an exception", () => {
    expect(resolveAsset("no-such-asset")).toMatchObject({ ok: false, file: null, problem: expect.stringContaining("unknown") });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
    const reg = { ghost: { category: "animal" as const, file: "missing/ghost.glb", source: "test", licence: "CC0" } };
    expect(resolveAsset("ghost", reg, dir)).toMatchObject({ ok: false, file: null, problem: expect.stringContaining("file missing") });
    expect(resolveAsset("handpump")).toMatchObject({ ok: true, file: null }); // procedural
  });
});

const DOG = resolveAsset("dog-shiba");
describe.skipIf(!DOG.file)("timeline-driven animal (dog)", () => {
  const spec = { id: "dog", asset: "dog-shiba", path: [{ at: 0, x: 0, z: 0 }, { at: 1, x: 0, z: 0 }, { at: 4, x: 3, z: 1 }, { at: 6, x: 3, z: 1 }], face: [{ at: 5, x: 0, z: 5 }], actions: [{ at: 4.5, duration: 1, clip: "eat" }] };
  const make = async () => new Animal3D(spec, await loadGlbNode(DOG.file!), DOG.entry!.clips!, DOG.entry!.height!);
  const pose = (a: Animal3D) => { const out: number[] = [...a.root.position.toArray(), a.root.rotation.y]; a.root.traverse((o) => { if ((o as THREE.Bone).isBone) out.push(...o.quaternion.toArray()); }); return out; };
  it("is a pure function of t: the same pose in any evaluation order", async () => {
    const a = await make(), b = await make();
    a.update(3.3); const pa = pose(a);
    b.update(5.1); b.update(0.2); b.update(3.3); const pb = pose(b);
    pa.forEach((v, i) => expect(v).toBeCloseTo(pb[i]!, 9));
  });
  it("moves continuously along its path, starting and stopping without a jolt, facing where it goes", async () => {
    const a = await make(); let prev: THREE.Vector3 | null = null, prevYaw = 0;
    for (let i = 0; i <= 180; i++) {
      const t = i / 30; a.update(t); const p = a.root.position.clone();
      // <= 2.1 m/s between frames: a walk, never a jump
      if (prev) { expect(p.distanceTo(prev)).toBeLessThan(0.07); expect(Math.abs(Math.atan2(Math.sin(a.root.rotation.y - prevYaw), Math.cos(a.root.rotation.y - prevYaw)))).toBeLessThan(0.15); }
      prev = p; prevYaw = a.root.rotation.y;
    }
    a.update(2.5); expect(Math.cos(a.root.rotation.y - Math.atan2(3, 1))).toBeGreaterThan(0.95); // heading = travel direction
    a.update(6); expect(a.root.position.distanceTo(new THREE.Vector3(3, 0, 1))).toBeLessThan(1e-6);
  });
  it("its walk cycle advances with the distance travelled (paws planted), not with time", async () => {
    const a = await make();
    expect(a.stride.walk).toBeGreaterThan(0.05); expect(a.stride.walk).toBeLessThan(1.2);
  });
});
