import fs from "node:fs/promises";
import { SOUNDTRACK_ASSET_ID, type Project, type Shot } from "@studio/shared";
import { StageOrderError } from "../../../errors";
import { mixSoundtrack, planSoundtrack, type ExtraCue } from "../../../audio/soundtrack";
import { chunkLine, renderCaptionStates, type CaptionState, type CaptionStyle } from "../../../shots/captions";
import { findAsset, findAudio, upsertAsset } from "../../assets";
import { stableHash } from "../../hash";
import type { Timeline } from "../../../shots/timeline";
import type { PipelineServices, StageFn } from "../../types";
import { cinematicOf, mediaOf, storyOf, timelineOf } from "./common";

export const CAPTION_RECIPE_VERSION = "captions-karaoke-v1";
export const SOUNDTRACK_RECIPE_VERSION = "soundtrack-v1";
export const captionAssetId = (shotId: string): string => `captions-${shotId}`;

export interface ShotCaptions { states: CaptionState[]; insert?: CaptionState & { centerY: number } }

/** Reads the caption plan stored for a shot by the timeline stage. */
export async function readShotCaptions(readJson: (rel: string) => Promise<unknown>, p: Project, shotId: string): Promise<{ captions: ShotCaptions; hash: string }> {
  const a = findAsset(p, captionAssetId(shotId));
  if (!a || a.status !== "ready") throw new StageOrderError(`The captions for ${shotId} are missing. Build the timeline first.`);
  return { captions: (await readJson(a.path)) as ShotCaptions, hash: a.inputHash };
}

/**
 * Stage 4 (shot pipeline, id "subtitles"): the edit. Real voice durations -> shot timings; word-timed caption PNGs per
 * shot (and insert cards: phone text, title); the global audio timeline (voices, SFX, ambience, ducked music) mixed to
 * one WAV. Everything is content-addressed, so only changed captions/audio are re-made.
 */
export interface TimelineStageConfig {
  /** The edit timeline from the real voice durations (the animated pipeline also reserves time for the action). */
  timeline: (project: Project, story: NonNullable<Project["story"]>, svc: PipelineServices) => Timeline;
  style: (project: Project, svc: PipelineServices) => CaptionStyle;
  /** Sounds implied by the animation (footsteps, doors, impacts) with global times. */
  extraCues?: (project: Project, story: NonNullable<Project["story"]>, tl: Timeline, svc: PipelineServices) => Promise<ExtraCue[]>;
  rain?: (project: Project, svc: PipelineServices) => boolean;
  recipe?: string;
  /** Caption phrasing: words per caption (default 3) and characters per caption (default 20). */
  chunk?: { maxWords: number; maxChars: number };
}

export const buildShotTimeline: StageFn = (svc, ctx) => runTimelineStage(svc, ctx, { timeline: (p, story) => timelineOf(p, story), style: (p, s) => cinematicOf(s.profiles.get(p.formatProfile)).captions as CaptionStyle });

