import { parseWav, type Wav } from "../lib/wav";

/**
 * Lip-sync data for one spoken line, from the line's real voice audio and its text:
 * - `env`: how open the mouth is, frame by frame. This is the loudness envelope of the audio itself, so the mouth moves
 *   exactly when the voice is heard and closes in pauses.
 * - `visemes`: which mouth shape, from the text. Devanagari or Latin letters map to the 15 standard visemes (sil PP FF TH DD
 *   kk CH SS nn RR aa E I O U). They are spread over the voiced frames in proportion to their length (vowels longer than
 *   consonants), so the shape sequence follows the speech but is not phoneme-aligned.
 */
export const VISEMES = ["sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "I", "O", "U"] as const;
export type Viseme = (typeof VISEMES)[number];
export interface SpeechTrack { duration: number; fps: number; env: number[]; visemes: { t: number; v: Viseme }[] }

const V = (ch: string): Viseme | null => {
  const c = ch.codePointAt(0)!;
  // Devanagari vowels (independent + matras)
  if ([0x0905, 0x0906, 0x093e].includes(c)) return "aa";
  if ([0x0907, 0x0908, 0x093f, 0x0940, 0x092f].includes(c)) return "I";
  if ([0x0909, 0x090a, 0x0941, 0x0942].includes(c)) return "U";
  if ([0x090f, 0x0910, 0x0947, 0x0948, 0x0945, 0x090d].includes(c)) return "E";
  if ([0x0913, 0x0914, 0x094b, 0x094c, 0x0949, 0x0911].includes(c)) return "O";
  if ([0x090b, 0x0943, 0x0930, 0x0931].includes(c)) return "RR";
  if ([0x0901, 0x0902, 0x0928, 0x0929, 0x0923, 0x0932, 0x0933].includes(c)) return "nn";
  if (c >= 0x0915 && c <= 0x0919) return "kk";
  if (c >= 0x091a && c <= 0x091e) return "CH";
  if (c >= 0x091f && c <= 0x0922) return "DD";
  if (c >= 0x0924 && c <= 0x0927) return "DD";
  if (c >= 0x092a && c <= 0x092e) return "PP";
  if (c === 0x0935) return "FF";
  if (c >= 0x0936 && c <= 0x0938) return "SS";
  if (c === 0x0939) return "aa";
  // precomposed nukta letters: क़ ख़ ग़ / ज़ / ड़ ढ़ / फ़ / य़
  if (c >= 0x0958 && c <= 0x095a) return "kk";
  if (c === 0x095b) return "SS";
  if (c === 0x095c || c === 0x095d) return "DD";
  if (c === 0x095e) return "FF";
  if (c === 0x095f) return "I";
  // Latin
  const l = ch.toLowerCase();
  if ("a".includes(l)) return "aa";
  if ("e".includes(l)) return "E";
  if ("iy".includes(l)) return "I";
  if ("o".includes(l)) return "O";
  if ("uw".includes(l)) return "U";
  if ("pbm".includes(l)) return "PP";
  if ("fv".includes(l)) return "FF";
  if ("td".includes(l)) return "DD";
  if ("kgcq".includes(l)) return "kk";
  if ("jx".includes(l)) return "CH";
  if ("sz".includes(l)) return "SS";
  if ("nl".includes(l)) return "nn";
  if ("r".includes(l)) return "RR";
  return null;
};
const isConsonant = (c: number): boolean => (c >= 0x0915 && c <= 0x0939) || (c >= 0x0958 && c <= 0x095f);
const isMatraOrHalant = (c: number): boolean => (c >= 0x093e && c <= 0x094d) || c === 0x0902 || c === 0x0901;

/** The viseme sequence of a text, each with a relative length. Devanagari consonants carry their inherent "a" unless followed by a matra or virama (and not at a word end). */
export function textVisemes(text: string): { v: Viseme; w: number }[] {
  const out: { v: Viseme; w: number }[] = [];
  const chars = [...text.normalize("NFC")];
  chars.forEach((ch, i) => {
    const c = ch.codePointAt(0)!;
    if (/[\s,.;:!?।—-]/u.test(ch)) { if (out.length && out[out.length - 1]!.v !== "sil") out.push({ v: "sil", w: 0.4 }); return; }
    if (c === 0x093c) return; // nukta
    // a nukta letter (फ़, ज़) sounds like f / z
    const nukta = chars[i + 1]?.codePointAt(0) === 0x093c;
    const v = nukta && c === 0x092b ? "FF" : nukta && c === 0x091c ? "SS" : V(ch);
    if (!v) return;
    const vowel = v === "aa" || v === "E" || v === "I" || v === "O" || v === "U";
    out.push({ v, w: vowel ? 1.4 : 0.8 });
    if (isConsonant(c)) {
      const next = chars[nukta ? i + 2 : i + 1];
      const nc = next?.codePointAt(0) ?? 0;
      const wordEnd = !next || /[\s,.;:!?।—-]/u.test(next);
      if (!isMatraOrHalant(nc) && !wordEnd) out.push({ v: "aa", w: 0.7 });
    }
  });
  while (out.length && out[out.length - 1]!.v === "sil") out.pop();
  return out;
}

/** Mouth-opening envelope of a voice (0..1 per frame): RMS per frame, normalised to the line's loud parts, quick to open and a little slower to close. */
export function envelope(w: Wav, fps: number): number[] {
  const per = Math.max(1, Math.round(w.sampleRate / fps)), n = Math.ceil(w.samples.length / per);
  const rms: number[] = [];
  for (let f = 0; f < n; f++) {
    let s = 0, k = 0;
    for (let i = f * per; i < Math.min(w.samples.length, (f + 1) * per); i++) { const x = w.samples[i]! / 32768; s += x * x; k++; }
    rms.push(Math.sqrt(s / Math.max(1, k)));
  }
  const sorted = [...rms].sort((a, b) => a - b), ref = Math.max(1e-4, sorted[Math.floor(sorted.length * 0.95)] ?? 0);
  const out: number[] = [];
  let y = 0;
  for (const r of rms) {
    const x = Math.min(1, Math.max(0, (r / ref - 0.08) / 0.92));
    y += (x - y) * (x > y ? 0.7 : 0.4);
    out.push(+y.toFixed(3));
  }
  return out;
}

/** Lip-sync for one line: the envelope from the audio, the text's visemes laid over the voiced frames. */
export function speechTrack(wavBuf: Buffer, text: string, fps: number): SpeechTrack {
  const w = parseWav(wavBuf);
  const env = envelope(w, fps);
  const seq = textVisemes(text);
  const voiced = env.map((e, i) => (e > 0.12 ? i : -1)).filter((i) => i >= 0);
  const visemes: { t: number; v: Viseme }[] = [];
  if (seq.length && voiced.length) {
    const total = seq.reduce((a, s) => a + s.w, 0);
    let acc = 0, last: Viseme | null = null;
    for (const s of seq) {
      const frame = voiced[Math.min(voiced.length - 1, Math.floor((acc / total) * voiced.length))]!;
      if (s.v !== last) visemes.push({ t: +(frame / fps).toFixed(3), v: s.v });
      last = s.v; acc += s.w;
    }
  }
  return { duration: w.samples.length / w.sampleRate, fps, env, visemes };
}
