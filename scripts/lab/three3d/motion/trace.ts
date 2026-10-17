/**
 * Motion trace: runs a shot's characters with the renderer's own Character3D code (headless, in Node, frame by frame like
 * the browser) and measures transform continuity: root speed / turn rate spikes, per-bone angular steps, hips-vs-root jumps
 * and planted-foot sliding. Usage: npx tsx scripts/lab/three3d/motion/trace.ts <shot.compiled.json | dir> [--csv out.csv]
 */
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { Character3D } from "../../../../apps/server/src/anim/renderers/three3d/runtime/character";
import { characterFile } from "../../../../apps/server/src/anim/renderers/three3d/library";
import type { Shot3DSpec } from "../../../../apps/server/src/anim/renderers/three3d/spec";
import { loadGlbNode } from "./glb";

const ROLES = ["hips", "spine", "chest", "neck", "head", "upperArmR", "upperArmL", "handR", "handL"] as const;
export interface Frame { t: number; id: string; root: THREE.Vector3; heading: number; hips: THREE.Vector3; head: THREE.Vector3; footL: THREE.Vector3; footR: THREE.Vector3; q: Record<string, THREE.Quaternion>; speed: number; loco: string }
export interface Issue { shot: string; id: string; t: number; kind: string; value: number; detail: string }

export async function traceShot(spec: Shot3DSpec, file = characterFile): Promise<Frame[][]> {
  const door = spec.environment.objects.find((o) => o.kind === "door");
  const named: Record<string, THREE.Vector3> = {};
  if (door) {
    named["door"] = new THREE.Vector3(door.x + 0.4, 1.1, door.z + 0.15);
    named["door-front"] = new THREE.Vector3(door.x + 0.35, 0, door.z + 0.75);
    named["doorway"] = named["inside"] = new THREE.Vector3(door.x, 1.5, door.z - 2);
  }
  const chars = new Map<string, Character3D>();
  const world = { resolve: (t: unknown): THREE.Vector3 | null => {
    if (typeof t !== "string") { const p = t as { x: number; y?: number; z: number }; return new THREE.Vector3(p.x, p.y ?? 0, p.z); }
    if (t === "camera") return new THREE.Vector3(0, 1.5, 6);
    const c = chars.get(t); if (c) return c.headPosition();
    return named[t]?.clone() ?? null;
  } };
  for (const cs of spec.characters) chars.set(cs.id, new Character3D(cs, await loadGlbNode(file(cs.asset)), world as never));
  const out: Frame[][] = [...chars.keys()].map(() => []);
  const frames = Math.round(spec.duration * spec.fps), dt = 1 / spec.fps;
  for (let i = 0; i < frames; i++) {
    const t = i * dt;
    for (const c of chars.values()) c.update(t, i === 0 ? 0 : dt);
    [...chars.values()].forEach((c, k) => {
      const B = c.bones, wp = (b?: THREE.Object3D) => (b ?? c.root).getWorldPosition(new THREE.Vector3());
      const q: Record<string, THREE.Quaternion> = {};
      for (const r of ROLES) if (B[r]) q[r] = B[r]!.getWorldQuaternion(new THREE.Quaternion());
      const L = c.locomotion;
      out[k]!.push({ t, id: c.spec.id, root: c.root.position.clone(), heading: c.currentHeading, hips: wp(B.hips), head: wp(B.head), footL: wp(B.footL), footR: wp(B.footR), q, speed: c.currentSpeed, loco: `i${L.idle.toFixed(2)} w${L.walk.toFixed(2)}` });
    });
  }
  return out;
}

/** Frames recorded by the browser renderer itself (spec.trace): the transforms that were actually drawn. */
export function fromBrowserTrace(trace: Record<string, { t: number; root: number[]; heading: number; speed: number; loco: number[]; q: Record<string, number[]>; feet: number[][] }[]>): Frame[][] {
  return Object.entries(trace).filter(([id]) => !id.startsWith("~")).map(([id, fr]) => fr.map((f) => ({
    t: f.t, id, root: new THREE.Vector3().fromArray(f.root), heading: f.heading, speed: f.speed, loco: `i${f.loco[0]!.toFixed(2)} w${f.loco[1]!.toFixed(2)}`,
    footL: new THREE.Vector3().fromArray(f.feet[0]!), footR: new THREE.Vector3().fromArray(f.feet[1]!), hips: new THREE.Vector3().fromArray(f.feet[2]!), head: new THREE.Vector3().fromArray(f.feet[3]!),
    q: Object.fromEntries(Object.entries(f.q).filter(([k]) => !k.startsWith("foot")).map(([k, v]) => [k, new THREE.Quaternion().fromArray(v)])),
  })));
}

