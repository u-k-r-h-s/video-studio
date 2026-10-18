/**
 * Camera Cinematography V1 proofs: a small village story (a conversation, the hand pump, a walk home) compiled by the
 * PRODUCTION compiler (planVisuals -> coverage -> compileShot3D, scene blocking with carried positions, Piper voices with
 * lip-sync) and rendered by the Three.js renderer. Nothing about the camera is hand-written.
 *   npx tsx scripts/lab/camera/proof.ts <dialogue|pump|walk> [--stills] [--out dir]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Character, Shot, Story } from "@studio/shared";
import { compileShot3D, endPositions } from "../../../apps/server/src/anim/renderers/three3d/compile";
import { Three3DRenderer } from "../../../apps/server/src/anim/renderers/three3d";
import { characterFile } from "../../../apps/server/src/anim/renderers/three3d/library";
import { planVisuals } from "../../../apps/server/src/anim/renderers/three3d/visualPlan";
import { artStyleOf } from "../../../apps/server/src/anim/renderers/three3d/artStyle";
import type { Shot3DSpec, SpeechSpec3D } from "../../../apps/server/src/anim/renderers/three3d/spec";
import { speechTrack } from "../../../apps/server/src/anim/lipsync";
import { loadVoiceCatalog } from "../../../apps/server/src/providers/tts/voices";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const which = process.argv[2] as "dialogue" | "pump" | "walk";
const stills = process.argv.includes("--stills");
const OUTDIR = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1]! : path.join(ROOT, "projects/camera-v1");
fs.mkdirSync(OUTDIR, { recursive: true });
const W = Number(process.env.W ?? 1080), H = Number(process.env.H ?? 1920), FPS = 30;

const characters: Character[] = [
  { id: "dadaji", name: "Dadaji", description: "the grandfather", appearance: "an elderly man", clothing: "white kurta", visualIdentity: "" },
  { id: "meera", name: "Meera", description: "a village girl", appearance: "a girl of twelve", clothing: "a simple frock", visualIdentity: "" },
] as Character[];
const CAST: Record<string, string> = { dadaji: "rb-elder-man", meera: "rb-girl" };
const VOICE: Record<string, string> = { dadaji: "hi-pratham-elder", meera: "hi-priyamvada" };
const location = { id: "lane", name: "Village lane", description: "a village lane of mud houses with a hand pump", visualIdentity: "an Indian village lane, mud houses, a courtyard, a hand pump, golden evening light", lighting: "golden hour", timeOfDay: "golden_hour", weather: "clear", importantObjects: [] } as unknown as Story["locations"][number];

let n = 0;
const S = (o: Partial<Shot> & { say?: [string, string]; walk?: string; d: number }): Shot & { d: number } => ({
  id: `shot-${String(++n).padStart(2, "0")}`, sceneId: "scene-1", order: n, beat: "setup", duration: o.d, shotType: "medium", emotion: "calm", action: "", visualPrompt: "", visualKey: "",
  locationId: "lane", subjectIds: [], dialogue: o.say ? [{ id: `d${n}`, characterId: o.say[0], text: o.say[1] }] : [], sfx: [], characterMotion: [], transition: { type: "cut" },
  focus: { x: 0.5, y: 0.5 }, camera: {}, motion: { type: "parallax" },
  ...(o.walk ? { animation: { actions: [{ character: o.subjectIds![0]!, action: "walk", when: "start", toward: o.walk }], objects: [] } } : {}),
  ...o,
} as unknown as Shot & { d: number });

// the Director's shot list, as a story plan would give it (sizes + motions as the old pipeline produced them)
const shots: (Shot & { d: number })[] = [
  // scene 1: dadaji sends meera for water
  S({ shotType: "establishing", motion: { type: "pan" } as Shot["motion"], beat: "hook", d: 2.6 }),
  S({ subjectIds: ["dadaji", "meera"], shotType: "medium", say: ["dadaji", "मीरा, शाम हो गई। पानी भर लाओ।"], d: 3.6 }),
  S({ subjectIds: ["meera", "dadaji"], shotType: "medium", say: ["meera", "अभी जाती हूँ, दादाजी।"], d: 2.8 }),
  S({ subjectIds: ["dadaji", "meera"], shotType: "close-up", motion: { type: "push-in" } as Shot["motion"], say: ["dadaji", "अँधेरा होने से पहले लौट आना।"], d: 3.4 }),
  S({ subjectIds: ["meera", "dadaji"], shotType: "close-up", motion: { type: "push-in" } as Shot["motion"], emotion: "joy", d: 1.8 }),
  // scene 2: at the hand pump
  S({ sceneId: "scene-2", subjectIds: ["meera"], shotType: "medium-wide", action: "Meera starts working the hand pump", d: 2.8 }),
  S({ sceneId: "scene-2", subjectIds: ["meera"], shotType: "medium", action: "Meera pumps; water flows", d: 2.6 }),
  S({ sceneId: "scene-2", subjectIds: ["meera"], shotType: "close-up", action: "water from the pump fills the bucket", d: 2.4 }),
  S({ sceneId: "scene-2", subjectIds: ["meera"], shotType: "close-up", action: "Meera smiles, still working the pump", emotion: "joy", d: 1.8 }),
  // scene 3: home along the lane
  S({ sceneId: "scene-3", subjectIds: ["meera"], shotType: "medium-wide", motion: { type: "pan" } as Shot["motion"], walk: "along the lane", d: 5.5 }),
  S({ sceneId: "scene-3", shotType: "wide", motion: { type: "pull-out" } as Shot["motion"], beat: "payoff", d: 2.6 }),
];
const story = { title: "camera-v1", locations: [location], characters, shots } as unknown as Story;
const vp = planVisuals(story);
const range = { dialogue: [0, 4], pump: [5, 8], walk: [9, 10] }[which];

// Piper lines -> lip-sync tracks
const voices = new Map(loadVoiceCatalog(path.join(ROOT, "config/voices.json")).map((x) => [x.id, x]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cam-v1-"));
const line = (i: number): { who: string; wav: string; tr: ReturnType<typeof speechTrack> } | null => {
  const d = shots[i]!.dialogue[0]; if (!d) return null;
  const vc = voices.get(VOICE[d.characterId]!)!, wav = path.join(tmp, `${i}.wav`);
  execFileSync(path.join(ROOT, "venv-piper/bin/python"), ["-m", "piper", "-m", path.join(ROOT, `piper-voices/${vc.model}`), "-f", wav, "--length-scale", String(Math.round(1.35 * (vc.lengthScale ?? 1) * 1000) / 1000), "--", d.text], { stdio: "ignore" });
  return { who: d.characterId, wav, tr: speechTrack(fs.readFileSync(wav), d.text, FPS) };
};

const specs: Shot3DSpec[] = [];
const sceneOf = (s: Shot): string => s.sceneId;
const carry: Record<number, Record<string, { x: number; z: number; heading: number }>> = {};
const cams: Record<number, Shot3DSpec["camera"]> = {};
const lines: ({ who: string; wav: string; tr: ReturnType<typeof speechTrack> } | null)[] = [];
const report: string[] = [];
for (let i = 0; i <= range[1]!; i++) {
  const shot = shots[i]!, ln = i >= range[0]! ? line(i) : null;
  lines.push(ln);
  const AT = 0.35, D = ln ? Math.max(shot.d, AT + ln.tr.duration + 0.5) : shot.d;
  const speech: Record<string, SpeechSpec3D[]> = ln ? { [ln.who]: [{ at: AT, duration: ln.tr.duration, fps: ln.tr.fps, env: ln.tr.env, visemes: ln.tr.visemes }] } : {};
  const sceneShots = shots.filter((s) => sceneOf(s) === sceneOf(shot));
  const order: string[] = []; for (const s of sceneShots) for (const id of s.subjectIds) if (!order.includes(id)) order.push(id);
  const before = [...new Set(shots.slice(0, i).filter((s) => sceneOf(s) === sceneOf(shot)).flatMap((s) => s.subjectIds))];
  const prevCarry = i > 0 && sceneOf(shots[i - 1]!) === sceneOf(shot) ? carry[i - 1] : undefined;
  const { spec, notes } = compileShot3D({
    shot, story, characters, duration: +D.toFixed(2), width: W, height: H, fps: FPS, seed: i + 1, cast: (c) => ({ asset: CAST[c.id]! }),
    indexInScene: sceneShots.findIndex((s) => s.id === shot.id), speech, ...(i > 0 && sceneOf(shots[i - 1]!) === sceneOf(shot) ? { prevCamera: cams[i - 1] } : {}), scene: { order, before, ...(prevCarry ? { carry: prevCarry } : {}) },
    direction: { location: vp.locations[0]!, shot: vp.shots[i], style: artStyleOf(vp.artStyle) },
  });
  carry[i] = endPositions(spec); cams[i] = spec.camera;
  if (i < range[0]!) continue;
  specs.push(spec);
  const c = spec.camera, cov = vp.shots[i]!.coverage!;
  report.push(`${shot.id} ${shot.shotType.padEnd(13)} ${(shot.dialogue[0]?.characterId ?? "-").padEnd(7)} -> ${String(c.purpose).padEnd(12)} ${c.shot}/${c.move} target=${c.target}${c.toward ? ` toward=${c.toward}` : ""}${c.frameWith ? ` with=${c.frameWith}` : ""} side=${c.side} angle=${c.angle ?? "-"} h=${c.heightOffset} fov×${c.fovScale} [${cov.reason}] D=${spec.duration} | ${cov.transition.toUpperCase()}: ${cov.transitionReason}${c.enter ? ` (${c.enter.duration} s)` : ""}`);
  console.log(report.at(-1)); console.log(`   ${notes.join(" | ")}`);
}

const renderer = new Three3DRenderer({ characterFile, imageFile: (k) => (fs.existsSync(k) ? k : null) });
const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((f) => fs.existsSync(f))!;
const t0 = Date.now(), clips: string[] = [], timing: { shot: string; frames: number; s: number }[] = [];
try {
  for (const [k, spec] of specs.entries()) {
    const nf = Math.round(spec.duration * FPS);
    if (stills) {
      const r = await renderer.stills(spec, [3, Math.round(nf * 0.5), nf - 2]);
      for (const [f, png] of r.frames) fs.writeFileSync(path.join(OUTDIR, `still-${which}-${spec.id}-${String(f).padStart(3, "0")}.png`), png);
      continue;
    }
    const out = path.join(tmp, `${spec.id}.mp4`), t1 = Date.now();
    const r = await renderer.render(spec, out, { ffmpeg, encoder: "h264_videotoolbox", bitrateKbps: 10000, fadeIn: k === 0 ? 0.3 : 0, fadeOut: k === specs.length - 1 ? 0.4 : 0 } as never);
    clips.push(out); timing.push({ shot: spec.id, frames: r.frames, s: +((Date.now() - t1) / 1000).toFixed(1) });
    console.log(`${spec.id}: ${r.frames} frames in ${timing.at(-1)!.s} s`);
  }
} finally { await renderer.close(); }
if (!stills) {
  // the lines laid on the cut picture at their shot offsets
  const offs: number[] = []; let t = 0; for (const s of specs) { offs.push(t); t += s.duration; }
  const ls = lines.slice(range[0]!).map((l, k) => (l ? { wav: l.wav, at: offs[k]! + 0.35 } : null)).filter((x): x is { wav: string; at: number } => !!x);
  const list = path.join(tmp, "list.txt"); fs.writeFileSync(list, clips.map((c) => `file '${c}'`).join("\n") + "\n");
  const silent = path.join(tmp, "cut.mp4"), out = path.join(OUTDIR, `${path.basename(OUTDIR)}-${which}.mp4`);
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent]);
  if (ls.length) {
    const delays = ls.map((w, i) => `[${i + 1}:a]adelay=${Math.round(w.at * 1000)}|${Math.round(w.at * 1000)}[a${i}]`).join(";");
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", silent, ...ls.flatMap((w) => ["-i", w.wav]), "-filter_complex", `${delays};${ls.map((_, i) => `[a${i}]`).join("")}amix=inputs=${ls.length}:normalize=0,apad[a]`, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-shortest", out]);
  } else fs.copyFileSync(silent, out);
  fs.writeFileSync(`${out}.json`, JSON.stringify({ seconds: +t.toFixed(2), totalRenderS: +((Date.now() - t0) / 1000).toFixed(1), shots: timing, plan: report, specs }, null, 1));
  console.log(`${out}: ${t.toFixed(1)} s of video, rendered in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
