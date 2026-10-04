/**
 * A tiny deterministic audio synthesizer (no samples, no model): sound effects, ambience and a music bed built from
 * oscillators, filtered noise and envelopes. Everything is mono Float32 at 44.1 kHz in [-1, 1].
 * Same inputs -> bit-identical output, so generated audio can be cached by hash.
 */
export const SR = 44100;
export type Buf = Float32Array;

/** Small seeded PRNG (mulberry32): "noise" is repeatable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const n = (sec: number) => Math.max(1, Math.round(sec * SR));
const TAU = Math.PI * 2;

export const whiteNoise = (sec: number, seed = 1): Buf => {
  const r = rng(seed), b = new Float32Array(n(sec));
  for (let i = 0; i < b.length; i++) b[i] = r() * 2 - 1;
  return b;
};

/** One-pole low-pass with a per-sample cutoff (Hz): cutoff(t) with t in seconds. */
export function lowpass(x: Buf, cutoff: number | ((t: number) => number)): Buf {
  const y = new Float32Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    const fc = typeof cutoff === "number" ? cutoff : cutoff(i / SR);
    const a = 1 - Math.exp((-TAU * Math.max(5, fc)) / SR);
    s += a * (x[i]! - s);
    y[i] = s;
  }
  return y;
}
export function highpass(x: Buf, cutoff: number | ((t: number) => number)): Buf {
  const lp = lowpass(x, cutoff);
  return x.map((v, i) => v - lp[i]!) as Buf;
}
/** Band-pass = high-pass then low-pass. */
export const bandpass = (x: Buf, lo: number | ((t: number) => number), hi: number | ((t: number) => number)): Buf => lowpass(highpass(x, lo), hi);

const sec = (b: Buf) => b.length / SR;
export function mul(x: Buf, f: (t: number) => number): Buf {
  return x.map((v, i) => v * f(i / SR)) as Buf;
}
export function add(...bufs: Buf[]): Buf {
  const len = Math.max(...bufs.map((b) => b.length));
  const o = new Float32Array(len);
  for (const b of bufs) for (let i = 0; i < b.length; i++) o[i]! += b[i]!;
  return o;
}
/** Shift a buffer later by `sec` seconds (prepends silence). */
export function delay(x: Buf, s: number): Buf {
  const o = new Float32Array(x.length + n(s));
  o.set(x, n(s));
  return o;
}
export const gain = (x: Buf, g: number): Buf => x.map((v) => v * g) as Buf;
export const decay = (t: number, tau: number): number => Math.exp(-t / tau);
const attack = (t: number, a: number): number => Math.min(1, t / a);

/** Normalise to a target peak (default about -3 dBFS). */
export function normalize(x: Buf, peak = 0.7): Buf {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  return m === 0 ? x : (x.map((v) => (v / m) * peak) as Buf);
}

