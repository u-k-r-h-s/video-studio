import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as THREE from "three";
import { findClips } from "./runtime/rig";

/**
 * Finds the usable character in a folder of provider-exported files (Tripo, Meshy, ...): which GLB is the character, which
 * files only carry animations, which are textures or other supporting files. It reads only the glTF JSON (no decoding, no
 * browser) and never changes a file. The runtime needs ONE self-contained GLB with a skinned mesh and at least Idle + Walk
 * clips; when the clips live in separate files, a merged GLB has to be derived first (see docs/ai-character-poc.md):
 * that is reported, never done silently.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type GltfJson = any;

/** The glTF JSON (+ binary chunk) of a .glb / .gltf file. */
export function readGltf(file: string): { json: GltfJson; bin: Buffer | null; bytes: number; format: "glb" | "gltf" } {
  const buf = fs.readFileSync(file);
  if (file.toLowerCase().endsWith(".gltf")) {
    const json = JSON.parse(buf.toString("utf8"));
    const uri = json.buffers?.[0]?.uri as string | undefined;
    const ext = uri && !uri.startsWith("data:") ? path.join(path.dirname(file), uri) : null;
    const bin = ext && fs.existsSync(ext) ? fs.readFileSync(ext) : null;
    return { json, bin, bytes: buf.length + (bin?.length ?? 0), format: "gltf" };
  }
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB file");
  let off = 12, json: GltfJson = null, bin: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8")); else if (type === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  if (!json) throw new Error("GLB without a JSON chunk");
  return { json, bin, bytes: buf.length, format: "glb" };
}

export interface FoundFile {
  file: string;
  MB: number;
  meshes: number;
  skinnedMeshes: number;
  triangles: number;
  clips: string[];
  /** The file references external .bin / images (a .gltf): the browser runtime gets one file, so it must be a self-contained GLB. */
  external: string[];
}
export interface Discovery {
  dir: string;
  /** Every file found in the folder (recursive, hidden files skipped). */
  files: number;
  character: FoundFile | null;
  /** Other character-bearing files (alternatives), animation-only files, textures, supporting and unusable files. */
  alternatives: FoundFile[];
  animations: FoundFile[];
  textures: string[];
  supporting: string[];
  unusable: string[];
  /** Idle / Walk exist only in other files: a merged GLB must be derived before the runtime can use this character. */
  needsMerge: boolean;
  notes: string[];
}

function summarize(file: string): FoundFile {
  const { json, bytes } = readGltf(file);
  let tris = 0, skinned = 0;
  const meshNodes = (json.nodes ?? []).filter((n: GltfJson) => n.mesh !== undefined);
  for (const n of meshNodes) {
    if (n.skin !== undefined) skinned++;
    for (const p of json.meshes[n.mesh].primitives) {
      const count = (i: number | undefined): number => (i === undefined ? 0 : json.accessors?.[i]?.count ?? 0);
      tris += p.indices !== undefined ? count(p.indices) / 3 : count(p.attributes.POSITION) / 3;
    }
  }
  const external = [...(json.buffers ?? []), ...(json.images ?? [])].map((b: GltfJson) => b.uri).filter((u: unknown): u is string => typeof u === "string" && !u.startsWith("data:"));
  return { file, MB: +(bytes / 1e6).toFixed(2), meshes: meshNodes.length, skinnedMeshes: skinned, triangles: Math.round(tris), clips: (json.animations ?? []).map((a: GltfJson, i: number) => a.name ?? `clip${i}`), external };
}

const roles = (clips: string[]): ReturnType<typeof findClips> => findClips(clips.map((name) => ({ name }) as THREE.AnimationClip));
const hasBase = (f: FoundFile): boolean => { const r = roles(f.clips); return !!r.idle && !!r.walk; };
const ANIM_WORDS = /(idle|walk|run|jog|wave|anim|clip|motion|action|dance|jump|pose)/i;

