// Renders a test scene (scenes.ts) through the production 3D path: Director-format shots -> compileShot3D -> Three.js
// renderer -> shared FFmpeg post chain -> concat + soundtrack.
//   npx tsx scripts/lab/three3d/render-scene.ts <night|day> [--stills] [--out file.mp4]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileShot3D } from "../../../apps/server/src/anim/renderers/three3d/compile";
import { Three3DRenderer } from "../../../apps/server/src/anim/renderers/three3d";
import { characterFile, castFor } from "../../../apps/server/src/anim/renderers/three3d/library";
import { mixTracks, toWav, type MixTrack } from "../../../apps/server/src/audio/mixer";
import { ambientNight, footsteps, tensionBed } from "../../../apps/server/src/audio/synth";
import { sfxSamples } from "../../../apps/server/src/audio/soundtrack";
import { loadConfig } from "../../../apps/server/src/config";
import { encodeWav } from "../../../apps/server/src/lib/wav";
import { DAY, NIGHT } from "./scenes";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const cfg = loadConfig({}, ROOT);
const args = process.argv.slice(2);
const scene = args[0] === "day" ? DAY : NIGHT;
const stills = args.includes("--stills");
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1]! : path.join(os.homedir(), "Desktop", `three3d-quality-${scene.name}-v2.mp4`);
const W = Number(process.env.W ?? 1080), H = Number(process.env.H ?? 1920), FPS = 30;
const plate = path.join(ROOT, "assets/3d/plates/warehouse-night.png");
const only = process.env.SHOTS?.split(",");

const renderer = new Three3DRenderer({ characterFile, imageFile: (k) => (fs.existsSync(k) ? k : null) });
const t0 = Date.now();
const clips: string[] = [], allCues: { kind: string; at: number; volume?: number }[] = [], report: Record<string, unknown>[] = [];
let tStart = 0;
try {
  for (const [i, shot] of scene.shots.entries()) {
    if (only && !only.includes(shot.id)) { tStart += shot.duration; continue; }
    const { spec, notes } = compileShot3D({ shot, story: scene.story, characters: scene.characters, duration: shot.duration, width: W, height: H, fps: FPS, seed: 7 + i, cast: castFor, backdrop: () => (fs.existsSync(plate) && scene.name === "night" ? plate : undefined), indexInScene: i });
    scene.continuity?.(i, spec);
    console.log(`${shot.id} [${spec.lighting}, ${spec.environment.kind}, cam ${spec.camera.shot}/${spec.camera.move}]: ${notes.join(" | ")}`);
    if (stills) {
      const n = Math.round(shot.duration * FPS);
      const r = await renderer.stills(spec, [2, Math.round(n * 0.3), Math.round(n * 0.55), Math.round(n * 0.8), n - 1]);
      for (const [f, png] of r.frames) fs.writeFileSync(`/tmp/q2-${scene.name}-${shot.id}-${String(f).padStart(3, "0")}.png`, png);
      continue;
    }
    const out = path.join(os.tmpdir(), `q2-${scene.name}-${shot.id}.mp4`);
    const r = await renderer.render(spec, out, { ffmpeg: cfg.ffmpeg.ffmpeg, encoder: "h264_videotoolbox", bitrateKbps: 16000, fadeIn: i === 0 ? 0.4 : 0, fadeOut: i === scene.shots.length - 1 ? 0.6 : 0, grade: scene.name === "day" ? { contrast: 1.04, saturation: 1.06, bloom: 0.12, grain: 3, vignette: 0.6 } : { contrast: 1.05, saturation: 1.02, bloom: 0.26, grain: 5, vignette: 1.05 } });
    clips.push(out);
    for (const c of r.cues) allCues.push({ ...c, at: c.at + tStart });
    report.push({ shot: shot.id, frames: r.frames, hostMs: r.renderMs, ...r.info });
    tStart += shot.duration;
    console.log(`${shot.id}: ${r.frames} frames in ${(r.renderMs / 1000).toFixed(1)} s`);
  }
} finally { await renderer.close(); }
if (!stills) {
  const total = tStart, step = footsteps(1, 0.5, 5);
  const tracks: MixTrack[] = [{ type: "ambient", samples: ambientNight(total), startTime: 0, volume: scene.name === "day" ? 0.25 : 0.5 }];
  if (scene.name === "night") tracks.push({ type: "music", samples: tensionBed(total, (t) => 0.15 + 0.6 * (t / total)), startTime: 0, volume: 0.28 });
  for (const c of allCues) tracks.push({ type: "sfx", samples: c.kind === "footsteps" ? step : sfxSamples(c.kind as Parameters<typeof sfxSamples>[0]), startTime: c.at, volume: c.volume ?? 0.5 });
  const wav = path.join(os.tmpdir(), `q2-${scene.name}.wav`), list = path.join(os.tmpdir(), `q2-${scene.name}.txt`);
  fs.writeFileSync(wav, encodeWav(toWav(mixTracks(tracks, { totalSec: total }))));
  fs.writeFileSync(list, clips.map((c) => `file '${c}'`).join("\n") + "\n");
  execFileSync(cfg.ffmpeg.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", "loudnorm=I=-14:TP=-1.5:LRA=9,aresample=48000", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", OUT]);
  const stats = { out: OUT, seconds: +total.toFixed(2), totalSeconds: +((Date.now() - t0) / 1000).toFixed(1), sizeMB: +(fs.statSync(OUT).size / 1e6).toFixed(1), cues: allCues.length, shots: report };
  fs.writeFileSync(path.join(ROOT, `scripts/lab/three3d/quality-${scene.name}-v2.json`), JSON.stringify(stats, null, 1));
  console.log(JSON.stringify({ ...stats, shots: undefined }));
}
