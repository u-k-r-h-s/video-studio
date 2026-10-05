// "The Last Delivery" re-made with the animation engine: layered 2.5D, a rigged character that walks, turns her head, reacts,
// a hand-held phone that lights up, a door that opens, weather, traffic, camera work and sound driven by the animation.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { AnimEngine, AssetLibrary } from "../../apps/server/src/anim/engine";
import { loadRig, makeDoorLeaf, makeLitPhone, makePole } from "../../apps/server/src/anim/loader";
import type { AnimShotSpec, AnimationEvent, AudioCue, EffectSpec, VisualLayer } from "../../apps/server/src/anim/types";
import { renderAnimShot } from "../../apps/server/src/anim/video";
import { mixTracks, toFloat44k, toWav, type MixTrack } from "../../apps/server/src/audio/mixer";
import { sfxSamples } from "../../apps/server/src/audio/soundtrack";
import { ambientNight, bandpass, footsteps, normalize, tensionBed, whiteNoise } from "../../apps/server/src/audio/synth";
import { createContainer } from "../../apps/server/src/container";
import { durationSec, encodeWav, parseWav, trimSilence } from "../../apps/server/src/lib/wav";
import { chunkLine, renderCaptionStates, type CaptionState } from "../../apps/server/src/shots/captions";
import { A, FPS, H, W, cfg } from "./anim-common";

const c = createContainer(cfg);
const tts = Object.values(c.svc.providers.tts)[0]!;
const OUT = `${A}/short`;
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- assets
const lib = new AssetLibrary();
for (const id of ["bg-street", "bg-hall", "bg-building"]) await lib.addImage(id, `${A}/assets/${id}.png`);
await lib.addImage("bg-street-soft", `${A}/assets/bg-street.png`, { blur: 5 });
await lib.addImage("bg-hall-soft", `${A}/assets/bg-hall.png`, { blur: 4 });
await lib.addImage("hand-phone", `${A}/cutouts/prop-hand-phone-n.png`);
await lib.addImage("car", `${A}/cutouts/prop-car.png`);
lib.images.set("pole", makePole());
lib.images.set("door", makeDoorLeaf(300, 470));
const screen: [number, number][] = [[126, 86], [370, 80], [372, 478], [132, 476]];
lib.images.set("phone-lit", await makeLitPhone(lib.images.get("hand-phone")!, screen));
lib.images.set("phone-msg", await makeLitPhone(lib.images.get("hand-phone")!, screen, { from: "UNKNOWN", lines: ["ONE LAST", "DELIVERY.", "APT 13"] }));
await loadRig(lib, A, "char-rider-d402", "mira");

// ---------------------------------------------------------------- voices
const VOICES = { mira: "en-c", double: "en-b" } as const;
const LINES = {
  heard: { who: "mira", text: "What was that?" },
  apt: { who: "mira", text: "Apartment thirteen? Nobody lives there." },
  hello: { who: "mira", text: "Hello?" },
  who: { who: "mira", text: "Who's there?!" },
  late: { who: "double", text: "You're late." },
} as const;
const dur: Record<string, number> = {}, files: Record<string, string> = {};
for (const [k, l] of Object.entries(LINES)) {
  const raw = `${OUT}/${k}.raw.wav`, out = `${OUT}/${k}.wav`;
  await tts.synthesize({ text: l.text, voiceId: VOICES[l.who], outPath: raw, lengthScale: 1.15 });
  const t = trimSilence(parseWav(fs.readFileSync(raw)));
  fs.writeFileSync(out, encodeWav(t.wav));
  dur[k] = durationSec(t.wav);
  files[k] = out;
}
console.log("voices:", Object.entries(dur).map(([k, v]) => `${k}=${v.toFixed(2)}s`).join(" "));

