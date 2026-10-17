/**
 * Renders a hand-written Three.js shot spec to an MP4 (with an optional voice line, lip-synced) through the production
 * renderer and FFmpeg post chain, and writes the motion trace of the same spec next to it.
 * Usage: npx tsx scripts/lab/three3d/v3/render-spec.ts <spec.json> <out.mp4>
 *   spec.json = Shot3DSpec plus optional "_voice": { character, voice, text, at } (Piper, config/voices.json)
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Three3DRenderer } from "../../../../apps/server/src/anim/renderers/three3d/index";
import { characterFile } from "../../../../apps/server/src/anim/renderers/three3d/library";
import type { Shot3DSpec } from "../../../../apps/server/src/anim/renderers/three3d/spec";
import { speechTrack } from "../../../../apps/server/src/anim/lipsync";
import { loadVoiceCatalog } from "../../../../apps/server/src/providers/tts/voices";
import { analyse, events, fromBrowserTrace } from "../motion/trace";

const [specFile, out] = process.argv.slice(2) as [string, string];
const raw = JSON.parse(fs.readFileSync(specFile, "utf8")) as Shot3DSpec & { _voice?: { character: string; voice: string; text: string; at: number }[] };
const spec: Shot3DSpec = { ...raw, trace: true };
delete (spec as { _voice?: unknown })._voice;
const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((f) => fs.existsSync(f))!;
const tmp = fs.mkdtempSync("/tmp/v3-"), wavs: { file: string; at: number }[] = [];
for (const v of raw._voice ?? []) {
  const cat = new Map(loadVoiceCatalog("config/voices.json").map((x) => [x.id, x])), vc = cat.get(v.voice)!;
  const wav = path.join(tmp, `${v.character}-${wavs.length}.wav`);
  execFileSync("venv-piper/bin/python", ["-m", "piper", "-m", `piper-voices/${vc.model}`, "-f", wav, "--length-scale", String(Math.round(1.35 * (vc.lengthScale ?? 1) * 1000) / 1000), "--", v.text], { stdio: "ignore" });
  const tr = speechTrack(fs.readFileSync(wav), v.text, spec.fps);
  const c = spec.characters.find((x) => x.id === v.character)!;
  (c.speech ??= []).push({ at: v.at, duration: tr.duration, fps: tr.fps, env: tr.env, visemes: tr.visemes });
  for (const o of spec.characters) if (o.id !== v.character) (o.listen ??= []).push({ at: v.at, duration: tr.duration });
  wavs.push({ file: wav, at: v.at });
}
const t0 = Date.now();
const r = new Three3DRenderer({ characterFile, imageFile: (k) => k });
const silent = path.join(tmp, "video.mp4");
const res = await r.render(spec, silent, { ffmpeg, encoder: "h264_videotoolbox", bitrateKbps: 10000 } as never);
await r.close();
const renderS = (Date.now() - t0) / 1000;
if (wavs.length) {
  const inputs = wavs.flatMap((w) => ["-i", w.file]);
  const delays = wavs.map((w, i) => `[${i + 1}:a]adelay=${Math.round(w.at * 1000)}|${Math.round(w.at * 1000)}[a${i}]`).join(";");
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", silent, ...inputs, "-filter_complex", `${delays};${wavs.map((_, i) => `[a${i}]`).join("")}amix=inputs=${wavs.length}:normalize=0,apad[a]`, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-shortest", out]);
} else fs.copyFileSync(silent, out);
const info = res.info as { world?: Record<string, unknown>; engine: string; three: string; gl: string; characters: { id: string; lipSyncFrames: number; transitions: string[] }[]; trace: Parameters<typeof fromBrowserTrace>[0] };
// the motion check runs on the transforms Chrome actually drew, frame by frame
const ev = events(analyse(path.basename(out), fromBrowserTrace(info.trace)));
fs.writeFileSync(`${out}.trace.json`, JSON.stringify(info.trace));
fs.writeFileSync(`${out}.report.json`, JSON.stringify({ spec: specFile, renderS, frames: res.frames, world: info.world, engine: info.engine, three: info.three, gl: info.gl, characters: info.characters.map((c) => ({ id: c.id, lipSyncFrames: c.lipSyncFrames, transitions: c.transitions })), motionEvents: ev }, null, 1));
console.log(`${out}: ${res.frames} frames in ${renderS.toFixed(1)} s, ${info.engine} r${info.three} on ${info.gl}`);
console.log(`world built: ${JSON.stringify(info.world)}`);
console.log(`motion trace (from the browser render): ${ev.length} discontinuity events`); for (const e of ev) console.log(`  ${e.id} t=${e.t.toFixed(2)} ${e.kind} x${e.frames} peak ${e.peak} ${e.detail}`);
for (const c of info.characters) console.log(`  ${c.id}: lip-sync frames ${c.lipSyncFrames}; locomotion ${c.transitions.join(", ")}`);
