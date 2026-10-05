// The animation test video: five short scenes that must make the movement obvious (walk, head turn, object interaction,
// living environment, action). Output: projects/anim-lab/out/animation-test.mp4
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { AnimEngine } from "../../apps/server/src/anim/engine";
import { makeLitPhone } from "../../apps/server/src/anim/loader";
import { renderAnimShot } from "../../apps/server/src/anim/video";
import type { AnimShotSpec, AnimationEvent, AudioCue } from "../../apps/server/src/anim/types";
import { mixTracks, toWav, type MixTrack } from "../../apps/server/src/audio/mixer";
import { SR, ambientNight, footsteps, tensionBed } from "../../apps/server/src/audio/synth";
import { sfxSamples } from "../../apps/server/src/audio/soundtrack";
import { encodeWav } from "../../apps/server/src/lib/wav";
import { A, bg, cfg, loadLab, mira, spec } from "./anim-common";

const { lib } = await loadLab();
lib.images.set("hand-phone-lit", await makeLitPhone(lib.images.get("hand-phone")!, [[126, 86], [370, 80], [372, 478], [132, 476]]));
const OUT = `${A}/out`;
const ev = (targetId: string, type: AnimationEvent["type"], start: number, duration: number, params?: AnimationEvent["params"]): AnimationEvent => ({ targetId, type, start, duration, params });
const camera = (start: number, duration: number, params: AnimationEvent["params"]): AnimationEvent => ev("camera", "camera", start, duration, params);
const closeMira = { x: 540, y: 2020, height: 1500, tint: "#0c1426", tintAmount: 0.22 };

const tests: { label: string; spec: AnimShotSpec }[] = [
  { label: "TEST 1 - WALKING", spec: spec("t1", 3.4, [bg("bg-street"), mira({ x: 120 })], [ev("mira", "walk", 0.1, 3.0, { to: 960 })], [{ type: "fog", intensity: 0.5, layer: "back" }, { type: "rain", intensity: 0.7, layer: "front" }]) },
  { label: "TEST 2 - HEAD TURN", spec: spec("t2", 4.4, [bg("bg-street-soft", { parallax: 0.3 }), mira(closeMira)], [
    ev("mira", "look-left", 0.4, 1, { ramp: 0.3 }), ev("mira", "look-right", 1.5, 1, { ramp: 0.3 }), ev("mira", "head-turn", 2.5, 0.6, { to: "camera" }), ev("mira", "nod", 3.3, 0.9, { count: 2 }),
    camera(0, 0.01, { mode: "pan", x: 540, y: 780 }), camera(0, 0.01, { mode: "push", zoom: 1.9 }), camera(0.01, 4.4, { mode: "push", zoom: 2.25 }),
  ], [{ type: "rain", intensity: 0.4, layer: "front" }, { type: "dust", intensity: 0.5, layer: "front" }]) },
  { label: "TEST 3 - PHONE", spec: spec("t3", 4.6, [
    bg("bg-street-soft", { parallax: 0.3 }), mira(closeMira),
    { id: "phone", type: "foreground", source: "hand-phone", x: 690, y: 1950, scale: 1, opacity: 1, zIndex: 40, height: 430, parallax: 1 },
    { id: "phoneLit", type: "foreground", source: "hand-phone-lit", x: 690, y: 1950, scale: 1, opacity: 0, zIndex: 41, height: 430, parallax: 1, attach: "phone" },
  ], [
    ev("phone", "move", 0.2, 1.1, { x: 680, y: 1520, ease: "out" }), ev("phone", "shake", 1.35, 0.5, { amount: 4 }), ev("phone", "move", 2.3, 1.4, { x: 640, y: 1480 }),
    ev("phoneLit", "fade", 1.3, 0.12, { to: 1 }), ev("phoneLit", "glow", 1.3, 3.0, { color: "#9fd6ff", radius: 230, amount: 0.55, sfx: "ping" }),
    ev("mira", "glow", 1.3, 3.0, { color: "#8fd0ff", amount: 0.9 }), ev("mira", "look-down", 0.9, 1, { ramp: 0.4 }), ev("mira", "look-center", 2.6, 1, { ramp: 0.25 }), ev("mira", "surprise", 3.0, 1.0),
    camera(0, 0.01, { mode: "pan", x: 560, y: 900 }), camera(0, 0.01, { mode: "push", zoom: 1.75 }), camera(0.01, 4.6, { mode: "push", zoom: 1.95 }),
  ], [{ type: "rain", intensity: 0.35, layer: "front" }]) },
  { label: "TEST 4 - ENVIRONMENT", spec: spec("t4", 4.4, [bg("bg-street"), mira({ x: 560 })], [
    ev("mira", "look-right", 1.6, 1, { ramp: 0.3 }), ev("mira", "look-left", 3.0, 1, { ramp: 0.3 }),
    camera(0, 4.4, { mode: "pan", x: 640, y: 960 }), camera(0, 4.4, { mode: "push", zoom: 1.12 }),
  ], [{ type: "fog", intensity: 0.8, layer: "back", speed: 1.4 }, { type: "rain", intensity: 1, layer: "front", angle: 16 }, { type: "lightFlicker", x: 880, y: 640, radius: 760, color: "#ff9a5a", intensity: 0.9, layer: "front", seed: 3 }, { type: "lightFlicker", x: 190, y: 700, radius: 620, color: "#6fe0ff", intensity: 0.7, layer: "front", seed: 8, speed: 1.6 }, { type: "dust", intensity: 0.5, layer: "front" }]) },
  { label: "TEST 5 - ACTION", spec: spec("t5", 5.0, [
    bg("bg-street", { parallax: 0.55 }), mira({ x: -260 }),
    ...[900, 1900, 2900, 3900].map((x, i) => ({ id: `pole${i}`, type: "foreground" as const, source: "pole", x, y: 1990, scale: 1, opacity: 1, zIndex: 30, height: 1900, parallax: 1.4 })),
  ], [
    ev("mira", "run", 0, 0.8, { to: 380, ease: "in" }), ev("mira", "run", 0.8, 2.1, { to: 2300, ease: "linear" }),
    ev("mira", "surprise", 2.95, 1.0), ev("mira", "look-up", 3.6, 1, { ramp: 0.3 }),
    camera(0, 5, { mode: "follow", target: "mira", screenX: 0.38, tau: 0.3 }), camera(0, 2.9, { mode: "push", zoom: 1.12 }),
    camera(2.9, 1.2, { mode: "shake", amount: 34, decay: 4.5 }), camera(2.9, 0.6, { mode: "flash", amount: 0.55 }),
  ], [{ type: "streaks", intensity: 0.9, layer: "front", start: 0.3, end: 3.0 }, { type: "rain", intensity: 0.8, layer: "front", angle: 22 }, { type: "fog", intensity: 0.5, layer: "back" }, { type: "sparks", x: 2300, y: 1500, start: 2.95, layer: "front", intensity: 1 }]) },
];

