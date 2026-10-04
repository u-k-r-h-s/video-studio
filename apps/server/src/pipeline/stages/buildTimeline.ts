import fs from "node:fs/promises";
import { sceneAudioAssetId, type Scene } from "@studio/shared";
import { StageOrderError } from "../../errors";
import { encodeWav, mixTimeline, parseWav } from "../../lib/wav";
import { buildCues } from "../../render/subtitleCues";
import { buildTimeline } from "../../render/timeline";
import { findAsset, findAudio, upsertAsset } from "../assets";
import { stableHash } from "../hash";
import { inScope, type StageFn } from "../types";

const SUBTITLE_RECIPE_VERSION = "coretext-v2";

/**
 * Stage 4: "Subtitle Timing -> Scene Timeline". Real audio durations -> dialogue start/end -> subtitle cues ->
 * subtitle PNGs (CoreText) -> one mixed audio track per scene at sample-accurate offsets.
 */
export const buildSceneTimelines: StageFn = async (svc, ctx) => {
  const project = await svc.store.require(ctx.projectId);
  const profile = svc.profiles.get(project.formatProfile);
  const subtitles = svc.providers.subtitle[profile.subtitleRenderer];
  if (!subtitles) throw new StageOrderError(`No subtitle renderer "${profile.subtitleRenderer}" is registered.`);
  const stage = "subtitles";
  const font = profile.layout.subtitleFonts[project.language];
  const L = profile.layout;

  const scenes = project.scenes.filter((s) => inScope(ctx.scope, s.id));
  let done = 0;
  await ctx.log.time({ stage }, async () => {
    for (const scene of scenes) {
      await ctx.log.time({ stage, scene: scene.id }, async () => {
        const missing = scene.dialogue.filter((d) => !findAudio(project, `voice-${d.id}`));
        if (missing.length) throw new StageOrderError(`Voices are missing for ${scene.id}. Generate voices first.`);
        const audioSec = new Map(scene.dialogue.map((d) => [d.id, findAudio(project, `voice-${d.id}`)!.durationSec]));
        const tl = buildTimeline(scene, audioSec, profile);

        // 1. write the timeline back into the plan
        const timed: Scene = { ...scene, duration: tl.duration, dialogue: scene.dialogue.map((d) => { const l = tl.lines.find((x) => x.dialogueId === d.id)!; return { ...d, startTime: l.start, endTime: l.end }; }) };
        const cues = buildCues(timed);

        // 2. subtitle PNGs (re-rendered only when text/style changed)
        const cueAssets: { id: string; hash: string }[] = [];
        for (const cue of cues) {
          const hash = stableHash({ text: cue.text, font, size: L.subtitleFontPx, width: L.subtitleWidthPx, stroke: L.subtitleStrokePercent, box: L.subtitleBoxAlpha, lang: project.language, recipe: SUBTITLE_RECIPE_VERSION });
          const fresh = findAsset(project, cue.id);
          let width = Number(fresh?.meta.width);
          let height = Number(fresh?.meta.height);
          const rel = `subtitles/${cue.id}.png`;
          if (!(fresh && fresh.inputHash === hash && fresh.status === "ready" && svc.store.exists(project.id, rel))) {
            const img = await subtitles.render({ text: cue.text, language: project.language, fontFamily: font, fontSizePx: L.subtitleFontPx, widthPx: L.subtitleWidthPx, strokePercent: L.subtitleStrokePercent, boxAlpha: L.subtitleBoxAlpha, outPath: svc.store.resolve(project.id, rel) });
            width = img.width;
            height = img.height;
          }
          cueAssets.push({ id: cue.id, hash });
          await svc.store.update(project.id, (p) => upsertAsset(p, { id: cue.id, kind: "subtitle", sceneId: scene.id, path: rel, status: "ready", inputHash: hash, meta: { width, height, start: cue.start, end: cue.end, text: cue.text, dialogueId: cue.dialogueId }, createdAt: new Date().toISOString() }));
        }

        // 3. the scene's mixed audio track
        const sampleRate = scene.dialogue.length ? parseWav(await fs.readFile(svc.store.resolve(project.id, findAudio(project, `voice-${scene.dialogue[0]!.id}`)!.path))).sampleRate : 22050;
        const clips = await Promise.all(timed.dialogue.map(async (d) => ({ wav: parseWav(await fs.readFile(svc.store.resolve(project.id, findAudio(project, `voice-${d.id}`)!.path))), startSec: d.startTime! })));
        const audioId = sceneAudioAssetId(scene.id);
        const audioRel = `audio/${scene.id}.wav`;
        const audioHash = stableHash({ lines: timed.dialogue.map((d) => { const a = findAudio(project, `voice-${d.id}`)!; return [a.inputHash, a.createdAt, d.startTime]; }), duration: tl.duration, sampleRate });
        const prev = findAsset(project, audioId);
        if (!(prev && prev.inputHash === audioHash && svc.store.exists(project.id, audioRel))) {
          await fs.writeFile(svc.store.resolve(project.id, audioRel), encodeWav(mixTimeline(clips, sampleRate, tl.duration)));
        }

        await svc.store.update(project.id, (p) => {
          const sc = p.scenes.find((x) => x.id === scene.id)!;
          sc.duration = tl.duration;
          sc.dialogue = timed.dialogue;
          sc.status = "timed";
          upsertAsset(p, { id: audioId, kind: "scene_audio", sceneId: scene.id, path: audioRel, status: "ready", inputHash: audioHash, meta: { durationSec: tl.duration, sampleRate }, createdAt: prev && prev.inputHash === audioHash ? prev.createdAt : new Date().toISOString() });
          const live = new Set(cueAssets.map((c) => c.id));
          p.assets = p.assets.filter((a) => !(a.kind === "subtitle" && a.sceneId === scene.id && !live.has(a.id))); // cues of deleted/shortened lines
        });
      });
      ctx.progress(10 + (85 * ++done) / Math.max(1, scenes.length), `Timeline ${done}/${scenes.length}`);
    }
  });
};
