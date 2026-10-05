import { createCanvas } from "@napi-rs/canvas";

/**
 * A plain grey mannequin in a relaxed A-pose, drawn procedurally and given to the image model as the img2img start picture.
 * The model keeps the composition of the start picture (measured: even at denoise 0.85), so every generated character comes out
 * in the SAME pose: arms held clear of the body, legs apart, feet on the same line. That makes the cut-out separable into
 * puppet parts without any extra model, and the joint positions below are known in advance (the segmentation uses them as a prior).
 *
 * Coordinates are fractions of the template (w, h). The figure faces three-quarters to the screen LEFT (native facing -1).
 */
export interface Joint { x: number; y: number }
export interface MannequinJoints {
  headTop: Joint; head: Joint; neck: Joint;
  shoulderL: Joint; elbowL: Joint; wristL: Joint; handL: Joint;
  shoulderR: Joint; elbowR: Joint; wristR: Joint; handR: Joint;
  waist: Joint; hipL: Joint; kneeL: Joint; ankleL: Joint; toeL: Joint;
  hipR: Joint; kneeR: Joint; ankleR: Joint; toeR: Joint;
}
/** "L" / "R" are SCREEN left / right of the template. */
export const MANNEQUIN: { w: number; h: number; joints: MannequinJoints } = {
  w: 512, h: 896,
  joints: {
    headTop: { x: 0.49, y: 0.055 }, head: { x: 0.49, y: 0.115 }, neck: { x: 0.5, y: 0.18 },
    shoulderL: { x: 0.39, y: 0.215 }, elbowL: { x: 0.315, y: 0.355 }, wristL: { x: 0.275, y: 0.49 }, handL: { x: 0.262, y: 0.535 },
    shoulderR: { x: 0.6, y: 0.218 }, elbowR: { x: 0.675, y: 0.355 }, wristR: { x: 0.71, y: 0.485 }, handR: { x: 0.72, y: 0.528 },
    waist: { x: 0.5, y: 0.445 }, hipL: { x: 0.45, y: 0.53 }, kneeL: { x: 0.42, y: 0.72 }, ankleL: { x: 0.405, y: 0.915 }, toeL: { x: 0.35, y: 0.94 },
    hipR: { x: 0.555, y: 0.53 }, kneeR: { x: 0.575, y: 0.72 }, ankleR: { x: 0.59, y: 0.915 }, toeR: { x: 0.54, y: 0.94 },
  },
};

/** The start picture: light grey studio backdrop, mid-grey mannequin with soft shading. PNG bytes. */
export function mannequinPng(w = MANNEQUIN.w, h = MANNEQUIN.h): Buffer {
  const c = createCanvas(w, h), g = c.getContext("2d");
  const J = MANNEQUIN.joints, P = (j: Joint): [number, number] => [j.x * w, j.y * h];
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "#d6d6d6"); bg.addColorStop(1, "#c4c4c4");
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.fillStyle = "rgba(0,0,0,0.12)"; g.beginPath(); g.ellipse(0.5 * w, 0.945 * h, 0.17 * w, 0.012 * h, 0, 0, Math.PI * 2); g.fill();
  const body = "#7d7a78", shade = "#6a6764";
  g.lineCap = "round"; g.lineJoin = "round";
  const limb = (a: Joint, b: Joint, width: number, col = body): void => { g.strokeStyle = col; g.lineWidth = width * w; g.beginPath(); g.moveTo(...P(a)); g.lineTo(...P(b)); g.stroke(); };
  // far (screen right) limbs a little darker: they are turned away from the light
  limb(J.hipR, J.kneeR, 0.095, shade); limb(J.kneeR, J.ankleR, 0.078, shade); limb(J.ankleR, J.toeR, 0.06, shade);
  limb(J.shoulderR, J.elbowR, 0.07, shade); limb(J.elbowR, J.wristR, 0.058, shade);
  g.fillStyle = shade; g.beginPath(); g.ellipse(...P(J.handR), 0.03 * w, 0.03 * h, 0, 0, Math.PI * 2); g.fill();
  // torso
  g.fillStyle = body; g.beginPath();
  const pts: Joint[] = [{ x: 0.37, y: 0.205 }, { x: 0.62, y: 0.21 }, { x: 0.6, y: 0.33 }, { x: 0.575, y: 0.445 }, { x: 0.6, y: 0.54 }, { x: 0.41, y: 0.54 }, { x: 0.425, y: 0.445 }, { x: 0.395, y: 0.33 }];
  pts.forEach((p, i) => (i ? g.lineTo(...P(p)) : g.moveTo(...P(p))));
  g.closePath(); g.fill();
  limb(J.neck, { x: J.neck.x, y: J.neck.y + 0.04 }, 0.07);
  // near (screen left) limbs
  limb(J.hipL, J.kneeL, 0.1); limb(J.kneeL, J.ankleL, 0.082); limb(J.ankleL, J.toeL, 0.062);
  limb(J.shoulderL, J.elbowL, 0.074); limb(J.elbowL, J.wristL, 0.06);
  g.fillStyle = body; g.beginPath(); g.ellipse(...P(J.handL), 0.032 * w, 0.032 * h * 0.62, 0, 0, Math.PI * 2); g.fill();
  // head
  const hg = g.createRadialGradient(0.47 * w, 0.1 * h, 4, 0.49 * w, 0.115 * h, 0.09 * w);
  hg.addColorStop(0, "#8e8a87"); hg.addColorStop(1, body);
  g.fillStyle = hg; g.beginPath(); g.ellipse(J.head.x * w, J.head.y * h, 0.082 * w, 0.06 * h, 0, 0, Math.PI * 2); g.fill();
  return c.toBuffer("image/png");
}
