/** "Dadaji Dev!" -> "dadaji-dev"; with sep "_": "Village Shop" -> "village_shop". */
export function slugify(input: string, sep: "-" | "_" = "-"): string {
  const cut = (s: string) => s.replace(new RegExp(`^${sep}+|${sep}+$`, "g"), "");
  const slug = cut(
    input
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, sep),
  );
  return cut(slug.slice(0, 48));
}

export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SCENE_ID_PATTERN = /^scene-\d{2,3}$/;

/** Deterministic ids: the same inputs always produce the same ids, so assets can be cached and regenerated per scene. */
export const sceneId = (order: number): string => `scene-${String(order).padStart(2, "0")}`;
export const dialogueId = (scene: string, n: number): string => `${scene}-d${String(n).padStart(2, "0")}`;
export const locationKey = (location: string): string => slugify(location, "-") || "location";
export const backgroundAssetId = (location: string): string => `bg-${locationKey(location)}`;
/** Scene-specific background override (used when a single scene's background is regenerated on its own). */
export const sceneBackgroundAssetId = (scene: string): string => `bg-${scene}`;
export const characterAssetId = (characterId: string): string => `char-${characterId}`;
/** Scene-scoped so regenerating one scene never touches another scene's props. */
export const propAssetId = (scene: string, name: string): string => `prop-${scene}-${slugify(name) || "item"}`;
export const voiceAudioId = (dialogue: string): string => `voice-${dialogue}`;
export const subtitleAssetId = (dialogue: string, part: number): string => `sub-${dialogue}-${part}`;
export const sceneAudioAssetId = (scene: string): string => `scene-audio-${scene}`;
export const sceneVideoAssetId = (scene: string): string => `scene-video-${scene}`;
export const FINAL_VIDEO_ASSET_ID = "final-video";
