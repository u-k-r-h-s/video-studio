import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { encodePng, type Rgba } from "../lib/png";
import { MANNEQUIN, type Joint as TJoint } from "./mannequin";

/**
 * A 2D cut-out puppet built from ONE generated character picture in the mannequin pose (see mannequin.ts): arms held clear of the
 * body and legs apart, so every body part can be separated by plain geometry. Parts and pivots:
 *
 *   coat (hips / coat tails, lags behind the body) -> torso (pivot: hips) -> head (pivot: neck), hair (head, lagging)
 *   torso -> upper arm (pivot: shoulder) -> lower arm + hand (pivot: elbow) -> hand grip (held props attach here)
 *   hips  -> thigh (pivot: hip) -> shin + foot (pivot: knee)
 *
 * "Near" limbs are the ones on the screen-left of the source picture (in front of the body for a figure turned three-quarters to
 * the left); "far" limbs are behind the body. Every part is a full-size canvas in the same coordinates as the source, so a pivot is
 * just a point in that space and a pose is a chain of rotations about those points.
 */
export type Limb = "N" | "F";
export interface Pt { x: number; y: number }
export interface PuppetJoints {
  headTop: Pt; neck: Pt; waist: Pt; hips: Pt;
  shoulderN: Pt; elbowN: Pt; handN: Pt; shoulderF: Pt; elbowF: Pt; handF: Pt;
  hipN: Pt; kneeN: Pt; ankleN: Pt; hipF: Pt; kneeF: Pt; ankleF: Pt;
}
export interface Puppet {
  id: string;
  /** Canvas size (source cut-out plus transparent padding above the head). */
  w: number;
  h: number;
  /** Figure height in px (head top to feet), used to scale to the stage. */
  figH: number;
  /** Feet line (y) in canvas px. */
  groundY: number;
  nativeFacing: -1 | 1;
  /** Transparent rows added above the source picture (room for hair lag / raised arms). */
  pad: number;
  joints: PuppetJoints;
  /** Rest angle of each arm from straight down (deg, + = forward = toward the native facing direction). */
  armRest: { N: number; F: number };
  parts: {
    head: Canvas; face: Canvas; torso: Canvas; coat: Canvas;
    upperArmN: Canvas; lowerArmN: Canvas; upperArmF: Canvas; lowerArmF: Canvas;
    thighN: Canvas; shinN: Canvas; thighF: Canvas; shinF: Canvas;
  };
  /** Face-only expression variants (same canvas size; only the face ellipse, so hair and cap never pop). */
  faces: Record<string, Canvas>;
  faceEllipse: { cx: number; cy: number; rx: number; ry: number };
  headRect: { x: number; y: number; w: number; h: number };
  whole: Canvas;
  /** How the source was segmented (for logs/tests). */
  report: { armsSeparated: boolean; legsSeparated: boolean; partPixels: Record<string, number> };
}

const alphaAt = (img: Rgba, x: number, y: number): number => img.data[(y * img.width + x) * 4 + 3]!;
const ramp = (v: number, a: number, b: number): number => Math.min(1, Math.max(0, (v - a) / (b - a)));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** x of a polyline (monotonic in y) at row y; null outside its y range (with a margin). */
function polyX(pts: Pt[], y: number, margin = 0): number | null {
  if (y < pts[0]!.y - margin || y > pts[pts.length - 1]!.y + margin) return null;
  if (y <= pts[0]!.y) return pts[0]!.x;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    if (y <= b.y) return lerp(a.x, b.x, (y - a.y) / Math.max(1e-6, b.y - a.y));
  }
  return pts[pts.length - 1]!.x;
}

const LABEL = { none: 0, head: 1, torso: 2, armN: 3, armF: 4, legN: 5, legF: 6 } as const;
type LabelName = Exclude<keyof typeof LABEL, "none">;

/**
 * Segments a cut-out of a character drawn over the mannequin into labelled body parts. `box` is where the cut-out was cropped
 * from the generated picture (so the mannequin's joints can be mapped in as a prior); without it the figure's bounding box is used.
 */
