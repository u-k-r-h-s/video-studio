import type { Motion } from "@studio/shared";
import { cameraExpressions, fadeFilters, layerExpressions } from "./motionExpr";
import type { ImageLayer, ScenePlan } from "./SceneRenderer";

const num = (n: number): string => Number(n.toFixed(5)).toString();

export interface SceneGraph {
  /** FFmpeg input arguments, in order. Audio is the last input. */
  inputArgs: string[];
  filterGraph: string;
  audioInputIndex: number;
}

const motionsFor = (motions: Motion[], layer: "character" | "prop" | "subtitle", id: string): Motion[] =>
  motions.filter((m) => m.target.layer === layer && m.target.id === id);

/** Props are hidden until their first pop-in (scale from 0) starts. */
function derivedWindow(layer: ImageLayer, kind: "character" | "prop" | "subtitle", motions: Motion[]): [number, number] | undefined {
  if (layer.window) return layer.window;
  if (kind !== "prop") return undefined;
  const pop = motionsFor(motions, "prop", layer.id).find((m) => m.type === "scale" && m.from === 0);
  return pop ? [pop.start, 1e6] : undefined;
}

/**
 * Compiles a ScenePlan into an FFmpeg filter graph. Everything that moves comes from Motion primitives
 * (see motionExpr.ts); this function only wires layers together:
 *   background (zoompan camera) -> characters -> props -> subtitles
 */
export function buildSceneGraph(plan: ScenePlan): SceneGraph {
  const { width: W, height: H, fps } = plan.video;
  const N = Math.max(1, Math.ceil(plan.duration * fps));
  const inputArgs: string[] = ["-i", plan.background.path];
  const parts: string[] = [];

  // --- background with camera motion. 2x working size keeps slow zoom/pan smooth (zoompan snaps to whole pixels).
  const camera = cameraExpressions(plan.motions.filter((m) => m.target.layer === "camera"), `(on/${fps})`);
  parts.push(
    `[0:v]scale=${2 * W}:${2 * H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${2 * W}:${2 * H},` +
      `zoompan=z='${camera.zoom}':x='(iw-iw/zoom)*${camera.panX}':y='(ih-ih/zoom)*${camera.panY}':d=${N}:s=${W}x${H}:fps=${fps},format=yuv420p[bg]`,
  );

  let current = "bg";
  let inputIndex = 1;
  const addLayers = (layers: ImageLayer[], kind: "character" | "prop" | "subtitle") => {
    for (const layer of layers) {
      const i = inputIndex++;
      inputArgs.push("-loop", "1", "-framerate", String(fps), "-t", num(plan.duration), "-i", layer.path);
      const lm = motionsFor(plan.motions, kind, layer.id);
      const ex = layerExpressions(lm, "t");
      const chain: string[] = ["format=rgba"];
      if (layer.heightFrac !== undefined) {
        const pxPerSrcPx = (layer.heightFrac * H) / layer.height;
        chain.push(`scale=w='max(2,2*trunc(${num(layer.width * pxPerSrcPx)}*(${ex.scale})/2))':h=-2:eval=frame`);
      }
      chain.push(...fadeFilters(lm));
      parts.push(`[${i}:v]${chain.join(",")}[L${i}]`);
      const x = `${num(layer.anchorX)}*W-w/2+(${ex.dx})*W`;
      const y = layer.anchorY === "bottom" ? `${num(layer.y)}*H-h+(${ex.dy})*H` : `${num(layer.y)}*H+(${ex.dy})*H`;
      const win = derivedWindow(layer, kind, plan.motions);
      const enable = win ? `:enable='between(t,${num(win[0])},${num(win[1])})'` : "";
      const next = `V${i}`;
      parts.push(`[${current}][L${i}]overlay=x='${x}':y='${y}':eval=frame:format=auto${enable}[${next}]`);
      current = next;
    }
  };
  addLayers(plan.characters, "character");
  addLayers(plan.props, "prop");
  addLayers(plan.subtitles, "subtitle");

  parts.push(`[${current}]format=yuv420p[vout]`);
  inputArgs.push("-i", plan.audioPath);
  return { inputArgs, filterGraph: parts.join(";"), audioInputIndex: inputIndex };
}
