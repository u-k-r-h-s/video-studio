// Re-derives a stored project's key images with the CURRENT key-visual planner (lab tool: lets the pipeline re-generate
// only the images after a planner change). Usage: npx tsx scripts/lab/replan-keys.ts <project-id>
import fs from "node:fs";
import { planKeyVisuals } from "../../apps/server/src/shots/keyVisuals";
import { cinematicAnimatedShort } from "../../apps/server/src/profiles/cinematicAnimatedShort";

const id = process.argv[2]!;
const file = `/Users/apple/Desktop/ai-studio-feasibility/projects/${id}/project.json`;
const p = JSON.parse(fs.readFileSync(file, "utf8"));
const { keyVisuals, shotKey } = planKeyVisuals(p.story.shots, { style: cinematicAnimatedShort.cinematic!.stylePrefix, characters: p.characters, locations: p.story.locations }, cinematicAnimatedShort.cinematic!.maxKeyImages);
p.story.keyVisuals = keyVisuals;
for (const s of p.story.shots) s.visualKey = shotKey[s.id];
fs.writeFileSync(file, JSON.stringify(p, null, 2));
for (const k of keyVisuals) console.log(k.id.padEnd(34), k.initFrom ? `img2img ${k.initFrom.keyId} @${k.initFrom.denoise}` : "text2img", "|", k.prompt.slice(-90));
