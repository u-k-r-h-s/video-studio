// The first integrated 3D test: Director-format shots (the same JSON the AI Director writes: semantic actions, objects,
// shot size, camera motion) -> 3D compiler -> Three.js renderer -> shared FFmpeg post chain -> concat + soundtrack.
//   npx tsx scripts/lab/three3d/production-test.ts [--stills]        output: ~/Desktop/three3d-production-test.mp4
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Character, Shot, Story } from "@studio/shared";
import { compileShot3D } from "../../../apps/server/src/anim/renderers/three3d/compile";
import { Three3DRenderer } from "../../../apps/server/src/anim/renderers/three3d";
import { characterFile, castFor } from "../../../apps/server/src/anim/renderers/three3d/library";
import { mixTracks, toWav, type MixTrack } from "../../../apps/server/src/audio/mixer";
import { ambientNight, footsteps, tensionBed } from "../../../apps/server/src/audio/synth";
import { sfxSamples } from "../../../apps/server/src/audio/soundtrack";
import { loadConfig } from "../../../apps/server/src/config";
import { encodeWav } from "../../../apps/server/src/lib/wav";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const cfg = loadConfig({}, ROOT);
const OUT = process.env.OUT ?? path.join(os.homedir(), "Desktop", "three3d-production-test.mp4");
const W = Number(process.env.W ?? 1080), H = Number(process.env.H ?? 1920), FPS = 30;

// what the Director produces (the existing schema; nothing 3D-specific in it)
const rider: Character = { id: "rider", name: "Sam", description: "a night-shift delivery rider", appearance: "a young man with short brown hair", clothing: "orange courier jacket and dark trousers with a delivery bag", visualIdentity: "young man, orange courier jacket, delivery bag" };
const story: Pick<Story, "locations"> = { locations: [{ id: "warehouse", name: "Abandoned warehouse", description: "an abandoned warehouse at night, rain on the asphalt", visualIdentity: "abandoned corrugated-metal warehouse at night, wet asphalt, one lamp over a heavy door", lighting: "cold moonlight, a warm lamp over the door", importantObjects: ["door"] }] };
const base = { sceneId: "scene-01", locationId: "warehouse", subjectIds: ["rider"], visualPrompt: "", visualKey: "", dialogue: [], sfx: [], characterMotion: [], transition: { type: "cut" as const }, focus: { x: 0.5, y: 0.4 } };
const shots: Shot[] = [
  { ...base, id: "shot-01", order: 1, beat: "setup", duration: 4.8, shotType: "tracking", emotion: "uneasy", action: "Sam walks toward the dark warehouse door.", camera: { startScale: 1, endScale: 1, startX: 0.5, endX: 0.5, startY: 0.5, endY: 0.5 }, motion: { type: "tracking" },
    animation: { actions: [{ character: "rider", action: "walk", when: "start", toward: "the warehouse door" }, { character: "rider", action: "look-up", when: "end", toward: "the door" }], objects: [] } },
  { ...base, id: "shot-02", order: 2, beat: "curiosity", duration: 5.0, shotType: "over-shoulder", emotion: "tense", action: "He raises his flashlight and pushes the heavy door open; light spills out.", camera: { startScale: 1, endScale: 1, startX: 0.5, endX: 0.5, startY: 0.5, endY: 0.5 }, motion: { type: "push-in" },
    animation: { actions: [{ character: "rider", action: "raise-object", when: "start", toward: "the door" }, { character: "rider", action: "push", when: "mid", toward: "the door" }], objects: [{ object: "flashlight", action: "glow", when: "start" }, { object: "door", action: "open", when: "mid" }] } },
  { ...base, id: "shot-03", order: 3, beat: "escalation", duration: 4.2, shotType: "medium", emotion: "fear", action: "Something moves inside. He flinches and steps back; the camera pushes toward the dark entrance.", camera: { startScale: 1, endScale: 1, startX: 0.5, endX: 0.5, startY: 0.5, endY: 0.5 }, motion: { type: "push-in" },
    animation: { actions: [{ character: "rider", action: "raise-object", when: "start", toward: "inside" }, { character: "rider", action: "surprise", when: "early" }], objects: [{ object: "flashlight", action: "glow", when: "start" }] } },
] as unknown as Shot[];

