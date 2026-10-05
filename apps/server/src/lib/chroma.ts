import type { Rgba } from "./png";

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Keys out a flat GREEN backdrop (what the image model is asked to draw behind cut-out assets). Unlike keying by the
 * border colour, this keeps white and grey clothing, and removes the shadow/vignette the model puts on the backdrop.
 * Edge pixels get partial alpha and their green spill is removed.
 */
export function chromaKeyGreen(img: Rgba, lo = 14, hi = 60): Rgba {
  const out = new Uint8Array(img.data);
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * 4;
    const r = out[o]!, g = out[o + 1]!, b = out[o + 2]!;
    const mx = Math.max(r, b);
    const gd = g - mx; // how much greener than the other channels
    const a = 1 - smooth(lo, hi, gd);
    if (gd > 0) out[o + 1] = Math.round(mx + gd * 0.1); // despill
    out[o + 3] = Math.round(out[o + 3]! * a);
  }
  return { width: img.width, height: img.height, data: out };
}

/** Keeps only the biggest connected blob(s) of opaque pixels (drops specks and floor-shadow remnants). */
export function keepMainBody(img: Rgba, minFraction = 0.04, alphaMin = 40): Rgba {
  const { width: w, height: h } = img;
  const label = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (label[s] !== -1 || img.data[s * 4 + 3]! < alphaMin) continue;
    const id = sizes.length;
    let n = 0;
    stack.push(s);
    label[s] = id;
    while (stack.length) {
      const p = stack.pop()!;
      n++;
      const x = p % w, y = (p / w) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && label[q] === -1 && img.data[q * 4 + 3]! >= alphaMin) { label[q] = id; stack.push(q); }
      }
    }
    sizes.push(n);
  }
  if (!sizes.length) return img;
  const biggest = Math.max(...sizes);
  const keep = new Set(sizes.map((n, i) => [n, i] as const).filter(([n]) => n >= biggest * minFraction).map(([, i]) => i));
  const out = new Uint8Array(img.data);
  for (let p = 0; p < w * h; p++) if (!keep.has(label[p]!)) out[p * 4 + 3] = 0;
  return { width: w, height: h, data: out };
}

/**
 * Cuts a figure out of a smooth studio backdrop (the model ignores "green screen" and draws a grey gradient with a floor
 * shadow). The backdrop is found by FLOOD-FILL FROM THE BORDER over pixels whose colour changes only slowly from one pixel to
 * the next, so a vignette and a soft shadow are swallowed while the silhouette (a strong edge) stops the fill. That keeps white
 * clothing on a light backdrop, which keying by colour distance cannot do. The edge is then eroded and feathered.
 */
export function keyByContinuity(img: Rgba, opts: { step?: number; drift?: number; erode?: number; feather?: number } = {}): Rgba {
  const { width: w, height: h } = img;
  const step = opts.step ?? 7, drift = opts.drift ?? 95;
  const d = img.data;
  const px = (i: number): [number, number, number] => [d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!];
  const bg = new Uint8Array(w * h);
  const queue: number[] = [];
  // reference = mean of the border ring
  let sr = 0, sg = 0, sb = 0, n = 0;
  const ring = (x: number, y: number): boolean => x < 4 || y < 4 || x >= w - 4 || y >= h - 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ring(x, y)) { const [r, g, b] = px(y * w + x); sr += r; sg += g; sb += b; n++; }
  const ref = [sr / n, sg / n, sb / n];
  const near = (i: number): boolean => { const [r, g, b] = px(i); return Math.abs(r - ref[0]!) + Math.abs(g - ref[1]!) + Math.abs(b - ref[2]!) <= drift * 1.5; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ring(x, y)) { const i = y * w + x; if (near(i)) { bg[i] = 1; queue.push(i); } }
  const diff = (a: number, b: number): number => Math.max(Math.abs(d[a * 4]! - d[b * 4]!), Math.abs(d[a * 4 + 1]! - d[b * 4 + 1]!), Math.abs(d[a * 4 + 2]! - d[b * 4 + 2]!));
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!, x = p % w, y = (p / w) | 0;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
      if (q < 0 || bg[q]) continue;
      if (diff(p, q) <= step && near(q)) { bg[q] = 1; queue.push(q); }
    }
  }
  // alpha: foreground = not bg; erode by `erode` px to drop the halo, then feather with a box blur
  let fg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) fg[i] = bg[i] ? 0 : 1;
  for (let e = 0; e < (opts.erode ?? 1); e++) {
    const nx = new Uint8Array(fg);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (fg[i] && (!fg[i - 1] || !fg[i + 1] || !fg[i - w] || !fg[i + w])) nx[i] = 0; }
    fg = nx;
  }
  const out = new Uint8Array(d);
  const f = opts.feather ?? 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let dy = -f; dy <= f; dy++) for (let dx = -f; dx <= f; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += fg[yy * w + xx]!; c++; } }
    out[(y * w + x) * 4 + 3] = Math.round((s / c) * 255 * (img.data[(y * w + x) * 4 + 3]! / 255));
  }
  return { width: w, height: h, data: out };
}

