import fs from "node:fs/promises";
import { planAssets } from "../../../anim/manifest";
import type { StageFn } from "../../types";
import { planStory } from "../shots/planStory";
import { animationOf, storyOf } from "./common";

/**
 * Stage 1 (animated pipeline): the director's story and shot list (with semantic physical actions), then the asset manifest:
 * exactly which locations, character views, face variants and props the shots need. The manifest is saved with the project so the
 * plan can be reviewed before any image is generated.
 */
export const planAnimStory = (feedback?: string): StageFn => async (svc, ctx) => {
  await planStory(feedback)(svc, ctx);
  const project = await svc.store.require(ctx.projectId);
  const manifest = planAssets(storyOf(project), project.characters, animationOf(svc.profiles.get(project.formatProfile)));
  await fs.writeFile(svc.store.resolve(project.id, "manifest.json"), JSON.stringify(manifest, null, 1));
  ctx.log.event({ stage: "scene_planning" }, "manifest", { assets: manifest.assets.length, locations: manifest.locations.length, characters: manifest.characters.length, props: manifest.props.length });
};