const clips: string[] = [];
const cues: AudioCue[] = [];
const starts: number[] = [];
let t0 = 0;
for (const [i, t] of tests.entries()) {
  const png = `${OUT}/label-${i + 1}.png`;
  execFileSync(cfg.subtitles.helper, [t.label, "Impact", "64", "900", png, "5", "0.5"]);
  const b = fs.readFileSync(png);
  const engine = new AnimEngine(t.spec, lib);
  const out = `${OUT}/t${i + 1}.mp4`;
  const r = await renderAnimShot(engine, out, { ffmpeg: cfg.ffmpeg.ffmpeg, encoder: "h264_videotoolbox", bitrateKbps: 14000, insert: { png, start: 0, end: t.spec.duration, width: b.readUInt32BE(16), height: b.readUInt32BE(20), centerY: 0.07 } });
  console.log(t.label, `${t.spec.duration}s rendered in ${(r.renderMs / 1000).toFixed(1)}s`);
  clips.push(out);
  starts.push(t0);
  for (const c of engine.audioCues()) cues.push({ ...c, at: c.at + t0 });
  t0 += t.spec.duration;
}

// audio: ambience + tension bed + the sounds the animation implies (footsteps on foot contacts, ping, impact)
const total = t0;
const step = footsteps(1, 0.5, 5);
const tracks: MixTrack[] = [
  { type: "ambient", samples: ambientNight(total), startTime: 0, volume: 0.35 },
  { type: "music", samples: tensionBed(total, (t) => 0.2 + 0.5 * (t / total)), startTime: 0, volume: 0.3 },
];
for (const c of cues) {
  const samples = c.kind === "footsteps" ? step : sfxSamples(c.kind as Parameters<typeof sfxSamples>[0]);
  tracks.push({ type: "sfx", samples, startTime: c.at, volume: c.volume ?? 0.5 });
}
const mix = mixTracks(tracks, { totalSec: total });
fs.writeFileSync(`${OUT}/test-mix.wav`, encodeWav(toWav(mix)));
fs.writeFileSync(`${OUT}/test-concat.txt`, clips.map((c) => `file '${c}'`).join("\n") + "\n");
execFileSync(cfg.ffmpeg.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", `${OUT}/test-concat.txt`, "-i", `${OUT}/test-mix.wav`, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", `${OUT}/animation-test.mp4`]);
console.log("cues:", cues.length, "->", `${OUT}/animation-test.mp4`, `${total}s`);
void SR;
