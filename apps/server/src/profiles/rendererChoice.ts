import type { FormatProfile } from "@studio/shared";
import { HttpError } from "../errors";

/**
 * Explicit renderer selection (`npm run short -- --renderer=3d`). An explicit request is binding: an unknown value, or a
 * profile drawn by another engine, is an error; it never falls back to the other renderer.
 */
export type RendererChoice = "2d" | "3d";
/** The engine that draws a profile's frames: the 2D puppet renderer, Three.js, or none (the older still-image pipelines). */
export type RenderEngine = "canvas2d" | "three3d" | "still-image";

const SYNONYMS: Record<string, RendererChoice> = {
  "2d": "2d", canvas: "2d", canvas2d: "2d",
  "3d": "3d", three: "3d", threejs: "3d", "three.js": "3d", three3d: "3d", webgl: "3d",
};
export const ENGINE_OF_CHOICE: Record<RendererChoice, RenderEngine> = { "2d": "canvas2d", "3d": "three3d" };
const DEFAULT_PROFILE: Record<RendererChoice, string> = { "2d": "animated-short", "3d": "animated-short-3d" };

export function parseRendererChoice(raw: unknown): RendererChoice {
  const key = String(raw ?? "").trim().toLowerCase();
  const c = SYNONYMS[key];
  if (!c) throw new HttpError(400, "renderer_invalid", `Unknown renderer "${String(raw)}". Use --renderer=3d (Three.js) or --renderer=2d.`);
  return c;
}

export function engineOf(profile: FormatProfile): RenderEngine {
  if (profile.pipeline !== "animated") return "still-image";
  return profile.animation?.renderer === "three3d" ? "three3d" : "canvas2d";
}

/**
 * The profile a new project uses. No renderer requested: the requested profile as before. A renderer requested: its default
 * profile, or the explicitly requested profile if (and only if) that profile is drawn by the requested engine.
 */
export function profileForRenderer(choice: RendererChoice | undefined, requestedProfile: string | undefined, get: (id: string) => FormatProfile): string | undefined {
  if (!choice) return requestedProfile;
  const id = requestedProfile ?? DEFAULT_PROFILE[choice];
  const engine = engineOf(get(id));
  if (engine !== ENGINE_OF_CHOICE[choice]) {
    throw new HttpError(400, "renderer_mismatch", `--renderer=${choice} asks for ${ENGINE_OF_CHOICE[choice]}, but profile "${id}" is drawn by ${engine}. Drop --profile or choose a ${ENGINE_OF_CHOICE[choice]} profile.`);
  }
  return id;
}
