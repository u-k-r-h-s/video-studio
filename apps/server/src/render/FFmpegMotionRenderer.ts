import fs from "node:fs/promises";
import path from "node:path";
import type { FormatProfile, ServiceDetail } from "@studio/shared";
import { EncoderUnavailableError, RenderError } from "../errors";
import type { CommandRunner } from "../lib/command";
import { createLogger } from "../lib/logger";
import { buildSceneGraph } from "./filterGraph";
import type { RenderOutput, SceneRenderer, ScenePlan } from "./SceneRenderer";

const log = createLogger("ffmpeg");

export interface FFmpegOptions {
  ffmpeg: string;
  ffprobe: string;
  timeoutMs: number;
  /** Overrides the profile's encoder preference (env FFMPEG_ENCODER). "auto" defers to the profile. */
  encoderOverride?: "auto" | "h264_videotoolbox" | "libx264";
}

interface ProbeResult {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  hasAudio: boolean;
  videoCodec: string;
}

/** Concrete encoder choice for one run. */
type Encoder = "h264_videotoolbox" | "libx264";

/**
 * SceneRenderer implemented with FFmpeg only (no Blender): one filter graph per scene compiled from motion
 * primitives, h264_videotoolbox preferred (validated on the M1) with a libx264 software fallback.
 */
export class FFmpegMotionRenderer implements SceneRenderer {
  readonly name = "ffmpeg-motion";
  private encoders?: Promise<Set<string>>;

  constructor(
    private readonly runner: CommandRunner,
    private readonly opts: FFmpegOptions,
  ) {}

  private availableEncoders(): Promise<Set<string>> {
    this.encoders ??= this.runner
      .run(this.opts.ffmpeg, ["-hide_banner", "-encoders"], { timeoutMs: 15_000 })
      .then((r) => new Set(["h264_videotoolbox", "libx264"].filter((e) => new RegExp(`\\s${e}\\s`).test(r.stdout))));
    return this.encoders;
  }

  /** Decide which encoder to try first, honouring the profile preference and the env override. */
  async resolveEncoders(video: FormatProfile["video"]): Promise<Encoder[]> {
    const have = await this.availableEncoders();
    const pref = this.opts.encoderOverride && this.opts.encoderOverride !== "auto" ? this.opts.encoderOverride : video.videoEncoder;
    if (pref === "auto") {
      const order = (["h264_videotoolbox", "libx264"] as const).filter((e) => have.has(e));
      if (order.length === 0) throw new EncoderUnavailableError("libx264");
      if (!have.has("h264_videotoolbox")) log.warn("VideoToolbox encoder unavailable; using the libx264 software fallback");
      return order;
    }
    if (!have.has(pref)) throw new EncoderUnavailableError(pref);
    return [pref];
  }

  private videoArgs(encoder: Encoder, v: FormatProfile["video"]): string[] {
    return encoder === "h264_videotoolbox"
      ? ["-c:v", "h264_videotoolbox", "-b:v", `${v.videoBitrateKbps}k`, "-maxrate", `${Math.round(v.videoBitrateKbps * 1.2)}k`, "-profile:v", "high", "-allow_sw", "0"]
      : ["-c:v", "libx264", "-preset", "medium", "-crf", String(v.crf), "-profile:v", "high"];
  }

  async renderScene(plan: ScenePlan, outPath: string, hooks: { signal?: AbortSignal } = {}): Promise<RenderOutput> {
    const { width, height, fps } = plan.video;
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const graph = buildSceneGraph(plan);
    await fs.writeFile(`${outPath}.filtergraph.txt`, `${graph.filterGraph}\n`); // kept for debugging
    const encoders = await this.resolveEncoders(plan.video);

    let lastError: unknown;
    for (const [i, encoder] of encoders.entries()) {
      const args = [
        "-hide_banner", "-loglevel", "error", "-y", ...graph.inputArgs, "-filter_complex", graph.filterGraph,
        "-map", "[vout]", "-map", `${graph.audioInputIndex}:a`, ...this.videoArgs(encoder, plan.video),
        "-pix_fmt", "yuv420p", "-r", String(fps), "-c:a", "aac", "-b:a", `${plan.video.audioBitrateKbps}k`, "-ar", String(plan.video.audioSampleRate),
        "-t", String(plan.duration), "-movflags", "+faststart", outPath,
      ];
      const t0 = Date.now();
      try {
        const r = await this.runner.run(this.opts.ffmpeg, args, { timeoutMs: this.opts.timeoutMs, signal: hooks.signal });
        if (r.code !== 0) throw new RenderError(`ffmpeg (${encoder}) exited with code ${r.code}: ${r.stderr.slice(-600)}`);
        const probe = await this.probe(outPath);
        this.validate(probe, { width, height, fps, durationSec: plan.duration }, 0.2);
        const renderMs = Date.now() - t0;
        log.info("scene rendered", { scene: plan.sceneId, encoder, renderMs, durationSec: plan.duration });
        return { path: outPath, durationSec: probe.durationSec, width, height, fps, encoder, renderMs };
      } catch (err) {
        lastError = err;
        if (hooks.signal?.aborted) throw err;
        if (i < encoders.length - 1) log.warn(`${encoder} failed; retrying with the software encoder`, { scene: plan.sceneId, error: (err as Error).message.slice(0, 200) });
      }
    }
    throw lastError instanceof RenderError ? lastError : new RenderError(`render of ${plan.sceneId} failed`, lastError);
  }

