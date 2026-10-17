import * as THREE from "three";

/**
 * Finds the bones and clips a character needs, whatever the rig's naming (Mixamo "mixamorigRightArm", Quaternius
 * "UpperArm.R" / "UpperArmR", Unreal "upperarm_r"...). Nothing here depends on one particular model.
 */
export const BONE_ROLES = ["hips", "spine", "chest", "neck", "head", "shoulderR", "upperArmR", "lowerArmR", "handR", "shoulderL", "upperArmL", "lowerArmL", "handL", "upperLegR", "lowerLegR", "footR", "upperLegL", "lowerLegL", "footL"] as const;
export type BoneRole = (typeof BONE_ROLES)[number];

const side = (s: "R" | "L"): string => (s === "R" ? "(right|^r[_.]|[_.]r[_.]|_r\\b|\\.r\\b|r$|_r$)" : "(left|^l[_.]|[_.]l[_.]|_l\\b|\\.l\\b|l$|_l$)");
/** A limb part with the side on either end of the name: "UpperArm.R", "upperarm_r", "RightUpperArm", "R_UpperArm". */
const part = (p: string, s: "R" | "L"): RegExp => new RegExp(`(${p}).*${side(s)}|${side(s)}.*(${p})`, "i");
const limbs = (s: "R" | "L"): Partial<Record<BoneRole, RegExp[]>> => {
  const w = s === "R" ? "right" : "left";
  return {
    [`shoulder${s}`]: [part("shoulder|clavicle", s)],
    [`upperArm${s}`]: [part("upper_?arm", s), new RegExp(`${side(s)}.*arm$`, "i"), new RegExp(`^(mixamorig)?${w}arm$`, "i")],
    [`lowerArm${s}`]: [part("lower_?arm|fore_?arm", s)],
    [`hand${s}`]: [new RegExp(`(hand|wrist|palm).*${side(s)}|${side(s)}.*(hand|wrist|palm)$`, "i")],
    [`upperLeg${s}`]: [part("upper_?leg|thigh|up_?leg", s)],
    [`lowerLeg${s}`]: [part("lower_?leg|calf|shin", s), new RegExp(`^(mixamorig)?${w}leg$`, "i")],
    [`foot${s}`]: [new RegExp(`foot.*${side(s)}|${side(s)}.*foot$`, "i")],
  };
};
const PATTERNS: Record<BoneRole, RegExp[]> = {
  hips: [/hips?$/i, /pelvis/i],
  spine: [/^(mixamorig)?spine$/i, /abdomen/i, /spine_?0?1?$/i],
  chest: [/chest/i, /spine2$/i, /spine_?0?3$/i, /torso/i, /spine_?0?2$/i, /spine1$/i],
  neck: [/neck/i],
  head: [/^(mixamorig)?head$/i, /head$/i],
  ...limbs("R"),
  ...limbs("L"),
} as Record<BoneRole, RegExp[]>;

export function findBones(root: THREE.Object3D): Partial<Record<BoneRole, THREE.Bone>> {
  const bones: THREE.Bone[] = [];
  root.traverse((o) => { if ((o as THREE.Bone).isBone && !/_end$|end$|nub$|ik|pole|^pt/i.test(o.name)) bones.push(o as THREE.Bone); });
  const out: Partial<Record<BoneRole, THREE.Bone>> = {};
  const used = new Set<THREE.Bone>();
  for (const role of BONE_ROLES) {
    for (const re of PATTERNS[role]) {
      const b = bones.find((x) => !used.has(x) && re.test(x.name.replace(/[:\s]/g, "")) && !/(index|middle|ring|pinky|thumb|finger|toe|twist)/i.test(x.name));
      if (b) { out[role] = b; used.add(b); break; }
    }
  }
  return out;
}

/** Semantic clip roles and how to find them in a model's clip list (first match wins). */
export const CLIP_ROLES = {
  idle: [/(^|\|)idle$/i, /idle_neutral/i, /idle/i],
  walk: [/(^|\|)walk(ing)?$/i, /walk/i],
  run: [/(^|\|)run(ning)?$/i, /(^|\|)jog$/i, /sprint/i],
  wave: [/wave/i],
  interact: [/interact/i, /pick_?up/i, /use_?item/i],
  react: [/hit_?rec/i, /hit/i, /flinch/i],
  aim: [/gun_?point/i, /point/i, /aim/i],
  death: [/death|die/i],
} as const;
export type ClipRole = keyof typeof CLIP_ROLES;

export function findClips(clips: THREE.AnimationClip[]): Partial<Record<ClipRole, THREE.AnimationClip>> {
  const out: Partial<Record<ClipRole, THREE.AnimationClip>> = {};
  for (const role of Object.keys(CLIP_ROLES) as ClipRole[]) {
    for (const re of CLIP_ROLES[role]) {
      const c = clips.find((x) => re.test(x.name));
      if (c) { out[role] = c; break; }
    }
  }
  return out;
}

