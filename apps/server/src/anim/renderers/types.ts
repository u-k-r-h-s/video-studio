import type { AnimVideoOptions } from "../video";

/**
 * A shot renderer turns ONE shot description into a video clip (no audio) through the shared FFmpeg post chain
 * (grade, bloom, vignette, grain, caption overlays: `animPostGraph`). The pipeline picks one by the profile's renderer:
 *   canvas2d  - the layered 2D/2.5D puppet engine (AnimEngine)        - spec: AnimShotSpec + an AssetLibrary
 *   three3d   - rigged 3D characters in a Three.js scene (headless Chrome, WebGL) - spec: Shot3DSpec + 3D assets
 * Everything after the clip (captions, soundtrack, assembly, loudness) is the same for both.
 */
export type RendererId = "canvas2d" | "three3d";
export type ClipOptions = Omit<AnimVideoOptions, "onProgress"> & { onProgress?: (frame: number, total: number) => void };
export interface RenderResult { frames: number; renderMs: number; /** Sounds the animation implies, in shot seconds. */ cues: { kind: string; at: number; volume?: number }[]; info?: Record<string, unknown> }

export interface ShotRenderer<Spec> {
  readonly id: RendererId;
  render(spec: Spec, outPath: string, opts: ClipOptions): Promise<RenderResult>;
  /** Releases heavy resources (the browser). Safe to call twice. */
  close(): Promise<void>;
}
