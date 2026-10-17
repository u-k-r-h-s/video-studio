import { FINAL_VIDEO_ASSET_ID, shotVideoAssetId } from "@studio/shared";
import { engineOf } from "../../../profiles/rendererChoice";
import { StageOrderError } from "../../../errors";
import { findAsset } from "../../assets";
import type { StageFn } from "../../types";
import { assembleWith } from "../shots/assembleShots";
import { storyOf } from "../shots/common";
import { animTimelineOf } from "./common";
import { ANIM_RENDERER_ID } from "./renderAnimShots";

/**
 * Stage 6 (animated pipeline): the same join + mix as the shot pipeline, behind a guard: every clip must have been drawn by the
 * layered animation renderer. A clip from the still-image renderer is an error, never silently accepted.
 */
export const assembleAnimShots: StageFn = async (svc, ctx) => {
  const project = await svc.store.require(ctx.projectId);
  const wrong = storyOf(project).shots.filter((s) => findAsset(project, shotVideoAssetId(s.id))?.meta.renderer !== ANIM_RENDERER_ID).map((s) => s.id);
  if (wrong.length) throw new StageOrderError(`Refusing to assemble: ${wrong.join(", ")} not drawn by the animation renderer (a still-image fallback is not allowed in the animated pipeline).`);
  // every clip must come from the engine the project's profile names: a Three.js project never contains a 2D clip
  const engine = engineOf(svc.profiles.get(project.formatProfile));
  const other = storyOf(project).shots.filter((s) => ((findAsset(project, shotVideoAssetId(s.id))?.meta.engine as string | undefined) ?? "canvas2d") !== engine).map((s) => s.id);
  if (other.length) throw new StageOrderError(`Refusing to assemble: ${other.join(", ")} not drawn by ${engine} (the project's renderer). Re-render them; a renderer fallback is not allowed.`);
  await assembleWith(svc, ctx, animTimelineOf);
  // the final video records which engine drew its frames
  await svc.store.update(project.id, (p) => {
    const fin = p.assets.find((a) => a.id === FINAL_VIDEO_ASSET_ID);
    if (fin) fin.meta = { ...fin.meta, engine, engineShots: storyOf(p).shots.length };
  });
};