/** A clip restricted to some bones (an upper-body or one-arm layer that plays over the locomotion). */
/** Keeps the rotation tracks of `bones` and everything below them, minus the chains under `exclude` (in a 3ds Max Biped
 *  the thighs hang off the spine: an "upper body" mask would otherwise carry the legs too). */
export function maskClip(clip: THREE.AnimationClip, bones: THREE.Object3D[], name: string, exclude: THREE.Object3D[] = []): THREE.AnimationClip {
  const names = new Set<string>();
  for (const b of bones) b.traverse((o) => names.add(o.name));
  for (const b of exclude) b.traverse((o) => names.delete(o.name));
  const tracks = clip.tracks.filter((t) => names.has(t.name.split(".")[0]!) && !t.name.endsWith(".position") && !t.name.endsWith(".scale"));
  return new THREE.AnimationClip(name, clip.duration, tracks);
}

/** Removes the horizontal root motion from a locomotion clip so the renderer moves the character along its path (no double movement). */
export function inPlace(clip: THREE.AnimationClip, hips: THREE.Object3D | undefined): THREE.AnimationClip {
  if (!hips) return clip;
  const c = clip.clone();
  for (const t of c.tracks) {
    if (t.name !== `${hips.name}.position`) continue;
    const v = t.values, x0 = v[0]!, z0 = v[2]!;
    for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
  }
  return c;
}

/** The largest jump (degrees, over the rotation tracks) between a clip's last pose and its first: what a LoopRepeat shows
 *  at every wrap. A real cycle (walk, run) is ~1 degree; a trimmed performance (a talking gesture cut to 10 s) can be 100+. */
export function loopSeam(clip: THREE.AnimationClip): number {
  let worst = 0;
  for (const t of clip.tracks) {
    if (!t.name.endsWith(".quaternion") || t.times.length < 2) continue;
    const n = t.times.length, v = t.values;
    worst = Math.max(worst, new THREE.Quaternion().fromArray(v, 0).angleTo(new THREE.Quaternion().fromArray(v, (n - 1) * 4)));
  }
  return (worst * 180) / Math.PI;
}

/**
 * A seamless loop from a clip that is not one: the last `fade` seconds are cross-faded into the first, and the clip is
 * shortened by `fade`, so pose AND motion run on through the wrap (new(L) = new(0) exactly). Rotations slerp, positions
 * lerp, with an eased weight. Deterministic, done once at load.
 */
export function seamlessLoop(clip: THREE.AnimationClip, fade = Math.min(1, clip.duration * 0.25)): THREE.AnimationClip {
  const L = clip.duration - fade;
  if (fade <= 0 || L <= fade) return clip;
  const tracks = clip.tracks.map((t) => {
    const size = t.getValueSize(), quat = t.name.endsWith(".quaternion");
    const interp = (t as unknown as { createInterpolant(result?: Float32Array): { evaluate(x: number): ArrayLike<number> } }).createInterpolant(new Float32Array(size));
    const at = (x: number): number[] => Array.from(interp.evaluate(x));
    // the cross-fade region is sampled at 30 Hz whatever the source key density (sparse keys would skip the blend)
    const grid = Array.from({ length: Math.ceil(fade * 30) }, (_, i) => i / 30);
    const keys = [...new Set([...t.times].filter((x) => x <= L).concat(grid))].sort((a, b) => a - b);
    if (keys[keys.length - 1]! < L - 1e-6) keys.push(L);
    const values: number[] = [];
    for (const x of keys) {
      const own = at(x);
      if (x >= fade) { values.push(...own); continue; }
      const u = x / fade, w = u * u * (3 - 2 * u), tail = at(Math.min(clip.duration, x + L));
      if (quat) { const q = new THREE.Quaternion().fromArray(tail).slerp(new THREE.Quaternion().fromArray(own), w); values.push(q.x, q.y, q.z, q.w); }
      else values.push(...tail.map((a, k) => a + (own[k]! - a) * w));
    }
    // the last key (t = L) must equal the first (t = 0, which is orig(L)): set it explicitly to avoid rounding
    values.splice(values.length - size, size, ...values.slice(0, size));
    const T = t.constructor as new (name: string, times: number[], values: number[]) => THREE.KeyframeTrack;
    return new T(t.name, keys, values);
  });
  return new THREE.AnimationClip(clip.name, L, tracks);
}

/** How much a clip moves a bone chain (sum of the angle ranges of its quaternion tracks): which arm does the waving? */
export function chainMotion(clip: THREE.AnimationClip, root: THREE.Object3D | undefined): number {
  if (!root) return 0;
  const names = new Set<string>(); root.traverse((o) => names.add(o.name));
  let sum = 0;
  for (const t of clip.tracks) {
    if (!t.name.endsWith(".quaternion") || !names.has(t.name.split(".")[0]!)) continue;
    const v = t.values, q0 = new THREE.Quaternion(v[0], v[1], v[2], v[3]);
    let max = 0;
    for (let i = 4; i < v.length; i += 4) max = Math.max(max, q0.angleTo(new THREE.Quaternion(v[i], v[i + 1], v[i + 2], v[i + 3])));
    sum += max;
  }
  return sum;
}
