import fs from "node:fs/promises";
import path from "node:path";
import type { AssetKind } from "@studio/shared";
import { CancelledError, StageOrderError } from "../../../errors";
import { AssetCache, animPaths, makeCutout, makeHeadCrop, matteBox, readRgba, residualImage, unionMatte } from "../../../anim/assets";
import { diffManifest, planAssets, type AssetManifest, type ManifestAsset } from "../../../anim/manifest";
import { assessMatte } from "../../../lib/matte";
import { encodePng } from "../../../lib/png";
import type { ImageRequest } from "../../../providers/image/ImageProvider";
import { findAsset, upsertAsset } from "../../assets";
import { seedFor } from "../../hash";
import type { StageFn } from "../../types";
import { animationOf, storyOf } from "./common";

const KIND: Record<ManifestAsset["kind"], AssetKind> = { location: "anim_location", character_view: "anim_view", head_variant: "anim_head", prop: "anim_prop" };
const MAX_ROUNDS = 3;

/** The asset ids in scope when only some scenes are regenerated (plus whatever those assets are derived from). */
function inScopeIds(m: AssetManifest, sceneShots: Set<string> | null): Set<string> {
  if (!sceneShots) return new Set(m.assets.map((a) => a.id));
  const ids = new Set(m.assets.filter((a) => a.shots.some((s) => sceneShots.has(s))).map((a) => a.id));
  for (const a of m.assets) if (ids.has(a.id) && a.init) ids.add(a.init.assetId);
  return ids;
}

/**
 * Stage 2 (animated pipeline): generate the assets the manifest lists, in ONE ComfyUI session, and nothing else.
 *   locations -> wide backgrounds; characters -> the front view, then the other camera views (text-to-image with the same costume text and
 *   seed as the front) and the face variants (img2img on a crop of the head); props -> single objects.
 * Cut-outs come from the BiRefNet foreground matte (white, grey, black, pastel and glossy materials survive), checked by a
 * quality gate; a failed one is regenerated with a new seed in a later round. Everything is cached by the manifest hash, per
 * project and in a cache shared by all projects, so an asset that already exists is never generated again.
 */
