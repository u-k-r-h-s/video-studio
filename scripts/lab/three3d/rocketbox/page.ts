// Runs inside headless Chrome (bundled by convert.ts): three.js reads the Rocketbox FBX (FBXLoader), the clips are attached,
// materials become PBR, and GLTFExporter writes one GLB. Nothing here renders frames.
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

type Files = { fbx: string; textures: Record<string, string> };
const buf = (b64: string): ArrayBuffer => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

async function parse(f: Files): Promise<THREE.Group> {
  const manager = new THREE.LoadingManager();
  // the FBX names its textures by a 3ds Max path ("..\Textures\m022_body_color.tga"): match by file name
  manager.setURLModifier((url) => f.textures[url.split(/[\\/]/).pop()!.replace(/\.\w+$/, "").toLowerCase()] ?? url);
  manager.addHandler(/\.tga$/i, new THREE.TextureLoader(manager));
  const pending = new Promise<void>((res) => { manager.onLoad = () => res(); setTimeout(res, 8000); });
  const g = new FBXLoader(manager).parse(buf(f.fbx), "");
  await pending;
  return g;
}

function describe(g: THREE.Group): Record<string, unknown> {
  const meshes: unknown[] = [], bones: string[] = [];
  g.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.push(o.name);
    const m = o as THREE.SkinnedMesh;
    if (!m.isMesh) return;
    const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => { const a = x as THREE.MeshPhongMaterial; return { type: a.type, name: a.name, map: a.map?.name ?? a.map?.image?.width ?? null, normal: !!a.normalMap, spec: !!a.specularMap, alpha: !!a.alphaMap, transparent: a.transparent, opacity: a.opacity }; });
    meshes.push({ name: m.name, skinned: !!m.isSkinnedMesh, visible: m.visible, verts: m.geometry.attributes.position?.count, morphs: Object.keys(m.morphTargetDictionary ?? {}).length, morphNames: Object.keys(m.morphTargetDictionary ?? {}), mats });
  });
  const box = new THREE.Box3().setFromObject(g);
  return { meshes, bones, animations: g.animations.map((a) => `${a.name} ${a.duration.toFixed(2)}s ${a.tracks.length} tracks`), size: box.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(2)), scale: g.scale.toArray() };
}

/** Blend shapes worth shipping: the 15 visemes + the ARKit shapes the face layer uses (expressions, blinks, brows, jaw). */
const KEEP = /^(AA_VI_\d+_\w+|AK_\d+_(EyeBlink(Left|Right)|Brow\w+|CheekSquint\w+|EyeSquint\w+|EyeWide\w+|JawOpen|MouthClose|MouthFrown\w+|MouthFunnel|MouthPucker|MouthSmile\w+|MouthStretch\w+|MouthPress\w+|MouthLowerDown\w+|MouthUpperUp\w+|NoseSneer\w+|MouthRoll\w+))$/;
const FACE_BONE = /(eye|jaw|lip|mouth|cheek|brow|nose|masseter|caninus|tongue)/i;
const ROLE: [RegExp, string][] = [[/idle_neutral/, "Idle"], [/walk_neutral/, "Walk"], [/run_neutral/, "Run"], [/wave/, "Wave"], [/look_around/, "Look_Around"],
  [/talk_neutral_01/, "Talk_Neutral_01"], [/talk_neutral_02/, "Talk_Neutral_02"], [/talk_sad/, "Talk_Sad"], [/talk_excited/, "Talk_Excited"], [/talk_angry/, "Talk_Angry"],
  [/listen_neutral/, "Listen_Neutral"], [/listen_accept/, "Listen_Accept"], [/listen_sad/, "Listen_Sad"]];

type Clip = { file: string; fbx: string; locomotion: boolean };

