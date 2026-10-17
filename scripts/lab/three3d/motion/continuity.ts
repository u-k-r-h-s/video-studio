/**
 * Cross-shot continuity of a story: compiles every 3D shot and simulates it (the renderer's own Character3D, headless) to
 * get where each character really ends; within a scene the next shot must start them there. Reports the jumps at cuts.
 * Usage: npx tsx scripts/lab/three3d/motion/continuity.ts <plan.json> [--no-blocking]
 */
import fs from "node:fs";
import * as THREE from "three";
import { storyFromPlan } from "../../../../apps/server/src/shots/director";
import { animatedShort3d } from "../../../../apps/server/src/profiles/animatedShort3d";
import { compileShot3D, endPositions } from "../../../../apps/server/src/anim/renderers/three3d/compile";
import { planVisuals } from "../../../../apps/server/src/anim/renderers/three3d/visualPlan";
import { artStyleOf } from "../../../../apps/server/src/anim/renderers/three3d/artStyle";
import { castStory, loadCatalog } from "../../../../apps/server/src/anim/renderers/three3d/casting";
import { characterFile } from "../../../../apps/server/src/anim/renderers/three3d/library";
import { traceShot } from "./trace";
import { minShotDuration } from "../../../../apps/server/src/anim/compose";

export async function continuity(planFile: string, blocking = true, duration = 4): Promise<{ cut: string; id: string; jump: number; turn: number }[]> {
  const r = storyFromPlan(JSON.parse(fs.readFileSync(planFile, "utf8")), animatedShort3d, 180);
  const story = r.story, vp = planVisuals(story, story.artStyle), style = artStyleOf(vp.artStyle);
  const cast = castStory(r.characters, loadCatalog(undefined, (k) => fs.existsSync(characterFile(k))), style.characters);
  const sceneOf = (s: (typeof story.shots)[number]): string => s.sceneId || s.locationId;
  const ends: { scene: string; at: Map<string, { p: THREE.Vector3; h: number }> }[] = [];
  let carry: Record<string, { x: number; z: number; heading: number }> | undefined;
  const out: { cut: string; id: string; jump: number; turn: number }[] = [];
  for (let i = 0; i < story.shots.length; i++) {
    const shot = story.shots[i]!;
    const order: string[] = [];
    for (const s of story.shots) if (sceneOf(s) === sceneOf(shot)) for (const id of s.subjectIds) if (!order.includes(id)) order.push(id);
    const before = [...new Set(story.shots.slice(0, i).filter((s) => sceneOf(s) === sceneOf(shot)).flatMap((s) => s.subjectIds))];
    const D = Math.max(minShotDuration(shot), 1.2 + shot.dialogue.reduce((a, d) => a + d.text.length, 0) * 0.075);
    const spec = compileShot3D({ shot, story, characters: r.characters, duration: D, width: 108, height: 192, fps: 30, seed: i + 1, cast: (c) => ({ asset: cast[c.id] ?? "casual-man" }), direction: { location: vp.locations.find((l) => l.locationId === shot.locationId)!, shot: vp.shots[i], style }, ...(blocking ? { scene: { order, before, ...(carry && i > 0 && sceneOf(story.shots[i - 1]!) === sceneOf(shot) ? { carry } : {}) } } : {}) }).spec;
    carry = endPositions(spec); // the pipeline's static estimate; the jump below is measured against the simulated end
    const tr = await traceShot(spec);
    const prev = ends[ends.length - 1];
    const now = new Map<string, { p: THREE.Vector3; h: number }>();
    tr.forEach((frames) => { const f0 = frames[0]!, fN = frames[frames.length - 1]!; now.set(f0.id, { p: fN.root, h: fN.heading });
      const est = carry?.[f0.id]; if (est && process.argv.includes("--est") && Math.hypot(est.x - fN.root.x, est.z - fN.root.z) > 0.3) console.log(`  estimate off: ${shot.id} ${f0.id} static (${est.x.toFixed(2)}, ${est.z.toFixed(2)}) simulated (${fN.root.x.toFixed(2)}, ${fN.root.z.toFixed(2)}) speed at end ${frames[frames.length - 1]!.speed.toFixed(2)}`);
      const before = prev && prev.scene === sceneOf(shot) ? prev.at.get(f0.id) : undefined;
      if (before) out.push({ cut: `${story.shots[i - 1]!.id}>${shot.id}`, id: f0.id, jump: +before.p.distanceTo(f0.root).toFixed(2), turn: +Math.abs(Math.atan2(Math.sin(f0.heading - before.h), Math.cos(f0.heading - before.h)) * 57.3).toFixed(0) });
    });
    ends.push({ scene: sceneOf(shot), at: now });
  }
  return out;
}

if (process.argv[1]?.endsWith("continuity.ts")) {
  const rows = await continuity(process.argv[2]!, !process.argv.includes("--no-blocking"));
  const bad = rows.filter((x) => x.jump > 0.3 || x.turn > 30);
  for (const x of rows) console.log(`${x.cut.padEnd(18)} ${x.id.padEnd(7)} moved ${x.jump.toFixed(2)} m, turned ${x.turn} deg${x.jump > 0.3 || x.turn > 30 ? "   <-- jump at the cut" : ""}`);
  console.log(`${rows.length} character-cuts inside scenes; ${bad.length} jumps (> 0.3 m or > 30 deg)`);
}
