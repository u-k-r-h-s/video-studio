import fs from "node:fs/promises";
import { FINAL_VIDEO_ASSET_ID, SOUNDTRACK_ASSET_ID, shotVideoAssetId } from "@studio/shared";
import { RenderError, StageOrderError } from "../../../errors";
import { writeJsonAtomic } from "../../../lib/fsjson";
import { toSrt } from "../../../render/subtitleCues";
import { findAsset, upsertAsset } from "../../assets";
import { stableHash } from "../../hash";
import type { StageFn } from "../../types";
import { mediaOf, storyOf, timelineOf } from "./common";

/** Stage 6 (shot pipeline): join the shot clips (stream copy), mux the global soundtrack, normalise loudness; write the SRT. */
export const assembleShots: StageFn = (svc, ctx) => assembleWith(svc, ctx, timelineOf);

export const assembleWith = async (svc: Parameters<StageFn>[0], ctx: Parameters<StageFn>[1], timelineFor: typeof timelineOf): Promise<void> => {
  const project = await svc.store.require(ctx.projectId);
  const profile = svc.profiles.get(project.formatProfile);
  const story = storyOf(project);
  const media = mediaOf(svc);
  const stage = "assembly";
  const clips = story.shots.map((s) => ({ shot: s, asset: findAsset(project, shotVideoAssetId(s.id)) }));
  const missing = clips.filter((c) => !c.asset || c.asset.status !== "ready" || !svc.store.exists(project.id, c.asset.path)).map((c) => c.shot.id);
  if (missing.length) throw new StageOrderError(`Cannot assemble: no rendered clip for ${missing.join(", ")}. Render the shots first.`);
  const mix = findAsset(project, SOUNDTRACK_ASSET_ID);
  if (!mix || mix.status !== "ready" || !svc.store.exists(project.id, mix.path)) throw new StageOrderError("Cannot assemble: the soundtrack is missing. Build the timeline first.");

  const hash = stableHash({ clips: clips.map((c) => [c.shot.id, c.asset!.inputHash, c.asset!.createdAt]), mix: [mix.inputHash, mix.createdAt], video: profile.video });
  const finalRel = "final/final.mp4";
  const prev = findAsset(project, FINAL_VIDEO_ASSET_ID);
  await ctx.log.time({ stage }, async () => {
    if (prev && prev.status === "ready" && prev.inputHash === hash && svc.store.exists(project.id, finalRel) && !ctx.scope.force) {
      ctx.log.event({ stage, asset: FINAL_VIDEO_ASSET_ID }, "cached");
      return;
    }
    ctx.progress(20, "Joining shots and mixing audio...");
    const list = svc.store.resolve(project.id, "final", "shots.concat.txt");
    await fs.mkdir(svc.store.resolve(project.id, "final"), { recursive: true });
    await fs.writeFile(list, clips.map((c) => `file '${svc.store.resolve(project.id, c.asset!.path).replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    const out = svc.store.resolve(project.id, finalRel);
    const t0 = Date.now();
    const r = await media.runner.run(media.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-i", svc.store.resolve(project.id, mix.path), "-map", "0:v", "-map", "1:a",
      "-c:v", "copy", "-af", "loudnorm=I=-14:TP=-1.5:LRA=9,aresample=48000", "-c:a", "aac", "-b:a", `${profile.video.audioBitrateKbps}k`, "-movflags", "+faststart", "-shortest", out,
    ], { timeoutMs: 600_000, signal: ctx.signal });
    if (r.code !== 0) throw new RenderError(`ffmpeg assembly exited with code ${r.code}: ${r.stderr.slice(-600)}`);
    const probe = await media.renderer.probe(out);
    const tl = timelineFor(project, story);
    if (Math.abs(probe.durationSec - tl.totalSec) > 0.04 * clips.length + 0.3) throw new RenderError(`assembled video is ${probe.durationSec.toFixed(2)} s but the timeline is ${tl.totalSec.toFixed(2)} s`);
    if (probe.width !== profile.video.width || probe.height !== profile.video.height || !probe.hasAudio) throw new RenderError(`assembled video failed validation (${probe.width}x${probe.height}, audio ${probe.hasAudio})`);

    const cues = tl.shots.flatMap((st) => st.lines.map((l) => ({ text: l.text, start: l.start, end: l.end })));
    await fs.writeFile(svc.store.resolve(project.id, "final/subtitles.srt"), toSrt(cues));
    await writeJsonAtomic(svc.store.resolve(project.id, "final/render-info.json"), { durationSec: probe.durationSec, width: probe.width, height: probe.height, fps: probe.fps, shots: clips.length, builtAt: new Date().toISOString() });
    await svc.store.update(project.id, (p) => {
      upsertAsset(p, { id: FINAL_VIDEO_ASSET_ID, kind: "final_video", path: finalRel, status: "ready", inputHash: hash, meta: { durationSec: probe.durationSec, width: probe.width, height: probe.height, fps: probe.fps, encoder: probe.videoCodec, assembleMs: Date.now() - t0, srt: "final/subtitles.srt", shots: clips.length }, createdAt: new Date().toISOString() });
    });
  });
};
