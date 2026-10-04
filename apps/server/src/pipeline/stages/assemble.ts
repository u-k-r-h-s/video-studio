import fs from "node:fs/promises";
import { FINAL_VIDEO_ASSET_ID, sceneVideoAssetId } from "@studio/shared";
import { StageOrderError } from "../../errors";
import { writeJsonAtomic } from "../../lib/fsjson";
import { buildCues, toSrt } from "../../render/subtitleCues";
import { findAsset, upsertAsset } from "../assets";
import { stableHash } from "../hash";
import type { StageFn } from "../types";

/**
 * Stage 6: concatenate the scene clips into the final MP4 (+ an SRT sidecar with cumulative offsets).
 * Always covers the whole project; it is cheap and skipped entirely when no clip changed.
 */
export const assembleFinal: StageFn = async (svc, ctx) => {
  const project = await svc.store.require(ctx.projectId);
  const profile = svc.profiles.get(project.formatProfile);
  const renderer = svc.providers.renderer[profile.sceneRenderer];
  if (!renderer) throw new StageOrderError(`No scene renderer "${profile.sceneRenderer}" is registered.`);
  const stage = "assembly";
  const ordered = [...project.scenes].sort((a, b) => a.order - b.order);
  const clips = ordered.map((s) => ({ scene: s, asset: findAsset(project, sceneVideoAssetId(s.id)) }));
  const missing = clips.filter((c) => !c.asset || c.asset.status !== "ready" || !svc.store.exists(project.id, c.asset.path)).map((c) => c.scene.id);
  if (missing.length) throw new StageOrderError(`Cannot assemble: no rendered clip for ${missing.join(", ")}. Render the scenes first.`);

  const hash = stableHash({ clips: clips.map((c) => [c.scene.id, c.asset!.inputHash, c.asset!.createdAt]), video: profile.video });
  const finalRel = "final/final.mp4";
  const prev = findAsset(project, FINAL_VIDEO_ASSET_ID);
  await ctx.log.time({ stage }, async () => {
    if (prev && prev.status === "ready" && prev.inputHash === hash && svc.store.exists(project.id, finalRel) && !ctx.scope.force) {
      ctx.log.event({ stage, asset: FINAL_VIDEO_ASSET_ID }, "cached");
      return;
    }
    ctx.progress(20, "Joining scene clips...");
    const out = await renderer.assemble(clips.map((c) => svc.store.resolve(project.id, c.asset!.path)), svc.store.resolve(project.id, finalRel), profile.video);

    // SRT sidecar: cue times shifted by each scene's start within the final video
    let offset = 0;
    const cues = clips.flatMap(({ scene, asset }) => {
      const shifted = buildCues(scene).map((c) => ({ text: c.text, start: c.start + offset, end: c.end + offset }));
      offset += Number(asset!.meta.durationSec ?? scene.duration);
      return shifted;
    });
    await fs.writeFile(svc.store.resolve(project.id, "final/subtitles.srt"), toSrt(cues));
    await writeJsonAtomic(svc.store.resolve(project.id, "final/render-info.json"), { ...out, scenes: ordered.length, builtAt: new Date().toISOString() });

    await svc.store.update(project.id, (p) => {
      upsertAsset(p, { id: FINAL_VIDEO_ASSET_ID, kind: "final_video", path: finalRel, status: "ready", inputHash: hash, meta: { durationSec: out.durationSec, width: out.width, height: out.height, fps: out.fps, encoder: out.encoder, assembleMs: out.renderMs, srt: "final/subtitles.srt", scenes: ordered.length }, createdAt: new Date().toISOString() });
    });
  });
};
