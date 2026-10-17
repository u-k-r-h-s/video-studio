// Technical inspection of character files (GLB / glTF) without a browser: geometry, materials, textures, skin, bones, clips,
// and what the EXISTING rig discovery (runtime/rig.ts findBones / findClips) makes of them. Read-only: files are never changed.
//   npx tsx scripts/lab/three3d/ai-character-poc/inspect.ts <asset-key | file | folder> [...more] [--json out.json] [--full]
//   e.g.  inspect.ts casual-man      inspect.ts tripo      inspect.ts ~/Downloads/ai-courier/meshy/
// An asset key of an external source (tripo, meshy) first shows what discovery found in its folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as THREE from "three";
import { discoverCharacter, EXTERNAL_SOURCES, readGltf, sourceDir } from "../../../../apps/server/src/anim/renderers/three3d/discover";
import { LIBRARY_DIR } from "../../../../apps/server/src/anim/renderers/three3d/library";
import { findBones, findClips } from "../../../../apps/server/src/anim/renderers/three3d/runtime/rig";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** Pixel size of an embedded PNG / JPEG / WebP image. */
function imageSize(b: Buffer): [number, number] | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) { if (b[o] !== 0xff) { o++; continue; } const m = b[o + 1]!; if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b.readUInt16BE(o + 7), b.readUInt16BE(o + 5)]; o += 2 + b.readUInt16BE(o + 2); }
  }
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") { const t = b.toString("ascii", 12, 16); if (t === "VP8X") return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)]; if (t === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff]; }
  return null;
}

/** Which side a bone name is on (any naming convention), or null. */
function sideOf(name: string): "R" | "L" | null {
  if (/right/i.test(name)) return "R";
  if (/left/i.test(name)) return "L";
  if (/^r[_.]|[_.]r(\b|$|[_.])/i.test(name) || /[a-z0-9]R$/.test(name)) return "R";
  if (/^l[_.]|[_.]l(\b|$|[_.])/i.test(name) || /[a-z0-9]L$/.test(name)) return "L";
  return null;
}