export function segmentFigure(img: Rgba, box?: { x: number; y: number; w: number; h: number }, template = MANNEQUIN): { labels: Uint8Array; joints: PuppetJoints; top: number; bottom: number; armsSeparated: boolean; legsSeparated: boolean } {
  const { width: w, height: h } = img;
  const fg = (x: number, y: number): boolean => alphaAt(img, x, y) > 110;
  let top = 0, bottom = h - 1;
  while (top < h - 1 && !rowHas(img, top)) top++;
  while (bottom > 0 && !rowHas(img, bottom)) bottom--;
  const figH = bottom - top + 1;

  // map the template into this picture: vertically by the figure's extent, horizontally by the head centre
  const T = template.joints, tw = template.w, th = template.h;
  const tTop = T.headTop.y * th, tBottom = Math.max(T.toeL.y, T.toeR.y) * th + 0.012 * th;
  const s = figH / (tBottom - tTop);
  let headCx = 0, nh = 0;
  for (let y = top; y < top + figH * 0.08; y++) for (let x = 0; x < w; x++) if (fg(x, y)) { headCx += x; nh++; }
  headCx = nh ? headCx / nh : w / 2;
  const ox = box ? -box.x : headCx - T.head.x * tw * s;
  const map = (j: TJoint): Pt => (box ? { x: j.x * tw + ox, y: j.y * th - box.y } : { x: (j.x * tw - T.head.x * tw) * s + headCx, y: (j.y * th - tTop) * s + top });

  const J = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, map(v)])) as Record<keyof typeof T, Pt>;
  // neck: narrowest row near the template's neck
  const rowW = (y: number): number => { let lo = -1, hi = -1; for (let x = 0; x < w; x++) if (fg(x, y)) { if (lo < 0) lo = x; hi = x; } return lo < 0 ? 0 : hi - lo + 1; };
  let neckY = Math.round(J.neck.y), best = Infinity;
  for (let y = Math.round(J.neck.y - figH * 0.04); y <= Math.round(J.neck.y + figH * 0.03); y++) {
    if (y <= top || y >= h) continue;
    const v = (rowW(y - 1) + rowW(y) + rowW(y + 1)) / 3;
    if (v < best) { best = v; neckY = y; }
  }

  // crotch: first row below the hips where a gap sits between the two leg priors
  let crotchY = Math.round(Math.max(J.hipL.y, J.hipR.y) + figH * 0.02), legsSeparated = false;
  for (let y = Math.round(J.waist.y); y < Math.round(J.kneeL.y); y++) {
    const xm = Math.round((polyX([J.hipL, J.kneeL], y, 999)! + polyX([J.hipR, J.kneeR], y, 999)!) / 2);
    let gap = true;
    for (let k = 0; k < 8 && gap; k++) if (y + k >= h || fg(xm, y + k) || fg(xm - 1, y + k) || fg(xm + 1, y + k)) gap = false;
    if (gap) { crotchY = y; legsSeparated = true; break; }
  }
  const armHalf = 0.04 * tw * (box ? 1 : s), legHalf = 0.05 * tw * (box ? 1 : s);
  const armN = [J.shoulderL, J.elbowL, J.wristL, J.handL], armF = [J.shoulderR, J.elbowR, J.wristR, J.handR];
  const legN = [{ x: J.hipL.x, y: crotchY }, J.kneeL, J.ankleL, J.toeL], legF = [{ x: J.hipR.x, y: crotchY }, J.kneeR, J.ankleR, J.toeR];
  const torsoPath = [{ x: J.neck.x, y: neckY }, J.waist, { x: (J.hipL.x + J.hipR.x) / 2, y: crotchY }];
  const shoulderHalf = Math.abs(J.shoulderR.x - J.shoulderL.x) / 2;

  const labels = new Uint8Array(w * h);
  let armSepRows = 0, armRows = 0;
  for (let y = top; y <= bottom; y++) {
    if (y < neckY) { for (let x = 0; x < w; x++) if (fg(x, y)) labels[y * w + x] = LABEL.head; continue; }
    // candidate parts at this row: prior x and half-width
    const cands: { name: LabelName; x: number; half: number }[] = [];
    const ty = polyX(torsoPath, y);
    if (ty !== null && y < crotchY) {
      const shoulderRow = Math.min(J.shoulderL.y, J.shoulderR.y);
      const half = y < shoulderRow ? shoulderHalf * ramp(y, neckY, shoulderRow) + armHalf : shoulderHalf * 0.85;
      cands.push({ name: "torso", x: ty, half: Math.max(armHalf, half) });
    }
    const handEnd = (a: Pt[]): number => a[a.length - 1]!.y + figH * 0.035;
    const an = polyX(armN, y), af = polyX(armF, y);
    if (an !== null && y <= handEnd(armN)) cands.push({ name: "armN", x: an, half: armHalf * (y > J.wristL.y ? 1.3 : 1) });
    else if (y > J.wristL.y && y <= handEnd(armN)) cands.push({ name: "armN", x: armN[armN.length - 1]!.x, half: armHalf * 1.3 });
    if (af !== null && y <= handEnd(armF)) cands.push({ name: "armF", x: af, half: armHalf * (y > J.wristR.y ? 1.3 : 1) });
    else if (y > J.wristR.y && y <= handEnd(armF)) cands.push({ name: "armF", x: armF[armF.length - 1]!.x, half: armHalf * 1.3 });
    if (y >= crotchY) {
      cands.push({ name: "legN", x: polyX(legN, y, 9999)!, half: legHalf });
      cands.push({ name: "legF", x: polyX(legF, y, 9999)!, half: legHalf });
    }
    if (!cands.length) continue;
    cands.sort((a, b) => a.x - b.x);
    // runs of foreground pixels
    let x = 0, runs = 0;
    const isArmRow = cands.some((c) => c.name === "armN") && cands.some((c) => c.name === "torso");
    while (x < w) {
      if (!fg(x, y)) { x++; continue; }
      let x2 = x;
      while (x2 < w && fg(x2, y)) x2++;
      runs++;
      // candidates whose prior lies in (or near) this run; else the nearest one
      let inside = cands.filter((c) => c.x >= x - c.half * 0.6 && c.x <= x2 - 1 + c.half * 0.6);
      if (!inside.length) {
        const mid = (x + x2 - 1) / 2;
        inside = [cands.reduce((a, b) => (Math.abs(b.x - mid) / b.half < Math.abs(a.x - mid) / a.half ? b : a))];
      }
      for (let k = x; k < x2; k++) {
        let lab: LabelName = inside[0]!.name;
        // split a run shared by several parts where their normalised distances are equal
        for (let i = 1; i < inside.length; i++) {
          const a = inside[i - 1]!, b = inside[i]!;
          const split = (a.x * b.half + b.x * a.half) / (a.half + b.half);
          if (k >= split) lab = b.name;
        }
        labels[y * w + k] = LABEL[lab];
      }
      x = x2;
    }
    if (isArmRow && y > Math.max(J.shoulderL.y, J.shoulderR.y) + figH * 0.06 && y < Math.min(J.wristL.y, J.wristR.y)) { armRows++; if (runs >= 3) armSepRows++; }
  }

  // arms touching the body: measure the arm's real width where it hangs free, then take that much from the outer edge of the
  // merged rows (the template's prior width is only a guess, and a sleeve left on the torso looks like a third arm)
  {
    const yA = Math.round(Math.min(J.shoulderL.y, J.shoulderR.y) + figH * 0.03), yB = Math.round(Math.max(J.wristL.y, J.wristR.y));
    const runsAt = (y: number): [number, number][] => { const r: [number, number][] = []; let x = 0; while (x < w) { if (!fg(x, y)) { x++; continue; } let x2 = x; while (x2 < w && fg(x2, y)) x2++; r.push([x, x2]); x = x2; } return r; };
    const widths: { N: number[]; F: number[] } = { N: [], F: [] };
    for (let y = yA; y <= yB; y++) {
      const r = runsAt(y);
      if (r.length >= 3) { widths.N.push(r[0]![1] - r[0]![0]); widths.F.push(r[r.length - 1]![1] - r[r.length - 1]![0]); }
    }
    const med = (a: number[]): number => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)]! : 0);
    const wN = Math.max(armHalf * 2, med(widths.N)), wF = Math.max(armHalf * 2, med(widths.F));
    for (let y = yA; y <= yB; y++) {
      const r = runsAt(y);
      if (!r.length) continue;
      const tx = polyX(torsoPath, y);
      if (tx === null) continue;
      const shoulderBoost = 1 + 0.25 * (1 - ramp(y, yA, yA + figH * 0.12));
      const first = r[0]!, last = r[r.length - 1]!;
      if (first[0] <= tx && tx < first[1]) for (let x = first[0]; x < Math.min(first[1], first[0] + wN * shoulderBoost); x++) labels[y * w + x] = LABEL.armN;
      if (last[0] <= tx && tx < last[1]) for (let x = Math.max(last[0], last[1] - wF * shoulderBoost); x < last[1]; x++) labels[y * w + x] = LABEL.armF;
    }
  }

  // joints refined from the labelled pixels
  const centroid = (lab: number, y0: number, y1: number, fallback: Pt): Pt => {
    let sx = 0, sy = 0, n = 0;
    for (let y = Math.max(0, Math.round(y0)); y <= Math.min(h - 1, Math.round(y1)); y++) for (let x = 0; x < w; x++) if (labels[y * w + x] === lab) { sx += x; sy += y; n++; }
    return n > 4 ? { x: sx / n, y: sy / n } : fallback;
  };
  const lowest = (lab: number, fallback: Pt): Pt => {
    for (let y = bottom; y >= top; y--) {
      let sx = 0, n = 0;
      for (let x = 0; x < w; x++) if (labels[y * w + x] === lab) { sx += x; n++; }
      if (n > 2) return { x: sx / n, y };
    }
    return fallback;
  };
  const band = figH * 0.025;
  const handBottomN = lowest(LABEL.armN, J.handL), handBottomF = lowest(LABEL.armF, J.handR);
  const handN = centroid(LABEL.armN, handBottomN.y - figH * 0.05, handBottomN.y, J.handL);
  const handF = centroid(LABEL.armF, handBottomF.y - figH * 0.05, handBottomF.y, J.handR);
  const elbowN = centroid(LABEL.armN, J.elbowL.y - band, J.elbowL.y + band, J.elbowL);
  const elbowF = centroid(LABEL.armF, J.elbowR.y - band, J.elbowR.y + band, J.elbowR);
  const kneeN = centroid(LABEL.legN, J.kneeL.y - band, J.kneeL.y + band, J.kneeL);
  const kneeF = centroid(LABEL.legF, J.kneeR.y - band, J.kneeR.y + band, J.kneeR);
  const hipN = centroid(LABEL.legN, crotchY, crotchY + band * 1.5, { x: J.hipL.x, y: crotchY });
  const hipF = centroid(LABEL.legF, crotchY, crotchY + band * 1.5, { x: J.hipR.x, y: crotchY });
  const ankleN = centroid(LABEL.legN, J.ankleL.y - band, J.ankleL.y + band, J.ankleL);
  const ankleF = centroid(LABEL.legF, J.ankleR.y - band, J.ankleR.y + band, J.ankleR);
  const joints: PuppetJoints = {
    headTop: { x: headCx, y: top }, neck: { x: J.neck.x, y: neckY }, waist: J.waist, hips: { x: (hipN.x + hipF.x) / 2, y: crotchY - figH * 0.03 },
    shoulderN: { x: J.shoulderL.x + armHalf * 0.4, y: J.shoulderL.y + figH * 0.01 }, elbowN, handN,
    shoulderF: { x: J.shoulderR.x - armHalf * 0.4, y: J.shoulderR.y + figH * 0.01 }, elbowF, handF,
    hipN: { x: hipN.x, y: crotchY - figH * 0.01 }, kneeN, ankleN, hipF: { x: hipF.x, y: crotchY - figH * 0.01 }, kneeF, ankleF,
  };
  return { labels, joints, top, bottom, armsSeparated: armRows > 0 && armSepRows / armRows > 0.5, legsSeparated };
}

