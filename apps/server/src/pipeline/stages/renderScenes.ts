import {
  backgroundAssetId,
  characterAssetId,
  propAssetId,
  sceneAudioAssetId,
  sceneBackgroundAssetId,
  sceneVideoAssetId,
  type Asset,
  type Project,
  type Scene,
} from "@studio/shared";
import { StageOrderError } from "../../errors";
import { characterSlots, planMotion, propSlots } from "../../render/motionPlanner";
import type { ImageLayer, ScenePlan } from "../../render/SceneRenderer";
import { buildCues } from "../../render/subtitleCues";
import { findAsset, metaNumber, upsertAsset } from "../assets";
import { stableHash } from "../hash";
import { inScope, type PipelineServices, type StageFn } from "../types";

/** Bump when the motion planner / filter graph changes so cached clips are re-rendered. */
const RENDER_RECIPE_VERSION = "ffmpeg-motion-v1";

/** The background a scene uses: its own override if one was generated, else the shared location background. */
export function backgroundFor(p: Project, scene: Scene): Asset | undefined {
  const own = findAsset(p, sceneBackgroundAssetId(scene.id));
  return own?.status === "ready" ? own : findAsset(p, backgroundAssetId(scene.location));
}

interface SceneInputs {
  plan: Omit<ScenePlan, "audioPath" | "background" | "characters" | "props" | "subtitles"> & { audioPath: string; background: { path: string }; characters: ImageLayer[]; props: ImageLayer[]; subtitles: ImageLayer[] };
  hash: string;
}

/** Everything the renderer needs for one scene, plus a hash of all of it (for caching). Throws if a prerequisite is missing. */
export function resolveSceneInputs(svc: PipelineServices, p: Project, scene: Scene): SceneInputs {
  const profile = svc.profiles.get(p.formatProfile);
  const need = (a: Asset | undefined, what: string): Asset => {
    if (!a || a.status !== "ready" || !svc.store.exists(p.id, a.path)) throw new StageOrderError(`${what} for ${scene.id} is missing. Run the earlier stages first (images -> voices -> timeline).`);
    return a;
  };
  const abs = (a: Asset) => svc.store.resolve(p.id, a.path);
  const bg = need(backgroundFor(p, scene), "The background image");
  const audio = need(findAsset(p, sceneAudioAssetId(scene.id)), "The scene audio");
  if (scene.dialogue.some((d) => d.startTime === undefined)) throw new StageOrderError(`The timeline for ${scene.id} has not been built yet.`);

  const slots = characterSlots(scene.characters.length);
  const characters = scene.characters.map<ImageLayer>((cid, i) => {
    const a = need(findAsset(p, characterAssetId(cid)), `The image of character "${cid}"`);
    return { id: cid, path: abs(a), width: metaNumber(a, "width"), height: metaNumber(a, "height"), anchorX: slots[i]!, anchorY: "bottom", y: profile.layout.characterBaseline, heightFrac: profile.layout.characterHeight };
  });
  const pslots = propSlots(scene.props.length);
  const propIds = scene.props.map((name) => propAssetId(scene.id, name));
  const props = scene.props.map<ImageLayer>((name, i) => {
    const a = need(findAsset(p, propAssetId(scene.id, name)), `The prop image "${name}"`);
    return { id: a.id, path: abs(a), width: metaNumber(a, "width"), height: metaNumber(a, "height"), anchorX: pslots[i]!, anchorY: "bottom", y: profile.layout.propBaseline, heightFrac: profile.layout.propHeight };
  });
  const cues = buildCues(scene);
  const subtitles = cues.map<ImageLayer>((c) => {
    const a = need(findAsset(p, c.id), "The subtitle image");
    return { id: c.id, path: abs(a), width: metaNumber(a, "width"), height: metaNumber(a, "height"), anchorX: 0.5, anchorY: "top", y: profile.layout.subtitleY, window: [c.start, c.end] };
  });
  const motions = planMotion({ scene, profile, duration: scene.duration, propIds, cues });
  const plan = { sceneId: scene.id, duration: scene.duration, video: profile.video, background: { path: abs(bg) }, characters, props, subtitles, audioPath: abs(audio), motions };

  const hash = stableHash({
    recipe: RENDER_RECIPE_VERSION, renderer: profile.sceneRenderer, video: profile.video, duration: scene.duration, motions,
    // `attempt` increments on every forced regeneration, so a new image with the same prompt still invalidates the clip
    bg: [bg.id, bg.inputHash, bg.meta.attempt], audio: audio.inputHash,
    chars: characters.map((c) => { const a = findAsset(p, characterAssetId(c.id))!; return [c.id, a.inputHash, a.meta.attempt, c.anchorX]; }),
    props: props.map((x) => { const a = findAsset(p, x.id)!; return [x.id, a.inputHash, a.meta.attempt, x.anchorX]; }),
    subs: subtitles.map((x) => [x.id, findAsset(p, x.id)!.inputHash, x.window]),
  });
  return { plan, hash };
}

/**
 * Stage 5: one FFmpeg clip per scene (cached by input hash, so only changed scenes are re-rendered).
 * Gate: both heavy models must be verifiably gone before FFmpeg runs.
 */
export const renderScenes: StageFn = async (svc, ctx) => {
  const project = await svc.store.require(ctx.projectId);
  const profile = svc.profiles.get(project.formatProfile);
  const renderer = svc.providers.renderer[profile.sceneRenderer];
  if (!renderer) throw new StageOrderError(`No scene renderer "${profile.sceneRenderer}" is registered.`);
  await svc.gate.assertComfyUIStopped();
  await svc.gate.assertOllamaUnloaded();
  const stage = "scene_render";

  const scenes = project.scenes.filter((s) => inScope(ctx.scope, s.id));
  let done = 0;
  await ctx.log.time({ stage }, async () => {
    for (const scene of scenes) {
      const current = await svc.store.require(project.id);
      const fresh = current.scenes.find((s) => s.id === scene.id)!;
      const { plan, hash } = resolveSceneInputs(svc, current, fresh);
      const id = sceneVideoAssetId(scene.id);
      const prev = findAsset(current, id);
      const rel = `scenes/${scene.id}.mp4`;
      if (prev && prev.status === "ready" && prev.inputHash === hash && svc.store.exists(project.id, rel) && !ctx.scope.force) {
        ctx.log.event({ stage, scene: scene.id, asset: id }, "cached");
      } else {
        const { value: out } = await ctx.log.time({ stage, scene: scene.id, asset: id }, () => renderer.renderScene(plan as ScenePlan, svc.store.resolve(project.id, rel), { signal: ctx.signal }));
        await svc.store.update(project.id, (p) => {
          upsertAsset(p, { id, kind: "scene_video", sceneId: scene.id, path: rel, status: "ready", inputHash: hash, meta: { durationSec: out.durationSec, encoder: out.encoder, renderMs: out.renderMs, width: out.width, height: out.height, fps: out.fps }, createdAt: new Date().toISOString() });
        });
      }
      await svc.store.update(project.id, (p) => { const sc = p.scenes.find((x) => x.id === scene.id); if (sc) sc.status = "rendered"; });
      ctx.progress(10 + (85 * ++done) / Math.max(1, scenes.length), `Rendered ${done}/${scenes.length}`);
    }
  });
};