  async assemble(clipPaths: string[], outPath: string, video: FormatProfile["video"]): Promise<RenderOutput> {
    if (clipPaths.length === 0) throw new RenderError("there are no scene clips to assemble");
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const listFile = `${outPath}.concat.txt`;
    // concat demuxer list: single quotes escaped as '\''
    await fs.writeFile(listFile, clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    const t0 = Date.now();
    // Scene clips share encoder settings, so video is stream-copied; audio is re-encoded once for continuity.
    const args = [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:v", "copy", "-c:a", "aac", "-b:a", `${video.audioBitrateKbps}k`, "-ar", String(video.audioSampleRate), "-movflags", "+faststart", outPath,
    ];
    const r = await this.runner.run(this.opts.ffmpeg, args, { timeoutMs: this.opts.timeoutMs });
    if (r.code !== 0) throw new RenderError(`ffmpeg concat exited with code ${r.code}: ${r.stderr.slice(-600)}`);
    const clipDurations = await Promise.all(clipPaths.map(async (p) => (await this.probe(p)).durationSec));
    const expected = clipDurations.reduce((a, b) => a + b, 0);
    const probe = await this.probe(outPath);
    this.validate(probe, { width: video.width, height: video.height, fps: video.fps, durationSec: expected }, 0.15 * clipPaths.length + 0.2);
    return { path: outPath, durationSec: probe.durationSec, width: video.width, height: video.height, fps: video.fps, encoder: probe.videoCodec, renderMs: Date.now() - t0 };
  }

  async probe(file: string): Promise<ProbeResult> {
    const r = await this.runner.run(
      this.opts.ffprobe,
      ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate", "-show_entries", "format=duration", "-of", "json", file],
      { timeoutMs: 30_000 },
    );
    if (r.code !== 0) throw new RenderError(`ffprobe failed for ${path.basename(file)}: ${r.stderr.slice(-300)}`);
    const j = JSON.parse(r.stdout) as { streams?: { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string }[]; format?: { duration?: string } };
    const v = j.streams?.find((s) => s.codec_type === "video");
    if (!v) throw new RenderError(`${path.basename(file)} has no video stream`);
    const [n, d] = (v.r_frame_rate ?? "0/1").split("/").map(Number);
    return {
      width: v.width ?? 0, height: v.height ?? 0, fps: d ? n! / d : 0, durationSec: Number(j.format?.duration ?? 0),
      hasAudio: !!j.streams?.some((s) => s.codec_type === "audio"), videoCodec: v.codec_name,
    };
  }

  /** Final-output validation: right size, frame rate, audio present, duration within tolerance. */
  private validate(p: ProbeResult, want: { width: number; height: number; fps: number; durationSec: number }, tolSec: number): void {
    const problems: string[] = [];
    if (p.width !== want.width || p.height !== want.height) problems.push(`size ${p.width}x${p.height} (wanted ${want.width}x${want.height})`);
    if (Math.abs(p.fps - want.fps) > 0.01) problems.push(`fps ${p.fps} (wanted ${want.fps})`);
    if (!p.hasAudio) problems.push("no audio stream");
    if (Math.abs(p.durationSec - want.durationSec) > tolSec) problems.push(`duration ${p.durationSec.toFixed(2)}s (wanted ${want.durationSec.toFixed(2)}s)`);
    if (p.videoCodec !== "h264") problems.push(`codec ${p.videoCodec} (wanted h264)`);
    if (problems.length) throw new RenderError(`rendered output is invalid: ${problems.join("; ")}`);
  }

  async health(): Promise<ServiceDetail> {
    try {
      const have = await this.availableEncoders();
      if (!have.has("libx264") && !have.has("h264_videotoolbox")) return { status: "unavailable", message: "FFmpeg has no H.264 encoder", hint: "Install FFmpeg with libx264 (brew install ffmpeg)." };
      return { status: "ready", message: `FFmpeg ready (${[...have].join(", ")})` };
    } catch {
      return { status: "unavailable", message: `FFmpeg not found at ${this.opts.ffmpeg}`, hint: "Install with `brew install ffmpeg` or set FFMPEG_PATH." };
    }
  }
}
