import fs from "node:fs/promises";
import path from "node:path";
import { voiceAudioId } from "@studio/shared";
import { CancelledError, StageOrderError } from "../../errors";
import { durationSec, encodeWav, parseWav, trimSilence } from "../../lib/wav";
import { resolveVoiceId } from "../../providers/tts/voices";
import { findAudio, upsertAudio } from "../assets";
import { stableHash } from "../hash";
import { inScope, type StageFn } from "../types";

/** Bump when trimming/processing changes so cached audio is regenerated. */
const VOICE_RECIPE_VERSION = "piper-trim-v1";

/**
 * Stage 3: Piper voices for every dialogue line, silence-trimmed so the timeline is exact.
 * Gate: ComfyUI must be verifiably stopped before Piper runs (the sequential-memory rule).
 */
export const generateVoices: StageFn = async (svc, ctx) => {
  const project = await svc.store.require(ctx.projectId);
  if (!project.reviewApproved) throw new StageOrderError("Review and approve the scene plan before generating voices.");
  const profile = svc.profiles.get(project.formatProfile);
  const tts = svc.providers.tts[profile.ttsProvider];
  if (!tts) throw new StageOrderError(`No TTS provider "${profile.ttsProvider}" is registered.`);
  await svc.gate.assertComfyUIStopped();
  const stage = "voice_generation";

  const lines = project.scenes.filter((s) => inScope(ctx.scope, s.id)).flatMap((scene) => scene.dialogue.map((d) => ({ scene, d })));
  let done = 0;
  await ctx.log.time({ stage }, async () => {
    for (const { scene, d } of lines) {
      if (ctx.signal?.aborted) throw new CancelledError();
      const voiceId = resolveVoiceId(d.characterId, project.characters, project.language, profile);
      const voice = tts.getVoice(voiceId);
      const hash = stableHash({ text: d.text, voiceId, model: voice.model, speaker: voice.speaker, recipe: VOICE_RECIPE_VERSION });
      const id = voiceAudioId(d.id);
      const current = await svc.store.require(project.id);
      const existing = findAudio(current, id);
      if (existing && existing.inputHash === hash && svc.store.exists(project.id, existing.path) && !ctx.scope.force) {
        ctx.log.event({ stage, scene: scene.id, asset: id }, "cached");
      } else {
        const rawRel = `audio/${d.id}.raw.wav`;
        const finalRel = `audio/${d.id}.wav`;
        await ctx.log.time({ stage, scene: scene.id, asset: id }, async () => {
          const raw = await tts.synthesize({ text: d.text, voiceId, outPath: svc.store.resolve(project.id, rawRel), signal: ctx.signal });
          const trimmed = trimSilence(parseWav(await fs.readFile(raw.path)));
          await fs.writeFile(svc.store.resolve(project.id, finalRel), encodeWav(trimmed.wav));
          await svc.store.update(project.id, (p) => {
            upsertAudio(p, { id, dialogueId: d.id, sceneId: scene.id, path: finalRel, durationSec: durationSec(trimmed.wav), voiceId, inputHash: hash, createdAt: new Date().toISOString() });
            const sc = p.scenes.find((x) => x.id === scene.id);
            const line = sc?.dialogue.find((x) => x.id === d.id);
            if (line) line.audioAssetId = id;
          });
        }, { voice: voiceId });
      }
      ctx.progress(10 + (85 * ++done) / Math.max(1, lines.length), `Voice ${done}/${lines.length}`);
    }
  });

  await svc.store.update(project.id, (p) => {
    const live = new Set(p.scenes.flatMap((s) => s.dialogue.map((d) => d.id)));
    p.audio = p.audio.filter((a) => live.has(a.dialogueId)); // drop audio of deleted lines
    for (const scene of p.scenes.filter((s) => inScope(ctx.scope, s.id))) {
      if (scene.dialogue.every((d) => p.audio.some((a) => a.dialogueId === d.id))) scene.status = "voiced";
    }
  });
};
