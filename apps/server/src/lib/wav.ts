/** Minimal dependency-free WAV (PCM16 mono) toolkit: parse, encode, trim silence, mix onto a timeline. */
export interface Wav {
  sampleRate: number;
  samples: Int16Array;
}

export function parseWav(buf: Buffer): Wav {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let pos = 12;
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | undefined;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before fmt chunk");
      if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels !== 1) throw new Error(`unsupported WAV (need PCM16 mono, got format=${fmt.format} bits=${fmt.bits} channels=${fmt.channels})`);
      // streamed WAVs may declare a bogus size: clamp to what is actually there
      const end = Math.min(body + size, buf.length);
      const n = Math.floor((end - body) / 2);
      const samples = new Int16Array(n);
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(body + i * 2);
      return { sampleRate: fmt.sampleRate, samples };
    }
    pos = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

export function encodeWav(wav: Wav): Buffer {
  const dataBytes = wav.samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(wav.sampleRate, 24);
  buf.writeUInt32LE(wav.sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < wav.samples.length; i++) buf.writeInt16LE(wav.samples[i]!, 44 + i * 2);
  return buf;
}

export const durationSec = (w: Wav): number => w.samples.length / w.sampleRate;

export interface TrimOptions {
  /** Windows quieter than this (dBFS RMS) count as silence. */
  thresholdDb?: number;
  /** Silence kept on each side so speech doesn't sound clipped. */
  padMs?: number;
  windowMs?: number;
}

/** Removes leading/trailing silence (Piper clips carry up to ~0.3 s), keeping a short pad. Never returns an empty clip. */
export function trimSilence(w: Wav, opts: TrimOptions = {}): { wav: Wav; leadTrimmedSec: number; tailTrimmedSec: number } {
  const win = Math.max(1, Math.round((w.sampleRate * (opts.windowMs ?? 10)) / 1000));
  const threshold = 32768 * Math.pow(10, (opts.thresholdDb ?? -45) / 20);
  const pad = Math.round((w.sampleRate * (opts.padMs ?? 60)) / 1000);
  const loud = (start: number): boolean => {
    let sum = 0;
    const end = Math.min(start + win, w.samples.length);
    for (let i = start; i < end; i++) sum += w.samples[i]! * w.samples[i]!;
    return Math.sqrt(sum / Math.max(1, end - start)) > threshold;
  };
  let first = -1;
  let last = -1;
  for (let i = 0; i < w.samples.length; i += win) {
    if (loud(i)) {
      if (first < 0) first = i;
      last = Math.min(i + win, w.samples.length);
    }
  }
  if (first < 0) return { wav: w, leadTrimmedSec: 0, tailTrimmedSec: 0 }; // all silence: leave untouched
  const from = Math.max(0, first - pad);
  const to = Math.min(w.samples.length, last + pad);
  return { wav: { sampleRate: w.sampleRate, samples: w.samples.slice(from, to) }, leadTrimmedSec: from / w.sampleRate, tailTrimmedSec: (w.samples.length - to) / w.sampleRate };
}

/** Places clips at start times (seconds) on a silent track of `totalSec`. Overlaps are summed with clipping. */
export function mixTimeline(clips: { wav: Wav; startSec: number }[], sampleRate: number, totalSec: number): Wav {
  const out = new Int32Array(Math.ceil(totalSec * sampleRate));
  for (const { wav, startSec } of clips) {
    if (wav.sampleRate !== sampleRate) throw new Error(`sample rate mismatch: ${wav.sampleRate} vs ${sampleRate}`);
    const offset = Math.round(startSec * sampleRate);
    for (let i = 0; i < wav.samples.length && offset + i < out.length; i++) out[offset + i]! += wav.samples[i]!;
  }
  const samples = new Int16Array(out.length);
  for (let i = 0; i < out.length; i++) samples[i] = Math.max(-32768, Math.min(32767, out[i]!));
  return { sampleRate, samples };
}
