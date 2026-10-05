import type { Canvas, SKRSContext2D } from "@napi-rs/canvas";
import { envelope } from "./ease";
import type { Pose } from "./character";
import type { Rig } from "./rig";

export interface FigureLight {
  tint?: string;
  tintAmount?: number;
  rim?: { color: string; side: 1 | -1; amount?: number };
  /** Colour washes on the upper body (a phone lighting the face, a door spilling light). */
  glows: { color: string; alpha: number }[];
}

const RAD = Math.PI / 180;

/**
 * Poses one rig (one camera view of a character) on two scratch canvases and returns the composite: legs (thigh + shin joined at
 * the knee) behind, then torso, arms and head. Offsets are in rig pixels; `sg` is the sign of the horizontal flip (angles measured
 * on screen change sign when the figure is mirrored).
 */
export function composeFigure(getCanvas: (key: string, w: number, h: number) => Canvas, key: string, rig: Rig, pose: Pose, sg: number, light: FigureLight): { canvas: Canvas; margin: number } {
  const H = rig.h, m = Math.round(H * 0.3);
  const cw = rig.w + 2 * m, ch = rig.h + rig.pad + 2 * m;
  const lc = getCanvas(`legs-${key}`, cw, ch), lf: SKRSContext2D = lc.getContext("2d");
  const uc = getCanvas(`upper-${key}`, cw, ch), f: SKRSContext2D = uc.getContext("2d");
  const a = rig.analysis;
  const hipY = a.hipY + pose.bob * H;

  // legs: thigh about the hip, shin about the knee (carried by the thigh)
  const legs: [Pose["legL"], Canvas, Canvas, number, number][] = [[pose.legR, rig.thighR, rig.shinR, a.hipRx, a.kneeRx], [pose.legL, rig.thighL, rig.shinL, a.hipLx, a.kneeLx]];
  for (const [i, [leg, thigh, shin, hx, kx]] of legs.entries()) {
    lf.save();
    lf.translate(m + hx, m + hipY - leg.lift * H);
    lf.rotate(-leg.rot * sg * RAD);
    lf.translate(-hx, -a.hipY);
    lf.drawImage(thigh, 0, 0);
    lf.translate(kx, a.kneeY);
    lf.rotate(leg.knee * sg * RAD);
    lf.translate(-kx, -a.kneeY);
    lf.drawImage(shin, 0, 0);
    lf.restore();
    // in profile the far leg is in shade, so the two overlapping legs read as two legs
    if (i === 0 && rig.view === "side") { lf.save(); lf.globalCompositeOperation = "source-atop"; lf.fillStyle = "rgba(0,0,0,0.38)"; lf.fillRect(0, 0, cw, ch); lf.restore(); }
  }

  // upper body about the hips
  const hipCx = (a.hipLx + a.hipRx) / 2;
  f.save();
  f.translate(m + hipCx, m + hipY);
  f.rotate(pose.lean * (rig.nativeFacing === -1 ? -1 : 1) * RAD);
  f.translate(-hipCx, -a.hipY);
  f.drawImage(rig.torso, 0, 0);
  if (rig.arms && rig.armL && rig.armR) {
    for (const [arm, canvas, pv] of [[pose.armL, rig.armL, rig.arms.pivotL], [pose.armR, rig.armR, rig.arms.pivotR]] as const) {
      f.save();
      f.translate(pv.x, pv.y);
      f.rotate(-arm.rot * sg * RAD);
      f.translate(-pv.x, -pv.y);
      f.drawImage(canvas, 0, 0);
      f.restore();
    }
  }
  // head about the neck
  f.save();
  f.translate(a.neckCx + pose.headDx * H * sg, a.neckY + pose.headDy * H);
  f.rotate(pose.headRot * sg * RAD);
  f.scale(pose.headSquashX, pose.headSquashY);
  f.translate(-a.neckCx, -a.neckY);
  // cross-fade the head: the neutral head fades OUT as variants fade in, so two hairlines never show at once
  const entries = Object.entries(pose.head).filter(([n, w]) => rig.variants[n] && w > 0.002);
  const total = Math.min(1, entries.reduce((s, [, w]) => s + w, 0));
  f.globalAlpha = 1 - total;
  if (total < 0.999) f.drawImage(rig.head, 0, 0);
  let cum = 1 - total;
  for (const [name, w] of entries) {
    cum += w;
    f.globalAlpha = Math.min(1, w / cum);
    f.drawImage(rig.variants[name]!, 0, 0);
  }
  f.globalAlpha = 1;
  f.restore();
  f.restore();

  // lighting match: scene tint on both parts; glows and the rim light on the upper body only
  for (const part of [lf, f]) {
    part.globalCompositeOperation = "source-atop";
    if (light.tint && (light.tintAmount ?? 0) > 0) { part.globalAlpha = light.tintAmount!; part.fillStyle = light.tint; part.fillRect(0, 0, cw, ch); part.globalAlpha = 1; }
    part.globalCompositeOperation = "source-over";
  }
  for (const gl of light.glows) {
    f.globalCompositeOperation = "source-atop";
    f.globalAlpha = gl.alpha;
    f.fillStyle = gl.color;
    f.fillRect(0, 0, cw, ch);
    f.globalAlpha = 1;
    f.globalCompositeOperation = "source-over";
  }
  if (light.rim) {
    const rc = getCanvas(`rim-${key}`, cw, ch), rg: SKRSContext2D = rc.getContext("2d");
    rg.drawImage(uc, 0, 0);
    rg.globalCompositeOperation = "source-in";
    rg.fillStyle = light.rim.color;
    rg.fillRect(0, 0, cw, ch);
    rg.globalCompositeOperation = "destination-out";
    rg.drawImage(uc, -light.rim.side * sg * 3, 0);
    f.globalCompositeOperation = "source-atop";
    f.globalAlpha = light.rim.amount ?? 0.5;
    f.drawImage(rc, 0, 0);
    f.globalAlpha = 1;
    f.globalCompositeOperation = "source-over";
  }
  lf.drawImage(uc, 0, 0); // upper body over the legs
  return { canvas: lc, margin: m };
}

/** Light washes active at time t for the glow events aimed at a character. */
export function glowsAt(events: { start: number; duration: number; params?: Record<string, number | string | boolean> }[], t: number): { color: string; alpha: number }[] {
  const out: { color: string; alpha: number }[] = [];
  for (const e of events) {
    const local = t - e.start;
    if (local < 0 || local > e.duration) continue;
    const amt = (typeof e.params?.amount === "number" ? e.params.amount : 0.5) * envelope(local, e.duration, typeof e.params?.in === "number" ? e.params.in : 0.15, typeof e.params?.out === "number" ? e.params.out : 0.3);
    out.push({ color: typeof e.params?.color === "string" ? e.params.color : "#8fc4ff", alpha: Math.min(0.12, amt * 0.14) });
  }
  return out;
}