// ---------------------------------------------------------------- scene helpers
const ev = (targetId: string, type: AnimationEvent["type"], start: number, duration: number, params?: AnimationEvent["params"]): AnimationEvent => ({ targetId, type, start, duration, params });
const cam = (start: number, duration: number, params: AnimationEvent["params"]): AnimationEvent => ev("camera", "camera", start, duration, params);
const bgL = (id: string, over: Partial<VisualLayer> = {}): VisualLayer => ({ id: "bg", type: "background", source: id, x: W / 2, y: H / 2, scale: 1, opacity: 1, zIndex: 0, parallax: 0.55, height: H * 1.15, ...over });
const who = (id: string, over: Partial<VisualLayer> = {}): VisualLayer => ({ id, type: "character", source: "mira", x: 540, y: 1560, scale: 1, opacity: 1, zIndex: 20, height: 900, shadow: true, tint: "#10182c", tintAmount: 0.26, rim: { color: "#8fbaff", side: 1, amount: 0.45 }, ...over });
const close = { x: 540, y: 2020, height: 1500, tint: "#0c1426", tintAmount: 0.2 };
const phone = (y: number, over: Partial<VisualLayer> = {}): VisualLayer[] => [
  { id: "phone", type: "foreground", source: "hand-phone", x: 690, y, scale: 1, opacity: 1, zIndex: 40, height: 430, parallax: 1, ...over },
  { id: "phoneLit", type: "foreground", source: "phone-lit", x: 690, y, scale: 1, opacity: 0, zIndex: 41, height: 430, parallax: 1, attach: "phone" },
  { id: "phoneMsg", type: "foreground", source: "phone-msg", x: 690, y, scale: 1, opacity: 0, zIndex: 42, height: 430, parallax: 1, attach: "phone" },
];
const rain = (i = 0.8, angle = 12): EffectSpec => ({ type: "rain", intensity: i, layer: "front", angle });
const fog = (i = 0.5): EffectSpec => ({ type: "fog", intensity: i, layer: "back" });
const poles = (xs: number[]): VisualLayer[] => xs.map((x, i) => ({ id: `pole${i}`, type: "foreground" as const, source: "pole", x, y: 1990, scale: 1, opacity: 1, zIndex: 30, height: 1900, parallax: 1.4 }));

interface ShotDef { name: string; duration: number; layers: VisualLayer[]; events: AnimationEvent[]; effects: EffectSpec[]; line?: keyof typeof LINES; lineAt?: number; captionY?: number; insert?: { text: string; centerY: number; size?: number; start?: number }; fadeIn?: number; fadeOut?: number; cues?: AudioCue[]; camera?: Partial<AnimShotSpec["camera"]> }
const door = (over: Partial<VisualLayer> = {}): VisualLayer => ({ id: "door", type: "prop", source: "door", x: 553, y: 1633, scale: 1, opacity: 1, zIndex: 8, height: 854, parallax: 0.4, door: { hinge: "left", glow: "#ffcf8a" }, ...over });

