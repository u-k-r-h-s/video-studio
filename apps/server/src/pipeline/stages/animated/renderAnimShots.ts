import fs from "node:fs/promises";
import { shotVideoAssetId, type Project } from "@studio/shared";
import { StageOrderError } from "../../../errors";
import { composeShot, type ComposedShot } from "../../../anim/compose";
import { AnimEngine, type AssetLibrary } from "../../../anim/engine";
import { loadAnimLibrary, type LibraryReport } from "../../../anim/library";
import { makeLitPhone } from "../../../anim/loader";
import { planAssets, type AssetManifest } from "../../../anim/manifest";
import { renderAnimShot } from "../../../anim/video";
import { findAsset, upsertAsset } from "../../assets";
import { stableHash } from "../../hash";
import type { PipelineServices, StageFn } from "../../types";
import { readShotCaptions } from "../shots/buildShotTimeline";
import { mediaOf, shotsInScope, storyOf } from "../shots/common";
import { Three3DRenderer } from "../../../anim/renderers/three3d";
import { characterFile } from "../../../anim/renderers/three3d/library";
import { isThree3D, shot3dSpec } from "./plan3d";
import { animationOf, animTimelineOf } from "./common";

/** Bump when the layered renderer, the compiler or the post chain changes so cached clips are re-rendered. */
export const ANIM_RENDER_RECIPE_VERSION = "anim-render-v1";
/** The marker every clip of this pipeline carries; assembly refuses a project with clips that do not have it. */
export const ANIM_RENDERER_ID = "anim";

export interface LoadedAnimProject { lib: AssetLibrary; report: LibraryReport; manifest: AssetManifest }

export async function loadProjectLibrary(svc: PipelineServices, p: Project): Promise<LoadedAnimProject> {
  const anim = animationOf(svc.profiles.get(p.formatProfile));
  const manifest = planAssets(storyOf(p), p.characters, anim);
  const { lib, report } = await loadAnimLibrary({ resolve: (rel) => svc.store.resolve(p.id, rel), exists: (rel) => svc.store.exists(p.id, rel), manifest, assets: p.assets });
  return { lib, report, manifest };
}

/** The art one composed shot actually uses (so editing one asset only re-renders the shots that show it). */
function usedAssetHashes(p: Project, manifest: AssetManifest, composed: ComposedShot): unknown[] {
  const sources = new Set<string>();
  const owners = new Set<string>();
  for (const l of composed.spec.layers) {
    if (l.type === "character") owners.add(l.rig ?? l.source);
    else sources.add(l.source.replace(/-(soft|lit)$/, "").replace(/-msg-.*$/, ""));
  }
  return manifest.assets
    .filter((a) => sources.has(a.id) || (a.ownerId && owners.has(a.ownerId)))
    .map((a) => { const r = findAsset(p, a.id); return [a.id, r?.inputHash ?? null, r?.meta?.attempt ?? null]; });
}

const wrapMessage = (text: string): string[] => {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean), lines: string[] = [];
  for (const w of words) { const last = lines[lines.length - 1]; if (last && (last + " " + w).length <= 10) lines[lines.length - 1] = `${last} ${w}`; else lines.push(w); }
  return lines.slice(0, 4);
};

/**
 * Stage 5 (animated pipeline): the layered animation renderer. For every shot the animation compiler turns the director's
 * semantic actions into layers + timed events + camera, the engine draws every frame (30 fps) and streams them into FFmpeg
 * (grade, bloom, vignette, grain, caption overlays). Clips are cached by a hash of the composed shot and the art it uses.
 */
