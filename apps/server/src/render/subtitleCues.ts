import { subtitleAssetId, type Scene } from "@studio/shared";

export interface Cue {
  /** Deterministic subtitle asset id: sub-<dialogueId>-<part>. */
  id: string;
  dialogueId: string;
  text: string;
  /** Seconds from scene start. */
  start: number;
  end: number;
}

const SENTENCE_END = /(?<=[.!?।॥])\s+/u;

/** Splits long dialogue at sentence boundaries so a subtitle never exceeds ~maxChars (still whole sentences). */
export function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = text.split(SENTENCE_END).filter(Boolean);
  const parts: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (current && (current + " " + s).length > maxChars) {
      parts.push(current);
      current = s;
    } else current = current ? `${current} ${s}` : s;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Subtitle timing from the dialogue timeline. Each dialogue line becomes one cue (or several when it is very long;
 * the line's time is shared in proportion to text length). Requires start/end times from the timeline stage.
 */
export function buildCues(scene: Scene, maxChars = 90): Cue[] {
  const cues: Cue[] = [];
  for (const d of scene.dialogue) {
    if (d.startTime === undefined || d.endTime === undefined) throw new Error(`dialogue ${d.id} has no timing yet`);
    const parts = splitText(d.text, maxChars);
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let t = d.startTime;
    parts.forEach((text, i) => {
      const end = i === parts.length - 1 ? d.endTime! : t + ((d.endTime! - d.startTime!) * text.length) / total;
      cues.push({ id: subtitleAssetId(d.id, i + 1), dialogueId: d.id, text, start: Math.round(t * 1000) / 1000, end: Math.round(end * 1000) / 1000 });
      t = end;
    });
  }
  return cues;
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");
export function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  return `${pad(Math.floor(ms / 3_600_000), 2)}:${pad(Math.floor((ms % 3_600_000) / 60_000), 2)}:${pad(Math.floor((ms % 60_000) / 1000), 2)},${pad(ms % 1000, 3)}`;
}

/** SRT for a list of cues; `offsets[i]` shifts cue i (scene start within the final video). */
export function toSrt(cues: { text: string; start: number; end: number }[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}
