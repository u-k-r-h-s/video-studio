import { createCanvas, loadImage, type Canvas, type Image } from "@napi-rs/canvas";
import type { Rgba } from "../lib/png";
import { encodePng } from "../lib/png";

/** Where a cut-out figure splits into puppet parts (all in source pixels of the cropped figure). */
export interface FigureAnalysis {
  w: number;
  h: number;
  neckY: number;
  neckCx: number;
  hipY: number;
  crotchY: number;
  splitX: number;
  hipLx: number;
  hipRx: number;
  headRect: { x: number; y: number; w: number; h: number };
}

const alphaAt = (img: Rgba, x: number, y: number): number => img.data[(y * img.width + x) * 4 + 3]!;

/** Finds the neck (narrowest row under the head) and the crotch (where the legs separate) of a standing figure. */
export function analyzeFigure(img: Rgba, opts: { neckRange?: [number, number]; crotchFrom?: number } = {}): FigureAnalysis {
  const { width: w, height: h } = img;
  const minX = new Int32Array(h).fill(w), maxX = new Int32Array(h).fill(-1), cnt = new Int32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alphaAt(img, x, y) > 128) { cnt[y]!++; if (x < minX[y]!) minX[y] = x; if (x > maxX[y]!) maxX[y] = x; }
  const width = (y: number): number => (maxX[y]! >= 0 ? maxX[y]! - minX[y]! + 1 : 0);
  const sm = (y: number): number => { let s = 0, n = 0; for (let k = -3; k <= 3; k++) { const yy = Math.min(h - 1, Math.max(0, y + k)); s += width(yy); n++; } return s / n; };

  // head top = first row with content
  let top = 0;
  while (top < h && cnt[top] === 0) top++;
  const figH = h - top;
  const [nLo, nHi] = opts.neckRange ?? [0.09, 0.2];
  let neckY = Math.round(top + figH * 0.15), best = Infinity;
  for (let y = Math.round(top + figH * nLo); y <= Math.round(top + figH * nHi); y++) { const v = sm(y); if (v < best) { best = v; neckY = y; } }
  const neckCx = Math.round((minX[neckY]! + maxX[neckY]!) / 2);

  // crotch: first row below the waist where a transparent gap sits near the figure's centre and persists
  const gapAt = (y: number): { cx: number; len: number } | null => {
    const lo = minX[y]!, hi = maxX[y]!;
    if (hi < 0) return null;
    const mid = (lo + hi) / 2, tol = Math.max(8, (hi - lo + 1) * 0.18);
    let best: { cx: number; len: number } | null = null;
    let x = lo;
    while (x <= hi) {
      if (alphaAt(img, x, y) <= 128) {
        let x2 = x;
        while (x2 <= hi && alphaAt(img, x2, y) <= 128) x2++;
        const cx = (x + x2 - 1) / 2, len = x2 - x;
        if (len >= 3 && Math.abs(cx - mid) <= tol && x > lo && x2 <= hi && (!best || len > best.len)) best = { cx, len };
        x = x2;
      } else x++;
    }
    return best;
  };
  let crotchY = Math.round(top + figH * 0.52), splitX = Math.round(neckCx);
  const from = Math.round(top + figH * (opts.crotchFrom ?? 0.42));
  for (let y = from; y < Math.round(top + figH * 0.8); y++) {
    let ok = true, cxSum = 0;
    for (let k = 0; k < 14 && ok; k++) { const g = gapAt(y + k); if (!g) ok = false; else cxSum += g.cx; }
    if (ok) { crotchY = y; splitX = Math.round(cxSum / 14); break; }
  }
  const hipY = Math.round(crotchY - figH * 0.02);
  const legCx = (side: "L" | "R"): number => {
    let sum = 0, n = 0;
    const y = Math.min(h - 1, crotchY + Math.round(figH * 0.03));
    for (let x = 0; x < w; x++) if (alphaAt(img, x, y) > 128 && (side === "L" ? x < splitX : x >= splitX)) { sum += x; n++; }
    return n ? sum / n : side === "L" ? splitX - w * 0.1 : splitX + w * 0.1;
  };
  let headMin = w, headMax = 0;
  for (let y = top; y <= neckY; y++) { if (minX[y]! < headMin) headMin = minX[y]!; if (maxX[y]! > headMax) headMax = maxX[y]!; }
  const hw = headMax - headMin + 1;
  return {
    w, h, neckY, neckCx, hipY, crotchY, splitX, hipLx: legCx("L"), hipRx: legCx("R"),
    headRect: { x: Math.max(0, Math.round(headMin - hw * 0.15)), y: Math.max(0, top - 2), w: Math.min(w, Math.round(hw * 1.3)), h: neckY - top + Math.round(figH * 0.03) },
  };
}

export interface Rig {
  id: string;
  w: number;
  /** Figure height in source px (without padding). */
  h: number;
  /** Transparent rows added above the figure so hair of a taller head variant is not clipped. All canvases and `analysis` are in this padded space. */
  pad: number;
  /** Which way the artwork faces on screen. */
  nativeFacing: -1 | 1;
  analysis: FigureAnalysis;
  /** Full-figure-size canvases that contain only their body part (same coordinates as the source). */
  head: Canvas;
  torso: Canvas;
  legL: Canvas;
  legR: Canvas;
  /** Head variants (same size as `head`): front, lookL, lookR, surprised, smile, worried, angry. */
  variants: Record<string, Canvas>;
  /** The whole cut-out (for static use, thumbnails, silhouettes). */
  whole: Canvas;
}

