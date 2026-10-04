import type { FormatProfile, ServiceDetail, Motion } from "@studio/shared";

export interface ImageLayer {
  id: string;
  path: string;
  /** Source image size in pixels. */
  width: number;
  height: number;
  /** Horizontal centre as a fraction of the canvas width. */
  anchorX: number;
  anchorY: "bottom" | "top";
  /** Fraction of canvas height where the bottom (or top) edge sits. */
  y: number;
  /** Layer height as a fraction of canvas height at scale 1. Undefined = natural pixel size (subtitles). */
  heightFrac?: number;
  /** Visible only inside this window (seconds). Derived for props when omitted. */
  window?: [number, number];
}

export interface ScenePlan {
  sceneId: string;
  duration: number;
  video: FormatProfile["video"];
  background: { path: string };
  characters: ImageLayer[];
  props: ImageLayer[];
  subtitles: ImageLayer[];
  audioPath: string;
  motions: Motion[];
}

export interface RenderOutput {
  path: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  encoder: string;
  renderMs: number;
}

/** Turns a ScenePlan into a video clip and assembles clips into the final video. FFmpeg is one implementation. */
export interface SceneRenderer {
  readonly name: string;
  renderScene(plan: ScenePlan, outPath: string, hooks?: { signal?: AbortSignal }): Promise<RenderOutput>;
  assemble(clipPaths: string[], outPath: string, video: FormatProfile["video"]): Promise<RenderOutput>;
  health(): Promise<ServiceDetail>;
}