const shots: ShotDef[] = [
  { // 1. the rider walks through the rainy street; a car passes behind her; the camera tracks her
    name: "walk", duration: 3.4,
    layers: [bgL("bg-street"), { id: "car", type: "midground", source: "car", x: -300, y: 1215, scale: 1, opacity: 1, zIndex: 10, height: 175, parallax: 0.55, flipX: true, tint: "#05080f", tintAmount: 0.6 }, who("mira", { x: 160 }), ...poles([760, 1560, 2360])],
    events: [ev("mira", "walk", 0.15, 3.1, { to: 1880 }), ev("car", "drive", 0.8, 1.9, { x: 2900, y: 1215 }), ev("car", "glow", 0.8, 1.9, { color: "#ffe1a8", radius: 300, amount: 0.8, sfx: "whoosh", sfxAt: 0.55 }),
      cam(0, 3.4, { mode: "follow", target: "mira", screenX: 0.38, tau: 0.35 }), cam(0, 3.4, { mode: "push", zoom: 1.1 })],
    effects: [fog(0.6), rain(0.9), { type: "lightFlicker", x: 1500, y: 640, radius: 700, color: "#ff9a5a", intensity: 0.8, layer: "front", seed: 3 }], fadeIn: 0.25,
  },
  { // 2. she stops, hears something, turns her head toward it; the camera creeps closer
    name: "listen", duration: 3.0,
    layers: [bgL("bg-street", { parallax: 0.5 }), who("mira", { x: 330 })],
    events: [ev("mira", "walk", 0, 0.8, { to: 640, ease: "out" }), ev("mira", "look-right", 1.0, 1, { ramp: 0.22 }), ev("mira", "lean", 1.0, 1.4, { angle: 6 }), ev("mira", "react", 1.05, 0.5, { strength: 0.025 }),
      cam(0, 3.0, { mode: "pan", x: 640, y: 1010 }), cam(0, 3.0, { mode: "push", zoom: 1.55 })],
    effects: [fog(0.7), rain(0.8), { type: "lightFlicker", x: 200, y: 700, radius: 620, color: "#6fe0ff", intensity: 0.7, layer: "front", seed: 8, speed: 1.6 }],
    line: "heard", lineAt: 1.25, cues: [{ kind: "door", at: 0.85, volume: 0.35 }, { kind: "heartbeat", at: 0.9, volume: 0.35 }], captionY: 0.78,
  },
  { // 3. the phone vibrates, rises into the hand, the screen lights; she looks down at it
    name: "phone", duration: 2.8,
    layers: [bgL("bg-street-soft", { parallax: 0.3 }), who("mira", close), ...phone(1950)],
    events: [ev("phone", "move", 0.15, 0.85, { x: 680, y: 1520, ease: "out" }), ev("phone", "shake", 0.15, 1.9, { amount: 5 }),
      ev("phoneLit", "fade", 0.8, 0.1, { to: 1 }), ev("phoneLit", "glow", 0.8, 2.0, { color: "#9fd6ff", radius: 230, amount: 0.55, sfx: "ping" }),
      ev("mira", "glow", 0.8, 2.0, { color: "#8fd0ff", amount: 0.9 }), ev("mira", "look-down", 0.5, 1, { ramp: 0.35 }),
      cam(0, 0.01, { mode: "pan", x: 560, y: 900 }), cam(0, 0.01, { mode: "push", zoom: 1.75 }), cam(0.01, 2.8, { mode: "push", zoom: 1.95 })],
    effects: [rain(0.35)], cues: [{ kind: "glitch", at: 0.15, volume: 0.25 }],
  },
  { // 4. the message appears; her expression changes
    name: "message", duration: 3.3,
    layers: [bgL("bg-street-soft", { parallax: 0.3 }), who("mira", close), ...phone(1480, { x: 640 })],
    events: [ev("phoneMsg", "fade", 0, 0.01, { to: 1 }), ev("phoneMsg", "glow", 0, 3.3, { color: "#9fd6ff", radius: 230, amount: 0.5 }), ev("phone", "shake", 0, 0.3, { amount: 3 }),
      ev("mira", "glow", 0, 3.3, { color: "#8fd0ff", amount: 0.8 }), ev("mira", "look-down", 0, 1, { ramp: 0.1 }), ev("mira", "look-center", 0.9, 1, { ramp: 0.25 }), ev("mira", "fear", 0.9, 2.2, { hold: false }),
      cam(0, 0.01, { mode: "pan", x: 560, y: 900 }), cam(0, 0.01, { mode: "push", zoom: 1.95 }), cam(0.01, 3.3, { mode: "push", zoom: 2.2 })],
    effects: [rain(0.3)], line: "apt", lineAt: 0.7, captionY: 0.2,
  },
  { // 5. she looks toward the building; the camera moves toward it
    name: "building", duration: 2.4,
    layers: [bgL("bg-building", { parallax: 0.35 }), door({ parallax: 0.35 }), who("mira", { x: 300, y: 1760, height: 1250, tint: "#0a1424", tintAmount: 0.3 })],
    events: [ev("mira", "turn", 0, 0.25, { to: "right" }), ev("mira", "look-right", 0.3, 1, { ramp: 0.3 }), ev("mira", "step-forward", 1.0, 0.8, { distance: 0.1 }),
      cam(0, 2.4, { mode: "pan", x: 700, y: 1000 }), cam(0, 2.4, { mode: "push", zoom: 1.28 })],
    effects: [fog(0.8), rain(0.7, 8), { type: "lightFlicker", x: 548, y: 1180, radius: 600, color: "#8fd8ff", intensity: 0.8, layer: "front", seed: 5 }],
    cues: [{ kind: "riser", at: 0.2, volume: 0.4 }],
  },
  { // 6. she walks to the door; it opens by itself
    name: "door", duration: 3.0,
    layers: [bgL("bg-building", { parallax: 0.35 }), door({ parallax: 0.35 }), who("mira", { x: 40, y: 1650, height: 1000, tint: "#0a1424", tintAmount: 0.3 })],
    events: [ev("mira", "walk", 0.1, 1.5, { to: 330, ease: "out" }), ev("door", "open", 2.0, 0.9), ev("door", "glow", 2.0, 1.0, { color: "#ffd9a0", radius: 520, amount: 0.9 }), ev("mira", "glow", 2.2, 0.8, { color: "#ffd9a0", amount: 0.8 }),
      ev("mira", "surprise", 2.25, 0.8, { strength: 0.04 }), cam(0, 3.0, { mode: "pan", x: 640, y: 1080 }), cam(0, 3.0, { mode: "push", zoom: 1.3 })],
    effects: [fog(0.8), rain(0.7, 8)], line: "hello", lineAt: 1.75, captionY: 0.78,
  },
  { // 7. the dark hallway: she comes toward the camera; the camera backs away; the lights sputter
    name: "hall", duration: 2.8,
    layers: [bgL("bg-hall", { parallax: 0.3 }), who("mira", { x: 330, y: 1330, scale: 0.42, tint: "#2a1c10", tintAmount: 0.3, rim: { color: "#ffd9a0", side: -1, amount: 0.5 } })],
    events: [ev("mira", "walk", 0.1, 2.5, { to: 540, y: 1780, scale: 1.0, ease: "inOut" }), cam(0, 2.8, { mode: "push", zoom: 1.0 })],
    effects: [fog(0.4), { type: "lightFlicker", x: 540, y: 420, radius: 800, color: "#ffe9c4", intensity: 0.9, layer: "front", seed: 2 }, { type: "dust", intensity: 0.6, layer: "front" }],
    cues: [{ kind: "riser", at: 0.3, volume: 0.45 }], camera: { zoom: 1.28, y: 1000 },
  },
  { // 8. something moves behind her; she spins around; the camera shakes
    name: "behind", duration: 2.5,
    layers: [bgL("bg-hall", { parallax: 0.3 }), who("double", { x: 300, y: 1370, scale: 0.46, opacity: 0, zIndex: 12, tint: "#d6e2ff", tintAmount: 0.55, shadow: false, rim: { color: "#ff6a6a", side: 1, amount: 0.5 } }),
      who("mira", { x: 520, y: 1780, height: 1100, tint: "#2a1c10", tintAmount: 0.3, rim: { color: "#ffd9a0", side: -1, amount: 0.5 } })],
    events: [ev("double", "fade", 0.1, 0.25, { to: 0.9 }), ev("double", "walk", 0.3, 1.2, { to: 380, y: 1470, scale: 0.6 }), ev("double", "flicker", 0.3, 1.5, { rate: 9, depth: 0.5, threshold: 0.3 }),
      ev("mira", "look-up", 0.35, 0.6, { ramp: 0.2 }), ev("mira", "turn", 0.85, 0.22, { to: "right" }), ev("mira", "fear", 0.9, 1.4, { hold: false }), ev("mira", "shake", 0.9, 1.2, { amount: 0.007 }),
      cam(0.9, 1.4, { mode: "shake", amount: 30, decay: 4 }), cam(0.9, 0.5, { mode: "flash", amount: 0.4 }), cam(0, 2.5, { mode: "push", zoom: 1.2 })],
    effects: [fog(0.4), { type: "lightFlicker", x: 540, y: 420, radius: 800, color: "#ffe9c4", intensity: 0.9, layer: "front", seed: 6, speed: 1.8 }],
    line: "who", lineAt: 1.0, cues: [{ kind: "glitch", at: 0.3, volume: 0.4 }, { kind: "heartbeat", at: 0.2, volume: 0.45 }], camera: { zoom: 1.0, y: 1000 }, captionY: 0.2,
  },
  { // 9. the reveal: her double smiles into the camera
    name: "reveal", duration: 2.6,
    layers: [bgL("bg-hall-soft", { parallax: 0.3 }), who("double", { ...close, tint: "#9db4dc", tintAmount: 0.38, rim: { color: "#ffffff", side: -1, amount: 0.6 } })],
    events: [ev("double", "head-turn", 0.05, 0.4, { to: "camera" }), ev("double", "smile", 0.35, 2.0, { hold: true }), ev("double", "flicker", 0, 1.0, { rate: 12, depth: 0.55, threshold: 0.4 }),
      cam(0, 0.01, { mode: "pan", x: 540, y: 780 }), cam(0, 0.01, { mode: "push", zoom: 1.9 }), cam(0.01, 2.6, { mode: "push", zoom: 2.3 }), cam(0, 0.5, { mode: "flash", amount: 0.5 })],
    effects: [{ type: "dust", intensity: 0.5, layer: "front" }, { type: "lightFlicker", x: 540, y: 300, radius: 700, color: "#cfe0ff", intensity: 0.7, layer: "front", seed: 11 }],
    line: "late", lineAt: 0.55, cues: [{ kind: "impact", at: 0, volume: 0.8 }, { kind: "glitch", at: 0.05, volume: 0.45 }], captionY: 0.82,
  },
  { // 10. both stand in the flickering hall; the lights die; the title
    name: "payoff", duration: 2.8,
    layers: [bgL("bg-hall", { parallax: 0.3 }), who("double", { x: 700, y: 1720, height: 1000, tint: "#9db4dc", tintAmount: 0.4, rim: { color: "#ffffff", side: -1, amount: 0.5 } }), who("mira", { x: 380, y: 1720, height: 1000, tint: "#2a1c10", tintAmount: 0.3 })],
    events: [ev("mira", "fear", 0, 2.4, { hold: false }), ev("mira", "look-left", 0.2, 1, { ramp: 0.3 }), ev("double", "smile", 0.1, 2.5, { hold: true }), ev("double", "look-left", 0.2, 1, { ramp: 0.3 }), ev("double", "nod", 1.0, 0.8, { count: 1 }), cam(0, 2.8, { mode: "push", zoom: 1.22 })],
    effects: [fog(0.5), { type: "lightFlicker", x: 540, y: 420, radius: 900, color: "#ffe9c4", intensity: 1, layer: "front", seed: 21, speed: 2.4 }],
    insert: { text: "THE LAST DELIVERY", centerY: 0.42, size: 118, start: 0.7 }, fadeOut: 1.0, cues: [{ kind: "glitch", at: 1.6, volume: 0.5 }],
  },
];

