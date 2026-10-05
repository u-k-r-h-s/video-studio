import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { applyMatte } from "../lib/matte";
import { decodePng, encodePng, type Rgba } from "../lib/png";
import { analyzeFigure, headCropRect } from "./rig";

/** Project-relative locations of the animated pipeline's images. */
export const animPaths = {
  raw: (id: string): string => `images/anim/raw/${id}.png`,
  matte: (id: string, pass = 1): string => `images/anim/matte/${id}${pass > 1 ? `.p${pass}` : ""}.png`,
  rest: (id: string): string => `images/anim/matte/${id}.rest.png`,
  final: (id: string): string => `images/anim/${id}.png`,
  headCrop: (charId: string): string => `images/anim/raw/headcrop-${charId}.png`,
};

export function backdropColor(img: Rgba): [number, number, number] {
  let r = 0, g = 0, b = 0, n = 0;
  const { width: w, height: h } = img;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x > 3 && y > 3 && x < w - 4 && y < h - 4) continue;
    const i = (y * w + x) * 4; r += img.data[i]!; g += img.data[i + 1]!; b += img.data[i + 2]!; n++;
  }
  return [r / n, g / n, b / n];
}

/** Bounding box of the pixels the matte calls foreground. */
export function matteBox(matte: Rgba, threshold = 128): { x: number; y: number; w: number; h: number } | null {
  let x0 = matte.width, y0 = matte.height, x1 = -1, y1 = -1;
  for (let y = 0; y < matte.height; y++) for (let x = 0; x < matte.width; x++) if (matte.data[(y * matte.width + x) * 4]! > threshold) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Second pass for objects that are held (a hand holding a phone): the model's matte picks the most salient thing (the phone), so
 * that part is painted over with the backdrop colour and the picture is matted again, which finds the hand. The cut-out is the
 * union of the passes.
 */
export function residualImage(raw: Rgba, matte1: Rgba, grow = 8): Rgba {
  const { width: w, height: h } = raw;
  const fg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) fg[i] = matte1.data[i * 4]! > 100 ? 1 : 0;
  let cur = fg;
  for (let k = 0; k < grow; k++) {
    const nx = new Uint8Array(cur);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (!cur[i] && (cur[i - 1] || cur[i + 1] || cur[i - w] || cur[i + w])) nx[i] = 1; }
    cur = nx;
  }
  const [br, bg, bb] = backdropColor(raw);
  const out = new Uint8Array(raw.data);
  for (let i = 0; i < w * h; i++) if (cur[i]) { out[i * 4] = br; out[i * 4 + 1] = bg; out[i * 4 + 2] = bb; }
  return { width: w, height: h, data: out };
}

export function unionMatte(a: Rgba, b: Rgba): Rgba {
  const out = new Uint8Array(a.data);
  for (let i = 0; i < a.width * a.height * 4; i++) out[i] = Math.max(a.data[i]!, b.data[i]!);
  return { width: a.width, height: a.height, data: out };
}

/** Raw render + matte -> transparent cut-out. Figures and props are cropped to their content; head variants keep their full square. */
export function makeCutout(raw: Rgba, matte: Rgba, crop: boolean): { cut: Rgba; box: { x: number; y: number; w: number; h: number } } {
  const full = applyMatte(raw, matte);
  if (!crop) return { cut: full, box: { x: 0, y: 0, w: full.width, h: full.height } };
  let x0 = full.width, y0 = full.height, x1 = -1, y1 = -1;
  for (let y = 0; y < full.height; y++) for (let x = 0; x < full.width; x++) if (full.data[(y * full.width + x) * 4 + 3]! > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return { cut: full, box: { x: 0, y: 0, w: full.width, h: full.height } };
  x0 = Math.max(0, x0 - 2); y0 = Math.max(0, y0 - 2); x1 = Math.min(full.width - 1, x1 + 2); y1 = Math.min(full.height - 1, y1 + 2);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(full.data.subarray(((y0 + y) * full.width + x0) * 4, ((y0 + y) * full.width + x0 + w) * 4), y * w * 4);
  return { cut: { width: w, height: h, data }, box: { x: x0, y: y0, w, h } };
}

/** The square picture of a character's head, on white, that the image model redraws with other looks and expressions. */
export async function makeHeadCrop(frontCutout: Rgba, at?: { x: number; y: number; w: number; h: number }): Promise<{ png: Buffer; rect: { x: number; y: number; w: number; h: number } }> {
  const rect = at ?? headCropRect(analyzeFigure(frontCutout));
  const img = await loadImage(encodePng(frontCutout));
  const c = createCanvas(512, 512), g = c.getContext("2d");
  g.fillStyle = "#ececec";
  g.fillRect(0, 0, 512, 512);
  g.scale(512 / rect.w, 512 / rect.h);
  g.translate(-rect.x, -rect.y);
  g.drawImage(img, 0, 0);
  return { png: c.toBuffer("image/png"), rect };
}

/** Content-addressed cache shared by all projects: a hash identifies an asset's inputs, so identical assets are never generated twice. */
export class AssetCache {
  constructor(private readonly dir: string) {}
  private file(hash: string): string { return path.join(this.dir, `${hash}.png`); }
  has(hash: string): boolean { return existsSync(this.file(hash)); }
  async get(hash: string, dest: string): Promise<{ meta: Record<string, unknown> } | null> {
    if (!this.has(hash)) return null;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(this.file(hash), dest);
    const meta = await fs.readFile(`${this.file(hash)}.json`, "utf8").then((t) => JSON.parse(t) as Record<string, unknown>, () => ({}));
    return { meta };
  }
  async put(hash: string, src: string, meta: Record<string, unknown>): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.copyFile(src, this.file(hash));
    await fs.writeFile(`${this.file(hash)}.json`, JSON.stringify(meta));
  }
}

export const readRgba = async (file: string): Promise<Rgba> => decodePng(await fs.readFile(file));