/** One skinned mesh per material group (body / head), sharing the skeleton; only the head keeps the blend shapes. */
function splitByMaterial(m: THREE.SkinnedMesh): THREE.SkinnedMesh[] {
  const g = m.geometry, mats = m.material as THREE.Material[], idx = g.index?.array;
  return g.groups.map((grp) => {
    // indexed: the group is a range of indices; not indexed (FBXLoader): a range of vertices
    const map = new Map<number, number>(), order: number[] = [], index: number[] = [];
    for (let i = grp.start; i < grp.start + grp.count; i++) { const v = idx ? idx[i]! : i; if (!map.has(v)) { map.set(v, order.length); order.push(v); } index.push(map.get(v)!); }
    const sub = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(g.attributes)) {
      const at = a as THREE.BufferAttribute, out = new (at.array.constructor as new (n: number) => THREE.TypedArray)(order.length * at.itemSize);
      order.forEach((v, k) => { for (let c = 0; c < at.itemSize; c++) out[k * at.itemSize + c] = at.array[v * at.itemSize + c]!; });
      sub.setAttribute(name, new THREE.BufferAttribute(out, at.itemSize, at.normalized));
    }
    const mat = mats[grp.materialIndex ?? 0]!;
    const head = /head/i.test(mat.name);
    if (head && g.morphAttributes.position) {
      sub.morphAttributes.position = g.morphAttributes.position.map((a) => { const out = new Float32Array(order.length * 3); order.forEach((v, k) => { out[k * 3] = a.array[v * 3]!; out[k * 3 + 1] = a.array[v * 3 + 1]!; out[k * 3 + 2] = a.array[v * 3 + 2]!; }); return new THREE.BufferAttribute(out, 3); });
      sub.morphTargetsRelative = g.morphTargetsRelative;
    }
    sub.setIndex(index);
    const part = new THREE.SkinnedMesh(sub, mat);
    part.name = `${m.name}_${head ? "head" : "body"}`;
    if (head && sub.morphAttributes.position) { part.morphTargetDictionary = { ...m.morphTargetDictionary }; part.morphTargetInfluences = [...(m.morphTargetInfluences ?? [])]; }
    part.bind(m.skeleton, m.bindMatrix);
    return part;
  });
}
async function convert(f: Files, clips: Clip[]): Promise<{ glb: string; report: Record<string, unknown> }> {
  const g = await parse(f);
  g.animations = [];
  const names = new Set<string>();
  let rootBone: THREE.Bone | undefined;
  let kept: string[] = [], meshes = 0, verts = 0;
  g.traverse((o) => {
    if ((o as THREE.Bone).isBone) { names.add(o.name); if (o.name === "Bip01") rootBone = o as THREE.Bone; }
    const m = o as THREE.SkinnedMesh;
    if (!m.isMesh) return;
    meshes++; verts += m.geometry.attributes.position!.count;
    // blend shapes: keep the useful ones (positions only), drop the "blendShape1." prefix
    const dict = m.morphTargetDictionary ?? {}, pos = m.geometry.morphAttributes.position ?? [];
    const keep = Object.entries(dict).map(([n, i]) => [n.replace(/^.*\./, ""), i] as const).filter(([n]) => KEEP.test(n)).sort((a, b) => a[0].localeCompare(b[0]));
    if (keep.length) {
      m.geometry.morphAttributes = { position: keep.map(([, i]) => pos[i]!) };
      m.morphTargetDictionary = Object.fromEntries(keep.map(([n], k) => [n, k]));
      m.morphTargetInfluences = keep.map(() => 0);
      m.geometry.morphTargetsRelative = m.geometry.morphTargetsRelative;
      kept = keep.map(([n]) => n);
    }
    // PBR materials: colour + normal map; the face is a little smoother than the clothes
    const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshPhongMaterial[];
    const pbr = mats.map((x) => {
      const head = /head/i.test(x.name), cards = /opacity|hair|lash|beard/i.test(x.name) || !!x.alphaMap || x.transparent;
      // hair / beard cards: the colour texture carries the alpha, cut out (no sorting problems) and seen from both sides
      const s = new THREE.MeshStandardMaterial({ name: x.name, map: x.map, normalMap: x.normalMap, color: 0xffffff, roughness: head ? 0.52 : cards ? 0.7 : 0.8, metalness: 0, alphaMap: x.alphaMap ?? null, transparent: false, alphaTest: cards ? 0.45 : 0, side: cards ? THREE.DoubleSide : THREE.FrontSide });
      if (s.map) s.map.colorSpace = THREE.SRGBColorSpace;
      return s;
    });
    m.material = Array.isArray(m.material) ? pbr : pbr[0]!;
  });
  // centimetres -> metres
  // body and head as separate meshes: blend shapes only where they act (a much smaller file and morph texture)
  const multi: THREE.SkinnedMesh[] = [];
  g.traverse((o) => { const m = o as THREE.SkinnedMesh; if (m.isSkinnedMesh && Array.isArray(m.material) && m.geometry.groups.length > 1) multi.push(m); });
  for (const m of multi) { const parts = splitByMaterial(m); m.parent!.add(...parts); m.parent!.remove(m); }
  g.scale.setScalar(0.01);
  g.updateMatrixWorld(true);
  // which local axis of the biped root is "up" (its bind position is ~pelvis height on that axis)
  const bind = rootBone!.position.toArray(), upAxis = bind.map(Math.abs).indexOf(Math.max(...bind.map(Math.abs)));
  const out: THREE.AnimationClip[] = [];
  for (const c of clips) {
    const src = new FBXLoader().parse(buf(c.fbx), "").animations[0];
    const role = ROLE.find(([re]) => re.test(c.file))?.[1];
    if (!src || !role) continue;
    const tracks = src.tracks.filter((t) => { const b = t.name.split(".")[0]!; return names.has(b) && !FACE_BONE.test(b) && !/nub$/i.test(b) && !t.name.endsWith(".scale"); });
    for (const t of tracks) {
      if (!t.name.endsWith(".position") || !/^Bip01(_Pelvis)?\./.test(t.name)) continue;
      const v = t.values, isRoot = t.name.startsWith("Bip01.");
      // the clip was recorded on an adult: the root height follows this body's own proportions
      const ratio = isRoot && Math.abs(v[upAxis]!) > 1e-3 ? bind[upAxis]! / v[upAxis]! : 1;
      for (let i = 0; i < v.length; i += 3) for (let a = 0; a < 3; a++) {
        if (a === upAxis) v[i + a] = v[i + a]! * ratio;
        else if (c.locomotion) v[i + a] = v[a]!; // in place: the renderer moves the character along its path
      }
    }
    // a looping talk / listen / idle loop does not need 30-40 s of keys: ~10 s varies enough
    const full = new THREE.AnimationClip(role, src.duration, tracks);
    out.push(src.duration > 12 ? THREE.AnimationUtils.subclip(full, role, 0, 300, 30) : full);
  }
  const box = new THREE.Box3().setFromObject(g);
  const glb = (await new GLTFExporter().parseAsync(g, { binary: true, animations: out, maxTextureSize: 1024, onlyVisible: false })) as ArrayBuffer;
  let bin = ""; const u8 = new Uint8Array(glb);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return { glb: btoa(bin), report: { meshes, verts, blendShapes: kept.length, blendShapeNames: kept, clips: out.map((c) => `${c.name} ${c.duration.toFixed(2)}s ${c.tracks.length} tracks`), heightM: +(box.max.y - box.min.y).toFixed(2), upAxis, mb: +(glb.byteLength / 1e6).toFixed(1) } };
}

(window as unknown as { rb: unknown }).rb = {
  inspect: async (f: Files) => describe(await parse(f)),
  convert: (f: Files, clips: Clip[]) => convert(f, clips),
};
