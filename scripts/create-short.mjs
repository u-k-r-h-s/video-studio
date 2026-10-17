#!/usr/bin/env node
// One command from an idea to a finished 1080x1920 MP4 (layered animated short).
//   npm run short -- "Create a 25 second animated mystery short about a delivery rider."
//   npm run short -- "<idea>" --out ~/Desktop/my-short.mp4 --seconds 25
//   npm run short -- "<idea>" --renderer=3d                       (rigged 3D characters, Three.js renderer)
//   npm run short -- "<idea>" --renderer=3d --asset=tripo         (every character played by one 3D asset: casual-man, tripo, meshy)
//   npm run short -- --plan story.json --language hi --seconds 180  (an authored story + shot list in the director's format;
//                                                                     the LLM step is skipped, everything after it is the same)
//   npm run short -- "<idea>" --profile cinematic-animated-short   (the older still-image shots; not the default)
//   npm run short -- --resume <project-id>      (continue a failed/interrupted run; finished work is cached)
// Starts the local API itself when it is not running (and stops it afterwards), plans with Ollama, approves the plan
// (use --review to stop after planning and approve in the UI instead), then runs images -> voices -> edit -> render.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const idea = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !args[i - 1].includes("=") && args[i - 1] !== "--review")) ?? "Create a 25 second animated mystery short about a delivery rider.";
const seconds = Number(flag("seconds", (/(\d+)[ -]?second/i.exec(idea)?.[1]) ?? 25));
// --renderer=3d / --renderer 3d: rigged 3D characters (Three.js); --renderer=2d or nothing: the 2D puppet renderer (default)
const rendererArg = args.find((a) => a.startsWith("--renderer="))?.split("=")[1] ?? flag("renderer");
// an explicit renderer is binding: an unknown value stops here, the API checks it against the profile, a resumed project is
// checked below, and the run fails if any clip was drawn by another engine (never a silent fallback). Same synonyms as
// apps/server/src/profiles/rendererChoice.ts.
const RENDERERS = { "2d": "2d", canvas: "2d", canvas2d: "2d", "3d": "3d", three: "3d", threejs: "3d", "three.js": "3d", three3d: "3d", webgl: "3d" };
const ENGINE = { "2d": "canvas2d", "3d": "three3d" };
const rendererChoice = rendererArg === undefined ? undefined : RENDERERS[String(rendererArg).trim().toLowerCase()];
if (rendererArg !== undefined && !rendererChoice) { console.error(`Unknown renderer "${rendererArg}". Use --renderer=3d (Three.js) or --renderer=2d.`); process.exit(1); }
const profileArg = flag("profile");
const profile = profileArg ?? (rendererChoice === "3d" ? "animated-short-3d" : "animated-short");
const reviewOnly = args.includes("--review");
// --plan <file>: an authored story ({ outline, shots } in the shot director's format); --language en|hi
const planFile = args.find((a) => a.startsWith("--plan="))?.split("=")[1] ?? flag("plan");
const directorPlan = planFile ? JSON.parse(fs.readFileSync(planFile.replace(/^~(?=\/|$)/, os.homedir()), "utf8")) : undefined;
// the whole plan goes to the API (outline, shots, cast, artStyle, ...): dropping a section silently changes the film
const planBody = (p) => Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith("_") && k !== "language"));
const language = args.find((a) => a.startsWith("--language="))?.split("=")[1] ?? flag("language", directorPlan?.language ?? "en");
// --asset=<key>: comparison runs; the asset is checked before anything is planned (a missing provider export fails here)
const assetArg = args.find((a) => a.startsWith("--asset="))?.split("=")[1] ?? flag("asset");
const API = process.env.STUDIO_API ?? "http://127.0.0.1:8787/api";
const root = path.resolve(new URL("..", import.meta.url).pathname);