export const renderAnimShots: StageFn = async (svc, ctx) => {
  const project = await svc.store.require(ctx.projectId);
  const profile = svc.profiles.get(project.formatProfile);
  const anim = animationOf(profile);
  const story = storyOf(project);
  const media = mediaOf(svc);
  await svc.gate.assertComfyUIStopped();
  await svc.gate.assertOllamaUnloaded();
  const stage = "scene_render";
  const encoders = await media.renderer.resolveEncoders(profile.video);
  const tl = animTimelineOf(project, story);
  if (isThree3D(profile)) return renderThree3D(svc, ctx, project, story, tl, encoders);
  const { lib, report, manifest } = await loadProjectLibrary(svc, project);
  if (!report.locations.length) throw new StageOrderError("No background has been generated. Generate the assets first.");
  ctx.log.event({ stage }, "library", { locations: report.locations.length, characters: Object.keys(report.characters).length, props: report.props.length, missing: report.missing.length });

  const shots = shotsInScope(story, ctx.scope);
  let done = 0;
  await ctx.log.time({ stage }, async () => {
    for (const shot of shots) {
      const current = await svc.store.require(project.id);
      const index = story.shots.findIndex((s) => s.id === shot.id);
      const st = tl.shots[index]!;
      const composed = composeShot({ shot, story, characters: current.characters, manifest, anim, duration: st.duration, fps: profile.video.fps, seed: index + 1, has: (id) => lib.images.has(id) || lib.rigs.has(id) || lib.puppets.has(id) });
      const { captions, hash: capHash } = await readShotCaptions(async (rel) => JSON.parse(await fs.readFile(svc.store.resolve(project.id, rel), "utf8")), current, shot.id);
      const insert = shot.insert && shot.insert.kind !== "phone" ? captions.insert : undefined; // a phone message is drawn on the phone itself
      const id = shotVideoAssetId(shot.id), rel = `shots/${shot.id}.mp4`;
      const hash = stableHash({
        recipe: ANIM_RENDER_RECIPE_VERSION, video: profile.video, bitrate: anim.bitrateKbps, grade: anim.grade, duration: st.duration, spec: composed.spec,
        art: usedAssetHashes(current, manifest, composed), captions: capHash, phone: composed.phoneMessage?.text, first: index === 0, last: index === story.shots.length - 1,
      });
      const prev = findAsset(current, id);
      if (prev && prev.status === "ready" && prev.inputHash === hash && prev.meta.renderer === ANIM_RENDERER_ID && svc.store.exists(project.id, rel) && !ctx.scope.force) {
        ctx.log.event({ stage, scene: shot.sceneId, asset: id }, "cached");
      } else {
        await ctx.log.time({ stage, scene: shot.sceneId, asset: id }, async () => {
          if (composed.phoneMessage) {
            const m = composed.phoneMessage, base = lib.images.get(m.asset), quad = report.phoneQuads[m.asset];
            if (base && quad) lib.images.set(m.key, await makeLitPhone(base, quad, { from: "UNKNOWN", lines: wrapMessage(m.text) }));
          }
          const engine = new AnimEngine(composed.spec, lib);
          let last: unknown, used = encoders[0]!, renderMs = 0, frames = 0;
          for (const enc of encoders) {
            try {
              used = enc;
              ({ renderMs, frames } = await renderAnimShot(engine, svc.store.resolve(project.id, rel), {
                ffmpeg: media.ffmpeg, encoder: enc, bitrateKbps: anim.bitrateKbps, grade: anim.grade, captions: captions.states, captionCenterY: composed.captionY, insert,
                fadeIn: index === 0 ? 0.25 : 0, fadeOut: index === story.shots.length - 1 ? 0.6 : 0,
              }));
              last = undefined;
              break;
            } catch (err) {
              last = err;
              if (ctx.signal?.aborted) throw err;
            }
          }
          if (last) throw last;
          const probe = await media.renderer.probe(svc.store.resolve(project.id, rel));
          await fs.writeFile(svc.store.resolve(project.id, `shots/${shot.id}.compiled.json`), JSON.stringify({ notes: composed.notes, spec: composed.spec }, null, 1));
          await svc.store.update(project.id, (p) => upsertAsset(p, {
            id, kind: "shot_video", sceneId: shot.sceneId, path: rel, status: "ready", inputHash: hash,
            meta: { renderer: ANIM_RENDERER_ID, durationSec: probe.durationSec, encoder: used, renderMs, frames, width: probe.width, height: probe.height, fps: probe.fps, shotId: shot.id, layers: composed.spec.layers.length, events: composed.spec.events.length },
            createdAt: new Date().toISOString(),
          }));
        });
      }
      ctx.progress(10 + (85 * ++done) / Math.max(1, shots.length), `Animated shot ${done}/${shots.length}`);
    }
  });
};

