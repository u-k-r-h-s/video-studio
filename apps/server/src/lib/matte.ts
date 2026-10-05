import type { Rgba } from "./png";

/**
 * Cut-out from a foreground matte (white = foreground) produced by the background-removal model. The matte is a grey image the
 * size of the source; it is used as the alpha channel directly, so white, grey, black, skin, pastel and glossy materials are
 * kept exactly where the model says they belong to the foreground, with no colour heuristics.
 */
export function applyMatte(img: Rgba, matte: Rgba, opts: { gamma?: number; threshold?: number } = {}): Rgba {
  if (img.width !== matte.width || img.height !== matte.height) throw new Error(`matte is ${matte.width}x${matte.height} but the image is ${img.width}x${img.height}`);
  const out = new Uint8Array(img.data);
  const gamma = opts.gamma ?? 1.15, floor = opts.threshold ?? 0.04;
  for (let i = 0; i < img.width * img.height; i++) {
    let a = (matte.data[i * 4]! + matte.data[i * 4 + 1]! + matte.data[i * 4 + 2]!) / (3 * 255);
    a = a < floor ? 0 : a > 1 - floor ? 1 : Math.pow(a, gamma);
    out[i * 4 + 3] = Math.round(a * (img.data[i * 4 + 3]! / 255) * 255);
  }
  return { width: img.width, height: img.height, data: out };
}

export interface MatteReport { ok: boolean; reason?: string; coverage: number; edgeContact: number; components: number }

/**
 * Quality gate for a cut-out: the subject must exist (not empty, not the whole picture), must not be a pile of fragments,
 * and a full-body figure must not touch the image border (it was cropped by the frame).
 */
export function assessMatte(cut: Rgba, kind: "character" | "prop" | "head" = "character"): MatteReport {
  const { width: w, height: h } = cut;
  let solid = 0, edge = 0;
  const label = new Int32Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) if (cut.data[i * 4 + 3]! > 127) solid++;
  const coverage = solid / (w * h);
  for (let x = 0; x < w; x++) { if (cut.data[x * 4 + 3]! > 127) edge++; if (cut.data[((h - 1) * w + x) * 4 + 3]! > 127) edge++; }
  for (let y = 0; y < h; y++) { if (cut.data[y * w * 4 + 3]! > 127) edge++; if (cut.data[(y * w + w - 1) * 4 + 3]! > 127) edge++; }
  // connected components of solid pixels (count the ones that matter)
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (label[s] !== -1 || cut.data[s * 4 + 3]! <= 127) continue;
    const id = sizes.length;
    let n = 0;
    stack.push(s); label[s] = id;
    while (stack.length) {
      const p = stack.pop()!; n++;
      const x = p % w, y = (p / w) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) if (q >= 0 && label[q] === -1 && cut.data[q * 4 + 3]! > 127) { label[q] = id; stack.push(q); }
    }
    sizes.push(n);
  }
  const biggest = Math.max(0, ...sizes);
  const components = sizes.filter((n) => n > biggest * 0.05).length;
  const contact = edge / (2 * (w + h));
  let top = 0, bottom = 0;
  for (let x = 0; x < w; x++) { if (cut.data[x * 4 + 3]! > 127) top++; if (cut.data[((h - 1) * w + x) * 4 + 3]! > 127) bottom++; }
  const base = { coverage, edgeContact: contact, components };
  if (coverage < 0.03) return { ok: false, reason: "the subject was not found (empty matte)", ...base };
  if (coverage > 0.85) return { ok: false, reason: "the matte covers almost the whole picture", ...base };
  if (components > 3 && kind !== "prop") return { ok: false, reason: `the subject is split into ${components} pieces`, ...base };
  // a full-body figure needs its head and its feet inside the frame: a few touching pixels are fine, a cropped body is not
  if (kind === "character" && (top > w * 0.02 || bottom > w * 0.02)) return { ok: false, reason: top > bottom ? "the head is cut off by the image border" : "the feet are cut off by the image border", ...base };
  if (kind === "character" && contact > 0.08) return { ok: false, reason: "the figure touches the image border (cropped)", ...base };
  return { ok: true, ...base };
}

/**
 * Validation of a background: BiRefNet marks the salient foreground of a picture. In an empty place that is architecture (a door,
 * a doorway, a machine); a standing person, an animal or a ghost shows up as a compact upright blob. Returns a reason when the
 * picture probably contains a figure nobody asked for.
 */
export function figureInBackground(matte: Rgba): string | null {
  const { width: w, height: h } = matte;
  const on = (i: number): boolean => matte.data[i * 4]! > 128;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || !on(s)) continue;
    let n = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const p = stack.pop()!; n++;
      const x = p % w, y = (p / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) if (q >= 0 && !seen[q] && on(q)) { seen[q] = 1; stack.push(q); }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, fill = n / (bw * bh);
    if (n < w * h * 0.004) continue;
    const upright = bh / bw >= 1.5, sized = bh > h * 0.1 && bh < h * 0.72, compact = fill > 0.28 && fill < 0.82, notEdge = x0 > 2 && x1 < w - 3;
    if (upright && sized && compact && notEdge) return `an upright figure (${bw}x${bh} px) stands in the background`;
  }
  return null;
}
