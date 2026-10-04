import fs from "node:fs/promises";
import path from "node:path";
import type { CameraRig, Shot } from "@studio/shared";
import { RenderError } from "../errors";
import type { CommandRunner } from "../lib/command";
import { defaultFocus } from "./cameraLanguage";

/**
 * Renders ONE shot from ONE generated key image into a short video clip, with real 2.5D depth:
 *   far layer = the whole image, defocused (cheap depth-of-field) and moved less;
 *   mid layer = the same image, sharp, cut out by a soft elliptical subject mask and moved more.
 * Because the layers move at different rates the subject separates from the background (parallax). On top: camera rig
 * (zoom/pan/tilt/roll/shake), character motion (breathing, pop, tremble), haze, grade, bloom, vignette, grain,
 * flashes, transitions (baked in), caption and insert overlays. All numbers are compiled from data; nothing from the
 * LLM is interpolated into the graph other than validated numbers.
 */
export interface CaptionOverlay { png: string; start: number; end: number; width: number; height: number }

export interface GradeSpec {
  contrast: number; saturation: number; vignette: number; grain: number; bloom: number; haze: number;
  /** colour balance: shadows toward blue, highlights toward warm (-1..1 small values). */
  shadowTeal: number; highlightWarm: number;
  /** extra sharpening to counter the upscale from 512 px. */
  sharpen: number;
  /** >1 lifts the mid-tones (the base images are dark). */
  gamma: number;
}

export const DEFAULT_GRADE: GradeSpec = { contrast: 1.1, saturation: 1.12, vignette: 1, grain: 9, bloom: 0.38, haze: 0.1, shadowTeal: 0.03, highlightWarm: 0.05, sharpen: 0.7, gamma: 1.18 };

export interface ShotRenderSpec {
  shot: Shot;
  imagePath: string;
  /** Final duration of the clip in seconds (timeline-derived, may exceed shot.duration). */
  duration: number;
  width: number;
  height: number;
  fps: number;
  /** How the previous shot hands over to this one. */
  transitionIn: "cut" | "fade" | "zoom" | "match-cut";
  isFirst: boolean;
  isLast: boolean;
  captions: CaptionOverlay[];
  /** Vertical centre of captions, as a fraction of the height. */
  captionCenterY: number;
  insert?: CaptionOverlay & { centerY: number };
  grade?: Partial<GradeSpec>;
  /** Working resolution multiplier for the layer images (2 = 2160 x 3840). */
  working?: number;
  /** Local timeline (s) of flash/impact frames. */
  flashAt?: number[];
}

export interface ShotGraph { inputArgs: string[]; filter: string; outLabel: string }

const f = (n: number, d = 4): string => Number(n.toFixed(d)).toString();
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Depth-of-field blur sigma (at 540 px width) by framing: tight shots get a shallower plane of focus. */
function blurSigma(t: Shot["shotType"]): number {
  switch (t) {
    case "extreme-close-up": case "close-up": return 5;
    case "medium-close": case "over-shoulder": case "pov": return 4;
    case "wide": case "establishing": return 1.6;
    default: return 3;
  }
}

