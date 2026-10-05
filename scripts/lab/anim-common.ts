import { AssetLibrary } from "../../apps/server/src/anim/engine";
import { loadRig, makeDoorLeaf, makePole } from "../../apps/server/src/anim/loader";
import { loadConfig } from "../../apps/server/src/config";
import { setLogQuiet } from "../../apps/server/src/lib/logger";
import type { AnimShotSpec, AnimationEvent, EffectSpec, VisualLayer } from "../../apps/server/src/anim/types";

setLogQuiet(true);
export const ROOT = "/Users/apple/Desktop/ai-studio-feasibility";
export const A = `${ROOT}/projects/anim-lab`;
export const cfg = loadConfig({}, ROOT);
export const W = 1080, H = 1920, FPS = 30;

export async function loadLab(): Promise<{ lib: AssetLibrary; variants: string[] }> {
  const lib = new AssetLibrary();
  for (const id of ["bg-street", "bg-hall", "bg-building"]) await lib.addImage(id, `${A}/assets/${id}.png`);
  await lib.addImage("bg-street-soft", `${A}/assets/bg-street.png`, { blur: 5 });
  await lib.addImage("hand-phone", `${A}/cutouts/prop-hand-phone-n.png`);
  lib.images.set("pole", makePole());
  lib.images.set("door", makeDoorLeaf());
  const variants = await loadRig(lib, A, "char-rider-d402", "mira");
  return { lib, variants };
}

/** Street background wide enough for panning: centre-anchored, 1.15 x the frame height. */
export const bg = (id: string, over: Partial<VisualLayer> = {}): VisualLayer => ({ id: "bg", type: "background", source: id, x: W / 2, y: H / 2, scale: 1, opacity: 1, zIndex: 0, parallax: 0.6, height: H * 1.15, ...over });
export const mira = (over: Partial<VisualLayer> = {}): VisualLayer => ({ id: "mira", type: "character", source: "mira", x: 540, y: 1560, scale: 1, opacity: 1, zIndex: 20, height: 900, shadow: true, tint: "#10182c", tintAmount: 0.28, rim: { color: "#8fbaff", side: 1, amount: 0.45 }, ...over });
export const spec = (id: string, duration: number, layers: VisualLayer[], events: AnimationEvent[], effects: EffectSpec[] = [], extra: Partial<AnimShotSpec> = {}): AnimShotSpec => ({
  id, duration, width: W, height: H, fps: FPS, layers, events, effects, camera: { x: W / 2, y: H / 2, zoom: 1, rotation: 0 }, seed: 7, ...extra,
});