export function inspect(file: string): Record<string, unknown> {
  const t0 = performance.now();
  const { json, bin, bytes, format } = readGltf(file);
  const acc = (i: number | undefined): Json => (i === undefined ? null : json.accessors?.[i]);
  let tris = 0, verts = 0, prims = 0, skinnedMeshes = 0, morphTargets = 0;
  const morphNames = new Set<string>();
  const meshNodes = (json.nodes ?? []).filter((n: Json) => n.mesh !== undefined);
  for (const n of meshNodes) {
    const m = json.meshes[n.mesh];
    if (n.skin !== undefined) skinnedMeshes++;
    for (const t of m.extras?.targetNames ?? []) morphNames.add(t);
    for (const p of m.primitives) {
      prims++;
      const v = acc(p.attributes.POSITION)?.count ?? 0; verts += v;
      tris += p.indices !== undefined ? acc(p.indices).count / 3 : v / 3;
      morphTargets = Math.max(morphTargets, p.targets?.length ?? 0);
    }
  }
  let textureMB = 0;
  const images = (json.images ?? []).map((im: Json, i: number) => {
    let size = "?", kb = 0;
    if (im.bufferView !== undefined && bin) {
      const bv = json.bufferViews[im.bufferView]; const b = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
      const wh = imageSize(b); kb = Math.round(b.length / 1024);
      if (wh) { size = `${wh[0]}x${wh[1]}`; textureMB += (wh[0] * wh[1] * 4 * 4 / 3) / 1e6; } // RGBA8 + mipmaps, as uploaded to the GPU
    } else if (im.uri) size = `external ${im.uri.startsWith("data:") ? "data-uri" : im.uri}`;
    return `${im.name || `image${i}`}: ${size} ${im.mimeType ?? ""} ${kb} KB`.trim();
  });
  const materials = (json.materials ?? []).map((m: Json) => {
    const pbr = m.pbrMetallicRoughness ?? {};
    const maps = [pbr.baseColorTexture && "color", pbr.metallicRoughnessTexture && "metalRough", m.normalTexture && "normal", m.occlusionTexture && "ao", m.emissiveTexture && "emissive"].filter(Boolean);
    const n = (x: number | undefined, d: number): string => (x ?? d).toFixed(2);
    return `${m.name ?? "?"}: maps=${maps.join("+") || "none"} metal=${n(pbr.metallicFactor, 1)} rough=${n(pbr.roughnessFactor, 1)}${m.alphaMode && m.alphaMode !== "OPAQUE" ? ` ${m.alphaMode}` : ""}${m.extensions ? ` ext=${Object.keys(m.extensions).join(",")}` : ""}`;
  });

  // skeleton as THREE bones, so the production rig discovery runs on it unchanged
  const jointSet = new Set<number>((json.skins ?? []).flatMap((s: Json) => s.joints));
  const objs = new Map<number, THREE.Object3D>();
  (json.nodes ?? []).forEach((n: Json, i: number) => { const o = jointSet.has(i) ? new THREE.Bone() : new THREE.Object3D(); o.name = THREE.PropertyBinding.sanitizeNodeName(n.name ?? `node${i}`); if (n.translation) o.position.fromArray(n.translation); if (n.rotation) o.quaternion.fromArray(n.rotation); if (n.scale) o.scale.fromArray(n.scale); objs.set(i, o); });
  const root = new THREE.Group();
  (json.nodes ?? []).forEach((n: Json, i: number) => { for (const c of n.children ?? []) objs.get(i)!.add(objs.get(c)!); });
  for (const o of objs.values()) if (!o.parent) root.add(o);
  const bones = findBones(root);
  const boneNames = [...jointSet].map((i) => objs.get(i)!.name);
  // toes: the bone under the foot (any naming), else a toe/ball bone on that side
  const toe = (s: "R" | "L"): string | null => {
    const foot = s === "R" ? bones.footR : bones.footL;
    const child = foot?.children.find((c) => (c as THREE.Bone).isBone);
    return child?.name ?? boneNames.find((n) => /(toe|ball)/i.test(n) && !/end$/i.test(n) && sideOf(n) === s) ?? null;
  };
  const fingers = boneNames.filter((n) => /(thumb|index|middle|ring|pinky|little|finger)/i.test(n));
  const face = boneNames.filter((n) => /(jaw|eye|brow|lid|lip|mouth|cheek|tongue|teeth)/i.test(n));
  const yn = (b: { name: string } | null | undefined | string): string => (b ? `found (${typeof b === "string" ? b : b.name})` : "MISSING");
  const rig = {
    hips: yn(bones.hips), spine: yn(bones.spine), chest: yn(bones.chest), neck: yn(bones.neck), head: yn(bones.head),
    leftUpperArm: yn(bones.upperArmL), leftLowerArm: yn(bones.lowerArmL), leftHand: yn(bones.handL),
    rightUpperArm: yn(bones.upperArmR), rightLowerArm: yn(bones.lowerArmR), rightHand: yn(bones.handR),
    leftUpperLeg: yn(bones.upperLegL), leftLowerLeg: yn(bones.lowerLegL), leftFoot: yn(bones.footL), leftToe: yn(toe("L")),
    rightUpperLeg: yn(bones.upperLegR), rightLowerLeg: yn(bones.lowerLegR), rightFoot: yn(bones.footR), rightToe: yn(toe("R")),
  };

  const clips = (json.animations ?? []).map((a: Json, i: number) => {
    let dur = 0;
    for (const s of a.samplers) dur = Math.max(dur, acc(s.input)?.max?.[0] ?? 0);
    const targets = new Set(a.channels.map((c: Json) => c.target.node));
    return `${a.name ?? `clip${i}`}: ${dur.toFixed(2)} s, ${targets.size} bones`;
  });
  const roles = findClips((json.animations ?? []).map((a: Json, i: number) => ({ name: a.name ?? `clip${i}` }) as THREE.AnimationClip));
  const needed = ["idle", "walk"].filter((r) => !roles[r as keyof typeof roles]);
  return {
    file: file.replace(os.homedir(), "~"), format: format === "glb" ? "GLB (binary glTF 2.0)" : "glTF 2.0 (JSON)", MB: +(bytes / 1e6).toFixed(2), parseMs: Math.round(performance.now() - t0),
    generator: json.asset?.generator ?? "", extensionsUsed: json.extensionsUsed ?? [],
    geometry: { meshes: meshNodes.length, primitives: prims, triangles: Math.round(tris), vertices: verts },
    materials: { count: materials.length, list: materials },
    textures: { count: (json.textures ?? []).length, images: images.length, gpuMB: +textureMB.toFixed(1), list: images },
    skinning: { skinnedMeshes, skeletons: json.skins?.length ?? 0, bones: jointSet.size },
    rig,
    rigUsable: Object.entries(rig).filter(([k, v]) => v === "MISSING" && !/Toe$/.test(k)).length === 0 ? "yes: every role the runtime uses was found" : `NO: missing ${Object.entries(rig).filter(([k, v]) => v === "MISSING" && !/Toe$/.test(k)).map(([k]) => k).join(", ")}`,
    fingers: fingers.length ? `${fingers.length} bones (${fingers.slice(0, 4).join(", ")}${fingers.length > 4 ? ", ..." : ""})` : "none",
    faceBones: face.length ? face : "none",
    morphTargets: morphTargets ? { perMesh: morphTargets, names: [...morphNames].slice(0, 30) } : "none",
    animation: { count: clips.length, clips, roles: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v!.name])), runtimeNeeds: needed.length ? `MISSING ${needed.join(" + ")}` : "ok (Idle + Walk)" },
  };
}

