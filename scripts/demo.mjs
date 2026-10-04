#!/usr/bin/env node
// End-to-end demo driver: talks to the running studio API (npm run dev:server), exactly like the UI would.
// Usage: node scripts/demo.mjs ["your idea text"]
// While it runs it writes the current stage to results/stage.txt so scripts/memmon.py can label memory samples.
import fs from "node:fs";

const API = process.env.STUDIO_API ?? "http://127.0.0.1:8787/api";
const IDEA = process.argv[2] ??
  "A clever village detective discovers that someone has been stealing food from a small shop every night. He sets a simple trap and catches the thief. " +
  "Use exactly two characters (the detective and the thief), one location (the shop), and one or two props.";
const STAGE_FILE = new URL("../results/stage.txt", import.meta.url);

const call = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json.error?.message ?? ""} ${json.error?.hint ?? ""}`);
  return json;
};
const label = (s) => fs.writeFileSync(STAGE_FILE, s);
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4);

async function waitIdle(id, what) {
  let last = "";
  for (;;) {
    const { project, activeJob } = await call("GET", `/projects/${id}`);
    const running = Object.entries(project.stages).find(([, s]) => s.status === "running")?.[0] ?? "idle";
    label(`demo-${running}`);
    const line = activeJob ? `${activeJob.progress}% ${activeJob.message ?? ""} [${running}]` : "";
    if (line !== last && line) { console.log(`${secs()}s  ${what}: ${line}`); last = line; }
    if (!activeJob) return project;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

let id;
let project;
if (process.env.DEMO_PROJECT) {
  // Resume an existing project (keeps its plan, reuses cached voices/assets whose inputs did not change).
  id = process.env.DEMO_PROJECT;
  project = (await call("GET", `/projects/${id}`)).project;
  console.log(`${secs()}s  resuming project ${id}`);
} else {
  console.log("IDEA:", IDEA, "\n");
  label("demo-create");
  const { project: created } = await call("POST", "/projects", { inputMode: "idea", inputText: IDEA, language: "en", targetDurationSeconds: 20, title: "The Midnight Thief" });
  id = created.id;
  console.log(`${secs()}s  created project ${id}`);
  project = await waitIdle(id, "planning");
  if (project.stages.scene_planning.status !== "completed") { console.error("PLANNING FAILED:", project.stages.scene_planning.error); process.exit(1); }
}

console.log("\n=== SCENE PLAN (for human review) ===");
console.log("Characters:", project.characters.map((c) => `${c.name} [${c.id}]: ${c.appearance}`).join("\n            "));
for (const s of project.scenes) {
  console.log(`\n${s.id} (${s.duration}s) @ ${s.location} | camera ${s.camera.movement}/${s.camera.shot} | entrance ${s.motion.entrance} emphasis ${s.motion.emphasis}`);
  console.log(`  visual: ${s.visualDescription}`);
  console.log(`  characters: ${s.characters.join(", ")} | props: ${s.props.join(", ") || "-"}`);
  for (const d of s.dialogue) console.log(`  ${d.characterId}: "${d.text}"`);
}

if (process.env.DEMO_PROJECT) {
  // props are plain words now (older plans had kebab-case names)
  const fixed = project.scenes.map((sc) => ({ ...sc, props: sc.props.map((p) => p.replace(/[-_]+/g, " ")) }));
  await call("PUT", `/projects/${id}/plan`, { title: project.title, characters: project.characters, scenes: fixed });
  console.log("(normalised prop names via PUT /plan)");
} else if (process.env.DEMO_EDIT !== "0") {
  // Prove the human review/edit step: change one visual description through the same API the UI uses.
  const edit = { title: project.title, characters: project.characters, scenes: project.scenes.map((s, i) => (i === 0 ? { ...s, visualDescription: `${s.visualDescription.replace(/\.$/, "")}, warm lamp light.` } : s)) };
  await call("PUT", `/projects/${id}/plan`, edit);
  console.log("\n(edited scene-01 visual description via PUT /plan, as a reviewer would)");
}
await call("POST", `/projects/${id}/approve`);
console.log(`${secs()}s  plan approved; generating (images -> voices -> timeline -> render -> assemble)`);
const tProduce = Date.now();
await call("POST", `/projects/${id}/produce`);
project = await waitIdle(id, "produce");
label("demo-done");

console.log("\n=== RESULT ===");
console.log("status:", project.status);
for (const [name, s] of Object.entries(project.stages)) console.log(`  ${name.padEnd(18)} ${s.status.padEnd(10)} ${s.durationMs != null ? (s.durationMs / 1000).toFixed(1) + " s" : ""} ${s.error ?? ""}`);
if (project.status !== "completed") { console.error("\nFAILED:", project.errors.at(-1)?.message); process.exit(1); }
const imgs = project.assets.filter((a) => ["background", "character", "prop"].includes(a.kind));
console.log("\nimages generated:", imgs.map((a) => `${a.id} ${(a.meta.durationMs / 1000).toFixed(1)}s`).join(", "));
console.log("scene clips:", project.assets.filter((a) => a.kind === "scene_video").map((a) => `${a.sceneId} ${a.meta.durationSec.toFixed(1)}s ${a.meta.encoder} render ${a.meta.renderMs}ms`).join("; "));
const fin = project.assets.find((a) => a.kind === "final_video");
console.log(`final: ${fin.meta.width}x${fin.meta.height} ${fin.meta.fps}fps ${fin.meta.durationSec.toFixed(1)}s -> projects/${id}/${fin.path}`);
console.log(`generation wall time (approve -> final): ${((Date.now() - tProduce) / 1000).toFixed(0)} s; total incl. planning: ${secs().trim()} s`);
console.log("PROJECT_ID=" + id);