const deg = (r: number) => (r * 180) / Math.PI;
/** Discontinuities: a step much larger than the steps around it (a snap), beyond an absolute floor. */
export function analyse(shot: string, tracks: Frame[][]): Issue[] {
  const issues: Issue[] = [];
  for (const tr of tracks) {
    const n = tr.length;
    const spike = (vals: number[], floor: number, kind: string, detail: (i: number) => string): void => {
      for (let i = 2; i < n - 2; i++) {
        const nb = [vals[i - 2]!, vals[i - 1]!, vals[i + 1]!, vals[i + 2]!].sort((a, b) => a - b);
        const base = (nb[1]! + nb[2]!) / 2;
        if (vals[i]! > floor && vals[i]! > 3 * base + floor * 0.5) issues.push({ shot, id: tr[i]!.id, t: tr[i]!.t, kind, value: +vals[i]!.toFixed(3), detail: detail(i) });
      }
    };
    const rootStep = tr.map((f, i) => (i ? f.root.distanceTo(tr[i - 1]!.root) : 0));
    spike(rootStep, 0.02, "root-jump(m/frame)", (i) => `speed ${tr[i]!.speed.toFixed(2)}`);
    // the body moving against the way it faces (moonwalk / backward slide)
    for (let i = 1; i < n; i++) {
      const d = tr[i]!.root.clone().sub(tr[i - 1]!.root); const s = d.length();
      if (s < 0.01) continue;
      const fwd = new THREE.Vector3(Math.sin(tr[i]!.heading), 0, Math.cos(tr[i]!.heading));
      const cos = d.normalize().dot(fwd);
      if (cos < 0.5) issues.push({ shot, id: tr[i]!.id, t: tr[i]!.t, kind: "moves-not-facing", value: +deg(Math.acos(Math.max(-1, Math.min(1, cos)))).toFixed(0), detail: `step ${s.toFixed(3)} m` });
    }
    const turn = tr.map((f, i) => (i ? Math.abs(Math.atan2(Math.sin(f.heading - tr[i - 1]!.heading), Math.cos(f.heading - tr[i - 1]!.heading))) : 0));
    spike(turn.map(deg), 2.5, "root-turn-snap(deg/frame)", () => "");
    const hipsRel = tr.map((f) => f.hips.clone().sub(f.root).setY(0).applyAxisAngle(new THREE.Vector3(0, 1, 0), -f.heading));
    spike(hipsRel.map((p, i) => (i ? p.distanceTo(hipsRel[i - 1]!) : 0)), 0.02, "hips-jump(m/frame)", (i) => tr[i]!.loco);
    for (const r of ROLES) {
      if (!tr[0]!.q[r]) continue;
      const a = tr.map((f, i) => (i ? deg(f.q[r]!.angleTo(tr[i - 1]!.q[r]!)) : 0));
      spike(a, r === "head" || r === "neck" ? 3 : 4, `${r}-snap(deg/frame)`, (i) => tr[i]!.loco);
    }
    // planted foot: a foot within 2 cm of its own lowest point in the shot carries weight; the slower of the planted feet
    // must not slide (the other may be rolling off its toes)
    const lowL = Math.min(...tr.map((f) => f.footL.y)), lowR = Math.min(...tr.map((f) => f.footR.y));
    for (let i = 1; i < n; i++) {
      const sp: number[] = [];
      for (const [k, low] of [["footL", lowL], ["footR", lowR]] as const) {
        const f = tr[i]![k], p = tr[i - 1]![k];
        if (f.y - low <= 0.02) sp.push(Math.hypot(f.x - p.x, f.z - p.z) * 30);
      }
      if (!sp.length) continue;
      const slide = Math.min(...sp);
      if (slide > 0.35 && tr[i]!.speed > 0.05) issues.push({ shot, id: tr[i]!.id, t: tr[i]!.t, kind: "planted-foot-slide(m/s)", value: +slide.toFixed(2), detail: `${tr[i]!.loco} speed ${tr[i]!.speed.toFixed(2)}` });
    }
  }
  return issues;
}

/** Groups consecutive frames of the same issue into one event (start, frames, peak). */
export function events(issues: Issue[]): { shot: string; id: string; kind: string; t: number; frames: number; peak: number; detail: string }[] {
  const out: { shot: string; id: string; kind: string; t: number; frames: number; peak: number; detail: string; last: number }[] = [];
  for (const x of issues.sort((a, b) => a.shot.localeCompare(b.shot) || a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind) || a.t - b.t)) {
    const e = out[out.length - 1];
    if (e && e.shot === x.shot && e.id === x.id && e.kind === x.kind && x.t - e.last < 0.12) { e.frames++; e.peak = Math.max(e.peak, x.value); e.last = x.t; }
    else out.push({ shot: x.shot, id: x.id, kind: x.kind, t: x.t, frames: 1, peak: x.value, detail: x.detail, last: x.t });
  }
  return out.map(({ last: _l, ...e }) => e);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const arg = process.argv[2]!;
  const files = fs.statSync(arg).isDirectory() ? fs.readdirSync(arg).filter((f) => f.endsWith(".compiled.json")).sort().map((f) => path.join(arg, f)) : [arg];
  const all: ReturnType<typeof events> = [];
  for (const f of files) {
    const spec = JSON.parse(fs.readFileSync(f, "utf8")).spec as Shot3DSpec;
    all.push(...events(analyse(path.basename(f).replace(".compiled.json", ""), await traceShot(spec))));
  }
  const byKind = new Map<string, number>();
  for (const e of all) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  console.log(`${files.length} shots, ${all.length} discontinuity events`);
  for (const [k, v] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  if (process.argv.includes("--list")) for (const e of all) console.log(`${e.shot} ${e.id.padEnd(7)} t=${e.t.toFixed(2)} ${e.kind} x${e.frames} peak ${e.peak} ${e.detail}`);
}