const plate = path.join(ROOT, "assets/3d/plates/warehouse-night.png");
const wall = path.join(ROOT, "assets/3d/plates/corrugated-wall.png");
const renderer = new Three3DRenderer({ characterFile, imageFile: (k) => (fs.existsSync(k) ? k : null) });
const t0 = Date.now();
const clips: string[] = [];
const allCues: { kind: string; at: number; volume?: number }[] = [];
const report: Record<string, unknown>[] = [];
let tStart = 0;
try {
  for (const [i, shot] of shots.entries()) {
    const { spec, notes } = compileShot3D({ shot, story, characters: [rider], duration: shot.duration, width: W, height: H, fps: FPS, seed: 7 + i, cast: castFor, backdrop: () => (fs.existsSync(plate) ? plate : undefined), wallTexture: () => undefined, indexInScene: i });
    // continuity inside the scene: the door is already open in the last shot, the rider is already at the door
    if (i === 2) { spec.environment.objects.find((o) => o.id === "door")!.events = [{ at: -10, action: "open", duration: 0.01 }]; }
    console.log(`${shot.id}: ${notes.join(" | ")}`);
    if (process.argv.includes("--stills")) {
      const n = Math.round(shot.duration * FPS);
      const r = await renderer.stills(spec, [0, Math.round(n * 0.3), Math.round(n * 0.55), Math.round(n * 0.8), n - 1]);
      for (const [f, png] of r.frames) fs.writeFileSync(`/tmp/p3d-${shot.id}-${String(f).padStart(3, "0")}.png`, png);
      console.log(JSON.stringify(r.info));
      continue;
    }
    const out = path.join(os.tmpdir(), `p3d-${shot.id}.mp4`);
    const r = await renderer.render(spec, out, { ffmpeg: cfg.ffmpeg.ffmpeg, encoder: "h264_videotoolbox", bitrateKbps: 14000, fadeIn: i === 0 ? 0.4 : 0, fadeOut: i === shots.length - 1 ? 0.6 : 0, grade: { contrast: 1.05, saturation: 1.02, bloom: 0.28, grain: 5, vignette: 1.1 } });
    clips.push(out);
    for (const c of r.cues) allCues.push({ ...c, at: c.at + tStart });
    report.push({ shot: shot.id, frames: r.frames, renderMs: r.renderMs, ...r.info });
    tStart += shot.duration;
    console.log(`${shot.id}: ${r.frames} frames in ${(r.renderMs / 1000).toFixed(1)} s`);
  }
} finally {
  await renderer.close();
}
if (!process.argv.includes("--stills")) {
  const total = tStart;
  const step = footsteps(1, 0.5, 5);
  const tracks: MixTrack[] = [
    { type: "ambient", samples: ambientNight(total), startTime: 0, volume: 0.5 },
    { type: "music", samples: tensionBed(total, (t) => 0.15 + 0.6 * (t / total)), startTime: 0, volume: 0.28 },
  ];
  for (const c of allCues) tracks.push({ type: "sfx", samples: c.kind === "footsteps" ? step : sfxSamples(c.kind as Parameters<typeof sfxSamples>[0]), startTime: c.at, volume: c.volume ?? 0.5 });
  const wav = path.join(os.tmpdir(), "p3d-mix.wav"), list = path.join(os.tmpdir(), "p3d-concat.txt");
  fs.writeFileSync(wav, encodeWav(toWav(mixTracks(tracks, { totalSec: total }))));
  fs.writeFileSync(list, clips.map((c) => `file '${c}'`).join("\n") + "\n");
  execFileSync(cfg.ffmpeg.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-af", "loudnorm=I=-14:TP=-1.5:LRA=9,aresample=48000", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", OUT]);
  const stats = { out: OUT, seconds: total, totalSeconds: +((Date.now() - t0) / 1000).toFixed(1), sizeMB: +(fs.statSync(OUT).size / 1e6).toFixed(1), cues: allCues.length, shots: report };
  fs.writeFileSync(path.join(ROOT, "scripts/lab/three3d/production-test.json"), JSON.stringify(stats, null, 1));
  console.log(JSON.stringify(stats, null, 1));
}
