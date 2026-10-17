import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverCharacter, resolveSource } from "../src/anim/renderers/three3d/discover";
import { castFor, characterFile } from "../src/anim/renderers/three3d/library";

// Minimal GLB headers (JSON chunk only) shaped like provider exports: just enough structure for discovery, which reads the
// glTF JSON and nothing else. Test fixtures in a temp folder, not character assets.
function glb(file: string, o: { skinned?: boolean; mesh?: boolean; clips?: string[] }): void {
  const json: Record<string, unknown> = {
    asset: { version: "2.0" },
    accessors: [{ count: 300 }, { count: 600 }],
    nodes: [...(o.mesh || o.skinned ? [{ name: "Body", mesh: 0, ...(o.skinned ? { skin: 0 } : {}) }] : []), { name: "Hips" }],
    meshes: o.mesh || o.skinned ? [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }] : [],
    animations: (o.clips ?? []).map((name) => ({ name, channels: [], samplers: [] })),
  };
  let text = JSON.stringify(json);
  while (text.length % 4) text += " ";
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + text.length, 8);
  head.writeUInt32LE(text.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([head, Buffer.from(text)]));
}

const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "discover3d-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); delete process.env.STUDIO_3D_SOURCE_TRIPO; });

describe("3D asset discovery (provider export folders)", () => {
  it("a missing or empty folder fails with a clear message and never falls back to another character", () => {
    process.env.STUDIO_3D_SOURCE_TRIPO = path.join(tmp(), "nothing-here");
    expect(() => resolveSource("tripo")).toThrow(/Tripo character assets not found:\n.*nothing-here\/\nPlease place the generated GLB files there\./);
    expect(() => characterFile("tripo")).toThrow(/Tripo character assets not found/);
    process.env.STUDIO_3D_SOURCE_TRIPO = tmp();
    expect(() => resolveSource("tripo")).toThrow(/not found/);
  });

  it("one rigged GLB with its clips: that is the character; textures and other formats are classified", () => {
    const d = tmp();
    glb(path.join(d, "courier_rigged.glb"), { skinned: true, clips: ["Idle", "Walking", "Running"] });
    fs.writeFileSync(path.join(d, "texture_basecolor.png"), "x");
    fs.writeFileSync(path.join(d, "courier.fbx"), "x");
    const r = discoverCharacter(d);
    expect(path.basename(r.character!.file)).toBe("courier_rigged.glb");
    expect(r.character!.triangles).toBe(200);
    expect(r.needsMerge).toBe(false);
    expect(r.textures).toHaveLength(1);
    expect(r.unusable[0]).toMatch(/courier\.fbx.*not glTF/);
    process.env.STUDIO_3D_SOURCE_TRIPO = d;
    expect(characterFile("tripo")).toBe(path.join(d, "courier_rigged.glb"));
  });

  it("one GLB per animation (each with the mesh): picks the obvious character file and reports that a merge is needed", () => {
    const d = tmp();
    glb(path.join(d, "Character_output.glb"), { skinned: true });
    glb(path.join(d, "Animation_Walking_withSkin.glb"), { skinned: true, clips: ["Armature|walking|baselayer"] });
    glb(path.join(d, "Animation_Idle_withSkin.glb"), { skinned: true, clips: ["Armature|Idle|baselayer"] });
    const r = discoverCharacter(d);
    expect(path.basename(r.character!.file)).toBe("Character_output.glb");
    expect(r.alternatives).toHaveLength(2);
    expect(r.needsMerge).toBe(true);
    process.env.STUDIO_3D_SOURCE_TRIPO = d;
    expect(() => resolveSource("tripo")).toThrow(/animations are in separate files[\s\S]*assets\/3d\/characters\/ai-courier\/tripo\/character\.glb/);
  });

  it("animation-only GLBs (no mesh) are animation sources, not characters", () => {
    const d = tmp();
    glb(path.join(d, "model.glb"), { skinned: true, clips: ["Idle"] });
    glb(path.join(d, "anims/walk.glb"), { clips: ["Walk"] });
    const r = discoverCharacter(d);
    expect(path.basename(r.character!.file)).toBe("model.glb");
    expect(r.animations.map((a) => path.basename(a.file))).toEqual(["walk.glb"]);
    expect(r.needsMerge).toBe(true);
  });

  it("a mesh without a skeleton is reported as needing a rig", () => {
    const d = tmp();
    glb(path.join(d, "static.glb"), { mesh: true });
    process.env.STUDIO_3D_SOURCE_TRIPO = d;
    expect(() => resolveSource("tripo")).toThrow(/no rigged \(skinned\) character GLB[\s\S]*must be rigged/);
  });

  it("--asset=<key> (STUDIO_3D_ASSET) casts every character with that asset; without it casting is unchanged", () => {
    const c = { id: "r", name: "Rider", appearance: "young delivery rider", clothing: "orange jacket and blue jeans", description: "a courier" } as Parameters<typeof castFor>[0];
    expect(castFor(c, ["casual-man", "test-character"], undefined).asset).toBe("casual-man");
    expect(castFor(c, ["casual-man", "test-character"], "tripo").asset).toBe("tripo");
  });

  it("library characters resolve exactly as before", () => {
    expect(characterFile("casual-man")).toMatch(/assets\/3d\/characters\/casual-man\/character\.glb$/);
  });
});
