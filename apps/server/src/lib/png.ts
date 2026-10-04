import zlib from "node:zlib";

/** Minimal dependency-free PNG toolkit (8-bit RGB/RGBA, non-interlaced) for cut-out preparation. */
export interface Rgba {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buf: Buffer): Rgba {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); bitDepth = body[8]!; colorType = body[9]!; interlace = body[12]!;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}); need 8-bit RGB/RGBA, non-interlaced`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error("PNG pixel data is truncated");
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]!;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0, b = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0;
      let v = row[i]!;
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (ft !== 0) throw new Error(`bad PNG filter type ${ft}`);
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = cur[x * bpp]!; out[o + 1] = cur[x * bpp + 1]!; out[o + 2] = cur[x * bpp + 2]!; out[o + 3] = bpp === 4 ? cur[x * bpp + 3]! : 255;
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Buffer): number => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng(img: Rgba): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0); ihdr.writeUInt32BE(img.height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) { raw[y * (stride + 1)] = 0; Buffer.from(img.data.buffer, img.data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1); }
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Median colour of the outer border: the flat background colour a generated cut-out was drawn on. */
export function sampleBorderColor(img: Rgba, border = 8): [number, number, number] {
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (x >= border && x < img.width - border && y >= border && y < img.height - border) { x = img.width - border - 1; continue; }
      const o = (y * img.width + x) * 4; rs.push(img.data[o]!); gs.push(img.data[o + 1]!); bs.push(img.data[o + 2]!);
    }
  }
  const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1]!;
  return [med(rs), med(gs), med(bs)];
}

function opaqueBox(alpha: Uint8Array, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } | undefined {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x]! > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? undefined : { x0, y0, x1, y1 };
}

/**
 * Turns an image drawn on a plain/gradient background (or inside a poster frame) into a transparent cut-out.
 *
 * Background = the region CONNECTED to the image border that changes smoothly: starting from border pixels that
 * look like the background, a pixel joins the region when its colour differs from its already-accepted neighbour
 * by less than `delta`. That follows gradients and vignettes but stops at the figure's outline. Unlike a global
 * colour key it never deletes background-coloured parts INSIDE the figure (a white face, a hand).
 * If an opaque panel still spans most of the image (poster frame; >= 75% in both dimensions, which a standing
 * figure never does), the grow is repeated from that panel's edge, up to 8 times. Finally the alpha edge is softened.
 */
export function keyOutBackground(img: Rgba, delta = 22, maxDrift = 70): Rgba {
  const { width: w, height: h } = img;
  const alpha = new Uint8Array(w * h).fill(255);
  const px = (i: number, k: number) => img.data[i * 4 + k]!;
  const dist = (i: number, j: number) => Math.hypot(px(i, 0) - px(j, 0), px(i, 1) - px(j, 1), px(i, 2) - px(j, 2));

  /**
   * Region-grow transparency from seeds that resemble the median colour of the seed set. A pixel joins when it is
   * within `delta` of its accepted neighbour (follows gradients) AND within `drift` of the seed colour (cannot leak
   * through a blurry outline into a differently coloured interior).
   */
  const grow = (seedIdx: number[], drift: number): number => {
    if (seedIdx.length === 0) return 0;
    const med = (k: number) => seedIdx.map((i) => px(i, k)).sort((a, b) => a - b)[seedIdx.length >> 1]!;
    const [mr, mg, mb] = [med(0), med(1), med(2)];
    const close = (i: number) => Math.hypot(px(i, 0) - mr, px(i, 1) - mg, px(i, 2) - mb) < delta * 3;
    const nearSeed = (i: number) => Math.hypot(px(i, 0) - mr, px(i, 1) - mg, px(i, 2) - mb) < drift;
    const stack: number[] = [];
    for (const i of seedIdx) if (alpha[i] !== 0 && close(i)) { alpha[i] = 0; stack.push(i); }
    let n = stack.length;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && alpha[j] !== 0 && dist(i, j) < delta && nearSeed(j)) { alpha[j] = 0; stack.push(j); n++; }
      }
    }
    return n;
  };

  const ring: number[] = [];
  for (let x = 0; x < w; x++) ring.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) ring.push(y * w, y * w + w - 1);
  grow(ring, maxDrift);

  for (let pass = 0; pass < 8; pass++) {
    const box = opaqueBox(alpha, w, h);
    if (!box || box.x1 - box.x0 + 1 < 0.75 * w || box.y1 - box.y0 + 1 < 0.75 * h) break;
    const seeds: number[] = [];
    for (let x = box.x0; x <= box.x1; x++) seeds.push(box.y0 * w + x, box.y1 * w + x);
    for (let y = box.y0; y <= box.y1; y++) seeds.push(y * w + box.x0, y * w + box.x1);
    const live = seeds.filter((i) => alpha[i] !== 0);
    if (live.length === 0) break;
    // A real frame/panel has a homogeneous edge. If the edge is mixed, it runs through the figure itself: stop.
    const med = (k: number) => live.map((i) => px(i, k)).sort((a, b) => a - b)[live.length >> 1]!;
    const [mr, mg, mb] = [med(0), med(1), med(2)];
    const homogeneous = live.filter((i) => Math.hypot(px(i, 0) - mr, px(i, 1) - mg, px(i, 2) - mb) < delta * 2).length / live.length;
    if (homogeneous < 0.85) break;
    if (grow(live, maxDrift * 0.6) === 0) break;
  }

  const out = new Uint8Array(img.data);
  const soft = new Uint8Array(alpha.length); // 3x3 box blur: soft edge without a halo of hard pixels
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) { sum += alpha[yy * w + xx]!; n++; }
    }
    soft[y * w + x] = Math.round(sum / n);
  }
  for (let i = 0; i < soft.length; i++) out[i * 4 + 3] = soft[i]!;
  return { width: w, height: h, data: out };
}

/** Crops to the bounding box of non-transparent pixels (plus a margin) so layout anchors the visible figure. */
export function cropToContent(img: Rgba, alphaThreshold = 20, margin = 4): Rgba {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4 + 3]! > alphaThreshold) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return img; // fully transparent: nothing to crop to
  x0 = Math.max(0, x0 - margin); y0 = Math.max(0, y0 - margin); x1 = Math.min(img.width - 1, x1 + margin); y1 = Math.min(img.height - 1, y1 + margin);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
  return { width: w, height: h, data };
}

export interface CutoutAssessment {
  ok: boolean;
  /** Human-readable reason when not ok. */
  reason?: string;
  opaqueFraction: number;
  /** Width of the visible content as a fraction of the image width. */
  widthFraction: number;
}

/**
 * Quality check of a keyed cut-out (before cropping). Catches the typical failures of small image models:
 * a poster/panel that still fills the image (character too wide), nothing left, or (almost) nothing removed.
 */
export function assessCutout(keyed: Rgba, kind: "character" | "prop"): CutoutAssessment {
  const n = keyed.width * keyed.height;
  let opaque = 0, x0 = keyed.width, x1 = -1;
  for (let y = 0; y < keyed.height; y++) for (let x = 0; x < keyed.width; x++) {
    if (keyed.data[(y * keyed.width + x) * 4 + 3]! > 20) { opaque++; if (x < x0) x0 = x; if (x > x1) x1 = x; }
  }
  const opaqueFraction = opaque / n;
  const widthFraction = x1 < 0 ? 0 : (x1 - x0 + 1) / keyed.width;
  const base = { opaqueFraction, widthFraction };
  if (opaqueFraction < 0.04) return { ok: false, reason: "almost nothing is left after removing the background", ...base };
  if (kind === "character") {
    if (widthFraction > 0.8) return { ok: false, reason: "the background/frame could not be separated (the figure spans the whole width)", ...base };
    if (opaqueFraction > 0.6) return { ok: false, reason: "too much of the image is still opaque", ...base };
  } else if (opaqueFraction > 0.9) {
    return { ok: false, reason: "the background could not be separated", ...base };
  }
  return { ok: true, ...base };
}