/** Simple feedback-comb "room": adds a short tail so effects do not sound dry. */
export function room(x: Buf, tail = 0.35, mix = 0.25): Buf {
  const out = new Float32Array(x.length + n(tail));
  out.set(x);
  for (const [d, g] of [[0.029, 0.42], [0.043, 0.32], [0.061, 0.24]] as const) {
    const k = n(d);
    for (let i = 0; i + k < out.length; i++) out[i + k]! += out[i]! * g * mix * 2;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Sound effects
// ---------------------------------------------------------------------------------------------------------------

/** Air whoosh: band-passed noise whose centre frequency sweeps (rising = approaching, falling = passing away). */
export function whoosh(dur = 0.6, rising = true, seed = 7): Buf {
  const noise = whiteNoise(dur, seed);
  const f = (t: number) => (rising ? 300 + 5200 * Math.pow(t / dur, 2) : 5500 - 5000 * Math.pow(t / dur, 0.6));
  const shaped = bandpass(noise, (t) => f(t) * 0.6, (t) => f(t) * 1.5);
  return normalize(mul(shaped, (t) => Math.sin(Math.PI * Math.min(1, t / dur)) ** 1.5), 0.8);
}

/** Cinematic impact: sub-bass drop plus a noise crack. */
export function impact(dur = 1.2, seed = 11): Buf {
  const len = n(dur);
  const boom = new Float32Array(len);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = 38 + 90 * Math.exp(-t * 14);
    ph += (TAU * f) / SR;
    boom[i] = Math.sin(ph) * decay(t, 0.38) * attack(t, 0.002);
  }
  const crack = mul(lowpass(whiteNoise(dur, seed), 3500), (t) => decay(t, 0.05));
  return room(normalize(add(boom, gain(crack, 0.45)), 0.9), 0.4, 0.2);
}

/** Phone notification: two quick bell tones. */
export function ping(seed = 3): Buf {
  void seed;
  const tone = (f: number, d: number) => {
    const b = new Float32Array(n(d));
    for (let i = 0; i < b.length; i++) {
      const t = i / SR;
      b[i] = (Math.sin(TAU * f * t) + 0.35 * Math.sin(TAU * f * 2.01 * t)) * decay(t, 0.09) * attack(t, 0.002);
    }
    return b;
  };
  return normalize(room(add(tone(1318.5, 0.5), delay(tone(1760, 0.6), 0.13)), 0.3, 0.2), 0.6);
}

/** Old elevator "ding": bell with inharmonic partials and a long decay. */
export function elevatorDing(): Buf {
  const len = n(1.8);
  const b = new Float32Array(len);
  const partials: [number, number, number][] = [[1046.5, 1, 0.55], [2093, 0.5, 0.35], [2790, 0.3, 0.22], [4180, 0.15, 0.12]];
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let v = 0;
    for (const [f, a, tau] of partials) v += Math.sin(TAU * f * t) * a * decay(t, tau);
    b[i] = v * attack(t, 0.001);
  }
  return normalize(room(b, 0.5, 0.25), 0.6);
}

/** Heavy mechanical slide (doors opening): filtered noise with a rumble and a stuttering amplitude. */
export function doorSlide(dur = 1.6, seed = 21): Buf {
  const noise = lowpass(whiteNoise(dur, seed), (t) => 500 + 900 * Math.sin((Math.PI * t) / dur));
  const rumble = new Float32Array(n(dur));
  for (let i = 0; i < rumble.length; i++) rumble[i] = Math.sin(TAU * (48 + 10 * Math.sin(i / SR * 3)) * (i / SR));
  const env = (t: number) => Math.sin((Math.PI * t) / dur) * (0.75 + 0.25 * Math.sin(t * 37));
  return normalize(mul(add(noise, gain(rumble, 0.5)), env), 0.7);
}

/** Footsteps on hard floor: a low thud + a short noise click per step. */
export function footsteps(count = 4, interval = 0.5, seed = 5): Buf {
  const r = rng(seed);
  const out = new Float32Array(n(count * interval + 0.3));
  for (let k = 0; k < count; k++) {
    const len = n(0.18), step = new Float32Array(len);
    const noise = lowpass(whiteNoise(0.18, Math.floor(r() * 1e6)), 1800);
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      step[i] = (Math.sin(TAU * 95 * t) * decay(t, 0.05) + noise[i]! * 0.8 * decay(t, 0.02)) * (0.8 + 0.2 * r());
    }
    const start = n(k * interval + (r() - 0.5) * 0.03);
    for (let i = 0; i < len && start + i < out.length; i++) out[start + i]! += step[i]!;
  }
  return normalize(out, 0.6);
}

/** Heartbeat: "lub-dub" thumps. */
export function heartbeat(beats = 4, bpm = 70): Buf {
  const period = 60 / bpm;
  const out = new Float32Array(n(beats * period + 0.3));
  const thump = (amp: number) => {
    const b = new Float32Array(n(0.25));
    for (let i = 0; i < b.length; i++) { const t = i / SR; b[i] = Math.sin(TAU * (55 - 25 * t) * t) * decay(t, 0.07) * amp; }
    return b;
  };
  for (let k = 0; k < beats; k++) {
    for (const [off, a] of [[0, 1], [0.22, 0.7]] as const) {
      const t = thump(a), s = n(k * period + off);
      for (let i = 0; i < t.length && s + i < out.length; i++) out[s + i]! += t[i]!;
    }
  }
  return normalize(out, 0.7);
}

