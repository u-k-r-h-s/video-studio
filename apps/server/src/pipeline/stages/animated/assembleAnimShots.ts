import { shotVideoAssetId } from "@studio/shared";
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
  await assembleWith(svc, ctx, animTimelineOf);
};