/**
 * The 3D branch: each shot is compiled to a Shot3DSpec (same Director JSON) and drawn by the Three.js renderer through the
 * same FFmpeg post chain and caption overlays; clips are cached by a hash of the 3D spec and the files it uses.
 */
async function renderThree3D(svc: PipelineServices, ctx: Parameters<StageFn>[1], project: Project, story: NonNullable<Project["story"]>, tl: ReturnType<typeof animTimelineOf>, encoders: string[]): Promise<void> {
  const profile = svc.profiles.get(project.formatProfile);
  const anim = animationOf(profile);
  const media = mediaOf(svc);
  const stage = "scene_render";
  const renderer = new Three3DRenderer({ characterFile, chrome: process.env.CHROME_PATH });
  const shots = shotsInScope(story, ctx.scope);
  let done = 0;
  try {
    await ctx.log.time({ stage }, async () => {
      for (const shot of shots) {
        const current = await svc.store.require(project.id);
        const index = story.shots.findIndex((s) => s.id === shot.id);
        const st = tl.shots[index]!;
        const { spec, notes } = shot3dSpec(svc, current, story, index, st.duration);
        const { captions, hash: capHash } = await readShotCaptions(async (rel) => JSON.parse(await fs.readFile(svc.store.resolve(project.id, rel), "utf8")), current, shot.id);
        const id = shotVideoAssetId(shot.id), rel = `shots/${shot.id}.mp4`;
        const files = [...spec.characters.map((c) => characterFile(c.asset)), spec.environment.backdrop].filter((f): f is string => !!f);
        const stamps = await Promise.all(files.map(async (f) => [f, (await fs.stat(f).catch(() => null))?.size ?? 0]));
        const hash = stableHash({ recipe: `${ANIM_RENDER_RECIPE_VERSION}-three3d-v1`, video: profile.video, bitrate: anim.bitrateKbps, grade: anim.grade, spec, files: stamps, captions: capHash, first: index === 0, last: index === story.shots.length - 1 });
        const prev = findAsset(current, id);
        if (prev && prev.status === "ready" && prev.inputHash === hash && svc.store.exists(project.id, rel) && !ctx.scope.force) { ctx.log.event({ stage, scene: shot.sceneId, asset: id }, "cached"); }
        else {
          await ctx.log.time({ stage, scene: shot.sceneId, asset: id }, async () => {
            const insert = shot.insert && shot.insert.kind !== "phone" ? captions.insert : undefined;
            const r = await renderer.render(spec, svc.store.resolve(project.id, rel), {
              ffmpeg: media.ffmpeg, encoder: encoders[0] as "h264_videotoolbox" | "libx264", bitrateKbps: anim.bitrateKbps, grade: anim.grade, captions: captions.states, captionCenterY: 0.83, insert,
              fadeIn: index === 0 ? 0.3 : 0, fadeOut: index === story.shots.length - 1 ? 0.6 : 0,
            });
            const probe = await media.renderer.probe(svc.store.resolve(project.id, rel));
            await fs.writeFile(svc.store.resolve(project.id, `shots/${shot.id}.compiled.json`), JSON.stringify({ notes, spec, info: r.info }, null, 1));
            await svc.store.update(project.id, (p) => upsertAsset(p, {
              id, kind: "shot_video", sceneId: shot.sceneId, path: rel, status: "ready", inputHash: hash,
              meta: { renderer: ANIM_RENDERER_ID, engine: "three3d", durationSec: probe.durationSec, encoder: encoders[0], renderMs: r.renderMs, frames: r.frames, width: probe.width, height: probe.height, fps: probe.fps, shotId: shot.id },
              createdAt: new Date().toISOString(),
            }));
          });
        }
        ctx.progress(10 + (85 * ++done) / Math.max(1, shots.length), `Rendered 3D shot ${done}/${shots.length}`);
      }
    });
  } finally {
    await renderer.close();
  }
}