/**
 * Cuts a figure out of the grey studio backdrop the image model always draws. Rule: the backdrop is every LOW-SATURATION,
 * mid-brightness pixel that is connected to the image border through such pixels; the figure is whatever blocks that flood.
 * This works because the cast is dressed in saturated colours (a red jacket, navy trousers, tan boots), so no clothing
 * is grey, and dark hair/boots are darker than the backdrop and its floor shadow. Edges are eroded, defringed (darkened) and feathered.
 */
export function keyGreyBackdrop(img: Rgba, opts: { satMax?: number; lumMin?: number; lumMax?: number; erode?: number; feather?: number } = {}): Rgba {
  const { width: w, height: h } = img;
  const d = img.data;
  const satMax = opts.satMax ?? 34, lumMin = opts.lumMin ?? 62, lumMax = opts.lumMax ?? 252;
  const greyish = (i: number): boolean => {
    const r = d[i * 4]!, g = d[i * 4 + 1]!, b = d[i * 4 + 2]!;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), lum = 0.299 * r + 0.587 * g + 0.114 * b;
    return mx - mn <= satMax && lum >= lumMin && lum <= lumMax;
  };
  const bg = new Uint8Array(w * h);
  const q: number[] = [];
  const seed = (i: number): void => { if (!bg[i] && greyish(i)) { bg[i] = 1; q.push(i); } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  for (let qi = 0; qi < q.length; qi++) {
    const p = q[qi]!, x = p % w, y = (p / w) | 0;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (y > 0) seed(p - w);
    if (y < h - 1) seed(p + w);
  }
  let fg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) fg[i] = bg[i] ? 0 : 1;
  for (let e = 0; e < (opts.erode ?? 1); e++) {
    const nx = new Uint8Array(fg);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (fg[i] && (!fg[i - 1] || !fg[i + 1] || !fg[i - w] || !fg[i + w])) nx[i] = 0; }
    fg = nx;
  }
  const out = new Uint8Array(d);
  const f = opts.feather ?? 1;
  // defringe: the backdrop bleeds into the first pixels inside the silhouette; darken them so they do not glow against a dark scene
  const erodeOnce = (m: Uint8Array): Uint8Array => {
    const nx = new Uint8Array(m);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (m[i] && (!m[i - 1] || !m[i + 1] || !m[i - w] || !m[i + w])) nx[i] = 0; }
    return nx;
  };
  const e1 = erodeOnce(fg), e2 = erodeOnce(e1);
  for (let i = 0; i < w * h; i++) if (fg[i] && !e2[i]) {
    const k = e1[i] ? 0.8 : 0.58;
    out[i * 4] = Math.round(out[i * 4]! * k); out[i * 4 + 1] = Math.round(out[i * 4 + 1]! * k); out[i * 4 + 2] = Math.round(out[i * 4 + 2]! * k);
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let dy = -f; dy <= f; dy++) for (let dx = -f; dx <= f; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += fg[yy * w + xx]!; c++; } }
    out[(y * w + x) * 4 + 3] = Math.round((s / c) * 255);
  }
  return { width: w, height: h, data: out };
}

/**
 * Morphological closing of the alpha channel (dilate then erode with a square of radius `r`): fills the small notches a
 * light highlight can bite out of dark hair when keying. Newly opaque pixels take the average colour of the opaque pixels around them.
 */
export function closeAlpha(img: Rgba, r = 4): Rgba {
  const { width: w, height: h } = img;
  const a = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = img.data[i * 4 + 3]! > 127 ? 1 : 0;
  const sweep = (src: Uint8Array, grow: boolean): Uint8Array => {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let k = -r; k <= r; k++) { const xx = x + k; if (xx < 0 || xx >= w) { if (!grow) v = 0; continue; } const s = src[y * w + xx]!; if (grow ? s : !s) { v = grow ? 1 : 0; break; } }
      tmp[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let k = -r; k <= r; k++) { const yy = y + k; if (yy < 0 || yy >= h) { if (!grow) v = 0; continue; } const s = tmp[yy * w + x]!; if (grow ? s : !s) { v = grow ? 1 : 0; break; } }
      out[y * w + x] = v;
    }
    return out;
  };
  const closed = sweep(sweep(a, true), false);
  const out = new Uint8Array(img.data);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (closed[i] && !a[i]) {
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || !a[yy * w + xx]) continue;
        const j = (yy * w + xx) * 4; sr += out[j]!; sg += out[j + 1]!; sb += out[j + 2]!; n++;
      }
      if (n) { out[i * 4] = Math.round(sr / n); out[i * 4 + 1] = Math.round(sg / n); out[i * 4 + 2] = Math.round(sb / n); out[i * 4 + 3] = 255; }
    }
  }
  return { width: w, height: h, data: out };
}