// ---------------------------------------------------------------- render
const tracks: MixTrack[] = [];
const clips: string[] = [];
let t0 = 0;
const caps = await import("../../apps/server/src/shots/captions");
for (const [i, s] of shots.entries()) {
  // a shot is at least as long as its spoken line plus a short tail
  const lineEnd = s.line ? (s.lineAt ?? 0.4) + dur[s.line]! : 0;
  const duration = Math.round(Math.max(s.duration, lineEnd + 0.45) * FPS) / FPS;
  const spec: AnimShotSpec = { id: s.name, duration, width: W, height: H, fps: FPS, layers: s.layers, events: s.events, effects: s.effects, camera: { x: W / 2, y: H / 2, zoom: 1, rotation: 0, ...s.camera }, seed: 7 + i };
  const engine = new AnimEngine(spec, lib);
  let captions: CaptionState[] = [];
  if (s.line) {
    const l = LINES[s.line];
    const chunks = chunkLine(l.text, s.lineAt ?? 0.4, (s.lineAt ?? 0.4) + dur[s.line]!, []);
    captions = await renderCaptionStates(c.runner, cfg.subtitles.helper, chunks, `${OUT}/captions`, { font: "Impact", size: 112, maxWidth: 960, stroke: 7, highlight: "FFD23F", emphasisColour: "FF4D3D" });
  }
  let insert: Parameters<typeof renderAnimShot>[2]["insert"];
  if (s.insert) {
    const png = `${OUT}/captions/insert-${s.name}.png`;
    execFileSync(cfg.subtitles.helper, [s.insert.text, "Impact", String(s.insert.size ?? 92), "960", png, "5", "0", "-1"]);
    const b = fs.readFileSync(png);
    insert = { png, start: s.insert.start ?? 0.05, end: duration, width: b.readUInt32BE(16), height: b.readUInt32BE(20), centerY: s.insert.centerY };
  }
  const out = `${OUT}/shot-${String(i + 1).padStart(2, "0")}-${s.name}.mp4`;
  const r = await renderAnimShot(engine, out, {
    ffmpeg: cfg.ffmpeg.ffmpeg, encoder: "h264_videotoolbox", bitrateKbps: 14000, captions, captionCenterY: s.captionY ?? 0.72, insert, fadeIn: s.fadeIn, fadeOut: s.fadeOut,
    grade: { contrast: 1.1, saturation: 1.08, gamma: 1.12, vignette: 1, grain: 8, bloom: 0.34, haze: 0, shadowTeal: 0.03, highlightWarm: 0.05, sharpen: 0.55 },
  });
  console.log(`shot ${i + 1} ${s.name.padEnd(9)} ${duration.toFixed(2)}s rendered in ${(r.renderMs / 1000).toFixed(1)}s`);
  clips.push(out);
  const step = footsteps(1, 0.5, 5);
  const cueList = [...engine.audioCues(), ...(s.cues ?? [])];
  for (const q of cueList) tracks.push({ type: "sfx", samples: q.kind === "footsteps" ? step : sfxSamples(q.kind as Parameters<typeof sfxSamples>[0]), startTime: t0 + q.at, volume: q.volume ?? 0.5 });
  if (s.line) tracks.push({ type: "voice", samples: toFloat44k(parseWav(fs.readFileSync(files[s.line]!))), startTime: t0 + (s.lineAt ?? 0.4), volume: 1 });
  t0 += duration;
}

