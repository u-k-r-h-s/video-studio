// AI 3D character POC: one bright daytime shot through the production Three.js renderer (same Character3D runtime, rig
// discovery, locomotion, props, camera, lighting, FFmpeg post). Only the character asset changes.
//   npx tsx scripts/lab/three3d/ai-character-poc/render.ts [--asset casual-man|tripo|meshy] [--stills] [--out file.mp4]
// -> ~/Desktop/three3d-ai-character-poc-<asset>.mp4 + result-<asset>.json. tripo / meshy are read from the provider export
// folders (~/Downloads/ai-courier/<provider>/, see discover.ts); a missing folder stops here with a clear message.
// 0-2 s idle, 2-5 s walk, 5-7 s turn, 7-9 s reach for the parcel on a crate, 9-12 s hold and inspect it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Three3DRenderer } from "../../../../apps/server/src/anim/renderers/three3d";
import { characterFile } from "../../../../apps/server/src/anim/renderers/three3d/library";
import type { CharacterSpec3D, Shot3DSpec } from "../../../../apps/server/src/anim/renderers/three3d/spec";
import { mixTracks, toWav, type MixTrack } from "../../../../apps/server/src/audio/mixer";
import { ambientNight, footsteps } from "../../../../apps/server/src/audio/synth";
import { sfxSamples } from "../../../../apps/server/src/audio/soundtrack";
import { loadConfig } from "../../../../apps/server/src/config";
import { encodeWav } from "../../../../apps/server/src/lib/wav";

const ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const cfg = loadConfig({}, ROOT);
const args = process.argv.slice(2);
const opt = (k: string): string | undefined => args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const asset = opt("--asset") ?? "casual-man";
const stills = args.includes("--stills");
const OUT = opt("--out") ?? path.join(os.homedir(), "Desktop", `three3d-ai-character-poc-${asset}.mp4`);
// the same resolution the renderer uses; never falls back to another character
let glb: string;
try { glb = characterFile(asset); if (!fs.existsSync(glb)) throw new Error(`3D character "${asset}" not found (no ${glb})`); }
catch (e) { console.error((e as Error).message); process.exit(1); }
const W = Number(process.env.W ?? 1080), H = Number(process.env.H ?? 1920), FPS = 30, DURATION = 12;

// where things are (neighbourhood kit: house door at (0, -8), sidewalk along z ~ 2.5)
const START = { x: -2.9, z: 2.45 }, STOP = { x: 0.8, z: 2.45 };
const CRATE = { x: 1.55, z: 1.45, scale: 0.85 }; // a parcel drop box on the lawn edge, ahead and to the side, ~0.77 m high
const PARCEL = { x: 1.25, y: 0.77 + 0.11, z: 1.92 }; // on the near corner of the crate

const courier: CharacterSpec3D = {
  id: "courier",
  asset,
  start: { x: START.x, z: START.z, heading: Math.PI / 2 }, // facing +x, along the sidewalk
  // the Quaternius base model is dressed for the brief (blue jacket, dark trousers, courier bag); a generated model wears its own clothes
  wardrobe: asset === "casual-man" ? { LightBrown: "#2d4f86", LightBlue: "#22252b" } : undefined,
  props: [
    ...(asset === "casual-man" ? [{ id: "bag", kind: "bag" as const, socket: "back" as const, color: "#d4692a" }] : []),
    { id: "parcel", kind: "box", socket: "rightHand", restAt: { ...PARCEL, rotation: 0.15 } },
  ],
  events: [
    { at: 0.6, action: "look", target: { x: 2.5, y: 1.4, z: 0 }, duration: 1.1 }, // idle: a glance up the street
    { at: 2.0, action: "walk", target: STOP },
    { at: 5.2, action: "turn", target: { x: PARCEL.x + 0.6, z: PARCEL.z - 0.6 } }, // turns to the crate
    { at: 5.4, action: "look", target: PARCEL, duration: 1.6 },
    { at: 7.0, action: "reach", target: PARCEL, duration: 1.1 },
    { at: 8.15, action: "hold", prop: "parcel" },
    { at: 9.1, action: "raise", prop: "parcel", target: { x: STOP.x + 0.24, y: 1.15, z: STOP.z - 0.26 }, duration: 0.7 }, // brings it up to read the label
    { at: 10.9, action: "look", target: "camera", duration: 1.0 },
  ],
};

