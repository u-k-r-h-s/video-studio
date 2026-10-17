import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";

/** Loads a .glb in Node without its textures (Node has no image decoder; motion analysis, tests and cue simulation do not
 *  need them). Parsed once per file; every call gets its own skinned copy. */
const cache = new Map<string, Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }>>();
export async function loadGlbNode(file: string): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  let p = cache.get(file);
  if (!p) {
    const b = fs.readFileSync(file);
    const jl = b.readUInt32LE(12), json = JSON.parse(b.subarray(20, 20 + jl).toString("utf8"));
    delete json.images; delete json.textures; delete json.samplers;
    for (const m of json.materials ?? []) {
      for (const k of ["normalTexture", "occlusionTexture", "emissiveTexture"]) delete m[k];
      if (m.pbrMetallicRoughness) { delete m.pbrMetallicRoughness.baseColorTexture; delete m.pbrMetallicRoughness.metallicRoughnessTexture; }
      delete m.extensions;
    }
    let js = Buffer.from(JSON.stringify(json), "utf8"); const pad = (4 - (js.length % 4)) % 4; js = Buffer.concat([js, Buffer.alloc(pad, 0x20)]);
    const bin = b.subarray(20 + jl);
    const head = Buffer.alloc(20); head.write("glTF", 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + js.length + bin.length, 8); head.writeUInt32LE(js.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
    const glb = Buffer.concat([head, js, bin]);
    p = new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), "") as never;
    cache.set(file, p);
  }
  const g = await p;
  return { scene: clone(g.scene), animations: g.animations };
}