export function discoverCharacter(dir: string): Discovery {
  const d: Discovery = { dir, files: 0, character: null, alternatives: [], animations: [], textures: [], supporting: [], unusable: [], needsMerge: false, notes: [] };
  const files: string[] = [];
  const walk = (p: string): void => { for (const f of fs.readdirSync(p).sort()) { if (f.startsWith(".")) continue; const q = path.join(p, f); if (fs.statSync(q).isDirectory()) walk(q); else files.push(q); } };
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) walk(dir);
  d.files = files.length;
  const models: FoundFile[] = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (ext === ".glb" || ext === ".gltf") {
      try { models.push(summarize(f)); } catch (e) { d.unusable.push(`${f} (${(e as Error).message})`); }
    } else if ([".png", ".jpg", ".jpeg", ".webp", ".ktx2", ".tga", ".exr", ".hdr"].includes(ext)) d.textures.push(f);
    else if ([".bin", ".mtl", ".json", ".txt", ".md"].includes(ext)) d.supporting.push(f);
    else d.unusable.push(`${f} (${ext || "no extension"}: not glTF; export as GLB)`);
  }
  // the character: a skinned mesh; prefer one that already has Idle + Walk, then a name that says "character/model", then
  // the one with the most clips, then the biggest mesh
  const skinned = models.filter((m) => m.skinnedMeshes > 0);
  d.animations = models.filter((m) => m.meshes === 0 && m.clips.length > 0);
  const score = (m: FoundFile): number => (hasBase(m) ? 1e9 : 0) + (/(character|model|rig|base|mesh|body|courier)/i.test(path.basename(m.file)) ? 1e8 : 0) - (ANIM_WORDS.test(path.basename(m.file)) ? 1e7 : 0) + m.clips.length * 1e5 + m.triangles;
  const ranked = [...skinned].sort((a, b) => score(b) - score(a));
  d.character = ranked[0] ?? null;
  d.alternatives = ranked.slice(1);
  if (!d.character) {
    if (models.some((m) => m.meshes > 0)) d.notes.push("there are meshes but none is skinned (no skeleton): the model must be rigged before it can be animated");
    return d;
  }
  if (d.character.external.length) d.notes.push(`${path.basename(d.character.file)} references external files (${d.character.external.join(", ")}): export a self-contained .glb`);
  if (!hasBase(d.character)) {
    const others = [...d.alternatives, ...d.animations];
    const idleIn = others.find((m) => roles(m.clips).idle), walkIn = others.find((m) => roles(m.clips).walk);
    if (idleIn || walkIn) {
      d.needsMerge = true;
      d.notes.push(`${path.basename(d.character.file)} lacks ${[!roles(d.character.clips).idle && "Idle", !roles(d.character.clips).walk && "Walk"].filter(Boolean).join(" + ")}; found in: ${[...new Set([idleIn, walkIn].filter(Boolean).map((m) => path.basename(m!.file)))].join(", ")}`);
    } else d.notes.push(`no Idle / Walk clip in any file (clips: ${[...new Set(models.flatMap((m) => m.clips))].join(", ") || "none"})`);
  }
  if (d.alternatives.length) d.notes.push(`${d.alternatives.length + 1} skinned GLBs; selected ${path.basename(d.character.file)} (the others are listed as alternatives / animation sources)`);
  return d;
}

const home = (p: string): string => p.replace(/^~(?=\/|$)/, os.homedir());
const tilde = (p: string): string => p.replace(os.homedir(), "~");

/**
 * Character sources outside the library (provider exports for the AI character POC). Override a folder with
 * STUDIO_3D_SOURCE_<KEY>=<dir> (e.g. STUDIO_3D_SOURCE_TRIPO=/path/to/tripo-export).
 */
export const EXTERNAL_SOURCES: Record<string, { label: string; dir: string }> = {
  tripo: { label: "Tripo", dir: "~/Downloads/ai-courier/tripo/" },
  meshy: { label: "Meshy", dir: "~/Downloads/ai-courier/meshy/" },
};
export function sourceDir(key: string): string | null {
  const s = EXTERNAL_SOURCES[key];
  const env = process.env[`STUDIO_3D_SOURCE_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  return env ? home(env) : s ? home(s.dir) : null;
}

/** The runnable GLB of an external source, or a clear error saying what is missing. */
export function resolveSource(key: string): { file: string; discovery: Discovery } {
  const dir = sourceDir(key)!;
  const label = EXTERNAL_SOURCES[key]?.label ?? key;
  const d = discoverCharacter(dir);
  const shown = tilde(dir.endsWith("/") ? dir : `${dir}/`);
  if (!d.character) {
    const empty = d.files === 0;
    throw new Error(empty
      ? `${label} character assets not found:\n${shown}\nPlease place the generated GLB files there.`
      : `${label} assets in ${shown} contain no rigged (skinned) character GLB.\n${d.notes.join("\n")}${d.unusable.length ? `\nnot usable: ${d.unusable.map(tilde).join(", ")}` : ""}`);
  }
  if (d.needsMerge) throw new Error(`${label} character found (${tilde(d.character.file)}), but its animations are in separate files:\n${d.notes.join("\n")}\nA merged GLB has to be derived into assets/3d/characters/ai-courier/${key}/character.glb first (originals stay untouched).`);
  if (d.character.external.length) throw new Error(`${label}: ${d.notes[0]}`);
  return { file: d.character.file, discovery: d };
}