function rowHas(img: Rgba, y: number): boolean {
  for (let x = 0; x < img.width; x++) if (alphaAt(img, x, y) > 110) return true;
  return false;
}

/** A canvas holding only the pixels for which `keep(x, y)` (0..1) is > 0. */
function partCanvas(src: Rgba, pad: number, keep: (x: number, y: number) => number): { canvas: Canvas; n: number } {
  const W = src.width, H = src.height + pad;
  const c = createCanvas(W, H), g = c.getContext("2d");
  const d = g.createImageData(W, H);
  let n = 0;
  for (let y = 0; y < src.height; y++) for (let x = 0; x < W; x++) {
    const k = keep(x, y);
    if (k <= 0) continue;
    const i = (y * W + x) * 4, o = ((y + pad) * W + x) * 4;
    d.data[o] = src.data[i]!; d.data[o + 1] = src.data[i + 1]!; d.data[o + 2] = src.data[i + 2]!;
    d.data[o + 3] = Math.round(src.data[i + 3]! * Math.min(1, k));
    if (k > 0.5 && src.data[i + 3]! > 110) n++;
  }
  g.putImageData(d, 0, 0);
  return { canvas: c, n };
}

/** Distance (px) of pixel (x, y) from the nearest pixel with the given labels, approximated within `r` (cheap: used for overlaps). */
function nearLabel(labels: Uint8Array, w: number, h: number, set: Set<number>, r: number): Float32Array {
  // two-pass chamfer distance transform, capped at r
  const INF = 1e9, d = new Float32Array(w * h).fill(INF);
  for (let i = 0; i < w * h; i++) if (set.has(labels[i]!)) d[i] = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x > 0) d[i] = Math.min(d[i]!, d[i - 1]! + 1);
    if (y > 0) d[i] = Math.min(d[i]!, d[i - w]! + 1);
    if (x > 0 && y > 0) d[i] = Math.min(d[i]!, d[i - w - 1]! + 1.414);
    if (x < w - 1 && y > 0) d[i] = Math.min(d[i]!, d[i - w + 1]! + 1.414);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (x < w - 1) d[i] = Math.min(d[i]!, d[i + 1]! + 1);
    if (y < h - 1) d[i] = Math.min(d[i]!, d[i + w]! + 1);
    if (x < w - 1 && y < h - 1) d[i] = Math.min(d[i]!, d[i + w + 1]! + 1.414);
    if (x > 0 && y < h - 1) d[i] = Math.min(d[i]!, d[i + w - 1]! + 1.414);
  }
  for (let i = 0; i < w * h; i++) d[i] = Math.min(d[i]!, r + 1);
  return d;
}