export const runTimelineStage = async (svc: PipelineServices, ctx: Parameters<StageFn>[1], cfg: TimelineStageConfig): Promise<void> => {
  const project = await svc.store.require(ctx.projectId);
  const story = storyOf(project);
  const media = mediaOf(svc);
  const stage = "subtitles";
  const tl = cfg.timeline(project, story, svc);
  const style: CaptionStyle = cfg.style(project, svc);
  const extra = cfg.extraCues ? await cfg.extraCues(project, story, tl, svc) : [];
  const rain = cfg.rain?.(project, svc) ?? false;
  const capDir = svc.store.resolve(project.id, "captions");

  await ctx.log.time({ stage }, async () => {
    // 1. captions + inserts per shot
    for (const [i, shot] of story.shots.entries()) {
      const st = tl.shots[i]!;
      const chunks = st.lines.flatMap((l) => chunkLine(l.text, l.localStart, l.localEnd, l.emphasis, cfg.chunk));
      const insertKey = shot.insert ? [shot.insert.kind, shot.insert.text] : null;
      const hash = stableHash({ chunks, insert: insertKey, style, duration: st.duration, recipe: CAPTION_RECIPE_VERSION });
      const id = captionAssetId(shot.id), rel = `captions/${shot.id}.json`;
      const prev = findAsset(project, id);
      if (prev && prev.inputHash === hash && prev.status === "ready" && svc.store.exists(project.id, rel) && !ctx.scope.force) continue;
      const states = await renderCaptionStates(media.runner, media.captionHelper, chunks, capDir, style);
      const out: ShotCaptions = { states };
      if (shot.insert) out.insert = await renderInsert(svc, project.id, media, shot, st.duration, style);
      await fs.mkdir(capDir, { recursive: true });
      await fs.writeFile(svc.store.resolve(project.id, rel), JSON.stringify(out));
      await svc.store.update(project.id, (p) => upsertAsset(p, { id, kind: "caption", path: rel, status: "ready", inputHash: hash, meta: { shotId: shot.id, states: states.length }, createdAt: new Date().toISOString() }));
      ctx.progress(10 + (40 * (i + 1)) / story.shots.length, `Captions ${i + 1}/${story.shots.length}`);
    }

    // 2. the global soundtrack
    const voices = story.shots.flatMap((s) => s.dialogue.map((d) => findAudio(project, `voice-${d.id}`)!));
    const mixHash = stableHash({
      recipe: SOUNDTRACK_RECIPE_VERSION + (cfg.recipe ?? ""), extra, rain, total: tl.totalSec, voices: voices.map((v) => [v.id, v.inputHash, v.createdAt]),
      shots: story.shots.map((s, i) => [s.id, s.sfx, s.transition, s.effects, s.emotion, s.beat, s.action, tl.shots[i]!.start, tl.shots[i]!.duration, tl.shots[i]!.lines.map((l) => l.localStart)]),
    });
    const prev = findAsset(project, SOUNDTRACK_ASSET_ID);
    const mixRel = "audio/mix.wav";
    if (prev && prev.inputHash === mixHash && prev.status === "ready" && svc.store.exists(project.id, mixRel) && !ctx.scope.force) {
      ctx.log.event({ stage, asset: SOUNDTRACK_ASSET_ID }, "cached");
    } else {
      ctx.progress(60, "Mixing the soundtrack...");
      const voicePaths = Object.fromEntries(voices.map((v) => [v.dialogueId, svc.store.resolve(project.id, v.path)]));
      const tracks = await planSoundtrack({ shots: story.shots, timeline: tl, voicePaths, dir: svc.store.resolve(project.id, "audio", "synth"), extraCues: extra, rain });
      const mix = await mixSoundtrack(tracks, tl.totalSec, svc.store.resolve(project.id, mixRel));
      await svc.store.update(project.id, (p) => upsertAsset(p, { id: SOUNDTRACK_ASSET_ID, kind: "audio_track", path: mixRel, status: "ready", inputHash: mixHash, meta: { durationSec: tl.totalSec, peak: mix.peak, tracks: tracks.length }, createdAt: new Date().toISOString() }));
    }
  });
};

/** Phone-screen text (a translucent card) or the title (big, plain). */
async function renderInsert(svc: Parameters<StageFn>[0], projectId: string, media: ReturnType<typeof mediaOf>, shot: Shot, duration: number, style: CaptionStyle): Promise<ShotCaptions["insert"]> {
  const ins = shot.insert!;
  const isTitle = ins.kind === "title";
  const png = svc.store.resolve(projectId, "captions", `insert-${stableHash([ins, style.font])}.png`);
  const r = await media.runner.run(media.captionHelper, [ins.text, style.font, isTitle ? "136" : "92", isTitle ? "960" : "900", png, "5", isTitle ? "0" : "0.55", "-1"], { timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(`insert render failed: ${r.stderr.slice(-200)}`);
  const b = await fs.readFile(png);
  return { png, start: isTitle ? 0.5 : 0.05, end: duration, width: b.readUInt32BE(16), height: b.readUInt32BE(20), centerY: isTitle ? 0.44 : 0.27 };
}