const spec: Shot3DSpec = {
  id: "ai-character-poc", duration: DURATION, width: W, height: H, fps: FPS, seed: 11,
  lighting: "sunny-day",
  environment: {
    kind: "neighborhood",
    objects: [
      { id: "door", kind: "door", x: 0, z: -8, params: { width: 1.1, height: 2.15, hinge: "left", glow: "#ffd9a6", cold: "#6f9dff" }, events: [] },
      { id: "crate", kind: "crate", x: CRATE.x, z: CRATE.z, scale: CRATE.scale },
      { id: "car", kind: "car", x: 7.5, z: 6.2, params: { color: "#e0b03a" } },
    ],
    weather: { rain: 0, wind: 0.5 },
    palette: { wall: "#e9e1d0", door: "#2f5d50", trim: "#fbf8f1", roof: "#5b4a42" },
  },
  characters: [courier],
  camera: {
    // wide three-quarter view of the walk, then it settles into a medium for the reach and the parcel
    shot: "wide", move: "follow", target: "courier", angle: 1.15, side: 1,
    // walk: wide follow; turn + reach: the courier and the crate in one frame; inspect: in close on the face and the parcel
    keys: [{ at: 5.0, shot: "medium", blend: 1.6, frameWith: "crate" }, { at: 9.0, shot: "closeup", blend: 1.4, frameWith: null }],
  },
};

// peak memory of this process + the headless Chrome it starts (the whole process tree)
let peakMB = 0;
const sampler = setInterval(() => {
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="]).toString().trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map<number, number[]>();
    for (const [pid, ppid] of rows) kids.set(ppid!, [...(kids.get(ppid!) ?? []), pid!]);
    const rss = new Map(rows.map(([pid, , r]) => [pid!, r!]));
    let sum = 0; const stack = [process.pid];
    while (stack.length) { const p = stack.pop()!; sum += rss.get(p) ?? 0; stack.push(...(kids.get(p) ?? [])); }
    peakMB = Math.max(peakMB, sum / 1024);
  } catch { /* ps not available */ }
}, 400);

console.log(`character: ${asset} -> ${glb.replace(os.homedir(), "~")}`);
const renderer = new Three3DRenderer({ characterFile, imageFile: (k) => (fs.existsSync(k) ? k : null) });
const t0 = Date.now();
try {
  if (stills) {
    const frames = [15, 75, 135, 180, 225, 255, 300, 345];
    const r = await renderer.stills(spec, frames);
    for (const [f, png] of r.frames) fs.writeFileSync(`/tmp/aichar-${asset}-${String(f).padStart(3, "0")}.png`, png);
    console.log(JSON.stringify(r.info));
  } else {
    const clip = path.join(os.tmpdir(), `aichar-${asset}.mp4`);
    const r = await renderer.render(spec, clip, { ffmpeg: cfg.ffmpeg.ffmpeg, encoder: "h264_videotoolbox", bitrateKbps: 16000, fadeIn: 0.4, fadeOut: 0.6, grade: { contrast: 1.04, saturation: 1.06, bloom: 0.12, grain: 3, vignette: 0.6 } });
    const step = footsteps(1, 0.5, 5);
    const tracks: MixTrack[] = [{ type: "ambient", samples: ambientNight(DURATION), startTime: 0, volume: 0.22 }];
    for (const c of r.cues) tracks.push({ type: "sfx", samples: c.kind === "footsteps" ? step : sfxSamples(c.kind), startTime: c.at, volume: c.volume ?? 0.5 });
    const wav = path.join(os.tmpdir(), `aichar-${asset}.wav`);
    fs.writeFileSync(wav, encodeWav(toWav(mixTracks(tracks, { totalSec: DURATION }))));
    execFileSync(cfg.ffmpeg.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", clip, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", OUT]);
    const report = {
      asset, out: OUT, glbMB: +(fs.statSync(glb).size / 1e6).toFixed(2), seconds: DURATION, frames: r.frames,
      totalSeconds: +((Date.now() - t0) / 1000).toFixed(1), hostMsPerFrame: Math.round(r.renderMs / r.frames),
      glMsPerFrame: +(Number(r.info.renderMs) / r.frames).toFixed(2), peakMemoryMB: Math.round(peakMB), sizeMB: +(fs.statSync(OUT).size / 1e6).toFixed(1), ...r.info,
    };
    fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), `result-${asset}.json`), `${JSON.stringify(report, null, 1)}\n`);
    console.log(JSON.stringify(report, null, 1));
  }
} finally { clearInterval(sampler); await renderer.close(); }