/** Signed position of point p along the axis a->b (0 at a, 1 at b). */
const along = (p: Pt, a: Pt, b: Pt): number => { const dx = b.x - a.x, dy = b.y - a.y; return ((p.x - a.x) * dx + (p.y - a.y) * dy) / Math.max(1e-6, dx * dx + dy * dy); };
const angleFromDown = (a: Pt, b: Pt): number => (Math.atan2(-(b.x - a.x), b.y - a.y) * 180) / Math.PI; // + = toward screen left

/** Builds the puppet from a cut-out of a character generated over the mannequin. */
export async function buildPuppet(id: string, cut: Rgba, opts: { box?: { x: number; y: number; w: number; h: number }; nativeFacing?: -1 | 1 } = {}): Promise<Puppet> {
  const seg = segmentFigure(cut, opts.box);
  const { width: w, height: h } = cut;
  const L = seg.labels, J0 = seg.joints;
  const figH = seg.bottom - seg.top + 1;
  const pad = Math.round(figH * 0.08);
  const P = (p: Pt): Pt => ({ x: p.x, y: p.y + pad });
  const ov = Math.max(3, Math.round(figH * 0.012)); // overlap at the joints so rotated parts never open a gap
  const lab = (x: number, y: number): number => L[y * w + x]!;

  // overlaps: a part also takes foreground pixels within `ov` of itself that belong to its parent (drawn under the child)
  const dist = (names: LabelName[]): Float32Array => nearLabel(L, w, h, new Set(names.map((n) => LABEL[n])), ov * 3);
  const dArmN = dist(["armN"]), dArmF = dist(["armF"]);
  const fgA = (x: number, y: number): boolean => cut.data[(y * w + x) * 4 + 3]! > 8;

  const waistY = J0.waist.y, neckY = J0.neck.y;
  const counts: Record<string, number> = {};
  const make = (name: string, keep: (x: number, y: number) => number): Canvas => { const r = partCanvas(cut, pad, keep); counts[name] = r.n; return r.canvas; };

  // head (whole head incl. hair, the "underlay") and the face ellipse on top of it
  const head = make("head", (x, y) => (y < neckY + ov ? (lab(x, y) === LABEL.head || (y >= neckY && lab(x, y) === LABEL.torso) ? 1 - ramp(y, neckY, neckY + ov) : 0) : 0));
  let hx0 = w, hx1 = 0;
  for (let y = seg.top; y < neckY; y++) for (let x = 0; x < w; x++) if (lab(x, y) === LABEL.head) { hx0 = Math.min(hx0, x); hx1 = Math.max(hx1, x); }
  const headRect = { x: hx0, y: seg.top + pad, w: Math.max(1, hx1 - hx0 + 1), h: neckY - seg.top };
  const faceEllipse = { cx: (hx0 + hx1) / 2 - (opts.nativeFacing ?? -1) * headRect.w * 0.03, cy: seg.top + pad + headRect.h * 0.62, rx: headRect.w * 0.33, ry: headRect.h * 0.36 };
  const faceKeep = (x: number, y: number): number => {
    const d = Math.hypot((x - faceEllipse.cx) / faceEllipse.rx, (y + pad - faceEllipse.cy) / faceEllipse.ry);
    return ramp(1.12 - d, 0, 0.22);
  };
  const face = make("face", (x, y) => (lab(x, y) === LABEL.head ? faceKeep(x, y) : 0));
  // under the face, the head is painted plain skin colour: when the face slides for a head turn it uncovers skin, not a second pair of eyes
  {
    const g = head.getContext("2d"), d = g.getImageData(0, 0, w, h + pad);
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    for (let y = 0; y < h + pad; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d.data[i + 3]! < 200) continue;
      const dd = Math.hypot((x - faceEllipse.cx) / faceEllipse.rx, (y - faceEllipse.cy) / faceEllipse.ry);
      if (dd < 0.75 && dd > 0.35) { rs.push(d.data[i]!); gs.push(d.data[i + 1]!); bs.push(d.data[i + 2]!); }
    }
    const med = (a: number[]): number => (a.length ? a.sort((p, q) => p - q)[Math.floor(a.length * 0.6)]! : 180);
    const skin = [med(rs), med(gs), med(bs)];
    for (let y = 0; y < h + pad; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!d.data[i + 3]) continue;
      const dd = Math.hypot((x - faceEllipse.cx) / faceEllipse.rx, (y - faceEllipse.cy) / faceEllipse.ry);
      const k = ramp(1.0 - dd, 0, 0.25);
      for (let c = 0; c < 3; c++) d.data[i + c] = Math.round(d.data[i + c]! * (1 - k) + skin[c]! * k);
    }
    g.putImageData(d, 0, 0);
  }

  // torso above the waist (with the neck), and the coat / hips below it (the coat underlay extends up to the waist + overlap)
  const torsoish = (x: number, y: number): boolean => lab(x, y) === LABEL.torso;
  const torso = make("torso", (x, y) => (torsoish(x, y) || (y >= neckY - ov && y < neckY && lab(x, y) === LABEL.head) ? (y < neckY ? 1 : 1 - ramp(y, waistY + ov, waistY + ov * 3)) : 0));
  const crotch = J0.hipN.y + figH * 0.01;
  // the coat / hips: torso pixels below the waist, plus the top of the legs (the overlap that hides the hip joints)
  const coat = make("coat", (x, y) => (torsoish(x, y) && y > waistY - ov * 2 ? 1 : (lab(x, y) === LABEL.legN || lab(x, y) === LABEL.legF) && y < crotch + ov * 2 ? 1 - ramp(y, crotch + ov, crotch + ov * 2) : 0));

  // arms: split along the shoulder->hand axis at the elbow, with overlap; the upper arm also takes a little torso at the shoulder
  const arm = (limb: Limb): { upper: Canvas; lower: Canvas } => {
    const labA = limb === "N" ? LABEL.armN : LABEL.armF, dA = limb === "N" ? dArmN : dArmF;
    const sh = limb === "N" ? J0.shoulderN : J0.shoulderF, el = limb === "N" ? J0.elbowN : J0.elbowF, hand = limb === "N" ? J0.handN : J0.handF;
    const te = along(el, sh, hand), ovT = ov / Math.max(1, Math.hypot(hand.x - sh.x, hand.y - sh.y));
    const upper = make(`upperArm${limb}`, (x, y) => {
      const isArm = lab(x, y) === labA || (fgA(x, y) && lab(x, y) === LABEL.torso && dA[y * w + x]! <= ov && y < el.y);
      if (!isArm) return 0;
      const t = along({ x, y }, sh, hand);
      return 1 - ramp(t, te + ovT, te + ovT * 2.5);
    });
    const lower = make(`lowerArm${limb}`, (x, y) => (lab(x, y) === labA ? ramp(along({ x, y }, sh, hand), te - ovT * 1.5, te) : 0));
    return { upper, lower };
  };
  const aN = arm("N"), aF = arm("F");

  // legs: split along hip->ankle at the knee
  const leg = (limb: Limb): { thigh: Canvas; shin: Canvas } => {
    const labL = limb === "N" ? LABEL.legN : LABEL.legF;
    const hip = limb === "N" ? J0.hipN : J0.hipF, knee = limb === "N" ? J0.kneeN : J0.kneeF, ankle = limb === "N" ? J0.ankleN : J0.ankleF;
    const tk = along(knee, hip, ankle), ovT = ov / Math.max(1, Math.hypot(ankle.x - hip.x, ankle.y - hip.y));
    const thigh = make(`thigh${limb}`, (x, y) => (lab(x, y) === labL ? 1 - ramp(along({ x, y }, hip, ankle), tk + ovT, tk + ovT * 2.5) : 0));
    const shin = make(`shin${limb}`, (x, y) => (lab(x, y) === labL ? ramp(along({ x, y }, hip, ankle), tk - ovT * 1.5, tk) : 0));
    return { thigh, shin };
  };
  const lN = leg("N"), lF = leg("F");

  const whole = createCanvas(w, h + pad);
  whole.getContext("2d").drawImage(await loadImage(encodePng(cut)), 0, pad);
  const joints = Object.fromEntries(Object.entries(J0).map(([k, v]) => [k, P(v)])) as unknown as PuppetJoints;
  return {
    id, w, h: h + pad, pad, figH, groundY: seg.bottom + pad, nativeFacing: opts.nativeFacing ?? -1, joints,
    armRest: { N: angleFromDown(J0.shoulderN, J0.handN), F: angleFromDown(J0.shoulderF, J0.handF) },
    parts: { head, face, torso, coat, upperArmN: aN.upper, lowerArmN: aN.lower, upperArmF: aF.upper, lowerArmF: aF.lower, thighN: lN.thigh, shinN: lN.shin, thighF: lF.thigh, shinF: lF.shin },
    faces: {}, faceEllipse, headRect, whole,
    report: { armsSeparated: seg.armsSeparated, legsSeparated: seg.legsSeparated, partPixels: counts },
  };
}

