import { existsSync, readFileSync } from "node:fs";
import type { FormatProfile, Project, Story } from "@studio/shared";
import { animPaths } from "../../../anim/assets";
import { speechTrack, type SpeechTrack } from "../../../anim/lipsync";
import { castStory, loadCatalog } from "../../../anim/renderers/three3d/casting";
import { compileShot3D, endPositions, expressionOf } from "../../../anim/renderers/three3d/compile";
import { castFor, characterFile } from "../../../anim/renderers/three3d/library";
import type { Shot3DSpec, SpeechSpec3D } from "../../../anim/renderers/three3d/spec";
import { artStyleOf } from "../../../anim/renderers/three3d/artStyle";
import { planVisuals, type VisualPlan } from "../../../anim/renderers/three3d/visualPlan";
import type { ShotTiming } from "../../../shots/timeline";
import type { PipelineServices } from "../../types";

/** Is this profile rendered by the Three.js renderer? */
export const isThree3D = (profile: FormatProfile): boolean => profile.animation?.renderer === "three3d";

/** The story's visual plan (story-level decisions, made once per story). */
const plans = new Map<string, VisualPlan>();
export function visualPlanOf(svc: PipelineServices, p: Project, story: Story): VisualPlan {
  const profile = svc.profiles.get(p.formatProfile);
  const key = `${p.id}|${JSON.stringify(story.locations)}|${story.shots.map((s) => `${s.id}${s.locationId}${s.shotType}${s.emotion}`).join()}|${story.artStyle ?? profile.animation?.artStyle ?? ""}`;
  let plan = plans.get(key);
  if (!plan) { plan = planVisuals(story, story.artStyle ?? profile.animation?.artStyle); plans.set(key, plan); }
  return plan;
}

/** Lip-sync tracks, cached per voice file (the timeline and the render ask for the same lines). */
const tracks = new Map<string, SpeechTrack>();

/**
 * The 3D shot for story shot `index` (same compiler for the soundtrack cues and the render, so sound matches picture).
 * With the shot's timing, every visible speaker gets lip-sync from its own voice file.
 */
export function shot3dSpec(svc: PipelineServices, p: Project, story: Story, index: number, duration: number, timing?: ShotTiming): { spec: Shot3DSpec; notes: string[] } {
  const profile = svc.profiles.get(p.formatProfile);
  const shot = story.shots[index]!;
  const sceneShots = story.shots.filter((s) => s.sceneId === shot.sceneId);
  // scene blocking: everyone in this scene, in order of first appearance (one mark each for the whole scene)
  const sceneOf = (s: Story["shots"][number]): string => s.sceneId || s.locationId;
  const order: string[] = [];
  for (const s of story.shots) if (sceneOf(s) === sceneOf(shot)) for (const id of s.subjectIds) if (!order.includes(id) && p.characters.some((c) => c.id === id)) order.push(id);
  const before = [...new Set(story.shots.slice(0, index).filter((s) => sceneOf(s) === sceneOf(shot)).flatMap((s) => s.subjectIds))];
  // where the previous shot of this scene left everyone (the cut must not move them)
  const carry = index > 0 && sceneOf(story.shots[index - 1]!) === sceneOf(shot) ? endsOf(svc, p, story, index - 1) : undefined;
  // the previous shot's camera (same scene): a planned camera move opens on it, so the cut between them is invisible
  const prevCamera = index > 0 && sceneOf(story.shots[index - 1]!) === sceneOf(shot) ? cameraOf(svc, p, story, index - 1) : undefined;
  // one casting for the whole story: the best-fitting library model per character, no two characters alike
  const catalog = loadCatalog(undefined, (k) => existsSync(characterFile(k)));
  const plan = visualPlanOf(svc, p, story), style = artStyleOf(plan.artStyle);
  const cast = castStory(p.characters, catalog, profile.animation?.characterStyle ?? style.characters, process.env.STUDIO_3D_ASSET);
  const speech: Record<string, SpeechSpec3D[]> = {};
  for (const l of timing?.lines ?? []) {
    const a = p.audio.find((x) => x.dialogueId === l.dialogueId);
    if (!a || l.characterId === "narrator") continue;
    const file = svc.store.resolve(p.id, a.path);
    if (!existsSync(file)) continue;
    const key = `${file}|${a.inputHash}|${profile.video.fps}`;
    let tr = tracks.get(key);
    if (!tr) { tr = speechTrack(readFileSync(file), l.text, profile.video.fps); tracks.set(key, tr); }
    (speech[l.characterId] ??= []).push({ at: l.localStart, duration: Math.min(tr.duration, l.localEnd - l.localStart + 0.05), fps: tr.fps, env: tr.env, visemes: tr.visemes, expression: expressionOf(shot.emotion) });
  }
  return compileShot3D({
    shot, story, characters: p.characters, duration, width: profile.video.width, height: profile.video.height, fps: profile.video.fps, seed: index + 1,
    cast: (c) => ({ ...castFor(c), ...(cast[c.id] ? { asset: cast[c.id]! } : {}) }), indexInScene: sceneShots.findIndex((s) => s.id === shot.id), speech, ...(prevCamera ? { prevCamera } : {}), scene: { order, before, ...(carry ? { carry } : {}) },
    direction: { location: plan.locations.find((l) => l.locationId === shot.locationId) ?? plan.locations[0]!, shot: plan.shots[index], style },
    // the AI-painted location picture becomes the plate behind the 3D set
    backdrop: (l) => { const rel = animPaths.final(`loc-${l.id}`); const abs = svc.store.resolve(p.id, rel); return existsSync(abs) ? abs : undefined; },
  });
}

/** The camera spec of story shot `index` (its own composition; the duration does not change it). */
const cameras = new Map<string, Shot3DSpec["camera"]>();
function cameraOf(svc: PipelineServices, p: Project, story: Story, index: number): Shot3DSpec["camera"] {
  const key = `${p.id}|${index}|${story.shots.map((s) => s.id + s.locationId + s.shotType + s.subjectIds.join("+")).join()}`;
  let c = cameras.get(key);
  if (!c) { c = shot3dSpec(svc, p, story, index, 4).spec.camera; cameras.set(key, c); }
  return c;
}

/** End positions of story shot `index` (compiled without timing: walks end at their targets whatever the duration). */
const ends = new Map<string, Record<string, { x: number; z: number; heading: number }>>();
function endsOf(svc: PipelineServices, p: Project, story: Story, index: number): Record<string, { x: number; z: number; heading: number }> {
  const key = `${p.id}|${index}|${story.shots.map((s) => s.id + s.locationId + s.subjectIds.join("+")).join()}`;
  let e = ends.get(key);
  if (!e) { e = endPositions(shot3dSpec(svc, p, story, index, 4).spec); ends.set(key, e); }
  return e;
}