const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4);
const call = async (method, p, body) => {
  const res = await fetch(`${API}${p}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${method} ${p} -> ${res.status}: ${json.error?.message ?? ""} ${json.error?.hint ?? ""}`), { status: res.status });
  return json;
};
const up = () => fetch(`${API}/health`).then((r) => r.ok, () => false);

if (assetArg) {
  if (rendererChoice !== "3d") { console.error("--asset needs --renderer=3d"); process.exit(1); }
  const chk = spawnSync(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "scripts/check-3d-asset.ts"), assetArg], { cwd: root, encoding: "utf8" });
  if (chk.status !== 0) { console.error(chk.stderr.trim() || `3D asset "${assetArg}" is not usable`); process.exit(1); }
  console.log(`3D character asset: ${assetArg} (${chk.stdout.trim().replace(os.homedir(), "~")})`);
  // the asset reaches the pipeline through the API process this command starts; an API that is already running was
  // started without it
  if (await up()) { console.error(`An API server is already running at ${API}; --asset only applies to an API started by this command. Stop it and run again.`); process.exit(1); }
}

let server, serverErr = "", serverExit = null;
if (!(await up())) {
  console.log(`${secs()}s  starting the local API...`);
  server = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "apps/server/src/index.ts"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: assetArg ? { ...process.env, STUDIO_3D_ASSET: assetArg } : process.env });
  server.stdout.on("data", () => {});
  // the last of the API's stderr is kept, so if it dies mid-run the reason is printed instead of a bare "fetch failed"
  server.stderr.on("data", (d) => { serverErr = (serverErr + d).slice(-4000); if (process.env.DEBUG) process.stderr.write(d); });
  server.on("exit", (code, signal) => { serverExit = signal ? `signal ${signal}` : `code ${code}`; });
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await up())) { server.kill(); console.error("The API did not start. Run `npm run doctor` to check the setup."); process.exit(1); }
}
const stop = () => { if (server && !server.killed) server.kill("SIGTERM"); };
process.on("SIGINT", () => { stop(); process.exit(130); });

