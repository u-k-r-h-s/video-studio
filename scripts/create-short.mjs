#!/usr/bin/env node
// One command from an idea to a finished 1080x1920 MP4 (cinematic animated short).
//   npm run short -- "Create a 25 second animated mystery short about a delivery rider."
//   npm run short -- "<idea>" --out ~/Desktop/my-short.mp4 --seconds 25
//   npm run short -- --resume <project-id>      (continue a failed/interrupted run; finished work is cached)
// Starts the local API itself when it is not running (and stops it afterwards), plans with Ollama, approves the plan
// (use --review to stop after planning and approve in the UI instead), then runs images -> voices -> edit -> render.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const idea = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && args[i - 1] !== "--review")) ?? "Create a 25 second animated mystery short about a delivery rider.";
const seconds = Number(flag("seconds", (/(\d+)[ -]?second/i.exec(idea)?.[1]) ?? 25));
const profile = flag("profile", "cinematic-animated-short");
const reviewOnly = args.includes("--review");
const API = process.env.STUDIO_API ?? "http://127.0.0.1:8787/api";
const root = path.resolve(new URL("..", import.meta.url).pathname);

const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4);
const call = async (method, p, body) => {
  const res = await fetch(`${API}${p}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${json.error?.message ?? ""} ${json.error?.hint ?? ""}`);
  return json;
};
const up = () => fetch(`${API}/health`).then((r) => r.ok, () => false);

let server;
if (!(await up())) {
  console.log(`${secs()}s  starting the local API...`);
  server = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "apps/server/src/index.ts"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", () => {});
  server.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await up())) { server.kill(); console.error("The API did not start. Run `npm run doctor` to check the setup."); process.exit(1); }
}
const stop = () => { if (server && !server.killed) server.kill("SIGTERM"); };
process.on("SIGINT", () => { stop(); process.exit(130); });

try {
  const health = await call("GET", "/health");
  const down = Object.entries(health.services ?? {}).filter(([k, v]) => ["ollama", "piper", "ffmpeg"].includes(k) && v.status !== "ready");
  if (down.length) console.log(`warning: ${down.map(([k, v]) => `${k}: ${v.message}`).join("; ")}`);

  console.log(flag("resume") ? `RESUMING ${flag("resume")}\n` : `IDEA: ${idea}\n`);
  const resume = flag("resume");
  const id = resume ?? (await call("POST", "/projects", { inputMode: "idea", inputText: idea, language: "en", targetDurationSeconds: seconds, formatProfile: profile })).project.id;
  const wait = async (what) => {
    let last = "";
    for (;;) {
      const { project, activeJob } = await call("GET", `/projects/${id}`);
      const line = activeJob ? `${activeJob.progress}% ${activeJob.message ?? ""}` : "";
      if (line && line !== last) { console.log(`${secs()}s  ${what}: ${line}`); last = line; }
      if (!activeJob) return project;
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  let project = await wait("planning");
  if (project.stages.scene_planning.status !== "completed") throw new Error(`planning failed: ${project.stages.scene_planning.error}`);

  const story = project.story;
  console.log(`\nTITLE: ${project.title}\nLOGLINE: ${story.logline}\nCAST: ${project.characters.map((c) => `${c.name} (${c.visualIdentity})`).join("; ")}`);
  console.log(`${story.shots.length} shots from ${story.keyVisuals.length} generated images:`);
  for (const s of story.shots) console.log(`  ${s.id} ${s.beat.padEnd(10)} ${s.shotType.padEnd(16)} ${s.motion.type.padEnd(9)} ${s.duration.toFixed(1)}s  ${s.action}${s.dialogue[0] ? `  — ${s.dialogue[0].characterId}: "${s.dialogue[0].text}"` : ""}`);
  if (reviewOnly) { console.log(`\nPlan ready for review: open the UI and approve project ${id}.`); stop(); process.exit(0); }

  await call("POST", `/projects/${id}/approve`);
  console.log(`\n${secs()}s  approved; generating (images -> voices -> timeline -> render -> assemble)`);
  const tProduce = Date.now();
  await call("POST", `/projects/${id}/produce`);
  project = await wait("produce");
  if (project.status !== "completed") throw new Error(`generation failed: ${project.errors.at(-1)?.message ?? project.status}`);

  console.log("\n=== RESULT ===");
  for (const [name, s] of Object.entries(project.stages)) console.log(`  ${name.padEnd(18)} ${s.status.padEnd(10)} ${s.durationMs != null ? (s.durationMs / 1000).toFixed(1) + " s" : ""}`);
  const fin = project.assets.find((a) => a.kind === "final_video");
  const src = path.join(root, "projects", id, fin.path);
  const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "short";
  const out = flag("out", path.join(os.homedir(), "Desktop", `${slug}.mp4`));
  fs.copyFileSync(src, out);
  console.log(`\nfinal: ${fin.meta.width}x${fin.meta.height} ${fin.meta.fps}fps ${fin.meta.durationSec.toFixed(1)}s  ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
  console.log(`generation wall time (approve -> final): ${((Date.now() - tProduce) / 1000).toFixed(0)} s; total including planning: ${secs().trim()} s`);
  console.log(`video: ${out}\nproject: projects/${id}`);
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  stop();
  process.exit(1);
}
stop();
