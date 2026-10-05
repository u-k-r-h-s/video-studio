import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { noise1 } from "./ease";
import type { EffectSpec } from "./types";

/** Small deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rgba = (hex: string, a: number): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1]!, 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
};

interface Drop { x: number; y: number; len: number; speed: number; w: number; a: number }

/** Procedural weather and atmosphere. Each effect is a pure function of time, so renders are deterministic. */
export class EffectPainter {
  private readonly cache = new Map<string, unknown>();
  constructor(private readonly W: number, private readonly H: number, private readonly seed = 1) {}

  private memo<T>(key: string, make: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, make());
    return this.cache.get(key) as T;
  }

  draw(g: SKRSContext2D, e: EffectSpec, t: number, project: (x: number, y: number) => { x: number; y: number }): void {
    const start = e.start ?? 0;
    if (t < start || (e.end !== undefined && t > e.end)) return;
    const fade = Math.min(1, (t - start) / 0.4) * (e.end !== undefined ? Math.min(1, (e.end - t) / 0.4) : 1);
    const k = (e.intensity ?? 0.6) * fade;
    switch (e.type) {
      case "rain": return this.rain(g, e, t, k);
      case "snow": return this.snow(g, e, t, k);
      case "leaves": return this.leaves(g, e, t, k);
      case "fog": return this.fog(g, e, t, k);
      case "dust": return this.dust(g, e, t, k);
      case "smoke": return this.smoke(g, e, t, k, project);
      case "lightFlicker": return this.lightFlicker(g, e, t, k, project);
      case "sparks": return this.sparks(g, e, t, k, project);
      case "streaks": return this.streaks(g, e, t, k);
    }
  }

  private rain(g: SKRSContext2D, e: EffectSpec, t: number, k: number): void {
    const { W, H } = this;
    const drops = this.memo<Drop[]>(`rain${e.seed ?? 0}`, () => {
      const r = prng(this.seed * 977 + (e.seed ?? 0));
      return Array.from({ length: 520 }, () => {
        const near = r() < 0.3;
        return { x: r() * (W + 800) - 400, y: r() * (H + 300), len: near ? 90 + r() * 90 : 34 + r() * 46, speed: near ? 2900 + r() * 900 : 1700 + r() * 600, w: near ? 2.6 + r() * 1.4 : 1.2 + r() * 0.8, a: near ? 0.34 : 0.2 };
      });
    });
    const ang = ((e.angle ?? 12) * Math.PI) / 180, dx = Math.sin(ang), dy = Math.cos(ang);
    const sp = e.speed ?? 1;
    g.save();
    g.lineCap = "round";
    const count = Math.round(drops.length * Math.min(1, k * 1.2));
    for (let i = 0; i < count; i++) {
      const d = drops[i]!;
      const travel = d.speed * sp * t;
      const y = ((d.y + travel * dy) % (H + 300 + d.len)) - d.len;
      const x = d.x + (y - d.y) * (dx / dy) - (W * 0.0);
      g.strokeStyle = rgba(e.color ?? "#bcd4ff", d.a * Math.min(1, k + 0.2));
      g.lineWidth = d.w;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x - dx * d.len, y - dy * d.len);
      g.stroke();
    }
    g.restore();
  }

  private snow(g: SKRSContext2D, e: EffectSpec, t: number, k: number): void {
    const { W, H } = this;
    const flakes = this.memo(`snow${e.seed ?? 0}`, () => {
      const r = prng(this.seed * 313 + (e.seed ?? 0));
      return Array.from({ length: 220 }, () => ({ x: r() * W, y: r() * H, s: 2 + r() * 5, v: 60 + r() * 140, ph: r() * 6.28, sw: 20 + r() * 50 }));
    });
    g.save();
    const n = Math.round(flakes.length * Math.min(1, k * 1.3));
    for (let i = 0; i < n; i++) {
      const f = flakes[i]!;
      const y = (f.y + f.v * (e.speed ?? 1) * t) % (H + 20);
      const x = f.x + Math.sin(t * 0.9 + f.ph) * f.sw + ((e.angle ?? 0) / 45) * y * 0.3;
      g.fillStyle = rgba(e.color ?? "#ffffff", 0.55 * Math.min(1, k + 0.2));
      g.beginPath();
      g.arc(((x % W) + W) % W, y, f.s, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  private leaves(g: SKRSContext2D, e: EffectSpec, t: number, k: number): void {
    const { W, H } = this;
    const leaves = this.memo(`leaf${e.seed ?? 0}`, () => {
      const r = prng(this.seed * 71 + (e.seed ?? 0));
      return Array.from({ length: 28 }, () => ({ x: r() * W, y: r() * H, s: 10 + r() * 16, v: 90 + r() * 120, ph: r() * 6.28, rot: r() * 6.28, spin: 1 + r() * 3, hue: r() }));
    });
    g.save();
    const n = Math.round(leaves.length * Math.min(1, k * 1.5));
    for (let i = 0; i < n; i++) {
      const l = leaves[i]!;
      const y = (l.y + l.v * t) % (H + 40) - 20;
      const x = ((l.x + Math.sin(t * 1.3 + l.ph) * 90 + t * 60) % (W + 80) + W + 80) % (W + 80) - 40;
      g.translate(x, y);
      g.rotate(l.rot + t * l.spin);
      g.fillStyle = l.hue < 0.5 ? "rgba(168,98,38,0.85)" : "rgba(122,86,30,0.85)";
      g.beginPath();
      g.ellipse(0, 0, l.s, l.s * 0.45, 0, 0, Math.PI * 2);
      g.fill();
      g.setTransform(1, 0, 0, 1, 0, 0);
    }
    g.restore();
  }

  private fogTexture(color: string): Canvas {
    return this.memo(`fogtex${color}`, () => {
      const c = createCanvas(2048, 700), x = c.getContext("2d"), r = prng(this.seed * 5 + 3);
      for (let i = 0; i < 26; i++) {
        const cx = r() * 2048, cy = 120 + r() * 460, rad = 140 + r() * 260;
        for (const ox of [-2048, 0, 2048]) {
          const gr = x.createRadialGradient(cx + ox, cy, 0, cx + ox, cy, rad);
          gr.addColorStop(0, rgba(color, 0.2 + r() * 0.12));
          gr.addColorStop(1, rgba(color, 0));
          x.fillStyle = gr;
          x.fillRect(cx + ox - rad, cy - rad, rad * 2, rad * 2);
        }
      }
      // fade the texture out toward its top and bottom so no hard edge of the strip ever shows
      x.globalCompositeOperation = "destination-in";
      const vg = x.createLinearGradient(0, 0, 0, 700);
      vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(0.28, "rgba(0,0,0,1)"); vg.addColorStop(0.72, "rgba(0,0,0,1)"); vg.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = vg; x.fillRect(0, 0, 2048, 700);
      return c;
    });
  }

  private fog(g: SKRSContext2D, e: EffectSpec, t: number, k: number): void {
    const tex = this.fogTexture(e.color ?? "#8aa0c0");
    const { W, H } = this;
    const sp = (e.speed ?? 1) * 38;
    g.save();
    g.globalCompositeOperation = "screen";
    for (const [layer, dir, scale, yOff, alpha] of [[0, 1, 1.0, 0.52, 0.8], [1, -1, 1.5, 0.66, 0.6]] as const) {
      const h = tex.height * scale * (W / 1080), w = tex.width * scale * (W / 1080);
      const x0 = (((t * sp * dir * (1 + layer * 0.6)) % w) + w) % w;
      g.globalAlpha = Math.min(1, k) * alpha;
      for (let x = -x0; x < W; x += w) g.drawImage(tex, x, H * yOff - h / 2 + Math.sin(t * 0.3 + layer) * 14, w, h);
    }
    g.restore();
  }

  private dust(g: SKRSContext2D, e: EffectSpec, t: number, k: number): void {
    const { W, H } = this;
    const motes = this.memo(`dust${e.seed ?? 0}`, () => {
      const r = prng(this.seed * 131 + (e.seed ?? 0));
      return Array.from({ length: 70 }, () => ({ x: r() * W, y: r() * H, s: 1.5 + r() * 3.5, vx: -12 + r() * 24, vy: -18 + r() * 14, ph: r() * 6.28 }));
    });
    g.save();
    g.globalCompositeOperation = "screen";
    const n = Math.round(motes.length * Math.min(1, k * 1.3));
    for (let i = 0; i < n; i++) {
      const m = motes[i]!;
      const x = (((m.x + m.vx * t + Math.sin(t * 0.7 + m.ph) * 25) % W) + W) % W, y = (((m.y + m.vy * t) % H) + H) % H;
      g.fillStyle = rgba(e.color ?? "#ffe9c4", (0.25 + 0.25 * Math.sin(t * 1.7 + m.ph)) * Math.min(1, k + 0.2));
      g.beginPath();
      g.arc(x, y, m.s, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  private smoke(g: SKRSContext2D, e: EffectSpec, t: number, k: number, project: (x: number, y: number) => { x: number; y: number }): void {
    const o = project(e.x ?? this.W / 2, e.y ?? this.H * 0.7);
    const R = (e.radius ?? 90) * 1;
    const puffs = this.memo(`smoke${e.seed ?? 0}`, () => { const r = prng(this.seed * 17 + (e.seed ?? 0)); return Array.from({ length: 14 }, () => ({ ph: r(), dx: -20 + r() * 40, s: 0.7 + r() * 0.8 })); });
    g.save();
    for (const p of puffs) {
      const life = ((t * 0.28 * (e.speed ?? 1) + p.ph) % 1);
      const y = o.y - life * R * 4.5, x = o.x + p.dx + Math.sin(life * 5 + p.ph * 6) * R * 0.5 * life;
      const rad = R * (0.4 + life * 1.5) * p.s;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      const a = (1 - life) * Math.min(0.5, life * 3) * 0.55 * Math.min(1, k + 0.2);
      gr.addColorStop(0, rgba(e.color ?? "#9aa4b3", a));
      gr.addColorStop(1, rgba(e.color ?? "#9aa4b3", 0));
      g.fillStyle = gr;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    g.restore();
  }

  private lightFlicker(g: SKRSContext2D, e: EffectSpec, t: number, k: number, project: (x: number, y: number) => { x: number; y: number }): void {
    const o = project(e.x ?? this.W / 2, e.y ?? this.H * 0.3);
    const rad = e.radius ?? 520;
    const n = noise1(t * (e.speed ?? 1) * 3.1, e.seed ?? 4);
    const gate = n > 0.35 ? 0.25 : n > -0.1 ? 1 : 0.6; // sputters like a failing tube
    const a = 0.5 * Math.min(1, k + 0.15) * gate;
    g.save();
    g.globalCompositeOperation = "screen";
    const gr = g.createRadialGradient(o.x, o.y, 0, o.x, o.y, rad);
    gr.addColorStop(0, rgba(e.color ?? "#ffd9a0", a));
    gr.addColorStop(0.45, rgba(e.color ?? "#ffd9a0", a * 0.3));
    gr.addColorStop(1, rgba(e.color ?? "#ffd9a0", 0));
    g.fillStyle = gr;
    g.fillRect(o.x - rad, o.y - rad, rad * 2, rad * 2);
    g.restore();
  }

  private sparks(g: SKRSContext2D, e: EffectSpec, t: number, k: number, project: (x: number, y: number) => { x: number; y: number }): void {
    const o = project(e.x ?? this.W / 2, e.y ?? this.H * 0.6);
    const r = prng(this.seed * 7 + (e.seed ?? 0));
    const local = t - (e.start ?? 0);
    g.save();
    g.globalCompositeOperation = "lighter";
    for (let i = 0; i < 46; i++) {
      const a = r() * Math.PI * 2, v = 250 + r() * 700, life = 0.35 + r() * 0.5;
      if (local < 0 || local > life) continue;
      const x = o.x + Math.cos(a) * v * local, y = o.y + Math.sin(a) * v * local + 900 * local * local;
      g.strokeStyle = rgba(e.color ?? "#ffcf7a", (1 - local / life) * Math.min(1, k + 0.3));
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x - Math.cos(a) * 26, y - Math.sin(a) * 26);
      g.stroke();
    }
    g.restore();
  }

  /** Horizontal speed lines for running shots. */
  private streaks(g: SKRSContext2D, e: EffectSpec, t: number, k: number): void {
    const { W, H } = this;
    const lines = this.memo(`streak${e.seed ?? 0}`, () => { const r = prng(this.seed * 29 + (e.seed ?? 0)); return Array.from({ length: 26 }, () => ({ y: r() * H, len: 220 + r() * 420, v: 2400 + r() * 2200, ph: r() * W, w: 1 + r() * 2.2 })); });
    g.save();
    g.globalCompositeOperation = "screen";
    for (const l of lines) {
      const x = W + l.len - ((l.ph + l.v * t * (e.speed ?? 1)) % (W + l.len * 2));
      g.strokeStyle = rgba(e.color ?? "#cfe0ff", 0.18 * Math.min(1, k + 0.2));
      g.lineWidth = l.w;
      g.beginPath();
      g.moveTo(x, l.y);
      g.lineTo(x + l.len, l.y);
      g.stroke();
    }
    g.restore();
  }
}
