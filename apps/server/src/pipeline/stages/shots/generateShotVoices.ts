import fs from "node:fs/promises";
import { voiceAudioId } from "@studio/shared";
import { CancelledError, StageOrderError } from "../../../errors";
import { durationSec, encodeWav, parseWav, trimSilence } from "../../../lib/wav";
import { resolveVoiceId } from "../../../providers/tts/voices";
import { findAudio, upsertAudio } from "../../assets";
import { stableHash } from "../../hash";
import type { StageFn } from "../../types";
import { cinematicOf, shotsInScope, storyOf } from "./common";

const VOICE_RECIPE_VERSION = "piper-trim-shots-v1";

/** Stage 3 (shot pipeline): Piper voice for each shot's line, slowed by the profile's length scale, silence-trimmed. ComfyUI must be stopped. */
export const generateShotVoices: StageFn = async (svc, ctx) => {
  const project = await svc.store.require(ctx.projectId);
  if (!project.reviewApproved) throw new StageOrderError("Review and approve the plan before generating voices.");
  const profile = svc.profiles.get(project.formatProfile);
  const cin = cinematicOf(profile);
  const story = storyOf(project);
  const tts = svc.providers.tts[profile.ttsProvider];
  if (!tts) throw new StageOrderError(`No TTS provider "${profile.ttsProvider}" is registered.`);
  await svc.gate.assertComfyUIStopped();
  const stage = "voice_generation";

  const lines = shotsInScope(story, ctx.scope).flatMap((shot) => shot.dialogue.map((d) => ({ shot, d })));
  let done = 0;
  await ctx.log.time({ stage }, async () => {
    for (const { shot, d } of lines) {
      if (ctx.signal?.aborted) throw new CancelledError();
      const voiceId = resolveVoiceId(d.characterId, project.characters, project.language, profile);
      const voice = tts.getVoice(voiceId);
      const hash = stableHash({ text: d.text, voiceId, model: voice.model, speaker: voice.speaker, scale: cin.voiceLengthScale, recipe: VOICE_RECIPE_VERSION });
      const id = voiceAudioId(d.id);
      const current = await svc.store.require(project.id);
      const existing = findAudio(current, id);
      if (existing && existing.inputHash === hash && svc.store.exists(project.id, existing.path) && !ctx.scope.force) {
        ctx.log.event({ stage, scene: shot.sceneId, asset: id }, "cached");
      } else {
        const rawRel = `audio/${d.id}.raw.wav`, finalRel = `audio/${d.id}.wav`;
        await ctx.log.time({ stage, scene: shot.sceneId, asset: id }, async () => {
          const raw = await tts.synthesize({ text: d.text.replace(/\.\.\./g, ","), voiceId, outPath: svc.store.resolve(project.id, rawRel), lengthScale: cin.voiceLengthScale, signal: ctx.signal });
          const trimmed = trimSilence(parseWav(await fs.readFile(raw.path)));
          await fs.writeFile(svc.store.resolve(project.id, finalRel), encodeWav(trimmed.wav));
          await svc.store.update(project.id, (p) => {
            upsertAudio(p, { id, dialogueId: d.id, sceneId: shot.sceneId, path: finalRel, durationSec: durationSec(trimmed.wav), voiceId, inputHash: hash, createdAt: new Date().toISOString() });
            const line = p.story?.shots.find((s) => s.id === shot.id)?.dialogue.find((x) => x.id === d.id);
            if (line) line.audioAssetId = id;
          });
        }, { voice: voiceId });
      }
      ctx.progress(10 + (85 * ++done) / Math.max(1, lines.length), `Voice ${done}/${lines.length}`);
    }
  });
  await svc.store.update(project.id, (p) => {
    const live = new Set((p.story?.shots ?? []).flatMap((s) => s.dialogue.map((d) => d.id)));
    p.audio = p.audio.filter((a) => live.has(a.dialogueId));
  });
};
