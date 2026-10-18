/**
 * Prints a story plan's camera, shot by shot: the Director's shot size and motion, the old per-shot mapping
 * (shot size -> camera, motion -> move) and the planned coverage (cinematography.ts).
 * Usage: npx tsx scripts/lab/camera/plan-dump.ts scripts/lab/stories/<plan>.json
 */
import fs from "node:fs";
import { storyFromPlan } from "../../../apps/server/src/shots/director";
import { animatedShort3d } from "../../../apps/server/src/profiles/animatedShort3d";
import { planVisuals } from "../../../apps/server/src/anim/renderers/three3d/visualPlan";

const story = storyFromPlan(JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")), animatedShort3d, Number(process.argv[3] ?? 180)).story;
const OLD_SHOT: Record<string, string> = { establishing: "wide", wide: "wide", "medium-wide": "wide", "low-angle": "wide", "high-angle": "wide", tracking: "wide", action: "medium", medium: "medium", "medium-close": "closeup", "close-up": "closeup", "extreme-close-up": "closeup", "over-shoulder": "over_shoulder", pov: "over_shoulder" };
const OLD_MOVE: Record<string, string> = { static: "static", "push-in": "push_in", "pull-out": "pull_out", pan: "pan", tilt: "tilt", tracking: "tracking", shake: "handheld", parallax: "follow", action: "handheld" };
const vp = planVisuals(story);
const count = (xs: string[]) => Object.entries(xs.reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {} as Record<string, number>)).map(([k, v]) => `${k} ${v}`).join(", ");
const rows = story.shots.map((s, i) => {
  const c = vp.shots[i]!.coverage!, sp = s.dialogue.find((d) => d.characterId && d.characterId !== "narrator")?.characterId ?? "-";
  return { i, scene: s.sceneId || s.locationId, beat: s.beat, type: s.shotType, motion: s.motion.type, who: s.subjectIds.join("+"), sp, emo: s.emotion, old: `${OLD_SHOT[s.shotType]}/${OLD_MOVE[s.motion.type]}`, purpose: c.purpose, now: `${c.shot}/${c.move}`, target: c.target + (c.object ? `:${c.object}` : "") };
});
for (const r of rows) console.log([String(r.i).padStart(2), r.scene.slice(0, 10).padEnd(10), r.beat.padEnd(10), r.type.padEnd(16), r.who.padEnd(22), r.sp.padEnd(10), r.emo.padEnd(8), r.old.padEnd(22), "->", r.purpose.padEnd(12), r.now.padEnd(22), r.target].join(" "));
console.log(`old shots: ${count(rows.map((r) => r.old.split("/")[0]!))}; old moves: ${count(rows.map((r) => r.old.split("/")[1]!))}`);
console.log(`new purposes: ${count(rows.map((r) => r.purpose))}; new moves: ${count(rows.map((r) => r.now.split("/")[1]!))}`);
