/** Seeded value noise / fBm for procedural terrain and placement. Deterministic for a seed; no allocations per call. */
export function mulberry(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export class Noise2D {
  private readonly p = new Uint8Array(512);
  private readonly g: Float32Array;
  constructor(seed: number) {
    const r = mulberry(seed), perm = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j]!, perm[i]!]; }
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255]!;
    this.g = new Float32Array(256).map(() => r() * 2 - 1);
  }
  /** Smooth value noise in [-1, 1]. */
  at(x: number, y: number): number {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const P = this.p, G = this.g, X = xi & 255, Y = yi & 255;
    const a = G[P[P[X]! + Y]!]!, b = G[P[P[X + 1]! + Y]!]!, c = G[P[P[X]! + Y + 1]!]!, d = G[P[P[X + 1]! + Y + 1]!]!;
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  /** Fractal sum, roughly in [-1, 1]. */
  fbm(x: number, y: number, octaves = 5, lac = 2.03, gain = 0.5): number {
    let s = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < octaves; i++) { s += amp * this.at(x * f, y * f); norm += amp; amp *= gain; f *= lac; }
    return s / norm;
  }
  /** Ridged fBm in [0, 1]: sharp crests (mountain ridges). */
  ridged(x: number, y: number, octaves = 6): number {
    let s = 0, amp = 0.5, f = 1, norm = 0, w = 1;
    for (let i = 0; i < octaves; i++) { let n = 1 - Math.abs(this.at(x * f, y * f)); n *= n * w; w = Math.min(1, n * 2); s += amp * n; norm += amp; amp *= 0.5; f *= 2.07; }
    return s / norm;
  }
}

export const smoothstep = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
