/** Prints the procedural terms of one character around a time: npx tsx probe.ts <compiled.json> <id> <t> [window] */
import fs from "node:fs";
import * as THREE from "three";
import { Character3D } from "../../../../apps/server/src/anim/renderers/three3d/runtime/character";
import { characterFile } from "../../../../apps/server/src/anim/renderers/three3d/library";
import type { Shot3DSpec } from "../../../../apps/server/src/anim/renderers/three3d/spec";
import { loadGlbNode } from "./glb";
const [file, id, at, win = "0.2"] = process.argv.slice(2) as [string, string, string, string?];
const spec = JSON.parse(fs.readFileSync(file, "utf8")).spec as Shot3DSpec;
const chars = new Map<string, Character3D>();
const world = { resolve: (t: unknown) => (typeof t !== "string" ? new THREE.Vector3((t as { x: number }).x, (t as { y?: number }).y ?? 0, (t as { z: number }).z) : t === "camera" ? new THREE.Vector3(0, 1.5, 6) : chars.get(t)?.headPosition() ?? null) };
for (const cs of spec.characters) chars.set(cs.id, new Character3D(cs, await loadGlbNode(characterFile(cs.asset)), world as never));
console.log("events:", JSON.stringify(spec.characters.find((c) => c.id === id)!.events));
const T = Number(at), W = Number(win);
let prev: Record<string, number> = {};
for (let i = 0; i < Math.round(spec.duration * spec.fps); i++) {
  const t = i / spec.fps;
  for (const c of chars.values()) c.update(t, i ? 1 / spec.fps : 0);
  if (Math.abs(t - T) > W) { prev = { ...chars.get(id)!.terms }; continue; }
  const cur = chars.get(id)!.terms;
  const changed = Object.entries(cur).filter(([k, v]) => Math.abs(v - (prev[k] ?? 0)) > 0.02).map(([k, v]) => `${k}=${v.toFixed(3)}(${(v - (prev[k] ?? 0) >= 0 ? "+" : "")}${(v - (prev[k] ?? 0)).toFixed(3)})`);
  console.log(t.toFixed(3), changed.join(" "));
  prev = { ...cur };
}
