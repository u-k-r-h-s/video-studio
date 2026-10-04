import fs from "node:fs/promises";
import path from "node:path";
import {
  backgroundAssetId,
  characterAssetId,
  propAssetId,
  sceneBackgroundAssetId,
  type AssetKind,
  type FormatProfile,
  type Project,
  type Scene,
} from "@studio/shared";
import { StageOrderError } from "../../errors";
import { cropToContent, decodePng, encodePng, keyOutBackground } from "../../lib/png";
import type { ImageRequest } from "../../providers/image/ImageProvider";
import { findAsset, isFresh, upsertAsset } from "../assets";
import { stableHash, seedFor } from "../hash";
import { IMAGE_RECIPE_VERSION, backgroundPrompt, characterPrompt, propPrompt } from "../imagePrompts";
import { inScope, type Scope, type StageFn } from "../types";

export interface ImageNeed {
  assetId: string;
  kind: Extract<AssetKind, "background" | "character" | "prop">;
  sceneId?: string;
  characterId?: string;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  hash: string;
  /** Project-relative user-supplied art used instead of generation (characters only). */
  reference?: string;
}

const firstSceneAt = (p: Project, location: string): Scene | undefined => {
  const key = backgroundAssetId(location);
  return p.scenes.find((s) => backgroundAssetId(s.location) === key);
};

/** Everything the in-scope scenes need as images. Pure: no I/O except checking reference files. */
export function collectNeeds(p: Project, profile: FormatProfile, scope: Scope, referenceSize: (rel: string) => number | undefined): ImageNeed[] {
  const needs = new Map<string, ImageNeed>();
  const size = profile.images;
  const mk = (n: Omit<ImageNeed, "hash">, extra: object = {}): ImageNeed => ({
    ...n,
    hash: stableHash({ kind: n.kind, prompt: n.prompt, negative: n.negative, w: n.width, h: n.height, recipe: IMAGE_RECIPE_VERSION, provider: profile.imageProvider, ...extra }),
  });

  for (const scene of p.scenes.filter((s) => inScope(scope, s.id))) {
    // background: shared per location, or a scene-specific override
    const overrideId = sceneBackgroundAssetId(scene.id);
    const useOverride = !!(scope.includeBackground && scope.sceneIds) || findAsset(p, overrideId)?.status === "ready";
    if (useOverride) {
      const pr = backgroundPrompt(profile, scene);
      needs.set(overrideId, mk({ assetId: overrideId, kind: "background", sceneId: scene.id, prompt: pr.prompt, negative: pr.negative, ...size.background }));
    } else {
      const id = backgroundAssetId(scene.location);
      if (!needs.has(id)) {
        const pr = backgroundPrompt(profile, firstSceneAt(p, scene.location) ?? scene);
        needs.set(id, mk({ assetId: id, kind: "background", prompt: pr.prompt, negative: pr.negative, ...size.background }));
      }
    }
    for (const cid of scene.characters) {
      const id = characterAssetId(cid);
      const c = p.characters.find((x) => x.id === cid);
      if (!c || needs.has(id)) continue;
      const refSize = c.referenceImage ? referenceSize(c.referenceImage) : undefined;
      const pr = characterPrompt(profile, c);
      needs.set(id, mk({ assetId: id, kind: "character", characterId: cid, prompt: pr.prompt, negative: pr.negative, ...size.character, reference: refSize !== undefined ? c.referenceImage : undefined }, { ref: refSize !== undefined ? `${c.referenceImage}:${refSize}` : undefined }));
    }
    for (const name of scene.props) {
      const id = propAssetId(scene.id, name);
      const pr = propPrompt(profile, name);
      needs.set(id, mk({ assetId: id, kind: "prop", sceneId: scene.id, prompt: pr.prompt, negative: pr.negative, ...size.prop }));
    }
  }
  return [...needs.values()];
}

/** Whether `scope.force` applies to this asset: scene-owned items always, shared ones only when asked. */
export function isForced(need: ImageNeed, scope: Scope): boolean {
  if (!scope.force) return false;
  if (!scope.sceneIds) return true;
  if (need.kind === "prop") return true;
  if (need.kind === "background") return !!need.sceneId; // scene-specific background override
  return !!scope.includeCharacters;
}

/**
 * Stage 2: generate every missing/stale image for the project in ONE ComfyUI session.
 * The provider owns the gates (unload Ollama -> start -> generate all -> free -> stop -> verify). Each image is
 * persisted to project.json the moment it is saved, so a crash mid-batch loses at most the current image and the
 * next run only generates what is still missing.
 */