export const generateAnimAssets: StageFn = async (svc, ctx) => {
  const project = await svc.store.require(ctx.projectId);
  if (!project.reviewApproved) throw new StageOrderError("Review and approve the plan before generating assets.");
  const profile = svc.profiles.get(project.formatProfile);
  const anim = animationOf(profile);
  const story = storyOf(project);
  const provider = svc.providers.image[profile.imageProvider];
  if (!provider) throw new StageOrderError(`No image provider "${profile.imageProvider}" is registered.`);
  const stage = "image_generation";
  const missingFiles: string[] = [];
  for (const f of [...(svc.modelFiles?.[anim.imageModel] ?? []), ...(svc.modelFiles?.birefnet ?? [])]) if (!(await fs.stat(f).then(() => true, () => false))) missingFiles.push(path.basename(f));
  if (missingFiles.length) throw new StageOrderError(`Required image models are not installed (missing: ${[...new Set(missingFiles)].join(", ")}). See README "Model installation".`);

  const manifest = planAssets(story, project.characters, anim);
  await fs.writeFile(svc.store.resolve(project.id, "manifest.json"), JSON.stringify(manifest, null, 1));
  const sceneShots = ctx.scope.sceneIds ? new Set(story.shots.filter((s) => ctx.scope.sceneIds!.includes(s.sceneId)).map((s) => s.id)) : null;
  const scopeIds = inScopeIds(manifest, sceneShots);

  const have = new Map<string, string>();
  for (const a of project.assets) if (a.status === "ready" && svc.store.exists(project.id, a.path)) have.set(a.id, a.inputHash);
  const { missing, reused } = diffManifest(manifest, have);
  let todo = missing.filter((a) => scopeIds.has(a.id));
  if (ctx.scope.force) todo = manifest.assets.filter((a) => scopeIds.has(a.id) && (a.kind !== "head_variant" || true));
  ctx.log.event({ stage }, "planned", { manifest: manifest.assets.length, reusedInProject: reused.length, toGenerate: todo.length });

  // register an asset (final file already in place)
  const register = async (a: ManifestAsset, meta: Record<string, unknown>): Promise<void> => {
    await svc.store.update(project.id, (p) => upsertAsset(p, { id: a.id, kind: KIND[a.kind], characterId: a.kind === "character_view" || a.kind === "head_variant" ? a.ownerId : undefined, path: animPaths.final(a.id), status: "ready", inputHash: a.hash, meta, createdAt: new Date().toISOString() }));
  };

  // 1. the shared cache: another project (or an earlier run) may already have made exactly this asset
  const cache: AssetCache | undefined = svc.assetCache;
  const fromCache: ManifestAsset[] = [];
  if (cache && !ctx.scope.force) {
    for (const a of todo) {
      const hit = await cache.get(a.hash, svc.store.resolve(project.id, animPaths.final(a.id)));
      if (hit) { await register(a, { ...hit.meta, fromCache: true }); fromCache.push(a); }
    }
    todo = todo.filter((a) => !fromCache.includes(a));
    if (fromCache.length) ctx.log.event({ stage }, "cached", { assets: fromCache.length });
  }
  if (todo.length === 0) return;

  const attemptOf = (a: ManifestAsset): number => {
    const prev = findAsset(project, a.id);
    const prevAttempt = typeof prev?.meta.attempt === "number" ? (prev.meta.attempt as number) : -1;
    return prev && ctx.scope.force ? prevAttempt + 1 : Math.max(0, prevAttempt);
  };
  const baseAttempt = new Map(todo.map((a) => [a.id, attemptOf(a)]));
  const mem = await svc.advisor.snapshot();
  ctx.log.event({ stage }, "memory", { freePercent: mem.freePercent, swapUsedMb: mem.swapUsedMb });

  const done = new Set<string>();
  const failures = new Map<string, string>();
  const rel = (r: string): string => svc.store.resolve(project.id, r);
  const finalOf = async (id: string) => readRgba(rel(animPaths.final(id)));
  const byId = new Map(manifest.assets.map((a) => [a.id, a]));

  await ctx.log.time({ stage }, async () => {
    for (let round = 0; round < MAX_ROUNDS && todo.length > 0; round++) {
      if (ctx.signal?.aborted) throw new CancelledError();
      const matte1 = new Map<string, Awaited<ReturnType<typeof readRgba>>>();
      const rawReady = new Set<string>(); // generated in THIS round (a stale file from an earlier run must not be matted)
      const requests: ImageRequest[] = [];
      const seedOf = (a: ManifestAsset): number => seedFor(project.id, a.seedKey ?? a.id, (baseAttempt.get(a.id) ?? 0) + round);

      const finish = async (a: ManifestAsset, rawRel: string, mattes: Awaited<ReturnType<typeof readRgba>>[]): Promise<void> => {
        const raw = await readRgba(rel(rawRel));
        const matte = mattes.length > 1 ? unionMatte(mattes[0]!, mattes[1]!) : mattes[0]!;
        const { cut, box } = makeCutout(raw, matte, a.kind !== "head_variant");
        const qc = assessMatte(cut, a.kind === "character_view" ? "character" : a.kind === "head_variant" ? "head" : "prop");
        if (!qc.ok) { failures.set(a.id, qc.reason ?? "bad cut-out"); ctx.log.event({ stage, asset: a.id }, "warning", { quality: qc.reason, round }); return; }
        await fs.writeFile(rel(animPaths.final(a.id)), encodePng(cut));
        const primary = mattes.length > 1 ? matteBox(mattes[0]!) : null;
        const meta: Record<string, unknown> = { attempt: (baseAttempt.get(a.id) ?? 0) + round, seed: seedOf(a), qc: { coverage: qc.coverage, components: qc.components }, label: a.label, ...(primary ? { primaryBox: { x: primary.x - box.x, y: primary.y - box.y, w: primary.w, h: primary.h } } : {}) };
        await register(a, meta);
        if (cache) await cache.put(a.hash, rel(animPaths.final(a.id)), meta);
        failures.delete(a.id);
        done.add(a.id);
      };

      for (const a of todo) {
        const raw = animPaths.raw(a.id);
        const gen: ImageRequest = {
          id: a.id, prompt: a.prompt, negativePrompt: a.negative, width: a.width, height: a.height, seed: seedOf(a), outPath: rel(raw), model: a.model, steps: a.steps, cfg: a.cfg, maxAttempts: 1,
        };
        if (a.init) {
          const initAsset = byId.get(a.init.assetId)!;
          const denoise = a.init.denoise;
          if (a.kind === "head_variant") {
            gen.prepare = async () => {
              if (!svc.store.exists(project.id, animPaths.final(initAsset.id))) return null; // the front view is not available (yet)
              const { png } = await makeHeadCrop(await finalOf(initAsset.id));
              await fs.mkdir(path.dirname(rel(animPaths.headCrop(a.ownerId))), { recursive: true });
              await fs.writeFile(rel(animPaths.headCrop(a.ownerId)), png);
              return { initImage: { path: rel(animPaths.headCrop(a.ownerId)), denoise } };
            };
          } else {
            gen.prepare = async () => (svc.store.exists(project.id, animPaths.raw(initAsset.id)) && svc.store.exists(project.id, animPaths.final(initAsset.id)) ? { initImage: { path: rel(animPaths.raw(initAsset.id)), denoise } } : null);
          }
        }
        requests.push(gen);
        if (a.matte !== "none") {
          const m1 = animPaths.matte(a.id);
          requests.push({
            id: `${a.id}~m1`, task: "matte", prompt: "", negativePrompt: "", width: 0, height: 0, seed: 0, outPath: rel(m1), initImage: { path: rel(raw), denoise: 1 },
            prepare: async () => (rawReady.has(a.id) ? undefined : null),
          });
          if (a.matte === "multi") {
            requests.push({
              id: `${a.id}~m2`, task: "matte", prompt: "", negativePrompt: "", width: 0, height: 0, seed: 0, outPath: rel(animPaths.matte(a.id, 2)),
              prepare: async () => {
                const first = matte1.get(a.id);
                if (!first) return null;
                await fs.writeFile(rel(animPaths.rest(a.id)), encodePng(residualImage(await readRgba(rel(raw)), first)));
                return { initImage: { path: rel(animPaths.rest(a.id)), denoise: 1 } };
              },
            });
          }
        }
      }

      await provider.generateBatch(requests, {
        signal: ctx.signal,
        logFile: svc.store.resolve(project.id, "logs", "comfyui.log"),
        onImageStart: (id) => ctx.log.event({ stage, asset: id.replace(/~m\d$/, "") }, "started", { step: id.includes("~m") ? "matte" : "generate", round }),
        onProgress: (n, total, msg) => ctx.progress(10 + (80 * (round + n / Math.max(1, total))) / MAX_ROUNDS, msg),
        onImage: async (r) => {
          const m = /^(.*)~m(\d)$/.exec(r.id);
          if (!m) {
            const a = byId.get(r.id)!;
            rawReady.add(a.id);
            if (a.kind === "location") {
              await fs.copyFile(r.path, rel(animPaths.final(a.id)));
              const meta = { attempt: (baseAttempt.get(a.id) ?? 0) + round, seed: r.seed, durationMs: r.durationMs, label: a.label };
              await register(a, meta);
              if (cache) await cache.put(a.hash, rel(animPaths.final(a.id)), meta);
              done.add(a.id);
            }
            return;
          }
          const a = byId.get(m[1]!)!;
          const matte = await readRgba(r.path);
          if (m[2] === "1") {
            matte1.set(a.id, matte);
            if (a.matte === "single") await finish(a, animPaths.raw(a.id), [matte]);
          } else {
            await finish(a, animPaths.raw(a.id), [matte1.get(a.id)!, matte]);
          }
        },
      });
      todo = todo.filter((a) => !done.has(a.id));
    }
  });

  // fatal when a background or a character's front view is missing; props and extra views/faces degrade gracefully
  const critical = todo.filter((a) => a.kind === "location" || (a.kind === "character_view" && a.view === "front"));
  if (critical.length) throw new Error(`Could not make ${critical.map((a) => a.id).join(", ")}: ${critical.map((a) => failures.get(a.id) ?? "not generated").join("; ")}`);
  for (const a of todo) ctx.log.event({ stage, asset: a.id }, "warning", { skipped: failures.get(a.id) ?? "not generated" });
};