try {
  const health = await call("GET", "/health");
  const down = Object.entries(health.services ?? {}).filter(([k, v]) => ["ollama", "piper", "ffmpeg"].includes(k) && v.status !== "ready");
  if (down.length) console.log(`warning: ${down.map(([k, v]) => `${k}: ${v.message}`).join("; ")}`);

  console.log(flag("resume") ? `RESUMING ${flag("resume")}\n` : directorPlan ? `PLAN: ${planFile} (${directorPlan.shots?.length ?? 0} shots, ${language})\n` : `IDEA: ${idea}\n`);
  const resume = flag("resume");
  // the API picks/validates the profile for an explicit renderer; --profile is only sent when it was given
  const profileFields = rendererChoice ? { renderer: rendererChoice, ...(profileArg ? { formatProfile: profileArg } : {}) } : { formatProfile: profile };
  const id = resume ?? (await call("POST", "/projects", directorPlan
    ? { inputMode: "script", inputText: directorPlan.outline?.logline ?? idea, title: directorPlan.outline?.title, language, targetDurationSeconds: seconds, directorPlan: planBody(directorPlan), ...profileFields }
    : { inputMode: "idea", inputText: idea, language, targetDurationSeconds: seconds, ...profileFields })).project.id;
  const wait = async (what) => {
    let last = "";
    for (let busySince = 0; ;) {
      // a long synchronous step (mixing a 3-minute soundtrack) can keep the API from answering for a while: a network-level
      // failure is retried while the API process is alive; an HTTP error, an exited API or 10 minutes of silence still fail
      let r;
      try { r = await call("GET", `/projects/${id}`); busySince = 0; }
      catch (err) {
        if (err.status !== undefined || serverExit || (busySince && Date.now() - busySince > 600_000)) throw err;
        if (!busySince) { busySince = Date.now(); console.log(`${secs()}s  (the API is busy and not answering: ${err.cause?.code ?? err.cause?.message ?? err.message}; waiting)`); }
        await new Promise((res) => setTimeout(res, 3000));
        continue;
      }
      const { project, activeJob } = r;
      const line = activeJob ? `${activeJob.progress}% ${activeJob.message ?? ""}` : "";
      if (line && line !== last) { console.log(`${secs()}s  ${what}: ${line}`); last = line; }
      if (!activeJob) return project;
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  let project = await wait("planning");
  if (project.stages.scene_planning.status !== "completed") throw new Error(`planning failed: ${project.stages.scene_planning.error}`);
  const engineOfProfile = (await call("GET", "/profiles")).profiles.find((p) => p.id === project.formatProfile)?.engine ?? "unknown";
  console.log(`RENDERER: ${engineOfProfile}${engineOfProfile === "three3d" ? " (Three.js)" : ""} - profile ${project.formatProfile}`);
  console.log(`CAST: ${project.characters.map((c) => `${c.id} -> model ${c.asset3d ?? "auto"}, voice ${c.voiceId ?? "auto"}`).join(" | ")}`);
  // an authored cast must arrive intact (a dropped entry silently swaps models and voices)
  for (const [cid, want] of Object.entries(directorPlan?.cast ?? {})) {
    const got = project.characters.find((c) => c.id === cid);
    if (!got || (want.asset && got.asset3d !== want.asset) || (want.voice && got.voiceId !== want.voice)) throw new Error(`the plan's cast for "${cid}" (${JSON.stringify(want)}) did not reach the project (${JSON.stringify({ model: got?.asset3d, voice: got?.voiceId })})`);
  }
  if (rendererChoice && engineOfProfile !== ENGINE[rendererChoice]) throw new Error(`--renderer=${rendererChoice} needs ${ENGINE[rendererChoice]}, but project ${id} uses profile ${project.formatProfile} (${engineOfProfile}). Start a new project instead of resuming this one.`);

  const story = project.story;
  console.log(`\nTITLE: ${project.title}\nLOGLINE: ${story.logline}\nCAST: ${project.characters.map((c) => `${c.name} (${c.visualIdentity})`).join("; ")}`);
  const animated = profile.startsWith("animated-short") || project.formatProfile.startsWith("animated-short");
  console.log(animated ? `${story.shots.length} shots, animated from generated assets:` : `${story.shots.length} shots from ${story.keyVisuals.length} generated images:`);
  const acts = (s) => (s.animation?.actions ?? []).map((a) => `${a.action}${a.toward ? ` ${a.toward}` : ""}`).concat((s.animation?.objects ?? []).map((o) => `${o.object}:${o.action}`)).join(", ");
  for (const s of story.shots) console.log(`  ${s.id} ${s.beat.padEnd(10)} ${s.shotType.padEnd(16)} ${animated ? "" : s.motion.type.padEnd(9)} ${s.duration.toFixed(1)}s  ${s.action}${animated && acts(s) ? `  [${acts(s)}]` : ""}${s.dialogue[0] ? `  — ${s.dialogue[0].characterId}: "${s.dialogue[0].text}"` : ""}`);
  if (animated) {
    const m = await fs.promises.readFile(path.join(path.join(root, "projects"), id, "manifest.json"), "utf8").then(JSON.parse, () => null);
    if (m) console.log(`ASSET MANIFEST: ${m.assets.length} assets — ${m.locations.length} locations, ${m.characters.map((c) => `${c.id}: ${c.assetIds.length}`).join(", ")} character assets, ${m.props.length} props`);
  }
  if (reviewOnly) { console.log(`\nPlan ready for review: open the UI and approve project ${id}.`); stop(); process.exit(0); }

  await call("POST", `/projects/${id}/approve`);
  console.log(`\n${secs()}s  approved; generating (images -> voices -> timeline -> render -> assemble)`);
  const tProduce = Date.now();
  await call("POST", `/projects/${id}/produce`);
  project = await wait("produce");
  if (project.status !== "completed") throw new Error(`generation failed: ${project.errors.at(-1)?.message ?? project.status}`);

  console.log("\n=== RESULT ===");
  for (const [name, s] of Object.entries(project.stages)) console.log(`  ${name.padEnd(18)} ${s.status.padEnd(10)} ${s.durationMs != null ? (s.durationMs / 1000).toFixed(1) + " s" : ""}`);
  const clips = project.assets.filter((a) => a.kind === "shot_video");
  console.log(`  renderer: ${[...new Set(clips.map((c) => c.meta.renderer ?? "still-image"))].join(", ")} (${clips.length} clips, ${clips.reduce((n, c) => n + (c.meta.frames ?? 0), 0)} frames drawn)`);
  // which engine drew every clip, from the clips' own records; an explicit renderer must account for all of them
  const engineOfClip = (c) => c.meta.engine ?? (c.meta.renderer === "anim" ? "canvas2d" : "still-image");
  const engines = clips.reduce((m, c) => ({ ...m, [engineOfClip(c)]: (m[engineOfClip(c)] ?? 0) + 1 }), {});
  const gls = [...new Set(clips.map((c) => c.meta.gl).filter(Boolean))], threes = [...new Set(clips.map((c) => c.meta.three).filter(Boolean))];
  console.log(`  engine per clip: ${Object.entries(engines).map(([k, n]) => `${k} x${n}`).join(", ")}${threes.length ? ` (three.js r${threes.join(",")}, WebGL: ${gls.join(" | ")})` : ""}`);
  if (rendererChoice && (engines[ENGINE[rendererChoice]] ?? 0) !== clips.length) throw new Error(`--renderer=${rendererChoice}: only ${engines[ENGINE[rendererChoice]] ?? 0} of ${clips.length} clips were drawn by ${ENGINE[rendererChoice]}`);
  const fin = project.assets.find((a) => a.kind === "final_video");
  const src = path.join(root, "projects", id, fin.path);
  const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "short";
  const out = flag("out", path.join(os.homedir(), "Desktop", `${slug}.mp4`));
  fs.copyFileSync(src, out);
  console.log(`\nfinal: ${fin.meta.width}x${fin.meta.height} ${fin.meta.fps}fps ${fin.meta.durationSec.toFixed(1)}s  ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
  console.log(`generation wall time (approve -> final): ${((Date.now() - tProduce) / 1000).toFixed(0)} s; total including planning: ${secs().trim()} s`);
  const lines = (project.story?.shots ?? []).flatMap((s) => s.dialogue.map((d) => ({ shot: s.id, speaker: d.characterId, voice: project.audio.find((a) => a.dialogueId === d.id)?.voiceId ?? null, text: d.text })));
  fs.writeFileSync(`${out}.render.json`, `${JSON.stringify({ project: id, profile: project.formatProfile, requestedRenderer: rendererChoice ?? null, engine: fin.meta.engine ?? engineOfProfile, cast: project.characters.map((c) => ({ id: c.id, name: c.name, model: c.asset3d ?? null, voice: c.voiceId ?? null })), lines, clipEngines: engines, three: threes, webgl: gls, frames: clips.reduce((n, c) => n + (c.meta.frames ?? 0), 0), durationSec: fin.meta.durationSec, width: fin.meta.width, height: fin.meta.height, fps: fin.meta.fps }, null, 1)}\n`);
  console.log(`video: ${out}\nrender report: ${out}.render.json\nproject: projects/${id}`);
} catch (err) {
  console.error(`\nFAILED: ${err.message}${err.cause ? ` (${err.cause.code ?? ""} ${err.cause.message ?? err.cause})` : ""}`);
  if (serverExit) console.error(`The local API stopped (${serverExit}) during the run.${serverErr.trim() ? ` Its last output:\n${serverErr.trim().split("\n").slice(-25).join("\n")}` : " It printed nothing."}\nFinished work is cached: continue with  npm run short -- --resume <project-id>`);
  stop();
  process.exit(1);
}
stop();
