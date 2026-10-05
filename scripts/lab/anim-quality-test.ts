// Animation quality test (~10 s, no story): walk 4 steps, stop and listen, raise an arm, raise a flashlight and point it into the
// dark, react, turn and run away; rain + fog + a flickering lamp. Uses the puppet built from a character generated over the mannequin.
//   npx tsx scripts/lab/anim-quality-test.ts [--frames out.png t1 t2 ...]
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import { AnimEngine, AssetLibrary } from "../../apps/server/src/anim/engine";
import { makeCutout, readRgba } from "../../apps/server/src/anim/assets";
import { addPuppetFace, buildPuppet, puppetHeadCrop } from "../../apps/server/src/anim/puppet";
import { makeFlashlight } from "../../apps/server/src/anim/loader";
import { renderAnimShot } from "../../apps/server/src/anim/video";
import { audioCuesFor } from "../../apps/server/src/anim/cues";
import { mixTracks, toWav, type MixTrack } from "../../apps/server/src/audio/mixer";
import { ambientNight, footsteps } from "../../apps/server/src/audio/synth";
import { sfxSamples } from "../../apps/server/src/audio/soundtrack";
import { encodeWav } from "../../apps/server/src/lib/wav";
import type { AnimShotSpec, AnimationEvent, VisualLayer } from "../../apps/server/src/anim/types";
import { cfg, ROOT } from "./anim-common";

const P = `${ROOT}/projects/anim-lab/puppet`;
const CHAR = process.env.QT_CHAR ?? "mq-keeper-d0.78-s701";
const BG = process.env.QT_BG ?? `${ROOT}/projects/create-a-25-second-animated-mystery-fcfe2b/images/anim/loc-lighthouse-interior.png`;
const lib = new AssetLibrary();
await lib.addImage("bg", BG);
await lib.addImage("bg-soft", BG, { blur: 4 });
lib.images.set("torch", makeFlashlight());
const raw = await readRgba(`${P}/${CHAR}.png`), matte = await readRgba(`${P}/${CHAR}-matte.png`);
const { cut, box } = makeCutout(raw, matte, true);
const pup = await buildPuppet("keeper", cut, { box });
for (const v of ["surprised", "worried", "smile"]) {
  const f = `${P}/${CHAR}-face-${v}.png`;
  if (fs.existsSync(f)) await addPuppetFace(pup, v, await readRgba(f), puppetHeadCrop(pup));
}
lib.addPuppet(pup);
console.log("puppet:", pup.report.armsSeparated, pup.report.legsSeparated, Object.keys(pup.faces));

const D = 9.6;
const ev = (targetId: string, type: AnimationEvent["type"], start: number, duration: number, params?: AnimationEvent["params"]): AnimationEvent => ({ targetId, type, start, duration, ...(params ? { params } : {}) });
const layers: VisualLayer[] = [
  { id: "bg", type: "background", source: "bg", x: 540, y: 960, scale: 1, opacity: 1, zIndex: 0, parallax: 0.55, height: 1920 * 1.15 },
  { id: "keeper", type: "character", source: "keeper", x: -160, y: 1770, scale: 1, opacity: 1, zIndex: 20, height: 980, shadow: true, tint: "#0e1a30", tintAmount: 0.22, rim: { color: "#9cc4ff", side: 1, amount: 0.5 } },
  { id: "torch", type: "prop", source: "torch", x: 0, y: 0, scale: 1, opacity: 1, zIndex: 21, parent: { layerId: "keeper", hand: "near" }, grip: { x: 0.22, y: 0.5, axis: 0, size: 0.17 }, beam: { color: "#fff1c4", length: 1500, spread: 13, intensity: 0 } },
];
const events: AnimationEvent[] = [
  ev("keeper", "hold", 0, 0.01, { hand: "near" }),
  ev("keeper", "walk", 0.15, 2.75, { to: 1000 }), // 1. walk
  ev("keeper", "listen", 3.0, 0.9, { to: "left" }), // 2. stop, turn the head toward a sound
  ev("keeper", "raise-hand", 3.95, 1.0, { hand: "far" }), // 3. raise an arm
  ev("keeper", "raise-object", 5.0, 0.45), // 4. raise the flashlight and point it
  ev("torch", "glow", 5.15, 1.9, { amount: 1, in: 0.1, out: 0.2 }),
  ev("keeper", "lower-object", 7.05, 0.35),
  ev("keeper", "surprise", 7.1, 0.7, { strength: 0.05 }), // 5. react
  ev("camera", "camera", 7.1, 0.5, { mode: "shake", amount: 14 }),
  ev("keeper", "fear", 7.55, 2.6, { hold: true }),
  ev("keeper", "run", 7.7, 1.9, { to: -1300, ease: "in" }), // 6. run away
  ev("camera", "camera", 0, 7.8, { mode: "follow", target: "keeper", lead: 120, tau: 0.35 }), // then the camera holds and he runs out of frame
];
const spec: AnimShotSpec = {
  id: "quality", duration: D, width: 1080, height: 1920, fps: 30, layers, events,
  effects: [
    { type: "fog", intensity: 0.45, layer: "back" }, { type: "rain", intensity: 0.75, layer: "front", angle: 12 },
    { type: "lightFlicker", intensity: 0.5, x: 860, y: 520, radius: 520, color: "#ffcf8a", layer: "back" },
  ],
  camera: { x: 540, y: 960, zoom: 1, rotation: 0 }, seed: 11,
};
// the beam is driven by the torch's glow event
spec.layers[2]!.beam!.intensity = 1;
const engine = new AnimEngine(spec, lib);

const argv = process.argv.slice(2);
if (argv[0] === "--frames") {
  const out = argv[1]!, ts = argv.slice(2).map(Number);
  const W = 360, H = 640, sheet = createCanvas(W * ts.length, H), sg = sheet.getContext("2d"), fr = createCanvas(1080, 1920), fg = fr.getContext("2d");
  const [cx, cy, cw2, ch2] = (process.env.QT_CROP ?? "0,500,1080,1420").split(",").map(Number) as [number, number, number, number];
  ts.forEach((t, i) => { engine.renderFrame(fg, t); sg.drawImage(fr, cx, cy, cw2, ch2, i * W, 0, W, H); });
  fs.writeFileSync(out, sheet.toBuffer("image/png"));
  process.exit(0);
}
const OUT = `${P}/out`;
fs.mkdirSync(OUT, { recursive: true });
const r = await renderAnimShot(engine, `${OUT}/qt-video.mp4`, { ffmpeg: cfg.ffmpeg.ffmpeg, encoder: "h264_videotoolbox", bitrateKbps: 14000, fadeIn: 0.2, fadeOut: 0.3 });
const step = footsteps(1, 0.5, 5);
const tracks: MixTrack[] = [{ type: "ambient", samples: ambientNight(D), startTime: 0, volume: 0.45 }];
for (const c of audioCuesFor(spec)) tracks.push({ type: "sfx", samples: c.kind === "footsteps" ? step : sfxSamples(c.kind as Parameters<typeof sfxSamples>[0]), startTime: c.at, volume: c.volume ?? 0.5 });
fs.writeFileSync(`${OUT}/qt-mix.wav`, encodeWav(toWav(mixTracks(tracks, { totalSec: D }))));
const final = process.env.QT_OUT ?? `${ROOT}/../animation-quality-test.mp4`;
execFileSync(cfg.ffmpeg.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", `${OUT}/qt-video.mp4`, "-i", `${OUT}/qt-mix.wav`, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", final]);
console.log(`rendered ${r.frames} frames in ${(r.renderMs / 1000).toFixed(1)} s -> ${final}`);
