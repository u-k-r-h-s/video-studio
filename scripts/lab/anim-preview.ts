// Renders a few frames of one shot of a finished project straight from the engine (no FFmpeg): fast iteration on motion/rigs.
//   npx tsx scripts/lab/anim-preview.ts <project-id> <shot-id> <out.png> [t1 t2 ...]
import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { composeShot } from "../../apps/server/src/anim/compose";
import { AnimEngine } from "../../apps/server/src/anim/engine";
import { loadAnimLibrary } from "../../apps/server/src/anim/library";
import { planAssets } from "../../apps/server/src/anim/manifest";
import { animTimelineOf } from "../../apps/server/src/pipeline/stages/animated/common";
import { animatedShort } from "../../apps/server/src/profiles/animatedShort";

const [id, shotId, out, ...ts] = process.argv.slice(2);
const root = path.resolve(new URL("../..", import.meta.url).pathname);
const dir = path.join(root, "projects", id!);
const project = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
const anim = animatedShort.animation!;
const manifest = planAssets(project.story, project.characters, anim);
const { lib } = await loadAnimLibrary({ resolve: (r) => path.join(dir, r), exists: (r) => fs.existsSync(path.join(dir, r)), manifest, assets: project.assets });
const tl = animTimelineOf(project, project.story);
const i = project.story.shots.findIndex((s: any) => s.id === shotId);
const composed = composeShot({ shot: project.story.shots[i], story: project.story, characters: project.characters, manifest, anim, duration: tl.shots[i]!.duration, fps: 30, seed: i + 1, has: (a) => lib.images.has(a) || lib.rigs.has(a) });
const engine = new AnimEngine(composed.spec, lib);
const times = ts.length ? ts.map(Number) : [0.1, 0.4, 0.8, 1.2, 1.6, 2.0, 2.4];
const W = 270, H = 480, sheet = createCanvas(W * times.length, H), sg = sheet.getContext("2d");
const frame = createCanvas(engine.W, engine.H), fg = frame.getContext("2d");
times.forEach((t, k) => { engine.renderFrame(fg, t); sg.drawImage(frame, k * W, 0, W, H); });
fs.writeFileSync(out!, sheet.toBuffer("image/png"));
console.log(out, composed.notes);