/**
 * Adds an expression: `variant` is the model's redraw of the head crop (`crop` = where that crop sits in the source cut-out,
 * unpadded). Only the face ellipse is kept, so the hair, the cap and the outline of the head stay exactly the same.
 */
export async function addPuppetFace(p: Puppet, name: string, variant: Rgba, crop: { x: number; y: number; w: number; h: number }): Promise<void> {
  const img = await loadImage(encodePng(variant));
  const c = createCanvas(p.w, p.h), g = c.getContext("2d");
  g.drawImage(img, crop.x, crop.y + p.pad, crop.w, crop.h);
  const d = g.getImageData(0, 0, p.w, p.h);
  const e = p.faceEllipse;
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    const dd = Math.hypot((x - e.cx) / e.rx, (y - e.cy) / e.ry);
    const i = (y * p.w + x) * 4 + 3;
    d.data[i] = Math.round(d.data[i]! * ramp(1.12 - dd, 0, 0.22));
  }
  g.putImageData(d, 0, 0);
  p.faces[name] = c;
}

/** The square region around the head (unpadded source coordinates) that the image model redraws with other expressions. */
export function puppetHeadCrop(p: Puppet): { x: number; y: number; w: number; h: number } {
  const r = p.headRect, size = Math.round(Math.max(r.w, r.h) * 1.45);
  const cx = r.x + r.w / 2, cy = r.y - p.pad + r.h * 0.55;
  return { x: Math.round(cx - size / 2), y: Math.round(cy - size / 2), w: size, h: size };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Posing

/**
 * Joint angles in degrees in the puppet's NATIVE orientation (the renderer mirrors the whole figure for the other facing):
 * + = forward (toward the facing direction) for shoulders and hips; elbows + = forearm bent forward/up; knees + = shin bent back.
 * Offsets are fractions of the figure height.
 */
export interface PuppetPose {
  bob: number; lean: number; coat: number;
  headRot: number; headDx: number; headDy: number; hair: number;
  /** -1..1: face turned toward the screen left/right (the face slides over the head, hair stays). */
  look: number; lookUp: number;
  shoulderN: number; elbowN: number; shoulderF: number; elbowF: number;
  hipN: number; kneeN: number; liftN: number; hipF: number; kneeF: number; liftF: number;
  pop: number; trembleX: number; trembleY: number;
  /** Face expression weights (sum <= 1). */
  face: Record<string, number>;
}
export const restPose = (): PuppetPose => ({ bob: 0, lean: 0, coat: 0, headRot: 0, headDx: 0, headDy: 0, hair: 0, look: 0, lookUp: 0, shoulderN: 0, elbowN: 0, shoulderF: 0, elbowF: 0, hipN: 0, kneeN: 0, liftN: 0, hipF: 0, kneeF: 0, liftF: 0, pop: 0, trembleX: 0, trembleY: 0, face: {} });

/** Something held in a hand: drawn in the hand's frame right after that arm, so it is occluded exactly like the hand. */
export interface HeldItem {
  hand: Limb;
  image: Canvas | import("@napi-rs/canvas").Image;
  /** Grip point in the image (fractions) and the image's own axis angle (deg; 0 = the item points to the image's right). */
  grip: { x: number; y: number };
  axis: number;
  /** Item length (its longer side) as a fraction of the figure height. */
  size: number;
  opacity: number;
}
export interface HandFrame { x: number; y: number; angle: number }

const RAD = Math.PI / 180;

/**
 * Draws the posed puppet on a scratch canvas. Returns the canvas, the margin around the source picture, and the frame (position +
 * pointing direction, in that canvas) of each hand, so the renderer can light a held flashlight's beam from the right place.
 * `sg` = sign of the horizontal mirror applied afterwards (angles are mirrored with it).
 */
export function composePuppet(getCanvas: (key: string, w: number, h: number) => Canvas, key: string, p: Puppet, pose: PuppetPose, held: HeldItem[] = []): { canvas: Canvas; margin: number; hands: Record<Limb, HandFrame> } {
  const m = Math.round(p.figH * 0.45);
  const cw = p.w + 2 * m, ch = p.h + 2 * m;
  const c = getCanvas(`puppet-${key}`, cw, ch), g = c.getContext("2d");
  const J = p.joints, H = p.figH;
  const hands = {} as Record<Limb, HandFrame>;
  const rot = (pt: Pt, deg: number): void => { g.translate(pt.x, pt.y); g.rotate(deg * RAD); g.translate(-pt.x, -pt.y); };
  // native facing left: "forward" is screen-left, i.e. a clockwise (positive canvas) rotation of a limb that hangs down
  const fw = p.nativeFacing === -1 ? 1 : -1;
  g.save();
  // grounding: the lowest foot stays on the floor, so the body drops when the legs spread (a natural bob) and never floats
  const R = (pt: Pt, c: Pt, deg: number): Pt => { const a = deg * RAD, co = Math.cos(a), si = Math.sin(a); return { x: c.x + (pt.x - c.x) * co - (pt.y - c.y) * si, y: c.y + (pt.x - c.x) * si + (pt.y - c.y) * co }; };
  const ankleAt = (limb: Limb): number => {
    const hip = limb === "N" ? J.hipN : J.hipF, knee = limb === "N" ? J.kneeN : J.kneeF, ankle = limb === "N" ? J.ankleN : J.ankleF;
    const a = limb === "N" ? pose.hipN : pose.hipF, k = limb === "N" ? pose.kneeN : pose.kneeF, lift = limb === "N" ? pose.liftN : pose.liftF;
    return R(R(ankle, knee, -fw * k), hip, fw * a).y - lift * H;
  };
  const rest = Math.max(J.ankleN.y, J.ankleF.y);
  const drop = rest - Math.max(ankleAt("N"), ankleAt("F"));
  g.translate(m, m + drop + pose.bob * H * 0.35);

  const drawLeg = (limb: Limb): void => {
    const hip = limb === "N" ? J.hipN : J.hipF, knee = limb === "N" ? J.kneeN : J.kneeF;
    const a = limb === "N" ? pose.hipN : pose.hipF, k = limb === "N" ? pose.kneeN : pose.kneeF, lift = limb === "N" ? pose.liftN : pose.liftF;
    g.save();
    // the body bobs, the planted foot does not: legs are drawn without the bob (the coat covers the hip joint)
    g.translate(0, -(pose.bob * H * 0.35) - lift * H);
    rot(hip, fw * a);
    g.drawImage(limb === "N" ? p.parts.thighN : p.parts.thighF, 0, 0);
    rot(knee, -fw * k);
    g.drawImage(limb === "N" ? p.parts.shinN : p.parts.shinF, 0, 0);
    g.restore();
  };
  const drawArm = (limb: Limb): void => {
    const sh = limb === "N" ? J.shoulderN : J.shoulderF, el = limb === "N" ? J.elbowN : J.elbowF, hand = limb === "N" ? J.handN : J.handF;
    const s = limb === "N" ? pose.shoulderN : pose.shoulderF;
    const e = limb === "N" ? pose.elbowN : pose.elbowF;
    // arms hang in the mannequin's A-pose; bring them in toward the body first (rest), then apply the pose
    const rest = -(limb === "N" ? p.armRest.N : p.armRest.F) * 0.7;
    g.save();
    rot(sh, rest + fw * s);
    g.drawImage(limb === "N" ? p.parts.upperArmN : p.parts.upperArmF, 0, 0);
    rot(el, fw * e);
    g.drawImage(limb === "N" ? p.parts.lowerArmN : p.parts.lowerArmF, 0, 0);
    // hand frame: the forearm direction (elbow -> hand) after all rotations
    const tf = g.getTransform();
    const tx = (pt: Pt): Pt => ({ x: tf.a * pt.x + tf.c * pt.y + tf.e, y: tf.b * pt.x + tf.d * pt.y + tf.f });
    const hp = tx(hand), ep = tx(el);
    hands[limb] = { x: hp.x, y: hp.y, angle: (Math.atan2(hp.y - ep.y, hp.x - ep.x) * 180) / Math.PI };
    for (const it of held.filter((x) => x.hand === limb && x.opacity > 0.01)) {
      const len = it.size * H, iw = it.image.width, ih = it.image.height, sc = len / Math.max(iw, ih);
      g.save();
      g.globalAlpha = Math.min(1, it.opacity);
      g.translate(hand.x, hand.y);
      // the item continues the forearm: its axis aligned with elbow->hand in the arm's local frame
      g.rotate(Math.atan2(hand.y - el.y, hand.x - el.x) - it.axis * RAD);
      g.drawImage(it.image, -it.grip.x * iw * sc, -it.grip.y * ih * sc, iw * sc, ih * sc);
      g.restore();
    }
    g.restore();
  };

  // far side first
  g.save(); rot(J.hips, -fw * pose.lean); drawArm("F"); g.restore();
  drawLeg("F");
  drawLeg("N");
  // coat / hips lag behind the body
  g.save(); rot(J.waist, fw * (-pose.lean * 0.6 + pose.coat)); g.drawImage(p.parts.coat, 0, 0); g.restore();
  // upper body about the hips
  g.save();
  rot(J.hips, -fw * pose.lean);
  g.drawImage(p.parts.torso, 0, 0);
  // head: hair/head underlay with its lag, then the face (slides with the look)
  g.save();
  g.translate(fw * pose.headDx * H, pose.headDy * H);
  rot(J.neck, -fw * pose.headRot);
  g.save(); rot(J.neck, -fw * pose.hair); g.drawImage(p.parts.head, 0, 0); g.restore();
  const hw = p.headRect.w;
  g.translate(pose.look * hw * 0.08, pose.lookUp * p.headRect.h * 0.05);
  const fx = 1 - Math.abs(pose.look) * 0.06;
  g.translate(p.faceEllipse.cx, 0); g.scale(fx, 1); g.translate(-p.faceEllipse.cx, 0);
  const total = Math.min(1, Object.values(pose.face).reduce((a, b) => a + b, 0));
  g.globalAlpha = 1;
  g.drawImage(p.parts.face, 0, 0);
  for (const [name, wgt] of Object.entries(pose.face)) {
    const f = p.faces[name];
    if (!f || wgt < 0.003) continue;
    g.globalAlpha = Math.min(1, wgt / Math.max(1, total));
    g.drawImage(f, 0, 0);
  }
  g.globalAlpha = 1;
  g.restore();
  drawArm("N");
  g.restore();
  g.restore();
  // hand frames are in canvas space already (getTransform includes the margin)
  return { canvas: c, margin: m, hands };
}

/** Back-compat helper for tests: the hand position in rest pose. */