async function imageFromRgba(img: Rgba): Promise<Image> {
  return loadImage(encodePng(img));
}

/** Copies `src` into a new full-size canvas, keeping only rows/columns allowed by `mask(x,y)->0..1` (alpha multiplier). */
function slice(src: Image | Canvas, w: number, h: number, mask: (x: number, y: number) => number): Canvas {
  const c = createCanvas(w, h);
  const g = c.getContext("2d");
  g.drawImage(src, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const m = mask(x, y);
    if (m < 1) d.data[(y * w + x) * 4 + 3] = Math.round(d.data[(y * w + x) * 4 + 3]! * Math.max(0, m));
  }
  g.putImageData(d, 0, 0);
  return c;
}

const ramp = (v: number, a: number, b: number): number => Math.min(1, Math.max(0, (v - a) / (b - a)));

/**
 * Cuts a keyed, cropped full-body figure into a puppet: head (above the neck), torso (neck..hips), and two legs (below the
 * hips, split between them). Parts overlap by a feathered margin so the seams stay hidden while they rotate about their joints.
 */
export async function buildRig(id: string, cutout: Rgba, opts: { nativeFacing?: -1 | 1; analysis?: FigureAnalysis } = {}): Promise<Rig> {
  const a0 = opts.analysis ?? analyzeFigure(cutout);
  const pad = Math.round(cutout.height * 0.06);
  const a: FigureAnalysis = { ...a0, h: a0.h + pad, neckY: a0.neckY + pad, hipY: a0.hipY + pad, crotchY: a0.crotchY + pad, headRect: { ...a0.headRect, y: a0.headRect.y + pad } };
  const raw = await imageFromRgba(cutout);
  const w = a.w, h = a.h;
  const src = createCanvas(w, h);
  src.getContext("2d").drawImage(raw, 0, pad);
  const ov = Math.max(4, Math.round(cutout.height * 0.018));
  const head = slice(src, w, h, (_x, y) => 1 - ramp(y, a.neckY - ov, a.neckY + ov));
  const torso = slice(src, w, h, (_x, y) => ramp(y, a.neckY - ov * 2, a.neckY - ov * 0.5) * (1 - ramp(y, a.hipY + ov, a.hipY + ov * 3)));
  const leg = (side: "L" | "R"): Canvas => slice(src, w, h, (x, y) => {
    const sideOk = side === "L" ? 1 - ramp(x, a.splitX - 2, a.splitX + 2) : ramp(x, a.splitX - 2, a.splitX + 2);
    return ramp(y, a.hipY - ov * 2, a.hipY) * sideOk;
  });
  return { id, w, h: cutout.height, pad, nativeFacing: opts.nativeFacing ?? -1, analysis: a, head, torso, legL: leg("L"), legR: leg("R"), variants: {}, whole: src };
}

/**
 * Registers a head variant: `faceCutout` is a keyed render of the same head (a square crop of the figure around the head,
 * re-drawn by the image model). It is stretched back over the original head rectangle and limited to the head rows.
 */
export async function addHeadVariant(rig: Rig, name: string, faceCutout: Rgba, cropRect: { x: number; y: number; w: number; h: number }): Promise<void> {
  const img = await imageFromRgba(faceCutout);
  const H = rig.h + rig.pad;
  const full = createCanvas(rig.w, H);
  full.getContext("2d").drawImage(img, cropRect.x, cropRect.y + rig.pad, cropRect.w, cropRect.h);
  const a = rig.analysis, ov = Math.max(4, Math.round(rig.h * 0.018));
  const c = createCanvas(rig.w, H);
  const g = c.getContext("2d");
  g.drawImage(full, 0, 0);
  const d = g.getImageData(0, 0, rig.w, H);
  // keep only the head: rows above the neck, and inside a soft ellipse around the base head (drops stray backdrop bars/rings the model may draw)
  const hr = a.headRect, cx = hr.x + hr.w / 2, cy = hr.y + hr.h * 0.5, rx = hr.w * 0.82, ry = hr.h * 0.95;
  for (let y = 0; y < H; y++) {
    const mNeck = 1 - ramp(y, a.neckY - ov, a.neckY + ov);
    for (let x = 0; x < rig.w; x++) {
      const dd = Math.hypot((x - cx) / rx, (y - cy) / ry);
      const m = mNeck * (y > a.neckY - ov * 2 ? 1 : ramp(1 - dd, 0, 0.18));
      if (m < 1) d.data[(y * rig.w + x) * 4 + 3] = Math.round(d.data[(y * rig.w + x) * 4 + 3]! * m);
    }
  }
  g.putImageData(d, 0, 0);
  rig.variants[name] = c;
}

/** The square region around the head that is sent to the image model to draw expression variants (may extend past the figure; padded with backdrop). */
export function headCropRect(a: FigureAnalysis): { x: number; y: number; w: number; h: number } {
  const hr = a.headRect;
  const size = Math.round(Math.max(hr.w, hr.h) * 1.45);
  const cx = hr.x + hr.w / 2, cy = hr.y + hr.h * 0.55;
  return { x: Math.round(cx - size / 2), y: Math.round(cy - size / 2), w: size, h: size };
}