// ---------------------------------------------------------------- audio + assembly
const total = t0;
const rainLoop = normalize(bandpass(whiteNoise(total, 3), 1800, 7500), 0.5);
tracks.push({ type: "ambient", samples: ambientNight(total), startTime: 0, volume: 0.32, fadeIn: 0.5, fadeOut: 1.0 });
tracks.push({ type: "ambient", samples: rainLoop, startTime: 0, volume: 0.16, fadeIn: 0.4, fadeOut: 1.2 });
tracks.push({ type: "music", samples: tensionBed(total, (t) => 0.15 + 0.85 * Math.pow(t / total, 1.3)), startTime: 0, volume: 0.42, fadeIn: 0.4, fadeOut: 1.4 });
const mix = mixTracks(tracks, { totalSec: total, duck: 0.55 });
fs.writeFileSync(`${OUT}/mix.wav`, encodeWav(toWav(mix)));
fs.writeFileSync(`${OUT}/concat.txt`, clips.map((p) => `file '${p}'`).join("\n") + "\n");
const final = `${OUT}/the-last-delivery-animated.mp4`;
execFileSync(cfg.ffmpeg.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", `${OUT}/concat.txt`, "-i", `${OUT}/mix.wav`, "-map", "0:v", "-map", "1:a",
  "-c:v", "copy", "-af", "loudnorm=I=-14:TP=-1.5:LRA=9,aresample=48000", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", final]);
console.log(`final ${total.toFixed(1)}s -> ${final}; ${tracks.length} audio tracks`);
void caps;
