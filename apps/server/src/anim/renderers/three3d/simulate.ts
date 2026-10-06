import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Character3D } from "./runtime/character";
import type { Cue3D, Shot3DSpec } from "./spec";

/**
 * Runs a 3D shot's characters headless in Node (no browser, no drawing) to get the sounds the animation implies, so the
 * soundtrack can be mixed BEFORE the shots are rendered: footsteps land on the simulated foot contacts, the door sound on the
 * frame the door starts to move. The browser runs the same code, so the timing matches the picture.
 */
const cache = new Map<string, Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }>>();
async function loadNode(file: string): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  let p = cache.get(file);
  if (!p) {
    const b = fs.readFileSync(file);
    p = new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "") as unknown as Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }>;
    cache.set(file, p);
  }
  const g = await p;
  const { clone } = await import("three/examples/jsm/utils/SkeletonUtils.js");
  return { scene: clone(g.scene), animations: g.animations };
}

export async function simulateCues(spec: Shot3DSpec, characterFile: (asset: string) => string): Promise<Cue3D[]> {
  const cues: Cue3D[] = [];
  const named: Record<string, THREE.Vector3> = {};
  const door = spec.environment.objects.find((o) => o.kind === "door");
  if (door) {
    named["door"] = new THREE.Vector3(door.x + 0.4, 1.1, door.z + 0.15);
    named["door-front"] = new THREE.Vector3(door.x + 0.35, 0, door.z + 0.75);
    named["doorway"] = named["inside"] = new THREE.Vector3(door.x, 1.5, door.z - 2);
    for (const e of door.events ?? []) if (e.action === "open" && e.at >= 0) cues.push({ kind: "door", at: e.at, volume: 0.7 });
  }
  const camera = new THREE.Vector3(0, 1.5, 6);
  const chars: Character3D[] = [];
  for (const c of spec.characters) {
    try {
      chars.push(new Character3D(c, await loadNode(characterFile(c.asset)), { resolve: (t) => (typeof t === "string" ? (t === "camera" ? camera.clone() : named[t]?.clone() ?? null) : new THREE.Vector3(t.x, t.y ?? 0, t.z)) }));
    } catch { /* a model Node cannot parse (embedded textures): no footsteps for it, the render still works */ }
  }
  const frames = Math.round(spec.duration * spec.fps);
  for (let i = 0; i < frames; i++) for (const c of chars) c.update(i / spec.fps, i ? 1 / spec.fps : 0);
  for (const c of chars) cues.push(...c.cues);
  return cues.sort((a, b) => a.at - b.at);
}