export function buildShotGraph(spec: ShotRenderSpec): ShotGraph {
  const { shot, width: W, height: H, fps } = spec;
  const D = spec.duration;
  const N = Math.max(2, Math.round(D * fps));
  const work = spec.working ?? 2;
  const WW = Math.round((W * work) / 2) * 2, WH = Math.round((H * work) / 2) * 2;
  const g: GradeSpec = { ...DEFAULT_GRADE, ...spec.grade };
  const cam: CameraRig = shot.camera;
  const focus = shot.focus ?? defaultFocus(shot.shotType);

  const P = `(on/${N})`;
  const E = `(${P}*${P}*(3-2*${P}))`;
  const PR = `(0.35*${P}+0.65*${E})`; // gentle ease-in-out
  const lerp = (a: number, b: number): string => `(${f(a)}+(${f(b)}-${f(a)})*${PR})`;

  // transition punches (baked into the camera zoom)
  const tInSec = 0.3;
  const zin = spec.transitionIn === "zoom" ? `(1+0.16*pow(max(0,1-on/${f(fps * tInSec, 1)}),2))` : "1";
  const zout = shot.transition.type === "zoom" && !spec.isLast ? `(1+0.2*pow(max(0,(on-${f(N - fps * 0.3, 1)})/${f(fps * 0.3, 1)}),2))` : "1";

  // character motion primitives, applied to the MID layer only (the subject moves against the background)
  const cm = shot.characterMotion;
  const t = `(on/${fps})`;
  const midZ: string[] = [];
  const midX: string[] = [];
  const midY: string[] = [];
  const hasBreathing = cm.some((m) => m.action === "breathing" || m.action === "idle") || (cm.length === 0 && shot.subjectIds.length > 0);
  if (hasBreathing) midZ.push(`(1+0.006*sin(6.28*${t}/3.4))`);
  for (const m of cm) {
    const at = m.at ?? 0, s = m.strength ?? 0.6, d = `(${t}-${f(at)})`;
    switch (m.action) {
      case "surprise": case "impact": midZ.push(`(1+${f(0.05 * s)}*exp(-12*max(0,${d}))*gte(${d},0))`); break;
      case "fear": midX.push(`${f(0.0012 * s * 1.5, 5)}*sin(61*${t})`); midY.push(`${f(0.001 * s * 1.5, 5)}*sin(73*${t}+1)`); break;
      case "nod": midY.push(`${f(0.004 * s)}*sin(5*${t})*exp(-2*max(0,${d}))*gte(${d},0)`); break;
      case "lean": midX.push(`${f(0.01 * s)}*${E}`); break;
      case "step-forward": midZ.push(`(1+${f(0.05 * s)}*${PR})`); break;
      case "step-back": midZ.push(`(1-${f(0.03 * s)}*${PR})`); break;
      case "head-turn": case "look-left": midX.push(`-${f(0.012 * s)}*${E}`); break;
      case "look-right": midX.push(`${f(0.012 * s)}*${E}`); break;
      case "smile": midZ.push(`(1+${f(0.012 * s)}*${PR})`); break;
      default: break;
    }
  }
  const midZExpr = midZ.length ? midZ.join("*") : "1";
  const camZ = lerp(cam.startScale, cam.endScale);
  const zFar = `(1+(${camZ}*${zin}*${zout}-1)*0.55)`;
  const zMid = `(${camZ}*${zin}*${zout}*${midZExpr})`;
  const xN = lerp(cam.startX, cam.endX), yN = lerp(cam.startY, cam.endY);
  const xFar = `(iw-iw/zoom)*${xN}`, yFar = `(ih-ih/zoom)*${yN}`;
  const xMid = `(iw-iw/zoom)*clip(${xN}${midX.length ? "+" + midX.join("+") : ""},0,1)`;
  const yMid = `(ih-ih/zoom)*clip(${yN}${midY.length ? "+" + midY.join("+") : ""},0,1)`;
  const zp = (z: string, x: string, y: string): string => `zoompan=z='${z}':x='${x}':y='${y}':d=${N}:s=${W}x${H}:fps=${fps}`;

  const inputs: string[] = ["-i", spec.imagePath];
  const lines: string[] = [];
  // --- layers
  lines.push(`[0:v]scale=${WW}:${WH}:flags=lanczos,format=yuv420p,split=2[imgA][imgB]`);
  // far: blur at low resolution, then scale back up (cheap), darkened slightly for depth
  lines.push(`[imgA]scale=${Math.round(WW / 4)}:${Math.round(WH / 4)}:flags=area,gblur=sigma=${blurSigma(shot.shotType)},scale=${WW}:${WH}:flags=bicubic,eq=brightness=-0.015,${zp(zFar, xFar, yFar)}[far]`);
  // subject mask (soft ellipse), same camera as the mid layer so it stays registered
  const mx = f(focus.x), my = f(focus.y), rx = f(focus.rx), ry = f(focus.ry);
  lines.push(
    `nullsrc=s=135x240:r=25,format=gray,geq=lum='255*clip((1.3-hypot((X/W-${mx})/${rx},(Y/H-${my})/${ry}))/0.6,0,1)',trim=end_frame=1,scale=${WW}:${WH}:flags=bicubic,${zp(zMid, xMid, yMid)},format=gray[mask]`,
  );
  lines.push(`[imgB]${zp(zMid, xMid, yMid)},format=yuv420p[midc]`);
  lines.push(`[midc][mask]alphamerge[mid]`);
  lines.push(`[far][mid]overlay=format=auto,format=yuv420p[comp0]`);

  // --- roll + shake (needs an overscanned frame so the rotated edges never show)
  const rotStart = cam.rotation ?? 0, rotEnd = cam.endRotation ?? cam.rotation ?? 0;
  const shake = shot.motion.shake ?? 0;
  const impacts = (spec.flashAt ?? []).concat(shot.effects?.impact ? [0.0] : []);
  const needsRoll = Math.abs(rotStart) > 0.01 || Math.abs(rotEnd) > 0.01 || shake > 0 || impacts.length > 0;
  let cur = "comp0";
  if (needsRoll) {
    const maxRot = Math.max(Math.abs(rotStart), Math.abs(rotEnd)) + (impacts.length ? 1.5 : 0);
    const over = clamp(1.04 + (H / W) * Math.sin((maxRot * Math.PI) / 180) + (shake + (impacts.length ? 0.012 : 0)) * 2, 1.04, 1.3);
    const OW = Math.round((W * over) / 2) * 2, OH = Math.round((H * over) / 2) * 2;
    const pt = `(t/${f(D)})`;
    const rot = `(${f(rotStart)}+(${f(rotEnd)}-${f(rotStart)})*${pt})`;
    const imp = impacts.map((a) => `(${f(1.4)}*exp(-9*(t-${f(a)}))*sin(70*(t-${f(a)}))*gte(t,${f(a)}))`).join("+") || "0";
    lines.push(`[${cur}]scale=${OW}:${OH}:flags=bicubic,rotate=a='(${rot}+${imp})*PI/180':ow=iw:oh=ih:c=black,crop=${W}:${H}:x='(iw-${W})/2+${f(W * 1.0)}*${f(shake, 5)}*(0.6*sin(53*t)+0.4*sin(97*t+0.7))':y='(ih-${H})/2+${f(H * 0.6)}*${f(shake, 5)}*(0.5*sin(61*t+2)+0.5*sin(113*t))'[roll]`);
    cur = "roll";
  }

  // --- flashes / impact brightness
  const flashes = (spec.flashAt ?? []).concat(shot.effects?.flash ? [0.0] : []);
  if (flashes.length) {
    const expr = flashes.map((a) => `(0.55*max(0,1-(t-${f(a)})/0.16)*gte(t,${f(a)}))`).join("+");
    lines.push(`[${cur}]eq=brightness='${expr}':eval=frame[fl]`);
    cur = "fl";
  }

  // --- haze (a slowly drifting gradient screened over the image), grade, bloom
  const hazeIn = `gradients=s=270x480:r=${fps}:speed=0.012:nb_colors=2:c0=0x0b1620:c1=0x6a8fb0:seed=${(shot.order * 7919) % 9973}:d=${f(D + 0.2)}`;
  lines.push(`${hazeIn},scale=${W}:${H}:flags=bicubic,format=yuv420p[haze]`);
  lines.push(`[${cur}][haze]blend=all_mode=screen:all_opacity=${f(g.haze)}[hz]`);
  lines.push(
    `[hz]eq=contrast=${f(g.contrast)}:saturation=${f(g.saturation)}:gamma=${f(g.gamma)},colorbalance=rs=${f(-g.shadowTeal)}:bs=${f(g.shadowTeal * 1.4)}:rh=${f(g.highlightWarm)}:bh=${f(-g.highlightWarm)},split=2[g1][g2]`,
  );
  lines.push(`[g2]curves=all='0/0 0.62/0 0.82/0.55 1/1',scale=${Math.round(W / 4)}:${Math.round(H / 4)}:flags=area,gblur=sigma=14,scale=${W}:${H}:flags=bicubic[bl]`);
  lines.push(`[g1][bl]blend=all_mode=screen:all_opacity=${f(g.bloom)},vignette=angle=PI/${f(6 / Math.max(0.2, g.vignette), 2)}:mode=forward,unsharp=5:5:${f(g.sharpen)}:5:5:0,noise=alls=${Math.round(g.grain)}:allf=t,format=yuv420p[graded]`);
  cur = "graded";

  // --- transitions baked into the clip (fade = dip to black)
  const fades: string[] = [];
  if (spec.transitionIn === "fade" && !spec.isFirst) fades.push(`fade=t=in:st=0:d=0.35`);
  if (shot.transition.type === "fade" || spec.isLast) fades.push(`fade=t=out:st=${f(Math.max(0, D - (spec.isLast ? 0.7 : 0.35)))}:d=${spec.isLast ? 0.7 : 0.35}`);
  if (fades.length) {
    lines.push(`[${cur}]${fades.join(",")}[fd]`);
    cur = "fd";
  }

  // --- overlays: insert card, then captions (still PNGs gated by time, with a quick pop-in)
  let idx = 1;
  const ov = (o: CaptionOverlay, cy: number, label: string): void => {
    inputs.push("-loop", "1", "-framerate", String(fps), "-t", f(D + 0.1), "-i", o.png);
    const a = f(o.start), b = f(o.end);
    const y = `${f(cy * H)}-h/2+16*max(0,1-(t-${a})/0.12)`;
    lines.push(`[${cur}][${idx}:v]overlay=x='(W-w)/2':y='${y}':enable='between(t,${a},${b})':format=auto[${label}]`);
    cur = label;
    idx += 1;
  };
  if (spec.insert) ov(spec.insert, spec.insert.centerY, "ins");
  spec.captions.forEach((c, i) => ov(c, spec.captionCenterY, `cp${i}`));
  lines.push(`[${cur}]format=yuv420p,setsar=1[vout]`);
  return { inputArgs: inputs, filter: lines.join(";\n"), outLabel: "vout" };
}

