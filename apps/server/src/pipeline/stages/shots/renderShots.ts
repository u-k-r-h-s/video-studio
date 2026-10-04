import fs from "node:fs/promises";
import { keyVisualAssetId, shotVideoAssetId, type Project, type Shot } from "@studio/shared";
import { StageOrderError } from "../../../errors";
import { defaultFocus } from "../../../shots/cameraLanguage";
import { captionCenterY } from "../../../shots/captions";
import { renderShot, type ShotRenderSpec } from "../../../shots/shotRenderer";
import { findAsset, upsertAsset } from "../../assets";
import { stableHash } from "../../hash";
import type { PipelineServices, StageFn } from "../../types";
import { readShotCaptions } from "./buildShotTimeline";
import { cinematicOf, mediaOf, shotsInScope, storyOf, timelineOf } from "./common";

/** Bump when the shot renderer / filter graph changes so cached clips are re-rendered. */
export const SHOT_RENDER_RECIPE_VERSION = "shot-render-v1";

/** Everything the renderer needs for one shot, plus a hash of all of it (for caching). */
export async function resolveShotSpec(svc: PipelineServices, p: Project, shot: Shot, index: number): Promise<{ spec: ShotRenderSpec; hash: string }> {
  const profile = svc.profiles.get(p.formatProfile);
  const cin = cinematicOf(profile);
  const story = storyOf(p);
  const tl = timelineOf(p, story);
  const key = findAsset(p, keyVisualAssetId(shot.visualKey));
  if (!key || key.status !== "ready" || !svc.store.exists(p.id, key.path)) throw new StageOrderError(`The image for ${shot.id} is missing. Generate the images first.`);
  const { captions, hash: capHash } = await readShotCaptions(async (rel) => JSON.parse(await fs.readFile(svc.store.resolve(p.id, rel), "utf8")), p, shot.id);
  const duration = tl.shots[index]!.duration;
  const prev = story.shots[index - 1];
  const spec: ShotRenderSpec = {
    shot, imagePath: svc.store.resolve(p.id, key.path), duration, width: profile.video.width, height: profile.video.height, fps: profile.video.fps,
    transitionIn: prev?.transition.type ?? "cut", isFirst: index === 0, isLast: index === story.shots.length - 1,
    captions: captions.states, captionCenterY: captionCenterY(shot.focus ?? defaultFocus(shot.shotType)), insert: captions.insert, grade: cin.grade,
  };
  const hash = stableHash({
    recipe: SHOT_RENDER_RECIPE_VERSION, video: profile.video, bitrate: cin.bitrateKbps, duration, grade: cin.grade,
    shot: { camera: shot.camera, motion: shot.motion, characterMotion: shot.characterMotion, effects: shot.effects, transition: shot.transition, focus: shot.focus, shotType: shot.shotType, order: shot.order, insert: shot.insert },
    transitionIn: spec.transitionIn, isFirst: spec.isFirst, isLast: spec.isLast, key: [key.id, key.inputHash, key.meta.attempt], captions: capHash,
  });
  return { spec, hash };
}

/** Stage 5 (shot pipeline): one FFmpeg clip per shot, cached by input hash. Both heavy models must be gone. */
export const renderShots: StageFn = async (svc, ctx) => {
  const project = await svc.store.require(ctx.projectId);
  const profile = svc.profiles.get(project.formatProfile);
  const cin = cinematicOf(profile);
  const story = storyOf(project);
  const media = mediaOf(svc);
  await svc.gate.assertComfyUIStopped();
  await svc.gate.assertOllamaUnloaded();
  const stage = "scene_render";
  const encoders = await media.renderer.resolveEncoders(profile.video);

  const shots = shotsInScope(story, ctx.scope);
  let done = 0;
  await ctx.log.time({ stage }, async () => {
    for (const shot of shots) {
      const current = await svc.store.require(project.id);
      const index = story.shots.findIndex((s) => s.id === shot.id);
      const { spec, hash } = await resolveShotSpec(svc, current, shot, index);
      const id = shotVideoAssetId(shot.id), rel = `shots/${shot.id}.mp4`;
      const prev = findAsset(current, id);
      if (prev && prev.status === "ready" && prev.inputHash === hash && svc.store.exists(project.id, rel) && !ctx.scope.force) {
        ctx.log.event({ stage, scene: shot.sceneId, asset: id }, "cached");
      } else {
        await ctx.log.time({ stage, scene: shot.sceneId, asset: id }, async () => {
          let last: unknown, used = encoders[0]!, renderMs = 0;
          for (const enc of encoders) {
            try {
              used = enc;
              renderMs = (await renderShot(media.runner, spec, svc.store.resolve(project.id, rel), { ffmpeg: media.ffmpeg, ffprobe: media.ffprobe, encoder: enc, bitrateKbps: cin.bitrateKbps, timeoutMs: 600_000 }, ctx.signal)).renderMs;
              last = undefined;
              break;
            } catch (err) {
              last = err;
              if (ctx.signal?.aborted) throw err;
            }
          }
          if (last) throw last;
          const probe = await media.renderer.probe(svc.store.resolve(project.id, rel));
          await svc.store.update(project.id, (p) => upsertAsset(p, { id, kind: "shot_video", sceneId: shot.sceneId, path: rel, status: "ready", inputHash: hash, meta: { durationSec: probe.durationSec, encoder: used, renderMs, width: probe.width, height: probe.height, fps: probe.fps, shotId: shot.id }, createdAt: new Date().toISOString() }));
        });
      }
      ctx.progress(10 + (85 * ++done) / Math.max(1, shots.length), `Rendered shot ${done}/${shots.length}`);
    }
  });
};
