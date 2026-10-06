import * as THREE from "three";

/**
 * Finds the bones and clips a character needs, whatever the rig's naming (Mixamo "mixamorigRightArm", Quaternius
 * "UpperArm.R" / "UpperArmR", Unreal "upperarm_r"...). Nothing here depends on one particular model.
 */
export const BONE_ROLES = ["hips", "spine", "chest", "neck", "head", "shoulderR", "upperArmR", "lowerArmR", "handR", "shoulderL", "upperArmL", "lowerArmL", "handL", "upperLegR", "lowerLegR", "footR", "upperLegL", "lowerLegL", "footL"] as const;
export type BoneRole = (typeof BONE_ROLES)[number];

const side = (s: "R" | "L"): string => (s === "R" ? "(right|_r\\b|\\.r\\b|r$|_r$)" : "(left|_l\\b|\\.l\\b|l$|_l$)");
const PATTERNS: Record<BoneRole, RegExp[]> = {
  hips: [/hips?$/i, /pelvis/i],
  spine: [/^(mixamorig)?spine$/i, /abdomen/i, /spine_?0?1?$/i],
  chest: [/chest/i, /spine2$/i, /spine_?0?3$/i, /torso/i, /spine1$/i],
  neck: [/neck/i],
  head: [/^(mixamorig)?head$/i, /head$/i],
  shoulderR: [new RegExp(`shoulder.*${side("R")}|${side("R")}.*shoulder|clavicle.*${side("R")}`, "i")],
  upperArmR: [new RegExp(`upper_?arm.*${side("R")}|${side("R")}.*arm$|^(mixamorig)?rightarm$`, "i")],
  lowerArmR: [new RegExp(`(lower_?arm|fore_?arm).*${side("R")}|${side("R")}.*fore_?arm`, "i")],
  handR: [new RegExp(`(hand|wrist).*${side("R")}|${side("R")}.*hand$`, "i")],
  shoulderL: [new RegExp(`shoulder.*${side("L")}|${side("L")}.*shoulder|clavicle.*${side("L")}`, "i")],
  upperArmL: [new RegExp(`upper_?arm.*${side("L")}|${side("L")}.*arm$|^(mixamorig)?leftarm$`, "i")],
  lowerArmL: [new RegExp(`(lower_?arm|fore_?arm).*${side("L")}|${side("L")}.*fore_?arm`, "i")],
  handL: [new RegExp(`(hand|wrist).*${side("L")}|${side("L")}.*hand$`, "i")],
  upperLegR: [new RegExp(`(upper_?leg|thigh|up_?leg).*${side("R")}|${side("R")}.*up_?leg`, "i")],
  lowerLegR: [new RegExp(`(lower_?leg|calf|shin).*${side("R")}|^(mixamorig)?rightleg$`, "i")],
  footR: [new RegExp(`foot.*${side("R")}|${side("R")}.*foot$`, "i")],
  upperLegL: [new RegExp(`(upper_?leg|thigh|up_?leg).*${side("L")}|${side("L")}.*up_?leg`, "i")],
  lowerLegL: [new RegExp(`(lower_?leg|calf|shin).*${side("L")}|^(mixamorig)?leftleg$`, "i")],
  footL: [new RegExp(`foot.*${side("L")}|${side("L")}.*foot$`, "i")],
};

export function findBones(root: THREE.Object3D): Partial<Record<BoneRole, THREE.Bone>> {
  const bones: THREE.Bone[] = [];
  root.traverse((o) => { if ((o as THREE.Bone).isBone && !/_end$|end$|ik|pole|^pt/i.test(o.name)) bones.push(o as THREE.Bone); });
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
export function maskClip(clip: THREE.AnimationClip, bones: THREE.Object3D[], name: string): THREE.AnimationClip {
  const names = new Set<string>();
  for (const b of bones) b.traverse((o) => names.add(o.name));
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
