import { existsSync } from "node:fs";
import type { FormatProfile, Project, Story } from "@studio/shared";
import { animPaths } from "../../../anim/assets";
import { compileShot3D } from "../../../anim/renderers/three3d/compile";
import { castFor } from "../../../anim/renderers/three3d/library";
import type { Shot3DSpec } from "../../../anim/renderers/three3d/spec";
import type { PipelineServices } from "../../types";

/** Is this profile rendered by the Three.js renderer? */
export const isThree3D = (profile: FormatProfile): boolean => profile.animation?.renderer === "three3d";

/** The 3D shot for story shot `index` (same compiler for the soundtrack cues and the render, so sound matches picture). */
export function shot3dSpec(svc: PipelineServices, p: Project, story: Story, index: number, duration: number): { spec: Shot3DSpec; notes: string[] } {
  const profile = svc.profiles.get(p.formatProfile);
  const shot = story.shots[index]!;
  const sceneShots = story.shots.filter((s) => s.sceneId === shot.sceneId);
  return compileShot3D({
    shot, story, characters: p.characters, duration, width: profile.video.width, height: profile.video.height, fps: profile.video.fps, seed: index + 1,
    cast: (c) => castFor(c), indexInScene: sceneShots.findIndex((s) => s.id === shot.id),
    // the AI-painted location picture becomes the plate behind the 3D set
    backdrop: (l) => { const rel = animPaths.final(`loc-${l.id}`); const abs = svc.store.resolve(p.id, rel); return existsSync(abs) ? abs : undefined; },
  });
}