const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
const inputs = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--json");
const out: Record<string, unknown>[] = [];
let failed = false;
for (const input of inputs) {
  let target = input.replace(/^~(?=\/|$)/, os.homedir());
  if (!fs.existsSync(target)) {
    // an asset key: library model or external source folder
    const src = sourceDir(input), lib = path.join(LIBRARY_DIR, input);
    if (fs.existsSync(lib)) target = lib;
    else if (src) {
      const d = discoverCharacter(src);
      console.log(`== ${input}: ${src.replace(os.homedir(), "~")} (${d.files} files)`);
      if (!d.files) { console.log(`   ${EXTERNAL_SOURCES[input]?.label ?? input} character assets not found:\n   ${src.replace(os.homedir(), "~")}\n   Please place the generated GLB files there.`); failed = true; continue; }
      const b = (f: string): string => path.relative(src, f);
      console.log(JSON.stringify({ character: d.character && b(d.character.file), alternatives: d.alternatives.map((m) => `${b(m.file)} [${m.clips.join(", ") || "no clips"}]`), animationOnly: d.animations.map((m) => `${b(m.file)} [${m.clips.join(", ")}]`), textures: d.textures.map(b), supporting: d.supporting.map(b), unusable: d.unusable, needsMerge: d.needsMerge, notes: d.notes }, null, 1));
      target = src;
    } else { console.log(`!! ${input}: no such file, folder or asset key`); failed = true; continue; }
  }
  const files: string[] = [];
  const walk = (p: string): void => { if (fs.statSync(p).isDirectory()) { for (const f of fs.readdirSync(p).sort()) if (!f.startsWith(".")) walk(path.join(p, f)); } else files.push(p); };
  walk(target);
  for (const f of files) {
    if (!/\.(glb|gltf)$/i.test(f)) { console.log(`-- ${f.replace(os.homedir(), "~")} (${(fs.statSync(f).size / 1e6).toFixed(2)} MB, not glTF)`); continue; }
    try { const r = inspect(f); out.push(r); console.log(`== ${r.file}`); console.log(JSON.stringify(r, null, 1)); }
    catch (e) { console.log(`!! ${f}: ${(e as Error).message}`); failed = true; }
  }
}
if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify(out, null, 1)}\n`);
if (failed) process.exitCode = 1;