export const generateImages: StageFn = async (svc, ctx) => {
  const project = await svc.store.require(ctx.projectId);
  if (!project.reviewApproved) throw new StageOrderError("Review and approve the scene plan before generating images.");
  const profile = svc.profiles.get(project.formatProfile);
  const provider = svc.providers.image[profile.imageProvider];
  if (!provider) throw new StageOrderError(`No image provider "${profile.imageProvider}" is registered.`);
  const stage = "image_generation";

  const referenceSize = async (): Promise<(rel: string) => number | undefined> => {
    const sizes = new Map<string, number>();
    for (const c of project.characters) {
      if (c.referenceImage && svc.store.exists(project.id, c.referenceImage)) sizes.set(c.referenceImage, (await fs.stat(svc.store.resolve(project.id, c.referenceImage))).size);
    }
    return (rel) => sizes.get(rel);
  };

  const needs = collectNeeds(project, profile, ctx.scope, await referenceSize());
  const todo = needs.filter((n) => isForced(n, ctx.scope) || !isFresh(svc.store, project, n.assetId, n.hash));
  ctx.log.event({ stage }, "planned", { needed: needs.length, toGenerate: todo.length, cached: needs.length - todo.length });

  const persist = async (need: ImageNeed, rawRel: string, genMeta: { seed: number; durationMs: number; attempt: number }): Promise<void> => {
    let finalRel = rawRel;
    let width = need.width;
    let height = need.height;
    if (need.kind !== "background") {
      // Characters/props are generated on a flat colour: key it out, crop to the figure, keep the raw render too.
      const img = decodePng(await fs.readFile(svc.store.resolve(project.id, rawRel)));
      const cut = cropToContent(keyOutBackground(img));
      finalRel = `images/${need.assetId}.png`;
      await fs.writeFile(svc.store.resolve(project.id, finalRel), encodePng(cut));
      width = cut.width;
      height = cut.height;
    }
    await svc.store.update(project.id, (p) => {
      upsertAsset(p, {
        id: need.assetId, kind: need.kind, sceneId: need.sceneId, characterId: need.characterId, path: finalRel, status: "ready", inputHash: need.hash,
        meta: { width, height, seed: genMeta.seed, attempt: genMeta.attempt, durationMs: genMeta.durationMs, prompt: need.prompt, ...(need.kind !== "background" ? { rawPath: rawRel } : {}), ...(need.reference ? { reference: need.reference } : {}) },
        createdAt: new Date().toISOString(),
      });
    });
    ctx.log.event({ stage, scene: need.sceneId, asset: need.assetId }, "completed", { durationMs: genMeta.durationMs, seed: genMeta.seed });
  };

  await ctx.log.time({ stage }, async () => {
    if (todo.length > 0) {
      const mem = await svc.advisor.snapshot();
      ctx.log.event({ stage }, mem.freePercent !== null && mem.freePercent < svc.memoryWarnFreePercent ? "warning" : "memory", {
        freePercent: mem.freePercent, swapUsedMb: mem.swapUsedMb,
        ...(mem.freePercent !== null && mem.freePercent < svc.memoryWarnFreePercent ? { note: "low free memory: close other apps (browsers) for faster, safer generation" } : {}),
      });
    }

    // user-supplied reference art skips generation entirely
    const generated: ImageNeed[] = [];
    for (const need of todo) {
      if (need.reference) {
        await persist(need, need.reference, { seed: 0, durationMs: 0, attempt: 0 });
      } else generated.push(need);
    }

    const attemptOf = (need: ImageNeed): number => {
      const prev = findAsset(project, need.assetId);
      const prevAttempt = typeof prev?.meta.attempt === "number" ? (prev.meta.attempt as number) : -1;
      return prev && isForced(need, ctx.scope) ? prevAttempt + 1 : Math.max(0, prevAttempt); // forced regeneration = new seed
    };
    const attempts = new Map(generated.map((n) => [n.assetId, attemptOf(n)]));
    const requests: ImageRequest[] = generated.map((need) => ({
      id: need.assetId, prompt: need.prompt, negativePrompt: need.negative, width: need.width, height: need.height,
      seed: seedFor(project.id, need.assetId, attempts.get(need.assetId)!),
      outPath: svc.store.resolve(project.id, "images", need.kind === "background" ? `${need.assetId}.png` : `${need.assetId}.raw.png`),
    }));
    const byId = new Map(generated.map((n) => [n.assetId, n]));

    if (requests.length > 0) {
      await provider.generateBatch(requests, {
        signal: ctx.signal,
        logFile: svc.store.resolve(project.id, "logs", "comfyui.log"),
        onImageStart: (id) => ctx.log.event({ stage, scene: byId.get(id)!.sceneId, asset: id }, "started"),
        onProgress: (done, total, msg) => ctx.progress(10 + (80 * done) / total, msg),
        onImage: async (r) => persist(byId.get(r.id)!, path.relative(svc.store.dir(project.id), r.path), { seed: r.seed, durationMs: r.durationMs, attempt: attempts.get(r.id) ?? 0 }),
      });
    }
  });

  // statuses: scenes whose images are all fresh are "assets_ready"; downstream is reset for regenerated scenes
  const after = await svc.store.require(project.id);
  await svc.store.update(project.id, (p) => {
    for (const scene of p.scenes.filter((s) => inScope(ctx.scope, s.id))) {
      const sceneNeeds = collectNeeds(after, profile, { sceneIds: [scene.id] }, () => undefined);
      if (sceneNeeds.every((n) => isFresh(svc.store, after, n.assetId, n.hash) || n.reference)) scene.status = "assets_ready";
    }
  });
};
