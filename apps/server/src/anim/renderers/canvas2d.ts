import { audioCuesFor } from "../cues";
import { AnimEngine, type AssetLibrary } from "../engine";
import type { AnimShotSpec } from "../types";
import { renderAnimShot } from "../video";
import type { ClipOptions, RenderResult, ShotRenderer } from "./types";

/** The existing 2D puppet renderer behind the common interface (no behaviour change). */
export class Canvas2DRenderer implements ShotRenderer<AnimShotSpec> {
  readonly id = "canvas2d" as const;
  constructor(private readonly lib: AssetLibrary) {}
  async render(spec: AnimShotSpec, outPath: string, opts: ClipOptions): Promise<RenderResult> {
    const r = await renderAnimShot(new AnimEngine(spec, this.lib), outPath, opts);
    return { ...r, cues: audioCuesFor(spec) };
  }
  async close(): Promise<void> {}
}