export interface ShotRenderOptions { ffmpeg: string; ffprobe: string; encoder: "h264_videotoolbox" | "libx264"; bitrateKbps: number; timeoutMs: number }

export async function renderShot(runner: CommandRunner, spec: ShotRenderSpec, outPath: string, o: ShotRenderOptions, signal?: AbortSignal): Promise<{ path: string; renderMs: number }> {
  const g = buildShotGraph(spec);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(`${outPath}.filtergraph.txt`, `${g.filter}\n`);
  const venc = o.encoder === "h264_videotoolbox"
    ? ["-c:v", "h264_videotoolbox", "-b:v", `${o.bitrateKbps}k`, "-maxrate", `${Math.round(o.bitrateKbps * 1.25)}k`, "-profile:v", "high", "-allow_sw", "0"]
    : ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-profile:v", "high"];
  const args = [
    "-hide_banner", "-loglevel", "error", "-y", ...g.inputArgs, "-filter_complex", g.filter, "-map", `[${g.outLabel}]`,
    ...venc, "-pix_fmt", "yuv420p", "-r", String(spec.fps), "-t", String(spec.duration), "-an", "-movflags", "+faststart", outPath,
  ];
  const t0 = Date.now();
  const r = await runner.run(o.ffmpeg, args, { timeoutMs: o.timeoutMs, signal });
  if (r.code !== 0) throw new RenderError(`shot ${spec.shot.id} render failed (${o.encoder}): ${r.stderr.slice(-700)}`);
  return { path: outPath, renderMs: Date.now() - t0 };
}
