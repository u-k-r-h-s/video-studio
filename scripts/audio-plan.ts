// Writes what the soundtrack SHOULD contain for an animated project: every voice line (text, global start/end) and every sound cue
// implied by the animation (global time), so scripts/audio_check.py can look for them in the finished MP4.
//   npx tsx scripts/audio-plan.ts <project-id> [out.json]
import fs from "node:fs";
import path from "node:path";
import { audioCuesFor } from "../apps/server/src/anim/cues";
import { composeShot } from "../apps/server/src/anim/compose";
import { planAssets } from "../apps/server/src/anim/manifest";
import { animTimelineOf } from "../apps/server/src/pipeline/stages/animated/common";
import { animatedShort } from "../apps/server/src/profiles/animatedShort";
import { spokenText } from "../apps/server/src/lib/spoken";

const id = process.argv[2];
if (!id) { console.error("usage: tsx scripts/audio-plan.ts <project-id> [out.json]"); process.exit(1); }
const root = path.resolve(new URL("..", import.meta.url).pathname);
const project = JSON.parse(fs.readFileSync(path.join(root, "projects", id, "project.json"), "utf8"));
const story = project.story, anim = animatedShort.animation!;
const tl = animTimelineOf(project, story);
const manifest = planAssets(story, project.characters, anim);
const lines = tl.shots.flatMap((s) => s.lines.map((l) => ({ shot: s.shotId, text: l.text, spoken: spokenText(l.text), start: l.start, end: l.end })));
const cues = story.shots.flatMap((shot: any, i: number) => {
  const st = tl.shots[i]!;
  const composed = composeShot({ shot, story, characters: project.characters, manifest, anim, duration: st.duration, fps: 30, seed: i + 1, has: () => true });
  return audioCuesFor(composed.spec).map((c) => ({ shot: shot.id, kind: c.kind, at: +(st.start + c.at).toFixed(3), volume: c.volume }));
});
const out = process.argv[3] ?? path.join("/tmp", `audio-plan-${id}.json`);
fs.writeFileSync(out, JSON.stringify({ totalSec: tl.totalSec, shots: tl.shots.map((s) => ({ id: s.shotId, start: s.start, duration: s.duration })), lines, cues }, null, 1));
console.log(`${out}: ${lines.length} voice lines, ${cues.length} cues (${[...new Set(cues.map((c: any) => c.kind))].join(", ")}), ${tl.totalSec.toFixed(1)} s`);
