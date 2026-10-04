import type { Asset, AssetKind, AudioAsset, Project } from "@studio/shared";
import type { ProjectStore } from "../storage/ProjectStore";

/** Registry helpers. The asset registry in project.json is what makes the pipeline resumable and cache-aware. */
export const findAsset = (p: Project, id: string): Asset | undefined => p.assets.find((a) => a.id === id);
export const findAudio = (p: Project, id: string): AudioAsset | undefined => p.audio.find((a) => a.id === id);

/** An asset is fresh when it is ready, its input hash is unchanged, and its file still exists. */
export function isFresh(store: ProjectStore, p: Project, id: string, inputHash: string): boolean {
  const a = findAsset(p, id);
  return !!a && a.status === "ready" && a.inputHash === inputHash && store.exists(p.id, a.path);
}

export function upsertAsset(p: Project, asset: Asset): void {
  const i = p.assets.findIndex((a) => a.id === asset.id);
  if (i >= 0) p.assets[i] = asset;
  else p.assets.push(asset);
}

export function upsertAudio(p: Project, audio: AudioAsset): void {
  const i = p.audio.findIndex((a) => a.id === audio.id);
  if (i >= 0) p.audio[i] = audio;
  else p.audio.push(audio);
}

export const assetsOfKind = (p: Project, kind: AssetKind, sceneId?: string): Asset[] =>
  p.assets.filter((a) => a.kind === kind && (sceneId === undefined || a.sceneId === sceneId));

export const metaNumber = (a: Asset, key: string): number => {
  const v = a.meta[key];
  if (typeof v !== "number") throw new Error(`asset ${a.id} has no numeric meta.${key}`);
  return v;
};
