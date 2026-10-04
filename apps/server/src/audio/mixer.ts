import type { Wav } from "../lib/wav";
import { SR, type Buf } from "./synth";

export type TrackType = "voice" | "music" | "sfx" | "ambient";

/** One audio element on the timeline. `samples` are mono 44.1 kHz floats. */
export interface MixTrack {
  type: TrackType;
  samples: Buf;
  startTime: number;
  /** Optional hard length cap (s). */
  duration?: number;
  volume: number;
  /** Optional fade in/out (s). */
  fadeIn?: number;
  fadeOut?: number;
}

/** Linear-interpolation resample of an Int16 mono WAV to 44.1 kHz floats. */
export function toFloat44k(w: Wav): Buf {
  const ratio = w.sampleRate / SR;
  const out = new Float32Array(Math.floor(w.samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const p = i * ratio, k = Math.floor(p), f = p - k;
    out[i] = ((w.samples[k] ?? 0) * (1 - f) + (w.samples[k + 1] ?? 0) * f) / 32768;
  }
  return out;
}

/** Smoothed RMS activity (0..1) of a signal in 20 ms windows: used to duck music under speech. */
export function activity(x: Buf, totalSec: number, hop = 0.02): Float32Array {
  const len = Math.ceil(totalSec / hop), out = new Float32Array(len), w = Math.round(hop * SR);
  for (let k = 0; k < len; k++) {
    let s = 0;
    const a = k * w;
    for (let i = a; i < Math.min(x.length, a + w); i++) s += x[i]! * x[i]!;
    out[k] = Math.min(1, Math.sqrt(s / w) * 6);
  }
  return out;
}

export interface MixOptions {
  totalSec: number;
  /** How much music/ambience is lowered while speech is active (0..1). Default 0.55. */
  duck?: number;
  /** Final peak target. Default 0.89 (about -1 dBFS). */
  peak?: number;
}

/**
 * Mixes tracks on a shared timeline. Music and ambient tracks are ducked under the voice with a smooth envelope.
 * Returns mono floats; the caller encodes (and may upmix) for delivery.
 */
export function mixTracks(tracks: MixTrack[], opts: MixOptions): Buf {
  const total = Math.round(opts.totalSec * SR);
  const out = new Float32Array(total);
  const voice = new Float32Array(total);
  for (const t of tracks.filter((x) => x.type === "voice")) place(voice, t);
  const act = activity(voice, opts.totalSec);
  const duck = opts.duck ?? 0.55;
  // smooth the ducking gain (fast attack, slower release)
  const gains = new Float32Array(act.length);
  let g = 1;
  for (let k = 0; k < act.length; k++) {
    const target = 1 - duck * Math.min(1, act[k]! * 1.5);
    g += (target - g) * (target < g ? 0.35 : 0.06);
    gains[k] = g;
  }
  const hop = Math.round(0.02 * SR);
  for (let i = 0; i < total; i++) out[i] = voice[i]!;
  for (const t of tracks.filter((x) => x.type !== "voice")) {
    const layer = new Float32Array(total);
    place(layer, t);
    const duckable = t.type === "music" || t.type === "ambient";
    for (let i = 0; i < total; i++) out[i]! += layer[i]! * (duckable ? gains[Math.min(gains.length - 1, Math.floor(i / hop))]! : 1);
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const target = opts.peak ?? 0.89;
  if (peak > target) for (let i = 0; i < total; i++) out[i]! *= target / peak; // only ever attenuate: never boost quiet mixes
  return out;
}

function place(dst: Float32Array, t: MixTrack): void {
  const start = Math.round(t.startTime * SR);
  const maxLen = t.duration !== undefined ? Math.round(t.duration * SR) : t.samples.length;
  const len = Math.min(t.samples.length, maxLen);
  const fi = Math.round((t.fadeIn ?? 0) * SR), fo = Math.round((t.fadeOut ?? 0) * SR);
  for (let i = 0; i < len; i++) {
    const p = start + i;
    if (p < 0 || p >= dst.length) continue;
    let g = t.volume;
    if (fi && i < fi) g *= i / fi;
    if (fo && i > len - fo) g *= (len - i) / fo;
    dst[p]! += t.samples[i]! * g;
  }
}

/** Float mono -> Int16 WAV model (for writing with `encodeWav`). */
export function toWav(x: Buf): Wav {
  const s = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) s[i] = Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32767)));
  return { sampleRate: SR, samples: s };
}