/** Tension riser: rising filtered noise and a rising sine, ends abruptly. */
export function riser(dur = 2, seed = 9): Buf {
  const noise = bandpass(whiteNoise(dur, seed), (t) => 200 + 3000 * (t / dur) ** 2, (t) => 600 + 7000 * (t / dur) ** 2);
  const tone = new Float32Array(n(dur));
  let ph = 0;
  for (let i = 0; i < tone.length; i++) { const t = i / SR; ph += (TAU * (110 + 700 * (t / dur) ** 2)) / SR; tone[i] = Math.sin(ph) * 0.4; }
  return normalize(mul(add(noise, tone), (t) => (t / dur) ** 1.6), 0.7);
}

/** Low static / glitch burst (phone glitch, light flicker). */
export function glitch(dur = 0.35, seed = 13): Buf {
  const r = rng(seed);
  const b = new Float32Array(n(dur));
  let hold = 0, v = 0;
  for (let i = 0; i < b.length; i++) {
    if (--hold <= 0) { hold = 20 + Math.floor(r() * 220); v = (r() * 2 - 1) * (r() < 0.3 ? 1 : 0.35); }
    b[i] = v * (i / b.length > 0.85 ? 1 - (i / b.length - 0.85) / 0.15 : 1);
  }
  return normalize(highpass(b, 300), 0.55);
}

// ---------------------------------------------------------------------------------------------------------------
// Ambience and music
// ---------------------------------------------------------------------------------------------------------------

/** Night ambience: wind-like filtered noise, a faint hum, and slow swells. */
export function ambientNight(dur: number, seed = 31): Buf {
  const wind = lowpass(whiteNoise(dur, seed), (t) => 350 + 250 * Math.sin(t * 0.6) + 120 * Math.sin(t * 1.7));
  const hum = new Float32Array(n(dur));
  for (let i = 0; i < hum.length; i++) { const t = i / SR; hum[i] = Math.sin(TAU * 50 * t) * 0.12 + Math.sin(TAU * 100 * t) * 0.05; }
  return normalize(mul(add(gain(wind, 1.0), hum), (t) => (0.75 + 0.25 * Math.sin(t * 0.45)) * attack(t, 0.5) * Math.min(1, (dur - t) / 0.5)), 0.5);
}

/**
 * Dark tension bed: slow detuned pad on a minor chord, a soft pulse that speeds up, and a rising filter.
 * `intensity(t)` in 0..1 can shape it over time (default: builds across the clip).
 */
export function tensionBed(dur: number, intensity?: (t: number) => number): Buf {
  const I = intensity ?? ((t: number) => 0.25 + 0.75 * (t / dur) ** 1.4);
  const len = n(dur), pad = new Float32Array(len), pulse = new Float32Array(len);
  const notes = [55, 65.41, 82.41, 110]; // A1 C2 E2 A2: a dark minor tonic
  let ph = notes.map(() => 0), pph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let v = 0;
    notes.forEach((f, k) => {
      ph[k]! += (TAU * f * (1 + 0.003 * Math.sin(t * (0.3 + k * 0.17)))) / SR;
      v += Math.sin(ph[k]!) + 0.4 * Math.sin(ph[k]! * 2);
    });
    pad[i] = (v / notes.length) * (0.6 + 0.4 * Math.sin(t * 0.35));
    const rate = 1.1 + 2.4 * I(t); // pulse accelerates with intensity
    pph += (TAU * rate) / SR;
    const gate = Math.max(0, Math.sin(pph)) ** 6;
    pulse[i] = Math.sin(TAU * 55 * t) * gate * 0.7;
  }
  const bright = lowpass(pad, (t) => 180 + 1200 * I(t));
  const mix = add(gain(bright, 0.9), pulse.map((v, i) => v * (0.2 + 0.8 * I(i / SR))) as Buf);
  return normalize(mul(mix, (t) => attack(t, 1.0) * Math.min(1, (dur - t) / 0.6)), 0.5);
}
