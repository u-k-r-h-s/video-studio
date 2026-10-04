import fs from "node:fs/promises";
import path from "node:path";
import { keyVisualAssetId, type KeyVisual } from "@studio/shared";
import { StageOrderError } from "../../../errors";
import { decodePng } from "../../../lib/png";
import type { ImageRequest } from "../../../providers/image/ImageProvider";
import { KEY_RECIPE_VERSION } from "../../../shots/keyVisuals";
import { findAsset, isFresh, upsertAsset } from "../../assets";
import { seedFor, stableHash } from "../../hash";
import type { StageFn } from "../../types";
import { cinematicOf, storyOf } from "./common";

/** Rejects black or flat images (a failed sample): mean luma and contrast, measured on a subsample. */
export function assessKeyImage(rgba: { width: number; height: number; data: Uint8Array }): string | null {
  const step = Math.max(1, Math.floor((rgba.width * rgba.height) / 20000));
  let n = 0, sum = 0, sum2 = 0;
  for (let i = 0; i < rgba.width * rgba.height; i += step) {
    const o = i * 4, y = 0.299 * rgba.data[o]! + 0.587 * rgba.data[o + 1]! + 0.114 * rgba.data[o + 2]!;
    sum += y; sum2 += y * y; n++;
  }
  const mean = sum / n, sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  if (mean < 6) return "the image is almost black";
  if (sd < 5) return "the image is flat (no detail)";
  return null;
}

/**
 * Stage 2 (shot pipeline): generate the story's key images in ONE ComfyUI session. Shots share images, portraits of the
 * same character are img2img variants of its first portrait, and a budget caps the total (see keyVisuals.ts).
 * Gates and per-image persistence/resume are the same as in the scene pipeline.
 */
export const generateKeyVisuals: StageFn = async (svc, ctx) => {
  const project = await svc.store.require(ctx.projectId);
  if (!project.reviewApproved) throw new StageOrderError("Review and approve the plan before generating images.");
  const profile = svc.profiles.get(project.formatProfile);
  const cin = cinematicOf(profile);
  const story = storyOf(project);
  const provider = svc.providers.image[profile.imageProvider];
  if (!provider) throw new StageOrderError(`No image provider "${profile.imageProvider}" is registered.`);
  const stage = "image_generation";
  const missingFiles = [];
  for (const f of svc.modelFiles?.[cin.imageModel] ?? []) if (!(await fs.stat(f).then(() => true, () => false))) missingFiles.push(path.basename(f));
  if (missingFiles.length) throw new StageOrderError(`The image model "${cin.imageModel}" is not installed (missing: ${missingFiles.join(", ")}). See README "Model installation".`);

  const inScope = (k: KeyVisual): boolean => !ctx.scope.sceneIds || k.shotIds.some((id) => ctx.scope.sceneIds!.includes(story.shots.find((s) => s.id === id)?.sceneId ?? ""));
  interface Need { key: KeyVisual; assetId: string; rel: string; hash: string; forced: boolean }
  const needs = new Map<string, Need>();
  const todo = new Set<string>();
  for (const key of story.keyVisuals) {
    const assetId = keyVisualAssetId(key.id);
    const anchor = key.initFrom ? needs.get(key.initFrom.keyId) : undefined;
    const hash = stableHash({ prompt: key.prompt, model: cin.imageModel, size: cin.keyImage, neg: cin.negativePrompt, recipe: KEY_RECIPE_VERSION, init: key.initFrom ? { denoise: key.initFrom.denoise, anchor: anchor?.hash } : undefined });
    const forced = !!ctx.scope.force && inScope(key);
    const n: Need = { key, assetId, rel: `images/${assetId}.png`, hash, forced };
    needs.set(key.id, n);
    // a variant is stale whenever its anchor is being regenerated
    if (forced || !isFresh(svc.store, project, assetId, hash) || (key.initFrom && todo.has(key.initFrom.keyId))) todo.add(key.id);
  }
  const queue = story.keyVisuals.filter((k) => todo.has(k.id)); // anchors precede their variants (planKeyVisuals orders them)
  ctx.log.event({ stage }, "planned", { needed: needs.size, toGenerate: queue.length, cached: needs.size - queue.length });

  const attemptOf = (n: Need): number => {
    const prev = findAsset(project, n.assetId);
    const prevAttempt = typeof prev?.meta.attempt === "number" ? (prev.meta.attempt as number) : -1;
    return prev && n.forced ? prevAttempt + 1 : Math.max(0, prevAttempt);
  };
  const attempts = new Map(queue.map((k) => [k.id, attemptOf(needs.get(k.id)!)]));
  const byAsset = new Map(queue.map((k) => [keyVisualAssetId(k.id), needs.get(k.id)!]));

  await ctx.log.time({ stage }, async () => {
    if (queue.length === 0) return;
    const mem = await svc.advisor.snapshot();
    ctx.log.event({ stage }, mem.freePercent !== null && mem.freePercent < svc.memoryWarnFreePercent ? "warning" : "memory", { freePercent: mem.freePercent, swapUsedMb: mem.swapUsedMb });
    const requests: ImageRequest[] = queue.map((k) => {
      const n = needs.get(k.id)!;
      return {
        id: n.assetId, prompt: k.prompt, negativePrompt: cin.negativePrompt, width: cin.keyImage.width, height: cin.keyImage.height, seed: seedFor(project.id, n.assetId, attempts.get(k.id)!),
        outPath: svc.store.resolve(project.id, n.rel), model: cin.imageModel, steps: cin.keyImage.steps, cfg: cin.keyImage.cfg, maxAttempts: 2,
        ...(k.initFrom ? { initImage: { path: svc.store.resolve(project.id, `images/${keyVisualAssetId(k.initFrom.keyId)}.png`), denoise: k.initFrom.denoise } } : {}),
      };
    });
    await provider.generateBatch(requests, {
      signal: ctx.signal,
      logFile: svc.store.resolve(project.id, "logs", "comfyui.log"),
      onImageStart: (id) => ctx.log.event({ stage, asset: id }, "started"),
      onProgress: (done, total, msg) => ctx.progress(10 + (80 * done) / total, msg),
      validate: async (r) => assessKeyImage(decodePng(await fs.readFile(r.path))),
      onImage: async (r) => {
        const n = byAsset.get(r.id)!;
        await svc.store.update(project.id, (p) => {
          upsertAsset(p, {
            id: n.assetId, kind: "key_visual", path: n.rel, status: "ready", inputHash: n.hash,
            meta: { width: cin.keyImage.width, height: cin.keyImage.height, seed: r.seed, attempt: attempts.get(n.key.id) ?? 0, durationMs: r.durationMs, tries: r.attempts ?? 1, prompt: n.key.prompt, model: cin.imageModel, kind: n.key.kind, ...(r.qualityWarning ? { qualityWarning: r.qualityWarning } : {}), ...(n.key.initFrom ? { initFrom: n.key.initFrom.keyId } : {}) },
            createdAt: new Date().toISOString(),
          });
        });
        ctx.log.event({ stage, asset: n.assetId }, r.qualityWarning ? "warning" : "completed", { durationMs: r.durationMs, seed: r.seed });
      },
    });
  });
};
