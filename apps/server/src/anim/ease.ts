export type Easing = "linear" | "in" | "out" | "inOut" | "outBack" | "outElastic" | "hold";
const c1 = 1.70158, c3 = c1 + 1;
export function ease(kind: Easing, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  switch (kind) {
    case "linear": return x;
    case "in": return x * x;
    case "out": return 1 - (1 - x) * (1 - x);
    case "inOut": return x * x * (3 - 2 * x);
    case "outBack": return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    case "outElastic": return x === 0 || x === 1 ? x : Math.pow(2, -10 * x) * Math.sin(((x * 10 - 0.75) * (2 * Math.PI)) / 3) + 1;
    case "hold": return x < 1 ? 0 : 1;
  }
}

/** A numeric property over time: keyframes with the easing used to ARRIVE at each key. Values hold before the first and after the last. */
export class Track {
  private keys: { t: number; v: number; e: Easing }[] = [];
  constructor(private initial: number) {}
  /** Changes the value held before the first keyframe (e.g. an entrance starts off screen). */
  setInitial(v: number): this { this.initial = v; return this; }

  at(t: number): number {
    const k = this.keys;
    if (!k.length || t <= k[0]!.t) return k.length && t >= k[0]!.t ? k[0]!.v : this.initial;
    for (let i = 1; i < k.length; i++) {
      if (t <= k[i]!.t) {
        const a = k[i - 1]!, b = k[i]!;
        const span = b.t - a.t;
        return span <= 1e-9 ? b.v : a.v + (b.v - a.v) * ease(b.e, (t - a.t) / span);
      }
    }
    return k[k.length - 1]!.v;
  }

  /** Move from the value AT `start` to `value` over `duration`. Events must be added in start order per track. */
  moveTo(start: number, duration: number, value: number, e: Easing = "inOut"): this {
    const v0 = this.at(start);
    this.put(start, v0, "linear");
    this.put(start + Math.max(1e-6, duration), value, e);
    return this;
  }
  set(t: number, value: number): this { return this.put(t, value, "linear"); }

  private put(t: number, v: number, e: Easing): this {
    const i = this.keys.findIndex((k) => Math.abs(k.t - t) < 1e-9);
    if (i >= 0) this.keys[i] = { t, v, e };
    else { this.keys.push({ t, v, e }); this.keys.sort((a, b) => a.t - b.t); }
    return this;
  }
}

/** Bump-shaped envelope: ramps in over `inT`, holds, ramps out over `outT`, inside [0, dur]. 0 outside. */
export function envelope(local: number, dur: number, inT = 0.12, outT = 0.15): number {
  if (local < 0 || local > dur) return 0;
  const a = inT > 0 ? Math.min(1, local / inT) : 1;
  const b = outT > 0 ? Math.min(1, (dur - local) / outT) : 1;
  return ease("inOut", Math.min(a, b));
}

/** Deterministic smooth noise in [-1, 1] (sum of sines with seed-derived phases). */
export function noise1(t: number, seed = 0): number {
  const s = seed * 12.9898;
  return (Math.sin(t * 7.13 + s) * 0.5 + Math.sin(t * 13.7 + s * 1.7) * 0.3 + Math.sin(t * 29.3 + s * 2.3) * 0.2);
}
