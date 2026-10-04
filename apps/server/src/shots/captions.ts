import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { CommandRunner } from "../lib/command";

/** One on-screen caption phrase: 1-3 words, with the time each word is spoken (seconds, same clock as the caller's). */
export interface CaptionChunk {
  words: string[];
  wordStart: number[];
  wordEnd: number[];
  start: number;
  end: number;
  /** per word: does the director want this word emphasised? */
  emphasised: boolean[];
}

const strip = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/**
 * Splits one spoken line into short phrases and spreads the real audio duration over the words by character weight
 * (plus a pause weight after punctuation). Piper gives no word timestamps, so this is an estimate; it is tested to
 * stay inside the line and be monotonic.
 */
export function chunkLine(text: string, start: number, end: number, emphasis: string[] = [], opts: { maxWords?: number; maxChars?: number } = {}): CaptionChunk[] {
  const maxWords = opts.maxWords ?? 3, maxChars = opts.maxChars ?? 20;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length || end <= start) return [];
  const weight = words.map((w) => w.replace(/[^\p{L}\p{N}']/gu, "").length + 1.5 + (/[.!?…]$/.test(w) ? 3 : /[,;:—-]$/.test(w) ? 1.5 : 0));
  const total = weight.reduce((a, b) => a + b, 0);
  const span = end - start;
  const ws: number[] = [], we: number[] = [];
  let acc = 0;
  for (let i = 0; i < words.length; i++) {
    ws.push(start + (acc / total) * span);
    acc += weight[i]!;
    // the pause weight belongs to the gap after the word, so a word "ends" before its pause
    const pause = /[.!?…]$/.test(words[i]!) ? 3 : /[,;:—-]$/.test(words[i]!) ? 1.5 : 0;
    we.push(start + ((acc - pause) / total) * span);
  }
  const emph = new Set(emphasis.map(strip));
  const chunks: CaptionChunk[] = [];
  let cur: number[] = [];
  const flush = (): void => {
    if (!cur.length) return;
    chunks.push({
      words: cur.map((i) => words[i]!), wordStart: cur.map((i) => ws[i]!), wordEnd: cur.map((i) => we[i]!),
      start: ws[cur[0]!]!, end: we[cur[cur.length - 1]!]!, emphasised: cur.map((i) => emph.has(strip(words[i]!))),
    });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const nextChars = [...cur, i].map((k) => words[k]!).join(" ").length;
    if (cur.length && (cur.length >= maxWords || nextChars > maxChars)) flush();
    cur.push(i);
    if (/[.!?…,;:]$/.test(words[i]!)) flush();
  }
  flush();
  return chunks;
}

export interface CaptionStyle { font: string; size: number; maxWidth: number; stroke: number; highlight: string; emphasisColour: string }
export const DEFAULT_CAPTION_STYLE: CaptionStyle = { font: "Impact", size: 112, maxWidth: 960, stroke: 7, highlight: "FFD23F", emphasisColour: "FF4D3D" };

export interface CaptionState { png: string; start: number; end: number; width: number; height: number }

/** Display text: upper-case, no trailing comma/semicolon noise. */
export const displayText = (words: string[]): string => words.join(" ").toUpperCase().replace(/[,;:]+$/g, "");

/**
 * Renders one transparent PNG per (chunk, active word) with CoreText and returns the display schedule: while a word is
 * spoken its PNG (that word highlighted) is on screen, so the phrase reads like karaoke.
 */
export async function renderCaptionStates(runner: CommandRunner, helper: string, chunks: CaptionChunk[], dir: string, style: CaptionStyle = DEFAULT_CAPTION_STYLE, holdAfter = 0.12): Promise<CaptionState[]> {
  await fs.mkdir(dir, { recursive: true });
  const out: CaptionState[] = [];
  for (const ch of chunks) {
    const text = displayText(ch.words);
    for (let i = 0; i < ch.words.length; i++) {
      const colour = ch.emphasised[i] ? style.emphasisColour : style.highlight;
      const key = crypto.createHash("sha1").update(JSON.stringify([text, i, colour, style])).digest("hex").slice(0, 16);
      const png = path.join(dir, `cap-${key}.png`);
      let size: { w: number; h: number } | undefined;
      try {
        await fs.access(png);
      } catch {
        const r = await runner.run(helper, [text, style.font, String(style.size), String(style.maxWidth), png, String(style.stroke), "0", String(i), colour], { timeoutMs: 20_000 });
        if (r.code !== 0) throw new Error(`caption render failed: ${r.stderr.slice(-200)}`);
        const m = /(\d+)x(\d+)/.exec(r.stdout);
        size = m ? { w: Number(m[1]), h: Number(m[2]) } : undefined;
      }
      size ??= await pngSize(png);
      const start = ch.wordStart[i]!;
      const end = i + 1 < ch.words.length ? ch.wordStart[i + 1]! : ch.wordEnd[i]! + holdAfter;
      out.push({ png, start, end, width: size.w, height: size.h });
    }
  }
  // never let two caption states overlap (the previous one ends where the next begins)
  out.sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < out.length; i++) if (out[i]!.end > out[i + 1]!.start) out[i]!.end = out[i + 1]!.start;
  return out;
}

async function pngSize(file: string): Promise<{ w: number; h: number }> {
  const b = await fs.readFile(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/**
 * Where captions go (vertical centre, fraction of the frame height). Subjects' faces sit in the upper-middle of a
 * portrait frame, so captions go to the lower third, above the platform's own UI zone; when the subject (focus) is
 * itself low in the frame, captions move to the top instead.
 */
export function captionCenterY(focus: { y: number }): number {
  return focus.y >= 0.66 ? 0.2 : 0.7;
}
