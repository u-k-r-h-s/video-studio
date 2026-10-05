import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { DEFAULT_GRADE, type CaptionOverlay, type GradeSpec } from "../shots/shotRenderer";
import { AnimEngine } from "./engine";

export interface AnimVideoOptions {
  ffmpeg: string;
  encoder: "h264_videotoolbox" | "libx264";
  bitrateKbps: number;
  grade?: Partial<GradeSpec>;
  /** Fade from/to black. */
  fadeIn?: number;
  fadeOut?: number;
  captions?: CaptionOverlay[];
  captionCenterY?: number;
  insert?: CaptionOverlay & { centerY: number };
  onProgress?: (frame: number, total: number) => void;
}

const f = (n: number, d = 4): string => Number(n.toFixed(d)).toString();

/**
 * Post chain applied to the raw rendered frames: film grade, bloom, vignette, sharpening, grain, fades, then caption
 * overlays. (Motion, weather and camera are already in the frames; this is only the "look".)
 */
export function animPostGraph(W: number, H: number, D: number, fps: number, o: AnimVideoOptions): { inputs: string[]; filter: string } {
  const g: GradeSpec = { ...DEFAULT_GRADE, haze: 0, ...o.grade };
  const lines: string[] = [];
  lines.push(`[0:v]format=yuv420p,eq=contrast=${f(g.contrast)}:saturation=${f(g.saturation)}:gamma=${f(g.gamma)},colorbalance=rs=${f(-g.shadowTeal)}:bs=${f(g.shadowTeal * 1.4)}:rh=${f(g.highlightWarm)}:bh=${f(-g.highlightWarm)},split=2[g1][g2]`);
  lines.push(`[g2]curves=all='0/0 0.62/0 0.82/0.55 1/1',scale=${Math.round(W / 4)}:${Math.round(H / 4)}:flags=area,gblur=sigma=14,scale=${W}:${H}:flags=bicubic[bl]`);
  lines.push(`[g1][bl]blend=all_mode=screen:all_opacity=${f(g.bloom)},vignette=angle=PI/${f(6 / Math.max(0.2, g.vignette), 2)}:mode=forward,unsharp=5:5:${f(g.sharpen)}:5:5:0,noise=alls=${Math.round(g.grain)}:allf=t,format=yuv420p[graded]`);
  let cur = "graded";
  const fades: string[] = [];
  if (o.fadeIn) fades.push(`fade=t=in:st=0:d=${f(o.fadeIn)}`);
  if (o.fadeOut) fades.push(`fade=t=out:st=${f(Math.max(0, D - o.fadeOut))}:d=${f(o.fadeOut)}`);
  if (fades.length) { lines.push(`[${cur}]${fades.join(",")}[fd]`); cur = "fd"; }
  const inputs: string[] = [];
  let idx = 1;
  const ov = (c: CaptionOverlay, cy: number, label: string): void => {
    inputs.push("-loop", "1", "-framerate", String(fps), "-t", f(D + 0.1), "-i", c.png);
    const a = f(c.start), b = f(c.end);
    lines.push(`[${cur}][${idx}:v]overlay=x='(W-w)/2':y='${f(cy * H)}-h/2+16*max(0,1-(t-${a})/0.12)':enable='between(t,${a},${b})':format=auto[${label}]`);
    cur = label;
    idx += 1;
  };
  if (o.insert) ov(o.insert, o.insert.centerY, "ins");
  (o.captions ?? []).forEach((c, i) => ov(c, o.captionCenterY ?? 0.7, `cp${i}`));
  lines.push(`[${cur}]format=yuv420p,setsar=1[vout]`);
  return { inputs, filter: lines.join(";\n") };
}

/** Renders every frame of the shot with the canvas engine and streams them into FFmpeg (raw RGBA over stdin). */
export async function renderAnimShot(engine: AnimEngine, outPath: string, o: AnimVideoOptions): Promise<{ frames: number; renderMs: number }> {
  const { W, H } = engine, spec = engine.spec;
  const fps = spec.fps, total = Math.round(spec.duration * fps);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const post = animPostGraph(W, H, spec.duration, fps, o);
  await fs.writeFile(`${outPath}.filtergraph.txt`, `${post.filter}\n`);
  const venc = o.encoder === "h264_videotoolbox"
    ? ["-c:v", "h264_videotoolbox", "-b:v", `${o.bitrateKbps}k`, "-maxrate", `${Math.round(o.bitrateKbps * 1.25)}k`, "-profile:v", "high", "-allow_sw", "0"]
    : ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-profile:v", "high"];
  const args = [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(fps), "-i", "-", ...post.inputs,
    "-filter_complex", post.filter, "-map", "[vout]", ...venc, "-pix_fmt", "yuv420p", "-r", String(fps), "-an", "-movflags", "+faststart", outPath,
  ];
  const t0 = Date.now();
  const child = spawn(o.ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => { err += String(d); });
  const done = new Promise<void>((res, rej) => { child.on("error", rej); child.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}: ${err.slice(-600)}`)))); });
  child.stdin.on("error", () => {});
  const canvas = createCanvas(W, H), g = canvas.getContext("2d");
  for (let i = 0; i < total; i++) {
    engine.renderFrame(g, i / fps);
    const buf = Buffer.from(canvas.data());
    if (!child.stdin.write(buf)) await new Promise<void>((r) => child.stdin.once("drain", () => r()));
    o.onProgress?.(i + 1, total);
  }
  child.stdin.end();
  await done;
  return { frames: total, renderMs: Date.now() - t0 };
}
