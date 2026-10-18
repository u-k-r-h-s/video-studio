/**
 * Camera motion audit: renders shot specs with the browser trace and reports, per shot, the camera's frame-to-frame
 * travel (m), rotation (deg) and their peaks vs the shot's median: a "snap" is a frame that moves far more than its
 * neighbours. Usage: npx tsx scripts/lab/camera/cam-trace.ts <proof.json | spec.json>... [--ids shot-01,shot-02]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Three3DRenderer } from "../../../apps/server/src/anim/renderers/three3d/index";
import { characterFile } from "../../../apps/server/src/anim/renderers/three3d/library";
import type { Shot3DSpec } from "../../../apps/server/src/anim/renderers/three3d/spec";

const args = process.argv.slice(2), ids = args.includes("--ids") ? args[args.indexOf("--ids") + 1]!.split(",") : null;
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--ids");
const specs: Shot3DSpec[] = files.flatMap((f) => { const j = JSON.parse(fs.readFileSync(f, "utf8")); return j.specs ?? [j]; }).filter((s) => !ids || ids.includes(s.id));
const r = new Three3DRenderer({ characterFile, imageFile: (k) => (fs.existsSync(k) ? k : null) });
const out: Record<string, unknown>[] = [];
try {
  for (const s0 of specs) {
    const spec = { ...s0, width: 270, height: 480, trace: true };
    const res = await r.render(spec, path.join(os.tmpdir(), `ct-${spec.id}.mp4`), { ffmpeg: "/opt/homebrew/bin/ffmpeg", encoder: "h264_videotoolbox", bitrateKbps: 800 } as never);
    const cam = (res.info as { trace: Record<string, { t: number; root: number[]; q: { cam: number[] } }[]> }).trace["~camera"]!;
    const mv: number[] = [], rot: number[] = [];
    for (let i = 1; i < cam.length; i++) {
      const a = cam[i - 1]!, b = cam[i]!;
      mv.push(Math.hypot(b.root[0]! - a.root[0]!, b.root[1]! - a.root[1]!, b.root[2]! - a.root[2]!));
      const d = Math.abs(a.q.cam.reduce((s, v, k) => s + v * b.q.cam[k]!, 0)); rot.push((2 * Math.acos(Math.min(1, d)) * 180) / Math.PI);
    }
    const med = (x: number[]) => [...x].sort((p, q) => p - q)[Math.floor(x.length / 2)]!;
    const peak = (x: number[]) => x.reduce((m, v, i) => (v > x[m]! ? i : m), 0);
    const pm = peak(mv), pr = peak(rot);
    // the first 12 frames separately: the settle at the start of a shot is where a spring shows itself
    const head = mv.slice(0, 12), headR = rot.slice(0, 12);
    const row = { id: spec.id, cam: `${spec.camera.purpose ?? ""} ${spec.camera.shot}/${spec.camera.move}`, frames: cam.length, travel: +mv.reduce((a, b) => a + b, 0).toFixed(2),
      medMove: +med(mv).toFixed(4), peakMove: +mv[pm]!.toFixed(4), peakMoveAt: pm + 1, medRot: +med(rot).toFixed(3), peakRot: +rot[pr]!.toFixed(3), peakRotAt: pr + 1,
      first12Move: +head.reduce((a, b) => a + b, 0).toFixed(3), first12Rot: +headR.reduce((a, b) => a + b, 0).toFixed(2),
      first: { p: cam[0]!.root, q: cam[0]!.q.cam }, last: { p: cam.at(-1)!.root, q: cam.at(-1)!.q.cam },
      perFrameMove: mv.map((v) => +v.toFixed(4)), perFrameRot: rot.map((v) => +v.toFixed(3)) };
    out.push(row);
    console.log(`${row.id.padEnd(8)} ${row.cam.padEnd(30)} travel ${row.travel}m  med ${row.medMove} peak ${row.peakMove}@${row.peakMoveAt}  rot med ${row.medRot} peak ${row.peakRot}°@${row.peakRotAt}  first12: ${row.first12Move}m ${row.first12Rot}°`);
  }
} finally { await r.close(); }
fs.writeFileSync(path.join(os.tmpdir(), "cam-trace.json"), JSON.stringify(out));
// the cuts: camera travel and change of view direction between the last frame of a shot and the first of the next
const fwd = (q: number[]) => { const [x, y, z, w] = q as [number, number, number, number]; return [-(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y))]; };
for (let i = 1; i < out.length; i++) {
  const a = out[i - 1] as { id: string; last: { p: number[]; q: number[] } }, b = out[i] as { id: string; first: { p: number[]; q: number[] } };
  const fa = fwd(a.last.q), fb = fwd(b.first.q);
  const yaw = (f: number[]) => Math.atan2(f[0]!, f[2]!);
  const dyaw = Math.abs(((yaw(fb) - yaw(fa) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * 180 / Math.PI;
  const dp = Math.hypot(...a.last.p.map((v, k) => b.first.p[k]! - v));
  console.log(`cut ${a.id} -> ${b.id}: camera moves ${dp.toFixed(2)} m, view direction turns ${dyaw.toFixed(0)}°`);
}
